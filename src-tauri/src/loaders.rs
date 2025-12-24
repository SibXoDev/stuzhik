use crate::downloader::{fetch_json, DownloadManager};
use crate::error::{LauncherError, Result};
use crate::paths::{instance_dir, libraries_dir};
use crate::utils::gen_short_id;
use futures::stream::{self, StreamExt};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tauri::Emitter;

/// Windows flag to hide console window
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Таймаут для Java installer процессов (3 минуты)
/// Forge/NeoForge скачивают библиотеки - может занять время на медленном соединении
const JAVA_INSTALLER_TIMEOUT_SECS: u64 = 180;

// Кэш для версий загрузчиков
lazy_static::lazy_static! {
    static ref LOADER_VERSIONS_CACHE: Arc<Mutex<HashMap<String, (Vec<FabricLoader>, std::time::Instant)>>> =
        Arc::new(Mutex::new(HashMap::new()));
    static ref NEOFORGE_VERSIONS_CACHE: Arc<Mutex<HashMap<String, (Vec<String>, std::time::Instant)>>> =
        Arc::new(Mutex::new(HashMap::new()));
    static ref FORGE_VERSIONS_CACHE: Arc<Mutex<HashMap<String, (Vec<String>, std::time::Instant)>>> =
        Arc::new(Mutex::new(HashMap::new()));
}

const CACHE_TTL_SECS: u64 = 300; // 5 минут

/// Вычисляет SHA1 хеш файла
fn calculate_sha1(data: &[u8]) -> String {
    let mut hasher = Sha1::new();
    hasher.update(data);
    let result = hasher.finalize();
    result.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Получает SHA1 хеш от maven репозитория (Forge или NeoForge)
async fn fetch_installer_sha1(installer_url: &str, loader_name: &str) -> Option<String> {
    let sha1_url = format!("{}.sha1", installer_url);
    log::info!("Fetching {} SHA1 from: {}", loader_name, sha1_url);

    match reqwest::get(&sha1_url).await {
        Ok(resp) => {
            if resp.status().is_success() {
                match resp.text().await {
                    Ok(text) => {
                        // SHA1 хеш может содержать пробелы и имя файла, берём только первые 40 символов
                        let hash = text
                            .trim()
                            .split_whitespace()
                            .next()
                            .unwrap_or("")
                            .to_lowercase();
                        if hash.len() == 40 && hash.chars().all(|c| c.is_ascii_hexdigit()) {
                            log::info!("Got official {} SHA1: {}", loader_name, hash);
                            Some(hash)
                        } else {
                            log::warn!("Invalid SHA1 format from {} maven: {}", loader_name, text);
                            None
                        }
                    }
                    Err(e) => {
                        log::warn!("Failed to read {} SHA1 response: {}", loader_name, e);
                        None
                    }
                }
            } else {
                log::warn!(
                    "{} SHA1 fetch returned status: {}",
                    loader_name,
                    resp.status()
                );
                None
            }
        }
        Err(e) => {
            log::warn!("Failed to fetch {} SHA1: {}", loader_name, e);
            None
        }
    }
}

/// Верифицирует файл по SHA1 хешу
async fn verify_installer_sha1(
    file_path: &std::path::Path,
    expected_sha1: &str,
    loader_name: &str,
) -> Result<()> {
    let content = tokio::fs::read(file_path).await?;
    let actual_sha1 = calculate_sha1(&content);

    if actual_sha1 != expected_sha1 {
        log::error!(
            "SHA1 MISMATCH for {} installer! Expected: {}, Got: {}",
            loader_name,
            expected_sha1,
            actual_sha1
        );
        let _ = tokio::fs::remove_file(file_path).await;
        return Err(LauncherError::DownloadFailed(format!(
            "{} installer SHA1 hash mismatch - possible security issue or corrupted download",
            loader_name
        )));
    }

    log::info!("{} installer SHA1 verification PASSED", loader_name);
    Ok(())
}

/// Парсит версию загрузчика в semver-совместимый формат
/// Примеры:
/// - "21.3.45-beta" -> Version { major: 21, minor: 3, patch: 45, pre: "beta" }
/// - "1.20.1-47.3.0" -> Version { major: 1, minor: 20, patch: 1, ... }
fn parse_loader_version(version: &str) -> Option<Version> {
    // Попытка распарсить как есть
    if let Ok(v) = Version::parse(version) {
        return Some(v);
    }

    // Для NeoForge версий типа "21.3.45-beta"
    // Убираем преререлизные суффиксы для парсинга
    let cleaned = version
        .replace("-beta", "+beta")
        .replace("-alpha", "+alpha")
        .replace("-rc", "+rc");

    if let Ok(v) = Version::parse(&cleaned) {
        return Some(v);
    }

    // Для Forge версий типа "1.20.1-47.3.0"
    // Берём последнюю часть как версию загрузчика
    if let Some(loader_part) = version.split('-').last() {
        if let Ok(v) = Version::parse(loader_part) {
            return Some(v);
        }
    }

    None
}

/// Сортирует версии от новых к старым (descending)
fn sort_versions_descending(versions: &mut Vec<String>) {
    versions.sort_by(|a, b| {
        match (parse_loader_version(a), parse_loader_version(b)) {
            (Some(va), Some(vb)) => vb.cmp(&va), // Обратная сортировка (новые первые)
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => b.cmp(a), // Лексикографическая обратная сортировка
        }
    });
}

// ============================================================================
// Fabric
// ============================================================================

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FabricLoader {
    #[serde(default)]
    pub separator: Option<String>,
    #[serde(default)]
    pub build: Option<u32>,
    #[serde(default)]
    pub maven: Option<String>,
    pub version: String,
    #[serde(default)]
    pub stable: bool,
}

/// Wrapper for Fabric/Quilt API response that has nested loader object
#[derive(Debug, Clone, Deserialize)]
pub struct FabricLoaderResponse {
    pub loader: FabricLoader,
    // Other fields (intermediary, launcherMeta) are not needed for version listing
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FabricProfile {
    pub id: String,
    pub libraries: Vec<FabricLibrary>,
    #[serde(rename = "mainClass")]
    pub main_class: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FabricLibrary {
    pub name: String,
    pub url: String,
}

pub struct FabricInstaller;

impl FabricInstaller {
    const API_BASE: &'static str = "https://meta.fabricmc.net/v2";

    pub async fn get_versions(minecraft_version: &str) -> Result<Vec<FabricLoader>> {
        let cache_key = format!("fabric:{}", minecraft_version);

        // Проверяем кэш
        {
            let cache = LOADER_VERSIONS_CACHE
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some((versions, timestamp)) = cache.get(&cache_key) {
                if timestamp.elapsed().as_secs() < CACHE_TTL_SECS {
                    log::debug!("Using cached Fabric versions for {}", minecraft_version);
                    return Ok(versions.clone());
                }
            }
        }

        // Загружаем версии
        log::debug!("Fetching Fabric versions for {}", minecraft_version);
        let url = format!("{}/versions/loader/{}", Self::API_BASE, minecraft_version);

        // API returns nested structure: [{ "loader": {...}, "intermediary": {...} }]
        let responses: Vec<FabricLoaderResponse> = fetch_json(&url).await?;
        let mut loaders: Vec<FabricLoader> = responses.into_iter().map(|r| r.loader).collect();

        // API уже возвращает в правильном порядке, но на всякий случай сортируем
        loaders.sort_by(|a, b| {
            // Сначала стабильные версии
            match (a.stable, b.stable) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => {
                    // Затем по build number (больше = новее)
                    match (a.build, b.build) {
                        (Some(a_build), Some(b_build)) => b_build.cmp(&a_build),
                        (Some(_), None) => std::cmp::Ordering::Less,
                        (None, Some(_)) => std::cmp::Ordering::Greater,
                        (None, None) => b.version.cmp(&a.version),
                    }
                }
            }
        });

        // Сохраняем в кэш
        {
            let mut cache = LOADER_VERSIONS_CACHE
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            cache.insert(cache_key, (loaders.clone(), std::time::Instant::now()));
        }

        Ok(loaders)
    }

    pub async fn get_latest_version(minecraft_version: &str) -> Result<String> {
        let versions = Self::get_versions(minecraft_version).await?;
        versions
            .iter()
            .find(|v| v.stable)
            .or_else(|| versions.first())
            .map(|v| v.version.clone())
            .ok_or_else(|| {
                LauncherError::LoaderVersionNotFound(
                    "fabric".to_string(),
                    minecraft_version.to_string(),
                )
            })
    }

    pub async fn install(
        instance_id: &str,
        minecraft_version: &str,
        loader_version: Option<&str>,
        download_manager: &DownloadManager,
    ) -> Result<PathBuf> {
        // Handle empty string as None - use latest version
        let version = match loader_version {
            Some(v) if !v.is_empty() => v.to_string(),
            _ => Self::get_latest_version(minecraft_version).await?,
        };

        // Получаем профиль Fabric
        let url = format!(
            "{}/versions/loader/{}/{}/profile/json",
            Self::API_BASE,
            minecraft_version,
            version
        );

        let profile: FabricProfile = fetch_json(&url).await?;

        // Скачиваем библиотеки Fabric
        let libs_dir = libraries_dir();
        for library in &profile.libraries {
            let parts: Vec<&str> = library.name.split(':').collect();
            if parts.len() < 3 {
                continue;
            }

            let path = format!(
                "{}/{}/{}/{}-{}.jar",
                parts[0].replace('.', "/"),
                parts[1],
                parts[2],
                parts[1],
                parts[2]
            );

            let lib_path = libs_dir.join(&path);
            if tokio::fs::try_exists(&lib_path).await.unwrap_or(false) {
                continue;
            }

            let url = format!("{}/{}", library.url.trim_end_matches('/'), path);

            if let Some(parent) = lib_path.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }

            download_manager
                .download_file(
                    &url,
                    &lib_path,
                    &format!("Fabric Library: {}", library.name),
                    None,
                )
                .await?;
        }

        // Создаём fabric-server-launch.jar для сервера
        let instance_path = instance_dir(instance_id);
        let launch_jar = instance_path.join("fabric-server-launch.jar");

        // Сохраняем профиль
        let profile_path = instance_path.join("fabric-profile.json");
        tokio::fs::write(&profile_path, serde_json::to_string_pretty(&profile)?).await?;

        Ok(launch_jar)
    }
}

// ============================================================================
// Quilt
// ============================================================================

pub struct QuiltInstaller;

impl QuiltInstaller {
    const API_BASE: &'static str = "https://meta.quiltmc.org/v3";

    pub async fn get_versions(minecraft_version: &str) -> Result<Vec<FabricLoader>> {
        let cache_key = format!("quilt:{}", minecraft_version);

        // Проверяем кэш
        {
            let cache = LOADER_VERSIONS_CACHE
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some((versions, timestamp)) = cache.get(&cache_key) {
                if timestamp.elapsed().as_secs() < CACHE_TTL_SECS {
                    log::debug!("Using cached Quilt versions for {}", minecraft_version);
                    return Ok(versions.clone());
                }
            }
        }

        // Загружаем версии
        log::debug!("Fetching Quilt versions for {}", minecraft_version);
        let url = format!("{}/versions/loader/{}", Self::API_BASE, minecraft_version);
        // API returns nested structure: [{ "loader": {...}, "hashed": {...} }]
        let responses: Vec<FabricLoaderResponse> = fetch_json(&url).await?;
        let mut loaders: Vec<FabricLoader> = responses.into_iter().map(|r| r.loader).collect();

        // API возвращает версии от старых к новым, переворачиваем
        loaders.reverse();

        // Стабильная сортировка: стабильные версии в начало, сохраняя порядок от новых к старым
        loaders.sort_by_key(|v| !v.stable);

        // Сохраняем в кэш
        {
            let mut cache = LOADER_VERSIONS_CACHE
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            cache.insert(cache_key, (loaders.clone(), std::time::Instant::now()));
        }

        Ok(loaders)
    }

    pub async fn get_latest_version(minecraft_version: &str) -> Result<String> {
        let versions = Self::get_versions(minecraft_version).await?;
        versions
            .iter()
            .find(|v| v.stable)
            .or_else(|| versions.first())
            .map(|v| v.version.clone())
            .ok_or_else(|| {
                LauncherError::LoaderVersionNotFound(
                    "quilt".to_string(),
                    minecraft_version.to_string(),
                )
            })
    }

    pub async fn install(
        instance_id: &str,
        minecraft_version: &str,
        loader_version: Option<&str>,
        download_manager: &DownloadManager,
    ) -> Result<PathBuf> {
        // Handle empty string as None - use latest version
        let version = match loader_version {
            Some(v) if !v.is_empty() => v.to_string(),
            _ => Self::get_latest_version(minecraft_version).await?,
        };

        let url = format!(
            "{}/versions/loader/{}/{}/profile/json",
            Self::API_BASE,
            minecraft_version,
            version
        );

        let profile: FabricProfile = fetch_json(&url).await?;

        let libs_dir = libraries_dir();
        for library in &profile.libraries {
            let parts: Vec<&str> = library.name.split(':').collect();
            if parts.len() < 3 {
                continue;
            }

            let path = format!(
                "{}/{}/{}/{}-{}.jar",
                parts[0].replace('.', "/"),
                parts[1],
                parts[2],
                parts[1],
                parts[2]
            );

            let lib_path = libs_dir.join(&path);
            if tokio::fs::try_exists(&lib_path).await.unwrap_or(false) {
                continue;
            }

            let url = format!("{}/{}", library.url.trim_end_matches('/'), path);

            if let Some(parent) = lib_path.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }

            download_manager
                .download_file(
                    &url,
                    &lib_path,
                    &format!("Quilt Library: {}", library.name),
                    None,
                )
                .await?;
        }

        let instance_path = instance_dir(instance_id);
        let launch_jar = instance_path.join("quilt-server-launch.jar");

        let profile_path = instance_path.join("quilt-profile.json");
        tokio::fs::write(&profile_path, serde_json::to_string_pretty(&profile)?).await?;

        Ok(launch_jar)
    }
}

// ============================================================================
// NeoForge
// ============================================================================

#[derive(Debug, Clone, Deserialize)]
pub struct NeoForgeApiResponse {
    pub versions: Vec<String>,
    #[serde(rename = "isSnapshot")]
    pub is_snapshot: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct NeoForgeProfile {
    pub id: String,
    #[serde(rename = "type")]
    pub profile_type: String,
    #[serde(rename = "minecraftVersion")]
    pub minecraft_version: String,
}

pub struct NeoForgeInstaller;

impl NeoForgeInstaller {
    const API_BASE: &'static str =
        "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge";

    /// Конвертирует версию Minecraft в префикс NeoForge
    /// Например: "1.21.1" -> "21.1", "1.20.4" -> "20.4"
    fn minecraft_to_neoforge_prefix(minecraft_version: &str) -> String {
        // NeoForge использует схему версионирования без "1." в начале
        // Для 1.21.1 -> 21.1
        // Для 1.20.4 -> 20.4
        if let Some(stripped) = minecraft_version.strip_prefix("1.") {
            stripped.to_string()
        } else {
            minecraft_version.to_string()
        }
    }

    pub async fn get_versions(minecraft_version: &str) -> Result<Vec<String>> {
        let cache_key = format!("neoforge:{}", minecraft_version);

        // Проверяем кэш
        {
            let cache = NEOFORGE_VERSIONS_CACHE
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some((versions, timestamp)) = cache.get(&cache_key) {
                if timestamp.elapsed().as_secs() < CACHE_TTL_SECS {
                    log::debug!("Using cached NeoForge versions for {}", minecraft_version);
                    return Ok(versions.clone());
                }
            }
        }

        // Загружаем версии
        log::debug!("Fetching NeoForge versions for {}", minecraft_version);
        let response: NeoForgeApiResponse = fetch_json(Self::API_BASE).await?;

        let neoforge_prefix = Self::minecraft_to_neoforge_prefix(minecraft_version);

        // Фильтруем и СОРТИРУЕМ версии
        let mut filtered: Vec<String> = response
            .versions
            .into_iter()
            .filter(|v| v.starts_with(&neoforge_prefix))
            .collect();

        sort_versions_descending(&mut filtered);

        // Сохраняем в кэш
        {
            let mut cache = NEOFORGE_VERSIONS_CACHE
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            cache.insert(cache_key, (filtered.clone(), std::time::Instant::now()));
        }

        Ok(filtered)
    }

    pub async fn get_latest_version(minecraft_version: &str) -> Result<String> {
        let versions = Self::get_versions(minecraft_version).await?;

        // Берем последнюю версию (они отсортированы в обратном порядке)
        versions.first().cloned().ok_or_else(|| {
            LauncherError::LoaderVersionNotFound(
                "neoforge".to_string(),
                minecraft_version.to_string(),
            )
        })
    }

    /// Валидация совместимости версии NeoForge с версией Minecraft
    fn validate_version_compatibility(
        neoforge_version: &str,
        minecraft_version: &str,
    ) -> Result<()> {
        let expected_prefix = Self::minecraft_to_neoforge_prefix(minecraft_version);

        if !neoforge_version.starts_with(&expected_prefix) {
            log::error!(
                "NeoForge version {} is incompatible with Minecraft {}. Expected prefix: {}",
                neoforge_version,
                minecraft_version,
                expected_prefix
            );
            return Err(LauncherError::InvalidConfig(
                format!(
                    "NeoForge version {} is incompatible with Minecraft {}. Expected version starting with {}",
                    neoforge_version, minecraft_version, expected_prefix
                )
            ));
        }

        log::info!(
            "Version compatibility validated: NeoForge {} <-> Minecraft {}",
            neoforge_version,
            minecraft_version
        );
        Ok(())
    }

    pub async fn install(
        instance_id: &str,
        minecraft_version: &str,
        loader_version: Option<&str>,
        download_manager: &DownloadManager,
        is_server: bool,
    ) -> Result<PathBuf> {
        // Handle empty string as None - use latest version
        let version = match loader_version {
            Some(v) if !v.is_empty() => v.to_string(),
            _ => Self::get_latest_version(minecraft_version).await?,
        };

        // Валидация совместимости версий перед установкой
        Self::validate_version_compatibility(&version, minecraft_version)?;

        let instance_path = instance_dir(instance_id);

        if is_server {
            // Для сервера скачиваем installer с SHA1 верификацией
            let installer_url = format!(
                "https://maven.neoforged.net/releases/net/neoforged/neoforge/{}/neoforge-{}-installer.jar",
                version, version
            );

            // Получаем официальный SHA1 хеш для верификации безопасности
            let expected_sha1 = fetch_installer_sha1(&installer_url, "NeoForge").await;

            let installer_path = instance_path.join("neoforge-installer.jar");

            download_manager
                .download_file(
                    &installer_url,
                    &installer_path,
                    &format!("NeoForge {} Installer", version),
                    None,
                )
                .await?;

            // Верификация SHA1 хеша
            if let Some(expected) = expected_sha1 {
                verify_installer_sha1(&installer_path, &expected, "NeoForge").await?;
            } else {
                log::warn!(
                    "Skipping SHA1 verification for NeoForge server installer (hash not available)"
                );
            }

            // Запускаем установку
            let mut cmd = tokio::process::Command::new("java");
            cmd.arg("-jar")
                .arg(&installer_path)
                .arg("--installServer")
                .current_dir(&instance_path);

            #[cfg(windows)]
            cmd.creation_flags(CREATE_NO_WINDOW);

            log::info!(
                "Running NeoForge server installer (timeout: {}s)...",
                JAVA_INSTALLER_TIMEOUT_SECS
            );
            let output = tokio::time::timeout(
                std::time::Duration::from_secs(JAVA_INSTALLER_TIMEOUT_SECS),
                cmd.output()
            ).await
                .map_err(|_| LauncherError::DownloadFailed(format!(
                    "NeoForge server installer timed out after {} seconds - server may be slow or unresponsive",
                    JAVA_INSTALLER_TIMEOUT_SECS
                )))?
                ?;

            if !output.status.success() {
                return Err(LauncherError::Archive(format!(
                    "NeoForge installation failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                )));
            }

            // Удаляем installer
            tokio::fs::remove_file(&installer_path).await?;

            // Находим jar файл
            let jar_path = instance_path.join("neoforge-server.jar");

            Ok(jar_path)
        } else {
            // Для клиента скачиваем installer и устанавливаем с SHA1 верификацией
            let installer_url = format!(
                "https://maven.neoforged.net/releases/net/neoforged/neoforge/{}/neoforge-{}-installer.jar",
                version, version
            );

            // Получаем официальный SHA1 хеш для верификации безопасности
            let expected_sha1 = fetch_installer_sha1(&installer_url, "NeoForge").await;

            let installer_path = instance_path.join("neoforge-installer.jar");

            download_manager
                .download_file(
                    &installer_url,
                    &installer_path,
                    &format!("NeoForge {} Installer", version),
                    None,
                )
                .await?;

            // Верификация SHA1 хеша
            if let Some(expected) = expected_sha1 {
                verify_installer_sha1(&installer_path, &expected, "NeoForge").await?;
            } else {
                log::warn!(
                    "Skipping SHA1 verification for NeoForge client installer (hash not available)"
                );
            }

            // Создаем минимальный launcher_profiles.json для NeoForge installer
            // NeoForge installer требует наличие этого файла от официального Minecraft launcher
            log::info!("Creating launcher_profiles.json for NeoForge installer");
            let launcher_profiles = serde_json::json!({
                "profiles": {},
                "selectedProfile": "(Default)",
                "clientToken": gen_short_id(32),
                "authenticationDatabase": {},
                "version": 3
            });

            let launcher_profiles_path = instance_path.join("launcher_profiles.json");
            let profiles_content = serde_json::to_string_pretty(&launcher_profiles)?;
            tokio::fs::write(&launcher_profiles_path, profiles_content).await?;

            // Запускаем установку клиента
            log::info!("Running NeoForge installer for client...");
            let mut cmd = tokio::process::Command::new("java");
            cmd.arg("-jar")
                .arg(&installer_path)
                .arg("--installClient")
                .arg(&instance_path)
                .current_dir(&instance_path);

            #[cfg(windows)]
            cmd.creation_flags(CREATE_NO_WINDOW);

            log::info!(
                "Running NeoForge client installer (timeout: {}s)...",
                JAVA_INSTALLER_TIMEOUT_SECS
            );
            let output = tokio::time::timeout(
                std::time::Duration::from_secs(JAVA_INSTALLER_TIMEOUT_SECS),
                cmd.output()
            ).await
                .map_err(|_| LauncherError::DownloadFailed(format!(
                    "NeoForge client installer timed out after {} seconds - server may be slow or unresponsive",
                    JAVA_INSTALLER_TIMEOUT_SECS
                )))?
                ?;

            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);

            log::info!("NeoForge installer stdout: {}", stdout);
            if !stderr.is_empty() {
                log::warn!("NeoForge installer stderr: {}", stderr);
            }

            if !output.status.success() {
                return Err(LauncherError::Archive(
                    format!(
                        "NeoForge client installation failed (exit code: {:?}):\nStdout: {}\nStderr: {}",
                        output.status.code(),
                        stdout,
                        stderr
                    )
                ));
            }

            // Проверяем какие файлы были созданы
            log::info!("Checking installed files in {:?}", instance_path);
            let entries = tokio::fs::read_dir(&instance_path).await?;
            let mut entries = entries;

            let mut possible_jar_paths = Vec::new();
            while let Some(entry) = entries.next_entry().await? {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();
                log::info!("Found file: {}", name);

                // NeoForge может создать разные файлы в зависимости от версии
                if name.ends_with(".jar") && !name.contains("installer") {
                    possible_jar_paths.push(path.clone());
                }
            }

            // Читаем launcher_profiles.json чтобы найти созданный NeoForge профиль
            log::info!("Reading NeoForge profile from launcher_profiles.json");
            let profiles_content = tokio::fs::read_to_string(&launcher_profiles_path).await?;
            let profiles_json: serde_json::Value = serde_json::from_str(&profiles_content)?;

            // Находим NeoForge профиль
            let neoforge_version =
                if let Some(profiles) = profiles_json.get("profiles").and_then(|p| p.as_object()) {
                    profiles.values().find_map(|profile| {
                        let last_version = profile.get("lastVersionId")?;
                        let version_str = last_version.as_str()?;
                        if version_str.contains("neoforge") || version_str.contains(&version) {
                            Some(version_str.to_string())
                        } else {
                            None
                        }
                    })
                } else {
                    None
                };

            log::info!("Found NeoForge version: {:?}", neoforge_version);

            // Сохраняем версию в профиль для использования при запуске
            if let Some(nf_version) = &neoforge_version {
                let profile = serde_json::json!({
                    "id": nf_version,
                    "type": "neoforge",
                    "minecraftVersion": minecraft_version
                });

                let profile_path = instance_path.join("neoforge-profile.json");
                tokio::fs::write(&profile_path, serde_json::to_string_pretty(&profile)?).await?;
                log::info!("Saved NeoForge profile to: {:?}", profile_path);

                // ВАЖНО: Загружаем библиотеки из NeoForge version JSON
                log::info!("Downloading NeoForge libraries from version JSON...");
                let version_json_path = instance_path
                    .join("versions")
                    .join(nf_version)
                    .join(format!("{}.json", nf_version));

                if tokio::fs::try_exists(&version_json_path)
                    .await
                    .unwrap_or(false)
                {
                    log::info!(
                        "Loading NeoForge version JSON from: {:?}",
                        version_json_path
                    );
                    let version_content = tokio::fs::read_to_string(&version_json_path).await?;
                    let version_json: crate::minecraft::VersionJson =
                        serde_json::from_str(&version_content)?;

                    // Загружаем библиотеки в instance/libraries
                    let instance_libs_dir = instance_path.join("libraries");
                    tokio::fs::create_dir_all(&instance_libs_dir).await?;

                    log::info!(
                        "Downloading {} NeoForge libraries...",
                        version_json.libraries.len()
                    );
                    for library in &version_json.libraries {
                        if let Some(artifact) = &library.downloads.artifact {
                            let lib_path = instance_libs_dir.join(&artifact.path);

                            // Пропускаем если уже есть
                            if tokio::fs::try_exists(&lib_path).await.unwrap_or(false) {
                                continue;
                            }

                            // Создаем директории
                            if let Some(parent) = lib_path.parent() {
                                tokio::fs::create_dir_all(parent).await?;
                            }

                            // Скачиваем библиотеку
                            log::info!("Downloading library: {}", artifact.path);
                            download_manager
                                .download_file(
                                    &artifact.url,
                                    &lib_path,
                                    &format!("NeoForge Library: {}", artifact.path),
                                    Some(&artifact.sha1),
                                )
                                .await?;
                        }
                    }
                    log::info!("NeoForge libraries downloaded successfully");
                } else {
                    log::warn!(
                        "NeoForge version JSON not found at: {:?}",
                        version_json_path
                    );
                }
            }

            // Удаляем installer, логи и временный launcher_profiles.json
            tokio::fs::remove_file(&installer_path).await.ok();
            tokio::fs::remove_file(instance_path.join("neoforge-installer.jar.log")).await.ok();
            tokio::fs::remove_file(&launcher_profiles_path).await.ok();

            // Ищем подходящий jar файл
            let jar_path = if possible_jar_paths.len() == 1 {
                possible_jar_paths[0].clone()
            } else if possible_jar_paths.is_empty() {
                // Если jar не найден, возвращаем путь к installer (для клиента NeoForge может не требовать отдельного jar)
                log::warn!("No NeoForge client jar found, this is expected for some versions");
                instance_path.join(format!("neoforge-{}.jar", version))
            } else {
                // Если несколько jar файлов, берем тот, который содержит "neoforge" в имени
                possible_jar_paths
                    .iter()
                    .find(|p| {
                        p.file_name()
                            .and_then(|n| n.to_str())
                            .map(|n| n.to_lowercase().contains("neoforge"))
                            .unwrap_or(false)
                    })
                    .cloned()
                    .unwrap_or_else(|| possible_jar_paths[0].clone())
            };

            log::info!("Using NeoForge client jar: {:?}", jar_path);
            Ok(jar_path)
        }
    }
}

// ============================================================================
// Forge (Legacy)
// ============================================================================

#[derive(Debug, Clone, Deserialize)]
pub struct ForgePromotion {
    pub homepage: String,
    pub promos: std::collections::HashMap<String, String>,
}

/// Структура для парсинга install_profile.json из Forge installer JAR
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeInstallProfile {
    #[serde(default)]
    pub spec: Option<u32>,
    #[serde(default)]
    pub libraries: Vec<ForgeInstallLibrary>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ForgeInstallLibrary {
    pub name: String,
    #[serde(default)]
    pub downloads: Option<ForgeLibraryDownloads>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ForgeLibraryDownloads {
    #[serde(default)]
    pub artifact: Option<ForgeLibraryArtifact>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ForgeLibraryArtifact {
    pub path: String,
    pub url: String,
    #[serde(default)]
    pub sha1: Option<String>,
    #[serde(default)]
    pub size: Option<u64>,
}

/// Извлекает библиотеки из Forge installer JAR (из install_profile.json И version.json)
/// ASM и другие runtime библиотеки находятся в version.json, не в install_profile.json
async fn extract_forge_install_profile(
    installer_path: &std::path::Path,
) -> Result<ForgeInstallProfile> {
    let installer_path = installer_path.to_owned();

    tokio::task::spawn_blocking(move || {
        let file = std::fs::File::open(&installer_path)?;
        let mut archive = zip::ZipArchive::new(file)?;

        let mut all_libraries: Vec<ForgeInstallLibrary> = Vec::new();
        let mut seen_names: std::collections::HashSet<String> = std::collections::HashSet::new();

        // Читаем ОБА файла и объединяем библиотеки
        let profile_names = ["install_profile.json", "version.json"];

        for name in &profile_names {
            if let Ok(mut file) = archive.by_name(name) {
                let mut contents = String::new();
                std::io::Read::read_to_string(&mut file, &mut contents)?;

                if let Ok(profile) = serde_json::from_str::<ForgeInstallProfile>(&contents) {
                    log::info!("Found {} libraries in {}", profile.libraries.len(), name);

                    for lib in profile.libraries {
                        // Дедупликация по имени
                        if !seen_names.contains(&lib.name) {
                            seen_names.insert(lib.name.clone());
                            all_libraries.push(lib);
                        }
                    }
                }
            }
        }

        if all_libraries.is_empty() {
            return Err(LauncherError::Archive(
                "No libraries found in Forge installer".to_string(),
            ));
        }

        log::info!(
            "Total unique Forge libraries to pre-download: {}",
            all_libraries.len()
        );

        Ok(ForgeInstallProfile {
            spec: Some(1),
            libraries: all_libraries,
        })
    })
    .await?
}

/// Преобразует Maven координаты в путь к файлу
/// Пример: net.minecraftforge:forge:1.20.1-47.2.0:universal -> net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-universal.jar
fn maven_to_path(maven: &str) -> Option<String> {
    let parts: Vec<&str> = maven.split(':').collect();
    if parts.len() < 3 {
        return None;
    }

    let group = parts[0].replace('.', "/");
    let artifact = parts[1];
    let version = parts[2];
    let classifier = if parts.len() > 3 {
        Some(parts[3])
    } else {
        None
    };

    let filename = if let Some(c) = classifier {
        format!("{}-{}-{}.jar", artifact, version, c)
    } else {
        format!("{}-{}.jar", artifact, version)
    };

    Some(format!("{}/{}/{}/{}", group, artifact, version, filename))
}

/// Максимальное количество параллельных загрузок библиотек
/// Библиотеки маленькие (10-500KB), CDN не имеют строгих лимитов
/// 30 - баланс между скоростью и нагрузкой на сеть
const MAX_PARALLEL_LIB_DOWNLOADS: usize = 30;

/// Информация о библиотеке для загрузки
struct LibDownloadInfo {
    name: String,
    path: String,
    original_url: String,
    sha1: Option<String>,
    target_path: PathBuf,
}

/// Предзагружает библиотеки Forge используя быстрые зеркала BMCLAPI
/// Это ускоряет установку, так как Forge installer найдёт файлы и пропустит их скачивание
async fn predownload_forge_libraries(
    profile: &ForgeInstallProfile,
    instance_libs_dir: &std::path::Path,
    download_manager: &DownloadManager,
    instance_id: &str,
) -> Result<usize> {
    let total = profile.libraries.len();
    log::info!(
        "Pre-downloading {} Forge libraries using fast mirrors (parallel: {})...",
        total,
        MAX_PARALLEL_LIB_DOWNLOADS
    );

    // Эмитим событие о начале предзагрузки
    let _ = download_manager.app_handle().emit(
        "instance-install-progress",
        serde_json::json!({
            "id": instance_id,
            "step": "loader",
            "message": format!("Предзагрузка библиотек Forge (0/{})...", total)
        }),
    );

    // Сначала собираем список библиотек для загрузки (фильтруем уже существующие)
    let mut libs_to_download: Vec<LibDownloadInfo> = Vec::new();
    let mut skipped = 0;

    for library in &profile.libraries {
        // Пробуем получить path из downloads.artifact, иначе вычисляем из Maven координат
        let (path, original_url, sha1) = if let Some(ref downloads) = library.downloads {
            if let Some(ref artifact) = downloads.artifact {
                // Если path есть в artifact, используем его
                let path = if !artifact.path.is_empty() {
                    artifact.path.clone()
                } else {
                    // path пустой, вычисляем из Maven координат
                    match maven_to_path(&library.name) {
                        Some(p) => p,
                        None => {
                            log::debug!("Cannot compute path for library: {}", library.name);
                            continue;
                        }
                    }
                };
                (path, artifact.url.clone(), artifact.sha1.clone())
            } else {
                // downloads есть, но artifact нет - вычисляем путь
                match maven_to_path(&library.name) {
                    Some(p) => (p, String::new(), None),
                    None => {
                        log::debug!("Cannot compute path for library: {}", library.name);
                        continue;
                    }
                }
            }
        } else {
            // Нет downloads вообще - вычисляем путь из Maven координат
            match maven_to_path(&library.name) {
                Some(p) => (p, String::new(), None),
                None => {
                    log::debug!("Cannot compute path for library: {}", library.name);
                    continue;
                }
            }
        };

        let target_path = instance_libs_dir.join(&path);

        if tokio::fs::try_exists(&target_path).await.unwrap_or(false) {
            skipped += 1;
            continue;
        }

        libs_to_download.push(LibDownloadInfo {
            name: library.name.clone(),
            path,
            original_url,
            sha1,
            target_path,
        });
    }

    let to_download_count = libs_to_download.len();
    log::info!(
        "Found {} libraries to download, {} already exist",
        to_download_count,
        skipped
    );

    if to_download_count == 0 {
        return Ok(0);
    }

    // Атомарные счётчики для прогресса
    let downloaded = Arc::new(AtomicUsize::new(0));
    let processed = Arc::new(AtomicUsize::new(0));

    // Зеркала Maven для библиотек
    // BMCLAPI первым - быстрее для многих регионов
    // Maven Central для ASM и других стандартных библиотек
    let maven_mirrors: &[&str] = &[
        "https://bmclapi2.bangbang93.com/maven",
        "https://maven.minecraftforge.net",
        "https://repo.maven.apache.org/maven2",
        "https://libraries.minecraft.net",
    ];

    // Параллельная загрузка с ограничением
    let results: Vec<bool> = stream::iter(libs_to_download)
        .map(|lib| {
            let download_manager = download_manager.clone();
            let instance_id = instance_id.to_string();
            let downloaded = Arc::clone(&downloaded);
            let processed = Arc::clone(&processed);

            async move {
                // Создаём директории
                if let Some(parent) = lib.target_path.parent() {
                    if let Err(e) = tokio::fs::create_dir_all(parent).await {
                        log::debug!("Failed to create dir for {}: {}", lib.name, e);
                        processed.fetch_add(1, Ordering::SeqCst);
                        return false;
                    }
                }

                // Строим список URL для попыток
                let urls: Vec<String> = if !lib.original_url.is_empty() {
                    // Заменяем известные Maven URL на BMCLAPI зеркало
                    let bmclapi_url = lib.original_url
                        .replace("https://maven.minecraftforge.net", maven_mirrors[0])
                        .replace("https://files.minecraftforge.net/maven", maven_mirrors[0])
                        .replace("https://repo.maven.apache.org/maven2", maven_mirrors[0])
                        .replace("https://repo1.maven.org/maven2", maven_mirrors[0])
                        .replace("https://libraries.minecraft.net", maven_mirrors[0]);

                    if bmclapi_url != lib.original_url {
                        vec![bmclapi_url, lib.original_url.clone()]
                    } else {
                        vec![lib.original_url.clone()]
                    }
                } else {
                    // URL пустой - пробуем все зеркала с вычисленным путём
                    maven_mirrors
                        .iter()
                        .map(|m| format!("{}/{}", m, lib.path))
                        .collect()
                };

                // Пробуем скачать с разных зеркал (с таймаутом на каждую попытку)
                // НЕ показываем отдельные библиотеки в UI - только общий прогресс
                for url in &urls {
                    // Таймаут 10 секунд на каждую попытку зеркала
                    let download_future = download_manager.download_file(
                        url,
                        &lib.target_path,
                        "",  // Пустое имя - не создаёт запись в UI
                        lib.sha1.as_deref(),
                    );

                    match tokio::time::timeout(
                        std::time::Duration::from_secs(10),
                        download_future
                    ).await {
                        Ok(Ok(())) => {
                            downloaded.fetch_add(1, Ordering::SeqCst);
                            let current = processed.fetch_add(1, Ordering::SeqCst) + 1;

                            // Обновляем прогресс каждые 10 библиотек
                            if current % 10 == 0 || current == to_download_count {
                                let _ = download_manager.app_handle().emit(
                                    "instance-install-progress",
                                    serde_json::json!({
                                        "id": instance_id,
                                        "step": "loader",
                                        "message": format!("Библиотеки Forge: {}/{}", current, to_download_count)
                                    }),
                                );
                            }
                            return true;
                        }
                        Ok(Err(_)) | Err(_) => {
                            // Тихо пробуем следующее зеркало
                        }
                    }
                }

                // Не удалось скачать
                processed.fetch_add(1, Ordering::SeqCst);
                log::debug!(
                    "Could not pre-download library: {} (installer will download it)",
                    lib.name
                );
                false
            }
        })
        .buffer_unordered(MAX_PARALLEL_LIB_DOWNLOADS)
        .collect()
        .await;

    let final_downloaded = downloaded.load(Ordering::SeqCst);
    let successful = results.iter().filter(|&&s| s).count();
    log::info!(
        "Pre-downloaded {} Forge libraries, skipped {} (already exist), {} failed (installer will download them)",
        final_downloaded,
        skipped,
        to_download_count - successful
    );
    Ok(final_downloaded)
}

pub struct ForgeInstaller;

impl ForgeInstaller {
    const PROMO_URL: &'static str =
        "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json";

    pub async fn get_versions(minecraft_version: &str) -> Result<Vec<String>> {
        let cache_key = format!("forge:{}", minecraft_version);

        // Проверяем кэш
        {
            let cache = FORGE_VERSIONS_CACHE
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some((versions, timestamp)) = cache.get(&cache_key) {
                if timestamp.elapsed().as_secs() < CACHE_TTL_SECS {
                    log::debug!("Using cached Forge versions for {}", minecraft_version);
                    return Ok(versions.clone());
                }
            }
        }

        // Загружаем версии
        log::debug!("Fetching Forge versions for {}", minecraft_version);
        let promo: ForgePromotion = fetch_json(Self::PROMO_URL).await?;

        let prefix = format!("{}-", minecraft_version);
        let mut versions: Vec<String> = promo
            .promos
            .into_iter()
            .filter_map(|(k, v)| {
                if k.starts_with(&prefix) {
                    Some(v)
                } else {
                    None
                }
            })
            .collect();

        sort_versions_descending(&mut versions);

        // Сохраняем в кэш
        {
            let mut cache = FORGE_VERSIONS_CACHE
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            cache.insert(cache_key, (versions.clone(), std::time::Instant::now()));
        }

        Ok(versions)
    }

    pub async fn get_latest_version(minecraft_version: &str) -> Result<String> {
        let promo: ForgePromotion = fetch_json(Self::PROMO_URL).await?;

        let key = format!("{}-latest", minecraft_version);
        promo.promos.get(&key).cloned().ok_or_else(|| {
            LauncherError::LoaderVersionNotFound("forge".to_string(), minecraft_version.to_string())
        })
    }

    pub async fn install(
        instance_id: &str,
        minecraft_version: &str,
        loader_version: Option<&str>,
        download_manager: &DownloadManager,
        is_server: bool,
    ) -> Result<PathBuf> {
        // Handle empty string as None - use latest version
        let version = match loader_version {
            Some(v) if !v.is_empty() => v.to_string(),
            _ => Self::get_latest_version(minecraft_version).await?,
        };

        let instance_path = instance_dir(instance_id);
        let full_version = format!("{}-{}", minecraft_version, version);

        if is_server {
            // Скачиваем installer с SHA1 верификацией
            let installer_url = format!(
                "https://maven.minecraftforge.net/net/minecraftforge/forge/{}/forge-{}-installer.jar",
                full_version, full_version
            );

            // Получаем официальный SHA1 хеш для верификации безопасности
            let expected_sha1 = fetch_installer_sha1(&installer_url, "Forge").await;

            let installer_path = instance_path.join("forge-installer.jar");

            download_manager
                .download_file(
                    &installer_url,
                    &installer_path,
                    &format!("Forge {} Installer", version),
                    None,
                )
                .await?;

            // Верификация SHA1 хеша
            if let Some(expected) = expected_sha1 {
                let content = tokio::fs::read(&installer_path).await?;
                let actual_sha1 = calculate_sha1(&content);
                if actual_sha1 != expected {
                    log::error!(
                        "SHA1 MISMATCH for Forge server installer! Expected: {}, Got: {}",
                        expected,
                        actual_sha1
                    );
                    let _ = tokio::fs::remove_file(&installer_path).await;
                    return Err(LauncherError::DownloadFailed(
                        "Forge installer SHA1 hash mismatch - possible security issue or corrupted download".to_string()
                    ));
                }
                log::info!("Forge server installer SHA1 verification PASSED");
            } else {
                log::warn!(
                    "Skipping SHA1 verification for Forge server installer (hash not available)"
                );
            }

            // Запускаем установку
            let mut cmd = tokio::process::Command::new("java");
            cmd.arg("-jar")
                .arg(&installer_path)
                .arg("--installServer")
                .current_dir(&instance_path);

            #[cfg(windows)]
            cmd.creation_flags(CREATE_NO_WINDOW);

            log::info!(
                "Running Forge server installer (timeout: {}s)...",
                JAVA_INSTALLER_TIMEOUT_SECS
            );
            let output = tokio::time::timeout(
                std::time::Duration::from_secs(JAVA_INSTALLER_TIMEOUT_SECS),
                cmd.output()
            ).await
                .map_err(|_| LauncherError::DownloadFailed(format!(
                    "Forge server installer timed out after {} seconds - server may be slow or unresponsive",
                    JAVA_INSTALLER_TIMEOUT_SECS
                )))?
                ?;

            if !output.status.success() {
                return Err(LauncherError::Archive(format!(
                    "Forge installation failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                )));
            }

            tokio::fs::remove_file(&installer_path).await?;

            // Проверяем наличие run.sh/run.bat (современный Forge 1.17+)
            let run_sh = instance_path.join("run.sh");
            let run_bat = instance_path.join("run.bat");

            if run_sh.exists() || run_bat.exists() {
                // Современный Forge использует @libraries/... для запуска
                // Возвращаем путь к libraries как маркер
                log::info!("Modern Forge detected (run script present)");
                return Ok(instance_path.join("libraries"));
            }

            // Ищем jar (legacy Forge)
            let mut jar_path: Option<PathBuf> = None;
            let mut read_dir = tokio::fs::read_dir(&instance_path).await?;
            while let Some(entry) = read_dir.next_entry().await? {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with("forge-")
                    && name.ends_with(".jar")
                    && !name.contains("installer")
                {
                    jar_path = Some(entry.path());
                    break;
                }
            }

            let jar_path = jar_path.ok_or_else(|| {
                LauncherError::Archive(
                    "Forge server jar not found. For Forge 1.17+ check for run.sh/run.bat".to_string()
                )
            })?;

            Ok(jar_path)
        } else {
            // Для клиента тоже запускаем installer
            // Официальный URL для получения SHA1 хеша
            let official_url = format!(
                "https://maven.minecraftforge.net/net/minecraftforge/forge/{}/forge-{}-installer.jar",
                full_version, full_version
            );

            // Получаем официальный SHA1 хеш для верификации безопасности
            let expected_sha1 = fetch_installer_sha1(&official_url, "Forge").await;
            if expected_sha1.is_some() {
                log::info!("Will verify Forge installer with SHA1 hash");
            } else {
                log::warn!("Could not fetch SHA1 hash from official Forge maven, will skip hash verification");
            }

            // Скачиваем Forge installer с автоматическим выбором лучшего зеркала
            // download_file_with_mirrors делает параллельные HEAD запросы (2 сек timeout)
            // и приоритизирует доступные зеркала (BMCLAPI если быстрее)
            let installer_path = instance_path.join("forge-installer.jar");

            download_manager
                .download_file_with_mirrors(
                    &official_url,
                    &installer_path,
                    &format!("Forge {} Installer", version),
                    expected_sha1.as_deref(),
                )
                .await?;

            // Проверяем размер скачанного файла
            let size = tokio::fs::metadata(&installer_path)
                .await
                .map(|m| m.len())
                .unwrap_or(0);

            if size < 1_000_000 {
                let _ = tokio::fs::remove_file(&installer_path).await;
                return Err(LauncherError::DownloadFailed(format!(
                    "Forge installer is too small ({} bytes), download may be corrupted",
                    size
                )));
            }

            // Log security status
            if expected_sha1.is_some() {
                log::info!("Forge installer security: SHA1 VERIFIED");
            } else {
                log::warn!("Forge installer security: No SHA1 hash available for verification");
            }

            // Verify the installer was downloaded and is a valid JAR
            let installer_size = tokio::fs::metadata(&installer_path)
                .await
                .map(|m| m.len())
                .unwrap_or(0);

            log::info!(
                "Forge installer downloaded: {} bytes{}",
                installer_size,
                if expected_sha1.is_some() {
                    " (SHA1 verified)"
                } else {
                    ""
                }
            );

            // Validate it's actually a valid JAR/ZIP file
            let file_content = tokio::fs::read(&installer_path).await?;

            // Check magic bytes
            if file_content.len() < 4 || &file_content[0..2] != b"PK" {
                log::error!(
                    "Forge installer is not a valid JAR file (magic bytes: {:02X?})",
                    &file_content[..std::cmp::min(4, file_content.len())]
                );
                let preview = String::from_utf8_lossy(
                    &file_content[..std::cmp::min(500, file_content.len())],
                );
                log::error!("Downloaded content preview: {}", preview);
                let _ = tokio::fs::remove_file(&installer_path).await;
                return Err(LauncherError::DownloadFailed(
                    "Downloaded file is not a valid JAR. The Forge download server may have returned an error page.".to_string()
                ));
            }

            // Try to open as ZIP to validate it's not corrupted
            let installer_path_clone = installer_path.clone();
            let zip_valid = tokio::task::spawn_blocking(move || {
                match std::fs::File::open(&installer_path_clone) {
                    Ok(file) => match zip::ZipArchive::new(file) {
                        Ok(archive) => {
                            log::info!(
                                "Forge installer validated: {} files in archive",
                                archive.len()
                            );
                            true
                        }
                        Err(e) => {
                            log::error!("Forge installer ZIP validation failed: {}", e);
                            false
                        }
                    },
                    Err(e) => {
                        log::error!("Failed to open Forge installer for validation: {}", e);
                        false
                    }
                }
            })
            .await
            .unwrap_or(false);

            if !zip_valid {
                let _ = tokio::fs::remove_file(&installer_path).await;
                return Err(LauncherError::DownloadFailed(
                    "Downloaded Forge installer is corrupted or incomplete. Please try again."
                        .to_string(),
                ));
            }
            log::info!(
                "Forge installer validated as valid JAR file ({} bytes)",
                installer_size
            );

            // ВАЖНО: Forge installer для клиента требует наличие vanilla Minecraft
            // в директории versions/<mc_version>/ для патчинга
            log::info!(
                "Ensuring vanilla Minecraft {} is available for Forge installer",
                minecraft_version
            );

            // Получаем путь к ванильному Minecraft
            let shared_version_json = crate::paths::minecraft_version_json(minecraft_version);
            let shared_version_jar = crate::paths::minecraft_version_jar(minecraft_version);

            // Проверяем есть ли ванильный клиент в shared storage
            let json_exists = tokio::fs::try_exists(&shared_version_json)
                .await
                .unwrap_or(false);
            let jar_exists = tokio::fs::try_exists(&shared_version_jar)
                .await
                .unwrap_or(false);
            if !json_exists || !jar_exists {
                log::info!(
                    "Vanilla Minecraft {} not found in shared storage, downloading...",
                    minecraft_version
                );
                crate::minecraft::MinecraftInstaller::install_version(
                    minecraft_version,
                    false, // client
                    download_manager,
                )
                .await?;
            }

            // Создаем директорию versions в instance и копируем vanilla файлы
            let instance_versions_dir = instance_path.join("versions").join(minecraft_version);
            tokio::fs::create_dir_all(&instance_versions_dir).await?;

            let instance_version_json =
                instance_versions_dir.join(format!("{}.json", minecraft_version));
            let instance_version_jar =
                instance_versions_dir.join(format!("{}.jar", minecraft_version));

            // Копируем файлы если они не существуют
            if !tokio::fs::try_exists(&instance_version_json)
                .await
                .unwrap_or(false)
            {
                log::info!("Copying vanilla version JSON to instance");
                tokio::fs::copy(&shared_version_json, &instance_version_json).await?;
            }
            if !tokio::fs::try_exists(&instance_version_jar)
                .await
                .unwrap_or(false)
            {
                log::info!("Copying vanilla client JAR to instance");
                tokio::fs::copy(&shared_version_jar, &instance_version_jar).await?;
            }

            // Также нужно скопировать библиотеки vanilla Minecraft для патчинга
            log::info!("Copying vanilla libraries for Forge patching");
            let shared_libs_dir = crate::paths::libraries_dir();
            let instance_libs_dir = instance_path.join("libraries");
            tokio::fs::create_dir_all(&instance_libs_dir).await?;

            // Читаем version JSON для получения списка библиотек
            let version_content = tokio::fs::read_to_string(&shared_version_json).await?;
            let version_json: crate::minecraft::VersionJson =
                serde_json::from_str(&version_content)?;

            for library in &version_json.libraries {
                if let Some(artifact) = &library.downloads.artifact {
                    let shared_lib_path = shared_libs_dir.join(&artifact.path);
                    let instance_lib_path = instance_libs_dir.join(&artifact.path);

                    let shared_exists = tokio::fs::try_exists(&shared_lib_path)
                        .await
                        .unwrap_or(false);
                    let instance_exists = tokio::fs::try_exists(&instance_lib_path)
                        .await
                        .unwrap_or(false);
                    if shared_exists && !instance_exists {
                        if let Some(parent) = instance_lib_path.parent() {
                            tokio::fs::create_dir_all(parent).await?;
                        }
                        tokio::fs::copy(&shared_lib_path, &instance_lib_path).await?;
                    }
                }
            }

            // ОПТИМИЗАЦИЯ: Предзагружаем библиотеки Forge используя быстрые зеркала BMCLAPI
            // Forge installer проверяет существующие файлы и пропускает их скачивание
            // Это ЗНАЧИТЕЛЬНО ускоряет установку (в 5-10 раз) так как наши зеркала быстрее
            log::info!("Pre-downloading Forge libraries from install_profile.json...");
            match extract_forge_install_profile(&installer_path).await {
                Ok(profile) => {
                    match predownload_forge_libraries(
                        &profile,
                        &instance_libs_dir,
                        download_manager,
                        instance_id,
                    )
                    .await
                    {
                        Ok(count) => {
                            log::info!(
                                "Pre-downloaded {} Forge libraries - installer should be faster!",
                                count
                            );
                        }
                        Err(e) => {
                            log::warn!("Failed to pre-download Forge libraries: {} (installer will download them)", e);
                        }
                    }
                }
                Err(e) => {
                    log::warn!("Could not extract Forge install profile: {} (installer will download libraries)", e);
                }
            }

            // Создаем минимальный launcher_profiles.json для Forge installer
            // Forge installer требует наличие этого файла от официального Minecraft launcher
            log::info!("Creating launcher_profiles.json for Forge installer");
            let launcher_profiles = serde_json::json!({
                "profiles": {},
                "selectedProfile": "(Default)",
                "clientToken": gen_short_id(32),
                "authenticationDatabase": {},
                "version": 3
            });

            let launcher_profiles_path = instance_path.join("launcher_profiles.json");
            let profiles_content = serde_json::to_string_pretty(&launcher_profiles)?;
            tokio::fs::write(&launcher_profiles_path, profiles_content).await?;

            // Запускаем установку клиента
            // Forge installer создаёт версию в указанной директории и патчит vanilla client
            log::info!(
                "Running Forge installer for client in: {}",
                instance_path.display()
            );
            log::info!("Expected vanilla client at: {:?}", instance_version_jar);

            // Эмитим событие о начале установки Forge
            let _ = download_manager.app_handle().emit(
                "instance-install-progress",
                serde_json::json!({
                    "id": instance_id,
                    "step": "loader",
                    "message": format!("Запуск Forge installer (Forge {})...", version)
                }),
            );

            let mut cmd = tokio::process::Command::new("java");
            cmd.arg("-jar")
                .arg(&installer_path)
                .arg("--installClient")
                .arg(&instance_path)
                .current_dir(&instance_path)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());

            #[cfg(windows)]
            cmd.creation_flags(CREATE_NO_WINDOW);

            log::info!(
                "Running Forge client installer (timeout: {}s)...",
                JAVA_INSTALLER_TIMEOUT_SECS
            );

            // Spawn процесс для отслеживания вывода
            let mut child = cmd.spawn().map_err(|e| {
                LauncherError::DownloadFailed(format!("Failed to start Forge installer: {}", e))
            })?;

            let stdout = child.stdout.take();
            let stderr = child.stderr.take();

            // Читаем stdout в реальном времени для логирования и определения прогресса
            let instance_id_clone = instance_id.to_string();
            let app_handle = download_manager.app_handle().clone();
            let stdout_task = tokio::spawn(async move {
                use tokio::io::{AsyncBufReadExt, BufReader};
                let mut all_output = String::new();
                if let Some(stdout) = stdout {
                    let mut reader = BufReader::new(stdout).lines();
                    while let Ok(Some(line)) = reader.next_line().await {
                        log::info!("Forge installer: {}", line);
                        all_output.push_str(&line);
                        all_output.push('\n');

                        // Эмитим прогресс если видим интересные строки
                        if line.contains("Downloading") || line.contains("downloading") {
                            let _ = app_handle.emit(
                                "instance-install-progress",
                                serde_json::json!({
                                    "id": instance_id_clone,
                                    "step": "loader",
                                    "message": format!("Forge: {}", line)
                                }),
                            );
                        } else if line.contains("Extracting") || line.contains("extracting") {
                            let _ = app_handle.emit(
                                "instance-install-progress",
                                serde_json::json!({
                                    "id": instance_id_clone,
                                    "step": "loader",
                                    "message": "Forge: Распаковка файлов..."
                                }),
                            );
                        } else if line.contains("patching") || line.contains("Patching") {
                            let _ = app_handle.emit(
                                "instance-install-progress",
                                serde_json::json!({
                                    "id": instance_id_clone,
                                    "step": "loader",
                                    "message": "Forge: Патчинг клиента..."
                                }),
                            );
                        }
                    }
                }
                all_output
            });

            // Читаем stderr
            let stderr_task = tokio::spawn(async move {
                use tokio::io::{AsyncBufReadExt, BufReader};
                let mut all_output = String::new();
                if let Some(stderr) = stderr {
                    let mut reader = BufReader::new(stderr).lines();
                    while let Ok(Some(line)) = reader.next_line().await {
                        log::warn!("Forge installer stderr: {}", line);
                        all_output.push_str(&line);
                        all_output.push('\n');
                    }
                }
                all_output
            });

            // Ждём завершения процесса с таймаутом
            let status = tokio::time::timeout(
                std::time::Duration::from_secs(JAVA_INSTALLER_TIMEOUT_SECS),
                child.wait()
            ).await
                .map_err(|_| {
                    // Убиваем процесс при таймауте
                    let _ = child.start_kill();
                    LauncherError::DownloadFailed(format!(
                        "Forge client installer timed out after {} seconds - server may be slow or unresponsive",
                        JAVA_INSTALLER_TIMEOUT_SECS
                    ))
                })?
                .map_err(|e| LauncherError::DownloadFailed(format!("Forge installer wait error: {}", e)))?;

            // Собираем вывод
            let stdout = stdout_task.await.unwrap_or_default();
            let stderr = stderr_task.await.unwrap_or_default();

            log::info!("Forge installer stdout:\n{}", stdout);
            if !stderr.is_empty() {
                log::warn!("Forge installer stderr:\n{}", stderr);
            }

            if !status.success() {
                log::error!(
                    "Forge client installation failed (exit code: {:?})",
                    status.code()
                );
                return Err(LauncherError::Archive(format!(
                    "Forge client installation failed: {}",
                    stderr
                )));
            }

            log::info!("Forge installer completed successfully");

            // Находим созданную версию Forge
            let versions_dir = instance_path.join("versions");
            let forge_version_id = if tokio::fs::try_exists(&versions_dir).await.unwrap_or(false) {
                let mut entries = tokio::fs::read_dir(&versions_dir).await?;
                let mut found_version: Option<String> = None;

                while let Some(entry) = entries.next_entry().await? {
                    // Use async metadata instead of blocking is_dir()
                    let is_dir = entry.metadata().await.map(|m| m.is_dir()).unwrap_or(false);
                    if is_dir {
                        let name = entry.file_name().to_string_lossy().to_string();
                        if name.contains("forge") && name.contains(minecraft_version) {
                            found_version = Some(name);
                            break;
                        }
                    }
                }

                found_version
            } else {
                None
            };

            // Сохраняем профиль для восстановления
            let profile = serde_json::json!({
                "minecraft_version": minecraft_version,
                "forge_version": version,
                "full_version": full_version,
                "forge_version_id": forge_version_id,
            });
            let profile_path = instance_path.join("forge-profile.json");
            tokio::fs::write(&profile_path, serde_json::to_string_pretty(&profile)?).await?;

            // ВАЖНО: Загружаем библиотеки из Forge version JSON
            // Forge installer не скачивает все библиотеки автоматически -
            // он только создает version JSON с ссылками на библиотеки
            if let Some(ref forge_id) = forge_version_id {
                log::info!("Downloading Forge libraries from version JSON...");
                let version_json_path = instance_path
                    .join("versions")
                    .join(forge_id)
                    .join(format!("{}.json", forge_id));

                if tokio::fs::try_exists(&version_json_path)
                    .await
                    .unwrap_or(false)
                {
                    log::info!("Loading Forge version JSON from: {:?}", version_json_path);
                    let version_content = tokio::fs::read_to_string(&version_json_path).await?;
                    let version_json: crate::minecraft::VersionJson =
                        serde_json::from_str(&version_content)?;

                    // Загружаем библиотеки в instance/libraries
                    let instance_libs_dir = instance_path.join("libraries");
                    tokio::fs::create_dir_all(&instance_libs_dir).await?;

                    let total_libs = version_json.libraries.len();
                    log::info!("Downloading {} Forge libraries...", total_libs);

                    // Эмитим событие о начале скачивания библиотек
                    let _ = download_manager.app_handle().emit(
                        "instance-install-progress",
                        serde_json::json!({
                            "id": instance_id,
                            "step": "loader",
                            "message": format!("Загрузка библиотек Forge (0/{})...", total_libs)
                        }),
                    );

                    let mut downloaded_count = 0;
                    let mut skipped_count = 0;
                    let mut processed_count = 0;

                    for library in &version_json.libraries {
                        if let Some(artifact) = &library.downloads.artifact {
                            let lib_path = instance_libs_dir.join(&artifact.path);

                            // Пропускаем если уже есть
                            if tokio::fs::try_exists(&lib_path).await.unwrap_or(false) {
                                skipped_count += 1;
                                continue;
                            }

                            // Создаем директории
                            if let Some(parent) = lib_path.parent() {
                                tokio::fs::create_dir_all(parent).await?;
                            }

                            // Скачиваем библиотеку
                            log::info!("Downloading Forge library: {}", artifact.path);
                            match download_manager
                                .download_file(
                                    &artifact.url,
                                    &lib_path,
                                    &format!("Forge Library: {}", artifact.path),
                                    Some(&artifact.sha1),
                                )
                                .await
                            {
                                Ok(()) => {
                                    downloaded_count += 1;
                                }
                                Err(e) => {
                                    log::warn!(
                                        "Failed to download Forge library {}: {}",
                                        artifact.path,
                                        e
                                    );
                                    // Продолжаем с остальными библиотеками
                                }
                            }
                        }
                    }

                    log::info!(
                        "Forge libraries: downloaded {}, skipped {} (already exist)",
                        downloaded_count,
                        skipped_count
                    );

                    // Проверяем наличие критических библиотек, созданных installer'ом
                    // Эти файлы не имеют download URL - они генерируются при патчинге
                    let mut missing_critical = Vec::new();
                    for library in &version_json.libraries {
                        // Проверяем библиотеки без artifact (локальные файлы)
                        if library.downloads.artifact.is_none() {
                            // Парсим имя библиотеки для получения пути
                            // Формат: group:artifact:version[:classifier]
                            let parts: Vec<&str> = library.name.split(':').collect();
                            if parts.len() >= 3 {
                                let group = parts[0].replace('.', "/");
                                let artifact_name = parts[1];
                                let ver = parts[2];
                                let classifier = if parts.len() > 3 {
                                    Some(parts[3])
                                } else {
                                    None
                                };

                                let filename = if let Some(c) = classifier {
                                    format!("{}-{}-{}.jar", artifact_name, ver, c)
                                } else {
                                    format!("{}-{}.jar", artifact_name, ver)
                                };

                                let lib_path = instance_libs_dir
                                    .join(&group)
                                    .join(artifact_name)
                                    .join(ver)
                                    .join(&filename);

                                if !tokio::fs::try_exists(&lib_path).await.unwrap_or(false) {
                                    log::warn!(
                                        "Critical Forge library missing: {} (expected at {:?})",
                                        library.name,
                                        lib_path
                                    );
                                    missing_critical.push(library.name.clone());
                                } else {
                                    log::info!("Critical Forge library found: {}", library.name);
                                }
                            }
                        }
                    }

                    if !missing_critical.is_empty() {
                        log::error!("Missing {} critical Forge libraries that should have been created by installer: {:?}",
                            missing_critical.len(), missing_critical);
                        // Не возвращаем ошибку - возможно они будут созданы позже или это ложное срабатывание
                        log::warn!("Some libraries may need to be downloaded manually or the Forge installer may have failed silently");
                    }
                } else {
                    log::warn!("Forge version JSON not found at: {:?}", version_json_path);
                }
            }

            // Удаляем installer, логи и временный launcher_profiles.json
            let _ = tokio::fs::remove_file(&installer_path).await;
            let _ = tokio::fs::remove_file(instance_path.join("forge-installer.jar.log")).await;
            let _ = tokio::fs::remove_file(&launcher_profiles_path).await;

            if let Some(forge_id) = forge_version_id {
                log::info!("Forge installed version: {}", forge_id);
                let version_dir = versions_dir.join(&forge_id);
                return Ok(version_dir.join(format!("{}.jar", forge_id)));
            }

            // Если версия не найдена, возвращаем placeholder путь
            // (фактический запуск будет через version JSON)
            Ok(instance_path
                .join("versions")
                .join(&full_version)
                .join(format!("{}.jar", full_version)))
        }
    }
}

// ============================================================================
// Unified Loader Manager
// ============================================================================

use crate::types::LoaderType;

pub struct LoaderManager;

impl LoaderManager {
    pub async fn install_loader(
        instance_id: &str,
        minecraft_version: &str,
        loader: LoaderType,
        loader_version: Option<&str>,
        is_server: bool,
        download_manager: &DownloadManager,
    ) -> Result<PathBuf> {
        match loader {
            LoaderType::Vanilla => {
                // Для Vanilla просто возвращаем путь к minecraft jar
                let jar_name = if is_server {
                    "server.jar"
                } else {
                    "client.jar"
                };
                Ok(instance_dir(instance_id).join(jar_name))
            }
            LoaderType::Fabric => {
                FabricInstaller::install(
                    instance_id,
                    minecraft_version,
                    loader_version,
                    download_manager,
                )
                .await
            }
            LoaderType::Quilt => {
                QuiltInstaller::install(
                    instance_id,
                    minecraft_version,
                    loader_version,
                    download_manager,
                )
                .await
            }
            LoaderType::NeoForge => {
                NeoForgeInstaller::install(
                    instance_id,
                    minecraft_version,
                    loader_version,
                    download_manager,
                    is_server,
                )
                .await
            }
            LoaderType::Forge => {
                ForgeInstaller::install(
                    instance_id,
                    minecraft_version,
                    loader_version,
                    download_manager,
                    is_server,
                )
                .await
            }
        }
    }

    pub async fn get_latest_loader_version(
        minecraft_version: &str,
        loader: LoaderType,
    ) -> Result<String> {
        match loader {
            LoaderType::Vanilla => Ok("vanilla".to_string()),
            LoaderType::Fabric => FabricInstaller::get_latest_version(minecraft_version).await,
            LoaderType::Quilt => QuiltInstaller::get_latest_version(minecraft_version).await,
            LoaderType::NeoForge => NeoForgeInstaller::get_latest_version(minecraft_version).await,
            LoaderType::Forge => ForgeInstaller::get_latest_version(minecraft_version).await,
        }
    }
}
