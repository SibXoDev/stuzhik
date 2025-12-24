import { Show, For, createSignal, createEffect, createMemo } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { useFileBrowser } from "../../../shared/hooks";
import type { FileEntry } from "../../../shared/types";
import { createConfirmDialog } from "../../../shared/components/ConfirmDialog";
import { addToast } from "../../../shared/components/Toast";
import { MonacoEditor } from "../../../shared/components";
import { formatRelativeTime, formatFullDateTime } from "../../../shared/utils/date-formatter";

interface FileBrowserPanelProps {
  instanceId: string;
}

export function FileBrowserPanel(props: FileBrowserPanelProps) {
  const browser = useFileBrowser(() => props.instanceId);
  const [selectedFile, setSelectedFile] = createSignal<FileEntry | null>(null);
  const [fileContent, setFileContent] = createSignal<string | null>(null);
  const [editedContent, setEditedContent] = createSignal("");
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

  createEffect(() => {
    if (props.instanceId) {
      browser.browse("");
    }
  });

  const handleNavigate = (entry: FileEntry) => {
    if (entry.is_dir) {
      browser.browse(entry.path);
      setSelectedFile(null);
      setFileContent(null);
    } else {
      handleSelectFile(entry);
    }
  };

  const handleSelectFile = async (entry: FileEntry) => {
    setSelectedFile(entry);

    // Try to load text files
    if (entry.size < 1024 * 1024 && isTextFile(entry.name)) {
      const content = await browser.readFile(entry.path);
      if (content) {
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

    const parts = currentPath.split("/").filter(Boolean);
    parts.pop();
    browser.browse(parts.join("/"));
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
      const currentPath = browser.currentPath();
      await invoke("open_instance_folder", {
        id: props.instanceId,
        subfolder: currentPath || null,
      });
    } catch (e) {
      console.error("Failed to open folder:", e);
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

  const handleSave = async () => {
    const file = selectedFile();
    if (!file) return;

    const success = await browser.writeFile(file.path, editedContent());
    if (success) {
      setFileContent(editedContent());
      addToast({
        type: "success",
        title: "Файл сохранён",
        message: `${file.name} успешно сохранён`,
        duration: 3000,
      });
    } else {
      addToast({
        type: "error",
        title: "Ошибка сохранения",
        message: "Не удалось сохранить файл",
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
    if (name === "build.gradle" || name.endsWith(".gradle")) return "gradle";
    if (name.endsWith(".mcfunction")) return "shell"; // Minecraft functions

    // Extension-based detection
    switch (ext) {
      // Config files
      case "json": return "json";
      case "jsonc": case "json5": return "jsonc"; // JSON with Comments
      case "toml": return "toml";
      case "yaml": case "yml": return "yaml";
      case "properties": case "cfg": case "conf": case "ini": return "properties";
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
    ];

    return textExtensions.some((ext) => filename.toLowerCase().endsWith(ext));
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
              placeholder={useGlobalSearch() ? "Глобальный поиск..." : "Поиск файлов..."}
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
      <div class="flex-1 flex flex-col gap-3 min-w-0">
        <Show when={!selectedFile()}>
          <div class="card flex-1 flex-col-center text-center">
            <i class="i-hugeicons-folder-search w-16 h-16 text-gray-600 mb-4" />
            <h3 class="text-lg font-semibold mb-2">Браузер файлов</h3>
            <p class="text-muted text-sm max-w-md">
              Навигация по файлам instance. Выберите файл для предпросмотра
            </p>
            <div class="mt-6 flex gap-2">
              <div class="px-3 py-2 rounded bg-gray-800 text-xs">
                <i class="i-hugeicons-mouse-left-click-02 w-4 h-4 inline mr-1" />
                Открыть папку / файл
              </div>
            </div>
          </div>
        </Show>

        <Show when={selectedFile()}>
          {/* Header */}
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3">
              <i class={`${getFileIcon(selectedFile()!)} w-5 h-5 text-gray-500`} />
              <div>
                <h3 class="font-semibold">{selectedFile()!.name}</h3>
                <p class="text-xs text-muted">
                  {formatFileSize(selectedFile()!.size)} • <span title={formatFullDateTime(selectedFile()!.modified)}>{formatRelativeTime(selectedFile()!.modified)}</span>
                </p>
              </div>
            </div>

            <div class="flex gap-2">
              <button
                class="btn-secondary btn-sm"
                onClick={handleRename}
              >
                <i class="i-hugeicons-edit-02 w-4 h-4" />
                Переименовать
              </button>
              <button
                class="btn-secondary btn-sm"
                onClick={handleCopy}
              >
                <i class="i-hugeicons-copy-01 w-4 h-4" />
                Копировать
              </button>
              <button
                class="btn-secondary btn-sm text-red-400 hover:text-red-300"
                onClick={handleDelete}
              >
                <i class="i-hugeicons-delete-02 w-4 h-4" />
                Удалить
              </button>
            </div>
          </div>

          {/* Monaco Editor - Only for text files */}
          <Show when={selectedFile() && isTextFile(selectedFile()!.name)}>
            <Show when={fileContent()}>
              <div class="flex-1 min-h-0">
                <MonacoEditor
                  value={editedContent()}
                  onChange={setEditedContent}
                  onSave={handleSave}
                  language={getFileLanguage(selectedFile()!.name)}
                  fileName={selectedFile()!.path}
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
                placeholder="Введите новое имя..."
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
                placeholder="Введите имя копии..."
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
