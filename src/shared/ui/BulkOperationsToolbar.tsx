import { Show } from "solid-js";

interface BulkOperationsToolbarProps {
  selectedCount: number;
  onEnableAll?: () => void;
  onDisableAll?: () => void;
  onDeleteAll?: () => void;
  onDeselectAll: () => void;
  enableLabel?: string;
  disableLabel?: string;
  deleteLabel?: string;
}

/**
 * Toolbar that appears when items are selected
 * Shows count and bulk operation buttons
 */
export function BulkOperationsToolbar(props: BulkOperationsToolbarProps) {
  return (
    <Show when={props.selectedCount > 0}>
      <div class="flex items-center gap-3 p-3 bg-blue-600/10 border-l-4 border-blue-600 rounded-lg">
        <div class="flex items-center gap-2 text-sm text-blue-400">
          <i class="i-hugeicons-checkmark-circle-02 w-4 h-4" />
          <span class="font-medium">
            Выбрано: {props.selectedCount}
          </span>
        </div>

        <div class="flex gap-2 flex-1">
          <Show when={props.onEnableAll}>
            <button
              class="btn-sm btn-secondary"
              onClick={props.onEnableAll}
              title={props.enableLabel || "Включить все"}
            >
              <i class="i-hugeicons-checkmark-circle-02 w-4 h-4" />
              {props.enableLabel || "Включить"}
            </button>
          </Show>

          <Show when={props.onDisableAll}>
            <button
              class="btn-sm btn-secondary"
              onClick={props.onDisableAll}
              title={props.disableLabel || "Выключить все"}
            >
              <i class="i-hugeicons-cancel-circle w-4 h-4" />
              {props.disableLabel || "Выключить"}
            </button>
          </Show>

          <Show when={props.onDeleteAll}>
            <button
              class="btn-sm bg-red-600/20 hover:bg-red-600/30 text-red-400 border-red-600/30"
              onClick={props.onDeleteAll}
              title={props.deleteLabel || "Удалить все"}
            >
              <i class="i-hugeicons-delete-02 w-4 h-4" />
              {props.deleteLabel || "Удалить"}
            </button>
          </Show>
        </div>

        <button
          class="btn-sm btn-ghost"
          onClick={props.onDeselectAll}
          title="Снять выделение"
        >
          <i class="i-hugeicons-cancel-01 w-4 h-4" />
          Отменить
        </button>
      </div>
    </Show>
  );
}
