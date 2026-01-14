use crate::db::get_db_conn;
use crate::downloader::DownloadManager;
use crate::error::{LauncherError, Result};
use crate::paths::java_dir;
use crate::types::OneOrMany;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

/// Windows flag to hide console window
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const ADOPTIUM_API: &str = "https://api.adoptium.net/v3";

#[derive(Debug, Deserialize)]
pub struct AdoptiumRelease {
    #[serde(rename = "binary")]
    pub binary: OneOrMany<AdoptiumBinary>,
    #[serde(default)]
    pub release_link: String,
    #[serde(default)]
    pub release_name: String,
    #[serde(default)]
    pub vendor: String,
    #[serde(default)]
    pub version_data: Option<AdoptiumVersion>,
}

#[derive(Debug, Deserialize)]
pub struct AdoptiumVersion {
    pub build: Option<u32>,
    pub major: u32,
    pub minor: u32,
    pub openjdk_version: Option<String>,
    pub security: u32,
    pub semver: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AdoptiumBinary {
    pub architecture: String,
    pub download_count: u64,
    pub heap_size: String,
    pub image_type: String,
    pub installer: AdoptiumPackage,
    pub jvm_impl: Option<String>,
    pub os: String,
    pub package: AdoptiumPackage,
    pub project: String,
    pub scm_ref: String,
    pub updated_at: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AdoptiumPackage {
    pub checksum: Option<String>,
    pub checksum_link: Option<String>,
    pub download_count: Option<u64>,
    pub link: String,
    pub metadata_link: Option<String>,
    pub name: String,
    pub signature_link: Option<String>,
    pub size: Option<u64>,
}

/// Информация о найденной системной Java
#[derive(Debug, Clone, Serialize)]
pub struct SystemJavaInfo {
    pub path: String,
    pub version: String,
    pub major_version: u32,
    pub vendor: Option<String>,
    pub is_already_added: bool,
}

pub struct JavaManager;

impl JavaManager {
    /// Определение необходимой версии Java для версии Minecraft
    pub fn required_java_version(minecraft_version: &str) -> u32 {
        let parts: Vec<&str> = minecraft_version.split('.').collect();
        if parts.is_empty() {
            return 17;
        }

        let major: u32 = parts[0].parse().unwrap_or(1);
        let minor: u32 = if parts.len() > 1 {
            parts[1].parse().unwrap_or(0)
        } else {
            0
        };

        match (major, minor) {
            (1, 0..=16) => 8,
            (1, 17..=19) => 17,
            (1, 20..=20) => 17,
            (1, 21..) => 21,
            _ => 17,
        }
    }

    /// Проверка наличия установленной Java
    pub async fn get_installed_java(version: &str) -> Result<Option<PathBuf>> {
        let conn = get_db_conn()?;
        let mut stmt = conn.prepare("SELECT path FROM java_installations WHERE version = ?1")?;

        let path: Option<String> = stmt.query_row([version], |row| row.get(0)).ok();

        if let Some(p) = path {
            let path = PathBuf::from(p);
            if path.exists() {
                return Ok(Some(path));
            }
        }

        Ok(None)
    }

    /// Поиск Java в системе
    pub async fn find_system_java() -> Option<PathBuf> {
        if let Ok(java_home) = std::env::var("JAVA_HOME") {
            let java = if cfg!(windows) {
                PathBuf::from(&java_home).join("bin/java.exe")
            } else {
                PathBuf::from(&java_home).join("bin/java")
            };

            if java.exists() {
                return Some(java);
            }
        }

        // Try to run java -version with a timeout to prevent hanging
        let check_java = async {
            let mut cmd = tokio::process::Command::new("java");
            cmd.arg("-version");

            #[cfg(windows)]
            cmd.creation_flags(CREATE_NO_WINDOW);

            cmd.output().await
        };

        if let Ok(Ok(output)) = timeout(Duration::from_secs(5), check_java).await {
            if output.status.success() {
                return Some(PathBuf::from("java"));
            }
        }

        None
    }

    /// Получение версии установленной Java (with timeout to prevent hanging)
    pub async fn get_java_version(java_path: &Path) -> Option<String> {
        let path = java_path.to_path_buf();

        let get_version = async move {
            let mut cmd = tokio::process::Command::new(&path);
            cmd.arg("-version");

            #[cfg(windows)]
            cmd.creation_flags(CREATE_NO_WINDOW);

            cmd.output().await
        };

        let output = match timeout(Duration::from_secs(5), get_version).await {
            Ok(Ok(out)) => out,
            Ok(Err(e)) => {
                log::warn!("Failed to get Java version: {}", e);
                return None;
            }
            Err(_) => {
                log::warn!("Timeout getting Java version from {:?}", java_path);
                return None;
            }
        };

        let stderr = String::from_utf8_lossy(&output.stderr);

        for line in stderr.lines() {
            if line.contains("version") {
                if let Some(version) = line.split('"').nth(1) {
                    let major = version.split('.').next()?;
                    return Some(major.to_string());
                }
            }
        }

        None
    }

    /// Автоматическая установка Java с поддержкой отмены и зеркал
    pub async fn install_java(
        version: u32,
        download_manager: &DownloadManager,
        cancel_token: &CancellationToken,
        operation_id: Option<&str>,
    ) -> Result<PathBuf> {
        // let os = if cfg!(target_os = "windows") {
        //     "windows"
        // } else if cfg!(target_os = "macos") {
        //     "mac"
        // } else {
        //     "linux"
        // };

        let arch = if cfg!(target_arch = "x86_64") {
            "x64"
        } else if cfg!(target_arch = "aarch64") {
            "aarch64"
        } else {
            return Err(LauncherError::InvalidConfig(
                "Unsupported architecture".to_string(),
            ));
        };

        let os = {
            match std::env::consts::OS {
                "windows" => "windows",
                "linux" => "linux",
                "macos" => "macos",
                "freebsd" => "freebsd",
                "dragonfly" => "freebsd", // нет отдельного в API
                "netbsd" | "openbsd" => "bsd",
                other => {
                    eprintln!("Unknown OS: {}", other);
                    "unknown"
                }
            }
        };

        // Получаем список релизов
        let url = format!(
            "{}/assets/latest/{}/hotspot?architecture={}&os={}&image_type=jdk",
            ADOPTIUM_API, version, arch, os
        );

        log::info!("Fetching Java releases from Adoptium API: {}", url);

        let response = reqwest::Client::builder()
            .user_agent(crate::USER_AGENT)
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| LauncherError::ApiError(format!("Failed to build HTTP client: {}", e)))?
            .get(&url)
            .send()
            .await
            .map_err(|e| {
                log::error!("Failed to fetch Java releases from {}: {}", url, e);
                LauncherError::ApiError(format!("Failed to fetch Java releases: {}", e))
            })?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            log::error!("Adoptium API HTTP {}: {}", status, body);
            return Err(LauncherError::ApiError(format!(
                "Adoptium API returned HTTP {}: {} (URL: {})",
                status,
                &body[..body.len().min(200)],
                url
            )));
        }

        let text = response.text().await.map_err(|e| {
            log::error!("Failed to read Adoptium API response: {}", e);
            LauncherError::ApiError(format!("Failed to read Adoptium response body: {}", e))
        })?;

        let releases: Vec<AdoptiumRelease> = serde_json::from_str(&text).map_err(|e| {
            log::error!("Failed to parse Adoptium JSON: {}", e);
            log::debug!(
                "Response body (first 500 chars): {}",
                &text[..text.len().min(500)]
            );
            LauncherError::ApiError(format!(
                "Invalid JSON from Adoptium API: {} (URL: {})",
                e, url
            ))
        })?;

        let release = releases
            .iter()
            .find(|r| {
                r.binary
                    .as_slice()
                    .iter()
                    .any(|b| b.os == os && b.architecture == arch && b.image_type == "jdk")
            })
            .ok_or_else(|| LauncherError::JavaNotFound(version.to_string()))?;

        let binaries = release.binary.as_slice().iter();
        let binary = binaries
            .into_iter()
            .find(|b| b.os == os && b.architecture == arch && b.image_type == "jdk")
            .ok_or_else(|| LauncherError::JavaNotFound(version.to_string()))?;

        // Проверка отмены перед скачиванием
        if cancel_token.is_cancelled() {
            return Err(LauncherError::OperationCancelled);
        }

        // Скачиваем архив с поддержкой зеркал (TUNA -> Adoptium)
        let install_dir = java_dir().join(format!("java-{}", version));
        tokio::fs::create_dir_all(&install_dir).await?;

        let archive_path = install_dir.join(&binary.package.name);

        log::info!(
            "Downloading Java {} from mirrors (TUNA priority, Adoptium fallback)",
            version
        );

        download_manager
            .download_java_with_mirrors(
                &binary.package.link,
                &archive_path,
                &format!("Java {}", version),
                binary.package.checksum.as_deref(),
                version,
                arch,
                os,
                &binary.package.name,
                cancel_token,
                operation_id,
            )
            .await?;

        // Проверка отмены перед распаковкой
        if cancel_token.is_cancelled() {
            // Удаляем скачанный архив при отмене
            let _ = tokio::fs::remove_file(&archive_path).await;
            return Err(LauncherError::OperationCancelled);
        }

        // Распаковываем архив
        Self::extract_java_archive(&archive_path, &install_dir).await?;

        // Удаляем архив
        tokio::fs::remove_file(&archive_path).await?;

        // Находим java executable
        let java_exec = Self::find_java_in_dir(&install_dir)?;

        // Сохраняем в БД (OR REPLACE для случая race condition)
        let conn = get_db_conn()?;
        conn.execute(
            "INSERT OR REPLACE INTO java_installations (version, path, vendor, architecture, is_auto_installed, installed_at)
             VALUES (?1, ?2, ?3, ?4, 1, ?5)",
            rusqlite::params![
                version.to_string(),
                java_exec.to_string_lossy().to_string(),
                "Adoptium",
                arch,
                Utc::now().to_rfc3339(),
            ],
        )?;

        Ok(java_exec)
    }

    /// Распаковка Java архива
    async fn extract_java_archive(archive: &Path, dest: &Path) -> Result<()> {
        let archive = archive.to_path_buf();
        let dest = dest.to_path_buf();

        tokio::task::spawn_blocking(move || {
            let extension = archive.extension().and_then(|s| s.to_str());

            if extension == Some("zip") {
                // ZIP архив (Windows)
                let file = std::fs::File::open(&archive)?;
                let mut zip = zip::ZipArchive::new(file)?;

                for i in 0..zip.len() {
                    let mut file = zip.by_index(i)?;
                    let outpath = match file.enclosed_name() {
                        Some(path) => dest.join(path),
                        None => continue,
                    };

                    if file.name().ends_with('/') {
                        std::fs::create_dir_all(&outpath)?;
                    } else {
                        if let Some(p) = outpath.parent() {
                            if !p.exists() {
                                std::fs::create_dir_all(p)?;
                            }
                        }
                        let mut outfile = std::fs::File::create(&outpath)?;
                        std::io::copy(&mut file, &mut outfile)?;
                    }
                }
            } else {
                // TAR.GZ архив (Linux/macOS)
                let file = std::fs::File::open(&archive)?;
                let gz = flate2::read::GzDecoder::new(file);
                let mut tar = tar::Archive::new(gz);
                tar.unpack(&dest)?;
            }
            Ok::<_, LauncherError>(())
        })
        .await??;

        Ok(())
    }

    /// Поиск java executable в директории
    fn find_java_in_dir(dir: &Path) -> Result<PathBuf> {
        let java_name = if cfg!(windows) { "java.exe" } else { "java" };

        // Ищем в стандартных путях
        let possible_paths = [
            dir.join("bin").join(java_name),
            dir.join("jdk").join("bin").join(java_name),
            dir.join("Contents/Home/bin").join(java_name),
        ];

        for path in &possible_paths {
            if path.exists() {
                return Ok(path.clone());
            }
        }

        // Рекурсивный поиск
        for entry in walkdir::WalkDir::new(dir).max_depth(3) {
            if let Ok(entry) = entry {
                if entry.file_name() == java_name {
                    return Ok(entry.path().to_path_buf());
                }
            }
        }

        Err(LauncherError::JavaNotFound(
            "Could not find java executable in extracted archive".to_string(),
        ))
    }

    /// Получение или установка необходимой версии Java с поддержкой отмены
    pub async fn ensure_java(
        minecraft_version: &str,
        download_manager: &DownloadManager,
        cancel_token: &CancellationToken,
        operation_id: Option<&str>,
    ) -> Result<PathBuf> {
        let required_version = Self::required_java_version(minecraft_version);

        // Сначала проверяем активную Java для этой версии
        if let Some(path) = Self::get_active_java(required_version).await? {
            return Ok(path);
        }

        // Устанавливаем автоматически с поддержкой отмены и зеркал
        Self::install_java(
            required_version,
            download_manager,
            cancel_token,
            operation_id,
        )
        .await
    }

    /// Сканирование системы на наличие установленных Java
    pub async fn scan_system_java() -> Vec<SystemJavaInfo> {
        let mut found: Vec<SystemJavaInfo> = Vec::new();
        let mut checked_paths: HashSet<PathBuf> = HashSet::new();

        // Получаем уже добавленные пути из БД
        let added_paths: HashSet<String> = {
            let conn = match get_db_conn() {
                Ok(c) => c,
                Err(_) => return found,
            };
            let mut stmt = match conn.prepare("SELECT path FROM java_installations") {
                Ok(s) => s,
                Err(_) => return found,
            };
            stmt.query_map([], |row| row.get::<_, String>(0))
                .ok()
                .map(|rows| rows.filter_map(|r| r.ok()).collect())
                .unwrap_or_default()
        };

        // Стандартные пути для поиска Java
        let search_paths = Self::get_java_search_paths();

        for base_path in search_paths {
            if !base_path.exists() {
                continue;
            }

            // Ищем java executable в стандартных местах
            let java_name = if cfg!(windows) { "java.exe" } else { "java" };
            let possible_bins = [
                base_path.join("bin").join(java_name),
                base_path.join(java_name),
            ];

            for java_path in &possible_bins {
                if java_path.exists() && !checked_paths.contains(java_path) {
                    checked_paths.insert(java_path.clone());

                    if let Some(info) = Self::get_java_info(java_path, &added_paths).await {
                        found.push(info);
                    }
                }
            }

            // Проверяем поддиректории (для /usr/lib/jvm/*, C:\Program Files\Java\* и т.д.)
            if let Ok(entries) = std::fs::read_dir(&base_path) {
                for entry in entries.filter_map(|e| e.ok()) {
                    let sub_path = entry.path();
                    if sub_path.is_dir() {
                        let java_path = sub_path.join("bin").join(java_name);
                        if java_path.exists() && !checked_paths.contains(&java_path) {
                            checked_paths.insert(java_path.clone());

                            if let Some(info) = Self::get_java_info(&java_path, &added_paths).await
                            {
                                found.push(info);
                            }
                        }
                    }
                }
            }
        }

        // Проверяем JAVA_HOME
        if let Ok(java_home) = std::env::var("JAVA_HOME") {
            let java_name = if cfg!(windows) { "java.exe" } else { "java" };
            let java_path = PathBuf::from(&java_home).join("bin").join(java_name);
            if java_path.exists() && !checked_paths.contains(&java_path) {
                checked_paths.insert(java_path.clone());
                if let Some(info) = Self::get_java_info(&java_path, &added_paths).await {
                    found.push(info);
                }
            }
        }

        // Проверяем PATH
        if let Ok(path_var) = std::env::var("PATH") {
            let java_name = if cfg!(windows) { "java.exe" } else { "java" };
            let separator = if cfg!(windows) { ';' } else { ':' };

            for path_dir in path_var.split(separator) {
                let java_path = PathBuf::from(path_dir).join(java_name);
                if java_path.exists() && !checked_paths.contains(&java_path) {
                    checked_paths.insert(java_path.clone());
                    if let Some(info) = Self::get_java_info(&java_path, &added_paths).await {
                        found.push(info);
                    }
                }
            }
        }

        // Сортируем по major версии (новые первые)
        found.sort_by(|a, b| b.major_version.cmp(&a.major_version));
        found
    }

    /// Получает стандартные пути поиска Java для текущей ОС
    fn get_java_search_paths() -> Vec<PathBuf> {
        let mut paths = Vec::new();

        #[cfg(target_os = "windows")]
        {
            // Program Files
            if let Ok(pf) = std::env::var("ProgramFiles") {
                paths.push(PathBuf::from(&pf).join("Java"));
                paths.push(PathBuf::from(&pf).join("Eclipse Adoptium"));
                paths.push(PathBuf::from(&pf).join("Temurin"));
                paths.push(PathBuf::from(&pf).join("AdoptOpenJDK"));
                paths.push(PathBuf::from(&pf).join("Zulu"));
                paths.push(PathBuf::from(&pf).join("Microsoft"));
                paths.push(PathBuf::from(&pf).join("BellSoft"));
            }
            if let Ok(pf86) = std::env::var("ProgramFiles(x86)") {
                paths.push(PathBuf::from(&pf86).join("Java"));
            }
            // Scoop
            if let Ok(userprofile) = std::env::var("USERPROFILE") {
                paths.push(PathBuf::from(&userprofile).join("scoop").join("apps"));
            }
        }

        #[cfg(target_os = "linux")]
        {
            paths.push(PathBuf::from("/usr/lib/jvm"));
            paths.push(PathBuf::from("/usr/java"));
            paths.push(PathBuf::from("/opt/java"));
            paths.push(PathBuf::from("/opt/jdk"));
            // SDKMAN
            if let Ok(home) = std::env::var("HOME") {
                paths.push(
                    PathBuf::from(&home)
                        .join(".sdkman")
                        .join("candidates")
                        .join("java"),
                );
                paths.push(PathBuf::from(&home).join(".jdks"));
            }
        }

        #[cfg(target_os = "macos")]
        {
            paths.push(PathBuf::from("/Library/Java/JavaVirtualMachines"));
            paths.push(PathBuf::from("/System/Library/Java/JavaVirtualMachines"));
            // Homebrew
            paths.push(PathBuf::from("/opt/homebrew/opt/openjdk"));
            paths.push(PathBuf::from("/opt/homebrew/opt/openjdk@8"));
            paths.push(PathBuf::from("/opt/homebrew/opt/openjdk@11"));
            paths.push(PathBuf::from("/opt/homebrew/opt/openjdk@17"));
            paths.push(PathBuf::from("/opt/homebrew/opt/openjdk@21"));
            paths.push(PathBuf::from("/usr/local/opt/openjdk"));
            // SDKMAN
            if let Ok(home) = std::env::var("HOME") {
                paths.push(
                    PathBuf::from(&home)
                        .join(".sdkman")
                        .join("candidates")
                        .join("java"),
                );
                paths.push(PathBuf::from(&home).join(".jdks"));
            }
        }

        paths
    }

    /// Получает информацию о конкретной Java
    async fn get_java_info(
        java_path: &Path,
        added_paths: &HashSet<String>,
    ) -> Option<SystemJavaInfo> {
        let path_str = java_path.to_string_lossy().to_string();

        // Получаем версию
        let version_output = Self::get_java_version_full(java_path).await?;

        // Парсим major версию
        let major_version = Self::parse_major_version(&version_output)?;

        // Пытаемся определить vendor
        let vendor = Self::detect_vendor(&version_output);

        // Проверяем, добавлена ли уже эта Java
        let is_already_added = added_paths.contains(&path_str);

        Some(SystemJavaInfo {
            path: path_str,
            version: version_output,
            major_version,
            vendor,
            is_already_added,
        })
    }

    /// Получает полную строку версии Java
    async fn get_java_version_full(java_path: &Path) -> Option<String> {
        let path = java_path.to_path_buf();

        let get_version = async move {
            let mut cmd = tokio::process::Command::new(&path);
            cmd.arg("-version");

            #[cfg(windows)]
            cmd.creation_flags(CREATE_NO_WINDOW);

            cmd.output().await
        };

        let output = match timeout(Duration::from_secs(5), get_version).await {
            Ok(Ok(out)) => out,
            _ => return None,
        };

        let stderr = String::from_utf8_lossy(&output.stderr);

        // Первая строка обычно содержит версию
        for line in stderr.lines() {
            if line.contains("version") {
                if let Some(version) = line.split('"').nth(1) {
                    return Some(version.to_string());
                }
            }
        }

        None
    }

    /// Парсит major версию из строки версии Java
    fn parse_major_version(version: &str) -> Option<u32> {
        // Формат: "1.8.0_xxx" или "11.0.x" или "17.0.x" или "21.0.x"
        let parts: Vec<&str> = version.split('.').collect();
        if parts.is_empty() {
            return None;
        }

        let first: u32 = parts[0].parse().ok()?;

        // Старый формат (1.8, 1.7, etc)
        if first == 1 && parts.len() > 1 {
            parts[1].split('_').next()?.parse().ok()
        } else {
            // Новый формат (11, 17, 21, etc)
            Some(first)
        }
    }

    /// Определяет vendor по выводу java -version
    fn detect_vendor(version_output: &str) -> Option<String> {
        let lower = version_output.to_lowercase();

        if lower.contains("temurin") || lower.contains("adoptium") {
            Some("Adoptium".to_string())
        } else if lower.contains("openjdk") {
            Some("OpenJDK".to_string())
        } else if lower.contains("oracle") || lower.contains("java(tm)") {
            Some("Oracle".to_string())
        } else if lower.contains("zulu") {
            Some("Azul Zulu".to_string())
        } else if lower.contains("corretto") {
            Some("Amazon Corretto".to_string())
        } else if lower.contains("microsoft") {
            Some("Microsoft".to_string())
        } else if lower.contains("graalvm") {
            Some("GraalVM".to_string())
        } else if lower.contains("liberica") {
            Some("BellSoft Liberica".to_string())
        } else {
            None
        }
    }

    /// Добавляет кастомную Java в БД
    pub async fn add_custom_java(java_path: &str) -> Result<SystemJavaInfo> {
        let path = PathBuf::from(java_path);

        // Проверяем что файл существует
        if !path.exists() {
            return Err(LauncherError::InvalidConfig(format!(
                "Java не найдена по пути: {}",
                java_path
            )));
        }

        // Проверяем что это java executable
        let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

        let expected_name = if cfg!(windows) { "java.exe" } else { "java" };
        if file_name != expected_name {
            return Err(LauncherError::InvalidConfig(format!(
                "Ожидается путь к {}, получено: {}",
                expected_name, file_name
            )));
        }

        // Получаем версию
        let version = Self::get_java_version_full(&path)
            .await
            .ok_or_else(|| LauncherError::InvalidConfig(
                "Не удалось определить версию Java. Проверьте что путь указывает на корректный java executable.".to_string()
            ))?;

        let major_version = Self::parse_major_version(&version).ok_or_else(|| {
            LauncherError::InvalidConfig(format!("Не удалось распарсить версию Java: {}", version))
        })?;

        let vendor = Self::detect_vendor(&version);

        // Сохраняем в БД
        let conn = get_db_conn()?;
        conn.execute(
            "INSERT OR REPLACE INTO java_installations (version, path, vendor, architecture, is_auto_installed, installed_at)
             VALUES (?1, ?2, ?3, ?4, 0, ?5)",
            rusqlite::params![
                major_version.to_string(),
                java_path,
                vendor.as_deref().unwrap_or("Unknown"),
                std::env::consts::ARCH,
                Utc::now().to_rfc3339(),
            ],
        )?;

        Ok(SystemJavaInfo {
            path: java_path.to_string(),
            version,
            major_version,
            vendor,
            is_already_added: true,
        })
    }

    /// Валидирует путь к Java без добавления в БД
    pub async fn validate_java_path(java_path: &str) -> Result<SystemJavaInfo> {
        let path = PathBuf::from(java_path);

        if !path.exists() {
            return Err(LauncherError::InvalidConfig(format!(
                "Файл не найден: {}",
                java_path
            )));
        }

        let version = Self::get_java_version_full(&path).await.ok_or_else(|| {
            LauncherError::InvalidConfig("Не удалось определить версию Java".to_string())
        })?;

        let major_version = Self::parse_major_version(&version).ok_or_else(|| {
            LauncherError::InvalidConfig(format!("Не удалось распарсить версию: {}", version))
        })?;

        let vendor = Self::detect_vendor(&version);

        // Проверяем, добавлена ли уже
        let is_already_added = {
            let conn = get_db_conn()?;
            let mut stmt = conn.prepare("SELECT 1 FROM java_installations WHERE path = ?1")?;
            stmt.exists([java_path])?
        };

        Ok(SystemJavaInfo {
            path: java_path.to_string(),
            version,
            major_version,
            vendor,
            is_already_added,
        })
    }

    /// Получает список установленных major версий Java
    pub fn get_installed_major_versions() -> Result<Vec<u32>> {
        let conn = get_db_conn()?;
        let mut stmt =
            conn.prepare("SELECT DISTINCT version FROM java_installations ORDER BY version")?;
        let versions: Vec<u32> = stmt
            .query_map([], |row| {
                let v: String = row.get(0)?;
                Ok(v.parse::<u32>().unwrap_or(0))
            })?
            .filter_map(|r| r.ok())
            .filter(|v| *v > 0)
            .collect();
        Ok(versions)
    }

    /// Получает все установленные Java для конкретной major версии
    pub fn get_java_for_version(major_version: u32) -> Result<Vec<JavaInstallationInfo>> {
        let conn = get_db_conn()?;
        let mut stmt = conn.prepare(
            "SELECT path, vendor, is_auto_installed FROM java_installations WHERE version = ?1",
        )?;

        // Получаем активную Java для этой версии
        let active_path = Self::get_active_java_sync(major_version);

        let installations: Vec<JavaInstallationInfo> = stmt
            .query_map([major_version.to_string()], |row| {
                let path: String = row.get(0)?;
                let vendor: Option<String> = row.get(1)?;
                let is_auto_installed: bool = row.get::<_, i32>(2)? != 0;
                Ok((path, vendor, is_auto_installed))
            })?
            .filter_map(|r| r.ok())
            .map(|(path, vendor, is_auto_installed)| {
                let is_active = active_path.as_ref().map(|p| p == &path).unwrap_or(false);
                JavaInstallationInfo {
                    path,
                    vendor,
                    is_auto_installed,
                    is_active,
                }
            })
            .collect();

        Ok(installations)
    }

    /// Устанавливает активную Java для major версии
    pub fn set_active_java(major_version: u32, java_path: &str) -> Result<()> {
        let conn = get_db_conn()?;
        let key = format!("active_java_{}", major_version);
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?1, ?2, datetime('now'))",
            rusqlite::params![key, java_path],
        )?;
        Ok(())
    }

    /// Получает активную Java для major версии (sync версия)
    pub fn get_active_java_sync(major_version: u32) -> Option<String> {
        let conn = get_db_conn().ok()?;
        let key = format!("active_java_{}", major_version);
        conn.query_row("SELECT value FROM settings WHERE key = ?1", [&key], |row| {
            row.get(0)
        })
        .ok()
    }

    /// Получает активную Java для major версии (или первую доступную)
    pub async fn get_active_java(major_version: u32) -> Result<Option<PathBuf>> {
        // Сначала проверяем настройку активной Java
        if let Some(active_path) = Self::get_active_java_sync(major_version) {
            let path = PathBuf::from(&active_path);
            if path.exists() {
                return Ok(Some(path));
            }
        }

        // Fallback: получаем любую установленную Java этой версии
        Self::get_installed_java(&major_version.to_string()).await
    }

    /// Проверяет совместимость Java с версией Minecraft
    pub fn check_java_compatibility(java_major: u32, minecraft_version: &str) -> JavaCompatibility {
        let required = Self::required_java_version(minecraft_version);

        if java_major == required {
            JavaCompatibility::Compatible
        } else if java_major > required {
            // Более новая Java обычно работает
            JavaCompatibility::Warning(format!(
                "Рекомендуется Java {}, выбрана Java {}. Может работать, но возможны проблемы.",
                required, java_major
            ))
        } else {
            // Старая Java - не будет работать
            JavaCompatibility::Incompatible(format!(
                "Minecraft {} требует Java {} или новее. Выбрана Java {}.",
                minecraft_version, required, java_major
            ))
        }
    }

    /// Проверяет совместимость Java по пути с версией Minecraft
    pub async fn check_java_compatibility_for_path(
        java_path: &str,
        minecraft_version: &str,
    ) -> JavaCompatibility {
        let path = Path::new(java_path);

        // Получаем версию Java
        let version = match Self::get_java_version_full(path).await {
            Some(v) => v,
            None => {
                return JavaCompatibility::Incompatible(
                    "Не удалось определить версию Java по указанному пути.".to_string(),
                )
            }
        };

        // Парсим major версию
        let major_version = match Self::parse_major_version(&version) {
            Some(v) => v,
            None => {
                return JavaCompatibility::Incompatible(format!(
                    "Не удалось распарсить версию Java: {}",
                    version
                ))
            }
        };

        Self::check_java_compatibility(major_version, minecraft_version)
    }
}

/// Информация об установленной Java для UI
#[derive(Debug, Clone, Serialize)]
pub struct JavaInstallationInfo {
    pub path: String,
    pub vendor: Option<String>,
    pub is_auto_installed: bool,
    pub is_active: bool,
}

/// Результат проверки совместимости Java
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", content = "message")]
pub enum JavaCompatibility {
    Compatible,
    Warning(String),
    Incompatible(String),
}
