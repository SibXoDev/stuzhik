import { createSignal, Show, For, onMount, createEffect, type Component } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useI18n } from "../../../shared/i18n";
import { Select } from "../../../shared/ui/Select";
import { ModalWrapper } from "../../../shared/ui/ModalWrapper";
import type {
  Instance,
  ModpackPatch,
  PatchPreview,
  PatchApplyResult,
  PatchCompatibilityResult,
} from "../../../shared/types";

interface Props {
  onClose: () => void;
}

export const PatchApplyDialog: Component<Props> = (props) => {
  const { t } = useI18n();

  // State
  const [patch, setPatch] = createSignal<ModpackPatch | null>(null);
  const [patchPath, setPatchPath] = createSignal<string | null>(null);
  const [instances, setInstances] = createSignal<Instance[]>([]);
  const [selectedInstanceId, setSelectedInstanceId] = createSignal<string | null>(null);
  const [compatibility, setCompatibility] = createSignal<PatchCompatibilityResult | null>(null);
  const [preview, setPreview] = createSignal<PatchPreview | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [checkingCompatibility, setCheckingCompatibility] = createSignal(false);
  const [applying, setApplying] = createSignal(false);
  const [result, setResult] = createSignal<PatchApplyResult | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  // Load instances on mount
  onMount(async () => {
    try {
      const list = await invoke<Instance[]>("list_instances");
      setInstances(list.filter(i => i.status === "stopped"));
    } catch (e) {
      console.error("Failed to load instances:", e);
    }
  });

  // Check compatibility when instance or patch changes
  createEffect(async () => {
    const instanceId = selectedInstanceId();
    const currentPatch = patch();

    if (!instanceId || !currentPatch) {
      setCompatibility(null);
      return;
    }

    setCheckingCompatibility(true);
    try {
      const result = await invoke<PatchCompatibilityResult>("check_patch_compatibility", {
        patch: currentPatch,
        instanceId,
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
        path: filePath
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
    const instanceId = selectedInstanceId();
    const currentPatch = patch();

    if (!instanceId || !currentPatch) return;

    setLoading(true);
    setError(null);

    try {
      const previewResult = await invoke<PatchPreview>("preview_patch_application", {
        instanceId,
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
    const instanceId = selectedInstanceId();
    const currentPatch = patch();

    if (!instanceId || !currentPatch) return;

    setApplying(true);
    setError(null);

    try {
      const applyResult = await invoke<PatchApplyResult>("apply_modpack_patch", {
        instanceId,
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

  return (
    <ModalWrapper maxWidth="max-w-[600px]" backdrop onBackdropClick={props.onClose}>
      <div class="max-h-[80vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div class="flex items-center justify-between p-4 border-b border-gray-700">
          <div class="flex items-center gap-3">
            <i class="i-hugeicons-file-import w-6 h-6 text-cyan-400" />
            <h2 class="text-lg font-semibold">
              {t().modpackCompare.patch?.apply || "Apply Patch"}
            </h2>
          </div>
          <button
            class="btn-close"
            onClick={props.onClose}
          >
            <i class="i-hugeicons-cancel-01 w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div class="flex-1 overflow-y-auto p-4 space-y-4">
          {/* File Selection */}
          <div class="space-y-2">
            <label class="text-sm font-medium text-muted">
              {t().modpackCompare.patch?.selectFile || "Select patch file..."}
            </label>
            <div class="flex gap-2">
              <button
                class="btn-secondary flex-1 justify-start"
                onClick={handleSelectFile}
                disabled={loading()}
              >
                <i class="i-hugeicons-folder-01 w-4 h-4" />
                <span class="truncate">
                  {patchPath() ? patchPath()!.split(/[/\\]/).pop() : t().modpackCompare.selectFile}
                </span>
              </button>
            </div>
          </div>

          {/* Patch Info */}
          <Show when={patch()}>
            <div class="card bg-gray-alpha-30 p-4 space-y-3">
              <div class="flex items-center gap-2">
                <i class="i-hugeicons-file-01 w-5 h-5 text-cyan-400" />
                <span class="font-medium">{patch()!.base_modpack.name}</span>
              </div>
              <p class="text-sm text-muted">{patch()!.description}</p>
              <Show when={patch()!.author}>
                <p class="text-xs text-muted">
                  {t().modpackCompare.patch?.author || "Author"}: {patch()!.author}
                </p>
              </Show>
              <div class="flex flex-wrap gap-2 text-xs">
                <span class="px-2 py-1 bg-green-600/20 text-green-400 rounded">
                  +{patch()!.changes.mods_to_add.length} {t().modpackCompare.patch?.modsToAdd || "mods"}
                </span>
                <span class="px-2 py-1 bg-red-600/20 text-red-400 rounded">
                  -{patch()!.changes.mods_to_remove.length} {t().modpackCompare.patch?.modsToRemove || "mods"}
                </span>
                <Show when={patch()!.changes.configs_to_add.length > 0}>
                  <span class="px-2 py-1 bg-blue-600/20 text-blue-400 rounded">
                    {patch()!.changes.configs_to_add.length} configs
                  </span>
                </Show>
              </div>
            </div>
          </Show>

          {/* Instance Selection */}
          <Show when={patch()}>
            <div class="space-y-2">
              <label class="text-sm font-medium text-muted">
                {t().modpackCompare.selectInstance}
              </label>
              <Select
                value={selectedInstanceId() || ""}
                onChange={(val) => {
                  setSelectedInstanceId(val || null);
                  setPreview(null);
                  setResult(null);
                }}
                placeholder={t().modpackCompare.selectInstance}
                options={[
                  { value: "", label: t().modpackCompare.selectInstance },
                  ...instances().map(instance => ({
                    value: instance.id,
                    label: instance.name
                  }))
                ]}
              />
            </div>
          </Show>

          {/* Compatibility Check Result */}
          <Show when={compatibility() && !result()}>
            {(() => {
              const compat = compatibility()!;
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
                compatible: t().modpackCompare.patch?.compatibility?.compatible || "Compatible",
                compatible_with_warnings: t().modpackCompare.patch?.compatibility?.compatibleWithWarnings || "Compatible with warnings",
                incompatible: t().modpackCompare.patch?.compatibility?.incompatible || "Incompatible",
                already_applied: t().modpackCompare.patch?.compatibility?.alreadyApplied || "Already applied",
              };

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
              {t().modpackCompare.patch?.compatibility?.checking || "Checking compatibility..."}
            </div>
          </Show>

          {/* Preview Button - only show if compatible or compatible_with_warnings */}
          <Show when={patch() && selectedInstanceId() && !preview() && !result() && !checkingCompatibility() && compatibility() && (compatibility()!.status === "compatible" || compatibility()!.status === "compatible_with_warnings")}>
            <button
              class="btn-secondary w-full"
              onClick={handlePreview}
              disabled={loading()}
            >
              <Show when={loading()} fallback={
                <><i class="i-hugeicons-view w-4 h-4" /> {t().modpackCompare.patch?.preview || "Preview"}</>
              }>
                <i class="i-svg-spinners-6-dots-scale w-4 h-4" /> {t().common.loading}
              </Show>
            </button>
          </Show>

          {/* Preview Results */}
          <Show when={preview()}>
            <div class="space-y-3">
              <h3 class="text-sm font-semibold flex items-center gap-2">
                <i class="i-hugeicons-view w-4 h-4 text-cyan-400" />
                {t().modpackCompare.patch?.previewTitle || "Patch Preview"}
              </h3>

              {/* Mods to Add */}
              <Show when={preview()!.mods_to_add.length > 0}>
                <div class="space-y-1">
                  <p class="text-xs text-green-400 font-medium">
                    {t().modpackCompare.patch?.modsToAdd || "Mods to add"} ({preview()!.mods_to_add.length})
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
                    {t().modpackCompare.patch?.modsToRemove || "Mods to remove"} ({preview()!.mods_to_remove.length})
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
                    {t().modpackCompare.patch?.configsToChange || "Configs to change"} ({preview()!.configs_to_change.length})
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
                    {t().modpackCompare.patch?.warnings || "Warnings"}
                  </p>
                  <ul class="text-xs text-yellow-300 space-y-1">
                    <For each={preview()!.warnings}>
                      {(warning) => <li>- {warning}</li>}
                    </For>
                  </ul>
                </div>
              </Show>

              {/* Errors */}
              <Show when={preview()!.errors.length > 0}>
                <div class="p-3 bg-red-600/10 border border-red-600/30 rounded-xl">
                  <p class="text-xs text-red-400 font-medium mb-2">
                    <i class="i-hugeicons-alert-circle w-3 h-3 inline mr-1" />
                    {t().modpackCompare.patch?.errors || "Errors"}
                  </p>
                  <ul class="text-xs text-red-300 space-y-1">
                    <For each={preview()!.errors}>
                      {(err) => <li>- {err}</li>}
                    </For>
                  </ul>
                </div>
              </Show>
            </div>
          </Show>

          {/* Apply Result */}
          <Show when={result()}>
            <div class={`p-4 rounded-xl border ${
              result()!.success
                ? "bg-green-600/10 border-green-600/30"
                : "bg-red-600/10 border-red-600/30"
            }`}>
              <div class="flex items-center gap-2 mb-3">
                <i class={`w-5 h-5 ${
                  result()!.success
                    ? "i-hugeicons-checkmark-circle-02 text-green-400"
                    : "i-hugeicons-cancel-circle text-red-400"
                }`} />
                <span class="font-medium">
                  {result()!.success
                    ? t().modpackCompare.patch?.success || "Patch applied successfully"
                    : t().modpackCompare.patch?.failed || "Failed to apply patch"
                  }
                </span>
              </div>

              <Show when={result()!.mods_added.length > 0}>
                <p class="text-xs text-green-400 mb-1">
                  + {result()!.mods_added.length} mods added
                </p>
              </Show>
              <Show when={result()!.mods_removed.length > 0}>
                <p class="text-xs text-red-400 mb-1">
                  - {result()!.mods_removed.length} mods removed
                </p>
              </Show>
              <Show when={result()!.configs_changed.length > 0}>
                <p class="text-xs text-blue-400 mb-1">
                  {result()!.configs_changed.length} configs changed
                </p>
              </Show>
              <Show when={result()!.errors.length > 0}>
                <div class="mt-2 text-xs text-red-300">
                  <p class="font-medium mb-1">Errors:</p>
                  <For each={result()!.errors}>
                    {(err) => <p>- {err}</p>}
                  </For>
                </div>
              </Show>
            </div>
          </Show>

          {/* Error Display */}
          <Show when={error()}>
            <div class="p-3 bg-red-600/10 border border-red-600/30 rounded-xl flex items-start gap-2">
              <i class="i-hugeicons-alert-circle w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
              <span class="text-sm text-red-300">{error()}</span>
            </div>
          </Show>
        </div>

        {/* Footer */}
        <div class="flex justify-end gap-2 p-4 border-t border-gray-700">
          <button class="btn-secondary" onClick={props.onClose}>
            {t().common.close}
          </button>
          <Show when={preview() && !result()}>
            <button
              class="btn-primary bg-cyan-600 hover:bg-cyan-700"
              onClick={handleApply}
              disabled={applying() || preview()!.errors.length > 0}
            >
              <Show when={applying()} fallback={
                <><i class="i-hugeicons-play w-4 h-4" /> {t().modpackCompare.patch?.apply || "Apply Patch"}</>
              }>
                <i class="i-svg-spinners-6-dots-scale w-4 h-4" /> {t().modpackCompare.patch?.applying || "Applying..."}
              </Show>
            </button>
          </Show>
        </div>
      </div>
    </ModalWrapper>
  );
};

export default PatchApplyDialog;
