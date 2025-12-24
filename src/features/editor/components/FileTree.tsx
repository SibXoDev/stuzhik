import { For, Show, createSignal, createMemo, Index } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import type { FileEntry } from "../../../shared/types";

interface FileTreeProps {
  files: FileEntry[];
  currentPath: string;
  selectedPath: string | null;
  onSelect: (entry: FileEntry) => void;
  onNavigate: (path: string) => void;
  loading?: boolean;
}

// Hidden file patterns
const HIDDEN_PATTERNS = [
  /^\./, // Hidden files
  /\.log$/,
  /\.lock$/,
  /^crash-reports$/,
  /^logs$/,
  /^cache$/,
  /^\.fabric$/,
  /^\.mixin\.out$/,
];

export function FileTree(props: FileTreeProps) {
  const [showHidden, setShowHidden] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [useRegex, setUseRegex] = createSignal(false);
  const [regexError, setRegexError] = createSignal<string | null>(null);
  let scrollRef: HTMLDivElement | undefined;

  // Filter files
  const filteredFiles = createMemo(() => {
    let files = props.files;

    // Hide hidden files
    if (!showHidden()) {
      files = files.filter(
        (file) => !HIDDEN_PATTERNS.some((pattern) => pattern.test(file.name))
      );
    }

    // Search filter
    const query = searchQuery();
    if (query) {
      if (useRegex()) {
        // Regex mode
        try {
          const regex = new RegExp(query, "i");
          setRegexError(null);
          files = files.filter(
            (file) => regex.test(file.name) || regex.test(file.path)
          );
        } catch (e) {
          setRegexError((e as Error).message);
          // Don't filter on invalid regex
        }
      } else {
        // Simple search mode
        const lowerQuery = query.toLowerCase();
        files = files.filter(
          (file) =>
            file.name.toLowerCase().includes(lowerQuery) ||
            file.path.toLowerCase().includes(lowerQuery)
        );
      }
    } else {
      setRegexError(null);
    }

    return files;
  });

  // Sort files: directories first, then alphabetically
  const sortedFiles = createMemo(() => {
    return [...filteredFiles()].sort((a, b) => {
      if (a.is_dir && !b.is_dir) return -1;
      if (!a.is_dir && b.is_dir) return 1;
      return a.name.localeCompare(b.name);
    });
  });

  // Virtual list
  const virtualizer = createVirtualizer({
    get count() {
      return sortedFiles().length;
    },
    getScrollElement: () => scrollRef ?? null,
    estimateSize: () => 36,
    overscan: 5,
  });

  const handleClick = (entry: FileEntry) => {
    if (entry.is_dir) {
      props.onNavigate(entry.path);
    } else {
      props.onSelect(entry);
    }
  };

  const handleGoUp = () => {
    if (!props.currentPath) return;
    const parts = props.currentPath.split("/").filter(Boolean);
    parts.pop();
    props.onNavigate(parts.join("/"));
  };

  const breadcrumbs = createMemo(() => {
    if (!props.currentPath) return [{ name: "root", path: "" }];
    const parts = props.currentPath.split("/").filter(Boolean);
    return [
      { name: "root", path: "" },
      ...parts.map((part, i) => ({
        name: part,
        path: parts.slice(0, i + 1).join("/"),
      })),
    ];
  });

  const getFileIcon = (entry: FileEntry): string => {
    if (entry.is_dir) return "i-hugeicons-folder-01";

    const ext = entry.name.split(".").pop()?.toLowerCase();
    switch (ext) {
      case "jar":
        return "i-hugeicons-package";
      case "json":
      case "json5":
      case "jsonc":
        return "i-hugeicons-code-square";
      case "toml":
        return "i-hugeicons-settings-02";
      case "yaml":
      case "yml":
        return "i-hugeicons-list-view";
      case "js":
      case "ts":
        return "i-hugeicons-java-script";
      case "png":
      case "jpg":
      case "jpeg":
      case "gif":
        return "i-hugeicons-image-01";
      case "txt":
      case "md":
        return "i-hugeicons-file-01";
      case "log":
        return "i-hugeicons-scroll";
      case "properties":
      case "cfg":
      case "ini":
        return "i-hugeicons-settings-01";
      case "zs":
        return "i-hugeicons-code";
      case "mcfunction":
        return "i-hugeicons-command-line";
      default:
        return "i-hugeicons-file-01";
    }
  };

  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div class="flex flex-col h-full">
      {/* Breadcrumbs */}
      <div class="flex items-center gap-1 px-3 py-2 border-b border-gray-750 text-sm overflow-x-auto flex-shrink-0">
        <For each={breadcrumbs()}>
          {(crumb, index) => (
            <>
              <button
                class="hover:text-blue-400 transition-colors whitespace-nowrap"
                onClick={() => props.onNavigate(crumb.path)}
              >
                {crumb.name}
              </button>
              <Show when={index() < breadcrumbs().length - 1}>
                <i class="i-hugeicons-arrow-right-01 w-3 h-3 text-gray-600 flex-shrink-0" />
              </Show>
            </>
          )}
        </For>
      </div>

      {/* Search & Controls */}
      <div class="flex flex-col gap-1 p-2 border-b border-gray-750 flex-shrink-0">
        <div class="flex gap-2">
          <div class="relative flex-1">
            <i class="i-hugeicons-search-01 w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
            <input
              type="text"
              placeholder={useRegex() ? "Regex..." : "Поиск..."}
              value={searchQuery()}
              onInput={(e) => setSearchQuery(e.currentTarget.value)}
              class={`w-full pl-8 pr-8 py-1.5 text-sm bg-gray-800 border rounded focus:outline-none ${
                regexError() ? "border-red-500" : "border-gray-700 focus:border-blue-500"
              }`}
            />
            <Show when={searchQuery()}>
              <button
                onClick={() => setSearchQuery("")}
                class="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
              >
                <i class="i-hugeicons-cancel-01 w-4 h-4" />
              </button>
            </Show>
          </div>
          <button
            class={`p-1.5 rounded transition-colors ${
              useRegex() ? "bg-purple-600 text-white" : "bg-gray-800 text-gray-400 hover:text-gray-300"
            }`}
            onClick={() => setUseRegex(!useRegex())}
            title={useRegex() ? "Выключить regex" : "Включить regex"}
          >
            <span class="text-xs font-mono w-4 h-4 flex-center">.*</span>
          </button>
          <button
            class={`p-1.5 rounded transition-colors ${
              showHidden() ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-400 hover:text-gray-300"
            }`}
            onClick={() => setShowHidden(!showHidden())}
            title={showHidden() ? "Скрыть скрытые файлы" : "Показать скрытые файлы"}
          >
            <i class={`w-4 h-4 ${showHidden() ? "i-hugeicons-view" : "i-hugeicons-view-off"}`} />
          </button>
        </div>
        <Show when={regexError()}>
          <p class="text-xs text-red-400 px-1">{regexError()}</p>
        </Show>
      </div>

      {/* Back button */}
      <Show when={props.currentPath}>
        <button
          class="flex items-center gap-2 px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-800/50 transition-colors border-b border-gray-750"
          onClick={handleGoUp}
        >
          <i class="i-hugeicons-arrow-left-01 w-4 h-4" />
          ..
        </button>
      </Show>

      {/* File List with Virtualization */}
      <div ref={scrollRef} class="flex-1 overflow-y-auto min-h-0">
        <Show when={props.loading}>
          <div class="flex-center p-8">
            <i class="i-svg-spinners-6-dots-scale w-6 h-6" />
          </div>
        </Show>

        <Show when={!props.loading && sortedFiles().length === 0}>
          <div class="flex-col-center p-8 text-center">
            <i class="i-hugeicons-folder-01 w-10 h-10 text-gray-600 mb-2" />
            <p class="text-muted text-sm">
              {searchQuery() ? "Ничего не найдено" : "Папка пуста"}
            </p>
          </div>
        </Show>

        <Show when={!props.loading && sortedFiles().length > 0}>
          {(() => {
            // Capture stable reference to files for this render
            const files = sortedFiles();
            const totalSize = virtualizer.getTotalSize();

            return (
              <div
                style={{
                  height: `${totalSize}px`,
                  position: "relative",
                }}
              >
                <Index each={virtualizer.getVirtualItems()}>
                  {(virtualRow) => {
                    // Safe access with bounds check
                    const getEntry = () => {
                      const row = virtualRow();
                      const idx = row.index;
                      if (idx < 0 || idx >= files.length) return null;
                      return files[idx];
                    };

                    return (
                      <Show when={getEntry()}>
                        {(entry) => (
                          <div
                            role="button"
                            tabIndex={0}
                            class={`absolute left-0 right-0 flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-800/50 transition-colors cursor-pointer ${
                              entry().path === props.selectedPath ? "bg-blue-600/20 border-l-2 border-l-blue-600" : ""
                            }`}
                            style={{
                              top: `${virtualRow().start}px`,
                              height: `${virtualRow().size}px`,
                            }}
                            onClick={() => handleClick(entry())}
                            onKeyDown={(e) => e.key === "Enter" && handleClick(entry())}
                          >
                            <i
                              class={`${getFileIcon(entry())} w-4 h-4 flex-shrink-0 ${
                                entry().is_dir ? "text-blue-400" : "text-gray-500"
                              }`}
                            />
                            <span class="flex-1 truncate text-sm">{entry().name}</span>
                            <Show when={!entry().is_dir}>
                              <span class="text-xs text-gray-500">{formatSize(entry().size)}</span>
                            </Show>
                            <Show when={entry().is_dir}>
                              <i class="i-hugeicons-arrow-right-01 w-3 h-3 text-gray-600" />
                            </Show>
                          </div>
                        )}
                      </Show>
                    );
                  }}
                </Index>
              </div>
            );
          })()}
        </Show>
      </div>

      {/* Status bar */}
      <div class="px-3 py-1.5 border-t border-gray-750 text-xs text-gray-500 flex-shrink-0">
        {sortedFiles().length} элементов
        <Show when={searchQuery()}>
          {" "}(фильтр)
        </Show>
      </div>
    </div>
  );
}
