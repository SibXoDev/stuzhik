//! Server metrics for debugging and monitoring
//!
//! Provides detailed metrics for modders/modpack creators:
//! - TPS (Ticks Per Second) with history
//! - Memory usage (heap, non-heap)
//! - Player count and list
//! - Entity counts
//! - Chunk loading statistics
//! - World information
//! - Uptime

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};
use std::time::Instant;
use tokio::sync::RwLock;
use tauri::{AppHandle, Emitter};
use sysinfo::{Pid, System, ProcessRefreshKind, RefreshKind};

/// TPS data point
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TpsData {
    /// Timestamp (unix millis)
    pub timestamp: i64,
    /// TPS value (0.0 - 20.0)
    pub tps: f64,
    /// 1 minute average (if available)
    pub tps_1m: Option<f64>,
    /// 5 minute average (if available)
    pub tps_5m: Option<f64>,
    /// 15 minute average (if available)
    pub tps_15m: Option<f64>,
}

/// Memory metrics
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct MemoryMetrics {
    /// Used heap memory in bytes
    pub heap_used: u64,
    /// Max heap memory in bytes
    pub heap_max: u64,
    /// Process RSS (Resident Set Size) in bytes
    pub rss: u64,
    /// Process virtual memory in bytes
    pub virtual_mem: u64,
}

/// Player metrics
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct PlayerMetrics {
    /// Current player count
    pub online: u32,
    /// Max players
    pub max: u32,
    /// Player names
    pub players: Vec<String>,
}

/// World metrics
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct WorldMetrics {
    /// World name
    pub name: String,
    /// Loaded chunks count
    pub loaded_chunks: u32,
    /// Entity count
    pub entity_count: u32,
    /// Tile entity count
    pub tile_entity_count: u32,
    /// World size in bytes (if available)
    pub size_bytes: Option<u64>,
}

/// Dimension metrics (for each dimension)
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct DimensionMetrics {
    /// Dimension name (overworld, nether, end, or modded)
    pub name: String,
    /// Loaded chunks
    pub loaded_chunks: u32,
    /// Entity count
    pub entity_count: u32,
    /// Tile entity count
    pub tile_entity_count: u32,
}

/// Complete server metrics snapshot
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct ServerMetrics {
    /// Timestamp when metrics were collected
    pub timestamp: i64,
    /// Server uptime in seconds
    pub uptime_seconds: u64,
    /// TPS data
    pub tps: Option<TpsData>,
    /// Memory metrics
    pub memory: MemoryMetrics,
    /// Player metrics
    pub players: PlayerMetrics,
    /// World metrics
    pub world: WorldMetrics,
    /// Per-dimension metrics
    pub dimensions: Vec<DimensionMetrics>,
    /// MSPT (Milliseconds Per Tick) if available
    pub mspt: Option<f64>,
    /// CPU usage percentage
    pub cpu_percent: Option<f32>,
}

/// Metrics collector for a server instance
#[derive(Debug)]
pub struct MetricsCollector {
    /// Instance ID
    instance_id: String,
    /// Process ID
    pid: Option<u32>,
    /// Start time
    start_time: Instant,
    /// TPS history (last 60 data points, ~1 minute at 1/sec)
    tps_history: Vec<TpsData>,
    /// Last metrics snapshot
    last_metrics: Option<ServerMetrics>,
    /// System info for process monitoring
    system: System,
}

impl MetricsCollector {
    /// Create new metrics collector
    pub fn new(instance_id: String) -> Self {
        Self {
            instance_id,
            pid: None,
            start_time: Instant::now(),
            tps_history: Vec::with_capacity(60),
            last_metrics: None,
            system: System::new_with_specifics(
                RefreshKind::nothing().with_processes(ProcessRefreshKind::everything())
            ),
        }
    }

    /// Set the server process ID
    pub fn set_pid(&mut self, pid: u32) {
        self.pid = Some(pid);
        self.start_time = Instant::now();
    }

    /// Get uptime in seconds
    pub fn uptime(&self) -> u64 {
        self.start_time.elapsed().as_secs()
    }

    /// Collect metrics from process
    pub fn collect_process_metrics(&mut self) -> MemoryMetrics {
        let mut metrics = MemoryMetrics::default();

        if let Some(pid) = self.pid {
            self.system.refresh_processes_specifics(
                sysinfo::ProcessesToUpdate::Some(&[Pid::from_u32(pid)]),
                false,
                ProcessRefreshKind::nothing().with_memory(),
            );

            if let Some(process) = self.system.process(Pid::from_u32(pid)) {
                metrics.rss = process.memory();
                metrics.virtual_mem = process.virtual_memory();
            }
        }

        metrics
    }

    /// Collect CPU usage
    pub fn collect_cpu_usage(&mut self) -> Option<f32> {
        if let Some(pid) = self.pid {
            self.system.refresh_processes_specifics(
                sysinfo::ProcessesToUpdate::Some(&[Pid::from_u32(pid)]),
                false,
                ProcessRefreshKind::nothing().with_cpu(),
            );

            if let Some(process) = self.system.process(Pid::from_u32(pid)) {
                return Some(process.cpu_usage());
            }
        }
        None
    }

    /// Add TPS data point
    pub fn add_tps(&mut self, tps: TpsData) {
        if self.tps_history.len() >= 60 {
            self.tps_history.remove(0);
        }
        self.tps_history.push(tps);
    }

    /// Get TPS history
    pub fn get_tps_history(&self) -> &[TpsData] {
        &self.tps_history
    }

    /// Get last metrics
    pub fn get_last_metrics(&self) -> Option<&ServerMetrics> {
        self.last_metrics.as_ref()
    }

    /// Update last metrics
    pub fn set_last_metrics(&mut self, metrics: ServerMetrics) {
        self.last_metrics = Some(metrics);
    }
}

/// Global metrics collectors
static COLLECTORS: LazyLock<RwLock<HashMap<String, Arc<RwLock<MetricsCollector>>>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

/// App handle for emitting events
static METRICS_APP_HANDLE: LazyLock<RwLock<Option<AppHandle>>> = LazyLock::new(|| RwLock::new(None));

/// Initialize metrics module
pub fn init(app: &AppHandle) {
    let mut handle = METRICS_APP_HANDLE.blocking_write();
    *handle = Some(app.clone());
}

/// Get or create metrics collector for an instance
pub async fn get_collector(instance_id: &str) -> Arc<RwLock<MetricsCollector>> {
    let mut collectors = COLLECTORS.write().await;

    if let Some(collector) = collectors.get(instance_id) {
        collector.clone()
    } else {
        let collector = Arc::new(RwLock::new(MetricsCollector::new(instance_id.to_string())));
        collectors.insert(instance_id.to_string(), collector.clone());
        collector
    }
}

/// Remove metrics collector
pub async fn remove_collector(instance_id: &str) {
    let mut collectors = COLLECTORS.write().await;
    collectors.remove(instance_id);
}

/// Emit metrics to frontend
pub async fn emit_metrics(instance_id: &str, metrics: &ServerMetrics) {
    if let Some(ref app) = *METRICS_APP_HANDLE.read().await {
        let _ = app.emit(&format!("server-metrics:{}", instance_id), metrics);
    }
}

/// Parse debug output for entity counts (from /debug command or mods)
pub fn parse_debug_output(output: &str) -> Option<(u32, u32)> {
    // Try to find entity and tile entity counts
    // Various formats from different mods/commands
    let mut entities = None;
    let mut tile_entities = None;

    for line in output.lines() {
        let lower = line.to_lowercase();

        if lower.contains("entities") && entities.is_none() {
            // Try to find number before "entities"
            for word in line.split_whitespace() {
                if let Ok(n) = word.trim_matches(|c: char| !c.is_numeric()).parse::<u32>() {
                    entities = Some(n);
                    break;
                }
            }
        }

        if (lower.contains("tile entities") || lower.contains("block entities")) && tile_entities.is_none() {
            for word in line.split_whitespace() {
                if let Ok(n) = word.trim_matches(|c: char| !c.is_numeric()).parse::<u32>() {
                    tile_entities = Some(n);
                    break;
                }
            }
        }
    }

    match (entities, tile_entities) {
        (Some(e), Some(t)) => Some((e, t)),
        _ => None,
    }
}

/// Parse Spark mod output for detailed TPS
pub fn parse_spark_tps(output: &str) -> Option<TpsData> {
    // Spark format: "TPS from last 5s, 10s, 1m, 5m, 15m: *20.0, *20.0, *20.0, *20.0, *20.0"
    let mut tps_values: Vec<f64> = Vec::new();

    // Remove color codes and find numbers
    let clean: String = output
        .chars()
        .filter(|c| c.is_numeric() || *c == '.' || *c == ',' || *c == ' ' || *c == '*')
        .collect();

    for part in clean.split(',') {
        let num_str: String = part.chars().filter(|c| c.is_numeric() || *c == '.').collect();
        if let Ok(tps) = num_str.parse::<f64>() {
            if (0.0..=20.0).contains(&tps) {
                tps_values.push(tps);
            }
        }
    }

    if !tps_values.is_empty() {
        Some(TpsData {
            timestamp: chrono::Utc::now().timestamp_millis(),
            tps: tps_values[0],
            tps_1m: tps_values.get(2).copied(),
            tps_5m: tps_values.get(3).copied(),
            tps_15m: tps_values.get(4).copied(),
        })
    } else {
        None
    }
}

/// Parse memory from Spark or similar output
pub fn parse_memory_output(output: &str) -> Option<(u64, u64)> {
    // Look for patterns like "1234 MB / 4096 MB"
    let mut used = None;
    let mut max = None;

    for line in output.lines() {
        if line.to_lowercase().contains("heap") || line.to_lowercase().contains("memory") {
            let parts: Vec<&str> = line.split('/').collect();
            if parts.len() >= 2 {
                // Parse used
                for word in parts[0].split_whitespace().rev() {
                    if let Ok(n) = word.trim_matches(|c: char| !c.is_numeric()).parse::<u64>() {
                        used = Some(n * 1024 * 1024); // Assume MB
                        break;
                    }
                }
                // Parse max
                for word in parts[1].split_whitespace() {
                    if let Ok(n) = word.trim_matches(|c: char| !c.is_numeric()).parse::<u64>() {
                        max = Some(n * 1024 * 1024); // Assume MB
                        break;
                    }
                }
            }
        }
    }

    match (used, max) {
        (Some(u), Some(m)) => Some((u, m)),
        _ => None,
    }
}

// Tauri commands
#[tauri::command]
pub async fn get_server_metrics(instance_id: String) -> Result<Option<ServerMetrics>, String> {
    let collector = get_collector(&instance_id).await;
    let collector = collector.read().await;

    Ok(collector.get_last_metrics().cloned())
}

#[tauri::command]
pub async fn get_tps_history(instance_id: String) -> Result<Vec<TpsData>, String> {
    let collector = get_collector(&instance_id).await;
    let collector = collector.read().await;

    Ok(collector.get_tps_history().to_vec())
}

#[tauri::command]
pub async fn collect_server_metrics(instance_id: String) -> Result<ServerMetrics, String> {
    let collector = get_collector(&instance_id).await;
    let mut collector = collector.write().await;

    // Collect basic process metrics
    let memory = collector.collect_process_metrics();
    let cpu = collector.collect_cpu_usage();
    let uptime = collector.uptime();

    // Get last TPS
    let tps = collector.get_tps_history().last().cloned();

    let metrics = ServerMetrics {
        timestamp: chrono::Utc::now().timestamp_millis(),
        uptime_seconds: uptime,
        tps,
        memory,
        players: PlayerMetrics::default(),
        world: WorldMetrics::default(),
        dimensions: Vec::new(),
        mspt: None,
        cpu_percent: cpu,
    };

    collector.set_last_metrics(metrics.clone());

    // Emit to frontend
    emit_metrics(&instance_id, &metrics).await;

    Ok(metrics)
}

#[tauri::command]
pub async fn start_metrics_collection(instance_id: String, pid: u32) -> Result<(), String> {
    let collector = get_collector(&instance_id).await;
    let mut collector = collector.write().await;

    collector.set_pid(pid);
    log::info!("Started metrics collection for instance {} with pid {}", instance_id, pid);

    Ok(())
}

#[tauri::command]
pub async fn stop_metrics_collection(instance_id: String) -> Result<(), String> {
    remove_collector(&instance_id).await;
    log::info!("Stopped metrics collection for instance {}", instance_id);

    Ok(())
}
