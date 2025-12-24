/**
 * Types for Modpack Editor features
 * Config Editor, File Browser, Mod Profiles
 */

// ==================== Config Editor ====================

export type ConfigType = "toml" | "json" | "properties" | "yaml" | "txt";

export interface ConfigFile {
  path: string;
  name: string;
  config_type: ConfigType;
  size: number;
  modified: string;
}

export interface ConfigContent {
  path: string;
  content: string;
  config_type: ConfigType;
}

// ==================== File Browser ====================

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: string;
}

// ==================== Mod Profiles ====================

export interface ModProfile {
  id: string;
  instance_id: string;
  name: string;
  description: string | null;
  enabled_mod_ids: number[];
  created_at: string;
  updated_at: string;
}
