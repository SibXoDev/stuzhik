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
use std::fs::{File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;
use tauri::Emitter;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

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
}

/// API-aware семафоры для контроля параллельных загрузок
pub struct DownloadSemaphores {
    modrinth: Arc<Semaphore>,
    curseforge: Arc<Semaphore>,
    files: Arc<Semaphore>,
}

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
            max_speed: 1_000_000_000.0, // 1 GB/s cap
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

/// Rate limiter для bandwidth limiting (token bucket)
struct RateLimiter {
    /// Лимит bytes/sec (0 = без лимита)
    limit: u64,
    /// Время последней проверки
    last_check: Instant,
    /// Накопленные "токены" (байты которые можно скачать)
    tokens: f64,
}

impl RateLimiter {
    fn new(limit: u64) -> Self {
        Self {
            limit,
            last_check: Instant::now(),
            tokens: limit as f64, // Начинаем с полного bucket
        }
    }

    /// Ждать если нужно для соблюдения лимита, вернуть сколько можно скачать
    async fn acquire(&mut self, requested: usize) -> usize {
        if self.limit == 0 {
            return requested; // Без лимита
        }

        let now = Instant::now();
        let elapsed = now.duration_since(self.last_check).as_secs_f64();
        self.last_check = now;

        // Добавляем токены за прошедшее время
        self.tokens += elapsed * self.limit as f64;

        // Cap на 1 секунду burst
        self.tokens = self.tokens.min(self.limit as f64);

        if self.tokens >= requested as f64 {
            // Достаточно токенов - разрешаем сразу
            self.tokens -= requested as f64;
            requested
        } else if self.tokens > 0.0 {
            // Частичное разрешение
            let allowed = self.tokens as usize;
            self.tokens = 0.0;
            allowed.max(1) // Минимум 1 байт
        } else {
            // Нет токенов - ждём
            let wait_time = (requested as f64 - self.tokens) / self.limit as f64;
            tokio::time::sleep(std::time::Duration::from_secs_f64(wait_time.min(0.1))).await;
            self.tokens = 0.0;
            (self.limit as f64 * 0.1) as usize // 100ms worth of data
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

        // Получаем семафор для этого типа ресурса
        let semaphore = self.semaphores.for_resource_type(resource_type).clone();
        let _permit = semaphore.acquire().await.map_err(|e| {
            LauncherError::InvalidConfig(format!("Failed to acquire semaphore: {}", e))
        })?;

        // Если тип ресурса имеет зеркала - используем их
        if resource_type.has_mirrors() {
            let urls = self.registry.get_mirror_urls(url);
            return self
                .download_from_mirrors(
                    &urls,
                    destination,
                    name,
                    expected_hash,
                    cancel_token,
                    operation_id,
                    &download_id,
                )
                .await;
        }

        // Простая загрузка без зеркал
        self.download_single(
            url,
            destination,
            name,
            expected_hash,
            cancel_token,
            operation_id,
            &download_id,
        )
        .await
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

        // Все зеркала failed
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

        // Проверяем существующий partial файл для resume
        let existing_size = if part_path.exists() {
            match std::fs::metadata(&part_path) {
                Ok(meta) => meta.len(),
                Err(_) => 0,
            }
        } else {
            0
        };

        let is_resuming = existing_size > 0;

        self.emit_progress(
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
        let response = if let Some(token) = cancel_token {
            tokio::select! {
                biased;
                _ = token.cancelled() => {
                    return Err(LauncherError::OperationCancelled);
                }
                result = request.send() => {
                    result.map_err(|e| LauncherError::DownloadFailed(format!("Connection failed: {}", e)))?
                }
            }
        } else {
            request
                .send()
                .await
                .map_err(|e| LauncherError::DownloadFailed(format!("Connection failed: {}", e)))?
        };

        let status = response.status();

        // Определяем режим работы по статусу ответа
        let (resume_offset, total_size, _supports_resume) = if status == reqwest::StatusCode::PARTIAL_CONTENT {
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

        // Открываем файл: append если resume, create если с нуля
        let mut file = if resume_offset > 0 {
            let mut f = OpenOptions::new()
                .write(true)
                .append(true)
                .open(&part_path)
                .map_err(|e| {
                    log::error!("Failed to open file for resume {}: {}", part_path.display(), e);
                    LauncherError::Io(e)
                })?;
            // Перемещаемся в конец для надёжности
            f.seek(SeekFrom::End(0)).map_err(|e| {
                log::error!("Failed to seek to end: {}", e);
                LauncherError::Io(e)
            })?;
            f
        } else {
            File::create(&part_path).map_err(|e| {
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

        loop {
            // Проверка stall
            if stall_detector.is_stalled() {
                let timeout = stall_detector.timeout_secs();
                log::warn!(
                    "Download stalled for {} - no progress for {} seconds (downloaded {} bytes)",
                    name,
                    timeout,
                    downloaded
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

            // Читаем chunk
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
                    chunk = stream.next() => chunk
                }
            } else {
                stream.next().await
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

            // Rate limiting - ждём если превышен лимит скорости
            let allowed = rate_limiter.acquire(chunk.len()).await;
            let chunk_to_write = if allowed < chunk.len() {
                &chunk[..allowed]
            } else {
                &chunk[..]
            };

            file.write_all(chunk_to_write).map_err(|e| {
                log::error!("Failed to write: {}", e);
                LauncherError::Io(e)
            })?;

            downloaded += chunk_to_write.len() as u64;
            session_downloaded += chunk_to_write.len() as u64;

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

        file.sync_all().map_err(|e| LauncherError::Io(e))?;
        drop(file);

        let final_total = if total_size > 0 { total_size } else { downloaded };
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
        tokio::fs::rename(&part_path, destination).await.map_err(|e| {
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
        self.download_cancellable(url, destination, name, expected_hash, cancel_token, operation_id)
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
                        .download_file(&task.url, &task.destination, &task.name, task.hash.as_deref())
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
    pub fn new(url: impl Into<String>, destination: impl Into<std::path::PathBuf>, name: impl Into<String>) -> Self {
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

/// Fetch JSON from URL with retry logic
/// Standalone function (doesn't require SmartDownloader instance)
pub async fn fetch_json<T: serde::de::DeserializeOwned>(url: &str) -> Result<T> {
    const MAX_RETRIES: u32 = 4;
    const BASE_DELAY_MS: u64 = 2000;

    let client = Client::builder()
        .user_agent(crate::USER_AGENT)
        .timeout(std::time::Duration::from_secs(30))
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| {
            log::error!("Failed to build HTTP client: {}", e);
            LauncherError::ApiError(format!("Failed to build client: {}", e))
        })?;

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
            log::error!("HTTP {} for {}: {}", status, url, body);

            if status.is_server_error() {
                last_error = Some(LauncherError::ApiError(format!("HTTP {}: {}", status, url)));
                continue;
            } else {
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
