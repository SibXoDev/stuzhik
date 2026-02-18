//! Game type definitions and utilities
//!
//! Stuzhik supports multiple games: Minecraft and Hytale.
//! This module provides common types and utilities for game management.

use serde::{Deserialize, Serialize};

/// Supported game types
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GameType {
    Minecraft,
    Hytale,
}

impl GameType {
    /// Get the display name of the game
    pub fn display_name(&self) -> &'static str {
        match self {
            GameType::Minecraft => "Minecraft",
            GameType::Hytale => "Hytale",
        }
    }

    /// Get the CurseForge game ID
    pub fn curseforge_id(&self) -> u32 {
        match self {
            GameType::Minecraft => 432,
            GameType::Hytale => 83374, // Hytale CurseForge game ID
        }
    }

    /// Check if the game supports Modrinth
    pub fn supports_modrinth(&self) -> bool {
        match self {
            GameType::Minecraft => true,
            GameType::Hytale => false,
        }
    }

    /// Get the game's accent color (hex)
    pub fn accent_color(&self) -> &'static str {
        match self {
            GameType::Minecraft => "#5D8731",
            GameType::Hytale => "#E85D04",
        }
    }
}

impl Default for GameType {
    fn default() -> Self {
        GameType::Minecraft
    }
}

impl std::fmt::Display for GameType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.display_name())
    }
}

impl std::str::FromStr for GameType {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "minecraft" => Ok(GameType::Minecraft),
            "hytale" => Ok(GameType::Hytale),
            _ => Err(format!("Unknown game type: {}", s)),
        }
    }
}

/// Game installation information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameInstallation {
    pub game: GameType,
    pub path: String,
    pub version: Option<String>,
    pub is_installed: bool,
}

/// Detect installed games on the system
pub async fn detect_installed_games() -> Vec<GameInstallation> {
    let mut installations = Vec::new();

    // Detect Minecraft
    if let Some(mc_install) = detect_minecraft_installation().await {
        installations.push(mc_install);
    }

    // Detect Hytale
    if let Some(hytale_install) = detect_hytale_installation().await {
        installations.push(hytale_install);
    }

    installations
}

/// Get default Minecraft installation path for the current OS
fn get_minecraft_default_path() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA").map(|p| std::path::PathBuf::from(p).join(".minecraft"))
    }

    #[cfg(target_os = "macos")]
    {
        dirs::home_dir().map(|p| p.join("Library/Application Support/minecraft"))
    }

    #[cfg(target_os = "linux")]
    {
        dirs::home_dir().map(|p| p.join(".minecraft"))
    }
}

/// Detect Minecraft installation
async fn detect_minecraft_installation() -> Option<GameInstallation> {
    let mc_path = get_minecraft_default_path()?;

    Some(GameInstallation {
        game: GameType::Minecraft,
        path: mc_path.to_string_lossy().to_string(),
        version: None, // Could detect from launcher_profiles.json
        is_installed: tokio::fs::try_exists(&mc_path).await.unwrap_or(false),
    })
}

/// Detect Hytale installation
async fn detect_hytale_installation() -> Option<GameInstallation> {
    let hytale_paths = get_hytale_default_paths();

    for path in &hytale_paths {
        if tokio::fs::try_exists(std::path::Path::new(path)).await.unwrap_or(false) {
            return Some(GameInstallation {
                game: GameType::Hytale,
                path: path.clone(),
                version: None, // TODO: detect version from game files
                is_installed: true,
            });
        }
    }

    // Return first default path as not installed
    Some(GameInstallation {
        game: GameType::Hytale,
        path: hytale_paths.into_iter().next().unwrap_or_default(),
        version: None,
        is_installed: false,
    })
}

/// Get default Hytale installation paths for the current OS
fn get_hytale_default_paths() -> Vec<String> {
    let mut paths = Vec::new();

    #[cfg(target_os = "windows")]
    {
        // Common Windows installation paths
        if let Some(program_files) = std::env::var_os("ProgramFiles") {
            paths.push(format!("{}\\Hytale", program_files.to_string_lossy()));
        }
        if let Some(program_files_x86) = std::env::var_os("ProgramFiles(x86)") {
            paths.push(format!("{}\\Hytale", program_files_x86.to_string_lossy()));
        }
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            paths.push(format!("{}\\Hytale", local_app_data.to_string_lossy()));
        }
        // Steam path
        if let Some(program_files) = std::env::var_os("ProgramFiles(x86)") {
            paths.push(format!(
                "{}\\Steam\\steamapps\\common\\Hytale",
                program_files.to_string_lossy()
            ));
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Some(home) = std::env::var_os("HOME") {
            paths.push(format!(
                "{}/Library/Application Support/Hytale",
                home.to_string_lossy()
            ));
            paths.push(format!(
                "{}/Library/Application Support/Steam/steamapps/common/Hytale",
                home.to_string_lossy()
            ));
        }
        paths.push("/Applications/Hytale.app".to_string());
    }

    #[cfg(target_os = "linux")]
    {
        if let Some(home) = std::env::var_os("HOME") {
            paths.push(format!("{}/.local/share/Hytale", home.to_string_lossy()));
            paths.push(format!(
                "{}/.steam/steam/steamapps/common/Hytale",
                home.to_string_lossy()
            ));
        }
    }

    paths
}

// Tauri commands

/// Get list of supported games
#[tauri::command]
pub fn get_supported_games() -> Vec<serde_json::Value> {
    vec![
        serde_json::json!({
            "id": "minecraft",
            "name": "Minecraft",
            "icon": "i-hugeicons-cube-01",
            "curseforgeId": 432,
            "hasModrinth": true,
            "accentColor": "#5D8731"
        }),
        serde_json::json!({
            "id": "hytale",
            "name": "Hytale",
            "icon": "i-hugeicons-sword-01",
            "curseforgeId": 83374,
            "hasModrinth": false,
            "accentColor": "#E85D04"
        }),
    ]
}

/// Detect installed games
#[tauri::command]
pub async fn detect_games() -> Vec<GameInstallation> {
    detect_installed_games().await
}
