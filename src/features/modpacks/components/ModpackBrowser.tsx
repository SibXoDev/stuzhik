import { For, Show, createSignal, createEffect, createMemo, onMount, onCleanup } from "solid-js";
import type { Component } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { ModpackSearchResult, ModpackSearchResponse, ModpackInstallProgress, ModpackFilePreview, ModpackInstallSummary, Instance, InstallProgress, DownloadProgress, ModpackVersionInfo, ModpackDetails, VersionChangelog, ProjectInfo } from "../../../shared/types";
import { ProjectInfoDialog } from "../../../shared/components/ProjectInfoDialog";
import ModpackCompareDialog from "./ModpackCompareDialog";
import ModpackImportPreview from "./ModpackImportPreview";
import { Pagination } from "../../../shared/ui";
import { sanitizeImageUrl } from "../../../shared/utils/url-validator";
import { useSafeTimers, useDebounce } from "../../../shared/hooks";
import { useI18n } from "../../../shared/i18n";

interface Props {
  onClose: () => void;
  onInstalled: (instanceId: string, instanceName: string) => void;
  instances?: Instance[];
  initialFile?: string | null;
}

const ModpackBrowser: Component<Props> = (props) => {
  const { t } = useI18n();
  const [source, setSource] = createSignal<"modrinth" | "curseforge">("modrinth");
  const [searchQuery, setSearchQuery] = createSignal("");
  const [debouncedQuery, setDebouncedQuery] = createSignal("");
  const [results, setResults] = createSignal<ModpackSearchResult[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [page, setPage] = createSignal(0);
  const [total, setTotal] = createSignal(0);

  // Installation state
  const [installing, setInstalling] = createSignal(false);
  const [installProgress, setInstallProgress] = createSignal<ModpackInstallProgress | null>(null);
  const [selectedModpack, setSelectedModpack] = createSignal<ModpackSearchResult | null>(null);
  const [instanceName, setInstanceName] = createSignal("");
  const [operationId, setOperationId] = createSignal<string | null>(null);
  const [cancelling, setCancelling] = createSignal(false);

  // File install
  const [showFileInstall, setShowFileInstall] = createSignal(false);
  const [filePath, setFilePath] = createSignal("");
  const [fileInstanceName, setFileInstanceName] = createSignal("");
  const [filePreview, setFilePreview] = createSignal<ModpackFilePreview | null>(null);
  const [filePreviewLoading, setFilePreviewLoading] = createSignal(false);
  const [filePreviewError, setFilePreviewError] = createSignal<string | null>(null);

  // Detailed import preview
  const [showDetailedPreview, setShowDetailedPreview] = createSignal(false);

  // URL install
  const [showUrlInstall, setShowUrlInstall] = createSignal(false);
  const [urlInput, setUrlInput] = createSignal("");
  const [urlInstanceName, setUrlInstanceName] = createSignal("");

  // Preview dialog
  const [previewModpack, setPreviewModpack] = createSignal<ModpackSearchResult | null>(null);
  const [previewVersions, setPreviewVersions] = createSignal<VersionChangelog[]>([]);
  const [previewDetails, setPreviewDetails] = createSignal<ModpackDetails | null>(null);
  const [previewLoading, setPreviewLoading] = createSignal(false);
  const [previewInstanceName, setPreviewInstanceName] = createSignal("");
  const [previewInstalling, setPreviewInstalling] = createSignal(false);

  // Install summary (shows after installation completes)
  const [installSummary, setInstallSummary] = createSignal<ModpackInstallSummary | null>(null);

  // Instance installation progress (Java → Minecraft → Loader)
  const [instanceInstallStep, setInstanceInstallStep] = createSignal<string | null>(null);
  const [instanceInstallMessage, setInstanceInstallMessage] = createSignal<string>("");
  const [installedInstanceId, setInstalledInstanceId] = createSignal<string | null>(null);
  const [, setInstalledInstanceName] = createSignal<string>("");
  const [downloads, setDownloads] = createSignal<DownloadProgress[]>([]);

  // Compare dialog
  const [showCompareDialog, setShowCompareDialog] = createSignal(false);

  const limit = 20;
  const { debounce: debounceSearch } = useDebounce();
  const { setTimeout: safeTimeout } = useSafeTimers();

  // Debounce search with automatic cleanup
  createEffect(() => {
    const query = searchQuery();
    debounceSearch(() => {
      setDebouncedQuery(query);
      setPage(0);
    }, 300);
  });

  // Memoized search key to prevent duplicate API calls
  const searchKey = createMemo(() => {
    const query = debouncedQuery();
    const currentSource = source();
    const currentPage = page();

    return JSON.stringify({
      query,
      source: currentSource,
      page: currentPage,
    });
  });

  // Search only when key changes
  createEffect(() => {
    const key = searchKey();
    const parsed = JSON.parse(key);

    search(parsed.query, parsed.source, parsed.page);
  });

  // Handle initial file from drag & drop
  createEffect(() => {
    const initialPath = props.initialFile;
    if (initialPath) {
      // Switch to file install mode and load preview
      setShowFileInstall(true);
      setShowUrlInstall(false);
      setFilePath(initialPath);
      setFilePreview(null);
      setFilePreviewError(null);
      setFilePreviewLoading(true);

      // Load file preview
      invoke<ModpackFilePreview>("preview_modpack_file", { filePath: initialPath })
        .then((preview) => {
          setFilePreview(preview);
          if (!fileInstanceName()) {
            setFileInstanceName(preview.name);
          }
        })
        .catch((e) => {
          setFilePreviewError(String(e));
          // Fallback: extract name from filename
          const fileName = initialPath.split(/[/\\]/).pop() || "";
          const nameWithoutExt = fileName.replace(/\.(mrpack|zip|stzhk)$/i, "");
          if (nameWithoutExt && !fileInstanceName()) {
            setFileInstanceName(nameWithoutExt);
          }
        })
        .finally(() => {
          setFilePreviewLoading(false);
        });
    }
  });

  // Setup event listeners on mount (NOT in createEffect to avoid duplicates!)
  onMount(() => {
    // Listen for install progress
    const unlistenProgress = listen<ModpackInstallProgress>("modpack-install-progress", (event) => {
      setInstallProgress(event.payload);
      // Only close on cancellation - "completed" means mods downloaded,
      // but loader installation continues in background until instance-created fires
      if (event.payload.stage === "cancelled") {
        setInstalling(false);
        setOperationId(null);
        setCancelling(false);
        setInstanceInstallStep(null);
        setInstalledInstanceId(null);
        setInstalledInstanceName("");
        setDownloads([]);
      }
    });

    // Listen for modpack operation started (to get operation ID for cancellation)
    const unlistenOperationStarted = listen<{ operation_id: string }>("modpack-operation-started", (event) => {
      setOperationId(event.payload.operation_id);
    });

    // Listen for instance operation started (when loader installation begins after modpack install)
    // This is important because the modpack's operation_id is different from the instance's
    const unlistenInstanceOperationStarted = listen<{ operation_id: string }>("instance-operation-started", (event) => {
      // Update operation ID when instance installation starts (Java/MC/Loader)
      setOperationId(event.payload.operation_id);
    });

    // Listen for operation cancelled
    const unlistenOperationCancelled = listen<{ id: string }>("operation-cancelled", (event) => {
      if (event.payload.id === operationId()) {
        setInstalling(false);
        setOperationId(null);
        setCancelling(false);
        setError("Установка отменена");
      }
    });

    // Listen for install summary (shows mods from different sources)
    const unlistenInstallSummary = listen<ModpackInstallSummary>("modpack-install-summary", (event) => {
      const summary = event.payload;
      // Показываем сводку если есть моды с Modrinth (потенциально не те версии) или failed
      if (summary.from_modrinth.length > 0 || summary.failed.length > 0) {
        setInstallSummary(summary);
      }
    });

    // Listen for instance installation progress (Java → Minecraft → Loader)
    const unlistenInstanceProgress = listen<InstallProgress>("instance-install-progress", (event) => {
      const instId = installedInstanceId();
      // Only track if we have an instance ID or this is the first progress event
      if (!instId || event.payload.id === instId) {
        if (!instId) {
          setInstalledInstanceId(event.payload.id);
        }
        setInstanceInstallStep(event.payload.step);
        setInstanceInstallMessage(event.payload.message);
      }
    });

    // Listen for download progress
    const unlistenDownload = listen<DownloadProgress>("download-progress", (event) => {
      const progress = event.payload;
      setDownloads(prev => {
        const existing = prev.findIndex(d => d.id === progress.id);
        if (progress.status === "completed" || progress.status === "cancelled" || progress.status === "failed") {
          // Remove completed/cancelled/failed downloads after 1 second delay
          safeTimeout(() => {
            setDownloads(current => current.filter(d => d.id !== progress.id));
          }, 1000);
          return prev;
        }
        if (existing >= 0) {
          const updated = [...prev];
          updated[existing] = progress;
          return updated;
        }
        return [...prev, progress];
      });
    });

    // Listen for instance creation completed - close the modal
    // (onInstalled is already called immediately after invoke returns)
    const unlistenCreated = listen<{ id: string }>("instance-created", (event) => {
      const instId = installedInstanceId();
      const isInstalling = installing();
      // Close modal if we're installing and either:
      // 1. ID matches (strict check)
      // 2. We're installing but ID wasn't tracked yet (fallback)
      if (isInstalling && (instId === event.payload.id || !instId)) {
        setInstanceInstallStep("complete");
        setInstanceInstallMessage("Готово!");
        // Close the entire dialog after showing "complete" for a moment
        safeTimeout(() => {
          setInstalling(false);
          setOperationId(null);
          setInstanceInstallStep(null);
          setInstalledInstanceId(null);
          setInstalledInstanceName("");
          setDownloads([]);
          // Close the ModpackBrowser dialog itself
          props.onClose();
        }, 1500);
      }
    });

    // Cleanup all listeners on unmount
    onCleanup(() => {
      unlistenProgress.then(fn => fn());
      unlistenOperationStarted.then(fn => fn());
      unlistenInstanceOperationStarted.then(fn => fn());
      unlistenOperationCancelled.then(fn => fn());
      unlistenInstallSummary.then(fn => fn());
      unlistenInstanceProgress.then(fn => fn());
      unlistenDownload.then(fn => fn());
      unlistenCreated.then(fn => fn());
    });
  });

  const search = async (query: string, src: string, pg: number) => {
    setLoading(true);
    setError(null);

    try {
      const response = await invoke<ModpackSearchResponse>("search_modpacks", {
        query: query || "",
        minecraftVersion: null,
        loader: null,
        source: src,
        limit,
        offset: pg * limit,
      });

      setResults(response.results);
      setTotal(response.total);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleInstall = async (modpack: ModpackSearchResult) => {
    setSelectedModpack(modpack);
    setInstanceName(modpack.title);
  };

  const confirmInstall = async () => {
    const modpack = selectedModpack();
    const name = instanceName();
    if (!modpack || !name) return;

    setInstalling(true);
    setInstallProgress(null);
    setError(null);

    try {
      const instanceId = await invoke<string>("install_modpack", {
        source: modpack.source,
        projectId: modpack.project_id,
        versionId: null,
        instanceName: name,
      });

      // Store instance ID for tracking instance-created event (to close modal later)
      setInstalledInstanceId(instanceId);
      setInstalledInstanceName(name);
      setSelectedModpack(null);

      // Call onInstalled IMMEDIATELY so instance appears in the list
      // Modal stays open showing loader installation progress
      props.onInstalled(instanceId, name);
    } catch (e) {
      setError(String(e));
      setInstalling(false);
    }
  };

  const handleFileInstall = async () => {
    const path = filePath();
    const name = fileInstanceName();
    if (!path || !name) return;

    setInstalling(true);
    setInstallProgress(null);
    setError(null);

    try {
      const instanceId = await invoke<string>("install_modpack_from_file", {
        filePath: path,
        instanceName: name,
      });

      // Store instance ID for tracking instance-created event (to close modal later)
      setInstalledInstanceId(instanceId);
      setInstalledInstanceName(name);
      setShowFileInstall(false);

      // Call onInstalled IMMEDIATELY so instance appears in the list
      props.onInstalled(instanceId, name);
    } catch (e) {
      setError(String(e));
      setInstalling(false);
    }
  };

  const handleUrlInstall = async () => {
    const url = urlInput();
    const name = urlInstanceName();
    if (!url || !name) return;

    setInstalling(true);
    setInstallProgress(null);
    setError(null);

    try {
      const instanceId = await invoke<string>("install_stzhk_from_url", {
        url: url,
        instanceName: name,
        selectedOptionals: [],
      });

      // Store instance ID for tracking instance-created event (to close modal later)
      setInstalledInstanceId(instanceId);
      setInstalledInstanceName(name);
      setShowUrlInstall(false);
      setUrlInput("");
      setUrlInstanceName("");

      // Call onInstalled IMMEDIATELY so instance appears in the list
      props.onInstalled(instanceId, name);
    } catch (e) {
      setError(String(e));
      setInstalling(false);
    }
  };

  const getProgressText = () => {
    // If instance installation is in progress, show that instead
    const instStep = instanceInstallStep();
    const instMsg = instanceInstallMessage();
    if (instStep && instStep !== "complete") {
      // Show instance installation message (Java/Minecraft/Loader)
      return instMsg || "Установка компонентов...";
    }
    if (instStep === "complete") {
      return "Готово!";
    }

    const progress = installProgress();
    if (!progress) return "Подготовка...";

    switch (progress.stage) {
      case "downloading":
        return `Скачивание модпака...`;
      case "creating_instance":
        return "Создание экземпляра...";
      case "resolving_mods":
        return progress.current_file || `Анализ модов (${progress.current}/${progress.total})...`;
      case "downloading_mods":
        return `Скачивание модов (${progress.current}/${progress.total})${progress.current_file ? `: ${progress.current_file}` : ""}`;
      case "extracting_overrides":
        return "Распаковка файлов...";
      case "completed":
        // Mods downloaded, but loader installation may still be in progress
        // Only show "Готово!" if instance installation hasn't started yet
        return "Установка загрузчика...";
      default:
        return "Установка...";
    }
  };

  const getProgressPercent = () => {
    const progress = installProgress();
    if (!progress || progress.total === 0) return 0;
    return Math.round((progress.current / progress.total) * 100);
  };

  const handleCancel = async () => {
    const opId = operationId();
    if (!opId) return;

    setCancelling(true);
    try {
      await invoke<boolean>("cancel_operation", { operationId: opId });
    } catch (e) {
      console.error("Failed to cancel:", e);
      setCancelling(false);
    }
  };

  // Open preview dialog and load modpack data
  const openPreview = async (modpack: ModpackSearchResult) => {
    setPreviewModpack(modpack);
    setPreviewInstanceName(modpack.title);
    setPreviewLoading(true);
    setPreviewVersions([]);
    setPreviewDetails(null);

    try {
      // Load versions and details in parallel
      const [versionList, detailsData] = await Promise.all([
        invoke<ModpackVersionInfo[]>("get_modpack_versions", {
          source: modpack.source,
          projectId: modpack.project_id,
          minecraftVersion: null,
          loader: null,
        }),
        invoke<ModpackDetails>("get_modpack_details", {
          source: modpack.source,
          projectId: modpack.project_id,
        }).catch(() => null), // Details are optional
      ]);

      // Convert ModpackVersionInfo to VersionChangelog
      const versions: VersionChangelog[] = versionList.map(v => ({
        id: v.id,
        version_number: v.version_number,
        version_name: v.name,
        changelog: null,
        date_published: "",
        game_versions: v.game_versions,
        loaders: v.loaders,
        downloads: v.downloads,
        file_size: v.file_size,
        download_url: v.download_url,
        file_name: null,
        version_type: null,
      }));
      setPreviewVersions(versions);

      if (detailsData) {
        setPreviewDetails(detailsData);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setPreviewLoading(false);
    }
  };

  // Close preview dialog
  const closePreview = () => {
    setPreviewModpack(null);
    setPreviewVersions([]);
    setPreviewDetails(null);
    setPreviewInstanceName("");
    setPreviewInstalling(false);
  };

  // Install modpack from preview dialog
  const installFromPreview = async (versionId: string) => {
    const modpack = previewModpack();
    const name = previewInstanceName();
    if (!modpack || !name) return;

    setPreviewInstalling(true);
    setInstalling(true);
    setInstallProgress(null);
    setError(null);

    try {
      const instanceId = await invoke<string>("install_modpack", {
        source: modpack.source,
        projectId: modpack.project_id,
        versionId: versionId,
        instanceName: name,
      });

      setInstalledInstanceId(instanceId);
      setInstalledInstanceName(name);
      closePreview();
      props.onInstalled(instanceId, name);
    } catch (e) {
      setError(String(e));
      setInstalling(false);
      setPreviewInstalling(false);
    }
  };

  // Convert ModpackSearchResult + ModpackDetails to ProjectInfo
  const getPreviewProjectInfo = (): ProjectInfo | null => {
    const modpack = previewModpack();
    if (!modpack) return null;

    const details = previewDetails();

    // Convert gallery images to ProjectGalleryImage format
    const gallery = details?.gallery?.map(img => ({
      url: img.url,
      title: img.title,
      description: img.description,
      featured: img.featured,
    })) || [];

    return {
      slug: modpack.slug,
      title: modpack.title,
      description: modpack.description,
      body: details?.body,
      author: modpack.author,
      icon_url: modpack.icon_url,
      downloads: modpack.downloads,
      followers: details?.followers,
      categories: modpack.categories,
      versions: modpack.minecraft_versions,
      gallery,
      links: {
        source: details?.source_url,
        wiki: details?.wiki_url,
        discord: details?.discord_url,
        issues: details?.issues_url,
      },
      projectType: "modpack",
      source: modpack.source,
    };
  };

  const selectFile = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{
          name: "Модпаки",
          extensions: ["mrpack", "zip", "stzhk"]
        }],
        title: "Выберите файл модпака"
      });

      if (selected && typeof selected === "string") {
        setFilePath(selected);
        setFilePreview(null);
        setFilePreviewError(null);
        setFilePreviewLoading(true);

        try {
          const preview = await invoke<ModpackFilePreview>("preview_modpack_file", {
            filePath: selected
          });
          setFilePreview(preview);
          // Автозаполнение имени из метаданных модпака
          if (!fileInstanceName()) {
            setFileInstanceName(preview.name);
          }
        } catch (e) {
          setFilePreviewError(String(e));
          // Fallback: автозаполнение имени из файла
          const fileName = selected.split(/[/\\]/).pop() || "";
          const nameWithoutExt = fileName.replace(/\.(mrpack|zip|stzhk)$/i, "");
          if (nameWithoutExt && !fileInstanceName()) {
            setFileInstanceName(nameWithoutExt);
          }
        } finally {
          setFilePreviewLoading(false);
        }
      }
    } catch (e) {
      console.error("File selection error:", e);
    }
  };

  const clearFile = () => {
    setFilePath("");
    setFileInstanceName("");
    setFilePreview(null);
    setFilePreviewError(null);
  };

  return (
    <div class="flex flex-col h-full max-h-[calc(100vh-8rem)]">
      {/* Header */}
      <div class="flex items-center justify-between p-4 border-b border-gray-750 flex-shrink-0">
        <h2 class="text-xl font-bold">Установка модпака</h2>
        <button class="btn-close" onClick={props.onClose}>
          <i class="i-hugeicons-cancel-01 w-5 h-5" />
        </button>
      </div>

      {/* Content */}
      <div class="flex-1 overflow-y-auto p-4 flex flex-col gap-4">

      {/* Installing Overlay */}
      <Show when={installing()}>
        <div class="fixed inset-0 bg-black/70 backdrop-blur-sm z-60 flex items-center justify-center">
          <div class="card max-w-lg w-full text-center p-8">
            <Show when={!cancelling()} fallback={
              <>
                <i class="i-svg-spinners-6-dots-scale w-12 h-12 mx-auto mb-4" />
                <h3 class="text-xl font-semibold mb-2">Отмена...</h3>
                <p class="text-muted mb-4">Ожидание завершения текущей операции</p>
              </>
            }>
              <h3 class="text-xl font-semibold mb-4">Установка модпака</h3>

              {/* Unified progress indicator - all steps */}
              <div class="flex flex-wrap items-center justify-center gap-1.5 text-xs font-medium mb-4">
                {/* Модпак */}
                <span class={`px-2.5 py-1 rounded-lg transition-all duration-100 ${
                  installProgress()?.stage === "downloading"
                    ? "bg-blue-600 text-white animate-pulse"
                    : installProgress() || instanceInstallStep()
                      ? "bg-green-600/20 text-green-400"
                      : "bg-gray-800 text-gray-500"
                }`}>Модпак</span>
                <span class={installProgress() || instanceInstallStep() ? "text-green-400" : "text-gray-600"}>→</span>

                {/* Моды */}
                <span class={`px-2.5 py-1 rounded-lg transition-all duration-100 ${
                  ["resolving_mods", "downloading_mods"].includes(installProgress()?.stage || "")
                    ? "bg-blue-600 text-white animate-pulse"
                    : ["extracting_overrides", "completed"].includes(installProgress()?.stage || "") || instanceInstallStep()
                      ? "bg-green-600/20 text-green-400"
                      : "bg-gray-800 text-gray-500"
                }`}>Моды</span>
                <span class={["extracting_overrides", "completed"].includes(installProgress()?.stage || "") || instanceInstallStep() ? "text-green-400" : "text-gray-600"}>→</span>

                {/* Распаковка */}
                <span class={`px-2.5 py-1 rounded-lg transition-all duration-100 ${
                  installProgress()?.stage === "extracting_overrides"
                    ? "bg-blue-600 text-white animate-pulse"
                    : installProgress()?.stage === "completed" || instanceInstallStep()
                      ? "bg-green-600/20 text-green-400"
                      : "bg-gray-800 text-gray-500"
                }`}>Файлы</span>
                <span class={installProgress()?.stage === "completed" || instanceInstallStep() ? "text-green-400" : "text-gray-600"}>→</span>

                {/* Java + Minecraft (параллельно) */}
                <span class={`px-2.5 py-1 rounded-lg transition-all duration-100 ${
                  ["java", "minecraft"].includes(instanceInstallStep() || "")
                    ? "bg-blue-600 text-white animate-pulse"
                    : ["loader", "complete"].includes(instanceInstallStep() || "")
                      ? "bg-green-600/20 text-green-400"
                      : "bg-gray-800 text-gray-500"
                }`}>Java + MC</span>
                <span class={["loader", "complete"].includes(instanceInstallStep() || "") ? "text-green-400" : "text-gray-600"}>→</span>

                {/* Загрузчик */}
                <span class={`px-2.5 py-1 rounded-lg transition-all duration-100 ${
                  instanceInstallStep() === "loader"
                    ? "bg-blue-600 text-white animate-pulse"
                    : instanceInstallStep() === "complete"
                      ? "bg-green-600/20 text-green-400"
                      : "bg-gray-800 text-gray-500"
                }`}>Загрузчик</span>
                <span class={instanceInstallStep() === "complete" ? "text-green-400" : "text-gray-600"}>→</span>

                {/* Готово */}
                <span class={`px-2.5 py-1 rounded-lg transition-all duration-100 ${
                  instanceInstallStep() === "complete"
                    ? "bg-green-600 text-white"
                    : "bg-gray-800 text-gray-500"
                }`}>Готово</span>
              </div>

              {/* Current step details */}
              <p class="text-muted text-sm mb-2">{getProgressText()}</p>

              {/* Progress bar for mod downloads */}
              <Show when={installProgress()?.stage === "downloading_mods"}>
                <div class="w-full bg-gray-800 rounded-full h-2 mt-3">
                  <div
                    class="bg-blue-600 h-2 rounded-full transition-all duration-100"
                    style={{ width: `${getProgressPercent()}%` }}
                  />
                </div>
              </Show>

              {/* Active downloads */}
              <Show when={downloads().length > 0}>
                <div class="mt-4 max-h-32 overflow-y-auto text-left space-y-2">
                  <For each={downloads()}>
                    {(dl) => (
                      <div class="bg-gray-800/50 rounded-xl p-2">
                        <div class="flex items-center justify-between text-xs mb-1">
                          <span class="truncate flex-1 text-gray-300">{dl.name}</span>
                          <span class="text-dimmer ml-2">
                            {dl.total > 0 ? `${((dl.downloaded / dl.total) * 100).toFixed(0)}%` : "..."}
                          </span>
                        </div>
                        <div class="w-full bg-gray-800 rounded-full h-1">
                          <div
                            class="bg-blue-500 h-1 rounded-full transition-all duration-100"
                            style={{ width: `${dl.total > 0 ? (dl.downloaded / dl.total) * 100 : 0}%` }}
                          />
                        </div>
                        <Show when={dl.speed > 0}>
                          <div class="text-[10px] text-dimmer mt-1">
                            {(dl.speed / (1024 * 1024)).toFixed(1)} MB/s
                          </div>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              </Show>

              <button
                class="btn-secondary mt-6"
                onClick={handleCancel}
                disabled={cancelling() || !operationId()}
              >
                <i class="i-hugeicons-cancel-01 w-4 h-4" />
                {operationId() ? "Отменить" : "Ожидание..."}
              </button>
            </Show>
          </div>
        </div>
      </Show>

      {/* Install Summary Dialog */}
      <Show when={installSummary()}>
        <div class="fixed inset-0 bg-black/70 backdrop-blur-sm z-60 flex items-center justify-center p-4">
          <div class="card max-w-lg w-full max-h-[80vh] overflow-y-auto">
            <h3 class="text-lg font-semibold mb-4 flex items-center gap-2">
              <i class="i-hugeicons-alert-02 w-5 h-5 text-yellow-500" />
              Сводка установки
            </h3>

            <Show when={installSummary()!.from_modrinth.length > 0}>
              <div class="mb-4 p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-2xl">
                <p class="text-sm font-medium text-yellow-400 mb-2">
                  ⚠️ Следующие моды были найдены на Modrinth автоматически.
                  <br />
                  <span class="text-yellow-500/80">Возможно скачаны НЕ ТЕ версии! Проверьте совместимость.</span>
                </p>
                <ul class="text-xs text-muted space-y-1 max-h-32 overflow-y-auto">
                  <For each={installSummary()!.from_modrinth}>
                    {(mod) => <li class="truncate">• {mod}</li>}
                  </For>
                </ul>
              </div>
            </Show>

            <Show when={installSummary()!.failed.length > 0}>
              <div class="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-2xl">
                <p class="text-sm font-medium text-red-400 mb-2">
                  ❌ Следующие моды НЕ удалось скачать:
                </p>
                <ul class="text-xs text-muted space-y-1 max-h-32 overflow-y-auto">
                  <For each={installSummary()!.failed}>
                    {(mod) => <li class="truncate">• {mod}</li>}
                  </For>
                </ul>
              </div>
            </Show>

            <div class="text-xs text-dimmer mb-4">
              Всего модов: {installSummary()!.total_mods} |
              CurseForge: {installSummary()!.from_curseforge.length} |
              Modrinth: {installSummary()!.from_modrinth.length} |
              Не скачано: {installSummary()!.failed.length}
            </div>

            <button
              class="btn-primary w-full"
              onClick={() => setInstallSummary(null)}
            >
              Понятно
            </button>
          </div>
        </div>
      </Show>

      {/* Confirm Install Dialog */}
      <Show when={selectedModpack() && !installing()}>
        <div class="fixed inset-0 bg-black/50 backdrop-blur-sm z-40 flex items-center justify-center p-4">
          <div class="card max-w-md w-full">
            <h3 class="text-lg font-semibold mb-4">Установить модпак</h3>

            <div class="flex items-center gap-3 mb-4">
              <Show when={sanitizeImageUrl(selectedModpack()?.icon_url)}>
                <img
                  src={sanitizeImageUrl(selectedModpack()?.icon_url)!}
                  alt={selectedModpack()!.title}
                  class="w-12 h-12 rounded-2xl"
                />
              </Show>
              <div>
                <p class="font-medium">{selectedModpack()?.title}</p>
                <p class="text-sm text-muted">{selectedModpack()?.author}</p>
              </div>
            </div>

            <label class="block mb-4">
              <span class="text-sm text-muted mb-1 block">Название экземпляра</span>
              <input
                type="text"
                value={instanceName()}
                onInput={(e) => setInstanceName(e.currentTarget.value)}
                class="w-full"
                placeholder={t().ui.placeholders.enterName}
              />
            </label>

            <div class="flex gap-2 justify-end">
              <button class="btn-secondary" onClick={() => setSelectedModpack(null)}>
                Отмена
              </button>
              <button
                class="btn-primary"
                onClick={confirmInstall}
                disabled={!instanceName()}
              >
                <i class="i-hugeicons-download-02 w-4 h-4" />
                Установить
              </button>
            </div>
          </div>
        </div>
      </Show>

      {/* Mode Tabs */}
      <div class="flex gap-2">
        <button
          class={`flex-1 px-4 py-2 rounded-2xl font-medium transition-colors duration-100 inline-flex items-center justify-center gap-2 ${
            !showFileInstall() && !showUrlInstall()
              ? "bg-blue-600 text-white"
              : "bg-gray-800 text-gray-300 hover:bg-gray-750"
          }`}
          onClick={() => { setShowFileInstall(false); setShowUrlInstall(false); }}
        >
          <i class="i-hugeicons-search-01 w-4 h-4" />
          Поиск
        </button>
        <button
          class={`flex-1 px-4 py-2 rounded-2xl font-medium transition-colors duration-100 inline-flex items-center justify-center gap-2 ${
            showFileInstall()
              ? "bg-blue-600 text-white"
              : "bg-gray-800 text-gray-300 hover:bg-gray-750"
          }`}
          onClick={() => { setShowFileInstall(true); setShowUrlInstall(false); }}
        >
          <i class="i-hugeicons-folder-01 w-4 h-4" />
          Из файла
        </button>
        <button
          class={`flex-1 px-4 py-2 rounded-2xl font-medium transition-colors duration-100 inline-flex items-center justify-center gap-2 ${
            showUrlInstall()
              ? "bg-cyan-600 text-white"
              : "bg-gray-800 text-gray-300 hover:bg-gray-750"
          }`}
          onClick={() => { setShowFileInstall(false); setShowUrlInstall(true); }}
        >
          <i class="i-hugeicons-link-01 w-4 h-4" />
          По ссылке
        </button>
        <button
          class="px-4 py-2 rounded-2xl font-medium transition-colors duration-100 bg-purple-600/20 text-purple-400 hover:bg-purple-600/30 border border-purple-600/30 inline-flex items-center justify-center gap-2"
          onClick={() => setShowCompareDialog(true)}
          title="Сравнить два модпака"
        >
          <i class="i-hugeicons-git-compare w-4 h-4" />
          Сравнить
        </button>
      </div>

      {/* Compare Dialog */}
      <Show when={showCompareDialog()}>
        <ModpackCompareDialog
          instances={props.instances || []}
          onClose={() => setShowCompareDialog(false)}
        />
      </Show>

      {/* File Install Mode */}
      <Show when={showFileInstall()}>
        <div class="card">
          <p class="text-sm text-muted mb-4">
            Поддерживаются форматы: <strong>.mrpack</strong> (Modrinth), <strong>.zip</strong> (CurseForge) и <strong>.stzhk</strong> (Stuzhik)
          </p>

          <div class="mb-4">
            <span class="text-sm text-muted mb-2 block">Файл модпака</span>
            <div class="flex gap-2">
              <button
                class="btn-secondary flex-1 justify-start text-left"
                onClick={selectFile}
              >
                <i class="i-hugeicons-folder-01 w-4 h-4 flex-shrink-0" />
                <span class="truncate">
                  {filePath() || "Выбрать файл..."}
                </span>
              </button>
              <Show when={filePath()}>
                <button
                  class="btn-ghost px-2"
                  onClick={clearFile}
                  title="Очистить"
                >
                  <i class="i-hugeicons-cancel-01 w-4 h-4" />
                </button>
              </Show>
            </div>
          </div>

          {/* Preview loading */}
          <Show when={filePreviewLoading()}>
            <div class="flex-center gap-2 py-4">
              <i class="i-svg-spinners-6-dots-scale w-5 h-5" />
              <span class="text-muted text-sm">Чтение модпака...</span>
            </div>
          </Show>

          {/* Preview error */}
          <Show when={filePreviewError()}>
            <div class="card bg-yellow-600/10 border-yellow-600/30 mb-4">
              <p class="text-yellow-400 text-sm inline-flex items-center gap-1">
                <i class="i-hugeicons-alert-02 w-4 h-4" />
                Не удалось прочитать информацию о модпаке
              </p>
            </div>
          </Show>

          {/* Preview info */}
          <Show when={filePreview()}>
            <div class="card bg-gray-alpha-50 mb-4 space-y-3">
              <div class="flex items-start justify-between">
                <div>
                  <h4 class="font-semibold text-lg">{filePreview()!.name}</h4>
                  <p class="text-sm text-muted">{filePreview()!.summary || `Версия ${filePreview()!.version}`}</p>
                </div>
                <span class={`badge ${
                  filePreview()!.format === "modrinth" ? "badge-success" :
                  filePreview()!.format === "stzhk" ? "bg-cyan-600/20 text-cyan-400 border-cyan-600/30" :
                  "bg-orange-600/20 text-orange-400 border-orange-600/30"
                }`}>
                  {filePreview()!.format === "modrinth" ? "Modrinth" :
                   filePreview()!.format === "stzhk" ? "Stuzhik" : "CurseForge"}
                </span>
              </div>

              <div class="grid grid-cols-3 gap-3 text-center">
                <div class="card bg-gray-alpha-50">
                  <p class="text-xs text-dimmer">Minecraft</p>
                  <p class="font-medium">{filePreview()!.minecraft_version}</p>
                </div>
                <div class="card bg-gray-alpha-50">
                  <p class="text-xs text-dimmer">Загрузчик</p>
                  <p class="font-medium">{filePreview()!.loader}</p>
                  <Show when={filePreview()!.loader_version}>
                    <p class="text-xs text-muted">{filePreview()!.loader_version}</p>
                  </Show>
                </div>
                <div class="card bg-gray-alpha-50">
                  <p class="text-xs text-dimmer">Модов</p>
                  <p class="font-medium">
                    {filePreview()!.mod_count + filePreview()!.overrides_mods_count}
                  </p>
                  <Show when={filePreview()!.overrides_mods_count > 0}>
                    <p class="text-xs text-muted">
                      ({filePreview()!.mod_count} в манифесте + {filePreview()!.overrides_mods_count} в overrides)
                    </p>
                  </Show>
                </div>
              </div>
            </div>
          </Show>

          <label class="block mb-4">
            <span class="text-sm text-muted mb-1 block">Название экземпляра</span>
            <input
              type="text"
              value={fileInstanceName()}
              onInput={(e) => setFileInstanceName(e.currentTarget.value)}
              class="w-full"
              placeholder={t().ui.placeholders.myModpack}
            />
          </label>

          <div class="flex gap-2">
            <button
              class="btn-secondary flex-1"
              onClick={() => setShowDetailedPreview(true)}
              disabled={!filePath() || installing() || filePreviewLoading()}
              title="Просмотреть содержимое модпака"
            >
              <i class="i-hugeicons-view w-4 h-4" />
              Подробнее
            </button>
            <button
              class="btn-primary flex-1"
              onClick={handleFileInstall}
              disabled={!filePath() || !fileInstanceName() || installing() || filePreviewLoading()}
            >
              <i class="i-hugeicons-download-02 w-4 h-4" />
              Установить
            </button>
          </div>
        </div>
      </Show>

      {/* URL Install Mode */}
      <Show when={showUrlInstall()}>
        <div class="card">
          <p class="text-sm text-muted mb-4">
            Вставьте ссылку на модпак <strong>.stzhk</strong> с облачного хранилища
          </p>

          <div class="flex flex-wrap gap-2 mb-4">
            <span class="badge bg-yellow-600/20 text-yellow-400 border-yellow-600/30">
              <i class="i-hugeicons-youtube w-3 h-3" />
              Яндекс.Диск
            </span>
            <span class="badge bg-blue-600/20 text-blue-400 border-blue-600/30">
              <i class="i-hugeicons-google w-3 h-3" />
              Google Drive
            </span>
            <span class="badge bg-sky-600/20 text-sky-400 border-sky-600/30">
              <i class="i-hugeicons-cloud w-3 h-3" />
              Dropbox
            </span>
            <span class="badge bg-gray-600/20 text-gray-400 border-gray-600/30">
              <i class="i-hugeicons-link-01 w-3 h-3" />
              Прямая ссылка
            </span>
          </div>

          <label class="block mb-4">
            <span class="text-sm text-muted mb-1 block">Ссылка на модпак</span>
            <input
              type="text"
              value={urlInput()}
              onInput={(e) => setUrlInput(e.currentTarget.value)}
              class="w-full"
              placeholder={t().ui.placeholders.cloudStorageUrl}
            />
          </label>

          <label class="block mb-4">
            <span class="text-sm text-muted mb-1 block">Название экземпляра</span>
            <input
              type="text"
              value={urlInstanceName()}
              onInput={(e) => setUrlInstanceName(e.currentTarget.value)}
              class="w-full"
              placeholder={t().ui.placeholders.myModpack}
            />
          </label>

          <button
            class="btn w-full bg-cyan-600 hover:bg-cyan-500 text-white"
            onClick={handleUrlInstall}
            disabled={!urlInput() || !urlInstanceName() || installing()}
          >
            <i class="i-hugeicons-download-02 w-4 h-4" />
            Установить по ссылке
          </button>
        </div>
      </Show>

      {/* Online Search Mode */}
      <Show when={!showFileInstall() && !showUrlInstall()}>
        {/* Source Toggle */}
        <div class="flex gap-2">
          <button
            class={`flex-1 px-4 py-2 rounded-2xl font-medium transition-colors duration-100 ${
              source() === "modrinth"
                ? "bg-green-600 text-white"
                : "bg-gray-800 text-gray-300 hover:bg-gray-750"
            }`}
            onClick={() => { setSource("modrinth"); setPage(0); }}
          >
            Modrinth
          </button>
          <button
            class={`flex-1 px-4 py-2 rounded-2xl font-medium transition-colors duration-100 ${
              source() === "curseforge"
                ? "bg-orange-600 text-white"
                : "bg-gray-800 text-gray-300 hover:bg-gray-750"
            }`}
            onClick={() => { setSource("curseforge"); setPage(0); }}
          >
            CurseForge
          </button>
        </div>

        {/* Search Input */}
        <div>
          <input
            type="text"
            value={searchQuery()}
            onInput={(e) => setSearchQuery(e.currentTarget.value)}
            placeholder={t().ui.placeholders.searchModpacks}
            class="w-full pl-10"
          />
          <i class="i-hugeicons-search-01 absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-500" />
        </div>

        {/* Error */}
        <Show when={error()}>
          <div class="card bg-red-600/10 border-red-600/30">
            <p class="text-red-400 text-sm">{error()}</p>
          </div>
        </Show>

        {/* Loading */}
        <Show when={loading()}>
          <div class="flex-center gap-2 py-8">
            <i class="i-svg-spinners-6-dots-scale w-6 h-6" />
            <span class="text-muted">Поиск...</span>
          </div>
        </Show>

        {/* Results */}
        <Show when={!loading() && results().length > 0}>
          <div class="overflow-y-auto max-h-[50vh] space-y-3">
            <For each={results()}>
              {(modpack) => (
                <div
                  class="card-hover flex gap-4 cursor-pointer"
                  onClick={() => openPreview(modpack)}
                >
                  <Show when={sanitizeImageUrl(modpack.icon_url)}>
                    <img
                      src={sanitizeImageUrl(modpack.icon_url)!}
                      alt={modpack.title}
                      class="w-16 h-16 rounded-2xl object-cover flex-shrink-0"
                      onError={(e) => { e.currentTarget.style.display = "none"; }}
                    />
                  </Show>

                  <div class="flex-1 min-w-0">
                    <h3 class="font-semibold truncate">{modpack.title}</h3>
                    <p class="text-xs text-muted mb-1">от {modpack.author}</p>
                    <p class="text-sm text-muted line-clamp-2 mb-2">{modpack.description}</p>

                    <div class="flex items-center gap-2 flex-wrap">
                      <span class="badge badge-sm">
                        <i class="i-hugeicons-download-02 w-3 h-3" />
                        {modpack.downloads.toLocaleString()}
                      </span>
                      <Show when={modpack.loaders.length > 0}>
                        <span class="badge badge-sm bg-blue-600/20 text-blue-400">
                          {modpack.loaders[0]}
                        </span>
                      </Show>
                    </div>
                  </div>

                  <div class="flex gap-2 self-center flex-shrink-0">
                    <button
                      class="btn-primary"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleInstall(modpack);
                      }}
                    >
                      <i class="i-hugeicons-download-02 w-4 h-4" />
                      Установить
                    </button>
                  </div>
                </div>
              )}
            </For>
          </div>

          {/* Pagination */}
          <div class="pt-2">
            <Pagination
              currentPage={page()}
              totalPages={Math.ceil(total() / limit) || 1}
              onPageChange={setPage}
            />
          </div>
        </Show>

        {/* Empty State */}
        <Show when={!loading() && results().length === 0 && debouncedQuery()}>
          <div class="card flex-col-center py-12 text-center">
            <i class="i-hugeicons-search-01 w-12 h-12 text-gray-600 mb-3" />
            <p class="text-muted">Модпаки не найдены</p>
            <p class="text-sm text-dimmer">Попробуйте изменить запрос</p>
          </div>
        </Show>

        {/* Initial State */}
        <Show when={!loading() && results().length === 0 && !debouncedQuery()}>
          <div class="card flex-col-center py-12 text-center">
            <i class="i-hugeicons-package w-12 h-12 text-gray-600 mb-3" />
            <p class="text-muted">Введите запрос для поиска</p>
            <p class="text-sm text-dimmer">Найдите модпаки на Modrinth или CurseForge</p>
          </div>
        </Show>
      </Show>
      </div>

      {/* Preview Dialog */}
      <Show when={previewModpack() && getPreviewProjectInfo()}>
        <ProjectInfoDialog
          project={getPreviewProjectInfo()!}
          onClose={closePreview}
          versionsData={previewVersions()}
          onInstallVersion={installFromPreview}
          installing={previewInstalling() || previewLoading()}
          contentFormat={previewModpack()?.source === "curseforge" ? "html" : "markdown"}
          actions={() => (
            <div class="flex items-center gap-2">
              <label class="text-sm text-gray-400">Название:</label>
              <input
                type="text"
                value={previewInstanceName()}
                onInput={(e) => setPreviewInstanceName(e.currentTarget.value)}
                class="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-xl text-sm w-48"
                placeholder={t().ui.placeholders.enterName}
              />
            </div>
          )}
        />
      </Show>

      {/* Detailed Import Preview Dialog */}
      <Show when={showDetailedPreview() && filePath()}>
        <ModpackImportPreview
          filePath={filePath()}
          onClose={() => setShowDetailedPreview(false)}
          onImport={(name, _excludedMods, _excludedOverrides) => {
            // For now, we use the standard import without selective filtering
            // TODO: Add backend support for excluded_mods and excluded_overrides
            setFileInstanceName(name);
            setShowDetailedPreview(false);
            handleFileInstall();
          }}
          importing={installing()}
        />
      </Show>
    </div>
  );
};

export default ModpackBrowser;
