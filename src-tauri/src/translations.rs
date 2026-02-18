use crate::error::Result;
use crate::paths::get_base_dir;
use serde_json::Value;
use std::path::PathBuf;

/// Директория для пользовательских переводов
fn translations_dir() -> PathBuf {
    get_base_dir().join("translations")
}

/// Путь к файлу пользовательского перевода
fn custom_translation_path(lang: &str) -> PathBuf {
    translations_dir().join(format!("{}.json", lang))
}

/// Валидация кода языка (только буквы, 2-5 символов)
fn validate_lang_code(lang: &str) -> Result<()> {
    if lang.len() < 2
        || lang.len() > 5
        || !lang.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err(crate::error::LauncherError::InvalidConfig(format!(
            "Invalid language code: {}",
            lang
        )));
    }
    Ok(())
}

/// Получить пользовательские переводы для языка
#[tauri::command]
pub async fn get_custom_translations(lang: String) -> Result<Option<Value>> {
    validate_lang_code(&lang)?;

    let path = custom_translation_path(&lang);

    if !tokio::fs::try_exists(&path).await.unwrap_or(false) {
        return Ok(None);
    }

    let content = tokio::fs::read_to_string(&path).await?;
    let value: Value = serde_json::from_str(&content).map_err(|e| {
        crate::error::LauncherError::InvalidConfig(format!("Invalid JSON in {}.json: {}", lang, e))
    })?;

    Ok(Some(value))
}

/// Max translation file size: 2 MB (prevents abuse / accidental huge files)
const MAX_TRANSLATION_SIZE: usize = 2 * 1024 * 1024;

/// Validate that a translation value is a safe JSON structure
/// (nested string objects only — no arrays, numbers, or deeply nested structures)
fn validate_translation_value(value: &Value, depth: usize) -> Result<()> {
    if depth > 10 {
        return Err(crate::error::LauncherError::InvalidConfig(
            "Translation nesting too deep (max 10 levels)".to_string(),
        ));
    }
    match value {
        Value::Object(map) => {
            for v in map.values() {
                validate_translation_value(v, depth + 1)?;
            }
            Ok(())
        }
        Value::String(_) => Ok(()),
        _ => Err(crate::error::LauncherError::InvalidConfig(
            "Translation values must be strings or nested objects".to_string(),
        )),
    }
}

/// Сохранить пользовательские переводы для языка
#[tauri::command]
pub async fn save_custom_translations(lang: String, data: Value) -> Result<()> {
    validate_lang_code(&lang)?;

    // Must be an object at the root level
    if !data.is_object() {
        return Err(crate::error::LauncherError::InvalidConfig(
            "Translations must be a JSON object".to_string(),
        ));
    }

    // Validate structure: only nested string objects allowed
    validate_translation_value(&data, 0)?;

    // Inject _meta.lang so the file is self-describing
    let data = if let Value::Object(mut map) = data {
        let meta = map
            .entry("_meta")
            .or_insert_with(|| Value::Object(serde_json::Map::new()));
        if let Value::Object(ref mut meta_map) = meta {
            meta_map.insert("lang".to_string(), Value::String(lang.clone()));
        }
        Value::Object(map)
    } else {
        data
    };

    let dir = translations_dir();
    tokio::fs::create_dir_all(&dir).await?;

    let path = custom_translation_path(&lang);
    let content = serde_json::to_string_pretty(&data).map_err(|e| {
        crate::error::LauncherError::InvalidConfig(format!("Failed to serialize translations: {}", e))
    })?;

    if content.len() > MAX_TRANSLATION_SIZE {
        return Err(crate::error::LauncherError::InvalidConfig(format!(
            "Translation file too large: {} bytes (max {} bytes)",
            content.len(),
            MAX_TRANSLATION_SIZE
        )));
    }

    tokio::fs::write(&path, content).await?;

    log::info!("Saved custom translations for language: {}", lang);
    Ok(())
}

/// Удалить пользовательские переводы для языка
#[tauri::command]
pub async fn delete_custom_translations(lang: String) -> Result<()> {
    validate_lang_code(&lang)?;

    let path = custom_translation_path(&lang);

    if tokio::fs::try_exists(&path).await.unwrap_or(false) {
        tokio::fs::remove_file(&path).await?;
        log::info!("Deleted custom translations for language: {}", lang);
    }

    Ok(())
}

/// Список языков с пользовательскими переводами
#[tauri::command]
pub async fn list_custom_translation_langs() -> Result<Vec<String>> {
    let dir = translations_dir();

    if !tokio::fs::try_exists(&dir).await.unwrap_or(false) {
        return Ok(Vec::new());
    }

    let mut langs = Vec::new();
    let mut entries = tokio::fs::read_dir(&dir).await?;

    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.ends_with(".json") {
            let lang = name.trim_end_matches(".json").to_string();
            // Re-validate: only return codes that pass validation
            if validate_lang_code(&lang).is_ok() {
                langs.push(lang);
            }
        }
    }

    langs.sort();
    Ok(langs)
}

/// Экспорт пользовательских переводов в файл.
/// Injects `_meta.lang` so the exported file is self-describing and re-importable.
#[tauri::command]
pub async fn export_custom_translations(lang: String, dest_path: String) -> Result<()> {
    validate_lang_code(&lang)?;

    let src = custom_translation_path(&lang);
    if !tokio::fs::try_exists(&src).await.unwrap_or(false) {
        return Err(crate::error::LauncherError::NotFound(format!(
            "No custom translations for language: {}",
            lang
        )));
    }

    // Read, inject _meta.lang, write
    let content = tokio::fs::read_to_string(&src).await?;
    let mut value: Value = serde_json::from_str(&content).map_err(|e| {
        crate::error::LauncherError::InvalidConfig(format!("Invalid JSON: {}", e))
    })?;

    if let Value::Object(ref mut map) = value {
        let meta = map
            .entry("_meta")
            .or_insert_with(|| Value::Object(serde_json::Map::new()));
        if let Value::Object(ref mut meta_map) = meta {
            meta_map.insert("lang".to_string(), Value::String(lang.clone()));
        }
    }

    let export_content = serde_json::to_string_pretty(&value).map_err(|e| {
        crate::error::LauncherError::InvalidConfig(format!("Failed to serialize: {}", e))
    })?;
    tokio::fs::write(&dest_path, export_content).await?;

    log::info!("Exported custom translations for {} to {}", lang, dest_path);
    Ok(())
}

/// Импорт пользовательских переводов из файла
#[tauri::command]
pub async fn import_custom_translations(lang: String, src_path: String) -> Result<u32> {
    validate_lang_code(&lang)?;

    // Check file size before reading
    let metadata = tokio::fs::metadata(&src_path).await?;
    if metadata.len() as usize > MAX_TRANSLATION_SIZE {
        return Err(crate::error::LauncherError::InvalidConfig(format!(
            "Import file too large: {} bytes (max {} bytes)",
            metadata.len(),
            MAX_TRANSLATION_SIZE
        )));
    }

    let content = tokio::fs::read_to_string(&src_path).await?;

    // Валидация JSON
    let value: Value = serde_json::from_str(&content).map_err(|e| {
        crate::error::LauncherError::InvalidConfig(format!(
            "Invalid JSON in imported file: {}",
            e
        ))
    })?;

    // Подсчёт ключей
    let count = count_keys(&value);

    // Сохраняем (save_custom_translations validates structure)
    save_custom_translations(lang, value).await?;

    Ok(count)
}

/// Извлечь код языка из содержимого JSON (_meta.lang) или имени файла
fn extract_lang_code(value: &Value, file_path: &str) -> Option<String> {
    // 1. Try _meta.lang from JSON
    if let Some(meta) = value.get("_meta") {
        if let Some(lang) = meta.get("lang").and_then(|v| v.as_str()) {
            let code = lang.to_lowercase();
            if validate_lang_code(&code).is_ok() {
                return Some(code);
            }
        }
    }

    // 2. Fallback: derive from filename
    let filename = std::path::Path::new(file_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    // Strip common prefixes: "translations-de" → "de", "lang-fr" → "fr"
    let code = filename
        .strip_prefix("translations-")
        .or_else(|| filename.strip_prefix("lang-"))
        .unwrap_or(filename)
        .to_lowercase();
    if validate_lang_code(&code).is_ok() {
        Some(code)
    } else {
        None
    }
}

/// Импорт файла перевода — автоматически определяет код языка из JSON (_meta.lang) или имени файла.
/// Возвращает (код_языка, количество_ключей).
#[tauri::command]
pub async fn import_translation_file(src_path: String) -> Result<(String, u32)> {
    // Check file size before reading
    let metadata = tokio::fs::metadata(&src_path).await?;
    if metadata.len() as usize > MAX_TRANSLATION_SIZE {
        return Err(crate::error::LauncherError::InvalidConfig(format!(
            "Import file too large: {} bytes (max {} bytes)",
            metadata.len(),
            MAX_TRANSLATION_SIZE
        )));
    }

    let content = tokio::fs::read_to_string(&src_path).await?;

    let value: Value = serde_json::from_str(&content).map_err(|e| {
        crate::error::LauncherError::InvalidConfig(format!(
            "Invalid JSON in imported file: {}",
            e
        ))
    })?;

    let lang = extract_lang_code(&value, &src_path).ok_or_else(|| {
        crate::error::LauncherError::InvalidConfig(
            "Cannot determine language code: add \"_meta\": {\"lang\": \"es\"} to the JSON file, or name the file as es.json".to_string()
        )
    })?;

    let count = count_keys(&value);

    // Strip _meta before saving (it's metadata, not translation content)
    let data_to_save = if let Value::Object(mut map) = value {
        map.remove("_meta");
        Value::Object(map)
    } else {
        value
    };

    save_custom_translations(lang.clone(), data_to_save).await?;

    log::info!("Imported translation file {} as language: {}", src_path, lang);
    Ok((lang, count))
}

/// Подсчёт количества leaf ключей в JSON
fn count_keys(value: &Value) -> u32 {
    match value {
        Value::Object(map) => map.values().map(count_keys).sum(),
        _ => 1,
    }
}
