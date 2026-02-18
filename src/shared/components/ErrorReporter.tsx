import { createSignal, Show, onMount, onCleanup, For, createMemo } from "solid-js";
import type { Component } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useI18n } from "../i18n";
import { createFocusTrap } from "../hooks";

interface SystemInfo {
  os: string;
  os_version: string;
  arch: string;
  cpu_cores: number;
  total_memory_mb: number;
  app_version: string;
  rust_version: string;
}

interface ErrorReport {
  id: string;
  timestamp: string;
  error_type: string;
  error_message: string;
  stack_trace: string | null;
  context: string;
  system_info: SystemInfo;
  recent_logs: string[];
  screenshot_path: string | null;
}

interface CapturedError {
  id: string;
  reportId: string;
  errorType: string;
  errorMessage: string;
  stackTrace: string | null;
  context: string;
  timestamp: number;
  count: number;
  selected: boolean;
}

// Global error buffer
const capturedErrors: CapturedError[] = [];
let errorListeners: ((errors: CapturedError[]) => void)[] = [];

// Deduplication: track error signatures
const errorSignatures = new Map<string, { lastTime: number; count: number; errorId: string }>();
const DEDUP_COOLDOWN_MS = 60000; // 60 seconds between same errors

// Generate error signature for deduplication
function getErrorSignature(errorType: string, errorMessage: string): string {
  const normalized = errorMessage
    .replace(/\d{4}-\d{2}-\d{2}/g, "DATE")
    .replace(/\d{2}:\d{2}:\d{2}/g, "TIME")
    .replace(/:\d+:\d+/g, ":LINE:COL")
    .replace(/0x[a-f0-9]+/gi, "ADDR")
    .replace(/\d+/g, "N")
    .slice(0, 100);
  return `${errorType}:${normalized}`;
}

// Setup global error handler
function setupGlobalErrorHandler() {
  window.onerror = (message, source, lineno, colno, error) => {
    captureError("UncaughtError", String(message), error?.stack || null, `${source}:${lineno}:${colno}`);
    return false;
  };

  window.onunhandledrejection = (event) => {
    const error = event.reason;
    captureError(
      "UnhandledRejection",
      error?.message || String(error),
      error?.stack || null,
      "Promise rejection"
    );
  };
}

// Capture and create error report (with deduplication)
async function captureError(
  errorType: string,
  errorMessage: string,
  stackTrace: string | null,
  context: string
) {
  const now = Date.now();
  const signature = getErrorSignature(errorType, errorMessage);
  const existing = errorSignatures.get(signature);

  // Check if this is a duplicate within cooldown period
  if (existing && now - existing.lastTime < DEDUP_COOLDOWN_MS) {
    existing.count++;
    existing.lastTime = now;

    // Update existing error count
    const existingError = capturedErrors.find(e => e.id === existing.errorId);
    if (existingError) {
      existingError.count = existing.count;
      existingError.timestamp = now;
      errorListeners.forEach(fn => fn([...capturedErrors]));
    }
    return;
  }

  try {
    const report = await invoke<ErrorReport>("create_error_report", {
      errorType,
      errorMessage,
      stackTrace,
      context,
    });

    const errorId = `err_${now}`;
    errorSignatures.set(signature, { lastTime: now, count: 1, errorId });

    const capturedError: CapturedError = {
      id: errorId,
      reportId: report.id,
      errorType,
      errorMessage,
      stackTrace,
      context,
      timestamp: now,
      count: 1,
      selected: false,
    };

    capturedErrors.unshift(capturedError);
    if (capturedErrors.length > 50) capturedErrors.pop();

    errorListeners.forEach(fn => fn([...capturedErrors]));
  } catch (e) {
    if (import.meta.env.DEV) console.error("[ErrorReporter] Failed to capture error:", e);
  }

  // Cleanup old signatures
  for (const [sig, data] of errorSignatures) {
    if (now - data.lastTime > 300000) {
      errorSignatures.delete(sig);
    }
  }
}

// Export for manual error reporting
export async function reportError(
  errorType: string,
  errorMessage: string,
  context: string = "Manual report"
) {
  await captureError(errorType, errorMessage, null, context);
}

// Initialize once
let initialized = false;
function ensureInitialized() {
  if (!initialized) {
    setupGlobalErrorHandler();
    initialized = true;
  }
}

/** Inner panel component — mounts/unmounts with Show for correct focus trap */
const ErrorPanel: Component<{
  errors: CapturedError[];
  selectedErrors: CapturedError[];
  sending: boolean;
  onClose: () => void;
  onToggleSelect: (id: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onDeleteError: (id: string) => void;
  onClearAll: () => void;
  onSendReport: () => void;
}> = (panelProps) => {
  const { t } = useI18n();
  let panelRef: HTMLDivElement | undefined;
  createFocusTrap(() => panelRef);

  return (
    <div class="fixed inset-0 z-[100] bg-black/30 backdrop-blur-lg flex items-center justify-center p-4">
      <div ref={panelRef} tabIndex={-1} class="bg-[var(--color-bg-modal)] border border-[var(--color-border)] rounded-xl w-full max-w-2xl max-h-[80vh] flex flex-col">
        {/* Header */}
        <div class="px-4 py-3 border-b border-gray-750 flex items-center justify-between">
          <div class="flex items-center gap-3">
            <i class="i-hugeicons-alert-02 w-5 h-5 text-red-400" />
            <h2 class="text-lg font-medium">{t().errorReporter?.title || "Отчеты об ошибках"}</h2>
            <span class="text-sm text-gray-500">({panelProps.errors.length})</span>
          </div>
          <button
            class="p-1 text-gray-400 hover:text-[var(--color-text)]"
            onClick={panelProps.onClose}
          >
            <i class="i-hugeicons-cancel-01 w-5 h-5" />
          </button>
        </div>

        {/* Toolbar */}
        <div class="px-4 py-2 border-b border-gray-750 flex items-center justify-between bg-gray-900">
          <div class="flex items-center gap-2">
            <button
              class="px-2 py-1 text-xs text-gray-400 hover:text-[var(--color-text)] hover:bg-gray-800 rounded"
              onClick={panelProps.onSelectAll}
            >
              {t().errorReporter?.selectAll || "Выбрать все"}
            </button>
            <button
              class="px-2 py-1 text-xs text-gray-400 hover:text-[var(--color-text)] hover:bg-gray-800 rounded"
              onClick={panelProps.onDeselectAll}
            >
              {t().errorReporter?.deselect || "Снять выделение"}
            </button>
            <Show when={panelProps.selectedErrors.length > 0}>
              <span class="text-xs text-[var(--color-primary)]">
                {panelProps.selectedErrors.length} {t().errorReporter?.selected || "выбрано"}
              </span>
            </Show>
          </div>
          <div class="flex items-center gap-2">
            <button
              class="px-2 py-1 text-xs text-gray-400 hover:text-red-400 hover:bg-gray-800 rounded"
              onClick={panelProps.onClearAll}
            >
              {t().errorReporter?.clearAll || "Очистить все"}
            </button>
          </div>
        </div>

        {/* Error list */}
        <div class="flex-1 overflow-auto p-2">
          <Show when={panelProps.errors.length === 0}>
            <div class="text-center text-gray-500 py-8">
              {t().errorReporter?.noErrors || "Ошибок не обнаружено"}
            </div>
          </Show>
          <For each={panelProps.errors}>
            {(error) => (
              <div
                class={`p-3 mb-2 rounded-2xl border transition-colors cursor-pointer ${
                  error.selected
                    ? "bg-red-900/20 border-red-500/50"
                    : "bg-gray-900 border-gray-750 hover:border-gray-700"
                }`}
                onClick={() => panelProps.onToggleSelect(error.id)}
              >
                <div class="flex items-start gap-3">
                  {/* Checkbox */}
                  <div class={`mt-0.5 w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
                    error.selected
                      ? "bg-red-600 border-red-600"
                      : "border-gray-500 hover:border-gray-400"
                  }`}>
                    <Show when={error.selected}>
                      <i class="i-hugeicons-checkmark-circle-02 w-4 h-4 text-white" />
                    </Show>
                  </div>

                  {/* Content */}
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                      <span class="text-sm font-medium text-red-400">
                        {error.errorType}
                      </span>
                      <Show when={error.count > 1}>
                        <span class="px-1.5 py-0.5 text-[10px] font-bold bg-red-600 text-white rounded-full">
                          {error.count}x
                        </span>
                      </Show>
                      <span class="text-[10px] text-gray-500">
                        {new Date(error.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                    <p class="text-xs text-gray-400 mt-1 line-clamp-2">
                      {error.errorMessage}
                    </p>
                    <p class="text-[10px] text-gray-600 mt-1">
                      {error.context}
                    </p>
                  </div>

                  {/* Delete button */}
                  <button
                    class="p-1 text-gray-600 hover:text-red-400"
                    onClick={(e) => {
                      e.stopPropagation();
                      panelProps.onDeleteError(error.id);
                    }}
                  >
                    <i class="i-hugeicons-delete-02 w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </For>
        </div>

        {/* Footer with send button */}
        <div class="px-4 py-3 border-t border-gray-750 bg-gray-900">
          {/* Duplicate warning */}
          <div class="flex items-start gap-2 mb-3 p-2 bg-yellow-900/20 border border-yellow-500/30 rounded-2xl">
            <i class="i-hugeicons-information-circle w-4 h-4 text-yellow-400 mt-0.5 shrink-0" />
            <div class="text-xs text-yellow-200/80 inline-flex items-center gap-1 flex-wrap">
              <span><span class="font-medium">{t().errorReporter?.beforeReporting || "Перед отправкой"}:</span> {t().errorReporter?.checkDuplicates || "Проверьте, не была ли эта ошибка уже отправлена"}.</span>
              <button
                class="text-yellow-400 hover:text-yellow-300 underline"
                onClick={async () => {
                  const searchQuery = panelProps.selectedErrors.length > 0
                    ? panelProps.selectedErrors[0].errorType
                    : "is:issue is:open";
                  const url = `https://github.com/SibXoDev/stuzhik/issues?q=${encodeURIComponent(searchQuery)}`;
                  await openUrl(url);
                }}
              >
                {t().errorReporter?.searchIssues || "Поиск в GitHub"}
              </button>
            </div>
          </div>

          <div class="flex items-center justify-between">
            <p class="text-xs text-gray-500">
              {t().errorReporter?.selectToReport || "Выберите ошибки для отправки в GitHub"}
            </p>
            <button
              class="px-4 py-2 bg-red-600 hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm rounded-2xl flex items-center gap-2"
              onClick={panelProps.onSendReport}
              disabled={panelProps.selectedErrors.length === 0 || panelProps.sending}
            >
              <Show
                when={!panelProps.sending}
                fallback={<i class="i-svg-spinners-6-dots-scale w-4 h-4" />}
              >
                <i class="i-hugeicons-sent w-4 h-4" />
              </Show>
              {t().errorReporter?.report || "Отправить"} {panelProps.selectedErrors.length > 0 ? `(${panelProps.selectedErrors.length})` : ""}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export function ErrorReporter() {
  ensureInitialized();

  const [errors, setErrors] = createSignal<CapturedError[]>([]);
  const [showPanel, setShowPanel] = createSignal(false);
  const [sending, setSending] = createSignal(false);
  const [newErrorCount, setNewErrorCount] = createSignal(0);

  // Listen for new errors
  function onError(errs: CapturedError[]) {
    setErrors(errs);
    if (!showPanel()) {
      setNewErrorCount(prev => prev + 1);
    }
  }

  onMount(() => {
    errorListeners.push(onError);
    setErrors([...capturedErrors]);
  });

  onCleanup(() => {
    errorListeners = errorListeners.filter(fn => fn !== onError);
  });

  // Selected errors
  const selectedErrors = createMemo(() => errors().filter(e => e.selected));

  // Toggle error selection - create new objects for SolidJS reactivity
  function toggleSelect(id: string) {
    const idx = capturedErrors.findIndex(e => e.id === id);
    if (idx !== -1) {
      capturedErrors[idx] = { ...capturedErrors[idx], selected: !capturedErrors[idx].selected };
      setErrors([...capturedErrors]);
    }
  }

  // Select all - create new objects
  function selectAll() {
    for (let i = 0; i < capturedErrors.length; i++) {
      capturedErrors[i] = { ...capturedErrors[i], selected: true };
    }
    setErrors([...capturedErrors]);
  }

  // Deselect all - create new objects
  function deselectAll() {
    for (let i = 0; i < capturedErrors.length; i++) {
      capturedErrors[i] = { ...capturedErrors[i], selected: false };
    }
    setErrors([...capturedErrors]);
  }

  // Delete error from list
  function deleteError(id: string) {
    const idx = capturedErrors.findIndex(e => e.id === id);
    if (idx !== -1) {
      capturedErrors.splice(idx, 1);
      setErrors([...capturedErrors]);
    }
  }

  // Clear all errors
  function clearAll() {
    capturedErrors.length = 0;
    errorSignatures.clear();
    setErrors([]);
  }

  // Send selected errors as report
  async function sendSelectedReport() {
    const selected = selectedErrors();
    if (selected.length === 0) return;

    setSending(true);
    try {
      // If single error, use existing report
      if (selected.length === 1) {
        const url = await invoke<string>("generate_github_issue_url", { reportId: selected[0].reportId });
        await openUrl(url);
      } else {
        // Multiple errors - create combined report URL
        const systemInfo = await invoke<SystemInfo>("get_system_info_command");

        const errorsSection = selected.map((err, i) => `
### Error ${i + 1}: ${err.errorType}
**Message:** ${err.errorMessage}
**Context:** ${err.context}
**Count:** ${err.count}x
${err.stackTrace ? `\`\`\`\n${err.stackTrace}\n\`\`\`` : ""}`
        ).join("\n");

        const body = `## Combined Error Report (${selected.length} errors)

${errorsSection}

## System Information
- **OS:** ${systemInfo.os} (${systemInfo.os_version})
- **Architecture:** ${systemInfo.arch}
- **CPU Cores:** ${systemInfo.cpu_cores}
- **Memory:** ${systemInfo.total_memory_mb} MB
- **App Version:** ${systemInfo.app_version}

---
*This issue was auto-generated by Stuzhik Error Reporter*`;

        const title = encodeURIComponent(`[Bug] ${selected.length} errors: ${selected[0].errorType}${selected.length > 1 ? ` (+${selected.length - 1} more)` : ""}`);
        const bodyEncoded = encodeURIComponent(body);

        const url = `https://github.com/SibXoDev/stuzhik/issues/new?title=${title}&body=${bodyEncoded}&labels=bug`;
        await openUrl(url);
      }

      // Clear selected after sending
      selected.forEach(e => deleteError(e.id));
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to send report:", e);
    } finally {
      setSending(false);
    }
  }

  // Open panel
  function openPanel() {
    setShowPanel(true);
    setNewErrorCount(0);
  }

  // Recent errors (last 30 sec) for notification badge
  const recentErrors = createMemo(() => {
    const now = Date.now();
    return errors().filter(e => now - e.timestamp < 30000);
  });

  return (
    <>
      {/* Floating button with badge */}
      <Show when={errors().length > 0}>
        <button
          class="fixed bottom-4 right-4 z-[90] p-3 bg-red-600 hover:bg-red-500 text-white rounded-full shadow-lg flex items-center gap-2"
          onClick={openPanel}
        >
          <i class="i-hugeicons-alert-02 w-5 h-5" />
          <Show when={newErrorCount() > 0 || recentErrors().length > 0}>
            <span class="absolute -top-1 -right-1 px-1.5 py-0.5 text-xs font-bold bg-white text-red-600 rounded-full min-w-[20px] text-center">
              {newErrorCount() || recentErrors().length}
            </span>
          </Show>
        </button>
      </Show>

      {/* Error panel */}
      <Show when={showPanel()}>
        <ErrorPanel
          errors={errors()}
          selectedErrors={selectedErrors()}
          sending={sending()}
          onClose={() => setShowPanel(false)}
          onToggleSelect={toggleSelect}
          onSelectAll={selectAll}
          onDeselectAll={deselectAll}
          onDeleteError={deleteError}
          onClearAll={clearAll}
          onSendReport={sendSelectedReport}
        />
      </Show>
    </>
  );
}

export default ErrorReporter;
