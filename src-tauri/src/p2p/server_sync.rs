//! Server-P2P Integration Module
//!
//! Provides seamless integration between Minecraft servers and P2P functionality:
//! - Server invites: Generate invite codes/links to share with friends
//! - Quick Join: One-click modpack download + auto-connect to server
//! - Server↔Client instance linking
//! - Watch mode for auto-sync changes to players
//!
//! Flow for players:
//! 1. Server admin generates invite (code: STUZHIK-XXXX-XXXX or link)
//! 2. Player enters code or clicks link
//! 3. App auto-creates client instance with same mods
//! 4. Downloads required files via P2P delta-sync
//! 5. Launches Minecraft and connects to server

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rand::Rng;
use tokio::sync::RwLock;

use super::WatchConfig;

// Global Server Sync Manager instance
static SERVER_SYNC_MANAGER: OnceLock<Arc<ServerSyncManager>> = OnceLock::new();

/// Get the global ServerSyncManager instance
pub fn get_server_sync_manager() -> Arc<ServerSyncManager> {
    SERVER_SYNC_MANAGER
        .get_or_init(|| {
            let data_dir = crate::paths::BASE_DIR
                .get()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| PathBuf::from("."));
            Arc::new(ServerSyncManager::new(data_dir))
        })
        .clone()
}

/// Server visibility setting
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, Default)]
pub enum ServerVisibility {
    /// Server is not visible to anyone (still works with direct invites)
    Invisible,
    /// Only trusted friends can see and join
    FriendsOnly,
    /// Only authorized peers can see and join
    #[default]
    AuthorizedOnly,
    /// Anyone in the network can see, but may need invite to join
    Everyone,
}

/// Sync source type - what to sync to players
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SyncSource {
    /// No sync source configured
    #[default]
    None,
    /// Sync from a client instance (files)
    ClientInstance,
    /// Sync a modpack file (.stzhk) - player auto-installs
    ModpackFile,
}

/// Server sync configuration
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ServerSyncConfig {
    /// Server instance ID
    pub server_instance_id: String,
    /// Sync source type
    #[serde(default)]
    pub sync_source: SyncSource,
    /// Linked client instance ID (if server uses same mods as a client instance)
    pub linked_client_id: Option<String>,
    /// Path to modpack file (.stzhk) for direct modpack sync
    #[serde(default)]
    pub linked_modpack_path: Option<String>,
    /// Whether P2P sync is enabled for this server
    pub p2p_enabled: bool,
    /// Auto-sync on modpack changes (watch mode for admin)
    pub auto_sync: bool,
    /// Server IP for players to connect
    pub server_ip: String,
    /// Server port (default 25565)
    pub server_port: u16,
    /// Server visibility setting
    #[serde(default)]
    pub visibility: ServerVisibility,
    /// Require invite code to join (if false, anyone who can see can join directly)
    #[serde(default = "default_require_invite")]
    pub require_invite: bool,
    /// List of peer IDs authorized to sync
    pub authorized_peers: Vec<String>,
    /// Sync include patterns (globs)
    pub include_patterns: Vec<String>,
    /// Sync exclude patterns (globs)
    pub exclude_patterns: Vec<String>,
}

fn default_require_invite() -> bool {
    true
}

impl Default for ServerSyncConfig {
    fn default() -> Self {
        Self {
            server_instance_id: String::new(),
            sync_source: SyncSource::None,
            linked_client_id: None,
            linked_modpack_path: None,
            p2p_enabled: false,
            auto_sync: false,
            server_ip: "127.0.0.1".to_string(),
            server_port: 25565,
            visibility: ServerVisibility::default(),
            require_invite: true,
            authorized_peers: vec![],
            include_patterns: vec![
                "mods/**/*.jar".to_string(),
                "config/**/*".to_string(),
                "kubejs/**/*".to_string(),
                "resourcepacks/**/*".to_string(),
                "shaderpacks/**/*".to_string(),
            ],
            exclude_patterns: vec![
                "**/*.jar.disabled".to_string(),
                "**/cache/**".to_string(),
                "**/.git/**".to_string(),
                "**/logs/**".to_string(),
                "**/crash-reports/**".to_string(),
                "**/world/**".to_string(),
                "**/server.properties".to_string(),
                "**/whitelist.json".to_string(),
                "**/ops.json".to_string(),
                "**/banned-*.json".to_string(),
            ],
        }
    }
}

/// Server invite - shareable way to join a server
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ServerInvite {
    /// Unique invite ID
    pub id: String,
    /// Short code (e.g., STUZHIK-ABCD-1234)
    pub code: String,
    /// Server instance ID
    pub server_instance_id: String,
    /// Server name (for display)
    pub server_name: String,
    /// Minecraft version
    pub mc_version: String,
    /// Mod loader
    pub loader: String,
    /// Server address for connecting
    pub server_address: String,
    /// Peer ID of the host (for P2P connection)
    pub host_peer_id: String,
    /// When the invite was created
    pub created_at: u64,
    /// When the invite expires (0 = never)
    pub expires_at: u64,
    /// Max uses (0 = unlimited)
    pub max_uses: u32,
    /// Current use count
    pub use_count: u32,
    /// Whether the invite is active
    pub active: bool,
}

impl ServerInvite {
    /// Generate a new invite code
    pub fn generate_code() -> String {
        let mut rng = rand::rng();
        let chars: Vec<char> = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789".chars().collect();

        let part1: String = (0..4)
            .map(|_| chars[rng.random_range(0..chars.len())])
            .collect();
        let part2: String = (0..4)
            .map(|_| chars[rng.random_range(0..chars.len())])
            .collect();

        format!("STUZHIK-{}-{}", part1, part2)
    }

    /// Check if invite is valid (not expired, not maxed out)
    pub fn is_valid(&self) -> bool {
        if !self.active {
            return false;
        }

        // Check expiration
        if self.expires_at > 0 {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            if now > self.expires_at {
                return false;
            }
        }

        // Check max uses
        if self.max_uses > 0 && self.use_count >= self.max_uses {
            return false;
        }

        true
    }

    /// Get time remaining until expiration (in seconds)
    pub fn time_remaining(&self) -> Option<u64> {
        if self.expires_at == 0 {
            return None;
        }

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        if now >= self.expires_at {
            Some(0)
        } else {
            Some(self.expires_at - now)
        }
    }
}

/// Information about a published server (for discovery)
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PublishedServer {
    /// Server instance ID
    pub instance_id: String,
    /// Server name
    pub name: String,
    /// Minecraft version
    pub mc_version: String,
    /// Mod loader type
    pub loader: String,
    /// Server address (IP:Port)
    pub server_address: String,
    /// Modpack manifest hash (for version detection)
    pub manifest_hash: String,
    /// Number of mods
    pub mod_count: usize,
    /// Total size of modpack (bytes)
    pub total_size: u64,
    /// Last update time
    pub updated_at: i64,
    /// Online player count (if available)
    pub online_players: Option<u32>,
    /// Max players (if available)
    pub max_players: Option<u32>,
    /// Server MOTD
    pub motd: Option<String>,
    /// Active invite code (if sharing enabled)
    pub invite_code: Option<String>,
}

/// Quick Join request from a player
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct QuickJoinRequest {
    /// Invite code used
    pub invite_code: String,
    /// Peer ID of the requester
    pub requester_peer_id: String,
    /// Requester's nickname
    pub requester_nickname: String,
    /// Existing client instance to use (or None to create new)
    pub client_instance_id: Option<String>,
    /// Auto-launch after sync
    pub auto_launch: bool,
}

/// Quick Join status for UI updates
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "stage", rename_all = "snake_case")]
pub enum QuickJoinStatus {
    /// Validating invite code
    ValidatingInvite,
    /// Connecting to host peer
    Connecting { host_peer_id: String },
    /// Creating client instance
    CreatingInstance { instance_name: String },
    /// Downloading modpack
    Downloading {
        progress: f32,
        current_file: String,
        files_done: usize,
        files_total: usize,
        bytes_done: u64,
        bytes_total: u64,
    },
    /// Ready to launch
    Ready { client_instance_id: String },
    /// Launching game
    Launching { server_address: String },
    /// Complete
    Complete,
    /// Failed
    Failed { error: String },
}

/// Quick Join result
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct QuickJoinResult {
    pub success: bool,
    /// Client instance ID used/created
    pub client_instance_id: Option<String>,
    /// Error message if failed
    pub error: Option<String>,
    /// Files synced count
    pub files_synced: usize,
    /// Total bytes synced
    pub bytes_synced: u64,
    /// Time taken (ms)
    pub duration_ms: u64,
}

/// Server sync manager - handles all server P2P operations
pub struct ServerSyncManager {
    /// Active server configs
    configs: RwLock<HashMap<String, ServerSyncConfig>>,
    /// Published servers (by server instance ID)
    published_servers: RwLock<HashMap<String, PublishedServer>>,
    /// Active invites (by invite code)
    invites: RwLock<HashMap<String, ServerInvite>>,
    /// Servers discovered from peers (by peer_id:server_instance_id)
    discovered_servers: RwLock<HashMap<String, PublishedServer>>,
    /// Data directory for persistence
    data_dir: PathBuf,
    /// Our peer ID (set when P2P is enabled)
    peer_id: RwLock<String>,
}

impl ServerSyncManager {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            configs: RwLock::new(HashMap::new()),
            published_servers: RwLock::new(HashMap::new()),
            invites: RwLock::new(HashMap::new()),
            discovered_servers: RwLock::new(HashMap::new()),
            data_dir,
            peer_id: RwLock::new(String::new()),
        }
    }

    /// Set our peer ID
    pub async fn set_peer_id(&self, peer_id: &str) {
        *self.peer_id.write().await = peer_id.to_string();
    }

    /// Load configs and invites from disk
    pub async fn load(&self) -> Result<(), String> {
        // Load configs
        let config_path = self.data_dir.join("server_sync_configs.json");
        if tokio::fs::try_exists(&config_path).await.unwrap_or(false) {
            let content = tokio::fs::read_to_string(&config_path)
                .await
                .map_err(|e| e.to_string())?;
            let configs: HashMap<String, ServerSyncConfig> =
                serde_json::from_str(&content).map_err(|e| e.to_string())?;
            *self.configs.write().await = configs;
        }

        // Load invites
        let invite_path = self.data_dir.join("server_invites.json");
        if tokio::fs::try_exists(&invite_path).await.unwrap_or(false) {
            let content = tokio::fs::read_to_string(&invite_path)
                .await
                .map_err(|e| e.to_string())?;
            let invites: HashMap<String, ServerInvite> =
                serde_json::from_str(&content).map_err(|e| e.to_string())?;
            *self.invites.write().await = invites;
        }

        Ok(())
    }

    /// Save configs to disk
    pub async fn save_configs(&self) -> Result<(), String> {
        let path = self.data_dir.join("server_sync_configs.json");
        let configs = self.configs.read().await;
        let content = serde_json::to_string_pretty(&*configs).map_err(|e| e.to_string())?;
        tokio::fs::write(&path, content)
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Save invites to disk
    pub async fn save_invites(&self) -> Result<(), String> {
        let path = self.data_dir.join("server_invites.json");
        let invites = self.invites.read().await;
        let content = serde_json::to_string_pretty(&*invites).map_err(|e| e.to_string())?;
        tokio::fs::write(&path, content)
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    // ==================== Config Management ====================

    /// Set config for a server
    pub async fn set_config(&self, config: ServerSyncConfig) {
        let id = config.server_instance_id.clone();
        self.configs.write().await.insert(id, config);
        let _ = self.save_configs().await;
    }

    /// Get config for a server
    pub async fn get_config(&self, server_instance_id: &str) -> Option<ServerSyncConfig> {
        self.configs.read().await.get(server_instance_id).cloned()
    }

    /// Remove config
    pub async fn remove_config(&self, server_instance_id: &str) {
        self.configs.write().await.remove(server_instance_id);
        let _ = self.save_configs().await;
    }

    /// Get all configs
    pub async fn get_all_configs(&self) -> Vec<ServerSyncConfig> {
        self.configs.read().await.values().cloned().collect()
    }

    /// Link a client instance to a server
    pub async fn link_client_to_server(
        &self,
        server_instance_id: &str,
        client_instance_id: &str,
    ) -> Result<(), String> {
        let mut configs = self.configs.write().await;
        if let Some(config) = configs.get_mut(server_instance_id) {
            config.sync_source = SyncSource::ClientInstance;
            config.linked_client_id = Some(client_instance_id.to_string());
            config.linked_modpack_path = None;
            drop(configs);
            self.save_configs().await?;
            Ok(())
        } else {
            // Create new config if doesn't exist
            drop(configs);
            let config = ServerSyncConfig {
                server_instance_id: server_instance_id.to_string(),
                sync_source: SyncSource::ClientInstance,
                linked_client_id: Some(client_instance_id.to_string()),
                ..Default::default()
            };
            self.set_config(config).await;
            Ok(())
        }
    }

    /// Link a modpack file (.stzhk) to a server
    pub async fn link_modpack_to_server(
        &self,
        server_instance_id: &str,
        modpack_path: &str,
    ) -> Result<(), String> {
        // Verify file exists and is a valid modpack
        if !tokio::fs::try_exists(modpack_path).await.unwrap_or(false) {
            return Err("Modpack file not found".to_string());
        }

        let path = std::path::Path::new(modpack_path);
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if ext != "stzhk" && ext != "mrpack" && ext != "zip" {
            return Err(
                "Invalid modpack file format. Supported: .stzhk, .mrpack, .zip".to_string(),
            );
        }

        let mut configs = self.configs.write().await;
        if let Some(config) = configs.get_mut(server_instance_id) {
            config.sync_source = SyncSource::ModpackFile;
            config.linked_modpack_path = Some(modpack_path.to_string());
            config.linked_client_id = None;
            drop(configs);
            self.save_configs().await?;
            Ok(())
        } else {
            // Create new config if doesn't exist
            drop(configs);
            let config = ServerSyncConfig {
                server_instance_id: server_instance_id.to_string(),
                sync_source: SyncSource::ModpackFile,
                linked_modpack_path: Some(modpack_path.to_string()),
                ..Default::default()
            };
            self.set_config(config).await;
            Ok(())
        }
    }

    /// Unlink any sync source from server
    pub async fn unlink_sync_source(&self, server_instance_id: &str) -> Result<(), String> {
        let mut configs = self.configs.write().await;
        if let Some(config) = configs.get_mut(server_instance_id) {
            config.sync_source = SyncSource::None;
            config.linked_client_id = None;
            config.linked_modpack_path = None;
            drop(configs);
            self.save_configs().await?;
            Ok(())
        } else {
            Err("Server config not found".to_string())
        }
    }

    /// Unlink client from server (legacy - calls unlink_sync_source)
    pub async fn unlink_client(&self, server_instance_id: &str) -> Result<(), String> {
        self.unlink_sync_source(server_instance_id).await
    }

    // ==================== Invite Management ====================

    /// Create a new invite for a server
    pub async fn create_invite(
        &self,
        server_instance_id: &str,
        server_name: &str,
        mc_version: &str,
        loader: &str,
        server_address: &str,
        expires_in: Option<Duration>,
        max_uses: Option<u32>,
    ) -> Result<ServerInvite, String> {
        let peer_id = self.peer_id.read().await.clone();
        if peer_id.is_empty() {
            return Err("P2P not initialized".to_string());
        }

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        let expires_at = expires_in.map(|d| now + d.as_secs()).unwrap_or(0);
        let code = ServerInvite::generate_code();

        let invite = ServerInvite {
            id: uuid::Uuid::new_v4().to_string(),
            code: code.clone(),
            server_instance_id: server_instance_id.to_string(),
            server_name: server_name.to_string(),
            mc_version: mc_version.to_string(),
            loader: loader.to_string(),
            server_address: server_address.to_string(),
            host_peer_id: peer_id,
            created_at: now,
            expires_at,
            max_uses: max_uses.unwrap_or(0),
            use_count: 0,
            active: true,
        };

        self.invites
            .write()
            .await
            .insert(code.clone(), invite.clone());
        self.save_invites().await?;

        log::info!("Created invite {} for server {}", code, server_instance_id);

        Ok(invite)
    }

    /// Get invite by code
    pub async fn get_invite(&self, code: &str) -> Option<ServerInvite> {
        let normalized = code.to_uppercase().replace(" ", "").replace("-", "");
        let formatted = if normalized.starts_with("STUZHIK") {
            let rest = normalized.trim_start_matches("STUZHIK");
            if rest.len() >= 8 {
                format!("STUZHIK-{}-{}", &rest[0..4], &rest[4..8])
            } else {
                return None;
            }
        } else if normalized.len() == 8 {
            format!("STUZHIK-{}-{}", &normalized[0..4], &normalized[4..8])
        } else {
            code.to_string()
        };

        self.invites.read().await.get(&formatted).cloned()
    }

    /// Validate an invite code
    pub async fn validate_invite(&self, code: &str) -> Result<ServerInvite, String> {
        let invite = self
            .get_invite(code)
            .await
            .ok_or_else(|| "Invite not found".to_string())?;

        if !invite.is_valid() {
            if !invite.active {
                return Err("Invite has been deactivated".to_string());
            }
            if invite.max_uses > 0 && invite.use_count >= invite.max_uses {
                return Err("Invite has reached maximum uses".to_string());
            }
            if let Some(0) = invite.time_remaining() {
                return Err("Invite has expired".to_string());
            }
        }

        Ok(invite)
    }

    /// Use an invite (increment use count)
    pub async fn use_invite(&self, code: &str) -> Result<(), String> {
        let mut invites = self.invites.write().await;
        if let Some(invite) = invites.get_mut(code) {
            invite.use_count += 1;
            drop(invites);
            self.save_invites().await?;
            Ok(())
        } else {
            Err("Invite not found".to_string())
        }
    }

    /// Revoke an invite
    pub async fn revoke_invite(&self, code: &str) -> Result<(), String> {
        let mut invites = self.invites.write().await;
        if let Some(invite) = invites.get_mut(code) {
            invite.active = false;
            drop(invites);
            self.save_invites().await?;
            log::info!("Revoked invite {}", code);
            Ok(())
        } else {
            Err("Invite not found".to_string())
        }
    }

    /// Delete an invite
    pub async fn delete_invite(&self, code: &str) -> Result<(), String> {
        self.invites.write().await.remove(code);
        self.save_invites().await?;
        Ok(())
    }

    /// Get all invites for a server
    pub async fn get_server_invites(&self, server_instance_id: &str) -> Vec<ServerInvite> {
        self.invites
            .read()
            .await
            .values()
            .filter(|i| i.server_instance_id == server_instance_id)
            .cloned()
            .collect()
    }

    /// Get all active invites
    pub async fn get_active_invites(&self) -> Vec<ServerInvite> {
        self.invites
            .read()
            .await
            .values()
            .filter(|i| i.is_valid())
            .cloned()
            .collect()
    }

    /// Clean up expired invites
    pub async fn cleanup_expired_invites(&self) {
        let mut invites = self.invites.write().await;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        invites.retain(|_, i| {
            if i.expires_at == 0 {
                true
            } else {
                i.expires_at > now
            }
        });

        drop(invites);
        let _ = self.save_invites().await;
    }

    // ==================== Published Servers ====================

    /// Publish a server for P2P discovery
    pub async fn publish_server(&self, server: PublishedServer) {
        let id = server.instance_id.clone();
        self.published_servers.write().await.insert(id, server);
    }

    /// Unpublish a server
    pub async fn unpublish_server(&self, server_instance_id: &str) {
        self.published_servers
            .write()
            .await
            .remove(server_instance_id);
    }

    /// Get published servers
    pub async fn get_published_servers(&self) -> Vec<PublishedServer> {
        self.published_servers
            .read()
            .await
            .values()
            .cloned()
            .collect()
    }

    /// Update discovered server from peer
    pub async fn update_discovered_server(&self, peer_id: &str, server: PublishedServer) {
        let key = format!("{}:{}", peer_id, server.instance_id);
        self.discovered_servers.write().await.insert(key, server);
    }

    /// Get all discovered servers
    pub async fn get_discovered_servers(&self) -> Vec<(String, PublishedServer)> {
        self.discovered_servers
            .read()
            .await
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    /// Get discovered servers from a specific peer
    pub async fn get_servers_from_peer(&self, peer_id: &str) -> Vec<PublishedServer> {
        self.discovered_servers
            .read()
            .await
            .iter()
            .filter(|(k, _)| k.starts_with(peer_id))
            .map(|(_, v)| v.clone())
            .collect()
    }

    /// Clear discovered servers
    pub async fn clear_discovered_servers(&self) {
        self.discovered_servers.write().await.clear();
    }

    /// Remove discovered servers from a peer
    pub async fn remove_servers_from_peer(&self, peer_id: &str) {
        let mut servers = self.discovered_servers.write().await;
        servers.retain(|k, _| !k.starts_with(peer_id));
    }

    // ==================== Peer Authorization ====================

    /// Authorize a peer to sync with server
    pub async fn authorize_peer(
        &self,
        server_instance_id: &str,
        peer_id: &str,
    ) -> Result<(), String> {
        let mut configs = self.configs.write().await;
        if let Some(config) = configs.get_mut(server_instance_id) {
            if !config.authorized_peers.contains(&peer_id.to_string()) {
                config.authorized_peers.push(peer_id.to_string());
            }
            drop(configs);
            self.save_configs().await?;
            Ok(())
        } else {
            Err("Server config not found".to_string())
        }
    }

    /// Revoke peer authorization
    pub async fn revoke_peer(&self, server_instance_id: &str, peer_id: &str) -> Result<(), String> {
        let mut configs = self.configs.write().await;
        if let Some(config) = configs.get_mut(server_instance_id) {
            config.authorized_peers.retain(|p| p != peer_id);
            drop(configs);
            self.save_configs().await?;
            Ok(())
        } else {
            Err("Server config not found".to_string())
        }
    }

    /// Check if peer is authorized
    pub async fn is_peer_authorized(&self, server_instance_id: &str, peer_id: &str) -> bool {
        if let Some(config) = self.configs.read().await.get(server_instance_id) {
            // If no specific peers are authorized, allow all (public server)
            config.authorized_peers.is_empty()
                || config.authorized_peers.contains(&peer_id.to_string())
        } else {
            false
        }
    }

    // ==================== Watch Mode ====================

    /// Convert server config to watch config for auto-sync
    pub fn config_to_watch_config(
        config: &ServerSyncConfig,
        instance_path: &PathBuf,
    ) -> WatchConfig {
        WatchConfig {
            modpack_name: config.server_instance_id.clone(),
            modpack_path: instance_path.clone(),
            enabled: config.auto_sync,
            debounce_ms: 5000, // 5 second debounce
            ignore_patterns: config.exclude_patterns.clone(),
            watch_folders: vec![
                "mods".to_string(),
                "config".to_string(),
                "kubejs".to_string(),
            ],
            target_peers: config.authorized_peers.clone(),
        }
    }
}

// Note: Tauri commands are defined in lib.rs to avoid duplication

/// Format invite for sharing (returns shareable text with code)
pub fn format_invite_for_sharing(invite: &ServerInvite) -> String {
    let mut text = format!("🎮 Присоединяйся к серверу {}!\n\n", invite.server_name);
    text.push_str(&format!(
        "📦 Версия: {} ({})\n",
        invite.mc_version, invite.loader
    ));
    text.push_str(&format!("🔗 Адрес: {}\n\n", invite.server_address));
    text.push_str(&format!("📋 Код приглашения: {}\n\n", invite.code));
    text.push_str("Введи код в Stuzhik → Присоединиться к серверу");

    if let Some(remaining) = invite.time_remaining() {
        if remaining > 0 {
            let hours = remaining / 3600;
            let minutes = (remaining % 3600) / 60;
            if hours > 0 {
                text.push_str(&format!("\n⏰ Действует ещё: {}ч {}м", hours, minutes));
            } else {
                text.push_str(&format!("\n⏰ Действует ещё: {}м", minutes));
            }
        }
    }

    text
}
