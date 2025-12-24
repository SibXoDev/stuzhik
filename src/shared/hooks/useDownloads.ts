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
let unlistenFn: (() => void) | null = null;

// Track active timers for cleanup
const activeTimers = new Set<ReturnType<typeof setTimeout>>();

// Sync active downloads count - called explicitly when downloads change
function syncActiveDownloadsCount() {
  const activeCount = downloads().filter(d =>
    d.status !== "completed" && d.status !== "cancelled" && d.status !== "failed"
  ).length;
  updateActiveDownloads(activeCount);
}

/**
 * Initialize download listener (should be called once at app startup)
 */
export function initDownloadListener() {
  if (listenerInitialized) return;
  listenerInitialized = true;

  listen<DownloadProgress>("download-progress", (event) => {
    const progress = event.payload;

    setDownloads(prev => {
      const existing = prev.findIndex(p => p.id === progress.id);
      if (existing >= 0) {
        const updated = [...prev];
        updated[existing] = progress;

        // Remove completed, cancelled, failed after delay
        if (progress.status === "completed" || progress.status === "cancelled" || progress.status === "failed") {
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
    unlistenFn = fn;
  });
}

/**
 * Cleanup download listener (call on app unmount)
 */
export function cleanupDownloadListener() {
  // Clear all pending timers
  for (const timerId of activeTimers) {
    clearTimeout(timerId);
  }
  activeTimers.clear();

  if (unlistenFn) {
    unlistenFn();
    unlistenFn = null;
    listenerInitialized = false;
  }
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
    console.error("Failed to cancel operation:", e);
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
