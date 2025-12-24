//! Server module - Full server management for Minecraft servers
//!
//! This module provides comprehensive server functionality:
//! - Server instance management (create, start, stop, delete)
//! - Loader installation (Fabric, Forge, NeoForge, Quilt, Vanilla)
//! - Real-time console with log streaming
//! - RCON client for remote commands
//! - server.properties parser and editor
//! - EULA handling
//! - Client mod detection and auto-disable
//! - Player management (whitelist, ops, bans)
//! - Server import from existing directories
//! - Detailed metrics for debugging (TPS, RAM, players, entities)

pub mod client_mods;
pub mod console;
pub mod eula;
pub mod import;
pub mod installer;
pub mod metrics;
pub mod players;
pub mod properties;
pub mod rcon;

use tauri::AppHandle;

// Re-export main types
pub use client_mods::{ClientModInfo, DetectionSource};
pub use console::{ServerConsole, ServerLogEntry, LogLevel};
pub use eula::EulaStatus;
pub use import::{DetectedServer, ImportResult};
pub use installer::{ServerLoader, InstallResult};
pub use metrics::{ServerMetrics, TpsData, MemoryMetrics, PlayerMetrics, WorldMetrics};
pub use players::{WhitelistEntry, OpEntry, BannedPlayer, BannedIp, PlayerManagement};
pub use properties::{ServerProperties, ServerPropertiesUI};
pub use rcon::RconClient;

/// Initialize server module
pub fn init(app: &AppHandle) {
    // Initialize console manager
    console::init(app);

    // Initialize metrics collector
    metrics::init(app);

    log::info!("Server module initialized");
}

/// Server-specific error types
#[derive(Debug, thiserror::Error)]
pub enum ServerError {
    #[error("Server not found: {0}")]
    NotFound(String),

    #[error("Server already running: {0}")]
    AlreadyRunning(String),

    #[error("Server not running: {0}")]
    NotRunning(String),

    #[error("EULA not accepted")]
    EulaNotAccepted,

    #[error("Port {0} already in use")]
    PortInUse(u16),

    #[error("RCON connection failed: {0}")]
    RconError(String),

    #[error("Invalid server.properties: {0}")]
    PropertiesError(String),

    #[error("Loader installation failed: {0}")]
    InstallerError(String),

    #[error("Import failed: {0}")]
    ImportError(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Database error: {0}")]
    Database(String),

    #[error("Configuration error: {0}")]
    Config(String),

    #[error("Network error: {0}")]
    Network(String),

    #[error("Process error: {0}")]
    Process(String),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

impl serde::Serialize for ServerError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type ServerResult<T> = Result<T, ServerError>;
