//! Peer Groups - Группировка пиров для batch операций
//!
//! Позволяет создавать группы пиров для удобной отправки модпаков нескольким людям.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Группа пиров
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerGroup {
    /// Уникальный ID группы
    pub id: String,
    /// Название группы
    pub name: String,
    /// Описание группы
    pub description: Option<String>,
    /// ID пиров в группе
    pub peer_ids: HashSet<String>,
    /// Цвет группы (hex, например "#FF5733")
    pub color: Option<String>,
    /// Иконка группы (emoji или имя иконки)
    pub icon: Option<String>,
    /// Время создания
    pub created_at: String,
    /// Время последнего изменения
    pub updated_at: String,
}

impl PeerGroup {
    pub fn new(name: &str) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.to_string(),
            description: None,
            peer_ids: HashSet::new(),
            color: None,
            icon: None,
            created_at: now.clone(),
            updated_at: now,
        }
    }

    /// Добавить пира в группу
    pub fn add_peer(&mut self, peer_id: &str) {
        self.peer_ids.insert(peer_id.to_string());
        self.updated_at = chrono::Utc::now().to_rfc3339();
    }

    /// Удалить пира из группы
    pub fn remove_peer(&mut self, peer_id: &str) {
        self.peer_ids.remove(peer_id);
        self.updated_at = chrono::Utc::now().to_rfc3339();
    }

    /// Проверить, есть ли пир в группе
    pub fn contains(&self, peer_id: &str) -> bool {
        self.peer_ids.contains(peer_id)
    }

    /// Количество пиров в группе
    pub fn len(&self) -> usize {
        self.peer_ids.len()
    }

    /// Пустая ли группа
    pub fn is_empty(&self) -> bool {
        self.peer_ids.is_empty()
    }
}

/// Менеджер групп пиров
pub struct PeerGroupManager {
    /// Группы по ID
    groups: Arc<RwLock<HashMap<String, PeerGroup>>>,
    /// Путь к файлу для сохранения
    storage_path: PathBuf,
}

impl PeerGroupManager {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            groups: Arc::new(RwLock::new(HashMap::new())),
            storage_path: data_dir.join("p2p_groups.json"),
        }
    }

    /// Загрузить группы из файла
    pub async fn load(&self) -> Result<(), String> {
        if !tokio::fs::try_exists(&self.storage_path).await.unwrap_or(false) {
            return Ok(());
        }

        let data = tokio::fs::read_to_string(&self.storage_path)
            .await
            .map_err(|e| format!("Failed to read groups file: {}", e))?;

        let groups: Vec<PeerGroup> =
            serde_json::from_str(&data).map_err(|e| format!("Failed to parse groups: {}", e))?;

        let mut guard = self.groups.write().await;
        for group in groups {
            guard.insert(group.id.clone(), group);
        }

        log::info!("Loaded {} peer groups", guard.len());
        Ok(())
    }

    /// Сохранить группы в файл
    pub async fn save(&self) -> Result<(), String> {
        let guard = self.groups.read().await;
        let groups: Vec<_> = guard.values().collect();

        let data = serde_json::to_string_pretty(&groups)
            .map_err(|e| format!("Failed to serialize groups: {}", e))?;

        // Создаём директорию если не существует
        if let Some(parent) = self.storage_path.parent() {
            tokio::fs::create_dir_all(parent).await.ok();
        }

        tokio::fs::write(&self.storage_path, data)
            .await
            .map_err(|e| format!("Failed to write groups file: {}", e))?;

        Ok(())
    }

    /// Создать новую группу
    pub async fn create_group(&self, name: &str) -> PeerGroup {
        let group = PeerGroup::new(name);
        let id = group.id.clone();

        self.groups.write().await.insert(id, group.clone());

        // Сохраняем асинхронно
        let self_clone = Self {
            groups: self.groups.clone(),
            storage_path: self.storage_path.clone(),
        };
        tokio::spawn(async move {
            if let Err(e) = self_clone.save().await {
                log::error!("Failed to save groups: {}", e);
            }
        });

        group
    }

    /// Удалить группу
    pub async fn delete_group(&self, group_id: &str) -> Result<(), String> {
        let removed = self.groups.write().await.remove(group_id);

        if removed.is_some() {
            let self_clone = Self {
                groups: self.groups.clone(),
                storage_path: self.storage_path.clone(),
            };
            tokio::spawn(async move {
                if let Err(e) = self_clone.save().await {
                    log::error!("Failed to save groups: {}", e);
                }
            });
            Ok(())
        } else {
            Err("Group not found".to_string())
        }
    }

    /// Получить группу по ID
    pub async fn get_group(&self, group_id: &str) -> Option<PeerGroup> {
        self.groups.read().await.get(group_id).cloned()
    }

    /// Получить все группы
    pub async fn get_all_groups(&self) -> Vec<PeerGroup> {
        self.groups.read().await.values().cloned().collect()
    }

    /// Обновить группу
    pub async fn update_group(&self, group: PeerGroup) -> Result<(), String> {
        let mut guard = self.groups.write().await;

        if !guard.contains_key(&group.id) {
            return Err("Group not found".to_string());
        }

        guard.insert(group.id.clone(), group);
        drop(guard);

        let self_clone = Self {
            groups: self.groups.clone(),
            storage_path: self.storage_path.clone(),
        };
        tokio::spawn(async move {
            if let Err(e) = self_clone.save().await {
                log::error!("Failed to save groups: {}", e);
            }
        });

        Ok(())
    }

    /// Добавить пира в группу
    pub async fn add_peer_to_group(&self, group_id: &str, peer_id: &str) -> Result<(), String> {
        let mut guard = self.groups.write().await;

        if let Some(group) = guard.get_mut(group_id) {
            group.add_peer(peer_id);
            drop(guard);

            let self_clone = Self {
                groups: self.groups.clone(),
                storage_path: self.storage_path.clone(),
            };
            tokio::spawn(async move {
                if let Err(e) = self_clone.save().await {
                    log::error!("Failed to save groups: {}", e);
                }
            });

            Ok(())
        } else {
            Err("Group not found".to_string())
        }
    }

    /// Удалить пира из группы
    pub async fn remove_peer_from_group(
        &self,
        group_id: &str,
        peer_id: &str,
    ) -> Result<(), String> {
        let mut guard = self.groups.write().await;

        if let Some(group) = guard.get_mut(group_id) {
            group.remove_peer(peer_id);
            drop(guard);

            let self_clone = Self {
                groups: self.groups.clone(),
                storage_path: self.storage_path.clone(),
            };
            tokio::spawn(async move {
                if let Err(e) = self_clone.save().await {
                    log::error!("Failed to save groups: {}", e);
                }
            });

            Ok(())
        } else {
            Err("Group not found".to_string())
        }
    }

    /// Получить все группы, в которых состоит пир
    pub async fn get_groups_for_peer(&self, peer_id: &str) -> Vec<PeerGroup> {
        self.groups
            .read()
            .await
            .values()
            .filter(|g| g.contains(peer_id))
            .cloned()
            .collect()
    }

    /// Получить всех пиров из группы
    pub async fn get_peers_in_group(&self, group_id: &str) -> Option<Vec<String>> {
        self.groups
            .read()
            .await
            .get(group_id)
            .map(|g| g.peer_ids.iter().cloned().collect())
    }

    /// Переименовать группу
    pub async fn rename_group(&self, group_id: &str, new_name: &str) -> Result<(), String> {
        let mut guard = self.groups.write().await;

        if let Some(group) = guard.get_mut(group_id) {
            group.name = new_name.to_string();
            group.updated_at = chrono::Utc::now().to_rfc3339();
            drop(guard);

            let self_clone = Self {
                groups: self.groups.clone(),
                storage_path: self.storage_path.clone(),
            };
            tokio::spawn(async move {
                if let Err(e) = self_clone.save().await {
                    log::error!("Failed to save groups: {}", e);
                }
            });

            Ok(())
        } else {
            Err("Group not found".to_string())
        }
    }

    /// Установить цвет группы
    pub async fn set_group_color(
        &self,
        group_id: &str,
        color: Option<String>,
    ) -> Result<(), String> {
        let mut guard = self.groups.write().await;

        if let Some(group) = guard.get_mut(group_id) {
            group.color = color;
            group.updated_at = chrono::Utc::now().to_rfc3339();
            drop(guard);

            let self_clone = Self {
                groups: self.groups.clone(),
                storage_path: self.storage_path.clone(),
            };
            tokio::spawn(async move {
                if let Err(e) = self_clone.save().await {
                    log::error!("Failed to save groups: {}", e);
                }
            });

            Ok(())
        } else {
            Err("Group not found".to_string())
        }
    }

    /// Объединить несколько групп в одну
    pub async fn merge_groups(
        &self,
        group_ids: &[String],
        new_name: &str,
    ) -> Result<PeerGroup, String> {
        if group_ids.is_empty() {
            return Err("No groups to merge".to_string());
        }

        let guard = self.groups.read().await;

        // Собираем всех пиров из групп
        let mut all_peers = HashSet::new();
        for id in group_ids {
            if let Some(group) = guard.get(id) {
                all_peers.extend(group.peer_ids.iter().cloned());
            }
        }

        drop(guard);

        // Создаём новую группу
        let mut new_group = PeerGroup::new(new_name);
        new_group.peer_ids = all_peers;

        // Удаляем старые группы
        let mut guard = self.groups.write().await;
        for id in group_ids {
            guard.remove(id);
        }

        // Добавляем новую
        guard.insert(new_group.id.clone(), new_group.clone());
        drop(guard);

        // Сохраняем
        let self_clone = Self {
            groups: self.groups.clone(),
            storage_path: self.storage_path.clone(),
        };
        tokio::spawn(async move {
            if let Err(e) = self_clone.save().await {
                log::error!("Failed to save groups: {}", e);
            }
        });

        Ok(new_group)
    }

    /// Найти группы по имени (частичное совпадение)
    pub async fn search_groups(&self, query: &str) -> Vec<PeerGroup> {
        let query_lower = query.to_lowercase();
        self.groups
            .read()
            .await
            .values()
            .filter(|g| g.name.to_lowercase().contains(&query_lower))
            .cloned()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[tokio::test]
    async fn test_group_operations() {
        let manager = PeerGroupManager::new(PathBuf::from("/tmp"));

        // Создаём группу
        let group = manager.create_group("Test Group").await;
        assert_eq!(group.name, "Test Group");

        // Добавляем пиров
        manager.add_peer_to_group(&group.id, "peer1").await.unwrap();
        manager.add_peer_to_group(&group.id, "peer2").await.unwrap();

        let updated = manager.get_group(&group.id).await.unwrap();
        assert_eq!(updated.len(), 2);
        assert!(updated.contains("peer1"));
        assert!(updated.contains("peer2"));

        // Удаляем пира
        manager
            .remove_peer_from_group(&group.id, "peer1")
            .await
            .unwrap();
        let updated = manager.get_group(&group.id).await.unwrap();
        assert_eq!(updated.len(), 1);
        assert!(!updated.contains("peer1"));

        // Удаляем группу
        manager.delete_group(&group.id).await.unwrap();
        assert!(manager.get_group(&group.id).await.is_none());
    }

    #[tokio::test]
    async fn test_get_groups_for_peer() {
        let manager = PeerGroupManager::new(PathBuf::from("/tmp"));

        let group1 = manager.create_group("Group 1").await;
        let group2 = manager.create_group("Group 2").await;

        manager
            .add_peer_to_group(&group1.id, "peer1")
            .await
            .unwrap();
        manager
            .add_peer_to_group(&group2.id, "peer1")
            .await
            .unwrap();
        manager
            .add_peer_to_group(&group2.id, "peer2")
            .await
            .unwrap();

        let peer1_groups = manager.get_groups_for_peer("peer1").await;
        assert_eq!(peer1_groups.len(), 2);

        let peer2_groups = manager.get_groups_for_peer("peer2").await;
        assert_eq!(peer2_groups.len(), 1);
    }
}
