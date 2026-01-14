//! Project Detection System
//!
//! Detects KubeJS, CraftTweaker, Datapacks and their versions
//! to provide context-aware editing experience.

use crate::paths::instance_dir;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

// Local Result alias for this module
type Result<T> = std::result::Result<T, String>;

/// Detected project in an instance
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectedProject {
    /// Project type identifier
    pub project_type: ProjectType,
    /// Root directory relative to instance
    pub root_path: String,
    /// Display name
    pub name: String,
    /// Version if detected (e.g., "6.1" for KubeJS)
    pub version: Option<String>,
    /// Sub-projects or categories within this project
    pub categories: Vec<ProjectCategory>,
    /// Whether this project supports hot reload
    pub supports_hot_reload: bool,
    /// Files to watch for changes
    pub watch_patterns: Vec<String>,
}

/// Project type
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectType {
    /// KubeJS scripts
    #[serde(rename = "kubejs")]
    KubeJS,
    /// CraftTweaker/MineTweaker scripts
    #[serde(rename = "crafttweaker")]
    CraftTweaker,
    /// Datapacks (data/)
    #[serde(rename = "datapack")]
    Datapack,
    /// Resource packs (resourcepacks/)
    #[serde(rename = "resourcepack")]
    ResourcePack,
    /// Config files (config/)
    #[serde(rename = "configs")]
    Configs,
    /// Shader packs
    #[serde(rename = "shaders")]
    Shaders,
}

/// Category within a project
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectCategory {
    /// Category identifier
    pub id: String,
    /// Display name
    pub name: String,
    /// Path relative to project root
    pub path: String,
    /// File patterns this category handles
    pub file_patterns: Vec<String>,
    /// Description for UI
    pub description: Option<String>,
    /// Icon identifier
    pub icon: Option<String>,
    /// Templates available for this category
    pub templates: Vec<FileTemplate>,
}

/// File template for creating new files
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileTemplate {
    /// Template identifier
    pub id: String,
    /// Display name
    pub name: String,
    /// File extension
    pub extension: String,
    /// Default filename (without extension)
    pub default_name: String,
    /// Template content (with placeholders)
    pub content: String,
    /// Description
    pub description: Option<String>,
}

/// Instance project context
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstanceProjectContext {
    /// Instance ID
    pub instance_id: String,
    /// Minecraft version
    pub minecraft_version: String,
    /// Loader type
    pub loader: String,
    /// Detected projects
    pub projects: Vec<DetectedProject>,
    /// Mod versions map (mod_id -> version)
    pub mod_versions: HashMap<String, String>,
}

/// Detects projects in an instance
pub struct ProjectDetector {
    instance_id: String,
    instance_path: PathBuf,
}

impl ProjectDetector {
    pub fn new(instance_id: &str) -> Self {
        Self {
            instance_id: instance_id.to_string(),
            instance_path: instance_dir(instance_id),
        }
    }

    /// Detect all projects in the instance
    pub async fn detect(&self) -> Result<InstanceProjectContext> {
        let mut projects = Vec::new();
        let mut mod_versions = HashMap::new();

        // Detect KubeJS
        if let Some(kubejs) = self.detect_kubejs().await? {
            if let Some(ver) = &kubejs.version {
                mod_versions.insert("kubejs".to_string(), ver.clone());
            }
            projects.push(kubejs);
        }

        // Detect CraftTweaker
        if let Some(ct) = self.detect_crafttweaker().await? {
            if let Some(ver) = &ct.version {
                mod_versions.insert("crafttweaker".to_string(), ver.clone());
            }
            projects.push(ct);
        }

        // Detect Datapacks
        if let Some(datapack) = self.detect_datapacks().await? {
            projects.push(datapack);
        }

        // Detect Configs
        projects.push(self.detect_configs().await);

        // Detect Resource Packs
        if let Some(rp) = self.detect_resourcepacks().await? {
            projects.push(rp);
        }

        // Get Minecraft version and loader from instance info
        let (mc_version, loader) = self.get_instance_info().await;

        Ok(InstanceProjectContext {
            instance_id: self.instance_id.clone(),
            minecraft_version: mc_version,
            loader,
            projects,
            mod_versions,
        })
    }

    /// Detect KubeJS installation and version
    async fn detect_kubejs(&self) -> Result<Option<DetectedProject>> {
        let kubejs_dir = self.instance_path.join("kubejs");

        if !tokio::fs::try_exists(&kubejs_dir).await.unwrap_or(false) {
            return Ok(None);
        }

        // Try to detect KubeJS version from mods
        let version = self.detect_mod_version("kubejs").await;

        // Determine KubeJS API version based on mod version
        // Version can be:
        // - "6.x", "7.x" (already processed by extract_version_from_filename for Forge)
        // - "6.1.0", "7.0.0" (standard semver from Fabric/Quilt)
        let api_version = version.as_ref().map(|v| {
            // Already in X.x format (from Forge detection)
            if v.ends_with(".x") {
                return v.clone();
            }

            // Standard semver format - extract major version
            if v.starts_with("7.") {
                return "7.x".to_string();
            }
            if v.starts_with("6.") {
                return "6.x".to_string();
            }
            if v.starts_with("5.") {
                return "5.x".to_string();
            }
            if v.starts_with("4.") {
                return "4.x".to_string();
            }

            // Return the version as-is if it's valid
            v.clone()
        });

        let categories = self.build_kubejs_categories(&api_version).await;

        Ok(Some(DetectedProject {
            project_type: ProjectType::KubeJS,
            root_path: "kubejs".to_string(),
            name: "KubeJS".to_string(),
            version: api_version,
            categories,
            supports_hot_reload: true,
            watch_patterns: vec!["kubejs/**/*.js".to_string(), "kubejs/**/*.ts".to_string()],
        }))
    }

    /// Build KubeJS categories based on version
    async fn build_kubejs_categories(&self, api_version: &Option<String>) -> Vec<ProjectCategory> {
        let mut categories = Vec::new();

        // Server scripts (recipes, events)
        categories.push(ProjectCategory {
            id: "server_scripts".to_string(),
            name: "Server Scripts".to_string(),
            path: "server_scripts".to_string(),
            file_patterns: vec!["*.js".to_string(), "*.ts".to_string()],
            description: Some("Recipe modifications, server events".to_string()),
            icon: Some("server".to_string()),
            templates: self.get_kubejs_server_templates(api_version),
        });

        // Client scripts
        categories.push(ProjectCategory {
            id: "client_scripts".to_string(),
            name: "Client Scripts".to_string(),
            path: "client_scripts".to_string(),
            file_patterns: vec!["*.js".to_string(), "*.ts".to_string()],
            description: Some("Client-side modifications, JEI/REI tweaks".to_string()),
            icon: Some("client".to_string()),
            templates: self.get_kubejs_client_templates(api_version),
        });

        // Startup scripts
        categories.push(ProjectCategory {
            id: "startup_scripts".to_string(),
            name: "Startup Scripts".to_string(),
            path: "startup_scripts".to_string(),
            file_patterns: vec!["*.js".to_string(), "*.ts".to_string()],
            description: Some("Custom items, blocks, fluids".to_string()),
            icon: Some("startup".to_string()),
            templates: self.get_kubejs_startup_templates(api_version),
        });

        // Assets
        let assets_path = self.instance_path.join("kubejs/assets");
        if tokio::fs::try_exists(&assets_path).await.unwrap_or(false) {
            categories.push(ProjectCategory {
                id: "assets".to_string(),
                name: "Assets".to_string(),
                path: "assets".to_string(),
                file_patterns: vec!["*.json".to_string(), "*.png".to_string()],
                description: Some("Textures, models, lang files".to_string()),
                icon: Some("image".to_string()),
                templates: vec![],
            });
        }

        // Data
        let data_path = self.instance_path.join("kubejs/data");
        if tokio::fs::try_exists(&data_path).await.unwrap_or(false) {
            categories.push(ProjectCategory {
                id: "data".to_string(),
                name: "Data".to_string(),
                path: "data".to_string(),
                file_patterns: vec!["*.json".to_string()],
                description: Some("Loot tables, tags, advancements".to_string()),
                icon: Some("data".to_string()),
                templates: vec![],
            });
        }

        categories
    }

    /// Get KubeJS server script templates
    fn get_kubejs_server_templates(&self, api_version: &Option<String>) -> Vec<FileTemplate> {
        let is_v6_plus = api_version
            .as_ref()
            .map(|v| v.starts_with("6.") || v.starts_with("7."))
            .unwrap_or(true);

        if is_v6_plus {
            vec![
                FileTemplate {
                    id: "recipe_shaped".to_string(),
                    name: "Shaped Recipe".to_string(),
                    extension: "js".to_string(),
                    default_name: "shaped_recipe".to_string(),
                    content: r#"// Shaped crafting recipe
ServerEvents.recipes(event => {
  event.shaped(
    'minecraft:diamond', // Output
    [
      'AAA',
      'A A',
      'AAA'
    ],
    {
      A: 'minecraft:coal'
    }
  )
})
"#
                    .to_string(),
                    description: Some("Create a shaped crafting recipe".to_string()),
                },
                FileTemplate {
                    id: "recipe_shapeless".to_string(),
                    name: "Shapeless Recipe".to_string(),
                    extension: "js".to_string(),
                    default_name: "shapeless_recipe".to_string(),
                    content: r#"// Shapeless crafting recipe
ServerEvents.recipes(event => {
  event.shapeless(
    'minecraft:diamond', // Output
    [
      'minecraft:coal',
      'minecraft:coal',
      'minecraft:coal'
    ]
  )
})
"#
                    .to_string(),
                    description: Some("Create a shapeless crafting recipe".to_string()),
                },
                FileTemplate {
                    id: "recipe_smelting".to_string(),
                    name: "Smelting Recipe".to_string(),
                    extension: "js".to_string(),
                    default_name: "smelting_recipe".to_string(),
                    content: r#"// Smelting recipe
ServerEvents.recipes(event => {
  event.smelting('minecraft:iron_ingot', 'minecraft:raw_iron')

  // Blasting (faster)
  event.blasting('minecraft:iron_ingot', 'minecraft:raw_iron')

  // Smoking (food)
  // event.smoking('minecraft:cooked_beef', 'minecraft:beef')
})
"#
                    .to_string(),
                    description: Some("Create smelting/blasting recipes".to_string()),
                },
                FileTemplate {
                    id: "recipe_remove".to_string(),
                    name: "Remove Recipes".to_string(),
                    extension: "js".to_string(),
                    default_name: "remove_recipes".to_string(),
                    content: r#"// Remove recipes
ServerEvents.recipes(event => {
  // Remove by output
  event.remove({ output: 'minecraft:stick' })

  // Remove by ID
  event.remove({ id: 'minecraft:oak_planks' })

  // Remove by type
  // event.remove({ type: 'minecraft:crafting_shaped' })

  // Remove by mod
  // event.remove({ mod: 'create' })
})
"#
                    .to_string(),
                    description: Some("Remove existing recipes".to_string()),
                },
                FileTemplate {
                    id: "recipe_replace".to_string(),
                    name: "Replace Recipes".to_string(),
                    extension: "js".to_string(),
                    default_name: "replace_recipes".to_string(),
                    content: r#"// Replace ingredients in recipes
ServerEvents.recipes(event => {
  // Replace all occurrences of an ingredient
  event.replaceInput(
    {}, // filter (empty = all recipes)
    'minecraft:oak_planks', // original
    'minecraft:birch_planks' // replacement
  )

  // Replace output
  event.replaceOutput(
    {},
    'minecraft:stick',
    'minecraft:blaze_rod'
  )
})
"#
                    .to_string(),
                    description: Some("Replace ingredients/outputs in recipes".to_string()),
                },
                FileTemplate {
                    id: "tags".to_string(),
                    name: "Tag Modifications".to_string(),
                    extension: "js".to_string(),
                    default_name: "tags".to_string(),
                    content: r#"// Modify item/block tags
ServerEvents.tags('item', event => {
  // Add items to a tag
  event.add('forge:ingots/iron', 'minecraft:diamond')

  // Remove items from a tag
  event.remove('minecraft:planks', 'minecraft:oak_planks')

  // Create a new tag
  event.add('mymod:my_custom_tag', [
    'minecraft:diamond',
    'minecraft:emerald'
  ])
})

ServerEvents.tags('block', event => {
  // Similar for blocks
  event.add('minecraft:mineable/pickaxe', 'minecraft:obsidian')
})
"#
                    .to_string(),
                    description: Some("Add/remove items from tags".to_string()),
                },
                FileTemplate {
                    id: "loot".to_string(),
                    name: "Loot Table Modifications".to_string(),
                    extension: "js".to_string(),
                    default_name: "loot".to_string(),
                    content: r#"// Modify loot tables
ServerEvents.blockLootTables(event => {
  // Add drops to blocks
  event.addSimpleBlock('minecraft:diamond_ore', 'minecraft:diamond')

  // Modify existing loot table
  event.modify('minecraft:blocks/grass', loot => {
    loot.addPool(pool => {
      pool.addItem('minecraft:wheat_seeds', 1)
      pool.rolls = [1, 3]
    })
  })
})

ServerEvents.entityLootTables(event => {
  // Add drops to mobs
  event.modify('minecraft:entities/zombie', loot => {
    loot.addPool(pool => {
      pool.addItem('minecraft:diamond')
      pool.rolls = 1
      pool.randomChance(0.05) // 5% chance
    })
  })
})
"#
                    .to_string(),
                    description: Some("Modify block and entity loot tables".to_string()),
                },
            ]
        } else {
            // KubeJS 4.x/5.x templates (older API)
            vec![FileTemplate {
                id: "recipe_shaped".to_string(),
                name: "Shaped Recipe".to_string(),
                extension: "js".to_string(),
                default_name: "shaped_recipe".to_string(),
                content: r#"// Shaped crafting recipe (KubeJS 5.x)
onEvent('recipes', event => {
  event.shaped(
    'minecraft:diamond',
    [
      'AAA',
      'A A',
      'AAA'
    ],
    {
      A: 'minecraft:coal'
    }
  )
})
"#
                .to_string(),
                description: Some("Create a shaped crafting recipe".to_string()),
            }]
        }
    }

    /// Get KubeJS client script templates
    fn get_kubejs_client_templates(&self, _api_version: &Option<String>) -> Vec<FileTemplate> {
        vec![
            FileTemplate {
                id: "jei_hide".to_string(),
                name: "JEI/REI Hide Items".to_string(),
                extension: "js".to_string(),
                default_name: "jei_hide".to_string(),
                content: r#"// Hide items from JEI/REI
JEIEvents.hideItems(event => {
  // Hide specific items
  event.hide('minecraft:barrier')
  event.hide('minecraft:structure_void')

  // Hide by mod
  // event.hide('@examplemod')

  // Hide by tag
  // event.hide('#forge:hidden')
})
"#
                .to_string(),
                description: Some("Hide items from JEI/REI".to_string()),
            },
            FileTemplate {
                id: "tooltip".to_string(),
                name: "Custom Tooltips".to_string(),
                extension: "js".to_string(),
                default_name: "tooltips".to_string(),
                content: r#"// Add custom tooltips
ItemEvents.tooltip(event => {
  event.add('minecraft:diamond', [
    Text.of('Very shiny!').gold(),
    Text.of('Used for crafting').gray()
  ])

  // Add to all items with a tag
  event.add('#forge:ingots', 'This is an ingot')
})
"#
                .to_string(),
                description: Some("Add custom tooltips to items".to_string()),
            },
        ]
    }

    /// Get KubeJS startup script templates
    fn get_kubejs_startup_templates(&self, _api_version: &Option<String>) -> Vec<FileTemplate> {
        vec![
            FileTemplate {
                id: "custom_item".to_string(),
                name: "Custom Item".to_string(),
                extension: "js".to_string(),
                default_name: "custom_item".to_string(),
                content: r#"// Register a custom item
StartupEvents.registry('item', event => {
  event.create('my_custom_item')
    .displayName('My Custom Item')
    .maxStackSize(16)
    .rarity('rare')
    .glow(true)
})
"#
                .to_string(),
                description: Some("Create a custom item".to_string()),
            },
            FileTemplate {
                id: "custom_block".to_string(),
                name: "Custom Block".to_string(),
                extension: "js".to_string(),
                default_name: "custom_block".to_string(),
                content: r#"// Register a custom block
StartupEvents.registry('block', event => {
  event.create('my_custom_block')
    .displayName('My Custom Block')
    .hardness(2.0)
    .resistance(6.0)
    .requiresTool(true)
    .tagBlock('minecraft:mineable/pickaxe')
})
"#
                .to_string(),
                description: Some("Create a custom block".to_string()),
            },
        ]
    }

    /// Detect CraftTweaker installation
    async fn detect_crafttweaker(&self) -> Result<Option<DetectedProject>> {
        let scripts_dir = self.instance_path.join("scripts");

        if !tokio::fs::try_exists(&scripts_dir).await.unwrap_or(false) {
            return Ok(None);
        }

        // Check if any .zs files exist
        let mut has_zs_files = false;
        if let Ok(mut entries) = tokio::fs::read_dir(&scripts_dir).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                if entry.path().extension().map(|e| e == "zs").unwrap_or(false) {
                    has_zs_files = true;
                    break;
                }
            }
        }

        // Also check if CraftTweaker mod is installed
        let ct_version = self.detect_mod_version("crafttweaker").await;

        if !has_zs_files && ct_version.is_none() {
            return Ok(None);
        }

        let categories = vec![ProjectCategory {
            id: "scripts".to_string(),
            name: "Scripts".to_string(),
            path: ".".to_string(),
            file_patterns: vec!["*.zs".to_string()],
            description: Some("CraftTweaker ZenScript files".to_string()),
            icon: Some("script".to_string()),
            templates: self.get_crafttweaker_templates(),
        }];

        Ok(Some(DetectedProject {
            project_type: ProjectType::CraftTweaker,
            root_path: "scripts".to_string(),
            name: "CraftTweaker".to_string(),
            version: ct_version,
            categories,
            supports_hot_reload: true,
            watch_patterns: vec!["scripts/**/*.zs".to_string()],
        }))
    }

    /// Get CraftTweaker templates
    fn get_crafttweaker_templates(&self) -> Vec<FileTemplate> {
        vec![
            FileTemplate {
                id: "recipe_shaped".to_string(),
                name: "Shaped Recipe".to_string(),
                extension: "zs".to_string(),
                default_name: "shaped_recipe".to_string(),
                content: r#"// Shaped crafting recipe
import crafttweaker.api.recipe.IRecipeManager;

craftingTable.addShaped("custom_recipe", <item:minecraft:diamond>, [
    [<item:minecraft:coal>, <item:minecraft:coal>, <item:minecraft:coal>],
    [<item:minecraft:coal>, <item:minecraft:air>, <item:minecraft:coal>],
    [<item:minecraft:coal>, <item:minecraft:coal>, <item:minecraft:coal>]
]);
"#
                .to_string(),
                description: Some("Create a shaped crafting recipe".to_string()),
            },
            FileTemplate {
                id: "recipe_shapeless".to_string(),
                name: "Shapeless Recipe".to_string(),
                extension: "zs".to_string(),
                default_name: "shapeless_recipe".to_string(),
                content: r#"// Shapeless crafting recipe
craftingTable.addShapeless("custom_shapeless", <item:minecraft:diamond>, [
    <item:minecraft:coal>,
    <item:minecraft:coal>,
    <item:minecraft:coal>
]);
"#
                .to_string(),
                description: Some("Create a shapeless crafting recipe".to_string()),
            },
            FileTemplate {
                id: "recipe_remove".to_string(),
                name: "Remove Recipe".to_string(),
                extension: "zs".to_string(),
                default_name: "remove_recipes".to_string(),
                content: r#"// Remove recipes
craftingTable.removeByName("minecraft:oak_planks");
craftingTable.removeByOutput(<item:minecraft:stick>);

// Remove all recipes from a mod
// craftingTable.removeByModid("examplemod");
"#
                .to_string(),
                description: Some("Remove existing recipes".to_string()),
            },
        ]
    }

    /// Detect datapacks
    async fn detect_datapacks(&self) -> Result<Option<DetectedProject>> {
        // Check saves/*/datapacks and datapacks folders
        let datapacks_paths = [
            self.instance_path.join("datapacks"),
            // Also check in world saves - but that requires knowing the world name
        ];

        for path in &datapacks_paths {
            if tokio::fs::try_exists(path).await.unwrap_or(false) {
                return Ok(Some(DetectedProject {
                    project_type: ProjectType::Datapack,
                    root_path: path
                        .strip_prefix(&self.instance_path)
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_else(|_| "datapacks".to_string()),
                    name: "Datapacks".to_string(),
                    version: None,
                    categories: vec![
                        ProjectCategory {
                            id: "recipes".to_string(),
                            name: "Recipes".to_string(),
                            path: "data/*/recipes".to_string(),
                            file_patterns: vec!["*.json".to_string()],
                            description: Some("Custom recipes".to_string()),
                            icon: Some("recipe".to_string()),
                            templates: self.get_datapack_recipe_templates(),
                        },
                        ProjectCategory {
                            id: "loot_tables".to_string(),
                            name: "Loot Tables".to_string(),
                            path: "data/*/loot_tables".to_string(),
                            file_patterns: vec!["*.json".to_string()],
                            description: Some("Block and entity drops".to_string()),
                            icon: Some("loot".to_string()),
                            templates: vec![],
                        },
                        ProjectCategory {
                            id: "tags".to_string(),
                            name: "Tags".to_string(),
                            path: "data/*/tags".to_string(),
                            file_patterns: vec!["*.json".to_string()],
                            description: Some("Item, block, entity tags".to_string()),
                            icon: Some("tag".to_string()),
                            templates: vec![],
                        },
                        ProjectCategory {
                            id: "advancements".to_string(),
                            name: "Advancements".to_string(),
                            path: "data/*/advancements".to_string(),
                            file_patterns: vec!["*.json".to_string()],
                            description: Some("Custom advancements".to_string()),
                            icon: Some("advancement".to_string()),
                            templates: vec![],
                        },
                    ],
                    supports_hot_reload: true,
                    watch_patterns: vec!["datapacks/**/*.json".to_string()],
                }));
            }
        }

        Ok(None)
    }

    /// Get datapack recipe templates
    fn get_datapack_recipe_templates(&self) -> Vec<FileTemplate> {
        vec![
            FileTemplate {
                id: "recipe_shaped".to_string(),
                name: "Shaped Recipe".to_string(),
                extension: "json".to_string(),
                default_name: "shaped_recipe".to_string(),
                content: r#"{
  "type": "minecraft:crafting_shaped",
  "pattern": [
    "AAA",
    "A A",
    "AAA"
  ],
  "key": {
    "A": {
      "item": "minecraft:coal"
    }
  },
  "result": {
    "item": "minecraft:diamond",
    "count": 1
  }
}
"#
                .to_string(),
                description: Some("JSON shaped crafting recipe".to_string()),
            },
            FileTemplate {
                id: "recipe_shapeless".to_string(),
                name: "Shapeless Recipe".to_string(),
                extension: "json".to_string(),
                default_name: "shapeless_recipe".to_string(),
                content: r#"{
  "type": "minecraft:crafting_shapeless",
  "ingredients": [
    { "item": "minecraft:coal" },
    { "item": "minecraft:coal" },
    { "item": "minecraft:coal" }
  ],
  "result": {
    "item": "minecraft:diamond",
    "count": 1
  }
}
"#
                .to_string(),
                description: Some("JSON shapeless crafting recipe".to_string()),
            },
            FileTemplate {
                id: "recipe_smelting".to_string(),
                name: "Smelting Recipe".to_string(),
                extension: "json".to_string(),
                default_name: "smelting_recipe".to_string(),
                content: r#"{
  "type": "minecraft:smelting",
  "ingredient": {
    "item": "minecraft:raw_iron"
  },
  "result": "minecraft:iron_ingot",
  "experience": 0.7,
  "cookingtime": 200
}
"#
                .to_string(),
                description: Some("JSON smelting recipe".to_string()),
            },
        ]
    }

    /// Detect config files
    async fn detect_configs(&self) -> DetectedProject {
        let config_dir = self.instance_path.join("config");

        let mut categories = vec![
            ProjectCategory {
                id: "toml".to_string(),
                name: "TOML Configs".to_string(),
                path: ".".to_string(),
                file_patterns: vec!["*.toml".to_string()],
                description: Some("Forge/NeoForge mod configs".to_string()),
                icon: Some("config".to_string()),
                templates: vec![],
            },
            ProjectCategory {
                id: "json".to_string(),
                name: "JSON Configs".to_string(),
                path: ".".to_string(),
                file_patterns: vec!["*.json".to_string(), "*.json5".to_string()],
                description: Some("Fabric mod configs".to_string()),
                icon: Some("json".to_string()),
                templates: vec![],
            },
        ];

        // Check for common config subdirectories
        if let Ok(mut entries) = tokio::fs::read_dir(&config_dir).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                if entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false) {
                    let name = entry.file_name().to_string_lossy().to_string();
                    // Skip hidden directories
                    if !name.starts_with('.') {
                        categories.push(ProjectCategory {
                            id: name.clone(),
                            name: name.clone(),
                            path: name,
                            file_patterns: vec!["*.*".to_string()],
                            description: None,
                            icon: Some("folder".to_string()),
                            templates: vec![],
                        });
                    }
                }
            }
        }

        DetectedProject {
            project_type: ProjectType::Configs,
            root_path: "config".to_string(),
            name: "Configs".to_string(),
            version: None,
            categories,
            supports_hot_reload: false,
            watch_patterns: vec!["config/**/*".to_string()],
        }
    }

    /// Detect resource packs
    async fn detect_resourcepacks(&self) -> Result<Option<DetectedProject>> {
        let rp_dir = self.instance_path.join("resourcepacks");

        if !tokio::fs::try_exists(&rp_dir).await.unwrap_or(false) {
            return Ok(None);
        }

        Ok(Some(DetectedProject {
            project_type: ProjectType::ResourcePack,
            root_path: "resourcepacks".to_string(),
            name: "Resource Packs".to_string(),
            version: None,
            categories: vec![
                ProjectCategory {
                    id: "textures".to_string(),
                    name: "Textures".to_string(),
                    path: "*/assets/*/textures".to_string(),
                    file_patterns: vec!["*.png".to_string()],
                    description: Some("Block and item textures".to_string()),
                    icon: Some("image".to_string()),
                    templates: vec![],
                },
                ProjectCategory {
                    id: "models".to_string(),
                    name: "Models".to_string(),
                    path: "*/assets/*/models".to_string(),
                    file_patterns: vec!["*.json".to_string()],
                    description: Some("Block and item models".to_string()),
                    icon: Some("cube".to_string()),
                    templates: vec![],
                },
                ProjectCategory {
                    id: "lang".to_string(),
                    name: "Languages".to_string(),
                    path: "*/assets/*/lang".to_string(),
                    file_patterns: vec!["*.json".to_string()],
                    description: Some("Translation files".to_string()),
                    icon: Some("translate".to_string()),
                    templates: vec![],
                },
            ],
            supports_hot_reload: true,
            watch_patterns: vec!["resourcepacks/**/*".to_string()],
        }))
    }

    /// Detect mod version from jar files
    async fn detect_mod_version(&self, mod_id: &str) -> Option<String> {
        let mods_dir = self.instance_path.join("mods");

        if !tokio::fs::try_exists(&mods_dir).await.unwrap_or(false) {
            return None;
        }

        // Search for mod jar file
        if let Ok(mut entries) = tokio::fs::read_dir(&mods_dir).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                let path = entry.path();
                if path.extension().map(|e| e == "jar").unwrap_or(false) {
                    let filename = path.file_name()?.to_string_lossy().to_lowercase();

                    // Check if filename contains mod_id (case insensitive, already lowercase)
                    if filename.contains(mod_id) {
                        // Try to extract version from filename
                        if let Some(version) =
                            Self::extract_version_from_filename(&filename, mod_id)
                        {
                            return Some(version);
                        }
                    }
                }
            }
        }

        None
    }

    /// Extract version from filename
    /// Handles various formats:
    /// - kubejs-forge-2001.6.5-build.7.jar (Forge format: 2001.X.Y where X is major)
    /// - kubejs-6.1.0.jar (standard semver)
    /// - kubejs-fabric-1.20.1-6.1.0.jar (with MC version prefix)
    fn extract_version_from_filename(filename: &str, mod_id: &str) -> Option<String> {
        // Remove .jar extension
        let name = filename.trim_end_matches(".jar");

        // Try to find version pattern after mod_id
        let after_mod = name.split(mod_id).last()?;

        // Find all version-like patterns (X.Y.Z or X.Y)
        let version_regex = regex::Regex::new(r"(\d+)\.(\d+)(?:\.(\d+))?").ok()?;

        let mut best_version: Option<String> = None;

        for caps in version_regex.captures_iter(after_mod) {
            let full_match = caps.get(0)?.as_str();
            let first_part: u32 = caps.get(1)?.as_str().parse().ok()?;
            let second_part: u32 = caps.get(2)?.as_str().parse().ok()?;

            // Skip Minecraft version patterns (1.16, 1.17, 1.18, 1.19, 1.20, 1.21)
            if first_part == 1 && (16..=25).contains(&second_part) {
                continue;
            }

            // Forge format: 2001.6.5 where 2001 is a marker and 6 is the major version
            if first_part >= 2000 && first_part <= 2100 && second_part <= 10 {
                // This is Forge format, second part is the actual major version
                return Some(format!("{}.x", second_part));
            }

            // Standard semver format
            best_version = Some(full_match.to_string());
        }

        best_version
    }

    /// Get instance info (version, loader)
    async fn get_instance_info(&self) -> (String, String) {
        // Try to read from instance.json or database
        // For now, return defaults
        ("1.20.1".to_string(), "forge".to_string())
    }
}

// Tauri commands

/// Get detected projects for an instance
#[tauri::command]
pub async fn get_instance_projects(instance_id: String) -> Result<InstanceProjectContext> {
    let detector = ProjectDetector::new(&instance_id);
    detector.detect().await
}

/// Get templates for a specific project type
#[tauri::command]
pub async fn get_project_templates(
    instance_id: String,
    project_type: String,
    category_id: String,
) -> Result<Vec<FileTemplate>> {
    let detector = ProjectDetector::new(&instance_id);
    let context = detector.detect().await?;

    let project_type_enum = match project_type.as_str() {
        "kubejs" => ProjectType::KubeJS,
        "crafttweaker" => ProjectType::CraftTweaker,
        "datapack" => ProjectType::Datapack,
        "configs" => ProjectType::Configs,
        "resourcepack" => ProjectType::ResourcePack,
        _ => return Err("Unknown project type".to_string()),
    };

    for project in context.projects {
        if project.project_type == project_type_enum {
            for category in project.categories {
                if category.id == category_id {
                    return Ok(category.templates);
                }
            }
        }
    }

    Ok(vec![])
}

/// Create a file from template
#[tauri::command]
pub async fn create_file_from_template(
    instance_id: String,
    template_id: String,
    project_type: String,
    category_id: String,
    filename: String,
) -> Result<String> {
    let detector = ProjectDetector::new(&instance_id);
    let context = detector.detect().await?;

    let project_type_enum = match project_type.as_str() {
        "kubejs" => ProjectType::KubeJS,
        "crafttweaker" => ProjectType::CraftTweaker,
        "datapack" => ProjectType::Datapack,
        _ => return Err("Unknown project type".to_string()),
    };

    // Find the template
    for project in &context.projects {
        if project.project_type == project_type_enum {
            for category in &project.categories {
                if category.id == category_id {
                    for template in &category.templates {
                        if template.id == template_id {
                            // Build file path
                            let file_path = instance_dir(&instance_id)
                                .join(&project.root_path)
                                .join(&category.path)
                                .join(format!("{}.{}", filename, template.extension));

                            // Create parent directories
                            if let Some(parent) = file_path.parent() {
                                tokio::fs::create_dir_all(parent)
                                    .await
                                    .map_err(|e| e.to_string())?;
                            }

                            // Write file
                            tokio::fs::write(&file_path, &template.content)
                                .await
                                .map_err(|e| e.to_string())?;

                            // Return relative path
                            let relative = file_path
                                .strip_prefix(instance_dir(&instance_id))
                                .map(|p| p.to_string_lossy().to_string())
                                .unwrap_or_default();

                            return Ok(relative);
                        }
                    }
                }
            }
        }
    }

    Err("Template not found".to_string())
}
