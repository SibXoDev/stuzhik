//! Crash History Module
//!
//! Stores and analyzes crash history for instances.
//! Provides statistics and trends for problematic mods.

use chrono::{DateTime, Duration, Utc};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use stuzhik_core::DetectedProblem;
use stuzhik_db::get_db_conn;
use uuid::Uuid;

/// A single crash record in history
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrashRecord {
    /// Unique ID
    pub id: String,

    /// Instance ID
    pub instance_id: String,

    /// When the crash occurred
    pub crash_time: String,

    /// Type of log analyzed (crash/latest)
    pub log_type: String,

    /// Problems detected in this crash
    pub problems: Vec<DetectedProblem>,

    /// Suspected mods (extracted from problems)
    pub suspected_mods: Vec<String>,

    /// Minecraft version
    pub minecraft_version: Option<String>,

    /// Loader type (forge/fabric/etc)
    pub loader_type: Option<String>,

    /// Loader version
    pub loader_version: Option<String>,

    /// Whether this crash was fixed
    pub was_fixed: bool,

    /// Method used to fix (if fixed)
    pub fix_method: Option<String>,

    /// User notes
    pub notes: Option<String>,

    /// When record was created
    pub created_at: String,
}

/// Statistics about crashes for an instance
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrashStatistics {
    /// Total number of crashes recorded
    pub total_crashes: u32,

    /// Crashes in the last 7 days
    pub crashes_last_week: u32,

    /// Crashes in the last 24 hours
    pub crashes_last_day: u32,

    /// Most problematic mod (appears most often in crashes)
    pub most_problematic_mod: Option<ModCrashStats>,

    /// Top 5 problematic mods
    pub top_problematic_mods: Vec<ModCrashStats>,

    /// Average time between crashes (in hours)
    pub avg_hours_between_crashes: Option<f64>,

    /// Fix success rate (percentage)
    pub fix_success_rate: f32,

    /// Most common crash category
    pub most_common_category: Option<String>,

    /// Crash frequency trend
    pub trend: CrashTrendDirection,
}

/// Statistics for a single mod
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModCrashStats {
    /// Mod ID/name
    pub mod_id: String,

    /// Number of crashes involving this mod
    pub crash_count: u32,

    /// Percentage of total crashes
    pub crash_percentage: f32,

    /// Last crash time involving this mod
    pub last_crash: Option<String>,

    /// Was this mod ever fixed (removed/updated)?
    pub was_fixed: bool,
}

/// Trend information for crashes
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrashTrend {
    /// Mod ID
    pub mod_id: String,

    /// Crash count per period (last 7 days, day by day)
    pub daily_crashes: Vec<DailyCrashCount>,

    /// Trend direction
    pub trend: CrashTrendDirection,

    /// Recommendation based on trend
    pub recommendation: String,
}

/// Daily crash count for trends
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailyCrashCount {
    /// Date (YYYY-MM-DD)
    pub date: String,

    /// Number of crashes
    pub count: u32,
}

/// Trend direction
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CrashTrendDirection {
    /// Getting worse (more crashes)
    Worsening,
    /// Staying about the same
    Stable,
    /// Getting better (fewer crashes)
    Improving,
    /// Not enough data
    Unknown,
}

impl Default for CrashTrendDirection {
    fn default() -> Self {
        Self::Unknown
    }
}

/// Save a crash record to history
pub fn save_crash_record(
    instance_id: &str,
    log_type: &str,
    problems: &[DetectedProblem],
    minecraft_version: Option<&str>,
    loader_type: Option<&str>,
    loader_version: Option<&str>,
) -> Result<CrashRecord, String> {
    let conn = get_db_conn().map_err(|e| format!("Database error: {}", e))?;

    let id = Uuid::new_v4().to_string();
    let crash_time = Utc::now().to_rfc3339();

    // Extract suspected mods from problems
    let suspected_mods: Vec<String> = problems
        .iter()
        .flat_map(|p| p.related_mods.clone())
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();

    let problems_json =
        serde_json::to_string(problems).map_err(|e| format!("JSON error: {}", e))?;

    let suspected_mods_json =
        serde_json::to_string(&suspected_mods).map_err(|e| format!("JSON error: {}", e))?;

    conn.execute(
        r#"
        INSERT INTO crash_history (
            id, instance_id, crash_time, log_type, problems_json,
            suspected_mods, minecraft_version, loader_type, loader_version
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        "#,
        params![
            id,
            instance_id,
            crash_time,
            log_type,
            problems_json,
            suspected_mods_json,
            minecraft_version,
            loader_type,
            loader_version,
        ],
    )
    .map_err(|e| format!("Failed to save crash record: {}", e))?;

    log::info!(
        "Saved crash record {} for instance {} with {} problems",
        id,
        instance_id,
        problems.len()
    );

    Ok(CrashRecord {
        id,
        instance_id: instance_id.to_string(),
        crash_time: crash_time.clone(),
        log_type: log_type.to_string(),
        problems: problems.to_vec(),
        suspected_mods,
        minecraft_version: minecraft_version.map(String::from),
        loader_type: loader_type.map(String::from),
        loader_version: loader_version.map(String::from),
        was_fixed: false,
        fix_method: None,
        notes: None,
        created_at: crash_time,
    })
}

/// Get crash history for an instance
pub fn get_crash_history(
    instance_id: &str,
    limit: Option<u32>,
) -> Result<Vec<CrashRecord>, String> {
    let conn = get_db_conn().map_err(|e| format!("Database error: {}", e))?;

    let limit = limit.unwrap_or(100);

    let mut stmt = conn
        .prepare(
            r#"
            SELECT id, instance_id, crash_time, log_type, problems_json,
                   suspected_mods, minecraft_version, loader_type, loader_version,
                   was_fixed, fix_method, notes, created_at
            FROM crash_history
            WHERE instance_id = ?1
            ORDER BY crash_time DESC
            LIMIT ?2
            "#,
        )
        .map_err(|e| format!("Query error: {}", e))?;

    let records = stmt
        .query_map(params![instance_id, limit], |row| {
            let problems_json: String = row.get(4)?;
            let suspected_mods_json: Option<String> = row.get(5)?;

            let problems: Vec<DetectedProblem> =
                serde_json::from_str(&problems_json).unwrap_or_default();
            let suspected_mods: Vec<String> = suspected_mods_json
                .and_then(|j| serde_json::from_str(&j).ok())
                .unwrap_or_default();

            Ok(CrashRecord {
                id: row.get(0)?,
                instance_id: row.get(1)?,
                crash_time: row.get(2)?,
                log_type: row.get(3)?,
                problems,
                suspected_mods,
                minecraft_version: row.get(6)?,
                loader_type: row.get(7)?,
                loader_version: row.get(8)?,
                was_fixed: row.get::<_, i32>(9)? != 0,
                fix_method: row.get(10)?,
                notes: row.get(11)?,
                created_at: row.get(12)?,
            })
        })
        .map_err(|e| format!("Query error: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(records)
}

/// Get crash statistics for an instance
pub fn get_crash_statistics(instance_id: &str) -> Result<CrashStatistics, String> {
    let _conn = get_db_conn().map_err(|e| format!("Database error: {}", e))?;

    // Get all crash records
    let records = get_crash_history(instance_id, Some(1000))?;

    if records.is_empty() {
        return Ok(CrashStatistics {
            total_crashes: 0,
            crashes_last_week: 0,
            crashes_last_day: 0,
            most_problematic_mod: None,
            top_problematic_mods: vec![],
            avg_hours_between_crashes: None,
            fix_success_rate: 0.0,
            most_common_category: None,
            trend: CrashTrendDirection::Unknown,
        });
    }

    let now = Utc::now();
    let week_ago = now - Duration::days(7);
    let day_ago = now - Duration::days(1);

    // Count crashes by time period
    let mut crashes_last_week = 0u32;
    let mut crashes_last_day = 0u32;
    let mut fixed_count = 0u32;

    // Count mods involved in crashes
    let mut mod_crash_counts: HashMap<String, u32> = HashMap::new();
    let mut mod_last_crash: HashMap<String, String> = HashMap::new();

    // Count categories
    let mut category_counts: HashMap<String, u32> = HashMap::new();

    // Collect crash times for average calculation
    let mut crash_times: Vec<DateTime<Utc>> = vec![];

    for record in &records {
        // Parse crash time
        if let Ok(crash_time) = DateTime::parse_from_rfc3339(&record.crash_time) {
            let crash_time = crash_time.with_timezone(&Utc);
            crash_times.push(crash_time);

            if crash_time > week_ago {
                crashes_last_week += 1;
            }
            if crash_time > day_ago {
                crashes_last_day += 1;
            }
        }

        if record.was_fixed {
            fixed_count += 1;
        }

        // Count mods
        for mod_id in &record.suspected_mods {
            *mod_crash_counts.entry(mod_id.clone()).or_insert(0) += 1;
            mod_last_crash.insert(mod_id.clone(), record.crash_time.clone());
        }

        // Count categories from problems
        for problem in &record.problems {
            let category = format!("{:?}", problem.category);
            *category_counts.entry(category).or_insert(0) += 1;
        }
    }

    // Calculate average time between crashes
    let avg_hours_between_crashes = if crash_times.len() >= 2 {
        crash_times.sort();
        let mut total_hours = 0.0;
        for i in 1..crash_times.len() {
            let diff = crash_times[i] - crash_times[i - 1];
            total_hours += diff.num_hours() as f64;
        }
        Some(total_hours / (crash_times.len() - 1) as f64)
    } else {
        None
    };

    // Build top problematic mods
    let total_crashes = records.len() as u32;
    let mut mod_stats: Vec<ModCrashStats> = mod_crash_counts
        .iter()
        .map(|(mod_id, &count)| ModCrashStats {
            mod_id: mod_id.clone(),
            crash_count: count,
            crash_percentage: (count as f32 / total_crashes as f32) * 100.0,
            last_crash: mod_last_crash.get(mod_id).cloned(),
            was_fixed: false, // Определяется по отсутствию новых крашей после обновления мода
        })
        .collect();

    mod_stats.sort_by(|a, b| b.crash_count.cmp(&a.crash_count));

    let most_problematic_mod = mod_stats.first().cloned();
    let top_problematic_mods: Vec<ModCrashStats> = mod_stats.into_iter().take(5).collect();

    // Most common category
    let most_common_category = category_counts
        .iter()
        .max_by_key(|(_, &count)| count)
        .map(|(cat, _)| cat.clone());

    // Calculate fix success rate
    let fix_success_rate = if total_crashes > 0 {
        (fixed_count as f32 / total_crashes as f32) * 100.0
    } else {
        0.0
    };

    // Determine trend (compare last week to previous week)
    let two_weeks_ago = now - Duration::days(14);
    let crashes_previous_week = records
        .iter()
        .filter(|r| {
            if let Ok(t) = DateTime::parse_from_rfc3339(&r.crash_time) {
                let t = t.with_timezone(&Utc);
                t > two_weeks_ago && t <= week_ago
            } else {
                false
            }
        })
        .count() as u32;

    let trend = if crashes_last_week == 0 && crashes_previous_week == 0 {
        CrashTrendDirection::Unknown
    } else if crashes_last_week > crashes_previous_week + 2 {
        CrashTrendDirection::Worsening
    } else if crashes_last_week + 2 < crashes_previous_week {
        CrashTrendDirection::Improving
    } else {
        CrashTrendDirection::Stable
    };

    Ok(CrashStatistics {
        total_crashes,
        crashes_last_week,
        crashes_last_day,
        most_problematic_mod,
        top_problematic_mods,
        avg_hours_between_crashes,
        fix_success_rate,
        most_common_category,
        trend,
    })
}

/// Get crash trends for mods
pub fn get_crash_trends(instance_id: &str) -> Result<Vec<CrashTrend>, String> {
    let records = get_crash_history(instance_id, Some(1000))?;

    if records.is_empty() {
        return Ok(vec![]);
    }

    let now = Utc::now();

    // Group crashes by mod and day
    let mut mod_daily_crashes: HashMap<String, HashMap<String, u32>> = HashMap::new();

    for record in &records {
        if let Ok(crash_time) = DateTime::parse_from_rfc3339(&record.crash_time) {
            let date = crash_time.format("%Y-%m-%d").to_string();

            for mod_id in &record.suspected_mods {
                mod_daily_crashes
                    .entry(mod_id.clone())
                    .or_default()
                    .entry(date.clone())
                    .and_modify(|c| *c += 1)
                    .or_insert(1);
            }
        }
    }

    // Build trends for each mod
    let mut trends: Vec<CrashTrend> = vec![];

    for (mod_id, daily_counts) in mod_daily_crashes {
        // Get last 7 days
        let mut daily_crashes: Vec<DailyCrashCount> = vec![];
        for i in 0..7 {
            let date = (now - Duration::days(6 - i)).format("%Y-%m-%d").to_string();
            let count = daily_counts.get(&date).copied().unwrap_or(0);
            daily_crashes.push(DailyCrashCount { date, count });
        }

        // Calculate trend
        let first_half: u32 = daily_crashes.iter().take(3).map(|d| d.count).sum();
        let second_half: u32 = daily_crashes.iter().skip(4).map(|d| d.count).sum();

        let trend = if first_half == 0 && second_half == 0 {
            CrashTrendDirection::Unknown
        } else if second_half > first_half + 1 {
            CrashTrendDirection::Worsening
        } else if second_half + 1 < first_half {
            CrashTrendDirection::Improving
        } else {
            CrashTrendDirection::Stable
        };

        let recommendation = match trend {
            CrashTrendDirection::Worsening => {
                format!(
                    "Consider removing or updating '{}' - crashes are increasing",
                    mod_id
                )
            }
            CrashTrendDirection::Stable => {
                format!(
                    "'{}' has consistent issues - check for alternatives",
                    mod_id
                )
            }
            CrashTrendDirection::Improving => {
                format!("'{}' seems to be stabilizing", mod_id)
            }
            CrashTrendDirection::Unknown => {
                format!("Not enough data for '{}'", mod_id)
            }
        };

        trends.push(CrashTrend {
            mod_id,
            daily_crashes,
            trend,
            recommendation,
        });
    }

    // Sort by total crashes (most problematic first)
    trends.sort_by(|a, b| {
        let a_total: u32 = a.daily_crashes.iter().map(|d| d.count).sum();
        let b_total: u32 = b.daily_crashes.iter().map(|d| d.count).sum();
        b_total.cmp(&a_total)
    });

    Ok(trends)
}

/// Mark a crash as fixed
pub fn mark_crash_fixed(crash_id: &str, fix_method: &str) -> Result<(), String> {
    let conn = get_db_conn().map_err(|e| format!("Database error: {}", e))?;

    conn.execute(
        "UPDATE crash_history SET was_fixed = 1, fix_method = ?1 WHERE id = ?2",
        params![fix_method, crash_id],
    )
    .map_err(|e| format!("Failed to update crash: {}", e))?;

    log::info!(
        "Marked crash {} as fixed with method: {}",
        crash_id,
        fix_method
    );

    Ok(())
}

/// Add notes to a crash record
pub fn update_crash_notes(crash_id: &str, notes: &str) -> Result<(), String> {
    let conn = get_db_conn().map_err(|e| format!("Database error: {}", e))?;

    conn.execute(
        "UPDATE crash_history SET notes = ?1 WHERE id = ?2",
        params![notes, crash_id],
    )
    .map_err(|e| format!("Failed to update notes: {}", e))?;

    Ok(())
}

/// Clear crash history for an instance
pub fn clear_crash_history(instance_id: &str) -> Result<u32, String> {
    let conn = get_db_conn().map_err(|e| format!("Database error: {}", e))?;

    let deleted = conn
        .execute(
            "DELETE FROM crash_history WHERE instance_id = ?1",
            params![instance_id],
        )
        .map_err(|e| format!("Failed to clear history: {}", e))?;

    log::info!(
        "Cleared {} crash records for instance {}",
        deleted,
        instance_id
    );

    Ok(deleted as u32)
}

/// Delete old crash records (older than specified days)
pub fn cleanup_old_crashes(days: i64) -> Result<u32, String> {
    let conn = get_db_conn().map_err(|e| format!("Database error: {}", e))?;

    let cutoff = (Utc::now() - Duration::days(days)).to_rfc3339();

    let deleted = conn
        .execute(
            "DELETE FROM crash_history WHERE crash_time < ?1",
            params![cutoff],
        )
        .map_err(|e| format!("Failed to cleanup: {}", e))?;

    if deleted > 0 {
        log::info!(
            "Cleaned up {} old crash records (older than {} days)",
            deleted,
            days
        );
    }

    Ok(deleted as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_trend_direction_default() {
        assert_eq!(CrashTrendDirection::default(), CrashTrendDirection::Unknown);
    }

    #[test]
    fn test_crash_record_serialization() {
        let record = CrashRecord {
            id: "test-id".to_string(),
            instance_id: "instance-1".to_string(),
            crash_time: "2025-01-01T00:00:00Z".to_string(),
            log_type: "crash".to_string(),
            problems: vec![],
            suspected_mods: vec!["sodium".to_string()],
            minecraft_version: Some("1.20.1".to_string()),
            loader_type: Some("fabric".to_string()),
            loader_version: Some("0.15.0".to_string()),
            was_fixed: false,
            fix_method: None,
            notes: None,
            created_at: "2025-01-01T00:00:00Z".to_string(),
        };

        let json = serde_json::to_string(&record).unwrap();
        assert!(json.contains("test-id"));
        assert!(json.contains("sodium"));
    }
}
