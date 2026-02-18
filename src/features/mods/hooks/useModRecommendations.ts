import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { ModRecommendation } from "../../../shared/types";

/**
 * Hook for mod recommendations (used in ModRecommendations)
 */
export function useModRecommendations(
  instanceId: () => string,
  minecraftVersion?: () => string,
  loader?: () => string
) {
  const [recommendations, setRecommendations] = createSignal<ModRecommendation[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function loadRecommendations(limit: number = 10): Promise<void> {
    const id = instanceId();
    const mcVersion = minecraftVersion?.();
    const loaderType = loader?.();

    if (!id || !mcVersion || !loaderType) {
      // Cannot get recommendations without version and loader info
      return;
    }

    try {
      setLoading(true);
      setError(null);
      const recs = await invoke<ModRecommendation[]>("get_mod_recommendations", {
        instanceId: id,
        minecraftVersion: mcVersion,
        loader: loaderType,
        limit,
      });
      setRecommendations(recs);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setRecommendations([]);
    } finally {
      setLoading(false);
    }
  }

  function getReasonText(reason: ModRecommendation["reason"]): string {
    switch (reason.type) {
      case "same_category":
        return `Категория: ${reason.category}`;
      case "popular_with":
        return `Популярно с ${reason.mod_names.slice(0, 2).join(", ")}`;
      case "addon_for":
        return `Аддон для ${reason.mod_name}`;
      case "trending":
        return "Популярное";
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
    getReasonText,
  };
}
