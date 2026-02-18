//! Hytale game support module
//!
//! This module provides Hytale-specific functionality:
//! - Game installation detection
//! - Game launching
//! - Mod management (CurseForge integration)
//! - Settings and localization
//! - Server support

pub mod execution;
pub mod installation;
pub mod mods;
pub mod settings;

pub use execution::*;
pub use installation::*;
pub use mods::*;
pub use settings::*;

use serde::{Deserialize, Serialize};

/// Hytale mod types
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HytaleModType {
    /// Asset/content packs - new blocks, mobs, items
    Pack,
    /// Java plugins using the game's API
    Plugin,
    /// Bootstrap plugins that run before server starts
    EarlyPlugin,
}

impl HytaleModType {
    pub fn display_name(&self) -> &'static str {
        match self {
            HytaleModType::Pack => "Pack",
            HytaleModType::Plugin => "Plugin",
            HytaleModType::EarlyPlugin => "Early Plugin",
        }
    }

    pub fn folder_name(&self) -> &'static str {
        match self {
            HytaleModType::Pack => "packs",
            HytaleModType::Plugin => "plugins",
            HytaleModType::EarlyPlugin => "early_plugins",
        }
    }
}

/// Hytale instance configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HytaleInstanceConfig {
    /// Game version
    pub version: Option<String>,
    /// Enabled mod types
    pub mod_types: Vec<HytaleModType>,
    /// Custom game arguments
    pub game_args: Option<String>,
    /// Server address to auto-connect
    pub auto_connect_server: Option<String>,
}

impl Default for HytaleInstanceConfig {
    fn default() -> Self {
        Self {
            version: None,
            mod_types: vec![HytaleModType::Pack, HytaleModType::Plugin],
            game_args: None,
            auto_connect_server: None,
        }
    }
}

/// Hytale game information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HytaleInfo {
    pub installed: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub executable: Option<String>,
}

/// Get Hytale game info
#[tauri::command]
pub async fn get_hytale_info() -> Result<HytaleInfo, String> {
    let installation = installation::detect_hytale().await;

    Ok(HytaleInfo {
        installed: installation.is_some(),
        path: installation.as_ref().map(|i| i.path.clone()),
        version: installation.as_ref().and_then(|i| i.version.clone()),
        executable: installation.as_ref().and_then(|i| i.executable.clone()),
    })
}
