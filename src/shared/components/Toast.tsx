import { createSignal, onMount, onCleanup, For, Show } from "solid-js";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { useI18n } from "../i18n";

export interface ToastData {
  id: string;
  type: "info" | "success" | "warning" | "error";
  title: string;
  message?: string;
  duration?: number;
  action?: {
    label: string;
    onClick: () => void;
  };
}

interface InternalToast extends ToastData {
  exiting?: boolean;
}

interface P2PNotification {
  type: string;
  title?: string;
  message?: string;
  peer_id?: string;
  peer_nickname?: string;
  modpack_name?: string;
  files_count?: number;
  total_size?: number;
}

interface TransferEvent {
  type: string;
  session_id?: string;
  session?: {
    id: string;
    peer_nickname?: string;
    direction: "upload" | "download";
    modpack_name?: string;
  };
  files_synced?: number;
  bytes_synced?: number;
  message?: string;
}

const [toasts, setToasts] = createSignal<InternalToast[]>([]);

// Track active timers to prevent memory leaks
const activeTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function addToast(toast: Omit<ToastData, "id">) {
  const id = crypto.randomUUID();
  setToasts(prev => [...prev, { ...toast, id, exiting: false }]);

  // Auto remove after duration
  const duration = toast.duration ?? 5000;
  if (duration > 0) {
    const timerId = setTimeout(() => {
      activeTimers.delete(id);
      removeToast(id);
    }, duration);
    activeTimers.set(id, timerId);
  }

  return id;
}

export function removeToast(id: string) {
  // Clear auto-remove timer if exists
  const existingTimer = activeTimers.get(id);
  if (existingTimer) {
    clearTimeout(existingTimer);
    activeTimers.delete(id);
  }

  // First mark as exiting for animation
  setToasts(prev => prev.map(t => t.id === id ? { ...t, exiting: true } : t));

  // Then actually remove after animation completes
  const exitTimerId = setTimeout(() => {
    activeTimers.delete(`exit-${id}`);
    setToasts(prev => prev.filter(t => t.id !== id));
  }, 150);
  activeTimers.set(`exit-${id}`, exitTimerId);
}

export function clearAllToasts() {
  // Clear all timers
  activeTimers.forEach(timer => clearTimeout(timer));
  activeTimers.clear();
  setToasts([]);
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

export function ToastProvider() {
  const { t } = useI18n();
  let unlistenP2P: UnlistenFn | null = null;
  let unlistenTransfer: UnlistenFn | null = null;

  onMount(async () => {
    // Listen for P2P events and show toasts
    unlistenP2P = await listen<P2PNotification>("p2p-notification", (event) => {
        const data = event.payload;
        const peerName = data.peer_nickname || data.peer_id?.slice(0, 8) || t().connect.anonymous;

        switch (data.type) {
          case "peer_discovered":
            addToast({
              type: "info",
              title: t().notifications.peerDiscovered,
              message: peerName,
              duration: 3000,
            });
            break;

          case "incoming_transfer_request":
            addToast({
              type: "warning",
              title: t().notifications.incomingRequest,
              message: `${peerName} - ${data.modpack_name}`,
              duration: 10000,
            });
            break;

          case "friend_request":
            addToast({
              type: "info",
              title: t().notifications.friendRequest,
              message: peerName,
              duration: 10000,
            });
            break;

          case "friend_added":
            addToast({
              type: "success",
              title: t().notifications.friendAdded,
              message: peerName,
              duration: 3000,
            });
            break;
        }
      });

      // Listen for transfer events
      unlistenTransfer = await listen<TransferEvent>("transfer-event", (event) => {
        const data = event.payload;

        switch (data.type) {
          case "completed":
            addToast({
              type: "success",
              title: t().notifications.transferCompleted,
              message: `${data.files_synced || 0} ${t().connect.transfer.filesCount} (${formatBytes(data.bytes_synced || 0)})`,
              duration: 5000,
            });
            break;

          case "error":
            addToast({
              type: "error",
              title: t().notifications.transferFailed,
              message: data.message,
              duration: 7000,
            });
            break;

          case "incoming_request":
            const session = data.session;
            if (session) {
              addToast({
                type: "warning",
                title: t().notifications.incomingRequest,
                message: `${session.peer_nickname || t().connect.anonymous} - ${session.modpack_name || ""}`,
                duration: 10000,
              });
            }
            break;

          case "friend_request":
            addToast({
              type: "info",
              title: t().notifications.friendRequest,
              message: (data as unknown as { nickname?: string }).nickname || t().connect.anonymous,
              duration: 10000,
            });
            break;
        }
      });
  });

  onCleanup(() => {
    if (unlistenP2P) unlistenP2P();
    if (unlistenTransfer) unlistenTransfer();
  });

  return (
    <div class="fixed bottom-4 right-4 z-[100] flex flex-col-reverse gap-2 max-w-sm pointer-events-none">
      <For each={toasts()}>
        {(toast) => (
          <div
            class={`pointer-events-auto p-4 rounded-xl shadow-lg border backdrop-blur-sm transition-all duration-150 ease-out ${
              toast.exiting
                ? "opacity-0 translate-x-full scale-95"
                : "opacity-100 translate-x-0 scale-100 animate-toast-in"
            } ${
              toast.type === "success" ? "bg-green-900/90 border-green-700" :
              toast.type === "error" ? "bg-red-900/90 border-red-700" :
              toast.type === "warning" ? "bg-amber-900/90 border-amber-700" :
              "bg-gray-850/90 border-gray-700"
            }`}
          >
            <div class="flex items-start gap-3">
              {/* Icon */}
              <div class={`flex-shrink-0 mt-0.5 w-5 h-5 ${
                toast.type === "success" ? "text-green-400 i-hugeicons-checkmark-circle-02" :
                toast.type === "error" ? "text-red-400 i-hugeicons-cancel-circle" :
                toast.type === "warning" ? "text-amber-400 i-hugeicons-alert-02" :
                "text-blue-400 i-hugeicons-information-circle"
              }`} />

              {/* Content */}
              <div class="flex-1 min-w-0">
                <p class="text-sm font-medium text-white">{toast.title}</p>
                <Show when={toast.message}>
                  <p class="text-xs text-gray-400 mt-0.5 break-words">{toast.message}</p>
                </Show>
                <Show when={toast.action}>
                  <button
                    class="btn-ghost btn-sm mt-2 text-blue-400"
                    onClick={toast.action!.onClick}
                  >
                    {toast.action!.label}
                  </button>
                </Show>
              </div>

              {/* Close button */}
              <button
                class="btn-ghost btn-sm flex-shrink-0 p-1 opacity-60 hover:opacity-100"
                onClick={() => removeToast(toast.id)}
              >
                <i class="i-hugeicons-cancel-01 w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </For>
    </div>
  );
}

export default ToastProvider;
