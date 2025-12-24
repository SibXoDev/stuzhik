//! Secure storage for sensitive data
//!
//! ## Architecture (Hybrid Approach)
//!
//! 1. **Primary**: OS Keychain (best protection)
//!    - Windows: Credential Manager (DPAPI)
//!    - macOS: Keychain (user password protected)
//!    - Linux: Secret Service API (gnome-keyring/KWallet)
//!
//! 2. **Fallback**: Device-bound AES-256-GCM encryption
//!    - Used when keychain is unavailable (Linux without DE, servers)
//!    - Key derived from: machine_uid + app_salt + Argon2id
//!    - Encrypted data stored in SQLite
//!
//! ## Security Properties
//!
//! - **Keychain mode**: Protected by OS user password
//! - **Fallback mode**: Device-bound (can't decrypt on another machine)
//! - **AES-256-GCM**: Authenticated encryption (confidentiality + integrity)
//! - **Argon2id**: Memory-hard KDF (resists GPU/ASIC attacks)
//! - **Random nonce**: Each encryption is unique (no pattern analysis)
//!
//! ## Usage
//!
//! ```rust
//! // Simple API for any data
//! SecureVault::store("my_key", "sensitive_value")?;
//! let value = SecureVault::get("my_key")?;
//! SecureVault::delete("my_key")?;
//!
//! // Typed convenience methods
//! SecureVault::store_auth_token("token123")?;
//! let token = SecureVault::get_auth_token()?;
//! ```

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use argon2::{password_hash::SaltString, Argon2, PasswordHasher};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use keyring::Entry;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use thiserror::Error;

// ============================================================================
// Constants
// ============================================================================

/// Service name for keyring entries
const SERVICE_NAME: &str = "stuzhik";

/// App-specific salt for key derivation (32 bytes, hex-encoded)
/// This is NOT a secret - it's just to namespace our keys
const APP_SALT: &str = "stuzhik_minecraft_launcher_2024_v1";

/// Argon2 parameters (OWASP recommended for sensitive data)
const ARGON2_MEMORY_COST: u32 = 65536; // 64 MiB
const ARGON2_TIME_COST: u32 = 3; // 3 iterations
const ARGON2_PARALLELISM: u32 = 4; // 4 threads

/// Nonce size for AES-256-GCM (96 bits = 12 bytes)
const NONCE_SIZE: usize = 12;

// ============================================================================
// Types
// ============================================================================

#[derive(Error, Debug)]
pub enum SecretError {
    #[error("Failed to access secure storage: {0}")]
    StorageError(String),

    #[error("Secret not found: {0}")]
    NotFound(String),

    #[error("Encryption failed: {0}")]
    EncryptionError(String),

    #[error("Decryption failed: {0}")]
    DecryptionError(String),

    #[error("Key derivation failed: {0}")]
    KeyDerivationError(String),

    #[error("Database error: {0}")]
    DatabaseError(String),

    #[error("Invalid data format")]
    InvalidFormat,
}

pub type Result<T> = std::result::Result<T, SecretError>;

/// Storage backend being used
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum StorageBackend {
    /// OS Keychain (Windows Credential Manager, macOS Keychain, Linux Secret Service)
    OsKeychain,
    /// Encrypted SQLite storage (fallback)
    EncryptedDb,
}

/// Result of secret migration
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MigrationResult {
    pub ely_by_token_migrated: bool,
    pub rcon_passwords_migrated: usize,
    pub backend_used: Option<String>,
}

// ============================================================================
// Cached Master Key (derived once per session)
// ============================================================================

static MASTER_KEY: OnceLock<[u8; 32]> = OnceLock::new();
static KEYCHAIN_AVAILABLE: OnceLock<bool> = OnceLock::new();

/// Get or derive the master encryption key
fn get_master_key() -> Result<&'static [u8; 32]> {
    // Check if already initialized
    if let Some(key) = MASTER_KEY.get() {
        return Ok(key);
    }

    // Derive key (deterministic - same on same machine)
    let key = derive_master_key()?;

    // Try to set it (ignore if another thread set it first - that's fine)
    let _ = MASTER_KEY.set(key);

    // Now get() will return Some
    Ok(MASTER_KEY.get().expect("key was just set"))
}

/// Derive master key from machine_uid using Argon2id
fn derive_master_key() -> Result<[u8; 32]> {
    // Get machine-specific identifier
    let machine_id = machine_uid::get()
        .map_err(|e| SecretError::KeyDerivationError(format!("Failed to get machine ID: {}", e)))?;

    // Create password from machine_id + app_salt
    let password = format!("{}:{}", machine_id, APP_SALT);

    // Generate deterministic salt from app name (same salt = same key on same machine)
    let salt_input = format!("{}:salt:v1", APP_SALT);
    let salt_bytes: [u8; 16] = {
        use sha2::{Digest, Sha256};
        let hash = Sha256::digest(salt_input.as_bytes());
        let mut arr = [0u8; 16];
        arr.copy_from_slice(&hash[..16]);
        arr
    };

    // Encode salt for Argon2 (requires base64 encoding)
    let salt = SaltString::encode_b64(&salt_bytes)
        .map_err(|e| SecretError::KeyDerivationError(format!("Salt encoding failed: {}", e)))?;

    // Configure Argon2id
    let argon2 = Argon2::new(
        argon2::Algorithm::Argon2id,
        argon2::Version::V0x13,
        argon2::Params::new(
            ARGON2_MEMORY_COST,
            ARGON2_TIME_COST,
            ARGON2_PARALLELISM,
            Some(32),
        )
        .map_err(|e| SecretError::KeyDerivationError(format!("Invalid Argon2 params: {}", e)))?,
    );

    // Derive key
    let hash = argon2
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| SecretError::KeyDerivationError(format!("Argon2 failed: {}", e)))?;

    // Extract 32-byte key from hash output
    let hash_bytes = hash
        .hash
        .ok_or_else(|| SecretError::KeyDerivationError("No hash output from Argon2".to_string()))?;

    let mut key = [0u8; 32];
    key.copy_from_slice(hash_bytes.as_bytes());

    log::info!("Master key derived successfully");
    Ok(key)
}

// ============================================================================
// Encryption/Decryption (AES-256-GCM)
// ============================================================================

/// Encrypt data using AES-256-GCM
/// Returns: [nonce (12 bytes) | ciphertext | auth_tag (16 bytes)]
fn encrypt_data(plaintext: &[u8]) -> Result<Vec<u8>> {
    let key = get_master_key()?;
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|e| SecretError::EncryptionError(format!("Invalid key: {}", e)))?;

    // Generate random nonce
    let mut nonce_bytes = [0u8; NONCE_SIZE];
    rand::rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    // Encrypt
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| SecretError::EncryptionError(format!("Encryption failed: {}", e)))?;

    // Combine: nonce || ciphertext
    let mut result = Vec::with_capacity(NONCE_SIZE + ciphertext.len());
    result.extend_from_slice(&nonce_bytes);
    result.extend_from_slice(&ciphertext);

    Ok(result)
}

/// Decrypt data encrypted with encrypt_data()
fn decrypt_data(encrypted: &[u8]) -> Result<Vec<u8>> {
    if encrypted.len() < NONCE_SIZE + 16 {
        // Minimum: nonce + auth_tag
        return Err(SecretError::InvalidFormat);
    }

    let key = get_master_key()?;
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|e| SecretError::DecryptionError(format!("Invalid key: {}", e)))?;

    // Split nonce and ciphertext
    let (nonce_bytes, ciphertext) = encrypted.split_at(NONCE_SIZE);
    let nonce = Nonce::from_slice(nonce_bytes);

    // Decrypt and verify auth tag
    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| SecretError::DecryptionError("Decryption failed (tampering detected?)".into()))
}

// ============================================================================
// Keychain Backend
// ============================================================================

/// Check if OS keychain is available and working (cached)
fn is_keychain_available() -> bool {
    *KEYCHAIN_AVAILABLE.get_or_init(|| {
        log::debug!("[SECRETS] Testing keychain availability...");

        // Try a full roundtrip: create → store → get → delete
        let result = match Entry::new(SERVICE_NAME, "__test_availability__") {
            Ok(entry) => {
                // Store test value
                if entry.set_password("test_value_123").is_err() {
                    log::debug!("[SECRETS] Keychain test: set_password failed");
                    return false;
                }

                // Verify we can read it back
                match entry.get_password() {
                    Ok(val) if val == "test_value_123" => {
                        // Cleanup and return success
                        let _ = entry.delete_credential();
                        log::info!("[SECRETS] Keychain available and working");
                        true
                    }
                    Ok(val) => {
                        log::debug!("[SECRETS] Keychain test: value mismatch (got {:?})", val);
                        let _ = entry.delete_credential();
                        false
                    }
                    Err(e) => {
                        log::debug!("[SECRETS] Keychain test: get_password failed: {}", e);
                        let _ = entry.delete_credential();
                        false
                    }
                }
            }
            Err(e) => {
                log::debug!("[SECRETS] Keychain test: Entry::new failed: {}", e);
                false
            }
        };

        if !result {
            log::info!("[SECRETS] Keychain not available, using encrypted DB fallback");
        }

        result
    })
}

/// Store in OS keychain
fn keychain_store(key: &str, value: &str) -> Result<()> {
    let entry = Entry::new(SERVICE_NAME, key)
        .map_err(|e| SecretError::StorageError(format!("Keychain entry error: {}", e)))?;

    entry
        .set_password(value)
        .map_err(|e| SecretError::StorageError(format!("Keychain store error: {}", e)))?;

    Ok(())
}

/// Get from OS keychain
fn keychain_get(key: &str) -> Result<String> {
    let entry = Entry::new(SERVICE_NAME, key)
        .map_err(|e| SecretError::StorageError(format!("Keychain entry error: {}", e)))?;

    entry.get_password().map_err(|e| match e {
        keyring::Error::NoEntry => SecretError::NotFound(key.to_string()),
        other => SecretError::StorageError(format!("Keychain get error: {}", other)),
    })
}

/// Delete from OS keychain
fn keychain_delete(key: &str) -> Result<()> {
    let entry = Entry::new(SERVICE_NAME, key)
        .map_err(|e| SecretError::StorageError(format!("Keychain entry error: {}", e)))?;

    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()), // Already deleted
        Err(e) => Err(SecretError::StorageError(format!(
            "Keychain delete error: {}",
            e
        ))),
    }
}

// ============================================================================
// Encrypted DB Backend (Fallback)
// ============================================================================

/// Store encrypted in database
fn db_store_encrypted(key: &str, value: &str) -> Result<()> {
    let encrypted = encrypt_data(value.as_bytes())?;
    let encoded = BASE64.encode(&encrypted);

    let conn = crate::db::get_db_conn()
        .map_err(|e| SecretError::DatabaseError(format!("DB connection failed: {}", e)))?;

    conn.execute(
        "INSERT OR REPLACE INTO secure_secrets (key, value, updated_at) VALUES (?1, ?2, ?3)",
        rusqlite::params![key, encoded, chrono::Utc::now().to_rfc3339()],
    )
    .map_err(|e| SecretError::DatabaseError(format!("DB insert failed: {}", e)))?;

    Ok(())
}

/// Get decrypted from database
fn db_get_decrypted(key: &str) -> Result<String> {
    let conn = crate::db::get_db_conn()
        .map_err(|e| SecretError::DatabaseError(format!("DB connection failed: {}", e)))?;

    let encoded: String = conn
        .query_row(
            "SELECT value FROM secure_secrets WHERE key = ?1",
            [key],
            |row| row.get(0),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => SecretError::NotFound(key.to_string()),
            other => SecretError::DatabaseError(format!("DB query failed: {}", other)),
        })?;

    let encrypted = BASE64
        .decode(&encoded)
        .map_err(|_| SecretError::InvalidFormat)?;

    let decrypted = decrypt_data(&encrypted)?;

    String::from_utf8(decrypted).map_err(|_| SecretError::InvalidFormat)
}

/// Delete from database
fn db_delete(key: &str) -> Result<()> {
    let conn = crate::db::get_db_conn()
        .map_err(|e| SecretError::DatabaseError(format!("DB connection failed: {}", e)))?;

    conn.execute("DELETE FROM secure_secrets WHERE key = ?1", [key])
        .map_err(|e| SecretError::DatabaseError(format!("DB delete failed: {}", e)))?;

    Ok(())
}

/// Ensure secure_secrets table exists
pub fn ensure_secrets_table() -> Result<()> {
    let conn = crate::db::get_db_conn()
        .map_err(|e| SecretError::DatabaseError(format!("DB connection failed: {}", e)))?;

    conn.execute(
        r#"
        CREATE TABLE IF NOT EXISTS secure_secrets (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        "#,
        [],
    )
    .map_err(|e| SecretError::DatabaseError(format!("Table creation failed: {}", e)))?;

    Ok(())
}

// ============================================================================
// SecureVault - Main Public API
// ============================================================================

/// Secure vault for storing sensitive data
///
/// Automatically chooses the best available backend:
/// 1. OS Keychain (if available) - best security
/// 2. Encrypted DB (fallback) - device-bound encryption
pub struct SecureVault;

impl SecureVault {
    // ========== Core API ==========

    /// Store a secret value
    ///
    /// Automatically uses the best available backend.
    pub fn store(key: &str, value: &str) -> Result<()> {
        if is_keychain_available() {
            keychain_store(key, value)?;
            log::debug!("Stored secret '{}' in OS keychain", key);
        } else {
            ensure_secrets_table()?;
            db_store_encrypted(key, value)?;
            log::debug!("Stored secret '{}' in encrypted DB", key);
        }
        Ok(())
    }

    /// Get a secret value
    pub fn get(key: &str) -> Result<String> {
        // Try keychain first
        if is_keychain_available() {
            match keychain_get(key) {
                Ok(value) => return Ok(value),
                Err(SecretError::NotFound(_)) => {
                    // Fall through to try DB
                }
                Err(e) => return Err(e),
            }
        }

        // Try encrypted DB
        ensure_secrets_table()?;
        db_get_decrypted(key)
    }

    /// Delete a secret
    pub fn delete(key: &str) -> Result<()> {
        let mut deleted = false;

        // Try to delete from keychain
        if is_keychain_available() {
            if keychain_delete(key).is_ok() {
                deleted = true;
            }
        }

        // Also try to delete from DB (in case it was migrated)
        if ensure_secrets_table().is_ok() {
            if db_delete(key).is_ok() {
                deleted = true;
            }
        }

        if deleted {
            log::debug!("Deleted secret '{}'", key);
        }
        Ok(())
    }

    /// Check if a secret exists
    pub fn exists(key: &str) -> bool {
        Self::get(key).is_ok()
    }

    /// Get the current storage backend
    pub fn get_backend() -> StorageBackend {
        if is_keychain_available() {
            StorageBackend::OsKeychain
        } else {
            StorageBackend::EncryptedDb
        }
    }

    // ========== Typed Convenience Methods ==========

    /// Store Ely.by authentication token
    pub fn store_auth_token(token: &str) -> Result<()> {
        Self::store("ely_by_token", token)
    }

    /// Get Ely.by authentication token
    pub fn get_auth_token() -> Result<String> {
        Self::get("ely_by_token")
    }

    /// Delete Ely.by authentication token
    pub fn delete_auth_token() -> Result<()> {
        Self::delete("ely_by_token")
    }

    /// Check if Ely.by token exists
    pub fn has_auth_token() -> bool {
        Self::exists("ely_by_token")
    }

    /// Store Microsoft access token
    pub fn store_microsoft_access_token(token: &str) -> Result<()> {
        Self::store("microsoft_access_token", token)
    }

    /// Get Microsoft access token
    pub fn get_microsoft_access_token() -> Result<String> {
        Self::get("microsoft_access_token")
    }

    /// Store Microsoft refresh token
    pub fn store_microsoft_refresh_token(token: &str) -> Result<()> {
        Self::store("microsoft_refresh_token", token)
    }

    /// Get Microsoft refresh token
    pub fn get_microsoft_refresh_token() -> Result<String> {
        Self::get("microsoft_refresh_token")
    }

    /// Store RCON password for an instance
    pub fn store_rcon_password(instance_id: &str, password: &str) -> Result<()> {
        Self::store(&format!("rcon_password_{}", instance_id), password)
    }

    /// Get RCON password for an instance
    pub fn get_rcon_password(instance_id: &str) -> Result<String> {
        Self::get(&format!("rcon_password_{}", instance_id))
    }

    /// Delete RCON password for an instance
    pub fn delete_rcon_password(instance_id: &str) -> Result<()> {
        Self::delete(&format!("rcon_password_{}", instance_id))
    }

    // ========== Batch Operations ==========

    /// Store multiple secrets at once
    pub fn store_batch(secrets: &[(&str, &str)]) -> Result<()> {
        for (key, value) in secrets {
            Self::store(key, value)?;
        }
        Ok(())
    }

    /// Delete multiple secrets at once
    pub fn delete_batch(keys: &[&str]) -> Result<()> {
        for key in keys {
            Self::delete(key)?;
        }
        Ok(())
    }
}

// ============================================================================
// Startup Diagnostic Test
// ============================================================================

/// Result of the startup diagnostic test
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecureStorageTestResult {
    /// Whether the test passed
    pub success: bool,
    /// Which backend is being used
    pub backend: String,
    /// Detailed message
    pub message: String,
    /// Time taken in milliseconds
    pub time_ms: u64,
}

/// Run a diagnostic test of the secure storage system
/// Call this at app startup to verify everything works
pub fn run_startup_test() -> SecureStorageTestResult {
    use std::time::Instant;
    let start = Instant::now();

    let test_key = "__stuzhik_startup_test__";
    let test_value = "test_value_12345";

    // Determine backend
    let backend = match SecureVault::get_backend() {
        StorageBackend::OsKeychain => "os_keychain",
        StorageBackend::EncryptedDb => "encrypted_db",
    };

    // Test roundtrip: store → get → verify → delete
    let result = (|| -> Result<()> {
        // Store
        SecureVault::store(test_key, test_value)?;

        // Get and verify
        let retrieved = SecureVault::get(test_key)?;
        if retrieved != test_value {
            return Err(SecretError::DecryptionError(
                "Value mismatch after roundtrip".to_string(),
            ));
        }

        // Delete
        SecureVault::delete(test_key)?;

        // Verify deleted
        if SecureVault::exists(test_key) {
            return Err(SecretError::DatabaseError(
                "Key still exists after deletion".to_string(),
            ));
        }

        Ok(())
    })();

    let time_ms = start.elapsed().as_millis() as u64;

    match result {
        Ok(()) => {
            let msg = format!(
                "SecureVault OK: backend={}, roundtrip={}ms",
                backend, time_ms
            );
            log::info!("[SECRETS] {}", msg);
            SecureStorageTestResult {
                success: true,
                backend: backend.to_string(),
                message: msg,
                time_ms,
            }
        }
        Err(e) => {
            let msg = format!("SecureVault FAILED: backend={}, error={}", backend, e);
            log::error!("[SECRETS] {}", msg);
            SecureStorageTestResult {
                success: false,
                backend: backend.to_string(),
                message: msg,
                time_ms,
            }
        }
    }
}

// ============================================================================
// Tauri Commands
// ============================================================================

use crate::error::Result as AppResult;
use stuzhik_core::error::LauncherError;

impl From<SecretError> for LauncherError {
    fn from(err: SecretError) -> Self {
        LauncherError::InvalidConfig(err.to_string())
    }
}

/// Store a secret securely
#[tauri::command]
pub async fn store_secret(key: String, value: String) -> AppResult<()> {
    SecureVault::store(&key, &value)?;
    Ok(())
}

/// Get a secret
#[tauri::command]
pub async fn get_secret(key: String) -> AppResult<Option<String>> {
    match SecureVault::get(&key) {
        Ok(value) => Ok(Some(value)),
        Err(SecretError::NotFound(_)) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Delete a secret
#[tauri::command]
pub async fn delete_secret(key: String) -> AppResult<()> {
    SecureVault::delete(&key)?;
    Ok(())
}

/// Check if a secret exists
#[tauri::command]
pub async fn has_secret(key: String) -> AppResult<bool> {
    Ok(SecureVault::exists(&key))
}

/// Get current storage backend info
#[tauri::command]
pub async fn get_storage_backend() -> AppResult<String> {
    Ok(match SecureVault::get_backend() {
        StorageBackend::OsKeychain => "os_keychain".to_string(),
        StorageBackend::EncryptedDb => "encrypted_db".to_string(),
    })
}

/// Run diagnostic test and return result
#[tauri::command]
pub async fn test_secure_storage() -> AppResult<SecureStorageTestResult> {
    Ok(run_startup_test())
}

// Legacy compatibility commands
#[tauri::command]
pub async fn store_auth_token(token: String) -> AppResult<()> {
    SecureVault::store_auth_token(&token)?;
    Ok(())
}

#[tauri::command]
pub async fn get_auth_token() -> AppResult<Option<String>> {
    match SecureVault::get_auth_token() {
        Ok(token) => Ok(Some(token)),
        Err(SecretError::NotFound(_)) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

#[tauri::command]
pub async fn delete_auth_token() -> AppResult<()> {
    SecureVault::delete_auth_token()?;
    Ok(())
}

#[tauri::command]
pub async fn has_auth_token() -> AppResult<bool> {
    Ok(SecureVault::has_auth_token())
}

#[tauri::command]
pub async fn store_rcon_password(instance_id: String, password: String) -> AppResult<()> {
    SecureVault::store_rcon_password(&instance_id, &password)?;
    Ok(())
}

#[tauri::command]
pub async fn get_rcon_password(instance_id: String) -> AppResult<Option<String>> {
    match SecureVault::get_rcon_password(&instance_id) {
        Ok(password) => Ok(Some(password)),
        Err(SecretError::NotFound(_)) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

#[tauri::command]
pub async fn delete_rcon_password(instance_id: String) -> AppResult<()> {
    SecureVault::delete_rcon_password(&instance_id)?;
    Ok(())
}

/// Migrate legacy plaintext secrets to secure storage
#[tauri::command]
pub async fn migrate_legacy_secrets() -> AppResult<MigrationResult> {
    let mut result = MigrationResult::default();
    result.backend_used = Some(
        match SecureVault::get_backend() {
            StorageBackend::OsKeychain => "os_keychain",
            StorageBackend::EncryptedDb => "encrypted_db",
        }
        .to_string(),
    );

    // Ensure secrets table exists for fallback
    let _ = ensure_secrets_table();

    if let Ok(conn) = crate::db::get_db_conn() {
        // Migrate ely_by_client_token from settings
        if let Ok(mut stmt) =
            conn.prepare("SELECT value FROM settings WHERE key = 'ely_by_client_token'")
        {
            if let Ok(token) = stmt.query_row([], |row| row.get::<_, String>(0)) {
                if !token.is_empty() && SecureVault::store_auth_token(&token).is_ok() {
                    let _ =
                        conn.execute("DELETE FROM settings WHERE key = 'ely_by_client_token'", []);
                    result.ely_by_token_migrated = true;
                    log::info!("Migrated ely_by_client_token to secure storage");
                }
            }
        }

        // Migrate RCON passwords from instances
        if let Ok(mut stmt) = conn.prepare(
            "SELECT id, rcon_password FROM instances WHERE rcon_password IS NOT NULL AND rcon_password != ''",
        ) {
            let passwords: Vec<(String, String)> = stmt
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .ok()
                .map(|iter| iter.filter_map(|r| r.ok()).collect())
                .unwrap_or_default();

            for (instance_id, password) in passwords {
                if SecureVault::store_rcon_password(&instance_id, &password).is_ok() {
                    let _ = conn.execute(
                        "UPDATE instances SET rcon_password = NULL WHERE id = ?1",
                        [&instance_id],
                    );
                    result.rcon_passwords_migrated += 1;
                    log::info!("Migrated RCON password for instance {}", instance_id);
                }
            }
        }
    }

    Ok(result)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        // Force key derivation
        let _ = get_master_key();

        let plaintext = b"Hello, World! This is a test.";
        let encrypted = encrypt_data(plaintext).unwrap();

        // Verify format: nonce + ciphertext + tag
        assert!(encrypted.len() > NONCE_SIZE + 16);

        let decrypted = decrypt_data(&encrypted).unwrap();
        assert_eq!(plaintext.as_slice(), decrypted.as_slice());
    }

    #[test]
    fn test_different_nonces() {
        let _ = get_master_key();

        let plaintext = b"Same data";
        let enc1 = encrypt_data(plaintext).unwrap();
        let enc2 = encrypt_data(plaintext).unwrap();

        // Different nonces = different ciphertext
        assert_ne!(enc1, enc2);

        // But both decrypt to same value
        let dec1 = decrypt_data(&enc1).unwrap();
        let dec2 = decrypt_data(&enc2).unwrap();
        assert_eq!(dec1, dec2);
    }

    #[test]
    fn test_tamper_detection() {
        let _ = get_master_key();

        let plaintext = b"Sensitive data";
        let mut encrypted = encrypt_data(plaintext).unwrap();

        // Tamper with ciphertext
        if let Some(byte) = encrypted.get_mut(NONCE_SIZE + 5) {
            *byte ^= 0xFF;
        }

        // Should fail decryption (auth tag invalid)
        assert!(decrypt_data(&encrypted).is_err());
    }

    #[test]
    fn test_backend_detection() {
        let backend = SecureVault::get_backend();
        // Just verify it returns something valid
        assert!(matches!(
            backend,
            StorageBackend::OsKeychain | StorageBackend::EncryptedDb
        ));
    }
}
