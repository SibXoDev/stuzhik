import { Show, For, createMemo, createSignal } from "solid-js";
import type { Component } from "solid-js";
import type { SnapshotMeta, SnapshotHistory as SnapshotHistoryType } from "../../../shared/types";
import { Select } from "../../../shared/ui";
import { addToast } from "../../../shared/components/Toast";

interface Props {
  history: SnapshotHistoryType | null;
  selectedSnapshotId: string | null;
  onSelectSnapshot: (snapshotId: string) => void;
  onCompareLatest: () => void;
  /** Called for arrow navigation - doesn't close modal */
  onNavigate?: (snapshotId: string | null) => void;
  onSetMaxSnapshots?: (count: number) => void;
  loading?: boolean;
}

const MAX_SNAPSHOTS_OPTIONS = [
  { value: "5", label: "5" },
  { value: "10", label: "10" },
  { value: "15", label: "15" },
  { value: "20", label: "20" },
  { value: "30", label: "30" },
];

/**
 * Компонент для отображения истории снимков и выбора для сравнения
 */
const SnapshotHistory: Component<Props> = (props) => {
  const [showSettings, setShowSettings] = createSignal(false);

  const snapshots = createMemo(() => props.history?.snapshots ?? []);
  const maxSnapshots = createMemo(() => props.history?.max_snapshots ?? 10);

  // Улучшенное форматирование даты с человекочитаемыми интервалами
  const formatDate = (isoDate: string) => {
    try {
      const date = new Date(isoDate);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffSeconds = Math.floor(diffMs / 1000);
      const diffMinutes = Math.floor(diffSeconds / 60);
      const diffHours = Math.floor(diffMinutes / 60);
      const diffDays = Math.floor(diffHours / 24);

      // Только что (меньше минуты)
      if (diffSeconds < 60) {
        return "только что";
      }

      // Минуты назад
      if (diffMinutes < 60) {
        const mins = diffMinutes;
        if (mins === 1) return "минуту назад";
        if (mins < 5) return `${mins} минуты назад`;
        return `${mins} минут назад`;
      }

      // Часы назад (сегодня)
      if (diffHours < 24 && date.getDate() === now.getDate()) {
        const hrs = diffHours;
        if (hrs === 1) return "час назад";
        if (hrs < 5) return `${hrs} часа назад`;
        return `${hrs} часов назад`;
      }

      // Вчера
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      if (date.getDate() === yesterday.getDate() &&
          date.getMonth() === yesterday.getMonth() &&
          date.getFullYear() === yesterday.getFullYear()) {
        const timeStr = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        return `вчера в ${timeStr}`;
      }

      // Дни назад (до недели)
      if (diffDays < 7) {
        if (diffDays === 1) return "вчера";
        if (diffDays < 5) return `${diffDays} дня назад`;
        return `${diffDays} дней назад`;
      }

      // Старше недели - полная дата и время
      return date.toLocaleString([], {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return isoDate;
    }
  };

  // Иконка статуса запуска
  const getStatusIcon = (meta: SnapshotMeta) => {
    if (meta.was_successful === null) {
      return "i-hugeicons-help-circle text-gray-400";
    } else if (meta.was_successful) {
      return "i-hugeicons-checkmark-circle-02 text-green-400";
    } else {
      return "i-hugeicons-alert-02 text-red-400";
    }
  };

  // Получить текст статуса
  const getStatusText = (meta: SnapshotMeta) => {
    if (meta.was_successful === null) {
      return "Статус неизвестен";
    } else if (meta.was_successful) {
      return "Успешный запуск";
    } else {
      return "Игра завершилась с ошибкой";
    }
  };

  const handleMaxSnapshotsChange = (value: string) => {
    const count = parseInt(value, 10);
    if (!isNaN(count) && props.onSetMaxSnapshots) {
      props.onSetMaxSnapshots(count);
      addToast({
        type: "info",
        title: "Настройки сохранены",
        message: `Теперь будет храниться до ${count} снимков`,
        duration: 2000,
      });
    }
  };

  // Найти индекс текущего выбранного снимка
  const currentIndex = createMemo(() => {
    if (!props.selectedSnapshotId) return 0;
    return snapshots().findIndex(s => s.id === props.selectedSnapshotId);
  });

  // Можно ли перейти к более новому снимку
  const canGoNewer = createMemo(() => {
    return props.selectedSnapshotId && currentIndex() > 0;
  });

  // Можно ли перейти к более старому снимку
  const canGoOlder = createMemo(() => {
    const idx = currentIndex();
    return idx < snapshots().length - 1;
  });

  const goToNewer = () => {
    const idx = currentIndex();
    if (idx > 0) {
      if (idx - 1 === 0) {
        // Navigate to latest (null = compare with current state)
        props.onNavigate?.(null);
        addToast({
          type: "info",
          title: "Текущее состояние",
          message: "Сравнение с последним снимком",
          duration: 2000,
        });
      } else {
        const newerId = snapshots()[idx - 1].id;
        props.onNavigate?.(newerId);
      }
    }
  };

  const goToOlder = () => {
    const idx = currentIndex();
    if (idx < snapshots().length - 1) {
      const olderId = snapshots()[idx + 1].id;
      props.onNavigate?.(olderId);
    }
  };

  return (
    <div class="space-y-3">
      {/* Заголовок с настройками */}
      <div class="flex items-center justify-between">
        <h4 class="text-sm font-medium text-gray-300 flex items-center gap-2">
          <i class="i-hugeicons-time-02 w-4 h-4" />
          История запусков
          <span class="text-xs text-gray-500">
            ({snapshots().length}/{maxSnapshots()})
          </span>
        </h4>
        <div class="flex items-center gap-2">
          {/* Навигация по снимкам */}
          <Show when={snapshots().length > 1}>
            <div class="flex items-center gap-1">
              <button
                class="p-1 rounded hover:bg-gray-700/50 disabled:opacity-30 disabled:cursor-not-allowed"
                onClick={goToNewer}
                disabled={!canGoNewer()}
                title="К более новому снимку"
              >
                <i class="i-hugeicons-arrow-up-01 w-4 h-4" />
              </button>
              <button
                class="p-1 rounded hover:bg-gray-700/50 disabled:opacity-30 disabled:cursor-not-allowed"
                onClick={goToOlder}
                disabled={!canGoOlder()}
                title="К более старому снимку"
              >
                <i class="i-hugeicons-arrow-down-01 w-4 h-4" />
              </button>
            </div>
          </Show>

          <Show when={props.selectedSnapshotId}>
            <button
              class="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1 px-2 py-1 rounded hover:bg-blue-500/10"
              onClick={() => {
                props.onCompareLatest();
                addToast({
                  type: "info",
                  title: "Текущее состояние",
                  message: "Сравнение с последним снимком",
                  duration: 2000,
                });
              }}
            >
              <i class="i-hugeicons-arrow-left-01 w-3 h-3" />
              К текущему
            </button>
          </Show>

          <Show when={props.onSetMaxSnapshots}>
            <button
              class={`p-1.5 rounded transition-colors ${
                showSettings() ? "bg-gray-700 text-white" : "text-gray-400 hover:text-gray-300 hover:bg-gray-700/50"
              }`}
              onClick={() => setShowSettings(!showSettings())}
              title="Настройки истории"
            >
              <i class="i-hugeicons-settings-02 w-4 h-4" />
            </button>
          </Show>
        </div>
      </div>

      {/* Настройки */}
      <Show when={showSettings() && props.onSetMaxSnapshots}>
        <div class="flex items-center gap-3 p-3 bg-gray-800/50 rounded-xl border border-gray-700/50">
          <span class="text-sm text-gray-400">Хранить снимков:</span>
          <Select
            value={String(maxSnapshots())}
            options={MAX_SNAPSHOTS_OPTIONS}
            onChange={handleMaxSnapshotsChange}
            class="w-24"
          />
          <span class="text-xs text-gray-500 flex-1">
            Старые снимки удаляются автоматически
          </span>
        </div>
      </Show>

      {/* Список снимков */}
      <Show
        when={!props.loading && snapshots().length > 0}
        fallback={
          <Show
            when={props.loading}
            fallback={
              <div class="text-center py-6 text-gray-500">
                <i class="i-hugeicons-time-02 w-8 h-8 mx-auto mb-2 opacity-50" />
                <p class="text-sm">Нет снимков</p>
                <p class="text-xs mt-1">Запустите игру чтобы создать первый снимок</p>
              </div>
            }
          >
            <div class="flex items-center justify-center gap-2 text-sm text-gray-500 py-6">
              <i class="i-svg-spinners-ring-resize w-5 h-5" />
              Загрузка...
            </div>
          </Show>
        }
      >
        <div class="space-y-1.5 max-h-64 overflow-y-auto pr-1">
          <For each={snapshots()}>
            {(meta, index) => {
              const isSelected = () => props.selectedSnapshotId === meta.id;
              const isLatest = () => index() === 0;
              const isCurrent = () => !props.selectedSnapshotId && isLatest();

              return (
                <button
                  class={`w-full flex items-center gap-3 p-3 rounded-xl text-left transition-all ${
                    isSelected() || isCurrent()
                      ? "bg-blue-600/15 border border-blue-500/30 shadow-sm"
                      : "bg-gray-800/40 hover:bg-gray-700/50 border border-transparent"
                  }`}
                  onClick={() => {
                    if (isCurrent()) return;
                    if (isLatest()) {
                      props.onCompareLatest();
                    } else {
                      props.onSelectSnapshot(meta.id);
                      addToast({
                        type: "info",
                        title: "Снимок выбран",
                        message: `Сравнение с состоянием от ${formatDate(meta.created_at)}`,
                        duration: 2000,
                      });
                    }
                  }}
                >
                  {/* Статус иконка */}
                  <div class="flex-shrink-0" title={getStatusText(meta)}>
                    <i class={`${getStatusIcon(meta)} w-5 h-5`} />
                  </div>

                  {/* Информация */}
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 flex-wrap">
                      <span class="text-sm text-gray-200">
                        {formatDate(meta.created_at)}
                      </span>
                      <Show when={isLatest()}>
                        <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-600/30 text-blue-400 font-medium">
                          Последний
                        </span>
                      </Show>
                      <Show when={meta.backup_id}>
                        <span
                          class="text-[10px] px-1.5 py-0.5 rounded-full bg-green-600/30 text-green-400 flex items-center gap-1"
                          title="Связан с бэкапом"
                        >
                          <i class="i-hugeicons-archive w-3 h-3" />
                          Бэкап
                        </span>
                      </Show>
                    </div>
                    <div class="text-xs text-gray-500 mt-0.5">
                      {meta.mods_count} модов · {meta.configs_count} конфигов · {meta.files_count} файлов
                    </div>
                  </div>

                  {/* Индикатор выбора */}
                  <Show when={isSelected() || isCurrent()}>
                    <i class="i-hugeicons-checkmark-circle-02 w-5 h-5 text-blue-400 flex-shrink-0" />
                  </Show>
                </button>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
};

export default SnapshotHistory;
