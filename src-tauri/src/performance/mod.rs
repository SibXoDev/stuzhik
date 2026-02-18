//! Performance Profiler Module
//!
//! Мониторинг и анализ производительности Minecraft экземпляров:
//! - Системный мониторинг (RAM, CPU)
//! - Интеграция со Spark для детального анализа
//! - Сканирование логов на проблемы производительности
//! - Рекомендации по оптимизации

mod log_scanner;
mod process_monitor;
pub mod spark;
mod spark_parser;
pub mod types;

pub use spark::StdinMap;

use crate::db;
use crate::error::{LauncherError, Result};
use crate::paths;
use chrono::Utc;
use process_monitor::ProcessMonitor;
use rusqlite::params;
use std::sync::OnceLock;
use types::*;

/// Получить PID экземпляра из БД (надёжнее чем из HashMap, т.к. HashMap освобождается после spawn)
fn get_instance_pid_from_db(instance_id: &str) -> Option<u32> {
    let conn = db::get_db_conn().ok()?;
    let mut stmt = conn
        .prepare("SELECT pid FROM instances WHERE id = ?1 AND pid IS NOT NULL")
        .ok()?;
    stmt.query_row(params![instance_id], |row| row.get::<_, i64>(0))
        .ok()
        .map(|pid| pid as u32)
}

/// Глобальный монитор производительности
static PERFORMANCE_MONITOR: OnceLock<ProcessMonitor> = OnceLock::new();

fn get_monitor() -> &'static ProcessMonitor {
    PERFORMANCE_MONITOR.get_or_init(ProcessMonitor::new)
}

// ============================================================================
// Tauri Commands
// ============================================================================

/// Начать мониторинг производительности экземпляра
#[tauri::command]
pub async fn start_performance_monitoring(
    instance_id: String,
    interval_ms: Option<u64>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    log::info!(
        "[PERF-RUST] start_performance_monitoring called for: {}",
        instance_id
    );

    let interval = interval_ms.unwrap_or(1000);

    // Получаем PID из БД (надёжнее чем из HashMap, т.к. Child удаляется из HashMap при spawn)
    log::info!("[PERF-RUST] Getting PID from DB...");
    let pid = get_instance_pid_from_db(&instance_id).ok_or_else(|| {
        log::error!(
            "[PERF-RUST] Instance {} not found in DB or not running",
            instance_id
        );
        LauncherError::InstanceNotRunning
    })?;

    log::info!("[PERF-RUST] Got PID: {}", pid);

    let result = get_monitor()
        .start_monitoring(&instance_id, pid, app_handle, interval)
        .map_err(|e| {
            log::error!("[PERF-RUST] start_monitoring failed: {}", e);
            LauncherError::InvalidConfig(e)
        });

    log::info!("[PERF-RUST] Result: {:?}", result.is_ok());
    result
}

/// Остановить мониторинг производительности
#[tauri::command]
pub async fn stop_performance_monitoring(instance_id: String) -> Result<Vec<PerformanceSnapshot>> {
    get_monitor()
        .stop_monitoring(&instance_id)
        .map_err(|e| LauncherError::InvalidConfig(e))
}

/// Проверить, активен ли мониторинг
#[tauri::command]
pub fn is_performance_monitoring(instance_id: String) -> bool {
    get_monitor().is_monitoring(&instance_id)
}

/// Получить текущие снимки производительности
#[tauri::command]
pub fn get_performance_snapshots(instance_id: String) -> Option<Vec<PerformanceSnapshot>> {
    get_monitor().get_snapshots(&instance_id)
}

/// Получить список мониторимых экземпляров
#[tauri::command]
pub fn get_monitored_performance_instances() -> Vec<(String, u32)> {
    get_monitor().get_monitored_instances()
}

/// Получить разовый снимок производительности
#[tauri::command]
pub async fn get_performance_snapshot(instance_id: String) -> Result<PerformanceSnapshot> {
    let pid = get_instance_pid_from_db(&instance_id).ok_or(LauncherError::InstanceNotRunning)?;

    process_monitor::get_process_snapshot(pid)
        .ok_or_else(|| LauncherError::InvalidConfig("Failed to get process snapshot".to_string()))
}

/// Обнаружить Spark в экземпляре
#[tauri::command]
pub fn detect_spark(instance_id: String) -> SparkInfo {
    let instance_path = paths::instance_dir(&instance_id);
    spark_parser::detect_spark(&instance_path)
}

/// Парсинг Spark отчёта
#[tauri::command]
pub fn parse_spark_report(report_path: String) -> Result<SparkReportData> {
    let path = std::path::PathBuf::from(report_path);
    spark_parser::parse_spark_report(&path).map_err(|e| LauncherError::InvalidConfig(e))
}

/// Получить производительность модов из Spark
#[tauri::command]
pub fn get_mod_performance_from_spark(instance_id: String) -> Vec<ModPerformance> {
    let instance_path = paths::instance_dir(&instance_id);
    let spark_info = spark_parser::detect_spark(&instance_path);

    // Spark не установлен - возвращаем пустой массив (не ошибка)
    if !spark_info.detected {
        return Vec::new();
    }

    // Нет отчёта - возвращаем пустой массив (пользователь ещё не запускал /spark profiler)
    let Some(report_path) = spark_info.latest_report_path else {
        return Vec::new();
    };

    // Пробуем парсить отчёт, при ошибке возвращаем пустой массив
    match spark_parser::parse_spark_report(&std::path::PathBuf::from(report_path)) {
        Ok(spark_data) => spark_parser::spark_to_mod_performance(&spark_data),
        Err(e) => {
            log::warn!("Failed to parse Spark report: {}", e);
            Vec::new()
        }
    }
}

/// Сканировать логи на проблемы производительности
#[tauri::command]
pub fn scan_logs_for_performance(instance_id: String) -> Vec<PerformanceBottleneck> {
    let instance_path = paths::instance_dir(&instance_id);
    let log_path = instance_path.join("logs").join("latest.log");

    if !log_path.exists() {
        return Vec::new();
    }

    log_scanner::scan_log_for_performance_issues(&log_path)
}

/// Получить полный отчёт о производительности
#[tauri::command]
pub async fn get_performance_report(instance_id: String) -> Result<PerformanceReport> {
    let instance_path = paths::instance_dir(&instance_id);

    // Собираем данные из всех источников
    let mut snapshots = get_monitor()
        .get_snapshots(&instance_id)
        .unwrap_or_default();
    let mut mod_performance = Vec::new();
    let mut bottlenecks = Vec::new();
    let mut data_source = DataSource::SystemOnly;

    // Пробуем получить текущий снимок если нет накопленных
    if snapshots.is_empty() {
        if let Some(pid) = get_instance_pid_from_db(&instance_id) {
            if let Some(snapshot) = process_monitor::get_process_snapshot(pid) {
                snapshots.push(snapshot);
            }
        }
    }

    // Сканируем логи
    let log_path = instance_path.join("logs").join("latest.log");
    if tokio::fs::try_exists(&log_path).await.unwrap_or(false) {
        let log_issues = log_scanner::scan_log_for_performance_issues(&log_path);
        bottlenecks.extend(log_issues);
        data_source = DataSource::SystemAndLogs;

        // Пробуем извлечь TPS/MSPT из логов
        if let Ok(content) = tokio::fs::read_to_string(&log_path).await {
            let tps = log_scanner::extract_tps_from_log(&content);
            let mspt = log_scanner::extract_mspt_from_log(&content);

            // Обновляем последний снимок с TPS/MSPT
            if let Some(last_snapshot) = snapshots.last_mut() {
                if tps.is_some() {
                    last_snapshot.tps = tps;
                }
                if mspt.is_some() {
                    last_snapshot.mspt = mspt;
                }
            }
        }
    }

    // Пробуем Spark
    let spark_info = spark_parser::detect_spark(&instance_path);
    if spark_info.detected {
        if let Some(ref report_path) = spark_info.latest_report_path {
            if let Ok(spark_data) =
                spark_parser::parse_spark_report(&std::path::PathBuf::from(report_path))
            {
                mod_performance = spark_parser::spark_to_mod_performance(&spark_data);
                data_source = DataSource::SparkReport;

                // Обновляем TPS/MSPT из Spark
                if let Some(last_snapshot) = snapshots.last_mut() {
                    if spark_data.tps.is_some() {
                        last_snapshot.tps = spark_data.tps;
                    }
                    if let Some(ref mspt_stats) = spark_data.mspt {
                        last_snapshot.mspt = Some(mspt_stats.avg);
                    }
                }
            }
        }
    }

    // Генерируем рекомендации
    let recommendations =
        generate_recommendations(&snapshots, &mod_performance, &bottlenecks, &instance_id)?;

    // Рассчитываем общую оценку
    let overall_score = calculate_overall_score(&snapshots, &bottlenecks);

    Ok(PerformanceReport {
        instance_id: instance_id.clone(),
        created_at: Utc::now().to_rfc3339(),
        monitoring_duration_sec: calculate_duration(&snapshots),
        snapshots,
        mod_performance,
        bottlenecks,
        recommendations,
        overall_score,
        data_source,
        spark_detected: spark_info.detected,
    })
}

/// Получить рекомендации по оптимизации
#[tauri::command]
pub async fn get_performance_recommendations(
    instance_id: String,
) -> Result<Vec<PerformanceRecommendation>> {
    let report = get_performance_report(instance_id).await?;
    Ok(report.recommendations)
}

// ============================================================================
// Helper Functions
// ============================================================================

/// Генерация рекомендаций
fn generate_recommendations(
    snapshots: &[PerformanceSnapshot],
    mod_performance: &[ModPerformance],
    bottlenecks: &[PerformanceBottleneck],
    instance_id: &str,
) -> Result<Vec<PerformanceRecommendation>> {
    let mut recommendations = Vec::new();

    // Анализ памяти
    if let Some(avg_memory) = calculate_avg_memory(snapshots) {
        let max_memory = get_instance_max_memory(instance_id)?;

        // Если используется > 85% выделенной памяти
        if max_memory > 0 && (avg_memory as f64 / max_memory as f64) > 0.85 {
            let recommended = ((max_memory as f64 * 1.5) as u32).min(16384);
            recommendations.push(PerformanceRecommendation {
                title: "Увеличить выделенную память".to_string(),
                description: format!(
                    "Minecraft использует {}% выделенной памяти. Рекомендуется увеличить до {} MB",
                    ((avg_memory as f64 / max_memory as f64) * 100.0) as u32,
                    recommended
                ),
                action: RecommendedAction::IncreaseMemory {
                    current_mb: max_memory,
                    recommended_mb: recommended,
                },
                expected_impact: "High".to_string(),
                priority: 9,
            });
        }
    }

    // Анализ модов с высоким impact
    for mod_perf in mod_performance {
        if mod_perf.impact_category == ImpactCategory::Critical {
            recommendations.push(PerformanceRecommendation {
                title: format!("Мод {} сильно влияет на производительность", mod_perf.mod_name),
                description: format!(
                    "Мод занимает {:.1}% времени тика (avg {:.1}ms). Рассмотрите отключение или замену",
                    mod_perf.tick_percent,
                    mod_perf.tick_time_avg_ms
                ),
                action: RecommendedAction::DisableMod {
                    mod_id: mod_perf.mod_id.clone(),
                    reason: format!(
                        "Impact score: {:.0}, занимает {:.1}% времени тика",
                        mod_perf.impact_score,
                        mod_perf.tick_percent
                    ),
                },
                expected_impact: "High".to_string(),
                priority: 8,
            });
        } else if mod_perf.impact_category == ImpactCategory::High {
            recommendations.push(PerformanceRecommendation {
                title: format!("Оптимизировать настройки {}", mod_perf.mod_name),
                description: format!(
                    "Мод занимает {:.1}% времени тика. Проверьте настройки мода",
                    mod_perf.tick_percent
                ),
                action: RecommendedAction::ChangeSetting {
                    setting_name: format!("{} settings", mod_perf.mod_name),
                    current_value: "default".to_string(),
                    recommended_value: "optimized".to_string(),
                    file_path: None,
                },
                expected_impact: "Medium".to_string(),
                priority: 6,
            });
        }
    }

    // Рекомендации на основе bottlenecks
    for bottleneck in bottlenecks {
        match (&bottleneck.category, &bottleneck.severity) {
            (BottleneckCategory::Memory, BottleneckSeverity::Critical) => {
                recommendations.push(PerformanceRecommendation {
                    title: "Критическая нехватка памяти".to_string(),
                    description: "Обнаружен OutOfMemoryError. Срочно увеличьте выделенную память"
                        .to_string(),
                    action: RecommendedAction::IncreaseMemory {
                        current_mb: get_instance_max_memory(instance_id).unwrap_or(2048),
                        recommended_mb: 6144,
                    },
                    expected_impact: "Critical".to_string(),
                    priority: 10,
                });
            }
            (BottleneckCategory::GarbageCollection, _) => {
                recommendations.push(PerformanceRecommendation {
                    title: "Проблемы со сборкой мусора".to_string(),
                    description: "Рассмотрите добавление JVM аргументов для оптимизации GC"
                        .to_string(),
                    action: RecommendedAction::AddJvmArgument {
                        argument: "-XX:+UseG1GC -XX:MaxGCPauseMillis=50".to_string(),
                        reason: "Улучшает производительность сборки мусора".to_string(),
                    },
                    expected_impact: "Medium".to_string(),
                    priority: 7,
                });
            }
            _ => {}
        }
    }

    // Рекомендация Spark если не установлен
    let instance_path = paths::instance_dir(instance_id);
    let spark_info = spark_parser::detect_spark(&instance_path);
    if !spark_info.detected && !mod_performance.is_empty() {
        recommendations.push(PerformanceRecommendation {
            title: "Установить Spark для детального анализа".to_string(),
            description: "Spark позволяет анализировать производительность каждого мода"
                .to_string(),
            action: RecommendedAction::InstallOptimizationMod {
                mod_id: "spark".to_string(),
                mod_name: "Spark".to_string(),
                description: "Профайлер производительности для Minecraft".to_string(),
            },
            expected_impact: "Low".to_string(),
            priority: 3,
        });
    }

    // Сортируем по приоритету
    recommendations.sort_by(|a, b| b.priority.cmp(&a.priority));

    Ok(recommendations)
}

/// Рассчитать общую оценку (0-100)
fn calculate_overall_score(
    snapshots: &[PerformanceSnapshot],
    bottlenecks: &[PerformanceBottleneck],
) -> f32 {
    let mut score = 100.0f32;

    // Штрафы за TPS
    if let Some(snapshot) = snapshots.last() {
        if let Some(tps) = snapshot.tps {
            if tps < 20.0 {
                score -= (20.0 - tps) * 3.0; // -3 балла за каждый потерянный TPS
            }
        }

        // Штрафы за MSPT
        if let Some(mspt) = snapshot.mspt {
            if mspt > 50.0 {
                score -= (mspt - 50.0) * 0.5; // -0.5 балла за каждый ms выше 50
            }
        }
    }

    // Штрафы за bottlenecks
    for bottleneck in bottlenecks {
        match bottleneck.severity {
            BottleneckSeverity::Critical => score -= 20.0,
            BottleneckSeverity::High => score -= 10.0,
            BottleneckSeverity::Medium => score -= 5.0,
            BottleneckSeverity::Low => score -= 2.0,
        }
    }

    score.max(0.0).min(100.0)
}

/// Получить среднее использование памяти
fn calculate_avg_memory(snapshots: &[PerformanceSnapshot]) -> Option<u64> {
    if snapshots.is_empty() {
        return None;
    }

    let sum: u64 = snapshots.iter().map(|s| s.memory_used_mb).sum();
    Some(sum / snapshots.len() as u64)
}

/// Получить максимальную память экземпляра
fn get_instance_max_memory(instance_id: &str) -> Result<u32> {
    let conn = db::get_db_conn()?;
    let mut stmt = conn.prepare("SELECT memory_max FROM instances WHERE id = ?1")?;

    let memory: u32 = stmt
        .query_row([instance_id], |row| row.get(0))
        .unwrap_or(2048);

    Ok(memory)
}

/// Рассчитать длительность мониторинга
fn calculate_duration(snapshots: &[PerformanceSnapshot]) -> u64 {
    if snapshots.len() < 2 {
        return 0;
    }

    let first = &snapshots[0];
    let last = &snapshots[snapshots.len() - 1];

    // Парсим timestamps
    let first_time = chrono::DateTime::parse_from_rfc3339(&first.timestamp).ok();
    let last_time = chrono::DateTime::parse_from_rfc3339(&last.timestamp).ok();

    match (first_time, last_time) {
        (Some(f), Some(l)) => (l - f).num_seconds().max(0) as u64,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_calculate_overall_score() {
        // Идеальные условия
        let snapshots = vec![PerformanceSnapshot {
            timestamp: Utc::now().to_rfc3339(),
            memory_used_mb: 2048,
            memory_max_mb: Some(4096),
            cpu_percent: 50.0,
            cpu_cores: 12,
            physical_cores: 6,
            cpu_per_core: vec![50.0; 12],
            tps: Some(20.0),
            mspt: Some(45.0),
        }];

        let score = calculate_overall_score(&snapshots, &[]);
        assert!(score > 90.0);
    }

    #[test]
    fn test_calculate_avg_memory() {
        let snapshots = vec![
            PerformanceSnapshot {
                timestamp: "".to_string(),
                memory_used_mb: 1000,
                memory_max_mb: None,
                cpu_percent: 0.0,
                cpu_cores: 12,
                physical_cores: 6,
                cpu_per_core: vec![0.0; 12],
                tps: None,
                mspt: None,
            },
            PerformanceSnapshot {
                timestamp: "".to_string(),
                memory_used_mb: 2000,
                memory_max_mb: None,
                cpu_percent: 0.0,
                cpu_cores: 12,
                physical_cores: 6,
                cpu_per_core: vec![0.0; 12],
                tps: None,
                mspt: None,
            },
        ];

        assert_eq!(calculate_avg_memory(&snapshots), Some(1500));
    }
}
