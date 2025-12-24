use lazy_static::lazy_static;
use std::collections::HashMap;
use std::sync::Mutex;
use tokio_util::sync::CancellationToken;

lazy_static! {
    /// Глобальный реестр токенов отмены для активных операций
    static ref CANCELLATION_TOKENS: Mutex<HashMap<String, CancellationToken>> = Mutex::new(HashMap::new());
}

/// Создать новый токен отмены для операции
pub fn create_token(operation_id: &str) -> CancellationToken {
    let token = CancellationToken::new();
    let mut tokens = CANCELLATION_TOKENS
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    tokens.insert(operation_id.to_string(), token.clone());
    log::debug!("Created cancellation token for: {}", operation_id);
    token
}

/// Получить существующий токен или создать новый
pub fn get_or_create_token(operation_id: &str) -> CancellationToken {
    let mut tokens = CANCELLATION_TOKENS
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    tokens
        .entry(operation_id.to_string())
        .or_insert_with(CancellationToken::new)
        .clone()
}

/// Отменить операцию по ID
pub fn cancel(operation_id: &str) -> bool {
    let tokens = CANCELLATION_TOKENS
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(token) = tokens.get(operation_id) {
        token.cancel();
        log::info!("Cancelled operation: {}", operation_id);
        true
    } else {
        log::warn!("No token found for operation: {}", operation_id);
        false
    }
}

/// Удалить токен после завершения операции
pub fn remove_token(operation_id: &str) {
    let mut tokens = CANCELLATION_TOKENS
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    tokens.remove(operation_id);
    log::debug!("Removed cancellation token for: {}", operation_id);
}

/// Проверить, отменена ли операция
pub fn is_cancelled(operation_id: &str) -> bool {
    let tokens = CANCELLATION_TOKENS
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    tokens
        .get(operation_id)
        .map(|t| t.is_cancelled())
        .unwrap_or(false)
}

/// Получить список активных операций
pub fn list_active_operations() -> Vec<String> {
    let tokens = CANCELLATION_TOKENS
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    tokens
        .keys()
        .filter(|k| tokens.get(*k).map(|t| !t.is_cancelled()).unwrap_or(false))
        .cloned()
        .collect()
}
