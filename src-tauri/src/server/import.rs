//! Server import functionality
//!
//! Import existing server directories with bulletproof loader detection.
//! Uses multiple detection methods:
//! - Loader-specific files (fabric.json, forge config, etc.)
//! - JAR manifest inspection
//! - Libraries folder analysis
//! - Version JSON parsing

use std::io::Read;
use std::path::{Path, PathBuf};
use tokio::fs;
use zip::ZipArchive;

use super::installer::ServerLoader;
use super::properties::ServerProperties;
use super::{ServerError, ServerResult};

/// Detected server information
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DetectedServer {
    /// Detected loader type
    pub loader: ServerLoader,
    /// Minecraft version (if detected)
    pub minecraft_version: Option<String>,
    /// Loader version (if detected)
    pub loader_version: Option<String>,
    /// Main server JAR file
    pub server_jar: Option<PathBuf>,
    /// server.properties info
    pub properties: Option<ServerProperties>,
    /// Detection confidence (0-100)
    pub confidence: u8,
    /// Detection details/evidence
    pub evidence: Vec<String>,
    /// Detected mods count
    pub mods_count: usize,
    /// Has EULA been accepted
    pub eula_accepted: bool,
}

/// Import result
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ImportResult {
    /// Instance ID (generated)
    pub instance_id: String,
    /// Detected information
    pub detected: DetectedServer,
    /// Files copied
    pub files_copied: usize,
    /// Total size in bytes
    pub total_size: u64,
}

/// Detect server type and version from a directory
pub async fn detect_server(server_dir: impl AsRef<Path>) -> ServerResult<DetectedServer> {
    let server_dir = server_dir.as_ref();

    if !fs::try_exists(server_dir).await.unwrap_or(false) {
        return Err(ServerError::NotFound(format!(
            "Directory not found: {}",
            server_dir.display()
        )));
    }

    let mut evidence = Vec::new();
    let mut loader = ServerLoader::Vanilla;
    let mut minecraft_version = None;
    let mut loader_version = None;
    let mut server_jar = None;
    let mut confidence: u8 = 0;

    // Method 1: Check for loader-specific indicator files
    if let Some((l, v, ev)) = detect_from_indicator_files(server_dir).await {
        loader = l;
        loader_version = v;
        evidence.extend(ev);
        confidence = confidence.saturating_add(40);
    }

    // Method 2: Check libraries folder
    if let Some((l, mc_v, l_v, ev)) = detect_from_libraries(server_dir).await {
        if confidence == 0 || l != ServerLoader::Vanilla {
            loader = l;
        }
        if minecraft_version.is_none() {
            minecraft_version = mc_v;
        }
        if loader_version.is_none() {
            loader_version = l_v;
        }
        evidence.extend(ev);
        confidence = confidence.saturating_add(30);
    }

    // Method 3: Inspect JAR manifests
    if let Some((jar_path, l, mc_v, l_v, ev)) = detect_from_jars(server_dir).await {
        server_jar = Some(jar_path);
        if confidence == 0 || l != ServerLoader::Vanilla {
            loader = l;
        }
        if minecraft_version.is_none() {
            minecraft_version = mc_v;
        }
        if loader_version.is_none() {
            loader_version = l_v;
        }
        evidence.extend(ev);
        confidence = confidence.saturating_add(30);
    }

    // Method 4: Check run scripts
    if let Some((l, ev)) = detect_from_run_scripts(server_dir).await {
        if confidence == 0 || l != ServerLoader::Vanilla {
            loader = l;
        }
        evidence.extend(ev);
        confidence = confidence.saturating_add(20);
    }

    // Method 5: Check mods folder for loader hints
    if let Some((l, ev)) = detect_from_mods(server_dir).await {
        if confidence == 0 {
            loader = l;
        }
        evidence.extend(ev);
        confidence = confidence.saturating_add(10);
    }

    // Load server.properties
    let properties = super::properties::load_properties(server_dir).await.ok();

    // Check EULA
    let eula_accepted = super::eula::check_eula(server_dir)
        .await
        .map(|status| status.accepted)
        .unwrap_or(false);

    // Count mods
    let mods_count = count_mods(server_dir).await;

    // Clamp confidence
    confidence = confidence.min(100);

    Ok(DetectedServer {
        loader,
        minecraft_version,
        loader_version,
        server_jar,
        properties,
        confidence,
        evidence,
        mods_count,
        eula_accepted,
    })
}

/// Detect from loader-specific indicator files
async fn detect_from_indicator_files(
    server_dir: &Path,
) -> Option<(ServerLoader, Option<String>, Vec<String>)> {
    let mut evidence = Vec::new();

    // Fabric: .fabric folder or fabric-server-launcher.properties
    let fabric_folder = server_dir.join(".fabric");
    let fabric_props = server_dir.join("fabric-server-launcher.properties");

    if fs::try_exists(&fabric_folder).await.unwrap_or(false) {
        evidence.push("Found .fabric directory".into());

        // Try to read version from .fabric/server.properties or similar
        let version = read_fabric_version(&fabric_folder).await;
        return Some((ServerLoader::Fabric, version, evidence));
    }

    if fs::try_exists(&fabric_props).await.unwrap_or(false) {
        evidence.push("Found fabric-server-launcher.properties".into());

        // Parse properties to get version
        if let Ok(content) = fs::read_to_string(&fabric_props).await {
            for line in content.lines() {
                if let Some(version) = line.strip_prefix("loader=") {
                    return Some((ServerLoader::Fabric, Some(version.to_string()), evidence));
                }
            }
        }
        return Some((ServerLoader::Fabric, None, evidence));
    }

    // Quilt: .quilt folder or quilt-server-launcher.properties
    let quilt_folder = server_dir.join(".quilt");
    let quilt_props = server_dir.join("quilt-server-launcher.properties");

    if fs::try_exists(&quilt_folder).await.unwrap_or(false) {
        evidence.push("Found .quilt directory".into());
        return Some((ServerLoader::Quilt, None, evidence));
    }

    if fs::try_exists(&quilt_props).await.unwrap_or(false) {
        evidence.push("Found quilt-server-launcher.properties".into());
        return Some((ServerLoader::Quilt, None, evidence));
    }

    // Forge: forge-installer.jar.log, user_jvm_args.txt, or forge config
    let forge_log = server_dir.join("forge-installer.jar.log");
    let user_jvm = server_dir.join("user_jvm_args.txt");
    let forge_config_dir = server_dir.join("config").join("forge");

    if fs::try_exists(&forge_log).await.unwrap_or(false) {
        evidence.push("Found forge-installer.jar.log".into());

        // Parse log for version
        if let Ok(content) = fs::read_to_string(&forge_log).await {
            if let Some(version) = extract_forge_version_from_log(&content) {
                return Some((ServerLoader::Forge, Some(version), evidence));
            }
        }
        return Some((ServerLoader::Forge, None, evidence));
    }

    if fs::try_exists(&user_jvm).await.unwrap_or(false) {
        evidence.push("Found user_jvm_args.txt (Forge/NeoForge)".into());
        // Could be Forge or NeoForge, need more info
    }

    if fs::try_exists(&forge_config_dir).await.unwrap_or(false) {
        evidence.push("Found config/forge directory".into());
        return Some((ServerLoader::Forge, None, evidence));
    }

    // NeoForge: neoforge-installer.jar.log or neoforge in libraries
    let neoforge_log = server_dir.join("neoforge-installer.jar.log");
    let neoforge_config_dir = server_dir.join("config").join("neoforge");

    if fs::try_exists(&neoforge_log).await.unwrap_or(false) {
        evidence.push("Found neoforge-installer.jar.log".into());
        return Some((ServerLoader::NeoForge, None, evidence));
    }

    if fs::try_exists(&neoforge_config_dir).await.unwrap_or(false) {
        evidence.push("Found config/neoforge directory".into());
        return Some((ServerLoader::NeoForge, None, evidence));
    }

    if !evidence.is_empty() {
        // We found something but not conclusive
        return Some((ServerLoader::Vanilla, None, evidence));
    }

    None
}

/// Read Fabric version from .fabric directory
async fn read_fabric_version(fabric_dir: &Path) -> Option<String> {
    let remapped_path = fabric_dir.join("remappedJars");
    if fs::try_exists(&remapped_path).await.unwrap_or(false) {
        // Try to find version from remapped jars folder name
        if let Ok(mut entries) = fs::read_dir(&remapped_path).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with("net.fabricmc.fabric-loader-") {
                    return Some(name.replace("net.fabricmc.fabric-loader-", ""));
                }
            }
        }
    }
    None
}

/// Extract Forge version from installer log
fn extract_forge_version_from_log(content: &str) -> Option<String> {
    // Look for patterns like "Installing: net.minecraftforge:forge:1.20.1-47.2.0"
    for line in content.lines() {
        if line.contains("net.minecraftforge:forge:") {
            if let Some(version_part) = line.split("forge:").nth(1) {
                let version = version_part.split_whitespace().next()?;
                // Format: 1.20.1-47.2.0
                if let Some(forge_ver) = version.split('-').nth(1) {
                    return Some(forge_ver.to_string());
                }
            }
        }
        if line.contains("net.neoforged:neoforge:") {
            if let Some(version_part) = line.split("neoforge:").nth(1) {
                return version_part.split_whitespace().next().map(String::from);
            }
        }
    }
    None
}

/// Detect from libraries folder
async fn detect_from_libraries(
    server_dir: &Path,
) -> Option<(ServerLoader, Option<String>, Option<String>, Vec<String>)> {
    let libraries_dir = server_dir.join("libraries");
    if !fs::try_exists(&libraries_dir).await.unwrap_or(false) {
        return None;
    }

    let mut evidence = Vec::new();

    // Check for specific library paths
    let fabric_loader = libraries_dir.join("net/fabricmc/fabric-loader");
    let quilt_loader = libraries_dir.join("org/quiltmc/quilt-loader");
    let forge_libs = libraries_dir.join("net/minecraftforge/forge");
    let neoforge_libs = libraries_dir.join("net/neoforged/neoforge");

    if fs::try_exists(&fabric_loader).await.unwrap_or(false) {
        evidence.push("Found net/fabricmc/fabric-loader in libraries".into());

        // Get version from folder name
        let version = get_latest_version_from_dir(&fabric_loader).await;
        let mc_version = detect_mc_version_from_libraries(&libraries_dir).await;

        return Some((ServerLoader::Fabric, mc_version, version, evidence));
    }

    if fs::try_exists(&quilt_loader).await.unwrap_or(false) {
        evidence.push("Found org/quiltmc/quilt-loader in libraries".into());

        let version = get_latest_version_from_dir(&quilt_loader).await;
        let mc_version = detect_mc_version_from_libraries(&libraries_dir).await;

        return Some((ServerLoader::Quilt, mc_version, version, evidence));
    }

    if fs::try_exists(&neoforge_libs).await.unwrap_or(false) {
        evidence.push("Found net/neoforged/neoforge in libraries".into());

        let version = get_latest_version_from_dir(&neoforge_libs).await;
        let mc_version = detect_mc_version_from_libraries(&libraries_dir).await;

        return Some((ServerLoader::NeoForge, mc_version, version, evidence));
    }

    if fs::try_exists(&forge_libs).await.unwrap_or(false) {
        evidence.push("Found net/minecraftforge/forge in libraries".into());

        let version = get_latest_version_from_dir(&forge_libs).await;
        let mc_version = detect_mc_version_from_libraries(&libraries_dir).await;

        return Some((ServerLoader::Forge, mc_version, version, evidence));
    }

    // Check for vanilla Minecraft
    let mc_libs = libraries_dir.join("net/minecraft/server");
    if fs::try_exists(&mc_libs).await.unwrap_or(false) {
        evidence.push("Found vanilla Minecraft libraries".into());
        let mc_version = get_latest_version_from_dir(&mc_libs).await;
        return Some((ServerLoader::Vanilla, mc_version, None, evidence));
    }

    None
}

/// Get latest version from a directory containing version folders
async fn get_latest_version_from_dir(dir: &Path) -> Option<String> {
    let mut entries = fs::read_dir(dir).await.ok()?;
    let mut versions = Vec::new();

    while let Ok(Some(entry)) = entries.next_entry().await {
        if fs::metadata(entry.path()).await.map(|m| m.is_dir()).unwrap_or(false) {
            versions.push(entry.file_name().to_string_lossy().to_string());
        }
    }

    // Sort versions (simple string sort, good enough for most cases)
    versions.sort();
    versions.pop()
}

/// Detect Minecraft version from libraries
async fn detect_mc_version_from_libraries(libraries_dir: &Path) -> Option<String> {
    // Check various paths where MC version might be found
    let paths = [
        libraries_dir.join("net/minecraft/server"),
        libraries_dir.join("com/mojang/minecraft"),
    ];

    for path in &paths {
        if fs::try_exists(path).await.unwrap_or(false) {
            if let Some(version) = get_latest_version_from_dir(path).await {
                return Some(version);
            }
        }
    }

    None
}

/// Detect from JAR files
async fn detect_from_jars(
    server_dir: &Path,
) -> Option<(
    PathBuf,
    ServerLoader,
    Option<String>,
    Option<String>,
    Vec<String>,
)> {
    let mut entries = fs::read_dir(server_dir).await.ok()?;
    let mut evidence = Vec::new();

    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        if !name.ends_with(".jar") {
            continue;
        }

        // Check specific JAR names first
        if name.starts_with("fabric-server-launch") || name.starts_with("fabric-server-mc") {
            evidence.push(format!("Found Fabric server JAR: {}", name));
            return Some((path, ServerLoader::Fabric, None, None, evidence));
        }

        if name.starts_with("quilt-server-launch") {
            evidence.push(format!("Found Quilt server JAR: {}", name));
            return Some((path, ServerLoader::Quilt, None, None, evidence));
        }

        if name.starts_with("forge-") && name.contains("universal") {
            evidence.push(format!("Found Forge universal JAR: {}", name));
            // Try to parse version from name: forge-1.20.1-47.2.0-universal.jar
            if let Some((mc, forge)) = parse_forge_jar_name(&name) {
                return Some((path, ServerLoader::Forge, Some(mc), Some(forge), evidence));
            }
            return Some((path, ServerLoader::Forge, None, None, evidence));
        }

        // Check JAR manifest for vanilla server
        if name == "server.jar" || name == "minecraft_server.jar" {
            if let Some((mc_version, loader, ev)) = inspect_jar_manifest(&path).await {
                evidence.extend(ev);
                return Some((path, loader, mc_version, None, evidence));
            }
        }
    }

    None
}

/// Parse Forge JAR name for versions
fn parse_forge_jar_name(name: &str) -> Option<(String, String)> {
    // Format: forge-1.20.1-47.2.0-universal.jar
    let parts: Vec<&str> = name.trim_end_matches(".jar").split('-').collect();
    if parts.len() >= 3 {
        let mc = parts[1].to_string();
        let forge = parts[2].to_string();
        return Some((mc, forge));
    }
    None
}

/// Inspect JAR manifest
async fn inspect_jar_manifest(
    jar_path: &Path,
) -> Option<(Option<String>, ServerLoader, Vec<String>)> {
    // Use spawn_blocking for sync zip operations
    let jar_path = jar_path.to_path_buf();

    tokio::task::spawn_blocking(move || {
        let file = std::fs::File::open(&jar_path).ok()?;
        let mut archive = ZipArchive::new(file).ok()?;

        let mut evidence = Vec::new();

        // Check MANIFEST.MF
        if let Ok(mut manifest) = archive.by_name("META-INF/MANIFEST.MF") {
            let mut content = String::new();
            manifest.read_to_string(&mut content).ok()?;

            // Look for version info
            for line in content.lines() {
                if line.starts_with("Implementation-Version:") {
                    evidence.push(format!("Manifest version: {}", line));
                }
                if line.contains("FabricLoader") {
                    evidence.push("Manifest indicates Fabric".into());
                    return Some((None, ServerLoader::Fabric, evidence));
                }
                if line.contains("QuiltLoader") {
                    evidence.push("Manifest indicates Quilt".into());
                    return Some((None, ServerLoader::Quilt, evidence));
                }
            }
        }

        // Check version.json (Vanilla server includes this)
        if let Ok(mut version_json) = archive.by_name("version.json") {
            let mut content = String::new();
            version_json.read_to_string(&mut content).ok()?;

            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(id) = json["id"].as_str() {
                    evidence.push(format!("Found version.json with id: {}", id));
                    return Some((Some(id.to_string()), ServerLoader::Vanilla, evidence));
                }
            }
        }

        // Check for fabric.mod.json
        if archive.by_name("fabric.mod.json").is_ok() {
            evidence.push("Found fabric.mod.json in JAR".into());
            return Some((None, ServerLoader::Fabric, evidence));
        }

        // Check for quilt.mod.json
        if archive.by_name("quilt.mod.json").is_ok() {
            evidence.push("Found quilt.mod.json in JAR".into());
            return Some((None, ServerLoader::Quilt, evidence));
        }

        if !evidence.is_empty() {
            Some((None, ServerLoader::Vanilla, evidence))
        } else {
            None
        }
    })
    .await
    .ok()?
}

/// Detect from run scripts
async fn detect_from_run_scripts(server_dir: &Path) -> Option<(ServerLoader, Vec<String>)> {
    let run_sh = server_dir.join("run.sh");
    let run_bat = server_dir.join("run.bat");

    let mut evidence = Vec::new();

    for script_path in [&run_sh, &run_bat] {
        if !fs::try_exists(script_path).await.unwrap_or(false) {
            continue;
        }

        if let Ok(content) = fs::read_to_string(script_path).await {
            let content_lower = content.to_lowercase();

            if content_lower.contains("neoforge") || content_lower.contains("net/neoforged") {
                evidence.push(format!(
                    "Run script references NeoForge: {}",
                    script_path.display()
                ));
                return Some((ServerLoader::NeoForge, evidence));
            }

            if content_lower.contains("minecraftforge")
                || content_lower.contains("net/minecraftforge")
            {
                evidence.push(format!(
                    "Run script references Forge: {}",
                    script_path.display()
                ));
                return Some((ServerLoader::Forge, evidence));
            }

            if content_lower.contains("fabric") {
                evidence.push(format!(
                    "Run script references Fabric: {}",
                    script_path.display()
                ));
                return Some((ServerLoader::Fabric, evidence));
            }

            if content_lower.contains("quilt") {
                evidence.push(format!(
                    "Run script references Quilt: {}",
                    script_path.display()
                ));
                return Some((ServerLoader::Quilt, evidence));
            }
        }
    }

    None
}

/// Detect from mods folder
async fn detect_from_mods(server_dir: &Path) -> Option<(ServerLoader, Vec<String>)> {
    let mods_dir = server_dir.join("mods");
    if !fs::try_exists(&mods_dir).await.unwrap_or(false) {
        return None;
    }

    let mut evidence = Vec::new();
    let mut fabric_count = 0;
    let mut forge_count = 0;

    let mut entries = fs::read_dir(&mods_dir).await.ok()?;

    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if !path.extension().map_or(false, |e| e == "jar") {
            continue;
        }

        // Quick check: inspect mod JAR for fabric.mod.json or mods.toml
        if let Some(mod_type) = detect_mod_type(&path).await {
            match mod_type.as_str() {
                "fabric" => fabric_count += 1,
                "quilt" => fabric_count += 1, // Quilt mods are often Fabric-compatible
                "forge" => forge_count += 1,
                _ => {}
            }
        }
    }

    if fabric_count > 0 || forge_count > 0 {
        evidence.push(format!(
            "Mods folder analysis: {} Fabric-like, {} Forge-like mods",
            fabric_count, forge_count
        ));

        if fabric_count > forge_count {
            return Some((ServerLoader::Fabric, evidence));
        } else if forge_count > 0 {
            return Some((ServerLoader::Forge, evidence));
        }
    }

    None
}

/// Detect mod type from JAR
async fn detect_mod_type(jar_path: &Path) -> Option<String> {
    let jar_path = jar_path.to_path_buf();

    tokio::task::spawn_blocking(move || {
        let file = std::fs::File::open(&jar_path).ok()?;
        let mut archive = ZipArchive::new(file).ok()?;

        if archive.by_name("fabric.mod.json").is_ok() {
            return Some("fabric".to_string());
        }

        if archive.by_name("quilt.mod.json").is_ok() {
            return Some("quilt".to_string());
        }

        if archive.by_name("META-INF/mods.toml").is_ok() {
            return Some("forge".to_string());
        }

        if archive.by_name("mcmod.info").is_ok() {
            return Some("forge".to_string());
        }

        None
    })
    .await
    .ok()?
}

/// Count mods in mods folder
async fn count_mods(server_dir: &Path) -> usize {
    let mods_dir = server_dir.join("mods");
    if !fs::try_exists(&mods_dir).await.unwrap_or(false) {
        return 0;
    }

    let mut count = 0;
    if let Ok(mut entries) = fs::read_dir(&mods_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            if entry.path().extension().map_or(false, |e| e == "jar") {
                count += 1;
            }
        }
    }
    count
}

/// Progress event for import
#[derive(Debug, Clone, serde::Serialize)]
pub struct ImportProgress {
    pub phase: String,
    pub current: usize,
    pub total: usize,
    pub current_file: Option<String>,
    pub bytes_copied: u64,
    pub total_bytes: u64,
}

/// File entry for copying
struct FileEntry {
    src: PathBuf,
    dst: PathBuf,
    size: u64,
}

/// Scan directory to collect all files
async fn scan_directory(src: &Path, dst: &Path) -> ServerResult<(Vec<FileEntry>, u64)> {
    let mut files = Vec::new();
    let mut total_size = 0u64;
    let mut stack = vec![(src.to_path_buf(), dst.to_path_buf())];

    while let Some((src_path, dst_path)) = stack.pop() {
        let mut entries = fs::read_dir(&src_path).await?;

        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            let file_type = entry.file_type().await?;
            let dest = dst_path.join(entry.file_name());

            if file_type.is_dir() {
                stack.push((path, dest));
            } else if file_type.is_file() {
                let metadata = entry.metadata().await?;
                let size = metadata.len();
                total_size += size;
                files.push(FileEntry {
                    src: path,
                    dst: dest,
                    size,
                });
            }
        }
    }

    Ok((files, total_size))
}

/// Import server to instances directory with progress events
pub async fn import_server_with_progress<F>(
    source_dir: impl AsRef<Path>,
    instance_name: &str,
    on_progress: F,
) -> ServerResult<ImportResult>
where
    F: Fn(ImportProgress) + Send + Sync + 'static,
{
    let source_dir = source_dir.as_ref();

    // Phase 1: Detect server
    on_progress(ImportProgress {
        phase: "detecting".into(),
        current: 0,
        total: 1,
        current_file: None,
        bytes_copied: 0,
        total_bytes: 0,
    });

    let detected = detect_server(source_dir).await?;

    // Generate short ID like other instances
    let instance_id = crate::utils::gen_short_id(8);

    // Create instance directory
    let instances_dir = crate::paths::instances_dir();
    let target_dir = instances_dir.join(&instance_id);

    fs::create_dir_all(&target_dir).await?;

    // Phase 2: Scan files
    on_progress(ImportProgress {
        phase: "scanning".into(),
        current: 0,
        total: 1,
        current_file: None,
        bytes_copied: 0,
        total_bytes: 0,
    });

    let (files, total_bytes) = scan_directory(source_dir, &target_dir).await?;
    let total_files = files.len();

    log::info!("Importing {} files ({} bytes)", total_files, total_bytes);

    // Phase 3: Create all directories first
    let mut dirs_to_create = std::collections::HashSet::new();
    for file in &files {
        if let Some(parent) = file.dst.parent() {
            dirs_to_create.insert(parent.to_path_buf());
        }
    }

    for dir in dirs_to_create {
        fs::create_dir_all(&dir).await?;
    }

    // Phase 4: Copy files in parallel batches
    let files_copied = std::sync::atomic::AtomicUsize::new(0);
    let bytes_copied = std::sync::atomic::AtomicU64::new(0);

    // Use parallel copying with limited concurrency
    const BATCH_SIZE: usize = 50;
    let on_progress = std::sync::Arc::new(on_progress);

    for batch in files.chunks(BATCH_SIZE) {
        let mut handles = Vec::new();

        for file in batch {
            let src = file.src.clone();
            let dst = file.dst.clone();
            let size = file.size;

            let handle = tokio::spawn(async move {
                // Use std::fs::copy in spawn_blocking for better performance on large files
                let src_clone = src.clone();
                let dst_clone = dst.clone();

                if size > 10 * 1024 * 1024 {
                    // > 10MB - use blocking copy
                    tokio::task::spawn_blocking(move || std::fs::copy(&src_clone, &dst_clone))
                        .await
                        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?
                } else {
                    // Small files - use async copy
                    fs::copy(&src, &dst).await
                }
            });
            handles.push((handle, file.size, file.src.clone()));
        }

        for (handle, size, src) in handles {
            match handle.await {
                Ok(Ok(_)) => {
                    let copied = files_copied.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                    let bytes =
                        bytes_copied.fetch_add(size, std::sync::atomic::Ordering::SeqCst) + size;

                    // Emit progress every 100 files or at least every 10MB
                    if copied % 100 == 0 || bytes % (10 * 1024 * 1024) < size {
                        on_progress(ImportProgress {
                            phase: "copying".into(),
                            current: copied,
                            total: total_files,
                            current_file: src.file_name().map(|s| s.to_string_lossy().to_string()),
                            bytes_copied: bytes,
                            total_bytes,
                        });
                    }
                }
                Ok(Err(e)) => {
                    log::error!("Failed to copy {}: {}", src.display(), e);
                    // Continue with other files
                }
                Err(e) => {
                    log::error!("Task panicked for {}: {}", src.display(), e);
                }
            }
        }
    }

    let final_files_copied = files_copied.load(std::sync::atomic::Ordering::SeqCst);
    let final_bytes_copied = bytes_copied.load(std::sync::atomic::Ordering::SeqCst);

    // Phase 5: Save to database
    on_progress(ImportProgress {
        phase: "saving".into(),
        current: final_files_copied,
        total: total_files,
        current_file: None,
        bytes_copied: final_bytes_copied,
        total_bytes,
    });

    // Convert ServerLoader to LoaderType string
    let loader_str = detected.loader.to_string();

    // Get port from properties
    let port = detected.properties.as_ref().map(|p| p.port() as i32);

    // Get memory defaults
    let memory_min = crate::settings::SettingsManager::get_default_memory_min().unwrap_or(2048);
    let memory_max = crate::settings::SettingsManager::get_default_memory_max().unwrap_or(4096);

    // Get Java version
    let java_version = if let Some(ref mc_version) = detected.minecraft_version {
        crate::java::JavaManager::required_java_version(mc_version).to_string()
    } else {
        "21".to_string() // Default to Java 21 for modern servers
    };

    let now = chrono::Utc::now().to_rfc3339();
    let dir = target_dir.to_string_lossy().to_string();

    // Insert into database
    let conn = stuzhik_db::get_db_conn().map_err(|e| ServerError::Database(e.to_string()))?;
    conn.execute(
        r#"INSERT INTO instances (
            id, name, version, loader, loader_version, instance_type,
            java_version, java_path, memory_min, memory_max, java_args, game_args,
            dir, port, rcon_enabled, rcon_port, rcon_password, username,
            status, pid, auto_restart, total_playtime, notes,
            installation_step, installation_error, backup_enabled,
            created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28)"#,
        rusqlite::params![
            instance_id,
            instance_name,
            detected.minecraft_version.clone().unwrap_or_else(|| "unknown".to_string()),
            loader_str,
            detected.loader_version.clone(),
            "server",
            java_version,
            None::<String>,
            memory_min,
            memory_max,
            None::<String>,
            None::<String>,
            dir,
            port,
            0, // rcon_enabled
            None::<i32>,
            None::<String>,
            None::<String>, // username
            "stopped", // status - ready to use!
            None::<i64>,
            0, // auto_restart
            0, // total_playtime
            None::<String>, // notes
            None::<String>, // installation_step
            None::<String>, // installation_error
            None::<i32>, // backup_enabled
            now.clone(),
            now,
        ],
    ).map_err(|e| ServerError::Database(e.to_string()))?;

    // Phase 6: Scan and register mods
    on_progress(ImportProgress {
        phase: "scanning_mods".into(),
        current: final_files_copied,
        total: total_files,
        current_file: None,
        bytes_copied: final_bytes_copied,
        total_bytes,
    });

    // Sync mods folder with database to register all imported mods
    if let Err(e) = crate::mods::ModManager::sync_mods_with_folder(&instance_id).await {
        log::warn!("Failed to sync mods after import: {}", e);
        // Don't fail the import, mods can be synced later
    } else {
        log::info!("Successfully synced mods for imported server");
    }

    log::info!(
        "Imported server '{}' (id: {}, loader: {:?}, files: {}, size: {} bytes)",
        instance_name,
        instance_id,
        detected.loader,
        final_files_copied,
        final_bytes_copied
    );

    Ok(ImportResult {
        instance_id,
        detected,
        files_copied: final_files_copied,
        total_size: final_bytes_copied,
    })
}

/// Legacy import without progress (for backwards compatibility)
pub async fn import_server(
    source_dir: impl AsRef<Path>,
    instance_name: &str,
) -> ServerResult<ImportResult> {
    import_server_with_progress(source_dir, instance_name, |_| {}).await
}

// Tauri commands

#[tauri::command]
pub async fn detect_server_type(path: String) -> Result<DetectedServer, String> {
    detect_server(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn import_existing_server(
    app_handle: tauri::AppHandle,
    source_path: String,
    instance_name: String,
) -> Result<ImportResult, String> {
    use tauri::Emitter;

    let app = app_handle.clone();

    import_server_with_progress(&source_path, &instance_name, move |progress| {
        let _ = app.emit("server-import-progress", &progress);
    })
    .await
    .map_err(|e| e.to_string())
}
