import { createSignal, Show, For, createEffect, createMemo, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Toggle, Select } from "../../../shared/ui";
import { ModalWrapper } from "../../../shared/ui/ModalWrapper";
import { useI18n } from "../../../shared/i18n";
import { formatSize } from "../../../shared/utils/format-size";

type ExportFormat = "stzhk" | "mrpack" | "universalZip";
type ReadmeLanguage = "ru" | "en" | "both";

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

type OverrideCategory = "config" | "scripts" | "resources" | "generated" | "game_settings" | "other";

interface ExportOverrideInfo {
  name: string;
  path: string;
  size: number;
  file_count: number;
  is_file: boolean;
  category: OverrideCategory;
  hint: string | null;
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

export function StzhkExportDialog(props: StzhkExportDialogProps) {
  const { t } = useI18n();

  // Memoized size formatter with localized units
  const fmtSize = (bytes: number) => formatSize(bytes, t().ui?.units);

  // Load saved metadata from localStorage with error handling
  const savedMetadata = localStorage.getItem(`modpack-export-${props.instanceId}`);
  let initialMetadata: Record<string, string> = {};
  if (savedMetadata) {
    try {
      initialMetadata = JSON.parse(savedMetadata);
    } catch {
      // Ignore corrupted data
      localStorage.removeItem(`modpack-export-${props.instanceId}`);
    }
  }

  // Track active listeners for cleanup
  let previewUnlisten: UnlistenFn | null = null;
  let exportUnlisten: UnlistenFn | null = null;

  onCleanup(() => {
    if (previewUnlisten) previewUnlisten();
    if (exportUnlisten) exportUnlisten();
  });

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

  // Export format
  const [exportFormat, setExportFormat] = createSignal<ExportFormat>("stzhk");
  const [readmeLanguage, setReadmeLanguage] = createSignal<ReadmeLanguage>("ru");
  const [includeReadme, setIncludeReadme] = createSignal(true);

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

    // Clean up previous listener if any
    if (previewUnlisten) {
      previewUnlisten();
      previewUnlisten = null;
    }

    // Listen to progress events
    previewUnlisten = await listen<PreviewProgress>("stzhk-preview-progress", (event) => {
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
      if (previewUnlisten) {
        previewUnlisten();
        previewUnlisten = null;
      }
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

  // Get file extension and filter name based on format
  const getExportConfig = () => {
    switch (exportFormat()) {
      case "stzhk":
        return { ext: "stzhk", filter: "STZHK Modpack", extensions: ["stzhk"] };
      case "mrpack":
        return { ext: "mrpack", filter: "Modrinth Modpack", extensions: ["mrpack"] };
      case "universalZip":
        return { ext: "zip", filter: "ZIP Archive", extensions: ["zip"] };
    }
  };

  async function handleExport() {
    setError(null);
    setSuccess(null);

    const sanitizedName = modpackName().replace(/\s+/g, "_");
    const config = getExportConfig();
    const outputPath = await save({
      defaultPath: `${sanitizedName}_v${modpackVersion()}.${config.ext}`,
      filters: [{ name: config.filter, extensions: config.extensions }],
    });

    if (!outputPath) return;

    // Get directory from full path
    const outputDir = outputPath.replace(/[/\\][^/\\]+$/, "");

    setExporting(true);
    setProgress(null);

    // Clean up previous listener if any
    if (exportUnlisten) {
      exportUnlisten();
      exportUnlisten = null;
    }

    const progressEvent = exportFormat() === "universalZip"
      ? "universal-zip-export-progress"
      : "stzhk-export-progress";

    exportUnlisten = await listen<ExportProgress>(progressEvent, (event) => {
      setProgress(event.payload);
    });

    try {
      let resultPath: string;

      if (exportFormat() === "universalZip") {
        // Universal ZIP export for friends without launcher
        resultPath = await invoke<string>("export_universal_zip", {
          instanceId: props.instanceId,
          outputPath: outputDir,
          options: {
            name: modpackName(),
            version: modpackVersion(),
            author: modpackAuthor(),
            description: modpackDescription() || null,
            include_readme: includeReadme(),
            readme_language: readmeLanguage(),
            excluded_mods: Array.from(excludedMods()),
            excluded_overrides: Array.from(excludedOverrides()),
          },
        });
      } else if (exportFormat() === "mrpack") {
        // Modrinth .mrpack export
        resultPath = await invoke<string>("export_mrpack", {
          instanceId: props.instanceId,
          outputPath: outputDir,
          options: {
            name: modpackName(),
            version: modpackVersion(),
            summary: modpackDescription() || null,
            include_overrides: true,
            excluded_mods: Array.from(excludedMods()),
            excluded_overrides: Array.from(excludedOverrides()),
          },
        });
      } else {
        // STZHK export
        resultPath = await invoke<string>("export_stzhk", {
          instanceId: props.instanceId,
          outputPath: outputDir,
          options: {
            name: modpackName(),
            version: modpackVersion(),
            author: modpackAuthor(),
            description: modpackDescription() || null,
            embedMods: embedMods(),
            includeOverrides: includeOverrides(),
            excludedMods: Array.from(excludedMods()),
            excludedOverrides: Array.from(excludedOverrides()),
          },
        });
      }
      setSuccess(resultPath);
    } catch (e) {
      setError(String(e));
    } finally {
      if (exportUnlisten) {
        exportUnlisten();
        exportUnlisten = null;
      }
      setExporting(false);
      setProgress(null);
    }
  }

  // Dynamic title based on format
  const exportTitle = () => {
    switch (exportFormat()) {
      case "universalZip":
        return t().modpacks.export.universalZip?.title ?? "Export for Friends";
      case "mrpack":
        return t().modpacks.export.mrpack?.title ?? "Export to Modrinth";
      default:
        return t().modpacks.export.title;
    }
  };

  const exportSubtitle = () => {
    switch (exportFormat()) {
      case "universalZip":
        return t().modpacks.export.universalZip?.subtitle ?? "Creating archive from";
      default:
        return t().modpacks.export.subtitle;
    }
  };

  return (
    <ModalWrapper maxWidth="max-w-3xl" backdrop>
      <div class="max-h-[90vh] overflow-hidden flex flex-col p-4">
        {/* Header */}
        <div class="flex items-center justify-between mb-4 flex-shrink-0">
          <div class="flex flex-col gap-1">
            <h2 class="text-xl font-bold">{exportTitle()}</h2>
            <p class="text-sm text-muted">{exportSubtitle()} {props.instanceName}</p>
          </div>
          <button
            class="btn-close"
            onClick={props.onClose}
            disabled={exporting()}
            aria-label={t().ui?.tooltips?.close ?? "Close"}
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
                <p class="text-green-400 font-medium">{t().modpacks.export.success}</p>
                <p class="text-sm text-muted mt-1 break-all">{success()}</p>
              </div>
            </div>
          </div>
        </Show>

        <Show when={!success()}>
          {/* Format Selection */}
          <div class="flex gap-2 mb-4 flex-shrink-0">
            <button
              class={`flex-1 px-3 py-2.5 rounded-xl border transition-all ${
                exportFormat() === "stzhk"
                  ? "bg-[var(--color-primary-bg)] border-[var(--color-primary)] text-[var(--color-primary)]"
                  : "bg-gray-800/50 border-gray-700 hover:border-gray-600 text-gray-300"
              }`}
              onClick={() => setExportFormat("stzhk")}
              disabled={exporting()}
            >
              <div class="flex items-center justify-center gap-2">
                <i class="i-hugeicons-package w-4 h-4" />
                <span class="font-medium">{t().modpacks.export.format?.stzhk?.name ?? "STZHK"}</span>
              </div>
              <p class="text-[10px] text-muted mt-1">{t().modpacks.export.format?.stzhk?.hint ?? "For Stuzhik"}</p>
            </button>
            <button
              class={`flex-1 px-3 py-2.5 rounded-xl border transition-all ${
                exportFormat() === "mrpack"
                  ? "bg-green-500/20 border-green-500 text-green-400"
                  : "bg-gray-800/50 border-gray-700 hover:border-gray-600 text-gray-300"
              }`}
              onClick={() => setExportFormat("mrpack")}
              disabled={exporting()}
            >
              <div class="flex items-center justify-center gap-2">
                <i class="i-hugeicons-upload-02 w-4 h-4" />
                <span class="font-medium">{t().modpacks.export.format?.mrpack?.name ?? "Modrinth"}</span>
              </div>
              <p class="text-[10px] text-muted mt-1">{t().modpacks.export.format?.mrpack?.hint ?? "For Prism, MultiMC"}</p>
            </button>
            <button
              class={`flex-1 px-3 py-2.5 rounded-xl border transition-all ${
                exportFormat() === "universalZip"
                  ? "bg-amber-500/20 border-amber-500 text-amber-400"
                  : "bg-gray-800/50 border-gray-700 hover:border-gray-600 text-gray-300"
              }`}
              onClick={() => setExportFormat("universalZip")}
              disabled={exporting()}
            >
              <div class="flex items-center justify-center gap-2">
                <i class="i-hugeicons-user-multiple w-4 h-4" />
                <span class="font-medium">{t().modpacks.export.format?.universalZip?.name ?? "Universal ZIP"}</span>
              </div>
              <p class="text-[10px] text-muted mt-1">{t().modpacks.export.format?.universalZip?.hint ?? "For friends"}</p>
            </button>
          </div>

          {/* Warning for Universal ZIP */}
          <Show when={exportFormat() === "universalZip"}>
            <div class="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 mb-4 flex items-start gap-3 flex-shrink-0">
              <i class="i-hugeicons-alert-02 w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
              <div class="text-sm">
                <p class="text-amber-400 font-medium">{t().modpacks.export.universalZip?.warning?.title ?? "Warning: large file size"}</p>
                <p class="text-muted mt-1">{t().modpacks.export.universalZip?.warning?.hint ?? "Archive contains ALL mods and files."}</p>
              </div>
            </div>
          </Show>

          {/* Modpack Metadata Card */}
          <div class="bg-gradient-to-br from-gray-800/50 to-gray-750/50 rounded-xl p-4 mb-4 border border-gray-700 flex-shrink-0">
            <h3 class="text-sm font-semibold mb-3 flex items-center gap-2">
              <i class="i-hugeicons-package w-4 h-4 text-blue-400" />
              {t().modpacks.export.metadata.title}
            </h3>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="block text-xs text-muted mb-1.5">{t().modpacks.export.metadata.name}</label>
                <input
                  type="text"
                  value={modpackName()}
                  onInput={(e) => setModpackName(e.currentTarget.value)}
                  placeholder={t().ui.placeholders.modpackName}
                  disabled={exporting()}
                  class="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm focus:outline-none focus:border-[var(--color-primary)] transition-colors disabled:opacity-50"
                />
              </div>
              <div>
                <label class="block text-xs text-muted mb-1.5">{t().modpacks.export.metadata.version}</label>
                <input
                  type="text"
                  value={modpackVersion()}
                  onInput={(e) => setModpackVersion(e.currentTarget.value)}
                  placeholder={t().ui.placeholders.versionNumber}
                  disabled={exporting()}
                  class="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm focus:outline-none focus:border-[var(--color-primary)] transition-colors disabled:opacity-50"
                />
              </div>
              <div class="col-span-2">
                <label class="block text-xs text-muted mb-1.5">{t().modpacks.export.metadata.author}</label>
                <input
                  type="text"
                  value={modpackAuthor()}
                  onInput={(e) => setModpackAuthor(e.currentTarget.value)}
                  placeholder={t().ui.placeholders.yourNameOrNick}
                  disabled={exporting()}
                  class="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm focus:outline-none focus:border-[var(--color-primary)] transition-colors disabled:opacity-50"
                />
              </div>
              <div class="col-span-2">
                <label class="block text-xs text-muted mb-1.5">{t().modpacks.export.metadata.description}</label>
                <textarea
                  value={modpackDescription()}
                  onInput={(e) => setModpackDescription(e.currentTarget.value)}
                  placeholder={t().ui.placeholders.shortDescription}
                  disabled={exporting()}
                  rows={2}
                  class="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm focus:outline-none focus:border-[var(--color-primary)] transition-colors disabled:opacity-50 resize-none"
                />
              </div>
            </div>
          </div>

          {/* Options - different based on format */}
          <div class="space-y-4 mb-4 flex-shrink-0">
            {/* STZHK options */}
            <Show when={exportFormat() === "stzhk"}>
              {/* Embed mods option */}
              <div class="flex items-start gap-3">
                <Toggle
                  checked={embedMods()}
                  onChange={setEmbedMods}
                  disabled={exporting()}
                />
                <div class="flex-1">
                  <span class="font-medium">
                    {t().modpacks.export.options.embedMods}
                  </span>
                  <p class="text-sm text-muted mt-0.5">
                    {t().modpacks.export.options.embedModsHint}
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
                    {t().modpacks.export.options.includeOverrides}
                  </span>
                  <p class="text-sm text-muted mt-0.5">
                    {t().modpacks.export.options.includeOverridesHint}
                  </p>
                </div>
              </div>
            </Show>

            {/* Universal ZIP options */}
            <Show when={exportFormat() === "universalZip"}>
              {/* README toggle */}
              <div class="flex items-start gap-3">
                <Toggle
                  checked={includeReadme()}
                  onChange={setIncludeReadme}
                  disabled={exporting()}
                />
                <div class="flex-1">
                  <span class="font-medium">
                    {t().modpacks.export.universalZip?.readme?.include ?? "Include README with instructions"}
                  </span>
                  <p class="text-sm text-muted mt-0.5">
                    {t().modpacks.export.universalZip?.readme?.hint ?? "File with step-by-step installation guide"}
                  </p>
                </div>
              </div>

              {/* README language selector */}
              <Show when={includeReadme()}>
                <div class="flex items-center gap-3 pl-12">
                  <label class="text-sm text-muted whitespace-nowrap">
                    {t().modpacks.export.universalZip?.readmeLanguage ?? "README Language"}:
                  </label>
                  <Select
                    value={readmeLanguage()}
                    onChange={(v) => setReadmeLanguage(v as ReadmeLanguage)}
                    options={[
                      { value: "ru", label: t().modpacks.export.universalZip?.readmeLanguages?.ru ?? "Russian" },
                      { value: "en", label: t().modpacks.export.universalZip?.readmeLanguages?.en ?? "English" },
                      { value: "both", label: t().modpacks.export.universalZip?.readmeLanguages?.both ?? "Both languages" },
                    ]}
                    disabled={exporting()}
                  />
                </div>
              </Show>
            </Show>

            {/* MRPACK has no special options - just uses CDN links */}
            <Show when={exportFormat() === "mrpack"}>
              <div class="flex items-start gap-2 text-sm text-muted bg-gray-800/30 rounded-lg p-3">
                <i class="i-hugeicons-information-circle w-4 h-4 flex-shrink-0 mt-0.5 text-blue-400" />
                <span>{t().modpacks.export.mrpack?.info ?? "Modrinth format uses CDN links for mods. Compatible with Prism Launcher, MultiMC, and Modrinth App."}</span>
              </div>
            </Show>
          </div>

          {/* Preview toggle */}
          <button
            class="flex items-center gap-2 text-sm text-blue-400 hover:text-blue-300 mb-4 flex-shrink-0"
            onClick={() => setShowPreview(!showPreview())}
            disabled={loadingPreview()}
          >
            <i class={`w-4 h-4 ${showPreview() ? "i-hugeicons-arrow-down-01" : "i-hugeicons-arrow-right-01"}`} />
            <Show when={loadingPreview()} fallback={t().modpacks.export.preview.toggle}>
              <Show when={previewProgress()} fallback={t().modpacks.export.preview.loading}>
                {previewProgress()!.message} ({previewProgress()!.current}/{previewProgress()!.total})
              </Show>
            </Show>
          </button>

          {/* Loading progress bar */}
          <Show when={loadingPreview() && previewProgress()}>
            <div class="mb-4 flex-shrink-0">
              <div class="h-1.5 bg-gray-700 rounded-full overflow-hidden">
                <div
                  class="h-full bg-[var(--color-primary)] transition-all duration-150"
                  style={{
                    width: `${previewProgress()!.total > 0
                      ? (previewProgress()!.current / previewProgress()!.total) * 100
                      : 0}%`
                  }}
                />
              </div>
              <div class="flex justify-between items-center mt-1">
                <span class="text-xs text-muted">
                  {previewProgress()!.stage === "hashing" && t().modpacks.export.previewProgress.hashing}
                  {previewProgress()!.stage === "modrinth" && t().modpacks.export.previewProgress.modrinth}
                  {previewProgress()!.stage === "processing" && t().modpacks.export.previewProgress.processing}
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
                  <div class="text-sm text-muted">{t().modpacks.export.summary.mods}</div>
                  <div class="text-lg font-semibold">{preview()!.mods.length}</div>
                  <Show when={!embedMods()}>
                    <div class="flex flex-wrap gap-1 text-xs text-muted mt-1">
                      <span><span class="text-green-400">{preview()!.modrinth_mods_count}</span> {t().modpacks.export.summary.fromModrinth},</span>
                      <span><span class="text-yellow-400">{preview()!.local_mods_count}</span> {t().modpacks.export.summary.local}</span>
                    </div>
                  </Show>
                </div>
                <div class="bg-gray-800/50 rounded-xl p-3">
                  <div class="text-sm text-muted">{t().modpacks.export.summary.archiveSize}</div>
                  <div class="text-lg font-semibold">
                    {fmtSize(preview()!.embedded_size + preview()!.overrides_size)}
                  </div>
                </div>
              </div>

              {/* Warning for local mods when not embedding */}
              <Show when={!embedMods() && preview()!.local_mods_count > 0}>
                <div class="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-3 mb-4 flex items-start gap-3">
                  <i class="i-hugeicons-alert-02 w-5 h-5 text-yellow-400 flex-shrink-0 mt-0.5" />
                  <div class="text-sm">
                    <p class="text-yellow-400 font-medium">{t().modpacks.export.warnings.localModsEmbedded}</p>
                    <p class="text-muted mt-1">
                      {preview()!.local_mods_count} {t().modpacks.export.warnings.localModsEmbeddedHint}
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
                      {t().modpacks.export.mods.title} ({preview()!.mods.length - excludedMods().size} / {preview()!.mods.length})
                    </h3>
                    <button
                      class="text-xs px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600 transition-colors"
                      onClick={selectAllMods}
                    >
                      {t().modpacks.export.mods.selectAll}
                    </button>
                    <button
                      class="text-xs px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600 transition-colors"
                      onClick={deselectAllMods}
                    >
                      {t().modpacks.export.mods.deselectAll}
                    </button>
                  </div>
                  <div class="flex gap-1">
                    <button
                      class={`text-xs px-2 py-1 rounded-lg transition-colors ${
                        sourceFilter() === "all"
                          ? "bg-[var(--color-primary-bg)] text-[var(--color-primary)]"
                          : "text-gray-400 hover:text-gray-200 hover:bg-gray-700/50"
                      }`}
                      onClick={() => setSourceFilter("all")}
                    >
                      {t().modpacks.export.mods.all}
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
                      {t().modpacks.export.mods.local} ({preview()!.local_mods_count})
                    </button>
                  </div>
                </div>
                <div class="space-y-1 max-h-48 overflow-y-auto">
                  <Show when={filteredMods().length > 0} fallback={
                    <div class="text-center py-4 text-gray-500 text-sm">
                      {t().modpacks.export.mods.noModsWithFilter}
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
                                <span class="text-xs bg-gray-700 px-1.5 py-0.5 rounded">{t().modpacks.export.mods.embedded}</span>
                              </Show>
                            </div>
                            <div class="text-xs text-muted truncate">{mod.filename}</div>
                          </div>

                          {/* Size */}
                          <div class="text-xs text-muted flex-shrink-0">{fmtSize(mod.size)}</div>

                          {/* Source badge */}
                          <div class={`text-xs px-2 py-0.5 rounded flex-shrink-0 ${
                            mod.source_type === "modrinth" ? "bg-green-500/20 text-green-400" :
                            mod.source_type === "local" ? "bg-yellow-500/20 text-yellow-400" :
                            "bg-blue-500/20 text-blue-400"
                          }`}>
                            {mod.source_type === "modrinth" ? t().modpacks.export.mods.sourceModrinth :
                             mod.source_type === "local" ? t().modpacks.export.mods.sourceLocal :
                             t().modpacks.export.mods.sourceEmbedded}
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
                      {t().modpacks.export.overrides.title} ({preview()!.overrides.length - excludedOverrides().size} / {preview()!.overrides.length})
                    </h3>
                    <div class="flex gap-2">
                      <button
                        class="text-xs px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600 transition-colors"
                        onClick={() => setExcludedOverrides(new Set<string>())}
                      >
                        {t().modpacks.export.mods.selectAll}
                      </button>
                      <button
                        class="text-xs px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600 transition-colors"
                        onClick={() => setExcludedOverrides(new Set(preview()!.overrides.map(o => o.path)))}
                      >
                        {t().modpacks.export.mods.deselectAll}
                      </button>
                    </div>
                  </div>
                  <div class="space-y-1 max-h-48 overflow-y-auto">
                    <For each={preview()!.overrides}>
                      {(override) => {
                        const categoryIcon = () => {
                          switch (override.category) {
                            case "config": return "i-hugeicons-settings-02";
                            case "scripts": return "i-hugeicons-terminal";
                            case "resources": return "i-hugeicons-image-01";
                            case "generated": return "i-hugeicons-refresh";
                            case "game_settings": return "i-hugeicons-menu-02";
                            default: return override.is_file ? "i-hugeicons-file-01" : "i-hugeicons-folder-01";
                          }
                        };
                        const categoryColor = () => {
                          switch (override.category) {
                            case "config": return "text-blue-400";
                            case "scripts": return "text-green-400";
                            case "resources": return "text-purple-400";
                            case "generated": return "text-amber-400";
                            case "game_settings": return "text-cyan-400";
                            default: return "text-muted";
                          }
                        };
                        return (
                          <div class={`flex items-center gap-3 rounded-lg px-3 py-2 ${
                            excludedOverrides().has(override.path) ? "bg-gray-800/10 opacity-50" : "bg-gray-800/30"
                          }`}>
                            <input
                              type="checkbox"
                              checked={!excludedOverrides().has(override.path)}
                              onChange={() => toggleOverrideExclusion(override.path)}
                              class="w-4 h-4 rounded cursor-pointer"
                            />
                            <i class={`w-4 h-4 ${categoryIcon()} ${categoryColor()}`} />
                            <span class="flex-1 font-medium truncate">{override.name}</span>
                            <Show when={override.category === "generated"}>
                              <span class="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400">
                                {t().modpacks.export.overrides.generated}
                              </span>
                            </Show>
                            <Show when={!override.is_file}>
                              <span class="text-xs text-muted">{override.file_count} {t().modpacks.export.overrides.filesCount}</span>
                            </Show>
                            <span class="text-xs text-muted">{fmtSize(override.size)}</span>
                          </div>
                        );
                      }}
                    </For>
                  </div>
                  {/* Hint about generated files */}
                  <Show when={preview()!.overrides.some(o => o.category === "generated" && !excludedOverrides().has(o.path))}>
                    <div class="mt-2 p-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
                      <p class="flex items-center gap-1 text-xs text-amber-400">
                        <i class="i-hugeicons-information-circle w-3 h-3 flex-shrink-0" />
                        <span>{t().modpacks.export.overrides.generatedHint}</span>
                      </p>
                    </div>
                  </Show>
                </div>
              </Show>
            </div>
          </Show>

          {/* Progress */}
          <Show when={exporting() && progress()}>
            <div class="mb-4 flex-shrink-0">
              <div class="flex justify-between text-sm mb-2">
                <span class="text-muted">
                  {progress()!.stage === "manifest" && t().modpacks.export.progress.manifest}
                  {progress()!.stage === "mods" && t().modpacks.export.progress.mods}
                  {progress()!.stage === "overrides" && t().modpacks.export.progress.overrides}
                  {progress()!.stage === "finishing" && t().modpacks.export.progress.finishing}
                </span>
                <span class="text-white">{progress()!.current}/{progress()!.total}</span>
              </div>
              <div class="h-2 bg-gray-700 rounded-full overflow-hidden">
                <div
                  class="h-full bg-[var(--color-primary)] transition-all duration-150"
                  style={{ width: `${progress()!.total > 0 ? (progress()!.current / progress()!.total) * 100 : 0}%` }}
                />
              </div>
              <Show when={progress()!.filename}>
                <p class="text-xs text-dim mt-1.5 truncate">{progress()!.filename}</p>
              </Show>
            </div>
          </Show>
        </Show>

        {/* Info about exclusions */}
        <Show when={!success() && (excludedMods().size > 0 || excludedOverrides().size > 0)}>
          <div class="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 flex items-start gap-3 flex-shrink-0">
            <i class="i-hugeicons-filter w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
            <div class="text-sm">
              <p class="text-amber-400 font-medium">{t().modpacks.export.exclusions.title}</p>
              <p class="text-muted mt-1">
                {excludedMods().size > 0 && `${t().modpacks.export.exclusions.modsCount}: ${preview()!.mods.length - excludedMods().size}/${preview()!.mods.length}. `}
                {excludedOverrides().size > 0 && `${t().modpacks.export.exclusions.filesCount}: ${preview()!.overrides.length - excludedOverrides().size}/${preview()!.overrides.length}. `}
                {t().modpacks.export.exclusions.hint}
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
            {success() ? t().modpacks.export.buttons.close : t().modpacks.export.buttons.cancel}
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
                  {t().modpacks.export.buttons.export}
                </>
              }>
                <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                {t().modpacks.export.buttons.exporting}
              </Show>
            </button>
          </Show>
        </div>
      </div>
    </ModalWrapper>
  );
}

export default StzhkExportDialog;
