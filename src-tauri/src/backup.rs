//! Smart Backup System
//!
//! Умные бэкапы с:
//! - Детекцией backup модов (не дублируем бэкапы миров)
//! - Инкрементальными бэкапами
//! - Автоочисткой старых бэкапов
//! - Сжатием zstd

use crate::db::get_db_conn;
use crate::error::{LauncherError, Result};
use crate::paths::instance_dir;
use crate::settings::SettingsManager;
use chrono::Utc;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tokio::fs;

/// Известные моды бэкапов (если установлены - не бэкапим saves/)
const KNOWN_BACKUP_MODS: &[&str] = &[
    // Fabric/Forge
    "ftb-backups",
    "ftbbackups",
    "ftb-backups-2",
    "ftbbackups2",
    // AromaBackup
    "aromabackup",
    "aroma-backup",
    "aroma1997s-backup",
    // Simple Backups
    "simple-backups",
    "simplebackups",
    // Easy Backups
    "easy-backups",
    "easybackups",
    // World Backup
    "world-backup",
    "worldbackup",
    // Server side
    "essential-backup",
    "backup-mod",
    "server-backup",
];

/// Триггер бэкапа
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackupTrigger {
    /// Перед установкой мода
    BeforeModInstall { mod_name: String },
    /// Перед удалением мода
    BeforeModRemove { mod_name: String },
    /// Перед обновлением мода
    BeforeModUpdate {
        mod_name: String,
        from: String,
        to: String,
    },
    /// Перед применением автофикса
    BeforeAutoFix { fix_type: String },
    /// Ручной бэкап
    Manual,
}

/// Запись о бэкапе
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupRecord {
    pub id: String,
    pub instance_id: String,
    pub trigger: BackupTrigger,
    pub created_at: String,
    pub size_bytes: u64,
    pub includes_saves: bool,
    pub file_count: u32,
    pub path: String,
}

/// Статус детекции backup мода
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupModStatus {
    pub has_backup_mod: bool,
    pub detected_mod: Option<String>,
    pub message: String,
}

/// Менеджер бэкапов
pub struct BackupManager;

impl BackupManager {
    /// Проверить, установлен ли мод бэкапов
    pub async fn detect_backup_mod(instance_id: &str) -> Result<BackupModStatus> {
        let conn = get_db_conn()?;

        // Получаем список установленных модов
        let mut stmt =
            conn.prepare("SELECT slug, name FROM mods WHERE instance_id = ?1 AND enabled = 1")?;

        let mods: Vec<(String, String)> = stmt
            .query_map([instance_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .filter_map(|r| r.ok())
            .collect();

        // Проверяем на известные backup моды
        for (slug, name) in &mods {
            let slug_lower = slug.to_lowercase();
            let name_lower = name.to_lowercase();

            for known in KNOWN_BACKUP_MODS {
                if slug_lower.contains(known) || name_lower.contains(known) {
                    return Ok(BackupModStatus {
                        has_backup_mod: true,
                        detected_mod: Some(name.clone()),
                        message: format!(
                            "Обнаружен мод бэкапов '{}'. Миры бэкапятся им, мы бэкапим только моды и конфиги.",
                            name
                        ),
                    });
                }
            }
        }

        Ok(BackupModStatus {
            has_backup_mod: false,
            detected_mod: None,
            message: "Мод бэкапов не обнаружен. Бэкапим моды, конфиги и миры.".to_string(),
        })
    }

    /// Проверить, нужно ли делать бэкап для экземпляра
    pub async fn should_backup(instance_id: &str) -> Result<bool> {
        // Проверяем глобальную настройку
        let settings = SettingsManager::get_all()?;
        if !settings.backup_enabled {
            return Ok(false);
        }

        // Проверяем override на уровне экземпляра
        let conn = get_db_conn()?;
        let instance_backup: Option<Option<i32>> = conn
            .query_row(
                "SELECT backup_enabled FROM instances WHERE id = ?1",
                [instance_id],
                |row| row.get(0),
            )
            .ok();

        match instance_backup.flatten() {
            Some(0) => Ok(false),                // Явно отключено для экземпляра
            Some(1) => Ok(true),                 // Явно включено для экземпляра
            None => Ok(settings.backup_enabled), // Используем глобальную настройку
            _ => Ok(settings.backup_enabled),
        }
    }

    /// Получить директорию для бэкапов экземпляра
    pub(crate) fn backup_dir(instance_id: &str) -> PathBuf {
        instance_dir(instance_id).join(".backups")
    }

    /// Создать бэкап экземпляра
    pub async fn create_backup(instance_id: &str, trigger: BackupTrigger) -> Result<BackupRecord> {
        // Проверяем, нужно ли делать бэкап
        if !Self::should_backup(instance_id).await? {
            return Err(LauncherError::InvalidConfig(
                "Бэкапы отключены для этого экземпляра".to_string(),
            ));
        }

        let settings = SettingsManager::get_all()?;
        let instance_path = instance_dir(instance_id);
        let backup_dir = Self::backup_dir(instance_id);

        // Создаём директорию бэкапов если не существует
        fs::create_dir_all(&backup_dir).await?;

        // Определяем, нужно ли бэкапить saves
        let backup_mod_status = Self::detect_backup_mod(instance_id).await?;
        let include_saves = settings.backup_include_saves && !backup_mod_status.has_backup_mod;

        // Генерируем ID бэкапа
        let backup_id = format!(
            "backup_{}_{}",
            Utc::now().format("%Y%m%d_%H%M%S"),
            &instance_id[..6.min(instance_id.len())]
        );

        let backup_path = backup_dir.join(format!("{}.tar.zst", backup_id));

        // Собираем файлы для бэкапа
        let mut files_to_backup: Vec<PathBuf> = Vec::new();

        // Всегда бэкапим mods/ и config/
        let mods_dir = instance_path.join("mods");
        let config_dir = instance_path.join("config");

        if fs::try_exists(&mods_dir).await.unwrap_or(false) {
            collect_files_recursive(&mods_dir, &mut files_to_backup).await?;
        }
        if fs::try_exists(&config_dir).await.unwrap_or(false) {
            collect_files_recursive(&config_dir, &mut files_to_backup).await?;
        }

        // Опционально бэкапим saves/
        if include_saves {
            let saves_dir = instance_path.join("saves");
            if fs::try_exists(&saves_dir).await.unwrap_or(false) {
                collect_files_recursive(&saves_dir, &mut files_to_backup).await?;
            }
        }

        // Создаём tar.zst архив
        let total_size =
            create_compressed_archive(&instance_path, &files_to_backup, &backup_path).await?;

        let file_count = files_to_backup.len() as u32;
        let now = Utc::now().to_rfc3339();

        // Сохраняем запись в БД
        let record = BackupRecord {
            id: backup_id.clone(),
            instance_id: instance_id.to_string(),
            trigger,
            created_at: now.clone(),
            size_bytes: total_size,
            includes_saves: include_saves,
            file_count,
            path: backup_path.to_string_lossy().to_string(),
        };

        Self::save_backup_record(&record)?;

        // Очищаем старые бэкапы
        Self::cleanup_old_backups(instance_id, settings.backup_max_count as usize).await?;

        log::info!(
            "Created backup {} for instance {} ({} files, {} bytes)",
            backup_id,
            instance_id,
            file_count,
            total_size
        );

        Ok(record)
    }

    /// Сохранить запись о бэкапе в БД
    pub(crate) fn save_backup_record(record: &BackupRecord) -> Result<()> {
        let conn = get_db_conn()?;

        // Создаём таблицу если не существует
        conn.execute(
            r#"CREATE TABLE IF NOT EXISTS backups (
                id TEXT PRIMARY KEY,
                instance_id TEXT NOT NULL,
                trigger_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                size_bytes INTEGER NOT NULL,
                includes_saves INTEGER NOT NULL,
                file_count INTEGER NOT NULL,
                path TEXT NOT NULL,
                FOREIGN KEY (instance_id) REFERENCES instances(id) ON DELETE CASCADE
            )"#,
            [],
        )?;

        conn.execute(
            r#"INSERT INTO backups
                (id, instance_id, trigger_json, created_at, size_bytes, includes_saves, file_count, path)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"#,
            params![
                record.id,
                record.instance_id,
                serde_json::to_string(&record.trigger).unwrap_or_default(),
                record.created_at,
                record.size_bytes as i64,
                if record.includes_saves { 1 } else { 0 },
                record.file_count as i32,
                record.path,
            ],
        )?;

        Ok(())
    }

    /// Получить список бэкапов для экземпляра
    pub fn list_backups(instance_id: &str) -> Result<Vec<BackupRecord>> {
        let conn = get_db_conn()?;

        // Проверяем существует ли таблица
        let table_exists: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='backups'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .map(|count| count > 0)
            .unwrap_or(false);

        if !table_exists {
            return Ok(Vec::new());
        }

        let mut stmt = conn.prepare(
            r#"SELECT id, instance_id, trigger_json, created_at, size_bytes,
                      includes_saves, file_count, path
               FROM backups
               WHERE instance_id = ?1
               ORDER BY created_at DESC"#,
        )?;

        let records = stmt
            .query_map([instance_id], |row| {
                let trigger_json: String = row.get(2)?;
                let trigger: BackupTrigger =
                    serde_json::from_str(&trigger_json).unwrap_or(BackupTrigger::Manual);

                Ok(BackupRecord {
                    id: row.get(0)?,
                    instance_id: row.get(1)?,
                    trigger,
                    created_at: row.get(3)?,
                    size_bytes: row.get::<_, i64>(4)? as u64,
                    includes_saves: row.get::<_, i32>(5)? != 0,
                    file_count: row.get::<_, i32>(6)? as u32,
                    path: row.get(7)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        Ok(records)
    }

    /// Удалить старые бэкапы, оставив только max_count последних
    pub(crate) async fn cleanup_old_backups(instance_id: &str, max_count: usize) -> Result<()> {
        let backups = Self::list_backups(instance_id)?;

        if backups.len() <= max_count {
            return Ok(());
        }

        // Удаляем старые (backups уже отсортированы по дате DESC)
        let to_delete = &backups[max_count..];

        for backup in to_delete {
            // Удаляем файл
            let path = Path::new(&backup.path);
            if fs::try_exists(path).await.unwrap_or(false) {
                if let Err(e) = fs::remove_file(path).await {
                    log::warn!("Failed to delete backup file {}: {}", backup.path, e);
                }
            }

            // Удаляем запись из БД
            let conn = get_db_conn()?;
            if let Err(e) = conn.execute("DELETE FROM backups WHERE id = ?1", [&backup.id]) {
                log::warn!("Failed to delete backup record {}: {}", backup.id, e);
            }
        }

        log::info!(
            "Cleaned up {} old backups for instance {}",
            to_delete.len(),
            instance_id
        );

        Ok(())
    }

    /// Восстановить из бэкапа
    pub async fn restore_backup(backup_id: &str) -> Result<()> {
        let conn = get_db_conn()?;

        // Получаем информацию о бэкапе
        let (instance_id, path): (String, String) = conn.query_row(
            "SELECT instance_id, path FROM backups WHERE id = ?1",
            [backup_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;

        let backup_path = Path::new(&path);
        if !fs::try_exists(backup_path).await.unwrap_or(false) {
            return Err(LauncherError::NotFound(format!(
                "Backup file not found: {}",
                path
            )));
        }

        let instance_path = instance_dir(&instance_id);

        // Распаковываем архив
        extract_compressed_archive(backup_path, &instance_path).await?;

        log::info!("Restored backup {} for instance {}", backup_id, instance_id);

        Ok(())
    }

    /// Удалить конкретный бэкап
    pub async fn delete_backup(backup_id: &str) -> Result<()> {
        // Scope DB access before async operations (rusqlite Connection is !Send)
        let path: String = {
            let conn = get_db_conn()?;
            conn.query_row(
                "SELECT path FROM backups WHERE id = ?1",
                [backup_id],
                |row| row.get(0),
            )?
        };

        // Удаляем файл (async I/O — conn must be dropped by now)
        let backup_path = Path::new(&path);
        if fs::try_exists(backup_path).await.unwrap_or(false) {
            fs::remove_file(backup_path).await?;
        }

        // Re-acquire conn for DB delete
        {
            let conn = get_db_conn()?;
            conn.execute("DELETE FROM backups WHERE id = ?1", [backup_id])?;
        }

        Ok(())
    }
}

/// Рекурсивно собрать все файлы в директории
async fn collect_files_recursive(dir: &Path, files: &mut Vec<PathBuf>) -> Result<()> {
    let mut entries = fs::read_dir(dir).await?;

    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        let metadata = entry.metadata().await?;

        if metadata.is_file() {
            files.push(path);
        } else if metadata.is_dir() {
            // Пропускаем скрытые директории и .backup
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if !name_str.starts_with('.') {
                Box::pin(collect_files_recursive(&path, files)).await?;
            }
        }
    }

    Ok(())
}

/// Создать сжатый tar.zst архив
/// Использует spawn_blocking так как tar/zstd библиотеки требуют синхронного I/O
async fn create_compressed_archive(
    base_path: &Path,
    files: &[PathBuf],
    output_path: &Path,
) -> Result<u64> {
    let base_path = base_path.to_owned();
    let files = files.to_vec();
    let output_path = output_path.to_owned();

    tokio::task::spawn_blocking(move || {
        let output_file = std::fs::File::create(&output_path)?;
        let encoder = zstd::stream::Encoder::new(output_file, 3)?; // Уровень сжатия 3 (быстрый)
        let mut tar_builder = tar::Builder::new(encoder);

        let mut total_size = 0u64;

        for file_path in &files {
            if let Ok(relative) = file_path.strip_prefix(&base_path) {
                if let Ok(metadata) = std::fs::metadata(file_path) {
                    total_size += metadata.len();

                    let mut file = std::fs::File::open(file_path)?;
                    tar_builder.append_file(relative, &mut file)?;
                }
            }
        }

        let encoder = tar_builder.into_inner()?;
        encoder.finish()?;

        Ok(total_size)
    })
    .await
    .map_err(|e| LauncherError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?
}

/// Распаковать tar.zst архив
/// Использует spawn_blocking так как tar/zstd библиотеки требуют синхронного I/O
async fn extract_compressed_archive(archive_path: &Path, target_dir: &Path) -> Result<()> {
    let archive_path = archive_path.to_owned();
    let target_dir = target_dir.to_owned();

    tokio::task::spawn_blocking(move || {
        let archive_file = std::fs::File::open(&archive_path)?;
        let decoder = zstd::stream::Decoder::new(archive_file)?;
        let mut archive = tar::Archive::new(decoder);

        archive.unpack(&target_dir)?;

        Ok(())
    })
    .await
    .map_err(|e| LauncherError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?
}

// ============================================================================
// Internal API (for other modules)
// ============================================================================

/// Создать бэкап (внутренний API без проверки should_backup)
/// Используется модулем sync для создания бэкапа перед синхронизацией
pub async fn create_backup_internal(
    instance_id: &str,
    trigger: BackupTrigger,
    _include_saves: bool, // Пока не используется, но для совместимости API
) -> Result<BackupRecord> {
    let settings = SettingsManager::get_all()?;
    let instance_path = instance_dir(instance_id);
    let backup_dir = BackupManager::backup_dir(instance_id);

    // Создаём директорию бэкапов если не существует
    fs::create_dir_all(&backup_dir).await?;

    // Генерируем ID бэкапа
    let backup_id = format!(
        "backup_{}_{}",
        Utc::now().format("%Y%m%d_%H%M%S"),
        &instance_id[..6.min(instance_id.len())]
    );

    let backup_path = backup_dir.join(format!("{}.tar.zst", backup_id));

    // Собираем файлы для бэкапа (только конфиги, не saves)
    let mut files_to_backup: Vec<PathBuf> = Vec::new();

    let config_dir = instance_path.join("config");
    if fs::try_exists(&config_dir).await.unwrap_or(false) {
        collect_files_recursive(&config_dir, &mut files_to_backup).await?;
    }

    // Создаём tar.zst архив
    let total_size =
        create_compressed_archive(&instance_path, &files_to_backup, &backup_path).await?;

    let file_count = files_to_backup.len() as u32;
    let now = Utc::now().to_rfc3339();

    // Сохраняем запись в БД
    let record = BackupRecord {
        id: backup_id.clone(),
        instance_id: instance_id.to_string(),
        trigger,
        created_at: now.clone(),
        size_bytes: total_size,
        includes_saves: false,
        file_count,
        path: backup_path.to_string_lossy().to_string(),
    };

    BackupManager::save_backup_record(&record)?;

    // Очищаем старые бэкапы
    BackupManager::cleanup_old_backups(instance_id, settings.backup_max_count as usize).await?;

    log::info!(
        "Created internal backup {} for instance {} ({} files, {} bytes)",
        backup_id,
        instance_id,
        file_count,
        total_size
    );

    Ok(record)
}

// ============================================================================
// Tauri Commands
// ============================================================================

#[tauri::command]
pub async fn detect_backup_mod(instance_id: String) -> Result<BackupModStatus> {
    BackupManager::detect_backup_mod(&instance_id).await
}

#[tauri::command]
pub async fn should_backup(instance_id: String) -> Result<bool> {
    BackupManager::should_backup(&instance_id).await
}

#[tauri::command]
pub async fn create_backup(instance_id: String, trigger: BackupTrigger) -> Result<BackupRecord> {
    BackupManager::create_backup(&instance_id, trigger).await
}

#[tauri::command]
pub async fn list_backups(instance_id: String) -> Result<Vec<BackupRecord>> {
    BackupManager::list_backups(&instance_id)
}

#[tauri::command]
pub async fn restore_backup(backup_id: String) -> Result<()> {
    BackupManager::restore_backup(&backup_id).await
}

#[tauri::command]
pub async fn delete_backup(backup_id: String) -> Result<()> {
    BackupManager::delete_backup(&backup_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_backup_mod_detection_patterns() {
        // Проверяем что паттерны корректные
        assert!(KNOWN_BACKUP_MODS.contains(&"ftb-backups"));
        assert!(KNOWN_BACKUP_MODS.contains(&"aromabackup"));
        assert!(KNOWN_BACKUP_MODS.contains(&"simple-backups"));
    }

    #[test]
    fn test_backup_trigger_serialization() {
        let trigger = BackupTrigger::BeforeModInstall {
            mod_name: "sodium".to_string(),
        };

        let json = serde_json::to_string(&trigger).unwrap();
        assert!(json.contains("before_mod_install"));
        assert!(json.contains("sodium"));

        let parsed: BackupTrigger = serde_json::from_str(&json).unwrap();
        match parsed {
            BackupTrigger::BeforeModInstall { mod_name } => {
                assert_eq!(mod_name, "sodium");
            }
            _ => panic!("Wrong trigger type"),
        }
    }
}
