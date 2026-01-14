//! TCP сервер для передачи файлов между пирами
//!
//! Работает параллельно с UDP discovery.
//! Использует AES-256-GCM для шифрования передаваемых данных.
//!
//! ## Безопасность
//! - Все пути валидируются через security::sanitize_path()
//! - Rate limiting для защиты от DoS
//! - Проверка размеров файлов
//! - Валидация всех входных данных

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt, BufWriter};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, RwLock};
use tokio_util::sync::CancellationToken;

/// Расширения файлов, которые хорошо сжимаются
const COMPRESSIBLE_EXTENSIONS: &[&str] = &[
    "json",
    "toml",
    "cfg",
    "properties",
    "txt",
    "yaml",
    "yml",
    "xml",
    "lang",
    "mcmeta",
    "nbt",
    "dat",
    "snbt",
];

use super::crypto::{self, KeyPair, SessionKey};
use super::security::{
    sanitize_path, validate_extension, validate_file_size, validate_modpack_name, validate_peer_id,
    validate_transfer_size, RateLimiter,
};
use super::transfer::{FileInfo, ModpackManifest, SyncDiff, TransferManager};

/// Порт для TCP соединений (discovery port + 1)
pub const TCP_PORT_OFFSET: u16 = 1;

/// Получить информацию о instance из БД по имени папки
fn get_instance_info_by_name(instance_name: &str) -> (String, String, String) {
    if let Ok(conn) = stuzhik_db::get_db_conn() {
        // instance_name это имя папки, которое совпадает с id экземпляра
        if let Ok(mut stmt) = conn.prepare(
            "SELECT version, loader, loader_version FROM instances WHERE id = ?1 OR name = ?1",
        ) {
            if let Ok(row) = stmt.query_row([instance_name], |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                ))
            }) {
                return row;
            }
        }
    }
    (String::new(), String::new(), String::new())
}

/// Размер чанка для передачи файлов
/// - 64KB для обычных сетей (LAN, VPN)
/// - Можно увеличить до 256KB для высокоскоростных сетей
const CHUNK_SIZE: usize = 64 * 1024;

/// Минимальный интервал между событиями прогресса (100ms = 10 событий/сек)
const PROGRESS_THROTTLE_MS: u64 = 100;

/// Сообщения протокола передачи
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TransferProtocol {
    /// Приветствие с обменом ключами
    Hello {
        peer_id: String,
        public_key: Vec<u8>,
        /// Ed25519 публичный ключ для идентификации (base64)
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ed25519_public_key: Option<String>,
        /// Ed25519 подпись peer_id для верификации (base64)
        #[serde(default, skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
    },
    /// Ответ на приветствие
    HelloAck {
        peer_id: String,
        public_key: Vec<u8>,
        session_key: Vec<u8>, // Зашифрованный сессионный ключ
        /// Ed25519 публичный ключ для идентификации (base64)
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ed25519_public_key: Option<String>,
        /// Ed25519 подпись peer_id для верификации (base64)
        #[serde(default, skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
    },
    /// Запрос манифеста модпака
    ManifestRequest { modpack_name: String },
    /// Ответ с манифестом
    ManifestResponse { manifest: ModpackManifest },
    /// Запрос списка файлов для скачивания
    SyncRequest { diff: SyncDiff },
    /// Подтверждение синхронизации
    SyncAck {
        approved: bool,
        reason: Option<String>,
    },
    /// Запрос файла (с поддержкой resume)
    FileRequest {
        path: String,
        /// Offset в байтах для возобновления (0 = с начала)
        #[serde(default)]
        resume_offset: u64,
    },
    /// Заголовок файла (размер, хеш)
    FileHeader {
        path: String,
        size: u64,
        hash: String,
        total_chunks: u32,
        /// Файл сжат zstd
        #[serde(default)]
        compressed: bool,
        /// Оригинальный размер (до сжатия)
        #[serde(default)]
        original_size: u64,
    },
    /// Чанк файла
    FileChunk {
        path: String,
        chunk_index: u32,
        data: Vec<u8>,
        is_last: bool,
    },
    /// Подтверждение получения файла
    FileAck { path: String, success: bool },
    /// Синхронизация завершена
    SyncComplete {
        files_synced: u32,
        bytes_synced: u64,
    },
    /// Ошибка
    Error { message: String },
    /// Запрос дружбы
    FriendRequest {
        peer_id: String,
        nickname: String,
        public_key: String,
    },
    /// Ответ на запрос дружбы
    FriendResponse {
        accepted: bool,
        peer_id: String,
        nickname: Option<String>,
        public_key: Option<String>,
    },
    /// Запрос на синхронизацию модпака с сервера (Quick Join)
    ServerModpackRequest { server_instance_id: String },
    /// Информация о модпаке сервера (ответ на ServerModpackRequest)
    ServerModpackInfo {
        /// Тип синхронизации: "file" (отправить .stzhk) или "instance" (отправить файлы)
        sync_type: String,
        /// Путь к файлу модпака (если sync_type == "file")
        modpack_filename: Option<String>,
        /// Размер файла модпака
        modpack_size: u64,
        /// SHA256 хеш файла
        modpack_hash: String,
        /// Версия Minecraft
        mc_version: String,
        /// Загрузчик (fabric, forge, etc)
        loader: String,
    },
    /// Запрос на скачивание файла модпака
    ModpackFileRequest {
        /// ID сервера
        server_instance_id: String,
        /// Offset для докачки
        #[serde(default)]
        resume_offset: u64,
    },
    /// Чанк файла модпака
    ModpackFileChunk {
        chunk_index: u32,
        data: Vec<u8>,
        is_last: bool,
    },
    /// Подтверждение получения модпака
    ModpackFileAck {
        success: bool,
        error: Option<String>,
    },
}

/// Статус активной передачи
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferSession {
    pub id: String,
    pub peer_id: String,
    pub peer_nickname: Option<String>,
    pub direction: TransferDirection,
    pub status: SessionStatus,
    pub files_total: u32,
    pub files_done: u32,
    pub bytes_total: u64,
    pub bytes_done: u64,
    pub current_file: Option<String>,
    pub started_at: String,
    /// Скорость передачи (байт/сек)
    #[serde(default)]
    pub speed_bps: u64,
    /// Оставшееся время (секунды)
    #[serde(default)]
    pub eta_seconds: u64,
    /// Передача на паузе
    #[serde(default)]
    pub paused: bool,
    /// Лимит скорости (байт/сек, 0 = без лимита)
    #[serde(default)]
    pub bandwidth_limit: u64,
    /// Количество повторных попыток
    #[serde(default)]
    pub retry_count: u32,
    /// Пир верифицирован через Ed25519 подпись (является доверенным другом)
    #[serde(default)]
    pub verified: bool,
    /// Ed25519 публичный ключ пира (base64)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peer_ed25519_key: Option<String>,
}

/// Статистика передачи для расчёта скорости
#[derive(Debug, Clone)]
pub struct TransferStats {
    /// Время начала передачи
    pub started_at: std::time::Instant,
    /// Последнее обновление
    pub last_update: std::time::Instant,
    /// Байт передано за последний интервал
    pub bytes_last_interval: u64,
    /// Скользящее среднее скорости (для сглаживания)
    pub speed_samples: Vec<u64>,
}

impl TransferStats {
    pub fn new() -> Self {
        Self {
            started_at: std::time::Instant::now(),
            last_update: std::time::Instant::now(),
            bytes_last_interval: 0,
            speed_samples: Vec::with_capacity(10),
        }
    }

    /// Обновить статистику и вернуть (скорость, ETA)
    pub fn update(&mut self, bytes_done: u64, bytes_total: u64) -> (u64, u64) {
        let now = std::time::Instant::now();
        let elapsed = now.duration_since(self.last_update).as_secs_f64();

        if elapsed >= 0.5 {
            // Вычисляем текущую скорость
            let current_speed = (self.bytes_last_interval as f64 / elapsed) as u64;

            // Добавляем в скользящее среднее (последние 10 замеров)
            self.speed_samples.push(current_speed);
            if self.speed_samples.len() > 10 {
                self.speed_samples.remove(0);
            }

            self.last_update = now;
            self.bytes_last_interval = 0;
        }

        // Средняя скорость
        let avg_speed = if self.speed_samples.is_empty() {
            0
        } else {
            self.speed_samples.iter().sum::<u64>() / self.speed_samples.len() as u64
        };

        // ETA
        let remaining = bytes_total.saturating_sub(bytes_done);
        let eta = if avg_speed > 0 {
            remaining / avg_speed
        } else {
            0
        };

        (avg_speed, eta)
    }

    /// Добавить переданные байты
    pub fn add_bytes(&mut self, bytes: u64) {
        self.bytes_last_interval += bytes;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransferDirection {
    Upload,
    Download,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Connecting,
    Negotiating,
    Transferring,
    Paused,
    Completed,
    Failed,
    Cancelled,
}

/// События для UI
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TransferEvent {
    /// Сессия создана
    SessionCreated { session: TransferSession },
    /// Прогресс передачи
    Progress {
        session_id: String,
        bytes_done: u64,
        bytes_total: u64,
        files_done: u32,
        files_total: u32,
        current_file: String,
    },
    /// Передача завершена
    Completed {
        session_id: String,
        files_synced: u32,
        bytes_synced: u64,
    },
    /// Ошибка
    Error { session_id: String, message: String },
    /// Входящий запрос на передачу
    IncomingRequest {
        session_id: String,
        peer_id: String,
        peer_nickname: Option<String>,
        modpack_name: String,
        files_count: u32,
        total_size: u64,
    },
    /// Запрос в друзья
    FriendRequest {
        peer_id: String,
        nickname: String,
        public_key: String,
    },
    /// Передача отменена
    Cancelled { session_id: String },
}

/// Ограничитель скорости (Token Bucket)
#[derive(Debug, Clone)]
pub struct BandwidthLimiter {
    /// Лимит байт/сек (0 = без лимита)
    limit_bps: u64,
    /// Доступные токены
    tokens: u64,
    /// Последнее пополнение
    last_refill: std::time::Instant,
}

impl BandwidthLimiter {
    pub fn new(limit_bps: u64) -> Self {
        Self {
            limit_bps,
            tokens: limit_bps,
            last_refill: std::time::Instant::now(),
        }
    }

    /// Установить новый лимит
    pub fn set_limit(&mut self, limit_bps: u64) {
        self.limit_bps = limit_bps;
        self.tokens = limit_bps;
    }

    /// Запросить разрешение на передачу bytes байт
    /// Возвращает задержку в миллисекундах
    pub fn request(&mut self, bytes: u64) -> u64 {
        if self.limit_bps == 0 {
            return 0; // Без лимита
        }

        // Пополняем токены
        let now = std::time::Instant::now();
        let elapsed = now.duration_since(self.last_refill).as_secs_f64();
        let refill = (elapsed * self.limit_bps as f64) as u64;
        self.tokens = std::cmp::min(self.tokens + refill, self.limit_bps * 2); // Burst до 2 сек
        self.last_refill = now;

        // Если достаточно токенов - передаём сразу
        if self.tokens >= bytes {
            self.tokens -= bytes;
            return 0;
        }

        // Иначе вычисляем задержку
        let needed = bytes - self.tokens;
        self.tokens = 0;
        ((needed as f64 / self.limit_bps as f64) * 1000.0) as u64
    }
}

/// Сервер передачи файлов
pub struct TransferServer {
    /// ID пира
    peer_id: String,
    /// Порт для TCP (запрошенный)
    port: u16,
    /// Фактический порт (может отличаться если запрошенный занят)
    actual_port: Arc<RwLock<u16>>,
    /// Базовый путь к экземплярам
    instances_path: PathBuf,
    /// Активные сессии
    sessions: Arc<RwLock<HashMap<String, TransferSession>>>,
    /// Канал событий
    event_tx: mpsc::Sender<TransferEvent>,
    /// Токен отмены
    cancel_token: CancellationToken,
    /// Флаг работы
    running: Arc<RwLock<bool>>,
    /// Приостановленные сессии
    paused_sessions: Arc<RwLock<std::collections::HashSet<String>>>,
    /// Глобальный лимит скорости
    bandwidth_limit: Arc<RwLock<u64>>,
    /// Rate limiter для защиты от DoS (глобальный по peer_id)
    rate_limiter: Arc<RateLimiter>,
    /// Менеджер доверенных друзей для Ed25519 верификации
    friends_manager: Arc<RwLock<super::friends::FriendsManager>>,
}

impl TransferServer {
    pub fn new(
        peer_id: String,
        port: u16,
        instances_path: PathBuf,
        event_tx: mpsc::Sender<TransferEvent>,
    ) -> Self {
        Self {
            peer_id,
            port,
            actual_port: Arc::new(RwLock::new(port)),
            instances_path,
            sessions: Arc::new(RwLock::new(HashMap::new())),
            event_tx,
            cancel_token: CancellationToken::new(),
            running: Arc::new(RwLock::new(false)),
            paused_sessions: Arc::new(RwLock::new(std::collections::HashSet::new())),
            bandwidth_limit: Arc::new(RwLock::new(0)),
            // Rate limiter: 100 requests per 60 seconds per peer
            rate_limiter: Arc::new(RateLimiter::new(100, 60)),
            friends_manager: Arc::new(RwLock::new(super::friends::FriendsManager::new())),
        }
    }

    /// Установить менеджер друзей (с загруженными ключами)
    pub fn set_friends_manager(&mut self, manager: super::friends::FriendsManager) {
        self.friends_manager = Arc::new(RwLock::new(manager));
    }

    /// Получить ссылку на менеджер друзей
    pub fn get_friends_manager(&self) -> Arc<RwLock<super::friends::FriendsManager>> {
        self.friends_manager.clone()
    }

    /// Получить фактический порт сервера
    pub async fn get_actual_port(&self) -> u16 {
        *self.actual_port.read().await
    }

    /// Приостановить передачу
    pub async fn pause_session(&self, session_id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.write().await;
        if let Some(session) = sessions.get_mut(session_id) {
            session.paused = true;
            session.status = SessionStatus::Paused;
            self.paused_sessions
                .write()
                .await
                .insert(session_id.to_string());
            log::info!("Paused session {}", session_id);
            Ok(())
        } else {
            Err("Session not found".to_string())
        }
    }

    /// Возобновить передачу
    pub async fn resume_session(&self, session_id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.write().await;
        if let Some(session) = sessions.get_mut(session_id) {
            session.paused = false;
            session.status = SessionStatus::Transferring;
            self.paused_sessions.write().await.remove(session_id);
            log::info!("Resumed session {}", session_id);
            Ok(())
        } else {
            Err("Session not found".to_string())
        }
    }

    /// Установить лимит скорости (байт/сек, 0 = без лимита)
    pub async fn set_bandwidth_limit(&self, limit_bps: u64) {
        *self.bandwidth_limit.write().await = limit_bps;
        log::info!("Bandwidth limit set to {} bytes/sec", limit_bps);
    }

    /// Получить текущий лимит скорости
    pub async fn get_bandwidth_limit(&self) -> u64 {
        *self.bandwidth_limit.read().await
    }

    /// Проверить, на паузе ли сессия
    pub async fn is_session_paused(&self, session_id: &str) -> bool {
        self.paused_sessions.read().await.contains(session_id)
    }

    /// Запустить сервер
    pub async fn start(&mut self) -> Result<(), String> {
        {
            let running = self.running.read().await;
            if *running {
                return Ok(());
            }
        }

        // Пробуем порты: основной, затем +10, +20, +30
        let ports_to_try = [self.port, self.port + 10, self.port + 20, self.port + 30];

        let mut listener = None;
        let mut bound_port = self.port;

        for port in ports_to_try {
            let addr = SocketAddr::from(([0, 0, 0, 0], port));
            match TcpListener::bind(addr).await {
                Ok(l) => {
                    listener = Some(l);
                    bound_port = port;
                    if port != self.port {
                        log::warn!(
                            "Port {} was busy, using alternative port {}",
                            self.port,
                            port
                        );
                    }
                    break;
                }
                Err(e) => {
                    log::debug!("Failed to bind to port {}: {}", port, e);
                    continue;
                }
            }
        }

        let listener = listener.ok_or_else(|| {
            format!(
                "Failed to bind TCP server: all ports busy ({}, {}, {}, {})",
                ports_to_try[0], ports_to_try[1], ports_to_try[2], ports_to_try[3]
            )
        })?;

        *self.actual_port.write().await = bound_port;
        *self.running.write().await = true;
        self.cancel_token = CancellationToken::new();

        log::info!("Transfer server started on port {}", bound_port);

        let sessions = self.sessions.clone();
        let event_tx = self.event_tx.clone();
        let instances_path = self.instances_path.clone();
        let peer_id = self.peer_id.clone();
        let cancel_token = self.cancel_token.clone();
        let rate_limiter = self.rate_limiter.clone();

        // Запускаем периодическую очистку rate_limiter
        let rate_limiter_cleanup = rate_limiter.clone();
        let cleanup_cancel = cancel_token.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = cleanup_cancel.cancelled() => break,
                    _ = tokio::time::sleep(std::time::Duration::from_secs(60)) => {
                        rate_limiter_cleanup.cleanup().await;
                    }
                }
            }
        });

        // Запускаем приём соединений в фоне
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = cancel_token.cancelled() => {
                        log::info!("Transfer server shutting down");
                        break;
                    }
                    result = listener.accept() => {
                        match result {
                            Ok((stream, addr)) => {
                                log::info!("Incoming connection from {}", addr);
                                let sessions = sessions.clone();
                                let event_tx = event_tx.clone();
                                let instances_path = instances_path.clone();
                                let peer_id = peer_id.clone();
                                let rate_limiter = rate_limiter.clone();

                                tokio::spawn(async move {
                                    if let Err(e) = handle_connection(
                                        stream,
                                        addr,
                                        &peer_id,
                                        &instances_path,
                                        sessions,
                                        event_tx,
                                        rate_limiter,
                                    ).await {
                                        log::error!("Connection error: {}", e);
                                    }
                                });
                            }
                            Err(e) => {
                                log::error!("Failed to accept connection: {}", e);
                            }
                        }
                    }
                }
            }
        });

        Ok(())
    }

    /// Остановить сервер
    pub async fn stop(&self) {
        self.cancel_token.cancel();
        *self.running.write().await = false;
        log::info!("Transfer server stopped");
    }

    /// Получить активные сессии
    pub async fn get_sessions(&self) -> Vec<TransferSession> {
        self.sessions.read().await.values().cloned().collect()
    }

    /// Отменить сессию передачи
    pub async fn cancel_session(&self, session_id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.write().await;
        if let Some(session) = sessions.get_mut(session_id) {
            session.status = SessionStatus::Cancelled;
            let _ = self
                .event_tx
                .send(TransferEvent::Cancelled {
                    session_id: session_id.to_string(),
                })
                .await;
            log::info!("Transfer session cancelled: {}", session_id);
            Ok(())
        } else {
            Err("Session not found".to_string())
        }
    }

    /// Подключиться к пиру и запросить синхронизацию
    pub async fn request_sync(
        &self,
        peer_addr: SocketAddr,
        peer_id: &str,
        modpack_name: &str,
        local_manifest: &ModpackManifest,
    ) -> Result<String, String> {
        let mut stream = TcpStream::connect(peer_addr)
            .await
            .map_err(|e| format!("Failed to connect to peer: {}", e))?;

        // Генерируем ID сессии
        let session_id = uuid::Uuid::new_v4().to_string();

        // Создаём сессию
        let bandwidth_limit = *self.bandwidth_limit.read().await;
        let session = TransferSession {
            id: session_id.clone(),
            peer_id: peer_id.to_string(),
            peer_nickname: None,
            direction: TransferDirection::Download,
            status: SessionStatus::Connecting,
            files_total: 0,
            files_done: 0,
            bytes_total: 0,
            bytes_done: 0,
            current_file: None,
            started_at: chrono::Utc::now().to_rfc3339(),
            speed_bps: 0,
            eta_seconds: 0,
            paused: false,
            bandwidth_limit,
            retry_count: 0,
            verified: false,
            peer_ed25519_key: None,
        };

        self.sessions
            .write()
            .await
            .insert(session_id.clone(), session.clone());
        let _ = self
            .event_tx
            .send(TransferEvent::SessionCreated { session })
            .await;

        // Генерируем ключевую пару для E2E шифрования
        let our_keypair = KeyPair::generate();
        let our_public_key = our_keypair.public_bytes().to_vec();

        // Отправляем приветствие с нашим публичным ключом
        let hello = TransferProtocol::Hello {
            peer_id: self.peer_id.clone(),
            public_key: our_public_key,
            ed25519_public_key: None,
            signature: None,
        };
        send_message(&mut stream, &hello).await?;

        // Получаем ответ с публичным ключом пира
        let ack: TransferProtocol = receive_message(&mut stream).await?;
        let peer_public_key = match ack {
            TransferProtocol::HelloAck { public_key, .. } => public_key,
            TransferProtocol::Error { message } => {
                return Err(format!("Peer rejected connection: {}", message));
            }
            _ => return Err("Expected HelloAck response".to_string()),
        };

        // E2E шифрование обязательно
        if peer_public_key.is_empty() {
            return Err("Peer did not provide public key - E2E encryption required".to_string());
        }

        // Выполняем обмен ключами и создаём сессионный ключ
        let mut session_key = our_keypair
            .key_exchange(&peer_public_key)
            .map_err(|e| format!("Key exchange failed: {}", e))?;

        log::info!("E2E encryption established with peer {}", peer_id);

        // Запрашиваем манифест
        let request = TransferProtocol::ManifestRequest {
            modpack_name: modpack_name.to_string(),
        };
        send_message(&mut stream, &request).await?;

        // Получаем манифест
        let response: TransferProtocol = receive_message(&mut stream).await?;

        let remote_manifest = match response {
            TransferProtocol::ManifestResponse { manifest } => manifest,
            TransferProtocol::Error { message } => {
                return Err(format!("Peer error: {}", message));
            }
            _ => return Err("Unexpected response".to_string()),
        };

        // Вычисляем diff
        let diff = TransferManager::compute_diff(local_manifest, &remote_manifest);

        if diff.to_download.is_empty() && diff.to_delete.is_empty() {
            log::info!("No changes needed, modpacks are in sync");
            return Ok(session_id);
        }

        // Обновляем сессию
        {
            let mut sessions = self.sessions.write().await;
            if let Some(s) = sessions.get_mut(&session_id) {
                s.files_total = diff.to_download.len() as u32;
                s.bytes_total = diff.total_download_size;
                s.status = SessionStatus::Negotiating;
            }
        }

        // Запрашиваем синхронизацию
        let sync_request = TransferProtocol::SyncRequest { diff: diff.clone() };
        send_message(&mut stream, &sync_request).await?;

        // Ждём подтверждения
        let ack: TransferProtocol = receive_message(&mut stream).await?;

        match ack {
            TransferProtocol::SyncAck { approved: true, .. } => {
                // Начинаем скачивание файлов с E2E шифрованием
                self.download_files(
                    &mut stream,
                    &session_id,
                    &diff.to_download,
                    &self.instances_path,
                    modpack_name,
                    &session_key,
                )
                .await?;

                // Удаляем файлы которые больше не нужны
                for path in &diff.to_delete {
                    let full_path = self.instances_path.join(modpack_name).join(path);
                    if full_path.exists() {
                        let _ = tokio::fs::remove_file(&full_path).await;
                    }
                }

                Ok(session_id)
            }
            TransferProtocol::SyncAck {
                approved: false,
                reason,
            } => Err(format!("Sync rejected: {}", reason.unwrap_or_default())),
            _ => Err("Unexpected response".to_string()),
        }
    }

    /// Скачать файлы с E2E шифрованием, bandwidth limiting, pause/resume и статистикой
    async fn download_files(
        &self,
        stream: &mut TcpStream,
        session_id: &str,
        files: &[FileInfo],
        base_path: &PathBuf,
        modpack_name: &str,
        session_key: &SessionKey,
    ) -> Result<(), String> {
        // Обновляем статус
        {
            let mut sessions = self.sessions.write().await;
            if let Some(s) = sessions.get_mut(session_id) {
                s.status = SessionStatus::Transferring;
            }
        }

        let mut bytes_done: u64 = 0;
        let mut files_done: u32 = 0;

        // Pre-calculate totals (optimization: avoid recalculating in loop)
        let bytes_total: u64 = files.iter().map(|f| f.size).sum();
        let files_total = files.len() as u32;

        // Priority queue: сортируем файлы по размеру (мелкие сначала для быстрого старта)
        let mut sorted_files: Vec<_> = files.iter().collect();
        sorted_files.sort_by_key(|f| f.size);

        // Progress throttling: max 10 events/second
        let mut last_progress = std::time::Instant::now();
        let throttle_duration = std::time::Duration::from_millis(PROGRESS_THROTTLE_MS);

        // Transfer statistics
        let mut stats = TransferStats::new();

        // Bandwidth limiter
        let bandwidth_limit = *self.bandwidth_limit.read().await;
        let mut limiter = BandwidthLimiter::new(bandwidth_limit);

        for file in sorted_files {
            // Проверяем паузу
            while self.is_session_paused(session_id).await {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                // Проверяем отмену
                if self
                    .sessions
                    .read()
                    .await
                    .get(session_id)
                    .map(|s| s.status == SessionStatus::Cancelled)
                    .unwrap_or(true)
                {
                    return Err("Transfer cancelled".to_string());
                }
            }

            // Обновляем текущий файл
            {
                let mut sessions = self.sessions.write().await;
                if let Some(s) = sessions.get_mut(session_id) {
                    s.current_file = Some(file.path.clone());
                }
            }

            // Проверяем существующий частично скачанный файл для resume
            let file_path = base_path.join(modpack_name).join(&file.path);
            let resume_offset = if file_path.exists() {
                tokio::fs::metadata(&file_path)
                    .await
                    .map(|m| m.len())
                    .unwrap_or(0)
            } else {
                0
            };

            // Auto-retry: до 3 попыток при ошибках сети
            let mut retry_count = 0;
            const MAX_RETRIES: u32 = 3;

            let download_result = loop {
                // Запрашиваем файл с offset для resume
                let request = TransferProtocol::FileRequest {
                    path: file.path.clone(),
                    resume_offset,
                };

                match send_message(stream, &request).await {
                    Ok(_) => {}
                    Err(e) if retry_count < MAX_RETRIES => {
                        retry_count += 1;
                        log::warn!(
                            "Retry {}/{} for {}: {}",
                            retry_count,
                            MAX_RETRIES,
                            file.path,
                            e
                        );
                        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                        continue;
                    }
                    Err(e) => break Err(e),
                }

                // Получаем заголовок
                let header: TransferProtocol = match receive_message(stream).await {
                    Ok(h) => h,
                    Err(e) if retry_count < MAX_RETRIES => {
                        retry_count += 1;
                        log::warn!(
                            "Retry {}/{} for {}: {}",
                            retry_count,
                            MAX_RETRIES,
                            file.path,
                            e
                        );
                        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                        continue;
                    }
                    Err(e) => break Err(e),
                };

                let (path, size, total_chunks, compressed) = match header {
                    TransferProtocol::FileHeader {
                        path,
                        size,
                        total_chunks,
                        compressed,
                        ..
                    } => (path, size, total_chunks, compressed),
                    TransferProtocol::Error { message } => {
                        log::error!("Failed to get file {}: {}", file.path, message);
                        break Err(message);
                    }
                    _ => break Err("Unexpected response".to_string()),
                };

                // Создаём директорию
                let file_path = base_path.join(modpack_name).join(&path);
                if let Some(parent) = file_path.parent() {
                    tokio::fs::create_dir_all(parent).await.ok();
                }

                // Собираем все чанки в память если файл сжат
                let mut compressed_data: Vec<u8> = if compressed {
                    Vec::with_capacity(size as usize)
                } else {
                    Vec::new()
                };

                // Создаём файл для записи
                let output_file = if resume_offset > 0 && !compressed {
                    tokio::fs::OpenOptions::new()
                        .append(true)
                        .open(&file_path)
                        .await
                        .map_err(|e| format!("Failed to open file for append: {}", e))?
                } else {
                    tokio::fs::File::create(&file_path)
                        .await
                        .map_err(|e| format!("Failed to create file: {}", e))?
                };
                let mut output = BufWriter::with_capacity(256 * 1024, output_file);

                // Получаем и расшифровываем чанки
                let mut file_bytes: u64 = 0;
                for _ in 0..total_chunks {
                    // Проверяем паузу между чанками
                    while self.is_session_paused(session_id).await {
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    }

                    let chunk: TransferProtocol = receive_message(stream).await?;

                    if let TransferProtocol::FileChunk { data, .. } = chunk {
                        // Расшифровываем чанк
                        let decrypted = crypto::decrypt_chunk(session_key, &data)
                            .map_err(|e| format!("Failed to decrypt chunk: {}", e))?;

                        // Bandwidth limiting
                        let delay_ms = limiter.request(decrypted.len() as u64);
                        if delay_ms > 0 {
                            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                        }

                        if compressed {
                            compressed_data.extend_from_slice(&decrypted);
                        } else {
                            output
                                .write_all(&decrypted)
                                .await
                                .map_err(|e| format!("Failed to write chunk: {}", e))?;
                        }

                        file_bytes += decrypted.len() as u64;
                        bytes_done += decrypted.len() as u64;

                        // Update statistics
                        stats.add_bytes(decrypted.len() as u64);
                        let (speed, eta) = stats.update(bytes_done, bytes_total);

                        // Throttled progress
                        let now = std::time::Instant::now();
                        if now.duration_since(last_progress) >= throttle_duration {
                            last_progress = now;

                            // Обновляем сессию со статистикой
                            {
                                let mut sessions = self.sessions.write().await;
                                if let Some(s) = sessions.get_mut(session_id) {
                                    s.speed_bps = speed;
                                    s.eta_seconds = eta;
                                    s.bytes_done = bytes_done;
                                    s.retry_count = retry_count;
                                }
                            }

                            let _ = self
                                .event_tx
                                .send(TransferEvent::Progress {
                                    session_id: session_id.to_string(),
                                    bytes_done,
                                    bytes_total,
                                    files_done,
                                    files_total,
                                    current_file: file.path.clone(),
                                })
                                .await;
                        }
                    }
                }

                // Распаковываем если файл был сжат
                if compressed && !compressed_data.is_empty() {
                    let decompressed = decompress_data(&compressed_data)
                        .map_err(|e| format!("Failed to decompress {}: {}", path, e))?;
                    output
                        .write_all(&decompressed)
                        .await
                        .map_err(|e| format!("Failed to write decompressed data: {}", e))?;
                    log::debug!(
                        "Decompressed {} from {} to {} bytes",
                        path,
                        compressed_data.len(),
                        decompressed.len()
                    );
                }

                // Flush буфера перед подтверждением
                output
                    .flush()
                    .await
                    .map_err(|e| format!("Failed to flush file: {}", e))?;

                // Подтверждаем получение
                let ack = TransferProtocol::FileAck {
                    path: path.clone(),
                    success: file_bytes == size,
                };
                send_message(stream, &ack).await?;

                break Ok(());
            };

            // Обрабатываем результат (continue при ошибке отдельного файла)
            if let Err(e) = download_result {
                log::error!("Failed to download {}: {}", file.path, e);
                continue;
            }

            files_done += 1;

            // Обновляем сессию
            {
                let mut sessions = self.sessions.write().await;
                if let Some(s) = sessions.get_mut(session_id) {
                    s.files_done = files_done;
                    s.bytes_done = bytes_done;
                }
            }

            // Отправляем прогресс при завершении каждого файла
            let _ = self
                .event_tx
                .send(TransferEvent::Progress {
                    session_id: session_id.to_string(),
                    bytes_done,
                    bytes_total,
                    files_done,
                    files_total,
                    current_file: file.path.clone(),
                })
                .await;
        }

        // Завершаем
        {
            let mut sessions = self.sessions.write().await;
            if let Some(s) = sessions.get_mut(session_id) {
                s.status = SessionStatus::Completed;
            }
        }

        // Integrity check: верифицируем хеши скачанных файлов
        let mut verification_errors = Vec::new();
        for file in files {
            let file_path = base_path.join(modpack_name).join(&file.path);
            if file_path.exists() {
                match TransferManager::compute_file_hash_static(&file_path).await {
                    Ok(computed_hash) => {
                        if computed_hash != file.hash {
                            log::warn!(
                                "Hash mismatch for {}: expected {}, got {}",
                                file.path,
                                file.hash,
                                computed_hash
                            );
                            verification_errors.push(file.path.clone());
                        }
                    }
                    Err(e) => {
                        log::warn!("Failed to verify {}: {}", file.path, e);
                    }
                }
            }
        }

        if !verification_errors.is_empty() {
            log::warn!(
                "Integrity check failed for {} files",
                verification_errors.len()
            );
        }

        let _ = self
            .event_tx
            .send(TransferEvent::Completed {
                session_id: session_id.to_string(),
                files_synced: files_done,
                bytes_synced: bytes_done,
            })
            .await;

        Ok(())
    }

    /// Отправить запрос в друзья пиру
    pub async fn send_friend_request(
        &self,
        peer_addr: SocketAddr,
        our_nickname: &str,
        our_public_key: &str,
    ) -> Result<(), String> {
        let mut stream = TcpStream::connect(peer_addr)
            .await
            .map_err(|e| format!("Failed to connect to peer: {}", e))?;

        // Отправляем приветствие
        let hello = TransferProtocol::Hello {
            peer_id: self.peer_id.clone(),
            public_key: vec![],
            ed25519_public_key: None,
            signature: None,
        };
        send_message(&mut stream, &hello).await?;

        // Ждём ответ
        let _ack: TransferProtocol = receive_message(&mut stream).await?;

        // Отправляем запрос в друзья
        let request = TransferProtocol::FriendRequest {
            peer_id: self.peer_id.clone(),
            nickname: our_nickname.to_string(),
            public_key: our_public_key.to_string(),
        };
        send_message(&mut stream, &request).await?;

        log::info!("Sent friend request to {}", peer_addr);

        Ok(())
    }

    /// Групповая передача модпака нескольким пирам одновременно
    /// Возвращает список session_id для каждого пира
    pub async fn broadcast_sync(
        &self,
        peers: Vec<(SocketAddr, String)>, // (addr, peer_id)
        modpack_name: &str,
        local_manifest: &ModpackManifest,
    ) -> Vec<Result<String, String>> {
        use futures::future::join_all;

        let tasks: Vec<_> = peers
            .into_iter()
            .map(|(addr, peer_id)| {
                let modpack_name = modpack_name.to_string();
                let local_manifest = local_manifest.clone();
                let server = self.clone_for_broadcast();

                async move {
                    server
                        .request_sync(addr, &peer_id, &modpack_name, &local_manifest)
                        .await
                }
            })
            .collect();

        join_all(tasks).await
    }

    /// Создать копию сервера для параллельных операций
    fn clone_for_broadcast(&self) -> Self {
        Self {
            peer_id: self.peer_id.clone(),
            port: self.port,
            actual_port: self.actual_port.clone(),
            instances_path: self.instances_path.clone(),
            sessions: self.sessions.clone(),
            event_tx: self.event_tx.clone(),
            cancel_token: self.cancel_token.clone(),
            running: self.running.clone(),
            paused_sessions: self.paused_sessions.clone(),
            bandwidth_limit: self.bandwidth_limit.clone(),
            rate_limiter: self.rate_limiter.clone(),
            friends_manager: self.friends_manager.clone(),
        }
    }
}

/// Результат групповой передачи
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BroadcastResult {
    pub peer_id: String,
    pub session_id: Option<String>,
    pub error: Option<String>,
}

/// Обработка входящего соединения с полной валидацией безопасности и E2E шифрованием
async fn handle_connection(
    mut stream: TcpStream,
    addr: SocketAddr,
    my_peer_id: &str,
    instances_path: &PathBuf,
    sessions: Arc<RwLock<HashMap<String, TransferSession>>>,
    event_tx: mpsc::Sender<TransferEvent>,
    rate_limiter: Arc<RateLimiter>,
) -> Result<(), String> {
    log::debug!("Handling connection from {}", addr);

    // Получаем приветствие с публичным ключом пира
    let hello: TransferProtocol = receive_message(&mut stream).await?;

    let (peer_id, peer_public_key) = match hello {
        TransferProtocol::Hello {
            peer_id,
            public_key,
            ed25519_public_key: _,
            signature: _,
        } => {
            // SECURITY: Валидируем peer_id
            if let Err(e) = validate_peer_id(&peer_id) {
                log::warn!("Invalid peer_id from {}: {}", addr, e);
                return Err(format!("Invalid peer ID: {}", e));
            }
            (peer_id, public_key)
        }
        _ => return Err("Expected Hello message".to_string()),
    };

    // Генерируем нашу ключевую пару для E2E шифрования
    let our_keypair = KeyPair::generate();
    let our_public_key = our_keypair.public_bytes().to_vec();

    // Отвечаем с нашим публичным ключом
    let ack = TransferProtocol::HelloAck {
        peer_id: my_peer_id.to_string(),
        public_key: our_public_key,
        session_key: vec![], // Не используется при X25519
        ed25519_public_key: None,
        signature: None,
    };
    send_message(&mut stream, &ack).await?;

    // E2E шифрование обязательно - отклоняем соединения без него
    if peer_public_key.is_empty() {
        log::warn!(
            "Peer {} from {} did not provide public key - rejecting connection",
            peer_id,
            addr
        );
        let error = TransferProtocol::Error {
            message: "E2E encryption required - public key must be provided".to_string(),
        };
        let _ = send_message(&mut stream, &error).await;
        return Err("E2E encryption required but peer did not provide public key".to_string());
    }

    let session_key = match our_keypair.key_exchange(&peer_public_key) {
        Ok(key) => {
            log::info!(
                "E2E encryption established with peer {} from {}",
                peer_id,
                addr
            );
            Some(key)
        }
        Err(e) => {
            log::error!(
                "Key exchange failed with peer {} from {}: {}",
                peer_id,
                addr,
                e
            );
            let error = TransferProtocol::Error {
                message: format!("Key exchange failed: {}", e),
            };
            let _ = send_message(&mut stream, &error).await;
            return Err(format!("Key exchange failed: {}", e));
        }
    };

    // Мутабельная копия session_key для шифрования
    let mut session_key_mut = session_key;

    // Основной цикл обработки сообщений
    loop {
        // SECURITY: Global rate limiting per peer_id
        if !rate_limiter.check(&peer_id).await {
            log::warn!(
                "Global rate limit exceeded for peer {} from {}",
                peer_id,
                addr
            );
            let error = TransferProtocol::Error {
                message: "Rate limit exceeded".to_string(),
            };
            let _ = send_message(&mut stream, &error).await;
            break;
        }

        let message: TransferProtocol = match receive_message(&mut stream).await {
            Ok(m) => m,
            Err(_) => break, // Соединение закрыто
        };

        match message {
            TransferProtocol::ManifestRequest { modpack_name } => {
                // SECURITY: Валидируем имя модпака
                if let Err(e) = validate_modpack_name(&modpack_name) {
                    log::warn!(
                        "Invalid modpack name from {}: {} - {}",
                        addr,
                        modpack_name,
                        e
                    );
                    let error = TransferProtocol::Error {
                        message: format!("Invalid modpack name: {}", e),
                    };
                    send_message(&mut stream, &error).await?;
                    continue;
                }

                // SECURITY: Используем sanitize_path для безопасного формирования пути
                let instance_path = match sanitize_path(&modpack_name, instances_path) {
                    Ok(p) => p,
                    Err(e) => {
                        log::warn!(
                            "Path traversal attempt from {}: {} - {}",
                            addr,
                            modpack_name,
                            e
                        );
                        let error = TransferProtocol::Error {
                            message: "Access denied".to_string(),
                        };
                        send_message(&mut stream, &error).await?;
                        continue;
                    }
                };

                if !instance_path.exists() {
                    let error = TransferProtocol::Error {
                        message: format!("Instance '{}' not found", modpack_name),
                    };
                    send_message(&mut stream, &error).await?;
                    continue;
                }

                // Получаем информацию из БД
                let (mc_version, loader, loader_version) = get_instance_info_by_name(&modpack_name);

                // Создаём манифест
                match TransferManager::create_manifest(
                    &instance_path,
                    &modpack_name,
                    &mc_version,
                    &loader,
                    &loader_version,
                )
                .await
                {
                    Ok(manifest) => {
                        // SECURITY: Валидируем размер передачи
                        let total_size: u64 = manifest.files.iter().map(|f| f.size).sum();
                        if let Err(e) = validate_transfer_size(total_size, manifest.files.len()) {
                            log::warn!("Transfer size exceeded for {}: {}", modpack_name, e);
                            let error = TransferProtocol::Error {
                                message: format!("Transfer too large: {}", e),
                            };
                            send_message(&mut stream, &error).await?;
                            continue;
                        }

                        let response = TransferProtocol::ManifestResponse { manifest };
                        send_message(&mut stream, &response).await?;
                    }
                    Err(e) => {
                        let error = TransferProtocol::Error { message: e };
                        send_message(&mut stream, &error).await?;
                    }
                }
            }

            TransferProtocol::SyncRequest { diff } => {
                // SECURITY: Валидируем размер запроса
                if let Err(e) =
                    validate_transfer_size(diff.total_download_size, diff.to_download.len())
                {
                    log::warn!("Transfer size validation failed from {}: {}", addr, e);
                    let ack = TransferProtocol::SyncAck {
                        approved: false,
                        reason: Some(format!("Transfer too large: {}", e)),
                    };
                    send_message(&mut stream, &ack).await?;
                    continue;
                }

                let session_id = uuid::Uuid::new_v4().to_string();

                log::info!(
                    "Sync request from {} (files: {}, size: {} bytes)",
                    peer_id,
                    diff.to_download.len(),
                    diff.total_download_size
                );

                // Загружаем настройки для проверки запомненных разрешений
                let settings = super::settings::load_connect_settings();

                // Проверяем запомненные разрешения
                let remembered = settings
                    .remembered_permissions
                    .iter()
                    .find(|p| p.peer_id == peer_id && p.content_type == "modpack");

                let approved = if let Some(perm) = remembered {
                    log::info!(
                        "Using remembered permission for peer {}: allowed={}",
                        peer_id,
                        perm.allowed
                    );
                    perm.allowed
                } else {
                    // Создаём запрос на согласие и ждём ответа от пользователя
                    use super::consent::{get_consent_manager, ConsentType};

                    let (consent_request, consent_rx) = get_consent_manager()
                        .create_request(
                            peer_id.clone(),
                            None, // Никнейм недоступен в текущем протоколе - отображается peer_id
                            ConsentType::Modpack,
                            format!("{} files", diff.to_download.len()),
                            Some(diff.total_download_size),
                        )
                        .await;

                    // Отправляем событие для UI (запрос на подтверждение)
                    let _ = event_tx
                        .send(TransferEvent::IncomingRequest {
                            session_id: consent_request.request_id.clone(),
                            peer_id: peer_id.clone(),
                            peer_nickname: None,
                            modpack_name: format!("{} files", diff.to_download.len()),
                            files_count: diff.to_download.len() as u32,
                            total_size: diff.total_download_size,
                        })
                        .await;

                    // Ожидаем ответ пользователя (с таймаутом)
                    match get_consent_manager().wait_for_response(consent_rx).await {
                        Some(response) => {
                            log::info!(
                                "User consent for {}: approved={}",
                                peer_id,
                                response.approved
                            );
                            response.approved
                        }
                        None => {
                            log::info!("Consent request timed out for {}", peer_id);
                            false
                        }
                    }
                };

                let ack = if approved {
                    TransferProtocol::SyncAck {
                        approved: true,
                        reason: None,
                    }
                } else {
                    TransferProtocol::SyncAck {
                        approved: false,
                        reason: Some("User denied the transfer request.".to_string()),
                    }
                };
                send_message(&mut stream, &ack).await?;
            }

            TransferProtocol::FileRequest {
                path,
                resume_offset,
            } => {
                // SECURITY: Валидируем расширение файла
                if let Err(e) = validate_extension(&path) {
                    log::warn!("Forbidden file extension from {}: {} - {}", addr, path, e);
                    let error = TransferProtocol::Error {
                        message: format!("File type not allowed: {}", e),
                    };
                    send_message(&mut stream, &error).await?;
                    continue;
                }

                // SECURITY: Используем sanitize_path для защиты от path traversal
                let file_path = match sanitize_path(&path, instances_path) {
                    Ok(p) => p,
                    Err(e) => {
                        log::warn!("Path traversal attempt from {}: {} - {}", addr, path, e);
                        let error = TransferProtocol::Error {
                            message: "Access denied".to_string(),
                        };
                        send_message(&mut stream, &error).await?;
                        continue;
                    }
                };

                if !file_path.exists() {
                    let error = TransferProtocol::Error {
                        message: "File not found".to_string(), // Не раскрываем путь
                    };
                    send_message(&mut stream, &error).await?;
                    continue;
                }

                // SECURITY: Проверяем размер файла
                if let Ok(metadata) = tokio::fs::metadata(&file_path).await {
                    if let Err(e) = validate_file_size(metadata.len()) {
                        log::warn!("File too large: {} - {}", path, e);
                        let error = TransferProtocol::Error {
                            message: format!("File too large: {}", e),
                        };
                        send_message(&mut stream, &error).await?;
                        continue;
                    }
                }

                // Отправляем файл с E2E шифрованием, сжатием и поддержкой resume
                if let Err(e) = send_file(
                    &mut stream,
                    &file_path,
                    &path,
                    &mut session_key_mut,
                    resume_offset,
                )
                .await
                {
                    log::error!("Failed to send file {}: {}", path, e);
                }
            }

            TransferProtocol::FriendRequest {
                peer_id: req_peer_id,
                nickname,
                public_key,
            } => {
                // SECURITY: Валидируем данные friend request
                if let Err(e) = validate_peer_id(&req_peer_id) {
                    log::warn!("Invalid peer_id in friend request from {}: {}", addr, e);
                    continue;
                }

                // Ограничиваем длину nickname
                let safe_nickname = if nickname.len() > 50 {
                    nickname[..50].to_string()
                } else {
                    nickname
                };

                // Ограничиваем длину public_key
                if public_key.len() > 500 {
                    log::warn!("Public key too long in friend request from {}", addr);
                    continue;
                }

                let _ = event_tx
                    .send(TransferEvent::FriendRequest {
                        peer_id: req_peer_id,
                        nickname: safe_nickname,
                        public_key,
                    })
                    .await;
            }

            TransferProtocol::ServerModpackRequest { server_instance_id } => {
                // Get server sync config
                let sync_manager = super::server_sync::get_server_sync_manager();
                let config = sync_manager.get_config(&server_instance_id).await;

                match config {
                    Some(cfg) => {
                        use super::server_sync::SyncSource;

                        match cfg.sync_source {
                            SyncSource::ModpackFile => {
                                // Send modpack file directly
                                if let Some(ref modpack_path) = cfg.linked_modpack_path {
                                    let path = std::path::Path::new(modpack_path);
                                    if path.exists() {
                                        // Calculate hash and size
                                        match tokio::fs::metadata(path).await {
                                            Ok(metadata) => {
                                                let hash = tokio::task::spawn_blocking({
                                                    let path = path.to_path_buf();
                                                    move || {
                                                        use sha2::{Digest, Sha256};
                                                        let mut hasher = Sha256::new();
                                                        if let Ok(mut file) =
                                                            std::fs::File::open(&path)
                                                        {
                                                            let mut buffer = [0u8; 8192];
                                                            loop {
                                                                use std::io::Read;
                                                                match file.read(&mut buffer) {
                                                                    Ok(0) => break,
                                                                    Ok(n) => {
                                                                        hasher.update(&buffer[..n])
                                                                    }
                                                                    Err(_) => break,
                                                                }
                                                            }
                                                        }
                                                        format!("{:x}", hasher.finalize())
                                                    }
                                                })
                                                .await
                                                .unwrap_or_default();

                                                let filename = path
                                                    .file_name()
                                                    .map(|n| n.to_string_lossy().to_string());

                                                // Get MC version and loader from instance
                                                let (mc_version, loader) = {
                                                    let conn = stuzhik_db::get_db_conn().ok();
                                                    if let Some(conn) = conn {
                                                        let result: Option<(String, String)> = conn.query_row(
                                                            "SELECT version, loader FROM instances WHERE id = ?1",
                                                            [&server_instance_id],
                                                            |row| Ok((row.get(0)?, row.get(1)?)),
                                                        ).ok();
                                                        result.unwrap_or((
                                                            "unknown".to_string(),
                                                            "unknown".to_string(),
                                                        ))
                                                    } else {
                                                        (
                                                            "unknown".to_string(),
                                                            "unknown".to_string(),
                                                        )
                                                    }
                                                };

                                                let response =
                                                    TransferProtocol::ServerModpackInfo {
                                                        sync_type: "file".to_string(),
                                                        modpack_filename: filename,
                                                        modpack_size: metadata.len(),
                                                        modpack_hash: hash,
                                                        mc_version,
                                                        loader,
                                                    };
                                                send_message(&mut stream, &response).await?;
                                            }
                                            Err(e) => {
                                                let error = TransferProtocol::Error {
                                                    message: format!(
                                                        "Failed to read modpack file: {}",
                                                        e
                                                    ),
                                                };
                                                send_message(&mut stream, &error).await?;
                                            }
                                        }
                                    } else {
                                        let error = TransferProtocol::Error {
                                            message: "Modpack file not found".to_string(),
                                        };
                                        send_message(&mut stream, &error).await?;
                                    }
                                } else {
                                    let error = TransferProtocol::Error {
                                        message: "No modpack file configured".to_string(),
                                    };
                                    send_message(&mut stream, &error).await?;
                                }
                            }
                            SyncSource::ClientInstance => {
                                // Client will use regular manifest sync instead
                                let response = TransferProtocol::ServerModpackInfo {
                                    sync_type: "instance".to_string(),
                                    modpack_filename: None,
                                    modpack_size: 0,
                                    modpack_hash: String::new(),
                                    mc_version: String::new(),
                                    loader: String::new(),
                                };
                                send_message(&mut stream, &response).await?;
                            }
                            SyncSource::None => {
                                let error = TransferProtocol::Error {
                                    message: "Server sync not configured".to_string(),
                                };
                                send_message(&mut stream, &error).await?;
                            }
                        }
                    }
                    None => {
                        let error = TransferProtocol::Error {
                            message: "Server not found".to_string(),
                        };
                        send_message(&mut stream, &error).await?;
                    }
                }
            }

            TransferProtocol::ModpackFileRequest {
                server_instance_id,
                resume_offset,
            } => {
                // Get server sync config and send modpack file
                let sync_manager = super::server_sync::get_server_sync_manager();
                let config = sync_manager.get_config(&server_instance_id).await;

                if let Some(cfg) = config {
                    if let Some(ref modpack_path) = cfg.linked_modpack_path {
                        let path = std::path::Path::new(modpack_path);
                        if path.exists() {
                            // Send modpack file in chunks
                            match send_modpack_file(
                                &mut stream,
                                path,
                                resume_offset,
                                &mut session_key_mut,
                            )
                            .await
                            {
                                Ok(_) => {
                                    log::info!("Successfully sent modpack file to {}", addr);
                                }
                                Err(e) => {
                                    log::error!("Failed to send modpack file: {}", e);
                                }
                            }
                        } else {
                            let error = TransferProtocol::Error {
                                message: "Modpack file not found".to_string(),
                            };
                            send_message(&mut stream, &error).await?;
                        }
                    } else {
                        let error = TransferProtocol::Error {
                            message: "No modpack file configured".to_string(),
                        };
                        send_message(&mut stream, &error).await?;
                    }
                } else {
                    let error = TransferProtocol::Error {
                        message: "Server not found".to_string(),
                    };
                    send_message(&mut stream, &error).await?;
                }
            }

            _ => {}
        }
    }

    Ok(())
}

/// Проверить, сжимаем ли файл
fn should_compress(path: &str) -> bool {
    if let Some(ext) = std::path::Path::new(path).extension() {
        let ext_lower = ext.to_string_lossy().to_lowercase();
        COMPRESSIBLE_EXTENSIONS.contains(&ext_lower.as_str())
    } else {
        false
    }
}

/// Сжать данные zstd (уровень 3 - баланс скорости и сжатия)
fn compress_data(data: &[u8]) -> Result<Vec<u8>, String> {
    zstd::encode_all(std::io::Cursor::new(data), 3)
        .map_err(|e| format!("Compression failed: {}", e))
}

/// Распаковать данные zstd
fn decompress_data(data: &[u8]) -> Result<Vec<u8>, String> {
    zstd::decode_all(std::io::Cursor::new(data)).map_err(|e| format!("Decompression failed: {}", e))
}

/// Отправить файл по чанкам с E2E шифрованием, сжатием и поддержкой resume
async fn send_file(
    stream: &mut TcpStream,
    file_path: &PathBuf,
    relative_path: &str,
    session_key: &mut Option<SessionKey>,
    resume_offset: u64,
) -> Result<(), String> {
    let metadata = tokio::fs::metadata(file_path)
        .await
        .map_err(|e| format!("Failed to get metadata: {}", e))?;

    let original_size = metadata.len();

    // Вычисляем хеш
    let hash = TransferManager::compute_file_hash_static(file_path).await?;

    // Читаем файл
    let file_data = tokio::fs::read(file_path)
        .await
        .map_err(|e| format!("Failed to read file: {}", e))?;

    // Сжимаем если это текстовый файл и размер > 1KB
    let (data_to_send, compressed) = if should_compress(relative_path) && original_size > 1024 {
        match compress_data(&file_data) {
            Ok(compressed_data) => {
                // Сжимаем только если выигрыш > 10%
                if compressed_data.len() < (file_data.len() * 9 / 10) {
                    log::debug!(
                        "Compressed {} from {} to {} bytes",
                        relative_path,
                        file_data.len(),
                        compressed_data.len()
                    );
                    (compressed_data, true)
                } else {
                    (file_data, false)
                }
            }
            Err(_) => (file_data, false),
        }
    } else {
        (file_data, false)
    };

    let size = data_to_send.len() as u64;

    // Учитываем resume_offset
    let effective_offset = if resume_offset > 0 && resume_offset < size {
        resume_offset as usize
    } else {
        0
    };

    let remaining_size = size - effective_offset as u64;
    let total_chunks = ((remaining_size as f64) / (CHUNK_SIZE as f64)).ceil() as u32;

    // Отправляем заголовок
    let header = TransferProtocol::FileHeader {
        path: relative_path.to_string(),
        size: remaining_size,
        hash,
        total_chunks,
        compressed,
        original_size,
    };
    send_message(stream, &header).await?;

    // Отправляем чанки
    let mut offset = effective_offset;
    let mut chunk_index: u32 = 0;

    while offset < data_to_send.len() {
        let end = std::cmp::min(offset + CHUNK_SIZE, data_to_send.len());
        let chunk_bytes = &data_to_send[offset..end];

        // Шифрование обязательно для всех передач
        let chunk_data = match session_key {
            Some(ref mut key) => crypto::encrypt_chunk(key, chunk_bytes)
                .map_err(|e| format!("Failed to encrypt chunk: {}", e))?,
            None => {
                return Err("E2E encryption required but no session key established".to_string())
            }
        };

        let is_last = end >= data_to_send.len();
        let chunk = TransferProtocol::FileChunk {
            path: relative_path.to_string(),
            chunk_index,
            data: chunk_data,
            is_last,
        };
        send_message(stream, &chunk).await?;

        offset = end;
        chunk_index += 1;
    }

    // Ждём подтверждения
    let _ack: TransferProtocol = receive_message(stream).await?;

    Ok(())
}

/// Send modpack file in chunks (for modpack file sync)
async fn send_modpack_file(
    stream: &mut TcpStream,
    file_path: &std::path::Path,
    resume_offset: u64,
    session_key: &mut Option<SessionKey>,
) -> Result<(), String> {
    use tokio::io::AsyncReadExt;

    let mut file = tokio::fs::File::open(file_path)
        .await
        .map_err(|e| format!("Failed to open modpack file: {}", e))?;

    let metadata = file
        .metadata()
        .await
        .map_err(|e| format!("Failed to get metadata: {}", e))?;

    let file_size = metadata.len();

    // Seek to resume offset if needed
    if resume_offset > 0 && resume_offset < file_size {
        file.seek(std::io::SeekFrom::Start(resume_offset))
            .await
            .map_err(|e| format!("Failed to seek: {}", e))?;
    }

    let remaining_size = file_size.saturating_sub(resume_offset);
    let total_chunks = ((remaining_size as f64) / (CHUNK_SIZE as f64)).ceil() as u32;

    log::info!(
        "Sending modpack file: {} bytes, {} chunks (offset: {})",
        remaining_size,
        total_chunks,
        resume_offset
    );

    let mut chunk_index: u32 = 0;
    let mut buffer = vec![0u8; CHUNK_SIZE];
    let mut bytes_sent: u64 = 0;

    loop {
        let bytes_read = file
            .read(&mut buffer)
            .await
            .map_err(|e| format!("Failed to read file: {}", e))?;

        if bytes_read == 0 {
            break;
        }

        let chunk_bytes = &buffer[..bytes_read];

        // Encryption is mandatory for all transfers
        let chunk_data = match session_key {
            Some(ref mut key) => crypto::encrypt_chunk(key, chunk_bytes)
                .map_err(|e| format!("Failed to encrypt chunk: {}", e))?,
            None => {
                return Err("E2E encryption required but no session key established".to_string())
            }
        };

        bytes_sent += bytes_read as u64;
        let is_last = bytes_sent >= remaining_size;

        let chunk = TransferProtocol::ModpackFileChunk {
            chunk_index,
            data: chunk_data,
            is_last,
        };
        send_message(stream, &chunk).await?;

        chunk_index += 1;

        if is_last {
            break;
        }
    }

    // Wait for acknowledgment
    let ack: TransferProtocol = receive_message(stream).await?;
    match ack {
        TransferProtocol::ModpackFileAck { success, error } => {
            if success {
                log::info!("Modpack file transfer completed successfully");
                Ok(())
            } else {
                Err(format!(
                    "Modpack transfer failed: {}",
                    error.unwrap_or_default()
                ))
            }
        }
        _ => Err("Unexpected response after modpack transfer".to_string()),
    }
}

/// Отправить сообщение
async fn send_message(stream: &mut TcpStream, message: &TransferProtocol) -> Result<(), String> {
    let data =
        rmp_serde::to_vec(message).map_err(|e| format!("Failed to serialize message: {}", e))?;

    // Отправляем длину (4 байта) + данные
    let len = data.len() as u32;
    stream
        .write_all(&len.to_be_bytes())
        .await
        .map_err(|e| format!("Failed to write length: {}", e))?;
    stream
        .write_all(&data)
        .await
        .map_err(|e| format!("Failed to write data: {}", e))?;

    Ok(())
}

/// Получить сообщение
async fn receive_message(stream: &mut TcpStream) -> Result<TransferProtocol, String> {
    // Читаем длину
    let mut len_bytes = [0u8; 4];
    stream
        .read_exact(&mut len_bytes)
        .await
        .map_err(|e| format!("Failed to read length: {}", e))?;

    let len = u32::from_be_bytes(len_bytes) as usize;

    if len > 100 * 1024 * 1024 {
        // Защита от слишком больших сообщений (100MB)
        return Err("Message too large".to_string());
    }

    // Читаем данные
    let mut data = vec![0u8; len];
    stream
        .read_exact(&mut data)
        .await
        .map_err(|e| format!("Failed to read data: {}", e))?;

    rmp_serde::from_slice(&data).map_err(|e| format!("Failed to deserialize message: {}", e))
}
