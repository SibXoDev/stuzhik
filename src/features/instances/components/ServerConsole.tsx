import { Component, createSignal, createEffect, onMount, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { Select } from "../../../shared/ui/Select";
import { Tooltip } from "../../../shared/ui/Tooltip";
import { useI18n } from "../../../shared/i18n";

interface ServerLogEntry {
  timestamp: number;
  level: "debug" | "info" | "warn" | "error" | "fatal" | "unknown";
  line: string;
  thread?: string;
  source?: string;
}

interface ServerMetrics {
  cpu_percent: number;
  memory_mb: number;
  uptime_secs: number;
  players_online: number;
  tps?: number;
}

interface CommandResult {
  success: boolean;
  method: string;
  response?: string;
  error?: string;
}

interface RconConfig {
  enabled: boolean;
  port: number;
  password: string;
}

interface Props {
  instanceId: string;
  isRunning: boolean;
  instanceStatus?: string;
  onStop?: () => void;
}

const ServerConsole: Component<Props> = (props) => {
  const { t } = useI18n();
  const [logs, setLogs] = createSignal<ServerLogEntry[]>([]);
  const [command, setCommand] = createSignal("");
  const [commandHistory, setCommandHistory] = createSignal<string[]>([]);
  const [historyIndex, setHistoryIndex] = createSignal(-1);
  const [autoScroll, setAutoScroll] = createSignal(true);
  const [filterLevel, setFilterLevel] = createSignal<string>("all");
  const [metrics, setMetrics] = createSignal<ServerMetrics | null>(null);
  const [rconConnected, setRconConnected] = createSignal(false);
  const [rconConfig, setRconConfig] = createSignal<RconConfig | null>(null);
  const [isStopping, setIsStopping] = createSignal(false);
  const [showForceKillConfirm, setShowForceKillConfirm] = createSignal(false);

  let logsContainer: HTMLDivElement | undefined;
  let inputRef: HTMLInputElement | undefined;
  let unlistenLogs: UnlistenFn | undefined;
  let unlistenRcon: UnlistenFn | undefined;
  let unlistenStopping: UnlistenFn | undefined;

  // Load initial logs
  const loadLogs = async () => {
    try {
      const serverLogs = await invoke<ServerLogEntry[]>("get_server_logs", {
        instanceId: props.instanceId,
      });
      setLogs(serverLogs);
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to load server logs:", e);
    }
  };

  // Load metrics
  const loadMetrics = async () => {
    if (!props.isRunning) {
      setMetrics(null);
      return;
    }
    try {
      const m = await invoke<ServerMetrics>("get_server_metrics", {
        instanceId: props.instanceId,
      });
      setMetrics(m);
    } catch {
      // Metrics might not be available yet
    }
  };

  // Check RCON status
  const checkRconStatus = async () => {
    if (!props.isRunning) {
      setRconConnected(false);
      return;
    }
    try {
      const connected = await invoke<boolean>("is_rcon_connected", {
        instanceId: props.instanceId,
      });
      setRconConnected(connected);
    } catch {
      setRconConnected(false);
    }
  };

  // Load RCON config
  const loadRconConfig = async () => {
    try {
      const config = await invoke<RconConfig>("get_rcon_config", {
        instanceId: props.instanceId,
      });
      setRconConfig(config);
    } catch {
      setRconConfig(null);
    }
  };

  // Subscribe to events
  onMount(async () => {
    await loadLogs();
    await loadMetrics();
    await loadRconConfig();
    await checkRconStatus();

    // Listen for new log entries (instance-specific event)
    unlistenLogs = await listen<ServerLogEntry>(
      `server-log:${props.instanceId}`,
      (event) => {
        setLogs((prev) => [...prev, event.payload].slice(-1000));
      }
    );

    // Listen for RCON connection events
    unlistenRcon = await listen<{ connected: boolean }>(
      `server-rcon:${props.instanceId}`,
      (event) => {
        setRconConnected(event.payload.connected);
      }
    );

    // Listen for server stopping events
    unlistenStopping = await listen<{ reason: string }>(
      `server-stopping:${props.instanceId}`,
      () => {
        setIsStopping(true);
      }
    );

    // Refresh metrics periodically (every 3s to reduce overhead)
    const metricsInterval = setInterval(loadMetrics, 3000);
    // Check RCON status periodically
    const rconInterval = setInterval(checkRconStatus, 5000);

    onCleanup(() => {
      unlistenLogs?.();
      unlistenRcon?.();
      unlistenStopping?.();
      clearInterval(metricsInterval);
      clearInterval(rconInterval);
    });
  });

  // Auto-scroll to bottom when new logs arrive
  createEffect(() => {
    if (autoScroll() && logsContainer && logs().length > 0) {
      logsContainer.scrollTop = logsContainer.scrollHeight;
    }
  });

  // Refresh logs and reset stopping state when running state changes
  createEffect(() => {
    if (props.isRunning) {
      loadLogs();
      setIsStopping(false);
    } else {
      setRconConnected(false);
      setIsStopping(false);
    }
  });

  // Clear logs when server starts (status changes to "starting")
  createEffect(() => {
    if (props.instanceStatus === "starting") {
      setLogs([]);
    }
  });

  // Handle scroll to detect if user scrolled up
  const handleScroll = () => {
    if (logsContainer) {
      const isAtBottom = logsContainer.scrollHeight - logsContainer.scrollTop - logsContainer.clientHeight < 50;
      setAutoScroll(isAtBottom);
    }
  };

  // Send command
  const sendCommand = async () => {
    const cmd = command().trim();
    if (!cmd || !props.isRunning) return;

    try {
      const result = await invoke<CommandResult>("send_server_command", {
        instanceId: props.instanceId,
        command: cmd,
      });

      // Add to history
      setCommandHistory((prev) => [cmd, ...prev.filter((c) => c !== cmd)].slice(0, 50));
      setCommand("");
      setHistoryIndex(-1);

      // If command was sent via stdin (no response), log it locally
      if (result.method === "stdin" && result.success) {
        // The command will appear in server logs via stdout
      }
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to send command:", e);
    }
  };

  // Graceful stop
  const handleGracefulStop = async () => {
    if (isStopping()) return;

    setIsStopping(true);
    try {
      await invoke("graceful_stop_server", {
        id: props.instanceId,
      });
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to stop server:", e);
      setIsStopping(false);
    }
  };

  // Force kill
  const handleForceKill = async () => {
    setShowForceKillConfirm(false);
    try {
      await invoke("force_kill_server", {
        id: props.instanceId,
      });
      props.onStop?.();
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to force kill server:", e);
    }
  };

  // Handle keyboard navigation
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      sendCommand();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const history = commandHistory();
      if (history.length > 0 && historyIndex() < history.length - 1) {
        const newIndex = historyIndex() + 1;
        setHistoryIndex(newIndex);
        setCommand(history[newIndex]);
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIndex() > 0) {
        const newIndex = historyIndex() - 1;
        setHistoryIndex(newIndex);
        setCommand(commandHistory()[newIndex]);
      } else if (historyIndex() === 0) {
        setHistoryIndex(-1);
        setCommand("");
      }
    }
  };

  // Get log level color
  const getLevelColor = (level: string) => {
    switch (level) {
      case "error":
      case "fatal":
        return "text-red-400";
      case "warn":
        return "text-yellow-400";
      case "debug":
        return "text-gray-500";
      case "info":
        return "text-gray-300";
      default:
        return "text-gray-400";
    }
  };

  // Filter logs
  const filteredLogs = () => {
    const level = filterLevel();
    if (level === "all") return logs();
    return logs().filter((log) => log.level === level);
  };

  // Format uptime
  const formatUptime = (secs: number) => {
    const hours = Math.floor(secs / 3600);
    const mins = Math.floor((secs % 3600) / 60);
    if (hours > 0) return `${hours}${t().server.console.hours} ${mins}${t().server.console.minutes}`;
    return `${mins}${t().server.console.minutes}`;
  };

  // Clear logs
  const clearLogs = async () => {
    try {
      await invoke("clear_server_logs", { instanceId: props.instanceId });
      setLogs([]);
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to clear logs:", e);
    }
  };

  return (
    <div class="flex flex-col flex-1 min-h-0 gap-3">
      {/* Compact toolbar */}
      <div class="flex items-center justify-between gap-3 flex-shrink-0">
        {/* Metrics (when running) */}
        <Show when={metrics()} fallback={<div />}>
          {(m) => (
            <div class="flex items-center gap-3 text-xs text-gray-400">
              <span class="flex items-center gap-1">
                <i class="i-hugeicons-clock-01 w-3.5 h-3.5" />
                {formatUptime(m().uptime_secs)}
              </span>
              <span class="flex items-center gap-1">
                <i class="i-hugeicons-cpu w-3.5 h-3.5" />
                {m().cpu_percent.toFixed(0)}%
              </span>
              <span class="flex items-center gap-1">
                <i class="i-hugeicons-cpu-charge w-3.5 h-3.5" />
                {m().memory_mb.toFixed(0)} MB
              </span>
              <Show when={m().players_online !== undefined}>
                <span class="flex items-center gap-1">
                  <i class="i-hugeicons-user-group w-3.5 h-3.5" />
                  {m().players_online}
                </span>
              </Show>
              {/* RCON status indicator */}
              <Show when={rconConfig()?.enabled}>
                <Tooltip text={rconConnected() ? t().server.console.rconConnected : t().server.console.rconDisconnected} position="bottom">
                  <span
                    class={`flex items-center gap-1 ${rconConnected() ? "text-emerald-400" : "text-gray-500"}`}
                  >
                    <i class="i-hugeicons-command-line w-3.5 h-3.5" />
                    RCON
                  </span>
                </Tooltip>
              </Show>
            </div>
          )}
        </Show>

        <div class="flex items-center gap-1">
          {/* Filter */}
          <Select
            value={filterLevel()}
            onChange={setFilterLevel}
            options={[
              { value: "all", label: t().server.console.filterAll },
              { value: "error", label: t().server.console.filterErrors },
              { value: "warn", label: "Warn" },
              { value: "info", label: "Info" },
              { value: "debug", label: "Debug" },
            ]}
            class="w-28"
          />

          {/* Clear logs */}
          <Tooltip text={t().server.console.clearLogs} position="bottom">
            <button
              class="p-1.5 rounded text-gray-400 hover:text-gray-200 hover:bg-gray-800"
              onClick={clearLogs}
            >
              <i class="i-hugeicons-delete-02 w-4 h-4" />
            </button>
          </Tooltip>

          {/* Auto-scroll toggle */}
          <Tooltip text={autoScroll() ? t().server.console.autoScrollOn : t().server.console.autoScrollOff} position="bottom">
            <button
              class={`p-1.5 rounded ${autoScroll() ? "text-[var(--color-primary)] bg-[var(--color-primary-bg)]" : "text-gray-500 hover:text-gray-300"}`}
              onClick={() => setAutoScroll(!autoScroll())}
            >
              <i class="i-hugeicons-arrow-down-01 w-4 h-4" />
            </button>
          </Tooltip>

          {/* Separator */}
          <div class="w-px h-4 bg-gray-700 mx-1" />

          {/* Graceful stop button - primary action */}
          {/* Stop button - shown when running or stopping/starting */}
          <Show when={props.isRunning || ["stopping", "starting"].includes(props.instanceStatus || "")}>
            <Show
              when={props.instanceStatus === "stopping" || props.instanceStatus === "starting"}
              fallback={
                <Tooltip text={isStopping() ? t().server.console.stopping : t().server.console.stopServer} position="bottom">
                  <button
                    class={`px-3 py-1 rounded-lg flex items-center gap-1.5 text-sm font-medium transition-colors ${
                      isStopping()
                        ? "bg-yellow-500/20 text-yellow-400 cursor-wait"
                        : "bg-gray-700 text-gray-200 hover:bg-yellow-600 hover:text-white"
                    }`}
                    onClick={handleGracefulStop}
                    disabled={isStopping()}
                  >
                    <Show when={isStopping()} fallback={<i class="i-hugeicons-stop w-4 h-4" />}>
                      <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                    </Show>
                    <span>{isStopping() ? t().server.console.stopping : "Stop"}</span>
                  </button>
                </Tooltip>
              }
            >
              {/* Status indicator when stopping/starting */}
              <div class="px-3 py-1 rounded-lg flex items-center gap-1.5 text-sm bg-yellow-500/20 text-yellow-400">
                <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                <span>{props.instanceStatus === "stopping" ? t().server.console.stopping : t().server.console.starting}</span>
              </div>
            </Show>
          </Show>

          {/* Force kill button - shown during stopping/starting */}
          <Show when={["stopping", "starting"].includes(props.instanceStatus || "")}>
            <Tooltip text={t().server.console.forceKillHint} position="bottom">
              <button
                class="px-3 py-1 rounded-lg flex items-center gap-1.5 text-sm font-medium bg-red-500/20 text-red-400 hover:bg-red-500/30"
                onClick={() => setShowForceKillConfirm(true)}
              >
                <i class="i-hugeicons-power-socket-01 w-4 h-4" />
                <span>Force Kill</span>
              </button>
            </Tooltip>
          </Show>
        </div>
      </div>

      {/* Force kill confirmation */}
      <Show when={showForceKillConfirm()}>
        <div class="bg-red-500/10 border border-red-500/30 rounded-lg p-3 flex items-center justify-between gap-3">
          <div class="flex items-center gap-2 text-sm text-red-400">
            <i class="i-hugeicons-alert-02 w-4 h-4" />
            <span>{t().server.console.forceKillWarning}</span>
          </div>
          <div class="flex items-center gap-2">
            <button
              class="px-3 py-1 rounded text-xs bg-gray-700 text-gray-300 hover:bg-gray-600"
              onClick={() => setShowForceKillConfirm(false)}
            >
              {t().common.cancel}
            </button>
            <button
              class="px-3 py-1 rounded text-xs bg-red-600 text-white hover:bg-red-500"
              onClick={handleForceKill}
            >
              Force Kill
            </button>
          </div>
        </div>
      </Show>

      {/* Logs area */}
      <div
        ref={logsContainer}
        class="flex-1 min-h-0 overflow-y-auto bg-gray-900/50 rounded-lg border border-gray-800 p-3 font-mono text-xs leading-relaxed"
        onScroll={handleScroll}
      >
        <Show
          when={filteredLogs().length > 0}
          fallback={
            <div class="text-gray-500 text-center py-8 text-sm">
              {props.isRunning ? t().server.console.waitingLogs : t().server.console.serverStopped}
            </div>
          }
        >
          <For each={filteredLogs()}>
            {(log) => (
              <div class={`py-px ${getLevelColor(log.level)} whitespace-pre-wrap break-all`}>
                {log.line}
              </div>
            )}
          </For>
        </Show>
      </div>

      {/* Command input */}
      <div class="flex items-center gap-2 flex-shrink-0">
        <div class="flex-1 flex items-center gap-2">
          {/* RCON indicator in input */}
          <Show when={rconConnected()}>
            <Tooltip text="Команды отправляются через RCON" position="bottom">
              <span class="text-xs text-emerald-400 bg-emerald-500/10 px-2 py-1 rounded">
                RCON
              </span>
            </Tooltip>
          </Show>
          <input
            ref={inputRef}
            type="text"
            class="flex-1 bg-gray-800/50 border border-gray-700 rounded px-3 py-1.5 text-sm font-mono text-gray-100 placeholder-gray-500 focus:border-[var(--color-primary)] focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
            placeholder={props.isRunning ? t().server.console.enterCommand : t().server.console.serverNotRunning}
            value={command()}
            onInput={(e) => setCommand(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
            disabled={!props.isRunning}
          />
        </div>
        <button
          class="btn-primary px-3 py-1.5 text-sm"
          onClick={sendCommand}
          disabled={!props.isRunning || !command().trim()}
        >
          <i class="i-hugeicons-sent w-4 h-4" />
        </button>
      </div>
    </div>
  );
};

export default ServerConsole;
