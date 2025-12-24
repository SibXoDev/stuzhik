//! Player management for Minecraft servers
//!
//! Handles whitelist, operators (ops), and banned players.
//! Minecraft stores these in JSON files: whitelist.json, ops.json, banned-players.json, banned-ips.json

use std::path::Path;
use serde::{Deserialize, Serialize};
use tokio::fs;

use super::{ServerError, ServerResult};

/// Whitelist entry
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhitelistEntry {
    pub uuid: String,
    pub name: String,
}

/// Operator entry with permission level
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpEntry {
    pub uuid: String,
    pub name: String,
    pub level: u8,
    #[serde(default = "default_bypass")]
    #[serde(rename = "bypassesPlayerLimit")]
    pub bypasses_player_limit: bool,
}

fn default_bypass() -> bool {
    false
}

/// Banned player entry
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BannedPlayer {
    pub uuid: String,
    pub name: String,
    pub created: String,
    pub source: String,
    pub expires: String,
    pub reason: String,
}

/// Banned IP entry
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BannedIp {
    pub ip: String,
    pub created: String,
    pub source: String,
    pub expires: String,
    pub reason: String,
}

/// Combined player management state
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PlayerManagement {
    pub whitelist: Vec<WhitelistEntry>,
    pub ops: Vec<OpEntry>,
    pub banned_players: Vec<BannedPlayer>,
    pub banned_ips: Vec<BannedIp>,
}

/// Load whitelist from server directory
pub async fn load_whitelist(server_dir: impl AsRef<Path>) -> ServerResult<Vec<WhitelistEntry>> {
    let path = server_dir.as_ref().join("whitelist.json");

    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(&path).await?;
    let whitelist: Vec<WhitelistEntry> = serde_json::from_str(&content)
        .map_err(|e| ServerError::Config(format!("Failed to parse whitelist.json: {}", e)))?;

    Ok(whitelist)
}

/// Save whitelist to server directory
pub async fn save_whitelist(server_dir: impl AsRef<Path>, whitelist: &[WhitelistEntry]) -> ServerResult<()> {
    let path = server_dir.as_ref().join("whitelist.json");
    let content = serde_json::to_string_pretty(whitelist)?;
    fs::write(&path, content).await?;
    Ok(())
}

/// Load operators from server directory
pub async fn load_ops(server_dir: impl AsRef<Path>) -> ServerResult<Vec<OpEntry>> {
    let path = server_dir.as_ref().join("ops.json");

    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(&path).await?;
    let ops: Vec<OpEntry> = serde_json::from_str(&content)
        .map_err(|e| ServerError::Config(format!("Failed to parse ops.json: {}", e)))?;

    Ok(ops)
}

/// Save operators to server directory
pub async fn save_ops(server_dir: impl AsRef<Path>, ops: &[OpEntry]) -> ServerResult<()> {
    let path = server_dir.as_ref().join("ops.json");
    let content = serde_json::to_string_pretty(ops)?;
    fs::write(&path, content).await?;
    Ok(())
}

/// Load banned players from server directory
pub async fn load_banned_players(server_dir: impl AsRef<Path>) -> ServerResult<Vec<BannedPlayer>> {
    let path = server_dir.as_ref().join("banned-players.json");

    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(&path).await?;
    let banned: Vec<BannedPlayer> = serde_json::from_str(&content)
        .map_err(|e| ServerError::Config(format!("Failed to parse banned-players.json: {}", e)))?;

    Ok(banned)
}

/// Save banned players to server directory
pub async fn save_banned_players(server_dir: impl AsRef<Path>, banned: &[BannedPlayer]) -> ServerResult<()> {
    let path = server_dir.as_ref().join("banned-players.json");
    let content = serde_json::to_string_pretty(banned)?;
    fs::write(&path, content).await?;
    Ok(())
}

/// Load banned IPs from server directory
pub async fn load_banned_ips(server_dir: impl AsRef<Path>) -> ServerResult<Vec<BannedIp>> {
    let path = server_dir.as_ref().join("banned-ips.json");

    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(&path).await?;
    let banned: Vec<BannedIp> = serde_json::from_str(&content)
        .map_err(|e| ServerError::Config(format!("Failed to parse banned-ips.json: {}", e)))?;

    Ok(banned)
}

/// Save banned IPs to server directory
pub async fn save_banned_ips(server_dir: impl AsRef<Path>, banned: &[BannedIp]) -> ServerResult<()> {
    let path = server_dir.as_ref().join("banned-ips.json");
    let content = serde_json::to_string_pretty(banned)?;
    fs::write(&path, content).await?;
    Ok(())
}

/// Load all player management data
pub async fn load_all(server_dir: impl AsRef<Path>) -> ServerResult<PlayerManagement> {
    let server_dir = server_dir.as_ref();

    Ok(PlayerManagement {
        whitelist: load_whitelist(server_dir).await.unwrap_or_default(),
        ops: load_ops(server_dir).await.unwrap_or_default(),
        banned_players: load_banned_players(server_dir).await.unwrap_or_default(),
        banned_ips: load_banned_ips(server_dir).await.unwrap_or_default(),
    })
}

/// Add player to whitelist
pub async fn add_to_whitelist(
    server_dir: impl AsRef<Path>,
    uuid: &str,
    name: &str,
) -> ServerResult<()> {
    let server_dir = server_dir.as_ref();
    let mut whitelist = load_whitelist(server_dir).await?;

    // Check if already whitelisted
    if whitelist.iter().any(|e| e.uuid == uuid || e.name.eq_ignore_ascii_case(name)) {
        return Ok(());
    }

    whitelist.push(WhitelistEntry {
        uuid: uuid.to_string(),
        name: name.to_string(),
    });

    save_whitelist(server_dir, &whitelist).await?;
    log::info!("Added player '{}' to whitelist", name);
    Ok(())
}

/// Remove player from whitelist
pub async fn remove_from_whitelist(
    server_dir: impl AsRef<Path>,
    name: &str,
) -> ServerResult<()> {
    let server_dir = server_dir.as_ref();
    let mut whitelist = load_whitelist(server_dir).await?;

    let len_before = whitelist.len();
    whitelist.retain(|e| !e.name.eq_ignore_ascii_case(name));

    if whitelist.len() < len_before {
        save_whitelist(server_dir, &whitelist).await?;
        log::info!("Removed player '{}' from whitelist", name);
    }

    Ok(())
}

/// Add operator
pub async fn add_op(
    server_dir: impl AsRef<Path>,
    uuid: &str,
    name: &str,
    level: u8,
) -> ServerResult<()> {
    let server_dir = server_dir.as_ref();
    let mut ops = load_ops(server_dir).await?;

    // Remove existing entry if present
    ops.retain(|e| !e.name.eq_ignore_ascii_case(name));

    // Clamp level to valid range (1-4)
    let level = level.clamp(1, 4);

    ops.push(OpEntry {
        uuid: uuid.to_string(),
        name: name.to_string(),
        level,
        bypasses_player_limit: level >= 3,
    });

    save_ops(server_dir, &ops).await?;
    log::info!("Added player '{}' as operator (level {})", name, level);
    Ok(())
}

/// Remove operator
pub async fn remove_op(server_dir: impl AsRef<Path>, name: &str) -> ServerResult<()> {
    let server_dir = server_dir.as_ref();
    let mut ops = load_ops(server_dir).await?;

    let len_before = ops.len();
    ops.retain(|e| !e.name.eq_ignore_ascii_case(name));

    if ops.len() < len_before {
        save_ops(server_dir, &ops).await?;
        log::info!("Removed operator status from player '{}'", name);
    }

    Ok(())
}

/// Ban a player
pub async fn ban_player(
    server_dir: impl AsRef<Path>,
    uuid: &str,
    name: &str,
    reason: &str,
    source: &str,
) -> ServerResult<()> {
    let server_dir = server_dir.as_ref();
    let mut banned = load_banned_players(server_dir).await?;

    // Remove existing entry if present
    banned.retain(|e| !e.name.eq_ignore_ascii_case(name));

    banned.push(BannedPlayer {
        uuid: uuid.to_string(),
        name: name.to_string(),
        created: chrono::Utc::now().format("%Y-%m-%d %H:%M:%S %z").to_string(),
        source: source.to_string(),
        expires: "forever".to_string(),
        reason: reason.to_string(),
    });

    save_banned_players(server_dir, &banned).await?;
    log::info!("Banned player '{}' (reason: {})", name, reason);
    Ok(())
}

/// Unban a player
pub async fn unban_player(server_dir: impl AsRef<Path>, name: &str) -> ServerResult<()> {
    let server_dir = server_dir.as_ref();
    let mut banned = load_banned_players(server_dir).await?;

    let len_before = banned.len();
    banned.retain(|e| !e.name.eq_ignore_ascii_case(name));

    if banned.len() < len_before {
        save_banned_players(server_dir, &banned).await?;
        log::info!("Unbanned player '{}'", name);
    }

    Ok(())
}

/// Ban an IP address
pub async fn ban_ip(
    server_dir: impl AsRef<Path>,
    ip: &str,
    reason: &str,
    source: &str,
) -> ServerResult<()> {
    let server_dir = server_dir.as_ref();
    let mut banned = load_banned_ips(server_dir).await?;

    // Remove existing entry if present
    banned.retain(|e| e.ip != ip);

    banned.push(BannedIp {
        ip: ip.to_string(),
        created: chrono::Utc::now().format("%Y-%m-%d %H:%M:%S %z").to_string(),
        source: source.to_string(),
        expires: "forever".to_string(),
        reason: reason.to_string(),
    });

    save_banned_ips(server_dir, &banned).await?;
    log::info!("Banned IP '{}' (reason: {})", ip, reason);
    Ok(())
}

/// Unban an IP address
pub async fn unban_ip(server_dir: impl AsRef<Path>, ip: &str) -> ServerResult<()> {
    let server_dir = server_dir.as_ref();
    let mut banned = load_banned_ips(server_dir).await?;

    let len_before = banned.len();
    banned.retain(|e| e.ip != ip);

    if banned.len() < len_before {
        save_banned_ips(server_dir, &banned).await?;
        log::info!("Unbanned IP '{}'", ip);
    }

    Ok(())
}

/// Lookup player UUID from Mojang API
pub async fn lookup_uuid(username: &str) -> ServerResult<Option<String>> {
    let url = format!(
        "https://api.mojang.com/users/profiles/minecraft/{}",
        username
    );

    let response = reqwest::Client::new()
        .get(&url)
        .send()
        .await
        .map_err(|e| ServerError::Network(e.to_string()))?;

    if response.status() == 204 || response.status() == 404 {
        return Ok(None);
    }

    if !response.status().is_success() {
        return Err(ServerError::Network(format!(
            "Mojang API returned {}",
            response.status()
        )));
    }

    #[derive(Deserialize)]
    struct MojangProfile {
        id: String,
        name: String,
    }

    let profile: MojangProfile = response.json().await
        .map_err(|e| ServerError::Network(e.to_string()))?;

    // Convert to standard UUID format (with dashes)
    let uuid = format!(
        "{}-{}-{}-{}-{}",
        &profile.id[0..8],
        &profile.id[8..12],
        &profile.id[12..16],
        &profile.id[16..20],
        &profile.id[20..32]
    );

    Ok(Some(uuid))
}

/// Check if player is whitelisted
pub async fn is_whitelisted(server_dir: impl AsRef<Path>, name: &str) -> ServerResult<bool> {
    let whitelist = load_whitelist(server_dir).await?;
    Ok(whitelist.iter().any(|e| e.name.eq_ignore_ascii_case(name)))
}

/// Check if player is an operator
pub async fn is_op(server_dir: impl AsRef<Path>, name: &str) -> ServerResult<bool> {
    let ops = load_ops(server_dir).await?;
    Ok(ops.iter().any(|e| e.name.eq_ignore_ascii_case(name)))
}

/// Check if player is banned
pub async fn is_banned(server_dir: impl AsRef<Path>, name: &str) -> ServerResult<bool> {
    let banned = load_banned_players(server_dir).await?;
    Ok(banned.iter().any(|e| e.name.eq_ignore_ascii_case(name)))
}

/// Get operator level for a player (0 if not op)
pub async fn get_op_level(server_dir: impl AsRef<Path>, name: &str) -> ServerResult<u8> {
    let ops = load_ops(server_dir).await?;
    Ok(ops
        .iter()
        .find(|e| e.name.eq_ignore_ascii_case(name))
        .map(|e| e.level)
        .unwrap_or(0))
}

// Tauri commands

#[tauri::command]
pub async fn get_player_management(instance_id: String) -> Result<PlayerManagement, String> {
    let instances_dir = crate::paths::instances_dir();
    let server_dir = instances_dir.join(&instance_id);

    load_all(&server_dir)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn whitelist_add(instance_id: String, username: String) -> Result<(), String> {
    let instances_dir = crate::paths::instances_dir();
    let server_dir = instances_dir.join(&instance_id);

    // Try to lookup UUID from Mojang
    let uuid = lookup_uuid(&username)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Player '{}' not found", username))?;

    add_to_whitelist(&server_dir, &uuid, &username)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn whitelist_remove(instance_id: String, username: String) -> Result<(), String> {
    let instances_dir = crate::paths::instances_dir();
    let server_dir = instances_dir.join(&instance_id);

    remove_from_whitelist(&server_dir, &username)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn op_add(instance_id: String, username: String, level: u8) -> Result<(), String> {
    let instances_dir = crate::paths::instances_dir();
    let server_dir = instances_dir.join(&instance_id);

    // Try to lookup UUID from Mojang
    let uuid = lookup_uuid(&username)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Player '{}' not found", username))?;

    add_op(&server_dir, &uuid, &username, level)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn op_remove(instance_id: String, username: String) -> Result<(), String> {
    let instances_dir = crate::paths::instances_dir();
    let server_dir = instances_dir.join(&instance_id);

    remove_op(&server_dir, &username)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn player_ban(
    instance_id: String,
    username: String,
    reason: String,
) -> Result<(), String> {
    let instances_dir = crate::paths::instances_dir();
    let server_dir = instances_dir.join(&instance_id);

    // Try to lookup UUID from Mojang
    let uuid = lookup_uuid(&username)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Player '{}' not found", username))?;

    ban_player(&server_dir, &uuid, &username, &reason, "Stuzhik")
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn player_unban(instance_id: String, username: String) -> Result<(), String> {
    let instances_dir = crate::paths::instances_dir();
    let server_dir = instances_dir.join(&instance_id);

    unban_player(&server_dir, &username)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ip_ban(instance_id: String, ip: String, reason: String) -> Result<(), String> {
    let instances_dir = crate::paths::instances_dir();
    let server_dir = instances_dir.join(&instance_id);

    ban_ip(&server_dir, &ip, &reason, "Stuzhik")
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ip_unban(instance_id: String, ip: String) -> Result<(), String> {
    let instances_dir = crate::paths::instances_dir();
    let server_dir = instances_dir.join(&instance_id);

    unban_ip(&server_dir, &ip)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn lookup_player_uuid(username: String) -> Result<Option<String>, String> {
    lookup_uuid(&username)
        .await
        .map_err(|e| e.to_string())
}
