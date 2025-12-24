pub mod db;
pub mod knowledge_base;
pub mod migrations;

// Re-export commonly used items
pub use db::{get_db_conn, init_db, DB_PATH};
pub use knowledge_base::{
    create_problem_signature, create_solution_id, KnowledgeBase, KnowledgeBaseStats,
    PersonalizedSolution, SolutionFeedback, SolutionRating,
};
