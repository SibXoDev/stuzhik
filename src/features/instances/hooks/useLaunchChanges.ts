import { createSignal, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { LaunchChanges, SnapshotMeta, SnapshotHistory, LaunchSnapshot } from "../../../shared/types";

/**
 * Hook для получения изменений с последнего успешного запуска
 * и работы с историей снимков
 */
export function useLaunchChanges(instanceId: () => string | undefined) {
  const [changes, setChanges] = createSignal<LaunchChanges | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // Snapshot history
  const [history, setHistory] = createSignal<SnapshotHistory | null>(null);
  const [selectedSnapshotId, setSelectedSnapshotId] = createSignal<string | null>(null);
  const [historyLoading, setHistoryLoading] = createSignal(false);

  /**
   * Загрузить изменения относительно последнего снимка
   */
  const loadChanges = async () => {
    const id = instanceId();
    if (!id) return;

    setLoading(true);
    setError(null);

    try {
      const result = await invoke<LaunchChanges>("get_launch_changes", {
        instanceId: id,
      });
      setChanges(result);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      if (import.meta.env.DEV) {
        console.error("[useLaunchChanges] Error:", e);
      }
    } finally {
      setLoading(false);
    }
  };

  /**
   * Загрузить изменения относительно конкретного снимка
   */
  const loadChangesWithSnapshot = async (snapshotId: string) => {
    const id = instanceId();
    if (!id) return;

    setLoading(true);
    setError(null);
    setSelectedSnapshotId(snapshotId);

    try {
      const result = await invoke<LaunchChanges>("get_launch_changes_with_snapshot", {
        instanceId: id,
        snapshotId,
      });
      setChanges(result);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      if (import.meta.env.DEV) {
        console.error("[useLaunchChanges] Error loading changes with snapshot:", e);
      }
    } finally {
      setLoading(false);
    }
  };

  /**
   * Загрузить историю снимков
   */
  const loadHistory = async () => {
    const id = instanceId();
    if (!id) return;

    setHistoryLoading(true);

    try {
      const result = await invoke<SnapshotHistory>("get_snapshot_history", {
        instanceId: id,
      });
      setHistory(result);
    } catch (e) {
      if (import.meta.env.DEV) {
        console.error("[useLaunchChanges] Error loading history:", e);
      }
    } finally {
      setHistoryLoading(false);
    }
  };

  /**
   * Получить список снимков (только метаданные)
   */
  const getSnapshotList = async (): Promise<SnapshotMeta[]> => {
    const id = instanceId();
    if (!id) return [];

    try {
      return await invoke<SnapshotMeta[]>("get_snapshot_list", {
        instanceId: id,
      });
    } catch (e) {
      if (import.meta.env.DEV) {
        console.error("[useLaunchChanges] Error getting snapshot list:", e);
      }
      return [];
    }
  };

  /**
   * Загрузить полный снимок по ID
   */
  const loadSnapshot = async (snapshotId: string): Promise<LaunchSnapshot | null> => {
    const id = instanceId();
    if (!id) return null;

    try {
      return await invoke<LaunchSnapshot | null>("load_snapshot", {
        instanceId: id,
        snapshotId,
      });
    } catch (e) {
      if (import.meta.env.DEV) {
        console.error("[useLaunchChanges] Error loading snapshot:", e);
      }
      return null;
    }
  };

  /**
   * Пометить снимок как успешный/неуспешный
   */
  const markSnapshotResult = async (snapshotId: string, wasSuccessful: boolean) => {
    const id = instanceId();
    if (!id) return;

    try {
      await invoke("mark_snapshot_result", {
        instanceId: id,
        snapshotId,
        wasSuccessful,
      });
      // Обновляем историю
      await loadHistory();
    } catch (e) {
      if (import.meta.env.DEV) {
        console.error("[useLaunchChanges] Error marking snapshot result:", e);
      }
    }
  };

  /**
   * Связать снимок с бэкапом
   */
  const linkSnapshotToBackup = async (snapshotId: string, backupId: string) => {
    const id = instanceId();
    if (!id) return;

    try {
      await invoke("link_snapshot_to_backup", {
        instanceId: id,
        snapshotId,
        backupId,
      });
      // Обновляем историю
      await loadHistory();
    } catch (e) {
      if (import.meta.env.DEV) {
        console.error("[useLaunchChanges] Error linking snapshot to backup:", e);
      }
    }
  };

  /**
   * Установить максимальное количество снимков
   */
  const setMaxSnapshots = async (maxCount: number) => {
    const id = instanceId();
    if (!id) return;

    try {
      await invoke("set_max_snapshots", {
        instanceId: id,
        maxCount,
      });
      // Обновляем историю
      await loadHistory();
    } catch (e) {
      if (import.meta.env.DEV) {
        console.error("[useLaunchChanges] Error setting max snapshots:", e);
      }
    }
  };

  const dismissChanges = () => {
    setChanges(null);
    setSelectedSnapshotId(null);
  };

  const resetTracking = async () => {
    const id = instanceId();
    if (!id) return;

    try {
      await invoke("delete_launch_snapshot", { instanceId: id });
      setChanges(null);
      setHistory(null);
      setSelectedSnapshotId(null);
    } catch (e) {
      if (import.meta.env.DEV) {
        console.error("[useLaunchChanges] Reset error:", e);
      }
    }
  };

  // Load changes and history on mount
  onMount(() => {
    loadChanges();
    loadHistory();
  });

  return {
    // Изменения
    changes,
    loading,
    error,
    loadChanges,
    loadChangesWithSnapshot,
    dismissChanges,
    resetTracking,

    // История снимков
    history,
    historyLoading,
    loadHistory,
    selectedSnapshotId,
    setSelectedSnapshotId,

    // Работа со снимками
    getSnapshotList,
    loadSnapshot,
    markSnapshotResult,
    linkSnapshotToBackup,
    setMaxSnapshots,
  };
}
