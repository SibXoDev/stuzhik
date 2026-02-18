/** Project types that can be detected in an instance */
export type EditorProjectType =
  | "kubejs"
  | "crafttweaker"
  | "datapack"
  | "resourcepack"
  | "configs"
  | "shaders";

/** Detected project in an instance */
export interface DetectedProject {
  /** Project type identifier */
  project_type: EditorProjectType;
  /** Root directory relative to instance */
  root_path: string;
  /** Display name */
  name: string;
  /** Version if detected (e.g., "6.1" for KubeJS) */
  version: string | null;
  /** Sub-projects or categories within this project */
  categories: ProjectCategory[];
  /** Whether this project supports hot reload */
  supports_hot_reload: boolean;
  /** Files to watch for changes */
  watch_patterns: string[];
}

/** Category within a project */
export interface ProjectCategory {
  /** Category identifier */
  id: string;
  /** Display name */
  name: string;
  /** Path relative to project root */
  path: string;
  /** File patterns this category handles */
  file_patterns: string[];
  /** Description for UI */
  description: string | null;
  /** Icon identifier */
  icon: string | null;
  /** Templates available for this category */
  templates: FileTemplate[];
}

/** File template for creating new files */
export interface FileTemplate {
  /** Template identifier */
  id: string;
  /** Display name */
  name: string;
  /** File extension */
  extension: string;
  /** Default filename (without extension) */
  default_name: string;
  /** Template content (with placeholders) */
  content: string;
  /** Description */
  description: string | null;
}

/** Instance project context */
export interface InstanceProjectContext {
  /** Instance ID */
  instance_id: string;
  /** Minecraft version */
  minecraft_version: string;
  /** Loader type */
  loader: string;
  /** Detected projects */
  projects: DetectedProject[];
  /** Mod versions map (mod_id -> version) */
  mod_versions: Record<string, string>;
}

/** Project icon mapping */
export const PROJECT_ICONS: Record<EditorProjectType, string> = {
  kubejs: "i-hugeicons-java-script",
  crafttweaker: "i-hugeicons-code",
  datapack: "i-hugeicons-database",
  resourcepack: "i-hugeicons-image-01",
  configs: "i-hugeicons-settings-02",
  shaders: "i-hugeicons-flash",
};

/** Category icon mapping */
export const CATEGORY_ICONS: Record<string, string> = {
  server: "i-hugeicons-hard-drive",
  client: "i-hugeicons-laptop",
  startup: "i-hugeicons-rocket-01",
  assets: "i-hugeicons-image-01",
  data: "i-hugeicons-database",
  script: "i-hugeicons-code",
  recipes: "i-hugeicons-grid",
  loot_tables: "i-hugeicons-gift",
  tags: "i-hugeicons-tag-01",
  advancements: "i-hugeicons-trophy",
  textures: "i-hugeicons-image-01",
  models: "i-hugeicons-cube-01",
  lang: "i-hugeicons-translate",
  config: "i-hugeicons-settings-01",
  json: "i-hugeicons-code-square",
  toml: "i-hugeicons-file-01",
  folder: "i-hugeicons-folder-01",
  image: "i-hugeicons-image-01",
  cube: "i-hugeicons-cube-01",
  translate: "i-hugeicons-translate",
  recipe: "i-hugeicons-grid",
  loot: "i-hugeicons-gift",
  tag: "i-hugeicons-tag-01",
  advancement: "i-hugeicons-trophy",
};
