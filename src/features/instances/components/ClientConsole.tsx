import { Component, createSignal, createEffect, onMount, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { Select } from "../../../shared/ui/Select";
import { Tooltip } from "../../../shared/ui/Tooltip";
import { useI18n } from "../../../shared/i18n";

interface LogEntry {
  timestamp: number;
  level: "debug" | "info" | "warn" | "error" | "fatal" | "unknown";
  line: string;
  thread?: string;
  source?: string;
}

interface Props {
  instanceId: string;
  isRunning: boolean;
  instanceStatus?: string;
}

/**
 * Read-only console for client instances.
 * Shows real-time stdout/stderr output from the running Minecraft client.
 * Unlike ServerConsole, this does not support command input.
 */
const ClientConsole: Component<Props> = (props) => {
  const { t } = useI18n();
  const [logs, setLogs] = createSignal<LogEntry[]>([]);
  const [autoScroll, setAutoScroll] = createSignal(true);
  const [filterLevel, setFilterLevel] = createSignal<string>("all");
  const [searchTerm, setSearchTerm] = createSignal("");

  let logsContainer: HTMLDivElement | undefined;
  let unlistenLogs: UnlistenFn | undefined;

  // Load initial logs
  const loadLogs = async () => {
    try {
      const serverLogs = await invoke<LogEntry[]>("get_server_logs", {
        instanceId: props.instanceId,
      });
      setLogs(serverLogs);
    } catch (e) {
      // Console might not be initialized yet
      if (import.meta.env.DEV) {
        console.debug("[ClientConsole] Failed to load logs:", e);
      }
    }
  };

  // Subscribe to events
  onMount(async () => {
    await loadLogs();

    // Listen for new log entries (uses same event pattern as server console)
    unlistenLogs = await listen<LogEntry>(
      `server-log:${props.instanceId}`,
      (event) => {
        setLogs((prev) => [...prev, event.payload].slice(-2000)); // Keep more logs for clients
      }
    );

    onCleanup(() => {
      unlistenLogs?.();
    });
  });

  // Auto-scroll to bottom when new logs arrive
  createEffect(() => {
    if (autoScroll() && logsContainer && logs().length > 0) {
      logsContainer.scrollTop = logsContainer.scrollHeight;
    }
  });

  // Clear logs when client starts
  createEffect(() => {
    if (props.instanceStatus === "starting") {
      setLogs([]);
    }
  });

  // Refresh logs when running state changes
  createEffect(() => {
    if (props.isRunning) {
      loadLogs();
    }
  });

  // Handle scroll to detect if user scrolled up
  const handleScroll = () => {
    if (logsContainer) {
      const isAtBottom = logsContainer.scrollHeight - logsContainer.scrollTop - logsContainer.clientHeight < 50;
      setAutoScroll(isAtBottom);
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

  // Filter logs by level and search term
  const filteredLogs = () => {
    const level = filterLevel();
    const search = searchTerm().toLowerCase();

    let result = logs();

    if (level !== "all") {
      result = result.filter((log) => log.level === level);
    }

    if (search) {
      result = result.filter((log) => log.line.toLowerCase().includes(search));
    }

    return result;
  };

  // Clear logs
  const clearLogs = async () => {
    try {
      await invoke("clear_server_logs", { instanceId: props.instanceId });
      setLogs([]);
    } catch (e) {
      if (import.meta.env.DEV) {
        console.error("[ClientConsole] Failed to clear logs:", e);
      }
    }
  };

  // Copy logs to clipboard
  const copyLogs = async () => {
    const text = filteredLogs().map(l => l.line).join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API not available
    }
  };

  return (
    <div class="flex flex-col flex-1 min-h-0 gap-3">
      {/* Toolbar */}
      <div class="flex items-center justify-between gap-3 flex-shrink-0">
        {/* Status */}
        <div class="flex items-center gap-2 text-xs">
          <Show
            when={props.isRunning}
            fallback={
              <span class="flex items-center gap-1 text-gray-500">
                <i class="i-hugeicons-stop-circle w-3.5 h-3.5" />
                {t().console?.notRunning ?? "Not running"}
              </span>
            }
          >
            <span class="flex items-center gap-1 text-emerald-400">
              <i class="i-hugeicons-play-circle w-3.5 h-3.5" />
              {t().console?.running ?? "Running"}
            </span>
            <span class="text-gray-500">•</span>
            <span class="text-gray-400">{logs().length} {t().console?.lines ?? "lines"}</span>
          </Show>
        </div>

        {/* Actions */}
        <div class="flex items-center gap-1">
          {/* Search */}
          <input
            type="text"
            class="w-40 bg-gray-800/50 border border-gray-700 rounded px-2 py-1 text-xs text-gray-100 placeholder-gray-500 focus:border-[var(--color-primary)] focus:outline-none"
            placeholder={t().console?.search ?? "Search..."}
            value={searchTerm()}
            onInput={(e) => setSearchTerm(e.currentTarget.value)}
          />

          {/* Filter */}
          <Select
            value={filterLevel()}
            onChange={setFilterLevel}
            options={[
              { value: "all", label: t().server?.console?.filterAll ?? "All" },
              { value: "error", label: t().server?.console?.filterErrors ?? "Errors" },
              { value: "warn", label: "Warn" },
              { value: "info", label: "Info" },
              { value: "debug", label: "Debug" },
            ]}
            class="w-28"
          />

          {/* Copy logs */}
          <Tooltip text={t().console?.copy ?? "Copy logs"} position="bottom">
            <button
              class="p-1.5 rounded text-gray-400 hover:text-gray-200 hover:bg-gray-800"
              onClick={copyLogs}
            >
              <i class="i-hugeicons-copy-01 w-4 h-4" />
            </button>
          </Tooltip>

          {/* Clear logs */}
          <Tooltip text={t().server?.console?.clearLogs ?? "Clear"} position="bottom">
            <button
              class="p-1.5 rounded text-gray-400 hover:text-gray-200 hover:bg-gray-800"
              onClick={clearLogs}
            >
              <i class="i-hugeicons-delete-02 w-4 h-4" />
            </button>
          </Tooltip>

          {/* Auto-scroll toggle */}
          <Tooltip text={autoScroll() ? t().server?.console?.autoScrollOn ?? "Auto-scroll: ON" : t().server?.console?.autoScrollOff ?? "Auto-scroll: OFF"} position="bottom">
            <button
              class={`p-1.5 rounded ${autoScroll() ? "text-[var(--color-primary)] bg-[var(--color-primary-bg)]" : "text-gray-500 hover:text-gray-300"}`}
              onClick={() => setAutoScroll(!autoScroll())}
            >
              <i class="i-hugeicons-arrow-down-01 w-4 h-4" />
            </button>
          </Tooltip>
        </div>
      </div>

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
              <Show
                when={props.isRunning}
                fallback={t().console?.startToSee ?? "Start the game to see console output"}
              >
                {searchTerm() ? t().console?.noResults ?? "No matching logs" : t().server?.console?.waitingLogs ?? "Waiting for logs..."}
              </Show>
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

      {/* Info footer */}
      <div class="text-xs text-gray-500 flex-shrink-0">
        <i class="i-hugeicons-information-circle w-3.5 h-3.5 inline mr-1" />
        {t().console?.readOnly ?? "Read-only console. Logs are also saved to logs/latest-stdout.log"}
      </div>
    </div>
  );
};

export default ClientConsole;
