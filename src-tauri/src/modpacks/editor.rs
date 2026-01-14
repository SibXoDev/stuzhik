use crate::downloader::{fetch_json, DownloadManager};
use crate::error::{LauncherError, Result};
use crate::paths;
use std::io::Read;
use std::path::{Path, PathBuf};

use super::types::{
    ConfigDiff, ConfigInfo, CurseForgeManifest, ModInfo, ModSearchInfo, ModVersionDiff,
    ModpackComparison, ModpackFilePreview, ModrinthModpackIndex,
};
use super::ModpackManager;

const MODRINTH_API_BASE: &str = "https://api.modrinth.com/v2";

// ========== Helper Functions ==========

/// Парсит имя мода и версию из filename
/// Нормализует название мода для точного сравнения
/// Убирает версии MC, лоадеры, и извлекает "чистое" имя мода
fn parse_mod_filename(filename: &str) -> (String, Option<String>) {
    let name_without_ext = filename
        .trim_end_matches(".jar")
        .trim_end_matches(".disabled")
        .trim_end_matches(".jar");

    let lower = name_without_ext.to_lowercase();

    // Список известных лоадеров и их вариаций для удаления
    let loader_patterns = [
        "-forge",
        "_forge",
        "+forge",
        ".forge",
        "-fabric",
        "_fabric",
        "+fabric",
        ".fabric",
        "-neoforge",
        "_neoforge",
        "+neoforge",
        "-quilt",
        "_quilt",
        "+quilt",
    ];

    let mut cleaned = name_without_ext.to_string();
    let mut lower_cleaned = lower.clone();

    // Удаляем лоадеры
    for pattern in loader_patterns.iter() {
        if let Some(idx) = lower_cleaned.find(pattern) {
            let end = idx + pattern.len();
            let after = &cleaned[end..];
            let next_sep = after
                .find(|c: char| c == '-' || c == '_' || c == '+')
                .map(|i| end + i)
                .unwrap_or(end);
            cleaned = format!("{}{}", &cleaned[..idx], &cleaned[next_sep..]);
            lower_cleaned = cleaned.to_lowercase();
        }
    }

    // Удаляем версии Minecraft (паттерны типа 1.20.1, 1.20, mc1.20.1)
    cleaned = remove_mc_version(&cleaned);

    // Чистим множественные разделители и разделители в начале/конце
    let cleaned = cleaned
        .replace("--", "-")
        .replace("__", "_")
        .replace("-_", "-")
        .replace("_-", "-")
        .trim_matches(|c| c == '-' || c == '_' || c == '+' || c == '.')
        .to_string();

    // Теперь разделяем имя и версию мода
    let parts: Vec<&str> = cleaned.split(|c| c == '-' || c == '_').collect();

    if parts.len() >= 2 {
        let mut name_parts = Vec::new();
        let mut version_start_idx = None;

        for (i, part) in parts.iter().enumerate() {
            let is_version = part
                .chars()
                .next()
                .map(|c| {
                    c.is_ascii_digit()
                        || (c == 'v'
                            && part.len() > 1
                            && part.chars().nth(1).is_some_and(|c2| c2.is_ascii_digit()))
                })
                .unwrap_or(false);

            if is_version && version_start_idx.is_none() {
                version_start_idx = Some(i);
                break;
            }
            name_parts.push(*part);
        }

        let name = if name_parts.is_empty() {
            parts[0].to_lowercase()
        } else {
            name_parts.join("-").to_lowercase()
        };

        let version = version_start_idx.map(|idx| parts[idx..].join("-"));
        (name, version)
    } else {
        (cleaned.to_lowercase(), None)
    }
}

/// Удаляет версии Minecraft из строки (1.20.1, mc1.20, etc)
fn remove_mc_version(input: &str) -> String {
    let mut result = input.to_string();
    let lower = input.to_lowercase();

    // Ищем паттерны типа -1.20.1, +mc1.20, _1.20.4 и т.д.
    let mut i = 0;
    while i < result.len() {
        let remaining = &lower[i..];

        // Проверяем начало MC-версии
        let mc_start = if remaining.starts_with("-mc")
            || remaining.starts_with("+mc")
            || remaining.starts_with("_mc")
            || remaining.starts_with(".mc")
        {
            Some(i + 3)
        } else if remaining.starts_with("-1.")
            || remaining.starts_with("+1.")
            || remaining.starts_with("_1.")
            || remaining.starts_with(".1.")
        {
            Some(i + 1)
        } else if remaining.starts_with("mc1.") {
            Some(i + 2)
        } else {
            None
        };

        if let Some(ver_start) = mc_start {
            // Ищем конец версии (числа и точки)
            let ver_slice = &result[ver_start..];
            let ver_end = ver_slice
                .find(|c: char| !c.is_ascii_digit() && c != '.')
                .unwrap_or(ver_slice.len());

            // Проверяем что это похоже на версию MC (1.X или 1.X.X)
            let potential_ver = &ver_slice[..ver_end];
            if potential_ver.starts_with("1.") && potential_ver.len() >= 3 {
                result = format!("{}{}", &result[..i], &result[ver_start + ver_end..]);
                continue; // Проверяем эту позицию снова
            }
        }
        i += 1;
    }

    result
}

/// Вычисляет быстрый хеш для сравнения
#[inline]
fn quick_hash(data: &[u8]) -> String {
    use sha1::{Digest, Sha1};
    let mut hasher = Sha1::new();
    hasher.update(data);
    let result = hasher.finalize();
    result
        .iter()
        .take(8)
        .map(|b| format!("{:02x}", b))
        .collect()
}

/// Вычисляет SHA1 хеш файла
fn calculate_file_sha1(path: &Path) -> Option<String> {
    use sha1::{Digest, Sha1};
    let mut file = std::fs::File::open(path).ok()?;
    let mut hasher = Sha1::new();
    let mut buffer = [0u8; 8192];
    loop {
        let bytes_read = std::io::Read::read(&mut file, &mut buffer).ok()?;
        if bytes_read == 0 {
            break;
        }
        hasher.update(&buffer[..bytes_read]);
    }
    Some(format!("{:x}", hasher.finalize()))
}

/// Сканирует директорию модов
fn scan_mods_dir(mods_dir: &Path) -> Result<Vec<ModInfo>> {
    scan_mods_dir_with_hash(mods_dir, true)
}

/// Сканирует директорию модов с опциональным вычислением хеша
fn scan_mods_dir_with_hash(mods_dir: &Path, compute_hash: bool) -> Result<Vec<ModInfo>> {
    let mut mods = Vec::new();

    if !mods_dir.exists() {
        return Ok(mods);
    }

    for entry in std::fs::read_dir(mods_dir)? {
        let entry = entry?;
        let path = entry.path();

        if path.is_file() {
            let filename = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();

            if filename.ends_with(".jar") || filename.ends_with(".jar.disabled") {
                let (name, version) = parse_mod_filename(&filename);
                let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                let hash = if compute_hash {
                    calculate_file_sha1(&path)
                } else {
                    None
                };

                mods.push(ModInfo {
                    filename,
                    name,
                    version,
                    size,
                    hash,
                });
            }
        }
    }

    Ok(mods)
}

/// Сканирует директорию config
fn scan_config_dir(config_dir: &Path) -> Result<Vec<ConfigInfo>> {
    let mut configs = Vec::new();

    if !config_dir.exists() {
        return Ok(configs);
    }

    fn scan_recursive(dir: &Path, base: &Path, configs: &mut Vec<ConfigInfo>) -> Result<()> {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();

            if path.is_dir() {
                scan_recursive(&path, base, configs)?;
            } else if path.is_file() {
                let relative = path.strip_prefix(base).unwrap_or(&path);
                let content = std::fs::read(&path).unwrap_or_default();
                let hash = quick_hash(&content);

                configs.push(ConfigInfo {
                    path: relative.to_string_lossy().to_string(),
                    size: content.len() as u64,
                    hash,
                });
            }
        }
        Ok(())
    }

    scan_recursive(config_dir, config_dir, &mut configs)?;
    Ok(configs)
}

/// Сканирует другие директории (resourcepacks, shaderpacks, scripts)
fn scan_other_dirs(instance_dir: &Path) -> Vec<String> {
    let mut files = Vec::new();
    // defaultconfigs теперь сканируется как часть конфигов
    let dirs_to_scan = ["resourcepacks", "shaderpacks", "scripts", "kubejs"];

    for dir_name in dirs_to_scan {
        let dir = instance_dir.join(dir_name);
        if dir.exists() && dir.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

                    if !name.starts_with('.') {
                        files.push(format!("{}/{}", dir_name, name));
                    }
                }
            }
        }
    }

    files
}

/// Сканирует все конфиги включая defaultconfigs
fn scan_all_configs(base_dir: &Path) -> Result<Vec<ConfigInfo>> {
    let mut configs = Vec::new();

    // Сканируем config
    let config_dir = base_dir.join("config");
    if config_dir.exists() {
        scan_config_recursive(&config_dir, &config_dir, "config", &mut configs)?;
    }

    // Сканируем defaultconfigs
    let default_config_dir = base_dir.join("defaultconfigs");
    if default_config_dir.exists() {
        scan_config_recursive(
            &default_config_dir,
            &default_config_dir,
            "defaultconfigs",
            &mut configs,
        )?;
    }

    Ok(configs)
}

fn scan_config_recursive(
    dir: &Path,
    base: &Path,
    prefix: &str,
    configs: &mut Vec<ConfigInfo>,
) -> Result<()> {
    if !dir.exists() {
        return Ok(());
    }

    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();

        if path.is_dir() {
            scan_config_recursive(&path, base, prefix, configs)?;
        } else if path.is_file() {
            let relative = path.strip_prefix(base).unwrap_or(&path);
            let content = std::fs::read(&path).unwrap_or_default();
            let hash = quick_hash(&content);

            configs.push(ConfigInfo {
                path: format!("{}/{}", prefix, relative.to_string_lossy()),
                size: content.len() as u64,
                hash,
            });
        }
    }
    Ok(())
}

/// Извлекает содержимое модпака из архива во временную директорию
fn extract_modpack_to_temp(file_path: &Path) -> Result<PathBuf> {
    let temp_dir = std::env::temp_dir().join(format!("modpack_compare_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp_dir)?;

    let file = std::fs::File::open(file_path)?;
    let mut archive = zip::ZipArchive::new(file)?;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i)?;
        let outpath = temp_dir.join(file.mangled_name());

        if file.is_dir() {
            std::fs::create_dir_all(&outpath)?;
        } else {
            if let Some(parent) = outpath.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut outfile = std::fs::File::create(&outpath)?;
            std::io::copy(&mut file, &mut outfile)?;
        }
    }

    Ok(temp_dir)
}

/// Находит директорию с модами внутри распакованного модпака
fn find_mods_in_extracted(extracted_dir: &Path) -> PathBuf {
    // CurseForge: overrides/mods
    let cf_mods = extracted_dir.join("overrides").join("mods");
    if cf_mods.exists() {
        return cf_mods;
    }

    // Modrinth: mods или overrides/mods
    let mr_mods = extracted_dir.join("mods");
    if mr_mods.exists() {
        return mr_mods;
    }

    // Проверяем client-overrides для Modrinth
    let mr_client_mods = extracted_dir.join("client-overrides").join("mods");
    if mr_client_mods.exists() {
        return mr_client_mods;
    }

    extracted_dir.join("mods")
}

/// Находит директорию config
/// Сканирует конфиги в извлечённом архиве (config + defaultconfigs)
fn scan_configs_in_extracted(extracted_dir: &Path) -> Result<Vec<ConfigInfo>> {
    let mut configs = Vec::new();

    // Для CurseForge формата (overrides/)
    let cf_base = extracted_dir.join("overrides");
    if cf_base.exists() {
        let cf_config = cf_base.join("config");
        if cf_config.exists() {
            scan_config_recursive(&cf_config, &cf_config, "config", &mut configs)?;
        }
        let cf_default = cf_base.join("defaultconfigs");
        if cf_default.exists() {
            scan_config_recursive(&cf_default, &cf_default, "defaultconfigs", &mut configs)?;
        }
    }

    // Для Modrinth формата (прямо в архиве)
    let mr_config = extracted_dir.join("config");
    if mr_config.exists() && configs.is_empty() {
        scan_config_recursive(&mr_config, &mr_config, "config", &mut configs)?;
    }
    let mr_default = extracted_dir.join("defaultconfigs");
    if mr_default.exists() {
        scan_config_recursive(&mr_default, &mr_default, "defaultconfigs", &mut configs)?;
    }

    Ok(configs)
}

// ========== ModpackManager Implementation ==========

impl ModpackManager {
    /// Count mods in overrides/mods folder of an archive
    fn count_overrides_mods(archive: &mut zip::ZipArchive<std::fs::File>) -> usize {
        let mut count = 0;
        for i in 0..archive.len() {
            if let Ok(entry) = archive.by_index(i) {
                let name = entry.name().to_lowercase();
                // Check for mods in overrides/mods/ folder (both forward and back slashes)
                if (name.starts_with("overrides/mods/") || name.starts_with("overrides\\mods\\"))
                    && !name.ends_with('/')
                    && (name.ends_with(".jar") || name.ends_with(".jar.disabled"))
                {
                    count += 1;
                }
            }
        }
        count
    }

    /// Предпросмотр модпака из файла без установки
    pub async fn preview_file(file_path: &std::path::Path) -> Result<ModpackFilePreview> {
        // Check for STZHK format by extension
        if let Some(ext) = file_path.extension() {
            if ext.to_str().map(|s| s.to_lowercase()) == Some("stzhk".to_string()) {
                let stzhk_preview = crate::stzhk::StzhkManager::preview(file_path).await?;
                let manifest = &stzhk_preview.manifest;
                return Ok(ModpackFilePreview {
                    name: manifest.modpack.name.clone(),
                    version: manifest.modpack.version.clone(),
                    minecraft_version: manifest.requirements.minecraft_version.clone(),
                    loader: manifest.requirements.loader.clone(),
                    loader_version: manifest.requirements.loader_version.clone(),
                    mod_count: manifest.mods.len(),
                    overrides_mods_count: stzhk_preview.overrides_mods_count as usize,
                    format: "stzhk".to_string(),
                    summary: manifest.modpack.description.clone(),
                });
            }
        }

        // ИСПРАВЛЕНО: Используем spawn_blocking для sync-only zip библиотеки
        let file_path = file_path.to_path_buf();
        tokio::task::spawn_blocking(move || Self::preview_file_sync(&file_path))
            .await
            .map_err(|e| LauncherError::Join(e.to_string()))?
    }

    /// Синхронная версия preview_file для использования в spawn_blocking
    fn preview_file_sync(file_path: &std::path::Path) -> Result<ModpackFilePreview> {
        // Try to read Modrinth index (using .ok() to avoid early return while borrow is active)
        let modrinth_contents: Option<String> = std::fs::File::open(file_path)
            .ok()
            .and_then(|file| zip::ZipArchive::new(file).ok())
            .and_then(|mut archive| {
                archive
                    .by_name("modrinth.index.json")
                    .ok()
                    .and_then(|mut index_file| {
                        let mut contents = String::new();
                        index_file
                            .read_to_string(&mut contents)
                            .ok()
                            .map(|_| contents)
                    })
            });

        // Process Modrinth format
        if let Some(contents) = modrinth_contents {
            let index: ModrinthModpackIndex = serde_json::from_str(&contents)?;

            let (loader, loader_version) = if let Some(v) = &index.dependencies.fabric_loader {
                ("Fabric".to_string(), Some(v.clone()))
            } else if let Some(v) = &index.dependencies.quilt_loader {
                ("Quilt".to_string(), Some(v.clone()))
            } else if let Some(v) = &index.dependencies.forge {
                ("Forge".to_string(), Some(v.clone()))
            } else if let Some(v) = &index.dependencies.neoforge {
                ("NeoForge".to_string(), Some(v.clone()))
            } else {
                ("Vanilla".to_string(), None)
            };

            let mod_count = index
                .files
                .iter()
                .filter(|f| f.path.starts_with("mods/"))
                .count();

            // Open fresh archive to count overrides mods
            let file = std::fs::File::open(file_path)?;
            let mut archive_for_overrides = zip::ZipArchive::new(file)?;
            let overrides_mods_count = Self::count_overrides_mods(&mut archive_for_overrides);

            return Ok(ModpackFilePreview {
                name: index.name,
                version: index.version_id,
                minecraft_version: index.dependencies.minecraft,
                loader,
                loader_version,
                mod_count,
                overrides_mods_count,
                format: "modrinth".to_string(),
                summary: index.summary,
            });
        }

        // Try to read CurseForge manifest (using .ok() to avoid early return while borrow is active)
        let curseforge_contents: Option<String> = std::fs::File::open(file_path)
            .ok()
            .and_then(|file| zip::ZipArchive::new(file).ok())
            .and_then(|mut archive| {
                archive
                    .by_name("manifest.json")
                    .ok()
                    .and_then(|mut manifest_file| {
                        let mut contents = String::new();
                        manifest_file
                            .read_to_string(&mut contents)
                            .ok()
                            .map(|_| contents)
                    })
            });

        // Process CurseForge format
        if let Some(contents) = curseforge_contents {
            let manifest: CurseForgeManifest = serde_json::from_str(&contents)?;

            let (loader, loader_version) =
                if let Some(mod_loader) = manifest.minecraft.mod_loaders.first() {
                    let id = &mod_loader.id;
                    if id.starts_with("forge-") {
                        (
                            "Forge".to_string(),
                            Some(id.strip_prefix("forge-").unwrap_or(id).to_string()),
                        )
                    } else if id.starts_with("fabric-") {
                        (
                            "Fabric".to_string(),
                            Some(id.strip_prefix("fabric-").unwrap_or(id).to_string()),
                        )
                    } else if id.starts_with("neoforge-") {
                        (
                            "NeoForge".to_string(),
                            Some(id.strip_prefix("neoforge-").unwrap_or(id).to_string()),
                        )
                    } else if id.starts_with("quilt-") {
                        (
                            "Quilt".to_string(),
                            Some(id.strip_prefix("quilt-").unwrap_or(id).to_string()),
                        )
                    } else {
                        ("Vanilla".to_string(), None)
                    }
                } else {
                    ("Vanilla".to_string(), None)
                };

            // Open fresh archive to count overrides mods
            let file = std::fs::File::open(file_path)?;
            let mut archive_for_overrides = zip::ZipArchive::new(file)?;
            let overrides_mods_count = Self::count_overrides_mods(&mut archive_for_overrides);

            return Ok(ModpackFilePreview {
                name: manifest.name.clone(),
                version: manifest.version,
                minecraft_version: manifest.minecraft.version,
                loader,
                loader_version,
                mod_count: manifest.files.len(),
                overrides_mods_count,
                format: "curseforge".to_string(),
                summary: manifest.author.map(|a| format!("by {}", a)),
            });
        }

        Err(LauncherError::InvalidConfig(
            "Unknown modpack format".to_string(),
        ))
    }

    /// Поиск мода по имени на платформе
    pub async fn search_mod_by_name(
        name: &str,
        source: &str,
        minecraft_version: Option<&str>,
        loader: Option<&str>,
    ) -> Result<Vec<ModSearchInfo>> {
        match source {
            "modrinth" => Self::search_mod_modrinth(name, minecraft_version, loader).await,
            "curseforge" => Self::search_mod_curseforge(name, minecraft_version, loader).await,
            _ => Err(LauncherError::InvalidConfig(format!(
                "Unknown source: {}",
                source
            ))),
        }
    }

    async fn search_mod_modrinth(
        name: &str,
        minecraft_version: Option<&str>,
        loader: Option<&str>,
    ) -> Result<Vec<ModSearchInfo>> {
        let mut url = format!(
            "{}/search?query={}&limit=5&facets=[[\"project_type:mod\"]",
            MODRINTH_API_BASE,
            urlencoding::encode(name)
        );

        if let Some(mc_ver) = minecraft_version {
            url.push_str(&format!(",[\"versions:{}\"]", mc_ver));
        }
        if let Some(ldr) = loader {
            url.push_str(&format!(",[\"categories:{}\"]", ldr));
        }
        url.push(']');

        let response: serde_json::Value = fetch_json(&url).await?;
        let hits = response
            .get("hits")
            .and_then(|h| h.as_array())
            .cloned()
            .unwrap_or_default();

        let mut results = Vec::new();
        for hit in hits.into_iter().take(5) {
            let project_id = hit
                .get("project_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let slug = hit
                .get("slug")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let title = hit
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let icon_url = hit
                .get("icon_url")
                .and_then(|v| v.as_str())
                .map(String::from);

            // Получаем версии для этого мода
            let mut versions_url = format!(
                "{}/project/{}/version?limit=1",
                MODRINTH_API_BASE, project_id
            );
            if let Some(mc_ver) = minecraft_version {
                versions_url = format!("{}&game_versions=[\"{}\"]", versions_url, mc_ver);
            }

            let version_info =
                if let Ok(versions) = fetch_json::<Vec<serde_json::Value>>(&versions_url).await {
                    versions.first().map(|v| {
                        let version_id = v.get("id").and_then(|i| i.as_str()).map(String::from);
                        let version_number = v
                            .get("version_number")
                            .and_then(|n| n.as_str())
                            .map(String::from);
                        let files = v.get("files").and_then(|f| f.as_array());
                        let primary_file = files.and_then(|f| {
                            f.iter()
                                .find(|file| {
                                    file.get("primary")
                                        .and_then(|p| p.as_bool())
                                        .unwrap_or(false)
                                })
                                .or_else(|| f.first())
                        });

                        let download_url = primary_file
                            .and_then(|f| f.get("url"))
                            .and_then(|u| u.as_str())
                            .map(String::from);
                        let file_name = primary_file
                            .and_then(|f| f.get("filename"))
                            .and_then(|n| n.as_str())
                            .map(String::from);
                        let file_size = primary_file
                            .and_then(|f| f.get("size"))
                            .and_then(|s| s.as_u64())
                            .unwrap_or(0);

                        (
                            version_id,
                            version_number,
                            download_url,
                            file_name,
                            file_size,
                        )
                    })
                } else {
                    None
                };

            let (version_id, version, download_url, file_name, file_size) =
                version_info.unwrap_or((None, None, None, None, 0));

            results.push(ModSearchInfo {
                project_id,
                slug,
                name: title,
                version,
                version_id,
                download_url,
                file_name,
                file_size,
                source: "modrinth".to_string(),
                icon_url,
            });
        }

        Ok(results)
    }

    async fn search_mod_curseforge(
        name: &str,
        minecraft_version: Option<&str>,
        loader: Option<&str>,
    ) -> Result<Vec<ModSearchInfo>> {
        let mut url = format!(
            "https://api.curseforge.com/v1/mods/search?gameId=432&classId=6&searchFilter={}&pageSize=5",
            urlencoding::encode(name)
        );

        if let Some(mc_ver) = minecraft_version {
            url.push_str(&format!("&gameVersion={}", mc_ver));
        }
        if let Some(ldr) = loader {
            let loader_id = match ldr.to_lowercase().as_str() {
                "forge" => 1,
                "fabric" => 4,
                "quilt" => 5,
                "neoforge" => 6,
                _ => 0,
            };
            if loader_id > 0 {
                url.push_str(&format!("&modLoaderType={}", loader_id));
            }
        }

        let http_client = reqwest::Client::builder()
            .user_agent(crate::USER_AGENT)
            .default_headers({
                let mut headers = reqwest::header::HeaderMap::new();
                headers.insert(
                    "x-api-key",
                    "$2a$10$bL4bIL5pUWqfcO7KQtnMReakwtfHbNKh6v1uTpKlzhwoueEJQnPnm"
                        .parse()
                        .unwrap(),
                );
                headers
            })
            .build()?;

        let response: serde_json::Value = http_client.get(&url).send().await?.json().await?;
        let data = response
            .get("data")
            .and_then(|d| d.as_array())
            .cloned()
            .unwrap_or_default();

        let results = data
            .into_iter()
            .take(5)
            .filter_map(|item| {
                let id = item.get("id")?.as_u64()?;
                let slug = item.get("slug")?.as_str()?.to_string();
                let name = item.get("name")?.as_str()?.to_string();
                let icon_url = item
                    .get("logo")
                    .and_then(|l| l.get("url"))
                    .and_then(|u| u.as_str())
                    .map(String::from);

                let latest_files = item.get("latestFiles").and_then(|f| f.as_array())?;
                let latest_file = latest_files.first()?;

                let file_id = latest_file.get("id")?.as_u64()?;
                let file_name = latest_file
                    .get("fileName")
                    .and_then(|n| n.as_str())
                    .map(String::from);
                let download_url = latest_file
                    .get("downloadUrl")
                    .and_then(|u| u.as_str())
                    .map(String::from);
                let file_size = latest_file
                    .get("fileLength")
                    .and_then(|s| s.as_u64())
                    .unwrap_or(0);
                let display_name = latest_file
                    .get("displayName")
                    .and_then(|n| n.as_str())
                    .map(String::from);

                Some(ModSearchInfo {
                    project_id: id.to_string(),
                    slug,
                    name,
                    version: display_name,
                    version_id: Some(file_id.to_string()),
                    download_url,
                    file_name,
                    file_size,
                    source: "curseforge".to_string(),
                    icon_url,
                })
            })
            .collect();

        Ok(results)
    }

    /// Скачивание мода в указанный путь
    pub async fn download_mod_to_path(
        source: &str,
        project_id: &str,
        version_id: Option<&str>,
        dest_dir: &Path,
        _minecraft_version: Option<&str>,
        _loader: Option<&str>,
        download_manager: &DownloadManager,
    ) -> Result<String> {
        // ИСПРАВЛЕНО: Используем tokio::fs::create_dir_all для async создания директории
        tokio::fs::create_dir_all(dest_dir).await?;

        match source {
            "modrinth" => {
                let version_url = if let Some(vid) = version_id {
                    format!("{}/version/{}", MODRINTH_API_BASE, vid)
                } else {
                    let versions_url = format!(
                        "{}/project/{}/version?limit=1",
                        MODRINTH_API_BASE, project_id
                    );
                    let versions: Vec<serde_json::Value> = fetch_json(&versions_url).await?;
                    let first = versions.first().ok_or_else(|| {
                        LauncherError::ModNotFound("No versions found".to_string())
                    })?;
                    let vid = first
                        .get("id")
                        .and_then(|i| i.as_str())
                        .ok_or_else(|| LauncherError::ModNotFound("No version ID".to_string()))?;
                    format!("{}/version/{}", MODRINTH_API_BASE, vid)
                };

                let version: serde_json::Value = fetch_json(&version_url).await?;
                let files = version
                    .get("files")
                    .and_then(|f| f.as_array())
                    .ok_or_else(|| LauncherError::ModNotFound("No files".to_string()))?;

                let primary_file = files
                    .iter()
                    .find(|f| f.get("primary").and_then(|p| p.as_bool()).unwrap_or(false))
                    .or_else(|| files.first())
                    .ok_or_else(|| LauncherError::ModNotFound("No file".to_string()))?;

                let url = primary_file
                    .get("url")
                    .and_then(|u| u.as_str())
                    .ok_or_else(|| LauncherError::ModNotFound("No URL".to_string()))?;
                let filename = primary_file
                    .get("filename")
                    .and_then(|n| n.as_str())
                    .ok_or_else(|| LauncherError::ModNotFound("No filename".to_string()))?;

                let dest_path = dest_dir.join(filename);
                download_manager
                    .download_file(url, &dest_path, filename, None)
                    .await?;
                Ok(filename.to_string())
            }
            "curseforge" => {
                let project_id: u64 = project_id
                    .parse()
                    .map_err(|_| LauncherError::InvalidConfig("Invalid project ID".to_string()))?;

                let http_client = reqwest::Client::builder()
                    .user_agent(crate::USER_AGENT)
                    .default_headers({
                        let mut headers = reqwest::header::HeaderMap::new();
                        headers.insert(
                            "x-api-key",
                            "$2a$10$bL4bIL5pUWqfcO7KQtnMReakwtfHbNKh6v1uTpKlzhwoueEJQnPnm"
                                .parse()
                                .unwrap(),
                        );
                        headers
                    })
                    .build()?;

                let file_url = if let Some(fid) = version_id {
                    format!(
                        "https://api.curseforge.com/v1/mods/{}/files/{}",
                        project_id, fid
                    )
                } else {
                    format!(
                        "https://api.curseforge.com/v1/mods/{}/files?pageSize=1",
                        project_id
                    )
                };

                let response: serde_json::Value =
                    http_client.get(&file_url).send().await?.json().await?;

                let file_data = if version_id.is_some() {
                    response.get("data").cloned()
                } else {
                    response
                        .get("data")
                        .and_then(|d| d.as_array())
                        .and_then(|a| a.first().cloned())
                }
                .ok_or_else(|| LauncherError::ModNotFound("No file data".to_string()))?;

                let download_url = file_data.get("downloadUrl").and_then(|u| u.as_str());
                let filename = file_data
                    .get("fileName")
                    .and_then(|n| n.as_str())
                    .ok_or_else(|| LauncherError::ModNotFound("No filename".to_string()))?;

                let url = if let Some(durl) = download_url {
                    durl.to_string()
                } else {
                    let file_id = file_data.get("id").and_then(|i| i.as_u64()).unwrap_or(0);
                    let part1 = file_id / 1000;
                    let part2 = file_id % 1000;
                    format!(
                        "https://edge.forgecdn.net/files/{}/{}/{}",
                        part1, part2, filename
                    )
                };

                let dest_path = dest_dir.join(filename);
                download_manager
                    .download_file(&url, &dest_path, filename, None)
                    .await?;
                Ok(filename.to_string())
            }
            _ => Err(LauncherError::InvalidConfig(format!(
                "Unknown source: {}",
                source
            ))),
        }
    }

    /// Получение списка модов из модпака на платформе
    pub async fn get_modpack_mod_list(
        source: &str,
        project_id: &str,
        version_id: Option<&str>,
    ) -> Result<Vec<ModInfo>> {
        match source {
            "modrinth" => {
                let version_url = if let Some(vid) = version_id {
                    format!("{}/version/{}", MODRINTH_API_BASE, vid)
                } else {
                    let versions = Self::get_modrinth_versions(project_id, None, None).await?;
                    let latest = versions
                        .first()
                        .ok_or_else(|| LauncherError::ModNotFound("No versions".to_string()))?;
                    format!("{}/version/{}", MODRINTH_API_BASE, latest.id)
                };

                let version: serde_json::Value = fetch_json(&version_url).await?;
                let files = version
                    .get("files")
                    .and_then(|f| f.as_array())
                    .ok_or_else(|| LauncherError::ModNotFound("No files".to_string()))?;

                let primary_file = files
                    .iter()
                    .find(|f| f.get("primary").and_then(|p| p.as_bool()).unwrap_or(false))
                    .or_else(|| files.first())
                    .ok_or_else(|| LauncherError::ModNotFound("No file".to_string()))?;

                let download_url = primary_file
                    .get("url")
                    .and_then(|u| u.as_str())
                    .ok_or_else(|| LauncherError::ModNotFound("No URL".to_string()))?;

                // Скачиваем mrpack во временную директорию
                let cache_dir = paths::cache_dir();
                let temp_path =
                    cache_dir.join(format!("temp_modpack_{}.mrpack", uuid::Uuid::new_v4()));

                let client = reqwest::Client::builder()
                    .user_agent(crate::USER_AGENT)
                    .build()?;

                let response = client.get(download_url).send().await?;
                let bytes = response.bytes().await?;

                // ИСПРАВЛЕНО: Используем tokio::fs::write для async записи
                tokio::fs::write(&temp_path, &bytes).await?;

                // ИСПРАВЛЕНО: Используем spawn_blocking для sync-only zip библиотеки
                let temp_path_clone = temp_path.clone();
                let mods = tokio::task::spawn_blocking(move || -> Result<Vec<ModInfo>> {
                    // Извлекаем список модов из modrinth.index.json
                    let file = std::fs::File::open(&temp_path_clone)?;
                    let mut archive = zip::ZipArchive::new(file).map_err(|e| {
                        LauncherError::Archive(format!("Failed to open zip: {}", e))
                    })?;

                    let mods = if let Ok(mut index_file) = archive.by_name("modrinth.index.json") {
                        let mut contents = String::new();
                        index_file.read_to_string(&mut contents)?;
                        let index: ModrinthModpackIndex = serde_json::from_str(&contents)?;

                        index
                            .files
                            .into_iter()
                            .filter(|f| f.path.starts_with("mods/"))
                            .map(|f| {
                                let filename = Path::new(&f.path)
                                    .file_name()
                                    .and_then(|n| n.to_str())
                                    .unwrap_or("")
                                    .to_string();
                                let (name, version) = parse_mod_filename(&filename);
                                ModInfo {
                                    filename,
                                    name,
                                    version,
                                    size: f.file_size,
                                    hash: None,
                                }
                            })
                            .collect()
                    } else {
                        Vec::new()
                    };

                    Ok(mods)
                })
                .await
                .map_err(|e| LauncherError::Join(e.to_string()))??;

                // ИСПРАВЛЕНО: Используем tokio::fs::remove_file для async удаления
                let _ = tokio::fs::remove_file(&temp_path).await;
                Ok(mods)
            }
            "curseforge" => {
                let pid: u64 = project_id
                    .parse()
                    .map_err(|_| LauncherError::InvalidConfig("Invalid project ID".to_string()))?;

                let http_client = reqwest::Client::builder()
                    .user_agent(crate::USER_AGENT)
                    .default_headers({
                        let mut headers = reqwest::header::HeaderMap::new();
                        headers.insert(
                            "x-api-key",
                            "$2a$10$bL4bIL5pUWqfcO7KQtnMReakwtfHbNKh6v1uTpKlzhwoueEJQnPnm"
                                .parse()
                                .unwrap(),
                        );
                        headers
                    })
                    .build()?;

                // Получаем файл модпака
                let file_url = if let Some(fid) = version_id {
                    format!("https://api.curseforge.com/v1/mods/{}/files/{}", pid, fid)
                } else {
                    format!(
                        "https://api.curseforge.com/v1/mods/{}/files?pageSize=1",
                        pid
                    )
                };

                let response: serde_json::Value =
                    http_client.get(&file_url).send().await?.json().await?;

                let file_data = if version_id.is_some() {
                    response.get("data").cloned()
                } else {
                    response
                        .get("data")
                        .and_then(|d| d.as_array())
                        .and_then(|a| a.first().cloned())
                }
                .ok_or_else(|| LauncherError::ModNotFound("No file data".to_string()))?;

                let download_url = file_data.get("downloadUrl").and_then(|u| u.as_str());
                let filename = file_data
                    .get("fileName")
                    .and_then(|n| n.as_str())
                    .unwrap_or("modpack.zip");

                let url = if let Some(durl) = download_url {
                    durl.to_string()
                } else {
                    let file_id = file_data.get("id").and_then(|i| i.as_u64()).unwrap_or(0);
                    let part1 = file_id / 1000;
                    let part2 = file_id % 1000;
                    format!(
                        "https://edge.forgecdn.net/files/{}/{}/{}",
                        part1, part2, filename
                    )
                };

                // Скачиваем zip во временную директорию
                let cache_dir = paths::cache_dir();
                let temp_path =
                    cache_dir.join(format!("temp_modpack_{}.zip", uuid::Uuid::new_v4()));

                let response = http_client.get(&url).send().await?;
                let bytes = response.bytes().await?;

                // ИСПРАВЛЕНО: Используем tokio::fs::write для async записи
                tokio::fs::write(&temp_path, &bytes).await?;

                // ИСПРАВЛЕНО: Используем spawn_blocking для sync-only zip библиотеки
                let temp_path_clone = temp_path.clone();
                let file_ids = tokio::task::spawn_blocking(move || -> Result<Vec<u64>> {
                    // Извлекаем список модов из manifest.json
                    let file = std::fs::File::open(&temp_path_clone)?;
                    let mut archive = zip::ZipArchive::new(file).map_err(|e| {
                        LauncherError::Archive(format!("Failed to open zip: {}", e))
                    })?;

                    // Читаем содержимое файла и закрываем его до парсинга
                    let contents = if let Ok(mut manifest_file) = archive.by_name("manifest.json") {
                        let mut s = String::new();
                        manifest_file.read_to_string(&mut s)?;
                        s
                    } else {
                        return Ok(Vec::new());
                    };

                    // Теперь парсим после того как manifest_file закрыт
                    let manifest: CurseForgeManifest = serde_json::from_str(&contents)?;
                    Ok(manifest.files.iter().map(|f| f.file_id).collect())
                })
                .await
                .map_err(|e| LauncherError::Join(e.to_string()))??;

                let mods = if !file_ids.is_empty() {
                    let batch_response: serde_json::Value = http_client
                        .post("https://api.curseforge.com/v1/mods/files")
                        .json(&serde_json::json!({ "fileIds": file_ids }))
                        .send()
                        .await?
                        .json()
                        .await?;

                    let data = batch_response
                        .get("data")
                        .and_then(|d| d.as_array())
                        .cloned()
                        .unwrap_or_default();

                    data.into_iter()
                        .filter_map(|f| {
                            let filename = f.get("fileName")?.as_str()?.to_string();
                            let file_size =
                                f.get("fileLength").and_then(|s| s.as_u64()).unwrap_or(0);
                            let (name, version) = parse_mod_filename(&filename);
                            Some(ModInfo {
                                filename,
                                name,
                                version,
                                size: file_size,
                                hash: None,
                            })
                        })
                        .collect()
                } else {
                    Vec::new()
                };

                // ИСПРАВЛЕНО: Используем tokio::fs::remove_file для async удаления
                let _ = tokio::fs::remove_file(&temp_path).await;
                Ok(mods)
            }
            _ => Err(LauncherError::InvalidConfig(format!(
                "Unknown source: {}",
                source
            ))),
        }
    }

    /// Сравнивает два модпака (по путям к файлам .zip/.mrpack или директориям инстансов)
    /// Выполняется асинхронно чтобы не блокировать UI
    pub async fn compare_modpacks(path1: &Path, path2: &Path) -> Result<ModpackComparison> {
        log::info!("Comparing modpacks: {:?} vs {:?}", path1, path2);

        let p1 = path1.to_path_buf();
        let p2 = path2.to_path_buf();

        // Выполняем блокирующие операции в отдельном потоке
        tokio::task::spawn_blocking(move || Self::compare_modpacks_sync(&p1, &p2))
            .await
            .map_err(|e| LauncherError::Join(format!("Task join error: {}", e)))?
    }

    /// Синхронная версия сравнения модпаков (выполняется в отдельном потоке)
    fn compare_modpacks_sync(path1: &Path, path2: &Path) -> Result<ModpackComparison> {
        // Определяем, это архивы или директории
        let (mods1, configs1, other1, temp1) = if path1.is_file() {
            let temp = extract_modpack_to_temp(path1)?;
            let mods_dir = find_mods_in_extracted(&temp);
            let mods = scan_mods_dir(&mods_dir)?;
            let configs = scan_configs_in_extracted(&temp)?;
            let other = scan_other_dirs(&temp.join("overrides"));
            (mods, configs, other, Some(temp))
        } else {
            let mods = scan_mods_dir(&path1.join("mods"))?;
            let configs = scan_all_configs(path1)?;
            let other = scan_other_dirs(path1);
            (mods, configs, other, None)
        };

        let (mods2, configs2, other2, temp2) = if path2.is_file() {
            let temp = extract_modpack_to_temp(path2)?;
            let mods_dir = find_mods_in_extracted(&temp);
            let mods = scan_mods_dir(&mods_dir)?;
            let configs = scan_configs_in_extracted(&temp)?;
            let other = scan_other_dirs(&temp.join("overrides"));
            (mods, configs, other, Some(temp))
        } else {
            let mods = scan_mods_dir(&path2.join("mods"))?;
            let configs = scan_all_configs(path2)?;
            let other = scan_other_dirs(path2);
            (mods, configs, other, None)
        };

        // Сравниваем моды
        let mut mods_only_in_first = Vec::new();
        let mut mods_only_in_second = Vec::new();
        let mut mods_different_version = Vec::new();
        let mut mods_identical = Vec::new();

        // Создаём мапы для сравнения
        let mods2_by_name: std::collections::HashMap<String, &ModInfo> =
            mods2.iter().map(|m| (m.name.clone(), m)).collect();

        // Дополнительная мапа по хешу для поиска переименованных модов
        let mods2_by_hash: std::collections::HashMap<String, &ModInfo> = mods2
            .iter()
            .filter_map(|m| m.hash.as_ref().map(|h| (h.clone(), m)))
            .collect();

        let mut matched_in_second: std::collections::HashSet<String> =
            std::collections::HashSet::new();

        for mod1 in &mods1 {
            // Сначала ищем по имени
            if let Some(mod2) = mods2_by_name.get(&mod1.name) {
                matched_in_second.insert(mod2.name.clone());

                // Проверяем идентичность по хешу (приоритет) или по filename+size
                let is_identical = match (&mod1.hash, &mod2.hash) {
                    (Some(h1), Some(h2)) => h1 == h2,
                    _ => mod1.filename == mod2.filename && mod1.size == mod2.size,
                };

                if is_identical {
                    mods_identical.push(mod1.clone());
                } else {
                    mods_different_version.push(ModVersionDiff {
                        name: mod1.name.clone(),
                        first_filename: mod1.filename.clone(),
                        second_filename: mod2.filename.clone(),
                        first_version: mod1.version.clone(),
                        second_version: mod2.version.clone(),
                    });
                }
            } else if let Some(hash) = &mod1.hash {
                // Если не нашли по имени, ищем по хешу (мод мог быть переименован)
                if let Some(mod2) = mods2_by_hash.get(hash) {
                    if !matched_in_second.contains(&mod2.name) {
                        matched_in_second.insert(mod2.name.clone());
                        // Тот же мод но с другим именем/filename - считаем идентичным
                        mods_identical.push(mod1.clone());
                    }
                } else {
                    mods_only_in_first.push(mod1.clone());
                }
            } else {
                mods_only_in_first.push(mod1.clone());
            }
        }

        for mod2 in &mods2 {
            if !matched_in_second.contains(&mod2.name) {
                mods_only_in_second.push(mod2.clone());
            }
        }

        // Сравниваем конфиги
        let configs2_map: std::collections::HashMap<String, &ConfigInfo> =
            configs2.iter().map(|c| (c.path.clone(), c)).collect();

        let mut configs_only_in_first = Vec::new();
        let mut configs_only_in_second = Vec::new();
        let mut configs_different = Vec::new();

        let mut matched_configs: std::collections::HashSet<String> =
            std::collections::HashSet::new();

        for config1 in &configs1 {
            if let Some(config2) = configs2_map.get(&config1.path) {
                matched_configs.insert(config2.path.clone());

                if config1.hash != config2.hash {
                    configs_different.push(ConfigDiff {
                        path: config1.path.clone(),
                        first_size: config1.size,
                        second_size: config2.size,
                    });
                }
            } else {
                configs_only_in_first.push(config1.clone());
            }
        }

        for config2 in &configs2 {
            if !matched_configs.contains(&config2.path) {
                configs_only_in_second.push(config2.clone());
            }
        }

        // Сравниваем другие файлы
        let other1_set: std::collections::HashSet<_> = other1.iter().collect();
        let other2_set: std::collections::HashSet<_> = other2.iter().collect();

        let other_only_in_first: Vec<String> = other1
            .iter()
            .filter(|f| !other2_set.contains(f))
            .cloned()
            .collect();

        let other_only_in_second: Vec<String> = other2
            .iter()
            .filter(|f| !other1_set.contains(f))
            .cloned()
            .collect();

        // Очищаем временные директории
        if let Some(temp) = temp1 {
            let _ = std::fs::remove_dir_all(temp);
        }
        if let Some(temp) = temp2 {
            let _ = std::fs::remove_dir_all(temp);
        }

        Ok(ModpackComparison {
            total_mods_first: mods1.len() as u32,
            total_mods_second: mods2.len() as u32,
            total_configs_first: configs1.len() as u32,
            total_configs_second: configs2.len() as u32,
            mods_only_in_first,
            mods_only_in_second,
            mods_different_version,
            mods_identical,
            configs_only_in_first,
            configs_only_in_second,
            configs_different,
            other_only_in_first,
            other_only_in_second,
        })
    }

    /// Read file content from a modpack archive
    /// Returns the file content as a string (for text files) or None for binary files
    pub async fn read_file_from_archive(
        archive_path: &std::path::Path,
        file_path: &str,
    ) -> Result<Option<String>> {
        let archive_path = archive_path.to_path_buf();
        let file_path = file_path.to_string();

        tokio::task::spawn_blocking(move || {
            Self::read_file_from_archive_sync(&archive_path, &file_path)
        })
        .await
        .map_err(|e| LauncherError::Join(e.to_string()))?
    }

    /// Sync version of read_file_from_archive
    fn read_file_from_archive_sync(
        archive_path: &std::path::Path,
        file_path: &str,
    ) -> Result<Option<String>> {
        // List of binary file extensions that we shouldn't try to read as text
        const BINARY_EXTENSIONS: &[&str] = &[
            "jar", "zip", "gz", "tar", "rar", "7z", "bz2", "xz", "png", "jpg", "jpeg", "gif",
            "bmp", "ico", "webp", "svg", "mp3", "wav", "ogg", "flac", "aac", "mp4", "avi", "mkv",
            "webm", "mov", "ttf", "otf", "woff", "woff2", "pdf", "doc", "docx", "xls", "xlsx",
            "class", "so", "dll", "exe", "bin", "dat", "nbt", "mca",
            "mcr", // Minecraft binary formats
        ];

        // Check if file is binary based on extension
        let ext = file_path.rsplit('.').next().unwrap_or("").to_lowercase();

        if BINARY_EXTENSIONS.contains(&ext.as_str()) {
            return Ok(None);
        }

        let file = std::fs::File::open(archive_path)?;
        let mut archive = zip::ZipArchive::new(file)?;

        // Try to find the file in the archive
        // The file might be in overrides/ or directly at the path
        let possible_paths = [
            file_path.to_string(),
            format!("overrides/{}", file_path),
            format!("client-overrides/{}", file_path),
            format!("server-overrides/{}", file_path),
        ];

        for path in &possible_paths {
            if let Ok(mut entry) = archive.by_name(path) {
                // Limit file size to prevent loading huge files
                const MAX_SIZE: u64 = 10 * 1024 * 1024; // 10 MB
                if entry.size() > MAX_SIZE {
                    return Ok(None);
                }

                let mut content = String::new();
                match entry.read_to_string(&mut content) {
                    Ok(_) => return Ok(Some(content)),
                    Err(_) => return Ok(None), // File is not valid UTF-8, treat as binary
                }
            }
        }

        // File not found - return None for graceful handling
        Ok(None)
    }
}
