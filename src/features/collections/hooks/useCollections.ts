import { createSignal, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
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

/**
 * Hook for managing mod collections
 */
export function useCollections() {
  const [collections, setCollections] = createSignal<ModCollection[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // Load all collections
  async function loadCollections() {
    setLoading(true);
    setError(null);

    try {
      const result = await invoke<ModCollection[]>("list_collections");
      setCollections(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("[Collections] Failed to load collections:", e);
    } finally {
      setLoading(false);
    }
  }

  // Get a single collection by ID
  async function getCollection(id: string): Promise<ModCollection | null> {
    try {
      return await invoke<ModCollection>("get_collection", { id });
    } catch (e) {
      console.error("[Collections] Failed to get collection:", e);
      return null;
    }
  }

  // Get collection with all its mods
  async function getCollectionWithMods(id: string): Promise<CollectionWithMods | null> {
    try {
      return await invoke<CollectionWithMods>("get_collection_with_mods", { id });
    } catch (e) {
      console.error("[Collections] Failed to get collection with mods:", e);
      return null;
    }
  }

  // Get mods in a collection
  async function getCollectionMods(collectionId: string): Promise<CollectionMod[]> {
    try {
      return await invoke<CollectionMod[]>("get_collection_mods", { collectionId });
    } catch (e) {
      console.error("[Collections] Failed to get collection mods:", e);
      return [];
    }
  }

  // Create a new collection
  async function createCollection(request: CreateCollectionRequest): Promise<ModCollection | null> {
    setLoading(true);
    setError(null);

    try {
      const result = await invoke<ModCollection>("create_collection", { request });
      await loadCollections();
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("[Collections] Failed to create collection:", e);
      return null;
    } finally {
      setLoading(false);
    }
  }

  // Update a collection
  async function updateCollection(
    id: string,
    request: UpdateCollectionRequest
  ): Promise<ModCollection | null> {
    setLoading(true);
    setError(null);

    try {
      const result = await invoke<ModCollection>("update_collection", { id, request });
      await loadCollections();
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("[Collections] Failed to update collection:", e);
      return null;
    } finally {
      setLoading(false);
    }
  }

  // Delete a collection
  async function deleteCollection(id: string): Promise<boolean> {
    setLoading(true);
    setError(null);

    try {
      await invoke("delete_collection", { id });
      await loadCollections();
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("[Collections] Failed to delete collection:", e);
      return false;
    } finally {
      setLoading(false);
    }
  }

  // Add a mod to a collection
  async function addModToCollection(request: AddModToCollectionRequest): Promise<boolean> {
    try {
      await invoke("add_mod_to_collection", { request });
      await loadCollections(); // Refresh to update mod counts
      return true;
    } catch (e) {
      console.error("[Collections] Failed to add mod to collection:", e);
      return false;
    }
  }

  // Remove a mod from a collection
  async function removeModFromCollection(collectionId: string, modSlug: string): Promise<boolean> {
    try {
      await invoke("remove_mod_from_collection", { collectionId, modSlug });
      await loadCollections(); // Refresh to update mod counts
      return true;
    } catch (e) {
      console.error("[Collections] Failed to remove mod from collection:", e);
      return false;
    }
  }

  // Install all mods from a collection to an instance
  async function installCollection(
    collectionId: string,
    instanceId: string,
    minecraftVersion: string,
    loaderType: string
  ): Promise<CollectionInstallResult | null> {
    setLoading(true);
    setError(null);

    try {
      const result = await invoke<CollectionInstallResult>("install_collection", {
        collectionId,
        instanceId,
        minecraftVersion,
        loaderType,
      });
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("[Collections] Failed to install collection:", e);
      return null;
    } finally {
      setLoading(false);
    }
  }

  // Export collection to JSON
  async function exportCollection(id: string): Promise<ExportedCollection | null> {
    try {
      return await invoke<ExportedCollection>("export_collection", { id });
    } catch (e) {
      console.error("[Collections] Failed to export collection:", e);
      return null;
    }
  }

  // Import collection from JSON
  async function importCollection(exported: ExportedCollection): Promise<ModCollection | null> {
    setLoading(true);
    setError(null);

    try {
      const result = await invoke<ModCollection>("import_collection", { exported });
      await loadCollections();
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("[Collections] Failed to import collection:", e);
      return null;
    } finally {
      setLoading(false);
    }
  }

  // Duplicate a collection
  async function duplicateCollection(id: string, newName?: string): Promise<ModCollection | null> {
    setLoading(true);
    setError(null);

    try {
      const result = await invoke<ModCollection>("duplicate_collection", { id, newName });
      await loadCollections();
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("[Collections] Failed to duplicate collection:", e);
      return null;
    } finally {
      setLoading(false);
    }
  }

  // Get collections that contain a specific mod
  async function getCollectionsContainingMod(modSlug: string): Promise<ModCollection[]> {
    try {
      return await invoke<ModCollection[]>("get_collections_containing_mod", { modSlug });
    } catch (e) {
      console.error("[Collections] Failed to get collections containing mod:", e);
      return [];
    }
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
