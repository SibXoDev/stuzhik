import { createSignal, For, Show } from "solid-js";
import { save, open } from "@tauri-apps/plugin-dialog";
import { writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";
import { useI18n } from "../../../shared/i18n";
import { createConfirmDialog } from "../../../shared/components/ConfirmDialog";
import { useCollections, COLLECTION_COLORS, COLLECTION_ICONS, getCollectionIconUrl } from "../hooks/useCollections";
import type {
  ModCollection,
  CollectionWithMods,
  ExportedCollection,
  Instance,
} from "../../../shared/types/common.types";

interface CollectionsPanelProps {
  /** Current instance for installation */
  instance?: Instance;
  /** Callback when a collection is installed */
  onCollectionInstalled?: () => void;
  /** Callback to close the panel */
  onClose?: () => void;
}

export function CollectionsPanel(props: CollectionsPanelProps) {
  const { t } = useI18n();
  const { confirm, ConfirmDialogComponent } = createConfirmDialog();
  const collections = useCollections();

  // State
  const [selectedCollection, setSelectedCollection] = createSignal<CollectionWithMods | null>(null);
  const [showCreateDialog, setShowCreateDialog] = createSignal(false);
  const [showEditDialog, setShowEditDialog] = createSignal(false);
  const [installing, setInstalling] = createSignal(false);
  const [installResult, setInstallResult] = createSignal<{
    installed: number;
    failed: number;
    skipped: number;
  } | null>(null);

  // Create dialog state
  const [newName, setNewName] = createSignal("");
  const [newDescription, setNewDescription] = createSignal("");
  const [newColor, setNewColor] = createSignal(COLLECTION_COLORS[0]);
  const [newIcon, setNewIcon] = createSignal(COLLECTION_ICONS[0]);

  // Select a collection and load its mods
  async function selectCollection(collection: ModCollection) {
    const full = await collections.getCollectionWithMods(collection.id);
    if (full) {
      setSelectedCollection(full);
    }
  }

  // Create a new collection
  async function handleCreate() {
    if (!newName().trim()) return;

    await collections.createCollection({
      name: newName().trim(),
      description: newDescription().trim() || null,
      color: newColor(),
      icon: newIcon(),
    });

    setShowCreateDialog(false);
    resetCreateForm();
  }

  // Update selected collection
  async function handleUpdate() {
    const selected = selectedCollection();
    if (!selected || !newName().trim()) return;

    await collections.updateCollection(selected.id, {
      name: newName().trim(),
      description: newDescription().trim() || null,
      color: newColor(),
      icon: newIcon(),
    });

    // Reload
    const updated = await collections.getCollectionWithMods(selected.id);
    if (updated) {
      setSelectedCollection(updated);
    }

    setShowEditDialog(false);
  }

  // Delete selected collection
  async function handleDelete() {
    const selected = selectedCollection();
    if (!selected || selected.is_builtin) return;

    const confirmed = await confirm({
      title: t().collections?.deleteTitle ?? "Delete Collection",
      message: t().collections?.confirmDelete?.replace("{name}", selected.name) ??
        `Delete collection "${selected.name}"?`,
      variant: "danger",
      confirmText: t().common.delete,
      cancelText: t().common.cancel,
    });
    if (!confirmed) return;

    await collections.deleteCollection(selected.id);
    setSelectedCollection(null);
  }

  // Duplicate collection
  async function handleDuplicate() {
    const selected = selectedCollection();
    if (!selected) return;

    const newColl = await collections.duplicateCollection(selected.id);
    if (newColl) {
      const full = await collections.getCollectionWithMods(newColl.id);
      if (full) setSelectedCollection(full);
    }
  }

  // Install collection to instance
  async function handleInstall() {
    const selected = selectedCollection();
    const instance = props.instance;
    if (!selected || !instance) return;

    setInstalling(true);
    setInstallResult(null);

    try {
      const result = await collections.installCollection(
        selected.id,
        instance.id,
        instance.version,
        instance.loader
      );

      if (result) {
        setInstallResult({
          installed: result.installed.length,
          failed: result.failed.length,
          skipped: result.skipped.length,
        });
        props.onCollectionInstalled?.();
      }
    } finally {
      setInstalling(false);
    }
  }

  // Export collection
  async function handleExport() {
    const selected = selectedCollection();
    if (!selected) return;

    const exported = await collections.exportCollection(selected.id);
    if (!exported) return;

    const path = await save({
      defaultPath: `${selected.name.replace(/[^a-zA-Z0-9]/g, "_")}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });

    if (path) {
      await writeTextFile(path, JSON.stringify(exported, null, 2));
    }
  }

  // Import collection
  async function handleImport() {
    const path = await open({
      filters: [{ name: "JSON", extensions: ["json"] }],
    });

    if (path && typeof path === "string") {
      const content = await readTextFile(path);
      const exported: ExportedCollection = JSON.parse(content);
      await collections.importCollection(exported);
    }
  }

  // Open edit dialog for selected collection
  function openEditDialog() {
    const selected = selectedCollection();
    if (!selected || selected.is_builtin) return;

    setNewName(selected.name);
    setNewDescription(selected.description ?? "");
    setNewColor(selected.color);
    setNewIcon(selected.icon);
    setShowEditDialog(true);
  }

  // Reset create form
  function resetCreateForm() {
    setNewName("");
    setNewDescription("");
    setNewColor(COLLECTION_COLORS[0]);
    setNewIcon(COLLECTION_ICONS[0]);
  }

  return (
    <div class="flex flex-col gap-4">
      {/* Header */}
      <div class="flex items-center justify-between">
        <h2 class="text-lg font-semibold">
          {t().collections?.title ?? "Mod Collections"}
        </h2>
        <div class="flex gap-2">
          <button
            class="btn-secondary text-sm"
            onClick={handleImport}
          >
            <i class="i-hugeicons-upload-02 w-4 h-4" />
            {t().collections?.import ?? "Import"}
          </button>
          <button
            class="btn-primary text-sm"
            onClick={() => setShowCreateDialog(true)}
          >
            <i class="i-hugeicons-add-01 w-4 h-4" />
            {t().collections?.create ?? "Create"}
          </button>
          <Show when={props.onClose}>
            <button
              class="btn-ghost text-sm"
              onClick={props.onClose}
            >
              <i class="i-hugeicons-cancel-01 w-4 h-4" />
            </button>
          </Show>
        </div>
      </div>

      <div class="grid grid-cols-[280px_1fr] gap-6">
        {/* Collections List */}
        <div class="flex flex-col gap-2">
          <Show
            when={!collections.loading()}
            fallback={
              <div class="p-4 text-center text-gray-500">
                {t().common?.loading ?? "Loading..."}
              </div>
            }
          >
            <For each={collections.collections()}>
              {(collection) => (
                <button
                  class={`w-full aspect-[16/9] bg-cover bg-center text-left transition-all overflow-hidden p-0 hover:brightness-110 rounded-xl ${
                    selectedCollection()?.id === collection.id ? "ring-2 ring-[var(--color-primary)]" : ""
                  }`}
                  style={{
                    "background-image": `url(${getCollectionIconUrl(collection.icon)})`,
                  }}
                  onClick={() => selectCollection(collection)}
                >
                  <div class="w-full h-full bg-gradient-to-t from-black/80 via-black/30 to-transparent flex flex-col justify-end p-3">
                    <div class="font-semibold truncate text-white drop-shadow-md">{collection.name}</div>
                    <div class="text-xs text-gray-300 inline-flex items-center gap-1">
                      {collection.mod_count} {t().collections?.mods ?? "mods"}
                      {collection.is_builtin && (
                        <span class="text-blue-300">
                          • {t().collections?.builtin ?? "built-in"}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              )}
            </For>
          </Show>
        </div>

        {/* Collection Details */}
        <div>
          <Show
            when={selectedCollection()}
            fallback={
              <div class="flex items-center justify-center py-12 text-gray-500">
                <div class="flex flex-col items-center gap-2 text-center">
                  <i class="i-hugeicons-folder-add w-12 h-12 opacity-50" />
                  <p>{t().collections?.selectCollection ?? "Select a collection"}</p>
                </div>
              </div>
            }
          >
            {(selected) => (
              <div class="flex flex-col gap-4">
                {/* Collection Header - full width banner */}
                <div
                  class="aspect-[21/9] rounded-2xl bg-cover bg-center overflow-hidden"
                  style={{
                    "background-image": `url(${getCollectionIconUrl(selected().icon)})`,
                  }}
                >
                  <div class="w-full h-full bg-gradient-to-t from-black/90 via-black/40 to-transparent flex flex-col justify-end p-4">
                    <div class="flex items-end justify-between">
                      <div class="flex flex-col gap-1">
                        <h3 class="text-2xl font-bold text-white drop-shadow-lg">{selected().name}</h3>
                        <Show when={selected().description}>
                          <p class="text-gray-200 text-sm">{selected().description}</p>
                        </Show>
                      </div>
                      <div class="flex gap-1">
                        <Show when={!selected().is_builtin}>
                          <button
                            class="btn-ghost text-sm bg-white/10 hover:bg-white/20 text-white"
                            onClick={openEditDialog}
                            title={t().common?.edit ?? "Edit"}
                          >
                            <i class="i-hugeicons-edit-02 w-4 h-4" />
                          </button>
                          <button
                            class="btn-ghost text-sm bg-white/10 hover:bg-red-500/50 text-white"
                            onClick={handleDelete}
                            title={t().common?.delete ?? "Delete"}
                          >
                            <i class="i-hugeicons-delete-02 w-4 h-4" />
                          </button>
                        </Show>
                        <button
                          class="btn-ghost text-sm bg-white/10 hover:bg-white/20 text-white"
                          onClick={handleDuplicate}
                          title={t().collections?.duplicate ?? "Duplicate"}
                        >
                          <i class="i-hugeicons-copy-01 w-4 h-4" />
                        </button>
                        <button
                          class="btn-ghost text-sm bg-white/10 hover:bg-white/20 text-white"
                          onClick={handleExport}
                          title={t().collections?.export ?? "Export"}
                        >
                          <i class="i-hugeicons-download-02 w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Install Button */}
                <Show when={props.instance}>
                  <div class="p-3 bg-gray-800 rounded-xl">
                    <div class="flex items-center justify-between">
                      <div>
                        <div class="font-medium">
                          {t().collections?.installTo ?? "Install to"}: {props.instance?.name}
                        </div>
                        <div class="text-sm text-gray-400">
                          {selected().mod_count} {t().collections?.modsWillBeInstalled ?? "mods will be installed"}
                        </div>
                      </div>
                      <button
                        class="btn-primary"
                        onClick={handleInstall}
                        disabled={installing() || selected().mod_count === 0}
                      >
                        <Show
                          when={!installing()}
                          fallback={
                            <span class="flex items-center gap-2">
                              <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                              {t().collections?.installing ?? "Installing..."}
                            </span>
                          }
                        >
                          <i class="i-hugeicons-download-02 w-4 h-4" />
                          {t().collections?.installAll ?? "Install All"}
                        </Show>
                      </button>
                    </div>

                    {/* Install Result */}
                    <Show when={installResult()}>
                      {(result) => (
                        <div class="mt-3 pt-3 border-t border-gray-700 text-sm">
                          <div class="flex gap-4">
                            <span class="text-green-400 inline-flex items-center gap-1">
                              <i class="i-hugeicons-checkmark-circle-02 w-3 h-3" />
                              {result().installed} {t().collections?.installed ?? "installed"}
                            </span>
                            <Show when={result().skipped > 0}>
                              <span class="text-gray-400 inline-flex items-center gap-1">
                                <i class="i-hugeicons-next w-3 h-3" />
                                {result().skipped} {t().collections?.skipped ?? "skipped"}
                              </span>
                            </Show>
                            <Show when={result().failed > 0}>
                              <span class="text-red-400 inline-flex items-center gap-1">
                                <i class="i-hugeicons-cancel-01 w-3 h-3" />
                                {result().failed} {t().collections?.failed ?? "failed"}
                              </span>
                            </Show>
                          </div>
                        </div>
                      )}
                    </Show>
                  </div>
                </Show>

                {/* Mods List */}
                <div class="flex flex-col gap-2">
                <div class="text-sm font-medium text-gray-400">
                  {t().collections?.modsInCollection ?? "Mods in collection"} ({selected().mods.length})
                </div>
                <div class="flex flex-col gap-1">
                  <For
                    each={selected().mods}
                    fallback={
                      <div class="p-4 text-center text-gray-500 bg-gray-800 rounded-xl">
                        {t().collections?.emptyCollection ?? "No mods in this collection"}
                      </div>
                    }
                  >
                    {(mod) => (
                      <div class="flex items-center justify-between p-2 bg-gray-800 rounded-2xl">
                        <div class="flex items-center gap-2">
                          <div
                            class="w-1 h-8 rounded-full"
                            style={{ "background-color": selected().color }}
                          />
                          <div>
                            <div class="font-medium">{mod.mod_name}</div>
                            <div class="text-xs text-gray-500">
                              {mod.mod_source}
                              {mod.loader_type && ` • ${mod.loader_type}`}
                            </div>
                          </div>
                        </div>
                        <Show when={!selected().is_builtin}>
                          <button
                            class="btn-ghost text-sm text-red-400"
                            onClick={() =>
                              collections.removeModFromCollection(
                                selected().id,
                                mod.mod_slug
                              ).then(() => selectCollection(selected()))
                            }
                          >
                            <i class="i-hugeicons-cancel-01 w-4 h-4" />
                          </button>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
                </div>
              </div>
            )}
          </Show>
        </div>
      </div>

      {/* Create Dialog */}
      <Show when={showCreateDialog()}>
        <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div class="bg-gray-850 rounded-2xl p-6 w-96 border border-gray-700 flex flex-col gap-4">
            <h3 class="text-lg font-semibold">
              {t().collections?.createNew ?? "Create New Collection"}
            </h3>

            <div class="space-y-4">
              {/* Name */}
              <div class="flex flex-col gap-1">
                <label class="block text-sm text-gray-400">
                  {t().collections?.name ?? "Name"}
                </label>
                <input
                  type="text"
                  class="input w-full"
                  value={newName()}
                  onInput={(e) => setNewName(e.currentTarget.value)}
                  placeholder={t().collections?.namePlaceholder ?? "My Collection"}
                />
              </div>

              {/* Description */}
              <div class="flex flex-col gap-1">
                <label class="block text-sm text-gray-400">
                  {t().collections?.description ?? "Description"}
                </label>
                <input
                  type="text"
                  class="input w-full"
                  value={newDescription()}
                  onInput={(e) => setNewDescription(e.currentTarget.value)}
                  placeholder={t().collections?.descriptionPlaceholder ?? "Optional description"}
                />
              </div>

              {/* Icon */}
              <div class="flex flex-col gap-1">
                <label class="block text-sm text-gray-400">
                  {t().collections?.icon ?? "Icon"}
                </label>
                <div class="flex flex-wrap gap-2">
                  <For each={COLLECTION_ICONS}>
                    {(icon) => (
                      <button
                        class={`w-14 h-8 rounded-lg bg-cover bg-center transition-all ${
                          newIcon() === icon
                            ? "ring-2 ring-[var(--color-primary)] scale-110"
                            : "opacity-70 hover:opacity-100"
                        }`}
                        style={{
                          "background-image": `url(${getCollectionIconUrl(icon)})`,
                        }}
                        onClick={() => setNewIcon(icon)}
                      />
                    )}
                  </For>
                </div>
              </div>

              {/* Color */}
              <div class="flex flex-col gap-1">
                <label class="block text-sm text-gray-400">
                  {t().collections?.color ?? "Color"}
                </label>
                <div class="flex flex-wrap gap-2">
                  <For each={COLLECTION_COLORS}>
                    {(color) => (
                      <button
                        class={`w-8 h-8 rounded-full transition-transform ${
                          newColor() === color ? "scale-125 ring-2 ring-white" : ""
                        }`}
                        style={{ "background-color": color }}
                        onClick={() => setNewColor(color)}
                      />
                    )}
                  </For>
                </div>
              </div>
            </div>

            <div class="flex justify-end gap-2 mt-2">
              <button
                class="btn-secondary"
                onClick={() => {
                  setShowCreateDialog(false);
                  resetCreateForm();
                }}
              >
                {t().common?.cancel ?? "Cancel"}
              </button>
              <button
                class="btn-primary"
                onClick={handleCreate}
                disabled={!newName().trim()}
              >
                {t().common?.create ?? "Create"}
              </button>
            </div>
          </div>
        </div>
      </Show>

      {/* Edit Dialog */}
      <Show when={showEditDialog()}>
        <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div class="bg-gray-850 rounded-2xl p-6 w-96 border border-gray-700 flex flex-col gap-4">
            <h3 class="text-lg font-semibold">
              {t().collections?.edit ?? "Edit Collection"}
            </h3>

            <div class="space-y-4">
              {/* Name */}
              <div class="flex flex-col gap-1">
                <label class="block text-sm text-gray-400">
                  {t().collections?.name ?? "Name"}
                </label>
                <input
                  type="text"
                  class="input w-full"
                  value={newName()}
                  onInput={(e) => setNewName(e.currentTarget.value)}
                />
              </div>

              {/* Description */}
              <div class="flex flex-col gap-1">
                <label class="block text-sm text-gray-400">
                  {t().collections?.description ?? "Description"}
                </label>
                <input
                  type="text"
                  class="input w-full"
                  value={newDescription()}
                  onInput={(e) => setNewDescription(e.currentTarget.value)}
                />
              </div>

              {/* Icon */}
              <div class="flex flex-col gap-1">
                <label class="block text-sm text-gray-400">
                  {t().collections?.icon ?? "Icon"}
                </label>
                <div class="flex flex-wrap gap-2">
                  <For each={COLLECTION_ICONS}>
                    {(icon) => (
                      <button
                        class={`w-14 h-8 rounded-lg bg-cover bg-center transition-all ${
                          newIcon() === icon
                            ? "ring-2 ring-[var(--color-primary)] scale-110"
                            : "opacity-70 hover:opacity-100"
                        }`}
                        style={{
                          "background-image": `url(${getCollectionIconUrl(icon)})`,
                        }}
                        onClick={() => setNewIcon(icon)}
                      />
                    )}
                  </For>
                </div>
              </div>

              {/* Color */}
              <div class="flex flex-col gap-1">
                <label class="block text-sm text-gray-400">
                  {t().collections?.color ?? "Color"}
                </label>
                <div class="flex flex-wrap gap-2">
                  <For each={COLLECTION_COLORS}>
                    {(color) => (
                      <button
                        class={`w-8 h-8 rounded-full transition-transform ${
                          newColor() === color ? "scale-125 ring-2 ring-white" : ""
                        }`}
                        style={{ "background-color": color }}
                        onClick={() => setNewColor(color)}
                      />
                    )}
                  </For>
                </div>
              </div>
            </div>

            <div class="flex justify-end gap-2 mt-2">
              <button
                class="btn-secondary"
                onClick={() => setShowEditDialog(false)}
              >
                {t().common?.cancel ?? "Cancel"}
              </button>
              <button
                class="btn-primary"
                onClick={handleUpdate}
                disabled={!newName().trim()}
              >
                {t().common?.save ?? "Save"}
              </button>
            </div>
          </div>
        </div>
      </Show>

      <ConfirmDialogComponent />
    </div>
  );
}
