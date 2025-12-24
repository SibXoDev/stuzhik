//! Smart Settings Sync Module
//!
//! Интеллектуальная синхронизация настроек между экземплярами.
//! Разделяет настройки на категории:
//! - Personal: FOV, звук, управление - НИКОГДА не синхронизируются
//! - Performance: графика, FPS - зависят от железа
//! - ModConfig: конфиги модов - синхронизируются по умолчанию
//! - Gameplay: waypoints, bookmarks - опционально
//! - Visual: ресурспаки, шейдеры - опционально

mod classifier;
mod executor;
mod types;

pub use classifier::SettingsKnowledgeBase;
pub use executor::{CategoryStats, SyncExecutor};
pub use types::*;

use crate::error::Result;
use std::collections::HashMap;

// ============================================================================
// Tauri Commands
// ============================================================================

/// Получить список всех встроенных профилей синхронизации
#[tauri::command]
pub fn list_sync_profiles() -> Vec<SyncProfile> {
    SyncProfile::builtin_profiles()
}

/// Получить профиль по ID
#[tauri::command]
pub fn get_sync_profile(profile_id: String) -> Result<SyncProfile> {
    for profile in SyncProfile::builtin_profiles() {
        if profile.id == profile_id {
            return Ok(profile);
        }
    }
    Err(crate::error::LauncherError::NotFound(format!(
        "Sync profile '{}' not found",
        profile_id
    )))
}

/// Сканировать экземпляр и классифицировать все файлы настроек
#[tauri::command]
pub async fn scan_instance_settings(instance_id: String) -> Result<Vec<ClassifiedFile>> {
    let executor = SyncExecutor::new();
    executor.scan_instance(&instance_id).await
}

/// Получить статистику по категориям настроек
#[tauri::command]
pub async fn get_settings_category_stats(
    instance_id: String,
) -> Result<HashMap<String, CategoryStats>> {
    let executor = SyncExecutor::new();
    let stats = executor.get_category_stats(&instance_id).await?;

    // Конвертируем ключи в строки для JSON сериализации
    Ok(stats
        .into_iter()
        .map(|(k, v)| (format!("{:?}", k), v))
        .collect())
}

/// Preview синхронизации - показать что будет синхронизировано
#[tauri::command]
pub async fn preview_sync(
    source_instance_id: String,
    target_instance_id: String,
    profile_id: String,
    extra_excluded: Vec<String>,
    extra_included: Vec<String>,
) -> Result<SyncPreview> {
    let executor = SyncExecutor::new();
    let request = SyncRequest {
        source_instance_id,
        target_instance_id,
        profile_id,
        extra_excluded,
        extra_included,
        mode: SyncMode::Preview,
    };
    executor.preview_sync(&request).await
}

/// Выполнить синхронизацию настроек
#[tauri::command]
pub async fn execute_sync(
    source_instance_id: String,
    target_instance_id: String,
    profile_id: String,
    extra_excluded: Vec<String>,
    extra_included: Vec<String>,
) -> Result<SyncResult> {
    let executor = SyncExecutor::new();
    let request = SyncRequest {
        source_instance_id,
        target_instance_id,
        profile_id,
        extra_excluded,
        extra_included,
        mode: SyncMode::Apply,
    };

    log::info!(
        "Starting sync from {} to {} with profile {}",
        request.source_instance_id,
        request.target_instance_id,
        request.profile_id
    );

    let result = executor.execute_sync(&request).await?;

    log::info!(
        "Sync completed: {} files synced, {} skipped, {} errors",
        result.synced_files.len(),
        result.skipped_files.len(),
        result.errors.len()
    );

    Ok(result)
}

/// Получить список известных настроек (для UI)
#[tauri::command]
pub fn get_known_settings() -> Vec<KnownSetting> {
    let kb = SettingsKnowledgeBase::new();
    kb.get_all_known_settings().to_vec()
}

/// Классифицировать один файл
#[tauri::command]
pub fn classify_setting_file(relative_path: String, file_size: u64) -> ClassifiedFile {
    let kb = SettingsKnowledgeBase::new();
    kb.classify_file(&relative_path, file_size)
}

/// Получить описание категории
#[tauri::command]
pub fn get_category_description(category: SettingCategory) -> String {
    category.description().to_string()
}

/// Быстрая синхронизация с профилем по умолчанию (gameplay_only)
#[tauri::command]
pub async fn quick_sync(
    source_instance_id: String,
    target_instance_id: String,
) -> Result<SyncResult> {
    execute_sync(
        source_instance_id,
        target_instance_id,
        "gameplay_only".to_string(),
        vec![],
        vec![],
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_builtin_profiles() {
        let profiles = SyncProfile::builtin_profiles();
        assert_eq!(profiles.len(), 3);
        assert!(profiles.iter().any(|p| p.id == "gameplay_only"));
        assert!(profiles.iter().any(|p| p.id == "full_sync"));
        assert!(profiles.iter().any(|p| p.id == "minimal"));
    }

    #[test]
    fn test_category_sync_by_default() {
        assert!(!SettingCategory::Personal.sync_by_default());
        assert!(!SettingCategory::Performance.sync_by_default());
        assert!(SettingCategory::ModConfig.sync_by_default());
        assert!(!SettingCategory::Gameplay.sync_by_default());
    }

    #[test]
    fn test_category_can_sync() {
        assert!(!SettingCategory::Personal.can_sync());
        assert!(SettingCategory::Performance.can_sync());
        assert!(SettingCategory::ModConfig.can_sync());
        assert!(SettingCategory::Gameplay.can_sync());
    }
}
