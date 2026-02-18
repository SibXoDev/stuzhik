//! Stuzhik Modpack format (.stzhk)
//!
//! Кастомный формат модпаков с поддержкой:
//! - Встроенных модов (embedded)
//! - Ссылок на Modrinth/CurseForge
//! - SHA256 хешей для верификации
//! - Патчей и оверлеев
//! - Частичного обновления

use crate::downloader::DownloadManager;
use crate::error::{LauncherError, Result};
use crate::paths::instances_dir;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256, Sha512};
use std::collections::HashMap;
use std::io::{Read as IoRead, Write as IoWrite};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tauri::Emitter;
use zip::write::SimpleFileOptions;
use zip::{ZipArchive, ZipWriter};

// ========== Кеш для превью экспорта ==========

/// Кешированные данные превью для повторного использования при экспорте
#[derive(Debug, Clone)]
struct CachedModData {
    filename: String,
    name: String,
    sha256: String,
    size: u64,
    source: ModSource,
}

/// Глобальный кеш превью (instance_id -> Vec<CachedModData>)
static PREVIEW_CACHE: Mutex<Option<(String, bool, Vec<CachedModData>)>> = Mutex::new(None);

/// Структура для хранения собранных файлов перед записью в архив
/// Используется для разделения async сбора данных и sync записи в ZIP
#[derive(Debug)]
struct FileToArchive {
    archive_path: String,
    content: Vec<u8>,
}

/// Версия формата STZHK
pub const FORMAT_VERSION: u32 = 1;

/// Расширение файла
pub const FILE_EXTENSION: &str = ".stzhk";

/// Магические байты для идентификации формата
pub const MAGIC_BYTES: &[u8] = b"STZHK";

// ========== Типы манифеста ==========

/// Главный манифест модпака
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StzhkManifest {
    /// Версия формата
    pub format_version: u32,

    /// Метаданные модпака
    pub modpack: ModpackMeta,

    /// Требования к Minecraft и загрузчику
    pub requirements: GameRequirements,

    /// Список модов
    pub mods: Vec<ModEntry>,

    /// Оверрайды (конфиги, ресурспаки и т.д.)
    pub overrides: Option<OverridesInfo>,

    /// Патчи для модификации существующих файлов
    #[serde(default)]
    pub patches: Vec<PatchEntry>,

    /// Опциональные моды (пользователь выбирает при установке)
    #[serde(default)]
    pub optional_mods: Vec<OptionalModGroup>,
}

/// Метаданные модпака
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModpackMeta {
    /// Уникальный ID модпака
    pub id: String,

    /// Название
    pub name: String,

    /// Версия модпака
    pub version: String,

    /// Автор
    pub author: String,

    /// Описание
    pub description: Option<String>,

    /// Ссылка на сайт/GitHub
    pub url: Option<String>,

    /// Иконка (путь внутри архива)
    pub icon: Option<String>,

    /// Дата создания
    pub created_at: String,

    /// Дата последнего обновления
    pub updated_at: Option<String>,
}

/// Требования к игре
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameRequirements {
    /// Версия Minecraft
    pub minecraft_version: String,

    /// Тип загрузчика
    pub loader: String,

    /// Версия загрузчика
    pub loader_version: Option<String>,

    /// Минимальный объём RAM (МБ)
    pub min_ram_mb: Option<u32>,

    /// Рекомендуемый объём RAM (МБ)
    pub recommended_ram_mb: Option<u32>,

    /// Требуемая версия Java
    pub java_version: Option<u32>,
}

/// Запись о моде
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModEntry {
    /// Имя файла мода
    pub filename: String,

    /// Название мода для отображения
    pub name: String,

    /// Версия мода
    pub version: Option<String>,

    /// SHA256 хеш файла
    pub sha256: String,

    /// Размер файла в байтах
    pub size: u64,

    /// Источник мода
    pub source: ModSource,

    /// Обязательный ли мод
    #[serde(default = "default_true")]
    pub required: bool,

    /// Сторона (client/server/both)
    #[serde(default = "default_side")]
    pub side: ModSide,

    /// Зависимости (ID модов)
    #[serde(default)]
    pub dependencies: Vec<String>,
}

fn default_true() -> bool {
    true
}
fn default_side() -> ModSide {
    ModSide::Both
}

/// Источник мода
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ModSource {
    /// Встроен в архив
    #[serde(rename = "embedded")]
    Embedded {
        /// Путь внутри архива
        path: String,
    },

    /// Ссылка на Modrinth
    #[serde(rename = "modrinth")]
    Modrinth {
        /// ID проекта
        project_id: String,
        /// ID версии
        version_id: String,
        /// Прямая ссылка для скачивания
        download_url: String,
    },

    /// Ссылка на CurseForge
    #[serde(rename = "curseforge")]
    CurseForge {
        /// ID проекта
        project_id: u64,
        /// ID файла
        file_id: u64,
        /// Прямая ссылка (если доступна)
        download_url: Option<String>,
    },

    /// Прямая ссылка
    #[serde(rename = "direct")]
    Direct {
        /// URL для скачивания
        url: String,
    },
}

/// Сторона мода
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ModSide {
    Client,
    Server,
    Both,
}

/// Информация об оверрайдах
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OverridesInfo {
    /// Путь к папке с оверрайдами в архиве
    pub path: String,

    /// Хеш для верификации целостности
    pub hash: Option<String>,

    /// Размер всех оверрайдов
    pub size: u64,
}

/// Запись о патче
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatchEntry {
    /// ID патча
    pub id: String,

    /// Название патча
    pub name: String,

    /// Описание
    pub description: Option<String>,

    /// Целевой файл для патча
    pub target: String,

    /// Тип патча
    pub patch_type: PatchType,

    /// Путь к файлу патча в архиве
    pub patch_file: String,
}

/// Тип патча
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PatchType {
    /// Полная замена файла
    Replace,
    /// Diff патч (unified diff format)
    Diff,
    /// JSON merge патч
    JsonMerge,
    /// Бинарный патч (bsdiff)
    Binary,
}

/// Группа опциональных модов
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OptionalModGroup {
    /// ID группы
    pub id: String,

    /// Название группы
    pub name: String,

    /// Описание
    pub description: Option<String>,

    /// Тип выбора
    pub selection_type: SelectionType,

    /// Моды в группе
    pub mods: Vec<OptionalMod>,
}

/// Тип выбора модов
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SelectionType {
    /// Один из списка
    Single,
    /// Любое количество
    Multiple,
}

/// Опциональный мод
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OptionalMod {
    /// ID мода
    pub mod_id: String,

    /// Включён по умолчанию
    #[serde(default)]
    pub default_enabled: bool,

    /// Дополнительное описание
    pub note: Option<String>,
}

// ========== Результаты операций ==========

/// Результат верификации
#[derive(Debug, Clone, Serialize)]
pub struct VerificationResult {
    pub valid: bool,
    pub total_files: u32,
    pub verified_files: u32,
    pub failed_files: Vec<VerificationFailure>,
    pub missing_files: Vec<String>,
}

/// Ошибка верификации
#[derive(Debug, Clone, Serialize)]
pub struct VerificationFailure {
    pub filename: String,
    pub expected_hash: String,
    pub actual_hash: String,
}

/// Прогресс установки
#[derive(Debug, Clone, Serialize)]
pub struct StzhkInstallProgress {
    pub stage: String,
    pub current: u32,
    pub total: u32,
    pub current_file: Option<String>,
    pub bytes_downloaded: u64,
    pub bytes_total: u64,
}

/// Информация о неудавшейся загрузке
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FailedDownload {
    /// Имя файла
    pub filename: String,
    /// Название мода
    pub mod_name: String,
    /// Причина ошибки
    pub reason: DownloadFailureReason,
    /// Детали ошибки
    pub details: Option<String>,
}

/// Причины неудачной загрузки
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DownloadFailureReason {
    /// Сетевая ошибка
    NetworkError,
    /// Файл не найден на сервере (404)
    NotFound,
    /// Ошибка хеша (файл повреждён или подменён)
    HashMismatch,
    /// Файл отсутствует в архиве
    MissingInArchive,
    /// URL не указан
    MissingUrl,
    /// Таймаут
    Timeout,
    /// Сервер перегружен (503 и т.д.)
    ServerOverloaded,
    /// Доступ запрещён (403)
    AccessDenied,
    /// Неизвестная ошибка
    Unknown,
}

impl DownloadFailureReason {
    /// Определить причину из ошибки
    pub fn from_error(err: &LauncherError) -> Self {
        let err_str = err.to_string().to_lowercase();

        if err_str.contains("404") || err_str.contains("not found") {
            Self::NotFound
        } else if err_str.contains("403")
            || err_str.contains("forbidden")
            || err_str.contains("access denied")
        {
            Self::AccessDenied
        } else if err_str.contains("503")
            || err_str.contains("502")
            || err_str.contains("service unavailable")
        {
            Self::ServerOverloaded
        } else if err_str.contains("timeout") || err_str.contains("timed out") {
            Self::Timeout
        } else if err_str.contains("hash") || err_str.contains("mismatch") {
            Self::HashMismatch
        } else if err_str.contains("network")
            || err_str.contains("connect")
            || err_str.contains("dns")
        {
            Self::NetworkError
        } else {
            Self::Unknown
        }
    }

    /// Получить человекочитаемое описание
    pub fn description(&self) -> &'static str {
        match self {
            Self::NetworkError => "Ошибка сети. Проверьте подключение к интернету.",
            Self::NotFound => "Файл не найден на сервере. Мод мог быть удалён.",
            Self::HashMismatch => "Контрольная сумма не совпадает. Файл повреждён.",
            Self::MissingInArchive => "Файл отсутствует в архиве модпака.",
            Self::MissingUrl => "URL для скачивания не указан в манифесте.",
            Self::Timeout => "Превышено время ожидания. Попробуйте позже.",
            Self::ServerOverloaded => "Сервер перегружен. Попробуйте позже.",
            Self::AccessDenied => "Доступ запрещён. Возможно требуется авторизация.",
            Self::Unknown => "Неизвестная ошибка при скачивании.",
        }
    }
}

// ========== Основной менеджер ==========

/// Рекурсивно собирает файлы из директории для последующей записи в архив
/// Чистая async функция - только сбор данных, без sync операций
async fn collect_directory_files(
    files: &mut Vec<FileToArchive>,
    dir_path: &Path,
    archive_prefix: &str,
) -> Result<u32> {
    log::debug!(
        "collect_directory_files: scanning {:?} with prefix '{}'",
        dir_path,
        archive_prefix
    );

    let mut read_dir = match tokio::fs::read_dir(dir_path).await {
        Ok(rd) => rd,
        Err(e) => {
            log::error!("Failed to read directory {:?}: {}", dir_path, e);
            return Err(e.into());
        }
    };
    let mut files_added: u32 = 0;

    while let Some(entry) = read_dir.next_entry().await? {
        let entry_path = entry.path();
        let file_name = entry_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");
        let archive_path = format!("{}/{}", archive_prefix, file_name);

        let metadata = match tokio::fs::metadata(&entry_path).await {
            Ok(m) => m,
            Err(e) => {
                log::warn!("Failed to get metadata for {:?}: {}", entry_path, e);
                continue;
            }
        };

        if metadata.is_file() {
            let content = match tokio::fs::read(&entry_path).await {
                Ok(c) => c,
                Err(e) => {
                    log::warn!("Failed to read file {:?}: {}", entry_path, e);
                    continue;
                }
            };
            log::trace!(
                "Collected file for archive: {} ({} bytes)",
                archive_path,
                content.len()
            );
            files.push(FileToArchive {
                archive_path,
                content,
            });
            files_added += 1;
        } else if metadata.is_dir() {
            // Recursively collect from subdirectory
            log::trace!("Recursing into directory: {}", archive_path);
            files_added +=
                Box::pin(collect_directory_files(files, &entry_path, &archive_path)).await?;
        }
    }

    log::debug!(
        "collect_directory_files: finished {:?}, collected {} files",
        dir_path,
        files_added
    );
    Ok(files_added)
}

pub struct StzhkManager;

impl StzhkManager {
    /// Создать новый модпак в формате STZHK
    pub async fn create_modpack(
        name: String,
        version: String,
        author: String,
        minecraft_version: String,
        loader: String,
        loader_version: Option<String>,
        mods_path: &Path,
        output_path: &Path,
        embed_mods: bool,
        app_handle: &tauri::AppHandle,
    ) -> Result<PathBuf> {
        log::info!("Creating STZHK modpack: {} v{}", name, version);

        // Сканируем моды
        let mods = Self::scan_mods_for_export(mods_path, embed_mods).await?;

        // Создаём манифест
        let manifest = StzhkManifest {
            format_version: FORMAT_VERSION,
            modpack: ModpackMeta {
                id: uuid::Uuid::new_v4().to_string(),
                name: name.clone(),
                version: version.clone(),
                author,
                description: None,
                url: None,
                icon: None,
                created_at: chrono::Utc::now().to_rfc3339(),
                updated_at: None,
            },
            requirements: GameRequirements {
                minecraft_version,
                loader,
                loader_version,
                min_ram_mb: Some(4096),
                recommended_ram_mb: Some(8192),
                java_version: None,
            },
            mods,
            overrides: None,
            patches: vec![],
            optional_mods: vec![],
        };

        // Создаём архив
        let output_file = output_path.join(format!(
            "{}-{}{}",
            manifest.modpack.name.replace(" ", "_"),
            manifest.modpack.version,
            FILE_EXTENSION
        ));

        Self::write_modpack(&output_file, &manifest, mods_path, embed_mods, app_handle).await?;

        log::info!("STZHK modpack created: {:?}", output_file);
        Ok(output_file)
    }

    /// Сканировать моды для экспорта
    async fn scan_mods_for_export(mods_path: &Path, embed: bool) -> Result<Vec<ModEntry>> {
        let mut entries = Vec::new();

        if !tokio::fs::try_exists(mods_path).await.unwrap_or(false) {
            return Ok(entries);
        }

        // First pass: collect all mod info and calculate hashes
        struct ModInfo {
            path: PathBuf,
            filename: String,
            name: String,
            sha256: String,
            sha512: String,
            size: u64,
        }

        let mut mods_info: Vec<ModInfo> = Vec::new();
        let mut read_dir = tokio::fs::read_dir(mods_path).await?;

        while let Some(entry) = read_dir.next_entry().await? {
            let path = entry.path();

            if !path.is_file() {
                continue;
            }

            let filename = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();

            if !filename.ends_with(".jar") {
                continue;
            }

            // Читаем файл и вычисляем оба хеша
            let content = tokio::fs::read(&path).await?;
            let sha256 = Self::calculate_sha256(&content);
            let sha512 = Self::calculate_sha512(&content);
            let size = content.len() as u64;

            // Пытаемся извлечь имя мода из JAR
            let mod_path = path.clone();
            let filename_clone = filename.clone();
            let name = tokio::task::spawn_blocking(move || {
                Self::extract_mod_name(&mod_path).unwrap_or(filename_clone)
            })
            .await
            .unwrap_or(filename.clone());

            mods_info.push(ModInfo {
                path,
                filename,
                name,
                sha256,
                sha512,
                size,
            });
        }

        // If embedding all mods, skip Modrinth lookup
        if embed {
            for mod_info in mods_info {
                entries.push(ModEntry {
                    filename: mod_info.filename.clone(),
                    name: mod_info.name,
                    version: None,
                    sha256: mod_info.sha256,
                    size: mod_info.size,
                    source: ModSource::Embedded {
                        path: format!("mods/{}", mod_info.filename),
                    },
                    required: true,
                    side: ModSide::Both,
                    dependencies: vec![],
                });
            }
            return Ok(entries);
        }

        // Batch lookup on Modrinth using SHA512
        let sha512_hashes: Vec<String> = mods_info.iter().map(|m| m.sha512.clone()).collect();
        let modrinth_results = Self::find_mods_on_modrinth_batch(&sha512_hashes).await;

        // Build entries with Modrinth results
        for mod_info in mods_info {
            let source = if let Some(modrinth_source) = modrinth_results.get(&mod_info.sha512) {
                modrinth_source.clone()
            } else {
                // Not found on Modrinth - embed locally
                ModSource::Embedded {
                    path: format!("mods/{}", mod_info.filename),
                }
            };

            entries.push(ModEntry {
                filename: mod_info.filename,
                name: mod_info.name,
                version: None,
                sha256: mod_info.sha256, // Keep SHA256 for manifest verification
                size: mod_info.size,
                source,
                required: true,
                side: ModSide::Both,
                dependencies: vec![],
            });
        }

        Ok(entries)
    }

    /// Найти моды на Modrinth по хешам (SHA512) - BATCH API
    /// Возвращает HashMap<sha512, ModSource>
    async fn find_mods_on_modrinth_batch(sha512_hashes: &[String]) -> HashMap<String, ModSource> {
        let mut results: HashMap<String, ModSource> = HashMap::new();

        if sha512_hashes.is_empty() {
            return results;
        }

        log::info!(
            "Looking up {} mods on Modrinth via batch API",
            sha512_hashes.len()
        );

        // Modrinth batch API: POST /v2/version_files
        // Body: { "hashes": ["sha512_1", "sha512_2", ...], "algorithm": "sha512" }
        let client = &*crate::utils::SHARED_HTTP_CLIENT;

        #[derive(Serialize)]
        struct BatchRequest<'a> {
            hashes: &'a [String],
            algorithm: &'static str,
        }

        #[derive(Deserialize)]
        struct ModrinthVersion {
            id: String,
            project_id: String,
            files: Vec<ModrinthFile>,
        }

        #[derive(Deserialize)]
        struct ModrinthFile {
            url: String,
            primary: bool,
            hashes: ModrinthHashes,
        }

        #[derive(Deserialize)]
        struct ModrinthHashes {
            sha512: Option<String>,
            sha1: Option<String>,
        }

        let request_body = BatchRequest {
            hashes: sha512_hashes,
            algorithm: "sha512",
        };

        let resp = match client
            .post("https://api.modrinth.com/v2/version_files")
            .header("User-Agent", crate::USER_AGENT)
            .header("Content-Type", "application/json")
            .json(&request_body)
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                log::error!("Modrinth batch API request failed: {}", e);
                return results;
            }
        };

        let status = resp.status();
        if !status.is_success() {
            log::error!("Modrinth batch API returned status {}", status);
            return results;
        }

        // Response is a map: { "sha512_hash": ModrinthVersion, ... }
        let versions: HashMap<String, ModrinthVersion> = match resp.json().await {
            Ok(v) => v,
            Err(e) => {
                log::error!("Failed to parse Modrinth batch response: {}", e);
                return results;
            }
        };

        log::info!(
            "Modrinth batch API returned {} results for {} hashes",
            versions.len(),
            sha512_hashes.len()
        );

        for (hash, version) in versions {
            let download_url = version
                .files
                .iter()
                .find(|f| f.primary)
                .or(version.files.first())
                .map(|f| f.url.clone());

            if let Some(url) = download_url {
                log::debug!(
                    "Found mod on Modrinth: {} -> project_id={}",
                    &hash[..16],
                    version.project_id
                );

                results.insert(
                    hash,
                    ModSource::Modrinth {
                        project_id: version.project_id,
                        version_id: version.id,
                        download_url: url,
                    },
                );
            }
        }

        results
    }

    /// Найти один мод на Modrinth по хешу (SHA512) - для fallback
    async fn find_on_modrinth(sha512: &str) -> Option<ModSource> {
        let results = Self::find_mods_on_modrinth_batch(&[sha512.to_string()]).await;
        results.into_values().next()
    }

    /// Извлечь имя мода из JAR
    fn extract_mod_name(path: &Path) -> Option<String> {
        let file = std::fs::File::open(path).ok()?;
        let mut archive = ZipArchive::new(file).ok()?;

        // 1. Fabric/Quilt: fabric.mod.json
        if let Ok(mut entry) = archive.by_name("fabric.mod.json") {
            let mut content = String::new();
            entry.read_to_string(&mut content).ok()?;
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(name) = json.get("name").and_then(|v| v.as_str()) {
                    if !name.is_empty() {
                        return Some(name.to_string());
                    }
                }
            }
        }

        // 2. Forge/NeoForge 1.13+: META-INF/mods.toml (proper TOML parsing)
        if let Ok(mut entry) = archive.by_name("META-INF/mods.toml") {
            let mut content = String::new();
            entry.read_to_string(&mut content).ok()?;
            if let Ok(toml_value) = content.parse::<toml::Value>() {
                // mods.toml has [[mods]] array with displayName
                if let Some(mods) = toml_value.get("mods").and_then(|v| v.as_array()) {
                    if let Some(first_mod) = mods.first() {
                        if let Some(name) = first_mod.get("displayName").and_then(|v| v.as_str()) {
                            if !name.is_empty() {
                                return Some(name.to_string());
                            }
                        }
                    }
                }
            }
        }

        // 3. Legacy Forge (pre-1.13): mcmod.info (JSON array)
        if let Ok(mut entry) = archive.by_name("mcmod.info") {
            let mut content = String::new();
            entry.read_to_string(&mut content).ok()?;
            // mcmod.info can be array or object with modList
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                // Direct array format: [{...}, {...}]
                if let Some(arr) = json.as_array() {
                    if let Some(first) = arr.first() {
                        if let Some(name) = first.get("name").and_then(|v| v.as_str()) {
                            if !name.is_empty() {
                                return Some(name.to_string());
                            }
                        }
                    }
                }
                // Object with modList: { modList: [...] }
                if let Some(mod_list) = json.get("modList").and_then(|v| v.as_array()) {
                    if let Some(first) = mod_list.first() {
                        if let Some(name) = first.get("name").and_then(|v| v.as_str()) {
                            if !name.is_empty() {
                                return Some(name.to_string());
                            }
                        }
                    }
                }
            }
        }

        None
    }

    /// Записать модпак в файл
    async fn write_modpack(
        output_path: &Path,
        manifest: &StzhkManifest,
        mods_path: &Path,
        embed_mods: bool,
        app_handle: &tauri::AppHandle,
    ) -> Result<()> {
        let output_path = output_path.to_owned();
        let mods_path = mods_path.to_owned();
        let manifest = manifest.clone();
        let app_handle = app_handle.clone();

        tokio::task::spawn_blocking(move || {
            let file = std::fs::File::create(&output_path)?;
            let mut zip = ZipWriter::new(file);

            let options =
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

            // Записываем манифест
            let manifest_json = serde_json::to_string_pretty(&manifest)?;
            zip.start_file("manifest.json", options)?;
            zip.write_all(manifest_json.as_bytes())?;

            // Если нужно встраивать моды
            if embed_mods {
                let total = manifest.mods.len();

                for (i, mod_entry) in manifest.mods.iter().enumerate() {
                    if let ModSource::Embedded { path } = &mod_entry.source {
                        let mod_file_path = mods_path.join(&mod_entry.filename);

                        if mod_file_path.exists() {
                            let content = std::fs::read(&mod_file_path)?;

                            zip.start_file(path, options)?;
                            zip.write_all(&content)?;

                            // Отправляем прогресс
                            let _ = app_handle.emit(
                                "stzhk-export-progress",
                                serde_json::json!({
                                    "current": i + 1,
                                    "total": total,
                                    "filename": mod_entry.filename,
                                }),
                            );
                        }
                    }
                }
            }

            zip.finish()?;
            Ok(())
        })
        .await
        .map_err(|e| LauncherError::Join(e.to_string()))?
    }

    /// Прочитать манифест из файла STZHK
    pub async fn read_manifest(path: &Path) -> Result<StzhkManifest> {
        let path = path.to_owned();

        tokio::task::spawn_blocking(move || {
            let file = std::fs::File::open(&path)?;
            let mut archive = ZipArchive::new(file)?;

            let mut manifest_entry = archive.by_name("manifest.json").map_err(|_| {
                LauncherError::InvalidConfig("manifest.json not found in STZHK file".into())
            })?;

            let mut content = String::new();
            manifest_entry.read_to_string(&mut content)?;

            let manifest: StzhkManifest = serde_json::from_str(&content)?;

            // Проверяем версию формата
            if manifest.format_version > FORMAT_VERSION {
                return Err(LauncherError::InvalidConfig(format!(
                    "Unsupported STZHK format version: {}. Maximum supported: {}",
                    manifest.format_version, FORMAT_VERSION
                )));
            }

            Ok(manifest)
        })
        .await
        .map_err(|e| LauncherError::Join(e.to_string()))?
    }

    /// Предпросмотр модпака
    pub async fn preview(path: &Path) -> Result<StzhkPreview> {
        let manifest = Self::read_manifest(path).await?;

        let embedded_count = manifest
            .mods
            .iter()
            .filter(|m| matches!(m.source, ModSource::Embedded { .. }))
            .count();

        let linked_count = manifest.mods.len() - embedded_count;

        let total_size: u64 = manifest.mods.iter().map(|m| m.size).sum();

        // Count mods in overrides folder
        let overrides_mods_count = Self::count_overrides_mods(path).await?;

        Ok(StzhkPreview {
            manifest,
            embedded_mods_count: embedded_count as u32,
            linked_mods_count: linked_count as u32,
            overrides_mods_count,
            total_size,
        })
    }

    /// Count mods in overrides/mods folder
    async fn count_overrides_mods(path: &Path) -> Result<u32> {
        let path = path.to_owned();

        tokio::task::spawn_blocking(move || {
            let file = std::fs::File::open(&path)?;
            let mut archive = ZipArchive::new(file)?;
            let mut count = 0;

            for i in 0..archive.len() {
                if let Ok(entry) = archive.by_index(i) {
                    let name = entry.name();
                    // Check for mods in overrides/mods/ folder
                    if (name.starts_with("overrides/mods/")
                        || name.starts_with("overrides\\mods\\"))
                        && !name.ends_with('/')
                        && (name.to_lowercase().ends_with(".jar")
                            || name.to_lowercase().ends_with(".jar.disabled"))
                    {
                        count += 1;
                    }
                }
            }

            Ok(count)
        })
        .await
        .map_err(|e| LauncherError::Join(e.to_string()))?
    }

    /// Установить модпак из STZHK файла
    pub async fn install(
        path: &Path,
        instance_name: String,
        _selected_optionals: Vec<String>,
        download_manager: &DownloadManager,
        app_handle: &tauri::AppHandle,
    ) -> Result<String> {
        log::info!("Installing STZHK modpack from {:?}", path);

        let manifest = Self::read_manifest(path).await?;

        // Создаём экземпляр
        let instance = crate::instances::create_instance(
            crate::types::CreateInstanceRequest {
                name: instance_name.clone(),
                game_type: Some("minecraft".to_string()),
                version: manifest.requirements.minecraft_version.clone(),
                loader: manifest.requirements.loader.clone(),
                loader_version: manifest.requirements.loader_version.clone(),
                instance_type: "client".to_string(),
                memory_min: Some(2048),
                memory_max: Some(manifest.requirements.recommended_ram_mb.unwrap_or(4096) as i32),
                java_args: None,
                game_args: None,
                port: None,
                username: None,
                notes: None,
            },
            app_handle.clone(),
        )
        .await?;

        let instance_id = instance.id.clone();
        let instance_path = instances_dir().join(&instance_id);
        let mods_path = instance_path.join("mods");

        tokio::fs::create_dir_all(&mods_path).await?;

        let total_mods = manifest.mods.len();
        let installed = Arc::new(AtomicUsize::new(0));
        let failed: Arc<Mutex<Vec<FailedDownload>>> = Arc::new(Mutex::new(Vec::new()));

        // ========== PHASE 1: Extract embedded mods (sequential, archive is not thread-safe) ==========
        let _ = app_handle.emit(
            "modpack-install-progress",
            serde_json::json!({
                "stage": "extracting_overrides",
                "current": 0,
                "total": total_mods,
                "current_file": serde_json::Value::Null
            }),
        );

        let mut download_tasks: Vec<(ModEntry, String)> = Vec::new(); // (mod_entry, url)

        // Extract all embedded mods data in spawn_blocking
        let path_clone = path.to_owned();
        let manifest_clone = manifest.clone();
        let embedded_mods_data: Vec<(ModEntry, Vec<u8>)> = tokio::task::spawn_blocking(move || {
            let file = std::fs::File::open(&path_clone)?;
            let mut archive = ZipArchive::new(file)?;
            let mut result = Vec::new();

            for mod_entry in manifest_clone.mods.iter() {
                if let ModSource::Embedded { path: archive_path } = &mod_entry.source {
                    match archive.by_name(archive_path) {
                        Ok(mut entry) => {
                            let mut content = Vec::new();
                            entry.read_to_end(&mut content)?;
                            result.push((mod_entry.clone(), content));
                        }
                        Err(_) => {
                            // We'll handle the error in the main loop
                        }
                    }
                }
            }

            Ok::<_, LauncherError>(result)
        })
        .await
        .map_err(|e| LauncherError::Join(e.to_string()))??;

        // Write embedded mods and check hashes
        for (mod_entry, content) in embedded_mods_data {
            let _ = app_handle.emit(
                "modpack-install-progress",
                serde_json::json!({
                    "stage": "extracting_overrides",
                    "current": installed.load(Ordering::SeqCst),
                    "total": total_mods,
                    "current_file": mod_entry.name.clone()
                }),
            );

            // Check hash
            let hash = Self::calculate_sha256(&content);
            if hash != mod_entry.sha256 {
                log::warn!(
                    "Hash mismatch for {}: expected {}, got {}",
                    mod_entry.filename,
                    mod_entry.sha256,
                    hash
                );
                failed
                    .lock()
                    .map_err(|e| {
                        LauncherError::InvalidConfig(format!(
                            "Failed downloads mutex poisoned: {}",
                            e
                        ))
                    })?
                    .push(FailedDownload {
                        filename: mod_entry.filename.clone(),
                        mod_name: mod_entry.name.clone(),
                        reason: DownloadFailureReason::HashMismatch,
                        details: Some(format!("Expected: {}, got: {}", mod_entry.sha256, hash)),
                    });
                continue;
            }

            let dest_path = mods_path.join(&mod_entry.filename);
            tokio::fs::write(&dest_path, content).await?;
            installed.fetch_add(1, Ordering::SeqCst);
        }

        // Collect download tasks for non-embedded mods
        for mod_entry in manifest.mods.iter() {
            match &mod_entry.source {
                ModSource::Embedded { .. } => {
                    // Already processed above
                }
                ModSource::Modrinth {
                    project_id,
                    version_id,
                    download_url,
                } => {
                    let url = if !download_url.is_empty() {
                        download_url.clone()
                    } else {
                        format!(
                            "https://cdn.modrinth.com/data/{}/versions/{}/{}",
                            project_id, version_id, mod_entry.filename
                        )
                    };
                    download_tasks.push((mod_entry.clone(), url));
                }
                ModSource::CurseForge {
                    project_id,
                    file_id,
                    download_url,
                } => {
                    // Use download_url if available, otherwise construct URL
                    let url = download_url.clone().unwrap_or_else(|| {
                        format!(
                            "https://www.curseforge.com/api/v1/mods/{}/files/{}/download",
                            project_id, file_id
                        )
                    });
                    download_tasks.push((mod_entry.clone(), url));
                }
                ModSource::Direct { url } => {
                    download_tasks.push((mod_entry.clone(), url.clone()));
                }
                _ => {
                    failed
                        .lock()
                        .map_err(|e| {
                            LauncherError::InvalidConfig(format!(
                                "Failed downloads mutex poisoned: {}",
                                e
                            ))
                        })?
                        .push(FailedDownload {
                            filename: mod_entry.filename.clone(),
                            mod_name: mod_entry.name.clone(),
                            reason: DownloadFailureReason::MissingInArchive,
                            details: Some("Unknown mod source type".to_string()),
                        });
                }
            }
        }

        // ========== PHASE 2: Download mods in PARALLEL ==========
        if !download_tasks.is_empty() {
            log::info!(
                "Starting parallel download of {} mods",
                download_tasks.len()
            );

            let _ = app_handle.emit(
                "modpack-install-progress",
                serde_json::json!({
                    "stage": "downloading_mods",
                    "current": installed.load(Ordering::SeqCst),
                    "total": total_mods,
                    "current_file": serde_json::Value::Null
                }),
            );

            // Limit concurrent downloads to avoid overwhelming the network
            const MAX_CONCURRENT_DOWNLOADS: usize = 8;

            let semaphore = Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_DOWNLOADS));
            let mut handles = Vec::new();

            for (mod_entry, url) in download_tasks {
                let sem = Arc::clone(&semaphore);
                let dm = download_manager.clone();
                let mods_path = mods_path.clone();
                let app = app_handle.clone();
                let installed_counter = Arc::clone(&installed);
                let failed_list = Arc::clone(&failed);
                let total = total_mods;

                handles.push(tokio::spawn(async move {
                    // Acquire semaphore permit
                    let _permit = match sem.acquire().await {
                        Ok(permit) => permit,
                        Err(e) => {
                            log::error!("Failed to acquire semaphore: {}", e);
                            if let Ok(mut list) = failed_list.lock() {
                                list.push(FailedDownload {
                                    filename: mod_entry.filename.clone(),
                                    mod_name: mod_entry.name.clone(),
                                    reason: DownloadFailureReason::Unknown,
                                    details: Some(format!("Semaphore error: {}", e)),
                                });
                            }
                            return;
                        }
                    };

                    let dest_path = mods_path.join(&mod_entry.filename);

                    // Emit progress
                    let current = installed_counter.load(Ordering::SeqCst);
                    let _ = app.emit(
                        "modpack-install-progress",
                        serde_json::json!({
                            "stage": "downloading_mods",
                            "current": current,
                            "total": total,
                            "current_file": mod_entry.name.clone()
                        }),
                    );

                    match dm.download_file(&url, &dest_path, &mod_entry.filename, Some(&mod_entry.sha256)).await {
                        Ok(_) => {
                            installed_counter.fetch_add(1, Ordering::SeqCst);
                            log::debug!("Downloaded: {}", mod_entry.filename);
                        }
                        Err(e) => {
                            log::error!("Failed to download {}: {}", mod_entry.filename, e);
                            if let Ok(mut list) = failed_list.lock() {
                                list.push(FailedDownload {
                                    filename: mod_entry.filename.clone(),
                                    mod_name: mod_entry.name.clone(),
                                    reason: DownloadFailureReason::from_error(&e),
                                    details: Some(format!("URL: {}, error: {}", url, e)),
                                });
                            } else {
                                log::error!("Failed to acquire lock on failed downloads list - mutex poisoned");
                            }
                        }
                    }
                }));
            }

            // Wait for all downloads to complete
            for handle in handles {
                let _ = handle.await;
            }
        }

        // ========== PHASE 3: Extract overrides ==========
        let _ = app_handle.emit(
            "modpack-install-progress",
            serde_json::json!({
                "stage": "extracting_overrides",
                "current": installed.load(Ordering::SeqCst),
                "total": total_mods,
                "current_file": serde_json::Value::Null
            }),
        );

        let mut overrides_mods_installed: u32 = 0;
        if let Some(overrides) = &manifest.overrides {
            log::info!("Manifest has overrides section, path: '{}'", overrides.path);
            overrides_mods_installed =
                Self::extract_overrides(path, &overrides.path, &instance_path).await?;
            log::info!("Extracted {} mods from overrides", overrides_mods_installed);
        } else {
            log::info!("Manifest has no overrides section, checking archive for overrides...");
            overrides_mods_installed =
                Self::extract_overrides(path, "overrides", &instance_path).await?;
            if overrides_mods_installed > 0 {
                log::info!(
                    "Extracted {} mods from overrides (fallback)",
                    overrides_mods_installed
                );
            }
        }

        // ========== PHASE 4: Register mods in DB ==========
        let mod_files_info = Self::scan_mods_dir_for_db(&mods_path).await;
        if !mod_files_info.is_empty() {
            if let Err(e) = crate::mods::ModManager::register_modpack_mods(
                &instance_id,
                &manifest.requirements.minecraft_version,
                &mod_files_info,
            ) {
                log::warn!("Failed to register STZHK modpack mods in DB: {}", e);
            } else {
                log::info!("Registered {} mods in database", mod_files_info.len());
            }
        }

        // Final results
        let final_installed = installed.load(Ordering::SeqCst);
        let final_failed = failed
            .lock()
            .map_err(|e| {
                LauncherError::InvalidConfig(format!("Failed downloads mutex poisoned: {}", e))
            })?
            .clone();
        let total_installed = final_installed + overrides_mods_installed as usize;
        let total_expected = total_mods + overrides_mods_installed as usize;

        // Emit completion event
        let _ = app_handle.emit(
            "modpack-install-progress",
            serde_json::json!({
                "stage": "completed",
                "current": total_installed,
                "total": total_expected,
                "current_file": serde_json::Value::Null
            }),
        );

        log::info!(
            "STZHK install complete: {} installed ({} from manifest + {} from overrides), {} failed",
            total_installed,
            final_installed,
            overrides_mods_installed,
            final_failed.len()
        );

        Ok(instance_id)
    }

    /// Сканировать директорию модов для регистрации в БД
    async fn scan_mods_dir_for_db(mods_dir: &Path) -> Vec<(String, String)> {
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

    /// Извлечь оверрайды и вернуть количество извлечённых модов
    async fn extract_overrides(
        archive_path: &Path,
        overrides_path: &str,
        instance_path: &Path,
    ) -> Result<u32> {
        let archive_path = archive_path.to_owned();
        let overrides_path = overrides_path.to_owned();
        let instance_path = instance_path.to_owned();

        tokio::task::spawn_blocking(move || {
            let file = std::fs::File::open(&archive_path)?;
            let mut archive = ZipArchive::new(file)?;

            let prefix = format!("{}/", overrides_path.trim_end_matches('/'));
            let mut overrides_mods_count: u32 = 0;
            let mut total_extracted: u32 = 0;

            log::info!(
                "Extracting overrides from archive prefix '{}' to {:?}",
                prefix,
                instance_path
            );

            // Log what entries are in the archive
            let archive_entries: Vec<String> = (0..archive.len())
                .filter_map(|i| archive.by_index(i).ok().map(|e| e.name().to_string()))
                .collect();
            log::debug!(
                "Archive contains {} entries, {} start with '{}'",
                archive_entries.len(),
                archive_entries
                    .iter()
                    .filter(|e| e.starts_with(&prefix))
                    .count(),
                prefix
            );

            for i in 0..archive.len() {
                let mut entry = archive.by_index(i)?;
                let name = entry.name().to_string();

                if name.starts_with(&prefix) {
                    let relative_path = &name[prefix.len()..];
                    if relative_path.is_empty() || relative_path.ends_with('/') {
                        continue;
                    }

                    let dest_path = instance_path.join(relative_path);

                    if let Some(parent) = dest_path.parent() {
                        std::fs::create_dir_all(parent)?;
                    }

                    let mut content = Vec::new();
                    entry.read_to_end(&mut content)?;
                    std::fs::write(&dest_path, &content)?;
                    total_extracted += 1;

                    log::debug!(
                        "Extracted override: {} -> {:?} ({} bytes)",
                        name,
                        dest_path,
                        content.len()
                    );

                    // Count mods extracted from overrides/mods/
                    if relative_path.starts_with("mods/")
                        && (relative_path.ends_with(".jar")
                            || relative_path.ends_with(".jar.disabled"))
                    {
                        overrides_mods_count += 1;
                    }
                }
            }

            log::info!(
                "Extracted {} files from overrides ({} mods)",
                total_extracted,
                overrides_mods_count
            );

            Ok(overrides_mods_count)
        })
        .await
        .map_err(|e| LauncherError::Join(e.to_string()))?
    }

    /// Проверить целостность установленного экземпляра
    pub async fn verify_instance(
        instance_id: &str,
        manifest: &StzhkManifest,
    ) -> Result<VerificationResult> {
        let mods_path = instances_dir().join(instance_id).join("mods");

        let mut result = VerificationResult {
            valid: true,
            total_files: manifest.mods.len() as u32,
            verified_files: 0,
            failed_files: vec![],
            missing_files: vec![],
        };

        for mod_entry in &manifest.mods {
            let mod_path = mods_path.join(&mod_entry.filename);

            if !tokio::fs::try_exists(&mod_path).await.unwrap_or(false) {
                result.missing_files.push(mod_entry.filename.clone());
                result.valid = false;
                continue;
            }

            let content = tokio::fs::read(&mod_path).await?;
            let actual_hash = Self::calculate_sha256(&content);

            if actual_hash != mod_entry.sha256 {
                result.failed_files.push(VerificationFailure {
                    filename: mod_entry.filename.clone(),
                    expected_hash: mod_entry.sha256.clone(),
                    actual_hash,
                });
                result.valid = false;
            } else {
                result.verified_files += 1;
            }
        }

        Ok(result)
    }

    /// Вычислить SHA256 хеш
    pub fn calculate_sha256(data: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(data);
        format!("{:x}", hasher.finalize())
    }

    /// Вычислить SHA512 хеш (для Modrinth API)
    pub fn calculate_sha512(data: &[u8]) -> String {
        let mut hasher = Sha512::new();
        hasher.update(data);
        format!("{:x}", hasher.finalize())
    }

    /// Экспортировать экземпляр в STZHK формат
    pub async fn export_instance(
        instance_id: &str,
        output_path: &Path,
        options: &ExportOptions,
        app_handle: &tauri::AppHandle,
    ) -> Result<PathBuf> {
        let conn = crate::db::get_db_conn()?;

        // Получаем информацию об экземпляре
        let (mc_version, loader, loader_version): (String, String, Option<String>) = conn
            .query_row(
                "SELECT version, loader, loader_version FROM instances WHERE id = ?1",
                [instance_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;

        let instance_path = instances_dir().join(instance_id);
        let mods_path = instance_path.join("mods");

        // Convert excluded lists to HashSet for O(1) lookup
        let excluded_mods: std::collections::HashSet<&str> =
            options.excluded_mods.iter().map(|s| s.as_str()).collect();
        let excluded_overrides: std::collections::HashSet<&str> = options
            .excluded_overrides
            .iter()
            .map(|s| s.as_str())
            .collect();

        log::info!(
            "Export with {} excluded mods and {} excluded overrides",
            excluded_mods.len(),
            excluded_overrides.len()
        );

        // Try to use cached data from preview, otherwise scan fresh
        let all_mods = {
            let cached = PREVIEW_CACHE.lock().ok().and_then(|cache| {
                cache.as_ref().and_then(|(cached_id, cached_embed, data)| {
                    if cached_id == instance_id && *cached_embed == options.embed_mods {
                        log::info!("Using cached preview data for export ({} mods)", data.len());
                        Some(data.clone())
                    } else {
                        None
                    }
                })
            });

            if let Some(cached_mods) = cached {
                // Convert cached data to ModEntry
                cached_mods
                    .into_iter()
                    .map(|m| ModEntry {
                        filename: m.filename,
                        name: m.name,
                        version: None,
                        sha256: m.sha256,
                        size: m.size,
                        source: m.source,
                        required: true,
                        side: ModSide::Both,
                        dependencies: vec![],
                    })
                    .collect()
            } else {
                log::info!("No cache found, scanning mods fresh");
                Self::scan_mods_for_export(&mods_path, options.embed_mods).await?
            }
        };

        // Filter out excluded mods
        let mods: Vec<ModEntry> = all_mods
            .into_iter()
            .filter(|m| !excluded_mods.contains(m.filename.as_str()))
            .collect();

        log::info!("Exporting {} mods (after filtering)", mods.len());

        // Create manifest with user-provided metadata
        let mut manifest = StzhkManifest {
            format_version: FORMAT_VERSION,
            modpack: ModpackMeta {
                id: uuid::Uuid::new_v4().to_string(),
                name: options.name.clone(),
                version: options.version.clone(),
                author: options.author.clone(),
                description: options.description.clone(),
                url: None,
                icon: None,
                created_at: chrono::Utc::now().to_rfc3339(),
                updated_at: None,
            },
            requirements: GameRequirements {
                minecraft_version: mc_version,
                loader,
                loader_version,
                min_ram_mb: Some(4096),
                recommended_ram_mb: Some(8192),
                java_version: None,
            },
            mods,
            overrides: None,
            patches: vec![],
            optional_mods: vec![],
        };

        // Collect overrides directories if requested
        // Include ALL common directories that may contain user data, configs, assets, images
        let override_dirs: Vec<(&str, PathBuf)> = if options.include_overrides {
            let dirs = vec![
                // === Конфигурация ===
                ("config", instance_path.join("config")),
                ("defaultconfigs", instance_path.join("defaultconfigs")),
                // === Скрипты ===
                ("kubejs", instance_path.join("kubejs")),
                ("scripts", instance_path.join("scripts")),
                ("openloader", instance_path.join("openloader")),
                ("packmode", instance_path.join("packmode")),
                // === Ресурсы ===
                ("resourcepacks", instance_path.join("resourcepacks")),
                ("shaderpacks", instance_path.join("shaderpacks")),
                ("resources", instance_path.join("resources")),
                ("assets", instance_path.join("assets")),
                ("patchouli_books", instance_path.join("patchouli_books")),
                ("global_packs", instance_path.join("global_packs")),
                ("local", instance_path.join("local")),
                // === Настройки игры ===
                ("options.txt", instance_path.join("options.txt")),
                ("servers.dat", instance_path.join("servers.dat")),
                // === Генерируемые данные (можно исключить для экономии места) ===
                ("saves", instance_path.join("saves")),
                ("screenshots", instance_path.join("screenshots")),
                ("schematics", instance_path.join("schematics")),
                ("replay_recordings", instance_path.join("replay_recordings")),
                ("worldedit", instance_path.join("worldedit")),
            ];

            // Log what directories exist
            for (name, path) in &dirs {
                log::debug!(
                    "Override check: {} at {:?} - exists: {}",
                    name,
                    path,
                    tokio::fs::try_exists(path).await.unwrap_or(false)
                );
            }

            // Filter to only existing paths AND not excluded
            let mut filtered: Vec<(&str, std::path::PathBuf)> = Vec::new();
            for (name, path) in dirs {
                if tokio::fs::try_exists(&path).await.unwrap_or(false) && !excluded_overrides.contains(name) {
                    filtered.push((name, path));
                }
            }
            log::info!(
                "Found {} override directories/files to include (after exclusions)",
                filtered.len()
            );
            filtered
        } else {
            log::info!("include_overrides=false, skipping overrides");
            vec![]
        };

        // Calculate overrides size
        if !override_dirs.is_empty() {
            let mut total_size: u64 = 0;
            for (_, path) in &override_dirs {
                if path.is_file() {
                    if let Ok(meta) = tokio::fs::metadata(path).await {
                        total_size += meta.len();
                    }
                } else if path.is_dir() {
                    total_size += Self::calculate_dir_size(path).await.unwrap_or(0);
                }
            }

            manifest.overrides = Some(OverridesInfo {
                path: "overrides".into(),
                hash: None,
                size: total_size,
            });
        }

        // Create archive
        let output_file = output_path.join(format!(
            "{}-{}{}",
            manifest.modpack.name.replace(" ", "_"),
            manifest.modpack.version,
            FILE_EXTENSION
        ));

        Self::write_modpack_with_overrides(
            &output_file,
            &manifest,
            &mods_path,
            options.embed_mods,
            &override_dirs,
            app_handle,
        )
        .await?;

        log::info!("STZHK modpack exported: {:?}", output_file);

        // Clear cache after successful export
        if let Ok(mut cache) = PREVIEW_CACHE.lock() {
            *cache = None;
            log::debug!("Cleared export preview cache");
        }

        Ok(output_file)
    }

    /// Calculate total size of a directory recursively
    async fn calculate_dir_size(path: &Path) -> Result<u64> {
        let mut total: u64 = 0;
        let mut read_dir = tokio::fs::read_dir(path).await?;

        while let Some(entry) = read_dir.next_entry().await? {
            let entry_path = entry.path();
            let metadata = tokio::fs::metadata(&entry_path).await?;

            if metadata.is_file() {
                total += metadata.len();
            } else if metadata.is_dir() {
                total += Box::pin(Self::calculate_dir_size(&entry_path)).await?;
            }
        }

        Ok(total)
    }

    /// Записывает модпак в ZIP архив с разделением async/sync операций
    ///
    /// Архитектура:
    /// 1. Phase 1 (async): Собираем все данные файлов асинхронно
    /// 2. Phase 2 (sync в spawn_blocking): Пишем ZIP синхронно
    ///
    /// Это предотвращает блокировку tokio runtime sync операциями ZipWriter
    async fn write_modpack_with_overrides(
        output_path: &Path,
        manifest: &StzhkManifest,
        mods_path: &Path,
        _embed_mods: bool,
        override_dirs: &[(&str, PathBuf)],
        app_handle: &tauri::AppHandle,
    ) -> Result<()> {
        // Calculate total steps for progress
        let mods_to_embed = manifest
            .mods
            .iter()
            .filter(|m| matches!(m.source, ModSource::Embedded { .. }))
            .count();
        let overrides_count = override_dirs.len();
        let total_steps = 1 + mods_to_embed + overrides_count + 1; // manifest + mods + overrides + finish
        let mut current_step = 0;

        // ========== Phase 1: Async data collection ==========

        // Send initial progress
        let _ = app_handle.emit(
            "stzhk-export-progress",
            serde_json::json!({
                "stage": "manifest",
                "current": current_step,
                "total": total_steps,
                "filename": "manifest.json",
            }),
        );

        // Prepare manifest JSON
        let manifest_json = serde_json::to_string_pretty(manifest)?;
        current_step += 1;

        // Collect all files to archive
        let mut files_to_archive: Vec<FileToArchive> = Vec::new();

        // Collect embedded mods
        for mod_entry in manifest.mods.iter() {
            if let ModSource::Embedded { path } = &mod_entry.source {
                let mod_file_path = mods_path.join(&mod_entry.filename);

                if tokio::fs::try_exists(&mod_file_path).await.unwrap_or(false) {
                    // Send progress before processing
                    let _ = app_handle.emit(
                        "stzhk-export-progress",
                        serde_json::json!({
                            "stage": "mods",
                            "current": current_step,
                            "total": total_steps,
                            "filename": mod_entry.filename,
                        }),
                    );

                    log::debug!(
                        "Collecting mod {} for archive path: {}",
                        mod_entry.filename,
                        path
                    );

                    let content = tokio::fs::read(&mod_file_path).await?;
                    files_to_archive.push(FileToArchive {
                        archive_path: path.clone(),
                        content,
                    });
                    current_step += 1;
                } else {
                    log::warn!(
                        "Mod file not found for embedding: {} (expected at {:?})",
                        mod_entry.filename,
                        mod_file_path
                    );
                }
            }
        }

        // Collect overrides
        log::info!(
            "Collecting {} override items for archive",
            override_dirs.len()
        );
        let mut overrides_files_count: u32 = 0;

        for (name, path) in override_dirs {
            // Send progress
            let _ = app_handle.emit(
                "stzhk-export-progress",
                serde_json::json!({
                    "stage": "overrides",
                    "current": current_step,
                    "total": total_steps,
                    "filename": *name,
                }),
            );

            let metadata = match tokio::fs::metadata(path).await {
                Ok(m) => m,
                Err(e) => {
                    log::warn!("Failed to get metadata for override {:?}: {}", path, e);
                    current_step += 1;
                    continue;
                }
            };

            if metadata.is_file() {
                // Single file (options.txt, servers.dat)
                let content = tokio::fs::read(path).await?;
                let archive_path = format!("overrides/{}", name);
                log::debug!(
                    "Collected override file: {} ({} bytes)",
                    archive_path,
                    content.len()
                );
                files_to_archive.push(FileToArchive {
                    archive_path,
                    content,
                });
                overrides_files_count += 1;
            } else if metadata.is_dir() {
                // Directory (config, resourcepacks, shaderpacks)
                log::debug!("Collecting override directory: overrides/{}", name);
                let files_added = collect_directory_files(
                    &mut files_to_archive,
                    path,
                    &format!("overrides/{}", name),
                )
                .await?;
                overrides_files_count += files_added;
                log::debug!("Collected {} files from directory {}", files_added, name);
            }
            current_step += 1;
        }

        log::info!(
            "Collected {} override files for archive",
            overrides_files_count
        );

        // Send finishing progress
        let _ = app_handle.emit(
            "stzhk-export-progress",
            serde_json::json!({
                "stage": "finishing",
                "current": current_step,
                "total": total_steps,
                "filename": "",
            }),
        );

        // ========== Phase 2: Sync ZIP writing in spawn_blocking ==========

        let output_path = output_path.to_owned();
        tokio::task::spawn_blocking(move || {
            let file = std::fs::File::create(&output_path)?;
            let mut zip = ZipWriter::new(file);
            let options =
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

            // Write manifest
            zip.start_file("manifest.json", options)?;
            zip.write_all(manifest_json.as_bytes())?;

            // Write all collected files
            for file_data in files_to_archive {
                zip.start_file(&file_data.archive_path, options)?;
                zip.write_all(&file_data.content)?;
            }

            zip.finish()?;
            Ok::<(), LauncherError>(())
        })
        .await
        .map_err(|e| LauncherError::InvalidConfig(format!("spawn_blocking failed: {}", e)))??;

        Ok(())
    }

    /// Получить предпросмотр экспорта (показывает какие файлы будут включены)
    pub async fn get_export_preview(
        instance_id: &str,
        embed_mods: bool,
        include_overrides: bool,
        app_handle: &tauri::AppHandle,
    ) -> Result<ExportPreview> {
        let conn = crate::db::get_db_conn()?;

        // Get instance info
        let (name, version, loader, loader_version): (String, String, String, Option<String>) =
            conn.query_row(
                "SELECT name, version, loader, loader_version FROM instances WHERE id = ?1",
                [instance_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;

        let instance_path = instances_dir().join(instance_id);
        let mods_path = instance_path.join("mods");

        // Scan mods and get detailed info
        let mut mods_info: Vec<ExportModInfo> = Vec::new();
        let mut modrinth_count: u32 = 0;
        let mut local_count: u32 = 0;
        let mut embedded_size: u64 = 0;

        if tokio::fs::try_exists(&mods_path).await.unwrap_or(false) {
            // First pass: collect all mod file paths
            let mut mod_paths: Vec<PathBuf> = Vec::new();
            let mut read_dir = tokio::fs::read_dir(&mods_path).await?;

            while let Some(entry) = read_dir.next_entry().await? {
                let path = entry.path();

                // Use async metadata check instead of blocking is_file()
                let metadata = match entry.metadata().await {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                if !metadata.is_file() {
                    continue;
                }

                let filename = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_string();

                if !filename.ends_with(".jar") {
                    continue;
                }

                mod_paths.push(path);
            }

            let total_mods = mod_paths.len();
            log::info!("Found {} mods to process for export preview", total_mods);

            // Emit initial progress
            let _ = app_handle.emit(
                "stzhk-preview-progress",
                serde_json::json!({
                    "stage": "hashing",
                    "current": 0,
                    "total": total_mods,
                    "message": "Calculating hashes..."
                }),
            );

            // First pass: collect all mod info and calculate hashes (in PARALLEL!)
            struct PreviewModInfo {
                filename: String,
                name: String,
                sha256: String,
                sha512: String,
                size: u64,
            }

            // Process mods in parallel using spawn_blocking for CPU-intensive hash calculation
            // Use atomic counter for progress to avoid jumpy numbers when tasks complete out of order
            let progress_counter = Arc::new(AtomicUsize::new(0));
            let mut handles = Vec::new();

            for path in mod_paths.into_iter() {
                let app = app_handle.clone();
                let total = total_mods;
                let counter = Arc::clone(&progress_counter);

                handles.push(tokio::spawn(async move {
                    let filename = path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("")
                        .to_string();

                    // Read file
                    let content = match tokio::fs::read(&path).await {
                        Ok(c) => c,
                        Err(e) => {
                            log::warn!("Failed to read mod {}: {}", filename, e);
                            // Still increment counter even on failure
                            let current = counter.fetch_add(1, Ordering::SeqCst) + 1;
                            let _ = app.emit(
                                "stzhk-preview-progress",
                                serde_json::json!({
                                    "stage": "hashing",
                                    "current": current,
                                    "total": total,
                                    "message": format!("Skipped: {}", filename)
                                }),
                            );
                            return None;
                        }
                    };

                    let size = content.len() as u64;
                    let filename_for_name = filename.clone();
                    let path_for_name = path.clone();

                    // Calculate hashes in blocking thread (CPU intensive)
                    let (sha256, sha512) = tokio::task::spawn_blocking(move || {
                        let sha256 = {
                            let mut hasher = Sha256::new();
                            hasher.update(&content);
                            format!("{:x}", hasher.finalize())
                        };
                        let sha512 = {
                            let mut hasher = Sha512::new();
                            hasher.update(&content);
                            format!("{:x}", hasher.finalize())
                        };
                        (sha256, sha512)
                    })
                    .await
                    .unwrap_or_default();

                    // Try to extract mod name
                    let mod_name =
                        Self::extract_mod_name(&path_for_name).unwrap_or(filename_for_name.clone());

                    // Emit progress with atomic counter (always increments sequentially)
                    let current = counter.fetch_add(1, Ordering::SeqCst) + 1;
                    let _ = app.emit(
                        "stzhk-preview-progress",
                        serde_json::json!({
                            "stage": "hashing",
                            "current": current,
                            "total": total,
                            "message": format!("Processing: {}", filename)
                        }),
                    );

                    Some(PreviewModInfo {
                        filename,
                        name: mod_name,
                        sha256,
                        sha512,
                        size,
                    })
                }));
            }

            // Collect results
            let mut preview_mods: Vec<PreviewModInfo> = Vec::new();
            for handle in handles {
                if let Ok(Some(info)) = handle.await {
                    preview_mods.push(info);
                }
            }

            // If embedding all mods, skip Modrinth lookup
            if embed_mods {
                for mod_info in preview_mods {
                    embedded_size += mod_info.size;
                    mods_info.push(ExportModInfo {
                        filename: mod_info.filename,
                        name: mod_info.name,
                        version: None,
                        sha256: mod_info.sha256,
                        size: mod_info.size,
                        source_type: "embedded".to_string(),
                        will_embed: true,
                        download_url: None,
                        modrinth_project_id: None,
                    });
                }
            } else {
                // Emit progress for Modrinth lookup
                let _ = app_handle.emit(
                    "stzhk-preview-progress",
                    serde_json::json!({
                        "stage": "modrinth",
                        "current": 0,
                        "total": preview_mods.len(),
                        "message": "Looking up mods on Modrinth..."
                    }),
                );

                // Batch lookup on Modrinth using SHA512
                let sha512_hashes: Vec<String> =
                    preview_mods.iter().map(|m| m.sha512.clone()).collect();
                let modrinth_results = Self::find_mods_on_modrinth_batch(&sha512_hashes).await;

                // Emit progress after Modrinth lookup complete
                let _ = app_handle.emit(
                    "stzhk-preview-progress",
                    serde_json::json!({
                        "stage": "processing",
                        "current": preview_mods.len(),
                        "total": preview_mods.len(),
                        "message": "Processing results..."
                    }),
                );

                // Build results with Modrinth data
                for mod_info in preview_mods {
                    let (source_type, will_embed, download_url, modrinth_project_id) =
                        if let Some(modrinth_source) = modrinth_results.get(&mod_info.sha512) {
                            match modrinth_source {
                                ModSource::Modrinth {
                                    project_id,
                                    download_url,
                                    ..
                                } => {
                                    modrinth_count += 1;
                                    (
                                        "modrinth".to_string(),
                                        false,
                                        Some(download_url.clone()),
                                        Some(project_id.clone()),
                                    )
                                }
                                _ => {
                                    // Local mod - will be embedded
                                    local_count += 1;
                                    embedded_size += mod_info.size;
                                    ("local".to_string(), true, None, None)
                                }
                            }
                        } else {
                            // Not found on Modrinth - local mod
                            local_count += 1;
                            embedded_size += mod_info.size;
                            ("local".to_string(), true, None, None)
                        };

                    mods_info.push(ExportModInfo {
                        filename: mod_info.filename,
                        name: mod_info.name,
                        version: None,
                        sha256: mod_info.sha256, // Keep SHA256 for manifest verification
                        size: mod_info.size,
                        source_type,
                        will_embed,
                        download_url,
                        modrinth_project_id,
                    });
                }
            }
        }

        // Save to cache for reuse in export
        {
            let cached: Vec<CachedModData> = mods_info
                .iter()
                .map(|m| {
                    let source = if m.source_type == "modrinth" {
                        if let (Some(project_id), Some(url)) =
                            (&m.modrinth_project_id, &m.download_url)
                        {
                            ModSource::Modrinth {
                                project_id: project_id.clone(),
                                version_id: String::new(), // Not needed for export
                                download_url: url.clone(),
                            }
                        } else {
                            ModSource::Embedded {
                                path: format!("mods/{}", m.filename),
                            }
                        }
                    } else {
                        ModSource::Embedded {
                            path: format!("mods/{}", m.filename),
                        }
                    };

                    CachedModData {
                        filename: m.filename.clone(),
                        name: m.name.clone(),
                        sha256: m.sha256.clone(),
                        size: m.size,
                        source,
                    }
                })
                .collect();

            if let Ok(mut cache) = PREVIEW_CACHE.lock() {
                *cache = Some((instance_id.to_string(), embed_mods, cached));
                log::info!(
                    "Cached {} mods for instance {} (embed={})",
                    mods_info.len(),
                    instance_id,
                    embed_mods
                );
            }
        }

        // Get overrides info
        let mut overrides_info: Vec<ExportOverrideInfo> = Vec::new();
        let mut overrides_size: u64 = 0;

        if include_overrides {
            let override_items = vec![
                // === Конфигурация ===
                ("config", instance_path.join("config")),
                ("defaultconfigs", instance_path.join("defaultconfigs")),
                // === Скрипты ===
                ("kubejs", instance_path.join("kubejs")),
                ("scripts", instance_path.join("scripts")),
                ("openloader", instance_path.join("openloader")),
                ("packmode", instance_path.join("packmode")),
                // === Ресурсы ===
                ("resourcepacks", instance_path.join("resourcepacks")),
                ("shaderpacks", instance_path.join("shaderpacks")),
                ("resources", instance_path.join("resources")),
                ("assets", instance_path.join("assets")),
                ("patchouli_books", instance_path.join("patchouli_books")),
                ("global_packs", instance_path.join("global_packs")),
                ("local", instance_path.join("local")),
                // === Настройки игры ===
                ("options.txt", instance_path.join("options.txt")),
                ("servers.dat", instance_path.join("servers.dat")),
                // === Генерируемые данные (можно исключить для экономии места) ===
                ("saves", instance_path.join("saves")),
                ("screenshots", instance_path.join("screenshots")),
                ("schematics", instance_path.join("schematics")),
                ("replay_recordings", instance_path.join("replay_recordings")),
                ("worldedit", instance_path.join("worldedit")),
            ];

            for (name, path) in override_items {
                // Use async exists check instead of blocking
                if !tokio::fs::try_exists(&path).await.unwrap_or(false) {
                    continue;
                }

                // Use async metadata to check file type
                let meta = tokio::fs::metadata(&path).await?;
                let is_file = meta.is_file();
                let (size, file_count) = if is_file {
                    (meta.len(), 1)
                } else {
                    let size = Self::calculate_dir_size(&path).await.unwrap_or(0);
                    let count = Self::count_files_in_dir(&path).await.unwrap_or(0);
                    (size, count)
                };

                overrides_size += size;

                let category = OverrideCategory::from_name(name);
                let hint = category.hint().map(|s| s.to_string());

                overrides_info.push(ExportOverrideInfo {
                    name: name.to_string(),
                    path: path.to_string_lossy().to_string(),
                    size,
                    file_count,
                    is_file,
                    category,
                    hint,
                });
            }
        }

        // If embedding all mods, count them all as embedded
        if embed_mods {
            local_count = mods_info.len() as u32;
            modrinth_count = 0;
        }

        Ok(ExportPreview {
            instance_name: name,
            minecraft_version: version,
            loader,
            loader_version,
            mods: mods_info,
            overrides: overrides_info,
            modrinth_mods_count: modrinth_count,
            local_mods_count: local_count,
            embedded_size,
            overrides_size,
        })
    }

    /// Count files in directory recursively
    async fn count_files_in_dir(path: &Path) -> Result<u32> {
        let mut count: u32 = 0;
        let mut read_dir = tokio::fs::read_dir(path).await?;

        while let Some(entry) = read_dir.next_entry().await? {
            let entry_path = entry.path();
            let metadata = tokio::fs::metadata(&entry_path).await?;

            if metadata.is_file() {
                count += 1;
            } else if metadata.is_dir() {
                count += Box::pin(Self::count_files_in_dir(&entry_path)).await?;
            }
        }

        Ok(count)
    }
}

/// Предпросмотр STZHK модпака (для импорта)
#[derive(Debug, Clone, Serialize)]
pub struct StzhkPreview {
    pub manifest: StzhkManifest,
    pub embedded_mods_count: u32,
    pub linked_mods_count: u32,
    pub overrides_mods_count: u32,
    pub total_size: u64,
}

/// Информация о моде для предпросмотра экспорта
#[derive(Debug, Clone, Serialize)]
pub struct ExportModInfo {
    /// Имя файла
    pub filename: String,
    /// Название мода
    pub name: String,
    /// Версия мода
    pub version: Option<String>,
    /// SHA256 хеш
    pub sha256: String,
    /// Размер в байтах
    pub size: u64,
    /// Тип источника: "modrinth", "curseforge", "local"
    pub source_type: String,
    /// Будет ли встроен в архив (локальные моды всегда встраиваются)
    pub will_embed: bool,
    /// URL для скачивания (если есть)
    pub download_url: Option<String>,
    /// Project ID на Modrinth (если есть)
    pub modrinth_project_id: Option<String>,
}

/// Категория override файла для подсказок в UI
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum OverrideCategory {
    /// Конфигурация модов (config, defaultconfigs)
    Config,
    /// Скрипты (kubejs, scripts, openloader)
    Scripts,
    /// Ресурсы (resourcepacks, shaderpacks)
    Resources,
    /// Генерируемые данные (миры, логи, кэш) - можно исключить
    Generated,
    /// Настройки игры (options.txt, servers.dat)
    GameSettings,
    /// Прочее
    Other,
}

/// Информация об оверрайдах для предпросмотра
#[derive(Debug, Clone, Serialize)]
pub struct ExportOverrideInfo {
    /// Название (config, resourcepacks, etc.)
    pub name: String,
    /// Полный путь
    pub path: String,
    /// Размер в байтах
    pub size: u64,
    /// Количество файлов
    pub file_count: u32,
    /// Это файл или директория
    pub is_file: bool,
    /// Категория для подсказок в UI
    pub category: OverrideCategory,
    /// Подсказка для пользователя (локализуется на фронте)
    pub hint: Option<String>,
}

impl OverrideCategory {
    /// Определить категорию по имени папки/файла
    pub fn from_name(name: &str) -> Self {
        match name {
            // Конфигурация
            "config" | "defaultconfigs" => Self::Config,
            // Скрипты
            "kubejs" | "scripts" | "openloader" | "packmode" => Self::Scripts,
            // Ресурсы
            "resourcepacks" | "shaderpacks" | "texturepacks" => Self::Resources,
            // Настройки игры
            "options.txt" | "servers.dat" | "usercache.json" | "usernamecache.json" => {
                Self::GameSettings
            }
            // Генерируемые (можно исключить для экономии места)
            "saves" | "logs" | "crash-reports" | ".fabric" | ".mixin.out" | "cache" | ".cache"
            | "replay_recordings" | "screenshots" | "schematics" | "worldedit" => Self::Generated,
            // Прочее
            _ => Self::Other,
        }
    }

    /// Получить подсказку для категории
    pub fn hint(&self) -> Option<&'static str> {
        match self {
            Self::Config => Some("mod_configs"),
            Self::Scripts => Some("modpack_scripts"),
            Self::Resources => Some("resource_files"),
            Self::GameSettings => Some("game_settings"),
            Self::Generated => Some("generated_data"),
            Self::Other => None,
        }
    }
}

/// Результат предпросмотра экспорта
#[derive(Debug, Clone, Serialize)]
pub struct ExportPreview {
    /// Информация об экземпляре
    pub instance_name: String,
    pub minecraft_version: String,
    pub loader: String,
    pub loader_version: Option<String>,
    /// Список модов с детальной информацией
    pub mods: Vec<ExportModInfo>,
    /// Информация об оверрайдах
    pub overrides: Vec<ExportOverrideInfo>,
    /// Сколько модов будет загружено с Modrinth
    pub modrinth_mods_count: u32,
    /// Сколько модов локальных (будут встроены)
    pub local_mods_count: u32,
    /// Общий размер встраиваемых файлов
    pub embedded_size: u64,
    /// Общий размер оверрайдов
    pub overrides_size: u64,
}

// ========== Tauri Commands ==========

/// Предпросмотр STZHK модпака (для импорта)
#[tauri::command]
pub async fn preview_stzhk(path: String) -> Result<StzhkPreview> {
    StzhkManager::preview(&PathBuf::from(path)).await
}

/// Предпросмотр экспорта в STZHK (показывает какие файлы будут включены)
#[tauri::command]
pub async fn preview_stzhk_export(
    instance_id: String,
    embed_mods: bool,
    include_overrides: bool,
    app_handle: tauri::AppHandle,
) -> Result<ExportPreview> {
    StzhkManager::get_export_preview(&instance_id, embed_mods, include_overrides, &app_handle).await
}

/// Установить STZHK модпак
#[tauri::command]
pub async fn install_stzhk(
    path: String,
    instance_name: String,
    selected_optionals: Vec<String>,
    app_handle: tauri::AppHandle,
) -> Result<String> {
    let download_manager = DownloadManager::new(app_handle.clone())?;
    StzhkManager::install(
        &PathBuf::from(path),
        instance_name,
        selected_optionals,
        &download_manager,
        &app_handle,
    )
    .await
}

/// Параметры экспорта в STZHK
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    /// Название модпака
    pub name: String,
    /// Версия модпака
    pub version: String,
    /// Автор модпака
    pub author: String,
    /// Описание модпака
    pub description: Option<String>,
    /// Встраивать моды в архив (иначе только ссылки)
    pub embed_mods: bool,
    /// Включать overrides (конфиги, ресурспаки и т.д.)
    pub include_overrides: bool,
    /// Исключённые моды (по filename)
    #[serde(default)]
    pub excluded_mods: Vec<String>,
    /// Исключённые overrides (по имени папки/файла)
    #[serde(default)]
    pub excluded_overrides: Vec<String>,
}

/// Экспортировать экземпляр в STZHK
#[tauri::command]
pub async fn export_stzhk(
    instance_id: String,
    output_path: String,
    options: ExportOptions,
    app_handle: tauri::AppHandle,
) -> Result<String> {
    let path = StzhkManager::export_instance(
        &instance_id,
        &PathBuf::from(output_path),
        &options,
        &app_handle,
    )
    .await?;

    Ok(path.to_string_lossy().to_string())
}

/// Установить STZHK модпак по URL (Яндекс.Диск, Google Drive, прямые ссылки)
#[tauri::command]
pub async fn install_stzhk_from_url(
    url: String,
    instance_name: String,
    selected_optionals: Vec<String>,
    app_handle: tauri::AppHandle,
) -> Result<String> {
    use crate::paths::cache_dir;

    log::info!("Installing STZHK modpack from URL: {}", url);

    // Emit downloading stage
    let _ = app_handle.emit(
        "modpack-install-progress",
        serde_json::json!({
            "stage": "downloading",
            "current": 0,
            "total": 1,
            "current_file": "modpack.stzhk"
        }),
    );

    // Resolve direct download URL (handle Yandex.Disk, Google Drive, etc.)
    let direct_url = resolve_download_url(&url).await?;

    // Download to temp directory
    let temp_dir = cache_dir().join("temp");
    tokio::fs::create_dir_all(&temp_dir).await?;

    let filename =
        extract_filename_from_url(&direct_url).unwrap_or_else(|| "modpack.stzhk".to_string());
    let temp_path = temp_dir.join(&filename);

    // Download file
    let download_manager = DownloadManager::new(app_handle.clone())?;
    download_manager
        .download_file(&direct_url, &temp_path, &filename, None)
        .await?;

    log::info!("Downloaded modpack to {:?}", temp_path);

    // Install from downloaded file
    let instance_id = StzhkManager::install(
        &temp_path,
        instance_name,
        selected_optionals,
        &download_manager,
        &app_handle,
    )
    .await?;

    // Cleanup temp file
    let _ = tokio::fs::remove_file(&temp_path).await;

    Ok(instance_id)
}

/// Resolve download URL for cloud services (Yandex.Disk, Google Drive, etc.)
async fn resolve_download_url(url: &str) -> Result<String> {
    // Yandex.Disk public links
    if url.contains("disk.yandex") || url.contains("yadi.sk") {
        return resolve_yandex_disk_url(url).await;
    }

    // Google Drive
    if url.contains("drive.google.com") {
        return resolve_google_drive_url(url);
    }

    // Dropbox - replace dl=0 with dl=1
    if url.contains("dropbox.com") {
        return Ok(url.replace("dl=0", "dl=1"));
    }

    // Direct link - return as is
    Ok(url.to_string())
}

/// Resolve Yandex.Disk public link to direct download URL
async fn resolve_yandex_disk_url(url: &str) -> Result<String> {
    let api_url = format!(
        "https://cloud-api.yandex.net/v1/disk/public/resources/download?public_key={}",
        urlencoding::encode(url)
    );

    let response = crate::utils::SHARED_HTTP_CLIENT
        .get(&api_url)
        .send()
        .await?;

    if !response.status().is_success() {
        return Err(LauncherError::ApiError(format!(
            "Yandex.Disk API error: {}",
            response.status()
        )));
    }

    #[derive(serde::Deserialize)]
    struct YandexResponse {
        href: String,
    }

    let data: YandexResponse = response.json().await?;

    Ok(data.href)
}

/// Resolve Google Drive share link to direct download URL
fn resolve_google_drive_url(url: &str) -> Result<String> {
    // Extract file ID from various Google Drive URL formats
    let file_id = if url.contains("/file/d/") {
        url.split("/file/d/")
            .nth(1)
            .and_then(|s| s.split('/').next())
    } else if url.contains("id=") {
        url.split("id=").nth(1).and_then(|s| s.split('&').next())
    } else {
        None
    };

    match file_id {
        Some(id) => Ok(format!(
            "https://drive.google.com/uc?export=download&id={}",
            id
        )),
        None => Err(LauncherError::ApiError(
            "Could not extract Google Drive file ID from URL".to_string(),
        )),
    }
}

/// Extract filename from URL
fn extract_filename_from_url(url: &str) -> Option<String> {
    url.split('/')
        .last()
        .and_then(|s| s.split('?').next())
        .filter(|s| !s.is_empty() && s.contains('.'))
        .map(|s| {
            // Decode URL encoding
            urlencoding::decode(s)
                .unwrap_or_else(|_| s.into())
                .to_string()
        })
}

/// Проверить целостность экземпляра по манифесту STZHK
#[tauri::command]
pub async fn verify_stzhk_instance(
    instance_id: String,
    manifest_path: String,
) -> Result<VerificationResult> {
    let manifest = StzhkManager::read_manifest(&PathBuf::from(manifest_path)).await?;
    StzhkManager::verify_instance(&instance_id, &manifest).await
}

// ========== Export to .mrpack (Modrinth format) ==========

use crate::modpacks::types::{
    ModrinthModpackDependencies, ModrinthModpackEnv, ModrinthModpackFile, ModrinthModpackHashes,
    ModrinthModpackIndex,
};

/// Options for .mrpack export
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MrpackExportOptions {
    pub name: String,
    pub version: String,
    pub summary: Option<String>,
    #[serde(default)]
    pub include_overrides: bool,
    #[serde(default)]
    pub excluded_mods: Vec<String>,
    #[serde(default)]
    pub excluded_overrides: Vec<String>,
}

/// Export instance to .mrpack (Modrinth modpack format)
/// Compatible with Prism Launcher, Modrinth App, etc.
#[tauri::command]
pub async fn export_mrpack(
    instance_id: String,
    output_path: String,
    options: MrpackExportOptions,
    app_handle: tauri::AppHandle,
) -> Result<String> {
    use crate::db::get_db_conn;
    use crate::instances;
    use crate::paths::instance_mods_dir;
    use std::io::Write as IoWriteTrait;
    use tauri::Emitter;
    use zip::write::SimpleFileOptions as ZipOptions;

    log::info!(
        "Exporting instance {} to .mrpack: {:?}",
        instance_id,
        output_path
    );

    // Get instance details
    let instance = instances::lifecycle::get_instance(instance_id.clone()).await?;

    // Emit progress
    let _ = app_handle.emit(
        "export-progress",
        serde_json::json!({
            "stage": "preparing",
            "progress": 0,
            "message": "Preparing export..."
        }),
    );

    // Get installed mods (sync block to ensure conn is dropped before any await)
    let mods_dir = instance_mods_dir(&instance_id);
    let mods_rows: Vec<(String, String, String, String, Option<String>, bool)> = {
        let conn = get_db_conn()?;
        let mut rows = Vec::new();
        {
            let mut stmt = conn.prepare(
                "SELECT slug, name, file_name, source, source_id, enabled
                 FROM mods WHERE instance_id = ?1",
            )?;
            let mut query_rows = stmt.query([&instance_id])?;
            while let Some(row) = query_rows.next()? {
                rows.push((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, bool>(5)?,
                ));
            }
        }
        rows
    }; // conn dropped here, before any await

    // Collect mod files and their hashes
    let mut mrpack_files: Vec<ModrinthModpackFile> = Vec::new();
    let mut override_mods: Vec<(String, Vec<u8>)> = Vec::new(); // filename, content

    let total_mods = mods_rows.len();
    let mut processed = 0;

    for (slug, name, file_name, source, source_id, enabled) in &mods_rows {
        // Skip excluded mods
        if options.excluded_mods.contains(file_name) {
            continue;
        }

        // Skip disabled mods
        if !enabled {
            continue;
        }

        let mod_path = mods_dir.join(file_name);
        if !tokio::fs::try_exists(&mod_path).await.unwrap_or(false) {
            log::warn!("Mod file not found: {:?}", mod_path);
            continue;
        }

        // Calculate hashes
        let content = tokio::fs::read(&mod_path).await?;
        let sha1 = format!("{:x}", sha1::Sha1::digest(&content));
        let sha512 = format!("{:x}", Sha512::digest(&content));
        let file_size = content.len() as u64;

        processed += 1;
        let _ = app_handle.emit(
            "export-progress",
            serde_json::json!({
                "stage": "processing_mods",
                "progress": (processed * 50) / total_mods,
                "message": format!("Processing mod: {}", name)
            }),
        );

        // If mod is from Modrinth, use CDN URL
        if source == "modrinth" {
            if let Some(version_id) = source_id {
                // Get download URL from Modrinth API
                let download_url = format!(
                    "https://cdn.modrinth.com/data/{}/versions/{}/{}",
                    slug, version_id, file_name
                );

                mrpack_files.push(ModrinthModpackFile {
                    path: format!("mods/{}", file_name),
                    hashes: ModrinthModpackHashes {
                        sha1,
                        sha512: Some(sha512),
                    },
                    env: Some(ModrinthModpackEnv {
                        client: Some("required".to_string()),
                        server: Some("required".to_string()),
                    }),
                    downloads: vec![download_url],
                    file_size,
                });
                continue;
            }
        }

        // For CurseForge and local mods, add to overrides
        override_mods.push((file_name.clone(), content));
    }

    // Build dependencies
    let loader = instance.loader.as_str();
    let dependencies = ModrinthModpackDependencies {
        minecraft: instance.version.clone(),
        fabric_loader: if loader == "fabric" {
            instance.loader_version.clone()
        } else {
            None
        },
        quilt_loader: if loader == "quilt" {
            instance.loader_version.clone()
        } else {
            None
        },
        forge: if loader == "forge" {
            instance.loader_version.clone()
        } else {
            None
        },
        neoforge: if loader == "neoforge" {
            instance.loader_version.clone()
        } else {
            None
        },
    };

    // Build manifest
    let manifest = ModrinthModpackIndex {
        format_version: 1,
        game: "minecraft".to_string(),
        version_id: options.version.clone(),
        name: options.name.clone(),
        summary: options.summary.clone(),
        files: mrpack_files,
        dependencies,
    };

    // Collect override files (configs, etc.)
    let mut override_files: Vec<(String, Vec<u8>)> = Vec::new();

    if options.include_overrides {
        let instance_path = instances_dir().join(&instance_id);

        // Directories to include in overrides
        let override_dirs = ["config", "kubejs", "scripts", "defaultconfigs"];

        for dir_name in override_dirs {
            if options.excluded_overrides.contains(&dir_name.to_string()) {
                continue;
            }

            let dir_path = instance_path.join(dir_name);
            if tokio::fs::try_exists(&dir_path).await.unwrap_or(false) && dir_path.is_dir() {
                collect_override_files(&dir_path, dir_name, &mut override_files).await?;
            }
        }
    }

    let _ = app_handle.emit(
        "export-progress",
        serde_json::json!({
            "stage": "writing_archive",
            "progress": 75,
            "message": "Writing .mrpack archive..."
        }),
    );

    // Write .mrpack file (sync operation)
    let output = PathBuf::from(&output_path);
    let manifest_json = serde_json::to_string_pretty(&manifest)?;

    tokio::task::spawn_blocking(move || -> Result<()> {
        let file = std::fs::File::create(&output)?;
        let mut zip = ZipWriter::new(file);
        let options = ZipOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .compression_level(Some(6));

        // Write modrinth.index.json
        zip.start_file("modrinth.index.json", options)?;
        zip.write_all(manifest_json.as_bytes())?;

        // Write override mods
        for (filename, content) in override_mods {
            let path = format!("overrides/mods/{}", filename);
            zip.start_file(&path, options)?;
            zip.write_all(&content)?;
        }

        // Write other overrides
        for (path, content) in override_files {
            let archive_path = format!("overrides/{}", path);
            zip.start_file(&archive_path, options)?;
            zip.write_all(&content)?;
        }

        zip.finish()?;
        Ok(())
    })
    .await
    .map_err(|e| LauncherError::Join(e.to_string()))??;

    let _ = app_handle.emit(
        "export-progress",
        serde_json::json!({
            "stage": "complete",
            "progress": 100,
            "message": "Export complete!"
        }),
    );

    log::info!("Successfully exported to {}", output_path);
    Ok(output_path)
}

// ============================================================================
// Universal ZIP Export (for friends without launcher)
// ============================================================================

#[derive(Debug, Clone, serde::Deserialize)]
pub struct UniversalZipOptions {
    pub name: String,
    pub version: String,
    pub author: String,
    pub description: Option<String>,
    pub include_readme: bool,
    pub readme_language: String, // "ru", "en", or "both"
    pub excluded_mods: Vec<String>,
    pub excluded_overrides: Vec<String>,
}

/// Export instance to universal .zip for friends without any launcher.
/// Contains all mods embedded, configs, and README with installation instructions.
#[tauri::command]
pub async fn export_universal_zip(
    instance_id: String,
    output_path: String,
    options: UniversalZipOptions,
    app_handle: tauri::AppHandle,
) -> Result<String> {
    use crate::db::get_db_conn;
    use crate::instances;
    use crate::paths::{instance_mods_dir, instances_dir};
    use std::io::Write as IoWriteTrait;
    use tauri::Emitter;
    use zip::write::SimpleFileOptions as ZipOptions;

    log::info!(
        "Exporting instance {} to universal ZIP: {:?}",
        instance_id,
        output_path
    );

    // Get instance details
    let instance = instances::lifecycle::get_instance(instance_id.clone()).await?;

    // Emit progress
    let _ = app_handle.emit(
        "export-progress",
        serde_json::json!({
            "stage": "preparing",
            "progress": 0,
            "message": "Preparing export..."
        }),
    );

    // Get installed mods from database
    let mods_dir = instance_mods_dir(&instance_id);
    let mods_rows: Vec<(String, String, bool)> = {
        let conn = get_db_conn()?;
        let mut rows = Vec::new();
        {
            let mut stmt = conn.prepare(
                "SELECT name, file_name, enabled FROM mods WHERE instance_id = ?1",
            )?;
            let mut query_rows = stmt.query([&instance_id])?;
            while let Some(row) = query_rows.next()? {
                rows.push((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, bool>(2)?,
                ));
            }
        }
        rows
    };

    // Collect all mod files (embed all)
    let mut mod_files: Vec<(String, Vec<u8>)> = Vec::new();
    let total_mods = mods_rows.len();
    let mut processed = 0;
    let mut mod_names: Vec<String> = Vec::new();

    for (name, file_name, enabled) in &mods_rows {
        // Skip excluded mods
        if options.excluded_mods.contains(file_name) {
            continue;
        }

        // Skip disabled mods
        if !enabled {
            continue;
        }

        processed += 1;
        let _ = app_handle.emit(
            "export-progress",
            serde_json::json!({
                "stage": "processing_mods",
                "progress": (processed * 40) / total_mods.max(1),
                "message": format!("Processing mod: {}", name)
            }),
        );

        // Read mod file
        let mod_path = mods_dir.join(file_name);
        if tokio::fs::try_exists(&mod_path).await.unwrap_or(false) {
            match tokio::fs::read(&mod_path).await {
                Ok(content) => {
                    mod_files.push((file_name.clone(), content));
                    mod_names.push(name.clone());
                }
                Err(e) => {
                    log::warn!("Failed to read mod file {}: {}", file_name, e);
                }
            }
        }
    }

    // Collect override files (configs, etc.)
    let mut override_files: Vec<(String, Vec<u8>)> = Vec::new();
    let instance_path = instances_dir().join(&instance_id);

    // Directories to include
    let override_dirs = [
        "config",
        "kubejs",
        "scripts",
        "defaultconfigs",
        "resourcepacks",
        "shaderpacks",
    ];

    let _ = app_handle.emit(
        "export-progress",
        serde_json::json!({
            "stage": "collecting_overrides",
            "progress": 50,
            "message": "Collecting configs and resources..."
        }),
    );

    for dir_name in override_dirs {
        if options.excluded_overrides.contains(&dir_name.to_string()) {
            continue;
        }

        let dir_path = instance_path.join(dir_name);
        if tokio::fs::try_exists(&dir_path).await.unwrap_or(false) && dir_path.is_dir() {
            collect_override_files(&dir_path, dir_name, &mut override_files).await?;
        }
    }

    // Also include options.txt and servers.dat if they exist
    for file_name in ["options.txt", "servers.dat"] {
        let file_path = instance_path.join(file_name);
        if tokio::fs::try_exists(&file_path).await.unwrap_or(false) {
            if let Ok(content) = tokio::fs::read(&file_path).await {
                override_files.push((file_name.to_string(), content));
            }
        }
    }

    // Generate README content
    let readme_content = if options.include_readme {
        generate_readme(
            &options.name,
            &options.version,
            &options.author,
            options.description.as_deref(),
            &instance.version,
            instance.loader.as_str(),
            instance.loader_version.as_deref(),
            &mod_names,
            &options.readme_language,
        )
    } else {
        String::new()
    };

    let _ = app_handle.emit(
        "export-progress",
        serde_json::json!({
            "stage": "writing_archive",
            "progress": 70,
            "message": "Creating ZIP archive..."
        }),
    );

    // Write ZIP file
    let output = output_path.clone();
    tokio::task::spawn_blocking(move || -> Result<()> {
        let file = std::fs::File::create(&output)?;
        let mut zip = zip::ZipWriter::new(file);
        let zip_options = ZipOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .compression_level(Some(6));

        // Write README
        if !readme_content.is_empty() {
            zip.start_file("README.md", zip_options)?;
            zip.write_all(readme_content.as_bytes())?;
        }

        // Write mods
        for (filename, content) in &mod_files {
            let archive_path = format!("mods/{}", filename);
            zip.start_file(&archive_path, zip_options)?;
            zip.write_all(content)?;
        }

        // Write override files
        for (path, content) in &override_files {
            zip.start_file(path, zip_options)?;
            zip.write_all(content)?;
        }

        zip.finish()?;
        Ok(())
    })
    .await
    .map_err(|e| LauncherError::Join(e.to_string()))??;

    let _ = app_handle.emit(
        "export-progress",
        serde_json::json!({
            "stage": "complete",
            "progress": 100,
            "message": "Export complete!"
        }),
    );

    log::info!("Successfully exported universal ZIP to {}", output_path);
    Ok(output_path)
}

/// Generate README.md content with installation instructions
fn generate_readme(
    name: &str,
    version: &str,
    author: &str,
    description: Option<&str>,
    mc_version: &str,
    loader: &str,
    loader_version: Option<&str>,
    mod_names: &[String],
    language: &str,
) -> String {
    let loader_name = match loader {
        "fabric" => "Fabric",
        "forge" => "Forge",
        "neoforge" => "NeoForge",
        "quilt" => "Quilt",
        _ => loader,
    };

    let loader_ver = loader_version.unwrap_or("latest");
    let desc = description.unwrap_or("");

    match language {
        "ru" => generate_readme_ru(name, version, author, desc, mc_version, loader_name, loader_ver, mod_names),
        "en" => generate_readme_en(name, version, author, desc, mc_version, loader_name, loader_ver, mod_names),
        _ => {
            // Both languages
            let ru = generate_readme_ru(name, version, author, desc, mc_version, loader_name, loader_ver, mod_names);
            let en = generate_readme_en(name, version, author, desc, mc_version, loader_name, loader_ver, mod_names);
            format!("{}\n\n---\n\n{}", ru, en)
        }
    }
}

fn generate_readme_ru(
    name: &str,
    version: &str,
    author: &str,
    description: &str,
    mc_version: &str,
    loader_name: &str,
    loader_version: &str,
    mod_names: &[String],
) -> String {
    let mods_list = if mod_names.len() <= 20 {
        mod_names.iter().map(|m| format!("- {}", m)).collect::<Vec<_>>().join("\n")
    } else {
        format!("{} модов (см. папку mods/)", mod_names.len())
    };

    format!(r#"# {name}

**Версия:** {version}
**Автор:** {author}
{desc_line}

## Требования

- **Minecraft:** {mc_version}
- **Загрузчик модов:** {loader_name} {loader_version}
- **Java:** 17+ (для 1.18+) или 8 (для 1.12.2)

## Инструкция по установке

### Способ 1: Через официальный лаунчер Minecraft

1. Скачай и установи {loader_name}:
   - Fabric: https://fabricmc.net/use/installer/
   - Forge: https://files.minecraftforge.net/
   - NeoForge: https://neoforged.net/
   - Quilt: https://quiltmc.org/install/

2. Запусти Minecraft хотя бы один раз с {loader_name}, чтобы создалась папка mods

3. Открой папку .minecraft:
   - Windows: нажми Win+R, введи `%appdata%\.minecraft`
   - macOS: ~/Library/Application Support/minecraft
   - Linux: ~/.minecraft

4. Скопируй содержимое этого архива в папку .minecraft:
   - папку `mods/` → в `.minecraft/mods/`
   - папку `config/` → в `.minecraft/config/`
   - остальные папки аналогично

5. Запусти Minecraft с профилем {loader_name} {mc_version}

### Способ 2: Через Prism Launcher / MultiMC (рекомендуется)

1. Скачай Prism Launcher: https://prismlauncher.org/

2. Создай новый экземпляр:
   - Нажми "Добавить экземпляр"
   - Выбери Minecraft {mc_version}
   - Выбери {loader_name} в качестве загрузчика

3. Открой папку экземпляра (ПКМ → "Папка")

4. Скопируй содержимое архива в папку `.minecraft` экземпляра

5. Запусти экземпляр

## Содержимое модпака

{mods_list}

## Проблемы?

- Убедись что версия Java соответствует версии Minecraft
- Проверь что установлена правильная версия {loader_name}
- Удали папку mods и config, затем скопируй заново

---
*Экспортировано с помощью Stuzhik Launcher*
"#,
        name = name,
        version = version,
        author = author,
        desc_line = if description.is_empty() { String::new() } else { format!("\n{}\n", description) },
        mc_version = mc_version,
        loader_name = loader_name,
        loader_version = loader_version,
        mods_list = mods_list,
    )
}

fn generate_readme_en(
    name: &str,
    version: &str,
    author: &str,
    description: &str,
    mc_version: &str,
    loader_name: &str,
    loader_version: &str,
    mod_names: &[String],
) -> String {
    let mods_list = if mod_names.len() <= 20 {
        mod_names.iter().map(|m| format!("- {}", m)).collect::<Vec<_>>().join("\n")
    } else {
        format!("{} mods (see mods/ folder)", mod_names.len())
    };

    format!(r#"# {name}

**Version:** {version}
**Author:** {author}
{desc_line}

## Requirements

- **Minecraft:** {mc_version}
- **Mod Loader:** {loader_name} {loader_version}
- **Java:** 17+ (for 1.18+) or 8 (for 1.12.2)

## Installation Guide

### Method 1: Official Minecraft Launcher

1. Download and install {loader_name}:
   - Fabric: https://fabricmc.net/use/installer/
   - Forge: https://files.minecraftforge.net/
   - NeoForge: https://neoforged.net/
   - Quilt: https://quiltmc.org/install/

2. Launch Minecraft at least once with {loader_name} to create the mods folder

3. Open .minecraft folder:
   - Windows: Press Win+R, type `%appdata%\.minecraft`
   - macOS: ~/Library/Application Support/minecraft
   - Linux: ~/.minecraft

4. Copy the contents of this archive to .minecraft:
   - `mods/` folder → `.minecraft/mods/`
   - `config/` folder → `.minecraft/config/`
   - other folders similarly

5. Launch Minecraft with {loader_name} {mc_version} profile

### Method 2: Prism Launcher / MultiMC (recommended)

1. Download Prism Launcher: https://prismlauncher.org/

2. Create a new instance:
   - Click "Add Instance"
   - Select Minecraft {mc_version}
   - Select {loader_name} as mod loader

3. Open instance folder (Right-click → "Folder")

4. Copy archive contents to the instance's `.minecraft` folder

5. Launch the instance

## Modpack Contents

{mods_list}

## Troubleshooting

- Make sure Java version matches Minecraft version requirements
- Verify correct {loader_name} version is installed
- Delete mods and config folders, then copy again

---
*Exported with Stuzhik Launcher*
"#,
        name = name,
        version = version,
        author = author,
        desc_line = if description.is_empty() { String::new() } else { format!("\n{}\n", description) },
        mc_version = mc_version,
        loader_name = loader_name,
        loader_version = loader_version,
        mods_list = mods_list,
    )
}

/// Recursively collect files from a directory for overrides
async fn collect_override_files(
    dir: &Path,
    base_path: &str,
    files: &mut Vec<(String, Vec<u8>)>,
) -> Result<()> {
    let mut entries = tokio::fs::read_dir(dir).await?;

    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let relative_path = format!("{}/{}", base_path, name);

        if path.is_dir() {
            // Recursively collect subdirectory
            Box::pin(collect_override_files(&path, &relative_path, files)).await?;
        } else if path.is_file() {
            // Read file content
            let content = tokio::fs::read(&path).await?;
            files.push((relative_path, content));
        }
    }

    Ok(())
}
