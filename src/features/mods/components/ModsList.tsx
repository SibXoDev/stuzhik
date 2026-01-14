import { For, Show, createSignal, createMemo, createEffect, onMount, onCleanup } from "solid-js";
import type { Component } from "solid-js";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { useMods } from "../hooks/useMods";
import ModsBrowser from "./ModsBrowser";
import ModInfoDialog from "./ModInfoDialog";
import DependencyGraph from "./DependencyGraph";
import UpdateModsModal from "./UpdateModsModal";
import { createConfirmDialog } from "../../../shared/components/ConfirmDialog";
import { startModInstall, completeModInstall, registerDropHandler, filterByExtensions, registerSearchHandler, unregisterSearchHandler } from "../../../shared/stores";
import type { Mod } from "../../../shared/types";
import { sanitizeImageUrl } from "../../../shared/utils/url-validator";
import { Toggle, Tabs, BulkOperationsToolbar, ModalWrapper, Select } from "../../../shared/ui";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useMultiselect } from "../../../shared/hooks";
import { useI18n } from "../../../shared/i18n";

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
      // Focus search input
      setTimeout(() => searchInputRef?.focus(), 0);
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
            console.error(`Failed to install ${file.name}:`, error);
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
      title: "Удалить мод?",
      message: `Удалить мод "${mod.name}"? Файл будет удалён из папки модов.`,
      variant: "danger",
      confirmText: "Удалить",
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

  const handleInstall = async (slug: string, source: string, modName?: string, versionId?: string) => {
    // Mark mod as installing in global store
    startModInstall(props.instanceId, slug, source, modName || slug);

    try {
      await mods.installMod(slug, source, props.minecraftVersion, props.loader, versionId);
      // После установки перезагружаем список модов для обновления состояния
      await mods.loadMods();
    } catch (error) {
      console.error("Failed to install mod:", error);
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
        title: "Выберите мод-файлы (.jar)",
      });

      if (!selected) return;

      // Handle both single and multiple file selection
      const files = Array.isArray(selected) ? selected : [selected];

      for (const filePath of files) {
        await mods.installLocalMod(filePath);
      }
    } catch (e) {
      console.error("Failed to add local mod:", e);
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
      console.error("Failed to enable mods:", e);
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
      console.error("Failed to disable mods:", e);
    }
  };

  const handleBulkDelete = async () => {
    const selected = multiselect.getSelectedItems(filteredMods());
    if (selected.length === 0) return;

    const confirmed = await confirm({
      title: "Удалить выбранные моды?",
      message: `Будет удалено модов: ${selected.length}. Файлы будут удалены из папки модов.`,
      variant: "danger",
      confirmText: "Удалить",
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
      console.error("Failed to delete mods:", e);
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
                : `Моды (${mods.mods().length})`
              : "Каталог"}
          </h2>

          {/* View Mode Toggle */}
          <Tabs
            tabs={[
              { id: "installed", label: "Установленные", icon: "i-hugeicons-checkmark-circle-02" },
              { id: "browse", label: "Каталог", icon: "i-hugeicons-store-01" },
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
            <button
              class={`btn-sm ${showFilters() ? "btn-primary" : "btn-secondary"} ${hasActiveFilters() ? "ring-1 ring-blue-500" : ""}`}
              onClick={() => setShowFilters(!showFilters())}
              title="Фильтры"
            >
              <i class="i-hugeicons-filter w-4 h-4" />
              <Show when={hasActiveFilters()}>
                <span class="w-1.5 h-1.5 rounded-full bg-blue-500" />
              </Show>
            </button>

            {/* Refresh Button - force re-sync and re-enrich */}
            <button
              class="btn-sm btn-ghost"
              onClick={() => mods.forceSync()}
              disabled={mods.syncing() || mods.enriching() || mods.verifying()}
              title="Принудительное обновление данных"
            >
              <Show when={mods.syncing() || mods.enriching() || mods.verifying()} fallback={<i class="i-hugeicons-refresh w-4 h-4" />}>
                <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
              </Show>
            </button>

            {/* Add Local Mod Button */}
            <button
              class="btn-sm btn-secondary"
              onClick={handleAddLocalMod}
              disabled={mods.loading()}
              title="Добавить локальный мод (.jar файл)"
            >
              <i class="i-hugeicons-add-01 w-4 h-4" />
              <span>Локальный мод</span>
            </button>

            {/* Mod tools - show only when mods exist */}
            <Show when={mods.mods().length > 0}>
              {/* Check Updates Button - opens modal if updates exist, shows re-check button */}
              <div class="flex items-center">
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
                  title={mods.getUpdatableCount() > 0 ? `${mods.getUpdatableCount()} обновлений доступно - нажмите для просмотра` : "Проверить обновления"}
                >
                  <Show when={mods.checkingUpdates()} fallback={
                    <>
                      <i class="i-hugeicons-download-02 w-4 h-4" />
                      <Show when={mods.getUpdatableCount() > 0}>
                        <span class="text-xs font-bold bg-white/20 px-1.5 rounded-full">{mods.getUpdatableCount()}</span>
                      </Show>
                      <span>Обновления</span>
                    </>
                  }>
                    <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                    <span>Проверка...</span>
                  </Show>
                </button>
                {/* Re-check button - visible when updates exist */}
                <Show when={mods.getUpdatableCount() > 0}>
                  <button
                    class="btn-sm btn-secondary rounded-l-none border-l border-gray-600"
                    onClick={async () => {
                      await mods.checkModUpdates(props.minecraftVersion, props.loader, true);
                    }}
                    disabled={mods.checkingUpdates() || updating()}
                    title="Повторно проверить обновления"
                  >
                    <Show when={mods.checkingUpdates()} fallback={
                      <i class="i-hugeicons-refresh w-4 h-4" />
                    }>
                      <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                    </Show>
                  </button>
                </Show>
              </div>

              {/* Dependency Graph Button */}
              <button
                class="btn-sm btn-secondary"
                onClick={() => setShowDependencyGraph(true)}
                title="Визуальный граф зависимостей между модами"
              >
                <i class="i-hugeicons-chart-relationship w-4 h-4" />
                <span>Граф</span>
              </button>

              {/* Simple enriching/verifying indicator (spinner only) */}
              <Show when={mods.enriching() || mods.verifying()}>
                <div class="flex items-center gap-1 text-gray-400 text-xs" title={mods.verifying() ? "Проверка подлинности модов..." : "Загрузка информации о зависимостях..."}>
                  <i class="i-svg-spinners-6-dots-scale w-3.5 h-3.5" />
                  <i class={mods.verifying() ? "i-hugeicons-security-check w-3.5 h-3.5" : ""} />
                </div>
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
                  class="h-full bg-blue-500 transition-all duration-150"
                  style={{ width: `${Math.round((progress().current / progress().total) * 100)}%` }}
                />
              </div>
              <span class="text-xs text-gray-500">{progress().current}/{progress().total}</span>
            </Show>
          </div>
        )}
      </Show>

      {/* Search for Installed Mods */}
      <Show when={viewMode() === "installed" && mods.mods().length > 0}>
        <div class="flex gap-3 items-center">
          {/* Select All Checkbox */}
          <div class="flex items-center gap-2">
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
              class="w-4 h-4 rounded border-gray-600 bg-gray-800 checked:bg-blue-600 checked:border-blue-600 focus:ring-2 focus:ring-blue-600/50 cursor-pointer"
              title="Выбрать все"
            />
          </div>

          {/* Search Input */}
          <div class="flex-1">
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery()}
              onInput={(e) => setSearchQuery(e.currentTarget.value)}
              placeholder="Поиск по названию, mod ID, версии или источнику..."
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
        <div class="card bg-gray-800/50">
          <div class="flex items-center justify-between mb-3">
            <h4 class="text-sm font-semibold flex items-center gap-2">
              <i class="i-hugeicons-filter w-4 h-4" />
              Фильтры
            </h4>
            <Show when={hasActiveFilters()}>
              <button
                class="text-sm text-blue-400 hover:text-blue-300"
                onClick={clearFilters}
              >
                Сбросить все
              </button>
            </Show>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            {/* Enabled/Disabled Filter */}
            <div>
              <label class="block text-xs font-medium mb-1 text-gray-400">Состояние</label>
              <Select
                value={filterEnabled()}
                onChange={(v) => setFilterEnabled(v as any)}
                options={[
                  { value: "all", label: `Все (${filterCounts().total})`, icon: "i-hugeicons-apps-01" },
                  { value: "enabled", label: `Включено (${filterCounts().enabled})`, icon: "i-hugeicons-checkmark-circle-02" },
                  { value: "disabled", label: `Выключено (${filterCounts().disabled})`, icon: "i-hugeicons-cancel-circle" },
                ]}
              />
            </div>

            {/* Source Filter */}
            <div>
              <label class="block text-xs font-medium mb-1 text-gray-400">Источник</label>
              <Select
                value={filterSource()}
                onChange={(v) => setFilterSource(v as any)}
                options={[
                  { value: "all", label: "Все источники", icon: "i-hugeicons-globe-02" },
                  { value: "modrinth", label: `Modrinth (${filterCounts().modrinth})`, icon: "i-simple-icons-modrinth" },
                  { value: "curseforge", label: `CurseForge (${filterCounts().curseforge})`, icon: "i-simple-icons-curseforge" },
                  { value: "local", label: `Локальные (${filterCounts().local})`, icon: "i-hugeicons-folder-01" },
                ]}
              />
            </div>

            {/* Verification Filter */}
            <div>
              <label class="block text-xs font-medium mb-1 text-gray-400">Безопасность</label>
              <Select
                value={filterVerification()}
                onChange={(v) => setFilterVerification(v as any)}
                options={[
                  { value: "all", label: "Любой статус", icon: "i-hugeicons-shield-01" },
                  { value: "verified", label: `Проверенные (${mods.verifiedCount()})`, icon: "i-hugeicons-security-check" },
                  { value: "unverified", label: `Непроверенные (${mods.unverifiedCount()})`, icon: "i-hugeicons-help-circle" },
                  { value: "modified", label: "Модифицированные (0)", icon: "i-hugeicons-alert-02" },
                ]}
              />
            </div>

            {/* Auto-update Filter */}
            <div>
              <label class="block text-xs font-medium mb-1 text-gray-400">Автообновление</label>
              <Select
                value={filterAutoUpdate()}
                onChange={(v) => setFilterAutoUpdate(v as any)}
                options={[
                  { value: "all", label: "Любое", icon: "i-hugeicons-refresh" },
                  { value: "yes", label: `Включено (${filterCounts().autoUpdateYes})`, icon: "i-hugeicons-checkmark-circle-02" },
                  { value: "no", label: `Выключено (${filterCounts().autoUpdateNo})`, icon: "i-hugeicons-cancel-circle" },
                ]}
              />
            </div>

            {/* Update Available Filter */}
            <div>
              <label class="block text-xs font-medium mb-1 text-gray-400">Обновления</label>
              <Select
                value={filterUpdateAvailable()}
                onChange={(v) => setFilterUpdateAvailable(v as any)}
                options={[
                  { value: "all", label: "Любые", icon: "i-hugeicons-arrow-up-02" },
                  { value: "has_update", label: `Есть (${filterCounts().hasUpdate})`, icon: "i-hugeicons-arrow-up-double" },
                  { value: "no_update", label: `Нет обновлений (${filterCounts().noUpdate})`, icon: "i-hugeicons-checkmark-circle-02" },
                ]}
              />
            </div>
          </div>

          {/* Active Filters Summary */}
          <Show when={hasActiveFilters()}>
            <div class="mt-3 pt-3 border-t border-gray-700 flex items-center gap-2 flex-wrap text-xs">
              <span class="text-gray-500">Активные фильтры:</span>
              <Show when={filterEnabled() !== "all"}>
                <span class="px-2 py-1 rounded bg-blue-600/20 text-blue-400 border border-blue-600/30">
                  {filterEnabled() === "enabled" ? "Включено" : "Выключено"}
                </span>
              </Show>
              <Show when={filterSource() !== "all"}>
                <span class="px-2 py-1 rounded bg-purple-600/20 text-purple-400 border border-purple-600/30 capitalize">
                  {filterSource()}
                </span>
              </Show>
              <Show when={filterAutoUpdate() !== "all"}>
                <span class="px-2 py-1 rounded bg-orange-600/20 text-orange-400 border border-orange-600/30">
                  Авто-обновление: {filterAutoUpdate() === "yes" ? "Да" : "Нет"}
                </span>
              </Show>
              <Show when={filterVerification() !== "all"}>
                <span class={`px-2 py-1 rounded border ${
                  filterVerification() === "verified"
                    ? "bg-green-600/20 text-green-400 border-green-600/30"
                    : filterVerification() === "modified"
                    ? "bg-yellow-600/20 text-yellow-400 border-yellow-600/30"
                    : "bg-gray-600/20 text-gray-400 border-gray-600/30"
                }`}>
                  {filterVerification() === "verified" ? "Проверенные" : filterVerification() === "modified" ? "Модифицированные" : "Непроверенные"}
                </span>
              </Show>
              <Show when={filterUpdateAvailable() !== "all"}>
                <span class={`px-2 py-1 rounded border ${
                  filterUpdateAvailable() === "has_update"
                    ? "bg-cyan-600/20 text-cyan-400 border-cyan-600/30"
                    : "bg-gray-600/20 text-gray-400 border-gray-600/30"
                }`}>
                  {filterUpdateAvailable() === "has_update" ? "Есть обновления" : "Нет обновлений"}
                </span>
              </Show>
            </div>
          </Show>
        </div>
      </Show>

      {/* Conflicts Alert */}
      <Show when={mods.conflicts().length > 0}>
        <div class="card bg-yellow-600/10 border-yellow-600/30 flex items-start gap-3">
          <i class="i-hugeicons-alert-02 text-yellow-400 w-5 h-5 flex-shrink-0" />
          <div class="flex-1 flex flex-col gap-2">
            <h3 class="font-medium text-yellow-400">
              Обнаружены конфликты ({mods.conflicts().length})
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
                  Автоматически разрешить
                </>
              }>
                <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                Разрешение...
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
        {/* Loading */}
        <Show when={mods.loading()}>
          <div class="flex-center gap-2 py-8">
            <i class="i-svg-spinners-6-dots-scale w-6 h-6" />
            <span class="text-muted">Загрузка...</span>
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
        <Show when={!mods.loading() && mods.mods().length === 0 && !mods.error()}>
          <div class="card flex-col-center py-12 text-center">
            <i class="i-hugeicons-package w-16 h-16 text-gray-600 mb-4" />
            <p class="text-muted mb-2">Моды не установлены</p>
            <p class="text-sm text-dimmer mb-4">Перейдите в каталог чтобы найти моды</p>
            <button
              class="btn-primary"
              data-size="sm"
              onClick={() => setViewMode("browse")}
            >
              <i class="i-hugeicons-store-01 w-4 h-4" />
              Открыть каталог
            </button>
          </div>
        </Show>

        {/* Empty State - No search results */}
        <Show when={!mods.loading() && mods.mods().length > 0 && filteredMods().length === 0 && searchQuery()}>
          <div class="card flex-col-center py-8 text-center">
            <i class="i-hugeicons-search-01 w-12 h-12 text-gray-600 mb-3" />
            <p class="text-muted mb-1">Ничего не найдено</p>
            <p class="text-sm text-dimmer">Нет модов, соответствующих "{searchQuery()}"</p>
          </div>
        </Show>

        {/* Mods List */}
        <div class="space-y-2">
          <For each={filteredMods()}>
            {(mod) => (
              <div class="card flex items-center gap-4">
                {/* Multiselect Checkbox */}
                <input
                  type="checkbox"
                  checked={multiselect.isSelected(mod.id)}
                  onChange={() => multiselect.toggleSelect(mod.id)}
                  class="w-4 h-4 rounded border-gray-600 bg-gray-800 checked:bg-blue-600 checked:border-blue-600 focus:ring-2 focus:ring-blue-600/50 cursor-pointer"
                  title="Выбрать мод"
                />

                {/* Enable Toggle */}
                <Toggle
                  checked={mod.enabled}
                  onChange={(checked) => mods.toggleMod(mod.id, checked)}
                />

                {/* Icon */}
                <Show when={sanitizeImageUrl(mod.icon_url)}>
                  <img
                    src={sanitizeImageUrl(mod.icon_url)!}
                    alt={mod.name}
                    class="w-12 h-12 rounded-2xl object-cover"
                    onError={(e) => {
                      e.currentTarget.style.display = "none";
                    }}
                  />
                </Show>

                {/* Info */}
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2">
                    <h3 class="font-semibold truncate">
                      {mod.name}
                    </h3>
                    {/* Update Available Badge */}
                    <Show when={mod.update_available}>
                      <span
                        class="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs font-medium rounded bg-blue-600/20 text-blue-400 border border-blue-600/30"
                        title={`Доступно обновление: ${mod.latest_version}`}
                      >
                        <i class="i-hugeicons-arrow-up-02 w-3 h-3" />
                        <span class="hidden sm:inline">{mod.latest_version}</span>
                      </span>
                    </Show>
                  </div>
                  <div class="flex items-center gap-2 text-xs text-muted">
                    <span class="font-mono text-gray-500">{mod.slug}</span>
                    <span>•</span>
                    <span>{mod.version}</span>
                    <span>•</span>
                    {/* Unified Source + Verification Badge */}
                    {(() => {
                      const status = getVerificationStatus(mod);
                      const platform = mod.source;
                      const projectId = mod.source_id;

                      // Generate URL for platform
                      const getModUrl = () => {
                        if (platform === "modrinth" && projectId) {
                          return `https://modrinth.com/mod/${projectId}`;
                        }
                        if (platform === "curseforge" && projectId) {
                          return `https://www.curseforge.com/minecraft/mc-mods/${projectId}`;
                        }
                        return null;
                      };

                      const modUrl = getModUrl();
                      const isClickable = !!modUrl;

                      // Determine status and styling
                      let statusIcon: string;
                      let statusColor: string;
                      let tooltip: string;
                      let platformIcon: string;

                      if (platform === "modrinth") {
                        platformIcon = "i-simple-icons-modrinth";
                      } else if (platform === "curseforge") {
                        platformIcon = "i-simple-icons-curseforge";
                      } else {
                        platformIcon = "i-hugeicons-folder-01";
                      }

                      if (status === "verified") {
                        statusIcon = "i-hugeicons-security-check";
                        statusColor = "text-green-400 hover:text-green-300";
                        tooltip = "Проверен: хэш совпадает с официальным источником. Нажмите для открытия страницы мода.";
                      } else if (status === "modified") {
                        statusIcon = "i-hugeicons-alert-02";
                        statusColor = "text-orange-400 hover:text-orange-300";
                        tooltip = "Модифицирован: файл изменён после загрузки. Нажмите для открытия страницы мода.";
                      } else {
                        statusIcon = "i-hugeicons-help-circle";
                        statusColor = "text-gray-500 hover:text-gray-400";
                        tooltip = "Не найден на платформах: локальный мод или из другого источника.";
                      }

                      const handleClick = async (e: MouseEvent) => {
                        e.stopPropagation();
                        if (modUrl) {
                          try {
                            await openUrl(modUrl);
                          } catch (err) {
                            console.error("Failed to open URL:", err);
                          }
                        }
                      };

                      return (
                        <button
                          class={`inline-flex items-center gap-1 transition-colors duration-100 ${statusColor} ${isClickable ? "cursor-pointer" : "cursor-default"}`}
                          title={tooltip}
                          onClick={handleClick}
                          disabled={!isClickable}
                        >
                          <i class={`${platformIcon} w-3 h-3`} />
                          <i class={`${statusIcon} w-3 h-3`} />
                          <span class="capitalize">{platform}</span>
                          <Show when={isClickable}>
                            <i class="i-hugeicons-arrow-up-right-01 w-3 h-3 opacity-50" />
                          </Show>
                        </button>
                      );
                    })()}
                  </div>
                </div>

                {/* Actions */}
                <div class="flex items-center gap-2">
                  {/* Update Button - only if update is available */}
                  <Show when={mod.update_available}>
                    <button
                      class="btn-primary btn-sm"
                      onClick={() => mods.updateMod(mod.id)}
                      disabled={mods.loading()}
                      title={`Обновить до ${mod.latest_version}`}
                    >
                      <i class="i-hugeicons-arrow-up-02 w-4 h-4" />
                    </button>
                  </Show>

                  {/* Auto-update Toggle */}
                  <Show when={mod.source !== "local"}>
                    <button
                      class={`btn-ghost btn-sm ${mod.auto_update ? "text-blue-400" : "text-gray-500"}`}
                      onClick={() => mods.toggleModAutoUpdate(mod.id, !mod.auto_update)}
                      title={mod.auto_update ? "Автообновление включено" : "Автообновление отключено"}
                    >
                      <i class="i-hugeicons-refresh w-4 h-4" />
                    </button>
                  </Show>

                  {/* Mod Information */}
                  <button
                    class="btn-ghost btn-sm"
                    onClick={() => setSelectedMod(mod)}
                    title="Информация о моде"
                  >
                    <i class="i-hugeicons-information-circle w-4 h-4" />
                  </button>

                  {/* Open in folder */}
                  <button
                    class="btn-ghost btn-sm"
                    onClick={async () => {
                      try {
                        const instance = await invoke<{ dir: string }>("get_instance", { id: props.instanceId });
                        const modPath = `${instance.dir}/mods/${mod.file_name}`;
                        await revealItemInDir(modPath);
                      } catch (e) {
                        console.error("Failed to open mod in folder:", e);
                      }
                    }}
                    title="Показать в папке"
                  >
                    <i class="i-hugeicons-folder-search w-4 h-4" />
                  </button>

                  {/* Delete */}
                  <button
                    class="btn-ghost btn-sm text-red-400 hover:text-red-300"
                    onClick={() => handleRemoveMod(mod)}
                    title="Удалить мод"
                  >
                    <i class="i-hugeicons-delete-02 w-4 h-4" />
                  </button>
                </div>
              </div>
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
            } finally {
              setUpdating(false);
            }
          }}
        />
      </Show>

      {/* Verification Results Modal */}
      <Show when={showVerificationResults() && verificationSummary()}>
        <ModalWrapper
          backdrop
          maxWidth="max-w-lg"
          onBackdropClick={() => setShowVerificationResults(false)}
        >
          <div class="bg-gray-850 rounded-xl overflow-hidden">
            <div class="flex items-center gap-3 px-5 py-4 border-b border-gray-700">
              <i class={`w-6 h-6 ${
                verificationSummary()!.unverified === 0
                  ? "i-hugeicons-security-check text-green-400"
                  : "i-hugeicons-alert-02 text-yellow-400"
              }`} />
              <h3 class="text-lg font-medium text-white">
                {t().mods?.verification?.results?.title || "Verification Results"}
              </h3>
            </div>

            <div class="p-5">
              <p class="text-sm text-gray-300 mb-4">
                {verificationSummary()!.unverified === 0
                  ? (t().mods?.verification?.results?.allVerified || "All mods are verified and authentic")
                  : (t().mods?.verification?.results?.someUnverified || "Some mods were not found in official sources")}
              </p>

              <div class="flex gap-4 mb-4">
                <div class="flex-1 p-4 bg-green-500/10 rounded-lg border border-green-500/20">
                  <div class="flex items-center gap-2 mb-1">
                    <i class="i-hugeicons-security-check w-5 h-5 text-green-400" />
                    <span class="text-sm font-medium text-green-400">
                      {t().mods?.verification?.results?.verifiedCount || "Verified"}
                    </span>
                  </div>
                  <div class="text-2xl font-bold text-white">
                    {verificationSummary()!.verified}
                  </div>
                </div>

                <div class="flex-1 p-4 bg-yellow-500/10 rounded-lg border border-yellow-500/20">
                  <div class="flex items-center gap-2 mb-1">
                    <i class="i-hugeicons-alert-02 w-5 h-5 text-yellow-400" />
                    <span class="text-sm font-medium text-yellow-400">
                      {t().mods?.verification?.results?.unverifiedCount || "Not found"}
                    </span>
                  </div>
                  <div class="text-2xl font-bold text-white">
                    {verificationSummary()!.unverified}
                  </div>
                </div>
              </div>

              {/* List of unverified mods */}
              <Show when={verificationSummary()!.unverified > 0}>
                <div class="max-h-64 overflow-y-auto space-y-1.5">
                  <For each={mods.mods().filter(m => getVerificationStatus(m) === "unknown")}>
                    {(mod) => (
                      <div class="px-3 py-2.5 bg-gray-800 rounded-lg flex items-center gap-2">
                        <i class="i-hugeicons-file-01 w-4 h-4 text-gray-500 flex-shrink-0" />
                        <span class="text-sm text-gray-300 truncate">{mod.file_name}</span>
                        <span class="text-xs text-gray-500 ml-auto flex-shrink-0">
                          {t().mods?.verification?.status?.unknown || "Источник неизвестен"}
                        </span>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </div>

            <div class="flex justify-end px-5 py-4 border-t border-gray-700 bg-gray-800/50">
              <button
                onClick={() => setShowVerificationResults(false)}
                class="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg transition-colors"
              >
                {t().mods?.verification?.results?.close || "Close"}
              </button>
            </div>
          </div>
        </ModalWrapper>
      </Show>
    </div>
  );
};

export default ModsList;