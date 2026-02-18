//! EULA handling for Minecraft servers
//!
//! Minecraft servers require EULA acceptance before they can run.
//! This module handles reading, checking, and accepting the EULA.

use std::path::Path;
use tokio::fs;

use super::ServerResult;

/// EULA acceptance status
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct EulaStatus {
    /// Whether EULA file exists
    pub exists: bool,
    /// Whether EULA is accepted
    pub accepted: bool,
    /// EULA URL
    pub url: String,
}

impl Default for EulaStatus {
    fn default() -> Self {
        Self {
            exists: false,
            accepted: false,
            url: "https://aka.ms/MinecraftEULA".to_string(),
        }
    }
}

/// Check EULA status for a server
pub async fn check_eula(server_dir: impl AsRef<Path>) -> ServerResult<EulaStatus> {
    let eula_path = server_dir.as_ref().join("eula.txt");

    if !fs::try_exists(&eula_path).await.unwrap_or(false) {
        return Ok(EulaStatus::default());
    }

    let content = fs::read_to_string(&eula_path).await?;
    let accepted = content
        .lines()
        .filter(|line| !line.trim().starts_with('#'))
        .any(|line| line.to_lowercase().replace(' ', "").contains("eula=true"));

    Ok(EulaStatus {
        exists: true,
        accepted,
        url: "https://aka.ms/MinecraftEULA".to_string(),
    })
}

/// Accept EULA for a server
pub async fn accept_eula(server_dir: impl AsRef<Path>) -> ServerResult<()> {
    let eula_path = server_dir.as_ref().join("eula.txt");

    let content = format!(
        "#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).\n\
        #{}\n\
        eula=true\n",
        chrono::Utc::now().format("%a %b %d %H:%M:%S %Z %Y")
    );

    fs::write(&eula_path, content).await?;

    log::info!("EULA accepted at {:?}", eula_path);
    Ok(())
}

/// Create initial EULA file (not accepted)
pub async fn create_eula_file(server_dir: impl AsRef<Path>) -> ServerResult<()> {
    let eula_path = server_dir.as_ref().join("eula.txt");

    if fs::try_exists(&eula_path).await.unwrap_or(false) {
        return Ok(());
    }

    let content = format!(
        "#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).\n\
        #{}\n\
        eula=false\n",
        chrono::Utc::now().format("%a %b %d %H:%M:%S %Z %Y")
    );

    fs::write(&eula_path, content).await?;
    Ok(())
}

// Tauri commands
#[tauri::command]
pub async fn get_eula_status(instance_id: String) -> Result<EulaStatus, String> {
    let server_dir = crate::paths::instance_dir(&instance_id);
    check_eula(&server_dir).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn accept_server_eula(instance_id: String) -> Result<(), String> {
    let server_dir = crate::paths::instance_dir(&instance_id);
    accept_eula(&server_dir).await.map_err(|e| e.to_string())
}
