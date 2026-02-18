import { createSignal, Show, createMemo } from "solid-js";
import type {
  ResourceSearchResult,
  ResourceType,
  ResourceDetails,
  ProjectInfo,
  ProjectType,
} from "../../../shared/types/common.types";
import { invoke } from "@tauri-apps/api/core";
import { ProjectInfoDialog } from "../../../shared/components/ProjectInfoDialog";

export interface ResourceInfoDialogProps {
  resource: ResourceSearchResult;
  resourceType: ResourceType;
  onClose: () => void;
  onInstall?: (slug: string) => void;
  isInstalled?: boolean;
}

/** Convert ResourceType to ProjectType */
function toProjectType(resourceType: ResourceType): ProjectType {
  return resourceType === "shader" ? "shader" : "resourcepack";
}

/** Convert ResourceSearchResult + ResourceDetails to ProjectInfo */
function toProjectInfo(
  resource: ResourceSearchResult,
  resourceType: ResourceType,
  details: ResourceDetails | null
): ProjectInfo {
  // If we have full details, use them
  if (details) {
    return {
      slug: details.slug,
      title: details.title,
      description: details.description,
      body: details.body,
      author: details.author || resource.author,
      icon_url: details.icon_url || resource.icon_url || undefined,
      downloads: details.downloads,
      followers: details.followers,
      categories: details.categories,
      versions: details.versions,
      gallery: details.gallery.map((img) => ({
        url: img.url,
        title: img.title,
        description: img.description,
        featured: img.featured,
      })),
      links: {
        project: details.links.modrinth,
        source: details.links.source,
        wiki: details.links.wiki,
        discord: details.links.discord,
        issues: details.links.issues,
      },
      projectType: toProjectType(resourceType),
      source: "modrinth",
      license_id: details.license_id,
      license_name: details.license_name,
    };
  }

  // Fallback to search result data
  const projectType = resourceType === "shader" ? "shader" : "resourcepack";
  return {
    slug: resource.slug,
    title: resource.title,
    description: resource.description,
    author: resource.author,
    icon_url: resource.icon_url || undefined,
    downloads: resource.downloads,
    categories: resource.categories,
    versions: resource.versions,
    gallery: [],
    links: {
      project: `https://modrinth.com/${projectType}/${resource.slug}`,
    },
    projectType: toProjectType(resourceType),
    source: "modrinth",
  };
}

function ResourceInfoDialog(props: ResourceInfoDialogProps) {
  const [details, setDetails] = createSignal<ResourceDetails | null>(null);
  const [loadingDetails, setLoadingDetails] = createSignal(true);
  const [installing, setInstalling] = createSignal(false);

  // Fetch additional details on mount
  const fetchDetails = async () => {
    setLoadingDetails(true);
    try {
      const result = await invoke<ResourceDetails>("get_resource_details", {
        resourceType: props.resourceType,
        slug: props.resource.slug,
      });
      setDetails(result);
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to fetch resource details:", e);
    } finally {
      setLoadingDetails(false);
    }
  };

  // Fetch details when dialog opens
  fetchDetails();

  // Convert to ProjectInfo
  const projectInfo = createMemo(() =>
    toProjectInfo(props.resource, props.resourceType, details())
  );

  // Handle install
  const handleInstall = async () => {
    setInstalling(true);
    try {
      await props.onInstall?.(props.resource.slug);
    } finally {
      setInstalling(false);
    }
  };

  return (
    <>
      {/* Show loading state while fetching details */}
      <Show when={loadingDetails()}>
        <div class="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center">
          <div class="bg-gray-850 border border-gray-750 rounded-2xl p-8 flex items-center gap-3">
            <i class="i-svg-spinners-6-dots-scale w-6 h-6 text-[var(--color-primary)]" />
            <span class="text-gray-300">Loading...</span>
          </div>
        </div>
      </Show>

      {/* Show dialog when details are loaded */}
      <Show when={!loadingDetails()}>
        <ProjectInfoDialog
          project={projectInfo()}
          onClose={props.onClose}
          onInstall={props.onInstall ? handleInstall : undefined}
          isInstalled={props.isInstalled}
          installing={installing()}
        />
      </Show>
    </>
  );
}

export default ResourceInfoDialog;
