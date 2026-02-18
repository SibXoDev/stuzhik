import { Show, For, Accessor } from "solid-js";
import type { TransferHistoryEntry, HistoryStats } from "./connectTypes";
import { formatBytes, formatTimeAgo } from "./connectUtils";

interface TransferHistorySectionProps {
  history: Accessor<TransferHistoryEntry[]>;
  historyStats: Accessor<HistoryStats | null>;
  showHistory: Accessor<boolean>;
  onToggleShow: () => void;
  onClearHistory: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: () => any;
}

export function TransferHistorySection(props: TransferHistorySectionProps) {
  const t = () => props.t();

  return (
    <div class="mt-4 pt-4 border-t border-gray-700">
      <button
        class="w-full flex items-center justify-between p-2 rounded-lg hover:bg-gray-800 transition-colors"
        onClick={props.onToggleShow}
      >
        <div class="flex items-center gap-2">
          <i class="i-hugeicons-clock-01 w-4 h-4 text-gray-400" />
          <span class="text-sm font-medium">{t().connect.history?.title || "History"}</span>
          <Show when={props.historyStats()}>
            <span class="text-xs text-gray-500">
              {props.historyStats()!.total_transfers} {t().connect.history?.transfers || "transfers"}
            </span>
          </Show>
        </div>
        <i class={`w-4 h-4 text-gray-400 transition-transform ${props.showHistory() ? "i-hugeicons-arrow-up-01" : "i-hugeicons-arrow-down-01"}`} />
      </button>

      <Show when={props.showHistory()}>
        <div class="mt-2 space-y-2">
          {/* Stats summary */}
          <Show when={props.historyStats()}>
            <div class="p-3 bg-gray-800/50 rounded-lg grid grid-cols-3 gap-2 text-center text-xs">
              <div>
                <div class="text-green-400 font-medium">{props.historyStats()!.successful}</div>
                <div class="text-gray-500">{t().connect.history?.successful || "Success"}</div>
              </div>
              <div>
                <div class="text-red-400 font-medium">{props.historyStats()!.failed}</div>
                <div class="text-gray-500">{t().connect.history?.failed || "Failed"}</div>
              </div>
              <div>
                <div class="text-gray-400 font-medium">{formatBytes((props.historyStats()?.total_bytes_uploaded ?? 0) + (props.historyStats()?.total_bytes_downloaded ?? 0))}</div>
                <div class="text-gray-500">{t().connect.history?.total || "Total"}</div>
              </div>
            </div>
          </Show>

          {/* History entries */}
          <Show when={props.history().length > 0} fallback={
            <div class="text-center py-4 text-gray-500 text-sm">
              {t().connect.history?.empty || "No transfer history"}
            </div>
          }>
            <For each={props.history().slice(0, 10)}>
              {(entry) => (
                <div class={`p-2 rounded-lg ${
                  entry.result === "success" ? "bg-green-900/10" :
                  entry.result === "failed" ? "bg-red-900/10" :
                  "bg-gray-800/50"
                }`}>
                  <div class="flex items-center justify-between mb-1">
                    <div class="flex items-center gap-2 min-w-0">
                      <i class={`w-3 h-3 flex-shrink-0 ${
                        entry.direction === "upload" ? "i-hugeicons-upload-02 text-orange-400" : "i-hugeicons-download-02 text-blue-400"
                      }`} />
                      <span class="text-xs truncate">{entry.modpack_name}</span>
                    </div>
                    <i class={`w-3 h-3 flex-shrink-0 ${
                      entry.result === "success" ? "i-hugeicons-checkmark-circle-02 text-green-400" :
                      entry.result === "failed" ? "i-hugeicons-cancel-01 text-red-400" :
                      "i-hugeicons-alert-02 text-yellow-400"
                    }`} />
                  </div>
                  <div class="flex items-center justify-between text-xs text-gray-500">
                    <span>{entry.peer_nickname || entry.peer_id.slice(0, 8)}</span>
                    <span>{formatTimeAgo(entry.completed_at, props.t)}</span>
                  </div>
                </div>
              )}
            </For>
          </Show>

          {/* Clear history button */}
          <Show when={props.history().length > 0}>
            <button
              class="w-full py-2 text-xs text-gray-500 hover:text-red-400 transition-colors"
              onClick={props.onClearHistory}
            >
              {t().connect.history?.clear || "Clear history"}
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
}
