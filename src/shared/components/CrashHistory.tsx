import { Component, Show, For, createSignal, createEffect, Accessor } from "solid-js";
import { useCrashHistory } from "../hooks/useCrashHistory";
import { useI18n } from "../i18n";
import { createConfirmDialog } from "./ConfirmDialog";
import type { CrashRecord, CrashTrendDirection } from "../types";

interface CrashHistoryProps {
  instanceId: Accessor<string>;
  onClose?: () => void;
}

export const CrashHistory: Component<CrashHistoryProps> = (props) => {
  const { t } = useI18n();
  const { confirm, ConfirmDialogComponent } = createConfirmDialog();
  const crashHistory = useCrashHistory(props.instanceId);
  const [activeTab, setActiveTab] = createSignal<"stats" | "history" | "trends">("stats");
  const [selectedCrash, setSelectedCrash] = createSignal<CrashRecord | null>(null);

  // Load all data on mount
  createEffect(() => {
    if (props.instanceId()) {
      crashHistory.loadAll();
    }
  });

  const getTrendIcon = (trend: CrashTrendDirection) => {
    switch (trend) {
      case "worsening":
        return "i-hugeicons-arrow-up-01 text-red-400";
      case "improving":
        return "i-hugeicons-arrow-down-01 text-green-400";
      case "stable":
        return "i-hugeicons-minus-sign text-yellow-400";
      default:
        return "i-hugeicons-help-circle text-gray-400";
    }
  };

  const getTrendLabel = (trend: CrashTrendDirection) => {
    switch (trend) {
      case "worsening":
        return t().crashHistory.trendWorsening;
      case "improving":
        return t().crashHistory.trendImproving;
      case "stable":
        return t().crashHistory.trendStable;
      default:
        return t().crashHistory.trendUnknown;
    }
  };

  const formatDate = (dateStr: string) => {
    try {
      const date = new Date(dateStr);
      return date.toLocaleDateString() + " " + date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      return dateStr;
    }
  };

  const formatHours = (hours: number | undefined) => {
    if (!hours) return "-";
    if (hours < 1) return `${Math.round(hours * 60)}m`;
    if (hours < 24) return `${Math.round(hours)}h`;
    return `${Math.round(hours / 24)}d`;
  };

  return (
    <>
    <div class="flex flex-col h-full">
      {/* Header */}
      <div class="flex items-center justify-between p-4 border-b border-gray-700/50">
        <h2 class="text-lg font-medium flex items-center gap-2">
          <i class="i-hugeicons-chart-line-data-01 w-5 h-5" />
          {t().crashHistory.title}
        </h2>
        <Show when={props.onClose}>
          <button
            onClick={props.onClose}
            class="p-1.5 rounded hover:bg-gray-700/50 transition-colors"
          >
            <i class="i-hugeicons-cancel-01 w-5 h-5" />
          </button>
        </Show>
      </div>

      {/* Tabs */}
      <div class="flex border-b border-gray-700/50">
        <button
          class={`px-4 py-2 text-sm font-medium transition-colors inline-flex items-center gap-1.5 ${
            activeTab() === "stats"
              ? "text-blue-400 border-b-2 border-blue-400"
              : "text-gray-400 hover:text-gray-200"
          }`}
          onClick={() => setActiveTab("stats")}
        >
          <i class="i-hugeicons-dashboard-square-01 w-4 h-4" />
          {t().crashHistory.tabStatistics}
        </button>
        <button
          class={`px-4 py-2 text-sm font-medium transition-colors inline-flex items-center gap-1.5 ${
            activeTab() === "history"
              ? "text-blue-400 border-b-2 border-blue-400"
              : "text-gray-400 hover:text-gray-200"
          }`}
          onClick={() => setActiveTab("history")}
        >
          <i class="i-hugeicons-menu-01 w-4 h-4" />
          {t().crashHistory.tabHistory}
        </button>
        <button
          class={`px-4 py-2 text-sm font-medium transition-colors inline-flex items-center gap-1.5 ${
            activeTab() === "trends"
              ? "text-blue-400 border-b-2 border-blue-400"
              : "text-gray-400 hover:text-gray-200"
          }`}
          onClick={() => setActiveTab("trends")}
        >
          <i class="i-hugeicons-analytics-01 w-4 h-4" />
          {t().crashHistory.tabTrends}
        </button>

        {/* Refresh button */}
        <button
          class="ml-auto px-3 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
          onClick={() => crashHistory.loadAll()}
          disabled={crashHistory.loading()}
        >
          <i class={`w-4 h-4 ${crashHistory.loading() ? "i-svg-spinners-6-dots-scale" : "i-hugeicons-refresh"}`} />
        </button>
      </div>

      {/* Content */}
      <div class="flex-1 overflow-y-auto p-4">
        <Show when={crashHistory.loading()}>
          <div class="flex items-center justify-center py-8">
            <i class="i-svg-spinners-6-dots-scale w-6 h-6 text-gray-400" />
          </div>
        </Show>

        <Show when={!crashHistory.loading()}>
          {/* Statistics Tab */}
          <Show when={activeTab() === "stats"}>
            <div class="space-y-4">
              {/* Stats Cards */}
              <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div class="bg-gray-800/50 rounded-2xl p-3 border border-gray-700/50">
                  <div class="text-2xl font-bold text-white">
                    {crashHistory.statistics()?.total_crashes ?? 0}
                  </div>
                  <div class="text-xs text-gray-400">{t().crashHistory.totalCrashes}</div>
                </div>

                <div class="bg-gray-800/50 rounded-2xl p-3 border border-gray-700/50">
                  <div class="text-2xl font-bold text-yellow-400">
                    {crashHistory.statistics()?.crashes_last_week ?? 0}
                  </div>
                  <div class="text-xs text-gray-400">{t().crashHistory.lastWeek}</div>
                </div>

                <div class="bg-gray-800/50 rounded-2xl p-3 border border-gray-700/50">
                  <div class="text-2xl font-bold text-red-400">
                    {crashHistory.statistics()?.crashes_last_day ?? 0}
                  </div>
                  <div class="text-xs text-gray-400">{t().crashHistory.last24h}</div>
                </div>

                <div class="bg-gray-800/50 rounded-2xl p-3 border border-gray-700/50">
                  <div class="text-2xl font-bold text-green-400">
                    {crashHistory.statistics()?.fix_success_rate.toFixed(0) ?? 0}%
                  </div>
                  <div class="text-xs text-gray-400">{t().crashHistory.fixRate}</div>
                </div>
              </div>

              {/* Trend Indicator */}
              <Show when={crashHistory.statistics()?.trend}>
                <div class="flex items-center gap-2 p-3 bg-gray-800/30 rounded-2xl border border-gray-700/30">
                  <i class={`w-5 h-5 ${getTrendIcon(crashHistory.statistics()!.trend)}`} />
                  <span class="text-sm text-gray-300">
                    {t().crashHistory.overallTrend}: {getTrendLabel(crashHistory.statistics()!.trend)}
                  </span>
                </div>
              </Show>

              {/* Average Time Between Crashes */}
              <Show when={crashHistory.statistics()?.avg_hours_between_crashes}>
                <div class="p-3 bg-gray-800/30 rounded-2xl border border-gray-700/30">
                  <div class="text-sm text-gray-400">{t().crashHistory.avgTimeBetween}</div>
                  <div class="text-lg font-medium text-white">
                    {formatHours(crashHistory.statistics()?.avg_hours_between_crashes)}
                  </div>
                </div>
              </Show>

              {/* Top Problematic Mods */}
              <Show when={(crashHistory.statistics()?.top_problematic_mods.length ?? 0) > 0}>
                <div class="space-y-2">
                  <h3 class="text-sm font-medium text-gray-300">{t().crashHistory.problematicMods}</h3>
                  <div class="space-y-2">
                    <For each={crashHistory.statistics()?.top_problematic_mods}>
                      {(mod) => (
                        <div class="flex items-center justify-between p-2 bg-gray-800/30 rounded border border-gray-700/30">
                          <div class="flex items-center gap-2">
                            <i class="i-hugeicons-alert-02 w-4 h-4 text-orange-400" />
                            <span class="text-sm text-gray-200">{mod.mod_id}</span>
                          </div>
                          <div class="flex items-center gap-3">
                            <span class="text-xs text-gray-400">
                              {mod.crash_count} {t().crashHistory.crashes} ({mod.crash_percentage.toFixed(0)}%)
                            </span>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              </Show>

              {/* Empty State */}
              <Show when={crashHistory.statistics()?.total_crashes === 0}>
                <div class="flex flex-col items-center justify-center py-8 text-gray-400">
                  <i class="i-hugeicons-checkmark-circle-02 w-12 h-12 text-green-400 mb-3" />
                  <p class="text-sm">{t().crashHistory.noCrashes}</p>
                </div>
              </Show>
            </div>
          </Show>

          {/* History Tab */}
          <Show when={activeTab() === "history"}>
            <div class="space-y-2">
              <Show when={crashHistory.history().length === 0}>
                <div class="flex flex-col items-center justify-center py-8 text-gray-400">
                  <i class="i-hugeicons-file-01 w-10 h-10 mb-3" />
                  <p class="text-sm">{t().crashHistory.noHistory}</p>
                </div>
              </Show>

              <For each={crashHistory.history()}>
                {(record) => (
                  <div
                    class={`p-3 rounded-2xl border transition-colors cursor-pointer ${
                      record.was_fixed
                        ? "bg-green-900/20 border-green-700/30 hover:border-green-600/50"
                        : "bg-gray-800/30 border-gray-700/30 hover:border-gray-600/50"
                    }`}
                    onClick={() => setSelectedCrash(selectedCrash() === record ? null : record)}
                  >
                    <div class="flex items-center justify-between">
                      <div class="flex items-center gap-2">
                        <i
                          class={`w-4 h-4 ${
                            record.was_fixed ? "i-hugeicons-checkmark-circle-02 text-green-400" : "i-hugeicons-alert-02 text-red-400"
                          }`}
                        />
                        <span class="text-sm font-medium text-gray-200">
                          {record.log_type === "crash" ? t().crashHistory.crashReport : t().crashHistory.logAnalysis}
                        </span>
                        <span class="text-xs text-gray-500">{formatDate(record.crash_time)}</span>
                      </div>
                      <div class="flex items-center gap-2">
                        <span class="text-xs px-2 py-0.5 rounded bg-gray-700/50 text-gray-300">
                          {record.problems.length} {t().crashHistory.problems}
                        </span>
                        <i
                          class={`w-4 h-4 transition-transform ${
                            selectedCrash() === record ? "rotate-180" : ""
                          } i-hugeicons-arrow-down-01 text-gray-400`}
                        />
                      </div>
                    </div>

                    {/* Suspected Mods */}
                    <Show when={record.suspected_mods.length > 0}>
                      <div class="mt-2 flex flex-wrap gap-1">
                        <For each={record.suspected_mods.slice(0, 5)}>
                          {(mod) => (
                            <span class="text-xs px-1.5 py-0.5 rounded bg-orange-900/30 text-orange-300 border border-orange-700/30">
                              {mod}
                            </span>
                          )}
                        </For>
                        <Show when={record.suspected_mods.length > 5}>
                          <span class="text-xs text-gray-500">+{record.suspected_mods.length - 5}</span>
                        </Show>
                      </div>
                    </Show>

                    {/* Expanded Details */}
                    <Show when={selectedCrash() === record}>
                      <div class="mt-3 pt-3 border-t border-gray-700/30 space-y-2">
                        <Show when={record.minecraft_version}>
                          <div class="text-xs text-gray-400">
                            Minecraft: {record.minecraft_version}
                            {record.loader_type && ` / ${record.loader_type}`}
                            {record.loader_version && ` ${record.loader_version}`}
                          </div>
                        </Show>

                        {/* Problems List */}
                        <div class="space-y-1">
                          <For each={record.problems.slice(0, 3)}>
                            {(problem) => (
                              <div class="text-xs p-2 bg-gray-900/50 rounded">
                                <div class="font-medium text-gray-200">{problem.title}</div>
                                <div class="text-gray-400 truncate">{problem.description}</div>
                              </div>
                            )}
                          </For>
                          <Show when={record.problems.length > 3}>
                            <div class="text-xs text-gray-500 px-2">
                              +{record.problems.length - 3} {t().crashHistory.moreProblems}
                            </div>
                          </Show>
                        </div>

                        {/* Actions */}
                        <div class="flex items-center gap-2 pt-2">
                          <Show when={!record.was_fixed}>
                            <button
                              class="text-xs px-2 py-1 bg-green-600/20 text-green-400 rounded hover:bg-green-600/30 transition-colors inline-flex items-center gap-1"
                              onClick={(e) => {
                                e.stopPropagation();
                                crashHistory.markFixed(record.id, "manual");
                              }}
                            >
                              <i class="i-hugeicons-checkmark-circle-02 w-3 h-3" />
                              {t().crashHistory.markFixed}
                            </button>
                          </Show>
                          <Show when={record.was_fixed && record.fix_method}>
                            <span class="text-xs text-green-400">
                              {t().crashHistory.fixedVia}: {record.fix_method}
                            </span>
                          </Show>
                        </div>
                      </div>
                    </Show>
                  </div>
                )}
              </For>

              {/* Clear History */}
              <Show when={crashHistory.history().length > 0}>
                <button
                  class="mt-4 text-xs px-3 py-1.5 text-red-400 hover:text-red-300 hover:bg-red-900/20 rounded transition-colors inline-flex items-center gap-1"
                  onClick={async () => {
                    const confirmed = await confirm({
                      title: t().crashHistory.clearHistory,
                      message: t().crashHistory.confirmClear,
                      variant: "danger",
                      confirmText: t().common.delete,
                      cancelText: t().common.cancel,
                    });
                    if (confirmed) {
                      await crashHistory.clearHistory();
                    }
                  }}
                >
                  <i class="i-hugeicons-delete-02 w-3 h-3" />
                  {t().crashHistory.clearHistory}
                </button>
              </Show>
            </div>
          </Show>

          {/* Trends Tab */}
          <Show when={activeTab() === "trends"}>
            <div class="space-y-4">
              <Show when={crashHistory.trends().length === 0}>
                <div class="flex flex-col items-center justify-center py-8 text-gray-400">
                  <i class="i-hugeicons-analytics-01 w-10 h-10 mb-3" />
                  <p class="text-sm">{t().crashHistory.noTrends}</p>
                </div>
              </Show>

              <For each={crashHistory.trends()}>
                {(trend) => (
                  <div class="p-3 bg-gray-800/30 rounded-2xl border border-gray-700/30">
                    <div class="flex items-center justify-between mb-3">
                      <div class="flex items-center gap-2">
                        <span class="font-medium text-gray-200">{trend.mod_id}</span>
                        <i class={`w-4 h-4 ${getTrendIcon(trend.trend)}`} />
                      </div>
                      <span class="text-xs text-gray-400">{getTrendLabel(trend.trend)}</span>
                    </div>

                    {/* Mini Bar Chart */}
                    <div class="flex items-end gap-1 h-12 mb-2">
                      <For each={trend.daily_crashes}>
                        {(day) => {
                          const maxCount = Math.max(...trend.daily_crashes.map((d) => d.count), 1);
                          const height = day.count > 0 ? Math.max((day.count / maxCount) * 100, 10) : 4;
                          return (
                            <div class="flex-1 flex flex-col items-center gap-1">
                              <div
                                class={`w-full rounded-t ${day.count > 0 ? "bg-blue-500" : "bg-gray-700"}`}
                                style={{ height: `${height}%` }}
                                title={`${day.date}: ${day.count} crashes`}
                              />
                              <span class="text-[10px] text-gray-500">
                                {new Date(day.date).toLocaleDateString(undefined, { weekday: "narrow" })}
                              </span>
                            </div>
                          );
                        }}
                      </For>
                    </div>

                    {/* Recommendation */}
                    <div class="text-xs text-gray-400 italic">{trend.recommendation}</div>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </div>
    </div>
    <ConfirmDialogComponent />
    </>
  );
};

export default CrashHistory;
