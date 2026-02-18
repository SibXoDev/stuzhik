import { Show, For } from "solid-js";
import type { Accessor, Setter } from "solid-js";
import type { Settings, GpuDetectionResult, GpuDevice, SystemJavaInfo, JavaInstallationInfo } from "../../../shared/types";
import { Toggle, Select, RangeSlider } from "../../../shared/ui";

interface JavaManagement {
  loadInstalledJavaVersions: () => void;
  installedJavaVersions: Accessor<number[]>;
  javaByVersion: Accessor<Record<number, JavaInstallationInfo[]>>;
  loadingJavaVersions: Accessor<boolean>;
  javaError: Accessor<string | null>;
  installingJava: Accessor<number | null>;
  systemJavaList: Accessor<SystemJavaInfo[]>;
  scanningJava: Accessor<boolean>;
  customJavaPath: Accessor<string>;
  setCustomJavaPath: Setter<string>;
  addingJava: Accessor<boolean>;
  handleScanSystemJava: () => void;
  handleAddSystemJava: (path: string) => void;
  handleAddCustomJava: () => void;
  handleBrowseJava: () => void;
  handleInstallJava: (version: number) => void;
  handleSetActiveJava: (majorVersion: number, javaPath: string) => void;
}

interface GpuManagement {
  gpuDetection: Accessor<GpuDetectionResult | null>;
  loadingGpu: Accessor<boolean>;
  loadGpuDevices: () => void;
  getGpuTypeLabel: (device: GpuDevice) => string;
}

interface Props {
  settings: Accessor<Settings>;
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  totalMemory: Accessor<number>;
  java: JavaManagement;
  gpu: GpuManagement;
  t: Accessor<Record<string, any>>;
}

// Pure helper functions for memory sliders
const getMemoryStep = (maxMemory: number): number => {
  return maxMemory <= 8192 ? 512 : 1024;
};

const generateMemoryMarkers = (maxMemory: number): number[] => {
  const markers: number[] = [];
  const step = maxMemory <= 8192 ? 512 : 1024;
  for (let i = step; i <= maxMemory; i += step) {
    markers.push(i);
  }
  if (markers.length > 0 && markers[markers.length - 1] !== maxMemory) {
    markers.push(maxMemory);
  }
  return markers;
};

const generateLabelTicks = (allTicks: number[]): number[] => {
  if (allTicks.length <= 8) return allTicks;
  const result: number[] = [allTicks[0]];
  for (const tick of allTicks) {
    if (tick % 2048 === 0 && tick !== allTicks[0] && tick !== allTicks[allTicks.length - 1]) {
      result.push(tick);
    }
  }
  result.push(allTicks[allTicks.length - 1]);
  return result;
};

const formatMemoryLabel = (mb: number): string => {
  const gb = mb / 1024;
  return gb % 1 === 0 ? `${gb.toFixed(0)} GB` : `${gb.toFixed(1)} GB`;
};

const javaVersionDescriptions: Record<number, string> = {
  8: "MC 1.0 - 1.16.5",
  17: "MC 1.17 - 1.20.4",
  21: "MC 1.20.5+"
};

export default function SettingsGame(props: Props) {
  const t = () => props.t();

  return (
    <>
      {/* Память */}
      <fieldset data-section="memory">
        <legend class="text-base font-medium mb-4 inline-flex items-center gap-2">
          <i class="i-hugeicons-cpu w-5 h-5" />
          {t().settings.memory.title}
        </legend>
        <div class="space-y-6">
          <div class="flex flex-col gap-3">
            <label class="flex items-baseline gap-2 text-sm font-medium">
              <span>{t().settings.memory.minMemory}: {props.settings().default_memory_min} МБ</span>
              <span class="text-muted">({(props.settings().default_memory_min / 1024).toFixed(1)} ГБ)</span>
            </label>
            <RangeSlider
              value={props.settings().default_memory_min}
              onChange={(val) => {
                props.updateSetting("default_memory_min", val);
                if (val > props.settings().default_memory_max) {
                  props.updateSetting("default_memory_max", val);
                }
              }}
              min={getMemoryStep(Math.min(props.settings().default_memory_max, props.totalMemory()))}
              max={Math.min(props.settings().default_memory_max, props.totalMemory())}
              step={getMemoryStep(Math.min(props.settings().default_memory_max, props.totalMemory()))}
              showTicks
              showLabels
              ticks={generateMemoryMarkers(Math.min(props.settings().default_memory_max, props.totalMemory()))}
              labelTicks={generateLabelTicks(generateMemoryMarkers(Math.min(props.settings().default_memory_max, props.totalMemory())))}
              formatLabel={formatMemoryLabel}
            />
          </div>
          <div class="flex flex-col gap-3">
            <label class="flex items-baseline gap-2 text-sm font-medium">
              <span>{t().settings.memory.maxMemory}: {props.settings().default_memory_max} МБ</span>
              <span class="text-muted">({(props.settings().default_memory_max / 1024).toFixed(1)} ГБ)</span>
            </label>
            <RangeSlider
              value={props.settings().default_memory_max}
              onChange={(val) => {
                props.updateSetting("default_memory_max", val);
                if (val < props.settings().default_memory_min) {
                  props.updateSetting("default_memory_min", val);
                }
              }}
              min={getMemoryStep(props.totalMemory())}
              max={props.totalMemory()}
              step={getMemoryStep(props.totalMemory())}
              showTicks
              showLabels
              ticks={generateMemoryMarkers(props.totalMemory())}
              labelTicks={generateLabelTicks(generateMemoryMarkers(props.totalMemory()))}
              formatLabel={formatMemoryLabel}
            />
          </div>
        </div>
      </fieldset>

      {/* Java & Запуск */}
      <fieldset data-section="java">
        <legend class="text-base font-medium mb-4 inline-flex items-center gap-2">
          <i class="i-hugeicons-source-code w-5 h-5" />
          {t().settings.java.title}
        </legend>
        <div class="space-y-4">
          <div class="flex flex-col gap-2">
            <label class="text-sm font-medium">
              {t().settings.java.defaultJvmArgs}
            </label>
            <textarea
              value={props.settings().default_java_args || ""}
              onInput={(e) => props.updateSetting("default_java_args", e.currentTarget.value || null)}
              placeholder="-XX:+UseG1GC -XX:+UnlockExperimentalVMOptions..."
              rows="3"
              class="input w-full"
            />
            <p class="text-xs text-muted">
              {t().settings.java.jvmArgsHint}
            </p>
          </div>
          <div class="flex flex-col gap-2">
            <label class="text-sm font-medium">
              {t().settings.java.defaultGameArgs}
            </label>
            <textarea
              value={props.settings().default_game_args || ""}
              onInput={(e) => props.updateSetting("default_game_args", e.currentTarget.value || null)}
              placeholder="--fullscreen"
              rows="2"
              class="input w-full"
            />
          </div>
          <div class="flex items-center justify-between">
            <span class="text-sm">{t().settings.java.autoInstall}</span>
            <Toggle
              checked={props.settings().java_auto_install}
              onChange={(checked) => props.updateSetting("java_auto_install", checked)}
            />
          </div>

          {/* Java Management */}
          <div class="flex flex-col gap-3 border-t border-gray-700 pt-4">
            <div class="flex items-center justify-between">
              <p class="text-sm font-medium">{t().settings.java.management.title}</p>
              <button
                class="btn-secondary text-xs py-1 px-2"
                onClick={props.java.loadInstalledJavaVersions}
                disabled={props.java.loadingJavaVersions()}
              >
                <Show when={props.java.loadingJavaVersions()} fallback={
                  <><i class="i-hugeicons-refresh w-3 h-3" /></>
                }>
                  <i class="i-svg-spinners-6-dots-scale w-3 h-3" />
                </Show>
              </button>
            </div>

            {/* Ошибка */}
            <Show when={props.java.javaError()}>
              <div class="bg-red-500/10 border border-red-500/20 rounded-2xl p-3 text-sm text-red-400">
                {props.java.javaError()}
              </div>
            </Show>

            <div class="space-y-3">
              {/* Java версии с выбором активной */}
              <For each={[8, 17, 21] as const}>
                {(version) => {
                  const isInstalled = () => props.java.installedJavaVersions().includes(version);
                  const javasForVersion = () => props.java.javaByVersion()[version] || [];
                  const hasMultiple = () => javasForVersion().length > 1;
                  const activeJava = () => javasForVersion().find(j => j.is_active) || javasForVersion()[0];

                  return (
                    <div class={`flex flex-col gap-2 p-3 rounded-2xl border ${isInstalled() ? 'bg-green-600/5 border-green-600/20' : 'bg-gray-800/50 border-gray-700/50'}`}>
                      <div class="flex items-center justify-between">
                        <div class="flex items-center gap-2">
                          <i class={`i-hugeicons-coffee-01 w-4 h-4 ${isInstalled() ? 'text-green-400' : 'text-gray-500'}`} />
                          <span class="font-medium">Java {version}</span>
                          <span class="text-xs text-muted">({javaVersionDescriptions[version]})</span>
                        </div>
                        <Show when={isInstalled()} fallback={
                          <button
                            class="btn-primary text-xs py-1 px-2"
                            onClick={() => props.java.handleInstallJava(version)}
                            disabled={props.java.installingJava() !== null}
                          >
                            <Show when={props.java.installingJava() === version} fallback={
                              <><i class="i-hugeicons-download-02 w-3 h-3" />{t().settings.java.management.download}</>
                            }>
                              <i class="i-svg-spinners-6-dots-scale w-3 h-3" />
                            </Show>
                          </button>
                        }>
                          <span class="text-xs text-green-400 flex items-center gap-1">
                            <i class="i-hugeicons-checkmark-circle-02 w-3 h-3" />
                            {t().settings.java.management.installed}
                          </span>
                        </Show>
                      </div>

                      {/* Выбор активной Java если несколько */}
                      <Show when={isInstalled()}>
                        <Show when={hasMultiple()} fallback={
                          <p class="text-xs text-muted truncate" title={activeJava()?.path}>
                            {activeJava()?.vendor && <span class="text-blue-400">[{activeJava()?.vendor}] </span>}
                            {activeJava()?.path}
                          </p>
                        }>
                          <div>
                            <Select
                              value={activeJava()?.path || ""}
                              onChange={(val) => props.java.handleSetActiveJava(version, val)}
                              options={javasForVersion().map(java => ({
                                value: java.path,
                                label: `${java.vendor ? `[${java.vendor}] ` : ""}${java.path}${java.is_auto_installed ? " (Adoptium)" : ""}`
                              }))}
                            />
                          </div>
                        </Show>
                      </Show>
                    </div>
                  );
                }}
              </For>

              {/* Поиск системных Java */}
              <div class="flex flex-col gap-3 border-t border-gray-700 pt-3">
                <button
                  class="btn-secondary w-full"
                  onClick={props.java.handleScanSystemJava}
                  disabled={props.java.scanningJava()}
                >
                  <Show when={props.java.scanningJava()} fallback={
                    <>
                      <i class="i-hugeicons-search-01 w-4 h-4" />
                      {t().settings.java.management.scan}
                    </>
                  }>
                    <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                    {t().settings.java.management.scanning}
                  </Show>
                </button>

                {/* Найденные системные Java */}
                <Show when={props.java.systemJavaList().length > 0}>
                  <div class="space-y-2">
                    <p class="text-xs text-muted">{t().settings.java.management.found}: {props.java.systemJavaList().length}</p>
                    <For each={props.java.systemJavaList()}>
                      {(java) => (
                        <div class="flex items-center justify-between gap-2 text-sm p-2 rounded-2xl bg-gray-800/50 border border-gray-700/50">
                          <div class="flex-1 min-w-0">
                            <div class="flex items-center gap-2">
                              <span class="font-medium">Java {java.major_version}</span>
                              <span class="text-xs text-muted">({java.version})</span>
                              <Show when={java.vendor}>
                                <span class="text-xs px-1.5 py-0.5 bg-blue-600/20 text-blue-400 rounded-full">{java.vendor}</span>
                              </Show>
                            </div>
                            <p class="text-xs text-muted truncate mt-0.5" title={java.path}>{java.path}</p>
                          </div>
                          <Show when={!java.is_already_added} fallback={
                            <span class="text-xs text-green-400 flex items-center gap-1">
                              <i class="i-hugeicons-checkmark-circle-02 w-3 h-3" />
                              {t().settings.java.management.added}
                            </span>
                          }>
                            <button
                              class="btn-primary text-xs py-1 px-2"
                              onClick={() => props.java.handleAddSystemJava(java.path)}
                              disabled={props.java.addingJava()}
                            >
                              <Show when={props.java.addingJava()} fallback={
                                <>{t().settings.java.management.add}</>
                              }>
                                <i class="i-svg-spinners-6-dots-scale w-3 h-3" />
                              </Show>
                            </button>
                          </Show>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </div>

              {/* Ручной ввод пути */}
              <div class="flex flex-col gap-2 border-t border-gray-700 pt-3">
                <p class="text-xs text-muted">{t().settings.java.management.customPath}</p>
                <div class="flex gap-2">
                  <input
                    type="text"
                    class="input flex-1"
                    placeholder={navigator.platform.toLowerCase().includes("win") ? "C:\\Program Files\\Java\\jdk-21\\bin\\java.exe" : "/usr/lib/jvm/java-21/bin/java"}
                    value={props.java.customJavaPath()}
                    onInput={(e) => props.java.setCustomJavaPath(e.currentTarget.value)}
                  />
                  <button class="btn-secondary" onClick={props.java.handleBrowseJava}>
                    <i class="i-hugeicons-folder-01 w-4 h-4" />
                  </button>
                  <button
                    class="btn-primary"
                    onClick={props.java.handleAddCustomJava}
                    disabled={!props.java.customJavaPath().trim() || props.java.addingJava()}
                  >
                    <Show when={props.java.addingJava()} fallback={
                      <>{t().settings.java.management.add}</>
                    }>
                      <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                    </Show>
                  </button>
                </div>
              </div>

              <p class="text-xs text-muted">{t().settings.java.management.downloadHint}</p>
            </div>
          </div>
        </div>
      </fieldset>

      {/* GPU Selection */}
      <fieldset>
        <legend class="text-base font-medium mb-4 inline-flex items-center gap-2">
          <i class="i-hugeicons-cpu w-5 h-5" />
          {t().settings.gpu.title}
        </legend>
        <div class="space-y-4">
          {/* Кнопка обнаружения GPU */}
          <Show when={!props.gpu.gpuDetection()}>
            <button
              class="btn-secondary w-full"
              onClick={props.gpu.loadGpuDevices}
              disabled={props.gpu.loadingGpu()}
            >
              <Show when={props.gpu.loadingGpu()} fallback={
                <>
                  <i class="i-hugeicons-search-01 w-4 h-4" />
                  {t().settings.gpu.select}
                </>
              }>
                <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                {t().settings.gpu.detecting}
              </Show>
            </button>
          </Show>

          {/* Список GPU */}
          <Show when={props.gpu.gpuDetection()}>
            <div class="space-y-3">
              {/* Подсказка если несколько GPU */}
              <Show when={props.gpu.gpuDetection()!.has_multiple_gpus}>
                <div class="p-3 bg-blue-600/10 border border-blue-600/30 rounded-2xl">
                  <div class="flex items-start gap-2">
                    <i class="i-hugeicons-information-circle w-4 h-4 text-blue-400 mt-0.5" />
                    <div>
                      <p class="text-sm font-medium text-blue-400">{t().settings.gpu.multipleGpus}</p>
                      <p class="text-xs text-muted mt-1">{t().settings.gpu.multipleGpusHint}</p>
                    </div>
                  </div>
                </div>
              </Show>

              {/* Автоматический выбор */}
              <button
                type="button"
                class={`group overflow-hidden rounded-2xl border-2 transition-colors duration-75 p-4 w-full ${
                  !props.settings().selected_gpu
                    ? "border-[var(--color-primary)] bg-[var(--color-primary-bg)]"
                    : "border-gray-700 hover:border-gray-500 hover:bg-gray-alpha-50"
                }`}
                onClick={() => props.updateSetting("selected_gpu", null)}
              >
                <div class="flex items-center gap-3">
                  <i class="i-hugeicons-ai-magic w-6 h-6 text-blue-400" />
                  <div class="text-left flex-1">
                    <div class="font-medium text-sm">{t().settings.gpu.auto}</div>
                    <div class="text-xs text-muted">{t().settings.gpu.autoHint}</div>
                  </div>
                  <Show when={!props.settings().selected_gpu}>
                    <div class="w-5 h-5 bg-[var(--color-primary)] rounded-full flex items-center justify-center flex-shrink-0">
                      <i class="i-hugeicons-checkmark-circle-02 w-3 h-3 text-white" />
                    </div>
                  </Show>
                </div>
              </button>

              {/* Список устройств */}
              <For each={props.gpu.gpuDetection()!.devices}>
                {(device) => (
                  <button
                    type="button"
                    class={`group overflow-hidden rounded-2xl border-2 transition-colors duration-75 p-4 w-full ${
                      props.settings().selected_gpu === device.id
                        ? "border-[var(--color-primary)] bg-[var(--color-primary-bg)]"
                        : "border-gray-700 hover:border-gray-500 hover:bg-gray-alpha-50"
                    }`}
                    onClick={() => props.updateSetting("selected_gpu", device.id)}
                  >
                    <div class="flex items-center gap-3">
                      <i class={`w-6 h-6 ${
                        device.gpu_type === "discrete"
                          ? "i-hugeicons-package text-green-400"
                          : device.gpu_type === "integrated"
                            ? "i-hugeicons-laptop text-yellow-400"
                            : "i-hugeicons-help-circle text-gray-400"
                      }`} />
                      <div class="text-left flex-1">
                        <div class="font-medium text-sm">{device.name}</div>
                        <div class="flex items-center gap-2 text-xs text-muted">
                          <span>{device.vendor}</span>
                          <span>•</span>
                          <span>{props.gpu.getGpuTypeLabel(device)}</span>
                          <Show when={device.recommended}>
                            <span class="px-1.5 py-0.5 bg-green-600/20 text-green-400 rounded text-xs">
                              {t().settings.gpu.recommended}
                            </span>
                          </Show>
                        </div>
                      </div>
                      <Show when={props.settings().selected_gpu === device.id}>
                        <div class="w-5 h-5 bg-[var(--color-primary)] rounded-full flex items-center justify-center flex-shrink-0">
                          <i class="i-hugeicons-checkmark-circle-02 w-3 h-3 text-white" />
                        </div>
                      </Show>
                    </div>
                  </button>
                )}
              </For>

              {/* Кнопка обновления */}
              <button
                class="btn-ghost text-xs w-full"
                onClick={props.gpu.loadGpuDevices}
                disabled={props.gpu.loadingGpu()}
              >
                <i class="i-hugeicons-refresh w-3 h-3" />
                {t().settings.storage.refresh}
              </button>
            </div>
          </Show>
        </div>
      </fieldset>

      {/* Поведение при запуске игры */}
      <fieldset>
        <legend class="text-base font-medium mb-4 inline-flex items-center gap-2">
          <i class="i-hugeicons-play w-5 h-5" />
          {t().settings.launchBehavior.title}
        </legend>
        <div class="space-y-4">
          <p class="text-sm text-muted">{t().settings.launchBehavior.description}</p>
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {/* Свернуть в трей */}
            <button
              type="button"
              class={`group overflow-hidden rounded-2xl border-2 transition-colors duration-75 p-4 ${
                props.settings().launch_behavior === "minimize_to_tray"
                  ? "border-[var(--color-primary)] bg-[var(--color-primary-bg)]"
                  : "border-gray-700 hover:border-gray-500 hover:bg-gray-alpha-50"
              }`}
              onClick={() => props.updateSetting("launch_behavior", "minimize_to_tray")}
            >
              <div class="flex items-center gap-3">
                <i class="i-hugeicons-minimize-01 w-6 h-6 text-blue-400" />
                <div class="text-left flex-1">
                  <div class="font-medium text-sm">{t().settings.launchBehavior.minimizeToTray}</div>
                  <div class="text-xs text-muted">{t().settings.launchBehavior.minimizeToTrayHint}</div>
                </div>
                <Show when={props.settings().launch_behavior === "minimize_to_tray"}>
                  <div class="w-5 h-5 bg-[var(--color-primary)] rounded-full flex items-center justify-center flex-shrink-0">
                    <i class="i-hugeicons-checkmark-circle-02 w-3 h-3 text-white" />
                  </div>
                </Show>
              </div>
            </button>

            {/* Оставить открытым */}
            <button
              type="button"
              class={`group overflow-hidden rounded-2xl border-2 transition-colors duration-75 p-4 ${
                props.settings().launch_behavior === "keep_open"
                  ? "border-[var(--color-primary)] bg-[var(--color-primary-bg)]"
                  : "border-gray-700 hover:border-gray-500 hover:bg-gray-alpha-50"
              }`}
              onClick={() => props.updateSetting("launch_behavior", "keep_open")}
            >
              <div class="flex items-center gap-3">
                <i class="i-hugeicons-browser w-6 h-6 text-green-400" />
                <div class="text-left flex-1">
                  <div class="font-medium text-sm">{t().settings.launchBehavior.keepOpen}</div>
                  <div class="text-xs text-muted">{t().settings.launchBehavior.keepOpenHint}</div>
                </div>
                <Show when={props.settings().launch_behavior === "keep_open"}>
                  <div class="w-5 h-5 bg-[var(--color-primary)] rounded-full flex items-center justify-center flex-shrink-0">
                    <i class="i-hugeicons-checkmark-circle-02 w-3 h-3 text-white" />
                  </div>
                </Show>
              </div>
            </button>

            {/* Закрыть */}
            <button
              type="button"
              class={`group overflow-hidden rounded-2xl border-2 transition-colors duration-75 p-4 ${
                props.settings().launch_behavior === "close"
                  ? "border-[var(--color-primary)] bg-[var(--color-primary-bg)]"
                  : "border-gray-700 hover:border-gray-500 hover:bg-gray-alpha-50"
              }`}
              onClick={() => props.updateSetting("launch_behavior", "close")}
            >
              <div class="flex items-center gap-3">
                <i class="i-hugeicons-cancel-01 w-6 h-6 text-red-400" />
                <div class="text-left flex-1">
                  <div class="font-medium text-sm">{t().settings.launchBehavior.close}</div>
                  <div class="text-xs text-muted">{t().settings.launchBehavior.closeHint}</div>
                </div>
                <Show when={props.settings().launch_behavior === "close"}>
                  <div class="w-5 h-5 bg-[var(--color-primary)] rounded-full flex items-center justify-center flex-shrink-0">
                    <i class="i-hugeicons-checkmark-circle-02 w-3 h-3 text-white" />
                  </div>
                </Show>
              </div>
            </button>
          </div>
        </div>
      </fieldset>
    </>
  );
}
