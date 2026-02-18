import { For, Show, createSignal, createEffect, createMemo, onMount, onCleanup } from "solid-js";
import type { Component } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { ModpackSearchResult, ModpackSearchResponse, ModpackInstallProgress, ModpackFilePreview, ModpackInstallSummary, FailedModInfo, ModSearchInfo, Instance, InstallProgress, DownloadProgress, ModpackVersionInfo, ModpackDetails, VersionChangelog, ProjectInfo } from "../../../shared/types";
import { ProjectInfoDialog } from "../../../shared/components/ProjectInfoDialog";
import ModpackCompareDialog from "./ModpackCompareDialog";
import ModpackImportPreview from "./ModpackImportPreview";
import { InstallProgressModal } from "./InstallProgressModal";
import { InstallSummaryDialog } from "./InstallSummaryDialog";
import type { ModResolution } from "./InstallSummaryDialog";
import { FileInstallPanel } from "./FileInstallPanel";
import { UrlInstallPanel } from "./UrlInstallPanel";
import { Pagination, Tooltip } from "../../../shared/ui";
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
  // Separate signal for modpack-level operation ID (mod downloads).
  // Both tokens must be cancelled to fully stop installation.
  const [modpackOperationId, setModpackOperationId] = createSignal<string | null>(null);
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

  // Resolution state for failed mods: tracks search results and install status per mod
  const [modResolutions, setModResolutions] = createSignal<Record<string, ModResolution>>({});

  // Instance installation progress (Java → Minecraft → Loader)
  const [instanceInstallStep, setInstanceInstallStep] = createSignal<string | null>(null);
  const [instanceInstallMessage, setInstanceInstallMessage] = createSignal<string>("");
  // installedInstanceId is set ONLY when invoke returns (mods downloaded) — used as guard for dialog close
  const [installedInstanceId, setInstalledInstanceId] = createSignal<string | null>(null);
  // progressInstanceId tracks which instance's progress events to display (set early from progress events)
  const [progressInstanceId, setProgressInstanceId] = createSignal<string | null>(null);
  const [, setInstalledInstanceName] = createSignal<string>("");
  const [downloads, setDownloads] = createSignal<DownloadProgress[]>([]);
  // Track instance-created event that arrived before install_modpack returned
  const [earlyInstanceCreatedId, setEarlyInstanceCreatedId] = createSignal<string | null>(null);

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

  // Helper: close the install dialog with "complete" state
  const closeInstallDialog = () => {
    setInstanceInstallStep("complete");
    setInstanceInstallMessage(t().modpacks.browser.ready);
    safeTimeout(() => {
      // Don't close if install summary is showing — user needs to see failed mods
      if (installSummary()) {
        // Mark as ready to close but wait for user to dismiss summary
        setInstalling(false);
        return;
      }
      setInstalling(false);
      setOperationId(null);
      setInstanceInstallStep(null);
      setInstalledInstanceId(null);
      setProgressInstanceId(null);
      setInstalledInstanceName("");
      setDownloads([]);
      setEarlyInstanceCreatedId(null);
      props.onClose();
    }, 1500);
  };

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
        setProgressInstanceId(null);
        setInstalledInstanceName("");
        setDownloads([]);
        setEarlyInstanceCreatedId(null);
        setModpackOperationId(null);
      }
    });

    // Listen for modpack operation started (mod downloads — separate token from instance install)
    const unlistenOperationStarted = listen<{ operation_id: string }>("modpack-operation-started", (event) => {
      setModpackOperationId(event.payload.operation_id);
      // Set as primary operationId too (used for cancel button state / operation-cancelled matching)
      setOperationId(event.payload.operation_id);
    });

    // Listen for instance operation started (Java/MC/Loader — runs in parallel with mod downloads)
    // Store as primary operationId so cancel button targets it, but do NOT clear modpackOperationId
    const unlistenInstanceOperationStarted = listen<{ operation_id: string }>("instance-operation-started", (event) => {
      setOperationId(event.payload.operation_id);
    });

    // Listen for operation cancelled — match either modpack or instance token
    const unlistenOperationCancelled = listen<{ id: string }>("operation-cancelled", (event) => {
      const cancelledId = event.payload.id;
      if (cancelledId === operationId() || cancelledId === modpackOperationId()) {
        setInstalling(false);
        setOperationId(null);
        setModpackOperationId(null);
        setCancelling(false);
        setProgressInstanceId(null);
        setEarlyInstanceCreatedId(null);
        setError(t().modpacks.browser.installCancelled);
      }
    });

    // Listen for install summary (shows mods from different sources)
    const unlistenInstallSummary = listen<ModpackInstallSummary>("modpack-install-summary", (event) => {
      const summary = event.payload;
      // Показываем сводку если есть моды с Modrinth (потенциально не те версии) или failed
      if (summary.from_modrinth.length > 0 || summary.failed.length > 0) {
        setInstallSummary(summary);
        // Auto-search for failed mods
        if (summary.failed.length > 0) {
          autoSearchFailedMods(summary);
        }
      }
    });

    // Listen for instance installation progress (Java → Minecraft → Loader)
    // Uses progressInstanceId (NOT installedInstanceId) to avoid premature dialog close.
    // installedInstanceId is only set when invoke returns (mods downloaded).
    const unlistenInstanceProgress = listen<InstallProgress>("instance-install-progress", (event) => {
      const progId = progressInstanceId();
      // Accept progress from our tracked instance, or from any instance if we haven't identified one yet
      if (!progId || event.payload.id === progId) {
        if (!progId) {
          setProgressInstanceId(event.payload.id);
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

        // Preserve source from previous update if new event doesn't include it
        // (only the first Connecting event includes source, subsequent events have source=null)
        if (!progress.source && existing >= 0 && prev[existing].source) {
          progress.source = prev[existing].source;
        }

        if (progress.status === "completed" || progress.status === "cancelled" || progress.status === "failed" || progress.status === "stalled") {
          // Update status in array so user sees the terminal state visually
          if (existing >= 0) {
            const updated = [...prev];
            updated[existing] = progress;
            // Remove after 1.5s delay so user can see the failed/stalled state
            safeTimeout(() => {
              setDownloads(current => current.filter(d => d.id !== progress.id));
            }, 1500);
            return updated;
          }
          // Not in array yet — schedule removal anyway
          safeTimeout(() => {
            setDownloads(current => current.filter(d => d.id !== progress.id));
          }, 1500);
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
      if (!isInstalling) return;

      if (instId && instId === event.payload.id) {
        // Normal case: install_modpack already returned, ID matches → close dialog
        closeInstallDialog();
      } else if (!instId) {
        // Race condition: instance-created arrived BEFORE install_modpack returned
        // (loader installed faster than mods downloaded). Remember the event ID
        // and close later when install_modpack finishes.
        setEarlyInstanceCreatedId(event.payload.id);
      }
    });

    // Cleanup all listeners on unmount
    const safeUnlisten = (p: Promise<() => void>) => p.then(fn => fn()).catch(() => {});
    onCleanup(() => {
      safeUnlisten(unlistenProgress);
      safeUnlisten(unlistenOperationStarted);
      safeUnlisten(unlistenInstanceOperationStarted);
      safeUnlisten(unlistenOperationCancelled);
      safeUnlisten(unlistenInstallSummary);
      safeUnlisten(unlistenInstanceProgress);
      safeUnlisten(unlistenDownload);
      safeUnlisten(unlistenCreated);
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

  // === Failed mod resolution ===

  const autoSearchFailedMods = async (summary: ModpackInstallSummary) => {
    // Initialize resolution state for each failed mod
    const initial: Record<string, ModResolution> = {};
    for (const mod of summary.failed) {
      initial[mod.file_name] = { status: "searching", results: [], selectedIndex: 0 };
    }
    setModResolutions(initial);

    // Search for each failed mod on both platforms
    for (const mod of summary.failed) {
      try {
        // Try Modrinth first, then CurseForge
        let results: ModSearchInfo[] = [];
        try {
          const modrinthResults = await invoke<ModSearchInfo[]>("search_mod_by_name", {
            name: mod.display_name,
            source: "modrinth",
            minecraftVersion: summary.minecraft_version,
            loader: summary.loader !== "vanilla" ? summary.loader : null,
          });
          results.push(...modrinthResults);
        } catch {
          // Modrinth search failed, continue
        }
        try {
          const cfResults = await invoke<ModSearchInfo[]>("search_mod_by_name", {
            name: mod.display_name,
            source: "curseforge",
            minecraftVersion: summary.minecraft_version,
            loader: summary.loader !== "vanilla" ? summary.loader : null,
          });
          results.push(...cfResults);
        } catch {
          // CurseForge search failed, continue
        }

        setModResolutions((prev) => ({
          ...prev,
          [mod.file_name]: {
            status: results.length > 0 ? "found" : "not_found",
            results,
            selectedIndex: 0,
          },
        }));
      } catch {
        setModResolutions((prev) => ({
          ...prev,
          [mod.file_name]: { status: "error", results: [], selectedIndex: 0 },
        }));
      }
    }
  };

  const installResolvedMod = async (failedMod: FailedModInfo, searchResult: ModSearchInfo) => {
    const summary = installSummary();
    if (!summary) return;

    // Mark as installing
    setModResolutions((prev) => ({
      ...prev,
      [failedMod.file_name]: { ...prev[failedMod.file_name], status: "installing" },
    }));

    try {
      await invoke("install_mod_by_slug", {
        instanceId: summary.instance_id,
        slug: searchResult.source === "curseforge"
          ? searchResult.project_id
          : searchResult.slug,
        source: searchResult.source,
      });

      setModResolutions((prev) => ({
        ...prev,
        [failedMod.file_name]: { ...prev[failedMod.file_name], status: "installed" },
      }));
    } catch {
      setModResolutions((prev) => ({
        ...prev,
        [failedMod.file_name]: { ...prev[failedMod.file_name], status: "error" },
      }));
    }
  };

  const installAllResolved = async () => {
    const summary = installSummary();
    if (!summary) return;

    const resolutions = modResolutions();
    for (const mod of summary.failed) {
      const resolution = resolutions[mod.file_name];
      if (resolution?.status === "found" && resolution.results.length > 0) {
        await installResolvedMod(mod, resolution.results[resolution.selectedIndex]);
      }
    }
  };

  const resolvedCount = createMemo(() => {
    const resolutions = modResolutions();
    return Object.values(resolutions).filter((r) => r.status === "found" || r.status === "installed").length;
  });

  const installedResolvedCount = createMemo(() => {
    const resolutions = modResolutions();
    return Object.values(resolutions).filter((r) => r.status === "installed").length;
  });

  // === End failed mod resolution ===

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

      // If instance-created arrived BEFORE install_modpack returned (race condition),
      // close the dialog now since mods are done downloading
      if (earlyInstanceCreatedId() === instanceId) {
        closeInstallDialog();
      }
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

      // If instance-created arrived early, close now
      if (earlyInstanceCreatedId() === instanceId) {
        closeInstallDialog();
      }
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

      // If instance-created arrived early, close now
      if (earlyInstanceCreatedId() === instanceId) {
        closeInstallDialog();
      }
    } catch (e) {
      setError(String(e));
      setInstalling(false);
    }
  };

  const getProgressText = () => {
    const instStep = instanceInstallStep();
    const instMsg = instanceInstallMessage();
    const progress = installProgress();

    // Instance installation in progress (Java/Minecraft/Loader) — show that
    // BUT if mods are already downloading, prefer showing mod progress
    if (instStep && instStep !== "complete") {
      if (progress && progress.stage === "downloading_mods") {
        // Mods are downloading in parallel with loader — show mod progress
        return `${t().modpacks.browser.downloadingMods} (${progress.current}/${progress.total})${progress.current_file ? `: ${progress.current_file}` : ""}`;
      }
      return instMsg || t().modpacks.browser.installingComponents;
    }

    if (!progress) {
      if (instStep === "complete" && installedInstanceId()) return t().modpacks.browser.ready;
      if (instStep === "complete") return t().modpacks.browser.installingLoader;
      return t().modpacks.browser.preparing;
    }

    switch (progress.stage) {
      case "downloading":
        return t().modpacks.browser.downloadingModpack;
      case "creating_instance":
        return t().modpacks.browser.creatingInstance;
      case "resolving_mods":
        return progress.current_file || `${t().modpacks.browser.analyzingMods} (${progress.current}/${progress.total})...`;
      case "downloading_mods":
        return `${t().modpacks.browser.downloadingMods} (${progress.current}/${progress.total})${progress.current_file ? `: ${progress.current_file}` : ""}`;
      case "extracting_overrides":
        return t().modpacks.browser.extractingFiles;
      case "completed":
        // Mods downloaded — check if loader is still installing
        if (instStep && instStep !== "complete") {
          return t().modpacks.browser.installingLoader;
        }
        return t().modpacks.browser.ready;
      default:
        return t().modpacks.browser.installing;
    }
  };

  const getProgressPercent = () => {
    const progress = installProgress();
    if (!progress || progress.total === 0) return 0;
    return Math.round((progress.current / progress.total) * 100);
  };

  const handleCancel = async () => {
    const instanceOpId = operationId();
    const modpackOpId = modpackOperationId();
    if (!instanceOpId && !modpackOpId) return;

    setCancelling(true);
    try {
      // Cancel BOTH tokens: instance (Java/MC/Loader) AND modpack (mod downloads).
      // They run in parallel, so both must be cancelled to fully stop installation.
      const promises: Promise<boolean>[] = [];
      if (instanceOpId) {
        promises.push(invoke<boolean>("cancel_operation", { operationId: instanceOpId }));
      }
      if (modpackOpId && modpackOpId !== instanceOpId) {
        promises.push(invoke<boolean>("cancel_operation", { operationId: modpackOpId }));
      }
      await Promise.all(promises);
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to cancel:", e);
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
          name: t().ui?.dialogs?.modpackFilter ?? "Modpacks",
          extensions: ["mrpack", "zip", "stzhk"]
        }],
        title: t().ui?.dialogs?.selectModpackFile ?? "Select modpack file"
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
      if (import.meta.env.DEV) console.error("File selection error:", e);
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
        <h2 class="text-xl font-bold">{t().modpacks.browser.title}</h2>
        <button
          class="btn-close"
          onClick={props.onClose}
          aria-label={t().ui?.tooltips?.close ?? "Close"}
        >
          <i class="i-hugeicons-cancel-01 w-5 h-5" />
        </button>
      </div>

      {/* Content */}
      <div class="flex-1 overflow-y-auto p-4 flex flex-col gap-4">

      {/* Installing Overlay */}
      <Show when={installing()}>
        <InstallProgressModal
          cancelling={cancelling}
          installProgress={installProgress}
          instanceInstallStep={instanceInstallStep}
          installedInstanceId={installedInstanceId}
          downloads={downloads}
          operationId={operationId}
          modpackOperationId={modpackOperationId}
          getProgressText={getProgressText}
          getProgressPercent={getProgressPercent}
          onCancel={handleCancel}
          t={t}
        />
      </Show>

      {/* Install Summary Dialog */}
      <Show when={installSummary()}>
        <InstallSummaryDialog
          installSummary={installSummary}
          modResolutions={modResolutions}
          setModResolutions={setModResolutions}
          resolvedCount={resolvedCount}
          installedResolvedCount={installedResolvedCount}
          onAutoSearch={autoSearchFailedMods}
          onInstallMod={installResolvedMod}
          onInstallAll={installAllResolved}
          onDismiss={() => {
            setInstallSummary(null);
            setModResolutions({});
            if (!installing()) {
              setOperationId(null);
              setInstanceInstallStep(null);
              setInstalledInstanceId(null);
              setProgressInstanceId(null);
              setInstalledInstanceName("");
              setDownloads([]);
              setEarlyInstanceCreatedId(null);
              props.onClose();
            }
          }}
          t={t}
        />
      </Show>

      {/* Confirm Install Dialog */}
      <Show when={selectedModpack() && !installing()}>
        <div class="fixed inset-0 bg-black/50 backdrop-blur-sm z-40 flex items-center justify-center p-4">
          <div class="card max-w-md w-full">
            <h3 class="text-lg font-semibold mb-4">{t().modpacks.browser.confirm.title}</h3>

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
              <span class="text-sm text-muted mb-1 block">{t().modpacks.browser.confirm.instanceName}</span>
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
                {t().common.cancel}
              </button>
              <button
                class="btn-primary"
                onClick={confirmInstall}
                disabled={!instanceName()}
              >
                <i class="i-hugeicons-download-02 w-4 h-4" />
                {t().common.install}
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
              ? "bg-[var(--color-primary)] text-white"
              : "bg-gray-800 text-gray-300 hover:bg-gray-750"
          }`}
          onClick={() => { setShowFileInstall(false); setShowUrlInstall(false); }}
        >
          <i class="i-hugeicons-search-01 w-4 h-4" />
          {t().modpacks.browser.tabs.search}
        </button>
        <button
          class={`flex-1 px-4 py-2 rounded-2xl font-medium transition-colors duration-100 inline-flex items-center justify-center gap-2 ${
            showFileInstall()
              ? "bg-[var(--color-primary)] text-white"
              : "bg-gray-800 text-gray-300 hover:bg-gray-750"
          }`}
          onClick={() => { setShowFileInstall(true); setShowUrlInstall(false); }}
        >
          <i class="i-hugeicons-folder-01 w-4 h-4" />
          {t().modpacks.browser.tabs.fromFile}
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
          {t().modpacks.browser.tabs.byLink}
        </button>
        <Tooltip text={t().modpacks.browser.tabs.compare} position="bottom">
          <button
            class="px-4 py-2 rounded-2xl font-medium transition-colors duration-100 bg-purple-600/20 text-purple-400 hover:bg-purple-600/30 border border-purple-600/30 inline-flex items-center justify-center gap-2"
            onClick={() => setShowCompareDialog(true)}
          >
            <i class="i-hugeicons-git-compare w-4 h-4" />
            {t().modpacks.browser.tabs.compare}
          </button>
        </Tooltip>
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
        <FileInstallPanel
          filePath={filePath}
          fileInstanceName={fileInstanceName}
          filePreview={filePreview}
          filePreviewLoading={filePreviewLoading}
          filePreviewError={filePreviewError}
          installing={installing}
          onSelectFile={selectFile}
          onClearFile={clearFile}
          onSetInstanceName={setFileInstanceName}
          onShowDetailedPreview={() => setShowDetailedPreview(true)}
          onInstall={handleFileInstall}
          t={t}
        />
      </Show>

      {/* URL Install Mode */}
      <Show when={showUrlInstall()}>
        <UrlInstallPanel
          urlInput={urlInput}
          urlInstanceName={urlInstanceName}
          installing={installing}
          onSetUrl={setUrlInput}
          onSetInstanceName={setUrlInstanceName}
          onInstall={handleUrlInstall}
          t={t}
        />
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
            <span class="text-muted">{t().modpacks.browser.search.searching}</span>
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
                    <p class="text-xs text-muted mb-1">{t().modpacks.browser.search.by} {modpack.author}</p>
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
                      {t().common.install}
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
            <p class="text-muted">{t().modpacks.browser.search.notFound}</p>
            <p class="text-sm text-dimmer">{t().modpacks.browser.search.tryDifferent}</p>
          </div>
        </Show>

        {/* Initial State */}
        <Show when={!loading() && results().length === 0 && !debouncedQuery()}>
          <div class="card flex-col-center py-12 text-center">
            <i class="i-hugeicons-package w-12 h-12 text-gray-600 mb-3" />
            <p class="text-muted">{t().modpacks.browser.search.enterQuery}</p>
            <p class="text-sm text-dimmer">{t().modpacks.browser.search.findModpacks}</p>
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
              <label class="text-sm text-gray-400">{t().modpacks.browser.preview.name}</label>
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
