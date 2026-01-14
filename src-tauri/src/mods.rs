use crate::api::curseforge::CurseForgeClient;
use crate::api::modrinth::ModrinthClient;
use crate::code_editor::minecraft_data::jar_parser::JarParser;
use crate::db::get_db_conn;
use crate::downloader::DownloadManager;
use crate::error::{LauncherError, Result};
use crate::paths::instance_mods_dir;
use crate::utils::{calculate_sha1, calculate_sha512, sanitize_filename};
use chrono::Utc;
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use rusqlite::params;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::Emitter;
use tokio::sync::{mpsc, RwLock};

/// Парсит имя файла мода для извлечения slug и версии
/// Обрабатывает различные форматы именования файлов
/// Примеры:
///   "create-1.20.1-0.5.1.jar" -> ("create", "0.5.1")
///   "bunker-down 1-1-6 - 1-20-1.jar" -> ("bunker-down", "1-1-6")
///   "abandoned_cabins-1.0.0-forge-1.20.1 - Copy.jar" -> ("abandoned-cabins", "1.0.0")
///   "[TACZ ONLY] jeffs_cursed_walking_structures-1.0.6.jar" -> ("jeffs-cursed-walking-structures", "1.0.6")
fn parse_mod_filename(filename: &str) -> (String, String) {
    let mut name = filename
        .trim_end_matches(".jar")
        .trim_end_matches(".disabled")
        .to_string();

    // Remove common suffixes
    for suffix in [" - Copy", " (1)", " (2)", "(1)", "(2)", "_copy", "-copy"] {
        if let Some(pos) = name.to_lowercase().rfind(&suffix.to_lowercase()) {
            name = name[..pos].to_string();
        }
    }

    // Remove prefixes in brackets like "[TACZ ONLY]", "(FORGE)"
    while name.starts_with('[') || name.starts_with('(') {
        let close = if name.starts_with('[') { ']' } else { ')' };
        if let Some(end) = name.find(close) {
            name = name[end + 1..].trim_start().to_string();
        } else {
            break;
        }
    }

    // Normalize separators: replace spaces and underscores with dashes
    let normalized = name
        .replace('_', "-")
        .replace(' ', "-")
        .replace("--", "-")
        .replace("--", "-"); // double pass for multiple spaces

    // Split and filter parts
    let parts: Vec<&str> = normalized.split('-').filter(|p| !p.is_empty()).collect();

    if parts.is_empty() {
        return (name.to_lowercase(), "unknown".to_string());
    }

    // Patterns to skip (MC versions, loaders, etc.)
    let skip_patterns = [
        "fabric", "forge", "neoforge", "quilt", "all", "universal",
        "beta", "alpha", "release", "hotfix", "fix", "fixed",
    ];

    let mut slug_parts = Vec::new();
    let mut version = String::new();
    let mut found_mc_version = false;

    for (i, part) in parts.iter().enumerate() {
        let lower = part.to_lowercase();

        // Skip MC versions (1.20.1, 1.19.2, etc.)
        if lower.starts_with("1.") && lower.len() <= 8 && lower.chars().skip(2).all(|c| c.is_ascii_digit() || c == '.') {
            found_mc_version = true;
            continue;
        }

        // Skip known patterns
        if skip_patterns.contains(&lower.as_str()) {
            continue;
        }

        // Check if this looks like a version (starts with digit, or is last and has digits)
        let looks_like_version = lower.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false)
            || (lower.contains('.') && lower.chars().filter(|c| c.is_ascii_digit()).count() > lower.len() / 2);

        // If we already have slug parts and this looks like version, capture it
        if !slug_parts.is_empty() && looks_like_version {
            if version.is_empty() {
                version = part.to_string();
            }
            continue;
        }

        // If it's a short numeric-looking string after we found something, skip
        if found_mc_version && looks_like_version && slug_parts.is_empty() {
            continue;
        }

        // Otherwise add to slug
        if !looks_like_version || slug_parts.is_empty() {
            slug_parts.push(lower);
        }
    }

    // If no slug found, use first non-version part
    if slug_parts.is_empty() && !parts.is_empty() {
        slug_parts.push(parts[0].to_lowercase());
    }

    let slug = slug_parts.join("-")
        .replace("--", "-")
        .trim_matches('-')
        .to_string();

    if version.is_empty() {
        version = "unknown".to_string();
    }

    (slug, version)
}

/// Очищает display name мода от версий и технической информации
/// Примеры:
///   "Create 6.0.8 for mc1.20.1" -> "Create"
///   "[1.20] v2.0.5 (Forge)" -> "Unknown Mod"
///   "Sodium 0.5.8" -> "Sodium"
fn clean_mod_display_name(name: &str, slug: &str) -> String {
    use std::sync::LazyLock;

    // Pre-compiled regex patterns (compiled once, reused)
    static VERSION_REGEX: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"\s*v?\d+\.\d+(\.\d+)?(\.\d+)?\s*").expect("Invalid VERSION_REGEX")
    });
    static MC_REGEX: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?i)\s*(for\s+)?(\[)?mc?\s*1\.\d+(\.\d+)?(\])?").expect("Invalid MC_REGEX")
    });
    static LOADER_REGEX: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?i)\s*[\[\(]?(forge|fabric|neoforge|quilt)[\]\)]?").expect("Invalid LOADER_REGEX")
    });

    let mut cleaned = name.to_string();

    // Remove version patterns like "6.0.8", "v2.0.5", "1.0.0"
    cleaned = VERSION_REGEX.replace_all(&cleaned, " ").to_string();

    // Remove MC version patterns like "for mc1.20.1", "1.20.1", "[1.20]"
    cleaned = MC_REGEX.replace_all(&cleaned, "").to_string();

    // Remove loader suffixes like "(Forge)", "(Fabric)", "-forge", "-fabric"
    cleaned = LOADER_REGEX.replace_all(&cleaned, "").to_string();

    // Remove leading/trailing punctuation and whitespace
    cleaned = cleaned.trim().trim_matches(|c: char| c.is_ascii_punctuation() || c.is_whitespace()).to_string();

    // If result is empty or too short, use slug as fallback
    if cleaned.len() < 2 {
        // Convert slug to title case: "my-mod-name" -> "My Mod Name"
        return slug
            .replace('-', " ")
            .replace('_', " ")
            .split_whitespace()
            .map(|word| {
                let mut chars = word.chars();
                match chars.next() {
                    Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
                    None => String::new(),
                }
            })
            .collect::<Vec<_>>()
            .join(" ");
    }

    cleaned
}

/// Извлекает возможные варианты поиска из имени файла
/// Возвращает список строк для поиска на платформах
fn extract_search_terms(filename: &str, mod_name: &str, mod_id: &str) -> Vec<String> {
    let mut terms = Vec::new();

    // Primary: mod_id from JAR
    if !mod_id.is_empty() && mod_id != "unknown" {
        terms.push(mod_id.to_string());
        // Also try with dashes instead of underscores
        if mod_id.contains('_') {
            terms.push(mod_id.replace('_', "-"));
        }
    }

    // Secondary: mod name from JAR
    if !mod_name.is_empty() && mod_name != "Unknown" {
        terms.push(mod_name.to_string());
        // Simplified version without special chars
        let simplified = mod_name
            .chars()
            .filter(|c| c.is_alphanumeric() || *c == ' ')
            .collect::<String>();
        if simplified != mod_name && !simplified.is_empty() {
            terms.push(simplified);
        }
    }

    // Tertiary: parsed from filename
    let (slug, _) = parse_mod_filename(filename);
    if !slug.is_empty() && !terms.iter().any(|t| t.to_lowercase() == slug) {
        terms.push(slug.clone());
        // Also try with underscores
        if slug.contains('-') {
            terms.push(slug.replace('-', "_"));
        }
        // Try just first word for compound names
        if let Some(first) = slug.split('-').next() {
            if first.len() >= 3 && !terms.iter().any(|t| t.to_lowercase() == first.to_lowercase()) {
                terms.push(first.to_string());
            }
        }
    }

    // Remove duplicates while preserving order
    let mut seen = std::collections::HashSet::new();
    terms.retain(|t| {
        let lower = t.to_lowercase();
        if seen.contains(&lower) || lower.len() < 2 {
            false
        } else {
            seen.insert(lower);
            true
        }
    });

    terms
}

/// Нормализует имя мода для сравнения
/// Убирает разделители, приводит к lowercase, удаляет суффиксы
/// Примеры:
///   "alexs-delight" -> "alexsdelight"
///   "Alex's Delight" -> "alexsdelight"
///   "abandoned_cabins" -> "abandonedcabins"
///   "create_fabric" -> "createfabric" (или "create" если strip_suffixes=true)
fn normalize_mod_name(name: &str, strip_suffixes: bool) -> String {
    let mut normalized = name
        .to_lowercase()
        .replace(['-', '_', ' ', '\'', '"', '(', ')', '[', ']'], "");

    // Опционально убираем loader-суффиксы
    if strip_suffixes {
        for suffix in ["fabric", "forge", "neoforge", "quilt", "mod", "api"] {
            if normalized.ends_with(suffix) && normalized.len() > suffix.len() + 2 {
                normalized = normalized[..normalized.len() - suffix.len()].to_string();
            }
        }
    }

    normalized
}

/// Проверяет совпадение имён модов с учётом нормализации
/// Возвращает true если имена совпадают после нормализации
/// ВАЖНО: Partial matching убран — он вызывал ложные срабатывания
/// (например "catalogue" находил "The Mandela Catalogue: Alternates")
fn mod_names_match(name1: &str, name2: &str) -> bool {
    // Exact match (case-insensitive)
    if name1.eq_ignore_ascii_case(name2) {
        return true;
    }

    // Normalized match
    let norm1 = normalize_mod_name(name1, false);
    let norm2 = normalize_mod_name(name2, false);

    if norm1 == norm2 {
        return true;
    }

    // Match with stripped suffixes
    let norm1_stripped = normalize_mod_name(name1, true);
    let norm2_stripped = normalize_mod_name(name2, true);

    if norm1_stripped == norm2_stripped {
        return true;
    }

    // REMOVED: Partial matching was too aggressive and caused false positives
    // "catalogue" would match "The Mandela Catalogue: Alternates" - WRONG!
    // "bigger" would match "Bigger Better End Cities" - WRONG!
    // Instead, we rely on exact normalized matching and fuzzy similarity threshold

    false
}

/// Вычисляет схожесть двух строк (0.0 - 1.0)
/// Используется для fuzzy matching
fn string_similarity(s1: &str, s2: &str) -> f64 {
    if s1.is_empty() || s2.is_empty() {
        return 0.0;
    }

    let norm1 = normalize_mod_name(s1, false);
    let norm2 = normalize_mod_name(s2, false);

    if norm1 == norm2 {
        return 1.0;
    }

    // Levenshtein-like ratio
    let len1 = norm1.len();
    let len2 = norm2.len();
    let max_len = len1.max(len2) as f64;

    // Count matching characters
    let mut matches = 0;
    let chars1: Vec<char> = norm1.chars().collect();
    let chars2: Vec<char> = norm2.chars().collect();

    for (i, c1) in chars1.iter().enumerate() {
        if i < chars2.len() && chars2[i] == *c1 {
            matches += 1;
        }
    }

    // Also check common prefix
    let common_prefix = norm1
        .chars()
        .zip(norm2.chars())
        .take_while(|(c1, c2)| c1 == c2)
        .count();

    // Combined score
    let char_score = matches as f64 / max_len;
    let prefix_score = common_prefix as f64 / max_len;

    // Weight prefix more (mods often share prefix like "create-...")
    (char_score * 0.4 + prefix_score * 0.6).min(1.0)
}

/// Централизованный матчер модов - единая логика поиска везде
/// Используется в: check_dependencies, get_dependency_graph, UI поиске
pub struct ModMatcher;

impl ModMatcher {
    /// Алиасы зависимостей - мод A может удовлетворять зависимость B
    fn get_aliases() -> HashMap<&'static str, Vec<&'static str>> {
        [
            // Fabric API variants
            ("fabric-api", vec!["forgified-fabric-api", "sinytra-connector", "fabric", "quilted-fabric-api"]),
            ("fabric", vec!["forgified-fabric-api", "sinytra-connector", "fabric-api"]),
            ("fabric-api-base", vec!["forgified-fabric-api", "sinytra-connector", "fabric-api"]),
            ("quilted-fabric-api", vec!["forgified-fabric-api", "sinytra-connector", "fabric-api"]),
            // Connector aliases
            ("sinytra-connector", vec!["forgified-fabric-api", "connector"]),
            ("connector", vec!["sinytra-connector", "forgified-fabric-api"]),
            // Common library aliases
            ("cloth-config", vec!["cloth-config-forge", "cloth-config-fabric", "cloth-config-api"]),
            ("architectury", vec!["architectury-api", "architectury-forge", "architectury-fabric"]),
            ("geckolib", vec!["geckolib-forge", "geckolib-fabric", "geckolib4"]),
            ("geckolib3", vec!["geckolib"]),
            ("bookshelf", vec!["bookshelf-lib", "bookshelf-forge"]),
            ("iceberg", vec!["iceberg-forge", "iceberg-fabric"]),
            ("balm", vec!["balm-forge", "balm-fabric", "balm-neoforge"]),
            ("kotlin-for-forge", vec!["kotlinforforge", "kff"]),
            ("kotlinforforge", vec!["kotlin-for-forge"]),
            ("placebo", vec!["placebo-forge", "placebo-fabric"]),
            ("puzzles-lib", vec!["puzzleslib", "puzzles-lib-forge"]),
            ("puzzleslib", vec!["puzzles-lib"]),
            ("groovymodloader", vec!["gml", "groovy", "groovymodloader-all", "gml-all"]),
            ("gml", vec!["groovymodloader", "groovy", "groovymodloader-all"]),
            ("groovy", vec!["groovymodloader", "gml"]),
            ("terrablender", vec!["terrablender-forge", "terrablender-fabric"]),
            ("voicechat", vec!["simple-voice-chat", "plasmo-voice"]),
            ("simple-voice-chat", vec!["voicechat"]),
            ("library-of-exile", vec!["library_of_exile", "libraryofexile", "loe"]),
            ("library_of_exile", vec!["library-of-exile", "libraryofexile", "loe"]),
            ("libraryofexile", vec!["library-of-exile", "library_of_exile"]),
            ("temporal-api", vec!["temporalapi"]),
            ("temporalapi", vec!["temporal-api"]),
            ("mapi", vec!["marbledsapi", "marbleds-api", "marbled-api"]),
            ("marbleds-api", vec!["marbledsapi", "mapi"]),
            ("marbledsapi", vec!["mapi", "marbleds-api"]),
            ("yet-another-config-lib", vec!["yacl", "yacl3"]),
            ("yacl", vec!["yet-another-config-lib", "yacl3"]),
        ].into_iter().collect()
    }

    /// Проверяет, есть ли у нас Fabric-on-Forge совместимость (Sinytra Connector)
    pub fn has_fabric_on_forge(mods: &[InstalledMod]) -> bool {
        mods.iter().any(|m| {
            let slug_lower = m.slug.to_lowercase();
            let name_lower = m.name.to_lowercase();
            let mod_id_lower = m.mod_id.as_ref().map(|id| id.to_lowercase());

            slug_lower.contains("sinytra-connector")
                || slug_lower.contains("forgified-fabric-api")
                || slug_lower.contains("connector")
                || name_lower.contains("sinytra")
                || name_lower.contains("forgified fabric")
                || mod_id_lower.as_ref().map(|id| {
                    id.contains("connector") || id.contains("ffapi") || id.contains("forgified")
                }).unwrap_or(false)
                || m.file_name.to_lowercase().contains("connector")
                || m.file_name.to_lowercase().contains("forgified")
        })
    }

    /// Находит мод по идентификатору зависимости
    /// Проверяет: mod_id, slug, source_id, имя, алиасы
    pub fn find_mod<'a>(mods: &'a [InstalledMod], dep_id: &str) -> Option<&'a InstalledMod> {
        let dep_lower = dep_id.to_lowercase();
        let dep_underscore = dep_lower.replace('-', "_");
        let dep_hyphen = dep_lower.replace('_', "-");
        let aliases = Self::get_aliases();

        // Priority 1: Exact match on mod_id (from JAR)
        if let Some(m) = mods.iter().find(|m| {
            m.mod_id.as_ref().map(|id| {
                let id_lower = id.to_lowercase();
                id_lower == dep_lower || id_lower == dep_underscore || id_lower == dep_hyphen
            }).unwrap_or(false)
        }) {
            return Some(m);
        }

        // Priority 2: Exact match on slug or source_id
        if let Some(m) = mods.iter().find(|m| {
            m.slug.to_lowercase() == dep_lower
                || m.source_id.as_deref() == Some(dep_id)
                || m.source_id.as_ref().map(|s| s.to_lowercase()) == Some(dep_lower.clone())
        }) {
            return Some(m);
        }

        // Priority 3: Check aliases
        if let Some(alias_list) = aliases.get(dep_lower.as_str()) {
            for alias in alias_list {
                if let Some(m) = mods.iter().find(|m| {
                    m.mod_id.as_ref().map(|id| id.to_lowercase() == *alias).unwrap_or(false)
                        || m.slug.to_lowercase() == *alias
                        || m.slug.to_lowercase().contains(alias)
                }) {
                    return Some(m);
                }
            }
        }

        // Priority 4: Normalized name matching
        mods.iter().find(|m| {
            mod_names_match(&m.slug, &dep_lower)
                || m.mod_id.as_ref().map_or(false, |id| mod_names_match(id, &dep_lower))
                || mod_names_match(&m.name, &dep_lower)
        })
    }

    /// Проверяет, установлен и включён ли мод
    pub fn is_installed(mods: &[InstalledMod], dep_id: &str) -> bool {
        let dep_lower = dep_id.to_lowercase();

        // Skip fabric dependencies if we have Fabric-on-Forge
        if Self::has_fabric_on_forge(mods)
            && (dep_lower == "fabric" || dep_lower == "fabric-api" || dep_lower.starts_with("fabric-api"))
        {
            return true;
        }

        Self::find_mod(mods, dep_id).map_or(false, |m| m.enabled)
    }

    /// Проверяет, установлен ли мод по имени зависимости
    pub fn is_installed_by_name(mods: &[InstalledMod], dep_name: &str) -> bool {
        mods.iter().any(|m| {
            m.enabled && (
                mod_names_match(&m.name, dep_name)
                    || mod_names_match(&m.slug, dep_name)
                    || m.mod_id.as_ref().map_or(false, |id| mod_names_match(id, dep_name))
            )
        })
    }

    /// Резолвит dependency_slug в реальный slug установленного мода
    pub fn resolve_to_slug(mods: &[InstalledMod], dep_slug: &str) -> String {
        if let Some(m) = Self::find_mod(mods, dep_slug) {
            return m.slug.clone();
        }
        dep_slug.to_string()
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct InstalledMod {
    pub id: i64,
    pub instance_id: String,
    pub slug: String,
    pub mod_id: Option<String>, // mod_id из JAR файла (fabric.mod.json/mods.toml)
    pub name: String,
    pub version: String,
    pub minecraft_version: String,
    pub source: String,
    pub source_id: Option<String>,
    pub file_name: String,
    pub enabled: bool,
    pub auto_update: bool,
    pub icon_url: Option<String>,
    pub author: Option<String>,
    // Update tracking fields
    pub latest_version: Option<String>,
    pub latest_version_id: Option<String>,
    pub update_available: bool,
    pub update_checked_at: Option<String>,
}

/// Результат синхронизации папки модов с БД
#[derive(Debug, Clone, serde::Serialize)]
pub struct SyncResult {
    pub added: usize,
    pub removed: usize,
    /// Sync was skipped (folder unchanged since last sync)
    #[serde(default)]
    pub skipped: bool,
    /// IDs of newly added mods (for incremental operations)
    #[serde(default)]
    pub new_mod_ids: Vec<i64>,
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
        // CRITICAL: Check if mod already exists BEFORE starting download
        // Prevents duplicate downloads and race conditions
        {
            let conn = get_db_conn()?;
            let exists: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM mods WHERE instance_id = ?1 AND slug = ?2)",
                    params![instance_id, slug],
                    |row| row.get(0),
                )
                .unwrap_or(false);

            if exists {
                return Err(LauncherError::ModAlreadyInstalled(slug.to_string()));
            }
        }

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
                slug, // Use slug for progress display, not version.name
                Some(&file.hashes.sha1),
            )
            .await
            .map_err(|e| {
                LauncherError::ModDownloadFailed(format!(
                    "Ошибка загрузки файла '{}': {}",
                    file.filename, e
                ))
            })?;

        // IMPORTANT: Get mod name from JAR, NOT from version.name (which is VERSION title)
        // JAR metadata is authoritative for mod name
        let (mod_name, mod_description, mod_author, mod_id_from_jar) = {
            let path = file_path.clone();
            let slug_owned = slug.to_string(); // Clone for spawn_blocking
            let slug_fallback = slug.to_string(); // Clone for unwrap_or_else
            tokio::task::spawn_blocking(move || {
                match JarParser::parse_mod_jar(&path) {
                    Ok(data) => {
                        if let Some(info) = data.mod_info {
                            (
                                info.name,
                                info.description,
                                info.authors.map(|a| a.join(", ")),
                                Some(info.mod_id),
                            )
                        } else {
                            // JAR has no metadata, use slug as name
                            let fallback = slug_owned.replace('-', " ").replace('_', " ");
                            (fallback, None, None, None)
                        }
                    }
                    Err(_) => {
                        // JAR parsing failed, use slug as name
                        let fallback = slug_owned.replace('-', " ").replace('_', " ");
                        (fallback, None, None, None)
                    }
                }
            })
            .await
            .unwrap_or_else(|_| (slug_fallback.replace('-', " "), None, None, None))
        };

        // Сохраняем в БД with JAR-derived name
        let conn = get_db_conn()?;
        conn.execute(
            r#"INSERT INTO mods (
                instance_id, slug, mod_id, name, version, minecraft_version,
                source, source_id, project_url, download_url,
                file_name, file_hash, file_size, enabled, auto_update,
                description, author, icon_url, installed_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)"#,
            params![
                instance_id,
                slug,
                mod_id_from_jar, // mod_id from JAR for dependency matching
                mod_name,        // Name from JAR, NOT version.name!
                version.version_number,
                minecraft_version,
                "modrinth",
                version.project_id, // source_id for API matching
                format!("https://modrinth.com/mod/{}", slug),
                file.url,
                file.filename,
                file.hashes.sha1,
                file.size as i64,
                1, // enabled
                1, // auto_update
                mod_description, // From JAR
                mod_author,      // From JAR
                None::<String>,  // icon_url - will be set during enrichment
                Utc::now().to_rfc3339(),
                Utc::now().to_rfc3339(),
            ],
        )?;

        let mod_id = conn.last_insert_rowid();

        // Collect dependency project_ids for batch lookup
        let dep_project_ids: Vec<String> = version
            .dependencies
            .iter()
            .filter(|dep| {
                dep.dependency_type == "required"
                    || dep.dependency_type == "optional"
                    || dep.dependency_type == "incompatible"
            })
            .filter_map(|dep| dep.project_id.clone())
            .collect();

        // Batch lookup dependency names from Modrinth API
        let dep_names: HashMap<String, String> = if !dep_project_ids.is_empty() {
            ModrinthClient::get_projects(&dep_project_ids)
                .await
                .map(|projects| projects.into_iter().map(|p| (p.id, p.title)).collect())
                .unwrap_or_default()
        } else {
            HashMap::new()
        };

        // Save dependencies with resolved names
        for dep in &version.dependencies {
            if dep.dependency_type == "required"
                || dep.dependency_type == "optional"
                || dep.dependency_type == "incompatible"
            {
                if let Some(project_id) = &dep.project_id {
                    let dep_name = dep_names
                        .get(project_id)
                        .cloned()
                        .unwrap_or_else(|| Self::humanize_mod_id(project_id));

                    conn.execute(
                        "INSERT INTO mod_dependencies (mod_id, dependency_slug, dependency_type, version_requirement, dependency_name)
                         VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![
                            mod_id,
                            project_id,
                            dep.dependency_type,
                            None::<String>,
                            dep_name,
                        ],
                    )?;
                }
            }
        }

        Ok(InstalledMod {
            id: mod_id,
            instance_id: instance_id.to_string(),
            slug: slug.to_string(),
            mod_id: mod_id_from_jar, // From JAR parsing
            name: mod_name,          // From JAR, NOT version.name!
            version: version.version_number,
            minecraft_version: minecraft_version.to_string(),
            source: "modrinth".to_string(),
            source_id: Some(version.project_id.clone()),
            file_name: file.filename.clone(),
            enabled: true,
            auto_update: true,
            icon_url: None,
            author: mod_author, // From JAR
            latest_version: None,
            latest_version_id: None,
            update_available: false,
            update_checked_at: None,
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
        // CRITICAL: Check if mod already exists BEFORE starting download
        {
            let conn = get_db_conn()?;
            let exists: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM mods WHERE instance_id = ?1 AND source = 'curseforge' AND source_id = ?2)",
                    params![instance_id, mod_id.to_string()],
                    |row| row.get(0),
                )
                .unwrap_or(false);

            if exists {
                return Err(LauncherError::ModAlreadyInstalled(format!("CF-{}", mod_id)));
            }
        }

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
            client.get_file(mod_id, fid).await.map_err(|e| match e {
                LauncherError::ApiError(ref msg)
                    if msg.contains("404") || msg.contains("not found") =>
                {
                    LauncherError::ModNotFound(format!("File {} not found for mod {}", fid, mod_id))
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
            mod_id: None, // Will be extracted from JAR on sync
            name: mod_info.name,
            version: file.file_name.clone(),
            minecraft_version: minecraft_version.to_string(),
            source: "curseforge".to_string(),
            source_id: Some(mod_id.to_string()),
            file_name: file.file_name,
            enabled: true,
            auto_update: true,
            icon_url: mod_info.logo.map(|l| l.url),
            author: None, // Author fetched separately via list_mods
            latest_version: None,
            latest_version_id: None,
            update_available: false,
            update_checked_at: None,
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

        // Извлекаем mod_id из JAR файла
        let (slug, mod_name, mod_version) = tokio::task::spawn_blocking({
            let path = mod_file_path.clone();
            let fallback_name = file_name.clone();
            move || {
                // Парсим JAR для получения mod_id
                match JarParser::parse_mod_jar(&path) {
                    Ok(mod_data) => {
                        if let Some(info) = mod_data.mod_info {
                            // Успешно извлекли mod_id из JAR
                            (info.mod_id, info.name, info.version)
                        } else {
                            // JAR распарсился, но без mod_info - fallback на имя файла
                            (
                                sanitize_filename(&fallback_name),
                                fallback_name.clone(),
                                "unknown".to_string(),
                            )
                        }
                    }
                    Err(_) => {
                        // Не удалось распарсить JAR - fallback на имя файла
                        (
                            sanitize_filename(&fallback_name),
                            fallback_name.clone(),
                            "unknown".to_string(),
                        )
                    }
                }
            }
        })
        .await
        .map_err(|e| LauncherError::InvalidConfig(format!("Failed to parse mod JAR: {}", e)))?;

        // Проверяем, не установлен ли уже мод с таким mod_id
        let conn = get_db_conn()?;
        let existing: Option<i64> = conn
            .query_row(
                "SELECT id FROM mods WHERE instance_id = ?1 AND slug = ?2",
                params![instance_id, &slug],
                |row| row.get(0),
            )
            .ok();

        if existing.is_some() {
            return Err(LauncherError::ModAlreadyInstalled(mod_name.clone()));
        }

        // Копируем файл в директорию модов
        let mods_dir = instance_mods_dir(instance_id);
        tokio::fs::create_dir_all(&mods_dir).await?;

        // Проверяем, не существует ли файл с таким именем (от другого мода)
        let mut final_file_name = file_name.clone();
        let dest_path = mods_dir.join(&final_file_name);

        if tokio::fs::try_exists(&dest_path).await.unwrap_or(false) {
            // Файл существует - проверяем, принадлежит ли он другому моду
            let existing_mod_with_file: Option<String> = conn
                .query_row(
                    "SELECT slug FROM mods WHERE instance_id = ?1 AND file_name = ?2",
                    params![instance_id, &file_name],
                    |row| row.get(0),
                )
                .ok();

            if existing_mod_with_file.is_some() && existing_mod_with_file.as_ref() != Some(&slug) {
                // Файл принадлежит другому моду - генерируем уникальное имя
                let name_without_ext = file_name.trim_end_matches(".jar");
                let mut counter = 1;
                loop {
                    final_file_name = format!("{}_{}.jar", name_without_ext, counter);
                    let test_path = mods_dir.join(&final_file_name);
                    if !tokio::fs::try_exists(&test_path).await.unwrap_or(false) {
                        break;
                    }
                    counter += 1;
                    if counter > 100 {
                        return Err(LauncherError::InvalidConfig(
                            "Too many files with same name".to_string(),
                        ));
                    }
                }
            }
        }

        let dest_path = mods_dir.join(&final_file_name);
        tokio::fs::copy(mod_file_path, &dest_path).await?;

        // Вычисляем хеш
        let file_hash = calculate_sha1(&dest_path)?;
        let file_size = tokio::fs::metadata(&dest_path).await?.len();

        // Сохраняем в БД (используем final_file_name на случай переименования)
        conn.execute(
            r#"INSERT INTO mods (
                instance_id, slug, name, version, minecraft_version,
                source, source_id, file_name, file_hash, file_size,
                enabled, auto_update, installed_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)"#,
            params![
                instance_id,
                &slug,
                &mod_name,
                &mod_version,
                "unknown",
                "local",
                None::<String>,
                &final_file_name,
                file_hash,
                file_size as i64,
                1, // enabled
                0, // auto_update disabled for local mods
                Utc::now().to_rfc3339(),
                Utc::now().to_rfc3339(),
            ],
        )?;

        let mod_id = conn.last_insert_rowid();

        // Extract and save dependencies from JAR file
        let jar_deps = tokio::task::spawn_blocking({
            let path = dest_path.clone();
            move || JarParser::extract_dependencies(&path)
        })
        .await
        .unwrap_or_default();

        for dep in jar_deps {
            // Skip fabric-api and common library variants
            if dep.dependency_id.starts_with("fabric-api")
                || dep.dependency_id == "fabricloader"
                || dep.dependency_id == "java"
            {
                continue;
            }

            let _ = conn.execute(
                "INSERT INTO mod_dependencies (mod_id, dependency_slug, dependency_type, version_requirement, dependency_name)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    mod_id,
                    &dep.dependency_id,
                    &dep.dependency_type,
                    dep.version_requirement.as_deref(),
                    // Use humanized version of dependency_id as fallback name
                    Self::humanize_mod_id(&dep.dependency_id),
                ],
            );
        }

        Ok(InstalledMod {
            id: mod_id,
            instance_id: instance_id.to_string(),
            slug: slug.clone(),
            mod_id: Some(slug), // mod_id extracted from JAR (same as slug for local mods)
            name: mod_name,
            version: mod_version,
            minecraft_version: "unknown".to_string(),
            source: "local".to_string(),
            source_id: None,
            file_name: final_file_name,
            enabled: true,
            auto_update: false,
            icon_url: None,
            author: None, // Unknown for local mods
            latest_version: None,
            latest_version_id: None,
            update_available: false,
            update_checked_at: None,
        })
    }

    /// Humanizes mod_id from snake_case/kebab-case to "Title Case"
    fn humanize_mod_id(mod_id: &str) -> String {
        mod_id
            .split(|c| c == '-' || c == '_')
            .filter(|s| !s.is_empty())
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

    /// Получение списка установленных модов
    pub fn list_mods(instance_id: &str) -> Result<Vec<InstalledMod>> {
        let conn = get_db_conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, instance_id, slug, mod_id, name, version, minecraft_version, source, source_id, file_name, enabled, auto_update, icon_url, author, latest_version, latest_version_id, update_available, update_checked_at
             FROM mods WHERE instance_id = ?1 ORDER BY name"
        )?;

        let mods = stmt
            .query_map([instance_id], |row| {
                Ok(InstalledMod {
                    id: row.get(0)?,
                    instance_id: row.get(1)?,
                    slug: row.get(2)?,
                    mod_id: row.get(3)?,
                    name: row.get(4)?,
                    version: row.get(5)?,
                    minecraft_version: row.get(6)?,
                    source: row.get(7)?,
                    source_id: row.get(8)?,
                    file_name: row.get(9)?,
                    enabled: row.get::<_, i32>(10)? != 0,
                    auto_update: row.get::<_, i32>(11)? != 0,
                    icon_url: row.get(12)?,
                    author: row.get(13)?,
                    latest_version: row.get(14)?,
                    latest_version_id: row.get(15)?,
                    update_available: row.get::<_, Option<i32>>(16)?.unwrap_or(0) != 0,
                    update_checked_at: row.get(17)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        Ok(mods)
    }

    /// Регистрация модов из модпака в БД (без скачивания, моды уже в папке)
    /// Парсит имя файла для получения slug и версии
    /// Также извлекает mod_id из JAR файла для точного матчинга зависимостей
    pub fn register_modpack_mods(
        instance_id: &str,
        minecraft_version: &str,
        mod_files: &[(String, String)], // (file_name, sha1_hash)
    ) -> Result<()> {
        let conn = get_db_conn()?;
        let now = Utc::now().to_rfc3339();
        let mods_dir = instance_mods_dir(instance_id);

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

            // Извлекаем всю информацию из JAR файла
            let jar_path = mods_dir.join(file_name);
            let jar_info = if jar_path.exists() {
                match JarParser::parse_mod_jar(&jar_path) {
                    Ok(data) => data.mod_info,
                    Err(_) => None,
                }
            } else {
                None
            };

            let enabled: i32 = if is_disabled { 0 } else { 1 };

            // Используем данные из JAR или fallback на парсинг имени файла
            let (mod_id, display_name, mod_version, description, author) = match &jar_info {
                Some(info) => (
                    Some(info.mod_id.clone()),
                    info.name.clone(),
                    info.version.clone(),
                    info.description.clone(),
                    info.authors.as_ref().map(|a| a.join(", ")),
                ),
                None => (None, slug.replace('-', " "), version.clone(), None, None),
            };

            conn.execute(
                "INSERT INTO mods (instance_id, slug, mod_id, name, version, minecraft_version, source, source_id, file_name, file_hash, enabled, auto_update, description, author, installed_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, ?12, ?13, ?14, ?14)",
                params![
                    instance_id,
                    slug,
                    mod_id, // mod_id из JAR файла
                    display_name,
                    mod_version,
                    minecraft_version,
                    "modpack", // Источник - модпак
                    None::<String>, // source_id - will be set during verification
                    file_name,
                    hash, // file_hash - SHA1 для кэширования верификации!
                    enabled,
                    description,
                    author,
                    now,
                ],
            )?;
        }

        Ok(())
    }

    /// Smart sync: check folder mtime first, skip if unchanged
    /// Returns extended result with skipped flag and new mod IDs for incremental operations
    pub async fn sync_mods_with_folder(instance_id: &str) -> Result<SyncResult> {
        let mods_dir = instance_mods_dir(instance_id);

        // Get cached mtime from DB (stored as unix timestamp)
        let (cached_mtime, db_mod_count): (Option<i64>, i64) = {
            let conn = get_db_conn()?;
            let mtime = conn
                .query_row(
                    "SELECT mods_folder_mtime FROM instances WHERE id = ?1",
                    [instance_id],
                    |row| row.get::<_, Option<i64>>(0),
                )
                .unwrap_or(None);
            let count = conn
                .query_row(
                    "SELECT COUNT(*) FROM mods WHERE instance_id = ?1",
                    [instance_id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap_or(0);
            (mtime, count)
        };

        // Get current folder mtime and file count
        let (current_mtime, folder_file_count) = tokio::task::spawn_blocking({
            let mods_dir = mods_dir.clone();
            move || {
                let mtime = std::fs::metadata(&mods_dir)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64);

                let count = std::fs::read_dir(&mods_dir)
                    .map(|entries| {
                        entries
                            .filter_map(|e| e.ok())
                            .filter(|e| {
                                e.path()
                                    .extension()
                                    .map(|ext| ext == "jar")
                                    .unwrap_or(false)
                                    || e.path().to_string_lossy().ends_with(".jar.disabled")
                            })
                            .count() as i64
                    })
                    .unwrap_or(0);

                (mtime, count)
            }
        })
        .await
        .unwrap_or((None, 0));

        // Smart skip: if mtime unchanged AND file count matches, no need to scan
        if let (Some(cached), Some(current)) = (cached_mtime, current_mtime) {
            if cached == current && db_mod_count == folder_file_count {
                log::debug!(
                    "Sync skipped for {}: folder unchanged (mtime={}, count={})",
                    instance_id,
                    current,
                    folder_file_count
                );
                return Ok(SyncResult {
                    added: 0,
                    removed: 0,
                    skipped: true,
                    new_mod_ids: vec![],
                });
            }
        }

        // Получаем версию Minecraft из БД
        let minecraft_version: String = {
            let conn = get_db_conn()?;
            conn.query_row(
                "SELECT version FROM instances WHERE id = ?1",
                [instance_id],
                |row| row.get(0),
            )?
        };

        // Сканируем папку (full scan needed)
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
        let mut new_mod_ids: Vec<i64> = Vec::new();

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
            // Get IDs of newly added mods for incremental operations
            let start_id = {
                let conn = get_db_conn()?;
                conn.query_row("SELECT COALESCE(MAX(id), 0) FROM mods", [], |row| {
                    row.get::<_, i64>(0)
                })?
            };
            Self::register_modpack_mods(instance_id, &minecraft_version, &new_mods)?;
            // Collect new mod IDs
            let conn = get_db_conn()?;
            let mut stmt =
                conn.prepare("SELECT id FROM mods WHERE id > ?1 AND instance_id = ?2")?;
            let rows =
                stmt.query_map(params![start_id, instance_id], |row| row.get::<_, i64>(0))?;
            for row in rows.flatten() {
                new_mod_ids.push(row);
            }
        }

        // Удаляем отсутствующие моды (есть в БД, нет в папке)
        let conn = get_db_conn()?;
        for (mod_id, filename) in &db_mods {
            if !folder_mods.contains_key(filename) {
                conn.execute("DELETE FROM mods WHERE id = ?1", [mod_id])?;
                removed += 1;
            }
        }

        // CRITICAL: Update file_hash for existing mods (needed for incremental verification!)
        // Also invalidate verification cache if file changed
        {
            let mut stmt = conn.prepare(
                "SELECT id, file_name, file_hash FROM mods WHERE instance_id = ?1"
            )?;
            let existing_hashes: Vec<(i64, String, Option<String>)> = stmt
                .query_map([instance_id], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })?
                .filter_map(|r| r.ok())
                .collect();

            let mut hash_updates = 0;
            for (mod_id, filename, old_hash) in existing_hashes {
                if let Some(current_hash) = folder_mods.get(&filename) {
                    // Check if hash changed or was never set
                    let needs_update = match &old_hash {
                        Some(old) => old != current_hash,
                        None => true, // file_hash was NULL, need to set it
                    };

                    if needs_update {
                        // Update file_hash AND invalidate verification cache
                        conn.execute(
                            "UPDATE mods SET file_hash = ?1, verified_file_hash = NULL, enriched_file_hash = NULL WHERE id = ?2",
                            params![current_hash, mod_id],
                        )?;
                        hash_updates += 1;
                    }
                }
            }

            if hash_updates > 0 {
                log::info!(
                    "Updated file_hash for {} mods (verification cache invalidated)",
                    hash_updates
                );
            }
        }

        // Update cached mtime
        if let Some(mtime) = current_mtime {
            conn.execute(
                "UPDATE instances SET mods_folder_mtime = ?1 WHERE id = ?2",
                params![mtime, instance_id],
            )?;
        }

        log::info!(
            "Sync mods for {}: {} added, {} removed",
            instance_id,
            added,
            removed
        );

        // Update mod_id for mods that don't have it (legacy mods before migration)
        Self::update_missing_mod_ids(instance_id).await?;

        Ok(SyncResult {
            added,
            removed,
            skipped: false,
            new_mod_ids,
        })
    }

    /// Update mod_id for existing mods that don't have it
    /// This fixes mods registered before the mod_id column was added
    pub async fn update_missing_mod_ids(instance_id: &str) -> Result<usize> {
        let mods_dir = instance_mods_dir(instance_id);

        // Get mods without mod_id
        let mods_without_id: Vec<(i64, String)> = {
            let conn = get_db_conn()?;
            let mut stmt = conn.prepare(
                "SELECT id, file_name FROM mods WHERE instance_id = ?1 AND mod_id IS NULL",
            )?;
            let rows = stmt.query_map([instance_id], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })?;
            rows.flatten().collect()
        };

        if mods_without_id.is_empty() {
            return Ok(0);
        }

        let mods_to_update = mods_without_id.clone();
        let mods_dir_clone = mods_dir.clone();

        // Parse JAR files to extract mod_id
        let updates: Vec<(i64, String)> = tokio::task::spawn_blocking(move || {
            let mut results = Vec::new();
            for (id, file_name) in mods_to_update {
                let jar_path = mods_dir_clone.join(&file_name);
                if jar_path.exists() {
                    if let Ok(data) = JarParser::parse_mod_jar(&jar_path) {
                        if let Some(info) = data.mod_info {
                            results.push((id, info.mod_id));
                        }
                    }
                }
            }
            results
        })
        .await
        .unwrap_or_default();

        // Update database
        let updated_count = updates.len();
        if !updates.is_empty() {
            let conn = get_db_conn()?;
            for (id, mod_id) in updates {
                conn.execute(
                    "UPDATE mods SET mod_id = ?1 WHERE id = ?2",
                    params![mod_id, id],
                )?;
            }
            log::info!(
                "Updated mod_id for {} mods in instance {}",
                updated_count,
                instance_id
            );
        }

        Ok(updated_count)
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

    /// Clean up duplicate mods in the database
    /// Keeps the most complete entry (with source_id) and removes duplicates
    pub fn cleanup_duplicate_mods(instance_id: &str) -> Result<usize> {
        let conn = get_db_conn()?;
        let mods = Self::list_mods(instance_id)?;

        let mut seen: HashMap<String, (i64, bool)> = HashMap::new(); // normalized_name -> (id, has_source_id)
        let mut to_remove: Vec<i64> = Vec::new();

        for mod_item in &mods {
            // Normalize name for comparison
            let normalized = mod_item
                .name
                .to_lowercase()
                .chars()
                .filter(|c| c.is_alphanumeric())
                .collect::<String>();

            if normalized.is_empty() {
                continue;
            }

            let has_source = mod_item.source_id.is_some();

            if let Some((existing_id, existing_has_source)) = seen.get(&normalized) {
                // Duplicate found
                if has_source && !existing_has_source {
                    // New one is better (has source_id), remove old
                    to_remove.push(*existing_id);
                    seen.insert(normalized, (mod_item.id, has_source));
                } else {
                    // Keep existing, remove this one
                    to_remove.push(mod_item.id);
                }
            } else {
                seen.insert(normalized, (mod_item.id, has_source));
            }
        }

        // Also check by mod_id
        let mut seen_by_mod_id: HashMap<String, (i64, bool)> = HashMap::new();
        for mod_item in &mods {
            if let Some(ref mid) = mod_item.mod_id {
                let normalized = mid.to_lowercase();
                let has_source = mod_item.source_id.is_some();

                if let Some((existing_id, existing_has_source)) = seen_by_mod_id.get(&normalized) {
                    if has_source && !existing_has_source {
                        if !to_remove.contains(existing_id) {
                            to_remove.push(*existing_id);
                        }
                        seen_by_mod_id.insert(normalized, (mod_item.id, has_source));
                    } else if !to_remove.contains(&mod_item.id) {
                        to_remove.push(mod_item.id);
                    }
                } else {
                    seen_by_mod_id.insert(normalized, (mod_item.id, has_source));
                }
            }
        }

        // Remove duplicates from DB (not files - files are already removed by sync)
        let removed = to_remove.len();
        for id in to_remove {
            conn.execute("DELETE FROM mods WHERE id = ?1", params![id])?;
        }

        if removed > 0 {
            log::info!("Cleaned up {} duplicate mods from database", removed);
        }

        Ok(removed)
    }

    /// Clear update check cache for an instance (allows re-checking)
    pub fn clear_update_cache(instance_id: &str) -> Result<usize> {
        let conn = get_db_conn()?;
        let updated = conn.execute(
            "UPDATE mods SET update_available = 0, update_checked_at = NULL, latest_version = NULL, latest_version_id = NULL WHERE instance_id = ?1",
            params![instance_id],
        )?;
        log::info!("Cleared update cache for {} mods", updated);
        Ok(updated)
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

    /// Check for updates for all mods in an instance
    /// Uses batch API requests for speed - should complete in seconds, not minutes
    /// Returns info about available updates and saves to DB
    pub async fn check_mod_updates(
        instance_id: &str,
        minecraft_version: &str,
        loader: &str,
    ) -> Result<UpdateCheckResult> {
        let mods = Self::list_mods(instance_id)?;
        let mods_dir = instance_mods_dir(instance_id);

        let mut updates_available = 0;
        let mut skipped = 0;
        let mut errors = 0;
        let mut mods_with_updates = Vec::new();
        let now = Utc::now().to_rfc3339();

        // Build loaders list - include fabric for Sinytra Connector compatibility
        let loader_normalized = loader.to_lowercase();
        let loaders: Vec<String> = match loader_normalized.as_str() {
            "forge" | "neoforge" => vec![loader_normalized.clone(), "fabric".to_string()], // Sinytra Connector support
            _ => vec![loader_normalized.clone()],
        };

        // STEP 1: Collect file hashes for all mods
        log::info!("Collecting file hashes for {} mods...", mods.len());
        let mut hash_to_mod: HashMap<String, &InstalledMod> = HashMap::new();
        let mut modrinth_hashes: Vec<String> = Vec::new();
        let mut cf_mod_ids: Vec<(u64, &InstalledMod)> = Vec::new();

        // OPTIMIZATION: Batch load all file_hash values in one query
        let file_hashes: HashMap<i64, Option<String>> = {
            let conn = get_db_conn()?;
            let mut stmt = conn.prepare(
                "SELECT id, file_hash FROM mods WHERE instance_id = ?1"
            )?;
            let rows = stmt.query_map([instance_id], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?))
            })?;
            rows.filter_map(|r| r.ok()).collect()
        };

        for mod_item in &mods {
            if !mod_item.enabled {
                skipped += 1;
                continue;
            }

            let file_path = mods_dir.join(&mod_item.file_name);
            if !file_path.exists() {
                skipped += 1;
                continue;
            }

            // Use pre-loaded file_hash from batch query
            let hash = file_hashes.get(&mod_item.id).and_then(|h| h.clone());

            let sha1 = if let Some(h) = hash {
                h
            } else {
                match calculate_sha1(&file_path) {
                    Ok(h) => h,
                    Err(_) => {
                        skipped += 1;
                        continue;
                    }
                }
            };

            match mod_item.source.as_str() {
                "modrinth" => {
                    hash_to_mod.insert(sha1.clone(), mod_item);
                    modrinth_hashes.push(sha1);
                }
                "curseforge" => {
                    if let Some(source_id) = &mod_item.source_id {
                        if let Ok(cf_mod_id) = source_id.parse::<u64>() {
                            cf_mod_ids.push((cf_mod_id, mod_item));
                        }
                    }
                }
                "local" | _ => {
                    hash_to_mod.insert(sha1.clone(), mod_item);
                    modrinth_hashes.push(sha1);
                }
            }
        }

        let total_checked = modrinth_hashes.len() + cf_mod_ids.len();
        log::info!(
            "Update check: {} Modrinth hashes, {} CurseForge mods",
            modrinth_hashes.len(),
            cf_mod_ids.len()
        );

        // STEP 2: Batch request to Modrinth
        // Collect updates to batch-save to DB
        let mut updates_to_save: Vec<(String, String, i64)> = Vec::new(); // (version, version_id, mod_id)
        let mut no_updates: Vec<i64> = Vec::new(); // mod_ids with no updates

        if !modrinth_hashes.is_empty() {
            log::info!("Checking Modrinth updates (batch request)...");

            match ModrinthClient::check_updates_batch(
                &modrinth_hashes,
                "sha1",
                &loaders,
                &[minecraft_version.to_string()],
            )
            .await
            {
                Ok(updates_map) => {
                    log::info!("Modrinth returned {} update candidates", updates_map.len());

                    let mut processed_hashes: std::collections::HashSet<String> =
                        std::collections::HashSet::new();

                    for (hash, latest_version) in &updates_map {
                        processed_hashes.insert(hash.clone());
                        if let Some(mod_item) = hash_to_mod.get(hash) {
                            let is_update = mod_item.version != latest_version.version_number;

                            let version_loaders: Vec<String> = latest_version
                                .loaders
                                .iter()
                                .map(|l| l.to_lowercase())
                                .collect();
                            let same_loader = version_loaders.contains(&loader_normalized);

                            if is_update && same_loader {
                                updates_available += 1;
                                mods_with_updates.push(ModUpdateInfo {
                                    mod_id: mod_item.id,
                                    slug: mod_item.slug.clone(),
                                    name: mod_item.name.clone(),
                                    current_version: mod_item.version.clone(),
                                    latest_version: latest_version.version_number.clone(),
                                    latest_version_id: latest_version.id.clone(),
                                    source: "modrinth".to_string(),
                                });
                                updates_to_save.push((
                                    latest_version.version_number.clone(),
                                    latest_version.id.clone(),
                                    mod_item.id,
                                ));
                            } else {
                                no_updates.push(mod_item.id);
                            }
                        }
                    }

                    for hash in &modrinth_hashes {
                        if !processed_hashes.contains(hash) {
                            if let Some(mod_item) = hash_to_mod.get(hash) {
                                no_updates.push(mod_item.id);
                            }
                        }
                    }
                }
                Err(e) => {
                    log::error!("Modrinth batch update check failed: {}", e);
                    errors += modrinth_hashes.len();
                }
            }
        }

        // STEP 3: CurseForge checks (individual requests - CF doesn't have batch update endpoint)
        if !cf_mod_ids.is_empty() {
            log::info!("Checking CurseForge updates ({} mods)...", cf_mod_ids.len());
            if let Ok(client) = CurseForgeClient::new() {
                for (cf_mod_id, mod_item) in cf_mod_ids {
                    let current_file_id: u64 = mod_item.version.parse().unwrap_or(0);
                    match client
                        .check_updates(cf_mod_id, current_file_id, minecraft_version, &loader_normalized)
                        .await
                    {
                        Ok(Some(latest_file)) => {
                            updates_available += 1;
                            mods_with_updates.push(ModUpdateInfo {
                                mod_id: mod_item.id,
                                slug: mod_item.slug.clone(),
                                name: mod_item.name.clone(),
                                current_version: mod_item.version.clone(),
                                latest_version: latest_file.file_name.clone(),
                                latest_version_id: latest_file.id.to_string(),
                                source: "curseforge".to_string(),
                            });
                            updates_to_save.push((
                                latest_file.file_name.clone(),
                                latest_file.id.to_string(),
                                mod_item.id,
                            ));
                        }
                        Ok(None) => {
                            no_updates.push(mod_item.id);
                        }
                        Err(e) => {
                            log::warn!("CurseForge update check failed for {}: {}", mod_item.slug, e);
                            errors += 1;
                        }
                    }
                }
            }
        }

        // STEP 4: Batch save all updates in single transaction
        if !updates_to_save.is_empty() || !no_updates.is_empty() {
            let conn = get_db_conn()?;
            conn.execute("BEGIN TRANSACTION", [])?;

            if !updates_to_save.is_empty() {
                let mut stmt = conn.prepare(
                    "UPDATE mods SET latest_version = ?1, latest_version_id = ?2, update_available = 1, update_checked_at = ?3 WHERE id = ?4"
                )?;
                for (version, version_id, mod_id) in &updates_to_save {
                    stmt.execute(params![version, version_id, now, mod_id])?;
                }
            }

            if !no_updates.is_empty() {
                let mut stmt = conn.prepare(
                    "UPDATE mods SET update_available = 0, update_checked_at = ?1 WHERE id = ?2"
                )?;
                for mod_id in &no_updates {
                    stmt.execute(params![now, mod_id])?;
                }
            }

            conn.execute("COMMIT", [])?;
            log::info!("Batch saved {} updates, {} no-updates", updates_to_save.len(), no_updates.len());
        }

        log::info!(
            "Update check completed: {} checked, {} updates found, {} skipped, {} errors",
            total_checked,
            updates_available,
            skipped,
            errors
        );

        Ok(UpdateCheckResult {
            total_checked,
            updates_available,
            skipped,
            errors,
            mods_with_updates,
        })
    }

    /// Проверка зависимостей и конфликтов
    pub fn check_dependencies(instance_id: &str) -> Result<Vec<ModConflict>> {
        let conn = get_db_conn()?;
        let mods = Self::list_mods(instance_id)?;
        let mut conflicts = Vec::new();

        // Используем централизованный ModMatcher для единообразного матчинга
        let find_mod = |dep_id: &str| ModMatcher::find_mod(&mods, dep_id);
        let is_installed = |dep_id: &str| ModMatcher::is_installed(&mods, dep_id);

        for mod_item in &mods {
            if !mod_item.enabled {
                continue;
            }

            // Try to get dependencies with dependency_name (new schema)
            // Fall back to old schema if column doesn't exist
            let deps: Vec<(String, String, Option<String>, Option<String>)>;
            let new_schema_result = conn.prepare(
                "SELECT dependency_slug, dependency_type, version_requirement, dependency_name
                 FROM mod_dependencies WHERE mod_id = ?1",
            );

            if let Ok(mut stmt) = new_schema_result {
                let rows = stmt.query_map([mod_item.id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                })?;
                deps = rows.collect::<std::result::Result<Vec<_>, _>>()?;
            } else {
                // Fallback: old schema without dependency_name
                let mut stmt = conn.prepare(
                    "SELECT dependency_slug, dependency_type, version_requirement
                     FROM mod_dependencies WHERE mod_id = ?1",
                )?;
                let rows = stmt.query_map([mod_item.id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        None::<String>,
                    ))
                })?;
                deps = rows.collect::<std::result::Result<Vec<_>, _>>()?;
            }

            for (dep_id, dep_type, version_req, dep_name_from_db) in deps {
                // Получаем имя зависимости: приоритет установленный мод, затем dep_name из БД
                // Fallback: если ID выглядит как Modrinth project ID (8 символов), показываем более понятно
                let get_dep_name = || -> String {
                    find_mod(&dep_id)
                        .map(|m| m.name.clone())
                        .or_else(|| dep_name_from_db.clone())
                        .unwrap_or_else(|| {
                            // Check if it looks like a readable slug (lowercase with hyphens/underscores)
                            if dep_id.chars().all(|c| {
                                c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_'
                            }) {
                                // Looks like a slug - capitalize it for display
                                dep_id
                                    .split(|c| c == '-' || c == '_')
                                    .map(|word| {
                                        let mut chars: Vec<char> = word.chars().collect();
                                        if !chars.is_empty() {
                                            chars[0] = chars[0].to_ascii_uppercase();
                                        }
                                        chars.into_iter().collect::<String>()
                                    })
                                    .collect::<Vec<_>>()
                                    .join(" ")
                            } else {
                                // Looks like a cryptic ID - just use it as-is but mark it
                                format!("[{}]", dep_id)
                            }
                        })
                };

                // Check if dependency is installed (using centralized ModMatcher)
                let is_dep_installed = || -> bool {
                    // First try by dep_id (project_id/slug)
                    if is_installed(&dep_id) {
                        return true;
                    }
                    // Also try by dependency name (helps with local mods)
                    if let Some(ref dep_name) = dep_name_from_db {
                        if ModMatcher::is_installed_by_name(&mods, dep_name) {
                            return true;
                        }
                    }
                    false
                };

                match dep_type.as_str() {
                    "required" => {
                        // Проверяем наличие требуемого мода (по slug, source_id, или name)
                        if !is_dep_installed() {
                            let dep_name = get_dep_name();
                            conflicts.push(ModConflict {
                                mod_slug: mod_item.slug.clone(),
                                mod_name: mod_item.name.clone(),
                                conflict_type: "missing_dependency".to_string(),
                                details: format!("Requires mod: {}", dep_name),
                                required_slug: Some(dep_id.clone()),
                                required_version: version_req.clone(),
                            });
                        } else if let Some(req) = version_req {
                            // Проверяем версию
                            if let Some(dep_mod) = find_mod(&dep_id) {
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
                                            dep_mod.name, req, dep_mod.version
                                        ),
                                        required_slug: Some(dep_id),
                                        required_version: Some(req),
                                    });
                                }
                            }
                        }
                    }
                    "incompatible" => {
                        // Skip self-incompatibility (mod can't be incompatible with itself)
                        let dep_lower = dep_id.to_lowercase();
                        let self_slug = mod_item.slug.to_lowercase();
                        let self_mod_id = mod_item.mod_id.as_ref().map(|id| id.to_lowercase());
                        let self_source_id = mod_item.source_id.as_ref().map(|id| id.to_lowercase());
                        let self_name_normalized = mod_item.name.to_lowercase().replace(' ', "-");

                        // Check all possible ways this could be the same mod
                        let is_self = dep_lower == self_slug
                            || dep_lower.replace('-', "_") == self_slug.replace('-', "_")
                            || self_mod_id.as_ref().map(|id| id == &dep_lower || id == &dep_lower.replace('-', "_")).unwrap_or(false)
                            || self_source_id.as_ref().map(|id| id == &dep_lower).unwrap_or(false)
                            || dep_lower == self_name_normalized
                            || dep_lower == self_name_normalized.replace('-', "_");

                        // Also check by resolved dependency name
                        let dep_name = get_dep_name();
                        let dep_name_lower = dep_name.to_lowercase();
                        let mod_name_lower = mod_item.name.to_lowercase();
                        let is_self_by_name = dep_name_lower == mod_name_lower
                            || dep_name_lower.replace(' ', "-") == mod_name_lower.replace(' ', "-");

                        if is_self || is_self_by_name {
                            log::debug!("Skipping self-incompatibility for {} (dep_id={}, resolved={})",
                                mod_item.name, dep_id, dep_name);
                            continue; // Skip - mod can't be incompatible with itself
                        }

                        // Проверяем наличие несовместимого мода
                        if is_installed(&dep_id) {
                            conflicts.push(ModConflict {
                                mod_slug: mod_item.slug.clone(),
                                mod_name: mod_item.name.clone(),
                                conflict_type: "incompatible".to_string(),
                                details: format!("Incompatible with: {}", dep_name),
                                required_slug: Some(dep_id),
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

    /// Превентивная проверка зависимостей перед запуском экземпляра
    ///
    /// Проверяет все обязательные зависимости и возвращает детальный отчёт.
    /// В отличие от check_dependencies, эта функция:
    /// 1. Возвращает структурированный результат для UI
    /// 2. Включает информацию для автоматической установки
    /// 3. Различает блокирующие проблемы и предупреждения
    pub fn pre_launch_check(instance_id: &str) -> Result<PreLaunchCheckResult> {
        let conn = get_db_conn()?;
        let mods = Self::list_mods(instance_id)?;

        let mut missing_dependencies = Vec::new();
        let mut warnings = Vec::new();

        // Используем централизованный ModMatcher для единообразного матчинга
        let find_mod = |dep_id: &str| ModMatcher::find_mod(&mods, dep_id);
        let is_installed = |dep_id: &str| ModMatcher::is_installed(&mods, dep_id);

        for mod_item in &mods {
            if !mod_item.enabled {
                continue;
            }

            // Загружаем зависимости с новой схемой
            let deps: Vec<(String, String, Option<String>, Option<String>)>;
            let new_schema_result = conn.prepare(
                "SELECT dependency_slug, dependency_type, version_requirement, dependency_name
                 FROM mod_dependencies WHERE mod_id = ?1",
            );

            if let Ok(mut stmt) = new_schema_result {
                let rows = stmt.query_map([mod_item.id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                })?;
                deps = rows.collect::<std::result::Result<Vec<_>, _>>()?;
            } else {
                // Fallback: old schema without dependency_name
                let mut stmt = conn.prepare(
                    "SELECT dependency_slug, dependency_type, version_requirement
                     FROM mod_dependencies WHERE mod_id = ?1",
                )?;
                let rows = stmt.query_map([mod_item.id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        None::<String>,
                    ))
                })?;
                deps = rows.collect::<std::result::Result<Vec<_>, _>>()?;
            }

            for (dep_id, dep_type, version_req, dep_name_from_db) in deps {
                // Резолвим имя зависимости
                let dep_name = find_mod(&dep_id)
                    .map(|m| m.name.clone())
                    .or_else(|| dep_name_from_db.clone())
                    .unwrap_or_else(|| Self::humanize_mod_id(&dep_id));

                // Проверяем установлена ли зависимость
                let is_dep_installed = is_installed(&dep_id)
                    || dep_name_from_db
                        .as_ref()
                        .map(|name| ModMatcher::is_installed_by_name(&mods, name))
                        .unwrap_or(false);

                match dep_type.as_str() {
                    "required" => {
                        if !is_dep_installed {
                            // Определяем источник для установки
                            let (source, project_id) = Self::get_dependency_source(&dep_id);

                            missing_dependencies.push(MissingDependency {
                                required_by_slug: mod_item.slug.clone(),
                                required_by_name: mod_item.name.clone(),
                                dependency_slug: dep_id.clone(),
                                dependency_name: dep_name,
                                source,
                                project_id,
                                version_requirement: version_req.clone(),
                            });
                        } else if let Some(req) = version_req {
                            // Проверяем версию
                            if let Some(dep_mod) = find_mod(&dep_id) {
                                if !crate::utils::version_matches_requirement(&dep_mod.version, &req)
                                {
                                    warnings.push(DependencyWarning {
                                        warning_type: "version_mismatch".to_string(),
                                        message: format!(
                                            "{} требует {} версии {}, установлена {}",
                                            mod_item.name, dep_mod.name, req, dep_mod.version
                                        ),
                                        mod_slug: Some(mod_item.slug.clone()),
                                        dependency_slug: Some(dep_id),
                                    });
                                }
                            }
                        }
                    }
                    "optional" => {
                        // Опциональные зависимости — только предупреждение
                        if !is_dep_installed {
                            warnings.push(DependencyWarning {
                                warning_type: "optional_missing".to_string(),
                                message: format!(
                                    "{} может работать лучше с модом {}",
                                    mod_item.name, dep_name
                                ),
                                mod_slug: Some(mod_item.slug.clone()),
                                dependency_slug: Some(dep_id),
                            });
                        }
                    }
                    _ => {}
                }
            }
        }

        // Проверяем отключённые зависимости
        for mod_item in &mods {
            if !mod_item.enabled {
                // Проверяем, не требуется ли этот мод кому-то из включённых
                let mut stmt = conn.prepare(
                    "SELECT m.name, m.slug FROM mods m
                     JOIN mod_dependencies d ON m.id = d.mod_id
                     WHERE d.dependency_slug = ?1 AND d.dependency_type = 'required'
                     AND m.instance_id = ?2 AND m.enabled = 1",
                )?;

                let dependents: Vec<(String, String)> = stmt
                    .query_map([&mod_item.slug, instance_id], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                    })?
                    .filter_map(|r| r.ok())
                    .collect();

                if !dependents.is_empty() {
                    let dependent_names: Vec<_> =
                        dependents.iter().map(|(name, _)| name.as_str()).collect();
                    warnings.push(DependencyWarning {
                        warning_type: "disabled_dependency".to_string(),
                        message: format!(
                            "Мод {} отключён, но требуется для: {}",
                            mod_item.name,
                            dependent_names.join(", ")
                        ),
                        mod_slug: Some(mod_item.slug.clone()),
                        dependency_slug: None,
                    });
                }
            }
        }

        let total_issues = missing_dependencies.len() + warnings.len();
        let can_launch = missing_dependencies.is_empty();

        log::info!(
            "Pre-launch check for {}: can_launch={}, missing={}, warnings={}",
            instance_id,
            can_launch,
            missing_dependencies.len(),
            warnings.len()
        );

        Ok(PreLaunchCheckResult {
            can_launch,
            missing_dependencies,
            warnings,
            total_issues,
        })
    }

    /// Определяем источник для установки зависимости
    fn get_dependency_source(dep_id: &str) -> (Option<String>, Option<String>) {
        // Если dep_id выглядит как Modrinth project_id (8 alphanumeric символов)
        // или как slug (lowercase с дефисами), то это скорее всего Modrinth
        let is_modrinth_id =
            dep_id.len() == 8 && dep_id.chars().all(|c| c.is_ascii_alphanumeric());
        let is_slug = dep_id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');

        if is_modrinth_id || is_slug {
            (Some("modrinth".to_string()), Some(dep_id.to_string()))
        } else {
            // Неизвестный формат — попробуем Modrinth сначала
            (Some("modrinth".to_string()), Some(dep_id.to_string()))
        }
    }

    /// Получить граф зависимостей для визуализации
    /// Возвращает узлы (моды) и рёбра (зависимости)
    pub fn get_dependency_graph(instance_id: &str) -> Result<DependencyGraph> {
        let conn = get_db_conn()?;
        let mods = Self::list_mods(instance_id)?;

        let mut nodes = Vec::new();
        let mut edges = Vec::new();
        let mut mod_id_to_slug: HashMap<i64, String> = HashMap::new();
        let mut seen_slugs: std::collections::HashSet<String> = std::collections::HashSet::new();

        // Используем централизованный ModMatcher для единообразного матчинга
        let find_mod = |dep_slug: &str| ModMatcher::find_mod(&mods, dep_slug);
        let resolve_to_slug = |dep_slug: &str| ModMatcher::resolve_to_slug(&mods, dep_slug);

        // Создаём узлы для всех модов (дедупликация только по slug - это первичный ключ)
        for mod_item in &mods {
            // Skip duplicate slugs (can happen if DB has corrupted data)
            if !seen_slugs.insert(mod_item.slug.clone()) {
                log::warn!(
                    "Duplicate node skipped by slug: {} (mod_id={})",
                    mod_item.slug,
                    mod_item.id
                );
                continue;
            }
            // Note: Removed name-based and mod_id-based deduplication as they caused
            // false positives (e.g., "Create" vs "Create No Touching", "FTB Quests" vs "FTB Quests Freeze Fix")

            mod_id_to_slug.insert(mod_item.id, mod_item.slug.clone());

            // Подсчитываем количество зависимостей
            let dep_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM mod_dependencies WHERE mod_id = ?1 AND dependency_type = 'required'",
                    [mod_item.id],
                    |row| row.get(0),
                )
                .unwrap_or(0);

            // Clean display name from version info for graph
            let clean_name = clean_mod_display_name(&mod_item.name, &mod_item.slug);

            // Note: dependent_count will be calculated AFTER edges are created
            // This ensures we count edges correctly (edges use resolved slugs)
            nodes.push(DependencyNode {
                id: mod_item.slug.clone(),
                name: clean_name,
                enabled: mod_item.enabled,
                version: mod_item.version.clone(),
                icon_url: mod_item.icon_url.clone(),
                source: mod_item.source.clone(),
                dependency_count: dep_count as i32,
                dependent_count: 0, // Will be calculated from edges
                is_library: Self::is_library_mod(&mod_item.slug),
            });
        }

        // Создаём рёбра для всех зависимостей
        for mod_item in &mods {
            // Try to get dependencies with dependency_name (new schema)
            // Fall back to old schema if column doesn't exist
            let deps: Vec<(String, String, Option<String>, Option<String>)>;
            let new_schema_result = conn.prepare(
                "SELECT dependency_slug, dependency_type, version_requirement, dependency_name
                 FROM mod_dependencies WHERE mod_id = ?1",
            );

            if let Ok(mut stmt) = new_schema_result {
                let rows = stmt.query_map([mod_item.id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                })?;
                deps = rows.collect::<std::result::Result<Vec<_>, _>>()?;
            } else {
                // Fallback: old schema without dependency_name
                let mut stmt = conn.prepare(
                    "SELECT dependency_slug, dependency_type, version_requirement
                     FROM mod_dependencies WHERE mod_id = ?1",
                )?;
                let rows = stmt.query_map([mod_item.id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        None::<String>,
                    ))
                })?;
                deps = rows.collect::<std::result::Result<Vec<_>, _>>()?;
            }

            for (dep_slug, dep_type, version_req, dep_name) in deps {
                // Резолвим dependency_slug в реальный slug (если это project_id)
                let resolved_slug = resolve_to_slug(&dep_slug);

                // Skip self-references (mod can't depend on or be incompatible with itself)
                if resolved_slug == mod_item.slug
                    || dep_slug == mod_item.slug
                    || mod_item.source_id.as_deref() == Some(&dep_slug)
                    || mod_item.mod_id.as_deref() == Some(&dep_slug)
                {
                    continue;
                }

                // Проверяем, установлена ли зависимость (по slug или source_id)
                let found_mod = find_mod(&dep_slug);
                let is_satisfied = found_mod.map_or(false, |m| m.enabled);

                // Имя зависимости: приоритет - имя установленного мода, затем dependency_name из БД
                // Fallback - более читаемый формат если это криптический ID
                let raw_name = found_mod
                    .map(|m| m.name.clone())
                    .or(dep_name)
                    .unwrap_or_else(|| {
                        // If dep_slug looks like a readable slug (has dashes or only lowercase), use it
                        // Otherwise format it as "Mod [truncated_id]"
                        if dep_slug.contains('-')
                            || dep_slug
                                .chars()
                                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
                        {
                            dep_slug.clone()
                        } else {
                            format!("Mod [{}]", &dep_slug[..8.min(dep_slug.len())])
                        }
                    });
                // Clean name from version info
                let to_name = clean_mod_display_name(&raw_name, &resolved_slug);

                // Get clean display name for the source mod
                let from_name = clean_mod_display_name(&mod_item.name, &mod_item.slug);

                edges.push(DependencyEdge {
                    from: mod_item.slug.clone(),
                    from_name,
                    to: resolved_slug.clone(),
                    to_name,
                    dependency_type: dep_type.clone(),
                    version_requirement: version_req,
                    is_satisfied,
                    // Для incompatible - проблема если мод установлен
                    is_problem: if dep_type == "incompatible" {
                        find_mod(&dep_slug).map_or(false, |m| m.enabled)
                    } else {
                        // Для required - проблема если мод НЕ установлен
                        dep_type == "required" && !is_satisfied
                    },
                });
            }
        }

        // Deduplicate edges by (from, to, dependency_type) - same mod can be listed
        // multiple times with different identifiers (e.g., project_id vs slug)
        let edges_before = edges.len();
        let mut seen_edges: std::collections::HashSet<(String, String, String)> =
            std::collections::HashSet::new();
        edges.retain(|e| {
            let key = (e.from.clone(), e.to.clone(), e.dependency_type.clone());
            seen_edges.insert(key)
        });

        // Also deduplicate by (from, to_name, dependency_type) for cases where
        // different 'to' slugs have the same display name
        let mut seen_by_name: std::collections::HashSet<(String, String, String)> =
            std::collections::HashSet::new();
        edges.retain(|e| {
            let key = (
                e.from.clone(),
                e.to_name.to_lowercase(),
                e.dependency_type.clone(),
            );
            seen_by_name.insert(key)
        });

        let edges_removed = edges_before - edges.len();
        if edges_removed > 0 {
            log::debug!(
                "get_dependency_graph: removed {} duplicate edges",
                edges_removed
            );
        }

        // Filter out orphan edges - edges pointing to non-existent nodes
        // Build a set of all valid node IDs for O(1) lookup
        let valid_node_ids: std::collections::HashSet<String> =
            nodes.iter().map(|n| n.id.clone()).collect();

        let edges_before_orphan_filter = edges.len();
        edges.retain(|e| {
            // Keep edge only if both 'from' and 'to' exist in nodes
            valid_node_ids.contains(&e.from) && valid_node_ids.contains(&e.to)
        });

        let orphan_edges_removed = edges_before_orphan_filter - edges.len();
        if orphan_edges_removed > 0 {
            log::debug!(
                "get_dependency_graph: removed {} orphan edges (pointing to non-existent nodes)",
                orphan_edges_removed
            );
        }

        // Calculate dependent_count from edges (more accurate than SQL query)
        // Count how many edges point TO each node (only required/optional, not incompatible)
        let mut dependent_counts: std::collections::HashMap<String, i32> =
            std::collections::HashMap::new();
        for edge in &edges {
            if edge.dependency_type == "required" || edge.dependency_type == "optional" {
                *dependent_counts.entry(edge.to.clone()).or_insert(0) += 1;
            }
        }

        // Update nodes with calculated dependent_count
        for node in &mut nodes {
            if let Some(&count) = dependent_counts.get(&node.id) {
                node.dependent_count = count;
            }
        }

        log::debug!(
            "get_dependency_graph: returning {} nodes, {} edges for instance {}",
            nodes.len(),
            edges.len(),
            instance_id
        );

        Ok(DependencyGraph { nodes, edges })
    }

    /// Проверяет, является ли мод библиотекой (много зависимых, мало зависимостей)
    fn is_library_mod(slug: &str) -> bool {
        // Известные библиотечные моды
        const LIBRARY_MODS: &[&str] = &[
            "fabric-api",
            "quilted-fabric-api",
            "cloth-config",
            "architectury-api",
            "geckolib",
            "patchouli",
            "bookshelf-lib",
            "curios",
            "trinkets",
            "forge-config-api-port",
            "kotlin-for-forge",
            "fabric-language-kotlin",
            "owo-lib",
            "moonlight",
            "citadel",
            "iceberg",
            "puzzles-lib",
            "balm",
            "resourceful-lib",
            "condensed-creative",
            "creative-core",
            "playeranimator",
            "flywheel",
            "midnight-lib",
            "fusion-connected-textures",
            "prism-lib",
            "sinytra-connector",
            "forgified-fabric-api",
        ];
        LIBRARY_MODS.contains(&slug)
    }

    /// Анализ безопасности удаления мода
    /// Возвращает список модов, которые сломаются при удалении данного мода
    pub fn analyze_mod_removal(instance_id: &str, mod_slug: &str) -> Result<ModRemovalAnalysis> {
        let conn = get_db_conn()?;
        let mods = Self::list_mods(instance_id)?;

        // Находим все моды, которые зависят от удаляемого
        let mut affected_mods = Vec::new();
        let mut warning_mods = Vec::new();

        for mod_item in &mods {
            if !mod_item.enabled {
                continue;
            }

            // Получаем зависимости мода
            let mut stmt = conn.prepare(
                "SELECT dependency_slug, dependency_type FROM mod_dependencies WHERE mod_id = ?1",
            )?;

            let deps: Vec<(String, String)> = stmt
                .query_map([mod_item.id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;

            for (dep_slug, dep_type) in deps {
                if dep_slug == mod_slug {
                    match dep_type.as_str() {
                        "required" => {
                            affected_mods.push(AffectedMod {
                                slug: mod_item.slug.clone(),
                                name: mod_item.name.clone(),
                                impact: "will_break".to_string(),
                                reason: format!("{} requires {}", mod_item.name, mod_slug),
                            });
                        }
                        "optional" => {
                            warning_mods.push(AffectedMod {
                                slug: mod_item.slug.clone(),
                                name: mod_item.name.clone(),
                                impact: "may_lose_features".to_string(),
                                reason: format!(
                                    "{} has optional integration with {}",
                                    mod_item.name, mod_slug
                                ),
                            });
                        }
                        _ => {}
                    }
                }
            }
        }

        let is_safe = affected_mods.is_empty();
        let total_affected = affected_mods.len();

        Ok(ModRemovalAnalysis {
            mod_slug: mod_slug.to_string(),
            is_safe,
            affected_mods,
            warning_mods,
            total_affected,
            recommendation: if is_safe {
                "safe_to_remove".to_string()
            } else if total_affected <= 2 {
                "review_before_removing".to_string()
            } else {
                "not_recommended".to_string()
            },
        })
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
    pub async fn bulk_remove_mods(instance_id: &str, mod_ids: &[i64]) -> Result<Vec<i64>> {
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

    /// Batch install multiple local mods with optimized API lookups
    /// Uses batch Modrinth and CurseForge APIs for efficient verification
    pub async fn install_local_batch(
        instance_id: &str,
        file_paths: Vec<PathBuf>,
    ) -> Result<Vec<BatchModInstallResult>> {
        use futures::future::join_all;
        use std::collections::HashMap;

        if file_paths.is_empty() {
            return Ok(Vec::new());
        }

        let mods_dir = instance_mods_dir(instance_id);
        tokio::fs::create_dir_all(&mods_dir).await?;

        // Step 1: Parse all JAR files in parallel to get mod info and hashes
        let parse_futures = file_paths.iter().map(|path| {
            let path = path.clone();
            async move {
                let path_clone = path.clone();

                // Parse JAR for mod_id
                let jar_info = tokio::task::spawn_blocking({
                    let p = path.clone();
                    move || JarParser::parse_mod_jar(&p).ok()
                })
                .await
                .ok()
                .flatten();

                // Calculate SHA-1 hash
                let sha1 = tokio::task::spawn_blocking({
                    let p = path.clone();
                    move || calculate_sha1(&p).ok()
                })
                .await
                .ok()
                .flatten();

                // Calculate CurseForge fingerprint
                let fingerprint = tokio::task::spawn_blocking({
                    let p = path.clone();
                    move || compute_cf_fingerprint(&p)
                })
                .await
                .ok()
                .flatten();

                ModParseResult {
                    path: path_clone,
                    jar_info,
                    sha1,
                    fingerprint,
                }
            }
        });

        let parsed_mods: Vec<ModParseResult> = join_all(parse_futures).await;

        // Step 2: Batch lookup on Modrinth
        let sha1_hashes: Vec<String> = parsed_mods.iter().filter_map(|m| m.sha1.clone()).collect();

        let modrinth_results = if !sha1_hashes.is_empty() {
            ModrinthClient::get_versions_by_hashes(&sha1_hashes, "sha1")
                .await
                .unwrap_or_default()
        } else {
            HashMap::new()
        };

        // Step 3: Batch lookup on CurseForge for mods not found on Modrinth
        let fingerprints: Vec<u32> = parsed_mods
            .iter()
            .filter(|m| {
                // Only lookup mods not found on Modrinth
                m.sha1
                    .as_ref()
                    .map_or(true, |h| !modrinth_results.contains_key(h))
            })
            .filter_map(|m| m.fingerprint)
            .collect();

        let cf_matches: HashMap<u32, crate::api::curseforge::FingerprintMatch> =
            if !fingerprints.is_empty() {
                match CurseForgeClient::new() {
                    Ok(client) => {
                        match client.get_fingerprint_matches(&fingerprints).await {
                            Ok(matches) => {
                                log::debug!(
                                    "CurseForge batch install: {} fingerprints, {} matches",
                                    fingerprints.len(),
                                    matches.len()
                                );
                                matches.into_iter().map(|m| (m.fingerprint, m)).collect()
                            }
                            Err(e) => {
                                log::warn!("CurseForge fingerprint lookup failed: {}", e);
                                HashMap::new()
                            }
                        }
                    }
                    Err(e) => {
                        log::warn!("CurseForge client init failed: {}", e);
                        HashMap::new()
                    }
                }
            } else {
                HashMap::new()
            };

        // Step 4: Install each mod with resolved metadata
        let mut results = Vec::new();
        let conn = get_db_conn()?;

        for parsed in parsed_mods {
            let file_name = parsed
                .path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("unknown.jar")
                .to_string();

            // Determine mod info from JAR or API
            let (slug, mod_name, mod_version, source, source_id, project_slug) =
                resolve_mod_metadata(&parsed, &modrinth_results, &cf_matches, &file_name);

            // Check if already installed
            let existing: Option<i64> = conn
                .query_row(
                    "SELECT id FROM mods WHERE instance_id = ?1 AND slug = ?2",
                    params![instance_id, &slug],
                    |row| row.get(0),
                )
                .ok();

            if existing.is_some() {
                results.push(BatchModInstallResult {
                    file_name: file_name.clone(),
                    success: false,
                    mod_name: Some(mod_name),
                    error: Some("Мод уже установлен".to_string()),
                    source: source.clone(),
                    verified: source != "local",
                });
                continue;
            }

            // Copy file to mods directory
            let dest_path = mods_dir.join(&file_name);
            if let Err(e) = tokio::fs::copy(&parsed.path, &dest_path).await {
                results.push(BatchModInstallResult {
                    file_name: file_name.clone(),
                    success: false,
                    mod_name: Some(mod_name),
                    error: Some(format!("Ошибка копирования: {}", e)),
                    source: source.clone(),
                    verified: false,
                });
                continue;
            }

            // Calculate hash for DB
            let file_hash = parsed.sha1.clone().unwrap_or_else(|| "unknown".to_string());
            let file_size = tokio::fs::metadata(&dest_path)
                .await
                .map(|m| m.len())
                .unwrap_or(0);

            // Save to database
            let now = Utc::now().to_rfc3339();
            if let Err(e) = conn.execute(
                r#"INSERT INTO mods (
                    instance_id, slug, name, version, minecraft_version,
                    source, source_id, file_name, file_hash, file_size,
                    enabled, auto_update, installed_at, updated_at, project_slug
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)"#,
                params![
                    instance_id,
                    &slug,
                    &mod_name,
                    &mod_version,
                    "unknown",
                    &source,
                    source_id.as_ref(),
                    &file_name,
                    &file_hash,
                    file_size as i64,
                    1,                                     // enabled
                    if source != "local" { 1 } else { 0 }, // auto_update for verified mods
                    &now,
                    &now,
                    project_slug.as_ref(),
                ],
            ) {
                results.push(BatchModInstallResult {
                    file_name: file_name.clone(),
                    success: false,
                    mod_name: Some(mod_name),
                    error: Some(format!("Ошибка БД: {}", e)),
                    source: source.clone(),
                    verified: false,
                });
                continue;
            }

            results.push(BatchModInstallResult {
                file_name,
                success: true,
                mod_name: Some(mod_name),
                error: None,
                source: source.clone(),
                verified: source != "local",
            });
        }

        Ok(results)
    }

    /// Verify and sync all mods in an instance with official platforms
    /// Returns verification results and updates database with official metadata
    /// Uses INCREMENTAL verification - only verifies mods that have changed
    /// Верификация модов с полным pipeline поиска:
    /// 1. Modrinth SHA1 batch lookup
    /// 2. Modrinth SHA512 batch lookup (fallback)
    /// 3. CurseForge fingerprint lookup
    /// 4. Поиск по mod_id из JAR метаданных
    /// 5. Поиск по имени + версии
    pub async fn verify_instance_mods(
        instance_id: &str,
        app_handle: Option<tauri::AppHandle>,
    ) -> Result<Vec<ModVerifyResult>> {
        use futures::future::join_all;
        use std::collections::HashMap;
        use tauri::Emitter;

        // Helper to emit progress events
        let emit_progress = |stage: &str, current: usize, total: usize, message: &str| {
            if let Some(ref app) = app_handle {
                let _ = app.emit(
                    "verification-progress",
                    VerificationProgress {
                        instance_id: instance_id.to_string(),
                        stage: stage.to_string(),
                        current,
                        total,
                        message: message.to_string(),
                    },
                );
            }
        };

        let mods_dir = instance_mods_dir(instance_id);
        if !mods_dir.exists() {
            return Ok(Vec::new());
        }

        // Get instance info for fallback search
        let (minecraft_version, loader): (String, String) = {
            let conn = get_db_conn()?;
            conn.query_row(
                "SELECT version, loader FROM instances WHERE id = ?1",
                [instance_id],
                |row| Ok((row.get(0)?, row.get::<_, Option<String>>(1)?.unwrap_or_default())),
            )
            .unwrap_or_else(|_| ("1.20.1".to_string(), "fabric".to_string()))
        };

        // Step 1: Scan mods folder for JAR files
        emit_progress("scanning", 0, 0, "Сканирование папки модов...");
        let mut jar_files = Vec::new();
        let mut entries = tokio::fs::read_dir(&mods_dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if path.extension().map(|e| e == "jar").unwrap_or(false) {
                jar_files.push(path);
            }
        }

        if jar_files.is_empty() {
            emit_progress("done", 0, 0, "Нет модов");
            return Ok(Vec::new());
        }
        let total_mods = jar_files.len();

        // FAST PATH: Check if all mods are already verified (no file changes)
        // This avoids expensive SHA1 calculation when nothing changed
        {
            let conn = get_db_conn()?;
            let verified_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM mods WHERE instance_id = ?1 AND verified_file_hash IS NOT NULL",
                    [instance_id],
                    |row| row.get(0),
                )
                .unwrap_or(0);
            let total_in_db: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM mods WHERE instance_id = ?1",
                    [instance_id],
                    |row| row.get(0),
                )
                .unwrap_or(0);

            // If DB has same number of mods as folder AND all are verified → use cached results
            if verified_count > 0 && verified_count == total_in_db && total_in_db as usize == total_mods {
                log::info!(
                    "Fast path: all {} mods already verified, returning cached results",
                    total_mods
                );
                emit_progress("done", total_mods, total_mods, "Все моды проверены (кэш)");
                return Self::get_cached_verification_results(instance_id);
            }
        }

        // Step 2: Get existing mod data from DB for incremental check
        // Tuple: (file_hash, verified_file_hash, source, source_id, name, version, icon_url)
        let existing_mods: HashMap<String, (Option<String>, Option<String>, String, Option<String>, Option<String>, Option<String>, Option<String>)> = {
            let conn = get_db_conn()?;
            let mut stmt = conn.prepare(
                "SELECT file_name, file_hash, verified_file_hash, source, source_id, name, version, icon_url
                 FROM mods WHERE instance_id = ?1"
            )?;
            let rows: Vec<_> = stmt.query_map([instance_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,           // file_name
                    row.get::<_, Option<String>>(1)?,   // file_hash
                    row.get::<_, Option<String>>(2)?,   // verified_file_hash
                    row.get::<_, String>(3)?,           // source
                    row.get::<_, Option<String>>(4)?,   // source_id
                    row.get::<_, Option<String>>(5)?,   // name
                    row.get::<_, Option<String>>(6)?,   // version
                    row.get::<_, Option<String>>(7)?,   // icon_url
                ))
            })?
            .filter_map(|r| r.ok())
            .collect();
            rows.into_iter()
                .map(|(fname, fhash, vhash, source, sid, name, ver, icon)| {
                    (fname, (fhash, vhash, source, sid, name, ver, icon))
                })
                .collect()
        };

        // Step 3: Calculate SHA1 for all files and identify which need verification
        emit_progress("hashing", 0, total_mods, "Вычисление хешей файлов...");
        let hash_futures = jar_files.iter().map(|path| {
            let path = path.clone();
            async move {
                let sha1 = tokio::task::spawn_blocking({
                    let p = path.clone();
                    move || calculate_sha1(&p).ok()
                })
                .await
                .ok()
                .flatten();
                (path, sha1)
            }
        });
        let file_sha1_hashes: Vec<(PathBuf, Option<String>)> = join_all(hash_futures).await;
        emit_progress("hashing", total_mods, total_mods, "Хеши вычислены");

        // Separate mods: already verified (cached) vs needs verification
        let mut cached_results: Vec<ModVerifyResult> = Vec::new();
        let mut mods_to_verify: Vec<(PathBuf, Option<String>)> = Vec::new();

        for (path, sha1) in file_sha1_hashes {
            let file_name = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("unknown.jar")
                .to_string();

            if let Some((existing_hash, verified_hash, source, source_id, name, version, icon_url)) = existing_mods.get(&file_name) {
                // Check if mod hasn't changed and was previously verified
                let current_hash = sha1.as_ref();
                let is_unchanged = match (current_hash, existing_hash.as_ref(), verified_hash.as_ref()) {
                    (Some(curr), Some(exist), Some(verified)) => {
                        // Mod unchanged if: current hash = existing hash = verified hash
                        curr == exist && exist == verified
                    }
                    _ => false,
                };

                // Cache works for ALL sources including "local" (negative cache)
                // If verified_file_hash matches, we already checked this file
                if is_unchanged {
                    // Use cached result - mod hasn't changed since last verification
                    cached_results.push(ModVerifyResult {
                        file_name,
                        verified: source != "local", // local = not verified on platforms
                        platform: source.clone(),
                        status: if source == "local" { "unknown".to_string() } else { "verified".to_string() },
                        project_name: name.clone(),
                        project_id: source_id.clone(),
                        version: version.clone(),
                        icon_url: icon_url.clone(),
                    });
                    continue;
                }
            }

            // Mod needs verification
            mods_to_verify.push((path, sha1));
        }

        log::info!(
            "Incremental verification for {} (MC {}, {}): {} cached, {} need verification",
            instance_id,
            minecraft_version,
            loader,
            cached_results.len(),
            mods_to_verify.len()
        );

        // If all mods are cached, return early
        if mods_to_verify.is_empty() {
            return Ok(cached_results);
        }

        // Step 4: Calculate SHA512 and CurseForge fingerprint only for mods that need verification
        let extra_hash_futures = mods_to_verify.iter().map(|(path, sha1)| {
            let path = path.clone();
            let sha1 = sha1.clone();
            async move {
                // SHA512 (for Modrinth fallback)
                let sha512 = tokio::task::spawn_blocking({
                    let p = path.clone();
                    move || calculate_sha512(&p).ok()
                })
                .await
                .ok()
                .flatten();

                // CurseForge fingerprint
                let fingerprint = tokio::task::spawn_blocking({
                    let p = path.clone();
                    move || compute_cf_fingerprint(&p)
                })
                .await
                .ok()
                .flatten();

                (path, sha1, sha512, fingerprint)
            }
        });

        let file_hashes: Vec<(PathBuf, Option<String>, Option<String>, Option<u32>)> =
            join_all(extra_hash_futures).await;

        // Step 3: Batch Modrinth SHA1 lookup
        let mods_to_check = file_hashes.len();
        emit_progress("modrinth_lookup", 0, mods_to_check, "Поиск на Modrinth (SHA1)...");
        let sha1_hashes: Vec<String> = file_hashes
            .iter()
            .filter_map(|(_, h, _, _)| h.clone())
            .collect();

        let modrinth_sha1_results: HashMap<String, crate::api::modrinth::ModrinthVersion> =
            if !sha1_hashes.is_empty() {
                ModrinthClient::get_versions_by_hashes(&sha1_hashes, "sha1")
                    .await
                    .unwrap_or_default()
            } else {
                HashMap::new()
            };

        log::info!(
            "Modrinth SHA1 lookup: {} hashes, {} matches",
            sha1_hashes.len(),
            modrinth_sha1_results.len()
        );
        emit_progress("modrinth_lookup", modrinth_sha1_results.len(), mods_to_check, &format!("Modrinth SHA1: {} найдено", modrinth_sha1_results.len()));

        // Step 4: Batch Modrinth SHA512 lookup for remaining mods
        emit_progress("modrinth_lookup", modrinth_sha1_results.len(), mods_to_check, "Поиск на Modrinth (SHA512)...");
        let sha512_hashes_to_lookup: Vec<String> = file_hashes
            .iter()
            .filter(|(_, sha1, _, _)| {
                sha1.as_ref()
                    .map_or(true, |h| !modrinth_sha1_results.contains_key(h))
            })
            .filter_map(|(_, _, sha512, _)| sha512.clone())
            .collect();

        let modrinth_sha512_results: HashMap<String, crate::api::modrinth::ModrinthVersion> =
            if !sha512_hashes_to_lookup.is_empty() {
                ModrinthClient::get_versions_by_hashes(&sha512_hashes_to_lookup, "sha512")
                    .await
                    .unwrap_or_default()
            } else {
                HashMap::new()
            };

        let modrinth_total = modrinth_sha1_results.len() + modrinth_sha512_results.len();
        log::info!(
            "Modrinth SHA512 lookup: {} hashes, {} matches",
            sha512_hashes_to_lookup.len(),
            modrinth_sha512_results.len()
        );
        emit_progress("modrinth_lookup", modrinth_total, mods_to_check, &format!("Modrinth: {} найдено", modrinth_total));

        // Step 5: CurseForge fingerprint lookup for remaining
        emit_progress("curseforge_lookup", modrinth_total, mods_to_check, "Поиск на CurseForge...");
        let fingerprints_to_lookup: Vec<u32> = file_hashes
            .iter()
            .filter(|(_, sha1, sha512, _)| {
                let found_sha1 = sha1
                    .as_ref()
                    .map_or(false, |h| modrinth_sha1_results.contains_key(h));
                let found_sha512 = sha512
                    .as_ref()
                    .map_or(false, |h| modrinth_sha512_results.contains_key(h));
                !found_sha1 && !found_sha512
            })
            .filter_map(|(_, _, _, fp)| *fp)
            .collect();

        let cf_matches: HashMap<u32, crate::api::curseforge::FingerprintMatch> =
            if !fingerprints_to_lookup.is_empty() {
                match CurseForgeClient::new() {
                    Ok(client) => match client.get_fingerprint_matches(&fingerprints_to_lookup).await {
                        Ok(matches) => {
                            log::info!(
                                "CurseForge fingerprint lookup: {} fingerprints, {} matches",
                                fingerprints_to_lookup.len(),
                                matches.len()
                            );
                            matches.into_iter().map(|m| (m.fingerprint, m)).collect()
                        }
                        Err(e) => {
                            log::warn!("CurseForge fingerprint lookup failed: {}", e);
                            HashMap::new()
                        }
                    },
                    Err(e) => {
                        log::warn!("CurseForge client init failed: {}", e);
                        HashMap::new()
                    }
                }
            } else {
                HashMap::new()
            };

        let verified_so_far = modrinth_total + cf_matches.len();
        emit_progress("curseforge_lookup", verified_so_far, mods_to_check, &format!("Найдено: {} (Modrinth: {}, CurseForge: {})", verified_so_far, modrinth_total, cf_matches.len()));

        // Step 6: Batch fetch project/mod info for icons
        emit_progress("icons", 0, verified_so_far, "Загрузка иконок...");
        // Collect Modrinth project IDs from all version matches
        let modrinth_project_ids: Vec<String> = modrinth_sha1_results
            .values()
            .chain(modrinth_sha512_results.values())
            .map(|v| v.project_id.clone())
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .collect();

        // Batch fetch Modrinth projects to get icons
        let modrinth_project_icons: HashMap<String, Option<String>> = if !modrinth_project_ids.is_empty() {
            match ModrinthClient::get_projects(&modrinth_project_ids).await {
                Ok(projects) => {
                    log::info!("Fetched {} Modrinth project icons", projects.len());
                    projects.into_iter().map(|p| (p.id, p.icon_url)).collect()
                }
                Err(e) => {
                    log::warn!("Failed to fetch Modrinth project icons: {}", e);
                    HashMap::new()
                }
            }
        } else {
            HashMap::new()
        };

        // Collect CurseForge mod IDs from fingerprint matches
        let cf_mod_ids: Vec<u64> = cf_matches.values().map(|m| m.id).collect();

        // Batch fetch CurseForge mods to get icons
        let cf_mod_icons: HashMap<u64, Option<String>> = if !cf_mod_ids.is_empty() {
            match CurseForgeClient::new() {
                Ok(client) => match client.get_mods(&cf_mod_ids).await {
                    Ok(mods) => {
                        log::info!("Fetched {} CurseForge mod icons", mods.len());
                        mods.into_iter()
                            .map(|m| (m.id, m.logo.map(|l| l.thumbnail_url)))
                            .collect()
                    }
                    Err(e) => {
                        log::warn!("Failed to fetch CurseForge mod icons: {}", e);
                        HashMap::new()
                    }
                },
                Err(_) => HashMap::new(),
            }
        } else {
            HashMap::new()
        };

        // Step 7: Build initial results and identify mods needing fallback search
        let mut results = Vec::new();
        let mut mods_for_fallback: Vec<(PathBuf, String)> = Vec::new();
        let conn = get_db_conn()?;

        for (path, sha1, sha512, fingerprint) in &file_hashes {
            let file_name = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("unknown.jar")
                .to_string();

            // Check Modrinth SHA1
            if let Some(sha1_hash) = sha1 {
                if let Some(version) = modrinth_sha1_results.get(sha1_hash) {
                    let icon_url = modrinth_project_icons
                        .get(&version.project_id)
                        .cloned()
                        .flatten();
                    results.push(ModVerifyResult {
                        file_name,
                        verified: true,
                        platform: "modrinth".to_string(),
                        status: "verified".to_string(),
                        project_name: Some(version.name.clone()),
                        project_id: Some(version.project_id.clone()),
                        version: Some(version.version_number.clone()),
                        icon_url,
                    });
                    continue;
                }
            }

            // Check Modrinth SHA512
            if let Some(sha512_hash) = sha512 {
                if let Some(version) = modrinth_sha512_results.get(sha512_hash) {
                    let icon_url = modrinth_project_icons
                        .get(&version.project_id)
                        .cloned()
                        .flatten();
                    results.push(ModVerifyResult {
                        file_name,
                        verified: true,
                        platform: "modrinth".to_string(),
                        status: "verified".to_string(),
                        project_name: Some(version.name.clone()),
                        project_id: Some(version.project_id.clone()),
                        version: Some(version.version_number.clone()),
                        icon_url,
                    });
                    continue;
                }
            }

            // Check CurseForge fingerprint
            if let Some(fp) = fingerprint {
                if let Some(cf_match) = cf_matches.get(fp) {
                    let icon_url = cf_mod_icons.get(&cf_match.id).cloned().flatten();
                    results.push(ModVerifyResult {
                        file_name,
                        verified: true,
                        platform: "curseforge".to_string(),
                        status: "verified".to_string(),
                        project_name: Some(cf_match.file.display_name.clone()),
                        project_id: Some(cf_match.id.to_string()),
                        version: Some(cf_match.file.display_name.clone()),
                        icon_url,
                    });
                    continue;
                }
            }

            // Add to fallback list
            mods_for_fallback.push((path.clone(), file_name));
        }

        log::info!(
            "After hash lookups: {} verified, {} not found on platforms",
            results.len(),
            mods_for_fallback.len()
        );

        // Step 7: Mark remaining mods as local/unknown (NO slow API search - just parse JAR for metadata)
        // API search was removed as it was too slow and often gave false positives
        if !mods_for_fallback.is_empty() {
            let fallback_count = mods_for_fallback.len();
            emit_progress("fallback_search", 0, fallback_count, "Обработка локальных модов...");

            for (idx, (path, file_name)) in mods_for_fallback.iter().enumerate() {
                // Parse JAR for metadata (name, version)
                let jar_info = tokio::task::spawn_blocking({
                    let p = path.clone();
                    move || JarParser::parse_mod_jar(&p).ok()
                })
                .await
                .ok()
                .flatten();

                let project_name = jar_info
                    .as_ref()
                    .and_then(|d| d.mod_info.as_ref())
                    .map(|i| i.name.clone());

                let version = jar_info
                    .as_ref()
                    .and_then(|d| d.mod_info.as_ref())
                    .map(|i| i.version.clone());

                results.push(ModVerifyResult {
                    file_name: file_name.clone(),
                    verified: false,
                    platform: "local".to_string(),
                    status: "unknown".to_string(),
                    project_name,
                    project_id: None,
                    version,
                    icon_url: None,
                });

                if (idx + 1) % 50 == 0 {
                    emit_progress("fallback_search", idx + 1, fallback_count, &format!("Обработано {} модов...", idx + 1));
                }
            }

            emit_progress("fallback_search", fallback_count, fallback_count, &format!("Обработано {} локальных модов", fallback_count));
            log::info!("Marked {} mods as local/unknown (no API search)", fallback_count);
        }

        // Build map of file_name -> current sha1 hash for updating verified_file_hash
        let file_hash_map: HashMap<String, String> = file_hashes
            .iter()
            .filter_map(|(path, sha1, _, _)| {
                let file_name = path.file_name()?.to_str()?.to_string();
                sha1.as_ref().map(|h| (file_name, h.clone()))
            })
            .collect();

        // IMPORTANT: Save verification results to mods table so they persist!
        // Also update verified_file_hash for ALL mods (including local) for incremental verification
        // Also save icon_url from verification for display in graph and lists
        emit_progress("saving", 0, results.len(), "Сохранение результатов...");
        let mut updated_count = 0;
        for (idx, result) in results.iter().enumerate() {
            // Save verified_file_hash for ALL mods - including "local" (negative cache)
            // This prevents re-checking mods that were already verified/not found
            let platform = &result.platform;
            let source_id = result.project_id.as_deref();
            let icon_url = result.icon_url.as_deref();
            // DON'T save project_name here! It contains version.name (like "1.6.9 Forge")
            // The correct mod name is already in DB from JAR parsing during sync
            // Enrichment will update it with project.title if needed
            let current_hash = file_hash_map.get(&result.file_name);

            if let Err(e) = conn.execute(
                "UPDATE mods SET source = ?1, source_id = ?2, verified_file_hash = ?3, icon_url = COALESCE(?4, icon_url)
                 WHERE instance_id = ?5 AND file_name = ?6",
                params![
                    platform,
                    source_id,
                    current_hash,
                    icon_url,
                    instance_id,
                    &result.file_name
                ],
            ) {
                log::warn!("Failed to save verification for {}: {}", result.file_name, e);
            } else {
                updated_count += 1;
            }
        }

        emit_progress("saving", results.len(), results.len(), &format!("Сохранено: {} модов", updated_count));

        if updated_count > 0 {
            log::info!(
                "Saved verification results: {} mods updated in database (with verified_file_hash)",
                updated_count
            );
        }

        // Merge cached results with newly verified results
        let mut all_results = cached_results;
        all_results.extend(results);

        let verified_count = all_results.iter().filter(|r| r.verified).count();
        log::info!(
            "Verification complete: {}/{} mods verified ({} from cache, {} newly verified)",
            verified_count,
            all_results.len(),
            all_results.len() - file_hashes.len(),
            updated_count
        );

        emit_progress("done", all_results.len(), all_results.len(), &format!("Готово: {}/{} проверено", verified_count, all_results.len()));

        Ok(all_results)
    }

    /// Check if verification is needed based on hash of mod files
    /// Returns (needs_verification, current_hash)
    fn check_verification_needed(instance_id: &str) -> Result<(bool, String)> {
        let conn = get_db_conn()?;

        // Calculate current hash using xxh3 (fast, non-cryptographic)
        let mut sha1_hashes: Vec<String> = conn
            .prepare(
                "SELECT file_hash FROM mods WHERE instance_id = ?1 AND file_hash IS NOT NULL ORDER BY file_hash",
            )?
            .query_map([instance_id], |row| row.get(0))?
            .filter_map(|r| r.ok())
            .collect();

        sha1_hashes.sort();
        let combined = sha1_hashes.join("|");

        // Use xxh3 - extremely fast hash for cache invalidation
        let current_hash = format!("{:016x}", xxhash_rust::xxh3::xxh3_64(combined.as_bytes()));

        // Get cached verification hash
        let cached_hash: Option<String> = conn
            .query_row(
                "SELECT verification_hash FROM instances WHERE id = ?1",
                [instance_id],
                |row| row.get(0),
            )
            .ok();

        log::debug!(
            "Verification check for {}: cached={:?}, current={}, needs={}",
            instance_id,
            cached_hash,
            current_hash,
            cached_hash.as_deref() != Some(&current_hash)
        );

        let needs = cached_hash.as_deref() != Some(&current_hash);
        Ok((needs, current_hash))
    }

    /// Get cached verification results from DB (mods with source set)
    /// Note: This returns cached status, not fresh verification
    fn get_cached_verification_results(instance_id: &str) -> Result<Vec<ModVerifyResult>> {
        let conn = get_db_conn()?;
        let mut stmt = conn.prepare(
            "SELECT file_name, source, source_id, name, version, icon_url FROM mods WHERE instance_id = ?1",
        )?;

        let results = stmt
            .query_map([instance_id], |row| {
                let file_name: String = row.get(0)?;
                let source: String = row.get(1)?;
                let source_id: Option<String> = row.get(2)?;
                let name: Option<String> = row.get(3)?;
                let version: Option<String> = row.get(4)?;
                let icon_url: Option<String> = row.get(5)?;

                // Determine platform, status, and verified based on source
                let (platform, status, verified) = match source.as_str() {
                    "modrinth" if source_id.is_some() => ("modrinth".to_string(), "verified".to_string(), true),
                    "curseforge" if source_id.is_some() => ("curseforge".to_string(), "verified".to_string(), true),
                    "modrinth" | "curseforge" => (source.clone(), "modified".to_string(), false),
                    // Local/modpack mods - unknown source
                    _ => ("local".to_string(), "unknown".to_string(), false),
                };

                Ok(ModVerifyResult {
                    file_name,
                    verified,
                    platform,
                    status,
                    project_name: name,
                    project_id: source_id,
                    version,
                    icon_url,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        Ok(results)
    }

    /// Проверяет, нужно ли обновлять данные о зависимостях из API
    /// Возвращает true если зависимости отсутствуют или устарели
    pub fn needs_dependency_enrichment(instance_id: &str) -> Result<bool> {
        let conn = get_db_conn()?;

        // Проверяем количество зависимостей для модов этого instance
        let deps_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM mod_dependencies md
             JOIN mods m ON m.id = md.mod_id
             WHERE m.instance_id = ?1",
                [instance_id],
                |row| row.get(0),
            )
            .unwrap_or(0);

        // Проверяем количество модов с source='modrinth' (из API)
        let enriched_mods: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM mods
             WHERE instance_id = ?1 AND source = 'modrinth' AND source_id IS NOT NULL",
                [instance_id],
                |row| row.get(0),
            )
            .unwrap_or(0);

        let total_mods: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM mods WHERE instance_id = ?1",
                [instance_id],
                |row| row.get(0),
            )
            .unwrap_or(0);

        // Нужно обновление если:
        // 1. Нет зависимостей вообще
        // 2. Меньше половины модов обогащены
        Ok(deps_count == 0 || (enriched_mods < total_mods / 2 && total_mods > 5))
    }

    /// Обогащение данных о модах через API (batch-запрос)
    /// Загружает зависимости для всех модов instance
    /// Check if enrichment is needed by comparing hash of mod files
    /// Returns (needs_enrichment, current_hash)
    pub fn check_enrichment_needed(instance_id: &str) -> Result<(bool, String)> {
        let mods = Self::list_mods(instance_id)?;
        let mods_dir = instance_mods_dir(instance_id);

        // Calculate combined hash of all mod file hashes
        let mut all_hashes: Vec<String> = Vec::new();
        for mod_item in &mods {
            let file_path = mods_dir.join(&mod_item.file_name);
            if file_path.exists() {
                if let Ok(sha1) = calculate_sha1(&file_path) {
                    all_hashes.push(sha1);
                }
            }
        }

        // Sort for consistent hash
        all_hashes.sort();
        let combined = all_hashes.join("|");
        // Use xxh3 - extremely fast hash for cache invalidation
        let current_hash = format!("{:016x}", xxhash_rust::xxh3::xxh3_64(combined.as_bytes()));

        // Check cached hash in DB
        let conn = get_db_conn()?;
        let cached_hash: Option<String> = conn
            .query_row(
                "SELECT enrichment_hash FROM instances WHERE id = ?1",
                [instance_id],
                |row| row.get(0),
            )
            .unwrap_or(None);

        let needs_enrichment = cached_hash.as_ref() != Some(&current_hash);

        log::debug!(
            "Enrichment check for {}: cached={:?}, current={}, needs={}",
            instance_id,
            cached_hash,
            current_hash,
            needs_enrichment
        );

        Ok((needs_enrichment, current_hash))
    }

    pub async fn enrich_mod_dependencies(instance_id: &str) -> Result<EnrichmentResult> {
        let mods = Self::list_mods(instance_id)?;
        let mods_dir = instance_mods_dir(instance_id);

        if mods.is_empty() {
            return Ok(EnrichmentResult {
                total_mods: 0,
                enriched_mods: 0,
                dependencies_added: 0,
                errors: vec![],
            });
        }

        // Step 1: Get existing enrichment status from DB for incremental check
        let existing_enrichment: HashMap<String, Option<String>> = {
            let conn = get_db_conn()?;
            let mut stmt = conn.prepare(
                "SELECT file_name, enriched_file_hash FROM mods WHERE instance_id = ?1"
            )?;
            let rows: Vec<_> = stmt.query_map([instance_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                ))
            })?
            .filter_map(|r| r.ok())
            .collect();
            rows.into_iter().collect()
        };

        // Step 2: Calculate SHA1 hashes and identify mods needing enrichment
        let mut file_hashes: Vec<(i64, String, String)> = Vec::new(); // (mod_id, filename, sha1) - mods to enrich
        let mut cached_count = 0;

        for mod_item in &mods {
            let file_path = mods_dir.join(&mod_item.file_name);
            if !file_path.exists() {
                continue;
            }

            let sha1 = match calculate_sha1(&file_path) {
                Ok(h) => h,
                Err(_) => continue,
            };

            // Check if already enriched with same hash
            if let Some(enriched_hash) = existing_enrichment.get(&mod_item.file_name) {
                if enriched_hash.as_deref() == Some(&sha1) {
                    // Already enriched and unchanged - skip
                    cached_count += 1;
                    continue;
                }
            }

            // Needs enrichment
            file_hashes.push((mod_item.id, mod_item.file_name.clone(), sha1));
        }

        log::info!(
            "Incremental enrichment for {}: {} cached, {} need enrichment",
            instance_id,
            cached_count,
            file_hashes.len()
        );

        // If all mods are already enriched, return early
        if file_hashes.is_empty() {
            return Ok(EnrichmentResult {
                total_mods: mods.len(),
                enriched_mods: 0,
                dependencies_added: 0,
                errors: vec![],
            });
        }

        // Step 2: Batch request to Modrinth for versions
        let sha1_list: Vec<String> = file_hashes.iter().map(|(_, _, h)| h.clone()).collect();
        let modrinth_results = ModrinthClient::get_versions_by_hashes(&sha1_list, "sha1")
            .await
            .unwrap_or_default();

        // Step 3: Collect all project IDs (from versions + dependencies)
        let mut all_project_ids: Vec<String> = modrinth_results
            .values()
            .map(|v| v.project_id.clone())
            .collect();

        // Also collect dependency project IDs
        for version in modrinth_results.values() {
            for dep in &*version.dependencies {
                if let Some(ref pid) = dep.project_id {
                    if !all_project_ids.contains(pid) {
                        all_project_ids.push(pid.clone());
                    }
                }
            }
        }

        // Step 4: Batch request for project info (names, slugs, icons)
        let projects = ModrinthClient::get_projects(&all_project_ids)
            .await
            .unwrap_or_default();

        // Step 5: Create project_id -> (title, slug, icon) map using project.id
        let pid_to_info: HashMap<String, (&str, &str, Option<&str>)> = projects
            .iter()
            .map(|p| {
                (
                    p.id.clone(),
                    (p.title.as_str(), p.slug.as_str(), p.icon_url.as_deref()),
                )
            })
            .collect();

        // Step 6: Map sha1 -> mod_id AND sha1 -> filename (for better fallback)
        let sha1_to_mod_id: HashMap<String, i64> = file_hashes
            .iter()
            .map(|(id, _, sha1)| (sha1.clone(), *id))
            .collect();

        let sha1_to_filename: HashMap<String, String> = file_hashes
            .iter()
            .map(|(_, filename, sha1)| (sha1.clone(), filename.clone()))
            .collect();

        // Step 6.5: Collect missing dependency project IDs and make a second batch request
        let mut missing_dep_ids: Vec<String> = Vec::new();
        for version in modrinth_results.values() {
            for dep in &*version.dependencies {
                if let Some(ref pid) = dep.project_id {
                    if !pid_to_info.contains_key(pid) && !missing_dep_ids.contains(pid) {
                        missing_dep_ids.push(pid.clone());
                    }
                }
            }
        }

        // Fetch missing dependency project info
        let mut pid_to_info: HashMap<String, (String, String, Option<String>)> = pid_to_info
            .iter()
            .map(|(k, (title, slug, icon))| {
                (
                    k.clone(),
                    (
                        title.to_string(),
                        slug.to_string(),
                        icon.map(|s| s.to_string()),
                    ),
                )
            })
            .collect();

        if !missing_dep_ids.is_empty() {
            if let Ok(extra_projects) = ModrinthClient::get_projects(&missing_dep_ids).await {
                for p in extra_projects {
                    pid_to_info.insert(
                        p.id.clone(),
                        (p.title.clone(), p.slug.clone(), p.icon_url.clone()),
                    );
                }
            }
        }

        // Step 7: Save dependencies and update mod data
        let conn = get_db_conn()?;
        let now = Utc::now().to_rfc3339();
        let mut enriched_count = 0;
        let mut deps_added = 0;
        let mut errors: Vec<String> = Vec::new();

        // Track assigned slugs to detect duplicates (same mod in folder twice)
        // Key: new_slug -> mod_id that owns it
        let mut assigned_slugs: HashMap<String, i64> = {
            // Initialize with existing slugs from database
            let mut stmt = conn.prepare(
                "SELECT slug, id FROM mods WHERE instance_id = ?1"
            )?;
            let rows: Vec<(String, i64)> = stmt.query_map([instance_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?
            .filter_map(|r| r.ok())
            .collect();
            rows.into_iter().collect()
        };

        for (sha1, version) in &modrinth_results {
            let mod_id = match sha1_to_mod_id.get(sha1) {
                Some(id) => *id,
                None => continue,
            };

            // Get project info (title, slug, icon) from pid_to_info
            // If not found, try to get it via individual API call
            let (title, slug, icon_url): (String, String, Option<String>) =
                if let Some((t, s, i)) = pid_to_info.get(&version.project_id) {
                    (t.clone(), s.clone(), i.clone())
                } else {
                    // Project not in batch result - try individual request
                    // This can happen if batch API returns partial results
                    if let Ok(project) =
                        ModrinthClient::get_project(&version.project_id).await
                    {
                        log::debug!(
                            "Fetched missing project info for {}: {}",
                            version.project_id,
                            project.title
                        );
                        // Cache it for dependencies
                        pid_to_info.insert(
                            project.id.clone(),
                            (
                                project.title.clone(),
                                project.slug.clone(),
                                project.icon_url.clone(),
                            ),
                        );
                        (project.title, project.slug, project.icon_url)
                    } else {
                        // Last resort: derive from filename, NOT version.name!
                        // version.name is the VERSION title like "1.6.9 Forge (1.20.1)" - WRONG!
                        let filename = sha1_to_filename.get(sha1).cloned().unwrap_or_default();
                        let (slug_from_file, _) = parse_mod_filename(&filename);
                        let title_from_slug = slug_from_file
                            .replace('-', " ")
                            .replace('_', " ")
                            .split_whitespace()
                            .map(|w| {
                                let mut c = w.chars();
                                match c.next() {
                                    Some(first) => {
                                        first.to_uppercase().collect::<String>() + c.as_str()
                                    }
                                    None => String::new(),
                                }
                            })
                            .collect::<Vec<_>>()
                            .join(" ");
                        log::warn!(
                            "Project {} not found on Modrinth, using filename fallback: {}",
                            version.project_id,
                            title_from_slug
                        );
                        (title_from_slug, slug_from_file, None)
                    }
                };

            // Check for slug conflict (duplicate mod detection)
            // This can happen if the same mod is installed twice with different filenames
            if let Some(&existing_mod_id) = assigned_slugs.get(&slug) {
                if existing_mod_id != mod_id {
                    // This slug is already owned by another mod - this is a duplicate!
                    // Mark enriched_file_hash to avoid re-processing, but don't update slug
                    let filename = sha1_to_filename.get(sha1).cloned().unwrap_or_default();
                    errors.push(format!(
                        "Дубликат мода: {} (файл: {}) - уже установлен как другой файл. Рекомендуем удалить дубликат.",
                        title,
                        filename
                    ));
                    // Still mark as enriched to avoid re-processing
                    let _ = conn.execute(
                        "UPDATE mods SET enriched_file_hash = ?1 WHERE id = ?2",
                        params![sha1, mod_id],
                    );
                    continue;
                }
            }

            // Update mod data with PROJECT title (not version name!)
            // Also set enriched_file_hash for incremental enrichment
            if let Err(e) = conn.execute(
                r#"UPDATE mods SET
                    source = 'modrinth',
                    source_id = ?1,
                    slug = ?2,
                    name = ?3,
                    version = ?4,
                    file_hash = ?5,
                    icon_url = ?6,
                    updated_at = ?7,
                    enriched_file_hash = ?5
                WHERE id = ?8"#,
                params![
                    &version.project_id,
                    slug,
                    title,
                    &version.version_number,
                    sha1,
                    icon_url,
                    &now,
                    mod_id,
                ],
            ) {
                errors.push(format!("Failed to update mod {}: {}", mod_id, e));
                continue;
            }

            // Update assigned_slugs to track this mod now owns this slug
            assigned_slugs.insert(slug.clone(), mod_id);

            enriched_count += 1;

            // Debug: log raw dependencies before filtering
            if !version.dependencies.is_empty() {
                log::debug!(
                    "Mod {} raw deps: {} total, types: {:?}",
                    slug,
                    version.dependencies.len(),
                    version
                        .dependencies
                        .iter()
                        .map(|d| (&d.dependency_type, d.project_id.is_some()))
                        .collect::<Vec<_>>()
                );
            }

            // Count how many dependencies will be added
            let new_deps: Vec<_> = version
                .dependencies
                .iter()
                .filter(|d| {
                    d.project_id.is_some()
                        && (d.dependency_type == "required"
                            || d.dependency_type == "optional"
                            || d.dependency_type == "incompatible")
                })
                .collect();

            // Only clear old dependencies if we have new ones to replace them
            // This prevents data loss when API returns empty/partial results
            if !new_deps.is_empty() {
                let _ = conn.execute("DELETE FROM mod_dependencies WHERE mod_id = ?1", [mod_id]);
            }

            log::debug!(
                "Enriched mod {} ({}) from Modrinth: {} dependencies",
                title,
                slug,
                new_deps.len()
            );

            // Save new dependencies with proper names AND slugs
            // IMPORTANT: Store the SLUG (like "fabric-api"), not project_id (like "P7dR8mSH")
            // so that alias matching works in check_dependencies
            let mut mod_deps_saved = 0;
            for dep in &*version.dependencies {
                if let Some(ref project_id) = dep.project_id {
                    if dep.dependency_type == "required"
                        || dep.dependency_type == "optional"
                        || dep.dependency_type == "incompatible"
                    {
                        // Get dependency name AND slug from pid_to_info map
                        let (dep_name, dep_slug) = pid_to_info
                            .get(project_id)
                            .map(|(name, slug, _)| (name.clone(), slug.clone()))
                            .or_else(|| {
                                // Try to find the dependency in currently installed mods
                                mods.iter()
                                    .find(|m| m.source_id.as_deref() == Some(project_id))
                                    .map(|m| (m.name.clone(), m.slug.clone()))
                            })
                            .unwrap_or_else(|| {
                                // Fallback: use project_id as both name and slug
                                // If it looks like a slug (has dashes or lowercase), use it
                                if project_id.contains('-')
                                    || project_id.chars().all(|c| {
                                        c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'
                                    })
                                {
                                    (project_id.clone(), project_id.clone())
                                } else {
                                    (format!("Mod [{}]", &project_id[..8.min(project_id.len())]), project_id.clone())
                                }
                            });

                        if let Err(e) = conn.execute(
                            "INSERT INTO mod_dependencies (mod_id, dependency_slug, dependency_type, version_requirement, dependency_name)
                             VALUES (?1, ?2, ?3, ?4, ?5)",
                            params![
                                mod_id,
                                &dep_slug, // Use SLUG for matching, not project_id!
                                &dep.dependency_type,
                                None::<String>,
                                &dep_name,
                            ],
                        ) {
                            log::warn!("Failed to INSERT dependency for mod_id={}: {} -> {} ({})", mod_id, slug, dep_slug, e);
                            errors.push(format!("Failed to save dependency: {}", e));
                        } else {
                            mod_deps_saved += 1;
                            deps_added += 1;
                        }
                    }
                }
            }
            if mod_deps_saved > 0 || new_deps.len() > 0 {
                log::debug!(
                    "Mod {} (id={}): {} deps found, {} saved to DB",
                    slug,
                    mod_id,
                    new_deps.len(),
                    mod_deps_saved
                );
            }
        }

        // Step 8: For mods not found on Modrinth, extract info from JAR files
        // This includes mod_id extraction and dependencies
        let enriched_sha1s: std::collections::HashSet<String> =
            modrinth_results.keys().cloned().collect();
        for (mod_id, file_name, sha1) in &file_hashes {
            if enriched_sha1s.contains(sha1) {
                continue; // Already enriched from Modrinth
            }

            let jar_path = mods_dir.join(file_name);
            if !jar_path.exists() {
                continue;
            }

            // Extract mod_id from JAR if not already set
            if let Ok(mod_data) = crate::code_editor::minecraft_data::JarParser::parse_mod_jar(&jar_path) {
                if let Some(info) = mod_data.mod_info {
                    // Update mod_id in database for better dependency matching
                    let _ = conn.execute(
                        "UPDATE mods SET mod_id = ?1 WHERE id = ?2 AND mod_id IS NULL",
                        params![&info.mod_id, mod_id],
                    );
                    log::debug!("Set mod_id='{}' for mod {}", info.mod_id, file_name);
                }
            }

            // Try to parse dependencies from the JAR file
            let jar_deps =
                crate::code_editor::minecraft_data::JarParser::extract_dependencies(&jar_path);

            // Store count before consuming jar_deps
            let jar_deps_count = jar_deps.len();

            // Even if no dependencies found, we still need to mark this mod as enriched
            // so it doesn't get re-checked every time
            if jar_deps.is_empty() {
                // Set enriched_file_hash to mark as processed (no deps)
                let _ = conn.execute(
                    "UPDATE mods SET enriched_file_hash = ?1 WHERE id = ?2",
                    params![sha1, mod_id],
                );
                log::debug!(
                    "Marked mod {} as enriched (no dependencies found in JAR)",
                    file_name
                );
                continue;
            }

            // Clear old dependencies for this mod
            let _ = conn.execute("DELETE FROM mod_dependencies WHERE mod_id = ?1", [mod_id]);

            // Save parsed dependencies with humanized names
            for dep in jar_deps {
                // Use humanize_mod_id for better dependency names
                let dep_name = Self::humanize_mod_id(&dep.dependency_id);

                if let Err(e) = conn.execute(
                    "INSERT INTO mod_dependencies (mod_id, dependency_slug, dependency_type, version_requirement, dependency_name)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        mod_id,
                        &dep.dependency_id,
                        &dep.dependency_type,
                        dep.version_requirement.as_ref(),
                        &dep_name,
                    ],
                ) {
                    errors.push(format!("Failed to save JAR dependency: {}", e));
                } else {
                    deps_added += 1;
                }
            }

            // Update enriched_file_hash for this JAR-parsed mod
            let _ = conn.execute(
                "UPDATE mods SET enriched_file_hash = ?1 WHERE id = ?2",
                params![sha1, mod_id],
            );

            log::debug!(
                "Enriched mod {} from JAR: {} dependencies added",
                file_name,
                jar_deps_count
            );
        }

        log::info!(
            "Incremental enrichment complete for {}: {} mods enriched, {} dependencies added ({} from Modrinth, {} from JAR parsing)",
            instance_id,
            enriched_count,
            deps_added,
            modrinth_results.len(),
            mods.len() - modrinth_results.len()
        );

        if !errors.is_empty() {
            log::warn!("Enrichment errors for {}: {:?}", instance_id, errors);
        }

        // Note: enriched_file_hash is now saved per-mod in the UPDATE statements above
        // No need to save instance-level hash anymore

        Ok(EnrichmentResult {
            total_mods: mods.len(),
            enriched_mods: enriched_count,
            dependencies_added: deps_added,
            errors,
        })
    }

    /// Force enrich dependencies - clears per-mod cache hashes and re-fetches from API
    pub async fn force_enrich_mod_dependencies(instance_id: &str) -> Result<EnrichmentResult> {
        // Clear per-mod enriched_file_hash and verified_file_hash for all mods in this instance
        {
            let conn = get_db_conn()?;
            conn.execute(
                "UPDATE mods SET enriched_file_hash = NULL, verified_file_hash = NULL WHERE instance_id = ?1",
                params![instance_id],
            )?;
        }

        log::info!(
            "Force enrichment requested for {}, per-mod enrichment + verification caches cleared",
            instance_id
        );

        // Now call regular enrichment which will run since all mod hashes are cleared
        Self::enrich_mod_dependencies(instance_id).await
    }

    /// Incremental verification: only verify specified mod IDs
    /// Used after sync to verify only newly added mods
    pub async fn verify_mods_by_ids(
        instance_id: &str,
        mod_ids: &[i64],
    ) -> Result<Vec<ModVerifyResult>> {
        use futures::future::join_all;

        if mod_ids.is_empty() {
            return Ok(Vec::new());
        }

        let mods_dir = instance_mods_dir(instance_id);
        if !mods_dir.exists() {
            return Ok(Vec::new());
        }

        // Get filenames for specified mod IDs
        let mod_files: Vec<(i64, String)> = {
            let conn = get_db_conn()?;
            let placeholders = mod_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let query = format!(
                "SELECT id, file_name FROM mods WHERE id IN ({}) AND instance_id = ?",
                placeholders
            );
            let mut stmt = conn.prepare(&query)?;

            // Build params: mod_ids + instance_id
            let mut params_vec: Vec<&dyn rusqlite::ToSql> = mod_ids
                .iter()
                .map(|id| id as &dyn rusqlite::ToSql)
                .collect();
            params_vec.push(&instance_id);

            let rows = stmt.query_map(rusqlite::params_from_iter(params_vec), |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })?;
            rows.filter_map(|r| r.ok()).collect()
        };

        if mod_files.is_empty() {
            return Ok(Vec::new());
        }

        // Build JAR paths
        let jar_files: Vec<PathBuf> = mod_files
            .iter()
            .filter_map(|(_, filename)| {
                let path = mods_dir.join(filename);
                if path.exists() && path.extension().map(|e| e == "jar").unwrap_or(false) {
                    Some(path)
                } else {
                    None
                }
            })
            .collect();

        if jar_files.is_empty() {
            return Ok(Vec::new());
        }

        // Calculate hashes
        let hash_futures = jar_files.iter().map(|path| {
            let path = path.clone();
            async move {
                let sha1 = tokio::task::spawn_blocking({
                    let p = path.clone();
                    move || calculate_sha1(&p).ok()
                })
                .await
                .ok()
                .flatten();

                let fingerprint = tokio::task::spawn_blocking({
                    let p = path.clone();
                    move || compute_cf_fingerprint(&p)
                })
                .await
                .ok()
                .flatten();

                (path, sha1, fingerprint)
            }
        });

        let file_hashes: Vec<(PathBuf, Option<String>, Option<u32>)> = join_all(hash_futures).await;

        // Batch Modrinth lookup
        let sha1_hashes: Vec<String> = file_hashes
            .iter()
            .filter_map(|(_, h, _)| h.clone())
            .collect();

        let modrinth_results = if !sha1_hashes.is_empty() {
            ModrinthClient::get_versions_by_hashes(&sha1_hashes, "sha1")
                .await
                .unwrap_or_default()
        } else {
            std::collections::HashMap::new()
        };

        // Build results
        let mut results = Vec::new();
        let conn = get_db_conn()?;
        let now = Utc::now().to_rfc3339();

        for (path, sha1, _fingerprint) in file_hashes {
            let file_name = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("unknown.jar")
                .to_string();

            if let Some(sha1_hash) = &sha1 {
                if let Some(version) = modrinth_results.get(sha1_hash) {
                    // DON'T update name here! version.name is the VERSION title like "1.6.9 Forge"
                    // Let enrichment handle name update with proper project.title from API
                    // Only update source, source_id, and version_number
                    let _ = conn.execute(
                        r#"UPDATE mods SET
                            source = 'modrinth',
                            source_id = ?1,
                            version = ?2,
                            updated_at = ?3
                        WHERE instance_id = ?4 AND file_name = ?5"#,
                        params![
                            &version.project_id,
                            &version.version_number,
                            &now,
                            instance_id,
                            &file_name,
                        ],
                    );

                    // For UI result, we don't have project.title here, return version.name
                    // but it won't be saved to DB (name comes from JAR or enrichment)
                    results.push(ModVerifyResult {
                        file_name,
                        verified: true,
                        platform: "modrinth".to_string(),
                        status: "verified".to_string(),
                        project_name: Some(version.name.clone()), // UI only, not saved to DB
                        project_id: Some(version.project_id.clone()),
                        version: Some(version.version_number.clone()),
                        icon_url: None, // Will be fetched in full verification
                    });
                    continue;
                }
            }

            // Not found by hash - check if mod has source info (might be modified)
            let db_mod: Option<(String, Option<String>)> = conn
                .query_row(
                    "SELECT source, source_id FROM mods WHERE instance_id = ?1 AND file_name = ?2",
                    params![instance_id, &file_name],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .ok();

            let (status, platform) = match db_mod {
                Some((source, Some(_source_id))) if source == "modrinth" || source == "curseforge" => {
                    ("modified".to_string(), source)
                }
                _ => ("unknown".to_string(), "local".to_string())
            };

            results.push(ModVerifyResult {
                file_name,
                verified: status == "verified",
                platform,
                status,
                project_name: None,
                project_id: None,
                icon_url: None,
                version: None,
            });
        }

        log::info!(
            "Incremental verify for {}: {} mods processed, {} verified",
            instance_id,
            results.len(),
            results.iter().filter(|r| r.verified).count()
        );

        Ok(results)
    }

    /// Incremental enrichment: only enrich specified mod IDs
    /// Used after sync to enrich only newly added mods
    pub async fn enrich_mods_by_ids(
        instance_id: &str,
        mod_ids: &[i64],
    ) -> Result<EnrichmentResult> {
        if mod_ids.is_empty() {
            return Ok(EnrichmentResult {
                total_mods: 0,
                enriched_mods: 0,
                dependencies_added: 0,
                errors: vec![],
            });
        }

        let mods_dir = instance_mods_dir(instance_id);

        // Get mod info for specified IDs (only fields we need)
        let mods: Vec<InstalledMod> = {
            let conn = get_db_conn()?;
            let placeholders = mod_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let query = format!(
                "SELECT id, instance_id, slug, mod_id, name, version, minecraft_version, source, source_id,
                 file_name, enabled, auto_update, icon_url, author, latest_version, latest_version_id,
                 update_available, update_checked_at
                 FROM mods WHERE id IN ({}) AND instance_id = ?",
                placeholders
            );
            let mut stmt = conn.prepare(&query)?;

            let mut params_vec: Vec<&dyn rusqlite::ToSql> = mod_ids
                .iter()
                .map(|id| id as &dyn rusqlite::ToSql)
                .collect();
            params_vec.push(&instance_id);

            let rows = stmt.query_map(rusqlite::params_from_iter(params_vec), |row| {
                Ok(InstalledMod {
                    id: row.get(0)?,
                    instance_id: row.get(1)?,
                    slug: row.get(2)?,
                    mod_id: row.get(3)?,
                    name: row.get(4)?,
                    version: row.get(5)?,
                    minecraft_version: row.get(6)?,
                    source: row.get(7)?,
                    source_id: row.get(8)?,
                    file_name: row.get(9)?,
                    enabled: row.get(10)?,
                    auto_update: row.get(11)?,
                    icon_url: row.get(12)?,
                    author: row.get(13)?,
                    latest_version: row.get(14)?,
                    latest_version_id: row.get(15)?,
                    update_available: row.get::<_, i32>(16)? != 0,
                    update_checked_at: row.get(17)?,
                })
            })?;
            rows.filter_map(|r| r.ok()).collect()
        };

        if mods.is_empty() {
            return Ok(EnrichmentResult {
                total_mods: 0,
                enriched_mods: 0,
                dependencies_added: 0,
                errors: vec!["No mods found for specified IDs".to_string()],
            });
        }

        // Calculate SHA1 hashes
        let mut file_hashes: Vec<(i64, String, String)> = Vec::new();
        for mod_item in &mods {
            let file_path = mods_dir.join(&mod_item.file_name);
            if file_path.exists() {
                if let Ok(sha1) = calculate_sha1(&file_path) {
                    file_hashes.push((mod_item.id, mod_item.file_name.clone(), sha1));
                }
            }
        }

        if file_hashes.is_empty() {
            return Ok(EnrichmentResult {
                total_mods: mods.len(),
                enriched_mods: 0,
                dependencies_added: 0,
                errors: vec!["No valid mod files found".to_string()],
            });
        }

        // Batch Modrinth lookup
        let sha1_list: Vec<String> = file_hashes.iter().map(|(_, _, h)| h.clone()).collect();
        let modrinth_results = ModrinthClient::get_versions_by_hashes(&sha1_list, "sha1")
            .await
            .unwrap_or_default();

        // Collect project IDs for name resolution
        let mut all_project_ids: Vec<String> = modrinth_results
            .values()
            .map(|v| v.project_id.clone())
            .collect();

        for version in modrinth_results.values() {
            for dep in &*version.dependencies {
                if let Some(ref pid) = dep.project_id {
                    if !all_project_ids.contains(pid) {
                        all_project_ids.push(pid.clone());
                    }
                }
            }
        }

        // Batch project info
        let projects = ModrinthClient::get_projects(&all_project_ids)
            .await
            .unwrap_or_default();

        let pid_to_info: std::collections::HashMap<String, (String, String, Option<String>)> =
            projects
                .iter()
                .map(|p| {
                    (
                        p.id.clone(),
                        (p.title.clone(), p.slug.clone(), p.icon_url.clone()),
                    )
                })
                .collect();

        let sha1_to_mod_id: std::collections::HashMap<String, i64> = file_hashes
            .iter()
            .map(|(id, _, sha1)| (sha1.clone(), *id))
            .collect();

        // Save dependencies
        let conn = get_db_conn()?;
        let now = Utc::now().to_rfc3339();
        let mut enriched_count = 0;
        let mut deps_added = 0;
        let mut errors: Vec<String> = Vec::new();

        for (sha1, version) in &modrinth_results {
            let mod_id = match sha1_to_mod_id.get(sha1) {
                Some(id) => *id,
                None => continue,
            };

            // Get project title from pid_to_info (fetched via batch get_projects)
            // NEVER use version.name - it's the VERSION title like "1.6.9 Forge (1.20.1)"!
            let (title, slug, icon_url): (String, String, Option<String>) =
                if let Some((t, s, i)) = pid_to_info.get(&version.project_id) {
                    (t.clone(), s.clone(), i.clone())
                } else {
                    // Project not in batch result - try individual API call
                    if let Ok(project) = ModrinthClient::get_project(&version.project_id).await {
                        log::debug!(
                            "Fetched missing project for incremental enrich: {} -> {}",
                            version.project_id,
                            project.title
                        );
                        (project.title, project.slug, project.icon_url)
                    } else {
                        // Last resort: derive from filename (find mod by id)
                        let filename = file_hashes
                            .iter()
                            .find(|(id, _, _)| *id == mod_id)
                            .map(|(_, f, _)| f.clone())
                            .unwrap_or_default();
                        let (slug_from_file, _) = parse_mod_filename(&filename);
                        let title_from_slug = slug_from_file
                            .replace('-', " ")
                            .replace('_', " ")
                            .split_whitespace()
                            .map(|w| {
                                let mut c = w.chars();
                                match c.next() {
                                    Some(first) => {
                                        first.to_uppercase().collect::<String>() + c.as_str()
                                    }
                                    None => String::new(),
                                }
                            })
                            .collect::<Vec<_>>()
                            .join(" ");
                        log::debug!(
                            "Derived name from filename for {}: {} -> {}",
                            version.project_id,
                            filename,
                            title_from_slug
                        );
                        (title_from_slug, slug_from_file, None)
                    }
                };

            if let Err(e) = conn.execute(
                r#"UPDATE mods SET
                    source = 'modrinth',
                    source_id = ?1,
                    slug = ?2,
                    name = ?3,
                    version = ?4,
                    file_hash = ?5,
                    icon_url = ?6,
                    updated_at = ?7
                WHERE id = ?8"#,
                params![
                    &version.project_id,
                    slug,
                    title,
                    &version.version_number,
                    sha1,
                    icon_url,
                    &now,
                    mod_id,
                ],
            ) {
                errors.push(format!("Failed to update mod {}: {}", mod_id, e));
                continue;
            }

            enriched_count += 1;

            // Clear old dependencies
            let _ = conn.execute("DELETE FROM mod_dependencies WHERE mod_id = ?1", [mod_id]);

            // Save new dependencies with SLUG (not project_id) for alias matching
            for dep in &*version.dependencies {
                if let Some(ref project_id) = dep.project_id {
                    if dep.dependency_type == "required"
                        || dep.dependency_type == "optional"
                        || dep.dependency_type == "incompatible"
                    {
                        // Get name AND slug from pid_to_info
                        let (dep_name, dep_slug) = pid_to_info
                            .get(project_id)
                            .map(|(name, slug, _)| (name.clone(), slug.clone()))
                            .unwrap_or_else(|| {
                                if project_id.contains('-')
                                    || project_id.chars().all(|c| {
                                        c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'
                                    })
                                {
                                    (project_id.clone(), project_id.clone())
                                } else {
                                    (format!("Mod [{}]", &project_id[..8.min(project_id.len())]), project_id.clone())
                                }
                            });

                        if let Err(e) = conn.execute(
                            "INSERT INTO mod_dependencies (mod_id, dependency_slug, dependency_type, version_requirement, dependency_name)
                             VALUES (?1, ?2, ?3, ?4, ?5)",
                            params![mod_id, &dep_slug, &dep.dependency_type, None::<String>, &dep_name],
                        ) {
                            errors.push(format!("Failed to save dependency: {}", e));
                        } else {
                            deps_added += 1;
                        }
                    }
                }
            }
        }

        log::info!(
            "Incremental enrich for {}: {} mods processed, {} enriched, {} deps added",
            instance_id,
            mods.len(),
            enriched_count,
            deps_added
        );

        Ok(EnrichmentResult {
            total_mods: mods.len(),
            enriched_mods: enriched_count,
            dependencies_added: deps_added,
            errors,
        })
    }
}

/// Result of mod data enrichment
#[derive(Debug, Clone, serde::Serialize)]
pub struct EnrichmentResult {
    pub total_mods: usize,
    pub enriched_mods: usize,
    pub dependencies_added: usize,
    pub errors: Vec<String>,
}

/// Result of parsing a mod file
struct ModParseResult {
    path: PathBuf,
    jar_info: Option<crate::code_editor::minecraft_data::ModData>,
    sha1: Option<String>,
    fingerprint: Option<u32>,
}

/// Compute CurseForge fingerprint (MurmurHash2)
fn compute_cf_fingerprint(path: &PathBuf) -> Option<u32> {
    use std::io::Read;

    let mut file = std::fs::File::open(path).ok()?;
    let mut data = Vec::new();
    file.read_to_end(&mut data).ok()?;

    // Normalize: remove whitespace characters (9, 10, 13, 32)
    let normalized: Vec<u8> = data
        .into_iter()
        .filter(|&b| b != 9 && b != 10 && b != 13 && b != 32)
        .collect();

    Some(murmur2_hash(&normalized, 1))
}

/// MurmurHash2 implementation
fn murmur2_hash(data: &[u8], seed: u32) -> u32 {
    const M: u32 = 0x5bd1e995;
    const R: i32 = 24;

    let len = data.len();
    let mut h = seed ^ (len as u32);
    let mut i = 0;

    while i + 4 <= len {
        let mut k = u32::from_le_bytes([data[i], data[i + 1], data[i + 2], data[i + 3]]);
        k = k.wrapping_mul(M);
        k ^= k >> R;
        k = k.wrapping_mul(M);
        h = h.wrapping_mul(M);
        h ^= k;
        i += 4;
    }

    match len - i {
        3 => {
            h ^= (data[i + 2] as u32) << 16;
            h ^= (data[i + 1] as u32) << 8;
            h ^= data[i] as u32;
            h = h.wrapping_mul(M);
        }
        2 => {
            h ^= (data[i + 1] as u32) << 8;
            h ^= data[i] as u32;
            h = h.wrapping_mul(M);
        }
        1 => {
            h ^= data[i] as u32;
            h = h.wrapping_mul(M);
        }
        _ => {}
    }

    h ^= h >> 13;
    h = h.wrapping_mul(M);
    h ^= h >> 15;

    h
}

/// Resolve mod metadata from JAR info, enriched with API source info
/// PRIORITY: JAR data for name/version, API only for source verification
fn resolve_mod_metadata(
    parsed: &ModParseResult,
    modrinth: &std::collections::HashMap<String, crate::api::modrinth::ModrinthVersion>,
    cf: &std::collections::HashMap<u32, crate::api::curseforge::FingerprintMatch>,
    file_name: &str,
) -> (
    String,  // slug
    String,  // name
    String,  // version
    String,  // source
    Option<String>, // source_id (version_id)
    Option<String>, // project_id
) {
    // STEP 1: Get name and version from JAR (authoritative source)
    let (jar_slug, jar_name, jar_version) = if let Some(jar_info) = &parsed.jar_info {
        if let Some(info) = &jar_info.mod_info {
            (info.mod_id.clone(), info.name.clone(), info.version.clone())
        } else {
            let slug = sanitize_filename(file_name);
            (slug.clone(), file_name.replace(".jar", ""), "unknown".to_string())
        }
    } else {
        let slug = sanitize_filename(file_name);
        (slug.clone(), file_name.replace(".jar", ""), "unknown".to_string())
    };

    // STEP 2: Check if verified on platforms (for source info, NOT name)
    // Modrinth
    if let Some(sha1) = &parsed.sha1 {
        if let Some(version) = modrinth.get(sha1) {
            return (
                jar_slug,      // Use JAR slug, not API
                jar_name,      // Use JAR name, NOT version.name!
                jar_version,   // Use JAR version
                "modrinth".to_string(),
                Some(version.id.clone()),        // version_id for API reference
                Some(version.project_id.clone()), // project_id for enrichment
            );
        }
    }

    // CurseForge
    if let Some(fp) = parsed.fingerprint {
        if let Some(cf_match) = cf.get(&fp) {
            return (
                jar_slug,      // Use JAR slug
                jar_name,      // Use JAR name
                jar_version,   // Use JAR version
                "curseforge".to_string(),
                Some(cf_match.file.id.to_string()),
                Some(cf_match.id.to_string()),
            );
        }
    }

    // Not found on any platform - local mod
    (
        jar_slug,
        jar_name,
        jar_version,
        "local".to_string(),
        None,
        None,
    )
}

/// Result of batch mod installation
#[derive(Debug, Clone, serde::Serialize)]
pub struct BatchModInstallResult {
    pub file_name: String,
    pub success: bool,
    pub mod_name: Option<String>,
    pub error: Option<String>,
    pub source: String,
    pub verified: bool,
}

/// Result of mod verification
#[derive(Debug, Clone, serde::Serialize)]
pub struct ModVerifyResult {
    pub file_name: String,
    pub verified: bool,
    pub platform: String,          // "modrinth", "curseforge", "local"
    pub status: String,            // "verified", "modified", "unknown"
    pub project_name: Option<String>,
    pub project_id: Option<String>,
    pub version: Option<String>,
    pub icon_url: Option<String>,
}

/// Progress event for verification/enrichment operations
#[derive(Debug, Clone, serde::Serialize)]
pub struct VerificationProgress {
    pub instance_id: String,
    pub stage: String,           // "hashing", "modrinth_lookup", "curseforge_lookup", "icons", "fallback_search", "saving"
    pub current: usize,
    pub total: usize,
    pub message: String,
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

/// Граф зависимостей для визуализации
#[derive(Debug, Clone, serde::Serialize)]
pub struct DependencyGraph {
    pub nodes: Vec<DependencyNode>,
    pub edges: Vec<DependencyEdge>,
}

/// Узел графа зависимостей (мод)
#[derive(Debug, Clone, serde::Serialize)]
pub struct DependencyNode {
    pub id: String,               // slug мода
    pub name: String,             // отображаемое имя
    pub enabled: bool,            // включён ли мод
    pub version: String,          // версия
    pub icon_url: Option<String>, // иконка
    pub source: String,           // modrinth/curseforge/local
    pub dependency_count: i32,    // сколько модов требует этот мод
    pub dependent_count: i32,     // сколько модов зависят от этого
    pub is_library: bool,         // является ли библиотечным модом
}

/// Ребро графа зависимостей
#[derive(Debug, Clone, serde::Serialize)]
pub struct DependencyEdge {
    pub from: String,                        // slug мода-источника
    pub from_name: String,                   // человекочитаемое имя мода-источника
    pub to: String,                          // slug зависимости (или project_id если не установлен)
    pub to_name: String,                     // человекочитаемое имя зависимости
    pub dependency_type: String,             // required/optional/incompatible
    pub version_requirement: Option<String>, // требуемая версия
    pub is_satisfied: bool,                  // удовлетворена ли зависимость
    pub is_problem: bool,                    // есть ли проблема
}

/// Результат анализа безопасности удаления мода
#[derive(Debug, Clone, serde::Serialize)]
pub struct ModRemovalAnalysis {
    pub mod_slug: String,
    pub is_safe: bool,
    pub affected_mods: Vec<AffectedMod>, // моды которые сломаются
    pub warning_mods: Vec<AffectedMod>,  // моды которые потеряют функции
    pub total_affected: usize,
    pub recommendation: String, // safe_to_remove/review_before_removing/not_recommended
}

/// Мод, затронутый удалением
#[derive(Debug, Clone, serde::Serialize)]
pub struct AffectedMod {
    pub slug: String,
    pub name: String,
    pub impact: String, // will_break/may_lose_features
    pub reason: String,
}

// ============================================================================
// Pre-Launch Dependency Check
// ============================================================================

/// Результат проверки зависимостей перед запуском
#[derive(Debug, Clone, serde::Serialize)]
pub struct PreLaunchCheckResult {
    /// Можно ли безопасно запускать экземпляр
    pub can_launch: bool,
    /// Отсутствующие обязательные зависимости
    pub missing_dependencies: Vec<MissingDependency>,
    /// Предупреждения (необязательные зависимости, версии)
    pub warnings: Vec<DependencyWarning>,
    /// Общее количество проблем
    pub total_issues: usize,
}

/// Отсутствующая зависимость
#[derive(Debug, Clone, serde::Serialize)]
pub struct MissingDependency {
    /// Slug мода который требует зависимость
    pub required_by_slug: String,
    /// Имя мода который требует зависимость
    pub required_by_name: String,
    /// Slug/ID отсутствующей зависимости
    pub dependency_slug: String,
    /// Человекочитаемое имя зависимости
    pub dependency_name: String,
    /// Источник для установки (modrinth/curseforge)
    pub source: Option<String>,
    /// Project ID для автоматической установки
    pub project_id: Option<String>,
    /// Требуемая версия (если известна)
    pub version_requirement: Option<String>,
}

/// Предупреждение о зависимости (не блокирует запуск)
#[derive(Debug, Clone, serde::Serialize)]
pub struct DependencyWarning {
    /// Тип предупреждения
    pub warning_type: String, // "optional_missing", "version_mismatch", "disabled_dependency"
    /// Описание проблемы
    pub message: String,
    /// Связанный мод
    pub mod_slug: Option<String>,
    /// Связанная зависимость
    pub dependency_slug: Option<String>,
}

// ============================================================================
// Update Checking
// ============================================================================

/// Result of checking updates for an instance
#[derive(Debug, Clone, serde::Serialize)]
pub struct UpdateCheckResult {
    pub total_checked: usize,
    pub updates_available: usize,
    pub skipped: usize,        // local mods without source
    pub errors: usize,
    pub mods_with_updates: Vec<ModUpdateInfo>,
}

/// Info about an available update for a mod
#[derive(Debug, Clone, serde::Serialize)]
pub struct ModUpdateInfo {
    pub mod_id: i64,
    pub slug: String,
    pub name: String,
    pub current_version: String,
    pub latest_version: String,
    pub latest_version_id: String,
    pub source: String, // modrinth/curseforge
}

// ============================================================================
// File Watcher for Mods Folder
// ============================================================================

/// Event emitted when mods folder changes
#[derive(Debug, Clone, serde::Serialize)]
pub struct ModsFolderChange {
    pub instance_id: String,
    pub event_type: String, // "added", "removed", "modified"
    pub file_name: String,
    pub file_path: String,
}

/// Global mods watcher state
static MODS_WATCHERS: std::sync::LazyLock<Arc<RwLock<HashMap<String, WatcherHandle>>>> =
    std::sync::LazyLock::new(|| Arc::new(RwLock::new(HashMap::new())));

/// Handle for a running watcher
struct WatcherHandle {
    #[allow(dead_code)]
    watcher: RecommendedWatcher,
    stop_tx: mpsc::Sender<()>,
}

impl ModManager {
    /// Start watching mods folder for an instance
    /// Emits "mods_folder_changed" event when files change
    pub async fn start_watching(instance_id: &str, app_handle: tauri::AppHandle) -> Result<()> {
        let mods_dir = instance_mods_dir(instance_id);

        if !mods_dir.exists() {
            return Err(LauncherError::NotFound(format!(
                "Mods directory not found: {}",
                mods_dir.display()
            )));
        }

        // Stop existing watcher if any
        Self::stop_watching(instance_id).await?;

        let instance_id_clone = instance_id.to_string();
        let (event_tx, mut event_rx) = mpsc::channel::<Event>(100);
        let (stop_tx, mut stop_rx) = mpsc::channel::<()>(1);

        // Create notify watcher
        let watcher = {
            let tx = event_tx.clone();
            notify::recommended_watcher(move |res: std::result::Result<Event, notify::Error>| {
                if let Ok(event) = res {
                    let _ = tx.blocking_send(event);
                }
            })
            .map_err(|e| {
                LauncherError::Io(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("Failed to create watcher: {}", e),
                ))
            })?
        };

        // Start watching
        let mut watcher = watcher;
        watcher
            .configure(Config::default().with_poll_interval(std::time::Duration::from_secs(2)))
            .map_err(|e| {
                LauncherError::Io(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("Failed to configure watcher: {}", e),
                ))
            })?;

        watcher
            .watch(&mods_dir, RecursiveMode::NonRecursive)
            .map_err(|e| {
                LauncherError::Io(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("Failed to watch directory: {}", e),
                ))
            })?;

        // Store watcher handle
        {
            let mut watchers = MODS_WATCHERS.write().await;
            watchers.insert(instance_id.to_string(), WatcherHandle { watcher, stop_tx });
        }

        // Spawn event processing task
        let app_handle_clone = app_handle.clone();
        let instance_id_for_task = instance_id_clone.clone();

        tokio::spawn(async move {
            let mut debounce_timer: Option<tokio::time::Instant> = None;
            let debounce_duration = std::time::Duration::from_millis(500);
            let mut pending_events: Vec<ModsFolderChange> = Vec::new();

            loop {
                tokio::select! {
                    // Check for stop signal
                    _ = stop_rx.recv() => {
                        break;
                    }
                    // Process file events
                    event = event_rx.recv() => {
                        if let Some(event) = event {
                            // Convert notify event to our event type
                            if let Some(change) = Self::convert_event(&instance_id_for_task, &event) {
                                pending_events.push(change);
                                debounce_timer = Some(tokio::time::Instant::now());
                            }
                        } else {
                            break; // Channel closed
                        }
                    }
                    // Debounce timer
                    _ = async {
                        if let Some(timer) = debounce_timer {
                            tokio::time::sleep_until(timer + debounce_duration).await;
                        } else {
                            // No timer set, wait forever (select will pick another branch)
                            std::future::pending::<()>().await;
                        }
                    } => {
                        if !pending_events.is_empty() {
                            // Deduplicate events by file path
                            let mut unique_events: HashMap<String, ModsFolderChange> = HashMap::new();
                            for event in pending_events.drain(..) {
                                unique_events.insert(event.file_path.clone(), event);
                            }

                            // Emit events
                            for (_, change) in unique_events {
                                let _ = app_handle_clone.emit("mods_folder_changed", &change);
                            }

                            // Also trigger a sync
                            if let Err(e) = ModManager::sync_mods_with_folder(&instance_id_for_task).await {
                                log::warn!("Failed to sync mods folder: {}", e);
                            }
                        }
                        debounce_timer = None;
                    }
                }
            }
        });

        log::info!("Started watching mods folder for instance {}", instance_id);
        Ok(())
    }

    /// Stop watching mods folder for an instance
    pub async fn stop_watching(instance_id: &str) -> Result<()> {
        let mut watchers = MODS_WATCHERS.write().await;
        if let Some(handle) = watchers.remove(instance_id) {
            let _ = handle.stop_tx.send(()).await;
            log::info!("Stopped watching mods folder for instance {}", instance_id);
        }
        Ok(())
    }

    /// Stop all watchers
    pub async fn stop_all_watchers() -> Result<()> {
        let mut watchers = MODS_WATCHERS.write().await;
        for (id, handle) in watchers.drain() {
            let _ = handle.stop_tx.send(()).await;
            log::info!("Stopped watching mods folder for instance {}", id);
        }
        Ok(())
    }

    /// Check if watching is active for an instance
    pub async fn is_watching(instance_id: &str) -> bool {
        let watchers = MODS_WATCHERS.read().await;
        watchers.contains_key(instance_id)
    }

    /// Convert notify event to our change type
    fn convert_event(instance_id: &str, event: &Event) -> Option<ModsFolderChange> {
        // Only care about .jar files
        let path = event.paths.first()?;
        let file_name = path.file_name()?.to_string_lossy().to_string();

        if !file_name.ends_with(".jar") && !file_name.ends_with(".jar.disabled") {
            return None;
        }

        let event_type = match &event.kind {
            EventKind::Create(_) => "added",
            EventKind::Remove(_) => "removed",
            EventKind::Modify(_) => "modified",
            _ => return None,
        };

        Some(ModsFolderChange {
            instance_id: instance_id.to_string(),
            event_type: event_type.to_string(),
            file_name,
            file_path: path.to_string_lossy().to_string(),
        })
    }
}
