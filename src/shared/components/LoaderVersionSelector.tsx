import { createSignal, createEffect, For, Show, createMemo } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import Dropdown from "../ui/Dropdown";
import { useI18n } from "../i18n";

interface Props {
  value: string;
  onChange: (version: string) => void;
  disabled?: boolean;
  loader: string;
  minecraftVersion: string;
  /** Callback when loader version availability changes */
  onAvailabilityChange?: (available: boolean) => void;
}

function LoaderVersionSelector(props: Props) {
  const { t } = useI18n();
  const [versions, setVersions] = createSignal<string[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [showDropdown, setShowDropdown] = createSignal(false);
  // Track if loader is not available for this MC version (loaded but empty)
  const [notAvailable, setNotAvailable] = createSignal(false);

  // Мемоизированная функция для отслеживания изменений loader + mcVersion
  const loaderKey = createMemo(() => {
    const loader = props.loader;
    const mcVersion = props.minecraftVersion;

    if (!loader || loader === "vanilla" || !mcVersion) {
      return null;
    }

    return `${loader}:${mcVersion}`;
  });

  // Один эффект с проверкой изменений через мемоизированный ключ
  createEffect(() => {
    const key = loaderKey();

    if (key) {
      const [loader, mcVersion] = key.split(":");
      loadVersions(loader, mcVersion);
    } else {
      setVersions([]);
    }
  });

  // Мемоизированная фильтрация версий
  const filteredVersions = createMemo(() => {
    const query = searchQuery().toLowerCase();
    const allVersions = versions();

    if (!query) {
      return allVersions;
    }

    return allVersions.filter((version) =>
      version.toLowerCase().includes(query)
    );
  });

  const loadVersions = async (loader: string, mcVersion: string) => {
    try {
      setLoading(true);
      setError(null);
      setNotAvailable(false);

      const data = await invoke<string[]>("get_loader_versions", {
        minecraftVersion: mcVersion,
        loader: loader,
      });

      setVersions(data);

      // Check if loader is not available for this MC version
      const hasVersions = data.length > 0;
      setNotAvailable(!hasVersions);
      props.onAvailabilityChange?.(hasVersions);
    } catch (e: unknown) {
      if (import.meta.env.DEV) console.error("Failed to load loader versions:", e);
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Не удалось загрузить версии: ${msg}`);
      setVersions([]);
      setNotAvailable(true);
      props.onAvailabilityChange?.(false);
    } finally {
      setLoading(false);
    }
  };

  const handleSelect = (version: string) => {
    props.onChange(version);
    setShowDropdown(false);
    setSearchQuery("");
  };

  const getLoaderColor = (loader: string) => {
    switch (loader) {
      case "forge":
        return "text-blue-400";
      case "neoforge":
        return "text-orange-400";
      case "fabric":
        return "text-purple-400";
      case "quilt":
        return "text-pink-400";
      default:
        return "text-gray-400";
    }
  };

  const getLoaderLabel = (loader: string) => {
    switch (loader) {
      case "forge":
        return "Forge";
      case "neoforge":
        return "NeoForge";
      case "fabric":
        return "Fabric";
      case "quilt":
        return "Quilt";
      default:
        return loader;
    }
  };

  // Get display text for the button
  const getButtonText = () => {
    if (props.loader === "vanilla") {
      return t().loaders?.notRequired || "Не требуется";
    }
    if (notAvailable() && !loading() && !error()) {
      return t().loaders?.notSupported || "Не поддерживается";
    }
    return props.value || t().loaders?.autoLatest || "Автоматически (последняя)";
  };

  const triggerButton = (
    <button
      type="button"
      class={`flex items-center justify-between btn w-full ${error() ? "border-red-500" : ""} ${notAvailable() && !loading() ? "border-yellow-500/50" : ""}`}
      onClick={() => {
        if (props.loader !== "vanilla" && versions().length > 0) {
          setShowDropdown(!showDropdown());
        }
      }}
      disabled={props.disabled || loading() || props.loader === "vanilla" || versions().length === 0}
    >
      <div class="flex items-center gap-2">
        <Show
          when={!loading()}
          fallback={<i class="i-svg-spinners-6-dots-scale w-4 h-4" />}
        >
          <Show
            when={error()}
            fallback={
              <Show
                when={notAvailable()}
                fallback={
                  <i class={`i-hugeicons-package w-4 h-4 ${getLoaderColor(props.loader)}`} />
                }
              >
                <i class="i-hugeicons-alert-02 w-4 h-4 text-yellow-400" />
              </Show>
            }
          >
            <i class="i-hugeicons-alert-02 w-4 h-4 text-red-400" />
          </Show>
        </Show>
        <span class={`text-sm ${notAvailable() && !loading() ? "text-yellow-400" : ""}`}>
          {getButtonText()}
        </span>
      </div>
      <Show when={props.loader !== "vanilla" && versions().length > 0}>
        <i
          class={`${showDropdown() ? "i-hugeicons-arrow-up-01" : "i-hugeicons-arrow-down-01"} w-5 h-5 text-gray-400 transition-transform`}
        />
      </Show>
    </button>
  );

  return (
    <div>
      <Dropdown
        trigger={triggerButton}
        open={showDropdown()}
        onClose={() => setShowDropdown(false)}
        disabled={props.disabled || loading() || props.loader === "vanilla" || versions().length === 0}
      >
        {/* Search */}
        <div class="p-3 border-b border-gray-800 flex-shrink-0">
          <div>
            <input
              type="text"
              placeholder={`Поиск версий ${getLoaderLabel(props.loader)}...`}
              value={searchQuery()}
              onInput={(e) => setSearchQuery(e.currentTarget.value)}
              class="w-full pl-9"
              onClick={(e) => e.stopPropagation()}
            />
            <i class="i-hugeicons-search-01 absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          </div>
        </div>

        {/* Versions List */}
        <div class="overflow-y-auto flex-1">
          <Show
            when={filteredVersions().length > 0}
            fallback={
              <div class="p-8 text-center text-gray-500 text-sm">
                <i class="i-hugeicons-search-02 w-10 h-10 mx-auto mb-2 text-gray-600" />
                <p>Версии не найдены</p>
              </div>
            }
          >
            <div class="p-1">
              <For each={filteredVersions()}>
                {(version) => (
                  <button
                    type="button"
                    class={`w-full px-3 py-2.5 flex items-center justify-between hover:bg-gray-700/50 transition-colors text-left rounded-2xl ${
                      props.value === version ? "bg-[var(--color-primary-bg)] hover:bg-[var(--color-primary-bg)]" : ""
                    }`}
                    onClick={() => handleSelect(version)}
                  >
                    <div class="flex-1 min-w-0">
                      <span class="font-medium text-sm">{version}</span>
                    </div>
                    <Show when={props.value === version}>
                      <i class="i-hugeicons-checkmark-circle-02 w-5 h-5 text-[var(--color-primary)] flex-shrink-0" />
                    </Show>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>

        {/* Footer */}
        <div class="p-2 border-t border-gray-800 text-xs text-gray-500 text-center flex-shrink-0">
          Показано {filteredVersions().length} из {versions().length} версий {getLoaderLabel(props.loader)}
        </div>
      </Dropdown>

      {/* Error Message */}
      <Show when={error()}>
        <div class="mt-2 p-2 bg-red-900/20 border border-red-500/30 rounded-2xl text-xs text-red-400">
          <div class="flex items-start gap-2">
            <i class="i-hugeicons-alert-02 w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>{error()}</span>
          </div>
        </div>
      </Show>

      {/* Not Available Warning */}
      <Show when={notAvailable() && !loading() && !error() && props.loader !== "vanilla"}>
        <div class="mt-2 p-2 bg-yellow-900/20 border border-yellow-500/30 rounded-2xl text-xs text-yellow-400">
          <div class="flex items-start gap-2">
            <i class="i-hugeicons-alert-02 w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>
              {t().loaders?.notSupportedHint ||
                `${getLoaderLabel(props.loader)} не поддерживает Minecraft ${props.minecraftVersion}. Выберите другую версию или загрузчик.`}
            </span>
          </div>
        </div>
      </Show>
    </div>
  );
}

export default LoaderVersionSelector;