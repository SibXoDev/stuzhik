//! Типы данных для SmartDownloader

use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Тип ресурса для определения стратегии загрузки и зеркал
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ResourceType {
    /// Mojang ресурсы (libraries, assets, client.jar)
    Mojang,
    /// Forge maven artifacts
    Forge,
    /// Fabric maven artifacts
    Fabric,
    /// NeoForge maven artifacts
    NeoForge,
    /// Quilt maven artifacts
    Quilt,
    /// Java (Adoptium)
    Java,
    /// Modrinth CDN
    Modrinth,
    /// CurseForge CDN
    CurseForge,
    /// Неизвестный/прямой URL
    Direct,
}

impl ResourceType {
    /// Определить тип ресурса по URL
    pub fn from_url(url: &str) -> Self {
        if url.contains("mojang.com") || url.contains("minecraft.net") {
            ResourceType::Mojang
        } else if url.contains("minecraftforge.net") {
            ResourceType::Forge
        } else if url.contains("fabricmc.net") {
            ResourceType::Fabric
        } else if url.contains("neoforged.net") {
            ResourceType::NeoForge
        } else if url.contains("quiltmc.org") {
            ResourceType::Quilt
        } else if url.contains("adoptium.net") || url.contains("adoptopenjdk.net") {
            ResourceType::Java
        } else if url.contains("modrinth.com") {
            ResourceType::Modrinth
        } else if url.contains("curseforge.com") || url.contains("forgecdn.net") {
            ResourceType::CurseForge
        } else {
            ResourceType::Direct
        }
    }

    /// Имеет ли этот тип ресурса доступные зеркала
    pub fn has_mirrors(&self) -> bool {
        matches!(
            self,
            ResourceType::Mojang | ResourceType::Forge | ResourceType::Java
        )
    }

    /// Рекомендуемое количество параллельных загрузок
    pub fn recommended_concurrency(&self) -> usize {
        match self {
            // API с rate limits - ограничиваем
            ResourceType::Modrinth => 5,
            ResourceType::CurseForge => 2,
            // CDN без rate limits - можно больше
            ResourceType::Mojang => 50,
            ResourceType::Forge => 20,
            ResourceType::Fabric => 20,
            ResourceType::NeoForge => 20,
            ResourceType::Quilt => 20,
            ResourceType::Java => 4,
            ResourceType::Direct => 10,
        }
    }

    /// Приоритет зеркал (true = зеркало первое, false = оригинал первый)
    pub fn mirror_priority(&self) -> bool {
        match self {
            // Forge зеркала обычно быстрее оригинала
            ResourceType::Forge => true,
            // Java зеркало TUNA обычно быстрее Adoptium
            ResourceType::Java => true,
            // Mojang - оригинал первый (зеркала могут быть устаревшими)
            ResourceType::Mojang => false,
            _ => false,
        }
    }
}

/// Конфигурация загрузки
#[derive(Debug, Clone)]
pub struct DownloadConfig {
    /// Порог скорости (bytes/sec), ниже которого переключаемся на зеркало
    pub speed_threshold: u64,
    /// Время без прогресса до переключения на другое зеркало
    pub stall_timeout: Duration,
    /// Максимум retry на каждое зеркало (для network errors, не stalls)
    pub retries_per_mirror: u32,
    /// Базовая задержка между retry (ms)
    pub retry_delay_ms: u64,
    /// Общий таймаут запроса
    pub request_timeout: Duration,
    /// Таймаут соединения
    pub connect_timeout: Duration,
    /// Лимит скорости загрузки (bytes/sec), 0 = без лимита
    pub bandwidth_limit: u64,
}

impl Default for DownloadConfig {
    fn default() -> Self {
        Self {
            speed_threshold: 10_000, // 10 KB/s
            stall_timeout: Duration::from_secs(10),
            retries_per_mirror: 2,
            retry_delay_ms: 500,
            request_timeout: Duration::from_secs(60),
            connect_timeout: Duration::from_secs(10),
            bandwidth_limit: 0, // Без лимита
        }
    }
}

impl DownloadConfig {
    /// Конфигурация для быстрого соединения
    pub fn fast() -> Self {
        Self {
            speed_threshold: 100_000, // 100 KB/s
            stall_timeout: Duration::from_secs(5),
            retries_per_mirror: 1,
            retry_delay_ms: 250,
            request_timeout: Duration::from_secs(30),
            connect_timeout: Duration::from_secs(10),
            bandwidth_limit: 0,
        }
    }

    /// Конфигурация для медленного/нестабильного соединения
    pub fn slow() -> Self {
        Self {
            speed_threshold: 5_000, // 5 KB/s
            stall_timeout: Duration::from_secs(15),
            retries_per_mirror: 3,
            retry_delay_ms: 1000,
            request_timeout: Duration::from_secs(120),
            connect_timeout: Duration::from_secs(30),
            bandwidth_limit: 0,
        }
    }

    /// Установить лимит скорости загрузки
    pub fn with_bandwidth_limit(mut self, bytes_per_sec: u64) -> Self {
        self.bandwidth_limit = bytes_per_sec;
        self
    }
}

/// Информация о зеркале
#[derive(Debug, Clone)]
pub struct MirrorInfo {
    /// Базовый URL зеркала
    pub base_url: String,
    /// Название зеркала (для логов)
    pub name: String,
    /// Приоритет (меньше = выше приоритет)
    pub priority: u32,
    /// Активно ли зеркало (можно отключить временно)
    pub enabled: bool,
}

impl MirrorInfo {
    pub fn new(base_url: impl Into<String>, name: impl Into<String>, priority: u32) -> Self {
        Self {
            base_url: base_url.into(),
            name: name.into(),
            priority,
            enabled: true,
        }
    }
}

/// Статус загрузки
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DownloadStatus {
    Pending,
    Connecting,
    Resuming,
    Downloading,
    Verifying,
    Completed,
    Failed,
    Cancelled,
    Stalled,
}

impl std::fmt::Display for DownloadStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DownloadStatus::Pending => write!(f, "pending"),
            DownloadStatus::Connecting => write!(f, "connecting"),
            DownloadStatus::Resuming => write!(f, "resuming"),
            DownloadStatus::Downloading => write!(f, "downloading"),
            DownloadStatus::Verifying => write!(f, "verifying"),
            DownloadStatus::Completed => write!(f, "completed"),
            DownloadStatus::Failed => write!(f, "failed"),
            DownloadStatus::Cancelled => write!(f, "cancelled"),
            DownloadStatus::Stalled => write!(f, "stalled"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resource_type_from_url() {
        assert_eq!(
            ResourceType::from_url("https://piston-data.mojang.com/v1/objects/abc"),
            ResourceType::Mojang
        );
        assert_eq!(
            ResourceType::from_url("https://libraries.minecraft.net/com/google/guava.jar"),
            ResourceType::Mojang
        );
        assert_eq!(
            ResourceType::from_url(
                "https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1"
            ),
            ResourceType::Forge
        );
        assert_eq!(
            ResourceType::from_url("https://maven.fabricmc.net/net/fabricmc/fabric-loader/0.15.0"),
            ResourceType::Fabric
        );
        assert_eq!(
            ResourceType::from_url("https://maven.neoforged.net/releases/net/neoforged/neoforge"),
            ResourceType::NeoForge
        );
        assert_eq!(
            ResourceType::from_url("https://cdn.modrinth.com/data/abc123/versions/1.0.0/mod.jar"),
            ResourceType::Modrinth
        );
        assert_eq!(
            ResourceType::from_url("https://edge.forgecdn.net/files/1234/5678/mod.jar"),
            ResourceType::CurseForge
        );
        assert_eq!(
            ResourceType::from_url("https://api.adoptium.net/v3/binary/latest/21"),
            ResourceType::Java
        );
        assert_eq!(
            ResourceType::from_url("https://example.com/some-file.jar"),
            ResourceType::Direct
        );
    }

    #[test]
    fn test_resource_type_has_mirrors() {
        assert!(ResourceType::Mojang.has_mirrors());
        assert!(ResourceType::Forge.has_mirrors());
        assert!(ResourceType::Java.has_mirrors());
        assert!(!ResourceType::Modrinth.has_mirrors());
        assert!(!ResourceType::CurseForge.has_mirrors());
        assert!(!ResourceType::Direct.has_mirrors());
    }

    #[test]
    fn test_download_config_presets() {
        let default = DownloadConfig::default();
        let fast = DownloadConfig::fast();
        let slow = DownloadConfig::slow();

        // Fast должен иметь меньшие таймауты
        assert!(fast.stall_timeout < default.stall_timeout);
        assert!(fast.request_timeout < default.request_timeout);

        // Slow должен иметь большие таймауты
        assert!(slow.stall_timeout > default.stall_timeout);
        assert!(slow.request_timeout > default.request_timeout);
    }
}
