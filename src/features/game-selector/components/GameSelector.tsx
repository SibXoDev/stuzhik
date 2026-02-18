/**
 * Game Selector Component
 * Allows switching between Minecraft and Hytale
 */

import { For, Show, createSignal, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { currentGame, setCurrentGame } from "../../../shared/stores/gameContext";
import { GAMES, type GameType, type GameInfo } from "../../../shared/types/game.types";
import { useI18n } from "../../../shared/i18n";

interface GameInstallation {
  game: GameType;
  path: string;
  version: string | null;
  is_installed: boolean;
}

interface Props {
  /** Display mode: dropdown, tabs, or cards */
  mode?: "dropdown" | "tabs" | "cards";
  /** Size variant */
  size?: "sm" | "md" | "lg";
  /** Show installation status */
  showStatus?: boolean;
  /** Compact mode for sidebar */
  compact?: boolean;
  /** Callback when game changes */
  onChange?: (game: GameType) => void;
}

export default function GameSelector(props: Props) {
  const { t } = useI18n();
  const mode = () => props.mode || "dropdown";
  const size = () => props.size || "md";
  const sizeClasses = () => {
    switch (size()) {
      case "sm": return { button: "px-2 py-1 text-sm", icon: "w-4 h-4", arrow: "w-3 h-3" };
      case "lg": return { button: "px-4 py-3", icon: "w-6 h-6", arrow: "w-5 h-5" };
      default: return { button: "px-3 py-2", icon: "w-5 h-5", arrow: "w-4 h-4" };
    }
  };
  const [installations, setInstallations] = createSignal<Record<GameType, GameInstallation | null>>({
    minecraft: null,
    hytale: null,
  });
  const [open, setOpen] = createSignal(false);

  onMount(async () => {
    try {
      const detected = await invoke<GameInstallation[]>("detect_games");
      const instMap: Record<GameType, GameInstallation | null> = {
        minecraft: null,
        hytale: null,
      };
      for (const inst of detected) {
        instMap[inst.game] = inst;
      }
      setInstallations(instMap);
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to detect games:", e);
    }
  });

  const handleSelect = (game: GameType) => {
    setCurrentGame(game);
    setOpen(false);
    props.onChange?.(game);
  };

  const currentGameInfo = () => GAMES[currentGame()];
  const games = () => Object.values(GAMES) as GameInfo[];

  // Dropdown mode
  if (mode() === "dropdown") {
    return (
      <div>
        <button
          class={`flex items-center gap-2 ${sizeClasses().button} rounded-lg bg-gray-800 hover:bg-gray-700 transition-colors ${
            props.compact ? "text-sm" : ""
          }`}
          onClick={() => setOpen(!open())}
        >
          <i class={`${currentGameInfo().icon} ${sizeClasses().icon}`} style={{ color: currentGameInfo().accentColor }} />
          <span class="font-medium">{currentGameInfo().name}</span>
          <i class={`i-hugeicons-arrow-down-01 ${sizeClasses().arrow} text-gray-400 transition-transform ${open() ? "rotate-180" : ""}`} />
        </button>

        <Show when={open()}>
          <div class="absolute top-full left-0 mt-1 w-48 bg-gray-800 rounded-lg shadow-lg border border-gray-700 py-1 z-50">
            <For each={games()}>
              {(game) => {
                const inst = () => installations()[game.id];
                const isSelected = () => currentGame() === game.id;

                return (
                  <button
                    class={`w-full flex items-center gap-3 px-3 py-2 hover:bg-gray-700 transition-colors ${
                      isSelected() ? "bg-gray-700/50" : ""
                    }`}
                    onClick={() => handleSelect(game.id)}
                  >
                    <i class={`${game.icon} w-5 h-5`} style={{ color: game.accentColor }} />
                    <div class="flex-1 text-left">
                      <div class="font-medium">{game.name}</div>
                      <Show when={props.showStatus && inst()}>
                        <div class="text-xs text-gray-500">
                          {inst()?.is_installed
                            ? t().games?.installed ?? "Installed"
                            : t().games?.notInstalled ?? "Not installed"}
                        </div>
                      </Show>
                    </div>
                    <Show when={isSelected()}>
                      <i class="i-hugeicons-checkmark-circle-02 w-4 h-4 text-green-400" />
                    </Show>
                  </button>
                );
              }}
            </For>
          </div>
        </Show>
      </div>
    );
  }

  // Tabs mode
  if (mode() === "tabs") {
    return (
      <div class="flex gap-1 p-1 bg-gray-800 rounded-xl">
        <For each={games()}>
          {(game) => {
            const isSelected = () => currentGame() === game.id;

            return (
              <button
                class={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all ${
                  isSelected()
                    ? "bg-gray-700 text-white shadow-sm"
                    : "text-gray-400 hover:text-gray-200 hover:bg-gray-700/50"
                }`}
                onClick={() => handleSelect(game.id)}
              >
                <i class={`${game.icon} w-5 h-5`} style={{ color: isSelected() ? game.accentColor : undefined }} />
                <span>{game.name}</span>
              </button>
            );
          }}
        </For>
      </div>
    );
  }

  // Cards mode
  return (
    <div class="grid grid-cols-2 gap-4">
      <For each={games()}>
        {(game) => {
          const inst = () => installations()[game.id];
          const isSelected = () => currentGame() === game.id;

          return (
            <button
              class={`p-4 rounded-xl border-2 transition-all text-left ${
                isSelected()
                  ? "border-[var(--color-primary)] bg-[var(--color-primary-bg)]"
                  : "border-gray-700 bg-gray-800/50 hover:border-gray-600 hover:bg-gray-800"
              }`}
              onClick={() => handleSelect(game.id)}
            >
              <div class="flex items-center gap-3 mb-2">
                <div
                  class="w-12 h-12 rounded-xl flex items-center justify-center"
                  style={{ "background-color": `${game.accentColor}20` }}
                >
                  <i class={`${game.icon} w-6 h-6`} style={{ color: game.accentColor }} />
                </div>
                <div>
                  <div class="font-semibold text-lg">{game.name}</div>
                  <div class="text-xs text-gray-500">{game.description}</div>
                </div>
              </div>

              <Show when={props.showStatus}>
                <div class="flex items-center gap-2 mt-3 pt-3 border-t border-gray-700">
                  <Show when={inst()?.is_installed} fallback={
                    <>
                      <i class="i-hugeicons-alert-02 w-4 h-4 text-amber-400" />
                      <span class="text-xs text-amber-400">
                        {t().games?.notInstalled ?? "Not installed"}
                      </span>
                    </>
                  }>
                    <i class="i-hugeicons-checkmark-circle-02 w-4 h-4 text-green-400" />
                    <span class="text-xs text-green-400">
                      {t().games?.installed ?? "Installed"}
                    </span>
                  </Show>
                </div>
              </Show>
            </button>
          );
        }}
      </For>
    </div>
  );
}
