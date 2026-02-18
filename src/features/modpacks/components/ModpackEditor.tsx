import { createSignal, For, Show, onMount, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import type {
  ModpackProject,
  ModpackProjectFull,
  AddModInfo,
  ExportResult,
} from "../../../shared/types";
import { sanitizeImageUrl } from "../../../shared/utils/url-validator";
import { addToast } from "../../../shared/components/Toast";
import { Tabs, Tooltip } from "../../../shared/ui";
import { useI18n } from "../../../shared/i18n";
import { formatSize } from "../../../shared/utils/format-size";

interface Props {
  project: ModpackProject;
  onBack: () => void;
  onInstanceCreated?: (instanceId: string) => void;
}

type Tab = "mods" | "settings" | "export";
type ModSource = "modrinth" | "curseforge";

interface NormalizedMod {
  slug: string;
  _source: ModSource;
  _id: string;
  _title: string;
  _icon?: string;
  _description: string;
  _downloads: number;
  // Original fields that may be present
  title?: string;
  name?: string;
  icon_url?: string;
  id?: number | string;
  mod_id?: number | string;
  logo?: { thumbnailUrl?: string };
}

interface ExportProgress {
  current: number;
  total: number;
  stage: string;
  filename?: string;
}

export default function ModpackEditor(props: Props) {
  const { t } = useI18n();
  const [projectFull, setProjectFull] = createSignal<ModpackProjectFull | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [activeTab, setActiveTab] = createSignal<Tab>("mods");
  const [searchQuery, setSearchQuery] = createSignal("");
  const [searchResults, setSearchResults] = createSignal<NormalizedMod[]>([]);
  const [searching, setSearching] = createSignal(false);
  const [addingMod, setAddingMod] = createSignal<string | null>(null);
  const [removingMod, setRemovingMod] = createSignal<string | null>(null);
  const [searchSource, setSearchSource] = createSignal<ModSource>("modrinth");

  // Settings form
  const [editName, setEditName] = createSignal("");
  const [editVersion, setEditVersion] = createSignal("");
  const [editAuthor, setEditAuthor] = createSignal("");
  const [editDescription, setEditDescription] = createSignal("");
  const [saving, setSaving] = createSignal(false);

  // Export
  const [exporting, setExporting] = createSignal(false);
  const [exportProgress, setExportProgress] = createSignal<{
    current: number;
    total: number;
    stage: string;
    filename?: string;
  } | null>(null);
  const [embedMods, setEmbedMods] = createSignal(true);

  // Create instance
  const [creatingInstance, setCreatingInstance] = createSignal(false);
  const [instanceName, setInstanceName] = createSignal("");

  const loadProject = async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await invoke<ModpackProjectFull>("get_modpack_project", {
        projectId: props.project.id,
      });
      setProjectFull(result);

      // Init settings form
      setEditName(result.project.name);
      setEditVersion(result.project.version);
      setEditAuthor(result.project.author || "");
      setEditDescription(result.project.description || "");
      setInstanceName(result.project.name);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  // Load project on mount only (NOT in createEffect!)
  onMount(() => {
    loadProject();

    // Setup event listener on mount (NOT in createEffect to avoid duplicates!)
    const unlisten = listen<ExportProgress>("stzhk-export-progress", (event) => {
      setExportProgress(event.payload);
    });

    onCleanup(() => {
      unlisten.then((fn) => fn());
    });
  });

  const handleSearch = async () => {
    if (!searchQuery().trim()) {
      setSearchResults([]);
      return;
    }

    const project = projectFull()?.project;
    if (!project) return;

    try {
      setSearching(true);
      const source = searchSource();

      if (source === "modrinth") {
        const results = await invoke<{ hits: Record<string, unknown>[] }>("search_mods", {
          query: searchQuery(),
          minecraftVersion: project.minecraft_version,
          loader: project.loader,
          source: "modrinth",
          limit: 20,
          offset: 0,
          searchMode: "all",
        });
        // Нормализуем результаты Modrinth
        setSearchResults(
          (results.hits || []).map((mod): NormalizedMod => ({
            slug: mod.slug as string,
            _source: "modrinth",
            _id: mod.slug as string,
            _title: mod.title as string,
            _icon: mod.icon_url as string | undefined,
            _description: mod.description as string,
            _downloads: mod.downloads as number,
            title: mod.title as string,
            icon_url: mod.icon_url as string | undefined,
          }))
        );
      } else {
        const results = await invoke<{ hits: Record<string, unknown>[] }>("search_mods", {
          query: searchQuery(),
          minecraftVersion: project.minecraft_version,
          loader: project.loader,
          source: "curseforge",
          limit: 20,
          offset: 0,
        });
        // Нормализуем результаты CurseForge
        setSearchResults(
          (results.hits || []).map((mod): NormalizedMod => ({
            slug: (mod.slug as string) || String(mod.id),
            _source: "curseforge",
            _id: String(mod.id || mod.mod_id),
            _title: (mod.name as string) || (mod.title as string) || "",
            _icon: ((mod.logo as { thumbnailUrl?: string })?.thumbnailUrl) || (mod.icon_url as string),
            _description: (mod.summary as string) || (mod.description as string) || "",
            _downloads: (mod.downloadCount as number) || (mod.downloads as number) || 0,
            name: mod.name as string,
            id: mod.id as number | string,
            mod_id: mod.mod_id as number | string,
            logo: mod.logo as { thumbnailUrl?: string },
          }))
        );
      }
    } catch (e) {
      if (import.meta.env.DEV) console.error("Search error:", e);
      setError(`Ошибка поиска: ${e}`);
    } finally {
      setSearching(false);
    }
  };

  const handleAddMod = async (mod: NormalizedMod) => {
    const project = projectFull()?.project;
    if (!project) return;

    const source = mod._source || searchSource();
    const modId = mod._id || mod.slug;

    try {
      setAddingMod(modId);

      let modInfo: AddModInfo;

      if (source === "modrinth") {
        // Получаем версии с Modrinth
        const versions = await invoke<any[]>("get_modpack_versions", {
          source: "modrinth",
          projectId: mod.slug,
          minecraftVersion: project.minecraft_version,
          loader: project.loader,
        });

        const latestVersion = versions[0];

        modInfo = {
          slug: mod.slug,
          name: mod._title || mod.title || mod.slug,
          version: latestVersion?.version_number,
          filename: latestVersion?.download_url?.split("/").pop(),
          size: latestVersion?.file_size,
          source: "modrinth",
          source_id: mod.slug,
          source_version_id: latestVersion?.id,
          download_url: latestVersion?.download_url,
          icon_url: mod._icon || mod.icon_url,
          side: "both",
        };
      } else {
        // Получаем версии с CurseForge
        const cfId = mod.id || mod.mod_id || modId;
        const versions = await invoke<any[]>("get_modpack_versions", {
          source: "curseforge",
          projectId: String(cfId),
          minecraftVersion: project.minecraft_version,
          loader: project.loader,
        });

        const latestVersion = versions[0];

        modInfo = {
          slug: mod.slug || String(cfId),
          name: mod._title || mod.name || mod.slug || String(cfId),
          version: latestVersion?.version_number || latestVersion?.name,
          filename: latestVersion?.download_url?.split("/").pop() || latestVersion?.fileName,
          size: latestVersion?.file_size || latestVersion?.fileLength,
          source: "curseforge",
          source_id: String(cfId),
          source_version_id: latestVersion?.id ? String(latestVersion.id) : undefined,
          download_url: latestVersion?.download_url || latestVersion?.downloadUrl,
          icon_url: mod._icon || mod.logo?.thumbnailUrl,
          side: "both",
        };
      }

      await invoke("add_mod_to_project", {
        projectId: project.id,
        modInfo,
      });

      await loadProject();
      setSearchQuery("");
      setSearchResults([]);
    } catch (e) {
      setError(String(e));
    } finally {
      setAddingMod(null);
    }
  };

  const handleRemoveMod = async (modId: string) => {
    try {
      setRemovingMod(modId);
      await invoke("remove_mod_from_project", {
        projectId: props.project.id,
        modId,
      });
      await loadProject();
    } catch (e) {
      setError(String(e));
    } finally {
      setRemovingMod(null);
    }
  };

  const handleSaveSettings = async () => {
    try {
      setSaving(true);
      await invoke("update_modpack_project", {
        projectId: props.project.id,
        updates: {
          name: editName() || null,
          version: editVersion() || null,
          author: editAuthor() || null,
          description: editDescription() || null,
        },
      });
      await loadProject();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleExport = async () => {
    try {
      const outputPath = await save({
        title: "Сохранить модпак",
        defaultPath: `${editName().replace(/\s+/g, "_")}-${editVersion()}.stzhk`,
        filters: [{ name: "STZHK Modpack", extensions: ["stzhk"] }],
      });

      if (!outputPath) return;

      // Get directory from path
      const outputDir = outputPath.replace(/[/\\][^/\\]+$/, "");

      setExporting(true);
      setExportProgress({ current: 0, total: 0, stage: "starting" });

      const result = await invoke<ExportResult>("export_project_to_stzhk", {
        projectId: props.project.id,
        outputPath: outputDir,
        embedMods: embedMods(),
        appHandle: null,
      });

      setExportProgress(null);
      addToast({
        type: "success",
        title: t().modpacks.export?.success ?? "Modpack exported!",
        message: `${result.path} • ${fmtSize(result.size)} • ${result.mods_count} ${t().common?.mods ?? "mods"}`,
        duration: 7000,
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setExporting(false);
      setExportProgress(null);
    }
  };

  const handleCreateInstance = async () => {
    if (!instanceName().trim()) return;

    try {
      setCreatingInstance(true);
      const instanceId = await invoke<string>("create_instance_from_project", {
        projectId: props.project.id,
        instanceName: instanceName().trim(),
      });

      props.onInstanceCreated?.(instanceId);
    } catch (e) {
      setError(String(e));
    } finally {
      setCreatingInstance(false);
    }
  };

  // Localized size formatter
  const fmtSize = (bytes: number) => formatSize(bytes, t().ui?.units);

  const getLoaderColor = (loader: string) => {
    switch (loader) {
      case "fabric":
        return "text-amber-400";
      case "forge":
        return "text-orange-400";
      case "neoforge":
        return "text-red-400";
      case "quilt":
        return "text-purple-400";
      default:
        return "text-gray-400";
    }
  };

  const isModInProject = (slug: string) => {
    return projectFull()?.mods.some((m) => m.slug === slug) || false;
  };

  return (
    <div class="flex flex-col h-full max-h-[calc(100vh-8rem)]">
      {/* Header */}
      <div class="flex items-center gap-4 p-4 border-b border-gray-750 flex-shrink-0">
        <button
          class="p-2 rounded-2xl hover:bg-gray-800 text-gray-400 hover:text-gray-200 transition-colors duration-100"
          onClick={props.onBack}
        >
          <div class="i-hugeicons-arrow-left-01 w-5 h-5" />
        </button>

        <div class="flex-1 flex flex-col gap-1">
          <h2 class="text-xl font-bold text-white">
            {projectFull()?.project.name || props.project.name}
          </h2>
          <div class="flex items-center gap-3 text-sm text-gray-400">
            <span>v{projectFull()?.project.version || props.project.version}</span>
            <span>•</span>
            <span>{props.project.minecraft_version}</span>
            <span>•</span>
            <span class={getLoaderColor(props.project.loader)}>
              {props.project.loader}
            </span>
            <span>•</span>
            <span>{projectFull()?.mods.length || 0} модов</span>
          </div>
        </div>
      </div>

      {/* Content */}
      <div class="flex-1 overflow-y-auto p-4 flex flex-col gap-4">

      {/* Error */}
      <Show when={error()}>
        <div class="card p-3 bg-red-500/10 border-red-500/30">
          <div class="flex items-center gap-2 text-red-400">
            <div class="i-hugeicons-alert-02 w-5 h-5" />
            <span class="flex-1">{error()}</span>
            <button onClick={() => setError(null)} class="hover:text-red-300">
              <div class="i-hugeicons-cancel-01 w-4 h-4" />
            </button>
          </div>
        </div>
      </Show>

      {/* Loading */}
      <Show when={loading()}>
        <div class="flex-1 flex items-center justify-center">
          <i class="i-svg-spinners-6-dots-scale w-8 h-8 text-[var(--color-primary)]" />
        </div>
      </Show>

      <Show when={!loading() && projectFull()}>
        {/* Tabs */}
        <div>
          <Tabs
            tabs={[
              { id: "mods", label: "Моды", icon: "i-hugeicons-package" },
              { id: "settings", label: "Настройки", icon: "i-hugeicons-settings-02" },
              { id: "export", label: "Экспорт", icon: "i-hugeicons-share-01" },
            ]}
            activeTab={activeTab()}
            onTabChange={(id) => setActiveTab(id as Tab)}
            variant="underline"
          />
        </div>

        {/* Mods Tab */}
        <Show when={activeTab() === "mods"}>
          <div class="flex-1 flex flex-col gap-4 overflow-hidden">
            {/* Search */}
            <div class="flex flex-col gap-3">
              {/* Source Selector */}
              <div>
                <Tabs
                  tabs={[
                    { id: "modrinth", label: "Modrinth", icon: "i-hugeicons-github" },
                    { id: "curseforge", label: "CurseForge", icon: "i-hugeicons-fire" },
                  ]}
                  activeTab={searchSource()}
                  onTabChange={(id) => {
                    setSearchSource(id as ModSource);
                    setSearchResults([]);
                  }}
                  variant="pills"
                />
              </div>

              <div class="flex gap-2">
                <div class="flex-1">
                  <div class="i-hugeicons-search-01 absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                  <input
                    type="text"
                    class="w-full pl-10 pr-4 py-2 bg-gray-800 border border-gray-700 rounded-2xl text-gray-200 placeholder-gray-500 focus:border-[var(--color-primary)] focus:outline-none"
                    placeholder={t().ui.placeholders.searchModsOn.replace("{source}", searchSource() === "modrinth" ? "Modrinth" : "CurseForge")}
                    value={searchQuery()}
                    onInput={(e) => setSearchQuery(e.currentTarget.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                  />
                </div>
                <button
                  class="btn-primary"
                  onClick={handleSearch}
                  disabled={searching()}
                >
                  {searching() ? (
                    <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                  ) : (
                    "Поиск"
                  )}
                </button>
              </div>

              {/* Search Results */}
              <Show when={searchResults().length > 0}>
                <div class="max-h-64 overflow-y-auto rounded-2xl border border-gray-700 bg-gray-alpha-50">
                  <For each={searchResults()}>
                    {(mod) => (
                      <div class="flex items-center gap-3 p-3 border-b border-gray-700 last:border-0 hover:bg-gray-700/50">
                        <Show
                          when={sanitizeImageUrl(mod._icon)}
                          fallback={
                            <div class="w-10 h-10 rounded bg-gray-700 flex items-center justify-center flex-shrink-0">
                              <div class="i-hugeicons-package w-5 h-5 text-gray-500" />
                            </div>
                          }
                        >
                          <img
                            src={sanitizeImageUrl(mod._icon)}
                            class="w-10 h-10 rounded flex-shrink-0"
                            alt=""
                          />
                        </Show>

                        <div class="flex-1 min-w-0 flex flex-col gap-0.5">
                          <div class="flex items-center gap-2">
                            <span class="font-medium text-white truncate">
                              {mod._title}
                            </span>
                            <span
                              class={`text-xs px-1.5 py-0.5 rounded ${
                                mod._source === "modrinth"
                                  ? "bg-green-500/20 text-green-400"
                                  : "bg-orange-500/20 text-orange-400"
                              }`}
                            >
                              {mod._source === "modrinth" ? "MR" : "CF"}
                            </span>
                          </div>
                          <div class="text-xs text-gray-400 truncate">
                            {mod._description}
                          </div>
                          <div class="text-xs text-gray-500">
                            {mod._downloads?.toLocaleString()} загрузок
                          </div>
                        </div>

                        <Show
                          when={!isModInProject(mod.slug)}
                          fallback={
                            <span class="text-xs text-green-400 flex items-center gap-1">
                              <div class="i-hugeicons-checkmark-circle-02 w-4 h-4" />
                              Добавлен
                            </span>
                          }
                        >
                          <button
                            class="btn-primary text-sm py-1.5"
                            onClick={() => handleAddMod(mod)}
                            disabled={addingMod() === mod._id}
                          >
                            {addingMod() === mod._id ? (
                              <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                            ) : (
                              <>
                                <div class="i-hugeicons-add-01 w-4 h-4" />
                                Добавить
                              </>
                            )}
                          </button>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </div>

            {/* Mods List */}
            <div class="flex-1 overflow-y-auto">
              <Show
                when={projectFull()!.mods.length > 0}
                fallback={
                  <div class="flex flex-col items-center justify-center gap-3 h-full text-gray-400">
                    <div class="i-hugeicons-package w-12 h-12 opacity-50" />
                    <div class="flex flex-col items-center">
                      <p>Модов пока нет</p>
                      <p class="text-sm">Добавьте моды через поиск выше</p>
                    </div>
                  </div>
                }
              >
                <div class="space-y-2">
                  <For each={projectFull()!.mods}>
                    {(mod) => (
                      <div class="flex items-center gap-3 p-3 rounded-2xl bg-gray-alpha-50 hover:bg-gray-800 group">
                        <Show
                          when={sanitizeImageUrl(mod.icon_url)}
                          fallback={
                            <div class="w-10 h-10 rounded bg-gray-700 flex items-center justify-center flex-shrink-0">
                              <div class="i-hugeicons-package w-5 h-5 text-gray-500" />
                            </div>
                          }
                        >
                          <img
                            src={sanitizeImageUrl(mod.icon_url)}
                            class="w-10 h-10 rounded flex-shrink-0"
                            alt=""
                          />
                        </Show>

                        <div class="flex-1 min-w-0">
                          <div class="flex items-center gap-2">
                            <span class="font-medium text-white">
                              {mod.name}
                            </span>
                            <Show when={mod.version}>
                              <span class="text-xs text-gray-500">
                                v{mod.version}
                              </span>
                            </Show>
                          </div>
                          <div class="flex items-center gap-3 text-xs text-gray-400">
                            <span class="flex items-center gap-1">
                              <div class="i-hugeicons-file-01 w-3 h-3" />
                              {mod.slug}
                            </span>
                            <span
                              class={`px-1.5 py-0.5 rounded ${
                                mod.source === "modrinth"
                                  ? "bg-green-500/20 text-green-400"
                                  : mod.source === "curseforge"
                                    ? "bg-orange-500/20 text-orange-400"
                                    : "bg-gray-500/20 text-gray-400"
                              }`}
                            >
                              {mod.source === "modrinth"
                                ? "Modrinth"
                                : mod.source === "curseforge"
                                  ? "CurseForge"
                                  : mod.source}
                            </span>
                            <Show when={mod.size}>
                              <span>{fmtSize(mod.size!)}</span>
                            </Show>
                          </div>
                        </div>

                        <Tooltip text="Удалить мод" position="bottom">
                        <button
                          class="p-2 rounded opacity-0 group-hover:opacity-100 hover:bg-red-500/20 text-gray-400 hover:text-red-400 transition-colors duration-100"
                          onClick={() => handleRemoveMod(mod.mod_id)}
                          disabled={removingMod() === mod.mod_id}
                        >
                          {removingMod() === mod.mod_id ? (
                            <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                          ) : (
                            <div class="i-hugeicons-delete-02 w-4 h-4" />
                          )}
                        </button>
                        </Tooltip>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </div>
        </Show>

        {/* Settings Tab */}
        <Show when={activeTab() === "settings"}>
          <div class="flex-1 overflow-y-auto">
            <div class="max-w-xl space-y-4">
              <div class="flex flex-col gap-1">
                <label class="text-sm text-gray-400">
                  Название модпака
                </label>
                <input
                  type="text"
                  class="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-2xl text-gray-200 focus:border-[var(--color-primary)] focus:outline-none"
                  value={editName()}
                  onInput={(e) => setEditName(e.currentTarget.value)}
                />
              </div>

              <div class="flex flex-col gap-1">
                <label class="text-sm text-gray-400">Версия</label>
                <input
                  type="text"
                  class="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-2xl text-gray-200 focus:border-[var(--color-primary)] focus:outline-none"
                  placeholder={t().ui.placeholders.versionNumber}
                  value={editVersion()}
                  onInput={(e) => setEditVersion(e.currentTarget.value)}
                />
              </div>

              <div class="flex flex-col gap-1">
                <label class="text-sm text-gray-400">Автор</label>
                <input
                  type="text"
                  class="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-2xl text-gray-200 focus:border-[var(--color-primary)] focus:outline-none"
                  placeholder={t().ui.placeholders.yourName}
                  value={editAuthor()}
                  onInput={(e) => setEditAuthor(e.currentTarget.value)}
                />
              </div>

              <div class="flex flex-col gap-1">
                <label class="text-sm text-gray-400">Описание</label>
                <textarea
                  class="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-2xl text-gray-200 focus:border-[var(--color-primary)] focus:outline-none resize-none"
                  rows={4}
                  placeholder={t().ui.placeholders.modpackDescriptionLong}
                  value={editDescription()}
                  onInput={(e) => setEditDescription(e.currentTarget.value)}
                />
              </div>

              <div class="pt-4">
                <button
                  class="btn-primary"
                  onClick={handleSaveSettings}
                  disabled={saving()}
                >
                  {saving() ? (
                    <>
                      <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                      Сохранение...
                    </>
                  ) : (
                    <>
                      <div class="i-hugeicons-floppy-disk w-4 h-4" />
                      Сохранить
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </Show>

        {/* Export Tab */}
        <Show when={activeTab() === "export"}>
          <div class="flex-1 overflow-y-auto">
            <div class="max-w-xl space-y-6">
              {/* Export to STZHK */}
              <div class="card p-4">
                <h3 class="font-medium text-white mb-3 flex items-center gap-2">
                  <div class="i-hugeicons-share-01 w-5 h-5 text-blue-400" />
                  Экспорт в .stzhk
                </h3>

                <div class="space-y-3">
                  <label class="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      class="w-4 h-4 rounded border-gray-600 bg-gray-700 focus:ring-[var(--color-primary)]"
                      checked={embedMods()}
                      onChange={(e) => setEmbedMods(e.currentTarget.checked)}
                    />
                    <span class="text-sm text-gray-300">
                      Встроить моды в архив
                    </span>
                  </label>

                  <p class="text-xs text-gray-500">
                    {embedMods()
                      ? "Все моды будут скачаны и упакованы в архив. Больший размер файла, но не требует интернета при установке."
                      : "Моды будут скачиваться при установке. Меньший размер файла."}
                  </p>

                  <Show when={exportProgress()}>
                    <div class="mt-3">
                      <div class="flex items-center justify-between text-sm mb-1">
                        <span class="text-gray-400">
                          {exportProgress()!.stage === "downloading"
                            ? `Скачивание: ${exportProgress()!.filename}`
                            : exportProgress()!.stage}
                        </span>
                        <span class="text-gray-500">
                          {exportProgress()!.current}/{exportProgress()!.total}
                        </span>
                      </div>
                      <div class="h-1.5 bg-gray-700 rounded-full overflow-hidden">
                        <div
                          class="h-full bg-[var(--color-primary)] transition-colors duration-100"
                          style={{
                            width: `${(exportProgress()!.current / Math.max(exportProgress()!.total, 1)) * 100}%`,
                          }}
                        />
                      </div>
                    </div>
                  </Show>

                  <button
                    class="btn-primary w-full"
                    onClick={handleExport}
                    disabled={exporting() || projectFull()!.mods.length === 0}
                  >
                    {exporting() ? (
                      <>
                        <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                        Экспорт...
                      </>
                    ) : (
                      <>
                        <div class="i-hugeicons-download-02 w-4 h-4" />
                        Экспортировать
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Create Instance */}
              <div class="card p-4">
                <h3 class="font-medium text-white mb-3 flex items-center gap-2">
                  <div class="i-hugeicons-play w-5 h-5 text-green-400" />
                  Создать экземпляр
                </h3>

                <div class="space-y-3">
                  <div>
                    <label class="block text-sm text-gray-400 mb-1">
                      Имя экземпляра
                    </label>
                    <input
                      type="text"
                      class="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-2xl text-gray-200 focus:border-[var(--color-primary)] focus:outline-none"
                      value={instanceName()}
                      onInput={(e) => setInstanceName(e.currentTarget.value)}
                    />
                  </div>

                  <p class="text-xs text-gray-500">
                    Создаст новый экземпляр и установит все моды из проекта.
                  </p>

                  <button
                    class="btn-success w-full"
                    onClick={handleCreateInstance}
                    disabled={
                      creatingInstance() ||
                      !instanceName().trim() ||
                      projectFull()!.mods.length === 0
                    }
                  >
                    {creatingInstance() ? (
                      <>
                        <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                        Создание...
                      </>
                    ) : (
                      <>
                        <div class="i-hugeicons-add-01 w-4 h-4" />
                        Создать и установить
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </Show>
      </Show>
      </div>
    </div>
  );
}
