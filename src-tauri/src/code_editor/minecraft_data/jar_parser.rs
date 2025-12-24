use super::types::{MinecraftBlock, MinecraftItem, MinecraftTag, ModData, ModInfo, TagType};
use crate::error::Result;
use serde_json::Value;
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use zip::ZipArchive;

pub struct JarParser;

impl JarParser {
    /// Парсит .jar файл мода и извлекает все данные
    pub fn parse_mod_jar(jar_path: &Path) -> Result<ModData> {
        let file = std::fs::File::open(jar_path)?;
        let mut archive = ZipArchive::new(file)?;

        let mut data = ModData::new();

        // 1. Определяем тип мода и извлекаем базовую информацию
        let mod_info = Self::extract_mod_info(&mut archive)?;
        let mod_id = mod_info.mod_id.clone();
        data.mod_info = Some(mod_info);

        // 2. Читаем локализацию (для имен предметов/блоков)
        let lang_data = Self::read_lang_file(&mut archive, &mod_id);

        // 3. Парсим items и blocks
        // Пытаемся найти registry файлы или используем эвристику
        Self::extract_items_and_blocks(&mut archive, &mod_id, &lang_data, &mut data);

        // 4. Парсим теги
        Self::extract_tags(&mut archive, &mod_id, &mut data);

        Ok(data)
    }

    /// Извлекает информацию о моде (mod_id, version, loader)
    fn extract_mod_info(archive: &mut ZipArchive<std::fs::File>) -> Result<ModInfo> {
        // Попытка 1: Fabric (fabric.mod.json)
        if let Ok(mut file) = archive.by_name("fabric.mod.json") {
            let mut content = String::new();
            file.read_to_string(&mut content)?;

            let json: Value = serde_json::from_str(&content)?;

            return Ok(ModInfo {
                mod_id: json["id"].as_str().unwrap_or("unknown").to_string(),
                name: json["name"].as_str().unwrap_or("Unknown").to_string(),
                version: json["version"].as_str().unwrap_or("0.0.0").to_string(),
                loader: "fabric".to_string(),
                item_count: 0,
                block_count: 0,
            });
        }

        // Попытка 2: Forge/NeoForge (META-INF/mods.toml)
        if let Ok(mut file) = archive.by_name("META-INF/mods.toml") {
            let mut content = String::new();
            file.read_to_string(&mut content)?;

            // Простой TOML парсинг (ищем [[mods]] секцию)
            let mod_id = Self::parse_toml_value(&content, "modId");
            let version = Self::parse_toml_value(&content, "version");
            let display_name = Self::parse_toml_value(&content, "displayName");

            return Ok(ModInfo {
                mod_id: mod_id.unwrap_or_else(|| "unknown".to_string()),
                name: display_name.unwrap_or_else(|| "Unknown".to_string()),
                version: version.unwrap_or_else(|| "0.0.0".to_string()),
                loader: if content.contains("neoforge") {
                    "neoforge".to_string()
                } else {
                    "forge".to_string()
                },
                item_count: 0,
                block_count: 0,
            });
        }

        // Fallback: используем имя файла
        Err(crate::error::LauncherError::InvalidConfig(
            "Could not determine mod info".to_string()
        ))
    }

    /// Простой TOML парсер для извлечения значений
    fn parse_toml_value(content: &str, key: &str) -> Option<String> {
        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with(key) {
                if let Some(value_part) = trimmed.split('=').nth(1) {
                    let value = value_part
                        .trim()
                        .trim_matches('"')
                        .trim_matches('\'')
                        .to_string();
                    return Some(value);
                }
            }
        }
        None
    }

    /// Читает файл локализации (assets/<mod_id>/lang/en_us.json)
    fn read_lang_file(
        archive: &mut ZipArchive<std::fs::File>,
        mod_id: &str,
    ) -> HashMap<String, String> {
        let mut lang_data = HashMap::new();

        // Пути для поиска
        let paths = [
            format!("assets/{}/lang/en_us.json", mod_id),
            format!("assets/{}/lang/en_US.json", mod_id),
            "assets/minecraft/lang/en_us.json".to_string(),
        ];

        for path in &paths {
            if let Ok(mut file) = archive.by_name(path) {
                let mut content = String::new();
                if file.read_to_string(&mut content).is_ok() {
                    if let Ok(json) = serde_json::from_str::<HashMap<String, Value>>(&content) {
                        for (key, value) in json {
                            if let Some(text) = value.as_str() {
                                lang_data.insert(key, text.to_string());
                            }
                        }
                        break;
                    }
                }
            }
        }

        lang_data
    }

    /// Извлекает предметы и блоки (эвристический подход)
    fn extract_items_and_blocks(
        archive: &mut ZipArchive<std::fs::File>,
        mod_id: &str,
        lang_data: &HashMap<String, String>,
        data: &mut ModData,
    ) {
        // Ищем все файлы моделей предметов
        // assets/<mod_id>/models/item/*.json -> это item
        // assets/<mod_id>/models/block/*.json -> это block

        for i in 0..archive.len() {
            if let Ok(file) = archive.by_index(i) {
                let name = file.name();

                // Items
                if name.starts_with(&format!("assets/{}/models/item/", mod_id))
                    && name.ends_with(".json")
                {
                    if let Some(item_name) = name.split('/').last() {
                        let item_id = item_name.trim_end_matches(".json");
                        let full_id = format!("{}:{}", mod_id, item_id);

                        // Ищем локализованное имя
                        let localized_name = lang_data
                            .get(&format!("item.{}.{}", mod_id, item_id))
                            .or_else(|| lang_data.get(&format!("block.{}.{}", mod_id, item_id)))
                            .cloned()
                            .unwrap_or_else(|| Self::humanize_name(item_id));

                        data.items.push(MinecraftItem {
                            id: full_id,
                            name: localized_name,
                            mod_id: mod_id.to_string(),
                            tags: vec![],
                            texture_path: Some(name.to_string()),
                            stack_size: 64,
                            rarity: "common".to_string(),
                            description: None,
                        });
                    }
                }

                // Blocks
                if name.starts_with(&format!("assets/{}/models/block/", mod_id))
                    && name.ends_with(".json")
                {
                    if let Some(block_name) = name.split('/').last() {
                        let block_id = block_name.trim_end_matches(".json");
                        let full_id = format!("{}:{}", mod_id, block_id);

                        let localized_name = lang_data
                            .get(&format!("block.{}.{}", mod_id, block_id))
                            .cloned()
                            .unwrap_or_else(|| Self::humanize_name(block_id));

                        data.blocks.push(MinecraftBlock {
                            id: full_id,
                            name: localized_name,
                            mod_id: mod_id.to_string(),
                            tags: vec![],
                            hardness: None,
                            blast_resistance: None,
                            requires_tool: None,
                        });
                    }
                }
            }
        }
    }

    /// Извлекает теги из data/<mod_id>/tags/items/*.json и data/<mod_id>/tags/blocks/*.json
    fn extract_tags(
        archive: &mut ZipArchive<std::fs::File>,
        mod_id: &str,
        data: &mut ModData,
    ) {
        for i in 0..archive.len() {
            if let Ok(mut file) = archive.by_index(i) {
                let name = file.name().to_string(); // Clone to owned String to avoid borrow conflicts

                // Item tags
                if name.starts_with(&format!("data/{}/tags/items/", mod_id))
                    || name.starts_with("data/forge/tags/items/")
                    || name.starts_with("data/c/tags/items/")
                {
                    if name.ends_with(".json") {
                        let tag_name = Self::extract_tag_name(&name, mod_id, TagType::Item);
                        if let Ok(values) = Self::parse_tag_file(&mut file) {
                            data.tags.push(MinecraftTag {
                                id: tag_name,
                                tag_type: TagType::Item,
                                values,
                            });
                        }
                    }
                }

                // Block tags
                if name.starts_with(&format!("data/{}/tags/blocks/", mod_id))
                    || name.starts_with("data/forge/tags/blocks/")
                    || name.starts_with("data/c/tags/blocks/")
                {
                    if name.ends_with(".json") {
                        let tag_name = Self::extract_tag_name(&name, mod_id, TagType::Block);
                        if let Ok(values) = Self::parse_tag_file(&mut file) {
                            data.tags.push(MinecraftTag {
                                id: tag_name,
                                tag_type: TagType::Block,
                                values,
                            });
                        }
                    }
                }
            }
        }
    }

    /// Извлекает имя тега из пути
    fn extract_tag_name(path: &str, _mod_id: &str, tag_type: TagType) -> String {
        // data/forge/tags/items/ingots/iron.json -> forge:ingots/iron
        let parts: Vec<&str> = path.split('/').collect();

        if parts.len() >= 5 {
            let namespace = parts[1]; // forge, c, mod_id
            let tag_folder = match tag_type {
                TagType::Item => "items",
                TagType::Block => "blocks",
            };

            // Находим индекс папки tags
            if let Some(tags_idx) = parts.iter().position(|&p| p == "tags") {
                if tags_idx + 2 < parts.len() {
                    // Собираем путь после tags/items/ или tags/blocks/
                    let tag_path: Vec<&str> = parts[tags_idx + 2..].to_vec();
                    let joined = tag_path.join("/");
                    let tag_name = joined.trim_end_matches(".json");

                    return format!("{}:{}", namespace, tag_name);
                }
            }
        }

        "unknown:unknown".to_string()
    }

    /// Парсит JSON файл тега
    fn parse_tag_file<R: std::io::Read>(file: &mut R) -> Result<Vec<String>> {
        let mut content = String::new();
        file.read_to_string(&mut content)?;

        let json: Value = serde_json::from_str(&content)?;

        let mut values = Vec::new();

        if let Some(values_array) = json["values"].as_array() {
            for value in values_array {
                if let Some(item_id) = value.as_str() {
                    values.push(item_id.to_string());
                } else if let Some(obj) = value.as_object() {
                    // Некоторые теги имеют формат { "id": "...", "required": false }
                    if let Some(id) = obj.get("id").and_then(|v| v.as_str()) {
                        values.push(id.to_string());
                    }
                }
            }
        }

        Ok(values)
    }

    /// Превращает snake_case в "Human Readable"
    fn humanize_name(name: &str) -> String {
        name.split('_')
            .map(|word| {
                let mut chars = word.chars();
                match chars.next() {
                    Some(first) => {
                        first.to_uppercase().chain(chars).collect::<String>()
                    }
                    None => String::new(),
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_humanize_name() {
        assert_eq!(JarParser::humanize_name("iron_ingot"), "Iron Ingot");
        assert_eq!(JarParser::humanize_name("diamond_sword"), "Diamond Sword");
        assert_eq!(
            JarParser::humanize_name("andesite_alloy"),
            "Andesite Alloy"
        );
    }
}
