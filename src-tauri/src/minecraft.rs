use crate::db::get_db_conn;
use crate::downloader::{DownloadManager, DownloadTask};
use crate::error::{LauncherError, Result};
use crate::paths::{
    assets_dir, libraries_dir, minecraft_version_dir, minecraft_version_jar, minecraft_version_json,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::fs::File;
use std::io::Read;
use std::path::PathBuf;

const MOJANG_MANIFEST_URL: &str = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

#[derive(Debug, Deserialize, Serialize)]
pub struct VersionManifest {
    pub latest: LatestVersions,
    pub versions: Vec<VersionManifestEntry>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct LatestVersions {
    pub release: String,
    pub snapshot: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct VersionManifestEntry {
    pub id: String,
    #[serde(rename = "type")]
    pub version_type: String,
    pub url: String,
    pub time: String,
    #[serde(rename = "releaseTime")]
    pub release_time: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionJson {
    pub id: String,
    #[serde(rename = "type")]
    pub version_type: String,

    pub inherits_from: Option<String>,

    pub assets: Option<String>,
    pub asset_index: Option<AssetIndex>,
    pub downloads: Option<VersionDownloads>,

    pub libraries: Vec<Library>,
    pub main_class: String,
    pub minecraft_arguments: Option<String>,
    pub arguments: Option<Arguments>,
    pub java_version: Option<JavaVersionInfo>,
}

impl VersionJson {
    pub async fn load_with_inheritance(version_id: &str) -> Result<Self> {
        let version_path = Self::find_version_json(version_id)?;
        let content = tokio::fs::read_to_string(&version_path).await?;
        let mut version: VersionJson = serde_json::from_str(&content)?;

        if let Some(ref parent_id) = version.inherits_from {
            log::info!("Version {} inherits from {}", version_id, parent_id);

            let parent_path = minecraft_version_json(parent_id);
            if !parent_path.exists() {
                return Err(LauncherError::InvalidConfig(format!(
                    "Parent version {} not found. Install vanilla {} first.",
                    parent_id, parent_id
                )));
            }

            let parent_content = tokio::fs::read_to_string(&parent_path).await?;
            let parent: VersionJson = serde_json::from_str(&parent_content)?;

            version = version.merge_with_parent(parent);
        }

        Ok(version)
    }

    pub fn load_with_inheritance_sync(version_id: &str) -> Result<Self> {
        let version_path = Self::find_version_json(version_id)?;
        let content = std::fs::read_to_string(&version_path)?;
        let mut version: VersionJson = serde_json::from_str(&content)?;

        if let Some(ref parent_id) = version.inherits_from {
            log::info!("Version {} inherits from {}", version_id, parent_id);

            let parent_path = minecraft_version_json(parent_id);
            if !parent_path.exists() {
                return Err(LauncherError::InvalidConfig(format!(
                    "Parent version {} not found",
                    parent_id
                )));
            }

            let parent_content = std::fs::read_to_string(&parent_path)?;
            let parent: VersionJson = serde_json::from_str(&parent_content)?;

            version = version.merge_with_parent(parent);
        }

        Ok(version)
    }

    fn find_version_json(version_id: &str) -> Result<PathBuf> {
        let shared_path = minecraft_version_json(version_id);
        if shared_path.exists() {
            return Ok(shared_path);
        }

        let base_dir = crate::paths::get_base_dir();
        let instances_dir = base_dir.join("instances");

        if instances_dir.exists() {
            for entry in std::fs::read_dir(&instances_dir)? {
                let entry = entry?;
                let instance_version_path = entry
                    .path()
                    .join("versions")
                    .join(version_id)
                    .join(format!("{}.json", version_id));

                if instance_version_path.exists() {
                    log::info!(
                        "Found version JSON in instance: {:?}",
                        instance_version_path
                    );
                    return Ok(instance_version_path);
                }
            }
        }

        Err(LauncherError::InvalidConfig(format!(
            "Version {} JSON not found",
            version_id
        )))
    }

    fn merge_with_parent(mut self, parent: VersionJson) -> Self {
        if self.assets.is_none() {
            self.assets = parent.assets;
        }
        if self.asset_index.is_none() {
            self.asset_index = parent.asset_index;
        }
        if self.downloads.is_none() {
            self.downloads = parent.downloads;
        }

        let mut merged_libraries = parent.libraries;
        merged_libraries.extend(self.libraries);
        self.libraries = merged_libraries;

        if let Some(ref mut self_args) = self.arguments {
            if let Some(parent_args) = parent.arguments {
                let mut merged_game = parent_args.game;
                merged_game.extend(self_args.game.clone());
                self_args.game = merged_game;

                let mut merged_jvm = parent_args.jvm;
                merged_jvm.extend(self_args.jvm.clone());
                self_args.jvm = merged_jvm;
            }
        } else {
            self.arguments = parent.arguments;
        }

        if self.minecraft_arguments.is_none() {
            self.minecraft_arguments = parent.minecraft_arguments;
        }

        if self.java_version.is_none() {
            self.java_version = parent.java_version;
        }

        self
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct JavaVersionInfo {
    #[serde(rename = "majorVersion")]
    pub major_version: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AssetIndex {
    pub id: String,
    pub url: String,
    pub sha1: String,
    pub size: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct VersionDownloads {
    pub client: Option<DownloadInfo>,
    pub server: Option<DownloadInfo>,
    pub client_mappings: Option<DownloadInfo>,
    pub server_mappings: Option<DownloadInfo>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DownloadInfo {
    pub url: String,
    pub sha1: String,
    pub size: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Library {
    pub name: String,
    pub downloads: LibraryDownloads,
    pub rules: Option<Vec<Rule>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LibraryDownloads {
    pub artifact: Option<Artifact>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Artifact {
    pub path: String,
    pub url: String,
    pub sha1: String,
    pub size: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Rule {
    pub action: String,
    pub os: Option<OsRule>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct OsRule {
    pub name: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Arguments {
    pub game: Vec<ArgumentValue>,
    pub jvm: Vec<ArgumentValue>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub enum ArgumentValue {
    String(String),
    Object(ArgumentObject),
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ArgumentObject {
    pub rules: Vec<Rule>,
    pub value: ArgumentValueType,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub enum ArgumentValueType {
    String(String),
    Array(Vec<String>),
}

#[derive(Debug, Deserialize, Serialize)]
pub struct AssetIndexJson {
    pub objects: std::collections::HashMap<String, AssetObject>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct AssetObject {
    pub hash: String,
    pub size: u64,
}

pub struct MinecraftInstaller;

impl MinecraftInstaller {
    pub async fn fetch_version_manifest() -> Result<VersionManifest> {
        let response = crate::utils::SHARED_HTTP_CLIENT.get(MOJANG_MANIFEST_URL).send().await.map_err(|e| {
            log::error!(
                "Failed to fetch Mojang manifest from {}: {}",
                MOJANG_MANIFEST_URL,
                e
            );
            LauncherError::ApiError(format!("Failed to fetch Mojang manifest: {}", e))
        })?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            log::error!("Mojang manifest HTTP {}: {}", status, body);
            return Err(LauncherError::ApiError(format!(
                "Mojang API returned HTTP {}: {}",
                status,
                &body[..body.len().min(200)]
            )));
        }

        let text = response.text().await.map_err(|e| {
            log::error!("Failed to read Mojang manifest response: {}", e);
            LauncherError::ApiError(format!("Failed to read response body: {}", e))
        })?;

        let manifest: VersionManifest = serde_json::from_str(&text).map_err(|e| {
            log::error!("Failed to parse Mojang manifest JSON: {}", e);
            log::debug!(
                "Response body (first 500 chars): {}",
                &text[..text.len().min(500)]
            );
            LauncherError::ApiError(format!(
                "Invalid JSON from Mojang API: {} (URL: {})",
                e, MOJANG_MANIFEST_URL
            ))
        })?;

        Ok(manifest)
    }

    pub async fn cache_versions() -> Result<()> {
        // Check cache freshness (scoped to drop conn before async)
        let needs_update = {
            let conn = get_db_conn()?;
            let cache_check: std::result::Result<String, _> = conn.query_row(
                "SELECT cached_at FROM minecraft_versions ORDER BY cached_at DESC LIMIT 1",
                [],
                |row| row.get(0),
            );

            if let Ok(last_cached) = cache_check {
                if let Ok(cached_time) = chrono::DateTime::parse_from_rfc3339(&last_cached) {
                    let now = Utc::now();
                    let duration = now.signed_duration_since(cached_time);

                    if duration.num_hours() < 24 {
                        log::debug!(
                            "Minecraft versions cache is fresh (last update: {} hours ago)",
                            duration.num_hours()
                        );
                        false
                    } else {
                        true
                    }
                } else {
                    true
                }
            } else {
                true
            }
        }; // conn dropped here

        if !needs_update {
            return Ok(());
        }

        log::info!("Updating Minecraft versions cache...");
        let manifest = Self::fetch_version_manifest().await?;
        log::info!("Caching {} Minecraft versions", manifest.versions.len());

        // Re-acquire conn for inserts (after async fetch)
        let conn = get_db_conn()?;
        for version in &manifest.versions {
            let java_version = Self::estimate_java_version(&version.id);

            conn.execute(
                "INSERT OR REPLACE INTO minecraft_versions (id, type, release_time, url, java_version, cached_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![
                    &version.id,
                    &version.version_type,
                    &version.release_time,
                    &version.url,
                    java_version as i32,
                    Utc::now().to_rfc3339(),
                ],
            )?;
        }

        log::info!("Successfully cached versions");
        Ok(())
    }

    fn estimate_java_version(mc_version: &str) -> u32 {
        let parts: Vec<&str> = mc_version.split('.').collect();

        if parts.len() < 2 {
            return 8;
        }

        let minor = parts[1].parse::<u32>().unwrap_or(0);

        match minor {
            0..=16 => 8,
            17 => 16,
            18..=20 => 17,
            _ => 21,
        }
    }

    pub async fn install_version(
        version_id: &str,
        is_server: bool,
        download_manager: &DownloadManager,
    ) -> Result<PathBuf> {
        log::info!("Installing Minecraft version: {}", version_id);

        let version_dir = minecraft_version_dir(version_id);
        tokio::fs::create_dir_all(&version_dir).await?;

        let version_json_path = minecraft_version_json(version_id);

        if !version_json_path.exists() {
            let conn = get_db_conn()?;
            let url: String = conn.query_row(
                "SELECT url FROM minecraft_versions WHERE id = ?1",
                rusqlite::params![version_id],
                |row| row.get(0),
            )?;

            download_manager
                .download_file(
                    &url,
                    &version_json_path,
                    &format!("Minecraft {} Manifest", version_id),
                    None,
                )
                .await?;
        }

        let content = tokio::fs::read_to_string(&version_json_path).await?;
        let version_json: VersionJson = serde_json::from_str(&content)?;

        let jar_path = minecraft_version_jar(version_id);

        if !jar_path.exists() {
            let downloads = version_json.downloads.as_ref().ok_or_else(|| {
                LauncherError::DownloadFailed("No downloads in version JSON".to_string())
            })?;

            let download_info = if is_server {
                downloads.server.as_ref()
            } else {
                downloads.client.as_ref()
            }
            .ok_or_else(|| {
                LauncherError::DownloadFailed(format!(
                    "{} JAR not available",
                    if is_server { "Server" } else { "Client" }
                ))
            })?;

            download_manager
                .download_file(
                    &download_info.url,
                    &jar_path,
                    &format!(
                        "Minecraft {} {}",
                        version_id,
                        if is_server { "Server" } else { "Client" }
                    ),
                    Some(&download_info.sha1),
                )
                .await?;
        }

        Self::download_libraries(&version_json, download_manager).await?;

        if !is_server {
            Self::download_assets(&version_json, download_manager).await?;
        }

        Ok(jar_path)
    }

    async fn download_libraries(
        version_json: &VersionJson,
        download_manager: &DownloadManager,
    ) -> Result<()> {
        let libs_dir = libraries_dir();
        let mut tasks = Vec::new();

        for library in &version_json.libraries {
            if let Some(rules) = &library.rules {
                if !Self::check_rules(rules) {
                    continue;
                }
            }

            if let Some(artifact) = &library.downloads.artifact {
                let lib_path = libs_dir.join(&artifact.path);

                if lib_path.exists() && crate::utils::verify_file_hash(&lib_path, &artifact.sha1)? {
                    continue;
                }

                tasks.push(
                    DownloadTask::new(artifact.url.clone(), lib_path, library.name.clone())
                        .with_hash(artifact.sha1.clone()),
                );
            }
        }

        if !tasks.is_empty() {
            // Libraries - средний размер (50KB-5MB), используем умеренную параллельность
            download_manager.download_batch(tasks, 16).await?;
        }

        Ok(())
    }

    async fn download_assets(
        version_json: &VersionJson,
        download_manager: &DownloadManager,
    ) -> Result<()> {
        let asset_index = version_json
            .asset_index
            .as_ref()
            .ok_or_else(|| LauncherError::InvalidConfig("Asset index not found".to_string()))?;

        let assets_indexes_dir = assets_dir().join("indexes");
        tokio::fs::create_dir_all(&assets_indexes_dir).await?;

        let asset_index_path = assets_indexes_dir.join(format!("{}.json", asset_index.id));

        download_manager
            .download_file(
                &asset_index.url,
                &asset_index_path,
                &format!("Asset Index {}", asset_index.id),
                Some(&asset_index.sha1),
            )
            .await?;

        let asset_index_content = tokio::fs::read_to_string(&asset_index_path).await?;
        let asset_index_json: AssetIndexJson = serde_json::from_str(&asset_index_content)?;

        let objects_dir = assets_dir().join("objects");
        let mut tasks = Vec::new();

        for (_, asset) in asset_index_json.objects.iter() {
            let hash = &asset.hash;
            let prefix = &hash[0..2];
            let asset_path = objects_dir.join(prefix).join(hash);

            if asset_path.exists() && crate::utils::verify_file_hash(&asset_path, hash)? {
                continue;
            }

            let url = format!(
                "https://resources.download.minecraft.net/{}/{}",
                prefix, hash
            );

            tasks.push(
                DownloadTask::new(url, asset_path, format!("Asset {}", hash))
                    .with_hash(hash.clone()),
            );
        }

        if !tasks.is_empty() {
            // Assets - мелкие файлы (1-50KB), можно качать много параллельно
            download_manager.download_batch(tasks, 64).await?;
        }

        Ok(())
    }

    fn check_rules(rules: &[Rule]) -> bool {
        let current_os = std::env::consts::OS;
        let os_name = match current_os {
            "windows" => "windows",
            "macos" => "osx",
            "linux" => "linux",
            _ => return false,
        };

        let mut allowed = false;

        for rule in rules {
            let matches = if let Some(os) = &rule.os {
                os.name.as_deref() == Some(os_name)
            } else {
                true
            };

            if rule.action == "allow" && matches {
                allowed = true;
            } else if rule.action == "disallow" && matches {
                allowed = false;
            }
        }

        allowed
    }

    /// Вычисляет SHA1 хеш файла для проверки целостности
    fn calculate_sha1(path: &PathBuf) -> Result<String> {
        let mut file = File::open(path).map_err(|e| {
            LauncherError::Io(std::io::Error::new(
                e.kind(),
                format!("Failed to open file for checksum: {:?}", path),
            ))
        })?;

        let mut hasher = Sha1::new();
        let mut buffer = [0u8; 8192];

        loop {
            let n = file.read(&mut buffer).map_err(|e| {
                LauncherError::Io(std::io::Error::new(
                    e.kind(),
                    format!("Failed to read file for checksum: {:?}", path),
                ))
            })?;
            if n == 0 {
                break;
            }
            hasher.update(&buffer[..n]);
        }

        let hash = hasher.finalize();
        Ok(format!("{:x}", hash))
    }

    /// Проверяет целостность JAR файла по SHA1 хешу
    fn verify_jar_integrity(path: &PathBuf, expected_sha1: &str) -> Result<bool> {
        let actual_sha1 = Self::calculate_sha1(path)?;

        if actual_sha1.to_lowercase() != expected_sha1.to_lowercase() {
            log::error!(
                "JAR integrity check failed for {:?}. Expected: {}, Got: {}",
                path.file_name().unwrap_or_default(),
                expected_sha1,
                actual_sha1
            );
            return Ok(false);
        }

        log::debug!(
            "JAR integrity verified: {:?}",
            path.file_name().unwrap_or_default()
        );
        Ok(true)
    }

    pub fn generate_classpath(version_id: &str) -> Result<String> {
        let version_json = VersionJson::load_with_inheritance_sync(version_id)?;
        Self::generate_classpath_from_json(&version_json)
    }

    pub fn generate_classpath_from_json(version_json: &VersionJson) -> Result<String> {
        Self::generate_classpath_with_instance(version_json, None, true)
    }

    pub fn generate_classpath_with_instance(
        version_json: &VersionJson,
        instance_path: Option<&PathBuf>,
        include_minecraft_jar: bool,
    ) -> Result<String> {
        let shared_libs_dir = libraries_dir();
        let mut classpath_entries = Vec::new();
        let mut seen_paths = std::collections::HashSet::new();

        // Для загрузчиков используем JAR родительской версии
        let jar_version = version_json
            .inherits_from
            .as_ref()
            .unwrap_or(&version_json.id);

        // Для NeoForge/Forge пропускаем оригинальный Minecraft JAR
        // Они предоставляют свой собственный ремапленный JAR (client-*-srg.jar)
        if include_minecraft_jar {
            log::info!("Looking for JAR of version: {}", jar_version);

            let jar_candidates = if let Some(inst_path) = instance_path {
                vec![
                    minecraft_version_jar(jar_version),
                    inst_path
                        .join("versions")
                        .join(&version_json.id)
                        .join(format!("{}.jar", &version_json.id)),
                    inst_path
                        .join("versions")
                        .join(jar_version)
                        .join(format!("{}.jar", jar_version)),
                ]
            } else {
                vec![minecraft_version_jar(jar_version)]
            };

            let jar_path = jar_candidates
                .into_iter()
                .find(|p| {
                    let exists = p.exists();
                    log::debug!("Checking JAR: {:?} - exists: {}", p, exists);
                    exists
                })
                .ok_or_else(|| {
                    log::error!(
                        "Minecraft JAR not found for version {} (parent: {:?})",
                        version_json.id,
                        version_json.inherits_from
                    );
                    LauncherError::InvalidConfig(format!(
                        "Minecraft JAR not found for version {}. Parent: {:?}",
                        jar_version, version_json.inherits_from
                    ))
                })?;

            log::info!("Using Minecraft JAR: {:?}", jar_path);
            // КРИТИЧНО: Minecraft JAR должен быть ПЕРВЫМ в classpath для правильной загрузки классов
            classpath_entries.push(jar_path.to_string_lossy().to_string());
        } else {
            log::info!("Skipping Minecraft JAR (loader provides its own remapped client)");
        }

        for library in &version_json.libraries {
            if let Some(rules) = &library.rules {
                if !Self::check_rules(rules) {
                    continue;
                }
            }

            if let Some(artifact) = &library.downloads.artifact {
                let shared_lib_path = shared_libs_dir.join(&artifact.path);

                let lib_path = if shared_lib_path.exists() {
                    shared_lib_path
                } else if let Some(inst_path) = instance_path {
                    let instance_lib_path = inst_path.join("libraries").join(&artifact.path);
                    if instance_lib_path.exists() {
                        instance_lib_path
                    } else {
                        log::warn!("Library not found: {}", artifact.path);
                        continue;
                    }
                } else {
                    log::warn!("Library not found: {}", artifact.path);
                    continue;
                };

                // Проверка целостности JAR файлов (для критичных библиотек)
                let is_critical = artifact.path.to_lowercase().contains("minecraft")
                    || artifact.path.to_lowercase().contains("forge")
                    || artifact.path.to_lowercase().contains("neoforge");

                if is_critical {
                    match Self::verify_jar_integrity(&lib_path, &artifact.sha1) {
                        Ok(true) => {
                            log::info!(
                                "Integrity verified for critical library: {}",
                                artifact.path
                            );
                        }
                        Ok(false) => {
                            log::warn!(
                                "Integrity check failed for {}, but continuing (may cause issues)",
                                artifact.path
                            );
                            // Продолжаем, но с предупреждением - можно сделать строгим, вернув ошибку
                        }
                        Err(e) => {
                            log::warn!("Failed to verify integrity for {}: {}", artifact.path, e);
                        }
                    }
                }

                let lib_path_str = lib_path.to_string_lossy().to_string();

                // Дедупликация только по полному пути библиотеки
                // Это позволяет избежать конфликтов между log4j-api, log4j-core и т.д.
                // Maven путь вида "org/apache/logging/log4j/log4j-core/2.22.1/..." уже уникален
                if seen_paths.insert(lib_path_str.clone()) {
                    classpath_entries.push(lib_path_str);
                } else {
                    log::debug!("Skipping duplicate library path: {}", lib_path.display());
                }
            }
        }

        let separator = if cfg!(windows) { ";" } else { ":" };
        Ok(classpath_entries.join(separator))
    }

    pub fn get_jvm_arguments(
        version_id: &str,
        classpath: &str,
        natives_dir: &PathBuf,
    ) -> Result<Vec<String>> {
        let version_json = VersionJson::load_with_inheritance_sync(version_id)?;

        let mut args = Vec::new();

        if let Some(arguments) = &version_json.arguments {
            for arg in &arguments.jvm {
                match arg {
                    ArgumentValue::String(s) => args.push(s.clone()),
                    ArgumentValue::Object(obj) => {
                        if Self::check_rules(&obj.rules) {
                            match &obj.value {
                                ArgumentValueType::String(s) => args.push(s.clone()),
                                ArgumentValueType::Array(arr) => args.extend(arr.clone()),
                            }
                        }
                    }
                }
            }
        }

        // Замены для JVM аргументов
        let natives_dir_str = natives_dir.to_string_lossy().to_string();
        let replacements = [
            ("${natives_directory}", natives_dir_str.as_str()),
            ("${launcher_name}", "minecraft-launcher"),
            ("${launcher_version}", "1.0.0"),
            ("${classpath}", classpath),
        ];

        for arg in &mut args {
            for (pattern, value) in &replacements {
                *arg = arg.replace(pattern, value);
            }
        }

        Ok(args)
    }

    pub fn get_game_arguments(
        version_id: &str,
        username: &str,
        uuid: &str,
        access_token: &str,
        game_dir: &PathBuf,
        assets_root: &PathBuf,
    ) -> Result<Vec<String>> {
        let version_json = VersionJson::load_with_inheritance_sync(version_id)?;

        let mut args = Vec::new();

        if let Some(arguments) = &version_json.arguments {
            for arg in &arguments.game {
                match arg {
                    ArgumentValue::String(s) => args.push(s.clone()),
                    ArgumentValue::Object(obj) => {
                        if Self::check_rules(&obj.rules) {
                            match &obj.value {
                                ArgumentValueType::String(s) => args.push(s.clone()),
                                ArgumentValueType::Array(arr) => args.extend(arr.clone()),
                            }
                        }
                    }
                }
            }
        } else if let Some(minecraft_arguments) = &version_json.minecraft_arguments {
            args.extend(minecraft_arguments.split_whitespace().map(String::from));
        }

        let assets_index = version_json.assets.as_deref().unwrap_or("legacy");

        let replacements = [
            ("${auth_player_name}", username),
            ("${version_name}", version_id),
            ("${game_directory}", &game_dir.to_string_lossy()),
            ("${assets_root}", &assets_root.to_string_lossy()),
            ("${assets_index_name}", assets_index),
            ("${auth_uuid}", uuid),
            ("${auth_access_token}", access_token),
            ("${user_type}", "legacy"),
            ("${version_type}", &version_json.version_type),
            ("${user_properties}", "{}"),
            ("${auth_session}", access_token),
            ("${clientid}", ""),
            ("${auth_xuid}", ""),
            ("${resolution_width}", "854"),  // Default resolution
            ("${resolution_height}", "480"), // Default resolution
            // QuickPlay аргументы - по умолчанию пустые (будут удалены ниже если не используются)
            ("${quickPlayPath}", ""),
            ("${quickPlaySingleplayer}", ""),
            ("${quickPlayMultiplayer}", ""),
            ("${quickPlayRealms}", ""),
        ];

        for arg in &mut args {
            for (placeholder, value) in &replacements {
                *arg = arg.replace(placeholder, value);
            }
        }

        // Удаляем аргументы с незамененными шаблонными переменными или пустыми значениями
        let mut i = 0;
        while i < args.len() {
            let arg = &args[i];

            // Удаляем --demo
            if arg == "--demo" {
                args.remove(i);
                continue;
            }

            // Удаляем аргументы с нерезолвленными шаблонами
            if arg.contains("${") && arg.contains("}") {
                log::debug!("Removing argument with unresolved template: {}", arg);
                args.remove(i);
                continue;
            }

            // Удаляем пары флаг-значение где значение пустое (например, quickPlay аргументы)
            // Проверяем флаги, которые принимают значение
            if arg == "--quickPlayPath"
                || arg == "--quickPlaySingleplayer"
                || arg == "--quickPlayMultiplayer"
                || arg == "--quickPlayRealms"
            {
                // Если следующий аргумент пустой, удаляем оба
                if i + 1 < args.len() && args[i + 1].is_empty() {
                    log::debug!("Removing empty quickPlay argument: {} (empty value)", arg);
                    args.remove(i); // Удаляем флаг
                    if i < args.len() {
                        args.remove(i); // Удаляем пустое значение
                    }
                    continue;
                }
            }

            i += 1;
        }

        Ok(args)
    }
}
