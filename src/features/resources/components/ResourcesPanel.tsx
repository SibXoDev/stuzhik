import { createSignal, Show, For, createMemo, createEffect } from "solid-js";
import { useI18n } from "../../../shared/i18n";
import { useResources } from "../hooks/useResources";
import type { ResourceType, InstalledResource, ResourceSearchResult } from "../../../shared/types/common.types";
import { open } from "@tauri-apps/plugin-dialog";
import { sanitizeImageUrl } from "../../../shared/utils/url-validator";
import ResourceInfoDialog from "./ResourceInfoDialog";
import Pagination from "../../../shared/ui/Pagination";

interface ResourcesPanelProps {
  instanceId?: string;
  minecraftVersion?: string;
  resourceType: ResourceType;
}

const ITEMS_PER_PAGE = 20;

export function ResourcesPanel(props: ResourcesPanelProps) {
  const { t } = useI18n();
  const [view, setView] = createSignal<"installed" | "browse">("installed");
  const [searchQuery, setSearchQuery] = createSignal("");
  const [installGlobal, setInstallGlobal] = createSignal(false);
  const [_hasLoadedBrowse, setHasLoadedBrowse] = createSignal(false);
  const [selectedResource, setSelectedResource] = createSignal<ResourceSearchResult | null>(null);
  const [page, setPage] = createSignal(0);

  const resources = useResources(() => ({
    resourceType: props.resourceType,
    instanceId: props.instanceId,
    includeGlobal: true,
  }));

  // Calculate total pages
  const totalPages = createMemo(() =>
    Math.max(1, Math.ceil(resources.searchTotal() / ITEMS_PER_PAGE))
  );

  // Auto-load installed resources when switching to installed view or resource type changes
  createEffect(() => {
    const currentView = view();
    void props.resourceType;

    if (currentView === "installed") {
      // Auto-scan when opening installed tab
      handleScan();
    }
  });

  // Load popular resources when switching to browse view or changing resource type
  createEffect(() => {
    const currentView = view();
    // Track dependency on resourceType to re-run when it changes
    void props.resourceType;

    if (currentView === "browse") {
      // Reset page and load when view changes to browse or resource type changes
      setPage(0);
      setHasLoadedBrowse(false);
      // Load popular items (empty query returns trending/popular)
      resources.searchResources("", props.minecraftVersion, ITEMS_PER_PAGE, 0);
      setHasLoadedBrowse(true);
    }
  });

  // Filter resources by search
  const filteredResources = createMemo(() => {
    const query = searchQuery().toLowerCase();
    if (!query) return resources.resources();
    return resources.resources().filter(
      (r) =>
        r.name.toLowerCase().includes(query) ||
        r.slug.toLowerCase().includes(query)
    );
  });

  // Type label
  const typeLabel = () =>
    props.resourceType === "shader"
      ? t().resources?.shaders ?? "Shaders"
      : t().resources?.resourcePacks ?? "Resource Packs";

  // typeLabelSingular - reserved for future use
  // const typeLabelSingular = () =>
  //   props.resourceType === "shader"
  //     ? t().resources?.shader ?? "Shader"
  //     : t().resources?.resourcePack ?? "Resource Pack";

  // Handle search (empty query shows popular/trending)
  async function handleSearch(resetPage = true) {
    const query = searchQuery().trim();
    if (resetPage) {
      setPage(0);
    }
    const offset = resetPage ? 0 : page() * ITEMS_PER_PAGE;
    await resources.searchResources(query, props.minecraftVersion, ITEMS_PER_PAGE, offset);
  }

  // Handle page change
  async function handlePageChange(newPage: number) {
    setPage(newPage);
    const query = searchQuery().trim();
    const offset = newPage * ITEMS_PER_PAGE;
    await resources.searchResources(query, props.minecraftVersion, ITEMS_PER_PAGE, offset);
  }

  // Handle install from Modrinth
  async function handleInstall(slug: string) {
    try {
      await resources.installFromModrinth(slug, installGlobal(), props.minecraftVersion);
    } catch (e) {
      console.error("Install failed:", e);
    }
  }

  // Handle install from local file
  async function handleInstallLocal() {
    const selected = await open({
      multiple: false,
      filters: [{ name: "ZIP files", extensions: ["zip"] }],
    });

    if (selected) {
      try {
        await resources.installLocal(selected as string, installGlobal());
      } catch (e) {
        console.error("Local install failed:", e);
      }
    }
  }

  // Handle toggle
  async function handleToggle(resource: InstalledResource) {
    try {
      await resources.toggleResource(resource.id, !resource.enabled);
    } catch (e) {
      console.error("Toggle failed:", e);
    }
  }

  // Handle remove
  async function handleRemove(resource: InstalledResource) {
    try {
      await resources.removeResource(resource.id);
    } catch (e) {
      console.error("Remove failed:", e);
    }
  }

  // Handle scan
  async function handleScan() {
    const imported = await resources.scanAndImport(false);
    if (imported.length > 0) {
      console.log(`Imported ${imported.length} resources`);
    }
  }

  // formatSize - reserved for future use when displaying file sizes
  // function formatSize(bytes?: number | null): string {
  //   if (!bytes) return "—";
  //   if (bytes < 1024) return `${bytes} B`;
  //   if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  //   return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  // }

  return (
    <div class="flex flex-col">
      {/* Header */}
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-lg font-medium">{typeLabel()}</h3>
        <div class="flex gap-2">
          <button
            class={`px-3 py-1.5 rounded-2xl text-sm transition-colors ${
              view() === "installed"
                ? "bg-blue-600 text-white"
                : "bg-gray-700 text-gray-300 hover:bg-gray-600"
            }`}
            onClick={() => setView("installed")}
          >
            {t().resources?.installed ?? "Installed"}
          </button>
          <button
            class={`px-3 py-1.5 rounded-2xl text-sm transition-colors ${
              view() === "browse"
                ? "bg-blue-600 text-white"
                : "bg-gray-700 text-gray-300 hover:bg-gray-600"
            }`}
            onClick={() => setView("browse")}
          >
            {t().resources?.browse ?? "Browse"}
          </button>
        </div>
      </div>

      {/* Installed View */}
      <Show when={view() === "installed"}>
        <div class="flex flex-col gap-4">
          {/* Actions */}
          <div class="flex gap-2 items-center">
            <input
              type="text"
              placeholder={t().resources?.searchInstalled ?? "Search installed..."}
              value={searchQuery()}
              onInput={(e) => setSearchQuery(e.currentTarget.value)}
              class="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-2xl text-sm focus:border-blue-500 focus:outline-none"
            />
            <button
              onClick={handleInstallLocal}
              class="px-3 py-2 bg-gray-700 text-gray-300 rounded-2xl text-sm hover:bg-gray-600 transition-colors"
            >
              {t().resources?.addLocal ?? "Add Local"}
            </button>
            <button
              onClick={handleScan}
              class="px-3 py-2 bg-gray-700 text-gray-300 rounded-2xl text-sm hover:bg-gray-600 transition-colors"
              title={t().resources?.scanTooltip ?? "Scan folder for untracked files"}
            >
              <i class="i-hugeicons-refresh w-4 h-4" />
            </button>
          </div>

          {/* List */}
          <Show
            when={!resources.loading()}
            fallback={
              <div class="flex items-center justify-center gap-2 py-8 text-gray-400">
                <i class="i-svg-spinners-6-dots-scale w-5 h-5" />
                {t().common?.loading ?? "Loading..."}
              </div>
            }
          >
            <Show
              when={filteredResources().length > 0}
              fallback={
                <div class="text-center py-8 text-gray-500">
                  {t().resources?.noInstalled ?? `No ${typeLabel().toLowerCase()} installed`}
                </div>
              }
            >
              <div class="flex flex-col gap-2">
                <For each={filteredResources()}>
                  {(resource) => (
                    <ResourceCard
                      resource={resource}
                      onToggle={() => handleToggle(resource)}
                      onRemove={() => handleRemove(resource)}
                      t={t}
                    />
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </div>
      </Show>

      {/* Browse View */}
      <Show when={view() === "browse"}>
        <div class="flex flex-col gap-4">
          {/* Search */}
          <div class="flex gap-2 items-center">
            <input
              type="text"
              placeholder={t().resources?.searchModrinth ?? `Search ${typeLabel().toLowerCase()} on Modrinth...`}
              value={searchQuery()}
              onInput={(e) => setSearchQuery(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              class="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-2xl text-sm focus:border-blue-500 focus:outline-none"
            />
            <button
              onClick={() => handleSearch()}
              disabled={resources.searchLoading()}
              class="px-4 py-2 bg-blue-600 text-white rounded-2xl text-sm hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              {resources.searchLoading() ? (
                <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
              ) : (
                t().common?.search ?? "Search"
              )}
            </button>
          </div>

          {/* Install options */}
          <label class="flex items-center gap-2 text-sm text-gray-400 flex-shrink-0">
            <input
              type="checkbox"
              checked={installGlobal()}
              onChange={(e) => setInstallGlobal(e.currentTarget.checked)}
              class="rounded bg-gray-800 border-gray-600"
            />
            {t().resources?.installGlobal ?? "Install globally (available for all instances)"}
          </label>

          {/* Search results */}
          <Show
            when={resources.searchResults().length > 0}
            fallback={
              <Show
                when={!resources.searchLoading()}
                fallback={
                  <div class="flex items-center justify-center gap-2 py-8 text-gray-400">
                    <i class="i-svg-spinners-6-dots-scale w-5 h-5" />
                    {t().common?.loading ?? "Loading..."}
                  </div>
                }
              >
                <div class="text-center py-8 text-gray-500">
                  {t().resources?.noResults ?? `No ${typeLabel().toLowerCase()} found`}
                </div>
              </Show>
            }
          >
            <div class="flex flex-col gap-2">
              <For each={resources.searchResults()}>
                {(result) => (
                  <SearchResultCard
                    result={result}
                    isInstalled={resources.isInstalled(result.slug)}
                    onInstall={() => handleInstall(result.slug)}
                    onClick={() => setSelectedResource(result)}
                    t={t}
                  />
                )}
              </For>
            </div>
          </Show>

          {/* Pagination */}
          <Show when={resources.searchResults().length > 0 && totalPages() > 1}>
            <div class="flex-shrink-0">
              <Pagination
                currentPage={page()}
                totalPages={totalPages()}
                onPageChange={handlePageChange}
              />
            </div>
          </Show>
        </div>
      </Show>

      {/* Error message */}
      <Show when={resources.error()}>
        <div class="mt-4 p-3 bg-red-900/30 border border-red-700 rounded-2xl text-red-400 text-sm">
          {resources.error()}
        </div>
      </Show>

      {/* Resource Info Dialog */}
      <Show when={selectedResource()}>
        <ResourceInfoDialog
          resource={selectedResource()!}
          resourceType={props.resourceType}
          onClose={() => setSelectedResource(null)}
          onInstall={(slug) => {
            handleInstall(slug);
            setSelectedResource(null);
          }}
          isInstalled={resources.isInstalled(selectedResource()!.slug)}
        />
      </Show>
    </div>
  );
}

// Resource card for installed items
interface ResourceCardProps {
  resource: InstalledResource;
  onToggle: () => void;
  onRemove: () => void;
  t: () => Record<string, unknown>;
}

function ResourceCard(props: ResourceCardProps) {
  const t = () => props.t() as { resources?: Record<string, string>; common?: Record<string, string> };

  return (
    <div
      class={`card-hover flex items-center gap-4 p-4 ${
        !props.resource.enabled ? "opacity-60" : ""
      }`}
    >
      {/* Icon */}
      <Show
        when={sanitizeImageUrl(props.resource.icon_url)}
        fallback={
          <div class="w-12 h-12 rounded-xl bg-gray-700 flex items-center justify-center flex-shrink-0">
            <i
              class={`w-6 h-6 text-gray-400 ${
                props.resource.resource_type === "shader"
                  ? "i-hugeicons-flash"
                  : "i-hugeicons-image-01"
              }`}
            />
          </div>
        }
      >
        <img
          src={sanitizeImageUrl(props.resource.icon_url)!}
          alt={props.resource.name}
          class="w-12 h-12 rounded-xl object-cover flex-shrink-0"
        />
      </Show>

      {/* Info */}
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 mb-1">
          <span class="font-semibold truncate">{props.resource.name}</span>
          <Show when={props.resource.is_global}>
            <span class="badge badge-sm bg-purple-600/20 text-purple-300 border-purple-600/30">
              {t()?.resources?.global ?? "Global"}
            </span>
          </Show>
        </div>
        <div class="flex items-center gap-2 text-sm text-muted">
          <span>{props.resource.version}</span>
          <span class="w-1 h-1 rounded-full bg-gray-600" />
          <span class="capitalize">{props.resource.source}</span>
        </div>
      </div>

      {/* Actions */}
      <div class="flex items-center gap-2 flex-shrink-0">
        <button
          onClick={props.onToggle}
          class={`w-9 h-9 rounded-xl flex-center transition-colors ${
            props.resource.enabled
              ? "bg-green-600/20 text-green-400 hover:bg-green-600/30"
              : "bg-gray-700/50 text-gray-500 hover:bg-gray-700"
          }`}
          title={props.resource.enabled ? (t()?.resources?.disable ?? "Disable") : (t()?.resources?.enable ?? "Enable")}
        >
          <i
            class={`w-5 h-5 ${
              props.resource.enabled
                ? "i-hugeicons-checkmark-circle-02"
                : "i-hugeicons-tick-02"
            }`}
          />
        </button>
        <button
          onClick={props.onRemove}
          class="w-9 h-9 rounded-xl bg-gray-700/50 text-gray-400 hover:text-red-400 hover:bg-red-900/30 flex-center transition-colors"
          title={t()?.common?.delete ?? "Delete"}
        >
          <i class="i-hugeicons-delete-02 w-5 h-5" />
        </button>
      </div>
    </div>
  );
}

// Search result card
interface SearchResultCardProps {
  result: ResourceSearchResult;
  isInstalled: boolean;
  onInstall: () => void;
  onClick: () => void;
  t: () => Record<string, unknown>;
}

function SearchResultCard(props: SearchResultCardProps) {
  const t = () => props.t() as { resources?: Record<string, string>; common?: Record<string, string> };

  function formatDownloads(count: number): string {
    if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
    if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
    return count.toString();
  }

  return (
    <div
      class="card-hover cursor-pointer"
      onClick={props.onClick}
    >
      <div class="flex items-start gap-4 p-4">
        {/* Icon */}
        <Show
          when={sanitizeImageUrl(props.result.icon_url)}
          fallback={
            <div class="w-14 h-14 rounded-xl bg-gray-700 flex items-center justify-center flex-shrink-0">
              <i
                class={`w-7 h-7 text-gray-400 ${
                  props.result.project_type === "shader"
                    ? "i-hugeicons-flash"
                    : "i-hugeicons-image-01"
                }`}
              />
            </div>
          }
        >
          <img
            src={sanitizeImageUrl(props.result.icon_url)!}
            alt={props.result.title}
            class="w-14 h-14 rounded-xl object-cover flex-shrink-0"
          />
        </Show>

        {/* Info */}
        <div class="flex-1 min-w-0">
          <h4 class="font-semibold truncate mb-1">{props.result.title}</h4>
          <p class="text-sm text-muted line-clamp-2 mb-2">{props.result.description}</p>

          <div class="flex items-center gap-3 text-sm">
            <span class="badge badge-sm badge-gray">
              <i class="i-hugeicons-user w-3 h-3" />
              {props.result.author}
            </span>
            <span class="badge badge-sm badge-gray">
              <i class="i-hugeicons-download-02 w-3 h-3" />
              {formatDownloads(props.result.downloads)}
            </span>
          </div>

          {/* Version tags */}
          <div class="flex flex-wrap gap-1.5 mt-3">
            <For each={props.result.versions.slice(0, 5)}>
              {(version) => (
                <span class="badge badge-sm bg-blue-600/20 text-blue-300 border-blue-600/30">
                  {version}
                </span>
              )}
            </For>
            <Show when={props.result.versions.length > 5}>
              <span class="badge badge-sm badge-gray">
                +{props.result.versions.length - 5}
              </span>
            </Show>
          </div>
        </div>

        {/* Install button */}
        <div class="flex-shrink-0">
          <Show
            when={!props.isInstalled}
            fallback={
              <span class="badge badge-success">
                <i class="i-hugeicons-checkmark-circle-02 w-4 h-4" />
                {t()?.resources?.installed ?? "Installed"}
              </span>
            }
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                props.onInstall();
              }}
              class="btn-primary"
              data-size="sm"
            >
              <i class="i-hugeicons-add-01 w-4 h-4" />
              {t()?.common?.install ?? "Install"}
            </button>
          </Show>
        </div>
      </div>
    </div>
  );
}

export default ResourcesPanel;
