import { createSignal, Show, onMount, For, createEffect } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { Instance, LoaderType, InstanceUpdate, JavaInstallationInfo, JavaCompatibility } from "../../../shared/types";
import VersionSelector from "../../../shared/components/VersionSelector";
import LoaderVersionSelector from "../../../shared/components/LoaderVersionSelector";
import { createConfirmDialog } from "../../../shared/components/ConfirmDialog";
import { useI18n } from "../../../shared/i18n";
import Dropdown from "../../../shared/ui/Dropdown";
import { Select } from "../../../shared/ui/Select";
import { ModalWrapper } from "../../../shared/ui/ModalWrapper";
import { RangeSlider } from "../../../shared/ui";

export interface EditInstanceDialogProps {
  instance: Instance;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * Get memory step based on total memory
 */
function getMemoryStep(maxMemory: number): number {
  return maxMemory <= 8192 ? 512 : 1024;
}

/**
 * Generate memory markers for RangeSlider based on max memory
 * @param maxMemory - Maximum memory in MB
 * @returns Array of memory values in MB for tick marks
 */
function generateMemoryMarkers(maxMemory: number): number[] {
  const markers: number[] = [];
  const step = maxMemory <= 8192 ? 512 : 1024; // 512MB step for <=8GB, 1GB step for >8GB

  // Generate all ticks from step to maxMemory
  for (let i = step; i <= maxMemory; i += step) {
    markers.push(i);
  }

  // Always add max value as last marker if not already there
  if (markers.length > 0 && markers[markers.length - 1] !== maxMemory) {
    markers.push(maxMemory);
  }

  return markers;
}

/**
 * Generate filtered ticks for labels - only multiples of 2GB to avoid clutter
 * Always includes first and last tick
 * @param allTicks - All tick values
 * @returns Filtered array for labels (multiples of 2048 MB)
 */
function generateLabelTicks(allTicks: number[]): number[] {
  if (allTicks.length <= 8) return allTicks; // Show all if few ticks

  const result: number[] = [allTicks[0]]; // Always include first

  // Only show values that are multiples of 2048 (2 GB)
  for (const tick of allTicks) {
    if (tick % 2048 === 0 && tick !== allTicks[0] && tick !== allTicks[allTicks.length - 1]) {
      result.push(tick);
    }
  }

  result.push(allTicks[allTicks.length - 1]); // Always include last
  return result;
}

/**
 * Format memory value for labels (MB to GB with 1 decimal, hide .0)
 */
function formatMemoryLabel(mb: number): string {
  const gb = mb / 1024;
  return gb % 1 === 0 ? `${gb.toFixed(0)} GB` : `${gb.toFixed(1)} GB`;
}

function EditInstanceDialog(props: EditInstanceDialogProps) {
  const { confirm, ConfirmDialogComponent } = createConfirmDialog();
  const { t } = useI18n();

  // Safe accessor for instance
  const inst = () => props.instance;
  const instanceId = () => inst()?.id ?? "";
  const instanceType = () => inst()?.instance_type ?? "client";

  const [totalMemory, setTotalMemory] = createSignal(8192); // default value
  const [name, setName] = createSignal(props.instance.name);
  const [version, setVersion] = createSignal(props.instance.version);
  const [loader, setLoader] = createSignal(props.instance.loader);
  const [loaderVersion, setLoaderVersion] = createSignal(props.instance.loader_version || "");
  const [memoryMin, setMemoryMin] = createSignal(props.instance.memory_min);
  const [memoryMax, setMemoryMax] = createSignal(props.instance.memory_max);
  const [javaArgs, setJavaArgs] = createSignal(props.instance.java_args || "");
  const [gameArgs, setGameArgs] = createSignal(props.instance.game_args || "");
  const [username, setUsername] = createSignal(props.instance.username || "");
  const [notes, setNotes] = createSignal(props.instance.notes || "");
  const [port, setPort] = createSignal(props.instance.port || 25565);

  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [showAdvancedVersions, setShowAdvancedVersions] = createSignal(false);
  const [versionsChanged, setVersionsChanged] = createSignal(false);

  // Java selection state
  const [javaPath, setJavaPath] = createSignal(props.instance.java_path || "");
  const [availableJava, setAvailableJava] = createSignal<JavaInstallationInfo[]>([]);
  const [javaCompatibility, setJavaCompatibility] = createSignal<JavaCompatibility | null>(null);
  const [loadingJava, setLoadingJava] = createSignal(false);
  const [javaDropdownOpen, setJavaDropdownOpen] = createSignal(false);

  // Helper function to get required Java major version for MC version
  const getRequiredJavaMajor = (mcVersion: string): number => {
    const [major, minor] = mcVersion.split(".").map(Number);
    if (major === 1) {
      if (minor >= 21) return 21;
      if (minor >= 17) return 17;
    }
    return 8;
  };

  // Load available Java versions for this MC version
  const loadAvailableJava = async () => {
    setLoadingJava(true);
    try {
      const requiredMajor = getRequiredJavaMajor(version());
      const javaVersions = await invoke<JavaInstallationInfo[]>("get_java_for_version", {
        majorVersion: requiredMajor,
      });
      setAvailableJava(javaVersions);
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to load Java versions:", e);
    } finally {
      setLoadingJava(false);
    }
  };

  // Check Java compatibility when java_path changes
  const checkJavaCompatibility = async (path: string) => {
    if (!path) {
      setJavaCompatibility(null);
      return;
    }
    try {
      const result = await invoke<JavaCompatibility>("check_java_compatibility_for_path", {
        javaPath: path,
        minecraftVersion: version(),
      });
      setJavaCompatibility(result);
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to check Java compatibility:", e);
      setJavaCompatibility(null);
    }
  };

  // Load total memory and Java on mount
  onMount(async () => {
    try {
      const memory = await invoke<number>("get_total_memory");
      setTotalMemory(memory);
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to get total memory:", e);
    }
    await loadAvailableJava();
    if (javaPath()) {
      await checkJavaCompatibility(javaPath());
    }
  });

  // Reload Java versions when MC version changes
  createEffect(() => {
    const v = version();
    if (v) {
      loadAvailableJava();
      if (javaPath()) {
        checkJavaCompatibility(javaPath());
      }
    }
  });

  const handleSubmit = async (e: SubmitEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const updates: InstanceUpdate = {
        name: name(),
        version: version(),
        loader: loader(),
        loader_version: loaderVersion() || null,
        memory_min: memoryMin(),
        memory_max: memoryMax(),
        java_path: javaPath() || null,
        java_args: javaArgs() || null,
        game_args: gameArgs() || null,
        username: username() || null,
        notes: notes() || null,
        port: instanceType() === "server" ? port() : undefined,
      };

      await invoke("update_instance", {
        id: instanceId(),
        updates: updates,
      });

      // Если версии изменились, предлагаем repair
      if (versionsChanged()) {
        const shouldRepair = await confirm({
          title: t().instances.edit.repairDialog.title,
          message: t().instances.edit.repairDialog.message,
          variant: "info",
          confirmText: t().instances.edit.repairDialog.confirm,
          cancelText: t().instances.edit.repairDialog.skip,
        });
        if (shouldRepair) {
          try {
            await invoke("repair_instance", { id: instanceId() });
          } catch (repairError: unknown) {
            if (import.meta.env.DEV) console.error("Failed to repair instance:", repairError);
            const repairMsg = repairError instanceof Error ? repairError.message : String(repairError);
            setError(`${t().instances.edit.repairError}: ${repairMsg}`);
          }
        }
      }

      props.onSaved();
      props.onClose();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      if (import.meta.env.DEV) console.error("Failed to update instance:", e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <ModalWrapper maxWidth="max-w-4xl">
      <div class="p-6 flex flex-col gap-6">
        <div class="flex items-center justify-between">
          <h2 class="text-2xl font-bold">{t().instances.edit.title}</h2>
          <button
            type="button"
            class="btn-close"
            onClick={props.onClose}
            aria-label={t().ui?.tooltips?.close ?? "Close"}
          >
            <i class="i-hugeicons-cancel-01 w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} class="space-y-4">
          {/* Error Alert */}
          <Show when={error()}>
            <div class="bg-red-500/10 border border-red-500/30 rounded-2xl p-4 flex items-start gap-3">
              <div class="i-hugeicons-alert-02 text-red-400 w-5 h-5 flex-shrink-0" />
              <p class="text-red-400 text-sm flex-1">{error()}</p>
              <button
                type="button"
                class="text-red-400 hover:text-red-300"
                onClick={() => setError(null)}
              >
                <div class="i-hugeicons-cancel-01 w-5 h-5" />
              </button>
            </div>
          </Show>

          {/* Версии Minecraft и Загрузчика */}
          <div class="border border-gray-750 rounded-2xl p-4 flex flex-col gap-3">
            <div class="flex items-center justify-between">
              <h3 class="text-base font-semibold">{t().instances.edit.versions}</h3>
              <button
                type="button"
                class="text-xs px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded-2xl"
                onClick={() => setShowAdvancedVersions(!showAdvancedVersions())}
              >
                {showAdvancedVersions() ? t().instances.edit.hideVersions : t().instances.edit.showVersions}
              </button>
            </div>

            <Show
              when={showAdvancedVersions()}
              fallback={
                <div class="text-sm text-gray-400">
                  <p>
                    <strong>{t().instances.edit.minecraftLabel}:</strong> {inst()?.version}
                  </p>
                  <p>
                    <strong>{t().instances.edit.loaderLabel}:</strong> {inst()?.loader}
                    {inst()?.loader_version && ` (${inst()?.loader_version})`}
                  </p>
                </div>
              }
            >
              <div class="space-y-4">
                <div class="bg-amber-500/10 border border-amber-500/30 rounded-2xl p-3 text-xs text-amber-500 flex items-start gap-2">
                  <div class="i-hugeicons-alert-02 w-4 h-4 flex-shrink-0 mt-0.5" />
                  <p>{t().instances.edit.versionWarning}</p>
                </div>

                <div class="flex flex-col gap-2">
                  <label class="block text-sm font-medium">{t().instances.edit.minecraftVersion}</label>
                  <VersionSelector
                    value={version()}
                    onChange={(v) => {
                      setVersion(v);
                      setVersionsChanged(true);
                    }}
                    disabled={loading()}
                    loader={loader()}
                  />
                </div>

                <div class="flex flex-col gap-2">
                  <label class="block text-sm font-medium">{t().instances.edit.loaderLabel}</label>
                  <Select
                    value={loader()}
                    onChange={(val) => {
                      setLoader(val as LoaderType);
                      setVersionsChanged(true);
                    }}
                    disabled={loading()}
                    options={[
                      { value: "vanilla", label: "Vanilla" },
                      { value: "forge", label: "Forge" },
                      { value: "neoforge", label: "NeoForge" },
                      { value: "fabric", label: "Fabric" },
                      { value: "quilt", label: "Quilt" },
                    ]}
                  />
                </div>

                <div class="flex flex-col gap-2">
                  <label class="block text-sm font-medium inline-flex items-center gap-1">
                    {t().instances.edit.loaderVersion}
                    <span class="text-xs text-gray-400">{t().instances.edit.optional}</span>
                  </label>
                  <LoaderVersionSelector
                    value={loaderVersion()}
                    onChange={(v) => {
                      setLoaderVersion(v);
                      setVersionsChanged(true);
                    }}
                    disabled={loading()}
                    loader={loader()}
                    minecraftVersion={version()}
                  />
                </div>
              </div>
            </Show>
          </div>

          {/* Название */}
          <div class="flex flex-col gap-2">
            <label class="block text-sm font-medium">{t().instances.edit.name}</label>
            <input
              type="text"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              placeholder={t().instances.edit.namePlaceholder}
              required
              disabled={loading()}
              class="w-full px-3.5 py-2.5 border border-gray-700 rounded-2xl text-white transition-colors duration-150 hover:border-gray-600 focus:outline-none focus:border-[var(--color-primary)]"
            />
          </div>

          {/* Память */}
          <fieldset class="flex flex-col gap-4">
            <legend class="text-base font-medium inline-flex items-center gap-2">
              {t().instances.edit.memory}
              <span class="text-xs text-gray-400">
                {t().instances.edit.available}: {totalMemory()} MB
              </span>
            </legend>

            <div class="space-y-4">
              {/* Для КЛИЕНТА - один слайдер */}
              <Show when={instanceType() === "client"}>
                <div class="flex flex-col gap-2">
                  <div class="flex items-center justify-between">
                    <label class="text-sm font-medium">{t().instances.edit.allocateMemory}</label>
                    <span class="text-sm text-gray-400">{memoryMax()} MB ({(memoryMax() / 1024).toFixed(1)} GB)</span>
                  </div>
                  <RangeSlider
                    value={memoryMax()}
                    onChange={setMemoryMax}
                    min={getMemoryStep(totalMemory())}
                    max={totalMemory()}
                    step={getMemoryStep(totalMemory())}
                    showTicks
                    showLabels
                    ticks={generateMemoryMarkers(totalMemory())}
                    labelTicks={generateLabelTicks(generateMemoryMarkers(totalMemory()))}
                    formatLabel={formatMemoryLabel}
                  />
                  <p class="text-xs text-gray-400">
                    {t().instances.edit.memoryHint}
                  </p>
                </div>
              </Show>

              {/* Для СЕРВЕРА - два слайдера min/max */}
              <Show when={instanceType() === "server"}>
                <>
                  <div class="flex flex-col gap-2">
                    <div class="flex items-center justify-between">
                      <label class="text-sm font-medium">{t().instances.edit.minMemory}</label>
                      <span class="text-sm text-gray-400">{memoryMin()} MB ({(memoryMin() / 1024).toFixed(1)} GB)</span>
                    </div>
                    <RangeSlider
                      value={memoryMin()}
                      onChange={(val) => {
                        setMemoryMin(val);
                        if (val > memoryMax()) {
                          setMemoryMax(val);
                        }
                      }}
                      min={getMemoryStep(Math.min(memoryMax(), totalMemory()))}
                      max={Math.min(memoryMax(), totalMemory())}
                      step={getMemoryStep(Math.min(memoryMax(), totalMemory()))}
                      showTicks
                      showLabels
                      ticks={generateMemoryMarkers(Math.min(memoryMax(), totalMemory()))}
                      labelTicks={generateLabelTicks(generateMemoryMarkers(Math.min(memoryMax(), totalMemory())))}
                      formatLabel={formatMemoryLabel}
                    />
                  </div>

                  <div class="flex flex-col gap-2">
                    <div class="flex items-center justify-between">
                      <label class="text-sm font-medium">{t().instances.edit.maxMemory}</label>
                      <span class="text-sm text-gray-400">{memoryMax()} MB ({(memoryMax() / 1024).toFixed(1)} GB)</span>
                    </div>
                    <RangeSlider
                      value={memoryMax()}
                      onChange={(val) => {
                        setMemoryMax(val);
                        if (val < memoryMin()) {
                          setMemoryMin(val);
                        }
                      }}
                      min={Math.max(getMemoryStep(totalMemory()), memoryMin())}
                      max={totalMemory()}
                      step={getMemoryStep(totalMemory())}
                      showTicks
                      showLabels
                      ticks={generateMemoryMarkers(totalMemory())}
                      labelTicks={generateLabelTicks(generateMemoryMarkers(totalMemory()))}
                      formatLabel={formatMemoryLabel}
                    />
                  </div>
                </>
              </Show>
            </div>
          </fieldset>

          {/* Порт сервера */}
          <Show when={instanceType() === "server"}>
            <div class="flex flex-col gap-2">
              <label class="block text-sm font-medium">{t().instances.edit.serverPort}</label>
              <input
                type="number"
                value={port()}
                onInput={(e) => setPort(Number(e.currentTarget.value))}
                min="1024"
                max="65535"
                class="w-full px-3.5 py-2.5 border border-gray-700 rounded-2xl text-white transition-colors duration-150 hover:border-gray-600 focus:outline-none focus:border-[var(--color-primary)]"
              />
            </div>
          </Show>

          {/* Имя игрока */}
          <Show when={instanceType() === "client"}>
            <div class="flex flex-col gap-2">
              <label class="block text-sm font-medium inline-flex items-center gap-1">
                {t().instances.edit.username}
                <span class="text-xs text-gray-400">{t().instances.edit.optional}</span>
              </label>
              <input
                type="text"
                value={username()}
                onInput={(e) => setUsername(e.currentTarget.value)}
                placeholder={t().instances.edit.fromGlobalSettings}
                class="w-full px-3.5 py-2.5 border border-gray-700 rounded-2xl text-white transition-colors duration-150 hover:border-gray-600 focus:outline-none focus:border-[var(--color-primary)]"
              />
            </div>
          </Show>

          {/* Выбор Java */}
          <div class="flex flex-col gap-2">
            <label class="block text-sm font-medium inline-flex items-center gap-1">
              {t().instances.edit.java}
              <span class="text-xs text-gray-400">{t().instances.edit.optional}</span>
            </label>

            {loadingJava() ? (
              <div class="flex items-center gap-2 text-gray-400 py-2">
                <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                <span class="text-sm">{t().common.loading}</span>
              </div>
            ) : (
              <div class="space-y-2">
                {/* Dropdown для выбора Java */}
                <Dropdown
                  open={javaDropdownOpen()}
                  onClose={() => setJavaDropdownOpen(false)}
                  trigger={
                    <button
                      type="button"
                      class="w-full px-3.5 py-2.5 border border-gray-700 rounded-2xl text-white transition-colors duration-150 hover:border-gray-600 focus:outline-none focus:border-[var(--color-primary)] flex items-center justify-between"
                      onClick={() => setJavaDropdownOpen(!javaDropdownOpen())}
                    >
                      <span class={javaPath() ? "" : "text-gray-400"}>
                        {javaPath()
                          ? (() => {
                              const java = availableJava().find((j) => j.path === javaPath());
                              return java
                                ? `${java.vendor || "Java"} - ${java.path.split(/[/\\]/).pop()}${java.is_active ? " ★" : ""}`
                                : javaPath().split(/[/\\]/).pop();
                            })()
                          : t().instances.edit.javaAuto}
                      </span>
                      <i class="i-hugeicons-arrow-down-01 w-4 h-4 text-gray-400" />
                    </button>
                  }
                >
                  <div class="overflow-y-auto p-1">
                    {/* Автоматический выбор */}
                    <button
                      type="button"
                      class={`w-full px-3 py-2.5 text-left text-sm hover:bg-gray-700/50 transition-colors rounded-xl flex items-center gap-2 ${
                        !javaPath() ? "bg-[var(--color-primary-bg)] text-[var(--color-primary)]" : ""
                      }`}
                      onClick={() => {
                        setJavaPath("");
                        setJavaCompatibility(null);
                        setJavaDropdownOpen(false);
                      }}
                    >
                      <i class="i-hugeicons-settings-02 w-4 h-4" />
                      <div>
                        <div class="font-medium">{t().instances.edit.javaAuto}</div>
                        <div class="text-xs text-gray-500">{t().instances.edit.javaAutoHint}</div>
                      </div>
                    </button>

                    {/* Список Java */}
                    <For each={availableJava()}>
                      {(java) => (
                        <button
                          type="button"
                          class={`w-full px-3 py-2.5 text-left text-sm hover:bg-gray-700/50 transition-colors rounded-xl flex items-center gap-2 ${
                            javaPath() === java.path ? "bg-[var(--color-primary-bg)] text-[var(--color-primary)]" : ""
                          }`}
                          onClick={() => {
                            setJavaPath(java.path);
                            checkJavaCompatibility(java.path);
                            setJavaDropdownOpen(false);
                          }}
                        >
                          <i class={`w-4 h-4 ${java.is_active ? "i-hugeicons-star text-yellow-400" : "i-hugeicons-browser"}`} />
                          <div class="flex-1 min-w-0">
                            <div class="font-medium truncate">
                              {java.vendor || "Java"} - {java.path.split(/[/\\]/).pop()}
                            </div>
                            <div class="text-xs text-gray-500 truncate">{java.path}</div>
                          </div>
                          <Show when={java.is_active}>
                            <span class="text-xs text-yellow-400 flex-shrink-0">Активная</span>
                          </Show>
                        </button>
                      )}
                    </For>

                    {/* Нет Java */}
                    <Show when={availableJava().length === 0}>
                      <div class="px-3 py-2 text-sm text-gray-500 text-center">
                        Нет установленных Java для этой версии MC
                      </div>
                    </Show>
                  </div>
                </Dropdown>

                {/* Предупреждение совместимости */}
                <Show when={javaPath() && javaCompatibility()}>
                  {(() => {
                    const compat = javaCompatibility()!;
                    if (compat.status === "Compatible") {
                      return (
                        <div class="flex items-center gap-2 text-green-400 text-sm">
                          <i class="i-hugeicons-checkmark-circle-02 w-4 h-4" />
                          <span>{t().instances.edit.javaCompatible}</span>
                        </div>
                      );
                    } else if (compat.status === "Warning") {
                      return (
                        <div class="bg-amber-500/10 border border-amber-500/30 rounded-xl p-2 flex items-start gap-2">
                          <i class="i-hugeicons-alert-02 text-amber-400 w-4 h-4 flex-shrink-0 mt-0.5" />
                          <p class="text-amber-400 text-xs">{compat.message}</p>
                        </div>
                      );
                    } else if (compat.status === "Incompatible") {
                      return (
                        <div class="bg-red-500/10 border border-red-500/30 rounded-xl p-2 flex items-start gap-2">
                          <i class="i-hugeicons-cancel-circle text-red-400 w-4 h-4 flex-shrink-0 mt-0.5" />
                          <p class="text-red-400 text-xs">{compat.message}</p>
                        </div>
                      );
                    }
                    return null;
                  })()}
                </Show>
              </div>
            )}
          </div>

          {/* Аргументы JVM */}
          <div class="flex flex-col gap-2">
            <label class="block text-sm font-medium inline-flex items-center gap-1">
              {t().instances.edit.javaArgs}
              <span class="text-xs text-gray-400">{t().instances.edit.optional}</span>
            </label>
            <input
              type="text"
              value={javaArgs()}
              onInput={(e) => setJavaArgs(e.currentTarget.value)}
              placeholder={t().instances.edit.fromGlobalSettings}
              class="w-full px-3.5 py-2.5 border border-gray-700 rounded-2xl text-white transition-colors duration-150 hover:border-gray-600 focus:outline-none focus:border-[var(--color-primary)]"
            />
            <p class="text-xs text-gray-400">
              {t().instances.edit.javaArgsHint}
            </p>
          </div>

          {/* Игровые аргументы */}
          <Show when={instanceType() === "client"}>
            <div>
              <label class="block text-sm font-medium mb-2 inline-flex items-center gap-1">
                {t().instances.edit.gameArgs}
                <span class="text-xs text-gray-400">{t().instances.edit.optional}</span>
              </label>
              <input
                type="text"
                value={gameArgs()}
                onInput={(e) => setGameArgs(e.currentTarget.value)}
                placeholder={t().instances.edit.gameArgsPlaceholder}
                class="w-full px-3.5 py-2.5 border border-gray-700 rounded-2xl text-white transition-colors duration-150 hover:border-gray-600 focus:outline-none focus:border-[var(--color-primary)]"
              />
            </div>
          </Show>

          {/* Заметки */}
          <div>
            <label class="block text-sm font-medium mb-2 inline-flex items-center gap-1">
              {t().instances.edit.notes}
              <span class="text-xs text-gray-400">{t().instances.edit.optional}</span>
            </label>
            <textarea
              value={notes()}
              onInput={(e) => setNotes(e.currentTarget.value)}
              placeholder={t().instances.edit.notesPlaceholder}
              rows="3"
              class="w-full px-3.5 py-2.5 border border-gray-700 rounded-2xl text-white transition-colors duration-150 hover:border-gray-600 focus:outline-none focus:border-[var(--color-primary)] resize-none"
            />
          </div>

          {/* Кнопки */}
          <div class="flex items-center justify-end gap-3 pt-4 border-t border-gray-800">
            <button
              type="button"
              class="px-4 py-2.5 font-medium rounded-2xl inline-flex items-center justify-center gap-2 bg-gray-700 text-gray-100 hover:bg-gray-600 transition-colors"
              onClick={props.onClose}
              disabled={loading()}
            >
              {t().common.cancel}
            </button>
            <button
              type="submit"
              class="btn-primary px-4 py-2.5"
              disabled={loading()}
            >
              {loading() ? (
                <>
                  <i class="i-svg-spinners-6-dots-scale w-4 h-4 text-white" />
                  {t().instances.edit.saving}
                </>
              ) : (
                <>
                  <div class="i-hugeicons-checkmark-circle-02 w-4 h-4" />
                  {t().common.save}
                </>
              )}
            </button>
          </div>
        </form>
      </div>

      {/* Confirm Dialog */}
      <ConfirmDialogComponent />
    </ModalWrapper>
  );
}

export default EditInstanceDialog;
