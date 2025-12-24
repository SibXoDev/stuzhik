// Modular instances structure
pub mod execution;
pub mod installation;
pub mod lifecycle;
pub mod utilities;

// Re-export what's used through this module level
pub use lifecycle::{create_instance, get_instance, list_instances};
pub use utilities::cleanup_dead_processes;
