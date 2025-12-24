//! Mod Collections - Custom mod grouping and quick installation
//!
//! Allows users to create, manage, and share collections of mods.
//! Supports built-in collections (Optimization, Tech, Magic, etc.)
//! and user-created custom collections.

use crate::db::get_db_conn;
use crate::downloader::DownloadManager;
use crate::error::{LauncherError, Result};
use crate::mods::ModManager;
use chrono::Utc;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Mod collection
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModCollection {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub color: String,
    pub icon: String,
    pub is_builtin: bool,
    pub mod_count: i32,
    pub created_at: String,
    pub updated_at: String,
}

/// Mod in a collection
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionMod {
    pub collection_id: String,
    pub mod_slug: String,
    pub mod_name: String,
    pub mod_source: String,
    pub loader_type: Option<String>,
    pub added_at: String,
}

/// Collection with its mods
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionWithMods {
    #[serde(flatten)]
    pub collection: ModCollection,
    pub mods: Vec<CollectionMod>,
}

/// Request to create a new collection
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateCollectionRequest {
    pub name: String,
    pub description: Option<String>,
    pub color: Option<String>,
    pub icon: Option<String>,
}

/// Request to update a collection
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateCollectionRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    pub color: Option<String>,
    pub icon: Option<String>,
}

/// Request to add a mod to collection
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AddModRequest {
    pub collection_id: String,
    pub mod_slug: String,
    pub mod_name: String,
    pub mod_source: String,
    pub loader_type: Option<String>,
}

/// Result of installing a collection
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionInstallResult {
    pub installed: Vec<String>,
    pub failed: Vec<CollectionInstallError>,
    pub skipped: Vec<String>,
}

/// Error during collection installation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionInstallError {
    pub mod_slug: String,
    pub error: String,
}

/// Exportable collection format
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportedCollection {
    pub name: String,
    pub description: Option<String>,
    pub color: String,
    pub icon: String,
    pub mods: Vec<ExportedMod>,
    pub exported_at: String,
    pub version: String,
}

/// Exported mod info
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportedMod {
    pub slug: String,
    pub name: String,
    pub source: String,
    pub loader_type: Option<String>,
}

/// Collection manager
pub struct CollectionManager;

impl CollectionManager {
    /// List all collections with mod counts
    pub fn list_collections() -> Result<Vec<ModCollection>> {
        let conn = get_db_conn()?;

        let mut stmt = conn.prepare(
            r#"
            SELECT
                c.id, c.name, c.description, c.color, c.icon, c.is_builtin,
                c.created_at, c.updated_at,
                COUNT(cm.mod_slug) as mod_count
            FROM mod_collections c
            LEFT JOIN collection_mods cm ON c.id = cm.collection_id
            GROUP BY c.id
            ORDER BY c.is_builtin DESC, c.name ASC
            "#,
        )?;

        let collections = stmt
            .query_map([], |row| {
                Ok(ModCollection {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    description: row.get(2)?,
                    color: row.get(3)?,
                    icon: row.get(4)?,
                    is_builtin: row.get::<_, i32>(5)? != 0,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                    mod_count: row.get(8)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        Ok(collections)
    }

    /// Get a single collection by ID
    pub fn get_collection(id: &str) -> Result<ModCollection> {
        let conn = get_db_conn()?;

        let collection = conn.query_row(
            r#"
            SELECT
                c.id, c.name, c.description, c.color, c.icon, c.is_builtin,
                c.created_at, c.updated_at,
                COUNT(cm.mod_slug) as mod_count
            FROM mod_collections c
            LEFT JOIN collection_mods cm ON c.id = cm.collection_id
            WHERE c.id = ?1
            GROUP BY c.id
            "#,
            params![id],
            |row| {
                Ok(ModCollection {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    description: row.get(2)?,
                    color: row.get(3)?,
                    icon: row.get(4)?,
                    is_builtin: row.get::<_, i32>(5)? != 0,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                    mod_count: row.get(8)?,
                })
            },
        )?;

        Ok(collection)
    }

    /// Get collection with all its mods
    pub fn get_collection_with_mods(id: &str) -> Result<CollectionWithMods> {
        let collection = Self::get_collection(id)?;
        let mods = Self::get_collection_mods(id)?;

        Ok(CollectionWithMods { collection, mods })
    }

    /// Get mods in a collection
    pub fn get_collection_mods(collection_id: &str) -> Result<Vec<CollectionMod>> {
        let conn = get_db_conn()?;

        let mut stmt = conn.prepare(
            r#"
            SELECT collection_id, mod_slug, mod_name, mod_source, loader_type, added_at
            FROM collection_mods
            WHERE collection_id = ?1
            ORDER BY added_at ASC
            "#,
        )?;

        let mods = stmt
            .query_map(params![collection_id], |row| {
                Ok(CollectionMod {
                    collection_id: row.get(0)?,
                    mod_slug: row.get(1)?,
                    mod_name: row.get(2)?,
                    mod_source: row.get(3)?,
                    loader_type: row.get(4)?,
                    added_at: row.get(5)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        Ok(mods)
    }

    /// Create a new collection
    pub fn create_collection(request: CreateCollectionRequest) -> Result<ModCollection> {
        let conn = get_db_conn()?;
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        let color = request.color.unwrap_or_else(|| "#3b82f6".to_string());
        let icon = request.icon.unwrap_or_else(|| "default".to_string());

        conn.execute(
            r#"
            INSERT INTO mod_collections (id, name, description, color, icon, is_builtin, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?6)
            "#,
            params![id, request.name, request.description, color, icon, now],
        )?;

        Self::get_collection(&id)
    }

    /// Update an existing collection
    pub fn update_collection(id: &str, request: UpdateCollectionRequest) -> Result<ModCollection> {
        let conn = get_db_conn()?;

        // Check if collection exists and is not builtin
        let collection = Self::get_collection(id)?;
        if collection.is_builtin {
            return Err(LauncherError::InvalidConfig(
                "Cannot modify built-in collections".to_string(),
            ));
        }

        let now = Utc::now().to_rfc3339();

        if let Some(name) = request.name {
            conn.execute(
                "UPDATE mod_collections SET name = ?1, updated_at = ?2 WHERE id = ?3",
                params![name, now, id],
            )?;
        }

        if let Some(description) = request.description {
            conn.execute(
                "UPDATE mod_collections SET description = ?1, updated_at = ?2 WHERE id = ?3",
                params![description, now, id],
            )?;
        }

        if let Some(color) = request.color {
            conn.execute(
                "UPDATE mod_collections SET color = ?1, updated_at = ?2 WHERE id = ?3",
                params![color, now, id],
            )?;
        }

        if let Some(icon) = request.icon {
            conn.execute(
                "UPDATE mod_collections SET icon = ?1, updated_at = ?2 WHERE id = ?3",
                params![icon, now, id],
            )?;
        }

        Self::get_collection(id)
    }

    /// Delete a collection (only user-created collections)
    pub fn delete_collection(id: &str) -> Result<()> {
        let conn = get_db_conn()?;

        // Check if collection exists and is not builtin
        let collection = Self::get_collection(id)?;
        if collection.is_builtin {
            return Err(LauncherError::InvalidConfig(
                "Cannot delete built-in collections".to_string(),
            ));
        }

        // Delete mods first (foreign key constraint)
        conn.execute(
            "DELETE FROM collection_mods WHERE collection_id = ?1",
            params![id],
        )?;

        // Delete collection
        conn.execute("DELETE FROM mod_collections WHERE id = ?1", params![id])?;

        Ok(())
    }

    /// Add a mod to a collection
    pub fn add_mod_to_collection(request: AddModRequest) -> Result<CollectionMod> {
        let conn = get_db_conn()?;
        let now = Utc::now().to_rfc3339();

        // Verify collection exists
        let _ = Self::get_collection(&request.collection_id)?;

        conn.execute(
            r#"
            INSERT OR REPLACE INTO collection_mods
            (collection_id, mod_slug, mod_name, mod_source, loader_type, added_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            "#,
            params![
                request.collection_id,
                request.mod_slug,
                request.mod_name,
                request.mod_source,
                request.loader_type,
                now
            ],
        )?;

        // Update collection updated_at
        conn.execute(
            "UPDATE mod_collections SET updated_at = ?1 WHERE id = ?2",
            params![now, request.collection_id],
        )?;

        Ok(CollectionMod {
            collection_id: request.collection_id,
            mod_slug: request.mod_slug,
            mod_name: request.mod_name,
            mod_source: request.mod_source,
            loader_type: request.loader_type,
            added_at: now,
        })
    }

    /// Remove a mod from a collection
    pub fn remove_mod_from_collection(collection_id: &str, mod_slug: &str) -> Result<()> {
        let conn = get_db_conn()?;

        // Check if collection is builtin - allow removing from builtin for user customization
        let collection = Self::get_collection(collection_id)?;
        if collection.is_builtin {
            return Err(LauncherError::InvalidConfig(
                "Cannot modify built-in collections. Create a copy first.".to_string(),
            ));
        }

        conn.execute(
            "DELETE FROM collection_mods WHERE collection_id = ?1 AND mod_slug = ?2",
            params![collection_id, mod_slug],
        )?;

        // Update collection updated_at
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE mod_collections SET updated_at = ?1 WHERE id = ?2",
            params![now, collection_id],
        )?;

        Ok(())
    }

    /// Install all mods from a collection to an instance
    pub async fn install_collection(
        collection_id: &str,
        instance_id: &str,
        minecraft_version: &str,
        loader_type: &str,
        download_manager: &DownloadManager,
    ) -> Result<CollectionInstallResult> {
        let mods = Self::get_collection_mods(collection_id)?;

        let mut result = CollectionInstallResult {
            installed: Vec::new(),
            failed: Vec::new(),
            skipped: Vec::new(),
        };

        // Get already installed mods to skip
        let installed_mods = Self::get_installed_mod_slugs(instance_id)?;

        for mod_info in mods {
            // Skip if already installed
            if installed_mods.contains(&mod_info.mod_slug) {
                result.skipped.push(mod_info.mod_slug.clone());
                continue;
            }

            // Try to install
            match Self::install_single_mod(
                instance_id,
                &mod_info.mod_slug,
                &mod_info.mod_source,
                minecraft_version,
                loader_type,
                download_manager,
            )
            .await
            {
                Ok(_) => {
                    result.installed.push(mod_info.mod_slug);
                }
                Err(e) => {
                    result.failed.push(CollectionInstallError {
                        mod_slug: mod_info.mod_slug,
                        error: e.to_string(),
                    });
                }
            }
        }

        Ok(result)
    }

    /// Get slugs of already installed mods for an instance
    fn get_installed_mod_slugs(instance_id: &str) -> Result<Vec<String>> {
        let conn = get_db_conn()?;

        let mut stmt = conn.prepare("SELECT slug FROM mods WHERE instance_id = ?1")?;

        let slugs = stmt
            .query_map(params![instance_id], |row| row.get(0))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(slugs)
    }

    /// Install a single mod from source
    async fn install_single_mod(
        instance_id: &str,
        slug: &str,
        source: &str,
        minecraft_version: &str,
        loader_type: &str,
        download_manager: &DownloadManager,
    ) -> Result<()> {
        match source {
            "modrinth" => ModManager::install_from_modrinth(
                instance_id,
                slug,
                minecraft_version,
                loader_type,
                None,
                download_manager,
            )
            .await
            .map(|_| ()),
            "curseforge" => {
                // For CurseForge, slug should be the mod_id as string
                let mod_id: u64 = slug.parse().map_err(|_| {
                    LauncherError::InvalidConfig(format!("Invalid CurseForge mod ID: {}", slug))
                })?;
                ModManager::install_from_curseforge(
                    instance_id,
                    mod_id,
                    minecraft_version,
                    loader_type,
                    None,
                    download_manager,
                )
                .await
                .map(|_| ())
            }
            _ => Err(LauncherError::InvalidConfig(format!(
                "Unknown mod source: {}",
                source
            ))),
        }
    }

    /// Export collection to JSON
    pub fn export_collection(id: &str) -> Result<ExportedCollection> {
        let collection = Self::get_collection(id)?;
        let mods = Self::get_collection_mods(id)?;

        Ok(ExportedCollection {
            name: collection.name,
            description: collection.description,
            color: collection.color,
            icon: collection.icon,
            mods: mods
                .into_iter()
                .map(|m| ExportedMod {
                    slug: m.mod_slug,
                    name: m.mod_name,
                    source: m.mod_source,
                    loader_type: m.loader_type,
                })
                .collect(),
            exported_at: Utc::now().to_rfc3339(),
            version: "1.0".to_string(),
        })
    }

    /// Import collection from JSON
    pub fn import_collection(exported: ExportedCollection) -> Result<ModCollection> {
        // Create new collection
        let collection = Self::create_collection(CreateCollectionRequest {
            name: exported.name,
            description: exported.description,
            color: Some(exported.color),
            icon: Some(exported.icon),
        })?;

        // Add all mods
        for mod_info in exported.mods {
            let _ = Self::add_mod_to_collection(AddModRequest {
                collection_id: collection.id.clone(),
                mod_slug: mod_info.slug,
                mod_name: mod_info.name,
                mod_source: mod_info.source,
                loader_type: mod_info.loader_type,
            });
        }

        Self::get_collection(&collection.id)
    }

    /// Duplicate a collection (including builtin ones)
    pub fn duplicate_collection(id: &str, new_name: Option<String>) -> Result<ModCollection> {
        let source = Self::get_collection(id)?;
        let mods = Self::get_collection_mods(id)?;

        let name = new_name.unwrap_or_else(|| format!("{} (Copy)", source.name));

        let new_collection = Self::create_collection(CreateCollectionRequest {
            name,
            description: source.description,
            color: Some(source.color),
            icon: Some(source.icon),
        })?;

        // Copy all mods
        for mod_info in mods {
            let _ = Self::add_mod_to_collection(AddModRequest {
                collection_id: new_collection.id.clone(),
                mod_slug: mod_info.mod_slug,
                mod_name: mod_info.mod_name,
                mod_source: mod_info.mod_source,
                loader_type: mod_info.loader_type,
            });
        }

        Self::get_collection(&new_collection.id)
    }

    /// Check if a mod is in any collection
    pub fn get_collections_containing_mod(mod_slug: &str) -> Result<Vec<ModCollection>> {
        let conn = get_db_conn()?;

        let mut stmt = conn.prepare(
            r#"
            SELECT
                c.id, c.name, c.description, c.color, c.icon, c.is_builtin,
                c.created_at, c.updated_at,
                (SELECT COUNT(*) FROM collection_mods WHERE collection_id = c.id) as mod_count
            FROM mod_collections c
            INNER JOIN collection_mods cm ON c.id = cm.collection_id
            WHERE cm.mod_slug = ?1
            ORDER BY c.name
            "#,
        )?;

        let collections = stmt
            .query_map(params![mod_slug], |row| {
                Ok(ModCollection {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    description: row.get(2)?,
                    color: row.get(3)?,
                    icon: row.get(4)?,
                    is_builtin: row.get::<_, i32>(5)? != 0,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                    mod_count: row.get(8)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        Ok(collections)
    }
}

// ============ Tauri Commands ============

#[tauri::command]
pub fn list_collections() -> Result<Vec<ModCollection>> {
    CollectionManager::list_collections()
}

#[tauri::command]
pub fn get_collection(id: String) -> Result<ModCollection> {
    CollectionManager::get_collection(&id)
}

#[tauri::command]
pub fn get_collection_with_mods(id: String) -> Result<CollectionWithMods> {
    CollectionManager::get_collection_with_mods(&id)
}

#[tauri::command]
pub fn get_collection_mods(collection_id: String) -> Result<Vec<CollectionMod>> {
    CollectionManager::get_collection_mods(&collection_id)
}

#[tauri::command]
pub fn create_collection(request: CreateCollectionRequest) -> Result<ModCollection> {
    CollectionManager::create_collection(request)
}

#[tauri::command]
pub fn update_collection(id: String, request: UpdateCollectionRequest) -> Result<ModCollection> {
    CollectionManager::update_collection(&id, request)
}

#[tauri::command]
pub fn delete_collection(id: String) -> Result<()> {
    CollectionManager::delete_collection(&id)
}

#[tauri::command]
pub fn add_mod_to_collection(request: AddModRequest) -> Result<CollectionMod> {
    CollectionManager::add_mod_to_collection(request)
}

#[tauri::command]
pub fn remove_mod_from_collection(collection_id: String, mod_slug: String) -> Result<()> {
    CollectionManager::remove_mod_from_collection(&collection_id, &mod_slug)
}

#[tauri::command]
pub async fn install_collection(
    collection_id: String,
    instance_id: String,
    minecraft_version: String,
    loader_type: String,
    app_handle: tauri::AppHandle,
) -> Result<CollectionInstallResult> {
    let download_manager = DownloadManager::new(app_handle)?;
    CollectionManager::install_collection(
        &collection_id,
        &instance_id,
        &minecraft_version,
        &loader_type,
        &download_manager,
    )
    .await
}

#[tauri::command]
pub fn export_collection(id: String) -> Result<ExportedCollection> {
    CollectionManager::export_collection(&id)
}

#[tauri::command]
pub fn import_collection(exported: ExportedCollection) -> Result<ModCollection> {
    CollectionManager::import_collection(exported)
}

#[tauri::command]
pub fn duplicate_collection(id: String, new_name: Option<String>) -> Result<ModCollection> {
    CollectionManager::duplicate_collection(&id, new_name)
}

#[tauri::command]
pub fn get_collections_containing_mod(mod_slug: String) -> Result<Vec<ModCollection>> {
    CollectionManager::get_collections_containing_mod(&mod_slug)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_exported_collection_serialization() {
        let exported = ExportedCollection {
            name: "Test".to_string(),
            description: Some("Test collection".to_string()),
            color: "#ff0000".to_string(),
            icon: "🔥".to_string(),
            mods: vec![ExportedMod {
                slug: "sodium".to_string(),
                name: "Sodium".to_string(),
                source: "modrinth".to_string(),
                loader_type: Some("fabric".to_string()),
            }],
            exported_at: "2025-01-01T00:00:00Z".to_string(),
            version: "1.0".to_string(),
        };

        let json = serde_json::to_string(&exported).unwrap();
        let parsed: ExportedCollection = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.name, "Test");
        assert_eq!(parsed.mods.len(), 1);
        assert_eq!(parsed.mods[0].slug, "sodium");
    }
}
