import { For, Show, createSignal, createMemo, createEffect, onMount, onCleanup } from "solid-js";
import type { Component } from "solid-js";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useMods } from "../hooks/useMods";
import ModsBrowser from "./ModsBrowser";
import ModInfoDialog from "./ModInfoDialog";
import DependencyGraph from "./DependencyGraph";
import UpdateModsModal from "./UpdateModsModal";
import ChangelogAggregatorModal from "./ChangelogAggregatorModal";
import { ModCard } from "./ModCard";
import { ModFiltersPanel } from "./ModFiltersPanel";
import { VerificationResultsModal } from "./VerificationResultsModal";
import { createConfirmDialog } from "../../../shared/components/ConfirmDialog";
import { startModInstall, completeModInstall, registerDropHandler, filterByExtensions, registerSearchHandler, unregisterSearchHandler } from "../../../shared/stores";
import type { Mod } from "../../../shared/types";
import { Tabs, BulkOperationsToolbar, ModalWrapper, Tooltip } from "../../../shared/ui";
import { useMultiselect } from "../../../shared/hooks";
import { useI18n } from "../../../shared/i18n";
import { isVisible } from "../../../shared/stores/uiPreferences";

interface Props {
  instanceId: string;
  minecraftVersion: string;
  loader: string;
}

const ModsList: Component<Props> = (props) => {
  const { t } = useI18n();
  const mods = useMods(() => props.instanceId);
  const multiselect = useMultiselect<Mod>();
  const [viewMode, setViewMode] = createSignal<"installed" | "browse">("installed");
  const [searchQuery, setSearchQuery] = createSignal("");
  const [selectedMod, setSelectedMod] = createSignal<Mod | null>(null);
  const [filterEnabled, setFilterEnabled] = createSignal<"all" | "enabled" | "disabled">("all");
  const [filterSource, setFilterSource] = createSignal<"all" | "modrinth" | "curseforge" | "local">("all");
  const [filterAutoUpdate, setFilterAutoUpdate] = createSignal<"all" | "yes" | "no">("all");
  const [filterVerification, setFilterVerification] = createSignal<"all" | "verified" | "unverified" | "modified">("all");
  const [filterUpdateAvailable, setFilterUpdateAvailable] = createSignal<"all" | "has_update" | "no_update">("all");
  const [showFilters, setShowFilters] = createSignal(false);
  const [showDependencyGraph, setShowDependencyGraph] = createSignal(false);
  const [showUpdateModal, setShowUpdateModal] = createSignal(false);
  const [updating, setUpdating] = createSignal(false);
  const [showChangelogModal, setShowChangelogModal] = createSignal(false);
  const [updatedModsForChangelog, setUpdatedModsForChangelog] = createSignal<Mod[]>([]);
  const { confirm, ConfirmDialogComponent } = createConfirmDialog();

  // Verification results come from hook (auto-verified in background)
  const [showVerificationResults, setShowVerificationResults] = createSignal(false);

  let selectAllCheckboxRef: HTMLInputElement | undefined;
  let searchInputRef: HTMLInputElement | undefined;

  // Register search handler for Ctrl+F
  onMount(() => {
    registerSearchHandler("mods-list", () => {
      // Switch to installed view if in browse mode
      if (viewMode() !== "installed") {
        setViewMode("installed");
      }
      // Focus search input (queueMicrotask avoids setTimeout leak on unmount)
      queueMicrotask(() => searchInputRef?.focus());
    }, 5); // Lower priority than DependencyGraph
  });

  onCleanup(() => {
    unregisterSearchHandler("mods-list");
  });

  // Update indeterminate state for select-all checkbox
  createEffect(() => {
    if (selectAllCheckboxRef) {
      selectAllCheckboxRef.indeterminate = multiselect.someSelected(filteredMods()) && !multiselect.allSelected(filteredMods());
    }
  });

  // Register drag & drop handler for .jar files
  onMount(() => {
    const cleanup = registerDropHandler({
      accept: (files) => {
        // Accept only if in installed view and files contain .jar
        if (viewMode() !== "installed") return false;
        const jarFiles = filterByExtensions(files, ["jar"]);
        return jarFiles.length > 0;
      },
      onDrop: async (files) => {
        const jarFiles = filterByExtensions(files, ["jar"]);
        for (const file of jarFiles) {
          try {
            await mods.installLocalMod(file.path);
          } catch (error) {
            if (import.meta.env.DEV) console.error(`Failed to install ${file.name}:`, error);
          }
        }
      },
      priority: 10, // High priority for mod installation
    });

    // Auto-sync when window becomes visible (user returns to app)
    // This detects changes made to mods folder while app was in background
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible" && viewMode() === "installed") {
        // Sync mods folder to detect external changes
        mods.syncMods().then(() => mods.loadMods());
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    onCleanup(() => {
      cleanup();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    });
  });

  const handleRemoveMod = async (mod: Mod) => {
    const confirmed = await confirm({
      title: t().mods.list.confirm.deleteTitle,
      message: t().mods.list.confirm.deleteMessage.replace("{name}", mod.name),
      variant: "danger",
      confirmText: t().mods.list.confirm.delete,
    });
    if (confirmed) {
      await mods.removeMod(mod.id);
    }
  };

  // Мемоизированная фильтрация модов по поисковому запросу и фильтрам
  const filteredMods = createMemo(() => {
    let filtered = mods.mods();

    // Search filter
    const query = searchQuery().toLowerCase().trim();
    if (query) {
      filtered = filtered.filter(mod =>
        mod.name.toLowerCase().includes(query) ||
        mod.slug.toLowerCase().includes(query) ||
        mod.version.toLowerCase().includes(query) ||
        mod.source.toLowerCase().includes(query)
      );
    }

    // Enabled/Disabled filter
    if (filterEnabled() === "enabled") {
      filtered = filtered.filter(mod => mod.enabled);
    } else if (filterEnabled() === "disabled") {
      filtered = filtered.filter(mod => !mod.enabled);
    }

    // Source filter
    if (filterSource() !== "all") {
      filtered = filtered.filter(mod => mod.source.toLowerCase() === filterSource());
    }

    // Auto-update filter
    if (filterAutoUpdate() === "yes") {
      filtered = filtered.filter(mod => mod.auto_update);
    } else if (filterAutoUpdate() === "no") {
      filtered = filtered.filter(mod => !mod.auto_update);
    }

    // Verification filter (derive from mod.source - data is in DB)
    if (filterVerification() !== "all") {
      filtered = filtered.filter(mod => {
        const status = mods.getVerificationStatus(mod);
        if (filterVerification() === "verified") return status === "verified";
        if (filterVerification() === "unverified") return status === "unknown";
        if (filterVerification() === "modified") return status === "modified";
        return true;
      });
    }

    // Update available filter
    if (filterUpdateAvailable() === "has_update") {
      filtered = filtered.filter(mod => mod.update_available);
    } else if (filterUpdateAvailable() === "no_update") {
      filtered = filtered.filter(mod => !mod.update_available);
    }

    return filtered;
  });

  const hasActiveFilters = () => {
    return filterEnabled() !== "all" || filterSource() !== "all" || filterAutoUpdate() !== "all" || filterVerification() !== "all" || filterUpdateAvailable() !== "all";
  };

  const clearFilters = () => {
    setFilterEnabled("all");
    setFilterSource("all");
    setFilterAutoUpdate("all");
    setFilterVerification("all");
    setFilterUpdateAvailable("all");
  };

  // Memoized filter counts - calculated once per mods change
  const filterCounts = createMemo(() => {
    const allMods = mods.mods();
    return {
      total: allMods.length,
      enabled: allMods.filter(m => m.enabled).length,
      disabled: allMods.filter(m => !m.enabled).length,
      modrinth: allMods.filter(m => m.source === "modrinth").length,
      curseforge: allMods.filter(m => m.source === "curseforge").length,
      local: allMods.filter(m => m.source === "local").length,
      autoUpdateYes: allMods.filter(m => m.auto_update).length,
      autoUpdateNo: allMods.filter(m => !m.auto_update).length,
      hasUpdate: allMods.filter(m => m.update_available).length,
      noUpdate: allMods.filter(m => !m.update_available).length,
    };
  });

  // Mods with changelog from recent updates
  const modsWithChangelog = createMemo(() => {
    return mods.mods().filter(m => m.latest_changelog && m.latest_changelog.trim().length > 0);
  });

  const handleInstall = async (slug: string, source: string, modName?: string, versionId?: string) => {
    // Mark mod as installing in global store
    startModInstall(props.instanceId, slug, source, modName || slug);

    try {
      await mods.installMod(slug, source, props.minecraftVersion, props.loader, versionId);
      // После установки перезагружаем список модов для обновления состояния
      await mods.loadMods();
    } catch (error) {
      if (import.meta.env.DEV) console.error("Failed to install mod:", error);
    } finally {
      // Mark installation complete
      completeModInstall(props.instanceId, slug, source);
    }
  };

  // Get verification status for a mod (derive from mod.source - data is in DB)
  const getVerificationStatus = (mod: Mod) => mods.getVerificationStatus(mod);

  // Computed verification summary (reactive - updates when mods() changes)
  const verificationSummary = createMemo(() => {
    const allMods = mods.mods();
    if (allMods.length === 0) return null;

    const verified = mods.verifiedCount();
    const unverified = mods.unverifiedCount();
    return { verified, unverified, total: allMods.length };
  });

  const handleAddLocalMod = async () => {
    try {
      const selected = await open({
        multiple: true,
        filters: [
          { name: "Minecraft Mods", extensions: ["jar"] }
        ],
        title: t().mods.list.fileDialog.title,
      });

      if (!selected) return;

      // Handle both single and multiple file selection
      const files = Array.isArray(selected) ? selected : [selected];

      for (const filePath of files) {
        await mods.installLocalMod(filePath);
      }
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to add local mod:", e);
    }
  };

  // Bulk operations
  const handleBulkEnable = async () => {
    const selected = multiselect.getSelectedItems(filteredMods());
    if (selected.length === 0) return;

    try {
      const modIds = selected.map((m) => m.id);
      await invoke("bulk_toggle_mods", {
        instanceId: props.instanceId,
        modIds,
        enabled: true,
      });
      await mods.loadMods();
      multiselect.deselectAll();
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to enable mods:", e);
    }
  };

  const handleBulkDisable = async () => {
    const selected = multiselect.getSelectedItems(filteredMods());
    if (selected.length === 0) return;

    try {
      const modIds = selected.map((m) => m.id);
      await invoke("bulk_toggle_mods", {
        instanceId: props.instanceId,
        modIds,
        enabled: false,
      });
      await mods.loadMods();
      multiselect.deselectAll();
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to disable mods:", e);
    }
  };

  const handleBulkDelete = async () => {
    const selected = multiselect.getSelectedItems(filteredMods());
    if (selected.length === 0) return;

    const confirmed = await confirm({
      title: t().mods.list.confirm.deleteBulkTitle,
      message: t().mods.list.confirm.deleteBulkMessage.replace("{count}", String(selected.length)),
      variant: "danger",
      confirmText: t().mods.list.confirm.delete,
    });

    if (!confirmed) return;

    try {
      const modIds = selected.map((m) => m.id);
      await invoke("bulk_remove_mods", {
        instanceId: props.instanceId,
        modIds,
      });
      await mods.loadMods();
      multiselect.deselectAll();
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to delete mods:", e);
    }
  };

  return (
    <div class="flex flex-col gap-4">
      {/* Header with View Toggle */}
      <div class="flex flex-wrap items-center justify-between gap-2 lg:gap-3">
        <div class="flex items-center gap-2 lg:gap-3 flex-wrap min-w-0">
          <h2 class="text-lg lg:text-xl font-semibold truncate">
            {viewMode() === "installed"
              ? searchQuery()
                ? `${filteredMods().length}/${mods.mods().length}`
                : `${t().mods.list.header.modsCount} (${mods.mods().length})`
              : t().mods.list.header.catalog}
          </h2>

          {/* View Mode Toggle */}
          <Tabs
            tabs={[
              { id: "installed", label: t().mods.list.tabs.installed, icon: "i-hugeicons-checkmark-circle-02" },
              { id: "browse", label: t().mods.list.tabs.browse, icon: "i-hugeicons-store-01" },
            ]}
            activeTab={viewMode()}
            onTabChange={(id) => setViewMode(id as "installed" | "browse")}
            variant="pills"
          />
        </div>

        {/* Actions for Installed View */}
        <Show when={viewMode() === "installed"}>
          <div class="flex items-center gap-1.5 flex-wrap">
            {/* Filter Toggle Button */}
            <Tooltip text={t().mods.list.actions.filters} position="bottom">
              <button
                class={`btn-sm ${showFilters() ? "btn-primary" : "btn-secondary"} ${hasActiveFilters() ? "ring-1 ring-[var(--color-primary)]" : ""}`}
                onClick={() => setShowFilters(!showFilters())}
              >
                <i class="i-hugeicons-filter w-4 h-4" />
                <Show when={hasActiveFilters()}>
                  <span class="w-1.5 h-1.5 rounded-full bg-[var(--color-primary)]" />
                </Show>
              </button>
            </Tooltip>

            {/* Refresh Button - force re-sync and re-enrich */}
            <Tooltip text={t().mods.list.actions.forceRefresh} position="bottom">
              <button
                class="btn-sm btn-ghost"
                onClick={() => mods.forceSync()}
                disabled={mods.syncing() || mods.enriching() || mods.verifying()}
              >
                <Show when={mods.syncing() || mods.enriching() || mods.verifying()} fallback={<i class="i-hugeicons-refresh w-4 h-4" />}>
                  <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                </Show>
              </button>
            </Tooltip>

            {/* Add Local Mod Button */}
            <Tooltip text={t().mods.list.actions.addLocalMod} position="bottom">
              <button
                class="btn-sm btn-secondary"
                onClick={handleAddLocalMod}
                disabled={mods.loading()}
              >
                <i class="i-hugeicons-add-01 w-4 h-4" />
                <span>{t().mods.list.actions.localMod}</span>
              </button>
            </Tooltip>

            {/* Mod tools - show only when mods exist and tools visible */}
            <Show when={isVisible("toolsMenu") && mods.mods().length > 0}>
              {/* Check Updates Button - opens modal if updates exist, shows re-check button */}
              <div class="flex items-center">
                <Tooltip text={mods.getUpdatableCount() > 0 ? `${mods.getUpdatableCount()} ${t().mods.list.actions.updatesAvailable}` : t().mods.list.actions.checkUpdates} position="bottom">
                  <button
                    class={`btn-sm ${mods.getUpdatableCount() > 0 ? "btn-primary" : "btn-secondary"} ${mods.getUpdatableCount() > 0 ? "rounded-r-none" : ""}`}
                    onClick={async () => {
                      // If updates exist, open modal
                      if (mods.getUpdatableCount() > 0) {
                        setShowUpdateModal(true);
                        return;
                      }
                      // Otherwise check for updates first
                      await mods.checkModUpdates(props.minecraftVersion, props.loader, false);
                      // Open modal if updates found
                      if (mods.getUpdatableCount() > 0) {
                        setShowUpdateModal(true);
                      }
                    }}
                    disabled={mods.checkingUpdates() || updating()}
                  >
                    <Show when={mods.checkingUpdates()} fallback={
                      <>
                        <i class="i-hugeicons-download-02 w-4 h-4" />
                        <Show when={mods.getUpdatableCount() > 0}>
                          <span class="text-xs font-bold bg-white/20 px-1.5 rounded-full">{mods.getUpdatableCount()}</span>
                        </Show>
                        <span>{t().mods.list.actions.updates}</span>
                      </>
                    }>
                      <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                      <span>{t().mods.list.actions.checking}</span>
                    </Show>
                  </button>
                </Tooltip>
                {/* Re-check button - visible when updates exist */}
                <Show when={mods.getUpdatableCount() > 0}>
                  <Tooltip text={t().mods.list.actions.recheckUpdates} position="bottom">
                    <button
                      class="btn-sm btn-secondary rounded-l-none border-l border-gray-600"
                      onClick={async () => {
                        await mods.checkModUpdates(props.minecraftVersion, props.loader, true);
                      }}
                      disabled={mods.checkingUpdates() || updating()}
                    >
                      <Show when={mods.checkingUpdates()} fallback={
                        <i class="i-hugeicons-refresh w-4 h-4" />
                      }>
                        <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                      </Show>
                    </button>
                  </Tooltip>
                </Show>
              </div>

              {/* Dependency Graph Button */}
              <Tooltip text={t().mods.list.actions.graphTooltip} position="bottom">
                <button
                  class="btn-sm btn-secondary"
                  onClick={() => setShowDependencyGraph(true)}
                >
                  <i class="i-hugeicons-chart-relationship w-4 h-4" />
                  <span>{t().mods.list.actions.graph}</span>
                </button>
              </Tooltip>

              {/* Changelog Button - shows changelog of recently updated mods */}
              <Show when={modsWithChangelog().length > 0}>
                <Tooltip text={t().mods.list.actions.changelogTooltip ?? "View changes in recently updated mods"} position="bottom">
                  <button
                    class="btn-sm btn-secondary"
                    onClick={() => {
                      setUpdatedModsForChangelog(modsWithChangelog());
                      setShowChangelogModal(true);
                    }}
                  >
                    <i class="i-hugeicons-news w-4 h-4" />
                    <span class="text-xs font-bold bg-blue-500/30 px-1.5 rounded-full">{modsWithChangelog().length}</span>
                    <span>{t().mods.list.actions.changelog ?? "Changelog"}</span>
                  </button>
                </Tooltip>
              </Show>

              {/* Simple enriching/verifying indicator (spinner only) */}
              <Show when={mods.enriching() || mods.verifying()}>
                <Tooltip text={mods.verifying() ? t().mods.list.actions.verifyingMods : t().mods.list.actions.loadingDeps} position="bottom">
                  <div class="flex items-center gap-1 text-gray-400 text-xs">
                    <i class="i-svg-spinners-6-dots-scale w-3.5 h-3.5" />
                    <i class={mods.verifying() ? "i-hugeicons-security-check w-3.5 h-3.5" : ""} />
                  </div>
                </Tooltip>
              </Show>
            </Show>
          </div>
        </Show>
      </div>

      {/* Verification Progress Bar (separate row to avoid UI jumping) */}
      <Show when={mods.verifying() && mods.verificationProgress()}>
        {(progress) => (
          <div class="bg-gray-800/50 border border-gray-700 rounded-lg px-3 py-2 flex items-center gap-3">
            <i class="i-hugeicons-security-check w-4 h-4 text-blue-400" />
            <span class="text-sm text-gray-300 min-w-32">{progress().message}</span>
            <Show when={progress().total > 0}>
              <div class="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden max-w-xs">
                <div
                  class="h-full bg-[var(--color-primary)] transition-all duration-150"
                  style={{ width: `${Math.round((progress().current / progress().total) * 100)}%` }}
                />
              </div>
              <span class="text-xs text-gray-500">{progress().current}/{progress().total}</span>
            </Show>
          </div>
        )}
      </Show>

      {/* Search for Installed Mods */}
      <Show when={isVisible("searchBar") && viewMode() === "installed" && mods.mods().length > 0}>
        <div class="flex gap-3 items-center">
          {/* Select All Checkbox */}
          <div class="flex items-center gap-2">
            <Tooltip text={t().mods.list.search.selectAll} position="bottom">
              <input
                ref={selectAllCheckboxRef}
                type="checkbox"
                checked={multiselect.allSelected(filteredMods())}
                onChange={(e) => {
                  if (e.currentTarget.checked) {
                    multiselect.selectAll(filteredMods());
                  } else {
                    multiselect.deselectAll();
                  }
                }}
                class="w-4 h-4 rounded border-gray-600 bg-gray-800 focus:ring-2 focus:ring-[var(--color-primary-border)] cursor-pointer"
              />
            </Tooltip>
          </div>

          {/* Search Input */}
          <div class="flex-1">
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery()}
              onInput={(e) => setSearchQuery(e.currentTarget.value)}
              placeholder={t().mods.list.search.placeholder}
              class="w-full pl-10 pr-10"
            />
            <i class="i-hugeicons-search-01 absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-500" />
            <Show when={searchQuery()}>
              <button
                class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors duration-100"
                onClick={() => setSearchQuery("")}
              >
                <i class="i-hugeicons-cancel-01 w-4 h-4" />
              </button>
            </Show>
          </div>
        </div>
      </Show>

      {/* Bulk Operations Toolbar */}
      <Show when={viewMode() === "installed"}>
        <BulkOperationsToolbar
          selectedCount={multiselect.selectedCount()}
          onEnableAll={handleBulkEnable}
          onDisableAll={handleBulkDisable}
          onDeleteAll={handleBulkDelete}
          onDeselectAll={multiselect.deselectAll}
        />
      </Show>

      {/* Advanced Filters Panel */}
      <Show when={viewMode() === "installed" && showFilters()}>
        <ModFiltersPanel
          filterEnabled={filterEnabled()}
          filterSource={filterSource()}
          filterAutoUpdate={filterAutoUpdate()}
          filterVerification={filterVerification()}
          filterUpdateAvailable={filterUpdateAvailable()}
          verifiedCount={mods.verifiedCount()}
          unverifiedCount={mods.unverifiedCount()}
          filterCounts={filterCounts()}
          hasActiveFilters={hasActiveFilters()}
          onSetFilterEnabled={setFilterEnabled}
          onSetFilterSource={setFilterSource}
          onSetFilterAutoUpdate={setFilterAutoUpdate}
          onSetFilterVerification={setFilterVerification}
          onSetFilterUpdateAvailable={setFilterUpdateAvailable}
          onClearFilters={clearFilters}
          t={t}
        />
      </Show>

      {/* Conflicts Alert */}
      <Show when={mods.conflicts().length > 0}>
        <div class="card bg-yellow-600/10 border-yellow-600/30 flex items-start gap-3">
          <i class="i-hugeicons-alert-02 text-yellow-400 w-5 h-5 flex-shrink-0" />
          <div class="flex-1 flex flex-col gap-2">
            <h3 class="font-medium text-yellow-400">
              {t().mods.list.conflicts.title} ({mods.conflicts().length})
            </h3>
            <For each={mods.conflicts()}>
              {(conflict) => (
                <div class="text-sm text-yellow-300/90">
                  <strong>{conflict.mod_name}</strong>: {conflict.details}
                </div>
              )}
            </For>
            <button
              class="btn-secondary mt-1"
              data-size="sm"
              onClick={() => mods.autoResolveDependencies(props.minecraftVersion, props.loader)}
              disabled={mods.resolvingDeps()}
            >
              <Show when={mods.resolvingDeps()} fallback={
                <>
                  <i class="i-hugeicons-test-tube w-4 h-4" />
                  {t().mods.list.conflicts.autoResolve}
                </>
              }>
                <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                {t().mods.list.conflicts.resolving}
              </Show>
            </button>
          </div>
        </div>
      </Show>

      {/* Verification status is shown via badges on each mod - no need for banner */}

      
      {/* Browse Mode - Catalog */}
      <Show when={viewMode() === "browse"}>
        <ModsBrowser
          instanceId={props.instanceId}
          minecraftVersion={props.minecraftVersion}
          loader={props.loader}
          installedMods={mods.mods} // Передаём функцию-геттер для реактивности
          onInstall={handleInstall}
        />
      </Show>

      {/* Installed Mode - List */}
      <Show when={viewMode() === "installed"}>
        {/* Loading (includes syncing phase to prevent flash of "No mods installed") */}
        <Show when={mods.loading() || mods.syncing()}>
          <div class="flex-center gap-2 py-8">
            <i class="i-svg-spinners-6-dots-scale w-6 h-6" />
            <span class="text-muted">{t().mods.list.loading}</span>
          </div>
        </Show>

        {/* Error */}
        <Show when={mods.error()}>
          <div class="card bg-red-600/10 border-red-600/30 flex items-start gap-3">
            <i class="i-hugeicons-alert-02 text-red-400 w-5 h-5 flex-shrink-0" />
            <p class="text-red-400 text-sm flex-1">{mods.error()}</p>
          </div>
        </Show>

        {/* Empty State - No mods installed */}
        <Show when={!mods.loading() && !mods.syncing() && mods.mods().length === 0 && !mods.error()}>
          <div class="card flex-col-center py-12 text-center">
            <i class="i-hugeicons-package w-16 h-16 text-gray-600 mb-4" />
            <p class="text-muted mb-2">{t().mods.list.empty.noMods}</p>
            <p class="text-sm text-dimmer mb-4">{t().mods.list.empty.noModsHint}</p>
            <button
              class="btn-primary"
              data-size="sm"
              onClick={() => setViewMode("browse")}
            >
              <i class="i-hugeicons-store-01 w-4 h-4" />
              {t().mods.list.empty.openCatalog}
            </button>
          </div>
        </Show>

        {/* Empty State - No search results */}
        <Show when={!mods.loading() && mods.mods().length > 0 && filteredMods().length === 0 && searchQuery()}>
          <div class="card flex-col-center py-8 text-center">
            <i class="i-hugeicons-search-01 w-12 h-12 text-gray-600 mb-3" />
            <p class="text-muted mb-1">{t().mods.list.empty.noResults}</p>
            <p class="text-sm text-dimmer">{t().mods.list.empty.noResultsHint} "{searchQuery()}"</p>
          </div>
        </Show>

        {/* Mods List */}
        <div class="space-y-2">
          <For each={filteredMods()}>
            {(mod) => (
              <ModCard
                mod={mod}
                instanceId={props.instanceId}
                isSelected={multiselect.isSelected(mod.id)}
                loading={mods.loading()}
                onToggleSelect={() => multiselect.toggleSelect(mod.id)}
                onToggleMod={(id, enabled) => mods.toggleMod(id, enabled)}
                onUpdateMod={(id) => mods.updateMod(id)}
                onToggleAutoUpdate={(id, autoUpdate) => mods.toggleModAutoUpdate(id, autoUpdate)}
                onShowInfo={setSelectedMod}
                onRemove={handleRemoveMod}
                getVerificationStatus={getVerificationStatus}
                t={t}
              />
            )}
          </For>
        </div>
      </Show>

      {/* Mod Info Dialog */}
      <Show when={selectedMod()}>
        <ModInfoDialog
          mod={selectedMod()!}
          instanceId={props.instanceId}
          onClose={() => setSelectedMod(null)}
        />
      </Show>

      {/* Confirm Dialog */}
      <ConfirmDialogComponent />

      {/* Dependency Graph Modal */}
      <Show when={showDependencyGraph()}>
        <ModalWrapper
          backdrop
          fullHeight
          maxWidth="max-w-[1400px]"
          class="h-[85vh]"
          onBackdropClick={() => setShowDependencyGraph(false)}
        >
          <DependencyGraph
            instanceId={props.instanceId}
            onClose={() => setShowDependencyGraph(false)}
          />
        </ModalWrapper>
      </Show>

      {/* Update Mods Modal */}
      <Show when={showUpdateModal() && mods.getModsWithUpdates().length > 0}>
        <UpdateModsModal
          modsWithUpdates={mods.getModsWithUpdates()}
          updating={updating()}
          onClose={() => setShowUpdateModal(false)}
          onUpdate={async (modIds: number[]) => {
            setUpdating(true);
            try {
              for (const modId of modIds) {
                await mods.updateMod(modId);
              }

              // Reload mods to get updated data with latest_changelog
              await mods.loadMods();

              // Get updated mods for changelog display
              // Use modsBeforeUpdate to preserve changelogs that were fetched
              const updatedMods = mods.mods().filter(m => modIds.includes(m.id));

              // Show changelog aggregator if any mods have changelogs
              if (updatedMods.some(m => m.latest_changelog)) {
                setUpdatedModsForChangelog(updatedMods);
                setShowUpdateModal(false);
                setShowChangelogModal(true);
              }
            } finally {
              setUpdating(false);
            }
          }}
        />
      </Show>

      {/* Changelog Aggregator Modal - shown after mods are updated */}
      <Show when={showChangelogModal() && updatedModsForChangelog().length > 0}>
        <ChangelogAggregatorModal
          updatedMods={updatedModsForChangelog()}
          onClose={() => {
            setShowChangelogModal(false);
            setUpdatedModsForChangelog([]);
          }}
        />
      </Show>

      {/* Verification Results Modal */}
      <Show when={showVerificationResults() && verificationSummary()}>
        <VerificationResultsModal
          summary={verificationSummary()!}
          unverifiedMods={mods.mods().filter(m => getVerificationStatus(m) === "unknown")}
          onClose={() => setShowVerificationResults(false)}
          t={t}
        />
      </Show>
    </div>
  );
};

export default ModsList;