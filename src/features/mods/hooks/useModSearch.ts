import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { ModSearchResult, ModSearchResponse, ModSource } from "../../../shared/types";

/**
 * Hook for searching mods (used in ModsBrowser)
 */
export function useModSearch() {
  const [results, setResults] = createSignal<ModSearchResult[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [totalHits, setTotalHits] = createSignal(0);

  async function search(
    query: string,
    minecraftVersion?: string,
    loader?: string,
    source?: ModSource,
    limit?: number,
    offset?: number,
    mode?: string,
    sort?: string
  ): Promise<void> {
    try {
      setLoading(true);
      setError(null);
      // Backend expects individual parameters, not an object
      const response = await invoke<ModSearchResponse>("search_mods", {
        query,
        minecraftVersion: minecraftVersion || null,
        loader: loader || null,
        source: source || "modrinth",
        limit: limit || 20,
        offset: offset || 0,
        searchMode: mode || null,
        index: sort || null,
      });
      setResults(response.hits);
      setTotalHits(response.total_hits);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setResults([]);
      setTotalHits(0);
    } finally {
      setLoading(false);
    }
  }

  return {
    results,
    loading,
    error,
    totalHits,
    search,
  };
}
