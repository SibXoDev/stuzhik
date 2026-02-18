import { For, Show, createSignal, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { MetadataFile, PackMcmeta, PackFormatInfo, ModsToml, FabricModJson } from "../../../shared/types";
import { PACK_FORMATS } from "../../../shared/types";
import { ModalWrapper, Select } from "../../../shared/ui";
import { addToast } from "../../../shared/components/Toast";
import { useI18n } from "../../../shared/i18n";

interface MetadataEditorProps {
  instanceId: string;
  onClose: () => void;
}

export function MetadataEditor(props: MetadataEditorProps) {
  const { t } = useI18n();
  const [metadataFiles, setMetadataFiles] = createSignal<MetadataFile[]>([]);
  const [selectedFile, setSelectedFile] = createSignal<MetadataFile | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [saving, setSaving] = createSignal(false);
  const [showCreatePack, setShowCreatePack] = createSignal(false);

  // Local edit state for pack.mcmeta
  const [editPackFormat, setEditPackFormat] = createSignal(15);
  const [editDescription, setEditDescription] = createSignal("");

  // Load metadata files
  const loadMetadataFiles = async () => {
    setLoading(true);
    try {
      const files = await invoke<MetadataFile[]>("detect_metadata_files", {
        instanceId: props.instanceId,
      });
      setMetadataFiles(files);
      if (files.length > 0) {
        selectFile(files[0]);
      }
    } catch (e) {
      if (import.meta.env.DEV) {
        console.error("Failed to load metadata files:", e);
      }
      addToast({
        type: "error",
        title: t().editor?.metadataEditor?.toast?.failedToLoad || "Failed to load metadata",
        message: String(e),
        duration: 5000,
      });
    } finally {
      setLoading(false);
    }
  };

  onMount(() => {
    loadMetadataFiles();
  });

  // Select a file for editing
  const selectFile = (file: MetadataFile) => {
    setSelectedFile(file);

    if (file.type === "pack_mcmeta") {
      setEditPackFormat(file.data.pack.pack_format);
      setEditDescription(file.data.pack.description);
    }
  };

  // Save current file
  const saveFile = async () => {
    const file = selectedFile();
    if (!file) return;

    setSaving(true);
    try {
      let updatedFile: MetadataFile;

      if (file.type === "pack_mcmeta") {
        updatedFile = {
          type: "pack_mcmeta",
          path: file.path,
          data: {
            ...file.data,
            pack: {
              ...file.data.pack,
              pack_format: editPackFormat(),
              description: editDescription(),
            },
          },
        };
      } else {
        updatedFile = file;
      }

      await invoke("save_metadata_file", {
        instanceId: props.instanceId,
        metadata: updatedFile,
      });

      // Update local state
      setMetadataFiles((files) =>
        files.map((f) => (f.path === file.path ? updatedFile : f))
      );
      setSelectedFile(updatedFile);

      addToast({
        type: "success",
        title: t().editor?.metadataEditor?.toast?.saved || "Saved",
        message: (t().editor?.metadataEditor?.toast?.savedMessage || "{file} saved").replace("{file}", file.path.split("/").pop() || ""),
        duration: 2000,
      });
    } catch (e) {
      if (import.meta.env.DEV) {
        console.error("Failed to save:", e);
      }
      addToast({
        type: "error",
        title: t().editor?.metadataEditor?.toast?.failedToSave || "Failed to save",
        message: String(e),
        duration: 5000,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalWrapper maxWidth="max-w-4xl" backdrop onBackdropClick={props.onClose}>
      {/* Header */}
      <div class="flex items-center justify-between p-4 border-b border-gray-700">
        <h2 class="text-lg font-semibold">{t().editor?.metadataEditor?.title || "Metadata Editor"}</h2>
        <button
          class="p-1.5 rounded-lg hover:bg-gray-700 text-gray-400 hover:text-white"
          onClick={props.onClose}
        >
          <i class="i-hugeicons-cancel-01 w-5 h-5" />
        </button>
      </div>
      <div class="flex gap-4 min-h-[400px]">
        {/* Sidebar - File list */}
        <div class="w-56 flex-shrink-0 border-r border-gray-700 pr-4 flex flex-col gap-3">
          <div class="flex items-center justify-between">
            <span class="text-sm font-medium">{t().editor?.metadataEditor?.metadataFiles || "Metadata Files"}</span>
            <button
              class="p-1 rounded hover:bg-gray-700"
              onClick={() => setShowCreatePack(true)}
              title={t().editor?.metadataEditor?.createPackMcmeta || "Create pack.mcmeta"}
            >
              <i class="i-hugeicons-add-01 w-4 h-4 text-green-400" />
            </button>
          </div>

          <Show when={loading()}>
            <div class="flex-center py-8">
              <i class="i-svg-spinners-6-dots-scale w-6 h-6" />
            </div>
          </Show>

          <Show when={!loading() && metadataFiles().length === 0}>
            <div class="flex flex-col items-center py-8 text-gray-500 text-sm gap-2">
              <i class="i-hugeicons-file-search w-8 h-8" />
              <p>{t().editor?.metadataEditor?.noFilesFound || "No metadata files found"}</p>
              <button
                class="btn-primary btn-sm mt-2"
                onClick={() => setShowCreatePack(true)}
              >
                {t().editor?.metadataEditor?.createPackMcmeta || "Create pack.mcmeta"}
              </button>
            </div>
          </Show>

          <div class="space-y-1">
            <For each={metadataFiles()}>
              {(file) => (
                <button
                  class={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                    selectedFile()?.path === file.path
                      ? "bg-[var(--color-primary-bg)] border border-[var(--color-primary-border)]"
                      : "hover:bg-gray-800"
                  }`}
                  onClick={() => selectFile(file)}
                >
                  <div class="flex items-center gap-2">
                    <i
                      class={`w-4 h-4 ${
                        file.type === "pack_mcmeta"
                          ? "i-hugeicons-package text-purple-400"
                          : file.type === "mods_toml"
                          ? "i-hugeicons-settings-02 text-orange-400"
                          : "i-hugeicons-code-square text-blue-400"
                      }`}
                    />
                    <span class="truncate">{file.path.split("/").pop()}</span>
                  </div>
                  <div class="text-xs text-gray-500 truncate mt-0.5">
                    {file.path}
                  </div>
                </button>
              )}
            </For>
          </div>
        </div>

        {/* Main content - Editor */}
        <div class="flex-1">
          <Show
            when={selectedFile()}
            fallback={
              <div class="flex-center h-full text-gray-500">
                <div class="flex flex-col items-center gap-3">
                  <i class="i-hugeicons-file-edit w-12 h-12" />
                  <p>{t().editor?.metadataEditor?.selectFileToEdit || "Select a file to edit"}</p>
                </div>
              </div>
            }
          >
            {(file) => (
              <div class="space-y-4">
                {/* pack.mcmeta editor */}
                <Show when={file().type === "pack_mcmeta"}>
                  <PackMcmetaEditor
                    data={(file() as Extract<MetadataFile, { type: "pack_mcmeta" }>).data}
                    packFormat={editPackFormat()}
                    description={editDescription()}
                    onPackFormatChange={setEditPackFormat}
                    onDescriptionChange={setEditDescription}
                  />
                </Show>

                {/* mods.toml editor */}
                <Show when={file().type === "mods_toml"}>
                  <ModsTomlViewer
                    data={(file() as Extract<MetadataFile, { type: "mods_toml" }>).data}
                  />
                </Show>

                {/* fabric.mod.json editor */}
                <Show when={file().type === "fabric_mod_json"}>
                  <FabricModJsonViewer
                    data={(file() as Extract<MetadataFile, { type: "fabric_mod_json" }>).data}
                  />
                </Show>
              </div>
            )}
          </Show>
        </div>
      </div>

      {/* Actions */}
      <div class="flex justify-end gap-3 mt-6 pt-4 border-t border-gray-700">
        <button class="btn-secondary" onClick={props.onClose}>
          {t().editor?.metadataEditor?.close || "Close"}
        </button>
        <Show when={selectedFile()}>
          <button
            class="btn-primary"
            onClick={saveFile}
            disabled={saving()}
          >
            <Show when={saving()} fallback={t().editor?.metadataEditor?.save || "Save"}>
              <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
              {t().editor?.metadataEditor?.saving || "Saving..."}
            </Show>
          </button>
        </Show>
      </div>

      {/* Create pack.mcmeta modal */}
      <Show when={showCreatePack()}>
        <CreatePackMcmetaDialog
          instanceId={props.instanceId}
          onClose={() => setShowCreatePack(false)}
          onCreated={() => {
            setShowCreatePack(false);
            loadMetadataFiles();
          }}
        />
      </Show>
    </ModalWrapper>
  );
}

// Pack.mcmeta editor component
interface PackMcmetaEditorProps {
  data: PackMcmeta;
  packFormat: number;
  description: string;
  onPackFormatChange: (format: number) => void;
  onDescriptionChange: (desc: string) => void;
}

function PackMcmetaEditor(props: PackMcmetaEditorProps) {
  const { t } = useI18n();
  const formatInfo = (): PackFormatInfo | undefined => {
    return PACK_FORMATS.find((p) => p.format === props.packFormat);
  };

  return (
    <div class="space-y-4">
      <div class="flex items-center gap-3 p-3 bg-purple-900/20 border border-purple-500/30 rounded-lg">
        <i class="i-hugeicons-package w-8 h-8 text-purple-400" />
        <div>
          <div class="font-medium">{t().editor?.metadataEditor?.packMetadata || "Pack Metadata"}</div>
          <div class="text-sm text-gray-400">pack.mcmeta</div>
        </div>
      </div>

      {/* Pack Format */}
      <div class="flex flex-col gap-2">
        <label class="block text-sm font-medium">{t().editor?.metadataEditor?.packFormat || "Pack Format"}</label>
        <Select
          value={String(props.packFormat)}
          onChange={(v) => props.onPackFormatChange(parseInt(v))}
          options={[
            { value: "4", label: "4 (1.13 - 1.14.4)" },
            { value: "5", label: "5 (1.15 - 1.16.1)" },
            { value: "6", label: "6 (1.16.2 - 1.16.5)" },
            { value: "7", label: "7 (1.17 - 1.17.1)" },
            { value: "8", label: "8 (1.18 - 1.18.2)" },
            { value: "9", label: "9 (1.19 - 1.19.2)" },
            { value: "10", label: "10 (1.19.3)" },
            { value: "12", label: "12 (1.19.4)" },
            { value: "15", label: "15 (1.20.1 - 1.20.2)" },
            { value: "18", label: "18 (1.20.3 - 1.20.4)" },
            { value: "26", label: "26 (1.20.5 - 1.20.6)" },
            { value: "34", label: "34 (1.21 - 1.21.1)" },
            { value: "42", label: "42 (1.21.2 - 1.21.3)" },
            { value: "46", label: "46 (1.21.4+)" },
          ]}
        />
        <Show when={formatInfo()}>
          <p class="text-xs text-gray-500">
            {(t().editor?.metadataEditor?.compatibleWith || "Compatible with Minecraft {versions}").replace("{versions}", formatInfo()?.versions || "")}
          </p>
        </Show>
      </div>

      {/* Description */}
      <div class="flex flex-col gap-2">
        <label class="block text-sm font-medium">{t().editor?.metadataEditor?.description || "Description"}</label>
        <textarea
          value={props.description}
          onInput={(e) => props.onDescriptionChange(e.currentTarget.value)}
          rows={3}
          class="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg focus:outline-none focus:border-[var(--color-primary)] resize-none"
          placeholder={t().editor?.metadataEditor?.descriptionPlaceholder || "Pack description..."}
        />
        <p class="text-xs text-gray-500">
          {t().editor?.metadataEditor?.formattingHint || "Supports Minecraft formatting codes (e.g., §c for red)"}
        </p>
      </div>

      {/* Supported Formats */}
      <Show when={props.data.pack.supported_formats}>
        <div class="p-3 bg-gray-800 rounded-lg flex flex-col gap-2">
          <div class="text-sm font-medium">{t().editor?.metadataEditor?.supportedFormats || "Supported Formats"}</div>
          <code class="text-xs text-blue-400">
            {JSON.stringify(props.data.pack.supported_formats)}
          </code>
        </div>
      </Show>

      {/* Filter */}
      <Show when={props.data.filter}>
        <div class="p-3 bg-gray-800 rounded-lg flex flex-col gap-2">
          <div class="text-sm font-medium">{t().editor?.metadataEditor?.filters || "Filters"}</div>
          <code class="text-xs text-gray-400">
            {JSON.stringify(props.data.filter, null, 2)}
          </code>
        </div>
      </Show>
    </div>
  );
}

// Mods.toml viewer (read-only)
interface ModsTomlViewerProps {
  data: ModsToml;
}

function ModsTomlViewer(props: ModsTomlViewerProps) {
  const { t } = useI18n();
  return (
    <div class="space-y-4">
      <div class="flex items-center gap-3 p-3 bg-orange-900/20 border border-orange-500/30 rounded-lg">
        <i class="i-hugeicons-settings-02 w-8 h-8 text-orange-400" />
        <div>
          <div class="font-medium">{t().editor?.metadataEditor?.forgeModMetadata || "Forge/NeoForge Mod Metadata"}</div>
          <div class="text-sm text-gray-400">mods.toml</div>
        </div>
      </div>

      <div class="grid gap-4">
        <div class="p-3 bg-gray-800 rounded-lg flex flex-col gap-2">
          <div class="text-sm font-medium">{t().editor?.metadataEditor?.modLoader || "Mod Loader"}</div>
          <div class="text-gray-300">{props.data.mod_loader}</div>
        </div>

        <div class="p-3 bg-gray-800 rounded-lg flex flex-col gap-2">
          <div class="text-sm font-medium">{t().editor?.metadataEditor?.loaderVersion || "Loader Version"}</div>
          <div class="text-gray-300">{props.data.loader_version}</div>
        </div>

        <div class="p-3 bg-gray-800 rounded-lg flex flex-col gap-2">
          <div class="text-sm font-medium">{t().editor?.metadataEditor?.license || "License"}</div>
          <div class="text-gray-300">{props.data.license}</div>
        </div>

        <Show when={props.data.mods?.length > 0}>
          <div class="p-3 bg-gray-800 rounded-lg flex flex-col gap-2">
            <div class="text-sm font-medium">{t().editor?.metadataEditor?.mods || "Mods"} ({props.data.mods.length})</div>
            <For each={props.data.mods}>
              {(mod) => (
                <div class="p-2 bg-gray-750 rounded">
                  <div class="font-medium">{mod.display_name}</div>
                  <div class="text-xs text-gray-400">{mod.mod_id} v{mod.version}</div>
                  <Show when={mod.description}>
                    <div class="text-sm text-gray-500 mt-1">{mod.description}</div>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>

      <div class="p-3 bg-yellow-900/20 border border-yellow-500/30 rounded-lg text-sm text-yellow-300 flex items-center gap-1">
        <i class="i-hugeicons-information-circle w-4 h-4 flex-shrink-0" />
        <span>{t().editor?.metadataEditor?.modsTomlReadOnly || "mods.toml editing is read-only. Use the source editor for changes."}</span>
      </div>
    </div>
  );
}

// Fabric mod.json viewer (read-only)
interface FabricModJsonViewerProps {
  data: FabricModJson;
}

function FabricModJsonViewer(props: FabricModJsonViewerProps) {
  const { t } = useI18n();
  return (
    <div class="space-y-4">
      <div class="flex items-center gap-3 p-3 bg-blue-900/20 border border-blue-500/30 rounded-lg">
        <i class="i-hugeicons-code-square w-8 h-8 text-blue-400" />
        <div>
          <div class="font-medium">{t().editor?.metadataEditor?.fabricModMetadata || "Fabric Mod Metadata"}</div>
          <div class="text-sm text-gray-400">fabric.mod.json</div>
        </div>
      </div>

      <div class="grid gap-4">
        <div class="grid grid-cols-2 gap-4">
          <div class="p-3 bg-gray-800 rounded-lg flex flex-col gap-1">
            <div class="text-sm font-medium">{t().editor?.metadataEditor?.modId || "Mod ID"}</div>
            <div class="text-gray-300 font-mono">{props.data.id}</div>
          </div>
          <div class="p-3 bg-gray-800 rounded-lg flex flex-col gap-1">
            <div class="text-sm font-medium">{t().editor?.metadataEditor?.version || "Version"}</div>
            <div class="text-gray-300">{props.data.version}</div>
          </div>
        </div>

        <Show when={props.data.name}>
          <div class="p-3 bg-gray-800 rounded-lg flex flex-col gap-1">
            <div class="text-sm font-medium">{t().editor?.metadataEditor?.name || "Name"}</div>
            <div class="text-gray-300">{props.data.name}</div>
          </div>
        </Show>

        <Show when={props.data.description}>
          <div class="p-3 bg-gray-800 rounded-lg flex flex-col gap-1">
            <div class="text-sm font-medium">{t().editor?.metadataEditor?.description || "Description"}</div>
            <div class="text-gray-300">{props.data.description}</div>
          </div>
        </Show>

        <Show when={props.data.authors && props.data.authors.length > 0}>
          <div class="p-3 bg-gray-800 rounded-lg flex flex-col gap-1">
            <div class="text-sm font-medium">{t().editor?.metadataEditor?.authors || "Authors"}</div>
            <div class="flex flex-wrap gap-2">
              <For each={props.data.authors}>
                {(author) => (
                  <span class="px-2 py-1 bg-gray-700 rounded text-sm">
                    {typeof author === "string" ? author : author.name}
                  </span>
                )}
              </For>
            </div>
          </div>
        </Show>

        <Show when={props.data.depends && Object.keys(props.data.depends).length > 0}>
          <div class="p-3 bg-gray-800 rounded-lg flex flex-col gap-2">
            <div class="text-sm font-medium">{t().editor?.metadataEditor?.dependencies || "Dependencies"}</div>
            <div class="space-y-1">
              <For each={Object.entries(props.data.depends || {})}>
                {([id, version]) => (
                  <div class="flex justify-between text-sm">
                    <span class="font-mono text-gray-300">{id}</span>
                    <span class="text-gray-500">{String(version)}</span>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>

        <Show when={props.data.environment}>
          <div class="p-3 bg-gray-800 rounded-lg flex flex-col gap-1">
            <div class="text-sm font-medium">{t().editor?.metadataEditor?.environment || "Environment"}</div>
            <div class="text-gray-300 capitalize">{props.data.environment}</div>
          </div>
        </Show>
      </div>

      <div class="p-3 bg-yellow-900/20 border border-yellow-500/30 rounded-lg text-sm text-yellow-300 flex items-center gap-1">
        <i class="i-hugeicons-information-circle w-4 h-4 flex-shrink-0" />
        <span>{t().editor?.metadataEditor?.fabricReadOnly || "fabric.mod.json editing is read-only. Use the source editor for changes."}</span>
      </div>
    </div>
  );
}

// Create pack.mcmeta dialog
interface CreatePackMcmetaDialogProps {
  instanceId: string;
  onClose: () => void;
  onCreated: () => void;
}

function CreatePackMcmetaDialog(props: CreatePackMcmetaDialogProps) {
  const { t } = useI18n();
  const [packPath, setPackPath] = createSignal("kubejs");
  const [packFormat, setPackFormat] = createSignal(15);
  const [description, setDescription] = createSignal("");
  const [creating, setCreating] = createSignal(false);

  const handleCreate = async () => {
    setCreating(true);
    try {
      await invoke("create_pack_mcmeta", {
        instanceId: props.instanceId,
        packPath: packPath(),
        packFormat: packFormat(),
        description: description().trim() || t().editor?.metadataEditor?.defaultDescription || "A custom pack",
      });

      addToast({
        type: "success",
        title: t().editor?.metadataEditor?.toast?.created || "Created",
        message: t().editor?.metadataEditor?.toast?.createdMessage || "pack.mcmeta created successfully",
        duration: 2000,
      });

      props.onCreated();
    } catch (e) {
      if (import.meta.env.DEV) {
        console.error("Failed to create:", e);
      }
      addToast({
        type: "error",
        title: t().editor?.metadataEditor?.toast?.failedToCreate || "Failed to create",
        message: String(e),
        duration: 5000,
      });
    } finally {
      setCreating(false);
    }
  };

  return (
    <ModalWrapper backdrop onBackdropClick={props.onClose}>
      {/* Header */}
      <div class="flex items-center justify-between p-4 border-b border-gray-700">
        <h2 class="text-lg font-semibold">{t().editor?.metadataEditor?.createPackMcmeta || "Create pack.mcmeta"}</h2>
        <button
          class="p-1.5 rounded-lg hover:bg-gray-700 text-gray-400 hover:text-white"
          onClick={props.onClose}
        >
          <i class="i-hugeicons-cancel-01 w-5 h-5" />
        </button>
      </div>
      <div class="p-4 space-y-4">
        <div>
          <label class="block text-sm font-medium mb-2">{t().editor?.metadataEditor?.location || "Location"}</label>
          <Select
            value={packPath()}
            onChange={setPackPath}
            options={[
              { value: "kubejs", label: "kubejs/" },
              { value: "resourcepacks/custom", label: "resourcepacks/custom/" },
              { value: "datapacks/custom", label: "datapacks/custom/" },
            ]}
          />
        </div>

        <div>
          <label class="block text-sm font-medium mb-2">{t().editor?.metadataEditor?.packFormat || "Pack Format"}</label>
          <Select
            value={String(packFormat())}
            onChange={(v) => setPackFormat(parseInt(v))}
            options={[
              { value: "15", label: "15 (1.20.1 - 1.20.2)" },
              { value: "18", label: "18 (1.20.3 - 1.20.4)" },
              { value: "26", label: "26 (1.20.5 - 1.20.6)" },
              { value: "34", label: "34 (1.21 - 1.21.1)" },
              { value: "42", label: "42 (1.21.2 - 1.21.3)" },
              { value: "46", label: "46 (1.21.4+)" },
            ]}
          />
        </div>

        <div>
          <label class="block text-sm font-medium mb-2">{t().editor?.metadataEditor?.description || "Description"}</label>
          <input
            type="text"
            value={description()}
            onInput={(e) => setDescription(e.currentTarget.value)}
            class="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg"
            placeholder={t().editor?.metadataEditor?.descriptionPlaceholder || "Pack description..."}
          />
        </div>

        <div class="flex justify-end gap-3 pt-4">
          <button class="btn-secondary" onClick={props.onClose}>
            {t().editor?.metadataEditor?.cancel || "Cancel"}
          </button>
          <button
            class="btn-primary"
            onClick={handleCreate}
            disabled={creating()}
          >
            <Show when={creating()} fallback={t().editor?.metadataEditor?.create || "Create"}>
              <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
            </Show>
          </button>
        </div>
      </div>
    </ModalWrapper>
  );
}
