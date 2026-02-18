//! server.properties parser and editor
//!
//! Handles reading, writing, and modifying Minecraft server.properties files.
//! Preserves comments and formatting when possible.

use std::collections::HashMap;
use std::path::Path;
use tokio::fs;
use tokio::io::{AsyncBufReadExt, BufReader};

use super::ServerResult;

/// Parsed server.properties file
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct ServerProperties {
    /// Key-value properties
    pub properties: HashMap<String, String>,
    /// Original lines for preserving comments and order
    #[serde(skip)]
    original_lines: Vec<PropertyLine>,
}

#[derive(Debug, Clone)]
enum PropertyLine {
    Comment(String),
    Property { key: String, value: String },
    Empty,
}

impl ServerProperties {
    /// Load properties from file
    pub async fn load(path: impl AsRef<Path>) -> ServerResult<Self> {
        let path = path.as_ref();

        if !fs::try_exists(path).await.unwrap_or(false) {
            return Ok(Self::default_properties());
        }

        let file = fs::File::open(path).await?;
        let reader = BufReader::new(file);
        let mut lines = reader.lines();

        let mut properties = HashMap::new();
        let mut original_lines = Vec::new();

        while let Some(line) = lines.next_line().await? {
            let trimmed = line.trim();

            if trimmed.is_empty() {
                original_lines.push(PropertyLine::Empty);
            } else if trimmed.starts_with('#') {
                original_lines.push(PropertyLine::Comment(line.clone()));
            } else if let Some((key, value)) = trimmed.split_once('=') {
                let key = key.trim().to_string();
                let value = value.trim().to_string();
                properties.insert(key.clone(), value.clone());
                original_lines.push(PropertyLine::Property { key, value });
            }
        }

        Ok(Self {
            properties,
            original_lines,
        })
    }

    /// Save properties to file, preserving comments and order
    pub async fn save(&self, path: impl AsRef<Path>) -> ServerResult<()> {
        let mut output = String::new();
        let mut written_keys = std::collections::HashSet::new();

        // Write original lines with updated values
        for line in &self.original_lines {
            match line {
                PropertyLine::Comment(c) => {
                    output.push_str(c);
                    output.push('\n');
                }
                PropertyLine::Empty => {
                    output.push('\n');
                }
                PropertyLine::Property { key, .. } => {
                    if let Some(value) = self.properties.get(key) {
                        output.push_str(&format!("{}={}\n", key, value));
                        written_keys.insert(key.clone());
                    }
                }
            }
        }

        // Write any new properties that weren't in original file
        for (key, value) in &self.properties {
            if !written_keys.contains(key) {
                output.push_str(&format!("{}={}\n", key, value));
            }
        }

        fs::write(path, output).await?;
        Ok(())
    }

    /// Get a property value
    pub fn get(&self, key: &str) -> Option<&String> {
        self.properties.get(key)
    }

    /// Get a property as bool
    pub fn get_bool(&self, key: &str) -> Option<bool> {
        self.properties.get(key).map(|v| v == "true")
    }

    /// Get a property as i32
    pub fn get_i32(&self, key: &str) -> Option<i32> {
        self.properties.get(key).and_then(|v| v.parse().ok())
    }

    /// Set a property value
    pub fn set(&mut self, key: impl Into<String>, value: impl Into<String>) {
        let key = key.into();
        let value = value.into();

        // Update or add to original_lines
        let mut found = false;
        for line in &mut self.original_lines {
            if let PropertyLine::Property { key: k, value: v } = line {
                if k == &key {
                    *v = value.clone();
                    found = true;
                    break;
                }
            }
        }

        if !found {
            self.original_lines.push(PropertyLine::Property {
                key: key.clone(),
                value: value.clone(),
            });
        }

        self.properties.insert(key, value);
    }

    /// Set a bool property
    pub fn set_bool(&mut self, key: impl Into<String>, value: bool) {
        self.set(key, if value { "true" } else { "false" });
    }

    /// Set an i32 property
    pub fn set_i32(&mut self, key: impl Into<String>, value: i32) {
        self.set(key, value.to_string());
    }

    /// Create default server.properties
    pub fn default_properties() -> Self {
        let mut props = Self::default();

        // Essential defaults
        props.set("server-port", "25565");
        props.set("query.port", "25565");
        props.set("rcon.port", "25575");
        props.set("enable-rcon", "false");
        props.set("enable-query", "false");
        props.set("motd", "A Minecraft Server");
        props.set("max-players", "20");
        props.set("online-mode", "true");
        props.set("white-list", "false");
        props.set("difficulty", "normal");
        props.set("gamemode", "survival");
        props.set("level-name", "world");
        props.set("level-type", "minecraft:normal");
        props.set("spawn-protection", "16");
        props.set("view-distance", "10");
        props.set("simulation-distance", "10");
        props.set("max-tick-time", "60000");
        props.set("allow-flight", "false");
        props.set("spawn-npcs", "true");
        props.set("spawn-animals", "true");
        props.set("spawn-monsters", "true");
        props.set("generate-structures", "true");
        props.set("pvp", "true");
        props.set("enable-command-block", "false");
        props.set("allow-nether", "true");
        props.set("enforce-whitelist", "false");
        props.set("broadcast-console-to-ops", "true");
        props.set("broadcast-rcon-to-ops", "true");

        props
    }

    /// Get server port
    pub fn port(&self) -> u16 {
        self.get_i32("server-port").unwrap_or(25565) as u16
    }

    /// Get RCON port
    pub fn rcon_port(&self) -> u16 {
        self.get_i32("rcon.port").unwrap_or(25575) as u16
    }

    /// Get RCON password
    pub fn rcon_password(&self) -> Option<&String> {
        self.get("rcon.password")
    }

    /// Check if RCON is enabled
    pub fn rcon_enabled(&self) -> bool {
        self.get_bool("enable-rcon").unwrap_or(false)
    }

    /// Get MOTD
    pub fn motd(&self) -> String {
        self.get("motd")
            .cloned()
            .unwrap_or_else(|| "A Minecraft Server".to_string())
    }

    /// Get max players
    pub fn max_players(&self) -> i32 {
        self.get_i32("max-players").unwrap_or(20)
    }

    /// Check if whitelist is enabled
    pub fn whitelist_enabled(&self) -> bool {
        self.get_bool("white-list").unwrap_or(false)
    }

    /// Check if online mode is enabled
    pub fn online_mode(&self) -> bool {
        self.get_bool("online-mode").unwrap_or(true)
    }

    /// Configure RCON
    pub fn configure_rcon(&mut self, enabled: bool, port: u16, password: &str) {
        self.set_bool("enable-rcon", enabled);
        self.set_i32("rcon.port", port as i32);
        self.set("rcon.password", password);
    }

    /// Configure basic server settings
    pub fn configure_basic(&mut self, port: u16, motd: &str, max_players: i32) {
        self.set_i32("server-port", port as i32);
        self.set("motd", motd);
        self.set_i32("max-players", max_players);
    }
}

/// Structured server properties for frontend
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ServerPropertiesUI {
    // Network
    pub port: u16,
    pub max_players: i32,
    pub online_mode: bool,
    pub motd: String,

    // RCON
    pub rcon_enabled: bool,
    pub rcon_port: u16,
    pub rcon_password: String,

    // Whitelist
    pub whitelist_enabled: bool,
    pub enforce_whitelist: bool,

    // World
    pub level_name: String,
    pub gamemode: String,
    pub difficulty: String,
    pub hardcore: bool,
    pub pvp: bool,

    // Performance
    pub view_distance: i32,
    pub simulation_distance: i32,
    pub max_tick_time: i32,

    // Spawning
    pub spawn_protection: i32,
    pub spawn_npcs: bool,
    pub spawn_animals: bool,
    pub spawn_monsters: bool,

    // Features
    pub allow_flight: bool,
    pub allow_nether: bool,
    pub enable_command_block: bool,
    pub generate_structures: bool,

    // All raw properties for advanced editing
    pub raw: HashMap<String, String>,
}

impl From<&ServerProperties> for ServerPropertiesUI {
    fn from(props: &ServerProperties) -> Self {
        Self {
            port: props.port(),
            max_players: props.max_players(),
            online_mode: props.online_mode(),
            motd: props.motd(),

            rcon_enabled: props.rcon_enabled(),
            rcon_port: props.rcon_port(),
            rcon_password: props.rcon_password().cloned().unwrap_or_default(),

            whitelist_enabled: props.whitelist_enabled(),
            enforce_whitelist: props.get_bool("enforce-whitelist").unwrap_or(false),

            level_name: props
                .get("level-name")
                .cloned()
                .unwrap_or_else(|| "world".to_string()),
            gamemode: props
                .get("gamemode")
                .cloned()
                .unwrap_or_else(|| "survival".to_string()),
            difficulty: props
                .get("difficulty")
                .cloned()
                .unwrap_or_else(|| "normal".to_string()),
            hardcore: props.get_bool("hardcore").unwrap_or(false),
            pvp: props.get_bool("pvp").unwrap_or(true),

            view_distance: props.get_i32("view-distance").unwrap_or(10),
            simulation_distance: props.get_i32("simulation-distance").unwrap_or(10),
            max_tick_time: props.get_i32("max-tick-time").unwrap_or(60000),

            spawn_protection: props.get_i32("spawn-protection").unwrap_or(16),
            spawn_npcs: props.get_bool("spawn-npcs").unwrap_or(true),
            spawn_animals: props.get_bool("spawn-animals").unwrap_or(true),
            spawn_monsters: props.get_bool("spawn-monsters").unwrap_or(true),

            allow_flight: props.get_bool("allow-flight").unwrap_or(false),
            allow_nether: props.get_bool("allow-nether").unwrap_or(true),
            enable_command_block: props.get_bool("enable-command-block").unwrap_or(false),
            generate_structures: props.get_bool("generate-structures").unwrap_or(true),

            raw: props.properties.clone(),
        }
    }
}

impl ServerPropertiesUI {
    /// Apply UI changes to ServerProperties
    pub fn apply_to(&self, props: &mut ServerProperties) {
        props.set_i32("server-port", self.port as i32);
        props.set_i32("max-players", self.max_players);
        props.set_bool("online-mode", self.online_mode);
        props.set("motd", &self.motd);

        props.set_bool("enable-rcon", self.rcon_enabled);
        props.set_i32("rcon.port", self.rcon_port as i32);
        props.set("rcon.password", &self.rcon_password);

        props.set_bool("white-list", self.whitelist_enabled);
        props.set_bool("enforce-whitelist", self.enforce_whitelist);

        props.set("level-name", &self.level_name);
        props.set("gamemode", &self.gamemode);
        props.set("difficulty", &self.difficulty);
        props.set_bool("hardcore", self.hardcore);
        props.set_bool("pvp", self.pvp);

        props.set_i32("view-distance", self.view_distance);
        props.set_i32("simulation-distance", self.simulation_distance);
        props.set_i32("max-tick-time", self.max_tick_time);

        props.set_i32("spawn-protection", self.spawn_protection);
        props.set_bool("spawn-npcs", self.spawn_npcs);
        props.set_bool("spawn-animals", self.spawn_animals);
        props.set_bool("spawn-monsters", self.spawn_monsters);

        props.set_bool("allow-flight", self.allow_flight);
        props.set_bool("allow-nether", self.allow_nether);
        props.set_bool("enable-command-block", self.enable_command_block);
        props.set_bool("generate-structures", self.generate_structures);
    }
}

// Tauri commands
#[tauri::command]
pub async fn get_server_properties(
    instance_id: String,
) -> Result<HashMap<String, serde_json::Value>, String> {
    let instances_dir = crate::paths::instances_dir();
    let props_path = instances_dir.join(&instance_id).join("server.properties");

    let props = ServerProperties::load(&props_path)
        .await
        .map_err(|e| e.to_string())?;

    // Return all properties with proper types
    let mut result = HashMap::new();
    for (key, value) in props.properties.iter() {
        // Try to parse as bool, then number, then keep as string
        let json_value = if value == "true" || value == "false" {
            serde_json::Value::Bool(value == "true")
        } else if let Ok(n) = value.parse::<i64>() {
            serde_json::Value::Number(n.into())
        } else if let Ok(n) = value.parse::<f64>() {
            serde_json::json!(n)
        } else {
            serde_json::Value::String(value.clone())
        };
        result.insert(key.clone(), json_value);
    }

    Ok(result)
}

#[tauri::command]
pub async fn save_server_properties(
    instance_id: String,
    properties: HashMap<String, serde_json::Value>,
) -> Result<(), String> {
    let instances_dir = crate::paths::instances_dir();
    let props_path = instances_dir.join(&instance_id).join("server.properties");

    let mut props = ServerProperties::load(&props_path)
        .await
        .unwrap_or_else(|_| ServerProperties::default_properties());

    // Apply each property from the HashMap
    for (key, value) in properties {
        let str_value = match value {
            serde_json::Value::Bool(b) => b.to_string(),
            serde_json::Value::Number(n) => n.to_string(),
            serde_json::Value::String(s) => s,
            _ => continue,
        };
        props.set(&key, str_value);
    }

    props.save(&props_path).await.map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn create_default_server_properties(instance_id: String) -> Result<(), String> {
    let instances_dir = crate::paths::instances_dir();
    let props_path = instances_dir.join(&instance_id).join("server.properties");

    let props = ServerProperties::default_properties();
    props.save(&props_path).await.map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn set_server_property(
    instance_id: String,
    key: String,
    value: String,
) -> Result<(), String> {
    let instances_dir = crate::paths::instances_dir();
    let props_path = instances_dir.join(&instance_id).join("server.properties");

    let mut props = ServerProperties::load(&props_path)
        .await
        .unwrap_or_else(|_| ServerProperties::default_properties());

    props.set(&key, &value);

    props.save(&props_path).await.map_err(|e| e.to_string())?;

    Ok(())
}

/// Load raw properties for an instance (internal use)
pub async fn load_properties(server_dir: impl AsRef<Path>) -> ServerResult<ServerProperties> {
    let props_path = server_dir.as_ref().join("server.properties");
    ServerProperties::load(&props_path).await
}
