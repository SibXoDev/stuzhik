//! Integrated Wiki - встроенная документация по модам
//!
//! Получает wiki контент из Modrinth/CurseForge API:
//! - Full description (body) в markdown формате
//! - Changelog версий
//! - Галерея изображений
//! - Ссылки на внешние ресурсы (wiki, discord, issues)

use crate::api::{curseforge::CurseForgeClient, modrinth::ModrinthClient};
use crate::error::{LauncherError, Result};
use serde::{Deserialize, Serialize};

/// Wiki контент для мода
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WikiContent {
    /// Название мода
    pub mod_name: String,
    /// Slug/ID мода
    pub slug: String,
    /// Автор мода
    pub author: Option<String>,
    /// Полное описание (markdown для Modrinth, HTML для CurseForge)
    pub body: String,
    /// Формат контента
    pub content_format: ContentFormat,
    /// URL внешней страницы мода
    pub project_url: Option<String>,
    /// URL официальной wiki (если есть)
    pub wiki_url: Option<String>,
    /// URL Discord сервера
    pub discord_url: Option<String>,
    /// URL для issues/bug reports
    pub issues_url: Option<String>,
    /// URL исходного кода
    pub source_url: Option<String>,
    /// Лицензия
    pub license: Option<LicenseInfo>,
    /// Категории мода
    pub categories: Vec<String>,
    /// Галерея изображений
    pub gallery: Vec<GalleryImage>,
    /// Количество загрузок
    pub downloads: u64,
    /// Количество подписчиков/followers
    pub followers: u64,
    /// Дата создания
    pub date_created: Option<String>,
    /// Дата последнего обновления
    pub date_modified: Option<String>,
}

/// Формат контента wiki
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ContentFormat {
    Markdown,
    Html,
    PlainText,
}

/// Информация о лицензии
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LicenseInfo {
    pub id: String,
    pub name: String,
    pub url: Option<String>,
}

/// Изображение галереи
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GalleryImage {
    pub url: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub featured: bool,
}

/// Changelog версии мода (также используется для выбора версии при установке)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionChangelog {
    /// ID версии (для Modrinth - version_id, для CurseForge - file_id)
    pub id: String,
    pub version_number: String,
    pub version_name: String,
    pub changelog: Option<String>,
    pub date_published: String,
    pub game_versions: Vec<String>,
    pub loaders: Vec<String>,
    pub downloads: u64,
    /// Размер файла в байтах
    pub file_size: u64,
    /// URL для загрузки
    pub download_url: Option<String>,
    /// Имя файла
    pub file_name: Option<String>,
    /// Тип версии (release, beta, alpha)
    pub version_type: Option<String>,
}

/// Получить wiki контент мода из Modrinth
pub async fn get_modrinth_wiki(slug: &str) -> Result<WikiContent> {
    let project = ModrinthClient::get_project(slug).await?;

    // Modrinth project API doesn't return author, so we search for it
    let author = {
        let client = ModrinthClient::new();
        match client.search_mods(slug, None, None, 1, 0).await {
            Ok(result) => {
                // Find exact match by slug
                result
                    .hits
                    .iter()
                    .find(|h| h.slug == project.slug)
                    .map(|h| h.author.clone())
            }
            Err(_) => None,
        }
    };

    Ok(WikiContent {
        mod_name: project.title,
        slug: project.slug.clone(),
        author,
        body: project.body,
        content_format: ContentFormat::Markdown,
        project_url: Some(format!("https://modrinth.com/mod/{}", project.slug)),
        wiki_url: project.wiki_url,
        discord_url: project.discord_url,
        issues_url: project.issues_url,
        source_url: project.source_url,
        license: Some(LicenseInfo {
            id: project.license.id,
            name: project.license.name,
            url: project.license.url,
        }),
        categories: project.categories,
        gallery: project
            .gallery
            .into_iter()
            .map(|img| GalleryImage {
                url: img.url,
                title: img.title,
                description: img.description,
                featured: img.featured,
            })
            .collect(),
        downloads: project.downloads,
        followers: project.followers,
        date_created: None, // Нет в базовом API
        date_modified: None,
    })
}

/// Получить wiki контент мода из CurseForge
pub async fn get_curseforge_wiki(mod_id: u64) -> Result<WikiContent> {
    let client = CurseForgeClient::new()?;
    let mod_info = client.get_mod(mod_id).await?;

    // Clone values before moving them
    let mod_name = mod_info.name.clone();
    let slug = mod_info.slug.clone();
    let summary = mod_info.summary.clone();
    let wiki_url = mod_info.links.wiki_url.clone();
    let issues_url = mod_info.links.issues_url.clone();
    let source_url = mod_info.links.source_url.clone();
    let categories = mod_info.get_category_names();
    // Get author from first author in list
    let author = mod_info.authors.first().map(|a| a.name.clone());
    let gallery: Vec<GalleryImage> = mod_info
        .screenshots
        .iter()
        .map(|s| GalleryImage {
            url: s.url.clone(),
            title: s.title.clone(),
            description: s.description.clone(),
            featured: false,
        })
        .collect();
    let date_created = if mod_info.date_created.is_empty() {
        None
    } else {
        Some(mod_info.date_created.clone())
    };
    let date_modified = if mod_info.date_modified.is_empty() {
        None
    } else {
        Some(mod_info.date_modified.clone())
    };

    // CurseForge не предоставляет полный body через API
    // Только summary (короткое описание)
    Ok(WikiContent {
        mod_name,
        slug: slug.clone(),
        author,
        body: summary,
        content_format: ContentFormat::PlainText,
        project_url: Some(format!(
            "https://www.curseforge.com/minecraft/mc-mods/{}",
            slug
        )),
        wiki_url,
        discord_url: None,
        issues_url,
        source_url,
        license: None, // CurseForge не предоставляет лицензию в API
        categories,
        gallery,
        downloads: mod_info.download_count,
        followers: mod_info.thumbs_up_count,
        date_created,
        date_modified,
    })
}

/// Получить changelog версий мода из Modrinth
pub async fn get_modrinth_changelog(
    slug: &str,
    limit: Option<usize>,
) -> Result<Vec<VersionChangelog>> {
    let versions = ModrinthClient::get_project_versions(slug, None, None).await?;

    let limit = limit.unwrap_or(20);
    let changelogs: Vec<VersionChangelog> = versions
        .into_iter()
        .take(limit)
        .map(|v| {
            // Получаем primary файл или первый
            let primary_file = v.files.iter().find(|f| f.primary).or(v.files.first());

            VersionChangelog {
                id: v.id,
                version_number: v.version_number,
                version_name: v.name,
                changelog: v.changelog,
                date_published: v.date_published,
                game_versions: v.game_versions,
                loaders: v.loaders,
                downloads: v.downloads,
                file_size: primary_file.map(|f| f.size).unwrap_or(0),
                download_url: primary_file.map(|f| f.url.clone()),
                file_name: primary_file.map(|f| f.filename.clone()),
                version_type: Some(v.version_type),
            }
        })
        .collect();

    Ok(changelogs)
}

/// Получить changelog версий мода из CurseForge
pub async fn get_curseforge_changelog(
    mod_id: u64,
    limit: Option<usize>,
) -> Result<Vec<VersionChangelog>> {
    let client = CurseForgeClient::new()?;
    let files = client.get_mod_files(mod_id, None, None).await?;

    let limit = limit.unwrap_or(20);
    let mut changelogs = Vec::with_capacity(limit);

    // Получаем changelog для первых 5 файлов (для экономии API вызовов)
    // Остальные будут без changelog
    let changelog_limit = 5.min(limit);

    for (idx, f) in files.into_iter().take(limit).enumerate() {
        // Извлекаем loaders из game_versions (CurseForge смешивает MC версии и загрузчики)
        let loaders: Vec<String> = f
            .game_versions
            .iter()
            .filter(|v| {
                let lower = v.to_lowercase();
                lower == "forge" || lower == "fabric" || lower == "neoforge" || lower == "quilt"
            })
            .cloned()
            .collect();

        // Фильтруем только MC версии
        let game_versions: Vec<String> = f
            .game_versions
            .iter()
            .filter(|v| {
                let lower = v.to_lowercase();
                !lower.contains("forge")
                    && !lower.contains("fabric")
                    && !lower.contains("neoforge")
                    && !lower.contains("quilt")
            })
            .cloned()
            .collect();

        // Определяем тип версии из release_type
        let version_type = match f.release_type {
            1 => Some("release".to_string()),
            2 => Some("beta".to_string()),
            3 => Some("alpha".to_string()),
            _ => None,
        };

        // Получаем changelog только для первых N файлов
        let changelog = if idx < changelog_limit {
            client
                .get_file_changelog(mod_id, f.id)
                .await
                .unwrap_or(None)
        } else {
            None
        };

        changelogs.push(VersionChangelog {
            id: f.id.to_string(),
            version_number: f.display_name.clone(),
            version_name: f.display_name,
            changelog,
            date_published: f.file_date,
            game_versions,
            loaders,
            downloads: f.download_count as u64,
            file_size: f.file_length as u64,
            download_url: f.download_url,
            file_name: Some(f.file_name),
            version_type,
        });
    }

    Ok(changelogs)
}

/// Lookup mod on Modrinth by file hash (SHA1 or SHA512)
/// Returns the project slug if found
async fn lookup_mod_by_hash(hash: &str) -> Option<String> {
    // Determine algorithm by hash length: SHA1 = 40 chars, SHA512 = 128 chars
    let algorithm = if hash.len() == 40 { "sha1" } else { "sha512" };

    #[derive(serde::Serialize)]
    struct HashRequest<'a> {
        hashes: Vec<&'a str>,
        algorithm: &'a str,
    }

    #[derive(serde::Deserialize)]
    struct VersionResponse {
        project_id: String,
    }

    let request = HashRequest {
        hashes: vec![hash],
        algorithm,
    };

    let resp = crate::utils::SHARED_HTTP_CLIENT
        .post("https://api.modrinth.com/v2/version_files")
        .json(&request)
        .send()
        .await
        .ok()?;

    if !resp.status().is_success() {
        return None;
    }

    // Response is a map: { "hash": VersionResponse, ... }
    let versions: std::collections::HashMap<String, VersionResponse> = resp.json().await.ok()?;

    // Get the first result and lookup project slug
    if let Some(version) = versions.into_values().next() {
        // Get project info to get the slug
        let project_resp = crate::utils::SHARED_HTTP_CLIENT
            .get(format!(
                "https://api.modrinth.com/v2/project/{}",
                version.project_id
            ))
            .header("User-Agent", crate::USER_AGENT)
            .send()
            .await
            .ok()?;

        #[derive(serde::Deserialize)]
        struct ProjectInfo {
            slug: String,
        }

        let project: ProjectInfo = project_resp.json().await.ok()?;
        return Some(project.slug);
    }

    None
}

// ============================================================================
// Tauri Commands
// ============================================================================

/// Получить wiki контент мода
#[tauri::command]
pub async fn get_mod_wiki(
    slug: String,
    source: String,
    file_hash: Option<String>,
) -> Result<WikiContent> {
    match source.as_str() {
        "modrinth" => get_modrinth_wiki(&slug).await,
        "curseforge" => {
            // Для CurseForge slug - это mod_id
            let mod_id: u64 = slug.parse().map_err(|_| {
                LauncherError::InvalidConfig("Invalid CurseForge mod ID".to_string())
            })?;
            get_curseforge_wiki(mod_id).await
        }
        "local" | "modpack" => {
            // First try to find by hash if provided
            if let Some(hash) = &file_hash {
                if let Some(project_slug) = lookup_mod_by_hash(hash).await {
                    return get_modrinth_wiki(&project_slug).await;
                }
            }

            // Fallback: try to find by name
            let client = ModrinthClient::new();
            let clean_name = slug
                .trim_end_matches(".jar")
                .split(&['-', '_', '+'][..])
                .next()
                .unwrap_or(&slug)
                .to_lowercase();

            if let Ok(results) = client.search_mods(&clean_name, None, None, 5, 0).await {
                for hit in results.hits {
                    let hit_slug = hit.slug.to_lowercase();
                    let hit_title = hit.title.to_lowercase();

                    if hit_slug == clean_name
                        || hit_title == clean_name
                        || hit_slug.contains(&clean_name)
                        || clean_name.contains(&hit_slug)
                        || hit_title.contains(&clean_name)
                    {
                        return get_modrinth_wiki(&hit.slug).await;
                    }
                }
            }

            Err(LauncherError::InvalidConfig(format!(
                "Could not find mod '{}' on Modrinth. Try searching manually.",
                slug
            )))
        }
        _ => Err(LauncherError::InvalidConfig(format!(
            "Unknown source: {}",
            source
        ))),
    }
}

/// Получить changelog версий мода
#[tauri::command]
pub async fn get_mod_changelog(
    slug: String,
    source: String,
    limit: Option<usize>,
    file_hash: Option<String>,
) -> Result<Vec<VersionChangelog>> {
    match source.as_str() {
        "modrinth" => get_modrinth_changelog(&slug, limit).await,
        "curseforge" => {
            let mod_id: u64 = slug.parse().map_err(|_| {
                LauncherError::InvalidConfig("Invalid CurseForge mod ID".to_string())
            })?;
            get_curseforge_changelog(mod_id, limit).await
        }
        "local" | "modpack" => {
            // First try to find by hash if provided
            if let Some(hash) = &file_hash {
                if let Some(project_slug) = lookup_mod_by_hash(hash).await {
                    return get_modrinth_changelog(&project_slug, limit).await;
                }
            }

            // Fallback: try to find by name
            let client = ModrinthClient::new();
            let clean_name = slug
                .trim_end_matches(".jar")
                .split(&['-', '_', '+'][..])
                .next()
                .unwrap_or(&slug)
                .to_lowercase();

            if let Ok(results) = client.search_mods(&clean_name, None, None, 5, 0).await {
                for hit in results.hits {
                    let hit_slug = hit.slug.to_lowercase();
                    let hit_title = hit.title.to_lowercase();

                    if hit_slug == clean_name
                        || hit_title == clean_name
                        || hit_slug.contains(&clean_name)
                        || clean_name.contains(&hit_slug)
                        || hit_title.contains(&clean_name)
                    {
                        return get_modrinth_changelog(&hit.slug, limit).await;
                    }
                }
            }

            Err(LauncherError::InvalidConfig(format!(
                "Could not find mod '{}' on Modrinth. Try searching manually.",
                slug
            )))
        }
        _ => Err(LauncherError::InvalidConfig(format!(
            "Unknown source: {}",
            source
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_content_format_serialization() {
        let format = ContentFormat::Markdown;
        let json = serde_json::to_string(&format).unwrap();
        assert_eq!(json, "\"markdown\"");

        let format: ContentFormat = serde_json::from_str("\"html\"").unwrap();
        assert_eq!(format, ContentFormat::Html);
    }

    #[test]
    fn test_wiki_content_serialization() {
        let wiki = WikiContent {
            mod_name: "Test Mod".to_string(),
            slug: "test-mod".to_string(),
            author: Some("Test Author".to_string()),
            body: "# Description\nThis is a test".to_string(),
            content_format: ContentFormat::Markdown,
            project_url: Some("https://modrinth.com/mod/test-mod".to_string()),
            wiki_url: None,
            discord_url: None,
            issues_url: None,
            source_url: None,
            license: Some(LicenseInfo {
                id: "MIT".to_string(),
                name: "MIT License".to_string(),
                url: None,
            }),
            categories: vec!["technology".to_string()],
            gallery: vec![],
            downloads: 1000,
            followers: 100,
            date_created: None,
            date_modified: None,
        };

        let json = serde_json::to_string(&wiki).unwrap();
        assert!(json.contains("\"mod_name\":\"Test Mod\""));
        assert!(json.contains("\"content_format\":\"markdown\""));
    }
}
