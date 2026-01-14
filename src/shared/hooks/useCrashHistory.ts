import { createSignal, createEffect, Accessor } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { CrashRecord, CrashStatistics, CrashTrend } from "../types";
import { createAsyncState, runAsync, updateItemById, isValidInstanceId } from "./useAsyncUtils";

const LOG_PREFIX = "[CrashHistory]";

export function useCrashHistory(instanceId: Accessor<string>) {
  const [history, setHistory] = createSignal<CrashRecord[]>([]);
  const [statistics, setStatistics] = createSignal<CrashStatistics | null>(null);
  const [trends, setTrends] = createSignal<CrashTrend[]>([]);
  const { loading, setLoading, error, setError } = createAsyncState();

  // Load history when instanceId changes
  createEffect(() => {
    const id = instanceId();
    if (id) {
      loadHistory();
    }
  });

  async function loadHistory(limit?: number) {
    const id = instanceId();
    if (!isValidInstanceId(id)) return;

    await runAsync(
      () => invoke<CrashRecord[]>("get_crash_history_command", { instanceId: id, limit: limit ?? 100 }),
      { setLoading, setError, logPrefix: LOG_PREFIX, onSuccess: setHistory }
    );
  }

  async function loadStatistics() {
    const id = instanceId();
    if (!isValidInstanceId(id)) return;

    await runAsync(
      () => invoke<CrashStatistics>("get_crash_statistics_command", { instanceId: id }),
      { setLoading, setError, logPrefix: LOG_PREFIX, onSuccess: setStatistics }
    );
  }

  async function loadTrends() {
    const id = instanceId();
    if (!isValidInstanceId(id)) return;

    await runAsync(
      () => invoke<CrashTrend[]>("get_crash_trends_command", { instanceId: id }),
      { setLoading, setError, logPrefix: LOG_PREFIX, onSuccess: setTrends }
    );
  }

  async function loadAll() {
    await Promise.all([loadHistory(), loadStatistics(), loadTrends()]);
  }

  async function markFixed(crashId: string, fixMethod: string) {
    const result = await runAsync(
      () => invoke<void>("mark_crash_fixed_command", { crashId, fixMethod }),
      { setError, logPrefix: LOG_PREFIX }
    );

    if (result !== null) {
      // Update local state using helper
      updateItemById(setHistory, crashId, { was_fixed: true, fix_method: fixMethod });
      // Reload statistics
      await loadStatistics();
    }
  }

  async function updateNotes(crashId: string, notes: string) {
    const result = await runAsync(
      () => invoke<void>("update_crash_notes_command", { crashId, notes }),
      { setError, logPrefix: LOG_PREFIX }
    );

    if (result !== null) {
      // Update local state using helper
      updateItemById(setHistory, crashId, { notes });
    }
  }

  async function clearHistory(): Promise<number> {
    const id = instanceId();
    if (!isValidInstanceId(id)) return 0;

    const deleted = await runAsync(
      () => invoke<number>("clear_crash_history_command", { instanceId: id }),
      { setError, logPrefix: LOG_PREFIX }
    );

    if (deleted !== null) {
      // Clear local state
      setHistory([]);
      setStatistics(null);
      setTrends([]);
      return deleted;
    }
    return 0;
  }

  async function cleanupOld(days: number): Promise<number> {
    const deleted = await runAsync(
      () => invoke<number>("cleanup_old_crashes_command", { days }),
      {
        setError,
        logPrefix: LOG_PREFIX,
        onSuccess: () => loadAll(),
      }
    );
    return deleted ?? 0;
  }

  return {
    // State
    history,
    statistics,
    trends,
    loading,
    error,

    // Actions
    loadHistory,
    loadStatistics,
    loadTrends,
    loadAll,
    markFixed,
    updateNotes,
    clearHistory,
    cleanupOld,
  };
}
