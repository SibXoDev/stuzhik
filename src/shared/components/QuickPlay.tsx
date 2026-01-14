import { createSignal, createEffect, Show, For, onMount, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import type { LoaderType, MinecraftVersion, Instance, Settings } from "../types";
import { useI18n } from "../i18n";
import { Select } from "../ui/Select";

interface Props {
  instances: Instance[];
  onInstanceCreated?: () => void;
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

const LOADERS: { id: LoaderType; name: string }[] = [
  { id: "vanilla", name: "Vanilla" },
  { id: "fabric", name: "Fabric" },
  { id: "forge", name: "Forge" },
  { id: "neoforge", name: "NeoForge" },
  { id: "quilt", name: "Quilt" },
];

const QUICK_PLAY_INSTANCE_NAME = "Quick Play";

export default function QuickPlay(props: Props) {
  const { t } = useI18n();

  const [versions, setVersions] = createSignal<MinecraftVersion[]>([]);
  const [selectedVersion, setSelectedVersion] = createSignal("");
  const [selectedLoader, setSelectedLoader] = createSignal<LoaderType>("vanilla");
  const [isLoading, setIsLoading] = createSignal(false);
  const [_isPlaying, setIsPlaying] = createSignal(false);
  const [loadingVersions, setLoadingVersions] = createSignal(true);
  const [loaderAvailable, setLoaderAvailable] = createSignal(true);
  const [checkingLoader, setCheckingLoader] = createSignal(false);

  // Installation progress state
  const [installStep, setInstallStep] = createSignal<InstallProgress["step"] | null>(null);
  const [installMessage, setInstallMessage] = createSignal("");
  const [currentDownload, setCurrentDownload] = createSignal<DownloadProgress | null>(null);
  const [isInstalling, setIsInstalling] = createSignal(false);

  // Find Quick Play instance
  const quickPlayInstance = () =>
    props.instances.find(i => i.name === QUICK_PLAY_INSTANCE_NAME);

  // Check if currently running
  const isRunning = () => {
    const instance = quickPlayInstance();
    return instance?.status === "running" || instance?.status === "starting";
  };

  // Check if currently installing
  const isCurrentlyInstalling = () => {
    const instance = quickPlayInstance();
    return instance?.status === "installing";
  };

  // Load versions on mount + restore saved values from existing instance
  onMount(async () => {
    try {
      const data = await invoke<MinecraftVersion[]>("fetch_minecraft_versions");
      // Only releases, sorted by date
      const releases = data.filter(v => v.type === "release");
      setVersions(releases);

      // Check if Quick Play instance exists and restore its version/loader
      const existingInstance = props.instances.find(i => i.name === QUICK_PLAY_INSTANCE_NAME);
      if (existingInstance) {
        // Restore saved values from existing instance
        setSelectedVersion(existingInstance.version);
        setSelectedLoader(existingInstance.loader as LoaderType);
        if (import.meta.env.DEV) console.log("[QuickPlay] Restored from existing instance:", existingInstance.version, existingInstance.loader);
      } else if (releases.length > 0) {
        // Set latest version as default only if no instance exists
        setSelectedVersion(releases[0].id);
      }
    } catch (e) {
      console.error("[QuickPlay] Failed to load versions:", e);
    } finally {
      setLoadingVersions(false);
    }
  });

  // Update installing state based on instance status
  createEffect(() => {
    const instance = quickPlayInstance();
    if (instance) {
      setIsInstalling(instance.status === "installing");
    }
  });

  // Listen for instance status changes
  let unlistenStatus: UnlistenFn | undefined;
  let unlistenProgress: UnlistenFn | undefined;
  let unlistenDownload: UnlistenFn | undefined;
  let unlistenCreated: UnlistenFn | undefined;
  let unlistenFailed: UnlistenFn | undefined;

  onMount(async () => {
    unlistenStatus = await listen<{ id: string; status: string }>("instance-status-changed", (event) => {
      const instance = quickPlayInstance();
      if (instance && event.payload.id === instance.id) {
        if (event.payload.status === "stopped" || event.payload.status === "error") {
          setIsPlaying(false);
          setIsInstalling(false);
          setInstallStep(null);
          setCurrentDownload(null);
        } else if (event.payload.status === "installing") {
          setIsInstalling(true);
        }
      }
    });

    // Listen for installation progress
    unlistenProgress = await listen<InstallProgress>("instance-install-progress", (event) => {
      const instance = quickPlayInstance();
      if (instance && event.payload.id === instance.id) {
        setInstallStep(event.payload.step);
        setInstallMessage(event.payload.message);
      }
    });

    // Listen for download progress
    unlistenDownload = await listen<DownloadProgress>("download-progress", (event) => {
      // Show download progress during installation
      if (isInstalling() || isLoading()) {
        if (event.payload.status === "completed") {
          setCurrentDownload(null);
        } else {
          setCurrentDownload(event.payload);
        }
      }
    });

    // Listen for instance created (installation complete)
    unlistenCreated = await listen<{ id: string }>("instance-created", (event) => {
      const instance = quickPlayInstance();
      if (instance && event.payload.id === instance.id) {
        setIsInstalling(false);
        setInstallStep(null);
        setInstallMessage("");
        setCurrentDownload(null);
        setIsLoading(false);
      }
    });

    // Listen for installation failed
    unlistenFailed = await listen<{ id: string; error: string }>("instance-creation-failed", (event) => {
      const instance = quickPlayInstance();
      if (instance && event.payload.id === instance.id) {
        setIsInstalling(false);
        setInstallStep(null);
        setInstallMessage("");
        setCurrentDownload(null);
        setIsLoading(false);
        setIsPlaying(false);
      }
    });
  });

  onCleanup(() => {
    unlistenStatus?.();
    unlistenProgress?.();
    unlistenDownload?.();
    unlistenCreated?.();
    unlistenFailed?.();
  });

  // Check loader availability when loader or version changes
  createEffect(async () => {
    const loader = selectedLoader();
    const version = selectedVersion();

    // Vanilla is always available
    if (loader === "vanilla" || !version) {
      setLoaderAvailable(true);
      return;
    }

    setCheckingLoader(true);
    try {
      const loaderVersions = await invoke<string[]>("get_loader_versions", {
        minecraftVersion: version,
        loader: loader,
      });
      setLoaderAvailable(loaderVersions.length > 0);
    } catch (e) {
      console.error("[QuickPlay] Failed to check loader availability:", e);
      setLoaderAvailable(false);
    } finally {
      setCheckingLoader(false);
    }
  });

  const handlePlay = async () => {
    if (isRunning()) {
      // Stop instance
      const instance = quickPlayInstance();
      if (instance) {
        try {
          await invoke("stop_instance", { id: instance.id });
        } catch (e) {
          console.error("[QuickPlay] Failed to stop:", e);
        }
      }
      return;
    }

    setIsLoading(true);
    setIsPlaying(true);

    try {
      // Get global settings for memory
      const settings = await invoke<Settings>("get_settings");
      const memory = settings.default_memory_max || 4096;

      const instance = quickPlayInstance();

      // Check if instance exists and matches current selection
      if (instance) {
        // If version or loader changed, reset the instance (preserves user settings like options.txt)
        if (instance.version !== selectedVersion() || instance.loader !== selectedLoader()) {
          // Get latest loader version
          let loaderVersion: string | null = null;
          if (selectedLoader() !== "vanilla") {
            try {
              const loaderVersions = await invoke<string[]>("get_loader_versions", {
                minecraftVersion: selectedVersion(),
                loader: selectedLoader(),
              });
              if (loaderVersions.length > 0) {
                loaderVersion = loaderVersions[0];
              }
            } catch (e) {
              console.error("[QuickPlay] Failed to get loader versions:", e);
            }
          }

          // Reset instance version while preserving user files (options.txt, saves, etc.)
          await invoke<Instance>("reset_instance_version", {
            id: instance.id,
            newVersion: selectedVersion(),
            newLoader: selectedLoader(),
            newLoaderVersion: loaderVersion,
          });

          props.onInstanceCreated?.();
          // Wait for installation to complete
          return;
        } else {
          // Instance exists and matches, just start it
          await invoke("start_instance", { id: instance.id });
          return;
        }
      }

      // Create new instance if none exists
      // Get latest loader version
      let loaderVersion = "";
      if (selectedLoader() !== "vanilla") {
        try {
          const loaderVersions = await invoke<string[]>("get_loader_versions", {
            minecraftVersion: selectedVersion(),
            loader: selectedLoader(),
          });
          if (loaderVersions.length > 0) {
            loaderVersion = loaderVersions[0];
          }
        } catch (e) {
          console.error("[QuickPlay] Failed to get loader versions:", e);
        }
      }

      await invoke<Instance>("create_instance", {
        req: {
          name: QUICK_PLAY_INSTANCE_NAME,
          version: selectedVersion(),
          loader: selectedLoader(),
          loader_version: loaderVersion,
          instance_type: "client",
          memory_mb: memory,
        },
      });

      props.onInstanceCreated?.();
    } catch (e) {
      console.error("[QuickPlay] Failed:", e);
      setIsPlaying(false);
    } finally {
      setIsLoading(false);
    }
  };

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

  // Check if should show installing state
  const showInstallingState = () => isInstalling() || isCurrentlyInstalling() || (isLoading() && !isRunning());

  return (
    <div class="flex flex-col gap-3 mx-auto w-fit">
      {/* Main controls row */}
      <div class="flex items-center gap-3 bg-gray-850 border border-gray-750 rounded-2xl p-4">
        {/* Version selector */}
        <div class="w-[180px]">
          <Show
            when={!loadingVersions()}
            fallback={
              <div class="h-10 bg-gray-850 rounded-xl animate-pulse" />
            }
          >
            <Select
              value={selectedVersion()}
              options={versions().map(v => ({ value: v.id, label: v.id }))}
              onChange={setSelectedVersion}
              disabled={isLoading() || isRunning() || isInstalling()}
              maxHeight="300px"
            />
          </Show>
        </div>

        {/* Loader selector */}
        <div class="w-[140px]">
          <Select
            value={selectedLoader()}
            options={LOADERS.map(l => ({ value: l.id, label: l.name }))}
            onChange={(v) => setSelectedLoader(v as LoaderType)}
            disabled={isLoading() || isRunning() || isInstalling()}
          />
        </div>

        {/* Play button */}
        <button
          class={`h-10 px-6 rounded-xl font-medium transition-colors flex items-center gap-2 ${
            isRunning()
              ? "bg-red-600 hover:bg-red-500 text-white"
              : showInstallingState()
                ? "bg-blue-600 text-white cursor-wait"
                : !loaderAvailable() && selectedLoader() !== "vanilla"
                  ? "bg-gray-600 cursor-not-allowed text-gray-400"
                  : "bg-green-600 hover:bg-green-500 text-white"
          }`}
          onClick={handlePlay}
          disabled={isLoading() || loadingVersions() || checkingLoader() || isInstalling() || (!loaderAvailable() && selectedLoader() !== "vanilla")}
          title={!loaderAvailable() && selectedLoader() !== "vanilla"
            ? t().loaders?.notSupportedHint || `${LOADERS.find(l => l.id === selectedLoader())?.name} не поддерживает эту версию Minecraft`
            : undefined}
        >
          <Show when={showInstallingState() || checkingLoader()}>
            <i class="i-svg-spinners-6-dots-scale w-4 h-4 text-white" />
          </Show>
          <Show when={!showInstallingState() && !checkingLoader()}>
            <Show
              when={!loaderAvailable() && selectedLoader() !== "vanilla"}
              fallback={
                <i class={`w-5 h-5 ${isRunning() ? "i-hugeicons-stop" : "i-hugeicons-play"}`} />
              }
            >
              <i class="i-hugeicons-alert-02 w-5 h-5 text-yellow-400" />
            </Show>
          </Show>
          <span>
            {isRunning()
              ? t().common.stop
              : showInstallingState()
                ? t().quickPlay?.installing || "Установка..."
                : !loaderAvailable() && selectedLoader() !== "vanilla"
                  ? t().loaders?.notSupported || "Не поддерживается"
                  : t().common.play || "Играть"}
          </span>
        </button>
      </div>

      {/* Installation progress indicator */}
      <Show when={showInstallingState()}>
        <div class="bg-gray-850 border border-gray-750 rounded-2xl p-3 animate-in fade-in slide-in-from-top-2 duration-100">
          {/* Step indicators */}
          <div class="flex items-center justify-center gap-2 mb-2">
            <For each={["java", "minecraft", "loader"] as const}>
              {(step, index) => {
                const currentIndex = () => {
                  const s = installStep();
                  if (s === "java") return 0;
                  if (s === "minecraft") return 1;
                  if (s === "loader") return 2;
                  if (s === "complete") return 3;
                  return -1;
                };
                const isActive = () => currentIndex() === index();
                const isCompleted = () => currentIndex() > index();

                return (
                  <>
                    <div class="flex items-center gap-1.5">
                      <div
                        class={`w-6 h-6 rounded-full flex items-center justify-center text-xs transition-all ${
                          isCompleted()
                            ? "bg-green-600 text-white"
                            : isActive()
                              ? "bg-blue-600 text-white"
                              : "bg-gray-700 text-gray-500"
                        }`}
                      >
                        <Show when={isCompleted()} fallback={
                          <Show when={isActive()} fallback={<span>{index() + 1}</span>}>
                            <i class="i-svg-spinners-6-dots-scale w-3 h-3 text-white" />
                          </Show>
                        }>
                          <i class="i-hugeicons-checkmark-circle-02 w-3 h-3" />
                        </Show>
                      </div>
                      <span class={`text-xs ${isActive() ? "text-white" : "text-gray-500"}`}>
                        {getStepLabel(step)}
                      </span>
                    </div>
                    <Show when={index() < 2}>
                      <div class={`w-6 h-0.5 ${isCompleted() ? "bg-green-600" : "bg-gray-700"}`} />
                    </Show>
                  </>
                );
              }}
            </For>
          </div>

          {/* Current message */}
          <Show when={installMessage()}>
            <p class="text-xs text-gray-400 text-center truncate">{installMessage()}</p>
          </Show>

          {/* Download progress */}
          <Show when={currentDownload()}>
            {(download) => (
              <div class="mt-2 pt-2 border-t border-gray-750">
                <div class="flex items-center justify-between mb-1">
                  <span class="text-xs text-gray-400 truncate flex-1 mr-2">{download().name}</span>
                  <span class="text-xs text-gray-500">{download().percentage.toFixed(0)}%</span>
                </div>
                <div class="w-full h-1 bg-gray-700 rounded-full overflow-hidden">
                  <div
                    class="h-full bg-blue-600 transition-all duration-100"
                    style={{ width: `${download().percentage}%` }}
                  />
                </div>
                <div class="flex items-center justify-between mt-1">
                  <span class="text-xs text-gray-500">
                    {(download().downloaded / 1024 / 1024).toFixed(1)} / {(download().total / 1024 / 1024).toFixed(1)} MB
                  </span>
                  <span class="text-xs text-gray-500">
                    {(download().speed / 1024 / 1024).toFixed(1)} MB/s
                  </span>
                </div>
              </div>
            )}
          </Show>
        </div>
      </Show>
    </div>
  );
}
