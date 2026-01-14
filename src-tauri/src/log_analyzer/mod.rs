//! Интеллектуальный анализатор логов Minecraft
//!
//! Функции:
//! - Распознавание типичных ошибок
//! - Предложение решений
//! - Автоматическое исправление (где возможно)
//! - База знаний ошибок

use rayon::prelude::*;

mod auto_fix;
mod crash_history;
pub mod live_monitor;
mod mappings;
mod patterns;
pub mod solution_finder;

// Re-export публичных типов
pub use auto_fix::{apply_auto_fix, AutoFixResult};
pub use crash_history::{
    cleanup_old_crashes, clear_crash_history, get_crash_history, get_crash_statistics,
    get_crash_trends, mark_crash_fixed, save_crash_record, update_crash_notes, CrashRecord,
    CrashStatistics, CrashTrend, CrashTrendDirection, DailyCrashCount, ModCrashStats,
};
pub use live_monitor::{
    get_monitored_instances, init_live_monitor, is_live_monitoring, start_live_monitoring,
    stop_live_monitoring, LiveCrashEvent,
};
pub use mappings::{analyze_class_path, extract_mod_id_from_class, FRAMEWORK_PACKAGES, KNOWN_PACKAGE_MAPPINGS};
pub use solution_finder::{
    find_online_solutions, OnlineSolution, SolutionSearchResult, SolutionSource,
};

// Re-export types from stuzhik_core
pub use stuzhik_core::{
    AffectedLevel, AnalysisReport, AnalysisSummary, AutoFix, ClassAnalysisResult, CrashInfo,
    DetectedProblem, ErrorChainAnalysis, ErrorGroup, LagSpike, LogAnalysisResult, LogFileInfo,
    MemoryIssue, MemoryIssueType, ModInfo, Optimization, PerformanceAnalysis, ProblemCategory,
    ProblemStatus, Severity, SlowMod, Solution, SolutionDifficulty, SystemInfo, TpsIssue,
};

use crate::error::{LauncherError, Result};
use crate::paths::{
    self, find_newest_file_sync, find_newest_files_sync, has_extension, instances_dir,
};
use patterns::{get_matching_pattern_indices, get_patterns};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Анализатор логов
///
/// Паттерны кешируются глобально для производительности,
/// поэтому создание нового экземпляра очень быстрое (< 1 мкс)
pub struct LogAnalyzer;

impl LogAnalyzer {
    /// Создать новый анализатор (быстро - паттерны уже скомпилированы)
    pub fn new() -> Self {
        Self
    }

    /// Анализировать содержимое лога
    pub fn analyze(&self, log_content: &str) -> LogAnalysisResult {
        let start_time = std::time::Instant::now();

        let mut crash_info: Option<CrashInfo> = None;

        let all_lines: Vec<&str> = log_content.lines().collect();
        let total_lines = all_lines.len() as u32;

        // Ищем последнюю игровую сессию (чтобы не анализировать старые логи)
        // Minecraft начинает новую сессию с этих маркеров
        let session_markers = [
            "Setting user:",                        // Client start
            "Starting minecraft server",            // Server start
            "Loading Minecraft",                    // Game loading
            "Starting integrated minecraft server", // Singleplayer
            "Preparing start region",               // World loading
        ];

        // Находим индекс последнего маркера начала сессии
        // ОПТИМИЗАЦИЯ: используем case-insensitive поиск без аллокаций
        let last_session_start = all_lines
            .iter()
            .enumerate()
            .rev() // Ищем с конца
            .find(|(_, line)| {
                // Быстрая проверка без to_lowercase() - ищем паттерны case-insensitive
                session_markers.iter().any(|marker| {
                    line.len() >= marker.len()
                        && line
                            .as_bytes()
                            .windows(marker.len())
                            .any(|window| window.eq_ignore_ascii_case(marker.as_bytes()))
                })
            })
            .map(|(idx, _)| idx);

        let lines: Vec<&str> = if let Some(start_idx) = last_session_start {
            log::info!(
                "📍 Found last session start at line {} (analyzing {} lines from current session only)",
                start_idx + 1,
                all_lines.len() - start_idx
            );
            all_lines[start_idx..].to_vec()
        } else {
            log::warn!(
                "⚠️  No session marker found, analyzing all {} lines (might include old logs!)",
                total_lines
            );
            all_lines
        };

        log::debug!(
            "Analyzing {} lines from current session (total log: {} lines)",
            lines.len(),
            total_lines
        );

        // Проверяем на краш-репорт
        if log_content.contains("---- Minecraft Crash Report ----") {
            crash_info = Self::parse_crash_report(log_content);
        }

        // Быстрый фильтр - ключевые слова которые могут указывать на проблемы
        // Это ускоряет анализ, пропуская строки без потенциальных проблем
        let error_indicators = [
            "error",
            "exception",
            "failed",
            "missing",
            "requires",
            "crash",
            "corrupt",
            "invalid",
            "conflict",
            "incompatible",
            "outofmemory",
            "unsupported",
            "duplicate",
            "mixin",
            "kubejs",
            "warn",
            "fatal",
            "unable",
            "cannot",
            "not found",
            "nosuch",
            "abstract",
        ];

        // Noise patterns - ПОЛНЫЕ фразы которые точно НЕ являются ошибками
        // ВАЖНО: используем только точные фразы, не частичные совпадения!
        let noise_patterns = [
            // Успешные сообщения (ПОЛНЫЕ фразы)
            "loaded successfully",
            "completed successfully",
            "initialized successfully",
            "registered successfully",
            // Информационные (безопасные)
            "shutting down gracefully",
            "saving world",
            // Только точные deprecated/experimental предупреждения
            "this method is deprecated",
            "experimental feature",
            "running in dev environment",
            // Сетевые info сообщения (не ошибки)
            "connection established",
            "handshake completed",
        ];

        let patterns_start = std::time::Instant::now();

        // ОПТИМИЗАЦИЯ: Используем атомарный счётчик для early termination
        use std::sync::atomic::{AtomicUsize, Ordering};
        let problem_count = AtomicUsize::new(0);
        const MAX_PROBLEMS: usize = 100; // Лимит проблем для early termination

        // ОПТИМИЗАЦИЯ: case-insensitive contains без аллокаций
        fn contains_ci(haystack: &str, needle: &str) -> bool {
            if haystack.len() < needle.len() {
                return false;
            }
            haystack
                .as_bytes()
                .windows(needle.len())
                .any(|window| window.eq_ignore_ascii_case(needle.as_bytes()))
        }

        // Параллельно анализируем ВСЕ потенциально проблемные строки (rayon)
        // Это даёт 2-4x ускорение на многоядерных CPU
        let mut problems: Vec<DetectedProblem> = lines
            .par_iter()
            .enumerate()
            .filter_map(|(i, line)| {
                // Early termination: если уже нашли достаточно проблем
                if problem_count.load(Ordering::Relaxed) >= MAX_PROBLEMS {
                    return None;
                }

                let line_num = i as u32 + 1;

                // ОПТИМИЗАЦИЯ: Быстрая проверка БЕЗ to_lowercase()
                // Используем case-insensitive сравнение на уровне байтов
                let has_indicator = error_indicators
                    .iter()
                    .any(|ind| contains_ci(line, ind));
                if !has_indicator {
                    return None;
                }

                // Пропускаем строки с noise patterns (ложные срабатывания)
                let is_noise = noise_patterns.iter().any(|noise| contains_ci(line, noise));
                if is_noise {
                    return None;
                }

                // Применяем паттерны только к потенциально проблемным строкам
                // RegexSet O(1) пред-фильтрация: проверяет все паттерны за один проход
                let matching_indices = get_matching_pattern_indices(line);
                if matching_indices.is_empty() {
                    return None;
                }

                // Применяем только те паттерны, которые реально матчат
                let patterns = get_patterns();
                for idx in matching_indices {
                    let pattern = &patterns[idx];
                    if let Some(caps) = pattern.pattern.captures(line) {
                        if let Some(problem) = (pattern.handler)(&caps, line, line_num) {
                            // Инкрементируем счётчик найденных проблем
                            problem_count.fetch_add(1, Ordering::Relaxed);
                            // Возвращаем первую найденную проблему в строке
                            return Some(problem);
                        }
                    }
                }

                None
            })
            .collect();

        // Дедупликация после параллельного сбора (быстрее чем проверять в каждом потоке)
        let mut seen_titles = std::collections::HashSet::new();
        problems.retain(|p| seen_titles.insert(p.title.clone()));

        let patterns_time_ms = patterns_start.elapsed().as_millis();
        log::info!(
            "Pattern matching completed in {}ms ({} problems found)",
            patterns_time_ms,
            problems.len()
        );

        // Сортируем по приоритету: severity -> category priority -> line number
        // Это обеспечивает показ root causes (основных причин) первыми
        problems.sort_by(|a, b| {
            // Сначала по severity (Critical > Error > Warning > Info)
            match b.severity.cmp(&a.severity) {
                std::cmp::Ordering::Equal => {
                    // Затем по приоритету категории (root causes first)
                    match a.category.priority().cmp(&b.category.priority()) {
                        std::cmp::Ordering::Equal => {
                            // Затем по номеру строки (ранние ошибки first)
                            a.line_number.cmp(&b.line_number)
                        }
                        other => other,
                    }
                }
                other => other,
            }
        });

        // === ИНТЕЛЛЕКТУАЛЬНАЯ ОБРАБОТКА РЕЗУЛЬТАТОВ ===
        let postprocess_start = std::time::Instant::now();
        // Применяем умную дедупликацию, контекстный анализ и оценку уверенности
        problems = Self::smart_post_processing(problems, &lines);
        let postprocess_time_ms = postprocess_start.elapsed().as_millis();
        log::debug!(
            "Post-processing completed in {}ms ({} problems after dedup)",
            postprocess_time_ms,
            problems.len()
        );

        // Считаем по severity из найденных проблем (после обработки)
        let critical_count = problems
            .iter()
            .filter(|p| p.severity == Severity::Critical)
            .count() as u32;
        let error_count = problems
            .iter()
            .filter(|p| p.severity == Severity::Error)
            .count() as u32;
        let warning_count = problems
            .iter()
            .filter(|p| p.severity == Severity::Warning)
            .count() as u32;

        // Генерируем оптимизации
        let opt_start = std::time::Instant::now();
        let optimizations = Self::generate_optimizations(log_content);
        let opt_time_ms = opt_start.elapsed().as_millis();
        log::debug!(
            "Optimization generation completed in {}ms ({} suggestions)",
            opt_time_ms,
            optimizations.len()
        );

        let parse_time_ms = start_time.elapsed().as_millis() as u64;
        // Группируем ошибки по модам/категориям
        let error_groups = Self::group_errors_by_mod(&problems);

        // Анализ производительности
        let performance = Self::analyze_performance(&lines);

        log::info!(
            "⚡ Total log analysis completed in {}ms (lines: {}, problems: {}, groups: {})",
            parse_time_ms,
            total_lines,
            problems.len(),
            error_groups.len()
        );

        LogAnalysisResult {
            problems,
            summary: AnalysisSummary {
                total_lines,
                error_count,
                warning_count,
                critical_count,
                parse_time_ms,
            },
            optimizations,
            crash_info,
            error_groups,
            performance,
        }
    }

    /// Умная пост-обработка результатов: дедупликация, контекстный анализ, фильтрация
    fn smart_post_processing(
        problems: Vec<DetectedProblem>,
        lines: &[&str],
    ) -> Vec<DetectedProblem> {
        // 1. Группируем похожие проблемы
        let mut deduplicated = Vec::new();
        let mut seen_signatures = std::collections::HashSet::new();

        for problem in problems {
            // Создаём сигнатуру проблемы (category + основные слова из title)
            let signature = Self::problem_signature(&problem);

            if !seen_signatures.contains(&signature) {
                seen_signatures.insert(signature);
                deduplicated.push(problem);
            } else {
                // Дубликат - пропускаем, но могли бы агрегировать
                continue;
            }
        }

        // 2. Анализ цепочек ошибок - найти root causes
        let chain_analysis = Self::analyze_error_chains(lines);

        // 3. Контекстное улучшение описаний с расширенным stack trace
        for problem in &mut deduplicated {
            if let Some(line_num) = problem.line_number {
                // Расширенный контекст: до 30 строк после ошибки для полного stack trace
                let context = Self::extract_context(lines, line_num as usize, 30);

                // Улучшаем описание на основе контекста
                if !problem.description.ends_with('.') {
                    problem.description.push('.');
                }

                // Добавляем hints из расширенного контекстного анализа
                let hints = Self::extract_enhanced_hints(&context, &chain_analysis);
                for hint in hints {
                    problem.description.push_str(&format!(" {}", hint));
                }

                // Добавляем detected mods из stacktrace
                let detected_mods = Self::extract_mods_from_stacktrace(&context);
                for mod_id in detected_mods {
                    if !problem.related_mods.contains(&mod_id) {
                        problem.related_mods.push(mod_id);
                    }
                }
            }
        }

        // 4. Фильтруем низкокачественные детекции (только Warnings с низким confidence)
        deduplicated.retain(|p| {
            // Всегда оставляем Critical и Error
            if matches!(p.severity, Severity::Critical | Severity::Error) {
                return true;
            }

            // Для Warning проверяем качество детекции
            if p.severity == Severity::Warning {
                // Если есть solutions с auto_fix - оставляем
                if p.solutions.iter().any(|s| s.auto_fix.is_some()) {
                    return true;
                }

                // Если success_rate высокий - оставляем
                if p.solutions.iter().any(|s| s.success_rate >= 60) {
                    return true;
                }

                // Если есть related_mods - вероятно полезное
                if !p.related_mods.is_empty() {
                    return true;
                }

                // Иначе это вероятно ложное срабатывание - удаляем
                return false;
            }

            true
        });

        // 5. Переранжируем: проблемы с root cause первыми
        deduplicated.sort_by(|a, b| {
            // Проблемы с related_mods более важны (указывают на конкретный источник)
            let a_has_mods = !a.related_mods.is_empty();
            let b_has_mods = !b.related_mods.is_empty();
            match (b_has_mods, a_has_mods) {
                (true, false) => std::cmp::Ordering::Greater,
                (false, true) => std::cmp::Ordering::Less,
                _ => {
                    // Иначе по severity
                    match b.severity.cmp(&a.severity) {
                        std::cmp::Ordering::Equal => {
                            a.category.priority().cmp(&b.category.priority())
                        }
                        other => other,
                    }
                }
            }
        });

        // Ограничиваем количество проблем (топ-25 самых важных)
        deduplicated.truncate(25);

        deduplicated
    }

    /// Анализ цепочек ошибок - найти связи между проблемами
    /// ОПТИМИЗИРОВАНО: без to_lowercase() аллокаций
    fn analyze_error_chains(lines: &[&str]) -> ErrorChainAnalysis {
        let mut analysis = ErrorChainAnalysis {
            root_causes: Vec::new(),
            caused_by_chains: HashMap::new(),
            exception_sequence: Vec::new(),
        };

        let mut current_exception: Option<String> = None;
        let mut current_chain: Vec<String> = Vec::new();

        // ОПТИМИЗАЦИЯ: case-insensitive contains без аллокаций
        fn contains_ci_local(haystack: &str, needle: &str) -> bool {
            if haystack.len() < needle.len() {
                return false;
            }
            haystack
                .as_bytes()
                .windows(needle.len())
                .any(|window| window.eq_ignore_ascii_case(needle.as_bytes()))
        }

        for (i, line) in lines.iter().enumerate() {
            // ОПТИМИЗАЦИЯ: быстрая проверка без аллокаций
            // Detect exception start (case-sensitive - Exception/Error: всегда с заглавной)
            if line.contains("Exception") || line.contains("Error:") {
                if let Some(prev_exc) = current_exception.take() {
                    // Save previous chain
                    if !current_chain.is_empty() {
                        analysis
                            .caused_by_chains
                            .insert(prev_exc, current_chain.clone());
                        current_chain.clear();
                    }
                }

                // Extract exception type
                let exc_type = Self::extract_exception_type(line);
                if let Some(exc) = exc_type {
                    current_exception = Some(exc.clone());
                    analysis.exception_sequence.push((i, exc));
                }
            }

            // Track "Caused by" chain (case-insensitive)
            if contains_ci_local(line, "caused by:") || contains_ci_local(line, "caused by ") {
                if let Some(cause) = Self::extract_exception_type(line) {
                    current_chain.push(cause.clone());

                    // Root cause is the last "Caused by"
                    if !analysis.root_causes.contains(&cause) {
                        analysis.root_causes.push(cause);
                    }
                }
            }
        }

        // Save last chain
        if let Some(exc) = current_exception {
            if !current_chain.is_empty() {
                analysis.caused_by_chains.insert(exc, current_chain);
            }
        }

        analysis
    }

    /// Extract exception type from error line
    fn extract_exception_type(line: &str) -> Option<String> {
        // Pattern: SomeException: message or Caused by: SomeException: message
        let patterns = [
            r"(?:Caused by:\s*)?(\w+(?:\.\w+)*(?:Exception|Error))",
            r"(\w+(?:\.\w+)*(?:Exception|Error)):",
        ];

        for pattern in patterns {
            if let Ok(re) = Regex::new(pattern) {
                if let Some(caps) = re.captures(line) {
                    if let Some(m) = caps.get(1) {
                        return Some(m.as_str().to_string());
                    }
                }
            }
        }
        None
    }

    /// Извлечь улучшенные hints из контекста с учётом цепочек ошибок
    /// ОПТИМИЗИРОВАНО: без to_lowercase() аллокаций
    fn extract_enhanced_hints(
        context: &[String],
        chain_analysis: &ErrorChainAnalysis,
    ) -> Vec<String> {
        let mut hints = Vec::new();

        // ОПТИМИЗАЦИЯ: case-insensitive contains без аллокаций
        fn contains_ci_local(haystack: &str, needle: &str) -> bool {
            if haystack.len() < needle.len() {
                return false;
            }
            haystack
                .as_bytes()
                .windows(needle.len())
                .any(|window| window.eq_ignore_ascii_case(needle.as_bytes()))
        }

        // 1. Найти root cause из "Caused by" цепочки
        let mut found_caused_by = false;
        let mut root_cause_line: Option<&String> = None;

        for line in context.iter().rev() {
            if contains_ci_local(line, "caused by:") || contains_ci_local(line, "caused by ") {
                found_caused_by = true;
                root_cause_line = Some(line);
            }
        }

        if let Some(cause_line) = root_cause_line {
            // Extract just the cause message
            if let Some(cause) = cause_line
                .split("Caused by:")
                .nth(1)
                .or_else(|| cause_line.split("caused by:").nth(1))
                .or_else(|| cause_line.split("Caused by ").nth(1))
            {
                let cause = cause.trim();
                if !cause.is_empty() && cause.len() < 150 {
                    hints.push(format!("Причина: {}", cause));
                }
            }
        }

        // 2. Найти виновный мод из stack trace
        let mut found_mod = false;
        for line in context {
            if found_mod {
                break;
            }

            if line.contains("at ") && line.contains("(") {
                // Parse stack frame: at com.example.mod.Class.method(File.java:123)
                if let Some(class_info) = line.split("at ").nth(1) {
                    if let Some(class_path) = class_info.split('(').next() {
                        let class_path = class_path.trim();

                        // Skip system packages
                        if class_path.starts_with("java.")
                            || class_path.starts_with("sun.")
                            || class_path.starts_with("jdk.")
                            || class_path.starts_with("org.lwjgl.")
                        {
                            continue;
                        }

                        // Skip Minecraft core
                        if class_path.starts_with("net.minecraft.")
                            || class_path.starts_with("com.mojang.")
                        {
                            continue;
                        }

                        // Try to identify mod
                        if let Some(mod_id) = Self::identify_mod_from_class(class_path) {
                            hints.push(format!("Виновник: {}", mod_id));
                            found_mod = true;
                        }
                    }
                }
            }
        }

        // 3. Добавить info о root causes из chain analysis
        // Но только если это не стандартное Java исключение
        if !chain_analysis.root_causes.is_empty() && !found_caused_by {
            // Фильтруем бесполезные root causes - это стандартные Java исключения
            const USELESS_ROOT_CAUSES: &[&str] = &[
                // Network exceptions - not helpful for crash debugging
                "ConnectException", "IOException", "SocketException", "SocketTimeoutException",
                "UnresolvedAddressException", "UnknownHostException", "BindException",
                "PortUnreachableException", "NoRouteToHostException",
                // Standard Java exceptions - too generic
                "FileNotFoundException", "NullPointerException", "IllegalStateException",
                "IllegalArgumentException", "IndexOutOfBoundsException", "ClassCastException",
                "NoSuchMethodError", "NoSuchFieldError", "NoClassDefFoundError",
                "UnsupportedOperationException", "RuntimeException", "Exception",
                "Error", "Throwable", "AssertionError",
            ];

            // Находим первый полезный root cause
            let useful_root = chain_analysis.root_causes.iter()
                .map(|r| r.split('.').last().unwrap_or(r))
                .find(|root_name| !USELESS_ROOT_CAUSES.contains(root_name));

            if let Some(root_name) = useful_root {
                if !hints.iter().any(|h| h.contains(root_name)) {
                    hints.push(format!("Root cause: {}", root_name));
                }
            }
        }

        // 4. Ищем специфические ключевые слова в контексте
        for line in context {
            // ОПТИМИЗАЦИЯ: без to_lowercase() аллокаций
            // Missing dependency hints
            if contains_ci_local(line, "requires") && contains_ci_local(line, "version") {
                if hints.len() < 3 {
                    // Extract version requirement
                    if let Some(req) = Self::extract_version_requirement(line) {
                        hints.push(format!("Требуется: {}", req));
                    }
                }
            }

            // Mixin error specifics
            if contains_ci_local(line, "mixin") && contains_ci_local(line, "failed") {
                if let Some(target) = Self::extract_mixin_target(line) {
                    hints.push(format!("Mixin target: {}", target));
                }
            }
        }

        // Limit hints to avoid cluttering
        hints.truncate(3);
        hints
    }

    /// Extract version requirement from line
    fn extract_version_requirement(line: &str) -> Option<String> {
        // Pattern: requires modname version X.X.X or modname >= X.X.X
        let re =
            Regex::new(r"requires?\s+(\S+)\s+(?:version\s+)?([<>=!~]+\s*)?(\d+[.\d]*\S*)").ok()?;
        if let Some(caps) = re.captures(line) {
            let mod_name = caps.get(1).map(|m| m.as_str()).unwrap_or("unknown");
            let version = caps.get(3).map(|m| m.as_str()).unwrap_or("?");
            return Some(format!("{} {}", mod_name, version));
        }
        None
    }

    /// Extract mixin target from error line
    fn extract_mixin_target(line: &str) -> Option<String> {
        // Look for class being targeted (quotes are optional)
        let re = Regex::new(r#"(?:target|into|class)\s+['"]?(\S+)['"]?"#).ok()?;
        if let Some(caps) = re.captures(line) {
            if let Some(m) = caps.get(1) {
                return Some(m.as_str().to_string());
            }
        }
        None
    }

    /// Extract all mods mentioned in stacktrace context
    fn extract_mods_from_stacktrace(context: &[String]) -> Vec<String> {
        let mut mods = Vec::new();
        let mut seen = std::collections::HashSet::new();

        for line in context {
            if line.contains("at ") && line.contains("(") {
                if let Some(class_info) = line.split("at ").nth(1) {
                    if let Some(class_path) = class_info.split('(').next() {
                        let class_path = class_path.trim();

                        // Skip system packages
                        if class_path.starts_with("java.")
                            || class_path.starts_with("sun.")
                            || class_path.starts_with("jdk.")
                            || class_path.starts_with("org.lwjgl.")
                            || class_path.starts_with("net.minecraft.")
                            || class_path.starts_with("com.mojang.")
                        {
                            continue;
                        }

                        if let Some(mod_id) = Self::identify_mod_from_class(class_path) {
                            if !seen.contains(&mod_id) {
                                seen.insert(mod_id.clone());
                                mods.push(mod_id);
                            }
                        }
                    }
                }
            }
        }

        // Limit to top 5 most relevant mods
        mods.truncate(5);
        mods
    }

    /// Identify mod from class path using known mappings and heuristics
    fn identify_mod_from_class(class_path: &str) -> Option<String> {
        use mappings::{FRAMEWORK_PACKAGES, LIBRARY_PACKAGES};

        let parts: Vec<&str> = class_path.split('.').collect();
        if parts.is_empty() {
            return None;
        }

        // 0. СНАЧАЛА проверяем library пакеты - они НИКОГДА не виновники
        for lib in LIBRARY_PACKAGES {
            if class_path.starts_with(lib) {
                return None; // Library = не виновник
            }
        }

        // 0.1 Проверяем framework пакеты - они тоже НИКОГДА не виновники
        for framework in FRAMEWORK_PACKAGES {
            if class_path.starts_with(framework) {
                return None; // Framework = не виновник
            }
        }

        // 1. Check known package mappings
        for (package_parts, mod_id) in KNOWN_PACKAGE_MAPPINGS {
            if parts.len() >= package_parts.len() {
                let matches = package_parts
                    .iter()
                    .zip(parts.iter())
                    .all(|(expected, actual)| expected == actual);

                if matches {
                    // Системные идентификаторы (loaders, minecraft) = НЕ виновники
                    // ВАЖНО: возвращаем None, а не падаем в эвристику!
                    if mod_id.starts_with("__") {
                        return None; // Loader/Minecraft/Library = не виновник
                    }
                    return Some(mod_id.to_string());
                }
            }
        }

        // 2. Heuristic: extract mod id from package structure
        // Pattern: com.author.modname.* or author.modname.*
        if parts.len() >= 3 {
            // Skip common prefixes
            let start_idx = if parts[0] == "com"
                || parts[0] == "org"
                || parts[0] == "net"
                || parts[0] == "io"
            {
                2 // Skip com/org/net.author, take modname
            } else {
                1 // Skip author, take modname
            };

            if parts.len() > start_idx {
                let mod_id = parts[start_idx];
                let mod_id_lower = mod_id.to_lowercase();

                // Blacklist для framework-подобных имён которые НЕ являются модами
                const FRAMEWORK_NAMES: &[&str] = &[
                    // Mod loaders
                    "fml", "eventbus", "modlauncher", "bootstraplauncher",
                    "forge", "neoforge", "neoforged", "minecraftforge",
                    "fabric", "fabricmc", "quilt", "quiltmc",
                    "mixin", "asm", "sponge", "spongepowered",
                    // Generic names
                    "common", "client", "server", "api", "core",
                    "loader", "bootstrap", "launch", "launcher",
                    "util", "utils", "helper", "helpers", "lib", "library",
                    // Libraries
                    "registrate", "gson", "guava", "netty", "lwjgl",
                    "apache", "slf4j", "log4j", "twelvemonkeys",
                    "geckolib", "lodestone", "moonlight", "architectury",
                    "caffeine", "jctools", "objectweb",
                    // Author names (NOT mod IDs!)
                    "eliotlash", "bernie", "jellysquid", "caffeinemc",
                    "tterrag", "simibubi", "vazkii", "mezz",
                ];

                if FRAMEWORK_NAMES.contains(&mod_id_lower.as_str()) {
                    return None; // Framework name = не виновник
                }

                // Validate it looks like a mod id
                if mod_id.len() >= 3
                    && !mod_id.starts_with("mojang")
                    && !mod_id.starts_with("minecraft")
                    && mod_id
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_')
                {
                    return Some(mod_id_lower);
                }
            }
        }

        None
    }

    /// Создать сигнатуру проблемы для дедупликации
    fn problem_signature(problem: &DetectedProblem) -> String {
        // Используем category + ключевые слова из title (без чисел и специфичных имён)
        let category = format!("{:?}", problem.category);
        let title_words: Vec<&str> = problem
            .title
            .split_whitespace()
            .filter(|w| w.len() > 3) // Игнорируем короткие слова
            .filter(|w| !w.chars().all(|c| c.is_numeric())) // Игнорируем числа
            .take(3) // Берём первые 3 ключевых слова
            .collect();

        format!("{}:{}", category, title_words.join("_"))
    }

    /// Извлечь контекст вокруг строки с ошибкой
    fn extract_context(lines: &[&str], line_idx: usize, radius: usize) -> Vec<String> {
        let start = line_idx.saturating_sub(radius);
        let end = (line_idx + radius + 1).min(lines.len());

        lines[start..end].iter().map(|s| s.to_string()).collect()
    }

    /// Парсить краш-репорт (расширенный парсер)
    fn parse_crash_report(content: &str) -> Option<CrashInfo> {
        let mut main_cause = String::new();
        let mut stack_trace = Vec::new();
        let mut culprit_mod: Option<String> = None;
        let mut minecraft_version: Option<String> = None;
        let mut mod_loader: Option<String> = None;
        let mut loader_version: Option<String> = None;
        let mut java_version: Option<String> = None;
        let mut operating_system: Option<String> = None;
        let mut crash_time: Option<String> = None;
        let mut loaded_mods: Vec<ModInfo> = Vec::new();
        let mut affected_level: Option<AffectedLevel> = None;
        let mut system_info = SystemInfo {
            memory: None,
            cpu: None,
            gpu: None,
            opengl_version: None,
        };

        let mut in_stack_trace = false;
        let mut in_mod_list = false;
        let mut in_system_details = false;
        let mut in_affected_level = false;

        for line in content.lines() {
            let line_trimmed = line.trim();

            // === ОСНОВНАЯ ИНФОРМАЦИЯ ===

            // Описание краша
            if line.starts_with("Description:") {
                main_cause = line.replace("Description:", "").trim().to_string();
            }

            // Время краша
            if line.starts_with("Time:") {
                crash_time = Some(line.replace("Time:", "").trim().to_string());
            }

            // === ВЕРСИИ ===

            // Minecraft Version
            if line.contains("Minecraft Version:") || line.contains("Minecraft Version ID:") {
                minecraft_version = line.split(':').nth(1).map(|s| s.trim().to_string());
            }

            // Java Version
            if line.contains("Java Version:") || line.contains("Java is") {
                java_version = line
                    .split(':')
                    .nth(1)
                    .or_else(|| line.split("is").nth(1))
                    .map(|s| s.trim().to_string());
            }

            // Operating System
            if line.contains("Operating System:") {
                operating_system = line.split(':').nth(1).map(|s| s.trim().to_string());
            }

            // === ЗАГРУЗЧИК ===

            // Fabric Loader
            if line.contains("Fabric Loader") || line.contains("fabricloader") {
                mod_loader = Some("fabric".into());
                // Пытаемся извлечь версию: fabricloader 0.15.0
                if let Some(ver) =
                    Self::extract_version_from_line(line, &["fabricloader", "Fabric Loader"])
                {
                    loader_version = Some(ver);
                }
            }
            // Forge
            else if line.contains("Forge Mod Loader")
                || line.contains("MinecraftForge")
                || line.contains("net.minecraftforge")
            {
                mod_loader = Some("forge".into());
                // forge-1.20.1-47.2.0
                if let Some(ver) =
                    Self::extract_version_from_line(line, &["forge-", "MinecraftForge"])
                {
                    loader_version = Some(ver);
                }
            }
            // NeoForge
            else if line.contains("NeoForge") || line.contains("neoforge") {
                mod_loader = Some("neoforge".into());
                if let Some(ver) = Self::extract_version_from_line(line, &["neoforge-", "NeoForge"])
                {
                    loader_version = Some(ver);
                }
            }
            // Quilt
            else if line.contains("Quilt Loader") || line.contains("quilt_loader") {
                mod_loader = Some("quilt".into());
                if let Some(ver) =
                    Self::extract_version_from_line(line, &["quilt_loader", "Quilt Loader"])
                {
                    loader_version = Some(ver);
                }
            }

            // === СПИСОК МОДОВ ===

            // Начало списка модов
            if line.contains("Mod List:")
                || line.contains("Loaded Mods:")
                || line.contains("Mods:") && line.contains("loaded")
            {
                in_mod_list = true;
                continue;
            }

            // Парсим моды в формате: modid@version или modid (version) или |modid|version|file.jar|
            if in_mod_list {
                if line_trimmed.is_empty() || line_trimmed.starts_with("--") {
                    in_mod_list = false;
                } else if let Some(mod_info) = Self::parse_mod_line(line_trimmed) {
                    loaded_mods.push(mod_info);
                }
            }

            // === SYSTEM DETAILS ===

            if line.contains("-- System Details --") {
                in_system_details = true;
            }

            if in_system_details {
                // Memory
                if line.contains("Memory:") {
                    system_info.memory = line.split(':').nth(1).map(|s| s.trim().to_string());
                }
                // CPU
                if line.contains("Processor:") || line.contains("CPU:") {
                    system_info.cpu = line.split(':').nth(1).map(|s| s.trim().to_string());
                }
                // OpenGL
                if line.contains("GL version") || line.contains("OpenGL:") {
                    system_info.opengl_version =
                        line.split(':').nth(1).map(|s| s.trim().to_string());
                }
                // GPU
                if line.contains("GL Renderer") || line.contains("Graphics:") {
                    system_info.gpu = line.split(':').nth(1).map(|s| s.trim().to_string());
                }
            }

            // === AFFECTED LEVEL ===

            if line.contains("-- Affected level --") || line.contains("Affected level:") {
                in_affected_level = true;
            }

            if in_affected_level {
                if line.contains("Level name:") || line.contains("All players:") {
                    let level_name = line
                        .split(':')
                        .nth(1)
                        .map(|s| s.trim().to_string())
                        .unwrap_or_default();
                    affected_level = Some(AffectedLevel {
                        name: level_name,
                        dimension: None,
                        coordinates: None,
                    });
                }
                if line.contains("Dimension:") {
                    if let Some(ref mut level) = affected_level {
                        level.dimension = line.split(':').nth(1).map(|s| s.trim().to_string());
                    }
                }
                if line_trimmed.is_empty() || line_trimmed.starts_with("--") {
                    in_affected_level = false;
                }
            }

            // === STACK TRACE ===

            if line.contains("Stacktrace:")
                || (line.contains("at ") && line.contains("(") && line.contains(")"))
            {
                in_stack_trace = true;
            }

            if in_stack_trace && line_trimmed.starts_with("at ") {
                stack_trace.push(line_trimmed.to_string());
            }

            // Конец stack trace
            if in_stack_trace && line_trimmed.is_empty() {
                in_stack_trace = false;
            }
        }

        // === УМНОЕ ОПРЕДЕЛЕНИЕ ВИНОВНИКА ===
        // Анализируем весь stack trace для нахождения реального виновника
        culprit_mod = Self::find_culprit_from_stacktrace(&stack_trace, &loaded_mods);

        // Генерируем рекомендации на основе собранной информации
        let recommendations =
            Self::generate_crash_recommendations(&main_cause, culprit_mod.as_deref(), &loaded_mods);

        Some(CrashInfo {
            main_cause,
            stack_trace,
            culprit_mod,
            recommendations,
            minecraft_version,
            mod_loader,
            loader_version,
            java_version,
            operating_system,
            loaded_mods,
            crash_time,
            affected_level,
            system_info: if system_info.memory.is_some() || system_info.cpu.is_some() {
                Some(system_info)
            } else {
                None
            },
        })
    }

    /// Умный поиск виновника в stacktrace
    /// Анализирует весь стек, извлекает jar файлы, ранжирует кандидатов
    fn find_culprit_from_stacktrace(
        stack_trace: &[String],
        loaded_mods: &[ModInfo],
    ) -> Option<String> {
        use mappings::FRAMEWORK_PACKAGES;

        // Структура для хранения кандидата на виновника
        #[derive(Debug)]
        struct CulpritCandidate {
            mod_id: String,
            jar_file: Option<String>,
            position: usize, // Позиция в стеке (меньше = ближе к исключению)
            score: i32,      // Итоговый скор (больше = вероятнее виновник)
        }

        let mut candidates: Vec<CulpritCandidate> = Vec::new();
        let mut seen_mods = std::collections::HashSet::new();

        for (position, line) in stack_trace.iter().enumerate() {
            // Пропускаем строки которые не являются stack frame
            if !line.contains("at ") || !line.contains("(") {
                continue;
            }

            // Извлекаем путь класса и jar файл
            // Формат: at com.example.Mod.method(File.java:123) ~[modname-1.0.jar:?]
            let class_part = line
                .split('(')
                .next()
                .unwrap_or("")
                .replace("at ", "")
                .trim()
                .to_string();

            // Извлекаем имя jar файла из [...jar...]
            let jar_file: Option<String> = if let Some(bracket_start) = line.find('[') {
                if let Some(bracket_end) = line.find(']') {
                    let bracket_content = &line[bracket_start + 1..bracket_end];
                    // Ищем .jar в содержимом
                    if bracket_content.contains(".jar") {
                        // Извлекаем имя файла до :
                        let jar_name = bracket_content.split(':').next().unwrap_or("");
                        if jar_name.ends_with(".jar") {
                            Some(jar_name.to_string())
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            };

            // Пропускаем framework пакеты
            let is_framework = FRAMEWORK_PACKAGES
                .iter()
                .any(|fw| class_part.starts_with(fw));
            if is_framework {
                continue;
            }

            // Пропускаем системные пакеты
            if class_part.starts_with("java.")
                || class_part.starts_with("jdk.")
                || class_part.starts_with("sun.")
                || class_part.starts_with("net.minecraft.")
                || class_part.starts_with("com.mojang.")
                || class_part.starts_with("org.lwjgl.")
                || class_part.starts_with("io.netty.")
                || class_part.starts_with("com.google.")
                || class_part.starts_with("org.apache.")
            {
                continue;
            }

            // Пробуем определить mod_id
            if let Some(mod_id) = Self::identify_mod_from_class(&class_part) {
                // Избегаем дубликатов
                if seen_mods.contains(&mod_id) {
                    continue;
                }
                seen_mods.insert(mod_id.clone());

                // Вычисляем начальный скор на основе позиции
                // Ближе к началу стека (exception) = выше скор
                let mut score = 100 - (position as i32).min(100);

                // Бонус если есть jar файл
                if let Some(ref jar) = jar_file {
                    score += 20;

                    // Дополнительный бонус если jar содержит mod_id
                    let jar_lower = jar.to_lowercase();
                    if jar_lower.contains(&mod_id.to_lowercase()) {
                        score += 30;
                    }
                }

                // Бонус если мод есть в списке загруженных модов
                let is_loaded = loaded_mods
                    .iter()
                    .any(|m| m.id.to_lowercase() == mod_id.to_lowercase());
                if is_loaded {
                    score += 25;
                }

                // Штраф за библиотечные/API моды (часто появляются в стеке, но редко виновники)
                let is_lib = mod_id.contains("lib")
                    || mod_id.contains("api")
                    || mod_id == "registrate"
                    || mod_id == "flywheel"
                    || mod_id == "geckolib"
                    || mod_id == "architectury"
                    || mod_id == "cloth"
                    || mod_id == "placebo";
                if is_lib {
                    score -= 40;
                }

                // Штраф за utility/UI моды (они хукаются везде, но редко виновники)
                // Например map моды появляются в rendering стеке, но не вызывают ошибки
                let is_utility_mod = mod_id.contains("xaero")
                    || mod_id.contains("minimap")
                    || mod_id.contains("worldmap")
                    || mod_id == "journeymap"
                    || mod_id == "voxelmap"
                    || mod_id.contains("waila")
                    || mod_id == "jade"
                    || mod_id == "theoneprobe"
                    || mod_id == "jei"
                    || mod_id == "emi"
                    || mod_id.contains("rei");
                if is_utility_mod {
                    score -= 35;
                }

                candidates.push(CulpritCandidate {
                    mod_id,
                    jar_file,
                    position,
                    score,
                });
            }
        }

        // Дополнительный анализ: извлекаем mod_id из jar файлов
        // Это помогает когда package mapping не работает
        for (position, line) in stack_trace.iter().enumerate() {
            if let Some(bracket_start) = line.find('[') {
                if let Some(bracket_end) = line.find(']') {
                    let bracket_content = &line[bracket_start + 1..bracket_end];
                    if let Some(jar_name) = bracket_content.split(':').next() {
                        if jar_name.ends_with(".jar") {
                            // Извлекаем mod_id из имени jar
                            // Примеры: create-1.20.1-6.0.8.jar → create
                            //          jei-1.20.1-15.2.0.jar → jei
                            if let Some(mod_id) = Self::extract_mod_id_from_jar_name(jar_name) {
                                if !seen_mods.contains(&mod_id) {
                                    seen_mods.insert(mod_id.clone());

                                    let mut score = 90 - (position as i32).min(90);

                                    // Бонус за точное совпадение с загруженным модом
                                    let is_loaded = loaded_mods
                                        .iter()
                                        .any(|m| m.id.to_lowercase() == mod_id.to_lowercase());
                                    if is_loaded {
                                        score += 30;
                                    }

                                    // Пропускаем системные jar файлы
                                    let jar_lower = jar_name.to_lowercase();
                                    if jar_lower.contains("minecraft")
                                        || jar_lower.contains("forge-")
                                        || jar_lower.contains("neoforge-")
                                        || jar_lower.contains("fabric")
                                        || jar_lower.contains("fml")
                                        || jar_lower.contains("modlauncher")
                                        || jar_lower.contains("eventbus")
                                    {
                                        continue;
                                    }

                                    candidates.push(CulpritCandidate {
                                        mod_id,
                                        jar_file: Some(jar_name.to_string()),
                                        position,
                                        score,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }

        // Сортируем по скору (больше = лучше)
        candidates.sort_by(|a, b| b.score.cmp(&a.score));

        // Логируем для отладки
        if !candidates.is_empty() {
            log::debug!(
                "🔍 Culprit candidates: {:?}",
                candidates
                    .iter()
                    .take(5)
                    .map(|c| format!("{}(score={})", c.mod_id, c.score))
                    .collect::<Vec<_>>()
            );
        }

        // Возвращаем лучшего кандидата
        candidates.first().map(|c| c.mod_id.clone())
    }

    /// Извлечь mod_id из имени jar файла
    /// Примеры:
    /// - create-1.20.1-6.0.8.jar → Some("create")
    /// - jei-1.20.1-forge-15.2.0.jar → Some("jei")
    /// - TConstruct-1.20.1-3.8.3.jar → Some("tconstruct")
    fn extract_mod_id_from_jar_name(jar_name: &str) -> Option<String> {
        // Убираем .jar расширение
        let name = jar_name.trim_end_matches(".jar");

        // Разбиваем по - или _
        let parts: Vec<&str> = name.split(|c| c == '-' || c == '_').collect();
        if parts.is_empty() {
            return None;
        }

        // Первая часть обычно mod_id (до версии)
        let first_part = parts[0].to_lowercase();

        // Проверяем что это не версия (не начинается с цифры)
        if first_part.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(true) {
            return None;
        }

        // Минимальная длина для mod_id
        if first_part.len() < 2 {
            return None;
        }

        // Blacklist системных jar имён
        const SYSTEM_JARS: &[&str] = &[
            "minecraft", "forge", "neoforge", "fabric", "quilt",
            "fml", "loader", "modlauncher", "eventbus", "bootstrap",
            "client", "server", "common", "api", "lib",
        ];

        if SYSTEM_JARS.contains(&first_part.as_str()) {
            return None;
        }

        Some(first_part)
    }

    /// Извлечь версию из строки по ключевым словам
    fn extract_version_from_line(line: &str, keywords: &[&str]) -> Option<String> {
        for keyword in keywords {
            if let Some(pos) = line.find(keyword) {
                let after = &line[pos + keyword.len()..];
                // Ищем версию: число с точками
                let version: String = after
                    .trim()
                    .chars()
                    .take_while(|c| c.is_ascii_digit() || *c == '.' || *c == '-' || *c == '_')
                    .collect();
                if !version.is_empty() && version.contains('.') {
                    return Some(version.trim_matches(|c| c == '-' || c == '_').to_string());
                }
            }
        }
        None
    }

    /// Парсить строку с информацией о моде
    fn parse_mod_line(line: &str) -> Option<ModInfo> {
        let line = line.trim();
        if line.is_empty() || line.starts_with("--") {
            return None;
        }

        // Формат 1: modid@version (Fabric/Quilt)
        if line.contains('@') {
            let parts: Vec<&str> = line.splitn(2, '@').collect();
            if parts.len() == 2 {
                return Some(ModInfo {
                    id: parts[0].trim().to_string(),
                    version: parts[1].trim().to_string(),
                    file: None,
                });
            }
        }

        // Формат 2: |modid|version|file.jar| (Forge)
        if line.starts_with('|') && line.contains('|') {
            let parts: Vec<&str> = line.split('|').filter(|s| !s.is_empty()).collect();
            if parts.len() >= 2 {
                return Some(ModInfo {
                    id: parts[0].trim().to_string(),
                    version: parts[1].trim().to_string(),
                    file: parts.get(2).map(|s| s.trim().to_string()),
                });
            }
        }

        // Формат 3: modid (version) или modid version
        let re = Regex::new(r"^(\S+)[\s\(]+([0-9][^\s\)]+)").ok()?;
        if let Some(caps) = re.captures(line) {
            return Some(ModInfo {
                id: caps.get(1)?.as_str().to_string(),
                version: caps.get(2)?.as_str().to_string(),
                file: None,
            });
        }

        None
    }

    /// Генерировать рекомендации на основе краш-информации
    fn generate_crash_recommendations(
        main_cause: &str,
        culprit_mod: Option<&str>,
        loaded_mods: &[ModInfo],
    ) -> Vec<String> {
        let mut recommendations = Vec::new();
        let cause_lower = main_cause.to_lowercase();

        // Рекомендации на основе типа краша
        if cause_lower.contains("outofmemory") || cause_lower.contains("out of memory") {
            recommendations.push("Увеличьте выделенную память (RAM) в настройках JVM".into());
            recommendations.push("Попробуйте добавить -XX:+UseG1GC в JVM аргументы".into());
        }

        if cause_lower.contains("mixin") {
            recommendations
                .push("Конфликт Mixin - попробуйте удалить недавно добавленные моды".into());
            if let Some(mod_id) = culprit_mod {
                recommendations.push(format!(
                    "Проверьте совместимость мода '{}' с другими модами",
                    mod_id
                ));
            }
        }

        if cause_lower.contains("nullpointer") {
            if let Some(mod_id) = culprit_mod {
                recommendations.push(format!("Обновите мод '{}' до последней версии", mod_id));
            }
            recommendations.push("Проверьте, что все зависимости модов установлены".into());
        }

        if cause_lower.contains("classnotfound") || cause_lower.contains("nosuchmethod") {
            recommendations.push("Проверьте совместимость версий модов с версией Minecraft".into());
            recommendations.push(
                "Возможно, отсутствует зависимость или установлена неправильная версия".into(),
            );
        }

        if cause_lower.contains("opengl") || cause_lower.contains("lwjgl") {
            recommendations.push("Обновите драйверы видеокарты".into());
            recommendations
                .push("Попробуйте отключить шейдеры и моды на оптимизацию графики".into());
        }

        // Рекомендация про виновника
        if let Some(mod_id) = culprit_mod {
            if !recommendations.iter().any(|r| r.contains(mod_id)) {
                recommendations.push(format!(
                    "Мод '{}' вероятно вызвал краш - попробуйте обновить или удалить его",
                    mod_id
                ));
            }
        }

        // Общие рекомендации
        if loaded_mods.len() > 100 {
            recommendations.push(format!(
                "У вас установлено {} модов - попробуйте отключить часть для диагностики",
                loaded_mods.len()
            ));
        }

        recommendations.truncate(5);
        recommendations
    }

    /// Группировать ошибки по модам
    fn group_errors_by_mod(problems: &[DetectedProblem]) -> Vec<ErrorGroup> {
        let mut groups: HashMap<String, Vec<DetectedProblem>> = HashMap::new();

        for problem in problems {
            // Определяем группу для проблемы
            let group_key = if !problem.related_mods.is_empty() {
                // Группируем по первому связанному моду
                problem.related_mods[0].clone()
            } else {
                // Группируем по категории
                format!("{:?}", problem.category)
            };

            groups.entry(group_key).or_default().push(problem.clone());
        }

        // Конвертируем в ErrorGroup
        let mut result: Vec<ErrorGroup> = groups
            .into_iter()
            .map(|(name, problems)| {
                // Определяем максимальную severity в группе
                let severity = problems
                    .iter()
                    .map(|p| p.severity)
                    .max()
                    .unwrap_or(Severity::Info);

                let count = problems.len() as u32;

                ErrorGroup {
                    id: format!("group_{}", name.to_lowercase().replace(' ', "_")),
                    name,
                    problems,
                    severity,
                    count,
                }
            })
            .collect();

        // Сортируем по severity (критичные первыми) и количеству ошибок
        result.sort_by(|a, b| match b.severity.cmp(&a.severity) {
            std::cmp::Ordering::Equal => b.count.cmp(&a.count),
            other => other,
        });

        result
    }

    /// Анализ производительности из лога
    fn analyze_performance(lines: &[&str]) -> Option<PerformanceAnalysis> {
        use lazy_static::lazy_static;

        lazy_static! {
            // Кешированные regex для производительности
            static ref TPS_RE: Regex = Regex::new(r"(?i)(?:TPS|ticks per second)[:\s]+(\d+\.?\d*)").unwrap();
            static ref MEMORY_RE: Regex = Regex::new(r"(?i)(?:Memory|Mem)[:\s]+(\d+)(?:MB|M)?/(\d+)(?:MB|M)?").unwrap();
            static ref GC_RE: Regex = Regex::new(r"(?i)GC.*?(\d+)ms").unwrap();
            static ref LAG_RE: Regex = Regex::new(r"(?i)(?:server|tick)\s+(?:overloaded|lagging|running)\s+(\d+)ms\s+behind").unwrap();
            static ref TICK_TIME_RE: Regex = Regex::new(r"(?i)\[(\w+)\].*?tick.*?(\d+\.?\d*)ms").unwrap();
            // Дополнительные паттерны
            static ref SPARK_PROFILE_RE: Regex = Regex::new(r"(?i)(?:Spark|profiler).*?(\w+).*?(\d+\.?\d*)%").unwrap();
            static ref CHUNK_LOAD_RE: Regex = Regex::new(r"(?i)chunk.*?load.*?(\d+)ms").unwrap();
            static ref ENTITY_COUNT_RE: Regex = Regex::new(r"(?i)entities[:\s]+(\d+)").unwrap();
            static ref LOADED_CHUNKS_RE: Regex = Regex::new(r"(?i)chunks[:\s]+(\d+)").unwrap();
        }

        let mut tps_issues = Vec::new();
        let mut memory_issues = Vec::new();
        let mut lag_spikes = Vec::new();
        let mut slow_mods: HashMap<String, Vec<f32>> = HashMap::new();
        let mut entity_counts: Vec<u64> = Vec::new();
        let mut chunk_counts: Vec<u64> = Vec::new();

        // ОПТИМИЗАЦИЯ: case-insensitive поиск без аллокаций
        fn contains_ci_perf(haystack: &str, needle: &str) -> bool {
            if haystack.len() < needle.len() {
                return false;
            }
            haystack
                .as_bytes()
                .windows(needle.len())
                .any(|window| window.eq_ignore_ascii_case(needle.as_bytes()))
        }

        for line in lines {
            let line_str = *line;

            // Проверяем TPS
            if let Some(caps) = TPS_RE.captures(line_str) {
                if let Ok(tps) = caps
                    .get(1)
                    .map(|m| m.as_str())
                    .unwrap_or("20")
                    .parse::<f32>()
                {
                    if tps < 18.0 {
                        tps_issues.push(TpsIssue {
                            current_tps: tps,
                            expected_tps: 20.0,
                            cause: None,
                            log_line: Some(line_str.to_string()),
                        });
                    }
                }
            }

            // Проверяем использование памяти
            if let Some(caps) = MEMORY_RE.captures(line_str) {
                let used: u64 = caps
                    .get(1)
                    .and_then(|m| m.as_str().parse().ok())
                    .unwrap_or(0);
                let available: u64 = caps
                    .get(2)
                    .and_then(|m| m.as_str().parse().ok())
                    .unwrap_or(0);

                if available > 0 {
                    let usage_percent = (used as f64 / available as f64) * 100.0;
                    if usage_percent > 85.0 {
                        memory_issues.push(MemoryIssue {
                            issue_type: MemoryIssueType::HighHeapUsage,
                            used_mb: Some(used),
                            available_mb: Some(available),
                            description: format!(
                                "Высокое использование памяти: {}%",
                                usage_percent as u32
                            ),
                        });
                    }
                }
            }

            // Проверяем частый GC
            if let Some(caps) = GC_RE.captures(line_str) {
                if let Ok(gc_time) = caps
                    .get(1)
                    .map(|m| m.as_str())
                    .unwrap_or("0")
                    .parse::<u64>()
                {
                    if gc_time > 100 {
                        memory_issues.push(MemoryIssue {
                            issue_type: MemoryIssueType::FrequentGc,
                            used_mb: None,
                            available_mb: None,
                            description: format!("Долгая сборка мусора (GC): {}ms", gc_time),
                        });
                    }
                }
            }

            // Проверяем лаги сервера
            if let Some(caps) = LAG_RE.captures(line_str) {
                if let Ok(ms_behind) = caps
                    .get(1)
                    .map(|m| m.as_str())
                    .unwrap_or("0")
                    .parse::<u64>()
                {
                    lag_spikes.push(LagSpike {
                        duration_ms: ms_behind,
                        timestamp: None,
                        cause: Some("Server tick lag".into()),
                    });
                }
            }

            // Общие паттерны лагов (без to_lowercase аллокаций)
            if contains_ci_perf(line_str, "server overloaded")
                || contains_ci_perf(line_str, "can't keep up")
            {
                lag_spikes.push(LagSpike {
                    duration_ms: 0,
                    timestamp: None,
                    cause: Some("Server overloaded".into()),
                });
            }

            // Проверяем время tick для модов
            if let Some(caps) = TICK_TIME_RE.captures(line_str) {
                let mod_id = caps
                    .get(1)
                    .map(|m| m.as_str().to_lowercase())
                    .unwrap_or_default();
                let tick_ms: f32 = caps
                    .get(2)
                    .and_then(|m| m.as_str().parse().ok())
                    .unwrap_or(0.0);

                if tick_ms > 1.0 && !mod_id.is_empty() {
                    slow_mods.entry(mod_id).or_default().push(tick_ms);
                }
            }

            // Проверяем Spark профилирование
            if let Some(caps) = SPARK_PROFILE_RE.captures(line_str) {
                let mod_id = caps
                    .get(1)
                    .map(|m| m.as_str().to_lowercase())
                    .unwrap_or_default();
                let cpu_percent: f32 = caps
                    .get(2)
                    .and_then(|m| m.as_str().parse().ok())
                    .unwrap_or(0.0);

                // Конвертируем CPU% в примерное tick time (20 TPS = 50ms/tick)
                if cpu_percent > 5.0 && !mod_id.is_empty() {
                    let estimated_tick_ms = cpu_percent * 0.5; // ~50ms total per tick
                    slow_mods.entry(mod_id).or_default().push(estimated_tick_ms);
                }
            }

            // Собираем статистику по entities
            if let Some(caps) = ENTITY_COUNT_RE.captures(line_str) {
                if let Ok(count) = caps
                    .get(1)
                    .map(|m| m.as_str())
                    .unwrap_or("0")
                    .parse::<u64>()
                {
                    entity_counts.push(count);
                }
            }

            // Собираем статистику по chunks
            if let Some(caps) = LOADED_CHUNKS_RE.captures(line_str) {
                if let Ok(count) = caps
                    .get(1)
                    .map(|m| m.as_str())
                    .unwrap_or("0")
                    .parse::<u64>()
                {
                    chunk_counts.push(count);
                }
            }

            // Медленная загрузка чанков
            if let Some(caps) = CHUNK_LOAD_RE.captures(line_str) {
                if let Ok(load_time) = caps
                    .get(1)
                    .map(|m| m.as_str())
                    .unwrap_or("0")
                    .parse::<u64>()
                {
                    if load_time > 500 {
                        lag_spikes.push(LagSpike {
                            duration_ms: load_time,
                            timestamp: None,
                            cause: Some("Slow chunk loading".into()),
                        });
                    }
                }
            }
        }

        // Анализ entity/chunk counts для дополнительных предупреждений
        if !entity_counts.is_empty() {
            let max_entities = *entity_counts.iter().max().unwrap_or(&0);
            if max_entities > 5000 {
                memory_issues.push(MemoryIssue {
                    issue_type: MemoryIssueType::HighHeapUsage,
                    used_mb: None,
                    available_mb: None,
                    description: format!(
                        "Высокое количество entities: {} (может вызывать лаги)",
                        max_entities
                    ),
                });
            }
        }

        if !chunk_counts.is_empty() {
            let max_chunks = *chunk_counts.iter().max().unwrap_or(&0);
            if max_chunks > 1000 {
                memory_issues.push(MemoryIssue {
                    issue_type: MemoryIssueType::HighHeapUsage,
                    used_mb: None,
                    available_mb: None,
                    description: format!(
                        "Много загруженных чанков: {} (рекомендуется уменьшить render distance)",
                        max_chunks
                    ),
                });
            }
        }

        // Конвертируем slow_mods в SlowMod структуры
        let mut slow_mods_vec: Vec<SlowMod> = slow_mods
            .into_iter()
            .map(|(mod_id, times)| {
                let avg_tick = times.iter().sum::<f32>() / times.len() as f32;
                SlowMod {
                    mod_id,
                    avg_tick_ms: avg_tick,
                    tick_percentage: 0.0, // Рассчитаем позже если нужно
                }
            })
            .filter(|m| m.avg_tick_ms > 5.0) // Только моды с > 5ms tick
            .collect();

        slow_mods_vec.sort_by(|a, b| {
            b.avg_tick_ms
                .partial_cmp(&a.avg_tick_ms)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        slow_mods_vec.truncate(10);

        // Убираем дубликаты из memory_issues
        memory_issues.truncate(5);
        lag_spikes.truncate(10);
        tps_issues.truncate(5);

        // Если ничего не нашли - возвращаем None
        if tps_issues.is_empty()
            && memory_issues.is_empty()
            && lag_spikes.is_empty()
            && slow_mods_vec.is_empty()
        {
            return None;
        }

        // Рассчитываем health score (0-100)
        let mut health_score: u8 = 100;

        // TPS влияет на score
        if !tps_issues.is_empty() {
            let avg_tps: f32 =
                tps_issues.iter().map(|t| t.current_tps).sum::<f32>() / tps_issues.len() as f32;
            health_score = health_score.saturating_sub((20.0 - avg_tps) as u8 * 3);
        }

        // Memory issues
        health_score = health_score.saturating_sub(memory_issues.len() as u8 * 5);

        // Lag spikes
        health_score = health_score.saturating_sub(lag_spikes.len() as u8 * 2);

        // Slow mods
        health_score = health_score.saturating_sub(slow_mods_vec.len() as u8 * 2);

        Some(PerformanceAnalysis {
            tps_issues,
            memory_issues,
            lag_spikes,
            slow_mods: slow_mods_vec,
            health_score,
        })
    }

    /// Генерировать рекомендации по оптимизации
    fn generate_optimizations(content: &str) -> Vec<Optimization> {
        let mut optimizations = Vec::new();

        // Проверяем использование памяти
        if content.contains("-Xmx2G") || content.contains("-Xmx2048") {
            optimizations.push(Optimization {
                title: "Увеличить выделенную память".into(),
                description: "2GB RAM может быть недостаточно для модпаков".into(),
                impact: "Улучшит стабильность".into(),
                auto_fix: Some(AutoFix::IncreaseRam {
                    recommended_mb: 6144,
                }),
            });
        }

        // Проверяем на старые JVM аргументы
        if content.contains("-XX:+UseConcMarkSweepGC") {
            optimizations.push(Optimization {
                title: "Обновить JVM аргументы".into(),
                description: "CMS GC устарел, используйте G1GC или ZGC".into(),
                impact: "Улучшит производительность".into(),
                auto_fix: Some(AutoFix::ChangeJvmArg {
                    old_arg: Some("-XX:+UseConcMarkSweepGC".into()),
                    new_arg: "-XX:+UseG1GC".into(),
                }),
            });
        }

        optimizations
    }

    /// Анализировать файл лога
    pub async fn analyze_file(&self, path: &Path) -> Result<LogAnalysisResult> {
        let bytes = tokio::fs::read(path).await?;
        // Используем lossy чтобы корректно обработать non-UTF8 символы в логах
        let content = String::from_utf8_lossy(&bytes);
        Ok(self.analyze(&content))
    }

    /// Найти последний лог экземпляра
    pub async fn find_latest_log(instance_id: &str) -> Result<PathBuf> {
        let logs_path = instances_dir().join(instance_id).join("logs");

        // Ищем latest.log
        let latest = logs_path.join("latest.log");
        if tokio::fs::try_exists(&latest).await.unwrap_or(false) {
            return Ok(latest);
        }

        // Или ищем последний crash-report (spawn_blocking для directory iteration + metadata)
        let crash_reports = logs_path.join("..").join("crash-reports");
        if tokio::fs::try_exists(&crash_reports).await.unwrap_or(false) {
            let result = tokio::task::spawn_blocking(move || {
                // Используем unified helper
                find_newest_file_sync(&crash_reports, has_extension("txt"))
            })
            .await
            .ok()
            .flatten();

            if let Some(latest_crash) = result {
                return Ok(latest_crash);
            }
        }

        Err(LauncherError::NotFound("No log files found".into()))
    }

    /// Собрать все логи из папки экземпляра (включая логи модов)
    /// Использует spawn_blocking так как требует много операций с директориями и metadata
    pub async fn collect_all_logs(instance_id: &str) -> Vec<(PathBuf, String)> {
        let instance_path = instances_dir().join(instance_id);

        tokio::task::spawn_blocking(move || Self::collect_all_logs_sync(&instance_path))
            .await
            .unwrap_or_default()
    }

    /// Синхронная версия collect_all_logs (вызывается из spawn_blocking)
    fn collect_all_logs_sync(instance_path: &Path) -> Vec<(PathBuf, String)> {
        let mut logs: Vec<(PathBuf, String)> = Vec::new();

        // Основные логи Minecraft
        let main_logs = instance_path.join("logs");
        if main_logs.exists() {
            let latest = main_logs.join("latest.log");
            if latest.exists() {
                logs.push((latest, "Minecraft".into()));
            }
        }

        // Краш-репорты - используем unified helper
        let crash_reports = instance_path.join("crash-reports");
        if crash_reports.exists() {
            if let Some(latest_crash) = find_newest_file_sync(&crash_reports, has_extension("txt"))
            {
                logs.push((latest_crash, "Crash Report".into()));
            }
        }

        // === Логи модов ===

        // KubeJS
        let kubejs_logs = instance_path.join("kubejs").join("logs");
        if kubejs_logs.exists() {
            Self::collect_logs_from_dir(&kubejs_logs, "KubeJS", &mut logs);
        }

        // Open Loader
        let openloader_logs = instance_path.join("openloader");
        if openloader_logs.exists() {
            Self::collect_logs_from_dir(&openloader_logs, "OpenLoader", &mut logs);
        }

        // Create mod (может создавать диагностические файлы)
        let create_dir = instance_path.join("create");
        if create_dir.exists() {
            Self::collect_logs_from_dir(&create_dir, "Create", &mut logs);
        }

        // EMI (может создавать логи)
        let emi_dir = instance_path.join("emi");
        if emi_dir.exists() {
            Self::collect_logs_from_dir(&emi_dir, "EMI", &mut logs);
        }

        // JEI (логи в config/jei или jei/)
        for jei_path in &[
            instance_path.join("jei"),
            instance_path.join("config").join("jei"),
        ] {
            if jei_path.exists() {
                Self::collect_logs_from_dir(jei_path, "JEI", &mut logs);
            }
        }

        // REI
        let rei_dir = instance_path.join("rei");
        if rei_dir.exists() {
            Self::collect_logs_from_dir(&rei_dir, "REI", &mut logs);
        }

        // Supplementaries
        let supplementaries_dir = instance_path.join("supplementaries");
        if supplementaries_dir.exists() {
            Self::collect_logs_from_dir(&supplementaries_dir, "Supplementaries", &mut logs);
        }

        // PackMenu
        let packmenu_dir = instance_path.join("packmenu");
        if packmenu_dir.exists() {
            Self::collect_logs_from_dir(&packmenu_dir, "PackMenu", &mut logs);
        }

        // FancyMenu
        let fancymenu_dir = instance_path.join("fancymenu");
        if fancymenu_dir.exists() {
            Self::collect_logs_from_dir(&fancymenu_dir, "FancyMenu", &mut logs);
        }

        // Polymorph
        let polymorph_dir = instance_path.join("polymorph");
        if polymorph_dir.exists() {
            Self::collect_logs_from_dir(&polymorph_dir, "Polymorph", &mut logs);
        }

        // CraftTweaker
        let crafttweaker_logs = instance_path.join("logs").join("crafttweaker.log");
        if crafttweaker_logs.exists() {
            logs.push((crafttweaker_logs, "CraftTweaker".into()));
        }

        // ModernFix
        let modernfix_dir = instance_path.join("modernfix");
        if modernfix_dir.exists() {
            Self::collect_logs_from_dir(&modernfix_dir, "ModernFix", &mut logs);
        }

        // spark profiler
        let spark_dir = instance_path.join("spark");
        if spark_dir.exists() {
            Self::collect_logs_from_dir(&spark_dir, "Spark", &mut logs);
        }

        // Проверяем логи в корне (некоторые моды пишут туда)
        for entry in std::fs::read_dir(instance_path)
            .into_iter()
            .flatten()
            .flatten()
        {
            let path = entry.path();
            if path.is_file() {
                if let Some(ext) = path.extension() {
                    if ext == "log" {
                        if let Some(name) = path.file_stem().and_then(|s| s.to_str()) {
                            // Исключаем уже добавленные
                            if !name.starts_with("latest") && !name.starts_with("debug") {
                                logs.push((path.clone(), format!("{} (root)", name)));
                            }
                        }
                    }
                }
            }
        }

        logs
    }

    /// Вспомогательная функция для сбора логов из директории (sync, вызывается из spawn_blocking)
    fn collect_logs_from_dir(dir: &Path, source_name: &str, logs: &mut Vec<(PathBuf, String)>) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                let path = entry.path();
                if path.is_file() {
                    if let Some(ext) = path.extension() {
                        if ext == "log" || ext == "txt" {
                            logs.push((path, source_name.into()));
                        }
                    }
                }
            }
        }
    }

    /// Получить список установленных модов (slug/id) для экземпляра
    /// Проверяет и БД, и файлы в папке mods
    async fn get_installed_mod_ids(instance_id: &str) -> Vec<String> {
        let mut mod_ids = Vec::new();

        // 1. Проверяем БД
        if let Ok(conn) = crate::db::get_db_conn() {
            if let Ok(mut stmt) = conn.prepare("SELECT slug, name FROM mods WHERE instance_id = ?1")
            {
                if let Ok(rows) = stmt.query_map([instance_id], |row| {
                    Ok((
                        row.get::<_, String>(0).unwrap_or_default(),
                        row.get::<_, String>(1).unwrap_or_default(),
                    ))
                }) {
                    for row in rows.flatten() {
                        if !row.0.is_empty() {
                            mod_ids.push(row.0.to_lowercase());
                        }
                        if !row.1.is_empty() {
                            mod_ids.push(row.1.to_lowercase());
                        }
                    }
                }
            }
        }

        // 2. Проверяем файлы в папке mods
        let mods_path = instances_dir().join(instance_id).join("mods");
        if mods_path.exists() {
            if let Ok(mut entries) = tokio::fs::read_dir(&mods_path).await {
                while let Ok(Some(entry)) = entries.next_entry().await {
                    if let Some(name) = entry.file_name().to_str() {
                        // Извлекаем slug из имени файла: mod-name-1.2.3.jar -> mod-name
                        let name_lower = name.to_lowercase();
                        if name_lower.ends_with(".jar") {
                            // Удаляем .jar и пытаемся извлечь slug
                            let base = name_lower.trim_end_matches(".jar");
                            // Извлекаем часть до версии (до цифр после дефиса)
                            let parts: Vec<&str> = base.split('-').collect();
                            let mut slug_parts = Vec::new();
                            for part in parts {
                                // Если часть начинается с цифры - это скорее всего версия
                                if part
                                    .chars()
                                    .next()
                                    .map(|c| c.is_ascii_digit())
                                    .unwrap_or(false)
                                {
                                    break;
                                }
                                slug_parts.push(part);
                            }
                            if !slug_parts.is_empty() {
                                mod_ids.push(slug_parts.join("-"));
                            }
                            // Также добавляем полное имя без .jar
                            mod_ids.push(base.to_string());
                        }
                    }
                }
            }
        }

        mod_ids
    }

    /// Анализировать все логи экземпляра и объединить результаты
    pub async fn analyze_all_logs(&self, instance_id: &str) -> Result<LogAnalysisResult> {
        let start_time = std::time::Instant::now();
        let log_files = Self::collect_all_logs(instance_id).await;

        if log_files.is_empty() {
            return Err(LauncherError::NotFound("No log files found".into()));
        }

        let mut all_problems: Vec<DetectedProblem> = Vec::new();
        let mut total_lines = 0u32;
        let mut error_count = 0u32;
        let mut warning_count = 0u32;
        let mut critical_count = 0u32;
        let mut crash_info: Option<CrashInfo> = None;
        let mut all_optimizations: Vec<Optimization> = Vec::new();

        for (log_path, source_name) in log_files {
            match tokio::fs::read(&log_path).await {
                Ok(bytes) => {
                    let content = String::from_utf8_lossy(&bytes);
                    let result = self.analyze(&content);

                    // Добавляем источник к проблемам
                    for mut problem in result.problems {
                        // Добавляем имя источника к ID чтобы избежать дубликатов между файлами
                        problem.id = format!(
                            "{}_{}",
                            source_name.to_lowercase().replace(' ', "_"),
                            problem.id
                        );

                        // Добавляем источник в описание
                        problem.description = format!("[{}] {}", source_name, problem.description);

                        // Проверяем на дубликаты по заголовку
                        let is_duplicate = all_problems.iter().any(|p| p.title == problem.title);

                        if !is_duplicate {
                            all_problems.push(problem);
                        }
                    }

                    total_lines += result.summary.total_lines;
                    error_count += result.summary.error_count;
                    warning_count += result.summary.warning_count;
                    critical_count += result.summary.critical_count;

                    // Берём crash_info из первого файла где он найден
                    if crash_info.is_none() && result.crash_info.is_some() {
                        crash_info = result.crash_info;
                    }

                    // Собираем оптимизации (без дубликатов)
                    for opt in result.optimizations {
                        if !all_optimizations.iter().any(|o| o.title == opt.title) {
                            all_optimizations.push(opt);
                        }
                    }
                }
                Err(e) => {
                    log::warn!("Failed to read log file {:?}: {}", log_path, e);
                }
            }
        }

        // Сортируем по приоритету: severity -> category priority -> line number
        // НЕ фильтруем по installed_mods - пользователь должен видеть все проблемы
        all_problems.sort_by(|a, b| match b.severity.cmp(&a.severity) {
            std::cmp::Ordering::Equal => match a.category.priority().cmp(&b.category.priority()) {
                std::cmp::Ordering::Equal => a.line_number.cmp(&b.line_number),
                other => other,
            },
            other => other,
        });

        let parse_time_ms = start_time.elapsed().as_millis() as u64;

        // Группируем ошибки по модам/категориям
        let error_groups = Self::group_errors_by_mod(&all_problems);

        // Собираем performance данные из всех логов (берём первый найденный)
        let mut performance: Option<PerformanceAnalysis> = None;
        for (log_path, _) in Self::collect_all_logs(&instance_id).await {
            if let Ok(bytes) = tokio::fs::read(&log_path).await {
                let content = String::from_utf8_lossy(&bytes);
                let lines: Vec<&str> = content.lines().collect();
                if let Some(perf) = Self::analyze_performance(&lines) {
                    performance = Some(perf);
                    break;
                }
            }
        }

        Ok(LogAnalysisResult {
            problems: all_problems,
            summary: AnalysisSummary {
                total_lines,
                error_count,
                warning_count,
                critical_count,
                parse_time_ms,
            },
            optimizations: all_optimizations,
            crash_info,
            error_groups,
            performance,
        })
    }
}

impl Default for LogAnalyzer {
    fn default() -> Self {
        Self::new()
    }
}

/// Get instance info from database for crash record
fn get_instance_info(instance_id: &str) -> (Option<String>, Option<String>, Option<String>) {
    if let Ok(conn) = stuzhik_db::get_db_conn() {
        if let Ok(mut stmt) =
            conn.prepare("SELECT version, loader, loader_version FROM instances WHERE id = ?1")
        {
            if let Ok(row) = stmt.query_row([instance_id], |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            }) {
                return row;
            }
        }
    }
    (None, None, None)
}

// ========== Tauri Commands ==========

/// Анализировать лог файл
#[tauri::command]
pub async fn analyze_log_file(path: String) -> Result<LogAnalysisResult> {
    let analyzer = LogAnalyzer::new();
    analyzer.analyze_file(&PathBuf::from(path)).await
}

/// Анализировать лог экземпляра (только главный лог)
/// Автоматически сохраняет в историю крашей если найдены проблемы
#[tauri::command]
pub async fn analyze_instance_log(instance_id: String) -> Result<LogAnalysisResult> {
    let analyzer = LogAnalyzer::new();
    let result = analyzer.analyze_all_logs(&instance_id).await?;

    // Auto-save to crash history if problems found
    if !result.problems.is_empty() {
        // Get instance info for crash record
        let (mc_version, loader_type, loader_version) = get_instance_info(&instance_id);

        let log_type = if result.crash_info.is_some() {
            "crash"
        } else {
            "latest"
        };

        if let Err(e) = save_crash_record(
            &instance_id,
            log_type,
            &result.problems,
            mc_version.as_deref(),
            loader_type.as_deref(),
            loader_version.as_deref(),
        ) {
            log::warn!("Failed to save crash record: {}", e);
        }
    }

    Ok(result)
}

/// Анализировать все логи экземпляра (включая логи модов)
#[tauri::command]
pub async fn analyze_all_instance_logs(instance_id: String) -> Result<LogAnalysisResult> {
    let analyzer = LogAnalyzer::new();
    analyzer.analyze_all_logs(&instance_id).await
}

/// Получить список всех лог-файлов экземпляра
#[tauri::command]
pub async fn get_instance_log_files(instance_id: String) -> Result<Vec<LogFileInfo>> {
    let logs = LogAnalyzer::collect_all_logs(&instance_id).await;
    let mut result = Vec::new();

    for (path, source) in logs {
        let size = tokio::fs::metadata(&path)
            .await
            .map(|m| m.len())
            .unwrap_or(0);

        let modified = tokio::fs::metadata(&path)
            .await
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_secs());

        result.push(LogFileInfo {
            path: path.to_string_lossy().to_string(),
            source,
            size,
            modified_timestamp: modified,
        });
    }

    Ok(result)
}

/// Получить доступные автоисправления
#[tauri::command]
pub fn get_available_auto_fixes() -> Vec<serde_json::Value> {
    use serde_json::json;

    vec![
        json!({
            "type": "increase_ram",
            "name": "Увеличить RAM",
            "description": "Выделить больше памяти для игры"
        }),
        json!({
            "type": "remove_mod",
            "name": "Удалить мод",
            "description": "Удалить проблемный мод"
        }),
        json!({
            "type": "download_mod",
            "name": "Установить мод",
            "description": "Скачать недостающий мод"
        }),
        json!({
            "type": "change_jvm_arg",
            "name": "Изменить JVM аргумент",
            "description": "Изменить настройки Java"
        }),
        json!({
            "type": "reinstall_mod",
            "name": "Переустановить мод",
            "description": "Переустановить повреждённый мод"
        }),
        json!({
            "type": "delete_config",
            "name": "Удалить конфиг",
            "description": "Удалить повреждённый файл конфигурации"
        }),
        json!({
            "type": "install_java",
            "name": "Установить Java",
            "description": "Установить правильную версию Java"
        }),
        json!({
            "type": "update_loader",
            "name": "Обновить загрузчик",
            "description": "Обновить Forge/Fabric/NeoForge"
        }),
        json!({
            "type": "reset_configs",
            "name": "Сбросить конфиги",
            "description": "Сбросить все конфигурации на defaults"
        }),
        json!({
            "type": "verify_files",
            "name": "Проверить файлы",
            "description": "Проверить целостность файлов игры"
        }),
    ]
}

/// Применить автоматическое исправление к экземпляру
#[tauri::command]
pub async fn apply_auto_fix_command(
    instance_id: String,
    fix: AutoFix,
    app_handle: tauri::AppHandle,
) -> Result<AutoFixResult> {
    apply_auto_fix(&instance_id, fix, app_handle).await
}

// ========== Crash History Commands ==========

/// Get crash history for an instance
#[tauri::command]
pub fn get_crash_history_command(
    instance_id: String,
    limit: Option<u32>,
) -> std::result::Result<Vec<CrashRecord>, String> {
    get_crash_history(&instance_id, limit)
}

/// Get crash statistics for an instance
#[tauri::command]
pub fn get_crash_statistics_command(
    instance_id: String,
) -> std::result::Result<CrashStatistics, String> {
    get_crash_statistics(&instance_id)
}

/// Get crash trends for mods in an instance
#[tauri::command]
pub fn get_crash_trends_command(
    instance_id: String,
) -> std::result::Result<Vec<CrashTrend>, String> {
    get_crash_trends(&instance_id)
}

/// Mark a crash as fixed
#[tauri::command]
pub fn mark_crash_fixed_command(
    crash_id: String,
    fix_method: String,
) -> std::result::Result<(), String> {
    mark_crash_fixed(&crash_id, &fix_method)
}

/// Update crash notes
#[tauri::command]
pub fn update_crash_notes_command(
    crash_id: String,
    notes: String,
) -> std::result::Result<(), String> {
    update_crash_notes(&crash_id, &notes)
}

/// Clear crash history for an instance
#[tauri::command]
pub fn clear_crash_history_command(instance_id: String) -> std::result::Result<u32, String> {
    clear_crash_history(&instance_id)
}

/// Cleanup old crash records
#[tauri::command]
pub fn cleanup_old_crashes_command(days: i64) -> std::result::Result<u32, String> {
    cleanup_old_crashes(days)
}

// ========== Export Logs Archive ==========

/// Export logs archive for an instance (ZIP file with all logs + analysis)
#[tauri::command]
pub async fn export_logs_archive(
    instance_id: String,
    output_path: String,
) -> std::result::Result<ExportedArchiveInfo, String> {
    export_logs_archive_internal(&instance_id, &output_path).await
}

/// Information about exported archive
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportedArchiveInfo {
    /// Path to the created archive
    pub path: String,
    /// Size of the archive in bytes
    pub size_bytes: u64,
    /// Number of log files included
    pub files_count: u32,
    /// Instance info included
    pub instance_name: Option<String>,
    /// Analysis included
    pub has_analysis: bool,
}

/// Internal function to export logs archive
async fn export_logs_archive_internal(
    instance_id: &str,
    output_path: &str,
) -> std::result::Result<ExportedArchiveInfo, String> {
    let instance_dir = paths::instance_dir(instance_id);
    let logs_dir = instance_dir.join("logs");
    let crash_reports_dir = instance_dir.join("crash-reports");

    // Get instance name from DB
    let instance_name = if let Ok(conn) = crate::db::get_db_conn() {
        conn.query_row(
            "SELECT name FROM instances WHERE id = ?1",
            [instance_id],
            |row| row.get::<_, String>(0),
        )
        .ok()
    } else {
        None
    };

    // === Фаза 1: Асинхронное чтение всех файлов ===

    // Read latest.log
    let latest_log = logs_dir.join("latest.log");
    let latest_log_content = if tokio::fs::try_exists(&latest_log).await.unwrap_or(false) {
        tokio::fs::read_to_string(&latest_log).await.ok()
    } else {
        None
    };

    // Read debug.log (truncate to last 100KB)
    let debug_log = logs_dir.join("debug.log");
    let debug_log_content = if tokio::fs::try_exists(&debug_log).await.unwrap_or(false) {
        tokio::fs::read_to_string(&debug_log)
            .await
            .ok()
            .map(|content| {
                if content.len() > 100_000 {
                    format!(
                        "... (truncated, showing last 100KB) ...\n{}",
                        &content[content.len() - 100_000..]
                    )
                } else {
                    content
                }
            })
    } else {
        None
    };

    // Collect crash report paths (spawn_blocking for directory iteration)
    // Используем unified helper для получения топ-5 самых новых краш-репортов
    let crash_reports_dir_clone = crash_reports_dir.clone();
    let crash_report_paths: Vec<PathBuf> = tokio::task::spawn_blocking(move || {
        if !crash_reports_dir_clone.exists() {
            return Vec::new();
        }
        find_newest_files_sync(&crash_reports_dir_clone, has_extension("txt"), 5)
    })
    .await
    .unwrap_or_default();

    // Read crash report contents asynchronously
    let mut crash_reports: Vec<(String, String)> = Vec::new();
    for path in crash_report_paths {
        if let Ok(content) = tokio::fs::read_to_string(&path).await {
            if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
                crash_reports.push((file_name.to_string(), content));
            }
        }
    }

    // Generate analysis report if we have latest.log
    let analysis_report = latest_log_content.as_ref().map(|content| {
        let analyzer = LogAnalyzer::new();
        let result = analyzer.analyze(content);
        generate_analysis_report(&result, instance_name.as_deref())
    });

    // Prepare instance info
    let info = format!(
        "Instance ID: {}\nInstance Name: {}\nExported: {}\n",
        instance_id,
        instance_name.as_deref().unwrap_or("Unknown"),
        chrono::Utc::now().to_rfc3339()
    );

    // === Фаза 2: Создание ZIP в spawn_blocking ===
    let output_path_owned = output_path.to_string();
    let has_analysis = analysis_report.is_some();

    let (files_count, size_bytes) = tokio::task::spawn_blocking(move || {
        use std::io::Write;
        use zip::write::SimpleFileOptions;
        use zip::ZipWriter;

        let file = std::fs::File::create(&output_path_owned)
            .map_err(|e| format!("Failed to create archive: {}", e))?;
        let mut zip = ZipWriter::new(file);
        let options = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .compression_level(Some(6));

        let mut files_count = 0u32;

        // Add latest.log
        if let Some(content) = latest_log_content {
            zip.start_file("logs/latest.log", options)
                .map_err(|e| format!("Failed to add latest.log: {}", e))?;
            zip.write_all(content.as_bytes())
                .map_err(|e| format!("Failed to write latest.log: {}", e))?;
            files_count += 1;
        }

        // Add debug.log
        if let Some(content) = debug_log_content {
            zip.start_file("logs/debug.log", options)
                .map_err(|e| format!("Failed to add debug.log: {}", e))?;
            zip.write_all(content.as_bytes())
                .map_err(|e| format!("Failed to write debug.log: {}", e))?;
            files_count += 1;
        }

        // Add crash reports
        for (file_name, content) in crash_reports {
            let archive_path = format!("crash-reports/{}", file_name);
            zip.start_file(&archive_path, options)
                .map_err(|e| format!("Failed to add crash report: {}", e))?;
            zip.write_all(content.as_bytes())
                .map_err(|e| format!("Failed to write crash report: {}", e))?;
            files_count += 1;
        }

        // Add analysis report
        if let Some(report) = analysis_report {
            zip.start_file("ANALYSIS_REPORT.md", options)
                .map_err(|e| format!("Failed to add analysis report: {}", e))?;
            zip.write_all(report.as_bytes())
                .map_err(|e| format!("Failed to write analysis report: {}", e))?;
        }

        // Add instance info
        zip.start_file("INSTANCE_INFO.txt", options)
            .map_err(|e| format!("Failed to add instance info: {}", e))?;
        zip.write_all(info.as_bytes())
            .map_err(|e| format!("Failed to write instance info: {}", e))?;

        // Finish ZIP
        zip.finish()
            .map_err(|e| format!("Failed to finalize archive: {}", e))?;

        // Get file size
        let size_bytes = std::fs::metadata(&output_path_owned)
            .map(|m| m.len())
            .unwrap_or(0);

        Ok::<_, String>((files_count, size_bytes))
    })
    .await
    .map_err(|e| format!("ZIP creation failed: {}", e))??;

    log::info!(
        "Exported logs archive for instance {} to {} ({} files, {} bytes)",
        instance_id,
        output_path,
        files_count,
        size_bytes
    );

    Ok(ExportedArchiveInfo {
        path: output_path.to_string(),
        size_bytes,
        files_count,
        instance_name,
        has_analysis,
    })
}

/// Generate a markdown analysis report
fn generate_analysis_report(result: &LogAnalysisResult, instance_name: Option<&str>) -> String {
    let mut report = String::new();

    report.push_str("# Log Analysis Report\n\n");
    report.push_str(&format!(
        "**Instance:** {}\n",
        instance_name.unwrap_or("Unknown")
    ));
    report.push_str(&format!(
        "**Generated:** {}\n\n",
        chrono::Utc::now().to_rfc3339()
    ));

    // Summary
    report.push_str("## Summary\n\n");
    report.push_str(&format!(
        "- **Total lines analyzed:** {}\n",
        result.summary.total_lines
    ));
    report.push_str(&format!(
        "- **Critical issues:** {}\n",
        result.summary.critical_count
    ));
    report.push_str(&format!("- **Errors:** {}\n", result.summary.error_count));
    report.push_str(&format!(
        "- **Warnings:** {}\n",
        result.summary.warning_count
    ));
    report.push_str(&format!(
        "- **Parse time:** {}ms\n\n",
        result.summary.parse_time_ms
    ));

    // Problems
    if !result.problems.is_empty() {
        report.push_str("## Detected Problems\n\n");
        for (i, problem) in result.problems.iter().enumerate() {
            report.push_str(&format!(
                "### {}. {} ({:?})\n\n",
                i + 1,
                problem.title,
                problem.severity
            ));
            report.push_str(&format!("**Category:** {:?}\n\n", problem.category));
            report.push_str(&format!("{}\n\n", problem.description));

            if !problem.related_mods.is_empty() {
                report.push_str(&format!(
                    "**Related mods:** {}\n\n",
                    problem.related_mods.join(", ")
                ));
            }

            if !problem.solutions.is_empty() {
                report.push_str("**Solutions:**\n\n");
                for solution in &problem.solutions {
                    report.push_str(&format!(
                        "- **{}** ({}% success rate)\n  {}\n",
                        solution.title, solution.success_rate, solution.description
                    ));
                }
                report.push('\n');
            }
        }
    }

    // Crash info
    if let Some(ref crash) = result.crash_info {
        report.push_str("## Crash Information\n\n");
        if !crash.main_cause.is_empty() {
            report.push_str(&format!("**Main cause:** {}\n\n", crash.main_cause));
        }
        if let Some(ref culprit) = crash.culprit_mod {
            report.push_str(&format!("**Suspected mod:** {}\n\n", culprit));
        }
        if let Some(ref mc_version) = crash.minecraft_version {
            report.push_str(&format!("**Minecraft version:** {}\n", mc_version));
        }
        if let Some(ref loader) = crash.mod_loader {
            report.push_str(&format!(
                "**Mod loader:** {} {}\n",
                loader,
                crash.loader_version.as_deref().unwrap_or("")
            ));
        }
        if let Some(ref java) = crash.java_version {
            report.push_str(&format!("**Java version:** {}\n", java));
        }
        report.push('\n');
    }

    // Performance
    if let Some(ref perf) = result.performance {
        report.push_str("## Performance Analysis\n\n");
        report.push_str(&format!("- **Health score:** {}/100\n", perf.health_score));

        if !perf.tps_issues.is_empty() {
            let avg_tps: f32 = perf.tps_issues.iter().map(|t| t.current_tps).sum::<f32>()
                / perf.tps_issues.len() as f32;
            let min_tps = perf
                .tps_issues
                .iter()
                .map(|t| t.current_tps)
                .min_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
                .unwrap_or(20.0);
            report.push_str(&format!("- **Average TPS:** {:.1}\n", avg_tps));
            report.push_str(&format!("- **Minimum TPS:** {:.1}\n", min_tps));
        }

        if !perf.lag_spikes.is_empty() {
            report.push_str(&format!(
                "- **Lag spikes detected:** {}\n",
                perf.lag_spikes.len()
            ));
        }

        if !perf.memory_issues.is_empty() {
            report.push_str(&format!(
                "- **Memory issues:** {}\n",
                perf.memory_issues.len()
            ));
        }

        if !perf.slow_mods.is_empty() {
            report.push_str("\n**Slow mods (by tick time):**\n");
            for sm in perf.slow_mods.iter().take(5) {
                report.push_str(&format!("- {} ({:.1}ms avg)\n", sm.mod_id, sm.avg_tick_ms));
            }
        }
        report.push('\n');
    }

    report.push_str("---\n");
    report.push_str("*Generated by Minecraft Modpack Constructor Log Analyzer*\n");

    report
}
