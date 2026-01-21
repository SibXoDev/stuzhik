//! Launch Tracker — система отслеживания изменений между запусками
//!
//! Возможности:
//! - История снимков (настраиваемое количество, по умолчанию 10)
//! - Сравнение с любым предыдущим снимком
//! - Пометка успешности запуска
//! - Связь с бэкапами для отката
//! - Blake3 для быстрого хэширования

use chrono::{DateTime, Utc};
use futures::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use stuzhik_core::error::{LauncherError, Result};

// ==================== Types ====================

/// Информация о файле в snapshot
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileInfo {
    /// Относительный путь от директории экземпляра
    pub path: String,
    /// Blake3 хэш содержимого
    pub hash: String,
    /// Размер в байтах
    pub size: u64,
    /// Время последнего изменения (unix timestamp)
    pub modified: u64,
}

/// Информация о моде в snapshot
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModInfo {
    /// Имя файла
    pub filename: String,
    /// Blake3 хэш
    pub hash: String,
    /// Размер в байтах
    pub size: u64,
    /// Включён ли мод (не .disabled)
    pub enabled: bool,
}

/// Метаданные снимка (без содержимого)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotMeta {
    /// Уникальный ID снимка (timestamp-based)
    pub id: String,
    /// Время создания snapshot (ISO 8601)
    pub created_at: String,
    /// Был ли запуск успешным (или краш)
    pub was_successful: Option<bool>,
    /// ID связанного бэкапа (если есть)
    pub backup_id: Option<String>,
    /// Количество модов
    pub mods_count: usize,
    /// Количество конфигов
    pub configs_count: usize,
    /// Количество отслеживаемых файлов
    pub files_count: usize,
}

/// Полный snapshot состояния экземпляра
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaunchSnapshot {
    /// Версия формата snapshot
    pub format_version: u32,
    /// ID экземпляра
    pub instance_id: String,
    /// Уникальный ID снимка
    pub id: String,
    /// Время создания snapshot (ISO 8601)
    pub created_at: String,
    /// Был ли запуск успешным
    pub was_successful: Option<bool>,
    /// ID связанного бэкапа (если был создан)
    pub backup_id: Option<String>,
    /// Версия Minecraft
    pub minecraft_version: String,
    /// Загрузчик
    pub loader: String,
    /// Версия загрузчика
    pub loader_version: Option<String>,
    /// Список модов
    pub mods: Vec<ModInfo>,
    /// Конфиги
    pub configs: Vec<FileInfo>,
    /// Другие отслеживаемые файлы
    pub tracked_files: Vec<FileInfo>,
}

impl LaunchSnapshot {
    /// Получить метаданные снимка
    pub fn to_meta(&self) -> SnapshotMeta {
        SnapshotMeta {
            id: self.id.clone(),
            created_at: self.created_at.clone(),
            was_successful: self.was_successful,
            backup_id: self.backup_id.clone(),
            mods_count: self.mods.len(),
            configs_count: self.configs.len(),
            files_count: self.tracked_files.len(),
        }
    }
}

/// Изменения между снимками
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaunchChanges {
    /// Время последнего запуска (с которым сравниваем)
    pub last_launch_at: Option<String>,
    /// ID снимка с которым сравниваем
    pub compared_with_snapshot_id: Option<String>,
    /// Есть ли изменения
    pub has_changes: bool,

    // Моды
    pub mods_added: Vec<String>,
    pub mods_removed: Vec<String>,
    pub mods_updated: Vec<ModUpdateInfo>,
    pub mods_enabled: Vec<String>,
    pub mods_disabled: Vec<String>,

    // Конфиги
    pub configs_added: Vec<String>,
    pub configs_removed: Vec<String>,
    pub configs_modified: Vec<String>,

    // Другие файлы
    pub files_added: Vec<String>,
    pub files_removed: Vec<String>,
    pub files_modified: Vec<String>,

    // Сводка
    pub summary: ChangesSummary,
}

/// Информация об обновлении мода
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModUpdateInfo {
    pub old_filename: String,
    pub new_filename: String,
    pub mod_slug: String,
}

/// Краткая сводка изменений
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangesSummary {
    pub total_mod_changes: usize,
    pub total_config_changes: usize,
    pub total_file_changes: usize,
}

/// История снимков экземпляра
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotHistory {
    /// Список метаданных снимков (от новых к старым)
    pub snapshots: Vec<SnapshotMeta>,
    /// Максимальное количество хранимых снимков
    pub max_snapshots: usize,
}

const SNAPSHOT_FORMAT_VERSION: u32 = 2;
const SNAPSHOTS_DIR: &str = "snapshots";
const HISTORY_FILENAME: &str = "history.json";
const DEFAULT_MAX_SNAPSHOTS: usize = 10;

/// Отслеживаемые файлы помимо модов и конфигов
const TRACKED_FILES: &[&str] = &[
    "options.txt",
    "servers.dat",
    "optionsof.txt",
    "optionsshaders.txt",
    "usercache.json",
    "realms_persistence.json",
];

/// Директории для отслеживания
const TRACKED_DIRS: &[&str] = &[
    "resourcepacks",
    "shaderpacks",
    "saves",
];

// ==================== Blake3 Hashing ====================

/// Вычислить blake3 хэш файла
pub fn calculate_blake3<P: AsRef<Path>>(path: P) -> Result<String> {
    let content = std::fs::read(path.as_ref())?;
    let hash = blake3::hash(&content);
    Ok(hash.to_hex().to_string())
}

/// Вычислить blake3 хэш файла (async)
pub async fn calculate_blake3_async(path: PathBuf) -> Result<String> {
    tokio::task::spawn_blocking(move || calculate_blake3(&path))
        .await
        .map_err(|e| LauncherError::InvalidConfig(format!("Hash task failed: {}", e)))?
}

// ==================== Snapshot Storage ====================

fn get_stuzhik_dir(instance_dir: &Path) -> PathBuf {
    instance_dir.join(".stuzhik")
}

fn get_snapshots_dir(instance_dir: &Path) -> PathBuf {
    get_stuzhik_dir(instance_dir).join(SNAPSHOTS_DIR)
}

fn get_history_path(instance_dir: &Path) -> PathBuf {
    get_stuzhik_dir(instance_dir).join(HISTORY_FILENAME)
}

fn get_snapshot_path(instance_dir: &Path, snapshot_id: &str) -> PathBuf {
    get_snapshots_dir(instance_dir).join(format!("{}.json", snapshot_id))
}

/// Генерировать уникальный ID для снимка
fn generate_snapshot_id() -> String {
    Utc::now().format("%Y%m%d_%H%M%S_%3f").to_string()
}

/// Загрузить историю снимков
pub fn load_history(instance_dir: &Path) -> SnapshotHistory {
    let history_path = get_history_path(instance_dir);

    if history_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&history_path) {
            if let Ok(history) = serde_json::from_str(&content) {
                return history;
            }
        }
    }

    SnapshotHistory {
        snapshots: Vec::new(),
        max_snapshots: DEFAULT_MAX_SNAPSHOTS,
    }
}

/// Сохранить историю снимков
fn save_history(instance_dir: &Path, history: &SnapshotHistory) -> Result<()> {
    let stuzhik_dir = get_stuzhik_dir(instance_dir);
    std::fs::create_dir_all(&stuzhik_dir)?;

    let history_path = get_history_path(instance_dir);
    let json = serde_json::to_string_pretty(history)
        .map_err(|e| LauncherError::InvalidConfig(format!("Failed to serialize history: {}", e)))?;

    std::fs::write(&history_path, json)?;
    Ok(())
}

/// Сохранить снимок
pub fn save_snapshot(instance_dir: &Path, snapshot: &LaunchSnapshot) -> Result<()> {
    let snapshots_dir = get_snapshots_dir(instance_dir);
    std::fs::create_dir_all(&snapshots_dir)?;

    let snapshot_path = get_snapshot_path(instance_dir, &snapshot.id);
    let json = serde_json::to_string_pretty(snapshot)
        .map_err(|e| LauncherError::InvalidConfig(format!("Failed to serialize snapshot: {}", e)))?;

    std::fs::write(&snapshot_path, json)?;

    // Обновляем историю
    let mut history = load_history(instance_dir);

    // Добавляем новый снимок в начало
    history.snapshots.insert(0, snapshot.to_meta());

    // Ротация: удаляем старые снимки если превысили лимит
    while history.snapshots.len() > history.max_snapshots {
        if let Some(old_meta) = history.snapshots.pop() {
            let old_path = get_snapshot_path(instance_dir, &old_meta.id);
            let _ = std::fs::remove_file(old_path);
        }
    }

    save_history(instance_dir, &history)?;

    log::info!(
        "Saved snapshot {} ({} mods, {} configs, {} files)",
        snapshot.id,
        snapshot.mods.len(),
        snapshot.configs.len(),
        snapshot.tracked_files.len()
    );

    Ok(())
}

/// Загрузить снимок по ID
pub fn load_snapshot(instance_dir: &Path, snapshot_id: &str) -> Option<LaunchSnapshot> {
    let snapshot_path = get_snapshot_path(instance_dir, snapshot_id);

    if !snapshot_path.exists() {
        return None;
    }

    match std::fs::read_to_string(&snapshot_path) {
        Ok(content) => serde_json::from_str(&content).ok(),
        Err(_) => None,
    }
}

/// Загрузить последний снимок
pub fn load_latest_snapshot(instance_dir: &Path) -> Option<LaunchSnapshot> {
    let history = load_history(instance_dir);
    history.snapshots.first().and_then(|meta| load_snapshot(instance_dir, &meta.id))
}

/// Удалить все снимки экземпляра
pub fn delete_all_snapshots(instance_dir: &Path) -> Result<()> {
    let stuzhik_dir = get_stuzhik_dir(instance_dir);
    if stuzhik_dir.exists() {
        std::fs::remove_dir_all(&stuzhik_dir)?;
    }
    Ok(())
}

/// Получить список всех снимков (метаданные)
pub fn get_snapshot_list(instance_dir: &Path) -> Vec<SnapshotMeta> {
    load_history(instance_dir).snapshots
}

/// Установить максимальное количество снимков
pub fn set_max_snapshots(instance_dir: &Path, max_count: usize) -> Result<()> {
    let mut history = load_history(instance_dir);
    history.max_snapshots = max_count.max(1); // Минимум 1

    // Применяем ротацию если нужно
    while history.snapshots.len() > history.max_snapshots {
        if let Some(old_meta) = history.snapshots.pop() {
            let old_path = get_snapshot_path(instance_dir, &old_meta.id);
            let _ = std::fs::remove_file(old_path);
        }
    }

    save_history(instance_dir, &history)
}

/// Пометить снимок как успешный/неуспешный
pub fn mark_snapshot_result(instance_dir: &Path, snapshot_id: &str, was_successful: bool) -> Result<()> {
    // Обновляем снимок
    if let Some(mut snapshot) = load_snapshot(instance_dir, snapshot_id) {
        snapshot.was_successful = Some(was_successful);

        let snapshot_path = get_snapshot_path(instance_dir, snapshot_id);
        let json = serde_json::to_string_pretty(&snapshot)
            .map_err(|e| LauncherError::InvalidConfig(format!("Failed to serialize snapshot: {}", e)))?;
        std::fs::write(&snapshot_path, json)?;
    }

    // Обновляем историю
    let mut history = load_history(instance_dir);
    if let Some(meta) = history.snapshots.iter_mut().find(|m| m.id == snapshot_id) {
        meta.was_successful = Some(was_successful);
    }
    save_history(instance_dir, &history)
}

/// Связать снимок с бэкапом
pub fn link_snapshot_to_backup(instance_dir: &Path, snapshot_id: &str, backup_id: &str) -> Result<()> {
    // Обновляем снимок
    if let Some(mut snapshot) = load_snapshot(instance_dir, snapshot_id) {
        snapshot.backup_id = Some(backup_id.to_string());

        let snapshot_path = get_snapshot_path(instance_dir, snapshot_id);
        let json = serde_json::to_string_pretty(&snapshot)
            .map_err(|e| LauncherError::InvalidConfig(format!("Failed to serialize snapshot: {}", e)))?;
        std::fs::write(&snapshot_path, json)?;
    }

    // Обновляем историю
    let mut history = load_history(instance_dir);
    if let Some(meta) = history.snapshots.iter_mut().find(|m| m.id == snapshot_id) {
        meta.backup_id = Some(backup_id.to_string());
    }
    save_history(instance_dir, &history)
}

// ==================== Snapshot Creation ====================

/// Создать snapshot состояния экземпляра
pub async fn create_launch_snapshot(
    instance_id: &str,
    instance_dir: &Path,
    minecraft_version: &str,
    loader: &str,
    loader_version: Option<&str>,
) -> Result<LaunchSnapshot> {
    let mods_dir = instance_dir.join("mods");
    let config_dir = instance_dir.join("config");
    let snapshot_id = generate_snapshot_id();
    let created_at = Utc::now().to_rfc3339();

    log::info!(
        "Creating launch snapshot {} for instance {} at {}",
        snapshot_id,
        instance_id,
        instance_dir.display()
    );

    let mods = collect_mods_info(&mods_dir).await?;
    let configs = collect_configs_info(&config_dir).await?;
    let tracked_files = collect_tracked_files(instance_dir).await?;

    log::debug!(
        "Collected {} mods, {} configs, {} files",
        mods.len(),
        configs.len(),
        tracked_files.len()
    );

    Ok(LaunchSnapshot {
        format_version: SNAPSHOT_FORMAT_VERSION,
        instance_id: instance_id.to_string(),
        id: snapshot_id,
        created_at,
        was_successful: None, // Будет установлено позже
        backup_id: None,
        minecraft_version: minecraft_version.to_string(),
        loader: loader.to_string(),
        loader_version: loader_version.map(String::from),
        mods,
        configs,
        tracked_files,
    })
}

async fn collect_mods_info(mods_dir: &Path) -> Result<Vec<ModInfo>> {
    if !mods_dir.exists() {
        return Ok(Vec::new());
    }

    let mut mod_paths = Vec::new();
    for entry in std::fs::read_dir(mods_dir)? {
        let entry = entry?;
        let path = entry.path();
        if let Some(name) = path.file_name().map(|n| n.to_string_lossy().to_string()) {
            if name.ends_with(".jar") || name.ends_with(".jar.disabled") {
                mod_paths.push(path);
            }
        }
    }

    let mods: Vec<ModInfo> = stream::iter(mod_paths)
        .map(|path| async move { hash_mod_file(path).await })
        .buffer_unordered(8)
        .filter_map(|result| async move { result.ok() })
        .collect()
        .await;

    Ok(mods)
}

async fn hash_mod_file(path: PathBuf) -> Result<ModInfo> {
    tokio::task::spawn_blocking(move || {
        let filename = path
            .file_name()
            .ok_or_else(|| LauncherError::InvalidConfig("Path has no filename".to_string()))?
            .to_string_lossy()
            .to_string();

        let enabled = !filename.ends_with(".disabled");
        let content = std::fs::read(&path)?;
        let size = content.len() as u64;
        let hash = blake3::hash(&content).to_hex().to_string();

        Ok(ModInfo { filename, hash, size, enabled })
    })
    .await
    .map_err(|e| LauncherError::InvalidConfig(format!("Hash task failed: {}", e)))?
}

async fn collect_configs_info(config_dir: &Path) -> Result<Vec<FileInfo>> {
    if !config_dir.exists() {
        return Ok(Vec::new());
    }

    let config_paths = collect_files_recursive(config_dir)?;
    let base_dir = config_dir.to_path_buf();

    let configs: Vec<FileInfo> = stream::iter(config_paths)
        .map(|path| {
            let base = base_dir.clone();
            async move { hash_file_info(path, base, "config").await }
        })
        .buffer_unordered(8)
        .filter_map(|result| async move { result.ok() })
        .collect()
        .await;

    Ok(configs)
}

async fn collect_tracked_files(instance_dir: &Path) -> Result<Vec<FileInfo>> {
    let mut files = Vec::new();

    for filename in TRACKED_FILES {
        let path = instance_dir.join(filename);
        if path.exists() {
            if let Ok(info) = hash_file_info_sync(&path, instance_dir, "") {
                files.push(info);
            }
        }
    }

    for dirname in TRACKED_DIRS {
        let dir = instance_dir.join(dirname);
        if dir.exists() {
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_file() {
                        if let Ok(info) = hash_file_info_sync(&path, instance_dir, "") {
                            files.push(info);
                        }
                    }
                }
            }
        }
    }

    Ok(files)
}

fn collect_files_recursive(dir: &Path) -> Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    if dir.exists() {
        collect_files_recursive_inner(dir, &mut paths)?;
    }
    Ok(paths)
}

fn collect_files_recursive_inner(dir: &Path, paths: &mut Vec<PathBuf>) -> Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_files_recursive_inner(&path, paths)?;
        } else {
            paths.push(path);
        }
    }
    Ok(())
}

async fn hash_file_info(path: PathBuf, base_dir: PathBuf, prefix: &str) -> Result<FileInfo> {
    let prefix = prefix.to_string();
    tokio::task::spawn_blocking(move || hash_file_info_sync(&path, &base_dir, &prefix))
        .await
        .map_err(|e| LauncherError::InvalidConfig(format!("Hash task failed: {}", e)))?
}

fn hash_file_info_sync(path: &Path, base_dir: &Path, prefix: &str) -> Result<FileInfo> {
    let relative_path = path.strip_prefix(base_dir).unwrap_or(path);
    let path_str = if prefix.is_empty() {
        relative_path.to_string_lossy().to_string()
    } else {
        format!("{}/{}", prefix, relative_path.to_string_lossy())
    };

    let metadata = std::fs::metadata(path)?;
    let content = std::fs::read(path)?;
    let hash = blake3::hash(&content).to_hex().to_string();

    let modified = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    Ok(FileInfo {
        path: path_str,
        hash,
        size: metadata.len(),
        modified,
    })
}

// ==================== Change Detection ====================

/// Определить изменения с последнего запуска
pub async fn detect_changes_since_launch(
    instance_dir: &Path,
    minecraft_version: &str,
    loader: &str,
    loader_version: Option<&str>,
) -> Result<LaunchChanges> {
    detect_changes_with_snapshot(instance_dir, None, minecraft_version, loader, loader_version).await
}

/// Определить изменения с конкретным снимком
pub async fn detect_changes_with_snapshot(
    instance_dir: &Path,
    snapshot_id: Option<&str>,
    minecraft_version: &str,
    loader: &str,
    loader_version: Option<&str>,
) -> Result<LaunchChanges> {
    // Загружаем снимок для сравнения
    let previous = match snapshot_id {
        Some(id) => load_snapshot(instance_dir, id),
        None => load_latest_snapshot(instance_dir),
    };

    let instance_id = previous
        .as_ref()
        .map(|s| s.instance_id.clone())
        .unwrap_or_default();

    // Создаём текущий снимок (временный, не сохраняем)
    let current = create_launch_snapshot(
        &instance_id,
        instance_dir,
        minecraft_version,
        loader,
        loader_version,
    )
    .await?;

    let Some(previous) = previous else {
        return Ok(empty_changes());
    };

    compare_snapshots(&previous, &current)
}

fn empty_changes() -> LaunchChanges {
    LaunchChanges {
        last_launch_at: None,
        compared_with_snapshot_id: None,
        has_changes: false,
        mods_added: Vec::new(),
        mods_removed: Vec::new(),
        mods_updated: Vec::new(),
        mods_enabled: Vec::new(),
        mods_disabled: Vec::new(),
        configs_added: Vec::new(),
        configs_removed: Vec::new(),
        configs_modified: Vec::new(),
        files_added: Vec::new(),
        files_removed: Vec::new(),
        files_modified: Vec::new(),
        summary: ChangesSummary {
            total_mod_changes: 0,
            total_config_changes: 0,
            total_file_changes: 0,
        },
    }
}

fn compare_snapshots(previous: &LaunchSnapshot, current: &LaunchSnapshot) -> Result<LaunchChanges> {
    let mut mods_added = Vec::new();
    let mut mods_removed = Vec::new();
    let mut mods_updated = Vec::new();
    let mut mods_enabled = Vec::new();
    let mut mods_disabled = Vec::new();

    let prev_mods: HashMap<String, &ModInfo> =
        previous.mods.iter().map(|m| (m.filename.clone(), m)).collect();
    let curr_mods: HashMap<String, &ModInfo> =
        current.mods.iter().map(|m| (m.filename.clone(), m)).collect();

    let prev_slugs: HashMap<String, &ModInfo> = previous
        .mods
        .iter()
        .map(|m| (extract_mod_slug(&m.filename), m))
        .collect();
    let curr_slugs: HashMap<String, &ModInfo> = current
        .mods
        .iter()
        .map(|m| (extract_mod_slug(&m.filename), m))
        .collect();

    for (filename, curr_mod) in &curr_mods {
        if !prev_mods.contains_key(filename) {
            let slug = extract_mod_slug(filename);
            if let Some(prev_mod) = prev_slugs.get(&slug) {
                if prev_mod.filename != *filename {
                    mods_updated.push(ModUpdateInfo {
                        old_filename: prev_mod.filename.clone(),
                        new_filename: filename.clone(),
                        mod_slug: slug,
                    });
                    continue;
                }
            }
            mods_added.push(filename.clone());
        } else if let Some(prev_mod) = prev_mods.get(filename) {
            if prev_mod.enabled && !curr_mod.enabled {
                mods_disabled.push(filename.clone());
            } else if !prev_mod.enabled && curr_mod.enabled {
                mods_enabled.push(filename.clone());
            }
        }
    }

    let updated_old: HashSet<_> = mods_updated.iter().map(|u| &u.old_filename).collect();
    for filename in prev_mods.keys() {
        if !curr_mods.contains_key(filename) && !updated_old.contains(filename) {
            let slug = extract_mod_slug(filename);
            if !curr_slugs.contains_key(&slug) {
                mods_removed.push(filename.clone());
            }
        }
    }

    let (configs_added, configs_removed, configs_modified) =
        compare_file_lists(&previous.configs, &current.configs);
    let (files_added, files_removed, files_modified) =
        compare_file_lists(&previous.tracked_files, &current.tracked_files);

    let total_mod_changes = mods_added.len()
        + mods_removed.len()
        + mods_updated.len()
        + mods_enabled.len()
        + mods_disabled.len();
    let total_config_changes = configs_added.len() + configs_removed.len() + configs_modified.len();
    let total_file_changes = files_added.len() + files_removed.len() + files_modified.len();

    let has_changes = total_mod_changes > 0 || total_config_changes > 0 || total_file_changes > 0;

    Ok(LaunchChanges {
        last_launch_at: Some(previous.created_at.clone()),
        compared_with_snapshot_id: Some(previous.id.clone()),
        has_changes,
        mods_added,
        mods_removed,
        mods_updated,
        mods_enabled,
        mods_disabled,
        configs_added,
        configs_removed,
        configs_modified,
        files_added,
        files_removed,
        files_modified,
        summary: ChangesSummary {
            total_mod_changes,
            total_config_changes,
            total_file_changes,
        },
    })
}

fn compare_file_lists(
    previous: &[FileInfo],
    current: &[FileInfo],
) -> (Vec<String>, Vec<String>, Vec<String>) {
    let prev_files: HashMap<&str, &str> = previous.iter().map(|f| (f.path.as_str(), f.hash.as_str())).collect();
    let curr_files: HashMap<&str, &str> = current.iter().map(|f| (f.path.as_str(), f.hash.as_str())).collect();

    let mut added = Vec::new();
    let mut removed = Vec::new();
    let mut modified = Vec::new();

    for (path, hash) in &curr_files {
        match prev_files.get(path) {
            None => added.push(path.to_string()),
            Some(prev_hash) if prev_hash != hash => modified.push(path.to_string()),
            _ => {}
        }
    }

    for path in prev_files.keys() {
        if !curr_files.contains_key(path) {
            removed.push(path.to_string());
        }
    }

    (added, removed, modified)
}

fn extract_mod_slug(filename: &str) -> String {
    let name = filename
        .trim_end_matches(".jar")
        .trim_end_matches(".disabled");

    let parts: Vec<&str> = name.split(|c| c == '-' || c == '_').collect();
    if parts.is_empty() {
        return name.to_lowercase();
    }

    let mut slug_parts = Vec::new();
    for part in &parts {
        if part.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false) {
            break;
        }
        let lower = part.to_lowercase();
        if matches!(lower.as_str(), "fabric" | "forge" | "neoforge" | "quilt" | "mc" | "mod") {
            continue;
        }
        slug_parts.push(*part);
    }

    if slug_parts.is_empty() {
        parts[0].to_lowercase()
    } else {
        slug_parts.join("-").to_lowercase()
    }
}

// ==================== Integration ====================

/// Создать и сохранить снимок после запуска
pub async fn on_successful_launch(
    instance_id: &str,
    instance_dir: &Path,
    minecraft_version: &str,
    loader: &str,
    loader_version: Option<&str>,
) -> Result<String> {
    let snapshot = create_launch_snapshot(
        instance_id,
        instance_dir,
        minecraft_version,
        loader,
        loader_version,
    )
    .await?;

    let snapshot_id = snapshot.id.clone();
    save_snapshot(instance_dir, &snapshot)?;

    Ok(snapshot_id)
}

// ==================== Legacy Compatibility ====================

// Для обратной совместимости с существующим кодом
pub fn load_launch_snapshot(instance_dir: &Path) -> Option<LaunchSnapshot> {
    // Сначала пробуем новый формат
    if let Some(snapshot) = load_latest_snapshot(instance_dir) {
        return Some(snapshot);
    }

    // Пробуем старый формат
    let old_path = instance_dir.join(".stuzhik").join("last_launch_snapshot.json");
    if old_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&old_path) {
            if let Ok(snapshot) = serde_json::from_str::<LaunchSnapshot>(&content) {
                // Мигрируем на новый формат
                let mut migrated = snapshot.clone();
                if migrated.id.is_empty() {
                    migrated.id = generate_snapshot_id();
                }
                let _ = save_snapshot(instance_dir, &migrated);
                let _ = std::fs::remove_file(&old_path);
                return Some(migrated);
            }
        }
    }

    None
}

pub fn save_launch_snapshot(instance_dir: &Path, snapshot: &LaunchSnapshot) -> Result<()> {
    save_snapshot(instance_dir, snapshot)
}

pub fn delete_launch_snapshot(instance_dir: &Path) -> Result<()> {
    delete_all_snapshots(instance_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_mod_slug() {
        assert_eq!(extract_mod_slug("sodium-fabric-0.5.3.jar"), "sodium");
        assert_eq!(extract_mod_slug("jei-1.20.1-forge-15.3.0.4.jar"), "jei");
        assert_eq!(extract_mod_slug("create-1.20.1-0.5.1f.jar"), "create");
    }

    #[test]
    fn test_snapshot_id_generation() {
        let id1 = generate_snapshot_id();
        std::thread::sleep(std::time::Duration::from_millis(10));
        let id2 = generate_snapshot_id();
        assert_ne!(id1, id2);
    }
}
