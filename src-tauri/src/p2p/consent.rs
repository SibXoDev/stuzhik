//! Система согласий для P2P операций
//!
//! Требует явного согласия пользователя на каждую входящую операцию.
//! Поддерживает "запомнить для этого пира" и блокировку пиров.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{oneshot, RwLock};
use tokio::time::{timeout, Duration};

/// Тип запроса на согласие
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ConsentType {
    Modpack,
    Config,
    Resourcepack,
    Shaderpack,
    FriendRequest,
}

impl std::fmt::Display for ConsentType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConsentType::Modpack => write!(f, "modpack"),
            ConsentType::Config => write!(f, "config"),
            ConsentType::Resourcepack => write!(f, "resourcepack"),
            ConsentType::Shaderpack => write!(f, "shaderpack"),
            ConsentType::FriendRequest => write!(f, "friend_request"),
        }
    }
}

/// Запрос на согласие
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsentRequest {
    /// Уникальный ID запроса
    pub request_id: String,
    /// ID пира
    pub peer_id: String,
    /// Никнейм пира (если известен)
    pub peer_nickname: Option<String>,
    /// Тип запроса
    pub consent_type: ConsentType,
    /// Название контента
    pub content_name: String,
    /// Размер контента в байтах (если известен)
    pub content_size: Option<u64>,
    /// Время создания запроса
    pub created_at: String,
}

/// Ответ на запрос согласия
#[derive(Debug, Clone)]
pub struct ConsentResponse {
    /// Одобрено ли
    pub approved: bool,
    /// Запомнить выбор для этого пира
    pub remember: bool,
}

/// Ожидающий запрос с каналом ответа
struct PendingRequest {
    request: ConsentRequest,
    response_tx: oneshot::Sender<ConsentResponse>,
}

/// Менеджер согласий
pub struct ConsentManager {
    /// Ожидающие запросы: request_id -> (request, response_channel)
    pending: Arc<RwLock<HashMap<String, PendingRequest>>>,
    /// Таймаут ожидания ответа (в секундах)
    timeout_secs: u64,
}

impl ConsentManager {
    pub fn new() -> Self {
        Self {
            pending: Arc::new(RwLock::new(HashMap::new())),
            timeout_secs: 120, // 2 минуты на ответ
        }
    }

    /// Создать запрос на согласие и ожидать ответ
    ///
    /// Возвращает (request, receiver для ожидания ответа)
    pub async fn create_request(
        &self,
        peer_id: String,
        peer_nickname: Option<String>,
        consent_type: ConsentType,
        content_name: String,
        content_size: Option<u64>,
    ) -> (ConsentRequest, oneshot::Receiver<ConsentResponse>) {
        let request_id = uuid::Uuid::new_v4().to_string();
        let created_at = chrono::Utc::now().to_rfc3339();

        let request = ConsentRequest {
            request_id: request_id.clone(),
            peer_id,
            peer_nickname,
            consent_type,
            content_name,
            content_size,
            created_at,
        };

        let (tx, rx) = oneshot::channel();

        let pending = PendingRequest {
            request: request.clone(),
            response_tx: tx,
        };

        self.pending.write().await.insert(request_id, pending);

        (request, rx)
    }

    /// Ответить на запрос согласия
    pub async fn respond(&self, request_id: &str, approved: bool, remember: bool) -> Result<(), String> {
        let pending = self.pending.write().await.remove(request_id);

        match pending {
            Some(pending_request) => {
                let response = ConsentResponse { approved, remember };

                // Отправляем ответ (игнорируем ошибку если receiver уже закрыт)
                let _ = pending_request.response_tx.send(response);

                log::info!(
                    "Consent response for {}: approved={}, remember={}",
                    request_id, approved, remember
                );

                Ok(())
            }
            None => {
                log::warn!("Consent request {} not found or already expired", request_id);
                Err(format!("Consent request {} not found", request_id))
            }
        }
    }

    /// Ожидать ответ на запрос с таймаутом
    pub async fn wait_for_response(
        &self,
        rx: oneshot::Receiver<ConsentResponse>,
    ) -> Option<ConsentResponse> {
        match timeout(Duration::from_secs(self.timeout_secs), rx).await {
            Ok(Ok(response)) => Some(response),
            Ok(Err(_)) => {
                log::warn!("Consent response channel closed");
                None
            }
            Err(_) => {
                log::warn!("Consent request timed out after {} seconds", self.timeout_secs);
                None
            }
        }
    }

    /// Получить список ожидающих запросов
    pub async fn get_pending_requests(&self) -> Vec<ConsentRequest> {
        self.pending
            .read()
            .await
            .values()
            .map(|p| p.request.clone())
            .collect()
    }

    /// Отменить запрос (удалить без ответа)
    pub async fn cancel_request(&self, request_id: &str) {
        self.pending.write().await.remove(request_id);
        log::debug!("Consent request {} cancelled", request_id);
    }

    /// Очистить просроченные запросы
    pub async fn cleanup_expired(&self) {
        let now = chrono::Utc::now();
        let mut pending = self.pending.write().await;

        pending.retain(|id, p| {
            if let Ok(created) = chrono::DateTime::parse_from_rfc3339(&p.request.created_at) {
                let age = now.signed_duration_since(created);
                if age.num_seconds() > self.timeout_secs as i64 {
                    log::debug!("Removing expired consent request: {}", id);
                    return false;
                }
            }
            true
        });
    }
}

impl Default for ConsentManager {
    fn default() -> Self {
        Self::new()
    }
}

// Глобальный экземпляр ConsentManager
use std::sync::OnceLock;

static CONSENT_MANAGER: OnceLock<ConsentManager> = OnceLock::new();

/// Получить глобальный ConsentManager
pub fn get_consent_manager() -> &'static ConsentManager {
    CONSENT_MANAGER.get_or_init(ConsentManager::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_consent_flow() {
        let manager = ConsentManager::new();

        // Создаём запрос
        let (request, rx) = manager
            .create_request(
                "peer123".to_string(),
                Some("TestPeer".to_string()),
                ConsentType::Modpack,
                "TestModpack".to_string(),
                Some(1024 * 1024),
            )
            .await;

        // Проверяем что запрос создан
        let pending = manager.get_pending_requests().await;
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].request_id, request.request_id);

        // Отвечаем на запрос
        manager.respond(&request.request_id, true, false).await.unwrap();

        // Получаем ответ
        let response = rx.await.unwrap();
        assert!(response.approved);
        assert!(!response.remember);

        // Проверяем что запрос удалён
        let pending = manager.get_pending_requests().await;
        assert!(pending.is_empty());
    }

    #[tokio::test]
    async fn test_consent_not_found() {
        let manager = ConsentManager::new();
        let result = manager.respond("nonexistent", true, false).await;
        assert!(result.is_err());
    }
}
