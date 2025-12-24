use chrono::Utc;
use rusqlite::params;
use std::collections::HashMap;
use std::process::Child;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, State};

use crate::cancellation;
use crate::db::get_db_conn;
use crate::error::{LauncherError, Result};
use crate::java::JavaManager;
use crate::modpacks;
use crate::paths::{create_instance_structure, instance_dir};
use crate::settings::SettingsManager;
use crate::types::{CreateInstanceRequest, Instance, InstanceStatus, InstanceType, LoaderType};
use crate::utils::gen_short_id;

use super::installation::install_instance_async_cancellable;

pub type ChildMap = Arc<Mutex<HashMap<String, Child>>>;

/// Получение списка всех экземпляров
#[tauri::command]
pub async fn list_instances() -> Result<Vec<Instance>> {
    let conn = get_db_conn()?;
    let mut stmt = conn.prepare(
        r#"SELECT
            id, name, version, loader, loader_version, instance_type,
            java_version, java_path, memory_min, memory_max, java_args, game_args,
            dir, port, rcon_enabled, rcon_port, rcon_password, username,
            status, pid, auto_restart, last_played, total_playtime, notes,
            installation_step, installation_error, backup_enabled,
            created_at, updated_at
         FROM instances ORDER BY created_at DESC"#,
    )?;

    let instances = stmt
        .query_map([], |row| {
            let loader_str: String = row.get(3)?;
            let instance_type_str: String = row.get(5)?;
            let status_str: String = row.get(18)?;

            Ok(Instance {
                id: row.get(0)?,
                name: row.get(1)?,
                version: row.get(2)?,
                loader: LoaderType::parse(&loader_str).unwrap_or(LoaderType::Vanilla),
                loader_version: row.get(4)?,
                instance_type: if instance_type_str == "server" {
                    InstanceType::Server
                } else {
                    InstanceType::Client
                },
                java_version: row.get(6)?,
                java_path: row.get(7)?,
                memory_min: row.get(8)?,
                memory_max: row.get(9)?,
                java_args: row.get(10)?,
                game_args: row.get(11)?,
                dir: row.get(12)?,
                port: row.get(13)?,
                rcon_enabled: row.get::<_, i32>(14)? != 0,
                rcon_port: row.get(15)?,
                rcon_password: row.get(16)?,
                username: row.get(17)?,
                status: InstanceStatus::parse(&status_str),
                auto_restart: row.get::<_, i32>(20)? != 0,
                last_played: row.get(21)?,
                total_playtime: row.get::<_, Option<i64>>(22)?.unwrap_or(0),
                notes: row.get(23)?,
                installation_step: row.get(24)?,
                installation_error: row.get(25)?,
                backup_enabled: row.get::<_, Option<i32>>(26)?.map(|v| v != 0),
                created_at: row.get(27)?,
                updated_at: row.get(28)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    Ok(instances)
}

/// Получение конкретного экземпляра по ID
#[tauri::command]
pub async fn get_instance(id: String) -> Result<Instance> {
    let conn = get_db_conn()?;

    conn.query_row(
        "SELECT id, name, version, loader, loader_version, instance_type,
                java_version, java_path, memory_min, memory_max,
                java_args, game_args, dir, port, rcon_enabled, rcon_port,
                rcon_password, username, status, auto_restart, last_played,
                total_playtime, notes, installation_step, installation_error,
                backup_enabled, created_at, updated_at
         FROM instances
         WHERE id = ?1",
        [id.clone()],
        |row| {
            let loader_str: String = row.get(3)?;
            let instance_type_str: String = row.get(5)?;
            let status_str: String = row.get(18)?;

            Ok(Instance {
                id: row.get(0)?,
                name: row.get(1)?,
                version: row.get(2)?,
                loader: LoaderType::parse(&loader_str).unwrap_or(LoaderType::Vanilla),
                loader_version: row.get(4)?,
                instance_type: if instance_type_str == "server" {
                    InstanceType::Server
                } else {
                    InstanceType::Client
                },
                java_version: row.get(6)?,
                java_path: row.get(7)?,
                memory_min: row.get(8)?,
                memory_max: row.get(9)?,
                java_args: row.get(10)?,
                game_args: row.get(11)?,
                dir: row.get(12)?,
                port: row.get(13)?,
                rcon_enabled: row.get(14)?,
                rcon_port: row.get(15)?,
                rcon_password: row.get(16)?,
                username: row.get(17)?,
                status: InstanceStatus::parse(&status_str),
                auto_restart: row.get(19)?,
                last_played: row.get(20)?,
                total_playtime: row.get(21)?,
                notes: row.get(22)?,
                installation_step: row.get(23)?,
                installation_error: row.get(24)?,
                backup_enabled: row.get::<_, Option<i32>>(25)?.map(|v| v != 0),
                created_at: row.get(26)?,
                updated_at: row.get(27)?,
            })
        },
    )
    .map_err(|_| LauncherError::InstanceNotFound(id))
}

/// Создание нового экземпляра и запуск его установки в фоне
#[tauri::command]
pub async fn create_instance(
    req: CreateInstanceRequest,
    app_handle: tauri::AppHandle,
) -> Result<Instance> {
    let id = gen_short_id(12);

    let loader_str = req.loader.clone();
    let instance_type_str = req.instance_type.clone();

    let loader = LoaderType::parse(&loader_str)
        .ok_or_else(|| LauncherError::InvalidConfig(format!("Invalid loader: {}", loader_str)))?;
    let instance_type = if instance_type_str == "server" {
        InstanceType::Server
    } else {
        InstanceType::Client
    };

    let dir = instance_dir(&id).to_string_lossy().to_string();
    create_instance_structure(&id, matches!(instance_type, InstanceType::Server))?;

    let java_version = JavaManager::required_java_version(&req.version);

    let username = if let Some(u) = req.username {
        if u.trim().is_empty() {
            SettingsManager::get_default_username()?
        } else {
            Some(u)
        }
    } else {
        SettingsManager::get_default_username()?
    };

    let memory_min = req
        .memory_min
        .unwrap_or_else(|| SettingsManager::get_default_memory_min().unwrap_or(2048));
    let memory_max = req
        .memory_max
        .unwrap_or_else(|| SettingsManager::get_default_memory_max().unwrap_or(4096));
    let java_args = req
        .java_args
        .or_else(|| SettingsManager::get_default_java_args().ok().flatten());
    let game_args = req
        .game_args
        .or_else(|| SettingsManager::get_default_game_args().ok().flatten());

    let now = Utc::now().to_rfc3339();

    let instance = Instance {
        id: id.clone(),
        name: req.name.clone(),
        version: req.version.clone(),
        loader,
        loader_version: req.loader_version.clone(),
        instance_type,
        java_version: Some(java_version.to_string()),
        java_path: None,
        memory_min,
        memory_max,
        java_args: java_args.clone(),
        game_args: game_args.clone(),
        dir: dir.clone(),
        port: req.port,
        rcon_enabled: false,
        rcon_port: None,
        rcon_password: None,
        username: username.clone(),
        status: InstanceStatus::Installing,
        auto_restart: false,
        last_played: None,
        total_playtime: 0,
        notes: req.notes.clone(),
        installation_step: None,
        installation_error: None,
        backup_enabled: None, // None = использовать глобальную настройку
        created_at: now.clone(),
        updated_at: now.clone(),
    };

    let conn = get_db_conn()?;
    conn.execute(
        r#"INSERT INTO instances (
            id, name, version, loader, loader_version, instance_type,
            java_version, java_path, memory_min, memory_max, java_args, game_args,
            dir, port, rcon_enabled, rcon_port, rcon_password, username,
            status, pid, auto_restart, total_playtime, notes,
            installation_step, installation_error, backup_enabled,
            created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28)"#,
        params![
            id, req.name, req.version, loader_str, req.loader_version, instance_type_str,
            java_version.to_string(), None::<String>, memory_min, memory_max,
            java_args, game_args, dir, req.port, 0, None::<i32>, None::<String>, username,
            "installing", None::<i64>, 0, 0, req.notes,
            None::<String>, None::<String>, None::<i32>, // backup_enabled = NULL
            now.clone(), now,
        ],
    )?;

    // Создаём токен отмены для установки
    let operation_id = format!("instance-install-{}", id);
    let cancel_token = cancellation::create_token(&operation_id);

    let _ = app_handle.emit(
        "instance-creating",
        serde_json::json!({
            "id": id,
            "name": req.name,
            "status": "creating"
        }),
    );

    // Отправляем ID операции клиенту для возможности отмены
    let _ = app_handle.emit(
        "instance-operation-started",
        serde_json::json!({
            "operation_id": operation_id,
        }),
    );

    let instance_clone = instance.clone();
    let app_handle_clone = app_handle.clone();
    let operation_id_clone = operation_id.clone();

    tauri::async_runtime::spawn(async move {
        log::info!(
            "Starting background installation task for instance {}",
            instance_clone.id
        );

        let result = install_instance_async_cancellable(
            &instance_clone,
            app_handle_clone.clone(),
            &cancel_token,
        )
        .await;

        // Удаляем токен после завершения
        cancellation::remove_token(&operation_id_clone);

        log::info!(
            "Background installation task completed for instance {} with result: {:?}",
            instance_clone.id,
            result.is_ok()
        );

        match result {
            Ok(()) => {
                log::info!(
                    "Installation successful for instance {}, setting status to 'stopped'",
                    instance_clone.id
                );

                if let Ok(conn) = get_db_conn() {
                    // Очищаем поля установки при успехе
                    let _ = conn.execute(
                        "UPDATE instances SET status = 'stopped', installation_step = NULL, installation_error = NULL, updated_at = ?1 WHERE id = ?2",
                        params![Utc::now().to_rfc3339(), instance_clone.id],
                    );
                    log::info!(
                        "Status updated to 'stopped' in database for instance {}",
                        instance_clone.id
                    );
                }

                // Автоматически создаём snapshot для отслеживания изменений
                let inst_dir = instance_dir(&instance_clone.id);
                match modpacks::patch::create_instance_snapshot_async(
                    &instance_clone.id,
                    &instance_clone.name,
                    &instance_clone.version,
                    instance_clone.loader.as_str(),
                    instance_clone.loader_version.as_deref(),
                    &inst_dir,
                )
                .await
                {
                    Ok(snapshot) => {
                        if let Err(e) = modpacks::patch::save_snapshot(&inst_dir, &snapshot) {
                            log::warn!("Failed to save initial snapshot: {}", e);
                        } else {
                            log::info!(
                                "Created initial snapshot for instance {}",
                                instance_clone.id
                            );
                        }
                    }
                    Err(e) => {
                        log::warn!("Failed to create initial snapshot: {}", e);
                    }
                }

                let _ = app_handle_clone.emit(
                    "instance-created",
                    serde_json::json!({
                        "id": instance_clone.id,
                        "name": instance_clone.name
                    }),
                );
                log::info!(
                    "Emitted instance-created event for instance {}",
                    instance_clone.id
                );
            }
            Err(LauncherError::OperationCancelled) => {
                log::info!("Instance installation cancelled: {}", instance_clone.id);

                // Удаляем частично созданный экземпляр
                let instance_dir = crate::paths::instance_dir(&instance_clone.id);
                let _ = tokio::fs::remove_dir_all(&instance_dir).await;

                if let Ok(conn) = get_db_conn() {
                    let _ = conn.execute(
                        "DELETE FROM instances WHERE id = ?1",
                        params![instance_clone.id],
                    );
                }

                let _ = app_handle_clone.emit(
                    "instance-creation-failed",
                    serde_json::json!({
                        "id": instance_clone.id,
                        "error": "Установка отменена"
                    }),
                );
            }
            Err(e) => {
                log::error!("Failed to install instance {}: {}", instance_clone.id, e);

                if let Ok(conn) = get_db_conn() {
                    // Сохраняем ошибку в БД
                    let _ = conn.execute(
                        "UPDATE instances SET status = 'error', installation_error = ?1, updated_at = ?2 WHERE id = ?3",
                        params![e.to_string(), Utc::now().to_rfc3339(), instance_clone.id],
                    );
                }

                let _ = app_handle_clone.emit(
                    "instance-creation-failed",
                    serde_json::json!({
                        "id": instance_clone.id,
                        "error": e.to_string()
                    }),
                );
            }
        }
    });

    Ok(instance)
}

/// Обновление параметров экземпляра
#[tauri::command]
pub async fn update_instance(id: String, updates: serde_json::Value) -> Result<Instance> {
    {
        let conn = get_db_conn()?;

        let mut sql = String::from("UPDATE instances SET updated_at = ?1");
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(Utc::now().to_rfc3339())];
        let mut index = 2;

        if let Some(name) = updates.get("name").and_then(|v| v.as_str()) {
            sql.push_str(&format!(", name = ?{}", index));
            params.push(Box::new(name.to_string()));
            index += 1;
        }

        if let Some(memory_min) = updates.get("memory_min").and_then(|v| v.as_i64()) {
            sql.push_str(&format!(", memory_min = ?{}", index));
            params.push(Box::new(memory_min as i32));
            index += 1;
        }

        if let Some(memory_max) = updates.get("memory_max").and_then(|v| v.as_i64()) {
            sql.push_str(&format!(", memory_max = ?{}", index));
            params.push(Box::new(memory_max as i32));
            index += 1;
        }

        // backup_enabled: true/false для override, null для использования глобальной настройки
        if updates.get("backup_enabled").is_some() {
            sql.push_str(&format!(", backup_enabled = ?{}", index));
            let backup_val: Option<i32> = updates
                .get("backup_enabled")
                .and_then(|v| v.as_bool())
                .map(|b| if b { 1 } else { 0 });
            params.push(Box::new(backup_val));
            index += 1;
        }

        // auto_restart: автоматический перезапуск сервера при краше
        if let Some(auto_restart) = updates.get("auto_restart").and_then(|v| v.as_bool()) {
            sql.push_str(&format!(", auto_restart = ?{}", index));
            params.push(Box::new(if auto_restart { 1 } else { 0 }));
            index += 1;
        }

        sql.push_str(&format!(" WHERE id = ?{}", index));
        params.push(Box::new(id.clone()));

        conn.execute(
            &sql,
            rusqlite::params_from_iter(params.iter().map(|b| b.as_ref())),
        )?;
    }

    get_instance(id).await
}

/// Удаление экземпляра
#[tauri::command]
pub async fn delete_instance(id: String, state: State<'_, ChildMap>) -> Result<()> {
    log::info!("Deleting instance: {}", id);

    // Останавливаем процесс если запущен
    {
        let mut map = state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(mut child) = map.remove(&id) {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    // Получаем путь к директории
    let dir_path = {
        let conn = get_db_conn()?;
        let mut stmt = conn.prepare("SELECT dir FROM instances WHERE id = ?1")?;
        stmt.query_row(params![id.clone()], |row| row.get::<_, String>(0))?
    };

    // Удаляем из БД сразу (быстро)
    {
        let conn = get_db_conn()?;
        conn.execute("DELETE FROM instances WHERE id = ?1", params![id])?;
    }

    // Удаляем файлы в фоне (медленно, но не блокирует UI)
    let p = std::path::PathBuf::from(dir_path);
    if p.exists() {
        tokio::task::spawn_blocking(move || {
            if let Err(e) = std::fs::remove_dir_all(&p) {
                log::error!("Failed to remove instance directory: {}", e);
            } else {
                log::info!("Instance directory removed successfully");
            }
        });
    }

    log::info!("Instance deleted from DB: {}", id);
    Ok(())
}

/// Files and directories that should be preserved when resetting instance version
const USER_FILES_TO_PRESERVE: &[&str] = &[
    "options.txt",    // Game settings (music, graphics, controls)
    "servers.dat",    // Server list
    "saves",          // Worlds
    "resourcepacks",  // Resource packs
    "shaderpacks",    // Shaders
    "screenshots",    // Screenshots
    "schematics",     // Litematica/WorldEdit schematics
    "XaeroWorldMap",  // Xaero's World Map data
    "XaeroWaypoints", // Xaero's Minimap waypoints
    "journeymap",     // JourneyMap data
];

/// Reset instance version/loader while preserving user files (options.txt, saves, etc.)
/// This is used by QuickPlay to change versions without losing game settings.
#[tauri::command]
pub async fn reset_instance_version(
    id: String,
    new_version: String,
    new_loader: String,
    new_loader_version: Option<String>,
    app_handle: tauri::AppHandle,
) -> Result<Instance> {
    log::info!(
        "Resetting instance {} to version {} with loader {}",
        id,
        new_version,
        new_loader
    );

    // Get current instance
    let instance = get_instance(id.clone()).await?;
    let instance_path = std::path::PathBuf::from(&instance.dir);
    let temp_dir = instance_path.join(".user_backup_temp");

    // Backup and clear instance files in spawn_blocking
    let instance_path_clone = instance_path.clone();
    let temp_dir_for_backup = temp_dir.clone();
    let id_for_error = id.clone();
    tokio::task::spawn_blocking(move || {
        if !instance_path_clone.exists() {
            return Err(LauncherError::InstanceNotFound(id_for_error));
        }

        // Create temp directory for user files
        let temp_dir = temp_dir_for_backup;
        if temp_dir.exists() {
            let _ = std::fs::remove_dir_all(&temp_dir);
        }
        std::fs::create_dir_all(&temp_dir)?;

        // 1. Move user files to temp
        for file_name in USER_FILES_TO_PRESERVE {
            let src = instance_path_clone.join(file_name);
            let dst = temp_dir.join(file_name);

            if src.exists() {
                if src.is_dir() {
                    // Copy directory
                    if let Err(e) = copy_dir_all(&src, &dst) {
                        log::warn!("Failed to backup {}: {}", file_name, e);
                    } else {
                        log::info!("Backed up directory: {}", file_name);
                    }
                } else {
                    // Copy file
                    if let Err(e) = std::fs::copy(&src, &dst) {
                        log::warn!("Failed to backup {}: {}", file_name, e);
                    } else {
                        log::info!("Backed up file: {}", file_name);
                    }
                }
            }
        }

        // 2. Clear instance directory (except temp backup)
        for entry in std::fs::read_dir(&instance_path_clone)? {
            let entry = entry?;
            let path = entry.path();
            let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

            // Skip our temp backup directory
            if file_name == ".user_backup_temp" {
                continue;
            }

            if path.is_dir() {
                let _ = std::fs::remove_dir_all(&path);
            } else {
                let _ = std::fs::remove_file(&path);
            }
        }

        Ok::<_, LauncherError>(())
    })
    .await
    .map_err(|e| LauncherError::Join(e.to_string()))??;

    // 3. Re-create instance structure
    let is_server = matches!(instance.instance_type, InstanceType::Server);
    crate::paths::create_instance_structure(&id, is_server)?;

    // 4. Parse new loader (validates the loader type)
    let _loader = LoaderType::parse(&new_loader)
        .ok_or_else(|| LauncherError::InvalidConfig(format!("Invalid loader: {}", new_loader)))?;

    let java_version = JavaManager::required_java_version(&new_version);

    // 5. Update database
    {
        let conn = get_db_conn()?;
        conn.execute(
            r#"UPDATE instances SET
                version = ?1,
                loader = ?2,
                loader_version = ?3,
                java_version = ?4,
                status = 'installing',
                installation_step = NULL,
                installation_error = NULL,
                updated_at = ?5
            WHERE id = ?6"#,
            params![
                new_version,
                new_loader,
                new_loader_version,
                java_version.to_string(),
                Utc::now().to_rfc3339(),
                id
            ],
        )?;
    }

    // 6. Get updated instance
    let updated_instance = get_instance(id.clone()).await?;

    // 7. Restore user files from temp + 8. Clean up
    let temp_dir_clone = temp_dir.clone();
    let instance_path_clone2 = instance_path.clone();
    tokio::task::spawn_blocking(move || {
        // Restore user files
        for file_name in USER_FILES_TO_PRESERVE {
            let src = temp_dir_clone.join(file_name);
            let dst = instance_path_clone2.join(file_name);

            if src.exists() {
                if src.is_dir() {
                    if let Err(e) = copy_dir_all(&src, &dst) {
                        log::warn!("Failed to restore {}: {}", file_name, e);
                    } else {
                        log::info!("Restored directory: {}", file_name);
                    }
                } else {
                    if let Err(e) = std::fs::copy(&src, &dst) {
                        log::warn!("Failed to restore {}: {}", file_name, e);
                    } else {
                        log::info!("Restored file: {}", file_name);
                    }
                }
            }
        }

        // Clean up temp directory
        let _ = std::fs::remove_dir_all(&temp_dir_clone);
    })
    .await
    .map_err(|e| LauncherError::Join(e.to_string()))?;

    // 9. Start installation in background
    let operation_id = format!("instance-reset-{}", id);
    let cancel_token = cancellation::create_token(&operation_id);

    let _ = app_handle.emit(
        "instance-operation-started",
        serde_json::json!({ "operation_id": operation_id }),
    );

    let instance_for_install = updated_instance.clone();
    let app_handle_clone = app_handle.clone();
    let operation_id_clone = operation_id.clone();

    tauri::async_runtime::spawn(async move {
        log::info!(
            "Starting reinstallation for reset instance {}",
            instance_for_install.id
        );

        let result = install_instance_async_cancellable(
            &instance_for_install,
            app_handle_clone.clone(),
            &cancel_token,
        )
        .await;

        cancellation::remove_token(&operation_id_clone);

        match result {
            Ok(()) => {
                log::info!(
                    "Reset installation successful for {}",
                    instance_for_install.id
                );

                if let Ok(conn) = get_db_conn() {
                    let _ = conn.execute(
                        "UPDATE instances SET status = 'stopped', installation_step = NULL, installation_error = NULL, updated_at = ?1 WHERE id = ?2",
                        params![Utc::now().to_rfc3339(), instance_for_install.id],
                    );
                }

                // Обновляем snapshot после сброса версии
                let inst_dir = instance_dir(&instance_for_install.id);
                match modpacks::patch::create_instance_snapshot_async(
                    &instance_for_install.id,
                    &instance_for_install.name,
                    &instance_for_install.version,
                    instance_for_install.loader.as_str(),
                    instance_for_install.loader_version.as_deref(),
                    &inst_dir,
                )
                .await
                {
                    Ok(snapshot) => {
                        if let Err(e) = modpacks::patch::save_snapshot(&inst_dir, &snapshot) {
                            log::warn!("Failed to save snapshot after reset: {}", e);
                        } else {
                            log::info!("Updated snapshot for instance {}", instance_for_install.id);
                        }
                    }
                    Err(e) => {
                        log::warn!("Failed to create snapshot after reset: {}", e);
                    }
                }

                let _ = app_handle_clone.emit(
                    "instance-created",
                    serde_json::json!({
                        "id": instance_for_install.id,
                        "name": instance_for_install.name
                    }),
                );
            }
            Err(e) => {
                log::error!(
                    "Reset installation failed for {}: {}",
                    instance_for_install.id,
                    e
                );

                if let Ok(conn) = get_db_conn() {
                    let _ = conn.execute(
                        "UPDATE instances SET status = 'error', installation_error = ?1, updated_at = ?2 WHERE id = ?3",
                        params![e.to_string(), Utc::now().to_rfc3339(), instance_for_install.id],
                    );
                }

                let _ = app_handle_clone.emit(
                    "instance-creation-failed",
                    serde_json::json!({
                        "id": instance_for_install.id,
                        "error": e.to_string()
                    }),
                );
            }
        }
    });

    Ok(updated_instance)
}

/// Recursively copy a directory
fn copy_dir_all(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());

        if src_path.is_dir() {
            copy_dir_all(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}
