//! Resource Manager - Shaders and Resource Packs
//!
//! Unified management for both shader packs and resource packs.
//! Supports installation from Modrinth, local files, and global/per-instance storage.

use crate::api::modrinth::ModrinthClient;
use crate::db::get_db_conn;
use crate::downloader::DownloadManager;
use crate::error::{LauncherError, Result};
use crate::paths::{
    global_resourcepacks_dir, global_shaderpacks_dir, instance_resourcepacks_dir,
    instance_shaderpacks_dir,
};
use chrono::Utc;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Type of resource (shader or resourcepack)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResourceType {
    Shader,
    Resourcepack,
}

impl ResourceType {
    pub fn table_name(&self) -> &'static str {
        match self {
            ResourceType::Shader => "shaderpacks",
            ResourceType::Resourcepack => "resourcepacks",
        }
    }

    pub fn modrinth_project_type(&self) -> &'static str {
        match self {
            ResourceType::Shader => "shader",
            ResourceType::Resourcepack => "resourcepack",
        }
    }

    pub fn folder_name(&self) -> &'static str {
        match self {
            ResourceType::Shader => "shaderpacks",
            ResourceType::Resourcepack => "resourcepacks",
        }
    }

    pub fn file_extension(&self) -> &'static str {
        match self {
            ResourceType::Shader => ".zip",
            ResourceType::Resourcepack => ".zip",
        }
    }
}

impl std::str::FromStr for ResourceType {
    type Err = LauncherError;

    fn from_str(s: &str) -> Result<Self> {
        match s.to_lowercase().as_str() {
            "shader" | "shaders" | "shaderpack" | "shaderpacks" => Ok(ResourceType::Shader),
            "resourcepack" | "resourcepacks" | "resource_pack" | "resource_packs" => {
                Ok(ResourceType::Resourcepack)
            }
            _ => Err(LauncherError::InvalidConfig(format!(
                "Unknown resource type: {}",
                s
            ))),
        }
    }
}

/// Source of the resource
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResourceSource {
    Modrinth,
    Local,
}

impl std::fmt::Display for ResourceSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ResourceSource::Modrinth => write!(f, "modrinth"),
            ResourceSource::Local => write!(f, "local"),
        }
    }
}

/// Installed resource (shader or resource pack)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledResource {
    pub id: i64,
    pub resource_type: ResourceType,
    pub instance_id: Option<String>,
    pub is_global: bool,

    pub slug: String,
    pub name: String,
    pub version: String,
    pub minecraft_version: Option<String>,

    pub source: String,
    pub source_id: Option<String>,
    pub project_url: Option<String>,
    pub download_url: Option<String>,

    pub file_name: String,
    pub file_hash: Option<String>,
    pub file_size: Option<i64>,

    pub enabled: bool,
    pub auto_update: bool,

    pub description: Option<String>,
    pub author: Option<String>,
    pub icon_url: Option<String>,

    pub installed_at: String,
    pub updated_at: String,
}

/// Search result from Modrinth
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceSearchResult {
    pub slug: String,
    pub title: String,
    pub description: String,
    pub author: String,
    pub icon_url: Option<String>,
    pub downloads: u64,
    pub project_type: String,
    pub categories: Vec<String>,
    pub versions: Vec<String>,
}

/// Search response with pagination info
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceSearchResponse {
    pub results: Vec<ResourceSearchResult>,
    pub total: u64,
    pub offset: u32,
    pub limit: u32,
}

/// Gallery image for resource details
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceGalleryImage {
    pub url: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub featured: bool,
}

/// External links for resource
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceLinks {
    pub modrinth: Option<String>,
    pub source: Option<String>,
    pub wiki: Option<String>,
    pub discord: Option<String>,
    pub issues: Option<String>,
}

/// Full resource details from Modrinth
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceDetails {
    pub slug: String,
    pub title: String,
    pub description: String,
    pub body: String,
    pub author: String,
    pub icon_url: Option<String>,
    pub downloads: u64,
    pub followers: u64,
    pub categories: Vec<String>,
    pub versions: Vec<String>,
    pub gallery: Vec<ResourceGalleryImage>,
    pub links: ResourceLinks,
    pub license_id: Option<String>,
    pub license_name: Option<String>,
}

/// Resource manager
pub struct ResourceManager;

impl ResourceManager {
    /// Get directory for resources
    fn get_resource_dir(
        resource_type: ResourceType,
        instance_id: Option<&str>,
        is_global: bool,
    ) -> PathBuf {
        if is_global {
            match resource_type {
                ResourceType::Shader => global_shaderpacks_dir(),
                ResourceType::Resourcepack => global_resourcepacks_dir(),
            }
        } else {
            let instance_id = instance_id.expect("instance_id required for non-global resources");
            match resource_type {
                ResourceType::Shader => instance_shaderpacks_dir(instance_id),
                ResourceType::Resourcepack => instance_resourcepacks_dir(instance_id),
            }
        }
    }

    /// List installed resources
    pub fn list_resources(
        resource_type: ResourceType,
        instance_id: Option<&str>,
        include_global: bool,
    ) -> Result<Vec<InstalledResource>> {
        let conn = get_db_conn()?;
        let table = resource_type.table_name();

        let query = if let Some(id) = instance_id {
            if include_global {
                format!(
                    "SELECT * FROM {} WHERE instance_id = ?1 OR is_global = 1 ORDER BY name",
                    table
                )
            } else {
                format!(
                    "SELECT * FROM {} WHERE instance_id = ?1 ORDER BY name",
                    table
                )
            }
        } else {
            format!("SELECT * FROM {} WHERE is_global = 1 ORDER BY name", table)
        };

        let mut stmt = conn.prepare(&query)?;

        let result: Vec<InstalledResource> = if let Some(id) = instance_id {
            stmt.query_map([id], |row| Self::row_to_resource(row, resource_type))?
                .filter_map(|r| r.ok())
                .collect()
        } else {
            stmt.query_map([], |row| Self::row_to_resource(row, resource_type))?
                .filter_map(|r| r.ok())
                .collect()
        };

        Ok(result)
    }

    /// Map database row to InstalledResource
    fn row_to_resource(
        row: &rusqlite::Row,
        resource_type: ResourceType,
    ) -> rusqlite::Result<InstalledResource> {
        Ok(InstalledResource {
            id: row.get(0)?,
            resource_type,
            instance_id: row.get(1)?,
            is_global: row.get::<_, i32>(2)? == 1,
            slug: row.get(3)?,
            name: row.get(4)?,
            version: row.get(5)?,
            minecraft_version: row.get(6)?,
            source: row.get(7)?,
            source_id: row.get(8)?,
            project_url: row.get(9)?,
            download_url: row.get(10)?,
            file_name: row.get(11)?,
            file_hash: row.get(12)?,
            file_size: row.get(13)?,
            enabled: row.get::<_, i32>(14)? == 1,
            auto_update: row.get::<_, i32>(15)? == 1,
            description: row.get(16)?,
            author: row.get(17)?,
            icon_url: row.get(18)?,
            installed_at: row.get(20)?,
            updated_at: row.get(21)?,
        })
    }

    /// Install resource from Modrinth
    pub async fn install_from_modrinth(
        resource_type: ResourceType,
        instance_id: Option<&str>,
        is_global: bool,
        slug: &str,
        minecraft_version: Option<&str>,
        download_manager: &DownloadManager,
    ) -> Result<InstalledResource> {
        log::info!(
            "Installing {:?} '{}' from Modrinth (global: {})",
            resource_type,
            slug,
            is_global
        );

        // Check if already installed
        if Self::is_installed(resource_type, instance_id, is_global, slug)? {
            return Err(LauncherError::InvalidConfig(format!(
                "{:?} '{}' is already installed",
                resource_type, slug
            )));
        }

        // Get project info
        let project = ModrinthClient::get_project(slug).await?;

        // Verify project type
        if project.project_type != resource_type.modrinth_project_type() {
            return Err(LauncherError::InvalidConfig(format!(
                "Project '{}' is a {}, not a {:?}",
                slug, project.project_type, resource_type
            )));
        }

        // Get versions
        let versions = ModrinthClient::get_project_versions(slug, minecraft_version, None).await?;

        if versions.is_empty() {
            return Err(LauncherError::NoCompatibleModVersion {
                mod_name: slug.to_string(),
                mc_version: minecraft_version.unwrap_or("any").to_string(),
                loader: "any".to_string(),
            });
        }

        let version = &versions[0];
        let file = version
            .files
            .iter()
            .find(|f| f.primary)
            .or_else(|| version.files.first())
            .ok_or_else(|| {
                LauncherError::ModDownloadFailed(format!("No files found for {}", slug))
            })?;

        // Determine target directory
        let target_dir = Self::get_resource_dir(resource_type, instance_id, is_global);
        // ИСПРАВЛЕНО: Используем tokio::fs::create_dir_all вместо блокирующего std::fs::create_dir_all
        tokio::fs::create_dir_all(&target_dir).await?;

        let target_path = target_dir.join(&file.filename);

        // Download file
        log::info!("Downloading {} to {:?}", file.url, target_path);
        download_manager
            .download_file(&file.url, &target_path, slug, Some(&file.hashes.sha1))
            .await?;

        // ИСПРАВЛЕНО: Используем tokio::fs::metadata вместо блокирующего std::fs::metadata
        let file_size = tokio::fs::metadata(&target_path)
            .await
            .map(|m| m.len() as i64)
            .ok();

        // Save to database
        let now = Utc::now().to_rfc3339();
        let conn = get_db_conn()?;
        let table = resource_type.table_name();

        conn.execute(
            &format!(
                r#"INSERT INTO {} (
                    instance_id, is_global, slug, name, version, minecraft_version,
                    source, source_id, project_url, download_url,
                    file_name, file_hash, file_size,
                    enabled, auto_update,
                    description, author, icon_url,
                    installed_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)"#,
                table
            ),
            params![
                instance_id,
                if is_global { 1 } else { 0 },
                slug,
                project.title,
                version.version_number,
                minecraft_version,
                "modrinth",
                project.slug,
                format!("https://modrinth.com/{}/{}", resource_type.modrinth_project_type(), slug),
                file.url,
                file.filename,
                file.hashes.sha1,
                file_size,
                1, // enabled
                1, // auto_update
                project.description,
                Option::<String>::None, // author - not available in ModrinthProject
                project.icon_url,
                now,
                now,
            ],
        )?;

        let id = conn.last_insert_rowid();

        log::info!(
            "Installed {:?} '{}' (id: {}, file: {})",
            resource_type,
            slug,
            id,
            file.filename
        );

        Ok(InstalledResource {
            id,
            resource_type,
            instance_id: instance_id.map(String::from),
            is_global,
            slug: slug.to_string(),
            name: project.title,
            version: version.version_number.clone(),
            minecraft_version: minecraft_version.map(String::from),
            source: "modrinth".to_string(),
            source_id: Some(project.slug.clone()),
            project_url: Some(format!(
                "https://modrinth.com/{}/{}",
                resource_type.modrinth_project_type(),
                slug
            )),
            download_url: Some(file.url.clone()),
            file_name: file.filename.clone(),
            file_hash: Some(file.hashes.sha1.clone()),
            file_size,
            enabled: true,
            auto_update: true,
            description: Some(project.description),
            author: None, // Not available in ModrinthProject
            icon_url: project.icon_url,
            installed_at: now.clone(),
            updated_at: now,
        })
    }

    /// Install resource from local file
    pub async fn install_local(
        resource_type: ResourceType,
        instance_id: Option<&str>,
        is_global: bool,
        source_path: &str,
    ) -> Result<InstalledResource> {
        let source = std::path::PathBuf::from(source_path);

        // ИСПРАВЛЕНО: Используем tokio::fs::try_exists вместо блокирующего exists()
        if !tokio::fs::try_exists(&source).await.unwrap_or(false) {
            return Err(LauncherError::NotFound(format!(
                "File not found: {}",
                source_path
            )));
        }

        let file_name = source
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| LauncherError::InvalidConfig("Invalid file name".into()))?
            .to_string();

        // Extract slug from filename (remove extension)
        let slug = source
            .file_stem()
            .and_then(|n| n.to_str())
            .unwrap_or(&file_name)
            .to_lowercase()
            .replace(' ', "-");

        // Check if already installed
        if Self::is_installed(resource_type, instance_id, is_global, &slug)? {
            return Err(LauncherError::InvalidConfig(format!(
                "{:?} '{}' is already installed",
                resource_type, slug
            )));
        }

        // ИСПРАВЛЕНО: Copy file to target directory using tokio::fs
        let target_dir = Self::get_resource_dir(resource_type, instance_id, is_global);
        tokio::fs::create_dir_all(&target_dir).await?;

        let target_path = target_dir.join(&file_name);
        tokio::fs::copy(&source, &target_path).await?;

        // Calculate hash
        let file_hash = Self::calculate_sha1(&target_path).await.ok();
        let file_size = tokio::fs::metadata(&target_path)
            .await
            .map(|m| m.len() as i64)
            .ok();

        // Save to database
        let now = Utc::now().to_rfc3339();
        let conn = get_db_conn()?;
        let table = resource_type.table_name();

        conn.execute(
            &format!(
                r#"INSERT INTO {} (
                    instance_id, is_global, slug, name, version, minecraft_version,
                    source, source_id, project_url, download_url,
                    file_name, file_hash, file_size,
                    enabled, auto_update,
                    description, author, icon_url,
                    installed_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)"#,
                table
            ),
            params![
                instance_id,
                if is_global { 1 } else { 0 },
                slug,
                file_name, // use filename as name
                "local",
                None::<String>, // minecraft_version
                "local",
                None::<String>, // source_id
                None::<String>, // project_url
                None::<String>, // download_url
                file_name,
                file_hash,
                file_size,
                1, // enabled
                0, // auto_update disabled for local
                None::<String>, // description
                None::<String>, // author
                None::<String>, // icon_url
                now,
                now,
            ],
        )?;

        let id = conn.last_insert_rowid();

        log::info!(
            "Installed local {:?} '{}' (id: {})",
            resource_type,
            slug,
            id
        );

        Ok(InstalledResource {
            id,
            resource_type,
            instance_id: instance_id.map(String::from),
            is_global,
            slug,
            name: file_name.clone(),
            version: "local".to_string(),
            minecraft_version: None,
            source: "local".to_string(),
            source_id: None,
            project_url: None,
            download_url: None,
            file_name,
            file_hash,
            file_size,
            enabled: true,
            auto_update: false,
            description: None,
            author: None,
            icon_url: None,
            installed_at: now.clone(),
            updated_at: now,
        })
    }

    /// Check if resource is installed
    pub fn is_installed(
        resource_type: ResourceType,
        instance_id: Option<&str>,
        is_global: bool,
        slug: &str,
    ) -> Result<bool> {
        let conn = get_db_conn()?;
        let table = resource_type.table_name();

        let count: i64 = if is_global {
            conn.query_row(
                &format!(
                    "SELECT COUNT(*) FROM {} WHERE is_global = 1 AND slug = ?1",
                    table
                ),
                [slug],
                |row| row.get(0),
            )?
        } else {
            conn.query_row(
                &format!(
                    "SELECT COUNT(*) FROM {} WHERE instance_id = ?1 AND slug = ?2",
                    table
                ),
                params![instance_id, slug],
                |row| row.get(0),
            )?
        };

        Ok(count > 0)
    }

    /// Toggle resource enabled/disabled
    pub async fn toggle_resource(
        resource_type: ResourceType,
        resource_id: i64,
        enabled: bool,
    ) -> Result<()> {
        let conn = get_db_conn()?;
        let table = resource_type.table_name();

        // Get resource info first
        let (file_name, instance_id, is_global): (String, Option<String>, bool) = conn.query_row(
            &format!(
                "SELECT file_name, instance_id, is_global FROM {} WHERE id = ?1",
                table
            ),
            [resource_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get::<_, i32>(2)? == 1)),
        )?;

        let dir = Self::get_resource_dir(resource_type, instance_id.as_deref(), is_global);

        // Rename file with .disabled suffix
        let current_path = if enabled {
            dir.join(format!("{}.disabled", file_name))
        } else {
            dir.join(&file_name)
        };

        let new_path = if enabled {
            dir.join(&file_name)
        } else {
            dir.join(format!("{}.disabled", file_name))
        };

        // ИСПРАВЛЕНО: Используем tokio::fs для проверки существования и переименования
        if tokio::fs::try_exists(&current_path).await.unwrap_or(false) {
            tokio::fs::rename(&current_path, &new_path).await?;
        }

        // Update database
        conn.execute(
            &format!(
                "UPDATE {} SET enabled = ?1, updated_at = ?2 WHERE id = ?3",
                table
            ),
            params![
                if enabled { 1 } else { 0 },
                Utc::now().to_rfc3339(),
                resource_id
            ],
        )?;

        log::info!(
            "Toggled {:?} {} to enabled={}",
            resource_type,
            resource_id,
            enabled
        );

        Ok(())
    }

    /// Remove resource
    pub async fn remove_resource(resource_type: ResourceType, resource_id: i64) -> Result<()> {
        let conn = get_db_conn()?;
        let table = resource_type.table_name();

        // Get resource info
        let (file_name, instance_id, is_global, _enabled): (String, Option<String>, bool, bool) =
            conn.query_row(
                &format!(
                    "SELECT file_name, instance_id, is_global, enabled FROM {} WHERE id = ?1",
                    table
                ),
                [resource_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get::<_, i32>(2)? == 1,
                        row.get::<_, i32>(3)? == 1,
                    ))
                },
            )?;

        let dir = Self::get_resource_dir(resource_type, instance_id.as_deref(), is_global);

        // ИСПРАВЛЕНО: Delete file using tokio::fs (check both enabled and disabled versions)
        let file_path = dir.join(&file_name);
        let disabled_path = dir.join(format!("{}.disabled", file_name));

        if tokio::fs::try_exists(&file_path).await.unwrap_or(false) {
            tokio::fs::remove_file(&file_path).await?;
        }
        if tokio::fs::try_exists(&disabled_path).await.unwrap_or(false) {
            tokio::fs::remove_file(&disabled_path).await?;
        }

        // Delete from database
        conn.execute(
            &format!("DELETE FROM {} WHERE id = ?1", table),
            [resource_id],
        )?;

        log::info!(
            "Removed {:?} {} ({})",
            resource_type,
            resource_id,
            file_name
        );

        Ok(())
    }

    /// Search resources on Modrinth
    pub async fn search_modrinth(
        resource_type: ResourceType,
        query: &str,
        minecraft_version: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> Result<ResourceSearchResponse> {
        let project_type = resource_type.modrinth_project_type();

        log::info!(
            "Searching Modrinth for {:?}: query='{}', mc_version={:?}, limit={}, offset={}",
            resource_type,
            query,
            minecraft_version,
            limit,
            offset
        );

        // Build facets
        let mut facets = vec![vec![format!("project_type:{}", project_type)]];
        if let Some(mc_version) = minecraft_version {
            facets.push(vec![format!("versions:{}", mc_version)]);
        }

        // Call Modrinth API
        let url = reqwest::Url::parse_with_params(
            "https://api.modrinth.com/v2/search",
            &[
                ("query", query),
                (
                    "facets",
                    &serde_json::to_string(&facets).unwrap_or_default(),
                ),
                ("limit", &limit.to_string()),
                ("offset", &offset.to_string()),
            ],
        )
        .map_err(|e| LauncherError::ApiError(format!("URL parse error: {}", e)))?;

        log::debug!("Modrinth search URL: {}", url);

        let response: serde_json::Value = crate::downloader::fetch_json(url.as_str()).await?;

        log::debug!(
            "Modrinth search response: total_hits={}, hits_count={}",
            response["total_hits"].as_u64().unwrap_or(0),
            response["hits"].as_array().map(|a| a.len()).unwrap_or(0)
        );

        let hits = response["hits"]
            .as_array()
            .ok_or_else(|| LauncherError::ApiError("Invalid response format".into()))?;

        let results: Vec<ResourceSearchResult> = hits
            .iter()
            .filter_map(|hit| {
                Some(ResourceSearchResult {
                    slug: hit["slug"].as_str()?.to_string(),
                    title: hit["title"].as_str()?.to_string(),
                    description: hit["description"].as_str().unwrap_or("").to_string(),
                    author: hit["author"].as_str().unwrap_or("Unknown").to_string(),
                    icon_url: hit["icon_url"].as_str().map(String::from),
                    downloads: hit["downloads"].as_u64().unwrap_or(0),
                    project_type: hit["project_type"].as_str().unwrap_or("").to_string(),
                    categories: hit["categories"]
                        .as_array()
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|v| v.as_str().map(String::from))
                                .collect()
                        })
                        .unwrap_or_default(),
                    versions: hit["versions"]
                        .as_array()
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|v| v.as_str().map(String::from))
                                .collect()
                        })
                        .unwrap_or_default(),
                })
            })
            .collect();

        let total = response["total_hits"].as_u64().unwrap_or(0);

        Ok(ResourceSearchResponse {
            results,
            total,
            offset,
            limit,
        })
    }

    /// Get full resource details from Modrinth
    pub async fn get_details(slug: &str, resource_type: ResourceType) -> Result<ResourceDetails> {
        log::info!("Fetching details for {:?} '{}'", resource_type, slug);

        // Get project info from Modrinth
        let project = ModrinthClient::get_project(slug).await?;

        // Verify project type
        if project.project_type != resource_type.modrinth_project_type() {
            return Err(LauncherError::InvalidConfig(format!(
                "Project '{}' is a {}, not a {:?}",
                slug, project.project_type, resource_type
            )));
        }

        // Fetch versions to get actual game_versions (not version IDs)
        let versions = ModrinthClient::get_project_versions(slug, None, None).await?;

        // Extract unique game versions and sort them (newest first)
        let mut game_versions: Vec<String> = versions
            .iter()
            .flat_map(|v| v.game_versions.clone())
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .collect();

        // Sort versions naturally (1.20.1, 1.20, 1.19.4, etc.)
        game_versions.sort_by(|a, b| {
            // Parse version components for natural sorting
            let parse_version = |s: &str| -> Vec<u32> {
                s.split('.').filter_map(|p| p.parse::<u32>().ok()).collect()
            };
            let va = parse_version(a);
            let vb = parse_version(b);
            vb.cmp(&va) // Reverse order (newest first)
        });

        // Convert gallery images
        let gallery: Vec<ResourceGalleryImage> = project
            .gallery
            .into_iter()
            .map(|img| ResourceGalleryImage {
                url: img.url,
                title: img.title,
                description: img.description,
                featured: img.featured,
            })
            .collect();

        // Build links
        let links = ResourceLinks {
            modrinth: Some(format!(
                "https://modrinth.com/{}/{}",
                resource_type.modrinth_project_type(),
                slug
            )),
            source: project.source_url,
            wiki: project.wiki_url,
            discord: project.discord_url,
            issues: project.issues_url,
        };

        Ok(ResourceDetails {
            slug: project.slug,
            title: project.title,
            description: project.description,
            body: project.body,
            author: "Unknown".to_string(), // Author not in ModrinthProject, would need team API
            icon_url: project.icon_url,
            downloads: project.downloads,
            followers: project.followers,
            categories: project.categories,
            versions: game_versions,
            gallery,
            links,
            license_id: Some(project.license.id),
            license_name: Some(project.license.name),
        })
    }

    /// Calculate SHA1 hash of file
    /// ИСПРАВЛЕНО: Используем spawn_blocking для CPU-intensive хеширования
    async fn calculate_sha1(path: &std::path::Path) -> Result<String> {
        let path = path.to_path_buf();
        tokio::task::spawn_blocking(move || {
            use sha1::{Digest, Sha1};
            let mut file = std::fs::File::open(&path)?;
            let mut hasher = Sha1::new();
            std::io::copy(&mut file, &mut hasher)?;
            Ok(format!("{:x}", hasher.finalize()))
        })
        .await
        .map_err(|e| LauncherError::Join(e.to_string()))?
    }

    /// Scan directory for untracked resources and add them to database
    pub async fn scan_and_import(
        resource_type: ResourceType,
        instance_id: Option<&str>,
        is_global: bool,
    ) -> Result<Vec<InstalledResource>> {
        let dir = Self::get_resource_dir(resource_type, instance_id, is_global);

        // ИСПРАВЛЕНО: Используем tokio::fs::try_exists вместо блокирующего exists()
        if !tokio::fs::try_exists(&dir).await.unwrap_or(false) {
            return Ok(vec![]);
        }

        let mut imported = Vec::new();

        // ИСПРАВЛЕНО: Используем tokio::fs::read_dir вместо блокирующего std::fs::read_dir
        let mut entries = tokio::fs::read_dir(&dir).await?;
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();

            // ИСПРАВЛЕНО: Используем tokio::fs::metadata вместо блокирующего path.is_file()
            let metadata = match tokio::fs::metadata(&path).await {
                Ok(m) => m,
                Err(_) => continue,
            };

            if !metadata.is_file() {
                continue;
            }

            let file_name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();

            // Skip disabled files for now
            let (actual_name, enabled) = if file_name.ends_with(".disabled") {
                (file_name.trim_end_matches(".disabled").to_string(), false)
            } else {
                (file_name.clone(), true)
            };

            // Only process .zip files
            if !actual_name.ends_with(".zip") {
                continue;
            }

            // Extract slug
            let slug = actual_name
                .trim_end_matches(".zip")
                .to_lowercase()
                .replace(' ', "-");

            // Check if already in database
            if Self::is_installed(resource_type, instance_id, is_global, &slug)? {
                continue;
            }

            // Add to database
            let file_hash = Self::calculate_sha1(&path).await.ok();
            // ИСПРАВЛЕНО: Используем tokio::fs::metadata вместо блокирующего std::fs::metadata
            let file_size = tokio::fs::metadata(&path)
                .await
                .map(|m| m.len() as i64)
                .ok();
            let now = Utc::now().to_rfc3339();

            let conn = get_db_conn()?;
            let table = resource_type.table_name();

            conn.execute(
                &format!(
                    r#"INSERT INTO {} (
                        instance_id, is_global, slug, name, version, minecraft_version,
                        source, source_id, project_url, download_url,
                        file_name, file_hash, file_size,
                        enabled, auto_update,
                        description, author, icon_url,
                        installed_at, updated_at
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)"#,
                    table
                ),
                params![
                    instance_id,
                    if is_global { 1 } else { 0 },
                    slug,
                    actual_name,
                    "unknown",
                    None::<String>,
                    "local",
                    None::<String>,
                    None::<String>,
                    None::<String>,
                    actual_name,
                    file_hash,
                    file_size,
                    if enabled { 1 } else { 0 },
                    0,
                    None::<String>,
                    None::<String>,
                    None::<String>,
                    now,
                    now,
                ],
            )?;

            let id = conn.last_insert_rowid();

            imported.push(InstalledResource {
                id,
                resource_type,
                instance_id: instance_id.map(String::from),
                is_global,
                slug,
                name: actual_name.clone(),
                version: "unknown".to_string(),
                minecraft_version: None,
                source: "local".to_string(),
                source_id: None,
                project_url: None,
                download_url: None,
                file_name: actual_name,
                file_hash,
                file_size,
                enabled,
                auto_update: false,
                description: None,
                author: None,
                icon_url: None,
                installed_at: now.clone(),
                updated_at: now,
            });
        }

        if !imported.is_empty() {
            log::info!("Imported {} untracked {:?}s", imported.len(), resource_type);
        }

        Ok(imported)
    }
}

// ============== Tauri Commands ==============

#[tauri::command]
pub async fn list_resources(
    resource_type: String,
    instance_id: Option<String>,
    include_global: Option<bool>,
) -> Result<Vec<InstalledResource>> {
    let rt: ResourceType = resource_type.parse()?;
    ResourceManager::list_resources(rt, instance_id.as_deref(), include_global.unwrap_or(true))
}

#[tauri::command]
pub async fn install_resource_from_modrinth(
    app_handle: tauri::AppHandle,
    resource_type: String,
    instance_id: Option<String>,
    is_global: bool,
    slug: String,
    minecraft_version: Option<String>,
) -> Result<InstalledResource> {
    let rt: ResourceType = resource_type.parse()?;
    let dm = DownloadManager::new(app_handle)?;
    ResourceManager::install_from_modrinth(
        rt,
        instance_id.as_deref(),
        is_global,
        &slug,
        minecraft_version.as_deref(),
        &dm,
    )
    .await
}

#[tauri::command]
pub async fn install_resource_local(
    resource_type: String,
    instance_id: Option<String>,
    is_global: bool,
    source_path: String,
) -> Result<InstalledResource> {
    let rt: ResourceType = resource_type.parse()?;
    // ИСПРАВЛЕНО: install_local теперь async
    ResourceManager::install_local(rt, instance_id.as_deref(), is_global, &source_path).await
}

#[tauri::command]
pub async fn toggle_resource(resource_type: String, resource_id: i64, enabled: bool) -> Result<()> {
    let rt: ResourceType = resource_type.parse()?;
    // ИСПРАВЛЕНО: toggle_resource теперь async
    ResourceManager::toggle_resource(rt, resource_id, enabled).await
}

#[tauri::command]
pub async fn remove_resource(resource_type: String, resource_id: i64) -> Result<()> {
    let rt: ResourceType = resource_type.parse()?;
    // ИСПРАВЛЕНО: remove_resource теперь async
    ResourceManager::remove_resource(rt, resource_id).await
}

#[tauri::command]
pub async fn search_resources(
    resource_type: String,
    query: String,
    minecraft_version: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<ResourceSearchResponse> {
    let rt: ResourceType = resource_type.parse()?;
    ResourceManager::search_modrinth(
        rt,
        &query,
        minecraft_version.as_deref(),
        limit.unwrap_or(20),
        offset.unwrap_or(0),
    )
    .await
}

#[tauri::command]
pub async fn scan_resources(
    resource_type: String,
    instance_id: Option<String>,
    is_global: bool,
) -> Result<Vec<InstalledResource>> {
    let rt: ResourceType = resource_type.parse()?;
    ResourceManager::scan_and_import(rt, instance_id.as_deref(), is_global).await
}

#[tauri::command]
pub async fn get_resource_details(resource_type: String, slug: String) -> Result<ResourceDetails> {
    let rt: ResourceType = resource_type.parse()?;
    ResourceManager::get_details(&slug, rt).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resource_type_parsing() {
        assert_eq!(
            "shader".parse::<ResourceType>().unwrap(),
            ResourceType::Shader
        );
        assert_eq!(
            "resourcepack".parse::<ResourceType>().unwrap(),
            ResourceType::Resourcepack
        );
        assert_eq!(
            "shaders".parse::<ResourceType>().unwrap(),
            ResourceType::Shader
        );
        assert!("invalid".parse::<ResourceType>().is_err());
    }

    #[test]
    fn test_resource_type_table_names() {
        assert_eq!(ResourceType::Shader.table_name(), "shaderpacks");
        assert_eq!(ResourceType::Resourcepack.table_name(), "resourcepacks");
    }

    #[test]
    fn test_modrinth_project_types() {
        assert_eq!(ResourceType::Shader.modrinth_project_type(), "shader");
        assert_eq!(
            ResourceType::Resourcepack.modrinth_project_type(),
            "resourcepack"
        );
    }
}
