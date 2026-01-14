import { Component, createSignal, createEffect, Show, onCleanup } from "solid-js";
import { highlightCode, detectLanguage, escapeHtml } from "../utils/highlighter";
import { useSafeTimers } from "../hooks";
import { useI18n } from "../i18n";

interface CodeViewerProps {
  code: string;
  language?: string;
  filename?: string;
  showLineNumbers?: boolean;
  showHeader?: boolean;
  maxHeight?: string;
  class?: string;
  /** Minimal mode - no container styling, just raw highlighted code */
  minimal?: boolean;
}

const CodeViewer: Component<CodeViewerProps> = (props) => {
  const { t } = useI18n();
  const [html, setHtml] = createSignal("");
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [copied, setCopied] = createSignal(false);
  const { setTimeout: safeTimeout } = useSafeTimers();

  // NOTE: Using sync wrapper to avoid SolidJS async effect issues
  createEffect(() => {
    const code = props.code;
    if (!code) {
      setHtml("");
      setLoading(false);
      setError(null);
      return;
    }

    // Track request to handle race conditions
    const requestId = Date.now();
    (window as any).__lastCodeViewerRequest = requestId;

    setLoading(true);
    setError(null);

    const lang = detectLanguage(props.filename, props.language);

    // Safety timeout - ensure loading state is cleared even if highlighter hangs
    const safetyTimeout = setTimeout(() => {
      if ((window as any).__lastCodeViewerRequest === requestId) {
        console.warn("[CodeViewer] Safety timeout - highlighter might be stuck");
        setError("Timeout");
        setHtml(`<pre class="shiki"><code>${escapeHtml(code)}</code></pre>`);
        setLoading(false);
      }
    }, 15000);

    // Cleanup timeout on effect re-run or unmount
    onCleanup(() => clearTimeout(safetyTimeout));

    highlightCode(code, lang)
      .then((result) => {
        clearTimeout(safetyTimeout);
        if ((window as any).__lastCodeViewerRequest === requestId) {
          setHtml(result);
          setLoading(false);
          setError(null);
        }
      })
      .catch((e) => {
        clearTimeout(safetyTimeout);
        if ((window as any).__lastCodeViewerRequest === requestId) {
          console.error("Failed to highlight code:", e);
          setError((e as Error).message);
          // Fallback to plain text
          setHtml(`<pre class="shiki"><code>${escapeHtml(code)}</code></pre>`);
          setLoading(false);
        }
      });
  });

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(props.code);
      setCopied(true);
      safeTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error("Failed to copy:", e);
    }
  };

  const showHeader = () => props.showHeader !== false && props.filename && !props.minimal;

  // Minimal mode - just raw Shiki output with optional line numbers
  if (props.minimal) {
    return (
      <Show when={!loading()} fallback={
        <div class="flex-center p-4">
          <i class="i-svg-spinners-ring-resize w-5 h-5 text-gray-500" />
        </div>
      }>
        <div classList={{ "line-numbers": props.showLineNumbers }} innerHTML={html()} />
      </Show>
    );
  }

  return (
    <div class={`code-viewer rounded-lg overflow-hidden bg-[#0d1117] flex flex-col ${props.class || ""}`}>
      {/* Header */}
      <Show when={showHeader()}>
        <div class="flex items-center justify-between px-3 py-2 bg-gray-900/50 border-b border-gray-800 flex-shrink-0">
          <div class="flex items-center gap-2 text-sm text-gray-400">
            <i class={`w-4 h-4 ${getFileIcon(props.filename || "")}`} />
            <span class="font-mono">{props.filename}</span>
          </div>
          <button
            class="p-1.5 rounded hover:bg-gray-800 transition-colors text-gray-500 hover:text-gray-300"
            onClick={handleCopy}
            title={t().ui?.tooltips?.copy ?? "Copy"}
          >
            <Show when={copied()} fallback={<i class="i-hugeicons-copy-01 w-4 h-4" />}>
              <i class="i-hugeicons-checkmark-circle-02 w-4 h-4 text-green-400" />
            </Show>
          </button>
        </div>
      </Show>

      {/* Code content - flex-1 with min-h-0 for proper scroll in flex container */}
      <div
        class="overflow-auto flex-1 min-h-0"
        style={{ "max-height": props.maxHeight === "100%" ? undefined : props.maxHeight || "none" }}
      >
        <Show when={loading()}>
          <div class="flex-center p-4">
            <i class="i-svg-spinners-ring-resize w-5 h-5 text-gray-500" />
          </div>
        </Show>

        <Show when={!loading() && error()}>
          <div class="p-3 text-sm text-red-400">
            Ошибка подсветки: {error()}
          </div>
        </Show>

        <Show when={!loading()}>
          <div
            class="code-content text-sm"
            classList={{ "line-numbers": props.showLineNumbers }}
            innerHTML={html()}
          />
        </Show>
      </div>
    </div>
  );
};

function getFileIcon(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
      return "i-hugeicons-java-script text-blue-400";
    case "js":
    case "jsx":
      return "i-hugeicons-java-script text-yellow-400";
    case "rs":
      return "i-hugeicons-code text-orange-400";
    case "json":
    case "json5":
      return "i-hugeicons-code-square text-yellow-400";
    case "toml":
      return "i-hugeicons-settings-02 text-gray-400";
    case "yaml":
    case "yml":
      return "i-hugeicons-list-view text-red-400";
    case "md":
    case "mdx":
      return "i-hugeicons-text text-blue-400";
    case "css":
    case "scss":
      return "i-hugeicons-paint-board text-purple-400";
    case "html":
      return "i-hugeicons-code text-orange-400";
    default:
      return "i-hugeicons-file-01 text-gray-400";
  }
}

export default CodeViewer;
