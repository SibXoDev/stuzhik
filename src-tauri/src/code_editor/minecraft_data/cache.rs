use super::jar_parser::JarParser;
use super::types::{MinecraftBlock, MinecraftItem, MinecraftTag, ModInfo, TagType};
use crate::error::Result;
use crate::paths::{cache_dir, instance_mods_dir};
use chrono::Utc;
use rusqlite::{params, Connection};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

pub struct MinecraftDataCache {
    instance_id: String,
    conn: Arc<Mutex<Connection>>,
}

impl MinecraftDataCache {
    /// Инициализирует кэш для instance
    pub async fn init(instance_id: &str) -> Result<Self> {
        let cache_path = Self::get_cache_path(instance_id);

        // Создаем директорию если не существует
        if let Some(parent) = cache_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        let conn = Connection::open(&cache_path)?;

        // Создаем таблицы
        Self::create_tables(&conn)?;

        Ok(Self {
            instance_id: instance_id.to_string(),
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    fn get_cache_path(instance_id: &str) -> PathBuf {
        cache_dir().join(format!("minecraft_data_{}.db", instance_id))
    }

    /// Создает таблицы в БД
    fn create_tables(conn: &Connection) -> Result<()> {
        // Таблица предметов
        conn.execute(
            "CREATE TABLE IF NOT EXISTS items (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                mod_id TEXT NOT NULL,
                tags TEXT,
                texture_path TEXT,
                stack_size INTEGER NOT NULL DEFAULT 64,
                rarity TEXT NOT NULL DEFAULT 'common',
                description TEXT,
                last_updated INTEGER NOT NULL
            )",
            [],
        )?;

        // Индексы для быстрого поиска
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_items_mod_id ON items(mod_id)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_items_name ON items(name COLLATE NOCASE)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_items_id_pattern ON items(id)",
            [],
        )?;

        // Таблица блоков
        conn.execute(
            "CREATE TABLE IF NOT EXISTS blocks (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                mod_id TEXT NOT NULL,
                tags TEXT,
                hardness REAL,
                blast_resistance REAL,
                requires_tool INTEGER,
                last_updated INTEGER NOT NULL
            )",
            [],
        )?;

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_blocks_mod_id ON blocks(mod_id)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_blocks_name ON blocks(name COLLATE NOCASE)",
            [],
        )?;

        // Таблица тегов
        conn.execute(
            "CREATE TABLE IF NOT EXISTS tags (
                id TEXT PRIMARY KEY,
                tag_type TEXT NOT NULL,
                values TEXT NOT NULL,
                last_updated INTEGER NOT NULL
            )",
            [],
        )?;

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_tags_type ON tags(tag_type)",
            [],
        )?;

        // Таблица информации о модах
        conn.execute(
            "CREATE TABLE IF NOT EXISTS mods (
                mod_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                version TEXT NOT NULL,
                loader TEXT NOT NULL,
                item_count INTEGER NOT NULL DEFAULT 0,
                block_count INTEGER NOT NULL DEFAULT 0,
                last_updated INTEGER NOT NULL
            )",
            [],
        )?;

        // Таблица метаданных кэша
        conn.execute(
            "CREATE TABLE IF NOT EXISTS cache_metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )",
            [],
        )?;

        Ok(())
    }

    /// Полное пересоздание кэша (сканирование всех модов)
    pub async fn rebuild(&self) -> Result<RebuildStats> {
        let mods_dir = instance_mods_dir(&self.instance_id);

        // Проверяем что директория существует
        if !tokio::fs::try_exists(&mods_dir).await.unwrap_or(false) {
            return Err(crate::error::LauncherError::InvalidConfig(
                "Mods directory does not exist".to_string()
            ));
        }

        let mut stats = RebuildStats::default();

        // Читаем все .jar файлы
        let mut entries = tokio::fs::read_dir(&mods_dir).await?;
        let mut jar_files = Vec::new();

        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("jar") {
                // Пропускаем .disabled файлы
                if !path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .map(|s| s.ends_with(".disabled"))
                    .unwrap_or(false)
                {
                    jar_files.push(path);
                }
            }
        }

        stats.total_mods = jar_files.len();

        // Очищаем старые данные
        {
            let conn = self.conn.lock().await;
            conn.execute("DELETE FROM items", [])?;
            conn.execute("DELETE FROM blocks", [])?;
            conn.execute("DELETE FROM tags", [])?;
            conn.execute("DELETE FROM mods", [])?;
        }

        // Парсим каждый мод
        for jar_path in jar_files {
            match JarParser::parse_mod_jar(&jar_path) {
                Ok(mod_data) => {
                    if !mod_data.is_empty() {
                        self.save_mod_data(&mod_data).await?;

                        stats.parsed_mods += 1;
                        stats.total_items += mod_data.items.len();
                        stats.total_blocks += mod_data.blocks.len();
                        stats.total_tags += mod_data.tags.len();
                    }
                }
                Err(e) => {
                    eprintln!("Failed to parse {:?}: {}", jar_path, e);
                    stats.failed_mods += 1;
                }
            }
        }

        // Сохраняем метаданные
        {
            let conn = self.conn.lock().await;
            conn.execute(
                "INSERT OR REPLACE INTO cache_metadata (key, value) VALUES ('last_rebuild', ?)",
                params![Utc::now().timestamp()],
            )?;
        }

        Ok(stats)
    }

    /// Сохраняет данные мода в БД
    async fn save_mod_data(&self, mod_data: &super::types::ModData) -> Result<()> {
        let conn = self.conn.lock().await;
        let tx = conn.unchecked_transaction()?;

        let now = Utc::now().timestamp();

        // Сохраняем информацию о моде
        if let Some(mod_info) = &mod_data.mod_info {
            tx.execute(
                "INSERT OR REPLACE INTO mods (mod_id, name, version, loader, item_count, block_count, last_updated)
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
                params![
                    mod_info.mod_id,
                    mod_info.name,
                    mod_info.version,
                    mod_info.loader,
                    mod_data.items.len() as i64,
                    mod_data.blocks.len() as i64,
                    now,
                ],
            )?;
        }

        // Сохраняем предметы
        for item in &mod_data.items {
            tx.execute(
                "INSERT OR REPLACE INTO items (id, name, mod_id, tags, texture_path, stack_size, rarity, description, last_updated)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    item.id,
                    item.name,
                    item.mod_id,
                    serde_json::to_string(&item.tags).unwrap_or_default(),
                    item.texture_path,
                    item.stack_size,
                    item.rarity,
                    item.description,
                    now,
                ],
            )?;
        }

        // Сохраняем блоки
        for block in &mod_data.blocks {
            tx.execute(
                "INSERT OR REPLACE INTO blocks (id, name, mod_id, tags, hardness, blast_resistance, requires_tool, last_updated)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    block.id,
                    block.name,
                    block.mod_id,
                    serde_json::to_string(&block.tags).unwrap_or_default(),
                    block.hardness,
                    block.blast_resistance,
                    block.requires_tool.map(|b| if b { 1 } else { 0 }),
                    now,
                ],
            )?;
        }

        // Сохраняем теги
        for tag in &mod_data.tags {
            tx.execute(
                "INSERT OR REPLACE INTO tags (id, tag_type, values, last_updated)
                 VALUES (?, ?, ?, ?)",
                params![
                    tag.id,
                    match tag.tag_type {
                        TagType::Item => "item",
                        TagType::Block => "block",
                    },
                    serde_json::to_string(&tag.values).unwrap_or_default(),
                    now,
                ],
            )?;
        }

        tx.commit()?;

        Ok(())
    }

    /// Поиск предметов (для автодополнения)
    pub async fn search_items(&self, query: &str, limit: usize) -> Result<Vec<MinecraftItem>> {
        let conn = self.conn.lock().await;

        let mut stmt = conn.prepare(
            "SELECT id, name, mod_id, tags, texture_path, stack_size, rarity, description
             FROM items
             WHERE id LIKE ?1 OR name LIKE ?1
             ORDER BY
                CASE
                    WHEN id = ?2 THEN 0
                    WHEN id LIKE ?3 THEN 1
                    WHEN name LIKE ?3 THEN 2
                    ELSE 3
                END,
                name
             LIMIT ?4",
        )?;

        let pattern = format!("%{}%", query);
        let exact_pattern = format!("{}%", query);

        let items = stmt
            .query_map(params![pattern, query, exact_pattern, limit], |row| {
                Ok(MinecraftItem {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    mod_id: row.get(2)?,
                    tags: serde_json::from_str(&row.get::<_, String>(3)?)
                        .unwrap_or_default(),
                    texture_path: row.get(4)?,
                    stack_size: row.get(5)?,
                    rarity: row.get(6)?,
                    description: row.get(7)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        Ok(items)
    }

    /// Поиск блоков
    pub async fn search_blocks(&self, query: &str, limit: usize) -> Result<Vec<MinecraftBlock>> {
        let conn = self.conn.lock().await;

        let mut stmt = conn.prepare(
            "SELECT id, name, mod_id, tags, hardness, blast_resistance, requires_tool
             FROM blocks
             WHERE id LIKE ?1 OR name LIKE ?1
             ORDER BY name
             LIMIT ?2",
        )?;

        let pattern = format!("%{}%", query);

        let blocks = stmt
            .query_map(params![pattern, limit], |row| {
                Ok(MinecraftBlock {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    mod_id: row.get(2)?,
                    tags: serde_json::from_str(&row.get::<_, String>(3)?)
                        .unwrap_or_default(),
                    hardness: row.get(4)?,
                    blast_resistance: row.get(5)?,
                    requires_tool: row
                        .get::<_, Option<i32>>(6)?
                        .map(|v| v != 0),
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        Ok(blocks)
    }

    /// Поиск тегов
    pub async fn search_tags(
        &self,
        query: &str,
        tag_type: Option<TagType>,
        limit: usize,
    ) -> Result<Vec<MinecraftTag>> {
        let conn = self.conn.lock().await;

        let mut sql = "SELECT id, tag_type, values FROM tags WHERE id LIKE ?1".to_string();

        if tag_type.is_some() {
            sql.push_str(" AND tag_type = ?2");
        }

        sql.push_str(" ORDER BY id LIMIT ?");

        let mut stmt = conn.prepare(&sql)?;

        let pattern = format!("%{}%", query);

        let tags = if let Some(tt) = tag_type {
            let type_str = match tt {
                TagType::Item => "item",
                TagType::Block => "block",
            };

            stmt.query_map(params![pattern, type_str, limit], |row| {
                Ok(MinecraftTag {
                    id: row.get(0)?,
                    tag_type: match row.get::<_, String>(1)?.as_str() {
                        "item" => TagType::Item,
                        "block" => TagType::Block,
                        _ => TagType::Item,
                    },
                    values: serde_json::from_str(&row.get::<_, String>(2)?)
                        .unwrap_or_default(),
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?
        } else {
            stmt.query_map(params![pattern, limit], |row| {
                Ok(MinecraftTag {
                    id: row.get(0)?,
                    tag_type: match row.get::<_, String>(1)?.as_str() {
                        "item" => TagType::Item,
                        "block" => TagType::Block,
                        _ => TagType::Item,
                    },
                    values: serde_json::from_str(&row.get::<_, String>(2)?)
                        .unwrap_or_default(),
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?
        };

        Ok(tags)
    }

    /// Получить информацию о всех модах
    pub async fn get_mods(&self) -> Result<Vec<ModInfo>> {
        let conn = self.conn.lock().await;

        let mut stmt = conn.prepare(
            "SELECT mod_id, name, version, loader, item_count, block_count
             FROM mods
             ORDER BY name",
        )?;

        let mods = stmt
            .query_map([], |row| {
                Ok(ModInfo {
                    mod_id: row.get(0)?,
                    name: row.get(1)?,
                    version: row.get(2)?,
                    loader: row.get(3)?,
                    item_count: row.get::<_, i64>(4)? as usize,
                    block_count: row.get::<_, i64>(5)? as usize,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        Ok(mods)
    }

    /// Получить статистику кэша
    pub async fn get_stats(&self) -> Result<CacheStats> {
        let conn = self.conn.lock().await;

        let total_items: i64 = conn.query_row("SELECT COUNT(*) FROM items", [], |row| row.get(0))?;
        let total_blocks: i64 =
            conn.query_row("SELECT COUNT(*) FROM blocks", [], |row| row.get(0))?;
        let total_tags: i64 = conn.query_row("SELECT COUNT(*) FROM tags", [], |row| row.get(0))?;
        let total_mods: i64 = conn.query_row("SELECT COUNT(*) FROM mods", [], |row| row.get(0))?;

        let last_rebuild: Option<i64> = conn
            .query_row(
                "SELECT value FROM cache_metadata WHERE key = 'last_rebuild'",
                [],
                |row| row.get(0),
            )
            .ok();

        Ok(CacheStats {
            total_items: total_items as usize,
            total_blocks: total_blocks as usize,
            total_tags: total_tags as usize,
            total_mods: total_mods as usize,
            last_rebuild,
        })
    }
}

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct RebuildStats {
    pub total_mods: usize,
    pub parsed_mods: usize,
    pub failed_mods: usize,
    pub total_items: usize,
    pub total_blocks: usize,
    pub total_tags: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CacheStats {
    pub total_items: usize,
    pub total_blocks: usize,
    pub total_tags: usize,
    pub total_mods: usize,
    pub last_rebuild: Option<i64>,
}
