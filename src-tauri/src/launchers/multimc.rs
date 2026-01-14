//! MultiMC and Prism Launcher instance parser
//!
//! Supports:
//! - MultiMC (original)
//! - Prism Launcher (fork)
//! - PolyMC (deprecated fork)
//!
//! File formats:
//! - instance.cfg (INI-like format)
//! - mmc-pack.json (component list)

use super::types::*;
use directories::BaseDirs;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::fs;

/// Parse instance.cfg file (INI-like format)
pub async fn parse_instance_cfg(instance_dir: &Path) -> LauncherResult<MultiMCInstanceCfg> {
    let cfg_path = instance_dir.join("instance.cfg");

    if !cfg_path.exists() {
        return Err(LauncherError::NotFound(format!(
            "instance.cfg not found in {}",
            instance_dir.display()
        )));
    }

    let content = fs::read_to_string(&cfg_path).await?;
    let mut cfg = MultiMCInstanceCfg::default();
    let mut in_general = false;

    for line in content.lines() {
        let line = line.trim();

        // Skip empty lines and comments
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }

        // Section headers
        if line.starts_with('[') && line.ends_with(']') {
            in_general = line == "[General]";
            continue;
        }

        // Key-value pairs
        if let Some((key, value)) = line.split_once('=') {
            let key = key.trim();
            let value = value.trim();

            match key {
                "name" => cfg.name = value.to_string(),
                "iconKey" => cfg.icon_key = Some(value.to_string()),
                "notes" => cfg.notes = Some(value.to_string()),
                "JavaPath" | "javaPath" => cfg.java_path = Some(value.to_string()),
                "JvmArgs" | "jvmArgs" => cfg.jvm_args = Some(value.to_string()),
                "MinMemAlloc" | "minMemAlloc" => cfg.min_memory = value.parse().ok(),
                "MaxMemAlloc" | "maxMemAlloc" => cfg.max_memory = value.parse().ok(),
                "lastLaunchTime" => cfg.last_launched = value.parse().ok(),
                "totalTimePlayed" => cfg.total_time_played = value.parse().ok(),
                _ => {
                    // Log unknown keys in debug builds
                    if in_general {
                        log::debug!("Unknown instance.cfg key: {} = {}", key, value);
                    }
                }
            }
        }
    }

    // Use folder name if name not set
    if cfg.name.is_empty() {
        cfg.name = instance_dir
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("Unknown")
            .to_string();
    }

    Ok(cfg)
}

/// Parse mmc-pack.json file
pub async fn parse_mmc_pack(instance_dir: &Path) -> LauncherResult<MMCPack> {
    let pack_path = instance_dir.join("mmc-pack.json");

    if !pack_path.exists() {
        return Err(LauncherError::NotFound(format!(
            "mmc-pack.json not found in {}",
            instance_dir.display()
        )));
    }

    let content = fs::read_to_string(&pack_path).await?;
    let pack: MMCPack = serde_json::from_str(&content)
        .map_err(|e| LauncherError::ParseError(format!("Failed to parse mmc-pack.json: {}", e)))?;

    Ok(pack)
}

/// Get .minecraft directory within instance
fn get_minecraft_dir(instance_dir: &Path) -> PathBuf {
    // Prism/MultiMC uses .minecraft subfolder
    let minecraft_dir = instance_dir.join(".minecraft");
    if minecraft_dir.exists() {
        return minecraft_dir;
    }

    // Some older versions use minecraft subfolder
    let alt_dir = instance_dir.join("minecraft");
    if alt_dir.exists() {
        return alt_dir;
    }

    // Fallback to .minecraft (will be created if needed)
    minecraft_dir
}

/// Count mods in instance
async fn count_mods(instance_dir: &Path) -> usize {
    let minecraft_dir = get_minecraft_dir(instance_dir);
    let mods_dir = minecraft_dir.join("mods");

    if !mods_dir.exists() {
        return 0;
    }

    let mut count = 0;
    if let Ok(mut entries) = fs::read_dir(&mods_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(".jar") || name.ends_with(".jar.disabled") {
                count += 1;
            }
        }
    }
    count
}

/// Calculate total instance size
async fn calculate_size(dir: &Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![dir.to_path_buf()];

    while let Some(current) = stack.pop() {
        if let Ok(mut entries) = fs::read_dir(&current).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                let path = entry.path();
                if let Ok(metadata) = entry.metadata().await {
                    if metadata.is_dir() {
                        stack.push(path);
                    } else {
                        total += metadata.len();
                    }
                }
            }
        }
    }

    total
}

/// Parse a single MultiMC/Prism instance
pub async fn parse_instance(
    instance_dir: &Path,
    launcher_type: LauncherType,
) -> LauncherResult<LauncherInstance> {
    // Parse instance.cfg
    let cfg = parse_instance_cfg(instance_dir).await?;

    // Parse mmc-pack.json for version info
    let (minecraft_version, loader, loader_version) = match parse_mmc_pack(instance_dir).await {
        Ok(pack) => {
            let mc_version = pack
                .minecraft_version()
                .unwrap_or_else(|| "unknown".to_string());
            let (loader, loader_version) = pack.loader_info();
            (mc_version, loader, loader_version)
        }
        Err(_) => {
            // Fallback: try to detect from libraries or mods
            log::warn!(
                "Failed to parse mmc-pack.json for {}, using fallback detection",
                instance_dir.display()
            );
            ("unknown".to_string(), "vanilla".to_string(), None)
        }
    };

    // Count mods
    let mods_count = count_mods(instance_dir).await;

    // Calculate total size
    let total_size = calculate_size(instance_dir).await;

    // Resolve icon path
    let icon_path = if let Some(ref icon_key) = cfg.icon_key {
        // MultiMC stores icons in icons/ folder with the icon key as filename
        let icon_file = instance_dir
            .parent()
            .and_then(|p| p.parent())
            .map(|launcher_root| {
                launcher_root
                    .join("icons")
                    .join(format!("{}.png", icon_key))
            });
        icon_file.filter(|p| p.exists())
    } else {
        None
    };

    // Parse last played timestamp
    let last_played = cfg.last_launched.map(|ts| {
        chrono::DateTime::from_timestamp(ts / 1000, 0)
            .map(|dt| dt.to_rfc3339())
            .unwrap_or_default()
    });

    Ok(LauncherInstance {
        name: cfg.name,
        path: instance_dir.to_path_buf(),
        minecraft_version,
        loader,
        loader_version,
        instance_type: "client".to_string(),
        mods_count,
        total_size,
        last_played,
        icon_path,
        java_args: cfg.jvm_args,
        memory_min: cfg.min_memory,
        memory_max: cfg.max_memory,
        source_launcher: launcher_type,
        notes: cfg.notes,
        confidence: 90, // High confidence for proper parsing
    })
}

/// List all instances in a MultiMC/Prism launcher
pub async fn list_instances(launcher_root: &Path) -> LauncherResult<Vec<LauncherInstance>> {
    // Determine launcher type
    let launcher_type = detect_launcher_type(launcher_root).await;

    // Find instances directory
    let instances_dir = launcher_root.join("instances");
    if !instances_dir.exists() {
        return Err(LauncherError::NotFound(format!(
            "Instances directory not found in {}",
            launcher_root.display()
        )));
    }

    let mut instances = Vec::new();

    let mut entries = fs::read_dir(&instances_dir).await?;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();

        // Skip non-directories
        if !path.is_dir() {
            continue;
        }

        // Skip hidden folders and special folders
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "_MMC_TEMP" || name == "_LAUNCHER_TEMP" {
            continue;
        }

        // Check if it's a valid instance (has instance.cfg)
        if !path.join("instance.cfg").exists() {
            continue;
        }

        match parse_instance(&path, launcher_type).await {
            Ok(instance) => instances.push(instance),
            Err(e) => {
                log::warn!("Failed to parse instance at {}: {}", path.display(), e);
            }
        }
    }

    // Sort by last played (most recent first), then by name
    instances.sort_by(|a, b| match (&b.last_played, &a.last_played) {
        (Some(b_time), Some(a_time)) => b_time.cmp(a_time),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.name.cmp(&b.name),
    });

    Ok(instances)
}

/// Detect if this is MultiMC or Prism based on launcher files
async fn detect_launcher_type(launcher_root: &Path) -> LauncherType {
    // Check for Prism-specific files
    if launcher_root.join("prismlauncher.cfg").exists() {
        return LauncherType::Prism;
    }

    // Check for MultiMC-specific files
    if launcher_root.join("multimc.cfg").exists() {
        return LauncherType::MultiMC;
    }

    // Check executable names
    let prism_exe = launcher_root.join("prismlauncher.exe");
    let prism_exe_linux = launcher_root.join("prismlauncher");

    if prism_exe.exists() || prism_exe_linux.exists() {
        return LauncherType::Prism;
    }

    // Default to MultiMC
    LauncherType::MultiMC
}

/// Detect MultiMC/Prism installations on the system
pub async fn detect_installations() -> Vec<DetectedLauncher> {
    let mut detected = Vec::new();

    let base_dirs = BaseDirs::new();

    // Common installation paths per OS
    #[cfg(target_os = "windows")]
    let search_paths = {
        let mut paths: Vec<Option<PathBuf>> = vec![
            Some(PathBuf::from("C:\\Program Files\\PrismLauncher")),
            Some(PathBuf::from("C:\\Program Files\\MultiMC")),
            Some(PathBuf::from("C:\\PrismLauncher")),
            Some(PathBuf::from("C:\\MultiMC")),
        ];
        if let Some(ref dirs) = base_dirs {
            paths.push(Some(dirs.data_local_dir().join("PrismLauncher")));
            paths.push(Some(dirs.data_local_dir().join("MultiMC")));
            paths.push(Some(dirs.data_local_dir().join("PolyMC")));
            // Portable installations in user folders
            paths.push(Some(dirs.home_dir().join("PrismLauncher")));
            paths.push(Some(dirs.home_dir().join("MultiMC")));
        }
        paths
    };

    #[cfg(target_os = "linux")]
    let search_paths = {
        let mut paths: Vec<Option<PathBuf>> = Vec::new();
        if let Some(ref dirs) = base_dirs {
            paths.push(Some(dirs.data_dir().join("PrismLauncher")));
            paths.push(Some(dirs.data_dir().join("multimc")));
            paths.push(Some(dirs.data_dir().join("PolyMC")));
            paths.push(Some(dirs.home_dir().join(".local/share/PrismLauncher")));
            paths.push(Some(dirs.home_dir().join(".local/share/multimc")));
            // Flatpak locations
            paths.push(Some(dirs.home_dir().join(
                ".var/app/org.prismlauncher.PrismLauncher/data/PrismLauncher",
            )));
        }
        paths
    };

    #[cfg(target_os = "macos")]
    let search_paths = {
        let mut paths: Vec<Option<PathBuf>> = Vec::new();
        if let Some(ref dirs) = base_dirs {
            paths.push(Some(dirs.data_dir().join("PrismLauncher")));
            paths.push(Some(dirs.data_dir().join("MultiMC")));
            paths.push(Some(
                dirs.home_dir()
                    .join("Library/Application Support/PrismLauncher"),
            ));
            paths.push(Some(
                dirs.home_dir().join("Library/Application Support/MultiMC"),
            ));
        }
        paths
    };

    for path_opt in search_paths {
        if let Some(path) = path_opt {
            if path.exists() {
                let instances_path = path.join("instances");
                if instances_path.exists() {
                    // Count instances
                    let instance_count = count_instances(&instances_path).await;

                    if instance_count > 0 {
                        let launcher_type = detect_launcher_type(&path).await;

                        detected.push(DetectedLauncher {
                            launcher_type,
                            root_path: path.clone(),
                            instances_path,
                            instance_count,
                            display_name: launcher_type.display_name().to_string(),
                        });
                    }
                }
            }
        }
    }

    detected
}

/// Count valid instances in directory
async fn count_instances(instances_dir: &Path) -> usize {
    let mut count = 0;

    if let Ok(mut entries) = fs::read_dir(instances_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if path.is_dir() && path.join("instance.cfg").exists() {
                count += 1;
            }
        }
    }

    count
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mmc_pack_parsing() {
        let json = r#"{
            "formatVersion": 1,
            "components": [
                {"uid": "net.minecraft", "version": "1.20.1"},
                {"uid": "net.fabricmc.fabric-loader", "version": "0.14.21"}
            ]
        }"#;

        let pack: MMCPack = serde_json::from_str(json).unwrap();
        assert_eq!(pack.minecraft_version(), Some("1.20.1".to_string()));

        let (loader, version) = pack.loader_info();
        assert_eq!(loader, "fabric");
        assert_eq!(version, Some("0.14.21".to_string()));
    }

    #[test]
    fn test_loader_detection() {
        let json_forge = r#"{
            "formatVersion": 1,
            "components": [
                {"uid": "net.minecraft", "version": "1.20.1"},
                {"uid": "net.minecraftforge", "version": "47.2.0"}
            ]
        }"#;

        let pack: MMCPack = serde_json::from_str(json_forge).unwrap();
        let (loader, _) = pack.loader_info();
        assert_eq!(loader, "forge");
    }
}
