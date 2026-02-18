//! SmartDownloader - модульная система загрузок с централизованным управлением зеркалами
//!
//! # Архитектура
//!
//! - `types.rs` - ResourceType, DownloadConfig, DownloadStatus
//! - `registry.rs` - MirrorRegistry для централизованного управления зеркалами
//! - `mod.rs` - SmartDownloader struct
//!
//! # Использование
//!
//! ```rust,ignore
//! use smart_downloader::{SmartDownloader, DownloadConfig, ResourceType};
//!
//! let downloader = SmartDownloader::new(app_handle)?;
//!
//! // Простая загрузка (автоматически определяет зеркала)
//! downloader.download(url, destination, name, hash).await?;
//!
//! // Загрузка с отменой
//! downloader.download_cancellable(url, destination, name, hash, &cancel_token).await?;
//!
//! // Загрузка Java с специфичными зеркалами
//! downloader.download_java(url, destination, name, hash, version, arch, os, filename, &cancel_token).await?;
//! ```

pub mod registry;
pub mod types;

pub use registry::{MirrorRegistry, MirrorRule};
pub use types::{DownloadConfig, DownloadStatus, MirrorInfo, ResourceType};

// Re-export DownloadTask for convenience (defined at bottom of file)
// pub use DownloadTask; - already in scope as it's in this module

use crate::error::{LauncherError, Result};
use crate::utils::verify_file_hash;
use futures::StreamExt;
use reqwest::Client;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;
use tauri::Emitter;
use tokio::io::{AsyncSeekExt, AsyncWriteExt};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

/// Infer download source from URL for UI badges
fn infer_download_source(url: &str) -> Option<String> {
    if url.contains("modrinth.com") || url.contains("cdn-raw.modrinth.com") {
        Some("modrinth".to_string())
    } else if url.contains("curseforge.com")
        || url.contains("forgecdn.net")
        || url.contains("edge.forgecdn.net")
    {
        Some("curseforge".to_string())
    } else if url.contains("maven.minecraftforge.net") || url.contains("minecraftforge.net") {
        Some("forge".to_string())
    } else if url.contains("fabricmc.net") || url.contains("maven.fabricmc.net") {
        Some("fabric".to_string())
    } else if url.contains("quiltmc.org") {
        Some("quilt".to_string())
    } else if url.contains("neoforged.net") {
        Some("neoforge".to_string())
    } else if url.contains("mojang.com") || url.contains("minecraft.net") {
        Some("minecraft".to_string())
    } else {
        None
    }
}

/// Прогресс загрузки
#[derive(Debug, Clone, serde::Serialize)]
pub struct DownloadProgress {
    pub id: String,
    pub name: String,
    pub downloaded: u64,
    pub total: u64,
    pub speed: u64,
    pub percentage: f32,
    pub status: String,
    pub operation_id: Option<String>,
    /// Source of the download: "modrinth", "curseforge", "forge", "fabric", etc.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// API-aware семафоры для контроля параллельных загрузок
pub struct DownloadSemaphores {
    modrinth: Arc<Semaphore>,
    curseforge: Arc<Semaphore>,
    files: Arc<Semaphore>,
    /// Timestamp последнего старта CurseForge CDN загрузки.
    /// Используется для rate limiting — предотвращает burst новых TCP connections,
    /// который вызывает отказы CDN (edge.forgecdn.net / AmazonS3).
    cf_last_start: Arc<tokio::sync::Mutex<tokio::time::Instant>>,
}

/// Минимальный интервал между стартами CurseForge CDN загрузок (мс).
/// Предотвращает burst новых TCP connections, из-за которого CDN отклоняет соединения.
/// 150ms = максимум ~6.6 новых connections/sec — комфортно для CDN.
const CF_MIN_START_GAP_MS: u64 = 150;

impl Default for DownloadSemaphores {
    fn default() -> Self {
        Self::new()
    }
}

impl DownloadSemaphores {
    pub fn new() -> Self {
        Self {
            modrinth: Arc::new(Semaphore::new(5)),
            curseforge: Arc::new(Semaphore::new(2)),
            files: Arc::new(Semaphore::new(50)),
            cf_last_start: Arc::new(tokio::sync::Mutex::new(
                tokio::time::Instant::now() - std::time::Duration::from_secs(10),
            )),
        }
    }

    /// Получить семафор для типа ресурса
    pub fn for_resource_type(&self, resource_type: ResourceType) -> &Arc<Semaphore> {
        match resource_type {
            ResourceType::Modrinth => &self.modrinth,
            ResourceType::CurseForge => &self.curseforge,
            _ => &self.files,
        }
    }

    /// Enforce minimum gap between CurseForge CDN download starts.
    /// Prevents burst of new TCP connections that causes CDN to drop connections.
    pub async fn throttle_cf_start(&self) {
        let mut last = self.cf_last_start.lock().await;
        let elapsed = last.elapsed();
        let min_gap = std::time::Duration::from_millis(CF_MIN_START_GAP_MS);
        if elapsed < min_gap {
            tokio::time::sleep(min_gap - elapsed).await;
        }
        *last = tokio::time::Instant::now();
    }
}

/// Калькулятор скорости с EMA сглаживанием и санитизацией
struct SpeedCalculator {
    /// EMA скорости (bytes/sec)
    speed_ema: f64,
    /// Последнее количество скачанных байт
    last_bytes: u64,
    /// Время последнего обновления
    last_update: Instant,
    /// Минимальный интервал между обновлениями (для точности)
    min_interval: std::time::Duration,
    /// Максимальная разумная скорость (1 GB/s - выше невозможно для потребительских соединений)
    max_speed: f64,
}

impl SpeedCalculator {
    fn new() -> Self {
        Self {
            speed_ema: 0.0,
            last_bytes: 0,
            last_update: Instant::now(),
            min_interval: std::time::Duration::from_millis(100), // Минимум 100ms между измерениями
            max_speed: 1_000_000_000.0,                          // 1 GB/s cap
        }
    }

    /// Обновить скорость и получить сглаженное значение
    fn update(&mut self, downloaded: u64) -> u64 {
        let now = Instant::now();
        let elapsed = now.duration_since(self.last_update);

        // Не обновляем слишком часто - это даёт нереальные значения
        if elapsed < self.min_interval {
            return self.speed_ema as u64;
        }

        let elapsed_secs = elapsed.as_secs_f64();
        let bytes_delta = downloaded.saturating_sub(self.last_bytes);

        // Вычисляем мгновенную скорость
        let instant_speed = if elapsed_secs > 0.0 {
            bytes_delta as f64 / elapsed_secs
        } else {
            0.0
        };

        // Санитизация - cap на максимальную скорость
        let capped_speed = instant_speed.min(self.max_speed);

        // EMA с alpha = 0.3 (сглаживает скачки)
        if self.speed_ema == 0.0 {
            self.speed_ema = capped_speed;
        } else {
            self.speed_ema = 0.3 * capped_speed + 0.7 * self.speed_ema;
        }

        self.last_bytes = downloaded;
        self.last_update = now;

        self.speed_ema as u64
    }

    /// Получить текущую скорость (без обновления)
    fn current_speed(&self) -> u64 {
        self.speed_ema as u64
    }
}

/// Adaptive stall detection - умный определитель зависания
struct StallDetector {
    last_progress_time: Instant,
    speed_calculator: SpeedCalculator,
    config: DownloadConfig,
}

impl StallDetector {
    fn new(config: DownloadConfig) -> Self {
        Self {
            last_progress_time: Instant::now(),
            speed_calculator: SpeedCalculator::new(),
            config,
        }
    }

    /// Обновить прогресс и получить скорость
    fn update_progress(&mut self, downloaded: u64) -> u64 {
        self.last_progress_time = Instant::now();
        self.speed_calculator.update(downloaded)
    }

    /// Вычислить адаптивный timeout на основе скорости
    fn adaptive_timeout(&self) -> std::time::Duration {
        let speed_bytes = self.speed_calculator.speed_ema;

        if speed_bytes > 1_000_000.0 {
            // > 1 MB/s - 3 сек
            std::time::Duration::from_secs(3)
        } else if speed_bytes > 100_000.0 {
            // 100 KB/s - 1 MB/s - 5 сек
            std::time::Duration::from_secs(5)
        } else if speed_bytes > self.config.speed_threshold as f64 {
            // > threshold - 8 сек
            std::time::Duration::from_secs(8)
        } else {
            // Медленная сеть - используем конфиг
            self.config.stall_timeout
        }
    }

    /// Проверить истёк ли timeout
    fn is_stalled(&self) -> bool {
        self.last_progress_time.elapsed() > self.adaptive_timeout()
    }

    /// Получить timeout в секундах для логирования
    fn timeout_secs(&self) -> u64 {
        self.adaptive_timeout().as_secs()
    }
}

/// Sleep-based rate limiter для bandwidth limiting.
/// В отличие от token bucket с truncation, этот подход ВСЕГДА записывает
/// весь chunk целиком, но замедляет скачивание через sleep.
/// Это предотвращает corrupted файлы из-за обрезанных данных.
struct RateLimiter {
    /// Лимит bytes/sec (0 = без лимита)
    limit: u64,
    /// Время начала текущего окна измерения
    window_start: Instant,
    /// Байт скачано в текущем окне
    window_bytes: u64,
}

impl RateLimiter {
    fn new(limit: u64) -> Self {
        Self {
            limit,
            window_start: Instant::now(),
            window_bytes: 0,
        }
    }

    /// Ждать если нужно для соблюдения лимита скорости.
    /// Весь chunk записывается целиком — throttling через sleep, не через truncation.
    async fn throttle(&mut self, chunk_size: usize) {
        if self.limit == 0 {
            return; // Без лимита
        }

        self.window_bytes += chunk_size as u64;

        let elapsed = self.window_start.elapsed().as_secs_f64();

        // Сколько времени ДОЛЖНО было пройти при заданном лимите
        let expected_time = self.window_bytes as f64 / self.limit as f64;

        if expected_time > elapsed {
            // Мы скачиваем быстрее лимита — нужно подождать
            let sleep_duration = expected_time - elapsed;
            // Cap sleep at 500ms to keep responsive to cancellation
            tokio::time::sleep(std::time::Duration::from_secs_f64(sleep_duration.min(0.5))).await;
        }

        // Сбрасываем окно каждую секунду для предотвращения drift
        if elapsed > 1.0 {
            self.window_start = Instant::now();
            self.window_bytes = 0;
        }
    }
}

/// SmartDownloader - умный загрузчик с централизованным управлением зеркалами
#[derive(Clone)]
pub struct SmartDownloader {
    client: Client,
    app_handle: tauri::AppHandle,
    registry: Arc<MirrorRegistry>,
    config: DownloadConfig,
    semaphores: Arc<DownloadSemaphores>,
}

impl SmartDownloader {
    /// Создать SmartDownloader с конфигурацией по умолчанию
    pub fn new(app_handle: tauri::AppHandle) -> Result<Self> {
        Self::with_config(app_handle, DownloadConfig::default())
    }

    /// Создать SmartDownloader с кастомной конфигурацией
    pub fn with_config(app_handle: tauri::AppHandle, config: DownloadConfig) -> Result<Self> {
        let client = Client::builder()
            .user_agent(crate::USER_AGENT)
            .timeout(config.request_timeout)
            .connect_timeout(config.connect_timeout)
            .build()
            .map_err(|e| {
                LauncherError::InvalidConfig(format!("Failed to create HTTP client: {}", e))
            })?;

        Ok(Self {
            client,
            app_handle,
            registry: Arc::new(MirrorRegistry::new()),
            config,
            semaphores: Arc::new(DownloadSemaphores::new()),
        })
    }

    /// Создать с кастомным реестром зеркал
    pub fn with_registry(
        app_handle: tauri::AppHandle,
        registry: MirrorRegistry,
        config: DownloadConfig,
    ) -> Result<Self> {
        let client = Client::builder()
            .user_agent(crate::USER_AGENT)
            .timeout(config.request_timeout)
            .connect_timeout(config.connect_timeout)
            .build()
            .map_err(|e| {
                LauncherError::InvalidConfig(format!("Failed to create HTTP client: {}", e))
            })?;

        Ok(Self {
            client,
            app_handle,
            registry: Arc::new(registry),
            config,
            semaphores: Arc::new(DownloadSemaphores::new()),
        })
    }

    /// Получить ссылку на app_handle
    pub fn app_handle(&self) -> &tauri::AppHandle {
        &self.app_handle
    }

    /// Получить ссылку на реестр зеркал
    pub fn registry(&self) -> &MirrorRegistry {
        &self.registry
    }

    /// Получить конфигурацию
    pub fn config(&self) -> &DownloadConfig {
        &self.config
    }

    /// Установить лимит скорости загрузки (bytes/sec, 0 = без лимита)
    /// Возвращает новый экземпляр SmartDownloader с обновлённым лимитом
    pub fn with_bandwidth_limit(mut self, bytes_per_sec: u64) -> Self {
        self.config.bandwidth_limit = bytes_per_sec;
        self
    }

    /// Скачать файл (автоматически определяет зеркала по URL)
    pub async fn download<P: AsRef<Path>>(
        &self,
        url: &str,
        destination: P,
        name: &str,
        expected_hash: Option<&str>,
    ) -> Result<()> {
        self.download_internal(url, destination.as_ref(), name, expected_hash, None, None)
            .await
    }

    /// Скачать файл с поддержкой отмены
    pub async fn download_cancellable<P: AsRef<Path>>(
        &self,
        url: &str,
        destination: P,
        name: &str,
        expected_hash: Option<&str>,
        cancel_token: &CancellationToken,
        operation_id: Option<&str>,
    ) -> Result<()> {
        self.download_internal(
            url,
            destination.as_ref(),
            name,
            expected_hash,
            Some(cancel_token),
            operation_id,
        )
        .await
    }

    /// Скачать Java с специфичными зеркалами
    pub async fn download_java<P: AsRef<Path>>(
        &self,
        original_url: &str,
        destination: P,
        name: &str,
        expected_hash: Option<&str>,
        version: u32,
        arch: &str,
        os: &str,
        filename: &str,
        cancel_token: &CancellationToken,
        operation_id: Option<&str>,
    ) -> Result<()> {
        let urls = self
            .registry
            .get_java_mirror_urls(original_url, version, arch, os, filename);
        let download_id = uuid::Uuid::new_v4().to_string();

        self.download_from_mirrors(
            &urls,
            destination.as_ref(),
            name,
            expected_hash,
            Some(cancel_token),
            operation_id,
            &download_id,
        )
        .await
    }

    /// Внутренняя реализация загрузки
    async fn download_internal(
        &self,
        url: &str,
        destination: &Path,
        name: &str,
        expected_hash: Option<&str>,
        cancel_token: Option<&CancellationToken>,
        operation_id: Option<&str>,
    ) -> Result<()> {
        let resource_type = ResourceType::from_url(url);
        let download_id = uuid::Uuid::new_v4().to_string();

        // Создаём child token для индивидуальной отмены этой загрузки
        // Child отменяется когда parent отменяется, но отмена child НЕ отменяет parent
        let child_token = cancel_token.map(|parent| parent.child_token());
        let effective_token = child_token.as_ref().or(cancel_token);

        // Регистрируем child token для индивидуальной отмены по download_id
        if let Some(ref ct) = child_token {
            crate::cancellation::register_token(&download_id, ct.clone());
        }

        // Scope guard: ensure child token is removed from registry even on early returns/errors
        struct TokenGuard(String);
        impl Drop for TokenGuard {
            fn drop(&mut self) {
                crate::cancellation::remove_token(&self.0);
            }
        }
        let _token_guard = TokenGuard(download_id.clone());

        // Получаем семафор для этого типа ресурса
        let semaphore = self.semaphores.for_resource_type(resource_type).clone();
        let _permit = semaphore.acquire().await.map_err(|e| {
            LauncherError::InvalidConfig(format!("Failed to acquire semaphore: {}", e))
        })?;

        // Rate limit CurseForge CDN — prevent burst of new TCP connections
        if resource_type == ResourceType::CurseForge {
            self.semaphores.throttle_cf_start().await;
        }

        // Если тип ресурса имеет зеркала - используем их
        let result = if resource_type.has_mirrors() {
            let urls = self.registry.get_mirror_urls(url);
            self.download_from_mirrors(
                    &urls,
                    destination,
                    name,
                    expected_hash,
                    effective_token,
                    operation_id,
                    &download_id,
                )
                .await
        } else {
            // Простая загрузка без зеркал — с retry для connection-level ошибок
            let source = infer_download_source(url);
            let max_retries = self.config.retries_per_mirror;
            let mut last_err = None;

            for attempt in 0..=max_retries {
                // Проверка отмены перед каждой попыткой
                if let Some(token) = effective_token {
                    if token.is_cancelled() {
                        return Err(LauncherError::OperationCancelled);
                    }
                }

                if attempt > 0 {
                    let delay = self.config.retry_delay_ms * (1 << (attempt - 1));
                    log::info!(
                        "Retrying download {} (attempt {}/{}) after {}ms",
                        name,
                        attempt + 1,
                        max_retries + 1,
                        delay
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                }

                match self
                    .download_single(
                        url,
                        destination,
                        name,
                        expected_hash,
                        effective_token,
                        operation_id,
                        &download_id,
                    )
                    .await
                {
                    Ok(()) => return Ok(()),
                    Err(LauncherError::OperationCancelled) => {
                        return Err(LauncherError::OperationCancelled);
                    }
                    Err(e) => {
                        let is_connection_error = e.to_string().contains("Connection failed")
                            || e.to_string().contains("error sending request");

                        if is_connection_error && attempt < max_retries {
                            log::warn!(
                                "[CDN-DIAG] Connection error for {} (attempt {}/{}): {}",
                                name,
                                attempt + 1,
                                max_retries + 1,
                                e
                            );
                            last_err = Some(e);
                            continue;
                        }

                        // Non-retryable error or last attempt
                        last_err = Some(e);
                        break;
                    }
                }
            }

            let dl_result = Err(last_err.unwrap_or_else(|| {
                LauncherError::DownloadFailed("Download failed after retries".to_string())
            }));

            // Ensure Failed status is emitted so frontend doesn't stay on "Connecting"
            self.emit_progress_with_source(
                &download_id,
                name,
                0,
                0,
                0,
                DownloadStatus::Failed,
                operation_id,
                source.as_deref(),
            )
            .await;

            dl_result
        };

        // _token_guard drops here → remove_token(&download_id) автоматически
        result
    }

    /// Загрузка с перебором зеркал
    async fn download_from_mirrors(
        &self,
        urls: &[String],
        destination: &Path,
        name: &str,
        expected_hash: Option<&str>,
        cancel_token: Option<&CancellationToken>,
        operation_id: Option<&str>,
        download_id: &str,
    ) -> Result<()> {
        log::info!("Downloading {} with {} mirror(s)", name, urls.len());

        let mut last_error = None;

        for (idx, mirror_url) in urls.iter().enumerate() {
            // Проверка отмены перед каждым зеркалом
            if let Some(token) = cancel_token {
                if token.is_cancelled() {
                    return Err(LauncherError::OperationCancelled);
                }
            }

            log::info!("Trying mirror #{}/{}: {}", idx + 1, urls.len(), mirror_url);

            match self
                .download_single(
                    mirror_url,
                    destination,
                    name,
                    expected_hash,
                    cancel_token,
                    operation_id,
                    download_id,
                )
                .await
            {
                Ok(()) => return Ok(()),
                Err(LauncherError::OperationCancelled) => {
                    return Err(LauncherError::OperationCancelled);
                }
                Err(e) => {
                    let is_stall = e.to_string().contains("stalled");

                    if is_stall {
                        // Stall = сразу следующее зеркало без retry
                        log::warn!("Mirror {} stalled - switching to next mirror", mirror_url);
                    } else {
                        // Network error - один retry
                        log::warn!("Mirror {} failed: {}, trying once more...", mirror_url, e);

                        if let Some(token) = cancel_token {
                            if token.is_cancelled() {
                                return Err(LauncherError::OperationCancelled);
                            }
                        }

                        tokio::time::sleep(std::time::Duration::from_millis(
                            self.config.retry_delay_ms,
                        ))
                        .await;

                        if let Ok(()) = self
                            .download_single(
                                mirror_url,
                                destination,
                                name,
                                expected_hash,
                                cancel_token,
                                operation_id,
                                download_id,
                            )
                            .await
                        {
                            return Ok(());
                        }
                    }

                    last_error = Some(e);
                }
            }
        }

        // Все зеркала failed — infer source from first URL for UI badge
        let source = urls.first().and_then(|u| infer_download_source(u));
        self.emit_progress_with_source(
            download_id,
            name,
            0,
            0,
            0,
            DownloadStatus::Failed,
            operation_id,
            source.as_deref(),
        )
        .await;

        Err(last_error
            .unwrap_or_else(|| LauncherError::DownloadFailed("All mirrors failed".to_string())))
    }

    /// Загрузка с одного URL (с поддержкой resume)
    async fn download_single(
        &self,
        url: &str,
        destination: &Path,
        name: &str,
        expected_hash: Option<&str>,
        cancel_token: Option<&CancellationToken>,
        operation_id: Option<&str>,
        download_id: &str,
    ) -> Result<()> {
        // Проверка отмены
        if let Some(token) = cancel_token {
            if token.is_cancelled() {
                return Err(LauncherError::OperationCancelled);
            }
        }

        // Создаём директорию
        if let Some(parent) = destination.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        // Путь для частично загруженного файла
        let part_path = destination.with_extension(
            destination
                .extension()
                .map(|e| format!("{}.part", e.to_string_lossy()))
                .unwrap_or_else(|| "part".to_string()),
        );

        // Проверяем существующий partial файл для resume (async I/O)
        let existing_size = match tokio::fs::metadata(&part_path).await {
            Ok(meta) => meta.len(),
            Err(_) => 0,
        };

        let is_resuming = existing_size > 0;

        // Infer download source from URL for UI badges
        let source = infer_download_source(url);

        self.emit_progress_with_source(
            download_id,
            name,
            existing_size,
            0,
            0,
            if is_resuming {
                DownloadStatus::Resuming
            } else {
                DownloadStatus::Connecting
            },
            operation_id,
            source.as_deref(),
        )
        .await;

        if is_resuming {
            log::info!(
                "Resuming {} from {} bytes, URL: {}",
                name,
                existing_size,
                url
            );
        } else {
            log::info!("Downloading {} from {}", name, url);
        }

        // Строим запрос с Range header если есть partial файл
        let request = if is_resuming {
            self.client
                .get(url)
                .header("Range", format!("bytes={}-", existing_size))
        } else {
            self.client.get(url)
        };

        // Выполняем запрос
        let map_reqwest_error = |e: reqwest::Error| -> LauncherError {
            let kind = if e.is_timeout() {
                "timeout"
            } else if e.is_connect() {
                "connect"
            } else if e.is_request() {
                "request"
            } else {
                "unknown"
            };
            log::warn!(
                "[CDN-DIAG] {} connection error (kind={}): {}",
                name,
                kind,
                e
            );
            LauncherError::DownloadFailed(format!("Connection failed ({}): {}", kind, e))
        };

        let mut response = if let Some(token) = cancel_token {
            tokio::select! {
                biased;
                _ = token.cancelled() => {
                    return Err(LauncherError::OperationCancelled);
                }
                result = request.send() => {
                    result.map_err(map_reqwest_error)?
                }
            }
        } else {
            request
                .send()
                .await
                .map_err(map_reqwest_error)?
        };

        let status = response.status();

        // Диагностика: логируем response details для отладки CDN проблем
        {
            let final_url = response.url().to_string();
            let content_length = response.content_length();
            let headers = response.headers();

            // Логируем redirect (debug — информационно, не проблема)
            if final_url != url {
                log::debug!(
                    "[CDN-DIAG] {} redirect: {} -> {}",
                    name,
                    url,
                    final_url
                );
            }

            log::debug!(
                "[CDN-DIAG] {} status={}, content-length={:?}, content-type={:?}, server={:?}, final_url={}",
                name,
                status,
                content_length,
                headers.get("content-type").map(|v| v.to_str().unwrap_or("?")),
                headers.get("server").map(|v| v.to_str().unwrap_or("?")),
                final_url,
            );

            // Предупреждение если content-length = 0 или отсутствует — возможный soft block
            if status.is_success() && content_length.unwrap_or(0) == 0 {
                log::warn!(
                    "[CDN-DIAG] {} response has no content-length or content-length=0! Possible soft block. Headers: {:?}",
                    name,
                    headers.keys().map(|k| k.as_str()).collect::<Vec<_>>()
                );
            }

            // Логируем нестандартные статусы
            if !status.is_success() && status != reqwest::StatusCode::PARTIAL_CONTENT && status != reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
                log::warn!(
                    "[CDN-DIAG] {} unexpected status {}. Response headers: {:?}",
                    name,
                    status,
                    headers.iter().map(|(k, v)| format!("{}: {}", k.as_str(), v.to_str().unwrap_or("?"))).collect::<Vec<_>>()
                );
            }
        }

        // Определяем режим работы по статусу ответа
        let (resume_offset, total_size, _supports_resume) =
            if status == reqwest::StatusCode::PARTIAL_CONTENT {
                // 206 - сервер поддерживает resume
                let content_length = response.content_length().unwrap_or(0);
                let total = existing_size + content_length;
                log::info!(
                    "Server supports resume for {}, continuing from {} bytes (total: {})",
                    name,
                    existing_size,
                    total
                );
                (existing_size, total, true)
            } else if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
                // 416 - Range Not Satisfiable (файл изменился или .part больше файла)
                log::warn!(
                    "HTTP 416 for {} - range not satisfiable, deleting partial and restarting",
                    name
                );
                let _ = tokio::fs::remove_file(&part_path).await;
                // Повторяем запрос без Range header
                let retry_response = self
                    .client
                    .get(url)
                    .send()
                    .await
                    .map_err(|e| LauncherError::DownloadFailed(format!("Retry after 416 failed: {}", e)))?;
                let total = retry_response.content_length().unwrap_or(0);
                response = retry_response;
                (0, total, false)
            } else if status.is_success() {
                // 200 - сервер не поддерживает resume или отправил полный файл
                if is_resuming {
                    log::warn!(
                        "Server doesn't support resume for {}, starting from scratch",
                        name
                    );
                    // Удаляем partial файл - начинаем заново
                    let _ = tokio::fs::remove_file(&part_path).await;
                }
                let total = response.content_length().unwrap_or(0);
                (0, total, false)
            } else {
                log::error!("HTTP {} for URL: {}", status, url);
                self.emit_progress(
                    download_id,
                    name,
                    0,
                    0,
                    0,
                    DownloadStatus::Failed,
                    operation_id,
                )
                .await;
                return Err(LauncherError::DownloadFailed(format!(
                    "HTTP {}: {}",
                    status, url
                )));
            };

        let start_time = Instant::now();

        self.emit_progress(
            download_id,
            name,
            resume_offset,
            total_size,
            0,
            DownloadStatus::Downloading,
            operation_id,
        )
        .await;

        // Открываем файл: append если resume, create если с нуля (async I/O)
        let mut file = if resume_offset > 0 {
            let mut f = tokio::fs::OpenOptions::new()
                .write(true)
                .append(true)
                .open(&part_path)
                .await
                .map_err(|e| {
                    log::error!(
                        "Failed to open file for resume {}: {}",
                        part_path.display(),
                        e
                    );
                    LauncherError::Io(e)
                })?;
            // Перемещаемся в конец для надёжности
            f.seek(std::io::SeekFrom::End(0)).await.map_err(|e| {
                log::error!("Failed to seek to end: {}", e);
                LauncherError::Io(e)
            })?;
            f
        } else {
            tokio::fs::File::create(&part_path).await.map_err(|e| {
                log::error!("Failed to create file {}: {}", part_path.display(), e);
                LauncherError::Io(e)
            })?
        };

        let mut stream = response.bytes_stream();
        let mut downloaded: u64 = resume_offset; // Начинаем с уже скачанного
        let mut session_downloaded: u64 = 0; // Скачано в этой сессии (для скорости)
        let mut stall_detector = StallDetector::new(self.config.clone());
        let mut rate_limiter = RateLimiter::new(self.config.bandwidth_limit);
        let mut last_progress_emit = Instant::now();
        let first_chunk_time = Instant::now();
        let mut got_first_chunk = false;

        loop {
            // Проверка stall
            if stall_detector.is_stalled() {
                let timeout = stall_detector.timeout_secs();
                log::warn!(
                    "[CDN-DIAG] Download stalled for {} - no progress for {} seconds (session={} bytes, total={} bytes, got_first_chunk={}, url={})",
                    name,
                    timeout,
                    session_downloaded,
                    downloaded,
                    got_first_chunk,
                    url,
                );
                drop(file);
                // НЕ удаляем partial файл - можно resume позже
                self.emit_progress(
                    download_id,
                    name,
                    downloaded,
                    total_size,
                    0,
                    DownloadStatus::Stalled,
                    operation_id,
                )
                .await;
                return Err(LauncherError::DownloadFailed(format!(
                    "Download stalled: no progress for {} seconds (partial file saved for resume)",
                    timeout
                )));
            }

            // Читаем chunk с таймаутом для защиты от зависания соединений
            let chunk_timeout = stall_detector.adaptive_timeout();
            let chunk_result = if let Some(token) = cancel_token {
                tokio::select! {
                    biased;
                    _ = token.cancelled() => {
                        drop(file);
                        // НЕ удаляем partial файл при отмене - можно resume
                        self.emit_progress(download_id, name, downloaded, total_size, 0, DownloadStatus::Cancelled, operation_id).await;
                        log::info!("Download cancelled for {} ({} bytes saved for resume)", name, downloaded);
                        return Err(LauncherError::OperationCancelled);
                    }
                    _ = tokio::time::sleep(chunk_timeout) => {
                        log::warn!(
                            "[CDN-DIAG] Chunk read timeout for {} after {:?} (session={} bytes, total={} bytes, got_first_chunk={}, url={})",
                            name, chunk_timeout, session_downloaded, downloaded, got_first_chunk, url
                        );
                        if session_downloaded > 0 {
                            // Some data was downloaded — save progress for resume
                            break;
                        }
                        return Err(LauncherError::DownloadFailed(format!(
                            "Download stalled: no data received for {:?}", chunk_timeout
                        )));
                    }
                    chunk = stream.next() => chunk
                }
            } else {
                match tokio::time::timeout(chunk_timeout, stream.next()).await {
                    Ok(chunk) => chunk,
                    Err(_) => {
                        log::warn!(
                            "[CDN-DIAG] Chunk read timeout (no cancel token) for {} after {:?} (session={} bytes, total={} bytes, got_first_chunk={}, url={})",
                            name, chunk_timeout, session_downloaded, downloaded, got_first_chunk, url
                        );
                        if session_downloaded > 0 {
                            break;
                        }
                        return Err(LauncherError::DownloadFailed(format!(
                            "Download stalled: no data received for {:?}", chunk_timeout
                        )));
                    }
                }
            };

            let chunk = match chunk_result {
                Some(Ok(c)) => c,
                Some(Err(e)) => {
                    if session_downloaded > 0 {
                        log::warn!(
                            "Stream error for {}, but {} bytes downloaded this session (total: {})",
                            name,
                            session_downloaded,
                            downloaded
                        );
                        // Сохраняем прогресс - можно resume
                        break;
                    }
                    log::error!("Stream error: {}", e);
                    self.emit_progress(
                        download_id,
                        name,
                        downloaded,
                        total_size,
                        0,
                        DownloadStatus::Failed,
                        operation_id,
                    )
                    .await;
                    return Err(LauncherError::DownloadFailed(format!(
                        "Stream error: {}",
                        e
                    )));
                }
                None => break,
            };

            // Диагностика: время до первого chunk (TTFB)
            if !got_first_chunk {
                got_first_chunk = true;
                let ttfb = first_chunk_time.elapsed();
                if ttfb.as_millis() > 2000 {
                    log::warn!(
                        "[CDN-DIAG] {} TTFB={:?} (slow!), first chunk={} bytes",
                        name,
                        ttfb,
                        chunk.len()
                    );
                } else {
                    log::debug!(
                        "[CDN-DIAG] {} TTFB={:?}, first chunk={} bytes",
                        name,
                        ttfb,
                        chunk.len()
                    );
                }
            }

            // Записываем ВЕСЬ chunk целиком (async) — rate limiting через sleep, не truncation
            file.write_all(&chunk).await.map_err(|e| {
                log::error!("Failed to write: {}", e);
                LauncherError::Io(e)
            })?;

            downloaded += chunk.len() as u64;
            session_downloaded += chunk.len() as u64;

            // Rate limiting — замедляем если скачиваем быстрее лимита
            rate_limiter.throttle(chunk.len()).await;

            // Обновляем stall detector с session_downloaded для корректного расчёта скорости
            let speed = stall_detector.update_progress(session_downloaded);

            // Обновляем UI каждые 100ms
            if last_progress_emit.elapsed() > std::time::Duration::from_millis(100) {
                let display_total = if total_size > 0 {
                    total_size
                } else {
                    downloaded
                };
                self.emit_progress(
                    download_id,
                    name,
                    downloaded,
                    display_total,
                    speed,
                    DownloadStatus::Downloading,
                    operation_id,
                )
                .await;

                last_progress_emit = Instant::now();
            }
        }

        // Финальная проверка отмены
        if let Some(token) = cancel_token {
            if token.is_cancelled() {
                drop(file);
                // Сохраняем partial для resume
                log::info!(
                    "Download cancelled for {} ({} bytes saved for resume)",
                    name,
                    downloaded
                );
                return Err(LauncherError::OperationCancelled);
            }
        }

        file.flush().await.map_err(LauncherError::Io)?;
        file.sync_all().await.map_err(LauncherError::Io)?;
        drop(file);

        let final_total = if total_size > 0 {
            total_size
        } else {
            downloaded
        };
        let duration = start_time.elapsed();
        let speed_mbps = if duration.as_secs() > 0 {
            (session_downloaded as f64 / 1_000_000.0) / duration.as_secs_f64()
        } else {
            0.0
        };

        // Проверяем завершённость загрузки
        let download_complete = total_size == 0 || downloaded >= total_size;

        if !download_complete {
            log::warn!(
                "Download incomplete for {} ({}/{} bytes), partial file saved",
                name,
                downloaded,
                total_size
            );
            return Err(LauncherError::DownloadFailed(format!(
                "Download incomplete: {}/{} bytes (partial saved for resume)",
                downloaded, total_size
            )));
        }

        log::info!(
            "Downloaded '{}' ({} bytes{}) in {:.1}s ({:.2} MB/s)",
            name,
            downloaded,
            if resume_offset > 0 {
                format!(", resumed from {}", resume_offset)
            } else {
                String::new()
            },
            duration.as_secs_f64(),
            speed_mbps
        );

        // Верификация хеша
        if let Some(hash) = expected_hash {
            self.emit_progress(
                download_id,
                name,
                downloaded,
                final_total,
                0,
                DownloadStatus::Verifying,
                operation_id,
            )
            .await;

            let part_path_clone = part_path.clone();
            let hash_str = hash.to_string();
            let hash_ok =
                tokio::task::spawn_blocking(move || verify_file_hash(&part_path_clone, &hash_str))
                    .await
                    .map_err(|e| LauncherError::Join(e.to_string()))??;

            if !hash_ok {
                // Hash mismatch - удаляем partial файл
                tokio::fs::remove_file(&part_path).await?;
                log::error!("Hash mismatch for {} - partial file removed", name);
                return Err(LauncherError::HashMismatch {
                    expected: hash.to_string(),
                    actual: "calculated hash differs".to_string(),
                });
            }

            log::info!("Hash verified for {}", name);
        }

        // Переименовываем .part в финальный файл
        tokio::fs::rename(&part_path, destination)
            .await
            .map_err(|e| {
                log::error!(
                    "Failed to rename {} to {}: {}",
                    part_path.display(),
                    destination.display(),
                    e
                );
                LauncherError::Io(e)
            })?;

        self.emit_progress(
            download_id,
            name,
            downloaded,
            final_total,
            0,
            DownloadStatus::Completed,
            operation_id,
        )
        .await;

        Ok(())
    }

    /// Emit прогресса загрузки
    async fn emit_progress(
        &self,
        id: &str,
        name: &str,
        downloaded: u64,
        total: u64,
        speed: u64,
        status: DownloadStatus,
        operation_id: Option<&str>,
    ) {
        self.emit_progress_with_source(id, name, downloaded, total, speed, status, operation_id, None).await;
    }

    async fn emit_progress_with_source(
        &self,
        id: &str,
        name: &str,
        downloaded: u64,
        total: u64,
        speed: u64,
        status: DownloadStatus,
        operation_id: Option<&str>,
        source: Option<&str>,
    ) {
        if name.is_empty() {
            return;
        }

        let percentage = if total > 0 {
            (downloaded as f32 / total as f32) * 100.0
        } else {
            0.0
        };

        let progress = DownloadProgress {
            id: id.to_string(),
            name: name.to_string(),
            downloaded,
            total,
            speed,
            percentage,
            status: status.to_string(),
            operation_id: operation_id.map(String::from),
            source: source.map(String::from),
        };

        let _ = self.app_handle.emit("download-progress", progress);
    }

    // ========================================
    // DownloadManager-compatible API
    // ========================================

    /// Алиас для download() - совместимость с DownloadManager
    pub async fn download_file<P: AsRef<Path>>(
        &self,
        url: &str,
        destination: P,
        name: &str,
        expected_hash: Option<&str>,
    ) -> Result<()> {
        self.download(url, destination, name, expected_hash).await
    }

    /// Алиас для download_cancellable() - совместимость с DownloadManager
    pub async fn download_file_cancellable<P: AsRef<Path>>(
        &self,
        url: &str,
        destination: P,
        name: &str,
        expected_hash: Option<&str>,
        cancel_token: &CancellationToken,
        operation_id: Option<&str>,
    ) -> Result<()> {
        self.download_cancellable(
            url,
            destination,
            name,
            expected_hash,
            cancel_token,
            operation_id,
        )
        .await
    }

    /// Алиас для download() - SmartDownloader уже автоматически использует зеркала
    pub async fn download_file_with_mirrors<P: AsRef<Path>>(
        &self,
        url: &str,
        destination: P,
        name: &str,
        expected_hash: Option<&str>,
    ) -> Result<()> {
        self.download(url, destination, name, expected_hash).await
    }

    /// Алиас для download_java() - совместимость с DownloadManager
    pub async fn download_java_with_mirrors<P: AsRef<Path>>(
        &self,
        original_url: &str,
        destination: P,
        name: &str,
        expected_hash: Option<&str>,
        version: u32,
        arch: &str,
        os: &str,
        filename: &str,
        cancel_token: &CancellationToken,
        operation_id: Option<&str>,
    ) -> Result<()> {
        self.download_java(
            original_url,
            destination,
            name,
            expected_hash,
            version,
            arch,
            os,
            filename,
            cancel_token,
            operation_id,
        )
        .await
    }

    /// Пакетная загрузка нескольких файлов
    pub async fn download_batch(
        &self,
        downloads: Vec<DownloadTask>,
        max_concurrent: usize,
    ) -> Result<Vec<Result<()>>> {
        use futures::stream::{self, StreamExt};

        let results = stream::iter(downloads)
            .map(|task| {
                let downloader = self.clone();
                async move {
                    downloader
                        .download_file(
                            &task.url,
                            &task.destination,
                            &task.name,
                            task.hash.as_deref(),
                        )
                        .await
                }
            })
            .buffer_unordered(max_concurrent)
            .collect::<Vec<_>>()
            .await;

        Ok(results)
    }
}

/// Задача для пакетной загрузки
#[derive(Debug, Clone)]
pub struct DownloadTask {
    pub url: String,
    pub destination: std::path::PathBuf,
    pub name: String,
    pub hash: Option<String>,
}

impl DownloadTask {
    pub fn new(
        url: impl Into<String>,
        destination: impl Into<std::path::PathBuf>,
        name: impl Into<String>,
    ) -> Self {
        Self {
            url: url.into(),
            destination: destination.into(),
            name: name.into(),
            hash: None,
        }
    }

    pub fn with_hash(mut self, hash: impl Into<String>) -> Self {
        self.hash = Some(hash.into());
        self
    }
}

/// Shared HTTP client for fetch_json — created once, reused for all calls.
/// Avoids repeated DNS resolution, TLS handshake, and connection pool overhead.
static FETCH_JSON_CLIENT: std::sync::LazyLock<Client> = std::sync::LazyLock::new(|| {
    Client::builder()
        .user_agent(crate::USER_AGENT)
        .timeout(std::time::Duration::from_secs(30))
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .expect("Failed to build HTTP client for fetch_json")
});

/// Fetch JSON from URL with retry logic
/// Standalone function (doesn't require SmartDownloader instance)
pub async fn fetch_json<T: serde::de::DeserializeOwned>(url: &str) -> Result<T> {
    const MAX_RETRIES: u32 = 4;
    const BASE_DELAY_MS: u64 = 500;

    let client = &*FETCH_JSON_CLIENT;

    let mut last_error = None;

    for attempt in 0..MAX_RETRIES {
        if attempt > 0 {
            let delay = BASE_DELAY_MS * (1 << (attempt - 1));
            log::debug!(
                "Retrying {} after {}ms (attempt {}/{})",
                url,
                delay,
                attempt + 1,
                MAX_RETRIES
            );
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
        }

        log::debug!(
            "Fetching JSON from: {} (attempt {}/{})",
            url,
            attempt + 1,
            MAX_RETRIES
        );

        let response = match client.get(url).send().await {
            Ok(r) => r,
            Err(e) => {
                log::warn!(
                    "Network error fetching {} (attempt {}/{}): {}",
                    url,
                    attempt + 1,
                    MAX_RETRIES,
                    e
                );
                last_error = Some(LauncherError::ApiError(format!("Failed to connect: {}", e)));
                continue;
            }
        };

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();

            // 404 Not Found — expected for API lookups (mod not on platform, etc.)
            // 5xx — server errors, worth retrying
            // Other client errors — log as warning
            if status.is_server_error() {
                log::error!("HTTP {} for {}: {}", status, url, body);
                last_error = Some(LauncherError::ApiError(format!("HTTP {}: {}", status, url)));
                continue;
            } else if status.as_u16() == 404 {
                log::debug!("HTTP 404 for {}", url);
                return Err(LauncherError::ApiError(format!("HTTP {}: {}", status, url)));
            } else {
                log::warn!("HTTP {} for {}: {}", status, url, body);
                return Err(LauncherError::ApiError(format!("HTTP {}: {}", status, url)));
            }
        }

        let text = match response.text().await {
            Ok(t) => t,
            Err(e) => {
                log::error!("Failed to read response body from {}: {}", url, e);
                last_error = Some(LauncherError::ApiError(format!(
                    "Failed to read response: {}",
                    e
                )));
                continue;
            }
        };

        match serde_json::from_str(&text) {
            Ok(data) => {
                log::debug!("Successfully fetched and parsed JSON from {}", url);
                return Ok(data);
            }
            Err(e) => {
                log::error!("Failed to parse JSON from {}: {}", url, e);
                log::debug!("Response body: {}", &text[..text.len().min(500)]);
                return Err(LauncherError::Json(e));
            }
        }
    }

    log::error!("All {} retry attempts failed for {}", MAX_RETRIES, url);
    Err(last_error.unwrap_or_else(|| LauncherError::ApiError(format!("Failed to fetch {}", url))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_speed_calculator_ema() {
        let mut calc = SpeedCalculator::new();

        // Начальная скорость 0
        assert_eq!(calc.current_speed(), 0);

        // Симулируем загрузку - устанавливаем EMA напрямую для теста
        calc.speed_ema = 1_000_000.0; // 1 MB/s
        assert_eq!(calc.current_speed(), 1_000_000);

        // Проверяем что cap работает
        calc.speed_ema = 2_000_000_000.0; // 2 GB/s (нереально)
                                          // current_speed возвращает как есть, cap применяется в update()
        assert_eq!(calc.current_speed(), 2_000_000_000);
    }

    #[test]
    fn test_stall_detector_adaptive_timeout() {
        let config = DownloadConfig::default();
        let mut detector = StallDetector::new(config);

        // Изначально timeout должен быть максимальным (медленная сеть)
        assert!(detector.adaptive_timeout().as_secs() >= 8);

        // Симулируем быструю загрузку (1 MB/s)
        detector.speed_calculator.speed_ema = 1_000_000.0;
        assert_eq!(detector.adaptive_timeout().as_secs(), 3);

        // Средняя скорость (500 KB/s)
        detector.speed_calculator.speed_ema = 500_000.0;
        assert_eq!(detector.adaptive_timeout().as_secs(), 5);

        // Медленная скорость (50 KB/s)
        detector.speed_calculator.speed_ema = 50_000.0;
        assert_eq!(detector.adaptive_timeout().as_secs(), 8);
    }

    #[test]
    fn test_bandwidth_limit_config() {
        let config = DownloadConfig::default().with_bandwidth_limit(1_000_000); // 1 MB/s
        assert_eq!(config.bandwidth_limit, 1_000_000);

        let config_no_limit = DownloadConfig::default();
        assert_eq!(config_no_limit.bandwidth_limit, 0);
    }
}
