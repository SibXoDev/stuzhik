//! Система доверенных друзей с публичными ключами
//!
//! Использует Ed25519 для подписи и верификации.

use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Информация о доверенном друге
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustedFriend {
    /// Публичный ключ друга (base64)
    pub public_key: String,
    /// Никнейм друга
    pub nickname: String,
    /// Дата добавления
    pub added_at: String,
    /// Заметка о друге
    pub note: Option<String>,
}

/// Менеджер друзей
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FriendsManager {
    /// Наш приватный ключ (base64) - хранится только локально
    #[serde(skip_serializing_if = "Option::is_none")]
    pub private_key: Option<String>,
    /// Наш публичный ключ (base64)
    pub public_key: Option<String>,
    /// Список доверенных друзей (ключ -> данные)
    pub friends: HashMap<String, TrustedFriend>,
}

impl FriendsManager {
    /// Создать нового менеджера
    pub fn new() -> Self {
        Self::default()
    }

    /// Генерация новой пары ключей Ed25519
    pub fn generate_keypair(&mut self) -> Result<String, String> {
        // Генерируем криптографически безопасную пару ключей Ed25519
        let signing_key = SigningKey::generate(&mut OsRng);
        let verifying_key = signing_key.verifying_key();

        // Сохраняем ключи в base64
        let private_key = STANDARD.encode(signing_key.to_bytes());
        let public_key = STANDARD.encode(verifying_key.to_bytes());

        self.private_key = Some(private_key);
        self.public_key = Some(public_key.clone());

        log::info!("Generated new Ed25519 keypair, public key: {}", public_key);

        Ok(public_key)
    }

    /// Подписать данные нашим приватным ключом
    pub fn sign(&self, data: &[u8]) -> Result<String, String> {
        let private_key = self
            .private_key
            .as_ref()
            .ok_or_else(|| "No private key available".to_string())?;

        let key_bytes = STANDARD
            .decode(private_key)
            .map_err(|e| format!("Failed to decode private key: {}", e))?;

        let key_array: [u8; 32] = key_bytes
            .try_into()
            .map_err(|_| "Invalid private key length")?;

        let signing_key = SigningKey::from_bytes(&key_array);
        let signature = signing_key.sign(data);

        Ok(STANDARD.encode(signature.to_bytes()))
    }

    /// Проверить подпись публичным ключом друга
    pub fn verify(&self, public_key: &str, data: &[u8], signature: &str) -> Result<bool, String> {
        let key_bytes = STANDARD
            .decode(public_key)
            .map_err(|e| format!("Failed to decode public key: {}", e))?;

        let key_array: [u8; 32] = key_bytes
            .try_into()
            .map_err(|_| "Invalid public key length")?;

        let verifying_key = VerifyingKey::from_bytes(&key_array)
            .map_err(|e| format!("Invalid public key: {}", e))?;

        let sig_bytes = STANDARD
            .decode(signature)
            .map_err(|e| format!("Failed to decode signature: {}", e))?;

        let sig_array: [u8; 64] = sig_bytes
            .try_into()
            .map_err(|_| "Invalid signature length")?;

        let sig = Signature::from_bytes(&sig_array);

        Ok(verifying_key.verify(data, &sig).is_ok())
    }

    /// Получить публичный ключ
    pub fn get_public_key(&self) -> Option<&str> {
        self.public_key.as_deref()
    }

    /// Добавить друга
    pub fn add_friend(
        &mut self,
        public_key: String,
        nickname: String,
        note: Option<String>,
    ) -> Result<(), String> {
        if self.friends.contains_key(&public_key) {
            return Err("Friend already exists".to_string());
        }

        let friend = TrustedFriend {
            public_key: public_key.clone(),
            nickname,
            added_at: chrono::Utc::now().to_rfc3339(),
            note,
        };

        self.friends.insert(public_key, friend);
        Ok(())
    }

    /// Удалить друга
    pub fn remove_friend(&mut self, public_key: &str) -> bool {
        self.friends.remove(public_key).is_some()
    }

    /// Проверить является ли пир доверенным другом
    pub fn is_friend(&self, public_key: &str) -> bool {
        self.friends.contains_key(public_key)
    }

    /// Получить друга по публичному ключу
    pub fn get_friend(&self, public_key: &str) -> Option<&TrustedFriend> {
        self.friends.get(public_key)
    }

    /// Получить всех друзей
    pub fn list_friends(&self) -> Vec<&TrustedFriend> {
        self.friends.values().collect()
    }

    /// Обновить никнейм друга
    pub fn update_friend_nickname(
        &mut self,
        public_key: &str,
        nickname: String,
    ) -> Result<(), String> {
        if let Some(friend) = self.friends.get_mut(public_key) {
            friend.nickname = nickname;
            Ok(())
        } else {
            Err("Friend not found".to_string())
        }
    }

    /// Обновить заметку о друге
    pub fn update_friend_note(
        &mut self,
        public_key: &str,
        note: Option<String>,
    ) -> Result<(), String> {
        if let Some(friend) = self.friends.get_mut(public_key) {
            friend.note = note;
            Ok(())
        } else {
            Err("Friend not found".to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_friends_manager() {
        let mut manager = FriendsManager::new();

        // Генерируем ключи
        let public_key = manager.generate_keypair().unwrap();
        assert!(!public_key.is_empty());
        assert_eq!(public_key.len(), 44); // Base64 encoded 32 bytes

        // Добавляем друга
        manager
            .add_friend("friend_key".to_string(), "Test Friend".to_string(), None)
            .unwrap();

        // Проверяем
        assert!(manager.is_friend("friend_key"));
        assert!(!manager.is_friend("unknown_key"));

        // Удаляем
        assert!(manager.remove_friend("friend_key"));
        assert!(!manager.is_friend("friend_key"));
    }

    #[test]
    fn test_ed25519_sign_verify() {
        let mut manager = FriendsManager::new();
        manager.generate_keypair().unwrap();

        let data = b"Hello, Stuzhik!";

        // Подписываем данные
        let signature = manager.sign(data).unwrap();
        assert!(!signature.is_empty());

        // Проверяем подпись своим публичным ключом
        let public_key = manager.get_public_key().unwrap();
        let valid = manager.verify(public_key, data, &signature).unwrap();
        assert!(valid);

        // Проверяем что изменённые данные не проходят верификацию
        let invalid = manager
            .verify(public_key, b"Modified data", &signature)
            .unwrap();
        assert!(!invalid);
    }

    #[test]
    fn test_cross_verification() {
        // Создаём двух пользователей
        let mut alice = FriendsManager::new();
        let mut bob = FriendsManager::new();

        alice.generate_keypair().unwrap();
        bob.generate_keypair().unwrap();

        let alice_public = alice.get_public_key().unwrap().to_string();
        let bob_public = bob.get_public_key().unwrap().to_string();

        // Alice добавляет Bob как друга
        alice
            .add_friend(bob_public.clone(), "Bob".to_string(), None)
            .unwrap();
        // Bob добавляет Alice как друга
        bob.add_friend(alice_public.clone(), "Alice".to_string(), None)
            .unwrap();

        // Alice подписывает сообщение
        let message = b"Trust message from Alice";
        let signature = alice.sign(message).unwrap();

        // Bob проверяет подпись Alice
        let valid = bob.verify(&alice_public, message, &signature).unwrap();
        assert!(valid);
    }
}
