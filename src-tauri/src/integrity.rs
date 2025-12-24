//! Проверка целостности файлов экземпляра
//!
//! Функции:
//! - Проверка хешей файлов перед запуском
//! - Автоматическое восстановление повреждённых файлов
//! - Кэширование хешей для быстрой проверки

use crate::downloader::DownloadManager;
use crate::error::{LauncherError, Result};
use crate::paths::instances_dir;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;
use tauri::Emitter;

/// Результат проверки целостности
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntegrityCheckResult {
    /// Проверка пройдена
    pub valid: bool,

    /// Всего файлов проверено
    pub total_files: u32,

    /// Файлов прошло проверку
    pub valid_files: u32,

    /// Повреждённые файлы
    pub corrupted_files: Vec<CorruptedFile>,

    /// Отсутствующие файлы
    pub missing_files: Vec<MissingFile>,

    /// Время проверки (мс)
    pub check_time_ms: u64,
}

/// Информация о повреждённом файле
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CorruptedFile {
    /// Путь к файлу (относительный)
    pub path: String,

    /// Ожидаемый хеш
    pub expected_hash: String,

    /// Фактический хеш
    pub actual_hash: String,

    /// Размер файла
    pub size: u64,

    /// Можно ли восстановить
    pub recoverable: bool,

    /// Источник для восстановления
    pub recovery_source: Option<RecoverySource>,
}

/// Информация об отсутствующем файле
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MissingFile {
    /// Путь к файлу (относительный)
    pub path: String,

    /// Ожидаемый хеш
    pub expected_hash: String,

    /// Ожидаемый размер
    pub expected_size: u64,

    /// Можно ли восстановить
    pub recoverable: bool,

    /// Источник для восстановления
    pub recovery_source: Option<RecoverySource>,
}

/// Источник для восстановления файла
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum RecoverySource {
    /// Minecraft библиотека
    #[serde(rename = "minecraft")]
    Minecraft { url: String },

    /// Modrinth мод
    #[serde(rename = "modrinth")]
    Modrinth {
        project_id: String,
        version_id: String,
        url: String,
    },

    /// CurseForge мод
    #[serde(rename = "curseforge")]
    CurseForge {
        project_id: u64,
        file_id: u64,
        url: Option<String>,
    },

    /// Прямая ссылка
    #[serde(rename = "direct")]
    Direct { url: String },

    /// Локальный кэш
    #[serde(rename = "cache")]
    Cache { path: String },
}

/// Манифест целостности экземпляра
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntegrityManifest {
    /// Версия манифеста
    pub version: u32,

    /// ID экземпляра
    pub instance_id: String,

    /// Дата создания
    pub created_at: String,

    /// Дата обновления
    pub updated_at: String,

    /// Записи о файлах
    pub files: HashMap<String, FileEntry>,
}

/// Запись о файле в манифесте
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    /// SHA256 хеш
    pub sha256: String,

    /// Размер файла
    pub size: u64,

    /// Источник для восстановления
    pub recovery_source: Option<RecoverySource>,

    /// Обязательный ли файл
    #[serde(default = "default_true")]
    pub required: bool,
}

fn default_true() -> bool {
    true
}

/// Прогресс проверки
#[derive(Debug, Clone, Serialize)]
pub struct IntegrityProgress {
    pub stage: String,
    pub current: u32,
    pub total: u32,
    pub current_file: Option<String>,
}

/// Менеджер целостности
pub struct IntegrityManager;

impl IntegrityManager {
    /// Проверить целостность экземпляра перед запуском
    pub async fn check_before_launch(
        instance_id: &str,
        app_handle: &tauri::AppHandle,
    ) -> Result<IntegrityCheckResult> {
        let start_time = std::time::Instant::now();
        let instance_path = instances_dir().join(instance_id);

        // Пробуем загрузить манифест
        let manifest_path = instance_path.join(".integrity.json");
        let manifest = if tokio::fs::try_exists(&manifest_path).await.unwrap_or(false) {
            let content = tokio::fs::read_to_string(&manifest_path).await?;
            serde_json::from_str::<IntegrityManifest>(&content).ok()
        } else {
            None
        };

        // Проверяем целостность в зависимости от наличия манифеста
        let mut result = match manifest {
            None => {
                // Проверяем только критичные файлы
                Self::check_critical_files(instance_id, &instance_path, app_handle).await?
            }
            Some(manifest) => {
                Self::check_with_manifest(&manifest, &instance_path, app_handle).await?
            }
        };

        result.check_time_ms = start_time.elapsed().as_millis() as u64;
        result.valid = result.corrupted_files.is_empty() && result.missing_files.is_empty();

        Ok(result)
    }

    /// Проверить критичные файлы без манифеста
    async fn check_critical_files(
        _instance_id: &str,
        instance_path: &Path,
        app_handle: &tauri::AppHandle,
    ) -> Result<IntegrityCheckResult> {
        let mut result = IntegrityCheckResult {
            valid: true,
            total_files: 0,
            valid_files: 0,
            corrupted_files: vec![],
            missing_files: vec![],
            check_time_ms: 0,
        };

        // Проверяем папку mods
        let mods_path = instance_path.join("mods");
        if tokio::fs::try_exists(&mods_path).await.unwrap_or(false) {
            let mut entries = tokio::fs::read_dir(&mods_path).await?;

            while let Some(entry) = entries.next_entry().await? {
                let path = entry.path();
                let file_type = entry.file_type().await?;

                if !file_type.is_file() {
                    continue;
                }

                let filename = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_string();

                if !filename.ends_with(".jar") {
                    continue;
                }

                result.total_files += 1;

                // Проверяем что файл читаем и является валидным ZIP
                match tokio::fs::read(&path).await {
                    Ok(content) => {
                        // Пробуем открыть как ZIP
                        let cursor = std::io::Cursor::new(&content);
                        match zip::ZipArchive::new(cursor) {
                            Ok(_) => {
                                result.valid_files += 1;
                            }
                            Err(_) => {
                                result.corrupted_files.push(CorruptedFile {
                                    path: format!("mods/{}", filename),
                                    expected_hash: String::new(),
                                    actual_hash: String::new(),
                                    size: content.len() as u64,
                                    recoverable: false,
                                    recovery_source: None,
                                });
                            }
                        }
                    }
                    Err(_) => {
                        result.corrupted_files.push(CorruptedFile {
                            path: format!("mods/{}", filename),
                            expected_hash: String::new(),
                            actual_hash: String::new(),
                            size: 0,
                            recoverable: false,
                            recovery_source: None,
                        });
                    }
                }

                let _ = app_handle.emit(
                    "integrity-progress",
                    IntegrityProgress {
                        stage: "Checking mods".into(),
                        current: result.total_files,
                        total: 0,
                        current_file: Some(filename),
                    },
                );
            }
        }

        Ok(result)
    }

    /// Проверить с использованием манифеста
    async fn check_with_manifest(
        manifest: &IntegrityManifest,
        instance_path: &Path,
        app_handle: &tauri::AppHandle,
    ) -> Result<IntegrityCheckResult> {
        let mut result = IntegrityCheckResult {
            valid: true,
            total_files: manifest.files.len() as u32,
            valid_files: 0,
            corrupted_files: vec![],
            missing_files: vec![],
            check_time_ms: 0,
        };

        let mut current = 0;

        for (path, entry) in &manifest.files {
            current += 1;

            let _ = app_handle.emit(
                "integrity-progress",
                IntegrityProgress {
                    stage: "Verifying files".into(),
                    current,
                    total: result.total_files,
                    current_file: Some(path.clone()),
                },
            );

            let file_path = instance_path.join(path);

            if !tokio::fs::try_exists(&file_path).await.unwrap_or(false) {
                if entry.required {
                    result.missing_files.push(MissingFile {
                        path: path.clone(),
                        expected_hash: entry.sha256.clone(),
                        expected_size: entry.size,
                        recoverable: entry.recovery_source.is_some(),
                        recovery_source: entry.recovery_source.clone(),
                    });
                }
                continue;
            }

            // Читаем и проверяем хеш
            match tokio::fs::read(&file_path).await {
                Ok(content) => {
                    let actual_hash = Self::calculate_sha256(&content);

                    if actual_hash != entry.sha256 {
                        result.corrupted_files.push(CorruptedFile {
                            path: path.clone(),
                            expected_hash: entry.sha256.clone(),
                            actual_hash,
                            size: content.len() as u64,
                            recoverable: entry.recovery_source.is_some(),
                            recovery_source: entry.recovery_source.clone(),
                        });
                    } else {
                        result.valid_files += 1;
                    }
                }
                Err(_) => {
                    result.corrupted_files.push(CorruptedFile {
                        path: path.clone(),
                        expected_hash: entry.sha256.clone(),
                        actual_hash: String::new(),
                        size: 0,
                        recoverable: entry.recovery_source.is_some(),
                        recovery_source: entry.recovery_source.clone(),
                    });
                }
            }
        }

        Ok(result)
    }

    /// Создать манифест целостности для экземпляра
    pub async fn create_manifest(
        instance_id: &str,
        app_handle: &tauri::AppHandle,
    ) -> Result<IntegrityManifest> {
        let instance_path = instances_dir().join(instance_id);

        let mut files: HashMap<String, FileEntry> = HashMap::new();

        // Сканируем папку mods
        let mods_path = instance_path.join("mods");
        if tokio::fs::try_exists(&mods_path).await.unwrap_or(false) {
            Self::scan_directory(&mods_path, &instance_path, &mut files, app_handle).await?;
        }

        // Сканируем config
        let config_path = instance_path.join("config");
        if tokio::fs::try_exists(&config_path).await.unwrap_or(false) {
            Self::scan_directory(&config_path, &instance_path, &mut files, app_handle).await?;
        }

        let now = chrono::Utc::now().to_rfc3339();

        let manifest = IntegrityManifest {
            version: 1,
            instance_id: instance_id.to_string(),
            created_at: now.clone(),
            updated_at: now,
            files,
        };

        // Сохраняем манифест
        let manifest_path = instance_path.join(".integrity.json");
        let content = serde_json::to_string_pretty(&manifest)?;
        tokio::fs::write(&manifest_path, content).await?;

        log::info!("Created integrity manifest for instance {}", instance_id);

        Ok(manifest)
    }

    /// Сканировать директорию рекурсивно
    async fn scan_directory(
        dir: &Path,
        base_path: &Path,
        files: &mut HashMap<String, FileEntry>,
        app_handle: &tauri::AppHandle,
    ) -> Result<()> {
        let mut entries = tokio::fs::read_dir(dir).await?;

        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            let file_type = entry.file_type().await?;

            if file_type.is_dir() {
                Box::pin(Self::scan_directory(&path, base_path, files, app_handle)).await?;
            } else if file_type.is_file() {
                let relative_path = path
                    .strip_prefix(base_path)
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default();

                if let Ok(content) = tokio::fs::read(&path).await {
                    let hash = Self::calculate_sha256(&content);

                    files.insert(
                        relative_path.clone(),
                        FileEntry {
                            sha256: hash,
                            size: content.len() as u64,
                            recovery_source: None,
                            required: true,
                        },
                    );

                    let _ = app_handle.emit(
                        "integrity-scan-progress",
                        serde_json::json!({
                            "file": relative_path,
                            "count": files.len(),
                        }),
                    );
                }
            }
        }

        Ok(())
    }

    /// Восстановить повреждённые файлы
    pub async fn repair_files(
        instance_id: &str,
        files: Vec<String>,
        download_manager: &DownloadManager,
        app_handle: &tauri::AppHandle,
    ) -> Result<RepairResult> {
        let instance_path = instances_dir().join(instance_id);

        // Загружаем манифест
        let manifest_path = instance_path.join(".integrity.json");
        if !tokio::fs::try_exists(&manifest_path).await.unwrap_or(false) {
            return Err(LauncherError::NotFound(
                "Integrity manifest not found".into(),
            ));
        }

        let content = tokio::fs::read_to_string(&manifest_path).await?;
        let manifest: IntegrityManifest = serde_json::from_str(&content)?;

        let mut repaired = 0;
        let mut failed = Vec::new();

        for file_path in files {
            if let Some(entry) = manifest.files.get(&file_path) {
                if let Some(source) = &entry.recovery_source {
                    match Self::download_from_source(
                        source,
                        &instance_path.join(&file_path),
                        download_manager,
                    )
                    .await
                    {
                        Ok(_) => {
                            repaired += 1;
                            let _ = app_handle.emit(
                                "integrity-repair-progress",
                                serde_json::json!({
                                    "file": file_path,
                                    "status": "repaired",
                                }),
                            );
                        }
                        Err(e) => {
                            log::error!("Failed to repair {}: {}", file_path, e);
                            failed.push(file_path);
                        }
                    }
                } else {
                    failed.push(file_path);
                }
            } else {
                failed.push(file_path);
            }
        }

        Ok(RepairResult { repaired, failed })
    }

    /// Скачать файл из источника
    async fn download_from_source(
        source: &RecoverySource,
        dest: &Path,
        download_manager: &DownloadManager,
    ) -> Result<()> {
        let url = match source {
            RecoverySource::Minecraft { url } => url.clone(),
            RecoverySource::Modrinth { url, .. } => url.clone(),
            RecoverySource::Direct { url } => url.clone(),
            RecoverySource::Cache { path } => {
                // Копируем из кэша
                tokio::fs::copy(path, dest).await?;
                return Ok(());
            }
            RecoverySource::CurseForge { url, .. } => {
                if let Some(u) = url {
                    u.clone()
                } else {
                    return Err(LauncherError::NotFound(
                        "CurseForge file requires download URL".into(),
                    ));
                }
            }
        };

        let filename = dest.file_name().and_then(|n| n.to_str()).unwrap_or("file");
        download_manager
            .download_file(&url, dest, filename, None)
            .await?;
        Ok(())
    }

    /// Вычислить SHA256 хеш
    pub fn calculate_sha256(data: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(data);
        format!("{:x}", hasher.finalize())
    }

    /// Обновить манифест после изменения файлов
    pub async fn update_manifest(instance_id: &str, changed_files: Vec<String>) -> Result<()> {
        let instance_path = instances_dir().join(instance_id);
        let manifest_path = instance_path.join(".integrity.json");

        if !tokio::fs::try_exists(&manifest_path).await.unwrap_or(false) {
            return Ok(());
        }

        let content = tokio::fs::read_to_string(&manifest_path).await?;
        let mut manifest: IntegrityManifest = serde_json::from_str(&content)?;

        for file_path in changed_files {
            let full_path = instance_path.join(&file_path);

            if tokio::fs::try_exists(&full_path).await.unwrap_or(false) {
                if let Ok(content) = tokio::fs::read(&full_path).await {
                    let hash = Self::calculate_sha256(&content);

                    manifest.files.insert(
                        file_path,
                        FileEntry {
                            sha256: hash,
                            size: content.len() as u64,
                            recovery_source: None,
                            required: true,
                        },
                    );
                }
            } else {
                manifest.files.remove(&file_path);
            }
        }

        manifest.updated_at = chrono::Utc::now().to_rfc3339();

        let content = serde_json::to_string_pretty(&manifest)?;
        tokio::fs::write(&manifest_path, content).await?;

        Ok(())
    }

    /// Быстрая проверка - только размеры файлов
    pub async fn quick_check(instance_id: &str) -> Result<bool> {
        let instance_path = instances_dir().join(instance_id);
        let manifest_path = instance_path.join(".integrity.json");

        if !tokio::fs::try_exists(&manifest_path).await.unwrap_or(false) {
            return Ok(true); // Нет манифеста - считаем ОК
        }

        let content = tokio::fs::read_to_string(&manifest_path).await?;
        let manifest: IntegrityManifest = serde_json::from_str(&content)?;

        for (path, entry) in &manifest.files {
            let file_path = instance_path.join(path);

            if !tokio::fs::try_exists(&file_path).await.unwrap_or(false) && entry.required {
                return Ok(false);
            }

            if let Ok(metadata) = tokio::fs::metadata(&file_path).await {
                if metadata.len() != entry.size {
                    return Ok(false);
                }
            }
        }

        Ok(true)
    }
}

/// Результат восстановления
#[derive(Debug, Clone, Serialize)]
pub struct RepairResult {
    pub repaired: u32,
    pub failed: Vec<String>,
}

// ========== Tauri Commands ==========

/// Проверить целостность экземпляра
#[tauri::command]
pub async fn check_integrity(
    instance_id: String,
    app_handle: tauri::AppHandle,
) -> Result<IntegrityCheckResult> {
    IntegrityManager::check_before_launch(&instance_id, &app_handle).await
}

/// Быстрая проверка целостности
#[tauri::command]
pub async fn quick_integrity_check(instance_id: String) -> Result<bool> {
    IntegrityManager::quick_check(&instance_id).await
}

/// Создать манифест целостности
#[tauri::command]
pub async fn create_integrity_manifest(
    instance_id: String,
    app_handle: tauri::AppHandle,
) -> Result<IntegrityManifest> {
    IntegrityManager::create_manifest(&instance_id, &app_handle).await
}

/// Восстановить файлы
#[tauri::command]
pub async fn repair_integrity(
    instance_id: String,
    files: Vec<String>,
    app_handle: tauri::AppHandle,
) -> Result<RepairResult> {
    let download_manager = DownloadManager::new(app_handle.clone())?;
    IntegrityManager::repair_files(&instance_id, files, &download_manager, &app_handle).await
}
