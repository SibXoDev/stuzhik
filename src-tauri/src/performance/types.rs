use serde::{Deserialize, Serialize};

/// Snapshot производительности в момент времени
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PerformanceSnapshot {
    /// Timestamp снимка (ISO 8601)
    pub timestamp: String,
    /// Использование RAM процессом (MB)
    pub memory_used_mb: u64,
    /// Максимальная RAM процесса (MB), если доступно
    pub memory_max_mb: Option<u64>,
    /// Загрузка CPU процессом (0-100%)
    pub cpu_percent: f32,
    /// Количество логических процессоров (потоков) в системе
    pub cpu_cores: u32,
    /// Количество физических ядер CPU
    pub physical_cores: u32,
    /// Загрузка каждого логического процессора (0-100%)
    pub cpu_per_core: Vec<f32>,
    /// TPS если доступно (из логов/Spark)
    pub tps: Option<f32>,
    /// MSPT (milliseconds per tick) если доступно
    pub mspt: Option<f32>,
}

/// Производительность отдельного мода
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModPerformance {
    /// ID мода
    pub mod_id: String,
    /// Название мода
    pub mod_name: String,
    /// Среднее время тика (ms)
    pub tick_time_avg_ms: f32,
    /// Максимальное время тика (ms)
    pub tick_time_max_ms: f32,
    /// Процент от общего времени тика
    pub tick_percent: f32,
    /// Использование памяти (MB), если доступно
    pub memory_mb: Option<f32>,
    /// Impact score (0-100) - влияние на производительность
    pub impact_score: f32,
    /// Категория влияния
    pub impact_category: ImpactCategory,
}

/// Категория влияния на производительность
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ImpactCategory {
    /// Минимальное влияние (< 5%)
    Minimal,
    /// Низкое влияние (5-15%)
    Low,
    /// Среднее влияние (15-30%)
    Medium,
    /// Высокое влияние (30-50%)
    High,
    /// Критическое влияние (> 50%)
    Critical,
}

impl ImpactCategory {
    pub fn from_score(score: f32) -> Self {
        match score {
            s if s < 5.0 => ImpactCategory::Minimal,
            s if s < 15.0 => ImpactCategory::Low,
            s if s < 30.0 => ImpactCategory::Medium,
            s if s < 50.0 => ImpactCategory::High,
            _ => ImpactCategory::Critical,
        }
    }
}

/// Узкое место производительности
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PerformanceBottleneck {
    /// Категория проблемы
    pub category: BottleneckCategory,
    /// Описание проблемы
    pub description: String,
    /// Серьёзность
    pub severity: BottleneckSeverity,
    /// Связанный мод (если определён)
    pub mod_id: Option<String>,
    /// Метрика (например, "45ms tick time")
    pub metric: Option<String>,
}

/// Категории узких мест
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum BottleneckCategory {
    /// Проблемы с памятью
    Memory,
    /// Долгие тики
    TickTime,
    /// Сетевые задержки
    NetworkLag,
    /// Задержки рендеринга
    RenderLag,
    /// Загрузка чанков
    ChunkLoading,
    /// Проблемы с GC
    GarbageCollection,
    /// Проблемы с I/O
    DiskIO,
}

/// Серьёзность узкого места
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Ord, PartialOrd, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BottleneckSeverity {
    Low,
    Medium,
    High,
    Critical,
}

/// Рекомендация по оптимизации
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PerformanceRecommendation {
    /// Заголовок рекомендации
    pub title: String,
    /// Описание
    pub description: String,
    /// Рекомендуемое действие
    pub action: RecommendedAction,
    /// Ожидаемый эффект ("High", "Medium", "Low")
    pub expected_impact: String,
    /// Приоритет (1-10, где 10 - наивысший)
    pub priority: u8,
}

/// Рекомендуемые действия
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RecommendedAction {
    /// Увеличить память
    IncreaseMemory {
        current_mb: u32,
        recommended_mb: u32,
    },
    /// Уменьшить дальность прорисовки
    ReduceRenderDistance { current: u32, recommended: u32 },
    /// Отключить мод
    DisableMod { mod_id: String, reason: String },
    /// Установить мод оптимизации
    InstallOptimizationMod {
        mod_id: String,
        mod_name: String,
        description: String,
    },
    /// Обновить мод
    UpdateMod { mod_id: String, reason: String },
    /// Изменить настройку
    ChangeSetting {
        setting_name: String,
        current_value: String,
        recommended_value: String,
        file_path: Option<String>,
    },
    /// Добавить JVM аргумент
    AddJvmArgument { argument: String, reason: String },
}

/// Полный отчёт о производительности
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PerformanceReport {
    /// ID экземпляра
    pub instance_id: String,
    /// Время создания отчёта
    pub created_at: String,
    /// Длительность мониторинга (секунды)
    pub monitoring_duration_sec: u64,
    /// Снимки производительности
    pub snapshots: Vec<PerformanceSnapshot>,
    /// Производительность модов (если Spark доступен)
    pub mod_performance: Vec<ModPerformance>,
    /// Обнаруженные узкие места
    pub bottlenecks: Vec<PerformanceBottleneck>,
    /// Рекомендации
    pub recommendations: Vec<PerformanceRecommendation>,
    /// Общая оценка (0-100, где 100 - отлично)
    pub overall_score: f32,
    /// Источник данных
    pub data_source: DataSource,
    /// Обнаружен ли Spark
    pub spark_detected: bool,
}

/// Источник данных для отчёта
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DataSource {
    /// Только системный мониторинг (RAM/CPU)
    SystemOnly,
    /// Системный + анализ логов
    SystemAndLogs,
    /// Полный анализ через Spark
    SparkReport,
}

/// Статус мониторинга
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonitoringStatus {
    /// Активен ли мониторинг
    pub active: bool,
    /// ID экземпляра
    pub instance_id: Option<String>,
    /// PID процесса
    pub pid: Option<u32>,
    /// Время начала мониторинга
    pub started_at: Option<String>,
    /// Количество собранных снимков
    pub snapshots_count: u32,
}

/// Информация о Spark
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SparkInfo {
    /// Обнаружен ли Spark
    pub detected: bool,
    /// Версия Spark (если известна)
    pub version: Option<String>,
    /// Путь к последнему отчёту
    pub latest_report_path: Option<String>,
    /// Время последнего отчёта
    pub latest_report_time: Option<String>,
}

/// Данные из Spark отчёта
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SparkReportData {
    /// TPS
    pub tps: Option<f32>,
    /// MSPT статистика
    pub mspt: Option<MsptStats>,
    /// Данные по тикам
    pub tick_data: Vec<SparkTickEntry>,
    /// GC статистика
    pub gc_stats: Option<GcStats>,
}

/// MSPT статистика
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MsptStats {
    pub min: f32,
    pub max: f32,
    pub avg: f32,
    pub median: f32,
}

/// Запись о тике из Spark
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SparkTickEntry {
    /// Название (мод/категория)
    pub name: String,
    /// Время (ms)
    pub time_ms: f32,
    /// Процент от общего
    pub percent: f32,
    /// Количество вызовов
    pub count: u32,
}

/// GC статистика
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GcStats {
    /// Количество minor GC
    pub minor_gc_count: u32,
    /// Время minor GC (ms)
    pub minor_gc_time_ms: u64,
    /// Количество major GC
    pub major_gc_count: u32,
    /// Время major GC (ms)
    pub major_gc_time_ms: u64,
}

/// Event для real-time мониторинга
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PerformanceEvent {
    /// Мониторинг начат
    Started { instance_id: String, pid: u32 },
    /// Мониторинг остановлен
    Stopped { instance_id: String },
    /// Новый снимок
    Snapshot {
        instance_id: String,
        snapshot: PerformanceSnapshot,
    },
    /// Обнаружена проблема
    BottleneckDetected {
        instance_id: String,
        bottleneck: PerformanceBottleneck,
    },
    /// Ошибка мониторинга
    Error {
        instance_id: String,
        message: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_impact_category_from_score() {
        assert_eq!(ImpactCategory::from_score(0.0), ImpactCategory::Minimal);
        assert_eq!(ImpactCategory::from_score(4.9), ImpactCategory::Minimal);
        assert_eq!(ImpactCategory::from_score(5.0), ImpactCategory::Low);
        assert_eq!(ImpactCategory::from_score(14.9), ImpactCategory::Low);
        assert_eq!(ImpactCategory::from_score(15.0), ImpactCategory::Medium);
        assert_eq!(ImpactCategory::from_score(29.9), ImpactCategory::Medium);
        assert_eq!(ImpactCategory::from_score(30.0), ImpactCategory::High);
        assert_eq!(ImpactCategory::from_score(49.9), ImpactCategory::High);
        assert_eq!(ImpactCategory::from_score(50.0), ImpactCategory::Critical);
        assert_eq!(ImpactCategory::from_score(100.0), ImpactCategory::Critical);
    }

    #[test]
    fn test_serialization() {
        let snapshot = PerformanceSnapshot {
            timestamp: "2025-12-06T10:00:00Z".to_string(),
            memory_used_mb: 2048,
            memory_max_mb: Some(4096),
            cpu_percent: 45.5,
            cpu_cores: 12,
            physical_cores: 6,
            cpu_per_core: vec![
                50.0, 45.0, 60.0, 40.0, 55.0, 48.0, 52.0, 47.0, 58.0, 42.0, 53.0, 49.0,
            ],
            tps: Some(20.0),
            mspt: Some(45.0),
        };

        let json = serde_json::to_string(&snapshot).unwrap();
        assert!(json.contains("memory_used_mb"));
        assert!(json.contains("2048"));
        assert!(json.contains("cpu_cores"));
        assert!(json.contains("physical_cores"));
        assert!(json.contains("cpu_per_core"));
    }
}
