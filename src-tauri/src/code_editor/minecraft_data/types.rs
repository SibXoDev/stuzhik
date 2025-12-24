use serde::{Deserialize, Serialize};

/// Minecraft предмет (item)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MinecraftItem {
    /// Полный ID предмета (например, "minecraft:diamond")
    pub id: String,

    /// Отображаемое имя (например, "Diamond")
    pub name: String,

    /// ID мода, которому принадлежит предмет
    pub mod_id: String,

    /// Теги предмета (например, ["forge:gems", "forge:gems/diamond"])
    #[serde(default)]
    pub tags: Vec<String>,

    /// Путь к текстуре внутри .jar (для preview)
    pub texture_path: Option<String>,

    /// Максимальный размер стака
    #[serde(default = "default_stack_size")]
    pub stack_size: u32,

    /// Редкость (common, uncommon, rare, epic)
    #[serde(default = "default_rarity")]
    pub rarity: String,

    /// Описание предмета
    pub description: Option<String>,
}

fn default_stack_size() -> u32 {
    64
}

fn default_rarity() -> String {
    "common".to_string()
}

/// Minecraft блок
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MinecraftBlock {
    /// Полный ID блока
    pub id: String,

    /// Отображаемое имя
    pub name: String,

    /// ID мода
    pub mod_id: String,

    /// Теги блока
    #[serde(default)]
    pub tags: Vec<String>,

    /// Прочность блока
    pub hardness: Option<f32>,

    /// Взрывоустойчивость
    pub blast_resistance: Option<f32>,

    /// Может ли блок быть добыт без инструмента
    pub requires_tool: Option<bool>,
}

/// Minecraft тег (группа предметов/блоков)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MinecraftTag {
    /// ID тега (например, "forge:ingots/iron")
    pub id: String,

    /// Тип тега (item или block)
    pub tag_type: TagType,

    /// Значения, входящие в тег
    pub values: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TagType {
    Item,
    Block,
}

/// Информация о моде (для context в автодополнении)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModInfo {
    /// ID мода
    pub mod_id: String,

    /// Название мода
    pub name: String,

    /// Версия мода
    pub version: String,

    /// Loader (fabric, forge, neoforge, quilt)
    pub loader: String,

    /// Количество предметов в моде
    pub item_count: usize,

    /// Количество блоков в моде
    pub block_count: usize,
}

/// Результат парсинга .jar файла мода
#[derive(Debug, Clone, Default)]
pub struct ModData {
    pub mod_info: Option<ModInfo>,
    pub items: Vec<MinecraftItem>,
    pub blocks: Vec<MinecraftBlock>,
    pub tags: Vec<MinecraftTag>,
}

impl ModData {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty() && self.blocks.is_empty() && self.tags.is_empty()
    }
}
