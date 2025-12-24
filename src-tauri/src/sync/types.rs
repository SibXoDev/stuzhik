use serde::{Deserialize, Serialize};

/// Категория настройки - определяет поведение при синхронизации
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SettingCategory {
    /// Личные настройки - НИКОГДА не синхронизировать
    /// FOV, render distance, звук, управление, яркость
    Personal,

    /// Настройки производительности - зависят от железа
    /// Качество графики, distance, FPS limit
    Performance,

    /// Конфиги модов (геймплей) - синхронизировать по умолчанию
    /// Рецепты, баланс, механики модов
    ModConfig,

    /// Игровые настройки - опционально
    /// Waypoints, JEI bookmarks, HUD положения
    Gameplay,

    /// Визуальные настройки - опционально
    /// Ресурспаки (список), шейдеры (выбор)
    Visual,

    /// Неизвестная категория - требует решения пользователя
    Unknown,
}

impl SettingCategory {
    /// Синхронизировать по умолчанию?
    pub fn sync_by_default(&self) -> bool {
        matches!(self, SettingCategory::ModConfig)
    }

    /// Можно ли вообще синхронизировать?
    pub fn can_sync(&self) -> bool {
        !matches!(self, SettingCategory::Personal)
    }

    /// Описание категории для UI
    pub fn description(&self) -> &'static str {
        match self {
            SettingCategory::Personal => "Личные настройки (не синхронизируются)",
            SettingCategory::Performance => "Производительность (зависит от железа)",
            SettingCategory::ModConfig => "Конфиги модов (геймплей)",
            SettingCategory::Gameplay => "Игровые данные (waypoints, bookmarks)",
            SettingCategory::Visual => "Визуальные (ресурспаки, шейдеры)",
            SettingCategory::Unknown => "Неизвестно",
        }
    }
}

/// Известная настройка в файле
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnownSetting {
    /// Паттерн файла (glob или точное имя)
    /// Примеры: "options.txt", "config/sodium-*.json", "config/*.toml"
    pub file_pattern: String,

    /// Конкретные ключи внутри файла (если применимо)
    /// None = весь файл, Some([]) = только структура, Some(["key1", "key2"]) = конкретные ключи
    pub keys: Option<Vec<String>>,

    /// Категория настройки
    pub category: SettingCategory,

    /// Описание для пользователя
    pub description: String,

    /// Мод-владелец (если известен)
    pub mod_id: Option<String>,
}

/// Профиль синхронизации - предустановка что синхронизировать
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncProfile {
    /// Уникальный ID профиля
    pub id: String,

    /// Название профиля
    pub name: String,

    /// Описание
    pub description: String,

    /// Встроенный профиль (нельзя удалить)
    pub is_builtin: bool,

    /// Какие категории включены
    pub enabled_categories: Vec<SettingCategory>,

    /// Явно исключённые файлы (паттерны)
    pub excluded_files: Vec<String>,

    /// Явно включённые файлы (даже если категория отключена)
    pub included_files: Vec<String>,
}

impl SyncProfile {
    /// Профиль "Только геймплей" - только конфиги модов
    pub fn gameplay_only() -> Self {
        Self {
            id: "gameplay_only".to_string(),
            name: "Только геймплей".to_string(),
            description: "Синхронизирует только конфиги модов (баланс, рецепты). Личные настройки и производительность не трогает.".to_string(),
            is_builtin: true,
            enabled_categories: vec![SettingCategory::ModConfig],
            excluded_files: vec![],
            included_files: vec![],
        }
    }

    /// Профиль "Полная синхронизация" - всё кроме личных
    pub fn full_sync() -> Self {
        Self {
            id: "full_sync".to_string(),
            name: "Полная синхронизация".to_string(),
            description: "Синхронизирует всё кроме личных настроек (FOV, звук, управление)."
                .to_string(),
            is_builtin: true,
            enabled_categories: vec![
                SettingCategory::ModConfig,
                SettingCategory::Gameplay,
                SettingCategory::Visual,
                SettingCategory::Performance,
            ],
            excluded_files: vec![],
            included_files: vec![],
        }
    }

    /// Профиль "Минимальный" - только критичные конфиги
    pub fn minimal() -> Self {
        Self {
            id: "minimal".to_string(),
            name: "Минимальный".to_string(),
            description: "Только критичные настройки модов. Подходит для серверов.".to_string(),
            is_builtin: true,
            enabled_categories: vec![SettingCategory::ModConfig],
            excluded_files: vec![
                // Исключаем клиентские настройки даже для mod configs
                "config/*-client.toml".to_string(),
                "config/*-client.json".to_string(),
                "config/*/client.toml".to_string(),
                "config/*/client.json".to_string(),
            ],
            included_files: vec![],
        }
    }

    /// Все встроенные профили
    pub fn builtin_profiles() -> Vec<Self> {
        vec![Self::gameplay_only(), Self::full_sync(), Self::minimal()]
    }
}

/// Результат классификации файла
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClassifiedFile {
    /// Относительный путь от корня экземпляра
    pub path: String,

    /// Категория
    pub category: SettingCategory,

    /// Размер файла в байтах
    pub size: u64,

    /// Причина классификации
    pub reason: ClassificationReason,

    /// Будет синхронизирован с текущим профилем?
    pub will_sync: bool,

    /// Дополнительная информация
    pub details: Option<String>,
}

/// Причина классификации файла
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClassificationReason {
    /// Известный файл из базы
    KnownFile { matched_pattern: String },

    /// Содержит известные ключи
    KnownKeys { keys: Vec<String> },

    /// Эвристика по имени файла
    FileNameHeuristic,

    /// Эвристика по содержимому
    ContentHeuristic,

    /// По умолчанию для директории
    DirectoryDefault,

    /// Пользовательское правило
    UserRule { rule_id: String },
}

/// Запрос на синхронизацию
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncRequest {
    /// ID исходного экземпляра
    pub source_instance_id: String,

    /// ID целевого экземпляра
    pub target_instance_id: String,

    /// ID профиля синхронизации
    pub profile_id: String,

    /// Дополнительно исключённые файлы (на этот раз)
    pub extra_excluded: Vec<String>,

    /// Дополнительно включённые файлы (на этот раз)
    pub extra_included: Vec<String>,

    /// Режим: preview (только показать) или apply (применить)
    pub mode: SyncMode,
}

/// Режим синхронизации
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncMode {
    /// Только показать что будет синхронизировано
    Preview,
    /// Применить синхронизацию
    Apply,
}

/// Результат синхронизации
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncResult {
    /// Успешно скопированные файлы
    pub synced_files: Vec<String>,

    /// Пропущенные файлы (с причинами)
    pub skipped_files: Vec<SkippedFile>,

    /// Ошибки при копировании
    pub errors: Vec<SyncError>,

    /// Создан ли бэкап
    pub backup_created: bool,

    /// Путь к бэкапу (если создан)
    pub backup_path: Option<String>,

    /// Общий размер синхронизированных данных
    pub total_size: u64,
}

/// Пропущенный файл
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkippedFile {
    pub path: String,
    pub reason: SkipReason,
}

/// Причина пропуска файла
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkipReason {
    /// Категория не включена в профиль
    CategoryDisabled { category: SettingCategory },
    /// Явно исключён в профиле
    ExplicitlyExcluded,
    /// Личная настройка (никогда не синхронизируется)
    PersonalSetting,
    /// Файл не существует в источнике
    NotFound,
    /// Идентичен в целевом экземпляре
    Identical,
}

/// Ошибка синхронизации
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncError {
    pub path: String,
    pub error: String,
}

/// Предпросмотр синхронизации
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncPreview {
    /// Файлы которые будут синхронизированы
    pub files_to_sync: Vec<ClassifiedFile>,

    /// Файлы которые будут пропущены
    pub files_to_skip: Vec<SkippedFile>,

    /// Общий размер
    pub total_size: u64,

    /// Количество по категориям
    pub by_category: std::collections::HashMap<String, usize>,
}

/// Пользовательское правило синхронизации
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserSyncRule {
    /// Уникальный ID
    pub id: String,

    /// Паттерн файла (glob)
    pub file_pattern: String,

    /// Действие
    pub action: UserRuleAction,

    /// Описание (опционально)
    pub description: Option<String>,

    /// Дата создания
    pub created_at: String,
}

/// Действие пользовательского правила
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UserRuleAction {
    /// Всегда синхронизировать
    AlwaysSync,
    /// Никогда не синхронизировать
    NeverSync,
    /// Переопределить категорию
    SetCategory(SettingCategory),
}
