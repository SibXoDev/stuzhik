//! Metadata Parser and Editor
//!
//! Handles parsing and editing of mod/pack metadata files:
//! - pack.mcmeta (datapacks, resource packs)
//! - mods.toml (Forge/NeoForge)
//! - fabric.mod.json (Fabric)

use crate::paths::instance_dir;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::HashMap;

/// Pack metadata (pack.mcmeta)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackMcmeta {
    pub pack: PackInfo,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filter: Option<PackFilter>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overlays: Option<PackOverlays>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackInfo {
    pub pack_format: u32,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supported_formats: Option<SupportedFormats>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SupportedFormats {
    Range {
        min_inclusive: u32,
        max_inclusive: u32,
    },
    List(Vec<u32>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackFilter {
    pub block: Vec<FilterBlock>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilterBlock {
    pub namespace: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackOverlays {
    pub entries: Vec<OverlayEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OverlayEntry {
    pub formats: SupportedFormats,
    pub directory: String,
}

/// Forge/NeoForge mods.toml
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModsToml {
    #[serde(rename = "modLoader")]
    pub mod_loader: String,
    #[serde(rename = "loaderVersion")]
    pub loader_version: String,
    pub license: String,
    #[serde(rename = "issueTrackerURL", skip_serializing_if = "Option::is_none")]
    pub issue_tracker_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub properties: Option<HashMap<String, String>>,
    pub mods: Vec<ModEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dependencies: Option<HashMap<String, Vec<ModDependency>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModEntry {
    #[serde(rename = "modId")]
    pub mod_id: String,
    pub version: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(rename = "logoFile", skip_serializing_if = "Option::is_none")]
    pub logo_file: Option<String>,
    #[serde(rename = "updateJSONURL", skip_serializing_if = "Option::is_none")]
    pub update_json_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credits: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authors: Option<String>,
    #[serde(rename = "displayURL", skip_serializing_if = "Option::is_none")]
    pub display_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModDependency {
    #[serde(rename = "modId")]
    pub mod_id: String,
    pub mandatory: bool,
    #[serde(rename = "versionRange")]
    pub version_range: String,
    pub ordering: String,
    pub side: String,
}

/// Fabric mod.json
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FabricModJson {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    pub id: String,
    pub version: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub authors: Option<Vec<AuthorEntry>>,
    pub contact: Option<ContactInfo>,
    pub license: Option<LicenseEntry>,
    pub icon: Option<String>,
    pub environment: Option<String>,
    pub entrypoints: Option<HashMap<String, Vec<EntrypointEntry>>>,
    pub mixins: Option<Vec<MixinEntry>>,
    pub depends: Option<HashMap<String, String>>,
    pub recommends: Option<HashMap<String, String>>,
    pub suggests: Option<HashMap<String, String>>,
    pub breaks: Option<HashMap<String, String>>,
    pub conflicts: Option<HashMap<String, String>>,
    #[serde(rename = "accessWidener")]
    pub access_widener: Option<String>,
    pub custom: Option<HashMap<String, JsonValue>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AuthorEntry {
    Simple(String),
    Complex {
        name: String,
        contact: Option<HashMap<String, String>>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContactInfo {
    pub homepage: Option<String>,
    pub issues: Option<String>,
    pub sources: Option<String>,
    pub email: Option<String>,
    pub irc: Option<String>,
    pub discord: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum LicenseEntry {
    Single(String),
    Multiple(Vec<String>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum EntrypointEntry {
    Simple(String),
    Complex { adapter: String, value: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MixinEntry {
    Simple(String),
    Complex {
        config: String,
        environment: Option<String>,
    },
}

/// Unified metadata type for frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum MetadataFile {
    #[serde(rename = "pack_mcmeta")]
    PackMcmeta { path: String, data: PackMcmeta },
    #[serde(rename = "mods_toml")]
    ModsToml { path: String, data: ModsToml },
    #[serde(rename = "fabric_mod_json")]
    FabricModJson { path: String, data: FabricModJson },
}

/// Pack format versions mapping
pub fn get_pack_format_info(format: u32) -> (&'static str, &'static str) {
    match format {
        1 => ("1.6.1 - 1.8.9", "Resource Pack"),
        2 => ("1.9 - 1.10.2", "Resource Pack"),
        3 => ("1.11 - 1.12.2", "Resource Pack"),
        4 => ("1.13 - 1.14.4", "Resource/Data Pack"),
        5 => ("1.15 - 1.16.1", "Resource/Data Pack"),
        6 => ("1.16.2 - 1.16.5", "Resource/Data Pack"),
        7 => ("1.17 - 1.17.1", "Resource/Data Pack"),
        8 => ("1.18 - 1.18.2", "Resource/Data Pack"),
        9 => ("1.19 - 1.19.2", "Resource/Data Pack"),
        10 => ("1.19.3", "Resource/Data Pack"),
        11 => ("1.19.4", "Resource/Data Pack"),
        12 => ("1.19.4", "Resource/Data Pack"),
        13 => ("1.20", "Resource/Data Pack"),
        14 => ("1.20", "Resource/Data Pack"),
        15 => ("1.20.1 - 1.20.2", "Resource/Data Pack"),
        18 => ("1.20.3 - 1.20.4", "Resource/Data Pack"),
        22 => ("1.20.5", "Resource/Data Pack"),
        26 => ("1.20.5 - 1.20.6", "Resource/Data Pack"),
        32 => ("1.21", "Resource/Data Pack"),
        34 => ("1.21.1", "Resource/Data Pack"),
        42 => ("1.21.2 - 1.21.3", "Resource/Data Pack"),
        46 => ("1.21.4", "Resource/Data Pack"),
        _ => ("Unknown", "Unknown"),
    }
}

/// Detect and parse metadata files in an instance
#[tauri::command]
pub async fn detect_metadata_files(instance_id: String) -> Result<Vec<MetadataFile>, String> {
    let instance_path = instance_dir(&instance_id);
    let mut metadata_files = Vec::new();

    // Check for datapacks/resourcepacks with pack.mcmeta
    let pack_locations = [
        instance_path.join("resourcepacks"),
        instance_path.join("datapacks"),
        instance_path.join("kubejs/assets"),
        instance_path.join("kubejs/data"),
    ];

    for location in &pack_locations {
        if let Ok(mut entries) = tokio::fs::read_dir(location).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                let pack_mcmeta = entry.path().join("pack.mcmeta");
                if tokio::fs::try_exists(&pack_mcmeta).await.unwrap_or(false) {
                    if let Ok(content) = tokio::fs::read_to_string(&pack_mcmeta).await {
                        if let Ok(data) = serde_json::from_str::<PackMcmeta>(&content) {
                            let relative_path = pack_mcmeta
                                .strip_prefix(&instance_path)
                                .map(|p| p.to_string_lossy().to_string())
                                .unwrap_or_default();
                            metadata_files.push(MetadataFile::PackMcmeta {
                                path: relative_path,
                                data,
                            });
                        }
                    }
                }
            }
        }
    }

    // Check kubejs pack.mcmeta directly
    let kubejs_pack = instance_path.join("kubejs/pack.mcmeta");
    if tokio::fs::try_exists(&kubejs_pack).await.unwrap_or(false) {
        if let Ok(content) = tokio::fs::read_to_string(&kubejs_pack).await {
            if let Ok(data) = serde_json::from_str::<PackMcmeta>(&content) {
                metadata_files.push(MetadataFile::PackMcmeta {
                    path: "kubejs/pack.mcmeta".to_string(),
                    data,
                });
            }
        }
    }

    Ok(metadata_files)
}

/// Parse a specific metadata file
#[tauri::command]
pub async fn parse_metadata_file(
    instance_id: String,
    relative_path: String,
) -> Result<MetadataFile, String> {
    let file_path = instance_dir(&instance_id).join(&relative_path);
    let content = tokio::fs::read_to_string(&file_path)
        .await
        .map_err(|e| format!("Failed to read file: {}", e))?;

    let filename = file_path.file_name().and_then(|n| n.to_str()).unwrap_or("");

    match filename {
        "pack.mcmeta" => {
            let data: PackMcmeta = serde_json::from_str(&content)
                .map_err(|e| format!("Failed to parse pack.mcmeta: {}", e))?;
            Ok(MetadataFile::PackMcmeta {
                path: relative_path,
                data,
            })
        }
        "mods.toml" => {
            let data: ModsToml = toml::from_str(&content)
                .map_err(|e| format!("Failed to parse mods.toml: {}", e))?;
            Ok(MetadataFile::ModsToml {
                path: relative_path,
                data,
            })
        }
        "fabric.mod.json" => {
            let data: FabricModJson = serde_json::from_str(&content)
                .map_err(|e| format!("Failed to parse fabric.mod.json: {}", e))?;
            Ok(MetadataFile::FabricModJson {
                path: relative_path,
                data,
            })
        }
        _ => Err(format!("Unknown metadata file type: {}", filename)),
    }
}

/// Save metadata file
#[tauri::command]
pub async fn save_metadata_file(instance_id: String, metadata: MetadataFile) -> Result<(), String> {
    let instance_path = instance_dir(&instance_id);

    match metadata {
        MetadataFile::PackMcmeta { path, data } => {
            let file_path = instance_path.join(&path);
            let content = serde_json::to_string_pretty(&data)
                .map_err(|e| format!("Failed to serialize: {}", e))?;
            tokio::fs::write(&file_path, content)
                .await
                .map_err(|e| format!("Failed to write file: {}", e))?;
        }
        MetadataFile::ModsToml { path, data } => {
            let file_path = instance_path.join(&path);
            let content =
                toml::to_string_pretty(&data).map_err(|e| format!("Failed to serialize: {}", e))?;
            tokio::fs::write(&file_path, content)
                .await
                .map_err(|e| format!("Failed to write file: {}", e))?;
        }
        MetadataFile::FabricModJson { path, data } => {
            let file_path = instance_path.join(&path);
            let content = serde_json::to_string_pretty(&data)
                .map_err(|e| format!("Failed to serialize: {}", e))?;
            tokio::fs::write(&file_path, content)
                .await
                .map_err(|e| format!("Failed to write file: {}", e))?;
        }
    }

    Ok(())
}

/// Create a new pack.mcmeta
#[tauri::command]
pub async fn create_pack_mcmeta(
    instance_id: String,
    pack_path: String,
    pack_format: u32,
    description: String,
) -> Result<String, String> {
    let file_path = instance_dir(&instance_id)
        .join(&pack_path)
        .join("pack.mcmeta");

    // Create parent directories
    if let Some(parent) = file_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create directories: {}", e))?;
    }

    let pack = PackMcmeta {
        pack: PackInfo {
            pack_format,
            description,
            supported_formats: None,
        },
        filter: None,
        overlays: None,
    };

    let content =
        serde_json::to_string_pretty(&pack).map_err(|e| format!("Failed to serialize: {}", e))?;

    tokio::fs::write(&file_path, content)
        .await
        .map_err(|e| format!("Failed to write file: {}", e))?;

    let relative = file_path
        .strip_prefix(instance_dir(&instance_id))
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    Ok(relative)
}
