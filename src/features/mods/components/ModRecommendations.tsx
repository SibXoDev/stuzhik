import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import type { Component, Accessor } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { useModRecommendations } from "../hooks/useMods";
import { ProjectInfoDialog } from "../../../shared/components/ProjectInfoDialog";
import type { Mod, ModRecommendation, WikiContent, VersionChangelog, ProjectInfo } from "../../../shared/types";
import { useI18n } from "../../../shared/i18n";
import { useInstallingMods } from "../../../shared/stores";
import { sanitizeImageUrl } from "../../../shared/utils/url-validator";

interface Props {
  instanceId: string;
  minecraftVersion: string;
  loader: string;
  installedMods: Accessor<Mod[]>;
  onInstall: (slug: string, source: string) => Promise<void>;
}

// Иконки для причин рекомендации
const getReasonIcon = (reason: ModRecommendation["reason"]): string => {
  switch (reason.type) {
    case "same_category":
      return "i-hugeicons-folder-01";
    case "popular_with":
      return "i-hugeicons-user-group";
    case "addon_for":
      return "i-hugeicons-plug-01";
    case "trending":
      return "i-hugeicons-arrow-up-right-01";
    case "optimization":
      return "i-hugeicons-flash";
    case "common_dependency":
      return "i-hugeicons-link-01";
    default:
      return "i-hugeicons-star";
  }
};

// Цвет бейджа для причины
const getReasonColor = (reason: ModRecommendation["reason"]): string => {
  switch (reason.type) {
    case "optimization":
      return "bg-green-600/20 text-green-400";
    case "trending":
      return "bg-orange-600/20 text-orange-400";
    case "addon_for":
      return "bg-purple-600/20 text-purple-400";
    case "common_dependency":
      return "bg-blue-600/20 text-blue-400";
    default:
      return "bg-gray-600/20 text-gray-400";
  }
};

const ModRecommendations: Component<Props> = (props) => {
  const { t } = useI18n();
  const installingMods = useInstallingMods();

  // Preview state
  const [previewMod, setPreviewMod] = createSignal<ModRecommendation | null>(null);
  const [previewWiki, setPreviewWiki] = createSignal<WikiContent | null>(null);
  const [previewVersions, setPreviewVersions] = createSignal<VersionChangelog[]>([]);
  const [previewLoading, setPreviewLoading] = createSignal(false);
  const [previewInstalling, setPreviewInstalling] = createSignal(false);

  const recommendations = useModRecommendations(
    () => props.instanceId,
    () => props.minecraftVersion,
    () => props.loader
  );

  // Memoized count to track when installed mods change
  const installedModsCount = createMemo(() => props.installedMods().length);

  // Загружаем рекомендации когда меняется количество модов
  createEffect(() => {
    const count = installedModsCount();
    if (count > 0) {
      recommendations.loadRecommendations(8);
    }
  });

  const isInstalled = (slug: string): boolean => {
    return props.installedMods().some(m => m.slug === slug);
  };

  // Check if mod is currently installing (reactive - accesses signal)
  const isModInstalling = (slug: string): boolean => {
    const modId = `modrinth:${slug}`;
    const key = `${props.instanceId}:${modId}`;
    return installingMods().has(key);
  };

  const handleInstall = async (rec: ModRecommendation) => {
    await props.onInstall(rec.slug, "modrinth");
    // Перезагрузим рекомендации после установки
    recommendations.loadRecommendations(8);
  };

  // Convert recommendation to ProjectInfo
  const toProjectInfo = (rec: ModRecommendation, wiki: WikiContent | null): ProjectInfo => {
    const projectUrl = `https://modrinth.com/mod/${rec.slug}`;

    if (wiki) {
      return {
        slug: rec.slug,
        title: rec.name,
        description: rec.description,
        body: wiki.body,
        author: rec.author,
        icon_url: rec.icon_url,
        downloads: wiki.downloads || rec.downloads,
        followers: wiki.followers,
        categories: wiki.categories,
        versions: [],
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
        source: "modrinth",
        license_id: wiki.license?.id,
        license_name: wiki.license?.name,
      };
    }

    return {
      slug: rec.slug,
      title: rec.name,
      description: rec.description,
      author: rec.author,
      icon_url: rec.icon_url,
      downloads: rec.downloads,
      categories: [],
      versions: [],
      gallery: [],
      links: { project: projectUrl },
      projectType: "mod",
      source: "modrinth",
    };
  };

  // Load wiki and versions when preview mod changes
  const loadModPreviewData = async (rec: ModRecommendation) => {
    setPreviewLoading(true);
    setPreviewWiki(null);
    setPreviewVersions([]);

    try {
      const [wikiResult, versionsResult] = await Promise.allSettled([
        invoke<WikiContent>("get_mod_wiki", { slug: rec.slug, source: "modrinth", fileHash: null }),
        invoke<VersionChangelog[]>("get_mod_changelog", { slug: rec.slug, source: "modrinth", limit: 30, fileHash: null }),
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
  const openModPreview = (rec: ModRecommendation) => {
    setPreviewMod(rec);
    loadModPreviewData(rec);
  };

  // Close preview
  const closeModPreview = () => {
    setPreviewMod(null);
    setPreviewWiki(null);
    setPreviewVersions([]);
    setPreviewInstalling(false);
  };

  // Install specific version from preview
  const handleInstallVersion = async (_versionId: string) => {
    const mod = previewMod();
    if (!mod) return;

    setPreviewInstalling(true);
    try {
      await props.onInstall(mod.slug, "modrinth");
      recommendations.loadRecommendations(8);
      closeModPreview();
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to install mod:", e);
    } finally {
      setPreviewInstalling(false);
    }
  };

  // Фильтруем уже установленные
  const filteredRecommendations = () => {
    return recommendations.recommendations().filter((r: ModRecommendation) => !isInstalled(r.slug));
  };

  return (
    <Show when={props.installedMods().length > 0}>
      <div class="card">
        <div class="flex items-center justify-between mb-4">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-2xl bg-gradient-to-br from-purple-600 to-blue-600 flex-center">
              <i class="i-hugeicons-star w-5 h-5 text-white" />
            </div>
            <div>
              <h3 class="font-semibold">{t().mods.recommendations?.title || "Recommended for you"}</h3>
              <p class="text-sm text-muted">
                {t().mods.recommendations?.basedOn || "Based on your installed mods"}
              </p>
            </div>
          </div>
          <button
            class="btn-ghost"
            data-size="sm"
            onClick={() => recommendations.loadRecommendations(8)}
            disabled={recommendations.loading()}
          >
            <i class={`w-4 h-4 ${recommendations.loading() ? "i-svg-spinners-6-dots-scale" : "i-hugeicons-refresh"}`} />
          </button>
        </div>

        {/* Loading */}
        <Show when={recommendations.loading()}>
          <div class="flex-center gap-2 py-8">
            <i class="i-svg-spinners-6-dots-scale w-6 h-6" />
            <span class="text-sm text-muted">{t().mods.recommendations?.loading || "Finding recommendations..."}</span>
          </div>
        </Show>

        {/* Error */}
        <Show when={recommendations.error()}>
          <div class="p-3 rounded-2xl bg-red-600/10 border border-red-600/30 text-sm text-red-400">
            {recommendations.error()}
          </div>
        </Show>

        {/* Empty State */}
        <Show when={!recommendations.loading() && filteredRecommendations().length === 0 && !recommendations.error()}>
          <div class="flex-col-center py-8 text-center">
            <i class="i-hugeicons-image-not-found-01 w-12 h-12 text-gray-600 mb-3" />
            <p class="text-sm text-muted">
              {t().mods.recommendations?.empty || "No recommendations yet. Install more mods!"}
            </p>
          </div>
        </Show>

        {/* Recommendations Grid */}
        <Show when={!recommendations.loading() && filteredRecommendations().length > 0}>
          <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            <For each={filteredRecommendations()}>
              {(rec) => (
                <div
                  class="card-hover p-3 flex flex-col cursor-pointer"
                  onClick={() => openModPreview(rec)}
                >
                  <div class="flex items-start gap-2 mb-2">
                    <Show when={sanitizeImageUrl(rec.icon_url)}>
                      <img
                        src={sanitizeImageUrl(rec.icon_url)!}
                        alt={rec.name}
                        class="w-10 h-10 rounded-2xl object-cover flex-shrink-0"
                        onError={(e) => { e.currentTarget.style.display = "none"; }}
                      />
                    </Show>
                    <div class="flex-1 min-w-0">
                      <h4 class="font-medium text-sm truncate">{rec.name}</h4>
                      <p class="text-xs text-muted truncate">by {rec.author}</p>
                    </div>
                  </div>

                  <p class="text-xs text-gray-400 line-clamp-2 mb-2 flex-1">
                    {rec.description}
                  </p>

                  {/* Reason Badge */}
                  <div class={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs mb-2 w-fit ${getReasonColor(rec.reason)}`}>
                    <i class={`${getReasonIcon(rec.reason)} w-3 h-3`} />
                    {recommendations.getReasonText(rec.reason)}
                  </div>

                  {/* Stats */}
                  <div class="flex items-center gap-2 text-xs text-muted mb-2">
                    <span class="flex items-center gap-1">
                      <i class="i-hugeicons-download-02 w-3 h-3" />
                      {rec.downloads?.toLocaleString()}
                    </span>
                    <span class="flex items-center gap-1">
                      <i class="i-hugeicons-star w-3 h-3 text-yellow-500" />
                      {Math.round(rec.confidence * 100)}%
                    </span>
                  </div>

                  <button
                    class={`btn-primary w-full ${isModInstalling(rec.slug) ? "opacity-50" : ""}`}
                    data-size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!isModInstalling(rec.slug)) handleInstall(rec);
                    }}
                    disabled={isModInstalling(rec.slug)}
                  >
                    <Show when={isModInstalling(rec.slug)} fallback={
                      <>
                        <i class="i-hugeicons-add-01 w-4 h-4" />
                        {t().common.install}
                      </>
                    }>
                      <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                      {t().mods.installing}...
                    </Show>
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>

        {/* Mod Preview Dialog */}
        <Show when={previewMod()}>
          <Show when={previewLoading()}>
            <div class="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center">
              <div class="bg-gray-850 border border-gray-750 rounded-2xl p-8 flex items-center gap-3">
                <i class="i-svg-spinners-6-dots-scale w-6 h-6 text-[var(--color-primary)]" />
                <span class="text-gray-300">{t().common?.loading ?? "Loading..."}</span>
              </div>
            </div>
          </Show>

          <Show when={!previewLoading()}>
            <ProjectInfoDialog
              project={toProjectInfo(previewMod()!, previewWiki())}
              onClose={closeModPreview}
              versionsData={previewVersions()}
              minecraftVersion={props.minecraftVersion}
              loaderType={props.loader}
              onInstallVersion={handleInstallVersion}
              isInstalled={isInstalled(previewMod()!.slug)}
              installing={previewInstalling()}
            />
          </Show>
        </Show>
      </div>
    </Show>
  );
};

export default ModRecommendations;
