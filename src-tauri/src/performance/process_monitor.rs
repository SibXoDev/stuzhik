use super::types::{
    BottleneckCategory, BottleneckSeverity, PerformanceBottleneck, PerformanceEvent,
    PerformanceSnapshot,
};
use chrono::Utc;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use sysinfo::{CpuRefreshKind, Pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System};
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;

/// Состояние мониторинга для одного экземпляра
struct MonitorState {
    instance_id: String,
    pid: u32,
    snapshots: Vec<PerformanceSnapshot>,
    started_at: chrono::DateTime<Utc>,
    stop_signal: watch::Sender<bool>,
}

/// Глобальное состояние мониторинга
pub struct ProcessMonitor {
    monitors: Arc<Mutex<HashMap<String, MonitorState>>>,
}

impl Default for ProcessMonitor {
    fn default() -> Self {
        Self::new()
    }
}

impl ProcessMonitor {
    pub fn new() -> Self {
        Self {
            monitors: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Начать мониторинг процесса
    pub fn start_monitoring(
        &self,
        instance_id: &str,
        pid: u32,
        app_handle: AppHandle,
        interval_ms: u64,
    ) -> Result<(), String> {
        let mut monitors = self
            .monitors
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;

        // Проверяем, не мониторим ли уже
        if monitors.contains_key(instance_id) {
            return Err(format!("Already monitoring instance: {}", instance_id));
        }

        let (stop_tx, stop_rx) = watch::channel(false);

        let state = MonitorState {
            instance_id: instance_id.to_string(),
            pid,
            snapshots: Vec::new(),
            started_at: Utc::now(),
            stop_signal: stop_tx,
        };

        monitors.insert(instance_id.to_string(), state);

        // Emit started event
        let _ = app_handle.emit(
            "performance-event",
            PerformanceEvent::Started {
                instance_id: instance_id.to_string(),
                pid,
            },
        );

        // Запускаем мониторинг в фоне
        let monitors_clone = Arc::clone(&self.monitors);
        let instance_id_clone = instance_id.to_string();

        tauri::async_runtime::spawn(async move {
            Self::monitoring_loop(
                monitors_clone,
                instance_id_clone,
                pid,
                app_handle,
                stop_rx,
                interval_ms,
            )
            .await;
        });

        log::info!(
            "Started performance monitoring for instance {} (PID: {})",
            instance_id,
            pid
        );
        Ok(())
    }

    /// Остановить мониторинг
    pub fn stop_monitoring(&self, instance_id: &str) -> Result<Vec<PerformanceSnapshot>, String> {
        let mut monitors = self
            .monitors
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;

        if let Some(state) = monitors.remove(instance_id) {
            // Отправляем сигнал остановки
            let _ = state.stop_signal.send(true);
            log::info!(
                "Stopped performance monitoring for instance {}",
                instance_id
            );
            Ok(state.snapshots)
        } else {
            Err(format!("Not monitoring instance: {}", instance_id))
        }
    }

    /// Проверить, активен ли мониторинг
    pub fn is_monitoring(&self, instance_id: &str) -> bool {
        self.monitors
            .lock()
            .map(|m| m.contains_key(instance_id))
            .unwrap_or(false)
    }

    /// Получить текущие снимки
    pub fn get_snapshots(&self, instance_id: &str) -> Option<Vec<PerformanceSnapshot>> {
        self.monitors
            .lock()
            .ok()
            .and_then(|m| m.get(instance_id).map(|s| s.snapshots.clone()))
    }

    /// Получить список мониторимых экземпляров
    pub fn get_monitored_instances(&self) -> Vec<(String, u32)> {
        self.monitors
            .lock()
            .map(|m| m.values().map(|s| (s.instance_id.clone(), s.pid)).collect())
            .unwrap_or_default()
    }

    /// Основной цикл мониторинга
    async fn monitoring_loop(
        monitors: Arc<Mutex<HashMap<String, MonitorState>>>,
        instance_id: String,
        pid: u32,
        app_handle: AppHandle,
        mut stop_rx: watch::Receiver<bool>,
        interval_ms: u64,
    ) {
        let mut sys = System::new_with_specifics(
            RefreshKind::nothing()
                .with_cpu(CpuRefreshKind::everything())
                .with_memory(sysinfo::MemoryRefreshKind::everything()),
        );
        let sysinfo_pid = Pid::from_u32(pid);
        let mut last_cpu_time: Option<u64> = None;
        let mut last_check_time = std::time::Instant::now();

        // Получаем количество ядер CPU один раз
        sys.refresh_cpu_all();
        let cpu_cores = sys.cpus().len() as u32;
        let physical_cores = System::physical_core_count().unwrap_or(cpu_cores as usize) as u32;

        // Предупреждения о проблемах (избегаем спама)
        let mut warned_high_memory = false;
        let mut warned_high_cpu = false;

        loop {
            // Проверяем сигнал остановки
            if *stop_rx.borrow() {
                break;
            }

            // Ждём интервал или сигнал остановки
            tokio::select! {
                _ = tokio::time::sleep(tokio::time::Duration::from_millis(interval_ms)) => {}
                _ = stop_rx.changed() => {
                    if *stop_rx.borrow() {
                        break;
                    }
                }
            }

            // Обновляем информацию о процессе и CPU
            sys.refresh_processes_specifics(
                ProcessesToUpdate::Some(&[sysinfo_pid]),
                true,
                ProcessRefreshKind::everything(),
            );
            sys.refresh_cpu_all();

            let Some(process) = sys.process(sysinfo_pid) else {
                // Процесс завершился
                log::info!("Process {} no longer exists, stopping monitoring", pid);
                let _ = app_handle.emit(
                    "performance-event",
                    PerformanceEvent::Stopped {
                        instance_id: instance_id.clone(),
                    },
                );
                break;
            };

            // Собираем метрики
            let memory_mb = process.memory() / 1024 / 1024;

            // CPU usage calculation
            // sysinfo возвращает сумму по всем ядрам, нормализуем до 0-100%
            let now = std::time::Instant::now();
            let elapsed = now.duration_since(last_check_time).as_secs_f32();
            last_check_time = now;

            let cpu_raw = process.cpu_usage();
            let cpu_percent = if let Some(_last) = last_cpu_time {
                // Нормализуем: делим на количество ядер
                (cpu_raw / cpu_cores as f32).min(100.0)
            } else {
                0.0
            };
            last_cpu_time = Some(cpu_raw as u64);

            // Собираем загрузку по каждому ядру (системную, не только процесса)
            let cpu_per_core: Vec<f32> = sys.cpus().iter().map(|cpu| cpu.cpu_usage()).collect();

            let snapshot = PerformanceSnapshot {
                timestamp: Utc::now().to_rfc3339(),
                memory_used_mb: memory_mb,
                memory_max_mb: None, // Будет заполнено из JVM если доступно
                cpu_percent,
                cpu_cores,
                physical_cores,
                cpu_per_core,
                tps: None, // Будет заполнено из логов/Spark
                mspt: None,
            };

            // Сохраняем снимок
            if let Ok(mut monitors_guard) = monitors.lock() {
                if let Some(state) = monitors_guard.get_mut(&instance_id) {
                    state.snapshots.push(snapshot.clone());

                    // Ограничиваем историю (последние 1000 снимков)
                    if state.snapshots.len() > 1000 {
                        state.snapshots.remove(0);
                    }
                }
            }

            // Emit snapshot event
            let _ = app_handle.emit(
                "performance-event",
                PerformanceEvent::Snapshot {
                    instance_id: instance_id.clone(),
                    snapshot: snapshot.clone(),
                },
            );

            // Проверяем на проблемы
            let mut bottlenecks = Vec::new();

            // Высокое потребление памяти (> 90% от системной)
            sys.refresh_memory();
            let total_memory_mb = sys.total_memory() / 1024 / 1024;
            let memory_percent = (memory_mb as f64 / total_memory_mb as f64) * 100.0;

            if memory_percent > 85.0 && !warned_high_memory {
                warned_high_memory = true;
                bottlenecks.push(PerformanceBottleneck {
                    category: BottleneckCategory::Memory,
                    description: format!(
                        "Minecraft использует {}% системной памяти ({} MB из {} MB)",
                        memory_percent as u32, memory_mb, total_memory_mb
                    ),
                    severity: if memory_percent > 95.0 {
                        BottleneckSeverity::Critical
                    } else {
                        BottleneckSeverity::High
                    },
                    mod_id: None,
                    metric: Some(format!("{} MB", memory_mb)),
                });
            } else if memory_percent < 80.0 {
                warned_high_memory = false; // Сброс предупреждения
            }

            // Высокая загрузка CPU (> 90%)
            if cpu_percent > 90.0 && !warned_high_cpu && elapsed > 0.5 {
                warned_high_cpu = true;
                bottlenecks.push(PerformanceBottleneck {
                    category: BottleneckCategory::TickTime,
                    description: format!("Высокая загрузка CPU: {:.1}%", cpu_percent),
                    severity: if cpu_percent > 98.0 {
                        BottleneckSeverity::Critical
                    } else {
                        BottleneckSeverity::High
                    },
                    mod_id: None,
                    metric: Some(format!("{:.1}%", cpu_percent)),
                });
            } else if cpu_percent < 85.0 {
                warned_high_cpu = false;
            }

            // Emit bottleneck events
            for bottleneck in bottlenecks {
                let _ = app_handle.emit(
                    "performance-event",
                    PerformanceEvent::BottleneckDetected {
                        instance_id: instance_id.clone(),
                        bottleneck,
                    },
                );
            }
        }

        // Удаляем из списка мониторимых
        if let Ok(mut monitors_guard) = monitors.lock() {
            monitors_guard.remove(&instance_id);
        }

        log::info!("Monitoring loop ended for instance {}", instance_id);
    }
}

/// Получить текущую информацию о процессе (разовый снимок)
pub fn get_process_snapshot(pid: u32) -> Option<PerformanceSnapshot> {
    let mut sys = System::new_with_specifics(
        RefreshKind::nothing()
            .with_cpu(CpuRefreshKind::everything())
            .with_memory(sysinfo::MemoryRefreshKind::everything()),
    );
    let sysinfo_pid = Pid::from_u32(pid);

    sys.refresh_cpu_all();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[sysinfo_pid]),
        true,
        ProcessRefreshKind::everything(),
    );

    let process = sys.process(sysinfo_pid)?;
    let cpu_cores = sys.cpus().len() as u32;
    let physical_cores = System::physical_core_count().unwrap_or(cpu_cores as usize) as u32;

    // Нормализуем CPU до 0-100%
    let cpu_raw = process.cpu_usage();
    let cpu_percent = (cpu_raw / cpu_cores as f32).min(100.0);

    // Загрузка по ядрам
    let cpu_per_core: Vec<f32> = sys.cpus().iter().map(|cpu| cpu.cpu_usage()).collect();

    Some(PerformanceSnapshot {
        timestamp: Utc::now().to_rfc3339(),
        memory_used_mb: process.memory() / 1024 / 1024,
        memory_max_mb: None,
        cpu_percent,
        cpu_cores,
        physical_cores,
        cpu_per_core,
        tps: None,
        mspt: None,
    })
}

/// Получить PID запущенного экземпляра
pub fn get_instance_pid(
    children: &std::sync::MutexGuard<'_, std::collections::HashMap<String, std::process::Child>>,
    instance_id: &str,
) -> Option<u32> {
    children.get(instance_id).map(|c| c.id())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_process_monitor_new() {
        let monitor = ProcessMonitor::new();
        assert!(!monitor.is_monitoring("test"));
        assert!(monitor.get_monitored_instances().is_empty());
    }
}
