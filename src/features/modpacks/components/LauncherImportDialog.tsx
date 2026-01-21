import { For, Show, createSignal, onMount, onCleanup } from "solid-js";
import type { Component } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  DetectedLauncher,
  LauncherInstance,
  LauncherImportProgress,
  LauncherImportResult,
  MinecraftFolderAnalysis,
} from "../../../shared/types";
import { ModalWrapper } from "../../../shared/ui";
import { useI18n } from "../../../shared/i18n";
import { formatSize } from "../../../shared/utils/format-size";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onImported: (instanceId: string, instanceName: string) => void;
}

type ImportMode = "auto" | "manual" | "folder";

const LauncherImportDialog: Component<Props> = (props) => {
  const { t } = useI18n();

  // State
  const [mode, setMode] = createSignal<ImportMode>("auto");
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // Auto-detected launchers
  const [detectedLaunchers, setDetectedLaunchers] = createSignal<DetectedLauncher[]>([]);
  const [selectedLauncher, setSelectedLauncher] = createSignal<DetectedLauncher | null>(null);

  // Instances from selected launcher
  const [instances, setInstances] = createSignal<LauncherInstance[]>([]);
  const [selectedInstance, setSelectedInstance] = createSignal<LauncherInstance | null>(null);
  const [instancesLoading, setInstancesLoading] = createSignal(false);

  // Folder analysis (for manual import)
  const [folderPath, setFolderPath] = createSignal<string>("");
  const [folderAnalysis, setFolderAnalysis] = createSignal<MinecraftFolderAnalysis | null>(null);
  const [folderAnalyzing, setFolderAnalyzing] = createSignal(false);

  // Import settings
  const [newInstanceName, setNewInstanceName] = createSignal("");
  const [includeWorlds, setIncludeWorlds] = createSignal(false);

  // Import progress
  const [importing, setImporting] = createSignal(false);
  const [importProgress, setImportProgress] = createSignal<LauncherImportProgress | null>(null);
  const [importResult, setImportResult] = createSignal<LauncherImportResult | null>(null);

  // Detect launchers on mount
  onMount(async () => {
    await detectLaunchers();
  });

  // Listen for import progress events
  onMount(() => {
    const unlistenProgress = listen<LauncherImportProgress>("launcher-import-progress", (event) => {
      setImportProgress(event.payload);
    });

    const unlistenCompleted = listen<{ instance_id: string; name: string }>(
      "launcher-import-completed",
      (event) => {
        setImporting(false);
        props.onImported(event.payload.instance_id, event.payload.name);
      }
    );

    onCleanup(() => {
      unlistenProgress.then((fn) => fn());
      unlistenCompleted.then((fn) => fn());
    });
  });

  // Auto-detect installed launchers
  async function detectLaunchers() {
    setLoading(true);
    setError(null);
    try {
      const launchers = await invoke<DetectedLauncher[]>("detect_launchers");
      setDetectedLaunchers(launchers);

      // Auto-select first launcher if only one found
      if (launchers.length === 1) {
        await selectLauncher(launchers[0]);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  // Select a launcher and load its instances
  async function selectLauncher(launcher: DetectedLauncher) {
    setSelectedLauncher(launcher);
    setSelectedInstance(null);
    setInstances([]);
    setInstancesLoading(true);
    setError(null);

    try {
      const launcherInstances = await invoke<LauncherInstance[]>(
        "list_detected_launcher_instances",
        { launcher }
      );
      setInstances(launcherInstances);
    } catch (e) {
      setError(String(e));
    } finally {
      setInstancesLoading(false);
    }
  }

  // Select an instance for import
  function selectInstance(instance: LauncherInstance) {
    setSelectedInstance(instance);
    setNewInstanceName(instance.name);
  }

  // Browse for folder (manual import)
  async function browseFolder() {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t().modpacks.launcherImport.selectFolder,
      });

      if (selected && typeof selected === "string") {
        setFolderPath(selected);
        await analyzeFolder(selected);
      }
    } catch (e) {
      setError(String(e));
    }
  }

  // Analyze a .minecraft folder
  async function analyzeFolder(path: string) {
    setFolderAnalyzing(true);
    setError(null);
    setFolderAnalysis(null);

    try {
      const analysis = await invoke<MinecraftFolderAnalysis>("analyze_minecraft_folder", {
        path,
      });
      setFolderAnalysis(analysis);

      // Set default name from folder name
      const folderName = path.split(/[/\\]/).pop() || "Imported Instance";
      setNewInstanceName(folderName);
    } catch (e) {
      setError(String(e));
    } finally {
      setFolderAnalyzing(false);
    }
  }

  // Start import
  async function startImport() {
    if (importing()) return;

    setImporting(true);
    setImportProgress(null);
    setImportResult(null);
    setError(null);

    try {
      let result: LauncherImportResult;

      if (mode() === "folder" && folderPath()) {
        // Import from folder
        result = await invoke<LauncherImportResult>("import_minecraft_folder", {
          path: folderPath(),
          name: newInstanceName(),
          includeWorlds: includeWorlds(),
        });
      } else if (selectedInstance()) {
        // Import from launcher
        result = await invoke<LauncherImportResult>("import_launcher_instance", {
          instance: selectedInstance(),
          newName: newInstanceName(),
          includeWorlds: includeWorlds(),
        });
      } else {
        throw new Error("No instance selected");
      }

      setImportResult(result);
      props.onImported(result.instance_id, newInstanceName());
    } catch (e) {
      setError(String(e));
      setImporting(false);
    }
  }

  // Localized size formatter
  const fmtSize = (bytes: number) => formatSize(bytes, t().ui?.units);

  // Get launcher icon
  function getLauncherIcon(type: string): string {
    switch (type) {
      case "prism":
        return "i-hugeicons-prisma";
      case "multimc":
        return "i-hugeicons-cube-01";
      case "curseforge_app":
        return "i-hugeicons-fire";
      case "modrinth":
        return "i-hugeicons-leaf-01";
      default:
        return "i-hugeicons-package";
    }
  }

  // Get progress phase text
  function getPhaseText(phase: string): string {
    switch (phase) {
      case "creating_instance":
        return t().modpacks.launcherImport.phaseCreating;
      case "scanning":
        return t().modpacks.launcherImport.phaseScanning;
      case "copying":
        return t().modpacks.launcherImport.phaseCopying;
      case "saving":
        return t().modpacks.launcherImport.phaseSaving;
      case "syncing_mods":
        return t().modpacks.launcherImport.phaseSyncing;
      default:
        return phase;
    }
  }

  // Can we start import?
  const canImport = () => {
    if (importing()) return false;
    if (!newInstanceName().trim()) return false;

    if (mode() === "folder") {
      return !!folderPath() && !!folderAnalysis();
    }

    return !!selectedInstance();
  };

  return (
    <Show when={props.isOpen}>
      <ModalWrapper maxWidth="max-w-4xl">
        {/* Header */}
        <div class="flex items-center justify-between p-4 border-b border-gray-750 flex-shrink-0">
          <h2 class="text-xl font-bold">{t().modpacks.launcherImport.title}</h2>
          <button
            class="btn-close"
            onClick={props.onClose}
          >
            <i class="i-hugeicons-cancel-01 w-5 h-5" />
          </button>
        </div>

        <div class="flex flex-col gap-4 p-4 h-[600px] overflow-hidden">
          {/* Mode tabs */}
          <div class="flex gap-2 border-b border-gray-700 pb-2 flex-shrink-0">
            <button
              class={`px-4 py-2 rounded-t-lg transition-colors inline-flex items-center gap-2 ${
                mode() === "auto"
                  ? "bg-blue-600 text-white"
                  : "bg-gray-800 text-gray-400 hover:text-white"
              }`}
              onClick={() => setMode("auto")}
            >
              <i class="i-hugeicons-search-01 w-4 h-4" />
              {t().modpacks.launcherImport.autoDetect}
            </button>
            <button
              class={`px-4 py-2 rounded-t-lg transition-colors inline-flex items-center gap-2 ${
                mode() === "folder"
                  ? "bg-blue-600 text-white"
                  : "bg-gray-800 text-gray-400 hover:text-white"
              }`}
              onClick={() => setMode("folder")}
            >
              <i class="i-hugeicons-folder-01 w-4 h-4" />
              {t().modpacks.launcherImport.fromFolder}
            </button>
          </div>

          {/* Error display */}
          <Show when={error()}>
            <div class="bg-red-900/50 border border-red-500 rounded-lg p-3 flex items-center gap-2 flex-shrink-0">
              <i class="i-hugeicons-alert-02 w-5 h-5 text-red-400" />
              <span class="text-red-200">{error()}</span>
            </div>
          </Show>

          {/* Auto-detect mode */}
          <Show when={mode() === "auto"}>
            <div class="flex-1 flex gap-4 min-h-0 overflow-hidden">
            {/* Launchers list */}
            <div class="w-64 flex flex-col gap-2 flex-shrink-0">
              <div class="text-sm text-gray-400 mb-1">
                {t().modpacks.launcherImport.detectedLaunchers}
              </div>

              <Show when={loading()}>
                <div class="flex items-center justify-center py-8">
                  <i class="i-svg-spinners-ring-resize w-6 h-6 text-blue-400" />
                </div>
              </Show>

              <Show when={!loading() && detectedLaunchers().length === 0}>
                <div class="text-gray-500 text-center py-8">
                  {t().modpacks.launcherImport.noLaunchersFound}
                </div>
              </Show>

              <div class="flex flex-col gap-1 overflow-y-auto">
                <For each={detectedLaunchers()}>
                  {(launcher) => (
                    <button
                      class={`flex items-center gap-3 p-3 rounded-lg transition-colors text-left ${
                        selectedLauncher()?.root_path === launcher.root_path
                          ? "bg-blue-600/20 border border-blue-500"
                          : "bg-gray-800 hover:bg-gray-700 border border-transparent"
                      }`}
                      onClick={() => selectLauncher(launcher)}
                    >
                      <i class={`${getLauncherIcon(launcher.launcher_type)} w-6 h-6`} />
                      <div class="flex-1 min-w-0">
                        <div class="font-medium truncate">{launcher.display_name}</div>
                        <div class="text-xs text-gray-400">
                          {launcher.instance_count} {t().modpacks.launcherImport.instances}
                        </div>
                      </div>
                    </button>
                  )}
                </For>
              </div>

              <button
                class="btn-ghost text-sm mt-2"
                onClick={detectLaunchers}
                disabled={loading()}
              >
                <i class="i-hugeicons-refresh w-4 h-4 mr-1" />
                {t().modpacks.launcherImport.refresh}
              </button>
            </div>

            {/* Instances list */}
            <div class="flex-1 flex flex-col min-h-0 min-w-0">
              <Show when={selectedLauncher()}>
                <div class="text-sm text-gray-400 mb-2">
                  {t().modpacks.launcherImport.instancesIn} {selectedLauncher()?.display_name}
                </div>

                <Show when={instancesLoading()}>
                  <div class="flex items-center justify-center py-8">
                    <i class="i-svg-spinners-ring-resize w-6 h-6 text-blue-400" />
                  </div>
                </Show>

                <div class="flex-1 overflow-y-auto space-y-1">
                  <For each={instances()}>
                    {(instance) => (
                      <button
                        class={`w-full flex items-center gap-3 p-3 rounded-lg transition-colors text-left ${
                          selectedInstance()?.path === instance.path
                            ? "bg-blue-600/20 border border-blue-500"
                            : "bg-gray-800 hover:bg-gray-700 border border-transparent"
                        }`}
                        onClick={() => selectInstance(instance)}
                      >
                        <div class="w-10 h-10 bg-gray-700 rounded-lg flex items-center justify-center flex-shrink-0">
                          <i class="i-hugeicons-package w-6 h-6 text-gray-400" />
                        </div>
                        <div class="flex-1 min-w-0">
                          <div class="font-medium truncate">{instance.name}</div>
                          <div class="flex items-center gap-2 text-xs text-gray-400">
                            <span>{instance.minecraft_version}</span>
                            <Show when={instance.loader !== "vanilla"}>
                              <span class="px-1.5 py-0.5 bg-gray-700 rounded">
                                {instance.loader}
                              </span>
                            </Show>
                            <span>{instance.mods_count} mods</span>
                          </div>
                        </div>
                        <div class="text-xs text-gray-500 flex-shrink-0">
                          {fmtSize(instance.total_size)}
                        </div>
                      </button>
                    )}
                  </For>
                </div>
              </Show>

              <Show when={!selectedLauncher()}>
                <div class="flex-1 flex items-center justify-center text-gray-500">
                  {t().modpacks.launcherImport.selectLauncher}
                </div>
              </Show>
            </div>
          </div>
        </Show>

        {/* Folder import mode */}
        <Show when={mode() === "folder"}>
          <div class="flex-1 flex flex-col gap-4">
            <div class="flex gap-2">
              <input
                type="text"
                class="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm"
                value={folderPath()}
                onInput={(e) => setFolderPath(e.currentTarget.value)}
                placeholder={t().modpacks.launcherImport.folderPath}
              />
              <button class="btn-secondary" onClick={browseFolder}>
                <i class="i-hugeicons-folder-open w-4 h-4 mr-1" />
                {t().common.browse}
              </button>
            </div>

            <Show when={folderAnalyzing()}>
              <div class="flex items-center justify-center py-8">
                <i class="i-svg-spinners-ring-resize w-6 h-6 text-blue-400 mr-2" />
                <span class="text-gray-400">{t().modpacks.launcherImport.analyzing}</span>
              </div>
            </Show>

            <Show when={folderAnalysis()}>
              <div class="bg-gray-800 rounded-lg p-4 space-y-3">
                <div class="flex items-center gap-2">
                  <i class="i-hugeicons-checkmark-circle-02 w-5 h-5 text-green-400" />
                  <span class="font-medium">{t().modpacks.launcherImport.folderAnalyzed}</span>
                </div>

                <div class="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span class="text-gray-400">Minecraft:</span>{" "}
                    <span class="font-medium">
                      {folderAnalysis()?.minecraft_version || "Unknown"}
                    </span>
                  </div>
                  <div>
                    <span class="text-gray-400">{t().common.loader}:</span>{" "}
                    <span class="font-medium">{folderAnalysis()?.loader}</span>
                  </div>
                  <div>
                    <span class="text-gray-400">{t().common.mods}:</span>{" "}
                    <span class="font-medium">{folderAnalysis()?.mods_count}</span>
                  </div>
                  <div>
                    <span class="text-gray-400">{t().modpacks.launcherImport.confidence}:</span>{" "}
                    <span class="font-medium">{folderAnalysis()?.confidence}%</span>
                  </div>
                </div>

                <Show when={folderAnalysis()?.suspicious_files.length}>
                  <div class="bg-yellow-900/30 border border-yellow-600/50 rounded-lg p-3">
                    <div class="flex items-center gap-2 text-yellow-400 mb-2">
                      <i class="i-hugeicons-alert-02 w-4 h-4" />
                      <span class="font-medium">
                        {t().modpacks.launcherImport.suspiciousFiles}
                      </span>
                    </div>
                    <div class="text-xs text-yellow-200/80 space-y-1">
                      <For each={folderAnalysis()?.suspicious_files.slice(0, 5)}>
                        {(file) => <div class="truncate">{file}</div>}
                      </For>
                      <Show when={(folderAnalysis()?.suspicious_files.length || 0) > 5}>
                        <div class="text-yellow-300">
                          +{(folderAnalysis()?.suspicious_files.length || 0) - 5} more...
                        </div>
                      </Show>
                    </div>
                  </div>
                </Show>
              </div>
            </Show>
          </div>
        </Show>

        {/* Import settings */}
        <Show when={(mode() === "auto" && selectedInstance()) || (mode() === "folder" && folderAnalysis())}>
          <div class="border-t border-gray-700 pt-4 space-y-3">
            <div class="flex items-center gap-4">
              <label class="text-sm text-gray-400 w-32">
                {t().modpacks.launcherImport.instanceName}
              </label>
              <input
                type="text"
                class="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm"
                value={newInstanceName()}
                onInput={(e) => setNewInstanceName(e.currentTarget.value)}
                placeholder={t().modpacks.launcherImport.enterName}
              />
            </div>

            <div class="flex items-center gap-4">
              <label class="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  class="w-4 h-4 rounded bg-gray-700 border-gray-600"
                  checked={includeWorlds()}
                  onChange={(e) => setIncludeWorlds(e.currentTarget.checked)}
                />
                <span class="text-sm">{t().modpacks.launcherImport.includeWorlds}</span>
              </label>
            </div>
          </div>
        </Show>

        {/* Import progress */}
        <Show when={importing() && importProgress()}>
          <div class="bg-gray-800 rounded-lg p-4">
            <div class="flex items-center gap-3 mb-3">
              <i class="i-svg-spinners-ring-resize w-5 h-5 text-blue-400" />
              <span class="font-medium">{getPhaseText(importProgress()!.phase)}</span>
            </div>

            <div class="h-2 bg-gray-700 rounded-full overflow-hidden mb-2">
              <div
                class="h-full bg-blue-500 transition-all duration-300"
                style={{
                  width: `${
                    importProgress()!.total > 0
                      ? (importProgress()!.current / importProgress()!.total) * 100
                      : 0
                  }%`,
                }}
              />
            </div>

            <div class="flex justify-between text-xs text-gray-400">
              <span>
                {importProgress()!.current} / {importProgress()!.total}
              </span>
              <span>
                {fmtSize(importProgress()!.bytes_copied)} /{" "}
                {fmtSize(importProgress()!.total_bytes)}
              </span>
            </div>

            <Show when={importProgress()?.current_file}>
              <div class="text-xs text-gray-500 mt-2 truncate">
                {importProgress()?.current_file}
              </div>
            </Show>
          </div>
        </Show>

        {/* Import result */}
        <Show when={importResult()}>
          <div class="bg-green-900/30 border border-green-600/50 rounded-lg p-4">
            <div class="flex items-center gap-2 text-green-400 mb-3">
              <i class="i-hugeicons-checkmark-circle-02 w-5 h-5" />
              <span class="font-medium">{t().modpacks.launcherImport.importComplete}</span>
            </div>

            <div class="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span class="text-gray-400">{t().modpacks.launcherImport.filesCopied}:</span>{" "}
                <span class="font-medium">{importResult()?.files_copied}</span>
              </div>
              <div>
                <span class="text-gray-400">{t().modpacks.launcherImport.modsImported}:</span>{" "}
                <span class="font-medium">{importResult()?.mods_imported}</span>
              </div>
              <div>
                <span class="text-gray-400">{t().modpacks.launcherImport.totalSize}:</span>{" "}
                <span class="font-medium">{fmtSize(importResult()?.total_size || 0)}</span>
              </div>
            </div>

            <Show when={importResult()?.warnings.length}>
              <div class="mt-3 text-xs text-yellow-400">
                <For each={importResult()?.warnings}>
                  {(warning) => <div>⚠️ {warning}</div>}
                </For>
              </div>
            </Show>
          </div>
        </Show>

        {/* Actions */}
        <div class="flex justify-end gap-2 pt-2 border-t border-gray-700">
          <button class="btn-secondary" onClick={props.onClose}>
            {importResult() ? t().common.close : t().common.cancel}
          </button>
          <Show when={!importResult()}>
            <button
              class="btn-primary"
              disabled={!canImport()}
              onClick={startImport}
            >
              <Show when={importing()}>
                <i class="i-svg-spinners-ring-resize w-4 h-4 mr-1" />
              </Show>
              {t().modpacks.launcherImport.startImport}
            </button>
          </Show>
        </div>
      </div>
      </ModalWrapper>
    </Show>
  );
};

export default LauncherImportDialog;
