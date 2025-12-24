export type LoaderType = "vanilla" | "forge" | "neoforge" | "fabric" | "quilt";
export type InstanceType = "client" | "server";
export type InstanceStatus = "stopped" | "starting" | "running" | "stopping" | "error" | "installing" | "crashed";
export type ModSource = "modrinth" | "curseforge" | "local";
export type DependencyType = "required" | "optional" | "incompatible";
export type LaunchBehavior = "minimize_to_tray" | "keep_open" | "close";

export interface Instance {
  id: string;
  name: string;
  version: string;
  loader: LoaderType;
  loader_version?: string | null;
  instance_type: InstanceType;

  // Java & Launch
  java_version?: string | null;
  java_path?: string | null;
  memory_min: number;
  memory_max: number;
  java_args?: string | null;
  game_args?: string | null;

  // Paths
  dir: string;

  // Server specific
  port?: number | null;
  rcon_enabled: boolean;
  rcon_port?: number | null;
  rcon_password?: string | null;

  // Client specific
  username?: string | null;

  // Status
  status: InstanceStatus;
  auto_restart: boolean;
  last_played?: string | null;
  total_playtime: number;
  notes?: string | null;

  // Installation status (for error recovery)
  installation_step?: string | null;
  installation_error?: string | null;

  // Backup override (null = использовать глобальную настройку)
  backup_enabled?: boolean | null;

  created_at: string;
  updated_at: string;
}

// Partial instance for updates (excludes immutable fields)
export type InstanceUpdate = Partial<Omit<Instance, 'id' | 'dir' | 'created_at' | 'updated_at' | 'status'>>;

export interface Mod {
  id: number;
  instance_id: string;

  slug: string;
  name: string;
  version: string;
  minecraft_version: string;

  source: ModSource;
  source_id?: string | null;
  project_url?: string | null;
  download_url?: string | null;

  file_name: string;
  file_hash?: string | null;
  file_size?: number | null;

  enabled: boolean;
  auto_update: boolean;

  description?: string | null;
  author?: string | null;
  icon_url?: string | null;
  categories?: string[] | null;

  installed_at: string;
  updated_at: string;
}

export interface ModDependency {
  id: number;
  mod_id: number;
  dependency_slug: string;
  dependency_type: DependencyType;
  version_requirement?: string | null;
}

export interface JavaInstallation {
  id: number;
  version: string;
  path: string;
  vendor?: string | null;
  architecture?: string | null;
  is_auto_installed: boolean;
  installed_at: string;
}

/** Информация о найденной системной Java */
export interface SystemJavaInfo {
  path: string;
  version: string;
  major_version: number;
  vendor?: string | null;
  is_already_added: boolean;
}

/** Информация об установленной Java для UI */
export interface JavaInstallationInfo {
  path: string;
  vendor?: string | null;
  is_auto_installed: boolean;
  is_active: boolean;
}

/** Результат проверки совместимости Java */
export type JavaCompatibility =
  | { status: "Compatible" }
  | { status: "Warning"; message: string }
  | { status: "Incompatible"; message: string };

export interface MinecraftVersion {
  id: string;
  type: string;
  release_time: string;
  url: string;
  java_version: number;
}

export interface LoaderVersion {
  id: number;
  loader: LoaderType;
  minecraft_version: string;
  loader_version: string;
  stable: boolean;
  url?: string | null;
}

export interface Settings {
  default_username: string | null;
  default_memory_min: number;
  default_memory_max: number;
  default_java_args: string | null;
  default_game_args: string | null;
  java_auto_install: boolean;
  launch_behavior: LaunchBehavior;
  auto_update_mods: boolean;
  download_threads: number;
  max_concurrent_downloads: number;
  /** Bandwidth limit in bytes/sec, 0 = unlimited */
  bandwidth_limit: number;
  auth_type: string; // "offline" | "ely_by" | "microsoft"
  ely_by_server_url: string | null;
  // NOTE: ely_by_client_token is stored in secure OS keychain
  // Use store_auth_token / get_auth_token commands instead
  language: 'ru' | 'en';
  selected_gpu: string | null;
  // Backup settings
  backup_enabled: boolean;
  backup_max_count: number;
  backup_include_saves: boolean;
}

// Secure storage migration result
export interface SecretMigrationResult {
  ely_by_token_migrated: boolean;
  rcon_passwords_migrated: number;
}

// GPU types
export type GpuType = "discrete" | "integrated" | "unknown";

export interface GpuDevice {
  id: string;
  name: string;
  vendor: string;
  gpu_type: GpuType;
  recommended: boolean;
}

export interface GpuDetectionResult {
  devices: GpuDevice[];
  recommended_id: string | null;
  has_multiple_gpus: boolean;
  platform: string;
}

export interface CreateInstanceRequest {
  name: string;
  version: string;
  loader: LoaderType;
  loader_version?: string;
  instance_type: InstanceType;

  memory_min?: number;
  memory_max?: number;
  java_args?: string;
  game_args?: string;

  port?: number;
  username?: string;
  notes?: string;
}

export interface InstallModRequest {
  instance_id: string;
  slug: string;
  source: ModSource;
  version?: string;
}

export interface DownloadProgress {
  id: string;
  name: string;
  downloaded: number;
  total: number;
  speed: number;
  percentage: number;
  status: string;
  operation_id: string | null;
  /** Instance ID for grouping (optional) */
  instance_id?: string;
}

export interface ModSearchResult {
  slug: string;
  name: string;
  description: string;
  author: string;
  icon_url?: string;
  downloads: number;
  follows: number;
  categories: string[];
  versions: string[];
  latest_version: string;
  source: ModSource;
  // CurseForge compatibility (alternative property names)
  id?: number;
  title?: string;
  summary?: string;
  logo?: { url: string };
  // Search flags
  _exact_match?: boolean;
}

export interface ModSearchParams extends Record<string, unknown> {
  query: string;
  minecraftVersion: string;
  loader: string;
  source: ModSource;
  limit: number;
  offset: number;
  searchMode: string;
  index?: string;
}

export interface ModSearchResponse {
  hits: ModSearchResult[];
  offset: number;
  limit: number;
  total_hits: number;
}

export interface ModConflict {
  mod_slug: string;
  mod_name: string;
  conflict_type: "missing_dependency" | "incompatible" | "version_mismatch";
  details: string;
  required_slug?: string;
  required_version?: string;
}

// ========== Conflict Predictor ==========

export type ConflictSeverity = "info" | "warning" | "error" | "critical";

export type ConflictCategory =
  | "incompatible"
  | "duplicate"
  | "loader_mismatch"
  | "version_conflict"
  | "missing_dependency"
  | "mixin_conflict"
  | "known_issue";

export type RecommendedAction =
  | { type: "dont_install" }
  | { type: "remove_conflicting"; mod_slug: string }
  | { type: "choose_one"; alternatives: string[] }
  | { type: "update_mod"; mod_slug: string; min_version: string }
  | { type: "install_dependency"; mod_slug: string }
  | { type: "ignore" };

export interface PredictedConflict {
  mod_to_install: string;
  conflicting_mod?: string;
  severity: ConflictSeverity;
  category: ConflictCategory;
  title: string;
  description: string;
  recommended_action: RecommendedAction;
  reference_url?: string;
}

export interface ConflictPredictionResult {
  safe_to_install: boolean;
  conflicts: PredictedConflict[];
  summary: string;
}

// ========== Modpacks ==========

export interface ModpackSearchResult {
  slug: string;
  title: string;
  description: string;
  icon_url?: string;
  downloads: number;
  author: string;
  categories: string[];
  minecraft_versions: string[];
  loaders: string[];
  source: "modrinth" | "curseforge";
  project_id: string;
}

export interface ModpackSearchResponse {
  results: ModpackSearchResult[];
  total: number;
  offset: number;
  limit: number;
}

export interface ModpackVersionInfo {
  id: string;
  name: string;
  version_number: string;
  game_versions: string[];
  loaders: string[];
  downloads: number;
  download_url: string;
  file_size: number;
}

export interface ModpackInstallProgress {
  stage: "downloading" | "creating_instance" | "resolving_mods" | "downloading_mods" | "extracting_overrides" | "completed" | "cancelled";
  current: number;
  total: number;
  current_file?: string;
}

// Instance installation progress (Java → Minecraft → Loader)
export interface InstallProgress {
  id: string;
  step: "java" | "minecraft" | "loader" | "complete";
  message: string;
}

export interface ModpackInstallSummary {
  total_mods: number;
  from_curseforge: string[];
  from_modrinth: string[];  // Важно! Эти моды были найдены автоматически и могут быть не той версии!
  failed: string[];
}

export interface ModpackGalleryImage {
  url: string;
  title?: string;
  description?: string;
  featured: boolean;
}

export interface ModpackDetails {
  body: string;
  license?: string;
  source_url?: string;
  issues_url?: string;
  wiki_url?: string;
  discord_url?: string;
  followers?: number;
  date_created?: string;
  date_modified?: string;
  gallery: ModpackGalleryImage[];
}

export interface ModpackFilePreview {
  name: string;
  version: string;
  minecraft_version: string;
  loader: string;
  loader_version?: string;
  mod_count: number;
  overrides_mods_count: number;
  format: "modrinth" | "curseforge" | "stzhk";
  summary?: string;
}

// ========== Modpack Comparison ==========

export interface ModInfo {
  filename: string;
  name: string;
  version?: string;
  size: number;
  /** SHA1 hash файла мода (для точного сравнения) */
  hash?: string;
}

export interface ConfigInfo {
  path: string;
  size: number;
  hash: string;
}

export interface ModVersionDiff {
  name: string;
  first_filename: string;
  second_filename: string;
  first_version?: string;
  second_version?: string;
}

export interface ConfigDiff {
  path: string;
  first_size: number;
  second_size: number;
}

export interface ModpackComparison {
  mods_only_in_first: ModInfo[];
  mods_only_in_second: ModInfo[];
  mods_different_version: ModVersionDiff[];
  mods_identical: ModInfo[];

  configs_only_in_first: ConfigInfo[];
  configs_only_in_second: ConfigInfo[];
  configs_different: ConfigDiff[];

  other_only_in_first: string[];
  other_only_in_second: string[];

  total_mods_first: number;
  total_mods_second: number;
  total_configs_first: number;
  total_configs_second: number;
}

// ========== Mod Search for Comparison ==========

export interface ModSearchInfo {
  project_id: string;
  slug: string;
  name: string;
  version?: string;
  version_id?: string;
  download_url?: string;
  file_name?: string;
  file_size: number;
  source: "modrinth" | "curseforge";
  icon_url?: string;
}

export type CompareSourceType = "file" | "instance" | "modrinth" | "curseforge";

// ========== Storage Info ==========

export interface InstanceSizeInfo {
  id: string;
  name: string;
  path: string;
  size: number;
}

export interface StorageInfo {
  total_size: number;
  instances_size: number;
  shared_size: number;
  libraries_size: number;
  assets_size: number;
  versions_size: number;
  java_size: number;
  cache_size: number;
  logs_size: number;
  instances: InstanceSizeInfo[];
}

// ========== Shared Resources Analysis ==========

export interface InstalledJavaInfo {
  version: string;
  path: string;
  size: number;
  is_used: boolean;
  used_by_instances: string[];
}

export interface SharedResourcesBreakdown {
  java_versions: InstalledJavaInfo[];
  libraries_count: number;
  libraries_size: number;
  assets_indexes_count: number;
  assets_size: number;
  versions_count: number;
  versions_size: number;
  total_unused_size: number;
}

export interface AppPaths {
  base: string;
  instances: string;
  shared: string;
  libraries: string;
  assets: string;
  versions: string;
  java: string;
  cache: string;
  logs: string;
  database: string;
  resourcepacks: string;
  shaderpacks: string;
}

export interface OrphanedFolder {
  path: string;
  name: string;
  size: number;
}

// ========== STZHK Custom Modpack Format ==========

export interface StzhkManifest {
  format_version: number;
  modpack: StzhkModpackMeta;
  requirements: StzhkGameRequirements;
  mods: StzhkModEntry[];
  overrides?: StzhkOverridesInfo;
  patches: StzhkPatchEntry[];
  optional_mods: StzhkOptionalModGroup[];
}

export interface StzhkModpackMeta {
  id: string;
  name: string;
  version: string;
  author: string;
  description?: string;
  url?: string;
  icon?: string;
  created_at: string;
  updated_at?: string;
}

export interface StzhkGameRequirements {
  minecraft_version: string;
  loader: string;
  loader_version?: string;
  min_ram_mb?: number;
  recommended_ram_mb?: number;
  java_version?: number;
}

export interface StzhkModEntry {
  filename: string;
  name: string;
  version?: string;
  sha256: string;
  size: number;
  source: StzhkModSource;
  required: boolean;
  side: "client" | "server" | "both";
  dependencies: string[];
}

export type StzhkModSource =
  | { type: "embedded"; path: string }
  | { type: "modrinth"; project_id: string; version_id: string; download_url: string }
  | { type: "curseforge"; project_id: number; file_id: number; download_url?: string }
  | { type: "direct"; url: string };

export interface StzhkOverridesInfo {
  path: string;
  hash?: string;
  size: number;
}

export interface StzhkPatchEntry {
  id: string;
  name: string;
  description?: string;
  target: string;
  patch_type: "replace" | "diff" | "json_merge" | "binary";
  patch_file: string;
}

export interface StzhkOptionalModGroup {
  id: string;
  name: string;
  description?: string;
  selection_type: "single" | "multiple";
  mods: StzhkOptionalMod[];
}

export interface StzhkOptionalMod {
  mod_id: string;
  default_enabled: boolean;
  note?: string;
}

export interface StzhkPreview {
  manifest: StzhkManifest;
  embedded_mods_count: number;
  linked_mods_count: number;
  overrides_mods_count: number;
  total_size: number;
}

export interface StzhkVerificationResult {
  valid: boolean;
  total_files: number;
  verified_files: number;
  failed_files: StzhkVerificationFailure[];
  missing_files: string[];
}

export interface StzhkVerificationFailure {
  filename: string;
  expected_hash: string;
  actual_hash: string;
}

export interface StzhkInstallProgress {
  stage: string;
  current: number;
  total: number;
  current_file?: string;
  bytes_downloaded: number;
  bytes_total: number;
}

// ========== Log Analyzer ==========

export type LogSeverity = "info" | "warning" | "error" | "critical";

export type LogProblemCategory =
  | "mod_conflict"
  | "missing_dependency"
  | "java_issue"
  | "memory_issue"
  | "corrupted_file"
  | "version_mismatch"
  | "config_error"
  | "network_error"
  | "permission_error"
  | "crash_during_startup"
  | "crash_during_gameplay"
  | "rendering_error"
  | "audio_error"
  | "unknown";

export type ProblemStatus = "detected" | "awaiting_restart" | "resolved" | "failed";

export interface DetectedProblem {
  id: string;
  title: string;
  description: string;
  severity: LogSeverity;
  category: LogProblemCategory;
  status?: ProblemStatus;
  log_line?: string;
  line_number?: number;
  solutions: LogSolution[];
  docs_links: string[];
  related_mods: string[];
}

export interface LogSolution {
  title: string;
  description: string;
  auto_fix?: AutoFix;
  difficulty: "easy" | "medium" | "hard" | "expert";
  success_rate: number;
}

export type AutoFix =
  | { type: "remove_mod"; filename: string }
  | { type: "download_mod"; name: string; source: string; project_id: string }
  | { type: "change_jvm_arg"; old_arg?: string; new_arg: string }
  | { type: "increase_ram"; recommended_mb: number }
  | { type: "reinstall_mod"; filename: string }
  | { type: "delete_config"; path: string }
  | { type: "install_java"; version: number }
  | { type: "update_loader"; loader: string }
  | { type: "reset_configs" }
  | { type: "verify_files" };

export interface AutoFixResult {
  success: boolean;
  message: string;
  requires_restart: boolean;
  details?: string;
}

export interface LogAnalysisResult {
  problems: DetectedProblem[];
  summary: LogAnalysisSummary;
  optimizations: LogOptimization[];
  crash_info?: CrashInfo;
}

export interface LogAnalysisSummary {
  total_lines: number;
  error_count: number;
  warning_count: number;
  critical_count: number;
  parse_time_ms: number;
}

export interface LogOptimization {
  title: string;
  description: string;
  impact: string;
  auto_fix?: AutoFix;
}

export interface CrashInfo {
  main_cause: string;
  stack_trace: string[];
  culprit_mod?: string;
  crash_time?: string;
  game_version?: string;
  loader?: string;
}

export interface AnalysisReport {
  version: string;
  created_at: number;
  instance_id?: string;
  instance_name?: string;
  result: LogAnalysisResult;
  analyzed_files: string[];
}

// ========== Integrity Check ==========

export interface IntegrityCheckResult {
  valid: boolean;
  total_files: number;
  valid_files: number;
  corrupted_files: CorruptedFile[];
  missing_files: MissingFile[];
  check_time_ms: number;
}

export interface CorruptedFile {
  path: string;
  expected_hash: string;
  actual_hash: string;
  size: number;
  recoverable: boolean;
  recovery_source?: RecoverySource;
}

export interface MissingFile {
  path: string;
  expected_hash: string;
  expected_size: number;
  recoverable: boolean;
  recovery_source?: RecoverySource;
}

export type RecoverySource =
  | { type: "minecraft"; url: string }
  | { type: "modrinth"; project_id: string; version_id: string; url: string }
  | { type: "curseforge"; project_id: number; file_id: number; url?: string }
  | { type: "direct"; url: string }
  | { type: "cache"; path: string };

export interface IntegrityManifest {
  version: number;
  instance_id: string;
  created_at: string;
  updated_at: string;
  files: Record<string, IntegrityFileEntry>;
}

export interface IntegrityFileEntry {
  sha256: string;
  size: number;
  recovery_source?: RecoverySource;
  required: boolean;
}

export interface IntegrityProgress {
  stage: string;
  current: number;
  total: number;
  current_file?: string;
}

export interface RepairResult {
  repaired: number;
  failed: string[];
}

// ========== Modpack Editor ==========

export interface ModpackProject {
  id: string;
  name: string;
  version: string;
  minecraft_version: string;
  loader: string;
  loader_version?: string;
  author?: string;
  description?: string;
  icon_path?: string;
  mods_count: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectMod {
  id: number;
  mod_id: string;
  slug: string;
  name: string;
  version?: string;
  filename?: string;
  sha256?: string;
  size?: number;
  source: string;
  source_id?: string;
  source_version_id?: string;
  download_url?: string;
  icon_url?: string;
  required: boolean;
  side: string;
  sort_order: number;
  created_at: string;
}

export interface ProjectOptionalGroup {
  id: string;
  name: string;
  description?: string;
  selection_type: string;
  sort_order: number;
  mods: ProjectOptionalMod[];
}

export interface ProjectOptionalMod {
  mod_id: string;
  default_enabled: boolean;
  note?: string;
  conflicts_with: string[];
}

export interface ModpackProjectFull {
  project: ModpackProject;
  mods: ProjectMod[];
  optional_groups: ProjectOptionalGroup[];
  overrides_count: number;
}

export interface ModpackProjectUpdate {
  name?: string;
  version?: string;
  author?: string;
  description?: string;
  icon_path?: string;
  minecraft_version?: string;
  loader?: string;
  loader_version?: string;
}

export interface AddModInfo {
  slug: string;
  name: string;
  version?: string;
  filename?: string;
  sha256?: string;
  size?: number;
  source: string;
  source_id?: string;
  source_version_id?: string;
  download_url?: string;
  icon_url?: string;
  side?: string;
}

export interface ExportResult {
  path: string;
  size: number;
  mods_count: number;
  embedded_count: number;
}

// ========== Mod Recommendations ==========

export type RecommendationReason =
  | { type: "same_category"; category: string }
  | { type: "popular_with"; mod_names: string[] }
  | { type: "addon_for"; mod_name: string }
  | { type: "trending" }
  | { type: "optimization" }
  | { type: "common_dependency" };

export interface ModRecommendation {
  slug: string;
  name: string;
  description: string;
  icon_url?: string;
  downloads: number;
  follows: number;
  author: string;
  categories: string[];
  reason: RecommendationReason;
  confidence: number;
}

// ========== Crash History ==========

export type CrashTrendDirection = "worsening" | "stable" | "improving" | "unknown";

export interface CrashRecord {
  id: string;
  instance_id: string;
  crash_time: string;
  log_type: string;
  problems: DetectedProblem[];
  suspected_mods: string[];
  minecraft_version?: string;
  loader_type?: string;
  loader_version?: string;
  was_fixed: boolean;
  fix_method?: string;
  notes?: string;
  created_at: string;
}

export interface ModCrashStats {
  mod_id: string;
  crash_count: number;
  crash_percentage: number;
  last_crash?: string;
  was_fixed: boolean;
}

export interface CrashStatistics {
  total_crashes: number;
  crashes_last_week: number;
  crashes_last_day: number;
  most_problematic_mod?: ModCrashStats;
  top_problematic_mods: ModCrashStats[];
  avg_hours_between_crashes?: number;
  fix_success_rate: number;
  most_common_category?: string;
  trend: CrashTrendDirection;
}

export interface DailyCrashCount {
  date: string;
  count: number;
}

export interface CrashTrend {
  mod_id: string;
  daily_crashes: DailyCrashCount[];
  trend: CrashTrendDirection;
  recommendation: string;
}

// ========== Error Info ==========

/**
 * Информация об ошибке с подсказкой для восстановления
 */
export interface ErrorInfo {
  /** Код ошибки для идентификации */
  code: string;
  /** Человекочитаемое сообщение */
  message: string;
  /** Подсказка для исправления */
  recovery_hint?: string;
  /** Технические детали (для логов) */
  details?: string;
}

/**
 * Проверяет, является ли объект ErrorInfo
 */
export function isErrorInfo(obj: unknown): obj is ErrorInfo {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "code" in obj &&
    "message" in obj &&
    typeof (obj as ErrorInfo).code === "string" &&
    typeof (obj as ErrorInfo).message === "string"
  );
}

/**
 * Извлекает понятное сообщение об ошибке
 */
export function getErrorMessage(error: unknown): string {
  if (isErrorInfo(error)) {
    return error.recovery_hint
      ? `${error.message}. ${error.recovery_hint}`
      : error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Неизвестная ошибка";
}

// ========== Live Crash Monitor ==========

export type LiveCrashEventType =
  | "started"
  | "stopped"
  | "warning"
  | "error"
  | "crash"
  | "monitor_error";

export interface LiveCrashEventStarted {
  type: "started";
  instance_id: string;
}

export interface LiveCrashEventStopped {
  type: "stopped";
  instance_id: string;
}

export interface LiveCrashEventWarning {
  type: "warning";
  instance_id: string;
  message: string;
  line_number: number;
  timestamp: string;
}

export interface LiveCrashEventError {
  type: "error";
  instance_id: string;
  problem: DetectedProblem;
  timestamp: string;
}

export interface LiveCrashEventCrash {
  type: "crash";
  instance_id: string;
  problems: DetectedProblem[];
  timestamp: string;
}

export interface LiveCrashEventMonitorError {
  type: "monitor_error";
  instance_id: string;
  message: string;
}

export type LiveCrashEvent =
  | LiveCrashEventStarted
  | LiveCrashEventStopped
  | LiveCrashEventWarning
  | LiveCrashEventError
  | LiveCrashEventCrash
  | LiveCrashEventMonitorError;

// ========== Solution Finder ==========

export type SolutionSource =
  | "built_in"
  | "github"
  | "reddit"
  | "mod_page"
  | "community";

export interface OnlineSolution {
  /** Заголовок решения (fallback на английском) */
  title: string;
  /** Описание решения (fallback на английском) */
  description: string;
  /** Источник решения */
  source: SolutionSource;
  /** Уверенность в решении (0.0 - 1.0) */
  confidence: number;
  /** Количество людей которым помогло */
  helped_count?: number;
  /** URL источника */
  url?: string;
  /** Теги для поиска */
  tags: string[];
  /**
   * Ключ локализации для встроенных решений.
   * Фронтенд использует его для получения перевода из solutionFinder.knowledgeBase.[key]
   */
  translation_key?: string;
}

export interface SolutionSearchResult {
  /** Найденные решения */
  solutions: OnlineSolution[];
  /** Время поиска в миллисекундах */
  search_time_ms: number;
  /** Проверенные источники */
  sources_checked: SolutionSource[];
}

// ============================================================================
// Knowledge Base Types
// ============================================================================

/** Feedback от пользователя о решении */
export interface SolutionFeedback {
  /** ID feedback записи */
  id: string;
  /** Сигнатура проблемы (hash для группировки) */
  problem_signature: string;
  /** ID решения */
  solution_id: string;
  /** Помогло ли решение */
  helped: boolean;
  /** Когда применено */
  applied_at: string;
  /** Заметки пользователя */
  notes?: string;
  /** ID экземпляра */
  instance_id?: string;
}

/** Статистика по решению */
export interface SolutionRating {
  /** ID решения */
  solution_id: string;
  /** Сколько раз применялось */
  times_applied: number;
  /** Сколько раз помогло */
  times_helped: number;
  /** Success rate (0.0 - 1.0) */
  success_rate: number;
  /** Когда последний раз использовалось */
  last_used: string;
}

/** Базовый тип решения (alias для LogSolution) */
export type Solution = LogSolution;

/** Персональная рекомендация решения */
export interface PersonalizedSolution extends Solution {
  /** Персональная статистика (если есть) */
  personal_rating?: SolutionRating;
  /** Рекомендуется ли на основе личного опыта */
  personally_recommended: boolean;
}

/** Статистика Knowledge Base */
export interface KnowledgeBaseStats {
  /** Всего feedback записей */
  total_feedback: number;
  /** Всего уникальных решений с рейтингом */
  total_solutions: number;
  /** Средний success rate всех решений */
  avg_success_rate: number;
}

// ============================================================================
// Backup Types
// ============================================================================

/** Причина создания бэкапа */
export type BackupTrigger =
  | "before_mod_install"
  | "before_mod_remove"
  | "before_mod_update"
  | "before_auto_fix"
  | "manual";

/** Информация об обнаруженном моде бэкапа */
export interface BackupModStatus {
  /** Обнаружен ли мод для бэкапов */
  detected: boolean;
  /** Название мода (если обнаружен) */
  mod_name?: string;
  /** Название файла мода */
  mod_filename?: string;
}

/** Запись о бэкапе */
export interface BackupRecord {
  /** Уникальный ID бэкапа */
  id: string;
  /** ID экземпляра */
  instance_id: string;
  /** Причина создания */
  trigger: BackupTrigger;
  /** Описание (что было сделано перед бэкапом) */
  description: string;
  /** Путь к файлу бэкапа */
  path: string;
  /** Размер в байтах */
  size: number;
  /** Время создания */
  created_at: string;
}

// ========== Performance Profiler ==========

/** Снимок производительности */
export interface PerformanceSnapshot {
  timestamp: string;
  /** Использование RAM процессом (RSS - вся память, не только heap) */
  memory_used_mb: number;
  memory_max_mb?: number | null;
  /** Загрузка CPU процессом (0-100%) */
  cpu_percent: number;
  /** Количество логических процессоров (потоков) в системе */
  cpu_cores: number;
  /** Количество физических ядер CPU */
  physical_cores: number;
  /** Загрузка каждого логического процессора (0-100%) */
  cpu_per_core: number[];
  tps?: number | null;
  mspt?: number | null;
}

/** Категория влияния на производительность */
export type ImpactCategory = "minimal" | "low" | "medium" | "high" | "critical";

/** Производительность отдельного мода */
export interface ModPerformance {
  mod_id: string;
  mod_name: string;
  tick_time_avg_ms: number;
  tick_time_max_ms: number;
  tick_percent: number;
  memory_mb?: number | null;
  impact_score: number;
  impact_category: ImpactCategory;
}

/** Категория узкого места */
export type BottleneckCategory =
  | "memory"
  | "tick_time"
  | "network_lag"
  | "render_lag"
  | "chunk_loading"
  | "garbage_collection"
  | "disk_io";

/** Серьёзность узкого места */
export type BottleneckSeverity = "low" | "medium" | "high" | "critical";

/** Узкое место производительности */
export interface PerformanceBottleneck {
  category: BottleneckCategory;
  description: string;
  severity: BottleneckSeverity;
  mod_id?: string | null;
  metric?: string | null;
}

/** Рекомендуемое действие для производительности */
export type PerformanceAction =
  | { type: "increase_memory"; current_mb: number; recommended_mb: number }
  | { type: "reduce_render_distance"; current: number; recommended: number }
  | { type: "disable_mod"; mod_id: string; reason: string }
  | { type: "install_optimization_mod"; mod_id: string; mod_name: string; description: string }
  | { type: "update_mod"; mod_id: string; reason: string }
  | { type: "change_setting"; setting_name: string; current_value: string; recommended_value: string; file_path?: string | null }
  | { type: "add_jvm_argument"; argument: string; reason: string };

/** Рекомендация по оптимизации */
export interface PerformanceRecommendation {
  title: string;
  description: string;
  action: PerformanceAction;
  expected_impact: string;
  priority: number;
}

/** Источник данных для отчёта */
export type DataSource = "system_only" | "system_and_logs" | "spark_report";

/** Полный отчёт о производительности */
export interface PerformanceReport {
  instance_id: string;
  created_at: string;
  monitoring_duration_sec: number;
  snapshots: PerformanceSnapshot[];
  mod_performance: ModPerformance[];
  bottlenecks: PerformanceBottleneck[];
  recommendations: PerformanceRecommendation[];
  overall_score: number;
  data_source: DataSource;
  spark_detected: boolean;
}

/** Информация о Spark */
export interface SparkInfo {
  detected: boolean;
  version?: string | null;
  latest_report_path?: string | null;
  latest_report_time?: string | null;
}

/** Event для real-time мониторинга */
export type PerformanceEvent =
  | { type: "started"; instance_id: string; pid: number }
  | { type: "stopped"; instance_id: string }
  | { type: "snapshot"; instance_id: string; snapshot: PerformanceSnapshot }
  | { type: "bottleneck_detected"; instance_id: string; bottleneck: PerformanceBottleneck }
  | { type: "error"; instance_id: string; message: string };

// ========== Shader & Resource Pack Manager ==========

/** Type of resource (shader or resource pack) */
export type ResourceType = "shader" | "resourcepack";

/** Source of the resource */
export type ResourceSource = "modrinth" | "local";

/** Installed resource (shader or resource pack) */
export interface InstalledResource {
  id: number;
  resource_type: ResourceType;
  instance_id?: string | null;
  is_global: boolean;

  slug: string;
  name: string;
  version: string;
  minecraft_version?: string | null;

  source: ResourceSource;
  source_id?: string | null;
  project_url?: string | null;
  download_url?: string | null;

  file_name: string;
  file_hash?: string | null;
  file_size?: number | null;

  enabled: boolean;
  auto_update: boolean;

  description?: string | null;
  author?: string | null;
  icon_url?: string | null;

  installed_at: string;
  updated_at: string;
}

/** Search result from Modrinth for resources */
export interface ResourceSearchResult {
  slug: string;
  title: string;
  description: string;
  author: string;
  icon_url?: string | null;
  downloads: number;
  project_type: string;
  categories: string[];
  versions: string[];
}

/** Search response with pagination info */
export interface ResourceSearchResponse {
  results: ResourceSearchResult[];
  total: number;
  offset: number;
  limit: number;
}

/** Gallery image for resource details */
export interface ResourceGalleryImage {
  url: string;
  title?: string;
  description?: string;
  featured: boolean;
}

/** External links for resource */
export interface ResourceLinks {
  modrinth?: string;
  source?: string;
  wiki?: string;
  discord?: string;
  issues?: string;
}

/** Full resource details from Modrinth */
export interface ResourceDetails {
  slug: string;
  title: string;
  description: string;
  body: string;
  author: string;
  icon_url?: string;
  downloads: number;
  followers: number;
  categories: string[];
  versions: string[];
  gallery: ResourceGalleryImage[];
  links: ResourceLinks;
  license_id?: string;
  license_name?: string;
}

// ========== Universal Project Info (for info dialogs) ==========

/** Project type for universal info dialog */
export type ProjectType = "mod" | "modpack" | "shader" | "resourcepack";

/** Universal gallery image */
export interface ProjectGalleryImage {
  url: string;
  title?: string;
  description?: string;
  featured: boolean;
}

/** Universal external links */
export interface ProjectLinks {
  project?: string; // Main project page (modrinth/curseforge)
  source?: string; // GitHub etc
  wiki?: string;
  discord?: string;
  issues?: string;
}

/** Universal project info for info dialogs */
export interface ProjectInfo {
  slug: string;
  title: string;
  description: string;
  body?: string; // Full markdown description
  author?: string;
  icon_url?: string;
  downloads?: number;
  followers?: number;
  categories: string[];
  versions: string[];
  gallery: ProjectGalleryImage[];
  links: ProjectLinks;
  projectType: ProjectType;
  source?: ModSource; // modrinth / curseforge / local

  // Optional fields for installed items
  enabled?: boolean;
  version?: string;
  file_name?: string;
  file_size?: number;
  installed_at?: string;
  updated_at?: string;
  license_id?: string;
  license_name?: string;
}

// ========== Mod Collections ==========

/** Mod collection */
export interface ModCollection {
  id: string;
  name: string;
  description?: string | null;
  color: string;
  icon: string;
  is_builtin: boolean;
  mod_count: number;
  created_at: string;
  updated_at: string;
}

/** Mod in a collection */
export interface CollectionMod {
  collection_id: string;
  mod_slug: string;
  mod_name: string;
  mod_source: string;
  loader_type?: string | null;
  added_at: string;
}

/** Collection with all its mods */
export interface CollectionWithMods extends ModCollection {
  mods: CollectionMod[];
}

/** Request to create a new collection */
export interface CreateCollectionRequest {
  name: string;
  description?: string | null;
  color?: string | null;
  icon?: string | null;
}

/** Request to update a collection */
export interface UpdateCollectionRequest {
  name?: string | null;
  description?: string | null;
  color?: string | null;
  icon?: string | null;
}

/** Request to add a mod to collection */
export interface AddModToCollectionRequest {
  collection_id: string;
  mod_slug: string;
  mod_name: string;
  mod_source: string;
  loader_type?: string | null;
}

/** Error during collection installation */
export interface CollectionInstallError {
  mod_slug: string;
  error: string;
}

/** Result of installing a collection */
export interface CollectionInstallResult {
  installed: string[];
  failed: CollectionInstallError[];
  skipped: string[];
}

/** Exportable collection format */
export interface ExportedCollection {
  name: string;
  description?: string | null;
  color: string;
  icon: string;
  mods: ExportedMod[];
  exported_at: string;
  version: string;
}

/** Exported mod info */
export interface ExportedMod {
  slug: string;
  name: string;
  source: string;
  loader_type?: string | null;
}

// ========== Integrated Wiki ==========

/** Формат контента wiki */
export type ContentFormat = "markdown" | "html" | "plaintext";

/** Информация о лицензии */
export interface LicenseInfo {
  id: string;
  name: string;
  url?: string | null;
}

/** Изображение галереи */
export interface GalleryImage {
  url: string;
  title?: string | null;
  description?: string | null;
  featured: boolean;
}

/** Wiki контент для мода */
export interface WikiContent {
  mod_name: string;
  slug: string;
  /** Полное описание (markdown для Modrinth, HTML для CurseForge) */
  body: string;
  content_format: ContentFormat;
  project_url?: string | null;
  wiki_url?: string | null;
  discord_url?: string | null;
  issues_url?: string | null;
  source_url?: string | null;
  license?: LicenseInfo | null;
  categories: string[];
  gallery: GalleryImage[];
  downloads: number;
  followers: number;
  date_created?: string | null;
  date_modified?: string | null;
}

/** Changelog версии мода (также используется для выбора версии при установке) */
export interface VersionChangelog {
  /** ID версии (для Modrinth - version_id, для CurseForge - file_id) */
  id: string;
  version_number: string;
  version_name: string;
  changelog?: string | null;
  date_published: string;
  game_versions: string[];
  loaders: string[];
  downloads: number;
  /** Размер файла в байтах */
  file_size: number;
  /** URL для загрузки */
  download_url?: string | null;
  /** Имя файла */
  file_name?: string | null;
  /** Тип версии (release, beta, alpha) */
  version_type?: string | null;
}

// ========== Modpack Patch System ==========

/** Версия формата STZHK файлов (модпаки и патчи) */
export const STZHK_FORMAT_VERSION = "1.0";

/** Информация о базовом модпаке */
export interface PatchBaseInfo {
  /** Название базового модпака */
  name: string;
  /** Версия Minecraft */
  minecraft_version: string;
  /** Загрузчик (fabric, forge, etc.) */
  loader: string;
  /** Версия загрузчика */
  loader_version?: string | null;
  /** Источник модпака (modrinth, curseforge, local) */
  source?: string | null;
  /** ID проекта (для Modrinth/CurseForge) */
  project_id?: string | null;
  /** ID версии (для Modrinth/CurseForge) */
  version_id?: string | null;
}

/** Мод для добавления в патче */
export interface PatchModAdd {
  /** Название мода (для отображения) */
  name: string;
  /** Slug мода */
  slug: string;
  /** Источник (modrinth, curseforge) */
  source: string;
  /** ID проекта */
  project_id: string;
  /** ID конкретной версии (если нужна конкретная версия) */
  version_id?: string | null;
  /** Имя файла (fallback если API недоступен) */
  filename?: string | null;
}

/** Мод для удаления в патче */
export interface PatchModRemove {
  /** Название мода */
  name: string;
  /** Паттерн имени файла (для fuzzy matching) */
  filename_pattern: string;
}

/** Конфиг для добавления/замены в патче */
export interface PatchConfigAdd {
  /** Путь к файлу относительно корня экземпляра */
  path: string;
  /** Содержимое файла в base64 */
  content_base64: string;
}

/** Файл для добавления в патче */
export interface PatchFileAdd {
  /** Путь к файлу */
  path: string;
  /** Содержимое в base64 (для небольших файлов) */
  content_base64?: string | null;
  /** URL для скачивания (для больших файлов) */
  download_url?: string | null;
}

/** Изменения в патче */
export interface PatchChanges {
  /** Моды для добавления */
  mods_to_add: PatchModAdd[];
  /** Моды для удаления */
  mods_to_remove: PatchModRemove[];
  /** Конфиги для добавления/замены */
  configs_to_add: PatchConfigAdd[];
  /** Конфиги для удаления */
  configs_to_remove: string[];
  /** Другие файлы для добавления (resourcepacks, shaderpacks, scripts) */
  files_to_add: PatchFileAdd[];
  /** Файлы для удаления */
  files_to_remove: string[];
}

/** Патч-файл для модпака (.stzhk с file_type: "patch") */
export interface ModpackPatch {
  /** Тип файла (всегда "patch" для патчей) */
  file_type?: string;
  /** Версия формата патча */
  format_version: string;
  /** Информация о базовом модпаке */
  base_modpack: PatchBaseInfo;
  /** Дата создания патча */
  created_at: string;
  /** Описание патча (что изменено) */
  description: string;
  /** Автор патча */
  author?: string | null;
  /** Изменения */
  changes: PatchChanges;
}

/** Результат предпросмотра применения патча */
export interface PatchPreview {
  /** Моды которые будут добавлены */
  mods_to_add: string[];
  /** Моды которые будут удалены */
  mods_to_remove: string[];
  /** Конфиги которые будут добавлены/изменены */
  configs_to_change: string[];
  /** Конфиги которые будут удалены */
  configs_to_remove: string[];
  /** Файлы которые будут добавлены */
  files_to_add: string[];
  /** Файлы которые будут удалены */
  files_to_remove: string[];
  /** Предупреждения (например, мод уже установлен) */
  warnings: string[];
  /** Ошибки (например, мод для удаления не найден) */
  errors: string[];
}

/** Результат применения патча */
export interface PatchApplyResult {
  success: boolean;
  /** Моды успешно добавлены */
  mods_added: string[];
  /** Моды успешно удалены */
  mods_removed: string[];
  /** Конфиги изменены */
  configs_changed: string[];
  /** Файлы добавлены */
  files_added: string[];
  /** Ошибки при применении */
  errors: string[];
}

// ========== Patch Compatibility System ==========

/** Статус совместимости патча */
export type PatchCompatibilityStatus =
  | "compatible"
  | "compatible_with_warnings"
  | "incompatible"
  | "already_applied";

/** Результат проверки совместимости патча */
export interface PatchCompatibilityResult {
  /** Общий статус совместимости */
  status: PatchCompatibilityStatus;
  /** Совместима ли версия Minecraft */
  minecraft_version_match: boolean;
  /** Совместим ли загрузчик */
  loader_match: boolean;
  /** Совместима ли версия загрузчика */
  loader_version_match: boolean;
  /** Совпадает ли базовый модпак (по project_id/version_id) */
  base_modpack_match?: boolean | null;
  /** Был ли патч уже применён */
  already_applied: boolean;
  /** Предупреждения */
  warnings: string[];
  /** Ошибки (почему несовместим) */
  errors: string[];
  /** Рекомендация пользователю */
  recommendation?: string | null;
}

/** Запись о применённом патче */
export interface AppliedPatchRecord {
  /** Уникальный хеш патча (SHA256 от содержимого) */
  patch_hash: string;
  /** Описание патча */
  description: string;
  /** Дата применения */
  applied_at: string;
  /** Базовый модпак для которого был создан патч */
  base_modpack_name: string;
}

// ========== Instance Snapshot System ==========

/** Информация о моде в снимке */
export interface SnapshotModInfo {
  /** Имя файла мода */
  filename: string;
  /** SHA256 хеш содержимого */
  hash: string;
  /** Размер файла в байтах */
  size: number;
}

/** Информация о конфиге в снимке */
export interface SnapshotConfigInfo {
  /** Относительный путь к файлу (от config/) */
  path: string;
  /** SHA256 хеш содержимого */
  hash: string;
  /** Размер файла в байтах */
  size: number;
}

/** Снимок состояния экземпляра для отслеживания изменений */
export interface InstanceSnapshot {
  /** ID экземпляра */
  instance_id: string;
  /** Имя экземпляра */
  instance_name: string;
  /** Версия Minecraft */
  minecraft_version: string;
  /** Загрузчик (fabric, forge, и т.д.) */
  loader: string;
  /** Версия загрузчика */
  loader_version?: string | null;
  /** Дата создания снимка */
  created_at: string;
  /** Список модов в снимке */
  mods: SnapshotModInfo[];
  /** Список конфигов в снимке */
  configs: SnapshotConfigInfo[];
}

/** Обнаруженные изменения в экземпляре */
export interface InstanceChanges {
  /** Добавленные моды (имена файлов) */
  mods_added: string[];
  /** Удалённые моды (имена файлов) */
  mods_removed: string[];
  /** Изменённые конфиги (относительные пути) */
  configs_changed: string[];
  /** Добавленные конфиги (относительные пути) */
  configs_added: string[];
  /** Удалённые конфиги (относительные пути) */
  configs_removed: string[];
  /** Есть ли какие-либо изменения */
  has_changes: boolean;
}
