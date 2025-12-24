//! Modpack Editor - создание и редактирование локальных модпаков
//!
//! Позволяет создавать проекты модпаков, добавлять/удалять моды,
//! экспортировать в .stzhk формат и создавать экземпляры.

use crate::db::get_db_conn;
use crate::error::{LauncherError, Result};
use crate::paths::instances_dir;
use crate::stzhk::{
    GameRequirements, ModEntry, ModSide, ModSource, ModpackMeta, OptionalMod, OptionalModGroup,
    SelectionType, StzhkManifest, FORMAT_VERSION,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// ========== Types ==========

/// Проект модпака (хранится в БД)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModpackProject {
    pub id: String,
    pub name: String,
    pub version: String,
    pub minecraft_version: String,
    pub loader: String,
    pub loader_version: Option<String>,
    pub author: Option<String>,
    pub description: Option<String>,
    pub icon_path: Option<String>,
    pub mods_count: u32,
    pub created_at: String,
    pub updated_at: String,
}

/// Полная информация о проекте с модами
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModpackProjectFull {
    pub project: ModpackProject,
    pub mods: Vec<ProjectMod>,
    pub optional_groups: Vec<ProjectOptionalGroup>,
    pub overrides_count: u32,
}

/// Мод в проекте
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectMod {
    pub id: i64,
    pub mod_id: String,
    pub slug: String,
    pub name: String,
    pub version: Option<String>,
    pub filename: Option<String>,
    pub sha256: Option<String>,
    pub size: Option<i64>,
    pub source: String,
    pub source_id: Option<String>,
    pub source_version_id: Option<String>,
    pub download_url: Option<String>,
    pub icon_url: Option<String>,
    pub required: bool,
    pub side: String,
    pub sort_order: i32,
    pub created_at: String,
}

/// Группа опциональных модов в проекте
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectOptionalGroup {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub selection_type: String,
    pub sort_order: i32,
    pub mods: Vec<ProjectOptionalMod>,
}

/// Опциональный мод
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectOptionalMod {
    pub mod_id: String,
    pub default_enabled: bool,
    pub note: Option<String>,
    pub conflicts_with: Vec<String>,
}

/// Обновление проекта
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModpackProjectUpdate {
    pub name: Option<String>,
    pub version: Option<String>,
    pub author: Option<String>,
    pub description: Option<String>,
    pub icon_path: Option<String>,
    pub minecraft_version: Option<String>,
    pub loader: Option<String>,
    pub loader_version: Option<String>,
}

/// Информация для добавления мода
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AddModInfo {
    pub slug: String,
    pub name: String,
    pub version: Option<String>,
    pub filename: Option<String>,
    pub sha256: Option<String>,
    pub size: Option<i64>,
    pub source: String,
    pub source_id: Option<String>,
    pub source_version_id: Option<String>,
    pub download_url: Option<String>,
    pub icon_url: Option<String>,
    pub side: Option<String>,
}

/// Результат экспорта
#[derive(Debug, Clone, Serialize)]
pub struct ExportResult {
    pub path: String,
    pub size: u64,
    pub mods_count: u32,
    pub embedded_count: u32,
}

// ========== Database ==========

/// Инициализация таблиц редактора модпаков
pub fn init_modpack_editor_tables() -> Result<()> {
    let conn = get_db_conn()?;

    conn.execute_batch(
        r#"
        -- Проекты модпаков
        CREATE TABLE IF NOT EXISTS modpack_projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            version TEXT DEFAULT '1.0.0',
            minecraft_version TEXT NOT NULL,
            loader TEXT NOT NULL,
            loader_version TEXT,
            author TEXT,
            description TEXT,
            icon_path TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        -- Моды в проекте
        CREATE TABLE IF NOT EXISTS modpack_project_mods (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id TEXT NOT NULL,
            mod_id TEXT NOT NULL,
            slug TEXT NOT NULL,
            name TEXT NOT NULL,
            version TEXT,
            filename TEXT,
            sha256 TEXT,
            size INTEGER,
            source TEXT NOT NULL,
            source_id TEXT,
            source_version_id TEXT,
            download_url TEXT,
            icon_url TEXT,
            required INTEGER DEFAULT 1,
            side TEXT DEFAULT 'both',
            sort_order INTEGER DEFAULT 0,
            created_at TEXT NOT NULL,
            FOREIGN KEY (project_id) REFERENCES modpack_projects(id) ON DELETE CASCADE,
            UNIQUE(project_id, mod_id)
        );

        -- Опциональные группы
        CREATE TABLE IF NOT EXISTS modpack_optional_groups (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            name TEXT NOT NULL,
            description TEXT,
            selection_type TEXT DEFAULT 'multiple',
            sort_order INTEGER DEFAULT 0,
            FOREIGN KEY (project_id) REFERENCES modpack_projects(id) ON DELETE CASCADE
        );

        -- Назначения опциональных модов
        CREATE TABLE IF NOT EXISTS modpack_optional_assignments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id TEXT NOT NULL,
            mod_id TEXT NOT NULL,
            default_enabled INTEGER DEFAULT 0,
            note TEXT,
            conflicts_with TEXT,
            FOREIGN KEY (group_id) REFERENCES modpack_optional_groups(id) ON DELETE CASCADE,
            UNIQUE(group_id, mod_id)
        );

        -- Оверрайды проекта
        CREATE TABLE IF NOT EXISTS modpack_overrides (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id TEXT NOT NULL,
            source_path TEXT NOT NULL,
            dest_path TEXT NOT NULL,
            file_hash TEXT,
            file_size INTEGER,
            FOREIGN KEY (project_id) REFERENCES modpack_projects(id) ON DELETE CASCADE,
            UNIQUE(project_id, dest_path)
        );

        -- Индексы
        CREATE INDEX IF NOT EXISTS idx_project_mods_project ON modpack_project_mods(project_id);
        CREATE INDEX IF NOT EXISTS idx_project_mods_slug ON modpack_project_mods(slug);
        CREATE INDEX IF NOT EXISTS idx_optional_groups_project ON modpack_optional_groups(project_id);
        CREATE INDEX IF NOT EXISTS idx_optional_assignments_group ON modpack_optional_assignments(group_id);
        CREATE INDEX IF NOT EXISTS idx_overrides_project ON modpack_overrides(project_id);
        "#,
    )?;

    Ok(())
}

// ========== Project Management ==========

/// Создать новый проект модпака
#[tauri::command]
pub fn create_modpack_project(
    name: String,
    minecraft_version: String,
    loader: String,
    loader_version: Option<String>,
) -> Result<String> {
    let conn = get_db_conn()?;
    let project_id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO modpack_projects (id, name, minecraft_version, loader, loader_version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![project_id, name, minecraft_version, loader, loader_version, now, now],
    )?;

    log::info!("Created modpack project: {} ({})", name, project_id);
    Ok(project_id)
}

/// Получить список проектов
#[tauri::command]
pub fn list_modpack_projects() -> Result<Vec<ModpackProject>> {
    let conn = get_db_conn()?;

    let mut stmt = conn.prepare(
        "SELECT p.id, p.name, p.version, p.minecraft_version, p.loader, p.loader_version,
                p.author, p.description, p.icon_path, p.created_at, p.updated_at,
                (SELECT COUNT(*) FROM modpack_project_mods WHERE project_id = p.id) as mods_count
         FROM modpack_projects p
         ORDER BY p.updated_at DESC",
    )?;

    let projects = stmt
        .query_map([], |row| {
            Ok(ModpackProject {
                id: row.get(0)?,
                name: row.get(1)?,
                version: row.get(2)?,
                minecraft_version: row.get(3)?,
                loader: row.get(4)?,
                loader_version: row.get(5)?,
                author: row.get(6)?,
                description: row.get(7)?,
                icon_path: row.get(8)?,
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
                mods_count: row.get(11)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    Ok(projects)
}

/// Получить полную информацию о проекте
#[tauri::command]
pub fn get_modpack_project(project_id: String) -> Result<ModpackProjectFull> {
    let conn = get_db_conn()?;

    // Получаем основную информацию
    let project: ModpackProject = conn
        .query_row(
            "SELECT p.id, p.name, p.version, p.minecraft_version, p.loader, p.loader_version,
                p.author, p.description, p.icon_path, p.created_at, p.updated_at,
                (SELECT COUNT(*) FROM modpack_project_mods WHERE project_id = p.id) as mods_count
         FROM modpack_projects p WHERE p.id = ?1",
            [&project_id],
            |row| {
                Ok(ModpackProject {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    version: row.get(2)?,
                    minecraft_version: row.get(3)?,
                    loader: row.get(4)?,
                    loader_version: row.get(5)?,
                    author: row.get(6)?,
                    description: row.get(7)?,
                    icon_path: row.get(8)?,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                    mods_count: row.get(11)?,
                })
            },
        )
        .map_err(|_| LauncherError::NotFound(format!("Project {} not found", project_id)))?;

    // Получаем моды
    let mut stmt = conn.prepare(
        "SELECT id, mod_id, slug, name, version, filename, sha256, size, source,
                source_id, source_version_id, download_url, icon_url, required, side, sort_order, created_at
         FROM modpack_project_mods WHERE project_id = ?1 ORDER BY sort_order, name"
    )?;

    let mods = stmt
        .query_map([&project_id], |row| {
            Ok(ProjectMod {
                id: row.get(0)?,
                mod_id: row.get(1)?,
                slug: row.get(2)?,
                name: row.get(3)?,
                version: row.get(4)?,
                filename: row.get(5)?,
                sha256: row.get(6)?,
                size: row.get(7)?,
                source: row.get(8)?,
                source_id: row.get(9)?,
                source_version_id: row.get(10)?,
                download_url: row.get(11)?,
                icon_url: row.get(12)?,
                required: row.get::<_, i32>(13)? != 0,
                side: row.get(14)?,
                sort_order: row.get(15)?,
                created_at: row.get(16)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    // Получаем опциональные группы
    let mut stmt = conn.prepare(
        "SELECT id, name, description, selection_type, sort_order
         FROM modpack_optional_groups WHERE project_id = ?1 ORDER BY sort_order",
    )?;

    let groups: Vec<(String, String, Option<String>, String, i32)> = stmt
        .query_map([&project_id], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    let mut optional_groups = Vec::new();
    for (group_id, name, description, selection_type, sort_order) in groups {
        let mut stmt = conn.prepare(
            "SELECT mod_id, default_enabled, note, conflicts_with
             FROM modpack_optional_assignments WHERE group_id = ?1",
        )?;

        let group_mods = stmt
            .query_map([&group_id], |row| {
                let conflicts_str: Option<String> = row.get(3)?;
                let conflicts = conflicts_str
                    .map(|s| serde_json::from_str(&s).unwrap_or_default())
                    .unwrap_or_default();

                Ok(ProjectOptionalMod {
                    mod_id: row.get(0)?,
                    default_enabled: row.get::<_, i32>(1)? != 0,
                    note: row.get(2)?,
                    conflicts_with: conflicts,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        optional_groups.push(ProjectOptionalGroup {
            id: group_id,
            name,
            description,
            selection_type,
            sort_order,
            mods: group_mods,
        });
    }

    // Считаем оверрайды
    let overrides_count: u32 = conn.query_row(
        "SELECT COUNT(*) FROM modpack_overrides WHERE project_id = ?1",
        [&project_id],
        |row| row.get(0),
    )?;

    Ok(ModpackProjectFull {
        project,
        mods,
        optional_groups,
        overrides_count,
    })
}

/// Обновить проект
#[tauri::command]
pub fn update_modpack_project(project_id: String, updates: ModpackProjectUpdate) -> Result<()> {
    let conn = get_db_conn()?;
    let now = chrono::Utc::now().to_rfc3339();

    let mut set_clauses = vec!["updated_at = ?1"];
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(now)];

    if let Some(name) = updates.name {
        set_clauses.push("name = ?");
        params.push(Box::new(name));
    }
    if let Some(version) = updates.version {
        set_clauses.push("version = ?");
        params.push(Box::new(version));
    }
    if let Some(author) = updates.author {
        set_clauses.push("author = ?");
        params.push(Box::new(author));
    }
    if let Some(description) = updates.description {
        set_clauses.push("description = ?");
        params.push(Box::new(description));
    }
    if let Some(icon_path) = updates.icon_path {
        set_clauses.push("icon_path = ?");
        params.push(Box::new(icon_path));
    }
    if let Some(mc_version) = updates.minecraft_version {
        set_clauses.push("minecraft_version = ?");
        params.push(Box::new(mc_version));
    }
    if let Some(loader) = updates.loader {
        set_clauses.push("loader = ?");
        params.push(Box::new(loader));
    }
    if let Some(loader_version) = updates.loader_version {
        set_clauses.push("loader_version = ?");
        params.push(Box::new(loader_version));
    }

    // Генерируем SQL с правильными номерами параметров
    let mut sql = String::from("UPDATE modpack_projects SET ");
    for (i, clause) in set_clauses.iter().enumerate() {
        if i > 0 {
            sql.push_str(", ");
        }
        // Заменяем ? на ?N
        let numbered_clause = clause.replace("?", &format!("?{}", i + 1));
        sql.push_str(&numbered_clause);
    }
    sql.push_str(&format!(" WHERE id = ?{}", params.len() + 1));
    params.push(Box::new(project_id));

    let params_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    conn.execute(&sql, params_refs.as_slice())?;

    Ok(())
}

/// Удалить проект
#[tauri::command]
pub fn delete_modpack_project(project_id: String) -> Result<()> {
    let conn = get_db_conn()?;

    // CASCADE удалит связанные записи
    let deleted = conn.execute("DELETE FROM modpack_projects WHERE id = ?1", [&project_id])?;

    if deleted == 0 {
        return Err(LauncherError::NotFound(format!(
            "Project {} not found",
            project_id
        )));
    }

    log::info!("Deleted modpack project: {}", project_id);
    Ok(())
}

// ========== Mod Management ==========

/// Добавить мод в проект
#[tauri::command]
pub async fn add_mod_to_project(project_id: String, mod_info: AddModInfo) -> Result<i64> {
    let conn = get_db_conn()?;
    let now = chrono::Utc::now().to_rfc3339();
    let mod_id = uuid::Uuid::new_v4().to_string();

    // Получаем максимальный sort_order
    let max_order: i32 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) FROM modpack_project_mods WHERE project_id = ?1",
        [&project_id],
        |row| row.get(0),
    )?;

    conn.execute(
        "INSERT INTO modpack_project_mods
         (project_id, mod_id, slug, name, version, filename, sha256, size, source,
          source_id, source_version_id, download_url, icon_url, side, sort_order, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        rusqlite::params![
            project_id,
            mod_id,
            mod_info.slug,
            mod_info.name,
            mod_info.version,
            mod_info.filename,
            mod_info.sha256,
            mod_info.size,
            mod_info.source,
            mod_info.source_id,
            mod_info.source_version_id,
            mod_info.download_url,
            mod_info.icon_url,
            mod_info.side.unwrap_or_else(|| "both".to_string()),
            max_order + 1,
            now,
        ],
    )?;

    // Обновляем updated_at проекта
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE modpack_projects SET updated_at = ?1 WHERE id = ?2",
        [&now, &project_id],
    )?;

    let id = conn.last_insert_rowid();
    log::info!("Added mod {} to project {}", mod_info.slug, project_id);

    Ok(id)
}

/// Удалить мод из проекта
#[tauri::command]
pub fn remove_mod_from_project(project_id: String, mod_id: String) -> Result<()> {
    let conn = get_db_conn()?;

    let deleted = conn.execute(
        "DELETE FROM modpack_project_mods WHERE project_id = ?1 AND mod_id = ?2",
        [&project_id, &mod_id],
    )?;

    if deleted == 0 {
        return Err(LauncherError::NotFound(
            "Mod not found in project".to_string(),
        ));
    }

    // Обновляем updated_at проекта
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE modpack_projects SET updated_at = ?1 WHERE id = ?2",
        [&now, &project_id],
    )?;

    Ok(())
}

/// Обновить порядок модов
#[tauri::command]
pub fn reorder_project_mods(project_id: String, mod_ids: Vec<String>) -> Result<()> {
    let conn = get_db_conn()?;

    for (i, mod_id) in mod_ids.iter().enumerate() {
        conn.execute(
            "UPDATE modpack_project_mods SET sort_order = ?1 WHERE project_id = ?2 AND mod_id = ?3",
            rusqlite::params![i as i32, project_id, mod_id],
        )?;
    }

    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE modpack_projects SET updated_at = ?1 WHERE id = ?2",
        [&now, &project_id],
    )?;

    Ok(())
}

/// Обновить настройки мода в проекте
#[tauri::command]
pub fn update_project_mod(
    project_id: String,
    mod_id: String,
    required: Option<bool>,
    side: Option<String>,
) -> Result<()> {
    let conn = get_db_conn()?;

    if let Some(req) = required {
        conn.execute(
            "UPDATE modpack_project_mods SET required = ?1 WHERE project_id = ?2 AND mod_id = ?3",
            rusqlite::params![req as i32, project_id, mod_id],
        )?;
    }

    if let Some(s) = side {
        conn.execute(
            "UPDATE modpack_project_mods SET side = ?1 WHERE project_id = ?2 AND mod_id = ?3",
            rusqlite::params![s, project_id, mod_id],
        )?;
    }

    Ok(())
}

// ========== Optional Groups ==========

/// Создать группу опциональных модов
#[tauri::command]
pub fn create_optional_group(
    project_id: String,
    name: String,
    description: Option<String>,
    selection_type: Option<String>,
) -> Result<String> {
    let conn = get_db_conn()?;
    let group_id = uuid::Uuid::new_v4().to_string();

    let max_order: i32 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) FROM modpack_optional_groups WHERE project_id = ?1",
        [&project_id],
        |row| row.get(0),
    )?;

    conn.execute(
        "INSERT INTO modpack_optional_groups (id, project_id, name, description, selection_type, sort_order)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            group_id,
            project_id,
            name,
            description,
            selection_type.unwrap_or_else(|| "multiple".to_string()),
            max_order + 1,
        ],
    )?;

    Ok(group_id)
}

/// Добавить мод в опциональную группу
#[tauri::command]
pub fn add_mod_to_optional_group(
    group_id: String,
    mod_id: String,
    default_enabled: bool,
    note: Option<String>,
    conflicts_with: Option<Vec<String>>,
) -> Result<()> {
    let conn = get_db_conn()?;

    let conflicts_json = conflicts_with.map(|c| serde_json::to_string(&c).unwrap_or_default());

    conn.execute(
        "INSERT OR REPLACE INTO modpack_optional_assignments (group_id, mod_id, default_enabled, note, conflicts_with)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![group_id, mod_id, default_enabled as i32, note, conflicts_json],
    )?;

    // Помечаем мод как не обязательный
    conn.execute(
        "UPDATE modpack_project_mods SET required = 0
         WHERE mod_id = ?1 AND project_id = (SELECT project_id FROM modpack_optional_groups WHERE id = ?2)",
        [&mod_id, &group_id],
    )?;

    Ok(())
}

/// Удалить группу опциональных модов
#[tauri::command]
pub fn delete_optional_group(group_id: String) -> Result<()> {
    let conn = get_db_conn()?;

    conn.execute(
        "DELETE FROM modpack_optional_groups WHERE id = ?1",
        [&group_id],
    )?;

    Ok(())
}

// ========== Export ==========

/// Экспортировать проект в .stzhk
#[tauri::command]
pub async fn export_project_to_stzhk(
    project_id: String,
    output_path: String,
    embed_mods: bool,
    app_handle: tauri::AppHandle,
) -> Result<ExportResult> {
    use std::io::Write;
    use tauri::Emitter;
    use zip::{write::SimpleFileOptions, ZipWriter};

    let project_full = get_modpack_project(project_id.clone())?;
    let project = &project_full.project;

    // Создаём манифест
    let mut mods = Vec::new();
    let mut embedded_count = 0u32;

    for pm in &project_full.mods {
        let source = match pm.source.as_str() {
            "modrinth" => {
                if embed_mods {
                    embedded_count += 1;
                    ModSource::Embedded {
                        path: format!("mods/{}", pm.filename.as_deref().unwrap_or(&pm.slug)),
                    }
                } else {
                    ModSource::Modrinth {
                        project_id: pm.source_id.clone().unwrap_or_default(),
                        version_id: pm.source_version_id.clone().unwrap_or_default(),
                        download_url: pm.download_url.clone().unwrap_or_default(),
                    }
                }
            }
            "curseforge" => {
                if embed_mods {
                    embedded_count += 1;
                    ModSource::Embedded {
                        path: format!("mods/{}", pm.filename.as_deref().unwrap_or(&pm.slug)),
                    }
                } else {
                    ModSource::CurseForge {
                        project_id: pm
                            .source_id
                            .clone()
                            .and_then(|s| s.parse().ok())
                            .unwrap_or(0),
                        file_id: pm
                            .source_version_id
                            .clone()
                            .and_then(|s| s.parse().ok())
                            .unwrap_or(0),
                        download_url: pm.download_url.clone(),
                    }
                }
            }
            _ => {
                embedded_count += 1;
                ModSource::Embedded {
                    path: format!("mods/{}", pm.filename.as_deref().unwrap_or(&pm.slug)),
                }
            }
        };

        let side = match pm.side.as_str() {
            "client" => ModSide::Client,
            "server" => ModSide::Server,
            _ => ModSide::Both,
        };

        mods.push(ModEntry {
            filename: pm
                .filename
                .clone()
                .unwrap_or_else(|| format!("{}.jar", pm.slug)),
            name: pm.name.clone(),
            version: pm.version.clone(),
            sha256: pm.sha256.clone().unwrap_or_default(),
            size: pm.size.unwrap_or(0) as u64,
            source,
            required: pm.required,
            side,
            dependencies: vec![],
        });
    }

    // Конвертируем опциональные группы
    let optional_mods: Vec<OptionalModGroup> = project_full
        .optional_groups
        .iter()
        .map(|g| OptionalModGroup {
            id: g.id.clone(),
            name: g.name.clone(),
            description: g.description.clone(),
            selection_type: match g.selection_type.as_str() {
                "single" => SelectionType::Single,
                _ => SelectionType::Multiple,
            },
            mods: g
                .mods
                .iter()
                .map(|m| OptionalMod {
                    mod_id: m.mod_id.clone(),
                    default_enabled: m.default_enabled,
                    note: m.note.clone(),
                })
                .collect(),
        })
        .collect();

    let manifest = StzhkManifest {
        format_version: FORMAT_VERSION,
        modpack: ModpackMeta {
            id: project.id.clone(),
            name: project.name.clone(),
            version: project.version.clone(),
            author: project
                .author
                .clone()
                .unwrap_or_else(|| "Unknown".to_string()),
            description: project.description.clone(),
            url: None,
            icon: project.icon_path.clone(),
            created_at: project.created_at.clone(),
            updated_at: Some(project.updated_at.clone()),
        },
        requirements: GameRequirements {
            minecraft_version: project.minecraft_version.clone(),
            loader: project.loader.clone(),
            loader_version: project.loader_version.clone(),
            min_ram_mb: Some(4096),
            recommended_ram_mb: Some(8192),
            java_version: None,
        },
        mods,
        overrides: None,
        patches: vec![],
        optional_mods,
    };

    // Создаём архив
    let output_file = PathBuf::from(&output_path).join(format!(
        "{}-{}.stzhk",
        project.name.replace(" ", "_"),
        project.version
    ));

    let file = std::fs::File::create(&output_file)?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    // Записываем манифест
    let manifest_json = serde_json::to_string_pretty(&manifest)?;
    zip.start_file("manifest.json", options)?;
    zip.write_all(manifest_json.as_bytes())?;

    // Если нужно встраивать моды, скачиваем их
    if embed_mods {
        let download_manager = crate::downloader::DownloadManager::new(app_handle.clone())?;
        let temp_dir = std::env::temp_dir().join(format!("stzhk_export_{}", project.id));
        tokio::fs::create_dir_all(&temp_dir).await?;

        let total = project_full.mods.len();
        for (i, pm) in project_full.mods.iter().enumerate() {
            let _ = app_handle.emit(
                "stzhk-export-progress",
                serde_json::json!({
                    "current": i + 1,
                    "total": total,
                    "stage": "downloading",
                    "filename": pm.name,
                }),
            );

            if let Some(url) = &pm.download_url {
                let filename = pm.filename.as_deref().unwrap_or(&pm.slug);
                let dest = temp_dir.join(filename);

                if let Err(e) = download_manager
                    .download_file(url, &dest, filename, pm.sha256.as_deref())
                    .await
                {
                    log::warn!("Failed to download {}: {}", pm.name, e);
                    continue;
                }

                // Добавляем в архив
                if let Ok(content) = tokio::fs::read(&dest).await {
                    let archive_path = format!("mods/{}", filename);
                    zip.start_file(&archive_path, options)?;
                    zip.write_all(&content)?;
                }
            }
        }

        // Очищаем временную директорию
        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    }

    zip.finish()?;

    let metadata = std::fs::metadata(&output_file)?;

    let _ = app_handle.emit(
        "stzhk-export-complete",
        serde_json::json!({
            "path": output_file.to_string_lossy(),
            "size": metadata.len(),
        }),
    );

    Ok(ExportResult {
        path: output_file.to_string_lossy().to_string(),
        size: metadata.len(),
        mods_count: project_full.mods.len() as u32,
        embedded_count,
    })
}

// ========== Instance Creation ==========

/// Создать экземпляр из проекта модпака
#[tauri::command]
pub async fn create_instance_from_project(
    project_id: String,
    instance_name: String,
    app_handle: tauri::AppHandle,
) -> Result<String> {
    use tauri::Emitter;

    let project_full = get_modpack_project(project_id.clone())?;
    let project = &project_full.project;

    // Создаём экземпляр
    let instance = crate::instances::create_instance(
        crate::types::CreateInstanceRequest {
            name: instance_name.clone(),
            version: project.minecraft_version.clone(),
            loader: project.loader.clone(),
            loader_version: project.loader_version.clone(),
            instance_type: "client".to_string(),
            memory_min: Some(2048),
            memory_max: Some(8192),
            java_args: None,
            game_args: None,
            port: None,
            username: None,
            notes: project.description.clone(),
        },
        app_handle.clone(),
    )
    .await?;

    let instance_id = instance.id.clone();
    let mods_path = instances_dir().join(&instance_id).join("mods");
    tokio::fs::create_dir_all(&mods_path).await?;

    // Устанавливаем моды
    let download_manager = crate::downloader::DownloadManager::new(app_handle.clone())?;
    let total = project_full.mods.len();

    for (i, pm) in project_full.mods.iter().enumerate() {
        let _ = app_handle.emit(
            "modpack-install-progress",
            serde_json::json!({
                "current": i + 1,
                "total": total,
                "mod_name": pm.name,
            }),
        );

        // Скачиваем мод
        if let Some(url) = &pm.download_url {
            let default_filename = format!("{}.jar", pm.slug);
            let filename = pm.filename.as_deref().unwrap_or(&default_filename);
            let dest = mods_path.join(filename);

            if let Err(e) = download_manager
                .download_file(url, &dest, filename, pm.sha256.as_deref())
                .await
            {
                log::warn!("Failed to download {}: {}", pm.name, e);
                continue;
            }

            // Регистрируем мод в БД
            let conn = get_db_conn()?;
            let now = chrono::Utc::now().to_rfc3339();

            let _ = conn.execute(
                "INSERT OR REPLACE INTO mods
                 (instance_id, slug, name, version, minecraft_version, source, source_id,
                  download_url, file_name, file_hash, file_size, enabled, installed_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 1, ?12, ?12)",
                rusqlite::params![
                    instance_id,
                    pm.slug,
                    pm.name,
                    pm.version.as_deref().unwrap_or("unknown"),
                    project.minecraft_version,
                    pm.source,
                    pm.source_id,
                    pm.download_url,
                    filename,
                    pm.sha256,
                    pm.size,
                    now,
                ],
            );
        }
    }

    let _ = app_handle.emit(
        "modpack-install-complete",
        serde_json::json!({
            "instance_id": instance_id,
            "mods_installed": total,
        }),
    );

    log::info!(
        "Created instance {} from project {}",
        instance_id,
        project_id
    );
    Ok(instance_id)
}

/// Тестовый запуск проекта (создаёт временный экземпляр)
#[tauri::command]
pub async fn test_modpack_project(
    project_id: String,
    app_handle: tauri::AppHandle,
) -> Result<String> {
    let project = get_modpack_project(project_id.clone())?;
    let test_name = format!("[TEST] {}", project.project.name);

    create_instance_from_project(project_id, test_name, app_handle).await
}

// ========== Import ==========

/// Импортировать .mrpack в проект
#[tauri::command]
pub async fn import_mrpack_to_project(mrpack_path: String) -> Result<String> {
    use std::io::Read;

    let path = PathBuf::from(mrpack_path);
    let file = std::fs::File::open(&path)?;
    let mut archive = zip::ZipArchive::new(file)?;

    // Читаем modrinth.index.json
    let mut index_entry = archive
        .by_name("modrinth.index.json")
        .map_err(|_| LauncherError::InvalidConfig("modrinth.index.json not found".into()))?;

    let mut content = String::new();
    index_entry.read_to_string(&mut content)?;

    #[derive(Deserialize)]
    struct MrpackIndex {
        name: String,
        #[serde(rename = "versionId")]
        version_id: Option<String>,
        dependencies: std::collections::HashMap<String, String>,
        files: Vec<MrpackFile>,
    }

    #[derive(Deserialize)]
    struct MrpackFile {
        path: String,
        hashes: std::collections::HashMap<String, String>,
        downloads: Vec<String>,
        #[serde(rename = "fileSize")]
        file_size: Option<u64>,
    }

    let index: MrpackIndex = serde_json::from_str(&content)?;

    // Определяем версию MC и загрузчик
    let minecraft_version = index
        .dependencies
        .get("minecraft")
        .cloned()
        .unwrap_or_else(|| "1.20.1".to_string());

    let (loader, loader_version) = if let Some(v) = index.dependencies.get("fabric-loader") {
        ("fabric".to_string(), Some(v.clone()))
    } else if let Some(v) = index.dependencies.get("quilt-loader") {
        ("quilt".to_string(), Some(v.clone()))
    } else if let Some(v) = index.dependencies.get("forge") {
        ("forge".to_string(), Some(v.clone()))
    } else if let Some(v) = index.dependencies.get("neoforge") {
        ("neoforge".to_string(), Some(v.clone()))
    } else {
        ("fabric".to_string(), None)
    };

    // Создаём проект
    let project_id = create_modpack_project(
        index.name.clone(),
        minecraft_version.clone(),
        loader,
        loader_version,
    )?;

    // Добавляем моды
    for file in index.files {
        if !file.path.starts_with("mods/") {
            continue;
        }

        let filename = file.path.strip_prefix("mods/").unwrap_or(&file.path);
        let sha256 = file.hashes.get("sha256").cloned();
        let download_url = file.downloads.first().cloned();

        // Пытаемся определить источник из URL
        let (source, source_id, source_version_id) = if let Some(url) = &download_url {
            if url.contains("modrinth.com") {
                // Парсим URL Modrinth: https://cdn.modrinth.com/data/{project_id}/versions/{version_id}/{filename}
                let parts: Vec<&str> = url.split('/').collect();
                if parts.len() >= 7 {
                    let proj_id = parts.get(4).map(|s| s.to_string());
                    let ver_id = parts.get(6).map(|s| s.to_string());
                    ("modrinth".to_string(), proj_id, ver_id)
                } else {
                    ("modrinth".to_string(), None, None)
                }
            } else {
                ("direct".to_string(), None, None)
            }
        } else {
            ("embedded".to_string(), None, None)
        };

        let mod_info = AddModInfo {
            slug: filename.trim_end_matches(".jar").to_string(),
            name: filename.trim_end_matches(".jar").to_string(),
            version: None,
            filename: Some(filename.to_string()),
            sha256,
            size: file.file_size.map(|s| s as i64),
            source,
            source_id,
            source_version_id,
            download_url,
            icon_url: None,
            side: None,
        };

        let _ = add_mod_to_project(project_id.clone(), mod_info).await;
    }

    log::info!("Imported mrpack to project: {}", project_id);
    Ok(project_id)
}
