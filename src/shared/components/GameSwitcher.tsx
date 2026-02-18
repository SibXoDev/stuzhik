/**
 * Compact game switcher for TitleBar
 * Displays as inline tabs/radio buttons without icons
 */

import { For } from "solid-js";
import { currentGame, setCurrentGame } from "../stores/gameContext";
import { GAMES, type GameType } from "../types/game.types";

export default function GameSwitcher() {
  const games = () => Object.values(GAMES) as Array<{ id: GameType; name: string; accentColor: string }>;

  const handleSelect = (game: GameType) => {
    setCurrentGame(game);
  };

  return (
    <div class="flex items-center gap-0.5 p-0.5 bg-gray-800/50 rounded-lg">
      <For each={games()}>
        {(game) => {
          const isSelected = () => currentGame() === game.id;

          return (
            <button
              class={`px-3 py-1 text-xs font-medium rounded-md transition-all ${
                isSelected()
                  ? "bg-gray-700 text-gray-200 shadow-sm"
                  : "text-gray-400 hover:text-gray-200 hover:bg-gray-700/50"
              }`}
              onClick={() => handleSelect(game.id)}
              style={isSelected() ? { "border-bottom": `2px solid ${game.accentColor}` } : undefined}
            >
              {game.name}
            </button>
          );
        }}
      </For>
    </div>
  );
}
