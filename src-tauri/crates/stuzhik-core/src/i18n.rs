use serde::{Deserialize, Serialize};
use std::str::FromStr;

/// Поддерживаемые языки
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    /// Русский
    #[serde(rename = "ru")]
    #[default]
    Russian,
    /// Английский
    #[serde(rename = "en")]
    English,
}

impl Language {
    /// Получить язык из строки (используйте Language::from_str() вместо этого метода)
    pub fn parse(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "ru" | "russian" | "русский" => Some(Language::Russian),
            "en" | "english" | "английский" => Some(Language::English),
            _ => None,
        }
    }

    /// Получить код языка (для сериализации)
    pub fn code(&self) -> &'static str {
        match self {
            Language::Russian => "ru",
            Language::English => "en",
        }
    }

    /// Получить название языка
    pub fn name(&self) -> &'static str {
        match self {
            Language::Russian => "Русский",
            Language::English => "English",
        }
    }
}

impl std::fmt::Display for Language {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.name())
    }
}

impl FromStr for Language {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Language::parse(s).ok_or_else(|| format!("Unknown language: {}", s))
    }
}
