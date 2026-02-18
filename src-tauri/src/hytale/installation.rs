//! Hytale installation detection and management

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Hytale installation information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HytaleInstallation {
    /// Installation path
    pub path: String,
    /// Game version if detected
    pub version: Option<String>,
    /// Executable path
    pub executable: Option<String>,
    /// Whether this is a Steam installation
    pub is_steam: bool,
}

/// Detect Hytale installation on the system
pub async fn detect_hytale() -> Option<HytaleInstallation> {
    let paths = get_hytale_search_paths();

    for (path, is_steam) in paths {
        if let Some(installation) = check_hytale_installation(&path, is_steam).await {
            return Some(installation);
        }
    }

    None
}

/// Get paths to search for Hytale installation
fn get_hytale_search_paths() -> Vec<(PathBuf, bool)> {
    let mut paths = Vec::new();

    #[cfg(target_os = "windows")]
    {
        // Steam installation
        if let Some(program_files) = std::env::var_os("ProgramFiles(x86)") {
            let steam_path = PathBuf::from(program_files).join("Steam/steamapps/common/Hytale");
            paths.push((steam_path, true));
        }

        // Standard installation paths
        if let Some(program_files) = std::env::var_os("ProgramFiles") {
            paths.push((PathBuf::from(program_files).join("Hytale"), false));
        }

        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            paths.push((PathBuf::from(local_app_data).join("Hytale"), false));
        }

        // Hypixel Studios launcher path
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            paths.push((
                PathBuf::from(local_app_data).join("Programs/Hytale"),
                false,
            ));
        }
    }

    #[cfg(target_os = "macos")]
    {
        paths.push((PathBuf::from("/Applications/Hytale.app"), false));

        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home);

            // Steam
            paths.push((
                home.join("Library/Application Support/Steam/steamapps/common/Hytale"),
                true,
            ));

            // Standard
            paths.push((home.join("Library/Application Support/Hytale"), false));
        }
    }

    #[cfg(target_os = "linux")]
    {
        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home);

            // Steam
            paths.push((
                home.join(".steam/steam/steamapps/common/Hytale"),
                true,
            ));
            paths.push((
                home.join(".local/share/Steam/steamapps/common/Hytale"),
                true,
            ));

            // Standard
            paths.push((home.join(".local/share/Hytale"), false));
        }
    }

    paths
}

/// Check if a path contains a valid Hytale installation
async fn check_hytale_installation(path: &Path, is_steam: bool) -> Option<HytaleInstallation> {
    if !tokio::fs::try_exists(path).await.unwrap_or(false) {
        return None;
    }

    // Look for the executable
    let executable = find_hytale_executable(path);
    if executable.is_none() {
        return None;
    }

    // Try to detect version
    let version = detect_hytale_version(path).await;

    Some(HytaleInstallation {
        path: path.to_string_lossy().to_string(),
        version,
        executable: executable.map(|p| p.to_string_lossy().to_string()),
        is_steam,
    })
}

/// Find the Hytale executable in an installation directory
fn find_hytale_executable(install_path: &Path) -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let exe = install_path.join("Hytale.exe");
        if exe.exists() {
            return Some(exe);
        }
    }

    #[cfg(target_os = "macos")]
    {
        // For .app bundles
        let app_exe = install_path.join("Contents/MacOS/Hytale");
        if app_exe.exists() {
            return Some(app_exe);
        }

        // For regular directories
        let exe = install_path.join("Hytale");
        if exe.exists() {
            return Some(exe);
        }
    }

    #[cfg(target_os = "linux")]
    {
        let exe = install_path.join("Hytale");
        if exe.exists() {
            return Some(exe);
        }

        let exe_bin = install_path.join("hytale");
        if exe_bin.exists() {
            return Some(exe_bin);
        }
    }

    None
}

/// Detect Hytale version from installation
async fn detect_hytale_version(install_path: &Path) -> Option<String> {
    // Try to read version from a manifest or version file
    let version_file = install_path.join("version.txt");
    if tokio::fs::try_exists(&version_file).await.unwrap_or(false) {
        if let Ok(content) = tokio::fs::read_to_string(&version_file).await {
            return Some(content.trim().to_string());
        }
    }

    // Try manifest.json
    let manifest_file = install_path.join("manifest.json");
    if tokio::fs::try_exists(&manifest_file).await.unwrap_or(false) {
        if let Ok(content) = tokio::fs::read_to_string(&manifest_file).await {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(version) = json.get("version").and_then(|v| v.as_str()) {
                    return Some(version.to_string());
                }
            }
        }
    }

    None
}

/// Get the default data directory for Hytale
pub fn get_hytale_data_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Some(app_data) = std::env::var_os("APPDATA") {
            return PathBuf::from(app_data).join("Hytale");
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join("Library/Application Support/Hytale");
        }
    }

    #[cfg(target_os = "linux")]
    {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(".local/share/Hytale");
        }
    }

    PathBuf::from(".")
}

// Tauri commands

/// Detect Hytale installation
#[tauri::command]
pub async fn detect_hytale_installation() -> Option<HytaleInstallation> {
    detect_hytale().await
}

/// Get Hytale data directory
#[tauri::command]
pub fn get_hytale_data_directory() -> String {
    get_hytale_data_dir().to_string_lossy().to_string()
}
