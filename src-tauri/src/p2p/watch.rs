//! Watch Mode - Авто-синхронизация при изменениях файлов
//!
//! Отслеживает изменения в папках модпаков и автоматически
//! синхронизирует с выбранными пирами.

use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, RwLock};

/// Настройки watch mode для модпака
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WatchConfig {
    /// Название модпака
    pub modpack_name: String,
    /// Путь к папке модпака
    pub modpack_path: PathBuf,
    /// ID пиров для авто-синхронизации
    pub target_peers: Vec<String>,
    /// Включено ли отслеживание
    pub enabled: bool,
    /// Задержка перед синхронизацией (debounce) в мс
    pub debounce_ms: u64,
    /// Паттерны для игнорирования
    pub ignore_patterns: Vec<String>,
    /// Синхронизировать только определённые папки
    pub watch_folders: Vec<String>,
}

impl Default for WatchConfig {
    fn default() -> Self {
        Self {
            modpack_name: String::new(),
            modpack_path: PathBuf::new(),
            target_peers: Vec::new(),
            enabled: false,
            debounce_ms: 2000, // 2 секунды задержки
            ignore_patterns: vec![
                "*.log".to_string(),
                "*.tmp".to_string(),
                "crash-reports/*".to_string(),
                "logs/*".to_string(),
                ".cache/*".to_string(),
            ],
            watch_folders: vec![
                "mods".to_string(),
                "config".to_string(),
                "resourcepacks".to_string(),
                "shaderpacks".to_string(),
            ],
        }
    }
}

/// Событие изменения файла
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileChangeEvent {
    pub modpack_name: String,
    pub relative_path: String,
    pub change_type: ChangeType,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeType {
    Created,
    Modified,
    Deleted,
    Renamed,
}

/// Событие для отправки в UI
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WatchEvent {
    /// Обнаружены изменения
    ChangesDetected {
        modpack_name: String,
        changes_count: usize,
    },
    /// Синхронизация запущена
    SyncStarted {
        modpack_name: String,
        peer_ids: Vec<String>,
    },
    /// Синхронизация завершена
    SyncCompleted {
        modpack_name: String,
        success: bool,
        error: Option<String>,
    },
    /// Watch mode включён
    WatchStarted { modpack_name: String },
    /// Watch mode выключен
    WatchStopped { modpack_name: String },
}

/// Менеджер watch mode
pub struct WatchManager {
    /// Конфигурации для модпаков
    configs: Arc<RwLock<HashMap<String, WatchConfig>>>,
    /// Активные watchers
    watchers: Arc<RwLock<HashMap<String, WatcherHandle>>>,
    /// Канал для событий
    event_tx: mpsc::Sender<WatchEvent>,
    /// Канал для запуска синхронизации
    sync_tx: mpsc::Sender<SyncRequest>,
    /// Накопленные изменения (для debounce)
    pending_changes: Arc<RwLock<HashMap<String, PendingSync>>>,
}

struct WatcherHandle {
    #[allow(dead_code)]
    watcher: RecommendedWatcher,
    stop_tx: mpsc::Sender<()>,
}

struct PendingSync {
    changes: Vec<FileChangeEvent>,
    last_change: Instant,
    debounce_ms: u64,
}

/// Запрос на синхронизацию
#[derive(Debug, Clone)]
pub struct SyncRequest {
    pub modpack_name: String,
    pub changes: Vec<FileChangeEvent>,
    pub target_peers: Vec<String>,
}

impl WatchManager {
    /// Создать новый менеджер
    pub fn new(event_tx: mpsc::Sender<WatchEvent>) -> (Self, mpsc::Receiver<SyncRequest>) {
        let (sync_tx, sync_rx) = mpsc::channel(32);

        let manager = Self {
            configs: Arc::new(RwLock::new(HashMap::new())),
            watchers: Arc::new(RwLock::new(HashMap::new())),
            event_tx,
            sync_tx,
            pending_changes: Arc::new(RwLock::new(HashMap::new())),
        };

        (manager, sync_rx)
    }

    /// Добавить конфигурацию для модпака
    pub async fn add_config(&self, config: WatchConfig) {
        let name = config.modpack_name.clone();
        self.configs.write().await.insert(name, config);
    }

    /// Удалить конфигурацию
    pub async fn remove_config(&self, modpack_name: &str) {
        self.stop_watching(modpack_name).await;
        self.configs.write().await.remove(modpack_name);
    }

    /// Получить конфигурацию
    pub async fn get_config(&self, modpack_name: &str) -> Option<WatchConfig> {
        self.configs.read().await.get(modpack_name).cloned()
    }

    /// Получить все конфигурации
    pub async fn get_all_configs(&self) -> Vec<WatchConfig> {
        self.configs.read().await.values().cloned().collect()
    }

    /// Начать отслеживание модпака
    pub async fn start_watching(&self, modpack_name: &str) -> Result<(), String> {
        let config = self
            .configs
            .read()
            .await
            .get(modpack_name)
            .cloned()
            .ok_or_else(|| format!("Config not found for {}", modpack_name))?;

        if !config.enabled {
            return Err("Watch mode disabled in config".to_string());
        }

        if self.watchers.read().await.contains_key(modpack_name) {
            return Ok(()); // Уже запущен
        }

        let modpack_path = config.modpack_path.clone();
        let modpack_name_clone = modpack_name.to_string();
        let pending_changes = self.pending_changes.clone();
        let sync_tx = self.sync_tx.clone();
        let event_tx = self.event_tx.clone();
        let ignore_patterns = config.ignore_patterns.clone();
        let watch_folders = config.watch_folders.clone();
        let debounce_ms = config.debounce_ms;
        let target_peers = config.target_peers.clone();

        let (stop_tx, mut stop_rx) = mpsc::channel::<()>(1);
        let (notify_tx, mut notify_rx) = std::sync::mpsc::channel();

        // Создаём watcher
        let watcher_config = Config::default().with_poll_interval(Duration::from_secs(1));

        let mut watcher = RecommendedWatcher::new(notify_tx, watcher_config)
            .map_err(|e| format!("Failed to create watcher: {}", e))?;

        // Добавляем папки для отслеживания
        for folder in &watch_folders {
            let path = modpack_path.join(folder);
            if tokio::fs::try_exists(&path).await.unwrap_or(false) {
                watcher
                    .watch(&path, RecursiveMode::Recursive)
                    .map_err(|e| format!("Failed to watch {}: {}", folder, e))?;
            }
        }

        // Запускаем обработку событий
        let modpack_name_for_task = modpack_name.to_string();
        tokio::spawn(async move {
            let mut debounce_timer: Option<tokio::time::Instant> = None;

            loop {
                tokio::select! {
                    _ = stop_rx.recv() => {
                        log::info!("Watch stopped for {}", modpack_name_for_task);
                        break;
                    }
                    // Проверяем события от notify
                    _ = tokio::time::sleep(Duration::from_millis(100)) => {
                        // Обрабатываем накопившиеся события
                        while let Ok(event) = notify_rx.try_recv() {
                            if let Ok(event) = event {
                                if let Some(change) = Self::process_notify_event(
                                    &event,
                                    &modpack_path,
                                    &modpack_name_clone,
                                    &ignore_patterns,
                                ) {
                                    let mut pending = pending_changes.write().await;
                                    let entry = pending.entry(modpack_name_clone.clone()).or_insert_with(|| {
                                        PendingSync {
                                            changes: Vec::new(),
                                            last_change: Instant::now(),
                                            debounce_ms,
                                        }
                                    });
                                    entry.changes.push(change);
                                    entry.last_change = Instant::now();
                                    debounce_timer = Some(tokio::time::Instant::now() + Duration::from_millis(debounce_ms));
                                }
                            }
                        }

                        // Проверяем debounce таймер
                        if let Some(timer) = debounce_timer {
                            if tokio::time::Instant::now() >= timer {
                                let mut pending = pending_changes.write().await;
                                if let Some(sync) = pending.remove(&modpack_name_clone) {
                                    if !sync.changes.is_empty() {
                                        // Отправляем событие в UI
                                        let _ = event_tx.send(WatchEvent::ChangesDetected {
                                            modpack_name: modpack_name_clone.clone(),
                                            changes_count: sync.changes.len(),
                                        }).await;

                                        // Отправляем запрос на синхронизацию
                                        let _ = sync_tx.send(SyncRequest {
                                            modpack_name: modpack_name_clone.clone(),
                                            changes: sync.changes,
                                            target_peers: target_peers.clone(),
                                        }).await;
                                    }
                                }
                                debounce_timer = None;
                            }
                        }
                    }
                }
            }
        });

        self.watchers
            .write()
            .await
            .insert(modpack_name.to_string(), WatcherHandle { watcher, stop_tx });

        self.event_tx
            .send(WatchEvent::WatchStarted {
                modpack_name: modpack_name.to_string(),
            })
            .await
            .ok();

        log::info!("Started watching {}", modpack_name);
        Ok(())
    }

    /// Остановить отслеживание модпака
    pub async fn stop_watching(&self, modpack_name: &str) {
        if let Some(handle) = self.watchers.write().await.remove(modpack_name) {
            let _ = handle.stop_tx.send(()).await;

            self.event_tx
                .send(WatchEvent::WatchStopped {
                    modpack_name: modpack_name.to_string(),
                })
                .await
                .ok();

            log::info!("Stopped watching {}", modpack_name);
        }

        // Очищаем pending changes
        self.pending_changes.write().await.remove(modpack_name);
    }

    /// Проверить, активен ли watch mode
    pub async fn is_watching(&self, modpack_name: &str) -> bool {
        self.watchers.read().await.contains_key(modpack_name)
    }

    /// Получить список активных watch
    pub async fn get_active_watches(&self) -> Vec<String> {
        self.watchers.read().await.keys().cloned().collect()
    }

    /// Остановить все watchers
    pub async fn stop_all(&self) {
        let names: Vec<String> = self.watchers.read().await.keys().cloned().collect();
        for name in names {
            self.stop_watching(&name).await;
        }
    }

    /// Обработать событие от notify
    fn process_notify_event(
        event: &Event,
        base_path: &PathBuf,
        modpack_name: &str,
        ignore_patterns: &[String],
    ) -> Option<FileChangeEvent> {
        use notify::EventKind;

        let path = event.paths.first()?;

        // Получаем относительный путь
        let relative_path = path.strip_prefix(base_path).ok()?;
        let relative_str = relative_path.to_string_lossy().to_string();

        // Проверяем игнорируемые паттерны
        if Self::should_ignore(&relative_str, ignore_patterns) {
            return None;
        }

        let change_type = match event.kind {
            EventKind::Create(_) => ChangeType::Created,
            EventKind::Modify(_) => ChangeType::Modified,
            EventKind::Remove(_) => ChangeType::Deleted,
            EventKind::Other => return None,
            _ => return None,
        };

        Some(FileChangeEvent {
            modpack_name: modpack_name.to_string(),
            relative_path: relative_str,
            change_type,
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
        })
    }

    /// Проверить, нужно ли игнорировать файл
    fn should_ignore(path: &str, patterns: &[String]) -> bool {
        for pattern in patterns {
            if Self::matches_glob(path, pattern) {
                return true;
            }
        }
        false
    }

    /// Простое сопоставление с glob паттерном
    fn matches_glob(path: &str, pattern: &str) -> bool {
        let path = path.replace('\\', "/");
        let pattern = pattern.replace('\\', "/");

        if pattern.ends_with("/*") {
            // Папка с содержимым
            let prefix = &pattern[..pattern.len() - 2];
            path.starts_with(prefix)
        } else if pattern.starts_with("*.") {
            // Расширение файла
            let ext = &pattern[1..];
            path.ends_with(ext)
        } else {
            path == pattern
        }
    }
}

/// Selective Sync - выбор конкретных файлов для синхронизации
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SelectiveSyncConfig {
    /// Название модпака
    pub modpack_name: String,
    /// Включённые файлы/папки (если пусто - всё включено)
    pub included_paths: HashSet<String>,
    /// Исключённые файлы/папки
    pub excluded_paths: HashSet<String>,
    /// Включить только моды
    pub mods_only: bool,
    /// Включить конфиги
    pub include_configs: bool,
    /// Включить ресурспаки
    pub include_resourcepacks: bool,
    /// Включить шейдеры
    pub include_shaders: bool,
}

impl Default for SelectiveSyncConfig {
    fn default() -> Self {
        Self {
            modpack_name: String::new(),
            included_paths: HashSet::new(),
            excluded_paths: HashSet::new(),
            mods_only: false,
            include_configs: true,
            include_resourcepacks: true,
            include_shaders: true,
        }
    }
}

impl SelectiveSyncConfig {
    /// Проверить, должен ли файл синхронизироваться
    pub fn should_sync(&self, relative_path: &str) -> bool {
        let path = relative_path.replace('\\', "/");

        // Проверяем исключения
        if self.excluded_paths.iter().any(|p| path.starts_with(p)) {
            return false;
        }

        // Если указаны конкретные пути - проверяем их
        if !self.included_paths.is_empty() {
            return self.included_paths.iter().any(|p| path.starts_with(p));
        }

        // Проверяем категории
        if self.mods_only {
            return path.starts_with("mods/");
        }

        if path.starts_with("config/") && !self.include_configs {
            return false;
        }

        if path.starts_with("resourcepacks/") && !self.include_resourcepacks {
            return false;
        }

        if path.starts_with("shaderpacks/") && !self.include_shaders {
            return false;
        }

        true
    }

    /// Добавить путь в включения
    pub fn include(&mut self, path: &str) {
        self.included_paths.insert(path.to_string());
        self.excluded_paths.remove(path);
    }

    /// Добавить путь в исключения
    pub fn exclude(&mut self, path: &str) {
        self.excluded_paths.insert(path.to_string());
        self.included_paths.remove(path);
    }

    /// Очистить все фильтры
    pub fn clear_filters(&mut self) {
        self.included_paths.clear();
        self.excluded_paths.clear();
    }
}

/// Менеджер selective sync
pub struct SelectiveSyncManager {
    configs: Arc<RwLock<HashMap<String, SelectiveSyncConfig>>>,
}

impl SelectiveSyncManager {
    pub fn new() -> Self {
        Self {
            configs: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Установить конфигурацию для модпака
    pub async fn set_config(&self, config: SelectiveSyncConfig) {
        let name = config.modpack_name.clone();
        self.configs.write().await.insert(name, config);
    }

    /// Получить конфигурацию
    pub async fn get_config(&self, modpack_name: &str) -> Option<SelectiveSyncConfig> {
        self.configs.read().await.get(modpack_name).cloned()
    }

    /// Удалить конфигурацию
    pub async fn remove_config(&self, modpack_name: &str) {
        self.configs.write().await.remove(modpack_name);
    }

    /// Отфильтровать список файлов по конфигурации
    pub async fn filter_files(&self, modpack_name: &str, files: Vec<String>) -> Vec<String> {
        let config = self.configs.read().await.get(modpack_name).cloned();

        match config {
            Some(cfg) => files.into_iter().filter(|f| cfg.should_sync(f)).collect(),
            None => files, // Без конфига - всё синхронизируется
        }
    }
}

impl Default for SelectiveSyncManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_selective_sync_should_sync() {
        let mut config = SelectiveSyncConfig::default();
        config.modpack_name = "test".to_string();

        // По умолчанию всё синхронизируется
        assert!(config.should_sync("mods/test.jar"));
        assert!(config.should_sync("config/test.toml"));
        assert!(config.should_sync("resourcepacks/pack.zip"));

        // mods_only
        config.mods_only = true;
        assert!(config.should_sync("mods/test.jar"));
        assert!(!config.should_sync("config/test.toml"));

        config.mods_only = false;

        // Исключения
        config.exclude("config/");
        assert!(!config.should_sync("config/test.toml"));
        assert!(config.should_sync("mods/test.jar"));

        // Включения
        config.clear_filters();
        config.include("mods/create");
        assert!(config.should_sync("mods/create/test.jar"));
        assert!(!config.should_sync("mods/other.jar"));
    }

    #[test]
    fn test_glob_matching() {
        assert!(WatchManager::matches_glob("logs/latest.log", "logs/*"));
        assert!(WatchManager::matches_glob("test.log", "*.log"));
        assert!(!WatchManager::matches_glob("test.jar", "*.log"));
        assert!(WatchManager::matches_glob(
            "crash-reports/crash.txt",
            "crash-reports/*"
        ));
    }
}
