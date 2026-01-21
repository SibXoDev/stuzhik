//! Preview модпака перед импортом
//!
//! Позволяет просмотреть содержимое модпака (.mrpack, .stzhk, .zip)
//! перед импортом и выбрать какие файлы включить/исключить.

use super::types::{
    ImportFileCategory, ImportModInfo, ImportOverrideInfo, ModpackFormat, ModpackPreview,
};
use super::{CurseForgeManifest, ModrinthModpackIndex};
use crate::error::{LauncherError, Result};
use crate::stzhk::StzhkManifest;
use std::io::Read;
use std::path::Path;

/// Определить формат модпака по содержимому архива
fn detect_format(archive: &mut zip::ZipArchive<std::fs::File>) -> ModpackFormat {
    // Check for Modrinth format
    if archive.by_name("modrinth.index.json").is_ok() {
        return ModpackFormat::Modrinth;
    }

    // Check for STZHK format
    if archive.by_name("manifest.json").is_ok() {
        // Need to distinguish between STZHK and CurseForge
        if let Ok(mut file) = archive.by_name("manifest.json") {
            let mut contents = String::new();
            if file.read_to_string(&mut contents).is_ok() {
                // STZHK has format_version field, CurseForge has manifestType
                if contents.contains("format_version") && contents.contains("modpack") {
                    return ModpackFormat::Stzhk;
                }
                if contents.contains("manifestType") || contents.contains("minecraft") {
                    return ModpackFormat::CurseForge;
                }
            }
        }
    }

    ModpackFormat::Unknown
}

/// Определить категорию файла по пути
fn categorize_file(path: &str) -> ImportFileCategory {
    let path_lower = path.to_lowercase();

    if path_lower.contains("/mods/") || path_lower.ends_with(".jar") {
        ImportFileCategory::Mod
    } else if path_lower.contains("/config/") || path_lower.contains("/defaultconfigs/") {
        ImportFileCategory::Config
    } else if path_lower.contains("/resourcepacks/") {
        ImportFileCategory::ResourcePack
    } else if path_lower.contains("/shaderpacks/") {
        ImportFileCategory::ShaderPack
    } else if path_lower.contains("/kubejs/") || path_lower.contains("/scripts/") {
        ImportFileCategory::Script
    } else if path_lower.contains("/saves/") || path_lower.contains("/world/") {
        ImportFileCategory::World
    } else {
        ImportFileCategory::Other
    }
}

/// Preview .mrpack (Modrinth) модпака
fn preview_mrpack(
    archive: &mut zip::ZipArchive<std::fs::File>,
    archive_size: u64,
) -> Result<ModpackPreview> {
    // Parse index
    let index: ModrinthModpackIndex = {
        let mut file = archive
            .by_name("modrinth.index.json")
            .map_err(|_| LauncherError::InvalidConfig("modrinth.index.json not found".into()))?;
        let mut contents = String::new();
        file.read_to_string(&mut contents)?;
        serde_json::from_str(&contents)?
    };

    // Extract mods from index
    let mut mods: Vec<ImportModInfo> = Vec::new();
    let mut mods_size: u64 = 0;

    for file in &index.files {
        let filename = file
            .path
            .split('/')
            .last()
            .unwrap_or(&file.path)
            .to_string();

        let side =
            file.env
                .as_ref()
                .map(|env| match (env.client.as_deref(), env.server.as_deref()) {
                    (Some("required"), Some("unsupported")) => "client".to_string(),
                    (Some("unsupported"), Some("required")) => "server".to_string(),
                    _ => "both".to_string(),
                });

        mods.push(ImportModInfo {
            path: file.path.clone(),
            filename,
            name: None, // Could lookup on Modrinth API
            size: file.file_size,
            download_url: file.downloads.first().cloned(),
            side,
            enabled: true,
        });
        mods_size += file.file_size;
    }

    // Scan overrides
    let mut overrides: Vec<ImportOverrideInfo> = Vec::new();
    let mut overrides_size: u64 = 0;

    let override_prefixes = ["overrides/", "client-overrides/", "server-overrides/"];

    for i in 0..archive.len() {
        let file = archive.by_index(i)?;
        let name = file.name().to_string();

        for prefix in &override_prefixes {
            if name.starts_with(prefix) && !file.is_dir() {
                let dest_path = name.strip_prefix(prefix).unwrap_or(&name).to_string();
                let size = file.size();

                overrides.push(ImportOverrideInfo {
                    archive_path: name.clone(),
                    dest_path: dest_path.clone(),
                    size,
                    category: categorize_file(&dest_path),
                    enabled: true,
                });
                overrides_size += size;
                break;
            }
        }
    }

    // Extract loader info
    let (loader, loader_version) = if let Some(fabric) = &index.dependencies.fabric_loader {
        (Some("fabric".to_string()), Some(fabric.clone()))
    } else if let Some(quilt) = &index.dependencies.quilt_loader {
        (Some("quilt".to_string()), Some(quilt.clone()))
    } else if let Some(forge) = &index.dependencies.forge {
        (Some("forge".to_string()), Some(forge.clone()))
    } else if let Some(neoforge) = &index.dependencies.neoforge {
        (Some("neoforge".to_string()), Some(neoforge.clone()))
    } else {
        (None, None)
    };

    Ok(ModpackPreview {
        format: ModpackFormat::Modrinth,
        name: index.name,
        version: Some(index.version_id),
        author: None,
        description: index.summary,
        minecraft_version: index.dependencies.minecraft.clone(),
        loader,
        loader_version,
        mods,
        overrides,
        mods_size,
        overrides_size,
        archive_size,
        optional_mods: None, // Modrinth не поддерживает optional mods
    })
}

/// Preview .stzhk модпака
fn preview_stzhk(
    archive: &mut zip::ZipArchive<std::fs::File>,
    archive_size: u64,
) -> Result<ModpackPreview> {
    // Parse manifest
    let manifest: StzhkManifest = {
        let mut file = archive
            .by_name("manifest.json")
            .map_err(|_| LauncherError::InvalidConfig("manifest.json not found".into()))?;
        let mut contents = String::new();
        file.read_to_string(&mut contents)?;
        serde_json::from_str(&contents)?
    };

    // Extract mods from manifest
    let mut mods: Vec<ImportModInfo> = Vec::new();
    let mut mods_size: u64 = 0;

    for mod_entry in &manifest.mods {
        let download_url = match &mod_entry.source {
            crate::stzhk::ModSource::Modrinth { download_url, .. } => Some(download_url.clone()),
            crate::stzhk::ModSource::CurseForge { download_url, .. } => {
                download_url.as_ref().cloned()
            }
            crate::stzhk::ModSource::Embedded { .. } => None,
            crate::stzhk::ModSource::Direct { url, .. } => Some(url.clone()),
        };

        let side = match mod_entry.side {
            crate::stzhk::ModSide::Client => Some("client".to_string()),
            crate::stzhk::ModSide::Server => Some("server".to_string()),
            crate::stzhk::ModSide::Both => Some("both".to_string()),
        };

        mods.push(ImportModInfo {
            path: format!("mods/{}", mod_entry.filename),
            filename: mod_entry.filename.clone(),
            name: Some(mod_entry.name.clone()),
            size: mod_entry.size,
            download_url,
            side,
            enabled: mod_entry.required,
        });
        mods_size += mod_entry.size;
    }

    // Scan overrides
    let mut overrides: Vec<ImportOverrideInfo> = Vec::new();
    let mut overrides_size: u64 = 0;

    for i in 0..archive.len() {
        let file = archive.by_index(i)?;
        let name = file.name().to_string();

        if name.starts_with("overrides/") && !file.is_dir() {
            let dest_path = name.strip_prefix("overrides/").unwrap_or(&name).to_string();
            let size = file.size();

            overrides.push(ImportOverrideInfo {
                archive_path: name.clone(),
                dest_path: dest_path.clone(),
                size,
                category: categorize_file(&dest_path),
                enabled: true,
            });
            overrides_size += size;
        }
    }

    // Извлекаем optional_mods только если они есть
    let optional_mods = if manifest.optional_mods.is_empty() {
        None
    } else {
        Some(manifest.optional_mods)
    };

    Ok(ModpackPreview {
        format: ModpackFormat::Stzhk,
        name: manifest.modpack.name,
        version: Some(manifest.modpack.version),
        author: Some(manifest.modpack.author),
        description: manifest.modpack.description,
        minecraft_version: manifest.requirements.minecraft_version,
        loader: Some(manifest.requirements.loader),
        loader_version: manifest.requirements.loader_version,
        mods,
        overrides,
        mods_size,
        overrides_size,
        archive_size,
        optional_mods,
    })
}

/// Preview CurseForge модпака
fn preview_curseforge(
    archive: &mut zip::ZipArchive<std::fs::File>,
    archive_size: u64,
) -> Result<ModpackPreview> {
    // Parse manifest
    let manifest: CurseForgeManifest = {
        let mut file = archive
            .by_name("manifest.json")
            .map_err(|_| LauncherError::InvalidConfig("manifest.json not found".into()))?;
        let mut contents = String::new();
        file.read_to_string(&mut contents)?;
        serde_json::from_str(&contents)?
    };

    // CurseForge mods need API lookup for names, we just show project/file IDs
    let mods: Vec<ImportModInfo> = manifest
        .files
        .iter()
        .map(|f| ImportModInfo {
            path: format!("mods/curseforge_{}_{}.jar", f.project_id, f.file_id),
            filename: format!("{}_{}.jar", f.project_id, f.file_id),
            name: None, // Would need CurseForge API lookup
            size: 0,    // Unknown without API
            download_url: None,
            side: None,
            enabled: f.required,
        })
        .collect();

    // Scan overrides
    let mut overrides: Vec<ImportOverrideInfo> = Vec::new();
    let mut overrides_size: u64 = 0;

    for i in 0..archive.len() {
        let file = archive.by_index(i)?;
        let name = file.name().to_string();

        if name.starts_with("overrides/") && !file.is_dir() {
            let dest_path = name.strip_prefix("overrides/").unwrap_or(&name).to_string();
            let size = file.size();

            overrides.push(ImportOverrideInfo {
                archive_path: name.clone(),
                dest_path: dest_path.clone(),
                size,
                category: categorize_file(&dest_path),
                enabled: true,
            });
            overrides_size += size;
        }
    }

    // Extract loader info
    let (loader, loader_version) = manifest
        .minecraft
        .mod_loaders
        .iter()
        .find(|l| l.primary)
        .map(|l| {
            let id = &l.id;
            if id.starts_with("forge-") {
                (
                    Some("forge".to_string()),
                    Some(id.strip_prefix("forge-").unwrap_or(id).to_string()),
                )
            } else if id.starts_with("fabric-") {
                (
                    Some("fabric".to_string()),
                    Some(id.strip_prefix("fabric-").unwrap_or(id).to_string()),
                )
            } else if id.starts_with("neoforge-") {
                (
                    Some("neoforge".to_string()),
                    Some(id.strip_prefix("neoforge-").unwrap_or(id).to_string()),
                )
            } else {
                (Some(id.clone()), None)
            }
        })
        .unwrap_or((None, None));

    Ok(ModpackPreview {
        format: ModpackFormat::CurseForge,
        name: manifest.name,
        version: Some(manifest.version),
        author: manifest.author, // Already Option<String>
        description: None,
        minecraft_version: manifest.minecraft.version,
        loader,
        loader_version,
        mods,
        overrides,
        mods_size: 0, // Unknown for CurseForge without API
        overrides_size,
        archive_size,
        optional_mods: None, // CurseForge не поддерживает optional mods
    })
}

/// Получить preview модпака из файла
pub async fn get_modpack_preview(file_path: &Path) -> Result<ModpackPreview> {
    let path = file_path.to_owned();

    // Get archive size
    let archive_size = tokio::fs::metadata(&path).await?.len();

    tokio::task::spawn_blocking(move || {
        let file = std::fs::File::open(&path)?;
        let mut archive = zip::ZipArchive::new(file)?;

        let format = detect_format(&mut archive);

        match format {
            ModpackFormat::Modrinth => preview_mrpack(&mut archive, archive_size),
            ModpackFormat::Stzhk => preview_stzhk(&mut archive, archive_size),
            ModpackFormat::CurseForge => preview_curseforge(&mut archive, archive_size),
            ModpackFormat::Unknown => Err(LauncherError::InvalidConfig(
                "Unknown modpack format. Expected .mrpack, .stzhk, or CurseForge .zip".into(),
            )),
        }
    })
    .await
    .map_err(|e| LauncherError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?
}
// Note: Tauri command wrapper is in lib.rs as preview_modpack_detailed
