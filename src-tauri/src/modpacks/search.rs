use super::types::*;
use crate::api::curseforge::CurseForgeClient;
use crate::downloader::fetch_json;
use crate::error::{LauncherError, Result};

const MODRINTH_API_BASE: &str = "https://api.modrinth.com/v2";

pub struct ModpackManager;

impl ModpackManager {
    /// Поиск модпаков на Modrinth
    pub async fn search_modrinth(
        query: &str,
        minecraft_version: Option<&str>,
        loader: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> Result<ModpackSearchResponse> {
        let mut url = format!(
            "{}/search?query={}&limit={}&offset={}",
            MODRINTH_API_BASE,
            urlencoding::encode(query),
            limit,
            offset
        );

        // Фильтр по типу проекта (только modpack)
        url.push_str("&facets=[[\"project_type:modpack\"]");

        if let Some(mc_ver) = minecraft_version {
            url.push_str(&format!(",[\"versions:{}\"]", mc_ver));
        }

        if let Some(ldr) = loader {
            url.push_str(&format!(",[\"categories:{}\"]", ldr));
        }

        url.push(']');

        let response: ModrinthSearchResponse = fetch_json(&url).await?;

        let results = response
            .hits
            .into_iter()
            .map(|hit| ModpackSearchResult {
                slug: hit.slug,
                title: hit.title,
                description: hit.description,
                icon_url: hit.icon_url,
                downloads: hit.downloads,
                author: hit.author,
                categories: hit.categories,
                minecraft_versions: hit.versions,
                loaders: hit.loaders.unwrap_or_default(),
                source: "modrinth".to_string(),
                project_id: hit.project_id,
            })
            .collect();

        Ok(ModpackSearchResponse {
            results,
            total: response.total_hits,
            offset: response.offset,
            limit: response.limit,
        })
    }

    /// Поиск модпаков на CurseForge
    pub async fn search_curseforge(
        query: &str,
        minecraft_version: Option<&str>,
        loader: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> Result<ModpackSearchResponse> {
        let _client = CurseForgeClient::new()?;

        // classId=4471 для модпаков
        let mut url = format!(
            "https://api.curseforge.com/v1/mods/search?gameId=432&classId=4471&searchFilter={}&pageSize={}&index={}",
            urlencoding::encode(query),
            limit,
            offset
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
                        .expect("valid API key header value"),
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
        let pagination = response.get("pagination");
        let total = pagination
            .and_then(|p| p.get("totalCount"))
            .and_then(|t| t.as_u64())
            .unwrap_or(0) as u32;

        let results = data
            .into_iter()
            .filter_map(|item| {
                let slug = item.get("slug")?.as_str()?.to_string();
                let id = item.get("id")?.as_u64()?;
                let name = item.get("name")?.as_str()?.to_string();
                let summary = item.get("summary")?.as_str()?.to_string();
                let downloads = item.get("downloadCount")?.as_u64().unwrap_or(0);
                let icon_url = item
                    .get("logo")
                    .and_then(|l| l.get("url"))
                    .and_then(|u| u.as_str())
                    .map(String::from);
                let author = item
                    .get("authors")
                    .and_then(|a| a.as_array())
                    .and_then(|a| a.first())
                    .and_then(|a| a.get("name"))
                    .and_then(|n| n.as_str())
                    .unwrap_or("Unknown")
                    .to_string();

                let categories = item
                    .get("categories")
                    .and_then(|c| c.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|c| {
                                c.get("name").and_then(|n| n.as_str()).map(String::from)
                            })
                            .collect()
                    })
                    .unwrap_or_default();

                Some(ModpackSearchResult {
                    slug,
                    title: name,
                    description: summary,
                    icon_url,
                    downloads,
                    author,
                    categories,
                    minecraft_versions: vec![],
                    loaders: vec![],
                    source: "curseforge".to_string(),
                    project_id: id.to_string(),
                })
            })
            .collect();

        Ok(ModpackSearchResponse {
            results,
            total,
            offset,
            limit,
        })
    }

    /// Получение версий модпака с Modrinth
    pub async fn get_modrinth_versions(
        slug: &str,
        minecraft_version: Option<&str>,
        loader: Option<&str>,
    ) -> Result<Vec<ModpackVersionInfo>> {
        let mut url = format!("{}/project/{}/version", MODRINTH_API_BASE, slug);

        let mut params = vec![];
        if let Some(mc_ver) = minecraft_version {
            params.push(format!("game_versions=[\"{}\"]", mc_ver));
        }
        if let Some(ldr) = loader {
            params.push(format!("loaders=[\"{}\"]", ldr));
        }

        if !params.is_empty() {
            url = format!("{}?{}", url, params.join("&"));
        }

        let versions: Vec<serde_json::Value> = fetch_json(&url).await?;

        let results = versions
            .into_iter()
            .filter_map(|v| {
                let id = v.get("id")?.as_str()?.to_string();
                let name = v.get("name")?.as_str()?.to_string();
                let version_number = v.get("version_number")?.as_str()?.to_string();
                let game_versions: Vec<String> = v
                    .get("game_versions")?
                    .as_array()?
                    .iter()
                    .filter_map(|g| g.as_str().map(String::from))
                    .collect();
                let loaders: Vec<String> = v
                    .get("loaders")?
                    .as_array()?
                    .iter()
                    .filter_map(|l| l.as_str().map(String::from))
                    .collect();
                let downloads = v.get("downloads")?.as_u64().unwrap_or(0);

                let files = v.get("files")?.as_array()?;
                let primary_file = files
                    .iter()
                    .find(|f| f.get("primary").and_then(|p| p.as_bool()).unwrap_or(false))
                    .or_else(|| files.first())?;
                let download_url = primary_file.get("url")?.as_str()?.to_string();
                let file_size = primary_file.get("size")?.as_u64().unwrap_or(0);

                Some(ModpackVersionInfo {
                    id,
                    name,
                    version_number,
                    game_versions,
                    loaders,
                    downloads,
                    download_url,
                    file_size,
                })
            })
            .collect();

        Ok(results)
    }

    /// Получение версий модпака с CurseForge
    pub async fn get_curseforge_versions(
        project_id: &str,
        minecraft_version: Option<&str>,
        loader: Option<&str>,
    ) -> Result<Vec<ModpackVersionInfo>> {
        let pid: u64 = project_id
            .parse()
            .map_err(|_| LauncherError::InvalidConfig("Invalid project ID".to_string()))?;

        let mut url = format!(
            "https://api.curseforge.com/v1/mods/{}/files?pageSize=50",
            pid
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
                        .expect("valid API key header value"),
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
            .filter_map(|item| {
                let id = item.get("id")?.as_u64()?.to_string();
                let display_name = item.get("displayName")?.as_str()?.to_string();
                let file_name = item.get("fileName")?.as_str()?.to_string();
                let file_size = item.get("fileLength")?.as_u64().unwrap_or(0);
                let downloads = item.get("downloadCount")?.as_u64().unwrap_or(0);
                let download_url = item.get("downloadUrl")?.as_str()?.to_string();

                let game_versions: Vec<String> = item
                    .get("gameVersions")
                    .and_then(|g| g.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();

                // Extract loaders from game versions (Forge, Fabric, etc.)
                let loaders: Vec<String> = game_versions
                    .iter()
                    .filter(|v| {
                        ["Forge", "Fabric", "NeoForge", "Quilt"]
                            .iter()
                            .any(|l| v.eq_ignore_ascii_case(l))
                    })
                    .cloned()
                    .collect();

                // Filter out loader names from game versions
                let game_versions: Vec<String> = game_versions
                    .into_iter()
                    .filter(|v| {
                        !["Forge", "Fabric", "NeoForge", "Quilt"]
                            .iter()
                            .any(|l| v.eq_ignore_ascii_case(l))
                    })
                    .collect();

                Some(ModpackVersionInfo {
                    id,
                    name: display_name,
                    version_number: file_name,
                    game_versions,
                    loaders,
                    downloads,
                    download_url,
                    file_size,
                })
            })
            .collect();

        Ok(results)
    }

    /// Получение деталей модпака с Modrinth
    pub async fn get_modrinth_details(project_id: &str) -> Result<ModpackDetails> {
        let url = format!("{}/project/{}", MODRINTH_API_BASE, project_id);
        let project: serde_json::Value = fetch_json(&url).await?;

        let body = project
            .get("body")
            .and_then(|b| b.as_str())
            .unwrap_or("")
            .to_string();
        let license = project
            .get("license")
            .and_then(|l| l.get("name"))
            .and_then(|n| n.as_str())
            .map(String::from);
        let source_url = project
            .get("source_url")
            .and_then(|u| u.as_str())
            .map(String::from);
        let issues_url = project
            .get("issues_url")
            .and_then(|u| u.as_str())
            .map(String::from);
        let wiki_url = project
            .get("wiki_url")
            .and_then(|u| u.as_str())
            .map(String::from);
        let discord_url = project
            .get("discord_url")
            .and_then(|u| u.as_str())
            .map(String::from);
        let followers = project.get("followers").and_then(|f| f.as_u64());
        let date_created = project
            .get("published")
            .and_then(|d| d.as_str())
            .map(String::from);
        let date_modified = project
            .get("updated")
            .and_then(|d| d.as_str())
            .map(String::from);

        // Parse gallery
        let gallery = project
            .get("gallery")
            .and_then(|g| g.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|img| {
                        Some(ModpackGalleryImage {
                            url: img.get("url")?.as_str()?.to_string(),
                            title: img.get("title").and_then(|t| t.as_str()).map(String::from),
                            description: img
                                .get("description")
                                .and_then(|d| d.as_str())
                                .map(String::from),
                            featured: img
                                .get("featured")
                                .and_then(|f| f.as_bool())
                                .unwrap_or(false),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        Ok(ModpackDetails {
            body,
            license,
            source_url,
            issues_url,
            wiki_url,
            discord_url,
            followers,
            date_created,
            date_modified,
            gallery,
        })
    }

    /// Получение деталей модпака с CurseForge
    pub async fn get_curseforge_details(project_id: &str) -> Result<ModpackDetails> {
        let pid: u64 = project_id
            .parse()
            .map_err(|_| LauncherError::InvalidConfig("Invalid project ID".to_string()))?;

        let url = format!("https://api.curseforge.com/v1/mods/{}", pid);

        let http_client = reqwest::Client::builder()
            .user_agent(crate::USER_AGENT)
            .default_headers({
                let mut headers = reqwest::header::HeaderMap::new();
                headers.insert(
                    "x-api-key",
                    "$2a$10$bL4bIL5pUWqfcO7KQtnMReakwtfHbNKh6v1uTpKlzhwoueEJQnPnm"
                        .parse()
                        .expect("valid API key header value"),
                );
                headers
            })
            .build()?;

        let response: serde_json::Value = http_client.get(&url).send().await?.json().await?;

        let data = response
            .get("data")
            .ok_or_else(|| LauncherError::ApiError("No data in response".to_string()))?;

        let body = data
            .get("summary")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string();

        // CurseForge links
        let links = data.get("links");
        let source_url = links
            .and_then(|l| l.get("sourceUrl"))
            .and_then(|u| u.as_str())
            .map(String::from);
        let issues_url = links
            .and_then(|l| l.get("issuesUrl"))
            .and_then(|u| u.as_str())
            .map(String::from);
        let wiki_url = links
            .and_then(|l| l.get("wikiUrl"))
            .and_then(|u| u.as_str())
            .map(String::from);

        let followers = data.get("thumbsUpCount").and_then(|f| f.as_u64());
        let date_created = data
            .get("dateCreated")
            .and_then(|d| d.as_str())
            .map(String::from);
        let date_modified = data
            .get("dateModified")
            .and_then(|d| d.as_str())
            .map(String::from);

        // CurseForge uses "screenshots" array
        let gallery = data
            .get("screenshots")
            .and_then(|g| g.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|img| {
                        Some(ModpackGalleryImage {
                            url: img.get("url")?.as_str()?.to_string(),
                            title: img.get("title").and_then(|t| t.as_str()).map(String::from),
                            description: img
                                .get("description")
                                .and_then(|d| d.as_str())
                                .map(String::from),
                            featured: false, // CurseForge doesn't have featured flag
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        Ok(ModpackDetails {
            body,
            license: None, // CurseForge doesn't provide license info in the same way
            source_url,
            issues_url,
            wiki_url,
            discord_url: None,
            followers,
            date_created,
            date_modified,
            gallery,
        })
    }
}
