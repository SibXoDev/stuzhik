use super::types::{
    ClassificationReason, ClassifiedFile, KnownSetting, SettingCategory, SkipReason, SyncProfile,
};
use glob::Pattern;
use std::collections::HashMap;

/// База знаний о известных настройках
pub struct SettingsKnowledgeBase {
    /// Известные файлы и их категории
    known_files: Vec<KnownSetting>,

    /// Известные ключи в options.txt
    options_txt_personal_keys: Vec<&'static str>,

    /// Паттерны для performance настроек
    performance_patterns: Vec<Pattern>,

    /// Паттерны для personal настроек
    personal_patterns: Vec<Pattern>,
}

impl Default for SettingsKnowledgeBase {
    fn default() -> Self {
        Self::new()
    }
}

impl SettingsKnowledgeBase {
    pub fn new() -> Self {
        Self {
            known_files: Self::build_known_files(),
            options_txt_personal_keys: Self::build_options_txt_personal_keys(),
            performance_patterns: Self::build_performance_patterns(),
            personal_patterns: Self::build_personal_patterns(),
        }
    }

    /// Классифицирует файл по пути
    pub fn classify_file(&self, relative_path: &str, file_size: u64) -> ClassifiedFile {
        let path_lower = relative_path.to_lowercase();

        // 1. Проверяем известные файлы
        for known in &self.known_files {
            if let Ok(pattern) = Pattern::new(&known.file_pattern.to_lowercase()) {
                if pattern.matches(&path_lower) {
                    return ClassifiedFile {
                        path: relative_path.to_string(),
                        category: known.category,
                        size: file_size,
                        reason: ClassificationReason::KnownFile {
                            matched_pattern: known.file_pattern.clone(),
                        },
                        will_sync: known.category.sync_by_default(),
                        details: Some(known.description.clone()),
                    };
                }
            }
        }

        // 2. Проверяем personal паттерны
        for pattern in &self.personal_patterns {
            if pattern.matches(&path_lower) {
                return ClassifiedFile {
                    path: relative_path.to_string(),
                    category: SettingCategory::Personal,
                    size: file_size,
                    reason: ClassificationReason::FileNameHeuristic,
                    will_sync: false,
                    details: Some("Личные настройки (управление, звук, графика)".to_string()),
                };
            }
        }

        // 3. Проверяем performance паттерны
        for pattern in &self.performance_patterns {
            if pattern.matches(&path_lower) {
                return ClassifiedFile {
                    path: relative_path.to_string(),
                    category: SettingCategory::Performance,
                    size: file_size,
                    reason: ClassificationReason::FileNameHeuristic,
                    will_sync: false,
                    details: Some("Настройки производительности".to_string()),
                };
            }
        }

        // 4. Эвристика по директории
        if path_lower.starts_with("config/") {
            // Большинство config/ файлов - это mod configs
            return ClassifiedFile {
                path: relative_path.to_string(),
                category: SettingCategory::ModConfig,
                size: file_size,
                reason: ClassificationReason::DirectoryDefault,
                will_sync: true,
                details: Some("Конфиг мода".to_string()),
            };
        }

        if path_lower.starts_with("journeymap/")
            || path_lower.starts_with("xaerominimap/")
            || path_lower.starts_with("xaeroworldmap/")
        {
            return ClassifiedFile {
                path: relative_path.to_string(),
                category: SettingCategory::Gameplay,
                size: file_size,
                reason: ClassificationReason::DirectoryDefault,
                will_sync: false,
                details: Some("Данные карты (waypoints, markers)".to_string()),
            };
        }

        // По умолчанию - неизвестная категория
        ClassifiedFile {
            path: relative_path.to_string(),
            category: SettingCategory::Unknown,
            size: file_size,
            reason: ClassificationReason::DirectoryDefault,
            will_sync: false,
            details: None,
        }
    }

    /// Проверяет, должен ли файл быть синхронизирован с данным профилем
    pub fn should_sync(
        &self,
        file: &ClassifiedFile,
        profile: &SyncProfile,
    ) -> Result<(), SkipReason> {
        // Personal настройки НИКОГДА не синхронизируются
        if file.category == SettingCategory::Personal {
            return Err(SkipReason::PersonalSetting);
        }

        // Проверяем явные исключения в профиле
        for excluded in &profile.excluded_files {
            if let Ok(pattern) = Pattern::new(&excluded.to_lowercase()) {
                if pattern.matches(&file.path.to_lowercase()) {
                    return Err(SkipReason::ExplicitlyExcluded);
                }
            }
        }

        // Проверяем явные включения (override)
        for included in &profile.included_files {
            if let Ok(pattern) = Pattern::new(&included.to_lowercase()) {
                if pattern.matches(&file.path.to_lowercase()) {
                    return Ok(()); // Явно включён - синхронизируем
                }
            }
        }

        // Проверяем категорию
        if profile.enabled_categories.contains(&file.category) {
            Ok(())
        } else {
            Err(SkipReason::CategoryDisabled {
                category: file.category,
            })
        }
    }

    /// Возвращает все известные настройки для UI
    pub fn get_all_known_settings(&self) -> &[KnownSetting] {
        &self.known_files
    }

    /// Проверяет, является ли ключ в options.txt личной настройкой
    pub fn is_personal_options_key(&self, key: &str) -> bool {
        self.options_txt_personal_keys
            .iter()
            .any(|&k| key.starts_with(k))
    }

    // =========================================================================
    // Построение базы знаний
    // =========================================================================

    fn build_known_files() -> Vec<KnownSetting> {
        vec![
            // =====================================================================
            // PERSONAL - Никогда не синхронизировать
            // =====================================================================

            // Базовые настройки Minecraft
            KnownSetting {
                file_pattern: "options.txt".to_string(),
                keys: None, // Обрабатывается отдельно по ключам
                category: SettingCategory::Personal,
                description: "Базовые настройки Minecraft (FOV, звук, управление)".to_string(),
                mod_id: None,
            },
            KnownSetting {
                file_pattern: "optionsof.txt".to_string(),
                keys: None,
                category: SettingCategory::Personal,
                description: "Настройки OptiFine (графика, производительность)".to_string(),
                mod_id: Some("optifine".to_string()),
            },
            KnownSetting {
                file_pattern: "optionsshaders.txt".to_string(),
                keys: None,
                category: SettingCategory::Personal,
                description: "Настройки шейдеров".to_string(),
                mod_id: None,
            },
            KnownSetting {
                file_pattern: "servers.dat".to_string(),
                keys: None,
                category: SettingCategory::Personal,
                description: "Список серверов (личный)".to_string(),
                mod_id: None,
            },
            KnownSetting {
                file_pattern: "hotbar.nbt".to_string(),
                keys: None,
                category: SettingCategory::Personal,
                description: "Сохранённые хотбары (личные)".to_string(),
                mod_id: None,
            },
            KnownSetting {
                file_pattern: "realms_persistence.json".to_string(),
                keys: None,
                category: SettingCategory::Personal,
                description: "Данные Realms (личные)".to_string(),
                mod_id: None,
            },
            // =====================================================================
            // PERFORMANCE - Настройки графики/производительности (зависят от железа)
            // =====================================================================

            // Sodium и альтернативы
            KnownSetting {
                file_pattern: "config/sodium-options.json".to_string(),
                keys: None,
                category: SettingCategory::Performance,
                description: "Настройки Sodium (графика, зависит от GPU)".to_string(),
                mod_id: Some("sodium".to_string()),
            },
            KnownSetting {
                file_pattern: "config/sodium-mixins.properties".to_string(),
                keys: None,
                category: SettingCategory::Performance,
                description: "Sodium mixins (оптимизации)".to_string(),
                mod_id: Some("sodium".to_string()),
            },
            KnownSetting {
                file_pattern: "config/rubidium-options.json".to_string(),
                keys: None,
                category: SettingCategory::Performance,
                description: "Настройки Rubidium (графика)".to_string(),
                mod_id: Some("rubidium".to_string()),
            },
            KnownSetting {
                file_pattern: "config/embeddium-options.json".to_string(),
                keys: None,
                category: SettingCategory::Performance,
                description: "Настройки Embeddium (графика)".to_string(),
                mod_id: Some("embeddium".to_string()),
            },
            // Iris и шейдеры
            KnownSetting {
                file_pattern: "config/iris.properties".to_string(),
                keys: None,
                category: SettingCategory::Performance,
                description: "Настройки Iris (шейдеры)".to_string(),
                mod_id: Some("iris".to_string()),
            },
            KnownSetting {
                file_pattern: "config/oculus.properties".to_string(),
                keys: None,
                category: SettingCategory::Performance,
                description: "Настройки Oculus (шейдеры для Forge)".to_string(),
                mod_id: Some("oculus".to_string()),
            },
            KnownSetting {
                file_pattern: "shaderpacks/*.txt".to_string(),
                keys: None,
                category: SettingCategory::Performance,
                description: "Настройки шейдерпаков".to_string(),
                mod_id: None,
            },
            // Другие performance моды
            KnownSetting {
                file_pattern: "config/entityculling.json".to_string(),
                keys: None,
                category: SettingCategory::Performance,
                description: "Entity Culling (производительность)".to_string(),
                mod_id: Some("entityculling".to_string()),
            },
            KnownSetting {
                file_pattern: "config/ferritecore*.toml".to_string(),
                keys: None,
                category: SettingCategory::Performance,
                description: "FerriteCore (память)".to_string(),
                mod_id: Some("ferritecore".to_string()),
            },
            KnownSetting {
                file_pattern: "config/modernfix*.toml".to_string(),
                keys: None,
                category: SettingCategory::Performance,
                description: "ModernFix (производительность)".to_string(),
                mod_id: Some("modernfix".to_string()),
            },
            KnownSetting {
                file_pattern: "config/lithium*.properties".to_string(),
                keys: None,
                category: SettingCategory::Performance,
                description: "Lithium (производительность)".to_string(),
                mod_id: Some("lithium".to_string()),
            },
            // =====================================================================
            // GAMEPLAY - Игровые данные (waypoints, bookmarks)
            // =====================================================================

            // JEI/REI/EMI bookmarks
            KnownSetting {
                file_pattern: "config/jei/bookmarks/*.ini".to_string(),
                keys: None,
                category: SettingCategory::Gameplay,
                description: "JEI закладки рецептов".to_string(),
                mod_id: Some("jei".to_string()),
            },
            KnownSetting {
                file_pattern: "config/roughlyenoughitems/favorites.json".to_string(),
                keys: None,
                category: SettingCategory::Gameplay,
                description: "REI избранные рецепты".to_string(),
                mod_id: Some("rei".to_string()),
            },
            KnownSetting {
                file_pattern: "config/emi/favorites.json".to_string(),
                keys: None,
                category: SettingCategory::Gameplay,
                description: "EMI избранные рецепты".to_string(),
                mod_id: Some("emi".to_string()),
            },
            // Карты и waypoints
            KnownSetting {
                file_pattern: "journeymap/waypoints/*.json".to_string(),
                keys: None,
                category: SettingCategory::Gameplay,
                description: "JourneyMap waypoints".to_string(),
                mod_id: Some("journeymap".to_string()),
            },
            KnownSetting {
                file_pattern: "XaeroWaypoints/**".to_string(),
                keys: None,
                category: SettingCategory::Gameplay,
                description: "Xaero's Waypoints".to_string(),
                mod_id: Some("xaerominimap".to_string()),
            },
            KnownSetting {
                file_pattern: "XaeroWorldMap/**".to_string(),
                keys: None,
                category: SettingCategory::Gameplay,
                description: "Xaero's World Map data".to_string(),
                mod_id: Some("xaeroworldmap".to_string()),
            },
            // =====================================================================
            // VISUAL - Ресурспаки и визуальные моды
            // =====================================================================
            KnownSetting {
                file_pattern: "options.txt:resourcePacks".to_string(), // Специальный синтаксис
                keys: Some(vec!["resourcePacks".to_string()]),
                category: SettingCategory::Visual,
                description: "Список активных ресурспаков".to_string(),
                mod_id: None,
            },
            // =====================================================================
            // MOD CONFIG - Конфиги модов (геймплей, баланс)
            // =====================================================================

            // По умолчанию все config/*.toml и config/*.json - mod configs
            // Но есть исключения (уже добавлены выше как Performance/Personal)

            // Примеры явных mod configs
            KnownSetting {
                file_pattern: "config/create*.toml".to_string(),
                keys: None,
                category: SettingCategory::ModConfig,
                description: "Create mod настройки".to_string(),
                mod_id: Some("create".to_string()),
            },
            KnownSetting {
                file_pattern: "config/botania*.toml".to_string(),
                keys: None,
                category: SettingCategory::ModConfig,
                description: "Botania настройки".to_string(),
                mod_id: Some("botania".to_string()),
            },
            KnownSetting {
                file_pattern: "config/mekanism*.toml".to_string(),
                keys: None,
                category: SettingCategory::ModConfig,
                description: "Mekanism настройки".to_string(),
                mod_id: Some("mekanism".to_string()),
            },
            KnownSetting {
                file_pattern: "config/thermal*.toml".to_string(),
                keys: None,
                category: SettingCategory::ModConfig,
                description: "Thermal настройки".to_string(),
                mod_id: Some("thermal".to_string()),
            },
            KnownSetting {
                file_pattern: "config/appliedenergistics2/*.json".to_string(),
                keys: None,
                category: SettingCategory::ModConfig,
                description: "Applied Energistics 2 настройки".to_string(),
                mod_id: Some("ae2".to_string()),
            },
            KnownSetting {
                file_pattern: "kubejs/**/*.js".to_string(),
                keys: None,
                category: SettingCategory::ModConfig,
                description: "KubeJS скрипты (рецепты, баланс)".to_string(),
                mod_id: Some("kubejs".to_string()),
            },
            KnownSetting {
                file_pattern: "kubejs/**/*.json".to_string(),
                keys: None,
                category: SettingCategory::ModConfig,
                description: "KubeJS данные".to_string(),
                mod_id: Some("kubejs".to_string()),
            },
            KnownSetting {
                file_pattern: "defaultconfigs/**".to_string(),
                keys: None,
                category: SettingCategory::ModConfig,
                description: "Default configs (автоприменяемые)".to_string(),
                mod_id: None,
            },
        ]
    }

    /// Ключи в options.txt которые являются личными настройками
    fn build_options_txt_personal_keys() -> Vec<&'static str> {
        vec![
            // Графика
            "fov",
            "gamma",
            "renderDistance",
            "simulationDistance",
            "entityDistanceScaling",
            "guiScale",
            "particles",
            "maxFps",
            "graphicsMode",
            "ao",
            "prioritizeChunkUpdates",
            "biomeBlendRadius",
            "renderClouds",
            "fullscreen",
            "vsync",
            "mipmapLevels",
            "entityShadows",
            "screenEffectScale",
            "fovEffectScale",
            "darknessEffectScale",
            "glintSpeed",
            "glintStrength",
            // Звук
            "soundCategory_",
            "soundDevice",
            "directionalAudio",
            // Управление
            "key_",
            "invertYMouse",
            "mouseSensitivity",
            "mouseWheelSensitivity",
            "rawMouseInput",
            "autoJump",
            "operatorItemsTab",
            "toggleCrouch",
            "toggleSprint",
            // Доступность
            "narrator",
            "narratorHotkey",
            "showSubtitles",
            "backgroundForChatOnly",
            "textBackgroundOpacity",
            "highContrast",
            // Чат и UI
            "chatOpacity",
            "chatLineSpacing",
            "textBackgroundOpacity",
            "chatScale",
            "chatWidth",
            "chatHeightFocused",
            "chatHeightUnfocused",
            "chatDelay",
            "autoSuggestions",
            "reducedDebugInfo",
            "hideMatchedNames",
            "hideBundleTutorial",
            // Другие личные
            "tutorialStep",
            "joinedFirstServer",
            "hideLightningFlashes",
            "skipRealmsWarning",
            "onboardAccessibility",
        ]
    }

    fn build_performance_patterns() -> Vec<Pattern> {
        [
            // Графические моды
            "config/sodium*.json",
            "config/sodium*.properties",
            "config/rubidium*.json",
            "config/embeddium*.json",
            "config/iris*.properties",
            "config/oculus*.properties",
            "config/entityculling*.json",
            "config/ferritecore*.toml",
            "config/modernfix*.toml",
            "config/lithium*.properties",
            "config/starlight*.toml",
            "config/smoothboot*.json",
            "config/lazydfu*.toml",
            "config/dashloader/*.json",
            "config/enhancedblockentities*.json",
            "config/dynamicfps*.json",
            "config/ksyxis.json",
            // Клиентские настройки модов (обычно -client.toml)
            "config/*-client.toml",
            "config/*-client.json",
            "config/*/client.toml",
            "config/*/client.json",
            "config/*_client.toml",
            "config/*_client.json",
        ]
        .iter()
        .filter_map(|p| Pattern::new(p).ok())
        .collect()
    }

    fn build_personal_patterns() -> Vec<Pattern> {
        [
            "options.txt",
            "optionsof.txt",
            "optionsshaders.txt",
            "servers.dat",
            "hotbar.nbt",
            "realms_persistence.json",
            "usercache.json",
            "profilekeys/*",
            // Кеши и временные данные
            ".cache/*",
            "crash-reports/*",
            "logs/*",
            "screenshots/*",
        ]
        .iter()
        .filter_map(|p| Pattern::new(p).ok())
        .collect()
    }
}

/// Парсит options.txt и фильтрует личные настройки
pub fn filter_options_txt_for_sync(content: &str, kb: &SettingsKnowledgeBase) -> String {
    content
        .lines()
        .filter(|line| {
            if let Some((key, _)) = line.split_once(':') {
                !kb.is_personal_options_key(key.trim())
            } else {
                true // Сохраняем строки без ключей (комментарии и т.д.)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Мержит options.txt: берёт геймплейные настройки из source, сохраняет личные из target
pub fn merge_options_txt(
    source_content: &str,
    target_content: &str,
    kb: &SettingsKnowledgeBase,
) -> String {
    let mut source_map: HashMap<&str, &str> = HashMap::new();
    let mut target_map: HashMap<&str, &str> = HashMap::new();

    // Парсим оба файла
    for line in source_content.lines() {
        if let Some((key, value)) = line.split_once(':') {
            source_map.insert(key.trim(), value.trim());
        }
    }

    for line in target_content.lines() {
        if let Some((key, value)) = line.split_once(':') {
            target_map.insert(key.trim(), value.trim());
        }
    }

    // Мержим: личные из target, остальное из source
    let mut result = Vec::new();

    // Сначала добавляем все ключи из target (сохраняем порядок)
    for line in target_content.lines() {
        if let Some((key, _)) = line.split_once(':') {
            let key = key.trim();
            if kb.is_personal_options_key(key) {
                // Личная настройка - сохраняем из target
                result.push(line.to_string());
            } else if let Some(source_value) = source_map.get(key) {
                // Геймплейная настройка - берём из source
                result.push(format!("{}:{}", key, source_value));
            } else {
                // Нет в source - сохраняем из target
                result.push(line.to_string());
            }
        } else {
            result.push(line.to_string());
        }
    }

    // Добавляем новые ключи из source которых нет в target
    for line in source_content.lines() {
        if let Some((key, value)) = line.split_once(':') {
            let key = key.trim();
            if !kb.is_personal_options_key(key) && !target_map.contains_key(key) {
                result.push(format!("{}:{}", key, value.trim()));
            }
        }
    }

    result.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify_options_txt() {
        let kb = SettingsKnowledgeBase::new();
        let file = kb.classify_file("options.txt", 1024);
        assert_eq!(file.category, SettingCategory::Personal);
        assert!(!file.will_sync);
    }

    #[test]
    fn test_classify_mod_config() {
        let kb = SettingsKnowledgeBase::new();
        let file = kb.classify_file("config/create-common.toml", 2048);
        assert_eq!(file.category, SettingCategory::ModConfig);
        assert!(file.will_sync);
    }

    #[test]
    fn test_classify_sodium() {
        let kb = SettingsKnowledgeBase::new();
        let file = kb.classify_file("config/sodium-options.json", 512);
        assert_eq!(file.category, SettingCategory::Performance);
        assert!(!file.will_sync);
    }

    #[test]
    fn test_personal_keys() {
        let kb = SettingsKnowledgeBase::new();
        assert!(kb.is_personal_options_key("fov"));
        assert!(kb.is_personal_options_key("renderDistance"));
        assert!(kb.is_personal_options_key("soundCategory_master"));
        assert!(kb.is_personal_options_key("key_key.attack"));
        assert!(!kb.is_personal_options_key("difficulty"));
        assert!(!kb.is_personal_options_key("chatVisibility"));
    }

    #[test]
    fn test_filter_options_txt() {
        let kb = SettingsKnowledgeBase::new();
        let content = "fov:90.0\ndifficulty:2\nrenderDistance:12\nchatVisibility:0";
        let filtered = filter_options_txt_for_sync(content, &kb);
        assert!(filtered.contains("difficulty:2"));
        assert!(filtered.contains("chatVisibility:0"));
        assert!(!filtered.contains("fov:"));
        assert!(!filtered.contains("renderDistance:"));
    }

    #[test]
    fn test_merge_options_txt() {
        let kb = SettingsKnowledgeBase::new();
        let source = "fov:70.0\ndifficulty:3\ngamma:1.0";
        let target = "fov:90.0\ndifficulty:2\ngamma:0.5";

        let merged = merge_options_txt(source, target, &kb);

        // Личные (fov, gamma) должны быть из target
        assert!(merged.contains("fov:90.0") || merged.contains("fov: 90.0"));
        assert!(merged.contains("gamma:0.5") || merged.contains("gamma: 0.5"));
        // Геймплейные (difficulty) должны быть из source
        assert!(merged.contains("difficulty:3") || merged.contains("difficulty: 3"));
    }
}
