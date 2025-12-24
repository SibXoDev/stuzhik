import { createSignal, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type {
  ResourceType,
  InstalledResource,
  ResourceSearchResult,
  ResourceSearchResponse,
} from "../../../shared/types/common.types";

export interface UseResourcesOptions {
  /** Instance ID (null for global resources only) */
  instanceId?: string | null;
  /** Resource type to manage */
  resourceType: ResourceType;
  /** Include global resources when listing for an instance */
  includeGlobal?: boolean;
}

export function useResources(options: () => UseResourcesOptions) {
  const [resources, setResources] = createSignal<InstalledResource[]>([]);
  const [searchResults, setSearchResults] = createSignal<ResourceSearchResult[]>([]);
  const [searchTotal, setSearchTotal] = createSignal(0);
  const [loading, setLoading] = createSignal(false);
  const [searchLoading, setSearchLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // Load installed resources
  async function loadResources() {
    const opts = options();
    setLoading(true);
    setError(null);

    try {
      const result = await invoke<InstalledResource[]>("list_resources", {
        resourceType: opts.resourceType,
        instanceId: opts.instanceId ?? null,
        includeGlobal: opts.includeGlobal ?? true,
      });
      setResources(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to load resources:", e);
    } finally {
      setLoading(false);
    }
  }

  // Search resources on Modrinth
  async function searchResources(
    query: string,
    minecraftVersion?: string,
    limit = 20,
    offset = 0
  ) {
    const opts = options();
    setSearchLoading(true);
    setError(null);

    try {
      const response = await invoke<ResourceSearchResponse>("search_resources", {
        resourceType: opts.resourceType,
        query,
        minecraftVersion: minecraftVersion ?? null,
        limit,
        offset,
      });
      setSearchResults(response.results);
      setSearchTotal(response.total);
      return response.results;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to search resources:", e);
      setSearchTotal(0);
      return [];
    } finally {
      setSearchLoading(false);
    }
  }

  // Install resource from Modrinth
  async function installFromModrinth(
    slug: string,
    isGlobal: boolean,
    minecraftVersion?: string
  ) {
    const opts = options();
    setLoading(true);
    setError(null);

    try {
      const result = await invoke<InstalledResource>("install_resource_from_modrinth", {
        resourceType: opts.resourceType,
        instanceId: isGlobal ? null : opts.instanceId,
        isGlobal,
        slug,
        minecraftVersion: minecraftVersion ?? null,
      });

      // Reload list
      await loadResources();
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to install resource:", e);
      throw e;
    } finally {
      setLoading(false);
    }
  }

  // Install resource from local file
  async function installLocal(sourcePath: string, isGlobal: boolean) {
    const opts = options();
    setLoading(true);
    setError(null);

    try {
      const result = await invoke<InstalledResource>("install_resource_local", {
        resourceType: opts.resourceType,
        instanceId: isGlobal ? null : opts.instanceId,
        isGlobal,
        sourcePath,
      });

      // Reload list
      await loadResources();
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to install local resource:", e);
      throw e;
    } finally {
      setLoading(false);
    }
  }

  // Toggle resource enabled/disabled
  async function toggleResource(resourceId: number, enabled: boolean) {
    const opts = options();
    setError(null);

    try {
      await invoke("toggle_resource", {
        resourceType: opts.resourceType,
        resourceId,
        enabled,
      });

      // Update local state
      setResources((prev) =>
        prev.map((r) =>
          r.id === resourceId ? { ...r, enabled } : r
        )
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to toggle resource:", e);
      throw e;
    }
  }

  // Remove resource
  async function removeResource(resourceId: number) {
    const opts = options();
    setError(null);

    try {
      await invoke("remove_resource", {
        resourceType: opts.resourceType,
        resourceId,
      });

      // Update local state
      setResources((prev) => prev.filter((r) => r.id !== resourceId));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to remove resource:", e);
      throw e;
    }
  }

  // Scan directory for untracked resources
  async function scanAndImport(isGlobal: boolean) {
    const opts = options();
    setLoading(true);
    setError(null);

    try {
      const imported = await invoke<InstalledResource[]>("scan_resources", {
        resourceType: opts.resourceType,
        instanceId: isGlobal ? null : opts.instanceId,
        isGlobal,
      });

      // Reload list
      await loadResources();
      return imported;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to scan resources:", e);
      return [];
    } finally {
      setLoading(false);
    }
  }

  // Check if resource is installed
  function isInstalled(slug: string): boolean {
    return resources().some((r) => r.slug === slug);
  }

  // Load on mount
  onMount(() => {
    loadResources();
  });

  return {
    // State
    resources,
    searchResults,
    searchTotal,
    loading,
    searchLoading,
    error,

    // Actions
    loadResources,
    searchResources,
    installFromModrinth,
    installLocal,
    toggleResource,
    removeResource,
    scanAndImport,
    isInstalled,
  };
}

// Convenience hooks for specific resource types
export function useShaders(instanceId?: () => string | null | undefined) {
  return useResources(() => ({
    resourceType: "shader" as const,
    instanceId: instanceId?.() ?? null,
    includeGlobal: true,
  }));
}

export function useResourcePacks(instanceId?: () => string | null | undefined) {
  return useResources(() => ({
    resourceType: "resourcepack" as const,
    instanceId: instanceId?.() ?? null,
    includeGlobal: true,
  }));
}
