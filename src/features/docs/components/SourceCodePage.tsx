import { Component, createSignal, createMemo, createEffect, Show, For, onMount, onCleanup, batch } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { openUrl } from "@tauri-apps/plugin-opener";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
// JSZip is lazy-loaded only when downloading ZIP to reduce initial bundle size
import { sourceBundle, type FileNode, type FileChange } from "../../../generated/source-code";
import { highlightCode, detectLanguage, resetHighlighter } from "../../../shared/utils/highlighter";
import { MarkdownRenderer } from "../../../shared/components/MarkdownRenderer";
import { addToast } from "../../../shared/components/Toast";
import { useSafeTimers } from "../../../shared/hooks";
import { formatSize } from "../../../shared/utils/format-size";
import { useI18n } from "../../../shared/i18n";
import { Tooltip } from "../../../shared/ui";

interface Props {
  onClose: () => void;
  /** Initial file path to open */
  initialPath?: string;
  /** Initial line to scroll to (1-indexed) */
  initialLine?: number;
}

type Tab = "files" | "changes";

// Extensions for images
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico"]);

// MD files in these paths should show as code by default (documentation source)
const CODE_MD_PATTERNS = [/^docs\//, /\.vitepress\//];

// Language colors (GitHub style)
const LANG_COLORS: Record<string, string> = {
  rs: "#dea584",
  rust: "#dea584",
  ts: "#3178c6",
  typescript: "#3178c6",
  tsx: "#3178c6",
  js: "#f1e05a",
  javascript: "#f1e05a",
  jsx: "#f1e05a",
  css: "#563d7c",
  html: "#e34c26",
  json: "#292929",
  toml: "#9c4221",
  yaml: "#cb171e",
  yml: "#cb171e",
  md: "#083fa1",
  markdown: "#083fa1",
};

const LANG_NAMES: Record<string, string> = {
  rs: "Rust",
  ts: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  css: "CSS",
  html: "HTML",
  json: "JSON",
  toml: "TOML",
  yaml: "YAML",
  yml: "YAML",
  md: "Markdown",
};

// Отслеживание актуального запроса подсветки (вместо window as any)
let lastHighlightRequest = 0;

const SourceCodePage: Component<Props> = (props) => {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = createSignal<Tab>("files");
  const [selectedPath, setSelectedPath] = createSignal<string | null>(null);
  const [expandedDirs, setExpandedDirs] = createSignal<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = createSignal("");
  const [useRegex, setUseRegex] = createSignal(false);
  const [regexError, setRegexError] = createSignal<string | null>(null);
  const [copied, setCopied] = createSignal(false);
  const [fileCopied, setFileCopied] = createSignal(false);
  const [showRawMd, setShowRawMd] = createSignal(false);
  const [codeHtml, setCodeHtml] = createSignal("");
  const [codeLoading, setCodeLoading] = createSignal(false);
  const [codeError, setCodeError] = createSignal<string | null>(null);
  const { setTimeout: safeTimeout } = useSafeTimers();
  const fmtSize = (bytes: number) => formatSize(bytes, t().ui?.units);

  let filesScrollRef: HTMLDivElement | undefined;
  let changesScrollRef: HTMLDivElement | undefined;
  let contentScrollRef: HTMLDivElement | undefined;

  // Sort nodes: directories first, then alphabetically
  const sortNodes = (nodes: FileNode[]): FileNode[] => {
    return [...nodes].sort((a, b) => {
      if (a.type === "directory" && b.type !== "directory") return -1;
      if (a.type !== "directory" && b.type === "directory") return 1;
      return a.name.localeCompare(b.name, "ru");
    });
  };

  // Search matcher - supports regex or plain text
  const matchesSearch = (path: string): boolean => {
    const query = searchQuery();
    if (!query) return true;

    if (useRegex()) {
      try {
        const regex = new RegExp(query, "i");
        setRegexError(null);
        return regex.test(path);
      } catch (e) {
        setRegexError((e as Error).message);
        return true; // Show all on error
      }
    } else {
      return path.toLowerCase().includes(query.toLowerCase());
    }
  };

  // Flatten tree for virtualization
  const flattenedTree = createMemo(() => {
    const result: { node: FileNode; depth: number }[] = [];
    const expanded = expandedDirs();

    function traverse(nodes: FileNode[], depth: number) {
      const sorted = sortNodes(nodes);
      for (const node of sorted) {
        if (!matchesSearch(node.path)) {
          if (node.type === "directory" && node.children) {
            const hasMatch = node.children.some((c: FileNode) => matchesSearch(c.path));
            if (!hasMatch) continue;
          } else {
            continue;
          }
        }

        result.push({ node, depth });

        if (node.type === "directory" && node.children && expanded.has(node.path)) {
          traverse(node.children, depth + 1);
        }
      }
    }

    traverse(sourceBundle.tree, 0);
    return result;
  });

  // Filter changes by search query
  const filteredChanges = createMemo(() => {
    const changes = sourceBundle.changes?.changes || [];
    if (!searchQuery()) return changes;
    return changes.filter((c: FileChange) => matchesSearch(c.path));
  });

  // Virtualizers - only create when tab is active AND refs are ready
  const [filesReady, setFilesReady] = createSignal(false);
  const [changesReady, setChangesReady] = createSignal(false);

  // Store initial line to scroll to
  const [pendingScrollLine, setPendingScrollLine] = createSignal<number | null>(null);

  onMount(() => {
    // Mark files tab ready after mount
    setFilesReady(true);

    // Open initial file if provided
    if (props.initialPath && sourceBundle.files[props.initialPath]) {
      expandToPath(props.initialPath);
      setSelectedPath(props.initialPath);
      if (props.initialLine) {
        setPendingScrollLine(props.initialLine);
      }
      // Scroll to file in tree after virtualizer is ready
      safeTimeout(() => {
        scrollToFile(props.initialPath!);
      }, 100);
    }
  });

  // Scroll to line after code is rendered
  createEffect(() => {
    const line = pendingScrollLine();
    const html = codeHtml();
    if (line && html && !codeLoading()) {
      // Wait for DOM update
      requestAnimationFrame(() => {
        const lineEl = document.querySelector(`.shiki code .line:nth-child(${line})`);
        if (lineEl) {
          lineEl.scrollIntoView({ behavior: "smooth", block: "center" });
          // Highlight the line temporarily
          lineEl.classList.add("bg-blue-500/20");
          safeTimeout(() => lineEl.classList.remove("bg-blue-500/20"), 2000);
        }
        setPendingScrollLine(null);
      });
    }
  });

  const filesVirtualizer = createMemo(() => {
    if (activeTab() !== "files" || !filesReady()) return null;
    const count = flattenedTree().length;
    return createVirtualizer({
      count,
      getScrollElement: () => filesScrollRef ?? null,
      estimateSize: () => 32,
      overscan: 10,
    });
  });

  const changesVirtualizer = createMemo(() => {
    if (activeTab() !== "changes" || !changesReady()) return null;
    const count = filteredChanges().length;
    return createVirtualizer({
      count,
      getScrollElement: () => changesScrollRef ?? null,
      estimateSize: () => 40,
      overscan: 10,
    });
  });

  const toggleDir = (path: string) => {
    const expanded = new Set(expandedDirs());
    if (expanded.has(path)) {
      expanded.delete(path);
    } else {
      expanded.add(path);
    }
    setExpandedDirs(expanded);
  };

  // Expand all parent directories for a given path
  const expandToPath = (filePath: string) => {
    const parts = filePath.split("/");
    const expanded = new Set(expandedDirs());
    let current = "";
    for (let i = 0; i < parts.length - 1; i++) {
      current = current ? `${current}/${parts[i]}` : parts[i];
      expanded.add(current);
    }
    setExpandedDirs(expanded);
  };

  // Find index of file in flattened tree and scroll to it
  const scrollToFile = (filePath: string) => {
    // First expand all parent folders
    expandToPath(filePath);

    // Wait for DOM update then scroll
    requestAnimationFrame(() => {
      const tree = flattenedTree();
      const index = tree.findIndex(item => item.node.path === filePath);
      if (index >= 0 && filesVirtualizer()) {
        filesVirtualizer()?.scrollToIndex(index, { align: "center" });
      }
    });
  };

  const selectFile = (node: FileNode) => {
    if (node.type === "file") {
      setSelectedPath(node.path);
      setShowRawMd(false);
    } else {
      toggleDir(node.path);
    }
  };

  const selectChangedFile = (change: FileChange) => {
    if (change.type !== "deleted") {
      batch(() => {
        setSelectedPath(change.path);
        setActiveTab("files");
        setShowRawMd(false);
      });
      // Scroll to file in tree after tab switch
      safeTimeout(() => scrollToFile(change.path), 50);
    }
  };

  const selectedContent = createMemo(() => {
    const path = selectedPath();
    if (!path) return null;
    return sourceBundle.files[path] || null;
  });

  // Reset scroll when file changes
  createEffect(() => {
    selectedPath(); // Track dependency
    if (contentScrollRef) {
      contentScrollRef.scrollTop = 0;
    }
  });

  // Syntax highlight when file changes
  // NOTE: Using sync wrapper to avoid SolidJS async effect issues
  createEffect(() => {
    const content = selectedContent();
    const path = selectedPath();
    if (!content || !path || isImage() || shouldRenderAsPrettyMd()) {
      setCodeHtml("");
      setCodeLoading(false);
      setCodeError(null);
      return;
    }

    const requestId = ++lastHighlightRequest;

    setCodeLoading(true);
    setCodeError(null);

    const lang = detectLanguage(path);
    if (import.meta.env.DEV) console.log("[SourceCodePage] Highlighting", path, "as", lang);

    // Safety timeout — если highlighter зависнет
    const safetyTimeout = setTimeout(() => {
      if (lastHighlightRequest === requestId) {
        if (import.meta.env.DEV) console.warn("[SourceCodePage] Safety timeout - highlighter might be stuck");
        setCodeError("Подсветка синтаксиса недоступна (timeout)");
        setCodeHtml(`<pre class="shiki"><code>${escapeHtmlBasic(content)}</code></pre>`);
        setCodeLoading(false);
      }
    }, 15000);

    onCleanup(() => clearTimeout(safetyTimeout));

    highlightCode(content, lang)
      .then((html) => {
        clearTimeout(safetyTimeout);
        if (lastHighlightRequest === requestId) {
          const isFallback = html.includes("shiki-fallback");
          if (import.meta.env.DEV) console.log("[SourceCodePage] Highlight done:", isFallback ? "fallback (plain text)" : "success", "HTML length:", html.length);
          setCodeHtml(html);
          setCodeLoading(false);
          setCodeError(null);
        }
      })
      .catch((e) => {
        clearTimeout(safetyTimeout);
        if (import.meta.env.DEV) console.error("[SourceCodePage] Failed to highlight:", e);
        if (lastHighlightRequest === requestId) {
          const errorMsg = e instanceof Error ? e.message : String(e);
          setCodeError(errorMsg);
          setCodeHtml(`<pre class="shiki"><code>${escapeHtmlBasic(content)}</code></pre>`);
          setCodeLoading(false);
        }
      });
  });

  // Simple HTML escape for fallback (avoiding circular import)
  const escapeHtmlBasic = (text: string): string => {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  };

  // Retry highlighting
  const retryHighlight = () => {
    resetHighlighter();
    // Trigger re-run by toggling a signal
    const path = selectedPath();
    setSelectedPath(null);
    safeTimeout(() => setSelectedPath(path), 10);
  };

  const getFileExt = (path: string): string => {
    const lastDot = path.lastIndexOf(".");
    return lastDot >= 0 ? path.slice(lastDot).toLowerCase() : "";
  };

  const isMarkdown = () => {
    const path = selectedPath();
    if (!path) return false;
    const ext = getFileExt(path);
    return ext === ".md" || ext === ".mdx";
  };

  const shouldShowMdAsCode = () => {
    const path = selectedPath();
    if (!path || !isMarkdown()) return false;
    return CODE_MD_PATTERNS.some(pattern => pattern.test(path));
  };

  const isImage = () => {
    const path = selectedPath();
    if (!path) return false;
    return IMAGE_EXTENSIONS.has(getFileExt(path));
  };

  const getFileName = () => {
    const path = selectedPath();
    if (!path) return "";
    return path.split("/").pop() || path;
  };

  const getFileIcon = (node: FileNode): string => {
    if (node.type === "directory") {
      return expandedDirs().has(node.path)
        ? "i-hugeicons-folder-open text-yellow-400"
        : "i-hugeicons-folder-01 text-yellow-400";
    }
    return getFileIconByExt(node.name);
  };

  const getFileIconByExt = (filename: string): string => {
    const ext = filename.split(".").pop()?.toLowerCase();
    switch (ext) {
      case "ts": return "i-hugeicons-java-script text-blue-400";
      case "tsx": return "i-hugeicons-java-script text-blue-500";
      case "js": return "i-hugeicons-java-script text-yellow-400";
      case "jsx": return "i-hugeicons-java-script text-yellow-500";
      case "rs": return "i-hugeicons-code text-orange-500";
      case "json": return "i-hugeicons-code-square text-yellow-300";
      case "toml": return "i-hugeicons-settings-02 text-gray-400";
      case "md": case "mdx": return "i-hugeicons-text text-blue-300";
      case "css": return "i-hugeicons-paint-board text-purple-400";
      case "html": return "i-hugeicons-code text-orange-400";
      case "yaml": case "yml": return "i-hugeicons-list-view text-pink-400";
      case "png": case "jpg": case "jpeg": case "gif": case "webp": case "svg": case "ico":
        return "i-hugeicons-image-01 text-green-400";
      default: return "i-hugeicons-file-01 text-gray-400";
    }
  };

  const getChangeTypeStyle = (type: FileChange["type"]) => {
    switch (type) {
      case "added": return { border: "border-green-500/30", bg: "bg-green-500/10", text: "text-green-400", icon: "i-hugeicons-add-circle text-green-400" };
      case "modified": return { border: "border-yellow-500/30", bg: "bg-yellow-500/10", text: "text-yellow-400", icon: "i-hugeicons-edit-02 text-yellow-400" };
      case "deleted": return { border: "border-red-500/30", bg: "bg-red-500/10", text: "text-red-400", icon: "i-hugeicons-delete-02 text-red-400" };
    }
  };

  // Calculate language stats for GitHub-style bar (merge similar extensions)
  const languageStats = createMemo(() => {
    const langs = sourceBundle.stats.languages as Record<string, number>;
    const total = Object.values(langs).reduce((a, b) => a + b, 0);
    if (total === 0) return [];

    // Merge similar extensions: ts+tsx -> TypeScript, js+jsx -> JavaScript
    const merged: Record<string, { name: string; count: number; color: string }> = {};
    for (const [ext, count] of Object.entries(langs)) {
      const name = LANG_NAMES[ext] || ext.toUpperCase();
      const color = LANG_COLORS[ext] || "#8b8b8b";
      if (merged[name]) {
        merged[name].count += count;
      } else {
        merged[name] = { name, count, color };
      }
    }

    return Object.values(merged)
      .map((lang) => ({
        ...lang,
        percent: (lang.count / total) * 100,
      }))
      .sort((a, b) => b.count - a.count);
  });

  const handleCopyGitClone = async () => {
    try {
      await navigator.clipboard.writeText("git clone https://github.com/SibXoDev/stuzhik.git");
      setCopied(true);
      safeTimeout(() => setCopied(false), 2000);
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to copy:", e);
    }
  };

  const handleCopyFile = async () => {
    const content = selectedContent();
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      setFileCopied(true);
      safeTimeout(() => setFileCopied(false), 2000);
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to copy:", e);
    }
  };

  const [downloading, setDownloading] = createSignal(false);

  const handleDownloadZip = async () => {
    // Show save dialog
    const filePath = await save({
      defaultPath: `stuzhik-source-v${sourceBundle.version}.zip`,
      filters: [{ name: "ZIP Archive", extensions: ["zip"] }],
    });

    if (!filePath) return; // User cancelled

    setDownloading(true);
    try {
      // Lazy-load JSZip only when needed (reduces initial bundle by ~200KB)
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();

      // Add text files
      for (const [path, content] of Object.entries(sourceBundle.files)) {
        zip.file(path, content as string);
      }

      // Add images (decode base64)
      for (const [path, dataUrl] of Object.entries(sourceBundle.images)) {
        const base64 = (dataUrl as string).split(",")[1];
        zip.file(path, base64, { base64: true });
      }

      // Generate ZIP as Uint8Array
      const data = await zip.generateAsync({ type: "uint8array" });

      // Save using Tauri
      await writeFile(filePath, data);

      addToast({
        type: "success",
        title: "ZIP сохранён",
        message: filePath.split(/[\\/]/).pop() || "stuzhik-source.zip",
        duration: 3000,
      });
    } catch (e) {
      if (import.meta.env.DEV) {
        console.error("Failed to create ZIP:", e);
      }
      addToast({
        type: "error",
        title: "Ошибка",
        message: "Не удалось создать ZIP",
        duration: 3000,
      });
    } finally {
      setDownloading(false);
    }
  };

  const hasChanges = () => sourceBundle.changes && sourceBundle.changes.changes.length > 0;

  const shouldRenderAsPrettyMd = () => {
    if (!isMarkdown()) return false;
    if (showRawMd()) return false;
    if (shouldShowMdAsCode()) return false;
    return true;
  };

  // Handle tab switch
  const switchTab = (tab: Tab) => {
    setActiveTab(tab);
    if (tab === "changes" && !changesReady()) {
      setChangesReady(true);
    }
  };

  return (
    <>
      {/* Background behind TitleBar */}
      <div class="fixed top-0 left-0 right-0 h-[var(--titlebar-height)] bg-gray-900 border-b border-gray-800 z-50" />

      <div class="flex-1 flex min-h-0 bg-gray-950">
      {/* Sidebar */}
      <div class="w-72 flex-shrink-0 border-r border-gray-800 flex flex-col bg-gray-900">
        {/* Header */}
        <div class="p-4 border-b border-gray-800">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3">
              <i class="i-hugeicons-source-code w-6 h-6 text-blue-400" />
              <div>
                <h2 class="text-lg font-bold">Исходный код</h2>
                <p class="text-xs text-gray-500">v{sourceBundle.version}</p>
              </div>
            </div>
            <Tooltip text="Закрыть" position="bottom">
              <button class="btn-ghost p-1.5" onClick={props.onClose}>
                <i class="i-hugeicons-cancel-01 w-5 h-5" />
              </button>
            </Tooltip>
          </div>
        </div>

        {/* Tabs */}
        <div class="flex border-b border-gray-800">
          <button
            class={`flex-1 py-2 text-sm font-medium transition-colors ${activeTab() === "files" ? "text-[var(--color-primary)] border-b-2 border-[var(--color-primary)]" : "text-gray-500 hover:text-gray-300"}`}
            onClick={() => switchTab("files")}
          >
            <div class="flex items-center justify-center gap-1.5">
              <i class="i-hugeicons-folder-01 w-4 h-4" />
              Файлы
            </div>
          </button>
          <Tooltip text={hasChanges() ? `${sourceBundle.changes!.changes.length} изменений` : "Первый релиз"} position="bottom">
          <button
            class={`flex-1 py-2 text-sm font-medium transition-colors ${activeTab() === "changes" ? "text-[var(--color-primary)] border-b-2 border-[var(--color-primary)]" : "text-gray-500 hover:text-gray-300"}`}
            onClick={() => switchTab("changes")}
            disabled={!hasChanges()}
          >
            <div class="flex items-center justify-center gap-1.5">
              <i class="i-hugeicons-git-compare w-4 h-4" />
              Изменения
              <Show when={hasChanges()}>
                <span class="px-1.5 py-0.5 text-xs rounded-full bg-[var(--color-primary-bg)] text-[var(--color-primary)]">
                  {sourceBundle.changes!.changes.length}
                </span>
              </Show>
            </div>
          </button>
          </Tooltip>
        </div>

        {/* Search */}
        <div class="border-b border-gray-800 flex flex-col gap-1 p-2">
          <div class="flex items-center gap-2">
            <i class="i-hugeicons-search-01 w-4 h-4 text-gray-500 flex-shrink-0" />
            <input
              type="text"
              placeholder={useRegex() ? "Regex..." : "Поиск..."}
              value={searchQuery()}
              onInput={(e) => setSearchQuery(e.currentTarget.value)}
              class="flex-1 bg-transparent text-sm outline-none min-w-0"
            />
            <Tooltip text="Регулярное выражение" position="bottom">
              <button
                class={`p-1 rounded transition-colors flex-shrink-0 ${useRegex() ? "text-[var(--color-primary)] bg-[var(--color-primary-bg)]" : "text-gray-500 hover:text-gray-300"}`}
                onClick={() => setUseRegex(!useRegex())}
              >
                <span class="text-xs font-mono">.*</span>
              </button>
            </Tooltip>
            <Show when={searchQuery()}>
              <Tooltip text="Очистить" position="bottom">
                <button
                  class="p-1 rounded text-gray-500 hover:text-gray-300 transition-colors flex-shrink-0"
                  onClick={() => setSearchQuery("")}
                >
                  <i class="i-hugeicons-cancel-01 w-3.5 h-3.5" />
                </button>
              </Tooltip>
            </Show>
          </div>
          <Show when={regexError()}>
            <p class="text-xs text-red-400 px-1">{regexError()}</p>
          </Show>
        </div>

        {/* Files tab content */}
        <Show when={activeTab() === "files"}>
          <div
            ref={filesScrollRef}
            class="flex-1 overflow-y-auto"
          >
            <Show when={filesVirtualizer()}>
              {(virt) => (
                <div style={{ height: `${virt().getTotalSize()}px`, position: "relative" }}>
                  <For each={virt().getVirtualItems()}>
                    {(virtualRow) => {
                      const item = () => flattenedTree()[virtualRow.index];
                      const node = () => item()?.node;
                      const depth = () => item()?.depth ?? 0;
                      return (
                        <Show when={node()}>
                          <div
                            class={`absolute left-0 right-0 flex items-center gap-2 px-2 py-1.5 cursor-pointer transition-colors ${selectedPath() === node()!.path ? "bg-[var(--color-primary-bg)] text-[var(--color-primary)]" : "hover:bg-gray-800/50"}`}
                            style={{ top: `${virtualRow.start}px`, height: `${virtualRow.size}px`, "padding-left": `${depth() * 12 + 8}px` }}
                            onClick={() => selectFile(node()!)}
                          >
                            <Show when={node()!.type === "directory"}>
                              <i class={`w-3 h-3 ${expandedDirs().has(node()!.path) ? "i-hugeicons-arrow-down-01" : "i-hugeicons-arrow-right-01"} text-gray-500`} />
                            </Show>
                            <Show when={node()!.type === "file"}>
                              <span class="w-3" />
                            </Show>
                            <i class={`w-4 h-4 flex-shrink-0 ${getFileIcon(node()!)}`} />
                            <span class="flex-1 truncate text-sm">{node()!.name}</span>
                            <Show when={node()!.type === "file" && node()!.size}>
                              <span class="text-xs text-gray-600">{fmtSize(node()!.size!)}</span>
                            </Show>
                          </div>
                        </Show>
                      );
                    }}
                  </For>
                </div>
              )}
            </Show>
          </div>
        </Show>

        {/* Changes tab content */}
        <Show when={activeTab() === "changes"}>
          <Show when={hasChanges()} fallback={
            <div class="flex-1 flex-col-center gap-2 text-gray-500 p-4">
              <i class="i-hugeicons-git-compare w-8 h-8 opacity-30" />
              <p class="text-sm">Первый релиз</p>
            </div>
          }>
            {/* Summary */}
            <div class="p-3 border-b border-gray-800 bg-gray-800/30 flex flex-col gap-1">
              <div class="flex items-center gap-3 text-sm">
                <span class="text-green-400">+{sourceBundle.changes!.summary.added}</span>
                <span class="text-yellow-400">~{sourceBundle.changes!.summary.modified}</span>
                <span class="text-red-400">-{sourceBundle.changes!.summary.deleted}</span>
              </div>
              <div class="flex items-center gap-2 text-xs text-gray-500">
                <span class="text-green-500">+{sourceBundle.changes!.summary.totalAdditions}</span>
                <span class="text-red-500">-{sourceBundle.changes!.summary.totalDeletions}</span>
                <span>строк</span>
              </div>
            </div>

            <div
              ref={changesScrollRef}
              class="flex-1 overflow-y-auto"
            >
              <Show when={changesVirtualizer()}>
                {(virt) => (
                  <div style={{ height: `${virt().getTotalSize()}px`, position: "relative" }}>
                    <For each={virt().getVirtualItems()}>
                      {(virtualRow) => {
                        const change = () => filteredChanges()[virtualRow.index] as FileChange | undefined;
                        const style = () => getChangeTypeStyle(change()?.type ?? "modified");
                        return (
                          <Show when={change()}>
                            <div
                              class={`absolute left-0 right-0 flex items-center gap-2 px-3 py-2 cursor-pointer border-l-2 ${style().border} ${selectedPath() === change()!.path ? `${style().bg} ${style().text}` : "hover:bg-gray-800/50"} ${change()!.type === "deleted" ? "opacity-60" : ""}`}
                              style={{ top: `${virtualRow.start}px`, height: `${virtualRow.size}px` }}
                              onClick={() => selectChangedFile(change()!)}
                            >
                              <i class={`w-4 h-4 flex-shrink-0 ${style().icon}`} />
                              <span class="flex-1 truncate text-sm font-mono">{change()!.path}</span>
                              <div class="flex items-center gap-1.5 text-xs">
                                <Show when={(change()?.additions ?? 0) > 0}><span class="text-green-400">+{change()!.additions}</span></Show>
                                <Show when={(change()?.deletions ?? 0) > 0}><span class="text-red-400">-{change()!.deletions}</span></Show>
                              </div>
                            </div>
                          </Show>
                        );
                      }}
                    </For>
                  </div>
                )}
              </Show>
            </div>
          </Show>
        </Show>

        {/* Stats & Language bar */}
        <div class="border-t border-gray-800">
          {/* Language bar */}
          <div class="p-3 flex flex-col gap-2">
            <div class="flex h-2 rounded-full overflow-hidden bg-gray-800">
              <For each={languageStats()}>
                {(lang) => (
                  <Tooltip text={`${lang.name}: ${lang.percent.toFixed(1)}%`} position="bottom">
                    <div
                      style={{ width: `${lang.percent}%`, "background-color": lang.color }}
                    />
                  </Tooltip>
                )}
              </For>
            </div>
            <div class="flex flex-wrap gap-x-3 gap-y-1 text-xs">
              <For each={languageStats().slice(0, 4)}>
                {(lang) => (
                  <div class="flex items-center gap-1.5">
                    <span class="w-2.5 h-2.5 rounded-full" style={{ "background-color": lang.color }} />
                    <span class="text-gray-300">{lang.name}</span>
                    <span class="text-gray-500">{lang.percent.toFixed(1)}%</span>
                  </div>
                )}
              </For>
            </div>
          </div>

          {/* File stats */}
          <div class="px-3 pb-3 text-xs text-gray-500">
            <div class="flex justify-between">
              <span>{sourceBundle.stats.totalFiles} файлов</span>
              <span>{fmtSize(sourceBundle.stats.totalSize)}</span>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div class="p-3 border-t border-gray-800 space-y-2">
          <Tooltip text="Скачать ZIP" position="bottom">
            <button
              class="btn-secondary w-full text-sm"
              onClick={handleDownloadZip}
              disabled={downloading()}
            >
              <Show when={downloading()} fallback={<i class="i-hugeicons-download-02 w-4 h-4" />}>
                <i class="i-svg-spinners-ring-resize w-4 h-4" />
              </Show>
              {downloading() ? "Создание..." : "Скачать ZIP"}
            </button>
          </Tooltip>
          <div class="flex gap-2">
            <Tooltip text="Копировать git clone" position="bottom">
              <button class="btn-ghost flex-1 text-sm" onClick={handleCopyGitClone}>
                <Show when={copied()} fallback={<i class="i-hugeicons-copy-01 w-4 h-4" />}>
                  <i class="i-hugeicons-checkmark-circle-02 w-4 h-4 text-green-400" />
                </Show>
                Clone
              </button>
            </Tooltip>
            <Tooltip text="GitHub" position="bottom">
              <button class="btn-ghost flex-1 text-sm" onClick={() => openUrl("https://github.com/SibXoDev/stuzhik")}>
                <i class="i-hugeicons-github w-4 h-4" />
                GitHub
              </button>
            </Tooltip>
          </div>
        </div>
      </div>

      {/* Content */}
      <div class="flex-1 flex flex-col min-w-0">
        {/* Header with file path */}
        <div class="flex items-center justify-between px-4 py-2 border-b border-gray-800 bg-gray-900/80 flex-shrink-0">
          <div class="flex items-center gap-2 min-w-0 flex-1">
            <Show when={selectedPath()} fallback={<span class="text-gray-500 text-sm">Выберите файл</span>}>
              <i class={`w-4 h-4 flex-shrink-0 ${getFileIconByExt(getFileName())}`} />
              <span class="font-mono text-sm truncate text-gray-300">{selectedPath()}</span>
            </Show>
          </div>
          <div class="flex items-center gap-1">
            <Show when={selectedPath() && isMarkdown() && !shouldShowMdAsCode()}>
              <Tooltip text={showRawMd() ? "Показать красиво" : "Показать код"} position="bottom">
                <button
                  class={`btn-ghost p-1.5 ${showRawMd() ? "text-[var(--color-primary)]" : ""}`}
                  onClick={() => setShowRawMd(!showRawMd())}
                >
                  <i class={showRawMd() ? "i-hugeicons-text w-4 h-4" : "i-hugeicons-code w-4 h-4"} />
                </button>
              </Tooltip>
            </Show>
            <Show when={selectedPath()}>
              <Tooltip text="Копировать" position="bottom">
                <button class="btn-ghost p-1.5" onClick={handleCopyFile}>
                  <Show when={fileCopied()} fallback={<i class="i-hugeicons-copy-01 w-4 h-4" />}>
                    <i class="i-hugeicons-checkmark-circle-02 w-4 h-4 text-green-400" />
                  </Show>
                </button>
              </Tooltip>
            </Show>
          </div>
        </div>

        {/* Content area */}
        <div
          ref={contentScrollRef}
          class="flex-1 overflow-auto"
          classList={{ "line-numbers": !isImage() && !shouldRenderAsPrettyMd() && !!selectedContent() }}
        >
          <Show when={selectedPath()} fallback={
            <div class="flex-col-center h-full gap-6 text-gray-500 p-8">
              <i class="i-hugeicons-source-code w-20 h-20 opacity-20" />
              <div class="text-center flex flex-col gap-2">
                <p class="text-xl font-medium text-gray-400">Stuzhik Source Code</p>
                <p class="text-sm">Выберите файл в дереве слева</p>
              </div>

              {/* Language stats like GitHub */}
              <div class="w-full max-w-md flex flex-col gap-2">
                <p class="text-xs text-gray-500">Languages</p>
                <div class="flex h-2 rounded-full overflow-hidden bg-gray-800">
                  <For each={languageStats()}>
                    {(lang) => (
                      <Tooltip text={`${lang.name}: ${lang.percent.toFixed(1)}%`} position="bottom">
                        <div
                          style={{ width: `${lang.percent}%`, "background-color": lang.color }}
                        />
                      </Tooltip>
                    )}
                  </For>
                </div>
                <div class="flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs">
                  <For each={languageStats()}>
                    {(lang) => (
                      <div class="flex items-center gap-1.5">
                        <span class="w-2.5 h-2.5 rounded-full" style={{ "background-color": lang.color }} />
                        <span class="text-gray-300">{lang.name}</span>
                        <span class="text-gray-500">{lang.percent.toFixed(1)}%</span>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </div>
          }>
            {/* Image view */}
            <Show when={isImage()}>
              <div class="flex-col-center h-full gap-4 p-8">
                <Show when={sourceBundle.images[selectedPath()!]} fallback={
                  <div class="flex flex-col items-center gap-4">
                    <i class="i-hugeicons-image-01 w-16 h-16 text-gray-600" />
                    <p class="text-gray-500 text-sm">Изображение не найдено</p>
                  </div>
                }>
                  <img
                    src={sourceBundle.images[selectedPath()!]}
                    alt={getFileName()}
                    class="max-w-full max-h-[70vh] object-contain rounded-lg"
                  />
                  <p class="text-gray-500 text-xs font-mono">{selectedPath()}</p>
                </Show>
              </div>
            </Show>

            {/* Markdown pretty view */}
            <Show when={!isImage() && shouldRenderAsPrettyMd()}>
              <div
                class="p-6 prose prose-invert max-w-none"
                onClick={(e) => {
                  // Intercept relative link clicks and navigate within source viewer
                  const anchor = (e.target as HTMLElement).closest("a");
                  if (!anchor) return;
                  const href = anchor.getAttribute("href");
                  if (!href || href.startsWith("#") || href.startsWith("http://") || href.startsWith("https://")) return;

                  e.preventDefault();
                  e.stopPropagation();

                  // Resolve relative path from current file's directory
                  const currentDir = selectedPath()?.split("/").slice(0, -1).join("/") || "";
                  const resolved = href.startsWith("./") ? href.slice(2) : href;
                  const targetPath = currentDir ? `${currentDir}/${resolved}` : resolved;

                  // Normalize path (handle ../)
                  const parts = targetPath.split("/");
                  const normalized: string[] = [];
                  for (const part of parts) {
                    if (part === "..") normalized.pop();
                    else if (part !== "." && part !== "") normalized.push(part);
                  }
                  const finalPath = normalized.join("/");

                  // Try to navigate to the file in source viewer
                  if (sourceBundle.files[finalPath]) {
                    setSelectedPath(finalPath);
                  }
                }}
              >
                <MarkdownRenderer content={selectedContent()!} />
              </div>
            </Show>

            {/* Code view - Shiki output directly */}
            <Show when={!isImage() && !shouldRenderAsPrettyMd() && selectedContent()}>
              <Show when={codeLoading()}>
                <div class="flex-center gap-2 p-8">
                  <i class="i-svg-spinners-ring-resize w-6 h-6 text-gray-500" />
                  <span class="text-sm text-gray-500">Загрузка подсветки...</span>
                </div>
              </Show>

              {/* Error banner (shown above code if there was an error) */}
              <Show when={!codeLoading() && codeError()}>
                <div class="flex items-center justify-between px-4 py-2 bg-yellow-500/10 border-b border-yellow-500/30 text-yellow-400 text-sm">
                  <div class="flex items-center gap-2">
                    <i class="i-hugeicons-alert-02 w-4 h-4" />
                    <span>Ошибка подсветки: {codeError()}</span>
                  </div>
                  <Tooltip text="Повторить" position="bottom">
                    <button
                      class="btn-ghost p-1.5 text-yellow-400 hover:text-yellow-300"
                      onClick={retryHighlight}
                    >
                      <i class="i-hugeicons-refresh w-4 h-4" />
                    </button>
                  </Tooltip>
                </div>
              </Show>

              <Show when={!codeLoading() && codeHtml()}>
                {/* Raw innerHTML - parent has line-numbers class via CSS */}
                <div innerHTML={codeHtml()} />
              </Show>

              {/* Fallback if no HTML at all */}
              <Show when={!codeLoading() && !codeHtml() && selectedContent()}>
                <pre class="p-4 text-sm font-mono text-gray-300 whitespace-pre-wrap">
                  {selectedContent()}
                </pre>
              </Show>
            </Show>
          </Show>
        </div>
      </div>
      </div>
    </>
  );
};

export default SourceCodePage;
