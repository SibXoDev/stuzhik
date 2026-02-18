/**
 * Hytale Mods Browser
 * Search and install Hytale mods from CurseForge
 */

import { For, Show, createSignal, createEffect } from "solid-js";
import type { Component } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../../../shared/i18n";
import { Pagination, Select } from "../../../shared/ui";
import { useDebounce } from "../../../shared/hooks";
import { sanitizeImageUrl } from "../../../shared/utils/url-validator";

// Hytale mod types
type HytaleModType = "Pack" | "Plugin" | "EarlyPlugin";

interface HytaleMod {
  id: string;
  name: string;
  slug: string;
  summary: string;
  mod_type: HytaleModType;
  downloads: number;
  icon_url: string | null;
  curseforge_id: number;
  author: string;
  version: string | null;
  file_name: string | null;
}

interface Props {
  instanceId: string;
  instancePath: string;
  onInstall?: (mod: HytaleMod) => void;
}

// Mod type filter options
const MOD_TYPE_OPTIONS: { value: HytaleModType | "all"; label: string }[] = [
  { value: "all", label: "All Types" },
  { value: "Pack", label: "Content Packs" },
  { value: "Plugin", label: "Plugins" },
  { value: "EarlyPlugin", label: "Early Plugins" },
];

const HytaleModsBrowser: Component<Props> = (props) => {
  const { t } = useI18n();
  const { debounce } = useDebounce();

  const [query, setQuery] = createSignal("");
  const [modType, setModType] = createSignal<HytaleModType | "all">("all");
  const [results, setResults] = createSignal<HytaleMod[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [page, setPage] = createSignal(0);
  const [installingIds, setInstallingIds] = createSignal<Set<number>>(new Set());

  const pageSize = 20;

  // Search function
  const searchMods = async () => {
    setLoading(true);
    setError(null);

    try {
      const typeFilter = modType() === "all" ? null : modType();
      const mods = await invoke<HytaleMod[]>("search_hytale_mods_cmd", {
        query: query(),
        modType: typeFilter,
        page: page(),
        pageSize,
      });
      setResults(mods);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      if (import.meta.env.DEV) console.error("Failed to search Hytale mods:", e);
    } finally {
      setLoading(false);
    }
  };

  // Load popular mods on mount
  createEffect(() => {
    searchMods();
  });

  // Debounced search on query change
  const handleQueryChange = (value: string) => {
    setQuery(value);
    setPage(0);
    debounce(() => searchMods(), 300);
  };

  // Install mod
  const handleInstall = async (mod: HytaleMod) => {
    if (installingIds().has(mod.curseforge_id)) return;

    setInstallingIds(prev => new Set(prev).add(mod.curseforge_id));

    try {
      await invoke("install_hytale_mod_cmd", {
        curseforgeId: mod.curseforge_id,
        instancePath: props.instancePath,
        modType: mod.mod_type,
      });

      props.onInstall?.(mod);
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to install Hytale mod:", e);
    } finally {
      setInstallingIds(prev => {
        const next = new Set(prev);
        next.delete(mod.curseforge_id);
        return next;
      });
    }
  };

  // Get mod type label
  const getModTypeLabel = (type: HytaleModType): string => {
    switch (type) {
      case "Pack": return t().games?.hytale?.modTypes?.pack ?? "Content Pack";
      case "Plugin": return t().games?.hytale?.modTypes?.plugin ?? "Plugin";
      case "EarlyPlugin": return t().games?.hytale?.modTypes?.earlyPlugin ?? "Early Plugin";
      default: return type;
    }
  };

  // Get mod type color
  const getModTypeColor = (type: HytaleModType): string => {
    switch (type) {
      case "Pack": return "bg-green-600/20 text-green-400 border-green-600/30";
      case "Plugin": return "bg-blue-600/20 text-blue-400 border-blue-600/30";
      case "EarlyPlugin": return "bg-purple-600/20 text-purple-400 border-purple-600/30";
      default: return "bg-gray-600/20 text-gray-400 border-gray-600/30";
    }
  };

  // Format download count
  const formatDownloads = (count: number): string => {
    if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
    if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
    return count.toString();
  };

  return (
    <div class="flex flex-col gap-4 h-full">
      {/* Search and Filters */}
      <div class="flex gap-3">
        <div class="flex-1">
          <i class="i-hugeicons-search-01 absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            type="text"
            value={query()}
            onInput={(e) => handleQueryChange(e.currentTarget.value)}
            placeholder={t().mods?.browser?.searchPlaceholder ?? "Search Hytale mods..."}
            class="w-full pl-10 pr-4 py-2 bg-gray-800 border border-gray-700 rounded-lg focus:border-[var(--color-primary)] focus:outline-none"
          />
        </div>

        <Select
          value={modType()}
          options={MOD_TYPE_OPTIONS}
          onChange={(val) => {
            setModType(val as HytaleModType | "all");
            setPage(0);
            searchMods();
          }}
          placeholder="Filter by type"
        />
      </div>

      {/* Error */}
      <Show when={error()}>
        <div class="p-4 rounded-xl bg-red-500/10 border border-red-500/20">
          <p class="text-red-400">{error()}</p>
        </div>
      </Show>

      {/* Loading */}
      <Show when={loading()}>
        <div class="flex items-center justify-center py-12 gap-3">
          <i class="i-svg-spinners-6-dots-scale w-8 h-8 text-orange-500" />
          <span class="text-gray-400">{t().common?.loading ?? "Loading..."}</span>
        </div>
      </Show>

      {/* Results */}
      <Show when={!loading() && results().length > 0}>
        <div class="flex-1 overflow-y-auto min-h-0">
          <div class="grid gap-3">
            <For each={results()}>
              {(mod) => {
                const isInstalling = () => installingIds().has(mod.curseforge_id);

                return (
                  <div class="flex items-start gap-4 p-4 bg-gray-800/50 rounded-xl border border-gray-750 hover:border-gray-600 transition-colors">
                    {/* Icon */}
                    <Show
                      when={mod.icon_url}
                      fallback={
                        <div class="w-12 h-12 rounded-lg bg-gray-700 flex items-center justify-center flex-shrink-0">
                          <i class="i-hugeicons-package w-6 h-6 text-gray-500" />
                        </div>
                      }
                    >
                      <img
                        src={sanitizeImageUrl(mod.icon_url!)}
                        alt={mod.name}
                        class="w-12 h-12 rounded-lg object-cover flex-shrink-0"
                        loading="lazy"
                      />
                    </Show>

                    {/* Info */}
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center gap-2 mb-1">
                        <h3 class="font-semibold truncate">{mod.name}</h3>
                        <span class={`px-2 py-0.5 text-xs rounded-full border ${getModTypeColor(mod.mod_type)}`}>
                          {getModTypeLabel(mod.mod_type)}
                        </span>
                      </div>

                      <p class="text-sm text-gray-400 line-clamp-2 mb-2">{mod.summary}</p>

                      <div class="flex items-center gap-4 text-xs text-gray-500">
                        <span class="flex items-center gap-1">
                          <i class="i-hugeicons-user w-3 h-3" />
                          {mod.author}
                        </span>
                        <span class="flex items-center gap-1">
                          <i class="i-hugeicons-download-02 w-3 h-3" />
                          {formatDownloads(mod.downloads)}
                        </span>
                      </div>
                    </div>

                    {/* Install Button */}
                    <button
                      class="btn-primary flex-shrink-0"
                      onClick={() => handleInstall(mod)}
                      disabled={isInstalling()}
                    >
                      <Show
                        when={!isInstalling()}
                        fallback={<i class="i-svg-spinners-ring-resize w-4 h-4" />}
                      >
                        <i class="i-hugeicons-download-02 w-4 h-4" />
                      </Show>
                      {t().common?.install ?? "Install"}
                    </button>
                  </div>
                );
              }}
            </For>
          </div>
        </div>

        {/* Pagination */}
        <div class="flex-shrink-0 border-t border-gray-750 pt-4">
          <Pagination
            currentPage={page()}
            totalPages={Math.ceil(results().length / pageSize) || 1}
            onPageChange={(p) => {
              setPage(p);
              searchMods();
            }}
          />
        </div>
      </Show>

      {/* No Results */}
      <Show when={!loading() && results().length === 0 && !error()}>
        <div class="flex flex-col items-center justify-center py-12 gap-4">
          <i class="i-hugeicons-search-01 w-12 h-12 text-gray-600" />
          <div class="text-center">
            <p class="text-gray-400">{t().mods?.browser?.noResults ?? "No mods found"}</p>
            <p class="text-sm text-gray-500 mt-1">
              {t().mods?.browser?.tryDifferentQuery ?? "Try a different search query"}
            </p>
          </div>
        </div>
      </Show>
    </div>
  );
};

export default HytaleModsBrowser;
