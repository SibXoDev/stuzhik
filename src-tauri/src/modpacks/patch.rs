//! Modpack Patch System
//!
//! Система создания и применения патчей для модпаков.
//! Позволяет делиться изменениями в модпаке без распространения всего содержимого.

use super::types::{
    ConfigPatchType, ModpackComparison, ModpackPatch, PatchApplyResult, PatchBaseInfo, PatchChanges,
    PatchConfigAdd, PatchFileAdd, PatchModAdd, PatchModRemove, PatchPreview, STZHK_FORMAT_VERSION,
};
use crate::api::modrinth::ModrinthClient;
use crate::downloader::DownloadManager;
use crate::instances;
use crate::mods::ModManager;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chrono::Utc;
use std::path::Path;
use stuzhik_core::error::{LauncherError, Result};

/// Создать патч из результата сравнения двух модпаков
pub fn create_patch_from_comparison(
    comparison: &ModpackComparison,
    base_info: PatchBaseInfo,
    description: String,
    author: Option<String>,
    include_configs: bool,
) -> Result<ModpackPatch> {
    let mut mods_to_add = Vec::new();
    let mut mods_to_remove = Vec::new();

    // Моды которые есть только во втором (добавленные)
    for mod_info in &comparison.mods_only_in_second {
        mods_to_add.push(PatchModAdd {
            name: mod_info.name.clone(),
            slug: extract_slug_from_filename(&mod_info.filename),
            source: "modrinth".to_string(), // По умолчанию ищем на Modrinth
            project_id: String::new(),      // Будет заполнено при применении
            version_id: None,
            filename: Some(mod_info.filename.clone()),
        });
    }

    // Моды которые есть только в первом (удаленные)
    for mod_info in &comparison.mods_only_in_first {
        mods_to_remove.push(PatchModRemove {
            name: mod_info.name.clone(),
            filename_pattern: mod_info.filename.clone(),
        });
    }

    // Моды с разными версиями - удаляем старую, добавляем новую
    for diff in &comparison.mods_different_version {
        mods_to_remove.push(PatchModRemove {
            name: diff.name.clone(),
            filename_pattern: diff.first_filename.clone(),
        });
        mods_to_add.push(PatchModAdd {
            name: diff.name.clone(),
            slug: extract_slug_from_filename(&diff.second_filename),
            source: "modrinth".to_string(),
            project_id: String::new(),
            version_id: None,
            filename: Some(diff.second_filename.clone()),
        });
    }

    let mut configs_to_add = Vec::new();
    let configs_to_remove: Vec<String>;

    if include_configs {
        // Конфиги только во втором (добавленные)
        // Примечание: содержимое нужно будет добавить отдельно
        for config in &comparison.configs_only_in_second {
            configs_to_add.push(PatchConfigAdd {
                path: config.path.clone(),
                content_base64: String::new(), // Placeholder - заполняется отдельно
                patch_type: ConfigPatchType::default(),
            });
        }

        // Конфиги с разным содержимым - добавляем новую версию
        for diff in &comparison.configs_different {
            configs_to_add.push(PatchConfigAdd {
                path: diff.path.clone(),
                content_base64: String::new(),
                patch_type: ConfigPatchType::default(),
            });
        }

        // Конфиги для удаления
        configs_to_remove = comparison
            .configs_only_in_first
            .iter()
            .map(|c| c.path.clone())
            .collect();
    } else {
        configs_to_remove = Vec::new();
    }

    let patch = ModpackPatch {
        file_type: "patch".to_string(),
        format_version: STZHK_FORMAT_VERSION.to_string(),
        base_modpack: base_info,
        created_at: Utc::now().to_rfc3339(),
        description,
        author,
        changes: PatchChanges {
            mods_to_add,
            mods_to_remove,
            configs_to_add,
            configs_to_remove,
            files_to_add: Vec::new(),
            files_to_remove: comparison.other_only_in_first.clone(),
        },
    };

    Ok(patch)
}

/// Добавить содержимое конфигов в патч из директории
pub fn populate_config_contents(patch: &mut ModpackPatch, source_dir: &Path) -> Result<()> {
    for config in &mut patch.changes.configs_to_add {
        let config_path = source_dir.join(&config.path);
        if config_path.exists() {
            let content = std::fs::read(&config_path).map_err(|e| {
                LauncherError::Io(std::io::Error::new(
                    e.kind(),
                    format!("Failed to read config {}: {}", config.path, e),
                ))
            })?;
            config.content_base64 = BASE64.encode(&content);
        }
    }
    Ok(())
}

/// Сохранить патч в файл
pub fn save_patch(patch: &ModpackPatch, path: &Path) -> Result<()> {
    let json = serde_json::to_string_pretty(patch)
        .map_err(|e| LauncherError::InvalidConfig(format!("Failed to serialize patch: {}", e)))?;
    std::fs::write(path, json)?;
    Ok(())
}

/// Загрузить патч из файла
pub fn load_patch(path: &Path) -> Result<ModpackPatch> {
    let content = std::fs::read_to_string(path)?;
    let patch: ModpackPatch = serde_json::from_str(&content)
        .map_err(|e| LauncherError::InvalidConfig(format!("Invalid patch file: {}", e)))?;

    // Проверка версии формата
    if patch.format_version != STZHK_FORMAT_VERSION {
        log::warn!(
            "Patch format version {} differs from current {}",
            patch.format_version,
            STZHK_FORMAT_VERSION
        );
    }

    Ok(patch)
}

/// Предпросмотр применения патча к экземпляру
pub async fn preview_patch(patch: &ModpackPatch, instance_dir: &Path) -> Result<PatchPreview> {
    let mods_dir = instance_dir.join("mods");
    let mut warnings = Vec::new();
    let errors = Vec::new();

    // Проверяем моды для удаления
    let mut mods_to_remove = Vec::new();
    for mod_remove in &patch.changes.mods_to_remove {
        let pattern = &mod_remove.filename_pattern;
        let found = find_mod_by_pattern(&mods_dir, pattern);
        if found.is_some() {
            mods_to_remove.push(mod_remove.name.clone());
        } else {
            warnings.push(format!(
                "Mod '{}' not found (pattern: {})",
                mod_remove.name, pattern
            ));
        }
    }

    // Проверяем моды для добавления
    let mut mods_to_add = Vec::new();
    for mod_add in &patch.changes.mods_to_add {
        // Проверяем, не установлен ли уже
        if let Some(filename) = &mod_add.filename {
            let slug = extract_slug_from_filename(filename);
            if mod_exists_by_slug(&mods_dir, &slug) {
                warnings.push(format!("Mod '{}' may already be installed", mod_add.name));
            }
        }
        mods_to_add.push(mod_add.name.clone());
    }

    // Проверяем конфиги
    let configs_to_change: Vec<String> = patch
        .changes
        .configs_to_add
        .iter()
        .map(|c| c.path.clone())
        .collect();

    let configs_to_remove: Vec<String> = patch.changes.configs_to_remove.clone();

    // Проверяем файлы
    let files_to_add: Vec<String> = patch
        .changes
        .files_to_add
        .iter()
        .map(|f| f.path.clone())
        .collect();

    let files_to_remove: Vec<String> = patch.changes.files_to_remove.clone();

    Ok(PatchPreview {
        mods_to_add,
        mods_to_remove,
        configs_to_change,
        configs_to_remove,
        files_to_add,
        files_to_remove,
        warnings,
        errors,
    })
}

/// Применить патч к экземпляру
pub async fn apply_patch(
    patch: &ModpackPatch,
    instance_id: &str,
    instance_dir: &Path,
    app_handle: tauri::AppHandle,
) -> Result<PatchApplyResult> {
    let mods_dir = instance_dir.join("mods");
    let mut mods_added = Vec::new();
    let mut mods_removed = Vec::new();
    let mut configs_changed = Vec::new();
    let mut files_added = Vec::new();
    let mut errors = Vec::new();

    // Получаем информацию об экземпляре для minecraft_version и loader
    let instance = instances::lifecycle::get_instance(instance_id.to_string()).await?;
    let minecraft_version = &instance.version;
    let loader = instance.loader.as_str();

    // Создаём DownloadManager
    let download_manager = DownloadManager::new(app_handle)?;

    // 1. Удаляем моды
    for mod_remove in &patch.changes.mods_to_remove {
        match remove_mod_by_pattern(&mods_dir, &mod_remove.filename_pattern) {
            Ok(removed) => {
                if removed {
                    mods_removed.push(mod_remove.name.clone());
                    log::info!("Removed mod: {}", mod_remove.name);
                }
            }
            Err(e) => {
                errors.push(format!("Failed to remove mod '{}': {}", mod_remove.name, e));
            }
        }
    }

    // 2. Добавляем моды (скачиваем с Modrinth/CurseForge)
    for mod_add in &patch.changes.mods_to_add {
        match install_mod_from_patch(
            instance_id,
            mod_add,
            minecraft_version,
            &loader,
            &download_manager,
        )
        .await
        {
            Ok(_) => {
                mods_added.push(mod_add.name.clone());
                log::info!("Added mod: {}", mod_add.name);
            }
            Err(e) => {
                errors.push(format!("Failed to add mod '{}': {}", mod_add.name, e));
            }
        }
    }

    // 3. Применяем конфиги
    for config in &patch.changes.configs_to_add {
        match apply_config(instance_dir, config) {
            Ok(_) => {
                configs_changed.push(config.path.clone());
                log::info!("Applied config: {}", config.path);
            }
            Err(e) => {
                errors.push(format!("Failed to apply config '{}': {}", config.path, e));
            }
        }
    }

    // 4. Удаляем конфиги
    for config_path in &patch.changes.configs_to_remove {
        let full_path = instance_dir.join(config_path);
        if tokio::fs::try_exists(&full_path).await.unwrap_or(false) {
            if let Err(e) = tokio::fs::remove_file(&full_path).await {
                errors.push(format!("Failed to remove config '{}': {}", config_path, e));
            }
        }
    }

    // 5. Добавляем файлы
    for file_add in &patch.changes.files_to_add {
        match apply_file(instance_dir, file_add).await {
            Ok(_) => {
                files_added.push(file_add.path.clone());
            }
            Err(e) => {
                errors.push(format!("Failed to add file '{}': {}", file_add.path, e));
            }
        }
    }

    // 6. Удаляем файлы
    for file_path in &patch.changes.files_to_remove {
        let full_path = instance_dir.join(file_path);
        if tokio::fs::try_exists(&full_path).await.unwrap_or(false) {
            if let Err(e) = tokio::fs::remove_file(&full_path).await {
                errors.push(format!("Failed to remove file '{}': {}", file_path, e));
            }
        }
    }

    let success = errors.is_empty();

    // 7. Сохраняем запись о применённом патче (только если успешно)
    if success {
        if let Err(e) = save_applied_patch(instance_dir, patch) {
            log::warn!("Failed to save applied patch record: {}", e);
        }
    }

    Ok(PatchApplyResult {
        success,
        mods_added,
        mods_removed,
        configs_changed,
        files_added,
        errors,
    })
}

/// Извлечь slug из имени файла мода
fn extract_slug_from_filename(filename: &str) -> String {
    // Убираем расширение
    let name = filename
        .trim_end_matches(".jar")
        .trim_end_matches(".disabled");

    // Пробуем найти slug (обычно до первого "-" или "_" с версией)
    // Примеры: sodium-fabric-0.5.3.jar -> sodium
    //          jei-1.20.1-forge-15.3.0.4.jar -> jei

    let parts: Vec<&str> = name.split(|c| c == '-' || c == '_').collect();
    if parts.is_empty() {
        return name.to_lowercase();
    }

    // Ищем первую часть которая не выглядит как версия
    let mut slug_parts = Vec::new();
    for part in &parts {
        // Если выглядит как версия (начинается с цифры) - останавливаемся
        if part
            .chars()
            .next()
            .map(|c| c.is_ascii_digit())
            .unwrap_or(false)
        {
            break;
        }
        // Пропускаем loader названия
        if matches!(
            part.to_lowercase().as_str(),
            "fabric" | "forge" | "neoforge" | "quilt" | "mc" | "mod"
        ) {
            continue;
        }
        slug_parts.push(*part);
    }

    if slug_parts.is_empty() {
        parts[0].to_lowercase()
    } else {
        slug_parts.join("-").to_lowercase()
    }
}

/// Найти мод по паттерну имени файла
fn find_mod_by_pattern(mods_dir: &Path, pattern: &str) -> Option<std::path::PathBuf> {
    if !mods_dir.exists() {
        return None;
    }

    let pattern_lower = pattern.to_lowercase();

    std::fs::read_dir(mods_dir).ok()?.find_map(|entry| {
        let entry = entry.ok()?;
        let filename = entry.file_name().to_string_lossy().to_lowercase();

        // Точное совпадение
        if filename == pattern_lower {
            return Some(entry.path());
        }

        // Fuzzy: проверяем начало имени (до версии)
        let slug = extract_slug_from_filename(&filename);
        let pattern_slug = extract_slug_from_filename(&pattern_lower);
        if slug == pattern_slug {
            return Some(entry.path());
        }

        None
    })
}

/// Проверить существует ли мод с данным slug
fn mod_exists_by_slug(mods_dir: &Path, slug: &str) -> bool {
    if !mods_dir.exists() {
        return false;
    }

    std::fs::read_dir(mods_dir)
        .map(|mut entries| {
            entries.any(|entry| {
                entry
                    .map(|e| {
                        let filename = e.file_name().to_string_lossy().to_lowercase();
                        extract_slug_from_filename(&filename) == slug
                    })
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

/// Удалить мод по паттерну
fn remove_mod_by_pattern(mods_dir: &Path, pattern: &str) -> Result<bool> {
    if let Some(path) = find_mod_by_pattern(mods_dir, pattern) {
        std::fs::remove_file(&path)?;
        Ok(true)
    } else {
        Ok(false)
    }
}

/// Установить мод из патча
async fn install_mod_from_patch(
    instance_id: &str,
    mod_add: &PatchModAdd,
    minecraft_version: &str,
    loader: &str,
    download_manager: &DownloadManager,
) -> Result<()> {
    // Ищем по slug или имени
    let search_name = if !mod_add.slug.is_empty() {
        mod_add.slug.clone()
    } else {
        mod_add.name.clone()
    };

    // Пробуем установить напрямую через Modrinth (slug совпадает с project slug)
    match ModManager::install_from_modrinth(
        instance_id,
        &search_name,
        minecraft_version,
        loader,
        None,
        download_manager,
    )
    .await
    {
        Ok(_) => {
            log::info!("Installed mod {} from Modrinth", mod_add.name);
            return Ok(());
        }
        Err(e) => {
            log::warn!(
                "Direct Modrinth install failed for {}: {}, trying search...",
                search_name,
                e
            );
        }
    }

    // Если прямая установка не удалась - ищем через API поиска
    let client = ModrinthClient::new();
    let results = client
        .search_mods(&search_name, Some(minecraft_version), Some(loader), 5, 0)
        .await?;

    if results.hits.is_empty() {
        return Err(LauncherError::ModNotFound(format!(
            "Mod '{}' not found on Modrinth for {} {}",
            mod_add.name, minecraft_version, loader
        )));
    }

    // Берём первый (наиболее релевантный) результат
    let hit = &results.hits[0];
    ModManager::install_from_modrinth(
        instance_id,
        &hit.slug,
        minecraft_version,
        loader,
        None,
        download_manager,
    )
    .await?;

    log::info!(
        "Installed mod {} (found as {}) from Modrinth",
        mod_add.name,
        hit.slug
    );
    Ok(())
}

/// Применить JSON merge patch (RFC 7396)
fn json_merge(target: &mut serde_json::Value, patch: &serde_json::Value) {
    // Безопасно извлекаем patch как объект
    if let Some(patch_obj) = patch.as_object() {
        // Убеждаемся что target - объект
        if !target.is_object() {
            *target = serde_json::Value::Object(serde_json::Map::new());
        }
        // Безопасно получаем mutable reference на target объект
        if let Some(target_obj) = target.as_object_mut() {
            for (key, value) in patch_obj {
                if value.is_null() {
                    // null означает удаление ключа
                    target_obj.remove(key);
                } else {
                    // Рекурсивно мержим вложенные объекты
                    let entry = target_obj
                        .entry(key.clone())
                        .or_insert(serde_json::Value::Null);
                    json_merge(entry, value);
                }
            }
        }
    } else {
        // Для не-объектов просто заменяем значение
        *target = patch.clone();
    }
}

/// Применить конфиг из патча
fn apply_config(instance_dir: &Path, config: &PatchConfigAdd) -> Result<()> {
    use super::types::ConfigPatchType;

    let config_path = instance_dir.join(&config.path);

    // Создаем родительские директории
    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    // Декодируем патч/содержимое
    let patch_content = BASE64.decode(&config.content_base64).map_err(|e| {
        LauncherError::InvalidConfig(format!("Invalid base64 in config {}: {}", config.path, e))
    })?;

    match config.patch_type {
        ConfigPatchType::Replace => {
            // Просто записываем файл
            std::fs::write(&config_path, patch_content)?;
        }
        ConfigPatchType::JsonMerge => {
            // Читаем существующий файл (или создаём пустой объект)
            let existing_content = if config_path.exists() {
                std::fs::read_to_string(&config_path)?
            } else {
                "{}".to_string()
            };

            // Парсим оба JSON
            let mut target: serde_json::Value = serde_json::from_str(&existing_content)
                .map_err(|e| {
                    LauncherError::InvalidConfig(format!(
                        "Failed to parse existing JSON config {}: {}",
                        config.path, e
                    ))
                })?;

            let patch_str = String::from_utf8(patch_content).map_err(|e| {
                LauncherError::InvalidConfig(format!(
                    "Patch content is not valid UTF-8 for {}: {}",
                    config.path, e
                ))
            })?;

            let patch: serde_json::Value = serde_json::from_str(&patch_str).map_err(|e| {
                LauncherError::InvalidConfig(format!(
                    "Failed to parse JSON patch for {}: {}",
                    config.path, e
                ))
            })?;

            // Применяем merge patch
            json_merge(&mut target, &patch);

            // Записываем результат с форматированием
            let result = serde_json::to_string_pretty(&target).map_err(|e| {
                LauncherError::InvalidConfig(format!(
                    "Failed to serialize merged JSON for {}: {}",
                    config.path, e
                ))
            })?;

            std::fs::write(&config_path, result)?;
            log::info!("Applied JSON merge patch to {}", config.path);
        }
        ConfigPatchType::Diff => {
            // TODO: Реализовать unified diff патчи
            // Требует внешнюю библиотеку (например, diffy или similar)
            // Пока просто заменяем файл с предупреждением
            log::warn!(
                "Diff patch type not yet implemented for {}, falling back to replace",
                config.path
            );
            std::fs::write(&config_path, patch_content)?;
        }
    }

    Ok(())
}

/// Применить файл из патча
async fn apply_file(instance_dir: &Path, file_add: &PatchFileAdd) -> Result<()> {
    let file_path = instance_dir.join(&file_add.path);

    // Создаем родительские директории
    if let Some(parent) = file_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }

    if let Some(content_b64) = &file_add.content_base64 {
        // Содержимое в base64
        let content = BASE64.decode(content_b64).map_err(|e| {
            LauncherError::InvalidConfig(format!("Invalid base64 in file {}: {}", file_add.path, e))
        })?;
        tokio::fs::write(&file_path, content).await?;
    } else if let Some(url) = &file_add.download_url {
        // Скачиваем файл
        let response = crate::utils::SHARED_HTTP_CLIENT.get(url).send().await.map_err(|e| {
            LauncherError::DownloadFailed(format!(
                "Failed to download file {}: {}",
                file_add.path, e
            ))
        })?;

        let bytes = response.bytes().await.map_err(|e| {
            LauncherError::DownloadFailed(format!("Failed to read file {}: {}", file_add.path, e))
        })?;

        tokio::fs::write(&file_path, &bytes).await?;
    } else {
        return Err(LauncherError::InvalidConfig(format!(
            "File {} has no content or download URL",
            file_add.path
        )));
    }

    Ok(())
}

/// Получить информацию о модпаке для создания патча
pub fn get_modpack_info_from_comparison(
    _comparison: &ModpackComparison,
    source_name: &str,
    mc_version: &str,
    loader: &str,
    loader_version: Option<&str>,
) -> PatchBaseInfo {
    PatchBaseInfo {
        name: source_name.to_string(),
        minecraft_version: mc_version.to_string(),
        loader: loader.to_string(),
        loader_version: loader_version.map(String::from),
        source: None,
        project_id: None,
        version_id: None,
    }
}

// ========== Patch Compatibility ==========

use super::types::{AppliedPatchRecord, PatchCompatibilityResult, PatchCompatibilityStatus};
use sha2::{Digest, Sha256};

/// Вычислить хеш патча для определения дубликатов
pub fn calculate_patch_hash(patch: &ModpackPatch) -> String {
    let mut hasher = Sha256::new();
    // Хешируем ключевые поля патча
    hasher.update(patch.base_modpack.name.as_bytes());
    hasher.update(patch.base_modpack.minecraft_version.as_bytes());
    hasher.update(patch.base_modpack.loader.as_bytes());
    hasher.update(patch.description.as_bytes());

    // Хешируем изменения
    for m in &patch.changes.mods_to_add {
        hasher.update(m.slug.as_bytes());
    }
    for m in &patch.changes.mods_to_remove {
        hasher.update(m.filename_pattern.as_bytes());
    }
    for c in &patch.changes.configs_to_add {
        hasher.update(c.path.as_bytes());
        hasher.update(c.content_base64.as_bytes());
    }

    format!("{:x}", hasher.finalize())
}

/// Проверить совместимость патча с экземпляром
pub fn check_patch_compatibility(
    patch: &ModpackPatch,
    instance_mc_version: &str,
    instance_loader: &str,
    instance_loader_version: Option<&str>,
    applied_patches: &[AppliedPatchRecord],
) -> PatchCompatibilityResult {
    let mut warnings = Vec::new();
    let mut errors = Vec::new();

    // 1. Проверка на дубликат
    let patch_hash = calculate_patch_hash(patch);
    let already_applied = applied_patches.iter().any(|p| p.patch_hash == patch_hash);

    if already_applied {
        return PatchCompatibilityResult {
            status: PatchCompatibilityStatus::AlreadyApplied,
            minecraft_version_match: true,
            loader_match: true,
            loader_version_match: true,
            base_modpack_match: None,
            already_applied: true,
            warnings: vec![],
            errors: vec!["Этот патч уже был применён к данному экземпляру".to_string()],
            recommendation: Some(
                "Этот патч уже применён. Повторное применение не требуется.".to_string(),
            ),
        };
    }

    // 2. Проверка версии Minecraft
    let minecraft_version_match = patch.base_modpack.minecraft_version == instance_mc_version;
    if !minecraft_version_match {
        errors.push(format!(
            "Патч создан для Minecraft {}, а экземпляр использует {}",
            patch.base_modpack.minecraft_version, instance_mc_version
        ));
    }

    // 3. Проверка загрузчика
    let loader_match = patch.base_modpack.loader.to_lowercase() == instance_loader.to_lowercase();
    if !loader_match {
        errors.push(format!(
            "Патч создан для загрузчика {}, а экземпляр использует {}",
            patch.base_modpack.loader, instance_loader
        ));
    }

    // 4. Проверка версии загрузчика (предупреждение, не ошибка)
    let loader_version_match = match (&patch.base_modpack.loader_version, instance_loader_version) {
        (Some(patch_ver), Some(inst_ver)) => {
            if patch_ver != inst_ver {
                warnings.push(format!(
                    "Версия загрузчика отличается: патч для {}, экземпляр использует {}",
                    patch_ver, inst_ver
                ));
                false
            } else {
                true
            }
        }
        _ => true, // Если версия не указана, считаем совместимым
    };

    // 5. Проверка модов которые должны быть удалены (предупреждение если их нет)
    // Это будет сделано в preview_patch, здесь только базовая совместимость

    // 6. Определяем общий статус
    let status = if !errors.is_empty() {
        PatchCompatibilityStatus::Incompatible
    } else if !warnings.is_empty() {
        PatchCompatibilityStatus::CompatibleWithWarnings
    } else {
        PatchCompatibilityStatus::Compatible
    };

    // 7. Формируем рекомендацию
    let recommendation = match &status {
        PatchCompatibilityStatus::Compatible => None,
        PatchCompatibilityStatus::CompatibleWithWarnings => {
            Some("Патч можно применить, но обратите внимание на предупреждения.".to_string())
        }
        PatchCompatibilityStatus::Incompatible => {
            Some(format!(
                "Патч создан для другой конфигурации ({} {}). Рекомендуется использовать экземпляр с аналогичной версией Minecraft и загрузчиком.",
                patch.base_modpack.minecraft_version,
                patch.base_modpack.loader
            ))
        }
        PatchCompatibilityStatus::AlreadyApplied => None, // Уже обработано выше
    };

    PatchCompatibilityResult {
        status,
        minecraft_version_match,
        loader_match,
        loader_version_match,
        base_modpack_match: None, // Проверка modpack не требуется - патчи универсальны
        already_applied,
        warnings,
        errors,
        recommendation,
    }
}

/// Загрузить список применённых патчей для экземпляра
pub fn load_applied_patches(instance_dir: &Path) -> Vec<AppliedPatchRecord> {
    let patches_file = instance_dir.join(".stuzhik").join("applied_patches.json");
    if !patches_file.exists() {
        return Vec::new();
    }

    match std::fs::read_to_string(&patches_file) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

/// Сохранить запись о применённом патче
pub fn save_applied_patch(instance_dir: &Path, patch: &ModpackPatch) -> Result<()> {
    let stuzhik_dir = instance_dir.join(".stuzhik");
    std::fs::create_dir_all(&stuzhik_dir)?;

    let patches_file = stuzhik_dir.join("applied_patches.json");
    let mut patches = load_applied_patches(instance_dir);

    let record = AppliedPatchRecord {
        patch_hash: calculate_patch_hash(patch),
        description: patch.description.clone(),
        applied_at: chrono::Utc::now().to_rfc3339(),
        base_modpack_name: patch.base_modpack.name.clone(),
    };

    patches.push(record);

    let json = serde_json::to_string_pretty(&patches).map_err(|e| {
        LauncherError::InvalidConfig(format!("Failed to serialize applied patches: {}", e))
    })?;
    std::fs::write(&patches_file, json)?;

    Ok(())
}

// ========== Instance Snapshot System ==========

use super::types::{InstanceChanges, InstanceSnapshot, SnapshotConfigInfo, SnapshotModInfo};

/// Создать снимок состояния экземпляра
pub fn create_instance_snapshot(
    instance_id: &str,
    instance_name: &str,
    minecraft_version: &str,
    loader: &str,
    loader_version: Option<&str>,
    instance_dir: &Path,
) -> Result<InstanceSnapshot> {
    let mods_dir = instance_dir.join("mods");
    let config_dir = instance_dir.join("config");

    let mut mods = Vec::new();
    let mut configs = Vec::new();

    // Scan mods directory
    if mods_dir.exists() {
        for entry in std::fs::read_dir(&mods_dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().map(|e| e == "jar").unwrap_or(false) {
                let Some(filename) = path.file_name().map(|n| n.to_string_lossy().to_string()) else {
                    continue;
                };
                let metadata = std::fs::metadata(&path)?;
                let content = std::fs::read(&path)?;
                let hash = format!("{:x}", Sha256::digest(&content));

                mods.push(SnapshotModInfo {
                    filename,
                    hash,
                    size: metadata.len(),
                });
            }
        }
    }

    // Scan config directory (recursively)
    if config_dir.exists() {
        scan_config_dir(&config_dir, &config_dir, &mut configs)?;
    }

    Ok(InstanceSnapshot {
        instance_id: instance_id.to_string(),
        instance_name: instance_name.to_string(),
        minecraft_version: minecraft_version.to_string(),
        loader: loader.to_string(),
        loader_version: loader_version.map(String::from),
        created_at: Utc::now().to_rfc3339(),
        mods,
        configs,
    })
}

/// Рекурсивно сканировать директорию конфигов
fn scan_config_dir(
    base_dir: &Path,
    current_dir: &Path,
    configs: &mut Vec<SnapshotConfigInfo>,
) -> Result<()> {
    for entry in std::fs::read_dir(current_dir)? {
        let entry = entry?;
        let path = entry.path();

        if path.is_dir() {
            scan_config_dir(base_dir, &path, configs)?;
        } else {
            let relative_path = path.strip_prefix(base_dir).unwrap_or(&path);
            let content = std::fs::read(&path)?;
            let hash = format!("{:x}", Sha256::digest(&content));
            let metadata = std::fs::metadata(&path)?;

            configs.push(SnapshotConfigInfo {
                path: relative_path.to_string_lossy().to_string(),
                hash,
                size: metadata.len(),
            });
        }
    }
    Ok(())
}

/// Сохранить снимок в директорию экземпляра
pub fn save_snapshot(instance_dir: &Path, snapshot: &InstanceSnapshot) -> Result<()> {
    let stuzhik_dir = instance_dir.join(".stuzhik");
    std::fs::create_dir_all(&stuzhik_dir)?;

    let snapshot_file = stuzhik_dir.join("snapshot.json");
    let json = serde_json::to_string_pretty(snapshot).map_err(|e| {
        LauncherError::InvalidConfig(format!("Failed to serialize snapshot: {}", e))
    })?;
    std::fs::write(&snapshot_file, json)?;

    log::info!("Saved instance snapshot for {}", snapshot.instance_name);
    Ok(())
}

/// Загрузить снимок из директории экземпляра
pub fn load_snapshot(instance_dir: &Path) -> Option<InstanceSnapshot> {
    let snapshot_file = instance_dir.join(".stuzhik").join("snapshot.json");
    if !snapshot_file.exists() {
        return None;
    }

    match std::fs::read_to_string(&snapshot_file) {
        Ok(content) => serde_json::from_str(&content).ok(),
        Err(_) => None,
    }
}

/// Удалить снимок
pub fn delete_snapshot(instance_dir: &Path) -> Result<()> {
    let snapshot_file = instance_dir.join(".stuzhik").join("snapshot.json");
    if snapshot_file.exists() {
        std::fs::remove_file(&snapshot_file)?;
    }
    Ok(())
}

// ========== Async/Parallel Snapshot Creation ==========

use futures::stream::{self, StreamExt};
use std::path::PathBuf;

/// Создать снимок состояния экземпляра (ASYNC версия с параллельным хешированием)
///
/// Оптимизации по сравнению с sync версией:
/// - Параллельное чтение и хеширование файлов (до 8 одновременно)
/// - spawn_blocking для CPU-bound операций хеширования
/// - Сначала сбор путей (быстро), потом параллельная обработка
pub async fn create_instance_snapshot_async(
    instance_id: &str,
    instance_name: &str,
    minecraft_version: &str,
    loader: &str,
    loader_version: Option<&str>,
    instance_dir: &Path,
) -> Result<InstanceSnapshot> {
    let mods_dir = instance_dir.join("mods");
    let config_dir = instance_dir.join("config");

    // 1. Собираем пути к файлам (быстрая операция)
    let mod_paths = collect_mod_paths(&mods_dir)?;
    let config_paths = collect_config_paths(&config_dir)?;

    log::info!(
        "Creating snapshot: {} mods, {} configs to process",
        mod_paths.len(),
        config_paths.len()
    );

    // 2. Параллельно хешируем моды (до 8 одновременно)
    let mods: Vec<SnapshotModInfo> = stream::iter(mod_paths)
        .map(|path| async move { hash_mod_file(path).await })
        .buffer_unordered(8)
        .filter_map(|result| async move { result.ok() })
        .collect()
        .await;

    // 3. Параллельно хешируем конфиги (до 8 одновременно)
    let config_base = config_dir.clone();
    let configs: Vec<SnapshotConfigInfo> = stream::iter(config_paths)
        .map(|path| {
            let base = config_base.clone();
            async move { hash_config_file(path, base).await }
        })
        .buffer_unordered(8)
        .filter_map(|result| async move { result.ok() })
        .collect()
        .await;

    log::info!(
        "Snapshot created: {} mods, {} configs processed",
        mods.len(),
        configs.len()
    );

    Ok(InstanceSnapshot {
        instance_id: instance_id.to_string(),
        instance_name: instance_name.to_string(),
        minecraft_version: minecraft_version.to_string(),
        loader: loader.to_string(),
        loader_version: loader_version.map(String::from),
        created_at: Utc::now().to_rfc3339(),
        mods,
        configs,
    })
}

/// Собрать пути к .jar файлам в директории mods
fn collect_mod_paths(mods_dir: &Path) -> Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    if mods_dir.exists() {
        for entry in std::fs::read_dir(mods_dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().map(|e| e == "jar").unwrap_or(false) {
                paths.push(path);
            }
        }
    }
    Ok(paths)
}

/// Собрать пути к файлам конфигов (рекурсивно)
fn collect_config_paths(config_dir: &Path) -> Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    if config_dir.exists() {
        collect_config_paths_recursive(config_dir, &mut paths)?;
    }
    Ok(paths)
}

fn collect_config_paths_recursive(dir: &Path, paths: &mut Vec<PathBuf>) -> Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_config_paths_recursive(&path, paths)?;
        } else {
            paths.push(path);
        }
    }
    Ok(())
}

/// Хешировать один мод файл (spawn_blocking для CPU-bound операции)
async fn hash_mod_file(path: PathBuf) -> Result<SnapshotModInfo> {
    tokio::task::spawn_blocking(move || {
        let filename = path
            .file_name()
            .ok_or_else(|| LauncherError::InvalidConfig("Path has no filename".to_string()))?
            .to_string_lossy()
            .to_string();
        let content = std::fs::read(&path)?;
        let size = content.len() as u64;
        let hash = format!("{:x}", Sha256::digest(&content));
        Ok(SnapshotModInfo {
            filename,
            hash,
            size,
        })
    })
    .await
    .map_err(|e| LauncherError::InvalidConfig(format!("Hash task failed: {}", e)))?
}

/// Хешировать один конфиг файл (spawn_blocking для CPU-bound операции)
async fn hash_config_file(path: PathBuf, base_dir: PathBuf) -> Result<SnapshotConfigInfo> {
    tokio::task::spawn_blocking(move || {
        let relative_path = path.strip_prefix(&base_dir).unwrap_or(&path);
        let content = std::fs::read(&path)?;
        let size = content.len() as u64;
        let hash = format!("{:x}", Sha256::digest(&content));
        Ok(SnapshotConfigInfo {
            path: relative_path.to_string_lossy().to_string(),
            hash,
            size,
        })
    })
    .await
    .map_err(|e| LauncherError::InvalidConfig(format!("Hash task failed: {}", e)))?
}

/// Определить изменения в экземпляре по сравнению со снимком
pub fn detect_instance_changes(
    snapshot: &InstanceSnapshot,
    instance_dir: &Path,
) -> Result<InstanceChanges> {
    let mods_dir = instance_dir.join("mods");
    let config_dir = instance_dir.join("config");

    let mut mods_added = Vec::new();
    let mut mods_removed = Vec::new();
    let mut configs_changed = Vec::new();
    let mut configs_added = Vec::new();
    let mut configs_removed = Vec::new();

    // Create maps for quick lookup
    let snapshot_mods: std::collections::HashMap<_, _> = snapshot
        .mods
        .iter()
        .map(|m| (m.filename.clone(), m.hash.clone()))
        .collect();

    let snapshot_configs: std::collections::HashMap<_, _> = snapshot
        .configs
        .iter()
        .map(|c| (c.path.clone(), c.hash.clone()))
        .collect();

    // Check current mods
    let mut current_mods = std::collections::HashSet::new();
    if mods_dir.exists() {
        for entry in std::fs::read_dir(&mods_dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().map(|e| e == "jar").unwrap_or(false) {
                let Some(filename) = path.file_name().map(|n| n.to_string_lossy().to_string()) else {
                    continue;
                };
                current_mods.insert(filename.clone());

                if !snapshot_mods.contains_key(&filename) {
                    mods_added.push(filename);
                }
            }
        }
    }

    // Check removed mods
    for mod_info in &snapshot.mods {
        if !current_mods.contains(&mod_info.filename) {
            mods_removed.push(mod_info.filename.clone());
        }
    }

    // Check current configs
    let mut current_configs = std::collections::HashMap::new();
    if config_dir.exists() {
        scan_current_configs(&config_dir, &config_dir, &mut current_configs)?;
    }

    // Check added/changed configs
    for (path, hash) in &current_configs {
        match snapshot_configs.get(path) {
            None => configs_added.push(path.clone()),
            Some(old_hash) if old_hash != hash => configs_changed.push(path.clone()),
            _ => {}
        }
    }

    // Check removed configs
    for config_info in &snapshot.configs {
        if !current_configs.contains_key(&config_info.path) {
            configs_removed.push(config_info.path.clone());
        }
    }

    let has_changes = !mods_added.is_empty()
        || !mods_removed.is_empty()
        || !configs_changed.is_empty()
        || !configs_added.is_empty()
        || !configs_removed.is_empty();

    Ok(InstanceChanges {
        mods_added,
        mods_removed,
        configs_changed,
        configs_added,
        configs_removed,
        has_changes,
    })
}

/// Сканировать текущие конфиги в HashMap
fn scan_current_configs(
    base_dir: &Path,
    current_dir: &Path,
    configs: &mut std::collections::HashMap<String, String>,
) -> Result<()> {
    for entry in std::fs::read_dir(current_dir)? {
        let entry = entry?;
        let path = entry.path();

        if path.is_dir() {
            scan_current_configs(base_dir, &path, configs)?;
        } else {
            let relative_path = path.strip_prefix(base_dir).unwrap_or(&path);
            let content = std::fs::read(&path)?;
            let hash = format!("{:x}", Sha256::digest(&content));
            configs.insert(relative_path.to_string_lossy().to_string(), hash);
        }
    }
    Ok(())
}

/// Создать патч из обнаруженных изменений
pub fn create_patch_from_changes(
    snapshot: &InstanceSnapshot,
    changes: &InstanceChanges,
    instance_dir: &Path,
    description: String,
    author: Option<String>,
    include_configs: bool,
) -> Result<ModpackPatch> {
    let mut mods_to_add = Vec::new();
    let mut mods_to_remove = Vec::new();
    let mut configs_to_add = Vec::new();
    let configs_to_remove: Vec<String>;

    // Process added mods
    for filename in &changes.mods_added {
        mods_to_add.push(PatchModAdd {
            name: extract_slug_from_filename(filename),
            slug: extract_slug_from_filename(filename),
            source: "modrinth".to_string(),
            project_id: String::new(),
            version_id: None,
            filename: Some(filename.clone()),
        });
    }

    // Process removed mods
    for filename in &changes.mods_removed {
        mods_to_remove.push(PatchModRemove {
            name: extract_slug_from_filename(filename),
            filename_pattern: filename.clone(),
        });
    }

    if include_configs {
        // Process added and changed configs
        let config_dir = instance_dir.join("config");
        for path in changes
            .configs_added
            .iter()
            .chain(changes.configs_changed.iter())
        {
            let full_path = config_dir.join(path);
            if full_path.exists() {
                let content = std::fs::read(&full_path)?;
                configs_to_add.push(PatchConfigAdd {
                    path: format!("config/{}", path),
                    content_base64: BASE64.encode(&content),
                    patch_type: ConfigPatchType::default(),
                });
            }
        }
        configs_to_remove = changes
            .configs_removed
            .iter()
            .map(|p| format!("config/{}", p))
            .collect();
    } else {
        configs_to_remove = Vec::new();
    }

    let patch = ModpackPatch {
        file_type: "patch".to_string(),
        format_version: STZHK_FORMAT_VERSION.to_string(),
        base_modpack: PatchBaseInfo {
            name: snapshot.instance_name.clone(),
            minecraft_version: snapshot.minecraft_version.clone(),
            loader: snapshot.loader.clone(),
            loader_version: snapshot.loader_version.clone(),
            source: None,
            project_id: None,
            version_id: None,
        },
        created_at: Utc::now().to_rfc3339(),
        description,
        author,
        changes: PatchChanges {
            mods_to_add,
            mods_to_remove,
            configs_to_add,
            configs_to_remove,
            files_to_add: Vec::new(),
            files_to_remove: Vec::new(),
        },
    };

    Ok(patch)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_slug_from_filename() {
        assert_eq!(
            extract_slug_from_filename("sodium-fabric-0.5.3.jar"),
            "sodium"
        );
        assert_eq!(
            extract_slug_from_filename("jei-1.20.1-forge-15.3.0.4.jar"),
            "jei"
        );
        assert_eq!(
            extract_slug_from_filename("create-1.20.1-0.5.1f.jar"),
            "create"
        );
        assert_eq!(
            extract_slug_from_filename("applied-energistics-2-forge-15.0.18.jar"),
            "applied-energistics"
        );
    }

    #[test]
    fn test_patch_serialization() {
        let patch = ModpackPatch {
            file_type: "patch".to_string(),
            format_version: STZHK_FORMAT_VERSION.to_string(),
            base_modpack: PatchBaseInfo {
                name: "Test Pack".to_string(),
                minecraft_version: "1.20.1".to_string(),
                loader: "fabric".to_string(),
                loader_version: Some("0.15.0".to_string()),
                source: None,
                project_id: None,
                version_id: None,
            },
            created_at: "2025-01-01T00:00:00Z".to_string(),
            description: "Test patch".to_string(),
            author: Some("Tester".to_string()),
            changes: PatchChanges {
                mods_to_add: vec![PatchModAdd {
                    name: "Sodium".to_string(),
                    slug: "sodium".to_string(),
                    source: "modrinth".to_string(),
                    project_id: "AANobbMI".to_string(),
                    version_id: None,
                    filename: Some("sodium-fabric-0.5.3.jar".to_string()),
                }],
                mods_to_remove: vec![],
                configs_to_add: vec![],
                configs_to_remove: vec![],
                files_to_add: vec![],
                files_to_remove: vec![],
            },
        };

        let json = serde_json::to_string(&patch).unwrap();
        let loaded: ModpackPatch = serde_json::from_str(&json).unwrap();
        assert_eq!(loaded.base_modpack.name, "Test Pack");
        assert_eq!(loaded.changes.mods_to_add.len(), 1);
    }
}
