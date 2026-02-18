use super::types::{BottleneckCategory, BottleneckSeverity, PerformanceBottleneck};
use regex::Regex;
use std::path::Path;

/// Паттерны для обнаружения проблем производительности в логах
static PERFORMANCE_PATTERNS: std::sync::LazyLock<Vec<PerformancePattern>> = std::sync::LazyLock::new(|| vec![
    // TPS проблемы
    PerformancePattern {
        pattern: Regex::new(r"Can't keep up! Is the server overloaded\? Running (\d+)ms or (\d+) ticks behind").unwrap(),
        category: BottleneckCategory::TickTime,
        severity: BottleneckSeverity::High,
        description_template: "Сервер не успевает: отставание на {1}ms ({2} тиков)",
    },
    PerformancePattern {
        pattern: Regex::new(r"Server is running (\d+) ticks behind").unwrap(),
        category: BottleneckCategory::TickTime,
        severity: BottleneckSeverity::Medium,
        description_template: "Сервер отстаёт на {1} тиков",
    },

    // Проблемы с памятью
    PerformancePattern {
        pattern: Regex::new(r"java\.lang\.OutOfMemoryError").unwrap(),
        category: BottleneckCategory::Memory,
        severity: BottleneckSeverity::Critical,
        description_template: "Критическая нехватка памяти (OutOfMemoryError)",
    },
    PerformancePattern {
        pattern: Regex::new(r"Attempting to allocate (\d+) bytes").unwrap(),
        category: BottleneckCategory::Memory,
        severity: BottleneckSeverity::High,
        description_template: "Попытка выделить {1} байт памяти",
    },
    PerformancePattern {
        pattern: Regex::new(r"GC overhead limit exceeded").unwrap(),
        category: BottleneckCategory::GarbageCollection,
        severity: BottleneckSeverity::Critical,
        description_template: "Превышен лимит времени на сборку мусора",
    },

    // Проблемы с чанками
    PerformancePattern {
        pattern: Regex::new(r"Chunk (\d+), (\d+) took (\d+)ms to generate").unwrap(),
        category: BottleneckCategory::ChunkLoading,
        severity: BottleneckSeverity::Medium,
        description_template: "Чанк ({1}, {2}) генерировался {3}ms",
    },
    PerformancePattern {
        pattern: Regex::new(r"Loading chunk took (\d+)ms").unwrap(),
        category: BottleneckCategory::ChunkLoading,
        severity: BottleneckSeverity::Low,
        description_template: "Загрузка чанка заняла {1}ms",
    },
    PerformancePattern {
        pattern: Regex::new(r"Saving chunks for level '([^']+)' took (\d+)ms").unwrap(),
        category: BottleneckCategory::DiskIO,
        severity: BottleneckSeverity::Medium,
        description_template: "Сохранение чанков '{1}' заняло {2}ms",
    },

    // Проблемы с сетью
    PerformancePattern {
        pattern: Regex::new(r"(Read timed out|Connection timed out)").unwrap(),
        category: BottleneckCategory::NetworkLag,
        severity: BottleneckSeverity::Medium,
        description_template: "Сетевой таймаут: {1}",
    },
    PerformancePattern {
        pattern: Regex::new(r"Player '([^']+)' has been kicked for packet spam").unwrap(),
        category: BottleneckCategory::NetworkLag,
        severity: BottleneckSeverity::Low,
        description_template: "Игрок '{1}' кикнут за спам пакетов",
    },

    // Проблемы с рендерингом
    PerformancePattern {
        pattern: Regex::new(r"Shader compilation took (\d+)ms").unwrap(),
        category: BottleneckCategory::RenderLag,
        severity: BottleneckSeverity::Low,
        description_template: "Компиляция шейдера заняла {1}ms",
    },
    PerformancePattern {
        pattern: Regex::new(r"OpenGL Error: (\d+)").unwrap(),
        category: BottleneckCategory::RenderLag,
        severity: BottleneckSeverity::Medium,
        description_template: "Ошибка OpenGL: {1}",
    },

    // Долгие операции
    PerformancePattern {
        pattern: Regex::new(r"Something is taking too long! '([^']+)' took (\d+)ms").unwrap(),
        category: BottleneckCategory::TickTime,
        severity: BottleneckSeverity::High,
        description_template: "Операция '{1}' заняла {2}ms",
    },
    PerformancePattern {
        pattern: Regex::new(r"Block entity at \(([^)]+)\) took (\d+)ms").unwrap(),
        category: BottleneckCategory::TickTime,
        severity: BottleneckSeverity::Medium,
        description_template: "Block entity на ({1}) обрабатывался {2}ms",
    },

    // Forge/Fabric специфичные
    PerformancePattern {
        pattern: Regex::new(r"\[([^\]]+)\] Took (\d+)ms to process tick").unwrap(),
        category: BottleneckCategory::TickTime,
        severity: BottleneckSeverity::Medium,
        description_template: "[{1}] Обработка тика заняла {2}ms",
    },
]);

struct PerformancePattern {
    pattern: Regex,
    category: BottleneckCategory,
    severity: BottleneckSeverity,
    description_template: &'static str,
}

/// Сканировать лог на проблемы производительности
pub fn scan_log_for_performance_issues(log_path: &Path) -> Vec<PerformanceBottleneck> {
    let content = match std::fs::read_to_string(log_path) {
        Ok(c) => c,
        Err(e) => {
            log::warn!("Failed to read log file {:?}: {}", log_path, e);
            return Vec::new();
        }
    };

    scan_content_for_performance_issues(&content)
}

/// Сканировать содержимое лога на проблемы производительности
pub fn scan_content_for_performance_issues(content: &str) -> Vec<PerformanceBottleneck> {
    let mut bottlenecks = Vec::new();
    let mut seen_descriptions = std::collections::HashSet::new();

    // Ограничиваем последними 10000 строк для производительности
    let lines: Vec<&str> = content.lines().rev().take(10000).collect();

    for line in lines {
        for pattern in PERFORMANCE_PATTERNS.iter() {
            if let Some(caps) = pattern.pattern.captures(line) {
                let description = format_description(pattern.description_template, &caps);

                // Дедупликация
                if seen_descriptions.contains(&description) {
                    continue;
                }
                seen_descriptions.insert(description.clone());

                // Извлекаем mod ID если есть в квадратных скобках
                let mod_id = extract_mod_from_line(line);

                bottlenecks.push(PerformanceBottleneck {
                    category: pattern.category.clone(),
                    description,
                    severity: pattern.severity.clone(),
                    mod_id,
                    metric: extract_metric_from_captures(&caps),
                });

                // Ограничиваем количество проблем
                if bottlenecks.len() >= 50 {
                    break;
                }
            }
        }

        if bottlenecks.len() >= 50 {
            break;
        }
    }

    // Сортируем по серьёзности
    bottlenecks.sort_by(|a, b| b.severity.cmp(&a.severity));

    bottlenecks
}

/// Форматировать description с подстановкой захваченных групп
fn format_description(template: &str, caps: &regex::Captures) -> String {
    let mut result = template.to_string();

    for i in 1..=5 {
        let placeholder = format!("{{{}}}", i);
        if let Some(m) = caps.get(i) {
            result = result.replace(&placeholder, m.as_str());
        }
    }

    result
}

/// Извлечь mod ID из строки лога
fn extract_mod_from_line(line: &str) -> Option<String> {
    // Форматы:
    // [15:30:45] [Server thread/WARN] [create]: Something
    // [create/WARN]: Something

    let re = Regex::new(r"\[([a-z][a-z0-9_-]*)\]").ok()?;

    for caps in re.captures_iter(line) {
        if let Some(m) = caps.get(1) {
            let potential_mod = m.as_str().to_lowercase();
            // Фильтруем известные не-mod теги
            if !is_system_tag(&potential_mod) {
                return Some(potential_mod);
            }
        }
    }

    None
}

/// Проверить, является ли тег системным (не mod)
fn is_system_tag(tag: &str) -> bool {
    const SYSTEM_TAGS: &[&str] = &[
        "main", "server", "client", "render", "worker", "io", "warn", "info", "error", "debug",
        "trace", "fatal", "stdout", "stderr", "thread", "pool", "async", "net", "netty",
    ];

    SYSTEM_TAGS.iter().any(|&t| tag.contains(t))
}

/// Извлечь метрику из захваченных групп (обычно время в ms)
fn extract_metric_from_captures(caps: &regex::Captures) -> Option<String> {
    // Ищем числовое значение с ms
    for i in 1..=5 {
        if let Some(m) = caps.get(i) {
            let value = m.as_str();
            if value.parse::<u64>().is_ok() {
                return Some(format!("{}ms", value));
            }
        }
    }
    None
}

/// Анализ TPS из лога
pub fn extract_tps_from_log(content: &str) -> Option<f32> {
    // Паттерны Spark в чате/логах:
    // "TPS from last 5s, 10s, 1m, 5m, 15m:"
    // "  20.0, 20.0, 20.0, 20.0, 20.0"
    // Или: "[CHAT] TPS: 20.0"
    // Или: "§a20.0§7, §a20.0§7" (с color codes)
    // Spark client/server: /spark tps, /sparkc tps, /sparkclient tps
    // Spark tickmonitor output: "Tick #1234 - 45ms"

    let patterns = [
        // Spark TPS output (first value is current TPS) - список значений
        Regex::new(r"^\s*(\d+\.?\d*),\s*\d+\.?\d*,\s*\d+\.?\d*").ok(),
        // Simple TPS format
        Regex::new(r"(?i)(?:TPS|current tps)[:\s]+(\d+\.?\d*)").ok(),
        // Spark with color codes: TPS: §a20.0 или §a20.0§7
        Regex::new(r"TPS[:\s]*§[a-f0-9](\d+\.?\d*)").ok(),
        // Spark color codes в чате: §a20.0§7,
        Regex::new(r"§[a-f0-9](\d+\.?\d*)§[a-f0-9],").ok(),
        // Server "Can't keep up" implies TPS < 20
        Regex::new(r"Can't keep up.*Running (\d+)ms").ok(),
        // Spark tickmonitor: Tick #1234 - 45ms или took 45ms
        Regex::new(r"(?i)tick\s+(?:#?\d+\s+)?(?:-|took)\s*(\d+\.?\d*)\s*ms").ok(),
        // Spark health output
        Regex::new(r"(?i)server\s+tps[:\s]+(\d+\.?\d*)").ok(),
    ];

    let mut last_tps: Option<f32> = None;

    for line in content.lines().rev().take(2000) {
        // Check if previous line was TPS header
        if line.contains("TPS from last") {
            continue; // Next line will have values
        }

        for pattern in patterns.iter().flatten() {
            if let Some(caps) = pattern.captures(line) {
                if let Some(m) = caps.get(1) {
                    if let Ok(value) = m.as_str().parse::<f32>() {
                        // For "Can't keep up" messages, estimate TPS from ms behind
                        if line.contains("Can't keep up") {
                            // 50ms behind = ~1 tick behind = ~19 TPS
                            let ms_behind = value;
                            let estimated_tps = (20.0 - (ms_behind / 50.0)).max(0.0);
                            last_tps = Some(estimated_tps);
                        } else if line.to_lowercase().contains("tick")
                            && (line.contains("ms") || line.contains("took"))
                        {
                            // Tickmonitor output - calculate TPS from tick time
                            // 50ms per tick = 20 TPS, 100ms = 10 TPS
                            if value > 0.0 {
                                let estimated_tps = (1000.0 / value).min(20.0);
                                last_tps = Some(estimated_tps);
                            }
                        } else if value <= 20.0 && value > 0.0 {
                            last_tps = Some(value);
                        }
                        break;
                    }
                }
            }
        }
        if last_tps.is_some() {
            break;
        }
    }

    last_tps
}

/// Анализ MSPT из лога
pub fn extract_mspt_from_log(content: &str) -> Option<f32> {
    // Паттерны для MSPT:
    // Spark: "MSPT: avg 45.2ms, min 20.1ms, max 102.3ms"
    // Spark: "§7avg §a45.2§7ms"
    // Generic: "Tick time: 48ms" или "tick took 50ms"

    let patterns = [
        // Spark MSPT format
        Regex::new(r"(?i)mspt[:\s]+(?:avg\s+)?(\d+\.?\d*)").ok(),
        // Generic tick time
        Regex::new(r"(?i)(?:tick time|tick took)[:\s]+(\d+\.?\d*)").ok(),
        // Spark color codes: avg §a45.2§7ms
        Regex::new(r"avg\s+§[a-f0-9](\d+\.?\d*)§").ok(),
        // "Something is taking too long" gives tick time
        Regex::new(r"took\s+(\d+)ms").ok(),
    ];

    let mut last_mspt: Option<f32> = None;

    for line in content.lines().rev().take(2000) {
        for pattern in patterns.iter().flatten() {
            if let Some(caps) = pattern.captures(line) {
                if let Some(m) = caps.get(1) {
                    if let Ok(mspt) = m.as_str().parse::<f32>() {
                        // MSPT should be reasonable (< 1000ms)
                        if mspt > 0.0 && mspt < 1000.0 {
                            last_mspt = Some(mspt);
                            break;
                        }
                    }
                }
            }
        }
        if last_mspt.is_some() {
            break;
        }
    }

    last_mspt
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_scan_cant_keep_up() {
        let content = "[15:30:45] [Server thread/WARN]: Can't keep up! Is the server overloaded? Running 2500ms or 50 ticks behind";
        let issues = scan_content_for_performance_issues(content);

        assert!(!issues.is_empty());
        assert_eq!(issues[0].category, BottleneckCategory::TickTime);
        assert_eq!(issues[0].severity, BottleneckSeverity::High);
    }

    #[test]
    fn test_scan_out_of_memory() {
        let content =
            "[15:30:45] [Server thread/ERROR]: java.lang.OutOfMemoryError: Java heap space";
        let issues = scan_content_for_performance_issues(content);

        assert!(!issues.is_empty());
        assert_eq!(issues[0].category, BottleneckCategory::Memory);
        assert_eq!(issues[0].severity, BottleneckSeverity::Critical);
    }

    #[test]
    fn test_extract_mod_from_line() {
        let line = "[15:30:45] [Server thread/WARN] [create]: Block entity processing slow";
        let mod_id = extract_mod_from_line(line);
        assert_eq!(mod_id, Some("create".to_string()));
    }

    #[test]
    fn test_extract_tps() {
        let content = "Some log line\nTPS: 19.5\nAnother line";
        let tps = extract_tps_from_log(content);
        assert_eq!(tps, Some(19.5));
    }

    #[test]
    fn test_is_system_tag() {
        assert!(is_system_tag("main"));
        assert!(is_system_tag("server thread"));
        assert!(!is_system_tag("create"));
        assert!(!is_system_tag("sodium"));
    }
}
