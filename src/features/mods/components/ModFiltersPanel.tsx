import { Show, Component } from "solid-js";
import { Select } from "../../../shared/ui";

interface FilterCounts {
  total: number;
  enabled: number;
  disabled: number;
  modrinth: number;
  curseforge: number;
  local: number;
  autoUpdateYes: number;
  autoUpdateNo: number;
  hasUpdate: number;
  noUpdate: number;
}

interface ModFiltersPanelProps {
  filterEnabled: string;
  filterSource: string;
  filterAutoUpdate: string;
  filterVerification: string;
  filterUpdateAvailable: string;
  verifiedCount: number;
  unverifiedCount: number;
  filterCounts: FilterCounts;
  hasActiveFilters: boolean;
  onSetFilterEnabled: (v: string) => void;
  onSetFilterSource: (v: string) => void;
  onSetFilterAutoUpdate: (v: string) => void;
  onSetFilterVerification: (v: string) => void;
  onSetFilterUpdateAvailable: (v: string) => void;
  onClearFilters: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: () => any;
}

export const ModFiltersPanel: Component<ModFiltersPanelProps> = (props) => {
  const t = () => props.t();

  return (
    <div class="card bg-gray-800/50 flex flex-col gap-3">
      <div class="flex items-center justify-between">
        <h4 class="text-sm font-semibold flex items-center gap-2">
          <i class="i-hugeicons-filter w-4 h-4" />
          {t().mods.list.filters.title}
        </h4>
        <Show when={props.hasActiveFilters}>
          <button
            class="text-sm text-[var(--color-primary)] hover:text-[var(--color-primary-light)]"
            onClick={props.onClearFilters}
          >
            {t().mods.list.filters.resetAll}
          </button>
        </Show>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
        {/* Enabled/Disabled Filter */}
        <div class="flex flex-col gap-1">
          <label class="block text-xs font-medium text-gray-400">{t().mods.list.filters.state}</label>
          <Select
            value={props.filterEnabled}
            onChange={props.onSetFilterEnabled}
            options={[
              { value: "all", label: `${t().mods.list.filters.allStates} (${props.filterCounts.total})`, icon: "i-hugeicons-apps-01" },
              { value: "enabled", label: `${t().mods.list.filters.enabled} (${props.filterCounts.enabled})`, icon: "i-hugeicons-checkmark-circle-02" },
              { value: "disabled", label: `${t().mods.list.filters.disabled} (${props.filterCounts.disabled})`, icon: "i-hugeicons-cancel-circle" },
            ]}
          />
        </div>

        {/* Source Filter */}
        <div class="flex flex-col gap-1">
          <label class="block text-xs font-medium text-gray-400">{t().mods.list.filters.source}</label>
          <Select
            value={props.filterSource}
            onChange={props.onSetFilterSource}
            options={[
              { value: "all", label: t().mods.list.filters.allSources, icon: "i-hugeicons-globe-02" },
              { value: "modrinth", label: `Modrinth (${props.filterCounts.modrinth})`, icon: "i-simple-icons-modrinth" },
              { value: "curseforge", label: `CurseForge (${props.filterCounts.curseforge})`, icon: "i-simple-icons-curseforge" },
              { value: "local", label: `${t().mods.list.filters.local} (${props.filterCounts.local})`, icon: "i-hugeicons-folder-01" },
            ]}
          />
        </div>

        {/* Verification Filter */}
        <div class="flex flex-col gap-1">
          <label class="block text-xs font-medium text-gray-400">{t().mods.list.filters.security}</label>
          <Select
            value={props.filterVerification}
            onChange={props.onSetFilterVerification}
            options={[
              { value: "all", label: t().mods.list.filters.anyStatus, icon: "i-hugeicons-shield-01" },
              { value: "verified", label: `${t().mods.list.filters.verified} (${props.verifiedCount})`, icon: "i-hugeicons-security-check" },
              { value: "unverified", label: `${t().mods.list.filters.unverified} (${props.unverifiedCount})`, icon: "i-hugeicons-help-circle" },
              { value: "modified", label: `${t().mods.list.filters.modified} (0)`, icon: "i-hugeicons-alert-02" },
            ]}
          />
        </div>

        {/* Auto-update Filter */}
        <div class="flex flex-col gap-1">
          <label class="block text-xs font-medium text-gray-400">{t().mods.list.filters.autoUpdate}</label>
          <Select
            value={props.filterAutoUpdate}
            onChange={props.onSetFilterAutoUpdate}
            options={[
              { value: "all", label: t().mods.list.filters.any, icon: "i-hugeicons-refresh" },
              { value: "yes", label: `${t().mods.list.filters.enabled} (${props.filterCounts.autoUpdateYes})`, icon: "i-hugeicons-checkmark-circle-02" },
              { value: "no", label: `${t().mods.list.filters.disabled} (${props.filterCounts.autoUpdateNo})`, icon: "i-hugeicons-cancel-circle" },
            ]}
          />
        </div>

        {/* Update Available Filter */}
        <div>
          <label class="block text-xs font-medium mb-1 text-gray-400">{t().mods.list.filters.updates}</label>
          <Select
            value={props.filterUpdateAvailable}
            onChange={props.onSetFilterUpdateAvailable}
            options={[
              { value: "all", label: t().mods.list.filters.anyUpdates, icon: "i-hugeicons-arrow-up-02" },
              { value: "has_update", label: `${t().mods.list.filters.hasUpdate} (${props.filterCounts.hasUpdate})`, icon: "i-hugeicons-arrow-up-double" },
              { value: "no_update", label: `${t().mods.list.filters.noUpdate} (${props.filterCounts.noUpdate})`, icon: "i-hugeicons-checkmark-circle-02" },
            ]}
          />
        </div>
      </div>

      {/* Active Filters Summary */}
      <Show when={props.hasActiveFilters}>
        <div class="mt-3 pt-3 border-t border-gray-700 flex items-center gap-2 flex-wrap text-xs">
          <span class="text-gray-500">{t().mods.list.filters.activeFilters}</span>
          <Show when={props.filterEnabled !== "all"}>
            <span class="px-2 py-1 rounded bg-[var(--color-primary-bg)] text-[var(--color-primary)] border border-[var(--color-primary-border)]">
              {props.filterEnabled === "enabled" ? t().mods.list.filters.enabled : t().mods.list.filters.disabled}
            </span>
          </Show>
          <Show when={props.filterSource !== "all"}>
            <span class="px-2 py-1 rounded bg-purple-600/20 text-purple-400 border border-purple-600/30 capitalize">
              {props.filterSource}
            </span>
          </Show>
          <Show when={props.filterAutoUpdate !== "all"}>
            <span class="px-2 py-1 rounded bg-orange-600/20 text-orange-400 border border-orange-600/30">
              {props.filterAutoUpdate === "yes" ? t().mods.list.filters.autoUpdateYes : t().mods.list.filters.autoUpdateNo}
            </span>
          </Show>
          <Show when={props.filterVerification !== "all"}>
            <span class={`px-2 py-1 rounded border ${
              props.filterVerification === "verified"
                ? "bg-green-600/20 text-green-400 border-green-600/30"
                : props.filterVerification === "modified"
                ? "bg-yellow-600/20 text-yellow-400 border-yellow-600/30"
                : "bg-gray-600/20 text-gray-400 border-gray-600/30"
            }`}>
              {props.filterVerification === "verified" ? t().mods.list.filters.verified : props.filterVerification === "modified" ? t().mods.list.filters.modified : t().mods.list.filters.unverified}
            </span>
          </Show>
          <Show when={props.filterUpdateAvailable !== "all"}>
            <span class={`px-2 py-1 rounded border ${
              props.filterUpdateAvailable === "has_update"
                ? "bg-cyan-600/20 text-cyan-400 border-cyan-600/30"
                : "bg-gray-600/20 text-gray-400 border-gray-600/30"
            }`}>
              {props.filterUpdateAvailable === "has_update" ? t().mods.list.filters.hasUpdates : t().mods.list.filters.noUpdates}
            </span>
          </Show>
        </div>
      </Show>
    </div>
  );
};
