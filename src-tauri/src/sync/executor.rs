use super::classifier::{merge_options_txt, SettingsKnowledgeBase};
use super::types::{
    ClassifiedFile, SettingCategory, SkipReason, SkippedFile, SyncError, SyncPreview, SyncProfile,
    SyncRequest, SyncResult,
};
use crate::backup;
use crate::error::Result;
use crate::instances::get_instance;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::fs;
use walkdir::WalkDir;

/// Исполнитель синхронизации
pub struct SyncExecutor {
    kb: SettingsKnowledgeBase,
}

impl Default for SyncExecutor {
    fn default() -> Self {
        Self::new()
    }
}

impl SyncExecutor {
    pub fn new() -> Self {
        Self {
            kb: SettingsKnowledgeBase::new(),
        }
    }

    /// Сканирует экземпляр и классифицирует все файлы настроек
    pub async fn scan_instance(&self, instance_id: &str) -> Result<Vec<ClassifiedFile>> {
        let instance = get_instance(instance_id.to_string()).await?;
        let instance_dir = PathBuf::from(&instance.dir);

        let mut files = Vec::new();

        // Сканируем директории с настройками
        let dirs_to_scan = [
            "", // Корень (options.txt и т.д.)
            "config",
            "kubejs",
            "journeymap",
            "XaeroWaypoints",
            "XaeroWorldMap",
            "defaultconfigs",
            "shaderpacks",
        ];

        for dir in dirs_to_scan {
            let scan_dir = if dir.is_empty() {
                instance_dir.clone()
            } else {
                instance_dir.join(dir)
            };

            if !scan_dir.exists() {
                continue;
            }

            for entry in WalkDir::new(&scan_dir)
                .max_depth(if dir.is_empty() { 1 } else { 10 })
                .into_iter()
                .filter_map(|e| e.ok())
            {
                let path = entry.path();

                // Пропускаем директории
                if path.is_dir() {
                    continue;
                }

                // Пропускаем не-настройки в корне
                if dir.is_empty() {
                    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    if !Self::is_root_settings_file(file_name) {
                        continue;
                    }
                }

                // Получаем относительный путь
                let relative = path
                    .strip_prefix(&instance_dir)
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default();

                // Получаем размер файла
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);

                // Классифицируем
                let classified = self.kb.classify_file(&relative, size);
                files.push(classified);
            }
        }

        // Сортируем по категориям и путям
        files.sort_by(|a, b| {
            let cat_order = |c: &SettingCategory| match c {
                SettingCategory::Personal => 0,
                SettingCategory::Performance => 1,
                SettingCategory::ModConfig => 2,
                SettingCategory::Gameplay => 3,
                SettingCategory::Visual => 4,
                SettingCategory::Unknown => 5,
            };
            cat_order(&a.category)
                .cmp(&cat_order(&b.category))
                .then(a.path.cmp(&b.path))
        });

        Ok(files)
    }

    /// Создаёт preview синхронизации
    pub async fn preview_sync(&self, request: &SyncRequest) -> Result<SyncPreview> {
        let profile = self.get_profile(&request.profile_id)?;

        // Сканируем исходный экземпляр
        let source_files = self.scan_instance(&request.source_instance_id).await?;

        let mut files_to_sync = Vec::new();
        let mut files_to_skip = Vec::new();
        let mut by_category: HashMap<String, usize> = HashMap::new();
        let mut total_size = 0u64;

        for mut file in source_files {
            // Обновляем will_sync на основе профиля и extra rules
            let sync_result = self.should_sync_with_extras(&file, &profile, request);

            match sync_result {
                Ok(()) => {
                    file.will_sync = true;
                    total_size += file.size;
                    *by_category
                        .entry(format!("{:?}", file.category))
                        .or_insert(0) += 1;
                    files_to_sync.push(file);
                }
                Err(reason) => {
                    file.will_sync = false;
                    files_to_skip.push(SkippedFile {
                        path: file.path.clone(),
                        reason,
                    });
                }
            }
        }

        Ok(SyncPreview {
            files_to_sync,
            files_to_skip,
            total_size,
            by_category,
        })
    }

    /// Выполняет синхронизацию
    pub async fn execute_sync(&self, request: &SyncRequest) -> Result<SyncResult> {
        let source_instance = get_instance(request.source_instance_id.clone()).await?;
        let target_instance = get_instance(request.target_instance_id.clone()).await?;
        let source_dir = PathBuf::from(&source_instance.dir);
        let target_dir = PathBuf::from(&target_instance.dir);

        // Получаем preview
        let preview = self.preview_sync(request).await?;

        // Создаём бэкап целевого экземпляра
        let backup_result = backup::create_backup_internal(
            &request.target_instance_id,
            backup::BackupTrigger::Manual,
            false, // Не включаем saves
        )
        .await;

        let (backup_created, backup_path) = match backup_result {
            Ok(record) => (true, Some(record.path)),
            Err(e) => {
                log::warn!("Failed to create backup before sync: {}", e);
                (false, None)
            }
        };

        let mut synced_files = Vec::new();
        let mut errors = Vec::new();

        // Копируем файлы
        for file in &preview.files_to_sync {
            let source_path = source_dir.join(&file.path);
            let target_path = target_dir.join(&file.path);

            // Специальная обработка options.txt - мержим вместо замены
            if file.path == "options.txt" {
                match self.sync_options_txt(&source_path, &target_path).await {
                    Ok(()) => synced_files.push(file.path.clone()),
                    Err(e) => errors.push(SyncError {
                        path: file.path.clone(),
                        error: e.to_string(),
                    }),
                }
                continue;
            }

            // Обычное копирование
            match self.copy_file(&source_path, &target_path).await {
                Ok(()) => synced_files.push(file.path.clone()),
                Err(e) => errors.push(SyncError {
                    path: file.path.clone(),
                    error: e.to_string(),
                }),
            }
        }

        Ok(SyncResult {
            synced_files,
            skipped_files: preview.files_to_skip,
            errors,
            backup_created,
            backup_path,
            total_size: preview.total_size,
        })
    }

    /// Получает профиль по ID
    fn get_profile(&self, profile_id: &str) -> Result<SyncProfile> {
        // Поиск среди встроенных профилей (пользовательские профили пока не поддерживаются)
        for profile in SyncProfile::builtin_profiles() {
            if profile.id == profile_id {
                return Ok(profile);
            }
        }

        Err(crate::error::LauncherError::InvalidConfig(format!(
            "Sync profile '{}' not found",
            profile_id
        )))
    }

    /// Проверяет, должен ли файл синхронизироваться с учётом extra rules
    fn should_sync_with_extras(
        &self,
        file: &ClassifiedFile,
        profile: &SyncProfile,
        request: &SyncRequest,
    ) -> std::result::Result<(), SkipReason> {
        // Проверяем extra_excluded
        for pattern in &request.extra_excluded {
            if let Ok(glob) = glob::Pattern::new(&pattern.to_lowercase()) {
                if glob.matches(&file.path.to_lowercase()) {
                    return Err(SkipReason::ExplicitlyExcluded);
                }
            }
        }

        // Проверяем extra_included (override)
        for pattern in &request.extra_included {
            if let Ok(glob) = glob::Pattern::new(&pattern.to_lowercase()) {
                if glob.matches(&file.path.to_lowercase()) {
                    // Но Personal всё равно не синхронизируем!
                    if file.category == SettingCategory::Personal {
                        return Err(SkipReason::PersonalSetting);
                    }
                    return Ok(());
                }
            }
        }

        // Стандартная проверка через knowledge base
        self.kb.should_sync(file, profile)
    }

    /// Проверяет, является ли файл в корне файлом настроек
    fn is_root_settings_file(filename: &str) -> bool {
        matches!(
            filename,
            "options.txt"
                | "optionsof.txt"
                | "optionsshaders.txt"
                | "servers.dat"
                | "hotbar.nbt"
                | "realms_persistence.json"
                | "usercache.json"
        )
    }

    /// Синхронизирует options.txt с умным мержем
    async fn sync_options_txt(&self, source: &Path, target: &Path) -> Result<()> {
        let source_content = fs::read_to_string(source).await?;

        let target_content = if target.exists() {
            fs::read_to_string(target).await?
        } else {
            String::new()
        };

        let merged = merge_options_txt(&source_content, &target_content, &self.kb);

        // Создаём директорию если нужно
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).await?;
        }

        fs::write(target, merged).await?;
        Ok(())
    }

    /// Копирует файл с созданием директорий
    async fn copy_file(&self, source: &Path, target: &Path) -> Result<()> {
        if !source.exists() {
            return Err(crate::error::LauncherError::NotFound(format!(
                "Source file not found: {}",
                source.display()
            )));
        }

        // Создаём директорию если нужно
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).await?;
        }

        fs::copy(source, target).await?;
        Ok(())
    }

    /// Получает статистику по категориям для экземпляра
    pub async fn get_category_stats(
        &self,
        instance_id: &str,
    ) -> Result<HashMap<SettingCategory, CategoryStats>> {
        let files = self.scan_instance(instance_id).await?;

        let mut stats: HashMap<SettingCategory, CategoryStats> = HashMap::new();

        for file in files {
            let entry = stats.entry(file.category).or_insert(CategoryStats {
                count: 0,
                total_size: 0,
            });
            entry.count += 1;
            entry.total_size += file.size;
        }

        Ok(stats)
    }
}

/// Статистика по категории
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CategoryStats {
    pub count: usize,
    pub total_size: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_root_settings_file() {
        assert!(SyncExecutor::is_root_settings_file("options.txt"));
        assert!(SyncExecutor::is_root_settings_file("optionsof.txt"));
        assert!(!SyncExecutor::is_root_settings_file("mods"));
        assert!(!SyncExecutor::is_root_settings_file("random.txt"));
    }
}
