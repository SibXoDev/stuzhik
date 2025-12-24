import { Show, For, createSignal, createEffect, createMemo } from "solid-js";
import { useConfigEditor } from "../../../shared/hooks";
import { MonacoEditor } from "../../../shared/components";
import { getPresetsForFile } from "../../../shared/data/config-templates";
import type { ConfigFile, ConfigContent, ConfigType } from "../../../shared/types";
import { createConfirmDialog } from "../../../shared/components/ConfirmDialog";
import { addToast } from "../../../shared/components/Toast";
import { QuickPresetsPanel } from "./QuickPresetsPanel";
import { formatRelativeTime, formatFullDateTime } from "../../../shared/utils/date-formatter";

interface ConfigEditorPanelProps {
  instanceId: string;
}

export function ConfigEditorPanel(props: ConfigEditorPanelProps) {
  const configEditor = useConfigEditor(() => props.instanceId);
  const [selectedFile, setSelectedFile] = createSignal<ConfigFile | null>(null);
  const [fileContent, setFileContent] = createSignal<ConfigContent | null>(null);
  const [editedContent, setEditedContent] = createSignal("");
  const [hasChanges, setHasChanges] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [subdirFilter, setSubdirFilter] = createSignal("config");
  const [searchQuery, setSearchQuery] = createSignal("");
  const [groupByMod, setGroupByMod] = createSignal(true);
  const [expandedGroups, setExpandedGroups] = createSignal<Set<string>>(new Set());
  const [useRegex, setUseRegex] = createSignal(false);
  const { confirm, ConfirmDialogComponent } = createConfirmDialog();

  createEffect(() => {
    if (props.instanceId) {
      configEditor.listConfigs(subdirFilter());
    }
  });

  // Auto-expand all groups when configs load
  createEffect(() => {
    if (configEditor.configs().length > 0) {
      setExpandedGroups(new Set(Object.keys(groupedConfigs())));
    }
  });

  const handleSelectFile = async (file: ConfigFile) => {
    // Check for unsaved changes
    if (hasChanges()) {
      const confirmed = await confirm({
        title: "Несохранённые изменения",
        message: "У вас есть несохранённые изменения. Продолжить без сохранения?",
        variant: "warning",
        confirmText: "Продолжить",
        cancelText: "Отмена",
      });

      if (!confirmed) return;
    }

    setSelectedFile(file);
    const content = await configEditor.readConfig(file.path);
    if (content) {
      setFileContent(content);
      setEditedContent(content.content);
      setHasChanges(false);
    }
  };

  const handleContentChange = (newContent: string) => {
    setEditedContent(newContent);
    setHasChanges(newContent !== fileContent()?.content);
  };

  const handleSave = async () => {
    const file = selectedFile();
    if (!file) return;

    setSaving(true);
    try {
      const success = await configEditor.writeConfig(file.path, editedContent());
      if (success) {
        setFileContent({ ...fileContent()!, content: editedContent() });
        setHasChanges(false);
        addToast({
          type: "success",
          title: "Сохранено",
          message: `Файл ${file.name} успешно сохранён`,
          duration: 3000,
        });
      }
    } finally {
      setSaving(false);
    }
  };

  const handleBackup = async () => {
    const file = selectedFile();
    if (!file) return;

    const backupName = await configEditor.backupConfig(file.path);
    if (backupName) {
      addToast({
        type: "success",
        title: "Резервная копия создана",
        message: `Создан файл: ${backupName}`,
        duration: 5000,
      });
    }
  };

  const handleApplyPreset = async (presetContent: string) => {
    const confirmed = await confirm({
      title: "Применить шаблон?",
      message: "Текущее содержимое файла будет заменено шаблоном. Продолжить?",
      variant: "warning",
      confirmText: "Применить",
    });

    if (!confirmed) return;

    setEditedContent(presetContent);
    setHasChanges(true);
  };

  const getLanguage = (type: ConfigType): "toml" | "json" | "properties" | "yaml" | "txt" => {
    return type;
  };

  // Reactive language computation
  const currentLanguage = createMemo(() => {
    return fileContent() ? getLanguage(fileContent()!.config_type) : "txt";
  });

  // Extract mod name from file path (e.g. "config/ae2/ae2-common.toml" -> "ae2")
  const extractModName = (path: string): string => {
    const parts = path.split("/");
    if (subdirFilter() === "config" && parts.length > 2) {
      return parts[1]; // config/modname/file.toml
    }
    return "Root"; // Root configs
  };

  // Filter and group configs
  const filteredConfigs = () => {
    const query = searchQuery();
    if (!query) return configEditor.configs();

    if (useRegex()) {
      try {
        const regex = new RegExp(query, 'i');
        return configEditor.configs().filter(file =>
          regex.test(file.name) || regex.test(file.path)
        );
      } catch (e) {
        // Invalid regex, fall back to text search
        return configEditor.configs().filter(file =>
          file.name.toLowerCase().includes(query.toLowerCase()) ||
          file.path.toLowerCase().includes(query.toLowerCase())
        );
      }
    } else {
      const lowerQuery = query.toLowerCase();
      return configEditor.configs().filter(file =>
        file.name.toLowerCase().includes(lowerQuery) ||
        file.path.toLowerCase().includes(lowerQuery)
      );
    }
  };

  const groupedConfigs = () => {
    const files = filteredConfigs();
    if (!groupByMod()) {
      return { "All": files };
    }

    const groups: Record<string, ConfigFile[]> = {};
    files.forEach(file => {
      const modName = extractModName(file.path);
      if (!groups[modName]) {
        groups[modName] = [];
      }
      groups[modName].push(file);
    });

    return groups;
  };

  const toggleGroup = (groupName: string) => {
    const expanded = new Set(expandedGroups());
    if (expanded.has(groupName)) {
      expanded.delete(groupName);
    } else {
      expanded.add(groupName);
    }
    setExpandedGroups(expanded);
  };

  // Auto-expand groups when search is active or grouping is disabled
  createEffect(() => {
    if (searchQuery() || !groupByMod()) {
      setExpandedGroups(new Set(Object.keys(groupedConfigs())));
    }
  });

  return (
    <div class="flex h-full gap-4">
      {/* Left Sidebar - File List */}
      <div class="w-80 flex flex-col gap-3 flex-shrink-0">
        {/* Subdir Filter */}
        <div class="flex flex-col gap-2">
          <div class="flex gap-2">
            <button
              class={`btn-sm flex-1 ${subdirFilter() === "config" ? "btn-primary" : "btn-secondary"}`}
              onClick={() => setSubdirFilter("config")}
              title="Конфиги модов из папки config/"
            >
              <i class="i-hugeicons-settings-02 w-4 h-4" />
              Config
            </button>
            <button
              class={`btn-sm flex-1 ${subdirFilter() === "." ? "btn-primary" : "btn-secondary"}`}
              onClick={() => setSubdirFilter(".")}
              title="Конфиги из корня экземпляра"
            >
              <i class="i-hugeicons-folder-01 w-4 h-4" />
              Root
            </button>
          </div>
          <p class="text-xs text-muted">
            {subdirFilter() === "config"
              ? "Конфигурационные файлы модов (config/*.toml, *.json)"
              : "Конфиги из корня (options.txt, server.properties)"}
          </p>
        </div>

        {/* Search and Group Controls */}
        <div class="flex flex-col gap-2">
          <div class="flex gap-2">
            <input
              type="text"
              value={searchQuery()}
              onInput={(e) => setSearchQuery(e.currentTarget.value)}
              placeholder={useRegex() ? "Regex поиск..." : "Поиск по файлам..."}
              class="flex-1 text-sm"
            />
            <button
              class={`btn-sm ${useRegex() ? "btn-primary" : "btn-secondary"}`}
              onClick={() => setUseRegex(!useRegex())}
              title={useRegex() ? "Обычный поиск" : "Regex поиск"}
            >
              <i class="i-hugeicons-search-01 w-4 h-4" />
              .*
            </button>
            <button
              class={`btn-sm ${groupByMod() ? "btn-primary" : "btn-secondary"}`}
              onClick={() => setGroupByMod(!groupByMod())}
              title={groupByMod() ? "Отключить группировку" : "Группировать по модам"}
            >
              <i class="i-hugeicons-layers-01 w-4 h-4" />
            </button>
          </div>
          <Show when={searchQuery()}>
            <p class="text-xs text-muted">
              Найдено: {filteredConfigs().length} из {configEditor.configs().length}
            </p>
          </Show>
        </div>

        {/* File List */}
        <div class="card flex-1 overflow-y-auto p-0">
          <Show when={configEditor.loading()}>
            <div class="flex-center p-8">
              <i class="i-svg-spinners-6-dots-scale w-6 h-6" />
            </div>
          </Show>

          <Show when={!configEditor.loading() && filteredConfigs().length === 0}>
            <div class="flex-col-center p-8 text-center">
              <i class="i-hugeicons-file-01 w-12 h-12 text-gray-600 mb-2" />
              <p class="text-muted text-sm">
                {searchQuery() ? "Файлы не найдены" : "Конфиг-файлы не найдены"}
              </p>
            </div>
          </Show>

          <Show when={!configEditor.loading() && filteredConfigs().length > 0}>
            <For each={Object.entries(groupedConfigs())}>
              {([groupName, files]) => (
                <div>
                  {/* Group Header (only if grouping enabled and multiple groups) */}
                  <Show when={groupByMod() && Object.keys(groupedConfigs()).length > 1}>
                    <button
                      class="w-full text-left px-4 py-2 bg-gray-800/50 border-b border-gray-750 hover:bg-gray-800 transition-colors flex items-center gap-2"
                      onClick={() => toggleGroup(groupName)}
                    >
                      <i class={`w-4 h-4 transition-transform ${expandedGroups().has(groupName) ? "i-hugeicons-arrow-down-01" : "i-hugeicons-arrow-right-01"}`} />
                      <span class="font-medium text-sm">{groupName}</span>
                      <span class="text-xs text-muted ml-auto">{files.length}</span>
                    </button>
                  </Show>

                  {/* Files in group */}
                  <Show when={!groupByMod() || expandedGroups().has(groupName)}>
                    <For each={files}>
                      {(file) => (
                        <button
                          class={`w-full text-left px-4 py-3 border-b border-gray-800 hover:bg-gray-800/50 transition-colors ${
                            selectedFile()?.path === file.path ? "bg-blue-600/20 border-l-4 border-l-blue-600" : ""
                          }`}
                          onClick={() => handleSelectFile(file)}
                        >
                          <div class="flex items-center gap-2">
                            <i class="i-hugeicons-file-01 w-4 h-4 text-gray-500" />
                            <div class="flex-1 min-w-0">
                              <div class="font-medium truncate">{file.name}</div>
                              <div class="text-xs text-muted">
                                {(file.size / 1024).toFixed(1)} KB • <span title={formatFullDateTime(file.modified)}>{formatRelativeTime(file.modified)}</span>
                              </div>
                            </div>
                            <Show when={getPresetsForFile(file.name).length > 0}>
                              <i class="i-hugeicons-sparkles w-4 h-4 text-blue-400" title="Есть быстрые шаблоны" />
                            </Show>
                          </div>
                        </button>
                      )}
                    </For>
                  </Show>
                </div>
              )}
            </For>
          </Show>
        </div>
      </div>

      {/* Right Panel - Editor */}
      <div class="flex-1 flex flex-col gap-3 min-w-0">
        <Show when={!selectedFile()}>
          <div class="card flex-1 flex-col-center text-center">
            <i class="i-hugeicons-file-search w-16 h-16 text-gray-600 mb-4" />
            <h3 class="text-lg font-semibold mb-2">Выберите файл для редактирования</h3>
            <p class="text-muted text-sm">
              Конфигурационные файлы позволяют настроить поведение модов
            </p>
          </div>
        </Show>

        <Show when={selectedFile()}>
          {/* Header */}
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3">
              <i class="i-hugeicons-file-01 w-5 h-5 text-gray-500" />
              <div>
                <h3 class="font-semibold">{selectedFile()!.name}</h3>
                <p class="text-xs text-muted">{selectedFile()!.path}</p>
              </div>
              <Show when={hasChanges()}>
                <span class="px-2 py-0.5 text-xs rounded bg-orange-600/20 text-orange-400 border border-orange-600/30">
                  Изменён
                </span>
              </Show>
            </div>

            <div class="flex gap-2">
              <button
                class="btn-secondary btn-sm"
                onClick={handleBackup}
                title="Создать резервную копию"
              >
                <i class="i-hugeicons-folder-cloud w-4 h-4" />
                Backup
              </button>

              <button
                class="btn-primary btn-sm"
                onClick={handleSave}
                disabled={!hasChanges() || saving()}
              >
                <Show when={saving()} fallback={
                  <>
                    <i class="i-hugeicons-floppy-disk w-4 h-4" />
                    Сохранить
                  </>
                }>
                  <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                  Сохранение...
                </Show>
              </button>
            </div>
          </div>

          {/* Quick Presets Panel */}
          <QuickPresetsPanel
            fileName={selectedFile()!.name}
            onApplyPreset={(content) => handleApplyPreset(content)}
            onBackup={handleBackup}
          />

          {/* Monaco Editor */}
          <Show when={fileContent()}>
            <div class="flex-1 min-h-0">
              <MonacoEditor
                value={editedContent()}
                onChange={handleContentChange}
                onSave={handleSave}
                language={currentLanguage()}
                fileName={selectedFile()?.path || selectedFile()?.name}
              />
            </div>
          </Show>
        </Show>
      </div>

      <ConfirmDialogComponent />
    </div>
  );
}
