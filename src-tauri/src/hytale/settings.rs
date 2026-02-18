//! Hytale game settings and localization management

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tokio::fs;

use super::installation::detect_hytale;

/// Hytale settings stored in our launcher
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HytaleSettings {
    /// Enable verbose logging
    pub verbose_logging: bool,
    /// Custom game arguments
    pub game_args: Option<String>,
    /// Skip intro videos
    pub skip_intro: bool,
    /// Windowed mode
    pub windowed: bool,
    /// Custom resolution width
    pub resolution_width: Option<u32>,
    /// Custom resolution height
    pub resolution_height: Option<u32>,
    /// Language override (e.g., "ru", "en")
    pub language: Option<String>,
    /// Auto-connect to server on launch
    pub auto_connect_server: Option<String>,
}

impl HytaleSettings {
    /// Convert settings to command line arguments
    pub fn to_args(&self) -> Vec<String> {
        let mut args = Vec::new();

        if self.verbose_logging {
            args.push("--verbose".to_string());
            args.push("--log-level=debug".to_string());
        }

        if self.skip_intro {
            args.push("--skip-intro".to_string());
        }

        if self.windowed {
            args.push("--windowed".to_string());
        }

        if let (Some(w), Some(h)) = (self.resolution_width, self.resolution_height) {
            args.push(format!("--width={}", w));
            args.push(format!("--height={}", h));
        }

        if let Some(ref lang) = self.language {
            args.push(format!("--language={}", lang));
        }

        if let Some(ref server) = self.auto_connect_server {
            args.push("--connect".to_string());
            args.push(server.clone());
        }

        if let Some(ref custom_args) = self.game_args {
            for arg in custom_args.split_whitespace() {
                args.push(arg.to_string());
            }
        }

        args
    }
}

/// Available language pack
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LanguagePack {
    /// Language code (e.g., "ru", "uk", "de")
    pub code: String,
    /// Display name (e.g., "Русский", "Українська")
    pub name: String,
    /// Download URL
    pub url: Option<String>,
    /// Is installed
    pub installed: bool,
    /// Version/date of the translation
    pub version: Option<String>,
}

/// Get available language packs
pub async fn get_available_languages() -> Vec<LanguagePack> {
    let mut languages = vec![
        LanguagePack {
            code: "en".to_string(),
            name: "English".to_string(),
            url: None,
            installed: true, // Default language, always installed
            version: None,
        },
    ];

    // Check if Russian language pack is installed
    if let Some(installation) = detect_hytale().await {
        let ru_pack_path = PathBuf::from(&installation.path)
            .join("localization")
            .join("ru.json");

        let ru_installed = fs::try_exists(&ru_pack_path).await.unwrap_or(false);

        languages.push(LanguagePack {
            code: "ru".to_string(),
            name: "Русский".to_string(),
            url: None, // Will be set when we find a legitimate source
            installed: ru_installed,
            version: if ru_installed {
                Some("Community".to_string())
            } else {
                None
            },
        });
    }

    languages
}

/// Install a language pack from a local file
pub async fn install_language_pack(file_path: &str, lang_code: &str) -> Result<(), String> {
    let installation = detect_hytale()
        .await
        .ok_or_else(|| "Hytale is not installed".to_string())?;

    let source = PathBuf::from(file_path);
    if !fs::try_exists(&source).await.unwrap_or(false) {
        return Err("Language pack file not found".to_string());
    }

    // Validate it's a JSON file
    if source.extension().and_then(|e| e.to_str()) != Some("json") {
        return Err("Language pack must be a JSON file".to_string());
    }

    // Create localization directory if it doesn't exist
    let loc_dir = PathBuf::from(&installation.path).join("localization");
    fs::create_dir_all(&loc_dir)
        .await
        .map_err(|e| format!("Failed to create localization directory: {}", e))?;

    // Copy language file
    let dest = loc_dir.join(format!("{}.json", lang_code));
    fs::copy(&source, &dest)
        .await
        .map_err(|e| format!("Failed to copy language pack: {}", e))?;

    log::info!("Installed language pack: {} -> {:?}", lang_code, dest);
    Ok(())
}

/// Get the path to Hytale's log files
pub fn get_hytale_log_path() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("LOCALAPPDATA")
            .map(|p| PathBuf::from(p).join("Hytale").join("logs"))
    }

    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME")
            .map(|p| PathBuf::from(p).join("Library/Logs/Hytale"))
    }

    #[cfg(target_os = "linux")]
    {
        std::env::var_os("HOME")
            .map(|p| PathBuf::from(p).join(".local/share/Hytale/logs"))
    }
}

/// Open Hytale log folder using tauri-plugin-opener (cross-platform, no console window)
pub async fn open_log_folder(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    let log_path = get_hytale_log_path()
        .ok_or_else(|| "Could not determine log path".to_string())?;

    if !fs::try_exists(&log_path).await.unwrap_or(false) {
        fs::create_dir_all(&log_path)
            .await
            .map_err(|e| format!("Failed to create log directory: {}", e))?;
    }

    app.opener()
        .open_path(log_path.to_string_lossy(), None::<&str>)
        .map_err(|e| format!("Failed to open folder: {}", e))?;

    Ok(())
}

// Tauri commands

/// Get Hytale settings
#[tauri::command]
pub async fn get_hytale_settings() -> HytaleSettings {
    // TODO: Load from database/config file
    HytaleSettings::default()
}

/// Save Hytale settings
#[tauri::command]
pub async fn save_hytale_settings(settings: HytaleSettings) -> Result<(), String> {
    // TODO: Save to database/config file
    log::info!("Saving Hytale settings: {:?}", settings);
    Ok(())
}

/// Get available language packs
#[tauri::command]
pub async fn get_hytale_languages() -> Vec<LanguagePack> {
    get_available_languages().await
}

/// Install language pack from file
#[tauri::command]
pub async fn install_hytale_language(file_path: String, lang_code: String) -> Result<(), String> {
    install_language_pack(&file_path, &lang_code).await
}

/// Open Hytale logs folder
#[tauri::command]
pub async fn open_hytale_logs(app: tauri::AppHandle) -> Result<(), String> {
    open_log_folder(&app).await
}
