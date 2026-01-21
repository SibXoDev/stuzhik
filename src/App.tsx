import { createSignal, Show, onMount, onCleanup } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen, emit, UnlistenFn } from "@tauri-apps/api/event";
import { TitleBar, AppBackground, DevConsole, ErrorReporter, LogAnalyzer, QuickPlay, DownloadsPanel, ConnectPanel, ToastProvider, UIKit, DevTests, DragDropOverlay } from "./shared/components";
import { initDownloadListener, useDownloads, useDeveloperMode } from "./shared/hooks";
import AutoUpdater from "./shared/components/AutoUpdater";
import { ModalWrapper, Dropdown } from "./shared/ui";
import { initModInstallTracking, initDragDrop, cleanupDragDrop, registerDropHandler, filterByExtensions, triggerSearch } from "./shared/stores";
import { InstanceList, CreateInstanceForm, InstallProgressModal, EditInstanceDialog, useInstances, ImportServerDialog } from "./features/instances";
import { Settings, SettingsSyncDialog } from "./features/settings";
import { ModpackBrowser, ModpackProjectList, ModpackEditor, LauncherImportDialog } from "./features/modpacks";
import { DocumentationPage, ChangelogModal, SourceCodePage } from "./features/docs";
import { I18nProvider, useI18n, type Language } from "./shared/i18n";
import type { Instance, ModpackProject, Settings as AppSettings } from "./shared/types";

function AppContent() {
  const { t } = useI18n();
  const { developerMode } = useDeveloperMode();
  const {
    instances,
    loading,
    error,
    load,
    createInstance,
    startInstance,
    stopInstance,
    deleteInstance,
    repairInstance,
  } = useInstances();

  const [showCreateForm, setShowCreateForm] = createSignal(false);
  const [showSettings, setShowSettings] = createSignal(false);
  const [showModpackBrowser, setShowModpackBrowser] = createSignal(false);
  const [showModpackEditor, setShowModpackEditor] = createSignal(false);
  const [showConsole, setShowConsole] = createSignal(false);
  const [showSettingsSync, setShowSettingsSync] = createSignal(false);
  const [showExternalLogAnalyzer, setShowExternalLogAnalyzer] = createSignal(false);
  const [showImportServer, setShowImportServer] = createSignal(false);
  const [showImportLauncher, setShowImportLauncher] = createSignal(false);
  const [showToolsMenu, setShowToolsMenu] = createSignal(false);
  const [showConnect, setShowConnect] = createSignal(false);
  const [showUIKit, setShowUIKit] = createSignal(false);
  const [showDevTests, setShowDevTests] = createSignal(false);
  const [showDocs, setShowDocs] = createSignal(false);
  const [showChangelog, setShowChangelog] = createSignal(false);
  const [showSourceCode, setShowSourceCode] = createSignal(false);
  const [sourceCodePath, setSourceCodePath] = createSignal<string | undefined>(undefined);
  const [sourceCodeLine, setSourceCodeLine] = createSignal<number | undefined>(undefined);
  const [settingsScrollTo, setSettingsScrollTo] = createSignal<string | undefined>(undefined);
  const [consoleLayout, setConsoleLayout] = createSignal<{ size: number; position: "right" | "bottom" }>({ size: 0, position: "bottom" });
  const [consoleDetached, setConsoleDetached] = createSignal(false);
  const [detailViewOpen, setDetailViewOpen] = createSignal(false);

  // Drag & drop: pending modpack file to install
  const [pendingModpackFile, setPendingModpackFile] = createSignal<string | null>(null);

  // Listen for console detach/attach events
  let unlistenDetach: UnlistenFn | undefined;
  let unlistenAttach: UnlistenFn | undefined;
  let unlistenOpenModpack: UnlistenFn | undefined;
  let unlistenJoinInvite: UnlistenFn | undefined;

  onMount(async () => {
    unlistenDetach = await listen("console-detached", () => {
      setConsoleDetached(true);
      setShowConsole(false);
    });

    unlistenAttach = await listen("console-attached", () => {
      setConsoleDetached(false);
    });

    // Listen for modpack file open events (from file association / deep link / second instance)
    unlistenOpenModpack = await listen<string>("open-modpack-file", (event) => {
      const filePath = event.payload;
      if (import.meta.env.DEV) console.log("Opening modpack file:", filePath);
      // Set the pending modpack file and open the browser
      setPendingModpackFile(filePath);
      setShowModpackBrowser(true);
    });

    // Listen for server invite join events (from deep link: stuzhik://join/CODE)
    unlistenJoinInvite = await listen<string>("join-server-invite", (event) => {
      const inviteCode = event.payload;
      if (import.meta.env.DEV) console.log("Joining server with invite:", inviteCode);
      // Open ConnectPanel and trigger join
      setShowConnect(true);
      // Emit event for ConnectPanel to handle
      emit("connect-join-invite", inviteCode);
    });

    // Check for pending modpack file (from file association / first launch)
    // This handles the case when app was launched by double-clicking .stzhk file
    try {
      const pendingFile = await invoke<string | null>("get_pending_modpack_file");
      if (pendingFile) {
        if (import.meta.env.DEV) console.log("Found pending modpack file:", pendingFile);
        setPendingModpackFile(pendingFile);
        setShowModpackBrowser(true);
      }
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to check pending modpack file:", e);
    }

    // Keyboard shortcuts
    const handleKeyDown = (e: KeyboardEvent) => {
      // ESC для закрытия документации и исходников
      if (e.key === "Escape") {
        if (showSourceCode()) {
          e.preventDefault();
          setShowSourceCode(false);
          setSourceCodePath(undefined);
          setSourceCodeLine(undefined);
          return;
        }
        if (showDocs()) {
          e.preventDefault();
          setShowDocs(false);
          return;
        }
      }
      // Ctrl+F - trigger custom search (prevents browser's find dialog)
      if ((e.ctrlKey || e.metaKey) && e.code === "KeyF" && !e.shiftKey && !e.altKey) {
        // Try to trigger registered search handler
        if (triggerSearch()) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        // If no handlers, let browser handle it (or prevent if you want)
      }
      // Ctrl+Shift+D для открытия/закрытия консоли
      if (e.ctrlKey && e.shiftKey && e.code === "KeyD") {
        e.preventDefault();
        if (!consoleDetached()) {
          setShowConsole(!showConsole());
        }
      }
      // Ctrl+Shift+U для открытия/закрытия UI Kit (dev mode)
      if (e.ctrlKey && e.shiftKey && e.code === "KeyU") {
        e.preventDefault();
        setShowUIKit(!showUIKit());
      }
      // Ctrl+Shift+T для открытия/закрытия Dev Tests (dev mode)
      if (e.ctrlKey && e.shiftKey && e.code === "KeyT") {
        e.preventDefault();
        setShowDevTests(!showDevTests());
      }
    };
    document.addEventListener("keydown", handleKeyDown);

    onCleanup(() => {
      document.removeEventListener("keydown", handleKeyDown);
    });
  });

  onCleanup(() => {
    unlistenDetach?.();
    unlistenAttach?.();
    unlistenOpenModpack?.();
    unlistenJoinInvite?.();
  });

  // Register global drag & drop handler for modpack files
  onMount(() => {
    const cleanup = registerDropHandler({
      accept: (files) => {
        // Accept modpack files (.stzhk, .mrpack, .zip)
        const modpackFiles = filterByExtensions(files, ["stzhk", "mrpack", "zip"]);
        return modpackFiles.length > 0;
      },
      onDrop: async (files) => {
        const modpackFiles = filterByExtensions(files, ["stzhk", "mrpack", "zip"]);
        if (modpackFiles.length > 0) {
          // Take the first modpack file and open ModpackBrowser with it
          setPendingModpackFile(modpackFiles[0].path);
          setShowModpackBrowser(true);
        }
      },
      priority: 5, // Lower than mods (10) but still reasonably high
    });

    onCleanup(cleanup);
  });

  // Register handler for manifest.json / modrinth.index.json files
  onMount(() => {
    const cleanup = registerDropHandler({
      accept: (files) => {
        // Accept manifest JSON files
        return files.some(
          (f) =>
            f.extension === "json" &&
            (f.name.toLowerCase() === "manifest.json" ||
              f.name.toLowerCase() === "modrinth.index.json")
        );
      },
      onDrop: async (files) => {
        const manifestFile = files.find(
          (f) =>
            f.extension === "json" &&
            (f.name.toLowerCase() === "manifest.json" ||
              f.name.toLowerCase() === "modrinth.index.json")
        );
        if (!manifestFile) return;

        try {
          // Preview manifest to get info
          const preview = await invoke<{
            format: string;
            name: string;
            minecraft_version: string;
            loader: string;
            mods_count: number;
          }>("preview_manifest_file", { filePath: manifestFile.path });

          // Use modpack name as instance name
          const instanceName = preview.name || "Imported Modpack";

          // Start installation
          const { addToast } = await import("./shared/components/Toast");
          addToast({
            type: "info",
            title: `Импорт ${preview.format === "modrinth" ? "Modrinth" : "CurseForge"} модпака`,
            message: `${instanceName} (${preview.mods_count} модов)`,
            duration: 5000,
          });

          const instanceId = await invoke<string>("install_modpack_from_manifest", {
            filePath: manifestFile.path,
            instanceName,
          });

          // Show progress modal
          setInstallingInstance({ id: instanceId, name: instanceName });

          addToast({
            type: "success",
            title: "Модпак импортирован",
            message: `${instanceName} создан успешно`,
            duration: 5000,
          });

          // Refresh instances
          load();
        } catch (e) {
          console.error("Failed to import manifest:", e);
          const { addToast } = await import("./shared/components/Toast");
          addToast({
            type: "error",
            title: "Ошибка импорта",
            message: String(e),
            duration: 8000,
          });
        }
      },
      priority: 8, // Higher than modpack archives but lower than mods
    });

    onCleanup(cleanup);
  });

  const [editingProject, setEditingProject] = createSignal<ModpackProject | null>(null);
  const [editingInstance, setEditingInstance] = createSignal<Instance | null>(null);
  const [installingInstance, setInstallingInstance] = createSignal<{
    id: string;
    name: string;
  } | null>(null);

  // Handle console resize
  const handleConsoleResize = (size: number, position: "right" | "bottom") => {
    setConsoleLayout({ size, position });
  };


  const handleInstanceCreated = (instanceId: string, instanceName: string) => {
    setShowCreateForm(false);
    // Показываем модалку прогресса
    setInstallingInstance({ id: instanceId, name: instanceName });
  };

  const handleInstallComplete = () => {
    setInstallingInstance(null);
  };

  const handleInstallError = (error: string) => {
    console.error("Installation error:", error);
    // Можно показать toast или что-то ещё
  };

  const handleConfigure = (instance: Instance) => {
    setEditingInstance(instance);
  };

  const handleEditSaved = () => {
    // Перезагружаем список экземпляров
    load();
  };

  const handleModpackInstalled = (_instanceId: string, _instanceName: string) => {
    // DON'T close the dialog immediately - loader installation is still in progress!
    // ModpackBrowser will close itself when instance-created event fires
    // Just reload the list so instance appears
    load();
  };

  const handleProjectSelect = (project: ModpackProject) => {
    setEditingProject(project);
  };

  const handleProjectInstanceCreated = (_instanceId: string) => {
    setEditingProject(null);
    setShowModpackEditor(false);
    load();
  };

  // Downloads panel state (global signal)
  const { showDownloadsPanel, setShowDownloadsPanel } = useDownloads();

  // Close modals that don't have unsaved data (for modal replacement)
  const closeOtherModals = () => {
    setShowSettings(false);
    setShowDownloadsPanel(false);
    setShowSettingsSync(false);
    setShowExternalLogAnalyzer(false);
    setShowModpackBrowser(false);
    setShowImportServer(false);
    setShowImportLauncher(false);
    setShowDocs(false);
    setShowChangelog(false);
    // Don't close: showCreateForm, showModpackEditor (with editingProject), installingInstance, editingInstance - have unsaved data
    // Note: showSourceCode is not a modal, it replaces main content
  };

  // Open modal with closing others
  const openSettings = (scrollTo?: string) => {
    closeOtherModals();
    setSettingsScrollTo(scrollTo);
    setShowSettings(true);
  };
  const openModpackBrowser = () => { closeOtherModals(); setShowModpackBrowser(true); };
  const openSettingsSync = () => { closeOtherModals(); setShowSettingsSync(true); };
  const openExternalLogAnalyzer = () => { closeOtherModals(); setShowExternalLogAnalyzer(true); };
  const openCreateForm = () => { closeOtherModals(); setShowCreateForm(true); };
  const openImportServer = () => { closeOtherModals(); setShowImportServer(true); };
  const openImportLauncher = () => { closeOtherModals(); setShowImportLauncher(true); };
  const openChangelog = () => { closeOtherModals(); setShowChangelog(true); };
  const openSourceCode = (path?: string, line?: number) => {
    setSourceCodePath(path);
    setSourceCodeLine(line);
    setShowDocs(false);
    setShowSourceCode(true);
  };

  // Check if any modal is open (for backdrop)
  const hasModal = () => showSettings() || showModpackBrowser() || showModpackEditor() ||
    showCreateForm() || installingInstance() || editingInstance() || showSettingsSync() ||
    showDownloadsPanel() || showExternalLogAnalyzer() || showUIKit() || showImportServer() ||
    showImportLauncher() || showChangelog();

  return (
    <div class="h-screen flex flex-col text-gray-200 overflow-hidden">
      {/* Background рендерится в App, не здесь - чтобы показывался во время проверки обновлений */}

      {/* Custom TitleBar - always on top */}
      <TitleBar
        onSettingsClick={() => {
          // Toggle: if already open, close; otherwise open with closeOtherModals
          if (showSettings()) {
            setShowSettings(false);
            setSettingsScrollTo(undefined);
          } else {
            openSettings();
          }
        }}
        onConnectClick={() => setShowConnect(!showConnect())}
        // Console button - only in developer mode
        onConsoleClick={developerMode() ? () => {
          // If console is detached, don't toggle - it's in separate window
          if (!consoleDetached()) {
            setShowConsole(!showConsole());
          }
        } : undefined}
        onDocsClick={() => {
          // Toggle: if already open, close; otherwise open
          if (showDocs()) {
            setShowDocs(false);
          } else {
            setShowSourceCode(false);
            setSourceCodePath(undefined);
            setSourceCodeLine(undefined);
            setShowDocs(true);
          }
        }}
        onChangelogClick={() => {
          // Toggle: if already open, close; otherwise open with closeOtherModals
          if (showChangelog()) {
            setShowChangelog(false);
          } else {
            openChangelog();
          }
        }}
        // Source Code button - only in developer mode
        onSourceCodeClick={developerMode() ? () => {
          // Toggle: if already open, close; otherwise open
          if (showSourceCode()) {
            setShowSourceCode(false);
            setSourceCodePath(undefined);
            setSourceCodeLine(undefined);
          } else {
            setShowDocs(false);
            setShowSourceCode(true);
          }
        } : undefined}
      />

      {/* Main row: content + console (right position) */}
      <div class="flex-1 flex overflow-hidden min-h-0 pt-[var(--titlebar-height)]">
        {/* Main Content Area */}
        <main class="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden">
          {/* Source Code Page (replaces normal content) */}
          <Show when={showSourceCode()}>
            <SourceCodePage
              onClose={() => {
                setShowSourceCode(false);
                setSourceCodePath(undefined);
                setSourceCodeLine(undefined);
              }}
              initialPath={sourceCodePath()}
              initialLine={sourceCodeLine()}
            />
          </Show>

          {/* Documentation Page (replaces normal content) */}
          <Show when={showDocs() && !showSourceCode()}>
            <DocumentationPage
              onClose={() => setShowDocs(false)}
              onOpenChangelog={openChangelog}
              onOpenSourceCode={openSourceCode}
            />
          </Show>

          {/* Normal content */}
          <Show when={!showSourceCode() && !showDocs()}>
          <div class="max-w-7xl mx-auto p-4 w-full flex-1 flex flex-col min-h-0 min-w-0">
            {/* Header */}
            <header class="mb-6 flex items-center justify-between">
              <p class="text-sm text-gray-500">
                {t().app.subtitle}
              </p>

              <div class="flex items-center gap-2">
                {/* Tools Dropdown - utility functions */}
                <Dropdown
                  trigger={
                    <button
                      class="btn-secondary"
                      title={t().common.tools}
                    >
                      <i class="i-hugeicons-wrench-01 w-4 h-4" />
                      {t().common.tools}
                      <i class={`w-3 h-3 transition-transform ${showToolsMenu() ? "i-hugeicons-arrow-up-01" : "i-hugeicons-arrow-down-01"}`} />
                    </button>
                  }
                  open={showToolsMenu()}
                  onToggle={() => setShowToolsMenu(!showToolsMenu())}
                  onClose={() => setShowToolsMenu(false)}
                >
                  <div class="p-1">
                    <button
                      class="dropdown-item"
                      onClick={() => {
                        openExternalLogAnalyzer();
                        setShowToolsMenu(false);
                      }}
                    >
                      <i class="i-hugeicons-file-view w-4 h-4 text-amber-400" />
                      {t().logAnalyzer?.analyzeExternal || t().instances.analyzeLogs}
                    </button>
                    <button
                      class="dropdown-item"
                      onClick={() => {
                        openSettingsSync();
                        setShowToolsMenu(false);
                      }}
                    >
                      <i class="i-hugeicons-refresh w-4 h-4 text-cyan-400" />
                      {t().sync?.title || "Sync Settings"}
                    </button>
                  </div>
                </Dropdown>

                  <button
                    class="btn-secondary bg-purple-600/10 border-purple-500/30 text-purple-400 hover:bg-purple-600/20 hover:border-purple-500/40"
                    onClick={openModpackBrowser}
                    title={t().modpacks.install}
                  >
                    <i class="i-hugeicons-package w-4 h-4" />
                    {t().modpacks.title}
                  </button>

                  <button
                    class="btn-primary"
                    onClick={openCreateForm}
                  >
                    <i class="i-hugeicons-add-01 w-4 h-4" />
                    {t().common.create}
                  </button>
                </div>
              </header>

              {/* Error Alert */}
              <Show when={error()}>
                <div class="mb-4 p-4 rounded-xl bg-red-500/10 border border-red-500/20 flex items-start gap-3">
                  <i class="i-hugeicons-alert-02 text-red-400 w-5 h-5 flex-shrink-0 mt-0.5" />
                  <div class="flex-1">
                    <h3 class="font-medium text-red-400">{t().common.error}</h3>
                    <p class="text-sm text-red-300/80 mt-1">{error()}</p>
                  </div>
                </div>
              </Show>

            {/* Instance List - flex container when detail view open, scrollable otherwise */}
            <div class={`flex-1 min-h-0 min-w-0 ${detailViewOpen() ? "flex flex-col" : "overflow-y-auto"}`}>
              <Show
                when={!loading()}
                fallback={
                  <div class="flex items-center justify-center py-20 gap-3">
                    <i class="i-svg-spinners-6-dots-scale w-8 h-8 text-blue-500" />
                    <span class="text-gray-400">{t().instances.loading}</span>
                  </div>
                }
              >
                <InstanceList
                  instances={instances()}
                  onStart={startInstance}
                  onStop={stopInstance}
                  onDelete={deleteInstance}
                  onRepair={repairInstance}
                  onConfigure={handleConfigure}
                  onCreateClick={openCreateForm}
                  onModpackClick={openModpackBrowser}
                  onImportServer={openImportServer}
                  onImportLauncher={openImportLauncher}
                  onDetailViewChange={setDetailViewOpen}
                />
              </Show>
            </div>

            {/* Quick Play Block - fixed at bottom, hidden when detail view is open */}
            <Show when={!detailViewOpen()}>
              <div class="flex-shrink-0 pt-4 pb-2">
                <QuickPlay
                  instances={instances()}
                  onInstanceCreated={load}
                />
              </div>
            </Show>
          </div>
          </Show>
        </main>

        {/* Console - right position (only if not detached) */}
        <Show when={showConsole() && !consoleDetached() && consoleLayout().position === "right"}>
          <DevConsole
            onClose={() => setShowConsole(false)}
            onResize={handleConsoleResize}
            onDetach={() => setShowConsole(false)}
          />
        </Show>
      </div>

      {/* Console - bottom position (only if not detached) */}
      <Show when={showConsole() && !consoleDetached() && consoleLayout().position === "bottom"}>
        <DevConsole
          onClose={() => setShowConsole(false)}
          onResize={handleConsoleResize}
          onDetach={() => setShowConsole(false)}
        />
      </Show>

      {/* Modal backdrop - covers entire screen including under titlebar */}
      <Show when={hasModal()}>
        <div class="fixed inset-0 bg-black/80 backdrop-blur-md z-40" />
      </Show>

      {/* Modals - fixed, centered with titlebar offset */}
      <Show when={showSettings()}>
        <Settings
          onClose={() => {
            setShowSettings(false);
            setSettingsScrollTo(undefined);
          }}
          scrollTo={settingsScrollTo()}
        />
      </Show>

      <Show when={showDownloadsPanel()}>
        <DownloadsPanel />
      </Show>

      <Show when={showConnect()}>
        <ConnectPanel
          onClose={() => setShowConnect(false)}
          onOpenSettings={openSettings}
        />
      </Show>

      <Show when={showSettingsSync()}>
        <SettingsSyncDialog
          instances={instances()}
          onClose={() => setShowSettingsSync(false)}
        />
      </Show>

      {/* External Log Analyzer - standalone without instance */}
      <Show when={showExternalLogAnalyzer()}>
        <ModalWrapper maxWidth="max-w-6xl">
          <div class="flex items-center justify-between p-4 border-b border-gray-750 flex-shrink-0">
            <div>
              <h2 class="text-xl font-bold">{t().logAnalyzer?.analyzeExternal || "Analyze Log File"}</h2>
              <p class="text-sm text-muted">{t().logAnalyzer?.analyzeExternalHint || "Open a log file from any location"}</p>
            </div>
            <button
              class="btn-close"
              onClick={() => setShowExternalLogAnalyzer(false)}
              aria-label={t().ui?.tooltips?.close ?? "Close"}
            >
              <i class="i-hugeicons-cancel-01 w-5 h-5" />
            </button>
          </div>
          <div class="flex-1 overflow-y-auto p-4">
            <LogAnalyzer onClose={() => setShowExternalLogAnalyzer(false)} />
          </div>
        </ModalWrapper>
      </Show>

      <Show when={showModpackBrowser()}>
        <ModalWrapper maxWidth="max-w-6xl">
          <ModpackBrowser
            onClose={() => {
              setShowModpackBrowser(false);
              setPendingModpackFile(null);
            }}
            onInstalled={handleModpackInstalled}
            instances={instances()}
            initialFile={pendingModpackFile()}
          />
        </ModalWrapper>
      </Show>

      <Show when={showModpackEditor()}>
        <ModalWrapper maxWidth="max-w-6xl" class="flex flex-col">
          <Show
            when={editingProject()}
            fallback={
              <ModpackProjectList
                onSelect={handleProjectSelect}
                onClose={() => setShowModpackEditor(false)}
              />
            }
          >
            <ModpackEditor
              project={editingProject()!}
              onBack={() => setEditingProject(null)}
              onInstanceCreated={handleProjectInstanceCreated}
            />
          </Show>
        </ModalWrapper>
      </Show>

      <Show when={showCreateForm()}>
        <ModalWrapper maxWidth="max-w-4xl">
          <div class="flex items-center justify-between p-4 border-b border-gray-750 flex-shrink-0">
            <h2 class="text-xl font-bold">{t().instances.creating}</h2>
            <button
              class="btn-close"
              onClick={() => setShowCreateForm(false)}
              aria-label={t().ui?.tooltips?.close ?? "Close"}
            >
              <i class="i-hugeicons-cancel-01 w-5 h-5" />
            </button>
          </div>
          <div class="p-4">
            <CreateInstanceForm
              onCreate={createInstance}
              onCreated={handleInstanceCreated}
              onCancel={() => setShowCreateForm(false)}
            />
          </div>
        </ModalWrapper>
      </Show>

      <Show when={installingInstance()}>
        <InstallProgressModal
          instanceId={installingInstance()!.id}
          instanceName={installingInstance()!.name}
          onComplete={handleInstallComplete}
          onError={handleInstallError}
        />
      </Show>

      <Show when={editingInstance()}>
        <EditInstanceDialog
          instance={editingInstance()!}
          onClose={() => setEditingInstance(null)}
          onSaved={handleEditSaved}
        />
      </Show>

      {/* UI Kit (dev mode) */}
      <Show when={showUIKit()}>
        <UIKit onClose={() => setShowUIKit(false)} />
      </Show>

      {/* Dev Tests (dev mode) */}
      <Show when={showDevTests()}>
        <DevTests onClose={() => setShowDevTests(false)} />
      </Show>

      {/* Import Server Dialog */}
      <Show when={showImportServer()}>
        <ImportServerDialog
          onClose={() => setShowImportServer(false)}
          onImported={() => {
            setShowImportServer(false);
            load(); // Refresh instance list
          }}
        />
      </Show>

      {/* Import from Launcher Dialog */}
      <Show when={showImportLauncher()}>
        <LauncherImportDialog
          isOpen={showImportLauncher()}
          onClose={() => setShowImportLauncher(false)}
          onImported={() => {
            setShowImportLauncher(false);
            load(); // Refresh instance list
          }}
        />
      </Show>

      {/* Changelog Modal */}
      <Show when={showChangelog()}>
        <div class="modal-overlay">
          <ChangelogModal onClose={() => setShowChangelog(false)} />
        </div>
      </Show>

      {/* Fixed overlays */}
      <ErrorReporter />
    </div>
  );
}

// Console-only view for detached window
function ConsoleOnlyView() {
  const appWindow = getCurrentWindow();

  const handleClose = async () => {
    // Notify main window that console is being re-attached
    await emit("console-attached");
    // Close this window
    await appWindow.close();
  };

  onMount(async () => {
    // Handle native window close (X button)
    const unlisten = await appWindow.onCloseRequested(async (event) => {
      // Prevent default close, emit event first
      event.preventDefault();
      await emit("console-attached");
      await appWindow.destroy();
    });

    // Show window immediately
    try {
      await appWindow.show();
    } catch (e) {
      console.error('Failed to show console window:', e);
    }

    // Cleanup on unmount
    onCleanup(() => {
      unlisten();
    });
  });

  return (
    <div class="h-screen w-screen bg-gray-950">
      <DevConsole
        detached={true}
        onClose={handleClose}
      />
    </div>
  );
}

// Check if we're in console-only mode
function isConsoleMode() {
  const params = new URLSearchParams(window.location.search);
  return params.get("mode") === "console";
}

function App() {
  // Check for console-only mode first
  if (isConsoleMode()) {
    return <ConsoleOnlyView />;
  }

  // Load language from settings
  const [language, setLanguage] = createSignal<Language>('ru');
  const [updateCheckComplete, setUpdateCheckComplete] = createSignal(false);

  // Load language and show window on mount
  onMount(async () => {
    const appWindow = getCurrentWindow();

    // Initialize mod install tracking (global state for installing mods)
    initModInstallTracking();

    // Initialize download listener (for TitleBar downloads button)
    initDownloadListener();

    // Initialize drag & drop listener (global file drop handler)
    await initDragDrop();

    // Load language from settings
    try {
      const settings = await invoke<AppSettings>('get_settings');
      if (settings.language) {
        setLanguage(settings.language);
      }
    } catch (e) {
      console.warn('Failed to load language from settings, using default (ru):', e);
    }

    // Wait for fonts and show window
    try {
      await document.fonts.ready;
    } catch {
      // Fallback if fonts API not available
    }

    // Maximize and show window after styles are applied
    requestAnimationFrame(() => {
      requestAnimationFrame(async () => {
        try {
          await appWindow.maximize();
          await appWindow.show();
        } catch (e) {
          console.error('Failed to show window:', e);
        }
      });
    });
  });

  onCleanup(() => {
    cleanupDragDrop();
  });

  return (
    <I18nProvider initialLanguage={language()}>
      {/* Фон загружается сразу, пока идёт проверка обновлений */}
      <AppBackground />

      <Show
        when={updateCheckComplete()}
        fallback={<AutoUpdater onReady={() => setUpdateCheckComplete(true)} />}
      >
        <AppContent />
      </Show>

      {/* Toast notifications */}
      <ToastProvider />

      {/* Drag & Drop overlay */}
      <DragDropOverlay />
    </I18nProvider>
  );
}

export default App;