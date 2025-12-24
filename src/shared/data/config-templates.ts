/**
 * Config templates and autocomplete data for popular mods
 * Provides quick configs, defaults, and autocomplete suggestions
 */

export interface ConfigTemplate {
  modId: string;
  modName: string;
  fileName: string;
  description: string;
  presets: ConfigPreset[];
  autocomplete: string[];
  defaultContent?: string;
}

export interface ConfigPreset {
  name: string;
  description: string;
  content: string;
  icon?: string;
}

/**
 * Popular mod configurations with templates
 */
export const CONFIG_TEMPLATES: Record<string, ConfigTemplate> = {
  // JEI (Just Enough Items)
  jei: {
    modId: "jei",
    modName: "Just Enough Items",
    fileName: "jei-client.toml",
    description: "Recipe viewer and item list",
    autocomplete: [
      "CheatMode",
      "EditMode",
      "SearchMode",
      "MaxColumns",
      "MaxRecipeGuiHeight",
      "RecipeCatalystEnabled",
      "AdvancedTooltips",
      "ColorSearchEnabled",
    ],
    presets: [
      {
        name: "Cheat Mode (Creative)",
        description: "Включить режим чита для получения предметов",
        icon: "i-hugeicons-magic-wand-01",
        content: `[AdvancedTooltips]
\tEnabled = true

[CheatMode]
\tEnabled = true
\tCheatItemsEnabled = true

[SearchMode]
\tModNameSearchMode = "REQUIRE_PREFIX"
\tTooltipSearchMode = "ENABLED"
\tTagSearchMode = "ENABLED"
\tColorSearchMode = "DISABLED"`,
      },
      {
        name: "Recipe Mode (Default)",
        description: "Стандартный режим просмотра рецептов",
        icon: "i-hugeicons-book-02",
        content: `[AdvancedTooltips]
\tEnabled = false

[CheatMode]
\tEnabled = false
\tCheatItemsEnabled = false

[SearchMode]
\tModNameSearchMode = "REQUIRE_PREFIX"
\tTooltipSearchMode = "ENABLED"
\tTagSearchMode = "ENABLED"
\tColorSearchMode = "DISABLED"`,
      },
    ],
  },

  // Sodium
  sodium: {
    modId: "sodium",
    modName: "Sodium",
    fileName: "sodium-options.json",
    description: "Rendering optimization mod",
    autocomplete: [
      "enable_fog",
      "enable_distortion_effects",
      "max_fps",
      "use_chunk_face_culling",
      "use_fog_occlusion",
      "use_entity_culling",
      "animate_only_visible_textures",
    ],
    presets: [
      {
        name: "Maximum Performance",
        description: "Максимальная производительность, минимальная красота",
        icon: "i-hugeicons-rocket-02",
        content: `{
  "quality": {
    "weather_quality": "FAST",
    "leaves_quality": "FAST",
    "enable_vignette": false,
    "enable_fog": false,
    "enable_distortion_effects": false
  },
  "performance": {
    "chunk_builder_threads": 0,
    "use_chunk_face_culling": true,
    "use_fog_occlusion": true,
    "use_entity_culling": true,
    "animate_only_visible_textures": true
  },
  "advanced": {
    "max_fps": 260,
    "cpu_render_ahead_limit": 3
  }
}`,
      },
      {
        name: "Balanced",
        description: "Баланс между качеством и производительностью",
        icon: "i-hugeicons-scale-01",
        content: `{
  "quality": {
    "weather_quality": "DEFAULT",
    "leaves_quality": "FANCY",
    "enable_vignette": true,
    "enable_fog": true,
    "enable_distortion_effects": true
  },
  "performance": {
    "chunk_builder_threads": 0,
    "use_chunk_face_culling": true,
    "use_fog_occlusion": true,
    "use_entity_culling": true,
    "animate_only_visible_textures": false
  },
  "advanced": {
    "max_fps": 144,
    "cpu_render_ahead_limit": 3
  }
}`,
      },
    ],
  },

  // Iris Shaders
  iris: {
    modId: "iris",
    modName: "Iris Shaders",
    fileName: "iris.properties",
    description: "Shader mod for Fabric/Quilt",
    autocomplete: [
      "maxShadowRenderDistance",
      "shadowDistance",
      "enableShaders",
      "shaderPack",
    ],
    presets: [
      {
        name: "Shaders Enabled",
        description: "Включить шейдеры с оптимальными настройками",
        icon: "i-hugeicons-sun-cloud-02",
        content: `enableShaders=true
maxShadowRenderDistance=12
shadowDistance=32.0
disableUpdateMessage=false`,
      },
      {
        name: "Shaders Disabled",
        description: "Отключить шейдеры для производительности",
        icon: "i-hugeicons-cancel-circle",
        content: `enableShaders=false
maxShadowRenderDistance=0
shadowDistance=0.0
disableUpdateMessage=true`,
      },
    ],
  },

  // OptiFine (для Forge)
  optifine: {
    modId: "optifine",
    modName: "OptiFine",
    fileName: "optionsof.txt",
    description: "Graphics and performance optimization",
    autocomplete: [
      "ofFogType",
      "ofFogStart",
      "ofMipmapType",
      "ofOcclusionFancy",
      "ofSmoothFps",
      "ofSmoothWorld",
      "ofLazyChunkLoading",
      "ofRenderRegions",
      "ofSmartAnimations",
    ],
    presets: [
      {
        name: "Ultra Performance",
        description: "Максимальная производительность",
        icon: "i-hugeicons-rocket-02",
        content: `ofFogType:3
ofFogStart:0.8
ofMipmapType:0
ofOcclusionFancy:false
ofSmoothFps:true
ofSmoothWorld:true
ofLazyChunkLoading:true
ofRenderRegions:true
ofSmartAnimations:true
ofSmoothBiomes:false
ofCustomFonts:false
ofCustomColors:false
ofCustomSky:false
ofShowCapes:false
ofNaturalTextures:false
ofEmissiveTextures:false
ofRandomEntities:false
ofBetterGrass:1
ofConnectedTextures:2
ofWeather:false
ofSky:false
ofStars:false
ofSunMoon:false
ofVignette:false
ofChunkUpdates:1
ofChunkUpdatesDynamic:false
ofTime:0
ofAaLevel:0
ofAfLevel:1`,
      },
    ],
  },

  // Create
  create: {
    modId: "create",
    modName: "Create",
    fileName: "create-common.toml",
    description: "Contraptions and automation mod",
    autocomplete: [
      "maxBeltLength",
      "maxChainDriveLength",
      "stressValues",
      "kinetics",
      "fanBlockCheckRate",
      "crankHungerMultiplier",
    ],
    presets: [
      {
        name: "Performance Optimized",
        description: "Оптимизация для серверов",
        icon: "i-hugeicons-settings-02",
        content: `[kinetics]
\tmaxBeltLength = 16
\tmaxChainDriveLength = 16
\tfanBlockCheckRate = 50
\tcrankHungerMultiplier = 0.005

[contraptions]
\tmaxBlocksMoved = 2048
\tmaxChassisRange = 16
\tmaxPistonPoles = 64`,
      },
    ],
  },

  // Minecraft server.properties
  "server.properties": {
    modId: "minecraft",
    modName: "Minecraft Server",
    fileName: "server.properties",
    description: "Server configuration",
    autocomplete: [
      "difficulty",
      "gamemode",
      "max-players",
      "view-distance",
      "simulation-distance",
      "spawn-protection",
      "pvp",
      "enable-command-block",
      "motd",
      "server-port",
      "level-seed",
      "level-type",
      "spawn-monsters",
      "spawn-animals",
      "spawn-npcs",
      "allow-nether",
      "allow-flight",
      "white-list",
      "online-mode",
    ],
    presets: [
      {
        name: "Vanilla Survival",
        description: "Стандартный выживание сервер",
        icon: "i-hugeicons-sword-03",
        content: `difficulty=normal
gamemode=survival
max-players=20
view-distance=10
simulation-distance=10
spawn-protection=16
pvp=true
enable-command-block=false
allow-flight=false
spawn-monsters=true
spawn-animals=true
spawn-npcs=true
allow-nether=true
white-list=false
online-mode=true`,
      },
      {
        name: "Creative Server",
        description: "Креативный режим для строительства",
        icon: "i-hugeicons-paint-board",
        content: `difficulty=peaceful
gamemode=creative
max-players=20
view-distance=12
simulation-distance=8
spawn-protection=0
pvp=false
enable-command-block=true
allow-flight=true
spawn-monsters=false
spawn-animals=false
spawn-npcs=false
allow-nether=true
white-list=false
online-mode=true`,
      },
      {
        name: "Performance Server",
        description: "Оптимизация для производительности",
        icon: "i-hugeicons-rocket-02",
        content: `difficulty=normal
gamemode=survival
max-players=50
view-distance=6
simulation-distance=4
spawn-protection=16
pvp=true
enable-command-block=false
allow-flight=false
spawn-monsters=true
spawn-animals=true
spawn-npcs=true
allow-nether=true
white-list=false
online-mode=true
max-tick-time=60000
rate-limit=0`,
      },
    ],
  },

  // Litematica
  litematica: {
    modId: "litematica",
    modName: "Litematica",
    fileName: "litematica.json",
    description: "Schematic mod for creative building",
    autocomplete: [
      "executeRequiresTool",
      "pastingIgnoreEntities",
      "renderSchematicVboDisabled",
      "schematicBlockRenderLimit",
    ],
    presets: [
      {
        name: "Builder Mode",
        description: "Оптимизировано для строительства",
        icon: "i-hugeicons-paint-board",
        content: `{
  "Generic": {
    "executeRequiresTool": false,
    "pastingIgnoreEntities": false,
    "pickBlockEnabled": true,
    "renderSchematicVboDisabled": false,
    "schematicBlockRenderLimit": 100000
  }
}`,
      },
    ],
  },

  // Applied Energistics 2
  ae2: {
    modId: "ae2",
    modName: "Applied Energistics 2",
    fileName: "ae2-common.toml",
    description: "Storage and automation mod",
    autocomplete: [
      "channels",
      "wirelessBaseCost",
      "wirelessBoosterRatioExp",
      "powerMultiplier",
    ],
    presets: [
      {
        name: "No Channels",
        description: "Отключить систему каналов (проще)",
        icon: "i-hugeicons-settings-02",
        content: `[general]
\tchannels = "INFINITE"
\twirelessBaseCost = 8.0
\twirelessBoosterRatioExp = 1.5
\tpowerMultiplier = 1.0`,
      },
      {
        name: "Default Channels",
        description: "Стандартная система каналов",
        icon: "i-hugeicons-layers-01",
        content: `[general]
\tchannels = "DEFAULT"
\twirelessBaseCost = 8.0
\twirelessBoosterRatioExp = 1.5
\tpowerMultiplier = 1.0`,
      },
    ],
  },

  // Mekanism
  mekanism: {
    modId: "mekanism",
    modName: "Mekanism",
    fileName: "mekanism-common.toml",
    description: "Tech mod with machines",
    autocomplete: [
      "energyPerHeat",
      "machinesUseFuel",
      "maxUpgradeMultiplier",
      "pumpHeavyWaterAmount",
    ],
    presets: [
      {
        name: "Easy Mode",
        description: "Упрощённые рецепты и больше энергии",
        icon: "i-hugeicons-rocket-02",
        content: `[general]
\tenergyPerHeat = 1000.0
\tmachinesUseFuel = true
\tmaxUpgradeMultiplier = 16
\tvoiceServerEnabled = false

[usage]
\tdigitalMiner = 10000.0
\telectricPump = 100.0`,
      },
    ],
  },

  // Botania
  botania: {
    modId: "botania",
    modName: "Botania",
    fileName: "botania-common.toml",
    description: "Nature magic mod",
    autocomplete: [
      "manaMultiplier",
      "flowerPatchCount",
      "relicRarity",
      "harderRecipes",
    ],
    presets: [
      {
        name: "More Mana",
        description: "Увеличенная генерация маны",
        icon: "i-hugeicons-magic-wand-01",
        content: `[balance]
\tmanaMultiplier = 2.0
\tflowerPatchCount = 2
\trelicRarity = 0.1
\tharderRecipes = false`,
      },
    ],
  },

  // Farmer's Delight
  farmersdelight: {
    modId: "farmersdelight",
    modName: "Farmer's Delight",
    fileName: "farmersdelight-common.toml",
    description: "Farming and cooking mod",
    autocomplete: [
      "enableVanillaCropCrates",
      "farmersBuyFDCrops",
      "richSoilBoost",
    ],
    presets: [
      {
        name: "Boosted Farming",
        description: "Усиленное фермерство",
        icon: "i-hugeicons-plant-01",
        content: `[common]
\tenableVanillaCropCrates = true
\tfarmersBuyFDCrops = true
\trichSoilBoost = 2.0`,
      },
    ],
  },

  // Quark
  quark: {
    modId: "quark",
    modName: "Quark",
    fileName: "quark-common.toml",
    description: "Vanilla+ features mod",
    autocomplete: [
      "enableVariantAnimals",
      "enableBigDungeons",
      "enableCaveRoots",
    ],
    presets: [
      {
        name: "All Features",
        description: "Включить все фичи Quark",
        icon: "i-hugeicons-star",
        content: `[general]
\tenableVariantAnimals = true
\tenableBigDungeons = true
\tenableCaveRoots = true
\tenableAutomaticRecipeUnlock = true`,
      },
    ],
  },

  // REI (Roughly Enough Items)
  rei: {
    modId: "rei",
    modName: "Roughly Enough Items",
    fileName: "rei.json",
    description: "Recipe viewer alternative to JEI",
    autocomplete: [
      "cheating",
      "favoritesEnabled",
      "loadDefaultFavorites",
      "searchFieldLocation",
    ],
    presets: [
      {
        name: "Cheat Mode",
        description: "Включить режим чита",
        icon: "i-hugeicons-magic-wand-01",
        content: `{
  "basics": {
    "cheating": true,
    "favoritesEnabled": true,
    "loadDefaultFavorites": true,
    "searchFieldLocation": "BOTTOM_SIDE"
  }
}`,
      },
    ],
  },

  // Biomes O' Plenty
  biomesoplenty: {
    modId: "biomesoplenty",
    modName: "Biomes O' Plenty",
    fileName: "biomesoplenty-common.toml",
    description: "Adds many new biomes",
    autocomplete: [
      "enhancedVanillaBiomes",
      "useSereneSeasons",
      "generateBopOres",
    ],
    presets: [
      {
        name: "Full Biomes",
        description: "Максимум биомов",
        icon: "i-hugeicons-tree-01",
        content: `[worldgen]
\tenhancedVanillaBiomes = true
\tuseSereneSeasons = true
\tgenerateBopOres = true`,
      },
    ],
  },
};

/**
 * Get template by mod ID or filename
 */
export function getConfigTemplate(modIdOrFilename: string): ConfigTemplate | undefined {
  // Direct match by mod ID
  if (CONFIG_TEMPLATES[modIdOrFilename]) {
    return CONFIG_TEMPLATES[modIdOrFilename];
  }

  // Match by filename
  return Object.values(CONFIG_TEMPLATES).find(
    (template) => template.fileName === modIdOrFilename
  );
}

/**
 * Get autocomplete suggestions for a file
 */
export function getAutocompleteForFile(filename: string): string[] {
  const template = getConfigTemplate(filename);
  return template?.autocomplete || [];
}

/**
 * Get all available templates
 */
export function getAllTemplates(): ConfigTemplate[] {
  return Object.values(CONFIG_TEMPLATES);
}

/**
 * Get preset templates for a specific file
 */
export function getPresetsForFile(filename: string): Array<{name: string; description: string; content: string}> {
  const template = getConfigTemplate(filename);
  return template?.presets || [];
}
