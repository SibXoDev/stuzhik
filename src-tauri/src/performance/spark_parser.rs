use super::types::{
    GcStats, ImpactCategory, ModPerformance, MsptStats, SparkInfo, SparkReportData, SparkTickEntry,
};
use std::path::{Path, PathBuf};

/// Известные slug'и Spark мода для детекции
const SPARK_SLUGS: &[&str] = &["spark", "spark-forge", "spark-fabric"];

/// Детекция Spark в экземпляре
pub fn detect_spark(instance_path: &Path) -> SparkInfo {
    let mods_dir = instance_path.join("mods");

    if !mods_dir.exists() {
        return SparkInfo {
            detected: false,
            version: None,
            latest_report_path: None,
            latest_report_time: None,
        };
    }

    // Ищем Spark мод по имени файла
    let mut spark_detected = false;
    let mut spark_version = None;

    if let Ok(entries) = std::fs::read_dir(&mods_dir) {
        for entry in entries.flatten() {
            let file_name = entry.file_name().to_string_lossy().to_lowercase();
            if file_name.contains("spark") && file_name.ends_with(".jar") {
                spark_detected = true;
                // Пытаемся извлечь версию из имени файла
                // Формат: spark-1.10.53-fabric.jar или spark-forge-1.10.53.jar
                if let Some(version) = extract_version_from_filename(&file_name) {
                    spark_version = Some(version);
                }
                break;
            }
        }
    }

    // Ищем последний отчёт Spark
    let (latest_report_path, latest_report_time) = find_latest_spark_report(instance_path);

    SparkInfo {
        detected: spark_detected,
        version: spark_version,
        latest_report_path: latest_report_path.map(|p| p.to_string_lossy().to_string()),
        latest_report_time,
    }
}

/// Извлечь версию из имени файла
fn extract_version_from_filename(filename: &str) -> Option<String> {
    // Паттерны: spark-1.10.53-fabric.jar, spark-forge-1.10.53.jar
    let re = regex::Regex::new(r"spark[^0-9]*([0-9]+\.[0-9]+\.[0-9]+)").ok()?;
    re.captures(filename)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
}

/// Найти последний Spark отчёт
fn find_latest_spark_report(instance_path: &Path) -> (Option<PathBuf>, Option<String>) {
    // Spark сохраняет отчёты в:
    // - spark/ директории (если настроено)
    // - .minecraft/spark/ или instance/spark/

    let possible_dirs = [
        instance_path.join("spark"),
        instance_path.join(".minecraft").join("spark"),
    ];

    let mut latest_path: Option<PathBuf> = None;
    let mut latest_time: Option<std::time::SystemTime> = None;

    for dir in &possible_dirs {
        if !dir.exists() {
            continue;
        }

        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();

                // Spark отчёты имеют расширение .sparkprofile или .json
                if let Some(ext) = path.extension() {
                    let ext_str = ext.to_string_lossy().to_lowercase();
                    if ext_str == "sparkprofile" || ext_str == "json" {
                        if let Ok(metadata) = entry.metadata() {
                            if let Ok(modified) = metadata.modified() {
                                if latest_time.is_none() || modified > latest_time.unwrap() {
                                    latest_time = Some(modified);
                                    latest_path = Some(path);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    let time_str = latest_time.map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339());

    (latest_path, time_str)
}

/// Парсинг Spark отчёта
pub fn parse_spark_report(report_path: &Path) -> Result<SparkReportData, String> {
    let content = std::fs::read_to_string(report_path)
        .map_err(|e| format!("Failed to read report: {}", e))?;

    // Spark может выводить в разных форматах
    // Попробуем распарсить как JSON
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
        return parse_spark_json(&json);
    }

    // Если не JSON, пробуем текстовый формат
    parse_spark_text(&content)
}

/// Парсинг Spark JSON отчёта
fn parse_spark_json(json: &serde_json::Value) -> Result<SparkReportData, String> {
    let mut data = SparkReportData {
        tps: None,
        mspt: None,
        tick_data: Vec::new(),
        gc_stats: None,
    };

    // Извлекаем TPS
    if let Some(tps) = json.get("tps").and_then(|v| v.as_f64()) {
        data.tps = Some(tps as f32);
    }

    // Извлекаем MSPT
    if let Some(mspt_obj) = json.get("mspt") {
        data.mspt = Some(MsptStats {
            min: mspt_obj.get("min").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32,
            max: mspt_obj.get("max").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32,
            avg: mspt_obj.get("avg").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32,
            median: mspt_obj
                .get("median")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0) as f32,
        });
    }

    // Извлекаем данные о тиках
    if let Some(ticks) = json.get("ticks").or_else(|| json.get("threads")) {
        if let Some(arr) = ticks.as_array() {
            for entry in arr {
                if let (Some(name), Some(time)) = (
                    entry.get("name").and_then(|v| v.as_str()),
                    entry.get("time").and_then(|v| v.as_f64()),
                ) {
                    let percent = entry.get("percent").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    let count = entry.get("count").and_then(|v| v.as_u64()).unwrap_or(1);

                    data.tick_data.push(SparkTickEntry {
                        name: name.to_string(),
                        time_ms: time as f32,
                        percent: percent as f32,
                        count: count as u32,
                    });
                }
            }
        }
    }

    // Извлекаем GC статистику
    if let Some(gc) = json.get("gc") {
        data.gc_stats = Some(GcStats {
            minor_gc_count: gc.get("minorCount").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
            minor_gc_time_ms: gc.get("minorTime").and_then(|v| v.as_u64()).unwrap_or(0),
            major_gc_count: gc.get("majorCount").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
            major_gc_time_ms: gc.get("majorTime").and_then(|v| v.as_u64()).unwrap_or(0),
        });
    }

    Ok(data)
}

/// Парсинг текстового Spark отчёта
fn parse_spark_text(content: &str) -> Result<SparkReportData, String> {
    let mut data = SparkReportData {
        tps: None,
        mspt: None,
        tick_data: Vec::new(),
        gc_stats: None,
    };

    // Парсим TPS
    // Формат: "TPS from last 5s, 10s, 1m, 5m, 15m: *20.0, *20.0, *20.0, *20.0, *20.0"
    let tps_re = regex::Regex::new(r"TPS[^:]*:\s*\*?([0-9.]+)").ok();
    if let Some(re) = tps_re {
        if let Some(caps) = re.captures(content) {
            if let Some(tps_str) = caps.get(1) {
                if let Ok(tps) = tps_str.as_str().parse::<f32>() {
                    data.tps = Some(tps);
                }
            }
        }
    }

    // Парсим MSPT
    // Формат: "Tick durations (min/avg/max): 12.5/45.2/89.1 ms"
    let mspt_re = regex::Regex::new(r"Tick durations[^:]*:\s*([0-9.]+)/([0-9.]+)/([0-9.]+)").ok();
    if let Some(re) = mspt_re {
        if let Some(caps) = re.captures(content) {
            let min = caps
                .get(1)
                .and_then(|m| m.as_str().parse().ok())
                .unwrap_or(0.0);
            let avg = caps
                .get(2)
                .and_then(|m| m.as_str().parse().ok())
                .unwrap_or(0.0);
            let max = caps
                .get(3)
                .and_then(|m| m.as_str().parse().ok())
                .unwrap_or(0.0);

            data.mspt = Some(MsptStats {
                min,
                max,
                avg,
                median: avg, // Нет медианы в текстовом формате
            });
        }
    }

    // Парсим данные о тиках
    // Формат: "  48.2% 24.1ms   - minecraft:tick" или подобное
    let tick_re = regex::Regex::new(r"^\s*([0-9.]+)%\s+([0-9.]+)ms\s+.*?([a-zA-Z0-9_:]+)\s*$").ok();
    if let Some(re) = tick_re {
        for line in content.lines() {
            if let Some(caps) = re.captures(line) {
                let percent = caps
                    .get(1)
                    .and_then(|m| m.as_str().parse().ok())
                    .unwrap_or(0.0);
                let time = caps
                    .get(2)
                    .and_then(|m| m.as_str().parse().ok())
                    .unwrap_or(0.0);
                let name = caps
                    .get(3)
                    .map(|m| m.as_str().to_string())
                    .unwrap_or_default();

                if !name.is_empty() {
                    data.tick_data.push(SparkTickEntry {
                        name,
                        time_ms: time,
                        percent,
                        count: 1,
                    });
                }
            }
        }
    }

    Ok(data)
}

/// Конвертировать Spark данные в ModPerformance
pub fn spark_to_mod_performance(spark_data: &SparkReportData) -> Vec<ModPerformance> {
    let mut mods: Vec<ModPerformance> = Vec::new();

    // Группируем по mod ID
    let mut mod_stats: std::collections::HashMap<String, (f32, f32, f32, u32)> =
        std::collections::HashMap::new();

    for entry in &spark_data.tick_data {
        // Извлекаем mod ID из имени
        // Форматы: "minecraft:tick", "create:contraption", "mod_id.something"
        let mod_id = extract_mod_id(&entry.name);

        let stats = mod_stats
            .entry(mod_id.clone())
            .or_insert((0.0, 0.0, 0.0, 0));
        stats.0 += entry.time_ms; // Total time
        stats.1 = stats.1.max(entry.time_ms); // Max time
        stats.2 += entry.percent; // Total percent
        stats.3 += entry.count; // Total count
    }

    // Конвертируем в ModPerformance
    for (mod_id, (total_time, max_time, percent, count)) in mod_stats {
        let avg_time = if count > 0 {
            total_time / count as f32
        } else {
            0.0
        };

        let impact_score = calculate_impact_score(avg_time, percent);

        mods.push(ModPerformance {
            mod_id: mod_id.clone(),
            mod_name: prettify_mod_name(&mod_id),
            tick_time_avg_ms: avg_time,
            tick_time_max_ms: max_time,
            tick_percent: percent,
            memory_mb: None,
            impact_score,
            impact_category: ImpactCategory::from_score(impact_score),
        });
    }

    // Сортируем по impact score (убывание)
    mods.sort_by(|a, b| {
        b.impact_score
            .partial_cmp(&a.impact_score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    mods
}

/// Извлечь mod ID из имени в Spark отчёте
fn extract_mod_id(name: &str) -> String {
    // Форматы:
    // "minecraft:tick" -> "minecraft"
    // "create:contraption_tick" -> "create"
    // "mod_id.something.Class" -> "mod_id"
    // "net.minecraft.server.MinecraftServer" -> "minecraft"

    if let Some(colon_pos) = name.find(':') {
        return name[..colon_pos].to_string();
    }

    if name.contains('.') {
        let parts: Vec<&str> = name.split('.').collect();
        // net.minecraft.* -> minecraft
        // com.simibubi.create.* -> create
        if parts.len() >= 2 {
            if parts[0] == "net" && parts[1] == "minecraft" {
                return "minecraft".to_string();
            }
            if parts.len() >= 3 && (parts[0] == "com" || parts[0] == "net" || parts[0] == "org") {
                return parts[2].to_string();
            }
            return parts[0].to_string();
        }
    }

    name.to_string()
}

/// Красивое название мода
fn prettify_mod_name(mod_id: &str) -> String {
    // Простая капитализация
    let name = mod_id.replace('_', " ").replace('-', " ");
    name.split_whitespace()
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                None => String::new(),
                Some(first) => first.to_uppercase().chain(chars).collect(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Расчёт impact score (0-100)
fn calculate_impact_score(avg_time_ms: f32, percent: f32) -> f32 {
    // Комбинированная оценка:
    // - 70% веса от процента времени тика
    // - 30% веса от абсолютного времени (нормализованного к 50ms = 100%)

    let percent_score = percent.min(100.0);
    let time_score = (avg_time_ms / 50.0 * 100.0).min(100.0);

    (percent_score * 0.7 + time_score * 0.3).min(100.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_mod_id() {
        assert_eq!(extract_mod_id("minecraft:tick"), "minecraft");
        assert_eq!(extract_mod_id("create:contraption_tick"), "create");
        assert_eq!(
            extract_mod_id("net.minecraft.server.MinecraftServer"),
            "minecraft"
        );
        assert_eq!(extract_mod_id("com.simibubi.create.AllBlocks"), "create");
        assert_eq!(extract_mod_id("simple_name"), "simple_name");
    }

    #[test]
    fn test_prettify_mod_name() {
        assert_eq!(prettify_mod_name("minecraft"), "Minecraft");
        assert_eq!(prettify_mod_name("create"), "Create");
        assert_eq!(
            prettify_mod_name("applied_energistics_2"),
            "Applied Energistics 2"
        );
    }

    #[test]
    fn test_calculate_impact_score() {
        // 50% времени тика, 25ms avg
        let score = calculate_impact_score(25.0, 50.0);
        assert!(score > 40.0 && score < 60.0);

        // 100% времени, 50ms
        let score = calculate_impact_score(50.0, 100.0);
        assert_eq!(score, 100.0);

        // 0% времени, 0ms
        let score = calculate_impact_score(0.0, 0.0);
        assert_eq!(score, 0.0);
    }

    #[test]
    fn test_extract_version_from_filename() {
        assert_eq!(
            extract_version_from_filename("spark-1.10.53-fabric.jar"),
            Some("1.10.53".to_string())
        );
        assert_eq!(
            extract_version_from_filename("spark-forge-1.10.53.jar"),
            Some("1.10.53".to_string())
        );
    }
}
