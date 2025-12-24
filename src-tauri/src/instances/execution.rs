use chrono::Utc;
use rusqlite::params;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{Emitter, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use crate::server::console as server_console;

/// Windows flag to hide console window
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

use tokio_util::sync::CancellationToken;

use crate::db::get_db_conn;
use crate::downloader::DownloadManager;
use crate::error::{LauncherError, Result};
use crate::gpu;
use crate::java::JavaManager;
use crate::log_analyzer::{LiveCrashEvent, LogAnalyzer};
use crate::minecraft::MinecraftInstaller;
use crate::paths::{find_newest_file_sync, has_extension};
use crate::settings::SettingsManager;
use crate::tray;
use crate::types::{Instance, InstanceType, LoaderType};

use super::lifecycle::{get_instance, ChildMap};

/// Quick patterns for real-time error detection in stdout
fn is_error_line(line: &str) -> bool {
    line.contains("/FATAL]")
        || line.contains("/ERROR]")
        || line.contains("Exception in thread")
        || line.contains("Caused by:")
        || line.contains("Game crashed!")
        || line.contains("A fatal error has been detected")
}

fn is_crash_indicator(line: &str) -> bool {
    line.contains("Game crashed!")
        || line.contains("Preparing crash report")
        || line.contains("A fatal error has been detected")
        || line.contains("The game has crashed")
}

#[tauri::command]
pub async fn start_instance(
    id: String,
    app_handle: tauri::AppHandle,
    state: State<'_, ChildMap>,
) -> Result<()> {
    {
        let map = state.lock().unwrap_or_else(|e| e.into_inner());
        if map.contains_key(&id) {
            return Err(LauncherError::InstanceAlreadyRunning);
        }
    }

    let instance = get_instance(id.clone()).await?;

    // Проверяем статус экземпляра - нельзя запускать если он устанавливается или уже запускается
    match instance.status.as_str() {
        "installing" => {
            log::warn!(
                "Cannot start instance {} - installation in progress",
                instance.name
            );
            return Err(LauncherError::InvalidConfig(
                "Невозможно запустить экземпляр: идёт установка. Дождитесь завершения установки."
                    .to_string(),
            ));
        }
        "starting" => {
            log::warn!("Cannot start instance {} - already starting", instance.name);
            return Err(LauncherError::InvalidConfig(
                "Экземпляр уже запускается.".to_string(),
            ));
        }
        "running" => {
            log::warn!("Cannot start instance {} - already running", instance.name);
            return Err(LauncherError::InstanceAlreadyRunning);
        }
        "stopping" => {
            log::warn!(
                "Cannot start instance {} - currently stopping",
                instance.name
            );
            return Err(LauncherError::InvalidConfig(
                "Экземпляр останавливается. Подождите завершения.".to_string(),
            ));
        }
        _ => {}
    }

    log::info!("Starting instance: {} ({})", instance.name, instance.id);
    log::info!("Instance loader: {:?}, version: {}", instance.loader, instance.version);
    log::info!("Instance dir: {}", instance.dir);

    let download_manager = DownloadManager::new(app_handle.clone())?;
    // Создаём токен отмены для start операций (не используется активно при запуске, но нужен для API)
    let cancel_token = CancellationToken::new();

    log::info!("Ensuring Java availability...");
    let java_path = if let Some(custom_path) = &instance.java_path {
        log::info!("Using custom Java path: {}", custom_path);
        PathBuf::from(custom_path)
    } else {
        log::info!("Auto-detecting Java for version: {}", instance.version);
        JavaManager::ensure_java(
            &instance.version,
            &download_manager,
            &cancel_token,
            Some(&instance.id),
        )
        .await?
    };
    log::info!("Java path resolved: {:?}", java_path);

    log::info!("Spawning instance process...");
    let mut child = spawn_instance_process(&instance, &java_path).await?;
    let child_pid = child.id();

    log::info!("Process started with PID: {}", child_pid);

    // Проверяем не упал ли процесс сразу
    // Увеличено время ожидания для более надежной проверки
    tokio::time::sleep(tokio::time::Duration::from_millis(2000)).await;

    match child.try_wait() {
        Ok(Some(status)) => {
            log::error!("Process exited immediately with status: {:?}", status);
            log::error!("Exit code: {:?}", status.code());

            // Пытаемся прочитать логи для диагностики
            let log_dir = crate::paths::instance_logs_dir(&id);
            let stderr_log = log_dir.join("latest-stderr.log");
            let stdout_log = log_dir.join("latest-stdout.log");

            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

            let mut has_logs = false;
            if let Ok(stderr_content) = tokio::fs::read_to_string(&stderr_log).await {
                if !stderr_content.is_empty() {
                    log::error!("STDERR output:\n{}", stderr_content);
                    has_logs = true;
                }
            }

            if let Ok(stdout_content) = tokio::fs::read_to_string(&stdout_log).await {
                if !stdout_content.is_empty() {
                    log::error!("STDOUT output:\n{}", stdout_content);
                    has_logs = true;
                }
            }

            // Если логи не были записаны, запускаем процесс еще раз для диагностики
            if !has_logs {
                log::warn!(
                    "No logs captured from crashed process. Re-running command for diagnostics..."
                );

                // Пересоздаем команду для диагностики
                let diagnostic_output = spawn_instance_process(&instance, &java_path).await;
                match diagnostic_output {
                    Ok(diag_child) => {
                        // wait_with_output() - это блокирующий вызов, запускаем в отдельном потоке
                        let output =
                            tokio::task::spawn_blocking(move || diag_child.wait_with_output())
                                .await;

                        match output {
                            Ok(Ok(out)) => {
                                let stdout = String::from_utf8_lossy(&out.stdout);
                                let stderr = String::from_utf8_lossy(&out.stderr);
                                if !stdout.is_empty() {
                                    log::error!("Diagnostic STDOUT:\n{}", stdout);
                                }
                                if !stderr.is_empty() {
                                    log::error!("Diagnostic STDERR:\n{}", stderr);
                                }
                            }
                            Ok(Err(e)) => {
                                log::error!("Failed to wait for diagnostic process: {}", e)
                            }
                            Err(e) => log::error!("Failed to join diagnostic task: {}", e),
                        }
                    }
                    Err(e) => log::error!("Failed to spawn diagnostic process: {}", e),
                }
            }

            return Err(LauncherError::InvalidConfig(format!(
                "Minecraft crashed immediately. Check logs in {:?}. Exit status: {:?}",
                log_dir, status
            )));
        }
        Ok(None) => {
            log::info!("Process is running");
        }
        Err(e) => {
            log::error!("Error checking process status: {}", e);
        }
    }

    {
        let conn = get_db_conn()?;
        conn.execute(
            "UPDATE instances SET status = 'running', pid = ?1, last_played = ?2, updated_at = ?2, installation_error = NULL, installation_step = NULL WHERE id = ?3",
            params![child_pid as i64, Utc::now().to_rfc3339(), id],
        )?;
    }

    // Emit status change
    let _ = app_handle.emit(
        "instance-status-changed",
        serde_json::json!({
            "id": id,
            "status": "running"
        }),
    );

    // Live crash monitoring and launch behavior only for clients
    let is_client = matches!(instance.instance_type, InstanceType::Client);

    if is_client {
        // Emit live-crash-event "started" for UI indicator
        let _ = app_handle.emit(
            "live-crash-event",
            LiveCrashEvent::Started {
                instance_id: id.clone(),
            },
        );
        // Apply launch behavior (minimize to tray / keep open / close)
        tray::apply_launch_behavior(&app_handle);
    }

    let instance_id = id.clone();
    let state_clone = state.inner().clone();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdin = child.stdin.take();

    // For servers: register stdin with the console so commands can be sent
    if !is_client {
        if let Some(stdin) = stdin {
            let instance_id_for_stdin = instance_id.clone();
            tauri::async_runtime::spawn(async move {
                server_console::register_server_stdin(&instance_id_for_stdin, stdin).await;
            });
        }
    }

    {
        let mut map = state.lock().unwrap_or_else(|e| e.into_inner());
        map.insert(id, child);
    }

    // Создаем файлы логов для отладки
    let log_dir = crate::paths::instance_logs_dir(&instance_id);
    let stdout_log_path = log_dir.join("latest-stdout.log");
    let stderr_log_path = log_dir.join("latest-stderr.log");

    // Channel to collect stdout lines for crash analysis
    let (stdout_tx, stdout_rx) = std::sync::mpsc::channel::<String>();

    // For servers: spawn async task to handle console log streaming
    let server_log_tx = if !is_client {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let instance_id_for_logs = instance_id.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(line) = rx.recv().await {
                server_console::add_log_and_emit(&instance_id_for_logs, &line).await;
            }
        });
        Some(tx)
    } else {
        None
    };

    if let Some(stdout) = stdout {
        let instance_id_log = instance_id.clone();
        let log_path = stdout_log_path.clone();
        let app_handle_stdout = app_handle.clone();
        let tx = stdout_tx.clone();
        let is_client_stdout = is_client;
        let server_tx = server_log_tx.clone();

        thread::spawn(move || {
            use std::io::Write;
            let mut log_file = std::fs::File::create(&log_path).ok();
            let reader = BufReader::new(stdout);
            let mut error_count = 0u32;
            let mut crash_detected = false;

            for line in reader.lines() {
                if let Ok(line) = line {
                    // Use trace level to avoid cluttering dev console
                    // Logs are saved to file anyway
                    log::trace!("[{} OUT] {}", instance_id_log, line);

                    // Save to file
                    if let Some(ref mut file) = log_file {
                        let _ = writeln!(file, "{}", line);
                    }

                    // For servers: send to async console handler
                    if let Some(ref tx) = server_tx {
                        let _ = tx.send(line.clone());
                    }

                    // Send to collector for crash analysis (only for clients)
                    if is_client_stdout {
                        let _ = tx.send(line.clone());
                    }

                    // Real-time error detection (only for clients)
                    if is_client_stdout && is_error_line(&line) {
                        error_count += 1;

                        // Emit warning event (rate limited - every 5th error)
                        if error_count % 5 == 1 {
                            let _ = app_handle_stdout.emit(
                                "live-crash-event",
                                LiveCrashEvent::Warning {
                                    instance_id: instance_id_log.clone(),
                                    message: line.clone(),
                                    line_number: error_count,
                                    timestamp: chrono::Utc::now().to_rfc3339(),
                                },
                            );
                        }
                    }

                    // Crash detection (only for clients)
                    if is_client_stdout && !crash_detected && is_crash_indicator(&line) {
                        crash_detected = true;
                        log::warn!("Crash detected for instance {}", instance_id_log);
                    }
                }
            }

            log::info!(
                "Stdout reader finished for {}, {} errors detected",
                instance_id_log,
                error_count
            );
        });
    } else {
        log::warn!("No stdout captured");
    }

    // Store stdout receiver for crash analysis when process exits
    let stdout_lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let stdout_lines_collector = Arc::clone(&stdout_lines);

    thread::spawn(move || {
        while let Ok(line) = stdout_rx.recv() {
            if let Ok(mut lines) = stdout_lines_collector.lock() {
                // Keep last 500 lines for crash analysis
                if lines.len() > 500 {
                    lines.remove(0);
                }
                lines.push(line);
            }
        }
    });

    if let Some(stderr) = stderr {
        let instance_id_log = instance_id.clone();
        let log_path = stderr_log_path.clone();
        let server_tx = server_log_tx.clone();
        thread::spawn(move || {
            use std::io::Write;
            let mut log_file = std::fs::File::create(&log_path).ok();
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(line) = line {
                    // Use trace level to avoid cluttering dev console
                    log::trace!("[{} ERR] {}", instance_id_log, line);
                    if let Some(ref mut file) = log_file {
                        let _ = writeln!(file, "{}", line);
                    }

                    // For servers: send to async console handler
                    if let Some(ref tx) = server_tx {
                        let _ = tx.send(format!("[STDERR] {}", line));
                    }
                }
            }
        });
    } else {
        log::warn!("No stderr captured");
    }

    let app_handle_monitor = app_handle.clone();
    let instance_dir_for_crash = crate::paths::instance_dir(&instance_id);
    let is_client_monitor = is_client;

    thread::spawn(move || {
        log::info!("Monitoring thread started for instance {}", instance_id);

        // Ждём завершения процесса. Child извлекается из map чтобы получить ownership
        // для вызова wait(). PID для мониторинга берётся из БД (см. get_instance_pid_from_db).
        let (exit_status, is_last_instance) = {
            let mut map = state_clone.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(mut child) = map.remove(&instance_id) {
                log::info!("Waiting for process to exit: {}", instance_id);
                // Check if this was the last running instance BEFORE dropping the lock
                let is_last = map.is_empty();
                // Освобождаем lock ПЕРЕД wait(), чтобы не блокировать другие операции
                drop(map);
                (child.wait(), is_last)
            } else {
                log::warn!("Child not found in map for instance {}, aborting monitor", instance_id);
                return;
            }
        };

        log::info!("Process exited for {}: {:?}", instance_id, exit_status);

        // Check if it was a crash (non-zero exit code)
        let is_crash = match &exit_status {
            Ok(status) => !status.success(),
            Err(_) => true,
        };

        // Crash analysis only for clients
        if is_crash && is_client_monitor {
            log::warn!("Instance {} crashed, analyzing...", instance_id);

            // Try to analyze crash report
            let crash_reports_dir = instance_dir_for_crash.join("crash-reports");
            let mut problems = Vec::new();

            // Find most recent crash report - используем unified helper
            if crash_reports_dir.exists() {
                if let Some(latest_crash) =
                    find_newest_file_sync(&crash_reports_dir, has_extension("txt"))
                {
                    log::info!("Analyzing crash report: {:?}", latest_crash);
                    if let Ok(content) = std::fs::read_to_string(&latest_crash) {
                        let analyzer = LogAnalyzer::new();
                        let result = analyzer.analyze(&content);
                        problems = result.problems;
                    }
                }
            }

            // Also analyze collected stdout if no problems found
            if problems.is_empty() {
                if let Ok(lines) = stdout_lines.lock() {
                    let content = lines.join("\n");
                    let analyzer = LogAnalyzer::new();
                    let result = analyzer.analyze(&content);
                    problems = result.problems;
                }
            }

            // Emit crash event with analysis
            let _ = app_handle_monitor.emit(
                "live-crash-event",
                LiveCrashEvent::CrashDetected {
                    instance_id: instance_id.clone(),
                    problems: problems.clone(),
                    timestamp: chrono::Utc::now().to_rfc3339(),
                },
            );

            log::info!(
                "Crash analysis complete for {}: {} problems found",
                instance_id,
                problems.len()
            );
        } else if is_crash {
            // For servers, just log the crash without analysis
            log::warn!("Server {} crashed with non-zero exit code", instance_id);
        }

        // Check auto-restart for servers
        let should_auto_restart = if is_crash && !is_client_monitor {
            // Check if auto_restart is enabled in DB
            if let Ok(conn) = get_db_conn() {
                conn.query_row(
                    "SELECT auto_restart FROM instances WHERE id = ?1",
                    params![&instance_id],
                    |row| row.get::<_, i32>(0),
                ).unwrap_or(0) == 1
            } else {
                false
            }
        } else {
            false
        };

        if let Ok(conn) = get_db_conn() {
            // If auto-restart is enabled, set status to "restarting" instead of "crashed"
            let status = if should_auto_restart {
                "restarting"
            } else if is_crash {
                "crashed"
            } else {
                "stopped"
            };
            let _ = conn.execute(
                "UPDATE instances SET status = ?1, pid = NULL, updated_at = ?2 WHERE id = ?3",
                params![status, Utc::now().to_rfc3339(), instance_id],
            );
        }

        // Mark server console as stopped
        if !is_client_monitor {
            let instance_id_for_console = instance_id.clone();
            tauri::async_runtime::block_on(async {
                server_console::mark_server_stopped(&instance_id_for_console).await;
            });
        }

        let _ = app_handle_monitor.emit(
            "instance-status-changed",
            serde_json::json!({
                "id": instance_id,
                "status": if should_auto_restart { "restarting" } else if is_crash { "crashed" } else { "stopped" }
            }),
        );

        // Auto-restart server if enabled
        if should_auto_restart {
            log::info!("Auto-restart enabled for server {}, restarting in 5 seconds...", instance_id);

            // Emit event to notify UI
            let _ = app_handle_monitor.emit(
                "server-auto-restart",
                serde_json::json!({
                    "instance_id": instance_id,
                    "delay_seconds": 5
                }),
            );

            // Wait before restarting to prevent rapid restart loops
            std::thread::sleep(std::time::Duration::from_secs(5));

            // Trigger restart via event - the frontend will handle the actual restart
            // This is safer than trying to restart directly from the monitoring thread
            let _ = app_handle_monitor.emit(
                "server-restart-now",
                serde_json::json!({
                    "instance_id": instance_id
                }),
            );

            log::info!("Auto-restart event emitted for server {}", instance_id);
        }

        // Emit live-crash-event "stopped" for UI indicator (only for clients)
        // This marks monitoring as stopped, but crashes stay visible until user clears them
        if is_client_monitor {
            let _ = app_handle_monitor.emit(
                "live-crash-event",
                LiveCrashEvent::Stopped {
                    instance_id: instance_id.clone(),
                },
            );
        }

        // Show main window only if:
        // 1. This was the last running instance (no other games running)
        // 2. The window was hidden due to game launch (not manually by user)
        // 3. This is a client (servers don't hide the window)
        if is_last_instance && is_client_monitor {
            tray::show_main_window(&app_handle_monitor);
        } else {
            log::debug!("Not showing window - other instances still running or this is a server");
        }

        log::info!(
            "Instance {} {} with status: {:?}",
            instance_id,
            if is_crash { "crashed" } else { "stopped" },
            exit_status
        );
    });

    Ok(())
}

/// Pre-flight проверки перед запуском instance
fn preflight_checks(instance: &Instance, java_path: &PathBuf) -> Result<()> {
    log::info!("=== Running pre-flight checks for {} ===", instance.name);

    // 1. Проверка наличия Java
    if !java_path.exists() {
        return Err(LauncherError::InvalidConfig(format!(
            "Java executable not found: {:?}",
            java_path
        )));
    }
    log::info!("✓ Java found: {:?}", java_path);

    // 2. Проверка доступной памяти системы
    let mut sys = sysinfo::System::new_all();
    sys.refresh_memory();
    let available_mb = sys.available_memory() / 1024 / 1024;
    let required_mb = instance.memory_max as u64;

    if available_mb < required_mb {
        log::warn!(
            "Low memory warning: Available {}MB < Required {}MB",
            available_mb,
            required_mb
        );
    } else {
        log::info!(
            "✓ Memory available: {}MB (required: {}MB)",
            available_mb,
            required_mb
        );
    }

    // 3. Проверка наличия директории instance
    let instance_path = PathBuf::from(&instance.dir);
    if !instance_path.exists() {
        return Err(LauncherError::InvalidConfig(format!(
            "Instance directory not found: {:?}",
            instance_path
        )));
    }
    log::info!("✓ Instance directory exists: {:?}", instance_path);

    // 4. Проверка наличия version JSON
    let version_json_path = instance_path
        .join("versions")
        .join(&instance.version)
        .join(format!("{}.json", &instance.version));

    if !version_json_path.exists() {
        log::warn!("Version JSON not found at: {:?}", version_json_path);
    } else {
        log::info!("✓ Version JSON found");
    }

    log::info!("=== Pre-flight checks completed ===");
    Ok(())
}

/// Check EULA acceptance for server instances
/// Returns error if EULA is not accepted, prompting user to accept in settings
fn check_server_eula(instance_path: &PathBuf) -> Result<()> {
    let eula_path = instance_path.join("eula.txt");

    if eula_path.exists() {
        let content = std::fs::read_to_string(&eula_path).unwrap_or_default();
        if content.contains("eula=true") {
            return Ok(());
        }
        // EULA file exists but not accepted
        return Err(LauncherError::InvalidConfig(
            "EULA не принята. Откройте настройки сервера и примите EULA для запуска.".to_string()
        ));
    }

    // EULA file doesn't exist - first run
    // Return error asking user to accept EULA first
    Err(LauncherError::InvalidConfig(
        "Для запуска сервера необходимо принять EULA. Откройте настройки сервера (вкладка EULA).".to_string()
    ))
}

/// Check if server has argfiles for modern Forge/NeoForge (1.17+)
/// Returns Some(Command) if argfiles found, None otherwise
///
/// Modern Forge/NeoForge use argfiles in libraries folder.
/// We find these argfiles directly without relying on run.bat/run.sh scripts.
fn check_server_run_script(
    instance: &Instance,
    instance_path: &PathBuf,
    java_path: &PathBuf,
) -> Result<Option<Command>> {
    // Check EULA - must be explicitly accepted before server can start
    check_server_eula(instance_path)?;

    // Write user_jvm_args.txt with memory settings and encoding
    let user_jvm_args = instance_path.join("user_jvm_args.txt");
    let jvm_content = format!(
        "# Stuzhik managed JVM args\n-Xms{}M\n-Xmx{}M\n-Dfile.encoding=UTF-8\n-Dstdout.encoding=UTF-8\n-Dstderr.encoding=UTF-8\n",
        instance.memory_max,
        instance.memory_max
    );
    if let Err(e) = std::fs::write(&user_jvm_args, jvm_content) {
        log::warn!("Failed to write user_jvm_args.txt: {}", e);
    }

    // Look for argfiles directly in libraries folder
    // Modern Forge: libraries/net/minecraftforge/forge/VERSION/win_args.txt or unix_args.txt
    // NeoForge: libraries/net/neoforged/neoforge/VERSION/win_args.txt or unix_args.txt
    let libraries_path = instance_path.join("libraries");

    if libraries_path.exists() {
        log::info!("Looking for argfiles in libraries folder...");

        let argfile_name = if cfg!(windows) { "win_args.txt" } else { "unix_args.txt" };

        // Search recursively for argfiles
        fn find_argfiles(dir: &std::path::Path, target: &str, results: &mut Vec<PathBuf>) {
            if let Ok(entries) = std::fs::read_dir(dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        find_argfiles(&path, target, results);
                    } else if path.file_name().and_then(|n| n.to_str()) == Some(target) {
                        results.push(path);
                    }
                }
            }
        }

        let mut found_argfiles: Vec<PathBuf> = Vec::new();
        find_argfiles(&libraries_path, argfile_name, &mut found_argfiles);

        if !found_argfiles.is_empty() {
            // Sort by path length descending (deeper = more specific = newer version)
            found_argfiles.sort_by(|a, b| b.to_string_lossy().len().cmp(&a.to_string_lossy().len()));

            let argfile = &found_argfiles[0];
            log::info!("Found argfile: {:?}", argfile);

            // Build command with our Java path
            let mut cmd = Command::new(java_path);

            // Add user_jvm_args.txt first (memory settings)
            if user_jvm_args.exists() {
                cmd.arg(format!("@{}", user_jvm_args.display()));
            }

            // Add the main argfile
            cmd.arg(format!("@{}", argfile.display()));

            // Add nogui for headless server
            cmd.arg("--nogui");

            log::info!("Launching with argfiles, Java: {:?}", java_path);
            return Ok(Some(cmd));
        } else {
            log::info!("No {} found in libraries folder", argfile_name);
        }
    } else {
        log::info!("No libraries folder found");
    }

    Ok(None)
}

/// Spawn server using run script
fn spawn_with_script(mut cmd: Command, instance_path: &PathBuf) -> Result<Child> {
    cmd.current_dir(instance_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::piped());

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    log::info!("=== Server Launch (run script) ===");
    log::info!("Command: {:?}", cmd);

    cmd.spawn().map_err(LauncherError::from)
}

async fn spawn_instance_process(instance: &Instance, java_path: &PathBuf) -> Result<Child> {
    // Выполняем pre-flight проверки
    preflight_checks(instance, java_path)?;

    log::info!("=== Starting instance: {} ===", instance.name);
    log::info!("Java path: {:?}", java_path);
    log::info!("Instance type: {:?}", instance.instance_type);
    log::info!("Loader: {:?}", instance.loader);
    log::info!("Version: {}", instance.version);

    let instance_path = PathBuf::from(&instance.dir);

    // Note: Client mods scanning is done separately via UI, not during launch
    // This avoids blocking server startup with API calls

    // For servers, check if we should use run scripts (ONLY for Forge/NeoForge)
    // Vanilla, Fabric, Quilt use simple -jar method
    if matches!(instance.instance_type, InstanceType::Server)
        && matches!(instance.loader, LoaderType::Forge | LoaderType::NeoForge)
    {
        log::info!("Checking for run script (Forge/NeoForge server)...");
        match check_server_run_script(instance, &instance_path, java_path) {
            Ok(Some(script_cmd)) => {
                log::info!("Using run script for server launch");
                return spawn_with_script(script_cmd, &instance_path);
            }
            Ok(None) => {
                log::info!("No run script found or argfiles not present, using JAR launch");
            }
            Err(e) => {
                log::error!("Error checking run script: {}", e);
                return Err(e);
            }
        }
    }

    let mut cmd = Command::new(java_path);

    // Получаем GPU переменные окружения (сохраняем для применения к final_cmd на Windows)
    let gpu_env_vars: HashMap<String, String> = if let Ok(Some(selected_gpu)) =
        SettingsManager::get_selected_gpu()
    {
        log::info!("Selected GPU: {}", selected_gpu);
        let gpu_detection = gpu::detect_gpus();
        let env_vars = gpu::get_gpu_environment_variables(&selected_gpu, &gpu_detection.devices);

        if !env_vars.is_empty() {
            log::info!("GPU environment variables: {:?}", env_vars);
        }
        env_vars
    } else {
        HashMap::new()
    };

    // Применяем GPU env vars к команде (на не-Windows платформах это будет final_cmd)
    if !gpu_env_vars.is_empty() {
        cmd.envs(gpu_env_vars.clone());
    }

    // Память
    match instance.instance_type {
        InstanceType::Client => {
            cmd.arg(format!("-Xms{}M", instance.memory_min));
            cmd.arg(format!("-Xmx{}M", instance.memory_max));
            log::info!(
                "Memory: {}M - {}M",
                instance.memory_min,
                instance.memory_max
            );
        }
        InstanceType::Server => {
            cmd.arg(format!("-Xms{}M", instance.memory_max));
            cmd.arg(format!("-Xmx{}M", instance.memory_max));
            // Force UTF-8 encoding for stdin/stdout (fixes Cyrillic input)
            cmd.arg("-Dfile.encoding=UTF-8");
            cmd.arg("-Dstdout.encoding=UTF-8");
            cmd.arg("-Dstderr.encoding=UTF-8");
            log::info!("Memory: {}M", instance.memory_max);
        }
    }

    // JVM аргументы для Forge и NeoForge теперь берутся из version JSON
    // в функции spawn_client_process, поэтому здесь их добавлять не нужно

    // Пользовательские JVM args
    if let Some(ref jargs) = instance.java_args {
        log::info!("Custom JVM args: {}", jargs);
        for arg in jargs.split_whitespace() {
            cmd.arg(arg);
        }
    }

    // Classpath и запуск
    match instance.instance_type {
        InstanceType::Server => {
            spawn_server_jar(&mut cmd, instance, &instance_path)?;
        }
        InstanceType::Client => {
            spawn_client_process(&mut cmd, instance, &instance_path).await?;
        }
    }

    cmd.current_dir(&instance.dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    log::info!("Working directory: {}", instance.dir);

    // На Windows используем argfile для обхода ограничения длины командной строки
    let mut final_cmd = {
        #[cfg(windows)]
        {
            let argfile_path = instance_path.join("launch_args.txt");
            let mut argfile_content = String::new();

            // Собираем все аргументы после java.exe
            for arg in cmd.get_args() {
                let arg_str = arg.to_string_lossy();
                // Экранируем кавычки и пробелы
                if arg_str.contains(' ') || arg_str.contains('"') {
                    argfile_content.push_str(&format!("\"{}\"", arg_str.replace("\"", "\\\"")));
                } else {
                    argfile_content.push_str(&arg_str);
                }
                argfile_content.push('\n');
            }

            // Записываем argfile (async)
            tokio::fs::write(&argfile_path, argfile_content).await?;
            log::info!("Created argfile: {:?}", argfile_path);

            // Создаем новую команду с @argfile
            let java_path = cmd.get_program().to_owned();
            let mut new_cmd = Command::new(java_path);
            new_cmd.arg(format!("@{}", argfile_path.to_string_lossy()));
            new_cmd
                .current_dir(&instance.dir)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .creation_flags(CREATE_NO_WINDOW); // Hide console window

            // Применяем GPU env vars к новой команде на Windows
            if !gpu_env_vars.is_empty() {
                new_cmd.envs(gpu_env_vars.clone());
            }

            new_cmd
        }
        #[cfg(not(windows))]
        {
            cmd
        }
    };

    log::info!("=== Full Launch Command ===");
    log::info!("Command: {:?}", final_cmd);

    // Логируем команду в удобочитаемом формате
    let program = final_cmd.get_program();
    let args: Vec<String> = final_cmd
        .get_args()
        .map(|s| s.to_string_lossy().to_string())
        .collect();
    log::info!("Program: {:?}", program);
    log::info!("Arguments ({}): {:#?}", args.len(), args);
    log::info!("=== End Full Launch Command ===");
    log::info!("Spawning process...");

    let child = final_cmd.spawn();

    match &child {
        Ok(_) => log::info!("Process spawned successfully"),
        Err(e) => log::error!("Failed to spawn process: {}", e),
    }

    child.map_err(LauncherError::from)
}

/// Fallback: spawn server using JAR file (for older Forge, Fabric, Quilt, Vanilla)
fn spawn_server_jar(
    cmd: &mut Command,
    instance: &Instance,
    instance_path: &PathBuf,
) -> Result<()> {
    log::info!("spawn_server_jar: Checking EULA...");
    // Check EULA - must be explicitly accepted before server can start
    check_server_eula(instance_path)?;
    log::info!("spawn_server_jar: EULA check passed");

    log::info!("spawn_server_jar: Finding JAR for loader {:?}", instance.loader);

    // Find any server JAR file - be flexible about naming
    let find_server_jar = || -> Option<String> {
        let entries: Vec<_> = std::fs::read_dir(instance_path)
            .ok()?
            .filter_map(|e| e.ok())
            .filter(|e| {
                let name = e.file_name().to_string_lossy().to_lowercase();
                name.ends_with(".jar")
                    && !name.contains("installer")
                    && !name.contains("-sources")
                    && (name.contains("server")
                        || name.contains("forge")
                        || name.contains("neoforge")
                        || name.contains("fabric")
                        || name.contains("quilt")
                        || name.contains("minecraft"))
            })
            .collect();

        log::info!("Found {} potential server JARs: {:?}",
            entries.len(),
            entries.iter().map(|e| e.file_name()).collect::<Vec<_>>()
        );

        // Prefer specific patterns based on loader
        let preferred: Option<&std::fs::DirEntry> = match instance.loader {
            LoaderType::Forge => entries.iter().find(|e| {
                let n = e.file_name().to_string_lossy().to_lowercase();
                n.starts_with("forge-") || n.contains("forge")
            }),
            LoaderType::NeoForge => entries.iter().find(|e| {
                let n = e.file_name().to_string_lossy().to_lowercase();
                n.contains("neoforge")
            }),
            LoaderType::Fabric => entries.iter().find(|e| {
                let n = e.file_name().to_string_lossy().to_lowercase();
                n.contains("fabric")
            }),
            LoaderType::Quilt => entries.iter().find(|e| {
                let n = e.file_name().to_string_lossy().to_lowercase();
                n.contains("quilt")
            }),
            LoaderType::Vanilla => entries.iter().find(|e| {
                let n = e.file_name().to_string_lossy().to_lowercase();
                n == "server.jar" || n.contains("minecraft")
            }),
        };

        // Use preferred or first found
        preferred
            .or(entries.first())
            .map(|e| e.file_name().to_string_lossy().to_string())
    };

    let jar_name = find_server_jar();

    let jar_path = match jar_name {
        Some(name) => {
            let path = instance_path.join(&name);
            log::info!("Using server JAR: {:?}", path);
            path
        }
        None => {
            // List all JARs for debugging
            let all_jars: Vec<_> = std::fs::read_dir(instance_path)
                .ok()
                .map(|entries| {
                    entries
                        .filter_map(|e| e.ok())
                        .filter(|e| e.file_name().to_string_lossy().ends_with(".jar"))
                        .map(|e| e.file_name().to_string_lossy().to_string())
                        .collect()
                })
                .unwrap_or_default();

            log::error!("No server JAR found. Available JARs: {:?}", all_jars);
            return Err(LauncherError::InvalidConfig(format!(
                "Не найден JAR файл сервера. Найденные JAR: {:?}. Проверьте установку сервера.",
                all_jars
            )));
        }
    };

    log::info!("spawn_server_jar: Launching with JAR: {:?}", jar_path);
    cmd.arg("-jar").arg(jar_path).arg("nogui");
    Ok(())
}

async fn spawn_client_process(
    cmd: &mut Command,
    instance: &Instance,
    instance_path: &PathBuf,
) -> Result<()> {
    let (main_class, classpath, game_args) = match instance.loader {
        LoaderType::Vanilla => {
            log::info!("Loading Vanilla version: {}", instance.version);
            let version_json =
                crate::minecraft::VersionJson::load_with_inheritance(&instance.version).await?;
            let classpath = MinecraftInstaller::generate_classpath_from_json(&version_json)?;
            let game_args = get_game_arguments_for_client(instance, instance_path)?;

            log::info!("Vanilla main class: {}", version_json.main_class);
            log::info!(
                "Classpath entries: {}",
                classpath
                    .split(if cfg!(windows) { ";" } else { ":" })
                    .count()
            );

            (version_json.main_class, classpath, game_args)
        }
        LoaderType::Fabric => {
            log::info!("Loading Fabric profile");
            let profile_path = instance_path.join("fabric-profile.json");
            if !profile_path.exists() {
                return Err(LauncherError::InvalidConfig(
                    "Fabric profile not found. Please reinstall the instance.".to_string(),
                ));
            }

            let content = tokio::fs::read_to_string(profile_path).await?;
            let profile: crate::loaders::FabricProfile = serde_json::from_str(&content)?;

            let classpath = generate_loader_classpath(&instance.version, &profile.libraries)?;
            let game_args = get_game_arguments_for_client(instance, instance_path)?;

            log::info!("Fabric main class: {}", profile.main_class);

            (profile.main_class, classpath, game_args)
        }
        LoaderType::Quilt => {
            log::info!("Loading Quilt profile");
            let profile_path = instance_path.join("quilt-profile.json");
            if !profile_path.exists() {
                return Err(LauncherError::InvalidConfig(
                    "Quilt profile not found. Please reinstall the instance.".to_string(),
                ));
            }

            let content = tokio::fs::read_to_string(profile_path).await?;
            let profile: crate::loaders::FabricProfile = serde_json::from_str(&content)?;

            let classpath = generate_loader_classpath(&instance.version, &profile.libraries)?;
            let game_args = get_game_arguments_for_client(instance, instance_path)?;

            log::info!("Quilt main class: {}", profile.main_class);

            (profile.main_class, classpath, game_args)
        }
        LoaderType::NeoForge => {
            log::info!("Loading NeoForge profile");
            let profile_path = instance_path.join("neoforge-profile.json");
            if !profile_path.exists() {
                log::error!("NeoForge profile not found at: {:?}", profile_path);
                return Err(LauncherError::InvalidConfig(
                    "NeoForge profile not found. Please reinstall the instance.".to_string(),
                ));
            }

            let content = tokio::fs::read_to_string(&profile_path).await?;
            let profile: crate::loaders::NeoForgeProfile = serde_json::from_str(&content)?;

            log::info!("NeoForge version from profile: {}", profile.id);

            // Загружаем версию с поддержкой наследования
            let version_json =
                match crate::minecraft::VersionJson::load_with_inheritance(&profile.id).await {
                    Ok(v) => {
                        log::info!("Successfully loaded NeoForge version JSON");
                        log::info!("Main class: {}", v.main_class);
                        log::info!("Inherits from: {:?}", v.inherits_from);
                        log::info!("Libraries count: {}", v.libraries.len());
                        v
                    }
                    Err(e) => {
                        log::error!("Failed to load NeoForge version JSON: {}", e);
                        return Err(e);
                    }
                };

            // Генерируем classpath с поддержкой instance libraries
            // Для NeoForge НЕ включаем оригинальный Minecraft JAR (используется remapped client)
            let classpath = match MinecraftInstaller::generate_classpath_with_instance(
                &version_json,
                Some(instance_path),
                false, // NeoForge предоставляет свой remapped JAR (client-*-srg.jar)
            ) {
                Ok(cp) => {
                    let entries_count = cp.split(if cfg!(windows) { ";" } else { ":" }).count();
                    log::info!("Generated classpath with {} entries", entries_count);
                    cp
                }
                Err(e) => {
                    log::error!("Failed to generate classpath: {}", e);
                    return Err(e);
                }
            };

            // ИСПРАВЛЕНИЕ: Используем profile.id (версия NeoForge) вместо instance.version (версия Minecraft)
            // для генерации правильных игровых аргументов
            let username = if let Some(ref u) = instance.username {
                u.clone()
            } else {
                SettingsManager::get_default_username()?.unwrap_or_else(|| "Player".to_string())
            };

            let uuid_string = format!("OfflinePlayer:{}", username);
            let uuid = uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_DNS, uuid_string.as_bytes());
            let access_token = uuid.to_string().replace("-", "");

            let game_args = match MinecraftInstaller::get_game_arguments(
                &profile.id, // Используем NeoForge версию, не Minecraft версию
                &username,
                &uuid.to_string(),
                &access_token,
                instance_path,
                &crate::paths::assets_dir(),
            ) {
                Ok(args) => {
                    log::info!("Generated {} game arguments", args.len());
                    args
                }
                Err(e) => {
                    log::error!("Failed to generate game arguments: {}", e);
                    return Err(e);
                }
            };

            // ВАЖНО: Для NeoForge добавляем JVM аргументы из version JSON ПЕРЕД classpath
            let natives_dir = instance_path.join("natives");
            tokio::fs::create_dir_all(&natives_dir).await.ok();

            // Добавляем критически важные аргументы для NeoForge
            // NeoForge использует Java module system с module path из instance/libraries
            log::info!("Adding critical JVM arguments for NeoForge");

            // Устанавливаем libraryDirectory system property для NeoForge
            let instance_libs = instance_path.join("libraries");
            let library_dir_prop =
                format!("-DlibraryDirectory={}", instance_libs.to_string_lossy());
            cmd.arg(&library_dir_prop);
            log::info!(
                "Setting libraryDirectory system property: {}",
                library_dir_prop
            );

            // Добавляем только критические --add-opens для java.base
            // Эти аргументы нужны для reflection и доступа к внутренним API
            let critical_args = vec![
                "--add-opens=java.base/java.lang.invoke=ALL-UNNAMED",
                "--add-opens=java.base/java.lang=ALL-UNNAMED",
                "--add-opens=java.base/java.lang.reflect=ALL-UNNAMED",
                "--add-opens=java.base/java.io=ALL-UNNAMED",
                "--add-opens=java.base/java.net=ALL-UNNAMED",
                "--add-opens=java.base/java.nio=ALL-UNNAMED",
                "--add-opens=java.base/java.nio.file=ALL-UNNAMED",
                "--add-opens=java.base/java.util=ALL-UNNAMED",
                "--add-opens=java.base/java.util.concurrent=ALL-UNNAMED",
                "--add-opens=java.base/java.util.jar=ALL-UNNAMED",
                "--add-opens=java.base/java.util.zip=ALL-UNNAMED",
                "--add-opens=java.base/sun.nio.ch=ALL-UNNAMED",
                "--add-opens=java.base/sun.security.util=ALL-UNNAMED",
            ];
            for arg in critical_args {
                cmd.arg(arg);
            }

            match MinecraftInstaller::get_jvm_arguments(&profile.id, &classpath, &natives_dir) {
                Ok(jvm_args) => {
                    log::info!(
                        "Processing {} JVM arguments from NeoForge version JSON",
                        jvm_args.len()
                    );
                    let mut skip_next = false;
                    let mut added_count = 0;
                    let mut skipped_count = 0;
                    let mut is_module_path_next = false;

                    for jvm_arg in jvm_args {
                        // Обрабатываем module path - заменяем шаблонные переменные и используем instance libraries
                        if is_module_path_next {
                            is_module_path_next = false;

                            // Заменяем шаблонные переменные на реальные пути
                            let instance_libs = instance_path.join("libraries");
                            let separator = if cfg!(windows) { ";" } else { ":" };

                            let mut module_path_value = jvm_arg
                                .replace("${library_directory}", &instance_libs.to_string_lossy())
                                .replace("${classpath_separator}", separator);

                            // ВАЖНО: Исключаем Minecraft JAR из module path!
                            // Minecraft JAR должен быть только в classpath, не в module path
                            // Иначе получим конфликт: "Modules minecraft and _1._21._1 export package..."
                            let separator_str = if cfg!(windows) { ";" } else { ":" };
                            let paths: Vec<&str> = module_path_value.split(separator_str).collect();
                            let filtered_paths: Vec<&str> = paths.into_iter()
                                .filter(|path| {
                                    // Исключаем пути, содержащие /versions/ (Minecraft JAR из shared)
                                    let contains_versions = path.contains("/versions/") || path.contains("\\versions\\");

                                    // Исключаем ТОЛЬКО явные Minecraft JAR файлы:
                                    // - client-<version>-srg.jar (NeoForge remapped client)
                                    // - minecraft-<version>.jar (явное имя)
                                    let _path_lower = path.to_lowercase();
                                    let file_name = PathBuf::from(path)
                                        .file_name()
                                        .and_then(|n| n.to_str())
                                        .map(|s| s.to_lowercase())
                                        .unwrap_or_default();

                                    let is_minecraft_jar =
                                        // Паттерн: client-X.Y.Z-srg.jar (например, client-1.21.1-srg.jar)
                                        (file_name.starts_with("client-") && file_name.ends_with("-srg.jar")) ||
                                        // Паттерн: minecraft-X.Y.Z.jar
                                        (file_name.starts_with("minecraft-") && file_name.ends_with(".jar"));

                                    if contains_versions || is_minecraft_jar {
                                        log::info!("Filtering out Minecraft JAR from module-path: {}", path);
                                        false
                                    } else {
                                        true
                                    }
                                })
                                .collect();

                            module_path_value = filtered_paths.join(separator_str);

                            added_count += 1;
                            log::info!("Using filtered module-path: {}", module_path_value);
                            cmd.arg(module_path_value);
                            continue;
                        }

                        // Пропускаем следующий аргумент если это был -cp
                        if skip_next {
                            skip_next = false;
                            skipped_count += 1;
                            log::debug!("Skipping paired argument: {}", jvm_arg);
                            continue;
                        }

                        // ПРОПУСКАЕМ -DlibraryDirectory из version JSON (мы уже установили его выше)
                        if jvm_arg.starts_with("-DlibraryDirectory=") {
                            skipped_count += 1;
                            log::info!(
                                "Skipping libraryDirectory from version JSON (already set): {}",
                                jvm_arg
                            );
                            continue;
                        }

                        // Пропускаем аргументы памяти, так как они уже добавлены
                        if jvm_arg.starts_with("-Xms") || jvm_arg.starts_with("-Xmx") {
                            skipped_count += 1;
                            log::debug!("Skipping memory argument: {}", jvm_arg);
                            continue;
                        }

                        // Пропускаем -cp и помечаем что следующий аргумент (classpath) тоже нужно пропустить
                        if jvm_arg == "-cp" {
                            skip_next = true;
                            skipped_count += 1;
                            log::debug!("Skipping -cp, will skip next argument too");
                            continue;
                        }

                        // ИСПОЛЬЗУЕМ --module-path для NeoForge, но обработаем следующий аргумент
                        if jvm_arg == "--module-path" || jvm_arg == "-p" {
                            is_module_path_next = true;
                            added_count += 1;
                            log::info!("Keeping module-path for NeoForge: {}", jvm_arg);
                            cmd.arg(jvm_arg);
                            continue;
                        }

                        // ИСПОЛЬЗУЕМ --add-modules для NeoForge
                        if jvm_arg.starts_with("--add-modules=") || jvm_arg == "--add-modules" {
                            added_count += 1;
                            log::info!("Keeping add-modules for NeoForge: {}", jvm_arg);
                            cmd.arg(jvm_arg);
                            continue;
                        }

                        // ПРОПУСКАЕМ --add-reads (это для module system, но не критично)
                        if jvm_arg.starts_with("--add-reads=") {
                            skipped_count += 1;
                            log::debug!("Skipping add-reads (not critical): {}", jvm_arg);
                            continue;
                        }

                        // Пропускаем дубликаты критических аргументов
                        if jvm_arg.starts_with("--add-opens=java.base/java.lang.invoke=")
                            || jvm_arg.starts_with("--add-opens=java.base/java.lang=")
                        {
                            skipped_count += 1;
                            log::debug!("Skipping duplicate critical argument: {}", jvm_arg);
                            continue;
                        }

                        // Разрешаем ВСЕ --add-exports и --add-opens (предупреждения не критичны если module path правильный)
                        if jvm_arg.starts_with("--add-exports=")
                            || jvm_arg.starts_with("--add-opens=")
                        {
                            added_count += 1;
                            log::debug!("Keeping module export/open argument: {}", jvm_arg);
                            cmd.arg(jvm_arg);
                            continue;
                        }

                        added_count += 1;
                        log::debug!("Adding JVM argument: {}", jvm_arg);
                        cmd.arg(jvm_arg);
                    }

                    log::info!(
                        "Added {} JVM arguments, skipped {} arguments",
                        added_count,
                        skipped_count
                    );
                }
                Err(e) => {
                    log::warn!("Failed to get JVM arguments from version JSON: {}", e);
                }
            }

            (version_json.main_class, classpath, game_args)
        }
        LoaderType::Forge => {
            log::info!("Loading Forge profile");

            // Ищем Forge version JSON в instance/versions
            // Forge installer создает version JSON с именем вида "1.20.1-forge-47.2.0"
            let versions_dir = instance_path.join("versions");

            // Сначала пробуем найти директорию версии Forge
            let mut forge_version_id = if versions_dir.exists() {
                let mut entries = tokio::fs::read_dir(&versions_dir).await?;
                let mut found_version: Option<String> = None;

                while let Some(entry) = entries.next_entry().await? {
                    if entry.path().is_dir() {
                        let name = entry.file_name().to_string_lossy().to_string();
                        if name.contains("forge") && name.contains(&instance.version) {
                            found_version = Some(name);
                            break;
                        }
                    }
                }

                found_version
            } else {
                None
            };

            // Fallback: если не найдено в директории, пробуем загрузить из forge-profile.json
            if forge_version_id.is_none() {
                let profile_path = instance_path.join("forge-profile.json");
                if profile_path.exists() {
                    if let Ok(content) = tokio::fs::read_to_string(&profile_path).await {
                        if let Ok(profile) = serde_json::from_str::<serde_json::Value>(&content) {
                            if let Some(id) =
                                profile.get("forge_version_id").and_then(|v| v.as_str())
                            {
                                log::info!("Found forge_version_id in profile: {}", id);
                                forge_version_id = Some(id.to_string());
                            }
                        }
                    }
                }
            }

            if let Some(forge_id) = forge_version_id {
                log::info!("Found Forge version: {}", forge_id);

                // Загружаем Forge version JSON с наследованием
                let version_json =
                    crate::minecraft::VersionJson::load_with_inheritance(&forge_id).await?;

                // Генерируем classpath с учетом instance libraries
                // Для Forge НЕ включаем оригинальный Minecraft JAR (используется remapped client)
                let classpath = MinecraftInstaller::generate_classpath_with_instance(
                    &version_json,
                    Some(instance_path),
                    false, // Forge предоставляет свой remapped JAR (client-*-srg.jar)
                )?;

                // Генерируем game arguments используя Forge version ID
                let username = if let Some(ref u) = instance.username {
                    u.clone()
                } else {
                    SettingsManager::get_default_username()?.unwrap_or_else(|| "Player".to_string())
                };

                let uuid_string = format!("OfflinePlayer:{}", username);
                let uuid = uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_DNS, uuid_string.as_bytes());
                let access_token = uuid.to_string().replace("-", "");

                let game_args = MinecraftInstaller::get_game_arguments(
                    &forge_id,
                    &username,
                    &uuid.to_string(),
                    &access_token,
                    instance_path,
                    &crate::paths::assets_dir(),
                )?;

                // Добавляем JVM аргументы из Forge version JSON
                let natives_dir = instance_path.join("natives");
                tokio::fs::create_dir_all(&natives_dir).await.ok();

                // Добавляем критически важные аргументы для Forge
                // Forge использует Java module system с module path из instance/libraries
                log::info!("Adding critical JVM arguments for Forge");

                // Устанавливаем libraryDirectory system property для Forge
                let instance_libs = instance_path.join("libraries");
                let library_dir_prop =
                    format!("-DlibraryDirectory={}", instance_libs.to_string_lossy());
                cmd.arg(&library_dir_prop);
                log::info!(
                    "Setting libraryDirectory system property: {}",
                    library_dir_prop
                );

                // Добавляем только критические --add-opens для java.base
                // Эти аргументы нужны для reflection и доступа к внутренним API
                let critical_args = vec![
                    "--add-opens=java.base/java.lang.invoke=ALL-UNNAMED",
                    "--add-opens=java.base/java.lang=ALL-UNNAMED",
                    "--add-opens=java.base/java.lang.reflect=ALL-UNNAMED",
                    "--add-opens=java.base/java.io=ALL-UNNAMED",
                    "--add-opens=java.base/java.net=ALL-UNNAMED",
                    "--add-opens=java.base/java.nio=ALL-UNNAMED",
                    "--add-opens=java.base/java.nio.file=ALL-UNNAMED",
                    "--add-opens=java.base/java.util=ALL-UNNAMED",
                    "--add-opens=java.base/java.util.concurrent=ALL-UNNAMED",
                    "--add-opens=java.base/java.util.jar=ALL-UNNAMED",
                    "--add-opens=java.base/java.util.zip=ALL-UNNAMED",
                    "--add-opens=java.base/sun.nio.ch=ALL-UNNAMED",
                    "--add-opens=java.base/sun.security.util=ALL-UNNAMED",
                ];
                for arg in critical_args {
                    cmd.arg(arg);
                }

                match MinecraftInstaller::get_jvm_arguments(&forge_id, &classpath, &natives_dir) {
                    Ok(jvm_args) => {
                        log::info!(
                            "Processing {} JVM arguments from Forge version JSON",
                            jvm_args.len()
                        );
                        let mut skip_next = false;
                        let mut added_count = 0;
                        let mut skipped_count = 0;
                        let mut is_module_path_next = false;

                        for jvm_arg in jvm_args {
                            // Обрабатываем module path - заменяем шаблонные переменные и используем instance libraries
                            if is_module_path_next {
                                is_module_path_next = false;

                                // Заменяем шаблонные переменные на реальные пути
                                let instance_libs = instance_path.join("libraries");
                                let separator = if cfg!(windows) { ";" } else { ":" };

                                let mut module_path_value = jvm_arg
                                    .replace(
                                        "${library_directory}",
                                        &instance_libs.to_string_lossy(),
                                    )
                                    .replace("${classpath_separator}", separator);

                                // ВАЖНО: Исключаем Minecraft JAR из module path!
                                // Minecraft JAR должен быть только в classpath, не в module path
                                // Иначе получим конфликт: "Modules minecraft and _1._21._1 export package..."
                                let separator_str = if cfg!(windows) { ";" } else { ":" };
                                let paths: Vec<&str> =
                                    module_path_value.split(separator_str).collect();
                                let filtered_paths: Vec<&str> = paths.into_iter()
                                    .filter(|path| {
                                        // Исключаем пути, содержащие /versions/ (Minecraft JAR из shared)
                                        let contains_versions = path.contains("/versions/") || path.contains("\\versions\\");

                                        // Исключаем ТОЛЬКО явные Minecraft JAR файлы:
                                        // - client-<version>-srg.jar (NeoForge remapped client)
                                        // - minecraft-<version>.jar (явное имя)
                                        let _path_lower = path.to_lowercase();
                                        let file_name = PathBuf::from(path)
                                            .file_name()
                                            .and_then(|n| n.to_str())
                                            .map(|s| s.to_lowercase())
                                            .unwrap_or_default();

                                        let is_minecraft_jar =
                                            // Паттерн: client-X.Y.Z-srg.jar (например, client-1.21.1-srg.jar)
                                            (file_name.starts_with("client-") && file_name.ends_with("-srg.jar")) ||
                                            // Паттерн: minecraft-X.Y.Z.jar
                                            (file_name.starts_with("minecraft-") && file_name.ends_with(".jar"));

                                        if contains_versions || is_minecraft_jar {
                                            log::info!("Filtering out Minecraft JAR from module-path: {}", path);
                                            false
                                        } else {
                                            true
                                        }
                                    })
                                    .collect();

                                module_path_value = filtered_paths.join(separator_str);

                                added_count += 1;
                                log::info!("Using filtered module-path: {}", module_path_value);
                                cmd.arg(module_path_value);
                                continue;
                            }

                            // Пропускаем следующий аргумент если это был -cp
                            if skip_next {
                                skip_next = false;
                                skipped_count += 1;
                                log::debug!("Skipping paired argument: {}", jvm_arg);
                                continue;
                            }

                            // ПРОПУСКАЕМ -DlibraryDirectory из version JSON (мы уже установили его выше)
                            if jvm_arg.starts_with("-DlibraryDirectory=") {
                                skipped_count += 1;
                                log::info!(
                                    "Skipping libraryDirectory from version JSON (already set): {}",
                                    jvm_arg
                                );
                                continue;
                            }

                            // Пропускаем аргументы памяти, так как они уже добавлены
                            if jvm_arg.starts_with("-Xms") || jvm_arg.starts_with("-Xmx") {
                                skipped_count += 1;
                                log::debug!("Skipping memory argument: {}", jvm_arg);
                                continue;
                            }

                            // Пропускаем -cp и помечаем что следующий аргумент (classpath) тоже нужно пропустить
                            if jvm_arg == "-cp" {
                                skip_next = true;
                                skipped_count += 1;
                                log::debug!("Skipping -cp, will skip next argument too");
                                continue;
                            }

                            // ИСПОЛЬЗУЕМ --module-path для Forge, но обработаем следующий аргумент
                            if jvm_arg == "--module-path" || jvm_arg == "-p" {
                                is_module_path_next = true;
                                added_count += 1;
                                log::info!("Keeping module-path for Forge: {}", jvm_arg);
                                cmd.arg(jvm_arg);
                                continue;
                            }

                            // ИСПОЛЬЗУЕМ --add-modules для Forge
                            if jvm_arg.starts_with("--add-modules=") || jvm_arg == "--add-modules" {
                                added_count += 1;
                                log::info!("Keeping add-modules for Forge: {}", jvm_arg);
                                cmd.arg(jvm_arg);
                                continue;
                            }

                            // ПРОПУСКАЕМ --add-reads (это для module system, но не критично)
                            if jvm_arg.starts_with("--add-reads=") {
                                skipped_count += 1;
                                log::debug!("Skipping add-reads (not critical): {}", jvm_arg);
                                continue;
                            }

                            // Пропускаем дубликаты критических аргументов
                            if jvm_arg.starts_with("--add-opens=java.base/java.lang.invoke=")
                                || jvm_arg.starts_with("--add-opens=java.base/java.lang=")
                            {
                                skipped_count += 1;
                                log::debug!("Skipping duplicate critical argument: {}", jvm_arg);
                                continue;
                            }

                            // Разрешаем ВСЕ --add-exports и --add-opens (предупреждения не критичны если module path правильный)
                            if jvm_arg.starts_with("--add-exports=")
                                || jvm_arg.starts_with("--add-opens=")
                            {
                                added_count += 1;
                                log::debug!("Keeping module export/open argument: {}", jvm_arg);
                                cmd.arg(jvm_arg);
                                continue;
                            }

                            added_count += 1;
                            log::debug!("Adding JVM argument: {}", jvm_arg);
                            cmd.arg(jvm_arg);
                        }

                        log::info!(
                            "Added {} JVM arguments, skipped {} arguments",
                            added_count,
                            skipped_count
                        );
                    }
                    Err(e) => {
                        log::warn!("Failed to get JVM arguments from version JSON: {}", e);
                    }
                }

                (version_json.main_class, classpath, game_args)
            } else {
                log::error!("Forge version not found! Checked:");
                log::error!("  - versions directory: {:?}", versions_dir);
                log::error!(
                    "  - forge-profile.json: {:?}",
                    instance_path.join("forge-profile.json")
                );
                log::error!("Falling back to vanilla - Forge installation may have failed.");
                log::error!("Try repairing the instance or reinstalling Forge.");

                let version_json =
                    crate::minecraft::VersionJson::load_with_inheritance(&instance.version).await?;
                let classpath = MinecraftInstaller::generate_classpath(&instance.version)?;
                let game_args = get_game_arguments_for_client(instance, instance_path)?;

                (version_json.main_class, classpath, game_args)
            }
        }
    };

    // Логируем полную команду запуска
    log::info!("=== Launch Command Details ===");
    log::info!("Main class: {}", main_class);
    log::info!("Game arguments count: {}", game_args.len());

    // Добавляем classpath
    cmd.arg("-cp").arg(&classpath);
    cmd.arg(&main_class);

    // Добавляем game arguments
    for arg in &game_args {
        cmd.arg(arg);
    }

    log::info!("Game arguments: {:?}", game_args);

    // Пользовательские game args
    if let Some(ref gargs) = instance.game_args {
        log::info!("Adding custom game args: {}", gargs);
        for arg in gargs.split_whitespace() {
            cmd.arg(arg);
        }
    }

    log::info!("=== End Launch Command ===");
    Ok(())
}

fn get_game_arguments_for_client(
    instance: &Instance,
    instance_path: &PathBuf,
) -> Result<Vec<String>> {
    let username = if let Some(ref u) = instance.username {
        u.clone()
    } else {
        SettingsManager::get_default_username()?.unwrap_or_else(|| "Player".to_string())
    };

    let uuid_string = format!("OfflinePlayer:{}", username);
    let uuid = uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_DNS, uuid_string.as_bytes());
    let access_token = uuid.to_string().replace("-", "");

    let game_args = MinecraftInstaller::get_game_arguments(
        &instance.version,
        &username,
        &uuid.to_string(),
        &access_token,
        instance_path,
        &crate::paths::assets_dir(),
    )?;

    Ok(game_args)
}

fn generate_loader_classpath(
    minecraft_version: &str,
    libraries: &[crate::loaders::FabricLibrary],
) -> Result<String> {
    let libs_dir = crate::paths::libraries_dir();
    let mut classpath_entries = Vec::new();

    for library in libraries {
        let parts: Vec<&str> = library.name.split(':').collect();
        if parts.len() < 3 {
            continue;
        }

        let path = format!(
            "{}/{}/{}/{}-{}.jar",
            parts[0].replace('.', "/"),
            parts[1],
            parts[2],
            parts[1],
            parts[2]
        );

        let lib_path = libs_dir.join(&path);
        if lib_path.exists() {
            classpath_entries.push(lib_path.to_string_lossy().to_string());
        }
    }

    let vanilla_classpath = MinecraftInstaller::generate_classpath(minecraft_version)?;
    classpath_entries.push(vanilla_classpath);

    let separator = if cfg!(windows) { ";" } else { ":" };
    Ok(classpath_entries.join(separator))
}

#[tauri::command]
pub fn stop_instance(id: String, state: State<'_, ChildMap>) -> Result<()> {
    let mut map = state.lock().unwrap_or_else(|e| e.into_inner());

    if let Some(mut child) = map.remove(&id) {
        log::info!("Stopping instance {} via ChildMap", id);
        let _ = child.kill();
        let _ = child.wait();

        drop(map);

        let conn = get_db_conn()?;
        conn.execute(
            "UPDATE instances SET status = 'stopped', pid = NULL, updated_at = ?1 WHERE id = ?2",
            params![Utc::now().to_rfc3339(), id],
        )?;

        // Mark server console as stopped (sync version)
        server_console::mark_server_stopped_sync(&id);

        Ok(())
    } else {
        drop(map);

        // Try to kill by PID from database (orphaned process from previous app session)
        let conn = get_db_conn()?;
        let pid: Option<i64> = conn
            .query_row(
                "SELECT pid FROM instances WHERE id = ?1",
                params![id.clone()],
                |row| row.get(0),
            )
            .ok();

        if let Some(pid) = pid {
            log::info!("Instance {} not in ChildMap, attempting to kill orphaned process with PID {}", id, pid);

            // Try to kill the process by PID
            let killed = kill_process_by_pid(pid as u32);

            if killed {
                log::info!("Successfully killed orphaned process {} for instance {}", pid, id);
            } else {
                log::warn!("Failed to kill process {} (may already be dead)", pid);
            }

            // Update DB regardless - the process is either dead or we can't kill it
            conn.execute(
                "UPDATE instances SET status = 'stopped', pid = NULL, updated_at = ?1 WHERE id = ?2",
                params![Utc::now().to_rfc3339(), id],
            )?;

            // Mark server console as stopped (sync version)
            server_console::mark_server_stopped_sync(&id);

            Ok(())
        } else {
            Err(LauncherError::InstanceNotRunning)
        }
    }
}

/// Kill a process by PID (cross-platform)
fn kill_process_by_pid(pid: u32) -> bool {
    #[cfg(windows)]
    {
        use std::process::Command;
        // On Windows, use taskkill /F /PID
        Command::new("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        use std::process::Command;
        // On Unix, use kill -9
        Command::new("kill")
            .args(["-9", &pid.to_string()])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
}

/// Force kill a server (SIGKILL) - for when graceful stop doesn't work
#[tauri::command]
pub fn force_kill_server(id: String, state: State<'_, ChildMap>, app_handle: tauri::AppHandle) -> Result<()> {
    log::warn!("Force killing server {}", id);

    let mut map = state.lock().unwrap_or_else(|e| e.into_inner());

    if let Some(mut child) = map.remove(&id) {
        // Force kill the process
        #[cfg(windows)]
        {
            // On Windows, kill() sends TerminateProcess
            let _ = child.kill();
        }
        #[cfg(not(windows))]
        {
            // On Unix, send SIGKILL
            let pid = child.id();
            let _ = std::process::Command::new("kill")
                .args(["-9", &pid.to_string()])
                .output();
        }

        let _ = child.wait();

        drop(map);

        let conn = get_db_conn()?;
        conn.execute(
            "UPDATE instances SET status = 'stopped', pid = NULL, updated_at = ?1 WHERE id = ?2",
            params![Utc::now().to_rfc3339(), id],
        )?;

        // Mark server console as stopped
        server_console::mark_server_stopped_sync(&id);

        // Disconnect RCON
        let id_for_rcon = id.clone();
        tauri::async_runtime::spawn(async move {
            crate::server::rcon::auto_disconnect(&id_for_rcon).await;
        });

        let _ = app_handle.emit(
            "instance-status-changed",
            serde_json::json!({
                "id": &id,
                "status": "stopped"
            }),
        );

        log::info!("Server {} force killed successfully", id);
        Ok(())
    } else {
        drop(map);

        // Try to kill by PID from database
        let conn = get_db_conn()?;
        let pid: Option<i64> = conn
            .query_row(
                "SELECT pid FROM instances WHERE id = ?1",
                params![id.clone()],
                |row| row.get(0),
            )
            .ok();

        if let Some(pid) = pid {
            log::info!("Force killing orphaned process {} for server {}", pid, id);
            kill_process_by_pid(pid as u32);

            conn.execute(
                "UPDATE instances SET status = 'stopped', pid = NULL, updated_at = ?1 WHERE id = ?2",
                params![Utc::now().to_rfc3339(), id],
            )?;

            server_console::mark_server_stopped_sync(&id);

            let id_clone = id.clone();
            tauri::async_runtime::spawn(async move {
                crate::server::rcon::auto_disconnect(&id_clone).await;
            });

            let _ = app_handle.emit(
                "instance-status-changed",
                serde_json::json!({
                    "id": id,
                    "status": "stopped"
                }),
            );

            Ok(())
        } else {
            Err(LauncherError::InstanceNotRunning)
        }
    }
}

/// Graceful stop server via RCON or stdin "stop" command
#[tauri::command]
pub async fn graceful_stop_server(id: String, app_handle: tauri::AppHandle) -> std::result::Result<(), String> {
    log::info!("Attempting graceful stop for server {}", id);

    // Try to send "stop" command
    match server_console::send_server_command(id.clone(), "stop".to_string()).await {
        Ok(result) => {
            if result.success {
                log::info!("Stop command sent to server {} via {}", id, result.method);

                // Emit stopping event
                let _ = app_handle.emit(
                    "instance-status-changed",
                    serde_json::json!({
                        "id": id,
                        "status": "stopping"
                    }),
                );

                // Update status to stopping
                if let Ok(conn) = get_db_conn() {
                    let _ = conn.execute(
                        "UPDATE instances SET status = 'stopping', updated_at = ?1 WHERE id = ?2",
                        params![Utc::now().to_rfc3339(), id],
                    );
                }

                Ok(())
            } else {
                Err(result.error.unwrap_or_else(|| "Failed to send stop command".to_string()))
            }
        }
        Err(e) => Err(e),
    }
}

/// Clean up orphaned processes on app startup
/// This is called during app initialization to kill any processes
/// that were left running from a previous session
pub fn cleanup_orphaned_processes() {
    log::info!("Checking for orphaned processes...");

    let conn = match get_db_conn() {
        Ok(c) => c,
        Err(e) => {
            log::error!("Failed to get DB connection for orphan cleanup: {}", e);
            return;
        }
    };

    // Find instances with running/starting/stopping status and a PID
    // 'stopping' is included because graceful_stop may fail to complete
    let mut stmt = match conn.prepare(
        "SELECT id, name, pid FROM instances WHERE status IN ('running', 'starting', 'stopping') AND pid IS NOT NULL"
    ) {
        Ok(s) => s,
        Err(e) => {
            log::error!("Failed to prepare orphan query: {}", e);
            return;
        }
    };

    let orphans: Vec<(String, String, i64)> = stmt
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .ok()
        .map(|rows| rows.filter_map(|r| r.ok()).collect())
        .unwrap_or_default();

    if orphans.is_empty() {
        log::info!("No orphaned processes found");
        return;
    }

    log::info!("Found {} orphaned instance(s)", orphans.len());

    for (id, name, pid) in orphans {
        log::info!("Cleaning up orphaned instance '{}' (PID: {})", name, pid);

        // Check if process is still running
        if is_process_running(pid as u32) {
            log::info!("Process {} is still running, killing it", pid);
            kill_process_by_pid(pid as u32);
        } else {
            log::info!("Process {} is no longer running", pid);
        }

        // Update DB to stopped status
        if let Err(e) = conn.execute(
            "UPDATE instances SET status = 'stopped', pid = NULL, updated_at = ?1 WHERE id = ?2",
            params![Utc::now().to_rfc3339(), id],
        ) {
            log::error!("Failed to update instance {} status: {}", id, e);
        }
    }

    log::info!("Orphan cleanup complete");

    // Also reset any instances stuck in 'stopping' or 'starting' status without a PID
    // This can happen if the app crashed during stop/start
    let reset_count = conn.execute(
        "UPDATE instances SET status = 'stopped', updated_at = ?1 WHERE status IN ('stopping', 'starting') AND pid IS NULL",
        params![Utc::now().to_rfc3339()],
    ).unwrap_or(0);

    if reset_count > 0 {
        log::info!("Reset {} instances stuck in stopping/starting status", reset_count);
    }
}

/// Check if a process with the given PID is running
fn is_process_running(pid: u32) -> bool {
    #[cfg(windows)]
    {
        use std::process::Command;
        // On Windows, use tasklist to check
        Command::new("tasklist")
            .args(["/FI", &format!("PID eq {}", pid), "/NH"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| {
                let output = String::from_utf8_lossy(&o.stdout);
                output.contains(&pid.to_string())
            })
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        // On Unix, check /proc/PID or use kill -0
        std::path::Path::new(&format!("/proc/{}", pid)).exists()
    }
}
