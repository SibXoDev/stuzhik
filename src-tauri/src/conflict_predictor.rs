//! Mod Conflict Predictor - предсказание конфликтов ДО установки мода
//!
//! Упрощённая версия: только 100% подтверждённые несовместимости.
//! Никогда не блокирует установку - только предупреждает.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Уровень серьёзности конфликта
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum ConflictSeverity {
    /// Информация
    Info,
    /// Предупреждение
    Warning,
    /// Критично - 100% краш
    Critical,
}

/// Категория конфликта
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConflictCategory {
    /// Несовместимые моды (OptiFine + Sodium)
    Incompatible,
    /// Дублирующий функционал (один и тот же мод дважды)
    Duplicate,
}

/// Рекомендуемое действие
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecommendedAction {
    /// Удалить конфликтующий мод (автофикс)
    RemoveConflicting { mod_slug: String },
    /// Выбрать один из двух
    ChooseOne { alternatives: Vec<String> },
    /// Игнорировать
    Ignore,
}

/// Предсказанный конфликт
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PredictedConflict {
    /// Мод который хотим установить
    pub mod_to_install: String,
    /// Конфликтующий установленный мод
    pub conflicting_mod: Option<String>,
    /// Серьёзность
    pub severity: ConflictSeverity,
    /// Категория конфликта
    pub category: ConflictCategory,
    /// Заголовок проблемы
    pub title: String,
    /// Детальное описание
    pub description: String,
    /// Рекомендуемое действие
    pub recommended_action: RecommendedAction,
    /// Ссылка на документацию (если есть)
    pub reference_url: Option<String>,
}

/// Результат предсказания конфликтов
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConflictPredictionResult {
    /// Всегда true - мы никогда не блокируем установку
    pub safe_to_install: bool,
    /// Список предсказанных конфликтов (предупреждения)
    pub conflicts: Vec<PredictedConflict>,
    /// Общая рекомендация
    pub summary: String,
}

/// Запись в базе известных несовместимостей
struct IncompatibilityRecord {
    mod_a: &'static str,
    mod_b: &'static str,
    severity: ConflictSeverity,
    category: ConflictCategory,
    description: &'static str,
    reference_url: Option<&'static str>,
}

/// База ТОЛЬКО 100% подтверждённых несовместимостей
/// Это моды которые ГАРАНТИРОВАННО крашат игру вместе
fn get_known_incompatibilities() -> Vec<IncompatibilityRecord> {
    vec![
        // ============ RENDERING - 100% CRASH ============
        // OptiFine несовместим со всеми Sodium-based модами
        IncompatibilityRecord {
            mod_a: "optifine",
            mod_b: "sodium",
            severity: ConflictSeverity::Critical,
            category: ConflictCategory::Incompatible,
            description: "OptiFine и Sodium несовместимы - игра крашнется при запуске. Используйте один из них.",
            reference_url: Some("https://github.com/CaffeineMC/sodium-fabric/wiki/FAQ"),
        },
        IncompatibilityRecord {
            mod_a: "optifine",
            mod_b: "rubidium",
            severity: ConflictSeverity::Critical,
            category: ConflictCategory::Incompatible,
            description: "OptiFine и Rubidium несовместимы - игра крашнется. Rubidium это порт Sodium.",
            reference_url: None,
        },
        IncompatibilityRecord {
            mod_a: "optifine",
            mod_b: "embeddium",
            severity: ConflictSeverity::Critical,
            category: ConflictCategory::Incompatible,
            description: "OptiFine и Embeddium несовместимы - игра крашнется. Embeddium это форк Sodium.",
            reference_url: None,
        },
        IncompatibilityRecord {
            mod_a: "optifine",
            mod_b: "iris",
            severity: ConflictSeverity::Critical,
            category: ConflictCategory::Incompatible,
            description: "OptiFine и Iris несовместимы - оба реализуют шейдеры. Используйте один.",
            reference_url: Some("https://irisshaders.net/"),
        },
        IncompatibilityRecord {
            mod_a: "optifine",
            mod_b: "oculus",
            severity: ConflictSeverity::Critical,
            category: ConflictCategory::Incompatible,
            description: "OptiFine и Oculus несовместимы. Oculus это порт Iris для Forge.",
            reference_url: None,
        },

        // ============ ДУБЛИКАТЫ ОДНОГО МОДА ============
        // Sodium варианты - нельзя иметь два одновременно
        IncompatibilityRecord {
            mod_a: "sodium",
            mod_b: "rubidium",
            severity: ConflictSeverity::Critical,
            category: ConflictCategory::Duplicate,
            description: "Rubidium это порт Sodium для Forge. Нельзя использовать оба.",
            reference_url: None,
        },
        IncompatibilityRecord {
            mod_a: "sodium",
            mod_b: "embeddium",
            severity: ConflictSeverity::Critical,
            category: ConflictCategory::Duplicate,
            description: "Embeddium это форк Sodium. Нельзя использовать оба.",
            reference_url: None,
        },
        IncompatibilityRecord {
            mod_a: "rubidium",
            mod_b: "embeddium",
            severity: ConflictSeverity::Critical,
            category: ConflictCategory::Duplicate,
            description: "Rubidium и Embeddium - оба порты Sodium. Используйте один.",
            reference_url: None,
        },

        // Iris варианты
        IncompatibilityRecord {
            mod_a: "iris",
            mod_b: "oculus",
            severity: ConflictSeverity::Critical,
            category: ConflictCategory::Duplicate,
            description: "Oculus это порт Iris для Forge. Нельзя использовать оба.",
            reference_url: None,
        },

        // Physics Mod
        IncompatibilityRecord {
            mod_a: "physics-mod",
            mod_b: "physics-mod-pro",
            severity: ConflictSeverity::Critical,
            category: ConflictCategory::Duplicate,
            description: "Physics Mod и Physics Mod Pro - разные версии одного мода.",
            reference_url: None,
        },

        // Entity Culling варианты
        IncompatibilityRecord {
            mod_a: "entity-culling",
            mod_b: "entityculling",
            severity: ConflictSeverity::Critical,
            category: ConflictCategory::Duplicate,
            description: "Два варианта Entity Culling мода. Используйте один.",
            reference_url: None,
        },
    ]
}

/// Алиасы для slug'ов модов
fn get_mod_aliases() -> HashMap<&'static str, Vec<&'static str>> {
    let mut aliases = HashMap::new();

    aliases.insert("optifine", vec!["optifine", "optifabric", "optiforge"]);
    aliases.insert("sodium", vec!["sodium", "sodium-fabric", "sodium-forge"]);
    aliases.insert("rubidium", vec!["rubidium", "rubidium-reforged"]);
    aliases.insert("embeddium", vec!["embeddium", "embeddium-plus"]);
    aliases.insert("iris", vec!["iris", "iris-shaders"]);
    aliases.insert("physics-mod", vec!["physics-mod", "physicsmod"]);

    aliases
}

/// Нормализует slug мода
fn normalize_slug(slug: &str) -> String {
    let mut normalized = slug.to_lowercase();

    for suffix in &["-fabric", "-forge", "-neoforge", "-quilt", "-mod"] {
        if normalized.ends_with(suffix) {
            normalized = normalized.trim_end_matches(suffix).to_string();
        }
    }

    normalized
}

/// Проверяет совпадение slug с учётом алиасов
fn matches_mod(slug: &str, target: &str, aliases: &HashMap<&str, Vec<&str>>) -> bool {
    let normalized_slug = normalize_slug(slug);
    let normalized_target = normalize_slug(target);

    if normalized_slug == normalized_target {
        return true;
    }

    if let Some(target_aliases) = aliases.get(normalized_target.as_str()) {
        for alias in target_aliases {
            if normalize_slug(alias) == normalized_slug {
                return true;
            }
        }
    }

    for (canonical, alias_list) in aliases.iter() {
        if alias_list
            .iter()
            .any(|a| normalize_slug(a) == normalized_slug)
            && (*canonical == normalized_target.as_str()
                || alias_list
                    .iter()
                    .any(|a| normalize_slug(a) == normalized_target))
        {
            return true;
        }
    }

    false
}

/// Предсказывает конфликты при установке мода
/// НИКОГДА не блокирует - только предупреждает
pub fn predict_conflicts(
    mod_to_install: &str,
    installed_mods: &[String],
    _loader: &str, // Не используем - убрали loader warnings
) -> ConflictPredictionResult {
    let incompatibilities = get_known_incompatibilities();
    let aliases = get_mod_aliases();

    let mut conflicts = Vec::new();

    // Проверяем известные несовместимости
    for record in &incompatibilities {
        let is_mod_a = matches_mod(mod_to_install, record.mod_a, &aliases);
        let is_mod_b = matches_mod(mod_to_install, record.mod_b, &aliases);

        if !is_mod_a && !is_mod_b {
            continue;
        }

        let conflict_target = if is_mod_a { record.mod_b } else { record.mod_a };

        for installed in installed_mods {
            if matches_mod(installed, conflict_target, &aliases) {
                let recommended_action = RecommendedAction::RemoveConflicting {
                    mod_slug: installed.clone(),
                };

                conflicts.push(PredictedConflict {
                    mod_to_install: mod_to_install.to_string(),
                    conflicting_mod: Some(installed.clone()),
                    severity: record.severity,
                    category: record.category.clone(),
                    title: format!("{} конфликтует с {}", mod_to_install, installed),
                    description: record.description.to_string(),
                    recommended_action,
                    reference_url: record.reference_url.map(|s| s.to_string()),
                });
            }
        }
    }

    // Проверяем дубликаты (тот же мод уже установлен)
    for installed in installed_mods {
        if matches_mod(installed, mod_to_install, &aliases) {
            conflicts.push(PredictedConflict {
                mod_to_install: mod_to_install.to_string(),
                conflicting_mod: Some(installed.clone()),
                severity: ConflictSeverity::Warning,
                category: ConflictCategory::Duplicate,
                title: format!("Мод {} уже установлен", installed),
                description: "Мод с таким же slug уже установлен. Возможно это дубликат."
                    .to_string(),
                recommended_action: RecommendedAction::Ignore,
                reference_url: None,
            });
        }
    }

    // Сортируем по серьёзности
    conflicts.sort_by(|a, b| b.severity.cmp(&a.severity));

    // Формируем summary
    let summary = if conflicts.is_empty() {
        "Конфликтов не обнаружено.".to_string()
    } else {
        let critical_count = conflicts
            .iter()
            .filter(|c| c.severity == ConflictSeverity::Critical)
            .count();
        if critical_count > 0 {
            format!(
                "Обнаружено {} критических конфликтов! Рекомендуется удалить конфликтующие моды.",
                critical_count
            )
        } else {
            format!("Обнаружено {} предупреждений.", conflicts.len())
        }
    };

    ConflictPredictionResult {
        safe_to_install: true, // Всегда разрешаем установку
        conflicts,
        summary,
    }
}

/// Быстрая проверка - есть ли известные проблемы с модом
pub fn has_known_issues(mod_slug: &str) -> bool {
    let incompatibilities = get_known_incompatibilities();
    let aliases = get_mod_aliases();

    for record in &incompatibilities {
        if matches_mod(mod_slug, record.mod_a, &aliases)
            || matches_mod(mod_slug, record.mod_b, &aliases)
        {
            return true;
        }
    }

    false
}

/// Получить список всех известных конфликтующих модов
pub fn get_conflicting_mods(mod_slug: &str) -> Vec<String> {
    let incompatibilities = get_known_incompatibilities();
    let aliases = get_mod_aliases();
    let mut conflicting = Vec::new();

    for record in &incompatibilities {
        let is_mod_a = matches_mod(mod_slug, record.mod_a, &aliases);
        let is_mod_b = matches_mod(mod_slug, record.mod_b, &aliases);

        if is_mod_a {
            conflicting.push(record.mod_b.to_string());
        } else if is_mod_b {
            conflicting.push(record.mod_a.to_string());
        }
    }

    conflicting.sort();
    conflicting.dedup();
    conflicting
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_slug() {
        assert_eq!(normalize_slug("sodium-fabric"), "sodium");
        assert_eq!(normalize_slug("Sodium-Forge"), "sodium");
        assert_eq!(normalize_slug("create-mod"), "create");
    }

    #[test]
    fn test_matches_mod() {
        let aliases = get_mod_aliases();
        assert!(matches_mod("sodium", "sodium", &aliases));
        assert!(matches_mod("sodium-fabric", "sodium", &aliases));
        assert!(matches_mod("optifabric", "optifine", &aliases));
    }

    #[test]
    fn test_predict_conflicts_optifine_sodium() {
        let installed = vec!["sodium".to_string()];
        let result = predict_conflicts("optifine", &installed, "fabric");

        assert!(result.safe_to_install); // Всегда true
        assert!(!result.conflicts.is_empty());
        assert_eq!(result.conflicts[0].severity, ConflictSeverity::Critical);
    }

    #[test]
    fn test_predict_conflicts_no_conflicts() {
        let installed = vec!["create".to_string(), "jei".to_string()];
        let result = predict_conflicts("journeymap", &installed, "forge");

        assert!(result.safe_to_install);
        assert!(result.conflicts.is_empty());
    }

    #[test]
    fn test_get_conflicting_mods() {
        let conflicts = get_conflicting_mods("sodium");

        assert!(conflicts.contains(&"optifine".to_string()));
        assert!(conflicts.contains(&"rubidium".to_string()));
        assert!(conflicts.contains(&"embeddium".to_string()));
    }

    #[test]
    fn test_has_known_issues() {
        assert!(has_known_issues("optifine"));
        assert!(has_known_issues("sodium"));
        assert!(!has_known_issues("create"));
        assert!(!has_known_issues("jei"));
    }
}
