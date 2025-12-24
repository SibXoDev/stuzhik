import { Show, createSignal, createEffect, createMemo, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { FileEntry } from "../../../shared/types";
import { MonacoEditor } from "../../../shared/components";
import { createConfirmDialog } from "../../../shared/components/ConfirmDialog";
import { addToast } from "../../../shared/components/Toast";
import { FileTree } from "./FileTree";
import { FileTabs, type OpenFile } from "./FileTabs";
import { RecipePreview } from "./RecipePreview";

interface EditorPanelProps {
  instanceId: string;
}

interface FileContent {
  path: string;
  content: string;
  originalContent: string;
  language: string;
}

// Text file extensions
const TEXT_EXTENSIONS = [
  ".txt", ".json", ".jsonc", ".json5", ".toml", ".yaml", ".yml",
  ".properties", ".cfg", ".conf", ".ini", ".xml",
  ".mcmeta", ".log",
  ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts",
  ".java", ".py", ".pyw", ".rs", ".lua", ".zs",
  ".sh", ".bash", ".zsh", ".bat", ".cmd", ".gradle",
  ".html", ".htm", ".css", ".scss", ".sass", ".less",
  ".md", ".markdown", ".mcfunction",
];

// Language detection
const getFileLanguage = (filename: string): string => {
  const ext = filename.split(".").pop()?.toLowerCase();
  const name = filename.toLowerCase();

  if (name === "dockerfile") return "dockerfile";
  if (name === "build.gradle" || name.endsWith(".gradle")) return "gradle";
  if (name.endsWith(".mcfunction")) return "shell";

  switch (ext) {
    case "json": return "json";
    case "jsonc": case "json5": return "jsonc";
    case "toml": return "toml";
    case "yaml": case "yml": return "yaml";
    case "properties": case "cfg": case "conf": case "ini": return "properties";
    case "xml": return "xml";
    case "js": case "mjs": case "cjs": return "javascript";
    case "ts": case "mts": case "cts": return "typescript";
    case "java": return "java";
    case "py": case "pyw": return "python";
    case "rs": return "rust";
    case "lua": return "lua";
    case "sh": case "bash": case "zsh": return "shell";
    case "bat": case "cmd": return "bat";
    case "html": case "htm": return "html";
    case "css": case "scss": case "sass": case "less": return "css";
    case "md": case "markdown": return "markdown";
    case "zs": return "java"; // ZenScript
    default: return "txt";
  }
};

const isTextFile = (filename: string): boolean => {
  return TEXT_EXTENSIONS.some((ext) => filename.toLowerCase().endsWith(ext));
};

export function EditorPanel(props: EditorPanelProps) {
  // File tree state
  const [currentPath, setCurrentPath] = createSignal("");
  const [files, setFiles] = createSignal<FileEntry[]>([]);
  const [loading, setLoading] = createSignal(false);

  // Open files state
  const [openFiles, setOpenFiles] = createSignal<FileContent[]>([]);
  const [activeFilePath, setActiveFilePath] = createSignal<string | null>(null);

  // UI state
  const [sidebarWidth, setSidebarWidth] = createSignal(280);
  const [isResizing, setIsResizing] = createSignal(false);

  const { confirm, ConfirmDialogComponent } = createConfirmDialog();

  // Load files for current path
  const loadFiles = async (path: string) => {
    setLoading(true);
    try {
      const entries = await invoke<FileEntry[]>("browse_instance_files", {
        instanceId: props.instanceId,
        subpath: path || ".",
      });
      setFiles(entries);
      setCurrentPath(path);
    } catch (e) {
      console.error("Failed to load files:", e);
      addToast({
        type: "error",
        title: "Ошибка загрузки",
        message: String(e),
        duration: 5000,
      });
    } finally {
      setLoading(false);
    }
  };

  // Load files on mount
  onMount(() => {
    loadFiles("");
  });

  // Reload when instanceId changes
  createEffect(() => {
    if (props.instanceId) {
      loadFiles("");
      setOpenFiles([]);
      setActiveFilePath(null);
    }
  });

  // Get active file content
  const activeFile = createMemo(() => {
    const path = activeFilePath();
    if (!path) return null;
    return openFiles().find((f) => f.path === path) || null;
  });

  // Get open files for tabs
  const tabFiles = createMemo((): OpenFile[] => {
    return openFiles().map((f) => ({
      path: f.path,
      name: f.path.split("/").pop() || f.path,
      isDirty: f.content !== f.originalContent,
      language: f.language,
    }));
  });

  // Open a file
  const openFile = async (entry: FileEntry) => {
    if (entry.is_dir) return;

    // Check if already open
    const existing = openFiles().find((f) => f.path === entry.path);
    if (existing) {
      setActiveFilePath(entry.path);
      return;
    }

    // Check if text file
    if (!isTextFile(entry.name)) {
      addToast({
        type: "info",
        title: "Файл не поддерживается",
        message: "Редактирование доступно только для текстовых файлов",
        duration: 3000,
      });
      return;
    }

    // Check file size (1MB limit)
    if (entry.size > 1024 * 1024) {
      addToast({
        type: "warning",
        title: "Файл слишком большой",
        message: "Файлы больше 1MB не могут быть открыты в редакторе",
        duration: 5000,
      });
      return;
    }

    try {
      const content = await invoke<string>("read_instance_file", {
        instanceId: props.instanceId,
        relativePath: entry.path,
      });

      const language = getFileLanguage(entry.name);

      setOpenFiles((prev) => [
        ...prev,
        {
          path: entry.path,
          content,
          originalContent: content,
          language,
        },
      ]);
      setActiveFilePath(entry.path);
    } catch (e) {
      console.error("Failed to read file:", e);
      addToast({
        type: "error",
        title: "Ошибка чтения",
        message: String(e),
        duration: 5000,
      });
    }
  };

  // Close a file
  const closeFile = async (path: string) => {
    const file = openFiles().find((f) => f.path === path);
    if (!file) return;

    // Check for unsaved changes
    if (file.content !== file.originalContent) {
      const confirmed = await confirm({
        title: "Несохранённые изменения",
        message: `Файл "${path.split("/").pop()}" содержит несохранённые изменения. Закрыть без сохранения?`,
        variant: "warning",
        confirmText: "Закрыть",
        cancelText: "Отмена",
      });

      if (!confirmed) return;
    }

    // Remove from open files
    setOpenFiles((prev) => prev.filter((f) => f.path !== path));

    // Update active file
    if (activeFilePath() === path) {
      const remaining = openFiles().filter((f) => f.path !== path);
      setActiveFilePath(remaining.length > 0 ? remaining[remaining.length - 1].path : null);
    }
  };

  // Close all files
  const closeAllFiles = async () => {
    const hasUnsaved = openFiles().some((f) => f.content !== f.originalContent);

    if (hasUnsaved) {
      const confirmed = await confirm({
        title: "Несохранённые изменения",
        message: "Некоторые файлы содержат несохранённые изменения. Закрыть все без сохранения?",
        variant: "warning",
        confirmText: "Закрыть все",
        cancelText: "Отмена",
      });

      if (!confirmed) return;
    }

    setOpenFiles([]);
    setActiveFilePath(null);
  };

  // Update file content
  const updateContent = (path: string, content: string) => {
    setOpenFiles((prev) =>
      prev.map((f) => (f.path === path ? { ...f, content } : f))
    );
  };

  // Save active file
  const saveActiveFile = async () => {
    const file = activeFile();
    if (!file) return;

    try {
      await invoke("write_instance_file", {
        instanceId: props.instanceId,
        relativePath: file.path,
        content: file.content,
      });

      // Update original content
      setOpenFiles((prev) =>
        prev.map((f) =>
          f.path === file.path ? { ...f, originalContent: file.content } : f
        )
      );

      addToast({
        type: "success",
        title: "Сохранено",
        message: `${file.path.split("/").pop()} сохранён`,
        duration: 2000,
      });
    } catch (e) {
      console.error("Failed to save file:", e);
      addToast({
        type: "error",
        title: "Ошибка сохранения",
        message: String(e),
        duration: 5000,
      });
    }
  };

  // Handle resize
  const handleResizeStart = (e: MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);

    const startX = e.clientX;
    const startWidth = sidebarWidth();

    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - startX;
      const newWidth = Math.max(200, Math.min(500, startWidth + delta));
      setSidebarWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  };

  // Open in explorer
  const openInExplorer = async () => {
    try {
      await invoke("open_instance_folder", {
        id: props.instanceId,
        subfolder: currentPath() || null,
      });
    } catch (e) {
      console.error("Failed to open folder:", e);
    }
  };

  return (
    <div class="flex h-full">
      {/* Sidebar - File Tree */}
      <div
        class="flex-shrink-0 border-r border-gray-750 bg-gray-850 flex flex-col"
        style={{ width: `${sidebarWidth()}px` }}
      >
        {/* Sidebar header */}
        <div class="flex items-center justify-between px-3 py-2 border-b border-gray-750">
          <span class="text-sm font-medium">Файлы</span>
          <button
            class="p-1 rounded hover:bg-gray-700 transition-colors"
            onClick={openInExplorer}
            title="Открыть в проводнике"
          >
            <i class="i-hugeicons-folder-open w-4 h-4 text-gray-400" />
          </button>
        </div>

        {/* File tree */}
        <FileTree
          files={files()}
          currentPath={currentPath()}
          selectedPath={activeFilePath()}
          onSelect={openFile}
          onNavigate={loadFiles}
          loading={loading()}
        />
      </div>

      {/* Resize handle */}
      <div
        class={`w-1 cursor-col-resize hover:bg-blue-500/50 transition-colors ${
          isResizing() ? "bg-blue-500/50" : ""
        }`}
        onMouseDown={handleResizeStart}
      />

      {/* Main content */}
      <div class="flex-1 flex flex-col min-w-0">
        {/* File tabs */}
        <FileTabs
          files={tabFiles()}
          activeFile={activeFilePath()}
          onSelect={setActiveFilePath}
          onClose={closeFile}
          onCloseAll={closeAllFiles}
        />

        {/* Editor or empty state */}
        <Show
          when={activeFile()}
          fallback={
            <div class="flex-1 flex-col-center text-center">
              <i class="i-hugeicons-file-search w-16 h-16 text-gray-600 mb-4" />
              <h3 class="text-lg font-semibold mb-2">Выберите файл</h3>
              <p class="text-muted text-sm max-w-md">
                Используйте файловое дерево слева для навигации и выбора файлов для редактирования
              </p>
              <div class="mt-6 flex gap-4 text-xs text-gray-500">
                <div class="flex items-center gap-1">
                  <i class="i-hugeicons-keyboard w-4 h-4" />
                  <span>Ctrl+S - сохранить</span>
                </div>
                <div class="flex items-center gap-1">
                  <i class="i-hugeicons-full-screen w-4 h-4" />
                  <span>F11 - полный экран</span>
                </div>
              </div>
            </div>
          }
        >
          <div class="flex-1 flex flex-col min-h-0">
            {/* Monaco Editor */}
            <div class="flex-1 min-h-0">
              <MonacoEditor
                value={activeFile()!.content}
                onChange={(value) => updateContent(activeFile()!.path, value)}
                onSave={saveActiveFile}
                language={activeFile()!.language as any}
                fileName={activeFile()!.path}
              />
            </div>

            {/* Recipe Preview */}
            <RecipePreview
              content={activeFile()!.content}
              language={activeFile()!.language}
              fileName={activeFile()!.path}
            />
          </div>
        </Show>
      </div>

      <ConfirmDialogComponent />
    </div>
  );
}
