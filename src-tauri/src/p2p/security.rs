//! Модуль безопасности для P2P передачи
//!
//! Включает защиту от:
//! - Path traversal атак
//! - Чрезмерно больших файлов
//! - Rate limiting для защиты от DoS
//! - Валидацию входных данных

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

/// Максимальный размер одного файла (500 MB)
pub const MAX_FILE_SIZE: u64 = 500 * 1024 * 1024;

/// Максимальный общий размер передачи (5 GB)
pub const MAX_TOTAL_TRANSFER_SIZE: u64 = 5 * 1024 * 1024 * 1024;

/// Максимальное количество файлов в одной передаче
pub const MAX_FILES_PER_TRANSFER: usize = 10000;

/// Максимальная длина пути
pub const MAX_PATH_LENGTH: usize = 500;

/// Максимальная длина имени модпака
pub const MAX_MODPACK_NAME_LENGTH: usize = 100;

/// Максимальный размер сообщения протокола (10 MB)
pub const MAX_MESSAGE_SIZE: usize = 10 * 1024 * 1024;

/// Разрешённые расширения файлов для передачи
pub const ALLOWED_EXTENSIONS: &[&str] = &[
    "jar", "json", "toml", "cfg", "properties", "txt", "md",
    "png", "jpg", "jpeg", "gif", "zip", "gz", "nbt", "dat",
    "mcmeta", "lang", "ogg", "wav", "fsh", "vsh", "glsl",
];

/// Запрещённые паттерны в путях
const FORBIDDEN_PATH_PATTERNS: &[&str] = &[
    "..", "~", "$", "%", "\\\\", "//",
    ".git", ".svn", ".env", "node_modules",
    "id_rsa", "id_ed25519", "known_hosts",
    "credentials", "secrets", "tokens",
];

/// Запрещённые директории (абсолютные пути)
const FORBIDDEN_DIRECTORIES: &[&str] = &[
    "/etc", "/usr", "/bin", "/sbin", "/var", "/root", "/home",
    "C:\\Windows", "C:\\Program Files", "C:\\Users",
];

/// Rate limiter для защиты от DoS
pub struct RateLimiter {
    requests: Arc<RwLock<HashMap<String, Vec<Instant>>>>,
    max_requests: usize,
    window: Duration,
}

impl RateLimiter {
    pub fn new(max_requests: usize, window_secs: u64) -> Self {
        Self {
            requests: Arc::new(RwLock::new(HashMap::new())),
            max_requests,
            window: Duration::from_secs(window_secs),
        }
    }

    /// Проверить, разрешён ли запрос для данного IP
    pub async fn check(&self, peer_id: &str) -> bool {
        let mut requests = self.requests.write().await;
        let now = Instant::now();

        let entry = requests.entry(peer_id.to_string()).or_insert_with(Vec::new);

        // Удаляем старые записи
        entry.retain(|t| now.duration_since(*t) < self.window);

        if entry.len() >= self.max_requests {
            log::warn!("Rate limit exceeded for peer: {}", peer_id);
            return false;
        }

        entry.push(now);
        true
    }

    /// Очистить старые записи (вызывать периодически)
    pub async fn cleanup(&self) {
        let mut requests = self.requests.write().await;
        let now = Instant::now();

        requests.retain(|_, times| {
            times.retain(|t| now.duration_since(*t) < self.window);
            !times.is_empty()
        });
    }
}

/// Результат валидации
#[derive(Debug)]
pub enum ValidationError {
    PathTraversal(String),
    InvalidCharacters(String),
    PathTooLong,
    ForbiddenExtension(String),
    ForbiddenDirectory(String),
    FileTooLarge(u64),
    TooManyFiles(usize),
    TotalSizeTooLarge(u64),
    InvalidPeerId,
    InvalidModpackName,
}

impl std::fmt::Display for ValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PathTraversal(p) => write!(f, "Path traversal detected: {}", p),
            Self::InvalidCharacters(p) => write!(f, "Invalid characters in path: {}", p),
            Self::PathTooLong => write!(f, "Path too long"),
            Self::ForbiddenExtension(ext) => write!(f, "Forbidden file extension: {}", ext),
            Self::ForbiddenDirectory(dir) => write!(f, "Access to forbidden directory: {}", dir),
            Self::FileTooLarge(size) => write!(f, "File too large: {} bytes", size),
            Self::TooManyFiles(count) => write!(f, "Too many files: {}", count),
            Self::TotalSizeTooLarge(size) => write!(f, "Total transfer size too large: {} bytes", size),
            Self::InvalidPeerId => write!(f, "Invalid peer ID format"),
            Self::InvalidModpackName => write!(f, "Invalid modpack name"),
        }
    }
}

/// Очистить и провалидировать путь файла
///
/// Возвращает безопасный путь относительно base_path или ошибку
pub fn sanitize_path(path: &str, base_path: &Path) -> Result<PathBuf, ValidationError> {
    // Проверяем длину
    if path.len() > MAX_PATH_LENGTH {
        return Err(ValidationError::PathTooLong);
    }

    // Проверяем запрещённые паттерны
    let path_lower = path.to_lowercase();
    for pattern in FORBIDDEN_PATH_PATTERNS {
        if path_lower.contains(pattern) {
            return Err(ValidationError::PathTraversal(pattern.to_string()));
        }
    }

    // Нормализуем разделители путей
    let normalized = path.replace('\\', "/");

    // Проверяем на абсолютный путь
    if normalized.starts_with('/') || normalized.contains(':') {
        return Err(ValidationError::PathTraversal("absolute path".to_string()));
    }

    // Разбиваем путь и проверяем каждый компонент
    let components: Vec<&str> = normalized.split('/').filter(|s| !s.is_empty()).collect();

    for component in &components {
        // Проверяем на ".."
        if *component == ".." || *component == "." {
            return Err(ValidationError::PathTraversal(component.to_string()));
        }

        // Проверяем на недопустимые символы
        if component.contains(|c: char| {
            c == '<' || c == '>' || c == ':' || c == '"' || c == '|' || c == '?' || c == '*'
            || c == '\0' || c == '\n' || c == '\r'
        }) {
            return Err(ValidationError::InvalidCharacters(component.to_string()));
        }
    }

    // Собираем безопасный путь
    let mut safe_path = base_path.to_path_buf();
    for component in components {
        safe_path.push(component);
    }

    // Финальная проверка - путь должен быть внутри base_path
    let canonical_base = base_path.canonicalize().unwrap_or_else(|_| base_path.to_path_buf());

    // Проверяем что результирующий путь начинается с base_path
    // (canonicalize может не работать для несуществующих путей, поэтому проверяем prefix)
    if !safe_path.starts_with(&canonical_base) && !safe_path.starts_with(base_path) {
        return Err(ValidationError::PathTraversal("path escape".to_string()));
    }

    // Проверяем на запрещённые директории
    let path_str = safe_path.to_string_lossy().to_lowercase();
    for forbidden in FORBIDDEN_DIRECTORIES {
        if path_str.starts_with(&forbidden.to_lowercase()) {
            return Err(ValidationError::ForbiddenDirectory(forbidden.to_string()));
        }
    }

    Ok(safe_path)
}

/// Проверить расширение файла
pub fn validate_extension(path: &str) -> Result<(), ValidationError> {
    let extension = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase());

    match extension {
        Some(ext) => {
            if ALLOWED_EXTENSIONS.contains(&ext.as_str()) {
                Ok(())
            } else {
                // Разрешаем файлы без расширения (конфиги и т.п.)
                if ext.is_empty() {
                    Ok(())
                } else {
                    Err(ValidationError::ForbiddenExtension(ext))
                }
            }
        }
        // Файлы без расширения разрешены
        None => Ok(()),
    }
}

/// Валидировать peer ID
pub fn validate_peer_id(peer_id: &str) -> Result<(), ValidationError> {
    // Peer ID должен быть непустым и содержать только безопасные символы
    if peer_id.is_empty() || peer_id.len() > 100 {
        return Err(ValidationError::InvalidPeerId);
    }

    // Разрешаем только буквы, цифры, дефисы и точки
    if !peer_id.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '.' || c == '_') {
        return Err(ValidationError::InvalidPeerId);
    }

    Ok(())
}

/// Валидировать имя модпака
pub fn validate_modpack_name(name: &str) -> Result<(), ValidationError> {
    if name.is_empty() || name.len() > MAX_MODPACK_NAME_LENGTH {
        return Err(ValidationError::InvalidModpackName);
    }

    // Проверяем на path traversal в имени
    if name.contains("..") || name.contains('/') || name.contains('\\') {
        return Err(ValidationError::InvalidModpackName);
    }

    // Разрешаем только безопасные символы
    if !name.chars().all(|c| {
        c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' || c == '.' || c == '(' || c == ')'
    }) {
        return Err(ValidationError::InvalidModpackName);
    }

    Ok(())
}

/// Валидировать размер файла
pub fn validate_file_size(size: u64) -> Result<(), ValidationError> {
    if size > MAX_FILE_SIZE {
        return Err(ValidationError::FileTooLarge(size));
    }
    Ok(())
}

/// Валидировать общий размер передачи
pub fn validate_transfer_size(total_size: u64, file_count: usize) -> Result<(), ValidationError> {
    if total_size > MAX_TOTAL_TRANSFER_SIZE {
        return Err(ValidationError::TotalSizeTooLarge(total_size));
    }
    if file_count > MAX_FILES_PER_TRANSFER {
        return Err(ValidationError::TooManyFiles(file_count));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_path_traversal_protection() {
        let base = PathBuf::from("/home/user/instances");

        // Должно быть отклонено
        assert!(sanitize_path("../etc/passwd", &base).is_err());
        assert!(sanitize_path("..\\..\\Windows\\System32", &base).is_err());
        assert!(sanitize_path("/etc/passwd", &base).is_err());
        assert!(sanitize_path("C:\\Windows\\System32", &base).is_err());
        assert!(sanitize_path("mods/../../../etc/passwd", &base).is_err());
        assert!(sanitize_path(".git/config", &base).is_err());
        assert!(sanitize_path("mod$pack", &base).is_err());

        // Должно быть разрешено
        assert!(sanitize_path("mods/fabric-api.jar", &base).is_ok());
        assert!(sanitize_path("config/mod.toml", &base).is_ok());
        assert!(sanitize_path("resourcepacks/pack.zip", &base).is_ok());
    }

    #[test]
    fn test_extension_validation() {
        assert!(validate_extension("mod.jar").is_ok());
        assert!(validate_extension("config.json").is_ok());
        assert!(validate_extension("settings.toml").is_ok());
        assert!(validate_extension("script.exe").is_err());
        assert!(validate_extension("virus.bat").is_err());
        assert!(validate_extension("shell.sh").is_err());
    }

    #[test]
    fn test_peer_id_validation() {
        assert!(validate_peer_id("abc-123").is_ok());
        assert!(validate_peer_id("peer.local").is_ok());
        assert!(validate_peer_id("").is_err());
        assert!(validate_peer_id("../etc").is_err());
        assert!(validate_peer_id("peer<script>").is_err());
    }

    #[test]
    fn test_modpack_name_validation() {
        assert!(validate_modpack_name("My Modpack").is_ok());
        assert!(validate_modpack_name("Create-1.20.1").is_ok());
        assert!(validate_modpack_name("../malicious").is_err());
        assert!(validate_modpack_name("pack/../../etc").is_err());
        assert!(validate_modpack_name("").is_err());
    }
}
