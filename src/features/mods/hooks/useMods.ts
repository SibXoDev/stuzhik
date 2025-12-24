import { createSignal, createEffect } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { Mod, ModConflict, ConflictPredictionResult, ModRecommendation, ModSearchParams, ModSearchResponse, ModSearchResult, ModSource } from "../../../shared/types";

export function useMods(instanceId: () => string) {
  const [mods, setMods] = createSignal<Mod[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [resolvingDeps, setResolvingDeps] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [conflicts, setConflicts] = createSignal<ModConflict[]>([]);
  const [predictionLoading, setPredictionLoading] = createSignal(false);

  async function loadMods() {
    if (!instanceId()) return;

    try {
      setLoading(true);
      setError(null);
      const items = await invoke<Mod[]>("list_mods", { instanceId: instanceId() });
      setMods(items);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to load mods:", e);
    } finally {
      setLoading(false);
    }
  }

  async function installMod(
    slug: string,
    source: string,
    minecraftVersion: string,
    loader: string,
    versionId?: string
  ): Promise<Mod | null> {
    try {
      setLoading(true);
      setError(null);

      const mod = await invoke<Mod>("install_mod", {
        instanceId: instanceId(),
        slug,
        source,
        minecraftVersion,
        loader,
        versionId: versionId || null,
      });

      setMods(prev => [...prev, mod]);
      await checkDependencies();
      return mod;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to install mod:", e);
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function installLocalMod(filePath: string, analyze: boolean = true): Promise<Mod | null> {
    try {
      setLoading(true);
      setError(null);

      const mod = await invoke<Mod>("install_mod_local", {
        instanceId: instanceId(),
        filePath,
        analyze,
      });

      setMods(prev => [...prev, mod]);
      return mod;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to install local mod:", e);
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function toggleMod(modId: number, enabled: boolean) {
    try {
      setError(null);
      await invoke("toggle_mod", {
        instanceId: instanceId(),
        modId,
        enabled,
      });

      setMods(prev =>
        prev.map(mod =>
          mod.id === modId ? { ...mod, enabled } : mod
        )
      );

      await checkDependencies();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to toggle mod:", e);
    }
  }

  async function toggleModAutoUpdate(modId: number, autoUpdate: boolean) {
    try {
      setError(null);
      await invoke("toggle_mod_auto_update", {
        instanceId: instanceId(),
        modId,
        autoUpdate,
      });

      setMods(prev =>
        prev.map(mod =>
          mod.id === modId ? { ...mod, auto_update: autoUpdate } : mod
        )
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to toggle mod auto-update:", e);
    }
  }

  async function removeMod(modId: number) {
    try {
      setError(null);
      await invoke("remove_mod", {
        instanceId: instanceId(),
        modId,
      });

      setMods(prev => prev.filter(mod => mod.id !== modId));
      await checkDependencies();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to remove mod:", e);
    }
  }

  async function updateMod(modId: number) {
    try {
      setLoading(true);
      setError(null);

      await invoke("update_mod", {
        instanceId: instanceId(),
        modId,
      });

      await loadMods();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to update mod:", e);
    } finally {
      setLoading(false);
    }
  }

  async function checkDependencies() {
    try {
      const conflicts = await invoke<ModConflict[]>("check_mod_dependencies", {
        instanceId: instanceId(),
      });
      setConflicts(conflicts);
    } catch (e: unknown) {
      console.error("Failed to check dependencies:", e);
    }
  }

  async function autoResolveDependencies(minecraftVersion: string, loader: string) {
    try {
      setResolvingDeps(true);
      setError(null);

      const installedMods = await invoke<Mod[]>("resolve_dependencies", {
        instanceId: instanceId(),
        minecraftVersion,
        loader,
      });

      if (installedMods.length > 0) {
        await loadMods();
        await checkDependencies();
      }

      return installedMods;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to resolve dependencies:", e);
      return [];
    } finally {
      setResolvingDeps(false);
    }
  }

  /**
   * Предсказывает конфликты ДО установки мода
   * @param modSlug - slug мода который планируем установить
   * @param loader - загрузчик (fabric, forge, neoforge, quilt)
   * @returns результат предсказания с конфликтами
   */
  async function predictConflicts(
    modSlug: string,
    loader: string
  ): Promise<ConflictPredictionResult | null> {
    try {
      setPredictionLoading(true);
      setError(null);

      const result = await invoke<ConflictPredictionResult>("predict_mod_conflicts", {
        modSlug,
        instanceId: instanceId(),
        loader,
      });

      return result;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to predict conflicts:", e);
      return null;
    } finally {
      setPredictionLoading(false);
    }
  }

  /**
   * Получает список модов, которые конфликтуют с указанным
   * @param modSlug - slug мода
   * @returns массив slug'ов конфликтующих модов
   */
  async function getConflictingMods(modSlug: string): Promise<string[]> {
    try {
      return await invoke<string[]>("get_conflicting_mods", { modSlug });
    } catch (e: unknown) {
      console.error("Failed to get conflicting mods:", e);
      return [];
    }
  }

  /**
   * Проверяет, есть ли известные проблемы с модом
   * @param modSlug - slug мода
   * @returns true если есть известные проблемы
   */
  async function hasKnownIssues(modSlug: string): Promise<boolean> {
    try {
      return await invoke<boolean>("has_mod_known_issues", { modSlug });
    } catch (e: unknown) {
      console.error("Failed to check known issues:", e);
      return false;
    }
  }

  createEffect(() => {
    if (instanceId()) {
      loadMods();
      checkDependencies();
    }
  });

  return {
    mods,
    loading,
    resolvingDeps,
    predictionLoading,
    error,
    conflicts,
    loadMods,
    installMod,
    installLocalMod,
    toggleMod,
    toggleModAutoUpdate,
    removeMod,
    updateMod,
    checkDependencies,
    autoResolveDependencies,
    // Conflict Predictor
    predictConflicts,
    getConflictingMods,
    hasKnownIssues,
  };
}

export function useModSearch() {
  const [results, setResults] = createSignal<ModSearchResult[]>([]);
  const [totalHits, setTotalHits] = createSignal(0);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function search(
    query: string,
    minecraftVersion?: string,
    loader?: string,
    source?: string,
    limit?: number,
    offset?: number,
    searchMode?: "name" | "id" | "all",
    index?: string
  ) {
    try {
      setLoading(true);
      setError(null);

      const params: ModSearchParams = {
        query,
        minecraftVersion: minecraftVersion || "",
        loader: loader || "",
        source: (source || "modrinth") as ModSource,
        limit: limit || 20,
        offset: offset || 0,
        searchMode: searchMode || "name",
        index: index,
      };

      const data = await invoke<ModSearchResponse | ModSearchResult[]>("search_mods", params);

      // API возвращает структуру { hits: [...], offset, limit, total_hits }
      // Нужно извлечь массив hits
      if (data && typeof data === 'object' && 'hits' in data) {
        setResults(data.hits || []);
        setTotalHits(data.total_hits || 0);
      } else if (Array.isArray(data)) {
        // Fallback если вдруг вернулся просто массив
        setResults(data);
        setTotalHits(data.length);
      } else {
        console.warn("Unexpected search results format:", data);
        setResults([]);
        setTotalHits(0);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to search mods:", e);
      setResults([]);
      setTotalHits(0);
    } finally {
      setLoading(false);
    }
  }

  function clearResults() {
    setResults([]);
    setTotalHits(0);
  }

  return {
    results,
    totalHits,
    loading,
    error,
    search,
    clearResults,
  };
}

/**
 * Hook for getting mod recommendations based on installed mods
 */
export function useModRecommendations(
  instanceId: () => string,
  minecraftVersion: () => string,
  loader: () => string
) {
  const [recommendations, setRecommendations] = createSignal<ModRecommendation[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function loadRecommendations(limit: number = 10) {
    if (!instanceId() || !minecraftVersion() || !loader()) {
      return;
    }

    try {
      setLoading(true);
      setError(null);

      const results = await invoke<ModRecommendation[]>("get_mod_recommendations", {
        instanceId: instanceId(),
        minecraftVersion: minecraftVersion(),
        loader: loader(),
        limit,
      });

      setRecommendations(results);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to load recommendations:", e);
      setRecommendations([]);
    } finally {
      setLoading(false);
    }
  }

  function clearRecommendations() {
    setRecommendations([]);
  }

  /**
   * Get human-readable reason for recommendation
   */
  function getReasonText(reason: ModRecommendation["reason"]): string {
    switch (reason.type) {
      case "same_category":
        return `Категория: ${reason.category}`;
      case "popular_with":
        return `Популярен с: ${reason.mod_names.slice(0, 2).join(", ")}`;
      case "addon_for":
        return `Дополнение для ${reason.mod_name}`;
      case "trending":
        return "В тренде";
      case "optimization":
        return "Оптимизация";
      case "common_dependency":
        return "Часто используется";
      default:
        return "Рекомендуется";
    }
  }

  return {
    recommendations,
    loading,
    error,
    loadRecommendations,
    clearRecommendations,
    getReasonText,
  };
}