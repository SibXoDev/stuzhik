import { createSignal, Show, For, JSX, onMount, onCleanup, createEffect, createMemo } from "solid-js";
import type { ProjectInfo, ProjectType, VersionChangelog } from "../types/common.types";
import { useI18n } from "../i18n";
import { sanitizeImageUrl } from "../utils/url-validator";
import { openUrl } from "@tauri-apps/plugin-opener";
import { MarkdownRenderer, HtmlRenderer } from "./MarkdownRenderer";
import { ModalWrapper } from "../ui";

export interface ProjectInfoDialogProps {
  /** Project info to display */
  project: ProjectInfo;
  /** Close handler */
  onClose: () => void;
  /** Install handler (optional - shows install button if provided) */
  onInstall?: () => void;
  /** Whether the project is already installed */
  isInstalled?: boolean;
  /** Loading state for install button */
  installing?: boolean;
  /** Custom action slot (for additional buttons) */
  actions?: () => JSX.Element;
  /** Category click handler (for search/filter) */
  onCategoryClick?: (category: string) => void;

  // === Version Selector Props (for catalog mode) ===
  /** Available versions with changelog data */
  versionsData?: VersionChangelog[];
  /** Minecraft version for compatibility checking */
  minecraftVersion?: string;
  /** Loader type for compatibility checking */
  loaderType?: string;
  /** Install handler with specific version (called instead of onInstall when version selected) */
  onInstallVersion?: (versionId: string) => Promise<void>;
  /** Content format for body (markdown/html) - defaults to markdown */
  contentFormat?: "markdown" | "html";
}

/** Get icon for project type */
function getProjectTypeIcon(type: ProjectType): string {
  switch (type) {
    case "mod":
      return "i-hugeicons-package";
    case "modpack":
      return "i-hugeicons-hierarchy";
    case "shader":
      return "i-hugeicons-flash";
    case "resourcepack":
      return "i-hugeicons-image-01";
    default:
      return "i-hugeicons-package";
  }
}

/** Format large numbers (downloads, followers) */
function formatCount(count: number | undefined): string {
  if (!count) return "0";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return count.toString();
}

/** Format file size */
function formatSize(bytes: number | undefined): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** Get version type badge class */
function getVersionTypeBadge(type?: string | null): string {
  if (!type) return "";
  switch (type.toLowerCase()) {
    case "release":
      return "bg-green-600/20 text-green-400 border-green-600/30";
    case "beta":
      return "bg-yellow-600/20 text-yellow-400 border-yellow-600/30";
    case "alpha":
      return "bg-red-600/20 text-red-400 border-red-600/30";
    default:
      return "bg-gray-600/20 text-gray-400 border-gray-600/30";
  }
}

export function ProjectInfoDialog(props: ProjectInfoDialogProps) {
  const { t } = useI18n();
  const [selectedImage, setSelectedImage] = createSignal<string | null>(null);
  const [showFullBody, setShowFullBody] = createSignal(false);
  const [showAllVersions, setShowAllVersions] = createSignal(false);
  const [selectedVersion, setSelectedVersion] = createSignal<VersionChangelog | null>(null);
  const [showAllVersionsData, setShowAllVersionsData] = createSignal(false);
  const [hideIncompatible, setHideIncompatible] = createSignal(true); // По умолчанию скрываем

  // Check if version is compatible with instance settings
  const isVersionCompatible = (v: VersionChangelog): boolean => {
    if (!props.minecraftVersion || !props.loaderType) return true;

    // If no game_versions or loaders data, consider compatible (can't determine)
    if (v.game_versions.length === 0 || v.loaders.length === 0) return true;

    const instanceMC = props.minecraftVersion!.toLowerCase();
    // MC version compatible: exact match OR one contains the other (for 1.20 vs 1.20.1)
    const mcCompatible = v.game_versions.some(gv => {
      const gameVer = gv.toLowerCase();
      return gameVer === instanceMC || gameVer.startsWith(instanceMC) || instanceMC.startsWith(gameVer);
    });

    // Loader compatible: case-insensitive match
    const instanceLoader = props.loaderType!.toLowerCase();
    const loaderCompatible = v.loaders.some(l => l.toLowerCase() === instanceLoader);

    return mcCompatible && loaderCompatible;
  };

  // Auto-select first compatible version when versionsData changes
  createEffect(() => {
    const versions = props.versionsData;
    if (versions && versions.length > 0 && !selectedVersion()) {
      const compatible = versions.find(v => isVersionCompatible(v));
      setSelectedVersion(compatible || versions[0]);
    }
  });

  // Check if filtering makes sense (only when we have mc version and loader)
  const canFilterCompatibility = () => !!props.minecraftVersion && !!props.loaderType;

  // Displayed versions (filtered by compatibility, then limited or all)
  const displayedVersionsData = createMemo(() => {
    let versions = props.versionsData || [];

    // Filter incompatible if checkbox is checked and we can filter
    if (hideIncompatible() && canFilterCompatibility()) {
      versions = versions.filter(v => isVersionCompatible(v));
    }

    if (showAllVersionsData() || versions.length <= 5) return versions;
    return versions.slice(0, 5);
  });

  // Total count for "show all" button (respecting filter)
  const totalVersionsCount = createMemo(() => {
    let versions = props.versionsData || [];
    if (hideIncompatible() && canFilterCompatibility()) {
      versions = versions.filter(v => isVersionCompatible(v));
    }
    return versions.length;
  });

  // Has version selector mode
  const hasVersionSelector = () => props.versionsData && props.versionsData.length > 0;

  // ESC key to close image preview
  onMount(() => {
    const handleKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && selectedImage()) {
        setSelectedImage(null);
      }
    };
    window.addEventListener("keydown", handleKeydown);
    onCleanup(() => window.removeEventListener("keydown", handleKeydown));
  });

  const handleOpenExternal = async (url: string) => {
    try {
      await openUrl(url);
    } catch (e) {
      console.error("Failed to open URL:", e);
    }
  };

  // Check if body is long (more than 500 chars)
  const isBodyLong = () => (props.project.body?.length ?? 0) > 500;

  // Get versions to display (limited or all)
  const displayVersions = () => {
    const versions = props.project.versions;
    if (showAllVersions() || versions.length <= 20) {
      return versions;
    }
    return versions.slice(0, 20);
  };

  return (
    <ModalWrapper backdrop onBackdropClick={props.onClose} maxWidth="max-w-6xl">
      <div class="p-6 flex flex-col max-h-full overflow-hidden">
        {/* Header */}
        <div class="flex items-start gap-4 mb-4 flex-shrink-0">
          <Show
            when={sanitizeImageUrl(props.project.icon_url)}
            fallback={
              <div class="w-20 h-20 rounded-xl bg-gray-700 flex items-center justify-center flex-shrink-0">
                <i class={`w-8 h-8 text-gray-400 ${getProjectTypeIcon(props.project.projectType)}`} />
              </div>
            }
          >
            <img
              src={sanitizeImageUrl(props.project.icon_url)!}
              alt={props.project.title}
              class="w-20 h-20 rounded-xl object-cover flex-shrink-0"
              onError={(e) => {
                e.currentTarget.style.display = "none";
              }}
            />
          </Show>

          <div class="flex-1 min-w-0">
            <div class="flex items-start justify-between gap-4">
              <div class="flex-1 min-w-0">
                <h2 class="text-2xl font-bold mb-1">{props.project.title}</h2>
                <p class="text-muted mb-2">от {props.project.author || "Unknown"}</p>
                {/* Links in header */}
                <div class="flex items-center gap-2 flex-wrap">
                  <Show when={props.project.source && props.project.source !== "local"}>
                    <span class={`badge ${props.project.source === "modrinth" ? "badge-success" : "bg-orange-600/20 text-orange-400 border-orange-600/30"}`}>
                      {props.project.source === "modrinth" ? "Modrinth" : "CurseForge"}
                    </span>
                  </Show>
                  <Show when={props.project.links?.source}>
                    <button
                      class="flex items-center gap-1.5 px-2 py-1 bg-gray-700/50 border border-gray-600/50 rounded-xl text-xs text-gray-300 hover:bg-gray-700 transition-colors"
                      onClick={() => handleOpenExternal(props.project.links.source!)}
                    >
                      <i class="i-hugeicons-github w-3.5 h-3.5" />
                      GitHub
                    </button>
                  </Show>
                  <Show when={props.project.links?.discord}>
                    <button
                      class="flex items-center gap-1.5 px-2 py-1 bg-indigo-600/20 border border-indigo-600/30 rounded-xl text-xs text-indigo-300 hover:bg-indigo-600/30 transition-colors"
                      onClick={() => handleOpenExternal(props.project.links.discord!)}
                    >
                      <i class="i-hugeicons-discord w-3.5 h-3.5" />
                      Discord
                    </button>
                  </Show>
                  <Show when={props.project.links?.wiki}>
                    <button
                      class="flex items-center gap-1.5 px-2 py-1 bg-gray-700/50 border border-gray-600/50 rounded-xl text-xs text-gray-300 hover:bg-gray-700 transition-colors"
                      onClick={() => handleOpenExternal(props.project.links.wiki!)}
                    >
                      <i class="i-hugeicons-book-01 w-3.5 h-3.5" />
                      Wiki
                    </button>
                  </Show>
                  <Show when={props.project.links?.issues}>
                    <button
                      class="flex items-center gap-1.5 px-2 py-1 bg-gray-700/50 border border-gray-600/50 rounded-xl text-xs text-gray-300 hover:bg-gray-700 transition-colors"
                      onClick={() => handleOpenExternal(props.project.links.issues!)}
                    >
                      <i class="i-hugeicons-alert-02 w-3.5 h-3.5" />
                      Issues
                    </button>
                  </Show>
                </div>
              </div>
              <button
                class="btn-close"
                onClick={() => props.onClose()}
                title={t().common?.close ?? "Close"}
              >
                <i class="i-hugeicons-cancel-01 w-5 h-5" />
              </button>
            </div>

            <div class="flex items-center gap-3 mt-3 flex-wrap">
              <Show when={props.project.downloads}>
                <span class="badge badge-gray">
                  <i class="i-hugeicons-download-02 w-3 h-3" />
                  {formatCount(props.project.downloads)} загрузок
                </span>
              </Show>
              <Show when={props.project.followers}>
                <span class="badge badge-gray">
                  <i class="i-hugeicons:user-love-01 w-3 h-3" />
                  {formatCount(props.project.followers)} подписчиков
                </span>
              </Show>
            </div>
          </div>
        </div>

        {/* Content */}
        <div class="overflow-y-auto flex-1 space-y-6">
          {/* Short Description */}
          <div>
            <p class="text-white text-sm leading-relaxed">
              {props.project.description}
            </p>
          </div>

          {/* Full Body/Description with Show More */}
          <Show when={props.project.body && props.project.body !== props.project.description}>
            <div>
              <h3 class="text-sm font-medium text-gray-400 mb-2">
                {t().wiki?.about ?? "About"}
              </h3>
              <div
                class={`bg-gray-800/50 rounded-xl p-4 overflow-hidden transition-all ${
                  !showFullBody() && isBodyLong() ? "max-h-48" : ""
                }`}
              >
                <Show
                  when={props.contentFormat === "html"}
                  fallback={<MarkdownRenderer content={props.project.body!} />}
                >
                  <HtmlRenderer content={props.project.body!} />
                </Show>
              </div>
              <Show when={isBodyLong()}>
                <button
                  class="mt-2 text-sm text-blue-400 hover:text-blue-300 flex items-center gap-1 transition-colors"
                  onClick={() => setShowFullBody(!showFullBody())}
                >
                  <i
                    class={`w-4 h-4 transition-transform ${
                      showFullBody() ? "i-hugeicons-arrow-up-01" : "i-hugeicons-arrow-down-01"
                    }`}
                  />
                  {showFullBody()
                    ? t().common?.showLess ?? "Show less"
                    : t().common?.showMore ?? "Show more"}
                </button>
              </Show>
            </div>
          </Show>

          {/* Categories - Clickable */}
          <Show when={props.project.categories.length > 0}>
            <div>
              <h3 class="text-sm font-medium text-gray-400 mb-2">
                {t().wiki?.categories ?? "Categories"}
              </h3>
              <div class="flex flex-wrap gap-2">
                <For each={props.project.categories}>
                  {(category) => (
                    <button
                      class="px-2 py-1 bg-gray-800/50 border border-gray-700/50 rounded-2xl text-xs text-gray-300 capitalize hover:bg-gray-700/50 hover:border-gray-600/50 transition-colors cursor-pointer"
                      onClick={() => props.onCategoryClick?.(category)}
                      title={props.onCategoryClick ? `Search for ${category}` : undefined}
                    >
                      {category.replace(/-/g, " ")}
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>

          {/* Supported Versions - Expandable */}
          <Show when={props.project.versions.length > 0}>
            <div>
              <h3 class="text-sm font-medium text-gray-400 mb-2">
                {t().resources?.supportedVersions ?? "Supported Versions"}
              </h3>
              <div class="flex flex-wrap gap-1.5">
                <For each={displayVersions()}>
                  {(version) => (
                    <span class="px-2 py-0.5 bg-blue-600/20 border border-blue-600/30 rounded text-xs text-blue-300">
                      {version}
                    </span>
                  )}
                </For>
                <Show when={props.project.versions.length > 20}>
                  <button
                    class="px-2 py-0.5 bg-gray-700/50 hover:bg-gray-600/50 rounded text-xs text-gray-400 hover:text-gray-300 transition-colors cursor-pointer"
                    onClick={() => setShowAllVersions(!showAllVersions())}
                  >
                    {showAllVersions()
                      ? t().common?.showLess ?? "Show less"
                      : `+${props.project.versions.length - 20} ${t().common?.more ?? "more"}`}
                  </button>
                </Show>
              </div>
            </div>
          </Show>

          {/* Gallery */}
          <Show when={props.project.gallery && props.project.gallery.length > 0}>
            <div>
              <h3 class="text-sm font-medium text-gray-400 mb-2">
                {t().wiki?.gallery ?? "Gallery"}
              </h3>
              <div class="grid grid-cols-3 gap-2">
                <For each={props.project.gallery}>
                  {(image) => (
                    <button
                      class="aspect-video rounded-xl overflow-hidden border-2 border-transparent hover:border-blue-500 transition-colors p-0"
                      onClick={() => setSelectedImage(image.url)}
                    >
                      <img
                        src={image.url}
                        alt={image.title ?? "Screenshot"}
                        class="w-full h-full object-cover"
                        loading="lazy"
                      />
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>

          {/* Version Selector (for catalog/install mode) */}
          <Show when={hasVersionSelector()}>
            <div class="pt-4 border-t border-gray-700/50">
              <div class="flex items-center justify-between mb-3">
                <h3 class="text-sm font-medium text-gray-400">
                  {t().wiki?.versions ?? "Versions"}
                </h3>
                {/* Filter checkbox - only show when we can filter */}
                <Show when={canFilterCompatibility()}>
                  <label class="flex items-center gap-2 text-xs text-gray-400 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={hideIncompatible()}
                      onChange={(e) => setHideIncompatible(e.currentTarget.checked)}
                    />
                    {(t() as any).mods?.hideIncompatible ?? "Скрыть несовместимые"}
                  </label>
                </Show>
              </div>
              <div class="space-y-2 max-h-[300px] overflow-y-auto pr-1">
                <For each={displayedVersionsData()}>
                  {(version, index) => {
                    const compatible = isVersionCompatible(version);
                    const isFirstRelease = () =>
                      index() === 0 &&
                      version.version_type?.toLowerCase() === "release" &&
                      compatible;

                    return (
                      <button
                        class={`w-full text-left p-3 rounded-2xl border transition-colors duration-100 flex gap-3 ${
                          selectedVersion()?.id === version.id
                            ? "bg-blue-600/20 border-blue-600/50"
                            : compatible
                              ? "bg-gray-800/50 border-gray-700 hover:border-gray-600"
                              : "bg-gray-800/30 border-gray-800 opacity-60"
                        }`}
                        onClick={() => setSelectedVersion(version)}
                      >
                        {/* Radio button */}
                        <div
                          class={`w-5 h-5 rounded-full border-2 flex-shrink-0 flex items-center justify-center mt-0.5 ${
                            selectedVersion()?.id === version.id
                              ? "border-blue-500 bg-blue-500"
                              : "border-gray-500"
                          }`}
                        >
                          <Show when={selectedVersion()?.id === version.id}>
                            <i class="i-hugeicons-checkmark-circle-02 w-3 h-3 text-white" />
                          </Show>
                        </div>

                        {/* Content */}
                        <div class="flex-1 min-w-0">
                          <div class="flex items-start justify-between gap-2 mb-1">
                            <div class="min-w-0 flex items-center gap-2">
                              <div>
                                <p class="font-medium truncate">{version.version_name}</p>
                                <p class="text-xs text-gray-500">{version.version_number}</p>
                              </div>
                              {/* Рекомендовано badge */}
                              <Show when={isFirstRelease()}>
                                <span class="px-2 py-0.5 text-xs rounded bg-emerald-600/20 text-emerald-400 border border-emerald-600/30 flex-shrink-0 flex items-center gap-1">
                                  <i class="i-hugeicons-star w-3 h-3" />
                                  Рекомендовано
                                </span>
                              </Show>
                            </div>
                            <div class="flex-shrink-0 text-right text-xs text-gray-500">
                              <p>{formatSize(version.file_size)}</p>
                              <p>{version.downloads.toLocaleString()} {t().mods?.downloads ?? "downloads"}</p>
                            </div>
                          </div>

                          {/* Tags */}
                          <div class="flex flex-wrap items-center gap-1.5 mt-2">
                            {/* Compatibility indicator */}
                            <Show when={compatible}>
                              <span class="px-2 py-0.5 text-xs rounded bg-green-600/20 text-green-400 border border-green-600/30 flex items-center gap-1">
                                <i class="i-hugeicons-checkmark-circle-02 w-3 h-3" />
                                Совместим
                              </span>
                            </Show>
                            <Show when={!compatible}>
                              <span class="px-2 py-0.5 text-xs rounded bg-orange-600/20 text-orange-400 border border-orange-600/30 flex items-center gap-1">
                                <i class="i-hugeicons-alert-02 w-3 h-3" />
                                {(t() as any).mods?.incompatible ?? "Несовместим"}
                              </span>
                            </Show>

                            <Show when={version.version_type}>
                              <span
                                class={`px-2 py-0.5 text-xs rounded border ${getVersionTypeBadge(version.version_type)}`}
                              >
                                {version.version_type}
                              </span>
                            </Show>
                            <For each={version.loaders.slice(0, 3)}>
                              {(loader) => (
                                <span class="px-2 py-0.5 text-xs rounded bg-blue-600/20 text-blue-400 border border-blue-600/30">
                                  {loader}
                                </span>
                              )}
                            </For>
                            <span class="px-2 py-0.5 text-xs rounded bg-gray-700/50 text-gray-300 border border-gray-600/30">
                              MC {version.game_versions[0]}
                              {version.game_versions.length > 1 && ` +${version.game_versions.length - 1}`}
                            </span>
                          </div>
                        </div>
                      </button>
                    );
                  }}
                </For>
              </div>
              <Show when={totalVersionsCount() > 5}>
                <button
                  class="mt-2 text-sm text-blue-400 hover:text-blue-300 flex items-center gap-1 transition-colors w-full justify-center"
                  onClick={() => setShowAllVersionsData(!showAllVersionsData())}
                >
                  <i
                    class={`w-4 h-4 ${showAllVersionsData() ? "i-hugeicons-arrow-up-01" : "i-hugeicons-arrow-down-01"}`}
                  />
                  {showAllVersionsData()
                    ? t().common?.showLess ?? "Show less"
                    : `${t().common?.showAll ?? "Show all"} (${totalVersionsCount()})`}
                </button>
              </Show>
            </div>
          </Show>

          {/* Installed Info (for installed items) */}
          <Show when={props.project.file_name || props.project.version}>
            <div class="pt-4 border-t border-gray-700/50">
              <h3 class="text-sm font-medium text-gray-400 mb-3">
                {t().wiki?.file ?? "File Info"}
              </h3>
              <div class="grid grid-cols-2 gap-4 text-sm">
                <Show when={props.project.version}>
                  <div>
                    <span class="text-gray-500">{t().wiki?.version ?? "Version"}:</span>
                    <span class="text-white ml-2">{props.project.version}</span>
                  </div>
                </Show>
                <Show when={props.project.file_name}>
                  <div>
                    <span class="text-gray-500">{t().wiki?.file ?? "File"}:</span>
                    <span class="text-white ml-2 font-mono text-xs">{props.project.file_name}</span>
                  </div>
                </Show>
                <Show when={props.project.file_size}>
                  <div>
                    <span class="text-gray-500">{t().wiki?.size ?? "Size"}:</span>
                    <span class="text-white ml-2">{formatSize(props.project.file_size)}</span>
                  </div>
                </Show>
                <Show when={props.project.enabled !== undefined}>
                  <div class="flex items-center gap-2">
                    <i
                      class={`w-4 h-4 ${
                        props.project.enabled
                          ? "i-hugeicons-checkmark-circle-02 text-green-400"
                          : "i-hugeicons-cancel-circle text-red-400"
                      }`}
                    />
                    <span class="text-gray-400">
                      {props.project.enabled
                        ? t().wiki?.enabled ?? "Enabled"
                        : t().wiki?.disabled ?? "Disabled"}
                    </span>
                  </div>
                </Show>
              </div>
            </div>
          </Show>

          {/* Dates (for installed items) */}
          <Show when={props.project.installed_at || props.project.updated_at}>
            <div class="grid grid-cols-2 gap-4 pt-4 border-t border-gray-700/50">
              <Show when={props.project.installed_at}>
                <div>
                  <h3 class="text-sm font-medium text-gray-400 mb-1">
                    {t().wiki?.installedAt ?? "Installed"}
                  </h3>
                  <p class="text-white text-sm">
                    {new Date(props.project.installed_at!).toLocaleDateString()}
                  </p>
                </div>
              </Show>
              <Show when={props.project.updated_at}>
                <div>
                  <h3 class="text-sm font-medium text-gray-400 mb-1">
                    {t().wiki?.updatedAt ?? "Updated"}
                  </h3>
                  <p class="text-white text-sm">
                    {new Date(props.project.updated_at!).toLocaleDateString()}
                  </p>
                </div>
              </Show>
            </div>
          </Show>

          {/* License */}
          <Show when={props.project.license_name}>
            <div class="text-xs text-gray-500">
              {t().wiki?.license ?? "License"}: {props.project.license_name}
            </div>
          </Show>
        </div>

        {/* Footer with Install button */}
        <div class="flex items-center justify-between gap-4 mt-4 pt-4 border-t border-gray-700/50 flex-shrink-0">
          {/* Selected version info (when version selector is active) */}
          <div class="text-sm text-gray-400 flex items-center gap-2">
            <Show when={hasVersionSelector() && selectedVersion()}>
              <span>{t().wiki?.selectedVersion ?? "Selected"}:</span>
              <span class="font-medium text-white">{selectedVersion()!.version_name}</span>
              <span>({formatSize(selectedVersion()!.file_size)})</span>
            </Show>
          </div>

          <div class="flex items-center gap-2">
            {/* Custom actions slot */}
            <Show when={props.actions}>
              {props.actions!()}
            </Show>

            <button
              class="btn-secondary"
              onClick={() => props.onClose()}
            >
              {t().common?.close ?? "Close"}
            </button>

            {/* Install button - version selector mode */}
            <Show when={hasVersionSelector() && props.onInstallVersion}>
              <Show
                when={!props.isInstalled}
                fallback={
                  <span class="px-4 py-2 text-sm text-green-400 flex items-center gap-2">
                    <i class="i-hugeicons-checkmark-circle-02 w-4 h-4" />
                    {t().resources?.installed ?? "Installed"}
                  </span>
                }
              >
                <button
                  class="btn-primary flex items-center gap-2"
                  onClick={async () => {
                    if (selectedVersion()) {
                      await props.onInstallVersion?.(selectedVersion()!.id);
                    }
                  }}
                  disabled={props.installing || !selectedVersion()}
                >
                  <Show when={props.installing}>
                    <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                  </Show>
                  <Show when={!props.installing}>
                    <i class="i-hugeicons-download-02 w-4 h-4" />
                  </Show>
                  {props.installing
                    ? t().mods?.installing ?? "Installing..."
                    : t().common?.install ?? "Install"}
                </button>
              </Show>
            </Show>

            {/* Install button - simple mode (no version selector) */}
            <Show when={!hasVersionSelector() && props.onInstall}>
              <Show
                when={!props.isInstalled}
                fallback={
                  <span class="px-4 py-2 text-sm text-green-400 flex items-center gap-2">
                    <i class="i-hugeicons-checkmark-circle-02 w-4 h-4" />
                    {t().resources?.installed ?? "Installed"}
                  </span>
                }
              >
                <button
                  class="btn-primary flex items-center gap-2"
                  onClick={() => props.onInstall?.()}
                  disabled={props.installing}
                >
                  <Show when={props.installing}>
                    <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                  </Show>
                  {t().common?.install ?? "Install"}
                </button>
              </Show>
            </Show>
          </div>
        </div>
      </div>

      {/* Full-Screen Image Preview Modal */}
      <Show when={selectedImage()}>
        <div
          class="fixed inset-0 bg-black z-[100] flex items-center justify-center pt-10"
          onClick={() => setSelectedImage(null)}
        >
          {/* Image container - fills available space */}
          <img
            src={selectedImage()!}
            alt="Preview"
            class="max-w-full max-h-full object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          {/* Close button - positioned below TitleBar, away from window controls */}
          <button
            class="absolute top-14 right-4 p-2 bg-gray-800/80 rounded-xl text-white hover:bg-gray-700 transition-colors flex items-center gap-2"
            onClick={(e) => {
              e.stopPropagation();
              setSelectedImage(null);
            }}
          >
            <i class="i-hugeicons-cancel-01 w-5 h-5" />
            <span class="text-sm">ESC</span>
          </button>
          {/* Image title if available */}
          <Show when={props.project.gallery?.find(img => img.url === selectedImage())?.title}>
            <div class="absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 bg-gray-900/80 rounded-xl text-white text-sm max-w-md text-center">
              {props.project.gallery?.find(img => img.url === selectedImage())?.title}
            </div>
          </Show>
        </div>
      </Show>
    </ModalWrapper>
  );
}

export default ProjectInfoDialog;
