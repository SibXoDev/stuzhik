import { createSignal, createEffect, For, Show, onMount, createMemo } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { MinecraftVersion } from "../types";
import Dropdown from "../ui/Dropdown";
import { useI18n, getSafeLocale } from "../i18n";

interface Props {
  value: string;
  onChange: (version: string) => void;
  disabled?: boolean;
  loader?: string;
}

interface LoaderCompatibility {
  isCompatible: boolean;
  availableVersions: string[];
  message?: string;
}

function VersionSelector(props: Props) {
  const { t, language } = useI18n();
  const [versions, setVersions] = createSignal<MinecraftVersion[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [showDropdown, setShowDropdown] = createSignal(false);
  const [compatibility, setCompatibility] = createSignal<LoaderCompatibility | null>(null);

  // Настройки фильтрации
  const [showSnapshots, setShowSnapshots] = createSignal(false);
  const [showOldBeta, setShowOldBeta] = createSignal(false);
  const [showOldAlpha, setShowOldAlpha] = createSignal(false);

  // Загрузка версий один раз при монтировании
  onMount(() => {
    loadVersions();
  });

  const loadVersions = async () => {
    try {
      setLoading(true);
      const data = await invoke<MinecraftVersion[]>("fetch_minecraft_versions");
      setVersions(data);

      if (!props.value && data.length > 0) {
        const latestRelease = data.find(v => v.type === "release");
        if (latestRelease) {
          props.onChange(latestRelease.id);
        }
      }
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to load versions:", e);
    } finally {
      setLoading(false);
    }
  };

  const checkLoaderCompatibility = async (mcVersion: string, loader: string) => {
    try {
      const availableVersions = await invoke<string[]>("get_loader_versions", {
        minecraftVersion: mcVersion,
        loader: loader,
      });

      if (availableVersions.length === 0) {
        const msg = (t().versions?.loaderNotSupported ?? "{loader} does not support Minecraft {version}")
          .replace("{loader}", loader)
          .replace("{version}", mcVersion);
        setCompatibility({
          isCompatible: false,
          availableVersions: [],
          message: msg,
        });
      } else {
        setCompatibility({
          isCompatible: true,
          availableVersions,
        });
      }
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to check loader compatibility:", e);
      const msg = (t().versions?.compatibilityCheckFailed ?? "Failed to check compatibility: {error}")
        .replace("{error}", String(e));
      setCompatibility({
        isCompatible: false,
        availableVersions: [],
        message: msg,
      });
    }
  };

  // Мемоизированный ключ для проверки совместимости загрузчика
  const compatibilityKey = createMemo(() => {
    const mcVersion = props.value;
    const loader = props.loader;

    if (!mcVersion || !loader || loader === "vanilla") {
      return null;
    }

    return `${mcVersion}:${loader}`;
  });

  // Эффект для проверки совместимости (только при изменении ключа)
  createEffect(() => {
    const key = compatibilityKey();

    if (key) {
      const [mcVersion, loader] = key.split(":");
      checkLoaderCompatibility(mcVersion, loader);
    } else {
      setCompatibility(null);
    }
  });

  // Мемоизированная фильтрация версий
  const filteredVersions = createMemo(() => {
    const versionsList = versions();
    const searchQueryFilter = searchQuery();
    const snapshots = showSnapshots();
    const oldBeta = showOldBeta();
    const oldAlpha = showOldAlpha();

    let filtered = versionsList.filter((version) => {
      if (version.type === "release") return true;
      if (version.type === "snapshot" && snapshots) return true;
      if (version.type === "old_beta" && oldBeta) return true;
      if (version.type === "old_alpha" && oldAlpha) return true;
      return false;
    });

    if (searchQueryFilter) {
      filtered = filtered.filter((version) =>
        version.id.toLowerCase().includes(searchQueryFilter.toLowerCase())
      );
    }

    return filtered;
  });

  const handleSelect = (versionId: string) => {
    props.onChange(versionId);
    setShowDropdown(false);
    setSearchQuery("");
  };

  const getVersionTypeLabel = (type: string) => {
    const types = t().versions?.types;
    switch (type) {
      case "release":
        return { label: types?.release ?? "Release", color: "text-green-400" };
      case "snapshot":
        return { label: types?.snapshot ?? "Snapshot", color: "text-yellow-400" };
      case "old_beta":
        return { label: types?.old_beta ?? "Beta", color: "text-blue-400" };
      case "old_alpha":
        return { label: types?.old_alpha ?? "Alpha", color: "text-purple-400" };
      default:
        return { label: type, color: "text-gray-400" };
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString(getSafeLocale(language()), {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  const triggerButton = (
    <button
      type="button"
      class={`flex items-center justify-between btn w-full ${
        compatibility() && !compatibility()!.isCompatible ? "border-red-500" : ""
      }`}
      onClick={() => setShowDropdown(!showDropdown())}
      disabled={props.disabled || loading()}
    >
      <div class="flex items-center gap-2">
        <Show
          when={!loading()}
          fallback={<i class="i-svg-spinners-6-dots-scale w-4 h-4" />}
        >
          <Show
            when={compatibility() && !compatibility()!.isCompatible}
            fallback={<i class="i-hugeicons-git-branch w-4 h-4 text-gray-400" />}
          >
            <i class="i-hugeicons-alert-02 w-4 h-4 text-red-400" />
          </Show>
        </Show>
        <span>{props.value || (t().versions?.select ?? "Select version")}</span>
      </div>
      <i class={`${showDropdown() ? "i-hugeicons-arrow-up-01" : "i-hugeicons-arrow-down-01"} w-5 h-5 text-gray-400 transition-transform`} />
    </button>
  );

  return (
    <div>
      <Dropdown
        trigger={triggerButton}
        open={showDropdown()}
        onClose={() => setShowDropdown(false)}
        disabled={props.disabled || loading()}
      >
        {/* Search & Filters */}
        <div class="p-3 border-b border-gray-800 space-y-2 flex-shrink-0">
          <div>
            <input
              type="text"
              placeholder={t().ui?.placeholders?.searchVersions ?? "Search versions..."}
              value={searchQuery()}
              onInput={(e) => setSearchQuery(e.currentTarget.value)}
              class="w-full pl-9"
              onClick={(e) => e.stopPropagation()}
            />
            <i class="i-hugeicons-search-01 absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          </div>

          <div class="flex items-center gap-3 text-xs flex-wrap">
            <label class="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={showSnapshots()}
                onChange={(e) => setShowSnapshots(e.currentTarget.checked)}
                class="w-3.5 h-3.5 rounded-md"
              />
              <span class="text-gray-400">{t().versions?.filters?.snapshots ?? "Snapshots"}</span>
            </label>

            <label class="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={showOldBeta()}
                onChange={(e) => setShowOldBeta(e.currentTarget.checked)}
                class="w-3.5 h-3.5 rounded-md"
              />
              <span class="text-gray-400">{t().versions?.filters?.oldBeta ?? "Old beta"}</span>
            </label>

            <label class="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={showOldAlpha()}
                onChange={(e) => setShowOldAlpha(e.currentTarget.checked)}
                class="w-3.5 h-3.5 rounded-md"
              />
              <span class="text-gray-400">{t().versions?.filters?.oldAlpha ?? "Old alpha"}</span>
            </label>
          </div>
        </div>

        {/* Versions List */}
        <div class="overflow-y-auto flex-1">
          <Show
            when={filteredVersions().length > 0}
            fallback={
              <div class="p-8 text-center text-gray-500 text-sm">
                <i class="i-hugeicons-search-02 w-10 h-10 mx-auto mb-2 text-gray-600" />
                <p>{t().versions?.notFound ?? "No versions found"}</p>
              </div>
            }
          >
            <div class="p-1">
              <For each={filteredVersions()}>
                {(version) => {
                  const typeInfo = getVersionTypeLabel(version.type);
                  return (
                    <button
                      type="button"
                      class={`w-full px-3 py-2.5 flex items-center justify-between hover:bg-gray-700/50 transition-colors text-left rounded-2xl ${
                        props.value === version.id ? "bg-[var(--color-primary-bg)] hover:bg-[var(--color-primary-bg)]" : ""
                      }`}
                      onClick={() => handleSelect(version.id)}
                    >
                      <div class="flex-1 min-w-0">
                        <div class="flex items-center gap-2 mb-0.5">
                          <span class="font-medium text-sm">{version.id}</span>
                          <span class={`text-xs ${typeInfo.color}`}>
                            {typeInfo.label}
                          </span>
                        </div>
                        <div class="flex items-center gap-3 text-xs text-gray-500">
                          <span class="flex items-center gap-1">
                            <i class="i-hugeicons-calendar-01 w-3 h-3" />
                            {formatDate(version.release_time)}
                          </span>
                          <span class="flex items-center gap-1">
                            <i class="i-hugeicons-cpu w-3 h-3" />
                            Java {version.java_version}
                          </span>
                        </div>
                      </div>
                      <Show when={props.value === version.id}>
                        <i class="i-hugeicons-checkmark-circle-02 w-5 h-5 text-[var(--color-primary)] flex-shrink-0" />
                      </Show>
                    </button>
                  );
                }}
              </For>
            </div>
          </Show>
        </div>

        {/* Footer */}
        <div class="p-2 border-t border-gray-800 text-xs text-gray-500 text-center flex-shrink-0">
          {(t().versions?.showingOf ?? "Showing {shown} of {total} versions")
            .replace("{shown}", String(filteredVersions().length))
            .replace("{total}", String(versions().length))}
        </div>
      </Dropdown>

      {/* Compatibility Warning */}
      <Show when={compatibility() && !compatibility()!.isCompatible}>
        <div class="mt-2 p-2 bg-red-900/20 border border-red-500/30 rounded-2xl text-xs text-red-400">
          <div class="flex items-start gap-2">
            <i class="i-hugeicons-alert-02 w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>{compatibility()!.message}</span>
          </div>
        </div>
      </Show>
    </div>
  );
}

export default VersionSelector;