//! Legacy Launcher (llaun.ch) parser
//!
//! Parses instances from Legacy Launcher.
//! Files are stored in .tlauncher/legacy/Minecraft/game/ folder.

use super::types::*;
use directories::BaseDirs;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::fs;

/// Parse tl.properties file
async fn parse_tl_properties(path: &Path) -> HashMap<String, String> {
    let mut props = HashMap::new();

    if let Ok(content) = fs::read_to_string(path).await {
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((key, value)) = line.split_once('=') {
                props.insert(key.trim().to_string(), value.trim().to_string());
            }
        }
    }

    props
}

/// Parse launcher instances from Legacy Launcher
pub async fn parse_launcher_profiles(legacy_dir: &Path) -> LauncherResult<Vec<LauncherInstance>> {
    // Legacy Launcher structure:
    // .tlauncher/legacy/Minecraft/
    //   - tl.properties
    //   - game/ (main .minecraft directory)
    //   - launcher/ (launcher versions)

    let game_dir = legacy_dir.join("game");
    let tl_props_path = legacy_dir.join("tl.properties");

    // Check if game directory exists
    if !game_dir.exists() {
        return Err(LauncherError::NotFound(format!(
            "Game directory not found at {}",
            game_dir.display()
        )));
    }

    let mut instances = Vec::new();

    // Parse tl.properties for launcher info
    let props = parse_tl_properties(&tl_props_path).await;

    // Legacy Launcher doesn't have multiple profiles like official launcher
    // It has one main "game" folder and versions in separate folder
    // We'll scan the versions folder to find installed versions

    let versions_dir = game_dir.join("versions");

    if versions_dir.exists() {
        // Scan versions - each is a potential instance
        if let Ok(mut entries) = fs::read_dir(&versions_dir).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                let version_path = entry.path();
                if !version_path.is_dir() {
                    continue;
                }

                let version_name = entry.file_name().to_string_lossy().to_string();

                // Skip non-game directories
                if version_name.starts_with('.') {
                    continue;
                }

                // Detect loader from version name
                let (loader, loader_version) = detect_loader_from_version(&version_name);

                // Extract Minecraft version from version name
                let minecraft_version = extract_mc_version(&version_name);

                instances.push(LauncherInstance {
                    name: version_name.clone(),
                    path: game_dir.clone(),
                    minecraft_version,
                    loader: loader.to_string(),
                    loader_version,
                    instance_type: "client".to_string(),
                    mods_count: count_mods(&game_dir).await,
                    total_size: calculate_dir_size(&game_dir).await,
                    last_played: props.get("lastPlayed").cloned(),
                    icon_path: None,
                    java_args: None,
                    memory_min: None,
                    memory_max: None,
                    source_launcher: LauncherType::LegacyLauncher,
                    notes: Some(format!("Version: {}", version_name)),
                    confidence: 70,
                });
            }
        }
    }

    // If no versions found, create a single instance for the game folder
    if instances.is_empty() && game_dir.join("mods").exists() {
        let mods_count = count_mods(&game_dir).await;
        let total_size = calculate_dir_size(&game_dir).await;

        instances.push(LauncherInstance {
            name: "Legacy Launcher".to_string(),
            path: game_dir,
            minecraft_version: "unknown".to_string(),
            loader: detect_loader_from_mods(&legacy_dir.join("game").join("mods")).await,
            loader_version: None,
            instance_type: "client".to_string(),
            mods_count,
            total_size,
            last_played: props.get("lastPlayed").cloned(),
            icon_path: None,
            java_args: None,
            memory_min: None,
            memory_max: None,
            source_launcher: LauncherType::LegacyLauncher,
            notes: None,
            confidence: 60,
        });
    }

    Ok(instances)
}

/// Extract Minecraft version from version string
fn extract_mc_version(version: &str) -> String {
    // Common patterns:
    // "1.20.1" -> "1.20.1"
    // "1.20.1-forge-47.2.0" -> "1.20.1"
    // "fabric-loader-0.15.0-1.20.1" -> "1.20.1"
    // "1.20.1-OptiFine_HD_U_I6" -> "1.20.1"

    // Try to find version pattern like 1.X.X or 1.XX.X
    let re_pattern = regex::Regex::new(r"(1\.\d+(?:\.\d+)?)").ok();

    if let Some(re) = re_pattern {
        if let Some(captures) = re.captures(version) {
            if let Some(mc_ver) = captures.get(1) {
                return mc_ver.as_str().to_string();
            }
        }
    }

    // If no pattern found, return the first part before hyphen
    version.split('-').next().unwrap_or(version).to_string()
}

/// Detect loader type from version string
fn detect_loader_from_version(version: &str) -> (&'static str, Option<String>) {
    let version_lower = version.to_lowercase();

    if version_lower.contains("fabric") {
        // Format: "fabric-loader-X.X.X-Y.Y.Y"
        let loader_ver = version.split('-').nth(2).map(String::from);
        ("fabric", loader_ver)
    } else if version_lower.contains("forge") {
        // Format: "1.20.1-forge-47.2.0"
        let loader_ver = version.split('-').last().map(String::from);
        ("forge", loader_ver)
    } else if version_lower.contains("neoforge") {
        let loader_ver = version.split('-').last().map(String::from);
        ("neoforge", loader_ver)
    } else if version_lower.contains("quilt") {
        let loader_ver = version.split('-').nth(2).map(String::from);
        ("quilt", loader_ver)
    } else if version_lower.contains("optifine") {
        // OptiFine HD versions
        let loader_ver = version.split('_').last().map(String::from);
        ("optifine", loader_ver)
    } else {
        ("vanilla", None)
    }
}

/// Detect loader from mods folder (by scanning jar files)
async fn detect_loader_from_mods(mods_dir: &Path) -> String {
    if !mods_dir.exists() {
        return "vanilla".to_string();
    }

    // Check for fabric.mod.json or mods.toml in any jar
    if let Ok(mut entries) = fs::read_dir(mods_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if path.extension().map(|e| e == "jar").unwrap_or(false) {
                // Just having mods suggests a modded instance
                // We can't easily inspect JAR contents without unzipping
                // Return "modded" as a fallback
                return "modded".to_string();
            }
        }
    }

    "vanilla".to_string()
}

/// Count mods in mods folder
async fn count_mods(game_dir: &Path) -> usize {
    let mods_dir = game_dir.join("mods");
    if !mods_dir.exists() {
        return 0;
    }

    let mut count = 0;
    if let Ok(mut entries) = fs::read_dir(&mods_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if path.extension().map(|e| e == "jar").unwrap_or(false) {
                count += 1;
            }
        }
    }
    count
}

/// Calculate directory size (simplified)
async fn calculate_dir_size(dir: &Path) -> u64 {
    let mut total = 0u64;

    // Just count mods folder size for now
    let mods_dir = dir.join("mods");
    if mods_dir.exists() {
        if let Ok(mut entries) = fs::read_dir(&mods_dir).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                if let Ok(meta) = entry.metadata().await {
                    total += meta.len();
                }
            }
        }
    }

    // Add config folder size
    let config_dir = dir.join("config");
    if config_dir.exists() {
        if let Ok(mut entries) = fs::read_dir(&config_dir).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                if let Ok(meta) = entry.metadata().await {
                    total += meta.len();
                }
            }
        }
    }

    total
}

/// List all instances from Legacy Launcher
pub async fn list_instances(legacy_dir: &Path) -> LauncherResult<Vec<LauncherInstance>> {
    parse_launcher_profiles(legacy_dir).await
}

/// Detect Legacy Launcher installations
pub async fn detect_installations() -> Vec<DetectedLauncher> {
    let mut detected = Vec::new();

    // Legacy Launcher stores files in .tlauncher/legacy/Minecraft/
    #[cfg(target_os = "windows")]
    let search_paths = {
        let mut paths: Vec<PathBuf> = Vec::new();

        // Primary: APPDATA\.tlauncher\legacy\Minecraft
        if let Ok(appdata) = std::env::var("APPDATA") {
            paths.push(
                PathBuf::from(&appdata)
                    .join(".tlauncher")
                    .join("legacy")
                    .join("Minecraft"),
            );
        }

        // Alternative: USERPROFILE\.tlauncher\legacy\Minecraft
        if let Some(dirs) = BaseDirs::new() {
            let home_path = dirs
                .home_dir()
                .join(".tlauncher")
                .join("legacy")
                .join("Minecraft");
            if !paths.contains(&home_path) {
                paths.push(home_path);
            }
        }

        paths
    };

    #[cfg(target_os = "linux")]
    let search_paths = {
        let mut paths: Vec<PathBuf> = Vec::new();
        if let Some(dirs) = BaseDirs::new() {
            paths.push(
                dirs.home_dir()
                    .join(".tlauncher")
                    .join("legacy")
                    .join("Minecraft"),
            );
        }
        paths
    };

    #[cfg(target_os = "macos")]
    let search_paths = {
        let mut paths: Vec<PathBuf> = Vec::new();
        if let Some(dirs) = BaseDirs::new() {
            paths.push(
                dirs.home_dir()
                    .join(".tlauncher")
                    .join("legacy")
                    .join("Minecraft"),
            );
            // macOS might also use Library folder
            paths.push(
                dirs.home_dir()
                    .join("Library/Application Support/tlauncher/legacy/Minecraft"),
            );
        }
        paths
    };

    for path in search_paths {
        // Check if game folder exists (this is the actual .minecraft-like directory)
        let game_dir = path.join("game");
        if game_dir.exists() {
            // Count instances (versions or just check if there are mods)
            let instance_count = match parse_launcher_profiles(&path).await {
                Ok(instances) => instances.len(),
                Err(_) => 0,
            };

            // Even if no versions found, if game folder exists, we have a valid installation
            let count = if instance_count > 0 {
                instance_count
            } else {
                1
            };

            detected.push(DetectedLauncher {
                launcher_type: LauncherType::LegacyLauncher,
                root_path: path.clone(),
                instances_path: game_dir,
                instance_count: count,
                display_name: "Legacy Launcher".to_string(),
            });
        }
    }

    detected
}
