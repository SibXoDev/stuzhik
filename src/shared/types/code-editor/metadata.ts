/** Pack metadata (pack.mcmeta) */
export interface PackMcmeta {
  pack: PackInfo;
  filter?: PackFilter;
  overlays?: PackOverlays;
}

export interface PackInfo {
  pack_format: number;
  description: string;
  supported_formats?: SupportedFormats;
}

export type SupportedFormats =
  | { min_inclusive: number; max_inclusive: number }
  | number[];

export interface PackFilter {
  block: FilterBlock[];
}

export interface FilterBlock {
  namespace?: string;
  path?: string;
}

export interface PackOverlays {
  entries: OverlayEntry[];
}

export interface OverlayEntry {
  formats: SupportedFormats;
  directory: string;
}

/** Forge/NeoForge mods.toml */
export interface ModsToml {
  mod_loader: string;
  loader_version: string;
  license: string;
  issue_tracker_url?: string;
  properties?: Record<string, string>;
  mods: ModEntry[];
  dependencies?: Record<string, TomlModDependency[]>;
}

export interface ModEntry {
  mod_id: string;
  version: string;
  display_name: string;
  description?: string;
  logo_file?: string;
  update_json_url?: string;
  credits?: string;
  authors?: string;
  display_url?: string;
}

export interface TomlModDependency {
  mod_id: string;
  mandatory: boolean;
  version_range: string;
  ordering: string;
  side: string;
}

/** Fabric mod.json */
export interface FabricModJson {
  schema_version: number;
  id: string;
  version: string;
  name?: string;
  description?: string;
  authors?: AuthorEntry[];
  contact?: ContactInfo;
  license?: string | string[];
  icon?: string;
  environment?: string;
  entrypoints?: Record<string, EntrypointEntry[]>;
  mixins?: MixinEntry[];
  depends?: Record<string, string>;
  recommends?: Record<string, string>;
  suggests?: Record<string, string>;
  breaks?: Record<string, string>;
  conflicts?: Record<string, string>;
  access_widener?: string;
  custom?: Record<string, unknown>;
}

export type AuthorEntry =
  | string
  | { name: string; contact?: Record<string, string> };

export interface ContactInfo {
  homepage?: string;
  issues?: string;
  sources?: string;
  email?: string;
  irc?: string;
  discord?: string;
}

export type EntrypointEntry =
  | string
  | { adapter: string; value: string };

export type MixinEntry =
  | string
  | { config: string; environment?: string };

/** Unified metadata file type */
export type MetadataFile =
  | { type: "pack_mcmeta"; path: string; data: PackMcmeta }
  | { type: "mods_toml"; path: string; data: ModsToml }
  | { type: "fabric_mod_json"; path: string; data: FabricModJson };

/** Pack format info */
export interface PackFormatInfo {
  format: number;
  versions: string;
  packType: string;
}

/** Pack format mapping */
export const PACK_FORMATS: PackFormatInfo[] = [
  { format: 1, versions: "1.6.1 - 1.8.9", packType: "Resource Pack" },
  { format: 2, versions: "1.9 - 1.10.2", packType: "Resource Pack" },
  { format: 3, versions: "1.11 - 1.12.2", packType: "Resource Pack" },
  { format: 4, versions: "1.13 - 1.14.4", packType: "Resource/Data Pack" },
  { format: 5, versions: "1.15 - 1.16.1", packType: "Resource/Data Pack" },
  { format: 6, versions: "1.16.2 - 1.16.5", packType: "Resource/Data Pack" },
  { format: 7, versions: "1.17 - 1.17.1", packType: "Resource/Data Pack" },
  { format: 8, versions: "1.18 - 1.18.2", packType: "Resource/Data Pack" },
  { format: 9, versions: "1.19 - 1.19.2", packType: "Resource/Data Pack" },
  { format: 10, versions: "1.19.3", packType: "Resource/Data Pack" },
  { format: 12, versions: "1.19.4", packType: "Resource/Data Pack" },
  { format: 15, versions: "1.20.1 - 1.20.2", packType: "Resource/Data Pack" },
  { format: 18, versions: "1.20.3 - 1.20.4", packType: "Resource/Data Pack" },
  { format: 26, versions: "1.20.5 - 1.20.6", packType: "Resource/Data Pack" },
  { format: 34, versions: "1.21 - 1.21.1", packType: "Resource/Data Pack" },
  { format: 42, versions: "1.21.2 - 1.21.3", packType: "Resource/Data Pack" },
  { format: 46, versions: "1.21.4+", packType: "Resource/Data Pack" },
];

export function getPackFormatInfo(format: number): PackFormatInfo | undefined {
  return PACK_FORMATS.find((p) => p.format === format);
}
