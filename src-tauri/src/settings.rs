use crate::db::get_db_conn;
use crate::error::Result;
use chrono::Utc;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use stuzhik_core::i18n::Language;

/// Поведение лаунчера при запуске игры
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum LaunchBehavior {
    /// Свернуть в трей (по умолчанию)
    #[default]
    MinimizeToTray,
    /// Оставить открытым
    KeepOpen,
    /// Закрыть лаунчер
    Close,
}

impl LaunchBehavior {
    pub fn as_str(&self) -> &'static str {
        match self {
            LaunchBehavior::MinimizeToTray => "minimize_to_tray",
            LaunchBehavior::KeepOpen => "keep_open",
            LaunchBehavior::Close => "close",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "keep_open" => LaunchBehavior::KeepOpen,
            "close" => LaunchBehavior::Close,
            _ => LaunchBehavior::MinimizeToTray,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    // Интерфейс
    pub language: Language,
    /// Режим разработчика (показывает Console, Source Code в TitleBar)
    pub developer_mode: bool,

    // Пользователь
    pub default_username: Option<String>,

    // Память
    pub default_memory_min: i32,
    pub default_memory_max: i32,

    // Java & Запуск
    pub default_java_args: Option<String>,
    pub default_game_args: Option<String>,
    pub java_auto_install: bool,
    /// Поведение при запуске игры
    pub launch_behavior: LaunchBehavior,

    // Моды
    pub auto_update_mods: bool,

    // Загрузки
    pub download_threads: i32,
    pub max_concurrent_downloads: i32,
    /// Лимит скорости загрузки (bytes/sec), 0 = без лимита
    pub bandwidth_limit: u64,

    // Авторизация
    /// Authentication type: "offline", "ely_by", "microsoft"
    pub auth_type: String,
    /// Ely.by server URL (non-sensitive)
    pub ely_by_server_url: Option<String>,
    // NOTE: ely_by_client_token is now stored in secure storage (OS keychain)
    // Use secrets::get_auth_token() / secrets::store_auth_token() instead

    // GPU
    /// Выбранный GPU (ID устройства). None = автоматический выбор
    pub selected_gpu: Option<String>,

    // Бэкапы
    /// Включены ли автоматические бэкапы (по умолчанию true)
    pub backup_enabled: bool,
    /// Максимальное количество бэкапов на экземпляр (по умолчанию 5)
    pub backup_max_count: i32,
    /// Бэкапить ли миры (saves). Автоматически false если есть backup мод
    pub backup_include_saves: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            language: Language::Russian,
            developer_mode: false, // По умолчанию выключен
            default_username: None,
            default_memory_min: 2048,
            default_memory_max: 4096,
            default_java_args: Some("-XX:+UseG1GC -XX:+UnlockExperimentalVMOptions -XX:G1NewSizePercent=20 -XX:G1ReservePercent=20 -XX:MaxGCPauseMillis=50 -XX:G1HeapRegionSize=32M".to_string()),
            default_game_args: None,
            java_auto_install: true,
            launch_behavior: LaunchBehavior::MinimizeToTray,
            auto_update_mods: false,
            download_threads: 4,
            max_concurrent_downloads: 8,
            bandwidth_limit: 0, // Без лимита
            auth_type: "offline".to_string(),
            ely_by_server_url: Some("https://authserver.ely.by".to_string()),
            // ely_by_client_token stored in OS keychain via secrets module
            selected_gpu: None, // Auto-select
            // Бэкапы - включены по умолчанию
            backup_enabled: true,
            backup_max_count: 5,
            backup_include_saves: true,
        }
    }
}

pub struct SettingsManager;

impl SettingsManager {
    /// Получить значение настройки
    fn get_setting(key: &str) -> Result<Option<String>> {
        let conn = get_db_conn()?;
        let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;

        match stmt.query_row([key], |row| row.get::<_, String>(0)) {
            Ok(value) => Ok(Some(value)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Установить значение настройки
    fn set_setting(key: &str, value: &str) -> Result<()> {
        let conn = get_db_conn()?;
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
            params![key, value, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    /// Получить все настройки
    pub fn get_all() -> Result<Settings> {
        let default = Settings::default();

        Ok(Settings {
            language: Self::get_setting("language")?
                .and_then(|s| Language::parse(&s))
                .unwrap_or(default.language),

            developer_mode: Self::get_setting("developer_mode")?
                .and_then(|s| s.parse().ok())
                .unwrap_or(default.developer_mode),

            default_username: Self::get_setting("default_username")?.or(default.default_username),

            default_memory_min: Self::get_setting("default_memory_min")?
                .and_then(|s| s.parse().ok())
                .unwrap_or(default.default_memory_min),

            default_memory_max: Self::get_setting("default_memory_max")?
                .and_then(|s| s.parse().ok())
                .unwrap_or(default.default_memory_max),

            default_java_args: Self::get_setting("default_java_args")?
                .or(default.default_java_args),
            default_game_args: Self::get_setting("default_game_args")?
                .or(default.default_game_args),

            java_auto_install: Self::get_setting("java_auto_install")?
                .and_then(|s| s.parse().ok())
                .unwrap_or(default.java_auto_install),

            launch_behavior: Self::get_setting("launch_behavior")?
                .map(|s| LaunchBehavior::from_str(&s))
                .unwrap_or(default.launch_behavior),

            auto_update_mods: Self::get_setting("auto_update_mods")?
                .and_then(|s| s.parse().ok())
                .unwrap_or(default.auto_update_mods),

            download_threads: Self::get_setting("download_threads")?
                .and_then(|s| s.parse().ok())
                .unwrap_or(default.download_threads),

            max_concurrent_downloads: Self::get_setting("max_concurrent_downloads")?
                .and_then(|s| s.parse().ok())
                .unwrap_or(default.max_concurrent_downloads),

            bandwidth_limit: Self::get_setting("bandwidth_limit")?
                .and_then(|s| s.parse().ok())
                .unwrap_or(default.bandwidth_limit),

            auth_type: Self::get_setting("auth_type")?.unwrap_or(default.auth_type),
            ely_by_server_url: Self::get_setting("ely_by_server_url")?
                .or(default.ely_by_server_url),
            // ely_by_client_token is now in secure storage (OS keychain)
            selected_gpu: Self::get_setting("selected_gpu")?,

            // Бэкапы
            backup_enabled: Self::get_setting("backup_enabled")?
                .and_then(|s| s.parse().ok())
                .unwrap_or(default.backup_enabled),
            backup_max_count: Self::get_setting("backup_max_count")?
                .and_then(|s| s.parse().ok())
                .unwrap_or(default.backup_max_count),
            backup_include_saves: Self::get_setting("backup_include_saves")?
                .and_then(|s| s.parse().ok())
                .unwrap_or(default.backup_include_saves),
        })
    }

    /// Сохранить все настройки
    pub fn save_all(settings: Settings) -> Result<()> {
        Self::set_setting("language", settings.language.code())?;
        Self::set_setting("developer_mode", &settings.developer_mode.to_string())?;

        if let Some(username) = settings.default_username {
            Self::set_setting("default_username", &username)?;
        }

        Self::set_setting(
            "default_memory_min",
            &settings.default_memory_min.to_string(),
        )?;
        Self::set_setting(
            "default_memory_max",
            &settings.default_memory_max.to_string(),
        )?;

        if let Some(java_args) = settings.default_java_args {
            Self::set_setting("default_java_args", &java_args)?;
        }

        if let Some(game_args) = settings.default_game_args {
            Self::set_setting("default_game_args", &game_args)?;
        }

        Self::set_setting("java_auto_install", &settings.java_auto_install.to_string())?;
        Self::set_setting("auto_update_mods", &settings.auto_update_mods.to_string())?;
        Self::set_setting("download_threads", &settings.download_threads.to_string())?;
        Self::set_setting(
            "max_concurrent_downloads",
            &settings.max_concurrent_downloads.to_string(),
        )?;
        Self::set_setting("bandwidth_limit", &settings.bandwidth_limit.to_string())?;
        Self::set_setting("auth_type", &settings.auth_type)?;
        Self::set_setting("launch_behavior", settings.launch_behavior.as_str())?;

        if let Some(url) = settings.ely_by_server_url {
            Self::set_setting("ely_by_server_url", &url)?;
        }
        // NOTE: ely_by_client_token is stored in secure storage (OS keychain)
        // Use secrets::store_auth_token() instead

        if let Some(gpu) = settings.selected_gpu {
            Self::set_setting("selected_gpu", &gpu)?;
        } else {
            // Clear GPU selection if None (auto mode)
            let conn = get_db_conn()?;
            conn.execute("DELETE FROM settings WHERE key = 'selected_gpu'", [])?;
        }

        // Бэкапы
        Self::set_setting("backup_enabled", &settings.backup_enabled.to_string())?;
        Self::set_setting("backup_max_count", &settings.backup_max_count.to_string())?;
        Self::set_setting(
            "backup_include_saves",
            &settings.backup_include_saves.to_string(),
        )?;

        Ok(())
    }

    // Convenience методы для частых настроек

    pub fn get_default_username() -> Result<Option<String>> {
        Self::get_setting("default_username")
    }

    pub fn get_default_memory_min() -> Result<i32> {
        Ok(Self::get_setting("default_memory_min")?
            .and_then(|s| s.parse().ok())
            .unwrap_or(512))
    }

    pub fn get_default_memory_max() -> Result<i32> {
        Ok(Self::get_setting("default_memory_max")?
            .and_then(|s| s.parse().ok())
            .unwrap_or(2048))
    }

    pub fn get_default_java_args() -> Result<Option<String>> {
        Self::get_setting("default_java_args")
    }

    pub fn get_default_game_args() -> Result<Option<String>> {
        Self::get_setting("default_game_args")
    }

    pub fn get_auth_type() -> Result<String> {
        Ok(Self::get_setting("auth_type")?.unwrap_or_else(|| "offline".to_string()))
    }

    /// Get Ely.by server URL (token is stored in secure storage)
    pub fn get_ely_by_server_url() -> Result<String> {
        Ok(Self::get_setting("ely_by_server_url")?
            .unwrap_or_else(|| "https://authserver.ely.by".to_string()))
    }

    /// Получить выбранный GPU (None = автоматический выбор)
    pub fn get_selected_gpu() -> Result<Option<String>> {
        Self::get_setting("selected_gpu")
    }
}

// Tauri commands

#[tauri::command]
pub async fn get_settings() -> Result<Settings> {
    SettingsManager::get_all()
}

#[tauri::command]
pub async fn save_settings(settings: Settings) -> Result<()> {
    SettingsManager::save_all(settings)
}

#[tauri::command]
pub async fn reset_settings() -> Result<Settings> {
    let default = Settings::default();
    SettingsManager::save_all(default.clone())?;
    Ok(default)
}
