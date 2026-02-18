//! Live Crash Monitor - Real-time log monitoring and crash detection
//!
//! Monitors Minecraft log files in real-time, detecting errors and crashes
//! as they happen and streaming events to the UI.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use regex::Regex;
use serde::{Deserialize, Serialize};
use stuzhik_core::{DetectedProblem, ProblemCategory, ProblemStatus, Severity};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

use super::LogAnalyzer;

// Кешированные regex паттерны для extract_mod_from_line (компилируются один раз)

/// Pattern: [ModName] - извлекает имя мода из квадратных скобок
static RE_BRACKET: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
    Regex::new(r"\[([a-zA-Z][a-zA-Z0-9_-]{2,30})\]")
        .expect("RE_BRACKET regex should compile")
});

/// Pattern: at com.modname. - извлекает mod ID из stacktrace
static RE_AT_PACKAGE: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
    Regex::new(r"at\s+(?:com|net|org)\.([a-z][a-z0-9_]{2,20})\.")
        .expect("RE_AT_PACKAGE regex should compile")
});

/// Live crash event sent to frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum LiveCrashEvent {
    /// Monitoring started
    #[serde(rename = "started")]
    Started { instance_id: String },

    /// Monitoring stopped
    #[serde(rename = "stopped")]
    Stopped { instance_id: String },

    /// Warning detected in log
    #[serde(rename = "warning")]
    Warning {
        instance_id: String,
        message: String,
        line_number: u32,
        timestamp: String,
    },

    /// Error detected in log
    #[serde(rename = "error")]
    Error {
        instance_id: String,
        problem: DetectedProblem,
        timestamp: String,
    },

    /// Game crashed
    #[serde(rename = "crash")]
    CrashDetected {
        instance_id: String,
        problems: Vec<DetectedProblem>,
        timestamp: String,
    },

    /// Monitoring error occurred
    #[serde(rename = "monitor_error")]
    MonitorError {
        instance_id: String,
        message: String,
    },
}

/// State for a single monitored instance
struct MonitoredInstance {
    /// Instance ID
    instance_id: String,
    /// Path to the log file being monitored
    log_path: PathBuf,
    /// Last read position in the file
    last_position: u64,
    /// Line number for new lines
    current_line: u32,
    /// Recent errors for deduplication
    recent_errors: Vec<String>,
    /// Last error time for rate limiting
    last_error_time: Option<Instant>,
}

impl MonitoredInstance {
    fn new(instance_id: String, log_path: PathBuf) -> Self {
        Self {
            instance_id,
            log_path,
            last_position: 0,
            current_line: 0,
            recent_errors: Vec::new(),
            last_error_time: None,
        }
    }

    /// Check if error should be deduplicated
    fn should_dedupe(&mut self, error_msg: &str) -> bool {
        // Keep last 20 errors for deduplication
        if self.recent_errors.len() > 20 {
            self.recent_errors.remove(0);
        }

        // Check if error is recent duplicate
        let is_duplicate = self.recent_errors.iter().any(|e| {
            // Fuzzy match - same first 50 chars
            let e_prefix = &e[..e.len().min(50)];
            let msg_prefix = &error_msg[..error_msg.len().min(50)];
            e_prefix == msg_prefix
        });

        if !is_duplicate {
            self.recent_errors.push(error_msg.to_string());
        }

        is_duplicate
    }

    /// Rate limiting - max 1 error per 100ms
    fn should_rate_limit(&mut self) -> bool {
        if let Some(last_time) = self.last_error_time {
            if last_time.elapsed() < Duration::from_millis(100) {
                return true;
            }
        }
        self.last_error_time = Some(Instant::now());
        false
    }
}

/// Live Crash Monitor - manages file watchers for multiple instances
pub struct LiveCrashMonitor {
    /// Monitored instances by instance_id
    instances: Arc<Mutex<HashMap<String, MonitoredInstance>>>,
    /// File watcher
    watcher: Option<RecommendedWatcher>,
    /// Event channel sender
    tx: Option<mpsc::UnboundedSender<(String, PathBuf)>>,
    /// App handle for emitting events
    app_handle: Option<AppHandle>,
}

impl Default for LiveCrashMonitor {
    fn default() -> Self {
        Self::new()
    }
}

impl LiveCrashMonitor {
    /// Create a new LiveCrashMonitor
    pub fn new() -> Self {
        Self {
            instances: Arc::new(Mutex::new(HashMap::new())),
            watcher: None,
            tx: None,
            app_handle: None,
        }
    }

    /// Initialize the monitor with an app handle
    pub fn init(&mut self, app_handle: AppHandle) -> Result<(), String> {
        self.app_handle = Some(app_handle.clone());

        let (tx, mut rx) = mpsc::unbounded_channel::<(String, PathBuf)>();
        self.tx = Some(tx.clone());

        let instances = Arc::clone(&self.instances);

        // Create file watcher
        let watcher_tx = tx.clone();
        let watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                if matches!(event.kind, EventKind::Modify(_)) {
                    for path in event.paths {
                        // Find which instance this path belongs to
                        if let Ok(instances_guard) = instances.lock() {
                            for (instance_id, instance) in instances_guard.iter() {
                                if instance.log_path == path {
                                    let _ = watcher_tx.send((instance_id.clone(), path.clone()));
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        })
        .map_err(|e| format!("Failed to create file watcher: {}", e))?;

        self.watcher = Some(watcher);

        // Spawn task to handle file changes
        let instances_for_task = Arc::clone(&self.instances);
        let app_for_task = app_handle.clone();

        tauri::async_runtime::spawn(async move {
            while let Some((instance_id, path)) = rx.recv().await {
                Self::process_new_lines(&instances_for_task, &app_for_task, &instance_id, &path)
                    .await;
            }
        });

        log::info!("LiveCrashMonitor initialized");
        Ok(())
    }

    /// Start monitoring an instance's log file
    /// If the file doesn't exist yet, spawns a background task to wait for it
    pub fn start_monitoring(&mut self, instance_id: &str, log_path: PathBuf) -> Result<(), String> {
        // If log file doesn't exist yet, spawn a task to wait for it
        if !log_path.exists() {
            log::info!(
                "Log file doesn't exist yet for {}, waiting for it to appear: {:?}",
                instance_id,
                log_path
            );

            // Spawn background task to wait for file and then start monitoring
            let instance_id_clone = instance_id.to_string();
            let log_path_clone = log_path.clone();

            tauri::async_runtime::spawn(async move {
                // Wait up to 60 seconds for file to appear (Minecraft can take a while to start)
                let timeout = std::time::Duration::from_secs(60);
                let poll_interval = std::time::Duration::from_millis(500);
                let start = std::time::Instant::now();

                while start.elapsed() < timeout {
                    if log_path_clone.exists() {
                        log::info!(
                            "Log file appeared for {}, starting monitoring",
                            instance_id_clone
                        );

                        // Try to start monitoring now
                        if let Ok(mut monitor) = get_monitor().lock() {
                            if let Err(e) = monitor.start_monitoring_internal(
                                &instance_id_clone,
                                log_path_clone.clone(),
                            ) {
                                log::error!(
                                    "Failed to start monitoring after file appeared: {}",
                                    e
                                );
                            }
                        }
                        return;
                    }
                    tokio::time::sleep(poll_interval).await;
                }

                log::warn!(
                    "Timeout waiting for log file to appear for {}: {:?}",
                    instance_id_clone,
                    log_path_clone
                );
            });

            return Ok(()); // Return immediately, monitoring will start when file appears
        }

        self.start_monitoring_internal(instance_id, log_path)
    }

    /// Internal method to actually start monitoring (file must exist)
    fn start_monitoring_internal(
        &mut self,
        instance_id: &str,
        log_path: PathBuf,
    ) -> Result<(), String> {
        // Get file size for initial position
        let initial_position = std::fs::metadata(&log_path).map(|m| m.len()).unwrap_or(0);

        // Count existing lines
        let initial_lines = if let Ok(file) = File::open(&log_path) {
            BufReader::new(file).lines().count() as u32
        } else {
            0
        };

        // Add to monitored instances
        let mut instance = MonitoredInstance::new(instance_id.to_string(), log_path.clone());
        instance.last_position = initial_position;
        instance.current_line = initial_lines;

        {
            let mut instances = self
                .instances
                .lock()
                .map_err(|e| format!("Failed to lock instances: {}", e))?;
            instances.insert(instance_id.to_string(), instance);
        }

        // Start watching the file
        if let Some(watcher) = &mut self.watcher {
            watcher
                .watch(&log_path, RecursiveMode::NonRecursive)
                .map_err(|e| format!("Failed to watch file: {}", e))?;
        }

        // Emit started event
        if let Some(app) = &self.app_handle {
            let _ = app.emit(
                "live-crash-event",
                LiveCrashEvent::Started {
                    instance_id: instance_id.to_string(),
                },
            );
        }

        log::info!(
            "Started monitoring instance {} at {:?}",
            instance_id,
            log_path
        );
        Ok(())
    }

    /// Stop monitoring an instance
    pub fn stop_monitoring(&mut self, instance_id: &str) -> Result<(), String> {
        let log_path = {
            let mut instances = self
                .instances
                .lock()
                .map_err(|e| format!("Failed to lock instances: {}", e))?;

            if let Some(instance) = instances.remove(instance_id) {
                Some(instance.log_path)
            } else {
                None
            }
        };

        // Unwatch the file
        if let (Some(watcher), Some(path)) = (&mut self.watcher, log_path) {
            let _ = watcher.unwatch(&path);
        }

        // Emit stopped event
        if let Some(app) = &self.app_handle {
            let _ = app.emit(
                "live-crash-event",
                LiveCrashEvent::Stopped {
                    instance_id: instance_id.to_string(),
                },
            );
        }

        log::info!("Stopped monitoring instance {}", instance_id);
        Ok(())
    }

    /// Check if an instance is being monitored
    pub fn is_monitoring(&self, instance_id: &str) -> bool {
        if let Ok(instances) = self.instances.lock() {
            instances.contains_key(instance_id)
        } else {
            false
        }
    }

    /// Get list of monitored instances
    pub fn get_monitored_instances(&self) -> Vec<String> {
        if let Ok(instances) = self.instances.lock() {
            instances.keys().cloned().collect()
        } else {
            Vec::new()
        }
    }

    /// Process new lines added to the log file
    async fn process_new_lines(
        instances: &Arc<Mutex<HashMap<String, MonitoredInstance>>>,
        app: &AppHandle,
        instance_id: &str,
        path: &PathBuf,
    ) {
        // Read new lines
        let new_lines = {
            let mut instances_guard = match instances.lock() {
                Ok(g) => g,
                Err(_) => return,
            };

            let instance = match instances_guard.get_mut(instance_id) {
                Some(i) => i,
                None => return,
            };

            // Open file and seek to last position
            let mut file = match File::open(path) {
                Ok(f) => f,
                Err(_) => return,
            };

            let file_len = file.metadata().map(|m| m.len()).unwrap_or(0);

            // File was truncated/reset - start from beginning
            if file_len < instance.last_position {
                instance.last_position = 0;
                instance.current_line = 0;
            }

            // No new content
            if file_len == instance.last_position {
                return;
            }

            // Seek to last position
            if file.seek(SeekFrom::Start(instance.last_position)).is_err() {
                return;
            }

            let reader = BufReader::new(&file);
            let mut lines: Vec<(u32, String)> = Vec::new();

            for line in reader.lines().map_while(Result::ok) {
                instance.current_line += 1;
                lines.push((instance.current_line, line));
            }

            // Update position
            instance.last_position = file_len;

            lines
        };

        // Analyze new lines
        for (line_num, line) in new_lines {
            Self::analyze_line(instances, app, instance_id, line_num, &line).await;
        }
    }

    /// Analyze a single log line
    async fn analyze_line(
        instances: &Arc<Mutex<HashMap<String, MonitoredInstance>>>,
        app: &AppHandle,
        instance_id: &str,
        line_num: u32,
        line: &str,
    ) {
        let timestamp = chrono::Utc::now().to_rfc3339();

        // Quick pattern matching for common issues
        let line_lower = line.to_lowercase();

        // Check for crash
        if line_lower.contains("the game crashed")
            || line_lower.contains("a fatal error has been detected")
            || line_lower.contains("minecraft has crashed")
            || line_lower.contains("---- minecraft crash report ----")
        {
            // Full crash analysis
            let result = LogAnalyzer::new().analyze(line);
            let problems = result.problems;
            let _ = app.emit(
                "live-crash-event",
                LiveCrashEvent::CrashDetected {
                    instance_id: instance_id.to_string(),
                    problems,
                    timestamp,
                },
            );
            return;
        }

        // Check for errors
        if line_lower.contains("[error]")
            || line_lower.contains("/error]")
            || line.contains("Exception")
            || line.contains("Error:")
        {
            // Rate limiting and deduplication
            {
                let mut instances_guard = match instances.lock() {
                    Ok(g) => g,
                    Err(_) => return,
                };

                if let Some(instance) = instances_guard.get_mut(instance_id) {
                    if instance.should_rate_limit() || instance.should_dedupe(line) {
                        return;
                    }
                }
            }

            // Quick analysis for common errors
            let problem = Self::quick_analyze_error(line, line_num);

            let _ = app.emit(
                "live-crash-event",
                LiveCrashEvent::Error {
                    instance_id: instance_id.to_string(),
                    problem,
                    timestamp,
                },
            );
            return;
        }

        // Check for warnings (less verbose)
        if line_lower.contains("[warn]") || line_lower.contains("/warn]") {
            // Only emit significant warnings
            if Self::is_significant_warning(line) {
                let _ = app.emit(
                    "live-crash-event",
                    LiveCrashEvent::Warning {
                        instance_id: instance_id.to_string(),
                        message: line.to_string(),
                        line_number: line_num,
                        timestamp,
                    },
                );
            }
        }
    }

    /// Quick analysis of an error line
    fn quick_analyze_error(line: &str, line_num: u32) -> DetectedProblem {
        let line_lower = line.to_lowercase();

        // Determine category and severity
        let (category, severity, title) =
            if line_lower.contains("outofmemory") || line_lower.contains("out of memory") {
                (
                    ProblemCategory::MemoryIssue,
                    Severity::Critical,
                    "Out of Memory",
                )
            } else if line_lower.contains("classnotfound") || line_lower.contains("nosuchmethod") {
                (
                    ProblemCategory::MissingDependency,
                    Severity::Error,
                    "Missing Class/Method",
                )
            } else if line_lower.contains("mixin") || line_lower.contains("injection") {
                (
                    ProblemCategory::ModConflict,
                    Severity::Error,
                    "Mixin/Injection Error",
                )
            } else if line_lower.contains("config") || line_lower.contains("toml") {
                (
                    ProblemCategory::ConfigError,
                    Severity::Warning,
                    "Configuration Error",
                )
            } else if line_lower.contains("render") || line_lower.contains("opengl") {
                (
                    ProblemCategory::RenderingError,
                    Severity::Error,
                    "Rendering Error",
                )
            } else if line_lower.contains("java.lang") {
                (
                    ProblemCategory::JavaIssue,
                    Severity::Error,
                    "Java Exception",
                )
            } else {
                (
                    ProblemCategory::Unknown,
                    Severity::Warning,
                    "Error Detected",
                )
            };

        // Extract mod name if present
        let related_mods = Self::extract_mod_from_line(line);

        DetectedProblem {
            id: format!("live-{}-{}", line_num, uuid::Uuid::new_v4()),
            title: title.to_string(),
            description: Self::truncate_line(line, 200),
            severity,
            category,
            status: ProblemStatus::Detected,
            log_line: Some(line.to_string()),
            line_number: Some(line_num),
            solutions: Vec::new(),
            docs_links: Vec::new(),
            related_mods,
        }
    }

    /// Check if warning is significant enough to report
    fn is_significant_warning(line: &str) -> bool {
        let line_lower = line.to_lowercase();

        // Skip common non-critical warnings
        let skip_patterns = [
            "deprecated",
            "experimental",
            "not found, but",
            "using default",
            "config option",
            "unknown key",
            "outdated",
        ];

        for pattern in skip_patterns {
            if line_lower.contains(pattern) {
                return false;
            }
        }

        // Report significant warnings
        let significant_patterns = [
            "mixin",
            "injection",
            "failed to",
            "could not",
            "unable to",
            "missing",
            "conflict",
            "incompatible",
        ];

        for pattern in significant_patterns {
            if line_lower.contains(pattern) {
                return true;
            }
        }

        false
    }

    /// Extract mod name from log line (uses cached regex for performance)
    fn extract_mod_from_line(line: &str) -> Vec<String> {
        let mut mods = Vec::new();

        // Pattern: [ModName] - использует кешированный regex
        for cap in RE_BRACKET.captures_iter(line) {
            if let Some(m) = cap.get(1) {
                let name = m.as_str().to_lowercase();
                // Filter out common non-mod names
                if !["main", "info", "warn", "error", "debug", "fatal", "trace"]
                    .contains(&name.as_str())
                {
                    mods.push(name);
                }
            }
        }

        // Pattern: at com.modname. - использует кешированный regex
        for cap in RE_AT_PACKAGE.captures_iter(line) {
            if let Some(m) = cap.get(1) {
                mods.push(m.as_str().to_string());
            }
        }

        mods.sort();
        mods.dedup();
        mods
    }

    /// Truncate line for display
    fn truncate_line(line: &str, max_len: usize) -> String {
        if line.len() <= max_len {
            line.to_string()
        } else {
            format!("{}...", &line[..max_len])
        }
    }
}

/// Global monitor instance
static LIVE_MONITOR: std::sync::OnceLock<Mutex<LiveCrashMonitor>> = std::sync::OnceLock::new();

/// Get or create the global monitor
pub fn get_monitor() -> &'static Mutex<LiveCrashMonitor> {
    LIVE_MONITOR.get_or_init(|| Mutex::new(LiveCrashMonitor::new()))
}

// ============================================================================
// Tauri Commands
// ============================================================================

/// Initialize the live crash monitor
#[tauri::command]
pub fn init_live_monitor(app: AppHandle) -> Result<(), String> {
    let mut monitor = get_monitor()
        .lock()
        .map_err(|e| format!("Failed to lock monitor: {}", e))?;
    monitor.init(app)
}

/// Start monitoring an instance's log file
#[tauri::command]
pub fn start_live_monitoring(instance_id: String, log_path: String) -> Result<(), String> {
    let mut monitor = get_monitor()
        .lock()
        .map_err(|e| format!("Failed to lock monitor: {}", e))?;
    monitor.start_monitoring(&instance_id, PathBuf::from(log_path))
}

/// Stop monitoring an instance
#[tauri::command]
pub fn stop_live_monitoring(instance_id: String) -> Result<(), String> {
    let mut monitor = get_monitor()
        .lock()
        .map_err(|e| format!("Failed to lock monitor: {}", e))?;
    monitor.stop_monitoring(&instance_id)
}

/// Check if an instance is being monitored
#[tauri::command]
pub fn is_live_monitoring(instance_id: String) -> bool {
    if let Ok(monitor) = get_monitor().lock() {
        monitor.is_monitoring(&instance_id)
    } else {
        false
    }
}

/// Get list of monitored instances
#[tauri::command]
pub fn get_monitored_instances() -> Vec<String> {
    if let Ok(monitor) = get_monitor().lock() {
        monitor.get_monitored_instances()
    } else {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_mod_from_line() {
        let line = "[Sodium] Error loading chunk at com.sodium.render.ChunkRenderer";
        let mods = LiveCrashMonitor::extract_mod_from_line(line);
        assert!(mods.contains(&"sodium".to_string()));
    }

    #[test]
    fn test_is_significant_warning() {
        assert!(LiveCrashMonitor::is_significant_warning(
            "[WARN] Mixin injection failed"
        ));
        assert!(!LiveCrashMonitor::is_significant_warning(
            "[WARN] Deprecated config option"
        ));
    }

    #[test]
    fn test_truncate_line() {
        let short = "short line";
        assert_eq!(LiveCrashMonitor::truncate_line(short, 20), "short line");

        let long = "this is a very long line that should be truncated";
        assert_eq!(
            LiveCrashMonitor::truncate_line(long, 20),
            "this is a very long ..."
        );
    }

    #[test]
    fn test_quick_analyze_error() {
        let problem =
            LiveCrashMonitor::quick_analyze_error("java.lang.OutOfMemoryError: heap space", 100);
        assert_eq!(problem.category, ProblemCategory::MemoryIssue);
        assert_eq!(problem.severity, Severity::Critical);
    }
}
