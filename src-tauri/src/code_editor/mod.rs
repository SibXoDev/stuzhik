pub mod language_server;
pub mod minecraft_data;
pub mod type_definitions;

use minecraft_data::{CacheStats, MinecraftDataCache, MinecraftItem, MinecraftBlock, MinecraftTag, RebuildStats, TagType};

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
    limit: Option<usize>,
) -> Result<Vec<MinecraftItem>, String> {
    let cache = MinecraftDataCache::init(&instance_id)
        .await
        .map_err(|e| e.to_string())?;

    cache
        .search_items(&query, limit.unwrap_or(50))
        .await
        .map_err(|e| e.to_string())
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
