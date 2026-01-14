//! Official Minecraft Launcher (Legacy Launcher) parser
//!
//! Parses launcher_profiles.json from the official Minecraft launcher.
//! Supports both old and new launcher versions.

use super::types::*;
use directories::BaseDirs;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::fs;

/// Profile from launcher_profiles.json
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LauncherProfile {
    name: Option<String>,
    #[serde(rename = "type")]
    profile_type: Option<String>,
    last_version_id: Option<String>,
    game_dir: Option<String>,
    java_args: Option<String>,
    last_used: Option<String>,
}

/// launcher_profiles.json structure
#[derive(Debug, Deserialize)]
struct LauncherProfiles {
    profiles: Option<HashMap<String, LauncherProfile>>,
}

/// Parse launcher_profiles.json
pub async fn parse_launcher_profiles(
    minecraft_dir: &Path,
) -> LauncherResult<Vec<LauncherInstance>> {
    let profiles_path = minecraft_dir.join("launcher_profiles.json");

    if !profiles_path.exists() {
        return Err(LauncherError::NotFound(format!(
            "launcher_profiles.json not found in {}",
            minecraft_dir.display()
        )));
    }

    let content = fs::read_to_string(&profiles_path).await?;
    let data: LauncherProfiles = serde_json::from_str(&content).map_err(|e| {
        LauncherError::ParseError(format!("Failed to parse launcher_profiles.json: {}", e))
    })?;

    let mut instances = Vec::new();

    if let Some(profiles) = data.profiles {
        for (id, profile) in profiles {
            // Skip "latest-release" and "latest-snapshot" default profiles
            if let Some(ref ptype) = profile.profile_type {
                if ptype == "latest-release" || ptype == "latest-snapshot" {
                    continue;
                }
            }

            let name = profile.name.unwrap_or_else(|| id.clone());

            // Determine the game directory
            let game_dir = if let Some(ref dir) = profile.game_dir {
                PathBuf::from(dir)
            } else {
                minecraft_dir.to_path_buf()
            };

            // Extract version info
            let minecraft_version = profile.last_version_id.clone();

            // Detect loader from version string
            let (loader, loader_version) =
                detect_loader_from_version(minecraft_version.as_deref().unwrap_or(""));

            // Count mods if mods folder exists
            let mods_count = count_mods(&game_dir).await;

            // Calculate size
            let total_size = calculate_dir_size(&game_dir).await;

            instances.push(LauncherInstance {
                name,
                path: game_dir,
                minecraft_version: minecraft_version.unwrap_or_else(|| "unknown".to_string()),
                loader: loader.to_string(),
                loader_version,
                instance_type: "client".to_string(),
                mods_count,
                total_size,
                last_played: profile.last_used,
                icon_path: None,
                java_args: profile.java_args,
                memory_min: None,
                memory_max: None,
                source_launcher: LauncherType::OfficialLauncher,
                notes: None,
                confidence: 80,
            });
        }
    }

    Ok(instances)
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
    } else {
        ("vanilla", None)
    }
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

/// List all instances from the official launcher
pub async fn list_instances(minecraft_dir: &Path) -> LauncherResult<Vec<LauncherInstance>> {
    parse_launcher_profiles(minecraft_dir).await
}

/// Detect official Minecraft Launcher installations
pub async fn detect_installations() -> Vec<DetectedLauncher> {
    let mut detected = Vec::new();

    let base_dirs = BaseDirs::new();

    // Common installation paths per OS
    #[cfg(target_os = "windows")]
    let search_paths = {
        let mut paths: Vec<Option<PathBuf>> = Vec::new();
        if let Some(ref dirs) = base_dirs {
            // Standard .minecraft location
            paths.push(Some(dirs.data_dir().join(".minecraft")));
        }
        // Also check APPDATA directly
        if let Ok(appdata) = std::env::var("APPDATA") {
            paths.push(Some(PathBuf::from(appdata).join(".minecraft")));
        }
        paths
    };

    #[cfg(target_os = "linux")]
    let search_paths = {
        let mut paths: Vec<Option<PathBuf>> = Vec::new();
        if let Some(ref dirs) = base_dirs {
            paths.push(Some(dirs.home_dir().join(".minecraft")));
        }
        paths
    };

    #[cfg(target_os = "macos")]
    let search_paths = {
        let mut paths: Vec<Option<PathBuf>> = Vec::new();
        if let Some(ref dirs) = base_dirs {
            paths.push(Some(
                dirs.home_dir()
                    .join("Library/Application Support/minecraft"),
            ));
        }
        paths
    };

    for path_opt in search_paths {
        if let Some(path) = path_opt {
            // Check for launcher_profiles.json
            let profiles_path = path.join("launcher_profiles.json");
            if profiles_path.exists() {
                // Count profiles
                let instance_count = match parse_launcher_profiles(&path).await {
                    Ok(instances) => instances.len(),
                    Err(_) => 0,
                };

                if instance_count > 0 {
                    detected.push(DetectedLauncher {
                        launcher_type: LauncherType::OfficialLauncher,
                        root_path: path.clone(),
                        instances_path: path,
                        instance_count,
                        display_name: "Minecraft Launcher".to_string(),
                    });
                }
            }
        }
    }

    detected
}
