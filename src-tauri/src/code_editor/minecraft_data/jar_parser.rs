use super::types::{MinecraftBlock, MinecraftItem, MinecraftTag, ModData, ModInfo, TagType};
use crate::error::Result;
use crate::paths::cache_dir;
use serde_json::Value;
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use zip::ZipArchive;

/// Санитизирует строку для использования в пути файловой системы
fn sanitize_for_path(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect()
}

pub struct JarParser;

impl JarParser {
    /// Парсит .jar файл мода и извлекает все данные
    pub fn parse_mod_jar(jar_path: &Path) -> Result<ModData> {
        Self::parse_mod_jar_with_textures(jar_path, None)
    }

    /// Парсит .jar файл мода с извлечением текстур
    pub fn parse_mod_jar_with_textures(
        jar_path: &Path,
        instance_id: Option<&str>,
    ) -> Result<ModData> {
        let file = std::fs::File::open(jar_path)?;
        let mut archive = ZipArchive::new(file)?;

        let mut data = ModData::new();

        // 1. Определяем тип мода и извлекаем базовую информацию
        let mod_info = Self::extract_mod_info(&mut archive)?;
        let mod_id = mod_info.mod_id.clone();
        data.mod_info = Some(mod_info);

        // 2. Читаем локализацию (для имен предметов/блоков)
        let lang_data = Self::read_lang_file(&mut archive, &mod_id);

        // 3. Извлекаем текстуры если указан instance_id
        let (item_textures, block_textures) = if let Some(inst_id) = instance_id {
            Self::extract_textures(&mut archive, &mod_id, inst_id)
        } else {
            (HashMap::new(), HashMap::new())
        };

        // 4. Парсим items и blocks с текстурами
        Self::extract_items_and_blocks(
            &mut archive,
            &mod_id,
            &lang_data,
            &item_textures,
            &block_textures,
            &mut data,
        );

        // 5. Парсим теги
        Self::extract_tags(&mut archive, &mod_id, &mut data);

        Ok(data)
    }

    /// Извлекает текстуры предметов и блоков из JAR файла
    /// Возвращает (item_textures, block_textures)
    ///
    /// Хранит текстуры с несколькими ключами для лучшего матчинга:
    /// - Полный путь: mod_id:path/to/texture
    /// - Только имя: mod_id:texture_name
    fn extract_textures(
        archive: &mut ZipArchive<std::fs::File>,
        mod_id: &str,
        instance_id: &str,
    ) -> (HashMap<String, String>, HashMap<String, String>) {
        let mut item_textures = HashMap::new();
        let mut block_textures = HashMap::new();

        // Санитизируем пути для Windows
        let safe_instance_id = sanitize_for_path(instance_id);
        let safe_mod_id = sanitize_for_path(mod_id);

        // Создаём директорию для текстур
        let textures_dir = cache_dir()
            .join("textures")
            .join(&safe_instance_id)
            .join(&safe_mod_id);

        if let Err(e) = std::fs::create_dir_all(&textures_dir) {
            eprintln!("Failed to create textures dir: {}", e);
            return (item_textures, block_textures);
        }

        // Ищем все PNG текстуры
        for i in 0..archive.len() {
            if let Ok(mut file) = archive.by_index(i) {
                let name = file.name().to_string();

                // Item textures: assets/<mod_id>/textures/item/**/*.png
                // Block textures: assets/<mod_id>/textures/block/**/*.png
                let item_prefix = format!("assets/{}/textures/item/", mod_id);
                let block_prefix = format!("assets/{}/textures/block/", mod_id);

                let (is_item, prefix) = if name.starts_with(&item_prefix) {
                    (true, &item_prefix)
                } else if name.starts_with(&block_prefix) {
                    (false, &block_prefix)
                } else {
                    continue;
                };

                if !name.ends_with(".png") {
                    continue;
                }

                // Извлекаем относительный путь (включая подпапки)
                let relative_path = &name[prefix.len()..];
                // Имя файла без пути
                let texture_filename = relative_path.rsplit('/').next().unwrap_or(relative_path);

                if texture_filename.is_empty() {
                    continue;
                }

                // ID с полным путём (без .png): mod_id:path/to/texture
                let relative_without_ext = relative_path.trim_end_matches(".png");
                let full_path_id = format!("{}:{}", mod_id, relative_without_ext);

                // ID только с именем (без .png): mod_id:texture
                let simple_id = texture_filename.trim_end_matches(".png");
                let full_simple_id = format!("{}:{}", mod_id, simple_id);

                // Сохраняем файл (санитизируем имя файла)
                // Используем полный путь для уникальности
                let type_prefix = if is_item { "item_" } else { "block_" };
                let safe_texture_name = format!(
                    "{}{}",
                    type_prefix,
                    sanitize_for_path(&relative_path.replace('/', "_"))
                );
                let dest_path = textures_dir.join(&safe_texture_name);

                // Читаем данные текстуры
                let mut buffer = Vec::new();
                if file.read_to_end(&mut buffer).is_ok() {
                    if std::fs::write(&dest_path, &buffer).is_ok() {
                        let path_str = dest_path.to_string_lossy().to_string();
                        if is_item {
                            // Храним оба варианта для лучшего матчинга
                            item_textures.insert(full_path_id, path_str.clone());
                            // Только если простой ID ещё не занят (приоритет полному пути)
                            item_textures.entry(full_simple_id).or_insert(path_str);
                        } else {
                            block_textures.insert(full_path_id, path_str.clone());
                            block_textures.entry(full_simple_id).or_insert(path_str);
                        }
                    }
                }
            }
        }

        (item_textures, block_textures)
    }

    /// Извлекает информацию о моде (mod_id, version, loader, description, authors, etc.)
    fn extract_mod_info(archive: &mut ZipArchive<std::fs::File>) -> Result<ModInfo> {
        // 1. Fabric/Quilt: fabric.mod.json
        if let Ok(mut file) = archive.by_name("fabric.mod.json") {
            let mut content = String::new();
            file.read_to_string(&mut content)?;

            let json: Value = serde_json::from_str(&content)?;

            // Извлекаем авторов (может быть массив строк или объектов)
            let authors = json.get("authors").and_then(|a| {
                if let Some(arr) = a.as_array() {
                    let names: Vec<String> = arr
                        .iter()
                        .filter_map(|v| {
                            if let Some(s) = v.as_str() {
                                Some(s.to_string())
                            } else if let Some(obj) = v.as_object() {
                                obj.get("name")
                                    .and_then(|n| n.as_str())
                                    .map(|s| s.to_string())
                            } else {
                                None
                            }
                        })
                        .collect();
                    if names.is_empty() {
                        None
                    } else {
                        Some(names)
                    }
                } else {
                    None
                }
            });

            // Извлекаем homepage из contact
            let homepage = json
                .get("contact")
                .and_then(|c| c.get("homepage"))
                .and_then(|h| h.as_str())
                .map(|s| s.to_string())
                .or_else(|| {
                    json.get("contact")
                        .and_then(|c| c.get("sources"))
                        .and_then(|h| h.as_str())
                        .map(|s| s.to_string())
                });

            return Ok(ModInfo {
                mod_id: json["id"].as_str().unwrap_or("unknown").to_string(),
                name: json["name"].as_str().unwrap_or("Unknown").to_string(),
                version: json["version"].as_str().unwrap_or("0.0.0").to_string(),
                loader: "fabric".to_string(),
                description: json
                    .get("description")
                    .and_then(|d| d.as_str())
                    .map(|s| s.to_string()),
                authors,
                homepage,
                license: json
                    .get("license")
                    .and_then(|l| l.as_str())
                    .map(|s| s.to_string()),
                item_count: 0,
                block_count: 0,
            });
        }

        // 2. Forge/NeoForge 1.13+: META-INF/mods.toml (proper TOML parsing)
        if let Ok(mut file) = archive.by_name("META-INF/mods.toml") {
            let mut content = String::new();
            file.read_to_string(&mut content)?;

            // Use proper TOML parsing
            if let Ok(toml_value) = content.parse::<toml::Value>() {
                if let Some(mods) = toml_value.get("mods").and_then(|v| v.as_array()) {
                    if let Some(first_mod) = mods.first() {
                        let mod_id = first_mod
                            .get("modId")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown")
                            .to_string();
                        let display_name = first_mod
                            .get("displayName")
                            .and_then(|v| v.as_str())
                            .unwrap_or("Unknown")
                            .to_string();
                        let version = first_mod
                            .get("version")
                            .and_then(|v| v.as_str())
                            .unwrap_or("0.0.0")
                            .to_string();
                        let description = first_mod
                            .get("description")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                        let authors = first_mod
                            .get("authors")
                            .and_then(|v| v.as_str())
                            .map(|s| vec![s.to_string()]);
                        let homepage = first_mod
                            .get("displayURL")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                        let license = toml_value
                            .get("license")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());

                        let loader = if content.contains("neoforge") {
                            "neoforge".to_string()
                        } else {
                            "forge".to_string()
                        };

                        return Ok(ModInfo {
                            mod_id,
                            name: display_name,
                            version,
                            loader,
                            description,
                            authors,
                            homepage,
                            license,
                            item_count: 0,
                            block_count: 0,
                        });
                    }
                }
            }
        }

        // 3. Legacy Forge (pre-1.13): mcmod.info
        if let Ok(mut file) = archive.by_name("mcmod.info") {
            let mut content = String::new();
            file.read_to_string(&mut content)?;

            if let Ok(json) = serde_json::from_str::<Value>(&content) {
                // mcmod.info can be array or object with modList
                let mod_info = if let Some(arr) = json.as_array() {
                    arr.first()
                } else if let Some(mod_list) = json.get("modList").and_then(|v| v.as_array()) {
                    mod_list.first()
                } else {
                    None
                };

                if let Some(info) = mod_info {
                    let authors = info
                        .get("authorList")
                        .and_then(|a| a.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                                .collect::<Vec<_>>()
                        })
                        .filter(|v: &Vec<String>| !v.is_empty());

                    return Ok(ModInfo {
                        mod_id: info["modid"].as_str().unwrap_or("unknown").to_string(),
                        name: info["name"].as_str().unwrap_or("Unknown").to_string(),
                        version: info["version"].as_str().unwrap_or("0.0.0").to_string(),
                        loader: "forge".to_string(),
                        description: info
                            .get("description")
                            .and_then(|d| d.as_str())
                            .map(|s| s.to_string()),
                        authors,
                        homepage: info
                            .get("url")
                            .and_then(|u| u.as_str())
                            .map(|s| s.to_string()),
                        license: None,
                        item_count: 0,
                        block_count: 0,
                    });
                }
            }
        }

        // Fallback: используем имя файла
        Err(crate::error::LauncherError::InvalidConfig(
            "Could not determine mod info".to_string(),
        ))
    }

    /// Извлекает зависимости мода из JAR файла (fabric.mod.json, mods.toml, mcmod.info)
    pub fn extract_dependencies(
        jar_path: &std::path::Path,
    ) -> Vec<super::types::ParsedModDependency> {
        let file = match std::fs::File::open(jar_path) {
            Ok(f) => f,
            Err(_) => return vec![],
        };

        let mut archive = match ZipArchive::new(file) {
            Ok(a) => a,
            Err(_) => return vec![],
        };

        let mut dependencies = Vec::new();

        // 1. Fabric/Quilt: fabric.mod.json
        if let Ok(mut file) = archive.by_name("fabric.mod.json") {
            let mut content = String::new();
            if file.read_to_string(&mut content).is_ok() {
                if let Ok(json) = serde_json::from_str::<Value>(&content) {
                    // "depends" - required dependencies
                    if let Some(depends) = json.get("depends").and_then(|v| v.as_object()) {
                        for (dep_id, version) in depends {
                            // Skip minecraft and fabric-api variants (they're always present)
                            if dep_id == "minecraft" || dep_id == "java" || dep_id == "fabricloader"
                            {
                                continue;
                            }
                            dependencies.push(super::types::ParsedModDependency {
                                dependency_id: dep_id.clone(),
                                dependency_type: "required".to_string(),
                                version_requirement: version.as_str().map(|s| s.to_string()),
                            });
                        }
                    }

                    // "recommends" - optional dependencies
                    if let Some(recommends) = json.get("recommends").and_then(|v| v.as_object()) {
                        for (dep_id, version) in recommends {
                            dependencies.push(super::types::ParsedModDependency {
                                dependency_id: dep_id.clone(),
                                dependency_type: "optional".to_string(),
                                version_requirement: version.as_str().map(|s| s.to_string()),
                            });
                        }
                    }

                    // "breaks" - incompatible mods
                    if let Some(breaks) = json.get("breaks").and_then(|v| v.as_object()) {
                        for (dep_id, version) in breaks {
                            dependencies.push(super::types::ParsedModDependency {
                                dependency_id: dep_id.clone(),
                                dependency_type: "incompatible".to_string(),
                                version_requirement: version.as_str().map(|s| s.to_string()),
                            });
                        }
                    }

                    return dependencies;
                }
            }
        }

        // 2. Forge/NeoForge: META-INF/mods.toml
        if let Ok(mut file) = archive.by_name("META-INF/mods.toml") {
            let mut content = String::new();
            if file.read_to_string(&mut content).is_ok() {
                if let Ok(toml_value) = content.parse::<toml::Value>() {
                    // Get the mod_id from [[mods]] section
                    let mod_id = toml_value
                        .get("mods")
                        .and_then(|v| v.as_array())
                        .and_then(|arr| arr.first())
                        .and_then(|m| m.get("modId"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown");

                    // Dependencies are in [[dependencies.modId]] sections
                    if let Some(deps_table) =
                        toml_value.get("dependencies").and_then(|v| v.as_table())
                    {
                        // Check for dependencies under our mod_id key
                        if let Some(mod_deps) = deps_table.get(mod_id).and_then(|v| v.as_array()) {
                            for dep in mod_deps {
                                let dep_id = match dep.get("modId").and_then(|v| v.as_str()) {
                                    Some(id) => id,
                                    None => continue,
                                };
                                // Skip common Forge/MC dependencies
                                if dep_id == "minecraft"
                                    || dep_id == "forge"
                                    || dep_id == "neoforge"
                                {
                                    continue;
                                }

                                let mandatory = dep
                                    .get("mandatory")
                                    .and_then(|v| v.as_bool())
                                    .unwrap_or(true);
                                let dep_type = if mandatory { "required" } else { "optional" };

                                let version_req = dep
                                    .get("versionRange")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string());

                                dependencies.push(super::types::ParsedModDependency {
                                    dependency_id: dep_id.to_string(),
                                    dependency_type: dep_type.to_string(),
                                    version_requirement: version_req,
                                });
                            }
                        }
                    }

                    return dependencies;
                }
            }
        }

        // 3. Legacy Forge: mcmod.info
        if let Ok(mut file) = archive.by_name("mcmod.info") {
            let mut content = String::new();
            if file.read_to_string(&mut content).is_ok() {
                if let Ok(json) = serde_json::from_str::<Value>(&content) {
                    // mcmod.info can be array or object with modList
                    let mod_info = if let Some(arr) = json.as_array() {
                        arr.first()
                    } else if let Some(mod_list) = json.get("modList").and_then(|v| v.as_array()) {
                        mod_list.first()
                    } else {
                        None
                    };

                    if let Some(info) = mod_info {
                        // "dependencies" array
                        if let Some(deps) = info.get("dependencies").and_then(|v| v.as_array()) {
                            for dep in deps {
                                if let Some(dep_str) = dep.as_str() {
                                    // Skip Forge/MC
                                    if dep_str.contains("Forge") || dep_str == "Minecraft" {
                                        continue;
                                    }
                                    dependencies.push(super::types::ParsedModDependency {
                                        dependency_id: dep_str.to_string(),
                                        dependency_type: "required".to_string(),
                                        version_requirement: None,
                                    });
                                }
                            }
                        }

                        // "requiredMods" array (alternative format)
                        if let Some(deps) = info.get("requiredMods").and_then(|v| v.as_array()) {
                            for dep in deps {
                                if let Some(dep_str) = dep.as_str() {
                                    if dep_str.contains("Forge") || dep_str == "Minecraft" {
                                        continue;
                                    }
                                    dependencies.push(super::types::ParsedModDependency {
                                        dependency_id: dep_str.to_string(),
                                        dependency_type: "required".to_string(),
                                        version_requirement: None,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }

        dependencies
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

    /// Извлекает предметы и блоки с улучшенным парсингом текстур
    fn extract_items_and_blocks(
        archive: &mut ZipArchive<std::fs::File>,
        mod_id: &str,
        lang_data: &HashMap<String, String>,
        item_textures: &HashMap<String, String>,
        block_textures: &HashMap<String, String>,
        data: &mut ModData,
    ) {
        // Карты для хранения ссылок из моделей
        let mut item_model_refs: HashMap<String, String> = HashMap::new();
        let mut block_model_refs: HashMap<String, String> = HashMap::new();

        // Первый проход: парсим все модели (item и block) для извлечения текстурных ссылок
        for i in 0..archive.len() {
            if let Ok(mut file) = archive.by_index(i) {
                let name = file.name().to_string();

                let item_prefix = format!("assets/{}/models/item/", mod_id);
                let block_prefix = format!("assets/{}/models/block/", mod_id);

                let (is_item, model_name) =
                    if name.starts_with(&item_prefix) && name.ends_with(".json") {
                        (true, name.split('/').last())
                    } else if name.starts_with(&block_prefix) && name.ends_with(".json") {
                        (false, name.split('/').last())
                    } else {
                        continue;
                    };

                if let Some(model_file) = model_name {
                    let model_id = model_file.trim_end_matches(".json");
                    let full_id = format!("{}:{}", mod_id, model_id);

                    let mut content = String::new();
                    if file.read_to_string(&mut content).is_ok() {
                        if let Ok(json) = serde_json::from_str::<Value>(&content) {
                            // Ищем текстурные ссылки в модели
                            if let Some(textures) = json.get("textures").and_then(|t| t.as_object())
                            {
                                // Приоритет текстур для предметов
                                let item_keys = ["layer0", "0", "all", "particle", "texture"];
                                // Приоритет текстур для блоков (предпочитаем лицевую сторону)
                                let block_keys = [
                                    "front", "all", "top", "side", "north", "particle", "texture",
                                    "0",
                                ];

                                let keys = if is_item {
                                    &item_keys[..]
                                } else {
                                    &block_keys[..]
                                };

                                for key in keys {
                                    if let Some(tex) = textures.get(*key).and_then(|v| v.as_str()) {
                                        let tex_id = Self::parse_texture_ref(tex, mod_id);
                                        if is_item {
                                            item_model_refs.insert(full_id.clone(), tex_id);
                                        } else {
                                            block_model_refs.insert(full_id.clone(), tex_id);
                                        }
                                        break;
                                    }
                                }
                            }

                            // Если текстура не найдена, проверяем parent
                            let refs = if is_item {
                                &item_model_refs
                            } else {
                                &block_model_refs
                            };
                            if !refs.contains_key(&full_id) {
                                if let Some(parent) = json.get("parent").and_then(|p| p.as_str()) {
                                    // Parent может указывать на блок или другую модель
                                    let parent_id = if parent.contains(':') {
                                        // Уже содержит namespace
                                        if parent.contains("block/") {
                                            parent.split("block/").last().map(|n| {
                                                format!(
                                                    "{}:{}",
                                                    parent.split(':').next().unwrap_or(mod_id),
                                                    n
                                                )
                                            })
                                        } else if parent.contains("item/") {
                                            parent.split("item/").last().map(|n| {
                                                format!(
                                                    "{}:{}",
                                                    parent.split(':').next().unwrap_or(mod_id),
                                                    n
                                                )
                                            })
                                        } else {
                                            Some(parent.to_string())
                                        }
                                    } else if parent.contains("block/") {
                                        parent
                                            .split("block/")
                                            .last()
                                            .map(|n| format!("{}:{}", mod_id, n))
                                    } else if parent.contains("item/") {
                                        parent
                                            .split("item/")
                                            .last()
                                            .map(|n| format!("{}:{}", mod_id, n))
                                    } else {
                                        None
                                    };

                                    if let Some(pid) = parent_id {
                                        if is_item {
                                            item_model_refs.insert(full_id.clone(), pid);
                                        } else {
                                            block_model_refs.insert(full_id.clone(), pid);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // Второй проход: создаём items и blocks
        for i in 0..archive.len() {
            if let Ok(file) = archive.by_index(i) {
                let name = file.name();

                // Items
                if name.starts_with(&format!("assets/{}/models/item/", mod_id))
                    && name.ends_with(".json")
                {
                    if let Some(item_name) = name.split('/').last() {
                        let item_id = item_name.trim_end_matches(".json");

                        // Пропускаем невалидные ID (только цифры, начинаются с _, слишком короткие)
                        if Self::is_invalid_id(item_id) {
                            continue;
                        }

                        let full_id = format!("{}:{}", mod_id, item_id);

                        // Ищем локализованное имя и очищаем от placeholder'ов
                        let localized_name = lang_data
                            .get(&format!("item.{}.{}", mod_id, item_id))
                            .or_else(|| lang_data.get(&format!("block.{}.{}", mod_id, item_id)))
                            .map(|name| Self::sanitize_localized_name(name, item_id))
                            .unwrap_or_else(|| Self::humanize_name(item_id));

                        // Ищем текстуру с улучшенной логикой:
                        // 1. Прямая текстура предмета
                        // 2. Текстура из ссылки в модели предмета (item или block)
                        // 3. Текстура из модели блока (если item ссылается на block)
                        // 4. Fallback на текстуру блока с таким же ID
                        let texture_path = item_textures
                            .get(&full_id)
                            .or_else(|| {
                                item_model_refs.get(&full_id).and_then(|ref_id| {
                                    // Ищем текстуру по ссылке
                                    item_textures
                                        .get(ref_id)
                                        .or_else(|| block_textures.get(ref_id))
                                        // Рекурсивно проверяем ссылки блоков
                                        .or_else(|| {
                                            block_model_refs
                                                .get(ref_id)
                                                .and_then(|block_ref| block_textures.get(block_ref))
                                        })
                                })
                            })
                            .or_else(|| block_textures.get(&full_id))
                            .cloned();

                        data.items.push(MinecraftItem {
                            id: full_id,
                            name: localized_name,
                            mod_id: mod_id.to_string(),
                            tags: vec![],
                            texture_path,
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

                        // Пропускаем невалидные ID (только цифры, начинаются с _, слишком короткие)
                        if Self::is_invalid_id(block_id) {
                            continue;
                        }

                        let full_id = format!("{}:{}", mod_id, block_id);

                        let localized_name = lang_data
                            .get(&format!("block.{}.{}", mod_id, block_id))
                            .map(|name| Self::sanitize_localized_name(name, block_id))
                            .unwrap_or_else(|| Self::humanize_name(block_id));

                        // Ищем текстуру блока с улучшенной логикой
                        let texture_path = block_textures
                            .get(&full_id)
                            .or_else(|| {
                                block_model_refs
                                    .get(&full_id)
                                    .and_then(|ref_id| block_textures.get(ref_id))
                            })
                            .cloned();

                        data.blocks.push(MinecraftBlock {
                            id: full_id,
                            name: localized_name,
                            mod_id: mod_id.to_string(),
                            tags: vec![],
                            texture_path,
                            hardness: None,
                            blast_resistance: None,
                            requires_tool: None,
                        });
                    }
                }
            }
        }
    }

    /// Парсит ссылку на текстуру и возвращает полный ID
    fn parse_texture_ref(tex: &str, default_mod: &str) -> String {
        // tex может быть:
        // - "minecraft:item/diamond" -> minecraft:diamond
        // - "mod_id:item/name" -> mod_id:name
        // - "mod_id:block/name" -> mod_id:name
        // - "item/name" -> default_mod:name

        if tex.contains(':') {
            let parts: Vec<&str> = tex.splitn(2, ':').collect();
            if parts.len() == 2 {
                let namespace = parts[0];
                let path = parts[1];
                let name = path
                    .trim_start_matches("item/")
                    .trim_start_matches("block/");
                return format!("{}:{}", namespace, name);
            }
        }

        // Без namespace
        let name = tex.trim_start_matches("item/").trim_start_matches("block/");
        format!("{}:{}", default_mod, name)
    }

    /// Извлекает теги из data/<mod_id>/tags/items/*.json и data/<mod_id>/tags/blocks/*.json
    fn extract_tags(archive: &mut ZipArchive<std::fs::File>, mod_id: &str, data: &mut ModData) {
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
                    Some(first) => first.to_uppercase().chain(chars).collect::<String>(),
                    None => String::new(),
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// Проверяет и очищает локализованное имя от format placeholder'ов (%s, %1$s и т.д.)
    /// Если имя содержит placeholder или слишком короткое - возвращает humanize_name
    fn sanitize_localized_name(localized: &str, item_id: &str) -> String {
        // Если имя содержит format placeholders - используем humanize
        if localized.contains('%') || localized.len() < 2 {
            return Self::humanize_name(item_id);
        }
        localized.to_string()
    }

    /// Проверяет, является ли ID невалидным (только цифры, слишком короткий, служебный)
    /// Такие ID как "1", "2", "_internal" не должны попадать в список
    fn is_invalid_id(id: &str) -> bool {
        id.is_empty()
            || id.len() < 2
            || id.chars().all(|c| c.is_ascii_digit())
            || id.starts_with('_')
            || id.starts_with("debug_")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_humanize_name() {
        assert_eq!(JarParser::humanize_name("iron_ingot"), "Iron Ingot");
        assert_eq!(JarParser::humanize_name("diamond_sword"), "Diamond Sword");
        assert_eq!(JarParser::humanize_name("andesite_alloy"), "Andesite Alloy");
    }

    #[test]
    fn test_is_invalid_id() {
        // Invalid IDs
        assert!(JarParser::is_invalid_id("")); // empty
        assert!(JarParser::is_invalid_id("1")); // only digits, too short
        assert!(JarParser::is_invalid_id("2")); // only digits, too short
        assert!(JarParser::is_invalid_id("123")); // only digits
        assert!(JarParser::is_invalid_id("_internal")); // starts with _
        assert!(JarParser::is_invalid_id("debug_test")); // starts with debug_
        assert!(JarParser::is_invalid_id("a")); // too short

        // Valid IDs
        assert!(!JarParser::is_invalid_id("iron_ingot"));
        assert!(!JarParser::is_invalid_id("diamond_sword"));
        assert!(!JarParser::is_invalid_id("stone"));
        assert!(!JarParser::is_invalid_id("a1")); // 2 chars, not all digits
        assert!(!JarParser::is_invalid_id("item_1")); // contains digit but not only
    }
}
