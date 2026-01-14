import { createSignal, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import {
  createAsyncState,
  runAsync,
  runAsyncSilent,
} from "../../../shared/hooks/useAsyncUtils";
import type {
  ModCollection,
  CollectionMod,
  CollectionWithMods,
  CreateCollectionRequest,
  UpdateCollectionRequest,
  AddModToCollectionRequest,
  CollectionInstallResult,
  ExportedCollection,
} from "../../../shared/types/common.types";

const LOG_PREFIX = "[Collections]";

/**
 * Hook for managing mod collections
 */
export function useCollections() {
  const [collections, setCollections] = createSignal<ModCollection[]>([]);
  const { loading, setLoading, error, setError } = createAsyncState();

  // Load all collections
  async function loadCollections() {
    await runAsync(
      () => invoke<ModCollection[]>("list_collections"),
      { setLoading, setError, logPrefix: LOG_PREFIX, onSuccess: setCollections }
    );
  }

  // Get a single collection by ID
  async function getCollection(id: string): Promise<ModCollection | null> {
    return runAsyncSilent(
      () => invoke<ModCollection>("get_collection", { id }),
      { logPrefix: LOG_PREFIX }
    );
  }

  // Get collection with all its mods
  async function getCollectionWithMods(id: string): Promise<CollectionWithMods | null> {
    return runAsyncSilent(
      () => invoke<CollectionWithMods>("get_collection_with_mods", { id }),
      { logPrefix: LOG_PREFIX }
    );
  }

  // Get mods in a collection
  async function getCollectionMods(collectionId: string): Promise<CollectionMod[]> {
    const result = await runAsyncSilent(
      () => invoke<CollectionMod[]>("get_collection_mods", { collectionId }),
      { logPrefix: LOG_PREFIX }
    );
    return result ?? [];
  }

  // Create a new collection
  async function createCollection(request: CreateCollectionRequest): Promise<ModCollection | null> {
    const result = await runAsync(
      () => invoke<ModCollection>("create_collection", { request }),
      { setLoading, setError, logPrefix: LOG_PREFIX }
    );
    if (result) {
      await loadCollections();
    }
    return result;
  }

  // Update a collection
  async function updateCollection(
    id: string,
    request: UpdateCollectionRequest
  ): Promise<ModCollection | null> {
    const result = await runAsync(
      () => invoke<ModCollection>("update_collection", { id, request }),
      { setLoading, setError, logPrefix: LOG_PREFIX }
    );
    if (result) {
      await loadCollections();
    }
    return result;
  }

  // Delete a collection
  async function deleteCollection(id: string): Promise<boolean> {
    const result = await runAsync(
      () => invoke<void>("delete_collection", { id }),
      { setLoading, setError, logPrefix: LOG_PREFIX }
    );
    if (result !== null) {
      await loadCollections();
      return true;
    }
    return false;
  }

  // Add a mod to a collection
  async function addModToCollection(request: AddModToCollectionRequest): Promise<boolean> {
    const result = await runAsyncSilent(
      () => invoke<void>("add_mod_to_collection", { request }),
      { logPrefix: LOG_PREFIX }
    );
    if (result !== null) {
      await loadCollections();
      return true;
    }
    return false;
  }

  // Remove a mod from a collection
  async function removeModFromCollection(collectionId: string, modSlug: string): Promise<boolean> {
    const result = await runAsyncSilent(
      () => invoke<void>("remove_mod_from_collection", { collectionId, modSlug }),
      { logPrefix: LOG_PREFIX }
    );
    if (result !== null) {
      await loadCollections();
      return true;
    }
    return false;
  }

  // Install all mods from a collection to an instance
  async function installCollection(
    collectionId: string,
    instanceId: string,
    minecraftVersion: string,
    loaderType: string
  ): Promise<CollectionInstallResult | null> {
    return runAsync(
      () => invoke<CollectionInstallResult>("install_collection", {
        collectionId,
        instanceId,
        minecraftVersion,
        loaderType,
      }),
      { setLoading, setError, logPrefix: LOG_PREFIX }
    );
  }

  // Export collection to JSON
  async function exportCollection(id: string): Promise<ExportedCollection | null> {
    return runAsyncSilent(
      () => invoke<ExportedCollection>("export_collection", { id }),
      { logPrefix: LOG_PREFIX }
    );
  }

  // Import collection from JSON
  async function importCollection(exported: ExportedCollection): Promise<ModCollection | null> {
    const result = await runAsync(
      () => invoke<ModCollection>("import_collection", { exported }),
      { setLoading, setError, logPrefix: LOG_PREFIX }
    );
    if (result) {
      await loadCollections();
    }
    return result;
  }

  // Duplicate a collection
  async function duplicateCollection(id: string, newName?: string): Promise<ModCollection | null> {
    const result = await runAsync(
      () => invoke<ModCollection>("duplicate_collection", { id, newName }),
      { setLoading, setError, logPrefix: LOG_PREFIX }
    );
    if (result) {
      await loadCollections();
    }
    return result;
  }

  // Get collections that contain a specific mod
  async function getCollectionsContainingMod(modSlug: string): Promise<ModCollection[]> {
    const result = await runAsyncSilent(
      () => invoke<ModCollection[]>("get_collections_containing_mod", { modSlug }),
      { logPrefix: LOG_PREFIX }
    );
    return result ?? [];
  }

  // Auto-load on mount
  onMount(() => {
    loadCollections();
  });

  return {
    // State
    collections,
    loading,
    error,

    // Actions
    loadCollections,
    getCollection,
    getCollectionWithMods,
    getCollectionMods,
    createCollection,
    updateCollection,
    deleteCollection,
    addModToCollection,
    removeModFromCollection,
    installCollection,
    exportCollection,
    importCollection,
    duplicateCollection,
    getCollectionsContainingMod,
  };
}

/**
 * Predefined colors for collections
 */
export const COLLECTION_COLORS = [
  "#3b82f6", // blue
  "#22c55e", // green
  "#f59e0b", // amber
  "#ef4444", // red
  "#a855f7", // purple
  "#06b6d4", // cyan
  "#84cc16", // lime
  "#f97316", // orange
  "#ec4899", // pink
  "#14b8a6", // teal
];

/**
 * Predefined icons for collections (image filenames in /collections/)
 * Place images in: public/collections/
 */
export const COLLECTION_ICONS = [
  "default",
  "optimization",
  "tech",
  "magic",
  "adventure",
  "building",
  "qol",
  "popular",
  "gameplay",
  "visual",
  "utility",
  "world",
  "experimental",
  "favorites",
  "library",
];

/**
 * Get the icon URL for a collection icon name
 */
export function getCollectionIconUrl(icon: string): string {
  return `/collections/${icon}.webp`;
}
