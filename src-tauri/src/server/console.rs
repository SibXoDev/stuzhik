//! Server console with real-time log streaming
//!
//! Provides:
//! - Real-time log streaming via Tauri events
//! - Log level parsing (INFO, WARN, ERROR, DEBUG)
//! - Ring buffer for storing recent logs
//! - Command history
//! - stdin input to running server (works with both sync and async processes)
//! - RCON integration for command responses
//! - Server stop detection from console output
//! - Graceful and force shutdown support

use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::sync::{Arc, LazyLock};
use tokio::sync::RwLock;
use tauri::{AppHandle, Emitter};

use super::rcon::RCON_CONNECTIONS;
use super::ServerResult;

/// Maximum lines to keep in ring buffer
const MAX_LOG_LINES: usize = 10_000;

/// Log level for server logs
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
    Fatal,
    Unknown,
}

impl LogLevel {
    /// Parse log level from Minecraft log line
    pub fn parse(line: &str) -> Self {
        let upper = line.to_uppercase();

        if upper.contains("/FATAL]") || upper.contains("[FATAL]") {
            LogLevel::Fatal
        } else if upper.contains("/ERROR]") || upper.contains("[ERROR]") {
            LogLevel::Error
        } else if upper.contains("/WARN]") || upper.contains("[WARN]") {
            LogLevel::Warn
        } else if upper.contains("/DEBUG]") || upper.contains("[DEBUG]") {
            LogLevel::Debug
        } else if upper.contains("/INFO]") || upper.contains("[INFO]") {
            LogLevel::Info
        } else {
            LogLevel::Unknown
        }
    }
}

/// A single log entry
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ServerLogEntry {
    /// Timestamp when log was received
    pub timestamp: i64,
    /// Log level
    pub level: LogLevel,
    /// Raw log line
    pub line: String,
    /// Parsed thread name (if available)
    pub thread: Option<String>,
    /// Parsed source/logger name (if available)
    pub source: Option<String>,
}

impl ServerLogEntry {
    /// Parse a log line into an entry
    pub fn parse(line: &str) -> Self {
        let level = LogLevel::parse(line);
        let timestamp = chrono::Utc::now().timestamp_millis();

        // Try to parse thread and source from common formats:
        // [HH:MM:SS] [Thread/LEVEL] [Source]: message
        // [HH:MM:SS INFO]: message
        let (thread, source) = parse_log_metadata(line);

        Self {
            timestamp,
            level,
            line: line.to_string(),
            thread,
            source,
        }
    }
}

/// Patterns that indicate server is ready and accepting RCON connections
const SERVER_READY_PATTERNS: &[&str] = &[
    "Done (", // "Done (X.XXXs)! For help, type \"help\""
    "RCON running on",
    "Server started on port",
];

/// Patterns that indicate server is stopping
const SERVER_STOPPING_PATTERNS: &[&str] = &[
    "Stopping server",
    "Stopping the server",
    "Shutting down",
    "Server thread/Shutting Down",
    "[Server thread/INFO]: Stopping server",
    "Server closed",
];

/// Check if a log line indicates server is ready
pub fn is_server_ready_line(line: &str) -> bool {
    SERVER_READY_PATTERNS.iter().any(|p| line.contains(p))
}

/// Check if a log line indicates server is stopping
pub fn is_server_stopping_line(line: &str) -> bool {
    SERVER_STOPPING_PATTERNS.iter().any(|p| line.contains(p))
}

/// Parse thread and source from log line
fn parse_log_metadata(line: &str) -> (Option<String>, Option<String>) {
    let mut thread = None;
    let mut source = None;

    // Find bracketed sections
    let mut brackets: Vec<&str> = Vec::new();
    let mut start = None;
    let mut depth = 0;

    for (i, c) in line.char_indices() {
        match c {
            '[' => {
                if depth == 0 {
                    start = Some(i + 1);
                }
                depth += 1;
            }
            ']' => {
                depth -= 1;
                if depth == 0 {
                    if let Some(s) = start {
                        brackets.push(&line[s..i]);
                    }
                    start = None;
                }
            }
            _ => {}
        }
    }

    // Parse brackets
    for (i, bracket) in brackets.iter().enumerate() {
        if bracket.contains('/') && (bracket.contains("INFO") || bracket.contains("WARN") || bracket.contains("ERROR") || bracket.contains("DEBUG")) {
            if let Some(slash_pos) = bracket.find('/') {
                thread = Some(bracket[..slash_pos].to_string());
            }
        } else if i > 0 && thread.is_some() && source.is_none() {
            source = Some(bracket.to_string());
        }
    }

    (thread, source)
}

/// Command sender type - uses sync channel to send commands to stdin thread
type CommandSender = std::sync::mpsc::Sender<String>;

/// Server console state
pub struct ServerConsole {
    /// Instance ID
    pub instance_id: String,
    /// Ring buffer of log entries
    logs: VecDeque<ServerLogEntry>,
    /// Command history
    command_history: VecDeque<String>,
    /// Channel for sending commands to the stdin thread
    command_sender: Option<CommandSender>,
    /// Is the server running?
    running: bool,
    /// Start time
    start_time: Option<std::time::Instant>,
}

impl std::fmt::Debug for ServerConsole {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ServerConsole")
            .field("instance_id", &self.instance_id)
            .field("logs_count", &self.logs.len())
            .field("running", &self.running)
            .finish()
    }
}

impl ServerConsole {
    /// Create a new console for an instance
    pub fn new(instance_id: String) -> Self {
        Self {
            instance_id,
            logs: VecDeque::with_capacity(MAX_LOG_LINES),
            command_history: VecDeque::with_capacity(100),
            command_sender: None,
            running: false,
            start_time: None,
        }
    }

    /// Start tracking a running server
    /// Takes ownership of the stdin and spawns a thread to handle commands
    pub fn start_with_stdin(&mut self, stdin: std::process::ChildStdin) {
        // Create a channel for commands
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        self.command_sender = Some(tx);
        self.running = true;
        self.start_time = Some(std::time::Instant::now());

        // Spawn a thread to write commands to stdin
        let instance_id = self.instance_id.clone();
        std::thread::spawn(move || {
            let mut stdin = stdin;
            log::info!("Stdin writer thread started for {}", instance_id);

            while let Ok(command) = rx.recv() {
                let line = format!("{}\n", command);
                if let Err(e) = stdin.write_all(line.as_bytes()) {
                    log::error!("Failed to write to stdin for {}: {}", instance_id, e);
                    break;
                }
                if let Err(e) = stdin.flush() {
                    log::error!("Failed to flush stdin for {}: {}", instance_id, e);
                    break;
                }
                log::debug!("Sent command to {}: {}", instance_id, command);
            }

            log::info!("Stdin writer thread exiting for {}", instance_id);
        });
    }

    /// Mark server as stopped
    pub fn mark_stopped(&mut self) {
        self.running = false;
        self.command_sender = None;
        self.start_time = None;
    }

    /// Check if server is running
    pub fn is_running(&self) -> bool {
        self.running
    }

    /// Get uptime in seconds
    pub fn uptime_seconds(&self) -> Option<u64> {
        self.start_time.map(|t| t.elapsed().as_secs())
    }

    /// Add a log line
    pub fn add_log(&mut self, line: &str) {
        let entry = ServerLogEntry::parse(line);

        if self.logs.len() >= MAX_LOG_LINES {
            self.logs.pop_front();
        }

        self.logs.push_back(entry);
    }

    /// Get all logs
    pub fn get_logs(&self) -> Vec<ServerLogEntry> {
        self.logs.iter().cloned().collect()
    }

    /// Get logs since a timestamp
    pub fn get_logs_since(&self, since_timestamp: i64) -> Vec<ServerLogEntry> {
        self.logs
            .iter()
            .filter(|e| e.timestamp > since_timestamp)
            .cloned()
            .collect()
    }

    /// Get recent logs (last N entries)
    pub fn get_recent_logs(&self, count: usize) -> Vec<ServerLogEntry> {
        self.logs.iter().rev().take(count).rev().cloned().collect()
    }

    /// Clear all logs
    pub fn clear_logs(&mut self) {
        self.logs.clear();
    }

    /// Send a command to the server via stdin
    pub fn send_command(&mut self, command: &str) -> ServerResult<()> {
        if let Some(ref sender) = self.command_sender {
            sender.send(command.to_string()).map_err(|_| {
                super::ServerError::NotRunning(self.instance_id.clone())
            })?;

            // Add to history
            let cmd = command.to_string();
            if self.command_history.front() != Some(&cmd) {
                if self.command_history.len() >= 100 {
                    self.command_history.pop_back();
                }
                self.command_history.push_front(cmd);
            }

            Ok(())
        } else {
            Err(super::ServerError::NotRunning(self.instance_id.clone()))
        }
    }

    /// Get command history
    pub fn get_command_history(&self) -> Vec<String> {
        self.command_history.iter().cloned().collect()
    }

    /// Check if console can send commands
    pub fn can_send_commands(&self) -> bool {
        self.command_sender.is_some()
    }
}

/// Global console manager
static CONSOLES: LazyLock<RwLock<HashMap<String, Arc<RwLock<ServerConsole>>>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

/// App handle for emitting events
static APP_HANDLE: LazyLock<RwLock<Option<AppHandle>>> = LazyLock::new(|| RwLock::new(None));

/// Initialize console module
pub fn init(app: &AppHandle) {
    let mut handle = APP_HANDLE.blocking_write();
    *handle = Some(app.clone());
}

/// Get or create console for an instance
pub async fn get_console(instance_id: &str) -> Arc<RwLock<ServerConsole>> {
    let mut consoles = CONSOLES.write().await;

    if let Some(console) = consoles.get(instance_id) {
        console.clone()
    } else {
        let console = Arc::new(RwLock::new(ServerConsole::new(instance_id.to_string())));
        consoles.insert(instance_id.to_string(), console.clone());
        console
    }
}

/// Remove console for an instance
pub async fn remove_console(instance_id: &str) {
    let mut consoles = CONSOLES.write().await;
    consoles.remove(instance_id);
}

/// Register a running server with its stdin
pub async fn register_server_stdin(instance_id: &str, stdin: std::process::ChildStdin) {
    let console = get_console(instance_id).await;
    let mut console = console.write().await;
    console.start_with_stdin(stdin);
    log::info!("Registered stdin for server {}", instance_id);
}

/// Mark server as stopped (sync version for use from stop_instance)
pub fn mark_server_stopped_sync(instance_id: &str) {
    let consoles = CONSOLES.blocking_read();
    if let Some(console) = consoles.get(instance_id) {
        let mut console = console.blocking_write();
        console.mark_stopped();
        log::info!("Marked server {} as stopped", instance_id);
    }
}

/// Mark server as stopped (async version)
pub async fn mark_server_stopped(instance_id: &str) {
    let console = get_console(instance_id).await;
    let mut console = console.write().await;
    console.mark_stopped();
    log::info!("Marked server {} as stopped", instance_id);
}

/// Add log line and emit event
/// Also detects server ready/stopping patterns and triggers appropriate actions
pub async fn add_log_and_emit(instance_id: &str, line: &str) {
    let console = get_console(instance_id).await;
    let entry = {
        let mut console = console.write().await;
        console.add_log(line);
        console.logs.back().cloned()
    };

    // Check for server ready pattern - try to auto-connect RCON
    if is_server_ready_line(line) {
        log::info!("Server {} appears ready, attempting RCON auto-connect", instance_id);

        // Spawn async task to try RCON connection (with delay for server to fully start)
        let instance_id_clone = instance_id.to_string();
        tauri::async_runtime::spawn(async move {
            // Wait a bit for RCON to be ready
            tokio::time::sleep(tokio::time::Duration::from_millis(2000)).await;

            // Try to connect, retry a few times if needed
            for attempt in 1..=5 {
                if super::rcon::try_auto_connect(&instance_id_clone).await {
                    // Emit RCON connected event
                    if let Some(ref app) = *APP_HANDLE.read().await {
                        let _ = app.emit(
                            &format!("server-rcon:{}", instance_id_clone),
                            serde_json::json!({ "connected": true }),
                        );
                    }
                    break;
                }

                if attempt < 5 {
                    tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
                }
            }
        });
    }

    // Check for server stopping pattern
    if is_server_stopping_line(line) {
        log::info!("Server {} is stopping (detected from console)", instance_id);

        // Emit stopping event
        if let Some(ref app) = *APP_HANDLE.read().await {
            let _ = app.emit(
                &format!("server-stopping:{}", instance_id),
                serde_json::json!({ "reason": "console_command" }),
            );
        }

        // Disconnect RCON
        super::rcon::auto_disconnect(instance_id).await;
    }

    // Emit log event to frontend with instance-specific event name
    if let Some(entry) = entry {
        if let Some(ref app) = *APP_HANDLE.read().await {
            let _ = app.emit(&format!("server-log:{}", instance_id), &entry);
        }
    }
}

/// Batch emit logs (for initial load or reconnection)
pub async fn emit_logs_batch(instance_id: &str, logs: &[ServerLogEntry]) {
    if let Some(ref app) = *APP_HANDLE.read().await {
        let _ = app.emit(&format!("server-logs-batch:{}", instance_id), logs);
    }
}

// Tauri commands
#[tauri::command]
pub async fn get_server_logs(
    instance_id: String,
    since_timestamp: Option<i64>,
    limit: Option<usize>,
) -> Result<Vec<ServerLogEntry>, String> {
    let console = get_console(&instance_id).await;
    let console = console.read().await;

    let logs = if let Some(since) = since_timestamp {
        console.get_logs_since(since)
    } else if let Some(limit) = limit {
        console.get_recent_logs(limit)
    } else {
        console.get_logs()
    };

    Ok(logs)
}

/// Result of sending a command to the server
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CommandResult {
    /// Whether command was sent successfully
    pub success: bool,
    /// Method used (rcon or stdin)
    pub method: String,
    /// Response from RCON (if available)
    pub response: Option<String>,
    /// Error message (if any)
    pub error: Option<String>,
}

#[tauri::command]
pub async fn send_server_command(instance_id: String, command: String) -> Result<CommandResult, String> {
    // Try RCON first if connected (provides response)
    {
        let connections = RCON_CONNECTIONS.read().await;
        if let Some(client) = connections.get(&instance_id) {
            match client.command(&command).await {
                Ok(response) => {
                    log::debug!("Command sent via RCON: {} -> {}", command, response);

                    // Add command and response to console logs
                    drop(connections);
                    let console = get_console(&instance_id).await;
                    {
                        let mut console = console.write().await;
                        // Add command to history
                        let cmd = command.clone();
                        if console.command_history.front() != Some(&cmd) {
                            if console.command_history.len() >= 100 {
                                console.command_history.pop_back();
                            }
                            console.command_history.push_front(cmd);
                        }
                    }

                    // Add RCON response as a log entry
                    if !response.is_empty() {
                        add_log_and_emit(&instance_id, &format!("[RCON] > {}", command)).await;
                        add_log_and_emit(&instance_id, &format!("[RCON] {}", response)).await;
                    }

                    return Ok(CommandResult {
                        success: true,
                        method: "rcon".to_string(),
                        response: Some(response),
                        error: None,
                    });
                }
                Err(e) => {
                    log::warn!("RCON command failed, falling back to stdin: {}", e);
                    // Fall through to stdin
                }
            }
        }
    }

    // Fallback to stdin
    let console = get_console(&instance_id).await;
    let mut console = console.write().await;

    match console.send_command(&command) {
        Ok(()) => Ok(CommandResult {
            success: true,
            method: "stdin".to_string(),
            response: None,
            error: None,
        }),
        Err(e) => Ok(CommandResult {
            success: false,
            method: "stdin".to_string(),
            response: None,
            error: Some(e.to_string()),
        }),
    }
}

/// Send command via RCON only (returns error if RCON not connected)
#[tauri::command]
pub async fn send_rcon_command(instance_id: String, command: String) -> Result<String, String> {
    let connections = RCON_CONNECTIONS.read().await;
    let client = connections
        .get(&instance_id)
        .ok_or_else(|| "RCON not connected. Enable RCON in server settings.".to_string())?;

    client.command(&command).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_command_history(instance_id: String) -> Result<Vec<String>, String> {
    let console = get_console(&instance_id).await;
    let console = console.read().await;

    Ok(console.get_command_history())
}

#[tauri::command]
pub async fn clear_server_logs(instance_id: String) -> Result<(), String> {
    let console = get_console(&instance_id).await;
    let mut console = console.write().await;

    console.clear_logs();
    Ok(())
}

/// Server status
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ServerStatus {
    pub running: bool,
    pub instance_id: String,
    pub uptime_seconds: Option<u64>,
    pub log_count: usize,
    pub can_send_commands: bool,
}

#[tauri::command]
pub async fn get_server_status(instance_id: String) -> Result<ServerStatus, String> {
    let console = get_console(&instance_id).await;
    let console = console.read().await;

    Ok(ServerStatus {
        running: console.is_running(),
        instance_id: console.instance_id.clone(),
        uptime_seconds: console.uptime_seconds(),
        log_count: console.logs.len(),
        can_send_commands: console.can_send_commands(),
    })
}

#[tauri::command]
pub async fn is_server_running(instance_id: String) -> bool {
    let console = get_console(&instance_id).await;
    let console = console.read().await;
    console.is_running()
}

// Legacy start_server/stop_server functions removed - use instances::start_instance instead
#[tauri::command]
pub async fn start_server(
    _instance_id: String,
    _java_path: String,
    _server_jar: String,
    _jvm_args: Option<Vec<String>>,
    _game_args: Option<Vec<String>>,
) -> Result<(), String> {
    Err("Use start_instance instead of start_server".to_string())
}

#[tauri::command]
pub async fn stop_server(_instance_id: String) -> Result<(), String> {
    Err("Use stop_instance instead of stop_server".to_string())
}
