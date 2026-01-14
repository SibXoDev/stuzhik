import { For, Show, createSignal, createEffect, onMount, onCleanup } from "solid-js";
import type { Component } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import type { Instance } from "../../../shared/types";
import { useI18n } from "../../../shared/i18n";
import { DELETE_CONFIRM_TIMEOUT_MS } from "../../../shared/constants";
import { LoaderIcon } from "../../../shared/components/LoaderSelector";
import ModsList from "../../mods/components/ModsList";
import { ResourcesPanel } from "../../resources";
import { CollectionsPanel } from "../../collections";
import { PerformancePanel } from "../../performance";
import { LogAnalyzer } from "../../../shared/components/LogAnalyzer";
import GameSettingsDialog from "./GameSettingsDialog";
import BackupManager from "./BackupManager";
import PatchesPanel from "./PatchesPanel";
import ServerConsole from "./ServerConsole";
import ClientConsole from "./ClientConsole";
import ServerSettings from "./ServerSettings";
import { ModProfilesPanel } from "../../modpack-editor";
import { EditorPanel } from "../../editor";
import { StzhkExportDialog } from "../../modpacks/components/StzhkExportDialog";
import { useSafeTimers } from "../../../shared/hooks";
import { Tabs } from "../../../shared/ui";

export type Tab = "mods" | "resources" | "logs" | "collections" | "performance" | "backups" | "patches" | "console" | "settings" | "editor" | "profiles";

interface Props {
  instance: Instance;
  initialTab?: Tab;
  onBack: () => void;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  onDelete: (id: string) => void;
  onRepair: (id: string) => void;
  onConfigure: (instance: Instance) => void;
  onRefresh: () => void;
}

interface InstallProgress {
  id: string;
  step: "java" | "minecraft" | "loader" | "complete";
  message: string;
}

interface DownloadProgress {
  id: string;
  name: string;
  downloaded: number;
  total: number;
  speed: number;
  percentage: number;
  status: string;
}

type ResourceSubTab = "resourcepacks" | "shaders";

interface EulaStatus {
  exists: boolean;
  accepted: boolean;
  url: string;
}

const InstanceDetail: Component<Props> = (props) => {
  const { t } = useI18n();
  const { setTimeout: safeTimeout } = useSafeTimers();

  // Create a stable reference to instance that won't throw if props.instance becomes null
  const instance = () => props.instance;

  // Early return if instance is null (during unmount)
  const safeInstance = () => {
    const inst = instance();
    if (!inst) return null;
    return inst;
  };

  const defaultTab = () => {
    const inst = safeInstance();
    return inst?.instance_type === "server" ? "console" : "mods";
  };

  const [activeTab, setActiveTab] = createSignal<Tab>(props.initialTab || defaultTab() || "mods");
  const [resourceSubTab, setResourceSubTab] = createSignal<ResourceSubTab>("resourcepacks");
  const [showGameSettings, setShowGameSettings] = createSignal(false);
  const [showExportDialog, setShowExportDialog] = createSignal(false);
  const [confirmDelete, setConfirmDelete] = createSignal(false);

  // EULA modal state for servers
  const [showEulaModal, setShowEulaModal] = createSignal(false);
  const [acceptingEula, setAcceptingEula] = createSignal(false);

  // Installation progress state
  const [installStep, setInstallStep] = createSignal<InstallProgress["step"] | null>(null);
  const [installMessage, setInstallMessage] = createSignal("");
  const [downloads, setDownloads] = createSignal<DownloadProgress[]>([]);

  // Update tab when initialTab prop changes
  createEffect(() => {
    if (props.initialTab) {
      setActiveTab(props.initialTab);
    }
  });

  // Listen for status changes to refresh
  let unlistenStatus: UnlistenFn | undefined;
  let unlistenProgress: UnlistenFn | undefined;
  let unlistenDownload: UnlistenFn | undefined;
  let unlistenCreated: UnlistenFn | undefined;

  onMount(async () => {
    unlistenStatus = await listen<{ id: string; status: string }>("instance-status-changed", (event) => {
      const instance = props.instance;
      if (instance && event.payload.id === instance.id) {
        props.onRefresh();
        // Clear progress when done
        if (event.payload.status !== "installing") {
          setInstallStep(null);
          setInstallMessage("");
          setDownloads([]);
        }
      }
    });

    // Listen for installation progress
    unlistenProgress = await listen<InstallProgress>("instance-install-progress", (event) => {
      const instance = props.instance;
      if (instance && event.payload.id === instance.id) {
        setInstallStep(event.payload.step);
        setInstallMessage(event.payload.message);
      }
    });

    // Listen for download progress
    unlistenDownload = await listen<DownloadProgress>("download-progress", (event) => {
      const instance = props.instance;
      if (instance?.status === "installing") {
        setDownloads(prev => {
          const existing = prev.findIndex(p => p.id === event.payload.id);
          if (event.payload.status === "completed") {
            // Remove completed download
            return prev.filter(p => p.id !== event.payload.id);
          }
          if (existing >= 0) {
            const updated = [...prev];
            updated[existing] = event.payload;
            return updated;
          }
          return [...prev, event.payload];
        });
      }
    });

    // Listen for instance created (installation complete)
    unlistenCreated = await listen<{ id: string }>("instance-created", (event) => {
      const instance = props.instance;
      if (instance && event.payload.id === instance.id) {
        setInstallStep(null);
        setInstallMessage("");
        setDownloads([]);
      }
    });
  });

  onCleanup(() => {
    unlistenStatus?.();
    unlistenProgress?.();
    unlistenDownload?.();
    unlistenCreated?.();
  });

  // Helper to get step label
  const getStepLabel = (step: InstallProgress["step"] | null) => {
    const labels = t().quickPlay?.steps || {
      java: "Java",
      minecraft: "Minecraft",
      loader: "Загрузчик",
      complete: "Готово",
    };
    return step ? labels[step] || step : "";
  };

  // Helper to get step index
  const getStepIndex = (step: InstallProgress["step"] | null): number => {
    if (step === "java") return 0;
    if (step === "minecraft") return 1;
    if (step === "loader") return 2;
    if (step === "complete") return 3;
    return -1;
  };

  const handleOpenFolder = async () => {
    const instance = props.instance;
    if (!instance) return;
    try {
      await invoke("open_instance_folder", { id: instance.id });
    } catch (e) {
      console.error("Failed to open folder:", e);
    }
  };

  const handleDelete = () => {
    const instance = props.instance;
    if (!instance) return;
    if (confirmDelete()) {
      props.onDelete(instance.id);
      props.onBack();
    } else {
      setConfirmDelete(true);
      safeTimeout(() => setConfirmDelete(false), DELETE_CONFIRM_TIMEOUT_MS);
    }
  };

  // Server start handler - checks EULA first
  const handleServerStart = async () => {
    const instance = props.instance;
    if (!instance) return;

    if (instance.instance_type !== "server") {
      props.onStart(instance.id);
      return;
    }

    try {
      const eulaStatus = await invoke<EulaStatus>("get_eula_status", { instanceId: instance.id });
      if (!eulaStatus.accepted) {
        setShowEulaModal(true);
        return;
      }
      props.onStart(instance.id);
    } catch (e) {
      console.error("Failed to check EULA:", e);
      // Try to start anyway, backend will show error if needed
      if (instance) props.onStart(instance.id);
    }
  };

  // Accept EULA and start server
  const handleAcceptEula = async () => {
    const instance = props.instance;
    if (!instance) return;
    setAcceptingEula(true);
    try {
      await invoke("accept_server_eula", { instanceId: instance.id });
      setShowEulaModal(false);
      // Start server after accepting
      props.onStart(instance.id);
    } catch (e) {
      console.error("Failed to accept EULA:", e);
    } finally {
      setAcceptingEula(false);
    }
  };

  const getStatusText = (status: string) => {
    switch (status) {
      case "running": return t().instances.status.running;
      case "starting": return t().instances.status.starting;
      case "stopping": return t().instances.status.stopping;
      case "error": return t().instances.status.error;
      case "installing": return t().instances.status.installing;
      default: return t().instances.status.stopped;
    }
  };

  const getStatusClass = (status: string) => {
    switch (status) {
      case "running": return "bg-emerald-500/10 text-emerald-400 border-emerald-500/30";
      case "starting": return "bg-yellow-500/10 text-yellow-400 border-yellow-500/30";
      case "installing": return "bg-blue-500/10 text-blue-400 border-blue-500/30";
      case "error": return "bg-red-500/10 text-red-400 border-red-500/30";
      default: return "bg-gray-500/10 text-gray-400 border-gray-500/30";
    }
  };

  // Guard - if instance is null, don't render anything (during unmount)
  const inst = () => props.instance;
  const isServer = () => inst()?.instance_type === "server";

  const tabs = (): { id: Tab; label: string; icon: string }[] => isServer()
    ? [
        { id: "console", label: "Консоль", icon: "i-hugeicons-command-line" },
        { id: "mods", label: t().mods.title, icon: "i-hugeicons-package" },
        { id: "editor", label: "Редактор", icon: "i-hugeicons-source-code" },
        { id: "profiles", label: "Профили", icon: "i-hugeicons-layers-01" },
        { id: "settings", label: "Настройки", icon: "i-hugeicons-settings-02" },
        { id: "backups", label: t().backup?.title || "Бэкапы", icon: "i-hugeicons-floppy-disk" },
        { id: "logs", label: t().instances.analyzeLogs || "Логи", icon: "i-hugeicons-file-view" },
      ]
    : [
        { id: "mods", label: t().mods.title, icon: "i-hugeicons-package" },
        { id: "editor", label: "Редактор", icon: "i-hugeicons-source-code" },
        { id: "profiles", label: "Профили", icon: "i-hugeicons-layers-01" },
        { id: "resources", label: t().resources?.title || "Ресурсы", icon: "i-hugeicons-image-01" },
        { id: "collections", label: t().collections?.title || "Коллекции", icon: "i-hugeicons-folder-library" },
        { id: "patches", label: t().modpackCompare?.patch?.title || "Патчи", icon: "i-hugeicons-file-import" },
        { id: "performance", label: t().performance?.title || "Производительность", icon: "i-hugeicons-activity-01" },
        { id: "console", label: t().console?.title || "Консоль", icon: "i-hugeicons-command-line" },
        { id: "backups", label: t().backup?.title || "Бэкапы", icon: "i-hugeicons-floppy-disk" },
        { id: "logs", label: t().instances.analyzeLogs || "Логи", icon: "i-hugeicons-file-view" },
      ];

  // Safe accessors that won't throw if instance is null
  const status = () => inst()?.status ?? "stopped";
  const instanceId = () => inst()?.id ?? "";

  return (
    <Show when={inst()} fallback={null}>
    <div class="flex flex-col gap-4 flex-1 min-h-0">
      {/* Header with back button and instance info */}
      <div class="flex items-start gap-3">
        <button class="btn-ghost flex-shrink-0" onClick={props.onBack}>
          <i class="i-hugeicons-arrow-left-01 w-5 h-5" />
        </button>

        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-3">
            {/* Loader Icon */}
            <div class="w-12 h-12 rounded-2xl bg-black/30 flex-center flex-shrink-0 border border-gray-700/50">
              <LoaderIcon loader={inst()?.loader} class="w-7 h-7" />
            </div>

            {/* Info */}
            <div class="flex-1 min-w-0">
              <div class="flex flex-wrap items-center gap-2 mb-1">
                <h2 class="text-lg font-bold truncate">{inst()?.name}</h2>
                <span
                  class={`px-2 py-0.5 text-xs rounded-full flex-shrink-0 ${
                    inst()?.instance_type === "server"
                      ? "bg-purple-500/15 text-purple-400 border border-purple-500/30"
                      : "bg-blue-500/15 text-blue-400 border border-blue-500/30"
                  }`}
                >
                  {inst()?.instance_type === "server" ? "Server" : "Client"}
                </span>
                <span class={`px-2 py-0.5 text-xs rounded-full border ${getStatusClass(status())}`}>
                  {getStatusText(status())}
                </span>
              </div>
              <div class="flex flex-wrap items-center gap-2 text-xs text-gray-400">
                <span>MC {inst()?.version}</span>
                <span class="w-1 h-1 rounded-full bg-gray-600" />
                <span class="capitalize">{inst()?.loader || "vanilla"}</span>
                <Show when={inst()?.loader_version}>
                  <span class="text-gray-500">({inst()?.loader_version})</span>
                </Show>
                <Show when={(inst()?.total_playtime ?? 0) > 0}>
                  <span class="w-1 h-1 rounded-full bg-gray-600" />
                  <span>
                    {Math.floor((inst()?.total_playtime ?? 0) / 3600)}ч{" "}
                    {Math.floor(((inst()?.total_playtime ?? 0) % 3600) / 60)}м
                  </span>
                </Show>
              </div>
            </div>
          </div>
        </div>

        {/* Action buttons */}
        <div class="flex items-center gap-1 flex-shrink-0">
            <Show
              when={status() === "running" || status() === "stopping" || status() === "starting"}
              fallback={
                <button
                  class="btn-primary px-3 lg:px-6"
                  onClick={handleServerStart}
                  disabled={status() === "starting" || status() === "installing"}
                >
                  <Show
                    when={status() === "starting"}
                    fallback={
                      <>
                        <i class="i-hugeicons-play w-4 h-4" />
                        <span class="hidden sm:inline">{inst()?.instance_type === "server" ? "Запустить" : (t().instances.start || "Играть")}</span>
                      </>
                    }
                  >
                    <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                    <span class="hidden sm:inline">{t().instances.status.starting}</span>
                  </Show>
                </button>
              }
            >
              <button
                class="btn-danger px-3 lg:px-6"
                onClick={() => instanceId() && props.onStop(instanceId())}
                disabled={status() === "stopping"}
              >
                <Show
                  when={status() === "stopping"}
                  fallback={
                    <>
                      <i class="i-hugeicons-stop w-4 h-4" />
                      <span class="hidden sm:inline">{t().instances.stop || "Стоп"}</span>
                    </>
                  }
                >
                  <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                  <span class="hidden sm:inline">Остановка...</span>
                </Show>
              </button>
            </Show>

            <button class="btn-ghost" onClick={handleOpenFolder} title={t().instances.openFolder}>
              <i class="i-hugeicons-folder-01 w-5 h-5" />
            </button>

            <button class="btn-ghost" onClick={() => setShowExportDialog(true)} title="Экспорт модпака">
              <i class="i-hugeicons-share-01 w-5 h-5" />
            </button>

            <button class="btn-ghost" onClick={() => setShowGameSettings(true)} title={t().instances.gameSettings}>
              <i class="i-hugeicons-game-controller-03 w-5 h-5" />
            </button>

            <button class="btn-ghost" onClick={() => inst() && props.onConfigure(inst()!)} title={t().common.edit}>
              <i class="i-hugeicons-settings-02 w-5 h-5" />
            </button>

            <button
              class="btn-ghost"
              onClick={() => instanceId() && props.onRepair(instanceId())}
              disabled={status() === "running" || status() === "starting"}
              title={t().instances.repair}
            >
              <i class="i-hugeicons-wrench-01 w-5 h-5" />
            </button>

            <button
              class={`btn-ghost transition-all ${
                confirmDelete()
                  ? "bg-red-600 text-white hover:bg-red-500 px-3"
                  : "text-red-400 hover:text-red-300"
              }`}
              onClick={handleDelete}
              disabled={status() === "running"}
              title={confirmDelete() ? t().instances.confirmDelete : t().common.delete}
            >
              <Show when={confirmDelete()} fallback={<i class="i-hugeicons-delete-02 w-5 h-5" />}>
                <i class="i-hugeicons-checkmark-circle-02 w-5 h-5" />
                <span class="text-sm">{t().instances.confirmDelete || "Удалить?"}</span>
              </Show>
            </button>
        </div>
      </div>

      {/* Error Banner */}
      <Show when={status() === "error"}>
        <div class="bg-red-500/10 border border-red-500/30 rounded-2xl p-4 flex items-start gap-3">
          <i class="i-hugeicons-alert-02 w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
          <div class="flex-1 min-w-0">
            <h3 class="font-medium text-red-400 mb-1">
              {t().instances.installationFailed || "Ошибка"}
            </h3>
            <p class="text-sm text-red-300/80 break-words">
              {inst()?.installation_error || t().instances.unknownError || "Неизвестная ошибка. Попробуйте переустановить экземпляр."}
            </p>
            <Show when={inst()?.installation_step}>
              <p class="text-xs text-gray-500 mt-2">
                {t().instances.failedAtStep || "Этап"}: {inst()?.installation_step}
              </p>
            </Show>
          </div>
          <button
            class="btn-secondary text-red-400 border-red-500/30 hover:bg-red-500/20 flex-shrink-0"
            onClick={() => instanceId() && props.onRepair(instanceId())}
            title={t().instances.retryInstallation || "Повторить установку"}
          >
            <i class="i-hugeicons-refresh w-4 h-4" />
            {t().instances.retry || "Повторить"}
          </button>
        </div>
      </Show>

      {/* Installation Progress Panel */}
      <Show when={status() === "installing"}>
        <div class="bg-blue-500/10 border border-blue-500/30 rounded-2xl p-4">
          <div class="flex items-center gap-3 mb-4">
            <i class="i-svg-spinners-6-dots-scale w-5 h-5 text-blue-400" />
            <h3 class="font-medium text-blue-400">
              {t().quickPlay?.installing || "Установка..."}
            </h3>
          </div>

          {/* Step indicators */}
          <div class="flex items-center justify-between mb-4 px-4">
            <For each={["java", "minecraft", "loader"] as const}>
              {(step, index) => {
                const currentIndex = () => getStepIndex(installStep());
                const isActive = () => currentIndex() === index();
                const isCompleted = () => currentIndex() > index();
                const isFuture = () => currentIndex() < index();

                return (
                  <>
                    <div class="flex flex-col items-center gap-2">
                      <div
                        class={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-medium transition-all ${
                          isCompleted()
                            ? "bg-green-600 text-white"
                            : isActive()
                              ? "bg-blue-600 text-white"
                              : "bg-gray-700 text-gray-500"
                        }`}
                      >
                        <Show when={isCompleted()} fallback={
                          <Show when={isActive()} fallback={<span>{index() + 1}</span>}>
                            <i class="i-svg-spinners-6-dots-scale w-4 h-4 text-white" />
                          </Show>
                        }>
                          <i class="i-hugeicons-checkmark-circle-02 w-5 h-5" />
                        </Show>
                      </div>
                      <span class={`text-sm ${isActive() ? "text-white font-medium" : isFuture() ? "text-gray-500" : "text-gray-400"}`}>
                        {getStepLabel(step)}
                      </span>
                    </div>

                    {/* Connector Line */}
                    <Show when={index() < 2}>
                      <div class="flex-1 mx-4 max-w-[100px]">
                        <div class={`h-1 rounded transition-all ${isCompleted() ? "bg-green-600" : "bg-gray-700"}`} />
                      </div>
                    </Show>
                  </>
                );
              }}
            </For>
          </div>

          {/* Current message */}
          <Show when={installMessage()}>
            <p class="text-sm text-gray-400 text-center mb-3">{installMessage()}</p>
          </Show>

          {/* Downloads list */}
          <Show when={downloads().length > 0}>
            <div class="space-y-2 border-t border-blue-500/20 pt-3 mt-3">
              <h4 class="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
                {t().instances.downloads || "Загрузки"}
              </h4>
              <For each={downloads()}>
                {(download) => (
                  <div class="bg-gray-800/50 rounded-xl p-3">
                    <div class="flex items-center justify-between mb-2">
                      <span class="text-sm text-gray-300 truncate flex-1 mr-2">{download.name}</span>
                      <span class="text-xs text-gray-500">
                        {(download.speed / 1024 / 1024).toFixed(1)} MB/s
                      </span>
                    </div>
                    <div class="w-full h-1.5 bg-gray-700 rounded-full overflow-hidden">
                      <div
                        class="h-full bg-blue-500 transition-all duration-100"
                        style={{ width: `${download.percentage}%` }}
                      />
                    </div>
                    <div class="flex items-center justify-between mt-1">
                      <span class="text-xs text-gray-500">
                        {(download.downloaded / 1024 / 1024).toFixed(1)} / {(download.total / 1024 / 1024).toFixed(1)} MB
                      </span>
                      <span class="text-xs text-gray-400 font-medium">{download.percentage.toFixed(0)}%</span>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>

      {/* Tabs - wrapper with min-w-0 to allow shrinking in flex column */}
      <div class="min-w-0 w-full flex-shrink-0">
        <Tabs
          tabs={tabs()}
          activeTab={activeTab()}
          onTabChange={(id) => setActiveTab(id as Tab)}
          variant="underline"
        />
      </div>

      {/* Tab content - scrollable for most tabs, but console and editor manage their own scroll */}
      <div class={`flex-1 min-h-0 ${activeTab() === "console" || activeTab() === "editor" ? "flex flex-col" : "overflow-y-auto"}`}>
        {/* ModsList uses global verification store - no need to keep mounted */}
        <Show when={activeTab() === "mods" && instanceId()}>
          <ModsList
            instanceId={instanceId()}
            minecraftVersion={inst()?.version ?? ""}
            loader={inst()?.loader || "neoforge"}
          />
        </Show>

        <Show when={activeTab() === "resources"}>
          {/* Sub-tabs for resource types */}
          <div class="mb-4">
            <Tabs
              tabs={[
                { id: "resourcepacks", label: t().resources?.resourcePacks ?? "Resource Packs", icon: "i-hugeicons-image-01" },
                { id: "shaders", label: t().resources?.shaders ?? "Shaders", icon: "i-hugeicons-flash" },
              ]}
              activeTab={resourceSubTab()}
              onTabChange={(id) => setResourceSubTab(id as ResourceSubTab)}
              variant="pills"
            />
          </div>

          <Show when={instanceId()}>
            <ResourcesPanel
              instanceId={instanceId()}
              minecraftVersion={inst()?.version ?? ""}
              resourceType={resourceSubTab() === "shaders" ? "shader" : "resourcepack"}
            />
          </Show>
        </Show>

        <Show when={activeTab() === "collections" && inst()}>
          <CollectionsPanel
            instance={inst()!}
          />
        </Show>

        <Show when={activeTab() === "performance" && instanceId()}>
          <PerformancePanel
            instanceId={() => instanceId()}
            instanceStatus={() => status()}
            isModal={false}
          />
        </Show>

        <Show when={activeTab() === "backups" && inst()}>
          <BackupManager
            instance={inst()!}
            isModal={false}
          />
        </Show>

        <Show when={activeTab() === "patches" && inst()}>
          <PatchesPanel instance={inst()!} />
        </Show>

        <Show when={activeTab() === "logs" && instanceId()}>
          <LogAnalyzer
            instanceId={instanceId()}
            onClose={() => setActiveTab("mods")}
          />
        </Show>

        <Show when={activeTab() === "editor" && instanceId()}>
          <EditorPanel instanceId={instanceId()} />
        </Show>

        <Show when={activeTab() === "profiles" && instanceId()}>
          <ModProfilesPanel instanceId={instanceId()} />
        </Show>

        <Show when={activeTab() === "console" && instanceId()}>
          <Show
            when={isServer()}
            fallback={
              <ClientConsole
                instanceId={instanceId()}
                isRunning={status() === "running"}
                instanceStatus={status()}
              />
            }
          >
            <ServerConsole
              instanceId={instanceId()}
              isRunning={status() === "running"}
              instanceStatus={status()}
            />
          </Show>
        </Show>

        <Show when={activeTab() === "settings" && instanceId()}>
          <ServerSettings
            instanceId={instanceId()}
            isRunning={status() === "running"}
          />
        </Show>
      </div>

      {/* Modal overlays */}
      <Show when={showGameSettings() && instanceId()}>
        <GameSettingsDialog
          instanceId={instanceId()}
          instanceName={inst()?.name ?? ""}
          onClose={() => setShowGameSettings(false)}
        />
      </Show>

      {/* Export Dialog */}
      <Show when={showExportDialog() && instanceId()}>
        <StzhkExportDialog
          instanceId={instanceId()}
          instanceName={inst()?.name ?? ""}
          onClose={() => setShowExportDialog(false)}
        />
      </Show>

      {/* EULA Modal for servers */}
      <Show when={showEulaModal()}>
        <div class="fixed inset-0 z-50 flex items-center justify-center">
          <div class="absolute inset-0 bg-black/70" onClick={() => setShowEulaModal(false)} />
          <div class="bg-gray-850 rounded-2xl border border-gray-700 p-6 max-w-md w-full mx-4 shadow-2xl z-10">
            <div class="flex items-center gap-3 mb-4">
              <div class="w-10 h-10 rounded-xl bg-amber-500/10 flex items-center justify-center">
                <i class="i-hugeicons-file-01 w-5 h-5 text-amber-400" />
              </div>
              <div>
                <h3 class="text-lg font-semibold">Лицензионное соглашение</h3>
                <p class="text-sm text-gray-400">Minecraft EULA</p>
              </div>
            </div>

            <p class="text-gray-300 text-sm mb-4">
              Для запуска сервера Minecraft необходимо принять лицензионное соглашение (EULA).
            </p>

            <a
              href="https://aka.ms/MinecraftEULA"
              target="_blank"
              rel="noopener noreferrer"
              class="flex items-center gap-2 text-blue-400 hover:text-blue-300 text-sm mb-6"
            >
              <i class="i-hugeicons-rocket-01 w-4 h-4" />
              Прочитать EULA на сайте Minecraft
            </a>

            <div class="flex gap-3">
              <button
                class="flex-1 btn-secondary"
                onClick={() => setShowEulaModal(false)}
                disabled={acceptingEula()}
              >
                Отмена
              </button>
              <button
                class="flex-1 btn-primary"
                onClick={handleAcceptEula}
                disabled={acceptingEula()}
              >
                <Show when={acceptingEula()} fallback="Принять и запустить">
                  <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                </Show>
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
    </Show>
  );
};

export default InstanceDetail;
