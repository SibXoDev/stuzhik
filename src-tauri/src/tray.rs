use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime,
};

use crate::settings::{LaunchBehavior, SettingsManager};

/// Flag to track if the launcher was hidden due to game launch
/// This prevents accidental re-showing while a game is running
static HIDDEN_FOR_GAME: AtomicBool = AtomicBool::new(false);

/// Check if the launcher is currently hidden due to a running game
pub fn is_hidden_for_game() -> bool {
    HIDDEN_FOR_GAME.load(Ordering::SeqCst)
}

/// Clear the hidden-for-game flag (call when game stops)
pub fn clear_hidden_for_game() {
    HIDDEN_FOR_GAME.store(false, Ordering::SeqCst);
    log::debug!("Cleared hidden-for-game flag");
}

/// Get localized tray menu labels
fn get_tray_labels() -> (&'static str, &'static str, &'static str) {
    let lang = SettingsManager::get_all()
        .map(|s| s.language)
        .unwrap_or_else(|_| "ru".to_string());

    match lang.as_str() {
        "ru" => ("Показать", "Свернуть в трей", "Выход"),
        _ => ("Show", "Minimize to tray", "Quit"),
    }
}

/// Initialize system tray icon with menu
pub fn init_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let (show_label, minimize_label, quit_label) = get_tray_labels();

    // Create menu items
    let show_item = MenuItem::with_id(app, "show", show_label, true, None::<&str>)?;
    let minimize_item = MenuItem::with_id(app, "minimize", minimize_label, true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", quit_label, true, None::<&str>)?;

    // Create menu
    let menu = Menu::with_items(app, &[&show_item, &minimize_item, &quit_item])?;

    // Build tray icon
    let icon = app
        .default_window_icon()
        .ok_or_else(|| tauri::Error::AssetNotFound("default window icon".to_string()))?
        .clone();
    let _tray = TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Stuzhik - Minecraft Launcher")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                // User explicitly requested to show - clear the hidden-for-game flag
                HIDDEN_FOR_GAME.store(false, Ordering::SeqCst);
                if let Some(window) = app.get_webview_window("main") {
                    log::info!("Showing window via tray menu");
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "minimize" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Show window on left click
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                // User explicitly clicked tray icon - clear the hidden-for-game flag
                HIDDEN_FOR_GAME.store(false, Ordering::SeqCst);
                if let Some(window) = tray.app_handle().get_webview_window("main") {
                    log::info!("Showing window via tray icon click");
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}

/// Apply launch behavior when game starts
/// Returns true if the window was hidden/closed
pub fn apply_launch_behavior<R: Runtime>(app: &AppHandle<R>) -> bool {
    let behavior = SettingsManager::get_all()
        .map(|s| s.launch_behavior)
        .unwrap_or_default();

    let window = match app.get_webview_window("main") {
        Some(w) => w,
        None => return false,
    };

    match behavior {
        LaunchBehavior::MinimizeToTray => {
            log::info!("Minimizing to tray (game started)");
            // Set flag BEFORE hiding to prevent race conditions
            HIDDEN_FOR_GAME.store(true, Ordering::SeqCst);
            if let Err(e) = window.hide() {
                log::error!("Failed to hide window: {}", e);
                HIDDEN_FOR_GAME.store(false, Ordering::SeqCst);
                return false;
            }
            log::debug!("Window hidden, hidden-for-game flag set");
            true
        }
        LaunchBehavior::KeepOpen => {
            log::info!("Keeping window open (game started)");
            false
        }
        LaunchBehavior::Close => {
            log::info!("Closing launcher (game started)");
            let _ = window.close();
            true
        }
    }
}

/// Show the main window when game stops (if it was hidden due to game launch)
/// Only shows if:
/// 1. The window was hidden due to game launch (HIDDEN_FOR_GAME flag)
/// 2. No other instances are still running (checked by caller)
pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    // Only show if we were hidden due to game launch
    // This prevents showing when user manually minimized via tray menu
    if !is_hidden_for_game() {
        log::debug!("Not showing window - was not hidden for game (user manually minimized)");
        return;
    }

    // Clear the flag - game has stopped and we're about to show
    clear_hidden_for_game();

    if let Some(window) = app.get_webview_window("main") {
        log::info!("Showing main window (game stopped)");
        if let Err(e) = window.show() {
            log::error!("Failed to show window: {}", e);
        }
        if let Err(e) = window.set_focus() {
            log::error!("Failed to set focus: {}", e);
        }
    }
}

/// Show the main window when all games have stopped
/// Call this when the last running instance stops
pub fn show_main_window_all_stopped<R: Runtime>(app: &AppHandle<R>) {
    // Force show - all games stopped
    if is_hidden_for_game() {
        clear_hidden_for_game();
        if let Some(window) = app.get_webview_window("main") {
            log::info!("Showing main window (all games stopped)");
            if let Err(e) = window.show() {
                log::error!("Failed to show window: {}", e);
            }
            if let Err(e) = window.set_focus() {
                log::error!("Failed to set focus: {}", e);
            }
        }
    }
}
