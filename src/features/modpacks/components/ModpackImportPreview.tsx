import { For, Show, createSignal, createMemo, createEffect } from "solid-js";
import type { Component } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { ModpackDetailedPreview, ImportOverrideInfo, ImportFileCategory, OptionalModGroup } from "../../../shared/types";
import CodeViewer from "../../../shared/components/CodeViewer";
import { formatSize } from "../../../shared/utils/format-size";
import { useI18n } from "../../../shared/i18n";

interface Props {
  filePath: string;
  onClose: () => void;
  onImport: (instanceName: string, excludedMods: string[], excludedOverrides: string[]) => void;
  importing?: boolean;
}

/** Иконка для категории файла */
const getCategoryIcon = (category: ImportFileCategory): string => {
  switch (category) {
    case "mod": return "i-hugeicons-package";
    case "config": return "i-hugeicons-settings-02";
    case "resource_pack": return "i-hugeicons-image-02";
    case "shader_pack": return "i-hugeicons-sun-03";
    case "script": return "i-hugeicons-source-code";
    case "world": return "i-hugeicons-globe-02";
    default: return "i-hugeicons-file-01";
  }
};

/** Цвет для категории файла */
const getCategoryColor = (category: ImportFileCategory): string => {
  switch (category) {
    case "mod": return "text-blue-400";
    case "config": return "text-yellow-400";
    case "resource_pack": return "text-green-400";
    case "shader_pack": return "text-purple-400";
    case "script": return "text-cyan-400";
    case "world": return "text-orange-400";
    default: return "text-gray-400";
  }
};

/** Название категории */
const getCategoryName = (category: ImportFileCategory): string => {
  switch (category) {
    case "mod": return "Моды";
    case "config": return "Конфиги";
    case "resource_pack": return "Ресурспаки";
    case "shader_pack": return "Шейдеры";
    case "script": return "Скрипты";
    case "world": return "Миры";
    default: return "Другое";
  }
};

/** Tree node for file hierarchy */
interface TreeNode {
  name: string;
  path: string;
  isFolder: boolean;
  children: TreeNode[];
  file?: ImportOverrideInfo; // Only for leaf nodes
}

/** Build tree from flat file list */
function buildFileTree(files: ImportOverrideInfo[]): TreeNode {
  const root: TreeNode = { name: "", path: "", isFolder: true, children: [] };

  for (const file of files) {
    const parts = file.dest_path.split("/").filter(Boolean);
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const currentPath = parts.slice(0, i + 1).join("/");

      let child = current.children.find((c) => c.name === part);

      if (!child) {
        child = {
          name: part,
          path: currentPath,
          isFolder: !isLast,
          children: [],
          file: isLast ? file : undefined,
        };
        current.children.push(child);
      }

      current = child;
    }
  }

  // Sort: folders first, then alphabetically
  const sortChildren = (node: TreeNode) => {
    node.children.sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    node.children.forEach(sortChildren);
  };
  sortChildren(root);

  return root;
}

const ModpackImportPreview: Component<Props> = (props) => {
  const { t } = useI18n();
  const [preview, setPreview] = createSignal<ModpackDetailedPreview | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [instanceName, setInstanceName] = createSignal("");
  const fmtSize = (bytes: number) => formatSize(bytes, t().ui?.units);

  // Track enabled/disabled state for mods and overrides
  const [modsEnabled, setModsEnabled] = createSignal<Record<string, boolean>>({});
  const [overridesEnabled, setOverridesEnabled] = createSignal<Record<string, boolean>>({});

  // Active tab for files view
  const [activeTab, setActiveTab] = createSignal<"mods" | "files" | "tree" | "optional">("mods");

  // Track optional mods selection (mod_id -> enabled)
  const [optionalModsSelection, setOptionalModsSelection] = createSignal<Record<string, boolean>>({});

  // Expand/collapse categories
  const [expandedCategories, setExpandedCategories] = createSignal<Set<ImportFileCategory>>(new Set());

  // Expand/collapse tree folders
  const [expandedFolders, setExpandedFolders] = createSignal<Set<string>>(new Set([""])); // Root expanded by default

  // File preview state
  const [previewFile, setPreviewFile] = createSignal<ImportOverrideInfo | null>(null);
  const [previewContent, setPreviewContent] = createSignal<string | null>(null);
  const [previewLoading, setPreviewLoading] = createSignal(false);

  // Load file content for preview
  const loadFilePreview = async (file: ImportOverrideInfo) => {
    setPreviewFile(file);
    setPreviewContent(null);
    setPreviewLoading(true);

    try {
      const content = await invoke<string | null>("read_modpack_file_content", {
        archivePath: props.filePath,
        filePath: file.archive_path,
      });
      setPreviewContent(content);
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to load file content:", e);
      setPreviewContent(null);
    } finally {
      setPreviewLoading(false);
    }
  };

  // Check if file can be previewed (text files only)
  const canPreview = (filename: string): boolean => {
    const ext = filename.split(".").pop()?.toLowerCase() || "";
    const lowerName = filename.toLowerCase();

    // Known text files without extension
    const knownTextFiles = ["dockerfile", "makefile", "readme", "license", "changelog", "eula"];
    if (knownTextFiles.some(f => lowerName === f || lowerName.startsWith(f + "."))) {
      return true;
    }

    const textExtensions = [
      // Config & Data
      "json", "json5", "jsonc", "toml", "cfg", "conf", "ini", "properties",
      "txt", "md", "yml", "yaml", "xml", "html", "css", "mcmeta", "log",
      // Programming
      "js", "mjs", "cjs", "ts", "mts", "cts",
      "java", "py", "pyw", "rs", "lua", "zs",
      // Scripts
      "sh", "bash", "zsh", "bat", "cmd", "gradle",
      // Minecraft specific
      "mcfunction", "lang", "snbt", "accesswidener",
      "list", "launchproperties", "server", "option",
      // Backup/disabled files (often text)
      "disabled", "bak", "old",
      // Dev config
      "env", "gitignore", "gitattributes", "gitmodules",
      "editorconfig", "prettierrc", "eslintrc",
    ];
    return textExtensions.includes(ext);
  };

  // Load preview on mount
  createEffect(() => {
    const path = props.filePath;
    if (!path) return;

    setLoading(true);
    setError(null);

    invoke<ModpackDetailedPreview>("preview_modpack_detailed", { filePath: path })
      .then((data) => {
        setPreview(data);
        setInstanceName(data.name);

        // Initialize all mods as enabled
        const modsState: Record<string, boolean> = {};
        for (const mod of data.mods) {
          modsState[mod.path] = mod.enabled;
        }
        setModsEnabled(modsState);

        // Initialize all overrides as enabled
        const overridesState: Record<string, boolean> = {};
        for (const override of data.overrides) {
          overridesState[override.archive_path] = override.enabled;
        }
        setOverridesEnabled(overridesState);

        // Initialize optional mods selection based on default_enabled
        if (data.optional_mods && data.optional_mods.length > 0) {
          const optionalState: Record<string, boolean> = {};
          for (const group of data.optional_mods) {
            for (const mod of group.mods) {
              optionalState[mod.mod_id] = mod.default_enabled;
            }
          }
          setOptionalModsSelection(optionalState);
        }
      })
      .catch((e) => {
        setError(String(e));
      })
      .finally(() => {
        setLoading(false);
      });
  });

  // Group overrides by category
  const overridesByCategory = createMemo(() => {
    const p = preview();
    if (!p) return new Map<ImportFileCategory, ImportOverrideInfo[]>();

    const grouped = new Map<ImportFileCategory, ImportOverrideInfo[]>();
    for (const override of p.overrides) {
      const list = grouped.get(override.category) || [];
      list.push(override);
      grouped.set(override.category, list);
    }
    return grouped;
  });

  // Count enabled items
  const enabledModsCount = createMemo(() => {
    const state = modsEnabled();
    return Object.values(state).filter(Boolean).length;
  });

  const enabledOverridesCount = createMemo(() => {
    const state = overridesEnabled();
    return Object.values(state).filter(Boolean).length;
  });

  // Calculate selected size
  const selectedModsSize = createMemo(() => {
    const p = preview();
    const state = modsEnabled();
    if (!p) return 0;
    return p.mods.filter(m => state[m.path]).reduce((sum, m) => sum + m.size, 0);
  });

  const selectedOverridesSize = createMemo(() => {
    const p = preview();
    const state = overridesEnabled();
    if (!p) return 0;
    return p.overrides.filter(o => state[o.archive_path]).reduce((sum, o) => sum + o.size, 0);
  });

  // Toggle functions
  const toggleMod = (path: string) => {
    setModsEnabled(prev => ({ ...prev, [path]: !prev[path] }));
  };

  const toggleOverride = (archivePath: string) => {
    setOverridesEnabled(prev => ({ ...prev, [archivePath]: !prev[archivePath] }));
  };

  const toggleAllMods = (enabled: boolean) => {
    const p = preview();
    if (!p) return;
    const newState: Record<string, boolean> = {};
    for (const mod of p.mods) {
      newState[mod.path] = enabled;
    }
    setModsEnabled(newState);
  };

  const toggleCategory = (category: ImportFileCategory, enabled: boolean) => {
    const overrides = overridesByCategory().get(category) || [];
    setOverridesEnabled(prev => {
      const newState = { ...prev };
      for (const override of overrides) {
        newState[override.archive_path] = enabled;
      }
      return newState;
    });
  };

  const toggleCategoryExpand = (category: ImportFileCategory) => {
    setExpandedCategories(prev => {
      const newSet = new Set(prev);
      if (newSet.has(category)) {
        newSet.delete(category);
      } else {
        newSet.add(category);
      }
      return newSet;
    });
  };

  // Toggle folder expand/collapse in tree view
  const toggleFolder = (path: string) => {
    setExpandedFolders(prev => {
      const newSet = new Set(prev);
      if (newSet.has(path)) {
        newSet.delete(path);
      } else {
        newSet.add(path);
      }
      return newSet;
    });
  };

  // Build file tree for tree view
  const fileTree = createMemo(() => {
    const p = preview();
    if (!p) return null;
    return buildFileTree(p.overrides);
  });

  // Get folder enabled status (all/some/none)
  const getFolderEnabledStatus = (node: TreeNode): "all" | "some" | "none" => {
    const state = overridesEnabled();
    const collectFiles = (n: TreeNode): ImportOverrideInfo[] => {
      if (n.file) return [n.file];
      return n.children.flatMap(collectFiles);
    };
    const files = collectFiles(node);
    if (files.length === 0) return "none";
    const enabledCount = files.filter(f => state[f.archive_path]).length;
    if (enabledCount === files.length) return "all";
    if (enabledCount === 0) return "none";
    return "some";
  };

  // Toggle all files in a folder
  const toggleFolderFiles = (node: TreeNode, enabled: boolean) => {
    const collectPaths = (n: TreeNode): string[] => {
      if (n.file) return [n.file.archive_path];
      return n.children.flatMap(collectPaths);
    };
    const paths = collectPaths(node);
    setOverridesEnabled(prev => {
      const newState = { ...prev };
      for (const path of paths) {
        newState[path] = enabled;
      }
      return newState;
    });
  };

  // Check if modpack has optional mods
  const hasOptionalMods = createMemo(() => {
    const p = preview();
    return p?.optional_mods && p.optional_mods.length > 0;
  });

  // Toggle optional mod (for multiple selection type)
  const toggleOptionalMod = (modId: string) => {
    setOptionalModsSelection(prev => ({ ...prev, [modId]: !prev[modId] }));
  };

  // Select optional mod (for single selection type - radio button behavior)
  const selectOptionalMod = (group: OptionalModGroup, modId: string) => {
    setOptionalModsSelection(prev => {
      const newState = { ...prev };
      // Disable all mods in the group first
      for (const mod of group.mods) {
        newState[mod.mod_id] = false;
      }
      // Enable only the selected one
      newState[modId] = true;
      return newState;
    });
  };

  // Get optional mods count
  const optionalModsCount = createMemo(() => {
    const p = preview();
    if (!p?.optional_mods) return { selected: 0, total: 0 };
    const selection = optionalModsSelection();
    let total = 0;
    let selected = 0;
    for (const group of p.optional_mods) {
      for (const mod of group.mods) {
        total++;
        if (selection[mod.mod_id]) selected++;
      }
    }
    return { selected, total };
  });

  // Get excluded items for import
  const getExcludedMods = (): string[] => {
    const state = modsEnabled();
    const optionalSelection = optionalModsSelection();
    const p = preview();

    // Get disabled mods from main mods list
    const excludedFromMain = Object.entries(state)
      .filter(([_, enabled]) => !enabled)
      .map(([path]) => path);

    // Get disabled optional mods (match by mod_id to mods[].path containing mod_id)
    const excludedFromOptional: string[] = [];
    if (p?.optional_mods) {
      for (const group of p.optional_mods) {
        for (const optMod of group.mods) {
          if (!optionalSelection[optMod.mod_id]) {
            // Find the corresponding mod path
            const mod = p.mods.find(m =>
              m.filename.toLowerCase().includes(optMod.mod_id.toLowerCase()) ||
              m.name?.toLowerCase().includes(optMod.mod_id.toLowerCase())
            );
            if (mod) {
              excludedFromOptional.push(mod.path);
            }
          }
        }
      }
    }

    return [...new Set([...excludedFromMain, ...excludedFromOptional])];
  };

  const getExcludedOverrides = (): string[] => {
    const state = overridesEnabled();
    return Object.entries(state)
      .filter(([_, enabled]) => !enabled)
      .map(([path]) => path);
  };

  const handleImport = () => {
    const name = instanceName().trim();
    if (!name) return;
    props.onImport(name, getExcludedMods(), getExcludedOverrides());
  };

  // Format badge for format type
  const formatBadge = createMemo(() => {
    const p = preview();
    if (!p) return null;

    switch (p.format) {
      case "modrinth":
        return { text: "Modrinth", class: "bg-green-600/20 text-green-400 border-green-600/30" };
      case "stzhk":
        return { text: "Stuzhik", class: "bg-cyan-600/20 text-cyan-400 border-cyan-600/30" };
      case "curseforge":
        return { text: "CurseForge", class: "bg-orange-600/20 text-orange-400 border-orange-600/30" };
      default:
        return { text: "Unknown", class: "bg-gray-600/20 text-gray-400 border-gray-600/30" };
    }
  });

  return (
    <div class="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div class="card max-w-4xl w-full max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div class="flex items-center justify-between p-4 border-b border-gray-750 flex-shrink-0">
          <h2 class="text-xl font-bold">Предпросмотр модпака</h2>
          <button
            class="btn-close"
            onClick={props.onClose}
            disabled={props.importing}
            aria-label={t().ui?.tooltips?.close ?? "Close"}
          >
            <i class="i-hugeicons-cancel-01 w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div class="flex-1 overflow-y-auto p-4 space-y-4 min-h-0">
          {/* Loading */}
          <Show when={loading()}>
            <div class="flex-center gap-2 py-12">
              <i class="i-svg-spinners-6-dots-scale w-8 h-8" />
              <span class="text-muted">Анализ модпака...</span>
            </div>
          </Show>

          {/* Error */}
          <Show when={error()}>
            <div class="card bg-red-600/10 border-red-600/30">
              <p class="text-red-400">{error()}</p>
            </div>
          </Show>

          {/* Preview content */}
          <Show when={preview() && !loading()}>
            {/* Basic info */}
            <div class="card bg-gray-alpha-50">
              <div class="flex items-start justify-between gap-4">
                <div class="flex-1 min-w-0">
                  <h3 class="text-lg font-semibold truncate">{preview()!.name}</h3>
                  <Show when={preview()!.author}>
                    <p class="text-sm text-muted">от {preview()!.author}</p>
                  </Show>
                  <Show when={preview()!.description}>
                    <p class="text-sm text-muted mt-1 line-clamp-2">{preview()!.description}</p>
                  </Show>
                </div>
                <Show when={formatBadge()}>
                  <span class={`badge ${formatBadge()!.class}`}>
                    {formatBadge()!.text}
                  </span>
                </Show>
              </div>

              <div class="grid grid-cols-4 gap-3 mt-4">
                <div class="card bg-gray-alpha-50 text-center">
                  <p class="text-xs text-dimmer">Minecraft</p>
                  <p class="font-medium">{preview()!.minecraft_version}</p>
                </div>
                <div class="card bg-gray-alpha-50 text-center">
                  <p class="text-xs text-dimmer">Загрузчик</p>
                  <p class="font-medium">{preview()!.loader || "—"}</p>
                  <Show when={preview()!.loader_version}>
                    <p class="text-xs text-muted">{preview()!.loader_version}</p>
                  </Show>
                </div>
                <div class="card bg-gray-alpha-50 text-center">
                  <p class="text-xs text-dimmer">Модов</p>
                  <p class="font-medium">{preview()!.mods.length}</p>
                </div>
                <div class="card bg-gray-alpha-50 text-center">
                  <p class="text-xs text-dimmer">Файлов</p>
                  <p class="font-medium">{preview()!.overrides.length}</p>
                </div>
              </div>
            </div>

            {/* Instance name */}
            <div>
              <label class="text-sm text-muted mb-1 block">Название экземпляра</label>
              <input
                type="text"
                value={instanceName()}
                onInput={(e) => setInstanceName(e.currentTarget.value)}
                class="w-full"
                placeholder="Введите название"
                disabled={props.importing}
              />
            </div>

            {/* Tabs */}
            <div class="flex gap-2 flex-wrap">
              <button
                class={`flex-1 min-w-fit px-4 py-2 rounded-2xl font-medium transition-colors duration-100 inline-flex items-center justify-center gap-2 ${
                  activeTab() === "mods"
                    ? "bg-blue-600 text-white"
                    : "bg-gray-800 text-gray-300 hover:bg-gray-750"
                }`}
                onClick={() => setActiveTab("mods")}
              >
                <i class="i-hugeicons-package w-4 h-4" />
                Моды ({enabledModsCount()}/{preview()!.mods.length})
              </button>
              <Show when={hasOptionalMods()}>
                <button
                  class={`flex-1 min-w-fit px-4 py-2 rounded-2xl font-medium transition-colors duration-100 inline-flex items-center justify-center gap-2 ${
                    activeTab() === "optional"
                      ? "bg-purple-600 text-white"
                      : "bg-gray-800 text-gray-300 hover:bg-gray-750"
                  }`}
                  onClick={() => setActiveTab("optional")}
                >
                  <i class="i-hugeicons-toggle-on w-4 h-4" />
                  Опциональные ({optionalModsCount().selected}/{optionalModsCount().total})
                </button>
              </Show>
              <button
                class={`flex-1 min-w-fit px-4 py-2 rounded-2xl font-medium transition-colors duration-100 inline-flex items-center justify-center gap-2 ${
                  activeTab() === "files"
                    ? "bg-blue-600 text-white"
                    : "bg-gray-800 text-gray-300 hover:bg-gray-750"
                }`}
                onClick={() => setActiveTab("files")}
              >
                <i class="i-hugeicons-folder-01 w-4 h-4" />
                По категориям
              </button>
              <button
                class={`flex-1 min-w-fit px-4 py-2 rounded-2xl font-medium transition-colors duration-100 inline-flex items-center justify-center gap-2 ${
                  activeTab() === "tree"
                    ? "bg-blue-600 text-white"
                    : "bg-gray-800 text-gray-300 hover:bg-gray-750"
                }`}
                onClick={() => setActiveTab("tree")}
              >
                <i class="i-hugeicons-hierarchy w-4 h-4" />
                Все файлы
              </button>
            </div>

            {/* Mods list */}
            <Show when={activeTab() === "mods"}>
              <div class="space-y-2">
                {/* Select all */}
                <div class="flex items-center justify-between bg-gray-800/50 rounded-xl px-3 py-2">
                  <span class="text-sm text-muted">Выбрано: {enabledModsCount()} из {preview()!.mods.length}</span>
                  <div class="flex gap-2">
                    <button
                      class="text-xs text-blue-400 hover:underline"
                      onClick={() => toggleAllMods(true)}
                    >
                      Выбрать все
                    </button>
                    <button
                      class="text-xs text-gray-400 hover:underline"
                      onClick={() => toggleAllMods(false)}
                    >
                      Снять все
                    </button>
                  </div>
                </div>

                {/* Mods */}
                <div class="max-h-64 overflow-y-auto space-y-1">
                  <For each={preview()!.mods}>
                    {(mod) => (
                      <div
                        class={`flex items-center gap-3 p-2 rounded-xl cursor-pointer transition-colors duration-100 ${
                          modsEnabled()[mod.path]
                            ? "bg-gray-800/50 hover:bg-gray-800"
                            : "bg-gray-900/50 opacity-50 hover:opacity-70"
                        }`}
                        onClick={() => toggleMod(mod.path)}
                      >
                        <input
                          type="checkbox"
                          checked={modsEnabled()[mod.path]}
                          class="w-4 h-4 accent-blue-600"
                          onChange={() => {}}
                        />
                        <i class="i-hugeicons-package w-4 h-4 text-blue-400 flex-shrink-0" />
                        <div class="flex-1 min-w-0">
                          <p class="text-sm truncate">
                            {mod.name || mod.filename}
                          </p>
                          <Show when={mod.name && mod.name !== mod.filename}>
                            <p class="text-xs text-dimmer truncate">{mod.filename}</p>
                          </Show>
                        </div>
                        <Show when={mod.side}>
                          <span class="badge badge-sm bg-gray-700/50 inline-flex items-center gap-1">
                            {mod.side === "client" ? (
                              <>
                                <i class="i-hugeicons-laptop w-3 h-3" />
                                Клиент
                              </>
                            ) : mod.side === "server" ? (
                              <>
                                <i class="i-hugeicons-database w-3 h-3" />
                                Сервер
                              </>
                            ) : (
                              <>
                                <i class="i-hugeicons-laptop w-3 h-3" />
                                <i class="i-hugeicons-database w-3 h-3" />
                              </>
                            )}
                          </span>
                        </Show>
                        <span class="text-xs text-dimmer">{fmtSize(mod.size)}</span>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            {/* Optional mods list */}
            <Show when={activeTab() === "optional" && hasOptionalMods()}>
              <div class="space-y-3">
                <div class="card bg-purple-600/10 border-purple-600/30">
                  <p class="text-sm text-purple-300">
                    <i class="i-hugeicons-information-circle w-4 h-4 inline-block mr-1" />
                    Опциональные моды можно включить или выключить по желанию.
                    Автор модпака сгруппировал их для удобства выбора.
                  </p>
                </div>

                <For each={preview()!.optional_mods}>
                  {(group) => {
                    const selection = () => optionalModsSelection();

                    return (
                      <div class="card bg-gray-alpha-50">
                        {/* Group header */}
                        <div class="flex items-center gap-3 mb-3">
                          <i class={`w-5 h-5 ${
                            group.selection_type === "single"
                              ? "i-hugeicons-radio text-purple-400"
                              : "i-hugeicons-checkbox-check text-purple-400"
                          }`} />
                          <div class="flex-1 min-w-0">
                            <h4 class="font-medium">{group.name}</h4>
                            <Show when={group.description}>
                              <p class="text-xs text-muted mt-0.5">{group.description}</p>
                            </Show>
                          </div>
                          <span class="badge bg-gray-700/50 text-xs">
                            {group.selection_type === "single" ? "Выберите один" : "Выберите любые"}
                          </span>
                        </div>

                        {/* Mods in group */}
                        <div class="space-y-1.5">
                          <For each={group.mods}>
                            {(optMod) => {
                              const isSelected = () => selection()[optMod.mod_id] ?? false;
                              // Find mod info from main mods list
                              const modInfo = () => preview()!.mods.find(m =>
                                m.filename.toLowerCase().includes(optMod.mod_id.toLowerCase()) ||
                                m.name?.toLowerCase().includes(optMod.mod_id.toLowerCase())
                              );

                              return (
                                <div
                                  class={`flex items-center gap-3 p-2.5 rounded-xl cursor-pointer transition-colors duration-100 ${
                                    isSelected()
                                      ? "bg-purple-600/10 hover:bg-purple-600/20"
                                      : "bg-gray-900/50 opacity-60 hover:opacity-80"
                                  }`}
                                  onClick={() => {
                                    if (group.selection_type === "single") {
                                      selectOptionalMod(group, optMod.mod_id);
                                    } else {
                                      toggleOptionalMod(optMod.mod_id);
                                    }
                                  }}
                                >
                                  {/* Radio or Checkbox */}
                                  {group.selection_type === "single" ? (
                                    <div class={`w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                                      isSelected() ? "border-purple-500 bg-purple-500" : "border-gray-500"
                                    }`}>
                                      <Show when={isSelected()}>
                                        <div class="w-2 h-2 rounded-full bg-white" />
                                      </Show>
                                    </div>
                                  ) : (
                                    <input
                                      type="checkbox"
                                      checked={isSelected()}
                                      class="w-4 h-4 accent-purple-600"
                                      onChange={() => {}}
                                    />
                                  )}

                                  <i class="i-hugeicons-package w-4 h-4 text-purple-400 flex-shrink-0" />

                                  <div class="flex-1 min-w-0">
                                    <p class="text-sm truncate">{modInfo()?.name || optMod.mod_id}</p>
                                    <Show when={optMod.note}>
                                      <p class="text-xs text-muted mt-0.5">{optMod.note}</p>
                                    </Show>
                                  </div>

                                  <Show when={optMod.default_enabled}>
                                    <span class="badge bg-purple-600/20 text-purple-300 text-xs">
                                      по умолчанию
                                    </span>
                                  </Show>

                                  <Show when={modInfo()}>
                                    <span class="text-xs text-dimmer">{fmtSize(modInfo()!.size)}</span>
                                  </Show>
                                </div>
                              );
                            }}
                          </For>
                        </div>
                      </div>
                    );
                  }}
                </For>
              </div>
            </Show>

            {/* Files list */}
            <Show when={activeTab() === "files"}>
              <div class="space-y-2">
                <Show when={preview()!.overrides.length === 0}>
                  <div class="text-center py-8 text-muted">
                    <i class="i-hugeicons-folder-01 w-12 h-12 mx-auto mb-2 opacity-50" />
                    <p>Нет дополнительных файлов</p>
                  </div>
                </Show>

                <For each={Array.from(overridesByCategory().entries())}>
                  {([category, files]) => {
                    // Use getter functions for reactivity inside For callback
                    const enabledCount = () => files.filter(f => overridesEnabled()[f.archive_path]).length;
                    const isExpanded = () => expandedCategories().has(category);

                    return (
                      <div class="card bg-gray-alpha-50 p-0 overflow-hidden">
                        {/* Category header */}
                        <div
                          class="flex items-center gap-3 p-3 cursor-pointer hover:bg-gray-800/30 transition-colors duration-100"
                          onClick={() => toggleCategoryExpand(category)}
                        >
                          <i class={`${getCategoryIcon(category)} w-5 h-5 ${getCategoryColor(category)}`} />
                          <span class="font-medium flex-1">{getCategoryName(category)}</span>
                          <span class="text-sm text-muted">{enabledCount()}/{files.length}</span>
                          <div class="flex gap-2" onClick={(e) => e.stopPropagation()}>
                            <button
                              class="text-xs text-blue-400 hover:underline px-2"
                              onClick={() => toggleCategory(category, true)}
                            >
                              Все
                            </button>
                            <button
                              class="text-xs text-gray-400 hover:underline px-2"
                              onClick={() => toggleCategory(category, false)}
                            >
                              Ничего
                            </button>
                          </div>
                          <i class={`w-4 h-4 transition-transform duration-100 ${
                            isExpanded() ? "i-hugeicons-arrow-up-01" : "i-hugeicons-arrow-down-01"
                          }`} />
                        </div>

                        {/* Files in category */}
                        <Show when={isExpanded()}>
                          <div class="border-t border-gray-750 max-h-48 overflow-y-auto">
                            <For each={files}>
                              {(file) => {
                                const filename = file.dest_path.split("/").pop() || file.dest_path;
                                const previewable = canPreview(filename);
                                return (
                                  <div
                                    class={`flex items-center gap-3 px-3 py-2 cursor-pointer transition-colors duration-100 ${
                                      overridesEnabled()[file.archive_path]
                                        ? "hover:bg-gray-800/30"
                                        : "opacity-50 hover:opacity-70"
                                    }`}
                                    onClick={() => toggleOverride(file.archive_path)}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={overridesEnabled()[file.archive_path]}
                                      class="w-4 h-4 accent-blue-600"
                                      onChange={() => {}}
                                    />
                                    <span class="text-sm flex-1 truncate">{file.dest_path}</span>
                                    <Show when={previewable}>
                                      <button
                                        class="p-1 rounded hover:bg-gray-700/50 text-gray-500 hover:text-gray-300 transition-colors"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          loadFilePreview(file);
                                        }}
                                        title="Предпросмотр"
                                      >
                                        <i class="i-hugeicons-view w-3.5 h-3.5" />
                                      </button>
                                    </Show>
                                    <span class="text-xs text-dimmer">{fmtSize(file.size)}</span>
                                  </div>
                                );
                              }}
                            </For>
                          </div>
                        </Show>
                      </div>
                    );
                  }}
                </For>
              </div>
            </Show>

            {/* Tree view */}
            <Show when={activeTab() === "tree"}>
              <div class="space-y-2">
                <Show when={preview()!.overrides.length === 0}>
                  <div class="text-center py-8 text-muted">
                    <i class="i-hugeicons-folder-01 w-12 h-12 mx-auto mb-2 opacity-50" />
                    <p>Нет дополнительных файлов</p>
                  </div>
                </Show>

                <Show when={fileTree()}>
                  <div class="card bg-gray-alpha-50 p-0 overflow-hidden max-h-80 overflow-y-auto">
                    {/* Recursive tree rendering */}
                    <For each={fileTree()!.children}>
                      {(node) => {
                        const renderNode = (node: TreeNode, depth: number): any => {
                          const isExpanded = () => expandedFolders().has(node.path);
                          const status = () => getFolderEnabledStatus(node);
                          const paddingLeft = `${depth * 1.25}rem`;

                          if (node.isFolder) {
                            return (
                              <div>
                                {/* Folder header */}
                                <div
                                  class="flex items-center gap-2 py-1.5 px-3 cursor-pointer hover:bg-gray-800/30 transition-colors duration-100"
                                  style={{ "padding-left": paddingLeft }}
                                >
                                  <button
                                    class="p-0.5 hover:bg-gray-700/50 rounded"
                                    onClick={() => toggleFolder(node.path)}
                                  >
                                    <i class={`w-4 h-4 transition-transform duration-100 ${
                                      isExpanded() ? "i-hugeicons-arrow-down-01" : "i-hugeicons-arrow-right-01"
                                    }`} />
                                  </button>
                                  <input
                                    type="checkbox"
                                    checked={status() === "all"}
                                    ref={(el) => {
                                      createEffect(() => { el.indeterminate = status() === "some"; });
                                    }}
                                    class="w-4 h-4 accent-blue-600"
                                    onChange={(e) => toggleFolderFiles(node, e.currentTarget.checked)}
                                    onClick={(e) => e.stopPropagation()}
                                  />
                                  <i class={`w-4 h-4 ${isExpanded() ? "i-hugeicons-folder-open text-yellow-400" : "i-hugeicons-folder-01 text-yellow-400"}`} />
                                  <span class="text-sm flex-1 truncate">{node.name}</span>
                                  <span class="text-xs text-dimmer">
                                    {node.children.length} элементов
                                  </span>
                                </div>
                                {/* Children */}
                                <Show when={isExpanded()}>
                                  <For each={node.children}>
                                    {(child) => renderNode(child, depth + 1)}
                                  </For>
                                </Show>
                              </div>
                            );
                          } else {
                            // File node
                            const file = node.file!;
                            const isEnabled = () => overridesEnabled()[file.archive_path];
                            const fileIcon = getCategoryIcon(file.category);
                            const fileColor = getCategoryColor(file.category);
                            const previewable = canPreview(node.name);

                            return (
                              <div
                                class={`flex items-center gap-2 py-1.5 px-3 cursor-pointer transition-colors duration-100 ${
                                  isEnabled()
                                    ? "hover:bg-gray-800/30"
                                    : "opacity-50 hover:opacity-70"
                                }`}
                                style={{ "padding-left": paddingLeft }}
                                onClick={() => toggleOverride(file.archive_path)}
                              >
                                <div class="w-4" /> {/* Spacer for alignment with folders */}
                                <input
                                  type="checkbox"
                                  checked={isEnabled()}
                                  class="w-4 h-4 accent-blue-600"
                                  onChange={() => {}}
                                />
                                <i class={`w-4 h-4 ${fileIcon} ${fileColor}`} />
                                <span class="text-sm flex-1 truncate">{node.name}</span>
                                <Show when={previewable}>
                                  <button
                                    class="p-1 rounded hover:bg-gray-700/50 text-gray-500 hover:text-gray-300 transition-colors"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      loadFilePreview(file);
                                    }}
                                    title="Предпросмотр"
                                  >
                                    <i class="i-hugeicons-view w-3.5 h-3.5" />
                                  </button>
                                </Show>
                                <span class="text-xs text-dimmer">{fmtSize(file.size)}</span>
                              </div>
                            );
                          }
                        };
                        return renderNode(node, 0);
                      }}
                    </For>
                  </div>
                </Show>
              </div>
            </Show>

            {/* Summary */}
            <div class="card bg-gray-alpha-50 flex items-center justify-between">
              <div>
                <p class="text-sm text-muted">Будет импортировано:</p>
                <p class="text-xs text-dimmer">
                  {enabledModsCount()} модов ({fmtSize(selectedModsSize())}) +{" "}
                  {enabledOverridesCount()} файлов ({fmtSize(selectedOverridesSize())})
                </p>
              </div>
              <p class="font-medium">
                Всего: {fmtSize(selectedModsSize() + selectedOverridesSize())}
              </p>
            </div>
          </Show>
        </div>

        {/* Footer */}
        <div class="flex items-center justify-end gap-2 p-4 border-t border-gray-750 flex-shrink-0">
          <button
            class="btn-secondary"
            onClick={props.onClose}
            disabled={props.importing}
          >
            Отмена
          </button>
          <button
            class="btn-primary"
            onClick={handleImport}
            disabled={loading() || !!error() || !instanceName().trim() || props.importing}
          >
            <Show when={props.importing} fallback={
              <>
                <i class="i-hugeicons-download-02 w-4 h-4" />
                Импортировать
              </>
            }>
              <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
              Импорт...
            </Show>
          </button>
        </div>
      </div>

      {/* File Preview Modal */}
      <Show when={previewFile()}>
        <div
          class="fixed inset-0 bg-black/70 backdrop-blur-sm z-[60] flex items-center justify-center p-4"
          onClick={() => setPreviewFile(null)}
        >
          <div
            class="card max-w-4xl w-full max-h-[85vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div class="flex items-center justify-between p-4 border-b border-gray-750 flex-shrink-0">
              <div class="flex items-center gap-3 min-w-0">
                <i class={`w-5 h-5 ${getCategoryIcon(previewFile()!.category)} ${getCategoryColor(previewFile()!.category)}`} />
                <span class="font-medium truncate">{previewFile()!.dest_path}</span>
                <span class="text-xs text-dimmer flex-shrink-0">{fmtSize(previewFile()!.size)}</span>
              </div>
              <button
                class="btn-close"
                onClick={() => setPreviewFile(null)}
                aria-label={t().ui?.tooltips?.close ?? "Close"}
              >
                <i class="i-hugeicons-cancel-01 w-5 h-5" />
              </button>
            </div>

            {/* Content */}
            <div class="flex-1 overflow-hidden min-h-0">
              <Show when={previewLoading()}>
                <div class="flex-center h-full">
                  <i class="i-svg-spinners-6-dots-scale w-8 h-8 text-gray-500" />
                </div>
              </Show>

              <Show when={!previewLoading() && previewContent() === null}>
                <div class="flex-center flex-col gap-2 h-full text-muted">
                  <i class="i-hugeicons-file-01 w-12 h-12 opacity-50" />
                  <p>Не удалось загрузить содержимое файла</p>
                  <p class="text-xs text-dimmer">Файл может быть бинарным или слишком большим</p>
                </div>
              </Show>

              <Show when={!previewLoading() && previewContent() !== null}>
                <div class="h-full overflow-auto">
                  <CodeViewer
                    code={previewContent()!}
                    filename={previewFile()!.dest_path}
                    showLineNumbers
                    showHeader={false}
                    maxHeight="calc(85vh - 8rem)"
                  />
                </div>
              </Show>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
};

export default ModpackImportPreview;
