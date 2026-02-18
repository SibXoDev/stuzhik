//! Server loader installers
//!
//! Downloads and installs server JARs for different loaders:
//! - Vanilla (from Mojang)
//! - Fabric (from Fabric Meta)
//! - Forge (from Forge Maven)
//! - NeoForge (from NeoForge Maven)
//! - Quilt (from Quilt Meta)

use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::fs;
use tokio::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Windows: Hide console window when spawning processes
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

use super::{ServerError, ServerResult};

use crate::utils::SHARED_HTTP_CLIENT as SERVER_HTTP_CLIENT;

/// Loader type for server
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ServerLoader {
    Vanilla,
    Fabric,
    Forge,
    NeoForge,
    Quilt,
}

impl std::fmt::Display for ServerLoader {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ServerLoader::Vanilla => write!(f, "vanilla"),
            ServerLoader::Fabric => write!(f, "fabric"),
            ServerLoader::Forge => write!(f, "forge"),
            ServerLoader::NeoForge => write!(f, "neoforge"),
            ServerLoader::Quilt => write!(f, "quilt"),
        }
    }
}

impl std::str::FromStr for ServerLoader {
    type Err = ServerError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "vanilla" => Ok(ServerLoader::Vanilla),
            "fabric" => Ok(ServerLoader::Fabric),
            "forge" => Ok(ServerLoader::Forge),
            "neoforge" => Ok(ServerLoader::NeoForge),
            "quilt" => Ok(ServerLoader::Quilt),
            _ => Err(ServerError::Config(format!("Unknown loader: {}", s))),
        }
    }
}

/// Installation result
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct InstallResult {
    /// Path to the main server JAR
    pub server_jar: PathBuf,
    /// Loader type
    pub loader: ServerLoader,
    /// Minecraft version
    pub minecraft_version: String,
    /// Loader version (None for Vanilla)
    pub loader_version: Option<String>,
    /// Java arguments to use
    pub java_args: Vec<String>,
}

/// Get latest loader version for a Minecraft version
pub async fn get_latest_loader_version(
    loader: ServerLoader,
    mc_version: &str,
) -> ServerResult<Option<String>> {
    match loader {
        ServerLoader::Vanilla => Ok(None),
        ServerLoader::Fabric => get_latest_fabric_loader(mc_version).await,
        ServerLoader::Forge => get_latest_forge_version(mc_version).await,
        ServerLoader::NeoForge => get_latest_neoforge_version(mc_version).await,
        ServerLoader::Quilt => get_latest_quilt_loader(mc_version).await,
    }
}

/// Install server with specified loader
pub async fn install_server(
    server_dir: impl AsRef<Path>,
    loader: ServerLoader,
    mc_version: &str,
    loader_version: Option<&str>,
    java_path: &Path,
) -> ServerResult<InstallResult> {
    let server_dir = server_dir.as_ref();

    // Ensure directory exists
    fs::create_dir_all(server_dir).await?;

    match loader {
        ServerLoader::Vanilla => install_vanilla(server_dir, mc_version).await,
        ServerLoader::Fabric => {
            let loader_ver = match loader_version {
                Some(v) => v.to_string(),
                None => get_latest_fabric_loader(mc_version).await?.ok_or_else(|| {
                    ServerError::NotFound(format!("No Fabric loader for MC {}", mc_version))
                })?,
            };
            install_fabric(server_dir, mc_version, &loader_ver, java_path).await
        }
        ServerLoader::Forge => {
            let loader_ver = match loader_version {
                Some(v) => v.to_string(),
                None => get_latest_forge_version(mc_version).await?.ok_or_else(|| {
                    ServerError::NotFound(format!("No Forge for MC {}", mc_version))
                })?,
            };
            install_forge(server_dir, mc_version, &loader_ver, java_path).await
        }
        ServerLoader::NeoForge => {
            let loader_ver = match loader_version {
                Some(v) => v.to_string(),
                None => get_latest_neoforge_version(mc_version)
                    .await?
                    .ok_or_else(|| {
                        ServerError::NotFound(format!("No NeoForge for MC {}", mc_version))
                    })?,
            };
            install_neoforge(server_dir, mc_version, &loader_ver, java_path).await
        }
        ServerLoader::Quilt => {
            let loader_ver = match loader_version {
                Some(v) => v.to_string(),
                None => get_latest_quilt_loader(mc_version).await?.ok_or_else(|| {
                    ServerError::NotFound(format!("No Quilt loader for MC {}", mc_version))
                })?,
            };
            install_quilt(server_dir, mc_version, &loader_ver, java_path).await
        }
    }
}

// ============================================================================
// Vanilla Server
// ============================================================================

async fn install_vanilla(server_dir: &Path, mc_version: &str) -> ServerResult<InstallResult> {
    log::info!("Installing Vanilla server version {}", mc_version);

    // Get version manifest
    let manifest_url = "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json";
    let manifest: serde_json::Value = SERVER_HTTP_CLIENT.get(manifest_url)
        .send().await
        .map_err(|e| ServerError::Network(e.to_string()))?
        .json()
        .await
        .map_err(|e| ServerError::Network(e.to_string()))?;

    // Find version
    let versions = manifest["versions"]
        .as_array()
        .ok_or_else(|| ServerError::Config("Invalid manifest".into()))?;

    let version_info = versions
        .iter()
        .find(|v| v["id"].as_str() == Some(mc_version))
        .ok_or_else(|| ServerError::NotFound(format!("MC version {} not found", mc_version)))?;

    let version_url = version_info["url"]
        .as_str()
        .ok_or_else(|| ServerError::Config("No version URL".into()))?;

    // Get version details
    let version_data: serde_json::Value = SERVER_HTTP_CLIENT.get(version_url)
        .send().await
        .map_err(|e| ServerError::Network(e.to_string()))?
        .json()
        .await
        .map_err(|e| ServerError::Network(e.to_string()))?;

    let server_url = version_data["downloads"]["server"]["url"]
        .as_str()
        .ok_or_else(|| ServerError::Config("No server download URL".into()))?;

    // Download server JAR
    let server_jar = server_dir.join("server.jar");
    download_file(server_url, &server_jar).await?;

    log::info!("Vanilla server installed at {:?}", server_jar);

    Ok(InstallResult {
        server_jar,
        loader: ServerLoader::Vanilla,
        minecraft_version: mc_version.to_string(),
        loader_version: None,
        java_args: vec!["-jar".into(), "server.jar".into(), "nogui".into()],
    })
}

// ============================================================================
// Fabric Server
// ============================================================================

async fn get_latest_fabric_loader(mc_version: &str) -> ServerResult<Option<String>> {
    let url = format!(
        "https://meta.fabricmc.net/v2/versions/loader/{}",
        mc_version
    );

    let response = SERVER_HTTP_CLIENT.get(&url)
        .send().await
        .map_err(|e| ServerError::Network(e.to_string()))?;

    if !response.status().is_success() {
        return Ok(None);
    }

    let versions: Vec<serde_json::Value> = response
        .json()
        .await
        .map_err(|e| ServerError::Network(e.to_string()))?;

    // First stable version
    Ok(versions
        .iter()
        .find(|v| v["loader"]["stable"].as_bool() == Some(true))
        .or_else(|| versions.first())
        .and_then(|v| v["loader"]["version"].as_str())
        .map(String::from))
}

async fn install_fabric(
    server_dir: &Path,
    mc_version: &str,
    loader_version: &str,
    java_path: &Path,
) -> ServerResult<InstallResult> {
    log::info!(
        "Installing Fabric server: MC {} loader {}",
        mc_version,
        loader_version
    );

    // Get latest installer version
    let installer_url = "https://meta.fabricmc.net/v2/versions/installer";
    let installers: Vec<serde_json::Value> = SERVER_HTTP_CLIENT.get(installer_url)
        .send().await
        .map_err(|e| ServerError::Network(e.to_string()))?
        .json()
        .await
        .map_err(|e| ServerError::Network(e.to_string()))?;

    let installer_version = installers
        .iter()
        .find(|v| v["stable"].as_bool() == Some(true))
        .or_else(|| installers.first())
        .and_then(|v| v["version"].as_str())
        .ok_or_else(|| ServerError::NotFound("No Fabric installer found".into()))?;

    // Download installer
    let installer_jar = server_dir.join("fabric-installer.jar");
    let download_url = format!(
        "https://maven.fabricmc.net/net/fabricmc/fabric-installer/{}/fabric-installer-{}.jar",
        installer_version, installer_version
    );
    download_file(&download_url, &installer_jar).await?;

    // Run installer
    let mut cmd = Command::new(java_path);
    cmd.current_dir(server_dir)
        .args([
            "-jar",
            "fabric-installer.jar",
            "server",
            "-mcversion",
            mc_version,
            "-loader",
            loader_version,
            "-downloadMinecraft",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let status = cmd
        .status()
        .await
        .map_err(|e| ServerError::Process(e.to_string()))?;

    if !status.success() {
        return Err(ServerError::Process("Fabric installer failed".into()));
    }

    // Clean up installer
    let _ = fs::remove_file(&installer_jar).await;

    // Find the server JAR (fabric-server-launch.jar or fabric-server-mc.X.X.X-loader.X.X.X-launcher.jar)
    let server_jar = if fs::try_exists(server_dir.join("fabric-server-launch.jar")).await.unwrap_or(false) {
        server_dir.join("fabric-server-launch.jar")
    } else {
        // Try to find the launcher JAR
        let mut entries = fs::read_dir(server_dir).await?;
        let mut found_jar = None;
        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("fabric-server-") && name.ends_with("-launcher.jar") {
                found_jar = Some(entry.path());
                break;
            }
        }
        found_jar.unwrap_or_else(|| server_dir.join("server.jar"))
    };

    log::info!("Fabric server installed at {:?}", server_jar);

    Ok(InstallResult {
        server_jar: server_jar.clone(),
        loader: ServerLoader::Fabric,
        minecraft_version: mc_version.to_string(),
        loader_version: Some(loader_version.to_string()),
        java_args: vec![
            "-jar".into(),
            server_jar
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string(),
            "nogui".into(),
        ],
    })
}

// ============================================================================
// Forge Server
// ============================================================================

async fn get_latest_forge_version(mc_version: &str) -> ServerResult<Option<String>> {
    let url = "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json";

    let response = SERVER_HTTP_CLIENT.get(url)
        .send().await
        .map_err(|e| ServerError::Network(e.to_string()))?;

    let data: serde_json::Value = response
        .json()
        .await
        .map_err(|e| ServerError::Network(e.to_string()))?;

    let promos = data["promos"]
        .as_object()
        .ok_or_else(|| ServerError::Config("Invalid Forge promotions".into()))?;

    // Try recommended first, then latest
    let key_recommended = format!("{}-recommended", mc_version);
    let key_latest = format!("{}-latest", mc_version);

    Ok(promos
        .get(&key_recommended)
        .or_else(|| promos.get(&key_latest))
        .and_then(|v| v.as_str())
        .map(String::from))
}

async fn install_forge(
    server_dir: &Path,
    mc_version: &str,
    forge_version: &str,
    java_path: &Path,
) -> ServerResult<InstallResult> {
    log::info!(
        "Installing Forge server: MC {} forge {}",
        mc_version,
        forge_version
    );

    // Forge version format: 1.20.1-47.2.0
    let full_version = format!("{}-{}", mc_version, forge_version);

    // Download installer
    let installer_jar = server_dir.join("forge-installer.jar");
    let download_url = format!(
        "https://maven.minecraftforge.net/net/minecraftforge/forge/{}/forge-{}-installer.jar",
        full_version, full_version
    );
    download_file(&download_url, &installer_jar).await?;

    // Run installer
    let mut cmd = Command::new(java_path);
    cmd.current_dir(server_dir)
        .args(["-jar", "forge-installer.jar", "--installServer"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let status = cmd
        .status()
        .await
        .map_err(|e| ServerError::Process(e.to_string()))?;

    if !status.success() {
        return Err(ServerError::Process("Forge installer failed".into()));
    }

    // Clean up installer
    let _ = fs::remove_file(&installer_jar).await;
    let _ = fs::remove_file(server_dir.join("forge-installer.jar.log")).await;

    // Find the server JAR or run script
    // Modern Forge (1.17+) creates run.sh/run.bat and uses @libraries/...
    // Older Forge creates forge-VERSION-universal.jar or forge-VERSION.jar

    let run_sh = server_dir.join("run.sh");
    let run_bat = server_dir.join("run.bat");

    let (server_jar, java_args) = if fs::try_exists(&run_sh).await.unwrap_or(false) || fs::try_exists(&run_bat).await.unwrap_or(false) {
        // Modern Forge - use the args from run script
        let args_file = format!(
            "@libraries/net/minecraftforge/forge/{}/unix_args.txt",
            full_version
        );
        let args_path = server_dir
            .join("libraries/net/minecraftforge/forge")
            .join(&full_version)
            .join("unix_args.txt");

        if !fs::try_exists(&args_path).await.unwrap_or(false) {
            // Try win_args.txt as fallback
            let win_args = server_dir
                .join("libraries/net/minecraftforge/forge")
                .join(&full_version)
                .join("win_args.txt");
            if !fs::try_exists(&win_args).await.unwrap_or(false) {
                return Err(ServerError::Config(format!(
                    "Forge installed but args file not found at {:?}",
                    args_path
                )));
            }
        }

        (
            server_dir.join("libraries"),
            vec![args_file, "nogui".into()],
        )
    } else {
        // Legacy Forge - scan directory for the server JAR
        let mut found_jar: Option<PathBuf> = None;

        // Try common patterns
        let patterns = [
            format!("forge-{}-universal.jar", full_version),
            format!("forge-{}.jar", full_version),
            format!("forge-{}-server.jar", full_version),
            "forge-server.jar".to_string(),
        ];

        for pattern in &patterns {
            let jar_path = server_dir.join(pattern);
            if fs::try_exists(&jar_path).await.unwrap_or(false) {
                found_jar = Some(jar_path);
                break;
            }
        }

        // If still not found, scan for any forge*.jar
        if found_jar.is_none() {
            if let Ok(mut entries) = fs::read_dir(server_dir).await {
                while let Ok(Some(entry)) = entries.next_entry().await {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if name.starts_with("forge")
                        && name.ends_with(".jar")
                        && !name.contains("installer")
                    {
                        found_jar = Some(entry.path());
                        break;
                    }
                }
            }
        }

        match found_jar {
            Some(jar_path) => {
                let jar_name = jar_path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("forge-server.jar")
                    .to_string();
                (jar_path, vec!["-jar".into(), jar_name, "nogui".into()])
            }
            None => {
                return Err(ServerError::Config(
                    "Forge server jar not found after installation. Check the installer log."
                        .into(),
                ));
            }
        }
    };

    log::info!("Forge server installed at {:?}", server_jar);

    Ok(InstallResult {
        server_jar,
        loader: ServerLoader::Forge,
        minecraft_version: mc_version.to_string(),
        loader_version: Some(forge_version.to_string()),
        java_args,
    })
}

// ============================================================================
// NeoForge Server
// ============================================================================

async fn get_latest_neoforge_version(mc_version: &str) -> ServerResult<Option<String>> {
    // NeoForge uses different versioning: for 1.20.1, it's 47.1.X
    // For 1.20.2+, it's 20.2.X (matching MC minor.patch)
    let url = "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge";

    let response = SERVER_HTTP_CLIENT.get(url)
        .send().await
        .map_err(|e| ServerError::Network(e.to_string()))?;

    let data: serde_json::Value = response
        .json()
        .await
        .map_err(|e| ServerError::Network(e.to_string()))?;

    let versions = data["versions"]
        .as_array()
        .ok_or_else(|| ServerError::Config("Invalid NeoForge versions".into()))?;

    // Parse MC version
    let mc_parts: Vec<&str> = mc_version.split('.').collect();
    if mc_parts.len() < 2 {
        return Ok(None);
    }

    let mc_minor: u32 = mc_parts[1].parse().unwrap_or(0);
    let mc_patch: u32 = mc_parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);

    // Find matching NeoForge version
    // NeoForge 20.2.X corresponds to MC 1.20.2
    // NeoForge 20.4.X corresponds to MC 1.20.4
    // etc.
    let target_prefix = format!("{}.{}.", mc_minor, mc_patch);

    Ok(versions
        .iter()
        .filter_map(|v| v.as_str())
        .filter(|v| v.starts_with(&target_prefix))
        .max_by(|a, b| {
            // Compare version numbers
            let a_parts: Vec<u32> = a.split('.').filter_map(|s| s.parse().ok()).collect();
            let b_parts: Vec<u32> = b.split('.').filter_map(|s| s.parse().ok()).collect();
            a_parts.cmp(&b_parts)
        })
        .map(String::from))
}

async fn install_neoforge(
    server_dir: &Path,
    mc_version: &str,
    neoforge_version: &str,
    java_path: &Path,
) -> ServerResult<InstallResult> {
    log::info!(
        "Installing NeoForge server: MC {} neoforge {}",
        mc_version,
        neoforge_version
    );

    // Download installer
    let installer_jar = server_dir.join("neoforge-installer.jar");
    let download_url = format!(
        "https://maven.neoforged.net/releases/net/neoforged/neoforge/{}/neoforge-{}-installer.jar",
        neoforge_version, neoforge_version
    );
    download_file(&download_url, &installer_jar).await?;

    // Run installer
    let mut cmd = Command::new(java_path);
    cmd.current_dir(server_dir)
        .args(["-jar", "neoforge-installer.jar", "--installServer"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let status = cmd
        .status()
        .await
        .map_err(|e| ServerError::Process(e.to_string()))?;

    if !status.success() {
        return Err(ServerError::Process("NeoForge installer failed".into()));
    }

    // Clean up installer
    let _ = fs::remove_file(&installer_jar).await;
    let _ = fs::remove_file(server_dir.join("neoforge-installer.jar.log")).await;

    // NeoForge creates run.sh/run.bat similar to modern Forge
    let args_file = format!(
        "@libraries/net/neoforged/neoforge/{}/unix_args.txt",
        neoforge_version
    );

    log::info!("NeoForge server installed");

    Ok(InstallResult {
        server_jar: server_dir.join("libraries"),
        loader: ServerLoader::NeoForge,
        minecraft_version: mc_version.to_string(),
        loader_version: Some(neoforge_version.to_string()),
        java_args: vec![args_file, "nogui".into()],
    })
}

// ============================================================================
// Quilt Server
// ============================================================================

async fn get_latest_quilt_loader(mc_version: &str) -> ServerResult<Option<String>> {
    let url = format!("https://meta.quiltmc.org/v3/versions/loader/{}", mc_version);

    let response = SERVER_HTTP_CLIENT.get(&url)
        .send().await
        .map_err(|e| ServerError::Network(e.to_string()))?;

    if !response.status().is_success() {
        return Ok(None);
    }

    let versions: Vec<serde_json::Value> = response
        .json()
        .await
        .map_err(|e| ServerError::Network(e.to_string()))?;

    Ok(versions
        .first()
        .and_then(|v| v["loader"]["version"].as_str())
        .map(String::from))
}

async fn install_quilt(
    server_dir: &Path,
    mc_version: &str,
    loader_version: &str,
    java_path: &Path,
) -> ServerResult<InstallResult> {
    log::info!(
        "Installing Quilt server: MC {} loader {}",
        mc_version,
        loader_version
    );

    // Get latest installer version
    let installer_url = "https://meta.quiltmc.org/v3/versions/installer";
    let installers: Vec<serde_json::Value> = SERVER_HTTP_CLIENT.get(installer_url)
        .send().await
        .map_err(|e| ServerError::Network(e.to_string()))?
        .json()
        .await
        .map_err(|e| ServerError::Network(e.to_string()))?;

    let installer_version = installers
        .first()
        .and_then(|v| v["version"].as_str())
        .ok_or_else(|| ServerError::NotFound("No Quilt installer found".into()))?;

    // Download installer
    let installer_jar = server_dir.join("quilt-installer.jar");
    let download_url = format!(
        "https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/{}/quilt-installer-{}.jar",
        installer_version, installer_version
    );
    download_file(&download_url, &installer_jar).await?;

    // Run installer
    let mut cmd = Command::new(java_path);
    cmd.current_dir(server_dir)
        .args([
            "-jar",
            "quilt-installer.jar",
            "install",
            "server",
            mc_version,
            loader_version,
            "--download-server",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let status = cmd
        .status()
        .await
        .map_err(|e| ServerError::Process(e.to_string()))?;

    if !status.success() {
        return Err(ServerError::Process("Quilt installer failed".into()));
    }

    // Clean up installer
    let _ = fs::remove_file(&installer_jar).await;

    // Quilt creates quilt-server-launch.jar
    let server_jar = server_dir.join("quilt-server-launch.jar");

    log::info!("Quilt server installed at {:?}", server_jar);

    Ok(InstallResult {
        server_jar: server_jar.clone(),
        loader: ServerLoader::Quilt,
        minecraft_version: mc_version.to_string(),
        loader_version: Some(loader_version.to_string()),
        java_args: vec![
            "-jar".into(),
            server_jar
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string(),
            "nogui".into(),
        ],
    })
}

// ============================================================================
// Helpers
// ============================================================================

/// Download a file from URL to path
async fn download_file(url: &str, path: &Path) -> ServerResult<()> {
    log::debug!("Downloading {} to {:?}", url, path);

    let response = SERVER_HTTP_CLIENT.get(url)
        .send().await
        .map_err(|e| ServerError::Network(e.to_string()))?;

    if !response.status().is_success() {
        return Err(ServerError::Network(format!(
            "Download failed: {} returned {}",
            url,
            response.status()
        )));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| ServerError::Network(e.to_string()))?;

    fs::write(path, &bytes).await?;

    Ok(())
}

/// Get available loader versions for a Minecraft version
pub async fn get_available_loader_versions(
    loader: ServerLoader,
    mc_version: &str,
) -> ServerResult<Vec<String>> {
    match loader {
        ServerLoader::Vanilla => Ok(vec![mc_version.to_string()]),
        ServerLoader::Fabric => {
            let url = format!(
                "https://meta.fabricmc.net/v2/versions/loader/{}",
                mc_version
            );
            let versions: Vec<serde_json::Value> = SERVER_HTTP_CLIENT.get(&url)
                .send().await
                .map_err(|e| ServerError::Network(e.to_string()))?
                .json()
                .await
                .map_err(|e| ServerError::Network(e.to_string()))?;

            Ok(versions
                .iter()
                .filter_map(|v| v["loader"]["version"].as_str())
                .map(String::from)
                .collect())
        }
        ServerLoader::Quilt => {
            let url = format!("https://meta.quiltmc.org/v3/versions/loader/{}", mc_version);
            let versions: Vec<serde_json::Value> = SERVER_HTTP_CLIENT.get(&url)
                .send().await
                .map_err(|e| ServerError::Network(e.to_string()))?
                .json()
                .await
                .map_err(|e| ServerError::Network(e.to_string()))?;

            Ok(versions
                .iter()
                .filter_map(|v| v["loader"]["version"].as_str())
                .map(String::from)
                .collect())
        }
        ServerLoader::Forge | ServerLoader::NeoForge => {
            // These require more complex version listing
            // For now, just return the latest
            let latest = get_latest_loader_version(loader, mc_version).await?;
            Ok(latest.into_iter().collect())
        }
    }
}

// Tauri commands

#[tauri::command]
pub async fn install_server_loader(
    instance_id: String,
    loader: String,
    mc_version: String,
    loader_version: Option<String>,
    java_path: String,
) -> Result<InstallResult, String> {
    let instances_dir = crate::paths::instances_dir();
    let server_dir = instances_dir.join(&instance_id);

    let loader: ServerLoader = loader.parse().map_err(|e: ServerError| e.to_string())?;

    let java_path = std::path::PathBuf::from(&java_path);

    install_server(
        &server_dir,
        loader,
        &mc_version,
        loader_version.as_deref(),
        &java_path,
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_server_loader_versions(
    loader: String,
    mc_version: String,
) -> Result<Vec<String>, String> {
    let loader: ServerLoader = loader.parse().map_err(|e: ServerError| e.to_string())?;

    get_available_loader_versions(loader, &mc_version)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_latest_loader(
    loader: String,
    mc_version: String,
) -> Result<Option<String>, String> {
    let loader: ServerLoader = loader.parse().map_err(|e: ServerError| e.to_string())?;

    get_latest_loader_version(loader, &mc_version)
        .await
        .map_err(|e| e.to_string())
}
