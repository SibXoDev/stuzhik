pub mod language_server;
pub mod metadata;
pub mod minecraft_data;
pub mod project_detector;
pub mod type_definitions;

use minecraft_data::{
    CacheStats, MinecraftBlock, MinecraftDataCache, MinecraftItem, MinecraftTag, ModInfo,
    RebuildStats, TagType,
};
use serde::Serialize;

/// Унифицированный тип для предметов и блоков (для Recipe Builder)
#[derive(Debug, Clone, Serialize)]
pub struct MinecraftEntry {
    pub id: String,
    pub name: String,
    pub mod_id: String,
    pub texture_path: Option<String>,
    pub entry_type: String, // "item" или "block"
}

impl From<MinecraftItem> for MinecraftEntry {
    fn from(item: MinecraftItem) -> Self {
        Self {
            id: item.id,
            name: item.name,
            mod_id: item.mod_id,
            texture_path: item.texture_path,
            entry_type: "item".to_string(),
        }
    }
}

impl From<MinecraftBlock> for MinecraftEntry {
    fn from(block: MinecraftBlock) -> Self {
        Self {
            id: block.id,
            name: block.name,
            mod_id: block.mod_id,
            texture_path: block.texture_path,
            entry_type: "block".to_string(),
        }
    }
}

/// Перестроить кэш Minecraft данных для instance
#[tauri::command]
pub async fn rebuild_minecraft_data_cache(instance_id: String) -> Result<RebuildStats, String> {
    let cache = MinecraftDataCache::init(&instance_id)
        .await
        .map_err(|e| e.to_string())?;

    cache.rebuild().await.map_err(|e| e.to_string())
}

/// Получить статистику кэша
#[tauri::command]
pub async fn get_minecraft_data_stats(instance_id: String) -> Result<CacheStats, String> {
    let cache = MinecraftDataCache::init(&instance_id)
        .await
        .map_err(|e| e.to_string())?;

    cache.get_stats().await.map_err(|e| e.to_string())
}

/// Поиск предметов (для автодополнения)
#[tauri::command]
pub async fn search_minecraft_items(
    instance_id: String,
    query: String,
    mod_id: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<MinecraftItem>, String> {
    let cache = MinecraftDataCache::init(&instance_id)
        .await
        .map_err(|e| e.to_string())?;

    cache
        .search_items(&query, mod_id.as_deref(), limit.unwrap_or(50))
        .await
        .map_err(|e| e.to_string())
}

/// Получить список всех модов с их item/block counts
#[tauri::command]
pub async fn get_minecraft_mods(instance_id: String) -> Result<Vec<ModInfo>, String> {
    let cache = MinecraftDataCache::init(&instance_id)
        .await
        .map_err(|e| e.to_string())?;

    cache.get_mods().await.map_err(|e| e.to_string())
}

/// Поиск блоков
#[tauri::command]
pub async fn search_minecraft_blocks(
    instance_id: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<MinecraftBlock>, String> {
    let cache = MinecraftDataCache::init(&instance_id)
        .await
        .map_err(|e| e.to_string())?;

    cache
        .search_blocks(&query, limit.unwrap_or(50))
        .await
        .map_err(|e| e.to_string())
}

/// Поиск тегов
#[tauri::command]
pub async fn search_minecraft_tags(
    instance_id: String,
    query: String,
    tag_type: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<MinecraftTag>, String> {
    let cache = MinecraftDataCache::init(&instance_id)
        .await
        .map_err(|e| e.to_string())?;

    let parsed_type = tag_type.and_then(|t| match t.as_str() {
        "item" => Some(TagType::Item),
        "block" => Some(TagType::Block),
        _ => None,
    });

    cache
        .search_tags(&query, parsed_type, limit.unwrap_or(50))
        .await
        .map_err(|e| e.to_string())
}

/// Комбинированный поиск предметов И блоков (для Recipe Builder)
/// Дедуплицирует по ID - если есть и item и block с одинаковым ID, берём item (у него обычно лучше текстура)
#[tauri::command]
pub async fn search_minecraft_entries(
    instance_id: String,
    query: String,
    mod_id: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<MinecraftEntry>, String> {
    use std::collections::HashSet;

    let cache = MinecraftDataCache::init(&instance_id)
        .await
        .map_err(|e| e.to_string())?;

    let limit = limit.unwrap_or(100);

    // Поиск предметов (с фильтром по mod_id)
    let items = cache
        .search_items(&query, mod_id.as_deref(), limit * 2)
        .await
        .map_err(|e| e.to_string())?;

    // Поиск блоков (с фильтром по mod_id)
    let blocks = cache
        .search_blocks_filtered(&query, mod_id.as_deref(), limit * 2)
        .await
        .map_err(|e| e.to_string())?;

    // Дедупликация: items имеют приоритет над blocks
    let mut seen_ids: HashSet<String> = HashSet::new();
    let mut entries: Vec<MinecraftEntry> = Vec::with_capacity(limit);

    // Сначала добавляем items
    for item in items {
        if seen_ids.insert(item.id.clone()) {
            entries.push(item.into());
        }
    }

    // Потом blocks (только если ID ещё не добавлен)
    for block in blocks {
        if seen_ids.insert(block.id.clone()) {
            entries.push(block.into());
        }
    }

    // Сортируем: сначала с текстурами, потом по имени
    entries.sort_by(
        |a, b| match (a.texture_path.is_some(), b.texture_path.is_some()) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.cmp(&b.name),
        },
    );

    // Ограничиваем итоговый результат
    entries.truncate(limit);

    Ok(entries)
}
