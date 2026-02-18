import { createSignal, Show, createMemo } from "solid-js";
import type {
  Mod,
  WikiContent,
  ProjectInfo,
  ProjectType,
} from "../../../shared/types/common.types";
import { invoke } from "@tauri-apps/api/core";
import { ProjectInfoDialog } from "../../../shared/components/ProjectInfoDialog";

export interface ModInfoDialogProps {
  mod: Mod;
  instanceId: string;
  onClose: () => void;
}

/** Convert Mod + WikiContent to ProjectInfo */
function toProjectInfo(mod: Mod, wiki: WikiContent | null): ProjectInfo {
  // Determine project type based on loader
  const projectType: ProjectType = "mod";

  // If we have wiki content, use it for rich data
  if (wiki) {
    return {
      slug: mod.slug,
      title: mod.name,
      description: mod.description || "",
      body: wiki.body,
      author: wiki.author || mod.author || undefined,
      icon_url: mod.icon_url || undefined,
      downloads: wiki.downloads,
      followers: wiki.followers,
      categories: wiki.categories.length > 0 ? wiki.categories : (mod.categories || []),
      versions: mod.minecraft_version ? [mod.minecraft_version] : [],
      gallery: wiki.gallery.map((img) => ({
        url: img.url,
        title: img.title || undefined,
        description: img.description || undefined,
        featured: img.featured,
      })),
      links: {
        project: wiki.project_url || mod.project_url || undefined,
        source: wiki.source_url || undefined,
        wiki: wiki.wiki_url || undefined,
        discord: wiki.discord_url || undefined,
        issues: wiki.issues_url || undefined,
      },
      projectType,
      source: mod.source,
      license_id: wiki.license?.id,
      license_name: wiki.license?.name,

      // Mod-specific installed info
      enabled: mod.enabled,
      version: mod.version,
      file_name: mod.file_name,
      file_size: mod.file_size || undefined,
      installed_at: mod.installed_at,
      updated_at: mod.updated_at,
    };
  }

  // Fallback to basic mod data without wiki
  return {
    slug: mod.slug,
    title: mod.name,
    description: mod.description || "",
    author: mod.author || undefined,
    icon_url: mod.icon_url || undefined,
    categories: mod.categories || [],
    versions: mod.minecraft_version ? [mod.minecraft_version] : [],
    gallery: [],
    links: {
      project: mod.project_url || undefined,
    },
    projectType,
    source: mod.source,

    // Mod-specific installed info
    enabled: mod.enabled,
    version: mod.version,
    file_name: mod.file_name,
    file_size: mod.file_size || undefined,
    installed_at: mod.installed_at,
    updated_at: mod.updated_at,
  };
}

function ModInfoDialog(props: ModInfoDialogProps) {
  const [wiki, setWiki] = createSignal<WikiContent | null>(null);
  const [loadingWiki, setLoadingWiki] = createSignal(true);
  const [filePath, setFilePath] = createSignal<string | null>(null);

  // Fetch file path for "Open in Explorer" feature
  const fetchFilePath = async () => {
    if (props.mod.file_name && props.instanceId) {
      try {
        const path = await invoke<string>("get_mod_file_path", {
          instanceId: props.instanceId,
          fileName: props.mod.file_name,
        });
        setFilePath(path);
      } catch (e) {
        if (import.meta.env.DEV) console.error("Failed to get mod file path:", e);
      }
    }
  };

  // Fetch wiki content on mount (only for non-local mods)
  const fetchWiki = async () => {
    if (props.mod.source === "local") {
      setLoadingWiki(false);
      return;
    }

    setLoadingWiki(true);
    try {
      // For CurseForge, use source_id if available
      const slug =
        props.mod.source === "curseforge"
          ? props.mod.source_id || props.mod.slug
          : props.mod.slug;

      const result = await invoke<WikiContent>("get_mod_wiki", {
        slug,
        source: props.mod.source,
        fileHash: props.mod.file_hash || null,
      });
      setWiki(result);
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to fetch mod wiki:", e);
    } finally {
      setLoadingWiki(false);
    }
  };

  // Fetch wiki and file path when dialog opens
  fetchWiki();
  fetchFilePath();

  // Convert to ProjectInfo
  const projectInfo = createMemo(() => toProjectInfo(props.mod, wiki()));

  return (
    <>
      {/* Show loading state while fetching wiki */}
      <Show when={loadingWiki()}>
        <div class="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center">
          <div class="bg-gray-850 border border-gray-750 rounded-2xl p-8 flex items-center gap-3">
            <i class="i-svg-spinners-6-dots-scale w-6 h-6 text-[var(--color-primary)]" />
            <span class="text-gray-300">Loading...</span>
          </div>
        </div>
      </Show>

      {/* Show dialog when wiki is loaded (or skipped for local mods) */}
      <Show when={!loadingWiki()}>
        <ProjectInfoDialog
          project={projectInfo()}
          onClose={props.onClose}
          filePath={filePath() || undefined}
        />
      </Show>
    </>
  );
}

export default ModInfoDialog;
