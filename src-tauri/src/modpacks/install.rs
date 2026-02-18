use super::{CurseForgeManifest, FailedModInfo, ModpackInstallSummary, ModpackManager, ModrinthModpackIndex};
use crate::cancellation;
use crate::downloader::{fetch_json, DownloadManager};
use crate::error::{LauncherError, Result};
use crate::instances;
use crate::paths;
use crate::settings::SettingsManager;
use crate::types::CreateInstanceRequest;
use futures::stream::{self, StreamExt};
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use tauri::Emitter;

const MODRINTH_API_BASE: &str = "https://api.modrinth.com/v2";
// Лимит concurrent futures в buffer_unordered.
// Реальная параллельность контролируется API-aware семафорами внутри DownloadManager:
// - Modrinth CDN: max 5 параллельных
// - CurseForge CDN: max 2 параллельных + 150ms inter-start throttle (предотвращает CDN burst rejects)
// - Files (прямые загрузки CDN): max 50 параллельных
// Modrinth search в try_modrinth_fallback защищён circuit breaker + single-attempt (no retries),
// поэтому высокий лимит futures безопасен.
const MAX_PARALLEL_DOWNLOADS: usize = 20;

// ========== Unified Helper Functions ==========

/// Извлекает читаемое имя мода из filename
/// "create-1.20.1-0.5.1f.jar" → "Create"
/// "jei-1.20.1-forge-15.3.0.4.jar" → "JEI"
fn extract_display_name(file_name: &str) -> String {
    let stem = file_name.trim_end_matches(".jar").trim_end_matches(".disabled");
    // Split by version-like separators
    let parts: Vec<&str> = stem.split(&['-', '_', '+'][..]).collect();
    // Take parts until we hit a version number
    let name_end = parts.iter().position(|p| {
        p.starts_with(|c: char| c.is_ascii_digit())
    }).unwrap_or(parts.len());
    if name_end > 0 {
        // Title case each word
        parts[..name_end]
            .iter()
            .map(|p| {
                let mut chars = p.chars();
                match chars.next() {
                    Some(c) => {
                        let upper: String = c.to_uppercase().collect();
                        format!("{}{}", upper, chars.collect::<String>())
                    }
                    None => String::new(),
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        stem.to_string()
    }
}

/// Generic JSON parser from archive (replaces parse_mrpack_index & parse_curseforge_manifest)
///
/// # Arguments
/// * `archive_path` - Path to the archive file (.mrpack, .zip, etc.)
/// * `json_file_name` - Name of the JSON file inside archive (e.g. "modrinth.index.json", "manifest.json")
///
/// # Example
/// ```rust
/// let index: ModrinthModpackIndex = parse_archive_json(&mrpack_path, "modrinth.index.json").await?;
/// let manifest: CurseForgeManifest = parse_archive_json(&zip_path, "manifest.json").await?;
/// ```
async fn parse_archive_json<T: DeserializeOwned + Send + 'static>(
    archive_path: &Path,
    json_file_name: &str,
) -> Result<T> {
    let path = archive_path.to_owned();
    let file_name = json_file_name.to_owned();

    tokio::task::spawn_blocking(move || {
        let file = std::fs::File::open(&path)?;
        let mut archive = zip::ZipArchive::new(file)?;
        let mut json_file = archive.by_name(&file_name).map_err(|_| {
            LauncherError::InvalidConfig(format!("File '{}' not found in archive", file_name))
        })?;
        let mut contents = String::new();
        json_file.read_to_string(&mut contents)?;
        let parsed: T = serde_json::from_str(&contents)?;
        Ok(parsed)
    })
    .await
    .map_err(|e| LauncherError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?
}

/// Generic override extractor (replaces extract_mrpack_overrides & extract_curseforge_overrides)
///
/// # Arguments
/// * `archive_path` - Path to the archive file
/// * `instance_dir` - Destination directory for extracted files
/// * `prefixes` - List of prefixes to extract (e.g. ["overrides/", "client-overrides/"])
///
/// # Example
/// ```rust
/// // Modrinth .mrpack
/// extract_archive_dirs(&mrpack_path, &instance_dir, &["overrides/", "client-overrides/"]).await?;
/// // CurseForge .zip
/// extract_archive_dirs(&zip_path, &instance_dir, &["overrides/"]).await?;
/// ```
async fn extract_archive_dirs(
    archive_path: &Path,
    instance_dir: &Path,
    prefixes: &[&str],
) -> Result<()> {
    let archive_path = archive_path.to_owned();
    let instance_dir_clone = instance_dir.to_owned();
    let prefixes: Vec<String> = prefixes.iter().map(|s| s.to_string()).collect();

    // Streaming extraction: файлы извлекаются и записываются по одному,
    // без буферизации всего архива в RAM. Это критично для больших модпаков (500+ файлов).
    tokio::task::spawn_blocking(move || {
        let file = std::fs::File::open(&archive_path)?;
        let mut archive = zip::ZipArchive::new(file)?;

        for i in 0..archive.len() {
            let mut file = archive.by_index(i)?;
            let name = file.name().to_string();

            let matched_prefix = prefixes.iter().find(|p| name.starts_with(p.as_str()));

            if let Some(prefix) = matched_prefix {
                let relative_path = name
                    .strip_prefix(prefix.as_str())
                    .and_then(|p| p.strip_prefix('/').or(Some(p)))
                    .unwrap_or(&name);

                if relative_path.is_empty() || relative_path.ends_with('/') {
                    continue;
                }

                // Path traversal protection: reject paths with ".." components
                if relative_path.contains("..") {
                    log::warn!("Path traversal blocked in archive: {}", name);
                    continue;
                }

                let dest_path = instance_dir_clone.join(relative_path);

                // Validate dest_path is within instance_dir (defense in depth)
                if !dest_path.starts_with(&instance_dir_clone) {
                    log::warn!("Path traversal blocked (escaped instance dir): {}", name);
                    continue;
                }

                if let Some(parent) = dest_path.parent() {
                    std::fs::create_dir_all(parent)?;
                }

                // Stream directly to disk — no intermediate Vec buffer
                let mut dest_file = std::fs::File::create(&dest_path)?;
                std::io::copy(&mut file, &mut dest_file)?;
            }
        }

        Ok::<_, LauncherError>(())
    })
    .await
    .map_err(|e| LauncherError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))??;

    Ok(())
}

/// Helper to emit modpack installation progress
/// Reduces repetitive emit() calls throughout the code
#[inline]
fn emit_progress(
    app_handle: &tauri::AppHandle,
    stage: &str,
    current: u32,
    total: u32,
    current_file: Option<String>,
) {
    app_handle
        .emit(
            "modpack-install-progress",
            ModpackInstallProgress {
                stage: stage.to_string(),
                current,
                total,
                current_file,
            },
        )
        .ok();
}

/// Helper to check cancellation and return error if cancelled
#[inline]
fn check_cancelled(cancel_token: &tokio_util::sync::CancellationToken) -> Result<()> {
    if cancel_token.is_cancelled() {
        Err(LauncherError::OperationCancelled)
    } else {
        Ok(())
    }
}

/// Helper to cleanup instance dir, DB record, and emit cancelled event
async fn handle_cancellation(
    instance_id: &str,
    instance_dir: &Path,
    app_handle: &tauri::AppHandle,
    completed: u32,
    total: u32,
) -> LauncherError {
    // Удаляем файлы
    let _ = tokio::fs::remove_dir_all(instance_dir).await;
    // Удаляем запись из БД (instance + связанные моды и зависимости)
    if let Ok(conn) = crate::db::get_db_conn() {
        let _ = conn.execute_batch("BEGIN TRANSACTION");
        let _ = conn.execute("DELETE FROM mod_dependencies WHERE mod_id IN (SELECT id FROM mods WHERE instance_id = ?1)", rusqlite::params![instance_id]);
        let _ = conn.execute("DELETE FROM mods WHERE instance_id = ?1", rusqlite::params![instance_id]);
        let _ = conn.execute("DELETE FROM instances WHERE id = ?1", rusqlite::params![instance_id]);
        let _ = conn.execute_batch("COMMIT");
    }
    emit_progress(app_handle, "cancelled", completed, total, None);

    // Уведомляем frontend немедленно удалить экземпляр из списка.
    // Background task (Java/MC/Loader) может ещё не обнаружить отмену,
    // поэтому это событие — единственный способ мгновенно убрать "призрак".
    app_handle
        .emit(
            "instance-removed",
            serde_json::json!({ "id": instance_id }),
        )
        .ok();

    LauncherError::OperationCancelled
}

/// Helper to cleanup instance on unexpected error (NOT cancellation)
async fn cleanup_failed_instance(
    instance_id: &str,
    instance_dir: &Path,
    app_handle: &tauri::AppHandle,
) {
    let _ = tokio::fs::remove_dir_all(instance_dir).await;
    if let Ok(conn) = crate::db::get_db_conn() {
        let _ = conn.execute_batch("BEGIN TRANSACTION");
        let _ = conn.execute("DELETE FROM mod_dependencies WHERE mod_id IN (SELECT id FROM mods WHERE instance_id = ?1)", rusqlite::params![instance_id]);
        let _ = conn.execute("DELETE FROM mods WHERE instance_id = ?1", rusqlite::params![instance_id]);
        let _ = conn.execute("DELETE FROM instances WHERE id = ?1", rusqlite::params![instance_id]);
        let _ = conn.execute_batch("COMMIT");
    }

    // Уведомляем frontend убрать экземпляр из списка
    app_handle
        .emit(
            "instance-removed",
            serde_json::json!({ "id": instance_id }),
        )
        .ok();
}

/// Parameters for creating a modpack instance (unified for mrpack/curseforge)
struct ModpackInstanceParams {
    name: String,
    mc_version: String,
    loader: String,
    loader_version: Option<String>,
    modpack_name: String,
}

/// Unified function to create instance from modpack
/// Returns (instance_id, instance_dir, mods_dir)
async fn create_modpack_instance(
    params: ModpackInstanceParams,
    app_handle: &tauri::AppHandle,
) -> Result<(String, PathBuf, PathBuf)> {
    emit_progress(app_handle, "creating_instance", 0, 1, None);

    let instance = instances::create_instance(
        CreateInstanceRequest {
            name: params.name,
            game_type: Some("minecraft".to_string()),
            version: params.mc_version,
            loader: params.loader,
            loader_version: params.loader_version,
            instance_type: "client".to_string(),
            memory_min: Some(2048),
            memory_max: Some(4096),
            java_args: None,
            game_args: None,
            port: None,
            username: None,
            notes: Some(format!("Installed from modpack: {}", params.modpack_name)),
        },
        app_handle.clone(),
    )
    .await?;

    let instance_id = instance.id.clone();

    // Notify frontend about instance creation (with installing status)
    app_handle
        .emit(
            "instance-installing",
            serde_json::json!({
                "id": instance_id,
                "name": instance.name,
            }),
        )
        .ok();

    let instance_dir = paths::instance_dir(&instance_id);
    let mods_dir = instance_dir.join("mods");
    tokio::fs::create_dir_all(&mods_dir).await?;

    Ok((instance_id, instance_dir, mods_dir))
}

// ========== Type-safe wrappers для удобства чтения кода ==========

/// Парсинг modrinth.index.json из .mrpack архива
#[inline]
async fn parse_mrpack_index(mrpack_path: &Path) -> Result<ModrinthModpackIndex> {
    parse_archive_json(mrpack_path, "modrinth.index.json").await
}

/// Парсинг manifest.json из CurseForge .zip архива
#[inline]
async fn parse_curseforge_manifest(zip_path: &Path) -> Result<CurseForgeManifest> {
    parse_archive_json(zip_path, "manifest.json").await
}

/// Распаковка overrides из .mrpack архива
#[inline]
async fn extract_mrpack_overrides(mrpack_path: &Path, instance_dir: &Path) -> Result<()> {
    extract_archive_dirs(
        mrpack_path,
        instance_dir,
        &["overrides/", "client-overrides/"],
    )
    .await
}

/// Распаковка overrides из CurseForge .zip архива (legacy wrapper)
#[inline]
async fn extract_curseforge_overrides(
    zip_path: &Path,
    instance_dir: &Path,
    overrides_folder: &str,
) -> Result<()> {
    // CurseForge uses a single overrides folder (typically "overrides")
    let prefix = if overrides_folder.ends_with('/') {
        overrides_folder.to_string()
    } else {
        format!("{}/", overrides_folder)
    };

    // Use the generic function with owned strings
    let archive_path = zip_path.to_owned();
    let instance_dir = instance_dir.to_owned();

    tokio::task::spawn_blocking(move || {
        let file = std::fs::File::open(&archive_path)?;
        let mut archive = zip::ZipArchive::new(file)?;

        for i in 0..archive.len() {
            let mut file = archive.by_index(i)?;
            let name = file.name().to_string();

            if name.starts_with(&prefix) {
                let relative_path = name.strip_prefix(&prefix).unwrap_or(&name);

                if relative_path.is_empty() || relative_path.ends_with('/') {
                    continue;
                }

                // Path traversal protection
                if relative_path.contains("..") {
                    log::warn!("Path traversal blocked in archive: {}", name);
                    continue;
                }

                let dest_path = instance_dir.join(relative_path);

                // Defense in depth: validate resolved path is within instance_dir
                if !dest_path.starts_with(&instance_dir) {
                    log::warn!("Path traversal blocked (escaped instance dir): {}", name);
                    continue;
                }

                if let Some(parent) = dest_path.parent() {
                    std::fs::create_dir_all(parent)?;
                }

                let mut dest_file = std::fs::File::create(&dest_path)?;
                std::io::copy(&mut file, &mut dest_file)?;
            }
        }

        Ok(())
    })
    .await
    .map_err(|e| LauncherError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?
}

/// Сканирование директории модов для регистрации в БД (spawn_blocking)
async fn scan_mods_dir(mods_dir: &Path) -> Vec<(String, String)> {
    let mods_dir = mods_dir.to_owned();

    tokio::task::spawn_blocking(move || {
        let mut files = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&mods_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    // Check for .jar or .jar.disabled files
                    if name.ends_with(".jar") || name.ends_with(".jar.disabled") {
                        let hash = crate::utils::calculate_sha1(&path).unwrap_or_default();
                        files.push((name.to_string(), hash));
                    }
                }
            }
        }
        files
    })
    .await
    .unwrap_or_default()
}

/// Определение формата модпака по содержимому архива (spawn_blocking)
async fn detect_modpack_format(file_path: &Path) -> Result<ModpackFormat> {
    // First check file extension for STZHK
    if let Some(ext) = file_path.extension() {
        if ext.to_str().map(|s| s.to_lowercase()) == Some("stzhk".to_string()) {
            return Ok(ModpackFormat::Stzhk);
        }
    }

    let path = file_path.to_owned();

    tokio::task::spawn_blocking(move || {
        let file = std::fs::File::open(&path)?;
        let mut archive = zip::ZipArchive::new(file)?;

        let has_modrinth_index = archive.by_name("modrinth.index.json").is_ok();
        let has_curseforge_manifest = archive.by_name("manifest.json").is_ok();

        if has_modrinth_index {
            Ok(ModpackFormat::Modrinth)
        } else if has_curseforge_manifest {
            Ok(ModpackFormat::CurseForge)
        } else {
            Err(LauncherError::InvalidConfig(
                "Unknown modpack format. Expected .mrpack (Modrinth), .zip (CurseForge) or .stzhk (Stuzhik)"
                    .to_string(),
            ))
        }
    })
    .await
    .map_err(|e| LauncherError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?
}

/// Формат модпака
enum ModpackFormat {
    Modrinth,
    CurseForge,
    Stzhk,
}

// ========== Прогресс установки ==========

#[derive(Debug, Clone, Serialize)]
pub struct ModpackInstallProgress {
    pub stage: String,
    pub current: u32,
    pub total: u32,
    pub current_file: Option<String>,
}

/// Результат ре-импорта манифеста
#[derive(Debug, Clone, Serialize)]
pub struct ReimportResult {
    pub total_in_manifest: u32,
    pub already_present: u32,
    pub downloaded: u32,
    pub failed: u32,
}

/// Источник скачивания мода
#[derive(Debug, Clone)]
enum DownloadSource {
    CurseForge,
    Modrinth,
    /// Не удалось скачать. Содержит CurseForge project_id (если известен) для последующего поиска
    Failed(Option<u64>),
    Skipped,
}

// ========== Installation Functions ==========

impl ModpackManager {
    /// Установка модпака с Modrinth
    pub async fn install_from_modrinth(
        slug: String,
        version_id: Option<String>,
        instance_name: String,
        download_manager: DownloadManager,
        app_handle: tauri::AppHandle,
    ) -> Result<String> {
        // 1. Получаем информацию о версии
        let version_url = if let Some(vid) = &version_id {
            format!("{}/version/{}", MODRINTH_API_BASE, vid)
        } else {
            let versions = Self::get_modrinth_versions(&slug, None, None).await?;
            let latest = versions
                .first()
                .ok_or_else(|| LauncherError::ModNotFound("No versions found".to_string()))?;
            format!("{}/version/{}", MODRINTH_API_BASE, latest.id)
        };

        let version: serde_json::Value = fetch_json(&version_url).await?;

        let files = version
            .get("files")
            .and_then(|f| f.as_array())
            .ok_or_else(|| LauncherError::InvalidConfig("No files in version".to_string()))?;

        let primary_file = files
            .iter()
            .find(|f| f.get("primary").and_then(|p| p.as_bool()).unwrap_or(false))
            .or_else(|| files.first())
            .ok_or_else(|| LauncherError::InvalidConfig("No primary file".to_string()))?;

        let download_url = primary_file
            .get("url")
            .and_then(|u| u.as_str())
            .ok_or_else(|| LauncherError::InvalidConfig("No download URL".to_string()))?;

        // 2. Скачиваем .mrpack
        emit_progress(
            &app_handle,
            "downloading",
            0,
            1,
            Some("modpack.mrpack".to_string()),
        );

        let cache_dir = paths::cache_dir();
        let mrpack_path = cache_dir.join(format!("{}.mrpack", slug));
        download_manager
            .download_file(download_url, &mrpack_path, "modpack", None)
            .await?;

        // 3. Устанавливаем из файла
        let cache_file = mrpack_path.clone();
        let result =
            Self::install_from_mrpack(mrpack_path, instance_name, download_manager, app_handle)
                .await;

        // Clean up cache file after installation (regardless of success/failure)
        let _ = tokio::fs::remove_file(&cache_file).await;

        result
    }

    /// Установка модпака из .mrpack файла
    pub async fn install_from_mrpack(
        mrpack_path: PathBuf,
        instance_name: String,
        download_manager: DownloadManager,
        app_handle: tauri::AppHandle,
    ) -> Result<String> {
        // Создаём токен отмены для этой операции
        let operation_id = format!("modpack-install-{}", uuid::Uuid::new_v4());
        let cancel_token = cancellation::create_token(&operation_id);

        // Отправляем ID операции клиенту для возможности отмены
        app_handle
            .emit(
                "modpack-operation-started",
                serde_json::json!({
                    "operation_id": operation_id,
                }),
            )
            .ok();

        let result = Self::install_from_mrpack_internal(
            mrpack_path,
            instance_name,
            download_manager,
            app_handle,
            cancel_token.clone(),
            operation_id.clone(),
        )
        .await;

        // Удаляем токен после завершения
        cancellation::remove_token(&operation_id);

        result
    }

    /// Внутренняя реализация установки mrpack с поддержкой отмены
    async fn install_from_mrpack_internal(
        mrpack_path: PathBuf,
        instance_name: String,
        download_manager: DownloadManager,
        app_handle: tauri::AppHandle,
        cancel_token: tokio_util::sync::CancellationToken,
        operation_id: String,
    ) -> Result<String> {
        // 1. Парсим modrinth.index.json (spawn_blocking - zip требует sync I/O)
        let index = parse_mrpack_index(&mrpack_path).await?;

        // 2. Определяем loader
        let (loader, loader_version) = if let Some(v) = &index.dependencies.fabric_loader {
            ("fabric".to_string(), Some(v.clone()))
        } else if let Some(v) = &index.dependencies.quilt_loader {
            ("quilt".to_string(), Some(v.clone()))
        } else if let Some(v) = &index.dependencies.forge {
            ("forge".to_string(), Some(v.clone()))
        } else if let Some(v) = &index.dependencies.neoforge {
            ("neoforge".to_string(), Some(v.clone()))
        } else {
            ("vanilla".to_string(), None)
        };

        // Проверка отмены
        check_cancelled(&cancel_token)?;

        // 4. Создаём экземпляр через унифицированную функцию
        let (instance_id, instance_dir, mods_dir) = create_modpack_instance(
            ModpackInstanceParams {
                name: instance_name,
                mc_version: index.dependencies.minecraft.clone(),
                loader: loader.clone(),
                loader_version,
                modpack_name: index.name.clone(),
            },
            &app_handle,
        )
        .await?;

        // 5. Скачиваем моды ПАРАЛЛЕЛЬНО с поддержкой отмены
        // Считаем только файлы модов для корректного прогресса
        let mod_files: Vec<_> = index
            .files
            .into_iter()
            .filter(|f| f.path.starts_with("mods/"))
            .collect();
        let total_mods = mod_files.len() as u32;

        // Счётчик завершённых загрузок
        let completed_count = Arc::new(AtomicU32::new(0));

        // Начальный прогресс
        emit_progress(&app_handle, "downloading_mods", 0, total_mods, None);

        // Подготавливаем задачи для параллельной загрузки с несколькими URL
        let download_tasks: Vec<_> = mod_files
            .into_iter()
            .filter_map(|mod_file| {
                let urls: Vec<String> = mod_file.downloads.into_iter().collect();
                if urls.is_empty() {
                    return None;
                }
                let file_name = Path::new(&mod_file.path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("unknown.jar")
                    .to_string();
                let dest_path = instance_dir.join(&mod_file.path);
                let hash = mod_file.hashes.sha1;

                Some((urls, dest_path, file_name, hash))
            })
            .collect();

        // Выполняем параллельную загрузку с fallback на альтернативные URL
        let download_stream = stream::iter(download_tasks)
            .map(|(urls, dest_path, file_name, hash)| {
                let dm = download_manager.clone();
                let cancel = cancel_token.clone();
                let op_id = operation_id.clone();
                let app = app_handle.clone();
                let counter = completed_count.clone();
                let total = total_mods;

                async move {
                    // Создаём родительскую директорию
                    if let Some(parent) = dest_path.parent() {
                        tokio::fs::create_dir_all(parent).await?;
                    }

                    // Дедупликация: пропускаем если файл уже существует
                    if tokio::fs::try_exists(&dest_path).await.unwrap_or(false) {
                        log::info!("Skipping already downloaded: {}", file_name);
                        let current = counter.fetch_add(1, Ordering::SeqCst) + 1;
                        emit_progress(&app, "downloading_mods", current, total, Some(file_name.clone()));
                        return Ok(());
                    }

                    // Пробуем все Modrinth URL (обычно их несколько - зеркала)
                    let mut last_error = None;
                    for url in &urls {
                        if cancel.is_cancelled() {
                            return Err(LauncherError::OperationCancelled);
                        }

                        match dm
                            .download_file_cancellable(
                                url,
                                &dest_path,
                                &file_name,
                                Some(&hash),
                                &cancel,
                                Some(&op_id),
                            )
                            .await
                        {
                            Ok(()) => {
                                let current = counter.fetch_add(1, Ordering::SeqCst) + 1;
                                emit_progress(
                                    &app,
                                    "downloading_mods",
                                    current,
                                    total,
                                    Some(file_name.clone()),
                                );
                                return Ok(());
                            }
                            Err(LauncherError::OperationCancelled) => {
                                return Err(LauncherError::OperationCancelled);
                            }
                            Err(e) => {
                                log::warn!("Download failed for {} from {}: {}", file_name, url, e);
                                last_error = Some(e);
                            }
                        }
                    }

                    // Не удалось скачать — clean up .part file
                    let _ = tokio::fs::remove_file(&clean_part_path(&dest_path)).await;

                    let current = counter.fetch_add(1, Ordering::SeqCst) + 1;
                    emit_progress(
                        &app,
                        "downloading_mods",
                        current,
                        total,
                        Some(file_name.clone()),
                    );

                    if let Some(e) = last_error {
                        log::warn!("Failed to download {}: {}", file_name, e);
                    }
                    // Return file_name as Err to track failures, but don't abort installation
                    Err(LauncherError::DownloadFailed(file_name))
                }
            })
            .buffer_unordered(MAX_PARALLEL_DOWNLOADS);

        // Collect results with cancellation support — tokio::select! drops the future
        // immediately on cancel, aborting all in-flight downloads
        let collect_fut = download_stream.collect::<Vec<Result<()>>>();
        futures::pin_mut!(collect_fut);
        let results = {
            let cancel = cancel_token.clone();
            tokio::select! {
                biased;
                _ = cancel.cancelled() => {
                    return Err(handle_cancellation(
                        &instance_id,
                        &instance_dir,
                        &app_handle,
                        completed_count.load(Ordering::SeqCst),
                        total_mods,
                    ).await);
                }
                results = &mut collect_fut => results
            }
        };

        // Проверяем результаты и собираем список неудачных загрузок
        let mut failed_mods: Vec<FailedModInfo> = Vec::new();
        for result in results {
            match result {
                Ok(()) => {}
                Err(LauncherError::OperationCancelled) => {
                    return Err(handle_cancellation(
                        &instance_id,
                        &instance_dir,
                        &app_handle,
                        completed_count.load(Ordering::SeqCst),
                        total_mods,
                    )
                    .await);
                }
                Err(LauncherError::DownloadFailed(file_name)) => {
                    // Track failed mod downloads (don't abort — continue installation)
                    failed_mods.push(FailedModInfo {
                        display_name: extract_display_name(&file_name),
                        file_name,
                        curseforge_project_id: None,
                        curseforge_file_id: None,
                    });
                }
                Err(e) => {
                    cleanup_failed_instance(&instance_id, &instance_dir, &app_handle).await;
                    return Err(e);
                }
            }
        }

        // 5.5. Распаковываем overrides (spawn_blocking - zip требует sync I/O)
        // ВАЖНО: делаем ДО регистрации модов, чтобы моды из overrides/mods/ тоже попали в БД
        emit_progress(&app_handle, "extracting_overrides", 0, 1, None);

        extract_mrpack_overrides(&mrpack_path, &instance_dir).await?;

        // 6. Регистрируем ВСЕ моды в БД (включая из overrides/mods/)
        let mod_files_info = scan_mods_dir(&mods_dir).await;

        if !mod_files_info.is_empty() {
            if let Err(e) = crate::mods::ModManager::register_modpack_mods(
                &instance_id,
                &index.dependencies.minecraft,
                &mod_files_info,
            ) {
                log::error!("Failed to register modpack mods in DB: {}", e);
            } else {
                log::info!("Registered {} mods in database", mod_files_info.len());
            }
        }

        // НЕ устанавливаем статус "stopped" здесь - установка модпака завершена,
        // но загрузчик (Forge/Fabric/etc) ещё не установлен!
        // Статус изменится на "stopped" только после полной установки в background task из create_instance.

        emit_progress(&app_handle, "completed", 1, 1, None);

        // Отправляем сводку (важно для отображения failed модов в UI)
        if !failed_mods.is_empty() {
            let summary = ModpackInstallSummary {
                total_mods,
                from_curseforge: Vec::new(),
                from_modrinth: Vec::new(),
                failed: failed_mods,
                instance_id: instance_id.clone(),
                minecraft_version: index.dependencies.minecraft.clone(),
                loader: loader.clone(),
            };
            log::warn!(
                "Mrpack install summary: {} failed out of {}",
                summary.failed.len(),
                total_mods
            );
            app_handle.emit("modpack-install-summary", &summary).ok();
        }

        // НЕ эмитим instance-created здесь - это делает background task из create_instance
        // когда установка загрузчика (Forge/Fabric/etc) полностью завершена.
        // Преждевременный instance-created приводил к тому, что кнопка "Играть"
        // становилась активной пока Forge ещё скачивается.

        Ok(instance_id)
    }

    /// Установка модпака с CurseForge
    pub async fn install_from_curseforge(
        project_id: u64,
        file_id: Option<u64>,
        instance_name: String,
        download_manager: DownloadManager,
        app_handle: tauri::AppHandle,
    ) -> Result<String> {
        // Use shared CurseForge HTTP client (connection pooling, no repeated TLS handshake)
        let http_client = crate::api::curseforge::shared_client();

        // 1. Получаем информацию о файле (with retry for connection errors)
        let file_info = if let Some(fid) = file_id {
            let url = format!(
                "https://api.curseforge.com/v1/mods/{}/files/{}",
                project_id, fid
            );
            let response: serde_json::Value =
                crate::api::curseforge::cf_api_retry("get_mod_file", || {
                    let u = url.clone();
                    async move { http_client.get(&u).send().await?.json().await }
                })
                .await?;
            response
                .get("data")
                .cloned()
                .ok_or_else(|| LauncherError::ModNotFound("File not found".to_string()))?
        } else {
            // Берём последний файл
            let url = format!(
                "https://api.curseforge.com/v1/mods/{}/files?pageSize=1",
                project_id
            );
            let response: serde_json::Value =
                crate::api::curseforge::cf_api_retry("get_latest_file", || {
                    let u = url.clone();
                    async move { http_client.get(&u).send().await?.json().await }
                })
                .await?;
            response
                .get("data")
                .and_then(|d| d.as_array())
                .and_then(|a| a.first().cloned())
                .ok_or_else(|| LauncherError::ModNotFound("No files found".to_string()))?
        };

        let download_url = file_info
            .get("downloadUrl")
            .and_then(|u| u.as_str())
            .ok_or_else(|| LauncherError::InvalidConfig("No download URL".to_string()))?;

        let file_name = file_info
            .get("fileName")
            .and_then(|n| n.as_str())
            .unwrap_or("modpack.zip");

        // 2. Скачиваем архив
        emit_progress(
            &app_handle,
            "downloading",
            0,
            1,
            Some(file_name.to_string()),
        );

        let cache_dir = paths::cache_dir();
        let zip_path = cache_dir.join(file_name);
        download_manager
            .download_file(download_url, &zip_path, "modpack", None)
            .await?;

        // 3. Устанавливаем из файла
        let cache_file = zip_path.clone();
        let result = Self::install_from_curseforge_zip(
            zip_path,
            instance_name,
            download_manager,
            app_handle,
        )
        .await;

        // Clean up cache file after installation (regardless of success/failure)
        let _ = tokio::fs::remove_file(&cache_file).await;

        result
    }

    /// Установка модпака из CurseForge .zip файла
    pub async fn install_from_curseforge_zip(
        zip_path: PathBuf,
        instance_name: String,
        download_manager: DownloadManager,
        app_handle: tauri::AppHandle,
    ) -> Result<String> {
        // Создаём токен отмены для этой операции
        let operation_id = format!("modpack-install-{}", uuid::Uuid::new_v4());
        let cancel_token = cancellation::create_token(&operation_id);

        // Отправляем ID операции клиенту для возможности отмены
        app_handle
            .emit(
                "modpack-operation-started",
                serde_json::json!({
                    "operation_id": operation_id,
                }),
            )
            .ok();

        let result = Self::install_from_curseforge_zip_internal(
            zip_path,
            instance_name,
            download_manager,
            app_handle,
            cancel_token.clone(),
            operation_id.clone(),
        )
        .await;

        // Удаляем токен после завершения
        cancellation::remove_token(&operation_id);

        result
    }

    /// Внутренняя реализация установки CurseForge zip с поддержкой отмены
    async fn install_from_curseforge_zip_internal(
        zip_path: PathBuf,
        instance_name: String,
        download_manager: DownloadManager,
        app_handle: tauri::AppHandle,
        cancel_token: tokio_util::sync::CancellationToken,
        operation_id: String,
    ) -> Result<String> {
        // 1. Парсим manifest.json (spawn_blocking - zip требует sync I/O)
        let manifest = parse_curseforge_manifest(&zip_path).await?;

        // 2. Определяем loader
        let (loader, loader_version) =
            if let Some(mod_loader) = manifest.minecraft.mod_loaders.first() {
                let id = &mod_loader.id;
                if id.starts_with("forge-") {
                    (
                        "forge".to_string(),
                        Some(id.strip_prefix("forge-").unwrap_or(id).to_string()),
                    )
                } else if id.starts_with("fabric-") {
                    (
                        "fabric".to_string(),
                        Some(id.strip_prefix("fabric-").unwrap_or(id).to_string()),
                    )
                } else if id.starts_with("neoforge-") {
                    (
                        "neoforge".to_string(),
                        Some(id.strip_prefix("neoforge-").unwrap_or(id).to_string()),
                    )
                } else if id.starts_with("quilt-") {
                    (
                        "quilt".to_string(),
                        Some(id.strip_prefix("quilt-").unwrap_or(id).to_string()),
                    )
                } else {
                    ("vanilla".to_string(), None)
                }
            } else {
                ("vanilla".to_string(), None)
            };

        // Проверка отмены
        check_cancelled(&cancel_token)?;

        // 4. Создаём экземпляр через унифицированную функцию
        let (instance_id, instance_dir, mods_dir) = create_modpack_instance(
            ModpackInstanceParams {
                name: instance_name,
                mc_version: manifest.minecraft.version.clone(),
                loader: loader.clone(),
                loader_version,
                modpack_name: manifest.name.clone(),
            },
            &app_handle,
        )
        .await?;

        // 5. Скачиваем моды ПАРАЛЛЕЛЬНО с CurseForge
        // Сначала получаем ВСЕ download URL одним батч-запросом
        let total_files = manifest.files.len() as u32;

        // Уведомляем о начале разрешения модов - CurseForge API может занять время
        emit_progress(
            &app_handle,
            "resolving_mods",
            0,
            total_files,
            Some(format!(
                "Запрос к CurseForge API ({} модов)...",
                total_files
            )),
        );

        log::info!(
            "CurseForge: requesting batch API for {} files...",
            total_files
        );

        // Use shared CurseForge HTTP client (connection pooling, no repeated TLS handshake)
        let http_client = crate::api::curseforge::shared_client();

        // Получаем все file_ids
        let file_ids: Vec<u64> = manifest.files.iter().map(|f| f.file_id).collect();

        // Разбиваем запрос на части если слишком много файлов (CurseForge может не любить большие запросы)
        let mut file_info_map: std::collections::HashMap<u64, (String, String)> =
            std::collections::HashMap::new();
        let chunk_size = 100; // По 100 файлов за запрос

        for (chunk_idx, chunk) in file_ids.chunks(chunk_size).enumerate() {
            check_cancelled(&cancel_token)?;

            let resolved_so_far = chunk_idx * chunk_size;
            emit_progress(
                &app_handle,
                "resolving_mods",
                resolved_so_far as u32,
                total_files,
                Some(format!(
                    "Получение URL модов ({}/{})...",
                    resolved_so_far, total_files
                )),
            );

            let chunk_request = serde_json::json!({ "fileIds": chunk });

            let batch_response: serde_json::Value =
                crate::api::curseforge::cf_api_retry("batch_mod_files", || {
                    let req = chunk_request.clone();
                    async move {
                        let resp = http_client
                            .post("https://api.curseforge.com/v1/mods/files")
                            .json(&req)
                            .send()
                            .await?;
                        resp.json().await
                    }
                })
                .await?;

            // Парсим ответ
            if let Some(data) = batch_response.get("data").and_then(|d| d.as_array()) {
                for file_data in data {
                    let file_id = file_data.get("id").and_then(|v| v.as_u64());
                    let file_name = file_data.get("fileName").and_then(|v| v.as_str());
                    let download_url = file_data.get("downloadUrl").and_then(|v| v.as_str());

                    if let (Some(fid), Some(fname)) = (file_id, file_name) {
                        let url = if let Some(durl) = download_url {
                            durl.to_string()
                        } else {
                            // CurseForge вернул null downloadUrl (ограниченное распространение)
                            // Конструируем URL вручную через CDN
                            let part1 = fid / 1000;
                            let part2 = fid % 1000;
                            let cdn_url = format!(
                                "https://edge.forgecdn.net/files/{}/{}/{}",
                                part1, part2, fname
                            );
                            log::info!("Constructed CDN URL for file {}: {}", fid, cdn_url);
                            cdn_url
                        };
                        file_info_map.insert(fid, (url, fname.to_string()));
                    }
                }
            }

            log::info!(
                "CurseForge batch API: chunk {} resolved, total {}/{} URLs",
                chunk_idx + 1,
                file_info_map.len(),
                total_files
            );
        }

        log::info!(
            "CurseForge batch API: resolved {}/{} file URLs",
            file_info_map.len(),
            total_files
        );

        // Проверка отмены
        check_cancelled(&cancel_token)?;

        emit_progress(&app_handle, "downloading_mods", 0, total_files, None);

        // Счётчик завершённых загрузок
        let completed_count = Arc::new(AtomicU32::new(0));
        let file_info_map = Arc::new(file_info_map);
        let manifest_mc_version = manifest.minecraft.version.clone();

        // Проверяем настройку prefer_modrinth
        let prefer_modrinth = SettingsManager::get_prefer_modrinth().unwrap_or(false);
        // Circuit breaker: skip Modrinth search after 3 consecutive failures
        let modrinth_circuit_breaker = Arc::new(AtomicU32::new(0));
        if prefer_modrinth {
            log::info!("Prefer Modrinth enabled: will try Modrinth first for CurseForge modpack mods");
        }

        // Скачиваем моды параллельно, возвращая (file_name, source)
        let download_stream =
            stream::iter(manifest.files.into_iter())
                .map(|manifest_file| {
                    let dm = download_manager.clone();
                    let cancel = cancel_token.clone();
                    let op_id = operation_id.clone();
                    let app = app_handle.clone();
                    let counter = completed_count.clone();
                    let total = total_files;
                    let mods_path = mods_dir.clone();
                    let info_map = file_info_map.clone();
                    let mc_ver = manifest_mc_version.clone();
                    let ldr = loader.clone();
                    let cb = modrinth_circuit_breaker.clone();

                    async move {
                        if cancel.is_cancelled() {
                            return Err(LauncherError::OperationCancelled);
                        }

                        // Получаем URL и имя из кэша
                        let (download_url, file_name) = match info_map.get(&manifest_file.file_id) {
                            Some((url, name)) => (url.clone(), name.clone()),
                            None => {
                                log::warn!("No cached info for file_id {}", manifest_file.file_id);
                                counter.fetch_add(1, Ordering::SeqCst);
                                return Ok((
                                    format!("file_id:{}", manifest_file.file_id),
                                    DownloadSource::Failed(Some(manifest_file.project_id)),
                                ));
                            }
                        };

                        let dest_path = mods_path.join(&file_name);

                        // Дедупликация: пропускаем если файл уже существует
                        if tokio::fs::try_exists(&dest_path).await.unwrap_or(false) {
                            log::info!("Skipping already downloaded: {}", file_name);
                            let current = counter.fetch_add(1, Ordering::SeqCst) + 1;
                            emit_progress(&app, "downloading_mods", current, total, Some(file_name.clone()));
                            return Ok((file_name, DownloadSource::Skipped));
                        }

                        // Extract mod name from filename for Modrinth search
                        let extract_mod_name = |fname: &str| -> String {
                            let stem = fname.trim_end_matches(".jar");
                            let parts: Vec<&str> = stem.split(&['-', '_', '+'][..]).collect();
                            let name_end = parts.iter().position(|p| {
                                p.starts_with(|c: char| c.is_ascii_digit())
                            }).unwrap_or(parts.len());
                            if name_end > 0 {
                                parts[..name_end].join(" ")
                            } else {
                                stem.to_string()
                            }
                        };

                        let (result, source) = if prefer_modrinth {
                            // Prefer Modrinth: try Modrinth first, CurseForge as fallback
                            let mod_name = extract_mod_name(&file_name);
                            match try_modrinth_fallback(
                                &dm, &mod_name, &file_name, &dest_path, &cancel, &op_id,
                                &mc_ver, &ldr, &cb,
                            ).await {
                                Ok(()) => {
                                    log::info!("Downloaded {} from Modrinth (preferred)", file_name);
                                    (Ok(()), DownloadSource::Modrinth)
                                }
                                Err(_) => {
                                    // Clean partial .part from Modrinth attempt before CurseForge retry
                                    let _ = tokio::fs::remove_file(&clean_part_path(&dest_path)).await;
                                    // Modrinth failed, fallback to CurseForge
                                    match dm.download_file_cancellable(
                                        &download_url, &dest_path, &file_name, None, &cancel, Some(&op_id),
                                    ).await {
                                        Ok(()) => (Ok(()), DownloadSource::CurseForge),
                                        Err(LauncherError::OperationCancelled) => {
                                            return Err(LauncherError::OperationCancelled);
                                        }
                                        Err(e) => {
                                            log::warn!("Both Modrinth and CurseForge failed for {}: {}", file_name, e);
                                            // Clean leftover .part file
                                            let _ = tokio::fs::remove_file(&clean_part_path(&dest_path)).await;
                                            (Ok(()), DownloadSource::Failed(Some(manifest_file.project_id)))
                                        }
                                    }
                                }
                            }
                        } else {
                            // Default: CurseForge first, Modrinth as fallback
                            let cf_result = dm
                                .download_file_cancellable(
                                    &download_url, &dest_path, &file_name, None, &cancel, Some(&op_id),
                                )
                                .await;

                            match cf_result {
                                Ok(()) => (Ok(()), DownloadSource::CurseForge),
                                Err(LauncherError::OperationCancelled) => {
                                    return Err(LauncherError::OperationCancelled);
                                }
                                Err(e) => {
                                    log::warn!(
                                        "CurseForge download failed for {}: {}, trying Modrinth...",
                                        file_name, e
                                    );
                                    // Clean partial .part from CurseForge attempt before Modrinth retry
                                    let _ = tokio::fs::remove_file(&clean_part_path(&dest_path)).await;
                                    let mod_name = extract_mod_name(&file_name);
                                    match try_modrinth_fallback(
                                        &dm, &mod_name, &file_name, &dest_path, &cancel, &op_id,
                                        &mc_ver, &ldr, &cb,
                                    ).await {
                                        Ok(()) => {
                                            log::info!("Successfully downloaded {} from Modrinth", file_name);
                                            (Ok(()), DownloadSource::Modrinth)
                                        }
                                        Err(modrinth_err) => {
                                            log::warn!("Modrinth fallback also failed for {}: {}", file_name, modrinth_err);
                                            // Clean leftover .part file
                                            let _ = tokio::fs::remove_file(&clean_part_path(&dest_path)).await;
                                            (Ok(()), DownloadSource::Failed(Some(manifest_file.project_id)))
                                        }
                                    }
                                }
                            }
                        };

                        // Обновляем счётчик и прогресс
                        let current = counter.fetch_add(1, Ordering::SeqCst) + 1;
                        emit_progress(
                            &app,
                            "downloading_mods",
                            current,
                            total,
                            Some(file_name.clone()),
                        );

                        result.map(|_| (file_name, source))
                    }
                })
                .buffer_unordered(MAX_PARALLEL_DOWNLOADS);

        // Collect results with cancellation support — tokio::select! drops the future
        // immediately on cancel, aborting all in-flight downloads
        let collect_fut = download_stream.collect::<Vec<std::result::Result<(String, DownloadSource), LauncherError>>>();
        futures::pin_mut!(collect_fut);
        let results = {
            let cancel = cancel_token.clone();
            tokio::select! {
                biased;
                _ = cancel.cancelled() => {
                    return Err(handle_cancellation(
                        &instance_id,
                        &instance_dir,
                        &app_handle,
                        completed_count.load(Ordering::SeqCst),
                        total_files,
                    ).await);
                }
                results = &mut collect_fut => results
            }
        };

        // Собираем статистику по источникам загрузки
        let mut from_curseforge: Vec<String> = Vec::new();
        let mut from_modrinth: Vec<String> = Vec::new();
        let mut failed: Vec<FailedModInfo> = Vec::new();

        for result in results {
            match result {
                Ok((file_name, source)) => match source {
                    DownloadSource::CurseForge => from_curseforge.push(file_name),
                    DownloadSource::Modrinth => from_modrinth.push(file_name),
                    DownloadSource::Failed(cf_project_id) => {
                        failed.push(FailedModInfo {
                            display_name: extract_display_name(&file_name),
                            file_name,
                            curseforge_project_id: cf_project_id,
                            curseforge_file_id: None,
                        });
                    }
                    DownloadSource::Skipped => {} // Уже существовал на диске — не включаем в summary
                },
                Err(LauncherError::OperationCancelled) => {
                    return Err(handle_cancellation(
                        &instance_id,
                        &instance_dir,
                        &app_handle,
                        completed_count.load(Ordering::SeqCst),
                        total_files,
                    ).await);
                }
                Err(e) => {
                    log::warn!("Download error: {}", e);
                }
            }
        }

        // Логируем статистику
        log::info!(
            "Download summary: {} from CurseForge, {} from Modrinth, {} failed",
            from_curseforge.len(),
            from_modrinth.len(),
            failed.len()
        );

        // Сохраняем сводку для отправки в конце
        let install_summary = ModpackInstallSummary {
            total_mods: total_files,
            from_curseforge,
            from_modrinth,
            failed,
            instance_id: instance_id.clone(),
            minecraft_version: manifest_mc_version.clone(),
            loader: loader.clone(),
        };

        // Финальная проверка отмены
        check_cancelled(&cancel_token)?;

        // 6. Распаковываем overrides (spawn_blocking - zip требует sync I/O)
        emit_progress(&app_handle, "extracting_overrides", 0, 1, None);

        let overrides_folder = manifest.overrides.as_deref().unwrap_or("overrides");
        extract_curseforge_overrides(&zip_path, &instance_dir, overrides_folder).await?;

        // 7. Регистрируем ВСЕ моды в БД (включая из overrides/mods/)
        let mod_files_info = scan_mods_dir(&mods_dir).await;

        if !mod_files_info.is_empty() {
            if let Err(e) = crate::mods::ModManager::register_modpack_mods(
                &instance_id,
                &manifest_mc_version,
                &mod_files_info,
            ) {
                log::error!("Failed to register modpack mods in DB: {}", e);
            } else {
                log::info!("Registered {} mods in database", mod_files_info.len());
            }
        }

        // НЕ устанавливаем статус "stopped" здесь - установка модпака завершена,
        // но загрузчик (Forge/Fabric/etc) ещё не установлен!
        // Статус изменится на "stopped" только после полной установки в background task из create_instance.

        emit_progress(&app_handle, "completed", 1, 1, None);

        // Отправляем сводку об установке (особенно важно для модов с Modrinth - могут быть не те версии!)
        app_handle
            .emit("modpack-install-summary", &install_summary)
            .ok();

        // НЕ эмитим instance-created здесь - это делает background task из create_instance
        // когда установка загрузчика (Forge/Fabric/etc) полностью завершена.

        Ok(instance_id)
    }

    /// Установка модпака из локального файла (автоопределение формата)
    pub async fn install_from_file(
        file_path: PathBuf,
        instance_name: String,
        download_manager: DownloadManager,
        app_handle: tauri::AppHandle,
    ) -> Result<String> {
        // Определяем формат модпака (spawn_blocking - zip требует sync I/O)
        let format = detect_modpack_format(&file_path).await?;

        match format {
            ModpackFormat::Modrinth => {
                Self::install_from_mrpack(file_path, instance_name, download_manager, app_handle)
                    .await
            }
            ModpackFormat::CurseForge => {
                Self::install_from_curseforge_zip(
                    file_path,
                    instance_name,
                    download_manager,
                    app_handle,
                )
                .await
            }
            ModpackFormat::Stzhk => {
                // Use STZHK installer
                crate::stzhk::StzhkManager::install(
                    &file_path,
                    instance_name,
                    vec![], // No optional mods selected by default
                    &download_manager,
                    &app_handle,
                )
                .await
            }
        }
    }
}

// ========== Helper Functions ==========

/// Compute the .part file path matching SmartDownloader's convention
/// e.g. "mod.jar" → "mod.jar.part"
#[inline]
fn clean_part_path(path: &std::path::Path) -> PathBuf {
    path.with_extension(
        path.extension()
            .map(|e| format!("{}.part", e.to_string_lossy()))
            .unwrap_or_else(|| "part".to_string()),
    )
}

/// Пробует найти и скачать мод с Modrinth как fallback
/// `circuit_breaker` — shared counter; if >= 3, skips Modrinth immediately
async fn try_modrinth_fallback(
    dm: &crate::downloader::DownloadManager,
    mod_name: &str,
    original_filename: &str,
    dest_path: &std::path::Path,
    cancel_token: &tokio_util::sync::CancellationToken,
    operation_id: &str,
    mc_version: &str,
    loader: &str,
    circuit_breaker: &AtomicU32,
) -> Result<()> {
    // Circuit breaker: skip Modrinth after 3 consecutive failures
    if circuit_breaker.load(Ordering::Relaxed) >= 3 {
        return Err(LauncherError::ApiError(
            "Modrinth search disabled (circuit breaker)".to_string(),
        ));
    }
    // Normalize loader name for Modrinth facets
    let mr_loader = match loader.to_lowercase().as_str() {
        "forge" | "neoforge" => loader.to_lowercase(),
        "fabric" => "fabric".to_string(),
        "quilt" => "quilt".to_string(),
        _ => "".to_string(),
    };

    // Strategy 1: Search by mod name with MC version and loader filters for accuracy
    let facets = if mr_loader.is_empty() {
        format!(
            "[[\"project_type:mod\"],[\"versions:{}\"]]",
            mc_version
        )
    } else {
        format!(
            "[[\"project_type:mod\"],[\"versions:{}\"],[\"categories:{}\"]]",
            mc_version, mr_loader
        )
    };

    let search_url = format!(
        "{}/search?query={}&limit=10&index=relevance&facets={}",
        MODRINTH_API_BASE,
        urlencoding::encode(mod_name),
        urlencoding::encode(&facets)
    );

    // Single attempt search (no retries) — CurseForge is our fallback
    let search_result: serde_json::Value = match modrinth_search_once(&search_url).await {
        Ok(v) => {
            // Reset circuit breaker on success
            circuit_breaker.store(0, Ordering::Relaxed);
            v
        }
        Err(e) => {
            circuit_breaker.fetch_add(1, Ordering::Relaxed);
            return Err(e);
        }
    };

    let hits = search_result
        .get("hits")
        .and_then(|h| h.as_array())
        .ok_or_else(|| {
            LauncherError::ModNotFound(format!("No Modrinth results for {}", mod_name))
        })?;

    if hits.is_empty() {
        // Strategy 2: Retry without loader filter (some mods don't tag loader correctly)
        let facets_no_loader = format!(
            "[[\"project_type:mod\"],[\"versions:{}\"]]",
            mc_version
        );
        let fallback_url = format!(
            "{}/search?query={}&limit=10&index=relevance&facets={}",
            MODRINTH_API_BASE,
            urlencoding::encode(mod_name),
            urlencoding::encode(&facets_no_loader)
        );
        let fallback_result: serde_json::Value = match modrinth_search_once(&fallback_url).await {
            Ok(v) => v,
            Err(e) => {
                circuit_breaker.fetch_add(1, Ordering::Relaxed);
                return Err(e);
            }
        };
        let fallback_hits = fallback_result
            .get("hits")
            .and_then(|h| h.as_array());

        if fallback_hits.map_or(true, |h| h.is_empty()) {
            return Err(LauncherError::ModNotFound(format!(
                "No Modrinth results for {}",
                mod_name
            )));
        }

        // Safety: fallback_hits is guaranteed Some and non-empty by the check above
        let fh = fallback_hits.expect("checked non-empty above");
        return download_modrinth_hit(dm, &fh[0], mc_version, &mr_loader, dest_path, original_filename, cancel_token, operation_id).await;
    }

    // Find best match by comparing slug/title to our mod name
    let mod_name_lower = mod_name.to_lowercase().replace(['-', '_'], "");
    let best_hit = hits.iter().find(|h| {
        let slug = h.get("slug").and_then(|s| s.as_str()).unwrap_or("");
        let title = h.get("title").and_then(|s| s.as_str()).unwrap_or("");
        let slug_norm = slug.to_lowercase().replace(['-', '_'], "");
        let title_norm = title.to_lowercase().replace(['-', '_'], "");
        slug_norm == mod_name_lower || title_norm == mod_name_lower
    }).unwrap_or(hits.first().ok_or_else(|| {
        LauncherError::ModNotFound(format!("Empty search results for {}", mod_name))
    })?);

    download_modrinth_hit(dm, best_hit, mc_version, &mr_loader, dest_path, original_filename, cancel_token, operation_id).await
}

/// Download a mod from Modrinth search hit, filtered by MC version and loader
async fn download_modrinth_hit(
    dm: &crate::downloader::DownloadManager,
    hit: &serde_json::Value,
    mc_version: &str,
    loader: &str,
    dest_path: &std::path::Path,
    original_filename: &str,
    cancel_token: &tokio_util::sync::CancellationToken,
    operation_id: &str,
) -> Result<()> {
    let project_id = hit
        .get("project_id")
        .and_then(|p| p.as_str())
        .ok_or_else(|| LauncherError::ModNotFound("Invalid Modrinth response".to_string()))?;

    // Get versions filtered by MC version and loader (single attempt)
    let mut versions_url = format!(
        "{}/project/{}/version?game_versions=[\"{}\"]",
        MODRINTH_API_BASE, project_id, mc_version
    );
    if !loader.is_empty() {
        versions_url.push_str(&format!("&loaders=[\"{}\"]", loader));
    }

    let versions: Vec<serde_json::Value> = modrinth_search_once(&versions_url)
        .await
        .and_then(|v| serde_json::from_value(v).map_err(|e| {
            LauncherError::ApiError(format!("Failed to parse versions: {}", e))
        }))?;

    if versions.is_empty() {
        return Err(LauncherError::ModNotFound(format!(
            "No compatible versions for {} on MC {}",
            project_id, mc_version
        )));
    }

    // Use first (latest) version
    let version = &versions[0];
    let files = version
        .get("files")
        .and_then(|f| f.as_array())
        .ok_or_else(|| LauncherError::ModNotFound("No files in version".to_string()))?;

    let primary_file = files
        .iter()
        .find(|f| f.get("primary").and_then(|p| p.as_bool()).unwrap_or(false))
        .or_else(|| files.first())
        .ok_or_else(|| LauncherError::ModNotFound("No files in version".to_string()))?;

    let download_url = primary_file
        .get("url")
        .and_then(|u| u.as_str())
        .ok_or_else(|| LauncherError::ModNotFound("No download URL".to_string()))?;

    dm.download_file_cancellable(
        download_url,
        dest_path,
        original_filename,
        None,
        cancel_token,
        Some(operation_id),
    )
    .await
}

/// Shared HTTP client for Modrinth search (reused across calls)
static MODRINTH_SEARCH_CLIENT: std::sync::LazyLock<reqwest::Client> =
    std::sync::LazyLock::new(|| {
        reqwest::Client::builder()
            .user_agent(crate::USER_AGENT)
            .timeout(std::time::Duration::from_secs(10))
            .connect_timeout(std::time::Duration::from_secs(5))
            .pool_max_idle_per_host(5)
            .build()
            .expect("Failed to build Modrinth search HTTP client")
    });

/// Single-attempt Modrinth search (no retries).
/// Used in prefer_modrinth fallback where CurseForge is the safety net.
/// Short timeout to avoid blocking the download pipeline.
async fn modrinth_search_once(url: &str) -> Result<serde_json::Value> {
    let response = MODRINTH_SEARCH_CLIENT
        .get(url)
        .send()
        .await
        .map_err(|e| LauncherError::ApiError(format!("Modrinth search failed: {}", e)))?;

    let status = response.status();
    if !status.is_success() {
        return Err(LauncherError::ApiError(format!(
            "Modrinth search HTTP {}: {}",
            status, url
        )));
    }

    response
        .json()
        .await
        .map_err(|e| LauncherError::ApiError(format!("Modrinth search parse error: {}", e)))
}

// ========== Standalone Manifest JSON Import ==========

/// Detect manifest format from JSON content
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ManifestFormat {
    Modrinth,
    CurseForge,
}

/// Parse standalone JSON file and determine format
pub async fn parse_standalone_manifest(json_path: &Path) -> Result<(ManifestFormat, String)> {
    let content = tokio::fs::read_to_string(json_path).await?;

    // Try to determine format
    if content.contains("\"formatVersion\"") && content.contains("\"modrinth.index.json\"")
        || content.contains("\"game\": \"minecraft\"")
    {
        Ok((ManifestFormat::Modrinth, content))
    } else if content.contains("\"manifestType\"") && content.contains("\"minecraftModpack\"") {
        Ok((ManifestFormat::CurseForge, content))
    } else if content.contains("\"files\"") && content.contains("\"dependencies\"") {
        // Modrinth format without explicit markers
        Ok((ManifestFormat::Modrinth, content))
    } else if content.contains("\"modLoaders\"") || content.contains("\"projectID\"") {
        // CurseForge format without explicit markers
        Ok((ManifestFormat::CurseForge, content))
    } else {
        Err(LauncherError::InvalidConfig(
            "Unknown manifest format. Expected Modrinth or CurseForge manifest.".to_string(),
        ))
    }
}

impl ModpackManager {
    /// Install from standalone manifest.json or modrinth.index.json
    pub async fn install_from_standalone_manifest(
        json_path: PathBuf,
        instance_name: String,
        download_manager: DownloadManager,
        app_handle: tauri::AppHandle,
    ) -> Result<String> {
        // Generate operation ID for tracking/cancellation
        let operation_id = uuid::Uuid::new_v4().to_string();
        let cancel_token = cancellation::get_or_create_token(&operation_id);

        let result = Self::install_from_standalone_manifest_internal(
            json_path,
            instance_name,
            download_manager,
            app_handle.clone(),
            cancel_token,
            operation_id.clone(),
        )
        .await;

        cancellation::remove_token(&operation_id);

        if let Err(ref e) = result {
            app_handle
                .emit(
                    "modpack-install-error",
                    serde_json::json!({
                        "error": e.to_string(),
                        "operation_id": operation_id,
                    }),
                )
                .ok();
        }

        result
    }

    async fn install_from_standalone_manifest_internal(
        json_path: PathBuf,
        instance_name: String,
        download_manager: DownloadManager,
        app_handle: tauri::AppHandle,
        cancel_token: tokio_util::sync::CancellationToken,
        operation_id: String,
    ) -> Result<String> {
        // Parse and detect format
        let (format, content) = parse_standalone_manifest(&json_path).await?;

        match format {
            ManifestFormat::Modrinth => {
                let index: ModrinthModpackIndex = serde_json::from_str(&content)?;
                Self::install_from_modrinth_manifest(
                    index,
                    instance_name,
                    download_manager,
                    app_handle,
                    cancel_token,
                    operation_id,
                )
                .await
            }
            ManifestFormat::CurseForge => {
                let manifest: CurseForgeManifest = serde_json::from_str(&content)?;
                Self::install_from_curseforge_manifest(
                    manifest,
                    instance_name,
                    download_manager,
                    app_handle,
                    cancel_token,
                    operation_id,
                )
                .await
            }
        }
    }

    /// Install from parsed Modrinth manifest (standalone or from archive)
    async fn install_from_modrinth_manifest(
        index: ModrinthModpackIndex,
        instance_name: String,
        download_manager: DownloadManager,
        app_handle: tauri::AppHandle,
        cancel_token: tokio_util::sync::CancellationToken,
        operation_id: String,
    ) -> Result<String> {
        // Determine loader from dependencies
        let (loader, loader_version) = if let Some(ref v) = index.dependencies.fabric_loader {
            ("fabric".to_string(), Some(v.clone()))
        } else if let Some(ref v) = index.dependencies.quilt_loader {
            ("quilt".to_string(), Some(v.clone()))
        } else if let Some(ref v) = index.dependencies.forge {
            ("forge".to_string(), Some(v.clone()))
        } else if let Some(ref v) = index.dependencies.neoforge {
            ("neoforge".to_string(), Some(v.clone()))
        } else {
            ("vanilla".to_string(), None)
        };

        check_cancelled(&cancel_token)?;

        // Create instance
        let (instance_id, instance_dir, mods_dir) = create_modpack_instance(
            ModpackInstanceParams {
                name: instance_name,
                mc_version: index.dependencies.minecraft.clone(),
                loader: loader.clone(),
                loader_version,
                modpack_name: index.name.clone(),
            },
            &app_handle,
        )
        .await?;

        // Filter mod files (clone to avoid lifetime issues in async closures)
        let mod_files: Vec<_> = index
            .files
            .iter()
            .filter(|f| f.path.starts_with("mods/"))
            .cloned()
            .collect();

        let total_files = mod_files.len() as u32;
        let counter = Arc::new(AtomicU32::new(0));

        emit_progress(
            &app_handle,
            "downloading_mods",
            0,
            total_files,
            Some(format!("Скачивание {} модов...", total_files)),
        );

        // Download mods in parallel
        let download_stream = stream::iter(mod_files)
            .map(|file| {
                let dm = download_manager.clone();
                let mods_path = mods_dir.clone();
                let counter = counter.clone();
                let app = app_handle.clone();
                let cancel = cancel_token.clone();
                let op_id = operation_id.clone();
                let total = total_files;

                async move {
                    check_cancelled(&cancel)?;

                    let filename = file.path.strip_prefix("mods/").unwrap_or(&file.path);
                    let dest_path = mods_path.join(filename);

                    // Try each download URL
                    let mut last_error = None;
                    for url in &file.downloads {
                        match dm
                            .download_file_cancellable(
                                url,
                                &dest_path,
                                filename,
                                None,
                                &cancel,
                                Some(&op_id),
                            )
                            .await
                        {
                            Ok(()) => {
                                let current = counter.fetch_add(1, Ordering::SeqCst) + 1;
                                emit_progress(
                                    &app,
                                    "downloading_mods",
                                    current,
                                    total,
                                    Some(filename.to_string()),
                                );
                                return Ok(filename.to_string());
                            }
                            Err(LauncherError::OperationCancelled) => {
                                return Err(LauncherError::OperationCancelled);
                            }
                            Err(e) => {
                                last_error = Some(e);
                            }
                        }
                    }

                    // Update counter even on failure, clean .part file
                    let _ = tokio::fs::remove_file(&clean_part_path(&dest_path)).await;
                    let current = counter.fetch_add(1, Ordering::SeqCst) + 1;
                    emit_progress(
                        &app,
                        "downloading_mods",
                        current,
                        total,
                        Some(filename.to_string()),
                    );

                    log::warn!("Failed to download {}: {:?}", filename, last_error);
                    Err(LauncherError::DownloadFailed(filename.to_string()))
                }
            })
            .buffer_unordered(MAX_PARALLEL_DOWNLOADS);

        // Collect with cancellation support
        let collect_fut = download_stream.collect::<Vec<Result<String>>>();
        futures::pin_mut!(collect_fut);
        let results = tokio::select! {
            biased;
            _ = cancel_token.cancelled() => {
                cleanup_failed_instance(&instance_id, &instance_dir, &app_handle).await;
                return Err(LauncherError::OperationCancelled);
            }
            results = &mut collect_fut => results
        };

        // Count successes and failures, collect failed mod names
        let mut success_count = 0;
        let mut failed_mods: Vec<FailedModInfo> = Vec::new();
        for result in &results {
            match result {
                Ok(_) => success_count += 1,
                Err(LauncherError::OperationCancelled) => {
                    cleanup_failed_instance(&instance_id, &instance_dir, &app_handle).await;
                    return Err(LauncherError::OperationCancelled);
                }
                Err(LauncherError::DownloadFailed(name)) => {
                    failed_mods.push(FailedModInfo {
                        display_name: extract_display_name(name),
                        file_name: name.clone(),
                        curseforge_project_id: None,
                        curseforge_file_id: None,
                    });
                }
                Err(_) => {
                    failed_mods.push(FailedModInfo {
                        display_name: "Unknown".to_string(),
                        file_name: "unknown".to_string(),
                        curseforge_project_id: None,
                        curseforge_file_id: None,
                    });
                }
            }
        }

        log::info!(
            "Modrinth manifest import complete: {} succeeded, {} failed",
            success_count,
            failed_mods.len()
        );

        // Register all mods in DB
        let mod_files_info = scan_mods_dir(&mods_dir).await;

        if !mod_files_info.is_empty() {
            if let Err(e) = crate::mods::ModManager::register_modpack_mods(
                &instance_id,
                &index.dependencies.minecraft,
                &mod_files_info,
            ) {
                log::error!("Failed to register modpack mods in DB: {}", e);
            } else {
                log::info!("Registered {} mods in database", mod_files_info.len());
            }
        }

        // Emit summary with failed mods for UI
        if !failed_mods.is_empty() {
            let summary = ModpackInstallSummary {
                total_mods: total_files,
                from_curseforge: Vec::new(),
                from_modrinth: Vec::new(),
                failed: failed_mods,
                instance_id: instance_id.clone(),
                minecraft_version: index.dependencies.minecraft.clone(),
                loader: loader.clone(),
            };
            app_handle.emit("modpack-install-summary", &summary).ok();
        }

        emit_progress(&app_handle, "complete", total_files, total_files, None);

        Ok(instance_id)
    }

    /// Install from parsed CurseForge manifest (standalone or from archive)
    async fn install_from_curseforge_manifest(
        manifest: CurseForgeManifest,
        instance_name: String,
        download_manager: DownloadManager,
        app_handle: tauri::AppHandle,
        cancel_token: tokio_util::sync::CancellationToken,
        operation_id: String,
    ) -> Result<String> {
        // Determine loader
        let (loader, loader_version) =
            if let Some(mod_loader) = manifest.minecraft.mod_loaders.first() {
                let id = &mod_loader.id;
                if id.starts_with("forge-") {
                    (
                        "forge".to_string(),
                        Some(id.strip_prefix("forge-").unwrap_or(id).to_string()),
                    )
                } else if id.starts_with("fabric-") {
                    (
                        "fabric".to_string(),
                        Some(id.strip_prefix("fabric-").unwrap_or(id).to_string()),
                    )
                } else if id.starts_with("neoforge-") {
                    (
                        "neoforge".to_string(),
                        Some(id.strip_prefix("neoforge-").unwrap_or(id).to_string()),
                    )
                } else if id.starts_with("quilt-") {
                    (
                        "quilt".to_string(),
                        Some(id.strip_prefix("quilt-").unwrap_or(id).to_string()),
                    )
                } else {
                    ("vanilla".to_string(), None)
                }
            } else {
                ("vanilla".to_string(), None)
            };

        check_cancelled(&cancel_token)?;

        // Create instance
        let (instance_id, instance_dir, mods_dir) = create_modpack_instance(
            ModpackInstanceParams {
                name: instance_name,
                mc_version: manifest.minecraft.version.clone(),
                loader: loader.clone(),
                loader_version,
                modpack_name: manifest.name.clone(),
            },
            &app_handle,
        )
        .await?;

        let total_files = manifest.files.len() as u32;

        emit_progress(
            &app_handle,
            "resolving_mods",
            0,
            total_files,
            Some(format!(
                "Запрос к CurseForge API ({} модов)...",
                total_files
            )),
        );

        // Use shared CurseForge HTTP client (connection pooling, no repeated TLS handshake)
        let http_client = crate::api::curseforge::shared_client();

        // Get file IDs
        let file_ids: Vec<u64> = manifest.files.iter().map(|f| f.file_id).collect();

        // Batch request to CurseForge API (with retry for connection errors)
        let file_ids_json = serde_json::json!({ "fileIds": file_ids });
        let batch_response: serde_json::Value =
            crate::api::curseforge::cf_api_retry("batch_mod_files_standalone", || {
                let req = file_ids_json.clone();
                async move {
                    let resp = http_client
                        .post("https://api.curseforge.com/v1/mods/files")
                        .json(&req)
                        .send()
                        .await?;
                    resp.json().await
                }
            })
            .await?;

        // Parse response and build download map
        let mut file_info_map: std::collections::HashMap<u64, (String, String)> =
            std::collections::HashMap::new();

        if let Some(data) = batch_response.get("data").and_then(|d| d.as_array()) {
            for file_data in data {
                if let (Some(id), Some(url), Some(filename)) = (
                    file_data.get("id").and_then(|i| i.as_u64()),
                    file_data.get("downloadUrl").and_then(|u| u.as_str()),
                    file_data.get("fileName").and_then(|f| f.as_str()),
                ) {
                    file_info_map.insert(id, (url.to_string(), filename.to_string()));
                }
            }
        }

        check_cancelled(&cancel_token)?;

        let counter = Arc::new(AtomicU32::new(0));

        emit_progress(
            &app_handle,
            "downloading_mods",
            0,
            total_files,
            Some("Скачивание модов...".to_string()),
        );

        // Download mods (clone manifest files to avoid lifetime issues in async closures)
        let download_stream = stream::iter(manifest.files.iter().cloned())
            .map(|manifest_file| {
                let dm = download_manager.clone();
                let mods_path = mods_dir.clone();
                let counter = counter.clone();
                let app = app_handle.clone();
                let cancel = cancel_token.clone();
                let op_id = operation_id.clone();
                let total = total_files;
                let file_info = file_info_map.get(&manifest_file.file_id).cloned();

                async move {
                    check_cancelled(&cancel)?;

                    let (download_url, file_name) = match file_info {
                        Some((url, name)) => (url, name),
                        None => {
                            log::warn!("No info for file_id {}", manifest_file.file_id);
                            counter.fetch_add(1, Ordering::SeqCst);
                            return Err(LauncherError::ModNotFound(format!(
                                "No download info for file {}",
                                manifest_file.file_id
                            )));
                        }
                    };

                    let dest_path = mods_path.join(&file_name);

                    let result = dm
                        .download_file_cancellable(
                            &download_url,
                            &dest_path,
                            &file_name,
                            None,
                            &cancel,
                            Some(&op_id),
                        )
                        .await;

                    let current = counter.fetch_add(1, Ordering::SeqCst) + 1;
                    emit_progress(
                        &app,
                        "downloading_mods",
                        current,
                        total,
                        Some(file_name.clone()),
                    );

                    match result {
                        Ok(()) => Ok(file_name),
                        Err(LauncherError::OperationCancelled) => Err(LauncherError::OperationCancelled),
                        Err(e) => {
                            // Clean up .part file on failure
                            let _ = tokio::fs::remove_file(&clean_part_path(&dest_path)).await;
                            log::warn!("Failed to download {}: {}", file_name, e);
                            Err(LauncherError::DownloadFailed(file_name))
                        }
                    }
                }
            })
            .buffer_unordered(MAX_PARALLEL_DOWNLOADS);

        // Collect with cancellation support
        let collect_fut = download_stream.collect::<Vec<Result<String>>>();
        futures::pin_mut!(collect_fut);
        let results = tokio::select! {
            biased;
            _ = cancel_token.cancelled() => {
                cleanup_failed_instance(&instance_id, &instance_dir, &app_handle).await;
                return Err(LauncherError::OperationCancelled);
            }
            results = &mut collect_fut => results
        };

        // Count results and collect failed mod names
        let mut success_count = 0;
        let mut failed_mods: Vec<FailedModInfo> = Vec::new();
        for result in results {
            match result {
                Ok(_) => success_count += 1,
                Err(LauncherError::OperationCancelled) => {
                    cleanup_failed_instance(&instance_id, &instance_dir, &app_handle).await;
                    return Err(LauncherError::OperationCancelled);
                }
                Err(LauncherError::DownloadFailed(name)) => {
                    failed_mods.push(FailedModInfo {
                        display_name: extract_display_name(&name),
                        file_name: name,
                        curseforge_project_id: None,
                        curseforge_file_id: None,
                    });
                }
                Err(_) => {
                    failed_mods.push(FailedModInfo {
                        display_name: "Unknown".to_string(),
                        file_name: "unknown".to_string(),
                        curseforge_project_id: None,
                        curseforge_file_id: None,
                    });
                }
            }
        }

        log::info!(
            "CurseForge manifest import complete: {} succeeded, {} failed",
            success_count,
            failed_mods.len()
        );

        // Register all mods in DB
        let mod_files_info = scan_mods_dir(&mods_dir).await;

        if !mod_files_info.is_empty() {
            if let Err(e) = crate::mods::ModManager::register_modpack_mods(
                &instance_id,
                &manifest.minecraft.version,
                &mod_files_info,
            ) {
                log::error!("Failed to register modpack mods in DB: {}", e);
            } else {
                log::info!("Registered {} mods in database", mod_files_info.len());
            }
        }

        // Emit summary with failed mods for UI
        if !failed_mods.is_empty() {
            let summary = ModpackInstallSummary {
                total_mods: total_files,
                from_curseforge: Vec::new(),
                from_modrinth: Vec::new(),
                failed: failed_mods,
                instance_id: instance_id.clone(),
                minecraft_version: manifest.minecraft.version.clone(),
                loader: loader.clone(),
            };
            app_handle.emit("modpack-install-summary", &summary).ok();
        }

        emit_progress(&app_handle, "complete", total_files, total_files, None);

        Ok(instance_id)
    }

    /// Re-import manifest for an existing instance to download missing mods
    pub async fn reimport_manifest(
        instance_id: String,
        json_path: PathBuf,
        download_manager: DownloadManager,
        app_handle: tauri::AppHandle,
    ) -> Result<ReimportResult> {
        let operation_id = format!("reimport-{}", uuid::Uuid::new_v4());
        let cancel_token = cancellation::get_or_create_token(&operation_id);

        app_handle
            .emit(
                "modpack-operation-started",
                serde_json::json!({ "operation_id": operation_id }),
            )
            .ok();

        let result = Self::reimport_manifest_internal(
            instance_id,
            json_path,
            download_manager,
            app_handle.clone(),
            cancel_token,
            operation_id.clone(),
        )
        .await;

        cancellation::remove_token(&operation_id);

        if let Err(ref e) = result {
            app_handle
                .emit(
                    "modpack-install-error",
                    serde_json::json!({
                        "error": e.to_string(),
                        "operation_id": operation_id,
                    }),
                )
                .ok();
        }

        result
    }

    async fn reimport_manifest_internal(
        instance_id: String,
        json_path: PathBuf,
        download_manager: DownloadManager,
        app_handle: tauri::AppHandle,
        cancel_token: tokio_util::sync::CancellationToken,
        operation_id: String,
    ) -> Result<ReimportResult> {
        // Get instance info
        let instance = crate::instances::get_instance(instance_id.clone()).await?;
        let instance_dir = PathBuf::from(&instance.dir);
        let mods_dir = instance_dir.join("mods");
        tokio::fs::create_dir_all(&mods_dir).await?;

        // Collect existing files in mods dir
        let mut existing_files: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut dir = tokio::fs::read_dir(&mods_dir).await?;
        while let Ok(Some(entry)) = dir.next_entry().await {
            if let Some(name) = entry.file_name().to_str() {
                existing_files.insert(name.to_lowercase());
            }
        }

        // Parse manifest
        let (format, content) = parse_standalone_manifest(&json_path).await?;
        check_cancelled(&cancel_token)?;

        match format {
            ManifestFormat::Modrinth => {
                let index: ModrinthModpackIndex = serde_json::from_str(&content)?;
                let mod_files: Vec<_> = index.files.iter()
                    .filter(|f| f.path.starts_with("mods/"))
                    .filter(|f| {
                        let filename = Path::new(&f.path)
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("");
                        !existing_files.contains(&filename.to_lowercase())
                    })
                    .cloned()
                    .collect();

                let total_missing = mod_files.len() as u32;
                let total_manifest = index.files.iter().filter(|f| f.path.starts_with("mods/")).count() as u32;

                if total_missing == 0 {
                    return Ok(ReimportResult {
                        total_in_manifest: total_manifest,
                        already_present: total_manifest,
                        downloaded: 0,
                        failed: 0,
                    });
                }

                log::info!("Re-import: {} missing of {} total mods", total_missing, total_manifest);
                let counter = Arc::new(AtomicU32::new(0));
                emit_progress(&app_handle, "downloading_mods", 0, total_missing, None);

                let download_stream = stream::iter(mod_files)
                    .map(|file| {
                        let dm = download_manager.clone();
                        let mods_path = mods_dir.clone();
                        let counter = counter.clone();
                        let app = app_handle.clone();
                        let cancel = cancel_token.clone();
                        let op_id = operation_id.clone();
                        let total = total_missing;

                        async move {
                            check_cancelled(&cancel)?;
                            let filename = file.path.strip_prefix("mods/").unwrap_or(&file.path);
                            let dest_path = mods_path.join(filename);

                            if let Some(parent) = dest_path.parent() {
                                tokio::fs::create_dir_all(parent).await?;
                            }

                            let mut last_error = None;
                            for url in &file.downloads {
                                match dm.download_file_cancellable(
                                    url, &dest_path, filename, Some(&file.hashes.sha1),
                                    &cancel, Some(&op_id),
                                ).await {
                                    Ok(()) => {
                                        let current = counter.fetch_add(1, Ordering::SeqCst) + 1;
                                        emit_progress(&app, "downloading_mods", current, total, Some(filename.to_string()));
                                        return Ok(());
                                    }
                                    Err(LauncherError::OperationCancelled) => {
                                        return Err(LauncherError::OperationCancelled);
                                    }
                                    Err(e) => { last_error = Some(e); }
                                }
                            }
                            // Clean up .part file on total failure
                            let _ = tokio::fs::remove_file(&clean_part_path(&dest_path)).await;
                            let current = counter.fetch_add(1, Ordering::SeqCst) + 1;
                            emit_progress(&app, "downloading_mods", current, total, Some(filename.to_string()));
                            Err(last_error.unwrap_or_else(|| LauncherError::DownloadFailed(format!("No URLs for {}", filename))))
                        }
                    })
                    .buffer_unordered(MAX_PARALLEL_DOWNLOADS);

                // Collect with cancellation support
                let collect_fut = download_stream.collect::<Vec<Result<()>>>();
                futures::pin_mut!(collect_fut);
                let results = tokio::select! {
                    biased;
                    _ = cancel_token.cancelled() => {
                        return Err(LauncherError::OperationCancelled);
                    }
                    results = &mut collect_fut => results
                };

                let mut downloaded = 0u32;
                let mut failed = 0u32;
                for r in results {
                    match r {
                        Ok(()) => downloaded += 1,
                        Err(LauncherError::OperationCancelled) => return Err(LauncherError::OperationCancelled),
                        Err(_) => failed += 1,
                    }
                }

                // Register newly downloaded mods in DB (skips already-registered ones)
                if downloaded > 0 {
                    let mod_files_info = scan_mods_dir(&mods_dir).await;
                    if !mod_files_info.is_empty() {
                        if let Err(e) = crate::mods::ModManager::register_modpack_mods(
                            &instance_id,
                            &instance.version,
                            &mod_files_info,
                        ) {
                            log::warn!("Failed to register reimported mods in DB: {}", e);
                        } else {
                            log::info!("Registered {} mods in database after reimport", mod_files_info.len());
                        }
                    }
                }

                emit_progress(&app_handle, "complete", total_missing, total_missing, None);

                Ok(ReimportResult {
                    total_in_manifest: total_manifest,
                    already_present: total_manifest - total_missing,
                    downloaded,
                    failed,
                })
            }
            ManifestFormat::CurseForge => {
                let manifest: CurseForgeManifest = serde_json::from_str(&content)?;
                let total_manifest = manifest.files.len() as u32;

                // Use shared CurseForge HTTP client (connection pooling, no repeated TLS handshake)
                let http_client = crate::api::curseforge::shared_client();

                let file_ids: Vec<u64> = manifest.files.iter().map(|f| f.file_id).collect();
                let file_ids_json = serde_json::json!({ "fileIds": file_ids });
                let batch_response: serde_json::Value =
                    crate::api::curseforge::cf_api_retry("batch_mod_files_reimport", || {
                        let req = file_ids_json.clone();
                        async move {
                            let resp = http_client
                                .post("https://api.curseforge.com/v1/mods/files")
                                .json(&req)
                                .send()
                                .await?;
                            resp.json().await
                        }
                    })
                    .await?;

                let mut file_info_map: std::collections::HashMap<u64, (String, String)> =
                    std::collections::HashMap::new();
                if let Some(data) = batch_response.get("data").and_then(|d| d.as_array()) {
                    for file_data in data {
                        let fid = file_data.get("id").and_then(|i| i.as_u64());
                        let fname = file_data.get("fileName").and_then(|f| f.as_str());
                        let durl = file_data.get("downloadUrl").and_then(|u| u.as_str());
                        if let (Some(id), Some(name)) = (fid, fname) {
                            let url = if let Some(u) = durl {
                                u.to_string()
                            } else {
                                let p1 = id / 1000;
                                let p2 = id % 1000;
                                format!("https://edge.forgecdn.net/files/{}/{}/{}", p1, p2, name)
                            };
                            file_info_map.insert(id, (url, name.to_string()));
                        }
                    }
                }

                // Filter out already-present files
                let missing_files: Vec<_> = manifest.files.iter()
                    .filter(|f| {
                        if let Some((_, fname)) = file_info_map.get(&f.file_id) {
                            !existing_files.contains(&fname.to_lowercase())
                        } else {
                            true // Unknown files are "missing"
                        }
                    })
                    .cloned()
                    .collect();

                let total_missing = missing_files.len() as u32;

                if total_missing == 0 {
                    return Ok(ReimportResult {
                        total_in_manifest: total_manifest,
                        already_present: total_manifest,
                        downloaded: 0,
                        failed: 0,
                    });
                }

                log::info!("Re-import: {} missing of {} total mods", total_missing, total_manifest);
                let counter = Arc::new(AtomicU32::new(0));
                emit_progress(&app_handle, "downloading_mods", 0, total_missing, None);

                let mc_ver = manifest.minecraft.version.clone();
                let ldr = if let Some(ml) = manifest.minecraft.mod_loaders.first() {
                    let id = &ml.id;
                    if let Some(l) = id.split('-').next() { l.to_string() } else { String::new() }
                } else { String::new() };
                let prefer_modrinth = SettingsManager::get_prefer_modrinth().unwrap_or(false);
                let modrinth_circuit_breaker = Arc::new(AtomicU32::new(0));

                let download_stream = stream::iter(missing_files)
                    .map(|mf| {
                        let dm = download_manager.clone();
                        let mods_path = mods_dir.clone();
                        let counter = counter.clone();
                        let app = app_handle.clone();
                        let cancel = cancel_token.clone();
                        let op_id = operation_id.clone();
                        let total = total_missing;
                        let info = file_info_map.get(&mf.file_id).cloned();
                        let mc = mc_ver.clone();
                        let loader = ldr.clone();
                        let cb = modrinth_circuit_breaker.clone();

                        async move {
                            check_cancelled(&cancel)?;
                            let (download_url, file_name) = match info {
                                Some(i) => i,
                                None => {
                                    counter.fetch_add(1, Ordering::SeqCst);
                                    return Err(LauncherError::ModNotFound(format!("No info for file {}", mf.file_id)));
                                }
                            };
                            let dest_path = mods_path.join(&file_name);

                            // Skip if already exists (race condition guard)
                            if tokio::fs::try_exists(&dest_path).await.unwrap_or(false) {
                                let current = counter.fetch_add(1, Ordering::SeqCst) + 1;
                                emit_progress(&app, "downloading_mods", current, total, Some(file_name.clone()));
                                return Ok(());
                            }

                            let result = if prefer_modrinth {
                                let stem = file_name.trim_end_matches(".jar");
                                let parts: Vec<&str> = stem.split(&['-', '_', '+'][..]).collect();
                                let name_end = parts.iter().position(|p| p.starts_with(|c: char| c.is_ascii_digit())).unwrap_or(parts.len());
                                let mod_name = if name_end > 0 { parts[..name_end].join(" ") } else { stem.to_string() };
                                match try_modrinth_fallback(&dm, &mod_name, &file_name, &dest_path, &cancel, &op_id, &mc, &loader, &cb).await {
                                    Ok(()) => Ok(()),
                                    Err(_) => {
                                        // Clean .part from Modrinth attempt before CurseForge retry
                                        let _ = tokio::fs::remove_file(&clean_part_path(&dest_path)).await;
                                        dm.download_file_cancellable(&download_url, &dest_path, &file_name, None, &cancel, Some(&op_id)).await
                                    }
                                }
                            } else {
                                dm.download_file_cancellable(&download_url, &dest_path, &file_name, None, &cancel, Some(&op_id)).await
                            };

                            let current = counter.fetch_add(1, Ordering::SeqCst) + 1;
                            emit_progress(&app, "downloading_mods", current, total, Some(file_name.clone()));

                            if result.is_err() {
                                // Clean up .part file on total failure
                                let _ = tokio::fs::remove_file(&clean_part_path(&dest_path)).await;
                            }
                            result
                        }
                    })
                    .buffer_unordered(MAX_PARALLEL_DOWNLOADS);

                // Collect with cancellation support
                let collect_fut = download_stream.collect::<Vec<Result<()>>>();
                futures::pin_mut!(collect_fut);
                let results = tokio::select! {
                    biased;
                    _ = cancel_token.cancelled() => {
                        return Err(LauncherError::OperationCancelled);
                    }
                    results = &mut collect_fut => results
                };

                let mut downloaded = 0u32;
                let mut failed = 0u32;
                for r in results {
                    match r {
                        Ok(()) => downloaded += 1,
                        Err(LauncherError::OperationCancelled) => return Err(LauncherError::OperationCancelled),
                        Err(_) => failed += 1,
                    }
                }

                // Register newly downloaded mods in DB (skips already-registered ones)
                if downloaded > 0 {
                    let mod_files_info = scan_mods_dir(&mods_dir).await;
                    if !mod_files_info.is_empty() {
                        if let Err(e) = crate::mods::ModManager::register_modpack_mods(
                            &instance_id,
                            &instance.version,
                            &mod_files_info,
                        ) {
                            log::warn!("Failed to register reimported mods in DB: {}", e);
                        } else {
                            log::info!("Registered {} mods in database after reimport", mod_files_info.len());
                        }
                    }
                }

                emit_progress(&app_handle, "complete", total_missing, total_missing, None);

                Ok(ReimportResult {
                    total_in_manifest: total_manifest,
                    already_present: total_manifest - total_missing,
                    downloaded,
                    failed,
                })
            }
        }
    }
}

/// Clean up stale .part files and old cache files on startup.
/// Removes .part files older than 24 hours that were left from interrupted downloads.
pub async fn cleanup_stale_cache_files() {
    let cache_dir = crate::paths::cache_dir();

    if !tokio::fs::try_exists(&cache_dir).await.unwrap_or(false) {
        return;
    }

    let Ok(mut entries) = tokio::fs::read_dir(&cache_dir).await else {
        return;
    };

    let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(24 * 60 * 60);

    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");

        // Clean up .part files older than 24h
        if file_name.ends_with(".part") {
            if let Ok(metadata) = tokio::fs::metadata(&path).await {
                if let Ok(modified) = metadata.modified() {
                    if modified < cutoff {
                        log::info!("Cleaning stale .part file: {}", file_name);
                        let _ = tokio::fs::remove_file(&path).await;
                    }
                }
            }
        }
    }
}
