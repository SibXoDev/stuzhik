import { createSignal, createEffect, onCleanup, createMemo } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Mod, ModConflict, ConflictPredictionResult, ModRecommendation, ModSearchParams, ModSearchResponse, ModSearchResult, ModSource, UpdateCheckResult } from "../../../shared/types";
import { addToast } from "../../../shared/components/Toast";

interface SyncResult {
  added: number;
  removed: number;
  skipped?: boolean;
  new_mod_ids?: number[];
}

interface EnrichmentResult {
  total_mods: number;
  enriched_mods: number;
  dependencies_added: number;
}

interface ModVerifyResult {
  file_name: string;
  verified: boolean;
  platform: string;
  status: "verified" | "modified" | "unknown"; // verified=exact match, modified=hash mismatch, unknown=not found
  project_name: string | null;
  project_id: string | null;
  version: string | null;
  icon_url: string | null;
}

interface VerificationProgress {
  instance_id: string;
  stage: string;  // "scanning", "hashing", "modrinth_lookup", "curseforge_lookup", "icons", "fallback_search", "saving", "done"
  current: number;
  total: number;
  message: string;
}

// ============================================================================
// GLOBAL STATE - minimal, only to prevent concurrent initialization
// ============================================================================

/** Active initialization promises to prevent concurrent init */
const activeInit = new Map<string, Promise<void>>();

/** Track which instance was last initialized to avoid redundant loads */
let lastInitializedId: string | null = null;

// ============================================================================
// MAIN HOOK
// ============================================================================

export function useMods(instanceId: () => string) {
  const [mods, setMods] = createSignal<Mod[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [syncing, setSyncing] = createSignal(false);
  const [enriching, setEnriching] = createSignal(false);
  const [verifying, setVerifying] = createSignal(false);
  const [resolvingDeps, setResolvingDeps] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [conflicts, setConflicts] = createSignal<ModConflict[]>([]);
  const [predictionLoading, setPredictionLoading] = createSignal(false);
  const [checkingUpdates, setCheckingUpdates] = createSignal(false);
  const [lastUpdateCheck, setLastUpdateCheck] = createSignal<UpdateCheckResult | null>(null);

  // Verification progress - local state for UI feedback during verification
  const [verificationProgress, setVerificationProgress] = createSignal<VerificationProgress | null>(null);

  // Derive verification status directly from mod.source (data is persisted in DB by backend)
  // This is reactive: when mods() updates, these values update automatically
  const getVerificationStatus = (mod: Mod): "verified" | "modified" | "unknown" => {
    // If source is modrinth or curseforge with source_id, it's verified
    if ((mod.source === "modrinth" || mod.source === "curseforge") && mod.source_id) {
      return "verified";
    }
    // Local mods are unknown
    return "unknown";
  };

  // Count verified mods (reactive)
  const verifiedCount = createMemo(() => {
    return mods().filter(m => getVerificationStatus(m) === "verified").length;
  });

  // Count unverified mods (reactive)
  const unverifiedCount = createMemo(() => {
    return mods().filter(m => getVerificationStatus(m) === "unknown").length;
  });

  // Listen for verification progress events
  const unlistenPromise = listen<VerificationProgress>("verification-progress", (event) => {
    const progress = event.payload;
    // Only update if event is for our instance
    if (progress.instance_id === instanceId()) {
      setVerificationProgress(progress);
    }
  });

  // Cleanup listener on unmount
  onCleanup(() => {
    unlistenPromise.then(unlisten => unlisten());
  });

  // ============================================================================
  // CORE OPERATIONS
  // ============================================================================

  /**
   * Load mods from database (always runs, shows current state)
   */
  async function loadMods(): Promise<void> {
    const id = instanceId();
    if (!id) return;

    try {
      setLoading(true);
      setError(null);
      const items = await invoke<Mod[]>("list_mods", { instanceId: id });
      setMods(items);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to load mods:", e);
    } finally {
      setLoading(false);
    }
  }

  /**
   * Sync mods folder with database
   * Backend has mtime cache - skips if folder unchanged
   */
  async function syncMods(): Promise<SyncResult | null> {
    const id = instanceId();
    if (!id) return null;

    try {
      setSyncing(true);
      const result = await invoke<SyncResult>("sync_mods_folder", { instanceId: id });
      return result;
    } catch (e: unknown) {
      console.error("Failed to sync mods:", e);
      return null;
    } finally {
      setSyncing(false);
    }
  }

  /**
   * Check dependencies (fast, uses data already in DB)
   */
  async function checkDependencies(): Promise<void> {
    const id = instanceId();
    if (!id) return;

    try {
      const result = await invoke<ModConflict[]>("check_mod_dependencies", { instanceId: id });
      setConflicts(result);
    } catch (e: unknown) {
      console.error("Failed to check dependencies:", e);
    }
  }

  /**
   * Enrich mod data from APIs (Modrinth/CurseForge)
   * Backend has hash-based cache - skips if mods unchanged since last enrichment
   * @param showIndicator - whether to show loading indicator (false for background checks)
   * @returns true if enrichment actually ran (not skipped), false otherwise
   */
  async function enrichDependencies(showIndicator: boolean = false): Promise<boolean> {
    const id = instanceId();
    if (!id) return false;

    try {
      // Only show indicator if explicitly requested (e.g., force refresh)
      // Background checks should be silent
      if (showIndicator) {
        setEnriching(true);
      }
      const result = await invoke<EnrichmentResult>("enrich_mod_dependencies", { instanceId: id });
      // If enrichment ran (not skipped), reload mods to get updated data
      if (result.enriched_mods > 0) {
        await loadMods();
        return true; // Enrichment did work
      }
      return false; // Enrichment was skipped (hash unchanged)
    } catch (e: unknown) {
      // Non-critical - data still usable without enrichment
      console.debug("Enrichment failed (non-critical):", e);
      return false;
    } finally {
      if (showIndicator) {
        setEnriching(false);
      }
    }
  }

  /**
   * Verify mods authenticity
   * Backend updates mods table with source/source_id - data is persisted in DB
   * @param showNotification - whether to show notification after completion
   */
  async function verifyMods(showNotification: boolean = false): Promise<void> {
    const id = instanceId();
    if (!id) return;

    try {
      setVerifying(true);
      setVerificationProgress(null); // Reset progress before starting
      const results = await invoke<ModVerifyResult[]>("verify_instance_mods", { instanceId: id });

      // Backend has updated mods table - reload to get fresh data with source/source_id
      await loadMods();

      // Show notification if requested (e.g., after force refresh)
      if (showNotification && results.length > 0) {
        const verified = results.filter(r => r.status === "verified").length;
        const modified = results.filter(r => r.status === "modified").length;
        const unknown = results.filter(r => r.status === "unknown").length;

        if (modified === 0 && unknown === 0) {
          addToast({
            type: "success",
            title: "Проверка завершена",
            message: `Все ${verified} модов подтверждены`,
            duration: 4000,
          });
        } else {
          addToast({
            type: "warning",
            title: "Проверка завершена",
            message: `${verified} подтверждено, ${modified} изменено, ${unknown} неизвестно`,
            duration: 5000,
          });
        }
      }
    } catch (e: unknown) {
      console.debug("Verification failed (non-critical):", e);
    } finally {
      setVerifying(false);
      setVerificationProgress(null); // Clear progress when done
    }
  }

  /**
   * Check for available mod updates from Modrinth/CurseForge
   * @param minecraftVersion - Minecraft version of the instance
   * @param loader - Mod loader type (fabric, forge, neoforge, quilt)
   * @param showNotification - whether to show notification after completion
   */
  async function checkModUpdates(
    minecraftVersion: string,
    loader: string,
    showNotification: boolean = true
  ): Promise<UpdateCheckResult | null> {
    const id = instanceId();
    if (!id) return null;

    try {
      setCheckingUpdates(true);
      const result = await invoke<UpdateCheckResult>("check_mod_updates", {
        instanceId: id,
        minecraftVersion,
        loader,
      });

      setLastUpdateCheck(result);

      // Reload mods to get updated update_available flags
      await loadMods();

      // Show notification if requested
      if (showNotification) {
        if (result.updates_available > 0) {
          addToast({
            type: "info",
            title: "Доступны обновления",
            message: `${result.updates_available} модов можно обновить`,
            duration: 5000,
          });
        } else if (result.total_checked > 0) {
          addToast({
            type: "success",
            title: "Проверка завершена",
            message: "Все моды актуальны",
            duration: 3000,
          });
        }
      }

      return result;
    } catch (e: unknown) {
      console.error("Failed to check mod updates:", e);
      if (showNotification) {
        addToast({
          type: "error",
          title: "Ошибка проверки",
          message: "Не удалось проверить обновления",
          duration: 4000,
        });
      }
      return null;
    } finally {
      setCheckingUpdates(false);
    }
  }

  /**
   * Get count of mods with available updates
   */
  function getUpdatableCount(): number {
    return mods().filter(m => m.update_available).length;
  }

  /**
   * Get list of mods that have updates available
   */
  function getModsWithUpdates(): Mod[] {
    return mods().filter(m => m.update_available);
  }

  /**
   * Clear update cache and force re-check updates
   */
  async function forceCheckUpdates(
    minecraftVersion: string,
    loader: string
  ): Promise<UpdateCheckResult | null> {
    const id = instanceId();
    if (!id) return null;

    try {
      // First clear the cache
      await invoke("clear_update_cache", { instanceId: id });
      // Then check updates
      return await checkModUpdates(minecraftVersion, loader, true);
    } catch (e) {
      console.error("Failed to force check updates:", e);
      return null;
    }
  }

  /**
   * Clean up duplicate mods from the database
   */
  async function cleanupDuplicates(): Promise<number> {
    const id = instanceId();
    if (!id) return 0;

    try {
      const removed = await invoke<number>("cleanup_duplicate_mods", { instanceId: id });
      if (removed > 0) {
        addToast({
          type: "success",
          title: "Дубликаты удалены",
          message: `Удалено ${removed} дубликатов из базы данных`,
          duration: 4000,
        });
        // Reload mods after cleanup
        await loadMods();
      }
      return removed;
    } catch (e) {
      console.error("Failed to cleanup duplicates:", e);
      return 0;
    }
  }

  // ============================================================================
  // INITIALIZATION PIPELINE
  // ============================================================================

  /**
   * Main initialization - runs when instance is opened
   *
   * Pipeline:
   * 1. Sync folder with DB (backend caches by mtime)
   * 2. Load mods from DB
   * 3. Background: enrich (backend caches by file hashes) + verify
   * 4. Check dependencies after enrichment
   */
  async function initializeMods(): Promise<void> {
    const id = instanceId();
    if (!id) return;

    // Prevent concurrent initialization
    const existingInit = activeInit.get(id);
    if (existingInit) {
      await existingInit;
      return;
    }

    // Always sync folder first - it's fast when unchanged (mtime cache)
    // This ensures we detect file changes even when tab is already open
    const initPromise = (async () => {
      try {
        // Step 1: Sync folder (backend has mtime cache - skips if unchanged)
        const syncResult = await syncMods();

        // Step 2: Load mods from DB
        await loadMods();

        // Fast path: if sync was skipped and we already initialized, skip background tasks
        const alreadyInitialized = lastInitializedId === id;
        lastInitializedId = id;

        // ALWAYS load conflicts from DB - signal state is lost on component remount
        // even if lastInitializedId matches (module-level var persists, but signal doesn't)
        checkDependencies();

        if (alreadyInitialized && syncResult?.skipped) {
          // Already initialized and no changes - skip enrichment/verification
          // but conflicts were already loaded above
          return;
        }

        // Step 4: Background tasks (don't block UI)
        // Backend handles caching - enrichment skips if hashes unchanged
        Promise.all([
          enrichDependencies(),
          verifyMods(),
        ]).then(([enrichmentDidWork]) => {
          // Only re-check dependencies if enrichment actually did work
          // This avoids redundant DB queries when hash unchanged
          if (enrichmentDidWork) {
            checkDependencies();
          }
        }).catch(() => {});
      } finally {
        activeInit.delete(id);
      }
    })();

    activeInit.set(id, initPromise);
    await initPromise;
  }

  /**
   * Force full refresh (manual action by user)
   * Clears backend caches and re-runs everything
   */
  async function forceSync(): Promise<void> {
    const id = instanceId();
    if (!id) return;

    lastInitializedId = null;

    try {
      setSyncing(true);

      // Step 1: Re-sync folder
      await syncMods();
      await loadMods();

      setSyncing(false);
      setEnriching(true);

      // Step 2: Force enrichment - clears hash cache and re-fetches from API
      await invoke<EnrichmentResult>("force_enrich_mod_dependencies", { instanceId: id });
      await loadMods(); // Reload after enrichment

      setEnriching(false);
      setVerifying(true);

      // Step 3: Verify and check dependencies (show notification for force refresh)
      await verifyMods(true);
      await checkDependencies();
    } catch (e) {
      console.error("Force sync failed:", e);
    } finally {
      setSyncing(false);
      setEnriching(false);
      setVerifying(false);
      lastInitializedId = id;
    }
  }

  // ============================================================================
  // MOD OPERATIONS (install, remove, toggle, update)
  // ============================================================================

  async function installMod(
    slug: string,
    source: string,
    minecraftVersion: string,
    loader: string,
    versionId?: string
  ): Promise<Mod | null> {
    try {
      setLoading(true);
      setError(null);

      const mod = await invoke<Mod>("install_mod", {
        instanceId: instanceId(),
        slug,
        source,
        minecraftVersion,
        loader,
        versionId: versionId || null,
      });

      // Update local state immediately
      setMods(prev => [...prev, mod]);

      // Check dependencies (important after install)
      await checkDependencies();

      return mod;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to install mod:", e);
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function installLocalMod(filePath: string, analyze: boolean = true): Promise<Mod | null> {
    try {
      setLoading(true);
      setError(null);

      const mod = await invoke<Mod>("install_mod_local", {
        instanceId: instanceId(),
        filePath,
        analyze,
      });

      setMods(prev => [...prev, mod]);
      await checkDependencies();

      return mod;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to install local mod:", e);
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function toggleMod(modId: number, enabled: boolean): Promise<void> {
    try {
      setError(null);
      await invoke("toggle_mod", {
        instanceId: instanceId(),
        modId,
        enabled,
      });

      setMods(prev =>
        prev.map(mod =>
          mod.id === modId ? { ...mod, enabled } : mod
        )
      );

      // Dependencies may change when mod is toggled
      await checkDependencies();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to toggle mod:", e);
    }
  }

  async function removeMod(modId: number): Promise<void> {
    try {
      setError(null);
      await invoke("remove_mod", {
        instanceId: instanceId(),
        modId,
      });

      setMods(prev => prev.filter(mod => mod.id !== modId));
      await checkDependencies();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to remove mod:", e);
    }
  }

  async function updateMod(modId: number): Promise<void> {
    try {
      setLoading(true);
      setError(null);
      await invoke("update_mod", {
        instanceId: instanceId(),
        modId,
      });

      // Reload mods to get updated data
      await loadMods();
      await checkDependencies();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to update mod:", e);
    } finally {
      setLoading(false);
    }
  }

  // ============================================================================
  // BULK OPERATIONS
  // ============================================================================

  async function bulkToggleMods(modIds: number[], enabled: boolean): Promise<number[]> {
    try {
      setError(null);
      const toggledIds = await invoke<number[]>("bulk_toggle_mods", {
        instanceId: instanceId(),
        modIds,
        enabled,
      });

      setMods(prev =>
        prev.map(mod =>
          toggledIds.includes(mod.id) ? { ...mod, enabled } : mod
        )
      );

      await checkDependencies();
      return toggledIds;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to bulk toggle mods:", e);
      return [];
    }
  }

  async function bulkRemoveMods(modIds: number[]): Promise<number[]> {
    try {
      setError(null);
      const removedIds = await invoke<number[]>("bulk_remove_mods", {
        instanceId: instanceId(),
        modIds,
      });

      setMods(prev => prev.filter(mod => !removedIds.includes(mod.id)));
      await checkDependencies();
      return removedIds;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to bulk remove mods:", e);
      return [];
    }
  }

  async function bulkToggleAutoUpdate(modIds: number[], autoUpdate: boolean): Promise<number[]> {
    try {
      setError(null);
      const toggledIds = await invoke<number[]>("bulk_toggle_auto_update", {
        instanceId: instanceId(),
        modIds,
        autoUpdate,
      });

      setMods(prev =>
        prev.map(mod =>
          toggledIds.includes(mod.id) ? { ...mod, auto_update: autoUpdate } : mod
        )
      );

      return toggledIds;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to bulk toggle auto update:", e);
      return [];
    }
  }

  // ============================================================================
  // DEPENDENCY RESOLUTION
  // ============================================================================

  async function resolveDependencies(modSlugs: string[]): Promise<void> {
    const id = instanceId();
    if (!id || modSlugs.length === 0) return;

    try {
      setResolvingDeps(true);
      setError(null);
      await invoke("resolve_dependencies", {
        instanceId: id,
        modSlugs,
      });

      // Reload mods after dependencies resolved
      await loadMods();
      await checkDependencies();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to resolve dependencies:", e);
    } finally {
      setResolvingDeps(false);
    }
  }

  async function toggleModAutoUpdate(modId: number, autoUpdate: boolean): Promise<void> {
    try {
      setError(null);
      await invoke("toggle_mod_auto_update", {
        instanceId: instanceId(),
        modId,
        autoUpdate,
      });

      setMods(prev =>
        prev.map(mod =>
          mod.id === modId ? { ...mod, auto_update: autoUpdate } : mod
        )
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to toggle mod auto update:", e);
    }
  }

  async function autoResolveDependencies(minecraftVersion: string, loader: string): Promise<void> {
    const id = instanceId();
    if (!id) return;

    try {
      setResolvingDeps(true);
      setError(null);
      await invoke("auto_resolve_dependencies", {
        instanceId: id,
        minecraftVersion,
        loader,
      });

      // Reload mods after dependencies resolved
      await loadMods();
      await checkDependencies();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to auto resolve dependencies:", e);
    } finally {
      setResolvingDeps(false);
    }
  }

  // ============================================================================
  // CONFLICT PREDICTION
  // ============================================================================

  async function predictConflicts(modSlug: string, source: string): Promise<ConflictPredictionResult | null> {
    const id = instanceId();
    if (!id) return null;

    try {
      setPredictionLoading(true);
      const result = await invoke<ConflictPredictionResult>("predict_mod_conflicts", {
        instanceId: id,
        modSlug,
        source,
      });
      return result;
    } catch (e: unknown) {
      console.error("Failed to predict conflicts:", e);
      return null;
    } finally {
      setPredictionLoading(false);
    }
  }

  // ============================================================================
  // SEARCH
  // ============================================================================

  async function searchMods(params: ModSearchParams): Promise<ModSearchResponse | null> {
    try {
      const response = await invoke<ModSearchResponse>("search_mods", { params });
      return response;
    } catch (e: unknown) {
      console.error("Failed to search mods:", e);
      return null;
    }
  }

  async function getModDetails(slug: string, source: ModSource): Promise<ModSearchResult | null> {
    try {
      const result = await invoke<ModSearchResult>("get_mod_details", { slug, source });
      return result;
    } catch (e: unknown) {
      console.error("Failed to get mod details:", e);
      return null;
    }
  }

  // ============================================================================
  // RECOMMENDATIONS
  // ============================================================================

  /**
   * @deprecated Use useModRecommendations hook instead - this function requires minecraftVersion and loader
   * which are not available in useMods context. Returns empty array.
   */
  async function getRecommendations(): Promise<ModRecommendation[]> {
    if (import.meta.env.DEV) {
      console.warn("getRecommendations() is deprecated. Use useModRecommendations hook instead.");
    }
    return [];
  }

  // ============================================================================
  // REACTIVE INITIALIZATION + FILE WATCHER
  // ============================================================================

  // Track watcher state
  let watcherStarted = false;
  let folderChangeUnlisten: (() => void) | null = null;

  /**
   * Handle mods folder changes from backend file watcher
   */
  async function handleFolderChange(event: { payload: { instance_id: string; event_type: string; file_name: string } }): Promise<void> {
    const id = instanceId();
    if (!id || event.payload.instance_id !== id) return;

    // Skip if currently syncing or other operations in progress
    if (syncing() || enriching() || verifying() || loading()) return;

    if (import.meta.env.DEV) {
      console.log(`[useMods] File watcher: ${event.payload.event_type} - ${event.payload.file_name}`);
    }

    // Reload mods list after folder change
    await loadMods();
    await checkDependencies();
  }

  /**
   * Start file watcher for mods folder (uses Rust notify crate)
   */
  async function startWatcher(): Promise<void> {
    const id = instanceId();
    if (!id || watcherStarted) return;

    try {
      // Start backend watcher
      await invoke("start_mods_watcher", { instanceId: id });
      watcherStarted = true;

      // Listen for folder change events
      const unlisten = await listen("mods_folder_changed", handleFolderChange);
      folderChangeUnlisten = unlisten;

      if (import.meta.env.DEV) {
        console.log(`[useMods] File watcher started for ${id}`);
      }
    } catch (e) {
      // Non-critical - mods still work without watcher
      if (import.meta.env.DEV) {
        console.warn(`[useMods] Failed to start file watcher:`, e);
      }
    }
  }

  /**
   * Stop file watcher
   */
  async function stopWatcher(): Promise<void> {
    const id = instanceId();
    if (!watcherStarted) return;

    try {
      if (id) {
        await invoke("stop_mods_watcher", { instanceId: id });
      }
      if (folderChangeUnlisten) {
        folderChangeUnlisten();
        folderChangeUnlisten = null;
      }
      watcherStarted = false;

      if (import.meta.env.DEV) {
        console.log(`[useMods] File watcher stopped`);
      }
    } catch {
      // Ignore stop errors
    }
  }

  createEffect(() => {
    const id = instanceId();
    if (id) {
      initializeMods();
      startWatcher();
    } else {
      stopWatcher();
    }
  });

  // Cleanup on unmount
  onCleanup(() => {
    stopWatcher();
  });

  return {
    // State
    mods,
    loading,
    syncing,
    enriching,
    verifying,
    resolvingDeps,
    error,
    conflicts,
    predictionLoading,
    verificationProgress,
    checkingUpdates,
    lastUpdateCheck,

    // Verification helpers (derive from mod.source - data is in DB)
    getVerificationStatus,
    verifiedCount,
    unverifiedCount,

    // Actions
    loadMods,
    syncMods,
    forceSync,
    installMod,
    installLocalMod,
    toggleMod,
    removeMod,
    updateMod,
    bulkToggleMods,
    bulkRemoveMods,
    bulkToggleAutoUpdate,
    toggleModAutoUpdate,
    resolveDependencies,
    autoResolveDependencies,
    checkDependencies,
    predictConflicts,
    searchMods,
    getModDetails,
    getRecommendations,
    checkModUpdates,
    forceCheckUpdates,
    getUpdatableCount,
    getModsWithUpdates,
    cleanupDuplicates,
  };
}

// ============================================================================
// STANDALONE HOOKS
// ============================================================================

/**
 * Hook for searching mods (used in ModsBrowser)
 */
export function useModSearch() {
  const [results, setResults] = createSignal<ModSearchResult[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [totalHits, setTotalHits] = createSignal(0);

  async function search(
    query: string,
    minecraftVersion?: string,
    loader?: string,
    source?: ModSource,
    limit?: number,
    offset?: number,
    mode?: string,
    sort?: string
  ): Promise<void> {
    try {
      setLoading(true);
      setError(null);
      // Backend expects individual parameters, not an object
      const response = await invoke<ModSearchResponse>("search_mods", {
        query,
        minecraftVersion: minecraftVersion || null,
        loader: loader || null,
        source: source || "modrinth",
        limit: limit || 20,
        offset: offset || 0,
        searchMode: mode || null,
        index: sort || null,
      });
      setResults(response.hits);
      setTotalHits(response.total_hits);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setResults([]);
      setTotalHits(0);
    } finally {
      setLoading(false);
    }
  }

  return {
    results,
    loading,
    error,
    totalHits,
    search,
  };
}

/**
 * Hook for mod recommendations (used in ModRecommendations)
 */
export function useModRecommendations(
  instanceId: () => string,
  minecraftVersion?: () => string,
  loader?: () => string
) {
  const [recommendations, setRecommendations] = createSignal<ModRecommendation[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function loadRecommendations(limit: number = 10): Promise<void> {
    const id = instanceId();
    const mcVersion = minecraftVersion?.();
    const loaderType = loader?.();

    if (!id || !mcVersion || !loaderType) {
      // Cannot get recommendations without version and loader info
      return;
    }

    try {
      setLoading(true);
      setError(null);
      const recs = await invoke<ModRecommendation[]>("get_mod_recommendations", {
        instanceId: id,
        minecraftVersion: mcVersion,
        loader: loaderType,
        limit,
      });
      setRecommendations(recs);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setRecommendations([]);
    } finally {
      setLoading(false);
    }
  }

  function getReasonText(reason: ModRecommendation["reason"]): string {
    switch (reason.type) {
      case "same_category":
        return `Категория: ${reason.category}`;
      case "popular_with":
        return `Популярно с ${reason.mod_names.slice(0, 2).join(", ")}`;
      case "addon_for":
        return `Аддон для ${reason.mod_name}`;
      case "trending":
        return "Популярное";
      case "optimization":
        return "Оптимизация";
      case "common_dependency":
        return "Часто используется";
      default:
        return "Рекомендуется";
    }
  }

  return {
    recommendations,
    loading,
    error,
    loadRecommendations,
    getReasonText,
  };
}
