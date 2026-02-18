use std::collections::HashMap;
use std::sync::Mutex;
use tokio_util::sync::CancellationToken;

/// Глобальный реестр токенов отмены для активных операций
static CANCELLATION_TOKENS: std::sync::LazyLock<Mutex<HashMap<String, CancellationToken>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// Auto-cleanup threshold: when registry exceeds this size, stale tokens are purged.
const AUTO_CLEANUP_THRESHOLD: usize = 50;

/// Создать новый токен отмены для операции.
/// Если для этой операции уже существует токен — он отменяется и заменяется новым.
/// Автоматически очищает stale (отменённые) токены при переполнении реестра.
pub fn create_token(operation_id: &str) -> CancellationToken {
    let token = CancellationToken::new();
    let mut tokens = CANCELLATION_TOKENS
        .lock()
        .unwrap_or_else(|e| e.into_inner());

    // Отменяем старый токен если он был (предотвращает zombie операции)
    if let Some(old_token) = tokens.insert(operation_id.to_string(), token.clone()) {
        if !old_token.is_cancelled() {
            old_token.cancel();
            log::warn!(
                "Replaced active cancellation token for: {} (old token cancelled)",
                operation_id
            );
        }
    }

    // Auto-cleanup: purge cancelled tokens when registry grows too large
    if tokens.len() > AUTO_CLEANUP_THRESHOLD {
        let before = tokens.len();
        tokens.retain(|_, t| !t.is_cancelled());
        let removed = before - tokens.len();
        if removed > 0 {
            log::debug!(
                "Auto-cleaned {} stale tokens (registry was {} entries)",
                removed,
                before
            );
        }
    }

    log::debug!("Created cancellation token for: {}", operation_id);
    token
}

/// Зарегистрировать внешний токен (например, child token) в реестре.
/// Позволяет отменять этот токен по ID через `cancel()`.
pub fn register_token(operation_id: &str, token: CancellationToken) {
    let mut tokens = CANCELLATION_TOKENS
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    tokens.insert(operation_id.to_string(), token);
}

/// Получить существующий АКТИВНЫЙ токен или создать новый.
/// Если существующий токен уже отменён — создаёт свежий (предотвращает мгновенную "отмену").
pub fn get_or_create_token(operation_id: &str) -> CancellationToken {
    let mut tokens = CANCELLATION_TOKENS
        .lock()
        .unwrap_or_else(|e| e.into_inner());

    // Проверяем существующий токен
    if let Some(existing) = tokens.get(operation_id) {
        if !existing.is_cancelled() {
            return existing.clone();
        }
        // Токен отменён — создаём новый
        log::debug!(
            "Replacing cancelled token for: {} with fresh one",
            operation_id
        );
    }

    let token = CancellationToken::new();
    tokens.insert(operation_id.to_string(), token.clone());
    token
}

/// Отменить операцию по ID и удалить токен из реестра.
pub fn cancel(operation_id: &str) -> bool {
    let mut tokens = CANCELLATION_TOKENS
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(token) = tokens.remove(operation_id) {
        if !token.is_cancelled() {
            token.cancel();
            log::info!("Cancelled and removed operation: {}", operation_id);
        } else {
            log::debug!("Removed already-cancelled operation: {}", operation_id);
        }
        true
    } else {
        log::warn!("No token found for operation: {}", operation_id);
        false
    }
}

/// Удалить токен после завершения операции (освобождает память)
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

/// Получить список активных (не отменённых) операций
pub fn list_active_operations() -> Vec<String> {
    let tokens = CANCELLATION_TOKENS
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    tokens
        .iter()
        .filter(|(_, t)| !t.is_cancelled())
        .map(|(k, _)| k.clone())
        .collect()
}

/// Очистить все отменённые и завершённые токены из реестра (предотвращает memory leak).
/// Вызывается автоматически при create_token, или может быть вызвана вручную.
pub fn cleanup_stale_tokens() {
    let mut tokens = CANCELLATION_TOKENS
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let before = tokens.len();
    tokens.retain(|_, t| !t.is_cancelled());
    let removed = before - tokens.len();
    if removed > 0 {
        log::debug!("Cleaned up {} stale cancellation tokens", removed);
    }
}

/// Отменить все операции с указанным префиксом и удалить их из реестра.
/// Например: cancel_by_prefix("instance-install-abc123") отменит установку экземпляра.
pub fn cancel_by_prefix(prefix: &str) -> Vec<String> {
    let mut tokens = CANCELLATION_TOKENS
        .lock()
        .unwrap_or_else(|e| e.into_inner());

    // Collect keys to cancel
    let keys_to_cancel: Vec<String> = tokens
        .iter()
        .filter(|(key, token)| key.starts_with(prefix) && !token.is_cancelled())
        .map(|(key, _)| key.clone())
        .collect();

    // Cancel and remove
    let mut cancelled = Vec::new();
    for key in keys_to_cancel {
        if let Some(token) = tokens.remove(&key) {
            token.cancel();
            log::info!("Cancelled and removed operation by prefix: {}", key);
            cancelled.push(key);
        }
    }

    cancelled
}
