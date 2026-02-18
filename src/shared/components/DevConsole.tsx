import { createSignal, onMount, onCleanup, For, Show, createEffect } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { invoke } from "@tauri-apps/api/core";
import { listen, emit, UnlistenFn } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { tsLogBuffer, tsLogListeners, type LogEntry } from "../utils/console-interceptor";

type ConsolePosition = "right" | "bottom";

interface ConsoleState {
  position: ConsolePosition;
  size: number;
}

interface DevConsoleProps {
  onClose: () => void;
  onResize?: (size: number, position: ConsolePosition) => void;
  /** If true, console is in detached window mode */
  detached?: boolean;
  /** Called when user clicks detach button (in embedded mode) */
  onDetach?: () => void;
}

// Storage key for persisting console state
const CONSOLE_STATE_KEY = "stuzhik-console-state";

function loadConsoleState(): ConsoleState {
  try {
    const saved = localStorage.getItem(CONSOLE_STATE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      return {
        position: parsed.position === "bottom" ? "bottom" : "right",
        size: typeof parsed.size === "number" ? Math.max(200, Math.min(900, parsed.size)) : 400,
      };
    }
  } catch {
    // Ignore errors
  }
  return { position: "right", size: 400 };
}

function saveConsoleState(state: ConsoleState) {
  try {
    localStorage.setItem(CONSOLE_STATE_KEY, JSON.stringify(state));
  } catch {
    // Ignore errors
  }
}

const GITHUB_ISSUES_URL = "https://github.com/SibXoDev/minecraft-modpack-constructor/issues/new";

// Fixed row height for log entries (in pixels)
const LOG_ROW_HEIGHT = 18;

// Virtualized log list component for performance
interface VirtualizedLogListProps {
  logs: LogEntry[];
  scrollContainerRef: HTMLDivElement | undefined;
  getLevelInfo: (level: string) => { color: string; label: string };
  autoScroll: boolean;
}

function VirtualizedLogList(props: VirtualizedLogListProps) {
  const virtualizer = createVirtualizer({
    get count() { return props.logs.length; },
    getScrollElement: () => props.scrollContainerRef ?? null,
    estimateSize: () => LOG_ROW_HEIGHT,
    overscan: 20, // Render extra rows above/below viewport for smooth scrolling
  });

  // Auto-scroll to bottom when new logs arrive
  createEffect(() => {
    if (props.autoScroll && props.logs.length > 0) {
      virtualizer.scrollToIndex(props.logs.length - 1, { align: "end" });
    }
  });

  return (
    <div
      style={{
        height: `${virtualizer.getTotalSize()}px`,
        width: "100%",
        position: "relative",
      }}
    >
      <For each={virtualizer.getVirtualItems()}>
        {(virtualRow) => {
          const entry = props.logs[virtualRow.index];
          const levelInfo = props.getLevelInfo(entry.level);

          return (
            <div
              data-index={virtualRow.index}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: `${LOG_ROW_HEIGHT}px`,
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <div class="flex gap-1.5 hover:bg-white/[0.02] px-1.5 py-px rounded group h-full items-center">
                <span class="text-gray-700 shrink-0 text-[10px] tabular-nums w-14">
                  {entry.timestamp.split(" ")[1]?.slice(0, 8) || entry.timestamp}
                </span>
                <span class={`shrink-0 w-8 text-center text-[9px] font-medium rounded-sm h-fit ${levelInfo.color}`}>
                  {levelInfo.label}
                </span>
                <span class={`shrink-0 w-4 text-center text-[9px] rounded-sm ${entry.source === "ts" ? "text-blue-500/70" : "text-orange-500/70"}`}>
                  {entry.source === "ts" ? "ts" : "rs"}
                </span>
                <span class="text-purple-500/50 shrink-0 w-16 truncate text-[10px]" title={entry.target}>
                  {entry.target}
                </span>
                <span class="text-gray-400 truncate min-w-0 flex-1">{entry.message}</span>
              </div>
            </div>
          );
        }}
      </For>
    </div>
  );
}

// Level display names (short)
const LEVEL_LABELS: Record<string, string> = {
  ERROR: "err",
  WARN: "warn",
  INFO: "info",
  DEBUG: "dbg",
  TRACE: "trc",
};

export function DevConsole(props: DevConsoleProps) {
  const initialState = loadConsoleState();

  const [logs, setLogs] = createSignal<LogEntry[]>([]);
  const [filter, setFilter] = createSignal("");
  const [levelFilter, setLevelFilter] = createSignal<string | null>(null);
  const [sourceFilter, setSourceFilter] = createSignal<"all" | "rust" | "ts">("all");
  const [autoScroll, setAutoScroll] = createSignal(true);
  const [logPath, setLogPath] = createSignal<string | null>(null);
  const [isLoading, setIsLoading] = createSignal(false);
  const [position, setPosition] = createSignal<ConsolePosition>(initialState.position);
  const [panelSize, setPanelSize] = createSignal(initialState.size);
  const [isResizing, setIsResizing] = createSignal(false);

  let containerRef: HTMLDivElement | undefined;

  // Save state when it changes
  createEffect(() => {
    saveConsoleState({ position: position(), size: panelSize() });
  });

  // Load all logs (Rust from file + TS from buffer)
  // Auto-scroll is handled by VirtualizedLogList when logs are loaded
  async function loadLogs() {
    setIsLoading(true);
    try {
      const entries = await invoke<LogEntry[]>("read_launcher_logs", { lines: 500 });
      const rustLogs = entries.map(e => ({ ...e, source: "rust" as const }));

      // Merge Rust logs from file + all TS logs from buffer
      const allLogs = [...rustLogs, ...tsLogBuffer]
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
        .slice(-1000);

      setLogs(allLogs);

      const path = await invoke<string>("get_current_log_path");
      setLogPath(path);
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to load logs:", e);
    } finally {
      setIsLoading(false);
    }
  }

  // Listen for new TS logs (reactive - while console is open)
  // Auto-scroll is handled by VirtualizedLogList
  function onTsLog(entry: LogEntry) {
    setLogs(prev => [...prev, entry].slice(-1000));
  }

  // Listen for new Rust logs (via Tauri events - real-time!)
  // Auto-scroll is handled by VirtualizedLogList
  function onRustLog(entry: LogEntry) {
    const rustEntry = { ...entry, source: "rust" as const };
    setLogs(prev => [...prev, rustEntry].slice(-1000));
  }

  let unlistenRustLogs: UnlistenFn | null = null;

  onMount(async () => {
    loadLogs();
    tsLogListeners.push(onTsLog);
    props.onResize?.(panelSize(), position());

    // Subscribe to real-time Rust logs
    unlistenRustLogs = await listen<LogEntry>("rust-log", (event) => {
      onRustLog(event.payload);
    });
  });

  onCleanup(() => {
    const index = tsLogListeners.indexOf(onTsLog);
    if (index > -1) {
      tsLogListeners.splice(index, 1);
    }
    unlistenRustLogs?.();
    props.onResize?.(0, position());
  });

  const filteredLogs = () => {
    let result = logs();

    if (sourceFilter() !== "all") {
      result = result.filter(l => l.source === sourceFilter());
    }

    if (levelFilter()) {
      result = result.filter(l => l.level === levelFilter());
    }

    const f = filter().toLowerCase();
    if (f) {
      result = result.filter(l =>
        l.message.toLowerCase().includes(f) ||
        l.target.toLowerCase().includes(f)
      );
    }

    return result;
  };

  function getLevelInfo(level: string): { color: string; label: string } {
    const upperLevel = level.toUpperCase();
    const label = LEVEL_LABELS[upperLevel] || level.toLowerCase().slice(0, 4);

    switch (upperLevel) {
      case "ERROR": return { color: "text-red-400 bg-red-500/20", label };
      case "WARN": return { color: "text-yellow-400 bg-yellow-500/20", label };
      case "INFO": return { color: "text-blue-400 bg-blue-500/20", label };
      case "DEBUG": return { color: "text-gray-400 bg-gray-500/20", label };
      case "TRACE": return { color: "text-gray-500 bg-gray-500/10", label };
      default: return { color: "text-gray-300", label };
    }
  }

  function clearConsole() {
    setLogs([]);
    tsLogBuffer.length = 0;
  }

  async function copyLogs() {
    const text = filteredLogs()
      .map(l => `[${l.timestamp} ${l.level} ${l.target}] ${l.message}`)
      .join("\n");
    await navigator.clipboard.writeText(text);
  }

  async function exportLogs() {
    try {
      const path = await save({
        defaultPath: `stuzhik-logs-${new Date().toISOString().slice(0, 10)}.log`,
        filters: [{ name: "Log files", extensions: ["log", "txt"] }]
      });

      if (path) {
        const systemInfo = [
          `=== Stuzhik Log Export ===`,
          `Date: ${new Date().toISOString()}`,
          `Platform: ${navigator.platform}`,
          `Log file: ${logPath() || "unknown"}`,
          `Total entries: ${logs().length}`,
          ``,
          `=== LOGS ===`,
          ``
        ].join("\n");

        const logText = logs()
          .map(l => `[${l.timestamp} ${l.level} ${l.source || "?"} ${l.target}] ${l.message}`)
          .join("\n");

        await writeTextFile(path, systemInfo + logText);
      }
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to export logs:", e);
    }
  }

  async function openLogFolder() {
    const path = logPath();
    if (path) {
      try {
        // Use revealItemInDir to open folder with file selected
        await revealItemInDir(path);
      } catch (e) {
        if (import.meta.env.DEV) console.error("Failed to open log folder:", e);
      }
    }
  }

  async function openBugReport() {
    try {
      const errorLogs = logs()
        .filter(l => l.level === "ERROR")
        .slice(-10)
        .map(l => `[${l.timestamp}] ${l.message}`)
        .join("\n");

      const body = encodeURIComponent(`
## Description
<!-- Describe the bug -->

## Steps to Reproduce
1.
2.
3.

## Expected Behavior
<!-- What should happen -->

## Actual Behavior
<!-- What actually happens -->

## Environment
- Platform: ${navigator.platform}
- Log file: ${logPath() || "unknown"}

## Recent Errors
\`\`\`
${errorLogs || "No recent errors"}
\`\`\`
`);

      await openUrl(`${GITHUB_ISSUES_URL}?labels=bug&body=${body}`);
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to open bug report:", e);
    }
  }

  // Resize handler
  function startResize(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);

    const startX = e.clientX;
    const startY = e.clientY;
    const startSize = panelSize();

    const onMouseMove = (e: MouseEvent) => {
      let newSize: number;
      if (position() === "right") {
        const delta = startX - e.clientX;
        newSize = Math.max(280, Math.min(900, startSize + delta));
      } else {
        const delta = startY - e.clientY;
        newSize = Math.max(180, Math.min(700, startSize + delta));
      }
      setPanelSize(newSize);
      props.onResize?.(newSize, position());
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setIsResizing(false);
    };

    document.body.style.cursor = position() === "right" ? "ew-resize" : "ns-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }

  function changePosition(newPos: ConsolePosition) {
    setPosition(newPos);
    const newSize = newPos === "right" ? 400 : 300;
    setPanelSize(newSize);
    props.onResize?.(newSize, newPos);
  }

  // Detach console to separate window
  async function detachConsole() {
    try {
      // Create new window with console-only mode
      const consoleWindow = new WebviewWindow("console", {
        url: "index.html?mode=console",
        title: "Stuzhik Console",
        width: 800,
        height: 600,
        minWidth: 400,
        minHeight: 300,
        decorations: true,
        transparent: false,
        resizable: true,
        center: true,
      });

      // Listen for window creation
      consoleWindow.once("tauri://created", () => {
        // Notify main window that console was detached
        emit("console-detached");
        props.onDetach?.();
      });

      consoleWindow.once("tauri://error", (e) => {
        if (import.meta.env.DEV) console.error("Failed to create console window:", e);
      });
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to detach console:", e);
    }
  }

  // Track error/warn counts
  const errorCount = () => logs().filter(l => l.level === "ERROR").length;
  const warnCount = () => logs().filter(l => l.level === "WARN").length;

  return (
    <div
      class={`bg-gray-950 flex flex-col shadow-2xl ${
        props.detached
          ? "h-full w-full"
          : `border-gray-800/60 shrink-0 z-[55] ${
              position() === "right"
                ? "border-l h-full"
                : "border-t w-full"
            }`
      }`}
      style={props.detached
        ? undefined
        : position() === "right"
          ? { width: `${panelSize()}px` }
          : { height: `${panelSize()}px` }
      }
    >
      {/* Resize handle - only in embedded mode */}
      <Show when={!props.detached}>
        <div
          class={`absolute z-10 group ${
            position() === "right"
              ? "left-0 top-0 bottom-0 w-1 cursor-ew-resize"
              : "left-0 right-0 top-0 h-1 cursor-ns-resize"
          }`}
          onMouseDown={startResize}
        >
          {/* Invisible hit area */}
          <div class={`absolute ${
            position() === "right"
              ? "-left-1 top-0 bottom-0 w-3"
              : "left-0 right-0 -top-1 h-3"
          }`} />
          {/* Visual line - subtle on hover, visible when resizing */}
          <div class={`absolute transition-all duration-100 ${
            position() === "right"
              ? `left-0 top-0 bottom-0 w-px ${isResizing() ? "bg-gray-500" : "bg-gray-800 group-hover:bg-gray-600"}`
              : `left-0 right-0 top-0 h-px ${isResizing() ? "bg-gray-500" : "bg-gray-800 group-hover:bg-gray-600"}`
          }`} />
        </div>
      </Show>

      {/* Header - responsive with flex-wrap */}
      <div class="flex flex-wrap items-center gap-1 px-2 py-1.5 border-b border-gray-800/60 bg-gray-925 shrink-0">
        {/* Left: Title and stats */}
        <div class="flex items-center gap-2 mr-auto">
          <span class="text-xs font-medium text-gray-300">Console</span>
          <Show when={errorCount() > 0}>
            <span class="px-1 py-0.5 text-[10px] rounded bg-red-500/20 text-red-400 font-medium">
              {errorCount()}
            </span>
          </Show>
          <Show when={warnCount() > 0}>
            <span class="px-1 py-0.5 text-[10px] rounded bg-yellow-500/20 text-yellow-400 font-medium">
              {warnCount()}
            </span>
          </Show>
        </div>

        {/* Filters row */}
        <div class="flex items-center gap-1">
          {/* Source filter */}
          <div class="flex gap-px bg-gray-800/40 rounded p-0.5">
            <button
              class={`px-1.5 py-0.5 text-[10px] rounded transition-colors ${sourceFilter() === "all" ? "bg-gray-700 text-gray-200" : "text-gray-500 hover:text-gray-300"}`}
              onClick={() => setSourceFilter("all")}
            >all</button>
            <button
              class={`px-1.5 py-0.5 text-[10px] rounded transition-colors ${sourceFilter() === "rust" ? "bg-orange-600/80 text-white" : "text-orange-400/60 hover:text-orange-400"}`}
              onClick={() => setSourceFilter("rust")}
            >rs</button>
            <button
              class={`px-1.5 py-0.5 text-[10px] rounded transition-colors ${sourceFilter() === "ts" ? "bg-blue-600/80 text-white" : "text-blue-400/60 hover:text-blue-400"}`}
              onClick={() => setSourceFilter("ts")}
            >ts</button>
          </div>

          {/* Level filter */}
          <div class="flex gap-px">
            {["ERROR", "WARN", "INFO", "DEBUG"].map(level => (
              <button
                class={`px-1.5 py-0.5 text-[10px] rounded transition-colors ${
                  levelFilter() === level
                    ? level === "ERROR" ? "bg-red-600/80 text-white"
                      : level === "WARN" ? "bg-yellow-600/80 text-white"
                      : level === "INFO" ? "bg-blue-600/80 text-white"
                      : "bg-gray-600/80 text-white"
                    : "text-gray-600 hover:text-gray-400"
                }`}
                onClick={() => setLevelFilter(levelFilter() === level ? null : level)}
                title={level}
              >
                {LEVEL_LABELS[level]}
              </button>
            ))}
          </div>

          {/* Search */}
          <input
            type="text"
            placeholder="Filter..."
            class="px-1.5 py-0.5 text-[10px] bg-gray-900 border border-gray-800 rounded text-gray-300 w-16 focus:outline-none focus:border-gray-600 placeholder-gray-600"
            value={filter()}
            onInput={(e) => setFilter(e.currentTarget.value)}
          />
        </div>

        {/* Actions row */}
        <div class="flex items-center gap-0.5">
          {/* Position toggles - only in embedded mode */}
          <Show when={!props.detached}>
            <button
              class={`p-1 rounded transition-colors ${position() === "right" ? "bg-gray-700 text-gray-200" : "text-gray-600 hover:text-gray-400"}`}
              onClick={() => changePosition("right")}
              title="Dock right"
            >
              <i class="i-hugeicons-sidebar-right w-3 h-3" />
            </button>
            <button
              class={`p-1 rounded transition-colors ${position() === "bottom" ? "bg-gray-700 text-gray-200" : "text-gray-600 hover:text-gray-400"}`}
              onClick={() => changePosition("bottom")}
              title="Dock bottom"
            >
              <i class="i-hugeicons-layout-bottom w-3 h-3" />
            </button>

            <div class="w-px h-3 bg-gray-800 mx-0.5" />
          </Show>

          {/* Actions */}
          <button
            class="p-1 text-gray-600 hover:text-gray-300 rounded transition-colors"
            onClick={loadLogs}
            title="Refresh"
          >
            <i class="i-hugeicons-refresh w-3 h-3" />
          </button>
          <button
            class="p-1 text-gray-600 hover:text-gray-300 rounded transition-colors"
            onClick={exportLogs}
            title="Export"
          >
            <i class="i-hugeicons-share-01 w-3 h-3" />
          </button>
          <button
            class="p-1 text-gray-600 hover:text-gray-300 rounded transition-colors"
            onClick={copyLogs}
            title="Copy"
          >
            <i class="i-hugeicons-copy-01 w-3 h-3" />
          </button>
          <button
            class="p-1 text-gray-600 hover:text-gray-300 rounded transition-colors"
            onClick={clearConsole}
            title="Clear"
          >
            <i class="i-hugeicons-delete-02 w-3 h-3" />
          </button>
          <button
            class={`p-1 rounded transition-colors ${autoScroll() ? "text-[var(--color-primary)] bg-[var(--color-primary-bg)]" : "text-gray-600 hover:text-gray-300"}`}
            onClick={() => setAutoScroll(!autoScroll())}
            title="Auto-scroll"
          >
            <i class="i-hugeicons-arrow-down-01 w-3 h-3" />
          </button>

          <div class="w-px h-3 bg-gray-800 mx-0.5" />

          <button
            class="p-1 text-gray-600 hover:text-orange-400 rounded transition-colors"
            onClick={openBugReport}
            title="Report bug"
          >
            <i class="i-hugeicons-bug-01 w-3 h-3" />
          </button>

          {/* Detach button - only in embedded mode */}
          <Show when={!props.detached}>
            <button
              class="p-1 text-gray-600 hover:text-purple-400 rounded transition-colors"
              onClick={detachConsole}
              title="Open in separate window"
            >
              <i class="i-hugeicons-browser w-3 h-3" />
            </button>
          </Show>

          <button
            class="p-1 text-gray-600 hover:text-red-400 rounded transition-colors"
            onClick={props.onClose}
            title={props.detached ? "Close window" : "Close console"}
          >
            <i class="i-hugeicons-cancel-01 w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Log content - virtualized for performance */}
      <div
        ref={containerRef}
        class="flex-1 overflow-auto font-mono text-[11px] leading-[1.4] min-h-0"
      >
        <Show when={isLoading()}>
          <div class="text-gray-600 text-center py-4 text-[10px]">Loading logs...</div>
        </Show>
        <Show when={!isLoading() && filteredLogs().length === 0}>
          <div class="text-gray-600 text-center py-4 text-[10px]">No logs</div>
        </Show>
        <Show when={!isLoading() && filteredLogs().length > 0}>
          <VirtualizedLogList
            logs={filteredLogs()}
            scrollContainerRef={containerRef}
            getLevelInfo={getLevelInfo}
            autoScroll={autoScroll()}
          />
        </Show>
      </div>

      {/* Footer - minimal */}
      <div class="px-2 py-1 border-t border-gray-800/60 bg-gray-925 text-[10px] flex items-center justify-between shrink-0">
        <span
          class="text-gray-600 hover:text-blue-400 hover:underline truncate cursor-pointer"
          onClick={openLogFolder}
          title="Open log folder"
        >
          {logPath() || "..."}
        </span>
        <span class="text-gray-700 shrink-0">{filteredLogs().length} logs</span>
      </div>
    </div>
  );
}
