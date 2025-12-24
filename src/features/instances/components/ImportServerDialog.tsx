import { createSignal, Show, For, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { ModalWrapper } from "../../../shared/ui/ModalWrapper";
import { useI18n } from "../../../shared/i18n";

interface ImportProgress {
  phase: string;
  current: number;
  total: number;
  current_file: string | null;
  bytes_copied: number;
  total_bytes: number;
}

interface DetectedServer {
  loader: string;
  minecraft_version: string | null;
  loader_version: string | null;
  server_jar: string | null;
  properties: {
    port: number;
    motd: string;
    max_players: number;
    [key: string]: unknown;
  } | null;
  confidence: number;
  evidence: string[];
  mods_count: number;
  eula_accepted: boolean;
}

interface ImportResult {
  instance_id: string;
  detected: DetectedServer;
  files_copied: number;
  total_size: number;
}

interface Props {
  onClose: () => void;
  onImported: (instanceId: string) => void;
}

export default function ImportServerDialog(props: Props) {
  const { t } = useI18n();

  const [serverPath, setServerPath] = createSignal<string | null>(null);
  const [detecting, setDetecting] = createSignal(false);
  const [detected, setDetected] = createSignal<DetectedServer | null>(null);
  const [detectError, setDetectError] = createSignal<string | null>(null);

  const [instanceName, setInstanceName] = createSignal("");
  const [importing, setImporting] = createSignal(false);
  const [importProgress, setImportProgress] = createSignal<ImportProgress | null>(null);
  const [importError, setImportError] = createSignal<string | null>(null);
  const [importResult, setImportResult] = createSignal<ImportResult | null>(null);

  // Listen for progress events
  let unlisten: UnlistenFn | null = null;

  const setupProgressListener = async () => {
    unlisten = await listen<ImportProgress>("server-import-progress", (event) => {
      setImportProgress(event.payload);
    });
  };

  onCleanup(() => {
    if (unlisten) unlisten();
  });

  // Select server folder
  const handleSelectFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Выберите папку сервера",
      });

      if (selected && typeof selected === "string") {
        setServerPath(selected);
        setDetected(null);
        setDetectError(null);
        setImportResult(null);
        await detectServer(selected);
      }
    } catch (e) {
      console.error("Failed to select folder:", e);
    }
  };

  // Detect server type
  const detectServer = async (path: string) => {
    setDetecting(true);
    setDetectError(null);

    try {
      const result = await invoke<DetectedServer>("detect_server_type", { path });
      setDetected(result);

      // Generate default name from folder
      const folderName = path.split(/[/\\]/).pop() || "server";
      setInstanceName(folderName);
    } catch (e) {
      setDetectError(String(e));
    } finally {
      setDetecting(false);
    }
  };

  // Import server
  const handleImport = async () => {
    const path = serverPath();
    const name = instanceName().trim();

    if (!path || !name) return;

    setImporting(true);
    setImportError(null);
    setImportProgress(null);

    // Set up progress listener before starting import
    await setupProgressListener();

    try {
      const result = await invoke<ImportResult>("import_existing_server", {
        sourcePath: path,
        instanceName: name,
      });
      setImportResult(result);
    } catch (e) {
      setImportError(String(e));
    } finally {
      setImporting(false);
      setImportProgress(null);
      if (unlisten) {
        unlisten();
        unlisten = null;
      }
    }
  };

  // Get phase label
  const getPhaseLabel = (phase: string): string => {
    const phases: Record<string, string> = {
      detecting: t().server.import.phases.detecting,
      scanning: t().server.import.phases.scanning,
      copying: t().server.import.phases.copying,
      saving: t().server.import.phases.saving,
      scanning_mods: t().server.import.phases.scanningMods,
    };
    return phases[phase] || phase;
  };

  // Format bytes
  const formatSize = (bytes: number): string => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  // Get loader display name
  const getLoaderName = (loader: string): string => {
    const loaders: Record<string, string> = {
      vanilla: "Vanilla",
      forge: "Forge",
      neoforge: "NeoForge",
      fabric: "Fabric",
      quilt: "Quilt",
      paper: "Paper",
      spigot: "Spigot",
      purpur: "Purpur",
    };
    return loaders[loader.toLowerCase()] || loader;
  };

  // Get confidence color
  const getConfidenceColor = (confidence: number): string => {
    if (confidence >= 70) return "text-green-400";
    if (confidence >= 40) return "text-yellow-400";
    return "text-red-400";
  };

  return (
    <ModalWrapper maxWidth="max-w-2xl">
      <div class="p-6">
        {/* Header */}
        <div class="flex items-center justify-between mb-6">
          <h2 class="text-xl font-bold text-white flex items-center gap-2">
            <i class="i-hugeicons-upload-02 w-6 h-6 text-blue-400" />
            {t().server.import.title}
          </h2>
          <button
            class="btn-close"
            onClick={props.onClose}
          >
            <i class="i-hugeicons-cancel-01 w-5 h-5" />
          </button>
        </div>

        {/* Success state */}
        <Show when={importResult()}>
          {(result) => (
            <div class="space-y-4">
              <div class="p-4 bg-green-900/30 border border-green-700/50 rounded-lg">
                <div class="flex items-center gap-3 mb-3">
                  <i class="i-hugeicons-checkmark-circle-02 w-8 h-8 text-green-400" />
                  <div>
                    <div class="text-lg font-medium text-green-300">{t().server.import.success}</div>
                    <div class="text-sm text-green-400/70">
                      {result().files_copied} {t().server.import.files}, {formatSize(result().total_size)}
                    </div>
                  </div>
                </div>
              </div>

              <div class="flex justify-end gap-3">
                <button class="btn-secondary" onClick={props.onClose}>
                  {t().common.close}
                </button>
                <button
                  class="btn-primary"
                  onClick={() => props.onImported(result().instance_id)}
                >
                  {t().server.import.openServer}
                </button>
              </div>
            </div>
          )}
        </Show>

        {/* Main content */}
        <Show when={!importResult()}>
          <div class="space-y-4">
            {/* Folder selection */}
            <div>
              <label class="block text-sm text-gray-400 mb-2">{t().server.import.serverFolder}</label>
              <div class="flex gap-2">
                <input
                  type="text"
                  value={serverPath() || ""}
                  readonly
                  placeholder={t().server.import.selectFolder}
                  class="flex-1 px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500"
                />
                <button
                  class="btn-secondary px-4"
                  onClick={handleSelectFolder}
                  disabled={detecting() || importing()}
                >
                  <i class="i-hugeicons-folder-01 w-4 h-4" />
                  {t().server.import.browse}
                </button>
              </div>
            </div>

            {/* Detecting spinner */}
            <Show when={detecting()}>
              <div class="p-4 bg-gray-800 rounded-lg flex items-center justify-center gap-3">
                <i class="i-svg-spinners-ring-resize w-5 h-5 text-blue-400" />
                <span class="text-gray-300">{t().server.import.detecting}</span>
              </div>
            </Show>

            {/* Detection error */}
            <Show when={detectError()}>
              <div class="p-4 bg-red-900/30 border border-red-700/50 rounded-lg">
                <div class="flex items-start gap-2">
                  <i class="i-hugeicons-alert-02 w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <div class="text-sm font-medium text-red-300">{t().server.import.detectError}</div>
                    <div class="text-xs text-red-400/70 mt-1">{detectError()}</div>
                  </div>
                </div>
              </div>
            </Show>

            {/* Detection results */}
            <Show when={detected()}>
              {(server) => (
                <div class="space-y-4">
                  {/* Server info card */}
                  <div class="p-4 bg-gray-800 rounded-lg space-y-3">
                    <div class="flex items-center justify-between">
                      <span class="text-sm text-gray-400">{t().server.import.serverType}</span>
                      <span class="text-white font-medium">{getLoaderName(server().loader)}</span>
                    </div>

                    <Show when={server().minecraft_version}>
                      <div class="flex items-center justify-between">
                        <span class="text-sm text-gray-400">{t().server.import.minecraftVersion}</span>
                        <span class="text-white">{server().minecraft_version}</span>
                      </div>
                    </Show>

                    <Show when={server().loader_version}>
                      <div class="flex items-center justify-between">
                        <span class="text-sm text-gray-400">{t().server.import.loaderVersion}</span>
                        <span class="text-white">{server().loader_version}</span>
                      </div>
                    </Show>

                    <Show when={server().mods_count > 0}>
                      <div class="flex items-center justify-between">
                        <span class="text-sm text-gray-400">{t().server.import.modsCount}</span>
                        <span class="text-white">{server().mods_count}</span>
                      </div>
                    </Show>

                    <Show when={server().properties}>
                      <div class="flex items-center justify-between">
                        <span class="text-sm text-gray-400">{t().server.import.port}</span>
                        <span class="text-white">{server().properties!.port}</span>
                      </div>
                      <div class="flex items-center justify-between">
                        <span class="text-sm text-gray-400">{t().server.import.maxPlayers}</span>
                        <span class="text-white">{server().properties!.max_players}</span>
                      </div>
                    </Show>

                    <div class="flex items-center justify-between">
                      <span class="text-sm text-gray-400">{t().server.import.eulaAccepted}</span>
                      <span class={server().eula_accepted ? "text-green-400" : "text-amber-400"}>
                        {server().eula_accepted ? t().common.yes : t().common.no}
                      </span>
                    </div>

                    <div class="flex items-center justify-between">
                      <span class="text-sm text-gray-400">{t().server.import.confidence}</span>
                      <span class={getConfidenceColor(server().confidence)}>
                        {server().confidence}%
                      </span>
                    </div>
                  </div>

                  {/* Evidence details (collapsible) */}
                  <Show when={server().evidence.length > 0}>
                    <details class="group">
                      <summary class="text-xs text-gray-500 cursor-pointer hover:text-gray-400 flex items-center gap-1">
                        <i class="i-hugeicons-arrow-right-01 w-3 h-3 group-open:rotate-90 transition-transform" />
                        {t().server.import.detectionDetails} ({server().evidence.length})
                      </summary>
                      <div class="mt-2 p-3 bg-gray-800/50 rounded-lg text-xs text-gray-400 space-y-1">
                        <For each={server().evidence}>
                          {(item) => (
                            <div class="flex items-start gap-2">
                              <i class="i-hugeicons-checkmark-circle-02 w-3 h-3 text-green-500 flex-shrink-0 mt-0.5" />
                              <span>{item}</span>
                            </div>
                          )}
                        </For>
                      </div>
                    </details>
                  </Show>

                  {/* Instance name input */}
                  <div>
                    <label class="block text-sm text-gray-400 mb-2">{t().server.import.name}</label>
                    <input
                      type="text"
                      value={instanceName()}
                      onInput={(e) => setInstanceName(e.currentTarget.value)}
                      placeholder={t().server.import.namePlaceholder}
                      class="w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
                    />
                  </div>

                  {/* Import error */}
                  <Show when={importError()}>
                    <div class="p-3 bg-red-900/30 border border-red-700/50 rounded-lg">
                      <div class="text-sm text-red-300">{importError()}</div>
                    </div>
                  </Show>

                  {/* Import progress */}
                  <Show when={importing() && importProgress()}>
                    {(progress) => (
                      <div class="p-4 bg-gray-800 rounded-lg space-y-3">
                        <div class="flex items-center gap-3">
                          <i class="i-svg-spinners-ring-resize w-5 h-5 text-blue-400" />
                          <span class="text-gray-300">{getPhaseLabel(progress().phase)}</span>
                        </div>

                        <Show when={progress().phase === "copying"}>
                          {/* Progress bar */}
                          <div class="h-2 bg-gray-700 rounded-full overflow-hidden">
                            <div
                              class="h-full bg-blue-500 transition-all duration-150"
                              style={{
                                width: `${Math.round((progress().current / Math.max(progress().total, 1)) * 100)}%`
                              }}
                            />
                          </div>

                          {/* Stats */}
                          <div class="flex items-center justify-between text-xs text-gray-400">
                            <span>
                              {progress().current.toLocaleString()} / {progress().total.toLocaleString()} файлов
                            </span>
                            <span>
                              {formatSize(progress().bytes_copied)} / {formatSize(progress().total_bytes)}
                            </span>
                          </div>

                          {/* Current file */}
                          <Show when={progress().current_file}>
                            <div class="text-xs text-gray-500 truncate">
                              {progress().current_file}
                            </div>
                          </Show>
                        </Show>
                      </div>
                    )}
                  </Show>
                </div>
              )}
            </Show>

            {/* Actions */}
            <div class="flex justify-end gap-3 pt-4 border-t border-gray-700">
              <button class="btn-secondary" onClick={props.onClose} disabled={importing()}>
                {t().common.cancel}
              </button>
              <button
                class="btn-primary"
                onClick={handleImport}
                disabled={!detected() || !instanceName().trim() || importing()}
              >
                <Show when={importing()} fallback={
                  <>
                    <i class="i-hugeicons-upload-02 w-4 h-4" />
                    {t().server.import.importBtn}
                  </>
                }>
                  <i class="i-svg-spinners-ring-resize w-4 h-4" />
                  {t().server.import.importing}
                </Show>
              </button>
            </div>
          </div>
        </Show>
      </div>
    </ModalWrapper>
  );
}
