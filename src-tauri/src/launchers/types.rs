//! Unified types for launcher instance imports
//!
//! Supports importing from:
//! - MultiMC / Prism Launcher (instance.cfg + mmc-pack.json)
//! - CurseForge App (minecraftinstance.json)
//! - ATLauncher (instance.json) - future
//! - GDLauncher (config.json) - future

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Supported launcher types
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LauncherType {
    MultiMC,
    Prism,
    CurseForgeApp,
    ATLauncher,
    GDLauncher,
    Modrinth,
    /// Official Minecraft Launcher
    OfficialLauncher,
    /// Legacy Launcher (llaun.ch) - stores files in .tlauncher/legacy
    LegacyLauncher,
}

impl LauncherType {
    /// Human-readable name
    pub fn display_name(&self) -> &'static str {
        match self {
            Self::MultiMC => "MultiMC",
            Self::Prism => "Prism Launcher",
            Self::CurseForgeApp => "CurseForge App",
            Self::ATLauncher => "ATLauncher",
            Self::GDLauncher => "GDLauncher",
            Self::Modrinth => "Modrinth App",
            Self::OfficialLauncher => "Minecraft Launcher",
            Self::LegacyLauncher => "Legacy Launcher",
        }
    }

    /// Instance directory pattern (for auto-detection)
    pub fn instances_folder_name(&self) -> &'static str {
        match self {
            Self::MultiMC => "instances",
            Self::Prism => "instances",
            Self::CurseForgeApp => "Instances",
            Self::ATLauncher => "instances",
            Self::GDLauncher => "instances",
            Self::Modrinth => "profiles",
            // Official launcher uses profiles from launcher_profiles.json, not a folder
            Self::OfficialLauncher => ".",
            // Legacy Launcher stores versions in .tlauncher/legacy/versions
            Self::LegacyLauncher => "versions",
        }
    }
}

/// Detected launcher installation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectedLauncher {
    /// Type of launcher
    pub launcher_type: LauncherType,
    /// Root directory of the launcher
    pub root_path: PathBuf,
    /// Path to instances folder
    pub instances_path: PathBuf,
    /// Number of instances found
    pub instance_count: usize,
    /// Display name for UI
    pub display_name: String,
}

/// Instance from another launcher (ready for import)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LauncherInstance {
    /// Instance name
    pub name: String,
    /// Path to instance directory
    pub path: PathBuf,
    /// Minecraft version
    pub minecraft_version: String,
    /// Mod loader (fabric, forge, quilt, neoforge, vanilla)
    pub loader: String,
    /// Loader version (if applicable)
    pub loader_version: Option<String>,
    /// Instance type (client/server)
    pub instance_type: String,
    /// Number of mods
    pub mods_count: usize,
    /// Total size in bytes
    pub total_size: u64,
    /// Last played timestamp (if available)
    pub last_played: Option<String>,
    /// Instance icon path (if available)
    pub icon_path: Option<PathBuf>,
    /// Java arguments (if configured)
    pub java_args: Option<String>,
    /// Memory allocation (min/max in MB)
    pub memory_min: Option<u32>,
    pub memory_max: Option<u32>,
    /// Source launcher type
    pub source_launcher: LauncherType,
    /// Notes/description
    pub notes: Option<String>,
    /// Detection confidence (0-100)
    pub confidence: u8,
}

/// Import progress event
#[derive(Debug, Clone, Serialize)]
pub struct LauncherImportProgress {
    /// Current phase
    pub phase: String,
    /// Current item index
    pub current: usize,
    /// Total items
    pub total: usize,
    /// Current file being processed
    pub current_file: Option<String>,
    /// Bytes copied so far
    pub bytes_copied: u64,
    /// Total bytes to copy
    pub total_bytes: u64,
}

/// Import result
#[derive(Debug, Clone, Serialize)]
pub struct LauncherImportResult {
    /// New instance ID in Stuzhik
    pub instance_id: String,
    /// Original instance name
    pub original_name: String,
    /// Number of files copied
    pub files_copied: usize,
    /// Total size in bytes
    pub total_size: u64,
    /// Number of mods imported
    pub mods_imported: usize,
    /// Warnings during import
    pub warnings: Vec<String>,
}

// ========== MultiMC/Prism Specific Types ==========

/// MultiMC/Prism instance.cfg parser
#[derive(Debug, Clone, Default)]
pub struct MultiMCInstanceCfg {
    pub name: String,
    pub icon_key: Option<String>,
    pub notes: Option<String>,
    pub java_path: Option<String>,
    pub jvm_args: Option<String>,
    pub min_memory: Option<u32>,
    pub max_memory: Option<u32>,
    pub last_launched: Option<i64>,
    pub total_time_played: Option<i64>,
}

/// MultiMC/Prism mmc-pack.json component
#[derive(Debug, Clone, Deserialize)]
pub struct MMCComponent {
    /// Component UID (e.g., "net.minecraft", "net.fabricmc.fabric-loader")
    pub uid: String,
    /// Version string
    pub version: String,
    /// Whether this is an important component
    #[serde(default)]
    pub important: bool,
    /// Cached name
    #[serde(rename = "cachedName")]
    pub cached_name: Option<String>,
    /// Cached version (for display)
    #[serde(rename = "cachedVersion")]
    pub cached_version: Option<String>,
}

/// MultiMC/Prism mmc-pack.json format
#[derive(Debug, Clone, Deserialize)]
pub struct MMCPack {
    /// Format version
    #[serde(rename = "formatVersion")]
    pub format_version: u32,
    /// Components list
    pub components: Vec<MMCComponent>,
}

impl MMCPack {
    /// Get Minecraft version from components
    pub fn minecraft_version(&self) -> Option<String> {
        self.components
            .iter()
            .find(|c| c.uid == "net.minecraft")
            .map(|c| c.version.clone())
    }

    /// Get loader info from components
    pub fn loader_info(&self) -> (String, Option<String>) {
        // Check Fabric
        if let Some(fabric) = self
            .components
            .iter()
            .find(|c| c.uid == "net.fabricmc.fabric-loader")
        {
            return ("fabric".to_string(), Some(fabric.version.clone()));
        }

        // Check Quilt
        if let Some(quilt) = self
            .components
            .iter()
            .find(|c| c.uid == "org.quiltmc.quilt-loader")
        {
            return ("quilt".to_string(), Some(quilt.version.clone()));
        }

        // Check NeoForge
        if let Some(neoforge) = self.components.iter().find(|c| c.uid == "net.neoforged") {
            return ("neoforge".to_string(), Some(neoforge.version.clone()));
        }

        // Check Forge
        if let Some(forge) = self
            .components
            .iter()
            .find(|c| c.uid == "net.minecraftforge")
        {
            return ("forge".to_string(), Some(forge.version.clone()));
        }

        ("vanilla".to_string(), None)
    }
}

// ========== CurseForge App Specific Types ==========

/// CurseForge App minecraftinstance.json
#[derive(Debug, Clone, Deserialize)]
pub struct CurseForgeInstance {
    /// Instance name
    pub name: String,
    /// Game directory name (usually "minecraft")
    #[serde(rename = "gameDir")]
    pub game_dir: Option<String>,
    /// Base mod loader info
    #[serde(rename = "baseModLoader")]
    pub base_mod_loader: Option<CurseForgeModLoader>,
    /// Last played timestamp
    #[serde(rename = "lastPlayed")]
    pub last_played: Option<String>,
    /// Play time in seconds
    #[serde(rename = "playedCount")]
    pub played_count: Option<u64>,
    /// JVM arguments
    #[serde(rename = "javaArgsOverride")]
    pub java_args_override: Option<String>,
    /// Memory allocation
    #[serde(rename = "allocatedMemory")]
    pub allocated_memory: Option<u32>,
    /// Profile ID
    #[serde(rename = "profileId")]
    pub profile_id: Option<String>,
    /// Installed modpack info
    #[serde(rename = "installedModpack")]
    pub installed_modpack: Option<CurseForgeInstalledModpack>,
}

/// CurseForge mod loader info
#[derive(Debug, Clone, Deserialize)]
pub struct CurseForgeModLoader {
    /// Loader name (e.g., "forge-47.2.0")
    pub name: String,
    /// Minecraft version
    #[serde(rename = "minecraftVersion")]
    pub minecraft_version: Option<String>,
    /// Forge version (if applicable)
    #[serde(rename = "forgeVersion")]
    pub forge_version: Option<String>,
}

impl CurseForgeModLoader {
    /// Parse loader type and version
    pub fn parse(&self) -> (String, Option<String>) {
        let name = &self.name;

        if name.starts_with("forge-") {
            let version = name.strip_prefix("forge-").map(String::from);
            return ("forge".to_string(), version);
        }

        if name.starts_with("fabric-") {
            let version = name.strip_prefix("fabric-").map(String::from);
            return ("fabric".to_string(), version);
        }

        if name.starts_with("neoforge-") {
            let version = name.strip_prefix("neoforge-").map(String::from);
            return ("neoforge".to_string(), version);
        }

        if name.starts_with("quilt-") {
            let version = name.strip_prefix("quilt-").map(String::from);
            return ("quilt".to_string(), version);
        }

        // Fallback: try forge version field
        if let Some(ref fv) = self.forge_version {
            return ("forge".to_string(), Some(fv.clone()));
        }

        ("vanilla".to_string(), None)
    }
}

/// CurseForge installed modpack info
#[derive(Debug, Clone, Deserialize)]
pub struct CurseForgeInstalledModpack {
    #[serde(rename = "projectID")]
    pub project_id: Option<u64>,
    #[serde(rename = "fileID")]
    pub file_id: Option<u64>,
    pub name: Option<String>,
}

// ========== Modrinth App Specific Types ==========

/// Modrinth App profile.json
#[derive(Debug, Clone, Deserialize)]
pub struct ModrinthProfile {
    /// Profile name
    pub name: String,
    /// Minecraft version
    #[serde(rename = "game_version")]
    pub game_version: String,
    /// Loader type
    pub loader: Option<String>,
    /// Loader version
    #[serde(rename = "loader_version")]
    pub loader_version: Option<String>,
    /// Created timestamp
    pub created: Option<String>,
    /// Last modified
    pub modified: Option<String>,
    /// Icon path
    pub icon_path: Option<String>,
}

// ========== Error Types ==========

/// Launcher import error
#[derive(Debug, thiserror::Error)]
pub enum LauncherError {
    #[error("Launcher not found at path: {0}")]
    NotFound(String),

    #[error("Invalid launcher format: {0}")]
    InvalidFormat(String),

    #[error("Instance not found: {0}")]
    InstanceNotFound(String),

    #[error("Failed to parse config: {0}")]
    ParseError(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Database error: {0}")]
    Database(String),

    #[error("Import cancelled")]
    Cancelled,
}

pub type LauncherResult<T> = Result<T, LauncherError>;
