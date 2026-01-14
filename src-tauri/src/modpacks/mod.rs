// Модульная структура для работы с модпаками

pub mod editor;
pub mod install;
pub mod patch;
pub mod preview;
pub mod search;
pub mod types;

// Реэкспорт всех публичных типов
pub use types::*;

// Реэкспорт ModpackManager
pub use search::ModpackManager;
