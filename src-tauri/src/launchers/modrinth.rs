//! Modrinth App instance parser
//!
//! Parses profile.json files from Modrinth App installations.

use super::types::*;
use directories::BaseDirs;
use std::path::{Path, PathBuf};
use tokio::fs;

/// Parse profile.json
pub async fn parse_profile_json(profile_dir: &Path) -> LauncherResult<ModrinthProfile> {
    let json_path = profile_dir.join("profile.json");

    if !fs::try_exists(&json_path).await.unwrap_or(false) {
        return Err(LauncherError::NotFound(format!(
            "profile.json not found in {}",
            profile_dir.display()
        )));
    }

    let content = fs::read_to_string(&json_path).await?;
    let profile: ModrinthProfile = serde_json::from_str(&content)
        .map_err(|e| LauncherError::ParseError(format!("Failed to parse profile.json: {}", e)))?;

    Ok(profile)
}

/// Count mods in Modrinth profile
async fn count_mods(profile_dir: &Path) -> usize {
    let mods_dir = profile_dir.join("mods");

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

/// Calculate total profile size
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

/// Parse a single Modrinth profile
pub async fn parse_instance(profile_dir: &Path) -> LauncherResult<LauncherInstance> {
    let profile = parse_profile_json(profile_dir).await?;

    // Get loader info
    let loader = profile
        .loader
        .clone()
        .unwrap_or_else(|| "vanilla".to_string());
    let loader_version = profile.loader_version.clone();

    // Count mods
    let mods_count = count_mods(profile_dir).await;

    // Calculate size
    let total_size = calculate_size(profile_dir).await;

    // Icon path
    let icon_path = profile
        .icon_path
        .as_ref()
        .map(|p| profile_dir.join(p))
        .filter(|p| p.exists());

    Ok(LauncherInstance {
        name: profile.name,
        path: profile_dir.to_path_buf(),
        minecraft_version: profile.game_version,
        loader,
        loader_version,
        instance_type: "client".to_string(),
        mods_count,
        total_size,
        last_played: profile.modified,
        icon_path,
        java_args: None,
        memory_min: None,
        memory_max: None,
        source_launcher: LauncherType::Modrinth,
        notes: None,
        confidence: 90,
    })
}

/// List all profiles in Modrinth App
pub async fn list_instances(launcher_root: &Path) -> LauncherResult<Vec<LauncherInstance>> {
    // Modrinth App stores profiles in profiles/ folder
    let profiles_dir = launcher_root.join("profiles");
    if !fs::try_exists(&profiles_dir).await.unwrap_or(false) {
        return Err(LauncherError::NotFound(format!(
            "Profiles directory not found in {}",
            launcher_root.display()
        )));
    }

    let mut instances = Vec::new();

    let mut entries = fs::read_dir(&profiles_dir).await?;
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

        // Check if it's a valid profile (has profile.json)
        if !fs::try_exists(path.join("profile.json")).await.unwrap_or(false) {
            continue;
        }

        match parse_instance(&path).await {
            Ok(instance) => instances.push(instance),
            Err(e) => {
                log::warn!(
                    "Failed to parse Modrinth profile at {}: {}",
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

/// Detect Modrinth App installations on the system
pub async fn detect_installations() -> Vec<DetectedLauncher> {
    let mut detected = Vec::new();

    let base_dirs = BaseDirs::new();

    // Common installation paths per OS
    #[cfg(target_os = "windows")]
    let search_paths = {
        let mut paths: Vec<Option<PathBuf>> = Vec::new();
        if let Some(ref dirs) = base_dirs {
            paths.push(Some(dirs.data_local_dir().join("ModrinthApp")));
            paths.push(Some(dirs.data_dir().join("ModrinthApp")));
        }
        paths
    };

    #[cfg(target_os = "linux")]
    let search_paths = {
        let mut paths: Vec<Option<PathBuf>> = Vec::new();
        if let Some(ref dirs) = base_dirs {
            paths.push(Some(dirs.data_dir().join("ModrinthApp")));
            paths.push(Some(dirs.home_dir().join(".local/share/ModrinthApp")));
            // Flatpak location
            paths.push(Some(
                dirs.home_dir()
                    .join(".var/app/com.modrinth.ModrinthApp/data/ModrinthApp"),
            ));
        }
        paths
    };

    #[cfg(target_os = "macos")]
    let search_paths = {
        let mut paths: Vec<Option<PathBuf>> = Vec::new();
        if let Some(ref dirs) = base_dirs {
            paths.push(Some(dirs.data_dir().join("ModrinthApp")));
            paths.push(Some(
                dirs.home_dir()
                    .join("Library/Application Support/ModrinthApp"),
            ));
        }
        paths
    };

    for path_opt in search_paths {
        if let Some(path) = path_opt {
            if fs::try_exists(&path).await.unwrap_or(false) {
                let profiles_path = path.join("profiles");
                if fs::try_exists(&profiles_path).await.unwrap_or(false) {
                    let instance_count = count_instances(&profiles_path).await;

                    if instance_count > 0 {
                        detected.push(DetectedLauncher {
                            launcher_type: LauncherType::Modrinth,
                            root_path: path.clone(),
                            instances_path: profiles_path,
                            instance_count,
                            display_name: "Modrinth App".to_string(),
                        });
                    }
                }
            }
        }
    }

    detected
}

/// Count valid profiles in directory
async fn count_instances(profiles_dir: &Path) -> usize {
    let mut count = 0;

    if let Ok(mut entries) = fs::read_dir(profiles_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if path.is_dir()
                && fs::try_exists(path.join("profile.json")).await.unwrap_or(false)
            {
                count += 1;
            }
        }
    }

    count
}
