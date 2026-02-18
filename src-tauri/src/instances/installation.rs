use chrono::Utc;
use rusqlite::params;
use std::path::PathBuf;
use tauri::{Emitter, State};

use crate::cancellation;
use crate::db::get_db_conn;
use crate::downloader::DownloadManager;
use crate::error::{LauncherError, Result};
use crate::java::JavaManager;
use crate::loaders::LoaderManager;
use crate::minecraft::MinecraftInstaller;
use crate::modpacks;
use crate::types::{GameType, Instance, InstanceStatus, InstanceType, LoaderType};

use super::lifecycle::{get_instance, ChildMap};

/// Проверяет существование Forge version JSON (spawn_blocking для directory iteration)
async fn check_forge_version_exists(versions_dir: &std::path::Path, mc_version: &str) -> bool {
    if !versions_dir.exists() {  // sync .exists() is fine here — called before spawn_blocking
        return false;
    }
    let versions_dir = versions_dir.to_owned();
    let mc_version = mc_version.to_owned();
    tokio::task::spawn_blocking(move || {
        if let Ok(mut entries) = std::fs::read_dir(&versions_dir) {
            entries.any(|entry| {
                if let Ok(entry) = entry {
                    let name = entry.file_name().to_string_lossy().to_string();
                    name.contains("forge") && name.contains(&mc_version)
                } else {
                    false
                }
            })
        } else {
            false
        }
    })
    .await
    .unwrap_or(false)
}

async fn install_instance_async(instance: &Instance, app_handle: tauri::AppHandle) -> Result<()> {
    let download_manager = DownloadManager::new(app_handle.clone())?;
    // Создаём токен отмены для retry операций (не используется активно, но нужен для API)
    let cancel_token = tokio_util::sync::CancellationToken::new();

    let _ = app_handle.emit(
        "instance-install-progress",
        serde_json::json!({
            "id": instance.id,
            "step": "java",
            "message": "Установка Java..."
        }),
    );

    log::info!(
        "Installing Minecraft {} for instance {}",
        instance.version,
        instance.id
    );

    let java_path = if let Some(custom_path) = &instance.java_path {
        PathBuf::from(custom_path)
    } else {
        JavaManager::ensure_java(
            &instance.version,
            &download_manager,
            &cancel_token,
            Some(&instance.id),
        )
        .await?
    };

    log::info!("Java installed at: {:?}", java_path);

    let _ = app_handle.emit(
        "instance-install-progress",
        serde_json::json!({
            "id": instance.id,
            "step": "minecraft",
            "message": format!("Загрузка Minecraft {}...", instance.version)
        }),
    );

    let is_server = matches!(instance.instance_type, InstanceType::Server);
    MinecraftInstaller::install_version(&instance.version, is_server, &download_manager).await?;

    log::info!("Minecraft {} installed", instance.version);

    if !matches!(instance.loader, LoaderType::Vanilla) {
        let _ = app_handle.emit(
            "instance-install-progress",
            serde_json::json!({
                "id": instance.id,
                "step": "loader",
                "message": format!("Установка {:?}...", instance.loader)
            }),
        );

        log::info!("Installing loader: {:?}", instance.loader);

        LoaderManager::install_loader(
            &instance.id,
            &instance.version,
            instance.loader.clone(),
            instance.loader_version.as_deref(),
            is_server,
            &download_manager,
            &cancel_token,
        )
        .await?;

        log::info!("Loader installed");
    }

    // Notify frontend that instance installation (Java/MC/Loader) is done
    let _ = app_handle.emit(
        "instance-install-progress",
        serde_json::json!({
            "id": instance.id,
            "step": "complete",
            "message": ""
        }),
    );

    log::info!("Instance {} installation completed", instance.id);

    Ok(())
}

/// Версия install_instance_async с поддержкой отмены и параллельной загрузкой
pub(super) async fn install_instance_async_cancellable(
    instance: &Instance,
    app_handle: tauri::AppHandle,
    cancel_token: &tokio_util::sync::CancellationToken,
) -> Result<()> {
    let download_manager = DownloadManager::new(app_handle.clone())?;

    // Проверка отмены в начале
    if cancel_token.is_cancelled() {
        return Err(LauncherError::OperationCancelled);
    }

    let is_server = matches!(instance.instance_type, InstanceType::Server);

    // ============================================
    // ПАРАЛЛЕЛЬНАЯ ЗАГРУЗКА: Java + Minecraft + Forge Installer (если нужен)
    // ============================================
    // Все компоненты качаются одновременно для ускорения установки
    // Forge installer скачивается параллельно, но ЗАПУСКАЕТСЯ только после MC

    // Сохраняем начало параллельного этапа
    if let Ok(conn) = get_db_conn() {
        let _ = conn.execute(
            "UPDATE instances SET installation_step = 'java', updated_at = ?1 WHERE id = ?2",
            params![Utc::now().to_rfc3339(), instance.id],
        );
    }

    let needs_loader = !matches!(instance.loader, LoaderType::Vanilla);
    let loader_name = if needs_loader {
        format!(" + {:?} installer", instance.loader)
    } else {
        String::new()
    };

    let _ = app_handle.emit(
        "instance-install-progress",
        serde_json::json!({
            "id": instance.id,
            "step": "java",
            "message": format!("Загрузка Java + Minecraft{}...", loader_name)
        }),
    );

    log::info!(
        "Starting PARALLEL download: Java + Minecraft {}{} for instance {}",
        instance.version,
        loader_name,
        instance.id
    );

    // Подготавливаем данные для параллельных задач
    let dm_java = download_manager.clone();
    let dm_mc = download_manager.clone();
    let version_java = instance.version.clone();
    let version_mc = instance.version.clone();
    let custom_java_path = instance.java_path.clone();
    let cancel_java = cancel_token.clone();
    let cancel_mc = cancel_token.clone();
    let app_java = app_handle.clone();
    let app_mc = app_handle.clone();
    let instance_id_java = instance.id.clone();
    let instance_id_mc = instance.id.clone();

    // Запускаем Java загрузку с поддержкой отмены и зеркал
    let java_task = async move {
        if cancel_java.is_cancelled() {
            return Err(LauncherError::OperationCancelled);
        }

        let path = if let Some(custom_path) = custom_java_path {
            PathBuf::from(custom_path)
        } else {
            JavaManager::ensure_java(
                &version_java,
                &dm_java,
                &cancel_java,
                Some(&instance_id_java),
            )
            .await?
        };

        log::info!("Java installed at: {:?}", path);

        // Отправляем событие что Java готова
        let _ = app_java.emit(
            "instance-install-progress",
            serde_json::json!({
                "id": instance_id_java,
                "step": "java",
                "message": "Java установлена ✓"
            }),
        );

        Ok::<PathBuf, LauncherError>(path)
    };

    // Запускаем Minecraft загрузку
    let minecraft_task = async move {
        if cancel_mc.is_cancelled() {
            return Err(LauncherError::OperationCancelled);
        }

        // Обновляем прогресс
        let _ = app_mc.emit(
            "instance-install-progress",
            serde_json::json!({
                "id": instance_id_mc,
                "step": "minecraft",
                "message": format!("Загрузка Minecraft {}...", version_mc)
            }),
        );

        MinecraftInstaller::install_version(&version_mc, is_server, &dm_mc).await?;

        log::info!("Minecraft {} installed", version_mc);
        Ok::<(), LauncherError>(())
    };

    // Ждём завершения Java и Minecraft параллельно
    // try_join! aborts the second task early if the first fails
    let (_java_path, _) = tokio::try_join!(java_task, minecraft_task)?;

    // Проверка отмены после параллельной загрузки
    if cancel_token.is_cancelled() {
        return Err(LauncherError::OperationCancelled);
    }

    log::info!("Parallel download completed: Java + Minecraft");

    // ============================================
    // УСТАНОВКА ЗАГРУЗЧИКА (требует Java + MC)
    // ============================================
    if needs_loader {
        // Сохраняем начало этапа "loader"
        if let Ok(conn) = get_db_conn() {
            let _ = conn.execute(
                "UPDATE instances SET installation_step = 'loader', updated_at = ?1 WHERE id = ?2",
                params![Utc::now().to_rfc3339(), instance.id],
            );
        }

        let _ = app_handle.emit(
            "instance-install-progress",
            serde_json::json!({
                "id": instance.id,
                "step": "loader",
                "message": format!("Установка {:?}...", instance.loader)
            }),
        );

        log::info!("Installing loader: {:?}", instance.loader);

        LoaderManager::install_loader(
            &instance.id,
            &instance.version,
            instance.loader.clone(),
            instance.loader_version.as_deref(),
            is_server,
            &download_manager,
            cancel_token,
        )
        .await?;

        // Проверка отмены после loader (не нужна - уже проверяется в install_loader)
        log::info!("Loader installed");
    }

    // Notify frontend that instance installation (Java/MC/Loader) is done
    // This clears the "Загрузка библиотек Forge (29/29)..." message
    // so that modpack mod download progress becomes visible
    let _ = app_handle.emit(
        "instance-install-progress",
        serde_json::json!({
            "id": instance.id,
            "step": "complete",
            "message": ""
        }),
    );

    log::info!("Instance {} installation completed", instance.id);

    Ok(())
}

#[tauri::command]
pub async fn reinstall_instance(
    id: String,
    app_handle: tauri::AppHandle,
    state: State<'_, ChildMap>,
) -> Result<()> {
    let instance = get_instance(id.clone()).await?;

    {
        let map = state.lock().unwrap_or_else(|e| e.into_inner());
        if map.contains_key(&id) {
            return Err(LauncherError::InvalidConfig(
                "Cannot reinstall running instance. Please stop it first.".to_string(),
            ));
        }
    }

    {
        let conn = get_db_conn()?;
        conn.execute(
            "UPDATE instances SET status = 'installing', updated_at = ?1 WHERE id = ?2",
            params![Utc::now().to_rfc3339(), id],
        )?;
    }

    let _ = app_handle.emit(
        "instance-reinstalling",
        serde_json::json!({
            "id": id,
            "status": "installing"
        }),
    );

    let operation_id = format!("instance-reinstall-{}", id);
    let cancel_token = cancellation::create_token(&operation_id);

    let instance_clone = instance.clone();
    let app_handle_clone = app_handle.clone();
    let operation_id_clone = operation_id.clone();

    tauri::async_runtime::spawn(async move {
        let result = install_instance_async_cancellable(
            &instance_clone,
            app_handle_clone.clone(),
            &cancel_token,
        )
        .await;

        // Clean up cancellation token
        cancellation::remove_token(&operation_id_clone);

        match result {
            Ok(()) => {
                if let Ok(conn) = get_db_conn() {
                    let _ = conn.execute(
                        "UPDATE instances SET status = 'stopped', updated_at = ?1 WHERE id = ?2",
                        params![Utc::now().to_rfc3339(), instance_clone.id],
                    );
                }

                let _ = app_handle_clone.emit(
                    "instance-reinstalled",
                    serde_json::json!({
                        "id": instance_clone.id,
                        "name": instance_clone.name
                    }),
                );
            }
            Err(LauncherError::OperationCancelled) => {
                log::info!("Reinstallation cancelled for instance {}", instance_clone.id);

                if let Ok(conn) = get_db_conn() {
                    let _ = conn.execute(
                        "UPDATE instances SET status = 'stopped', updated_at = ?1 WHERE id = ?2",
                        params![Utc::now().to_rfc3339(), instance_clone.id],
                    );
                }

                let _ = app_handle_clone.emit(
                    "instance-reinstall-failed",
                    serde_json::json!({
                        "id": instance_clone.id,
                        "error": "Переустановка отменена"
                    }),
                );
            }
            Err(e) => {
                log::error!("Failed to reinstall instance {}: {}", instance_clone.id, e);

                if let Ok(conn) = get_db_conn() {
                    let _ = conn.execute(
                        "UPDATE instances SET status = 'error', updated_at = ?1 WHERE id = ?2",
                        params![Utc::now().to_rfc3339(), instance_clone.id],
                    );
                }

                let _ = app_handle_clone.emit(
                    "instance-reinstall-failed",
                    serde_json::json!({
                        "id": instance_clone.id,
                        "error": e.to_string()
                    }),
                );
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn repair_instance(
    id: String,
    app_handle: tauri::AppHandle,
    state: State<'_, ChildMap>,
) -> Result<()> {
    let instance = get_instance(id.clone()).await?;

    {
        let map = state.lock().unwrap_or_else(|e| e.into_inner());
        if map.contains_key(&id) {
            return Err(LauncherError::InvalidConfig(
                "Cannot repair running instance. Please stop it first.".to_string(),
            ));
        }
    }

    {
        let conn = get_db_conn()?;
        conn.execute(
            "UPDATE instances SET status = 'installing', updated_at = ?1 WHERE id = ?2",
            params![Utc::now().to_rfc3339(), id],
        )?;
    }

    let _ = app_handle.emit(
        "instance-repairing",
        serde_json::json!({
            "id": id,
            "status": "repairing"
        }),
    );

    let operation_id = format!("instance-repair-{}", id);
    let cancel_token = cancellation::create_token(&operation_id);

    let instance_clone = instance.clone();
    let app_handle_clone = app_handle.clone();
    let operation_id_clone = operation_id.clone();

    tauri::async_runtime::spawn(async move {
        let result =
            repair_instance_async(&instance_clone, app_handle_clone.clone(), &cancel_token).await;

        // Clean up cancellation token
        cancellation::remove_token(&operation_id_clone);

        match result {
            Ok(()) => {
                if let Ok(conn) = get_db_conn() {
                    let _ = conn.execute(
                        "UPDATE instances SET status = 'stopped', updated_at = ?1 WHERE id = ?2",
                        params![Utc::now().to_rfc3339(), instance_clone.id],
                    );
                }

                let _ = app_handle_clone.emit(
                    "instance-repaired",
                    serde_json::json!({
                        "id": instance_clone.id,
                        "name": instance_clone.name
                    }),
                );
            }
            Err(LauncherError::OperationCancelled) => {
                log::info!("Repair cancelled for instance {}", instance_clone.id);

                if let Ok(conn) = get_db_conn() {
                    let _ = conn.execute(
                        "UPDATE instances SET status = 'stopped', updated_at = ?1 WHERE id = ?2",
                        params![Utc::now().to_rfc3339(), instance_clone.id],
                    );
                }

                let _ = app_handle_clone.emit(
                    "instance-repair-failed",
                    serde_json::json!({
                        "id": instance_clone.id,
                        "error": "Восстановление отменено"
                    }),
                );
            }
            Err(e) => {
                log::error!("Failed to repair instance {}: {}", instance_clone.id, e);

                if let Ok(conn) = get_db_conn() {
                    let _ = conn.execute(
                        "UPDATE instances SET status = 'error', installation_error = ?1, installation_step = 'repair', updated_at = ?2 WHERE id = ?3",
                        params![e.to_string(), Utc::now().to_rfc3339(), instance_clone.id],
                    );
                }

                let _ = app_handle_clone.emit(
                    "instance-repair-failed",
                    serde_json::json!({
                        "id": instance_clone.id,
                        "error": e.to_string()
                    }),
                );
            }
        }
    });

    Ok(())
}

async fn repair_instance_async(
    instance: &Instance,
    app_handle: tauri::AppHandle,
    cancel_token: &tokio_util::sync::CancellationToken,
) -> Result<()> {
    let download_manager = DownloadManager::new(app_handle.clone())?;

    // Проверка отмены в начале
    if cancel_token.is_cancelled() {
        return Err(LauncherError::OperationCancelled);
    }

    let _ = app_handle.emit(
        "instance-install-progress",
        serde_json::json!({
            "id": instance.id,
            "step": "checking",
            "message": "Проверка файлов..."
        }),
    );

    log::info!("Repairing instance {} ({})", instance.name, instance.id);

    // Проверяем и восстанавливаем Java
    let _ = app_handle.emit(
        "instance-install-progress",
        serde_json::json!({
            "id": instance.id,
            "step": "java",
            "message": "Проверка Java..."
        }),
    );

    let java_path = if let Some(custom_path) = &instance.java_path {
        PathBuf::from(custom_path)
    } else {
        JavaManager::ensure_java(
            &instance.version,
            &download_manager,
            &cancel_token,
            Some(&instance.id),
        )
        .await?
    };

    log::info!("Java verified at: {:?}", java_path);

    // Проверка отмены после Java
    if cancel_token.is_cancelled() {
        return Err(LauncherError::OperationCancelled);
    }

    // Проверяем и восстанавливаем Minecraft файлы
    let _ = app_handle.emit(
        "instance-install-progress",
        serde_json::json!({
            "id": instance.id,
            "step": "minecraft",
            "message": format!("Проверка Minecraft {}...", instance.version)
        }),
    );

    let is_server = matches!(instance.instance_type, InstanceType::Server);

    // Проверяем наличие основных файлов Minecraft
    let instance_path = PathBuf::from(&instance.dir);
    let version_json_path = instance_path
        .join("versions")
        .join(&instance.version)
        .join(format!("{}.json", &instance.version));

    let needs_minecraft_repair = !version_json_path.exists();

    if needs_minecraft_repair {
        log::info!("Minecraft files missing, repairing...");
        MinecraftInstaller::install_version(&instance.version, is_server, &download_manager)
            .await?;
        log::info!("Minecraft {} repaired", instance.version);
    } else {
        log::info!("Minecraft files OK");
    }

    // Проверка отмены после Minecraft
    if cancel_token.is_cancelled() {
        return Err(LauncherError::OperationCancelled);
    }

    // Проверяем и восстанавливаем загрузчик, если он не Vanilla
    if !matches!(instance.loader, LoaderType::Vanilla) {
        let _ = app_handle.emit(
            "instance-install-progress",
            serde_json::json!({
                "id": instance.id,
                "step": "loader",
                "message": format!("Проверка {:?}...", instance.loader)
            }),
        );

        // Проверяем наличие профиля загрузчика
        let loader_profile_exists = match instance.loader {
            LoaderType::Fabric => instance_path.join("fabric-profile.json").exists(),
            LoaderType::Quilt => instance_path.join("quilt-profile.json").exists(),
            LoaderType::NeoForge => {
                instance_path.join("neoforge-profile.json").exists()
            }
            LoaderType::Forge => {
                // Для Forge ищем version JSON (spawn_blocking для directory iteration)
                let versions_dir = instance_path.join("versions");
                let mc_version = instance.version.clone();
                check_forge_version_exists(&versions_dir, &mc_version).await
            }
            LoaderType::Vanilla => true,
        };

        if !loader_profile_exists {
            log::info!("Loader files missing, repairing...");
            LoaderManager::install_loader(
                &instance.id,
                &instance.version,
                instance.loader.clone(),
                instance.loader_version.as_deref(),
                is_server,
                &download_manager,
                &cancel_token,
            )
            .await?;
            log::info!("Loader repaired");
        } else {
            log::info!("Loader files OK");
        }
    }

    log::info!("Instance {} repair completed", instance.id);

    Ok(())
}

/// Повторная попытка установки экземпляра после ошибки
#[tauri::command]
pub async fn retry_instance_installation(
    instance_id: String,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    log::info!("Retrying installation for instance {}", instance_id);

    let conn = get_db_conn()?;

    // Получаем данные экземпляра
    let instance: Instance = conn.query_row(
        r#"SELECT
            id, name, game_type, version, loader, loader_version, instance_type,
            java_version, java_path, memory_min, memory_max, java_args, game_args,
            dir, port, rcon_enabled, rcon_port, rcon_password, username,
            status, pid, auto_restart, last_played, total_playtime, notes,
            installation_step, installation_error, backup_enabled,
            created_at, updated_at
         FROM instances WHERE id = ?1"#,
        params![instance_id],
        |row| {
            let game_type_str: String = row.get(2)?;
            let loader_str: String = row.get(4)?;
            let instance_type_str: String = row.get(6)?;
            let status_str: String = row.get(19)?;

            Ok(Instance {
                id: row.get(0)?,
                name: row.get(1)?,
                game_type: GameType::parse(&game_type_str).unwrap_or(GameType::Minecraft),
                version: row.get(3)?,
                loader: LoaderType::parse(&loader_str).unwrap_or(LoaderType::Vanilla),
                loader_version: row.get(5)?,
                instance_type: if instance_type_str == "server" {
                    InstanceType::Server
                } else {
                    InstanceType::Client
                },
                java_version: row.get(7)?,
                java_path: row.get(8)?,
                memory_min: row.get(9)?,
                memory_max: row.get(10)?,
                java_args: row.get(11)?,
                game_args: row.get(12)?,
                dir: row.get(13)?,
                port: row.get(14)?,
                rcon_enabled: row.get::<_, i32>(15)? != 0,
                rcon_port: row.get(16)?,
                rcon_password: row.get(17)?,
                username: row.get(18)?,
                status: InstanceStatus::parse(&status_str),
                auto_restart: row.get::<_, i32>(21)? != 0,
                last_played: row.get(22)?,
                total_playtime: row.get::<_, Option<i64>>(23)?.unwrap_or(0),
                notes: row.get(24)?,
                installation_step: row.get(25)?,
                installation_error: row.get(26)?,
                backup_enabled: row.get::<_, Option<i32>>(27)?.map(|v| v != 0),
                created_at: row.get(28)?,
                updated_at: row.get(29)?,
            })
        },
    )?;

    // Проверяем, что экземпляр в статусе error
    if !matches!(instance.status, InstanceStatus::Error) {
        return Err(LauncherError::InvalidConfig(
            "Instance is not in error state".to_string(),
        ));
    }

    // Сбрасываем статус и ошибку, переводим в installing
    conn.execute(
        "UPDATE instances SET status = 'installing', installation_step = NULL, installation_error = NULL, updated_at = ?1 WHERE id = ?2",
        params![Utc::now().to_rfc3339(), instance_id],
    )?;

    // Создаём токен отмены для установки
    let operation_id = format!("instance-install-{}", instance_id);
    let cancel_token = cancellation::create_token(&operation_id);

    let _ = app_handle.emit(
        "instance-creating",
        serde_json::json!({
            "id": instance_id,
            "name": instance.name,
            "status": "creating"
        }),
    );

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
            "Starting background installation task for instance {} (retry)",
            instance_clone.id
        );

        let result = install_instance_async_cancellable(
            &instance_clone,
            app_handle_clone.clone(),
            &cancel_token,
        )
        .await;

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
                    let _ = conn.execute(
                        "UPDATE instances SET status = 'stopped', installation_step = NULL, installation_error = NULL, updated_at = ?1 WHERE id = ?2",
                        params![Utc::now().to_rfc3339(), instance_clone.id],
                    );
                }

                // Автоматически создаём snapshot для отслеживания изменений
                let instance_dir = PathBuf::from(&instance_clone.dir);
                match modpacks::patch::create_instance_snapshot_async(
                    &instance_clone.id,
                    &instance_clone.name,
                    &instance_clone.version,
                    instance_clone.loader.as_str(),
                    instance_clone.loader_version.as_deref(),
                    &instance_dir,
                )
                .await
                {
                    Ok(snapshot) => {
                        if let Err(e) = modpacks::patch::save_snapshot(&instance_dir, &snapshot) {
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
            }
            Err(LauncherError::OperationCancelled) => {
                log::info!("Instance installation cancelled: {}", instance_clone.id);

                if let Ok(conn) = get_db_conn() {
                    let _ = conn.execute(
                        "UPDATE instances SET status = 'error', installation_error = 'Установка отменена', updated_at = ?1 WHERE id = ?2",
                        params![Utc::now().to_rfc3339(), instance_clone.id],
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

    Ok(())
}
