use crate::api::curseforge::CurseForgeClient;
use crate::api::modrinth::ModrinthClient;
use crate::db::get_db_conn;
use crate::downloader::DownloadManager;
use crate::error::{LauncherError, Result};
use crate::paths::instance_mods_dir;
use crate::utils::{calculate_sha1, sanitize_filename};
use chrono::Utc;
use rusqlite::params;
use std::path::PathBuf;

/// Парсит имя файла мода для извлечения slug и версии
/// Примеры: "create-1.20.1-0.5.1.jar" -> ("create", "0.5.1")
///          "jei-1.20.1-fabric-15.2.0.27.jar" -> ("jei", "15.2.0.27")
fn parse_mod_filename(filename: &str) -> (String, String) {
    let name = filename
        .trim_end_matches(".jar")
        .trim_end_matches(".disabled");

    // Ищем паттерн версии (цифры через точки в конце)
    // Пробуем найти последний сегмент с версией
    let parts: Vec<&str> = name.split('-').collect();

    if parts.len() >= 2 {
        // Проверяем последний сегмент - это версия?
        let last = parts[parts.len() - 1];
        if last
            .chars()
            .next()
            .map(|c| c.is_ascii_digit())
            .unwrap_or(false)
        {
            // Это похоже на версию
            // Ищем где начинается версия MC (1.20, 1.19, etc)
            let mut slug_parts = Vec::new();
            let mut version = String::new();
            let mut found_mc_version = false;

            for (i, part) in parts.iter().enumerate() {
                // Пропускаем версию MC (1.20.1, 1.19.2, etc)
                if part.starts_with("1.") && part.len() <= 7 {
                    found_mc_version = true;
                    continue;
                }
                // Пропускаем loader идентификаторы
                if ["fabric", "forge", "neoforge", "quilt"].contains(&part.to_lowercase().as_str())
                {
                    continue;
                }
                // Если это последний и похоже на версию
                if i == parts.len() - 1
                    && part
                        .chars()
                        .next()
                        .map(|c| c.is_ascii_digit())
                        .unwrap_or(false)
                {
                    version = part.to_string();
                } else if !found_mc_version
                    || !part
                        .chars()
                        .next()
                        .map(|c| c.is_ascii_digit())
                        .unwrap_or(false)
                {
                    slug_parts.push(*part);
                }
            }

            if !slug_parts.is_empty() {
                return (slug_parts.join("-").to_lowercase(), version);
            }
        }
    }

    // Fallback: всё имя как slug, версия неизвестна
    (name.to_lowercase(), "unknown".to_string())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct InstalledMod {
    pub id: i64,
    pub instance_id: String,
    pub slug: String,
    pub name: String,
    pub version: String,
    pub minecraft_version: String,
    pub source: String,
    pub source_id: Option<String>,
    pub file_name: String,
    pub enabled: bool,
    pub auto_update: bool,
    pub icon_url: Option<String>,
}

/// Результат синхронизации папки модов с БД
#[derive(Debug, Clone, serde::Serialize)]
pub struct SyncResult {
    pub added: usize,
    pub removed: usize,
}

pub struct ModManager;

impl ModManager {
    /// Установка мода из Modrinth
    pub async fn install_from_modrinth(
        instance_id: &str,
        slug: &str,
        minecraft_version: &str,
        loader: &str,
        version_id: Option<&str>,
        download_manager: &DownloadManager,
    ) -> Result<InstalledMod> {
        // Получаем версию: либо конкретную по ID, либо последнюю совместимую
        let version = if let Some(vid) = version_id {
            // Используем конкретную версию
            ModrinthClient::get_version(vid)
                .await
                .map_err(|e| match e {
                    LauncherError::ApiError(ref msg)
                        if msg.contains("404") || msg.contains("not found") =>
                    {
                        LauncherError::ModNotFound(format!(
                            "Version {} not found for mod {}",
                            vid, slug
                        ))
                    }
                    _ => e,
                })?
        } else {
            // Автоматический выбор последней release версии
            ModrinthClient::get_latest_version(slug, minecraft_version, loader)
                .await
                .map_err(|e| {
                    // Если мод не найден или нет совместимой версии, возвращаем более понятную ошибку
                    match e {
                        LauncherError::ApiError(ref msg)
                            if msg.contains("404") || msg.contains("not found") =>
                        {
                            LauncherError::ModNotFound(slug.to_string())
                        }
                        LauncherError::NotFound(_) => LauncherError::NoCompatibleModVersion {
                            mod_name: slug.to_string(),
                            mc_version: minecraft_version.to_string(),
                            loader: loader.to_string(),
                        },
                        _ => e,
                    }
                })?
        };

        // Находим primary файл
        let file = version
            .files
            .iter()
            .find(|f| f.primary)
            .or_else(|| version.files.first())
            .ok_or_else(|| {
                LauncherError::ModDownloadFailed(format!(
                    "Файлы для мода '{}' не найдены в версии {}",
                    slug, version.version_number
                ))
            })?;

        // Проверяем свободное место на диске (приблизительно)
        let required_space_mb = (file.size as f64 / 1024.0 / 1024.0).ceil() as u64;
        if let Ok(_metadata) = tokio::fs::metadata(&instance_mods_dir(instance_id)).await {
            // Упрощённая проверка - в реальности нужно проверять свободное место на диске
            // Здесь просто логируем предупреждение
            log::info!(
                "Downloading mod file: {} ({} MB)",
                file.filename,
                required_space_mb
            );
        }

        // Скачиваем мод
        let mods_dir = instance_mods_dir(instance_id);
        tokio::fs::create_dir_all(&mods_dir).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::PermissionDenied {
                LauncherError::Io(e)
            } else {
                LauncherError::ModDownloadFailed(format!("Не удалось создать папку модов: {}", e))
            }
        })?;

        let file_path = mods_dir.join(&file.filename);

        download_manager
            .download_file(
                &file.url,
                &file_path,
                &version.name,
                Some(&file.hashes.sha1),
            )
            .await
            .map_err(|e| {
                LauncherError::ModDownloadFailed(format!(
                    "Ошибка загрузки файла '{}': {}",
                    file.filename, e
                ))
            })?;

        // Сохраняем в БД
        let conn = get_db_conn()?;
        conn.execute(
            r#"INSERT INTO mods (
                instance_id, slug, name, version, minecraft_version,
                source, source_id, project_url, download_url,
                file_name, file_hash, file_size, enabled, auto_update,
                description, author, icon_url, installed_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)"#,
            params![
                instance_id,
                slug,
                version.name,
                version.version_number,
                minecraft_version,
                "modrinth",
                version.id,
                format!("https://modrinth.com/mod/{}", slug),
                file.url,
                file.filename,
                file.hashes.sha1,
                file.size as i64,
                1, // enabled
                1, // auto_update
                None::<String>, // description
                None::<String>, // author
                None::<String>, // icon_url
                Utc::now().to_rfc3339(),
                Utc::now().to_rfc3339(),
            ],
        )?;

        let mod_id = conn.last_insert_rowid();

        // Сохраняем зависимости
        for dep in &version.dependencies {
            if dep.dependency_type == "required"
                || dep.dependency_type == "optional"
                || dep.dependency_type == "incompatible"
            {
                if let Some(project_id) = &dep.project_id {
                    conn.execute(
                        "INSERT INTO mod_dependencies (mod_id, dependency_slug, dependency_type, version_requirement)
                         VALUES (?1, ?2, ?3, ?4)",
                        params![
                            mod_id,
                            project_id,
                            dep.dependency_type,
                            None::<String>,
                        ],
                    )?;
                }
            }
        }

        Ok(InstalledMod {
            id: mod_id,
            instance_id: instance_id.to_string(),
            slug: slug.to_string(),
            name: version.name,
            version: version.version_number,
            minecraft_version: minecraft_version.to_string(),
            source: "modrinth".to_string(),
            source_id: Some(version.project_id.clone()),
            file_name: file.filename.clone(),
            enabled: true,
            auto_update: true,
            icon_url: None,
        })
    }

    /// Установка мода из CurseForge
    pub async fn install_from_curseforge(
        instance_id: &str,
        mod_id: u64,
        minecraft_version: &str,
        loader: &str,
        file_id: Option<u64>,
        download_manager: &DownloadManager,
    ) -> Result<InstalledMod> {
        let client = CurseForgeClient::new()?;

        // Получаем информацию о моде с обработкой ошибок
        let mod_info = client.get_mod(mod_id).await.map_err(|e| match e {
            LauncherError::ApiError(ref msg)
                if msg.contains("404") || msg.contains("not found") =>
            {
                LauncherError::ModNotFound(format!("CurseForge mod ID {}", mod_id))
            }
            _ => e,
        })?;

        // Получаем файл: либо конкретный по ID, либо последний совместимый
        let file = if let Some(fid) = file_id {
            // Используем конкретный файл
            client
                .get_file(mod_id, fid)
                .await
                .map_err(|e| match e {
                    LauncherError::ApiError(ref msg)
                        if msg.contains("404") || msg.contains("not found") =>
                    {
                        LauncherError::ModNotFound(format!(
                            "File {} not found for mod {}",
                            fid, mod_id
                        ))
                    }
                    _ => e,
                })?
        } else {
            // Автоматический выбор последнего совместимого файла
            client
                .get_latest_file(mod_id, minecraft_version, loader)
                .await
                .map_err(|e| match e {
                    LauncherError::NotFound(_) => LauncherError::NoCompatibleModVersion {
                        mod_name: mod_info.name.clone(),
                        mc_version: minecraft_version.to_string(),
                        loader: loader.to_string(),
                    },
                    _ => e,
                })?
        };

        // Скачиваем мод
        let mods_dir = instance_mods_dir(instance_id);
        tokio::fs::create_dir_all(&mods_dir).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::PermissionDenied {
                LauncherError::Io(e)
            } else {
                LauncherError::ModDownloadFailed(format!("Не удалось создать папку модов: {}", e))
            }
        })?;

        let file_path = mods_dir.join(&file.file_name);

        // Логируем размер файла
        let file_size_mb = (file.file_length as f64 / 1024.0 / 1024.0).ceil() as u64;
        log::info!(
            "Downloading CurseForge mod: {} ({} MB)",
            file.file_name,
            file_size_mb
        );

        // CurseForge может не предоставлять прямую ссылку
        let download_url = file.download_url.clone().unwrap_or_else(|| {
            format!(
                "https://www.curseforge.com/api/v1/mods/{}/files/{}/download",
                mod_id, file.id
            )
        });

        let file_hash = file
            .hashes
            .iter()
            .find(|h| h.algo == 1) // SHA1
            .map(|h| h.value.clone());

        download_manager
            .download_file(
                &download_url,
                &file_path,
                &file.display_name,
                file_hash.as_deref(),
            )
            .await
            .map_err(|e| {
                LauncherError::ModDownloadFailed(format!(
                    "Ошибка загрузки файла '{}': {}",
                    file.file_name, e
                ))
            })?;

        // Сохраняем в БД
        let icon_url = mod_info.logo.as_ref().map(|l| l.url.clone());
        let author = mod_info.authors.first().map(|a| a.name.clone());
        let slug = mod_info.slug.clone();

        let conn = get_db_conn()?;
        conn.execute(
            r#"INSERT INTO mods (
                instance_id, slug, name, version, minecraft_version,
                source, source_id, project_url, download_url,
                file_name, file_hash, file_size, enabled, auto_update,
                description, author, icon_url, installed_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)"#,
            params![
                instance_id,
                slug,
                mod_info.name,
                file.file_name,
                minecraft_version,
                "curseforge",
                mod_id.to_string(),
                format!("https://www.curseforge.com/minecraft/mc-mods/{}", slug),
                download_url,
                file.file_name,
                file_hash,
                file.file_length as i64,
                1, // enabled
                1, // auto_update
                Some(mod_info.summary),
                author,
                icon_url.clone(),
                Utc::now().to_rfc3339(),
                Utc::now().to_rfc3339(),
            ],
        )?;

        let db_mod_id = conn.last_insert_rowid();

        // Сохраняем зависимости (резолвим ID в имя мода)
        for dep in &file.dependencies {
            let dep_type = match dep.relation_type {
                3 => "required",
                2 => "optional",
                5 => "incompatible",
                _ => continue,
            };

            // Пытаемся получить информацию о моде-зависимости
            let dep_slug = match client.get_mod(dep.mod_id).await {
                Ok(dep_mod) => dep_mod.slug,
                Err(_) => {
                    // Если не удалось получить - используем ID с префиксом
                    format!("cf:{}", dep.mod_id)
                }
            };

            conn.execute(
                "INSERT INTO mod_dependencies (mod_id, dependency_slug, dependency_type)
                 VALUES (?1, ?2, ?3)",
                params![db_mod_id, dep_slug, dep_type,],
            )?;
        }

        Ok(InstalledMod {
            id: db_mod_id,
            instance_id: instance_id.to_string(),
            slug: mod_info.slug,
            name: mod_info.name,
            version: file.file_name.clone(),
            minecraft_version: minecraft_version.to_string(),
            source: "curseforge".to_string(),
            source_id: Some(mod_id.to_string()),
            file_name: file.file_name,
            enabled: true,
            auto_update: true,
            icon_url: mod_info.logo.map(|l| l.url),
        })
    }

    /// Установка локального мода
    pub async fn install_local(
        instance_id: &str,
        mod_file_path: &PathBuf,
        _analyze: bool,
    ) -> Result<InstalledMod> {
        let file_name = mod_file_path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| LauncherError::InvalidConfig("Invalid file name".to_string()))?
            .to_string();

        // Копируем файл в директорию модов
        let mods_dir = instance_mods_dir(instance_id);
        tokio::fs::create_dir_all(&mods_dir).await?;

        let dest_path = mods_dir.join(&file_name);
        tokio::fs::copy(mod_file_path, &dest_path).await?;

        // Вычисляем хеш
        let file_hash = calculate_sha1(&dest_path)?;
        let file_size = tokio::fs::metadata(&dest_path).await?.len();

        let slug = sanitize_filename(&file_name);

        // Сохраняем в БД
        let conn = get_db_conn()?;
        conn.execute(
            r#"INSERT INTO mods (
                instance_id, slug, name, version, minecraft_version,
                source, source_id, file_name, file_hash, file_size,
                enabled, auto_update, installed_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)"#,
            params![
                instance_id,
                slug,
                file_name.clone(),
                "unknown",
                "unknown",
                "local",
                None::<String>,
                file_name,
                file_hash,
                file_size as i64,
                1, // enabled
                0, // auto_update disabled for local mods
                Utc::now().to_rfc3339(),
                Utc::now().to_rfc3339(),
            ],
        )?;

        let mod_id = conn.last_insert_rowid();

        Ok(InstalledMod {
            id: mod_id,
            instance_id: instance_id.to_string(),
            slug,
            name: file_name.clone(),
            version: "unknown".to_string(),
            minecraft_version: "unknown".to_string(),
            source: "local".to_string(),
            source_id: None,
            file_name,
            enabled: true,
            auto_update: false,
            icon_url: None,
        })
    }

    /// Получение списка установленных модов
    pub fn list_mods(instance_id: &str) -> Result<Vec<InstalledMod>> {
        let conn = get_db_conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, instance_id, slug, name, version, minecraft_version, source, source_id, file_name, enabled, auto_update, icon_url
             FROM mods WHERE instance_id = ?1 ORDER BY name"
        )?;

        let mods = stmt
            .query_map([instance_id], |row| {
                Ok(InstalledMod {
                    id: row.get(0)?,
                    instance_id: row.get(1)?,
                    slug: row.get(2)?,
                    name: row.get(3)?,
                    version: row.get(4)?,
                    minecraft_version: row.get(5)?,
                    source: row.get(6)?,
                    source_id: row.get(7)?,
                    file_name: row.get(8)?,
                    enabled: row.get::<_, i32>(9)? != 0,
                    auto_update: row.get::<_, i32>(10)? != 0,
                    icon_url: row.get(11)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        Ok(mods)
    }

    /// Регистрация модов из модпака в БД (без скачивания, моды уже в папке)
    /// Парсит имя файла для получения slug и версии
    pub fn register_modpack_mods(
        instance_id: &str,
        minecraft_version: &str,
        mod_files: &[(String, String)], // (file_name, sha1_hash)
    ) -> Result<()> {
        let conn = get_db_conn()?;
        let now = Utc::now().to_rfc3339();

        for (file_name, hash) in mod_files {
            // Check if mod is disabled (has .disabled suffix)
            let is_disabled = file_name.ends_with(".disabled");
            let parse_name = if is_disabled {
                file_name.trim_end_matches(".disabled")
            } else {
                file_name.as_str()
            };

            // Парсим имя файла: mod-name-1.2.3.jar -> (mod-name, 1.2.3)
            let (slug, version) = parse_mod_filename(parse_name);

            // Проверяем, не зарегистрирован ли уже
            let exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM mods WHERE instance_id = ?1 AND file_name = ?2)",
                params![instance_id, file_name],
                |row| row.get(0),
            )?;

            if exists {
                continue;
            }

            let enabled: i32 = if is_disabled { 0 } else { 1 };

            conn.execute(
                "INSERT INTO mods (instance_id, slug, name, version, minecraft_version, source, source_id, file_name, enabled, auto_update, installed_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?10)",
                params![
                    instance_id,
                    slug,
                    slug.replace('-', " "), // Простое имя из slug
                    version,
                    minecraft_version,
                    "modpack", // Источник - модпак
                    hash, // source_id = hash для возможной будущей идентификации
                    file_name,
                    enabled,
                    now,
                ],
            )?;
        }

        Ok(())
    }

    /// Синхронизация папки модов с БД
    /// Добавляет новые моды, удаляет отсутствующие
    pub async fn sync_mods_with_folder(instance_id: &str) -> Result<SyncResult> {
        let mods_dir = instance_mods_dir(instance_id);

        // Получаем версию Minecraft из БД
        let minecraft_version: String = {
            let conn = get_db_conn()?;
            conn.query_row(
                "SELECT version FROM instances WHERE id = ?1",
                [instance_id],
                |row| row.get(0),
            )?
        };

        // Сканируем папку
        let folder_mods = tokio::task::spawn_blocking({
            let mods_dir = mods_dir.clone();
            move || {
                let mut files = std::collections::HashMap::new();
                if let Ok(entries) = std::fs::read_dir(&mods_dir) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                            if name.ends_with(".jar") || name.ends_with(".jar.disabled") {
                                let hash = calculate_sha1(&path).unwrap_or_default();
                                files.insert(name.to_string(), hash);
                            }
                        }
                    }
                }
                files
            }
        })
        .await
        .unwrap_or_default();

        // Получаем моды из БД
        let db_mods: Vec<(i64, String)> = {
            let conn = get_db_conn()?;
            let mut stmt = conn.prepare("SELECT id, file_name FROM mods WHERE instance_id = ?1")?;
            let rows = stmt.query_map([instance_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
            let mut result = Vec::new();
            for row in rows {
                if let Ok(r) = row {
                    result.push(r);
                }
            }
            result
        };

        let mut added = 0;
        let mut removed = 0;

        // Добавляем новые моды (есть в папке, нет в БД)
        let db_filenames: std::collections::HashSet<_> =
            db_mods.iter().map(|(_, f)| f.as_str()).collect();
        let mut new_mods: Vec<(String, String)> = Vec::new();

        for (filename, hash) in &folder_mods {
            if !db_filenames.contains(filename.as_str()) {
                new_mods.push((filename.clone(), hash.clone()));
            }
        }

        if !new_mods.is_empty() {
            added = new_mods.len();
            Self::register_modpack_mods(instance_id, &minecraft_version, &new_mods)?;
        }

        // Удаляем отсутствующие моды (есть в БД, нет в папке)
        let conn = get_db_conn()?;
        for (mod_id, filename) in &db_mods {
            if !folder_mods.contains_key(filename) {
                conn.execute("DELETE FROM mods WHERE id = ?1", [mod_id])?;
                removed += 1;
            }
        }

        log::info!(
            "Sync mods for {}: {} added, {} removed",
            instance_id,
            added,
            removed
        );

        Ok(SyncResult { added, removed })
    }

    /// Включение/отключение мода
    pub async fn toggle_mod(instance_id: &str, mod_id: i64, enabled: bool) -> Result<()> {
        // Получаем информацию о моде
        let file_name = {
            let conn = get_db_conn()?;
            let mut stmt =
                conn.prepare("SELECT file_name FROM mods WHERE id = ?1 AND instance_id = ?2")?;
            stmt.query_row(params![mod_id, instance_id], |row| row.get::<_, String>(0))?
        };

        let mods_dir = instance_mods_dir(instance_id);
        let file_path = mods_dir.join(&file_name);

        if enabled {
            // Включаем: убираем .disabled
            if file_name.ends_with(".disabled") {
                let new_name = file_name.trim_end_matches(".disabled");
                let new_path = mods_dir.join(new_name);
                tokio::fs::rename(&file_path, &new_path).await?;

                // Обновляем БД
                let conn = get_db_conn()?;
                conn.execute(
                    "UPDATE mods SET enabled = 1, file_name = ?1, updated_at = ?2 WHERE id = ?3",
                    params![new_name, Utc::now().to_rfc3339(), mod_id],
                )?;
            }
        } else {
            // Отключаем: добавляем .disabled
            if !file_name.ends_with(".disabled") {
                let new_name = format!("{}.disabled", file_name);
                let new_path = mods_dir.join(&new_name);
                tokio::fs::rename(&file_path, &new_path).await?;

                // Обновляем БД
                let conn = get_db_conn()?;
                conn.execute(
                    "UPDATE mods SET enabled = 0, file_name = ?1, updated_at = ?2 WHERE id = ?3",
                    params![new_name, Utc::now().to_rfc3339(), mod_id],
                )?;
            }
        }

        Ok(())
    }

    /// Включение/отключение автообновления мода
    pub async fn toggle_mod_auto_update(
        instance_id: &str,
        mod_id: i64,
        auto_update: bool,
    ) -> Result<()> {
        let conn = get_db_conn()?;
        conn.execute(
            "UPDATE mods SET auto_update = ?1, updated_at = ?2 WHERE id = ?3 AND instance_id = ?4",
            params![
                auto_update as i32,
                Utc::now().to_rfc3339(),
                mod_id,
                instance_id
            ],
        )?;
        Ok(())
    }

    /// Удаление мода
    pub async fn remove_mod(instance_id: &str, mod_id: i64) -> Result<()> {
        let file_name = {
            let conn = get_db_conn()?;
            let mut stmt =
                conn.prepare("SELECT file_name FROM mods WHERE id = ?1 AND instance_id = ?2")?;
            stmt.query_row(params![mod_id, instance_id], |row| row.get::<_, String>(0))?
        };

        // Удаляем файл
        let mods_dir = instance_mods_dir(instance_id);
        let file_path = mods_dir.join(&file_name);

        if tokio::fs::try_exists(&file_path).await.unwrap_or(false) {
            tokio::fs::remove_file(&file_path).await?;
        }

        // Удаляем из БД
        {
            let conn = get_db_conn()?;
            conn.execute("DELETE FROM mods WHERE id = ?1", params![mod_id])?;
        }

        Ok(())
    }

    /// Обновление мода
    pub async fn update_mod(
        instance_id: &str,
        mod_id: i64,
        download_manager: &DownloadManager,
    ) -> Result<()> {
        let (slug, source, source_id, current_version, mc_version) = {
            let conn = get_db_conn()?;
            let mut stmt = conn.prepare(
                "SELECT slug, source, source_id, version, minecraft_version FROM mods WHERE id = ?1"
            )?;
            stmt.query_row(params![mod_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })?
        };

        match source.as_str() {
            "modrinth" => {
                // Проверяем обновления
                if let Some(new_version) =
                    ModrinthClient::check_updates(&slug, &current_version, &mc_version, "neoforge")
                        .await?
                {
                    // Удаляем старый файл
                    Self::remove_mod(instance_id, mod_id).await?;

                    // Устанавливаем новую версию
                    Self::install_from_modrinth(
                        instance_id,
                        &slug,
                        &mc_version,
                        "neoforge",
                        None,
                        download_manager,
                    )
                    .await?;

                    // Сохраняем историю
                    {
                        let conn = get_db_conn()?;
                        conn.execute(
                            "INSERT INTO mod_update_history (mod_id, old_version, new_version, updated_at)
                            VALUES (?1, ?2, ?3, ?4)",
                            params![
                                mod_id,
                                current_version,
                                new_version.version_number,
                                Utc::now().to_rfc3339(),
                            ],
                        )?;
                    }
                }
            }
            "curseforge" => {
                if let Some(source_id_str) = source_id {
                    let cf_mod_id: u64 = source_id_str.parse().map_err(|_| {
                        LauncherError::InvalidConfig("Invalid CurseForge mod ID".to_string())
                    })?;

                    let client = CurseForgeClient::new()?;

                    // Получаем текущий файл
                    let current_file_id: u64 = current_version.parse().unwrap_or(0);

                    if current_file_id == 0 {
                        log::warn!("Cannot parse file ID from version: {}", current_version);
                        return Ok(());
                    }

                    // Проверяем обновления
                    if let Some(new_file) = client
                        .check_updates(cf_mod_id, current_file_id, &mc_version, "neoforge")
                        .await?
                    {
                        // Удаляем старый файл
                        Self::remove_mod(instance_id, mod_id).await?;

                        // Устанавливаем новую версию
                        Self::install_from_curseforge(
                            instance_id,
                            cf_mod_id,
                            &mc_version,
                            "neoforge",
                            None,
                            download_manager,
                        )
                        .await?;

                        // Сохраняем историю
                        {
                            let conn = get_db_conn()?;
                            conn.execute(
                                "INSERT INTO mod_update_history (mod_id, old_version, new_version, updated_at)
                                VALUES (?1, ?2, ?3, ?4)",
                                params![
                                    mod_id,
                                    current_version,
                                    new_file.file_name,
                                    Utc::now().to_rfc3339(),
                                ],
                            )?;
                        }
                    }
                }
            }
            "local" => {
                return Err(LauncherError::InvalidConfig(
                    "Cannot auto-update local mods".to_string(),
                ));
            }
            _ => {}
        }

        Ok(())
    }

    /// Проверка зависимостей и конфликтов
    pub fn check_dependencies(instance_id: &str) -> Result<Vec<ModConflict>> {
        let conn = get_db_conn()?;
        let mods = Self::list_mods(instance_id)?;
        let mut conflicts = Vec::new();

        for mod_item in &mods {
            if !mod_item.enabled {
                continue;
            }

            // Получаем зависимости мода
            let mut stmt = conn.prepare(
                "SELECT dependency_slug, dependency_type, version_requirement
                 FROM mod_dependencies WHERE mod_id = ?1",
            )?;

            let deps = stmt
                .query_map([mod_item.id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;

            for (dep_slug, dep_type, version_req) in deps {
                match dep_type.as_str() {
                    "required" => {
                        // Проверяем наличие требуемого мода
                        let dep_installed = mods.iter().any(|m| m.slug == dep_slug && m.enabled);

                        if !dep_installed {
                            conflicts.push(ModConflict {
                                mod_slug: mod_item.slug.clone(),
                                mod_name: mod_item.name.clone(),
                                conflict_type: "missing_dependency".to_string(),
                                details: format!("Requires mod: {}", dep_slug),
                                required_slug: Some(dep_slug.clone()),
                                required_version: version_req.clone(),
                            });
                        } else if let Some(req) = version_req {
                            // Проверяем версию
                            if let Some(dep_mod) = mods.iter().find(|m| m.slug == dep_slug) {
                                if !crate::utils::version_matches_requirement(
                                    &dep_mod.version,
                                    &req,
                                ) {
                                    conflicts.push(ModConflict {
                                        mod_slug: mod_item.slug.clone(),
                                        mod_name: mod_item.name.clone(),
                                        conflict_type: "version_mismatch".to_string(),
                                        details: format!(
                                            "Requires {} {}, but {} is installed",
                                            dep_slug, req, dep_mod.version
                                        ),
                                        required_slug: Some(dep_slug),
                                        required_version: Some(req),
                                    });
                                }
                            }
                        }
                    }
                    "incompatible" => {
                        // Проверяем отсутствие несовместимого мода
                        let incomp_installed = mods.iter().any(|m| m.slug == dep_slug && m.enabled);

                        if incomp_installed {
                            conflicts.push(ModConflict {
                                mod_slug: mod_item.slug.clone(),
                                mod_name: mod_item.name.clone(),
                                conflict_type: "incompatible".to_string(),
                                details: format!("Incompatible with: {}", dep_slug),
                                required_slug: Some(dep_slug),
                                required_version: None,
                            });
                        }
                    }
                    _ => {}
                }
            }
        }

        Ok(conflicts)
    }

    /// Автоматическое разрешение зависимостей
    pub async fn auto_resolve_dependencies(
        instance_id: &str,
        minecraft_version: &str,
        loader: &str,
        download_manager: &DownloadManager,
    ) -> Result<Vec<InstalledMod>> {
        let conflicts = Self::check_dependencies(instance_id)?;
        let installed_mods = Self::list_mods(instance_id)?;
        let mut installed = Vec::new();

        for conflict in conflicts {
            if conflict.conflict_type == "missing_dependency" {
                if let Some(dep_slug) = conflict.required_slug {
                    // Проверяем, не установлен ли уже мод с таким slug
                    let already_installed = installed_mods.iter().any(|m| m.slug == dep_slug);

                    if already_installed {
                        log::info!("Dependency {} is already installed, skipping", dep_slug);
                        continue;
                    }

                    // Проверяем, не установили ли мы его уже в этой итерации
                    let already_in_installed =
                        installed.iter().any(|m: &InstalledMod| m.slug == dep_slug);

                    if already_in_installed {
                        log::info!(
                            "Dependency {} was just installed in this session, skipping",
                            dep_slug
                        );
                        continue;
                    }

                    // Пытаемся установить зависимость из Modrinth
                    log::info!("Installing missing dependency: {}", dep_slug);
                    match Self::install_from_modrinth(
                        instance_id,
                        &dep_slug,
                        minecraft_version,
                        loader,
                        None,
                        download_manager,
                    )
                    .await
                    {
                        Ok(mod_item) => {
                            log::info!("Successfully installed dependency: {}", dep_slug);
                            installed.push(mod_item);
                        }
                        Err(e) => {
                            log::warn!("Failed to install dependency {}: {}", dep_slug, e);
                        }
                    }
                }
            }
        }

        Ok(installed)
    }

    /// Массовое включение/выключение модов
    pub async fn bulk_toggle_mods(
        instance_id: &str,
        mod_ids: &[i64],
        enabled: bool,
    ) -> Result<Vec<i64>> {
        let mut succeeded = Vec::new();

        for &mod_id in mod_ids {
            match Self::toggle_mod(instance_id, mod_id, enabled).await {
                Ok(_) => succeeded.push(mod_id),
                Err(e) => {
                    log::warn!("Failed to toggle mod {}: {}", mod_id, e);
                }
            }
        }

        Ok(succeeded)
    }

    /// Массовое удаление модов
    pub async fn bulk_remove_mods(
        instance_id: &str,
        mod_ids: &[i64],
    ) -> Result<Vec<i64>> {
        let mut succeeded = Vec::new();

        for &mod_id in mod_ids {
            match Self::remove_mod(instance_id, mod_id).await {
                Ok(_) => succeeded.push(mod_id),
                Err(e) => {
                    log::warn!("Failed to remove mod {}: {}", mod_id, e);
                }
            }
        }

        Ok(succeeded)
    }

    /// Массовое переключение авто-обновления
    pub async fn bulk_toggle_auto_update(
        instance_id: &str,
        mod_ids: &[i64],
        auto_update: bool,
    ) -> Result<Vec<i64>> {
        let mods_dir = instance_mods_dir(instance_id);
        let mut succeeded = Vec::new();

        for &mod_id in mod_ids {
            match Self::toggle_mod_auto_update(instance_id, mod_id, auto_update).await {
                Ok(_) => succeeded.push(mod_id),
                Err(e) => {
                    log::warn!("Failed to toggle auto-update for mod {}: {}", mod_id, e);
                }
            }
        }

        Ok(succeeded)
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ModConflict {
    pub mod_slug: String,
    pub mod_name: String,
    pub conflict_type: String,
    pub details: String,
    pub required_slug: Option<String>,
    pub required_version: Option<String>,
}
