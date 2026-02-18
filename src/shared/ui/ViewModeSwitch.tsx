import { For } from "solid-js";
import type { ViewMode } from "../stores/uiPreferences";

interface ViewModeSwitchProps {
  value: ViewMode;
  onChange: (mode: ViewMode) => void;
  /** Какие режимы показывать. По умолчанию все три */
  modes?: ViewMode[];
}

const MODE_CONFIG: Record<ViewMode, { icon: string; label: string }> = {
  grid:    { icon: "i-hugeicons-grid",      label: "Grid" },
  list:    { icon: "i-hugeicons-list-view",  label: "List" },
  compact: { icon: "i-hugeicons-menu-01",    label: "Compact" },
};

export function ViewModeSwitch(props: ViewModeSwitchProps) {
  const modes = () => props.modes ?? (["grid", "list", "compact"] as ViewMode[]);

  return (
    <div class="flex items-center bg-gray-800 rounded-xl p-0.5" role="radiogroup" aria-label="View mode">
      <For each={modes()}>
        {(mode) => {
          const config = MODE_CONFIG[mode];
          const active = () => props.value === mode;

          return (
            <button
              role="radio"
              aria-checked={active()}
              aria-label={config.label}
              class={`p-1.5 rounded-lg transition-colors duration-100 ${
                active()
                  ? "bg-gray-700 text-gray-100"
                  : "text-gray-500 hover:text-gray-300"
              }`}
              onClick={() => props.onChange(mode)}
            >
              <i class={`${config.icon} w-4 h-4`} />
            </button>
          );
        }}
      </For>
    </div>
  );
}
