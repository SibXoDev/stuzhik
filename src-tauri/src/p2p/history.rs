//! История передач P2P
//!
//! Хранит лог всех передач для отображения в UI.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Максимальное количество записей в истории
const MAX_HISTORY_ENTRIES: usize = 1000;

/// Запись в истории передач
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferHistoryEntry {
    /// Уникальный ID записи
    pub id: String,
    /// ID сессии передачи
    pub session_id: String,
    /// ID пира
    pub peer_id: String,
    /// Ник пира (если известен)
    pub peer_nickname: Option<String>,
    /// Название модпака
    pub modpack_name: String,
    /// Направление (upload/download)
    pub direction: TransferDirection,
    /// Результат
    pub result: TransferResult,
    /// Количество файлов
    pub files_count: u32,
    /// Общий размер (байт)
    pub total_bytes: u64,
    /// Время начала
    pub started_at: DateTime<Utc>,
    /// Время завершения
    pub completed_at: DateTime<Utc>,
    /// Длительность (секунды)
    pub duration_seconds: u64,
    /// Средняя скорость (байт/сек)
    pub avg_speed_bps: u64,
    /// Ошибка (если была)
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransferDirection {
    Upload,
    Download,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransferResult {
    Success,
    Failed,
    Cancelled,
    PartialSuccess,
}

/// Менеджер истории передач
pub struct TransferHistory {
    /// Записи истории (новые в начале)
    entries: Arc<RwLock<VecDeque<TransferHistoryEntry>>>,
    /// Путь к файлу истории
    history_file: PathBuf,
}

impl TransferHistory {
    /// Создать новый менеджер истории
    pub fn new(data_dir: PathBuf) -> Self {
        let history_file = data_dir.join("p2p_history.json");
        Self {
            entries: Arc::new(RwLock::new(VecDeque::new())),
            history_file,
        }
    }

    /// Загрузить историю из файла
    pub async fn load(&self) -> Result<(), String> {
        if !self.history_file.exists() {
            return Ok(());
        }

        let data = tokio::fs::read_to_string(&self.history_file)
            .await
            .map_err(|e| format!("Failed to read history file: {}", e))?;

        let entries: Vec<TransferHistoryEntry> =
            serde_json::from_str(&data).map_err(|e| format!("Failed to parse history: {}", e))?;

        let mut guard = self.entries.write().await;
        *guard = VecDeque::from(entries);

        log::info!("Loaded {} history entries", guard.len());
        Ok(())
    }

    /// Сохранить историю в файл
    pub async fn save(&self) -> Result<(), String> {
        let guard = self.entries.read().await;
        let entries: Vec<_> = guard.iter().collect();

        let data = serde_json::to_string_pretty(&entries)
            .map_err(|e| format!("Failed to serialize history: {}", e))?;

        // Создаём директорию если не существует
        if let Some(parent) = self.history_file.parent() {
            tokio::fs::create_dir_all(parent).await.ok();
        }

        tokio::fs::write(&self.history_file, data)
            .await
            .map_err(|e| format!("Failed to write history file: {}", e))?;

        Ok(())
    }

    /// Добавить запись в историю
    pub async fn add_entry(&self, entry: TransferHistoryEntry) {
        let mut guard = self.entries.write().await;

        // Добавляем в начало
        guard.push_front(entry);

        // Ограничиваем размер
        while guard.len() > MAX_HISTORY_ENTRIES {
            guard.pop_back();
        }

        drop(guard);

        // Сохраняем асинхронно (не блокируем)
        let self_clone = Self {
            entries: self.entries.clone(),
            history_file: self.history_file.clone(),
        };
        tokio::spawn(async move {
            if let Err(e) = self_clone.save().await {
                log::error!("Failed to save history: {}", e);
            }
        });
    }

    /// Создать запись для завершённой передачи
    pub fn create_entry(
        session_id: &str,
        peer_id: &str,
        peer_nickname: Option<String>,
        modpack_name: &str,
        direction: TransferDirection,
        result: TransferResult,
        files_count: u32,
        total_bytes: u64,
        started_at: DateTime<Utc>,
        error: Option<String>,
    ) -> TransferHistoryEntry {
        let completed_at = Utc::now();
        let duration_seconds = (completed_at - started_at).num_seconds().max(1) as u64;
        let avg_speed_bps = total_bytes / duration_seconds;

        TransferHistoryEntry {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: session_id.to_string(),
            peer_id: peer_id.to_string(),
            peer_nickname,
            modpack_name: modpack_name.to_string(),
            direction,
            result,
            files_count,
            total_bytes,
            started_at,
            completed_at,
            duration_seconds,
            avg_speed_bps,
            error,
        }
    }

    /// Получить все записи истории
    pub async fn get_entries(&self) -> Vec<TransferHistoryEntry> {
        self.entries.read().await.iter().cloned().collect()
    }

    /// Получить последние N записей
    pub async fn get_recent(&self, limit: usize) -> Vec<TransferHistoryEntry> {
        self.entries
            .read()
            .await
            .iter()
            .take(limit)
            .cloned()
            .collect()
    }

    /// Получить записи для конкретного пира
    pub async fn get_by_peer(&self, peer_id: &str) -> Vec<TransferHistoryEntry> {
        self.entries
            .read()
            .await
            .iter()
            .filter(|e| e.peer_id == peer_id)
            .cloned()
            .collect()
    }

    /// Получить записи для конкретного модпака
    pub async fn get_by_modpack(&self, modpack_name: &str) -> Vec<TransferHistoryEntry> {
        self.entries
            .read()
            .await
            .iter()
            .filter(|e| e.modpack_name == modpack_name)
            .cloned()
            .collect()
    }

    /// Очистить историю
    pub async fn clear(&self) -> Result<(), String> {
        self.entries.write().await.clear();
        self.save().await
    }

    /// Получить статистику
    pub async fn get_stats(&self) -> HistoryStats {
        let guard = self.entries.read().await;

        let total_transfers = guard.len();
        let successful = guard
            .iter()
            .filter(|e| e.result == TransferResult::Success)
            .count();
        let failed = guard
            .iter()
            .filter(|e| e.result == TransferResult::Failed)
            .count();
        let total_bytes_sent: u64 = guard
            .iter()
            .filter(|e| e.direction == TransferDirection::Upload)
            .map(|e| e.total_bytes)
            .sum();
        let total_bytes_received: u64 = guard
            .iter()
            .filter(|e| e.direction == TransferDirection::Download)
            .map(|e| e.total_bytes)
            .sum();

        HistoryStats {
            total_transfers,
            successful,
            failed,
            total_bytes_sent,
            total_bytes_received,
        }
    }
}

/// Статистика истории
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryStats {
    pub total_transfers: usize,
    pub successful: usize,
    pub failed: usize,
    pub total_bytes_sent: u64,
    pub total_bytes_received: u64,
}
