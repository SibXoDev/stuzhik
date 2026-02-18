import { createSignal, onCleanup, onMount, Accessor, createMemo } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import type {
  PerformanceSnapshot,
  PerformanceReport,
  PerformanceBottleneck,
  PerformanceRecommendation,
  SparkInfo,
  PerformanceEvent,
  ModPerformance,
} from "../../../shared/types/common.types";

interface UsePerformanceOptions {
  /** Автоматически начать мониторинг при запуске экземпляра */
  autoStart?: boolean;
  /** Интервал сбора данных (ms) */
  intervalMs?: number;
}

// Helper to extract error message from unknown error type
function getErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  if (typeof e === 'object' && e !== null) {
    const obj = e as Record<string, unknown>;
    // LauncherError has details field with actual error info
    if ('details' in obj && typeof obj.details === 'string' && obj.details) {
      return obj.details;
    }
    // Tauri errors often have a message property
    if ('message' in obj && typeof obj.message === 'string') {
      return obj.message;
    }
    return JSON.stringify(e);
  }
  return String(e);
}

export function usePerformance(
  instanceId: Accessor<string | null>,
  options: UsePerformanceOptions = {}
) {
  const { autoStart: _autoStart = false, intervalMs = 1000 } = options;
  void _autoStart; // Reserved for future auto-start functionality

  // State
  const [monitoring, setMonitoring] = createSignal(false);
  const [snapshots, setSnapshots] = createSignal<PerformanceSnapshot[]>([]);
  const [report, setReport] = createSignal<PerformanceReport | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [sparkInfo, setSparkInfo] = createSignal<SparkInfo | null>(null);
  const [realtimeBottlenecks, setRealtimeBottlenecks] = createSignal<PerformanceBottleneck[]>([]);

  // Computed
  const latestSnapshot = createMemo(() => {
    const snaps = snapshots();
    return snaps.length > 0 ? snaps[snaps.length - 1] : null;
  });

  const avgMemory = createMemo(() => {
    const snaps = snapshots();
    if (snaps.length === 0) return 0;
    const sum = snaps.reduce((acc, s) => acc + s.memory_used_mb, 0);
    return Math.round(sum / snaps.length);
  });

  const avgCpu = createMemo(() => {
    const snaps = snapshots();
    if (snaps.length === 0) return 0;
    const sum = snaps.reduce((acc, s) => acc + s.cpu_percent, 0);
    return Math.round(sum / snaps.length * 10) / 10;
  });

  // Event listener
  let unlistenPerformance: UnlistenFn | null = null;

  onMount(async () => {
    // Слушаем events производительности
    unlistenPerformance = await listen<PerformanceEvent>("performance-event", (event) => {
      const payload = event.payload;
      const currentId = instanceId();

      if (!currentId) return;

      switch (payload.type) {
        case "started":
          if (payload.instance_id === currentId) {
            setMonitoring(true);
            setSnapshots([]);
            setRealtimeBottlenecks([]);
          }
          break;

        case "stopped":
          if (payload.instance_id === currentId) {
            setMonitoring(false);
          }
          break;

        case "snapshot":
          if (payload.instance_id === currentId) {
            setSnapshots((prev) => {
              const newSnapshots = [...prev, payload.snapshot];
              // Ограничиваем 500 снимков в UI
              if (newSnapshots.length > 500) {
                return newSnapshots.slice(-500);
              }
              return newSnapshots;
            });
          }
          break;

        case "bottleneck_detected":
          if (payload.instance_id === currentId) {
            setRealtimeBottlenecks((prev) => {
              // Дедупликация по description
              const exists = prev.some(
                (b) => b.description === payload.bottleneck.description
              );
              if (exists) return prev;
              return [...prev.slice(-19), payload.bottleneck]; // Последние 20
            });
          }
          break;

        case "error":
          if (payload.instance_id === currentId) {
            setError(payload.message);
            setMonitoring(false);
          }
          break;
      }
    });

    // Проверяем Spark при загрузке
    const id = instanceId();
    if (id) {
      detectSpark(id);
    }
  });

  onCleanup(() => {
    unlistenPerformance?.();
  });

  // Actions
  async function startMonitoring() {
    const id = instanceId();
    if (!id) {
      setError("Instance ID not provided");
      return;
    }

    setError(null);
    setLoading(true);
    try {
      if (import.meta.env.DEV) console.log("[PERF] Starting monitoring for:", id);
      await invoke("start_performance_monitoring", {
        instanceId: id,
        intervalMs,
      });
      if (import.meta.env.DEV) console.log("[PERF] Monitoring started successfully");
      setMonitoring(true);
      setSnapshots([]);
      setRealtimeBottlenecks([]);
    } catch (e) {
      if (import.meta.env.DEV) console.error("[PERF] Failed to start monitoring:", e);
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  async function stopMonitoring(): Promise<PerformanceSnapshot[]> {
    const id = instanceId();
    if (!id) return [];

    try {
      const finalSnapshots = await invoke<PerformanceSnapshot[]>(
        "stop_performance_monitoring",
        { instanceId: id }
      );
      setMonitoring(false);
      return finalSnapshots;
    } catch (e) {
      setError(getErrorMessage(e));
      return [];
    }
  }

  async function getSnapshot(): Promise<PerformanceSnapshot | null> {
    const id = instanceId();
    if (!id) return null;

    try {
      const snapshot = await invoke<PerformanceSnapshot>("get_performance_snapshot", {
        instanceId: id,
      });
      return snapshot;
    } catch (e) {
      setError(getErrorMessage(e));
      return null;
    }
  }

  async function getReport(): Promise<PerformanceReport | null> {
    const id = instanceId();
    if (!id) {
      setError("Instance ID not provided");
      return null;
    }

    setLoading(true);
    setError(null);

    try {
      if (import.meta.env.DEV) console.log("[PERF] Getting report for:", id);
      const rep = await invoke<PerformanceReport>("get_performance_report", {
        instanceId: id,
      });
      if (import.meta.env.DEV) console.log("[PERF] Report received:", rep);
      setReport(rep);
      return rep;
    } catch (e) {
      if (import.meta.env.DEV) console.error("[PERF] Failed to get report:", e);
      setError(getErrorMessage(e));
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function getRecommendations(): Promise<PerformanceRecommendation[]> {
    const id = instanceId();
    if (!id) return [];

    try {
      return await invoke<PerformanceRecommendation[]>(
        "get_performance_recommendations",
        { instanceId: id }
      );
    } catch (e) {
      setError(getErrorMessage(e));
      return [];
    }
  }

  async function detectSpark(id?: string): Promise<SparkInfo | null> {
    const instanceIdValue = id || instanceId();
    if (!instanceIdValue) return null;

    try {
      const info = await invoke<SparkInfo>("detect_spark", {
        instanceId: instanceIdValue,
      });
      setSparkInfo(info);
      return info;
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to detect Spark:", e);
      return null;
    }
  }

  async function getModPerformanceFromSpark(): Promise<ModPerformance[]> {
    const id = instanceId();
    if (!id) return [];

    try {
      return await invoke<ModPerformance[]>("get_mod_performance_from_spark", {
        instanceId: id,
      });
    } catch (e) {
      setError(getErrorMessage(e));
      return [];
    }
  }

  async function scanLogsForPerformance(): Promise<PerformanceBottleneck[]> {
    const id = instanceId();
    if (!id) return [];

    try {
      return await invoke<PerformanceBottleneck[]>("scan_logs_for_performance", {
        instanceId: id,
      });
    } catch (e) {
      setError(getErrorMessage(e));
      return [];
    }
  }

  // Spark installation state
  const [sparkInstalling, setSparkInstalling] = createSignal(false);

  async function installSpark(): Promise<boolean> {
    const id = instanceId();
    if (!id) return false;

    setSparkInstalling(true);
    try {
      await invoke("install_spark", { instanceId: id });
      // Refresh Spark detection
      await detectSpark();
      return true;
    } catch (e) {
      setError(getErrorMessage(e));
      return false;
    } finally {
      setSparkInstalling(false);
    }
  }

  function clearSnapshots() {
    setSnapshots([]);
  }

  function clearError() {
    setError(null);
  }

  function clearRealtimeBottlenecks() {
    setRealtimeBottlenecks([]);
  }

  return {
    // State
    monitoring,
    snapshots,
    report,
    loading,
    error,
    sparkInfo,
    sparkInstalling,
    realtimeBottlenecks,

    // Computed
    latestSnapshot,
    avgMemory,
    avgCpu,

    // Actions
    startMonitoring,
    stopMonitoring,
    getSnapshot,
    getReport,
    getRecommendations,
    detectSpark,
    installSpark,
    getModPerformanceFromSpark,
    scanLogsForPerformance,
    clearSnapshots,
    clearError,
    clearRealtimeBottlenecks,
  };
}
