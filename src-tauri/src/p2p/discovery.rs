//! UDP Broadcast Discovery для поиска других пользователей Stuzhik в локальной сети
//!
//! Работает через UDP broadcast на порту 19847.
//! Совместимо с VPN типа Radmin VPN, ZeroTier, Tailscale.

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::UdpSocket;
use tokio::sync::RwLock;
use tokio::time::interval;
use tokio_util::sync::CancellationToken;

use super::protocol::{*, generate_peer_id, generate_short_code};
use super::settings::{ConnectSettings, Visibility};

/// Интервал отправки broadcast (секунды)
const BROADCAST_INTERVAL_SECS: u64 = 5;

/// Время жизни пира без ответа (секунды)
const PEER_TIMEOUT_SECS: u64 = 30;

/// Размер буфера для UDP пакетов
const UDP_BUFFER_SIZE: usize = 4096;

/// Discovery сервис для поиска пиров в локальной сети
pub struct Discovery {
    /// Настройки
    settings: ConnectSettings,
    /// ID текущего пира
    peer_id: String,
    /// Короткий код для подключения
    short_code: String,
    /// Найденные пиры
    peers: Arc<RwLock<HashMap<String, PeerInfo>>>,
    /// Токен отмены
    cancel_token: CancellationToken,
    /// Флаг работы
    running: Arc<RwLock<bool>>,
    /// Фактический TCP порт (может отличаться от discovery_port + 1)
    actual_tcp_port: Arc<RwLock<u16>>,
}

impl Discovery {
    /// Создать новый Discovery сервис
    pub fn new(settings: ConnectSettings) -> Self {
        let peer_id = generate_peer_id();
        let short_code = generate_short_code();
        let default_tcp_port = settings.discovery_port + super::server::TCP_PORT_OFFSET;

        log::info!("Generated short code: {}", short_code);

        Self {
            settings,
            peer_id,
            short_code,
            peers: Arc::new(RwLock::new(HashMap::new())),
            cancel_token: CancellationToken::new(),
            running: Arc::new(RwLock::new(false)),
            actual_tcp_port: Arc::new(RwLock::new(default_tcp_port)),
        }
    }

    /// Установить фактический TCP порт (если отличается от стандартного)
    pub async fn set_tcp_port(&self, port: u16) {
        *self.actual_tcp_port.write().await = port;
        log::debug!("Discovery: TCP port set to {}", port);
    }

    /// Получить фактический TCP порт
    pub async fn get_tcp_port(&self) -> u16 {
        *self.actual_tcp_port.read().await
    }

    /// Получить короткий код для подключения
    pub fn get_short_code(&self) -> &str {
        &self.short_code
    }

    /// Получить ID пира
    pub fn get_peer_id(&self) -> &str {
        &self.peer_id
    }

    /// Запустить discovery
    pub async fn start(&mut self) -> Result<(), String> {
        // Проверяем что не запущен
        {
            let running = self.running.read().await;
            if *running {
                return Ok(());
            }
        }

        // Проверяем видимость
        if self.settings.visibility == Visibility::Invisible {
            log::info!("P2P Discovery: visibility is Invisible, not starting broadcast");
            return Ok(());
        }

        let base_port = self.settings.discovery_port;

        // Пробуем порты: основной, затем +10, +20, +30
        let ports_to_try = [base_port, base_port + 10, base_port + 20, base_port + 30];
        let mut socket = None;
        let mut bound_port = base_port;

        for port in ports_to_try {
            match UdpSocket::bind(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, port)).await {
                Ok(s) => {
                    socket = Some(s);
                    bound_port = port;
                    if port != base_port {
                        log::warn!(
                            "UDP port {} was busy, using alternative port {}",
                            base_port, port
                        );
                    }
                    break;
                }
                Err(e) => {
                    log::debug!("Failed to bind UDP socket on port {}: {}", port, e);
                    continue;
                }
            }
        }

        let socket = socket.ok_or_else(|| {
            format!(
                "Failed to bind UDP socket: all ports busy ({}, {}, {}, {})",
                ports_to_try[0], ports_to_try[1], ports_to_try[2], ports_to_try[3]
            )
        })?;

        // Разрешаем broadcast
        socket
            .set_broadcast(true)
            .map_err(|e| format!("Failed to enable broadcast: {}", e))?;

        let socket = Arc::new(socket);

        // Создаём новый токен отмены
        self.cancel_token = CancellationToken::new();
        *self.running.write().await = true;

        log::info!("P2P Discovery started on port {}", bound_port);

        // Запускаем задачу отправки broadcast
        {
            let socket = socket.clone();
            let peer_id = self.peer_id.clone();
            let settings = self.settings.clone();
            let cancel_token = self.cancel_token.clone();
            let actual_tcp_port = self.actual_tcp_port.clone();

            tokio::spawn(async move {
                let mut interval = interval(Duration::from_secs(BROADCAST_INTERVAL_SECS));

                loop {
                    tokio::select! {
                        _ = interval.tick() => {
                            let tcp_port = *actual_tcp_port.read().await;
                            if let Err(e) = send_discovery_broadcast(&socket, &peer_id, &settings, tcp_port).await {
                                log::warn!("Failed to send discovery broadcast: {}", e);
                            }
                        }
                        _ = cancel_token.cancelled() => {
                            log::debug!("Discovery broadcast task stopped");
                            break;
                        }
                    }
                }
            });
        }

        // Запускаем задачу приёма ответов
        {
            let socket = socket.clone();
            let peers = self.peers.clone();
            let peer_id = self.peer_id.clone();
            let short_code = self.short_code.clone();
            let settings = self.settings.clone();
            let cancel_token = self.cancel_token.clone();
            let actual_tcp_port = self.actual_tcp_port.clone();

            tokio::spawn(async move {
                let mut buf = vec![0u8; UDP_BUFFER_SIZE];

                loop {
                    tokio::select! {
                        result = socket.recv_from(&mut buf) => {
                            match result {
                                Ok((len, addr)) => {
                                    let tcp_port = *actual_tcp_port.read().await;
                                    if let Err(e) = handle_incoming_message(
                                        &buf[..len],
                                        addr,
                                        &peers,
                                        &peer_id,
                                        &short_code,
                                        &settings,
                                        &socket,
                                        tcp_port,
                                    ).await {
                                        log::debug!("Failed to handle incoming message: {}", e);
                                    }
                                }
                                Err(e) => {
                                    log::warn!("UDP receive error: {}", e);
                                }
                            }
                        }
                        _ = cancel_token.cancelled() => {
                            log::debug!("Discovery receive task stopped");
                            break;
                        }
                    }
                }
            });
        }

        // Запускаем задачу очистки устаревших пиров
        {
            let peers = self.peers.clone();
            let cancel_token = self.cancel_token.clone();

            tokio::spawn(async move {
                let mut interval = interval(Duration::from_secs(10));

                loop {
                    tokio::select! {
                        _ = interval.tick() => {
                            cleanup_stale_peers(&peers).await;
                        }
                        _ = cancel_token.cancelled() => {
                            break;
                        }
                    }
                }
            });
        }

        Ok(())
    }

    /// Остановить discovery
    pub async fn stop(&self) {
        self.cancel_token.cancel();
        *self.running.write().await = false;
        self.peers.write().await.clear();
        log::info!("P2P Discovery stopped");
    }

    /// Получить список найденных пиров
    pub async fn get_peers(&self) -> Vec<PeerInfo> {
        self.peers.read().await.values().cloned().collect()
    }

    /// Проверить работает ли discovery
    pub async fn is_running(&self) -> bool {
        *self.running.read().await
    }

    /// Запросить модпак у пира
    /// Примечание: Фактическая передача модпака выполняется через ConnectService::request_modpack_sync()
    /// который использует TCP TransferServer для delta-sync
    pub async fn request_modpack(&self, peer: &PeerInfo, modpack_name: &str) -> Result<(), String> {
        if !*self.running.read().await {
            return Err("Discovery not running".to_string());
        }

        log::info!(
            "Modpack request initiated: '{}' from peer {} ({}:{}). Use ConnectService::request_modpack_sync() for actual transfer.",
            modpack_name,
            peer.id,
            peer.address,
            peer.port
        );

        // Фактическая передача выполняется через TCP TransferServer в server.rs
        // Этот метод только для совместимости API
        Ok(())
    }

    /// Подключиться к пиру по короткому коду
    pub async fn connect_by_code(&self, code: &str) -> Result<PeerInfo, String> {
        if !*self.running.read().await {
            return Err("Discovery not running".to_string());
        }

        let normalized_code = normalize_short_code(code);
        log::info!("Attempting to connect by code: {}", normalized_code);

        // Создаём сообщение запроса подключения по коду
        let msg = Message::ConnectByCode {
            code: normalized_code.clone(),
            requester_id: self.peer_id.clone(),
            requester_nickname: if self.settings.show_nickname {
                Some(self.settings.nickname.clone())
            } else {
                None
            },
        };

        let data = serialize_message(&msg)?;

        // Отправляем broadcast - все пиры в сети проверят свой код
        let broadcast_addr = SocketAddrV4::new(Ipv4Addr::BROADCAST, self.settings.discovery_port);

        // Создаём временный сокет для отправки
        let socket = UdpSocket::bind("0.0.0.0:0").await
            .map_err(|e| format!("Failed to create socket: {}", e))?;
        socket.set_broadcast(true)
            .map_err(|e| format!("Failed to enable broadcast: {}", e))?;

        socket.send_to(&data, broadcast_addr).await
            .map_err(|e| format!("Failed to send connect request: {}", e))?;

        log::debug!("Sent connect by code request for {}", normalized_code);

        // Ждём ответ (timeout 5 секунд)
        let mut buf = vec![0u8; UDP_BUFFER_SIZE];
        let timeout = tokio::time::timeout(
            Duration::from_secs(5),
            socket.recv_from(&mut buf)
        ).await;

        match timeout {
            Ok(Ok((len, _addr))) => {
                let response = deserialize_message(&buf[..len])?;
                match response {
                    Message::ConnectByCodeResponse { code: resp_code, success, peer_info, error } => {
                        if resp_code != normalized_code {
                            return Err("Response code mismatch".to_string());
                        }
                        if success {
                            if let Some(peer) = peer_info {
                                // Добавляем пира в список
                                self.peers.write().await.insert(peer.id.clone(), peer.clone());
                                log::info!("Connected to peer by code: {:?}", peer.nickname);
                                return Ok(peer);
                            }
                            return Err("Success but no peer info".to_string());
                        } else {
                            return Err(error.unwrap_or_else(|| "Connection refused".to_string()));
                        }
                    }
                    _ => return Err("Unexpected response type".to_string()),
                }
            }
            Ok(Err(e)) => Err(format!("Failed to receive response: {}", e)),
            Err(_) => Err("Connection timeout - no peer with this code found".to_string()),
        }
    }

    /// Получить настройки
    pub fn get_settings(&self) -> &ConnectSettings {
        &self.settings
    }
}

/// Отправить broadcast для обнаружения пиров
async fn send_discovery_broadcast(
    socket: &UdpSocket,
    peer_id: &str,
    settings: &ConnectSettings,
    tcp_port: u16,
) -> Result<(), String> {
    let msg = Message::Discovery(DiscoveryMessage {
        sender_id: peer_id.to_string(),
        protocol_version: PROTOCOL_VERSION,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        listen_port: tcp_port,
    });

    let data = serialize_message(&msg)?;

    // Отправляем на broadcast адрес
    let broadcast_addr = SocketAddrV4::new(Ipv4Addr::BROADCAST, settings.discovery_port);

    socket
        .send_to(&data, broadcast_addr)
        .await
        .map_err(|e| format!("Failed to send broadcast: {}", e))?;

    log::trace!("Sent discovery broadcast");

    Ok(())
}

/// Обработать входящее сообщение
async fn handle_incoming_message(
    data: &[u8],
    addr: SocketAddr,
    peers: &RwLock<HashMap<String, PeerInfo>>,
    our_peer_id: &str,
    our_short_code: &str,
    settings: &ConnectSettings,
    socket: &UdpSocket,
    tcp_port: u16,
) -> Result<(), String> {
    let msg = deserialize_message(data)?;

    match msg {
        Message::Discovery(discovery) => {
            // Игнорируем свои собственные broadcast
            if discovery.sender_id == our_peer_id {
                return Ok(());
            }

            log::debug!("Received discovery from {} at {}", discovery.sender_id, addr);

            // Если мы видимы, отправляем ответ
            if settings.visibility != Visibility::Invisible {
                let response = Message::DiscoveryResponse(DiscoveryResponseMessage {
                    peer_id: our_peer_id.to_string(),
                    nickname: if settings.show_nickname {
                        Some(settings.nickname.clone())
                    } else {
                        None
                    },
                    app_version: env!("CARGO_PKG_VERSION").to_string(),
                    status: PeerStatus::Online,
                    listen_port: tcp_port,
                });

                let response_data = serialize_message(&response)?;

                // Отправляем напрямую отправителю
                let response_addr = SocketAddrV4::new(
                    match addr {
                        SocketAddr::V4(v4) => *v4.ip(),
                        SocketAddr::V6(_) => return Ok(()), // IPv6 не поддерживаем пока
                    },
                    discovery.listen_port,
                );

                socket
                    .send_to(&response_data, response_addr)
                    .await
                    .map_err(|e| format!("Failed to send discovery response: {}", e))?;
            }
        }

        Message::DiscoveryResponse(response) => {
            // Игнорируем свои собственные ответы
            if response.peer_id == our_peer_id {
                return Ok(());
            }

            log::debug!(
                "Received discovery response from {} ({:?})",
                response.peer_id,
                response.nickname
            );

            // Проверяем не заблокирован ли пир
            if settings.blocked_peers.contains(&response.peer_id) {
                log::debug!("Ignoring blocked peer: {}", response.peer_id);
                return Ok(());
            }

            // Добавляем/обновляем пира
            let peer_info = PeerInfo {
                id: response.peer_id.clone(),
                nickname: response.nickname,
                address: addr.ip().to_string(),
                port: response.listen_port,
                app_version: response.app_version,
                last_seen: chrono::Utc::now().to_rfc3339(),
                status: response.status,
                modpacks: None,
                current_server: None,
            };

            peers.write().await.insert(response.peer_id, peer_info);
        }

        Message::Ping { timestamp } => {
            let pong = Message::Pong {
                timestamp,
                peer_id: our_peer_id.to_string(),
            };

            let pong_data = serialize_message(&pong)?;
            socket.send_to(&pong_data, addr).await.ok();
        }

        Message::ConnectByCode { code, requester_id, requester_nickname } => {
            // Игнорируем свои собственные запросы
            if requester_id == our_peer_id {
                return Ok(());
            }

            log::debug!("Received connect by code request: {} from {}", code, requester_id);

            // Проверяем совпадает ли код
            let normalized_code = normalize_short_code(&code);
            if normalized_code == our_short_code {
                log::info!("Short code match! Responding to {}", requester_id);

                // Проверяем не заблокирован ли пир
                if settings.blocked_peers.contains(&requester_id) {
                    let response = Message::ConnectByCodeResponse {
                        code: normalized_code,
                        success: false,
                        peer_info: None,
                        error: Some("Connection blocked".to_string()),
                    };
                    let response_data = serialize_message(&response)?;
                    socket.send_to(&response_data, addr).await.ok();
                    return Ok(());
                }

                // Создаём информацию о себе
                let our_info = PeerInfo {
                    id: our_peer_id.to_string(),
                    nickname: if settings.show_nickname {
                        Some(settings.nickname.clone())
                    } else {
                        None
                    },
                    address: addr.ip().to_string(), // Будет перезаписан на стороне получателя
                    port: tcp_port,
                    app_version: env!("CARGO_PKG_VERSION").to_string(),
                    last_seen: chrono::Utc::now().to_rfc3339(),
                    status: PeerStatus::Online,
                    modpacks: None,
                    current_server: None,
                };

                // Также добавляем запрашивающего в наш список пиров
                let requester_info = PeerInfo {
                    id: requester_id.clone(),
                    nickname: requester_nickname,
                    address: addr.ip().to_string(),
                    port: match addr {
                        SocketAddr::V4(v4) => v4.port(),
                        SocketAddr::V6(v6) => v6.port(),
                    },
                    app_version: String::new(),
                    last_seen: chrono::Utc::now().to_rfc3339(),
                    status: PeerStatus::Online,
                    modpacks: None,
                    current_server: None,
                };
                peers.write().await.insert(requester_id, requester_info);

                // Отправляем успешный ответ
                let response = Message::ConnectByCodeResponse {
                    code: normalized_code,
                    success: true,
                    peer_info: Some(our_info),
                    error: None,
                };
                let response_data = serialize_message(&response)?;
                socket.send_to(&response_data, addr).await
                    .map_err(|e| format!("Failed to send connect response: {}", e))?;
            }
            // Если код не совпадает, просто игнорируем (не отвечаем)
        }

        _ => {}
    }

    Ok(())
}

/// Очистка устаревших пиров
async fn cleanup_stale_peers(peers: &RwLock<HashMap<String, PeerInfo>>) {
    let now = chrono::Utc::now();
    let timeout = chrono::Duration::seconds(PEER_TIMEOUT_SECS as i64);

    let mut peers_guard = peers.write().await;
    peers_guard.retain(|_, peer| {
        if let Ok(last_seen) = chrono::DateTime::parse_from_rfc3339(&peer.last_seen) {
            let age = now.signed_duration_since(last_seen.with_timezone(&chrono::Utc));
            age < timeout
        } else {
            false
        }
    });
}
