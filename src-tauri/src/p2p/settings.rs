//! Настройки приватности Stuzhik Connect
//!
//! ПО УМОЛЧАНИЮ ВСЁ ВЫКЛЮЧЕНО для безопасности.
//! Полный контроль над отправкой и получением.

use serde::{Deserialize, Serialize};

/// Загрузить настройки P2P Connect из базы данных
pub fn load_connect_settings() -> ConnectSettings {
    let conn = match crate::db::get_db_conn() {
        Ok(c) => c,
        Err(_) => return ConnectSettings::default(),
    };

    conn.query_row(
        "SELECT value FROM settings WHERE key = 'connect_settings'",
        [],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .and_then(|json| serde_json::from_str(&json).ok())
    .unwrap_or_default()
}

/// Уровень видимости пользователя в сети
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Visibility {
    /// Полностью невидим - не отвечает на broadcast
    Invisible,
    /// Виден только добавленным друзьям
    FriendsOnly,
    /// Виден всем в локальной сети
    LocalNetwork,
}

impl Default for Visibility {
    fn default() -> Self {
        Self::Invisible // По умолчанию невидим
    }
}

/// Разрешение на действие
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Permission {
    /// Запрещено
    Deny,
    /// Только друзьям
    FriendsOnly,
    /// Спрашивать каждый раз (умный режим - по модпакам, не по файлам)
    Ask,
    /// Разрешено всем в сети
    Allow,
}

impl Default for Permission {
    fn default() -> Self {
        Self::Ask // По умолчанию спрашиваем
    }
}

/// Настройки отправки (что другие могут получить от меня)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendSettings {
    /// Разрешить отправлять мои модпаки
    pub modpacks: Permission,
    /// Разрешить отправлять конфиги
    pub configs: Permission,
    /// Разрешить отправлять ресурспаки
    pub resourcepacks: Permission,
    /// Разрешить отправлять шейдеры
    pub shaderpacks: Permission,
}

impl Default for SendSettings {
    fn default() -> Self {
        Self {
            modpacks: Permission::Ask,
            configs: Permission::Ask,
            resourcepacks: Permission::Ask,
            shaderpacks: Permission::Ask,
        }
    }
}

/// Настройки получения (что я могу получить от других)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReceiveSettings {
    /// Разрешить получать модпаки
    pub modpacks: Permission,
    /// Разрешить получать конфиги
    pub configs: Permission,
    /// Разрешить получать ресурспаки
    pub resourcepacks: Permission,
    /// Разрешить получать шейдеры
    pub shaderpacks: Permission,
    /// Автоматически проверять хэши файлов
    pub verify_hashes: bool,
}

impl Default for ReceiveSettings {
    fn default() -> Self {
        Self {
            modpacks: Permission::Ask,
            configs: Permission::Ask,
            resourcepacks: Permission::Ask,
            shaderpacks: Permission::Ask,
            verify_hashes: true, // Всегда проверяем
        }
    }
}

/// Главные настройки Stuzhik Connect
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectSettings {
    /// Включён ли P2P вообще (по умолчанию false)
    pub enabled: bool,

    /// Никнейм пользователя для отображения
    pub nickname: String,

    /// Уровень видимости
    pub visibility: Visibility,

    /// Показывать свой никнейм
    pub show_nickname: bool,

    /// Показывать список модпаков (названия)
    pub show_modpacks: bool,

    /// Показывать на каком сервере играю
    pub show_current_server: bool,

    /// Настройки отправки
    pub send: SendSettings,

    /// Настройки получения
    pub receive: ReceiveSettings,

    /// UDP порт для discovery (по умолчанию 19847)
    pub discovery_port: u16,

    /// Список заблокированных пиров (по ID)
    pub blocked_peers: Vec<String>,

    /// Список доверенных друзей
    pub trusted_friends: Vec<TrustedFriend>,

    /// Запомненные разрешения для конкретных пиров
    pub remembered_permissions: Vec<RememberedPermission>,
}

impl Default for ConnectSettings {
    fn default() -> Self {
        Self {
            enabled: false, // ПО УМОЛЧАНИЮ ВЫКЛЮЧЕНО!
            nickname: String::new(),
            visibility: Visibility::default(),
            show_nickname: true,
            show_modpacks: false,
            show_current_server: false,
            send: SendSettings::default(),
            receive: ReceiveSettings::default(),
            discovery_port: 19847,
            blocked_peers: Vec::new(),
            trusted_friends: Vec::new(),
            remembered_permissions: Vec::new(),
        }
    }
}

/// Доверенный друг
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustedFriend {
    /// Уникальный ID друга
    pub id: String,
    /// Никнейм (для отображения)
    pub nickname: String,
    /// Публичный ключ для верификации
    pub public_key: String,
    /// Дата добавления
    pub added_at: String,
    /// Заметка о друге
    pub note: Option<String>,
}

/// Запомненное разрешение для конкретного пира
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RememberedPermission {
    /// ID пира
    pub peer_id: String,
    /// Тип контента (modpack, config, etc.)
    pub content_type: String,
    /// Разрешено или нет
    pub allowed: bool,
    /// Дата создания
    pub created_at: String,
}

/// Рекомендуемые VPN приложения для P2P через интернет
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VpnRecommendation {
    pub name: String,
    pub url: String,
    pub description: String,
    pub difficulty: String,
}

impl VpnRecommendation {
    /// Список рекомендуемых VPN для игры с друзьями
    pub fn recommendations() -> Vec<Self> {
        vec![
            Self {
                name: "Radmin VPN".to_string(),
                url: "https://www.radmin-vpn.com/".to_string(),
                description: "Простой в использовании, быстрая настройка".to_string(),
                difficulty: "easy".to_string(),
            },
            Self {
                name: "ZeroTier".to_string(),
                url: "https://www.zerotier.com/".to_string(),
                description: "Надёжный, работает через NAT".to_string(),
                difficulty: "medium".to_string(),
            },
            Self {
                name: "Tailscale".to_string(),
                url: "https://tailscale.com/".to_string(),
                description: "Современный, для продвинутых пользователей".to_string(),
                difficulty: "advanced".to_string(),
            },
            Self {
                name: "Hamachi".to_string(),
                url: "https://vpn.net/".to_string(),
                description: "Классический вариант, ограничение 5 пользователей".to_string(),
                difficulty: "easy".to_string(),
            },
        ]
    }
}
