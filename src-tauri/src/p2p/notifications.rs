//! Auto-Update Notifications - Уведомления о новых версиях модпаков у пиров
//!
//! Отслеживает версии модпаков у других пиров и уведомляет когда есть обновления.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};

/// Информация о версии модпака у пира
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerModpackVersion {
    /// ID пира
    pub peer_id: String,
    /// Ник пира
    pub peer_nickname: Option<String>,
    /// Название модпака
    pub modpack_name: String,
    /// Версия (хеш манифеста или версия из конфига)
    pub version: String,
    /// Количество файлов
    pub files_count: u32,
    /// Общий размер
    pub total_size: u64,
    /// Время последнего обновления информации
    pub updated_at: String,
}

/// Уведомление об обновлении
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateNotification {
    /// Уникальный ID уведомления
    pub id: String,
    /// ID пира с новой версией
    pub peer_id: String,
    /// Ник пира
    pub peer_nickname: Option<String>,
    /// Название модпака
    pub modpack_name: String,
    /// Локальная версия
    pub local_version: String,
    /// Версия у пира
    pub peer_version: String,
    /// Разница в файлах (примерно)
    pub files_diff: i32,
    /// Разница в размере (байт)
    pub size_diff: i64,
    /// Время создания уведомления
    pub created_at: String,
    /// Прочитано ли
    pub read: bool,
    /// Отклонено ли (пользователь не хочет это обновление)
    pub dismissed: bool,
}

/// Событие для UI
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NotificationEvent {
    /// Новое уведомление об обновлении
    NewUpdate { notification: UpdateNotification },
    /// Версия модпака у пира изменилась
    PeerVersionChanged {
        peer_id: String,
        modpack_name: String,
        old_version: Option<String>,
        new_version: String,
    },
}

/// Менеджер уведомлений об обновлениях
pub struct UpdateNotificationManager {
    /// Версии модпаков у пиров: peer_id -> modpack_name -> version_info
    peer_versions: Arc<RwLock<HashMap<String, HashMap<String, PeerModpackVersion>>>>,
    /// Локальные версии модпаков: modpack_name -> version
    local_versions: Arc<RwLock<HashMap<String, String>>>,
    /// Активные уведомления
    notifications: Arc<RwLock<Vec<UpdateNotification>>>,
    /// Канал для отправки событий
    event_tx: Option<mpsc::Sender<NotificationEvent>>,
    /// Отслеживаемые модпаки (для каких модпаков получать уведомления)
    tracked_modpacks: Arc<RwLock<std::collections::HashSet<String>>>,
    /// Включены ли уведомления
    enabled: Arc<RwLock<bool>>,
}

impl UpdateNotificationManager {
    pub fn new() -> Self {
        Self {
            peer_versions: Arc::new(RwLock::new(HashMap::new())),
            local_versions: Arc::new(RwLock::new(HashMap::new())),
            notifications: Arc::new(RwLock::new(Vec::new())),
            event_tx: None,
            tracked_modpacks: Arc::new(RwLock::new(std::collections::HashSet::new())),
            enabled: Arc::new(RwLock::new(true)),
        }
    }

    /// Установить канал для событий
    pub fn with_event_channel(mut self, tx: mpsc::Sender<NotificationEvent>) -> Self {
        self.event_tx = Some(tx);
        self
    }

    /// Включить/выключить уведомления
    pub async fn set_enabled(&self, enabled: bool) {
        *self.enabled.write().await = enabled;
    }

    /// Проверить включены ли уведомления
    pub async fn is_enabled(&self) -> bool {
        *self.enabled.read().await
    }

    /// Добавить модпак в отслеживаемые
    pub async fn track_modpack(&self, modpack_name: &str) {
        self.tracked_modpacks
            .write()
            .await
            .insert(modpack_name.to_string());
    }

    /// Удалить модпак из отслеживаемых
    pub async fn untrack_modpack(&self, modpack_name: &str) {
        self.tracked_modpacks.write().await.remove(modpack_name);
    }

    /// Получить список отслеживаемых модпаков
    pub async fn get_tracked_modpacks(&self) -> Vec<String> {
        self.tracked_modpacks.read().await.iter().cloned().collect()
    }

    /// Проверить отслеживается ли модпак
    pub async fn is_tracked(&self, modpack_name: &str) -> bool {
        let tracked = self.tracked_modpacks.read().await;
        // Если список пуст - отслеживаем всё
        tracked.is_empty() || tracked.contains(modpack_name)
    }

    /// Обновить локальную версию модпака
    pub async fn set_local_version(&self, modpack_name: &str, version: &str) {
        self.local_versions
            .write()
            .await
            .insert(modpack_name.to_string(), version.to_string());

        // Проверяем, есть ли теперь обновления от пиров
        self.check_updates_for_modpack(modpack_name).await;
    }

    /// Получить локальную версию модпака
    pub async fn get_local_version(&self, modpack_name: &str) -> Option<String> {
        self.local_versions.read().await.get(modpack_name).cloned()
    }

    /// Обновить версию модпака у пира
    pub async fn update_peer_version(&self, version_info: PeerModpackVersion) {
        if !*self.enabled.read().await {
            return;
        }

        let peer_id = version_info.peer_id.clone();
        let modpack_name = version_info.modpack_name.clone();
        let new_version = version_info.version.clone();

        // Получаем старую версию
        let old_version = {
            let guard = self.peer_versions.read().await;
            guard
                .get(&peer_id)
                .and_then(|m| m.get(&modpack_name))
                .map(|v| v.version.clone())
        };

        // Обновляем
        {
            let mut guard = self.peer_versions.write().await;
            let peer_modpacks = guard.entry(peer_id.clone()).or_insert_with(HashMap::new);
            peer_modpacks.insert(modpack_name.clone(), version_info);
        }

        // Отправляем событие если версия изменилась
        if old_version.as_ref() != Some(&new_version) {
            if let Some(ref tx) = self.event_tx {
                let _ = tx
                    .send(NotificationEvent::PeerVersionChanged {
                        peer_id: peer_id.clone(),
                        modpack_name: modpack_name.clone(),
                        old_version,
                        new_version: new_version.clone(),
                    })
                    .await;
            }

            // Проверяем нужно ли создать уведомление
            self.check_and_notify(&peer_id, &modpack_name, &new_version)
                .await;
        }
    }

    /// Проверить и создать уведомление если нужно
    async fn check_and_notify(&self, peer_id: &str, modpack_name: &str, peer_version: &str) {
        // Проверяем отслеживается ли модпак
        if !self.is_tracked(modpack_name).await {
            return;
        }

        // Получаем локальную версию
        let local_version = match self.get_local_version(modpack_name).await {
            Some(v) => v,
            None => return, // Нет локальной версии - нет сравнения
        };

        // Если версии разные - создаём уведомление
        if local_version != peer_version {
            // Проверяем нет ли уже такого уведомления
            let exists = self.notifications.read().await.iter().any(|n| {
                n.peer_id == peer_id
                    && n.modpack_name == modpack_name
                    && n.peer_version == peer_version
                    && !n.dismissed
            });

            if exists {
                return;
            }

            // Получаем инфо о пире
            let peer_info = self
                .peer_versions
                .read()
                .await
                .get(peer_id)
                .and_then(|m| m.get(modpack_name))
                .cloned();

            let (peer_nickname, files_diff, size_diff) = if let Some(info) = peer_info {
                // Примерная разница (без точных данных о локальном модпаке)
                (info.peer_nickname, 0, 0)
            } else {
                (None, 0, 0)
            };

            let notification = UpdateNotification {
                id: uuid::Uuid::new_v4().to_string(),
                peer_id: peer_id.to_string(),
                peer_nickname,
                modpack_name: modpack_name.to_string(),
                local_version,
                peer_version: peer_version.to_string(),
                files_diff,
                size_diff,
                created_at: chrono::Utc::now().to_rfc3339(),
                read: false,
                dismissed: false,
            };

            self.notifications.write().await.push(notification.clone());

            // Отправляем событие
            if let Some(ref tx) = self.event_tx {
                let _ = tx.send(NotificationEvent::NewUpdate { notification }).await;
            }
        }
    }

    /// Проверить обновления для конкретного модпака
    async fn check_updates_for_modpack(&self, modpack_name: &str) {
        let local_version = match self.get_local_version(modpack_name).await {
            Some(v) => v,
            None => return,
        };

        let peer_versions = self.peer_versions.read().await;

        for (peer_id, modpacks) in peer_versions.iter() {
            if let Some(info) = modpacks.get(modpack_name) {
                if info.version != local_version {
                    self.check_and_notify(peer_id, modpack_name, &info.version)
                        .await;
                }
            }
        }
    }

    /// Получить все уведомления
    pub async fn get_notifications(&self) -> Vec<UpdateNotification> {
        self.notifications.read().await.clone()
    }

    /// Получить непрочитанные уведомления
    pub async fn get_unread_notifications(&self) -> Vec<UpdateNotification> {
        self.notifications
            .read()
            .await
            .iter()
            .filter(|n| !n.read && !n.dismissed)
            .cloned()
            .collect()
    }

    /// Получить количество непрочитанных уведомлений
    pub async fn get_unread_count(&self) -> usize {
        self.notifications
            .read()
            .await
            .iter()
            .filter(|n| !n.read && !n.dismissed)
            .count()
    }

    /// Отметить уведомление как прочитанное
    pub async fn mark_read(&self, notification_id: &str) {
        let mut guard = self.notifications.write().await;
        if let Some(n) = guard.iter_mut().find(|n| n.id == notification_id) {
            n.read = true;
        }
    }

    /// Отметить все уведомления как прочитанные
    pub async fn mark_all_read(&self) {
        let mut guard = self.notifications.write().await;
        for n in guard.iter_mut() {
            n.read = true;
        }
    }

    /// Отклонить уведомление (не хочу это обновление)
    pub async fn dismiss(&self, notification_id: &str) {
        let mut guard = self.notifications.write().await;
        if let Some(n) = guard.iter_mut().find(|n| n.id == notification_id) {
            n.dismissed = true;
        }
    }

    /// Удалить уведомление
    pub async fn delete_notification(&self, notification_id: &str) {
        let mut guard = self.notifications.write().await;
        guard.retain(|n| n.id != notification_id);
    }

    /// Очистить все уведомления
    pub async fn clear_all(&self) {
        self.notifications.write().await.clear();
    }

    /// Очистить старые уведомления (старше N дней)
    pub async fn cleanup_old(&self, days: u64) {
        let cutoff = chrono::Utc::now() - chrono::Duration::days(days as i64);
        let cutoff_str = cutoff.to_rfc3339();

        let mut guard = self.notifications.write().await;
        guard.retain(|n| n.created_at > cutoff_str);
    }

    /// Получить версии всех модпаков у конкретного пира
    pub async fn get_peer_modpacks(&self, peer_id: &str) -> Vec<PeerModpackVersion> {
        self.peer_versions
            .read()
            .await
            .get(peer_id)
            .map(|m| m.values().cloned().collect())
            .unwrap_or_default()
    }

    /// Получить всех пиров, у которых есть конкретный модпак
    pub async fn get_peers_with_modpack(&self, modpack_name: &str) -> Vec<PeerModpackVersion> {
        self.peer_versions
            .read()
            .await
            .values()
            .filter_map(|m| m.get(modpack_name).cloned())
            .collect()
    }

    /// Удалить информацию о пире (когда пир отключился)
    pub async fn remove_peer(&self, peer_id: &str) {
        self.peer_versions.write().await.remove(peer_id);
    }

    /// Получить уведомления для конкретного модпака
    pub async fn get_notifications_for_modpack(
        &self,
        modpack_name: &str,
    ) -> Vec<UpdateNotification> {
        self.notifications
            .read()
            .await
            .iter()
            .filter(|n| n.modpack_name == modpack_name && !n.dismissed)
            .cloned()
            .collect()
    }
}

impl Default for UpdateNotificationManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_notification_creation() {
        let manager = UpdateNotificationManager::new();

        // Устанавливаем локальную версию
        manager.set_local_version("test-modpack", "v1.0").await;

        // Обновляем версию у пира
        manager
            .update_peer_version(PeerModpackVersion {
                peer_id: "peer1".to_string(),
                peer_nickname: Some("Test Peer".to_string()),
                modpack_name: "test-modpack".to_string(),
                version: "v1.1".to_string(),
                files_count: 100,
                total_size: 1000000,
                updated_at: chrono::Utc::now().to_rfc3339(),
            })
            .await;

        // Должно быть уведомление
        let notifications = manager.get_unread_notifications().await;
        assert_eq!(notifications.len(), 1);
        assert_eq!(notifications[0].modpack_name, "test-modpack");
        assert_eq!(notifications[0].local_version, "v1.0");
        assert_eq!(notifications[0].peer_version, "v1.1");
    }

    #[tokio::test]
    async fn test_same_version_no_notification() {
        let manager = UpdateNotificationManager::new();

        manager.set_local_version("test-modpack", "v1.0").await;

        manager
            .update_peer_version(PeerModpackVersion {
                peer_id: "peer1".to_string(),
                peer_nickname: None,
                modpack_name: "test-modpack".to_string(),
                version: "v1.0".to_string(), // Та же версия
                files_count: 100,
                total_size: 1000000,
                updated_at: chrono::Utc::now().to_rfc3339(),
            })
            .await;

        // Не должно быть уведомлений
        let notifications = manager.get_unread_notifications().await;
        assert!(notifications.is_empty());
    }

    #[tokio::test]
    async fn test_tracked_modpacks() {
        let manager = UpdateNotificationManager::new();

        // Отслеживаем только один модпак
        manager.track_modpack("tracked-modpack").await;

        manager.set_local_version("tracked-modpack", "v1.0").await;
        manager.set_local_version("untracked-modpack", "v1.0").await;

        // Обновление для отслеживаемого
        manager
            .update_peer_version(PeerModpackVersion {
                peer_id: "peer1".to_string(),
                peer_nickname: None,
                modpack_name: "tracked-modpack".to_string(),
                version: "v1.1".to_string(),
                files_count: 100,
                total_size: 1000000,
                updated_at: chrono::Utc::now().to_rfc3339(),
            })
            .await;

        // Обновление для неотслеживаемого
        manager
            .update_peer_version(PeerModpackVersion {
                peer_id: "peer1".to_string(),
                peer_nickname: None,
                modpack_name: "untracked-modpack".to_string(),
                version: "v1.1".to_string(),
                files_count: 100,
                total_size: 1000000,
                updated_at: chrono::Utc::now().to_rfc3339(),
            })
            .await;

        // Должно быть только одно уведомление
        let notifications = manager.get_unread_notifications().await;
        assert_eq!(notifications.len(), 1);
        assert_eq!(notifications[0].modpack_name, "tracked-modpack");
    }
}
