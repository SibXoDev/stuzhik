import { createSignal, onMount, createMemo } from "solid-js";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { DownloadProgress } from "../types";
import { updateActiveDownloads } from "../stores";

// Global state for downloads (singleton pattern)
const [downloads, setDownloads] = createSignal<DownloadProgress[]>([]);
const [cancellingIds, setCancellingIds] = createSignal<Set<string>>(new Set());
const [showDownloadsPanel, setShowDownloadsPanel] = createSignal(false);
let listenerInitialized = false;

// Track active timers for cleanup
const activeTimers = new Set<ReturnType<typeof setTimeout>>();

// Track cancelled operation IDs to reject late progress events (race condition fix)
const cancelledOperationIds = new Set<string>();

// Sync active downloads count - called explicitly when downloads change
function syncActiveDownloadsCount() {
  const activeCount = downloads().filter(d =>
    d.status !== "completed" && d.status !== "cancelled" && d.status !== "failed"
  ).length;
  updateActiveDownloads(activeCount);
}

// Track multiple unlisten functions
let unlistenFns: (() => void)[] = [];

/**
 * Initialize download listener (should be called once at app startup)
 */
export function initDownloadListener() {
  if (listenerInitialized) return;
  listenerInitialized = true;

  listen<DownloadProgress>("download-progress", (event) => {
    const progress = event.payload;

    // Reject late progress events from cancelled operations (race condition fix)
    // Don't add NEW downloads for cancelled operations, but allow terminal states through
    // for existing entries so they get cleaned up properly
    if (progress.operation_id && cancelledOperationIds.has(progress.operation_id)) {
      const isTerminal = progress.status === "completed" || progress.status === "cancelled" || progress.status === "failed" || progress.status === "stalled";
      const existsInList = downloads().some(d => d.id === progress.id);
      if (!isTerminal && !existsInList) {
        return; // Ignore new non-terminal events from cancelled operations
      }
    }

    // Infer source from download name if not explicitly set
    if (!progress.source) {
      const name = (progress.name || "").toLowerCase();
      const id = (progress.id || "").toLowerCase();
      if (name.includes("modrinth") || id.includes("modrinth")) {
        progress.source = "modrinth";
      } else if (name.includes("curseforge") || name.includes("forgecdn") || id.includes("curseforge")) {
        progress.source = "curseforge";
      }
    }

    setDownloads(prev => {
      const existing = prev.findIndex(p => p.id === progress.id);
      if (existing >= 0) {
        const updated = [...prev];
        // Preserve source from earlier events if new event doesn't have one
        if (!progress.source && updated[existing].source) {
          progress.source = updated[existing].source;
        }
        updated[existing] = progress;

        // Remove completed, cancelled, failed, stalled after delay
        if (progress.status === "completed" || progress.status === "cancelled" || progress.status === "failed" || progress.status === "stalled") {
          const delay = progress.status === "failed" ? 10000 : 3000;
          const timerId = setTimeout(() => {
            activeTimers.delete(timerId);
            setDownloads(p => p.filter(item => item.id !== progress.id));
            if (progress.operation_id) {
              setCancellingIds(prev => {
                const next = new Set(prev);
                next.delete(progress.operation_id!);
                return next;
              });
            }
            syncActiveDownloadsCount();
          }, delay);
          activeTimers.add(timerId);
        }

        return updated;
      } else {
        return [...prev, progress];
      }
    });

    // Sync count after update
    syncActiveDownloadsCount();
  }).then(fn => {
    unlistenFns.push(fn);
  }).catch((e) => {
    if (import.meta.env.DEV) console.error("[useDownloads] Failed to register download-progress listener:", e);
  });

  // Listen for operation cancellation to clean up stale download entries
  // When tokio::select! drops in-flight futures, no individual "cancelled" events
  // are emitted — this handler marks those orphaned downloads as cancelled
  listen<{ id: string }>("operation-cancelled", (event) => {
    const opId = event.payload.id;

    // Track cancelled operation to reject late progress events
    cancelledOperationIds.add(opId);
    // Auto-cleanup after 30s to prevent unbounded growth
    setTimeout(() => cancelledOperationIds.delete(opId), 30000);

    setDownloads(prev => {
      let changed = false;
      const updated = prev.map(d => {
        // Match by operation_id (group cancel) OR by download id (individual cancel)
        const isMatch = (d.operation_id === opId) || (d.id === opId);
        if (isMatch && d.status !== "completed" && d.status !== "cancelled" && d.status !== "failed") {
          changed = true;
          return { ...d, status: "cancelled" };
        }
        return d;
      });

      if (!changed) return prev;

      // Schedule removal of cancelled entries
      for (const d of updated) {
        const isMatch = (d.operation_id === opId) || (d.id === opId);
        if (isMatch && d.status === "cancelled") {
          const timerId = setTimeout(() => {
            activeTimers.delete(timerId);
            setDownloads(p => p.filter(item => item.id !== d.id));
            syncActiveDownloadsCount();
          }, 3000);
          activeTimers.add(timerId);
        }
      }

      return updated;
    });

    // Clean up cancelling state
    setCancellingIds(prev => {
      const next = new Set(prev);
      next.delete(opId);
      return next;
    });

    syncActiveDownloadsCount();
  }).then(fn => {
    unlistenFns.push(fn);
  }).catch((e) => {
    if (import.meta.env.DEV) console.error("[useDownloads] Failed to register operation-cancelled listener:", e);
  });
}

/**
 * Cleanup download listener (call on app unmount)
 */
export function cleanupDownloadListener() {
  // Block new registrations FIRST to prevent race with concurrent initDownloadListener()
  listenerInitialized = false;

  // Clear all pending timers
  for (const timerId of activeTimers) {
    clearTimeout(timerId);
  }
  activeTimers.clear();

  for (const fn of unlistenFns) {
    fn();
  }
  unlistenFns = [];
  cancelledOperationIds.clear();
}

/**
 * Cancel a download by operation ID
 */
export async function cancelDownload(operationId: string) {
  if (!operationId || cancellingIds().has(operationId)) return;

  setCancellingIds(prev => new Set([...prev, operationId]));
  try {
    await invoke("cancel_operation", { operationId });
  } catch (e) {
    if (import.meta.env.DEV) console.error("Failed to cancel operation:", e);
  }
}

/**
 * Hook to access download state
 */
export function useDownloads() {
  // Initialize listener on first use
  onMount(() => {
    initDownloadListener();
  });

  const activeDownloads = createMemo(() =>
    downloads().filter(d =>
      d.status !== "completed" && d.status !== "cancelled" && d.status !== "failed"
    )
  );

  const downloadsByInstance = createMemo(() => {
    const grouped: Record<string, DownloadProgress[]> = {};
    const noInstance: DownloadProgress[] = [];

    for (const download of downloads()) {
      if (download.instance_id) {
        if (!grouped[download.instance_id]) {
          grouped[download.instance_id] = [];
        }
        grouped[download.instance_id].push(download);
      } else {
        noInstance.push(download);
      }
    }

    return { grouped, noInstance };
  });

  const totalSpeed = createMemo(() =>
    activeDownloads().reduce((sum, d) => sum + d.speed, 0)
  );

  const overallProgress = createMemo(() => {
    const active = activeDownloads();
    if (active.length === 0) return 100;
    const totalDownloaded = active.reduce((sum, d) => sum + d.downloaded, 0);
    const totalSize = active.reduce((sum, d) => sum + d.total, 0);
    if (totalSize === 0) return 0;
    return Math.round((totalDownloaded / totalSize) * 100);
  });

  const isCancelling = (operationId: string | null) =>
    operationId ? cancellingIds().has(operationId) : false;

  return {
    downloads,
    activeDownloads,
    downloadsByInstance,
    totalSpeed,
    overallProgress,
    cancelDownload,
    isCancelling,
    showDownloadsPanel,
    setShowDownloadsPanel,
  };
}
