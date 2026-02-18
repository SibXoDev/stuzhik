import { createSignal, createEffect, Show, For, Accessor, createMemo } from "solid-js";
import { usePerformance } from "../hooks/usePerformance";
import { useI18n } from "../../../shared/i18n";
import { invoke } from "@tauri-apps/api/core";
import { addToast } from "../../../shared/components/Toast";
import { Tabs } from "../../../shared/ui";
import type {
  PerformanceSnapshot,
  ModPerformance,
  PerformanceRecommendation,
  PerformanceAction,
  ImpactCategory,
  BottleneckSeverity,
} from "../../../shared/types/common.types";

// ============================================================================
// Performance Graph Component
// ============================================================================

interface PerformanceGraphProps {
  snapshots: PerformanceSnapshot[];
  formatMemory: (mb: number) => string;
}

function PerformanceGraph(props: PerformanceGraphProps) {
  const { t } = useI18n();
  const [hoveredIndex, setHoveredIndex] = createSignal<number | null>(null);
  const [mousePos, setMousePos] = createSignal({ x: 0, y: 0 });

  const graphData = createMemo(() => {
    const snaps = props.snapshots.slice(-100);
    const width = 800;
    const height = 100;
    const padding = 2;

    if (snaps.length === 0) return { snaps, width, height, padding, maxMem: 0, maxCpu: 100, memPoints: "", cpuPoints: "" };

    const maxMem = Math.max(...snaps.map(s => s.memory_used_mb), 1);
    const maxCpu = 100; // Теперь CPU нормализован до 100%

    const memPoints = snaps.map((s, i) => {
      const x = padding + (i / Math.max(snaps.length - 1, 1)) * (width - padding * 2);
      const y = height - padding - (s.memory_used_mb / maxMem) * (height - padding * 2);
      return `${x},${y}`;
    }).join(" ");

    const cpuPoints = snaps.map((s, i) => {
      const x = padding + (i / Math.max(snaps.length - 1, 1)) * (width - padding * 2);
      const y = height - padding - (s.cpu_percent / maxCpu) * (height - padding * 2);
      return `${x},${y}`;
    }).join(" ");

    return { snaps, width, height, padding, maxMem, maxCpu, memPoints, cpuPoints };
  });

  const handleMouseMove = (e: MouseEvent) => {
    const svg = e.currentTarget as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const relativeX = x / rect.width;
    const data = graphData();
    const index = Math.round(relativeX * (data.snaps.length - 1));

    if (index >= 0 && index < data.snaps.length) {
      setHoveredIndex(index);
      setMousePos({ x: e.clientX, y: e.clientY });
    }
  };

  const handleMouseLeave = () => {
    setHoveredIndex(null);
  };

  const formatTime = (timestamp: string) => {
    try {
      const date = new Date(timestamp);
      return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
      return "";
    }
  };

  const hoveredSnapshot = createMemo(() => {
    const idx = hoveredIndex();
    if (idx === null) return null;
    return graphData().snaps[idx];
  });

  return (
    <div class="bg-gray-750/50 rounded-xl p-4 flex flex-col gap-3">
      <div class="flex items-center justify-between">
        <div class="text-sm text-gray-400">{t().performance?.history || "History"}</div>
        <div class="flex items-center gap-4 text-xs">
          <span class="flex items-center gap-1">
            <span class="w-3 h-0.5 bg-[var(--color-primary)] rounded" />
            RAM
          </span>
          <span class="flex items-center gap-1">
            <span class="w-3 h-0.5 bg-green-500 rounded" />
            CPU
          </span>
        </div>
      </div>

      <div>
        <svg
          viewBox={`0 0 ${graphData().width} ${graphData().height}`}
          class="w-full h-24 cursor-crosshair"
          preserveAspectRatio="none"
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        >
          {/* Grid lines */}
          <line x1="0" y1={graphData().height/2} x2={graphData().width} y2={graphData().height/2} stroke="rgba(255,255,255,0.1)" stroke-width="1" />
          <line x1="0" y1={graphData().height/4} x2={graphData().width} y2={graphData().height/4} stroke="rgba(255,255,255,0.05)" stroke-width="1" />
          <line x1="0" y1={graphData().height*3/4} x2={graphData().width} y2={graphData().height*3/4} stroke="rgba(255,255,255,0.05)" stroke-width="1" />

          {/* Memory line */}
          <polyline
            fill="none"
            stroke="#3b82f6"
            stroke-width="2"
            stroke-linejoin="round"
            stroke-linecap="round"
            points={graphData().memPoints}
          />

          {/* CPU line */}
          <polyline
            fill="none"
            stroke="#22c55e"
            stroke-width="2"
            stroke-linejoin="round"
            stroke-linecap="round"
            points={graphData().cpuPoints}
          />

          {/* Hover line */}
          <Show when={hoveredIndex() !== null}>
            {(() => {
              const idx = hoveredIndex()!;
              const data = graphData();
              const x = data.padding + (idx / Math.max(data.snaps.length - 1, 1)) * (data.width - data.padding * 2);
              return (
                <line
                  x1={x}
                  y1={0}
                  x2={x}
                  y2={data.height}
                  stroke="rgba(255,255,255,0.3)"
                  stroke-width="1"
                  stroke-dasharray="4,4"
                />
              );
            })()}
          </Show>
        </svg>

        {/* Tooltip */}
        <Show when={hoveredSnapshot()}>
          <div
            class="fixed z-50 px-3 py-2 bg-gray-900 border border-gray-700 rounded-2xl shadow-xl text-xs pointer-events-none flex flex-col gap-1"
            style={{
              left: `${Math.min(mousePos().x + 10, window.innerWidth - 180)}px`,
              top: `${mousePos().y - 70}px`,
            }}
          >
            <div class="text-gray-400">{formatTime(hoveredSnapshot()!.timestamp)}</div>
            <div class="flex items-center gap-2">
              <span class="w-2 h-2 rounded-full bg-[var(--color-primary)]" />
              <span class="text-white">RAM: {props.formatMemory(hoveredSnapshot()!.memory_used_mb)}</span>
            </div>
            <div class="flex items-center gap-2">
              <span class="w-2 h-2 rounded-full bg-green-500" />
              <span class="text-white">CPU: {hoveredSnapshot()!.cpu_percent.toFixed(0)}%</span>
            </div>
            <Show when={hoveredSnapshot()!.tps}>
              <div class="text-yellow-400">TPS: {hoveredSnapshot()!.tps!.toFixed(1)}</div>
            </Show>
          </div>
        </Show>
      </div>

      {/* Time axis labels */}
      <div class="flex justify-between text-xs text-gray-500">
        <span>{graphData().snaps.length > 0 ? formatTime(graphData().snaps[0].timestamp) : ""}</span>
        <span>{t().performance?.maxRam || "Max RAM"}: {props.formatMemory(graphData().maxMem)}</span>
        <span>{t().performance?.maxCpu || "Max CPU"}: {Math.max(...graphData().snaps.map(s => s.cpu_percent), 0).toFixed(0)}%</span>
        <span>{graphData().snaps.length > 0 ? formatTime(graphData().snaps[graphData().snaps.length - 1].timestamp) : ""}</span>
      </div>
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

interface PerformancePanelProps {
  instanceId: Accessor<string | null>;
  instanceStatus: Accessor<string>;
  onClose?: () => void;
  isModal?: boolean;
}

export function PerformancePanel(props: PerformancePanelProps) {
  const { t } = useI18n();
  const perf = usePerformance(props.instanceId);

  const [activeTab, setActiveTab] = createSignal<"realtime" | "mods" | "recommendations">("realtime");
  const [modPerformance, setModPerformance] = createSignal<ModPerformance[]>([]);
  const [recommendations, setRecommendations] = createSignal<PerformanceRecommendation[]>([]);
  const [instanceClosed, setInstanceClosed] = createSignal(false);
  const [applyingFix, setApplyingFix] = createSignal<string | null>(null);

  // Загружаем данные при открытии
  createEffect(async () => {
    const id = props.instanceId();
    if (!id) return;

    // Детектируем Spark
    await perf.detectSpark(id);

    // Если экземпляр запущен и мониторинг не активен - предлагаем начать
    if (props.instanceStatus() === "running" && !perf.monitoring()) {
      // Можно автоматически начать или оставить кнопку
    }
  });

  // Отслеживаем закрытие экземпляра
  createEffect(() => {
    const status = props.instanceStatus();
    if (status === "stopped" && perf.snapshots().length > 0) {
      setInstanceClosed(true);
    } else if (status === "running") {
      setInstanceClosed(false);
    }
  });

  // Загружаем данные модов при переключении на вкладку
  createEffect(async () => {
    if (activeTab() === "mods" && perf.sparkInfo()?.detected) {
      const mods = await perf.getModPerformanceFromSpark();
      setModPerformance(mods);
    }
  });

  // Загружаем рекомендации при переключении на вкладку
  createEffect(async () => {
    if (activeTab() === "recommendations") {
      const recs = await perf.getRecommendations();
      setRecommendations(recs);
    }
  });

  const getSeverityColor = (severity: BottleneckSeverity): string => {
    switch (severity) {
      case "critical": return "text-red-500";
      case "high": return "text-orange-500";
      case "medium": return "text-yellow-500";
      case "low": return "text-blue-400";
      default: return "text-gray-400";
    }
  };

  const getImpactColor = (category: ImpactCategory): string => {
    switch (category) {
      case "critical": return "bg-red-500/20 text-red-400 border-red-500/30";
      case "high": return "bg-orange-500/20 text-orange-400 border-orange-500/30";
      case "medium": return "bg-yellow-500/20 text-yellow-400 border-yellow-500/30";
      case "low": return "bg-blue-500/20 text-blue-400 border-blue-500/30";
      case "minimal": return "bg-green-500/20 text-green-400 border-green-500/30";
      default: return "bg-gray-500/20 text-gray-400 border-gray-500/30";
    }
  };

  const getScoreColor = (score: number): string => {
    if (score >= 80) return "text-green-400";
    if (score >= 60) return "text-yellow-400";
    if (score >= 40) return "text-orange-400";
    return "text-red-400";
  };

  const formatMemory = (mb: number): string => {
    if (mb >= 1024) {
      return `${(mb / 1024).toFixed(1)} GB`;
    }
    return `${mb} MB`;
  };

  // Применить быстрый фикс
  const applyFix = async (rec: PerformanceRecommendation) => {
    const id = props.instanceId();
    if (!id) return;

    setApplyingFix(rec.title);
    try {
      const action = rec.action;

      if (action.type === "increase_memory") {
        // Обновляем память экземпляра
        await invoke("update_instance", {
          instanceId: id,
          request: { memory_mb: action.recommended_mb }
        });
        addToast({
          type: "success",
          title: t().performance?.toast?.memoryIncreased || "Memory increased",
          message: (t().performance?.toast?.memoryIncreasedMessage || "{memory}. Restart the instance.").replace("{memory}", formatMemory(action.recommended_mb)),
        });
      } else if (action.type === "disable_mod") {
        // Отключаем мод
        await invoke("toggle_mod", {
          instanceId: id,
          modId: action.mod_id,
          enabled: false
        });
        addToast({
          type: "success",
          title: t().performance?.toast?.modDisabled || "Mod disabled",
          message: (t().performance?.toast?.modDisabledMessage || "{modId}. Restart the instance.").replace("{modId}", action.mod_id),
        });
      } else if (action.type === "install_optimization_mod") {
        // Устанавливаем мод оптимизации
        await invoke("install_mod_by_slug", {
          instanceId: id,
          slug: action.mod_id,
          source: "modrinth"
        });
        addToast({
          type: "success",
          title: t().performance?.toast?.modInstalled || "Mod installed",
          message: (t().performance?.toast?.modInstalledMessage || "{name}. Restart the instance.").replace("{name}", action.mod_name),
        });
      } else if (action.type === "add_jvm_argument") {
        // Добавляем JVM аргумент - нужно обновить экземпляр
        addToast({
          type: "info",
          title: t().performance?.toast?.addJvmArgManually || "Add JVM argument manually",
          message: action.argument,
          duration: 10000,
        });
      } else {
        addToast({
          type: "info",
          title: t().performance?.toast?.executeManually || "Execute manually",
          message: rec.description,
          duration: 10000,
        });
      }

      // Обновляем рекомендации
      const recs = await perf.getRecommendations();
      setRecommendations(recs);
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to apply fix:", e);
      addToast({
        type: "error",
        title: t().performance?.toast?.error || "Error",
        message: String(e),
        duration: 7000,
      });
    } finally {
      setApplyingFix(null);
    }
  };

  // Получить текст кнопки для действия
  const getActionButtonText = (action: PerformanceAction): string => {
    switch (action.type) {
      case "increase_memory": return (t().performance?.actions?.increaseTo || "Increase to {memory}").replace("{memory}", formatMemory(action.recommended_mb));
      case "disable_mod": return t().performance?.actions?.disableMod || "Disable mod";
      case "install_optimization_mod": return (t().performance?.actions?.install || "Install {name}").replace("{name}", action.mod_name);
      case "update_mod": return t().performance?.actions?.updateMod || "Update mod";
      case "add_jvm_argument": return t().performance?.actions?.copyArgument || "Copy argument";
      case "reduce_render_distance": return (t().performance?.actions?.reduceTo || "Reduce to {value}").replace("{value}", String(action.recommended));
      case "change_setting": return t().performance?.actions?.changeSetting || "Change setting";
      default: return t().performance?.actions?.apply || "Apply";
    }
  };

  // Можно ли автоматически применить фикс
  const canAutoFix = (action: PerformanceAction): boolean => {
    return ["increase_memory", "disable_mod", "install_optimization_mod"].includes(action.type);
  };

  const isModal = () => props.isModal !== false;

  const content = (
    <div class={`bg-gray-850 rounded-2xl border border-gray-700/50 shadow-xl ${isModal() ? 'w-[900px] max-h-[85vh] flex flex-col' : 'w-full'}`}>
        {/* Header */}
        <div class="flex items-center justify-between p-4 border-b border-gray-700/50">
          <div class="flex items-center gap-3">
            <i class="i-hugeicons-activity-01 w-5 h-5 text-blue-400" />
            <h2 class="text-lg font-medium">{t().performance?.title || "Производительность"}</h2>

            {/* Overall Score */}
            <Show when={perf.report()}>
              <div class={`px-2 py-0.5 rounded-2xl text-sm font-medium ${getScoreColor(perf.report()!.overall_score)}`}>
                {Math.round(perf.report()!.overall_score)}/100
              </div>
            </Show>

            {/* Spark Badge */}
            <Show when={perf.sparkInfo()?.detected}>
              <div class="px-2 py-0.5 rounded-2xl text-xs bg-purple-500/20 text-purple-400 border border-purple-500/30 inline-flex items-center gap-1">
                <i class="i-hugeicons-flash w-3 h-3" />
                Spark
              </div>
            </Show>
          </div>

          <div class="flex items-center gap-2">
            {/* Monitoring Toggle */}
            <Show when={props.instanceStatus() === "running"}>
              <button
                onClick={async () => {
                  if (perf.monitoring()) {
                    await perf.stopMonitoring();
                  } else {
                    await perf.startMonitoring();
                  }
                }}
                disabled={perf.loading()}
                class={`px-3 py-1.5 rounded-xl text-sm font-medium transition-all disabled:opacity-50 inline-flex items-center gap-1.5 ${
                  perf.monitoring()
                    ? "bg-red-500/20 text-red-400 hover:bg-red-500/30"
                    : "bg-green-500/20 text-green-400 hover:bg-green-500/30"
                }`}
              >
                <Show
                  when={!perf.loading()}
                  fallback={<i class="w-4 h-4 i-svg-spinners-6-dots-scale" />}
                >
                  <i class={`w-4 h-4 ${perf.monitoring() ? "i-hugeicons-stop" : "i-hugeicons-play"}`} />
                </Show>
                {perf.monitoring()
                  ? (t().performance?.stopMonitoring || "Остановить")
                  : (t().performance?.startMonitoring || "Мониторинг")}
              </button>
            </Show>

            {/* Refresh Report */}
            <button
              onClick={() => perf.getReport()}
              disabled={perf.loading()}
              class="p-2 rounded-xl text-gray-400 hover:text-white hover:bg-gray-750 transition-all disabled:opacity-50"
            >
              <i class={`w-5 h-5 ${perf.loading() ? "i-svg-spinners-6-dots-scale" : "i-hugeicons-refresh"}`} />
            </button>

            {/* Close - only show in modal mode */}
            <Show when={isModal() && props.onClose}>
              <button
                onClick={props.onClose}
                class="btn-close"
                aria-label={t().ui?.tooltips?.close ?? "Close"}
              >
                <i class="i-hugeicons-cancel-01 w-5 h-5" />
              </button>
            </Show>
          </div>
        </div>

        {/* Tabs */}
        <div class="p-2 border-b border-gray-700/30">
          <Tabs
            tabs={[
              { id: "realtime", label: t().performance?.realtime || "Реальное время", icon: "i-hugeicons-chart-line-data-01" },
              { id: "mods", label: t().performance?.modPerformance || "Моды", icon: "i-hugeicons-package" },
              { id: "recommendations", label: t().performance?.recommendations || "Рекомендации", icon: "i-hugeicons-idea" },
            ]}
            activeTab={activeTab()}
            onTabChange={(id) => setActiveTab(id as "realtime" | "mods" | "recommendations")}
          />
        </div>

        {/* Error Display */}
        <Show when={perf.error()}>
          <div class="mx-4 mt-2 p-3 bg-red-500/20 border border-red-500/30 rounded-xl flex items-center gap-2">
            <i class="i-hugeicons-alert-02 w-5 h-5 text-red-400 flex-shrink-0" />
            <span class="text-sm text-red-300">{perf.error()}</span>
            <button
              onClick={() => perf.clearError()}
              class="ml-auto p-1 rounded hover:bg-red-500/20 text-red-400"
            >
              <i class="i-hugeicons-cancel-01 w-4 h-4" />
            </button>
          </div>
        </Show>

        {/* Instance Closed Notification */}
        <Show when={instanceClosed()}>
          <div class="mx-4 mt-2 p-3 bg-yellow-500/20 border border-yellow-500/30 rounded-xl flex items-center gap-2">
            <i class="i-hugeicons-power-socket-01 w-5 h-5 text-yellow-400 flex-shrink-0" />
            <span class="text-sm text-yellow-300">{t().performance?.instanceClosed || "Instance closed. Monitoring data saved."}</span>
            <button
              onClick={() => setInstanceClosed(false)}
              class="ml-auto p-1 rounded hover:bg-yellow-500/20 text-yellow-400"
            >
              <i class="i-hugeicons-cancel-01 w-4 h-4" />
            </button>
          </div>
        </Show>

        {/* Content */}
        <div class={`p-4 ${isModal() ? 'flex-1 overflow-y-auto' : ''}`}>
          {/* Realtime Tab */}
          <Show when={activeTab() === "realtime"}>
            <div class="space-y-4">
              {/* Stats Cards */}
              <div class="grid grid-cols-4 gap-3">
                {/* Memory */}
                <div class="bg-gray-750/50 rounded-xl p-4 flex flex-col gap-1">
                  <div class="text-xs text-gray-500" title="RSS (Resident Set Size) - вся память процесса">
                    {t().performance?.memoryUsage || "Память"} (RSS)
                  </div>
                  <div class="text-2xl font-semibold text-white">
                    {formatMemory(perf.latestSnapshot()?.memory_used_mb || perf.avgMemory())}
                  </div>
                  <Show when={perf.latestSnapshot()?.memory_max_mb}>
                    <div class="text-xs text-gray-500">
                      / {formatMemory(perf.latestSnapshot()!.memory_max_mb!)}
                    </div>
                  </Show>
                </div>

                {/* CPU - нормализованный процент 0-100% */}
                <div class="bg-gray-750/50 rounded-xl p-4 flex flex-col gap-1">
                  <div class="text-xs text-gray-500">
                    {t().performance?.cpuUsage || "CPU"} (процесс)
                  </div>
                  {(() => {
                    const cpuPercent = perf.latestSnapshot()?.cpu_percent || perf.avgCpu();
                    const cpuCores = perf.latestSnapshot()?.cpu_cores || 1;
                    const physicalCores = perf.latestSnapshot()?.physical_cores || 1;
                    return (
                      <>
                        <div class={`text-2xl font-semibold ${
                          cpuPercent >= 90 ? "text-red-400" :
                          cpuPercent >= 70 ? "text-yellow-400" : "text-green-400"
                        }`}>
                          {cpuPercent.toFixed(0)}
                          <span class="text-sm text-gray-500">%</span>
                        </div>
                        <div class="text-xs text-gray-500">
                          {(t().performance?.coresThreads || "{cores} cores / {threads} threads").replace("{cores}", String(physicalCores)).replace("{threads}", String(cpuCores))}
                        </div>
                      </>
                    );
                  })()}
                </div>

                {/* TPS */}
                <div class="bg-gray-750/50 rounded-xl p-4 flex flex-col gap-1">
                  <div class="text-xs text-gray-500">
                    {t().performance?.tps || "TPS"}
                  </div>
                  <div class={`text-2xl font-semibold ${
                    (perf.latestSnapshot()?.tps || 20) >= 18 ? "text-green-400" :
                    (perf.latestSnapshot()?.tps || 20) >= 15 ? "text-yellow-400" : "text-red-400"
                  }`}>
                    {perf.latestSnapshot()?.tps?.toFixed(1) || "—"}
                  </div>
                </div>

                {/* MSPT */}
                <div class="bg-gray-750/50 rounded-xl p-4 flex flex-col gap-1">
                  <div class="text-xs text-gray-500">
                    {t().performance?.mspt || "MSPT"}
                  </div>
                  <div class={`text-2xl font-semibold ${
                    (perf.latestSnapshot()?.mspt || 0) <= 50 ? "text-green-400" :
                    (perf.latestSnapshot()?.mspt || 0) <= 100 ? "text-yellow-400" : "text-red-400"
                  }`}>
                    {perf.latestSnapshot()?.mspt?.toFixed(1) || "—"}
                    <span class="text-sm text-gray-500">ms</span>
                  </div>
                </div>
              </div>

              {/* Memory & CPU Line Graph with Hover Tooltips */}
              <Show when={perf.snapshots().length > 1}>
                <PerformanceGraph snapshots={perf.snapshots()} formatMemory={formatMemory} />
              </Show>

              {/* Per-Core CPU Usage */}
              <Show when={perf.latestSnapshot()?.cpu_per_core && perf.latestSnapshot()!.cpu_per_core.length > 0}>
                <details class="bg-gray-750/50 rounded-xl">
                  <summary class="px-4 py-3 cursor-pointer text-sm text-gray-400 hover:text-white transition-colors select-none flex items-center gap-2">
                    <i class="i-hugeicons-cpu w-4 h-4" />
                    <span>{t().performance?.threadUsage || "Thread usage (system)"}</span>
                    <span class="text-xs text-gray-500 ml-auto">
                      {(t().performance?.coresThreads || "{cores} cores / {threads} threads").replace("{cores}", String(perf.latestSnapshot()?.physical_cores || 0)).replace("{threads}", String(perf.latestSnapshot()?.cpu_cores || 0))}
                    </span>
                  </summary>
                  <div class="px-4 pb-4 pt-2 grid grid-cols-6 gap-2">
                    <For each={perf.latestSnapshot()?.cpu_per_core || []}>
                      {(usage, index) => {
                        // Чередуем цвета для визуальной группировки пар (ядро + его hyperthread)
                        const coreGroup = () => Math.floor(index() / 2);
                        const isEvenGroup = () => coreGroup() % 2 === 0;
                        return (
                          <div class={`rounded-2xl p-2 text-center flex flex-col gap-1 ${
                            isEvenGroup() ? "bg-gray-700/50" : "bg-gray-800/50"
                          }`}>
                            <div class="text-xs text-gray-500">
                              {t().performance?.thread || "Thread"} {index() + 1}
                            </div>
                            <div class={`text-sm font-medium ${
                              usage >= 90 ? "text-red-400" :
                              usage >= 70 ? "text-yellow-400" :
                              usage >= 50 ? "text-[var(--color-primary)]" : "text-green-400"
                            }`}>
                              {usage.toFixed(0)}%
                            </div>
                            {/* Mini progress bar */}
                            <div class="h-1 bg-gray-600 rounded-full overflow-hidden">
                              <div
                                class={`h-full rounded-full transition-all ${
                                  usage >= 90 ? "bg-red-500" :
                                  usage >= 70 ? "bg-yellow-500" :
                                  usage >= 50 ? "bg-[var(--color-primary)]" : "bg-green-500"
                                }`}
                                style={{ width: `${Math.min(usage, 100)}%` }}
                              />
                            </div>
                          </div>
                        );
                      }}
                    </For>
                  </div>
                </details>
              </Show>

              {/* Realtime Bottlenecks */}
              <Show when={perf.realtimeBottlenecks().length > 0}>
                <div class="bg-gray-750/50 rounded-xl p-4 flex flex-col gap-3">
                  <div class="flex items-center justify-between">
                    <div class="text-sm text-gray-400">{t().performance?.bottlenecks || "Проблемы"}</div>
                    <button
                      onClick={() => perf.clearRealtimeBottlenecks()}
                      class="text-xs text-gray-500 hover:text-white"
                    >
                      {t().common?.clear || "Очистить"}
                    </button>
                  </div>
                  <div class="space-y-2 max-h-40 overflow-y-auto">
                    <For each={perf.realtimeBottlenecks()}>
                      {(bottleneck) => (
                        <div class="flex items-start gap-2 text-sm">
                          <i class={`w-4 h-4 mt-0.5 i-hugeicons-alert-02 ${getSeverityColor(bottleneck.severity)}`} />
                          <span class="text-gray-300">{bottleneck.description}</span>
                          <Show when={bottleneck.metric}>
                            <span class="text-gray-500 ml-auto">{bottleneck.metric}</span>
                          </Show>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              </Show>

              {/* No data message */}
              <Show when={!perf.monitoring() && perf.snapshots().length === 0}>
                <div class="flex flex-col items-center justify-center gap-3 py-12 text-gray-500">
                  <i class="i-hugeicons-chart-line-data-01 w-12 h-12 opacity-50" />
                  <div class="text-sm">
                    {props.instanceStatus() === "running"
                      ? (t().performance?.clickToStart || "Нажмите \"Мониторинг\" для начала сбора данных")
                      : (t().performance?.instanceNotRunning || "Экземпляр не запущен")}
                  </div>
                </div>
              </Show>
            </div>
          </Show>

          {/* Mods Tab */}
          <Show when={activeTab() === "mods"}>
            <div class="space-y-3">
              <Show
                when={perf.sparkInfo()?.detected}
                fallback={
                  <div class="flex flex-col items-center justify-center gap-3 py-12 text-gray-500">
                    <i class="i-hugeicons-flash w-12 h-12 opacity-50" />
                    <div class="text-sm">{t().performance?.sparkNotInstalled || "Spark не установлен"}</div>
                    <div class="text-xs text-gray-600">
                      {t().performance?.installSparkHint || "Установите Spark для детального анализа производительности модов"}
                    </div>
                    <button
                      onClick={() => perf.installSpark()}
                      disabled={perf.sparkInstalling()}
                      class="btn-primary px-4 py-2 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl text-sm flex items-center gap-2"
                    >
                      <Show
                        when={!perf.sparkInstalling()}
                        fallback={<i class="i-svg-spinners-6-dots-scale w-4 h-4" />}
                      >
                        <i class="i-hugeicons-download-02 w-4 h-4" />
                      </Show>
                      {perf.sparkInstalling()
                        ? (t().performance?.installingSpark || "Установка...")
                        : (t().performance?.installSparkButton || "Установить Spark")}
                    </button>
                  </div>
                }
              >
                <For each={modPerformance()}>
                  {(mod) => (
                    <div class="bg-gray-750/50 rounded-xl p-4">
                      <div class="flex items-center justify-between">
                        <div class="flex items-center gap-3">
                          <span class="font-medium text-white">{mod.mod_name}</span>
                          <span class={`px-2 py-0.5 rounded text-xs border ${getImpactColor(mod.impact_category)}`}>
                            {mod.impact_category}
                          </span>
                        </div>
                        <div class="text-sm text-gray-400">
                          {mod.tick_percent.toFixed(1)}% tick
                        </div>
                      </div>
                      <div class="mt-2 flex items-center gap-4 text-xs text-gray-500">
                        <span>Avg: {mod.tick_time_avg_ms.toFixed(2)}ms</span>
                        <span>Max: {mod.tick_time_max_ms.toFixed(2)}ms</span>
                        <span>Impact: {mod.impact_score.toFixed(0)}</span>
                      </div>
                      {/* Progress bar */}
                      <div class="mt-2 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                        <div
                          class={`h-full rounded-full ${
                            mod.impact_category === "critical" ? "bg-red-500" :
                            mod.impact_category === "high" ? "bg-orange-500" :
                            mod.impact_category === "medium" ? "bg-yellow-500" : "bg-blue-500"
                          }`}
                          style={{ width: `${Math.min(mod.tick_percent, 100)}%` }}
                        />
                      </div>
                    </div>
                  )}
                </For>

                <Show when={modPerformance().length === 0}>
                  <div class="bg-gray-750/50 rounded-xl p-6">
                    <div class="flex items-start gap-4">
                      <i class="i-hugeicons-information-circle w-6 h-6 text-blue-400 flex-shrink-0 mt-0.5" />
                      <div class="flex flex-col gap-2">
                        <div class="text-white font-medium">{t().performance?.modPerformanceInfo?.title || "How to get mod performance data"}</div>
                        <div class="text-sm text-gray-400 flex flex-col gap-2">
                          <p>{t().performance?.modPerformanceInfo?.intro || "Spark is installed, but you need to create a profiling report:"}</p>
                          <ol class="list-decimal list-inside flex flex-col gap-1 text-gray-500">
                            <li>{t().performance?.modPerformanceInfo?.step1 || "In game chat, type:"} <code class="bg-gray-700 px-1.5 py-0.5 rounded text-blue-300">/sparkc profiler start</code></li>
                            <li>{t().performance?.modPerformanceInfo?.step2 || "Play for 30-60 seconds (load chunks, open mod inventories)"}</li>
                            <li>{t().performance?.modPerformanceInfo?.step3 || "Stop profiling:"} <code class="bg-gray-700 px-1.5 py-0.5 rounded text-blue-300">/sparkc profiler stop</code></li>
                            <li>{t().performance?.modPerformanceInfo?.step4 || "Spark will create a report link in chat"}</li>
                          </ol>
                          <p class="text-xs text-gray-600">
                            {t().performance?.modPerformanceInfo?.otherCommands || "Other useful commands:"} <code class="bg-gray-700 px-1 rounded">/sparkc tps</code>, <code class="bg-gray-700 px-1 rounded">/sparkc health</code>
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                </Show>
              </Show>
            </div>
          </Show>

          {/* Recommendations Tab */}
          <Show when={activeTab() === "recommendations"}>
            <div class="space-y-3">
              <For each={recommendations()}>
                {(rec) => (
                  <div class="bg-gray-750/50 rounded-xl p-4">
                    <div class="flex items-start gap-3">
                      <div class={`w-8 h-8 rounded-2xl flex items-center justify-center flex-shrink-0 ${
                        rec.priority >= 8 ? "bg-red-500/20 text-red-400" :
                        rec.priority >= 6 ? "bg-orange-500/20 text-orange-400" :
                        rec.priority >= 4 ? "bg-yellow-500/20 text-yellow-400" : "bg-blue-500/20 text-blue-400"
                      }`}>
                        <i class="i-hugeicons-idea w-5 h-5" />
                      </div>
                      <div class="flex-1">
                        <div class="font-medium text-white">{rec.title}</div>
                        <div class="text-sm text-gray-400 mt-1">{rec.description}</div>
                        <div class="flex items-center gap-3 mt-3">
                          <span class={`px-2 py-0.5 rounded text-xs ${
                            rec.expected_impact === "Critical" ? "bg-red-500/20 text-red-400" :
                            rec.expected_impact === "High" ? "bg-orange-500/20 text-orange-400" :
                            rec.expected_impact === "Medium" ? "bg-yellow-500/20 text-yellow-400" : "bg-blue-500/20 text-blue-400"
                          }`}>
                            {rec.expected_impact}
                          </span>
                          <span class="text-xs text-gray-500">{t().performance?.priority || "Priority"}: {rec.priority}/10</span>

                          {/* Quick Fix Button */}
                          <Show when={canAutoFix(rec.action)}>
                            <button
                              onClick={() => applyFix(rec)}
                              disabled={applyingFix() !== null}
                              class={`ml-auto px-3 py-1 rounded-2xl text-xs font-medium transition-all ${
                                applyingFix() === rec.title
                                  ? "bg-gray-600 text-gray-300 cursor-wait"
                                  : "bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white"
                              }`}
                            >
                              <Show
                                when={applyingFix() !== rec.title}
                                fallback={
                                  <span class="flex items-center gap-1">
                                    <i class="i-svg-spinners-6-dots-scale w-3 h-3" />
                                    {t().performance?.applying || "Applying..."}
                                  </span>
                                }
                              >
                                <span class="flex items-center gap-1">
                                  <i class="i-hugeicons-flash w-3 h-3" />
                                  {getActionButtonText(rec.action)}
                                </span>
                              </Show>
                            </button>
                          </Show>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </For>

              <Show when={recommendations().length === 0}>
                <div class="flex flex-col items-center justify-center gap-3 py-12 text-gray-500">
                  <i class="i-hugeicons-checkmark-circle-02 w-12 h-12 text-green-500 opacity-50" />
                  <div class="text-sm">{t().performance?.noRecommendations || "Нет рекомендаций - всё работает хорошо!"}</div>
                </div>
              </Show>
            </div>
          </Show>
        </div>

        {/* Footer */}
        <div class="p-3 border-t border-gray-700/30 flex items-center justify-between text-xs text-gray-500">
          <div>
            {perf.monitoring() && (
              <span class="flex items-center gap-1.5">
                <span class="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                {t().performance?.monitoring || "Monitoring"}
                <span class="text-gray-600">({perf.snapshots().length} {t().performance?.snapshots || "snapshots"})</span>
              </span>
            )}
          </div>
          <div>
            {perf.report()?.data_source === "spark_report"
              ? (t().performance?.dataSource?.spark || "Data: Spark")
              : perf.report()?.data_source === "system_and_logs"
              ? (t().performance?.dataSource?.systemLogs || "Data: System + Logs")
              : (t().performance?.dataSource?.system || "Data: System")}
          </div>
        </div>
      </div>
  );

  // Return with optional modal wrapper
  return isModal() ? (
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      {content}
    </div>
  ) : content;
}

export default PerformancePanel;
