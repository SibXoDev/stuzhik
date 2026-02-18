//! Hytale mod management via CurseForge
//!
//! Hytale uses CurseForge as its official mod platform.
//! Mods are divided into three categories:
//! - Packs: Content packs (blocks, mobs, items)
//! - Plugins: Java plugins using the game's API
//! - Early Plugins: Bootstrap plugins that run before server starts

use super::HytaleModType;
use crate::api::curseforge::CurseForgeClient;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Hytale CurseForge game ID
pub const HYTALE_CURSEFORGE_GAME_ID: u32 = 83374;

/// Hytale mod information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HytaleMod {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub summary: String,
    pub mod_type: HytaleModType,
    pub downloads: u64,
    pub icon_url: Option<String>,
    pub curseforge_id: u64,
    pub author: String,
    pub version: Option<String>,
    pub file_name: Option<String>,
}

/// Search for Hytale mods on CurseForge
pub async fn search_hytale_mods(
    query: &str,
    mod_type: Option<HytaleModType>,
    page: u32,
    page_size: u32,
) -> Result<Vec<HytaleMod>, String> {
    let client = CurseForgeClient::new()
        .map_err(|e| format!("Failed to create CurseForge client: {}", e))?;

    // Map mod type to CurseForge class ID
    let class_id = mod_type.map(|t| match t {
        HytaleModType::Pack => 6945, // Approximate - need to verify actual class IDs
        HytaleModType::Plugin => 6946,
        HytaleModType::EarlyPlugin => 6947,
    });

    let results = client
        .search_mods_hytale(query, class_id, page_size, page * page_size)
        .await
        .map_err(|e| format!("CurseForge search failed: {}", e))?;

    Ok(results
        .into_iter()
        .map(|hit| HytaleMod {
            id: hit.id.to_string(),
            name: hit.name,
            slug: hit.slug,
            summary: hit.summary,
            mod_type: mod_type.unwrap_or(HytaleModType::Pack),
            downloads: hit.download_count,
            icon_url: hit.logo.map(|l| l.url),
            curseforge_id: hit.id,
            author: hit
                .authors
                .first()
                .map(|a| a.name.clone())
                .unwrap_or_default(),
            version: None,
            file_name: None,
        })
        .collect())
}

/// Get popular Hytale mods
pub async fn get_popular_hytale_mods(
    mod_type: Option<HytaleModType>,
    limit: u32,
) -> Result<Vec<HytaleMod>, String> {
    search_hytale_mods("", mod_type, 0, limit).await
}

/// Install a Hytale mod from CurseForge
pub async fn install_hytale_mod(
    curseforge_id: u64,
    instance_path: &str,
    mod_type: HytaleModType,
) -> Result<HytaleMod, String> {
    let client = CurseForgeClient::new()
        .map_err(|e| format!("Failed to create CurseForge client: {}", e))?;

    // Get mod info
    let mod_info = client
        .get_mod(curseforge_id)
        .await
        .map_err(|e| format!("Failed to get mod info: {}", e))?;

    // Get latest file
    let file = mod_info
        .latest_files
        .first()
        .ok_or_else(|| "No files available for this mod".to_string())?;

    // Determine target directory
    let target_dir = PathBuf::from(instance_path).join(mod_type.folder_name());

    // Create directory if it doesn't exist
    tokio::fs::create_dir_all(&target_dir)
        .await
        .map_err(|e| format!("Failed to create mod directory: {}", e))?;

    // Download the file
    let download_url = file
        .download_url
        .as_ref()
        .ok_or_else(|| "Download URL not available".to_string())?;

    let file_path = target_dir.join(&file.file_name);

    let response = crate::utils::SHARED_HTTP_CLIENT.get(download_url)
        .send().await
        .map_err(|e| format!("Failed to download mod: {}", e))?;

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read mod data: {}", e))?;

    tokio::fs::write(&file_path, &bytes)
        .await
        .map_err(|e| format!("Failed to save mod: {}", e))?;

    log::info!(
        "Installed Hytale mod: {} to {:?}",
        mod_info.name,
        file_path
    );

    Ok(HytaleMod {
        id: mod_info.id.to_string(),
        name: mod_info.name,
        slug: mod_info.slug,
        summary: mod_info.summary,
        mod_type,
        downloads: mod_info.download_count,
        icon_url: mod_info.logo.map(|l| l.url),
        curseforge_id: mod_info.id,
        author: mod_info
            .authors
            .first()
            .map(|a| a.name.clone())
            .unwrap_or_default(),
        version: Some(file.display_name.clone()),
        file_name: Some(file.file_name.clone()),
    })
}

/// List installed Hytale mods for an instance
pub async fn list_installed_hytale_mods(
    instance_path: &str,
) -> Result<Vec<HytaleMod>, String> {
    let mut mods = Vec::new();
    let base_path = PathBuf::from(instance_path);

    for mod_type in [
        HytaleModType::Pack,
        HytaleModType::Plugin,
        HytaleModType::EarlyPlugin,
    ] {
        let type_path = base_path.join(mod_type.folder_name());
        if !tokio::fs::try_exists(&type_path).await.unwrap_or(false) {
            continue;
        }

        let mut entries = tokio::fs::read_dir(&type_path)
            .await
            .map_err(|e| format!("Failed to read mod directory: {}", e))?;

        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|e| format!("Failed to read entry: {}", e))?
        {
            let path = entry.path();
            if path.is_file() {
                let file_name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();

                // Extract mod name from file name
                let name = file_name
                    .trim_end_matches(".zip")
                    .trim_end_matches(".jar")
                    .to_string();

                mods.push(HytaleMod {
                    id: file_name.clone(),
                    name,
                    slug: file_name.clone(),
                    summary: String::new(),
                    mod_type,
                    downloads: 0,
                    icon_url: None,
                    curseforge_id: 0,
                    author: String::new(),
                    version: None,
                    file_name: Some(file_name),
                });
            }
        }
    }

    Ok(mods)
}

/// Remove a Hytale mod from an instance
pub async fn remove_hytale_mod(
    instance_path: &str,
    file_name: &str,
    mod_type: HytaleModType,
) -> Result<(), String> {
    let file_path = PathBuf::from(instance_path)
        .join(mod_type.folder_name())
        .join(file_name);

    if tokio::fs::try_exists(&file_path).await.unwrap_or(false) {
        tokio::fs::remove_file(&file_path)
            .await
            .map_err(|e| format!("Failed to remove mod: {}", e))?;

        log::info!("Removed Hytale mod: {:?}", file_path);
    }

    Ok(())
}

// Tauri commands

/// Search Hytale mods
#[tauri::command]
pub async fn search_hytale_mods_cmd(
    query: String,
    mod_type: Option<HytaleModType>,
    page: u32,
    page_size: u32,
) -> Result<Vec<HytaleMod>, String> {
    search_hytale_mods(&query, mod_type, page, page_size).await
}

/// Get popular Hytale mods
#[tauri::command]
pub async fn get_popular_hytale_mods_cmd(
    mod_type: Option<HytaleModType>,
    limit: u32,
) -> Result<Vec<HytaleMod>, String> {
    get_popular_hytale_mods(mod_type, limit).await
}

/// Install Hytale mod
#[tauri::command]
pub async fn install_hytale_mod_cmd(
    curseforge_id: u64,
    instance_path: String,
    mod_type: HytaleModType,
) -> Result<HytaleMod, String> {
    install_hytale_mod(curseforge_id, &instance_path, mod_type).await
}

/// List installed Hytale mods
#[tauri::command]
pub async fn list_hytale_mods(instance_path: String) -> Result<Vec<HytaleMod>, String> {
    list_installed_hytale_mods(&instance_path).await
}

/// Remove Hytale mod
#[tauri::command]
pub async fn remove_hytale_mod_cmd(
    instance_path: String,
    file_name: String,
    mod_type: HytaleModType,
) -> Result<(), String> {
    remove_hytale_mod(&instance_path, &file_name, mod_type).await
}
