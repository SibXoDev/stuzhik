import { createSignal, createEffect, Accessor } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { CrashRecord, CrashStatistics, CrashTrend } from "../types";

export function useCrashHistory(instanceId: Accessor<string>) {
  const [history, setHistory] = createSignal<CrashRecord[]>([]);
  const [statistics, setStatistics] = createSignal<CrashStatistics | null>(null);
  const [trends, setTrends] = createSignal<CrashTrend[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // Load history when instanceId changes
  createEffect(() => {
    const id = instanceId();
    if (id) {
      loadHistory();
    }
  });

  async function loadHistory(limit?: number) {
    const id = instanceId();
    if (!id) return;

    try {
      setLoading(true);
      setError(null);

      const records = await invoke<CrashRecord[]>("get_crash_history_command", {
        instanceId: id,
        limit: limit ?? 100,
      });

      setHistory(records);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to load crash history:", e);
    } finally {
      setLoading(false);
    }
  }

  async function loadStatistics() {
    const id = instanceId();
    if (!id) return;

    try {
      setLoading(true);
      setError(null);

      const stats = await invoke<CrashStatistics>("get_crash_statistics_command", {
        instanceId: id,
      });

      setStatistics(stats);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to load crash statistics:", e);
    } finally {
      setLoading(false);
    }
  }

  async function loadTrends() {
    const id = instanceId();
    if (!id) return;

    try {
      setLoading(true);
      setError(null);

      const trendData = await invoke<CrashTrend[]>("get_crash_trends_command", {
        instanceId: id,
      });

      setTrends(trendData);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to load crash trends:", e);
    } finally {
      setLoading(false);
    }
  }

  async function loadAll() {
    await Promise.all([loadHistory(), loadStatistics(), loadTrends()]);
  }

  async function markFixed(crashId: string, fixMethod: string) {
    try {
      setError(null);

      await invoke("mark_crash_fixed_command", {
        crashId,
        fixMethod,
      });

      // Update local state
      setHistory((prev) =>
        prev.map((record) =>
          record.id === crashId
            ? { ...record, was_fixed: true, fix_method: fixMethod }
            : record
        )
      );

      // Reload statistics
      await loadStatistics();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to mark crash as fixed:", e);
    }
  }

  async function updateNotes(crashId: string, notes: string) {
    try {
      setError(null);

      await invoke("update_crash_notes_command", {
        crashId,
        notes,
      });

      // Update local state
      setHistory((prev) =>
        prev.map((record) =>
          record.id === crashId ? { ...record, notes } : record
        )
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to update crash notes:", e);
    }
  }

  async function clearHistory(): Promise<number> {
    const id = instanceId();
    if (!id) return 0;

    try {
      setError(null);

      const deleted = await invoke<number>("clear_crash_history_command", {
        instanceId: id,
      });

      // Clear local state
      setHistory([]);
      setStatistics(null);
      setTrends([]);

      return deleted;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to clear crash history:", e);
      return 0;
    }
  }

  async function cleanupOld(days: number): Promise<number> {
    try {
      setError(null);

      const deleted = await invoke<number>("cleanup_old_crashes_command", {
        days,
      });

      // Reload data
      await loadAll();

      return deleted;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to cleanup old crashes:", e);
      return 0;
    }
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
