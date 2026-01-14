//! Delta-sync модуль для эффективной передачи модпаков
//!
//! Использует хеширование файлов для определения различий и передаёт только изменённые файлы.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;
use tokio::fs;
use tokio::io::AsyncReadExt;

/// Информация о файле для синхронизации
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileInfo {
    /// Относительный путь от корня модпака
    pub path: String,
    /// Размер файла в байтах
    pub size: u64,
    /// SHA-256 хеш файла
    pub hash: String,
    /// Время последнего изменения (Unix timestamp)
    pub modified: u64,
}

/// Манифест модпака для синхронизации
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModpackManifest {
    /// Название модпака
    pub name: String,
    /// Версия Minecraft
    pub minecraft_version: String,
    /// Загрузчик модов
    pub loader: String,
    /// Версия загрузчика
    pub loader_version: String,
    /// Список файлов в модпаке
    pub files: Vec<FileInfo>,
    /// Общий хеш манифеста
    pub manifest_hash: String,
}

/// Результат сравнения двух манифестов
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncDiff {
    /// Файлы которые нужно добавить/обновить
    pub to_download: Vec<FileInfo>,
    /// Файлы которые нужно удалить
    pub to_delete: Vec<String>,
    /// Общий размер для скачивания
    pub total_download_size: u64,
    /// Количество неизменённых файлов
    pub unchanged_count: usize,
}

/// Статус передачи
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum TransferStatus {
    /// Ожидание начала
    Pending,
    /// Вычисление хешей
    Hashing { progress: f32, current_file: String },
    /// Сравнение манифестов
    Comparing,
    /// Передача файлов
    Transferring {
        progress: f32,
        current_file: String,
        bytes_transferred: u64,
        total_bytes: u64,
    },
    /// Применение изменений
    Applying { progress: f32 },
    /// Завершено
    Completed {
        files_synced: usize,
        bytes_synced: u64,
    },
    /// Ошибка
    Error { message: String },
}

/// Менеджер передачи файлов
pub struct TransferManager {
    /// Текущий статус
    status: TransferStatus,
}

impl TransferManager {
    pub fn new() -> Self {
        Self {
            status: TransferStatus::Pending,
        }
    }

    /// Создать манифест для папки модпака
    pub async fn create_manifest(
        instance_path: &Path,
        name: &str,
        minecraft_version: &str,
        loader: &str,
        loader_version: &str,
    ) -> Result<ModpackManifest, String> {
        let mut files = Vec::new();

        // Сканируем папки которые нужно синхронизировать
        let sync_folders = ["mods", "config", "resourcepacks", "shaderpacks"];

        for folder in sync_folders {
            let folder_path = instance_path.join(folder);
            if folder_path.exists() {
                Self::scan_directory(&folder_path, &folder_path, &mut files).await?;
            }
        }

        // Вычисляем хеш манифеста
        let manifest_hash = Self::compute_manifest_hash(&files);

        Ok(ModpackManifest {
            name: name.to_string(),
            minecraft_version: minecraft_version.to_string(),
            loader: loader.to_string(),
            loader_version: loader_version.to_string(),
            files,
            manifest_hash,
        })
    }

    /// Рекурсивно сканирует директорию и добавляет файлы
    async fn scan_directory(
        base_path: &Path,
        current_path: &Path,
        files: &mut Vec<FileInfo>,
    ) -> Result<(), String> {
        let mut entries = fs::read_dir(current_path)
            .await
            .map_err(|e| format!("Failed to read directory: {}", e))?;

        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|e| format!("Failed to read entry: {}", e))?
        {
            let path = entry.path();
            let metadata = entry
                .metadata()
                .await
                .map_err(|e| format!("Failed to read metadata: {}", e))?;

            if metadata.is_file() {
                // Вычисляем относительный путь
                let relative_path = path
                    .strip_prefix(base_path.parent().unwrap_or(base_path))
                    .map_err(|e| format!("Failed to compute relative path: {}", e))?
                    .to_string_lossy()
                    .to_string();

                // Вычисляем хеш файла
                let hash = Self::compute_file_hash(&path).await?;

                // Получаем время модификации
                let modified = metadata
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);

                files.push(FileInfo {
                    path: relative_path,
                    size: metadata.len(),
                    hash,
                    modified,
                });
            } else if metadata.is_dir() {
                // Рекурсивно обрабатываем поддиректории
                Box::pin(Self::scan_directory(base_path, &path, files)).await?;
            }
        }

        Ok(())
    }

    /// Вычисляет SHA-256 хеш файла (внутренний метод)
    async fn compute_file_hash(path: &Path) -> Result<String, String> {
        Self::compute_file_hash_static(path).await
    }

    /// Вычисляет SHA-256 хеш файла (статический метод для внешнего использования)
    pub async fn compute_file_hash_static(path: &Path) -> Result<String, String> {
        let mut file = fs::File::open(path)
            .await
            .map_err(|e| format!("Failed to open file: {}", e))?;

        let mut hasher = Sha256::new();
        let mut buffer = vec![0u8; 64 * 1024]; // 64KB буфер

        loop {
            let bytes_read = file
                .read(&mut buffer)
                .await
                .map_err(|e| format!("Failed to read file: {}", e))?;

            if bytes_read == 0 {
                break;
            }

            hasher.update(&buffer[..bytes_read]);
        }

        let result = hasher.finalize();
        Ok(hex::encode(result))
    }

    /// Вычисляет хеш манифеста на основе всех файлов
    fn compute_manifest_hash(files: &[FileInfo]) -> String {
        let mut hasher = Sha256::new();

        for file in files {
            hasher.update(file.path.as_bytes());
            hasher.update(file.hash.as_bytes());
        }

        hex::encode(hasher.finalize())
    }

    /// Сравнивает локальный и удалённый манифесты
    pub fn compute_diff(local: &ModpackManifest, remote: &ModpackManifest) -> SyncDiff {
        // Создаём индекс локальных файлов по пути
        let local_files: HashMap<&str, &FileInfo> =
            local.files.iter().map(|f| (f.path.as_str(), f)).collect();

        // Создаём индекс удалённых файлов по пути
        let remote_files: HashMap<&str, &FileInfo> =
            remote.files.iter().map(|f| (f.path.as_str(), f)).collect();

        let mut to_download = Vec::new();
        let mut to_delete = Vec::new();
        let mut unchanged_count = 0;

        // Находим файлы для скачивания/обновления
        for (path, remote_file) in &remote_files {
            match local_files.get(path) {
                Some(local_file) if local_file.hash == remote_file.hash => {
                    // Файл не изменился
                    unchanged_count += 1;
                }
                _ => {
                    // Файл новый или изменился
                    to_download.push((*remote_file).clone());
                }
            }
        }

        // Находим файлы для удаления
        for (path, _) in &local_files {
            if !remote_files.contains_key(path) {
                to_delete.push(path.to_string());
            }
        }

        let total_download_size = to_download.iter().map(|f| f.size).sum();

        SyncDiff {
            to_download,
            to_delete,
            total_download_size,
            unchanged_count,
        }
    }

    /// Получить текущий статус
    pub fn status(&self) -> &TransferStatus {
        &self.status
    }

    /// Установить статус
    pub fn set_status(&mut self, status: TransferStatus) {
        self.status = status;
        log::debug!("Transfer status: {:?}", self.status);
    }
}

impl Default for TransferManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Сообщения протокола для передачи файлов
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TransferMessage {
    /// Запрос манифеста модпака
    ManifestRequest { modpack_name: String },

    /// Ответ с манифестом
    ManifestResponse { manifest: ModpackManifest },

    /// Запрос файла
    FileRequest { path: String, offset: u64 },

    /// Данные файла (чанк)
    FileData {
        path: String,
        offset: u64,
        data: Vec<u8>,
        is_last: bool,
    },

    /// Файл успешно получен
    FileAck { path: String },

    /// Синхронизация завершена
    SyncComplete {
        files_synced: usize,
        bytes_synced: u64,
    },

    /// Ошибка передачи
    TransferError { message: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compute_diff_new_file() {
        let local = ModpackManifest {
            name: "Test".to_string(),
            minecraft_version: "1.20.1".to_string(),
            loader: "fabric".to_string(),
            loader_version: "0.14.21".to_string(),
            files: vec![],
            manifest_hash: "".to_string(),
        };

        let remote = ModpackManifest {
            name: "Test".to_string(),
            minecraft_version: "1.20.1".to_string(),
            loader: "fabric".to_string(),
            loader_version: "0.14.21".to_string(),
            files: vec![FileInfo {
                path: "mods/test.jar".to_string(),
                size: 1024,
                hash: "abc123".to_string(),
                modified: 0,
            }],
            manifest_hash: "".to_string(),
        };

        let diff = TransferManager::compute_diff(&local, &remote);

        assert_eq!(diff.to_download.len(), 1);
        assert_eq!(diff.to_delete.len(), 0);
        assert_eq!(diff.unchanged_count, 0);
        assert_eq!(diff.total_download_size, 1024);
    }

    #[test]
    fn test_compute_diff_unchanged() {
        let file = FileInfo {
            path: "mods/test.jar".to_string(),
            size: 1024,
            hash: "abc123".to_string(),
            modified: 0,
        };

        let local = ModpackManifest {
            name: "Test".to_string(),
            minecraft_version: "1.20.1".to_string(),
            loader: "fabric".to_string(),
            loader_version: "0.14.21".to_string(),
            files: vec![file.clone()],
            manifest_hash: "".to_string(),
        };

        let remote = ModpackManifest {
            name: "Test".to_string(),
            minecraft_version: "1.20.1".to_string(),
            loader: "fabric".to_string(),
            loader_version: "0.14.21".to_string(),
            files: vec![file],
            manifest_hash: "".to_string(),
        };

        let diff = TransferManager::compute_diff(&local, &remote);

        assert_eq!(diff.to_download.len(), 0);
        assert_eq!(diff.to_delete.len(), 0);
        assert_eq!(diff.unchanged_count, 1);
        assert_eq!(diff.total_download_size, 0);
    }

    #[test]
    fn test_compute_diff_deleted_file() {
        let local = ModpackManifest {
            name: "Test".to_string(),
            minecraft_version: "1.20.1".to_string(),
            loader: "fabric".to_string(),
            loader_version: "0.14.21".to_string(),
            files: vec![FileInfo {
                path: "mods/old.jar".to_string(),
                size: 512,
                hash: "def456".to_string(),
                modified: 0,
            }],
            manifest_hash: "".to_string(),
        };

        let remote = ModpackManifest {
            name: "Test".to_string(),
            minecraft_version: "1.20.1".to_string(),
            loader: "fabric".to_string(),
            loader_version: "0.14.21".to_string(),
            files: vec![],
            manifest_hash: "".to_string(),
        };

        let diff = TransferManager::compute_diff(&local, &remote);

        assert_eq!(diff.to_download.len(), 0);
        assert_eq!(diff.to_delete.len(), 1);
        assert_eq!(diff.to_delete[0], "mods/old.jar");
    }
}
