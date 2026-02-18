import { createSignal, createEffect, createMemo, Show, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { Instance, CreateInstanceRequest, LoaderType, InstanceType } from "../../../shared/types";
import { useI18n } from "../../../shared/i18n";
import { currentGame } from "../../../shared/stores/gameContext";
import VersionSelector from "../../../shared/components/VersionSelector";
import LoaderVersionSelector from "../../../shared/components/LoaderVersionSelector";
import LoaderSelector from "../../../shared/components/LoaderSelector";
import { RangeSlider } from "../../../shared/ui";

/**
 * Get memory step based on total memory
 */
function getMemoryStep(maxMemory: number): number {
  return maxMemory <= 8192 ? 512 : 1024;
}

/**
 * Generate memory markers for RangeSlider based on total memory
 * @param maxMemory - Maximum available memory in MB
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

export interface CreateInstanceFormProps {
  onCreate: (request: CreateInstanceRequest) => Promise<Instance | null>;
  onCreated?: (instanceId: string, instanceName: string) => void;
  onCancel?: () => void;
}

function CreateInstanceForm(props: CreateInstanceFormProps) {
  const { t } = useI18n();
  const [totalMemory, setTotalMemory] = createSignal(8192);
  const [name, setName] = createSignal("");
  const [version, setVersion] = createSignal("");
  const [loader, setLoader] = createSignal("neoforge" as LoaderType);
  const [loaderVersion, setLoaderVersion] = createSignal("");
  const [instanceType, setInstanceType] = createSignal("client" as InstanceType);

  const [port, setPort] = createSignal(25565);
  const [memoryMin, setMemoryMin] = createSignal(512);
  const [memoryMax, setMemoryMax] = createSignal(2048);
  const [javaArgs, setJavaArgs] = createSignal("");
  const [gameArgs, setGameArgs] = createSignal("");
  const [username, setUsername] = createSignal("");
  const [notes, setNotes] = createSignal("");

  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [step, setStep] = createSignal(1);

  // Load total memory on mount
  onMount(async () => {
    try {
      const memory = await invoke<number>("get_total_memory");
      setTotalMemory(memory);
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to get total memory:", e);
    }
  });

  // Memoized preload key to prevent duplicate API calls
  const preloadKey = createMemo(() => {
    const mcVersion = version();
    const currentLoader = loader();

    if (!mcVersion || !currentLoader || currentLoader === "vanilla") {
      return null;
    }

    return `${mcVersion}:${currentLoader}`;
  });

  // Предзагрузка версий загрузчика только при изменении ключа
  createEffect(() => {
    const key = preloadKey();

    if (key) {
      const [mcVersion, currentLoader] = key.split(":");

      // Предзагружаем версии в фоне (для кэша)
      invoke<string[]>("get_loader_versions", {
        minecraftVersion: mcVersion,
        loader: currentLoader,
      }).catch((e) => {
        if (import.meta.env.DEV) console.debug("Pre-loading loader versions failed (non-critical):", e);
      });
    }
  });

  const handleSubmit = async (e: SubmitEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const request: CreateInstanceRequest = {
        name: name().trim() || t().instances.newInstance,
        game_type: currentGame(),
        version: version(),
        loader: loader(),
        loader_version: loaderVersion() || undefined,
        instance_type: instanceType(),
        memory_min: instanceType() === "server" ? memoryMin() : undefined,
        memory_max: memoryMax(),
        java_args: javaArgs() || undefined,
        game_args: gameArgs() || undefined,
        port: instanceType() === "server" ? port() : undefined,
        username: username() || undefined,
        notes: notes() || undefined,
      };

      const instance = await props.onCreate(request);
      if (instance) {
        props.onCreated?.(instance.id, instance.name);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      if (import.meta.env.DEV) console.error("Failed to create instance:", e);
    } finally {
      setLoading(false);
    }
  };

  const canProceed = () => {
    if (step() === 1) {
      return version().trim().length > 0; // name uses default if empty
    }
    return true;
  };

  return (
    <form onSubmit={handleSubmit} class="flex flex-col gap-6">
      {/* Progress Steps */}
      <div class="flex items-center justify-center gap-2">
        <div class={`flex items-center gap-2 ${step() >= 1 ? "text-[var(--color-primary)]" : "text-gray-500"}`}>
          <div class={`w-8 h-8 rounded-full flex items-center justify-center font-medium ${step() >= 1 ? "bg-[var(--color-primary)]" : "bg-gray-700"}`}>
            1
          </div>
          <span class="text-sm font-medium">{t().instances.stepBasic}</span>
        </div>
        <div class="w-12 h-0.5 bg-gray-700" />
        <div class={`flex items-center gap-2 ${step() >= 2 ? "text-[var(--color-primary)]" : "text-gray-500"}`}>
          <div class={`w-8 h-8 rounded-full flex items-center justify-center font-medium ${step() >= 2 ? "bg-[var(--color-primary)]" : "bg-gray-700"}`}>
            2
          </div>
          <span class="text-sm font-medium">{t().instances.stepSettings}</span>
        </div>
        <div class="w-12 h-0.5 bg-gray-700" />
        <div class={`flex items-center gap-2 ${step() >= 3 ? "text-[var(--color-primary)]" : "text-gray-500"}`}>
          <div class={`w-8 h-8 rounded-full flex items-center justify-center font-medium ${step() >= 3 ? "bg-[var(--color-primary)]" : "bg-gray-700"}`}>
            3
          </div>
          <span class="text-sm font-medium">{t().instances.stepConfirm}</span>
        </div>
      </div>

      {/* Error Alert */}
      <Show when={error()}>
        <div class="bg-red-500/10 border border-red-500/30 rounded-2xl p-4">
          <div class="flex items-start gap-3">
            <div class="i-hugeicons-alert-02 text-red-400 w-5 h-5 flex-shrink-0" />
            <div class="flex-1">
              <p class="text-red-400 text-sm">{error()}</p>
            </div>
            <button
              type="button"
              class="text-red-400 hover:text-red-300"
              onClick={() => setError(null)}
            >
              <div class="i-hugeicons-cancel-01 w-5 h-5" />
            </button>
          </div>
        </div>
      </Show>

      {/* Step 1: Basic Info */}
      <Show when={step() === 1}>
        <div class="space-y-4">
          <div class="flex flex-col gap-2">
            <label class="block text-sm font-medium">
              {t().instances.name} <span class="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              placeholder={t().instances.namePlaceholder}
              required
              disabled={loading()}
            />
          </div>

          <div class="grid grid-cols-2 gap-4">
            <div class="flex flex-col gap-2">
              <label class="block text-sm font-medium">
                {t().instances.minecraftVersion} <span class="text-red-500">*</span>
              </label>
              <VersionSelector
                value={version()}
                onChange={setVersion}
                disabled={loading()}
                loader={loader()}
              />
            </div>

            <div class="flex flex-col gap-2">
              <label class="block text-sm font-medium">{t().instances.type}</label>
              <div class="flex rounded-2xl overflow-hidden border border-gray-700">
                <button
                  type="button"
                  class={`flex-1 px-4 py-2.5 flex items-center justify-center gap-2 transition-colors ${
                    instanceType() === "client"
                      ? "bg-[var(--color-primary)] text-white"
                      : "bg-gray-850 text-gray-400 hover:bg-gray-700/50"
                  }`}
                  onClick={() => setInstanceType("client")}
                >
                  <i class="i-hugeicons-user w-4 h-4" />
                  {t().instances.typeClient}
                </button>
                <button
                  type="button"
                  class={`flex-1 px-4 py-2.5 flex items-center justify-center gap-2 transition-colors ${
                    instanceType() === "server"
                      ? "bg-[var(--color-primary)] text-white"
                      : "bg-gray-850 text-gray-400 hover:bg-gray-700/50"
                  }`}
                  onClick={() => setInstanceType("server")}
                >
                  <i class="i-hugeicons-hard-drive w-4 h-4" />
                  {t().instances.typeServer}
                </button>
              </div>
            </div>
          </div>

          <div class="grid grid-cols-2 gap-4">
            <div class="flex flex-col gap-2">
              <label class="block text-sm font-medium">{t().instances.loader}</label>
              <LoaderSelector
                value={loader()}
                onChange={setLoader}
                disabled={loading()}
              />
            </div>

            <div class="flex flex-col gap-2">
              <label class="block text-sm font-medium inline-flex items-center gap-1">
                {t().instances.edit.loaderVersion}
                <span class="text-xs text-gray-400">{t().instances.edit.optional}</span>
              </label>
              <LoaderVersionSelector
                value={loaderVersion()}
                onChange={setLoaderVersion}
                disabled={loading()}
                loader={loader()}
                minecraftVersion={version()}
              />
            </div>
          </div>

          <Show when={instanceType() === "server"}>
            <div class="flex flex-col gap-2">
              <label class="block text-sm font-medium">{t().instances.edit.serverPort}</label>
              <input
                type="number"
                value={port()}
                onInput={(e) => setPort(Number(e.currentTarget.value))}
                min="1024"
                max="65535"
              />
            </div>
          </Show>

          <Show when={instanceType() === "client"}>
            <div class="flex flex-col gap-2">
              <label class="block text-sm font-medium">
                {t().instances.edit.username}
                <span class="text-xs text-gray-400">{t().instances.optionalFromSettings}</span>
              </label>
              <input
                type="text"
                value={username()}
                onInput={(e) => setUsername(e.currentTarget.value)}
                placeholder={t().instances.edit.fromGlobalSettings}
              />
            </div>
          </Show>
        </div>
      </Show>

      {/* Step 2: Advanced Settings */}
      <Show when={step() === 2}>
        <div class="space-y-4">
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
                      min={512}
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
                      min={Math.max(512, memoryMin())}
                      max={totalMemory()}
                      step={getMemoryStep(totalMemory())}
                      showTicks
                      showLabels
                      ticks={generateMemoryMarkers(totalMemory())}
                      labelTicks={generateLabelTicks(generateMemoryMarkers(totalMemory()))}
                      formatLabel={formatMemoryLabel}
                    />
                  </div>

                  <div class="bg-blue-500/10 border border-blue-500/30 rounded-2xl p-3 text-xs">
                    <div class="flex items-start gap-2">
                      <div class="i-hugeicons-information-circle text-blue-400 w-4 h-4 flex-shrink-0 mt-0.5" />
                      <div class="text-blue-300">
                        {t().instances.serverMemoryHint}
                      </div>
                    </div>
                  </div>
                </>
              </Show>
            </div>
          </fieldset>

          <div class="flex flex-col gap-2">
            <label class="block text-sm font-medium inline-flex items-center gap-1">
              {t().instances.edit.javaArgs}
              <span class="text-xs text-gray-400">{t().instances.optionalFromSettings}</span>
            </label>
            <input
              type="text"
              value={javaArgs()}
              onInput={(e) => setJavaArgs(e.currentTarget.value)}
              placeholder={t().instances.edit.fromGlobalSettings}
            />
            <p class="text-xs text-gray-400">
              {t().instances.edit.javaArgsHint}
            </p>
          </div>

          <Show when={instanceType() === "client"}>
            <div class="flex flex-col gap-2">
              <label class="block text-sm font-medium">
                {t().instances.edit.gameArgs}
                <span class="text-xs text-gray-400">{t().instances.edit.optional}</span>
              </label>
              <input
                type="text"
                value={gameArgs()}
                onInput={(e) => setGameArgs(e.currentTarget.value)}
                placeholder={t().instances.edit.gameArgsPlaceholder}
              />
            </div>
          </Show>

          <div class="flex flex-col gap-2">
            <label class="block text-sm font-medium inline-flex items-center gap-1">
              {t().instances.edit.notes}
              <span class="text-xs text-gray-400">{t().instances.edit.optional}</span>
            </label>
            <textarea
              value={notes()}
              onInput={(e) => setNotes(e.currentTarget.value)}
              placeholder={t().instances.edit.notesPlaceholder}
              rows="3"
            />
          </div>
        </div>
      </Show>

      {/* Step 3: Confirmation */}
      <Show when={step() === 3}>
        <div class="flex flex-col gap-4 bg-gray-700/50 rounded-2xl p-4">
          <h3 class="text-lg font-semibold">{t().instances.confirmTitle}</h3>

          <div class="space-y-3 text-sm">
            <div class="flex justify-between">
              <span class="text-gray-400">{t().instances.name}:</span>
              <span class="font-medium">{name()}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-gray-400">{t().instances.confirmVersion}:</span>
              <span class="font-medium">{version()}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-gray-400">{t().instances.loader}:</span>
              <span class="font-medium capitalize">{loader()}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-gray-400">{t().instances.type}:</span>
              <span class="font-medium capitalize">{instanceType() === "server" ? t().instances.typeServer : t().instances.typeClient}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-gray-400">{t().instances.memory}:</span>
              <span class="font-medium">
                {instanceType() === "server"
                  ? `${memoryMin()} - ${memoryMax()} MB`
                  : `${memoryMax()} MB`}
              </span>
            </div>
            <Show when={instanceType() === "server"}>
              <div class="flex justify-between">
                <span class="text-gray-400">{t().instances.confirmPort}:</span>
                <span class="font-medium">{port()}</span>
              </div>
            </Show>
            <Show when={instanceType() === "client" && username()}>
              <div class="flex justify-between">
                <span class="text-gray-400">{t().instances.confirmPlayer}:</span>
                <span class="font-medium">{username()}</span>
              </div>
            </Show>
          </div>

          <div class="p-3 bg-blue-500/10 border border-blue-500/30 rounded-2xl">
            <p class="text-sm text-blue-400 inline-flex items-start gap-1">
              <span class="i-hugeicons-information-circle w-4 h-4 flex-shrink-0" />
              {t().instances.installInfoMessage}
            </p>
          </div>
        </div>
      </Show>

      {/* Navigation Buttons */}
      <div class="flex items-center justify-between pt-4 border-t border-gray-800">
        <Show
          when={step() > 1}
          fallback={
            <button
              type="button"
              class="btn-ghost"
              onClick={() => props.onCancel?.()}
            >
              {t().common.cancel}
            </button>
          }
        >
          <button
            type="button"
            class="btn-secondary"
            onClick={() => setStep((s) => s - 1)}
            disabled={loading()}
          >
            <i class="i-hugeicons-arrow-left-01 w-4 h-4" />
            {t().instances.prev}
          </button>
        </Show>

        <Show
          when={step() < 3}
          fallback={
            <button
              type="submit"
              class="btn-primary"
              disabled={loading() || !canProceed()}
            >
              {loading() ? (
                <>
                  <i class="i-svg-spinners-6-dots-scale w-4 h-4 text-white" />
                  {t().instances.creating}...
                </>
              ) : (
                <>
                  <i class="i-hugeicons-checkmark-circle-02 w-4 h-4" />
                  {t().instances.createButton}
                </>
              )}
            </button>
          }
        >
          <button
            type="button"
            class="btn-primary"
            onClick={() => setStep((s) => s + 1)}
            disabled={!canProceed()}
          >
            {t().instances.next}
            <i class="i-hugeicons-arrow-right-01 w-4 h-4" />
          </button>
        </Show>
      </div>
    </form>
  );
}

export default CreateInstanceForm;