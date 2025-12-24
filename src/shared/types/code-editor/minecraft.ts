/**
 * Minecraft Data Types (соответствуют Rust типам)
 */

export interface MinecraftItem {
  id: string;
  name: string;
  mod_id: string;
  tags: string[];
  texture_path: string | null;
  stack_size: number;
  rarity: string;
  description: string | null;
}

export interface MinecraftBlock {
  id: string;
  name: string;
  mod_id: string;
  tags: string[];
  hardness: number | null;
  blast_resistance: number | null;
  requires_tool: boolean | null;
}

export interface MinecraftTag {
  id: string;
  tag_type: 'item' | 'block';
  values: string[];
}

export interface ModInfo {
  mod_id: string;
  name: string;
  version: string;
  loader: string;
  item_count: number;
  block_count: number;
}

export interface CacheStats {
  total_items: number;
  total_blocks: number;
  total_tags: number;
  total_mods: number;
  last_rebuild: number | null;
}

export interface RebuildStats {
  total_mods: number;
  parsed_mods: number;
  failed_mods: number;
  total_items: number;
  total_blocks: number;
  total_tags: number;
}
