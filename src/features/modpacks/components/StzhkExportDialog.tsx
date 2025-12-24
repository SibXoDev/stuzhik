import { createSignal, Show, For, createEffect, createMemo } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { Toggle } from "../../../shared/ui";
import { ModalWrapper } from "../../../shared/ui/ModalWrapper";

interface StzhkExportDialogProps {
  instanceId: string;
  instanceName: string;
  onClose: () => void;
}

interface ExportProgress {
  stage: "manifest" | "mods" | "overrides" | "finishing";
  current: number;
  total: number;
  filename: string;
}

interface PreviewProgress {
  stage: "hashing" | "modrinth" | "processing";
  current: number;
  total: number;
  message: string;
}

interface ExportModInfo {
  filename: string;
  name: string;
  version: string | null;
  sha256: string;
  size: number;
  source_type: string;
  will_embed: boolean;
  download_url: string | null;
  modrinth_project_id: string | null;
}

interface ExportOverrideInfo {
  name: string;
  path: string;
  size: number;
  file_count: number;
  is_file: boolean;
}

interface ExportPreview {
  instance_name: string;
  minecraft_version: string;
  loader: string;
  loader_version: string | null;
  mods: ExportModInfo[];
  overrides: ExportOverrideInfo[];
  modrinth_mods_count: number;
  local_mods_count: number;
  embedded_size: number;
  overrides_size: number;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "0 Б";
  const k = 1024;
  const sizes = ["Б", "КБ", "МБ", "ГБ"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

export function StzhkExportDialog(props: StzhkExportDialogProps) {
  // Load saved metadata from localStorage
  const savedMetadata = localStorage.getItem(`modpack-export-${props.instanceId}`);
  const initialMetadata = savedMetadata ? JSON.parse(savedMetadata) : {};

  const [modpackName, setModpackName] = createSignal(initialMetadata.name || props.instanceName);
  const [modpackVersion, setModpackVersion] = createSignal(initialMetadata.version || "1.0.0");
  const [modpackAuthor, setModpackAuthor] = createSignal(initialMetadata.author || "");
  const [modpackDescription, setModpackDescription] = createSignal(initialMetadata.description || "");

  const [embedMods, setEmbedMods] = createSignal(false);
  const [includeOverrides, setIncludeOverrides] = createSignal(true);
  const [exporting, setExporting] = createSignal(false);
  const [progress, setProgress] = createSignal<ExportProgress | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [success, setSuccess] = createSignal<string | null>(null);

  // Preview state
  const [preview, setPreview] = createSignal<ExportPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = createSignal(false);
  const [showPreview, setShowPreview] = createSignal(false);
  const [previewProgress, setPreviewProgress] = createSignal<PreviewProgress | null>(null);

  // Filter state
  type SourceFilter = "all" | "modrinth" | "local";
  const [sourceFilter, setSourceFilter] = createSignal<SourceFilter>("all");

  // Individual selection
  const [excludedMods, setExcludedMods] = createSignal<Set<string>>(new Set());
  const [excludedOverrides, setExcludedOverrides] = createSignal<Set<string>>(new Set());

  // Filtered mods based on source type
  const filteredMods = createMemo(() => {
    const p = preview();
    if (!p) return [];
    const filter = sourceFilter();
    if (filter === "all") return p.mods;
    return p.mods.filter(mod => mod.source_type === filter);
  });

  // Toggle mod exclusion
  function toggleModExclusion(filename: string) {
    const excluded = new Set(excludedMods());
    if (excluded.has(filename)) {
      excluded.delete(filename);
    } else {
      excluded.add(filename);
    }
    setExcludedMods(excluded);
  }

  // Toggle override exclusion
  function toggleOverrideExclusion(path: string) {
    const excluded = new Set(excludedOverrides());
    if (excluded.has(path)) {
      excluded.delete(path);
    } else {
      excluded.add(path);
    }
    setExcludedOverrides(excluded);
  }

  // Select/deselect all mods
  function selectAllMods() {
    setExcludedMods(new Set<string>());
  }

  function deselectAllMods() {
    const p = preview();
    if (!p) return;
    setExcludedMods(new Set(p.mods.map(m => m.filename)));
  }

  // Load preview when options change
  async function loadPreview() {
    setLoadingPreview(true);
    setError(null);
    setPreviewProgress(null);
    setExcludedMods(new Set<string>()); // Reset exclusions
    setExcludedOverrides(new Set<string>());

    // Listen to progress events
    const unlisten = await listen<PreviewProgress>("stzhk-preview-progress", (event) => {
      setPreviewProgress(event.payload);
    });

    try {
      const result = await invoke<ExportPreview>("preview_stzhk_export", {
        instanceId: props.instanceId,
        embedMods: embedMods(),
        includeOverrides: includeOverrides(),
      });
      setPreview(result);
    } catch (e) {
      setError(String(e));
    } finally {
      unlisten();
      setLoadingPreview(false);
      setPreviewProgress(null);
    }
  }

  // Auto-load preview when dialog opens or options change
  createEffect(() => {
    // Track reactive dependencies
    void embedMods();
    void includeOverrides();
    loadPreview();
  });

  // Save metadata to localStorage when it changes
  createEffect(() => {
    const metadata = {
      name: modpackName(),
      version: modpackVersion(),
      author: modpackAuthor(),
      description: modpackDescription(),
    };
    localStorage.setItem(`modpack-export-${props.instanceId}`, JSON.stringify(metadata));
  });

  async function handleExport() {
    setError(null);
    setSuccess(null);

    const sanitizedName = modpackName().replace(/\s+/g, "_");
    const outputPath = await save({
      defaultPath: `${sanitizedName}_v${modpackVersion()}.stzhk`,
      filters: [{ name: "STZHK Modpack", extensions: ["stzhk"] }],
    });

    if (!outputPath) return;

    // Get directory from full path
    const outputDir = outputPath.replace(/[/\\][^/\\]+$/, "");

    setExporting(true);
    setProgress(null);

    const unlisten = await listen<ExportProgress>("stzhk-export-progress", (event) => {
      setProgress(event.payload);
    });

    try {
      const resultPath = await invoke<string>("export_stzhk", {
        instanceId: props.instanceId,
        outputPath: outputDir,
        embedMods: embedMods(),
        includeOverrides: includeOverrides(),
      });
      setSuccess(resultPath);
    } catch (e) {
      setError(String(e));
    } finally {
      unlisten();
      setExporting(false);
      setProgress(null);
    }
  }

  return (
    <ModalWrapper maxWidth="max-w-3xl" backdrop>
      <div class="max-h-[90vh] overflow-hidden flex flex-col p-4">
        {/* Header */}
        <div class="flex items-center justify-between mb-6 flex-shrink-0">
          <div>
            <h2 class="text-xl font-bold">Экспорт в STZHK</h2>
            <p class="text-sm text-muted mt-1">Создание модпака из {props.instanceName}</p>
          </div>
          <button
            class="btn-close"
            onClick={props.onClose}
            disabled={exporting()}
          >
            <i class="i-hugeicons-cancel-01 w-5 h-5" />
          </button>
        </div>

        <Show when={error()}>
          <div class="bg-red-500/10 border border-red-500/30 rounded-2xl p-3 mb-4 flex-shrink-0">
            <p class="text-red-400 text-sm">{error()}</p>
          </div>
        </Show>

        <Show when={success()}>
          <div class="bg-green-500/10 border border-green-500/30 rounded-2xl p-4 mb-4 flex-shrink-0">
            <div class="flex items-start gap-3">
              <i class="i-hugeicons-checkmark-circle-02 w-5 h-5 text-green-400 flex-shrink-0 mt-0.5" />
              <div>
                <p class="text-green-400 font-medium">Экспорт завершён</p>
                <p class="text-sm text-muted mt-1 break-all">{success()}</p>
              </div>
            </div>
          </div>
        </Show>

        <Show when={!success()}>
          {/* Modpack Metadata Card */}
          <div class="bg-gradient-to-br from-gray-800/50 to-gray-750/50 rounded-xl p-4 mb-4 border border-gray-700 flex-shrink-0">
            <h3 class="text-sm font-semibold mb-3 flex items-center gap-2">
              <i class="i-hugeicons-package w-4 h-4 text-blue-400" />
              Информация о модпаке
            </h3>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="block text-xs text-muted mb-1.5">Название</label>
                <input
                  type="text"
                  value={modpackName()}
                  onInput={(e) => setModpackName(e.currentTarget.value)}
                  placeholder="Название модпака"
                  disabled={exporting()}
                  class="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm focus:outline-none focus:border-blue-500 transition-colors disabled:opacity-50"
                />
              </div>
              <div>
                <label class="block text-xs text-muted mb-1.5">Версия</label>
                <input
                  type="text"
                  value={modpackVersion()}
                  onInput={(e) => setModpackVersion(e.currentTarget.value)}
                  placeholder="1.0.0"
                  disabled={exporting()}
                  class="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm focus:outline-none focus:border-blue-500 transition-colors disabled:opacity-50"
                />
              </div>
              <div class="col-span-2">
                <label class="block text-xs text-muted mb-1.5">Автор</label>
                <input
                  type="text"
                  value={modpackAuthor()}
                  onInput={(e) => setModpackAuthor(e.currentTarget.value)}
                  placeholder="Ваше имя или ник"
                  disabled={exporting()}
                  class="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm focus:outline-none focus:border-blue-500 transition-colors disabled:opacity-50"
                />
              </div>
              <div class="col-span-2">
                <label class="block text-xs text-muted mb-1.5">Описание</label>
                <textarea
                  value={modpackDescription()}
                  onInput={(e) => setModpackDescription(e.currentTarget.value)}
                  placeholder="Краткое описание модпака (опционально)"
                  disabled={exporting()}
                  rows={2}
                  class="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm focus:outline-none focus:border-blue-500 transition-colors disabled:opacity-50 resize-none"
                />
              </div>
            </div>
          </div>

          {/* Options */}
          <div class="space-y-4 mb-4 flex-shrink-0">
            {/* Embed mods option */}
            <div class="flex items-start gap-3">
              <Toggle
                checked={embedMods()}
                onChange={setEmbedMods}
                disabled={exporting()}
              />
              <div class="flex-1">
                <span class="font-medium">
                  Встроить моды в архив
                </span>
                <p class="text-sm text-muted mt-0.5">
                  Моды будут включены в файл. Иначе будут добавлены ссылки на Modrinth
                </p>
              </div>
            </div>

            {/* Include overrides option */}
            <div class="flex items-start gap-3">
              <Toggle
                checked={includeOverrides()}
                onChange={setIncludeOverrides}
                disabled={exporting()}
              />
              <div class="flex-1">
                <span class="font-medium">
                  Включить конфиги и ресурсы
                </span>
                <p class="text-sm text-muted mt-0.5">
                  Добавить папки config, resourcepacks, shaderpacks
                </p>
              </div>
            </div>
          </div>

          {/* Preview toggle */}
          <button
            class="flex items-center gap-2 text-sm text-blue-400 hover:text-blue-300 mb-4 flex-shrink-0"
            onClick={() => setShowPreview(!showPreview())}
            disabled={loadingPreview()}
          >
            <i class={`w-4 h-4 ${showPreview() ? "i-hugeicons-arrow-down-01" : "i-hugeicons-arrow-right-01"}`} />
            <Show when={loadingPreview()} fallback="Предпросмотр файлов">
              <Show when={previewProgress()} fallback="Загрузка предпросмотра...">
                {previewProgress()!.message} ({previewProgress()!.current}/{previewProgress()!.total})
              </Show>
            </Show>
          </button>

          {/* Loading progress bar */}
          <Show when={loadingPreview() && previewProgress()}>
            <div class="mb-4 flex-shrink-0">
              <div class="h-1.5 bg-gray-700 rounded-full overflow-hidden">
                <div
                  class="h-full bg-blue-500 transition-all duration-150"
                  style={{
                    width: `${previewProgress()!.total > 0
                      ? (previewProgress()!.current / previewProgress()!.total) * 100
                      : 0}%`
                  }}
                />
              </div>
              <div class="flex justify-between items-center mt-1">
                <span class="text-xs text-muted">
                  {previewProgress()!.stage === "hashing" && "Вычисление хешей..."}
                  {previewProgress()!.stage === "modrinth" && "Поиск на Modrinth..."}
                  {previewProgress()!.stage === "processing" && "Обработка результатов..."}
                </span>
                <span class="text-xs text-gray-500">
                  {previewProgress()!.current}/{previewProgress()!.total}
                </span>
              </div>
            </div>
          </Show>

          {/* Preview content */}
          <Show when={showPreview() && preview()}>
            <div class="overflow-y-auto flex-1 min-h-0 mb-4">
              {/* Summary */}
              <div class="grid grid-cols-2 gap-3 mb-4">
                <div class="bg-gray-800/50 rounded-xl p-3">
                  <div class="text-sm text-muted">Моды</div>
                  <div class="text-lg font-semibold">{preview()!.mods.length}</div>
                  <Show when={!embedMods()}>
                    <div class="text-xs text-muted mt-1">
                      <span class="text-green-400">{preview()!.modrinth_mods_count}</span> с Modrinth,
                      <span class="text-yellow-400 ml-1">{preview()!.local_mods_count}</span> локальных
                    </div>
                  </Show>
                </div>
                <div class="bg-gray-800/50 rounded-xl p-3">
                  <div class="text-sm text-muted">Размер архива</div>
                  <div class="text-lg font-semibold">
                    {formatSize(preview()!.embedded_size + preview()!.overrides_size)}
                  </div>
                </div>
              </div>

              {/* Warning for local mods when not embedding */}
              <Show when={!embedMods() && preview()!.local_mods_count > 0}>
                <div class="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-3 mb-4 flex items-start gap-3">
                  <i class="i-hugeicons-alert-02 w-5 h-5 text-yellow-400 flex-shrink-0 mt-0.5" />
                  <div class="text-sm">
                    <p class="text-yellow-400 font-medium">Локальные моды будут встроены</p>
                    <p class="text-muted mt-1">
                      {preview()!.local_mods_count} модов не найдены на Modrinth и будут встроены в архив
                    </p>
                  </div>
                </div>
              </Show>

              {/* Mods list */}
              <div class="mb-4">
                {/* Selection controls */}
                <div class="flex items-center justify-between mb-2">
                  <div class="flex items-center gap-2">
                    <h3 class="text-sm font-medium text-muted">
                      Моды ({preview()!.mods.length - excludedMods().size} / {preview()!.mods.length})
                    </h3>
                    <button
                      class="text-xs px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600 transition-colors"
                      onClick={selectAllMods}
                    >
                      Выбрать всё
                    </button>
                    <button
                      class="text-xs px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600 transition-colors"
                      onClick={deselectAllMods}
                    >
                      Снять всё
                    </button>
                  </div>
                  <div class="flex gap-1">
                    <button
                      class={`text-xs px-2 py-1 rounded-lg transition-colors ${
                        sourceFilter() === "all"
                          ? "bg-blue-500/20 text-blue-400"
                          : "text-gray-400 hover:text-gray-200 hover:bg-gray-700/50"
                      }`}
                      onClick={() => setSourceFilter("all")}
                    >
                      Все
                    </button>
                    <button
                      class={`text-xs px-2 py-1 rounded-lg transition-colors flex items-center gap-1 ${
                        sourceFilter() === "modrinth"
                          ? "bg-green-500/20 text-green-400"
                          : "text-gray-400 hover:text-gray-200 hover:bg-gray-700/50"
                      }`}
                      onClick={() => setSourceFilter("modrinth")}
                    >
                      <span class="w-1.5 h-1.5 rounded-full bg-green-500" />
                      Modrinth ({preview()!.modrinth_mods_count})
                    </button>
                    <button
                      class={`text-xs px-2 py-1 rounded-lg transition-colors flex items-center gap-1 ${
                        sourceFilter() === "local"
                          ? "bg-yellow-500/20 text-yellow-400"
                          : "text-gray-400 hover:text-gray-200 hover:bg-gray-700/50"
                      }`}
                      onClick={() => setSourceFilter("local")}
                    >
                      <span class="w-1.5 h-1.5 rounded-full bg-yellow-500" />
                      Локальные ({preview()!.local_mods_count})
                    </button>
                  </div>
                </div>
                <div class="space-y-1 max-h-48 overflow-y-auto">
                  <Show when={filteredMods().length > 0} fallback={
                    <div class="text-center py-4 text-gray-500 text-sm">
                      Нет модов с выбранным источником
                    </div>
                  }>
                    <For each={filteredMods()}>
                      {(mod) => (
                        <div class={`flex items-center gap-3 rounded-lg px-3 py-2 ${
                          excludedMods().has(mod.filename) ? "bg-gray-800/10 opacity-50" : "bg-gray-800/30"
                        }`}>
                          {/* Checkbox */}
                          <input
                            type="checkbox"
                            checked={!excludedMods().has(mod.filename)}
                            onChange={() => toggleModExclusion(mod.filename)}
                            class="w-4 h-4 rounded cursor-pointer"
                          />

                          {/* Source indicator */}
                          <div class={`w-2 h-2 rounded-full flex-shrink-0 ${
                            mod.source_type === "modrinth" ? "bg-green-500" :
                            mod.source_type === "local" ? "bg-yellow-500" :
                            "bg-blue-500"
                          }`} />

                          {/* Mod info */}
                          <div class="flex-1 min-w-0">
                            <div class="flex items-center gap-2">
                              <span class="font-medium truncate">{mod.name}</span>
                              <Show when={mod.will_embed}>
                                <span class="text-xs bg-gray-700 px-1.5 py-0.5 rounded">встроен</span>
                              </Show>
                            </div>
                            <div class="text-xs text-muted truncate">{mod.filename}</div>
                          </div>

                          {/* Size */}
                          <div class="text-xs text-muted flex-shrink-0">{formatSize(mod.size)}</div>

                          {/* Source badge */}
                          <div class={`text-xs px-2 py-0.5 rounded flex-shrink-0 ${
                            mod.source_type === "modrinth" ? "bg-green-500/20 text-green-400" :
                            mod.source_type === "local" ? "bg-yellow-500/20 text-yellow-400" :
                            "bg-blue-500/20 text-blue-400"
                          }`}>
                            {mod.source_type === "modrinth" ? "Modrinth" :
                             mod.source_type === "local" ? "Локальный" :
                             "Встроен"}
                          </div>
                        </div>
                      )}
                    </For>
                  </Show>
                </div>
              </div>

              {/* Overrides list */}
              <Show when={includeOverrides() && preview()!.overrides.length > 0}>
                <div>
                  <div class="flex items-center justify-between mb-2">
                    <h3 class="text-sm font-medium text-muted">
                      Конфиги и ресурсы ({preview()!.overrides.length - excludedOverrides().size} / {preview()!.overrides.length})
                    </h3>
                    <div class="flex gap-2">
                      <button
                        class="text-xs px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600 transition-colors"
                        onClick={() => setExcludedOverrides(new Set<string>())}
                      >
                        Выбрать всё
                      </button>
                      <button
                        class="text-xs px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600 transition-colors"
                        onClick={() => setExcludedOverrides(new Set(preview()!.overrides.map(o => o.path)))}
                      >
                        Снять всё
                      </button>
                    </div>
                  </div>
                  <div class="space-y-1 max-h-32 overflow-y-auto">
                    <For each={preview()!.overrides}>
                      {(override) => (
                        <div class={`flex items-center gap-3 rounded-lg px-3 py-2 ${
                          excludedOverrides().has(override.path) ? "bg-gray-800/10 opacity-50" : "bg-gray-800/30"
                        }`}>
                          <input
                            type="checkbox"
                            checked={!excludedOverrides().has(override.path)}
                            onChange={() => toggleOverrideExclusion(override.path)}
                            class="w-4 h-4 rounded cursor-pointer"
                          />
                          <i class={`w-4 h-4 text-muted ${override.is_file ? "i-hugeicons-file-01" : "i-hugeicons-folder-01"}`} />
                          <span class="flex-1 font-medium truncate">{override.name}</span>
                          <Show when={!override.is_file}>
                            <span class="text-xs text-muted">{override.file_count} файлов</span>
                          </Show>
                          <span class="text-xs text-muted">{formatSize(override.size)}</span>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              </Show>
            </div>
          </Show>

          {/* Progress */}
          <Show when={exporting() && progress()}>
            <div class="mb-4 flex-shrink-0">
              <div class="flex justify-between text-sm mb-2">
                <span class="text-muted">
                  {progress()!.stage === "manifest" && "Создание манифеста..."}
                  {progress()!.stage === "mods" && "Встраивание модов..."}
                  {progress()!.stage === "overrides" && "Добавление overrides..."}
                  {progress()!.stage === "finishing" && "Завершение..."}
                </span>
                <span class="text-white">{progress()!.current}/{progress()!.total}</span>
              </div>
              <div class="h-2 bg-gray-700 rounded-full overflow-hidden">
                <div
                  class="h-full bg-blue-500 transition-all duration-150"
                  style={{ width: `${(progress()!.current / progress()!.total) * 100}%` }}
                />
              </div>
              <Show when={progress()!.filename}>
                <p class="text-xs text-dim mt-1.5 truncate">{progress()!.filename}</p>
              </Show>
            </div>
          </Show>
        </Show>

        {/* Warning about exclusions */}
        <Show when={!success() && (excludedMods().size > 0 || excludedOverrides().size > 0)}>
          <div class="bg-blue-500/10 border border-blue-500/30 rounded-xl p-3 flex items-start gap-3 flex-shrink-0">
            <i class="i-hugeicons-information-circle w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5" />
            <div class="text-sm">
              <p class="text-blue-400 font-medium">Примечание о фильтрах</p>
              <p class="text-muted mt-1">
                Чекбоксы помогают планировать экспорт. Backend поддержка исключения конкретных файлов будет добавлена в следующем обновлении.
                {excludedMods().size > 0 && ` Выбрано модов: ${preview()!.mods.length - excludedMods().size}/${preview()!.mods.length}`}
                {excludedOverrides().size > 0 && ` Выбрано файлов: ${preview()!.overrides.length - excludedOverrides().size}/${preview()!.overrides.length}`}
              </p>
            </div>
          </div>
        </Show>

        {/* Actions */}
        <div class="flex justify-end gap-2 flex-shrink-0 pt-4 border-t border-gray-750">
          <button
            class="btn-ghost"
            onClick={props.onClose}
            disabled={exporting()}
          >
            {success() ? "Закрыть" : "Отмена"}
          </button>
          <Show when={!success()}>
            <button
              class="btn-primary"
              onClick={handleExport}
              disabled={exporting() || loadingPreview()}
            >
              <Show when={exporting()} fallback={
                <>
                  <i class="i-hugeicons-share-01 w-4 h-4" />
                  Экспортировать
                </>
              }>
                <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                Экспорт...
              </Show>
            </button>
          </Show>
        </div>
      </div>
    </ModalWrapper>
  );
}

export default StzhkExportDialog;
