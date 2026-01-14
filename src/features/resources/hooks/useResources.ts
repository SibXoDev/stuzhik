import { createSignal, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import {
  createAsyncState,
  runAsync,
  runAsyncSilent,
  extractErrorMessage,
  removeItemById,
  updateItemById,
} from "../../../shared/hooks/useAsyncUtils";
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

const LOG_PREFIX = "[Resources]";

export function useResources(options: () => UseResourcesOptions) {
  const [resources, setResources] = createSignal<InstalledResource[]>([]);
  const [searchResults, setSearchResults] = createSignal<ResourceSearchResult[]>([]);
  const [searchTotal, setSearchTotal] = createSignal(0);
  const { loading, setLoading, error, setError } = createAsyncState();
  const [searchLoading, setSearchLoading] = createSignal(false);

  // Load installed resources
  async function loadResources() {
    const opts = options();
    await runAsync(
      () => invoke<InstalledResource[]>("list_resources", {
        resourceType: opts.resourceType,
        instanceId: opts.instanceId ?? null,
        includeGlobal: opts.includeGlobal ?? true,
      }),
      { setLoading, setError, logPrefix: LOG_PREFIX, onSuccess: setResources }
    );
  }

  // Search resources on Modrinth
  async function searchResources(
    query: string,
    minecraftVersion?: string,
    limit = 20,
    offset = 0
  ): Promise<ResourceSearchResult[]> {
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
      const msg = extractErrorMessage(e);
      setError(msg);
      if (import.meta.env.DEV) {
        console.error(`${LOG_PREFIX} Failed to search resources:`, e);
      }
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
  ): Promise<InstalledResource | null> {
    const opts = options();
    const result = await runAsync(
      () => invoke<InstalledResource>("install_resource_from_modrinth", {
        resourceType: opts.resourceType,
        instanceId: isGlobal ? null : opts.instanceId,
        isGlobal,
        slug,
        minecraftVersion: minecraftVersion ?? null,
      }),
      { setLoading, setError, logPrefix: LOG_PREFIX }
    );

    if (result) {
      await loadResources();
    }
    return result;
  }

  // Install resource from local file
  async function installLocal(
    sourcePath: string,
    isGlobal: boolean
  ): Promise<InstalledResource | null> {
    const opts = options();
    const result = await runAsync(
      () => invoke<InstalledResource>("install_resource_local", {
        resourceType: opts.resourceType,
        instanceId: isGlobal ? null : opts.instanceId,
        isGlobal,
        sourcePath,
      }),
      { setLoading, setError, logPrefix: LOG_PREFIX }
    );

    if (result) {
      await loadResources();
    }
    return result;
  }

  // Toggle resource enabled/disabled
  async function toggleResource(resourceId: number, enabled: boolean) {
    const opts = options();
    await runAsyncSilent(
      () => invoke("toggle_resource", {
        resourceType: opts.resourceType,
        resourceId,
        enabled,
      }),
      {
        setError,
        logPrefix: LOG_PREFIX,
        onSuccess: () => updateItemById(setResources, resourceId, { enabled }),
      }
    );
  }

  // Remove resource
  async function removeResource(resourceId: number) {
    const opts = options();
    await runAsyncSilent(
      () => invoke("remove_resource", {
        resourceType: opts.resourceType,
        resourceId,
      }),
      {
        setError,
        logPrefix: LOG_PREFIX,
        onSuccess: () => removeItemById(setResources, resourceId),
      }
    );
  }

  // Scan directory for untracked resources
  async function scanAndImport(isGlobal: boolean): Promise<InstalledResource[]> {
    const opts = options();
    const result = await runAsync(
      () => invoke<InstalledResource[]>("scan_resources", {
        resourceType: opts.resourceType,
        instanceId: isGlobal ? null : opts.instanceId,
        isGlobal,
      }),
      { setLoading, setError, logPrefix: LOG_PREFIX }
    );

    if (result) {
      await loadResources();
      return result;
    }
    return [];
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
