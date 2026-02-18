import { createSignal, onCleanup, onMount, Accessor } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, emit, UnlistenFn } from "@tauri-apps/api/event";
import type {
  LiveCrashEvent,
  LiveCrashEventError,
  LiveCrashEventWarning,
  LiveCrashEventCrash,
  DetectedProblem,
  Instance,
} from "../types";

export interface LiveCrashState {
  /** Whether any monitoring is active */
  isMonitoring: boolean;
  /** Map of instance ID to monitoring status */
  monitoredInstances: Map<string, boolean>;
  /** Recent warnings (last 10) */
  warnings: LiveCrashEventWarning[];
  /** Recent errors (last 10) */
  errors: LiveCrashEventError[];
  /** Detected crashes */
  crashes: LiveCrashEventCrash[];
  /** Error message from monitor itself */
  monitorError: string | null;
  /** Total error count since start */
  errorCount: number;
  /** Total warning count since start */
  warningCount: number;
}

const MAX_EVENTS = 10;

/**
 * Global hook for live crash monitoring
 *
 * Automatically monitors running instances for crashes.
 * Listens to instance-status-changed events to start/stop monitoring.
 */
export function useLiveCrashMonitor(instanceId?: Accessor<string | null>) {
  const [state, setState] = createSignal<LiveCrashState>({
    isMonitoring: false,
    monitoredInstances: new Map(),
    warnings: [],
    errors: [],
    crashes: [],
    monitorError: null,
    errorCount: 0,
    warningCount: 0,
  });

  const [loading, setLoading] = createSignal(false);
  const [initialized, setInitialized] = createSignal(false);
  let unlistenCrashEvents: UnlistenFn | null = null;
  let unlistenStatusChanged: UnlistenFn | null = null;

  // Initialize on mount if global mode (no instanceId)
  onMount(async () => {
    if (!instanceId) {
      await init();
    }
  });

  onCleanup(() => {
    // Cleanup listeners
    unlistenCrashEvents?.();
    unlistenStatusChanged?.();

    // Stop all monitoring
    stopAll();
  });

  async function init() {
    if (initialized()) return;

    try {
      await invoke("init_live_monitor");
      setInitialized(true);

      // Listen for live crash events
      unlistenCrashEvents = await listen<LiveCrashEvent>("live-crash-event", (event) => {
        handleEvent(event.payload);
      });

      // Listen for instance status changes to auto-start/stop monitoring
      unlistenStatusChanged = await listen<{ id: string; status: string; log_path?: string }>(
        "instance-status-changed",
        async (event) => {
          const { id, status, log_path } = event.payload;

          if (status === "running" && log_path) {
            // Auto-start monitoring when instance starts
            try {
              await invoke("start_live_monitoring", {
                instanceId: id,
                logPath: log_path,
              });
            } catch (e) {
              if (import.meta.env.DEV) console.error(`Failed to start monitoring for ${id}:`, e);
            }
          } else if (status === "stopped" || status === "error") {
            // Auto-stop monitoring when instance stops
            try {
              await invoke("stop_live_monitoring", { instanceId: id });
            } catch (e) {
              // Ignore errors when stopping
            }
          }
        }
      );

      // Check for already running instances
      try {
        const instances = await invoke<Instance[]>("list_instances");
        for (const instance of instances) {
          if (instance.status === "running") {
            // Try to get log path and start monitoring
            const logPath = await getInstanceLogPath(instance.id);
            if (logPath) {
              try {
                await invoke("start_live_monitoring", {
                  instanceId: instance.id,
                  logPath,
                });
              } catch (e) {
                if (import.meta.env.DEV) console.error(`Failed to start monitoring for running instance ${instance.id}:`, e);
              }
            }
          }
        }
      } catch (e) {
        if (import.meta.env.DEV) console.error("Failed to check running instances:", e);
      }
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to initialize live crash monitor:", e);
      setState((prev) => ({
        ...prev,
        monitorError: e instanceof Error ? e.message : String(e),
      }));
    }
  }

  async function getInstanceLogPath(instanceId: string): Promise<string | null> {
    try {
      const instance = await invoke<Instance>("get_instance", { id: instanceId });
      if (instance && instance.dir) {
        // Both client and server use logs/latest.log in instance directory
        return `${instance.dir}/logs/latest.log`;
      }
    } catch (e) {
      if (import.meta.env.DEV) console.error(`Failed to get instance ${instanceId}:`, e);
    }
    return null;
  }

  function handleEvent(event: LiveCrashEvent) {
    // In instance-specific mode, filter events
    if (instanceId) {
      const id = instanceId();
      if (event.instance_id !== id) return;
    }

    switch (event.type) {
      case "started":
        setState((prev) => {
          const instances = new Map(prev.monitoredInstances);
          instances.set(event.instance_id, true);
          return {
            ...prev,
            isMonitoring: true,
            monitoredInstances: instances,
            monitorError: null,
          };
        });
        break;

      case "stopped":
        setState((prev) => {
          const instances = new Map(prev.monitoredInstances);
          instances.delete(event.instance_id);
          return {
            ...prev,
            isMonitoring: instances.size > 0,
            monitoredInstances: instances,
          };
        });
        break;

      case "warning":
        setState((prev) => ({
          ...prev,
          warnings: [...prev.warnings.slice(-MAX_EVENTS + 1), event],
          warningCount: prev.warningCount + 1,
        }));
        break;

      case "error":
        setState((prev) => ({
          ...prev,
          errors: [...prev.errors.slice(-MAX_EVENTS + 1), event],
          errorCount: prev.errorCount + 1,
        }));
        // Auto-open log analyzer for loading errors (KubeJS, Mixin, etc.)
        emit("open-log-analyzer", { instanceId: event.instance_id });
        break;

      case "crash":
        setState((prev) => ({
          ...prev,
          crashes: [...prev.crashes, event],
          errorCount: prev.errorCount + event.problems.length,
        }));
        // Emit event to auto-open log analyzer
        emit("open-log-analyzer", { instanceId: event.instance_id });
        break;

      case "monitor_error":
        setState((prev) => ({
          ...prev,
          monitorError: event.message,
        }));
        break;
    }
  }

  async function startMonitoring(targetInstanceId: string, logPath: string) {
    try {
      setLoading(true);
      await invoke("start_live_monitoring", {
        instanceId: targetInstanceId,
        logPath,
      });
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to start live monitoring:", e);
      setState((prev) => ({
        ...prev,
        monitorError: e instanceof Error ? e.message : String(e),
      }));
    } finally {
      setLoading(false);
    }
  }

  async function stopMonitoring(targetInstanceId?: string) {
    const id = targetInstanceId || (instanceId ? instanceId() : null);
    if (!id) return;

    try {
      setLoading(true);
      await invoke("stop_live_monitoring", { instanceId: id });
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to stop live monitoring:", e);
    } finally {
      setLoading(false);
    }
  }

  async function stopAll() {
    try {
      setLoading(true);
      const instances = Array.from(state().monitoredInstances.keys());
      await Promise.all(
        instances.map((id) =>
          invoke("stop_live_monitoring", { instanceId: id }).catch((e) => {
            if (import.meta.env.DEV) console.error("Failed to stop monitoring:", e);
          })
        )
      );
    } finally {
      setLoading(false);
    }
  }

  function clearEvents() {
    setState((prev) => ({
      ...prev,
      warnings: [],
      errors: [],
      crashes: [],
      errorCount: 0,
      warningCount: 0,
      monitorError: null,
    }));
  }

  function getLatestProblems(limit = 5): DetectedProblem[] {
    const s = state();
    const problems: DetectedProblem[] = [];

    // Add errors
    for (const err of s.errors.slice(-limit)) {
      problems.push(err.problem);
    }

    // Add crash problems
    for (const crash of s.crashes) {
      problems.push(...crash.problems.slice(0, limit - problems.length));
      if (problems.length >= limit) break;
    }

    return problems.slice(0, limit);
  }

  function getLatestWarnings(limit = 5): LiveCrashEventWarning[] {
    return state().warnings.slice(-limit);
  }

  async function checkIsMonitoring(targetInstanceId?: string): Promise<boolean> {
    const id = targetInstanceId || (instanceId ? instanceId() : null);
    if (!id) return state().isMonitoring;

    try {
      return await invoke<boolean>("is_live_monitoring", { instanceId: id });
    } catch {
      return false;
    }
  }

  return {
    // State
    state,
    loading,

    // Derived
    isMonitoring: () => state().isMonitoring,
    errorCount: () => state().errorCount,
    warningCount: () => state().warningCount,
    hasErrors: () => state().errorCount > 0,
    hasCrash: () => state().crashes.length > 0,
    monitorError: () => state().monitorError,
    getLatestProblems,
    getLatestWarnings,

    // Actions
    init,
    startMonitoring,
    stopMonitoring,
    stopAll,
    clearEvents,
    checkIsMonitoring,
  };
}
