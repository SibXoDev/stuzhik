import { Show, For, createSignal, createMemo } from "solid-js";
import { useLiveCrashMonitor } from "../hooks/useLiveCrashMonitor";
import { useI18n } from "../i18n";
import { Tooltip } from "../ui";

/**
 * Compact Live Crash Indicator for TitleBar
 *
 * Shows a small status indicator with dropdown for details.
 * Automatically monitors running instances.
 */
export function LiveCrashIndicator() {
  const { t } = useI18n();
  const monitor = useLiveCrashMonitor();
  const [showDropdown, setShowDropdown] = createSignal(false);

  const hasIssues = createMemo(
    () => monitor.errorCount() > 0 || monitor.warningCount() > 0 || monitor.hasCrash()
  );

  const statusColor = createMemo(() => {
    if (!monitor.isMonitoring()) return "text-gray-500";
    if (monitor.hasCrash()) return "text-red-500";
    if (monitor.errorCount() > 0) return "text-orange-400";
    if (monitor.warningCount() > 0) return "text-yellow-400";
    return "text-green-400";
  });

  const statusIcon = createMemo(() => {
    if (!monitor.isMonitoring()) return "i-hugeicons-record";
    if (monitor.hasCrash()) return "i-hugeicons-alert-circle";
    if (monitor.errorCount() > 0) return "i-hugeicons-alert-02";
    if (monitor.warningCount() > 0) return "i-hugeicons-alert-02";
    return "i-hugeicons-checkmark-circle-02";
  });

  const problems = createMemo(() => monitor.getLatestProblems(5));
  const warnings = createMemo(() => monitor.getLatestWarnings(5));

  // Don't render if not monitoring and no issues
  const shouldShow = createMemo(() => monitor.isMonitoring() || hasIssues());

  return (
    <Show when={shouldShow()}>
      <div>
        {/* Compact Indicator Button */}
        <Tooltip text={monitor.isMonitoring() ? t().liveCrash.monitoring : t().liveCrash.notMonitoring} position="bottom">
          <button
            class={`p-1.5 flex items-center justify-center gap-1 rounded-2xl bg-transparent border-none outline-none cursor-pointer hover:bg-white/10 transition-colors duration-75 ${statusColor()}`}
            onClick={() => setShowDropdown(!showDropdown())}
          >
          <i class={`${statusIcon()} w-4 h-4`} />

          {/* Error count badge */}
          <Show when={monitor.errorCount() > 0}>
            <span class="text-[10px] font-medium min-w-[14px] h-[14px] flex items-center justify-center rounded-full bg-red-500/20 text-red-400 px-1">
              {monitor.errorCount() > 99 ? "99+" : monitor.errorCount()}
            </span>
          </Show>

          {/* Warning count badge (only if no errors) */}
          <Show when={monitor.warningCount() > 0 && monitor.errorCount() === 0}>
            <span class="text-[10px] font-medium min-w-[14px] h-[14px] flex items-center justify-center rounded-full bg-yellow-500/20 text-yellow-400 px-1">
              {monitor.warningCount() > 99 ? "99+" : monitor.warningCount()}
            </span>
          </Show>
        </button>
        </Tooltip>

        {/* Dropdown */}
        <Show when={showDropdown()}>
          {/* Backdrop to close dropdown */}
          <div
            class="fixed inset-0 z-50"
            onClick={() => setShowDropdown(false)}
          />

          <div
            class="absolute top-full right-0 mt-1 w-72 bg-gray-850 border border-gray-750 rounded-2xl shadow-xl z-50 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div class="px-3 py-2 border-b border-gray-750 flex items-center justify-between">
              <span class="text-sm font-medium text-gray-200">
                {t().liveCrash.title}
              </span>

              <Show when={hasIssues()}>
                <Tooltip text={t().liveCrash.clear} position="bottom">
                  <button
                    class="p-1 rounded hover:bg-gray-700 text-gray-400 hover:text-gray-200"
                    onClick={() => monitor.clearEvents()}
                  >
                    <i class="i-hugeicons-delete-02 w-3.5 h-3.5" />
                  </button>
                </Tooltip>
              </Show>
            </div>

            {/* Status */}
            <div class="px-3 py-2 border-b border-gray-750 bg-gray-900">
              <div class="flex items-center gap-3 text-xs">
                <div class="flex items-center gap-1">
                  <i class={`w-2 h-2 rounded-full ${monitor.isMonitoring() ? "bg-green-500 animate-pulse" : "bg-gray-500"}`} />
                  <span class={monitor.isMonitoring() ? "text-green-400" : "text-gray-500"}>
                    {monitor.isMonitoring() ? t().liveCrash.active : t().liveCrash.inactive}
                  </span>
                </div>

                <Show when={monitor.isMonitoring()}>
                  <span class="text-gray-500">|</span>
                  <span class="text-gray-400">
                    {t().liveCrash.errors}: <span class="text-red-400">{monitor.errorCount()}</span>
                  </span>
                  <span class="text-gray-400">
                    {t().liveCrash.warnings}: <span class="text-yellow-400">{monitor.warningCount()}</span>
                  </span>
                </Show>
              </div>
            </div>

            {/* Crash Alert */}
            <Show when={monitor.hasCrash()}>
              <div class="px-3 py-2 bg-red-500/10 border-b border-red-500/20 flex items-center gap-2 text-red-400">
                <i class="i-hugeicons-alert-circle w-4 h-4" />
                <span class="text-sm font-medium">{t().liveCrash.crashDetected}</span>
              </div>
            </Show>

            {/* Problems List */}
            <Show when={problems().length > 0}>
              <div class="max-h-32 overflow-y-auto">
                <For each={problems()}>
                  {(problem) => (
                    <div class="px-3 py-2 border-b border-gray-750 last:border-b-0 hover:bg-gray-800 flex items-start gap-2">
                      <i
                        class={`w-3.5 h-3.5 mt-0.5 flex-shrink-0 ${
                          problem.severity === "critical"
                            ? "i-hugeicons-alert-circle text-red-500"
                            : problem.severity === "error"
                              ? "i-hugeicons-alert-02 text-orange-400"
                              : "i-hugeicons-alert-02 text-yellow-400"
                        }`}
                      />
                      <div class="flex-1 min-w-0">
                        <div class="text-xs font-medium text-gray-200 truncate">
                          {problem.title}
                        </div>
                        <div class="text-[10px] text-gray-500 truncate">
                          {problem.description.slice(0, 80)}
                          {problem.description.length > 80 ? "..." : ""}
                        </div>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>

            {/* Warnings List */}
            <Show when={warnings().length > 0}>
              <div class="border-t border-gray-750">
                <div class="px-3 py-1.5 bg-gray-900 text-[10px] text-yellow-400 font-medium">
                  {t().liveCrash.warnings} ({warnings().length})
                </div>
                <div class="max-h-32 overflow-y-auto">
                  <For each={warnings()}>
                    {(warning) => (
                      <div class="px-3 py-2 border-b border-gray-750 last:border-b-0 hover:bg-gray-800 flex items-start gap-2">
                        <i class="i-hugeicons-alert-02 w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-yellow-400" />
                        <span class="flex-1 min-w-0 text-[11px] text-gray-300 break-words">
                          {warning.message.length > 120
                            ? warning.message.slice(0, 120) + "..."
                            : warning.message}
                        </span>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            {/* Empty State */}
            <Show when={problems().length === 0 && monitor.isMonitoring()}>
              <div class="px-3 py-4 text-center">
                <i class="i-hugeicons-checkmark-circle-02 w-6 h-6 text-green-400 mx-auto mb-2" />
                <p class="text-xs text-gray-400">{t().liveCrash.noIssues}</p>
              </div>
            </Show>

            {/* Not Monitoring State */}
            <Show when={!monitor.isMonitoring()}>
              <div class="px-3 py-4 text-center">
                <i class="i-hugeicons-view-off w-6 h-6 text-gray-500 mx-auto mb-2" />
                <p class="text-xs text-gray-400">{t().liveCrash.notMonitoringDesc}</p>
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  );
}
