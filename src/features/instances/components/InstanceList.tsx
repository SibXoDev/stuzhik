import { For, Show, createSignal, createMemo, createEffect, on, onMount, onCleanup } from "solid-js";
import type { Component } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import type { Instance } from "../../../shared/types";
import { useI18n } from "../../../shared/i18n";
import { DELETE_CONFIRM_TIMEOUT_MS } from "../../../shared/constants";
import GameSettingsDialog from "./GameSettingsDialog";
import { IntegrityChecker } from "../../../shared/components/IntegrityChecker";
import { StzhkExportDialog } from "../../modpacks/components/StzhkExportDialog";
import { LoaderIcon } from "../../../shared/components/LoaderSelector";
import InstanceDetail, { type Tab } from "./InstanceDetail";
import { Tooltip } from "../../../shared/ui/Tooltip";
import { useSafeTimers } from "../../../shared/hooks";
import { useDragDrop, registerDropHandler, type DroppedFile } from "../../../shared/stores/dragDrop";
import { addToast } from "../../../shared/components/Toast";

interface Props {
  instances: Instance[];
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  onDelete: (id: string) => void;
  onRepair: (id: string) => void;
  onConfigure: (instance: Instance) => void;
  onCreateClick?: () => void;
  onModpackClick?: () => void;
  onImportServer?: () => void;
  onImportLauncher?: () => void;
  onRefresh?: () => void;
  onDetailViewChange?: (viewing: boolean) => void;
}

const InstanceList: Component<Props> = (props) => {
  const { t } = useI18n();
  const { setTimeout: safeTimeout } = useSafeTimers();
  const { isDragging, draggedFiles, dragPosition, isInDetailView, setIsInDetailView } = useDragDrop();
  const [detailInstance, setDetailInstance] = createSignal<Instance | null>(null);
  const [detailInitialTab, setDetailInitialTab] = createSignal<Tab>("mods");
  const [showGameSettings, setShowGameSettings] = createSignal(false);
  const [gameSettingsInstance, setGameSettingsInstance] = createSignal<Instance | null>(null);
  const [confirmDelete, setConfirmDelete] = createSignal<string | null>(null);
  const [openMenuId, setOpenMenuId] = createSignal<string | null>(null);
  const [menuPosition, setMenuPosition] = createSignal<{ top: number; left: number; maxHeight?: number } | null>(null);
  let menuRef: HTMLDivElement | undefined;
  const [showIntegrityChecker, setShowIntegrityChecker] = createSignal(false);
  const [integrityInstance, setIntegrityInstance] = createSignal<Instance | null>(null);
  const [showStzhkExport, setShowStzhkExport] = createSignal(false);
  const [stzhkExportInstance, setStzhkExportInstance] = createSignal<Instance | null>(null);

  // Drag & drop: track which instance is being hovered for mod drops
  const [dragHoveredInstance, setDragHoveredInstance] = createSignal<string | null>(null);
  // Store last hovered instance for drop handler (survives reactivity clearing)
  let lastHoveredInstanceId: string | null = null;

  // Check if dragged files are all .jar mods
  const isDraggingMods = createMemo(() => {
    const files = draggedFiles();
    return isDragging() && files.length > 0 && files.every(f => f.extension === "jar");
  });

  // Check if instance can accept mods (has a mod loader, not vanilla)
  const canAcceptMods = (instance: Instance): boolean => {
    const loader = instance.loader?.toLowerCase();
    // Only instances with mod loaders can accept mods
    return !!loader && loader !== "vanilla" && loader !== "";
  };

  // Batch install result type
  interface BatchModInstallResult {
    file_name: string;
    success: boolean;
    mod_name: string | null;
    error: string | null;
    source: string;
    verified: boolean;
  }

  // Install mods to a specific instance (batch API for efficiency)
  const installModsToInstance = async (instanceId: string, files: DroppedFile[]) => {
    const jarFiles = files.filter(f => f.extension === "jar");
    if (jarFiles.length === 0) return;

    const instance = props.instances.find(i => i.id === instanceId);
    if (!instance) return;

    // Check if instance can accept mods
    if (!canAcceptMods(instance)) {
      addToast({
        type: "error",
        title: "Невозможно установить мод",
        message: `${instance.name} не поддерживает моды (нужен Fabric, Forge или другой загрузчик)`,
        duration: 5000,
      });
      return;
    }

    // Use batch install API for efficiency (1 request for N mods)
    try {
      const filePaths = jarFiles.map(f => f.path);
      const results = await invoke<BatchModInstallResult[]>("install_mods_local_batch", {
        instanceId,
        filePaths,
      });

      // Count successes and failures
      const successes = results.filter(r => r.success);
      const failures = results.filter(r => !r.success);
      const verified = results.filter(r => r.verified);

      // Show summary toast
      if (successes.length > 0) {
        const verifiedMsg = verified.length > 0 ? ` (${verified.length} верифицировано)` : "";
        addToast({
          type: "success",
          title: `Установлено ${successes.length} модов${verifiedMsg}`,
          message: `→ ${instance.name}`,
          duration: 3000,
        });
      }

      // Show individual errors
      for (const failure of failures) {
        const errorMsg = failure.error || "Неизвестная ошибка";
        addToast({
          type: errorMsg.includes("уже установлен") ? "warning" : "error",
          title: errorMsg.includes("уже установлен") ? "Мод уже установлен" : "Ошибка установки",
          message: `${failure.file_name}: ${errorMsg}`,
          duration: errorMsg.includes("уже установлен") ? 3000 : 5000,
        });
      }
    } catch (e: unknown) {
      if (import.meta.env.DEV) {
        console.error("Failed to batch install mods:", e);
      }
      const errorMessage = e instanceof Error
        ? e.message
        : (e && typeof e === "object" && "details" in e)
          ? String((e as { details: unknown }).details)
          : "Неизвестная ошибка";
      addToast({
        type: "error",
        title: "Ошибка пакетной установки",
        message: errorMessage,
        duration: 5000,
      });
    }
  };

  // Map to track instance card bounding boxes for drag detection
  const instanceCardRefs = new Map<string, HTMLDivElement>();

  // Register instance cards for drop detection
  const registerInstanceCard = (id: string, el: HTMLDivElement) => {
    instanceCardRefs.set(id, el);
  };

  // Find instance card at position (only if actually visible - not covered by other UI)
  const findInstanceAtPosition = (x: number, y: number): string | null => {
    // Use elementFromPoint to find what's actually visible at cursor position
    const elementAtPoint = document.elementFromPoint(x, y);
    if (!elementAtPoint) return null;

    // Check if this element or any of its parents is a registered instance card
    for (const [id, cardEl] of instanceCardRefs) {
      if (cardEl.contains(elementAtPoint)) {
        return id;
      }
    }
    return null;
  };

  // Update hovered instance based on drag position from store
  createEffect(() => {
    const dragging = isDraggingMods();
    const position = dragPosition();

    if (!dragging) {
      setDragHoveredInstance(null);
      // Don't clear lastHoveredInstanceId - we need it for drop handler
      return;
    }

    if (position) {
      const instanceId = findInstanceAtPosition(position.x, position.y);
      setDragHoveredInstance(instanceId);
      // Store for drop handler - also clear when not over any instance
      lastHoveredInstanceId = instanceId;
    }
  });

  // Notify parent when detail view changes and update drag-drop context
  createEffect(on(detailInstance, (instance) => {
    const isInDetail = instance !== null;
    props.onDetailViewChange?.(isInDetail);
    setIsInDetailView(isInDetail);
  }));

  // Sync detailInstance with props.instances when status changes
  createEffect(() => {
    // Explicitly track props.instances by accessing the array
    const instances = props.instances;
    const current = detailInstance();
    if (current && instances.length > 0) {
      const updated = instances.find(i => i.id === current.id);
      if (updated && updated.status !== current.status) {
        setDetailInstance({ ...updated });
      }
    }
  });

  // Register drop handler for mods on instance cards (only in list view, not detail view)
  onMount(() => {
    const cleanupDropHandler = registerDropHandler({
      accept: (files) => {
        // Only accept .jar files when NOT in detail view and hovering an instance
        if (isInDetailView()) return false;
        if (!lastHoveredInstanceId) return false;
        return files.some(f => f.extension === "jar");
      },
      onDrop: async (files) => {
        const instanceId = lastHoveredInstanceId;
        if (!instanceId) return;

        const jarFiles = files.filter(f => f.extension === "jar");
        await installModsToInstance(instanceId, jarFiles);

        // Clear state
        lastHoveredInstanceId = null;
        setDragHoveredInstance(null);
      },
      priority: 15, // Higher than ModsList (10) to catch drops on instance cards
    });

    onCleanup(cleanupDropHandler);
  });

  // Event listener for log analyzer
  let unlistenOpenLogAnalyzer: UnlistenFn | undefined;

  onMount(async () => {
    unlistenOpenLogAnalyzer = await listen<{ instanceId: string }>("open-log-analyzer", (event) => {
      const instanceId = event.payload.instanceId;
      const instance = props.instances.find(i => i.id === instanceId);
      if (instance) {
        setDetailInitialTab("logs");
        setDetailInstance(instance);
      }
    });
  });

  onCleanup(() => {
    unlistenOpenLogAnalyzer?.();
  });

  // Check if both client and server types exist (show badges only when both exist)
  const hasBothTypes = createMemo(() => {
    if (!props.instances || !Array.isArray(props.instances)) return false;
    const types = new Set(props.instances.filter(i => i != null).map(i => i.instance_type));
    return types.has("client") && types.has("server");
  });

  // Сортировка: запущенные/устанавливающиеся сверху, потом по дате создания
  const sortedInstances = createMemo(() => {
    // Guard against undefined/null instances array
    if (!props.instances || !Array.isArray(props.instances)) {
      return [];
    }
    return [...props.instances].filter(i => i != null && i.status != null).sort((a, b) => {
      // Приоритетные статусы всегда сверху
      const priorityStatuses = ["running", "starting", "installing"];
      const aIsPriority = priorityStatuses.includes(a.status);
      const bIsPriority = priorityStatuses.includes(b.status);

      if (aIsPriority && !bIsPriority) return -1;
      if (bIsPriority && !aIsPriority) return 1;

      // Между приоритетными: running > starting > installing
      if (aIsPriority && bIsPriority) {
        const aIndex = priorityStatuses.indexOf(a.status);
        const bIndex = priorityStatuses.indexOf(b.status);
        if (aIndex !== bIndex) return aIndex - bIndex;
      }

      // Сортировка по дате создания (новые сверху)
      // Используем created_at как основной критерий для консистентности
      const aCreated = new Date(a.created_at).getTime();
      const bCreated = new Date(b.created_at).getTime();

      // Если есть last_played, используем более позднюю дату
      const aDate = a.last_played
        ? Math.max(new Date(a.last_played).getTime(), aCreated)
        : aCreated;
      const bDate = b.last_played
        ? Math.max(new Date(b.last_played).getTime(), bCreated)
        : bCreated;

      return bDate - aDate; // Новые сверху
    });
  });

  // Закрывать меню при изменении статуса экземпляров (чтобы не висело бесконечно)
  createEffect(on(
    () => {
      if (!props.instances || !Array.isArray(props.instances)) return '';
      return props.instances.filter(i => i != null && i.status != null).map(i => `${i.id}:${i.status}`).join(',');
    },
    () => {
      // Закрываем меню только если оно открыто
      if (openMenuId()) {
        setOpenMenuId(null);
        setMenuPosition(null);
      }
    },
    { defer: true } // Не срабатывать при первом рендере
  ));

  const handleOpenMods = (instance: Instance) => {
    setDetailInitialTab("mods");
    setDetailInstance(instance);
    setOpenMenuId(null);
    setMenuPosition(null);
  };

  // Open instance detail with appropriate default tab
  const openInstanceDetail = (instance: Instance, tab?: Tab) => {
    const defaultTab = tab || (instance.instance_type === "server" ? "console" : "mods");
    setDetailInitialTab(defaultTab);
    setDetailInstance(instance);
  };

  const handleOpenFolder = async (instance: Instance) => {
    try {
      await invoke("open_instance_folder", { id: instance.id });
    } catch (e) {
      console.error("Failed to open folder:", e);
    }
    setOpenMenuId(null);
    setMenuPosition(null);
  };

  const handleDelete = (id: string) => {
    if (confirmDelete() === id) {
      props.onDelete(id);
      setConfirmDelete(null);
      setOpenMenuId(null);
      setMenuPosition(null);
    } else {
      setConfirmDelete(id);
      safeTimeout(() => setConfirmDelete(null), DELETE_CONFIRM_TIMEOUT_MS);
    }
  };

  const toggleMenu = (id: string, event: MouseEvent) => {
    if (openMenuId() === id) {
      setOpenMenuId(null);
      setMenuPosition(null);
    } else {
      const button = event.currentTarget as HTMLElement;
      const rect = button.getBoundingClientRect();
      const menuWidth = 220;
      const menuHeight = 500; // 11 кнопок × 40px + 3 разделителя × 17px + padding
      const padding = 12; // Отступ от краёв viewport
      const titleBarHeight = 40; // Высота TitleBar - меню не должно заходить за него

      // Вычисляем горизонтальную позицию (по правому краю кнопки)
      let left = rect.right - menuWidth;

      // Если меню выходит за правый край
      if (left + menuWidth > window.innerWidth - padding) {
        left = window.innerWidth - menuWidth - padding;
      }

      // Если меню выходит за левый край
      if (left < padding) {
        left = padding;
      }

      // Вычисляем вертикальную позицию и максимальную высоту
      // ВАЖНО: учитываем TitleBar при расчёте пространства сверху
      let top: number;
      let maxHeight: number | undefined;

      const spaceBelow = window.innerHeight - rect.bottom - padding;
      const spaceAbove = rect.top - titleBarHeight - padding; // Минус высота TitleBar

      // Пробуем открыть вниз (предпочтительно)
      if (spaceBelow >= menuHeight) {
        // Достаточно места внизу - открываем вниз
        top = rect.bottom + 8;
        // Убедимся что не выходит за нижний край
        if (top + menuHeight > window.innerHeight - padding) {
          maxHeight = window.innerHeight - top - padding;
        }
      } else if (spaceAbove >= menuHeight) {
        // Внизу не влезает, но вверх влезает - открываем вверх
        top = rect.top - menuHeight - 8;
      } else {
        // Ни вниз, ни вверх полностью не влезает
        // Выбираем направление с большим пространством
        if (spaceBelow > spaceAbove) {
          // Открываем вниз с ограничением по высоте
          top = rect.bottom + 8;
          maxHeight = spaceBelow - 16; // Запас для отступов
        } else {
          // Открываем вверх с ограничением по высоте
          maxHeight = spaceAbove - 16;
          top = rect.top - maxHeight - 8;
          // Убедимся что меню не заходит за TitleBar
          if (top < titleBarHeight + padding) {
            top = titleBarHeight + padding;
          }
        }
      }

      setMenuPosition({ top, left, maxHeight });
      setOpenMenuId(id);
    }
  };

  // Reposition menu after render if it goes beyond viewport
  let rafId: number | undefined;
  onCleanup(() => {
    if (rafId !== undefined) cancelAnimationFrame(rafId);
  });

  createEffect(() => {
    const pos = menuPosition();
    if (!pos || !menuRef) return;

    // Use requestAnimationFrame to ensure DOM is updated
    rafId = requestAnimationFrame(() => {
      if (!menuRef) return;
      const menuRect = menuRef.getBoundingClientRect();
      const titleBarHeight = 40;
      const padding = 12;

      let needsUpdate = false;
      let newTop = pos.top;
      let newMaxHeight = pos.maxHeight;

      // Check if menu goes below viewport
      if (menuRect.bottom > window.innerHeight - padding) {
        newMaxHeight = window.innerHeight - pos.top - padding;
        needsUpdate = true;
      }

      // Check if menu goes above TitleBar
      if (menuRect.top < titleBarHeight + padding) {
        newTop = titleBarHeight + padding;
        needsUpdate = true;
      }

      if (needsUpdate) {
        setMenuPosition({ ...pos, top: newTop, maxHeight: newMaxHeight });
      }
    });
  });

  // Close menu when clicking outside
  const handleClickOutside = () => {
    setOpenMenuId(null);
    setMenuPosition(null);
  };

  const getStatusText = (status: string) => {
    switch (status) {
      case "running":
        return t().instances.status.running;
      case "starting":
        return t().instances.status.starting;
      case "stopping":
        return t().instances.status.stopping;
      case "error":
        return t().instances.status.error;
      case "installing":
        return t().instances.status.installing;
      default:
        return t().instances.status.stopped;
    }
  };

  return (
    <div class="flex flex-col flex-1 min-h-0">
      {/* Instance Detail View */}
      <Show when={detailInstance()}>
        <InstanceDetail
          instance={detailInstance()!}
          initialTab={detailInitialTab()}
          onBack={() => setDetailInstance(null)}
          onStart={props.onStart}
          onStop={props.onStop}
          onDelete={(id) => {
            props.onDelete(id);
            setDetailInstance(null);
          }}
          onRepair={props.onRepair}
          onConfigure={props.onConfigure}
          onRefresh={() => {
            props.onRefresh?.();
            // Update detail instance with fresh data
            const updated = props.instances.find(i => i.id === detailInstance()?.id);
            if (updated) {
              setDetailInstance(updated);
            }
          }}
        />
      </Show>

      {/* Main List - scrollable when not in detail view */}
      <Show when={!detailInstance()}>
        <div class="flex flex-col flex-1 min-h-0 overflow-y-auto">
        <Show when={props.instances.length === 0}>
          {/* Empty state - centered in available space */}
          <div class="flex flex-col items-center justify-center text-center">
            <img src="/logo.png" alt="Stuzhik" class="w-24 h-24 rounded-2xl" />
            <h3 class="text-xl font-semibold mb-2 text-gray-200">{t().instances.emptyTitle}</h3>
            <p class="text-sm text-gray-500 max-w-sm mb-6">
              {t().instances.emptyDescription}
            </p>
            <div class="flex flex-col items-center gap-3">
              <div class="flex items-center gap-3">
                <button class="btn-primary" onClick={() => props.onCreateClick?.()}>
                  <i class="i-hugeicons-add-01 w-4 h-4" />
                  {t().instances.create}
                </button>
                <span class="text-gray-600">{t().common.or}</span>
                <button class="btn-secondary" onClick={() => props.onModpackClick?.()}>
                  <i class="i-hugeicons-package w-4 h-4" />
                  {t().modpacks.install}
                </button>
              </div>
              <div class="flex items-center gap-4">
                <Show when={props.onImportLauncher}>
                  <button
                    class="text-xs text-gray-500 hover:text-gray-300 transition-colors flex items-center gap-1"
                    onClick={() => props.onImportLauncher?.()}
                  >
                    <i class="i-hugeicons-folder-sync w-3 h-3" />
                    {t().launchers?.importFromLauncher ?? "Импорт из лаунчера"}
                  </button>
                </Show>
                <Show when={props.onImportServer}>
                  <button
                    class="text-xs text-gray-500 hover:text-gray-300 transition-colors flex items-center gap-1"
                    onClick={() => props.onImportServer?.()}
                  >
                    <i class="i-hugeicons-upload-02 w-3 h-3" />
                    {t().launchers?.importServer ?? "Импорт сервера"}
                  </button>
                </Show>
              </div>
            </div>
          </div>
        </Show>

        {/* Instance List Header */}
        <Show when={props.instances.length > 0}>
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-xs font-medium text-gray-500 uppercase tracking-wider">
              {t().instances.title} · {props.instances.length}
            </h3>
            <div class="flex items-center gap-3">
              <Show when={props.onImportLauncher}>
                <button
                  class="text-xs text-gray-500 hover:text-gray-300 transition-colors flex items-center gap-1"
                  onClick={() => props.onImportLauncher?.()}
                >
                  <i class="i-hugeicons-folder-sync w-3 h-3" />
                  {t().launchers?.importFromLauncher ?? "Импорт"}
                </button>
              </Show>
              <Show when={props.onImportServer}>
                <button
                  class="text-xs text-gray-500 hover:text-gray-300 transition-colors flex items-center gap-1"
                  onClick={() => props.onImportServer?.()}
                >
                  <i class="i-hugeicons-upload-02 w-3 h-3" />
                  {t().launchers?.importServer ?? "Сервер"}
                </button>
              </Show>
            </div>
          </div>
        </Show>

        <div class="grid grid-cols-1 gap-3">
          <For each={sortedInstances()}>
            {(instance) => {
              const acceptsMods = canAcceptMods(instance);
              const isHovered = () => dragHoveredInstance() === instance.id;

              // Determine card classes based on drag state and loader support
              const cardClasses = () => {
                if (!isDraggingMods()) {
                  return "card-hover";
                }

                if (acceptsMods) {
                  if (isHovered()) {
                    // Active drop target - solid blue border
                    return "bg-[var(--color-bg-card)] rounded-xl p-4 border border-blue-500";
                  }
                  // Valid drop target - dashed blue border
                  return "bg-[var(--color-bg-card)] rounded-xl p-4 border border-dashed border-blue-500/50";
                }

                // Invalid drop target (vanilla) - dashed gray border
                return "bg-[var(--color-bg-card)] rounded-xl p-4 border border-dashed border-gray-600/50 opacity-50";
              };

              return (
              <div
                ref={(el) => registerInstanceCard(instance.id, el)}
                class={`group cursor-pointer transition-all duration-150 ${cardClasses()}`}
                onClick={() => openInstanceDetail(instance)}
              >
                {/* Drop zone indicator overlay for valid targets */}
                <Show when={isDraggingMods() && isHovered() && acceptsMods}>
                  <div class="absolute inset-0 flex items-center justify-center bg-blue-500/10 rounded-xl pointer-events-none z-10">
                    <div class="flex items-center gap-2 px-4 py-2 bg-blue-600 rounded-full text-white text-sm font-medium shadow-lg animate-pulse">
                      <i class="i-hugeicons-download-02 w-4 h-4" />
                      <span>Отпустите для установки</span>
                    </div>
                  </div>
                </Show>

                {/* Drop zone indicator overlay for invalid targets */}
                <Show when={isDraggingMods() && isHovered() && !acceptsMods}>
                  <div class="absolute inset-0 flex items-center justify-center bg-red-500/10 rounded-xl pointer-events-none z-10">
                    <div class="flex items-center gap-2 px-4 py-2 bg-red-600/80 rounded-full text-white text-sm font-medium shadow-lg">
                      <i class="i-hugeicons-cancel-01 w-4 h-4" />
                      <span>Нужен загрузчик модов</span>
                    </div>
                  </div>
                </Show>

                <div class="flex items-center gap-4">
                  {/* Loader Icon */}
                  <div class="w-12 h-12 rounded-2xl bg-black/30 flex-center flex-shrink-0 border border-gray-700/50">
                    <LoaderIcon loader={instance.loader} class="w-7 h-7" />
                  </div>

                  {/* Info */}
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-3 mb-1">
                      <h3 class="text-base font-medium truncate text-gray-100">
                        {instance.name}
                      </h3>
                      {/* Instance Type Badge - only show when both types exist */}
                      <Show when={hasBothTypes()}>
                        <span
                          class={`px-2 py-0.5 text-xs rounded-full flex-shrink-0 ${
                            instance.instance_type === "server"
                              ? "bg-purple-500/15 text-purple-400 border border-purple-500/30"
                              : "bg-blue-500/15 text-blue-400 border border-blue-500/30"
                          }`}
                        >
                          {instance.instance_type === "server" ? "Server" : "Client"}
                        </span>
                      </Show>
                      {/* Status Indicator */}
                      <Show when={instance.status !== "stopped"}>
                        <Show
                          when={instance.status === "error" && instance.installation_error}
                          fallback={
                            <span
                              class={`px-2 py-0.5 text-xs rounded-full ${
                                instance.status === "running"
                                  ? "bg-emerald-500/10 text-emerald-400"
                                  : instance.status === "starting"
                                    ? "bg-yellow-500/10 text-yellow-400"
                                    : instance.status === "installing"
                                      ? "bg-blue-500/10 text-blue-400"
                                      : instance.status === "error"
                                        ? "bg-red-500/10 text-red-400"
                                        : "bg-gray-500/10 text-gray-400"
                              }`}
                            >
                              {getStatusText(instance.status)}
                            </span>
                          }
                        >
                          <Tooltip
                            text={instance.installation_error || t().instances.status.error}
                            position="bottom"
                            delay={100}
                          >
                            <span class="px-2 py-0.5 text-xs rounded-full bg-red-500/10 text-red-400 cursor-help flex items-center gap-1">
                              <i class="i-hugeicons-alert-02 w-3 h-3" />
                              {getStatusText(instance.status)}
                            </span>
                          </Tooltip>
                        </Show>
                      </Show>
                    </div>
                    <div class="flex items-center gap-2 text-xs text-gray-500">
                      <span>{instance.version}</span>
                      <span class="w-1 h-1 rounded-full bg-gray-700" />
                      <span class="capitalize">{instance.loader || "vanilla"}</span>
                      <Show when={instance.last_played}>
                        <span class="w-1 h-1 rounded-full bg-gray-700" />
                        <span>{new Date(instance.last_played!).toLocaleDateString("ru-RU")}</span>
                      </Show>
                      <Show when={instance.total_playtime > 0}>
                        <span class="w-1 h-1 rounded-full bg-gray-700" />
                        <span>
                          {Math.floor(instance.total_playtime / 3600)}ч{" "}
                          {Math.floor((instance.total_playtime % 3600) / 60)}м
                        </span>
                      </Show>
                    </div>
                  </div>

                  {/* Actions */}
                  <div class="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    {/* Primary Action Button */}
                    <Show
                      when={instance.status === "running"}
                      fallback={
                        <button
                          class="px-4 py-2 text-sm font-medium rounded-2xl bg-white/10 hover:bg-white/15 text-white transition-colors disabled:opacity-50"
                          onClick={(e) => {
                            e.stopPropagation();
                            props.onStart(instance.id);
                          }}
                          disabled={
                            instance.status === "starting" ||
                            instance.status === "installing"
                          }
                        >
                          <Show
                            when={instance.status === "starting"}
                            fallback={
                              <span class="flex items-center gap-2">
                                <i class="i-hugeicons-play w-3.5 h-3.5" />
                                Играть
                              </span>
                            }
                          >
                            <span class="flex items-center gap-2">
                              <i class="i-svg-spinners-6-dots-scale w-3.5 h-3.5" />
                              Запуск
                            </span>
                          </Show>
                        </button>
                      }
                    >
                      <button
                        class="px-4 py-2 text-sm font-medium rounded-2xl bg-red-500/10 hover:bg-red-500/20 text-red-400 transition-colors"
                        onClick={(e) => {
                          e.stopPropagation();
                          props.onStop(instance.id);
                        }}
                        disabled={instance.status === "stopping"}
                      >
                        <Show
                          when={instance.status === "stopping"}
                          fallback={
                            <span class="flex items-center gap-2">
                              <i class="i-hugeicons-stop w-3.5 h-3.5" />
                              Стоп
                            </span>
                          }
                        >
                          <span class="flex items-center gap-2">
                            <i class="i-svg-spinners-6-dots-scale w-3.5 h-3.5" />
                            ...
                          </span>
                        </Show>
                      </button>
                    </Show>

                    {/* More Actions Menu Button */}
                    <button
                      class="p-2 rounded-2xl hover:bg-white/10 text-gray-400 hover:text-white transition-colors"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleMenu(instance.id, e);
                      }}
                      title={t().instances.moreActions}
                    >
                      <i class="i-hugeicons-more-horizontal w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
              );
            }}
          </For>
        </div>
        </div>

        {/* Context Menu Portal - рендерится отдельно с fixed позиционированием */}
        <Show when={openMenuId() && menuPosition()}>
          {(() => {
            const instance = props.instances.find(i => i.id === openMenuId());
            if (!instance) return null;
            const pos = menuPosition()!;
            return (
              <>
                {/* Backdrop для закрытия */}
                <div
                  class="fixed inset-0 z-40"
                  onClick={handleClickOutside}
                />
                {/* Само меню */}
                <div
                  ref={menuRef}
                  class={`fixed z-50 bg-[--color-bg-elevated] border border-[--color-border] rounded-xl shadow-xl p-2 w-[220px] animate-scale-in ${pos.maxHeight ? 'overflow-y-auto' : 'overflow-hidden'}`}
                  style={{
                    top: `${pos.top}px`,
                    left: `${pos.left}px`,
                    ...(pos.maxHeight ? { "max-height": `${pos.maxHeight}px` } : {})
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    class="dropdown-item"
                    onClick={() => handleOpenMods(instance)}
                  >
                    <i class="i-hugeicons-package w-4 h-4" />
                    {t().mods.title}
                  </button>

                  {/* Game Settings - only for clients */}
                  <Show when={instance.instance_type !== "server"}>
                    <button
                      class="dropdown-item"
                      onClick={() => {
                        setGameSettingsInstance(instance);
                        setShowGameSettings(true);
                        setOpenMenuId(null);
                        setMenuPosition(null);
                      }}
                    >
                      <i class="i-hugeicons-game-controller-03 w-4 h-4" />
                      {t().instances.gameSettings}
                    </button>
                  </Show>

                  {/* Server Console - only for servers */}
                  <Show when={instance.instance_type === "server"}>
                    <button
                      class="dropdown-item"
                      onClick={() => {
                        openInstanceDetail(instance, "console");
                        setOpenMenuId(null);
                        setMenuPosition(null);
                      }}
                    >
                      <i class="i-hugeicons-computer-terminal-01 w-4 h-4" />
                      {t().instances.console}
                    </button>
                    <button
                      class="dropdown-item"
                      onClick={() => {
                        openInstanceDetail(instance, "settings");
                        setOpenMenuId(null);
                        setMenuPosition(null);
                      }}
                    >
                      <i class="i-hugeicons-settings-02 w-4 h-4" />
                      {t().instances.serverSettings}
                    </button>
                  </Show>

                  <div class="dropdown-divider" />

                  <button
                    class="dropdown-item"
                    onClick={() => {
                      setDetailInitialTab("logs");
                      setDetailInstance(instance);
                      setOpenMenuId(null);
                      setMenuPosition(null);
                    }}
                  >
                    <i class="i-hugeicons-file-view w-4 h-4" />
                    {t().instances.analyzeLogs}
                  </button>

                  <button
                    class="dropdown-item"
                    onClick={() => {
                      setIntegrityInstance(instance);
                      setShowIntegrityChecker(true);
                      setOpenMenuId(null);
                      setMenuPosition(null);
                    }}
                  >
                    <i class="i-hugeicons-checkmark-circle-02 w-4 h-4" />
                    {t().instances.checkIntegrity}
                  </button>

                  <button
                    class="dropdown-item"
                    onClick={() => {
                      setStzhkExportInstance(instance);
                      setShowStzhkExport(true);
                      setOpenMenuId(null);
                      setMenuPosition(null);
                    }}
                  >
                    <i class="i-hugeicons-share-01 w-4 h-4" />
                    {t().instances.exportStzhk}
                  </button>

                  <div class="dropdown-divider" />

                  <button
                    class="dropdown-item"
                    onClick={() => handleOpenFolder(instance)}
                  >
                    <i class="i-hugeicons-folder-01 w-4 h-4" />
                    {t().instances.openFolder}
                  </button>

                  <button
                    class="dropdown-item"
                    onClick={() => {
                      props.onConfigure(instance);
                      setOpenMenuId(null);
                      setMenuPosition(null);
                    }}
                  >
                    <i class="i-hugeicons-settings-02 w-4 h-4" />
                    {t().common.edit}
                  </button>

                  <button
                    class="dropdown-item"
                    onClick={() => {
                      props.onRepair(instance.id);
                      setOpenMenuId(null);
                      setMenuPosition(null);
                    }}
                    disabled={
                      instance.status === "running" ||
                      instance.status === "starting"
                    }
                  >
                    <i class="i-hugeicons-wrench-01 w-4 h-4" />
                    {t().instances.repair}
                  </button>

                  <button
                    class="dropdown-item"
                    onClick={() => {
                      setDetailInitialTab("backups");
                      setDetailInstance(instance);
                      setOpenMenuId(null);
                      setMenuPosition(null);
                    }}
                  >
                    <i class="i-hugeicons-floppy-disk w-4 h-4" />
                    {t().backup.title}
                  </button>

                  <button
                    class="dropdown-item"
                    onClick={() => {
                      setDetailInitialTab("patches");
                      setDetailInstance(instance);
                      setOpenMenuId(null);
                      setMenuPosition(null);
                    }}
                  >
                    <i class="i-hugeicons-git-compare w-4 h-4" />
                    {t().patches?.title || "Патчи"}
                  </button>

                  <button
                    class="dropdown-item"
                    onClick={() => {
                      setDetailInitialTab("performance");
                      setDetailInstance(instance);
                      setOpenMenuId(null);
                      setMenuPosition(null);
                    }}
                  >
                    <i class="i-hugeicons-activity-01 w-4 h-4" />
                    {t().performance?.title || "Производительность"}
                  </button>

                  <div class="dropdown-divider" />

                  <button
                    class="dropdown-item"
                    data-danger="true"
                    onClick={() => handleDelete(instance.id)}
                    disabled={instance.status === "running"}
                  >
                    <i class="i-hugeicons-delete-02 w-4 h-4" />
                    {confirmDelete() === instance.id
                      ? t().instances.confirmDelete
                      : t().common.delete}
                  </button>
                </div>
              </>
            );
          })()}
        </Show>
      </Show>

      {/* Game Settings Dialog */}
      <Show when={showGameSettings() && gameSettingsInstance()}>
        <GameSettingsDialog
          instanceId={gameSettingsInstance()!.id}
          instanceName={gameSettingsInstance()!.name}
          onClose={() => {
            setShowGameSettings(false);
            setGameSettingsInstance(null);
          }}
        />
      </Show>

      {/* Integrity Checker Dialog */}
      <Show when={showIntegrityChecker() && integrityInstance()}>
        <div
          class="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 flex items-center justify-center p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              (e.currentTarget as HTMLElement).dataset.mouseDownOnBackdrop = "true";
            }
          }}
          onMouseUp={(e) => {
            const target = e.currentTarget as HTMLElement;
            if (e.target === e.currentTarget && target.dataset.mouseDownOnBackdrop === "true") {
              setShowIntegrityChecker(false);
              setIntegrityInstance(null);
            }
            delete target.dataset.mouseDownOnBackdrop;
          }}
        >
          <div class="card max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-100">
            <div class="flex items-center justify-between mb-4 flex-shrink-0">
              <div>
                <h2 class="text-xl font-bold">Проверка целостности</h2>
                <p class="text-sm text-muted">{integrityInstance()!.name}</p>
              </div>
              <button
                class="btn-close"
                onClick={() => {
                  setShowIntegrityChecker(false);
                  setIntegrityInstance(null);
                }}
                aria-label={t().ui?.tooltips?.close ?? "Close"}
              >
                <i class="i-hugeicons-cancel-01 w-5 h-5" />
              </button>
            </div>
            <div class="flex-1 overflow-y-auto -mx-4 px-4">
              <IntegrityChecker
                instanceId={integrityInstance()!.id}
                onClose={() => {
                  setShowIntegrityChecker(false);
                  setIntegrityInstance(null);
                }}
              />
            </div>
          </div>
        </div>
      </Show>

      {/* STZHK Export Dialog */}
      <Show when={showStzhkExport() && stzhkExportInstance()}>
        <StzhkExportDialog
          instanceId={stzhkExportInstance()!.id}
          instanceName={stzhkExportInstance()!.name}
          onClose={() => {
            setShowStzhkExport(false);
            setStzhkExportInstance(null);
          }}
        />
      </Show>

    </div>
  );
};

export default InstanceList;