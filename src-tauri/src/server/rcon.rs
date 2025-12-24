//! RCON (Remote Console) client for Minecraft servers
//!
//! Implementation of the Source RCON protocol used by Minecraft servers.
//! Allows sending commands and receiving responses remotely.

use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::Mutex;

use super::{ServerError, ServerResult};

/// RCON packet types
#[derive(Debug, Clone, Copy, PartialEq)]
#[repr(i32)]
pub enum PacketType {
    /// Command response
    Response = 0,
    /// Command request
    Command = 2,
    /// Login request
    Login = 3,
}

impl From<i32> for PacketType {
    fn from(value: i32) -> Self {
        match value {
            0 => PacketType::Response,
            2 => PacketType::Command,
            3 => PacketType::Login,
            _ => PacketType::Response,
        }
    }
}

/// RCON packet structure
#[derive(Debug, Clone)]
struct RconPacket {
    id: i32,
    packet_type: PacketType,
    body: String,
}

impl RconPacket {
    fn new(id: i32, packet_type: PacketType, body: impl Into<String>) -> Self {
        Self {
            id,
            packet_type,
            body: body.into(),
        }
    }

    /// Serialize packet to bytes
    fn to_bytes(&self) -> Vec<u8> {
        let body_bytes = self.body.as_bytes();
        let length = 4 + 4 + body_bytes.len() + 2; // id + type + body + null terminators

        let mut data = Vec::with_capacity(4 + length);
        data.extend_from_slice(&(length as i32).to_le_bytes());
        data.extend_from_slice(&self.id.to_le_bytes());
        data.extend_from_slice(&(self.packet_type as i32).to_le_bytes());
        data.extend_from_slice(body_bytes);
        data.push(0); // Body null terminator
        data.push(0); // Padding null terminator

        data
    }

    /// Parse packet from bytes
    fn from_bytes(data: &[u8]) -> Option<Self> {
        if data.len() < 14 {
            return None;
        }

        let id = i32::from_le_bytes([data[0], data[1], data[2], data[3]]);
        let packet_type = i32::from_le_bytes([data[4], data[5], data[6], data[7]]);
        let body_end = data.len().saturating_sub(2);
        let body = String::from_utf8_lossy(&data[8..body_end]).to_string();

        Some(Self {
            id,
            packet_type: PacketType::from(packet_type),
            body,
        })
    }
}

/// RCON client for communicating with Minecraft servers
#[derive(Debug)]
pub struct RconClient {
    stream: Arc<Mutex<TcpStream>>,
    request_id: Arc<Mutex<i32>>,
}

impl RconClient {
    /// Connect to RCON server
    pub async fn connect(host: &str, port: u16, password: &str) -> ServerResult<Self> {
        let addr = format!("{}:{}", host, port);

        let stream = TcpStream::connect(&addr)
            .await
            .map_err(|e| ServerError::RconError(format!("Failed to connect to {}: {}", addr, e)))?;

        let client = Self {
            stream: Arc::new(Mutex::new(stream)),
            request_id: Arc::new(Mutex::new(0)),
        };

        // Authenticate
        client.authenticate(password).await?;

        Ok(client)
    }

    /// Authenticate with the RCON server
    async fn authenticate(&self, password: &str) -> ServerResult<()> {
        let id = self.next_id().await;
        let packet = RconPacket::new(id, PacketType::Login, password);

        let response = self.send_packet(packet).await?;

        if response.id == -1 {
            return Err(ServerError::RconError("Authentication failed".to_string()));
        }

        Ok(())
    }

    /// Send a command to the server
    pub async fn command(&self, cmd: &str) -> ServerResult<String> {
        let id = self.next_id().await;
        let packet = RconPacket::new(id, PacketType::Command, cmd);

        let response = self.send_packet(packet).await?;
        Ok(response.body)
    }

    /// Send packet and receive response
    async fn send_packet(&self, packet: RconPacket) -> ServerResult<RconPacket> {
        let mut stream = self.stream.lock().await;

        // Send packet
        let data = packet.to_bytes();
        stream.write_all(&data).await.map_err(|e| {
            ServerError::RconError(format!("Failed to send packet: {}", e))
        })?;

        // Read response length
        let mut length_buf = [0u8; 4];
        stream.read_exact(&mut length_buf).await.map_err(|e| {
            ServerError::RconError(format!("Failed to read response length: {}", e))
        })?;
        let length = i32::from_le_bytes(length_buf) as usize;

        if length > 4096 {
            return Err(ServerError::RconError(format!(
                "Response too large: {} bytes",
                length
            )));
        }

        // Read response body
        let mut body_buf = vec![0u8; length];
        stream.read_exact(&mut body_buf).await.map_err(|e| {
            ServerError::RconError(format!("Failed to read response body: {}", e))
        })?;

        RconPacket::from_bytes(&body_buf).ok_or_else(|| {
            ServerError::RconError("Failed to parse response packet".to_string())
        })
    }

    /// Get next request ID
    async fn next_id(&self) -> i32 {
        let mut id = self.request_id.lock().await;
        *id = id.wrapping_add(1);
        *id
    }

    /// Get player list
    pub async fn list_players(&self) -> ServerResult<Vec<String>> {
        let response = self.command("list").await?;
        // Parse "There are X of a max of Y players online: player1, player2, ..."
        let players = if let Some(colon_pos) = response.find(':') {
            response[colon_pos + 1..]
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        } else {
            Vec::new()
        };
        Ok(players)
    }

    /// Get TPS (requires mod like Spark or Forge/Fabric built-in)
    pub async fn get_tps(&self) -> ServerResult<Option<f64>> {
        // Try different TPS commands based on what's available
        // Forge/NeoForge
        if let Ok(response) = self.command("forge tps").await {
            if let Some(tps) = parse_tps_from_response(&response) {
                return Ok(Some(tps));
            }
        }

        // Spark plugin
        if let Ok(response) = self.command("spark tps").await {
            if let Some(tps) = parse_tps_from_response(&response) {
                return Ok(Some(tps));
            }
        }

        // Paper/Spigot
        if let Ok(response) = self.command("tps").await {
            if let Some(tps) = parse_tps_from_response(&response) {
                return Ok(Some(tps));
            }
        }

        Ok(None)
    }

    /// Kick a player
    pub async fn kick(&self, player: &str, reason: Option<&str>) -> ServerResult<String> {
        let cmd = match reason {
            Some(r) => format!("kick {} {}", player, r),
            None => format!("kick {}", player),
        };
        self.command(&cmd).await
    }

    /// Ban a player
    pub async fn ban(&self, player: &str, reason: Option<&str>) -> ServerResult<String> {
        let cmd = match reason {
            Some(r) => format!("ban {} {}", player, r),
            None => format!("ban {}", player),
        };
        self.command(&cmd).await
    }

    /// Pardon (unban) a player
    pub async fn pardon(&self, player: &str) -> ServerResult<String> {
        self.command(&format!("pardon {}", player)).await
    }

    /// Op a player
    pub async fn op(&self, player: &str) -> ServerResult<String> {
        self.command(&format!("op {}", player)).await
    }

    /// Deop a player
    pub async fn deop(&self, player: &str) -> ServerResult<String> {
        self.command(&format!("deop {}", player)).await
    }

    /// Whitelist add
    pub async fn whitelist_add(&self, player: &str) -> ServerResult<String> {
        self.command(&format!("whitelist add {}", player)).await
    }

    /// Whitelist remove
    pub async fn whitelist_remove(&self, player: &str) -> ServerResult<String> {
        self.command(&format!("whitelist remove {}", player)).await
    }

    /// Whitelist on/off
    pub async fn whitelist_toggle(&self, enabled: bool) -> ServerResult<String> {
        self.command(if enabled { "whitelist on" } else { "whitelist off" }).await
    }

    /// Say message to all players
    pub async fn say(&self, message: &str) -> ServerResult<String> {
        self.command(&format!("say {}", message)).await
    }

    /// Stop the server gracefully
    pub async fn stop(&self) -> ServerResult<String> {
        self.command("stop").await
    }

    /// Save the world
    pub async fn save_all(&self) -> ServerResult<String> {
        self.command("save-all").await
    }
}

/// Parse TPS value from various command outputs
fn parse_tps_from_response(response: &str) -> Option<f64> {
    // Common patterns:
    // "TPS: 20.0" or "TPS: *20.0"
    // "Overall: 20.0"
    // "20.0, 20.0, 20.0"
    // "§6TPS from last 1m, 5m, 15m: §a*20.0, §a*20.0, §a*20.0"

    // Remove Minecraft color codes
    let clean = response
        .replace("§", "")
        .chars()
        .filter(|c| !c.is_ascii_lowercase() || *c == '.' || *c == ' ' || *c == ':' || *c == ',')
        .collect::<String>();

    // Try to find a decimal number between 0 and 20
    for word in clean.split_whitespace() {
        let word = word.trim_matches(|c: char| !c.is_numeric() && c != '.');
        if let Ok(tps) = word.parse::<f64>() {
            if (0.0..=20.0).contains(&tps) {
                return Some(tps);
            }
        }
    }

    None
}

/// Connection state for an RCON client
#[derive(Debug, Clone, serde::Serialize)]
pub struct RconState {
    pub connected: bool,
    pub host: String,
    pub port: u16,
}

// Tauri commands
use std::collections::HashMap;
use std::sync::LazyLock;
use tokio::sync::RwLock;

/// Global RCON connections (pub for use in console.rs)
pub static RCON_CONNECTIONS: LazyLock<RwLock<HashMap<String, Arc<RconClient>>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

#[tauri::command]
pub async fn rcon_connect(
    instance_id: String,
    host: String,
    port: u16,
    password: String,
) -> Result<(), String> {
    let client = RconClient::connect(&host, port, &password)
        .await
        .map_err(|e| e.to_string())?;

    let mut connections = RCON_CONNECTIONS.write().await;
    connections.insert(instance_id, Arc::new(client));

    Ok(())
}

#[tauri::command]
pub async fn rcon_disconnect(instance_id: String) -> Result<(), String> {
    let mut connections = RCON_CONNECTIONS.write().await;
    connections.remove(&instance_id);
    Ok(())
}

#[tauri::command]
pub async fn rcon_command(instance_id: String, command: String) -> Result<String, String> {
    let connections = RCON_CONNECTIONS.read().await;
    let client = connections
        .get(&instance_id)
        .ok_or_else(|| "RCON not connected".to_string())?;

    client.command(&command).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn rcon_list_players(instance_id: String) -> Result<Vec<String>, String> {
    let connections = RCON_CONNECTIONS.read().await;
    let client = connections
        .get(&instance_id)
        .ok_or_else(|| "RCON not connected".to_string())?;

    client.list_players().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn rcon_get_tps(instance_id: String) -> Result<Option<f64>, String> {
    let connections = RCON_CONNECTIONS.read().await;
    let client = connections
        .get(&instance_id)
        .ok_or_else(|| "RCON not connected".to_string())?;

    client.get_tps().await.map_err(|e| e.to_string())
}

/// Check if RCON is connected for an instance
#[tauri::command]
pub async fn is_rcon_connected(instance_id: String) -> bool {
    let connections = RCON_CONNECTIONS.read().await;
    connections.contains_key(&instance_id)
}

/// RCON configuration for an instance
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RconConfig {
    pub enabled: bool,
    pub port: u16,
    pub password: String,
}

/// Get RCON configuration from server.properties
#[tauri::command]
pub async fn get_rcon_config(instance_id: String) -> Result<RconConfig, String> {
    let instances_dir = crate::paths::instances_dir();
    let props_path = instances_dir.join(&instance_id).join("server.properties");

    let props = super::properties::ServerProperties::load(&props_path)
        .await
        .unwrap_or_else(|_| super::properties::ServerProperties::default_properties());

    Ok(RconConfig {
        enabled: props.rcon_enabled(),
        port: props.rcon_port(),
        password: props.rcon_password().cloned().unwrap_or_default(),
    })
}

/// Auto-connect to RCON if enabled (called when server is detected as ready)
/// Retries up to 3 times with exponential backoff (1s, 2s, 4s)
pub async fn try_auto_connect(instance_id: &str) -> bool {
    // Check if already connected
    {
        let connections = RCON_CONNECTIONS.read().await;
        if connections.contains_key(instance_id) {
            return true;
        }
    }

    // Get RCON config
    let instances_dir = crate::paths::instances_dir();
    let props_path = instances_dir.join(instance_id).join("server.properties");

    let props = match super::properties::ServerProperties::load(&props_path).await {
        Ok(p) => p,
        Err(_) => return false,
    };

    if !props.rcon_enabled() {
        log::debug!("RCON not enabled for {}", instance_id);
        return false;
    }

    let password = match props.rcon_password() {
        Some(p) if !p.is_empty() => p.clone(),
        _ => {
            log::warn!("RCON enabled but no password set for {}", instance_id);
            return false;
        }
    };

    let port = props.rcon_port();

    // Try to connect with retries (exponential backoff: 1s, 2s, 4s)
    const MAX_RETRIES: u32 = 3;
    let mut delay_secs = 1u64;

    for attempt in 1..=MAX_RETRIES {
        log::info!(
            "Attempting RCON auto-connect for {} on port {} (attempt {}/{})",
            instance_id, port, attempt, MAX_RETRIES
        );

        match RconClient::connect("127.0.0.1", port, &password).await {
            Ok(client) => {
                let mut connections = RCON_CONNECTIONS.write().await;
                connections.insert(instance_id.to_string(), Arc::new(client));
                log::info!("RCON auto-connected for {} after {} attempt(s)", instance_id, attempt);
                return true;
            }
            Err(e) => {
                if attempt < MAX_RETRIES {
                    log::debug!(
                        "RCON connect attempt {} failed for {}: {}, retrying in {}s...",
                        attempt, instance_id, e, delay_secs
                    );
                    tokio::time::sleep(std::time::Duration::from_secs(delay_secs)).await;
                    delay_secs *= 2; // Exponential backoff
                } else {
                    log::warn!(
                        "RCON auto-connect failed for {} after {} attempts: {}",
                        instance_id, MAX_RETRIES, e
                    );
                }
            }
        }
    }

    false
}

/// Try to reconnect RCON if disconnected
/// Returns true if reconnected successfully
pub async fn try_reconnect(instance_id: &str) -> bool {
    // First disconnect if there's a stale connection
    {
        let mut connections = RCON_CONNECTIONS.write().await;
        connections.remove(instance_id);
    }

    // Then try to connect again
    try_auto_connect(instance_id).await
}

/// Disconnect RCON when server stops
pub async fn auto_disconnect(instance_id: &str) {
    let mut connections = RCON_CONNECTIONS.write().await;
    if connections.remove(instance_id).is_some() {
        log::info!("RCON auto-disconnected for {}", instance_id);
    }
}
