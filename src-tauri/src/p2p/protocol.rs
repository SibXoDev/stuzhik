//! Протокол обмена сообщениями Stuzhik Connect
//!
//! Использует MessagePack для компактной сериализации.

use serde::{Deserialize, Serialize};

/// Версия протокола для совместимости
pub const PROTOCOL_VERSION: u8 = 1;

/// Магический байт для идентификации пакетов Stuzhik
pub const MAGIC_BYTES: [u8; 4] = [0x53, 0x54, 0x5A, 0x48]; // "STZH"

/// Информация о пире (другом пользователе)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerInfo {
    /// Уникальный ID пира
    pub id: String,
    /// Никнейм
    pub nickname: Option<String>,
    /// IP адрес
    pub address: String,
    /// Порт
    pub port: u16,
    /// Версия приложения
    pub app_version: String,
    /// Последний раз когда видели онлайн
    pub last_seen: String,
    /// Статус
    pub status: PeerStatus,
    /// Список модпаков (если разрешено показывать)
    pub modpacks: Option<Vec<ModpackPreview>>,
    /// На каком сервере играет (если разрешено показывать)
    pub current_server: Option<String>,
}

/// Статус пира
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PeerStatus {
    /// В меню лаунчера
    Online,
    /// Играет
    InGame,
    /// Не отвечает
    Away,
}

/// Краткая информация о модпаке для отображения
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModpackPreview {
    /// Название модпака
    pub name: String,
    /// Версия Minecraft
    pub minecraft_version: String,
    /// Загрузчик (Fabric, Forge, etc.)
    pub loader: String,
    /// Количество модов
    pub mod_count: u32,
    /// Хэш для проверки идентичности
    pub hash: String,
}

/// Типы сообщений протокола
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Message {
    /// Broadcast для обнаружения пиров
    Discovery(DiscoveryMessage),

    /// Ответ на discovery
    DiscoveryResponse(DiscoveryResponseMessage),

    /// Запрос информации о пире
    PeerInfoRequest { peer_id: String },

    /// Ответ с информацией о пире
    PeerInfoResponse(PeerInfo),

    /// Запрос на скачивание модпака
    ModpackRequest {
        modpack_hash: String,
        requester_id: String,
        requester_nickname: Option<String>,
    },

    /// Ответ на запрос модпака
    ModpackResponse(ModpackResponseData),

    /// Пинг для проверки связи
    Ping { timestamp: u64 },

    /// Ответ на пинг
    Pong { timestamp: u64, peer_id: String },

    /// Запрос подключения по короткому коду
    ConnectByCode {
        /// Короткий код (4 символа)
        code: String,
        /// ID запрашивающего
        requester_id: String,
        /// Никнейм запрашивающего
        requester_nickname: Option<String>,
    },

    /// Ответ на запрос подключения по коду
    ConnectByCodeResponse {
        /// Короткий код
        code: String,
        /// Успешно ли
        success: bool,
        /// Информация о пире (если успешно)
        peer_info: Option<PeerInfo>,
        /// Причина ошибки (если неуспешно)
        error: Option<String>,
    },
}

/// Сообщение discovery (broadcast)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveryMessage {
    /// ID отправителя
    pub sender_id: String,
    /// Версия протокола
    pub protocol_version: u8,
    /// Версия приложения
    pub app_version: String,
    /// Порт для прямого подключения
    pub listen_port: u16,
}

/// Ответ на discovery
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveryResponseMessage {
    /// ID отвечающего
    pub peer_id: String,
    /// Никнейм (если разрешено показывать)
    pub nickname: Option<String>,
    /// Версия приложения
    pub app_version: String,
    /// Статус
    pub status: PeerStatus,
    /// Порт для прямого подключения
    pub listen_port: u16,
}

/// Данные ответа на запрос модпака
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ModpackResponseData {
    /// Запрос одобрен, начинаем передачу
    Approved {
        modpack_hash: String,
        total_size: u64,
        file_count: u32,
    },
    /// Запрос отклонён
    Denied { reason: String },
    /// Ожидает подтверждения пользователя
    Pending,
}

/// Сериализация сообщения в байты (MessagePack)
pub fn serialize_message(msg: &Message) -> Result<Vec<u8>, String> {
    let mut buffer = Vec::with_capacity(512);

    // Magic bytes
    buffer.extend_from_slice(&MAGIC_BYTES);

    // Protocol version
    buffer.push(PROTOCOL_VERSION);

    // MessagePack payload
    let payload =
        rmp_serde::to_vec(msg).map_err(|e| format!("Failed to serialize message: {}", e))?;

    // Payload length (2 bytes, big endian)
    let len = payload.len() as u16;
    buffer.extend_from_slice(&len.to_be_bytes());

    // Payload
    buffer.extend_from_slice(&payload);

    Ok(buffer)
}

/// Десериализация сообщения из байтов
pub fn deserialize_message(data: &[u8]) -> Result<Message, String> {
    // Минимальный размер: 4 (magic) + 1 (version) + 2 (length) = 7 байт
    if data.len() < 7 {
        return Err("Message too short".to_string());
    }

    // Проверяем magic bytes
    if &data[0..4] != MAGIC_BYTES {
        return Err("Invalid magic bytes".to_string());
    }

    // Проверяем версию протокола
    let version = data[4];
    if version != PROTOCOL_VERSION {
        return Err(format!(
            "Unsupported protocol version: {} (expected {})",
            version, PROTOCOL_VERSION
        ));
    }

    // Читаем длину payload
    let len = u16::from_be_bytes([data[5], data[6]]) as usize;

    // Проверяем что данных достаточно
    if data.len() < 7 + len {
        return Err("Incomplete message".to_string());
    }

    // Десериализуем payload
    let payload = &data[7..7 + len];
    rmp_serde::from_slice(payload).map_err(|e| format!("Failed to deserialize message: {}", e))
}

/// Генерация уникального ID пира
pub fn generate_peer_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Генерация короткого кода для подключения (STUZHIK-XXXX)
pub fn generate_short_code() -> String {
    use rand::Rng;
    const CHARS: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // Без похожих символов (0/O, 1/I/L)
    let mut rng = rand::rng();
    let code: String = (0..4)
        .map(|_| {
            let idx = rng.random_range(0..CHARS.len());
            CHARS[idx] as char
        })
        .collect();
    format!("STUZHIK-{}", code)
}

/// Проверка формата короткого кода
pub fn validate_short_code(code: &str) -> bool {
    let code = code.trim().to_uppercase();
    if let Some(suffix) = code.strip_prefix("STUZHIK-") {
        suffix.len() == 4 && suffix.chars().all(|c| c.is_ascii_alphanumeric())
    } else {
        // Также принимаем просто 4 символа
        code.len() == 4 && code.chars().all(|c| c.is_ascii_alphanumeric())
    }
}

/// Нормализация короткого кода (добавляет префикс если нужно)
pub fn normalize_short_code(code: &str) -> String {
    let code = code.trim().to_uppercase();
    if code.starts_with("STUZHIK-") {
        code
    } else {
        format!("STUZHIK-{}", code)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_serialize_deserialize() {
        let msg = Message::Ping {
            timestamp: 1234567890,
        };

        let bytes = serialize_message(&msg).unwrap();
        let decoded = deserialize_message(&bytes).unwrap();

        match decoded {
            Message::Ping { timestamp } => assert_eq!(timestamp, 1234567890),
            _ => panic!("Wrong message type"),
        }
    }
}
