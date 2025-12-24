import { createSignal } from "solid-js";
import { listen } from "@tauri-apps/api/event";

interface ModInstallInfo {
  modId: string; // format: "source:slug"
  instanceId: string;
  name: string;
  startedAt: number;
}

// Global state for mods currently being installed
const [installingMods, setInstallingMods] = createSignal<Map<string, ModInstallInfo>>(new Map());

// Track if we're listening to download events
let isListening = false;

/**
 * Initialize listeners for download-progress events
 * Call this once at app startup
 */
export async function initModInstallTracking() {
  if (isListening) return;
  isListening = true;

  // Listen for download completions to auto-cleanup stale entries
  await listen<{ id: string; status: string }>("download-progress", (event) => {
    const { id, status } = event.payload;

    // If download completed, cancelled, or failed - remove from installing
    if (status === "completed" || status === "cancelled" || status === "failed") {
      // Try to find and remove by matching download ID pattern
      setInstallingMods(prev => {
        const next = new Map(prev);
        // Download ID might contain the mod slug, try to match
        for (const [key, info] of next) {
          if (id.includes(info.modId.split(":")[1])) {
            next.delete(key);
            break;
          }
        }
        return next;
      });
    }
  });
}

/**
 * Mark a mod as currently being installed
 */
export function startModInstall(instanceId: string, slug: string, source: string, name: string) {
  const modId = `${source}:${slug}`;
  const key = `${instanceId}:${modId}`;

  setInstallingMods(prev => {
    const next = new Map(prev);
    next.set(key, {
      modId,
      instanceId,
      name,
      startedAt: Date.now(),
    });
    return next;
  });
}

/**
 * Mark a mod installation as complete
 */
export function completeModInstall(instanceId: string, slug: string, source: string) {
  const modId = `${source}:${slug}`;
  const key = `${instanceId}:${modId}`;

  setInstallingMods(prev => {
    const next = new Map(prev);
    next.delete(key);
    return next;
  });
}

/**
 * Check if a mod is currently being installed for an instance
 */
export function isModInstalling(instanceId: string, slug: string, source: string): boolean {
  const modId = `${source}:${slug}`;
  const key = `${instanceId}:${modId}`;
  return installingMods().has(key);
}

/**
 * Get all mods currently being installed for an instance
 */
export function getInstallingMods(instanceId: string): ModInstallInfo[] {
  return Array.from(installingMods().values())
    .filter(info => info.instanceId === instanceId);
}

/**
 * Get the raw signal for reactive access
 */
export function useInstallingMods() {
  return installingMods;
}

/**
 * Cleanup stale entries (older than 10 minutes)
 */
export function cleanupStaleEntries() {
  const staleThreshold = 10 * 60 * 1000; // 10 minutes
  const now = Date.now();

  setInstallingMods(prev => {
    const next = new Map(prev);
    for (const [key, info] of next) {
      if (now - info.startedAt > staleThreshold) {
        next.delete(key);
      }
    }
    return next;
  });
}
