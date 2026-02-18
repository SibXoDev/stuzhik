//! Расширенная интеграция со Spark Profiler
//!
//! Возможности:
//! - Отправка команд в Minecraft через stdin
//! - Авто-установка Spark через Modrinth
//! - Открытие Web Viewer с предупреждением о приватности
//! - Парсинг URL отчётов из логов

use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::process::ChildStdin;
use std::sync::{Arc, LazyLock, Mutex};

use crate::downloader::DownloadManager;
use crate::error::{LauncherError, Result};
use crate::mods::ModManager;
use crate::paths;

/// Карта stdin handles для запущенных экземпляров
pub type StdinMap = Arc<Mutex<HashMap<String, ChildStdin>>>;

/// Spark команды
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SparkCommand {
    /// Начать профилирование
    ProfilerStart,
    /// Остановить профилирование
    ProfilerStop,
    /// Показать TPS
    Tps,
    /// Показать здоровье сервера
    Health,
    /// Показать использование памяти
    Gc,
    /// Показать информацию о тиках
    Tickmonitor,
}

impl SparkCommand {
    /// Получить строку команды для отправки в Minecraft (сервер)
    pub fn to_command_string(&self) -> &'static str {
        match self {
            SparkCommand::ProfilerStart => "/spark profiler start",
            SparkCommand::ProfilerStop => "/spark profiler stop",
            SparkCommand::Tps => "/spark tps",
            SparkCommand::Health => "/spark health",
            SparkCommand::Gc => "/spark gc",
            SparkCommand::Tickmonitor => "/spark tickmonitor",
        }
    }

    /// Получить строку команды для клиента (/sparkc или /sparkclient)
    pub fn to_client_command_string(&self) -> &'static str {
        match self {
            SparkCommand::ProfilerStart => "/sparkc profiler start",
            SparkCommand::ProfilerStop => "/sparkc profiler stop",
            SparkCommand::Tps => "/sparkc tps",
            SparkCommand::Health => "/sparkc health",
            SparkCommand::Gc => "/sparkc gc",
            SparkCommand::Tickmonitor => "/sparkc tickmonitor",
        }
    }

    /// Получить команду в зависимости от типа экземпляра (клиент/сервер)
    pub fn to_command_for_instance(&self, is_server: bool) -> &'static str {
        if is_server {
            self.to_command_string()
        } else {
            self.to_client_command_string()
        }
    }
}

/// Результат отправки команды
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CommandResult {
    pub success: bool,
    pub command: String,
    pub message: Option<String>,
}

/// Информация о Spark Web Viewer
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SparkViewerInfo {
    pub url: String,
    pub timestamp: String,
    pub report_type: String,
}

/// Предупреждение о приватности для Web Viewer
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PrivacyWarning {
    pub title: String,
    pub message: String,
    pub data_uploaded: Vec<String>,
    pub data_not_uploaded: Vec<String>,
    pub retention_days: u32,
}

impl Default for PrivacyWarning {
    fn default() -> Self {
        Self {
            title: "Предупреждение о приватности".to_string(),
            message: "Отчёт будет загружен на spark.lucko.me для просмотра.".to_string(),
            data_uploaded: vec![
                "Время тиков и стектрейсы".to_string(),
                "Названия модов и плагинов".to_string(),
                "Данные профилирования CPU/памяти".to_string(),
            ],
            data_not_uploaded: vec![
                "Данные игроков и координаты".to_string(),
                "Содержимое мира и конфиги".to_string(),
                "Персональная информация".to_string(),
            ],
            retention_days: 30,
        }
    }
}

/// Отправить команду в Minecraft через stdin
pub fn send_command(
    stdin_map: &StdinMap,
    instance_id: &str,
    command: &str,
) -> Result<CommandResult> {
    let mut map = stdin_map
        .lock()
        .map_err(|e| LauncherError::InvalidConfig(format!("Failed to lock stdin map: {}", e)))?;

    if let Some(stdin) = map.get_mut(instance_id) {
        // Добавляем перевод строки в конец команды
        let cmd_with_newline = format!("{}\n", command);

        stdin.write_all(cmd_with_newline.as_bytes()).map_err(|e| {
            LauncherError::Io(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                format!("Failed to write to stdin: {}", e),
            ))
        })?;

        stdin.flush().map_err(|e| {
            LauncherError::Io(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                format!("Failed to flush stdin: {}", e),
            ))
        })?;

        Ok(CommandResult {
            success: true,
            command: command.to_string(),
            message: Some("Command sent successfully".to_string()),
        })
    } else {
        Err(LauncherError::InstanceNotRunning)
    }
}

/// Отправить Spark команду
pub fn send_spark_command(
    stdin_map: &StdinMap,
    instance_id: &str,
    spark_cmd: SparkCommand,
) -> Result<CommandResult> {
    let command_str = spark_cmd.to_command_string();
    send_command(stdin_map, instance_id, command_str)
}

/// Парсить URL Spark Web Viewer из логов
pub fn parse_spark_viewer_urls(instance_id: &str) -> Vec<SparkViewerInfo> {
    let instance_path = paths::instance_dir(instance_id);
    let log_path = instance_path.join("logs").join("latest.log");

    if !log_path.exists() {
        return Vec::new();
    }

    let content = match std::fs::read_to_string(&log_path) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };

    let mut results = Vec::new();

    // Статические regex — компилируются один раз
    static SPARK_URL_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"https://spark\.lucko\.me/([a-zA-Z0-9]+)").expect("valid spark URL regex")
    });
    static LOG_TIME_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"\[(\d{2}:\d{2}:\d{2})\]").expect("valid log timestamp regex")
    });
    let url_regex = &*SPARK_URL_RE;
    let time_regex = &*LOG_TIME_RE;

    for line in content.lines() {
        if let Some(url_match) = url_regex.find(line) {
            let url = url_match.as_str().to_string();

            // Пытаемся извлечь время из строки
            let timestamp = time_regex
                .captures(line)
                .and_then(|c| c.get(1))
                .map(|m| m.as_str().to_string())
                .unwrap_or_else(|| "unknown".to_string());

            // Определяем тип отчёта
            let report_type = if line.contains("profiler") || line.contains("Profiler") {
                "profiler"
            } else if line.contains("health") || line.contains("Health") {
                "health"
            } else if line.contains("heap") || line.contains("Heap") {
                "heap"
            } else {
                "unknown"
            };

            results.push(SparkViewerInfo {
                url,
                timestamp,
                report_type: report_type.to_string(),
            });
        }
    }

    results
}

/// Получить slug Spark мода для текущего загрузчика
pub fn get_spark_slug(loader: &str) -> &'static str {
    match loader.to_lowercase().as_str() {
        "fabric" => "spark",
        "quilt" => "spark",
        "forge" => "spark",
        "neoforge" => "spark",
        _ => "spark",
    }
}

/// Проверить, установлен ли Spark
pub fn is_spark_installed(instance_path: &Path) -> bool {
    let mods_dir = instance_path.join("mods");
    if !mods_dir.exists() {
        return false;
    }

    if let Ok(entries) = std::fs::read_dir(&mods_dir) {
        for entry in entries.flatten() {
            let file_name = entry.file_name().to_string_lossy().to_lowercase();
            if file_name.contains("spark") && file_name.ends_with(".jar") {
                return true;
            }
        }
    }

    false
}

/// Получить предупреждение о приватности
pub fn get_privacy_warning() -> PrivacyWarning {
    PrivacyWarning::default()
}

// ============================================================================
// Tauri Commands
// ============================================================================

/// Отправить команду в Minecraft
#[tauri::command]
pub async fn send_minecraft_command(
    instance_id: String,
    command: String,
    stdin_state: tauri::State<'_, StdinMap>,
) -> Result<CommandResult> {
    send_command(&stdin_state, &instance_id, &command)
}

/// Отправить Spark команду
#[tauri::command]
pub async fn send_spark_command_tauri(
    instance_id: String,
    command: SparkCommand,
    stdin_state: tauri::State<'_, StdinMap>,
) -> Result<CommandResult> {
    send_spark_command(&stdin_state, &instance_id, command)
}

/// Отправить Spark команду с авто-определением клиент/сервер
#[tauri::command]
pub async fn send_spark_command_auto(
    instance_id: String,
    command: SparkCommand,
    stdin_state: tauri::State<'_, StdinMap>,
) -> Result<CommandResult> {
    // Определяем тип экземпляра
    let instance = crate::instances::get_instance(instance_id.clone()).await?;
    let is_server = matches!(
        instance.instance_type,
        stuzhik_core::types::InstanceType::Server
    );

    // Получаем правильную команду
    let cmd_str = command.to_command_for_instance(is_server);

    log::info!(
        "Sending Spark command to {} ({}): {}",
        instance_id,
        if is_server { "server" } else { "client" },
        cmd_str
    );

    send_command(&stdin_state, &instance_id, cmd_str)
}

/// Автоматически запустить Spark tickmonitor для мониторинга производительности
#[tauri::command]
pub async fn start_spark_tickmonitor(
    instance_id: String,
    stdin_state: tauri::State<'_, StdinMap>,
) -> Result<CommandResult> {
    // Проверяем, установлен ли Spark
    if !check_spark_installed(instance_id.clone()) {
        return Err(LauncherError::InvalidConfig(
            "Spark не установлен в этом экземпляре".to_string(),
        ));
    }

    // Определяем тип экземпляра
    let instance = crate::instances::get_instance(instance_id.clone()).await?;
    let is_server = matches!(
        instance.instance_type,
        stuzhik_core::types::InstanceType::Server
    );

    // Получаем правильную команду
    let cmd_str = SparkCommand::Tickmonitor.to_command_for_instance(is_server);

    log::info!(
        "Starting Spark tickmonitor for {} ({}): {}",
        instance_id,
        if is_server { "server" } else { "client" },
        cmd_str
    );

    send_command(&stdin_state, &instance_id, cmd_str)
}

/// Получить URL Spark Web Viewer из логов
#[tauri::command]
pub fn get_spark_viewer_urls(instance_id: String) -> Vec<SparkViewerInfo> {
    parse_spark_viewer_urls(&instance_id)
}

/// Получить предупреждение о приватности
#[tauri::command]
pub fn get_spark_privacy_warning() -> PrivacyWarning {
    get_privacy_warning()
}

/// Проверить, установлен ли Spark в БД
fn is_spark_in_database(instance_id: &str) -> bool {
    if let Ok(mods) = ModManager::list_mods(instance_id) {
        mods.iter().any(|m| {
            let slug_lower = m.slug.to_lowercase();
            slug_lower.contains("spark")
        })
    } else {
        false
    }
}

/// Установить Spark через Modrinth
#[tauri::command]
pub async fn install_spark(instance_id: String, app_handle: tauri::AppHandle) -> Result<()> {
    // Проверяем наличие в БД
    if is_spark_in_database(&instance_id) {
        return Err(LauncherError::InvalidConfig(
            "Spark уже установлен в этом экземпляре".to_string(),
        ));
    }

    // Проверяем наличие файла (на случай ручной установки)
    let instance_path = paths::instance_dir(&instance_id);
    if is_spark_installed(&instance_path) {
        return Err(LauncherError::InvalidConfig(
            "Spark уже установлен в этом экземпляре (обнаружен файл)".to_string(),
        ));
    }

    // Получаем информацию об экземпляре для определения версии MC и загрузчика
    let instance = crate::instances::get_instance(instance_id.clone()).await?;

    let spark_slug = get_spark_slug(instance.loader.as_str());
    let download_manager = DownloadManager::new(app_handle)?;

    // Используем ModManager для установки мода
    ModManager::install_from_modrinth(
        &instance_id,
        spark_slug,
        &instance.version,
        instance.loader.as_str(),
        None,
        &download_manager,
    )
    .await?;

    Ok(())
}

/// Проверить, установлен ли Spark (проверяет и БД, и файловую систему)
#[tauri::command]
pub fn check_spark_installed(instance_id: String) -> bool {
    // Сначала проверяем БД (более надёжно)
    if is_spark_in_database(&instance_id) {
        return true;
    }
    // Затем проверяем файловую систему (на случай ручной установки)
    let instance_path = paths::instance_dir(&instance_id);
    is_spark_installed(&instance_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_spark_command_strings() {
        assert_eq!(
            SparkCommand::ProfilerStart.to_command_string(),
            "/spark profiler start"
        );
        assert_eq!(SparkCommand::Tps.to_command_string(), "/spark tps");
    }

    #[test]
    fn test_privacy_warning_default() {
        let warning = PrivacyWarning::default();
        assert_eq!(warning.retention_days, 30);
        assert!(!warning.data_uploaded.is_empty());
        assert!(!warning.data_not_uploaded.is_empty());
    }
}
