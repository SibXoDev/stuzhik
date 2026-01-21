use chrono::Utc;
use rusqlite::params;
use std::path::PathBuf;
use std::process::Command;
use tauri_plugin_opener::OpenerExt;

use crate::db::get_db_conn;
use crate::error::{LauncherError, Result};

use super::lifecycle::get_instance;

/// Find VS Code executable on the system
/// Checks common installation paths for each platform
fn find_vscode_executable() -> Option<PathBuf> {
    // First, try the 'code' command in PATH
    if Command::new("code").arg("--version").output().is_ok() {
        return Some(PathBuf::from("code"));
    }

    #[cfg(target_os = "windows")]
    {
        use std::env;

        // Common Windows installation paths
        let mut paths_to_check = Vec::new();

        // User installation (most common)
        if let Ok(local_app_data) = env::var("LOCALAPPDATA") {
            paths_to_check.push(PathBuf::from(&local_app_data).join("Programs/Microsoft VS Code/Code.exe"));
        }

        // System installation
        if let Ok(program_files) = env::var("ProgramFiles") {
            paths_to_check.push(PathBuf::from(&program_files).join("Microsoft VS Code/Code.exe"));
        }

        // 32-bit on 64-bit Windows
        if let Ok(program_files_x86) = env::var("ProgramFiles(x86)") {
            paths_to_check.push(PathBuf::from(&program_files_x86).join("Microsoft VS Code/Code.exe"));
        }

        // VS Code Insiders
        if let Ok(local_app_data) = env::var("LOCALAPPDATA") {
            paths_to_check.push(PathBuf::from(&local_app_data).join("Programs/Microsoft VS Code Insiders/Code - Insiders.exe"));
        }

        for path in paths_to_check {
            if path.exists() {
                return Some(path);
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        let paths_to_check = [
            "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
            "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders",
            "/usr/local/bin/code",
        ];

        for path in paths_to_check {
            let path_buf = PathBuf::from(path);
            if path_buf.exists() {
                return Some(path_buf);
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        let paths_to_check = [
            "/usr/bin/code",
            "/usr/share/code/code",
            "/snap/bin/code",
            "/usr/bin/code-insiders",
            "/var/lib/flatpak/exports/bin/com.visualstudio.code",
        ];

        for path in paths_to_check {
            let path_buf = PathBuf::from(path);
            if path_buf.exists() {
                return Some(path_buf);
            }
        }
    }

    None
}

/// Очистка мёртвых и осиротевших процессов при запуске приложения
/// - Убивает процессы, которые остались от предыдущей сессии
/// - Помечает статус как stopped для мёртвых процессов
pub fn cleanup_dead_processes() -> Result<()> {
    let conn = get_db_conn()?;

    // Очистка мёртвых и осиротевших процессов
    let mut stmt =
        conn.prepare("SELECT id, name, pid FROM instances WHERE status IN ('running', 'starting') AND pid IS NOT NULL")?;

    let instances: Vec<(String, String, i64)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    for (id, name, pid) in instances {
        let process_exists = is_process_running(pid as u32);

        if process_exists {
            // Process is still running from previous session - kill it
            log::warn!(
                "Found orphaned process for instance '{}' (PID {}), killing it",
                name,
                pid
            );
            kill_process_by_pid(pid as u32);
        } else {
            log::info!(
                "Instance '{}' has dead process (PID {}), cleaning up",
                name,
                pid
            );
        }

        // Update status to stopped in both cases
        conn.execute(
            "UPDATE instances SET status = 'stopped', pid = NULL, updated_at = ?1 WHERE id = ?2",
            params![Utc::now().to_rfc3339(), id],
        )?;
    }

    // Обработка зависших установок
    let mut stmt = conn
        .prepare("SELECT id, name, installation_step FROM instances WHERE status = 'installing'")?;

    let installing_instances: Vec<(String, String, Option<String>)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    for (id, name, step) in installing_instances {
        let step_msg = step.unwrap_or_else(|| "unknown".to_string());
        let error_msg = format!("Установка была прервана на этапе '{}'", step_msg);

        log::warn!(
            "Instance {} ('{}') was left in 'installing' state, marking as error",
            id,
            name
        );
        conn.execute(
            "UPDATE instances SET status = 'error', installation_error = ?1, updated_at = ?2 WHERE id = ?3",
            params![error_msg, Utc::now().to_rfc3339(), id],
        )?;
    }

    Ok(())
}

/// Проверка запущен ли процесс с данным PID
pub(super) fn is_process_running(pid: u32) -> bool {
    #[cfg(unix)]
    {
        let result = std::process::Command::new("kill")
            .args(&["-0", &pid.to_string()])
            .output();
        matches!(result, Ok(output) if output.status.success())
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        let result = std::process::Command::new("tasklist")
            .args(&["/FI", &format!("PID eq {}", pid), "/NH"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();

        if let Ok(output) = result {
            let stdout = String::from_utf8_lossy(&output.stdout);
            stdout.contains(&pid.to_string())
        } else {
            false
        }
    }
}

/// Убить процесс по PID (кроссплатформенно)
fn kill_process_by_pid(pid: u32) -> bool {
    #[cfg(unix)]
    {
        let result = Command::new("kill").args(["-9", &pid.to_string()]).output();
        matches!(result, Ok(output) if output.status.success())
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        let result = Command::new("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        matches!(result, Ok(output) if output.status.success())
    }
}

/// Открытие папки экземпляра в файловом менеджере
#[tauri::command]
pub async fn open_instance_folder(
    app: tauri::AppHandle,
    id: String,
    subfolder: Option<String>,
) -> Result<()> {
    // Проверяем что экземпляр существует
    let instance = get_instance(id.clone()).await?;

    let mut path = PathBuf::from(&instance.dir);

    // Если указана подпапка, добавляем её к пути
    if let Some(subfolder) = subfolder {
        // Path traversal protection
        if subfolder.contains("..") {
            return Err(LauncherError::InvalidConfig(
                "Invalid subfolder path: path traversal detected".to_string(),
            ));
        }

        path.push(&subfolder);
    }

    // Проверяем что путь существует
    if !path.exists() {
        return Err(LauncherError::NotFound(format!(
            "Folder not found: {}",
            path.display()
        )));
    }

    // Проверяем что путь находится внутри директории экземпляра
    let canonical_path = path.canonicalize().map_err(|e| LauncherError::Io(e))?;
    let canonical_instance_dir = PathBuf::from(&instance.dir)
        .canonicalize()
        .map_err(|e| LauncherError::Io(e))?;

    if !canonical_path.starts_with(&canonical_instance_dir) {
        return Err(LauncherError::InvalidConfig(
            "Path is outside instance directory".to_string(),
        ));
    }

    // Открываем папку через tauri-plugin-opener (кроссплатформенно)
    app.opener()
        .open_path(canonical_path.to_string_lossy(), None::<&str>)
        .map_err(|e| LauncherError::ApiError(e.to_string()))?;

    Ok(())
}

/// Показать файл в файловом менеджере (с выделением)
#[tauri::command]
pub async fn reveal_instance_file(
    app: tauri::AppHandle,
    instance_id: String,
    relative_path: String,
) -> Result<()> {
    // Проверяем что экземпляр существует
    let instance = get_instance(instance_id.clone()).await?;

    // Path traversal protection
    if relative_path.contains("..") {
        return Err(LauncherError::InvalidConfig(
            "Invalid file path: path traversal detected".to_string(),
        ));
    }

    let mut path = PathBuf::from(&instance.dir);
    path.push(&relative_path);

    // Проверяем что файл существует
    if !path.exists() {
        return Err(LauncherError::NotFound(format!(
            "File not found: {}",
            path.display()
        )));
    }

    // Проверяем что путь находится внутри директории экземпляра
    let canonical_path = path.canonicalize().map_err(|e| LauncherError::Io(e))?;
    let canonical_instance_dir = PathBuf::from(&instance.dir)
        .canonicalize()
        .map_err(|e| LauncherError::Io(e))?;

    if !canonical_path.starts_with(&canonical_instance_dir) {
        return Err(LauncherError::InvalidConfig(
            "Path is outside instance directory".to_string(),
        ));
    }

    // Показываем файл через tauri-plugin-opener (кроссплатформенно)
    app.opener()
        .reveal_item_in_dir(canonical_path)
        .map_err(|e| LauncherError::ApiError(e.to_string()))?;

    Ok(())
}

/// Открыть файл в системном редакторе по умолчанию
#[tauri::command]
pub async fn open_file_in_editor(
    app: tauri::AppHandle,
    instance_id: String,
    relative_path: String,
) -> Result<()> {
    let instance = get_instance(instance_id.clone()).await?;

    // Path traversal protection
    if relative_path.contains("..") {
        return Err(LauncherError::InvalidConfig(
            "Invalid file path: path traversal detected".to_string(),
        ));
    }

    let mut path = PathBuf::from(&instance.dir);
    path.push(&relative_path);

    if !path.exists() {
        return Err(LauncherError::NotFound(format!(
            "File not found: {}",
            path.display()
        )));
    }

    // Verify path is inside instance directory
    let canonical_path = path.canonicalize().map_err(LauncherError::Io)?;
    let canonical_instance_dir = PathBuf::from(&instance.dir)
        .canonicalize()
        .map_err(LauncherError::Io)?;

    if !canonical_path.starts_with(&canonical_instance_dir) {
        return Err(LauncherError::InvalidConfig(
            "Path is outside instance directory".to_string(),
        ));
    }

    // Open in default system editor
    app.opener()
        .open_path(canonical_path.to_string_lossy(), None::<&str>)
        .map_err(|e| LauncherError::ApiError(e.to_string()))?;

    Ok(())
}

/// Открыть файл в VS Code
#[tauri::command]
pub async fn open_file_in_vscode(
    instance_id: String,
    relative_path: String,
) -> Result<()> {
    let instance = get_instance(instance_id.clone()).await?;

    // Path traversal protection
    if relative_path.contains("..") {
        return Err(LauncherError::InvalidConfig(
            "Invalid file path: path traversal detected".to_string(),
        ));
    }

    let mut path = PathBuf::from(&instance.dir);
    path.push(&relative_path);

    if !path.exists() {
        return Err(LauncherError::NotFound(format!(
            "File not found: {}",
            path.display()
        )));
    }

    // Verify path is inside instance directory
    let canonical_path = path.canonicalize().map_err(LauncherError::Io)?;
    let canonical_instance_dir = PathBuf::from(&instance.dir)
        .canonicalize()
        .map_err(LauncherError::Io)?;

    if !canonical_path.starts_with(&canonical_instance_dir) {
        return Err(LauncherError::InvalidConfig(
            "Path is outside instance directory".to_string(),
        ));
    }

    // Find VS Code executable
    let vscode_path = find_vscode_executable().ok_or_else(|| {
        LauncherError::NotFound("VS Code not found. Please install VS Code.".to_string())
    })?;

    let mut cmd = std::process::Command::new(&vscode_path);
    cmd.arg(&canonical_path);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.spawn().map_err(LauncherError::Io)?;

    Ok(())
}

/// Открыть папку экземпляра в VS Code
#[tauri::command]
pub async fn open_folder_in_vscode(instance_id: String) -> Result<()> {
    let instance = get_instance(instance_id.clone()).await?;

    let path = PathBuf::from(&instance.dir);
    if !path.exists() {
        return Err(LauncherError::NotFound(format!(
            "Instance folder not found: {}",
            path.display()
        )));
    }

    // Find VS Code executable
    let vscode_path = find_vscode_executable().ok_or_else(|| {
        LauncherError::NotFound("VS Code not found. Please install VS Code.".to_string())
    })?;

    let mut cmd = std::process::Command::new(&vscode_path);
    cmd.arg(&path);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.spawn().map_err(LauncherError::Io)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_process_running_current_process() {
        // Current process should always be running
        let current_pid = std::process::id();
        assert!(is_process_running(current_pid));
    }

    #[test]
    fn test_is_process_running_invalid_pid() {
        // PID 99999 is very unlikely to exist
        assert!(!is_process_running(99999));
    }
}
