//! Stuzhik Connect - P2P модуль для обмена модпаками между пользователями
//!
//! Архитектура:
//! - discovery.rs: UDP broadcast для поиска других пользователей в локальной сети
//! - protocol.rs: Протокол обмена сообщениями (MessagePack)
//! - settings.rs: Настройки приватности
//! - friends.rs: Система доверенных друзей
//! - transfer.rs: Delta-sync для передачи модпаков
//! - server.rs: TCP сервер для передачи файлов
//! - consent.rs: Система согласий на действия
//! - security.rs: Защита от атак (path traversal, DoS, etc.)
//! - crypto.rs: E2E шифрование (X25519 + AES-256-GCM)
//! - history.rs: Лог истории передач
//! - watch.rs: Watch mode для авто-синхронизации
//! - queue.rs: Очередь передач с приоритетами
//! - groups.rs: Группировка пиров
//! - notifications.rs: Уведомления об обновлениях
//!
//! По умолчанию ВСЁ ВЫКЛЮЧЕНО для безопасности.

pub mod consent;
pub mod crypto;
pub mod discovery;
pub mod friends;
pub mod groups;
pub mod history;
pub mod network;
pub mod notifications;
pub mod protocol;
pub mod queue;
pub mod security;
pub mod server;
pub mod server_sync;
pub mod settings;
pub mod transfer;
pub mod watch;

use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};

pub use consent::{
    get_consent_manager, ConsentManager, ConsentRequest, ConsentResponse, ConsentType,
};
pub use discovery::Discovery;
pub use groups::{PeerGroup, PeerGroupManager};
pub use history::{
    HistoryStats, TransferDirection, TransferHistory, TransferHistoryEntry, TransferResult,
};
pub use network::{FirewallResult, NetworkDiagnostics, NetworkRecommendation};
pub use notifications::{
    NotificationEvent, PeerModpackVersion, UpdateNotification, UpdateNotificationManager,
};
pub use protocol::*;
pub use queue::{QueueStatus, QueuedTransfer, TransferPriority, TransferQueue};
pub use server::{BroadcastResult, TransferEvent, TransferServer, TransferSession};
pub use server_sync::{
    get_server_sync_manager, PublishedServer, QuickJoinRequest, QuickJoinResult, QuickJoinStatus,
    ServerInvite, ServerSyncConfig, ServerSyncManager, ServerVisibility, SyncSource,
};
pub use settings::*;
pub use watch::{
    ChangeType, FileChangeEvent, SelectiveSyncConfig, SelectiveSyncManager, SyncRequest,
    WatchConfig, WatchEvent, WatchManager,
};

/// Глобальное состояние P2P сервиса
pub struct ConnectService {
    settings: Arc<RwLock<ConnectSettings>>,
    discovery: Arc<RwLock<Option<Discovery>>>,
    peers: Arc<RwLock<Vec<PeerInfo>>>,
    transfer_server: Arc<RwLock<Option<TransferServer>>>,
    event_tx: Option<mpsc::Sender<TransferEvent>>,
    instances_path: PathBuf,
    /// История передач
    transfer_history: Arc<TransferHistory>,
    /// Менеджер watch mode
    watch_manager: Arc<RwLock<Option<WatchManager>>>,
    /// Менеджер selective sync
    selective_sync: Arc<SelectiveSyncManager>,
    /// Канал для запросов синхронизации от watch mode
    watch_sync_rx: Arc<RwLock<Option<mpsc::Receiver<SyncRequest>>>>,
    /// Очередь передач
    transfer_queue: Arc<TransferQueue>,
    /// Группы пиров
    peer_groups: Arc<PeerGroupManager>,
    /// Уведомления об обновлениях
    update_notifications: Arc<UpdateNotificationManager>,
}

impl ConnectService {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            settings: Arc::new(RwLock::new(ConnectSettings::default())),
            discovery: Arc::new(RwLock::new(None)),
            peers: Arc::new(RwLock::new(Vec::new())),
            transfer_server: Arc::new(RwLock::new(None)),
            event_tx: None,
            instances_path: PathBuf::new(),
            transfer_history: Arc::new(TransferHistory::new(data_dir.clone())),
            watch_manager: Arc::new(RwLock::new(None)),
            selective_sync: Arc::new(SelectiveSyncManager::new()),
            watch_sync_rx: Arc::new(RwLock::new(None)),
            transfer_queue: Arc::new(TransferQueue::new()),
            peer_groups: Arc::new(PeerGroupManager::new(data_dir)),
            update_notifications: Arc::new(UpdateNotificationManager::new()),
        }
    }

    /// Инициализировать с путём к экземплярам
    pub fn with_instances_path(mut self, path: PathBuf) -> Self {
        self.instances_path = path;
        self
    }

    /// Установить канал событий
    pub fn with_event_channel(mut self, tx: mpsc::Sender<TransferEvent>) -> Self {
        self.event_tx = Some(tx);
        self
    }

    /// Включить P2P сервис
    pub async fn enable(&self) -> Result<(), String> {
        let settings = self.settings.read().await;
        if !settings.enabled {
            return Err("P2P отключён в настройках".to_string());
        }

        // Запускаем discovery
        let mut discovery_guard = self.discovery.write().await;
        if discovery_guard.is_none() {
            let discovery = Discovery::new(settings.clone());
            *discovery_guard = Some(discovery);
        }

        if let Some(ref mut discovery) = *discovery_guard {
            discovery.start().await?;
        }

        // Запускаем transfer server
        if let Some(ref event_tx) = self.event_tx {
            let tcp_port = settings.discovery_port + server::TCP_PORT_OFFSET;
            let peer_id = discovery_guard
                .as_ref()
                .map(|d| d.get_peer_id().to_string())
                .unwrap_or_default();

            let mut server = TransferServer::new(
                peer_id,
                tcp_port,
                self.instances_path.clone(),
                event_tx.clone(),
            );

            server.start().await?;

            // Получаем фактический порт (может отличаться если основной был занят)
            let actual_port = server.get_actual_port().await;

            // Обновляем порт в discovery для корректного broadcast
            if let Some(ref discovery) = *discovery_guard {
                discovery.set_tcp_port(actual_port).await;
            }

            *self.transfer_server.write().await = Some(server);

            log::info!("Transfer server started on port {}", actual_port);
        }

        Ok(())
    }

    /// Выключить P2P сервис
    pub async fn disable(&self) {
        // Останавливаем transfer server
        if let Some(ref server) = *self.transfer_server.read().await {
            server.stop().await;
        }
        *self.transfer_server.write().await = None;

        // Останавливаем discovery
        let mut discovery_guard = self.discovery.write().await;
        if let Some(ref discovery) = *discovery_guard {
            discovery.stop().await;
        }
        *discovery_guard = None;

        // Очищаем список пиров
        self.peers.write().await.clear();
    }

    /// Получить активные сессии передачи
    pub async fn get_transfer_sessions(&self) -> Vec<TransferSession> {
        if let Some(ref server) = *self.transfer_server.read().await {
            server.get_sessions().await
        } else {
            vec![]
        }
    }

    /// Получить список найденных пиров
    pub async fn get_peers(&self) -> Vec<PeerInfo> {
        self.peers.read().await.clone()
    }

    /// Обновить настройки
    pub async fn update_settings(&self, new_settings: ConnectSettings) {
        let was_enabled = {
            let old = self.settings.read().await;
            old.enabled
        };

        *self.settings.write().await = new_settings.clone();

        // Если был включён, а теперь выключен - останавливаем
        if was_enabled && !new_settings.enabled {
            self.disable().await;
        }
    }

    /// Получить текущие настройки
    pub async fn get_settings(&self) -> ConnectSettings {
        self.settings.read().await.clone()
    }

    /// Запросить синхронизацию модпака у пира
    pub async fn request_modpack_sync(
        &self,
        peer_id: &str,
        modpack_name: &str,
    ) -> Result<(), String> {
        let discovery_guard = self.discovery.read().await;
        if let Some(ref discovery) = *discovery_guard {
            // Находим пира
            let peers = self.peers.read().await;
            let peer = peers
                .iter()
                .find(|p| p.id == peer_id)
                .ok_or_else(|| "Peer not found".to_string())?;

            // Отправляем запрос на синхронизацию
            discovery
                .request_modpack(peer, modpack_name)
                .await
                .map_err(|e| e.to_string())?;

            log::info!("Requested modpack sync: {} from {}", modpack_name, peer_id);
            Ok(())
        } else {
            Err("P2P not enabled".to_string())
        }
    }

    /// Получить короткий код для подключения
    pub async fn get_short_code(&self) -> Option<String> {
        let discovery_guard = self.discovery.read().await;
        if let Some(ref discovery) = *discovery_guard {
            Some(discovery.get_short_code().to_string())
        } else {
            None
        }
    }

    /// Получить свой peer ID
    pub async fn get_peer_id(&self) -> Option<String> {
        let discovery_guard = self.discovery.read().await;
        if let Some(ref discovery) = *discovery_guard {
            Some(discovery.get_peer_id().to_string())
        } else {
            None
        }
    }

    /// Подключиться к пиру по короткому коду
    /// Возвращает информацию о подключённом пире
    pub async fn connect_by_code(&self, code: &str) -> Result<PeerInfo, String> {
        let code = protocol::normalize_short_code(code);
        if !protocol::validate_short_code(&code) {
            return Err("Invalid code format".to_string());
        }

        let discovery_guard = self.discovery.read().await;
        if let Some(ref discovery) = *discovery_guard {
            let peer_info = discovery.connect_by_code(&code).await?;

            // Добавляем пира в список если ещё нет
            let mut peers = self.peers.write().await;
            if !peers.iter().any(|p| p.id == peer_info.id) {
                peers.push(peer_info.clone());
            }

            Ok(peer_info)
        } else {
            Err("P2P not enabled".to_string())
        }
    }

    /// Отменить передачу файлов
    pub async fn cancel_transfer(&self, session_id: &str) -> Result<(), String> {
        if let Some(ref server) = *self.transfer_server.read().await {
            server.cancel_session(session_id).await
        } else {
            Err("P2P not enabled".to_string())
        }
    }

    /// Отправить запрос в друзья
    pub async fn send_friend_request(
        &self,
        peer_id: &str,
        nickname: &str,
        public_key: &str,
    ) -> Result<(), String> {
        // Находим адрес пира
        let peers = self.peers.read().await;
        let peer = peers
            .iter()
            .find(|p| p.id == peer_id)
            .ok_or_else(|| "Peer not found".to_string())?;

        let peer_addr = std::net::SocketAddr::new(
            peer.address.parse().map_err(|_| "Invalid peer address")?,
            peer.port + server::TCP_PORT_OFFSET,
        );

        if let Some(ref server) = *self.transfer_server.read().await {
            server
                .send_friend_request(peer_addr, nickname, public_key)
                .await
        } else {
            Err("P2P not enabled".to_string())
        }
    }

    /// Групповая передача модпака нескольким пирам одновременно
    pub async fn broadcast_modpack(
        &self,
        peer_ids: Vec<String>,
        modpack_name: &str,
        manifest: &transfer::ModpackManifest,
    ) -> Vec<BroadcastResult> {
        let peers_guard = self.peers.read().await;

        // Собираем адреса пиров
        let mut peer_addrs: Vec<(std::net::SocketAddr, String)> = Vec::new();
        let mut not_found: Vec<BroadcastResult> = Vec::new();

        for peer_id in &peer_ids {
            if let Some(peer) = peers_guard.iter().find(|p| &p.id == peer_id) {
                if let Ok(ip) = peer.address.parse() {
                    let addr = std::net::SocketAddr::new(ip, peer.port + server::TCP_PORT_OFFSET);
                    peer_addrs.push((addr, peer_id.clone()));
                } else {
                    not_found.push(BroadcastResult {
                        peer_id: peer_id.clone(),
                        session_id: None,
                        error: Some("Invalid peer address".to_string()),
                    });
                }
            } else {
                not_found.push(BroadcastResult {
                    peer_id: peer_id.clone(),
                    session_id: None,
                    error: Some("Peer not found".to_string()),
                });
            }
        }

        drop(peers_guard);

        // Отправляем всем найденным пирам
        let server_guard = self.transfer_server.read().await;
        let mut results = not_found;

        if let Some(ref server) = *server_guard {
            let sync_results = server
                .broadcast_sync(peer_addrs.clone(), modpack_name, manifest)
                .await;

            for ((_, peer_id), result) in peer_addrs.into_iter().zip(sync_results) {
                results.push(BroadcastResult {
                    peer_id,
                    session_id: result.as_ref().ok().cloned(),
                    error: result.err(),
                });
            }
        } else {
            for (_, peer_id) in peer_addrs {
                results.push(BroadcastResult {
                    peer_id,
                    session_id: None,
                    error: Some("P2P not enabled".to_string()),
                });
            }
        }

        results
    }

    // ==================== Transfer History ====================

    /// Загрузить историю передач из файла
    pub async fn load_history(&self) -> Result<(), String> {
        self.transfer_history.load().await
    }

    /// Получить историю передач
    pub async fn get_transfer_history(&self) -> Vec<TransferHistoryEntry> {
        self.transfer_history.get_entries().await
    }

    /// Получить последние N записей истории
    pub async fn get_recent_history(&self, limit: usize) -> Vec<TransferHistoryEntry> {
        self.transfer_history.get_recent(limit).await
    }

    /// Получить историю для пира
    pub async fn get_history_by_peer(&self, peer_id: &str) -> Vec<TransferHistoryEntry> {
        self.transfer_history.get_by_peer(peer_id).await
    }

    /// Получить историю для модпака
    pub async fn get_history_by_modpack(&self, modpack_name: &str) -> Vec<TransferHistoryEntry> {
        self.transfer_history.get_by_modpack(modpack_name).await
    }

    /// Получить статистику истории
    pub async fn get_history_stats(&self) -> HistoryStats {
        self.transfer_history.get_stats().await
    }

    /// Очистить историю
    pub async fn clear_history(&self) -> Result<(), String> {
        self.transfer_history.clear().await
    }

    /// Добавить запись в историю (для внутреннего использования)
    pub async fn add_history_entry(&self, entry: TransferHistoryEntry) {
        self.transfer_history.add_entry(entry).await;
    }

    /// Получить ссылку на историю (для передачи в сервер)
    pub fn get_history_ref(&self) -> Arc<TransferHistory> {
        self.transfer_history.clone()
    }

    // ==================== Watch Mode ====================

    /// Инициализировать watch manager
    pub async fn init_watch_manager(&self, event_tx: mpsc::Sender<WatchEvent>) {
        let (manager, sync_rx) = WatchManager::new(event_tx);
        *self.watch_manager.write().await = Some(manager);
        *self.watch_sync_rx.write().await = Some(sync_rx);
    }

    /// Добавить конфигурацию watch mode для модпака
    pub async fn add_watch_config(&self, config: WatchConfig) -> Result<(), String> {
        let guard = self.watch_manager.read().await;
        if let Some(ref manager) = *guard {
            manager.add_config(config).await;
            Ok(())
        } else {
            Err("Watch manager not initialized".to_string())
        }
    }

    /// Получить конфигурацию watch mode
    pub async fn get_watch_config(&self, modpack_name: &str) -> Option<WatchConfig> {
        let guard = self.watch_manager.read().await;
        if let Some(ref manager) = *guard {
            manager.get_config(modpack_name).await
        } else {
            None
        }
    }

    /// Получить все конфигурации watch mode
    pub async fn get_all_watch_configs(&self) -> Vec<WatchConfig> {
        let guard = self.watch_manager.read().await;
        if let Some(ref manager) = *guard {
            manager.get_all_configs().await
        } else {
            vec![]
        }
    }

    /// Начать отслеживание модпака
    pub async fn start_watching(&self, modpack_name: &str) -> Result<(), String> {
        let guard = self.watch_manager.read().await;
        if let Some(ref manager) = *guard {
            manager.start_watching(modpack_name).await
        } else {
            Err("Watch manager not initialized".to_string())
        }
    }

    /// Остановить отслеживание модпака
    pub async fn stop_watching(&self, modpack_name: &str) -> Result<(), String> {
        let guard = self.watch_manager.read().await;
        if let Some(ref manager) = *guard {
            manager.stop_watching(modpack_name).await;
            Ok(())
        } else {
            Err("Watch manager not initialized".to_string())
        }
    }

    /// Проверить активен ли watch mode
    pub async fn is_watching(&self, modpack_name: &str) -> bool {
        let guard = self.watch_manager.read().await;
        if let Some(ref manager) = *guard {
            manager.is_watching(modpack_name).await
        } else {
            false
        }
    }

    /// Получить список активных watchers
    pub async fn get_active_watches(&self) -> Vec<String> {
        let guard = self.watch_manager.read().await;
        if let Some(ref manager) = *guard {
            manager.get_active_watches().await
        } else {
            vec![]
        }
    }

    /// Остановить все watchers
    pub async fn stop_all_watches(&self) {
        let guard = self.watch_manager.read().await;
        if let Some(ref manager) = *guard {
            manager.stop_all().await;
        }
    }

    // ==================== Selective Sync ====================

    /// Установить конфигурацию selective sync для модпака
    pub async fn set_selective_sync(&self, config: SelectiveSyncConfig) {
        self.selective_sync.set_config(config).await;
    }

    /// Получить конфигурацию selective sync
    pub async fn get_selective_sync(&self, modpack_name: &str) -> Option<SelectiveSyncConfig> {
        self.selective_sync.get_config(modpack_name).await
    }

    /// Удалить конфигурацию selective sync
    pub async fn remove_selective_sync(&self, modpack_name: &str) {
        self.selective_sync.remove_config(modpack_name).await;
    }

    /// Отфильтровать файлы по selective sync конфигурации
    pub async fn filter_files_for_sync(
        &self,
        modpack_name: &str,
        files: Vec<String>,
    ) -> Vec<String> {
        self.selective_sync.filter_files(modpack_name, files).await
    }

    /// Получить ссылку на selective sync manager
    pub fn get_selective_sync_ref(&self) -> Arc<SelectiveSyncManager> {
        self.selective_sync.clone()
    }

    // ==================== Transfer Queue ====================

    /// Добавить передачу в очередь
    pub async fn queue_transfer(
        &self,
        peer_id: &str,
        peer_nickname: Option<String>,
        modpack_name: &str,
        priority: TransferPriority,
    ) -> String {
        self.transfer_queue
            .add(peer_id, peer_nickname, modpack_name, priority)
            .await
    }

    /// Получить следующую передачу из очереди
    pub async fn get_next_queued_transfer(&self) -> Option<QueuedTransfer> {
        self.transfer_queue.get_next().await
    }

    /// Получить всю очередь передач
    pub async fn get_transfer_queue(&self) -> Vec<QueuedTransfer> {
        self.transfer_queue.get_all().await
    }

    /// Отменить передачу в очереди
    pub async fn cancel_queued_transfer(&self, queue_id: &str) -> Result<(), String> {
        self.transfer_queue.cancel(queue_id).await
    }

    /// Изменить приоритет передачи
    pub async fn set_transfer_priority(
        &self,
        queue_id: &str,
        priority: TransferPriority,
    ) -> Result<(), String> {
        self.transfer_queue.set_priority(queue_id, priority).await
    }

    /// Установить максимальное количество одновременных передач
    pub async fn set_max_concurrent_transfers(&self, max: usize) {
        self.transfer_queue.set_max_concurrent(max).await;
    }

    /// Получить количество активных передач в очереди
    pub async fn get_active_transfer_count(&self) -> usize {
        self.transfer_queue.active_count().await
    }

    /// Повторить неудачную передачу
    pub async fn retry_queued_transfer(&self, queue_id: &str) -> Result<(), String> {
        self.transfer_queue.retry(queue_id).await
    }

    /// Очистить очередь передач
    pub async fn clear_transfer_queue(&self) {
        self.transfer_queue.clear().await;
    }

    // ==================== Peer Groups ====================

    /// Загрузить группы пиров
    pub async fn load_peer_groups(&self) -> Result<(), String> {
        self.peer_groups.load().await
    }

    /// Создать новую группу пиров
    pub async fn create_peer_group(&self, name: &str) -> PeerGroup {
        self.peer_groups.create_group(name).await
    }

    /// Удалить группу пиров
    pub async fn delete_peer_group(&self, group_id: &str) -> Result<(), String> {
        self.peer_groups.delete_group(group_id).await
    }

    /// Получить группу по ID
    pub async fn get_peer_group(&self, group_id: &str) -> Option<PeerGroup> {
        self.peer_groups.get_group(group_id).await
    }

    /// Получить все группы пиров
    pub async fn get_all_peer_groups(&self) -> Vec<PeerGroup> {
        self.peer_groups.get_all_groups().await
    }

    /// Добавить пира в группу
    pub async fn add_peer_to_group(&self, group_id: &str, peer_id: &str) -> Result<(), String> {
        self.peer_groups.add_peer_to_group(group_id, peer_id).await
    }

    /// Удалить пира из группы
    pub async fn remove_peer_from_group(
        &self,
        group_id: &str,
        peer_id: &str,
    ) -> Result<(), String> {
        self.peer_groups
            .remove_peer_from_group(group_id, peer_id)
            .await
    }

    /// Получить группы для пира
    pub async fn get_groups_for_peer(&self, peer_id: &str) -> Vec<PeerGroup> {
        self.peer_groups.get_groups_for_peer(peer_id).await
    }

    /// Переименовать группу
    pub async fn rename_peer_group(&self, group_id: &str, new_name: &str) -> Result<(), String> {
        self.peer_groups.rename_group(group_id, new_name).await
    }

    // ==================== Update Notifications ====================

    /// Включить/выключить уведомления об обновлениях
    pub async fn set_update_notifications_enabled(&self, enabled: bool) {
        self.update_notifications.set_enabled(enabled).await;
    }

    /// Установить локальную версию модпака (для сравнения)
    pub async fn set_local_modpack_version(&self, modpack_name: &str, version: &str) {
        self.update_notifications
            .set_local_version(modpack_name, version)
            .await;
    }

    /// Обновить версию модпака у пира
    pub async fn update_peer_modpack_version(&self, version_info: PeerModpackVersion) {
        self.update_notifications
            .update_peer_version(version_info)
            .await;
    }

    /// Получить уведомления об обновлениях
    pub async fn get_update_notifications(&self) -> Vec<UpdateNotification> {
        self.update_notifications.get_notifications().await
    }

    /// Получить непрочитанные уведомления
    pub async fn get_unread_update_notifications(&self) -> Vec<UpdateNotification> {
        self.update_notifications.get_unread_notifications().await
    }

    /// Получить количество непрочитанных уведомлений
    pub async fn get_unread_notification_count(&self) -> usize {
        self.update_notifications.get_unread_count().await
    }

    /// Отметить уведомление как прочитанное
    pub async fn mark_notification_read(&self, notification_id: &str) {
        self.update_notifications.mark_read(notification_id).await;
    }

    /// Отметить все уведомления как прочитанные
    pub async fn mark_all_notifications_read(&self) {
        self.update_notifications.mark_all_read().await;
    }

    /// Отклонить уведомление
    pub async fn dismiss_notification(&self, notification_id: &str) {
        self.update_notifications.dismiss(notification_id).await;
    }

    /// Очистить все уведомления
    pub async fn clear_update_notifications(&self) {
        self.update_notifications.clear_all().await;
    }

    /// Отслеживать модпак для уведомлений
    pub async fn track_modpack_updates(&self, modpack_name: &str) {
        self.update_notifications.track_modpack(modpack_name).await;
    }

    /// Перестать отслеживать модпак
    pub async fn untrack_modpack_updates(&self, modpack_name: &str) {
        self.update_notifications
            .untrack_modpack(modpack_name)
            .await;
    }

    /// Получить пиров с конкретным модпаком
    pub async fn get_peers_with_modpack(&self, modpack_name: &str) -> Vec<PeerModpackVersion> {
        self.update_notifications
            .get_peers_with_modpack(modpack_name)
            .await
    }
}

impl Default for ConnectService {
    fn default() -> Self {
        Self::new(PathBuf::from("."))
    }
}
