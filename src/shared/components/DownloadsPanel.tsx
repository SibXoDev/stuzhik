import { Show, For, createMemo } from "solid-js";
import { useDownloads } from "../hooks/useDownloads";
import { useI18n } from "../i18n";
import type { DownloadProgress } from "../types";

export default function DownloadsPanel() {
  const { t } = useI18n();
  const { downloads, activeDownloads, downloadsByInstance, totalSpeed, cancelDownload, isCancelling, setShowDownloadsPanel } = useDownloads();

  const formatSpeed = (bytesPerSec: number) => {
    if (bytesPerSec >= 1_000_000) {
      return `${(bytesPerSec / 1_000_000).toFixed(1)} MB/s`;
    }
    return `${(bytesPerSec / 1000).toFixed(0)} KB/s`;
  };

  const formatSize = (bytes: number) => {
    if (bytes >= 1_000_000) {
      return `${(bytes / 1_000_000).toFixed(1)} MB`;
    }
    return `${(bytes / 1000).toFixed(0)} KB`;
  };

  // Get sorted instance groups
  const instanceGroups = createMemo(() => {
    const { grouped, noInstance } = downloadsByInstance();
    const entries = Object.entries(grouped);
    return { entries, noInstance };
  });

  const onClose = () => setShowDownloadsPanel(false);

  return (
    <div class="fixed inset-0 z-50 pt-[var(--titlebar-height)] pb-4 px-4 flex items-center justify-center pointer-events-none">
      <div
        class="bg-gray-850 rounded-2xl shadow-2xl w-full max-w-lg max-h-full flex flex-col border border-gray-750 pointer-events-auto"
        onClick={(e) => e.stopPropagation()}
      >
      {/* Header */}
      <div class="flex items-center justify-between px-5 py-4 border-b border-gray-800">
        <div class="flex items-center gap-3">
          <div class="flex items-center justify-center w-9 h-9 bg-blue-600 rounded-2xl">
            <i class="i-hugeicons-download-02 w-5 h-5 text-white" />
          </div>
          <div>
            <h2 class="text-lg font-bold">{t().titleBar.downloads}</h2>
            <Show when={activeDownloads().length > 0}>
              <p class="text-xs text-gray-400">
                {activeDownloads().length} {t().common.loading.toLowerCase().replace("...", "")} • {formatSpeed(totalSpeed())}
              </p>
            </Show>
          </div>
        </div>
        <button
          class="btn-close"
          onClick={onClose}
        >
          <i class="i-hugeicons-cancel-01 w-5 h-5" />
        </button>
      </div>

      {/* Content */}
      <div class="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Empty state */}
        <Show when={downloads().length === 0}>
          <div class="flex-col-center py-12 text-center">
            <i class="i-hugeicons-checkmark-circle-02 w-16 h-16 text-green-500 mb-3" />
            <p class="text-muted">No active downloads</p>
          </div>
        </Show>

        {/* Downloads without instance */}
        <Show when={instanceGroups().noInstance.length > 0}>
          <div class="space-y-2">
            <h3 class="text-sm font-medium text-gray-400 px-1">General</h3>
            <For each={instanceGroups().noInstance}>
              {(download) => <DownloadItem download={download} onCancel={cancelDownload} isCancelling={isCancelling} formatSpeed={formatSpeed} formatSize={formatSize} />}
            </For>
          </div>
        </Show>

        {/* Downloads grouped by instance */}
        <For each={instanceGroups().entries}>
          {([instanceId, instanceDownloads]) => (
            <div class="space-y-2">
              <h3 class="text-sm font-medium text-gray-400 px-1 flex items-center gap-2">
                <i class="i-hugeicons-package w-4 h-4" />
                {instanceId}
                <span class="text-xs bg-gray-700 px-1.5 py-0.5 rounded">
                  {instanceDownloads.filter(d => d.status !== "completed" && d.status !== "cancelled" && d.status !== "failed").length}
                </span>
              </h3>
              <For each={instanceDownloads}>
                {(download) => <DownloadItem download={download} onCancel={cancelDownload} isCancelling={isCancelling} formatSpeed={formatSpeed} formatSize={formatSize} />}
              </For>
            </div>
          )}
        </For>
      </div>
      </div>
    </div>
  );
}

interface DownloadItemProps {
  download: DownloadProgress;
  onCancel: (operationId: string) => void;
  isCancelling: (operationId: string | null) => boolean;
  formatSpeed: (bytesPerSec: number) => string;
  formatSize: (bytes: number) => string;
}

function DownloadItem(props: DownloadItemProps) {
  const { download, onCancel, isCancelling, formatSpeed, formatSize } = props;

  const isCompleted = download.status === "completed";
  const isVerifying = download.status === "verifying";
  const isRequesting = download.status === "requesting";
  const isConnecting = download.status === "connecting";
  const isResuming = download.status === "resuming";
  const isCancelled = download.status === "cancelled";
  const isFailed = download.status === "failed";
  const isStalled = download.status === "stalled";
  const canCancel = !isCompleted && !isCancelled && !isFailed && !isRequesting && download.operation_id;
  const cancelling = () => isCancelling(download.operation_id);

  return (
    <div
      class={`p-3 rounded-2xl transition-colors ${
        isCompleted
          ? "bg-green-600/10 border border-green-600/30"
          : isCancelled || isFailed || isStalled
          ? "bg-red-600/10 border border-red-600/30"
          : isResuming
          ? "bg-cyan-600/10 border border-cyan-600/30"
          : "bg-gray-800/50"
      }`}
    >
      <div class="flex items-start gap-3">
        <div
          class={`flex-shrink-0 w-8 h-8 rounded-2xl flex-center ${
            isCompleted
              ? "bg-green-600"
              : isCancelled || isFailed || isStalled
              ? "bg-red-600"
              : isVerifying
              ? "bg-yellow-600"
              : isResuming
              ? "bg-cyan-600"
              : isRequesting || isConnecting
              ? "bg-purple-600"
              : "bg-blue-600"
          }`}
        >
          <Show
            when={isCompleted}
            fallback={
              <Show
                when={isCancelled || isFailed || isStalled}
                fallback={
                  <Show
                    when={isVerifying}
                    fallback={
                      <Show
                        when={isResuming}
                        fallback={
                          <Show
                            when={isRequesting || isConnecting}
                            fallback={<i class="i-hugeicons-download-02 w-4 h-4 text-white" />}
                          >
                            <i class="i-hugeicons-database w-4 h-4 text-white animate-pulse" />
                          </Show>
                        }
                      >
                        <i class="i-svg-spinners-ring-resize w-4 h-4 text-white" />
                      </Show>
                    }
                  >
                    <i class="i-hugeicons-checkmark-circle-02 w-4 h-4 text-white" />
                  </Show>
                }
              >
                <i class="i-hugeicons-cancel-01 w-4 h-4 text-white" />
              </Show>
            }
          >
            <i class="i-hugeicons-checkmark-circle-02 w-4 h-4 text-white" />
          </Show>
        </div>

        <div class="flex-1 min-w-0">
          <div class="flex items-center justify-between mb-1">
            <p class="text-sm font-medium truncate">{download.name}</p>
            <Show when={canCancel}>
              <button
                class="btn-ghost btn-sm p-1 hover:bg-red-600/20 text-gray-400 hover:text-red-400"
                onClick={() => download.operation_id && onCancel(download.operation_id)}
                disabled={cancelling()}
              >
                <Show when={cancelling()} fallback={<i class="i-hugeicons-cancel-01 w-4 h-4" />}>
                  <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                </Show>
              </button>
            </Show>
          </div>

          <Show when={!isCompleted && !isCancelled && !isFailed && !isStalled}>
            <div class="space-y-1">
              <div class="w-full h-1.5 bg-gray-900 rounded-full overflow-hidden">
                <div
                  class={`h-full transition-all duration-100 ${
                    isVerifying
                      ? "bg-yellow-500"
                      : isResuming
                      ? "bg-gradient-to-r from-cyan-600 to-blue-600"
                      : "bg-gradient-to-r from-blue-600 to-purple-600"
                  }`}
                  style={{ width: `${download.percentage}%` }}
                />
              </div>

              <div class="flex items-center justify-between text-xs">
                <span class="text-gray-400">
                  {isRequesting ? (
                    "Requesting..."
                  ) : isConnecting ? (
                    "Connecting..."
                  ) : isResuming ? (
                    "Resuming..."
                  ) : isVerifying ? (
                    "Verifying..."
                  ) : (
                    <>
                      {formatSize(download.downloaded)} / {formatSize(download.total)}
                    </>
                  )}
                </span>
                <Show when={download.speed > 0 && !isVerifying && !isRequesting && !isConnecting && !isResuming}>
                  <span class="text-gray-500">{formatSpeed(download.speed)}</span>
                </Show>
              </div>
            </div>
          </Show>

          <Show when={isCompleted}>
            <p class="text-xs text-green-400">{formatSize(download.total)}</p>
          </Show>

          <Show when={isCancelled}>
            <p class="text-xs text-red-400">Cancelled</p>
          </Show>

          <Show when={isFailed}>
            <p class="text-xs text-red-400">Failed</p>
          </Show>

          <Show when={isStalled}>
            <p class="text-xs text-red-400">Stalled (will resume)</p>
          </Show>
        </div>
      </div>
    </div>
  );
}
