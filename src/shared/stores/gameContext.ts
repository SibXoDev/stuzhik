/**
 * Game context store - manages the currently selected game
 */

import { createSignal } from "solid-js";
import type { GameType } from "../types/game.types";

// Default to Minecraft for backwards compatibility
const STORAGE_KEY = "stuzhik_current_game";

function getInitialGame(): GameType {
  if (typeof localStorage !== "undefined") {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "minecraft" || stored === "hytale") {
      return stored;
    }
  }
  return "minecraft";
}

const [currentGame, setCurrentGameInternal] = createSignal<GameType>(getInitialGame());

/**
 * Set the current game and persist to localStorage
 */
export function setCurrentGame(game: GameType): void {
  setCurrentGameInternal(game);
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(STORAGE_KEY, game);
  }
}

/**
 * Get the current game (reactive)
 */
export { currentGame };

/**
 * Check if current game is Minecraft
 */
export function isMinecraft(): boolean {
  return currentGame() === "minecraft";
}

/**
 * Check if current game is Hytale
 */
export function isHytale(): boolean {
  return currentGame() === "hytale";
}

/**
 * Toggle between games
 */
export function toggleGame(): void {
  setCurrentGame(currentGame() === "minecraft" ? "hytale" : "minecraft");
}
