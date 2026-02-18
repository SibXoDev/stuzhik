import { Show, For, Switch, Match, Component } from "solid-js";
import type { CompareSourceType, ModpackSearchResult, ModpackVersionInfo, Instance } from "../../../shared/types";
import { sanitizeImageUrl } from "../../../shared/utils/url-validator";
import { Select } from "../../../shared/ui";
import { useDebounce } from "../../../shared/hooks";
import { useI18n } from "../../../shared/i18n";

interface CompareSourceSelectorProps {
  sourceType: CompareSourceType;
  setSourceType: (t: CompareSourceType) => void;
  path: string;
  setPath: (p: string) => void;
  selectedInstance: string;
  setSelectedInstance: (id: string) => void;
  platformSearch: string;
  setPlatformSearch: (s: string) => void;
  platformResults: ModpackSearchResult[];
  setPlatformResults: (r: ModpackSearchResult[]) => void;
  selectedModpack: ModpackSearchResult | null;
  setSelectedModpack: (m: ModpackSearchResult | null) => void;
  modpackVersions: ModpackVersionInfo[];
  setModpackVersions: (v: ModpackVersionInfo[]) => void;
  selectedVersion: string;
  setSelectedVersion: (v: string) => void;
  searching: boolean;
  setSearching: (s: boolean) => void;
  label: string;
  colorClass: string;
  instances: Instance[];
  onSelectFile: (setter: (path: string) => void) => void;
  onSearchPlatform: (query: string, source: "modrinth" | "curseforge", setResults: (r: ModpackSearchResult[]) => void, setSearching: (s: boolean) => void) => void;
  onLoadVersions: (modpack: ModpackSearchResult, setVersions: (v: ModpackVersionInfo[]) => void) => void;
}

const getFileName = (path: string) => path.split(/[/\\]/).pop() || path;

export const CompareSourceSelector: Component<CompareSourceSelectorProps> = (p) => {
  const { t } = useI18n();
  const { debounce } = useDebounce();

  const handleSearchInput = (value: string) => {
    p.setPlatformSearch(value);
    if (value.length >= 2) {
      debounce(() => {
        const source = p.sourceType === "modrinth" ? "modrinth" : "curseforge";
        p.onSearchPlatform(value, source as "modrinth" | "curseforge", p.setPlatformResults, p.setSearching);
      }, 300);
    }
  };

  const selectModpack = (modpack: ModpackSearchResult) => {
    p.setSelectedModpack(modpack);
    p.setPlatformResults([]);
    p.onLoadVersions(modpack, p.setModpackVersions);
  };

  return (
    <div class="space-y-3">
      <label class={`text-sm font-medium ${p.colorClass}`}>{p.label}</label>

      <div class="grid grid-cols-4 gap-1">
        <button
          class={`py-1.5 px-2 rounded text-xs font-medium transition-colors duration-100 ${p.sourceType === "file" ? "bg-[var(--color-primary)] text-white" : "bg-gray-800 text-muted hover:bg-gray-700"}`}
          onClick={() => p.setSourceType("file")}
        >
          {t().modpackCompare.sourceType.file}
        </button>
        <button
          class={`py-1.5 px-2 rounded text-xs font-medium transition-colors duration-100 ${p.sourceType === "instance" ? "bg-[var(--color-primary)] text-white" : "bg-gray-800 text-muted hover:bg-gray-700"}`}
          onClick={() => p.setSourceType("instance")}
        >
          {t().modpackCompare.sourceType.instance}
        </button>
        <button
          class={`py-1.5 px-2 rounded text-xs font-medium transition-colors duration-100 ${p.sourceType === "modrinth" ? "bg-green-600 text-white" : "bg-gray-800 text-muted hover:bg-gray-700"}`}
          onClick={() => p.setSourceType("modrinth")}
        >
          Modrinth
        </button>
        <button
          class={`py-1.5 px-2 rounded text-xs font-medium transition-colors duration-100 ${p.sourceType === "curseforge" ? "bg-orange-600 text-white" : "bg-gray-800 text-muted hover:bg-gray-700"}`}
          onClick={() => p.setSourceType("curseforge")}
        >
          CurseForge
        </button>
      </div>

      <Switch>
        <Match when={p.sourceType === "file"}>
          <button class="btn-secondary w-full" onClick={() => p.onSelectFile(p.setPath)}>
            <i class="i-hugeicons-folder-01 w-4 h-4" />
            {p.path ? getFileName(p.path) : t().modpackCompare.selectFile}
          </button>
        </Match>

        <Match when={p.sourceType === "instance"}>
          <Select
            value={p.selectedInstance}
            onChange={p.setSelectedInstance}
            placeholder={t().modpackCompare.selectInstance}
            options={[
              { value: "", label: t().modpackCompare.selectInstance },
              ...p.instances.map(instance => ({
                value: instance.id,
                label: instance.name
              }))
            ]}
          />
        </Match>

        <Match when={p.sourceType === "modrinth" || p.sourceType === "curseforge"}>
          <Show when={!p.selectedModpack} fallback={
            <div class="space-y-2">
              <div class="flex items-center gap-2 p-2 bg-gray-800 rounded-2xl">
                <Show when={sanitizeImageUrl(p.selectedModpack?.icon_url)}>
                  <img src={sanitizeImageUrl(p.selectedModpack?.icon_url)} class="w-8 h-8 rounded" alt="" />
                </Show>
                <div class="flex-1 min-w-0">
                  <div class="font-medium truncate">{p.selectedModpack?.title}</div>
                  <div class="text-xs text-muted">{p.selectedModpack?.author}</div>
                </div>
                <button
                  class="btn-ghost btn-sm"
                  onClick={() => {
                    p.setSelectedModpack(null);
                    p.setModpackVersions([]);
                    p.setSelectedVersion("");
                  }}
                  aria-label={t().ui?.tooltips?.close ?? "Close"}
                >
                  <i class="i-hugeicons-cancel-01 w-4 h-4" />
                </button>
              </div>
              <Show when={p.modpackVersions.length > 0}>
                <Select
                  value={p.selectedVersion}
                  onChange={p.setSelectedVersion}
                  placeholder={t().modpackCompare.latestVersion}
                  options={[
                    { value: "", label: t().modpackCompare.latestVersion },
                    ...p.modpackVersions.map(v => ({
                      value: v.id,
                      label: `${v.name} (${v.game_versions.join(", ")})`
                    }))
                  ]}
                />
              </Show>
            </div>
          }>
            <div class="space-y-2">
              <div>
                <input
                  type="text"
                  class="input w-full pl-8"
                  placeholder={t().modpackCompare.searchModpack}
                  value={p.platformSearch}
                  onInput={(e) => handleSearchInput(e.target.value)}
                />
                <i class="i-hugeicons-search-01 w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
                <Show when={p.searching}>
                  <i class="i-svg-spinners-6-dots-scale w-4 h-4 absolute right-2.5 top-1/2 -translate-y-1/2" />
                </Show>
              </div>
              <Show when={p.platformResults.length > 0}>
                <div class="max-h-40 overflow-y-auto space-y-1 p-1 bg-gray-900 rounded-2xl">
                  <For each={p.platformResults}>
                    {(modpack) => (
                      <button
                        class="w-full flex items-center gap-2 p-2 rounded hover:bg-gray-800 transition-colors duration-100 text-left"
                        onClick={() => selectModpack(modpack)}
                      >
                        <Show when={sanitizeImageUrl(modpack.icon_url)} fallback={
                          <div class="w-8 h-8 rounded bg-gray-700 flex-center">
                            <i class="i-hugeicons-package w-4 h-4 text-muted" />
                          </div>
                        }>
                          <img src={sanitizeImageUrl(modpack.icon_url)} class="w-8 h-8 rounded" alt="" />
                        </Show>
                        <div class="flex-1 min-w-0">
                          <div class="text-sm font-medium truncate">{modpack.title}</div>
                          <div class="text-xs text-muted">{modpack.author}</div>
                        </div>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </Show>
        </Match>
      </Switch>
    </div>
  );
};
