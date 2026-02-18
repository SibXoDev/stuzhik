import { For, Show, createSignal, createEffect, createMemo, Accessor } from "solid-js";
import type { Component } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { useModSearch } from "../hooks/useMods";
import ModRecommendations from "./ModRecommendations";
import { ProjectInfoDialog } from "../../../shared/components/ProjectInfoDialog";
import type {
  Mod,
  ModSearchResult,
  ConflictPredictionResult,
  PredictedConflict,
  ConflictSeverity,
  ModSource,
  WikiContent,
  VersionChangelog,
  ProjectInfo,
} from "../../../shared/types";
import { useI18n } from "../../../shared/i18n";
import { Pagination, Select } from "../../../shared/ui";
import { useInstallingMods } from "../../../shared/stores";
import { useDebounce } from "../../../shared/hooks";
import { sanitizeImageUrl } from "../../../shared/utils/url-validator";
import { isVisible } from "../../../shared/stores/uiPreferences";

interface Props {
  instanceId: string;
  minecraftVersion: string;
  loader: string;
  installedMods: Accessor<Mod[]>;
  onInstall: (slug: string, source: string, modName?: string, versionId?: string) => Promise<void>;
  onRemoveMod?: (modId: number) => Promise<void>; // Для автофикса
  onSwitchToInstalled?: () => void; // Переключиться на вкладку установленных
}

// Категории Modrinth - ID и иконки (названия берутся из i18n)
const CATEGORY_IDS = [
  { id: "adventure", icon: "i-hugeicons-maps-location-01" },
  { id: "cursed", icon: "i-hugeicons-wink" },
  { id: "decoration", icon: "i-hugeicons-paint-brush-01" },
  { id: "economy", icon: "i-hugeicons-dollar-01" },
  { id: "equipment", icon: "i-hugeicons-wrench-01" },
  { id: "food", icon: "i-hugeicons-restaurant-01" },
  { id: "game-mechanics", icon: "i-hugeicons-game-controller-03" },
  { id: "library", icon: "i-hugeicons-source-code" },
  { id: "magic", icon: "i-hugeicons-magic-wand-01" },
  { id: "management", icon: "i-hugeicons-settings-02" },
  { id: "minigame", icon: "i-hugeicons-game-controller-03" },
  { id: "mobs", icon: "i-hugeicons-user-group" },
  { id: "optimization", icon: "i-hugeicons-flash" },
  { id: "social", icon: "i-hugeicons-user-group" },
  { id: "storage", icon: "i-hugeicons-database" },
  { id: "technology", icon: "i-hugeicons-cpu" },
  { id: "transportation", icon: "i-hugeicons-car-01" },
  { id: "utility", icon: "i-hugeicons-tools" },
  { id: "worldgen", icon: "i-hugeicons-earth" },
];

// Sort option keys (labels come from i18n)
const SORT_OPTION_KEYS = ["relevance", "downloads", "follows", "newest", "updated"] as const;

// Цвет для severity
const getSeverityColor = (severity: ConflictSeverity): string => {
  switch (severity) {
    case "critical": return "text-red-400 bg-red-600/20 border-red-600/30";
    case "warning": return "text-yellow-400 bg-yellow-600/20 border-yellow-600/30";
    default: return "text-blue-400 bg-blue-600/20 border-blue-600/30";
  }
};

const ModsBrowser: Component<Props> = (props) => {
  const { t } = useI18n();
  const modSearch = useModSearch();
  const installingMods = useInstallingMods();

  // Memoized translations for categories and sort options
  const sortOptions = createMemo(() =>
    SORT_OPTION_KEYS.map(key => ({
      value: key,
      label: t().mods?.browser?.sortOptions?.[key] ?? key.charAt(0).toUpperCase() + key.slice(1),
    }))
  );

  const getCategoryName = (id: string) => {
    const categories = t().mods?.browser?.categories;
    return categories?.[id as keyof typeof categories] ?? id.charAt(0).toUpperCase() + id.slice(1);
  };
  const [source, setSource] = createSignal<"modrinth" | "curseforge">("modrinth");
  const [searchQuery, setSearchQuery] = createSignal("");
  const [searchMode, setSearchMode] = createSignal<"name" | "id" | "all">("name");
  const [selectedCategory, setSelectedCategory] = createSignal<string | null>(null);
  const [sortBy, setSortBy] = createSignal("relevance");
  const [page, setPage] = createSignal(0);
  const [showCategories, setShowCategories] = createSignal(true);
  const [debouncedSearchQuery, setDebouncedSearchQuery] = createSignal("");
  const [showIncompatible, setShowIncompatible] = createSignal(false);

  // Уведомление о конфликтах (показывается после установки)
  const [conflictNotification, setConflictNotification] = createSignal<{
    show: boolean;
    modName: string;
    conflicts: PredictedConflict[];
  } | null>(null);

  // Превью мода (показывается при клике на карточку)
  const [previewMod, setPreviewMod] = createSignal<ModSearchResult | null>(null);
  const [previewWiki, setPreviewWiki] = createSignal<WikiContent | null>(null);
  const [previewVersions, setPreviewVersions] = createSignal<VersionChangelog[]>([]);
  const [previewLoading, setPreviewLoading] = createSignal(false);
  const [previewInstalling, setPreviewInstalling] = createSignal(false);

  const { debounce: debounceSearch } = useDebounce();
  const limit = 20;

  // Get mod ID for API calls
  const getModId = (mod: ModSearchResult, modSource: "modrinth" | "curseforge") => {
    if (modSource === "curseforge") {
      return mod.id?.toString() || mod.slug;
    }
    return mod.slug;
  };

  // Convert ModSearchResult + WikiContent to ProjectInfo
  const toProjectInfo = (mod: ModSearchResult, wiki: WikiContent | null, modSource: "modrinth" | "curseforge"): ProjectInfo => {
    const projectUrl = modSource === "modrinth"
      ? `https://modrinth.com/mod/${mod.slug}`
      : `https://www.curseforge.com/minecraft/mc-mods/${mod.slug}`;

    if (wiki) {
      return {
        slug: mod.slug || mod.id?.toString() || "",
        title: mod.title || mod.name || "",
        description: mod.description || mod.summary || "",
        body: wiki.body,
        author: mod.author,
        icon_url: mod.icon_url || mod.logo?.url,
        downloads: wiki.downloads || mod.downloads,
        followers: wiki.followers,
        categories: wiki.categories.length > 0 ? wiki.categories : (mod.categories || []),
        versions: [], // Will show versionsData instead
        gallery: wiki.gallery.map((img) => ({
          url: img.url,
          title: img.title || undefined,
          description: img.description || undefined,
          featured: img.featured,
        })),
        links: {
          project: wiki.project_url || projectUrl,
          source: wiki.source_url || undefined,
          wiki: wiki.wiki_url || undefined,
          discord: wiki.discord_url || undefined,
          issues: wiki.issues_url || undefined,
        },
        projectType: "mod",
        source: modSource,
        license_id: wiki.license?.id,
        license_name: wiki.license?.name,
      };
    }

    // Fallback without wiki
    return {
      slug: mod.slug || mod.id?.toString() || "",
      title: mod.title || mod.name || "",
      description: mod.description || mod.summary || "",
      author: mod.author,
      icon_url: mod.icon_url || mod.logo?.url,
      downloads: mod.downloads,
      categories: mod.categories || [],
      versions: [],
      gallery: [],
      links: {
        project: projectUrl,
      },
      projectType: "mod",
      source: modSource,
    };
  };

  // Load wiki and versions when preview mod changes
  const loadModPreviewData = async (mod: ModSearchResult, modSource: "modrinth" | "curseforge") => {
    setPreviewLoading(true);
    setPreviewWiki(null);
    setPreviewVersions([]);

    try {
      const modId = getModId(mod, modSource);

      // Load wiki content and versions in parallel
      const [wikiResult, versionsResult] = await Promise.allSettled([
        invoke<WikiContent>("get_mod_wiki", { slug: modId, source: modSource, fileHash: null }),
        invoke<VersionChangelog[]>("get_mod_changelog", { slug: modId, source: modSource, limit: 30, fileHash: null }),
      ]);

      if (wikiResult.status === "fulfilled") {
        setPreviewWiki(wikiResult.value);
      }

      if (versionsResult.status === "fulfilled") {
        setPreviewVersions(versionsResult.value);
      }
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to load mod preview data:", e);
    } finally {
      setPreviewLoading(false);
    }
  };

  // Open preview for a mod
  const openModPreview = (mod: ModSearchResult) => {
    setPreviewMod(mod);
    loadModPreviewData(mod, source());
  };

  // Close preview
  const closeModPreview = () => {
    setPreviewMod(null);
    setPreviewWiki(null);
    setPreviewVersions([]);
    setPreviewInstalling(false);
  };

  // Install specific version from preview
  const handleInstallVersion = async (versionId: string) => {
    const mod = previewMod();
    if (!mod) return;

    setPreviewInstalling(true);
    try {
      const modId = getModId(mod, source());
      await handleInstall(modId, source(), mod.title || mod.name || modId, versionId);
      closeModPreview();
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to install mod:", e);
    } finally {
      setPreviewInstalling(false);
    }
  };

  // Автофикс - удалить конфликтующий мод
  const handleAutoFix = async (conflictingModSlug: string) => {
    if (!props.onRemoveMod) return;

    // Найти мод по slug
    const mod = props.installedMods().find(m => m.slug === conflictingModSlug);
    if (mod) {
      await props.onRemoveMod(mod.id);
      setConflictNotification(null);
    }
  };

  // Перейти к установленным модам
  const handleGoToInstalled = () => {
    setConflictNotification(null);
    props.onSwitchToInstalled?.();
  };

  // Закрыть уведомление
  const closeNotification = () => {
    setConflictNotification(null);
  };

  // Helper function to check if mod is installing (reactive - must access signal inside JSX)
  const isModInstalling = (modSlug: string, modSource: string): boolean => {
    const modId = `${modSource}:${modSlug}`;
    const key = `${props.instanceId}:${modId}`;
    return installingMods().has(key);
  };

  // Установить мод (всегда устанавливаем, потом проверяем конфликты)
  const handleInstall = async (modSlug: string, modSource: string, modName: string, versionId?: string) => {
    // Check if already installing using global store
    if (isModInstalling(modSlug, modSource)) return;

    try {
      // Вызываем onInstall который использует глобальный store для tracking
      await props.onInstall(modSlug, modSource, modName, versionId);

      // После установки проверяем конфликты
      try {
        const prediction = await invoke<ConflictPredictionResult>("predict_mod_conflicts", {
          modSlug,
          instanceId: props.instanceId,
          loader: props.loader,
        });

        // Если есть конфликты - показываем уведомление
        if (prediction.conflicts.length > 0) {
          setConflictNotification({
            show: true,
            modName,
            conflicts: prediction.conflicts,
          });
        }
      } catch (e) {
        if (import.meta.env.DEV) console.error("Failed to check conflicts:", e);
      }
    } catch (error) {
      if (import.meta.env.DEV) console.error("Failed to install mod:", error);
    }
  };

  const isModInstalled = (modSlug: string, modSource: string) => {
    return props.installedMods().some(
      (m) => m.slug === modSlug && m.source === modSource
    );
  };

  // Debounce search query with automatic cleanup
  createEffect(() => {
    const query = searchQuery();
    debounceSearch(() => {
      setDebouncedSearchQuery(query);
      setPage(0);
    }, 300);
  });

  // Memoized search key to prevent duplicate API calls
  const searchKey = createMemo(() => {
    const query = debouncedSearchQuery();
    const category = selectedCategory();
    const currentPage = page();
    const currentSource = source();
    const currentSearchMode = searchMode();
    const currentSortBy = sortBy();
    const incompatible = showIncompatible();

    return JSON.stringify({
      query,
      category,
      page: currentPage,
      source: currentSource,
      mode: currentSearchMode,
      sort: currentSortBy,
      showIncompatible: incompatible,
    });
  });

  // Perform search only when search key changes
  createEffect(() => {
    const key = searchKey();
    const parsed = JSON.parse(key);

    // When query is empty, default to showing popular mods (sorted by downloads)
    const effectiveSort = parsed.query ? parsed.sort : "downloads";

    // When showIncompatible is true, don't filter by version/loader
    const mcVersion = parsed.showIncompatible ? undefined : props.minecraftVersion;
    const loader = parsed.showIncompatible ? undefined : props.loader;

    modSearch.search(
      parsed.query || "",
      mcVersion,
      loader,
      parsed.source as ModSource,
      limit,
      parsed.page * limit,
      parsed.mode,
      effectiveSort
    );
  });

  const handleCategorySelect = (categoryId: string | null) => {
    setSelectedCategory(categoryId);
    setPage(0);
  };

  return (
    <div class="flex flex-col gap-4 flex-1 min-h-0">
      {/* Conflict Notification - показывается после установки */}
      <Show when={conflictNotification()?.show}>
        <div class="card border-red-600/50 bg-red-600/10 flex items-start gap-3">
          <i class="i-hugeicons-alert-02 w-10 h-10 p-2.5 rounded-2xl bg-red-600/20 text-red-400 flex-shrink-0" />
          <div class="flex-1">
            <h3 class="font-semibold text-red-400">
              {t().conflictPredictor.dangerTitle}
            </h3>
            <p class="text-sm text-muted mt-1">
              <span class="font-medium text-white">{conflictNotification()!.modName}</span> {t().mods?.browser?.conflictInstalled ?? "installed, but conflicts detected:"}
            </p>

            {/* Список конфликтов */}
            <div class="mt-3 flex flex-col gap-2">
              <For each={conflictNotification()!.conflicts}>
                {(conflict) => (
                  <div class={`p-2 rounded-2xl border text-sm ${getSeverityColor(conflict.severity)}`}>
                    <p class="font-medium">{conflict.title}</p>
                    <p class="text-xs opacity-80 mt-1">{conflict.description}</p>

                    {/* Кнопка автофикса */}
                    <Show when={conflict.conflicting_mod && props.onRemoveMod}>
                      <button
                        class="btn-danger mt-2"
                        data-size="sm"
                        onClick={() => handleAutoFix(conflict.conflicting_mod!)}
                      >
                        <i class="i-hugeicons-delete-02 w-4 h-4" />
                        {t().mods?.browser?.deleteMod ?? "Delete"} {conflict.conflicting_mod}
                      </button>
                    </Show>
                  </div>
                )}
              </For>
            </div>

            {/* Действия */}
            <div class="flex gap-2 mt-4">
              <Show when={props.onSwitchToInstalled}>
                <button class="btn-secondary" data-size="sm" onClick={handleGoToInstalled}>
                  <i class="i-hugeicons-menu-01 w-4 h-4" />
                  {t().mods?.browser?.goToInstalled ?? "Go to installed"}
                </button>
              </Show>
              <button class="btn-ghost" data-size="sm" onClick={closeNotification}>
                {t().common.close}
              </button>
            </div>
          </div>
        </div>
      </Show>

      {/* Recommendations Section */}
      <ModRecommendations
        instanceId={props.instanceId}
        minecraftVersion={props.minecraftVersion}
        loader={props.loader}
        installedMods={props.installedMods}
        onInstall={props.onInstall}
      />

      {/* Search & Filters */}
      <div class="card">
        <div class="flex flex-col gap-4">
          {/* Source Toggle */}
          <div class="flex gap-2">
            <button
              class={`flex-1 px-4 py-2 rounded-2xl font-medium transition-colors duration-100 ${
                source() === "modrinth"
                  ? "bg-green-600 text-white"
                  : "bg-gray-800 text-gray-300 hover:bg-gray-750"
              }`}
              onClick={() => { setSource("modrinth"); setPage(0); }}
            >
              Modrinth
            </button>
            <button
              class={`flex-1 px-4 py-2 rounded-2xl font-medium transition-colors duration-100 ${
                source() === "curseforge"
                  ? "bg-orange-600 text-white"
                  : "bg-gray-800 text-gray-300 hover:bg-gray-750"
              }`}
              onClick={() => { setSource("curseforge"); setPage(0); }}
            >
              CurseForge
            </button>
          </div>

          {/* Search Input */}
          <div class="flex flex-col gap-2">
            <div class="flex gap-2">
              <div class="flex-1">
                <input
                  type="text"
                  value={searchQuery()}
                  onInput={(e) => setSearchQuery(e.currentTarget.value)}
                  placeholder={
                    searchMode() === "name"
                      ? (t().mods?.browser?.searchByName ?? "Search by mod name...")
                      : searchMode() === "id"
                        ? (t().mods?.browser?.searchById ?? "Search by mod ID (e.g.: jei, create)...")
                        : (t().mods?.browser?.searchAll ?? "Search by name or mod ID...")
                  }
                  class="w-full pl-10"
                />
                <i class="i-hugeicons-search-01 absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-500" />
              </div>

              <Select
                value={sortBy()}
                onChange={(val) => { setSortBy(val); setPage(0); }}
                options={sortOptions()}
                class="w-48"
              />
            </div>

            {/* Search Mode Toggle */}
            <div class="flex items-center justify-between gap-4 flex-wrap">
              <div class="flex items-center gap-4">
                <span class="text-sm text-muted">{t().mods?.browser?.searchBy ?? "Search by:"}</span>
                <div class="flex gap-2">
                  <button
                    class={`px-3 py-1 rounded-2xl text-sm font-medium transition-colors duration-100 ${
                      searchMode() === "name"
                        ? "bg-[var(--color-primary)] text-white"
                        : "bg-gray-800 text-gray-300 hover:bg-gray-750"
                    }`}
                    onClick={() => { setSearchMode("name"); setPage(0); }}
                  >
                    <i class="i-hugeicons-text-font w-4 h-4" />
                    {t().mods?.browser?.searchByNameBtn ?? "Name"}
                  </button>
                  <button
                    class={`px-3 py-1 rounded-2xl text-sm font-medium transition-colors duration-100 ${
                      searchMode() === "id"
                        ? "bg-[var(--color-primary)] text-white"
                        : "bg-gray-800 text-gray-300 hover:bg-gray-750"
                    }`}
                    onClick={() => { setSearchMode("id"); setPage(0); }}
                  >
                    <i class="i-hugeicons-user-account w-4 h-4" />
                    {t().mods?.browser?.searchByIdBtn ?? "Mod ID"}
                  </button>
                  <button
                    class={`px-3 py-1 rounded-2xl text-sm font-medium transition-colors duration-100 ${
                      searchMode() === "all"
                        ? "bg-[var(--color-primary)] text-white"
                        : "bg-gray-800 text-gray-300 hover:bg-gray-750"
                    }`}
                    onClick={() => { setSearchMode("all"); setPage(0); }}
                  >
                    <i class="i-hugeicons-search-02 w-4 h-4" />
                    {t().mods?.browser?.searchByAllBtn ?? "All"}
                  </button>
                </div>
              </div>

              {/* Show incompatible mods checkbox */}
              <label class="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showIncompatible()}
                  onChange={(e) => { setShowIncompatible(e.currentTarget.checked); setPage(0); }}
                  class="w-4 h-4 rounded border-gray-600 bg-gray-800 focus:ring-[var(--color-primary)] focus:ring-offset-gray-900"
                />
                <span class="text-sm text-muted">{t().mods?.browser?.showIncompatible ?? "Show incompatible"}</span>
              </label>
            </div>
          </div>

          {/* Categories Toggle */}
          <button
            class="btn-ghost"
            data-size="sm"
            onClick={() => setShowCategories(!showCategories())}
          >
            <i class={`w-4 h-4 transition-transform duration-100 ${showCategories() ? "i-hugeicons-arrow-up-01" : "i-hugeicons-arrow-down-01"}`} />
            {showCategories() ? (t().mods?.browser?.hideCategories ?? "Hide categories") : (t().mods?.browser?.showCategories ?? "Show categories")}
          </button>

          {/* Categories Grid */}
          <Show when={showCategories()}>
            <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
              <button
                class={`px-3 py-2 rounded-2xl text-sm font-medium transition-colors duration-100 flex items-center gap-2 ${
                  selectedCategory() === null
                    ? "bg-[var(--color-primary)] text-white"
                    : "bg-gray-800 text-gray-300 hover:bg-gray-750"
                }`}
                onClick={() => handleCategorySelect(null)}
              >
                <i class="i-hugeicons-grid w-4 h-4" />
                {t().mods?.browser?.allCategories ?? "All"}
              </button>
              <For each={CATEGORY_IDS}>
                {(cat) => (
                  <button
                    class={`px-3 py-2 rounded-2xl text-sm font-medium transition-colors duration-100 flex items-center gap-2 ${
                      selectedCategory() === cat.id
                        ? "bg-[var(--color-primary)] text-white"
                        : "bg-gray-800 text-gray-300 hover:bg-gray-750"
                    }`}
                    onClick={() => handleCategorySelect(cat.id)}
                  >
                    <i class={`${cat.icon} w-4 h-4`} />
                    {getCategoryName(cat.id)}
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>

      {/* Loading */}
      <Show when={modSearch.loading()}>
        <div class="flex-center gap-3 py-12">
          <i class="i-svg-spinners-6-dots-scale w-8 h-8" />
          <span class="text-muted">{t().mods?.browser?.searching ?? "Searching mods..."}</span>
        </div>
      </Show>

      {/* Error */}
      <Show when={modSearch.error()}>
        <div class="card bg-red-600/10 border-red-600/30">
          <div class="flex items-start gap-3">
            <i class="i-hugeicons-alert-02 text-red-400 w-5 h-5" />
            <div class="flex-1">
              <p class="text-red-400 text-sm">{modSearch.error()}</p>
            </div>
          </div>
        </div>
      </Show>

      {/* Empty State */}
      <Show when={!modSearch.loading() && modSearch.results().length === 0 && !modSearch.error()}>
        <div class="card flex-col-center py-16 text-center">
          <i class="i-hugeicons-search-02 w-16 h-16 text-gray-600 mb-4" />
          <h3 class="text-lg font-medium mb-2">{t().mods?.browser?.noResults ?? "Nothing found"}</h3>
          <p class="text-sm text-muted max-w-md">
            {t().mods?.browser?.noResultsHint ?? "Try changing your query or select a different category"}
          </p>
        </div>
      </Show>

      {/* Results Grid */}
      <Show when={!modSearch.loading() && modSearch.results().length > 0}>
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <For each={modSearch.results()}>
            {(mod) => {
              const modId = getModId(mod, source());
              // Note: isModInstalling and isModInstalled are called directly in JSX for reactivity
              // SolidJS tracks signal dependencies only when accessed in reactive context (JSX)

              return (
                <div
                  class="card-hover flex flex-col gap-3 cursor-pointer"
                  onClick={() => openModPreview(mod)}
                >
                  <div class="flex items-start gap-3">
                    <Show when={isVisible("modThumbnails") && sanitizeImageUrl(mod.icon_url || mod.logo?.url)}>
                      <img
                        src={sanitizeImageUrl(mod.icon_url || mod.logo?.url)!}
                        alt={mod.title || mod.name}
                        class="w-16 h-16 rounded-2xl object-cover flex-shrink-0"
                        onError={(e) => { e.currentTarget.style.display = "none"; }}
                      />
                    </Show>
                    <div class="flex-1 min-w-0">
                      <h3 class="font-semibold truncate">{mod.title || mod.name}</h3>
                      <Show when={mod.author}>
                        <p class="text-xs text-muted">{t().mods?.browser?.byAuthor ?? "by"} {mod.author}</p>
                      </Show>
                      <p class="text-xs text-gray-500 font-mono truncate">{mod.slug || mod.id}</p>
                    </div>
                  </div>

                  <Show when={isVisible("modDescriptions")}>
                    <p class="text-sm text-muted line-clamp-3 mb-3 flex-1">
                      {mod.description || mod.summary}
                    </p>
                  </Show>

                  <div class="flex items-center gap-2 flex-wrap mb-3">
                    <Show when={mod._exact_match}>
                      <span class="badge badge-sm bg-green-600/20 text-green-400">
                        <i class="i-hugeicons-checkmark-circle-02 w-3 h-3" />
                        {t().mods?.browser?.matchedById ?? "By ID"}
                      </span>
                    </Show>
                    <span class="badge badge-sm">
                      <i class="i-hugeicons-download-02 w-3 h-3" />
                      {mod.downloads?.toLocaleString() || 0}
                    </span>
                    <Show when={mod.categories?.length}>
                      <span class="badge badge-sm bg-blue-600/20 text-blue-400">
                        {mod.categories![0]}
                      </span>
                    </Show>
                  </div>

                  <button
                    class={`btn-primary w-full transition-colors duration-100 ${
                      isModInstalled(modId, source()) ? "btn-secondary" : isModInstalling(modId, source()) ? "opacity-50" : ""
                    }`}
                    onClick={(e) => {
                      e.stopPropagation(); // Prevent card click
                      if (!isModInstalled(modId, source()) && !isModInstalling(modId, source())) {
                        handleInstall(modId, source(), mod.title || mod.name || modId);
                      }
                    }}
                    disabled={isModInstalled(modId, source()) || isModInstalling(modId, source())}
                  >
                    <Show when={isModInstalling(modId, source())} fallback={
                      isModInstalled(modId, source()) ? (
                        <>
                          <i class="i-hugeicons-checkmark-circle-02 w-4 h-4" />
                          {t().mods.installed}
                        </>
                      ) : (
                        <>
                          <i class="i-hugeicons-download-02 w-4 h-4" />
                          {t().common.install}
                        </>
                      )
                    }>
                      <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                      {t().mods.installing}...
                    </Show>
                  </button>
                </div>
              );
            }}
          </For>
        </div>

        {/* Pagination - sticky at bottom */}
        <div class="sticky bottom-0 pt-4 pb-2 bg-gradient-to-t from-gray-950 via-gray-950/95 to-transparent">
          <Pagination
            currentPage={page()}
            totalPages={Math.ceil(modSearch.totalHits() / limit)}
            onPageChange={setPage}
          />
        </div>
      </Show>

      {/* Mod Preview Dialog - Universal ProjectInfoDialog */}
      <Show when={previewMod()}>
        {/* Show loading state while fetching data */}
        <Show when={previewLoading()}>
          <div class="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center">
            <div class="bg-gray-850 border border-gray-750 rounded-2xl p-8 flex items-center gap-3">
              <i class="i-svg-spinners-6-dots-scale w-6 h-6 text-[var(--color-primary)]" />
              <span class="text-gray-300">{t().common?.loading ?? "Loading..."}</span>
            </div>
          </div>
        </Show>

        {/* Show dialog when data loaded */}
        <Show when={!previewLoading()}>
          <ProjectInfoDialog
            project={toProjectInfo(previewMod()!, previewWiki(), source())}
            onClose={closeModPreview}
            versionsData={previewVersions()}
            minecraftVersion={props.minecraftVersion}
            loaderType={props.loader}
            onInstallVersion={handleInstallVersion}
            isInstalled={isModInstalled(previewMod()?.slug || previewMod()?.id?.toString() || "", source())}
            installing={previewInstalling()}
            contentFormat={source() === "curseforge" ? "html" : "markdown"}
          />
        </Show>
      </Show>
    </div>
  );
};

export default ModsBrowser;
