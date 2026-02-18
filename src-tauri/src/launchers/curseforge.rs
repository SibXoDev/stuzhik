//! CurseForge App instance parser
//!
//! Parses minecraftinstance.json files from CurseForge installations.

use super::types::*;
use directories::BaseDirs;
use std::path::{Path, PathBuf};
use tokio::fs;

/// Parse minecraftinstance.json
pub async fn parse_instance_json(instance_dir: &Path) -> LauncherResult<CurseForgeInstance> {
    let json_path = instance_dir.join("minecraftinstance.json");

    if !fs::try_exists(&json_path).await.unwrap_or(false) {
        return Err(LauncherError::NotFound(format!(
            "minecraftinstance.json not found in {}",
            instance_dir.display()
        )));
    }

    let content = fs::read_to_string(&json_path).await?;
    let instance: CurseForgeInstance = serde_json::from_str(&content).map_err(|e| {
        LauncherError::ParseError(format!("Failed to parse minecraftinstance.json: {}", e))
    })?;

    Ok(instance)
}

/// Count mods in CurseForge instance
async fn count_mods(instance_dir: &Path) -> usize {
    let mods_dir = instance_dir.join("mods");

    if !fs::try_exists(&mods_dir).await.unwrap_or(false) {
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

/// Parse a single CurseForge instance
pub async fn parse_instance(instance_dir: &Path) -> LauncherResult<LauncherInstance> {
    let cf_instance = parse_instance_json(instance_dir).await?;

    // Get loader info
    let (loader, loader_version, minecraft_version) =
        if let Some(ref mod_loader) = cf_instance.base_mod_loader {
            let (loader, version) = mod_loader.parse();
            let mc_version = mod_loader
                .minecraft_version
                .clone()
                .unwrap_or_else(|| "unknown".to_string());
            (loader, version, mc_version)
        } else {
            ("vanilla".to_string(), None, "unknown".to_string())
        };

    // Count mods
    let mods_count = count_mods(instance_dir).await;

    // Calculate size
    let total_size = calculate_size(instance_dir).await;

    // Notes from modpack info
    let notes = cf_instance
        .installed_modpack
        .as_ref()
        .and_then(|mp| mp.name.clone())
        .map(|name| format!("Imported from CurseForge modpack: {}", name));

    Ok(LauncherInstance {
        name: cf_instance.name,
        path: instance_dir.to_path_buf(),
        minecraft_version,
        loader,
        loader_version,
        instance_type: "client".to_string(),
        mods_count,
        total_size,
        last_played: cf_instance.last_played,
        icon_path: None, // CurseForge doesn't have standard icon paths
        java_args: cf_instance.java_args_override,
        memory_min: None,
        memory_max: cf_instance.allocated_memory,
        source_launcher: LauncherType::CurseForgeApp,
        notes,
        confidence: 85,
    })
}

/// List all instances in CurseForge installation
pub async fn list_instances(launcher_root: &Path) -> LauncherResult<Vec<LauncherInstance>> {
    // CurseForge stores instances in Instances/ folder
    let instances_dir = launcher_root.join("Instances");
    if !fs::try_exists(&instances_dir).await.unwrap_or(false) {
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

        // Skip hidden folders
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }

        // Check if it's a valid instance (has minecraftinstance.json)
        if !fs::try_exists(path.join("minecraftinstance.json")).await.unwrap_or(false) {
            continue;
        }

        match parse_instance(&path).await {
            Ok(instance) => instances.push(instance),
            Err(e) => {
                log::warn!(
                    "Failed to parse CurseForge instance at {}: {}",
                    path.display(),
                    e
                );
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

/// Detect CurseForge App installations on the system
pub async fn detect_installations() -> Vec<DetectedLauncher> {
    let mut detected = Vec::new();

    let base_dirs = BaseDirs::new();

    // Common installation paths per OS
    #[cfg(target_os = "windows")]
    let search_paths = {
        let mut paths: Vec<Option<PathBuf>> =
            vec![Some(PathBuf::from("C:\\CurseForge\\minecraft"))];
        if let Some(ref dirs) = base_dirs {
            // Standard CurseForge location
            paths.push(Some(dirs.home_dir().join("curseforge").join("minecraft")));
        }
        paths
    };

    #[cfg(target_os = "linux")]
    let search_paths = {
        let mut paths: Vec<Option<PathBuf>> = Vec::new();
        if let Some(ref dirs) = base_dirs {
            paths.push(Some(dirs.home_dir().join(".curseforge").join("minecraft")));
            paths.push(Some(dirs.data_dir().join("curseforge").join("minecraft")));
        }
        paths
    };

    #[cfg(target_os = "macos")]
    let search_paths = {
        let mut paths: Vec<Option<PathBuf>> = Vec::new();
        if let Some(ref dirs) = base_dirs {
            paths.push(Some(dirs.home_dir().join("curseforge").join("minecraft")));
            paths.push(Some(dirs.data_dir().join("curseforge").join("minecraft")));
        }
        paths
    };

    for path_opt in search_paths {
        if let Some(path) = path_opt {
            if fs::try_exists(&path).await.unwrap_or(false) {
                let instances_path = path.join("Instances");
                if fs::try_exists(&instances_path).await.unwrap_or(false) {
                    let instance_count = count_instances(&instances_path).await;

                    if instance_count > 0 {
                        detected.push(DetectedLauncher {
                            launcher_type: LauncherType::CurseForgeApp,
                            root_path: path.clone(),
                            instances_path,
                            instance_count,
                            display_name: "CurseForge App".to_string(),
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
            if path.is_dir()
                && fs::try_exists(path.join("minecraftinstance.json")).await.unwrap_or(false)
            {
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
    fn test_mod_loader_parsing() {
        let loader = CurseForgeModLoader {
            name: "forge-47.2.0".to_string(),
            minecraft_version: Some("1.20.1".to_string()),
            forge_version: None,
        };

        let (loader_type, version) = loader.parse();
        assert_eq!(loader_type, "forge");
        assert_eq!(version, Some("47.2.0".to_string()));
    }

    #[test]
    fn test_fabric_loader_parsing() {
        let loader = CurseForgeModLoader {
            name: "fabric-0.14.21".to_string(),
            minecraft_version: Some("1.20.1".to_string()),
            forge_version: None,
        };

        let (loader_type, version) = loader.parse();
        assert_eq!(loader_type, "fabric");
        assert_eq!(version, Some("0.14.21".to_string()));
    }
}
