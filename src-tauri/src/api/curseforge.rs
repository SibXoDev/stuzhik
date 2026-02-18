use super::cache::{curseforge_cache, curseforge_limiter, CacheTTL};
use crate::error::{LauncherError, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::OnceLock;

const CURSEFORGE_API_BASE: &str = "https://api.curseforge.com/v1";

const DEFAULT_CURSEFORGE_API_KEY: &str = "$2a$10$bL4bIL5pUWqfcO7KQtnMReakwtfHbNKh6v1uTpKlzhwoueEJQnPnm";

pub fn get_curseforge_api_key() -> String {
    std::env::var("CURSEFORGE_API_KEY").unwrap_or_else(|_| DEFAULT_CURSEFORGE_API_KEY.to_string())
}

/// Shared CurseForge HTTP client — created once, reused across all calls.
/// Avoids DNS resolution, TLS handshake, and connection pool overhead per request.
/// Uses 120s timeout for large batch API requests (500+ mods).
static CF_SHARED_CLIENT: std::sync::LazyLock<Client> = std::sync::LazyLock::new(|| {
    let api_key = get_curseforge_api_key()
        .parse()
        .expect("valid CurseForge API key header value");
    Client::builder()
        .user_agent(crate::USER_AGENT)
        .timeout(std::time::Duration::from_secs(120))
        .connect_timeout(std::time::Duration::from_secs(10))
        .pool_max_idle_per_host(4)
        .default_headers({
            let mut headers = reqwest::header::HeaderMap::new();
            headers.insert("x-api-key", api_key);
            headers
        })
        .build()
        .expect("Failed to build CurseForge shared HTTP client")
});

/// Get the shared CurseForge HTTP client (connection pooling, no repeated TLS handshake)
pub fn shared_client() -> &'static Client {
    &CF_SHARED_CLIENT
}

/// Retry helper for CurseForge API calls.
/// Retries on connection-level errors (timeout, connect, request) with exponential backoff.
/// Does NOT retry on HTTP errors (4xx, 5xx) — those are handled by the caller.
pub async fn cf_api_retry<F, Fut, T>(operation_name: &str, make_request: F) -> Result<T>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = std::result::Result<T, reqwest::Error>>,
{
    const MAX_RETRIES: u32 = 2;
    const BASE_DELAY_MS: u64 = 500;

    let mut last_err = None;

    for attempt in 0..=MAX_RETRIES {
        if attempt > 0 {
            let delay = BASE_DELAY_MS * (1 << (attempt - 1));
            log::info!(
                "Retrying CurseForge API call '{}' (attempt {}/{}) after {}ms",
                operation_name,
                attempt + 1,
                MAX_RETRIES + 1,
                delay
            );
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
        }

        match make_request().await {
            Ok(result) => return Ok(result),
            Err(e) => {
                let is_connection_error =
                    e.is_timeout() || e.is_connect() || e.is_request();

                if is_connection_error && attempt < MAX_RETRIES {
                    log::warn!(
                        "CurseForge API '{}' connection error (attempt {}/{}): {}",
                        operation_name,
                        attempt + 1,
                        MAX_RETRIES + 1,
                        e
                    );
                    last_err = Some(e);
                    continue;
                }

                return Err(LauncherError::ApiError(format!(
                    "CurseForge API '{}' failed: {}",
                    operation_name, e
                )));
            }
        }
    }

    Err(last_err
        .map(|e| LauncherError::ApiError(format!("CurseForge API '{}' failed after retries: {}", operation_name, e)))
        .unwrap_or_else(|| LauncherError::ApiError(format!("CurseForge API '{}' failed", operation_name))))
}

static CATEGORY_NAMES: OnceLock<HashMap<u32, String>> = OnceLock::new();

fn get_category_map() -> &'static HashMap<u32, String> {
    CATEGORY_NAMES.get_or_init(|| {
        let mut map = HashMap::new();
        // Основные категории CurseForge для Minecraft модов
        map.insert(412, "Technology".to_string());
        map.insert(419, "Magic".to_string());
        map.insert(406, "Adventure".to_string());
        map.insert(407, "Utility".to_string());
        map.insert(409, "World Gen".to_string());
        map.insert(414, "Food".to_string());
        map.insert(415, "Mobs".to_string());
        map.insert(416, "Cosmetic".to_string());
        map.insert(417, "Storage".to_string());
        map.insert(423, "Library".to_string());
        map.insert(435, "Equipment".to_string());
        map.insert(436, "Optimization".to_string());
        map
    })
}

#[derive(Debug, Deserialize)]
pub struct CurseForgeResponse<T> {
    pub data: T,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CurseForgeMod {
    pub id: u64,
    pub name: String,
    pub slug: String,
    pub summary: String,
    pub download_count: u64,
    pub thumbs_up_count: u64,
    pub logo: Option<CurseForgeLogo>,
    pub authors: Vec<CurseForgeAuthor>,
    pub categories: Vec<CurseForgeCategory>,
    pub latest_files: Vec<CurseForgeFile>,
    #[serde(default)]
    pub links: CurseForgeLinks,
    #[serde(default)]
    pub screenshots: Vec<CurseForgeScreenshot>,
    #[serde(default)]
    pub date_created: String,
    #[serde(default)]
    pub date_modified: String,
}

impl CurseForgeMod {
    pub fn get_category_names(&self) -> Vec<String> {
        let map = get_category_map();
        self.categories
            .iter()
            .filter_map(|cat| map.get(&cat.id).cloned())
            .collect()
    }
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CurseForgeLogo {
    pub url: String,
    pub thumbnail_url: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct CurseForgeAuthor {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct CurseForgeCategory {
    pub id: u32,
    pub name: String,
    pub slug: String,
}

#[derive(Debug, Deserialize, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct CurseForgeLinks {
    pub website_url: Option<String>,
    pub wiki_url: Option<String>,
    pub issues_url: Option<String>,
    pub source_url: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CurseForgeScreenshot {
    pub id: u64,
    pub title: Option<String>,
    pub description: Option<String>,
    pub url: String,
    pub thumbnail_url: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CurseForgeFile {
    pub id: u64,
    pub display_name: String,
    pub file_name: String,
    pub file_date: String,
    pub file_length: u64,
    pub download_url: Option<String>,
    pub game_versions: Vec<String>,
    pub dependencies: Vec<CurseForgeDependency>,
    pub hashes: Vec<CurseForgeHash>,
    #[serde(default)]
    pub download_count: u64,
    /// Release type: 1=release, 2=beta, 3=alpha
    #[serde(default = "default_release_type")]
    pub release_type: u8,
}

fn default_release_type() -> u8 {
    1 // release
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CurseForgeDependency {
    pub mod_id: u64,
    pub relation_type: u32, // 1=embedded, 2=optional, 3=required, 4=tool, 5=incompatible, 6=include
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct CurseForgeHash {
    pub value: String,
    pub algo: u32, // 1=SHA1, 2=MD5
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct CurseForgeSearchResult {
    pub data: Vec<CurseForgeMod>,
    pub pagination: CurseForgePagination,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CurseForgePagination {
    pub index: u32,
    pub page_size: u32,
    pub result_count: u32,
    pub total_count: u32,
}

pub struct CurseForgeClient {
    client: Client,
}

impl CurseForgeClient {
    pub fn new() -> Result<Self> {
        let api_key = get_curseforge_api_key().parse().map_err(|_| {
            LauncherError::InvalidConfig("Invalid CurseForge API key format".to_string())
        })?;

        let client = Client::builder()
            .user_agent(crate::USER_AGENT)
            .timeout(std::time::Duration::from_secs(30))
            .default_headers({
                let mut headers = reqwest::header::HeaderMap::new();
                headers.insert("x-api-key", api_key);
                headers
            })
            .build()
            .map_err(|e| {
                LauncherError::InvalidConfig(format!(
                    "Failed to create CurseForge HTTP client: {}",
                    e
                ))
            })?;

        Ok(Self { client })
    }

    /// Fetch JSON from CurseForge API with proper error handling and URL context
    async fn fetch_json<T: serde::de::DeserializeOwned>(&self, url: &str) -> Result<T> {
        let response = self.client.get(url).send().await.map_err(|e| {
            log::error!("CurseForge API request failed for {}: {}", url, e);
            LauncherError::ApiError(format!("CurseForge API request failed: {}", e))
        })?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            log::error!("CurseForge API HTTP {}: {} (URL: {})", status, body, url);
            return Err(LauncherError::ApiError(format!(
                "CurseForge API returned HTTP {}: {}",
                status,
                &body[..body.len().min(200)]
            )));
        }

        let text = response.text().await.map_err(|e| {
            log::error!("Failed to read CurseForge response body: {}", e);
            LauncherError::ApiError(format!("Failed to read CurseForge response: {}", e))
        })?;

        serde_json::from_str(&text).map_err(|e| {
            log::error!("Failed to parse CurseForge JSON: {}", e);
            log::debug!(
                "Response body (first 500 chars): {}",
                &text[..text.len().min(500)]
            );
            LauncherError::ApiError(format!(
                "Invalid JSON from CurseForge API: {} (URL: {})",
                e, url
            ))
        })
    }

    /// Получение мода по ID (с кешированием и rate limiting)
    pub async fn get_mod(&self, mod_id: u64) -> Result<CurseForgeMod> {
        let cache = curseforge_cache();
        let limiter = curseforge_limiter();
        let cache_key = format!("mod:{}", mod_id);

        cache
            .get_or_fetch_throttled(&cache_key, CacheTTL::Long, limiter, || async {
                let url = format!("{}/mods/{}", CURSEFORGE_API_BASE, mod_id);
                let response: CurseForgeResponse<CurseForgeMod> = self.fetch_json(&url).await?;
                Ok(response.data)
            })
            .await
    }

    /// Batch получение модов по ID (для получения иконок и другой информации)
    pub async fn get_mods(&self, mod_ids: &[u64]) -> Result<Vec<CurseForgeMod>> {
        if mod_ids.is_empty() {
            return Ok(vec![]);
        }

        let limiter = curseforge_limiter();
        limiter.acquire().await;

        let url = format!("{}/mods", CURSEFORGE_API_BASE);
        let body = serde_json::json!({
            "modIds": mod_ids
        });

        let response = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| LauncherError::ApiError(format!("CurseForge batch get_mods request failed: {}", e)))?;

        if !response.status().is_success() {
            return Err(LauncherError::ApiError(format!(
                "CurseForge batch get_mods failed: HTTP {}",
                response.status()
            )));
        }

        let result: CurseForgeResponse<Vec<CurseForgeMod>> = response
            .json()
            .await
            .map_err(|e| LauncherError::ApiError(format!("Failed to parse CurseForge batch response: {}", e)))?;

        Ok(result.data)
    }

    /// Поиск модов (с кешированием и rate limiting)
    pub async fn search_mods(
        &self,
        query: &str,
        minecraft_version: Option<&str>,
        loader: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> Result<CurseForgeSearchResult> {
        let cache = curseforge_cache();
        let limiter = curseforge_limiter();
        let cache_key = format!(
            "search:{}:{}:{}:{}:{}",
            query,
            minecraft_version.unwrap_or("any"),
            loader.unwrap_or("any"),
            limit,
            offset
        );

        cache
            .get_or_fetch_throttled(&cache_key, CacheTTL::Medium, limiter, || async {
                // Собираем параметры запроса
                let mut params = vec![
                    ("gameId", "432".to_string()),
                    ("classId", "6".to_string()),
                    ("searchFilter", query.to_string()),
                    ("pageSize", limit.to_string()),
                    ("index", offset.to_string()),
                ];

                if let Some(mc_ver) = minecraft_version {
                    params.push(("gameVersion", mc_ver.to_string()));
                }

                if let Some(ldr) = loader {
                    let loader_id = match ldr.to_lowercase().as_str() {
                        "forge" => 1,
                        "fabric" => 4,
                        "quilt" => 5,
                        "neoforge" => 6,
                        _ => 0,
                    };
                    if loader_id > 0 {
                        params.push(("modLoaderType", loader_id.to_string()));
                    }
                }

                // Используем reqwest Url для правильного URL encoding
                let url = reqwest::Url::parse_with_params(
                    &format!("{}/mods/search", CURSEFORGE_API_BASE),
                    &params
                        .iter()
                        .map(|(k, v)| (*k, v.as_str()))
                        .collect::<Vec<_>>(),
                )
                .map_err(|e| LauncherError::ApiError(format!("Failed to build URL: {}", e)))?;

                self.client
                    .get(url)
                    .send()
                    .await?
                    .json()
                    .await
                    .map_err(Into::into)
            })
            .await
    }

    /// Search Hytale mods on CurseForge
    pub async fn search_mods_hytale(
        &self,
        query: &str,
        class_id: Option<u32>,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<CurseForgeMod>> {
        let cache = curseforge_cache();
        let limiter = curseforge_limiter();
        let cache_key = format!(
            "hytale_search:{}:{}:{}:{}",
            query,
            class_id.unwrap_or(0),
            limit,
            offset
        );

        let result: CurseForgeSearchResult = cache
            .get_or_fetch_throttled(&cache_key, CacheTTL::Medium, limiter, || async {
                let mut params = vec![
                    ("gameId", "83374".to_string()), // Hytale game ID
                    ("searchFilter", query.to_string()),
                    ("pageSize", limit.to_string()),
                    ("index", offset.to_string()),
                    ("sortField", "2".to_string()), // Sort by popularity
                    ("sortOrder", "desc".to_string()),
                ];

                if let Some(cid) = class_id {
                    params.push(("classId", cid.to_string()));
                }

                let url = reqwest::Url::parse_with_params(
                    &format!("{}/mods/search", CURSEFORGE_API_BASE),
                    &params
                        .iter()
                        .map(|(k, v)| (*k, v.as_str()))
                        .collect::<Vec<_>>(),
                )
                .map_err(|e| LauncherError::ApiError(format!("Failed to build URL: {}", e)))?;

                self.client
                    .get(url)
                    .send()
                    .await?
                    .json()
                    .await
                    .map_err(Into::into)
            })
            .await?;

        Ok(result.data)
    }

    /// Получение файлов мода (с кешированием и rate limiting)
    pub async fn get_mod_files(
        &self,
        mod_id: u64,
        minecraft_version: Option<&str>,
        loader: Option<&str>,
    ) -> Result<Vec<CurseForgeFile>> {
        let cache = curseforge_cache();
        let limiter = curseforge_limiter();
        let cache_key = format!(
            "files:{}:{}:{}",
            mod_id,
            minecraft_version.unwrap_or("any"),
            loader.unwrap_or("any")
        );

        cache
            .get_or_fetch_throttled(&cache_key, CacheTTL::Medium, limiter, || async {
                let mut url = format!("{}/mods/{}/files", CURSEFORGE_API_BASE, mod_id);

                let mut params = vec![];
                if let Some(mc_ver) = minecraft_version {
                    params.push(format!("gameVersion={}", mc_ver));
                }
                if let Some(ldr) = loader {
                    let loader_id = match ldr.to_lowercase().as_str() {
                        "forge" => 1,
                        "fabric" => 4,
                        "quilt" => 5,
                        "neoforge" => 6,
                        _ => 0,
                    };
                    if loader_id > 0 {
                        params.push(format!("modLoaderType={}", loader_id));
                    }
                }

                if !params.is_empty() {
                    url = format!("{}?{}", url, params.join("&"));
                }

                let response: CurseForgeResponse<Vec<CurseForgeFile>> =
                    self.fetch_json(&url).await?;

                Ok(response.data)
            })
            .await
    }

    /// Получение конкретного файла (с кешированием и rate limiting)
    pub async fn get_file(&self, mod_id: u64, file_id: u64) -> Result<CurseForgeFile> {
        let cache = curseforge_cache();
        let limiter = curseforge_limiter();
        let cache_key = format!("file:{}:{}", mod_id, file_id);

        cache
            .get_or_fetch_throttled(&cache_key, CacheTTL::Long, limiter, || async {
                let url = format!("{}/mods/{}/files/{}", CURSEFORGE_API_BASE, mod_id, file_id);
                let response: CurseForgeResponse<CurseForgeFile> = self.fetch_json(&url).await?;
                Ok(response.data)
            })
            .await
    }

    /// Получение последней совместимой версии
    pub async fn get_latest_file(
        &self,
        mod_id: u64,
        minecraft_version: &str,
        loader: &str,
    ) -> Result<CurseForgeFile> {
        let files = self
            .get_mod_files(mod_id, Some(minecraft_version), Some(loader))
            .await?;

        files.into_iter().next().ok_or_else(|| {
            LauncherError::ModNotFound(format!(
                "No compatible file found for mod {} (MC: {}, Loader: {})",
                mod_id, minecraft_version, loader
            ))
        })
    }

    /// Разрешение зависимостей
    pub async fn resolve_dependencies(&self, file: &CurseForgeFile) -> Result<Vec<(u64, String)>> {
        let mut deps = Vec::new();

        for dep in &file.dependencies {
            match dep.relation_type {
                3 => {
                    // Required
                    deps.push((dep.mod_id, "required".to_string()));
                }
                5 => {
                    // Incompatible
                    deps.push((dep.mod_id, "incompatible".to_string()));
                }
                _ => {}
            }
        }

        Ok(deps)
    }

    /// Проверка обновлений
    pub async fn check_updates(
        &self,
        mod_id: u64,
        current_file_id: u64,
        minecraft_version: &str,
        loader: &str,
    ) -> Result<Option<CurseForgeFile>> {
        let latest = self
            .get_latest_file(mod_id, minecraft_version, loader)
            .await?;

        if latest.id != current_file_id {
            Ok(Some(latest))
        } else {
            Ok(None)
        }
    }

    /// Получение changelog для конкретного файла
    pub async fn get_file_changelog(&self, mod_id: u64, file_id: u64) -> Result<Option<String>> {
        let cache = curseforge_cache();
        let limiter = curseforge_limiter();
        let cache_key = format!("changelog:{}:{}", mod_id, file_id);

        cache
            .get_or_fetch_throttled(&cache_key, CacheTTL::Long, limiter, || async {
                let url = format!(
                    "{}/mods/{}/files/{}/changelog",
                    CURSEFORGE_API_BASE, mod_id, file_id
                );

                #[derive(Deserialize)]
                struct ChangelogResponse {
                    data: String,
                }

                match self.fetch_json::<CurseForgeResponse<String>>(&url).await {
                    Ok(response) => {
                        let changelog = response.data.trim().to_string();
                        if changelog.is_empty() {
                            Ok(None)
                        } else {
                            Ok(Some(changelog))
                        }
                    }
                    Err(_) => Ok(None), // Changelog не обязателен, при ошибке возвращаем None
                }
            })
            .await
    }

    /// Look up mods by their fingerprints (MurmurHash2)
    /// Returns matching files with their mod info
    pub async fn get_fingerprint_matches(
        &self,
        fingerprints: &[u32],
    ) -> Result<Vec<FingerprintMatch>> {
        let limiter = curseforge_limiter();
        limiter.acquire().await;

        let url = format!("{}/fingerprints", CURSEFORGE_API_BASE);

        #[derive(Serialize)]
        struct FingerprintRequest {
            fingerprints: Vec<u32>,
        }

        #[derive(Deserialize)]
        struct FingerprintResponse {
            data: FingerprintData,
        }

        #[derive(Deserialize)]
        struct FingerprintData {
            #[serde(rename = "exactMatches")]
            exact_matches: Vec<FingerprintMatch>,
        }

        let fps = fingerprints.to_vec();
        let client = &self.client;

        let result: FingerprintResponse = cf_api_retry("fingerprint_matches", || {
            let req = FingerprintRequest {
                fingerprints: fps.clone(),
            };
            let u = url.clone();
            async move {
                let resp = client.post(&u).json(&req).send().await?;
                if !resp.status().is_success() {
                    // Return empty on HTTP errors (4xx) — not a connection issue
                    return Ok(FingerprintResponse {
                        data: FingerprintData {
                            exact_matches: Vec::new(),
                        },
                    });
                }
                resp.json().await
            }
        })
        .await?;

        Ok(result.data.exact_matches)
    }
}

/// Match result from fingerprint lookup
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FingerprintMatch {
    pub id: u64,
    pub file: CurseForgeFile,
    /// The fingerprint that matched this file
    #[serde(default)]
    pub fingerprint: u32,
}

impl Default for CurseForgeClient {
    fn default() -> Self {
        Self::new().expect("Failed to create CurseForge client - API key configuration error")
    }
}
