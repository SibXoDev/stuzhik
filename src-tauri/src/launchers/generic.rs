//! Generic .minecraft folder parser
//!
//! Parses any Minecraft folder structure:
//! - Raw .minecraft folders
//! - TLauncher instances
//! - Official Minecraft Launcher profiles
//! - Unknown/custom launchers
//!
//! Uses heuristics to detect loader and version.

use super::types::*;
use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use tokio::fs;
use zip::ZipArchive;

/// Files to skip during import (cache, logs, crash reports, etc.)
const SKIP_PATTERNS: &[&str] = &[
    // Logs and crashes
    "logs/",
    "crash-reports/",
    "debug.log",
    ".log",
    // Cache and temporary
    ".mixin.out/",
    ".fabric/",
    "assets/",
    "libraries/",
    "versions/",
    "natives/",
    // Runtime data
    "screenshots/",
    "replay_recordings/",
    "schematics/",
    "backups/",
    // TLauncher specific junk
    "TLauncher/",
    "tlauncher",
    ".tlauncher",
    "updates/",
    // Other launcher junk
    ".curseclient",
    ".curse",
    "launcher_profiles.json",
    "launcher_accounts.json",
    "usercache.json",
    "usernamecache.json",
    "realms_persistence.json",
];

/// Files that indicate adware/suspicious activity (TLauncher, etc.)
const SUSPICIOUS_PATTERNS: &[&str] = &[
    "TLauncher",
    "tlauncher",
    "tlskinscape",
    "TLSkinCape",
    // Add more as discovered
];

/// Safe directories to import
const SAFE_DIRS: &[&str] = &[
    "mods",
    "config",
    "resourcepacks",
    "shaderpacks",
    "scripts",        // KubeJS, CraftTweaker
    "kubejs",         // KubeJS scripts
    "defaultconfigs", // Forge default configs
    "global_packs",   // Global datapacks
    "saves",          // Optional: worlds
];

/// Detection result for a .minecraft folder
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MinecraftFolderAnalysis {
    /// Detected Minecraft version
    pub minecraft_version: Option<String>,
    /// Detected loader
    pub loader: String,
    /// Detected loader version
    pub loader_version: Option<String>,
    /// Number of mods found
    pub mods_count: usize,
    /// Total size of safe files
    pub safe_size: u64,
    /// Files that would be skipped (cache, logs, etc.)
    pub skipped_size: u64,
    /// Suspicious files found (adware indicators)
    pub suspicious_files: Vec<String>,
    /// Detection confidence (0-100)
    pub confidence: u8,
    /// Evidence for detection
    pub evidence: Vec<String>,
}

/// Analyze a .minecraft folder
pub async fn analyze_folder(minecraft_dir: &Path) -> LauncherResult<MinecraftFolderAnalysis> {
    if !fs::try_exists(minecraft_dir).await.unwrap_or(false) {
        return Err(LauncherError::NotFound(format!(
            "Directory not found: {}",
            minecraft_dir.display()
        )));
    }

    let mut analysis = MinecraftFolderAnalysis {
        minecraft_version: None,
        loader: "vanilla".to_string(),
        loader_version: None,
        mods_count: 0,
        safe_size: 0,
        skipped_size: 0,
        suspicious_files: Vec::new(),
        confidence: 0,
        evidence: Vec::new(),
    };

    // Scan for suspicious files first
    scan_suspicious(&minecraft_dir, &mut analysis).await;

    // Detect loader from mods
    detect_loader_from_mods(&minecraft_dir, &mut analysis).await;

    // Try to detect version from various sources
    detect_version(&minecraft_dir, &mut analysis).await;

    // Count mods
    analysis.mods_count = count_mods(&minecraft_dir.join("mods")).await;

    // Calculate sizes
    calculate_sizes(&minecraft_dir, &mut analysis).await;

    // Calculate confidence
    analysis.confidence = calculate_confidence(&analysis);

    Ok(analysis)
}

/// Scan for suspicious files (TLauncher adware, etc.)
async fn scan_suspicious(dir: &Path, analysis: &mut MinecraftFolderAnalysis) {
    let mut stack = vec![dir.to_path_buf()];

    while let Some(current) = stack.pop() {
        if let Ok(mut entries) = fs::read_dir(&current).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();

                // Check for suspicious patterns
                for pattern in SUSPICIOUS_PATTERNS {
                    if name.to_lowercase().contains(&pattern.to_lowercase()) {
                        analysis
                            .suspicious_files
                            .push(format!("{}: {}", pattern, path.display()));
                    }
                }

                // Recurse into directories (but not too deep)
                if path.is_dir() {
                    let depth = path.components().count() - dir.components().count();
                    if depth < 3 {
                        stack.push(path);
                    }
                }
            }
        }
    }
}

/// Detect loader by inspecting mod JARs
async fn detect_loader_from_mods(minecraft_dir: &Path, analysis: &mut MinecraftFolderAnalysis) {
    let mods_dir = minecraft_dir.join("mods");
    if !fs::try_exists(&mods_dir).await.unwrap_or(false) {
        return;
    }

    let mut fabric_count = 0;
    let mut forge_count = 0;
    let mut quilt_count = 0;

    if let Ok(mut entries) = fs::read_dir(&mods_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if !path.extension().map_or(false, |e| e == "jar") {
                continue;
            }

            // Check mod type in a blocking task
            let path_clone = path.clone();
            if let Ok(Some(mod_type)) =
                tokio::task::spawn_blocking(move || detect_mod_type_sync(&path_clone)).await
            {
                match mod_type.as_str() {
                    "fabric" => fabric_count += 1,
                    "quilt" => quilt_count += 1,
                    "forge" => forge_count += 1,
                    _ => {}
                }
            }

            // Only check first 20 mods for performance
            if fabric_count + forge_count + quilt_count >= 20 {
                break;
            }
        }
    }

    // Determine primary loader
    let total = fabric_count + forge_count + quilt_count;
    if total > 0 {
        if quilt_count > fabric_count && quilt_count > forge_count {
            analysis.loader = "quilt".to_string();
            analysis.evidence.push(format!(
                "Found {} Quilt mods, {} Fabric mods, {} Forge mods",
                quilt_count, fabric_count, forge_count
            ));
        } else if fabric_count > forge_count {
            analysis.loader = "fabric".to_string();
            analysis.evidence.push(format!(
                "Found {} Fabric mods, {} Forge mods",
                fabric_count, forge_count
            ));
        } else if forge_count > 0 {
            analysis.loader = "forge".to_string();
            analysis.evidence.push(format!(
                "Found {} Forge mods, {} Fabric mods",
                forge_count, fabric_count
            ));
        }
    }
}

/// Detect mod type from JAR file (sync, for spawn_blocking)
fn detect_mod_type_sync(jar_path: &Path) -> Option<String> {
    let file = std::fs::File::open(jar_path).ok()?;
    let mut archive = ZipArchive::new(file).ok()?;

    if archive.by_name("quilt.mod.json").is_ok() {
        return Some("quilt".to_string());
    }

    if archive.by_name("fabric.mod.json").is_ok() {
        return Some("fabric".to_string());
    }

    if archive.by_name("META-INF/mods.toml").is_ok() {
        return Some("forge".to_string());
    }

    if archive.by_name("mcmod.info").is_ok() {
        return Some("forge".to_string());
    }

    None
}

/// Detect Minecraft version from various sources
async fn detect_version(minecraft_dir: &Path, analysis: &mut MinecraftFolderAnalysis) {
    // Method 1: Check for version marker files in config
    if let Some(version) = detect_version_from_config(minecraft_dir).await {
        analysis.minecraft_version = Some(version.clone());
        analysis
            .evidence
            .push(format!("Version from config: {}", version));
        return;
    }

    // Method 2: Check for Fabric/Quilt files
    if let Some((version, loader_version)) = detect_fabric_version(minecraft_dir).await {
        analysis.minecraft_version = Some(version.clone());
        analysis.loader_version = Some(loader_version.clone());
        analysis.evidence.push(format!(
            "Fabric version: MC {} / Loader {}",
            version, loader_version
        ));
        return;
    }

    // Method 3: Check mod compatibility (many mods have version in filename)
    if let Some(version) = detect_version_from_mod_names(minecraft_dir).await {
        analysis.minecraft_version = Some(version.clone());
        analysis
            .evidence
            .push(format!("Version from mod filenames: {}", version));
    }
}

/// Detect version from config files
async fn detect_version_from_config(minecraft_dir: &Path) -> Option<String> {
    // Check fml-cache-annotation.json (Forge)
    let fml_cache = minecraft_dir
        .join("config")
        .join("fml-cache-annotation.json");
    if fs::try_exists(&fml_cache).await.unwrap_or(false) {
        if let Ok(content) = fs::read_to_string(&fml_cache).await {
            // Parse version from FML cache
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(version) = json.get("minecraft_version").and_then(|v| v.as_str()) {
                    return Some(version.to_string());
                }
            }
        }
    }

    // Check defaultconfigs/.fabric (Fabric)
    let fabric_marker = minecraft_dir.join(".fabric");
    if fs::try_exists(&fabric_marker).await.unwrap_or(false) {
        // Try to find version in .fabric folder
        // This is a heuristic - actual version detection is more complex
    }

    None
}

/// Detect Fabric loader version
async fn detect_fabric_version(minecraft_dir: &Path) -> Option<(String, String)> {
    let fabric_dir = minecraft_dir.join(".fabric");
    if !fs::try_exists(&fabric_dir).await.unwrap_or(false) {
        return None;
    }

    // Check for remappedJars folder naming
    let remapped_jars = fabric_dir.join("remappedJars");
    if fs::try_exists(&remapped_jars).await.unwrap_or(false) {
        if let Ok(mut entries) = fs::read_dir(&remapped_jars).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                let name = entry.file_name().to_string_lossy().to_string();
                // Pattern: minecraft-1.20.1+build.10
                if name.starts_with("minecraft-") {
                    if let Some(version) = name.strip_prefix("minecraft-") {
                        let version = version.split('+').next().unwrap_or(version);
                        return Some((version.to_string(), "unknown".to_string()));
                    }
                }
            }
        }
    }

    None
}

/// Detect version from mod filenames (heuristic)
async fn detect_version_from_mod_names(minecraft_dir: &Path) -> Option<String> {
    let mods_dir = minecraft_dir.join("mods");
    if !fs::try_exists(&mods_dir).await.unwrap_or(false) {
        return None;
    }

    // Common version patterns in mod filenames
    let version_patterns = [
        "1.21.1", "1.21", "1.20.6", "1.20.4", "1.20.2", "1.20.1", "1.20", "1.19.4", "1.19.3",
        "1.19.2", "1.19.1", "1.19", "1.18.2", "1.18.1", "1.18", "1.17.1", "1.17", "1.16.5",
        "1.16.4", "1.16.3", "1.16.2", "1.16.1", "1.16", "1.12.2", "1.12.1", "1.12", "1.7.10",
    ];

    let mut version_counts: std::collections::HashMap<&str, usize> =
        std::collections::HashMap::new();

    if let Ok(mut entries) = fs::read_dir(&mods_dir).await {
        let mut checked = 0;
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".jar") {
                continue;
            }

            for pattern in &version_patterns {
                if name.contains(pattern) {
                    *version_counts.entry(pattern).or_insert(0) += 1;
                }
            }

            checked += 1;
            if checked >= 30 {
                break;
            }
        }
    }

    // Return most common version
    version_counts
        .into_iter()
        .max_by_key(|(_, count)| *count)
        .map(|(version, _)| version.to_string())
}

/// Count mods in directory
async fn count_mods(mods_dir: &Path) -> usize {
    if !fs::try_exists(mods_dir).await.unwrap_or(false) {
        return 0;
    }

    let mut count = 0;
    if let Ok(mut entries) = fs::read_dir(mods_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(".jar") || name.ends_with(".jar.disabled") {
                count += 1;
            }
        }
    }
    count
}

/// Calculate safe and skipped sizes
async fn calculate_sizes(minecraft_dir: &Path, analysis: &mut MinecraftFolderAnalysis) {
    let mut stack = vec![(minecraft_dir.to_path_buf(), String::new())];

    while let Some((current, relative)) = stack.pop() {
        if let Ok(mut entries) = fs::read_dir(&current).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();
                let rel_path = if relative.is_empty() {
                    name.clone()
                } else {
                    format!("{}/{}", relative, name)
                };

                // Check if should skip
                let should_skip = SKIP_PATTERNS.iter().any(|p| {
                    rel_path.starts_with(p)
                        || rel_path.contains(p)
                        || name.to_lowercase().contains(&p.to_lowercase())
                });

                if let Ok(metadata) = entry.metadata().await {
                    if metadata.is_dir() {
                        if !should_skip {
                            stack.push((path, rel_path));
                        } else {
                            // Count skipped directory size
                            analysis.skipped_size += dir_size_sync(&path).await;
                        }
                    } else {
                        if should_skip {
                            analysis.skipped_size += metadata.len();
                        } else {
                            analysis.safe_size += metadata.len();
                        }
                    }
                }
            }
        }
    }
}

/// Calculate directory size (async wrapper)
async fn dir_size_sync(dir: &Path) -> u64 {
    let dir = dir.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let mut total = 0u64;
        let mut stack = vec![dir];

        while let Some(current) = stack.pop() {
            if let Ok(entries) = std::fs::read_dir(&current) {
                for entry in entries.flatten() {
                    if let Ok(metadata) = entry.metadata() {
                        if metadata.is_dir() {
                            stack.push(entry.path());
                        } else {
                            total += metadata.len();
                        }
                    }
                }
            }
        }
        total
    })
    .await
    .unwrap_or(0)
}

/// Calculate detection confidence
fn calculate_confidence(analysis: &MinecraftFolderAnalysis) -> u8 {
    let mut confidence: u8 = 0;

    // Has mods
    if analysis.mods_count > 0 {
        confidence = confidence.saturating_add(30);
    }

    // Has detected version
    if analysis.minecraft_version.is_some() {
        confidence = confidence.saturating_add(25);
    }

    // Has detected loader (not vanilla)
    if analysis.loader != "vanilla" {
        confidence = confidence.saturating_add(20);

        // Has loader version
        if analysis.loader_version.is_some() {
            confidence = confidence.saturating_add(10);
        }
    }

    // No suspicious files
    if analysis.suspicious_files.is_empty() {
        confidence = confidence.saturating_add(15);
    } else {
        // Reduce confidence if suspicious files found
        confidence = confidence.saturating_sub(20);
    }

    confidence.min(100)
}

/// Parse generic .minecraft folder as LauncherInstance
pub async fn parse_instance(
    minecraft_dir: &Path,
    name: Option<String>,
) -> LauncherResult<LauncherInstance> {
    let analysis = analyze_folder(minecraft_dir).await?;

    let instance_name = name.unwrap_or_else(|| {
        minecraft_dir
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("Imported Instance")
            .to_string()
    });

    Ok(LauncherInstance {
        name: instance_name,
        path: minecraft_dir.to_path_buf(),
        minecraft_version: analysis
            .minecraft_version
            .unwrap_or_else(|| "unknown".to_string()),
        loader: analysis.loader,
        loader_version: analysis.loader_version,
        instance_type: "client".to_string(),
        mods_count: analysis.mods_count,
        total_size: analysis.safe_size,
        last_played: None,
        icon_path: None,
        java_args: None,
        memory_min: None,
        memory_max: None,
        source_launcher: LauncherType::MultiMC, // Generic, will be overridden
        notes: if !analysis.suspicious_files.is_empty() {
            Some(format!(
                "⚠️ Found {} suspicious files that were skipped",
                analysis.suspicious_files.len()
            ))
        } else {
            None
        },
        confidence: analysis.confidence,
    })
}

/// Get list of files/directories that will be imported
pub async fn get_importable_paths(minecraft_dir: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();

    for safe_dir in SAFE_DIRS {
        let path = minecraft_dir.join(safe_dir);
        if fs::try_exists(&path).await.unwrap_or(false) {
            paths.push(path);
        }
    }

    // Also check for options.txt and other single files
    let safe_files = [
        "options.txt",
        "optionsof.txt",
        "optionsshaders.txt",
        "servers.dat",
    ];
    for file in &safe_files {
        let path = minecraft_dir.join(file);
        if fs::try_exists(&path).await.unwrap_or(false) {
            paths.push(path);
        }
    }

    paths
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_should_skip() {
        let patterns = SKIP_PATTERNS;

        assert!(patterns.iter().any(|p| "logs/latest.log".contains(p)));
        assert!(patterns
            .iter()
            .any(|p| "crash-reports/crash.txt".contains(p)));
        assert!(!patterns.iter().any(|p| "mods/sodium.jar".contains(p)));
        assert!(!patterns.iter().any(|p| "config/sodium.json".contains(p)));
    }
}
