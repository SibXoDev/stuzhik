use crate::error::{LauncherError, Result};
use crate::paths::{get_base_dir, get_current_log_path};
use chrono::{DateTime, Local, Utc};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use sysinfo::System;
use tokio::fs;

// For sync functions (generate_github_issue_url)
use std::fs as std_fs;

/// Directory for storing error reports
fn error_reports_dir() -> PathBuf {
    get_base_dir().join("error_reports")
}

/// System information for error reports
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemInfo {
    pub os: String,
    pub os_version: String,
    pub arch: String,
    pub cpu_cores: usize,
    pub total_memory_mb: u64,
    pub app_version: String,
    pub rust_version: String,
}

/// Error report data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorReport {
    pub id: String,
    pub timestamp: String,
    pub error_type: String,
    pub error_message: String,
    pub stack_trace: Option<String>,
    pub context: String,
    pub system_info: SystemInfo,
    pub recent_logs: Vec<String>,
    pub screenshot_path: Option<String>,
}

/// Summary of an error report for listing
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorReportSummary {
    pub id: String,
    pub timestamp: String,
    pub error_type: String,
    pub error_message: String,
    pub has_screenshot: bool,
}

/// Get system information using sysinfo crate
fn get_system_info() -> SystemInfo {
    let mut sys = System::new_all();
    sys.refresh_all();

    let os = System::name().unwrap_or_else(|| std::env::consts::OS.to_string());
    let os_version = System::os_version().unwrap_or_else(|| "Unknown".to_string());
    let arch = std::env::consts::ARCH.to_string();

    // CPU cores (logical)
    let cpu_cores = sys.cpus().len();

    // Total memory in MB
    let total_memory_mb = sys.total_memory() / 1024 / 1024;

    SystemInfo {
        os,
        os_version,
        arch,
        cpu_cores,
        total_memory_mb,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        rust_version: env!("CARGO_PKG_RUST_VERSION").to_string(),
    }
}

/// Read recent log lines from current session
async fn get_recent_logs(max_lines: usize) -> Vec<String> {
    // Use get_current_log_path() to find newest session log
    let log_file = match get_current_log_path().await {
        Ok(path) => PathBuf::from(path),
        Err(_) => {
            log::warn!("Could not find current log file for error report");
            return vec![];
        }
    };

    if !fs::try_exists(&log_file).await.unwrap_or(false) {
        return vec![];
    }

    fs::read_to_string(&log_file)
        .await
        .ok()
        .map(|content| {
            content
                .lines()
                .rev()
                .take(max_lines)
                .map(|s| s.to_string())
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect()
        })
        .unwrap_or_default()
}

/// Create an error report
#[tauri::command]
pub async fn create_error_report(
    error_type: String,
    error_message: String,
    stack_trace: Option<String>,
    context: String,
) -> Result<ErrorReport> {
    // Create reports directory
    let reports_dir = error_reports_dir();
    fs::create_dir_all(&reports_dir).await?;

    // Generate unique ID
    let id = format!("err_{}", Utc::now().format("%Y%m%d_%H%M%S_%3f"));
    let timestamp = Local::now().to_rfc3339();

    // Collect system info
    let system_info = get_system_info();

    // Get recent logs
    let recent_logs = get_recent_logs(100).await;

    let report = ErrorReport {
        id: id.clone(),
        timestamp,
        error_type,
        error_message,
        stack_trace,
        context,
        system_info,
        recent_logs,
        screenshot_path: None,
    };

    // Save report to file
    let report_path = reports_dir.join(format!("{}.json", id));
    let json = serde_json::to_string_pretty(&report).map_err(|e| LauncherError::Json(e))?;
    fs::write(&report_path, json).await?;

    log::info!("Created error report: {}", id);

    Ok(report)
}

/// Get system info (exposed to frontend)
#[tauri::command]
pub fn get_system_info_command() -> SystemInfo {
    get_system_info()
}

/// List all error reports
#[tauri::command]
pub async fn list_error_reports() -> Result<Vec<ErrorReportSummary>> {
    let reports_dir = error_reports_dir();

    if !fs::try_exists(&reports_dir).await.unwrap_or(false) {
        return Ok(vec![]);
    }

    let mut reports = Vec::new();
    let mut entries = fs::read_dir(&reports_dir).await?;

    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();

        if path.extension().map(|e| e == "json").unwrap_or(false) {
            if let Ok(content) = fs::read_to_string(&path).await {
                if let Ok(report) = serde_json::from_str::<ErrorReport>(&content) {
                    reports.push(ErrorReportSummary {
                        id: report.id,
                        timestamp: report.timestamp,
                        error_type: report.error_type,
                        error_message: report.error_message,
                        has_screenshot: report.screenshot_path.is_some(),
                    });
                }
            }
        }
    }

    // Sort by timestamp descending
    reports.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));

    Ok(reports)
}

/// Get a specific error report
#[tauri::command]
pub async fn get_error_report(id: String) -> Result<ErrorReport> {
    let reports_dir = error_reports_dir();
    let report_path = reports_dir.join(format!("{}.json", id));

    if !fs::try_exists(&report_path).await.unwrap_or(false) {
        return Err(LauncherError::NotFound(format!(
            "Error report not found: {}",
            id
        )));
    }

    let content = fs::read_to_string(&report_path).await?;
    let report: ErrorReport = serde_json::from_str(&content).map_err(|e| LauncherError::Json(e))?;

    Ok(report)
}

/// Delete an error report
#[tauri::command]
pub async fn delete_error_report(id: String) -> Result<()> {
    let reports_dir = error_reports_dir();
    let report_path = reports_dir.join(format!("{}.json", id));

    if fs::try_exists(&report_path).await.unwrap_or(false) {
        fs::remove_file(&report_path).await?;
    }

    // Also delete screenshot if exists
    let screenshot_path = reports_dir.join(format!("{}.png", id));
    if fs::try_exists(&screenshot_path).await.unwrap_or(false) {
        let _ = fs::remove_file(&screenshot_path).await;
    }

    Ok(())
}

/// Clean up old error reports (older than 7 days)
#[tauri::command]
pub async fn cleanup_old_reports() -> Result<u32> {
    let reports_dir = error_reports_dir();

    if !fs::try_exists(&reports_dir).await.unwrap_or(false) {
        return Ok(0);
    }

    let seven_days_ago = Utc::now() - chrono::Duration::days(7);
    let mut deleted = 0u32;
    let mut entries = fs::read_dir(&reports_dir).await?;

    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();

        if let Ok(metadata) = entry.metadata().await {
            if let Ok(modified) = metadata.modified() {
                let modified: DateTime<Utc> = modified.into();
                if modified < seven_days_ago {
                    if fs::remove_file(&path).await.is_ok() {
                        deleted += 1;
                    }
                }
            }
        }
    }

    if deleted > 0 {
        log::info!("Cleaned up {} old error reports", deleted);
    }

    Ok(deleted)
}

/// Generate GitHub issue URL with pre-filled data
#[tauri::command]
pub fn generate_github_issue_url(report_id: String) -> Result<String> {
    let reports_dir = error_reports_dir();
    let report_path = reports_dir.join(format!("{}.json", report_id));

    if !report_path.exists() {
        return Err(LauncherError::NotFound(format!(
            "Error report not found: {}",
            report_id
        )));
    }

    let content = std_fs::read_to_string(&report_path)?;
    let report: ErrorReport = serde_json::from_str(&content).map_err(|e| LauncherError::Json(e))?;

    // Build issue body
    let body = format!(
        r#"## Error Report
**Type:** {}
**Message:** {}
**Context:** {}
**Time:** {}

## System Information
- **OS:** {} ({})
- **Architecture:** {}
- **CPU Cores:** {}
- **Memory:** {} MB
- **App Version:** {}

## Stack Trace
```
{}
```

## Recent Logs
```
{}
```

---
*This issue was auto-generated by Stuzhik Error Reporter*
"#,
        report.error_type,
        report.error_message,
        report.context,
        report.timestamp,
        report.system_info.os,
        report.system_info.os_version,
        report.system_info.arch,
        report.system_info.cpu_cores,
        report.system_info.total_memory_mb,
        report.system_info.app_version,
        report
            .stack_trace
            .as_deref()
            .unwrap_or("No stack trace available"),
        report
            .recent_logs
            .iter()
            .rev()
            .take(20)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n"),
    );

    // URL encode
    // Truncate message safely (respecting UTF-8 boundaries)
    let truncated_msg: String = report.error_message.chars().take(50).collect();
    let title_str = format!("[Bug] {}: {}", report.error_type, truncated_msg);
    let title = urlencoding::encode(&title_str);
    let body_encoded = urlencoding::encode(&body);

    let url = format!(
        "https://github.com/SibXoDev/stuzhik/issues/new?title={}&body={}&labels=bug",
        title, body_encoded
    );

    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_system_info() {
        let info = get_system_info();
        assert!(!info.os.is_empty());
        assert!(!info.arch.is_empty());
        assert!(info.cpu_cores > 0);
    }
}
