import { createSignal, Show, For, createMemo, onMount } from "solid-js";
import type { Component } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../../../shared/i18n";
import { Dropdown } from "../../../shared/ui";
import { ModalWrapper } from "../../../shared/ui/ModalWrapper";
import type { Instance } from "../../../shared/types";

// Типы для синхронизации
interface SyncProfile {
  id: string;
  name: string;
  description: string;
  is_builtin: boolean;
  enabled_categories: SettingCategory[];
  excluded_files: string[];
  included_files: string[];
}

type SettingCategory = "personal" | "performance" | "mod_config" | "gameplay" | "visual" | "unknown";

interface ClassifiedFile {
  path: string;
  category: SettingCategory;
  size: number;
  reason: ClassificationReason;
  will_sync: boolean;
  details?: string;
}

interface ClassificationReason {
  known_file?: { matched_pattern: string };
  known_keys?: { keys: string[] };
  file_name_heuristic?: boolean;
  content_heuristic?: boolean;
  directory_default?: boolean;
  user_rule?: { rule_id: string };
}

interface SyncPreview {
  files_to_sync: ClassifiedFile[];
  files_to_skip: SkippedFile[];
  total_size: number;
  by_category: Record<string, number>;
}

interface SkippedFile {
  path: string;
  reason: SkipReason;
}

type SkipReason =
  | { category_disabled: { category: SettingCategory } }
  | "explicitly_excluded"
  | "personal_setting"
  | "not_found"
  | "identical";

interface SyncResult {
  synced_files: string[];
  skipped_files: SkippedFile[];
  errors: SyncError[];
  backup_created: boolean;
  backup_path?: string;
  total_size: number;
}

interface SyncError {
  path: string;
  error: string;
}

interface Props {
  instances: Instance[];
  onClose: () => void;
}

const SettingsSyncDialog: Component<Props> = (props) => {
  const { t } = useI18n();

  // Состояние выбора
  const [sourceInstance, setSourceInstance] = createSignal("");
  const [targetInstance, setTargetInstance] = createSignal("");
  const [selectedProfile, setSelectedProfile] = createSignal("gameplay_only");
  const [profiles, setProfiles] = createSignal<SyncProfile[]>([]);

  // Расширенные настройки
  const [extraExcluded, setExtraExcluded] = createSignal("");
  const [extraIncluded, setExtraIncluded] = createSignal("");

  // Preview
  const [preview, setPreview] = createSignal<SyncPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = createSignal(false);

  // Результат
  const [result, setResult] = createSignal<SyncResult | null>(null);
  const [syncing, setSyncing] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // Подтверждение
  const [showConfirm, setShowConfirm] = createSignal(false);

  // Dropdown states
  const [sourceDropdownOpen, setSourceDropdownOpen] = createSignal(false);
  const [targetDropdownOpen, setTargetDropdownOpen] = createSignal(false);

  // Загрузка профилей при открытии
  onMount(async () => {
    try {
      const p = await invoke<SyncProfile[]>("list_sync_profiles");
      setProfiles(p);
    } catch (e) {
      console.error("Failed to load sync profiles:", e);
    }
  });

  const canPreview = createMemo(() =>
    sourceInstance() && targetInstance() && sourceInstance() !== targetInstance()
  );

  const loadPreview = async () => {
    if (!canPreview()) return;

    setLoadingPreview(true);
    setError(null);
    setPreview(null);

    try {
      const p = await invoke<SyncPreview>("preview_sync", {
        sourceInstanceId: sourceInstance(),
        targetInstanceId: targetInstance(),
        profileId: selectedProfile(),
        extraExcluded: extraExcluded().split("\n").filter(s => s.trim()),
        extraIncluded: extraIncluded().split("\n").filter(s => s.trim()),
      });
      setPreview(p);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingPreview(false);
    }
  };

  const executeSync = async () => {
    setSyncing(true);
    setError(null);
    setShowConfirm(false);

    try {
      const r = await invoke<SyncResult>("execute_sync", {
        sourceInstanceId: sourceInstance(),
        targetInstanceId: targetInstance(),
        profileId: selectedProfile(),
        extraExcluded: extraExcluded().split("\n").filter(s => s.trim()),
        extraIncluded: extraIncluded().split("\n").filter(s => s.trim()),
      });
      setResult(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setSyncing(false);
    }
  };

  const quickSync = async () => {
    if (!canPreview()) return;

    setSyncing(true);
    setError(null);

    try {
      const r = await invoke<SyncResult>("quick_sync", {
        sourceInstanceId: sourceInstance(),
        targetInstanceId: targetInstance(),
      });
      setResult(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setSyncing(false);
    }
  };

  const formatSize = (bytes: number) => {
    const units = t().settings.units;
    if (bytes < 1024) return `${bytes} ${units.bytes}`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} ${units.kilobytes}`;
    return `${(bytes / 1024 / 1024).toFixed(2)} ${units.megabytes}`;
  };

  const getCategoryColor = (cat: SettingCategory) => {
    switch (cat) {
      case "personal": return "text-red-400 bg-red-600/20 border-red-600/30";
      case "performance": return "text-yellow-400 bg-yellow-600/20 border-yellow-600/30";
      case "mod_config": return "text-green-400 bg-green-600/20 border-green-600/30";
      case "gameplay": return "text-blue-400 bg-blue-600/20 border-blue-600/30";
      case "visual": return "text-purple-400 bg-purple-600/20 border-purple-600/30";
      default: return "text-gray-400 bg-gray-600/20 border-gray-600/30";
    }
  };

  // Static category icon component to avoid UnoCSS dynamic parsing issues
  const CategoryIcon = (props: { category: SettingCategory; class?: string }) => {
    const baseClass = () => props.class || "w-3.5 h-3.5";
    return (
      <>
        <Show when={props.category === "personal"}>
          <i class={`i-hugeicons-user ${baseClass()} text-red-400`} />
        </Show>
        <Show when={props.category === "performance"}>
          <i class={`i-hugeicons-dashboard-speed-01 ${baseClass()} text-yellow-400`} />
        </Show>
        <Show when={props.category === "mod_config"}>
          <i class={`i-hugeicons-settings-02 ${baseClass()} text-green-400`} />
        </Show>
        <Show when={props.category === "gameplay"}>
          <i class={`i-hugeicons-game-controller-03 ${baseClass()} text-blue-400`} />
        </Show>
        <Show when={props.category === "visual"}>
          <i class={`i-hugeicons-view ${baseClass()} text-purple-400`} />
        </Show>
        <Show when={props.category === "unknown"}>
          <i class={`i-hugeicons-help-circle ${baseClass()} text-gray-400`} />
        </Show>
      </>
    );
  };

  const getCategoryLabel = (cat: SettingCategory) => {
    const categories = t().sync.categories;
    switch (cat) {
      case "personal": return categories.personal;
      case "performance": return categories.performance;
      case "mod_config": return categories.modConfig;
      case "gameplay": return categories.gameplay;
      case "visual": return categories.visual;
      default: return categories.unknown;
    }
  };

  const getSkipReasonLabel = (reason: SkipReason) => {
    const reasons = t().sync.skipReasons;
    if (typeof reason === "string") {
      switch (reason) {
        case "explicitly_excluded": return reasons.explicitlyExcluded;
        case "personal_setting": return reasons.personalSetting;
        case "not_found": return reasons.notFound;
        case "identical": return reasons.identical;
      }
    }
    if ("category_disabled" in reason) {
      return reasons.categoryDisabled;
    }
    return "";
  };

  const sourceInstanceName = createMemo(() => {
    const inst = props.instances.find(i => i.id === sourceInstance());
    return inst?.name || "";
  });

  const targetInstanceName = createMemo(() => {
    const inst = props.instances.find(i => i.id === targetInstance());
    return inst?.name || "";
  });

  return (
    <ModalWrapper maxWidth="max-w-[800px]" backdrop onBackdropClick={props.onClose}>
      <div class="max-h-[85vh] overflow-hidden flex flex-col p-4">
        {/* Header */}
        <div class="flex items-center justify-between pb-4 border-b border-gray-800">
          <div class="flex items-center gap-3">
            <div class="flex-center w-10 h-10 rounded-2xl bg-blue-600/20">
              <i class="i-hugeicons-refresh w-5 h-5 text-blue-400" />
            </div>
            <div>
              <h2 class="text-lg font-semibold">{t().sync.title}</h2>
              <p class="text-sm text-muted">{t().sync.subtitle}</p>
            </div>
          </div>
          <button class="btn-close" onClick={props.onClose}>
            <i class="i-hugeicons-cancel-01 w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div class="flex-1 overflow-y-auto py-4">
          <Show when={!result()}>
            {/* Selection */}
            <div class="space-y-4">
              {/* Source & Target */}
              <div class="grid grid-cols-2 gap-4">
                <div class="space-y-2">
                  <label class="text-sm font-medium text-green-400">{t().sync.sourceInstance}</label>
                  <Dropdown
                    open={sourceDropdownOpen()}
                    onClose={() => setSourceDropdownOpen(false)}
                    trigger={
                      <button
                        class="input w-full flex items-center justify-between"
                        onClick={() => setSourceDropdownOpen(!sourceDropdownOpen())}
                      >
                        <span class={sourceInstance() ? "" : "text-muted"}>
                          {sourceInstanceName() || t().sync.selectInstance}
                        </span>
                        <i class="i-hugeicons-arrow-down-01 w-4 h-4 text-muted" />
                      </button>
                    }
                  >
                    <div class="overflow-y-auto">
                      <For each={props.instances}>
                        {(inst) => (
                          <button
                            class={`w-full px-3 py-2 text-left text-sm hover:bg-gray-700/50 transition-colors ${
                              inst.id === sourceInstance() ? "bg-green-600/20 text-green-400" : ""
                            } ${inst.id === targetInstance() ? "opacity-50 cursor-not-allowed" : ""}`}
                            onClick={() => {
                              if (inst.id !== targetInstance()) {
                                setSourceInstance(inst.id);
                                setPreview(null);
                                setSourceDropdownOpen(false);
                              }
                            }}
                            disabled={inst.id === targetInstance()}
                          >
                            <div class="flex items-center gap-2">
                              <Show when={inst.id === sourceInstance()}>
                                <i class="i-hugeicons-checkmark-circle-02 w-4 h-4 text-green-400" />
                              </Show>
                              <Show when={inst.id !== sourceInstance()}>
                                <div class="w-4 h-4" />
                              </Show>
                              <span>{inst.name}</span>
                            </div>
                          </button>
                        )}
                      </For>
                    </div>
                  </Dropdown>
                </div>

                <div class="space-y-2">
                  <label class="text-sm font-medium text-blue-400">{t().sync.targetInstance}</label>
                  <Dropdown
                    open={targetDropdownOpen()}
                    onClose={() => setTargetDropdownOpen(false)}
                    trigger={
                      <button
                        class="input w-full flex items-center justify-between"
                        onClick={() => setTargetDropdownOpen(!targetDropdownOpen())}
                      >
                        <span class={targetInstance() ? "" : "text-muted"}>
                          {targetInstanceName() || t().sync.selectInstance}
                        </span>
                        <i class="i-hugeicons-arrow-down-01 w-4 h-4 text-muted" />
                      </button>
                    }
                  >
                    <div class="overflow-y-auto">
                      <For each={props.instances}>
                        {(inst) => (
                          <button
                            class={`w-full px-3 py-2 text-left text-sm hover:bg-gray-700/50 transition-colors ${
                              inst.id === targetInstance() ? "bg-blue-600/20 text-blue-400" : ""
                            } ${inst.id === sourceInstance() ? "opacity-50 cursor-not-allowed" : ""}`}
                            onClick={() => {
                              if (inst.id !== sourceInstance()) {
                                setTargetInstance(inst.id);
                                setPreview(null);
                                setTargetDropdownOpen(false);
                              }
                            }}
                            disabled={inst.id === sourceInstance()}
                          >
                            <div class="flex items-center gap-2">
                              <Show when={inst.id === targetInstance()}>
                                <i class="i-hugeicons-checkmark-circle-02 w-4 h-4 text-blue-400" />
                              </Show>
                              <Show when={inst.id !== targetInstance()}>
                                <div class="w-4 h-4" />
                              </Show>
                              <span>{inst.name}</span>
                            </div>
                          </button>
                        )}
                      </For>
                    </div>
                  </Dropdown>
                </div>
              </div>

              {/* Profile Selection */}
              <div class="space-y-2">
                <label class="text-sm font-medium">{t().sync.profile}</label>
                <For each={profiles()}>
                  {(profile) => (
                    <button
                      class={`w-full p-4 rounded-xl border text-left transition-colors duration-100 ${
                        selectedProfile() === profile.id
                          ? "bg-blue-600/20 border-blue-500"
                          : "bg-gray-800/50 border-gray-700 hover:border-gray-600"
                      }`}
                      onClick={() => { setSelectedProfile(profile.id); setPreview(null); }}
                    >
                      <div class="flex flex-col gap-1 text-center">
                        <div class="flex items-center gap-2 justify-center text-center">
                          <span class="font-medium">
                            {profile.id === "gameplay_only" ? t().sync.profiles.gameplayOnly :
                              profile.id === "full_sync" ? t().sync.profiles.fullSync :
                              profile.id === "minimal" ? t().sync.profiles.minimal : profile.name}
                          </span>
                          <Show when={selectedProfile() === profile.id}>
                            <i class="i-hugeicons-checkmark-circle-02 w-4 h-4 text-blue-400" />
                          </Show>
                        </div>
                        <p class="text-sm text-muted leading-relaxed justify-center text-center">
                          {profile.id === "gameplay_only" ? t().sync.profiles.gameplayOnlyDesc :
                            profile.id === "full_sync" ? t().sync.profiles.fullSyncDesc :
                            profile.id === "minimal" ? t().sync.profiles.minimalDesc : profile.description}
                        </p>
                      </div>
                    </button>
                  )}
                </For>
              </div>

              {/* Categories Legend */}
              <div class="p-3 bg-gray-800/30 rounded-2xl">
                <div class="text-xs font-medium text-muted mb-2">{t().sync.categories.personal}:</div>
                <div class="grid grid-cols-3 gap-2 text-xs">
                  <div class="flex items-center gap-1.5">
                    <i class="i-hugeicons-user w-3.5 h-3.5 text-red-400" />
                    <span class="text-red-400">{t().sync.categories.personal}</span>
                    <span class="text-muted">- {t().sync.categories.personalDesc.split(" - ")[0]}</span>
                  </div>
                  <div class="flex items-center gap-1.5">
                    <i class="i-hugeicons-dashboard-speed-01 w-3.5 h-3.5 text-yellow-400" />
                    <span class="text-yellow-400">{t().sync.categories.performance}</span>
                  </div>
                  <div class="flex items-center gap-1.5">
                    <i class="i-hugeicons-settings-02 w-3.5 h-3.5 text-green-400" />
                    <span class="text-green-400">{t().sync.categories.modConfig}</span>
                  </div>
                  <div class="flex items-center gap-1.5">
                    <i class="i-hugeicons-game-controller-03 w-3.5 h-3.5 text-blue-400" />
                    <span class="text-blue-400">{t().sync.categories.gameplay}</span>
                  </div>
                  <div class="flex items-center gap-1.5">
                    <i class="i-hugeicons-view w-3.5 h-3.5 text-purple-400" />
                    <span class="text-purple-400">{t().sync.categories.visual}</span>
                  </div>
                </div>
              </div>

              {/* Advanced Settings */}
              <details class="group">
                <summary class="text-sm font-medium cursor-pointer flex items-center gap-2 select-none">
                  <i class="i-hugeicons-settings-02 w-4 h-4" />
                  {t().sync.advanced.title}
                  <i class="i-hugeicons-arrow-down-01 w-4 h-4 group-open:rotate-180 transition-transform duration-100" />
                </summary>
                <div class="mt-3 grid grid-cols-2 gap-4">
                  <div class="space-y-1">
                    <label class="text-xs text-muted">{t().sync.advanced.exclude}</label>
                    <textarea
                      class="input w-full h-20 text-xs font-mono"
                      placeholder={t().sync.advanced.excludeHint}
                      value={extraExcluded()}
                      onInput={(e) => setExtraExcluded(e.target.value)}
                    />
                  </div>
                  <div class="space-y-1">
                    <label class="text-xs text-muted">{t().sync.advanced.include}</label>
                    <textarea
                      class="input w-full h-20 text-xs font-mono"
                      placeholder={t().sync.advanced.includeHint}
                      value={extraIncluded()}
                      onInput={(e) => setExtraIncluded(e.target.value)}
                    />
                  </div>
                </div>
              </details>

              {/* Error */}
              <Show when={error()}>
                <div class="p-3 bg-red-600/20 border border-red-600/40 rounded-2xl text-sm text-red-400">
                  {error()}
                </div>
              </Show>

              {/* Preview Section */}
              <Show when={preview()}>
                <div class="space-y-3 pt-4 border-t border-gray-800">
                  <h3 class="text-sm font-medium">{t().sync.previewTitle}</h3>

                  {/* Stats */}
                  <div class="grid grid-cols-3 gap-3">
                    <div class="p-3 bg-green-600/10 rounded-2xl border border-green-600/30 text-center">
                      <div class="text-2xl font-bold text-green-400">{preview()!.files_to_sync.length}</div>
                      <div class="text-xs text-muted">{t().sync.willSync}</div>
                    </div>
                    <div class="p-3 bg-gray-600/10 rounded-2xl border border-gray-600/30 text-center">
                      <div class="text-2xl font-bold text-gray-400">{preview()!.files_to_skip.length}</div>
                      <div class="text-xs text-muted">{t().sync.willSkip}</div>
                    </div>
                    <div class="p-3 bg-blue-600/10 rounded-2xl border border-blue-600/30 text-center">
                      <div class="text-2xl font-bold text-blue-400">{formatSize(preview()!.total_size)}</div>
                      <div class="text-xs text-muted">{t().sync.totalSize}</div>
                    </div>
                  </div>

                  {/* By Category */}
                  <div class="space-y-1">
                    <div class="text-xs text-muted">{t().sync.byCategory}:</div>
                    <div class="flex flex-wrap gap-2">
                      <For each={Object.entries(preview()!.by_category)}>
                        {([cat, count]) => (
                          <span class={`px-2 py-1 rounded text-xs border ${getCategoryColor(cat.toLowerCase().replace("modconfig", "mod_config") as SettingCategory)}`}>
                            {getCategoryLabel(cat.toLowerCase().replace("modconfig", "mod_config") as SettingCategory)}: {count}
                          </span>
                        )}
                      </For>
                    </div>
                  </div>

                  {/* Files to Sync */}
                  <Show when={preview()!.files_to_sync.length > 0}>
                    <details class="group">
                      <summary class="text-xs text-green-400 cursor-pointer flex items-center gap-1">
                        <i class="i-hugeicons-arrow-down-01 w-3 h-3 group-open:rotate-180 transition-transform" />
                        {t().sync.willSync} ({preview()!.files_to_sync.length})
                      </summary>
                      <div class="mt-2 max-h-32 overflow-y-auto space-y-1">
                        <For each={preview()!.files_to_sync}>
                          {(file) => (
                            <div class="flex items-center gap-2 p-1.5 bg-gray-800/30 rounded text-xs">
                              <CategoryIcon category={file.category} />
                              <span class="flex-1 truncate font-mono">{file.path}</span>
                              <span class="text-muted">{formatSize(file.size)}</span>
                            </div>
                          )}
                        </For>
                      </div>
                    </details>
                  </Show>

                  {/* Files to Skip */}
                  <Show when={preview()!.files_to_skip.length > 0}>
                    <details class="group">
                      <summary class="text-xs text-gray-400 cursor-pointer flex items-center gap-1">
                        <i class="i-hugeicons-arrow-down-01 w-3 h-3 group-open:rotate-180 transition-transform" />
                        {t().sync.willSkip} ({preview()!.files_to_skip.length})
                      </summary>
                      <div class="mt-2 max-h-32 overflow-y-auto space-y-1">
                        <For each={preview()!.files_to_skip}>
                          {(file) => (
                            <div class="flex items-center gap-2 p-1.5 bg-gray-800/30 rounded text-xs">
                              <i class="i-hugeicons-minus-sign w-3.5 h-3.5 text-gray-500" />
                              <span class="flex-1 truncate font-mono">{file.path}</span>
                              <span class="text-muted">{getSkipReasonLabel(file.reason)}</span>
                            </div>
                          )}
                        </For>
                      </div>
                    </details>
                  </Show>
                </div>
              </Show>
            </div>
          </Show>

          {/* Result */}
          <Show when={result()}>
            <div class="space-y-4">
              <div class="flex-center py-4">
                <div class="w-16 h-16 rounded-full bg-green-600/20 flex-center">
                  <i class="i-hugeicons-checkmark-circle-02 w-8 h-8 text-green-400" />
                </div>
              </div>

              <h3 class="text-center text-lg font-semibold">{t().sync.result.success}</h3>

              <div class="grid grid-cols-3 gap-3">
                <div class="p-3 bg-green-600/10 rounded-2xl border border-green-600/30 text-center">
                  <div class="text-2xl font-bold text-green-400">{result()!.synced_files.length}</div>
                  <div class="text-xs text-muted">{t().sync.result.synced}</div>
                </div>
                <div class="p-3 bg-gray-600/10 rounded-2xl border border-gray-600/30 text-center">
                  <div class="text-2xl font-bold text-gray-400">{result()!.skipped_files.length}</div>
                  <div class="text-xs text-muted">{t().sync.result.skipped}</div>
                </div>
                <div class="p-3 bg-red-600/10 rounded-2xl border border-red-600/30 text-center">
                  <div class="text-2xl font-bold text-red-400">{result()!.errors.length}</div>
                  <div class="text-xs text-muted">{t().sync.result.errors}</div>
                </div>
              </div>

              <Show when={result()!.backup_created}>
                <div class="p-3 bg-blue-600/10 rounded-2xl border border-blue-600/30 text-sm flex items-center gap-2">
                  <i class="i-hugeicons-floppy-disk w-4 h-4 text-blue-400" />
                  <span>{t().sync.result.backupCreated}</span>
                </div>
              </Show>

              <Show when={result()!.errors.length > 0}>
                <div class="space-y-1">
                  <div class="text-xs text-red-400">{t().sync.result.errors}:</div>
                  <div class="max-h-24 overflow-y-auto space-y-1">
                    <For each={result()!.errors}>
                      {(err) => (
                        <div class="p-2 bg-red-600/10 rounded text-xs">
                          <span class="font-mono">{err.path}</span>: {err.error}
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              </Show>
            </div>
          </Show>
        </div>

        {/* Footer */}
        <div class="pt-4 border-t border-gray-800 flex justify-between">
          <Show when={!result()}>
            <button
              class="btn-secondary"
              onClick={quickSync}
              disabled={!canPreview() || syncing()}
              title={t().sync.quickSyncHint}
            >
              <i class="i-hugeicons-flash w-4 h-4" />
              {t().sync.quickSync}
            </button>
            <div class="flex gap-2">
              <button
                class="btn-secondary"
                onClick={loadPreview}
                disabled={!canPreview() || loadingPreview()}
              >
                <Show when={loadingPreview()} fallback={<><i class="i-hugeicons-view w-4 h-4" /> {t().sync.preview}</>}>
                  <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                </Show>
              </button>
              <button
                class="btn-primary"
                onClick={() => setShowConfirm(true)}
                disabled={!preview() || preview()!.files_to_sync.length === 0 || syncing()}
              >
                <Show when={syncing()} fallback={<><i class="i-hugeicons-refresh w-4 h-4" /> {t().sync.sync}</>}>
                  <i class="i-svg-spinners-6-dots-scale w-4 h-4" /> {t().sync.syncing}
                </Show>
              </button>
            </div>
          </Show>

          <Show when={result()}>
            <button class="btn-secondary" onClick={() => { setResult(null); setPreview(null); }}>
              <i class="i-hugeicons-refresh w-4 h-4" />
              {t().common.back}
            </button>
            <button class="btn-primary" onClick={props.onClose}>
              {t().common.close}
            </button>
          </Show>
        </div>
      </div>

      {/* Confirm Dialog */}
      <Show when={showConfirm()}>
        <div class="fixed inset-0 bg-black/80 flex-center z-50">
          <div class="card w-[400px] p-6">
            <div class="flex items-center gap-3 mb-4">
              <div class="flex-center w-10 h-10 rounded-2xl bg-yellow-600/20">
                <i class="i-hugeicons-alert-02 w-5 h-5 text-yellow-400" />
              </div>
              <h3 class="text-lg font-semibold">{t().sync.confirmSync.title}</h3>
            </div>

            <div class="space-y-3 mb-6">
              <p class="text-sm text-muted">{t().sync.confirmSync.message}</p>

              <div class="p-3 bg-gray-800/50 rounded-2xl text-sm space-y-1">
                <div class="flex justify-between">
                  <span class="text-muted">{t().sync.sourceInstance}:</span>
                  <span class="text-green-400">{sourceInstanceName()}</span>
                </div>
                <div class="flex justify-between">
                  <span class="text-muted">{t().sync.targetInstance}:</span>
                  <span class="text-blue-400">{targetInstanceName()}</span>
                </div>
                <div class="flex justify-between">
                  <span class="text-muted">{t().sync.filesCount}:</span>
                  <span>{preview()?.files_to_sync.length || 0}</span>
                </div>
              </div>

              <div class="p-3 bg-green-600/10 border border-green-600/30 rounded-2xl text-xs text-green-400 inline-flex items-center gap-1">
                <i class="i-hugeicons-security-check w-4 h-4" />
                {t().sync.confirmSync.warning}
              </div>
            </div>

            <div class="flex justify-end gap-2">
              <button class="btn-secondary" onClick={() => setShowConfirm(false)}>
                {t().common.cancel}
              </button>
              <button class="btn-primary" onClick={executeSync}>
                <i class="i-hugeicons-refresh w-4 h-4" />
                {t().sync.sync}
              </button>
            </div>
          </div>
        </div>
      </Show>
    </ModalWrapper>
  );
};

export default SettingsSyncDialog;
