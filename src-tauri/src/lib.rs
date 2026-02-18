use chrono::Local;
use std::{
    collections::HashMap,
    fs,
    io::Write,
    process::Child,
    sync::{Arc, Mutex, OnceLock},
};
use tauri::{Emitter, Manager};
use tokio_util::sync::CancellationToken;

// Global app handle for log event emission
static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

// Global P2P Connect service
static CONNECT_SERVICE: OnceLock<tokio::sync::RwLock<p2p::ConnectService>> = OnceLock::new();

// Global pending modpack file (for file association handling)
// This stores the file path when app is launched via double-click on .stzhk file
static PENDING_MODPACK_FILE: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn get_pending_modpack_storage() -> &'static Mutex<Option<String>> {
    PENDING_MODPACK_FILE.get_or_init(|| Mutex::new(None))
}

fn get_connect_service() -> &'static tokio::sync::RwLock<p2p::ConnectService> {
    CONNECT_SERVICE.get_or_init(|| {
        // Используем cache dir для истории P2P (если BASE_DIR ещё не инициализирован)
        let data_dir = paths::BASE_DIR
            .get()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| std::path::PathBuf::from("."));
        tokio::sync::RwLock::new(p2p::ConnectService::new(data_dir))
    })
}

/// Custom writer that emits log entries as Tauri events
struct TauriLogWriter;

impl Write for TauriLogWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if let Some(app) = APP_HANDLE.get() {
            if let Ok(log_line) = std::str::from_utf8(buf) {
                // Parse log line: [timestamp level target] message
                if let Some(entry) = parse_log_line(log_line.trim()) {
                    let _ = app.emit("rust-log", entry);
                }
            }
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Parse a fern log line into structured data
fn parse_log_line(line: &str) -> Option<serde_json::Value> {
    // Format: [2024-12-04 16:48:12.345 INFO target] message
    if !line.starts_with('[') {
        return None;
    }

    let close_bracket = line.find(']')?;
    let header = &line[1..close_bracket];
    let message = line[close_bracket + 1..].trim();

    let parts: Vec<&str> = header.splitn(4, ' ').collect();
    if parts.len() < 4 {
        return None;
    }

    Some(serde_json::json!({
        "timestamp": format!("{} {}", parts[0], parts[1]),
        "level": parts[2],
        "target": parts[3],
        "message": message
    }))
}

// External workspace crates
use stuzhik_core as core;
use stuzhik_db as db_crate;

// Re-export for internal use
use core::{error, types};
use db_crate::db;

// Local modules
mod api; // API stays in main crate for now
mod backup;
mod cancellation;
mod code_editor;
mod collections;
mod config_editor;
mod conflict_predictor;
mod downloader; // Re-exports SmartDownloader as DownloadManager
mod error_reporter;
mod game_settings;
mod games;
mod gpu;
mod hytale;
mod instances;
mod integrity;
mod java;
mod launch_tracker;
mod launchers;
mod loaders;
mod log_analyzer;
mod minecraft;
mod modpack_editor;
mod modpacks;
mod mods;
mod p2p;
mod paths;
mod performance;
mod recommendations;
mod resources;
mod secrets;
mod server;
mod settings;
mod smart_downloader; // Must be before downloader (downloader re-exports from it)
mod stzhk;
mod sync;
mod translations;
mod tray;
mod utils;
mod wiki;

use error::Result;

/// User-Agent для API запросов (Modrinth best practices)
/// Формат: github_username/project_name/version
pub const USER_AGENT: &str = concat!("SibXoDev/stuzhik/", env!("CARGO_PKG_VERSION"));

#[tauri::command]
fn get_total_memory() -> Result<u64> {
    let mut sys = sysinfo::System::new_all();
    sys.refresh_memory();
    Ok(sys.total_memory() / 1024 / 1024)
}

/// Отмена установки/загрузки по ID операции
#[tauri::command]
fn cancel_operation(operation_id: String, app_handle: tauri::AppHandle) -> Result<bool> {
    use tauri::Emitter;

    let cancelled = cancellation::cancel(&operation_id);

    if cancelled {
        // Отправляем событие об отмене
        let _ = app_handle.emit(
            "operation-cancelled",
            serde_json::json!({
                "id": operation_id,
                "status": "cancelled"
            }),
        );
    }

    Ok(cancelled)
}

/// Получить список активных операций
#[tauri::command]
fn list_active_operations() -> Vec<String> {
    cancellation::list_active_operations()
}

/// Get and clear pending modpack file (for file association handling)
/// Returns the file path if one was pending, and clears it to prevent reopening
#[tauri::command]
fn get_pending_modpack_file() -> Option<String> {
    let storage = get_pending_modpack_storage();
    if let Ok(mut guard) = storage.lock() {
        guard.take() // Returns Some(path) and sets to None
    } else {
        None
    }
}

/// Check if query looks like a mod ID/slug (lowercase, no spaces, alphanumeric/hyphens/underscores)
fn looks_like_mod_id(query: &str) -> bool {
    !query.is_empty()
        && !query.contains(' ')
        && query
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

#[tauri::command]
async fn search_mods(
    query: String,
    minecraft_version: Option<String>,
    loader: Option<String>,
    source: String,
    limit: u32,
    offset: u32,
    search_mode: Option<String>,
    index: Option<String>,
) -> Result<serde_json::Value> {
    let mode = search_mode.unwrap_or_else(|| "name".to_string());
    let sort_index = index.as_deref();

    match source.as_str() {
        "modrinth" => {
            let client = api::modrinth::ModrinthClient::new();

            // If searching by ID or all, and query looks like a mod ID, try direct lookup first
            let should_try_id_lookup =
                (mode == "id" || mode == "all") && offset == 0 && looks_like_mod_id(&query);

            if should_try_id_lookup {
                if let Ok(project) = api::modrinth::ModrinthClient::get_project(&query).await {
                    // Check if project matches version/loader filters
                    let matches_filters = {
                        let matches_version = minecraft_version
                            .as_ref()
                            .map(|v| project.versions.iter().any(|pv| pv.contains(v)))
                            .unwrap_or(true);
                        let matches_loader = loader
                            .as_ref()
                            .map(|l| project.categories.iter().any(|c| c.eq_ignore_ascii_case(l)))
                            .unwrap_or(true);
                        matches_version && matches_loader
                    };

                    if matches_filters && project.project_type == "mod" {
                        // Convert project to search hit format
                        let hit = serde_json::json!({
                            "slug": project.slug,
                            "title": project.title,
                            "description": project.description,
                            "categories": project.categories,
                            "client_side": project.client_side,
                            "server_side": project.server_side,
                            "project_type": project.project_type,
                            "downloads": project.downloads,
                            "icon_url": project.icon_url,
                            "author": "",
                            "versions": project.versions,
                            "follows": project.followers,
                            "date_created": "",
                            "date_modified": "",
                            "latest_version": null,
                            "_exact_match": true
                        });

                        // If searching by ID only, return just the exact match
                        if mode == "id" {
                            return Ok(serde_json::json!({
                                "hits": [hit],
                                "offset": 0,
                                "limit": limit,
                                "total_hits": 1
                            }));
                        }

                        // If searching by "all", also do regular search and prepend the exact match
                        let mut results = client
                            .search_mods_sorted(
                                &query,
                                minecraft_version.as_deref(),
                                loader.as_deref(),
                                limit.saturating_sub(1),
                                0,
                                sort_index,
                            )
                            .await
                            .unwrap_or_else(|_| api::modrinth::ModrinthSearchResult {
                                hits: vec![],
                                offset: 0,
                                limit,
                                total_hits: 0,
                            });

                        // Filter out the exact match from search results to avoid duplicates
                        let exact_slug = project.slug.clone();
                        results.hits.retain(|h| h.slug != exact_slug);

                        // Create combined result
                        let mut hits: Vec<serde_json::Value> = vec![hit];
                        hits.extend(
                            results
                                .hits
                                .into_iter()
                                .filter_map(|h| serde_json::to_value(h).ok()),
                        );

                        return Ok(serde_json::json!({
                            "hits": hits,
                            "offset": 0,
                            "limit": limit,
                            "total_hits": results.total_hits + 1
                        }));
                    }
                }
            }

            // If mode is "id" but no exact match was found, return empty
            if mode == "id" {
                return Ok(serde_json::json!({
                    "hits": [],
                    "offset": offset,
                    "limit": limit,
                    "total_hits": 0
                }));
            }

            // Standard name search
            let results = client
                .search_mods_sorted(
                    &query,
                    minecraft_version.as_deref(),
                    loader.as_deref(),
                    limit,
                    offset,
                    sort_index,
                )
                .await?;

            log::debug!(
                "Modrinth search results: {} hits, total: {}",
                results.hits.len(),
                results.total_hits
            );
            Ok(serde_json::to_value(results)?)
        }
        "curseforge" => {
            let client = api::curseforge::CurseForgeClient::new()?;
            let results = client
                .search_mods(
                    &query,
                    minecraft_version.as_deref(),
                    loader.as_deref(),
                    limit,
                    offset,
                )
                .await?;

            // Transform CurseForge response to unified format with 'hits' array
            // and ensure 'id' field is present for wiki/changelog APIs
            let hits: Vec<serde_json::Value> = results.data.into_iter().map(|m| {
                serde_json::json!({
                    "id": m.id,  // CurseForge mod ID - REQUIRED for wiki/changelog
                    "slug": m.slug,
                    "name": m.name,
                    "title": m.name,  // Alias for compatibility
                    "description": m.summary,
                    "summary": m.summary,
                    "downloads": m.download_count,
                    "follows": m.thumbs_up_count,
                    "icon_url": m.logo.as_ref().map(|l| l.url.clone()),
                    "author": m.authors.first().map(|a| a.name.clone()).unwrap_or_default(),
                    "categories": m.get_category_names(),
                    "versions": m.latest_files.iter().flat_map(|f| f.game_versions.clone()).collect::<Vec<_>>(),
                    "source": "curseforge"
                })
            }).collect();

            Ok(serde_json::json!({
                "hits": hits,
                "offset": results.pagination.index,
                "limit": results.pagination.page_size,
                "total_hits": results.pagination.result_count
            }))
        }
        _ => Err(error::LauncherError::InvalidConfig(format!(
            "Unknown source: {}",
            source
        ))),
    }
}

#[tauri::command]
async fn install_mod(
    instance_id: String,
    slug: String,
    source: String,
    minecraft_version: String,
    loader: String,
    version_id: Option<String>,
    app_handle: tauri::AppHandle,
) -> Result<mods::InstalledMod> {
    // Emit "requesting" status immediately so user sees feedback
    let download_source = Some(source.clone());
    let _ = app_handle.emit(
        "download-progress",
        downloader::DownloadProgress {
            id: format!("mod-{}", slug),
            name: slug.clone(),
            downloaded: 0,
            total: 0,
            speed: 0,
            percentage: 0.0,
            status: "requesting".to_string(),
            operation_id: None,
            source: download_source,
        },
    );

    let download_manager = downloader::DownloadManager::new(app_handle)?;

    match source.as_str() {
        "modrinth" => {
            mods::ModManager::install_from_modrinth(
                &instance_id,
                &slug,
                &minecraft_version,
                &loader,
                version_id.as_deref(),
                &download_manager,
            )
            .await
        }
        "curseforge" => {
            // Парсим slug как mod_id для CurseForge
            let mod_id: u64 = slug.parse().map_err(|_| {
                error::LauncherError::InvalidConfig("Invalid CurseForge mod ID".to_string())
            })?;

            // Парсим version_id как file_id для CurseForge
            let file_id = version_id.as_ref().and_then(|v| v.parse::<u64>().ok());

            mods::ModManager::install_from_curseforge(
                &instance_id,
                mod_id,
                &minecraft_version,
                &loader,
                file_id,
                &download_manager,
            )
            .await
        }
        _ => Err(error::LauncherError::InvalidConfig(format!(
            "Unknown source: {}",
            source
        ))),
    }
}

/// Установка мода по slug с автоматическим определением версии и loader из instance
#[tauri::command]
async fn install_mod_by_slug(
    instance_id: String,
    slug: String,
    source: String,
    app_handle: tauri::AppHandle,
) -> Result<mods::InstalledMod> {
    // Получаем instance из БД для определения версии и loader
    let instance = instances::get_instance(instance_id.clone()).await?;

    let minecraft_version = instance.version;
    let loader = instance.loader.as_str().to_string();

    // Используем основную функцию установки
    install_mod(
        instance_id,
        slug,
        source,
        minecraft_version,
        loader,
        None,
        app_handle,
    )
    .await
}

#[tauri::command]
async fn install_mod_local(
    instance_id: String,
    file_path: String,
    analyze: bool,
) -> Result<mods::InstalledMod> {
    let path = std::path::PathBuf::from(file_path);
    mods::ModManager::install_local(&instance_id, &path, analyze).await
}

/// Batch install multiple local mod files with optimized API lookups
#[tauri::command]
async fn install_mods_local_batch(
    instance_id: String,
    file_paths: Vec<String>,
) -> Result<Vec<mods::BatchModInstallResult>> {
    let paths: Vec<std::path::PathBuf> = file_paths
        .into_iter()
        .map(std::path::PathBuf::from)
        .collect();
    mods::ModManager::install_local_batch(&instance_id, paths).await
}

/// Verify all mods in an instance against Modrinth and CurseForge
#[tauri::command]
async fn verify_instance_mods(
    app_handle: tauri::AppHandle,
    instance_id: String,
) -> Result<Vec<mods::ModVerifyResult>> {
    mods::ModManager::verify_instance_mods(&instance_id, Some(app_handle)).await
}

/// Check for updates for all mods in an instance
#[tauri::command]
async fn check_mod_updates(
    instance_id: String,
    minecraft_version: String,
    loader: String,
) -> Result<mods::UpdateCheckResult> {
    mods::ModManager::check_mod_updates(&instance_id, &minecraft_version, &loader).await
}

/// Verification result for a mod file
#[derive(Debug, Clone, serde::Serialize)]
pub struct ModVerificationResult {
    /// Whether the mod was found on official platforms
    pub verified: bool,
    /// Platform where mod was found: "modrinth", "curseforge", or "unknown"
    pub platform: String,
    /// Project name if found
    pub project_name: Option<String>,
    /// Project slug/id if found
    pub project_slug: Option<String>,
    /// Version string if found
    pub version: Option<String>,
    /// Mod ID extracted from JAR
    pub mod_id: Option<String>,
}

#[tauri::command]
async fn verify_mod_file(file_path: String) -> Result<ModVerificationResult> {
    use crate::api::curseforge::CurseForgeClient;
    use crate::api::modrinth::ModrinthClient;
    use crate::code_editor::minecraft_data::jar_parser::JarParser;
    use crate::error::LauncherError;
    use crate::utils::calculate_sha1;

    let path = std::path::PathBuf::from(&file_path);

    // Extract mod_id from JAR
    let mod_id = tokio::task::spawn_blocking({
        let path = path.clone();
        move || {
            JarParser::parse_mod_jar(&path)
                .ok()
                .and_then(|data| data.mod_info.map(|info| info.mod_id))
        }
    })
    .await
    .ok()
    .flatten();

    // Calculate SHA-1 hash for Modrinth
    let hash = tokio::task::spawn_blocking({
        let path = path.clone();
        move || calculate_sha1(&path)
    })
    .await
    .map_err(|e| LauncherError::InvalidConfig(format!("Hash calculation failed: {}", e)))?
    .map_err(|e| LauncherError::InvalidConfig(format!("Hash calculation failed: {}", e)))?;

    // Try Modrinth API first
    let modrinth_result = ModrinthClient::get_versions_by_hashes(&[hash.clone()], "sha1").await;

    if let Ok(versions) = modrinth_result {
        if let Some(version) = versions.get(&hash) {
            return Ok(ModVerificationResult {
                verified: true,
                platform: "modrinth".to_string(),
                project_name: Some(version.name.clone()),
                project_slug: Some(version.project_id.clone()),
                version: Some(version.version_number.clone()),
                mod_id,
            });
        }
    }

    // Try CurseForge fingerprint API
    let fingerprint = tokio::task::spawn_blocking({
        let path = path.clone();
        move || compute_curseforge_fingerprint(&path)
    })
    .await
    .ok()
    .flatten();

    if let Some(fp) = fingerprint {
        if let Ok(client) = CurseForgeClient::new() {
            if let Ok(matches) = client.get_fingerprint_matches(&[fp]).await {
                if let Some(match_result) = matches.first() {
                    // Get mod info from CurseForge
                    if let Ok(mod_info) = client.get_mod(match_result.id).await {
                        return Ok(ModVerificationResult {
                            verified: true,
                            platform: "curseforge".to_string(),
                            project_name: Some(mod_info.name),
                            project_slug: Some(mod_info.slug),
                            version: Some(match_result.file.display_name.clone()),
                            mod_id,
                        });
                    }
                }
            }
        }
    }

    // Not found on any platform
    Ok(ModVerificationResult {
        verified: false,
        platform: "unknown".to_string(),
        project_name: None,
        project_slug: None,
        version: None,
        mod_id,
    })
}

/// Batch result for verify_mod_files_batch
#[derive(Debug, Clone, serde::Serialize)]
pub struct BatchVerificationResult {
    pub file_path: String,
    pub result: ModVerificationResult,
}

/// Batch verify multiple mod files in a single API call
#[tauri::command]
async fn verify_mod_files_batch(file_paths: Vec<String>) -> Result<Vec<BatchVerificationResult>> {
    use crate::api::curseforge::CurseForgeClient;
    use crate::api::modrinth::ModrinthClient;
    use crate::error::LauncherError;
    use crate::utils::calculate_sha1;
    use std::collections::HashMap;

    if file_paths.is_empty() {
        return Ok(vec![]);
    }

    log::info!("Batch verifying {} mod files", file_paths.len());

    // Step 1: Calculate SHA-1 hashes for all files in parallel
    let hash_futures: Vec<_> = file_paths
        .iter()
        .map(|path| {
            let path = path.clone();
            async move {
                let p = std::path::PathBuf::from(&path);
                let hash_result = tokio::task::spawn_blocking(move || calculate_sha1(&p))
                    .await
                    .ok()
                    .and_then(|r| r.ok());
                (path, hash_result)
            }
        })
        .collect();

    let hash_results: Vec<(String, Option<String>)> = futures::future::join_all(hash_futures).await;

    // Build hash -> file_path map
    let mut hash_to_path: HashMap<String, String> = HashMap::new();
    let mut results: HashMap<String, ModVerificationResult> = HashMap::new();

    for (path, hash) in &hash_results {
        if let Some(h) = hash {
            hash_to_path.insert(h.clone(), path.clone());
        } else {
            // Failed to hash - mark as error
            results.insert(
                path.clone(),
                ModVerificationResult {
                    verified: false,
                    platform: "error".to_string(),
                    project_name: None,
                    project_slug: None,
                    version: None,
                    mod_id: None,
                },
            );
        }
    }

    // Step 2: Batch lookup on Modrinth
    let hashes: Vec<String> = hash_to_path.keys().cloned().collect();
    if !hashes.is_empty() {
        if let Ok(versions) = ModrinthClient::get_versions_by_hashes(&hashes, "sha1").await {
            for (hash, version) in versions {
                if let Some(path) = hash_to_path.get(&hash) {
                    results.insert(
                        path.clone(),
                        ModVerificationResult {
                            verified: true,
                            platform: "modrinth".to_string(),
                            project_name: Some(version.name.clone()),
                            project_slug: Some(version.project_id.clone()),
                            version: Some(version.version_number.clone()),
                            mod_id: None,
                        },
                    );
                }
            }
        }
    }

    // Step 3: For files not found on Modrinth, try CurseForge batch
    let unverified_paths: Vec<&String> = file_paths
        .iter()
        .filter(|p| !results.contains_key(*p))
        .collect();

    if !unverified_paths.is_empty() {
        // Calculate CurseForge fingerprints
        let fp_futures: Vec<_> = unverified_paths
            .iter()
            .map(|path| {
                let path = (*path).clone();
                async move {
                    let p = std::path::PathBuf::from(&path);
                    let fp =
                        tokio::task::spawn_blocking(move || compute_curseforge_fingerprint(&p))
                            .await
                            .ok()
                            .flatten();
                    (path, fp)
                }
            })
            .collect();

        let fp_results: Vec<(String, Option<u32>)> = futures::future::join_all(fp_futures).await;

        let mut fp_to_path: HashMap<u32, String> = HashMap::new();
        for (path, fp) in &fp_results {
            if let Some(fingerprint) = fp {
                fp_to_path.insert(*fingerprint, path.clone());
            }
        }

        // Batch CurseForge lookup
        if !fp_to_path.is_empty() {
            if let Ok(client) = CurseForgeClient::new() {
                let fingerprints: Vec<u32> = fp_to_path.keys().cloned().collect();
                if let Ok(matches) = client.get_fingerprint_matches(&fingerprints).await {
                    for match_result in matches {
                        // Find the fingerprint that matched
                        for (fp, path) in &fp_to_path {
                            if match_result.fingerprint == *fp {
                                if let Ok(mod_info) = client.get_mod(match_result.id).await {
                                    results.insert(
                                        path.clone(),
                                        ModVerificationResult {
                                            verified: true,
                                            platform: "curseforge".to_string(),
                                            project_name: Some(mod_info.name),
                                            project_slug: Some(mod_info.slug),
                                            version: Some(match_result.file.display_name.clone()),
                                            mod_id: None,
                                        },
                                    );
                                }
                                break;
                            }
                        }
                    }
                }
            }
        }
    }

    // Step 4: Mark remaining as unknown
    for path in &file_paths {
        results
            .entry(path.clone())
            .or_insert(ModVerificationResult {
                verified: false,
                platform: "unknown".to_string(),
                project_name: None,
                project_slug: None,
                version: None,
                mod_id: None,
            });
    }

    // Convert to Vec
    let final_results: Vec<BatchVerificationResult> = file_paths
        .into_iter()
        .filter_map(|path| {
            results.remove(&path).map(|result| BatchVerificationResult {
                file_path: path,
                result,
            })
        })
        .collect();

    log::info!(
        "Batch verification complete: {} verified, {} unknown",
        final_results.iter().filter(|r| r.result.verified).count(),
        final_results.iter().filter(|r| !r.result.verified).count()
    );

    Ok(final_results)
}

/// Compute CurseForge fingerprint (MurmurHash2 with whitespace normalization)
fn compute_curseforge_fingerprint(path: &std::path::Path) -> Option<u32> {
    let content = std::fs::read(path).ok()?;

    // CurseForge fingerprint: normalize whitespace and compute MurmurHash2
    let normalized: Vec<u8> = content
        .into_iter()
        .filter(|&b| b != 9 && b != 10 && b != 13 && b != 32) // Remove whitespace
        .collect();

    Some(murmur2_hash(&normalized, 1))
}

/// MurmurHash2 implementation (seed=1, as used by CurseForge)
fn murmur2_hash(data: &[u8], seed: u32) -> u32 {
    const M: u32 = 0x5bd1e995;
    const R: i32 = 24;

    let len = data.len() as u32;
    let mut h = seed ^ len;

    let chunks = data.chunks_exact(4);
    let remainder = chunks.remainder();

    for chunk in chunks {
        let mut k = u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        k = k.wrapping_mul(M);
        k ^= k >> R;
        k = k.wrapping_mul(M);
        h = h.wrapping_mul(M);
        h ^= k;
    }

    match remainder.len() {
        3 => {
            h ^= (remainder[2] as u32) << 16;
            h ^= (remainder[1] as u32) << 8;
            h ^= remainder[0] as u32;
            h = h.wrapping_mul(M);
        }
        2 => {
            h ^= (remainder[1] as u32) << 8;
            h ^= remainder[0] as u32;
            h = h.wrapping_mul(M);
        }
        1 => {
            h ^= remainder[0] as u32;
            h = h.wrapping_mul(M);
        }
        _ => {}
    }

    h ^= h >> 13;
    h = h.wrapping_mul(M);
    h ^= h >> 15;

    h
}

#[tauri::command]
async fn list_mods(instance_id: String) -> Result<Vec<mods::InstalledMod>> {
    mods::ModManager::list_mods(&instance_id)
}

#[tauri::command]
async fn toggle_mod(instance_id: String, mod_id: i64, enabled: bool) -> Result<()> {
    mods::ModManager::toggle_mod(&instance_id, mod_id, enabled).await
}

#[tauri::command]
async fn toggle_mod_auto_update(instance_id: String, mod_id: i64, auto_update: bool) -> Result<()> {
    mods::ModManager::toggle_mod_auto_update(&instance_id, mod_id, auto_update).await
}

#[tauri::command]
async fn remove_mod(instance_id: String, mod_id: i64) -> Result<()> {
    mods::ModManager::remove_mod(&instance_id, mod_id).await
}

#[tauri::command]
async fn sync_mods_folder(instance_id: String) -> Result<mods::SyncResult> {
    mods::ModManager::sync_mods_with_folder(&instance_id).await
}

/// Start watching mods folder for changes (emits "mods_folder_changed" events)
#[tauri::command]
async fn start_mods_watcher(instance_id: String, app_handle: tauri::AppHandle) -> Result<()> {
    mods::ModManager::start_watching(&instance_id, app_handle).await
}

/// Stop watching mods folder
#[tauri::command]
async fn stop_mods_watcher(instance_id: String) -> Result<()> {
    mods::ModManager::stop_watching(&instance_id).await
}

/// Check if mods folder is being watched
#[tauri::command]
async fn is_watching_mods(instance_id: String) -> bool {
    mods::ModManager::is_watching(&instance_id).await
}

#[tauri::command]
async fn update_mod(instance_id: String, mod_id: i64, app_handle: tauri::AppHandle) -> Result<()> {
    let download_manager = downloader::DownloadManager::new(app_handle)?;
    mods::ModManager::update_mod(&instance_id, mod_id, &download_manager).await
}

#[tauri::command]
async fn bulk_toggle_mods(
    instance_id: String,
    mod_ids: Vec<i64>,
    enabled: bool,
) -> Result<Vec<i64>> {
    mods::ModManager::bulk_toggle_mods(&instance_id, &mod_ids, enabled).await
}

#[tauri::command]
async fn bulk_remove_mods(instance_id: String, mod_ids: Vec<i64>) -> Result<Vec<i64>> {
    mods::ModManager::bulk_remove_mods(&instance_id, &mod_ids).await
}

#[tauri::command]
async fn bulk_toggle_auto_update(
    instance_id: String,
    mod_ids: Vec<i64>,
    auto_update: bool,
) -> Result<Vec<i64>> {
    mods::ModManager::bulk_toggle_auto_update(&instance_id, &mod_ids, auto_update).await
}

#[tauri::command]
async fn check_mod_dependencies(instance_id: String) -> Result<Vec<mods::ModConflict>> {
    mods::ModManager::check_dependencies(&instance_id)
}

/// Превентивная проверка зависимостей перед запуском экземпляра
#[tauri::command]
async fn pre_launch_check(instance_id: String) -> Result<mods::PreLaunchCheckResult> {
    mods::ModManager::pre_launch_check(&instance_id)
}

/// Получить граф зависимостей для визуализации
#[tauri::command]
async fn get_dependency_graph(instance_id: String) -> Result<mods::DependencyGraph> {
    mods::ModManager::get_dependency_graph(&instance_id)
}

/// Clean up duplicate mods from the database
#[tauri::command]
fn cleanup_duplicate_mods(instance_id: String) -> Result<usize> {
    mods::ModManager::cleanup_duplicate_mods(&instance_id)
}

/// Clear update check cache to allow re-checking
#[tauri::command]
fn clear_update_cache(instance_id: String) -> Result<usize> {
    mods::ModManager::clear_update_cache(&instance_id)
}

/// Анализ безопасности удаления мода
#[tauri::command]
async fn analyze_mod_removal(
    instance_id: String,
    mod_slug: String,
) -> Result<mods::ModRemovalAnalysis> {
    mods::ModManager::analyze_mod_removal(&instance_id, &mod_slug)
}

/// Get the full path to a mod file
#[tauri::command]
fn get_mod_file_path(instance_id: String, file_name: String) -> Result<String> {
    let mods_dir = paths::instance_mods_dir(&instance_id);
    let file_path = mods_dir.join(&file_name);
    Ok(file_path.to_string_lossy().to_string())
}

/// Проверяет, нужно ли обновлять данные о зависимостях
#[tauri::command]
fn needs_dependency_enrichment(instance_id: String) -> Result<bool> {
    mods::ModManager::needs_dependency_enrichment(&instance_id)
}

/// Check if enrichment is needed (based on file hashes)
/// Returns true if enrichment should run, false if cached data is still valid
#[tauri::command]
fn check_enrichment_needed(instance_id: String) -> Result<bool> {
    let (needs_enrichment, _hash) = mods::ModManager::check_enrichment_needed(&instance_id)?;
    Ok(needs_enrichment)
}

/// Обогащение данных о модах через API (batch-запрос)
/// Загружает зависимости для всех модов из Modrinth
/// Now with built-in hash check - skips if already enriched with same mods
#[tauri::command]
async fn enrich_mod_dependencies(instance_id: String) -> Result<mods::EnrichmentResult> {
    mods::ModManager::enrich_mod_dependencies(&instance_id).await
}

/// Force enrich dependencies - clears cache and re-fetches from API
/// Used when user manually requests refresh
#[tauri::command]
async fn force_enrich_mod_dependencies(instance_id: String) -> Result<mods::EnrichmentResult> {
    mods::ModManager::force_enrich_mod_dependencies(&instance_id).await
}

/// Incremental verification: only verify specified mod IDs
/// Used after sync to verify only newly added mods
#[tauri::command]
async fn verify_mods_by_ids(
    instance_id: String,
    mod_ids: Vec<i64>,
) -> Result<Vec<mods::ModVerifyResult>> {
    mods::ModManager::verify_mods_by_ids(&instance_id, &mod_ids).await
}

/// Incremental enrichment: only enrich specified mod IDs
/// Used after sync to enrich only newly added mods
#[tauri::command]
async fn enrich_mods_by_ids(
    instance_id: String,
    mod_ids: Vec<i64>,
) -> Result<mods::EnrichmentResult> {
    mods::ModManager::enrich_mods_by_ids(&instance_id, &mod_ids).await
}

/// Предсказание конфликтов ДО установки мода
#[tauri::command]
async fn predict_mod_conflicts(
    mod_slug: String,
    instance_id: String,
    loader: String,
) -> Result<conflict_predictor::ConflictPredictionResult> {
    // Получаем список установленных модов
    let installed_mods = mods::ModManager::list_mods(&instance_id)?;
    let installed_slugs: Vec<String> = installed_mods
        .iter()
        .filter(|m| m.enabled)
        .map(|m| m.slug.clone())
        .collect();

    // Предсказываем конфликты
    let result = conflict_predictor::predict_conflicts(&mod_slug, &installed_slugs, &loader);

    Ok(result)
}

/// Получить список модов, конфликтующих с указанным
#[tauri::command]
fn get_conflicting_mods(mod_slug: String) -> Vec<String> {
    conflict_predictor::get_conflicting_mods(&mod_slug)
}

/// Проверить, есть ли известные проблемы с модом
#[tauri::command]
fn has_mod_known_issues(mod_slug: String) -> bool {
    conflict_predictor::has_known_issues(&mod_slug)
}

/// Получить рекомендации модов на основе установленных
#[tauri::command]
async fn get_mod_recommendations(
    instance_id: String,
    minecraft_version: String,
    loader: String,
    limit: Option<usize>,
) -> Result<Vec<recommendations::ModRecommendation>> {
    let config = recommendations::RecommendationConfig {
        limit: limit.unwrap_or(10),
        minecraft_version,
        loader,
    };
    recommendations::RecommendationEngine::get_recommendations(&instance_id, config).await
}

#[tauri::command]
async fn resolve_dependencies(
    instance_id: String,
    minecraft_version: String,
    loader: String,
    app_handle: tauri::AppHandle,
) -> Result<Vec<mods::InstalledMod>> {
    let download_manager = downloader::DownloadManager::new(app_handle)?;
    mods::ModManager::auto_resolve_dependencies(
        &instance_id,
        &minecraft_version,
        &loader,
        &download_manager,
    )
    .await
}

// ========== Config Editor ==========

#[tauri::command]
async fn list_config_files(
    instance_id: String,
    subdir: String,
) -> Result<Vec<config_editor::ConfigFile>> {
    config_editor::ConfigManager::list_config_files(&instance_id, &subdir).await
}

#[tauri::command]
async fn read_config_file(
    instance_id: String,
    relative_path: String,
) -> Result<config_editor::ConfigContent> {
    config_editor::ConfigManager::read_config_file(&instance_id, &relative_path).await
}

#[tauri::command]
async fn write_config_file(
    instance_id: String,
    relative_path: String,
    content: String,
) -> Result<()> {
    config_editor::ConfigManager::write_config_file(&instance_id, &relative_path, &content).await
}

#[tauri::command]
async fn backup_config_file(instance_id: String, relative_path: String) -> Result<String> {
    config_editor::ConfigManager::backup_config(&instance_id, &relative_path).await
}

// ========== File Browser ==========

#[derive(Debug, Clone, serde::Serialize)]
struct FileEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    modified: String,
}

#[tauri::command]
async fn browse_instance_files(instance_id: String, subpath: String) -> Result<Vec<FileEntry>> {
    use crate::paths::get_base_dir;

    let base_dir = get_base_dir().join("instances");
    let target_dir = if subpath.is_empty() {
        base_dir.join(&instance_id)
    } else {
        base_dir.join(&instance_id).join(&subpath)
    };

    let canonical_base = base_dir.join(&instance_id).canonicalize().map_err(|_| {
        error::LauncherError::InvalidConfig("Instance directory not found".to_string())
    })?;

    let canonical_target = target_dir
        .canonicalize()
        .map_err(|_| error::LauncherError::InvalidConfig("Path not found".to_string()))?;

    if !canonical_target.starts_with(&canonical_base) {
        return Err(error::LauncherError::InvalidConfig(
            "Path traversal detected".to_string(),
        ));
    }

    let mut entries = Vec::new();
    let mut dir_entries = tokio::fs::read_dir(&target_dir).await.map_err(|e| {
        error::LauncherError::Io(std::io::Error::new(e.kind(), "Failed to read directory"))
    })?;

    while let Some(entry) = dir_entries.next_entry().await.map_err(|e| {
        error::LauncherError::Io(std::io::Error::new(e.kind(), "Failed to read entry"))
    })? {
        let path = entry.path();
        let metadata = entry.metadata().await.map_err(|e| {
            error::LauncherError::Io(std::io::Error::new(e.kind(), "Failed to read metadata"))
        })?;

        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();

        let relative_path = path
            .strip_prefix(&base_dir.join(&instance_id))
            .unwrap_or(&path)
            .to_string_lossy()
            .to_string();

        let modified = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .and_then(|t| chrono::DateTime::from_timestamp(t as i64, 0))
            .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
            .unwrap_or_default();

        entries.push(FileEntry {
            name,
            path: relative_path,
            is_dir: metadata.is_dir(),
            size: metadata.len(),
            modified,
        });
    }

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });

    Ok(entries)
}

#[tauri::command]
async fn search_instance_files(
    instance_id: String,
    query: String,
    use_regex: bool,
) -> Result<Vec<FileEntry>> {
    use crate::paths::get_base_dir;
    use regex::Regex;

    let base_dir = get_base_dir().join("instances").join(&instance_id);
    let canonical_base = base_dir.canonicalize().map_err(|_| {
        error::LauncherError::InvalidConfig("Instance directory not found".to_string())
    })?;

    // Compile regex if needed
    let regex_pattern =
        if use_regex {
            Some(Regex::new(&query).map_err(|e| {
                error::LauncherError::InvalidConfig(format!("Invalid regex: {}", e))
            })?)
        } else {
            None
        };

    let mut results = Vec::new();
    let query_lower = query.to_lowercase();

    // Recursive file walker
    async fn walk_dir(
        dir: &std::path::Path,
        base: &std::path::Path,
        query: &str,
        regex_pattern: &Option<Regex>,
        results: &mut Vec<FileEntry>,
        instance_id: &str,
    ) -> std::io::Result<()> {
        let mut entries = tokio::fs::read_dir(dir).await?;

        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            let metadata = entry.metadata().await?;

            // Skip hidden directories and common cache/log folders
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

            if name.starts_with('.') || matches!(name, "logs" | "crash-reports" | "cache") {
                continue;
            }

            if metadata.is_dir() {
                // Recursively search subdirectories
                if let Err(e) = Box::pin(walk_dir(
                    &path,
                    base,
                    query,
                    regex_pattern,
                    results,
                    instance_id,
                ))
                .await
                {
                    eprintln!("Failed to read subdirectory {:?}: {}", path, e);
                }
            } else {
                // Check if file matches query
                let matches = if let Some(regex) = regex_pattern {
                    regex.is_match(name)
                } else {
                    name.to_lowercase().contains(query)
                };

                if matches {
                    let relative_path = path
                        .strip_prefix(base)
                        .unwrap_or(&path)
                        .to_string_lossy()
                        .to_string();

                    let modified = metadata
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .and_then(|t| chrono::DateTime::from_timestamp(t as i64, 0))
                        .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
                        .unwrap_or_default();

                    results.push(FileEntry {
                        name: name.to_string(),
                        path: relative_path,
                        is_dir: false,
                        size: metadata.len(),
                        modified,
                    });
                }
            }
        }

        Ok(())
    }

    walk_dir(
        &canonical_base,
        &canonical_base,
        &query_lower,
        &regex_pattern,
        &mut results,
        &instance_id,
    )
    .await
    .map_err(|e| error::LauncherError::Io(std::io::Error::new(e.kind(), "Search failed")))?;

    // Sort results by relevance (exact matches first, then alphabetically)
    results.sort_by(|a, b| a.name.cmp(&b.name));

    Ok(results)
}

#[tauri::command]
async fn read_instance_file(instance_id: String, relative_path: String) -> Result<String> {
    use crate::paths::get_base_dir;

    let base_dir = get_base_dir().join("instances");
    let file_path = base_dir.join(&instance_id).join(&relative_path);

    let canonical_base = base_dir.join(&instance_id).canonicalize().map_err(|_| {
        error::LauncherError::InvalidConfig("Instance directory not found".to_string())
    })?;

    let canonical_file = file_path
        .canonicalize()
        .map_err(|_| error::LauncherError::InvalidConfig("File not found".to_string()))?;

    if !canonical_file.starts_with(&canonical_base) {
        return Err(error::LauncherError::InvalidConfig(
            "Path traversal detected".to_string(),
        ));
    }

    tokio::fs::read_to_string(&file_path)
        .await
        .map_err(|e| error::LauncherError::Io(std::io::Error::new(e.kind(), "Failed to read file")))
}

#[tauri::command]
async fn write_instance_file(
    instance_id: String,
    relative_path: String,
    content: String,
) -> Result<()> {
    use crate::paths::get_base_dir;

    let base_dir = get_base_dir().join("instances");
    let file_path = base_dir.join(&instance_id).join(&relative_path);

    let canonical_base = base_dir.join(&instance_id).canonicalize().map_err(|_| {
        error::LauncherError::InvalidConfig("Instance directory not found".to_string())
    })?;

    if let Some(parent) = file_path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| {
            error::LauncherError::Io(std::io::Error::new(
                e.kind(),
                "Failed to create directories",
            ))
        })?;
    }

    let canonical_file = file_path.canonicalize().or_else(|_| {
        let parent = file_path
            .parent()
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "Invalid path"))?;
        let file_name = file_path
            .file_name()
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "Invalid file name"))?;
        parent.canonicalize().map(|p| p.join(file_name))
    })?;

    if !canonical_file.starts_with(&canonical_base) {
        return Err(error::LauncherError::InvalidConfig(
            "Path traversal detected".to_string(),
        ));
    }

    tokio::fs::write(&file_path, content).await.map_err(|e| {
        error::LauncherError::Io(std::io::Error::new(e.kind(), "Failed to write file"))
    })
}

#[tauri::command]
async fn delete_instance_file(instance_id: String, relative_path: String) -> Result<()> {
    use crate::paths::get_base_dir;

    let base_dir = get_base_dir().join("instances");
    let file_path = base_dir.join(&instance_id).join(&relative_path);

    let canonical_base = base_dir.join(&instance_id).canonicalize().map_err(|_| {
        error::LauncherError::InvalidConfig("Instance directory not found".to_string())
    })?;

    let canonical_file = file_path
        .canonicalize()
        .map_err(|_| error::LauncherError::InvalidConfig("File not found".to_string()))?;

    if !canonical_file.starts_with(&canonical_base) {
        return Err(error::LauncherError::InvalidConfig(
            "Path traversal detected".to_string(),
        ));
    }

    if canonical_file.is_dir() {
        tokio::fs::remove_dir_all(&file_path).await
    } else {
        tokio::fs::remove_file(&file_path).await
    }
    .map_err(|e| error::LauncherError::Io(std::io::Error::new(e.kind(), "Failed to delete")))
}

/// Rename instance file or directory
#[tauri::command]
async fn rename_instance_file(
    instance_id: String,
    relative_path: String,
    new_name: String,
) -> Result<()> {
    use crate::paths::get_base_dir;

    let base_dir = get_base_dir().join("instances");
    let old_path = base_dir.join(&instance_id).join(&relative_path);

    let canonical_base = base_dir.join(&instance_id).canonicalize().map_err(|_| {
        error::LauncherError::InvalidConfig("Instance directory not found".to_string())
    })?;

    let canonical_old = old_path
        .canonicalize()
        .map_err(|_| error::LauncherError::InvalidConfig("File not found".to_string()))?;

    if !canonical_old.starts_with(&canonical_base) {
        return Err(error::LauncherError::InvalidConfig(
            "Path traversal detected".to_string(),
        ));
    }

    // Build new path
    let parent = canonical_old.parent().ok_or_else(|| {
        error::LauncherError::InvalidConfig("Cannot rename root directory".to_string())
    })?;

    let new_path = parent.join(&new_name);

    // Validate new path is also within instance directory
    if !new_path.starts_with(&canonical_base) {
        return Err(error::LauncherError::InvalidConfig(
            "Invalid new name".to_string(),
        ));
    }

    // Check if destination already exists
    if tokio::fs::try_exists(&new_path).await.unwrap_or(false) {
        return Err(error::LauncherError::InvalidConfig(
            "File with this name already exists".to_string(),
        ));
    }

    tokio::fs::rename(&canonical_old, &new_path)
        .await
        .map_err(|e| error::LauncherError::Io(std::io::Error::new(e.kind(), "Failed to rename")))
}

/// Copy instance file or directory
#[tauri::command]
async fn copy_instance_file(
    instance_id: String,
    relative_path: String,
    new_name: String,
) -> Result<()> {
    use crate::paths::get_base_dir;

    let base_dir = get_base_dir().join("instances");
    let src_path = base_dir.join(&instance_id).join(&relative_path);

    let canonical_base = base_dir.join(&instance_id).canonicalize().map_err(|_| {
        error::LauncherError::InvalidConfig("Instance directory not found".to_string())
    })?;

    let canonical_src = src_path
        .canonicalize()
        .map_err(|_| error::LauncherError::InvalidConfig("File not found".to_string()))?;

    if !canonical_src.starts_with(&canonical_base) {
        return Err(error::LauncherError::InvalidConfig(
            "Path traversal detected".to_string(),
        ));
    }

    // Build destination path
    let parent = canonical_src.parent().ok_or_else(|| {
        error::LauncherError::InvalidConfig("Cannot copy root directory".to_string())
    })?;

    let dest_path = parent.join(&new_name);

    // Validate destination is also within instance directory
    if !dest_path.starts_with(&canonical_base) {
        return Err(error::LauncherError::InvalidConfig(
            "Invalid destination name".to_string(),
        ));
    }

    // Check if destination already exists
    if tokio::fs::try_exists(&dest_path).await.unwrap_or(false) {
        return Err(error::LauncherError::InvalidConfig(
            "File with this name already exists".to_string(),
        ));
    }

    // Copy file or directory
    if canonical_src.is_dir() {
        copy_dir_recursive(canonical_src.to_path_buf(), dest_path.clone()).await
    } else {
        tokio::fs::copy(&canonical_src, &dest_path)
            .await
            .map(|_| ())
    }
    .map_err(|e| error::LauncherError::Io(std::io::Error::new(e.kind(), "Failed to copy")))
}

/// Recursive directory copy helper
fn copy_dir_recursive(
    src: std::path::PathBuf,
    dest: std::path::PathBuf,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = std::io::Result<()>> + Send>> {
    Box::pin(async move {
        tokio::fs::create_dir_all(&dest).await?;

        let mut entries = tokio::fs::read_dir(&src).await?;
        while let Some(entry) = entries.next_entry().await? {
            let src_path = entry.path();
            let dest_path = dest.join(entry.file_name());

            if src_path.is_dir() {
                copy_dir_recursive(src_path, dest_path).await?;
            } else {
                tokio::fs::copy(&src_path, &dest_path).await?;
            }
        }

        Ok(())
    })
}

// ========== Mod Profiles ==========

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct ModProfile {
    id: String,
    name: String,
    description: Option<String>,
    instance_id: String,
    enabled_mods: Vec<i64>,
    created_at: String,
}

#[tauri::command]
fn save_mod_profile(
    instance_id: String,
    name: String,
    description: Option<String>,
    enabled_mod_ids: Vec<i64>,
) -> Result<String> {
    let conn = db::get_db_conn()?;
    let profile_id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    conn.execute(
        "CREATE TABLE IF NOT EXISTS mod_profiles (
            id TEXT PRIMARY KEY,
            instance_id TEXT NOT NULL,
            name TEXT NOT NULL,
            description TEXT,
            enabled_mods TEXT NOT NULL,
            created_at TEXT NOT NULL
        )",
        [],
    )?;

    conn.execute(
        "INSERT INTO mod_profiles (id, instance_id, name, description, enabled_mods, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            profile_id,
            instance_id,
            name,
            description,
            serde_json::to_string(&enabled_mod_ids).unwrap_or_default(),
            now,
        ],
    )?;

    log::info!("Saved mod profile: {} for instance {}", name, instance_id);
    Ok(profile_id)
}

#[tauri::command]
fn list_mod_profiles(instance_id: String) -> Result<Vec<ModProfile>> {
    let conn = db::get_db_conn()?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS mod_profiles (
            id TEXT PRIMARY KEY,
            instance_id TEXT NOT NULL,
            name TEXT NOT NULL,
            description TEXT,
            enabled_mods TEXT NOT NULL,
            created_at TEXT NOT NULL
        )",
        [],
    )?;

    let mut stmt = conn.prepare(
        "SELECT id, name, description, instance_id, enabled_mods, created_at
         FROM mod_profiles WHERE instance_id = ?1 ORDER BY created_at DESC",
    )?;

    let profiles = stmt
        .query_map([&instance_id], |row| {
            let enabled_mods_json: String = row.get(4)?;
            let enabled_mods: Vec<i64> =
                serde_json::from_str(&enabled_mods_json).unwrap_or_default();

            Ok(ModProfile {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                instance_id: row.get(3)?,
                enabled_mods,
                created_at: row.get(5)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    Ok(profiles)
}

#[tauri::command]
async fn apply_mod_profile(instance_id: String, profile_id: String) -> Result<()> {
    let conn = db::get_db_conn()?;

    let profile: ModProfile = conn
        .query_row(
            "SELECT id, name, description, instance_id, enabled_mods, created_at
         FROM mod_profiles WHERE id = ?1",
            [&profile_id],
            |row| {
                let enabled_mods_json: String = row.get(4)?;
                let enabled_mods: Vec<i64> =
                    serde_json::from_str(&enabled_mods_json).unwrap_or_default();

                Ok(ModProfile {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    description: row.get(2)?,
                    instance_id: row.get(3)?,
                    enabled_mods,
                    created_at: row.get(5)?,
                })
            },
        )
        .map_err(|_| error::LauncherError::NotFound("Profile not found".to_string()))?;

    let all_mods = mods::ModManager::list_mods(&instance_id)?;

    for mod_item in &all_mods {
        if mod_item.enabled {
            let _ = mods::ModManager::toggle_mod(&instance_id, mod_item.id, false).await;
        }
    }

    for mod_id in profile.enabled_mods {
        let _ = mods::ModManager::toggle_mod(&instance_id, mod_id, true).await;
    }

    log::info!(
        "Applied mod profile {} to instance {}",
        profile.name,
        instance_id
    );
    Ok(())
}

#[tauri::command]
fn delete_mod_profile(profile_id: String) -> Result<()> {
    let conn = db::get_db_conn()?;

    let deleted = conn.execute("DELETE FROM mod_profiles WHERE id = ?1", [&profile_id])?;

    if deleted == 0 {
        return Err(error::LauncherError::NotFound(
            "Profile not found".to_string(),
        ));
    }

    Ok(())
}

/// Export mod profile as JSON string
#[tauri::command]
fn export_mod_profile(profile_id: String) -> Result<String> {
    let conn = db::get_db_conn()?;

    let mut stmt =
        conn.prepare("SELECT name, description, enabled_mods FROM mod_profiles WHERE id = ?1")?;

    let profile = stmt
        .query_row([&profile_id], |row| {
            Ok(serde_json::json!({
                "name": row.get::<_, String>(0)?,
                "description": row.get::<_, Option<String>>(1)?,
                "enabled_mods": row.get::<_, String>(2)?,
                "version": "1.0",
                "exported_at": chrono::Local::now().to_rfc3339(),
            }))
        })
        .map_err(|_| error::LauncherError::NotFound("Profile not found".to_string()))?;

    serde_json::to_string_pretty(&profile)
        .map_err(|e| error::LauncherError::InvalidConfig(format!("Failed to serialize profile: {}", e)))
}

/// Import mod profile from JSON string
#[tauri::command]
fn import_mod_profile(instance_id: String, json_data: String) -> Result<String> {
    let data: serde_json::Value = serde_json::from_str(&json_data)
        .map_err(|e| error::LauncherError::InvalidConfig(format!("Invalid JSON: {}", e)))?;

    let name = data["name"]
        .as_str()
        .ok_or_else(|| error::LauncherError::InvalidConfig("Missing 'name' field".to_string()))?;
    let description = data["description"].as_str();
    let enabled_mods_str = data["enabled_mods"].as_str().ok_or_else(|| {
        error::LauncherError::InvalidConfig("Missing 'enabled_mods' field".to_string())
    })?;

    // Валидация JSON
    let _: Vec<i64> = serde_json::from_str(enabled_mods_str)
        .map_err(|e| error::LauncherError::InvalidConfig(format!("Invalid enabled_mods: {}", e)))?;

    let conn = db::get_db_conn()?;
    let profile_id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Local::now().to_rfc3339();

    conn.execute(
        "INSERT INTO mod_profiles (id, instance_id, name, description, enabled_mods, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            profile_id,
            instance_id,
            name,
            description,
            enabled_mods_str,
            now,
            now,
        ],
    )?;

    Ok(profile_id)
}

// ========== Modpacks ==========

#[tauri::command]
async fn search_modpacks(
    query: String,
    minecraft_version: Option<String>,
    loader: Option<String>,
    source: String,
    limit: u32,
    offset: u32,
) -> Result<modpacks::ModpackSearchResponse> {
    match source.as_str() {
        "modrinth" => {
            modpacks::ModpackManager::search_modrinth(
                &query,
                minecraft_version.as_deref(),
                loader.as_deref(),
                limit,
                offset,
            )
            .await
        }
        "curseforge" => {
            modpacks::ModpackManager::search_curseforge(
                &query,
                minecraft_version.as_deref(),
                loader.as_deref(),
                limit,
                offset,
            )
            .await
        }
        _ => Err(error::LauncherError::InvalidConfig(format!(
            "Unknown source: {}",
            source
        ))),
    }
}

#[tauri::command]
async fn get_modpack_versions(
    source: String,
    project_id: String,
    minecraft_version: Option<String>,
    loader: Option<String>,
) -> Result<Vec<modpacks::ModpackVersionInfo>> {
    match source.as_str() {
        "modrinth" => {
            modpacks::ModpackManager::get_modrinth_versions(
                &project_id,
                minecraft_version.as_deref(),
                loader.as_deref(),
            )
            .await
        }
        "curseforge" => {
            modpacks::ModpackManager::get_curseforge_versions(
                &project_id,
                minecraft_version.as_deref(),
                loader.as_deref(),
            )
            .await
        }
        _ => Err(error::LauncherError::InvalidConfig(
            "Unknown source".to_string(),
        )),
    }
}

#[tauri::command]
async fn get_modpack_details(
    source: String,
    project_id: String,
) -> Result<modpacks::ModpackDetails> {
    match source.as_str() {
        "modrinth" => modpacks::ModpackManager::get_modrinth_details(&project_id).await,
        "curseforge" => modpacks::ModpackManager::get_curseforge_details(&project_id).await,
        _ => Err(error::LauncherError::InvalidConfig(
            "Unknown source".to_string(),
        )),
    }
}

#[tauri::command]
async fn install_modpack(
    source: String,
    project_id: String,
    version_id: Option<String>,
    instance_name: String,
    app_handle: tauri::AppHandle,
) -> Result<String> {
    let download_manager = downloader::DownloadManager::new(app_handle.clone())?;

    match source.as_str() {
        "modrinth" => {
            modpacks::ModpackManager::install_from_modrinth(
                project_id,
                version_id,
                instance_name,
                download_manager,
                app_handle,
            )
            .await
        }
        "curseforge" => {
            let pid: u64 = project_id.parse().map_err(|_| {
                error::LauncherError::InvalidConfig("Invalid CurseForge project ID".to_string())
            })?;
            let fid = version_id.and_then(|v| v.parse().ok());

            modpacks::ModpackManager::install_from_curseforge(
                pid,
                fid,
                instance_name,
                download_manager,
                app_handle,
            )
            .await
        }
        _ => Err(error::LauncherError::InvalidConfig(format!(
            "Unknown source: {}",
            source
        ))),
    }
}

#[tauri::command]
async fn install_modpack_from_file(
    file_path: String,
    instance_name: String,
    app_handle: tauri::AppHandle,
) -> Result<String> {
    let download_manager = downloader::DownloadManager::new(app_handle.clone())?;
    let path = std::path::PathBuf::from(file_path);

    modpacks::ModpackManager::install_from_file(path, instance_name, download_manager, app_handle)
        .await
}

/// Install from standalone manifest.json (CurseForge) or modrinth.index.json (Modrinth)
#[tauri::command]
async fn install_modpack_from_manifest(
    file_path: String,
    instance_name: String,
    app_handle: tauri::AppHandle,
) -> Result<String> {
    let download_manager = downloader::DownloadManager::new(app_handle.clone())?;
    let path = std::path::PathBuf::from(file_path);

    modpacks::ModpackManager::install_from_standalone_manifest(
        path,
        instance_name,
        download_manager,
        app_handle,
    )
    .await
}

/// Preview a standalone manifest file (detect format and return info)
#[tauri::command]
async fn preview_manifest_file(file_path: String) -> Result<serde_json::Value> {
    let path = std::path::PathBuf::from(&file_path);
    let (format, content) = modpacks::install::parse_standalone_manifest(&path).await?;

    // Parse based on format
    match format {
        modpacks::install::ManifestFormat::Modrinth => {
            let index: modpacks::ModrinthModpackIndex = serde_json::from_str(&content)?;
            let loader = if index.dependencies.fabric_loader.is_some() {
                "fabric"
            } else if index.dependencies.quilt_loader.is_some() {
                "quilt"
            } else if index.dependencies.forge.is_some() {
                "forge"
            } else if index.dependencies.neoforge.is_some() {
                "neoforge"
            } else {
                "vanilla"
            };

            Ok(serde_json::json!({
                "format": "modrinth",
                "name": index.name,
                "version": index.version_id,
                "minecraft_version": index.dependencies.minecraft,
                "loader": loader,
                "mods_count": index.files.iter().filter(|f| f.path.starts_with("mods/")).count(),
                "total_files": index.files.len(),
            }))
        }
        modpacks::install::ManifestFormat::CurseForge => {
            let manifest: modpacks::CurseForgeManifest = serde_json::from_str(&content)?;
            let loader = manifest
                .minecraft
                .mod_loaders
                .first()
                .map(|l| l.id.split('-').next().unwrap_or("vanilla"))
                .unwrap_or("vanilla");

            Ok(serde_json::json!({
                "format": "curseforge",
                "name": manifest.name,
                "version": manifest.version,
                "author": manifest.author,
                "minecraft_version": manifest.minecraft.version,
                "loader": loader,
                "mods_count": manifest.files.len(),
            }))
        }
    }
}

/// Re-import manifest for an existing instance to download missing mods
#[tauri::command]
async fn reimport_manifest(
    instance_id: String,
    file_path: String,
    app_handle: tauri::AppHandle,
) -> Result<modpacks::install::ReimportResult> {
    let download_manager = downloader::DownloadManager::new(app_handle.clone())?;
    let path = std::path::PathBuf::from(file_path);

    modpacks::ModpackManager::reimport_manifest(
        instance_id,
        path,
        download_manager,
        app_handle,
    )
    .await
}

#[tauri::command]
async fn preview_modpack_file(file_path: String) -> Result<modpacks::ModpackFilePreview> {
    let path = std::path::PathBuf::from(file_path);
    modpacks::ModpackManager::preview_file(&path).await
}

#[tauri::command]
async fn preview_modpack_detailed(file_path: String) -> Result<modpacks::ModpackPreview> {
    modpacks::preview::get_modpack_preview(std::path::Path::new(&file_path)).await
}

#[tauri::command]
async fn compare_modpacks(path1: String, path2: String) -> Result<modpacks::ModpackComparison> {
    let p1 = std::path::PathBuf::from(path1);
    let p2 = std::path::PathBuf::from(path2);
    modpacks::ModpackManager::compare_modpacks(&p1, &p2).await
}

#[tauri::command]
async fn read_modpack_file_content(
    archive_path: String,
    file_path: String,
) -> Result<Option<String>> {
    let path = std::path::PathBuf::from(archive_path);
    modpacks::ModpackManager::read_file_from_archive(&path, &file_path).await
}

/// Создать патч из результата сравнения модпаков
#[tauri::command]
fn create_modpack_patch(
    comparison: modpacks::ModpackComparison,
    base_name: String,
    minecraft_version: String,
    loader: String,
    loader_version: Option<String>,
    description: String,
    author: Option<String>,
    include_configs: bool,
) -> Result<modpacks::ModpackPatch> {
    let base_info = modpacks::PatchBaseInfo {
        name: base_name,
        minecraft_version,
        loader,
        loader_version,
        source: None,
        project_id: None,
        version_id: None,
    };
    modpacks::patch::create_patch_from_comparison(
        &comparison,
        base_info,
        description,
        author,
        include_configs,
    )
}

/// Сохранить патч в файл
#[tauri::command]
fn save_modpack_patch(patch: modpacks::ModpackPatch, path: String) -> Result<()> {
    let p = std::path::PathBuf::from(path);
    modpacks::patch::save_patch(&patch, &p)
}

/// Загрузить патч из файла
#[tauri::command]
fn load_modpack_patch(path: String) -> Result<modpacks::ModpackPatch> {
    let p = std::path::PathBuf::from(path);
    modpacks::patch::load_patch(&p)
}

/// Предпросмотр применения патча
#[tauri::command]
async fn preview_modpack_patch(
    patch: modpacks::ModpackPatch,
    instance_id: String,
) -> Result<modpacks::PatchPreview> {
    let instance = instances::lifecycle::get_instance(instance_id).await?;
    let instance_dir = std::path::PathBuf::from(&instance.dir);
    modpacks::patch::preview_patch(&patch, &instance_dir).await
}

/// Применить патч к экземпляру
#[tauri::command]
async fn apply_modpack_patch(
    patch: modpacks::ModpackPatch,
    instance_id: String,
    app_handle: tauri::AppHandle,
) -> Result<modpacks::PatchApplyResult> {
    let instance = instances::lifecycle::get_instance(instance_id.clone()).await?;
    let instance_dir = std::path::PathBuf::from(&instance.dir);
    modpacks::patch::apply_patch(&patch, &instance_id, &instance_dir, app_handle).await
}

/// Проверить совместимость патча с экземпляром
#[tauri::command]
async fn check_patch_compatibility(
    patch: modpacks::ModpackPatch,
    instance_id: String,
) -> Result<modpacks::PatchCompatibilityResult> {
    let instance = instances::lifecycle::get_instance(instance_id).await?;
    let instance_dir = std::path::PathBuf::from(&instance.dir);

    let applied_patches = modpacks::patch::load_applied_patches(&instance_dir);

    let result = modpacks::patch::check_patch_compatibility(
        &patch,
        &instance.version,
        instance.loader.as_str(),
        instance.loader_version.as_deref(),
        &applied_patches,
    );

    Ok(result)
}

/// Получить список применённых патчей для экземпляра
#[tauri::command]
async fn get_applied_patches(instance_id: String) -> Result<Vec<modpacks::AppliedPatchRecord>> {
    let instance = instances::lifecycle::get_instance(instance_id).await?;
    let instance_dir = std::path::PathBuf::from(&instance.dir);
    Ok(modpacks::patch::load_applied_patches(&instance_dir))
}

/// Добавить содержимое конфигов в патч
#[tauri::command]
fn populate_patch_configs(
    mut patch: modpacks::ModpackPatch,
    source_dir: String,
) -> Result<modpacks::ModpackPatch> {
    let dir = std::path::PathBuf::from(source_dir);
    modpacks::patch::populate_config_contents(&mut patch, &dir)?;
    Ok(patch)
}

// ========== Instance Snapshot System ==========

/// Создать снимок состояния экземпляра для отслеживания изменений
/// Использует async параллельное хеширование для скорости
#[tauri::command]
async fn create_instance_snapshot(instance_id: String) -> Result<modpacks::InstanceSnapshot> {
    let instance = instances::lifecycle::get_instance(instance_id.clone()).await?;
    let instance_dir = std::path::PathBuf::from(&instance.dir);

    // Используем async версию с параллельным хешированием (8x быстрее)
    let snapshot = modpacks::patch::create_instance_snapshot_async(
        &instance_id,
        &instance.name,
        &instance.version,
        instance.loader.as_str(),
        instance.loader_version.as_deref(),
        &instance_dir,
    )
    .await?;

    // Save snapshot to instance directory
    modpacks::patch::save_snapshot(&instance_dir, &snapshot)?;

    Ok(snapshot)
}

/// Получить текущий снимок экземпляра
#[tauri::command]
async fn get_instance_snapshot(instance_id: String) -> Result<Option<modpacks::InstanceSnapshot>> {
    let instance = instances::lifecycle::get_instance(instance_id).await?;
    let instance_dir = std::path::PathBuf::from(&instance.dir);
    Ok(modpacks::patch::load_snapshot(&instance_dir))
}

/// Удалить снимок экземпляра
#[tauri::command]
async fn delete_instance_snapshot(instance_id: String) -> Result<()> {
    let instance = instances::lifecycle::get_instance(instance_id).await?;
    let instance_dir = std::path::PathBuf::from(&instance.dir);
    modpacks::patch::delete_snapshot(&instance_dir)
}

/// Определить изменения в экземпляре по сравнению со снимком
#[tauri::command]
async fn detect_instance_changes(instance_id: String) -> Result<Option<modpacks::InstanceChanges>> {
    let instance = instances::lifecycle::get_instance(instance_id).await?;
    let instance_dir = std::path::PathBuf::from(&instance.dir);

    // Load existing snapshot
    let snapshot = match modpacks::patch::load_snapshot(&instance_dir) {
        Some(s) => s,
        None => return Ok(None),
    };

    let changes = modpacks::patch::detect_instance_changes(&snapshot, &instance_dir)?;
    Ok(Some(changes))
}

/// Создать патч из обнаруженных изменений в экземпляре
#[tauri::command]
async fn create_patch_from_instance_changes(
    instance_id: String,
    description: String,
    author: Option<String>,
    include_configs: bool,
) -> Result<modpacks::ModpackPatch> {
    let instance = instances::lifecycle::get_instance(instance_id).await?;
    let instance_dir = std::path::PathBuf::from(&instance.dir);

    // Load existing snapshot
    let snapshot = modpacks::patch::load_snapshot(&instance_dir).ok_or_else(|| {
        error::LauncherError::InvalidConfig(
            "No snapshot found for instance. Create a snapshot first.".to_string(),
        )
    })?;

    // Detect changes
    let changes = modpacks::patch::detect_instance_changes(&snapshot, &instance_dir)?;

    if !changes.has_changes {
        return Err(error::LauncherError::InvalidConfig(
            "No changes detected in instance.".to_string(),
        ));
    }

    // Create patch from changes
    modpacks::patch::create_patch_from_changes(
        &snapshot,
        &changes,
        &instance_dir,
        description,
        author,
        include_configs,
    )
}

// ========== Launch Tracker — изменения с последнего запуска ==========

/// Получить изменения с последнего успешного запуска
/// Использует blake3 для быстрого хэширования
#[tauri::command]
async fn get_launch_changes(instance_id: String) -> Result<launch_tracker::LaunchChanges> {
    let instance = instances::lifecycle::get_instance(instance_id).await?;
    let instance_dir = std::path::PathBuf::from(&instance.dir);

    launch_tracker::detect_changes_since_launch(
        &instance_dir,
        &instance.version,
        instance.loader.as_str(),
        instance.loader_version.as_deref(),
    )
    .await
}

/// Сохранить snapshot после успешного запуска
#[tauri::command]
async fn save_launch_snapshot(instance_id: String) -> Result<String> {
    log::info!("[save_launch_snapshot] Starting for instance: {}", instance_id);

    let instance = instances::lifecycle::get_instance(instance_id.clone()).await?;
    let instance_dir = std::path::PathBuf::from(&instance.dir);

    log::info!("[save_launch_snapshot] Instance dir: {}", instance_dir.display());

    let result = launch_tracker::on_successful_launch(
        &instance_id,
        &instance_dir,
        &instance.version,
        instance.loader.as_str(),
        instance.loader_version.as_deref(),
    )
    .await;

    match &result {
        Ok(snapshot_id) => log::info!("[save_launch_snapshot] Created snapshot: {}", snapshot_id),
        Err(e) => log::error!("[save_launch_snapshot] Failed: {:?}", e),
    }

    result
}

/// Удалить launch snapshot (сбросить отслеживание)
#[tauri::command]
async fn delete_launch_snapshot(instance_id: String) -> Result<()> {
    let instance = instances::lifecycle::get_instance(instance_id).await?;
    let instance_dir = std::path::PathBuf::from(&instance.dir);
    launch_tracker::delete_launch_snapshot(&instance_dir)
}

/// Получить историю снимков экземпляра
#[tauri::command]
async fn get_snapshot_history(instance_id: String) -> Result<launch_tracker::SnapshotHistory> {
    let instance = instances::lifecycle::get_instance(instance_id).await?;
    let instance_dir = std::path::PathBuf::from(&instance.dir);
    Ok(launch_tracker::load_history(&instance_dir))
}

/// Получить список снимков (только метаданные)
#[tauri::command]
async fn get_snapshot_list(instance_id: String) -> Result<Vec<launch_tracker::SnapshotMeta>> {
    let instance = instances::lifecycle::get_instance(instance_id).await?;
    let instance_dir = std::path::PathBuf::from(&instance.dir);
    Ok(launch_tracker::get_snapshot_list(&instance_dir))
}

/// Получить изменения относительно конкретного снимка
#[tauri::command]
async fn get_launch_changes_with_snapshot(
    instance_id: String,
    snapshot_id: String,
) -> Result<launch_tracker::LaunchChanges> {
    let instance = instances::lifecycle::get_instance(instance_id).await?;
    let instance_dir = std::path::PathBuf::from(&instance.dir);

    launch_tracker::detect_changes_with_snapshot(
        &instance_dir,
        Some(&snapshot_id),
        &instance.version,
        instance.loader.as_str(),
        instance.loader_version.as_deref(),
    )
    .await
}

/// Пометить снимок как успешный/неуспешный
#[tauri::command]
async fn mark_snapshot_result(
    instance_id: String,
    snapshot_id: String,
    was_successful: bool,
) -> Result<()> {
    let instance = instances::lifecycle::get_instance(instance_id).await?;
    let instance_dir = std::path::PathBuf::from(&instance.dir);
    launch_tracker::mark_snapshot_result(&instance_dir, &snapshot_id, was_successful)
}

/// Связать снимок с бэкапом
#[tauri::command]
async fn link_snapshot_to_backup(
    instance_id: String,
    snapshot_id: String,
    backup_id: String,
) -> Result<()> {
    let instance = instances::lifecycle::get_instance(instance_id).await?;
    let instance_dir = std::path::PathBuf::from(&instance.dir);
    launch_tracker::link_snapshot_to_backup(&instance_dir, &snapshot_id, &backup_id)
}

/// Установить максимальное количество снимков
#[tauri::command]
async fn set_max_snapshots(instance_id: String, max_count: usize) -> Result<()> {
    let instance = instances::lifecycle::get_instance(instance_id).await?;
    let instance_dir = std::path::PathBuf::from(&instance.dir);
    launch_tracker::set_max_snapshots(&instance_dir, max_count)
}

/// Загрузить конкретный снимок по ID
#[tauri::command]
async fn load_snapshot(instance_id: String, snapshot_id: String) -> Result<Option<launch_tracker::LaunchSnapshot>> {
    let instance = instances::lifecycle::get_instance(instance_id).await?;
    let instance_dir = std::path::PathBuf::from(&instance.dir);
    Ok(launch_tracker::load_snapshot(&instance_dir, &snapshot_id))
}

/// Поиск мода по имени на указанной платформе
#[tauri::command]
async fn search_mod_by_name(
    name: String,
    source: String,
    minecraft_version: Option<String>,
    loader: Option<String>,
) -> Result<Vec<modpacks::ModSearchInfo>> {
    modpacks::ModpackManager::search_mod_by_name(
        &name,
        &source,
        minecraft_version.as_deref(),
        loader.as_deref(),
    )
    .await
}

/// Скачивание мода с платформы в указанную директорию
#[tauri::command]
async fn download_mod_to_path(
    source: String,
    project_id: String,
    version_id: Option<String>,
    dest_path: String,
    minecraft_version: Option<String>,
    loader: Option<String>,
    app_handle: tauri::AppHandle,
) -> Result<String> {
    let download_manager = downloader::DownloadManager::new(app_handle)?;
    modpacks::ModpackManager::download_mod_to_path(
        &source,
        &project_id,
        version_id.as_deref(),
        &std::path::PathBuf::from(dest_path),
        minecraft_version.as_deref(),
        loader.as_deref(),
        &download_manager,
    )
    .await
}

/// Получение списка версий модпака с платформы для сравнения
#[tauri::command]
async fn get_modpack_mod_list(
    source: String,
    project_id: String,
    version_id: Option<String>,
) -> Result<Vec<modpacks::ModInfo>> {
    modpacks::ModpackManager::get_modpack_mod_list(&source, &project_id, version_id.as_deref())
        .await
}

#[tauri::command]
async fn list_java_installations() -> Result<Vec<types::JavaInstallation>> {
    let conn = db::get_db_conn()?;
    let mut stmt = conn.prepare(
        "SELECT id, version, path, vendor, architecture, is_auto_installed, installed_at
         FROM java_installations ORDER BY version DESC",
    )?;

    let installations = stmt
        .query_map([], |row| {
            Ok(types::JavaInstallation {
                id: row.get(0)?,
                version: row.get(1)?,
                path: row.get(2)?,
                vendor: row.get(3)?,
                architecture: row.get(4)?,
                is_auto_installed: row.get::<_, i32>(5)? != 0,
                installed_at: row.get(6)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    Ok(installations)
}

#[tauri::command]
async fn install_java(version: u32, app_handle: tauri::AppHandle) -> Result<String> {
    let download_manager = downloader::DownloadManager::new(app_handle)?;
    // Создаём токен отмены для ручной установки Java (не отменяется через UI)
    let cancel_token = CancellationToken::new();
    let path =
        java::JavaManager::install_java(version, &download_manager, &cancel_token, None).await?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
async fn scan_system_java() -> Vec<java::SystemJavaInfo> {
    java::JavaManager::scan_system_java().await
}

#[tauri::command]
async fn add_custom_java(path: String) -> Result<java::SystemJavaInfo> {
    java::JavaManager::add_custom_java(&path).await
}

#[tauri::command]
async fn validate_java_path(path: String) -> Result<java::SystemJavaInfo> {
    java::JavaManager::validate_java_path(&path).await
}

#[tauri::command]
fn get_installed_java_major_versions() -> Result<Vec<u32>> {
    java::JavaManager::get_installed_major_versions()
}

#[tauri::command]
fn get_java_for_version(major_version: u32) -> Result<Vec<java::JavaInstallationInfo>> {
    java::JavaManager::get_java_for_version(major_version)
}

#[tauri::command]
fn set_active_java(major_version: u32, java_path: String) -> Result<()> {
    java::JavaManager::set_active_java(major_version, &java_path)
}

#[tauri::command]
fn check_java_compatibility(java_major: u32, minecraft_version: String) -> java::JavaCompatibility {
    java::JavaManager::check_java_compatibility(java_major, &minecraft_version)
}

#[tauri::command]
async fn check_java_compatibility_for_path(
    java_path: String,
    minecraft_version: String,
) -> java::JavaCompatibility {
    java::JavaManager::check_java_compatibility_for_path(&java_path, &minecraft_version).await
}

// НОВЫЕ КОМАНДЫ для Minecraft версий
#[tauri::command]
async fn fetch_minecraft_versions() -> Result<Vec<types::MinecraftVersion>> {
    minecraft::MinecraftInstaller::cache_versions().await?;

    let conn = db::get_db_conn()?;
    let mut stmt = conn.prepare(
        "SELECT id, type, release_time, url, java_version
         FROM minecraft_versions
         ORDER BY release_time DESC",
    )?;

    let versions = stmt
        .query_map([], |row| {
            Ok(types::MinecraftVersion {
                id: row.get(0)?,
                version_type: row.get(1)?,
                release_time: row.get(2)?,
                url: row.get(3)?,
                java_version: row.get(4)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    Ok(versions)
}

#[tauri::command]
async fn get_loader_versions(minecraft_version: String, loader: String) -> Result<Vec<String>> {
    use types::LoaderType;

    let loader_type = LoaderType::parse(&loader).ok_or_else(|| {
        error::LauncherError::InvalidConfig(format!("Invalid loader: {}", loader))
    })?;

    match loader_type {
        LoaderType::Vanilla => Ok(vec!["vanilla".to_string()]),
        LoaderType::Fabric => {
            let versions = loaders::FabricInstaller::get_versions(&minecraft_version).await?;
            Ok(versions.into_iter().map(|v| v.version).collect())
        }
        LoaderType::Quilt => {
            let versions = loaders::QuiltInstaller::get_versions(&minecraft_version).await?;
            Ok(versions.into_iter().map(|v| v.version).collect())
        }
        LoaderType::NeoForge => loaders::NeoForgeInstaller::get_versions(&minecraft_version).await,
        LoaderType::Forge => loaders::ForgeInstaller::get_versions(&minecraft_version).await,
    }
}

// ============================================================================
// Knowledge Base Commands
// ============================================================================

/// Save feedback about a solution
#[tauri::command]
async fn save_solution_feedback(
    problem_signature: String,
    solution_id: String,
    helped: bool,
    notes: Option<String>,
    instance_id: Option<String>,
) -> Result<String> {
    use stuzhik_db::KnowledgeBase;

    let kb = KnowledgeBase::new()
        .map_err(|e| error::LauncherError::InvalidConfig(format!("Failed to create KB: {}", e)))?;

    kb.save_feedback(&problem_signature, &solution_id, helped, notes, instance_id)
        .map_err(|e| error::LauncherError::InvalidConfig(format!("Failed to save feedback: {}", e)))
}

/// Get rating for a solution
#[tauri::command]
async fn get_solution_rating(solution_id: String) -> Result<Option<stuzhik_db::SolutionRating>> {
    use stuzhik_db::KnowledgeBase;

    let kb = KnowledgeBase::new()
        .map_err(|e| error::LauncherError::InvalidConfig(format!("Failed to create KB: {}", e)))?;

    kb.get_solution_rating(&solution_id)
        .map_err(|e| error::LauncherError::InvalidConfig(format!("Failed to get rating: {}", e)))
}

/// Get all feedback for a problem
#[tauri::command]
async fn get_feedback_for_problem(
    problem_signature: String,
) -> Result<Vec<stuzhik_db::SolutionFeedback>> {
    use stuzhik_db::KnowledgeBase;

    let kb = KnowledgeBase::new()
        .map_err(|e| error::LauncherError::InvalidConfig(format!("Failed to create KB: {}", e)))?;

    kb.get_feedback_for_problem(&problem_signature)
        .map_err(|e| error::LauncherError::InvalidConfig(format!("Failed to get feedback: {}", e)))
}

/// Get top rated solutions
#[tauri::command]
async fn get_top_rated_solutions(limit: u32) -> Result<Vec<stuzhik_db::SolutionRating>> {
    use stuzhik_db::KnowledgeBase;

    let kb = KnowledgeBase::new()
        .map_err(|e| error::LauncherError::InvalidConfig(format!("Failed to create KB: {}", e)))?;

    kb.get_top_rated_solutions(limit).map_err(|e| {
        error::LauncherError::InvalidConfig(format!("Failed to get top solutions: {}", e))
    })
}

/// Get Knowledge Base statistics
#[tauri::command]
async fn get_knowledge_base_stats() -> Result<stuzhik_db::KnowledgeBaseStats> {
    use stuzhik_db::KnowledgeBase;

    let kb = KnowledgeBase::new()
        .map_err(|e| error::LauncherError::InvalidConfig(format!("Failed to create KB: {}", e)))?;

    kb.get_statistics()
        .map_err(|e| error::LauncherError::InvalidConfig(format!("Failed to get stats: {}", e)))
}

/// Cleanup old feedback records
#[tauri::command]
async fn cleanup_old_feedback(days: u32) -> Result<usize> {
    use stuzhik_db::KnowledgeBase;

    let kb = KnowledgeBase::new()
        .map_err(|e| error::LauncherError::InvalidConfig(format!("Failed to create KB: {}", e)))?;

    kb.cleanup_old_feedback(days)
        .map_err(|e| error::LauncherError::InvalidConfig(format!("Failed to cleanup: {}", e)))
}

// ============================================================================
// P2P / Stuzhik Connect Commands
// ============================================================================

/// Получить настройки P2P Connect
#[tauri::command]
fn get_connect_settings() -> p2p::ConnectSettings {
    let conn = match db::get_db_conn() {
        Ok(c) => c,
        Err(_) => return p2p::ConnectSettings::default(),
    };

    conn.query_row(
        "SELECT value FROM settings WHERE key = 'connect_settings'",
        [],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .and_then(|json| serde_json::from_str(&json).ok())
    .unwrap_or_default()
}

/// Сохранить настройки P2P Connect
#[tauri::command]
async fn save_connect_settings(settings: p2p::ConnectSettings) -> Result<()> {
    use chrono::Utc;

    let conn = db::get_db_conn()?;
    let json = serde_json::to_string(&settings)?;

    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('connect_settings', ?1, ?2)",
        rusqlite::params![json, Utc::now().to_rfc3339()],
    )?;

    // Обновляем ConnectService
    let service = get_connect_service();
    let was_enabled = service.read().await.get_settings().await.enabled;
    service
        .write()
        .await
        .update_settings(settings.clone())
        .await;

    // Если включили - запускаем discovery
    if settings.enabled && !was_enabled {
        if let Err(e) = service.write().await.enable().await {
            log::warn!("Failed to enable P2P discovery: {}", e);
        }
    }

    Ok(())
}

/// Получить список рекомендуемых VPN
#[tauri::command]
fn get_vpn_recommendations() -> Vec<p2p::VpnRecommendation> {
    p2p::VpnRecommendation::recommendations()
}

/// Получить список найденных пиров
#[tauri::command]
async fn get_discovered_peers() -> Vec<p2p::PeerInfo> {
    get_connect_service().read().await.get_peers().await
}

/// Запустить P2P discovery вручную
#[tauri::command]
async fn start_p2p_discovery() -> Result<()> {
    let service = get_connect_service();
    service
        .write()
        .await
        .enable()
        .await
        .map_err(|e| error::LauncherError::InvalidConfig(e.to_string()))
}

/// Остановить P2P discovery
#[tauri::command]
async fn stop_p2p_discovery() -> Result<()> {
    let service = get_connect_service();
    service.write().await.disable().await;
    Ok(())
}

/// Получить ID текущего пира
#[tauri::command]
async fn get_my_peer_id() -> Option<String> {
    get_connect_service().read().await.get_peer_id().await
}

/// Получить короткий код для подключения
#[tauri::command]
async fn get_short_code() -> Option<String> {
    get_connect_service().read().await.get_short_code().await
}

/// Подключиться к пиру по короткому коду
/// Возвращает информацию о подключённом пире
#[tauri::command]
async fn connect_by_code(code: String) -> Result<p2p::PeerInfo> {
    get_connect_service()
        .read()
        .await
        .connect_by_code(&code)
        .await
        .map_err(|e| error::LauncherError::P2PConnection(e))
}

/// Ответить на запрос согласия
#[tauri::command]
async fn respond_to_consent(request_id: String, approved: bool, remember: bool) -> Result<()> {
    use p2p::get_consent_manager;

    log::info!(
        "Consent response for {}: approved={}, remember={}",
        request_id,
        approved,
        remember
    );

    // Получаем информацию о запросе перед ответом (для remember)
    let pending_requests = get_consent_manager().get_pending_requests().await;
    let request_info = pending_requests
        .iter()
        .find(|r| r.request_id == request_id)
        .cloned();

    // Отправляем ответ через ConsentManager
    get_consent_manager()
        .respond(&request_id, approved, remember)
        .await
        .map_err(|e| error::LauncherError::InvalidConfig(e))?;

    // Если remember=true, сохраняем разрешение в настройках
    if remember {
        if let Some(req) = request_info {
            let mut settings = get_connect_settings();

            // Удаляем старое разрешение для этого пира и типа (если есть)
            settings.remembered_permissions.retain(|p| {
                !(p.peer_id == req.peer_id && p.content_type == req.consent_type.to_string())
            });

            // Добавляем новое разрешение
            settings
                .remembered_permissions
                .push(p2p::RememberedPermission {
                    peer_id: req.peer_id.clone(),
                    content_type: req.consent_type.to_string(),
                    allowed: approved,
                    created_at: chrono::Utc::now().to_rfc3339(),
                });

            // Сохраняем в БД
            let conn = db::get_db_conn()?;
            let json = serde_json::to_string(&settings)?;
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('connect_settings', ?1, ?2)",
                rusqlite::params![json, chrono::Utc::now().to_rfc3339()],
            )?;

            // Обновляем ConnectService
            get_connect_service()
                .write()
                .await
                .update_settings(settings)
                .await;

            log::info!(
                "Remembered permission for peer {} type {}: allowed={}",
                req.peer_id,
                req.consent_type,
                approved
            );
        }
    }

    Ok(())
}

/// Получить ожидающие запросы на согласие
#[tauri::command]
async fn get_pending_consents() -> Result<Vec<p2p::ConsentRequest>> {
    Ok(p2p::get_consent_manager().get_pending_requests().await)
}

/// Заблокировать пира
#[tauri::command]
async fn block_peer(peer_id: String) -> Result<()> {
    let mut settings = get_connect_settings();
    if !settings.blocked_peers.contains(&peer_id) {
        settings.blocked_peers.push(peer_id.clone());

        // Сохраняем в БД
        use chrono::Utc;
        let conn = db::get_db_conn()?;
        let json = serde_json::to_string(&settings)?;
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('connect_settings', ?1, ?2)",
            rusqlite::params![json, Utc::now().to_rfc3339()],
        )?;

        // Обновляем ConnectService
        get_connect_service()
            .write()
            .await
            .update_settings(settings)
            .await;

        log::info!("Blocked peer: {}", peer_id);
    }
    Ok(())
}

/// Разблокировать пира
#[tauri::command]
async fn unblock_peer(peer_id: String) -> Result<()> {
    let mut settings = get_connect_settings();
    settings.blocked_peers.retain(|id| id != &peer_id);

    // Сохраняем в БД
    use chrono::Utc;
    let conn = db::get_db_conn()?;
    let json = serde_json::to_string(&settings)?;
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('connect_settings', ?1, ?2)",
        rusqlite::params![json, Utc::now().to_rfc3339()],
    )?;

    // Обновляем ConnectService
    get_connect_service()
        .write()
        .await
        .update_settings(settings)
        .await;

    log::info!("Unblocked peer: {}", peer_id);
    Ok(())
}

/// Добавить доверенного друга
#[tauri::command]
async fn add_friend(
    peer_id: String,
    nickname: String,
    public_key: String,
    note: Option<String>,
) -> Result<()> {
    let mut settings = get_connect_settings();

    // Проверяем что друг ещё не добавлен
    if settings.trusted_friends.iter().any(|f| f.id == peer_id) {
        return Err(error::LauncherError::InvalidConfig(
            "Friend already exists".to_string(),
        ));
    }

    let friend = p2p::TrustedFriend {
        id: peer_id.clone(),
        nickname,
        public_key,
        added_at: chrono::Utc::now().to_rfc3339(),
        note,
    };

    settings.trusted_friends.push(friend);

    // Сохраняем в БД
    let conn = db::get_db_conn()?;
    let json = serde_json::to_string(&settings)?;
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('connect_settings', ?1, ?2)",
        rusqlite::params![json, chrono::Utc::now().to_rfc3339()],
    )?;

    get_connect_service()
        .write()
        .await
        .update_settings(settings)
        .await;

    log::info!("Added friend: {}", peer_id);
    Ok(())
}

/// Удалить друга
#[tauri::command]
async fn remove_friend(peer_id: String) -> Result<()> {
    let mut settings = get_connect_settings();
    settings.trusted_friends.retain(|f| f.id != peer_id);

    // Сохраняем в БД
    let conn = db::get_db_conn()?;
    let json = serde_json::to_string(&settings)?;
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('connect_settings', ?1, ?2)",
        rusqlite::params![json, chrono::Utc::now().to_rfc3339()],
    )?;

    get_connect_service()
        .write()
        .await
        .update_settings(settings)
        .await;

    log::info!("Removed friend: {}", peer_id);
    Ok(())
}

/// Отправить запрос в друзья пиру
#[tauri::command]
async fn send_friend_request(peer_id: String) -> Result<()> {
    let settings = get_connect_settings();
    let nickname = settings.nickname.clone();

    // Используем peer_id как публичный ключ пока нет настоящей криптографии
    let public_key = peer_id.clone();

    get_connect_service()
        .read()
        .await
        .send_friend_request(&peer_id, &nickname, &public_key)
        .await
        .map_err(|e| error::LauncherError::InvalidConfig(e))?;

    log::info!("Sent friend request to: {}", peer_id);
    Ok(())
}

/// Диагностика сети для P2P
#[tauri::command]
async fn diagnose_network() -> p2p::network::NetworkDiagnostics {
    let settings = get_connect_settings();
    p2p::network::diagnose_network(settings.discovery_port, settings.enabled).await
}

/// Получить объяснение настройки firewall
#[tauri::command]
fn get_firewall_explanation_cmd() -> String {
    let settings = get_connect_settings();
    p2p::network::get_firewall_explanation(settings.discovery_port, settings.discovery_port + 1)
}

/// Получить список друзей
#[tauri::command]
async fn get_friends() -> Vec<p2p::TrustedFriend> {
    get_connect_settings().trusted_friends
}

/// Запросить синхронизацию модпака у пира
#[tauri::command]
async fn request_modpack_sync(peer_id: String, modpack_name: String) -> Result<()> {
    log::info!(
        "Requesting modpack sync from peer {}: {}",
        peer_id,
        modpack_name
    );

    // Отправляем запрос на синхронизацию модпака
    let service = get_connect_service().read().await;
    service
        .request_modpack_sync(&peer_id, &modpack_name)
        .await
        .map_err(|e| error::LauncherError::InvalidConfig(e.to_string()))?;

    Ok(())
}

/// Быстро присоединиться к серверу друга
/// Возвращает instance_id если найден подходящий экземпляр
#[tauri::command]
async fn quick_join_server(
    peer_id: String,
    server_address: String,
    modpack_name: String,
) -> Result<String> {
    log::info!(
        "Quick join: peer={}, server={}, modpack={}",
        peer_id,
        server_address,
        modpack_name
    );

    // 1. Находим экземпляр с таким же именем модпака
    let instances = instances::list_instances().await?;
    let matching_instance = instances.iter().find(|i| i.name == modpack_name);

    let instance = if let Some(inst) = matching_instance {
        inst.clone()
    } else {
        // Экземпляр не найден - нужна синхронизация
        log::info!("Instance '{}' not found, sync required", modpack_name);
        return Err(error::LauncherError::InvalidConfig(format!(
            "Instance '{}' not found. Please sync modpack first.",
            modpack_name
        )));
    };

    // 2. Обновляем game_args экземпляра для подключения к серверу
    let server_arg = format!("--server {}", server_address);
    let game_args = match &instance.game_args {
        Some(existing) => {
            // Убираем старый --server аргумент если есть
            let cleaned: String = existing
                .split_whitespace()
                .filter(|arg| !arg.starts_with("--server"))
                .collect::<Vec<_>>()
                .join(" ");
            if cleaned.is_empty() {
                server_arg
            } else {
                format!("{} {}", cleaned, server_arg)
            }
        }
        None => server_arg,
    };

    // Обновляем экземпляр
    let conn = db::get_db_conn()?;
    conn.execute(
        "UPDATE instances SET game_args = ?1 WHERE id = ?2",
        rusqlite::params![game_args, instance.id],
    )?;

    log::info!(
        "Updated instance {} game_args for server: {}",
        instance.id,
        server_address
    );

    // Возвращаем instance_id - фронтенд запустит его через start_instance
    Ok(instance.id)
}

/// Получить манифест модпака для delta-sync
#[tauri::command]
async fn get_modpack_manifest(instance_id: String) -> Result<p2p::transfer::ModpackManifest> {
    let instance = instances::get_instance(instance_id.clone()).await?;
    let instance_path = std::path::PathBuf::from(&instance.dir);

    let manifest = p2p::transfer::TransferManager::create_manifest(
        &instance_path,
        &instance.name,
        &instance.version,
        instance.loader.as_str(),
        &instance.loader_version.clone().unwrap_or_default(),
    )
    .await
    .map_err(|e| error::LauncherError::InvalidConfig(e))?;

    Ok(manifest)
}

/// Вычислить разницу между локальным и удалённым манифестами
#[tauri::command]
fn compute_sync_diff(
    local_manifest: p2p::transfer::ModpackManifest,
    remote_manifest: p2p::transfer::ModpackManifest,
) -> p2p::transfer::SyncDiff {
    p2p::transfer::TransferManager::compute_diff(&local_manifest, &remote_manifest)
}

/// Получить активные сессии передачи
#[tauri::command]
async fn get_transfer_sessions() -> Vec<p2p::TransferSession> {
    get_connect_service()
        .read()
        .await
        .get_transfer_sessions()
        .await
}

/// Отменить передачу файлов
#[tauri::command]
async fn cancel_transfer(session_id: String) -> Result<()> {
    get_connect_service()
        .read()
        .await
        .cancel_transfer(&session_id)
        .await
        .map_err(|e| error::LauncherError::InvalidConfig(e))
}

// ==================== Transfer History Commands ====================

/// Получить историю передач
#[tauri::command]
async fn get_transfer_history() -> Vec<p2p::TransferHistoryEntry> {
    get_connect_service()
        .read()
        .await
        .get_transfer_history()
        .await
}

/// Получить последние N записей истории
#[tauri::command]
async fn get_recent_transfer_history(limit: usize) -> Vec<p2p::TransferHistoryEntry> {
    get_connect_service()
        .read()
        .await
        .get_recent_history(limit)
        .await
}

/// Получить статистику истории передач
#[tauri::command]
async fn get_transfer_history_stats() -> p2p::HistoryStats {
    get_connect_service().read().await.get_history_stats().await
}

/// Очистить историю передач
#[tauri::command]
async fn clear_transfer_history() -> Result<()> {
    get_connect_service()
        .read()
        .await
        .clear_history()
        .await
        .map_err(|e| error::LauncherError::InvalidConfig(e))
}

// ==================== Selective Sync Commands ====================

/// Установить конфигурацию selective sync для модпака
#[tauri::command]
async fn set_selective_sync_config(config: p2p::SelectiveSyncConfig) {
    get_connect_service()
        .read()
        .await
        .set_selective_sync(config)
        .await;
}

/// Получить конфигурацию selective sync для модпака
#[tauri::command]
async fn get_selective_sync_config(modpack_name: String) -> Option<p2p::SelectiveSyncConfig> {
    get_connect_service()
        .read()
        .await
        .get_selective_sync(&modpack_name)
        .await
}

/// Удалить конфигурацию selective sync для модпака
#[tauri::command]
async fn remove_selective_sync_config(modpack_name: String) {
    get_connect_service()
        .read()
        .await
        .remove_selective_sync(&modpack_name)
        .await;
}

// ==================== Watch Mode Commands ====================

/// Добавить конфигурацию watch mode для модпака
#[tauri::command]
async fn add_watch_config(config: p2p::WatchConfig) -> Result<()> {
    get_connect_service()
        .read()
        .await
        .add_watch_config(config)
        .await
        .map_err(|e| error::LauncherError::InvalidConfig(e))
}

/// Получить конфигурацию watch mode для модпака
#[tauri::command]
async fn get_watch_config(modpack_name: String) -> Option<p2p::WatchConfig> {
    get_connect_service()
        .read()
        .await
        .get_watch_config(&modpack_name)
        .await
}

/// Получить все конфигурации watch mode
#[tauri::command]
async fn get_all_watch_configs() -> Vec<p2p::WatchConfig> {
    get_connect_service()
        .read()
        .await
        .get_all_watch_configs()
        .await
}

/// Начать отслеживание модпака
#[tauri::command]
async fn start_watching(modpack_name: String) -> Result<()> {
    get_connect_service()
        .read()
        .await
        .start_watching(&modpack_name)
        .await
        .map_err(|e| error::LauncherError::InvalidConfig(e))
}

/// Остановить отслеживание модпака
#[tauri::command]
async fn stop_watching(modpack_name: String) -> Result<()> {
    get_connect_service()
        .read()
        .await
        .stop_watching(&modpack_name)
        .await
        .map_err(|e| error::LauncherError::InvalidConfig(e))
}

/// Проверить активен ли watch mode для модпака
#[tauri::command]
async fn is_watching(modpack_name: String) -> bool {
    get_connect_service()
        .read()
        .await
        .is_watching(&modpack_name)
        .await
}

/// Получить список активных watchers
#[tauri::command]
async fn get_active_watches() -> Vec<String> {
    get_connect_service()
        .read()
        .await
        .get_active_watches()
        .await
}

/// Остановить все watchers
#[tauri::command]
async fn stop_all_watches() {
    get_connect_service().read().await.stop_all_watches().await;
}

// ==================== Transfer Queue Commands ====================

/// Добавить передачу в очередь
#[tauri::command]
async fn queue_transfer(
    peer_id: String,
    peer_nickname: Option<String>,
    modpack_name: String,
    priority: p2p::TransferPriority,
) -> String {
    get_connect_service()
        .read()
        .await
        .queue_transfer(&peer_id, peer_nickname, &modpack_name, priority)
        .await
}

/// Получить очередь передач
#[tauri::command]
async fn get_transfer_queue() -> Vec<p2p::QueuedTransfer> {
    get_connect_service()
        .read()
        .await
        .get_transfer_queue()
        .await
}

/// Отменить передачу в очереди
#[tauri::command]
async fn cancel_queued_transfer(queue_id: String) -> Result<()> {
    get_connect_service()
        .read()
        .await
        .cancel_queued_transfer(&queue_id)
        .await
        .map_err(|e| error::LauncherError::InvalidConfig(e))
}

/// Изменить приоритет передачи
#[tauri::command]
async fn set_transfer_priority(queue_id: String, priority: p2p::TransferPriority) -> Result<()> {
    get_connect_service()
        .read()
        .await
        .set_transfer_priority(&queue_id, priority)
        .await
        .map_err(|e| error::LauncherError::InvalidConfig(e))
}

/// Установить максимальное количество одновременных передач
#[tauri::command]
async fn set_max_concurrent_transfers(max: usize) {
    get_connect_service()
        .read()
        .await
        .set_max_concurrent_transfers(max)
        .await;
}

/// Повторить неудачную передачу
#[tauri::command]
async fn retry_queued_transfer(queue_id: String) -> Result<()> {
    get_connect_service()
        .read()
        .await
        .retry_queued_transfer(&queue_id)
        .await
        .map_err(|e| error::LauncherError::InvalidConfig(e))
}

/// Очистить очередь передач
#[tauri::command]
async fn clear_transfer_queue() {
    get_connect_service()
        .read()
        .await
        .clear_transfer_queue()
        .await;
}

// ==================== Peer Groups Commands ====================

/// Загрузить группы пиров
#[tauri::command]
async fn load_peer_groups() -> Result<()> {
    get_connect_service()
        .read()
        .await
        .load_peer_groups()
        .await
        .map_err(|e| error::LauncherError::InvalidConfig(e))
}

/// Создать группу пиров
#[tauri::command]
async fn create_peer_group(name: String) -> p2p::PeerGroup {
    get_connect_service()
        .read()
        .await
        .create_peer_group(&name)
        .await
}

/// Удалить группу пиров
#[tauri::command]
async fn delete_peer_group(group_id: String) -> Result<()> {
    get_connect_service()
        .read()
        .await
        .delete_peer_group(&group_id)
        .await
        .map_err(|e| error::LauncherError::InvalidConfig(e))
}

/// Получить группу по ID
#[tauri::command]
async fn get_peer_group(group_id: String) -> Option<p2p::PeerGroup> {
    get_connect_service()
        .read()
        .await
        .get_peer_group(&group_id)
        .await
}

/// Получить все группы пиров
#[tauri::command]
async fn get_all_peer_groups() -> Vec<p2p::PeerGroup> {
    get_connect_service()
        .read()
        .await
        .get_all_peer_groups()
        .await
}

/// Добавить пира в группу
#[tauri::command]
async fn add_peer_to_group(group_id: String, peer_id: String) -> Result<()> {
    get_connect_service()
        .read()
        .await
        .add_peer_to_group(&group_id, &peer_id)
        .await
        .map_err(|e| error::LauncherError::InvalidConfig(e))
}

/// Удалить пира из группы
#[tauri::command]
async fn remove_peer_from_group(group_id: String, peer_id: String) -> Result<()> {
    get_connect_service()
        .read()
        .await
        .remove_peer_from_group(&group_id, &peer_id)
        .await
        .map_err(|e| error::LauncherError::InvalidConfig(e))
}

/// Получить группы для пира
#[tauri::command]
async fn get_groups_for_peer(peer_id: String) -> Vec<p2p::PeerGroup> {
    get_connect_service()
        .read()
        .await
        .get_groups_for_peer(&peer_id)
        .await
}

/// Переименовать группу
#[tauri::command]
async fn rename_peer_group(group_id: String, new_name: String) -> Result<()> {
    get_connect_service()
        .read()
        .await
        .rename_peer_group(&group_id, &new_name)
        .await
        .map_err(|e| error::LauncherError::InvalidConfig(e))
}

// ==================== Update Notifications Commands ====================

/// Включить/выключить уведомления об обновлениях
#[tauri::command]
async fn set_update_notifications_enabled(enabled: bool) {
    get_connect_service()
        .read()
        .await
        .set_update_notifications_enabled(enabled)
        .await;
}

/// Установить локальную версию модпака
#[tauri::command]
async fn set_local_modpack_version(modpack_name: String, version: String) {
    get_connect_service()
        .read()
        .await
        .set_local_modpack_version(&modpack_name, &version)
        .await;
}

/// Получить уведомления об обновлениях
#[tauri::command]
async fn get_update_notifications() -> Vec<p2p::UpdateNotification> {
    get_connect_service()
        .read()
        .await
        .get_update_notifications()
        .await
}

/// Получить непрочитанные уведомления
#[tauri::command]
async fn get_unread_update_notifications() -> Vec<p2p::UpdateNotification> {
    get_connect_service()
        .read()
        .await
        .get_unread_update_notifications()
        .await
}

/// Получить количество непрочитанных уведомлений
#[tauri::command]
async fn get_unread_notification_count() -> usize {
    get_connect_service()
        .read()
        .await
        .get_unread_notification_count()
        .await
}

/// Отметить уведомление как прочитанное
#[tauri::command]
async fn mark_notification_read(notification_id: String) {
    get_connect_service()
        .read()
        .await
        .mark_notification_read(&notification_id)
        .await;
}

/// Отметить все уведомления как прочитанные
#[tauri::command]
async fn mark_all_notifications_read() {
    get_connect_service()
        .read()
        .await
        .mark_all_notifications_read()
        .await;
}

/// Отклонить уведомление
#[tauri::command]
async fn dismiss_notification(notification_id: String) {
    get_connect_service()
        .read()
        .await
        .dismiss_notification(&notification_id)
        .await;
}

/// Очистить все уведомления
#[tauri::command]
async fn clear_update_notifications() {
    get_connect_service()
        .read()
        .await
        .clear_update_notifications()
        .await;
}

/// Отслеживать модпак для уведомлений
#[tauri::command]
async fn track_modpack_updates(modpack_name: String) {
    get_connect_service()
        .read()
        .await
        .track_modpack_updates(&modpack_name)
        .await;
}

/// Перестать отслеживать модпак
#[tauri::command]
async fn untrack_modpack_updates(modpack_name: String) {
    get_connect_service()
        .read()
        .await
        .untrack_modpack_updates(&modpack_name)
        .await;
}

/// Получить пиров с конкретным модпаком
#[tauri::command]
async fn get_peers_with_modpack(modpack_name: String) -> Vec<p2p::PeerModpackVersion> {
    get_connect_service()
        .read()
        .await
        .get_peers_with_modpack(&modpack_name)
        .await
}

// ==================== Server P2P Sync ====================

// Use the global ServerSyncManager from p2p::server_sync
fn get_server_sync_manager() -> Arc<p2p::ServerSyncManager> {
    p2p::server_sync::get_server_sync_manager()
}

/// Get server sync config
#[tauri::command]
async fn get_server_sync_config(server_instance_id: String) -> Option<p2p::ServerSyncConfig> {
    get_server_sync_manager()
        .get_config(&server_instance_id)
        .await
}

/// Set server sync config
#[tauri::command]
async fn set_server_sync_config(config: p2p::ServerSyncConfig) -> Result<()> {
    get_server_sync_manager().set_config(config).await;
    Ok(())
}

/// Link client instance to server
#[tauri::command]
async fn link_client_to_server(
    server_instance_id: String,
    client_instance_id: String,
) -> Result<()> {
    get_server_sync_manager()
        .link_client_to_server(&server_instance_id, &client_instance_id)
        .await
        .map_err(|e| error::LauncherError::InvalidConfig(e))
}

/// Unlink client from server
#[tauri::command]
async fn unlink_client_from_server(server_instance_id: String) -> Result<()> {
    get_server_sync_manager()
        .unlink_client(&server_instance_id)
        .await
        .map_err(|e| error::LauncherError::InvalidConfig(e))
}

/// Link modpack file to server
#[tauri::command]
async fn link_modpack_to_server(server_instance_id: String, modpack_path: String) -> Result<()> {
    get_server_sync_manager()
        .link_modpack_to_server(&server_instance_id, &modpack_path)
        .await
        .map_err(|e| error::LauncherError::InvalidConfig(e))
}

/// Get all server sync configs
#[tauri::command]
async fn get_all_server_sync_configs() -> Vec<p2p::ServerSyncConfig> {
    get_server_sync_manager().get_all_configs().await
}

/// Get published servers (local)
#[tauri::command]
async fn get_local_published_servers() -> Vec<p2p::PublishedServer> {
    get_server_sync_manager().get_published_servers().await
}

/// Get discovered servers from peers
#[tauri::command]
async fn get_discovered_servers() -> Vec<(String, p2p::PublishedServer)> {
    let servers = get_server_sync_manager().get_discovered_servers().await;
    // Extract peer_id from key format "peer_id:instance_id"
    servers
        .into_iter()
        .map(|(key, server)| {
            let peer_id = key.split(':').next().unwrap_or(&key).to_string();
            (peer_id, server)
        })
        .collect()
}

/// Publish server for P2P discovery
#[tauri::command]
async fn publish_server_for_discovery(server: p2p::PublishedServer) {
    get_server_sync_manager().publish_server(server).await;
}

/// Unpublish server from P2P discovery
#[tauri::command]
async fn unpublish_server(server_instance_id: String) {
    get_server_sync_manager()
        .unpublish_server(&server_instance_id)
        .await;
}

/// Authorize peer for server sync
#[tauri::command]
async fn authorize_server_sync_peer(server_instance_id: String, peer_id: String) -> Result<()> {
    get_server_sync_manager()
        .authorize_peer(&server_instance_id, &peer_id)
        .await
        .map_err(|e| error::LauncherError::InvalidConfig(e))
}

/// Revoke peer from server sync
#[tauri::command]
async fn revoke_server_sync_peer(server_instance_id: String, peer_id: String) -> Result<()> {
    get_server_sync_manager()
        .revoke_peer(&server_instance_id, &peer_id)
        .await
        .map_err(|e| error::LauncherError::InvalidConfig(e))
}

// ==================== Server Invite Commands ====================

/// Create a server invite
#[tauri::command]
async fn create_server_invite(
    server_instance_id: String,
    server_name: String,
    mc_version: String,
    loader: String,
    server_address: String,
    expires_in_hours: Option<u64>,
    max_uses: Option<u32>,
) -> Result<p2p::ServerInvite> {
    let expires_in = expires_in_hours.map(|h| std::time::Duration::from_secs(h * 3600));
    get_server_sync_manager()
        .create_invite(
            &server_instance_id,
            &server_name,
            &mc_version,
            &loader,
            &server_address,
            expires_in,
            max_uses,
        )
        .await
        .map_err(|e| error::LauncherError::InvalidConfig(e))
}

/// Validate a server invite code
#[tauri::command]
async fn validate_server_invite(code: String) -> Result<p2p::ServerInvite> {
    get_server_sync_manager()
        .validate_invite(&code)
        .await
        .map_err(|e| error::LauncherError::InvalidConfig(e))
}

/// Revoke a server invite
#[tauri::command]
async fn revoke_server_invite(code: String) -> Result<()> {
    get_server_sync_manager()
        .revoke_invite(&code)
        .await
        .map_err(|e| error::LauncherError::InvalidConfig(e))
}

/// Delete a server invite
#[tauri::command]
async fn delete_server_invite(code: String) -> Result<()> {
    get_server_sync_manager()
        .delete_invite(&code)
        .await
        .map_err(|e| error::LauncherError::InvalidConfig(e))
}

/// Get all invites for a server
#[tauri::command]
async fn get_server_invites(server_instance_id: String) -> Vec<p2p::ServerInvite> {
    get_server_sync_manager()
        .get_server_invites(&server_instance_id)
        .await
}

/// Get all active invites
#[tauri::command]
async fn get_all_active_invites() -> Vec<p2p::ServerInvite> {
    get_server_sync_manager().get_active_invites().await
}

/// Format invite for sharing
#[tauri::command]
fn format_invite_text(invite: p2p::ServerInvite) -> String {
    p2p::server_sync::format_invite_for_sharing(&invite)
}

/// Quick join server using invite code
/// This is the invite-based join flow:
/// 1. Validate and use the invite
/// 2. Find or create a matching client instance
/// 3. Set up the game to connect to the server
#[tauri::command]
async fn quick_join_by_invite(invite_code: String, app: tauri::AppHandle) -> Result<String> {
    log::info!("Quick join by invite: {}", invite_code);

    // 1. Validate and use the invite
    let invite = get_server_sync_manager()
        .validate_invite(&invite_code)
        .await
        .map_err(|e| error::LauncherError::InvalidConfig(e))?;

    // Emit progress event
    let _ = app.emit(
        "quick_join_status",
        serde_json::json!({
            "stage": "validating",
            "progress": 10,
            "message": "Проверка приглашения..."
        }),
    );

    // Use the invite (increment counter)
    get_server_sync_manager()
        .use_invite(&invite_code)
        .await
        .map_err(|e| error::LauncherError::InvalidConfig(e))?;

    // 2. Find a matching local instance
    let _ = app.emit(
        "quick_join_status",
        serde_json::json!({
            "stage": "finding_instance",
            "progress": 30,
            "message": "Поиск подходящего экземпляра..."
        }),
    );

    let all_instances = instances::list_instances().await?;

    // Try to find an instance with matching version and loader
    let matching_instance = all_instances.iter().find(|i| {
        matches!(i.instance_type, types::InstanceType::Client)
            && i.version == invite.mc_version
            && i.loader.as_str().to_lowercase() == invite.loader.to_lowercase()
    });

    let instance = if let Some(inst) = matching_instance {
        log::info!("Found matching instance: {} ({})", inst.name, inst.id);
        inst.clone()
    } else {
        // No matching instance - check if we have one with same modpack name
        let name_match = all_instances.iter().find(|i| {
            matches!(i.instance_type, types::InstanceType::Client) && i.name == invite.server_name
        });

        if let Some(inst) = name_match {
            log::info!("Found instance by name: {} ({})", inst.name, inst.id);
            inst.clone()
        } else {
            log::warn!(
                "No matching instance found for {} {} {}",
                invite.server_name,
                invite.mc_version,
                invite.loader
            );

            let _ = app.emit(
                "quick_join_status",
                serde_json::json!({
                    "stage": "error",
                    "progress": 0,
                    "message": "Не найден подходящий экземпляр",
                    "error": format!("Создайте экземпляр с версией {} и загрузчиком {}",
                        invite.mc_version, invite.loader)
                }),
            );

            return Err(error::LauncherError::InvalidConfig(format!(
                "No instance found for {} {} {}. Please create one first.",
                invite.server_name, invite.mc_version, invite.loader
            )));
        }
    };

    // 3. Update instance to connect to server
    let _ = app.emit(
        "quick_join_status",
        serde_json::json!({
            "stage": "configuring",
            "progress": 60,
            "message": "Настройка подключения..."
        }),
    );

    let server_arg = format!("--server {}", invite.server_address);
    let game_args = match &instance.game_args {
        Some(existing) => {
            // Remove old --server argument if present
            let cleaned: String = existing
                .split_whitespace()
                .filter(|arg| !arg.starts_with("--server"))
                .collect::<Vec<_>>()
                .join(" ");
            if cleaned.is_empty() {
                server_arg
            } else {
                format!("{} {}", cleaned, server_arg)
            }
        }
        None => server_arg,
    };

    // Update instance in database
    let conn = db::get_db_conn()?;
    conn.execute(
        "UPDATE instances SET game_args = ?1 WHERE id = ?2",
        rusqlite::params![game_args, instance.id],
    )?;

    let _ = app.emit(
        "quick_join_status",
        serde_json::json!({
            "stage": "complete",
            "progress": 100,
            "message": "Готово! Запускаем игру..."
        }),
    );

    log::info!(
        "Quick join configured: instance={}, server={}",
        instance.id,
        invite.server_address
    );

    Ok(instance.id)
}

// ==================== Network/Firewall Commands ====================

/// Diagnose P2P network issues
#[tauri::command]
async fn diagnose_p2p_network(
    discovery_port: u16,
    connect_enabled: bool,
) -> p2p::NetworkDiagnostics {
    p2p::network::diagnose_network(discovery_port, connect_enabled).await
}

/// Configure firewall for P2P (with UAC/sudo elevation)
#[tauri::command]
async fn configure_p2p_firewall(
    app_name: String,
    udp_port: u16,
    tcp_port: u16,
) -> p2p::FirewallResult {
    p2p::network::configure_firewall(&app_name, udp_port, tcp_port).await
}

/// Remove firewall rules created by Stuzhik
#[tauri::command]
async fn remove_p2p_firewall(app_name: String) -> p2p::FirewallResult {
    p2p::network::remove_firewall_rules(&app_name).await
}

/// Check if firewall is already configured
#[tauri::command]
async fn check_firewall_configured(app_name: String) -> bool {
    p2p::network::check_firewall_rules_exist(&app_name).await
}

/// Get explanation of what firewall configuration will do
#[tauri::command]
fn get_firewall_explanation(udp_port: u16, tcp_port: u16) -> String {
    p2p::network::get_firewall_explanation(udp_port, tcp_port)
}

/// Open Windows Firewall settings (Allow apps through firewall)
#[tauri::command]
fn open_firewall_settings() {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        // Open "Allow an app through Windows Firewall" panel
        let _ = std::process::Command::new("control")
            .args(["firewall.cpl"])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }

    #[cfg(target_os = "linux")]
    {
        // Try common firewall GUI apps
        let guis = ["gufw", "firewall-config", "system-config-firewall"];
        for gui in guis {
            if std::process::Command::new("which")
                .arg(gui)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
            {
                let _ = std::process::Command::new(gui).spawn();
                return;
            }
        }
        // Fallback: open system settings
        let _ = std::process::Command::new("xdg-open")
            .arg("settings://")
            .spawn();
    }

    #[cfg(target_os = "macos")]
    {
        // Open macOS Security & Privacy settings
        let _ = std::process::Command::new("open")
            .args(["x-apple.systempreferences:com.apple.preference.security?Firewall"])
            .spawn();
    }
}

/// Setup logging with file output for debugging release builds
fn setup_logging(base_dir: &std::path::Path) {
    // Use same logs directory as paths::logs_dir() for consistency
    // This allows users to find app logs in Settings -> Storage -> Logs
    let logs_dir = base_dir.join("logs");
    let _ = fs::create_dir_all(&logs_dir);

    // Create log file with session timestamp (one file per launch)
    // This is simpler than daily logs - no need to filter by session markers
    let session_id = Local::now().timestamp();
    let log_file = logs_dir.join(format!("launcher_{}.log", session_id));

    // Setup fern logger
    let file_logger = fern::Dispatch::new()
        .format(|out, message, record| {
            out.finish(format_args!(
                "[{} {} {}] {}",
                Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
                record.level(),
                record.target(),
                message
            ))
        })
        .level(log::LevelFilter::Debug)
        .level_for("hyper", log::LevelFilter::Warn)
        .level_for("reqwest", log::LevelFilter::Warn)
        .level_for("tao", log::LevelFilter::Warn)
        .level_for("wry", log::LevelFilter::Warn);

    // In debug mode: log to console + file + tauri events
    // In release mode: log to file + tauri events only
    let file_output: fern::Output = match fern::log_file(&log_file) {
        Ok(file) => file.into(),
        Err(_) => fern::Output::writer(Box::new(std::io::sink()), "\n"),
    };

    // TauriLogWriter emits events to frontend for real-time console
    let tauri_output = fern::Output::writer(Box::new(TauriLogWriter), "\n");

    #[cfg(debug_assertions)]
    let logger = file_logger
        .chain(std::io::stdout())
        .chain(file_output)
        .chain(tauri_output);

    #[cfg(not(debug_assertions))]
    let logger = file_logger.chain(file_output).chain(tauri_output);

    if let Err(e) = logger.apply() {
        eprintln!("Failed to initialize logger: {}", e);
    }

    log::info!("=== Stuzhik started ===");
    log::info!("Session ID: {}", session_id);
    log::info!("Log file: {:?}", log_file);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Инициализация путей
            let base_dir = app.path().app_data_dir().map_err(|e| {
                format!(
                    "Failed to get app data directory: {} - check system permissions",
                    e
                )
            })?;
            fs::create_dir_all(&base_dir).map_err(|e| e.to_string())?;
            paths::init_paths(base_dir.clone()).map_err(|e| e.to_string())?;

            // Set global app handle for real-time log emission (BEFORE setup_logging!)
            let _ = APP_HANDLE.set(app.handle().clone());

            // Setup logging AFTER paths are initialized AND after APP_HANDLE
            setup_logging(&base_dir);

            // Cleanup old logs (keep last 7 days)
            if let Err(e) = paths::cleanup_old_logs(7) {
                log::warn!("Failed to cleanup old logs: {}", e);
            }

            // Инициализация БД
            let mut db_path = base_dir.clone();
            db_path.push("launcher.db");
            let db_path_str = db_path.to_string_lossy().to_string();
            db::DB_PATH
                .set(db_path_str.clone())
                .map_err(|_| "failed to set DB path")?;
            db::init_db(&db_path_str).map_err(|e| e.to_string())?;

            log::info!("Launcher initialized. Base dir: {:?}", base_dir);
            log::info!("Database path: {:?}", db_path);

            // Run secure storage diagnostic test
            let test_result = secrets::run_startup_test();
            if !test_result.success {
                log::error!("Secure storage test FAILED: {}", test_result.message);
            }

            // Initialize system tray
            if let Err(e) = tray::init_tray(app.handle()) {
                log::warn!("Failed to initialize system tray: {}", e);
            }

            // Initialize server module (console, metrics)
            server::init(app.handle());

            // Очищаем мёртвые процессы
            if let Err(e) = instances::cleanup_dead_processes() {
                log::warn!("Failed to cleanup dead processes: {}", e);
            }

            // Очищаем устаревшие .part файлы и кэш-файлы модпаков
            tauri::async_runtime::spawn(async {
                modpacks::install::cleanup_stale_cache_files().await;
            });

            // Кешируем версии Minecraft при старте
            tauri::async_runtime::spawn(async move {
                if let Err(e) = minecraft::MinecraftInstaller::cache_versions().await {
                    log::warn!("Failed to cache Minecraft versions: {}", e);
                }
            });

            // Инициализируем P2P Connect если был включён
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Создаём канал для передачи событий transfer
                let (event_tx, mut event_rx) =
                    tokio::sync::mpsc::channel::<p2p::TransferEvent>(100);

                // Загружаем сохранённые настройки
                let settings = get_connect_settings();

                // Получаем путь к instances
                let instances_path = paths::instances_dir();

                // Инициализируем сервис с event channel и путём к instances
                {
                    let mut service = get_connect_service().write().await;
                    // Пересоздаём сервис с нужными параметрами
                    let data_dir = paths::get_base_dir().to_path_buf();
                    *service = p2p::ConnectService::new(data_dir)
                        .with_instances_path(instances_path)
                        .with_event_channel(event_tx);
                    service.update_settings(settings.clone()).await;

                    // Загружаем историю передач
                    if let Err(e) = service.load_history().await {
                        log::warn!("Failed to load transfer history: {}", e);
                    }
                }

                // Загружаем сохранённые конфигурации server sync
                if let Err(e) = get_server_sync_manager().load().await {
                    log::warn!("Failed to load server sync configs: {}", e);
                }

                // Если Connect был включён - запускаем discovery
                if settings.enabled {
                    log::info!("P2P Connect is enabled, starting discovery...");
                    if let Err(e) = get_connect_service().write().await.enable().await {
                        log::warn!("Failed to start P2P discovery: {}", e);
                    }
                }

                // Запускаем пересылку transfer событий в frontend
                let app_handle_events = app_handle.clone();
                tokio::spawn(async move {
                    while let Some(event) = event_rx.recv().await {
                        if let Err(e) = app_handle_events.emit("transfer-event", &event) {
                            log::warn!("Failed to emit transfer event: {}", e);
                        }
                    }
                });

                // Запускаем периодическую отправку событий об обновлении пиров
                let app_handle_clone = app_handle.clone();
                tokio::spawn(async move {
                    let mut interval = tokio::time::interval(std::time::Duration::from_secs(2));
                    loop {
                        interval.tick().await;
                        let peers = get_connect_service().read().await.get_peers().await;
                        let _ = app_handle_clone.emit("peers-updated", &peers);
                    }
                });
            });

            // Fallback: показываем окно через 10 секунд если JS ещё не показал
            // НО: не показываем если окно было скрыто для запущенной игры
            let main_window = app.get_webview_window("main");
            if let Some(window) = main_window {
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                    // Don't show if intentionally hidden for a running game
                    if tray::is_hidden_for_game() {
                        log::debug!("Window not shown - intentionally hidden for running game");
                        return;
                    }
                    if let Ok(visible) = window.is_visible() {
                        if !visible {
                            log::warn!(
                                "Window not shown by frontend after 10s, showing via Rust fallback"
                            );
                            if let Err(e) = window.show() {
                                log::error!("Failed to show window: {}", e);
                            }
                        }
                    }
                });
            }

            // Handle deep links (stuzhik:// URLs)
            #[cfg(any(windows, target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let app_handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    let urls = event.urls();
                    log::info!("Deep link received: {:?}", urls);
                    for url in urls {
                        let url_str = url.to_string();
                        // Handle stuzhik:// protocol
                        if url_str.starts_with("stuzhik://") {
                            // Parse the URL path: stuzhik://import/path or stuzhik://join/code
                            if let Some(path) = url_str.strip_prefix("stuzhik://") {
                                if path.starts_with("import/") {
                                    let file_path = path.strip_prefix("import/").unwrap_or("");
                                    let _ = app_handle.emit("open-modpack-file", file_path);
                                } else if path.starts_with("join/") {
                                    let invite_code = path.strip_prefix("join/").unwrap_or("");
                                    let _ = app_handle.emit("join-server-invite", invite_code);
                                }
                            }
                        }
                    }
                });
            }

            // Handle file arguments on first launch (double-click on .stzhk file)
            // Store in global state - frontend will request it when ready
            let args: Vec<String> = std::env::args().collect();
            if args.len() > 1 {
                let file_path = &args[1];
                if file_path.ends_with(".stzhk")
                    || file_path.ends_with(".mrpack")
                    || file_path.ends_with(".zip")
                {
                    log::info!("Storing pending modpack file from command line: {}", file_path);
                    // Store in global state for frontend to retrieve when ready
                    let storage = get_pending_modpack_storage();
                    if let Ok(mut guard) = storage.lock() {
                        *guard = Some(file_path.clone());
                    }
                }
            }

            Ok(())
        })
        .manage(Arc::new(Mutex::new(HashMap::<String, Child>::new())))
        .manage(Arc::new(Mutex::new(
            HashMap::<String, std::process::ChildStdin>::new(),
        )) as performance::StdinMap)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // Second instance was launched - focus existing window and handle file arguments
            log::info!("Second instance detected with args: {:?}", argv);

            // Focus the main window
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
                let _ = window.show();
            }

            // If arguments contain a file path, emit event to frontend
            if argv.len() > 1 {
                let file_path = &argv[1];
                // Check if it's a modpack file
                if file_path.ends_with(".stzhk")
                    || file_path.ends_with(".mrpack")
                    || file_path.ends_with(".zip")
                {
                    log::info!("Opening modpack file from second instance: {}", file_path);
                    let _ = app.emit("open-modpack-file", file_path);
                }
            }
        }))
        .invoke_handler(tauri::generate_handler![
            // Instances
            instances::lifecycle::list_instances,
            instances::lifecycle::create_instance,
            instances::execution::start_instance,
            instances::execution::stop_instance,
            instances::lifecycle::delete_instance,
            instances::lifecycle::update_instance,
            instances::lifecycle::get_instance,
            instances::installation::reinstall_instance,
            instances::installation::repair_instance,
            instances::installation::retry_instance_installation,
            instances::utilities::open_instance_folder,
            instances::utilities::reveal_instance_file,
            instances::utilities::open_file_in_editor,
            instances::utilities::open_file_in_vscode,
            instances::utilities::open_folder_in_vscode,
            instances::lifecycle::reset_instance_version,
            instances::lifecycle::convert_client_to_server,
            // Mods
            search_mods,
            install_mod,
            install_mod_by_slug,
            install_mod_local,
            install_mods_local_batch,
            verify_instance_mods,
            check_mod_updates,
            verify_mod_file,
            verify_mod_files_batch,
            list_mods,
            toggle_mod,
            toggle_mod_auto_update,
            remove_mod,
            sync_mods_folder,
            start_mods_watcher,
            stop_mods_watcher,
            is_watching_mods,
            update_mod,
            bulk_toggle_mods,
            bulk_remove_mods,
            bulk_toggle_auto_update,
            check_mod_dependencies,
            pre_launch_check,
            resolve_dependencies,
            get_dependency_graph,
            cleanup_duplicate_mods,
            clear_update_cache,
            analyze_mod_removal,
            get_mod_file_path,
            needs_dependency_enrichment,
            check_enrichment_needed,
            enrich_mod_dependencies,
            force_enrich_mod_dependencies,
            verify_mods_by_ids,
            enrich_mods_by_ids,
            // Conflict Predictor
            predict_mod_conflicts,
            get_conflicting_mods,
            has_mod_known_issues,
            // Recommendations
            get_mod_recommendations,
            // Modpacks
            search_modpacks,
            get_modpack_versions,
            get_modpack_details,
            install_modpack,
            install_modpack_from_file,
            install_modpack_from_manifest,
            reimport_manifest,
            preview_manifest_file,
            preview_modpack_file,
            preview_modpack_detailed,
            compare_modpacks,
            read_modpack_file_content,
            // Patch system
            create_modpack_patch,
            save_modpack_patch,
            load_modpack_patch,
            preview_modpack_patch,
            apply_modpack_patch,
            check_patch_compatibility,
            get_applied_patches,
            populate_patch_configs,
            // Instance Snapshot System
            create_instance_snapshot,
            get_instance_snapshot,
            delete_instance_snapshot,
            detect_instance_changes,
            create_patch_from_instance_changes,
            // Launch Tracker (blake3)
            get_launch_changes,
            save_launch_snapshot,
            delete_launch_snapshot,
            get_snapshot_history,
            get_snapshot_list,
            get_launch_changes_with_snapshot,
            mark_snapshot_result,
            link_snapshot_to_backup,
            set_max_snapshots,
            load_snapshot,
            search_mod_by_name,
            download_mod_to_path,
            get_modpack_mod_list,
            // Java
            list_java_installations,
            install_java,
            scan_system_java,
            add_custom_java,
            validate_java_path,
            get_installed_java_major_versions,
            get_java_for_version,
            set_active_java,
            check_java_compatibility,
            check_java_compatibility_for_path,
            // Minecraft versions
            fetch_minecraft_versions,
            get_loader_versions,
            // Settings
            settings::get_settings,
            settings::save_settings,
            settings::reset_settings,
            // Custom Translations
            translations::get_custom_translations,
            translations::save_custom_translations,
            translations::delete_custom_translations,
            translations::list_custom_translation_langs,
            translations::export_custom_translations,
            translations::import_custom_translations,
            translations::import_translation_file,
            // Game Settings Templates
            game_settings::save_settings_template,
            game_settings::apply_settings_template,
            game_settings::list_settings_templates,
            game_settings::delete_settings_template,
            // Global Resourcepacks & Shaderpacks
            game_settings::list_global_resourcepacks,
            game_settings::list_global_shaderpacks,
            game_settings::copy_global_resourcepacks_to_instance,
            game_settings::copy_global_shaderpacks_to_instance,
            game_settings::delete_global_resourcepack,
            game_settings::delete_global_shaderpack,
            game_settings::open_global_resourcepacks_folder,
            game_settings::open_global_shaderpacks_folder,
            // System
            get_total_memory,
            // Cancellation
            cancel_operation,
            list_active_operations,
            // File association
            get_pending_modpack_file,
            // Storage & Paths
            paths::get_storage_info,
            paths::get_app_paths,
            paths::open_app_folder,
            paths::clear_cache,
            paths::clear_logs,
            paths::get_current_log_path,
            paths::read_launcher_logs,
            paths::tail_launcher_logs,
            paths::get_orphaned_folders,
            paths::delete_orphaned_folder,
            paths::delete_all_orphaned_folders,
            paths::copy_background_image,
            paths::delete_background_image,
            paths::get_background_image_path,
            paths::get_background_image_base64,
            // Shared Resources Cleanup
            paths::get_installed_java_versions,
            paths::get_shared_resources_breakdown,
            paths::cleanup_java_version,
            paths::cleanup_all_unused_java,
            // STZHK Custom Modpack Format
            stzhk::preview_stzhk,
            stzhk::preview_stzhk_export,
            stzhk::install_stzhk,
            stzhk::install_stzhk_from_url,
            stzhk::export_stzhk,
            stzhk::verify_stzhk_instance,
            stzhk::export_mrpack,
            stzhk::export_universal_zip,
            // Log Analyzer
            log_analyzer::analyze_log_file,
            log_analyzer::analyze_instance_log,
            log_analyzer::analyze_all_instance_logs,
            log_analyzer::get_instance_log_files,
            log_analyzer::get_available_auto_fixes,
            log_analyzer::apply_auto_fix_command,
            // Crash History
            log_analyzer::get_crash_history_command,
            log_analyzer::get_crash_statistics_command,
            log_analyzer::get_crash_trends_command,
            log_analyzer::mark_crash_fixed_command,
            log_analyzer::update_crash_notes_command,
            log_analyzer::clear_crash_history_command,
            log_analyzer::cleanup_old_crashes_command,
            // Live Crash Monitor
            log_analyzer::live_monitor::init_live_monitor,
            log_analyzer::live_monitor::start_live_monitoring,
            log_analyzer::live_monitor::stop_live_monitoring,
            log_analyzer::live_monitor::is_live_monitoring,
            log_analyzer::live_monitor::get_monitored_instances,
            // Integrity Check
            integrity::check_integrity,
            integrity::quick_integrity_check,
            integrity::create_integrity_manifest,
            integrity::repair_integrity,
            // Error Reporter
            error_reporter::create_error_report,
            error_reporter::get_system_info_command,
            error_reporter::list_error_reports,
            error_reporter::get_error_report,
            error_reporter::delete_error_report,
            error_reporter::cleanup_old_reports,
            error_reporter::generate_github_issue_url,
            // Modpack Editor
            modpack_editor::create_modpack_project,
            modpack_editor::list_modpack_projects,
            modpack_editor::get_modpack_project,
            modpack_editor::update_modpack_project,
            modpack_editor::delete_modpack_project,
            modpack_editor::add_mod_to_project,
            modpack_editor::remove_mod_from_project,
            modpack_editor::reorder_project_mods,
            modpack_editor::update_project_mod,
            modpack_editor::create_optional_group,
            modpack_editor::add_mod_to_optional_group,
            modpack_editor::delete_optional_group,
            modpack_editor::export_project_to_stzhk,
            modpack_editor::create_instance_from_project,
            modpack_editor::test_modpack_project,
            modpack_editor::import_mrpack_to_project,
            // GPU Detection & Selection
            gpu::detect_gpus_command,
            gpu::get_gpu_env_vars_command,
            gpu::get_gpu_recommendation_command,
            // Knowledge Base
            save_solution_feedback,
            get_solution_rating,
            get_feedback_for_problem,
            get_top_rated_solutions,
            get_knowledge_base_stats,
            cleanup_old_feedback,
            // Backup
            backup::detect_backup_mod,
            backup::should_backup,
            backup::create_backup,
            backup::list_backups,
            backup::restore_backup,
            backup::delete_backup,
            // Performance Profiler
            performance::start_performance_monitoring,
            performance::stop_performance_monitoring,
            performance::is_performance_monitoring,
            performance::get_performance_snapshots,
            performance::get_monitored_performance_instances,
            performance::get_performance_snapshot,
            performance::detect_spark,
            performance::parse_spark_report,
            performance::get_mod_performance_from_spark,
            performance::scan_logs_for_performance,
            performance::get_performance_report,
            performance::get_performance_recommendations,
            // Spark Integration
            performance::spark::send_minecraft_command,
            performance::spark::send_spark_command_tauri,
            performance::spark::get_spark_viewer_urls,
            performance::spark::get_spark_privacy_warning,
            performance::spark::install_spark,
            performance::spark::check_spark_installed,
            // Smart Settings Sync
            sync::list_sync_profiles,
            sync::get_sync_profile,
            sync::scan_instance_settings,
            sync::get_settings_category_stats,
            sync::preview_sync,
            sync::execute_sync,
            sync::get_known_settings,
            sync::classify_setting_file,
            sync::get_category_description,
            sync::quick_sync,
            // Secure Secrets Storage
            secrets::store_auth_token,
            secrets::get_auth_token,
            secrets::delete_auth_token,
            secrets::has_auth_token,
            secrets::store_rcon_password,
            secrets::get_rcon_password,
            secrets::delete_rcon_password,
            secrets::migrate_legacy_secrets,
            // Universal secret API
            secrets::store_secret,
            secrets::get_secret,
            secrets::delete_secret,
            secrets::has_secret,
            secrets::get_storage_backend,
            secrets::test_secure_storage,
            // Shader & Resource Pack Manager
            resources::list_resources,
            resources::install_resource_from_modrinth,
            resources::install_resource_local,
            resources::toggle_resource,
            resources::remove_resource,
            resources::search_resources,
            resources::scan_resources,
            resources::get_resource_details,
            // Mod Collections
            collections::list_collections,
            collections::get_collection,
            collections::get_collection_with_mods,
            collections::get_collection_mods,
            collections::create_collection,
            collections::update_collection,
            collections::delete_collection,
            collections::add_mod_to_collection,
            collections::remove_mod_from_collection,
            collections::install_collection,
            collections::export_collection,
            collections::import_collection,
            collections::duplicate_collection,
            collections::get_collections_containing_mod,
            // Integrated Wiki
            wiki::get_mod_wiki,
            wiki::get_mod_changelog,
            // Server Management
            server::properties::get_server_properties,
            server::properties::set_server_property,
            server::properties::save_server_properties,
            server::eula::get_eula_status,
            server::eula::accept_server_eula,
            server::console::start_server,
            server::console::stop_server,
            server::console::send_server_command,
            server::console::get_server_logs,
            server::console::get_server_status,
            server::console::is_server_running,
            server::console::clear_server_logs,
            server::rcon::rcon_connect,
            server::rcon::rcon_command,
            server::rcon::rcon_disconnect,
            server::rcon::is_rcon_connected,
            server::rcon::get_rcon_config,
            server::console::send_rcon_command,
            instances::execution::force_kill_server,
            instances::execution::graceful_stop_server,
            server::metrics::get_server_metrics,
            server::metrics::start_metrics_collection,
            server::metrics::stop_metrics_collection,
            server::client_mods::scan_client_mods,
            server::client_mods::disable_client_mods_for_server,
            server::client_mods::enable_mod_file,
            server::client_mods::disable_mod_file,
            server::client_mods::get_disabled_mods_list,
            server::client_mods::enable_all_disabled_mods,
            server::players::get_player_management,
            server::players::whitelist_add,
            server::players::whitelist_remove,
            server::players::op_add,
            server::players::op_remove,
            server::players::player_ban,
            server::players::player_unban,
            server::players::ip_ban,
            server::players::ip_unban,
            server::players::lookup_player_uuid,
            server::installer::install_server_loader,
            server::installer::get_server_loader_versions,
            server::installer::get_latest_loader,
            server::import::detect_server_type,
            server::import::import_existing_server,
            // P2P / Stuzhik Connect
            get_connect_settings,
            save_connect_settings,
            get_vpn_recommendations,
            get_discovered_peers,
            start_p2p_discovery,
            stop_p2p_discovery,
            get_my_peer_id,
            get_short_code,
            connect_by_code,
            respond_to_consent,
            get_pending_consents,
            block_peer,
            unblock_peer,
            add_friend,
            remove_friend,
            send_friend_request,
            diagnose_network,
            get_firewall_explanation_cmd,
            get_friends,
            request_modpack_sync,
            quick_join_server,
            get_modpack_manifest,
            compute_sync_diff,
            get_transfer_sessions,
            cancel_transfer,
            // Transfer History
            get_transfer_history,
            get_recent_transfer_history,
            get_transfer_history_stats,
            clear_transfer_history,
            // Selective Sync
            set_selective_sync_config,
            get_selective_sync_config,
            remove_selective_sync_config,
            // Watch Mode
            add_watch_config,
            get_watch_config,
            get_all_watch_configs,
            start_watching,
            stop_watching,
            is_watching,
            get_active_watches,
            stop_all_watches,
            // Transfer Queue
            queue_transfer,
            get_transfer_queue,
            cancel_queued_transfer,
            set_transfer_priority,
            set_max_concurrent_transfers,
            retry_queued_transfer,
            clear_transfer_queue,
            // Peer Groups
            load_peer_groups,
            create_peer_group,
            delete_peer_group,
            get_peer_group,
            get_all_peer_groups,
            add_peer_to_group,
            remove_peer_from_group,
            get_groups_for_peer,
            rename_peer_group,
            // Update Notifications
            set_update_notifications_enabled,
            set_local_modpack_version,
            get_update_notifications,
            get_unread_update_notifications,
            get_unread_notification_count,
            mark_notification_read,
            mark_all_notifications_read,
            dismiss_notification,
            clear_update_notifications,
            track_modpack_updates,
            untrack_modpack_updates,
            get_peers_with_modpack,
            // Server P2P Sync
            get_server_sync_config,
            set_server_sync_config,
            link_client_to_server,
            link_modpack_to_server,
            unlink_client_from_server,
            get_all_server_sync_configs,
            get_local_published_servers,
            get_discovered_servers,
            publish_server_for_discovery,
            unpublish_server,
            authorize_server_sync_peer,
            revoke_server_sync_peer,
            // Server Invites
            create_server_invite,
            validate_server_invite,
            revoke_server_invite,
            delete_server_invite,
            get_server_invites,
            get_all_active_invites,
            format_invite_text,
            quick_join_by_invite,
            // Network/Firewall
            diagnose_p2p_network,
            configure_p2p_firewall,
            remove_p2p_firewall,
            check_firewall_configured,
            get_firewall_explanation,
            open_firewall_settings,
            // Client Mods (new API-based commands)
            server::client_mods::get_mod_info,
            server::client_mods::mark_mod_as_client_only,
            server::client_mods::mark_mod_as_server_compatible,
            // Config Editor
            list_config_files,
            read_config_file,
            write_config_file,
            backup_config_file,
            // File Browser
            browse_instance_files,
            search_instance_files,
            read_instance_file,
            write_instance_file,
            delete_instance_file,
            rename_instance_file,
            copy_instance_file,
            // Code Editor - Minecraft Data
            code_editor::rebuild_minecraft_data_cache,
            code_editor::get_minecraft_data_stats,
            code_editor::search_minecraft_items,
            code_editor::search_minecraft_blocks,
            code_editor::search_minecraft_tags,
            code_editor::search_minecraft_entries,
            code_editor::get_minecraft_mods,
            // Code Editor - Project Detection
            code_editor::project_detector::get_instance_projects,
            code_editor::project_detector::get_project_templates,
            code_editor::project_detector::create_file_from_template,
            // Code Editor - Metadata
            code_editor::metadata::detect_metadata_files,
            code_editor::metadata::parse_metadata_file,
            code_editor::metadata::save_metadata_file,
            code_editor::metadata::create_pack_mcmeta,
            // Mod Profiles
            save_mod_profile,
            list_mod_profiles,
            apply_mod_profile,
            delete_mod_profile,
            export_mod_profile,
            import_mod_profile,
            // Games
            games::get_supported_games,
            games::detect_games,
            // Hytale
            hytale::get_hytale_info,
            hytale::detect_hytale_installation,
            hytale::get_hytale_data_directory,
            hytale::launch_hytale_game,
            hytale::check_hytale_running,
            hytale::search_hytale_mods_cmd,
            hytale::get_popular_hytale_mods_cmd,
            hytale::install_hytale_mod_cmd,
            hytale::list_hytale_mods,
            hytale::remove_hytale_mod_cmd,
            // Hytale Settings & Localization
            hytale::get_hytale_settings,
            hytale::save_hytale_settings,
            hytale::get_hytale_languages,
            hytale::install_hytale_language,
            hytale::open_hytale_logs,
            // Launcher Import (MultiMC, Prism, CurseForge App, Modrinth App, generic .minecraft)
            launchers::detect_launchers,
            launchers::list_launcher_instances,
            launchers::list_detected_launcher_instances,
            launchers::import_launcher_instance,
            launchers::analyze_minecraft_folder,
            launchers::import_minecraft_folder,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            match event {
                tauri::RunEvent::Exit => {
                    log::info!("Application exiting, cleaning up...");

                    // Stop P2P services with timeout to prevent hanging
                    let rt = tokio::runtime::Handle::current();
                    let cleanup_result = rt.block_on(async {
                        tokio::time::timeout(std::time::Duration::from_secs(3), async {
                            // Stop Connect service (releases UDP/TCP ports)
                            if let Some(service) = CONNECT_SERVICE.get() {
                                log::info!("Stopping P2P Connect service...");
                                if let Ok(mut guard) = tokio::time::timeout(
                                    std::time::Duration::from_secs(1),
                                    service.write(),
                                )
                                .await
                                {
                                    guard.disable().await;
                                    log::info!("P2P Connect service stopped");
                                }
                            }

                            // Stop all watches
                            if let Some(service) = CONNECT_SERVICE.get() {
                                if let Ok(guard) = tokio::time::timeout(
                                    std::time::Duration::from_secs(1),
                                    service.read(),
                                )
                                .await
                                {
                                    guard.stop_all_watches().await;
                                }
                            }
                        })
                        .await
                    });

                    if cleanup_result.is_err() {
                        log::warn!("P2P cleanup timed out, forcing exit...");
                    }

                    // Cleanup orphaned game processes
                    instances::execution::cleanup_orphaned_processes();

                    log::info!("Cleanup complete, exiting...");
                }
                tauri::RunEvent::ExitRequested { api, .. } => {
                    // Allow exit - don't prevent it
                    log::info!("Exit requested");
                }
                _ => {}
            }
        });
}
