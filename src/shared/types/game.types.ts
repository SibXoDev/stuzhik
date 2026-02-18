/**
 * Game types supported by Stuzhik launcher
 */

/** Supported games */
export type GameType = "minecraft" | "hytale";

/** Game metadata */
export interface GameInfo {
  id: GameType;
  name: string;
  icon: string;
  description: string;
  /** CurseForge game ID */
  curseforgeId: number;
  /** Whether the game supports Modrinth */
  hasModrinth: boolean;
  /** Color theme for the game */
  accentColor: string;
}

/** Game-specific instance configuration */
export interface GameInstanceConfig {
  game: GameType;
}

/** Minecraft-specific instance config */
export interface MinecraftInstanceConfig extends GameInstanceConfig {
  game: "minecraft";
  loader: "vanilla" | "forge" | "fabric" | "quilt" | "neoforge";
  loaderVersion?: string;
  javaPath?: string;
  javaArgs?: string;
}

/** Hytale-specific instance config */
export interface HytaleInstanceConfig extends GameInstanceConfig {
  game: "hytale";
  /** Hytale mod types */
  modTypes: ("packs" | "plugins" | "early_plugins")[];
}

/** Union type for all game configs */
export type AnyGameInstanceConfig = MinecraftInstanceConfig | HytaleInstanceConfig;

/** Game detection result */
export interface GameInstallation {
  game: GameType;
  path: string;
  version?: string;
  isInstalled: boolean;
}

/** Static game information */
export const GAMES: Record<GameType, GameInfo> = {
  minecraft: {
    id: "minecraft",
    name: "Minecraft",
    icon: "i-hugeicons-cube-01",
    description: "The original sandbox game",
    curseforgeId: 432,
    hasModrinth: true,
    accentColor: "#5D8731", // Minecraft green
  },
  hytale: {
    id: "hytale",
    name: "Hytale",
    icon: "i-hugeicons-sword-01",
    description: "The next generation sandbox RPG",
    curseforgeId: 83374, // Hytale CurseForge game ID
    hasModrinth: false,
    accentColor: "#E85D04", // Hytale orange
  },
};

/** Get game info by type */
export function getGameInfo(game: GameType): GameInfo {
  return GAMES[game];
}

/** Check if a game supports Modrinth */
export function supportsModrinth(game: GameType): boolean {
  return GAMES[game].hasModrinth;
}
