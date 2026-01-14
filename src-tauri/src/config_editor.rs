use crate::error::{LauncherError, Result};
use crate::paths::get_base_dir;
use std::path::PathBuf;

/// Типы конфигурационных файлов
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConfigType {
    Toml,
    Json,
    Properties,
    Yaml,
    Txt,
}

impl ConfigType {
    pub fn from_extension(ext: &str) -> Option<Self> {
        match ext.to_lowercase().as_str() {
            "toml" => Some(Self::Toml),
            "json" | "json5" => Some(Self::Json),
            "properties" => Some(Self::Properties),
            "yaml" | "yml" => Some(Self::Yaml),
            "txt" | "cfg" => Some(Self::Txt),
            _ => None,
        }
    }
}

/// Информация о конфигурационном файле
#[derive(Debug, Clone, serde::Serialize)]
pub struct ConfigFile {
    pub path: String,
    pub name: String,
    pub config_type: ConfigType,
    pub size: u64,
    pub modified: String,
}

/// Содержимое конфигурационного файла
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ConfigContent {
    pub path: String,
    pub content: String,
    pub config_type: ConfigType,
}

/// Менеджер конфигурационных файлов
pub struct ConfigManager;

impl ConfigManager {
    /// Получить список конфигурационных файлов в директории instance
    pub async fn list_config_files(instance_id: &str, subdir: &str) -> Result<Vec<ConfigFile>> {
        let base_dir = get_base_dir().join("instances");
        let config_dir = base_dir.join(instance_id).join(subdir);

        if !tokio::fs::try_exists(&config_dir).await.unwrap_or(false) {
            return Ok(Vec::new());
        }

        let mut configs = Vec::new();
        let mut entries = tokio::fs::read_dir(&config_dir).await.map_err(|e| {
            LauncherError::Io(std::io::Error::new(
                e.kind(),
                format!("Failed to read config directory: {}", e),
            ))
        })?;

        while let Some(entry) = entries.next_entry().await.map_err(|e| {
            LauncherError::Io(std::io::Error::new(
                e.kind(),
                format!("Failed to read directory entry: {}", e),
            ))
        })? {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }

            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();

            let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("");

            if let Some(config_type) = ConfigType::from_extension(extension) {
                let metadata = tokio::fs::metadata(&path).await.map_err(|e| {
                    LauncherError::Io(std::io::Error::new(
                        e.kind(),
                        format!("Failed to read file metadata: {}", e),
                    ))
                })?;

                let relative_path = path
                    .strip_prefix(&base_dir.join(instance_id))
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .to_string();

                configs.push(ConfigFile {
                    path: relative_path,
                    name,
                    config_type,
                    size: metadata.len(),
                    modified: metadata
                        .modified()
                        .ok()
                        .and_then(|t| {
                            t.duration_since(std::time::UNIX_EPOCH)
                                .ok()
                                .map(|d| d.as_secs())
                        })
                        .map(|t| chrono::DateTime::from_timestamp(t as i64, 0))
                        .flatten()
                        .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
                        .unwrap_or_default(),
                });
            }
        }

        configs.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(configs)
    }

    /// Прочитать содержимое конфигурационного файла
    pub async fn read_config_file(instance_id: &str, relative_path: &str) -> Result<ConfigContent> {
        let base_dir = get_base_dir().join("instances");
        let file_path = base_dir.join(instance_id).join(relative_path);

        // Проверка безопасности: файл должен быть внутри instance директории
        let canonical_base = base_dir.join(instance_id).canonicalize().map_err(|e| {
            LauncherError::Io(std::io::Error::new(
                e.kind(),
                "Failed to resolve instance directory",
            ))
        })?;

        let canonical_file = file_path
            .canonicalize()
            .map_err(|e| LauncherError::Io(std::io::Error::new(e.kind(), "File not found")))?;

        if !canonical_file.starts_with(&canonical_base) {
            return Err(LauncherError::InvalidConfig(
                "Path traversal attempt detected".to_string(),
            ));
        }

        let content = tokio::fs::read_to_string(&file_path).await.map_err(|e| {
            LauncherError::Io(std::io::Error::new(
                e.kind(),
                format!("Failed to read config file: {}", e),
            ))
        })?;

        let extension = file_path.extension().and_then(|e| e.to_str()).unwrap_or("");

        let config_type = ConfigType::from_extension(extension).unwrap_or(ConfigType::Txt);

        Ok(ConfigContent {
            path: relative_path.to_string(),
            content,
            config_type,
        })
    }

    /// Записать содержимое конфигурационного файла
    pub async fn write_config_file(
        instance_id: &str,
        relative_path: &str,
        content: &str,
    ) -> Result<()> {
        let base_dir = get_base_dir().join("instances");
        let file_path = base_dir.join(instance_id).join(relative_path);

        // Проверка безопасности
        let canonical_base = base_dir.join(instance_id).canonicalize().map_err(|e| {
            LauncherError::Io(std::io::Error::new(
                e.kind(),
                "Failed to resolve instance directory",
            ))
        })?;

        // Создаем родительские директории если нужно
        if let Some(parent) = file_path.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| {
                LauncherError::Io(std::io::Error::new(
                    e.kind(),
                    "Failed to create parent directories",
                ))
            })?;
        }

        let canonical_file = file_path.canonicalize().or_else(|_| {
            // Если файл не существует, проверяем родительскую директорию
            let parent = file_path
                .parent()
                .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "Invalid path"))?;
            let file_name = file_path
                .file_name()
                .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "Invalid file name"))?;
            parent.canonicalize().map(|p| p.join(file_name))
        })?;

        if !canonical_file.starts_with(&canonical_base) {
            return Err(LauncherError::InvalidConfig(
                "Path traversal attempt detected".to_string(),
            ));
        }

        tokio::fs::write(&file_path, content).await.map_err(|e| {
            LauncherError::Io(std::io::Error::new(
                e.kind(),
                format!("Failed to write config file: {}", e),
            ))
        })?;

        Ok(())
    }

    /// Создать резервную копию конфига перед изменением
    pub async fn backup_config(instance_id: &str, relative_path: &str) -> Result<String> {
        let base_dir = get_base_dir().join("instances");
        let file_path = base_dir.join(instance_id).join(relative_path);

        if !tokio::fs::try_exists(&file_path).await.unwrap_or(false) {
            return Err(LauncherError::InvalidConfig("File not found".to_string()));
        }

        let timestamp = chrono::Utc::now().format("%Y%m%d_%H%M%S");
        let backup_name = format!("{}.backup_{}", relative_path, timestamp);
        let backup_path = base_dir.join(instance_id).join(&backup_name);

        tokio::fs::copy(&file_path, &backup_path)
            .await
            .map_err(|e| {
                LauncherError::Io(std::io::Error::new(
                    e.kind(),
                    format!("Failed to create backup: {}", e),
                ))
            })?;

        Ok(backup_name)
    }
}
