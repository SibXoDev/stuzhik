import { For, Show, createSignal, createMemo, createEffect, on, onMount, onCleanup } from "solid-js";
import type { Component } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { Instance } from "../../../shared/types";
import { useI18n } from "../../../shared/i18n";
import { DELETE_CONFIRM_TIMEOUT_MS } from "../../../shared/constants";
import { getViewMode, setViewMode } from "../../../shared/stores/uiPreferences";
import { ViewModeSwitch } from "../../../shared/ui";
import GameSettingsDialog from "./GameSettingsDialog";
import { IntegrityChecker } from "../../../shared/components/IntegrityChecker";
import { StzhkExportDialog } from "../../modpacks/components/StzhkExportDialog";
import ConvertToServerDialog from "./ConvertToServerDialog";
import InstanceDetail, { type Tab } from "./InstanceDetail";
import { InstanceCard } from "./InstanceCard";
import { InstanceContextMenu } from "./InstanceContextMenu";
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
  const { t, language } = useI18n();
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
  const [showConvertToServer, setShowConvertToServer] = createSignal(false);
  const [convertInstance, setConvertInstance] = createSignal<Instance | null>(null);
  const [menuMode, setMenuMode] = createSignal<"primary" | "advanced">("primary");

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
        title: t().instances.cannotInstallMod,
        message: t().instances.noModLoaderMessage.replace("{name}", instance.name),
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
        const verifiedMsg = verified.length > 0 ? ` (${t().instances.modsVerified.replace("{count}", String(verified.length))})` : "";
        addToast({
          type: "success",
          title: t().instances.modsInstalled.replace("{count}", String(successes.length)) + verifiedMsg,
          message: `→ ${instance.name}`,
          duration: 3000,
        });
      }

      // Show individual errors
      for (const failure of failures) {
        const errorMsg = failure.error || t().instances.unknownErrorShort;
        const isAlreadyInstalled = errorMsg.includes("уже установлен") || errorMsg.includes("already installed");
        addToast({
          type: isAlreadyInstalled ? "warning" : "error",
          title: isAlreadyInstalled ? t().instances.modAlreadyInstalled : t().instances.installationFailed,
          message: `${failure.file_name}: ${errorMsg}`,
          duration: isAlreadyInstalled ? 3000 : 5000,
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
          : t().instances.unknownErrorShort;
      addToast({
        type: "error",
        title: t().instances.batchInstallError,
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
      if (import.meta.env.DEV) console.error("Failed to open folder:", e);
    }
    setOpenMenuId(null);
    setMenuPosition(null);
  };

  const handleReimportManifest = async (instance: Instance) => {
    setOpenMenuId(null);
    setMenuPosition(null);
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "Manifest", extensions: ["json"] }],
      });
      if (!selected) return;
      if (typeof selected !== "string") return;
      const filePath = selected;

      addToast({
        type: "info",
        title: t().instances?.reimport?.started ?? "Re-importing manifest...",
        duration: 3000,
      });

      const result = await invoke<{
        total_in_manifest: number;
        already_present: number;
        downloaded: number;
        failed: number;
      }>("reimport_manifest", { instanceId: instance.id, filePath });

      addToast({
        type: result.failed > 0 ? "warning" : "success",
        title: t().instances?.reimport?.complete ?? "Re-import complete",
        message: `${result.downloaded} ${t().instances?.reimport?.downloaded ?? "downloaded"}, ${result.already_present} ${t().instances?.reimport?.alreadyPresent ?? "already present"}, ${result.failed} ${t().instances?.reimport?.failed ?? "failed"}`,
        duration: 5000,
      });
    } catch (e: unknown) {
      if (import.meta.env.DEV) console.error("Reimport failed:", e);
      addToast({
        type: "error",
        title: t().instances?.reimport?.error ?? "Re-import failed",
        message: e instanceof Error ? e.message : String(e),
        duration: 5000,
      });
    }
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
      const menuHeight = 340; // Primary menu: ~7 items × 40px + dividers + padding
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
      setMenuMode("primary");
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
          onBack={() => {
            setDetailInstance(null);
            setDetailInitialTab("mods"); // Reset to default to prevent stale tab on next open
          }}
          onStart={props.onStart}
          onStop={props.onStop}
          onDelete={(id) => {
            props.onDelete(id);
            setDetailInstance(null);
            setDetailInitialTab("mods");
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
        <div class="flex flex-col flex-1 min-h-0 overflow-y-auto" data-tour="instance-list">
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
              <ViewModeSwitch
                value={getViewMode("instances")}
                onChange={(mode) => setViewMode("instances", mode)}
                modes={["grid", "list"]}
              />
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

        <div data-tour="instance-grid" class={getViewMode("instances") === "list" ? "flex flex-col gap-2" : "grid grid-cols-1 xl:grid-cols-2 gap-3"}>
          <For each={sortedInstances()}>
            {(instance) => (
              <InstanceCard
                instance={instance}
                hasBothTypes={hasBothTypes()}
                isDraggingMods={isDraggingMods()}
                isHovered={dragHoveredInstance() === instance.id}
                acceptsMods={canAcceptMods(instance)}
                getStatusText={getStatusText}
                onClick={() => openInstanceDetail(instance)}
                onStart={props.onStart}
                onStop={props.onStop}
                onToggleMenu={toggleMenu}
                registerRef={registerInstanceCard}
                t={t}
                language={language}
              />
            )}
          </For>
        </div>
        </div>

        {/* Context Menu */}
        <Show when={openMenuId() && menuPosition()}>
          {(() => {
            const instance = props.instances.find(i => i.id === openMenuId());
            if (!instance) return null;
            return (
              <InstanceContextMenu
                instance={instance}
                position={menuPosition()!}
                menuMode={menuMode()}
                confirmDelete={confirmDelete()}
                setMenuMode={setMenuMode}
                onOpenMods={handleOpenMods}
                onOpenDetail={openInstanceDetail}
                onOpenFolder={handleOpenFolder}
                onConfigure={(inst) => {
                  props.onConfigure(inst);
                  setOpenMenuId(null);
                  setMenuPosition(null);
                }}
                onDelete={handleDelete}
                onGameSettings={(inst) => {
                  setGameSettingsInstance(inst);
                  setShowGameSettings(true);
                  setOpenMenuId(null);
                  setMenuPosition(null);
                }}
                onCheckIntegrity={(inst) => {
                  setIntegrityInstance(inst);
                  setShowIntegrityChecker(true);
                  setOpenMenuId(null);
                  setMenuPosition(null);
                }}
                onExportStzhk={(inst) => {
                  setStzhkExportInstance(inst);
                  setShowStzhkExport(true);
                  setOpenMenuId(null);
                  setMenuPosition(null);
                }}
                onReimportManifest={handleReimportManifest}
                onConvertToServer={(inst) => {
                  setConvertInstance(inst);
                  setShowConvertToServer(true);
                  setOpenMenuId(null);
                  setMenuPosition(null);
                }}
                onRepair={props.onRepair}
                onClose={handleClickOutside}
                menuRef={(el) => { menuRef = el; }}
                t={t}
              />
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
                <h2 class="text-xl font-bold">{t().instances.checkIntegrity}</h2>
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

      {/* Convert to Server Dialog */}
      <Show when={showConvertToServer() && convertInstance()}>
        <ConvertToServerDialog
          instance={convertInstance()!}
          onClose={() => {
            setShowConvertToServer(false);
            setConvertInstance(null);
          }}
          onConverted={(updated) => {
            // Refresh the instance list to show updated type
            props.onConfigure(updated);
            setShowConvertToServer(false);
            setConvertInstance(null);
          }}
        />
      </Show>

    </div>
  );
};

export default InstanceList;