//! Knowledge Base - локальная база знаний о решениях проблем
//!
//! Сохраняет feedback от пользователя о том, какие решения помогли,
//! и использует эту информацию для персональных рекомендаций.

use chrono::Utc;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use stuzhik_core::{DetectedProblem, Solution};
use uuid::Uuid;

use crate::get_db_conn;

/// Feedback от пользователя о решении
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SolutionFeedback {
    /// ID feedback записи
    pub id: String,

    /// Сигнатура проблемы (hash для группировки)
    pub problem_signature: String,

    /// ID решения
    pub solution_id: String,

    /// Помогло ли решение
    pub helped: bool,

    /// Когда применено
    pub applied_at: String,

    /// Заметки пользователя
    pub notes: Option<String>,

    /// ID экземпляра (опционально)
    pub instance_id: Option<String>,
}

/// Статистика по решению
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SolutionRating {
    /// ID решения
    pub solution_id: String,

    /// Сколько раз применялось
    pub times_applied: u32,

    /// Сколько раз помогло
    pub times_helped: u32,

    /// Success rate (0.0 - 1.0)
    pub success_rate: f32,

    /// Когда последний раз использовалось
    pub last_used: String,
}

/// Персональная рекомендация решения
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersonalizedSolution {
    /// Оригинальное решение
    #[serde(flatten)]
    pub solution: Solution,

    /// Персональная статистика (если есть)
    pub personal_rating: Option<SolutionRating>,

    /// Рекомендуется ли на основе личного опыта
    pub personally_recommended: bool,
}

/// Knowledge Base manager
pub struct KnowledgeBase {
    conn: Connection,
}

impl KnowledgeBase {
    /// Создать новый KnowledgeBase
    pub fn new() -> Result<Self, Box<dyn std::error::Error>> {
        let conn = get_db_conn()?;
        Ok(Self { conn })
    }

    /// Сохранить feedback о решении
    pub fn save_feedback(
        &self,
        problem_signature: &str,
        solution_id: &str,
        helped: bool,
        notes: Option<String>,
        instance_id: Option<String>,
    ) -> Result<String, Box<dyn std::error::Error>> {
        let feedback_id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();

        // Сохраняем feedback
        self.conn.execute(
            r#"
            INSERT OR REPLACE INTO solution_feedback
            (id, problem_signature, solution_id, helped, applied_at, notes, instance_id)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            "#,
            params![
                feedback_id,
                problem_signature,
                solution_id,
                helped as i32,
                now,
                notes,
                instance_id
            ],
        )?;

        // Обновляем рейтинг решения
        self.update_solution_rating(solution_id)?;

        log::info!(
            "Saved feedback for solution '{}': helped={}",
            solution_id,
            helped
        );

        Ok(feedback_id)
    }

    /// Обновить рейтинг решения
    fn update_solution_rating(&self, solution_id: &str) -> Result<(), Box<dyn std::error::Error>> {
        let now = Utc::now().to_rfc3339();

        // Подсчитываем статистику
        let (times_applied, times_helped): (u32, u32) = self.conn.query_row(
            r#"
            SELECT
                COUNT(*) as times_applied,
                SUM(CASE WHEN helped = 1 THEN 1 ELSE 0 END) as times_helped
            FROM solution_feedback
            WHERE solution_id = ?1
            "#,
            params![solution_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;

        let success_rate = if times_applied > 0 {
            times_helped as f32 / times_applied as f32
        } else {
            0.0
        };

        // Обновляем или создаём rating
        self.conn.execute(
            r#"
            INSERT OR REPLACE INTO solution_ratings
            (solution_id, times_applied, times_helped, success_rate, last_used)
            VALUES (?1, ?2, ?3, ?4, ?5)
            "#,
            params![solution_id, times_applied, times_helped, success_rate, now],
        )?;

        Ok(())
    }

    /// Получить рейтинг решения
    pub fn get_solution_rating(
        &self,
        solution_id: &str,
    ) -> Result<Option<SolutionRating>, Box<dyn std::error::Error>> {
        let result = self.conn.query_row(
            r#"
            SELECT solution_id, times_applied, times_helped, success_rate, last_used
            FROM solution_ratings
            WHERE solution_id = ?1
            "#,
            params![solution_id],
            |row| {
                Ok(SolutionRating {
                    solution_id: row.get(0)?,
                    times_applied: row.get(1)?,
                    times_helped: row.get(2)?,
                    success_rate: row.get(3)?,
                    last_used: row.get(4)?,
                })
            },
        );

        match result {
            Ok(rating) => Ok(Some(rating)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(Box::new(e)),
        }
    }

    /// Получить все feedback записи для проблемы
    pub fn get_feedback_for_problem(
        &self,
        problem_signature: &str,
    ) -> Result<Vec<SolutionFeedback>, Box<dyn std::error::Error>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT id, problem_signature, solution_id, helped, applied_at, notes, instance_id
            FROM solution_feedback
            WHERE problem_signature = ?1
            ORDER BY applied_at DESC
            "#,
        )?;

        let feedbacks = stmt
            .query_map(params![problem_signature], |row| {
                Ok(SolutionFeedback {
                    id: row.get(0)?,
                    problem_signature: row.get(1)?,
                    solution_id: row.get(2)?,
                    helped: row.get::<_, i32>(3)? == 1,
                    applied_at: row.get(4)?,
                    notes: row.get(5)?,
                    instance_id: row.get(6)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(feedbacks)
    }

    /// Получить топ-N решений с лучшим рейтингом
    pub fn get_top_rated_solutions(
        &self,
        limit: u32,
    ) -> Result<Vec<SolutionRating>, Box<dyn std::error::Error>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT solution_id, times_applied, times_helped, success_rate, last_used
            FROM solution_ratings
            WHERE times_applied >= 2
            ORDER BY success_rate DESC, times_applied DESC
            LIMIT ?1
            "#,
        )?;

        let ratings = stmt
            .query_map(params![limit], |row| {
                Ok(SolutionRating {
                    solution_id: row.get(0)?,
                    times_applied: row.get(1)?,
                    times_helped: row.get(2)?,
                    success_rate: row.get(3)?,
                    last_used: row.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(ratings)
    }

    /// Персонализировать решения на основе личного опыта
    pub fn personalize_solutions(
        &self,
        solutions: Vec<Solution>,
        problem_signature: &str,
    ) -> Result<Vec<PersonalizedSolution>, Box<dyn std::error::Error>> {
        // Получаем все рейтинги одним запросом для производительности
        let mut ratings_map: HashMap<String, SolutionRating> = HashMap::new();

        let solution_ids: Vec<String> = solutions
            .iter()
            .enumerate()
            .map(|(i, _)| format!("sol_{}", i))
            .collect();

        for (solution, sol_id) in solutions.iter().zip(solution_ids.iter()) {
            if let Ok(Some(rating)) = self.get_solution_rating(sol_id.as_str()) {
                ratings_map.insert(sol_id.to_string(), rating);
            }
        }

        // Создаём персонализированные решения
        let mut personalized: Vec<PersonalizedSolution> = solutions
            .into_iter()
            .enumerate()
            .map(|(i, solution)| {
                let sol_id = format!("sol_{}", i);
                let personal_rating = ratings_map.get(&sol_id).cloned();

                let personally_recommended = personal_rating
                    .as_ref()
                    .map(|r| r.success_rate >= 0.75 && r.times_applied >= 2)
                    .unwrap_or(false);

                PersonalizedSolution {
                    solution,
                    personal_rating,
                    personally_recommended,
                }
            })
            .collect();

        // Сортируем: personally_recommended первыми, затем по success_rate
        personalized.sort_by(|a, b| {
            match (a.personally_recommended, b.personally_recommended) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => {
                    // Оба recommended или оба нет - сортируем по success_rate
                    let a_rate = a
                        .personal_rating
                        .as_ref()
                        .map(|r| r.success_rate)
                        .unwrap_or(0.0);
                    let b_rate = b
                        .personal_rating
                        .as_ref()
                        .map(|r| r.success_rate)
                        .unwrap_or(0.0);

                    b_rate
                        .partial_cmp(&a_rate)
                        .unwrap_or(std::cmp::Ordering::Equal)
                }
            }
        });

        Ok(personalized)
    }

    /// Очистить старые feedback записи (старше N дней)
    pub fn cleanup_old_feedback(&self, days: u32) -> Result<usize, Box<dyn std::error::Error>> {
        let cutoff_date = Utc::now() - chrono::Duration::days(days as i64);
        let cutoff = cutoff_date.to_rfc3339();

        let deleted = self.conn.execute(
            "DELETE FROM solution_feedback WHERE applied_at < ?1",
            params![cutoff],
        )?;

        log::info!("Cleaned up {} old feedback records", deleted);

        Ok(deleted)
    }

    /// Получить статистику Knowledge Base
    pub fn get_statistics(&self) -> Result<KnowledgeBaseStats, Box<dyn std::error::Error>> {
        let total_feedback: u32 =
            self.conn
                .query_row("SELECT COUNT(*) FROM solution_feedback", [], |row| {
                    row.get(0)
                })?;

        let total_solutions: u32 =
            self.conn
                .query_row("SELECT COUNT(*) FROM solution_ratings", [], |row| {
                    row.get(0)
                })?;

        let avg_success_rate: f32 = self
            .conn
            .query_row(
                r#"
            SELECT AVG(success_rate)
            FROM solution_ratings
            WHERE times_applied >= 2
            "#,
                [],
                |row| row.get(0),
            )
            .unwrap_or(0.0);

        Ok(KnowledgeBaseStats {
            total_feedback,
            total_solutions,
            avg_success_rate,
        })
    }
}

/// Статистика Knowledge Base
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeBaseStats {
    pub total_feedback: u32,
    pub total_solutions: u32,
    pub avg_success_rate: f32,
}

/// Создать сигнатуру проблемы для группировки
pub fn create_problem_signature(problem: &DetectedProblem) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();

    // Хешируем category + title + related_mods для группировки похожих проблем
    format!("{:?}", problem.category).hash(&mut hasher);
    problem.title.hash(&mut hasher);

    // Добавляем первый related mod (если есть) для более точной группировки
    if let Some(first_mod) = problem.related_mods.first() {
        first_mod.hash(&mut hasher);
    }

    format!("prob_{:x}", hasher.finish())
}

/// Создать ID решения для tracking
pub fn create_solution_id(solution: &Solution, problem: &DetectedProblem) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();

    // Хешируем solution title + problem category
    solution.title.hash(&mut hasher);
    format!("{:?}", problem.category).hash(&mut hasher);

    format!("sol_{:x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use stuzhik_core::{ProblemCategory, ProblemStatus, Severity, SolutionDifficulty};

    #[test]
    fn test_problem_signature_same_for_similar() {
        let problem1 = DetectedProblem {
            id: "1".into(),
            title: "Mod conflict".into(),
            description: "Test".into(),
            severity: Severity::Error,
            category: ProblemCategory::ModConflict,
            status: ProblemStatus::Detected,
            log_line: None,
            line_number: None,
            solutions: vec![],
            docs_links: vec![],
            related_mods: vec!["sodium".into()],
        };

        let problem2 = DetectedProblem {
            id: "2".into(),
            title: "Mod conflict".into(), // Same title
            description: "Different desc".into(),
            severity: Severity::Warning,
            category: ProblemCategory::ModConflict, // Same category
            status: ProblemStatus::Detected,
            log_line: None,
            line_number: None,
            solutions: vec![],
            docs_links: vec![],
            related_mods: vec!["sodium".into()], // Same mod
        };

        let sig1 = create_problem_signature(&problem1);
        let sig2 = create_problem_signature(&problem2);

        assert_eq!(sig1, sig2, "Similar problems should have same signature");
    }

    #[test]
    fn test_solution_id_generation() {
        let problem = DetectedProblem {
            id: "1".into(),
            title: "Test".into(),
            description: "Test".into(),
            severity: Severity::Error,
            category: ProblemCategory::ModConflict,
            status: ProblemStatus::Detected,
            log_line: None,
            line_number: None,
            solutions: vec![],
            docs_links: vec![],
            related_mods: vec![],
        };

        let solution = Solution {
            title: "Remove mod".into(),
            description: "Test".into(),
            auto_fix: None,
            difficulty: SolutionDifficulty::Easy,
            success_rate: 90,
        };

        let id = create_solution_id(&solution, &problem);

        assert!(id.starts_with("sol_"));
        assert!(id.len() > 4);
    }
}
