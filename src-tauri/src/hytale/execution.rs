//! Hytale game execution

use super::installation::{detect_hytale, HytaleInstallation};
use super::settings::HytaleSettings;
use std::process::Stdio;
use tokio::process::Command;

/// Hytale launch options
#[derive(Debug, Clone, Default)]
pub struct HytaleLaunchOptions {
    /// Custom game arguments
    pub game_args: Option<String>,
    /// Server to auto-connect to
    pub server: Option<String>,
    /// Server port
    pub port: Option<u16>,
    /// Use settings from HytaleSettings
    pub settings: Option<HytaleSettings>,
}

/// Launch Hytale game
pub async fn launch_hytale(options: HytaleLaunchOptions) -> Result<u32, String> {
    let installation = detect_hytale()
        .await
        .ok_or_else(|| "Hytale is not installed".to_string())?;

    let executable = installation
        .executable
        .ok_or_else(|| "Hytale executable not found".to_string())?;

    let mut cmd = Command::new(&executable);

    // Set working directory
    cmd.current_dir(&installation.path);

    // Apply settings if provided
    if let Some(ref settings) = options.settings {
        for arg in settings.to_args() {
            cmd.arg(arg);
        }
    }

    // Add custom arguments (override settings)
    if let Some(ref args) = options.game_args {
        for arg in args.split_whitespace() {
            cmd.arg(arg);
        }
    }

    // Add server connection if specified (override settings)
    if let Some(ref server) = options.server {
        cmd.arg("--connect");
        cmd.arg(server);
        if let Some(port) = options.port {
            cmd.arg("--port");
            cmd.arg(port.to_string());
        }
    }

    // Configure process
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    // Hide console window on Windows
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    // Spawn the process
    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to launch Hytale: {}", e))?;

    let pid = child.id().unwrap_or(0);

    log::info!("Launched Hytale with PID: {}", pid);

    Ok(pid)
}

/// Launch Hytale and connect to a server
pub async fn launch_hytale_connect(
    server: String,
    port: Option<u16>,
) -> Result<u32, String> {
    launch_hytale(HytaleLaunchOptions {
        server: Some(server),
        port,
        ..Default::default()
    })
    .await
}

/// Check if Hytale is currently running
pub async fn is_hytale_running() -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command as StdCommand;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        if let Ok(output) = StdCommand::new("tasklist")
            .args(["/FI", "IMAGENAME eq Hytale.exe", "/NH"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            let output_str = String::from_utf8_lossy(&output.stdout);
            return output_str.contains("Hytale.exe");
        }
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        use std::process::Command as StdCommand;
        if let Ok(output) = StdCommand::new("pgrep")
            .args(["-x", "Hytale"])
            .output()
        {
            return output.status.success();
        }
    }

    false
}

// Tauri commands

/// Launch Hytale
#[tauri::command]
pub async fn launch_hytale_game(
    game_args: Option<String>,
    server: Option<String>,
    port: Option<u16>,
) -> Result<u32, String> {
    launch_hytale(HytaleLaunchOptions {
        game_args,
        server,
        port,
        settings: None,
    })
    .await
}

/// Check if Hytale is running
#[tauri::command]
pub async fn check_hytale_running() -> bool {
    is_hytale_running().await
}
