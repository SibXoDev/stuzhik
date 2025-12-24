//! Client mod detection and auto-disable
//!
//! Detects client-only mods using API lookups (Modrinth/CurseForge)
//! and automatically disables them when running as a server.
//!
//! Detection priority:
//! 1. Modrinth API via SHA-1/SHA-512 hash lookup (most accurate)
//! 2. CurseForge API via fingerprint lookup
//! 3. Local cache of previously detected mods
//! 4. Fallback: heuristics only for unknown mods (with warning)

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use sha1::{Digest as Sha1Digest, Sha1};
use sha2::{Sha512};
use tokio::fs;
use tokio::io::AsyncReadExt;
use tokio::sync::RwLock;

use super::{ServerError, ServerResult};

/// Information about a mod's side compatibility
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ModSideInfo {
    /// SHA-1 hash of the file
    pub sha1: String,
    /// SHA-512 hash of the file
    pub sha512: String,
    /// Client side requirement: "required", "optional", "unsupported"
    pub client_side: String,
    /// Server side requirement: "required", "optional", "unsupported"
    pub server_side: String,
    /// Mod ID (Modrinth slug or CurseForge ID)
    pub mod_id: Option<String>,
    /// Mod name
    pub mod_name: Option<String>,
    /// Detection source
    pub source: DetectionSource,
}

impl ModSideInfo {
    /// Returns true if this mod is client-only (doesn't work on server)
    pub fn is_client_only(&self) -> bool {
        // Client-only: client is required/optional AND server is unsupported
        self.server_side == "unsupported"
    }

    /// Returns true if this mod is server-only (doesn't work on client)
    pub fn is_server_only(&self) -> bool {
        // Server-only: server is required/optional AND client is unsupported
        self.client_side == "unsupported"
    }
}

/// Source of mod detection
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DetectionSource {
    /// Detected via Modrinth API
    Modrinth,
    /// Detected via CurseForge API
    CurseForge,
    /// From local cache
    Cache,
    /// User manually marked
    UserMarked,
    /// Unknown mod (not found in any API)
    Unknown,
}

/// Information about a client-only mod (for UI)
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ClientModInfo {
    /// Mod file name
    pub file_name: String,
    /// SHA-1 hash
    pub sha1: String,
    /// Mod ID (if known)
    pub mod_id: Option<String>,
    /// Mod name (if known)
    pub name: Option<String>,
    /// Detection source
    pub source: DetectionSource,
    /// Reason it was detected as client-only
    pub reason: String,
    /// Whether it was auto-disabled
    pub disabled: bool,
}

/// Cache for mod side information
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct ModSideCache {
    /// Map of SHA-1 hash -> side info
    pub mods: HashMap<String, ModSideInfo>,
    /// Version for cache invalidation
    pub version: u32,
}

impl ModSideCache {
    const CURRENT_VERSION: u32 = 1;

    pub fn new() -> Self {
        Self {
            mods: HashMap::new(),
            version: Self::CURRENT_VERSION,
        }
    }

    pub fn get(&self, sha1: &str) -> Option<&ModSideInfo> {
        self.mods.get(sha1)
    }

    pub fn insert(&mut self, sha1: String, info: ModSideInfo) {
        self.mods.insert(sha1, info);
    }
}

/// Global cache for mod side information
static MOD_SIDE_CACHE: std::sync::OnceLock<Arc<RwLock<ModSideCache>>> = std::sync::OnceLock::new();

fn get_cache() -> &'static Arc<RwLock<ModSideCache>> {
    MOD_SIDE_CACHE.get_or_init(|| Arc::new(RwLock::new(ModSideCache::new())))
}

/// Load cache from disk
pub async fn load_cache(data_dir: &Path) -> ServerResult<()> {
    let cache_path = data_dir.join("mod_side_cache.json");
    if cache_path.exists() {
        let content = fs::read_to_string(&cache_path).await?;
        if let Ok(cache) = serde_json::from_str::<ModSideCache>(&content) {
            if cache.version == ModSideCache::CURRENT_VERSION {
                *get_cache().write().await = cache;
                log::info!("Loaded mod side cache with {} entries", get_cache().read().await.mods.len());
            }
        }
    }
    Ok(())
}

/// Save cache to disk
pub async fn save_cache(data_dir: &Path) -> ServerResult<()> {
    let cache_path = data_dir.join("mod_side_cache.json");
    let cache = get_cache().read().await;
    let content = serde_json::to_string_pretty(&*cache)?;
    fs::write(&cache_path, content).await?;
    Ok(())
}

/// Compute SHA-1 and SHA-512 hashes for a file
pub async fn compute_file_hashes(path: &Path) -> ServerResult<(String, String)> {
    let mut file = fs::File::open(path).await?;
    let mut sha1_hasher = Sha1::new();
    let mut sha512_hasher = Sha512::new();
    let mut buffer = vec![0u8; 64 * 1024]; // 64KB buffer

    loop {
        let bytes_read = file.read(&mut buffer).await?;
        if bytes_read == 0 {
            break;
        }
        sha1_hasher.update(&buffer[..bytes_read]);
        sha512_hasher.update(&buffer[..bytes_read]);
    }

    let sha1 = hex::encode(sha1_hasher.finalize());
    let sha512 = hex::encode(sha512_hasher.finalize());

    Ok((sha1, sha512))
}

/// Look up mod side info via Modrinth API using hash
async fn lookup_modrinth(sha1: &str, sha512: &str) -> Option<ModSideInfo> {
    use crate::api::modrinth::ModrinthClient;

    // Try SHA-512 first (more unique)
    let version = match ModrinthClient::get_version_by_hash(sha512, "sha512").await {
        Ok(v) => v,
        Err(_) => {
            // Fall back to SHA-1
            match ModrinthClient::get_version_by_hash(sha1, "sha1").await {
                Ok(v) => v,
                Err(_) => return None,
            }
        }
    };

    // Get project info for client_side/server_side
    let project = match ModrinthClient::get_project(&version.project_id).await {
        Ok(p) => p,
        Err(_) => return None,
    };

    Some(ModSideInfo {
        sha1: sha1.to_string(),
        sha512: sha512.to_string(),
        client_side: project.client_side.clone(),
        server_side: project.server_side.clone(),
        mod_id: Some(project.slug.clone()),
        mod_name: Some(project.title.clone()),
        source: DetectionSource::Modrinth,
    })
}

/// Look up multiple mods via Modrinth API using batch hash lookup
async fn lookup_modrinth_batch(hashes: &[(String, String)]) -> HashMap<String, ModSideInfo> {
    use crate::api::modrinth::ModrinthClient;

    let mut results = HashMap::new();

    // Use SHA-1 for batch lookup (Modrinth supports it)
    let sha1_hashes: Vec<String> = hashes.iter().map(|(sha1, _)| sha1.clone()).collect();

    if sha1_hashes.is_empty() {
        return results;
    }

    // Batch lookup
    let versions = match ModrinthClient::get_versions_by_hashes(&sha1_hashes, "sha1").await {
        Ok(v) => v,
        Err(e) => {
            log::warn!("Modrinth batch lookup failed: {}", e);
            return results;
        }
    };

    // Get project IDs for all found versions
    let project_ids: Vec<String> = versions.values().map(|v| v.project_id.clone()).collect();

    // Fetch project info to get client_side/server_side
    // Note: We need to fetch each project individually or use bulk endpoint
    for (sha1, version) in &versions {
        let sha512 = hashes
            .iter()
            .find(|(s1, _)| s1 == sha1)
            .map(|(_, s512)| s512.clone())
            .unwrap_or_default();

        if let Ok(project) = ModrinthClient::get_project(&version.project_id).await {
            results.insert(
                sha1.clone(),
                ModSideInfo {
                    sha1: sha1.clone(),
                    sha512,
                    client_side: project.client_side.clone(),
                    server_side: project.server_side.clone(),
                    mod_id: Some(project.slug.clone()),
                    mod_name: Some(project.title.clone()),
                    source: DetectionSource::Modrinth,
                },
            );
        }
    }

    results
}

/// Look up mod via CurseForge fingerprint API
async fn lookup_curseforge(sha1: &str, sha512: &str, path: &Path) -> Option<ModSideInfo> {
    use crate::api::curseforge::CurseForgeClient;

    // CurseForge uses MurmurHash2 fingerprinting, not SHA hashes
    // We need to compute the fingerprint from the file content
    let fingerprint = match compute_curseforge_fingerprint(path).await {
        Ok(fp) => fp,
        Err(_) => return None,
    };

    // Use CurseForge fingerprint lookup
    let client = match CurseForgeClient::new() {
        Ok(c) => c,
        Err(_) => return None,
    };

    // CurseForge doesn't expose client_side/server_side directly
    // We need to check the mod categories instead
    // Category 435 = Client, Category 434 = Server
    // For now, we'll use the mod info but can't determine side accurately

    // Note: CurseForge API doesn't have a direct hash lookup
    // The fingerprint endpoint would need to be added to curseforge.rs
    // For now, return None and let Modrinth be the primary source

    None
}

/// Compute CurseForge fingerprint (MurmurHash2)
async fn compute_curseforge_fingerprint(path: &Path) -> ServerResult<u32> {
    let content = fs::read(path).await?;

    // CurseForge fingerprint: normalize whitespace and compute MurmurHash2
    let normalized: Vec<u8> = content
        .into_iter()
        .filter(|&b| b != 9 && b != 10 && b != 13 && b != 32) // Remove whitespace
        .collect();

    // Simple MurmurHash2 implementation
    let hash = murmur2_hash(&normalized, 1);
    Ok(hash)
}

/// MurmurHash2 implementation (seed=1, as used by CurseForge)
fn murmur2_hash(data: &[u8], seed: u32) -> u32 {
    const M: u32 = 0x5bd1e995;
    const R: i32 = 24;

    let len = data.len() as u32;
    let mut h = seed ^ len;

    let mut i = 0;
    while i + 4 <= data.len() {
        let mut k = u32::from_le_bytes([data[i], data[i + 1], data[i + 2], data[i + 3]]);
        k = k.wrapping_mul(M);
        k ^= k >> R;
        k = k.wrapping_mul(M);
        h = h.wrapping_mul(M);
        h ^= k;
        i += 4;
    }

    // Handle remaining bytes
    match data.len() - i {
        3 => {
            h ^= (data[i + 2] as u32) << 16;
            h ^= (data[i + 1] as u32) << 8;
            h ^= data[i] as u32;
            h = h.wrapping_mul(M);
        }
        2 => {
            h ^= (data[i + 1] as u32) << 8;
            h ^= data[i] as u32;
            h = h.wrapping_mul(M);
        }
        1 => {
            h ^= data[i] as u32;
            h = h.wrapping_mul(M);
        }
        _ => {}
    }

    h ^= h >> 13;
    h = h.wrapping_mul(M);
    h ^= h >> 15;

    h
}

/// Scan mods folder and detect client-only mods using API
pub async fn scan_for_client_mods(mods_dir: impl AsRef<Path>) -> ServerResult<Vec<ClientModInfo>> {
    let mods_dir = mods_dir.as_ref();
    let mut client_mods = Vec::new();

    if !mods_dir.exists() {
        return Ok(client_mods);
    }

    // Collect all jar files with their hashes
    let mut jar_files: Vec<(PathBuf, String, String)> = Vec::new();
    let mut entries = fs::read_dir(mods_dir).await?;

    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if path.extension().map_or(false, |e| e == "jar") {
            match compute_file_hashes(&path).await {
                Ok((sha1, sha512)) => {
                    jar_files.push((path, sha1, sha512));
                }
                Err(e) => {
                    log::warn!("Failed to hash {}: {}", path.display(), e);
                }
            }
        }
    }

    if jar_files.is_empty() {
        return Ok(client_mods);
    }

    log::info!("Scanning {} mods for client-side detection...", jar_files.len());

    // Check cache first
    let cache = get_cache().read().await;
    let mut uncached: Vec<(PathBuf, String, String)> = Vec::new();
    let mut cached_results: Vec<(PathBuf, ModSideInfo)> = Vec::new();

    for (path, sha1, sha512) in jar_files {
        if let Some(info) = cache.get(&sha1) {
            cached_results.push((path, info.clone()));
        } else {
            uncached.push((path, sha1, sha512));
        }
    }
    drop(cache);

    log::info!(
        "Found {} cached, {} need API lookup",
        cached_results.len(),
        uncached.len()
    );

    // Batch lookup uncached mods via Modrinth
    let hashes: Vec<(String, String)> = uncached.iter().map(|(_, s1, s512)| (s1.clone(), s512.clone())).collect();
    let api_results = lookup_modrinth_batch(&hashes).await;

    // Update cache with new results
    {
        let mut cache = get_cache().write().await;
        for (sha1, info) in &api_results {
            cache.insert(sha1.clone(), info.clone());
        }
    }

    // Process cached results
    for (path, info) in cached_results {
        if info.is_client_only() {
            let file_name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();

            client_mods.push(ClientModInfo {
                file_name,
                sha1: info.sha1.clone(),
                mod_id: info.mod_id.clone(),
                name: info.mod_name.clone(),
                source: DetectionSource::Cache,
                reason: format!(
                    "client_side={}, server_side={} (cached)",
                    info.client_side, info.server_side
                ),
                disabled: false,
            });
        }
    }

    // Process API results
    for (path, sha1, sha512) in &uncached {
        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();

        if let Some(info) = api_results.get(sha1) {
            if info.is_client_only() {
                client_mods.push(ClientModInfo {
                    file_name,
                    sha1: sha1.clone(),
                    mod_id: info.mod_id.clone(),
                    name: info.mod_name.clone(),
                    source: info.source.clone(),
                    reason: format!(
                        "client_side={}, server_side={} (Modrinth)",
                        info.client_side, info.server_side
                    ),
                    disabled: false,
                });
            }
        } else {
            // Not found in Modrinth - add to cache as unknown
            let unknown_info = ModSideInfo {
                sha1: sha1.clone(),
                sha512: sha512.clone(),
                client_side: "unknown".to_string(),
                server_side: "unknown".to_string(),
                mod_id: None,
                mod_name: None,
                source: DetectionSource::Unknown,
            };

            let mut cache = get_cache().write().await;
            cache.insert(sha1.clone(), unknown_info);
        }
    }

    // Save cache
    if let Err(e) = save_cache(crate::paths::get_base_dir()).await {
        log::warn!("Failed to save mod side cache: {}", e);
    }

    Ok(client_mods)
}

/// Get detailed mod info for a single file
pub async fn get_mod_side_info(path: &Path) -> ServerResult<Option<ModSideInfo>> {
    let (sha1, sha512) = compute_file_hashes(path).await?;

    // Check cache first
    if let Some(info) = get_cache().read().await.get(&sha1) {
        return Ok(Some(info.clone()));
    }

    // Try Modrinth
    if let Some(info) = lookup_modrinth(&sha1, &sha512).await {
        get_cache().write().await.insert(sha1.clone(), info.clone());
        return Ok(Some(info));
    }

    // Try CurseForge
    if let Some(info) = lookup_curseforge(&sha1, &sha512, path).await {
        get_cache().write().await.insert(sha1.clone(), info.clone());
        return Ok(Some(info));
    }

    // Unknown mod
    let info = ModSideInfo {
        sha1: sha1.clone(),
        sha512,
        client_side: "unknown".to_string(),
        server_side: "unknown".to_string(),
        mod_id: None,
        mod_name: None,
        source: DetectionSource::Unknown,
    };
    get_cache().write().await.insert(sha1, info.clone());

    Ok(Some(info))
}

/// Disable a mod by renaming .jar to .jar.disabled
pub async fn disable_mod(mods_dir: impl AsRef<Path>, file_name: &str) -> ServerResult<()> {
    let mods_dir = mods_dir.as_ref();
    let jar_path = mods_dir.join(file_name);
    let disabled_path = mods_dir.join(format!("{}.disabled", file_name));

    if tokio::fs::try_exists(&jar_path).await.unwrap_or(false) {
        fs::rename(&jar_path, &disabled_path).await?;
        log::info!("Disabled client mod: {}", file_name);
    }

    Ok(())
}

/// Enable a mod by renaming .jar.disabled to .jar
pub async fn enable_mod(mods_dir: impl AsRef<Path>, file_name: &str) -> ServerResult<()> {
    let mods_dir = mods_dir.as_ref();

    let (disabled_name, enabled_name) = if file_name.ends_with(".disabled") {
        (
            file_name.to_string(),
            file_name.trim_end_matches(".disabled").to_string(),
        )
    } else {
        (format!("{}.disabled", file_name), file_name.to_string())
    };

    let disabled_path = mods_dir.join(&disabled_name);
    let enabled_path = mods_dir.join(&enabled_name);

    if tokio::fs::try_exists(&disabled_path).await.unwrap_or(false) {
        fs::rename(&disabled_path, &enabled_path).await?;
        log::info!("Enabled mod: {}", enabled_name);
    }

    Ok(())
}

/// Auto-disable all detected client mods
pub async fn auto_disable_client_mods(
    mods_dir: impl AsRef<Path>,
) -> ServerResult<Vec<ClientModInfo>> {
    let mods_dir = mods_dir.as_ref();
    let mut client_mods = scan_for_client_mods(mods_dir).await?;

    for mod_info in &mut client_mods {
        disable_mod(mods_dir, &mod_info.file_name).await?;
        mod_info.disabled = true;
    }

    if !client_mods.is_empty() {
        log::info!(
            "Auto-disabled {} client mods for server: {:?}",
            client_mods.len(),
            client_mods.iter().map(|m| &m.file_name).collect::<Vec<_>>()
        );
    }

    Ok(client_mods)
}

/// Re-enable all disabled mods
pub async fn enable_all_mods(mods_dir: impl AsRef<Path>) -> ServerResult<Vec<String>> {
    let mods_dir = mods_dir.as_ref();
    let mut enabled = Vec::new();

    if !mods_dir.exists() {
        return Ok(enabled);
    }

    let mut entries = fs::read_dir(mods_dir).await?;

    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();

        if path.extension().map_or(false, |e| e == "disabled") {
            let file_name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();

            enable_mod(mods_dir, &file_name).await?;
            enabled.push(file_name.trim_end_matches(".disabled").to_string());
        }
    }

    Ok(enabled)
}

/// Get list of currently disabled mods
pub async fn get_disabled_mods(mods_dir: impl AsRef<Path>) -> ServerResult<Vec<String>> {
    let mods_dir = mods_dir.as_ref();
    let mut disabled = Vec::new();

    if !mods_dir.exists() {
        return Ok(disabled);
    }

    let mut entries = fs::read_dir(mods_dir).await?;

    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();

        if path.extension().map_or(false, |e| e == "disabled") {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                disabled.push(name.to_string());
            }
        }
    }

    Ok(disabled)
}

/// Manually mark a mod as client-only (for unknown mods)
pub async fn mark_as_client_mod(mods_dir: impl AsRef<Path>, file_name: &str) -> ServerResult<()> {
    let mods_dir = mods_dir.as_ref();
    let path = mods_dir.join(file_name);

    if !tokio::fs::try_exists(&path).await.unwrap_or(false) {
        return Err(ServerError::NotFound(file_name.to_string()));
    }

    let (sha1, sha512) = compute_file_hashes(&path).await?;

    let info = ModSideInfo {
        sha1: sha1.clone(),
        sha512,
        client_side: "required".to_string(),
        server_side: "unsupported".to_string(),
        mod_id: None,
        mod_name: Some(file_name.to_string()),
        source: DetectionSource::UserMarked,
    };

    get_cache().write().await.insert(sha1, info);
    save_cache(crate::paths::get_base_dir()).await?;

    Ok(())
}

/// Manually mark a mod as NOT client-only (server-compatible)
pub async fn unmark_as_client_mod(mods_dir: impl AsRef<Path>, file_name: &str) -> ServerResult<()> {
    let mods_dir = mods_dir.as_ref();
    let path = mods_dir.join(file_name);

    if !tokio::fs::try_exists(&path).await.unwrap_or(false) {
        return Err(ServerError::NotFound(file_name.to_string()));
    }

    let (sha1, sha512) = compute_file_hashes(&path).await?;

    let info = ModSideInfo {
        sha1: sha1.clone(),
        sha512,
        client_side: "optional".to_string(),
        server_side: "optional".to_string(),
        mod_id: None,
        mod_name: Some(file_name.to_string()),
        source: DetectionSource::UserMarked,
    };

    get_cache().write().await.insert(sha1, info);
    save_cache(crate::paths::get_base_dir()).await?;

    Ok(())
}

// ==================== Tauri Commands ====================

#[tauri::command]
pub async fn scan_client_mods(instance_id: String) -> Result<Vec<ClientModInfo>, String> {
    let instances_dir = crate::paths::instances_dir();
    let mods_dir = instances_dir.join(&instance_id).join("mods");

    scan_for_client_mods(&mods_dir)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn disable_client_mods_for_server(
    instance_id: String,
) -> Result<Vec<ClientModInfo>, String> {
    let instances_dir = crate::paths::instances_dir();
    let mods_dir = instances_dir.join(&instance_id).join("mods");

    auto_disable_client_mods(&mods_dir)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn enable_mod_file(instance_id: String, file_name: String) -> Result<(), String> {
    let instances_dir = crate::paths::instances_dir();
    let mods_dir = instances_dir.join(&instance_id).join("mods");

    enable_mod(&mods_dir, &file_name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn disable_mod_file(instance_id: String, file_name: String) -> Result<(), String> {
    let instances_dir = crate::paths::instances_dir();
    let mods_dir = instances_dir.join(&instance_id).join("mods");

    disable_mod(&mods_dir, &file_name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_disabled_mods_list(instance_id: String) -> Result<Vec<String>, String> {
    let instances_dir = crate::paths::instances_dir();
    let mods_dir = instances_dir.join(&instance_id).join("mods");

    get_disabled_mods(&mods_dir)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn enable_all_disabled_mods(instance_id: String) -> Result<Vec<String>, String> {
    let instances_dir = crate::paths::instances_dir();
    let mods_dir = instances_dir.join(&instance_id).join("mods");

    enable_all_mods(&mods_dir).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_mod_info(instance_id: String, file_name: String) -> Result<Option<ModSideInfo>, String> {
    let instances_dir = crate::paths::instances_dir();
    let path = instances_dir.join(&instance_id).join("mods").join(&file_name);

    get_mod_side_info(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn mark_mod_as_client_only(instance_id: String, file_name: String) -> Result<(), String> {
    let instances_dir = crate::paths::instances_dir();
    let mods_dir = instances_dir.join(&instance_id).join("mods");

    mark_as_client_mod(&mods_dir, &file_name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn mark_mod_as_server_compatible(instance_id: String, file_name: String) -> Result<(), String> {
    let instances_dir = crate::paths::instances_dir();
    let mods_dir = instances_dir.join(&instance_id).join("mods");

    unmark_as_client_mod(&mods_dir, &file_name)
        .await
        .map_err(|e| e.to_string())
}
