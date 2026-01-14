//! Модуль автоматического исправления проблем
//!
//! Применяет автофиксы, определённые в log_analyzer, к экземплярам Minecraft.

use crate::api::curseforge::CurseForgeClient;
use crate::db::get_db_conn;
use crate::downloader::DownloadManager;
use crate::error::{LauncherError, Result};
use crate::loaders::LoaderManager;
use crate::paths::instances_dir;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use stuzhik_core::{AutoFix, LoaderType};
use tauri::AppHandle;
use tokio_util::sync::CancellationToken;

/// Результат применения автофикса
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoFixResult {
    /// Успешно ли применён фикс
    pub success: bool,
    /// Сообщение о результате
    pub message: String,
    /// Требуется ли перезапуск экземпляра
    pub requires_restart: bool,
    /// Детали применённых изменений
    pub details: Option<String>,
}

/// Применить автофикс к экземпляру
pub async fn apply_auto_fix(
    instance_id: &str,
    fix: AutoFix,
    app_handle: AppHandle,
) -> Result<AutoFixResult> {
    log::info!("Applying auto-fix to instance {}: {:?}", instance_id, fix);

    match fix {
        AutoFix::RemoveMod { filename } => remove_mod_fix(instance_id, &filename).await,

        AutoFix::DownloadMod {
            name,
            source,
            project_id,
        } => download_mod_fix(instance_id, &name, &source, &project_id, app_handle).await,

        AutoFix::ChangeJvmArg { old_arg, new_arg } => {
            change_jvm_arg_fix(instance_id, old_arg.as_deref(), &new_arg).await
        }

        AutoFix::IncreaseRam { recommended_mb } => {
            increase_ram_fix(instance_id, recommended_mb).await
        }

        AutoFix::ReinstallMod { filename } => {
            reinstall_mod_fix(instance_id, &filename, app_handle).await
        }

        AutoFix::DeleteConfig { path } => delete_config_fix(instance_id, &path).await,

        AutoFix::InstallJava { version } => install_java_fix(version, app_handle).await,

        AutoFix::UpdateLoader { loader } => {
            update_loader_fix(instance_id, &loader, app_handle).await
        }

        AutoFix::ResetConfigs => reset_configs_fix(instance_id).await,

        AutoFix::VerifyFiles => verify_files_fix(instance_id).await,
    }
}

// ============ Реализации отдельных фиксов ============

/// Удалить мод из экземпляра
async fn remove_mod_fix(instance_id: &str, filename: &str) -> Result<AutoFixResult> {
    let mods_dir = instances_dir().join(instance_id).join("mods");
    let file_path = mods_dir.join(filename);

    if !tokio::fs::try_exists(&file_path).await.unwrap_or(false) {
        return Ok(AutoFixResult {
            success: false,
            message: format!("Файл мода '{}' не найден", filename),
            requires_restart: false,
            details: None,
        });
    }

    // Создаём backup перед удалением
    let backup_dir = instances_dir()
        .join(instance_id)
        .join(".backup")
        .join("mods");
    tokio::fs::create_dir_all(&backup_dir).await?;

    let backup_path = backup_dir.join(filename);
    tokio::fs::copy(&file_path, &backup_path).await?;

    // Удаляем файл
    tokio::fs::remove_file(&file_path).await?;

    // Удаляем из БД если есть
    if let Ok(conn) = get_db_conn() {
        let _ = conn.execute(
            "DELETE FROM mods WHERE instance_id = ?1 AND file_name = ?2",
            params![instance_id, filename],
        );
    }

    log::info!("Removed mod '{}' from instance {}", filename, instance_id);

    Ok(AutoFixResult {
        success: true,
        message: format!("Мод '{}' удалён", filename),
        requires_restart: true,
        details: Some(format!("Backup создан в .backup/mods/{}", filename)),
    })
}

/// Скачать и установить мод
async fn download_mod_fix(
    instance_id: &str,
    name: &str,
    source: &str,
    project_id: &str,
    app_handle: AppHandle,
) -> Result<AutoFixResult> {
    // Получаем версию и загрузчик экземпляра
    let (mc_version, loader) = get_instance_info(instance_id)?;

    log::info!(
        "Downloading mod {} from {} (project: {}) for MC {} with {}",
        name,
        source,
        project_id,
        mc_version,
        loader
    );

    let download_manager = DownloadManager::new(app_handle)?;

    // Используем существующую логику установки модов
    match source.to_lowercase().as_str() {
        "modrinth" => {
            // Пробуем Modrinth
            let modrinth_result = crate::mods::ModManager::install_from_modrinth(
                instance_id,
                project_id,
                &mc_version,
                &loader,
                None,
                &download_manager,
            )
            .await;

            match modrinth_result {
                Ok(_) => {
                    return Ok(AutoFixResult {
                        success: true,
                        message: format!("Мод '{}' установлен", name),
                        requires_restart: true,
                        details: Some("Источник: Modrinth".to_string()),
                    });
                }
                Err(e) => {
                    // Modrinth не нашёл - пробуем CurseForge
                    log::warn!(
                        "Modrinth failed for '{}': {}. Trying CurseForge fallback...",
                        name,
                        e
                    );

                    match try_curseforge_fallback(
                        instance_id,
                        name,
                        &mc_version,
                        &loader,
                        &download_manager,
                    )
                    .await
                    {
                        Ok(result) => return Ok(result),
                        Err(cf_error) => {
                            // Оба источника не нашли мод
                            log::error!(
                                "Both Modrinth and CurseForge failed for '{}': Modrinth: {}, CurseForge: {}",
                                name, e, cf_error
                            );
                            return Ok(AutoFixResult {
                                success: false,
                                message: format!("Мод '{}' не найден", name),
                                requires_restart: false,
                                details: Some(format!(
                                    "Попробуйте найти мод вручную:\n\
                                     • Modrinth: https://modrinth.com/mods?q={}\n\
                                     • CurseForge: https://www.curseforge.com/minecraft/mc-mods/search?search={}",
                                    urlencoding::encode(name),
                                    urlencoding::encode(name)
                                )),
                            });
                        }
                    }
                }
            }
        }
        "curseforge" => {
            // CurseForge требует числовой ID
            let project_id_num: u64 = project_id.parse().map_err(|_| {
                LauncherError::InvalidConfig(format!(
                    "Invalid CurseForge project ID: {}",
                    project_id
                ))
            })?;

            crate::mods::ModManager::install_from_curseforge(
                instance_id,
                project_id_num,
                &mc_version,
                &loader,
                None,
                &download_manager,
            )
            .await?;
        }
        _ => {
            return Ok(AutoFixResult {
                success: false,
                message: format!("Неизвестный источник: {}", source),
                requires_restart: false,
                details: None,
            });
        }
    }

    Ok(AutoFixResult {
        success: true,
        message: format!("Мод '{}' установлен", name),
        requires_restart: true,
        details: Some(format!("Источник: {}", source)),
    })
}

/// Попытка найти и установить мод через CurseForge
async fn try_curseforge_fallback(
    instance_id: &str,
    mod_name: &str,
    mc_version: &str,
    loader: &str,
    download_manager: &DownloadManager,
) -> Result<AutoFixResult> {
    let cf_client = CurseForgeClient::new()?;

    // Пробуем разные варианты поиска
    let search_queries = generate_search_variants(mod_name);

    let mut all_results = Vec::new();
    for query in &search_queries {
        if let Ok(result) = cf_client
            .search_mods(query, Some(mc_version), Some(loader), 10, 0)
            .await
        {
            all_results.extend(result.data);
        }
    }

    if all_results.is_empty() {
        return Err(LauncherError::ModNotFound(format!(
            "Mod '{}' not found on CurseForge",
            mod_name
        )));
    }

    // Ищем наиболее точное совпадение
    let best_match = find_best_match(&all_results, mod_name);

    log::info!(
        "Found mod on CurseForge: {} (ID: {}) for search '{}'",
        best_match.name,
        best_match.id,
        mod_name
    );

    // Устанавливаем мод
    crate::mods::ModManager::install_from_curseforge(
        instance_id,
        best_match.id,
        mc_version,
        loader,
        None,
        download_manager,
    )
    .await?;

    Ok(AutoFixResult {
        success: true,
        message: format!("Мод '{}' установлен (CurseForge)", best_match.name),
        requires_restart: true,
        details: Some(format!(
            "Найден через CurseForge: {} (ID: {})",
            best_match.name, best_match.id
        )),
    })
}

/// Генерирует варианты поиска для имени мода
fn generate_search_variants(mod_name: &str) -> Vec<String> {
    let mut variants = vec![mod_name.to_string()];

    // Если имя слитное (gamestages), пробуем разделить
    // gamestages -> game stages, game-stages
    let lower = mod_name.to_lowercase();

    // Попробуем вставить пробел перед заглавными или известными словами
    let common_suffixes = [
        "stages", "craft", "lib", "api", "mod", "plus", "tweaks", "utils",
    ];
    for suffix in common_suffixes {
        if lower.ends_with(suffix) && lower.len() > suffix.len() {
            let prefix = &mod_name[..mod_name.len() - suffix.len()];
            variants.push(format!("{} {}", prefix, suffix));
        }
    }

    // Если есть дефис или подчёркивание - заменяем на пробел
    if mod_name.contains('-') || mod_name.contains('_') {
        variants.push(mod_name.replace('-', " ").replace('_', " "));
    }

    variants
}

/// Находит наиболее подходящий мод из списка результатов
fn find_best_match<'a>(
    results: &'a [crate::api::curseforge::CurseForgeMod],
    search_term: &str,
) -> &'a crate::api::curseforge::CurseForgeMod {
    let search_lower = search_term.to_lowercase().replace(['-', '_', ' '], "");

    // Сортируем по релевантности
    let mut scored: Vec<_> = results
        .iter()
        .map(|m| {
            let name_lower = m.name.to_lowercase().replace(['-', '_', ' '], "");
            let slug_lower = m.slug.to_lowercase().replace(['-', '_', ' '], "");

            let mut score = 0i32;

            // Точное совпадение slug - лучший результат
            if slug_lower == search_lower {
                score += 1000;
            }

            // Точное совпадение имени (без пробелов)
            if name_lower == search_lower {
                score += 900;
            }

            // Slug начинается с поискового запроса
            if slug_lower.starts_with(&search_lower) {
                score += 500;
            }

            // Имя начинается с поискового запроса
            if name_lower.starts_with(&search_lower) {
                score += 400;
            }

            // Slug содержит поисковый запрос
            if slug_lower.contains(&search_lower) {
                score += 200;
            }

            // Имя содержит поисковый запрос
            if name_lower.contains(&search_lower) {
                score += 100;
            }

            // Штраф за "helper", "addon", "compat" в названии
            // (эти моды обычно зависят от основного мода)
            let penalty_words = [
                "helper",
                "addon",
                "compat",
                "compatibility",
                "integration",
                "patch",
                "fix",
            ];
            for word in penalty_words {
                if name_lower.contains(word) || slug_lower.contains(word) {
                    score -= 300;
                }
            }

            // Бонус за популярность (но не слишком большой)
            score += (m.download_count as f64).log10() as i32;

            (m, score)
        })
        .collect();

    // Сортируем по убыванию score
    scored.sort_by(|a, b| b.1.cmp(&a.1));

    log::debug!(
        "CurseForge search scores for '{}': {:?}",
        search_term,
        scored
            .iter()
            .take(5)
            .map(|(m, s)| (&m.name, *s))
            .collect::<Vec<_>>()
    );

    scored.first().map(|(m, _)| *m).unwrap_or(&results[0])
}

/// Изменить JVM аргумент
async fn change_jvm_arg_fix(
    instance_id: &str,
    old_arg: Option<&str>,
    new_arg: &str,
) -> Result<AutoFixResult> {
    let conn = get_db_conn()?;

    // Получаем текущие JVM аргументы экземпляра
    let current_args: Option<String> = conn
        .query_row(
            "SELECT jvm_args FROM instances WHERE id = ?1",
            [instance_id],
            |row| row.get(0),
        )
        .ok();

    let mut args = current_args.unwrap_or_default();

    // Если указан старый аргумент - заменяем его
    if let Some(old) = old_arg {
        if args.contains(old) {
            args = args.replace(old, new_arg);
        } else {
            // Старый аргумент не найден - просто добавляем новый
            if !args.is_empty() {
                args.push(' ');
            }
            args.push_str(new_arg);
        }
    } else {
        // Просто добавляем новый аргумент
        if !args.is_empty() {
            args.push(' ');
        }
        args.push_str(new_arg);
    }

    // Обновляем в БД
    conn.execute(
        "UPDATE instances SET jvm_args = ?1 WHERE id = ?2",
        params![args, instance_id],
    )?;

    let message = if let Some(old) = old_arg {
        format!("JVM аргумент '{}' заменён на '{}'", old, new_arg)
    } else {
        format!("Добавлен JVM аргумент '{}'", new_arg)
    };

    Ok(AutoFixResult {
        success: true,
        message,
        requires_restart: true,
        details: Some(format!("Текущие аргументы: {}", args)),
    })
}

/// Увеличить выделенную память
async fn increase_ram_fix(instance_id: &str, recommended_mb: u32) -> Result<AutoFixResult> {
    let conn = get_db_conn()?;

    // Получаем текущую память
    let current_max: Option<i32> = conn
        .query_row(
            "SELECT memory_max FROM instances WHERE id = ?1",
            [instance_id],
            |row| row.get(0),
        )
        .ok()
        .flatten();

    let current = current_max.unwrap_or(2048) as u32;

    if current >= recommended_mb {
        return Ok(AutoFixResult {
            success: true,
            message: format!(
                "Память уже достаточна: {} MB (рекомендовано {} MB)",
                current, recommended_mb
            ),
            requires_restart: false,
            details: None,
        });
    }

    // Проверяем доступную системную память
    let mut sys = sysinfo::System::new_all();
    sys.refresh_memory();
    let total_mb = sys.total_memory() / 1024 / 1024;

    // Не выделяем больше 75% системной памяти
    let max_allowed = (total_mb as f64 * 0.75) as u32;
    let new_memory = recommended_mb.min(max_allowed);

    // Обновляем в БД
    conn.execute(
        "UPDATE instances SET memory_max = ?1 WHERE id = ?2",
        params![new_memory as i32, instance_id],
    )?;

    log::info!(
        "Increased RAM for instance {} from {} MB to {} MB",
        instance_id,
        current,
        new_memory
    );

    Ok(AutoFixResult {
        success: true,
        message: format!("Память увеличена до {} MB", new_memory),
        requires_restart: true,
        details: Some(format!(
            "Было: {} MB, стало: {} MB (системная память: {} MB)",
            current, new_memory, total_mb
        )),
    })
}

/// Переустановить мод (удалить и скачать заново)
async fn reinstall_mod_fix(
    instance_id: &str,
    filename: &str,
    app_handle: AppHandle,
) -> Result<AutoFixResult> {
    // Получаем информацию о моде из БД
    let conn = get_db_conn()?;

    let mod_info: Option<(String, String, String)> = conn
        .query_row(
            "SELECT slug, source, project_id FROM mods WHERE instance_id = ?1 AND file_name = ?2",
            params![instance_id, filename],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .ok();

    // Удаляем текущий файл
    let mods_dir = instances_dir().join(instance_id).join("mods");
    let file_path = mods_dir.join(filename);

    if tokio::fs::try_exists(&file_path).await.unwrap_or(false) {
        // Backup
        let backup_dir = instances_dir()
            .join(instance_id)
            .join(".backup")
            .join("mods");
        tokio::fs::create_dir_all(&backup_dir).await?;
        let backup_path = backup_dir.join(filename);
        tokio::fs::copy(&file_path, &backup_path).await?;

        tokio::fs::remove_file(&file_path).await?;
    }

    // Если есть информация о моде - переустанавливаем
    if let Some((slug, source, project_id)) = mod_info {
        // Получаем версию экземпляра
        let (mc_version, loader) = get_instance_info(instance_id)?;
        let download_manager = DownloadManager::new(app_handle)?;

        match source.as_str() {
            "modrinth" => {
                crate::mods::ModManager::install_from_modrinth(
                    instance_id,
                    &slug,
                    &mc_version,
                    &loader,
                    None,
                    &download_manager,
                )
                .await?;
            }
            "curseforge" => {
                if let Ok(id) = project_id.parse::<u64>() {
                    crate::mods::ModManager::install_from_curseforge(
                        instance_id,
                        id,
                        &mc_version,
                        &loader,
                        None,
                        &download_manager,
                    )
                    .await?;
                }
            }
            _ => {
                return Ok(AutoFixResult {
                    success: false,
                    message: format!(
                        "Не удалось переустановить мод: неизвестный источник '{}'",
                        source
                    ),
                    requires_restart: false,
                    details: None,
                });
            }
        }

        Ok(AutoFixResult {
            success: true,
            message: format!("Мод '{}' переустановлен", slug),
            requires_restart: true,
            details: Some("Старая версия сохранена в .backup/mods/".to_string()),
        })
    } else {
        Ok(AutoFixResult {
            success: false,
            message: format!(
                "Не удалось найти информацию о моде '{}' для переустановки",
                filename
            ),
            requires_restart: false,
            details: Some(
                "Мод не найден в базе данных. Возможно, он был установлен вручную.".to_string(),
            ),
        })
    }
}

/// Удалить файл конфигурации
async fn delete_config_fix(instance_id: &str, config_path: &str) -> Result<AutoFixResult> {
    let instance_dir = instances_dir().join(instance_id);

    // Защита от path traversal
    let full_path = instance_dir.join(config_path);
    if !full_path.starts_with(&instance_dir) {
        return Ok(AutoFixResult {
            success: false,
            message: "Недопустимый путь к конфигу".to_string(),
            requires_restart: false,
            details: None,
        });
    }

    if !tokio::fs::try_exists(&full_path).await.unwrap_or(false) {
        return Ok(AutoFixResult {
            success: false,
            message: format!("Файл конфига '{}' не найден", config_path),
            requires_restart: false,
            details: None,
        });
    }

    // Backup
    let backup_dir = instances_dir()
        .join(instance_id)
        .join(".backup")
        .join("config");
    tokio::fs::create_dir_all(&backup_dir).await?;

    let backup_filename = config_path.replace(['/', '\\'], "_");
    let backup_path = backup_dir.join(&backup_filename);
    tokio::fs::copy(&full_path, &backup_path).await?;

    // Удаляем
    tokio::fs::remove_file(&full_path).await?;

    Ok(AutoFixResult {
        success: true,
        message: format!("Конфиг '{}' удалён", config_path),
        requires_restart: true,
        details: Some(format!("Backup: .backup/config/{}", backup_filename)),
    })
}

/// Установить Java нужной версии
async fn install_java_fix(version: u32, app_handle: AppHandle) -> Result<AutoFixResult> {
    log::info!("Installing Java version {}", version);

    let download_manager = DownloadManager::new(app_handle)?;
    // Создаём токен отмены для auto-fix операций (не отменяется пользователем)
    let cancel_token = CancellationToken::new();

    // Используем существующую систему установки Java
    match crate::java::JavaManager::install_java(version, &download_manager, &cancel_token, None)
        .await
    {
        Ok(java_path) => Ok(AutoFixResult {
            success: true,
            message: format!("Java {} установлена", version),
            requires_restart: true,
            details: Some(format!("Путь: {}", java_path.display())),
        }),
        Err(e) => Ok(AutoFixResult {
            success: false,
            message: format!("Не удалось установить Java {}: {}", version, e),
            requires_restart: false,
            details: None,
        }),
    }
}

/// Обновить загрузчик модов до последней версии
async fn update_loader_fix(
    instance_id: &str,
    loader_str: &str,
    app_handle: AppHandle,
) -> Result<AutoFixResult> {
    log::info!(
        "Updating loader '{}' for instance {}",
        loader_str,
        instance_id
    );

    // Парсим тип загрузчика
    let loader_type = match LoaderType::parse(loader_str) {
        Some(lt) => lt,
        None => {
            return Ok(AutoFixResult {
                success: false,
                message: format!("Неизвестный тип загрузчика: {}", loader_str),
                requires_restart: false,
                details: None,
            });
        }
    };

    // Vanilla нельзя обновить - это не загрузчик
    if matches!(loader_type, LoaderType::Vanilla) {
        return Ok(AutoFixResult {
            success: false,
            message: "Vanilla не требует обновления загрузчика".to_string(),
            requires_restart: false,
            details: None,
        });
    }

    // Получаем информацию об экземпляре из БД
    let conn = get_db_conn()?;
    let instance_info: Option<(String, String, String)> = conn
        .query_row(
            "SELECT version, loader_version, instance_type FROM instances WHERE id = ?1",
            [instance_id],
            |row| {
                let version: String = row.get(0)?;
                let loader_version: Option<String> = row.get(1)?;
                let instance_type: String = row.get(2)?;
                Ok((version, loader_version.unwrap_or_default(), instance_type))
            },
        )
        .ok();

    let (mc_version, current_loader_version, instance_type) = match instance_info {
        Some(info) => info,
        None => {
            return Ok(AutoFixResult {
                success: false,
                message: format!("Экземпляр '{}' не найден", instance_id),
                requires_restart: false,
                details: None,
            });
        }
    };

    let is_server = instance_type == "server";

    // Получаем последнюю версию загрузчика
    let latest_version =
        match LoaderManager::get_latest_loader_version(&mc_version, loader_type.clone()).await {
            Ok(v) => v,
            Err(e) => {
                return Ok(AutoFixResult {
                    success: false,
                    message: format!("Не удалось получить последнюю версию {}: {}", loader_str, e),
                    requires_restart: false,
                    details: Some("Проверьте подключение к интернету".to_string()),
                });
            }
        };

    // Проверяем нужно ли обновление
    if current_loader_version == latest_version {
        return Ok(AutoFixResult {
            success: true,
            message: format!(
                "{} уже обновлён до последней версии ({})",
                loader_str, latest_version
            ),
            requires_restart: false,
            details: None,
        });
    }

    log::info!(
        "Updating {} from {} to {} for MC {}",
        loader_str,
        current_loader_version,
        latest_version,
        mc_version
    );

    // Создаём backup текущих loader файлов
    let instance_dir = instances_dir().join(instance_id);
    let backup_dir = instance_dir.join(".backup").join("loader");
    tokio::fs::create_dir_all(&backup_dir).await?;

    // Backup libraries и mods (которые могут быть от loader'а)
    let libs_dir = instance_dir.join("libraries");
    if tokio::fs::try_exists(&libs_dir).await.unwrap_or(false) {
        let backup_libs = backup_dir.join("libraries");
        if tokio::fs::try_exists(&backup_libs).await.unwrap_or(false) {
            let _ = tokio::fs::remove_dir_all(&backup_libs).await;
        }
        copy_dir_recursive(&libs_dir, &backup_libs).await?;
    }

    // Устанавливаем новую версию загрузчика
    let download_manager = DownloadManager::new(app_handle)?;
    // Создаём токен отмены для операции (auto-fix обычно не отменяется)
    let cancel_token = tokio_util::sync::CancellationToken::new();

    match LoaderManager::install_loader(
        instance_id,
        &mc_version,
        loader_type,
        Some(&latest_version),
        is_server,
        &download_manager,
        &cancel_token,
    )
    .await
    {
        Ok(_) => {
            // Обновляем версию в БД
            conn.execute(
                "UPDATE instances SET loader_version = ?1 WHERE id = ?2",
                params![latest_version, instance_id],
            )?;

            log::info!(
                "Successfully updated {} to {} for instance {}",
                loader_str,
                latest_version,
                instance_id
            );

            Ok(AutoFixResult {
                success: true,
                message: format!("{} обновлён до версии {}", loader_str, latest_version),
                requires_restart: true,
                details: Some(format!(
                    "Было: {}, стало: {}. Backup в .backup/loader/",
                    current_loader_version, latest_version
                )),
            })
        }
        Err(e) => {
            log::error!("Failed to update loader: {}", e);

            // Пытаемся восстановить из backup
            let backup_libs_path = backup_dir.join("libraries");
            if tokio::fs::try_exists(&backup_libs_path)
                .await
                .unwrap_or(false)
            {
                let _ = tokio::fs::remove_dir_all(&libs_dir).await;
                let _ = copy_dir_recursive(&backup_libs_path, &libs_dir).await;
                log::info!("Restored libraries from backup after failed update");
            }

            Ok(AutoFixResult {
                success: false,
                message: format!("Не удалось обновить {}: {}", loader_str, e),
                requires_restart: false,
                details: Some("Файлы восстановлены из backup".to_string()),
            })
        }
    }
}

/// Сбросить все конфиги на дефолтные
async fn reset_configs_fix(instance_id: &str) -> Result<AutoFixResult> {
    let config_dir = instances_dir().join(instance_id).join("config");

    if !tokio::fs::try_exists(&config_dir).await.unwrap_or(false) {
        return Ok(AutoFixResult {
            success: true,
            message: "Папка config не найдена (уже пустая)".to_string(),
            requires_restart: false,
            details: None,
        });
    }

    // Backup всей папки config
    let backup_dir = instances_dir()
        .join(instance_id)
        .join(".backup")
        .join("config_full");

    // Удаляем старый backup если есть
    if tokio::fs::try_exists(&backup_dir).await.unwrap_or(false) {
        tokio::fs::remove_dir_all(&backup_dir).await?;
    }

    // Копируем config в backup
    copy_dir_recursive(&config_dir, &backup_dir).await?;

    // Удаляем config
    tokio::fs::remove_dir_all(&config_dir).await?;

    // Создаём пустую папку
    tokio::fs::create_dir_all(&config_dir).await?;

    Ok(AutoFixResult {
        success: true,
        message: "Все конфиги сброшены".to_string(),
        requires_restart: true,
        details: Some("Backup: .backup/config_full/".to_string()),
    })
}

/// Проверить целостность файлов (placeholder)
async fn verify_files_fix(instance_id: &str) -> Result<AutoFixResult> {
    // Используем существующий IntegrityChecker если есть
    log::info!("Verifying files for instance {}", instance_id);

    // Пока базовая проверка - проверяем что основные папки существуют
    let instance_dir = instances_dir().join(instance_id);

    let required_dirs = ["mods", "config", "logs"];
    let mut missing = Vec::new();

    for dir in required_dirs {
        let path = instance_dir.join(dir);
        if !tokio::fs::try_exists(&path).await.unwrap_or(false) {
            tokio::fs::create_dir_all(&path).await?;
            missing.push(dir);
        }
    }

    if missing.is_empty() {
        Ok(AutoFixResult {
            success: true,
            message: "Структура файлов в порядке".to_string(),
            requires_restart: false,
            details: None,
        })
    } else {
        Ok(AutoFixResult {
            success: true,
            message: format!("Созданы отсутствующие папки: {}", missing.join(", ")),
            requires_restart: false,
            details: None,
        })
    }
}

// ============ Вспомогательные функции ============

/// Получить версию MC и загрузчик экземпляра
fn get_instance_info(instance_id: &str) -> Result<(String, String)> {
    let conn = get_db_conn()?;

    conn.query_row(
        "SELECT version, loader FROM instances WHERE id = ?1",
        [instance_id],
        |row| {
            let version: String = row.get(0)?;
            let loader: String = row.get(1)?;
            Ok((version, loader))
        },
    )
    .map_err(|_| LauncherError::InstanceNotFound(instance_id.to_string()))
}

/// Рекурсивное копирование директории
async fn copy_dir_recursive(src: &PathBuf, dst: &PathBuf) -> Result<()> {
    tokio::fs::create_dir_all(dst).await?;

    let mut entries = tokio::fs::read_dir(src).await?;

    while let Some(entry) = entries.next_entry().await? {
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());

        // Используем async file_type() вместо блокирующего is_dir()
        let file_type = entry.file_type().await?;
        if file_type.is_dir() {
            Box::pin(copy_dir_recursive(&src_path, &dst_path)).await?;
        } else {
            tokio::fs::copy(&src_path, &dst_path).await?;
        }
    }

    Ok(())
}
