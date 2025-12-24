import { createSignal, Show, For, createEffect, onMount, type Component } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useI18n } from "../../../shared/i18n";
import { Tabs } from "../../../shared/ui";
import type {
  Instance,
  ModpackPatch,
  PatchPreview,
  PatchApplyResult,
  PatchCompatibilityResult,
  InstanceSnapshot,
  InstanceChanges,
} from "../../../shared/types";

interface Props {
  instance: Instance;
}

type PanelMode = "apply" | "create";

export const PatchesPanel: Component<Props> = (props) => {
  const { t } = useI18n();

  // Safe accessors for instance
  const inst = () => props.instance;
  const instanceId = () => inst()?.id ?? "";
  const instanceStatus = () => inst()?.status ?? "stopped";
  const instanceName = () => inst()?.name ?? "";

  // Mode
  const [mode, setMode] = createSignal<PanelMode>("apply");

  // Apply Patch State
  const [patch, setPatch] = createSignal<ModpackPatch | null>(null);
  const [patchPath, setPatchPath] = createSignal<string | null>(null);
  const [compatibility, setCompatibility] = createSignal<PatchCompatibilityResult | null>(null);
  const [preview, setPreview] = createSignal<PatchPreview | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [checkingCompatibility, setCheckingCompatibility] = createSignal(false);
  const [applying, setApplying] = createSignal(false);
  const [result, setResult] = createSignal<PatchApplyResult | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  // Create Patch State
  const [snapshot, setSnapshot] = createSignal<InstanceSnapshot | null>(null);
  const [changes, setChanges] = createSignal<InstanceChanges | null>(null);
  const [creatingSnapshot, setCreatingSnapshot] = createSignal(false);
  const [detectingChanges, setDetectingChanges] = createSignal(false);
  const [creatingPatch, setCreatingPatch] = createSignal(false);
  const [patchDescription, setPatchDescription] = createSignal("");
  const [patchAuthor, setPatchAuthor] = createSignal("");
  const [includeConfigs, setIncludeConfigs] = createSignal(true);
  const [createSuccess, setCreateSuccess] = createSignal<string | null>(null);

  // Load snapshot on mount
  onMount(async () => {
    if (!instanceId()) return;
    try {
      const existing = await invoke<InstanceSnapshot | null>("get_instance_snapshot", {
        instanceId: instanceId(),
      });
      setSnapshot(existing);
    } catch (e) {
      console.error("Failed to load snapshot:", e);
    }
  });

  // Check compatibility when patch changes
  createEffect(async () => {
    const currentPatch = patch();
    const instId = instanceId();

    if (!currentPatch || !instId) {
      setCompatibility(null);
      return;
    }

    setCheckingCompatibility(true);
    try {
      const result = await invoke<PatchCompatibilityResult>("check_patch_compatibility", {
        patch: currentPatch,
        instanceId: instId,
      });
      setCompatibility(result);
    } catch (e) {
      console.error("Failed to check compatibility:", e);
      setCompatibility(null);
    } finally {
      setCheckingCompatibility(false);
    }
  });

  // Select patch file
  const handleSelectFile = async () => {
    try {
      const filePath = await open({
        filters: [{ name: "Stuzhik Patch", extensions: ["stzhk"] }],
        multiple: false,
      });

      if (!filePath) return;

      setLoading(true);
      setError(null);
      setPatchPath(filePath as string);

      // Load and parse patch
      const loadedPatch = await invoke<ModpackPatch>("load_modpack_patch", {
        path: filePath,
      });
      setPatch(loadedPatch);
      setPreview(null);
      setResult(null);
    } catch (e) {
      console.error("Failed to load patch:", e);
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  // Preview patch application
  const handlePreview = async () => {
    const currentPatch = patch();
    const instId = instanceId();
    if (!currentPatch || !instId) return;

    setLoading(true);
    setError(null);

    try {
      const previewResult = await invoke<PatchPreview>("preview_modpack_patch", {
        instanceId: instId,
        patch: currentPatch,
      });
      setPreview(previewResult);
    } catch (e) {
      console.error("Failed to preview patch:", e);
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  // Apply patch
  const handleApply = async () => {
    const currentPatch = patch();
    const instId = instanceId();
    if (!currentPatch || !instId) return;

    setApplying(true);
    setError(null);

    try {
      const applyResult = await invoke<PatchApplyResult>("apply_modpack_patch", {
        instanceId: instId,
        patch: currentPatch,
      });
      setResult(applyResult);
    } catch (e) {
      console.error("Failed to apply patch:", e);
      setError(String(e));
    } finally {
      setApplying(false);
    }
  };

  // Reset to load another patch
  const handleReset = () => {
    setPatch(null);
    setPatchPath(null);
    setCompatibility(null);
    setPreview(null);
    setResult(null);
    setError(null);
  };

  // Create snapshot
  const handleCreateSnapshot = async () => {
    const instId = instanceId();
    if (!instId) return;

    setCreatingSnapshot(true);
    setError(null);
    setChanges(null);

    try {
      const newSnapshot = await invoke<InstanceSnapshot>("create_instance_snapshot", {
        instanceId: instId,
      });
      setSnapshot(newSnapshot);
    } catch (e) {
      console.error("Failed to create snapshot:", e);
      setError(String(e));
    } finally {
      setCreatingSnapshot(false);
    }
  };

  // Delete snapshot
  const handleDeleteSnapshot = async () => {
    const instId = instanceId();
    if (!instId) return;

    try {
      await invoke("delete_instance_snapshot", {
        instanceId: instId,
      });
      setSnapshot(null);
      setChanges(null);
    } catch (e) {
      console.error("Failed to delete snapshot:", e);
      setError(String(e));
    }
  };

  // Detect changes
  const handleDetectChanges = async () => {
    const instId = instanceId();
    if (!instId) return;

    setDetectingChanges(true);
    setError(null);

    try {
      const detectedChanges = await invoke<InstanceChanges | null>("detect_instance_changes", {
        instanceId: instId,
      });
      setChanges(detectedChanges);
    } catch (e) {
      console.error("Failed to detect changes:", e);
      setError(String(e));
    } finally {
      setDetectingChanges(false);
    }
  };

  // Create patch from changes
  const handleCreatePatch = async () => {
    const instId = instanceId();
    const instName = instanceName();
    if (!instId) return;

    if (!patchDescription().trim()) {
      setError("Please enter a description for the patch");
      return;
    }

    setCreatingPatch(true);
    setError(null);
    setCreateSuccess(null);

    try {
      const newPatch = await invoke<ModpackPatch>("create_patch_from_instance_changes", {
        instanceId: instId,
        description: patchDescription(),
        author: patchAuthor() || null,
        includeConfigs: includeConfigs(),
      });

      // Ask where to save
      const savePath = await save({
        filters: [{ name: "Stuzhik Patch", extensions: ["stzhk"] }],
        defaultPath: `${instName.replace(/[^a-zA-Z0-9]/g, "_")}_patch.stzhk`,
      });

      if (savePath) {
        await invoke("save_modpack_patch", {
          patch: newPatch,
          path: savePath,
        });
        setCreateSuccess(savePath);
        setPatchDescription("");
        setPatchAuthor("");
      }
    } catch (e) {
      console.error("Failed to create patch:", e);
      setError(String(e));
    } finally {
      setCreatingPatch(false);
    }
  };

  const statusColors: Record<string, string> = {
    compatible: "bg-green-600/10 border-green-600/30 text-green-400",
    compatible_with_warnings: "bg-yellow-600/10 border-yellow-600/30 text-yellow-400",
    incompatible: "bg-red-600/10 border-red-600/30 text-red-400",
    already_applied: "bg-blue-600/10 border-blue-600/30 text-blue-400",
  };

  const statusIcons: Record<string, string> = {
    compatible: "i-hugeicons-checkmark-circle-02",
    compatible_with_warnings: "i-hugeicons-alert-02",
    incompatible: "i-hugeicons-cancel-circle",
    already_applied: "i-hugeicons-information-circle",
  };

  const statusLabels: Record<string, string> = {
    compatible: t().modpackCompare?.patch?.compatibility?.compatible || "Compatible",
    compatible_with_warnings: t().modpackCompare?.patch?.compatibility?.compatibleWithWarnings || "Compatible with warnings",
    incompatible: t().modpackCompare?.patch?.compatibility?.incompatible || "Incompatible",
    already_applied: t().modpackCompare?.patch?.compatibility?.alreadyApplied || "Already applied",
  };

  const formatDate = (dateStr: string) => {
    try {
      return new Date(dateStr).toLocaleString();
    } catch {
      return dateStr;
    }
  };

  return (
    <div class="space-y-4">
      {/* Mode Tabs */}
      <Tabs
        tabs={[
          { id: "apply", label: t().modpackCompare?.patch?.apply || "Apply Patch", icon: "i-hugeicons-file-import" },
          { id: "create", label: t().patches?.create || "Create Patch", icon: "i-hugeicons-file-add" },
        ]}
        activeTab={mode()}
        onTabChange={(id) => setMode(id as PanelMode)}
        variant="underline"
      />

      {/* Instance disabled warning */}
      <Show when={instanceStatus() !== "stopped" && mode() === "apply"}>
        <div class="p-3 bg-yellow-600/10 border border-yellow-600/30 rounded-xl flex items-start gap-2">
          <i class="i-hugeicons-alert-02 w-4 h-4 text-yellow-400 flex-shrink-0 mt-0.5" />
          <span class="text-sm text-yellow-300">
            {t().modpackCompare?.patch?.instanceMustBeStopped || "Instance must be stopped to apply patches"}
          </span>
        </div>
      </Show>

      {/* ========== APPLY PATCH MODE ========== */}
      <Show when={mode() === "apply"}>
        {/* File Selection */}
        <Show when={!patch()}>
          <div class="p-8 border-2 border-dashed border-gray-600 rounded-2xl text-center">
            <i class="i-hugeicons-file-add w-12 h-12 text-gray-500 mx-auto mb-4" />
            <p class="text-gray-400 mb-4">
              {t().modpackCompare?.patch?.selectFile || "Select a patch file (.stzhk)"}
            </p>
            <button
              class="btn-secondary"
              onClick={handleSelectFile}
              disabled={loading() || instanceStatus() !== "stopped"}
            >
              <i class="i-hugeicons-folder-01 w-4 h-4" />
              {t().modpackCompare?.patch?.browse || "Browse..."}
            </button>
          </div>
        </Show>

        {/* Patch Info */}
        <Show when={patch()}>
          <div class="flex items-center justify-between mb-2">
            <span class="text-sm font-medium">{t().patches?.loaded || "Loaded Patch"}</span>
            <button class="btn-ghost text-sm" onClick={handleReset}>
              <i class="i-hugeicons-refresh w-4 h-4" />
              {t().common.reset || "Reset"}
            </button>
          </div>
          <div class="card bg-gray-alpha-30 p-4 space-y-3">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2">
                <i class="i-hugeicons-file-01 w-5 h-5 text-cyan-400" />
                <span class="font-medium">{patch()!.base_modpack.name}</span>
              </div>
              <span class="text-xs text-muted">
                {patchPath()?.split(/[/\\]/).pop()}
              </span>
            </div>
            <p class="text-sm text-muted">{patch()!.description}</p>
            <Show when={patch()!.author}>
              <p class="text-xs text-muted">
                {t().modpackCompare?.patch?.author || "Author"}: {patch()!.author}
              </p>
            </Show>
            <div class="flex flex-wrap gap-2 text-xs">
              <span class="px-2 py-1 bg-green-600/20 text-green-400 rounded">
                +{patch()!.changes.mods_to_add.length} {t().mods?.title || "mods"}
              </span>
              <span class="px-2 py-1 bg-red-600/20 text-red-400 rounded">
                -{patch()!.changes.mods_to_remove.length} {t().mods?.title || "mods"}
              </span>
              <Show when={patch()!.changes.configs_to_add.length > 0}>
                <span class="px-2 py-1 bg-blue-600/20 text-blue-400 rounded">
                  {patch()!.changes.configs_to_add.length} configs
                </span>
              </Show>
            </div>
          </div>
        </Show>

        {/* Compatibility Check Result */}
        <Show when={compatibility() && !result()}>
          {(() => {
            const compat = compatibility()!;
            return (
              <div class={`p-3 rounded-xl border ${statusColors[compat.status]}`}>
                <div class="flex items-center gap-2 mb-2">
                  <i class={`w-4 h-4 ${statusIcons[compat.status]}`} />
                  <span class="font-medium text-sm">{statusLabels[compat.status]}</span>
                </div>

                {/* Errors */}
                <Show when={compat.errors.length > 0}>
                  <ul class="text-xs space-y-1 mb-2">
                    <For each={compat.errors}>
                      {(err) => <li class="text-red-300">• {err}</li>}
                    </For>
                  </ul>
                </Show>

                {/* Warnings */}
                <Show when={compat.warnings.length > 0}>
                  <ul class="text-xs space-y-1 mb-2">
                    <For each={compat.warnings}>
                      {(warn) => <li class="text-yellow-300">• {warn}</li>}
                    </For>
                  </ul>
                </Show>

                {/* Recommendation */}
                <Show when={compat.recommendation}>
                  <p class="text-xs text-muted mt-2 italic">{compat.recommendation}</p>
                </Show>
              </div>
            );
          })()}
        </Show>

        {/* Checking compatibility spinner */}
        <Show when={checkingCompatibility()}>
          <div class="flex items-center gap-2 text-sm text-muted">
            <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
            {t().modpackCompare?.patch?.compatibility?.checking || "Checking compatibility..."}
          </div>
        </Show>

        {/* Preview Button */}
        <Show
          when={
            patch() &&
            !preview() &&
            !result() &&
            !checkingCompatibility() &&
            compatibility() &&
            (compatibility()!.status === "compatible" || compatibility()!.status === "compatible_with_warnings")
          }
        >
          <button class="btn-secondary w-full" onClick={handlePreview} disabled={loading()}>
            <Show
              when={loading()}
              fallback={
                <>
                  <i class="i-hugeicons-view w-4 h-4" /> {t().modpackCompare?.patch?.preview || "Preview"}
                </>
              }
            >
              <i class="i-svg-spinners-6-dots-scale w-4 h-4" /> {t().common.loading}
            </Show>
          </button>
        </Show>

        {/* Preview Results */}
        <Show when={preview()}>
          <div class="space-y-3">
            <h4 class="text-sm font-semibold flex items-center gap-2">
              <i class="i-hugeicons-view w-4 h-4 text-cyan-400" />
              {t().modpackCompare?.patch?.previewTitle || "Patch Preview"}
            </h4>

            {/* Mods to Add */}
            <Show when={preview()!.mods_to_add.length > 0}>
              <div class="space-y-1">
                <p class="text-xs text-green-400 font-medium">
                  {t().modpackCompare?.patch?.modsToAdd || "Mods to add"} ({preview()!.mods_to_add.length})
                </p>
                <div class="flex flex-wrap gap-1">
                  <For each={preview()!.mods_to_add}>
                    {(mod) => (
                      <span class="px-2 py-0.5 bg-green-600/20 text-green-300 text-xs rounded">
                        {mod}
                      </span>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            {/* Mods to Remove */}
            <Show when={preview()!.mods_to_remove.length > 0}>
              <div class="space-y-1">
                <p class="text-xs text-red-400 font-medium">
                  {t().modpackCompare?.patch?.modsToRemove || "Mods to remove"} ({preview()!.mods_to_remove.length})
                </p>
                <div class="flex flex-wrap gap-1">
                  <For each={preview()!.mods_to_remove}>
                    {(mod) => (
                      <span class="px-2 py-0.5 bg-red-600/20 text-red-300 text-xs rounded">
                        {mod}
                      </span>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            {/* Configs */}
            <Show when={preview()!.configs_to_change.length > 0}>
              <div class="space-y-1">
                <p class="text-xs text-blue-400 font-medium">
                  {t().modpackCompare?.patch?.configsToChange || "Configs to change"} ({preview()!.configs_to_change.length})
                </p>
                <div class="flex flex-wrap gap-1">
                  <For each={preview()!.configs_to_change.slice(0, 10)}>
                    {(config) => (
                      <span class="px-2 py-0.5 bg-blue-600/20 text-blue-300 text-xs rounded">
                        {config}
                      </span>
                    )}
                  </For>
                  <Show when={preview()!.configs_to_change.length > 10}>
                    <span class="px-2 py-0.5 bg-gray-600/20 text-gray-300 text-xs rounded">
                      +{preview()!.configs_to_change.length - 10} {t().common.more}
                    </span>
                  </Show>
                </div>
              </div>
            </Show>

            {/* Warnings */}
            <Show when={preview()!.warnings.length > 0}>
              <div class="p-3 bg-yellow-600/10 border border-yellow-600/30 rounded-xl">
                <p class="text-xs text-yellow-400 font-medium mb-2">
                  <i class="i-hugeicons-alert-02 w-3 h-3 inline mr-1" />
                  {t().modpackCompare?.patch?.warnings || "Warnings"}
                </p>
                <ul class="text-xs text-yellow-300 space-y-1">
                  <For each={preview()!.warnings}>{(warning) => <li>- {warning}</li>}</For>
                </ul>
              </div>
            </Show>

            {/* Errors */}
            <Show when={preview()!.errors.length > 0}>
              <div class="p-3 bg-red-600/10 border border-red-600/30 rounded-xl">
                <p class="text-xs text-red-400 font-medium mb-2">
                  <i class="i-hugeicons-alert-circle w-3 h-3 inline mr-1" />
                  {t().modpackCompare?.patch?.errors || "Errors"}
                </p>
                <ul class="text-xs text-red-300 space-y-1">
                  <For each={preview()!.errors}>{(err) => <li>- {err}</li>}</For>
                </ul>
              </div>
            </Show>

            {/* Apply Button */}
            <button
              class="btn-primary bg-cyan-600 hover:bg-cyan-700 w-full"
              onClick={handleApply}
              disabled={applying() || preview()!.errors.length > 0}
            >
              <Show
                when={applying()}
                fallback={
                  <>
                    <i class="i-hugeicons-play w-4 h-4" /> {t().modpackCompare?.patch?.apply || "Apply Patch"}
                  </>
                }
              >
                <i class="i-svg-spinners-6-dots-scale w-4 h-4" />{" "}
                {t().modpackCompare?.patch?.applying || "Applying..."}
              </Show>
            </button>
          </div>
        </Show>

        {/* Apply Result */}
        <Show when={result()}>
          <div
            class={`p-4 rounded-xl border ${
              result()!.success ? "bg-green-600/10 border-green-600/30" : "bg-red-600/10 border-red-600/30"
            }`}
          >
            <div class="flex items-center gap-2 mb-3">
              <i
                class={`w-5 h-5 ${
                  result()!.success ? "i-hugeicons-checkmark-circle-02 text-green-400" : "i-hugeicons-cancel-circle text-red-400"
                }`}
              />
              <span class="font-medium">
                {result()!.success
                  ? t().modpackCompare?.patch?.success || "Patch applied successfully"
                  : t().modpackCompare?.patch?.failed || "Failed to apply patch"}
              </span>
            </div>

            <Show when={result()!.mods_added.length > 0}>
              <p class="text-xs text-green-400 mb-1">+ {result()!.mods_added.length} mods added</p>
            </Show>
            <Show when={result()!.mods_removed.length > 0}>
              <p class="text-xs text-red-400 mb-1">- {result()!.mods_removed.length} mods removed</p>
            </Show>
            <Show when={result()!.configs_changed.length > 0}>
              <p class="text-xs text-blue-400 mb-1">{result()!.configs_changed.length} configs changed</p>
            </Show>
            <Show when={result()!.errors.length > 0}>
              <div class="mt-2 text-xs text-red-300">
                <p class="font-medium mb-1">Errors:</p>
                <For each={result()!.errors}>{(err) => <p>- {err}</p>}</For>
              </div>
            </Show>

            {/* Apply another patch button */}
            <button class="btn-secondary mt-4 w-full" onClick={handleReset}>
              <i class="i-hugeicons-add-01 w-4 h-4" />
              {t().modpackCompare?.patch?.applyAnother || "Apply Another Patch"}
            </button>
          </div>
        </Show>
      </Show>

      {/* ========== CREATE PATCH MODE ========== */}
      <Show when={mode() === "create"}>
        {/* Snapshot Info */}
        <div class="card bg-gray-alpha-30 p-4 space-y-3">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <i class="i-hugeicons-camera-01 w-5 h-5 text-green-400" />
              <span class="font-medium">{t().patches?.snapshot || "Snapshot"}</span>
            </div>
            <Show when={snapshot()}>
              <button
                class="btn-ghost text-xs text-red-400 hover:text-red-300"
                onClick={handleDeleteSnapshot}
              >
                <i class="i-hugeicons-delete-02 w-3 h-3" />
                {t().common.delete}
              </button>
            </Show>
          </div>

          <Show
            when={snapshot()}
            fallback={
              <div class="text-center py-4">
                <p class="text-sm text-muted mb-3">
                  {t().patches?.noSnapshot || "No snapshot exists. Create one to start tracking changes."}
                </p>
                <button
                  class="btn-secondary"
                  onClick={handleCreateSnapshot}
                  disabled={creatingSnapshot()}
                >
                  <Show when={creatingSnapshot()} fallback={<i class="i-hugeicons-camera-01 w-4 h-4" />}>
                    <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                  </Show>
                  {t().patches?.createSnapshot || "Create Snapshot"}
                </button>
              </div>
            }
          >
            <div class="space-y-2 text-sm">
              <div class="flex justify-between text-xs">
                <span class="text-muted">{t().patches?.snapshotCreated || "Created"}:</span>
                <span>{formatDate(snapshot()!.created_at)}</span>
              </div>
              <div class="flex justify-between text-xs">
                <span class="text-muted">{t().mods?.title || "Mods"}:</span>
                <span>{snapshot()!.mods.length}</span>
              </div>
              <div class="flex justify-between text-xs">
                <span class="text-muted">Configs:</span>
                <span>{snapshot()!.configs.length}</span>
              </div>
            </div>
          </Show>
        </div>

        {/* Detect Changes Button */}
        <Show when={snapshot()}>
          <button
            class="btn-secondary w-full"
            onClick={handleDetectChanges}
            disabled={detectingChanges()}
          >
            <Show when={detectingChanges()} fallback={<i class="i-hugeicons-search-01 w-4 h-4" />}>
              <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
            </Show>
            {t().patches?.detectChanges || "Detect Changes"}
          </button>
        </Show>

        {/* Changes Display */}
        <Show when={changes()}>
          <div class="card bg-gray-alpha-30 p-4 space-y-3">
            <div class="flex items-center gap-2">
              <i class={`w-5 h-5 ${changes()!.has_changes ? "i-hugeicons-edit-02 text-yellow-400" : "i-hugeicons-checkmark-circle-02 text-green-400"}`} />
              <span class="font-medium">
                {changes()!.has_changes
                  ? t().patches?.changesDetected || "Changes Detected"
                  : t().patches?.noChanges || "No Changes"}
              </span>
            </div>

            <Show when={changes()!.has_changes}>
              <div class="space-y-2">
                {/* Added Mods */}
                <Show when={changes()!.mods_added.length > 0}>
                  <div>
                    <p class="text-xs text-green-400 font-medium mb-1">
                      + {changes()!.mods_added.length} {t().patches?.modsAdded || "mods added"}
                    </p>
                    <div class="flex flex-wrap gap-1">
                      <For each={changes()!.mods_added.slice(0, 8)}>
                        {(mod) => (
                          <span class="px-2 py-0.5 bg-green-600/20 text-green-300 text-xs rounded truncate max-w-32">
                            {mod}
                          </span>
                        )}
                      </For>
                      <Show when={changes()!.mods_added.length > 8}>
                        <span class="px-2 py-0.5 bg-gray-600/20 text-gray-300 text-xs rounded">
                          +{changes()!.mods_added.length - 8}
                        </span>
                      </Show>
                    </div>
                  </div>
                </Show>

                {/* Removed Mods */}
                <Show when={changes()!.mods_removed.length > 0}>
                  <div>
                    <p class="text-xs text-red-400 font-medium mb-1">
                      - {changes()!.mods_removed.length} {t().patches?.modsRemoved || "mods removed"}
                    </p>
                    <div class="flex flex-wrap gap-1">
                      <For each={changes()!.mods_removed.slice(0, 8)}>
                        {(mod) => (
                          <span class="px-2 py-0.5 bg-red-600/20 text-red-300 text-xs rounded truncate max-w-32">
                            {mod}
                          </span>
                        )}
                      </For>
                      <Show when={changes()!.mods_removed.length > 8}>
                        <span class="px-2 py-0.5 bg-gray-600/20 text-gray-300 text-xs rounded">
                          +{changes()!.mods_removed.length - 8}
                        </span>
                      </Show>
                    </div>
                  </div>
                </Show>

                {/* Config Changes */}
                <Show when={changes()!.configs_added.length + changes()!.configs_changed.length + changes()!.configs_removed.length > 0}>
                  <div class="flex flex-wrap gap-2 text-xs">
                    <Show when={changes()!.configs_added.length > 0}>
                      <span class="px-2 py-1 bg-green-600/20 text-green-400 rounded">
                        +{changes()!.configs_added.length} configs
                      </span>
                    </Show>
                    <Show when={changes()!.configs_changed.length > 0}>
                      <span class="px-2 py-1 bg-yellow-600/20 text-yellow-400 rounded">
                        ~{changes()!.configs_changed.length} configs
                      </span>
                    </Show>
                    <Show when={changes()!.configs_removed.length > 0}>
                      <span class="px-2 py-1 bg-red-600/20 text-red-400 rounded">
                        -{changes()!.configs_removed.length} configs
                      </span>
                    </Show>
                  </div>
                </Show>
              </div>
            </Show>
          </div>
        </Show>

        {/* Create Patch Form */}
        <Show when={changes()?.has_changes}>
          <div class="card bg-gray-alpha-30 p-4 space-y-3">
            <h4 class="text-sm font-medium flex items-center gap-2">
              <i class="i-hugeicons-file-export w-4 h-4 text-green-400" />
              {t().patches?.createPatchTitle || "Create Patch File"}
            </h4>

            <div class="space-y-3">
              <div>
                <label class="block text-xs text-muted mb-1">
                  {t().patches?.description || "Description"} *
                </label>
                <input
                  type="text"
                  class="input w-full"
                  placeholder={t().patches?.descriptionPlaceholder || "e.g., Added optimization mods"}
                  value={patchDescription()}
                  onInput={(e) => setPatchDescription(e.currentTarget.value)}
                />
              </div>

              <div>
                <label class="block text-xs text-muted mb-1">
                  {t().patches?.author || "Author"} ({t().common.optional || "optional"})
                </label>
                <input
                  type="text"
                  class="input w-full"
                  placeholder={t().patches?.authorPlaceholder || "Your name"}
                  value={patchAuthor()}
                  onInput={(e) => setPatchAuthor(e.currentTarget.value)}
                />
              </div>

              <label class="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  class="w-4 h-4 rounded border-gray-600 bg-gray-800 text-green-500"
                  checked={includeConfigs()}
                  onChange={(e) => setIncludeConfigs(e.currentTarget.checked)}
                />
                <span class="text-sm">{t().patches?.includeConfigs || "Include config changes"}</span>
              </label>
            </div>

            <button
              class="btn-primary bg-green-600 hover:bg-green-700 w-full"
              onClick={handleCreatePatch}
              disabled={creatingPatch() || !patchDescription().trim()}
            >
              <Show when={creatingPatch()} fallback={<i class="i-hugeicons-file-export w-4 h-4" />}>
                <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
              </Show>
              {t().patches?.savePatch || "Save Patch"}
            </button>
          </div>
        </Show>

        {/* Success Message */}
        <Show when={createSuccess()}>
          <div class="p-3 bg-green-600/10 border border-green-600/30 rounded-xl flex items-start gap-2">
            <i class="i-hugeicons-checkmark-circle-02 w-4 h-4 text-green-400 flex-shrink-0 mt-0.5" />
            <div class="text-sm">
              <p class="text-green-300 font-medium">{t().patches?.patchSaved || "Patch saved successfully!"}</p>
              <p class="text-xs text-green-400/70 mt-1 break-all">{createSuccess()}</p>
            </div>
          </div>
        </Show>
      </Show>

      {/* Error Display */}
      <Show when={error()}>
        <div class="p-3 bg-red-600/10 border border-red-600/30 rounded-xl flex items-start gap-2">
          <i class="i-hugeicons-alert-circle w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
          <span class="text-sm text-red-300">{error()}</span>
        </div>
      </Show>
    </div>
  );
};

export default PatchesPanel;
