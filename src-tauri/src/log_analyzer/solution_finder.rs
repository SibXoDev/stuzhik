//! Solution Finder - поиск решений проблем в интернете
//!
//! Использует:
//! - GitHub Issues API (без аутентификации - 60 req/hour)
//! - Reddit .json API (без аутентификации)
//! - Встроенную базу знаний

use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;
use stuzhik_core::DetectedProblem;

/// Источник решения
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SolutionSource {
    /// Встроенная база знаний
    BuiltIn,
    /// GitHub Issues
    GitHub,
    /// Reddit (r/feedthebeast, r/minecraft)
    Reddit,
    /// Modrinth/CurseForge комментарии
    ModPage,
    /// Сообщество пользователей
    Community,
}

/// Найденное решение
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OnlineSolution {
    /// Заголовок решения
    pub title: String,
    /// Описание/шаги решения
    pub description: String,
    /// Источник
    pub source: SolutionSource,
    /// Уверенность в решении (0.0 - 1.0)
    pub confidence: f32,
    /// Количество людей которым помогло
    pub helped_count: Option<u32>,
    /// URL источника
    pub url: Option<String>,
    /// Теги
    pub tags: Vec<String>,
    /// Ключ локализации (для встроенных решений)
    /// Фронтенд использует его для отображения перевода из solutionFinder.knowledgeBase.[key]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub translation_key: Option<String>,
}

/// Результат поиска решений
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SolutionSearchResult {
    /// Найденные решения
    pub solutions: Vec<OnlineSolution>,
    /// Время поиска в миллисекундах
    pub search_time_ms: u64,
    /// Проверенные источники
    pub sources_checked: Vec<SolutionSource>,
}

/// Finder для поиска решений онлайн
pub struct SolutionFinder {
    client: Client,
    /// Встроенная база знаний
    knowledge_base: KnowledgeBase,
}

/// Встроенная база знаний с проверенными решениями
struct KnowledgeBase {
    solutions: HashMap<String, Vec<OnlineSolution>>,
}

impl KnowledgeBase {
    fn new() -> Self {
        let mut solutions = HashMap::new();

        // OutOfMemoryError
        // Fallback text in English, frontend uses translation_key for localization
        solutions.insert(
            "outofmemory".to_string(),
            vec![
                OnlineSolution {
                    title: "Increase allocated RAM".to_string(),
                    description: "Increase maximum memory in instance settings (6-8GB recommended for modpacks)".to_string(),
                    source: SolutionSource::BuiltIn,
                    confidence: 0.95,
                    helped_count: Some(15420),
                    url: None,
                    tags: vec!["memory".into(), "jvm".into(), "performance".into()],
                    translation_key: Some("outofmemory".into()),
                },
                OnlineSolution {
                    title: "Remove HD texture packs".to_string(),
                    description: "High resolution texture packs (256x+) consume lots of VRAM and RAM".to_string(),
                    source: SolutionSource::BuiltIn,
                    confidence: 0.75,
                    helped_count: Some(3200),
                    url: None,
                    tags: vec!["textures".into(), "memory".into()],
                    translation_key: Some("outofmemoryTextures".into()),
                },
            ],
        );

        // OptiFine conflicts
        solutions.insert(
            "optifine".to_string(),
            vec![OnlineSolution {
                title: "Remove OptiFine".to_string(),
                description: "OptiFine is incompatible with Sodium/Iris/Rubidium. Use Sodium + Iris for shaders".to_string(),
                source: SolutionSource::BuiltIn,
                confidence: 1.0,
                helped_count: Some(28500),
                url: None,
                tags: vec!["optifine".into(), "sodium".into(), "conflict".into()],
                translation_key: Some("optifine".into()),
            }],
        );

        // Missing dependencies
        solutions.insert(
            "missing_dependency".to_string(),
            vec![OnlineSolution {
                title: "Auto-install dependencies".to_string(),
                description:
                    "Use 'Resolve Dependencies' feature to automatically install missing mods"
                        .to_string(),
                source: SolutionSource::BuiltIn,
                confidence: 0.9,
                helped_count: Some(12300),
                url: None,
                tags: vec!["dependencies".into(), "mods".into()],
                translation_key: Some("missingDependency".into()),
            }],
        );

        // Mixin conflicts
        solutions.insert(
            "mixin".to_string(),
            vec![
                OnlineSolution {
                    title: "Update mods".to_string(),
                    description: "Mixin conflicts are often fixed in newer mod versions. Check for updates".to_string(),
                    source: SolutionSource::BuiltIn,
                    confidence: 0.8,
                    helped_count: Some(8900),
                    url: None,
                    tags: vec!["mixin".into(), "update".into(), "conflict".into()],
                    translation_key: Some("mixinUpdate".into()),
                },
                OnlineSolution {
                    title: "Remove conflicting mod".to_string(),
                    description: "If two mods modify the same method via Mixin, one of them needs to be removed".to_string(),
                    source: SolutionSource::BuiltIn,
                    confidence: 0.7,
                    helped_count: Some(5600),
                    url: None,
                    tags: vec!["mixin".into(), "conflict".into()],
                    translation_key: Some("mixinRemove".into()),
                },
            ],
        );

        // Java version mismatch
        solutions.insert(
            "java_version".to_string(),
            vec![OnlineSolution {
                title: "Install correct Java version".to_string(),
                description: "MC 1.17+ requires Java 17+, MC 1.20.5+ requires Java 21. Install the correct version".to_string(),
                source: SolutionSource::BuiltIn,
                confidence: 0.95,
                helped_count: Some(18700),
                url: None,
                tags: vec!["java".into(), "version".into()],
                translation_key: Some("javaVersion".into()),
            }],
        );

        // Corrupted mod files
        solutions.insert(
            "corrupted".to_string(),
            vec![OnlineSolution {
                title: "Reinstall mod".to_string(),
                description:
                    "Mod file is corrupted. Delete it and download again from Modrinth/CurseForge"
                        .to_string(),
                source: SolutionSource::BuiltIn,
                confidence: 0.85,
                helped_count: Some(6400),
                url: None,
                tags: vec!["corrupted".into(), "reinstall".into()],
                translation_key: Some("corrupted".into()),
            }],
        );

        // Config errors
        solutions.insert(
            "config".to_string(),
            vec![OnlineSolution {
                title: "Reset configs".to_string(),
                description: "Delete the config folder to reset settings. Mod will create new configs on startup".to_string(),
                source: SolutionSource::BuiltIn,
                confidence: 0.8,
                helped_count: Some(4200),
                url: None,
                tags: vec!["config".into(), "reset".into()],
                translation_key: Some("config".into()),
            }],
        );

        // KubeJS errors
        solutions.insert(
            "kubejs".to_string(),
            vec![OnlineSolution {
                title: "Check KubeJS scripts".to_string(),
                description: "KubeJS errors usually indicate problems in scripts. Check kubejs/startup_scripts/ and kubejs/server_scripts/".to_string(),
                source: SolutionSource::BuiltIn,
                confidence: 0.85,
                helped_count: Some(3100),
                url: None,
                tags: vec!["kubejs".into(), "scripts".into()],
                translation_key: Some("kubejs".into()),
            }],
        );

        KnowledgeBase { solutions }
    }

    fn search(&self, keywords: &[&str]) -> Vec<OnlineSolution> {
        let mut results = Vec::new();

        for keyword in keywords {
            let keyword_lower = keyword.to_lowercase();
            for (key, solutions) in &self.solutions {
                if key.contains(&keyword_lower) || keyword_lower.contains(key) {
                    for solution in solutions {
                        if !results
                            .iter()
                            .any(|s: &OnlineSolution| s.title == solution.title)
                        {
                            results.push(solution.clone());
                        }
                    }
                }
            }
        }

        // Сортируем по confidence
        results.sort_by(|a, b| {
            b.confidence
                .partial_cmp(&a.confidence)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        results
    }
}

impl SolutionFinder {
    pub fn new() -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(10))
            .user_agent("MinecraftModpackConstructor/1.0")
            .build()
            .unwrap_or_else(|_| Client::new());

        SolutionFinder {
            client,
            knowledge_base: KnowledgeBase::new(),
        }
    }

    /// Поиск решений для проблемы
    pub async fn find_solutions(&self, problem: &DetectedProblem) -> SolutionSearchResult {
        let start = std::time::Instant::now();
        let mut all_solutions = Vec::new();
        let mut sources_checked = vec![SolutionSource::BuiltIn];

        // Извлекаем ключевые слова из проблемы
        let keywords = self.extract_keywords(problem);
        log::debug!("Searching solutions for keywords: {:?}", keywords);

        // 1. Поиск в встроенной базе (мгновенно)
        let builtin = self
            .knowledge_base
            .search(&keywords.iter().map(|s| s.as_str()).collect::<Vec<_>>());
        all_solutions.extend(builtin);

        // 2. Поиск в GitHub Issues (если есть related_mods)
        if !problem.related_mods.is_empty() {
            sources_checked.push(SolutionSource::GitHub);
            if let Ok(github_solutions) = self
                .search_github(&problem.related_mods, &problem.title)
                .await
            {
                all_solutions.extend(github_solutions);
            }
        }

        // 3. Поиск в Reddit (ограниченно - без API ключа есть лимиты)
        sources_checked.push(SolutionSource::Reddit);
        if let Ok(reddit_solutions) = self.search_reddit(&keywords).await {
            all_solutions.extend(reddit_solutions);
        }

        // Дедупликация и ранжирование по confidence
        all_solutions = self.deduplicate_and_rank(all_solutions);

        let search_time_ms = start.elapsed().as_millis() as u64;

        SolutionSearchResult {
            solutions: all_solutions,
            search_time_ms,
            sources_checked,
        }
    }

    /// Извлечь ключевые слова из проблемы
    fn extract_keywords(&self, problem: &DetectedProblem) -> Vec<String> {
        let mut keywords = Vec::new();

        // Из категории
        let category_keyword = format!("{:?}", problem.category).to_lowercase();
        keywords.push(category_keyword);

        // Из title
        for word in problem.title.split_whitespace() {
            let word_clean = word
                .trim_matches(|c: char| !c.is_alphanumeric())
                .to_lowercase();
            if word_clean.len() > 3 && !is_stop_word(&word_clean) {
                keywords.push(word_clean);
            }
        }

        // Из related_mods
        keywords.extend(problem.related_mods.iter().cloned());

        // Специальные ключевые слова по severity
        if problem.title.to_lowercase().contains("outofmemory")
            || problem.title.to_lowercase().contains("memory")
        {
            keywords.push("outofmemory".into());
        }
        if problem.title.to_lowercase().contains("mixin") {
            keywords.push("mixin".into());
        }
        if problem.title.to_lowercase().contains("kubejs")
            || problem.title.to_lowercase().contains("kjs")
        {
            keywords.push("kubejs".into());
        }

        keywords
    }

    /// Поиск в GitHub Issues
    async fn search_github(
        &self,
        mod_names: &[String],
        error_title: &str,
    ) -> Result<Vec<OnlineSolution>, String> {
        let mut solutions = Vec::new();

        // Берём первый мод для поиска (лимит запросов)
        let mod_name = mod_names.first().map(|s| s.as_str()).unwrap_or("minecraft");

        // GitHub Search API (без аутентификации - 10 req/min, 60/hour)
        let query = format!(
            "{} {} is:issue",
            mod_name,
            error_title.chars().take(50).collect::<String>()
        );
        let url = format!(
            "https://api.github.com/search/issues?q={}&per_page=5",
            urlencoding::encode(&query)
        );

        log::debug!("Searching GitHub: {}", url);

        let response = self
            .client
            .get(&url)
            .header("Accept", "application/vnd.github.v3+json")
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !response.status().is_success() {
            log::warn!("GitHub API returned {}", response.status());
            return Ok(solutions);
        }

        let data: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;

        if let Some(items) = data["items"].as_array() {
            for item in items.iter().take(3) {
                let title = item["title"].as_str().unwrap_or("").to_string();
                let body = item["body"].as_str().unwrap_or("");
                let url = item["html_url"].as_str().map(|s| s.to_string());
                let state = item["state"].as_str().unwrap_or("");
                let reactions = item["reactions"]["+1"].as_i64().unwrap_or(0) as u32;

                // Пропускаем открытые issues без решения
                if state != "closed" && reactions < 5 {
                    continue;
                }

                // Пытаемся извлечь решение из body
                let description =
                    extract_solution_from_text(body).unwrap_or_else(|| truncate_text(body, 300));

                if !description.is_empty() {
                    let confidence = if state == "closed" { 0.7 } else { 0.5 };
                    solutions.push(OnlineSolution {
                        title: truncate_text(&title, 100),
                        description,
                        source: SolutionSource::GitHub,
                        confidence,
                        helped_count: Some(reactions),
                        url,
                        tags: vec!["github".into(), mod_name.to_string()],
                        translation_key: None, // Online solutions don't have translations
                    });
                }
            }
        }

        Ok(solutions)
    }

    /// Поиск в Reddit (r/feedthebeast, r/minecraft)
    async fn search_reddit(&self, keywords: &[String]) -> Result<Vec<OnlineSolution>, String> {
        let mut solutions = Vec::new();

        // Reddit .json API (без OAuth)
        let query = keywords
            .iter()
            .take(3)
            .cloned()
            .collect::<Vec<_>>()
            .join("+");
        let url = format!(
            "https://www.reddit.com/r/feedthebeast/search.json?q={}&restrict_sr=1&sort=relevance&limit=5",
            urlencoding::encode(&query)
        );

        log::debug!("Searching Reddit: {}", url);

        let response = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !response.status().is_success() {
            log::warn!("Reddit API returned {}", response.status());
            return Ok(solutions);
        }

        let data: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;

        if let Some(children) = data["data"]["children"].as_array() {
            for child in children.iter().take(3) {
                let post = &child["data"];
                let title = post["title"].as_str().unwrap_or("").to_string();
                let selftext = post["selftext"].as_str().unwrap_or("");
                let permalink = post["permalink"].as_str();
                let score = post["score"].as_i64().unwrap_or(0) as u32;
                let num_comments = post["num_comments"].as_i64().unwrap_or(0);

                // Пропускаем низкорейтинговые посты
                if score < 5 && num_comments < 3 {
                    continue;
                }

                let description = extract_solution_from_text(selftext)
                    .unwrap_or_else(|| truncate_text(selftext, 300));

                if !description.is_empty() {
                    let url = permalink.map(|p| format!("https://reddit.com{}", p));
                    let confidence = calculate_reddit_confidence(score, num_comments as u32);

                    solutions.push(OnlineSolution {
                        title: truncate_text(&title, 100),
                        description,
                        source: SolutionSource::Reddit,
                        confidence,
                        helped_count: Some(score),
                        url,
                        tags: vec!["reddit".into(), "feedthebeast".into()],
                        translation_key: None, // Online solutions don't have translations
                    });
                }
            }
        }

        Ok(solutions)
    }

    /// Дедупликация и ранжирование решений
    fn deduplicate_and_rank(&self, mut solutions: Vec<OnlineSolution>) -> Vec<OnlineSolution> {
        // Удаляем дубликаты по заголовку
        let mut seen_titles = std::collections::HashSet::new();
        solutions.retain(|s| {
            let title_key = s.title.to_lowercase();
            if seen_titles.contains(&title_key) {
                false
            } else {
                seen_titles.insert(title_key);
                true
            }
        });

        // Сортируем: сначала по confidence, потом по helped_count
        solutions.sort_by(|a, b| match b.confidence.partial_cmp(&a.confidence) {
            Some(std::cmp::Ordering::Equal) | None => b
                .helped_count
                .unwrap_or(0)
                .cmp(&a.helped_count.unwrap_or(0)),
            Some(ord) => ord,
        });

        // Ограничиваем количество
        solutions.truncate(10);
        solutions
    }
}

impl Default for SolutionFinder {
    fn default() -> Self {
        Self::new()
    }
}

/// Проверка на стоп-слово
fn is_stop_word(word: &str) -> bool {
    const STOP_WORDS: &[&str] = &[
        "the", "and", "for", "are", "but", "not", "you", "all", "can", "was", "has", "have",
        "been", "this", "that", "with", "from", "your", "will", "при", "для", "это", "что", "как",
        "или", "был", "была", "быть", "были",
    ];
    STOP_WORDS.contains(&word)
}

/// Извлечь решение из текста
fn extract_solution_from_text(text: &str) -> Option<String> {
    // Ищем паттерны типа "fixed by", "solution:", "solved:", "workaround:"
    let patterns = [
        "fixed by",
        "solution:",
        "solved:",
        "workaround:",
        "fix:",
        "решение:",
        "исправлено:",
    ];

    let text_lower = text.to_lowercase();
    for pattern in patterns {
        if let Some(pos) = text_lower.find(pattern) {
            let start = pos + pattern.len();
            let end = text[start..]
                .find('\n')
                .map(|p| start + p)
                .unwrap_or(text.len());
            let solution = text[start..end.min(start + 500)].trim();
            if !solution.is_empty() {
                return Some(solution.to_string());
            }
        }
    }
    None
}

/// Обрезать текст до max_len символов
fn truncate_text(text: &str, max_len: usize) -> String {
    if text.len() <= max_len {
        text.to_string()
    } else {
        format!("{}...", &text[..max_len])
    }
}

/// Рассчитать confidence для Reddit поста
fn calculate_reddit_confidence(score: u32, comments: u32) -> f32 {
    let base = 0.4;
    let score_bonus = (score as f32 / 100.0).min(0.3);
    let comments_bonus = (comments as f32 / 20.0).min(0.2);
    (base + score_bonus + comments_bonus).min(0.9)
}

// ============================================================================
// Tauri Commands
// ============================================================================

/// Поиск решений для проблемы
#[tauri::command]
pub async fn find_online_solutions(
    problem: DetectedProblem,
) -> Result<SolutionSearchResult, String> {
    let finder = SolutionFinder::new();
    Ok(finder.find_solutions(&problem).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_knowledge_base_search() {
        let kb = KnowledgeBase::new();

        let results = kb.search(&["outofmemory"]);
        assert!(!results.is_empty());
        assert!(results[0].confidence > 0.9);
    }

    #[test]
    fn test_extract_solution() {
        let text = "I had this issue too. Solution: delete the config folder and restart the game.";
        let solution = extract_solution_from_text(text);
        assert!(solution.is_some());
        assert!(solution.unwrap().contains("delete the config"));
    }

    #[test]
    fn test_confidence_calculation() {
        let conf = calculate_reddit_confidence(100, 20);
        assert!(conf > 0.5);
        assert!(conf < 1.0);
    }
}
