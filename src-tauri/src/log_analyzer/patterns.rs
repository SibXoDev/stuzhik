//! Паттерны распознавания ошибок в логах

use super::mappings::{analyze_class_path, extract_mod_id_from_class};
use lazy_static::lazy_static;
use regex::{Regex, RegexSet};
use stuzhik_core::{
    AutoFix, ClassAnalysisResult, DetectedProblem, ProblemCategory, ProblemStatus, Severity,
    Solution, SolutionDifficulty,
};

/// Паттерн для распознавания проблем
pub(super) struct ErrorPattern {
    /// Регулярное выражение
    pub pattern: Regex,

    /// Функция создания проблемы
    pub handler: fn(&regex::Captures, &str, u32) -> Option<DetectedProblem>,
}

// Кешируем скомпилированные паттерны глобально для производительности
// Компиляция ~50 regex паттернов происходит один раз при первом использовании
lazy_static! {
    pub(super) static ref CACHED_PATTERNS: Vec<ErrorPattern> = {
        let start = std::time::Instant::now();
        let patterns = build_patterns_internal();
        let elapsed = start.elapsed();
        log::info!(
            "✨ Compiled {} regex patterns in {:.1}ms (cached globally)",
            patterns.len(),
            elapsed.as_secs_f64() * 1000.0
        );
        patterns
    };

    /// RegexSet для быстрой пред-фильтрации строк (O(1) проверка всех паттернов)
    /// Это даёт 2-10x ускорение по сравнению с проверкой каждого паттерна по отдельности
    pub(super) static ref PATTERN_SET: RegexSet = {
        let pattern_strings: Vec<&str> = CACHED_PATTERNS
            .iter()
            .map(|p| p.pattern.as_str())
            .collect();
        RegexSet::new(&pattern_strings).expect("Failed to compile RegexSet")
    };
}

/// Получить индексы паттернов, которые матчат строку (быстрая пред-фильтрация)
pub(super) fn get_matching_pattern_indices(line: &str) -> Vec<usize> {
    PATTERN_SET.matches(line).into_iter().collect()
}

/// Получить закешированные паттерны (быстро)
pub(super) fn get_patterns() -> &'static Vec<ErrorPattern> {
    &CACHED_PATTERNS
}

/// Построить паттерны для распознавания ошибок (вызывается один раз)
fn build_patterns_internal() -> Vec<ErrorPattern> {
    vec![
            // Нехватка памяти
            ErrorPattern {
                pattern: Regex::new(r"(?i)java\.lang\.OutOfMemoryError").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("oom_{}", line_num),
                        title: "Нехватка оперативной памяти".into(),
                        description: "Java исчерпала выделенную память. Игра не может продолжать работу.".into(),
                        severity: Severity::Critical,
                        category: ProblemCategory::MemoryIssue,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Увеличить выделенную память".into(),
                                description: "Выделите больше RAM для игры в настройках экземпляра".into(),
                                auto_fix: Some(AutoFix::IncreaseRam { recommended_mb: 8192 }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 90,
                            },
                            Solution {
                                title: "Удалить тяжёлые моды".into(),
                                description: "Shader паки и HD текстуры потребляют много памяти".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 70,
                            },
                        ],
                        docs_links: vec!["https://minecraft.wiki/w/Out_of_memory".into()],
                        related_mods: vec![],
                    })
                },
            },

            // ============ FABRIC DEPENDENCY PATTERNS ============

            // Fabric: "Mod 'X' (Display Name) requires mod 'Y'" - standard format
            ErrorPattern {
                pattern: Regex::new(r"Mod '([^']+)' \(([^)]+)\) requires.*mod '([^']+)'").unwrap(),
                handler: |caps, line, line_num| {
                    let mod_id = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");
                    let mod_name = caps.get(2).map(|m| m.as_str()).unwrap_or("unknown");
                    let required = caps.get(3).map(|m| m.as_str()).unwrap_or("unknown");

                    Some(DetectedProblem {
                        id: format!("missing_dep_{}_{}", mod_id, line_num),
                        title: format!("Отсутствует зависимость: {}", required),
                        description: format!("Мод {} требует {}, который не установлен", mod_name, required),
                        severity: Severity::Error,
                        category: ProblemCategory::MissingDependency,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: format!("Установить {}", required),
                                description: "Скачайте и установите недостающий мод".into(),
                                auto_fix: Some(AutoFix::DownloadMod {
                                    name: required.to_string(),
                                    source: "modrinth".into(),
                                    project_id: required.to_string(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 95,
                            },
                            Solution {
                                title: format!("Удалить {}", mod_name),
                                description: "Если зависимость недоступна, удалите мод который её требует".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 100,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![mod_name.to_string()],
                    })
                },
            },

            // Fabric: "requires any version of mod X, which is missing!"
            ErrorPattern {
                pattern: Regex::new(r"(?i)requires\s+(?:any\s+version\s+of\s+)?mod\s+([a-z0-9_-]+)(?:,\s+which\s+is\s+missing)?").unwrap(),
                handler: |caps, line, line_num| {
                    let required = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");

                    // Skip common false positives
                    if ["java", "minecraft", "fabric", "forge", "fabricloader"].contains(&required) {
                        return None;
                    }

                    Some(DetectedProblem {
                        id: format!("fabric_missing_{}", line_num),
                        title: format!("Отсутствует мод: {}", required),
                        description: format!("Мод '{}' требуется, но не установлен", required),
                        severity: Severity::Critical,
                        category: ProblemCategory::MissingDependency,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: format!("Установить {}", required),
                                description: format!("Скачайте '{}' с Modrinth или CurseForge", required),
                                auto_fix: Some(AutoFix::DownloadMod {
                                    name: required.to_string(),
                                    source: "modrinth".into(),
                                    project_id: required.to_string(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 95,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![required.to_string()],
                    })
                },
            },

            // Fabric FormattedException: "Mod resolution encountered an incompatible mod set!"
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:FormattedException|ModResolutionException).*(?:incompatible|unmet|missing)").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("fabric_resolution_error_{}", line_num),
                        title: "Конфликт зависимостей Fabric".into(),
                        description: "Fabric не может загрузить моды из-за несовместимых или отсутствующих зависимостей. Проверьте следующие строки лога для деталей.".into(),
                        severity: Severity::Critical,
                        category: ProblemCategory::MissingDependency,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Проверить список модов".into(),
                                description: "Откройте вкладку 'Моды' для просмотра конфликтов зависимостей".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 80,
                            },
                        ],
                        docs_links: vec!["https://fabricmc.net/wiki/tutorial:dependencies".into()],
                        related_mods: vec![],
                    })
                },
            },

            // Fabric: "- Mod 'X' (Name) ..." bullet point format in exception message
            ErrorPattern {
                pattern: Regex::new(r"^\s*-\s*Mod\s+'([a-z0-9_-]+)'\s+\(([^)]+)\)").unwrap(),
                handler: |caps, line, line_num| {
                    let mod_id = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");
                    let mod_name = caps.get(2).map(|m| m.as_str()).unwrap_or("unknown");

                    // Only trigger if line indicates a problem
                    let line_lower = line.to_lowercase();
                    if !line_lower.contains("requires") && !line_lower.contains("missing")
                       && !line_lower.contains("depends") && !line_lower.contains("incompatible") {
                        return None;
                    }

                    Some(DetectedProblem {
                        id: format!("fabric_mod_issue_{}_{}", mod_id, line_num),
                        title: format!("Проблема с модом: {}", mod_name),
                        description: format!("Мод '{}' ({}) имеет проблему с зависимостями", mod_name, mod_id),
                        severity: Severity::Error,
                        category: ProblemCategory::MissingDependency,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Проверить зависимости".into(),
                                description: format!("Убедитесь что все зависимости мода '{}' установлены", mod_name),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 75,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![mod_id.to_string()],
                    })
                },
            },

            // Quilt: Similar to Fabric but with Quilt-specific messages
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:quilt|qsl).*(?:requires|depends on|needs)\s+([a-z0-9_-]+)").unwrap(),
                handler: |caps, line, line_num| {
                    let required = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");

                    if ["java", "minecraft", "quilt", "quilted_fabric_api"].contains(&required) {
                        return None;
                    }

                    Some(DetectedProblem {
                        id: format!("quilt_missing_{}", line_num),
                        title: format!("Quilt: Отсутствует {}", required),
                        description: format!("Мод требует '{}', который не установлен", required),
                        severity: Severity::Error,
                        category: ProblemCategory::MissingDependency,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: format!("Установить {}", required),
                                description: format!("Скачайте '{}' с Modrinth", required),
                                auto_fix: Some(AutoFix::DownloadMod {
                                    name: required.to_string(),
                                    source: "modrinth".into(),
                                    project_id: required.to_string(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 90,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![required.to_string()],
                    })
                },
            },

            // ============ EXPLICIT MOD ID PATTERNS ============

            // Registry entry not found (modid:item_name)
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:Unknown|Missing|Invalid)\s+(?:registry\s+)?(?:entry|item|block|entity).*?([a-z0-9_]+):([a-z0-9_/]+)").unwrap(),
                handler: |caps, line, line_num| {
                    let mod_id = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");
                    let entry_name = caps.get(2).map(|m| m.as_str()).unwrap_or("unknown");

                    // Skip minecraft namespace
                    if mod_id == "minecraft" {
                        return None;
                    }

                    Some(DetectedProblem {
                        id: format!("missing_registry_{}_{}", mod_id, line_num),
                        title: format!("Missing registry: {}:{}", mod_id, entry_name),
                        description: format!(
                            "Registry entry '{}:{}' not found. Mod '{}' is probably missing or outdated.",
                            mod_id, entry_name, mod_id
                        ),
                        severity: Severity::Error,
                        category: ProblemCategory::MissingDependency,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: format!("Download mod: {}", mod_id),
                                description: format!("Install '{}' from Modrinth or CurseForge", mod_id),
                                auto_fix: Some(AutoFix::DownloadMod {
                                    name: mod_id.to_string(),
                                    source: "modrinth".into(),
                                    project_id: mod_id.to_string(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 85,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![mod_id.to_string()],
                    })
                },
            },

            // Forge/NeoForge: Missing mod dependency
            ErrorPattern {
                pattern: Regex::new(r"(?i)Missing or unsupported mandatory dependencies:.*?Mod ID: '([a-z0-9_]+)'").unwrap(),
                handler: |caps, line, line_num| {
                    let mod_id = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");

                    Some(DetectedProblem {
                        id: format!("forge_missing_dep_{}", line_num),
                        title: format!("Missing mod: {}", mod_id),
                        description: format!("Required mod '{}' is not installed", mod_id),
                        severity: Severity::Error,
                        category: ProblemCategory::MissingDependency,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: format!("Download: {}", mod_id),
                                description: format!("Search and install '{}' from Modrinth or CurseForge", mod_id),
                                auto_fix: Some(AutoFix::DownloadMod {
                                    name: mod_id.to_string(),
                                    source: "modrinth".into(),
                                    project_id: mod_id.to_string(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 90,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![mod_id.to_string()],
                    })
                },
            },

            // NeoForge: "Mod X requires mod Y" alternative format
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:neoforge|fml).*mod\s+([a-z0-9_]+)\s+requires\s+(?:mod\s+)?([a-z0-9_]+)").unwrap(),
                handler: |caps, line, line_num| {
                    let mod_id = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");
                    let required = caps.get(2).map(|m| m.as_str()).unwrap_or("unknown");

                    if ["minecraft", "neoforge", "forge", "fml"].contains(&required) {
                        return None;
                    }

                    Some(DetectedProblem {
                        id: format!("neoforge_missing_{}_{}", required, line_num),
                        title: format!("NeoForge: Отсутствует {}", required),
                        description: format!("Мод '{}' требует '{}', который не установлен", mod_id, required),
                        severity: Severity::Critical,
                        category: ProblemCategory::MissingDependency,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: format!("Установить {}", required),
                                description: format!("Скачайте '{}' с Modrinth или CurseForge", required),
                                auto_fix: Some(AutoFix::DownloadMod {
                                    name: required.to_string(),
                                    source: "modrinth".into(),
                                    project_id: required.to_string(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 90,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![mod_id.to_string(), required.to_string()],
                    })
                },
            },

            // Forge/NeoForge: "Waiting for mod X" during loading
            ErrorPattern {
                pattern: Regex::new(r#"(?i)(?:waiting\s+for|depends\s+on|requires)\s+(?:mod\s+)?['"]?([a-z0-9_-]+)['"]?"#).unwrap(),
                handler: |caps, line, line_num| {
                    let mod_id = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");

                    // Skip common false positives
                    if ["minecraft", "forge", "neoforge", "fml", "java", "server", "client", "common"].contains(&mod_id) {
                        return None;
                    }

                    // Only trigger if this is in an error context
                    let line_lower = line.to_lowercase();
                    if !line_lower.contains("error") && !line_lower.contains("missing")
                       && !line_lower.contains("failed") && !line_lower.contains("exception")
                       && !line_lower.contains("timeout") {
                        return None;
                    }

                    Some(DetectedProblem {
                        id: format!("waiting_for_mod_{}_{}", mod_id, line_num),
                        title: format!("Ожидание мода: {}", mod_id),
                        description: format!("Загрузчик ожидает мод '{}', который возможно не установлен", mod_id),
                        severity: Severity::Warning,
                        category: ProblemCategory::MissingDependency,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: format!("Проверить наличие {}", mod_id),
                                description: format!("Убедитесь что '{}' установлен и включён", mod_id),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 70,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![mod_id.to_string()],
                    })
                },
            },

            // ============ KUBEJS PATTERNS (HIGH PRIORITY) ============
            // These patterns catch KubeJS-specific errors about missing mods

            // KubeJS: Mod.isLoaded() check or requires() check
            ErrorPattern {
                pattern: Regex::new(r#"(?i)(?:kubejs|kjs).*(?:mod|requires?|needs?|depends?)\s*[\(\['":]?\s*([a-z][a-z0-9_-]{2,})[\)'\]"]?"#).unwrap(),
                handler: |caps, line, line_num| {
                    let mod_id = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");

                    // Skip false positives
                    let false_positives = ["java", "file", "class", "method", "field", "script",
                                          "function", "event", "recipe", "item", "block", "tag",
                                          "startup", "server", "client", "common", "error", "true", "false"];
                    if false_positives.contains(&mod_id) {
                        return None;
                    }

                    // Only trigger if line contains error/warn/missing indicators
                    let line_lower = line.to_lowercase();
                    if !line_lower.contains("error") && !line_lower.contains("missing")
                       && !line_lower.contains("not found") && !line_lower.contains("failed")
                       && !line_lower.contains("required") && !line_lower.contains("not loaded") {
                        return None;
                    }

                    Some(DetectedProblem {
                        id: format!("kubejs_requires_mod_{}_{}", mod_id, line_num),
                        title: format!("KubeJS: Требуется мод {}", mod_id),
                        description: format!("KubeJS скрипт требует мод '{}', который не установлен или не загружен", mod_id),
                        severity: Severity::Critical,
                        category: ProblemCategory::MissingDependency,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: format!("Установить мод: {}", mod_id),
                                description: format!("Найти и установить '{}' с Modrinth или CurseForge", mod_id),
                                auto_fix: Some(AutoFix::DownloadMod {
                                    name: mod_id.to_string(),
                                    source: "modrinth".into(),
                                    project_id: mod_id.to_string(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 90,
                            },
                        ],
                        docs_links: vec!["https://kubejs.com/".into()],
                        related_mods: vec!["kubejs".into(), mod_id.to_string()],
                    })
                },
            },

            // KubeJS: ReferenceError / TypeError when mod is missing (common JS error)
            ErrorPattern {
                pattern: Regex::new(r#"(?i)(?:ReferenceError|TypeError).*?([A-Z][a-zA-Z0-9]+(?:Mod|API|Compat|Integration)?)\s+is\s+(?:not\s+defined|undefined)"#).unwrap(),
                handler: |caps, line, line_num| {
                    let class_name = caps.get(1).map(|m| m.as_str()).unwrap_or("Unknown");

                    // Convert CamelCase to mod-id style
                    let mod_id = class_name
                        .chars()
                        .fold(String::new(), |mut acc, c| {
                            if c.is_uppercase() && !acc.is_empty() {
                                acc.push('_');
                            }
                            acc.push(c.to_ascii_lowercase());
                            acc
                        });

                    Some(DetectedProblem {
                        id: format!("kubejs_undefined_{}_{}", mod_id, line_num),
                        title: format!("KubeJS: {} не определён", class_name),
                        description: format!(
                            "JavaScript ошибка: '{}' не найден. Вероятно мод не установлен или API изменился.",
                            class_name
                        ),
                        severity: Severity::Error,
                        category: ProblemCategory::MissingDependency,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Проверить установленные моды".into(),
                                description: format!("Убедитесь что мод предоставляющий '{}' установлен", class_name),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 70,
                            },
                            Solution {
                                title: "Обновить KubeJS скрипты".into(),
                                description: "Возможно скрипты устарели и используют старый API".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 60,
                            },
                        ],
                        docs_links: vec!["https://kubejs.com/".into()],
                        related_mods: vec!["kubejs".into()],
                    })
                },
            },

            // KubeJS: Direct "mod X not loaded" or "X is not installed" pattern
            // Требует явное слово "mod" перед именем ИЛИ кавычки вокруг имени
            ErrorPattern {
                pattern: Regex::new(r#"(?i)(?:mod\s+['"]?([a-z][a-z0-9_-]{2,})['"]?|['"]([a-z][a-z0-9_-]{2,})['"]\s+(?:mod)?)\s+(?:is\s+)?(?:not\s+(?:loaded|installed|found|available)|missing|unavailable)"#).unwrap(),
                handler: |caps, line, line_num| {
                    // Get mod_id from either capture group
                    let mod_id = caps.get(1)
                        .or_else(|| caps.get(2))
                        .map(|m| m.as_str())
                        .unwrap_or("unknown");

                    let line_lower = line.to_lowercase();

                    // Skip mixin-related lines (they have different format)
                    if line_lower.contains("mixin") || line_lower.contains("@mixin") {
                        return None;
                    }

                    // Only process if it's in a kubejs context or has error indicator
                    if !line_lower.contains("kubejs") && !line_lower.contains("kjs")
                       && !line_lower.contains("error") && !line_lower.contains("warn") {
                        return None;
                    }

                    // Skip false positives - common English words and technical terms
                    let false_positives = [
                        "java", "file", "class", "method", "config", "resource",
                        "was", "were", "been", "being", "the", "this", "that",
                        "target", "mixin", "inject", "accessor", "invoker",
                        "entity", "block", "item", "recipe", "tag", "event",
                    ];
                    if false_positives.contains(&mod_id) {
                        return None;
                    }

                    Some(DetectedProblem {
                        id: format!("mod_not_loaded_{}_{}", mod_id, line_num),
                        title: format!("Мод {} не загружен", mod_id),
                        description: format!("Мод '{}' не установлен или не загружен", mod_id),
                        severity: Severity::Error,
                        category: ProblemCategory::MissingDependency,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: format!("Установить {}", mod_id),
                                description: format!("Скачайте '{}' с Modrinth или CurseForge", mod_id),
                                auto_fix: Some(AutoFix::DownloadMod {
                                    name: mod_id.to_string(),
                                    source: "modrinth".into(),
                                    project_id: mod_id.to_string(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 85,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![mod_id.to_string()],
                    })
                },
            },

            // Generic: mod 'X' is missing / requires mod 'X' (только для явных упоминаний модов)
            ErrorPattern {
                pattern: Regex::new(r#"(?i)(?:mod|dependency)\s+['"]?([a-z0-9_-]+)['"]?\s+(?:is\s+)?(?:missing|not\s+found|required|needed)"#).unwrap(),
                handler: |caps, line, line_num| {
                    let mod_id = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");

                    // Skip common false positives (расширенный список)
                    if ["java", "file", "class", "method", "field", "config", "data", "tag", "item", "block", "entity", "resource", "texture", "model", "sound", "lang"].contains(&mod_id) {
                        return None;
                    }

                    // Проверяем что это похоже на ID мода (содержит _ или -)
                    if !mod_id.contains('_') && !mod_id.contains('-') && mod_id.len() < 4 {
                        return None; // Слишком короткое имя - вероятно не мод
                    }

                    Some(DetectedProblem {
                        id: format!("generic_missing_mod_{}", line_num),
                        title: format!("Возможно отсутствует мод: {}", mod_id),
                        description: format!("Мод '{}' возможно требуется (проверьте логи)", mod_id),
                        severity: Severity::Warning, // Пониженная severity для generic паттерна
                        category: ProblemCategory::MissingDependency,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: format!("Поискать мод: {}", mod_id),
                                description: format!("Проверить на Modrinth/CurseForge нужен ли '{}'", mod_id),
                                auto_fix: None, // Убираем auto_fix для generic паттерна - слишком много ложных срабатываний
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 40, // Снижен success_rate из-за неопределённости
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![mod_id.to_string()],
                    })
                },
            },

            // Log line with mod ID prefix: [modid/ERROR] or [modid/WARN]
            ErrorPattern {
                pattern: Regex::new(r"\[([a-z0-9_-]+)/(?:ERROR|FATAL)\].*(?:(?:missing|not found|failed|error|exception|cannot|unable).*([a-z0-9_]+:[a-z0-9_/]+)?)").unwrap(),
                handler: |caps, line, line_num| {
                    let mod_id = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");
                    let registry = caps.get(2).map(|m| m.as_str());

                    // Skip common non-mod prefixes
                    if ["main", "render", "worker", "server", "client", "minecraft", "fabric", "forge", "neoforge", "modloading"].contains(&mod_id) {
                        return None;
                    }

                    let title = if let Some(reg) = registry {
                        format!("[{}] Missing: {}", mod_id, reg)
                    } else {
                        format!("[{}] Error detected", mod_id)
                    };

                    Some(DetectedProblem {
                        id: format!("mod_error_{}_{}", mod_id, line_num),
                        title,
                        description: format!("Error in mod '{}'. Check if all dependencies are installed.", mod_id),
                        severity: Severity::Error,
                        category: ProblemCategory::ModConflict,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: format!("Check mod: {}", mod_id),
                                description: "Verify mod is up-to-date and all dependencies are installed".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 70,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![mod_id.to_string()],
                    })
                },
            },

            // ============ VERSION/DEPENDENCY PATTERNS ============

            // Конфликт версий мода
            ErrorPattern {
                pattern: Regex::new(r"(?i)Mod '([^']+)' \(([^)]+)\) requires version ([^\s]+) of mod '([^']+)', but ([^\s]+) is loaded").unwrap(),
                handler: |caps, line, line_num| {
                    let mod_name = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");
                    let required_version = caps.get(3).map(|m| m.as_str()).unwrap_or("?");
                    let dep_name = caps.get(4).map(|m| m.as_str()).unwrap_or("unknown");
                    let loaded_version = caps.get(5).map(|m| m.as_str()).unwrap_or("?");

                    Some(DetectedProblem {
                        id: format!("version_mismatch_{}", line_num),
                        title: format!("Несовместимая версия: {}", dep_name),
                        description: format!(
                            "{} требует {} версии {}, но загружена версия {}",
                            mod_name, dep_name, required_version, loaded_version
                        ),
                        severity: Severity::Error,
                        category: ProblemCategory::VersionMismatch,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: format!("Обновить {}", dep_name),
                                description: format!("Установите версию {} или новее", required_version),
                                auto_fix: Some(AutoFix::DownloadMod {
                                    name: dep_name.to_string(),
                                    source: "modrinth".into(),
                                    project_id: dep_name.to_string(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 85,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![mod_name.to_string(), dep_name.to_string()],
                    })
                },
            },

            // Mixin конфликт
            ErrorPattern {
                pattern: Regex::new(r"(?i)Mixin.*failed.*inject.*into.*target.*method.*'([^']+)'.*in.*'([^']+)'").unwrap(),
                handler: |caps, line, line_num| {
                    let method = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");
                    let target = caps.get(2).map(|m| m.as_str()).unwrap_or("unknown");

                    Some(DetectedProblem {
                        id: format!("mixin_conflict_{}", line_num),
                        title: "Конфликт Mixin".into(),
                        description: format!("Не удалось применить mixin к методу {} в {}", method, target),
                        severity: Severity::Critical,
                        category: ProblemCategory::ModConflict,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Проверить совместимость модов".into(),
                                description: "Два или более модов пытаются изменить один и тот же код".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Hard,
                                success_rate: 60,
                            },
                            Solution {
                                title: "Обновить моды".into(),
                                description: "Новые версии модов могут исправить конфликт".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 70,
                            },
                        ],
                        docs_links: vec!["https://fabricmc.net/wiki/tutorial:mixin_introduction".into()],
                        related_mods: vec![],
                    })
                },
            },

            // Неправильная версия Java
            ErrorPattern {
                pattern: Regex::new(r"(?i)UnsupportedClassVersionError.*class file version (\d+)\.(\d+)").unwrap(),
                handler: |caps, line, line_num| {
                    let major = caps.get(1).and_then(|m| m.as_str().parse::<u32>().ok()).unwrap_or(0);
                    let java_version = if major >= 52 { major - 44 } else { 8 };

                    Some(DetectedProblem {
                        id: format!("java_version_{}", line_num),
                        title: format!("Требуется Java {}", java_version),
                        description: format!("Мод скомпилирован для Java {}, установите соответствующую версию", java_version),
                        severity: Severity::Critical,
                        category: ProblemCategory::JavaIssue,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: format!("Установить Java {}", java_version),
                                description: "Скачайте и установите требуемую версию Java".into(),
                                auto_fix: Some(AutoFix::InstallJava { version: java_version }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 95,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![],
                    })
                },
            },

            // Повреждённый JAR файл
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:ZipException|invalid.*zip|corrupt.*jar|error.*reading.*jar).*?([A-Za-z0-9_\-]+\.jar)").unwrap(),
                handler: |caps, line, line_num| {
                    let filename = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown.jar");

                    Some(DetectedProblem {
                        id: format!("corrupt_jar_{}", line_num),
                        title: format!("Повреждённый файл: {}", filename),
                        description: "JAR файл повреждён или неполностью скачан".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::CorruptedFile,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Переустановить мод".into(),
                                description: "Удалите файл и скачайте заново".into(),
                                auto_fix: Some(AutoFix::ReinstallMod { filename: filename.to_string() }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 95,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![filename.to_string()],
                    })
                },
            },

            // Fabric Loader ошибка
            ErrorPattern {
                pattern: Regex::new(r"net\.fabricmc\.loader\.impl\.FormattedException: (.+)").unwrap(),
                handler: |caps, line, line_num| {
                    let message = caps.get(1).map(|m| m.as_str()).unwrap_or("Unknown error");

                    Some(DetectedProblem {
                        id: format!("fabric_error_{}", line_num),
                        title: "Ошибка Fabric Loader".into(),
                        description: message.to_string(),
                        severity: Severity::Critical,
                        category: ProblemCategory::CrashDuringStartup,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Проверить совместимость модов".into(),
                                description: "Убедитесь что все моды совместимы с текущей версией Fabric".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 70,
                            },
                        ],
                        docs_links: vec!["https://fabricmc.net/wiki/".into()],
                        related_mods: vec![],
                    })
                },
            },

            // Forge ошибка загрузки
            ErrorPattern {
                pattern: Regex::new(r"net\.minecraftforge\.fml\.common\.LoaderExceptionModCrash.*Mod.*?(\w+).*?crashed").unwrap(),
                handler: |caps, line, line_num| {
                    let mod_id = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");

                    Some(DetectedProblem {
                        id: format!("forge_mod_crash_{}", line_num),
                        title: format!("Мод {} вызвал краш", mod_id),
                        description: "Мод упал при загрузке".into(),
                        severity: Severity::Critical,
                        category: ProblemCategory::CrashDuringStartup,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: format!("Удалить {}", mod_id),
                                description: "Временно удалите проблемный мод".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 100,
                            },
                            Solution {
                                title: "Обновить мод".into(),
                                description: "Проверьте наличие новой версии".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 60,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![mod_id.to_string()],
                    })
                },
            },

            // OpenGL ошибка
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:GLFW error|OpenGL error|GL_ERROR|failed to create display|EXCEPTION_ACCESS_VIOLATION.*ig\d+icd)").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("opengl_error_{}", line_num),
                        title: "Ошибка графики (OpenGL)".into(),
                        description: "Проблема с драйверами видеокарты или настройками графики".into(),
                        severity: Severity::Critical,
                        category: ProblemCategory::RenderingError,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Обновить драйверы видеокарты".into(),
                                description: "Скачайте последние драйверы с сайта производителя".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 80,
                            },
                            Solution {
                                title: "Отключить шейдеры".into(),
                                description: "Удалите shader pack если он установлен".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 70,
                            },
                            Solution {
                                title: "Добавить -Dorg.lwjgl.opengl.Display.allowSoftwareOpenGL=true".into(),
                                description: "Включить программный рендеринг (снизит производительность)".into(),
                                auto_fix: Some(AutoFix::ChangeJvmArg {
                                    old_arg: None,
                                    new_arg: "-Dorg.lwjgl.opengl.Display.allowSoftwareOpenGL=true".into(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 50,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![],
                    })
                },
            },

            // Дублирующийся мод
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:duplicate|duplicated).*mod.*?([A-Za-z0-9_\-]+)").unwrap(),
                handler: |caps, line, line_num| {
                    let mod_id = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");

                    Some(DetectedProblem {
                        id: format!("duplicate_mod_{}", line_num),
                        title: format!("Дублирующийся мод: {}", mod_id),
                        description: "Мод установлен несколько раз с разными версиями".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::ModConflict,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Удалить дубликаты".into(),
                                description: "Оставьте только одну версию мода".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 100,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![mod_id.to_string()],
                    })
                },
            },

            // Ошибка конфигурации
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:Error|Exception).*(?:loading|parsing|reading).*config.*?([A-Za-z0-9_\-\.]+\.(?:json|toml|cfg|properties))").unwrap(),
                handler: |caps, line, line_num| {
                    let config_file = caps.get(1).map(|m| m.as_str()).unwrap_or("config");

                    Some(DetectedProblem {
                        id: format!("config_error_{}", line_num),
                        title: format!("Ошибка конфигурации: {}", config_file),
                        description: "Файл конфигурации повреждён или имеет неверный формат".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::ConfigError,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Удалить конфиг".into(),
                                description: "Удалите файл и позвольте моду создать новый".into(),
                                auto_fix: Some(AutoFix::DeleteConfig { path: config_file.to_string() }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 90,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![],
                    })
                },
            },

            // Сетевая ошибка
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:Connection.*(?:refused|timed out|reset)|UnknownHostException|SocketException|ConnectException)").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("network_error_{}", line_num),
                        title: "Сетевая ошибка".into(),
                        description: "Не удалось установить соединение".into(),
                        severity: Severity::Warning,
                        category: ProblemCategory::NetworkError,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Проверить интернет-соединение".into(),
                                description: "Убедитесь что интернет работает".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 50,
                            },
                            Solution {
                                title: "Проверить файрвол".into(),
                                description: "Разрешите Minecraft и Java в настройках файрвола".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 70,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![],
                    })
                },
            },

            // KubeJS: Отсутствующий класс (мод не установлен)
            // Расширенный паттерн: поддержка разных форматов KubeJS ошибок о классах
            ErrorPattern {
                pattern: Regex::new(r#"(?i)(?:Failed to load|Could not (?:find|load)|Cannot (?:find|load)|Unable to (?:find|load)).*?(?:Java )?[Cc]lass[:\s]+['"]?([a-zA-Z0-9_.$]+)['"]?"#).unwrap(),
                handler: |caps, line, line_num| {
                    let class_name = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");
                    let line_lower = line.to_lowercase();

                    // Умное извлечение mod ID из пути класса
                    let mod_id = extract_mod_id_from_class(class_name);
                    let mod_name_display = mod_id.replace('_', " ").replace('-', " ");

                    // Если это сообщение об отключённой интеграции - Info, не ошибка
                    // Например: "Integration with PonderJS disabled" - просто информация
                    if line_lower.contains("integration") &&
                       (line_lower.contains("disabled") || line_lower.contains("skipping") || line_lower.contains("skipped")) {
                        return Some(DetectedProblem {
                            id: format!("integration_disabled_{}", line_num),
                            title: format!("Интеграция отключена: {}", mod_name_display),
                            description: format!(
                                "Интеграция с модом '{}' отключена. Это не ошибка - мод просто не нашёл опциональный компонент.",
                                mod_name_display
                            ),
                            severity: Severity::Info,
                            category: ProblemCategory::ModConflict,
                            status: ProblemStatus::Detected,
                            log_line: Some(line.to_string()),
                            line_number: Some(line_num),
                            solutions: vec![],
                            docs_links: vec![],
                            related_mods: vec![mod_id.clone()],
                        });
                    }

                    // Формируем заголовок с именем мода
                    let title = if mod_id != "unknown" {
                        format!("Missing mod: {}", mod_name_display)
                    } else {
                        "KubeJS: Class not found".into()
                    };

                    Some(DetectedProblem {
                        id: format!("kubejs_missing_class_{}", line_num),
                        title,
                        description: format!(
                            "KubeJS script requires class '{}' which is not found. The mod '{}' is probably missing.",
                            class_name, mod_name_display
                        ),
                        severity: Severity::Error,
                        category: ProblemCategory::MissingDependency,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: format!("Download mod: {}", mod_name_display),
                                description: format!("Search and install '{}' from Modrinth or CurseForge", mod_name_display),
                                auto_fix: if mod_id != "unknown" {
                                    Some(AutoFix::DownloadMod {
                                        name: mod_name_display.clone(),
                                        source: "modrinth".into(),
                                        project_id: mod_id.clone(),
                                    })
                                } else {
                                    None
                                },
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 85,
                            },
                            Solution {
                                title: "Remove/fix KubeJS script".into(),
                                description: "Remove or edit the script that uses this class".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 100,
                            },
                        ],
                        docs_links: vec!["https://kubejs.com/wiki/".into()],
                        related_mods: vec!["kubejs".into(), mod_id],
                    })
                },
            },

            // KubeJS: Ошибка в скрипте
            ErrorPattern {
                pattern: Regex::new(r"(?i)\[KubeJS\].*(?:Error|Exception).*?([a-z_/]+\.js)(?:#(\d+))?").unwrap(),
                handler: |caps, line, line_num| {
                    let script_file = caps.get(1).map(|m| m.as_str()).unwrap_or("script.js");
                    let script_line = caps.get(2).map(|m| m.as_str()).unwrap_or("?");

                    Some(DetectedProblem {
                        id: format!("kubejs_script_error_{}", line_num),
                        title: format!("Ошибка скрипта KubeJS: {}", script_file),
                        description: format!("Ошибка в скрипте {} на строке {}", script_file, script_line),
                        severity: Severity::Error,
                        category: ProblemCategory::ConfigError,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Проверить синтаксис скрипта".into(),
                                description: format!("Откройте kubejs/{} и исправьте ошибку", script_file),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 90,
                            },
                        ],
                        docs_links: vec!["https://kubejs.com/wiki/".into()],
                        related_mods: vec!["kubejs".into()],
                    })
                },
            },

            // Общий паттерн: ClassNotFoundException
            // Интеллектуально определяет тип класса и даёт соответствующий совет
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:ClassNotFoundException|NoClassDefFoundError).*?([a-zA-Z0-9_.]+)").unwrap(),
                handler: |caps, line, line_num| {
                    let class_name = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");
                    let analysis = analyze_class_path(class_name);
                    let line_lower = line.to_lowercase();

                    // Проверяем контекст - это mixin ошибка?
                    let is_mixin_error = line_lower.contains("mixin") || line_lower.contains("mixing");

                    match analysis {
                        // Библиотеки игнорируем - это внутренние ошибки
                        ClassAnalysisResult::Library => None,

                        // Minecraft класс - это серьёзная проблема
                        ClassAnalysisResult::Minecraft => Some(DetectedProblem {
                            id: format!("minecraft_class_missing_{}", line_num),
                            title: "Повреждён Minecraft".into(),
                            description: format!(
                                "Класс Minecraft '{}' не найден. Игра повреждена или установлена неправильно.",
                                class_name
                            ),
                            severity: Severity::Critical,
                            category: ProblemCategory::CorruptedFile,
                            status: ProblemStatus::Detected,
                            log_line: Some(line.to_string()),
                            line_number: Some(line_num),
                            solutions: vec![
                                Solution {
                                    title: "Переустановить экземпляр".into(),
                                    description: "Удалите и создайте экземпляр заново".into(),
                                    auto_fix: Some(AutoFix::VerifyFiles),
                                    difficulty: SolutionDifficulty::Medium,
                                    success_rate: 95,
                                },
                            ],
                            docs_links: vec![],
                            related_mods: vec![],
                        }),

                        // Загрузчик - показать несовместимость
                        ClassAnalysisResult::Loader(loader) => {
                            // Если это mixin warning - это не фатальная ошибка
                            if is_mixin_error {
                                Some(DetectedProblem {
                                    id: format!("loader_mixin_warning_{}", line_num),
                                    title: format!("Mixin: попытка использовать {} API", loader),
                                    description: format!(
                                        "Какой-то мод пытается модифицировать класс '{}' из {} API. \
                                        Это обычно означает что установлен мод для {}, который не совместим с вашим загрузчиком. \
                                        Это предупреждение может не влиять на игру если мод опционально поддерживает {}.",
                                        class_name, loader, loader, loader
                                    ),
                                    severity: Severity::Warning,
                                    category: ProblemCategory::ModConflict,
                                    status: ProblemStatus::Detected,
                                    log_line: Some(line.to_string()),
                                    line_number: Some(line_num),
                                    solutions: vec![
                                        Solution {
                                            title: "Проверить список модов".into(),
                                            description: format!(
                                                "Посмотрите какие моды у вас установлены. \
                                                Возможно какой-то мод предназначен для {} а не для вашего загрузчика.",
                                                loader
                                            ),
                                            auto_fix: None,
                                            difficulty: SolutionDifficulty::Medium,
                                            success_rate: 70,
                                        },
                                        Solution {
                                            title: "Игнорировать если игра работает".into(),
                                            description: "Если игра запускается и работает нормально, это предупреждение можно проигнорировать.".into(),
                                            auto_fix: None,
                                            difficulty: SolutionDifficulty::Easy,
                                            success_rate: 80,
                                        },
                                    ],
                                    docs_links: vec![],
                                    related_mods: vec![],
                                })
                            } else {
                                // Реальная ошибка загрузчика (не mixin)
                                Some(DetectedProblem {
                                    id: format!("loader_mismatch_{}", line_num),
                                    title: format!("Несовместимый загрузчик: {}", loader),
                                    description: format!(
                                        "Мод требует загрузчик '{}', но установлен другой. \
                                        Класс '{}' принадлежит загрузчику {}.",
                                        loader, class_name, loader
                                    ),
                                    severity: Severity::Error,
                                    category: ProblemCategory::VersionMismatch,
                                    status: ProblemStatus::Detected,
                                    log_line: Some(line.to_string()),
                                    line_number: Some(line_num),
                                    solutions: vec![
                                        Solution {
                                            title: "Удалить несовместимый мод".into(),
                                            description: format!(
                                                "Этот мод для {} и не будет работать на текущем загрузчике. \
                                                Найдите альтернативу для вашего загрузчика.",
                                                loader
                                            ),
                                            auto_fix: None,
                                            difficulty: SolutionDifficulty::Easy,
                                            success_rate: 100,
                                        },
                                    ],
                                    docs_links: vec![],
                                    related_mods: vec![],
                                })
                            }
                        }

                        // Мод - различаем mixin ошибки и реально отсутствующие моды
                        ClassAnalysisResult::Mod(mod_id) => {
                            let mod_name_display = mod_id.replace('_', " ").replace('-', " ");

                            if is_mixin_error {
                                // Mixin ошибка = версия мода несовместима с каким-то аддоном
                                Some(DetectedProblem {
                                    id: format!("mixin_version_mismatch_{}", line_num),
                                    title: format!("Несовместимая версия: {}", mod_name_display),
                                    description: format!(
                                        "Какой-то мод пытается изменить класс '{}' мода '{}', но этот класс не существует. \
                                        Скорее всего аддон несовместим с установленной версией {}.",
                                        class_name, mod_name_display, mod_name_display
                                    ),
                                    severity: Severity::Warning,
                                    category: ProblemCategory::VersionMismatch,
                                    status: ProblemStatus::Detected,
                                    log_line: Some(line.to_string()),
                                    line_number: Some(line_num),
                                    solutions: vec![
                                        Solution {
                                            title: "Обновить аддоны".into(),
                                            description: format!(
                                                "Найдите какой мод добавляет mixin для {} и обновите его до совместимой версии.",
                                                mod_name_display
                                            ),
                                            auto_fix: None,
                                            difficulty: SolutionDifficulty::Medium,
                                            success_rate: 80,
                                        },
                                        Solution {
                                            title: format!("Изменить версию {}", mod_name_display),
                                            description: "Попробуйте другую версию основного мода, совместимую с аддонами.".into(),
                                            auto_fix: None,
                                            difficulty: SolutionDifficulty::Medium,
                                            success_rate: 70,
                                        },
                                    ],
                                    docs_links: vec![],
                                    related_mods: vec![mod_id.to_string()],
                                })
                            } else {
                                // Обычная ошибка - мод действительно отсутствует
                                Some(DetectedProblem {
                                    id: format!("class_not_found_{}", line_num),
                                    title: format!("Отсутствует мод: {}", mod_name_display),
                                    description: format!(
                                        "Класс '{}' не найден. Мод '{}' отсутствует или повреждён.",
                                        class_name, mod_name_display
                                    ),
                                    severity: Severity::Error,
                                    category: ProblemCategory::MissingDependency,
                                    status: ProblemStatus::Detected,
                                    log_line: Some(line.to_string()),
                                    line_number: Some(line_num),
                                    solutions: vec![
                                        Solution {
                                            title: format!("Установить мод: {}", mod_name_display),
                                            description: format!("Найдите и установите '{}' с Modrinth или CurseForge", mod_name_display),
                                            auto_fix: Some(AutoFix::DownloadMod {
                                                name: mod_name_display.clone(),
                                                source: "modrinth".into(),
                                                project_id: mod_id.clone(),
                                            }),
                                            difficulty: SolutionDifficulty::Easy,
                                            success_rate: 80,
                                        },
                                        Solution {
                                            title: "Обновить зависимые моды".into(),
                                            description: "Возможно один из модов использует устаревшую версию API".into(),
                                            auto_fix: None,
                                            difficulty: SolutionDifficulty::Medium,
                                            success_rate: 70,
                                        },
                                    ],
                                    docs_links: vec![],
                                    related_mods: vec![mod_id],
                                })
                            }
                        }

                        // Неизвестный класс - общее сообщение
                        ClassAnalysisResult::Unknown => {
                            let short_name = class_name.split('.').last().unwrap_or(class_name);
                            Some(DetectedProblem {
                                id: format!("class_not_found_{}", line_num),
                                title: format!("Класс не найден: {}", short_name),
                                description: format!(
                                    "Java не может найти класс '{}'. Это может быть связано с \
                                    отсутствующим модом или несовместимостью версий.",
                                    class_name
                                ),
                                severity: Severity::Error,
                                category: ProblemCategory::MissingDependency,
                                status: ProblemStatus::Detected,
                                log_line: Some(line.to_string()),
                                line_number: Some(line_num),
                                solutions: vec![
                                    Solution {
                                        title: "Проверить совместимость модов".into(),
                                        description: "Убедитесь что все моды совместимы с версией игры и загрузчика".into(),
                                        auto_fix: None,
                                        difficulty: SolutionDifficulty::Medium,
                                        success_rate: 70,
                                    },
                                ],
                                docs_links: vec![],
                                related_mods: vec![],
                            })
                        },
                    }
                },
            },

            // ============ JAVA LINKAGE ERRORS ============

            // NoSuchMethodError - метод удалён или изменён
            ErrorPattern {
                pattern: Regex::new(r"(?i)java\.lang\.NoSuchMethodError:.*?'?([a-zA-Z0-9_.$]+)'?").unwrap(),
                handler: |caps, line, line_num| {
                    let method = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");
                    Some(DetectedProblem {
                        id: format!("no_such_method_{}", line_num),
                        title: "Метод не найден".into(),
                        description: format!("Метод '{}' не существует. Версии модов несовместимы.", method),
                        severity: Severity::Error,
                        category: ProblemCategory::VersionMismatch,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Обновить моды".into(),
                                description: "Установите совместимые версии всех модов".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 80,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![],
                    })
                },
            },

            // NoSuchFieldError
            ErrorPattern {
                pattern: Regex::new(r"(?i)java\.lang\.NoSuchFieldError:.*?'?([a-zA-Z0-9_.$]+)'?").unwrap(),
                handler: |caps, line, line_num| {
                    let field = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");
                    Some(DetectedProblem {
                        id: format!("no_such_field_{}", line_num),
                        title: "Поле не найдено".into(),
                        description: format!("Поле '{}' не существует. Версии модов несовместимы.", field),
                        severity: Severity::Error,
                        category: ProblemCategory::VersionMismatch,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Обновить моды".into(),
                                description: "Убедитесь что все моды для одной версии Minecraft".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 80,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![],
                    })
                },
            },

            // AbstractMethodError
            ErrorPattern {
                pattern: Regex::new(r"(?i)java\.lang\.AbstractMethodError").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("abstract_method_{}", line_num),
                        title: "Несовместимость API".into(),
                        description: "Мод использует устаревший интерфейс библиотеки".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::VersionMismatch,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Обновить все моды и библиотеки".into(),
                                description: "Скачайте последние версии модов".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 75,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![],
                    })
                },
            },

            // IncompatibleClassChangeError
            ErrorPattern {
                pattern: Regex::new(r"(?i)java\.lang\.IncompatibleClassChangeError").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("incompatible_class_{}", line_num),
                        title: "Несовместимое изменение класса".into(),
                        description: "Бинарная несовместимость между модами".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::ModConflict,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Проверить версии модов".into(),
                                description: "Убедитесь что все моды для одной версии игры".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 70,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![],
                    })
                },
            },

            // ============ FORGE/NEOFORGE ERRORS ============

            // Forge: Missing mod dependency
            ErrorPattern {
                pattern: Regex::new(r"(?i)Missing or unsupported mandatory dependencies:.*?Mod ID: '([^']+)'.*?requires.*?mod '([^']+)'").unwrap(),
                handler: |caps, line, line_num| {
                    let mod_id = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");
                    let required = caps.get(2).map(|m| m.as_str()).unwrap_or("unknown");
                    Some(DetectedProblem {
                        id: format!("forge_missing_dep_{}", line_num),
                        title: format!("Forge: Отсутствует {}", required),
                        description: format!("Мод {} требует {}", mod_id, required),
                        severity: Severity::Error,
                        category: ProblemCategory::MissingDependency,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: format!("Установить {}", required),
                                description: "Скачайте мод с CurseForge или Modrinth".into(),
                                auto_fix: Some(AutoFix::DownloadMod {
                                    name: required.to_string(),
                                    source: "modrinth".into(),
                                    project_id: required.to_string(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 90,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![mod_id.to_string()],
                    })
                },
            },

            // Forge: Mod loading error
            ErrorPattern {
                pattern: Regex::new(r"(?i)net\.minecraftforge\.fml\.ModLoadingException.*?(\w+)").unwrap(),
                handler: |caps, line, line_num| {
                    let mod_id = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");
                    Some(DetectedProblem {
                        id: format!("forge_mod_loading_{}", line_num),
                        title: format!("Ошибка загрузки мода: {}", mod_id),
                        description: "Мод не смог загрузиться".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::ModConflict,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Проверить версию мода".into(),
                                description: "Убедитесь что мод совместим с вашей версией Forge".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 70,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![mod_id.to_string()],
                    })
                },
            },

            // ============ FABRIC API ERRORS ============

            // Fabric API missing module
            ErrorPattern {
                pattern: Regex::new(r"(?i)Mod '([^']+)' requires.*fabric-([a-z\-]+)-api").unwrap(),
                handler: |caps, line, line_num| {
                    let mod_name = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");
                    let api_module = caps.get(2).map(|m| m.as_str()).unwrap_or("unknown");
                    Some(DetectedProblem {
                        id: format!("fabric_api_module_{}", line_num),
                        title: format!("Fabric API: Требуется модуль {}", api_module),
                        description: format!("Мод {} требует Fabric API модуль: fabric-{}-api", mod_name, api_module),
                        severity: Severity::Error,
                        category: ProblemCategory::MissingDependency,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Установить/обновить Fabric API".into(),
                                description: "Скачайте последнюю версию Fabric API".into(),
                                auto_fix: Some(AutoFix::DownloadMod {
                                    name: "Fabric API".into(),
                                    source: "modrinth".into(),
                                    project_id: "fabric-api".into(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 95,
                            },
                        ],
                        docs_links: vec!["https://modrinth.com/mod/fabric-api".into()],
                        related_mods: vec![mod_name.to_string(), "fabric-api".into()],
                    })
                },
            },

            // ============ POPULAR LIBRARIES ============

            // Architectury API
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:requires|needs).*architectury").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("architectury_missing_{}", line_num),
                        title: "Требуется Architectury API".into(),
                        description: "Мод требует библиотеку Architectury API".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::MissingDependency,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Установить Architectury API".into(),
                                description: "Скачайте Architectury API для вашего загрузчика".into(),
                                auto_fix: Some(AutoFix::DownloadMod {
                                    name: "Architectury API".into(),
                                    source: "modrinth".into(),
                                    project_id: "architectury-api".into(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 95,
                            },
                        ],
                        docs_links: vec!["https://modrinth.com/mod/architectury-api".into()],
                        related_mods: vec!["architectury".into()],
                    })
                },
            },

            // Cloth Config
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:requires|needs).*cloth[_\-]?config").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("cloth_config_missing_{}", line_num),
                        title: "Требуется Cloth Config".into(),
                        description: "Мод требует библиотеку Cloth Config для настроек".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::MissingDependency,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Установить Cloth Config".into(),
                                description: "Скачайте Cloth Config API".into(),
                                auto_fix: Some(AutoFix::DownloadMod {
                                    name: "Cloth Config".into(),
                                    source: "modrinth".into(),
                                    project_id: "cloth-config".into(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 95,
                            },
                        ],
                        docs_links: vec!["https://modrinth.com/mod/cloth-config".into()],
                        related_mods: vec!["cloth-config".into()],
                    })
                },
            },

            // GeckoLib
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:requires|needs|missing).*geckolib").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("geckolib_missing_{}", line_num),
                        title: "Требуется GeckoLib".into(),
                        description: "Мод требует библиотеку GeckoLib для анимаций".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::MissingDependency,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Установить GeckoLib".into(),
                                description: "Скачайте GeckoLib для вашей версии".into(),
                                auto_fix: Some(AutoFix::DownloadMod {
                                    name: "GeckoLib".into(),
                                    source: "modrinth".into(),
                                    project_id: "geckolib".into(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 95,
                            },
                        ],
                        docs_links: vec!["https://modrinth.com/mod/geckolib".into()],
                        related_mods: vec!["geckolib".into()],
                    })
                },
            },

            // Kotlin for Forge/Fabric
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:requires|needs|missing).*kotlin.*(?:forge|fabric|language\s*provider)").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("kotlin_missing_{}", line_num),
                        title: "Требуется Kotlin".into(),
                        description: "Мод написан на Kotlin и требует языковой провайдер".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::MissingDependency,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Установить Kotlin for Forge/Fabric".into(),
                                description: "Скачайте Kotlin Language Provider".into(),
                                auto_fix: Some(AutoFix::DownloadMod {
                                    name: "Kotlin for Forge".into(),
                                    source: "modrinth".into(),
                                    project_id: "kotlin-for-forge".into(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 95,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec!["kotlin".into()],
                    })
                },
            },

            // Iceberg (required by many mods)
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:requires|needs|missing).*iceberg").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("iceberg_missing_{}", line_num),
                        title: "Требуется Iceberg".into(),
                        description: "Мод требует библиотеку Iceberg".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::MissingDependency,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Установить Iceberg".into(),
                                description: "Скачайте Iceberg".into(),
                                auto_fix: Some(AutoFix::DownloadMod {
                                    name: "Iceberg".into(),
                                    source: "modrinth".into(),
                                    project_id: "iceberg".into(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 95,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec!["iceberg".into()],
                    })
                },
            },

            // Balm (by BlayTheNinth)
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:requires|needs|missing).*balm").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("balm_missing_{}", line_num),
                        title: "Требуется Balm".into(),
                        description: "Мод требует библиотеку Balm".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::MissingDependency,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Установить Balm".into(),
                                description: "Скачайте Balm".into(),
                                auto_fix: Some(AutoFix::DownloadMod {
                                    name: "Balm".into(),
                                    source: "modrinth".into(),
                                    project_id: "balm".into(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 95,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec!["balm".into()],
                    })
                },
            },

            // Bookshelf
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:requires|needs|missing).*bookshelf").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("bookshelf_missing_{}", line_num),
                        title: "Требуется Bookshelf".into(),
                        description: "Мод требует библиотеку Bookshelf".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::MissingDependency,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Установить Bookshelf".into(),
                                description: "Скачайте Bookshelf".into(),
                                auto_fix: Some(AutoFix::DownloadMod {
                                    name: "Bookshelf".into(),
                                    source: "modrinth".into(),
                                    project_id: "bookshelf-lib".into(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 95,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec!["bookshelf".into()],
                    })
                },
            },

            // Puzzles Lib
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:requires|needs|missing).*puzzles[\s_\-]?lib").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("puzzleslib_missing_{}", line_num),
                        title: "Требуется Puzzles Lib".into(),
                        description: "Мод требует библиотеку Puzzles Lib".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::MissingDependency,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Установить Puzzles Lib".into(),
                                description: "Скачайте Puzzles Lib".into(),
                                auto_fix: Some(AutoFix::DownloadMod {
                                    name: "Puzzles Lib".into(),
                                    source: "modrinth".into(),
                                    project_id: "puzzles-lib".into(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 95,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec!["puzzles-lib".into()],
                    })
                },
            },

            // Moonlight Lib
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:requires|needs|missing).*moonlight").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("moonlight_missing_{}", line_num),
                        title: "Требуется Moonlight Lib".into(),
                        description: "Мод требует библиотеку Moonlight".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::MissingDependency,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Установить Moonlight Lib".into(),
                                description: "Скачайте Moonlight Lib".into(),
                                auto_fix: Some(AutoFix::DownloadMod {
                                    name: "Moonlight Lib".into(),
                                    source: "modrinth".into(),
                                    project_id: "moonlight".into(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 95,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec!["moonlight".into()],
                    })
                },
            },

            // Collective (by Serilum)
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:requires|needs|missing).*collective").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("collective_missing_{}", line_num),
                        title: "Требуется Collective".into(),
                        description: "Мод требует библиотеку Collective".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::MissingDependency,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Установить Collective".into(),
                                description: "Скачайте Collective".into(),
                                auto_fix: Some(AutoFix::DownloadMod {
                                    name: "Collective".into(),
                                    source: "modrinth".into(),
                                    project_id: "collective".into(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 95,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec!["collective".into()],
                    })
                },
            },

            // ============ POPULAR MODS CONFLICTS ============

            // Sodium/Rubidium conflicts
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:sodium|rubidium).*(?:conflict|incompatible|crash)").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("sodium_conflict_{}", line_num),
                        title: "Конфликт с Sodium/Rubidium".into(),
                        description: "Мод несовместим с Sodium/Rubidium оптимизацией рендера".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::ModConflict,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Установить Indium (для Fabric)".into(),
                                description: "Indium добавляет поддержку Fabric Rendering API для Sodium".into(),
                                auto_fix: Some(AutoFix::DownloadMod {
                                    name: "Indium".into(),
                                    source: "modrinth".into(),
                                    project_id: "indium".into(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 80,
                            },
                            Solution {
                                title: "Удалить конфликтующий мод".into(),
                                description: "Некоторые моды не работают с Sodium".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 90,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec!["sodium".into()],
                    })
                },
            },

            // Iris/Oculus shader errors
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:iris|oculus).*(?:shader.*(?:error|failed|compile)|failed.*load)").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("shader_error_{}", line_num),
                        title: "Ошибка шейдера".into(),
                        description: "Шейдерпак несовместим или повреждён".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::RenderingError,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Отключить шейдеры".into(),
                                description: "Отключите шейдерпак в настройках".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 100,
                            },
                            Solution {
                                title: "Обновить шейдерпак".into(),
                                description: "Скачайте версию шейдерпака для вашей версии Iris/Oculus".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 70,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec!["iris".into()],
                    })
                },
            },

            // JEI/REI/EMI loading errors
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:jei|rei|emi).*(?:error|exception|failed).*(?:load|register|plugin)").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("recipe_viewer_error_{}", line_num),
                        title: "Ошибка просмотрщика рецептов".into(),
                        description: "JEI/REI/EMI не смог загрузить плагин мода".into(),
                        severity: Severity::Warning,
                        category: ProblemCategory::ModConflict,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Обновить JEI/REI/EMI".into(),
                                description: "Установите последнюю версию просмотрщика рецептов".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 70,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec!["jei".into(), "rei".into(), "emi".into()],
                    })
                },
            },

            // Create mod errors
            ErrorPattern {
                pattern: Regex::new(r"(?i)com\.simibubi\.create.*(?:Exception|Error)").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("create_error_{}", line_num),
                        title: "Ошибка Create".into(),
                        description: "Мод Create столкнулся с ошибкой".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::ModConflict,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Обновить Create и зависимости".into(),
                                description: "Убедитесь что Flywheel и другие зависимости обновлены".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 70,
                            },
                        ],
                        docs_links: vec!["https://modrinth.com/mod/create".into()],
                        related_mods: vec!["create".into()],
                    })
                },
            },

            // Flywheel (Create dependency)
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:requires|needs|missing).*flywheel").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("flywheel_missing_{}", line_num),
                        title: "Требуется Flywheel".into(),
                        description: "Create и другие моды требуют Flywheel для рендера".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::MissingDependency,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Установить Flywheel".into(),
                                description: "Скачайте Flywheel".into(),
                                auto_fix: Some(AutoFix::DownloadMod {
                                    name: "Flywheel".into(),
                                    source: "modrinth".into(),
                                    project_id: "flywheel".into(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 95,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec!["flywheel".into(), "create".into()],
                    })
                },
            },

            // Curios/Trinkets API
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:requires|needs|missing).*(?:curios|trinkets)").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("curios_missing_{}", line_num),
                        title: "Требуется Curios/Trinkets API".into(),
                        description: "Мод требует API для аксессуаров".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::MissingDependency,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Установить Curios (Forge) или Trinkets (Fabric)".into(),
                                description: "Скачайте API для вашего загрузчика".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 95,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec!["curios".into(), "trinkets".into()],
                    })
                },
            },

            // Patchouli (guide books)
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:requires|needs|missing).*patchouli").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("patchouli_missing_{}", line_num),
                        title: "Требуется Patchouli".into(),
                        description: "Мод требует Patchouli для книг-гайдов".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::MissingDependency,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Установить Patchouli".into(),
                                description: "Скачайте Patchouli".into(),
                                auto_fix: Some(AutoFix::DownloadMod {
                                    name: "Patchouli".into(),
                                    source: "modrinth".into(),
                                    project_id: "patchouli".into(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 95,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec!["patchouli".into()],
                    })
                },
            },

            // ============ WORLD ERRORS ============

            // World/Region file corruption - more specific pattern
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:region file|chunk at|world save|level\.dat).*(?:corrupt|invalid|damage|failed to load)").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("world_corrupt_{}", line_num),
                        title: "World file corruption".into(),
                        description: "World/region files may be corrupted".into(),
                        severity: Severity::Critical,
                        category: ProblemCategory::CorruptedFile,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Restore from backup".into(),
                                description: "Use the latest world backup".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 90,
                            },
                            Solution {
                                title: "Use MCA Selector".into(),
                                description: "Remove corrupted chunks with MCA Selector tool".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Hard,
                                success_rate: 70,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![],
                    })
                },
            },

            // NBT parsing error - more specific
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:NBTTagCompound|TagCompound|NBTException|nbt\..*Exception)").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("nbt_error_{}", line_num),
                        title: "NBT data error".into(),
                        description: "NBT data for entity or block is corrupted".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::CorruptedFile,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Remove problematic entity".into(),
                                description: "Use NBT editor to remove corrupted data".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Hard,
                                success_rate: 80,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![],
                    })
                },
            },

            // ============ CRASH PATTERNS ============

            // TickingEntity crash
            ErrorPattern {
                pattern: Regex::new(r"(?i)Ticking (?:entity|block entity).*?([A-Za-z0-9_:]+)").unwrap(),
                handler: |caps, line, line_num| {
                    let entity = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");
                    Some(DetectedProblem {
                        id: format!("ticking_entity_{}", line_num),
                        title: format!("Краш при обработке: {}", entity),
                        description: format!("Игра крашнулась при обновлении сущности {}", entity),
                        severity: Severity::Critical,
                        category: ProblemCategory::CrashDuringGameplay,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Удалить сущность".into(),
                                description: "Используйте NBT редактор или команды".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Hard,
                                success_rate: 80,
                            },
                            Solution {
                                title: "Обновить мод".into(),
                                description: "Возможно баг исправлен в новой версии".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 60,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![],
                    })
                },
            },

            // StackOverflowError
            ErrorPattern {
                pattern: Regex::new(r"(?i)java\.lang\.StackOverflowError").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("stack_overflow_{}", line_num),
                        title: "Переполнение стека".into(),
                        description: "Бесконечная рекурсия в коде мода".into(),
                        severity: Severity::Critical,
                        category: ProblemCategory::ModConflict,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Найти конфликт модов".into(),
                                description: "Отключайте моды по одному".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Hard,
                                success_rate: 70,
                            },
                            Solution {
                                title: "Увеличить размер стека".into(),
                                description: "Добавьте -Xss2M в JVM аргументы".into(),
                                auto_fix: Some(AutoFix::ChangeJvmArg {
                                    old_arg: None,
                                    new_arg: "-Xss2M".into(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 40,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![],
                    })
                },
            },

            // ConcurrentModificationException
            ErrorPattern {
                pattern: Regex::new(r"(?i)java\.util\.ConcurrentModificationException").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("concurrent_mod_{}", line_num),
                        title: "Ошибка многопоточности".into(),
                        description: "Баг в моде с многопоточным доступом".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::ModConflict,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Обновить проблемный мод".into(),
                                description: "Баг скорее всего исправлен в новой версии".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 70,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![],
                    })
                },
            },

            // ============ MIXIN ERRORS ============

            // Mixin FAILED during APPLY (specific mod extraction from mixin config)
            ErrorPattern {
                pattern: Regex::new(r"(?i)Mixin\s+\[([^\]]+\.mixins\.json):([^\]]+)\]\s+(?:from\s+mod\s+([a-z0-9_]+)\s+)?FAILED\s+during\s+(PREINJECT|INJECT|APPLY)").unwrap(),
                handler: |caps, line, line_num| {
                    let mixin_config = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");
                    let mixin_class = caps.get(2).map(|m| m.as_str()).unwrap_or("unknown");
                    let mod_id = caps.get(3).map(|m| m.as_str())
                        .or_else(|| mixin_config.split('.').next())
                        .unwrap_or("unknown");
                    let phase = caps.get(4).map(|m| m.as_str()).unwrap_or("APPLY");

                    Some(DetectedProblem {
                        id: format!("mixin_failed_{}_{}", mod_id, line_num),
                        title: format!("Mixin ошибка: {} ({})", mod_id, phase),
                        description: format!(
                            "Мод '{}' не смог применить Mixin '{}'. Это часто означает несовместимость с версией Forge/Fabric или конфликт с другим модом.",
                            mod_id, mixin_class
                        ),
                        severity: Severity::Critical,
                        category: ProblemCategory::ModConflict,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: format!("Обновить мод {}", mod_id),
                                description: "Скачайте последнюю версию мода, совместимую с вашим загрузчиком".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 70,
                            },
                            Solution {
                                title: "Понизить версию Forge/Fabric".into(),
                                description: "Некоторые моды несовместимы с новыми версиями загрузчика".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 60,
                            },
                            Solution {
                                title: format!("Удалить мод {}", mod_id),
                                description: "Если мод не критичен, удалите его".into(),
                                auto_fix: Some(AutoFix::RemoveMod { filename: format!("{}.jar", mod_id) }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 100,
                            },
                        ],
                        docs_links: vec!["https://github.com/SpongePowered/Mixin/wiki/Troubleshooting".into()],
                        related_mods: vec![mod_id.to_string()],
                    })
                },
            },

            // MixinApplyError / MixinTransformerError
            ErrorPattern {
                pattern: Regex::new(r"(?i)org\.spongepowered\.asm\.mixin\.transformer\.(Mixin(?:Apply|Transformer)Error|MixinException).*?(?:in\s+)?([a-z][a-z0-9_.-]+\.mixins\.json)?").unwrap(),
                handler: |caps, line, line_num| {
                    let error_type = caps.get(1).map(|m| m.as_str()).unwrap_or("MixinError");
                    let mixin_config = caps.get(2).map(|m| m.as_str());
                    let mod_id = mixin_config
                        .and_then(|c| c.split('.').next())
                        .unwrap_or("unknown");

                    Some(DetectedProblem {
                        id: format!("mixin_transform_error_{}", line_num),
                        title: format!("Mixin {} от {}", error_type, mod_id),
                        description: format!(
                            "Критическая ошибка Mixin: {}. Мод '{}' несовместим с текущей конфигурацией.",
                            error_type, mod_id
                        ),
                        severity: Severity::Critical,
                        category: ProblemCategory::ModConflict,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Проверить совместимость модов".into(),
                                description: "Убедитесь что все моды поддерживают вашу версию Minecraft и загрузчика".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 60,
                            },
                            Solution {
                                title: "Отключить проблемные моды".into(),
                                description: "Попробуйте отключать моды по одному для поиска конфликта".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Hard,
                                success_rate: 80,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: if mod_id != "unknown" { vec![mod_id.to_string()] } else { vec![] },
                    })
                },
            },

            // MixinTargetAlreadyLoadedException
            ErrorPattern {
                pattern: Regex::new(r"(?i)Mixin(?:TargetAlreadyLoaded|PriorityOverlap)Exception.*?target\s+([a-zA-Z0-9_.]+)").unwrap(),
                handler: |caps, line, line_num| {
                    let target_class = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");

                    Some(DetectedProblem {
                        id: format!("mixin_already_loaded_{}", line_num),
                        title: "Mixin конфликт: класс уже загружен".into(),
                        description: format!(
                            "Класс '{}' был загружен до применения Mixin. Обычно это происходит когда два мода пытаются модифицировать один класс.",
                            target_class
                        ),
                        severity: Severity::Critical,
                        category: ProblemCategory::ModConflict,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Найти конфликтующие моды".into(),
                                description: "Два мода пытаются изменить один и тот же код. Отключите один из них.".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Hard,
                                success_rate: 70,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![],
                    })
                },
            },

            // Generic Mixin failure (catch-all)
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:Mixin\s+(?:config|injection|apply)|SpongePowered.*Mixin).*(?:failed|error|exception|unable)").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("mixin_generic_{}", line_num),
                        title: "Ошибка Mixin".into(),
                        description: "Произошла ошибка в системе Mixin. Это обычно означает несовместимость модов.".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::ModConflict,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Обновить все моды".into(),
                                description: "Убедитесь что используете последние версии модов".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 50,
                            },
                            Solution {
                                title: "Проверить совместимость".into(),
                                description: "Убедитесь что моды поддерживают вашу версию Minecraft".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 60,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![],
                    })
                },
            },

            // Generic requires pattern (catch-all for library dependencies)
            ErrorPattern {
                pattern: Regex::new(r#"(?i)(?:requires|depends on|needs).*mod[:\s]+['"]?([a-zA-Z0-9_\-]+)['"]?"#).unwrap(),
                handler: |caps, line, line_num| {
                    let mod_id = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");
                    Some(DetectedProblem {
                        id: format!("generic_dep_{}", line_num),
                        title: format!("Требуется мод: {}", mod_id),
                        description: format!("Отсутствует зависимость: {}", mod_id),
                        severity: Severity::Error,
                        category: ProblemCategory::MissingDependency,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: format!("Установить {}", mod_id),
                                description: "Найдите мод на Modrinth или CurseForge".into(),
                                auto_fix: Some(AutoFix::DownloadMod {
                                    name: mod_id.to_string(),
                                    source: "modrinth".into(),
                                    project_id: mod_id.to_string(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 80,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![],
                    })
                },
            },

            // === ПОПУЛЯРНЫЕ МОДЫ ===

            // Applied Energistics 2 - Channel issues
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:appliedenergistics2|ae2).*(?:channel|network|grid).*(?:error|overflow|limit)").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("ae2_channels_{}", line_num),
                        title: "AE2: Проблема с каналами".into(),
                        description: "Превышен лимит каналов в ME сети. Используйте Dense Cable или P2P Tunnels.".into(),
                        severity: Severity::Warning,
                        category: ProblemCategory::ConfigError,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Использовать Dense Cable".into(),
                                description: "Dense Cable поддерживает до 32 каналов".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 95,
                            },
                        ],
                        docs_links: vec!["https://guide.appliedenergistics.org/".into()],
                        related_mods: vec!["ae2".into()],
                    })
                },
            },

            // Metaspace OOM
            ErrorPattern {
                pattern: Regex::new(r"(?i)java\.lang\.OutOfMemoryError.*Metaspace").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("metaspace_oom_{}", line_num),
                        title: "OutOfMemoryError: Metaspace".into(),
                        description: "Закончилась память Metaspace (для классов Java). Обычно из-за слишком многих модов.".into(),
                        severity: Severity::Critical,
                        category: ProblemCategory::MemoryIssue,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Увеличить MaxMetaspaceSize".into(),
                                description: "Добавьте JVM аргумент: -XX:MaxMetaspaceSize=512M".into(),
                                auto_fix: Some(AutoFix::ChangeJvmArg {
                                    old_arg: None,
                                    new_arg: "-XX:MaxMetaspaceSize=512M".into(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 90,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![],
                    })
                },
            },

            // GC Overhead
            ErrorPattern {
                pattern: Regex::new(r"(?i)java\.lang\.OutOfMemoryError.*GC overhead limit exceeded").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("gc_overhead_{}", line_num),
                        title: "GC Overhead Limit Exceeded".into(),
                        description: "JVM тратит более 98% времени на сборку мусора. Нужно больше памяти.".into(),
                        severity: Severity::Critical,
                        category: ProblemCategory::MemoryIssue,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Увеличить RAM".into(),
                                description: "Выделите минимум 6-8GB памяти".into(),
                                auto_fix: Some(AutoFix::IncreaseRam { recommended_mb: 6144 }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 95,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![],
                    })
                },
            },

            // DataPack errors (1.20+)
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:data[\s_-]?pack|datapack).*(?:failed|error|invalid|corrupt)").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("datapack_error_{}", line_num),
                        title: "Ошибка DataPack".into(),
                        description: "Повреждённый или несовместимый DataPack (Minecraft 1.20+)".into(),
                        severity: Severity::Warning,
                        category: ProblemCategory::ConfigError,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Проверить DataPacks".into(),
                                description: "Удалите или обновите проблемный DataPack из saves/world/datapacks/".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 85,
                            },
                        ],
                        docs_links: vec!["https://minecraft.wiki/w/Data_pack".into()],
                        related_mods: vec![],
                    })
                },
            },

            // ============ РАСШИРЕННАЯ БАЗА ЗНАНИЙ ============
            // ============ JAVA RUNTIME ERRORS ============

            // Direct ByteBuffer allocation failure
            ErrorPattern {
                pattern: Regex::new(r"(?i)java\.lang\.OutOfMemoryError.*(?:Direct buffer memory|Direct ByteBuffer)").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("direct_memory_oom_{}", line_num),
                        title: "Нехватка Direct Memory".into(),
                        description: "Закончилась память Direct Buffer. Часто из-за шейдеров или модов с тяжёлой графикой.".into(),
                        severity: Severity::Critical,
                        category: ProblemCategory::MemoryIssue,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Увеличить MaxDirectMemorySize".into(),
                                description: "Добавьте JVM аргумент: -XX:MaxDirectMemorySize=512M".into(),
                                auto_fix: Some(AutoFix::ChangeJvmArg {
                                    old_arg: None,
                                    new_arg: "-XX:MaxDirectMemorySize=512M".into(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 85,
                            },
                            Solution {
                                title: "Отключить шейдеры".into(),
                                description: "Шейдеры потребляют много Direct Memory".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 90,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![],
                    })
                },
            },

            // Unable to allocate memory for array
            ErrorPattern {
                pattern: Regex::new(r"(?i)java\.lang\.OutOfMemoryError.*(?:Requested array size exceeds VM limit|requested (\d+) bytes)").unwrap(),
                handler: |caps, line, line_num| {
                    let size = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");
                    Some(DetectedProblem {
                        id: format!("array_alloc_oom_{}", line_num),
                        title: "Невозможно создать массив".into(),
                        description: format!("JVM не может выделить память для массива (запрошено {} байт). Возможно баг в моде.", size),
                        severity: Severity::Critical,
                        category: ProblemCategory::MemoryIssue,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Увеличить RAM и включить CompressedOops".into(),
                                description: "Добавьте: -XX:+UseCompressedOops и увеличьте -Xmx".into(),
                                auto_fix: Some(AutoFix::IncreaseRam { recommended_mb: 8192 }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 70,
                            },
                            Solution {
                                title: "Искать баг в моде".into(),
                                description: "Посмотрите stack trace чтобы найти виновный мод".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Hard,
                                success_rate: 50,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![],
                    })
                },
            },

            // Java heap space
            ErrorPattern {
                pattern: Regex::new(r"(?i)java\.lang\.OutOfMemoryError.*Java heap space").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("heap_oom_{}", line_num),
                        title: "Java Heap Space исчерпано".into(),
                        description: "Закончилась память кучи Java. Нужно выделить больше RAM.".into(),
                        severity: Severity::Critical,
                        category: ProblemCategory::MemoryIssue,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Увеличить -Xmx".into(),
                                description: "Выделите минимум 4-6GB RAM для модпаков".into(),
                                auto_fix: Some(AutoFix::IncreaseRam { recommended_mb: 6144 }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 95,
                            },
                            Solution {
                                title: "Использовать G1GC".into(),
                                description: "Добавьте: -XX:+UseG1GC -XX:G1HeapRegionSize=16M".into(),
                                auto_fix: Some(AutoFix::ChangeJvmArg {
                                    old_arg: None,
                                    new_arg: "-XX:+UseG1GC -XX:G1HeapRegionSize=16M".into(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 80,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![],
                    })
                },
            },

            // IllegalAccessError
            ErrorPattern {
                pattern: Regex::new(r"(?i)java\.lang\.IllegalAccessError.*?(?:tried to access|cannot access).*?([a-zA-Z0-9_.]+)").unwrap(),
                handler: |caps, line, line_num| {
                    let class_name = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");
                    Some(DetectedProblem {
                        id: format!("illegal_access_{}", line_num),
                        title: "IllegalAccessError".into(),
                        description: format!("Мод пытается получить доступ к закрытому классу '{}'. Версии несовместимы.", class_name),
                        severity: Severity::Error,
                        category: ProblemCategory::VersionMismatch,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Обновить моды".into(),
                                description: "Установите совместимые версии модов".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 80,
                            },
                            Solution {
                                title: "Добавить --add-opens".into(),
                                description: "Для Java 16+ может потребоваться: --add-opens java.base/java.lang=ALL-UNNAMED".into(),
                                auto_fix: Some(AutoFix::ChangeJvmArg {
                                    old_arg: None,
                                    new_arg: "--add-opens java.base/java.lang=ALL-UNNAMED".into(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 60,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![],
                    })
                },
            },

            // VerifyError
            ErrorPattern {
                pattern: Regex::new(r"(?i)java\.lang\.VerifyError.*?([a-zA-Z0-9_.]+)").unwrap(),
                handler: |caps, line, line_num| {
                    let class_name = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");
                    Some(DetectedProblem {
                        id: format!("verify_error_{}", line_num),
                        title: "VerifyError: повреждённый класс".into(),
                        description: format!("Класс '{}' имеет неверный байткод. JAR файл повреждён или несовместим.", class_name),
                        severity: Severity::Critical,
                        category: ProblemCategory::CorruptedFile,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Переустановить мод".into(),
                                description: "Удалите и заново скачайте проблемный мод".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 90,
                            },
                            Solution {
                                title: "Проверить версию Java".into(),
                                description: "Убедитесь что используете правильную версию Java".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 70,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![],
                    })
                },
            },

            // ClassCastException
            ErrorPattern {
                pattern: Regex::new(r"(?i)java\.lang\.ClassCastException.*?([a-zA-Z0-9_.]+).*cannot be cast to.*?([a-zA-Z0-9_.]+)").unwrap(),
                handler: |caps, line, line_num| {
                    let from_class = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");
                    let to_class = caps.get(2).map(|m| m.as_str()).unwrap_or("unknown");
                    Some(DetectedProblem {
                        id: format!("class_cast_{}", line_num),
                        title: "ClassCastException".into(),
                        description: format!("Несовместимые типы: {} нельзя преобразовать в {}. Конфликт модов.", from_class, to_class),
                        severity: Severity::Error,
                        category: ProblemCategory::ModConflict,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Найти конфликт модов".into(),
                                description: "Два мода создают несовместимые классы".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 70,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![],
                    })
                },
            },

            // NullPointerException with context
            ErrorPattern {
                pattern: Regex::new(r"(?i)java\.lang\.NullPointerException.*?(?:Cannot invoke.*?because.*?is null|at\s+([a-zA-Z0-9_.]+))").unwrap(),
                handler: |caps, line, line_num| {
                    let context = caps.get(1).map(|m| m.as_str());
                    let mod_id = context.and_then(|c| {
                        let analysis = analyze_class_path(c);
                        match analysis {
                            ClassAnalysisResult::Mod(id) => Some(id),
                            _ => None
                        }
                    });

                    Some(DetectedProblem {
                        id: format!("npe_{}", line_num),
                        title: if let Some(ref id) = mod_id {
                            format!("NullPointerException в моде: {}", id)
                        } else {
                            "NullPointerException".into()
                        },
                        description: "Баг в моде - попытка использовать null объект.".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::ModConflict,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Обновить мод".into(),
                                description: "Скорее всего баг исправлен в новой версии".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 70,
                            },
                            Solution {
                                title: "Сообщить разработчику".into(),
                                description: "Отправьте crash log разработчику мода".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 50,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: mod_id.map(|id| vec![id]).unwrap_or_default(),
                    })
                },
            },

            // IndexOutOfBoundsException
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:ArrayIndexOutOfBoundsException|IndexOutOfBoundsException|StringIndexOutOfBoundsException).*?(-?\d+)").unwrap(),
                handler: |caps, line, line_num| {
                    let index = caps.get(1).map(|m| m.as_str()).unwrap_or("?");
                    Some(DetectedProblem {
                        id: format!("index_oob_{}", line_num),
                        title: "IndexOutOfBoundsException".into(),
                        description: format!("Баг в моде - попытка доступа по индексу {}. Обычно из-за повреждённых данных.", index),
                        severity: Severity::Error,
                        category: ProblemCategory::ModConflict,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Обновить мод".into(),
                                description: "Баг скорее всего исправлен в новой версии".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 70,
                            },
                            Solution {
                                title: "Проверить мир на повреждения".into(),
                                description: "Повреждённые данные в мире могут вызывать такие ошибки".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 50,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![],
                    })
                },
            },

            // IllegalStateException
            ErrorPattern {
                pattern: Regex::new(r"(?i)java\.lang\.IllegalStateException.*?([^\n]{10,100})").unwrap(),
                handler: |caps, line, line_num| {
                    let message = caps.get(1).map(|m| m.as_str()).unwrap_or("Unknown state error");
                    Some(DetectedProblem {
                        id: format!("illegal_state_{}", line_num),
                        title: "IllegalStateException".into(),
                        description: format!("Недопустимое состояние: {}. Обычно конфликт модов или баг.", message),
                        severity: Severity::Error,
                        category: ProblemCategory::ModConflict,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Проверить совместимость модов".into(),
                                description: "Убедитесь что все моды совместимы между собой и версией игры".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 60,
                            },
                            Solution {
                                title: "Отключить проблемные моды".into(),
                                description: "Попробуйте отключить последние добавленные моды по одному".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 70,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![],
                    })
                },
            },

            // UnsatisfiedLinkError (native libraries)
            ErrorPattern {
                pattern: Regex::new(r"(?i)java\.lang\.UnsatisfiedLinkError.*?(?:no\s+([a-zA-Z0-9_]+)\s+in|can't load library)").unwrap(),
                handler: |caps, line, line_num| {
                    let lib = caps.get(1).map(|m| m.as_str()).unwrap_or("native library");
                    Some(DetectedProblem {
                        id: format!("native_lib_{}", line_num),
                        title: format!("Отсутствует native библиотека: {}", lib),
                        description: "Не удалось загрузить native библиотеку. Обычно из-за неправильной архитектуры или отсутствующих зависимостей.".into(),
                        severity: Severity::Critical,
                        category: ProblemCategory::JavaIssue,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Переустановить Java".into(),
                                description: "Скачайте Java с официального сайта для вашей ОС".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 80,
                            },
                            Solution {
                                title: "Установить Visual C++ Redistributable".into(),
                                description: "На Windows могут потребоваться VC++ Redistributable".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 70,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![],
                    })
                },
            },

            // ============ FORGE SPECIFIC ERRORS ============

            // Forge: Coremods error
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:Coremod|coremod).*(?:error|fail|crash|exception).*?([a-zA-Z0-9_\-]+)").unwrap(),
                handler: |caps, line, line_num| {
                    let coremod = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");
                    Some(DetectedProblem {
                        id: format!("coremod_error_{}", line_num),
                        title: format!("Ошибка Coremod: {}", coremod),
                        description: "Coremod (мод с трансформациями) вызвал ошибку. Это часто критичные моды.".into(),
                        severity: Severity::Critical,
                        category: ProblemCategory::ModConflict,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Удалить coremod".into(),
                                description: "Временно удалите проблемный coremod".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 90,
                            },
                            Solution {
                                title: "Обновить coremod".into(),
                                description: "Установите последнюю версию".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 70,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![coremod.to_string()],
                    })
                },
            },

            // Forge: AccessTransformer error
            // NOTE: Avoid matching generic "AT" - it causes false positives with Realms logs
            // Only match full "AccessTransformer" or "Access Transformer" words
            ErrorPattern {
                pattern: Regex::new(r"(?i)Access\s*Transform(?:er)?.*(?:error|fail|invalid|exception|unable).*?([a-zA-Z0-9_.]+)").unwrap(),
                handler: |caps, line, line_num| {
                    let target = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");
                    Some(DetectedProblem {
                        id: format!("access_transformer_{}", line_num),
                        title: "Ошибка Access Transformer".into(),
                        description: format!("AT не смог изменить доступ к {}. Мод несовместим с версией Forge.", target),
                        severity: Severity::Error,
                        category: ProblemCategory::ModConflict,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Обновить мод".into(),
                                description: "Мод требует обновления для этой версии Forge".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 80,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![],
                    })
                },
            },

            // Forge: Registry error
            ErrorPattern {
                pattern: Regex::new(r"(?i)Registry.*(?:error|exception|fail).*?([a-z0-9_]+:[a-z0-9_/]+)").unwrap(),
                handler: |caps, line, line_num| {
                    let registry_entry = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");
                    let mod_id = registry_entry.split(':').next().unwrap_or("unknown");

                    Some(DetectedProblem {
                        id: format!("registry_error_{}", line_num),
                        title: format!("Ошибка Registry: {}", registry_entry),
                        description: format!("Не удалось зарегистрировать {}. Возможно мод {} повреждён.", registry_entry, mod_id),
                        severity: Severity::Error,
                        category: ProblemCategory::ModConflict,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Переустановить мод".into(),
                                description: format!("Переустановите мод {}", mod_id),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 80,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![mod_id.to_string()],
                    })
                },
            },

            // Forge: Event bus error
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:Event\s*bus|EventBus).*(?:error|exception|crash)").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("event_bus_error_{}", line_num),
                        title: "Ошибка Event Bus".into(),
                        description: "Ошибка в системе событий Forge. Мод некорректно обрабатывает события.".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::ModConflict,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Найти мод по stack trace".into(),
                                description: "Посмотрите stack trace чтобы найти виновный мод".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 70,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![],
                    })
                },
            },

            // ============ FABRIC SPECIFIC ERRORS ============

            // Fabric: Entrypoint exception
            ErrorPattern {
                pattern: Regex::new(r"(?i)Could not execute entrypoint stage '(\w+)'.*?([a-z0-9_\-]+)").unwrap(),
                handler: |caps, line, line_num| {
                    let stage = caps.get(1).map(|m| m.as_str()).unwrap_or("main");
                    let mod_id = caps.get(2).map(|m| m.as_str()).unwrap_or("unknown");

                    Some(DetectedProblem {
                        id: format!("fabric_entrypoint_{}", line_num),
                        title: format!("Fabric: {} не смог запуститься", mod_id),
                        description: format!("Мод {} упал на стадии '{}'. Вероятно отсутствует зависимость.", mod_id, stage),
                        severity: Severity::Critical,
                        category: ProblemCategory::CrashDuringStartup,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Проверить зависимости".into(),
                                description: format!("Убедитесь что все зависимости {} установлены", mod_id),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 80,
                            },
                            Solution {
                                title: format!("Удалить {}", mod_id),
                                description: "Временно удалите мод".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 100,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![mod_id.to_string()],
                    })
                },
            },

            // Fabric: Incompatible mod set
            ErrorPattern {
                pattern: Regex::new(r"(?i)Incompatible mod set.*?([a-z0-9_\-]+).*(?:conflicts|incompatible).*?([a-z0-9_\-]+)").unwrap(),
                handler: |caps, line, line_num| {
                    let mod1 = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");
                    let mod2 = caps.get(2).map(|m| m.as_str()).unwrap_or("unknown");

                    Some(DetectedProblem {
                        id: format!("fabric_incompatible_{}", line_num),
                        title: format!("Несовместимые моды: {} и {}", mod1, mod2),
                        description: format!("Моды {} и {} конфликтуют. Нужно удалить один из них.", mod1, mod2),
                        severity: Severity::Critical,
                        category: ProblemCategory::ModConflict,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: format!("Удалить {}", mod1),
                                description: format!("Удалите {} если {} важнее", mod1, mod2),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 100,
                            },
                            Solution {
                                title: format!("Удалить {}", mod2),
                                description: format!("Удалите {} если {} важнее", mod2, mod1),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 100,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![mod1.to_string(), mod2.to_string()],
                    })
                },
            },

            // ============ NEOFORGE SPECIFIC ERRORS ============

            // NeoForge: Module error
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:net\.neoforged|neoforge).*(?:module|ModuleLayer).*(?:error|fail|exception)").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("neoforge_module_{}", line_num),
                        title: "NeoForge: Ошибка модульной системы".into(),
                        description: "Ошибка модульной системы Java. Мод несовместим с NeoForge.".into(),
                        severity: Severity::Critical,
                        category: ProblemCategory::ModConflict,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Обновить мод для NeoForge".into(),
                                description: "Убедитесь что мод поддерживает NeoForge (не только Forge)".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 80,
                            },
                        ],
                        docs_links: vec!["https://neoforged.net/".into()],
                        related_mods: vec![],
                    })
                },
            },

            // ============ QUILT SPECIFIC ERRORS ============

            // Quilt: QSL missing
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:quilt|qsl).*(?:missing|requires).*quilt[\s_-]?standard[\s_-]?libraries").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("qsl_missing_{}", line_num),
                        title: "Требуется Quilt Standard Libraries".into(),
                        description: "Мод требует QSL (Quilt Standard Libraries).".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::MissingDependency,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Установить QSL".into(),
                                description: "Скачайте Quilt Standard Libraries".into(),
                                auto_fix: Some(AutoFix::DownloadMod {
                                    name: "QSL".into(),
                                    source: "modrinth".into(),
                                    project_id: "qsl".into(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 95,
                            },
                        ],
                        docs_links: vec!["https://modrinth.com/mod/qsl".into()],
                        related_mods: vec!["qsl".into()],
                    })
                },
            },

            // ============ PERFORMANCE MODS CONFLICTS ============

            // OptiFine + Sodium conflict
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:optifine.*sodium|sodium.*optifine|OptiFine.*incompatible|Sodium.*OptiFine)").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("optifine_sodium_{}", line_num),
                        title: "Конфликт OptiFine и Sodium".into(),
                        description: "OptiFine и Sodium НЕСОВМЕСТИМЫ. Используйте только один из них.".into(),
                        severity: Severity::Critical,
                        category: ProblemCategory::ModConflict,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Удалить OptiFine".into(),
                                description: "Sodium + Iris обеспечивают лучшую производительность и совместимость".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 100,
                            },
                            Solution {
                                title: "Удалить Sodium".into(),
                                description: "Если нужны функции OptiFine - удалите Sodium".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 100,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec!["optifine".into(), "sodium".into()],
                    })
                },
            },

            // Embeddium (Forge Sodium port)
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:embeddium|rubidium).*(?:error|crash|conflict)").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("embeddium_error_{}", line_num),
                        title: "Ошибка Embeddium/Rubidium".into(),
                        description: "Конфликт с Embeddium/Rubidium (Sodium для Forge). Некоторые моды несовместимы.".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::ModConflict,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Установить Embeddium Extras".into(),
                                description: "Установите совместимые дополнения для Embeddium".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 70,
                            },
                            Solution {
                                title: "Удалить конфликтующий мод".into(),
                                description: "Найдите и удалите несовместимый мод".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Hard,
                                success_rate: 80,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec!["embeddium".into(), "rubidium".into()],
                    })
                },
            },

            // ============ POPULAR TECH MODS ============

            // Mekanism errors
            ErrorPattern {
                pattern: Regex::new(r"(?i)mekanism.*(?:exception|error|crash|fail)").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("mekanism_error_{}", line_num),
                        title: "Ошибка Mekanism".into(),
                        description: "Mekanism столкнулся с ошибкой. Проверьте совместимость версий.".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::ModConflict,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Обновить Mekanism".into(),
                                description: "Установите последнюю версию Mekanism и аддонов".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 70,
                            },
                            Solution {
                                title: "Проверить рецепты".into(),
                                description: "Конфликты рецептов от CraftTweaker/KubeJS могут ломать Mekanism".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 60,
                            },
                        ],
                        docs_links: vec!["https://wiki.aidancbrady.com/wiki/Mekanism".into()],
                        related_mods: vec!["mekanism".into()],
                    })
                },
            },

            // Thermal Series
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:thermal|cofh).*(?:exception|error|crash)").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("thermal_error_{}", line_num),
                        title: "Ошибка Thermal".into(),
                        description: "Thermal Series столкнулся с ошибкой.".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::ModConflict,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Проверить CoFH Core".into(),
                                description: "Убедитесь что CoFH Core установлен и обновлён".into(),
                                auto_fix: Some(AutoFix::DownloadMod {
                                    name: "CoFH Core".into(),
                                    source: "modrinth".into(),
                                    project_id: "cofh-core".into(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 80,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec!["thermal".into(), "cofh_core".into()],
                    })
                },
            },

            // Immersive Engineering
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:immersive[\s_-]?engineering|blusunrize).*(?:exception|error|crash)").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("ie_error_{}", line_num),
                        title: "Ошибка Immersive Engineering".into(),
                        description: "Immersive Engineering столкнулся с ошибкой.".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::ModConflict,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Обновить IE".into(),
                                description: "Установите последнюю версию Immersive Engineering".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 70,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec!["immersiveengineering".into()],
                    })
                },
            },

            // ============ MAGIC MODS ============

            // Botania errors
            ErrorPattern {
                pattern: Regex::new(r"(?i)vazkii\.botania.*(?:exception|error|crash)").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("botania_error_{}", line_num),
                        title: "Ошибка Botania".into(),
                        description: "Botania столкнулся с ошибкой.".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::ModConflict,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Проверить Patchouli".into(),
                                description: "Botania требует Patchouli для книги гайда".into(),
                                auto_fix: Some(AutoFix::DownloadMod {
                                    name: "Patchouli".into(),
                                    source: "modrinth".into(),
                                    project_id: "patchouli".into(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 80,
                            },
                        ],
                        docs_links: vec!["https://botaniamod.net/".into()],
                        related_mods: vec!["botania".into()],
                    })
                },
            },

            // Ars Nouveau
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:ars[\s_-]?nouveau|arsnouveau).*(?:exception|error|crash)").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("ars_nouveau_error_{}", line_num),
                        title: "Ошибка Ars Nouveau".into(),
                        description: "Ars Nouveau столкнулся с ошибкой.".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::ModConflict,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Проверить GeckoLib".into(),
                                description: "Ars Nouveau требует GeckoLib для анимаций".into(),
                                auto_fix: Some(AutoFix::DownloadMod {
                                    name: "GeckoLib".into(),
                                    source: "modrinth".into(),
                                    project_id: "geckolib".into(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 80,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec!["ars_nouveau".into()],
                    })
                },
            },

            // ============ WORLD GENERATION ============

            // Biome conflict
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:biome|worldgen).*(?:conflict|duplicate|overlap|error)").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("biome_conflict_{}", line_num),
                        title: "Конфликт биомов".into(),
                        description: "Конфликт генерации мира между модами.".into(),
                        severity: Severity::Warning,
                        category: ProblemCategory::ModConflict,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Проверить TerraBlender".into(),
                                description: "Моды с биомами часто требуют TerraBlender".into(),
                                auto_fix: Some(AutoFix::DownloadMod {
                                    name: "TerraBlender".into(),
                                    source: "modrinth".into(),
                                    project_id: "terrablender".into(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 70,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec!["terrablender".into()],
                    })
                },
            },

            // Dimension error
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:dimension|DimensionType).*(?:error|fail|missing|invalid)").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("dimension_error_{}", line_num),
                        title: "Ошибка измерения".into(),
                        description: "Проблема с регистрацией или загрузкой измерения.".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::ModConflict,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Проверить моды измерений".into(),
                                description: "Убедитесь что моды добавляющие измерения обновлены".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 70,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![],
                    })
                },
            },

            // Structure generation error
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:structure|feature|Structure\w+).*(?:failed to place|generation.*error|couldn't generate)").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("structure_gen_{}", line_num),
                        title: "Ошибка генерации структуры".into(),
                        description: "Не удалось сгенерировать структуру. Обычно не критично.".into(),
                        severity: Severity::Warning,
                        category: ProblemCategory::ConfigError,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Игнорировать".into(),
                                description: "Обычно это предупреждение не влияет на игру".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 90,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![],
                    })
                },
            },

            // ============ RESOURCE LOADING ============

            // Missing texture
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:missing|unable to load).*texture.*?([a-z0-9_]+:[a-z0-9_/]+)").unwrap(),
                handler: |caps, line, line_num| {
                    let texture = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");
                    let mod_id = texture.split(':').next().unwrap_or("unknown");

                    Some(DetectedProblem {
                        id: format!("missing_texture_{}", line_num),
                        title: format!("Отсутствует текстура: {}", texture),
                        description: format!("Текстура не найдена. Мод {} возможно неполностью установлен.", mod_id),
                        severity: Severity::Warning,
                        category: ProblemCategory::CorruptedFile,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Переустановить мод".into(),
                                description: format!("Переустановите мод {}", mod_id),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 90,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![mod_id.to_string()],
                    })
                },
            },

            // Missing model
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:missing|unable to load).*model.*?([a-z0-9_]+:[a-z0-9_/]+)").unwrap(),
                handler: |caps, line, line_num| {
                    let model = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");
                    let mod_id = model.split(':').next().unwrap_or("unknown");

                    Some(DetectedProblem {
                        id: format!("missing_model_{}", line_num),
                        title: format!("Отсутствует модель: {}", model),
                        description: format!("3D модель не найдена. Проверьте мод {}.", mod_id),
                        severity: Severity::Warning,
                        category: ProblemCategory::CorruptedFile,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Переустановить мод".into(),
                                description: format!("Переустановите мод {}", mod_id),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 90,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![mod_id.to_string()],
                    })
                },
            },

            // Missing sound
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:missing|unable to load).*sound.*?([a-z0-9_]+:[a-z0-9_/\.]+)").unwrap(),
                handler: |caps, line, line_num| {
                    let sound = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");
                    let mod_id = sound.split(':').next().unwrap_or("unknown");

                    Some(DetectedProblem {
                        id: format!("missing_sound_{}", line_num),
                        title: format!("Отсутствует звук: {}", sound),
                        description: "Звуковой файл не найден. Игра может работать без него.".into(),
                        severity: Severity::Info,
                        category: ProblemCategory::AudioError,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Переустановить мод".into(),
                                description: format!("Переустановите мод {}", mod_id),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 80,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![mod_id.to_string()],
                    })
                },
            },

            // Recipe conflict/error
            ErrorPattern {
                pattern: Regex::new(r"(?i)recipe.*?([a-z0-9_]+:[a-z0-9_/]+).*(?:conflict|duplicate|error|invalid)").unwrap(),
                handler: |caps, line, line_num| {
                    let recipe = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");
                    let mod_id = recipe.split(':').next().unwrap_or("unknown");

                    Some(DetectedProblem {
                        id: format!("recipe_error_{}", line_num),
                        title: format!("Ошибка рецепта: {}", recipe),
                        description: format!("Проблема с рецептом из мода {}.", mod_id),
                        severity: Severity::Warning,
                        category: ProblemCategory::ConfigError,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Обновить мод".into(),
                                description: format!("Обновите мод {}", mod_id),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 70,
                            },
                            Solution {
                                title: "Проверить KubeJS/CraftTweaker".into(),
                                description: "Скрипты рецептов могут вызывать конфликты".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 60,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![mod_id.to_string()],
                    })
                },
            },

            // ============ LANGUAGE/LOCALIZATION ============

            // Missing lang key
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:missing|unknown).*(?:lang|translation|localization).*key.*?([a-z0-9_.]+)").unwrap(),
                handler: |caps, line, line_num| {
                    let key = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");

                    Some(DetectedProblem {
                        id: format!("missing_lang_{}", line_num),
                        title: "Отсутствует перевод".into(),
                        description: format!("Ключ локализации '{}' не найден. Косметический баг.", key),
                        severity: Severity::Info,
                        category: ProblemCategory::ConfigError,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Игнорировать".into(),
                                description: "Отсутствие перевода не влияет на геймплей".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 100,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![],
                    })
                },
            },

            // ============ SERVER SPECIFIC ============

            // Server overload
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:Can't keep up|server overloaded|running (\d+)ms behind)").unwrap(),
                handler: |caps, line, line_num| {
                    let behind = caps.get(1).map(|m| m.as_str()).unwrap_or("?");

                    Some(DetectedProblem {
                        id: format!("server_overload_{}", line_num),
                        title: format!("Сервер перегружен ({}ms)", behind),
                        description: "Сервер не успевает обрабатывать тики. TPS упал.".into(),
                        severity: Severity::Warning,
                        category: ProblemCategory::MemoryIssue,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Увеличить RAM сервера".into(),
                                description: "Выделите больше памяти серверу".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 60,
                            },
                            Solution {
                                title: "Использовать Spark".into(),
                                description: "Установите Spark профайлер для поиска лагов".into(),
                                auto_fix: Some(AutoFix::DownloadMod {
                                    name: "Spark".into(),
                                    source: "modrinth".into(),
                                    project_id: "spark".into(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 70,
                            },
                        ],
                        docs_links: vec!["https://spark.lucko.me/".into()],
                        related_mods: vec![],
                    })
                },
            },

            // Connection timeout
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:connection|client).*(?:timed out|timeout|disconnect)").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("connection_timeout_{}", line_num),
                        title: "Таймаут соединения".into(),
                        description: "Клиент или сервер не ответил вовремя.".into(),
                        severity: Severity::Warning,
                        category: ProblemCategory::NetworkError,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Проверить сеть".into(),
                                description: "Убедитесь в стабильности интернет-соединения".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 50,
                            },
                            Solution {
                                title: "Увеличить таймаут".into(),
                                description: "Для модпаков может потребоваться увеличить connection-timeout в настройках".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 70,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![],
                    })
                },
            },

            // ============ CraftTweaker/ZenScript ERRORS ============

            // CraftTweaker script error
            ErrorPattern {
                pattern: Regex::new(r"(?i)\[CraftTweaker\].*(?:Error|Exception).*?([a-z0-9_/\-]+\.zs)(?::(\d+))?").unwrap(),
                handler: |caps, line, line_num| {
                    let script = caps.get(1).map(|m| m.as_str()).unwrap_or("script.zs");
                    let script_line = caps.get(2).map(|m| m.as_str()).unwrap_or("?");

                    Some(DetectedProblem {
                        id: format!("crafttweaker_error_{}", line_num),
                        title: format!("CraftTweaker: ошибка в {}", script),
                        description: format!("Ошибка в скрипте {} на строке {}", script, script_line),
                        severity: Severity::Error,
                        category: ProblemCategory::ConfigError,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Исправить скрипт".into(),
                                description: format!("Откройте scripts/{} и исправьте синтаксис", script),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 90,
                            },
                        ],
                        docs_links: vec!["https://docs.blamejared.com/".into()],
                        related_mods: vec!["crafttweaker".into()],
                    })
                },
            },

            // ============ ACCESS WIDENER (Fabric) ============

            // Access Widener error
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:access[\s_-]?widener|accesswidener).*(?:error|fail|invalid)").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("access_widener_{}", line_num),
                        title: "Ошибка Access Widener".into(),
                        description: "Мод не смог расширить доступ к классу. Несовместимость версий.".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::ModConflict,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Обновить мод".into(),
                                description: "Мод несовместим с текущей версией Minecraft/Fabric".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 80,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![],
                    })
                },
            },

            // ============ ADDITIONAL POPULAR LIBRARIES ============

            // Resourceful Lib
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:requires|needs|missing).*resourceful[\s_-]?lib").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("resourcefullib_missing_{}", line_num),
                        title: "Требуется Resourceful Lib".into(),
                        description: "Мод требует библиотеку Resourceful Lib".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::MissingDependency,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Установить Resourceful Lib".into(),
                                description: "Скачайте Resourceful Lib".into(),
                                auto_fix: Some(AutoFix::DownloadMod {
                                    name: "Resourceful Lib".into(),
                                    source: "modrinth".into(),
                                    project_id: "resourceful-lib".into(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 95,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec!["resourceful-lib".into()],
                    })
                },
            },

            // Geckolib 4 (новая версия)
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:requires|needs|missing).*azurelib").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("azurelib_missing_{}", line_num),
                        title: "Требуется AzureLib".into(),
                        description: "Мод требует AzureLib (форк GeckoLib).".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::MissingDependency,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Установить AzureLib".into(),
                                description: "Скачайте AzureLib".into(),
                                auto_fix: Some(AutoFix::DownloadMod {
                                    name: "AzureLib".into(),
                                    source: "modrinth".into(),
                                    project_id: "azurelib".into(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 95,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec!["azurelib".into()],
                    })
                },
            },

            // Playeranimator
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:requires|needs|missing).*player[\s_-]?animator").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("playeranimator_missing_{}", line_num),
                        title: "Требуется PlayerAnimator".into(),
                        description: "Мод требует библиотеку PlayerAnimator.".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::MissingDependency,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Установить PlayerAnimator".into(),
                                description: "Скачайте PlayerAnimator".into(),
                                auto_fix: Some(AutoFix::DownloadMod {
                                    name: "PlayerAnimator".into(),
                                    source: "modrinth".into(),
                                    project_id: "playeranimator".into(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 95,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec!["playeranimator".into()],
                    })
                },
            },

            // Citadel (Alex's Mobs dependency)
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:requires|needs|missing).*citadel").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("citadel_missing_{}", line_num),
                        title: "Требуется Citadel".into(),
                        description: "Мод (вероятно Alex's Mobs) требует библиотеку Citadel.".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::MissingDependency,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Установить Citadel".into(),
                                description: "Скачайте Citadel".into(),
                                auto_fix: Some(AutoFix::DownloadMod {
                                    name: "Citadel".into(),
                                    source: "modrinth".into(),
                                    project_id: "citadel".into(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 95,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec!["citadel".into(), "alexsmobs".into()],
                    })
                },
            },

            // Caelus API (Elytra rings etc)
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:requires|needs|missing).*caelus").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("caelus_missing_{}", line_num),
                        title: "Требуется Caelus API".into(),
                        description: "Мод требует Caelus API для работы с полётом/элитрами.".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::MissingDependency,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Установить Caelus API".into(),
                                description: "Скачайте Caelus API".into(),
                                auto_fix: Some(AutoFix::DownloadMod {
                                    name: "Caelus API".into(),
                                    source: "modrinth".into(),
                                    project_id: "caelus".into(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 95,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec!["caelus".into()],
                    })
                },
            },

            // MidnightLib
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:requires|needs|missing).*midnight[\s_-]?lib").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("midnightlib_missing_{}", line_num),
                        title: "Требуется MidnightLib".into(),
                        description: "Мод требует библиотеку MidnightLib.".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::MissingDependency,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Установить MidnightLib".into(),
                                description: "Скачайте MidnightLib".into(),
                                auto_fix: Some(AutoFix::DownloadMod {
                                    name: "MidnightLib".into(),
                                    source: "modrinth".into(),
                                    project_id: "midnightlib".into(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 95,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec!["midnightlib".into()],
                    })
                },
            },

            // Forge Config API Port (Fabric)
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:requires|needs|missing).*forge[\s_-]?config[\s_-]?api[\s_-]?port").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("forge_config_port_{}", line_num),
                        title: "Требуется Forge Config API Port".into(),
                        description: "Fabric мод требует Forge Config API Port.".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::MissingDependency,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Установить Forge Config API Port".into(),
                                description: "Скачайте Forge Config API Port".into(),
                                auto_fix: Some(AutoFix::DownloadMod {
                                    name: "Forge Config API Port".into(),
                                    source: "modrinth".into(),
                                    project_id: "forge-config-api-port".into(),
                                }),
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 95,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec!["forge-config-api-port".into()],
                    })
                },
            },

            // Sinytra Connector errors (Forge mods on Fabric)
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:sinytra|connector).*(?:error|fail|incompatible)").unwrap(),
                handler: |_, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("sinytra_error_{}", line_num),
                        title: "Ошибка Sinytra Connector".into(),
                        description: "Sinytra Connector не смог загрузить Forge мод на Fabric.".into(),
                        severity: Severity::Error,
                        category: ProblemCategory::ModConflict,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Использовать Fabric версию мода".into(),
                                description: "Не все Forge моды работают через Connector. Найдите нативную Fabric версию.".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 80,
                            },
                            Solution {
                                title: "Обновить Connector".into(),
                                description: "Обновите Sinytra Connector и Forgified Fabric API.".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 60,
                            },
                        ],
                        docs_links: vec!["https://sinytra.org/".into()],
                        related_mods: vec!["connector".into()],
                    })
                },
            },

            // ============ RESTART ADVICE PATTERNS ============
            // These patterns detect issues that are often fixed by a simple restart
            // Especially useful for modpacks on first launch

            // Timeout errors (often temporary network/loading issues)
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:connection|read|connect|socket)\s*(?:timed?\s*out|timeout)").unwrap(),
                handler: |_caps, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("timeout_error_{}", line_num),
                        title: "Ошибка тайм-аута".into(),
                        description: "Подключение прервалось из-за тайм-аута. Это часто временная проблема.".into(),
                        severity: Severity::Warning,
                        category: ProblemCategory::NetworkError,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Перезапустить игру".into(),
                                description: "Попробуйте просто перезапустить игру - часто это решает временные проблемы с сетью".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 70,
                            },
                            Solution {
                                title: "Проверить интернет-соединение".into(),
                                description: "Убедитесь, что интернет работает стабильно".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 50,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![],
                    })
                },
            },

            // First launch / cache generation issues
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:generating|building|creating)\s+(?:cache|index|resources?|assets?)").unwrap(),
                handler: |_caps, line, line_num| {
                    // Only trigger if there's an error indicator
                    let line_lower = line.to_lowercase();
                    if !line_lower.contains("error") && !line_lower.contains("failed") && !line_lower.contains("exception") {
                        return None;
                    }

                    Some(DetectedProblem {
                        id: format!("cache_generation_{}", line_num),
                        title: "Ошибка генерации кеша".into(),
                        description: "Ошибка при создании кеша/индексов. При первом запуске модпака это может занять время.".into(),
                        severity: Severity::Warning,
                        category: ProblemCategory::CorruptedFile,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Перезапустить игру".into(),
                                description: "Первый запуск модпака может быть нестабильным. Перезапуск часто решает проблему после генерации кешей.".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 80,
                            },
                            Solution {
                                title: "Удалить папку cache/".into(),
                                description: "Удалите папку cache или .cache в папке игры и запустите снова".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 60,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![],
                    })
                },
            },

            // Random/transient errors with restart advice
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:random|unexpected|transient|temporary)\s+(?:error|exception|failure)").unwrap(),
                handler: |_caps, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("transient_error_{}", line_num),
                        title: "Временная ошибка".into(),
                        description: "Произошла случайная/временная ошибка. Такие ошибки часто исчезают после перезапуска.".into(),
                        severity: Severity::Warning,
                        category: ProblemCategory::Unknown,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Перезапустить игру".into(),
                                description: "Временные ошибки часто решаются простым перезапуском".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 75,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![],
                    })
                },
            },

            // Modpack first launch issues (slow loading, indexing)
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:modpack|pack)\s+(?:initializ|load|start).*(?:slow|long|hang|stuck)").unwrap(),
                handler: |_caps, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("modpack_slow_start_{}", line_num),
                        title: "Медленный запуск модпака".into(),
                        description: "Модпак загружается медленно. Первый запуск всегда дольше из-за генерации кешей.".into(),
                        severity: Severity::Info,
                        category: ProblemCategory::Unknown,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Дождаться завершения".into(),
                                description: "Первый запуск модпака может занять 5-15 минут. Последующие запуски будут быстрее.".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 90,
                            },
                            Solution {
                                title: "Перезапустить если зависло".into(),
                                description: "Если игра зависла более 20 минут, попробуйте перезапустить. Кеши сохранятся.".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 70,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![],
                    })
                },
            },

            // World loading/saving errors that may be fixed by restart
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:saving|loading)\s+(?:world|chunks?|region).*(?:error|failed|exception)").unwrap(),
                handler: |_caps, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("world_io_error_{}", line_num),
                        title: "Ошибка чтения/записи мира".into(),
                        description: "Ошибка при загрузке или сохранении мира. Иногда это временная проблема.".into(),
                        severity: Severity::Warning,
                        category: ProblemCategory::CorruptedFile,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Перезапустить игру".into(),
                                description: "Некоторые ошибки загрузки мира временные и исчезают после перезапуска".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 50,
                            },
                            Solution {
                                title: "Проверить бэкап".into(),
                                description: "Если проблема повторяется, восстановите мир из бэкапа".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 80,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![],
                    })
                },
            },

            // ========== ИЗВЕСТНЫЕ КОНФЛИКТЫ МОДОВ ==========

            // OptiFine + Sodium conflict
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:optifine|optifabric).*(?:sodium|iris)|(?:sodium|iris).*(?:optifine|optifabric)").unwrap(),
                handler: |_caps, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("optifine_sodium_conflict_{}", line_num),
                        title: "Конфликт OptiFine и Sodium".into(),
                        description: "OptiFine несовместим с Sodium/Iris. Эти моды выполняют одну функцию и конфликтуют.".into(),
                        severity: Severity::Critical,
                        category: ProblemCategory::ModConflict,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Удалить OptiFine".into(),
                                description: "Sodium + Iris обеспечивают лучшую производительность и поддержку шейдеров".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 100,
                            },
                            Solution {
                                title: "Удалить Sodium".into(),
                                description: "Если вам нужен OptiFine для специфических функций (zoom, cape)".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 100,
                            },
                        ],
                        docs_links: vec!["https://github.com/CaffeineMC/sodium-fabric/wiki/FAQ".into()],
                        related_mods: vec!["optifine".into(), "sodium".into(), "iris".into()],
                    })
                },
            },

            // Explicit "Missing mod" message (common pattern)
            ErrorPattern {
                pattern: Regex::new(r#"(?i)(?:missing|not found|requires).*\bmod\b[:\s]+['"]?([a-z0-9_-]+)['"]?"#).unwrap(),
                handler: |caps, line, line_num| {
                    let mod_id = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");

                    // Filter out false positives
                    if mod_id.len() < 3 || mod_id == "unknown" || mod_id == "mod" {
                        return None;
                    }

                    Some(DetectedProblem {
                        id: format!("missing_mod_{}_{}", mod_id, line_num),
                        title: format!("Отсутствует мод: {}", mod_id),
                        description: format!("Игра не может найти мод '{}'. Он либо не установлен, либо несовместим с текущей версией.", mod_id),
                        severity: Severity::Critical,
                        category: ProblemCategory::MissingDependency,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: format!("Установить {}", mod_id),
                                description: format!("Скачайте и установите мод '{}' с Modrinth или CurseForge", mod_id),
                                auto_fix: None, // Manual search required - no project_id available
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 85,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![mod_id.to_string()],
                    })
                },
            },

            // Unknown item/block in registry (modid:name format)
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:unknown|missing|invalid|unregistered).*(?:item|block|fluid|tag|recipe)[:\s]+([a-z0-9_]+):([a-z0-9_/]+)").unwrap(),
                handler: |caps, line, line_num| {
                    let mod_id = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");
                    let item_name = caps.get(2).map(|m| m.as_str()).unwrap_or("unknown");

                    // Skip minecraft namespace
                    if mod_id == "minecraft" {
                        return None;
                    }

                    Some(DetectedProblem {
                        id: format!("unknown_registry_{}_{}", mod_id, line_num),
                        title: format!("Неизвестный предмет: {}:{}", mod_id, item_name),
                        description: format!("Не найден предмет '{}:{}'. Возможно, мод '{}' не установлен или обновился и удалил этот предмет.", mod_id, item_name, mod_id),
                        severity: Severity::Error,
                        category: ProblemCategory::MissingDependency,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: format!("Проверить мод {}", mod_id),
                                description: format!("Убедитесь что мод '{}' установлен и совместим с вашей версией игры", mod_id),
                                auto_fix: None, // Manual search required - no project_id available
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 70,
                            },
                            Solution {
                                title: "Проверить конфиги/скрипты".into(),
                                description: "Если вы используете KubeJS/CraftTweaker, проверьте скрипты на устаревшие ID предметов".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 60,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![mod_id.to_string()],
                    })
                },
            },

            // Datapack function not found
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:unknown|missing|cannot find|failed to load).*function[:\s]+([a-z0-9_]+):([a-z0-9_/]+)").unwrap(),
                handler: |caps, line, line_num| {
                    let namespace = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");
                    let path = caps.get(2).map(|m| m.as_str()).unwrap_or("unknown");

                    Some(DetectedProblem {
                        id: format!("unknown_function_{}_{}", namespace, line_num),
                        title: format!("Не найдена функция датапака: {}:{}", namespace, path),
                        description: format!("Датапак или скрипт вызывает функцию '{}:{}', которая не существует.", namespace, path),
                        severity: Severity::Warning,
                        category: ProblemCategory::ConfigError,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Проверить датапаки".into(),
                                description: format!("Убедитесь что датапак '{}' правильно установлен в папке datapacks", namespace),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 60,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![namespace.to_string()],
                    })
                },
            },

            // Client-only mod on server
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:environment|side)[:\s]+(?:client|CLIENT).*(?:server|SERVER)|mod.*only.*client|client.?only.*server").unwrap(),
                handler: |_caps, line, line_num| {
                    Some(DetectedProblem {
                        id: format!("client_mod_on_server_{}", line_num),
                        title: "Клиентский мод на сервере".into(),
                        description: "Обнаружен мод, предназначенный только для клиента. На сервере он вызовет краш.".into(),
                        severity: Severity::Critical,
                        category: ProblemCategory::ModConflict,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Удалить клиентский мод".into(),
                                description: "Удалите мод с сервера. Он нужен только на клиенте.".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 100,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![],
                    })
                },
            },

            // Recipe parsing error with mod reference
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:error|failed).*(?:parsing|loading|reading).*recipe.*([a-z0-9_]+):([a-z0-9_/]+)").unwrap(),
                handler: |caps, line, line_num| {
                    let mod_id = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");
                    let recipe_name = caps.get(2).map(|m| m.as_str()).unwrap_or("unknown");

                    Some(DetectedProblem {
                        id: format!("recipe_error_{}_{}", mod_id, line_num),
                        title: format!("Ошибка рецепта: {}:{}", mod_id, recipe_name),
                        description: format!("Ошибка при загрузке рецепта '{}:{}'. Возможно, рецепт ссылается на несуществующие предметы.", mod_id, recipe_name),
                        severity: Severity::Warning,
                        category: ProblemCategory::ConfigError,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Проверить зависимости рецепта".into(),
                                description: "Рецепт может требовать предметы из модов, которые не установлены".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Medium,
                                success_rate: 60,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![mod_id.to_string()],
                    })
                },
            },

            // Forge/NeoForge explicit dependency error
            ErrorPattern {
                pattern: Regex::new(r"(?i)Missing or unsupported mandatory dependencies.*Mod ID:\s*'([^']+)'.*depends on\s*'([^']+)'").unwrap(),
                handler: |caps, line, line_num| {
                    let mod_id = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");
                    let required = caps.get(2).map(|m| m.as_str()).unwrap_or("unknown");

                    Some(DetectedProblem {
                        id: format!("forge_missing_dep_{}_{}", mod_id, line_num),
                        title: format!("Отсутствует зависимость для {}", mod_id),
                        description: format!("Мод '{}' требует мод '{}', который не установлен или несовместим.", mod_id, required),
                        severity: Severity::Critical,
                        category: ProblemCategory::MissingDependency,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: format!("Установить {}", required),
                                description: format!("Скачайте и установите мод '{}' для корректной работы '{}'", required, mod_id),
                                auto_fix: None, // Manual search required - no project_id available
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 90,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![mod_id.to_string(), required.to_string()],
                    })
                },
            },

            // Quilt/Fabric loader version mismatch
            ErrorPattern {
                pattern: Regex::new(r"(?i)(?:requires|needs)\s+(?:fabric|quilt)\s*(?:loader|api)?\s*(?:version)?\s*([0-9.x><=]+)").unwrap(),
                handler: |caps, line, line_num| {
                    let version_req = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");

                    Some(DetectedProblem {
                        id: format!("loader_version_{}", line_num),
                        title: "Несовместимая версия загрузчика".into(),
                        description: format!("Мод требует версию Fabric/Quilt Loader {}. Обновите загрузчик.", version_req),
                        severity: Severity::Error,
                        category: ProblemCategory::VersionMismatch,
                        status: ProblemStatus::Detected,
                        log_line: Some(line.to_string()),
                        line_number: Some(line_num),
                        solutions: vec![
                            Solution {
                                title: "Обновить загрузчик".into(),
                                description: "Обновите Fabric/Quilt Loader до последней версии".into(),
                                auto_fix: None,
                                difficulty: SolutionDifficulty::Easy,
                                success_rate: 85,
                            },
                        ],
                        docs_links: vec![],
                        related_mods: vec![],
                    })
                },
            },
        ]
}

/// Build patterns for recognition (public wrapper that accesses cache)
pub fn build_patterns() -> &'static Vec<ErrorPattern> {
    get_patterns()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mixin_failed_pattern() {
        let patterns = build_patterns();

        // Test Mixin FAILED during APPLY pattern
        let mixin_line = "Mixin [tfc.mixins.json:client.MinecraftMixin] FAILED during APPLY";

        let mut found = false;
        for pattern in patterns {
            if let Some(caps) = pattern.pattern.captures(mixin_line) {
                if let Some(problem) = (pattern.handler)(&caps, mixin_line, 1) {
                    assert!(problem.title.contains("Mixin"));
                    assert!(problem.title.contains("tfc"));
                    assert_eq!(problem.severity, Severity::Critical);
                    assert_eq!(problem.category, ProblemCategory::ModConflict);
                    assert!(problem.related_mods.contains(&"tfc".to_string()));
                    found = true;
                    break;
                }
            }
        }
        assert!(found, "Mixin FAILED pattern should match");
    }

    #[test]
    fn test_mixin_transformer_error_pattern() {
        let patterns = build_patterns();

        // Test MixinApplyError pattern
        let error_line =
            "org.spongepowered.asm.mixin.transformer.MixinApplyError in tfc.mixins.json";

        let mut found = false;
        for pattern in patterns {
            if let Some(caps) = pattern.pattern.captures(error_line) {
                if let Some(problem) = (pattern.handler)(&caps, error_line, 1) {
                    if problem.id.contains("mixin") {
                        assert!(problem.title.contains("Mixin"));
                        found = true;
                        break;
                    }
                }
            }
        }
        assert!(found, "MixinApplyError pattern should match");
    }

    #[test]
    fn test_pattern_count() {
        let patterns = build_patterns();
        // Should have 115+ patterns now (includes expanded knowledge base + restart advice)
        assert!(
            patterns.len() >= 115,
            "Should have at least 115 patterns, got {}",
            patterns.len()
        );
    }

    #[test]
    fn test_oom_patterns() {
        let patterns = build_patterns();

        // Test heap space OOM
        let heap_oom = "java.lang.OutOfMemoryError: Java heap space";
        let mut found_heap = false;
        for pattern in patterns {
            if let Some(caps) = pattern.pattern.captures(heap_oom) {
                if let Some(problem) = (pattern.handler)(&caps, heap_oom, 1) {
                    if problem.id.contains("heap_oom") {
                        assert_eq!(problem.severity, Severity::Critical);
                        assert_eq!(problem.category, ProblemCategory::MemoryIssue);
                        found_heap = true;
                        break;
                    }
                }
            }
        }
        assert!(found_heap, "Heap OOM pattern should match");
    }

    #[test]
    fn test_fabric_entrypoint_pattern() {
        let patterns = build_patterns();

        let entrypoint_error = "Could not execute entrypoint stage 'main' for mod 'sodium'";
        let mut found = false;
        for pattern in patterns {
            if let Some(caps) = pattern.pattern.captures(entrypoint_error) {
                if let Some(problem) = (pattern.handler)(&caps, entrypoint_error, 1) {
                    if problem.id.contains("fabric_entrypoint") {
                        assert!(problem.title.contains("sodium"));
                        found = true;
                        break;
                    }
                }
            }
        }
        assert!(found, "Fabric entrypoint pattern should match");
    }
}
