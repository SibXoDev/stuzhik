import { Show, For, createSignal } from "solid-js";
import type { Component } from "solid-js";
import type { LaunchChanges, SnapshotHistory as SnapshotHistoryType } from "../../../shared/types";
import { useI18n } from "../../../shared/i18n";
import { Tooltip } from "../../../shared/ui/Tooltip";
import SnapshotHistory from "./SnapshotHistory";

interface Props {
  changes: LaunchChanges;
  onDismiss: () => void;
  onReset?: () => void;
  onRollback?: () => void;
  isCrashed?: boolean;
  // Новые props для истории снимков
  history?: SnapshotHistoryType | null;
  selectedSnapshotId?: string | null;
  onSelectSnapshot?: (snapshotId: string) => void;
  onCompareLatest?: () => void;
  onSetMaxSnapshots?: (count: number) => void;
  historyLoading?: boolean;
}

/**
 * Компонент для отображения изменений с последнего успешного запуска
 */
const LaunchChangesAlert: Component<Props> = (props) => {
  const { t } = useI18n();
  const [expanded, setExpanded] = createSignal(false);
  const [showHistory, setShowHistory] = createSignal(false);

  // Don't show if no changes or it's a first launch
  const hasChanges = () => props.changes.has_changes;
  const isFirstLaunch = () => !props.changes.last_launch_at;

  // Calculate total changes
  const totalChanges = () => props.changes.summary.total_mod_changes +
    props.changes.summary.total_config_changes +
    props.changes.summary.total_file_changes;

  // Check if comparing with non-latest snapshot
  const isComparingWithOldSnapshot = () => {
    if (!props.selectedSnapshotId || !props.history) return false;
    const snapshots = props.history.snapshots;
    if (snapshots.length === 0) return false;
    return props.selectedSnapshotId !== snapshots[0].id;
  };

  // Format relative time
  const formatLastLaunch = () => {
    if (!props.changes.last_launch_at) return "";
    const date = new Date(props.changes.last_launch_at);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffHours / 24);

    if (diffDays > 0) {
      return `${diffDays} ${t().launchChanges?.daysAgo || "дн. назад"}`;
    } else if (diffHours > 0) {
      return `${diffHours} ${t().launchChanges?.hoursAgo || "ч. назад"}`;
    } else {
      return t().launchChanges?.recently || "недавно";
    }
  };

  // Different styling for crash context
  const cardClass = () => props.isCrashed
    ? "card bg-red-600/10 border-red-600/30"
    : isComparingWithOldSnapshot()
      ? "card bg-purple-600/10 border-purple-600/30"
      : "card bg-blue-600/10 border-blue-600/30";

  const iconClass = () => props.isCrashed
    ? "i-hugeicons-alert-02 w-5 h-5 text-red-400 flex-shrink-0 mt-0.5"
    : isComparingWithOldSnapshot()
      ? "i-hugeicons-time-02 w-5 h-5 text-purple-400 flex-shrink-0 mt-0.5"
      : "i-hugeicons-clock-02 w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5";

  const titleClass = () => props.isCrashed
    ? "text-red-400"
    : isComparingWithOldSnapshot()
      ? "text-purple-400"
      : "text-blue-400";

  const borderColor = () => props.isCrashed
    ? "border-red-600/20"
    : isComparingWithOldSnapshot()
      ? "border-purple-600/20"
      : "border-blue-600/20";

  // Показывать историю
  const hasHistoryFeature = () => props.history && props.onSelectSnapshot && props.onCompareLatest;

  return (
    <Show when={hasChanges() && !isFirstLaunch()}>
      <div class={cardClass()}>
        {/* Header */}
        <div class="flex items-start gap-3">
          <i class={iconClass()} />

          <div class="flex-1 min-w-0">
            <div class="flex items-center justify-between gap-2">
              <h3 class={`font-medium ${titleClass()}`}>
                {props.isCrashed
                  ? (t().launchChanges?.crashTitle || "Изменения перед крашем")
                  : isComparingWithOldSnapshot()
                    ? (t().launchChanges?.comparingWith || "Сравнение с прошлым снимком")
                    : (t().launchChanges?.title || "Изменения с последнего запуска")}
              </h3>
              <Tooltip text={t().common?.close || "Закрыть"} position="bottom">
                <button
                  class="text-gray-400 hover:text-white transition-colors"
                  onClick={props.onDismiss}
                >
                  <i class="i-hugeicons-cancel-01 w-4 h-4" />
                </button>
              </Tooltip>
            </div>

            <p class="text-sm text-gray-400 mt-1">
              {isComparingWithOldSnapshot()
                ? (t().launchChanges?.snapshotFrom || "Снимок от")
                : (t().launchChanges?.lastLaunch || "Последний запуск")}: {formatLastLaunch()}
              {" • "}
              {totalChanges()} {t().launchChanges?.changesCount || "изменений"}
            </p>

            {/* Quick summary */}
            <div class="flex flex-wrap gap-2 mt-2">
              <Show when={props.changes.mods_added.length > 0}>
                <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-green-600/20 text-green-400">
                  <i class="i-hugeicons-add-01 w-3 h-3" />
                  +{props.changes.mods_added.length} {t().launchChanges?.mods || "модов"}
                </span>
              </Show>
              <Show when={props.changes.mods_removed.length > 0}>
                <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-red-600/20 text-red-400">
                  <i class="i-hugeicons-delete-02 w-3 h-3" />
                  -{props.changes.mods_removed.length} {t().launchChanges?.mods || "модов"}
                </span>
              </Show>
              <Show when={props.changes.mods_updated.length > 0}>
                <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-blue-600/20 text-blue-400">
                  <i class="i-hugeicons-arrow-up-02 w-3 h-3" />
                  {props.changes.mods_updated.length} {t().launchChanges?.updated || "обновлено"}
                </span>
              </Show>
              <Show when={props.changes.mods_enabled.length > 0}>
                <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-cyan-600/20 text-cyan-400">
                  <i class="i-hugeicons-checkmark-circle-02 w-3 h-3" />
                  {props.changes.mods_enabled.length} {t().launchChanges?.enabled || "включено"}
                </span>
              </Show>
              <Show when={props.changes.mods_disabled.length > 0}>
                <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-gray-600/20 text-gray-400">
                  <i class="i-hugeicons-cancel-circle w-3 h-3" />
                  {props.changes.mods_disabled.length} {t().launchChanges?.disabled || "выключено"}
                </span>
              </Show>
              <Show when={props.changes.summary.total_config_changes > 0}>
                <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-yellow-600/20 text-yellow-400">
                  <i class="i-hugeicons-settings-02 w-3 h-3" />
                  {props.changes.summary.total_config_changes} {t().launchChanges?.configs || "конфигов"}
                </span>
              </Show>
              <Show when={props.changes.summary.total_file_changes > 0}>
                <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-purple-600/20 text-purple-400">
                  <i class="i-hugeicons-file-01 w-3 h-3" />
                  {props.changes.summary.total_file_changes} {t().launchChanges?.files || "файлов"}
                </span>
              </Show>
            </div>

            {/* Actions */}
            <div class="flex items-center gap-3 mt-2">
              <button
                class="text-sm text-[var(--color-primary)] hover:text-[var(--color-primary-light)] flex items-center gap-1"
                onClick={() => setExpanded(!expanded())}
              >
                <i class={`w-4 h-4 transition-transform ${expanded() ? "i-hugeicons-arrow-up-01" : "i-hugeicons-arrow-down-01"}`} />
                {expanded() ? (t().launchChanges?.collapse || "Скрыть детали") : (t().launchChanges?.expand || "Показать детали")}
              </button>
              <Show when={hasHistoryFeature()}>
                <button
                  class="text-sm text-purple-400 hover:text-purple-300 flex items-center gap-1"
                  onClick={() => setShowHistory(!showHistory())}
                >
                  <i class={`w-4 h-4 ${showHistory() ? "i-hugeicons-arrow-up-01" : "i-hugeicons-time-02"}`} />
                  {showHistory() ? (t().launchChanges?.hideHistory || "Скрыть историю") : (t().launchChanges?.showHistory || "История")}
                </button>
              </Show>
              <Show when={props.onReset}>
                <Tooltip text={t().launchChanges?.resetHint || "Сбросить базовое состояние для отслеживания"} position="bottom">
                  <button
                    class="text-sm text-gray-400 hover:text-gray-300 flex items-center gap-1"
                    onClick={props.onReset}
                  >
                    <i class="i-hugeicons-refresh w-4 h-4" />
                    {t().launchChanges?.reset || "Сбросить"}
                  </button>
                </Tooltip>
              </Show>
              <Show when={props.onRollback}>
                <Tooltip text={t().launchChanges?.rollbackHint || "Откатить изменения через бэкапы"} position="bottom">
                  <button
                    class="text-sm text-yellow-400 hover:text-yellow-300 flex items-center gap-1"
                    onClick={props.onRollback}
                  >
                    <i class="i-hugeicons-arrow-turn-backward w-4 h-4" />
                    {t().launchChanges?.rollback || "Откатить"}
                  </button>
                </Tooltip>
              </Show>
            </div>
          </div>
        </div>

        {/* Snapshot History */}
        <Show when={showHistory() && hasHistoryFeature()}>
          <div class={`mt-4 pt-4 border-t ${borderColor()}`}>
            <SnapshotHistory
              history={props.history!}
              selectedSnapshotId={props.selectedSnapshotId ?? null}
              onSelectSnapshot={props.onSelectSnapshot!}
              onCompareLatest={props.onCompareLatest!}
              onSetMaxSnapshots={props.onSetMaxSnapshots}
              loading={props.historyLoading}
            />
          </div>
        </Show>

        {/* Expanded details */}
        <Show when={expanded()}>
          <div class={`mt-4 pt-4 border-t ${borderColor()} space-y-3 max-h-64 overflow-y-auto`}>
            {/* Added mods */}
            <Show when={props.changes.mods_added.length > 0}>
              <div class="flex flex-col gap-1">
                <h4 class="text-xs font-medium text-green-400 flex items-center gap-1">
                  <i class="i-hugeicons-add-01 w-3 h-3" />
                  {t().launchChanges?.addedMods || "Добавленные моды"}
                </h4>
                <div class="text-xs text-gray-300 space-y-0.5">
                  <For each={props.changes.mods_added}>
                    {(mod) => <div class="truncate">• {mod}</div>}
                  </For>
                </div>
              </div>
            </Show>

            {/* Removed mods */}
            <Show when={props.changes.mods_removed.length > 0}>
              <div class="flex flex-col gap-1">
                <h4 class="text-xs font-medium text-red-400 flex items-center gap-1">
                  <i class="i-hugeicons-delete-02 w-3 h-3" />
                  {t().launchChanges?.removedMods || "Удалённые моды"}
                </h4>
                <div class="text-xs text-gray-300 space-y-0.5">
                  <For each={props.changes.mods_removed}>
                    {(mod) => <div class="truncate">• {mod}</div>}
                  </For>
                </div>
              </div>
            </Show>

            {/* Updated mods */}
            <Show when={props.changes.mods_updated.length > 0}>
              <div class="flex flex-col gap-1">
                <h4 class="text-xs font-medium text-blue-400 flex items-center gap-1">
                  <i class="i-hugeicons-arrow-up-02 w-3 h-3" />
                  {t().launchChanges?.updatedMods || "Обновлённые моды"}
                </h4>
                <div class="text-xs text-gray-300 space-y-0.5">
                  <For each={props.changes.mods_updated}>
                    {(update) => (
                      <div class="truncate">
                        • {update.mod_slug}: {update.old_filename} → {update.new_filename}
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            {/* Enabled/Disabled mods */}
            <Show when={props.changes.mods_enabled.length > 0}>
              <div class="flex flex-col gap-1">
                <h4 class="text-xs font-medium text-cyan-400 flex items-center gap-1">
                  <i class="i-hugeicons-checkmark-circle-02 w-3 h-3" />
                  {t().launchChanges?.enabledMods || "Включённые моды"}
                </h4>
                <div class="text-xs text-gray-300 space-y-0.5">
                  <For each={props.changes.mods_enabled}>
                    {(mod) => <div class="truncate">• {mod}</div>}
                  </For>
                </div>
              </div>
            </Show>

            <Show when={props.changes.mods_disabled.length > 0}>
              <div>
                <h4 class="text-xs font-medium text-gray-400 mb-1 flex items-center gap-1">
                  <i class="i-hugeicons-cancel-circle w-3 h-3" />
                  {t().launchChanges?.disabledMods || "Выключенные моды"}
                </h4>
                <div class="text-xs text-gray-300 space-y-0.5">
                  <For each={props.changes.mods_disabled}>
                    {(mod) => <div class="truncate">• {mod}</div>}
                  </For>
                </div>
              </div>
            </Show>

            {/* Config changes */}
            <Show when={props.changes.configs_modified.length > 0 || props.changes.configs_added.length > 0 || props.changes.configs_removed.length > 0}>
              <div>
                <h4 class="text-xs font-medium text-yellow-400 mb-1 flex items-center gap-1">
                  <i class="i-hugeicons-settings-02 w-3 h-3" />
                  {t().launchChanges?.configChanges || "Изменения конфигов"}
                </h4>
                <div class="text-xs text-gray-300 space-y-0.5">
                  <For each={props.changes.configs_added}>
                    {(config) => <div class="truncate text-green-400">+ {config}</div>}
                  </For>
                  <For each={props.changes.configs_modified}>
                    {(config) => <div class="truncate">~ {config}</div>}
                  </For>
                  <For each={props.changes.configs_removed}>
                    {(config) => <div class="truncate text-red-400">- {config}</div>}
                  </For>
                </div>
              </div>
            </Show>

            {/* File changes (options.txt, resourcepacks, etc.) */}
            <Show when={props.changes.files_modified.length > 0 || props.changes.files_added.length > 0 || props.changes.files_removed.length > 0}>
              <div>
                <h4 class="text-xs font-medium text-purple-400 mb-1 flex items-center gap-1">
                  <i class="i-hugeicons-file-01 w-3 h-3" />
                  {t().launchChanges?.fileChanges || "Другие файлы"}
                </h4>
                <div class="text-xs text-gray-300 space-y-0.5">
                  <For each={props.changes.files_added}>
                    {(file) => <div class="truncate text-green-400">+ {file}</div>}
                  </For>
                  <For each={props.changes.files_modified}>
                    {(file) => <div class="truncate">~ {file}</div>}
                  </For>
                  <For each={props.changes.files_removed}>
                    {(file) => <div class="truncate text-red-400">- {file}</div>}
                  </For>
                </div>
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  );
};

export default LaunchChangesAlert;
