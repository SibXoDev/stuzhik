import { Show, For, createSignal } from "solid-js";
import { getPresetsForFile } from "../../../shared/data/config-templates";
import { addToast } from "../../../shared/components/Toast";

interface QuickPresetsPanelProps {
  fileName: string;
  onApplyPreset: (content: string) => void;
  onBackup: () => void;
}

export function QuickPresetsPanel(props: QuickPresetsPanelProps) {
  const [expanded, setExpanded] = createSignal(true);

  const presets = () => getPresetsForFile(props.fileName);
  const hasPresets = () => presets().length > 0;

  return (
    <Show when={hasPresets()}>
      <div class="card mb-3">
        {/* Header */}
        <div
          class="flex items-center justify-between cursor-pointer p-3"
          onClick={() => setExpanded(!expanded())}
        >
          <div class="flex items-center gap-2">
            <i class="i-hugeicons-sparkles w-5 h-5 text-[var(--color-primary)]" />
            <h3 class="font-semibold">Быстрые настройки</h3>
            <span class="text-xs text-gray-500">{presets().length} шаблонов</span>
          </div>
          <i class={`w-4 h-4 transition-transform ${expanded() ? "i-hugeicons-arrow-up-01" : "i-hugeicons-arrow-down-01"}`} />
        </div>

        {/* Content */}
        <Show when={expanded()}>
          <div class="border-t border-gray-800 p-3">
            <div class="grid grid-cols-2 gap-2 mb-3">
              <For each={presets()}>
                {(preset) => (
                  <button
                    class="card-hover text-left p-3"
                    onClick={() => props.onApplyPreset(preset.content)}
                  >
                    <div class="font-medium mb-1">{preset.name}</div>
                    <div class="text-xs text-muted">{preset.description}</div>
                  </button>
                )}
              </For>
            </div>

            {/* Quick Actions */}
            <div class="flex gap-2 pt-2 border-t border-gray-800">
              <button
                class="btn-secondary btn-sm flex-1"
                onClick={props.onBackup}
              >
                <i class="i-hugeicons-copy-01 w-4 h-4" />
                Создать бэкап
              </button>
              <button
                class="btn-secondary btn-sm flex-1"
                onClick={() => {
                  addToast({
                    type: "info",
                    title: "Совет",
                    message: "Используйте Ctrl+S для быстрого сохранения, Ctrl+F для поиска",
                    duration: 5000,
                  });
                }}
              >
                <i class="i-hugeicons-information-circle w-4 h-4" />
                Подсказки
              </button>
            </div>
          </div>
        </Show>
      </div>
    </Show>
  );
}
