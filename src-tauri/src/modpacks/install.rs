use super::{CurseForgeManifest, ModpackManager, ModrinthModpackIndex};
use crate::api::curseforge::CurseForgeClient;
use crate::cancellation;
use crate::downloader::{fetch_json, DownloadManager};
use crate::error::{LauncherError, Result};
use crate::instances;
use crate::paths;
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
// ВАЖНО: Этот лимит контролирует количество одновременных future в buffer_unordered,
// но реальная параллельность контролируется API-aware семафорами внутри DownloadManager:
// - Modrinth: max 5 параллельных
// - CurseForge: max 2 параллельных
// - Files (прямые загрузки): max 10 параллельных
// Поэтому безопасно ставить высокий лимит - семафоры не дадут нарушить rate limits
const MAX_PARALLEL_DOWNLOADS: usize = 20; // Параллельных future (семафоры контролируют реальную параллельность)

// ========== Unified Helper Functions ==========

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

    // Фаза 1: Читаем все файлы в память (spawn_blocking т.к. zip sync)
    let files_to_write: Vec<(PathBuf, Vec<u8>)> = tokio::task::spawn_blocking(move || {
        let file = std::fs::File::open(&archive_path)?;
        let mut archive = zip::ZipArchive::new(file)?;
        let mut files: Vec<(PathBuf, Vec<u8>)> = Vec::new();
        let mut dirs: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();

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

                let dest_path = instance_dir_clone.join(relative_path);

                // Собираем директории для создания
                if let Some(parent) = dest_path.parent() {
                    dirs.insert(parent.to_owned());
                }

                // Читаем содержимое в память
                let mut contents = Vec::new();
                std::io::Read::read_to_end(&mut file, &mut contents)?;
                files.push((dest_path, contents));
            }
        }

        // Создаём все директории сразу
        for dir in dirs {
            std::fs::create_dir_all(dir)?;
        }

        Ok::<_, LauncherError>(files)
    })
    .await
    .map_err(|e| LauncherError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))??;

    // Фаза 2: Пишем файлы параллельно через tokio::fs
    let write_tasks: Vec<_> = files_to_write
        .into_iter()
        .map(|(path, contents)| {
            tokio::spawn(async move { tokio::fs::write(&path, contents).await })
        })
        .collect();

    // Ждём завершения всех записей
    for task in write_tasks {
        task.await
            .map_err(|e| LauncherError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?
            .map_err(LauncherError::Io)?;
    }

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

/// Helper to cleanup instance dir and emit cancelled event
async fn handle_cancellation(
    instance_dir: &Path,
    app_handle: &tauri::AppHandle,
    completed: u32,
    total: u32,
) -> LauncherError {
    let _ = tokio::fs::remove_dir_all(instance_dir).await;
    emit_progress(app_handle, "cancelled", completed, total, None);
    LauncherError::OperationCancelled
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

                let dest_path = instance_dir.join(relative_path);
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

/// Итоги установки модпака
#[derive(Debug, Clone, Serialize)]
pub struct ModpackInstallSummary {
    pub total_mods: u32,
    pub from_curseforge: Vec<String>,
    pub from_modrinth: Vec<String>,
    pub failed: Vec<String>,
}

/// Источник скачивания мода
#[derive(Debug, Clone)]
enum DownloadSource {
    CurseForge,
    Modrinth,
    Failed,
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
        Self::install_from_mrpack(mrpack_path, instance_name, download_manager, app_handle).await
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
        let results: Vec<Result<()>> = stream::iter(download_tasks)
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

                    // Не удалось скачать
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
                    Ok(()) // Продолжаем установку
                }
            })
            .buffer_unordered(MAX_PARALLEL_DOWNLOADS)
            .collect()
            .await;

        // Проверяем результаты
        for result in results {
            match result {
                Ok(()) => {}
                Err(LauncherError::OperationCancelled) => {
                    return Err(handle_cancellation(
                        &instance_dir,
                        &app_handle,
                        completed_count.load(Ordering::SeqCst),
                        total_mods,
                    )
                    .await);
                }
                Err(e) => {
                    let _ = tokio::fs::remove_dir_all(&instance_dir).await;
                    return Err(e);
                }
            }
        }

        // Финальная проверка отмены
        if cancel_token.is_cancelled() {
            return Err(handle_cancellation(&instance_dir, &app_handle, 0, 0).await);
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
                log::warn!("Failed to register modpack mods in DB: {}", e);
            } else {
                log::info!("Registered {} mods in database", mod_files_info.len());
            }
        }

        // НЕ устанавливаем статус "stopped" здесь - установка модпака завершена,
        // но загрузчик (Forge/Fabric/etc) ещё не установлен!
        // Статус изменится на "stopped" только после полной установки в background task из create_instance.

        emit_progress(&app_handle, "completed", 1, 1, None);

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
        let _client = CurseForgeClient::new()?;

        // 1. Получаем информацию о файле
        let file_info = if let Some(fid) = file_id {
            let url = format!(
                "https://api.curseforge.com/v1/mods/{}/files/{}",
                project_id, fid
            );
            let http_client = reqwest::Client::builder()
                .user_agent(crate::USER_AGENT)
                .default_headers({
                    let mut headers = reqwest::header::HeaderMap::new();
                    headers.insert(
                        "x-api-key",
                        "$2a$10$bL4bIL5pUWqfcO7KQtnMReakwtfHbNKh6v1uTpKlzhwoueEJQnPnm"
                            .parse()
                            .expect("valid API key header value"),
                    );
                    headers
                })
                .build()?;
            let response: serde_json::Value = http_client.get(&url).send().await?.json().await?;
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
            let http_client = reqwest::Client::builder()
                .user_agent(crate::USER_AGENT)
                .default_headers({
                    let mut headers = reqwest::header::HeaderMap::new();
                    headers.insert(
                        "x-api-key",
                        "$2a$10$bL4bIL5pUWqfcO7KQtnMReakwtfHbNKh6v1uTpKlzhwoueEJQnPnm"
                            .parse()
                            .expect("valid API key header value"),
                    );
                    headers
                })
                .build()?;
            let response: serde_json::Value = http_client.get(&url).send().await?.json().await?;
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
        Self::install_from_curseforge_zip(zip_path, instance_name, download_manager, app_handle)
            .await
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

        let http_client = reqwest::Client::builder()
            .user_agent(crate::USER_AGENT)
            .timeout(std::time::Duration::from_secs(120)) // Увеличиваем таймаут для больших модпаков
            .default_headers({
                let mut headers = reqwest::header::HeaderMap::new();
                headers.insert(
                    "x-api-key",
                    "$2a$10$bL4bIL5pUWqfcO7KQtnMReakwtfHbNKh6v1uTpKlzhwoueEJQnPnm"
                        .parse()
                        .unwrap(),
                );
                headers
            })
            .build()?;

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

            let batch_response: serde_json::Value = http_client
                .post("https://api.curseforge.com/v1/mods/files")
                .json(&chunk_request)
                .send()
                .await?
                .json()
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

        // Скачиваем моды параллельно, возвращая (file_name, source)
        let results: Vec<std::result::Result<(String, DownloadSource), LauncherError>> =
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
                                    DownloadSource::Failed,
                                ));
                            }
                        };

                        let dest_path = mods_path.join(&file_name);

                        // Пробуем скачать с CurseForge/CDN
                        let cf_result = dm
                            .download_file_cancellable(
                                &download_url,
                                &dest_path,
                                &file_name,
                                None,
                                &cancel,
                                Some(&op_id),
                            )
                            .await;

                        let (result, source) = match cf_result {
                            Ok(()) => (Ok(()), DownloadSource::CurseForge),
                            Err(LauncherError::OperationCancelled) => {
                                return Err(LauncherError::OperationCancelled);
                            }
                            Err(e) => {
                                // CurseForge не сработал, пробуем Modrinth
                                log::warn!(
                                    "CurseForge download failed for {}: {}, trying Modrinth...",
                                    file_name,
                                    e
                                );

                                // Извлекаем имя мода из filename (убираем версию и .jar)
                                let mod_name = file_name
                                    .trim_end_matches(".jar")
                                    .split('-')
                                    .next()
                                    .unwrap_or(&file_name);

                                // Ищем на Modrinth
                                match try_modrinth_fallback(
                                    &dm, mod_name, &file_name, &dest_path, &cancel, &op_id,
                                )
                                .await
                                {
                                    Ok(()) => {
                                        log::info!(
                                            "Successfully downloaded {} from Modrinth",
                                            file_name
                                        );
                                        (Ok(()), DownloadSource::Modrinth)
                                    }
                                    Err(modrinth_err) => {
                                        log::warn!(
                                            "Modrinth fallback also failed for {}: {}",
                                            file_name,
                                            modrinth_err
                                        );
                                        (Ok(()), DownloadSource::Failed)
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
                .buffer_unordered(MAX_PARALLEL_DOWNLOADS)
                .collect()
                .await;

        // Собираем статистику по источникам загрузки
        let mut from_curseforge: Vec<String> = Vec::new();
        let mut from_modrinth: Vec<String> = Vec::new();
        let mut failed: Vec<String> = Vec::new();
        let mut has_cancelled = false;

        for result in results {
            match result {
                Ok((file_name, source)) => match source {
                    DownloadSource::CurseForge => from_curseforge.push(file_name),
                    DownloadSource::Modrinth => from_modrinth.push(file_name),
                    DownloadSource::Failed => failed.push(file_name),
                },
                Err(LauncherError::OperationCancelled) => {
                    has_cancelled = true;
                    break;
                }
                Err(e) => {
                    log::warn!("Download error: {}", e);
                }
            }
        }

        if has_cancelled {
            return Err(handle_cancellation(
                &instance_dir,
                &app_handle,
                completed_count.load(Ordering::SeqCst),
                total_files,
            )
            .await);
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
        };

        // Финальная проверка отмены
        check_cancelled(&cancel_token)?;

        // 6. Распаковываем overrides (spawn_blocking - zip требует sync I/O)
        emit_progress(&app_handle, "extracting_overrides", 0, 1, None);

        let overrides_folder = manifest.overrides.as_deref().unwrap_or("overrides");
        extract_curseforge_overrides(&zip_path, &instance_dir, overrides_folder).await?;

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

/// Пробует найти и скачать мод с Modrinth как fallback
async fn try_modrinth_fallback(
    dm: &crate::downloader::DownloadManager,
    mod_name: &str,
    original_filename: &str,
    dest_path: &std::path::Path,
    cancel_token: &tokio_util::sync::CancellationToken,
    operation_id: &str,
) -> Result<()> {
    use crate::downloader::fetch_json;

    // Ищем мод на Modrinth по имени
    let search_url = format!(
        "{}/search?query={}&limit=5&facets=[[\"project_type:mod\"]]",
        MODRINTH_API_BASE,
        urlencoding::encode(mod_name)
    );

    let search_result: serde_json::Value = fetch_json(&search_url).await?;

    let hits = search_result
        .get("hits")
        .and_then(|h| h.as_array())
        .ok_or_else(|| {
            LauncherError::ModNotFound(format!("No Modrinth results for {}", mod_name))
        })?;

    if hits.is_empty() {
        return Err(LauncherError::ModNotFound(format!(
            "No Modrinth results for {}",
            mod_name
        )));
    }

    // Берём первый результат
    let project_id = hits[0]
        .get("project_id")
        .and_then(|p| p.as_str())
        .ok_or_else(|| LauncherError::ModNotFound("Invalid Modrinth response".to_string()))?;

    // Получаем версии мода
    let versions_url = format!("{}/project/{}/version", MODRINTH_API_BASE, project_id);
    let versions: Vec<serde_json::Value> = fetch_json(&versions_url).await?;

    if versions.is_empty() {
        return Err(LauncherError::ModNotFound(format!(
            "No versions found for {}",
            mod_name
        )));
    }

    // Берём первую версию и её primary файл
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

    // Скачиваем
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
        let (instance_id, _instance_dir, mods_dir) = create_modpack_instance(
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
        let results: Vec<Result<String>> = stream::iter(mod_files)
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

                    // Update counter even on failure
                    let current = counter.fetch_add(1, Ordering::SeqCst) + 1;
                    emit_progress(
                        &app,
                        "downloading_mods",
                        current,
                        total,
                        Some(filename.to_string()),
                    );

                    Err(last_error.unwrap_or_else(|| {
                        LauncherError::DownloadFailed(format!("No download URLs for {}", filename))
                    }))
                }
            })
            .buffer_unordered(MAX_PARALLEL_DOWNLOADS)
            .collect()
            .await;

        // Count successes and failures
        let mut success_count = 0;
        let mut failed_count = 0;
        for result in results {
            match result {
                Ok(_) => success_count += 1,
                Err(LauncherError::OperationCancelled) => {
                    return Err(LauncherError::OperationCancelled);
                }
                Err(_) => failed_count += 1,
            }
        }

        log::info!(
            "Modrinth manifest import complete: {} succeeded, {} failed",
            success_count,
            failed_count
        );

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
        let (instance_id, _instance_dir, mods_dir) = create_modpack_instance(
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

        // Build HTTP client with CurseForge API key
        let http_client = reqwest::Client::builder()
            .user_agent(crate::USER_AGENT)
            .timeout(std::time::Duration::from_secs(120))
            .default_headers({
                let mut headers = reqwest::header::HeaderMap::new();
                headers.insert(
                    "x-api-key",
                    "$2a$10$bL4bIL5pUWqfcO7KQtnMReakwtfHbNKh6v1uTpKlzhwoueEJQnPnm"
                        .parse()
                        .unwrap(),
                );
                headers
            })
            .build()?;

        // Get file IDs
        let file_ids: Vec<u64> = manifest.files.iter().map(|f| f.file_id).collect();

        // Batch request to CurseForge API
        let batch_response = http_client
            .post("https://api.curseforge.com/v1/mods/files")
            .json(&serde_json::json!({ "fileIds": file_ids }))
            .send()
            .await?
            .json::<serde_json::Value>()
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
        let results: Vec<Result<String>> = stream::iter(manifest.files.iter().cloned())
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

                    result.map(|_| file_name)
                }
            })
            .buffer_unordered(MAX_PARALLEL_DOWNLOADS)
            .collect()
            .await;

        // Count results
        let mut success_count = 0;
        let mut failed_count = 0;
        for result in results {
            match result {
                Ok(_) => success_count += 1,
                Err(LauncherError::OperationCancelled) => {
                    return Err(LauncherError::OperationCancelled);
                }
                Err(_) => failed_count += 1,
            }
        }

        log::info!(
            "CurseForge manifest import complete: {} succeeded, {} failed",
            success_count,
            failed_count
        );

        emit_progress(&app_handle, "complete", total_files, total_files, None);

        Ok(instance_id)
    }
}
