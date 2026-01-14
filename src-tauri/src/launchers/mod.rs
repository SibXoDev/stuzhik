//! Launcher Import Module
//!
//! Supports importing instances from other Minecraft launchers:
//! - MultiMC / Prism Launcher
//! - CurseForge App
//! - Modrinth App
//! - Generic .minecraft folders (TLauncher, official launcher, etc.)
//!
//! # Usage
//!
//! ```rust
//! use launchers::{detect_all_launchers, list_instances, import_instance};
//!
//! // Auto-detect installed launchers
//! let launchers = detect_all_launchers().await;
//!
//! // List instances from a specific launcher
//! let instances = list_instances(&launchers[0]).await?;
//!
//! // Import an instance
//! let result = import_instance(&instances[0], "My Instance", app_handle).await?;
//! ```

pub mod curseforge;
pub mod generic;
pub mod legacy;
pub mod modrinth;
pub mod multimc;
pub mod official;
pub mod types;

pub use types::*;

use crate::paths;
use std::path::{Path, PathBuf};
use tauri::Emitter;
use tokio::fs;

/// Detect all installed launchers on the system
pub async fn detect_all_launchers() -> Vec<DetectedLauncher> {
    let mut all_launchers = Vec::new();

    // Detect each launcher type in parallel
    let (multimc, curseforge, modrinth, official, legacy_launcher) = tokio::join!(
        multimc::detect_installations(),
        curseforge::detect_installations(),
        modrinth::detect_installations(),
        official::detect_installations(),
        legacy::detect_installations(),
    );

    all_launchers.extend(multimc);
    all_launchers.extend(curseforge);
    all_launchers.extend(modrinth);
    all_launchers.extend(official);
    all_launchers.extend(legacy_launcher);

    // Sort by instance count (most instances first)
    all_launchers.sort_by(|a, b| b.instance_count.cmp(&a.instance_count));

    all_launchers
}

/// List instances from a detected launcher
pub async fn list_instances_from_launcher(
    launcher: &DetectedLauncher,
) -> LauncherResult<Vec<LauncherInstance>> {
    match launcher.launcher_type {
        LauncherType::MultiMC | LauncherType::Prism => {
            multimc::list_instances(&launcher.root_path).await
        }
        LauncherType::CurseForgeApp => curseforge::list_instances(&launcher.root_path).await,
        LauncherType::Modrinth => modrinth::list_instances(&launcher.root_path).await,
        LauncherType::OfficialLauncher => official::list_instances(&launcher.root_path).await,
        LauncherType::LegacyLauncher => legacy::list_instances(&launcher.root_path).await,
        LauncherType::ATLauncher | LauncherType::GDLauncher => {
            // Not implemented yet
            Err(LauncherError::InvalidFormat(format!(
                "{} is not supported yet",
                launcher.launcher_type.display_name()
            )))
        }
    }
}

/// List instances from a path (auto-detect launcher type)
pub async fn list_instances_from_path(path: &Path) -> LauncherResult<Vec<LauncherInstance>> {
    // Try to detect launcher type
    if path.join("instances").exists() {
        // MultiMC/Prism style
        if path.join("prismlauncher.cfg").exists() || path.join("multimc.cfg").exists() {
            return multimc::list_instances(path).await;
        }
    }

    if path.join("Instances").exists() {
        // CurseForge style
        return curseforge::list_instances(path).await;
    }

    if path.join("profiles").exists() {
        // Modrinth style
        return modrinth::list_instances(path).await;
    }

    // Try as generic .minecraft folder
    if path.join("mods").exists() || path.join("config").exists() {
        let instance = generic::parse_instance(path, None).await?;
        return Ok(vec![instance]);
    }

    Err(LauncherError::InvalidFormat(
        "Could not detect launcher type".to_string(),
    ))
}

/// Import an instance from another launcher
pub async fn import_instance(
    instance: &LauncherInstance,
    new_name: String,
    app_handle: &tauri::AppHandle,
) -> LauncherResult<LauncherImportResult> {
    import_instance_with_options(instance, new_name, true, app_handle).await
}

/// Import an instance with options
pub async fn import_instance_with_options(
    instance: &LauncherInstance,
    new_name: String,
    include_worlds: bool,
    app_handle: &tauri::AppHandle,
) -> LauncherResult<LauncherImportResult> {
    log::info!(
        "Importing instance '{}' from {} as '{}'",
        instance.name,
        instance.source_launcher.display_name(),
        new_name
    );

    // Emit start event
    app_handle
        .emit(
            "launcher-import-started",
            serde_json::json!({
                "name": new_name,
                "source": instance.source_launcher.display_name(),
            }),
        )
        .ok();

    // Phase 1: Create new instance in Stuzhik
    emit_progress(app_handle, "creating_instance", 0, 1, None, 0, 0);

    let instance_id = crate::utils::gen_short_id(8);
    let instances_dir = paths::instances_dir();
    let target_dir = instances_dir.join(&instance_id);

    fs::create_dir_all(&target_dir).await?;

    // Determine source directory (handle .minecraft subfolder for MultiMC/Prism)
    let source_dir = get_minecraft_source_dir(&instance.path, instance.source_launcher);

    // Phase 2: Scan files
    emit_progress(app_handle, "scanning", 0, 1, None, 0, 0);

    let (files, total_bytes) =
        scan_files_for_import(&source_dir, &target_dir, include_worlds).await?;
    let total_files = files.len();

    log::info!(
        "Found {} files to import ({} bytes)",
        total_files,
        total_bytes
    );

    // Phase 3: Create directories
    let mut dirs_to_create = std::collections::HashSet::new();
    for (_, dst) in &files {
        if let Some(parent) = dst.parent() {
            dirs_to_create.insert(parent.to_path_buf());
        }
    }

    for dir in dirs_to_create {
        fs::create_dir_all(&dir).await?;
    }

    // Phase 4: Copy files
    let files_copied = std::sync::atomic::AtomicUsize::new(0);
    let bytes_copied = std::sync::atomic::AtomicU64::new(0);
    let mut warnings = Vec::new();

    const BATCH_SIZE: usize = 50;

    for batch in files.chunks(BATCH_SIZE) {
        let mut handles = Vec::new();

        for (src, dst) in batch {
            let src = src.clone();
            let dst = dst.clone();
            let src_for_tracking = src.clone();

            let handle = tokio::spawn(async move {
                // Use async copy for small files, sync for large
                let metadata = tokio::fs::metadata(&src).await?;
                let size = metadata.len();

                if size > 10 * 1024 * 1024 {
                    // > 10MB - use blocking copy
                    let src_clone = src.clone();
                    let dst_clone = dst.clone();
                    tokio::task::spawn_blocking(move || std::fs::copy(&src_clone, &dst_clone))
                        .await
                        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?
                } else {
                    tokio::fs::copy(&src, &dst).await
                }
            });

            handles.push((handle, src_for_tracking));
        }

        for (handle, src) in handles {
            match handle.await {
                Ok(Ok(size)) => {
                    files_copied.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let total_copied =
                        bytes_copied.fetch_add(size, std::sync::atomic::Ordering::SeqCst) + size;

                    // Emit progress periodically
                    let copied_count = files_copied.load(std::sync::atomic::Ordering::SeqCst);
                    if copied_count % 50 == 0 {
                        emit_progress(
                            app_handle,
                            "copying",
                            copied_count,
                            total_files,
                            src.file_name().and_then(|n| n.to_str()).map(String::from),
                            total_copied,
                            total_bytes,
                        );
                    }
                }
                Ok(Err(e)) => {
                    warnings.push(format!("Failed to copy {}: {}", src.display(), e));
                }
                Err(e) => {
                    warnings.push(format!("Task error for {}: {}", src.display(), e));
                }
            }
        }
    }

    let final_files_copied = files_copied.load(std::sync::atomic::Ordering::SeqCst);
    let final_bytes_copied = bytes_copied.load(std::sync::atomic::Ordering::SeqCst);

    // Phase 5: Save to database
    emit_progress(
        app_handle,
        "saving",
        final_files_copied,
        total_files,
        None,
        final_bytes_copied,
        total_bytes,
    );

    save_instance_to_db(&instance_id, &new_name, &target_dir, instance)?;

    // Phase 6: Sync mods with database
    emit_progress(
        app_handle,
        "syncing_mods",
        final_files_copied,
        total_files,
        None,
        final_bytes_copied,
        total_bytes,
    );

    let mods_imported =
        if let Err(e) = crate::mods::ModManager::sync_mods_with_folder(&instance_id).await {
            warnings.push(format!("Failed to sync mods: {}", e));
            0
        } else {
            // Count mods in the new instance
            count_mods(&target_dir.join("mods")).await
        };

    log::info!(
        "Imported instance '{}' (id: {}, files: {}, mods: {})",
        new_name,
        instance_id,
        final_files_copied,
        mods_imported
    );

    // Emit completion
    app_handle
        .emit(
            "launcher-import-completed",
            serde_json::json!({
                "instance_id": instance_id,
                "name": new_name,
                "files_copied": final_files_copied,
                "mods_imported": mods_imported,
            }),
        )
        .ok();

    // Emit instance-created for UI refresh
    app_handle
        .emit(
            "instance-created",
            serde_json::json!({
                "id": instance_id,
                "name": new_name,
            }),
        )
        .ok();

    Ok(LauncherImportResult {
        instance_id,
        original_name: instance.name.clone(),
        files_copied: final_files_copied,
        total_size: final_bytes_copied,
        mods_imported,
        warnings,
    })
}

/// Get the actual .minecraft directory for different launcher types
fn get_minecraft_source_dir(instance_path: &Path, launcher_type: LauncherType) -> PathBuf {
    match launcher_type {
        LauncherType::MultiMC | LauncherType::Prism => {
            // MultiMC/Prism use .minecraft subfolder
            let minecraft_dir = instance_path.join(".minecraft");
            if minecraft_dir.exists() {
                return minecraft_dir;
            }
            let alt_dir = instance_path.join("minecraft");
            if alt_dir.exists() {
                return alt_dir;
            }
            instance_path.to_path_buf()
        }
        _ => instance_path.to_path_buf(),
    }
}

/// Scan files for import (excluding cache, logs, etc.)
async fn scan_files_for_import(
    source: &Path,
    dest: &Path,
    include_worlds: bool,
) -> LauncherResult<(Vec<(PathBuf, PathBuf)>, u64)> {
    // Directories to include
    let mut include_dirs = vec![
        "mods",
        "config",
        "resourcepacks",
        "shaderpacks",
        "scripts",
        "kubejs",
        "defaultconfigs",
        "global_packs",
    ];

    if include_worlds {
        include_dirs.push("saves");
    }

    // Files to include
    let include_files = [
        "options.txt",
        "optionsof.txt",
        "optionsshaders.txt",
        "servers.dat",
    ];

    let mut files = Vec::new();
    let mut total_size = 0u64;

    // Scan directories
    for dir_name in include_dirs {
        let src_dir = source.join(dir_name);
        let dst_dir = dest.join(dir_name);

        if src_dir.exists() {
            let (dir_files, dir_size) = scan_directory(&src_dir, &dst_dir).await?;
            files.extend(dir_files);
            total_size += dir_size;
        }
    }

    // Include specific files
    for file_name in &include_files {
        let src_file = source.join(file_name);
        let dst_file = dest.join(file_name);

        if src_file.exists() {
            if let Ok(metadata) = fs::metadata(&src_file).await {
                total_size += metadata.len();
                files.push((src_file, dst_file));
            }
        }
    }

    Ok((files, total_size))
}

/// Scan directory recursively
async fn scan_directory(src: &Path, dst: &Path) -> LauncherResult<(Vec<(PathBuf, PathBuf)>, u64)> {
    let mut files = Vec::new();
    let mut total_size = 0u64;
    let mut stack = vec![(src.to_path_buf(), dst.to_path_buf())];

    while let Some((src_path, dst_path)) = stack.pop() {
        let mut entries = fs::read_dir(&src_path).await?;

        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            let file_type = entry.file_type().await?;
            let dest = dst_path.join(entry.file_name());

            if file_type.is_dir() {
                stack.push((path, dest));
            } else if file_type.is_file() {
                let metadata = entry.metadata().await?;
                let size = metadata.len();
                total_size += size;
                files.push((path, dest));
            }
        }
    }

    Ok((files, total_size))
}

/// Save instance to database
fn save_instance_to_db(
    instance_id: &str,
    name: &str,
    dir: &Path,
    source: &LauncherInstance,
) -> LauncherResult<()> {
    let now = chrono::Utc::now().to_rfc3339();
    let dir_str = dir.to_string_lossy().to_string();

    // Get Java version for MC version
    let java_version =
        crate::java::JavaManager::required_java_version(&source.minecraft_version).to_string();

    // Get default memory settings
    let memory_min = source.memory_min.unwrap_or_else(|| {
        crate::settings::SettingsManager::get_default_memory_min().unwrap_or(2048) as u32
    });
    let memory_max = source.memory_max.unwrap_or_else(|| {
        crate::settings::SettingsManager::get_default_memory_max().unwrap_or(4096) as u32
    });

    let conn = stuzhik_db::get_db_conn().map_err(|e| LauncherError::Database(e.to_string()))?;

    conn.execute(
        r#"INSERT INTO instances (
            id, name, version, loader, loader_version, instance_type,
            java_version, java_path, memory_min, memory_max, java_args, game_args,
            dir, port, rcon_enabled, rcon_port, rcon_password, username,
            status, pid, auto_restart, total_playtime, notes,
            installation_step, installation_error, backup_enabled,
            created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28)"#,
        rusqlite::params![
            instance_id,
            name,
            source.minecraft_version,
            source.loader,
            source.loader_version,
            source.instance_type,
            java_version,
            None::<String>, // java_path
            memory_min,
            memory_max,
            source.java_args,
            None::<String>, // game_args
            dir_str,
            None::<i32>, // port
            0,           // rcon_enabled
            None::<i32>, // rcon_port
            None::<String>, // rcon_password
            None::<String>, // username
            "stopped",   // status
            None::<i64>, // pid
            0,           // auto_restart
            0,           // total_playtime
            source.notes.as_ref().map(|n| {
                format!(
                    "Imported from {}\n{}",
                    source.source_launcher.display_name(),
                    n
                )
            }),
            None::<String>, // installation_step
            None::<String>, // installation_error
            None::<i32>,    // backup_enabled
            now.clone(),
            now,
        ],
    )
    .map_err(|e| LauncherError::Database(e.to_string()))?;

    Ok(())
}

/// Count mods in directory
async fn count_mods(mods_dir: &Path) -> usize {
    if !mods_dir.exists() {
        return 0;
    }

    let mut count = 0;
    if let Ok(mut entries) = fs::read_dir(mods_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(".jar") || name.ends_with(".jar.disabled") {
                count += 1;
            }
        }
    }
    count
}

/// Emit progress event
fn emit_progress(
    app_handle: &tauri::AppHandle,
    phase: &str,
    current: usize,
    total: usize,
    current_file: Option<String>,
    bytes_copied: u64,
    total_bytes: u64,
) {
    app_handle
        .emit(
            "launcher-import-progress",
            LauncherImportProgress {
                phase: phase.to_string(),
                current,
                total,
                current_file,
                bytes_copied,
                total_bytes,
            },
        )
        .ok();
}

// ========== Tauri Commands ==========

/// Detect installed launchers
#[tauri::command]
pub async fn detect_launchers() -> Result<Vec<DetectedLauncher>, String> {
    Ok(detect_all_launchers().await)
}

/// List instances from a launcher
#[tauri::command]
pub async fn list_launcher_instances(
    launcher_path: String,
) -> Result<Vec<LauncherInstance>, String> {
    let path = PathBuf::from(launcher_path);
    list_instances_from_path(&path)
        .await
        .map_err(|e| e.to_string())
}

/// List instances from a detected launcher
#[tauri::command]
pub async fn list_detected_launcher_instances(
    launcher: DetectedLauncher,
) -> Result<Vec<LauncherInstance>, String> {
    list_instances_from_launcher(&launcher)
        .await
        .map_err(|e| e.to_string())
}

/// Import an instance from another launcher
#[tauri::command]
pub async fn import_launcher_instance(
    instance: LauncherInstance,
    new_name: String,
    include_worlds: bool,
    app_handle: tauri::AppHandle,
) -> Result<LauncherImportResult, String> {
    import_instance_with_options(&instance, new_name, include_worlds, &app_handle)
        .await
        .map_err(|e| e.to_string())
}

/// Analyze a .minecraft folder
#[tauri::command]
pub async fn analyze_minecraft_folder(
    path: String,
) -> Result<generic::MinecraftFolderAnalysis, String> {
    let path = PathBuf::from(path);
    generic::analyze_folder(&path)
        .await
        .map_err(|e| e.to_string())
}

/// Import from generic .minecraft folder
#[tauri::command]
pub async fn import_minecraft_folder(
    path: String,
    name: String,
    include_worlds: bool,
    app_handle: tauri::AppHandle,
) -> Result<LauncherImportResult, String> {
    let path = PathBuf::from(path);

    // Parse as generic instance
    let instance = generic::parse_instance(&path, Some(name.clone()))
        .await
        .map_err(|e| e.to_string())?;

    import_instance_with_options(&instance, name, include_worlds, &app_handle)
        .await
        .map_err(|e| e.to_string())
}
