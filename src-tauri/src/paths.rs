use crate::error::{LauncherError, Result};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub static BASE_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn init_paths(base: PathBuf) -> Result<()> {
    BASE_DIR.set(base.clone()).map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::AlreadyExists, "BASE_DIR already set")
    })?;

    // Создаём основные директории
    fs::create_dir_all(base.join("instances"))?;
    fs::create_dir_all(base.join("shared/libraries"))?;
    fs::create_dir_all(base.join("shared/assets"))?;
    fs::create_dir_all(base.join("shared/versions"))?;
    fs::create_dir_all(base.join("shared/java"))?;
    fs::create_dir_all(base.join("shared/resourcepacks"))?;
    fs::create_dir_all(base.join("shared/shaderpacks"))?;
    fs::create_dir_all(base.join("backgrounds"))?;
    fs::create_dir_all(base.join("cache"))?;
    fs::create_dir_all(base.join("logs"))?;

    Ok(())
}

/// Директория для фоновых изображений
pub fn backgrounds_dir() -> PathBuf {
    get_base_dir().join("backgrounds")
}

pub fn get_base_dir() -> &'static Path {
    BASE_DIR.get().expect("BASE_DIR not initialized")
}

// Пути к общим директориям
pub fn shared_dir() -> PathBuf {
    get_base_dir().join("shared")
}

pub fn libraries_dir() -> PathBuf {
    shared_dir().join("libraries")
}

pub fn assets_dir() -> PathBuf {
    shared_dir().join("assets")
}

pub fn versions_dir() -> PathBuf {
    shared_dir().join("versions")
}

pub fn java_dir() -> PathBuf {
    shared_dir().join("java")
}

pub fn global_resourcepacks_dir() -> PathBuf {
    shared_dir().join("resourcepacks")
}

pub fn global_shaderpacks_dir() -> PathBuf {
    shared_dir().join("shaderpacks")
}

// Получение пути к версии Minecraft
pub fn minecraft_version_dir(version: &str) -> PathBuf {
    versions_dir().join(version)
}

pub fn minecraft_version_jar(version: &str) -> PathBuf {
    minecraft_version_dir(version).join(format!("{}.jar", version))
}

pub fn minecraft_version_json(version: &str) -> PathBuf {
    minecraft_version_dir(version).join(format!("{}.json", version))
}

pub fn cache_dir() -> PathBuf {
    get_base_dir().join("cache")
}

pub fn logs_dir() -> PathBuf {
    get_base_dir().join("logs")
}

// Пути к директориям экземпляров
pub fn instances_dir() -> PathBuf {
    get_base_dir().join("instances")
}

pub fn instance_dir(instance_id: &str) -> PathBuf {
    instances_dir().join(instance_id)
}

pub fn instance_mods_dir(instance_id: &str) -> PathBuf {
    instance_dir(instance_id).join("mods")
}

pub fn instance_config_dir(instance_id: &str) -> PathBuf {
    instance_dir(instance_id).join("config")
}

pub fn instance_resourcepacks_dir(instance_id: &str) -> PathBuf {
    instance_dir(instance_id).join("resourcepacks")
}

pub fn instance_shaderpacks_dir(instance_id: &str) -> PathBuf {
    instance_dir(instance_id).join("shaderpacks")
}

pub fn instance_saves_dir(instance_id: &str) -> PathBuf {
    instance_dir(instance_id).join("saves")
}

pub fn instance_world_dir(instance_id: &str) -> PathBuf {
    instance_dir(instance_id).join("world")
}

pub fn instance_logs_dir(instance_id: &str) -> PathBuf {
    instance_dir(instance_id).join("logs")
}

// Создание структуры директорий для нового экземпляра
pub fn create_instance_structure(instance_id: &str, is_server: bool) -> Result<()> {
    let base = instance_dir(instance_id);

    fs::create_dir_all(&base)?;
    fs::create_dir_all(base.join("mods"))?;
    fs::create_dir_all(base.join("config"))?;
    fs::create_dir_all(base.join("logs"))?;

    if is_server {
        fs::create_dir_all(base.join("world"))?;
        fs::create_dir_all(base.join("plugins"))?;
    } else {
        fs::create_dir_all(base.join("saves"))?;
        fs::create_dir_all(base.join("resourcepacks"))?;
        fs::create_dir_all(base.join("shaderpacks"))?;
        fs::create_dir_all(base.join("screenshots"))?;
    }

    Ok(())
}

// Получение версии Java по ID
pub fn java_installation_dir(java_version: &str) -> PathBuf {
    java_dir().join(format!("java-{}", java_version))
}

// Путь к базе данных
pub fn database_path() -> PathBuf {
    get_base_dir().join("launcher.db")
}

// ============== Find Newest File Helpers ==============

/// Синхронная версия поиска самого нового файла в директории.
/// Используется внутри spawn_blocking.
///
/// # Arguments
/// * `dir` - Директория для поиска
/// * `predicate` - Функция-предикат для фильтрации файлов (принимает DirEntry, возвращает bool)
///
/// # Example
/// ```rust
/// let newest = find_newest_file_sync(&crash_reports_dir, |entry| {
///     entry.path().extension().map(|ext| ext == "txt").unwrap_or(false)
/// });
/// ```
pub fn find_newest_file_sync<F>(dir: &Path, predicate: F) -> Option<PathBuf>
where
    F: Fn(&std::fs::DirEntry) -> bool,
{
    let entries = std::fs::read_dir(dir).ok()?;

    entries
        .filter_map(|e| e.ok())
        .filter(|e| predicate(e))
        .max_by_key(|e| {
            e.metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
        })
        .map(|e| e.path())
}

/// Синхронная версия поиска N самых новых файлов в директории.
/// Возвращает файлы отсортированные от самого нового к самому старому.
///
/// # Arguments
/// * `dir` - Директория для поиска
/// * `predicate` - Функция-предикат для фильтрации файлов
/// * `limit` - Максимальное количество файлов для возврата
pub fn find_newest_files_sync<F>(dir: &Path, predicate: F, limit: usize) -> Vec<PathBuf>
where
    F: Fn(&std::fs::DirEntry) -> bool,
{
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };

    let mut files: Vec<_> = entries
        .filter_map(|e| e.ok())
        .filter(|e| predicate(e))
        .collect();

    // Sort by modification time (newest first)
    files.sort_by(|a, b| {
        let time_a = a
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        let time_b = b
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        time_b.cmp(&time_a) // Newest first
    });

    files.into_iter().take(limit).map(|e| e.path()).collect()
}

/// Асинхронная версия поиска самого нового файла в директории.
///
/// # Arguments
/// * `dir` - Директория для поиска
/// * `predicate` - Функция-предикат для фильтрации файлов (принимает PathBuf, возвращает bool)
pub async fn find_newest_file_async<F>(dir: &Path, predicate: F) -> Option<PathBuf>
where
    F: Fn(&Path) -> bool,
{
    let mut entries = tokio::fs::read_dir(dir).await.ok()?;

    let mut newest_path: Option<PathBuf> = None;
    let mut newest_time = std::time::SystemTime::UNIX_EPOCH;

    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if !predicate(&path) {
            continue;
        }

        if let Ok(metadata) = tokio::fs::metadata(&path).await {
            if let Ok(modified) = metadata.modified() {
                if modified > newest_time {
                    newest_time = modified;
                    newest_path = Some(path);
                }
            }
        }
    }

    newest_path
}

/// Предикат для файлов с определённым расширением
pub fn has_extension(ext: &str) -> impl Fn(&std::fs::DirEntry) -> bool + '_ {
    move |entry: &std::fs::DirEntry| entry.path().extension().map(|e| e == ext).unwrap_or(false)
}

/// Предикат для файлов с определённым расширением (для async версии)
pub fn path_has_extension(ext: &str) -> impl Fn(&Path) -> bool + '_ {
    move |path: &Path| path.extension().map(|e| e == ext).unwrap_or(false)
}

/// Предикат для файлов соответствующих паттерну prefix*suffix
pub fn matches_pattern<'a>(
    prefix: &'a str,
    suffix: &'a str,
) -> impl Fn(&std::fs::DirEntry) -> bool + 'a {
    move |entry: &std::fs::DirEntry| {
        if let Some(filename) = entry.path().file_name() {
            let filename_str = filename.to_string_lossy();
            filename_str.starts_with(prefix) && filename_str.ends_with(suffix)
        } else {
            false
        }
    }
}

/// Предикат для файлов соответствующих паттерну prefix*suffix (для async версии)
pub fn path_matches_pattern<'a>(prefix: &'a str, suffix: &'a str) -> impl Fn(&Path) -> bool + 'a {
    move |path: &Path| {
        if let Some(filename) = path.file_name() {
            let filename_str = filename.to_string_lossy();
            filename_str.starts_with(prefix) && filename_str.ends_with(suffix)
        } else {
            false
        }
    }
}

// ============== Storage Info ==============

use serde::Serialize;

/// Информация о размере экземпляра
#[derive(Debug, Clone, Serialize)]
pub struct InstanceSizeInfo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub size: u64,
}

/// Полная информация о хранилище приложения
#[derive(Debug, Clone, Serialize)]
pub struct StorageInfo {
    pub total_size: u64,
    pub instances_size: u64,
    pub shared_size: u64,
    pub libraries_size: u64,
    pub assets_size: u64,
    pub versions_size: u64,
    pub java_size: u64,
    pub cache_size: u64,
    pub logs_size: u64,
    pub instances: Vec<InstanceSizeInfo>,
}

/// Информация о всех путях приложения
#[derive(Debug, Clone, Serialize)]
pub struct AppPaths {
    pub base: String,
    pub instances: String,
    pub shared: String,
    pub libraries: String,
    pub assets: String,
    pub versions: String,
    pub java: String,
    pub cache: String,
    pub logs: String,
    pub database: String,
    pub resourcepacks: String,
    pub shaderpacks: String,
}

/// Быстро вычисляет размер директории используя walkdir (без рекурсии)
fn calculate_dir_size(path: &Path) -> u64 {
    if !path.exists() {
        return 0;
    }

    walkdir::WalkDir::new(path)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| e.metadata().ok())
        .map(|m| m.len())
        .sum()
}

/// Получает информацию о хранилище
pub fn get_storage_info_sync() -> StorageInfo {
    let instances_path = instances_dir();
    let mut instances = Vec::new();
    let mut instances_size = 0u64;

    // Сканируем экземпляры
    if let Ok(entries) = fs::read_dir(&instances_path) {
        for entry in entries.filter_map(|e| e.ok()) {
            let entry_path = entry.path();
            if entry_path.is_dir() {
                let id = entry.file_name().to_string_lossy().to_string();
                let size = calculate_dir_size(&entry_path);
                instances_size += size;

                // Пробуем получить имя из метаданных
                let name = id.clone(); // По умолчанию используем id

                instances.push(InstanceSizeInfo {
                    id,
                    name,
                    path: entry_path.to_string_lossy().to_string(),
                    size,
                });
            }
        }
    }

    // Сортируем по размеру (больший первый)
    instances.sort_by(|a, b| b.size.cmp(&a.size));

    let libraries_size = calculate_dir_size(&libraries_dir());
    let assets_size = calculate_dir_size(&assets_dir());
    let versions_size = calculate_dir_size(&versions_dir());
    let java_size = calculate_dir_size(&java_dir());
    let cache_size = calculate_dir_size(&cache_dir());
    let logs_size = calculate_dir_size(&logs_dir());

    let shared_size = libraries_size
        + assets_size
        + versions_size
        + java_size
        + calculate_dir_size(&global_resourcepacks_dir())
        + calculate_dir_size(&global_shaderpacks_dir());

    let total_size = instances_size
        + shared_size
        + cache_size
        + logs_size
        + fs::metadata(database_path()).map(|m| m.len()).unwrap_or(0);

    StorageInfo {
        total_size,
        instances_size,
        shared_size,
        libraries_size,
        assets_size,
        versions_size,
        java_size,
        cache_size,
        logs_size,
        instances,
    }
}

/// Получает все пути приложения
pub fn get_app_paths_sync() -> AppPaths {
    AppPaths {
        base: get_base_dir().to_string_lossy().to_string(),
        instances: instances_dir().to_string_lossy().to_string(),
        shared: shared_dir().to_string_lossy().to_string(),
        libraries: libraries_dir().to_string_lossy().to_string(),
        assets: assets_dir().to_string_lossy().to_string(),
        versions: versions_dir().to_string_lossy().to_string(),
        java: java_dir().to_string_lossy().to_string(),
        cache: cache_dir().to_string_lossy().to_string(),
        logs: logs_dir().to_string_lossy().to_string(),
        database: database_path().to_string_lossy().to_string(),
        resourcepacks: global_resourcepacks_dir().to_string_lossy().to_string(),
        shaderpacks: global_shaderpacks_dir().to_string_lossy().to_string(),
    }
}

// ============== Tauri Commands ==============

/// Получает информацию о хранилище (async для UI)
#[tauri::command]
pub async fn get_storage_info() -> Result<StorageInfo> {
    // Выполняем в blocking потоке чтобы не блокировать async runtime
    tokio::task::spawn_blocking(get_storage_info_sync)
        .await
        .map_err(|e| crate::error::LauncherError::Join(format!("Task error: {}", e)))
}

/// Получает все пути приложения
#[tauri::command]
pub async fn get_app_paths() -> Result<AppPaths> {
    Ok(get_app_paths_sync())
}

/// Открывает папку в файловом менеджере
#[tauri::command]
pub async fn open_app_folder(folder_type: String) -> Result<()> {
    let path = match folder_type.as_str() {
        "base" => get_base_dir().to_path_buf(),
        "instances" => instances_dir(),
        "shared" => shared_dir(),
        "libraries" => libraries_dir(),
        "assets" => assets_dir(),
        "versions" => versions_dir(),
        "java" => java_dir(),
        "cache" => cache_dir(),
        "logs" => logs_dir(),
        "resourcepacks" => global_resourcepacks_dir(),
        "shaderpacks" => global_shaderpacks_dir(),
        _ => {
            return Err(crate::error::LauncherError::InvalidConfig(format!(
                "Unknown folder type: {}",
                folder_type
            )))
        }
    };

    // ИСПРАВЛЕНО: Используем tokio::fs вместо блокирующего std::fs
    if !tokio::fs::try_exists(&path).await.unwrap_or(false) {
        tokio::fs::create_dir_all(&path).await?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| crate::error::LauncherError::Io(e))?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| crate::error::LauncherError::Io(e))?;
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        std::process::Command::new("explorer")
            .arg(&path)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| crate::error::LauncherError::Io(e))?;
    }

    Ok(())
}

/// Очищает кэш приложения
#[tauri::command]
pub async fn clear_cache() -> Result<u64> {
    let cache_path = cache_dir();
    let size = calculate_dir_size(&cache_path);

    if cache_path.exists() {
        tokio::fs::remove_dir_all(&cache_path).await?;
        tokio::fs::create_dir_all(&cache_path).await?;
    }

    Ok(size)
}

/// Очищает логи приложения (кроме текущего лог-файла, который открыт для записи)
#[tauri::command]
pub async fn clear_logs() -> Result<u64> {
    let logs_path = logs_dir();

    if !tokio::fs::try_exists(&logs_path).await.unwrap_or(false) {
        return Ok(0);
    }

    // Используем unified helper для поиска текущего (самого нового) лог-файла
    // Он открыт для записи и не может быть удалён
    let current_log =
        find_newest_file_async(&logs_path, path_matches_pattern("launcher_", ".log")).await;

    // Delete all files except the current log
    let mut deleted_size: u64 = 0;
    // ИСПРАВЛЕНО: Используем tokio::fs::read_dir вместо блокирующего std::fs::read_dir
    let mut entries = tokio::fs::read_dir(&logs_path).await?;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();

        // Skip the current log file (it's open and locked)
        if let Some(ref current) = current_log {
            if path == *current {
                continue;
            }
        }

        // ИСПРАВЛЕНО: Используем tokio::fs::metadata вместо блокирующего std::fs::metadata
        // Calculate size before deleting
        if let Ok(metadata) = tokio::fs::metadata(&path).await {
            if metadata.is_file() {
                deleted_size += metadata.len();
            } else if metadata.is_dir() {
                deleted_size += calculate_dir_size(&path);
            }
        }

        // ИСПРАВЛЕНО: Используем tokio::fs::metadata для проверки is_dir вместо блокирующего path.is_dir()
        // Delete file or directory
        if let Ok(metadata) = tokio::fs::metadata(&path).await {
            if metadata.is_dir() {
                let _ = tokio::fs::remove_dir_all(&path).await;
            } else {
                let _ = tokio::fs::remove_file(&path).await;
            }
        }
    }

    Ok(deleted_size)
}

/// Запись лога для DevConsole
#[derive(Debug, Clone, serde::Serialize)]
pub struct LogEntry {
    pub timestamp: String,
    pub level: String,
    pub target: String,
    pub message: String,
}

/// Получает путь к текущему файлу логов лаунчера (самый новый)
#[tauri::command]
pub async fn get_current_log_path() -> Result<String> {
    let logs_path = logs_dir();
    if !tokio::fs::try_exists(&logs_path).await.unwrap_or(false) {
        return Err(LauncherError::NotFound("Logs directory not found".into()));
    }

    // Используем unified helper для поиска самого нового launcher_*.log
    find_newest_file_async(&logs_path, path_matches_pattern("launcher_", ".log"))
        .await
        .ok_or_else(|| LauncherError::NotFound("No launcher log files found".into()))
        .map(|p| p.to_string_lossy().to_string())
}

/// Очищает старые логи лаунчера (старше указанного количества дней)
pub fn cleanup_old_logs(keep_days: u64) -> Result<usize> {
    use std::time::SystemTime;

    let logs_path = logs_dir();
    if !logs_path.exists() {
        return Ok(0);
    }

    let now = SystemTime::now();
    let cutoff_duration = std::time::Duration::from_secs(keep_days * 24 * 60 * 60);

    let mut deleted_count = 0;

    // Читаем все файлы в папке logs
    let entries = std::fs::read_dir(&logs_path)?;

    for entry in entries.flatten() {
        let path = entry.path();

        // Проверяем что это файл launcher_*.log
        if let Some(filename) = path.file_name() {
            let filename_str = filename.to_string_lossy();
            if filename_str.starts_with("launcher_") && filename_str.ends_with(".log") {
                // Проверяем дату модификации файла
                if let Ok(metadata) = entry.metadata() {
                    if let Ok(modified) = metadata.modified() {
                        if let Ok(age) = now.duration_since(modified) {
                            if age > cutoff_duration {
                                // Файл старше cutoff_duration - удаляем
                                if std::fs::remove_file(&path).is_ok() {
                                    log::debug!(
                                        "Deleted old log file: {} (age: {} days)",
                                        filename_str,
                                        age.as_secs() / (24 * 60 * 60)
                                    );
                                    deleted_count += 1;
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if deleted_count > 0 {
        log::info!(
            "🧹 Cleaned up {} old log files (older than {} days)",
            deleted_count,
            keep_days
        );
    }

    Ok(deleted_count)
}

/// Читает последние N строк из файла логов лаунчера (текущей сессии)
#[tauri::command]
pub async fn read_launcher_logs(lines: Option<usize>) -> Result<Vec<LogEntry>> {
    // ИСПРАВЛЕНО: get_current_log_path() теперь async
    let log_file = get_current_log_path().await?;
    let log_path = std::path::PathBuf::from(log_file);

    // ИСПРАВЛЕНО: Используем tokio::fs::try_exists вместо блокирующего exists()
    if !tokio::fs::try_exists(&log_path).await.unwrap_or(false) {
        return Ok(vec![]);
    }

    let content = tokio::fs::read_to_string(&log_path).await?;
    let max_lines = lines.unwrap_or(1000); // Увеличили до 1000 для текущей сессии

    // Читаем последние N строк (без фильтрации - это уже файл текущей сессии!)
    let entries: Vec<LogEntry> = content
        .lines()
        .rev()
        .take(max_lines)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .filter_map(|line| parse_log_line(line))
        .collect();

    Ok(entries)
}

/// Читает новые строки из файла логов начиная с позиции (для real-time tail)
#[tauri::command]
pub async fn tail_launcher_logs(from_line: usize) -> Result<(Vec<LogEntry>, usize)> {
    // ИСПРАВЛЕНО: get_current_log_path() теперь async
    let log_file = get_current_log_path().await?;
    let log_path = std::path::PathBuf::from(log_file);

    // ИСПРАВЛЕНО: Используем tokio::fs::try_exists вместо блокирующего exists()
    if !tokio::fs::try_exists(&log_path).await.unwrap_or(false) {
        return Ok((vec![], 0));
    }

    let content = tokio::fs::read_to_string(&log_path).await?;
    let all_lines: Vec<&str> = content.lines().collect();
    let total_lines = all_lines.len();

    // Читаем только новые строки начиная с from_line
    let entries: Vec<LogEntry> = all_lines
        .into_iter()
        .skip(from_line)
        .filter_map(|line| parse_log_line(line))
        .collect();

    Ok((entries, total_lines))
}

/// Парсит строку лога в структуру
fn parse_log_line(line: &str) -> Option<LogEntry> {
    // Формат: [2025-12-03 12:34:56.789 INFO target] message
    if !line.starts_with('[') {
        return Some(LogEntry {
            timestamp: String::new(),
            level: "INFO".to_string(),
            target: String::new(),
            message: line.to_string(),
        });
    }

    let close_bracket = line.find(']')?;
    let header = &line[1..close_bracket];
    let message = line[close_bracket + 2..].to_string();

    let parts: Vec<&str> = header.splitn(3, ' ').collect();
    if parts.len() < 3 {
        return Some(LogEntry {
            timestamp: header.to_string(),
            level: "INFO".to_string(),
            target: String::new(),
            message,
        });
    }

    // parts[0] = date, parts[1] = time, rest = "LEVEL target"
    let timestamp = format!("{} {}", parts[0], parts[1]);
    let rest: Vec<&str> = parts[2].splitn(2, ' ').collect();
    let level = rest.first().unwrap_or(&"INFO").to_string();
    let target = rest.get(1).unwrap_or(&"").to_string();

    Some(LogEntry {
        timestamp,
        level,
        target,
        message,
    })
}

/// Информация о мёртвой (orphaned) папке экземпляра
#[derive(Debug, Clone, Serialize)]
pub struct OrphanedFolder {
    pub path: String,
    pub name: String,
    pub size: u64,
}

/// Получает список папок экземпляров без записи в БД (мёртвые папки)
#[tauri::command]
pub async fn get_orphaned_folders() -> Result<Vec<OrphanedFolder>> {
    use crate::db::get_db_conn;

    // Получаем список ID экземпляров из БД
    let db_ids: std::collections::HashSet<String> = {
        let conn = get_db_conn()?;
        let mut stmt = conn.prepare("SELECT id FROM instances")?;
        let ids = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .collect();
        ids
    };

    // Сканируем папки и находим те, которых нет в БД
    let instances_path = instances_dir();
    let mut orphaned = Vec::new();

    // ИСПРАВЛЕНО: Используем tokio::fs::read_dir вместо блокирующего std::fs::read_dir
    let mut entries = tokio::fs::read_dir(&instances_path).await?;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let entry_path = entry.path();
        // ИСПРАВЛЕНО: Используем tokio::fs::metadata для проверки is_dir вместо блокирующего is_dir()
        if let Ok(metadata) = tokio::fs::metadata(&entry_path).await {
            if metadata.is_dir() {
                let folder_name = entry.file_name().to_string_lossy().to_string();

                // Если папки нет в БД - это orphaned
                if !db_ids.contains(&folder_name) {
                    let size = calculate_dir_size(&entry_path);
                    orphaned.push(OrphanedFolder {
                        path: entry_path.to_string_lossy().to_string(),
                        name: folder_name,
                        size,
                    });
                }
            }
        }
    }

    // Сортируем по размеру (большие первые)
    orphaned.sort_by(|a, b| b.size.cmp(&a.size));

    Ok(orphaned)
}

/// Удаляет мёртвую папку экземпляра
#[tauri::command]
pub async fn delete_orphaned_folder(path: String) -> Result<u64> {
    let folder_path = std::path::PathBuf::from(&path);

    // Проверяем что путь находится внутри instances_dir (безопасность)
    let instances_path = instances_dir();
    if !folder_path.starts_with(&instances_path) {
        return Err(crate::error::LauncherError::InvalidConfig(
            "Path is not inside instances directory".to_string(),
        ));
    }

    // Проверяем что это действительно orphaned (нет в БД)
    use crate::db::get_db_conn;
    let folder_name = folder_path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| crate::error::LauncherError::InvalidConfig("Invalid path".to_string()))?;

    let exists_in_db: bool = {
        let conn = get_db_conn()?;
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM instances WHERE id = ?1",
            [folder_name],
            |row| row.get(0),
        )?;
        count > 0
    };

    if exists_in_db {
        return Err(crate::error::LauncherError::InvalidConfig(
            "This folder belongs to an existing instance".to_string(),
        ));
    }

    let size = calculate_dir_size(&folder_path);

    // ИСПРАВЛЕНО: Используем tokio::fs::try_exists вместо блокирующего exists()
    if tokio::fs::try_exists(&folder_path).await.unwrap_or(false) {
        tokio::fs::remove_dir_all(&folder_path).await?;
        log::info!("Deleted orphaned folder: {} ({} bytes)", path, size);
    }

    Ok(size)
}

/// Удаляет все мёртвые папки экземпляров
#[tauri::command]
pub async fn delete_all_orphaned_folders() -> Result<u64> {
    let orphaned = get_orphaned_folders().await?;
    let mut total_size = 0u64;

    for folder in orphaned {
        match delete_orphaned_folder(folder.path.clone()).await {
            Ok(size) => total_size += size,
            Err(e) => log::warn!("Failed to delete orphaned folder {}: {}", folder.path, e),
        }
    }

    Ok(total_size)
}

/// Копирует фоновое изображение в папку лаунчера
/// Возвращает путь к скопированному файлу
#[tauri::command]
pub async fn copy_background_image(source_path: String) -> Result<String> {
    let source = std::path::PathBuf::from(&source_path);

    // ИСПРАВЛЕНО: Используем tokio::fs::try_exists вместо блокирующего exists()
    if !tokio::fs::try_exists(&source).await.unwrap_or(false) {
        return Err(crate::error::LauncherError::InvalidConfig(format!(
            "Source file does not exist: {}",
            source_path
        )));
    }

    // Проверяем расширение файла
    let extension = source
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    let valid_extensions = ["png", "jpg", "jpeg", "webp", "gif"];
    if !valid_extensions.contains(&extension.as_str()) {
        return Err(crate::error::LauncherError::InvalidConfig(format!(
            "Invalid image format: {}. Supported: png, jpg, jpeg, webp, gif",
            extension
        )));
    }

    // Создаём директорию если не существует
    let bg_dir = backgrounds_dir();
    tokio::fs::create_dir_all(&bg_dir).await?;

    // Генерируем уникальное имя файла (background.ext)
    let dest_filename = format!("background.{}", extension);
    let dest_path = bg_dir.join(&dest_filename);

    // Удаляем старые фоны (любые файлы background.*)
    if let Ok(mut entries) = tokio::fs::read_dir(&bg_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("background.") {
                let _ = tokio::fs::remove_file(entry.path()).await;
            }
        }
    }

    // Копируем файл
    tokio::fs::copy(&source, &dest_path).await?;

    log::info!(
        "Copied background image: {} -> {}",
        source_path,
        dest_path.display()
    );

    Ok(dest_path.to_string_lossy().to_string())
}

/// Удаляет фоновое изображение
#[tauri::command]
pub async fn delete_background_image() -> Result<()> {
    let bg_dir = backgrounds_dir();

    if let Ok(mut entries) = tokio::fs::read_dir(&bg_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("background.") {
                tokio::fs::remove_file(entry.path()).await?;
                log::info!("Deleted background image: {}", entry.path().display());
            }
        }
    }

    Ok(())
}

/// Получает путь к текущему фоновому изображению (если есть)
#[tauri::command]
pub async fn get_background_image_path() -> Result<Option<String>> {
    let bg_dir = backgrounds_dir();

    if let Ok(mut entries) = tokio::fs::read_dir(&bg_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("background.") {
                return Ok(Some(entry.path().to_string_lossy().to_string()));
            }
        }
    }

    Ok(None)
}

/// Получает фоновое изображение как base64 data URL
/// Более надёжный способ, не зависящий от asset protocol scope
#[tauri::command]
pub async fn get_background_image_base64() -> Result<Option<String>> {
    use base64::{engine::general_purpose::STANDARD, Engine};

    let bg_dir = backgrounds_dir();

    if let Ok(mut entries) = tokio::fs::read_dir(&bg_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("background.") {
                let path = entry.path();

                // Определяем MIME тип по расширению
                let mime_type = match path.extension().and_then(|e| e.to_str()) {
                    Some("png") => "image/png",
                    Some("jpg") | Some("jpeg") => "image/jpeg",
                    Some("webp") => "image/webp",
                    Some("gif") => "image/gif",
                    _ => "application/octet-stream",
                };

                // Читаем файл и конвертируем в base64
                let bytes = tokio::fs::read(&path).await?;
                let base64_data = STANDARD.encode(&bytes);
                let data_url = format!("data:{};base64,{}", mime_type, base64_data);

                log::info!(
                    "Loaded background image as base64: {} ({} bytes)",
                    path.display(),
                    bytes.len()
                );

                return Ok(Some(data_url));
            }
        }
    }

    Ok(None)
}

// ============== Shared Resources Cleanup ==============

/// Информация об установленной Java
#[derive(Debug, Clone, serde::Serialize)]
pub struct InstalledJavaInfo {
    pub version: String,
    pub path: String,
    pub size: u64,
    pub is_used: bool,
    pub used_by_instances: Vec<String>,
}

/// Детальная разбивка shared ресурсов
#[derive(Debug, Clone, serde::Serialize)]
pub struct SharedResourcesBreakdown {
    pub java_versions: Vec<InstalledJavaInfo>,
    pub libraries_count: usize,
    pub libraries_size: u64,
    pub assets_indexes_count: usize,
    pub assets_size: u64,
    pub versions_count: usize,
    pub versions_size: u64,
    pub total_unused_size: u64,
}

/// Получает список установленных Java версий с информацией об использовании
#[tauri::command]
pub async fn get_installed_java_versions() -> Result<Vec<InstalledJavaInfo>> {
    // ИСПРАВЛЕНО: ВСЁ (включая DB) в spawn_blocking для Send safety
    tokio::task::spawn_blocking(|| {
        use crate::db::get_db_conn;
        use crate::java::JavaManager;

        let conn = get_db_conn()?;

        // Получаем все установленные Java из БД
        let mut stmt = conn.prepare("SELECT version, path FROM java_installations")?;
        let java_rows: Vec<(String, String)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .filter_map(|r| r.ok())
            .collect();

        // Получаем все экземпляры и их версии Minecraft
        let mut instances_stmt = conn.prepare("SELECT id, name, version FROM instances")?;
        let instances: Vec<(String, String, String)> = instances_stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .filter_map(|r| r.ok())
            .collect();

        drop(instances_stmt);
        drop(stmt);
        drop(conn);

        // Определяем какие Java версии нужны каждому экземпляру
        let mut required_java: std::collections::HashMap<u32, Vec<String>> =
            std::collections::HashMap::new();
        for (_, name, mc_version) in &instances {
            let java_ver = JavaManager::required_java_version(mc_version);
            required_java
                .entry(java_ver)
                .or_default()
                .push(name.clone());
        }

        // Вычисляем размеры для каждой Java версии
        let mut result = Vec::new();
        for (version, path) in java_rows {
            let path_buf = std::path::PathBuf::from(&path);
            let size = if path_buf.exists() {
                calculate_dir_size(&path_buf)
            } else {
                0
            };

            let java_major: u32 = version.parse().unwrap_or(0);
            let used_by = required_java.get(&java_major).cloned().unwrap_or_default();
            let is_used = !used_by.is_empty();

            result.push(InstalledJavaInfo {
                version,
                path,
                size,
                is_used,
                used_by_instances: used_by,
            });
        }

        // Сортируем: неиспользуемые первыми, затем по размеру
        result.sort_by(|a, b| match (a.is_used, b.is_used) {
            (false, true) => std::cmp::Ordering::Less,
            (true, false) => std::cmp::Ordering::Greater,
            _ => b.size.cmp(&a.size),
        });

        Ok(result)
    })
    .await
    .map_err(|e| crate::error::LauncherError::Join(e.to_string()))?
}

/// Получает детальную разбивку shared ресурсов
#[tauri::command]
pub async fn get_shared_resources_breakdown() -> Result<SharedResourcesBreakdown> {
    let java_versions = get_installed_java_versions().await?;

    // ИСПРАВЛЕНО: Вся работа с файловой системой в spawn_blocking
    let (
        libraries_count,
        libraries_size,
        assets_indexes_count,
        assets_size,
        versions_count,
        versions_size,
    ) = tokio::task::spawn_blocking(move || {
        let libs_path = libraries_dir();
        let libraries_count = count_files_recursive(&libs_path);
        let libraries_size = calculate_dir_size(&libs_path);

        let assets_path = assets_dir();
        let assets_indexes_path = assets_path.join("indexes");
        let assets_indexes_count = if assets_indexes_path.exists() {
            std::fs::read_dir(&assets_indexes_path)
                .map(|entries| entries.count())
                .unwrap_or(0)
        } else {
            0
        };
        let assets_size = calculate_dir_size(&assets_path);

        let versions_path = versions_dir();
        let versions_count = if versions_path.exists() {
            std::fs::read_dir(&versions_path)
                .map(|entries| {
                    entries
                        .filter_map(|e| e.ok())
                        .filter(|e| e.path().is_dir())
                        .count()
                })
                .unwrap_or(0)
        } else {
            0
        };
        let versions_size = calculate_dir_size(&versions_path);

        (
            libraries_count,
            libraries_size,
            assets_indexes_count,
            assets_size,
            versions_count,
            versions_size,
        )
    })
    .await
    .unwrap_or((0, 0, 0, 0, 0, 0));

    // Считаем размер неиспользуемых ресурсов
    let total_unused_size: u64 = java_versions
        .iter()
        .filter(|j| !j.is_used)
        .map(|j| j.size)
        .sum();

    Ok(SharedResourcesBreakdown {
        java_versions,
        libraries_count,
        libraries_size,
        assets_indexes_count,
        assets_size,
        versions_count,
        versions_size,
        total_unused_size,
    })
}

/// Считает количество файлов в директории рекурсивно
fn count_files_recursive(path: &std::path::Path) -> usize {
    if !path.exists() {
        return 0;
    }

    let mut count = 0;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.filter_map(|e| e.ok()) {
            let entry_path = entry.path();
            if entry_path.is_file() {
                count += 1;
            } else if entry_path.is_dir() {
                count += count_files_recursive(&entry_path);
            }
        }
    }
    count
}

/// Удаляет неиспользуемую версию Java
#[tauri::command]
pub async fn cleanup_java_version(version: String) -> Result<u64> {
    // Проверяем что эта версия не используется
    let java_versions = get_installed_java_versions().await?;
    let java_info = java_versions.iter().find(|j| j.version == version);

    let java_info = match java_info {
        Some(info) => info,
        None => {
            return Err(crate::error::LauncherError::NotFound(format!(
                "Java version {} not found",
                version
            )))
        }
    };

    if java_info.is_used {
        return Err(crate::error::LauncherError::InvalidConfig(format!(
            "Java version {} is used by instances: {}",
            version,
            java_info.used_by_instances.join(", ")
        )));
    }

    let path = java_info.path.clone();
    let size = java_info.size;

    // ИСПРАВЛЕНО: И DB и файлы в spawn_blocking для Send safety
    tokio::task::spawn_blocking(move || {
        use crate::db::get_db_conn;

        // Удаляем из БД
        let conn = get_db_conn()?;
        conn.execute(
            "DELETE FROM java_installations WHERE version = ?1",
            [&version],
        )?;
        drop(conn);

        // Удаляем файлы
        let path_buf = std::path::PathBuf::from(&path);
        if path_buf.exists() {
            std::fs::remove_dir_all(&path_buf)?;
            log::info!(
                "Deleted Java {}: {} ({} bytes)",
                version,
                path_buf.display(),
                size
            );
        }

        Ok(size)
    })
    .await
    .map_err(|e| crate::error::LauncherError::Join(e.to_string()))?
}

/// Удаляет все неиспользуемые версии Java
#[tauri::command]
pub async fn cleanup_all_unused_java() -> Result<u64> {
    let java_versions = get_installed_java_versions().await?;
    let mut total_freed = 0u64;

    for java in java_versions {
        if !java.is_used {
            match cleanup_java_version(java.version.clone()).await {
                Ok(size) => total_freed += size,
                Err(e) => log::warn!("Failed to cleanup Java {}: {}", java.version, e),
            }
        }
    }

    Ok(total_freed)
}
