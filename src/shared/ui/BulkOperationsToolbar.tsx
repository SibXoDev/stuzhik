import { Show } from "solid-js";
import { useI18n } from "../i18n";

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
 *
 * Accessibility: All buttons have aria-label for screen readers
 */
export function BulkOperationsToolbar(props: BulkOperationsToolbarProps) {
  const { t } = useI18n();

  return (
    <Show when={props.selectedCount > 0}>
      <div
        class="flex items-center gap-3 p-3 bg-[var(--color-primary-bg)] border-l-4 border-[var(--color-primary)] rounded-lg"
        role="toolbar"
        aria-label={t().ui?.bulkOperations?.toolbar ?? "Bulk operations"}
      >
        <div class="flex items-center gap-2 text-sm text-[var(--color-primary)]">
          <i class="i-hugeicons-checkmark-circle-02 w-4 h-4" aria-hidden="true" />
          <span class="font-medium">
            {t().ui?.bulkOperations?.selected ?? "Selected:"} {props.selectedCount}
          </span>
        </div>

        <div class="flex gap-2 flex-1" role="group">
          <Show when={props.onEnableAll}>
            <button
              class="btn-sm btn-secondary"
              onClick={props.onEnableAll}
              title={props.enableLabel || (t().ui?.bulkOperations?.enableAll ?? "Enable all")}
              aria-label={props.enableLabel || (t().ui?.bulkOperations?.enableAll ?? "Enable all selected items")}
            >
              <i class="i-hugeicons-checkmark-circle-02 w-4 h-4" aria-hidden="true" />
              {props.enableLabel || (t().ui?.bulkOperations?.enable ?? "Enable")}
            </button>
          </Show>

          <Show when={props.onDisableAll}>
            <button
              class="btn-sm btn-secondary"
              onClick={props.onDisableAll}
              title={props.disableLabel || (t().ui?.bulkOperations?.disableAll ?? "Disable all")}
              aria-label={props.disableLabel || (t().ui?.bulkOperations?.disableAll ?? "Disable all selected items")}
            >
              <i class="i-hugeicons-cancel-circle w-4 h-4" aria-hidden="true" />
              {props.disableLabel || (t().ui?.bulkOperations?.disable ?? "Disable")}
            </button>
          </Show>

          <Show when={props.onDeleteAll}>
            <button
              class="btn-sm bg-red-600/20 hover:bg-red-600/30 text-red-400 border-red-600/30"
              onClick={props.onDeleteAll}
              title={props.deleteLabel || (t().ui?.bulkOperations?.deleteAll ?? "Delete all")}
              aria-label={props.deleteLabel || (t().ui?.bulkOperations?.deleteAll ?? "Delete all selected items")}
            >
              <i class="i-hugeicons-delete-02 w-4 h-4" aria-hidden="true" />
              {props.deleteLabel || (t().ui?.bulkOperations?.delete ?? "Delete")}
            </button>
          </Show>
        </div>

        <button
          class="btn-sm btn-ghost"
          onClick={props.onDeselectAll}
          title={t().ui?.bulkOperations?.deselect ?? "Deselect"}
          aria-label={t().ui?.bulkOperations?.deselect ?? "Deselect all items"}
        >
          <i class="i-hugeicons-cancel-01 w-4 h-4" aria-hidden="true" />
          {t().ui?.bulkOperations?.cancel ?? "Cancel"}
        </button>
      </div>
    </Show>
  );
}
