import { createSignal, createResource, createEffect, Accessor } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type {
  MinecraftItem,
  MinecraftBlock,
  MinecraftTag,
  CacheStats,
  RebuildStats,
} from "../../types/code-editor/minecraft";

export function useMinecraftData(instanceId: Accessor<string>) {
  const [query, setQuery] = createSignal("");
  const [autoRebuild, setAutoRebuild] = createSignal(true);

  // Статистика кэша
  const [stats, { refetch: refetchStats }] = createResource(instanceId, async (id) => {
    if (!id) return null;

    try {
      return await invoke<CacheStats>("get_minecraft_data_stats", {
        instanceId: id,
      });
    } catch (e) {
      console.error("Failed to load Minecraft data stats:", e);
      return null;
    }
  });

  // Автоматический rebuild если кэш пустой
  createEffect(() => {
    const st = stats();
    if (
      autoRebuild() &&
      st &&
      st.total_items === 0 &&
      st.total_blocks === 0
    ) {
      rebuild();
    }
  });

  // Rebuild кэша
  const rebuild = async () => {
    const id = instanceId();
    if (!id) return null;

    try {
      const result = await invoke<RebuildStats>(
        "rebuild_minecraft_data_cache",
        {
          instanceId: id,
        }
      );

      // Обновляем статистику
      refetchStats();

      return result;
    } catch (e) {
      console.error("Failed to rebuild Minecraft data cache:", e);
      return null;
    }
  };

  // Поиск предметов
  const searchItems = async (
    searchQuery: string,
    limit?: number
  ): Promise<MinecraftItem[]> => {
    const id = instanceId();
    if (!id || !searchQuery.trim()) return [];

    try {
      return await invoke<MinecraftItem[]>("search_minecraft_items", {
        instanceId: id,
        query: searchQuery,
        limit: limit ?? 50,
      });
    } catch (e) {
      console.error("Failed to search items:", e);
      return [];
    }
  };

  // Поиск блоков
  const searchBlocks = async (
    searchQuery: string,
    limit?: number
  ): Promise<MinecraftBlock[]> => {
    const id = instanceId();
    if (!id || !searchQuery.trim()) return [];

    try {
      return await invoke<MinecraftBlock[]>("search_minecraft_blocks", {
        instanceId: id,
        query: searchQuery,
        limit: limit ?? 50,
      });
    } catch (e) {
      console.error("Failed to search blocks:", e);
      return [];
    }
  };

  // Поиск тегов
  const searchTags = async (
    searchQuery: string,
    tagType?: "item" | "block",
    limit?: number
  ): Promise<MinecraftTag[]> => {
    const id = instanceId();
    if (!id || !searchQuery.trim()) return [];

    try {
      return await invoke<MinecraftTag[]>("search_minecraft_tags", {
        instanceId: id,
        query: searchQuery,
        tagType,
        limit: limit ?? 50,
      });
    } catch (e) {
      console.error("Failed to search tags:", e);
      return [];
    }
  };

  return {
    stats,
    rebuild,
    searchItems,
    searchBlocks,
    searchTags,
    query,
    setQuery,
    setAutoRebuild,
  };
}
