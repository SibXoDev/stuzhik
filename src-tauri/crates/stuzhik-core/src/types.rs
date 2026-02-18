use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSql, ToSqlOutput, ValueRef};
use serde::{Deserialize, Serialize};

/// Supported game types
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum GameType {
    #[default]
    Minecraft,
    Hytale,
}

impl GameType {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Minecraft => "minecraft",
            Self::Hytale => "hytale",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "minecraft" => Some(Self::Minecraft),
            "hytale" => Some(Self::Hytale),
            _ => None,
        }
    }

    pub fn curseforge_id(&self) -> u32 {
        match self {
            Self::Minecraft => 432,
            Self::Hytale => 83374,
        }
    }
}

impl FromSql for GameType {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        match value.as_str()? {
            "minecraft" => Ok(GameType::Minecraft),
            "hytale" => Ok(GameType::Hytale),
            other => Err(FromSqlError::Other(Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("Unknown GameType: {}", other),
            )))),
        }
    }
}

impl ToSql for GameType {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        let s: &'static str = match self {
            GameType::Minecraft => "minecraft",
            GameType::Hytale => "hytale",
        };
        Ok(ToSqlOutput::from(s))
    }
}

#[derive(Debug, Deserialize, Clone)]
#[serde(untagged)]
pub enum OneOrMany<T> {
    One(T),
    Many(Vec<T>),
}

impl<T> OneOrMany<T> {
    pub fn into_vec(self) -> Vec<T> {
        match self {
            OneOrMany::One(t) => vec![t],
            OneOrMany::Many(v) => v,
        }
    }

    pub fn as_slice(&self) -> &[T] {
        match self {
            OneOrMany::One(t) => std::slice::from_ref(t),
            OneOrMany::Many(v) => v.as_slice(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LoaderType {
    Vanilla,
    Forge,
    NeoForge,
    Fabric,
    Quilt,
}

impl LoaderType {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Vanilla => "vanilla",
            Self::Forge => "forge",
            Self::NeoForge => "neoforge",
            Self::Fabric => "fabric",
            Self::Quilt => "quilt",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "vanilla" => Some(Self::Vanilla),
            "forge" => Some(Self::Forge),
            "neoforge" => Some(Self::NeoForge),
            "fabric" => Some(Self::Fabric),
            "quilt" => Some(Self::Quilt),
            _ => None,
        }
    }
}

impl FromSql for LoaderType {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        match value.as_str()? {
            "vanilla" => Ok(LoaderType::Vanilla),
            "forge" => Ok(LoaderType::Forge),
            "neoforge" => Ok(LoaderType::NeoForge),
            "fabric" => Ok(LoaderType::Fabric),
            "quilt" => Ok(LoaderType::Quilt),
            other => Err(FromSqlError::Other(Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("Unknown LoaderType: {}", other),
            )))),
        }
    }
}

impl ToSql for LoaderType {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        let s: &'static str = match self {
            LoaderType::Vanilla => "vanilla",
            LoaderType::Forge => "forge",
            LoaderType::NeoForge => "neoforge",
            LoaderType::Fabric => "fabric",
            LoaderType::Quilt => "quilt",
        };
        Ok(ToSqlOutput::from(s))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InstanceType {
    Client,
    Server,
}

impl InstanceType {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Client => "client",
            Self::Server => "server",
        }
    }
}

impl FromSql for InstanceType {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        match value.as_str()? {
            "client" => Ok(InstanceType::Client),
            "server" => Ok(InstanceType::Server),
            other => Err(FromSqlError::Other(Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("Unknown InstanceType: {}", other),
            )))),
        }
    }
}

impl ToSql for InstanceType {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        let s: &'static str = match self {
            InstanceType::Client => "client",
            InstanceType::Server => "server",
        };
        Ok(ToSqlOutput::from(s))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InstanceStatus {
    Stopped,
    Starting,
    Running,
    Stopping,
    Installing,
    Error,
}

impl InstanceStatus {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Stopped => "stopped",
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Stopping => "stopping",
            Self::Installing => "installing",
            Self::Error => "error",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "stopped" => Self::Stopped,
            "starting" => Self::Starting,
            "running" => Self::Running,
            "stopping" => Self::Stopping,
            "installing" => Self::Installing,
            "error" => Self::Error,
            _ => Self::Error,
        }
    }
}

impl FromSql for InstanceStatus {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        match value.as_str()? {
            "running" => Ok(InstanceStatus::Running),
            "stopped" => Ok(InstanceStatus::Stopped),
            "starting" => Ok(InstanceStatus::Starting),
            "stopping" => Ok(InstanceStatus::Stopping),
            "installing" => Ok(InstanceStatus::Installing),
            "error" => Ok(InstanceStatus::Error),
            other => Err(FromSqlError::Other(Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("Unknown InstanceStatus: {}", other),
            )))),
        }
    }
}

impl ToSql for InstanceStatus {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        let s: &'static str = match self {
            InstanceStatus::Running => "running",
            InstanceStatus::Stopped => "stopped",
            InstanceStatus::Starting => "starting",
            InstanceStatus::Stopping => "stopping",
            InstanceStatus::Installing => "installing",
            InstanceStatus::Error => "error",
        };
        Ok(ToSqlOutput::from(s))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Instance {
    pub id: String,
    pub name: String,
    pub game_type: GameType,
    pub version: String,
    pub loader: LoaderType,
    pub loader_version: Option<String>,
    pub instance_type: InstanceType,

    // Java & Launch
    pub java_version: Option<String>,
    pub java_path: Option<String>,
    pub memory_min: i32,
    pub memory_max: i32,
    pub java_args: Option<String>,
    pub game_args: Option<String>,

    // Paths
    pub dir: String,

    // Server specific
    pub port: Option<i32>,
    pub rcon_enabled: bool,
    pub rcon_port: Option<i32>,
    pub rcon_password: Option<String>,

    // Client specific
    pub username: Option<String>,

    // Status
    pub status: InstanceStatus,
    pub auto_restart: bool,
    pub last_played: Option<String>,
    pub total_playtime: i64,
    pub notes: Option<String>,

    // Installation persistence
    pub installation_step: Option<String>,
    pub installation_error: Option<String>,

    // Backup override (None = использовать глобальную настройку)
    pub backup_enabled: Option<bool>,

    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModSource {
    Modrinth,
    CurseForge,
    Local,
}

impl ModSource {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Modrinth => "modrinth",
            Self::CurseForge => "curseforge",
            Self::Local => "local",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Mod {
    pub id: i64,
    pub instance_id: String,

    pub slug: String,
    pub name: String,
    pub version: String,
    pub minecraft_version: String,

    pub source: ModSource,
    pub source_id: Option<String>,
    pub project_url: Option<String>,
    pub download_url: Option<String>,

    pub file_name: String,
    pub file_hash: Option<String>,
    pub file_size: Option<i64>,

    pub enabled: bool,
    pub auto_update: bool,

    pub description: Option<String>,
    pub author: Option<String>,
    pub icon_url: Option<String>,
    pub categories: Option<Vec<String>>,

    pub installed_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DependencyType {
    Required,
    Optional,
    Incompatible,
}

impl DependencyType {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Required => "required",
            Self::Optional => "optional",
            Self::Incompatible => "incompatible",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModDependency {
    pub id: i64,
    pub mod_id: i64,
    pub dependency_slug: String,
    pub dependency_type: DependencyType,
    pub version_requirement: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JavaInstallation {
    pub id: i64,
    pub version: String,
    pub path: String,
    pub vendor: Option<String>,
    pub architecture: Option<String>,
    pub is_auto_installed: bool,
    pub installed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MinecraftVersion {
    pub id: String,
    #[serde(rename = "type")]
    pub version_type: String,
    pub release_time: String,
    pub url: String,
    pub java_version: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoaderVersion {
    pub id: i64,
    pub loader: LoaderType,
    pub minecraft_version: String,
    pub loader_version: String,
    pub stable: bool,
    pub url: Option<String>,
}

// DTO для создания экземпляра
#[derive(Debug, Deserialize)]
pub struct CreateInstanceRequest {
    pub name: String,
    pub game_type: Option<String>,  // "minecraft" | "hytale", defaults to minecraft
    pub version: String,
    pub loader: String,
    pub loader_version: Option<String>,
    pub instance_type: String,

    pub memory_min: Option<i32>,
    pub memory_max: Option<i32>,
    pub java_args: Option<String>,
    pub game_args: Option<String>,

    pub port: Option<i32>,
    pub username: Option<String>,
    pub notes: Option<String>,
}

// DTO для установки мода
#[derive(Debug, Deserialize)]
pub struct InstallModRequest {
    pub instance_id: String,
    pub slug: String,
    pub source: String,
    pub version: Option<String>,
}

// Ответ с прогрессом загрузки
#[derive(Debug, Clone, Serialize)]
pub struct DownloadProgress {
    pub id: String,
    pub name: String,
    pub downloaded: u64,
    pub total: u64,
    pub speed: u64,
    pub status: String,
}

// ============================================================================
// Log Analyzer Types
// ============================================================================

/// Результат анализа класса
#[derive(Debug, Clone, PartialEq)]
pub enum ClassAnalysisResult {
    /// Это библиотека, не мод - игнорировать
    Library,
    /// Это часть Minecraft - игнорировать
    Minecraft,
    /// Это загрузчик модов (forge/fabric/etc)
    Loader(String),
    /// Это мод с известным ID
    Mod(String),
    /// Неизвестный класс
    Unknown,
}

/// Уровень серьёзности проблемы
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Info,
    Warning,
    Error,
    Critical,
}

/// Статус проблемы
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ProblemStatus {
    /// Проблема обнаружена, не исправлена
    #[default]
    Detected,
    /// Исправление применено, ожидает перезапуска
    AwaitingRestart,
    /// Проблема решена
    Resolved,
    /// Не удалось исправить
    Failed,
}

/// Категория проблемы
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ProblemCategory {
    ModConflict,
    MissingDependency,
    JavaIssue,
    MemoryIssue,
    CorruptedFile,
    VersionMismatch,
    ConfigError,
    NetworkError,
    PermissionError,
    CrashDuringStartup,
    CrashDuringGameplay,
    RenderingError,
    AudioError,
    Unknown,
}

impl ProblemCategory {
    /// Приоритет категории для сортировки (меньше = важнее, показывается первым).
    /// Root causes (основные причины) имеют наивысший приоритет.
    pub fn priority(&self) -> u8 {
        match self {
            // Root causes - показываем первыми
            ProblemCategory::JavaIssue => 0,
            ProblemCategory::MissingDependency => 1,
            ProblemCategory::VersionMismatch => 2,
            ProblemCategory::CorruptedFile => 3,
            ProblemCategory::MemoryIssue => 4,
            ProblemCategory::CrashDuringStartup => 5,
            ProblemCategory::ModConflict => 6,
            ProblemCategory::ConfigError => 7,
            ProblemCategory::RenderingError => 8,
            ProblemCategory::AudioError => 9,
            ProblemCategory::NetworkError => 10,
            ProblemCategory::CrashDuringGameplay => 11,
            ProblemCategory::PermissionError => 12,
            ProblemCategory::Unknown => 99,
        }
    }
}

/// Тип автоматического исправления
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AutoFix {
    #[serde(rename = "remove_mod")]
    RemoveMod { filename: String },
    #[serde(rename = "download_mod")]
    DownloadMod {
        name: String,
        source: String,
        project_id: String,
    },
    #[serde(rename = "change_jvm_arg")]
    ChangeJvmArg {
        old_arg: Option<String>,
        new_arg: String,
    },
    #[serde(rename = "increase_ram")]
    IncreaseRam { recommended_mb: u32 },
    #[serde(rename = "reinstall_mod")]
    ReinstallMod { filename: String },
    #[serde(rename = "delete_config")]
    DeleteConfig { path: String },
    #[serde(rename = "install_java")]
    InstallJava { version: u32 },
    #[serde(rename = "update_loader")]
    UpdateLoader { loader: String },
    #[serde(rename = "reset_configs")]
    ResetConfigs,
    #[serde(rename = "verify_files")]
    VerifyFiles,
}

/// Обнаруженная проблема
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectedProblem {
    pub id: String,
    pub title: String,
    pub description: String,
    pub severity: Severity,
    pub category: ProblemCategory,
    #[serde(default)]
    pub status: ProblemStatus,
    pub log_line: Option<String>,
    pub line_number: Option<u32>,
    pub solutions: Vec<Solution>,
    pub docs_links: Vec<String>,
    pub related_mods: Vec<String>,
}

/// Предложенное решение
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Solution {
    pub title: String,
    pub description: String,
    pub auto_fix: Option<AutoFix>,
    pub difficulty: SolutionDifficulty,
    pub success_rate: u8,
}

/// Сложность решения
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SolutionDifficulty {
    Easy,
    Medium,
    Hard,
    Expert,
}

/// Результат анализа лога
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogAnalysisResult {
    pub problems: Vec<DetectedProblem>,
    pub summary: AnalysisSummary,
    pub optimizations: Vec<Optimization>,
    pub crash_info: Option<CrashInfo>,
    #[serde(default)]
    pub error_groups: Vec<ErrorGroup>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub performance: Option<PerformanceAnalysis>,
}

/// Сводка анализа
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisSummary {
    pub total_lines: u32,
    pub error_count: u32,
    pub warning_count: u32,
    pub critical_count: u32,
    pub parse_time_ms: u64,
}

/// Рекомендация по оптимизации
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Optimization {
    pub title: String,
    pub description: String,
    pub impact: String,
    pub auto_fix: Option<AutoFix>,
}

/// Информация о краше
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrashInfo {
    pub main_cause: String,
    pub stack_trace: Vec<String>,
    pub culprit_mod: Option<String>,
    pub recommendations: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minecraft_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mod_loader: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loader_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub java_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operating_system: Option<String>,
    #[serde(default)]
    pub loaded_mods: Vec<ModInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crash_time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub affected_level: Option<AffectedLevel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_info: Option<SystemInfo>,
}

/// Информация о загруженном моде
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModInfo {
    pub id: String,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
}

/// Информация об affected level
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AffectedLevel {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dimension: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coordinates: Option<String>,
}

/// Системная информация
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opengl_version: Option<String>,
}

/// Группа связанных ошибок
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorGroup {
    pub id: String,
    pub name: String,
    pub problems: Vec<DetectedProblem>,
    pub severity: Severity,
    pub count: u32,
}

/// Анализ производительности
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PerformanceAnalysis {
    pub tps_issues: Vec<TpsIssue>,
    pub memory_issues: Vec<MemoryIssue>,
    pub lag_spikes: Vec<LagSpike>,
    pub slow_mods: Vec<SlowMod>,
    pub health_score: u8,
}

/// Проблема с TPS
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TpsIssue {
    pub current_tps: f32,
    pub expected_tps: f32,
    pub cause: Option<String>,
    pub log_line: Option<String>,
}

/// Проблема с памятью
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryIssue {
    pub issue_type: MemoryIssueType,
    pub used_mb: Option<u64>,
    pub available_mb: Option<u64>,
    pub description: String,
}

/// Тип проблемы с памятью
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryIssueType {
    HighHeapUsage,
    FrequentGc,
    PotentialLeak,
    InsufficientAllocation,
}

/// Лаговый спайк
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LagSpike {
    pub duration_ms: u64,
    pub timestamp: Option<String>,
    pub cause: Option<String>,
}

/// Медленный мод
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlowMod {
    pub mod_id: String,
    pub avg_tick_ms: f32,
    pub tick_percentage: f32,
}

/// Информация о лог-файле
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogFileInfo {
    pub path: String,
    pub source: String,
    pub size: u64,
    pub modified_timestamp: Option<u64>,
}

/// Отчёт анализа
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisReport {
    pub log_file: LogFileInfo,
    pub result: LogAnalysisResult,
    pub analyzed_at: String,
}

/// Анализ цепочек ошибок
#[derive(Debug, Clone, Default)]
pub struct ErrorChainAnalysis {
    pub root_causes: Vec<String>,
    pub caused_by_chains: std::collections::HashMap<String, Vec<String>>,
    pub exception_sequence: Vec<(usize, String)>,
}
