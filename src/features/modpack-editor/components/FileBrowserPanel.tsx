import { Show, For, createSignal, createEffect, createMemo } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useFileBrowser } from "../../../shared/hooks";
import type { FileEntry } from "../../../shared/types";
import { createConfirmDialog } from "../../../shared/components/ConfirmDialog";
import { addToast } from "../../../shared/components/Toast";
import CodeViewer from "../../../shared/components/CodeViewer";
import { formatRelativeTime, formatFullDateTime } from "../../../shared/utils/date-formatter";
import { useI18n } from "../../../shared/i18n";

// Decode Unicode escape sequences like \u0027, \u0026
function decodeUnicodeEscapes(str: string): string {
  return str.replace(/\\u([0-9A-Fa-f]{4})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
}

// Normalize path separators for cross-platform compatibility
function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

interface FileBrowserPanelProps {
  instanceId: string;
}

export function FileBrowserPanel(props: FileBrowserPanelProps) {
  const { t } = useI18n();
  const browser = useFileBrowser(() => props.instanceId);
  const [selectedFile, setSelectedFile] = createSignal<FileEntry | null>(null);
  const [fileContent, setFileContent] = createSignal<string | null>(null);
  const [_editedContent, setEditedContent] = createSignal("");
  const [showHidden, setShowHidden] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [showRenameDialog, setShowRenameDialog] = createSignal(false);
  const [showCopyDialog, setShowCopyDialog] = createSignal(false);
  const [newName, setNewName] = createSignal("");
  const [useGlobalSearch, setUseGlobalSearch] = createSignal(false);
  const [useRegex, setUseRegex] = createSignal(false);
  const [globalSearchResults, setGlobalSearchResults] = createSignal<FileEntry[]>([]);
  const [searchLoading, setSearchLoading] = createSignal(false);
  const { confirm, ConfirmDialogComponent } = createConfirmDialog();

  // Ref for code preview container to reset scroll
  let codeContainerRef: HTMLDivElement | undefined;

  createEffect(() => {
    if (props.instanceId) {
      browser.browse("");
    }
  });

  const handleNavigate = (entry: FileEntry) => {
    if (entry.is_dir) {
      // Normalize path for Windows
      const normalizedPath = entry.path.replace(/\\/g, "/");
      browser.browse(normalizedPath);
      setSelectedFile(null);
      setFileContent(null);
    } else {
      handleSelectFile(entry);
    }
  };

  const handleSelectFile = async (entry: FileEntry) => {
    setSelectedFile(entry);

    // Reset scroll position when opening new file
    if (codeContainerRef) {
      codeContainerRef.scrollTop = 0;
    }

    // Try to load text files
    if (entry.size < 1024 * 1024 && isTextFile(entry.name)) {
      const rawContent = await browser.readFile(entry.path);
      if (rawContent) {
        // Decode Unicode escape sequences for display
        const content = decodeUnicodeEscapes(rawContent);
        setFileContent(content);
        setEditedContent(content);
      } else {
        setFileContent("Не удалось загрузить содержимое файла");
      }
    } else if (entry.size >= 1024 * 1024) {
      setFileContent(`Файл слишком большой для редактирования (${formatFileSize(entry.size)})`);
    } else {
      setFileContent("Редактирование недоступно для этого типа файла");
    }
  };

  const handleGoUp = () => {
    const currentPath = browser.currentPath();
    if (!currentPath) return;

    // Normalize path separators and split
    const normalizedPath = currentPath.replace(/\\/g, "/");
    const parts = normalizedPath.split("/").filter(Boolean);

    if (parts.length === 0) return; // Already at root

    parts.pop();
    const parentPath = parts.join("/");
    browser.browse(parentPath);
    setSelectedFile(null);
    setFileContent(null);
  };

  const performGlobalSearch = async () => {
    const query = searchQuery();
    if (!query) {
      setGlobalSearchResults([]);
      return;
    }

    try {
      setSearchLoading(true);
      const results = await invoke<FileEntry[]>("search_instance_files", {
        instanceId: props.instanceId,
        query,
        useRegex: useRegex(),
      });
      setGlobalSearchResults(results);
    } catch (err) {
      addToast({
        type: "error",
        title: "Ошибка поиска",
        message: String(err),
        duration: 5000,
      });
      setGlobalSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  };

  // Trigger global search when query changes in global mode
  createEffect(() => {
    if (useGlobalSearch() && searchQuery()) {
      performGlobalSearch();
    } else {
      setGlobalSearchResults([]);
    }
  });

  const handleDelete = async () => {
    const file = selectedFile();
    if (!file) return;

    const confirmed = await confirm({
      title: "Удалить файл?",
      message: `Файл "${file.name}" будет удалён. Это действие нельзя отменить.`,
      variant: "danger",
      confirmText: "Удалить",
    });

    if (!confirmed) return;

    const success = await browser.deleteFile(file.path);
    if (success) {
      setSelectedFile(null);
      setFileContent(null);
      addToast({
        type: "success",
        title: "Файл удалён",
        message: `${file.name} успешно удалён`,
        duration: 3000,
      });
    }
  };

  const handleOpenInExplorer = async () => {
    try {
      // Use backend command which has proper permissions
      const currentSubPath = browser.currentPath();
      await invoke("open_instance_folder", {
        id: props.instanceId,
        subfolder: currentSubPath || null,
      });
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to open folder:", e);
      addToast({
        type: "error",
        title: "Ошибка",
        message: "Не удалось открыть папку в проводнике",
        duration: 3000,
      });
    }
  };

  const handleShowFileInExplorer = async () => {
    const file = selectedFile();
    if (!file) return;

    try {
      const instance = await invoke<{ dir: string }>("get_instance", {
        id: props.instanceId,
      });
      // Normalize paths to use consistent forward slashes
      const basePath = normalizePath(instance.dir);
      const filePath = normalizePath(file.path);
      const fullPath = `${basePath}/${filePath}`;
      await revealItemInDir(fullPath);
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to reveal file:", e);
      addToast({
        type: "error",
        title: "Ошибка",
        message: "Не удалось показать файл в проводнике",
        duration: 3000,
      });
    }
  };

  const handleRename = () => {
    const file = selectedFile();
    if (!file) return;
    setNewName(file.name);
    setShowRenameDialog(true);
  };

  const handleCopy = () => {
    const file = selectedFile();
    if (!file) return;
    const baseName = file.name.replace(/\.[^.]+$/, "");
    const ext = file.name.match(/\.[^.]+$/)?.[0] || "";
    setNewName(`${baseName}_copy${ext}`);
    setShowCopyDialog(true);
  };

  const confirmRename = async () => {
    const file = selectedFile();
    if (!file || !newName().trim()) return;

    try {
      await invoke("rename_instance_file", {
        instanceId: props.instanceId,
        relativePath: file.path,
        newName: newName().trim(),
      });

      setShowRenameDialog(false);
      await browser.browse(browser.currentPath());
      setSelectedFile(null);
      setFileContent(null);

      addToast({
        type: "success",
        title: "Файл переименован",
        message: `${file.name} → ${newName().trim()}`,
        duration: 3000,
      });
    } catch (err) {
      addToast({
        type: "error",
        title: "Ошибка переименования",
        message: String(err),
        duration: 5000,
      });
    }
  };

  const confirmCopy = async () => {
    const file = selectedFile();
    if (!file || !newName().trim()) return;

    try {
      await invoke("copy_instance_file", {
        instanceId: props.instanceId,
        relativePath: file.path,
        newName: newName().trim(),
      });

      setShowCopyDialog(false);
      await browser.browse(browser.currentPath());

      addToast({
        type: "success",
        title: "Файл скопирован",
        message: `Создана копия: ${newName().trim()}`,
        duration: 3000,
      });
    } catch (err) {
      addToast({
        type: "error",
        title: "Ошибка копирования",
        message: String(err),
        duration: 5000,
      });
    }
  };

  const getFileLanguage = (filename: string):
    "toml" | "json" | "jsonc" | "properties" | "yaml" | "txt" |
    "javascript" | "typescript" | "java" | "python" |
    "shell" | "bat" | "gradle" | "xml" | "html" | "css" |
    "markdown" | "dockerfile" | "rust" | "lua" => {
    const ext = filename.split(".").pop()?.toLowerCase();
    const name = filename.toLowerCase();

    // Special cases based on filename
    if (name === "dockerfile") return "dockerfile";
    if (name === "makefile") return "shell";
    if (name === "build.gradle" || name.endsWith(".gradle")) return "gradle";
    if (name.endsWith(".mcfunction")) return "shell"; // Minecraft functions

    // Extension-based detection
    switch (ext) {
      // Config files
      case "json": case "mcmeta": return "json";
      case "jsonc": case "json5": return "jsonc"; // JSON with Comments
      case "toml": return "toml";
      case "yaml": case "yml": return "yaml";
      case "properties": case "cfg": case "conf": case "ini":
      case "launchproperties": case "option": case "server":
        return "properties";
      case "xml": return "xml";

      // Programming languages
      case "js": case "mjs": case "cjs": return "javascript";
      case "ts": case "mts": case "cts": return "typescript";
      case "java": return "java";
      case "py": case "pyw": return "python";
      case "rs": return "rust";
      case "lua": return "lua";

      // Scripts
      case "sh": case "bash": case "zsh": return "shell";
      case "bat": case "cmd": return "bat";

      // Web
      case "html": case "htm": return "html";
      case "css": case "scss": case "sass": case "less": return "css";

      // Markup
      case "md": case "markdown": return "markdown";

      // KubeJS & CraftTweaker
      case "zs": return "java"; // CraftTweaker uses ZenScript (Java-like)

      // Minecraft specific
      case "snbt": return "json"; // SNBT is JSON-like
      case "lang": return "properties"; // Legacy lang files use key=value
      case "accesswidener": return "txt"; // Fabric access wideners
      case "list": return "txt"; // List files
      case "disabled": case "bak": case "old":
        // For disabled/backup files, try to detect from the base filename
        const baseName = filename.replace(/\.(disabled|bak|old)$/i, "");
        if (baseName.endsWith(".json")) return "json";
        if (baseName.endsWith(".toml")) return "toml";
        if (baseName.endsWith(".properties") || baseName.endsWith(".cfg")) return "properties";
        return "txt";

      // Dev config files
      case "env": case "gitignore": case "gitattributes": case "gitmodules":
      case "editorconfig": case "prettierrc": case "eslintrc":
        return "properties";

      default: return "txt";
    }
  };

  const breadcrumbs = () => {
    const path = browser.currentPath();
    if (!path) return ["root"];
    return ["root", ...path.split("/").filter(Boolean)];
  };

  const filteredFiles = createMemo(() => {
    // If global search is active, show global results
    if (useGlobalSearch() && searchQuery()) {
      return globalSearchResults();
    }

    // Otherwise show local directory files
    let files = browser.files();

    // Apply hidden files filter
    if (!showHidden()) {
      files = files.filter((file) => {
        // Hide common generated/cache files
        const hiddenPatterns = [
          /^\./, // Hidden files (starting with .)
          /\.log$/,
          /\.lock$/,
          /^crash-reports$/,
          /^logs$/,
          /^cache$/,
          /^\.fabric$/,
          /^\.mixin\.out$/,
        ];

        return !hiddenPatterns.some((pattern) => pattern.test(file.name));
      });
    }

    // Apply local search filter
    const query = searchQuery().toLowerCase();
    if (query) {
      files = files.filter((file) =>
        file.name.toLowerCase().includes(query) ||
        file.path.toLowerCase().includes(query)
      );
    }

    return files;
  });

  const isTextFile = (filename: string): boolean => {
    const textExtensions = [
      // Config & Data
      ".txt", ".json", ".jsonc", ".json5", ".toml", ".yaml", ".yml",
      ".properties", ".cfg", ".conf", ".ini", ".xml",
      ".mcmeta", // pack.mcmeta, etc.
      ".log",
      // Programming
      ".js", ".mjs", ".cjs", // JavaScript
      ".ts", ".mts", ".cts", // TypeScript
      ".java", // Java source
      ".py", ".pyw", // Python
      ".rs", // Rust
      ".lua", // Lua
      ".zs", // CraftTweaker ZenScript
      // Scripts
      ".sh", ".bash", ".zsh", // Shell
      ".bat", ".cmd", // Batch
      ".gradle", // Gradle
      // Web
      ".html", ".htm", ".css", ".scss", ".sass", ".less",
      // Markup
      ".md", ".markdown",
      // Minecraft specific
      ".mcfunction", // Datapack functions
      ".snbt", // Stringified NBT (JSON-like)
      ".lang", // Legacy language files
      ".accesswidener", // Fabric access wideners
      ".list", // Forge/generic list files
      ".launchproperties", // Launcher properties
      ".server", // Server info files
      ".option", // Options files
      ".disabled", // Disabled mods/configs
      ".bak", ".old", // Backup files (often text)
      // Generic dev files
      ".env", ".env.local", ".env.example",
      ".gitignore", ".gitattributes", ".gitmodules",
      ".editorconfig", ".prettierrc", ".eslintrc",
    ];

    // Also match files without extension that are known text files
    const lowerName = filename.toLowerCase();
    const knownTextFiles = ["dockerfile", "makefile", "readme", "license", "changelog", "eula"];
    if (knownTextFiles.some(f => lowerName === f || lowerName.startsWith(f + "."))) {
      return true;
    }

    return textExtensions.some((ext) => lowerName.endsWith(ext));
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  };

  const getFileIcon = (entry: FileEntry): string => {
    if (entry.is_dir) return "i-hugeicons-folder-01";

    const ext = entry.name.split(".").pop()?.toLowerCase();
    switch (ext) {
      case "jar":
        return "i-hugeicons-package";
      case "json":
      case "toml":
      case "yaml":
      case "yml":
        return "i-hugeicons-settings-02";
      case "png":
      case "jpg":
      case "jpeg":
        return "i-hugeicons-image-01";
      case "txt":
      case "md":
        return "i-hugeicons-file-01";
      case "log":
        return "i-hugeicons-scroll";
      default:
        return "i-hugeicons-file-01";
    }
  };

  return (
    <div class="flex h-full gap-4">
      {/* Left Panel - File Tree */}
      <div class="w-96 flex flex-col gap-3 flex-shrink-0">
        {/* Breadcrumbs */}
        <div class="flex items-center gap-2 flex-wrap">
          <For each={breadcrumbs()}>
            {(crumb, index) => (
              <>
                <button
                  class="text-sm hover:text-blue-400 transition-colors"
                  onClick={() => {
                    if (index() === 0) {
                      browser.browse("");
                    } else {
                      const parts = breadcrumbs().slice(1, index() + 1);
                      browser.browse(parts.join("/"));
                    }
                  }}
                >
                  {crumb}
                </button>
                <Show when={index() < breadcrumbs().length - 1}>
                  <i class="i-hugeicons-arrow-right-01 w-3 h-3 text-gray-600" />
                </Show>
              </>
            )}
          </For>
        </div>

        {/* Search */}
        <div class="flex flex-col gap-2">
          <div class="relative">
            <i class="i-hugeicons-search-01 w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              type="text"
              placeholder={useGlobalSearch() ? t().ui.placeholders.globalSearch : t().ui.placeholders.searchFiles}
              value={searchQuery()}
              onInput={(e) => setSearchQuery(e.currentTarget.value)}
              class="w-full pl-10 pr-10 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm focus:outline-none focus:border-blue-500 transition-colors"
            />
            <Show when={searchQuery()}>
              <button
                onClick={() => setSearchQuery("")}
                class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
              >
                <i class="i-hugeicons-cancel-01 w-4 h-4" />
              </button>
            </Show>
          </div>

          {/* Search Options */}
          <div class="flex gap-2 items-center text-xs">
            <button
              class={`flex items-center gap-1.5 px-2 py-1 rounded transition-colors ${
                useGlobalSearch() ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-400 hover:text-gray-300"
              }`}
              onClick={() => setUseGlobalSearch(!useGlobalSearch())}
              title="Искать во всех папках"
            >
              <i class="i-hugeicons-folder-search w-3.5 h-3.5" />
              Глобально
            </button>

            <button
              class={`flex items-center gap-1.5 px-2 py-1 rounded transition-colors ${
                useRegex() ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-400 hover:text-gray-300"
              }`}
              onClick={() => setUseRegex(!useRegex())}
              title="Использовать регулярные выражения"
            >
              <i class="i-hugeicons-source-code w-3.5 h-3.5" />
              Regex
            </button>

            <Show when={searchLoading()}>
              <i class="i-svg-spinners-ring-resize w-3.5 h-3.5 text-blue-400" />
            </Show>

            <Show when={useGlobalSearch() && globalSearchResults().length > 0}>
              <span class="text-gray-500 ml-auto">
                {globalSearchResults().length} {globalSearchResults().length === 1 ? "файл" : "файлов"}
              </span>
            </Show>
          </div>
        </div>

        {/* Actions */}
        <div class="flex gap-2">
          <button
            class="btn-sm btn-secondary flex-1"
            onClick={handleGoUp}
            disabled={!browser.currentPath()}
            title="Вернуться на уровень выше"
          >
            <i class="i-hugeicons-arrow-left-01 w-4 h-4" />
            Назад
          </button>

          <button
            class="btn-sm btn-secondary"
            onClick={handleOpenInExplorer}
            title="Открыть в проводнике"
          >
            <i class="i-hugeicons-folder-open w-4 h-4" />
          </button>

          <button
            class={`btn-sm ${showHidden() ? "btn-primary" : "btn-secondary"}`}
            onClick={() => setShowHidden(!showHidden())}
            title={showHidden() ? "Скрыть скрытые файлы" : "Показать скрытые файлы"}
          >
            <i class={`w-4 h-4 ${showHidden() ? "i-hugeicons-view" : "i-hugeicons-view-off"}`} />
          </button>
        </div>

        {/* File List */}
        <div class="card flex-1 overflow-y-auto p-0">
          <Show when={browser.loading() || searchLoading()}>
            <div class="flex-center p-8">
              <i class="i-svg-spinners-6-dots-scale w-6 h-6" />
            </div>
          </Show>

          <Show when={!browser.loading() && !searchLoading() && filteredFiles().length === 0}>
            <div class="flex-col-center p-8 text-center">
              <Show when={searchQuery() && useGlobalSearch()}>
                <i class="i-hugeicons-search-01 w-12 h-12 text-gray-600 mb-2" />
                <p class="text-muted text-sm">Ничего не найдено</p>
                <p class="text-xs text-gray-600 mt-1">Попробуйте изменить запрос</p>
              </Show>
              <Show when={!searchQuery() || !useGlobalSearch()}>
                <i class="i-hugeicons-folder-01 w-12 h-12 text-gray-600 mb-2" />
                <p class="text-muted text-sm">Папка пуста</p>
              </Show>
            </div>
          </Show>

          <Show when={!browser.loading() && !searchLoading()}>
            <For each={filteredFiles()}>
              {(entry) => (
                <button
                  class={`w-full text-left px-4 py-3 border-b border-gray-800 hover:bg-gray-800/50 transition-colors flex items-center gap-3 ${
                    selectedFile()?.path === entry.path ? "bg-blue-600/20 border-l-4 border-l-blue-600" : ""
                  }`}
                  onClick={() => handleNavigate(entry)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (!entry.is_dir) {
                      setSelectedFile(entry);
                    }
                  }}
                >
                  <i class={`${getFileIcon(entry)} w-5 h-5 ${entry.is_dir ? "text-blue-400" : "text-gray-500"}`} />
                  <div class="flex-1 min-w-0">
                    <div class="font-medium truncate">{entry.name}</div>
                    <div class="text-xs text-muted">
                      <Show when={useGlobalSearch()}>
                        <span class="text-blue-400 font-mono mr-2">{entry.path}</span>
                      </Show>
                      {entry.is_dir ? "Папка" : formatFileSize(entry.size)} • <span title={formatFullDateTime(entry.modified)}>{formatRelativeTime(entry.modified)}</span>
                    </div>
                  </div>
                  <Show when={entry.is_dir}>
                    <i class="i-hugeicons-arrow-right-01 w-4 h-4 text-gray-600" />
                  </Show>
                </button>
              )}
            </For>
          </Show>
        </div>
      </div>

      {/* Right Panel - Preview */}
      <div class="flex-1 flex flex-col gap-3 min-w-0 overflow-hidden">
        <Show when={!selectedFile()}>
          <div class="card flex-1 flex-col-center text-center p-8">
            <i class="i-hugeicons-folder-search w-16 h-16 text-gray-600 mb-4" />
            <h3 class="text-lg font-semibold mb-2">Браузер файлов</h3>
            <p class="text-muted text-sm max-w-md">
              Навигация по файлам экземпляра. Выберите файл для предпросмотра
            </p>
            <div class="mt-6 flex gap-2 flex-wrap justify-center">
              <div class="px-3 py-2 rounded bg-gray-800 text-xs flex items-center gap-1">
                <i class="i-hugeicons-mouse-left-click-02 w-4 h-4" />
                Открыть папку / файл
              </div>
            </div>
          </div>
        </Show>

        <Show when={selectedFile()}>
          {/* Header */}
          <div class="flex flex-col gap-2 flex-shrink-0">
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-3 min-w-0">
                <i class={`${getFileIcon(selectedFile()!)} w-5 h-5 text-gray-500 flex-shrink-0`} />
                <div class="min-w-0">
                  <h3 class="font-semibold truncate" title={selectedFile()!.name}>{selectedFile()!.name}</h3>
                  <p class="text-xs text-muted">
                    {formatFileSize(selectedFile()!.size)} • <span title={formatFullDateTime(selectedFile()!.modified)}>{formatRelativeTime(selectedFile()!.modified)}</span>
                  </p>
                </div>
              </div>

              <div class="flex gap-1 flex-shrink-0">
                <button
                  class="btn-ghost btn-sm p-1.5"
                  onClick={handleShowFileInExplorer}
                  title="Показать файл в проводнике"
                >
                  <i class="i-hugeicons-folder-search w-4 h-4" />
                </button>
                <button
                  class="btn-ghost btn-sm p-1.5"
                  onClick={handleRename}
                  title="Переименовать файл"
                >
                  <i class="i-hugeicons-edit-02 w-4 h-4" />
                </button>
                <button
                  class="btn-ghost btn-sm p-1.5"
                  onClick={handleCopy}
                  title="Создать копию файла"
                >
                  <i class="i-hugeicons-copy-01 w-4 h-4" />
                </button>
                <button
                  class="btn-ghost btn-sm p-1.5 text-red-400 hover:text-red-300"
                  onClick={handleDelete}
                  title="Удалить файл"
                >
                  <i class="i-hugeicons-delete-02 w-4 h-4" />
                </button>
              </div>
            </div>
          </div>

          {/* Code Preview - Read only */}
          <Show when={selectedFile() && isTextFile(selectedFile()!.name)}>
            <Show when={fileContent()}>
              <div
                ref={codeContainerRef}
                class="flex-1 min-h-0 overflow-hidden"
              >
                <CodeViewer
                  code={fileContent()!}
                  language={getFileLanguage(selectedFile()!.name)}
                  filename={selectedFile()!.name}
                  showLineNumbers={true}
                  showHeader={true}
                  maxHeight="100%"
                  class="h-full"
                />
              </div>
            </Show>
          </Show>

          {/* Binary file notice */}
          <Show when={selectedFile() && !isTextFile(selectedFile()!.name)}>
            <div class="card flex-1 flex-col-center text-center">
              <i class="i-hugeicons-image-not-found-01 w-16 h-16 text-gray-600 mb-4" />
              <h3 class="text-lg font-semibold mb-2">Предпросмотр недоступен</h3>
              <p class="text-muted text-sm max-w-md">
                Файл {selectedFile()!.name} не является текстовым и не может быть отображён в редакторе
              </p>
              <div class="mt-4 text-xs text-muted">
                Поддерживаются: .toml, .json, .properties, .cfg, .txt, .java, .js, .py и другие текстовые форматы
              </div>
            </div>
          </Show>
        </Show>
      </div>

      <ConfirmDialogComponent />

      {/* Rename Dialog */}
      <Show when={showRenameDialog()}>
        <div class="modal-backdrop" onClick={() => setShowRenameDialog(false)}>
          <div class="modal-content max-w-md" onClick={(e) => e.stopPropagation()}>
            <h2 class="text-xl font-semibold mb-4">Переименовать</h2>
            <div class="mb-4">
              <label class="block text-sm font-medium mb-2">Новое имя</label>
              <input
                type="text"
                value={newName()}
                onInput={(e) => setNewName(e.currentTarget.value)}
                class="w-full"
                placeholder={t().ui.placeholders.enterNewName}
                onKeyPress={(e) => {
                  if (e.key === "Enter") {
                    confirmRename();
                  }
                }}
              />
            </div>
            <div class="flex gap-2 justify-end">
              <button
                class="btn-secondary"
                onClick={() => setShowRenameDialog(false)}
              >
                Отмена
              </button>
              <button
                class="btn-primary"
                onClick={confirmRename}
                disabled={!newName().trim()}
              >
                Переименовать
              </button>
            </div>
          </div>
        </div>
      </Show>

      {/* Copy Dialog */}
      <Show when={showCopyDialog()}>
        <div class="modal-backdrop" onClick={() => setShowCopyDialog(false)}>
          <div class="modal-content max-w-md" onClick={(e) => e.stopPropagation()}>
            <h2 class="text-xl font-semibold mb-4">Копировать</h2>
            <div class="mb-4">
              <label class="block text-sm font-medium mb-2">Имя копии</label>
              <input
                type="text"
                value={newName()}
                onInput={(e) => setNewName(e.currentTarget.value)}
                class="w-full"
                placeholder={t().ui.placeholders.enterCopyName}
                onKeyPress={(e) => {
                  if (e.key === "Enter") {
                    confirmCopy();
                  }
                }}
              />
            </div>
            <div class="flex gap-2 justify-end">
              <button
                class="btn-secondary"
                onClick={() => setShowCopyDialog(false)}
              >
                Отмена
              </button>
              <button
                class="btn-primary"
                onClick={confirmCopy}
                disabled={!newName().trim()}
              >
                Копировать
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}
