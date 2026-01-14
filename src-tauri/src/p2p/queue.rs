//! Transfer Queue - Очередь передач с приоритетами
//!
//! Позволяет ставить несколько передач в очередь и управлять их приоритетом.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Приоритет передачи
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransferPriority {
    Low = 0,
    Normal = 1,
    High = 2,
    Urgent = 3,
}

impl Default for TransferPriority {
    fn default() -> Self {
        Self::Normal
    }
}

/// Элемент очереди передач
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueuedTransfer {
    /// Уникальный ID в очереди
    pub id: String,
    /// ID пира для передачи
    pub peer_id: String,
    /// Ник пира (если известен)
    pub peer_nickname: Option<String>,
    /// Название модпака
    pub modpack_name: String,
    /// Приоритет
    pub priority: TransferPriority,
    /// Статус в очереди
    pub status: QueueStatus,
    /// Время добавления в очередь
    pub queued_at: String,
    /// ID активной сессии (если передача началась)
    pub session_id: Option<String>,
    /// Ошибка (если была)
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QueueStatus {
    /// Ожидает в очереди
    Pending,
    /// Передача активна
    Active,
    /// Завершено успешно
    Completed,
    /// Ошибка
    Failed,
    /// Отменено
    Cancelled,
}

/// Менеджер очереди передач
pub struct TransferQueue {
    /// Очередь (отсортирована по приоритету)
    queue: Arc<RwLock<VecDeque<QueuedTransfer>>>,
    /// Максимальное количество одновременных передач
    max_concurrent: Arc<RwLock<usize>>,
    /// Текущее количество активных передач
    active_count: Arc<RwLock<usize>>,
}

impl TransferQueue {
    pub fn new() -> Self {
        Self {
            queue: Arc::new(RwLock::new(VecDeque::new())),
            max_concurrent: Arc::new(RwLock::new(3)), // По умолчанию 3 одновременных
            active_count: Arc::new(RwLock::new(0)),
        }
    }

    /// Установить максимальное количество одновременных передач
    pub async fn set_max_concurrent(&self, max: usize) {
        *self.max_concurrent.write().await = max.max(1);
    }

    /// Получить максимальное количество одновременных передач
    pub async fn get_max_concurrent(&self) -> usize {
        *self.max_concurrent.read().await
    }

    /// Добавить передачу в очередь
    pub async fn enqueue(&self, transfer: QueuedTransfer) -> String {
        let id = transfer.id.clone();
        let mut queue = self.queue.write().await;

        // Вставляем с учётом приоритета
        let insert_pos = queue
            .iter()
            .position(|t| t.priority < transfer.priority && t.status == QueueStatus::Pending)
            .unwrap_or(queue.len());

        queue.insert(insert_pos, transfer);
        id
    }

    /// Создать и добавить передачу в очередь
    pub async fn add(
        &self,
        peer_id: &str,
        peer_nickname: Option<String>,
        modpack_name: &str,
        priority: TransferPriority,
    ) -> String {
        let transfer = QueuedTransfer {
            id: uuid::Uuid::new_v4().to_string(),
            peer_id: peer_id.to_string(),
            peer_nickname,
            modpack_name: modpack_name.to_string(),
            priority,
            status: QueueStatus::Pending,
            queued_at: chrono::Utc::now().to_rfc3339(),
            session_id: None,
            error: None,
        };

        self.enqueue(transfer).await
    }

    /// Получить следующую передачу для выполнения
    pub async fn get_next(&self) -> Option<QueuedTransfer> {
        let active = *self.active_count.read().await;
        let max = *self.max_concurrent.read().await;

        if active >= max {
            return None;
        }

        let mut queue = self.queue.write().await;

        // Ищем первую pending передачу
        for transfer in queue.iter_mut() {
            if transfer.status == QueueStatus::Pending {
                transfer.status = QueueStatus::Active;
                return Some(transfer.clone());
            }
        }

        None
    }

    /// Отметить передачу как начатую
    pub async fn mark_started(&self, queue_id: &str, session_id: &str) {
        let mut queue = self.queue.write().await;
        if let Some(transfer) = queue.iter_mut().find(|t| t.id == queue_id) {
            transfer.status = QueueStatus::Active;
            transfer.session_id = Some(session_id.to_string());
        }
        *self.active_count.write().await += 1;
    }

    /// Отметить передачу как завершённую
    pub async fn mark_completed(&self, queue_id: &str) {
        let mut queue = self.queue.write().await;
        if let Some(transfer) = queue.iter_mut().find(|t| t.id == queue_id) {
            transfer.status = QueueStatus::Completed;
        }
        let mut active = self.active_count.write().await;
        *active = active.saturating_sub(1);
    }

    /// Отметить передачу как неудачную
    pub async fn mark_failed(&self, queue_id: &str, error: &str) {
        let mut queue = self.queue.write().await;
        if let Some(transfer) = queue.iter_mut().find(|t| t.id == queue_id) {
            transfer.status = QueueStatus::Failed;
            transfer.error = Some(error.to_string());
        }
        let mut active = self.active_count.write().await;
        *active = active.saturating_sub(1);
    }

    /// Отменить передачу
    pub async fn cancel(&self, queue_id: &str) -> Result<(), String> {
        let mut queue = self.queue.write().await;
        if let Some(transfer) = queue.iter_mut().find(|t| t.id == queue_id) {
            if transfer.status == QueueStatus::Active {
                let mut active = self.active_count.write().await;
                *active = active.saturating_sub(1);
            }
            transfer.status = QueueStatus::Cancelled;
            Ok(())
        } else {
            Err("Transfer not found in queue".to_string())
        }
    }

    /// Удалить завершённые/отменённые передачи из очереди
    pub async fn cleanup(&self) {
        let mut queue = self.queue.write().await;
        queue.retain(|t| t.status == QueueStatus::Pending || t.status == QueueStatus::Active);
    }

    /// Изменить приоритет передачи
    pub async fn set_priority(
        &self,
        queue_id: &str,
        priority: TransferPriority,
    ) -> Result<(), String> {
        let mut queue = self.queue.write().await;

        // Находим и удаляем передачу
        let pos = queue.iter().position(|t| t.id == queue_id);
        if let Some(pos) = pos {
            let mut transfer = queue.remove(pos).unwrap();

            if transfer.status != QueueStatus::Pending {
                // Возвращаем обратно если не pending
                queue.insert(pos, transfer);
                return Err("Can only change priority of pending transfers".to_string());
            }

            transfer.priority = priority;

            // Вставляем с новым приоритетом
            let insert_pos = queue
                .iter()
                .position(|t| t.priority < priority && t.status == QueueStatus::Pending)
                .unwrap_or(queue.len());

            queue.insert(insert_pos, transfer);
            Ok(())
        } else {
            Err("Transfer not found".to_string())
        }
    }

    /// Переместить передачу вверх в очереди
    pub async fn move_up(&self, queue_id: &str) -> Result<(), String> {
        let mut queue = self.queue.write().await;
        let pos = queue.iter().position(|t| t.id == queue_id);

        if let Some(pos) = pos {
            if pos > 0 {
                queue.swap(pos, pos - 1);
            }
            Ok(())
        } else {
            Err("Transfer not found".to_string())
        }
    }

    /// Переместить передачу вниз в очереди
    pub async fn move_down(&self, queue_id: &str) -> Result<(), String> {
        let mut queue = self.queue.write().await;
        let pos = queue.iter().position(|t| t.id == queue_id);

        if let Some(pos) = pos {
            if pos < queue.len() - 1 {
                queue.swap(pos, pos + 1);
            }
            Ok(())
        } else {
            Err("Transfer not found".to_string())
        }
    }

    /// Получить всю очередь
    pub async fn get_all(&self) -> Vec<QueuedTransfer> {
        self.queue.read().await.iter().cloned().collect()
    }

    /// Получить только pending передачи
    pub async fn get_pending(&self) -> Vec<QueuedTransfer> {
        self.queue
            .read()
            .await
            .iter()
            .filter(|t| t.status == QueueStatus::Pending)
            .cloned()
            .collect()
    }

    /// Получить активные передачи
    pub async fn get_active(&self) -> Vec<QueuedTransfer> {
        self.queue
            .read()
            .await
            .iter()
            .filter(|t| t.status == QueueStatus::Active)
            .cloned()
            .collect()
    }

    /// Получить количество элементов в очереди
    pub async fn len(&self) -> usize {
        self.queue.read().await.len()
    }

    /// Проверить пуста ли очередь
    pub async fn is_empty(&self) -> bool {
        self.queue.read().await.is_empty()
    }

    /// Получить количество активных передач
    pub async fn active_count(&self) -> usize {
        *self.active_count.read().await
    }

    /// Очистить всю очередь
    pub async fn clear(&self) {
        self.queue.write().await.clear();
        *self.active_count.write().await = 0;
    }

    /// Повторить неудачную передачу
    pub async fn retry(&self, queue_id: &str) -> Result<(), String> {
        let mut queue = self.queue.write().await;

        if let Some(transfer) = queue.iter_mut().find(|t| t.id == queue_id) {
            if transfer.status != QueueStatus::Failed {
                return Err("Can only retry failed transfers".to_string());
            }

            transfer.status = QueueStatus::Pending;
            transfer.error = None;
            transfer.session_id = None;
            Ok(())
        } else {
            Err("Transfer not found".to_string())
        }
    }

    /// Повторить все неудачные передачи
    pub async fn retry_all_failed(&self) -> usize {
        let mut queue = self.queue.write().await;
        let mut count = 0;

        for transfer in queue.iter_mut() {
            if transfer.status == QueueStatus::Failed {
                transfer.status = QueueStatus::Pending;
                transfer.error = None;
                transfer.session_id = None;
                count += 1;
            }
        }

        count
    }
}

impl Default for TransferQueue {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_queue_priority() {
        let queue = TransferQueue::new();

        // Добавляем с разными приоритетами
        queue
            .add("peer1", None, "modpack1", TransferPriority::Low)
            .await;
        queue
            .add("peer2", None, "modpack2", TransferPriority::High)
            .await;
        queue
            .add("peer3", None, "modpack3", TransferPriority::Normal)
            .await;

        let all = queue.get_all().await;

        // High должен быть первым
        assert_eq!(all[0].peer_id, "peer2");
        assert_eq!(all[1].peer_id, "peer3");
        assert_eq!(all[2].peer_id, "peer1");
    }

    #[tokio::test]
    async fn test_max_concurrent() {
        let queue = TransferQueue::new();
        queue.set_max_concurrent(2).await;

        queue
            .add("peer1", None, "mp1", TransferPriority::Normal)
            .await;
        queue
            .add("peer2", None, "mp2", TransferPriority::Normal)
            .await;
        queue
            .add("peer3", None, "mp3", TransferPriority::Normal)
            .await;

        // Должны получить только 2
        let t1 = queue.get_next().await;
        assert!(t1.is_some());
        queue.mark_started(&t1.unwrap().id, "session1").await;

        let t2 = queue.get_next().await;
        assert!(t2.is_some());
        queue.mark_started(&t2.unwrap().id, "session2").await;

        // Третий не должен получиться
        let t3 = queue.get_next().await;
        assert!(t3.is_none());

        // После завершения одного - третий должен получиться
        queue.mark_completed(&queue.get_active().await[0].id).await;
        let t3 = queue.get_next().await;
        assert!(t3.is_some());
    }
}
