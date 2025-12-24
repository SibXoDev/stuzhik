//! MirrorRegistry - централизованное управление зеркалами

use super::types::{MirrorInfo, ResourceType};
use std::collections::HashMap;

/// Централизованный реестр зеркал для всех типов ресурсов
#[derive(Debug, Clone)]
pub struct MirrorRegistry {
    /// Зеркала по типу ресурса
    mirrors: HashMap<ResourceType, Vec<MirrorRule>>,
}

/// Правило замены URL для зеркала
#[derive(Debug, Clone)]
pub struct MirrorRule {
    /// Паттерн оригинального хоста для замены
    pub original_host: String,
    /// Замена на этот хост/путь
    pub mirror_host: String,
    /// Информация о зеркале
    pub info: MirrorInfo,
}

impl MirrorRule {
    pub fn new(original: impl Into<String>, mirror: impl Into<String>, info: MirrorInfo) -> Self {
        Self {
            original_host: original.into(),
            mirror_host: mirror.into(),
            info,
        }
    }
}

impl Default for MirrorRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl MirrorRegistry {
    /// Создать реестр с предустановленными зеркалами
    pub fn new() -> Self {
        let mut registry = Self {
            mirrors: HashMap::new(),
        };

        // Регистрируем зеркала для каждого типа ресурса
        registry.register_mojang_mirrors();
        registry.register_forge_mirrors();
        registry.register_java_mirrors();

        registry
    }

    /// Создать пустой реестр (без предустановленных зеркал)
    pub fn empty() -> Self {
        Self {
            mirrors: HashMap::new(),
        }
    }

    /// Зарегистрировать зеркала Mojang
    fn register_mojang_mirrors(&mut self) {
        let mojang_rules = vec![
            // Оригинальные URL (приоритет 0 = первые по умолчанию для Mojang)
            MirrorRule::new(
                "piston-data.mojang.com",
                "piston-data.mojang.com",
                MirrorInfo::new("https://piston-data.mojang.com", "Mojang (Original)", 0),
            ),
            MirrorRule::new(
                "piston-meta.mojang.com",
                "piston-meta.mojang.com",
                MirrorInfo::new(
                    "https://piston-meta.mojang.com",
                    "Mojang Meta (Original)",
                    0,
                ),
            ),
            MirrorRule::new(
                "launcher.mojang.com",
                "launcher.mojang.com",
                MirrorInfo::new(
                    "https://launcher.mojang.com",
                    "Mojang Launcher (Original)",
                    0,
                ),
            ),
            MirrorRule::new(
                "libraries.minecraft.net",
                "libraries.minecraft.net",
                MirrorInfo::new(
                    "https://libraries.minecraft.net",
                    "Minecraft Libraries (Original)",
                    0,
                ),
            ),
            MirrorRule::new(
                "resources.download.minecraft.net",
                "resources.download.minecraft.net",
                MirrorInfo::new(
                    "https://resources.download.minecraft.net",
                    "Minecraft Resources (Original)",
                    0,
                ),
            ),
            // BMCLAPI зеркала (приоритет 10 = fallback для Mojang)
            MirrorRule::new(
                "piston-data.mojang.com",
                "bmclapi2.bangbang93.com/assets",
                MirrorInfo::new("https://bmclapi2.bangbang93.com", "BMCLAPI (China)", 10),
            ),
            MirrorRule::new(
                "piston-meta.mojang.com",
                "bmclapi2.bangbang93.com",
                MirrorInfo::new("https://bmclapi2.bangbang93.com", "BMCLAPI (China)", 10),
            ),
            MirrorRule::new(
                "launcher.mojang.com",
                "bmclapi2.bangbang93.com",
                MirrorInfo::new("https://bmclapi2.bangbang93.com", "BMCLAPI (China)", 10),
            ),
            MirrorRule::new(
                "libraries.minecraft.net",
                "bmclapi2.bangbang93.com/maven",
                MirrorInfo::new("https://bmclapi2.bangbang93.com", "BMCLAPI (China)", 10),
            ),
            MirrorRule::new(
                "resources.download.minecraft.net",
                "bmclapi2.bangbang93.com/assets",
                MirrorInfo::new("https://bmclapi2.bangbang93.com", "BMCLAPI (China)", 10),
            ),
        ];

        self.mirrors.insert(ResourceType::Mojang, mojang_rules);
    }

    /// Зарегистрировать зеркала Forge
    fn register_forge_mirrors(&mut self) {
        // Для Forge: зеркало BMCLAPI приоритетнее (обычно быстрее)
        let forge_rules = vec![
            // BMCLAPI зеркала (приоритет 0 = первые для Forge)
            MirrorRule::new(
                "maven.minecraftforge.net",
                "bmclapi2.bangbang93.com/maven",
                MirrorInfo::new("https://bmclapi2.bangbang93.com", "BMCLAPI Forge Mirror", 0),
            ),
            MirrorRule::new(
                "files.minecraftforge.net",
                "bmclapi2.bangbang93.com/maven",
                MirrorInfo::new("https://bmclapi2.bangbang93.com", "BMCLAPI Forge Mirror", 0),
            ),
            // Оригинальные URL (приоритет 10 = fallback для Forge)
            MirrorRule::new(
                "maven.minecraftforge.net",
                "maven.minecraftforge.net",
                MirrorInfo::new(
                    "https://maven.minecraftforge.net",
                    "Forge Maven (Original)",
                    10,
                ),
            ),
            MirrorRule::new(
                "files.minecraftforge.net",
                "files.minecraftforge.net",
                MirrorInfo::new(
                    "https://files.minecraftforge.net",
                    "Forge Files (Original)",
                    10,
                ),
            ),
        ];

        self.mirrors.insert(ResourceType::Forge, forge_rules);
    }

    /// Зарегистрировать зеркала Java (Adoptium)
    fn register_java_mirrors(&mut self) {
        // Для Java: TUNA зеркало приоритетнее
        let java_rules = vec![
            // TUNA зеркало (Tsinghua University - официальное зеркало Adoptium)
            MirrorRule::new(
                "api.adoptium.net",
                "mirrors.tuna.tsinghua.edu.cn/Adoptium",
                MirrorInfo::new(
                    "https://mirrors.tuna.tsinghua.edu.cn/Adoptium",
                    "TUNA Adoptium Mirror",
                    0,
                ),
            ),
            // Оригинал Adoptium
            MirrorRule::new(
                "api.adoptium.net",
                "api.adoptium.net",
                MirrorInfo::new("https://api.adoptium.net", "Adoptium (Original)", 10),
            ),
        ];

        self.mirrors.insert(ResourceType::Java, java_rules);
    }

    /// Добавить кастомное зеркало для типа ресурса
    pub fn add_mirror(&mut self, resource_type: ResourceType, rule: MirrorRule) {
        self.mirrors.entry(resource_type).or_default().push(rule);
    }

    /// Получить все URL для загрузки (оригинал + зеркала)
    /// Возвращает в порядке приоритета
    pub fn get_mirror_urls(&self, url: &str) -> Vec<String> {
        let resource_type = ResourceType::from_url(url);

        // Если нет зеркал для этого типа - возвращаем только оригинал
        let Some(rules) = self.mirrors.get(&resource_type) else {
            return vec![url.to_string()];
        };

        let mut urls: Vec<(u32, String)> = Vec::new();

        for rule in rules {
            if !rule.info.enabled {
                continue;
            }

            if url.contains(&rule.original_host) {
                let mirrored = url.replace(&rule.original_host, &rule.mirror_host);
                urls.push((rule.info.priority, mirrored));
            }
        }

        // Если не нашли подходящих зеркал - возвращаем оригинал
        if urls.is_empty() {
            return vec![url.to_string()];
        }

        // Сортируем по приоритету (меньше = первее)
        urls.sort_by_key(|(priority, _)| *priority);

        // Убираем дубликаты сохраняя порядок
        let mut result = Vec::new();
        for (_, mirror_url) in urls {
            if !result.contains(&mirror_url) {
                result.push(mirror_url);
            }
        }

        result
    }

    /// Получить URL для Java с учётом структуры TUNA зеркала
    /// TUNA структура: https://mirrors.tuna.tsinghua.edu.cn/Adoptium/{version}/jdk/{arch}/{os}/{filename}
    pub fn get_java_mirror_urls(
        &self,
        original_url: &str,
        version: u32,
        arch: &str,
        os: &str,
        filename: &str,
    ) -> Vec<String> {
        let mut urls = Vec::new();

        // TUNA зеркало (приоритет)
        let tuna_url = format!(
            "https://mirrors.tuna.tsinghua.edu.cn/Adoptium/{}/jdk/{}/{}/{}",
            version, arch, os, filename
        );
        urls.push(tuna_url);

        // Оригинальный URL как fallback
        urls.push(original_url.to_string());

        urls
    }

    /// Включить/выключить зеркало
    pub fn set_mirror_enabled(
        &mut self,
        resource_type: ResourceType,
        mirror_name: &str,
        enabled: bool,
    ) {
        if let Some(rules) = self.mirrors.get_mut(&resource_type) {
            for rule in rules.iter_mut() {
                if rule.info.name == mirror_name {
                    rule.info.enabled = enabled;
                }
            }
        }
    }

    /// Получить список всех зеркал для типа ресурса
    pub fn list_mirrors(&self, resource_type: ResourceType) -> Vec<&MirrorInfo> {
        self.mirrors
            .get(&resource_type)
            .map(|rules| rules.iter().map(|r| &r.info).collect())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mojang_mirrors() {
        let registry = MirrorRegistry::new();

        // Для Mojang URL - оригинал должен быть первым
        let urls = registry.get_mirror_urls("https://piston-data.mojang.com/v1/objects/abc123");
        assert!(!urls.is_empty());
        assert!(urls[0].contains("piston-data.mojang.com")); // Оригинал первый
        assert!(urls.len() >= 2); // Должно быть хотя бы 2 (оригинал + BMCLAPI)
    }

    #[test]
    fn test_forge_mirrors() {
        let registry = MirrorRegistry::new();

        // Для Forge URL - BMCLAPI должен быть первым
        let urls =
            registry.get_mirror_urls("https://maven.minecraftforge.net/net/minecraftforge/forge");
        assert!(!urls.is_empty());
        assert!(urls[0].contains("bmclapi")); // Зеркало первое для Forge
    }

    #[test]
    fn test_java_mirrors() {
        let registry = MirrorRegistry::new();

        let urls = registry.get_java_mirror_urls(
            "https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse",
            21,
            "x64",
            "linux",
            "OpenJDK21U-jdk_x64_linux_hotspot.tar.gz",
        );

        assert_eq!(urls.len(), 2);
        assert!(urls[0].contains("tuna")); // TUNA первый
        assert!(urls[1].contains("adoptium")); // Оригинал второй
    }

    #[test]
    fn test_no_mirrors_for_direct() {
        let registry = MirrorRegistry::new();

        let urls = registry.get_mirror_urls("https://example.com/some-file.jar");
        assert_eq!(urls.len(), 1);
        assert_eq!(urls[0], "https://example.com/some-file.jar");
    }

    #[test]
    fn test_disable_mirror() {
        let mut registry = MirrorRegistry::new();

        // Отключаем BMCLAPI для Forge
        registry.set_mirror_enabled(ResourceType::Forge, "BMCLAPI Forge Mirror", false);

        let urls =
            registry.get_mirror_urls("https://maven.minecraftforge.net/net/minecraftforge/forge");

        // Теперь BMCLAPI не должен быть в списке, только оригинал
        assert!(urls.iter().all(|u| !u.contains("bmclapi")));
    }
}
