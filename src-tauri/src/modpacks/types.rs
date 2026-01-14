use serde::{Deserialize, Serialize};

// ========== Типы для поиска модпаков ==========

#[derive(Debug, Serialize, Deserialize)]
pub struct ModpackSearchResult {
    pub slug: String,
    pub title: String,
    pub description: String,
    pub icon_url: Option<String>,
    pub downloads: u64,
    pub author: String,
    pub categories: Vec<String>,
    pub minecraft_versions: Vec<String>,
    pub loaders: Vec<String>,
    pub source: String,
    pub project_id: String,
}

#[derive(Debug, Serialize)]
pub struct ModpackSearchResponse {
    pub results: Vec<ModpackSearchResult>,
    pub total: u32,
    pub offset: u32,
    pub limit: u32,
}

// ========== Modrinth Modpack Types ==========

/// Modrinth Modpack Index (for both import and export)
#[derive(Debug, Serialize, Deserialize)]
pub struct ModrinthModpackIndex {
    #[serde(rename = "formatVersion")]
    pub format_version: u32,
    pub game: String,
    #[serde(rename = "versionId")]
    pub version_id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    pub files: Vec<ModrinthModpackFile>,
    pub dependencies: ModrinthModpackDependencies,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModrinthModpackFile {
    pub path: String,
    pub hashes: ModrinthModpackHashes,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<ModrinthModpackEnv>,
    pub downloads: Vec<String>,
    #[serde(rename = "fileSize")]
    pub file_size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModrinthModpackHashes {
    pub sha1: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha512: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModrinthModpackEnv {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ModrinthModpackDependencies {
    pub minecraft: String,
    #[serde(rename = "fabric-loader", skip_serializing_if = "Option::is_none")]
    pub fabric_loader: Option<String>,
    #[serde(rename = "quilt-loader", skip_serializing_if = "Option::is_none")]
    pub quilt_loader: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub forge: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub neoforge: Option<String>,
}

// ========== CurseForge Modpack Types ==========

#[derive(Debug, Deserialize)]
pub struct CurseForgeManifest {
    pub minecraft: CurseForgeMinecraft,
    #[serde(rename = "manifestType")]
    pub manifest_type: String,
    #[serde(rename = "manifestVersion")]
    pub manifest_version: u32,
    pub name: String,
    pub version: String,
    pub author: Option<String>,
    pub files: Vec<CurseForgeManifestFile>,
    pub overrides: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CurseForgeMinecraft {
    pub version: String,
    #[serde(rename = "modLoaders")]
    pub mod_loaders: Vec<CurseForgeModLoader>,
}

#[derive(Debug, Deserialize)]
pub struct CurseForgeModLoader {
    pub id: String,
    pub primary: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CurseForgeManifestFile {
    #[serde(rename = "projectID")]
    pub project_id: u64,
    #[serde(rename = "fileID")]
    pub file_id: u64,
    pub required: bool,
}

// ========== Modrinth Search Response ==========

#[derive(Debug, Deserialize)]
pub(super) struct ModrinthSearchResponse {
    pub hits: Vec<ModrinthSearchHit>,
    pub offset: u32,
    pub limit: u32,
    pub total_hits: u32,
}

#[derive(Debug, Deserialize)]
pub(super) struct ModrinthSearchHit {
    pub slug: String,
    pub project_id: String,
    pub title: String,
    pub description: String,
    pub categories: Vec<String>,
    pub downloads: u64,
    pub icon_url: Option<String>,
    pub author: String,
    pub versions: Vec<String>,
    pub loaders: Option<Vec<String>>,
}

// ========== Прогресс установки ==========

#[derive(Debug, Clone, Serialize)]
pub struct ModpackInstallProgress {
    pub stage: String,
    pub current: u32,
    pub total: u32,
    pub current_file: Option<String>,
}

/// Итоги установки модпака
#[derive(Debug, Clone, Serialize)]
pub struct ModpackInstallSummary {
    pub total_mods: u32,
    pub from_curseforge: Vec<String>,
    pub from_modrinth: Vec<String>,
    pub failed: Vec<String>,
}

/// Источник скачивания мода
#[derive(Debug, Clone)]
pub(super) enum DownloadSource {
    CurseForge,
    Modrinth,
    Failed,
}

// ========== Детали модпака ==========

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModpackGalleryImage {
    pub url: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub featured: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModpackDetails {
    pub body: String,
    pub license: Option<String>,
    pub source_url: Option<String>,
    pub issues_url: Option<String>,
    pub wiki_url: Option<String>,
    pub discord_url: Option<String>,
    pub followers: Option<u64>,
    pub date_created: Option<String>,
    pub date_modified: Option<String>,
    pub gallery: Vec<ModpackGalleryImage>,
}

/// Предпросмотр модпака из файла
#[derive(Debug, Clone, Serialize)]
pub struct ModpackFilePreview {
    pub name: String,
    pub version: String,
    pub minecraft_version: String,
    pub loader: String,
    pub loader_version: Option<String>,
    pub mod_count: usize,
    pub overrides_mods_count: usize,
    pub format: String, // "modrinth", "curseforge" or "stzhk"
    pub summary: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ModpackVersionInfo {
    pub id: String,
    pub name: String,
    pub version_number: String,
    pub game_versions: Vec<String>,
    pub loaders: Vec<String>,
    pub downloads: u64,
    pub download_url: String,
    pub file_size: u64,
}

// ========== Modpack Comparison ==========

/// Информация о моде для сравнения
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModInfo {
    pub filename: String,
    pub name: String,
    pub version: Option<String>,
    pub size: u64,
    /// SHA1 hash файла мода (для точного сравнения)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
}

/// Информация о конфиг-файле
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigInfo {
    pub path: String,
    pub size: u64,
    pub hash: String,
}

/// Результат сравнения модпаков
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModpackComparison {
    /// Моды только в первом модпаке
    pub mods_only_in_first: Vec<ModInfo>,
    /// Моды только во втором модпаке
    pub mods_only_in_second: Vec<ModInfo>,
    /// Моды в обоих, но с разными версиями
    pub mods_different_version: Vec<ModVersionDiff>,
    /// Моды идентичные в обоих модпаках
    pub mods_identical: Vec<ModInfo>,

    /// Конфиги только в первом
    pub configs_only_in_first: Vec<ConfigInfo>,
    /// Конфиги только во втором
    pub configs_only_in_second: Vec<ConfigInfo>,
    /// Конфиги с разным содержимым
    pub configs_different: Vec<ConfigDiff>,

    /// Другие файлы (resourcepacks, shaderpacks, scripts)
    pub other_only_in_first: Vec<String>,
    pub other_only_in_second: Vec<String>,

    /// Общая статистика
    pub total_mods_first: u32,
    pub total_mods_second: u32,
    pub total_configs_first: u32,
    pub total_configs_second: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModVersionDiff {
    pub name: String,
    pub first_filename: String,
    pub second_filename: String,
    pub first_version: Option<String>,
    pub second_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigDiff {
    pub path: String,
    pub first_size: u64,
    pub second_size: u64,
}

/// Информация о найденном моде для скачивания
#[derive(Debug, Clone, Serialize)]
pub struct ModSearchInfo {
    pub project_id: String,
    pub slug: String,
    pub name: String,
    pub version: Option<String>,
    pub version_id: Option<String>,
    pub download_url: Option<String>,
    pub file_name: Option<String>,
    pub file_size: u64,
    pub source: String,
    pub icon_url: Option<String>,
}

// ========== Modpack Patch System ==========

/// Версия формата STZHK файлов (модпаки и патчи)
pub const STZHK_FORMAT_VERSION: &str = "1.0";

/// Патч-файл для модпака (.stzhk с type: "patch")
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModpackPatch {
    /// Тип файла (всегда "patch" для патчей)
    #[serde(default = "default_patch_type")]
    pub file_type: String,
    /// Версия формата патча
    pub format_version: String,
    /// Информация о базовом модпаке
    pub base_modpack: PatchBaseInfo,
    /// Дата создания патча
    pub created_at: String,
    /// Описание патча (что изменено)
    pub description: String,
    /// Автор патча
    pub author: Option<String>,
    /// Изменения
    pub changes: PatchChanges,
}

/// Информация о базовом модпаке
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatchBaseInfo {
    /// Название базового модпака
    pub name: String,
    /// Версия Minecraft
    pub minecraft_version: String,
    /// Загрузчик (fabric, forge, etc.)
    pub loader: String,
    /// Версия загрузчика
    pub loader_version: Option<String>,
    /// Источник модпака (modrinth, curseforge, local)
    pub source: Option<String>,
    /// ID проекта (для Modrinth/CurseForge)
    pub project_id: Option<String>,
    /// ID версии (для Modrinth/CurseForge)
    pub version_id: Option<String>,
}

/// Изменения в патче
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatchChanges {
    /// Моды для добавления
    pub mods_to_add: Vec<PatchModAdd>,
    /// Моды для удаления
    pub mods_to_remove: Vec<PatchModRemove>,
    /// Конфиги для добавления/замены
    pub configs_to_add: Vec<PatchConfigAdd>,
    /// Конфиги для удаления
    pub configs_to_remove: Vec<String>,
    /// Другие файлы для добавления (resourcepacks, shaderpacks, scripts)
    pub files_to_add: Vec<PatchFileAdd>,
    /// Файлы для удаления
    pub files_to_remove: Vec<String>,
}

/// Мод для добавления
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatchModAdd {
    /// Название мода (для отображения)
    pub name: String,
    /// Slug мода
    pub slug: String,
    /// Источник (modrinth, curseforge)
    pub source: String,
    /// ID проекта
    pub project_id: String,
    /// ID конкретной версии (если нужна конкретная версия)
    pub version_id: Option<String>,
    /// Имя файла (fallback если API недоступен)
    pub filename: Option<String>,
}

/// Мод для удаления
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatchModRemove {
    /// Название мода
    pub name: String,
    /// Паттерн имени файла (для fuzzy matching)
    pub filename_pattern: String,
}

/// Конфиг для добавления/замены
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatchConfigAdd {
    /// Путь к файлу относительно корня экземпляра
    pub path: String,
    /// Содержимое файла в base64
    pub content_base64: String,
}

/// Файл для добавления
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatchFileAdd {
    /// Путь к файлу
    pub path: String,
    /// Содержимое в base64 (для небольших файлов)
    pub content_base64: Option<String>,
    /// URL для скачивания (для больших файлов)
    pub download_url: Option<String>,
}

/// Результат предпросмотра применения патча
#[derive(Debug, Clone, Serialize)]
pub struct PatchPreview {
    /// Моды которые будут добавлены
    pub mods_to_add: Vec<String>,
    /// Моды которые будут удалены
    pub mods_to_remove: Vec<String>,
    /// Конфиги которые будут добавлены/изменены
    pub configs_to_change: Vec<String>,
    /// Конфиги которые будут удалены
    pub configs_to_remove: Vec<String>,
    /// Файлы которые будут добавлены
    pub files_to_add: Vec<String>,
    /// Файлы которые будут удалены
    pub files_to_remove: Vec<String>,
    /// Предупреждения (например, мод уже установлен)
    pub warnings: Vec<String>,
    /// Ошибки (например, мод для удаления не найден)
    pub errors: Vec<String>,
}

/// Результат применения патча
#[derive(Debug, Clone, Serialize)]
pub struct PatchApplyResult {
    pub success: bool,
    /// Моды успешно добавлены
    pub mods_added: Vec<String>,
    /// Моды успешно удалены
    pub mods_removed: Vec<String>,
    /// Конфиги изменены
    pub configs_changed: Vec<String>,
    /// Файлы добавлены
    pub files_added: Vec<String>,
    /// Ошибки при применении
    pub errors: Vec<String>,
}

/// Default value for file_type field in ModpackPatch
fn default_patch_type() -> String {
    "patch".to_string()
}

// ========== Patch Compatibility System ==========

/// Статус совместимости патча
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PatchCompatibilityStatus {
    /// Патч полностью совместим
    Compatible,
    /// Патч совместим, но есть предупреждения
    CompatibleWithWarnings,
    /// Патч несовместим
    Incompatible,
    /// Патч уже был применён
    AlreadyApplied,
}

/// Результат проверки совместимости патча
#[derive(Debug, Clone, Serialize)]
pub struct PatchCompatibilityResult {
    /// Общий статус совместимости
    pub status: PatchCompatibilityStatus,
    /// Совместима ли версия Minecraft
    pub minecraft_version_match: bool,
    /// Совместим ли загрузчик
    pub loader_match: bool,
    /// Совместима ли версия загрузчика
    pub loader_version_match: bool,
    /// Совпадает ли базовый модпак (по project_id/version_id)
    pub base_modpack_match: Option<bool>,
    /// Был ли патч уже применён
    pub already_applied: bool,
    /// Предупреждения
    pub warnings: Vec<String>,
    /// Ошибки (почему несовместим)
    pub errors: Vec<String>,
    /// Рекомендация пользователю
    pub recommendation: Option<String>,
}

/// Запись о применённом патче (хранится в метаданных экземпляра)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppliedPatchRecord {
    /// Уникальный хеш патча (SHA256 от содержимого)
    pub patch_hash: String,
    /// Описание патча
    pub description: String,
    /// Дата применения
    pub applied_at: String,
    /// Базовый модпак для которого был создан патч
    pub base_modpack_name: String,
}

// ========== Instance Snapshot for Auto-Patch Creation ==========

/// Снимок состояния экземпляра для отслеживания изменений
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstanceSnapshot {
    /// ID экземпляра
    pub instance_id: String,
    /// Название экземпляра
    pub instance_name: String,
    /// Версия Minecraft
    pub minecraft_version: String,
    /// Загрузчик
    pub loader: String,
    /// Версия загрузчика
    pub loader_version: Option<String>,
    /// Дата создания снимка
    pub created_at: String,
    /// Список модов (filename + hash)
    pub mods: Vec<SnapshotModInfo>,
    /// Список конфигов (path + hash)
    pub configs: Vec<SnapshotConfigInfo>,
}

/// Информация о моде в снимке
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotModInfo {
    pub filename: String,
    pub hash: String,
    pub size: u64,
}

/// Информация о конфиге в снимке
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotConfigInfo {
    pub path: String,
    pub hash: String,
    pub size: u64,
}

/// Обнаруженные изменения в экземпляре
#[derive(Debug, Clone, Serialize)]
pub struct InstanceChanges {
    /// Добавленные моды
    pub mods_added: Vec<String>,
    /// Удалённые моды
    pub mods_removed: Vec<String>,
    /// Изменённые конфиги
    pub configs_changed: Vec<String>,
    /// Добавленные конфиги
    pub configs_added: Vec<String>,
    /// Удалённые конфиги
    pub configs_removed: Vec<String>,
    /// Есть ли изменения
    pub has_changes: bool,
}

// ========== Preview модпака перед импортом ==========

/// Формат модпака
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ModpackFormat {
    Modrinth,   // .mrpack
    CurseForge, // .zip с manifest.json
    Stzhk,      // .stzhk
    Unknown,
}

/// Категория файла в модпаке
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ImportFileCategory {
    Mod,
    Config,
    ResourcePack,
    ShaderPack,
    Script,
    World,
    Other,
}

/// Информация о моде в preview
#[derive(Debug, Clone, Serialize)]
pub struct ImportModInfo {
    /// Путь в архиве
    pub path: String,
    /// Имя файла
    pub filename: String,
    /// Название мода (если известно)
    pub name: Option<String>,
    /// Размер файла
    pub size: u64,
    /// URL для скачивания (если есть)
    pub download_url: Option<String>,
    /// Требуется для клиента/сервера
    pub side: Option<String>,
    /// Включён по умолчанию
    pub enabled: bool,
}

/// Информация о override файле в preview
#[derive(Debug, Clone, Serialize)]
pub struct ImportOverrideInfo {
    /// Путь в архиве
    pub archive_path: String,
    /// Относительный путь назначения
    pub dest_path: String,
    /// Размер файла
    pub size: u64,
    /// Категория файла
    pub category: ImportFileCategory,
    /// Включён по умолчанию
    pub enabled: bool,
}

/// Полный preview модпака
#[derive(Debug, Clone, Serialize)]
pub struct ModpackPreview {
    /// Формат модпака
    pub format: ModpackFormat,
    /// Название модпака
    pub name: String,
    /// Версия модпака
    pub version: Option<String>,
    /// Автор
    pub author: Option<String>,
    /// Описание
    pub description: Option<String>,
    /// Версия Minecraft
    pub minecraft_version: String,
    /// Загрузчик (fabric, forge, etc.)
    pub loader: Option<String>,
    /// Версия загрузчика
    pub loader_version: Option<String>,
    /// Список модов
    pub mods: Vec<ImportModInfo>,
    /// Список override файлов
    pub overrides: Vec<ImportOverrideInfo>,
    /// Общий размер модов (байт)
    pub mods_size: u64,
    /// Общий размер overrides (байт)
    pub overrides_size: u64,
    /// Общий размер архива (байт)
    pub archive_size: u64,
}

/// Опции импорта (что включить/исключить)
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOptions {
    /// Название экземпляра
    pub instance_name: String,
    /// Исключённые моды (по path)
    #[serde(default)]
    pub excluded_mods: Vec<String>,
    /// Исключённые override файлы (по archive_path)
    #[serde(default)]
    pub excluded_overrides: Vec<String>,
}
