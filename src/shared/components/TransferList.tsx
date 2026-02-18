import { Show, For, Accessor } from "solid-js";
import type { TransferSession } from "./connectTypes";
import { formatBytes, formatSpeed, formatEta } from "./connectUtils";

interface TransferListProps {
  transfers: Accessor<TransferSession[]>;
  showTransfers: Accessor<boolean>;
  onToggleShow: () => void;
  onCancelTransfer: (sessionId: string) => void;
  onClearCompleted: () => void;
  activeTransfersCount: () => number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: () => any;
}

export function TransferList(props: TransferListProps) {
  const t = () => props.t();

  return (
    <div class="mt-4 pt-4 border-t border-gray-700">
      <button
        class="w-full flex items-center justify-between p-2 rounded-lg hover:bg-gray-800 transition-colors"
        onClick={props.onToggleShow}
      >
        <div class="flex items-center gap-2">
          <i class={`w-4 h-4 ${props.activeTransfersCount() > 0 ? "i-hugeicons-loading-01 text-[var(--color-primary)] animate-pulse" : "i-hugeicons-checkmark-circle-02 text-green-400"}`} />
          <span class="text-sm font-medium">{t().connect.transfer.title}</span>
          <Show when={props.activeTransfersCount() > 0}>
            <span class="px-1.5 py-0.5 rounded-full bg-[var(--color-primary)] text-xs text-white">
              {props.activeTransfersCount()}
            </span>
          </Show>
        </div>
        <i class={`w-4 h-4 text-gray-400 transition-transform ${props.showTransfers() ? "i-hugeicons-arrow-up-01" : "i-hugeicons-arrow-down-01"}`} />
      </button>

      <Show when={props.showTransfers()}>
        <div class="mt-2 space-y-2">
          <For each={props.transfers()}>
            {(transfer) => {
              const progress = transfer.bytes_total > 0
                ? Math.round((transfer.bytes_done / transfer.bytes_total) * 100)
                : 0;
              const isActive = transfer.status === "connecting" || transfer.status === "negotiating" || transfer.status === "transferring";

              return (
                <div class={`p-3 rounded-lg ${
                  transfer.status === "completed" ? "bg-green-900/20 border border-green-800/50" :
                  transfer.status === "failed" ? "bg-red-900/20 border border-red-800/50" :
                  transfer.status === "cancelled" ? "bg-gray-800/50 border border-gray-700" :
                  "bg-gray-800"
                }`}>
                  {/* Header */}
                  <div class="flex items-center justify-between mb-2">
                    <div class="flex items-center gap-2 min-w-0">
                      <i class={`w-4 h-4 flex-shrink-0 ${
                        transfer.direction === "upload" ? "i-hugeicons-upload-02 text-orange-400" : "i-hugeicons-download-02 text-blue-400"
                      }`} />
                      <span class="text-sm font-medium truncate">
                        {transfer.peer_nickname || transfer.peer_id.slice(0, 8)}
                      </span>
                    </div>
                    <div class="flex items-center gap-1">
                      <Show when={isActive}>
                        <button
                          class="p-1 rounded hover:bg-gray-700 text-gray-400 hover:text-red-400 transition-colors"
                          onClick={() => props.onCancelTransfer(transfer.id)}
                          title={t().connect.transfer.cancel}
                        >
                          <i class="i-hugeicons-cancel-01 w-4 h-4" />
                        </button>
                      </Show>
                      <Show when={!isActive}>
                        <span class={`text-xs px-2 py-0.5 rounded-full ${
                          transfer.status === "completed" ? "bg-green-600/30 text-green-400" :
                          transfer.status === "failed" ? "bg-red-600/30 text-red-400" :
                          "bg-gray-600/30 text-gray-400"
                        }`}>
                          {transfer.status === "completed" ? t().connect.transfer.completed :
                           transfer.status === "failed" ? t().connect.transfer.failed :
                           t().connect.transfer.cancelled}
                        </span>
                      </Show>
                    </div>
                  </div>

                  {/* Progress bar */}
                  <Show when={isActive}>
                    <div class="mb-2">
                      <div class="w-full h-1.5 bg-gray-700 rounded-full overflow-hidden">
                        <div
                          class={`h-full transition-all duration-100 ${
                            transfer.direction === "upload" ? "bg-orange-500" : "bg-[var(--color-primary)]"
                          }`}
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                    </div>
                  </Show>

                  {/* Stats */}
                  <div class="space-y-1">
                    <div class="flex items-center justify-between text-xs text-gray-500">
                      <span class="truncate max-w-[60%]" title={transfer.current_file || ""}>
                        {transfer.current_file
                          ? transfer.current_file.split('/').pop()
                          : transfer.status === "connecting" ? t().connect.transfer.connecting :
                            transfer.status === "negotiating" ? t().connect.transfer.negotiating :
                            `${transfer.files_done}/${transfer.files_total} ${t().connect.transfer.filesCount}`
                        }
                      </span>
                      <Show when={transfer.bytes_total > 0}>
                        <span class="flex-shrink-0">{progress}%</span>
                      </Show>
                    </div>
                    <Show when={isActive && transfer.status === "transferring"}>
                      <div class="flex items-center justify-between text-xs text-gray-400">
                        <span class="flex items-center gap-1">
                          <i class="i-hugeicons-chart-line-data-01 w-3 h-3" />
                          {transfer.speed_bps != null
                            ? formatSpeed(transfer.speed_bps)
                            : "—"
                          }
                        </span>
                        <span class="flex items-center gap-1">
                          {transfer.eta_seconds != null
                            ? formatEta(transfer.eta_seconds, props.t)
                            : "—"
                          }
                          <Show when={transfer.bytes_total > 0}>
                            <span class="text-gray-500 ml-1">
                              ({formatBytes(transfer.bytes_done)} / {formatBytes(transfer.bytes_total)})
                            </span>
                          </Show>
                        </span>
                      </div>
                    </Show>
                  </div>
                </div>
              );
            }}
          </For>

          {/* Clear completed button */}
          <Show when={props.transfers().some(t => t.status === "completed" || t.status === "failed" || t.status === "cancelled")}>
            <button
              class="w-full py-2 text-xs text-gray-500 hover:text-gray-300 transition-colors"
              onClick={props.onClearCompleted}
            >
              {t().connect.transfer.clearCompleted}
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
}
