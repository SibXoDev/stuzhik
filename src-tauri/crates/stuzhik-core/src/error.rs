use serde::Serialize;
use thiserror::Error;

use crate::i18n::Language;

/// Информация об ошибке с подсказкой для восстановления
#[derive(Debug, Clone, Serialize)]
pub struct ErrorInfo {
    /// Код ошибки для идентификации
    pub code: String,
    /// Человекочитаемое сообщение
    pub message: String,
    /// Подсказка для исправления
    pub recovery_hint: Option<String>,
    /// Технические детали (для логов)
    pub details: Option<String>,
}

impl ErrorInfo {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            recovery_hint: None,
            details: None,
        }
    }

    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.recovery_hint = Some(hint.into());
        self
    }

    pub fn with_details(mut self, details: impl Into<String>) -> Self {
        self.details = Some(details.into());
        self
    }
}

#[derive(Error, Debug)]
pub enum LauncherError {
    #[error("Database error: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("HTTP request failed: {0}")]
    Http(#[from] reqwest::Error),

    #[error("JSON parsing error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Archive extraction error: {0}")]
    Archive(String),

    #[error("Zip error: {0}")]
    Zip(#[from] zip::result::ZipError),

    #[error("Instance not found: {0}")]
    InstanceNotFound(String),

    #[error("Mod not found: {0}")]
    ModNotFound(String),

    #[error("No compatible mod version found for Minecraft {mc_version} with {loader}")]
    NoCompatibleModVersion {
        mod_name: String,
        mc_version: String,
        loader: String,
    },

    #[error("Mod file download failed: {0}")]
    ModDownloadFailed(String),

    #[error("Insufficient disk space: {required} MB required, {available} MB available")]
    InsufficientDiskSpace { required: u64, available: u64 },

    #[error("Java installation not found for version: {0}")]
    JavaNotFound(String),

    #[error("Minecraft version not found: {0}")]
    MinecraftVersionNotFound(String),

    #[error("Loader version not found: {0} for Minecraft {1}")]
    LoaderVersionNotFound(String, String),

    #[error("Invalid version format: {0}")]
    InvalidVersion(String),

    #[error("File hash mismatch: expected {expected}, got {actual}")]
    HashMismatch { expected: String, actual: String },

    #[error("Dependency conflict: {0}")]
    DependencyConflict(String),

    #[error("Instance is already running")]
    InstanceAlreadyRunning,

    #[error("Instance is not running")]
    InstanceNotRunning,

    #[error("Invalid configuration: {0}")]
    InvalidConfig(String),

    #[error("Download failed: {0}")]
    DownloadFailed(String),

    #[error("API error: {0}")]
    ApiError(String),

    #[error("Join error: {0}")]
    Join(String),

    #[error("Operation cancelled")]
    OperationCancelled,

    #[error("Not found: {0}")]
    NotFound(String),
}

impl LauncherError {
    /// Возвращает информацию об ошибке с подсказкой для восстановления (русский язык по умолчанию)
    pub fn to_error_info(&self) -> ErrorInfo {
        self.localized_error_info(Language::Russian)
    }

    /// Возвращает локализованную информацию об ошибке
    pub fn localized_error_info(&self, lang: Language) -> ErrorInfo {
        match self {
            LauncherError::Database(e) => match lang {
                Language::Russian => ErrorInfo::new("DATABASE_ERROR", "Ошибка базы данных")
                    .with_hint("Попробуйте перезапустить приложение. Если ошибка повторяется, удалите файл launcher.db")
                    .with_details(e.to_string()),
                Language::English => ErrorInfo::new("DATABASE_ERROR", "Database error")
                    .with_hint("Try restarting the application. If the error persists, delete the launcher.db file")
                    .with_details(e.to_string()),
            }
            LauncherError::Io(e) => match lang {
                Language::Russian => {
                    let hint = if e.kind() == std::io::ErrorKind::PermissionDenied {
                        "Проверьте права доступа к папке приложения"
                    } else if e.kind() == std::io::ErrorKind::NotFound {
                        "Файл или папка не найдены. Попробуйте переустановить экземпляр"
                    } else if e.kind() == std::io::ErrorKind::OutOfMemory {
                        "Недостаточно места на диске. Освободите место и попробуйте снова"
                    } else {
                        "Проверьте, что папка приложения доступна и не занята другим процессом"
                    };
                    ErrorInfo::new("IO_ERROR", format!("Ошибка файловой системы: {}", e.kind()))
                        .with_hint(hint)
                        .with_details(e.to_string())
                }
                Language::English => {
                    let hint = if e.kind() == std::io::ErrorKind::PermissionDenied {
                        "Check access permissions to the application folder"
                    } else if e.kind() == std::io::ErrorKind::NotFound {
                        "File or folder not found. Try reinstalling the instance"
                    } else if e.kind() == std::io::ErrorKind::OutOfMemory {
                        "Insufficient disk space. Free up space and try again"
                    } else {
                        "Ensure the application folder is accessible and not locked by another process"
                    };
                    ErrorInfo::new("IO_ERROR", format!("Filesystem error: {}", e.kind()))
                        .with_hint(hint)
                        .with_details(e.to_string())
                }
            }
            LauncherError::Http(e) => match lang {
                Language::Russian => {
                    let (message, hint) = if e.is_timeout() {
                        ("Превышено время ожидания сервера", "Проверьте подключение к интернету и попробуйте снова")
                    } else if e.is_connect() {
                        ("Не удалось подключиться к серверу", "Проверьте подключение к интернету. Возможно, сервер временно недоступен")
                    } else if e.status().map(|s| s.as_u16()) == Some(429) {
                        ("Превышен лимит запросов", "Подождите минуту и попробуйте снова")
                    } else if e.status().map(|s| s.as_u16()) == Some(404) {
                        ("Ресурс не найден", "Возможно, мод или модпак был удалён")
                    } else {
                        ("Ошибка сети", "Проверьте подключение к интернету")
                    };
                    ErrorInfo::new("HTTP_ERROR", message)
                        .with_hint(hint)
                        .with_details(e.to_string())
                }
                Language::English => {
                    let (message, hint) = if e.is_timeout() {
                        ("Server timeout", "Check your internet connection and try again")
                    } else if e.is_connect() {
                        ("Failed to connect to server", "Check your internet connection. The server might be temporarily unavailable")
                    } else if e.status().map(|s| s.as_u16()) == Some(429) {
                        ("Rate limit exceeded", "Wait a minute and try again")
                    } else if e.status().map(|s| s.as_u16()) == Some(404) {
                        ("Resource not found", "The mod or modpack may have been deleted")
                    } else {
                        ("Network error", "Check your internet connection")
                    };
                    ErrorInfo::new("HTTP_ERROR", message)
                        .with_hint(hint)
                        .with_details(e.to_string())
                }
            }
            LauncherError::Json(e) => match lang {
                Language::Russian => ErrorInfo::new("JSON_ERROR", "Ошибка обработки данных")
                    .with_hint("Возможно, API изменился. Проверьте обновления приложения")
                    .with_details(e.to_string()),
                Language::English => ErrorInfo::new("JSON_ERROR", "Data processing error")
                    .with_hint("The API may have changed. Check for application updates")
                    .with_details(e.to_string()),
            }
            LauncherError::Archive(msg) => match lang {
                Language::Russian => ErrorInfo::new("ARCHIVE_ERROR", "Ошибка распаковки архива")
                    .with_hint("Архив может быть повреждён. Попробуйте скачать заново")
                    .with_details(msg.clone()),
                Language::English => ErrorInfo::new("ARCHIVE_ERROR", "Archive extraction error")
                    .with_hint("The archive may be corrupted. Try downloading it again")
                    .with_details(msg.clone()),
            }
            LauncherError::Zip(e) => match lang {
                Language::Russian => ErrorInfo::new("ZIP_ERROR", "Ошибка работы с ZIP-архивом")
                    .with_hint("Архив может быть повреждён. Попробуйте скачать заново")
                    .with_details(e.to_string()),
                Language::English => ErrorInfo::new("ZIP_ERROR", "ZIP archive error")
                    .with_hint("The archive may be corrupted. Try downloading it again")
                    .with_details(e.to_string()),
            }
            LauncherError::InstanceNotFound(id) => match lang {
                Language::Russian => ErrorInfo::new("INSTANCE_NOT_FOUND", format!("Экземпляр '{}' не найден", id))
                    .with_hint("Экземпляр мог быть удалён. Обновите список экземпляров"),
                Language::English => ErrorInfo::new("INSTANCE_NOT_FOUND", format!("Instance '{}' not found", id))
                    .with_hint("The instance may have been deleted. Refresh the instance list"),
            }
            LauncherError::ModNotFound(name) => match lang {
                Language::Russian => ErrorInfo::new("MOD_NOT_FOUND", format!("Мод '{}' не найден", name))
                    .with_hint("Проверьте название мода или попробуйте найти его на Modrinth/CurseForge вручную"),
                Language::English => ErrorInfo::new("MOD_NOT_FOUND", format!("Mod '{}' not found", name))
                    .with_hint("Check the mod name or try searching manually on Modrinth/CurseForge"),
            }
            LauncherError::NoCompatibleModVersion { mod_name, mc_version, loader } => match lang {
                Language::Russian => ErrorInfo::new("NO_COMPATIBLE_MOD_VERSION",
                    format!("Мод '{}' не имеет версии для Minecraft {} ({})", mod_name, mc_version, loader))
                    .with_hint(format!(
                        "Попробуйте:\n• Выбрать другую версию Minecraft\n• Поискать альтернативные моды\n• Проверить, поддерживает ли мод загрузчик {}",
                        loader
                    )),
                Language::English => ErrorInfo::new("NO_COMPATIBLE_MOD_VERSION",
                    format!("Mod '{}' has no version for Minecraft {} ({})", mod_name, mc_version, loader))
                    .with_hint(format!(
                        "Try:\n• Choosing a different Minecraft version\n• Looking for alternative mods\n• Checking if the mod supports {} loader",
                        loader
                    )),
            }
            LauncherError::ModDownloadFailed(details) => match lang {
                Language::Russian => ErrorInfo::new("MOD_DOWNLOAD_FAILED", "Не удалось загрузить файл мода")
                    .with_hint("Проверьте:\n• Подключение к интернету\n• Свободное место на диске\n• Попробуйте загрузить мод позже")
                    .with_details(details.clone()),
                Language::English => ErrorInfo::new("MOD_DOWNLOAD_FAILED", "Failed to download mod file")
                    .with_hint("Check:\n• Internet connection\n• Free disk space\n• Try downloading the mod later")
                    .with_details(details.clone()),
            }
            LauncherError::InsufficientDiskSpace { required, available } => match lang {
                Language::Russian => ErrorInfo::new("INSUFFICIENT_DISK_SPACE",
                    format!("Недостаточно места на диске: требуется {} МБ, доступно {} МБ", required, available))
                    .with_hint("Освободите место на диске и попробуйте снова"),
                Language::English => ErrorInfo::new("INSUFFICIENT_DISK_SPACE",
                    format!("Insufficient disk space: {} MB required, {} MB available", required, available))
                    .with_hint("Free up disk space and try again"),
            }
            LauncherError::JavaNotFound(version) => match lang {
                Language::Russian => ErrorInfo::new("JAVA_NOT_FOUND", format!("Java {} не установлена", version))
                    .with_hint("Java будет загружена автоматически при запуске экземпляра"),
                Language::English => ErrorInfo::new("JAVA_NOT_FOUND", format!("Java {} not installed", version))
                    .with_hint("Java will be downloaded automatically when starting the instance"),
            }
            LauncherError::MinecraftVersionNotFound(version) => match lang {
                Language::Russian => ErrorInfo::new("MC_VERSION_NOT_FOUND", format!("Версия Minecraft {} не найдена", version))
                    .with_hint("Проверьте подключение к интернету. Версия может быть недоступна"),
                Language::English => ErrorInfo::new("MC_VERSION_NOT_FOUND", format!("Minecraft version {} not found", version))
                    .with_hint("Check your internet connection. The version may be unavailable"),
            }
            LauncherError::LoaderVersionNotFound(loader, mc_version) => match lang {
                Language::Russian => ErrorInfo::new("LOADER_NOT_FOUND", format!("{} не поддерживает Minecraft {}", loader, mc_version))
                    .with_hint("Попробуйте выбрать другую версию Minecraft или загрузчик"),
                Language::English => ErrorInfo::new("LOADER_NOT_FOUND", format!("{} doesn't support Minecraft {}", loader, mc_version))
                    .with_hint("Try choosing a different Minecraft version or loader"),
            }
            LauncherError::InvalidVersion(msg) => match lang {
                Language::Russian => ErrorInfo::new("INVALID_VERSION", "Неверный формат версии")
                    .with_details(msg.clone()),
                Language::English => ErrorInfo::new("INVALID_VERSION", "Invalid version format")
                    .with_details(msg.clone()),
            }
            LauncherError::HashMismatch { expected, actual } => match lang {
                Language::Russian => ErrorInfo::new("HASH_MISMATCH", "Контрольная сумма файла не совпадает")
                    .with_hint("Файл мог быть повреждён при загрузке. Попробуйте скачать заново")
                    .with_details(format!("Ожидалось: {}, получено: {}", expected, actual)),
                Language::English => ErrorInfo::new("HASH_MISMATCH", "File hash mismatch")
                    .with_hint("The file may have been corrupted during download. Try downloading again")
                    .with_details(format!("Expected: {}, got: {}", expected, actual)),
            }
            LauncherError::DependencyConflict(msg) => match lang {
                Language::Russian => ErrorInfo::new("DEPENDENCY_CONFLICT", "Конфликт зависимостей")
                    .with_hint("Попробуйте удалить конфликтующие моды или найти совместимые версии")
                    .with_details(msg.clone()),
                Language::English => ErrorInfo::new("DEPENDENCY_CONFLICT", "Dependency conflict")
                    .with_hint("Try removing conflicting mods or finding compatible versions")
                    .with_details(msg.clone()),
            }
            LauncherError::InstanceAlreadyRunning => match lang {
                Language::Russian => ErrorInfo::new("INSTANCE_RUNNING", "Экземпляр уже запущен")
                    .with_hint("Закройте игру перед повторным запуском"),
                Language::English => ErrorInfo::new("INSTANCE_RUNNING", "Instance already running")
                    .with_hint("Close the game before restarting"),
            }
            LauncherError::InstanceNotRunning => match lang {
                Language::Russian => ErrorInfo::new("INSTANCE_NOT_RUNNING", "Экземпляр не запущен"),
                Language::English => ErrorInfo::new("INSTANCE_NOT_RUNNING", "Instance not running"),
            }
            LauncherError::InvalidConfig(msg) => match lang {
                Language::Russian => ErrorInfo::new("INVALID_CONFIG", "Некорректная конфигурация")
                    .with_hint("Проверьте настройки экземпляра")
                    .with_details(msg.clone()),
                Language::English => ErrorInfo::new("INVALID_CONFIG", "Invalid configuration")
                    .with_hint("Check instance settings")
                    .with_details(msg.clone()),
            }
            LauncherError::DownloadFailed(msg) => match lang {
                Language::Russian => ErrorInfo::new("DOWNLOAD_FAILED", "Ошибка загрузки")
                    .with_hint("Проверьте подключение к интернету и попробуйте снова")
                    .with_details(msg.clone()),
                Language::English => ErrorInfo::new("DOWNLOAD_FAILED", "Download failed")
                    .with_hint("Check your internet connection and try again")
                    .with_details(msg.clone()),
            }
            LauncherError::ApiError(msg) => match lang {
                Language::Russian => ErrorInfo::new("API_ERROR", "Ошибка API")
                    .with_hint("Сервис может быть временно недоступен. Попробуйте позже")
                    .with_details(msg.clone()),
                Language::English => ErrorInfo::new("API_ERROR", "API error")
                    .with_hint("The service may be temporarily unavailable. Try again later")
                    .with_details(msg.clone()),
            }
            LauncherError::Join(msg) => match lang {
                Language::Russian => ErrorInfo::new("TASK_ERROR", "Ошибка выполнения задачи")
                    .with_details(msg.clone()),
                Language::English => ErrorInfo::new("TASK_ERROR", "Task execution error")
                    .with_details(msg.clone()),
            }
            LauncherError::OperationCancelled => match lang {
                Language::Russian => ErrorInfo::new("CANCELLED", "Операция отменена"),
                Language::English => ErrorInfo::new("CANCELLED", "Operation cancelled"),
            }
            LauncherError::NotFound(msg) => match lang {
                Language::Russian => ErrorInfo::new("NOT_FOUND", "Ресурс не найден")
                    .with_details(msg.clone()),
                Language::English => ErrorInfo::new("NOT_FOUND", "Resource not found")
                    .with_details(msg.clone()),
            }
        }
    }
}

impl From<tokio::task::JoinError> for LauncherError {
    fn from(err: tokio::task::JoinError) -> Self {
        LauncherError::Join(err.to_string())
    }
}

pub type Result<T> = std::result::Result<T, LauncherError>;

impl serde::Serialize for LauncherError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        // Сериализуем как ErrorInfo для более полной информации
        self.to_error_info().serialize(serializer)
    }
}
