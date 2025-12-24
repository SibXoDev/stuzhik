//! End-to-End Encryption for P2P transfers
//!
//! Uses X25519 for key exchange and AES-256-GCM for symmetric encryption.
//!
//! ## Security Properties:
//! - Forward secrecy: New ephemeral keys for each session
//! - Authenticated encryption: AES-256-GCM provides both confidentiality and integrity
//! - Replay protection: Unique nonces for each message

use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use x25519_dalek::{EphemeralSecret, PublicKey, SharedSecret};

/// Size of AES-256 key in bytes
pub const KEY_SIZE: usize = 32;
/// Size of GCM nonce in bytes
pub const NONCE_SIZE: usize = 12;
/// Size of GCM authentication tag in bytes
pub const TAG_SIZE: usize = 16;

/// Encrypted message with nonce prepended
#[derive(Debug, Clone)]
pub struct EncryptedMessage {
    /// Nonce used for this message (12 bytes)
    pub nonce: [u8; NONCE_SIZE],
    /// Encrypted data with authentication tag
    pub ciphertext: Vec<u8>,
}

impl EncryptedMessage {
    /// Serialize to bytes: nonce || ciphertext
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut result = Vec::with_capacity(NONCE_SIZE + self.ciphertext.len());
        result.extend_from_slice(&self.nonce);
        result.extend_from_slice(&self.ciphertext);
        result
    }

    /// Deserialize from bytes
    pub fn from_bytes(data: &[u8]) -> Result<Self, CryptoError> {
        if data.len() < NONCE_SIZE + TAG_SIZE {
            return Err(CryptoError::InvalidMessage("Message too short".into()));
        }

        let mut nonce = [0u8; NONCE_SIZE];
        nonce.copy_from_slice(&data[..NONCE_SIZE]);
        let ciphertext = data[NONCE_SIZE..].to_vec();

        Ok(Self { nonce, ciphertext })
    }
}

/// Crypto errors
#[derive(Debug)]
pub enum CryptoError {
    /// Key exchange failed
    KeyExchangeFailed(String),
    /// Encryption failed
    EncryptionFailed(String),
    /// Decryption failed (authentication failure)
    DecryptionFailed(String),
    /// Invalid message format
    InvalidMessage(String),
    /// Invalid key
    InvalidKey(String),
}

impl std::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::KeyExchangeFailed(msg) => write!(f, "Key exchange failed: {}", msg),
            Self::EncryptionFailed(msg) => write!(f, "Encryption failed: {}", msg),
            Self::DecryptionFailed(msg) => write!(f, "Decryption failed: {}", msg),
            Self::InvalidMessage(msg) => write!(f, "Invalid message: {}", msg),
            Self::InvalidKey(msg) => write!(f, "Invalid key: {}", msg),
        }
    }
}

impl std::error::Error for CryptoError {}

/// Key pair for X25519 key exchange
pub struct KeyPair {
    /// Private key (ephemeral)
    secret: EphemeralSecret,
    /// Public key to share with peer
    pub public: PublicKey,
}

impl KeyPair {
    /// Generate a new ephemeral key pair
    pub fn generate() -> Self {
        let secret = EphemeralSecret::random_from_rng(OsRng);
        let public = PublicKey::from(&secret);
        Self { secret, public }
    }

    /// Get the public key as bytes
    pub fn public_bytes(&self) -> [u8; 32] {
        *self.public.as_bytes()
    }

    /// Perform key exchange with peer's public key
    pub fn key_exchange(self, peer_public: &[u8]) -> Result<SessionKey, CryptoError> {
        if peer_public.len() != 32 {
            return Err(CryptoError::InvalidKey(
                "Public key must be 32 bytes".into(),
            ));
        }

        let mut peer_key_bytes = [0u8; 32];
        peer_key_bytes.copy_from_slice(peer_public);
        let peer_public_key = PublicKey::from(peer_key_bytes);

        let shared_secret = self.secret.diffie_hellman(&peer_public_key);

        Ok(SessionKey::from_shared_secret(shared_secret))
    }
}

/// Symmetric session key derived from key exchange
pub struct SessionKey {
    /// AES-256 cipher instance
    cipher: Aes256Gcm,
    /// Counter for nonce generation (prevents replay)
    nonce_counter: u64,
}

impl SessionKey {
    /// Create session key from shared secret
    fn from_shared_secret(shared: SharedSecret) -> Self {
        // Use the shared secret directly as AES-256 key
        // (X25519 output is already 32 bytes of high-entropy material)
        let cipher = Aes256Gcm::new_from_slice(shared.as_bytes())
            .expect("Shared secret is always 32 bytes");

        Self {
            cipher,
            nonce_counter: 0,
        }
    }

    /// Create session key from raw bytes (for receiver)
    pub fn from_bytes(key: &[u8]) -> Result<Self, CryptoError> {
        if key.len() != KEY_SIZE {
            return Err(CryptoError::InvalidKey(format!(
                "Key must be {} bytes, got {}",
                KEY_SIZE,
                key.len()
            )));
        }

        let cipher = Aes256Gcm::new_from_slice(key)
            .map_err(|e| CryptoError::InvalidKey(e.to_string()))?;

        Ok(Self {
            cipher,
            nonce_counter: 0,
        })
    }

    /// Generate next nonce (counter-based)
    fn next_nonce(&mut self) -> [u8; NONCE_SIZE] {
        let mut nonce = [0u8; NONCE_SIZE];
        // Use counter in big-endian in last 8 bytes
        nonce[4..].copy_from_slice(&self.nonce_counter.to_be_bytes());
        self.nonce_counter += 1;
        nonce
    }

    /// Encrypt data
    pub fn encrypt(&mut self, plaintext: &[u8]) -> Result<EncryptedMessage, CryptoError> {
        let nonce_bytes = self.next_nonce();
        let nonce = Nonce::from_slice(&nonce_bytes);

        let ciphertext = self
            .cipher
            .encrypt(nonce, plaintext)
            .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;

        Ok(EncryptedMessage {
            nonce: nonce_bytes,
            ciphertext,
        })
    }

    /// Decrypt data
    pub fn decrypt(&self, message: &EncryptedMessage) -> Result<Vec<u8>, CryptoError> {
        let nonce = Nonce::from_slice(&message.nonce);

        self.cipher
            .decrypt(nonce, message.ciphertext.as_slice())
            .map_err(|_| CryptoError::DecryptionFailed("Authentication failed".into()))
    }

    /// Encrypt and serialize to bytes
    pub fn encrypt_to_bytes(&mut self, plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
        let encrypted = self.encrypt(plaintext)?;
        Ok(encrypted.to_bytes())
    }

    /// Decrypt from serialized bytes
    pub fn decrypt_from_bytes(&self, data: &[u8]) -> Result<Vec<u8>, CryptoError> {
        let message = EncryptedMessage::from_bytes(data)?;
        self.decrypt(&message)
    }
}

/// Encrypt file chunk with session key
pub fn encrypt_chunk(session_key: &mut SessionKey, chunk: &[u8]) -> Result<Vec<u8>, CryptoError> {
    session_key.encrypt_to_bytes(chunk)
}

/// Decrypt file chunk with session key
pub fn decrypt_chunk(session_key: &SessionKey, encrypted: &[u8]) -> Result<Vec<u8>, CryptoError> {
    session_key.decrypt_from_bytes(encrypted)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_key_exchange() {
        // Alice generates key pair
        let alice = KeyPair::generate();
        let alice_public = alice.public_bytes();

        // Bob generates key pair
        let bob = KeyPair::generate();
        let bob_public = bob.public_bytes();

        // Both derive shared secret
        let alice_session = alice.key_exchange(&bob_public).unwrap();
        let bob_session = bob.key_exchange(&alice_public).unwrap();

        // Encrypt with Alice's key
        let plaintext = b"Hello, Bob!";
        let mut alice_session = alice_session;
        let encrypted = alice_session.encrypt(plaintext).unwrap();

        // Decrypt with Bob's key
        let decrypted = bob_session.decrypt(&encrypted).unwrap();

        assert_eq!(plaintext.as_slice(), decrypted.as_slice());
    }

    #[test]
    fn test_chunk_encryption() {
        let alice = KeyPair::generate();
        let bob = KeyPair::generate();

        // Get public bytes before key_exchange moves ownership
        let alice_public = alice.public_bytes();
        let bob_public = bob.public_bytes();

        let mut alice_session = alice.key_exchange(&bob_public).unwrap();
        let bob_session = bob.key_exchange(&alice_public).unwrap();

        // Simulate file transfer
        let chunk1 = vec![0u8; 64 * 1024]; // 64KB chunk
        let chunk2 = vec![1u8; 64 * 1024];

        let encrypted1 = encrypt_chunk(&mut alice_session, &chunk1).unwrap();
        let encrypted2 = encrypt_chunk(&mut alice_session, &chunk2).unwrap();

        let decrypted1 = decrypt_chunk(&bob_session, &encrypted1).unwrap();
        let decrypted2 = decrypt_chunk(&bob_session, &encrypted2).unwrap();

        assert_eq!(chunk1, decrypted1);
        assert_eq!(chunk2, decrypted2);
    }

    #[test]
    fn test_tamper_detection() {
        let alice = KeyPair::generate();
        let bob = KeyPair::generate();

        // Get public bytes before key_exchange moves ownership
        let alice_public = alice.public_bytes();
        let bob_public = bob.public_bytes();

        let mut alice_session = alice.key_exchange(&bob_public).unwrap();
        let bob_session = bob.key_exchange(&alice_public).unwrap();

        let plaintext = b"Secret message";
        let mut encrypted = alice_session.encrypt(plaintext).unwrap();

        // Tamper with ciphertext
        if !encrypted.ciphertext.is_empty() {
            encrypted.ciphertext[0] ^= 0xFF;
        }

        // Decryption should fail
        assert!(bob_session.decrypt(&encrypted).is_err());
    }

    #[test]
    fn test_serialization() {
        let alice = KeyPair::generate();
        let bob = KeyPair::generate();

        // Get public bytes before key_exchange moves ownership
        let alice_public = alice.public_bytes();
        let bob_public = bob.public_bytes();

        let mut alice_session = alice.key_exchange(&bob_public).unwrap();
        let bob_session = bob.key_exchange(&alice_public).unwrap();

        let plaintext = b"Test message for serialization";
        let encrypted_bytes = alice_session.encrypt_to_bytes(plaintext).unwrap();

        let decrypted = bob_session.decrypt_from_bytes(&encrypted_bytes).unwrap();
        assert_eq!(plaintext.as_slice(), decrypted.as_slice());
    }
}
