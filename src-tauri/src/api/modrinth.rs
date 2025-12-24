use std::sync::Arc;

use super::cache::{modrinth_cache, modrinth_limiter, CacheTTL};
use crate::downloader::fetch_json;
use crate::error::{LauncherError, Result};
use serde::{Deserialize, Serialize};

const MODRINTH_API_BASE: &str = "https://api.modrinth.com/v2";

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ModrinthProject {
    pub slug: String,
    pub title: String,
    pub description: String,
    pub categories: Vec<String>,
    pub client_side: String,
    pub server_side: String,
    pub downloads: u64,
    pub followers: u64,
    pub icon_url: Option<String>,
    pub body: String,
    pub project_type: String,
    pub license: ModrinthLicense,
    pub versions: Vec<String>,
    // Additional fields for full details
    #[serde(default)]
    pub gallery: Vec<ModrinthGalleryImage>,
    pub source_url: Option<String>,
    pub wiki_url: Option<String>,
    pub discord_url: Option<String>,
    pub issues_url: Option<String>,
    #[serde(default)]
    pub donation_urls: Vec<ModrinthDonationUrl>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ModrinthGalleryImage {
    pub url: String,
    pub featured: bool,
    pub title: Option<String>,
    pub description: Option<String>,
    pub ordering: i32,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ModrinthDonationUrl {
    pub id: String,
    pub platform: String,
    pub url: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ModrinthLicense {
    pub id: String,
    pub name: String,
    pub url: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ModrinthVersion {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub version_number: String,
    pub changelog: Option<String>,
    pub dependencies: Vec<Arc<ModrinthDependency>>,
    pub game_versions: Vec<String>,
    pub loaders: Vec<String>,
    pub files: Vec<Arc<ModrinthFile>>,
    pub date_published: String,
    pub downloads: u64,
    pub version_type: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ModrinthDependency {
    pub version_id: Option<String>,
    pub project_id: Option<String>,
    pub dependency_type: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ModrinthFile {
    pub hashes: ModrinthHashes,
    pub url: String,
    pub filename: String,
    pub primary: bool,
    pub size: u64,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ModrinthHashes {
    pub sha1: String,
    pub sha512: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ModrinthSearchResult {
    pub hits: Vec<ModrinthSearchHit>,
    pub offset: u32,
    pub limit: u32,
    pub total_hits: u32,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ModrinthSearchHit {
    pub slug: String,
    pub title: String,
    pub description: String,
    pub categories: Vec<String>,
    pub client_side: String,
    pub server_side: String,
    pub project_type: String,
    pub downloads: u64,
    pub icon_url: Option<String>,
    pub author: String,
    pub versions: Vec<String>,
    pub follows: u64,
    pub date_created: String,
    pub date_modified: String,
    pub latest_version: Option<String>,
}

pub struct ModrinthClient;

impl ModrinthClient {
    pub fn new() -> Self {
        Self
    }

    /// Поиск проекта по slug (с кешированием и rate limiting)
    pub async fn get_project(slug: &str) -> Result<ModrinthProject> {
        let cache = modrinth_cache();
        let limiter = modrinth_limiter();
        let cache_key = format!("project:{}", slug);

        cache
            .get_or_fetch_throttled(&cache_key, CacheTTL::Long, limiter, || async {
                let url = format!("{}/project/{}", MODRINTH_API_BASE, slug);
                fetch_json(&url).await
            })
            .await
    }

    /// Получение версий проекта (с кешированием и rate limiting)
    pub async fn get_project_versions(
        slug: &str,
        minecraft_version: Option<&str>,
        loader: Option<&str>,
    ) -> Result<Vec<ModrinthVersion>> {
        let cache = modrinth_cache();
        let limiter = modrinth_limiter();
        let cache_key = format!(
            "versions:{}:{}:{}",
            slug,
            minecraft_version.unwrap_or("any"),
            loader.unwrap_or("any")
        );

        cache
            .get_or_fetch_throttled(&cache_key, CacheTTL::Medium, limiter, || async {
                let mut url = format!("{}/project/{}/version", MODRINTH_API_BASE, slug);

                let mut params = vec![];
                if let Some(mc_ver) = minecraft_version {
                    params.push(format!("game_versions=[\"{}\"]", mc_ver));
                }
                if let Some(ldr) = loader {
                    params.push(format!("loaders=[\"{}\"]", ldr));
                }

                if !params.is_empty() {
                    url = format!("{}?{}", url, params.join("&"));
                }

                fetch_json(&url).await
            })
            .await
    }

    /// Получение конкретной версии (с кешированием и rate limiting)
    pub async fn get_version(version_id: &str) -> Result<ModrinthVersion> {
        let cache = modrinth_cache();
        let limiter = modrinth_limiter();
        let cache_key = format!("version:{}", version_id);

        cache
            .get_or_fetch_throttled(&cache_key, CacheTTL::Long, limiter, || async {
                let url = format!("{}/version/{}", MODRINTH_API_BASE, version_id);
                fetch_json(&url).await
            })
            .await
    }

    /// Поиск модов (с кешированием и rate limiting)
    pub async fn search_mods(
        &self,
        query: &str,
        minecraft_version: Option<&str>,
        loader: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> Result<ModrinthSearchResult> {
        self.search_mods_sorted(query, minecraft_version, loader, limit, offset, None)
            .await
    }

    /// Поиск модов с сортировкой (с кешированием и rate limiting)
    pub async fn search_mods_sorted(
        &self,
        query: &str,
        minecraft_version: Option<&str>,
        loader: Option<&str>,
        limit: u32,
        offset: u32,
        index: Option<&str>,
    ) -> Result<ModrinthSearchResult> {
        let cache = modrinth_cache();
        let limiter = modrinth_limiter();
        let sort_index = index.unwrap_or("relevance");
        let cache_key = format!(
            "search:{}:{}:{}:{}:{}:{}",
            query,
            minecraft_version.unwrap_or("any"),
            loader.unwrap_or("any"),
            limit,
            offset,
            sort_index
        );

        cache
            .get_or_fetch_throttled(&cache_key, CacheTTL::Medium, limiter, || async {
                // Формируем facets как JSON массив
                let mut facets = vec![vec!["project_type:mod".to_string()]];

                if let Some(mc_ver) = minecraft_version {
                    facets.push(vec![format!("versions:{}", mc_ver)]);
                }

                if let Some(ldr) = loader {
                    facets.push(vec![format!("categories:{}", ldr)]);
                }

                let facets_json = serde_json::to_string(&facets)
                    .unwrap_or_else(|_| "[[\"project_type:mod\"]]".to_string());

                // Используем reqwest Url для правильного URL encoding
                let url = reqwest::Url::parse_with_params(
                    &format!("{}/search", MODRINTH_API_BASE),
                    &[
                        ("query", query),
                        ("limit", &limit.to_string()),
                        ("offset", &offset.to_string()),
                        ("facets", &facets_json),
                        ("index", sort_index),
                    ],
                )
                .map_err(|e| LauncherError::ApiError(format!("Failed to build URL: {}", e)))?;

                fetch_json(url.as_str()).await
            })
            .await
    }

    /// Получение последней совместимой версии мода
    pub async fn get_latest_version(
        slug: &str,
        minecraft_version: &str,
        loader: &str,
    ) -> Result<ModrinthVersion> {
        let versions =
            Self::get_project_versions(slug, Some(minecraft_version), Some(loader)).await?;

        versions
            .iter()
            .find(|v| v.version_type == "release")
            .cloned()
            .or_else(|| versions.first().cloned())
            .ok_or_else(|| {
                LauncherError::ModNotFound(format!(
                    "No compatible version found for {} (MC: {}, Loader: {})",
                    slug, minecraft_version, loader
                ))
            })
    }

    /// Получение информации о зависимостях
    pub async fn resolve_dependencies(version: &ModrinthVersion) -> Result<Vec<(String, String)>> {
        let mut deps = Vec::new();

        for dep in &version.dependencies {
            if dep.dependency_type == "required" {
                if let Some(project_id) = &dep.project_id {
                    // Получаем информацию о проекте
                    match Self::get_project(project_id).await {
                        Ok(project) => {
                            deps.push((project.slug, dep.dependency_type.clone()));
                        }
                        Err(e) => {
                            log::warn!("Failed to resolve dependency {}: {}", project_id, e);
                        }
                    }
                }
            }
        }

        Ok(deps)
    }

    /// Проверка наличия обновлений для мода
    pub async fn check_updates(
        slug: &str,
        current_version: &str,
        minecraft_version: &str,
        loader: &str,
    ) -> Result<Option<ModrinthVersion>> {
        let latest = Self::get_latest_version(slug, minecraft_version, loader).await?;

        if latest.version_number != current_version {
            Ok(Some(latest))
        } else {
            Ok(None)
        }
    }

    /// Look up a version by file hash (SHA1 or SHA512)
    /// Returns the version and file info if found
    pub async fn get_version_by_hash(hash: &str, algorithm: &str) -> Result<ModrinthVersion> {
        let url = format!(
            "{}/version_file/{}?algorithm={}",
            MODRINTH_API_BASE, hash, algorithm
        );
        fetch_json(&url).await
    }

    /// Look up multiple versions by their file hashes (batch request)
    /// Returns a map of hash -> version info
    pub async fn get_versions_by_hashes(
        hashes: &[String],
        algorithm: &str,
    ) -> Result<std::collections::HashMap<String, ModrinthVersion>> {
        let url = format!("{}/version_files", MODRINTH_API_BASE);

        let client = reqwest::Client::builder()
            .user_agent(crate::USER_AGENT)
            .timeout(std::time::Duration::from_secs(10)) // 10 second timeout
            .build()?;

        let body = serde_json::json!({
            "hashes": hashes,
            "algorithm": algorithm
        });

        let response = client.post(&url).json(&body).send().await?;

        if !response.status().is_success() {
            return Err(LauncherError::ApiError(format!(
                "Modrinth hash lookup failed: {}",
                response.status()
            )));
        }

        response
            .json()
            .await
            .map_err(|e| LauncherError::ApiError(format!("Failed to parse hash response: {}", e)))
    }
}

impl Default for ModrinthClient {
    fn default() -> Self {
        Self::new()
    }
}
