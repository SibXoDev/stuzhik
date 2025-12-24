use serde::{de::DeserializeOwned, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

/// Запись в кеше с временем истечения
struct CacheEntry {
    data: String, // Сериализованные данные (JSON)
    expires_at: Instant,
}

/// TTL (время жизни) для разных типов данных
#[derive(Clone, Copy)]
pub enum CacheTTL {
    /// Короткий срок для часто меняющихся данных (5 минут)
    Short,
    /// Средний срок для поиска (15 минут)
    Medium,
    /// Длинный срок для редко меняющихся данных (1 час)
    Long,
    /// Для статичных данных (24 часа)
    Static,
    /// Пользовательский TTL
    Custom(Duration),
}

impl CacheTTL {
    pub fn duration(&self) -> Duration {
        match self {
            CacheTTL::Short => Duration::from_secs(5 * 60), // 5 минут
            CacheTTL::Medium => Duration::from_secs(15 * 60), // 15 минут
            CacheTTL::Long => Duration::from_secs(60 * 60), // 1 час
            CacheTTL::Static => Duration::from_secs(24 * 60 * 60), // 24 часа
            CacheTTL::Custom(d) => *d,
        }
    }
}

/// Потокобезопасный кеш для API-ответов
pub struct ApiCache {
    cache: Arc<RwLock<HashMap<String, CacheEntry>>>,
    max_entries: usize,
}

impl ApiCache {
    /// Создаёт новый кеш с максимальным количеством записей
    pub fn new(max_entries: usize) -> Self {
        Self {
            cache: Arc::new(RwLock::new(HashMap::new())),
            max_entries,
        }
    }

    /// Генерирует ключ кеша из URL и параметров
    pub fn make_key(base: &str, params: &[(&str, &str)]) -> String {
        let mut key = base.to_string();
        if !params.is_empty() {
            let params_str: Vec<String> =
                params.iter().map(|(k, v)| format!("{}={}", k, v)).collect();
            key.push('?');
            key.push_str(&params_str.join("&"));
        }
        key
    }

    /// Получает значение из кеша если оно есть и не истекло
    pub async fn get<T: DeserializeOwned>(&self, key: &str) -> Option<T> {
        let cache = self.cache.read().await;

        if let Some(entry) = cache.get(key) {
            if entry.expires_at > Instant::now() {
                // Данные всё ещё актуальны
                return serde_json::from_str(&entry.data).ok();
            }
        }

        None
    }

    /// Сохраняет значение в кеш
    pub async fn set<T: Serialize>(&self, key: &str, value: &T, ttl: CacheTTL) {
        let data = match serde_json::to_string(value) {
            Ok(d) => d,
            Err(e) => {
                log::warn!("Failed to serialize cache value: {}", e);
                return;
            }
        };

        let entry = CacheEntry {
            data,
            expires_at: Instant::now() + ttl.duration(),
        };

        let mut cache = self.cache.write().await;

        // Очистка если превышен лимит
        if cache.len() >= self.max_entries {
            self.cleanup_expired_inner(&mut cache);

            // Если всё ещё много - удаляем самые старые
            if cache.len() >= self.max_entries {
                let oldest_keys: Vec<String> = {
                    let mut entries: Vec<_> = cache
                        .iter()
                        .map(|(k, v)| (k.clone(), v.expires_at))
                        .collect();
                    entries.sort_by_key(|(_, exp)| *exp);
                    entries
                        .into_iter()
                        .take(self.max_entries / 4) // Удаляем 25% старых записей
                        .map(|(k, _)| k)
                        .collect()
                };

                for key in oldest_keys {
                    cache.remove(&key);
                }
            }
        }

        cache.insert(key.to_string(), entry);
    }

    /// Получает значение из кеша или выполняет функцию для получения данных
    pub async fn get_or_fetch<T, F, Fut>(
        &self,
        key: &str,
        ttl: CacheTTL,
        fetch: F,
    ) -> crate::error::Result<T>
    where
        T: Serialize + DeserializeOwned + Clone,
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = crate::error::Result<T>>,
    {
        // Пробуем получить из кеша
        if let Some(cached) = self.get::<T>(key).await {
            log::debug!("Cache hit for: {}", key);
            return Ok(cached);
        }

        log::debug!("Cache miss for: {}", key);

        // Получаем данные
        let data = fetch().await?;

        // Сохраняем в кеш
        self.set(key, &data, ttl).await;

        Ok(data)
    }

    /// Получает значение из кеша или выполняет функцию с rate limiting
    pub async fn get_or_fetch_throttled<T, F, Fut>(
        &self,
        key: &str,
        ttl: CacheTTL,
        limiter: &RateLimiter,
        fetch: F,
    ) -> crate::error::Result<T>
    where
        T: Serialize + DeserializeOwned + Clone,
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = crate::error::Result<T>>,
    {
        // Пробуем получить из кеша (без rate limiting)
        if let Some(cached) = self.get::<T>(key).await {
            log::debug!("Cache hit for: {}", key);
            return Ok(cached);
        }

        log::debug!("Cache miss for: {}, applying rate limit", key);

        // Ждём токен rate limiter перед запросом
        limiter.wait().await;

        // Получаем данные
        let data = fetch().await?;

        // Сохраняем в кеш
        self.set(key, &data, ttl).await;

        Ok(data)
    }

    /// Удаляет запись из кеша
    pub async fn invalidate(&self, key: &str) {
        let mut cache = self.cache.write().await;
        cache.remove(key);
    }

    /// Очищает весь кеш
    pub async fn clear(&self) {
        let mut cache = self.cache.write().await;
        cache.clear();
    }

    fn cleanup_expired_inner(&self, cache: &mut HashMap<String, CacheEntry>) {
        let now = Instant::now();
        cache.retain(|_, entry| entry.expires_at > now);
    }
}

impl Default for ApiCache {
    fn default() -> Self {
        Self::new(1000) // По умолчанию 1000 записей
    }
}

// ============== Rate Limiter ==============

/// Простой rate limiter на основе token bucket
pub struct RateLimiter {
    /// Максимальное количество токенов
    max_tokens: f64,
    /// Скорость пополнения токенов (токенов в секунду)
    refill_rate: f64,
    /// Текущие данные (tokens, last_refill)
    state: Arc<RwLock<(f64, Instant)>>,
}

impl RateLimiter {
    /// Создаёт новый rate limiter
    /// - max_tokens: максимальный burst
    /// - requests_per_second: средняя скорость запросов
    pub fn new(max_tokens: f64, requests_per_second: f64) -> Self {
        Self {
            max_tokens,
            refill_rate: requests_per_second,
            state: Arc::new(RwLock::new((max_tokens, Instant::now()))),
        }
    }

    /// Пытается получить токен. Возвращает время ожидания если токенов нет.
    pub async fn acquire(&self) -> Option<Duration> {
        let mut state = self.state.write().await;
        let (tokens, last_refill) = *state;

        let now = Instant::now();
        let elapsed = now.duration_since(last_refill).as_secs_f64();

        // Пополняем токены
        let new_tokens = (tokens + elapsed * self.refill_rate).min(self.max_tokens);

        if new_tokens >= 1.0 {
            // Есть токен - используем
            *state = (new_tokens - 1.0, now);
            None
        } else {
            // Нет токенов - возвращаем время ожидания
            *state = (new_tokens, now);
            let wait_time = (1.0 - new_tokens) / self.refill_rate;
            Some(Duration::from_secs_f64(wait_time))
        }
    }

    /// Ждёт пока токен не станет доступен
    pub async fn wait(&self) {
        loop {
            if let Some(wait_duration) = self.acquire().await {
                tokio::time::sleep(wait_duration).await;
            } else {
                return;
            }
        }
    }
}

// ============== Глобальные кеши и rate limiters ==============

use std::sync::OnceLock;

static MODRINTH_CACHE: OnceLock<ApiCache> = OnceLock::new();
static CURSEFORGE_CACHE: OnceLock<ApiCache> = OnceLock::new();
static MODRINTH_LIMITER: OnceLock<RateLimiter> = OnceLock::new();
static CURSEFORGE_LIMITER: OnceLock<RateLimiter> = OnceLock::new();

/// Получает глобальный кеш для Modrinth API
pub fn modrinth_cache() -> &'static ApiCache {
    MODRINTH_CACHE.get_or_init(|| ApiCache::new(500))
}

/// Получает глобальный кеш для CurseForge API
pub fn curseforge_cache() -> &'static ApiCache {
    CURSEFORGE_CACHE.get_or_init(|| ApiCache::new(500))
}

/// Получает rate limiter для Modrinth API
/// Modrinth: 300 запросов в минуту = 5 req/s
pub fn modrinth_limiter() -> &'static RateLimiter {
    MODRINTH_LIMITER.get_or_init(|| RateLimiter::new(10.0, 5.0))
}

/// Получает rate limiter для CurseForge API
/// CurseForge: более строгий, ~2 req/s для безопасности
pub fn curseforge_limiter() -> &'static RateLimiter {
    CURSEFORGE_LIMITER.get_or_init(|| RateLimiter::new(5.0, 2.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_cache_basic() {
        let cache = ApiCache::new(10);

        cache
            .set("test_key", &"test_value".to_string(), CacheTTL::Short)
            .await;

        let result: Option<String> = cache.get("test_key").await;
        assert_eq!(result, Some("test_value".to_string()));
    }

    #[tokio::test]
    async fn test_cache_miss() {
        let cache = ApiCache::new(10);

        let result: Option<String> = cache.get("nonexistent").await;
        assert_eq!(result, None);
    }

    #[tokio::test]
    async fn test_make_key() {
        let key = ApiCache::make_key("search", &[("q", "sodium"), ("limit", "20")]);
        assert_eq!(key, "search?q=sodium&limit=20");
    }
}
