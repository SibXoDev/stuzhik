import { For, Show, createSignal, createMemo, createEffect, onMount, onCleanup } from "solid-js";
import type { Component } from "solid-js";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useMods } from "../hooks/useMods";
import ModsBrowser from "./ModsBrowser";
import ModInfoDialog from "./ModInfoDialog";
import { createConfirmDialog } from "../../../shared/components/ConfirmDialog";
import { startModInstall, completeModInstall, registerDropHandler, filterByExtensions } from "../../../shared/stores";
import type { Mod } from "../../../shared/types";
import { sanitizeImageUrl } from "../../../shared/utils/url-validator";
import { Toggle, Tabs, BulkOperationsToolbar } from "../../../shared/ui";
import { useSafeTimers, useMultiselect } from "../../../shared/hooks";

interface Props {
  instanceId: string;
  minecraftVersion: string;
  loader: string;
}

interface SyncResult {
  added: number;
  removed: number;
}

const ModsList: Component<Props> = (props) => {
  const mods = useMods(() => props.instanceId);
  const { setTimeout: safeTimeout } = useSafeTimers();
  const multiselect = useMultiselect<Mod>();
  const [viewMode, setViewMode] = createSignal<"installed" | "browse">("installed");
  const [searchQuery, setSearchQuery] = createSignal("");
  const [selectedMod, setSelectedMod] = createSignal<Mod | null>(null);
  const [syncing, setSyncing] = createSignal(false);
  const [syncResult, setSyncResult] = createSignal<SyncResult | null>(null);
  const [filterEnabled, setFilterEnabled] = createSignal<"all" | "enabled" | "disabled">("all");
  const [filterSource, setFilterSource] = createSignal<"all" | "modrinth" | "curseforge" | "local">("all");
  const [filterAutoUpdate, setFilterAutoUpdate] = createSignal<"all" | "yes" | "no">("all");
  const [showFilters, setShowFilters] = createSignal(false);
  const { confirm, ConfirmDialogComponent } = createConfirmDialog();

  let selectAllCheckboxRef: HTMLInputElement | undefined;

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

    onCleanup(cleanup);
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

    return filtered;
  });

  const hasActiveFilters = () => {
    return filterEnabled() !== "all" || filterSource() !== "all" || filterAutoUpdate() !== "all";
  };

  const clearFilters = () => {
    setFilterEnabled("all");
    setFilterSource("all");
    setFilterAutoUpdate("all");
  };

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

  const handleCheckDependencies = async () => {
    await mods.checkDependencies();
    if (mods.conflicts().length > 0) {
      console.log("Found conflicts:", mods.conflicts());
    }
  };

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

  const handleSyncMods = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const result = await invoke<SyncResult>("sync_mods_folder", {
        instanceId: props.instanceId,
      });
      setSyncResult(result);
      // Reload mods list to show changes
      await mods.loadMods();
      // Auto-hide result after 5 seconds
      safeTimeout(() => setSyncResult(null), 5000);
    } catch (e) {
      console.error("Failed to sync mods folder:", e);
    } finally {
      setSyncing(false);
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
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <h2 class="text-xl font-semibold">
            {viewMode() === "installed"
              ? searchQuery()
                ? `Найдено: ${filteredMods().length} из ${mods.mods().length}`
                : `Установленные моды (${mods.mods().length})`
              : "Каталог модов"}
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
          <div class="flex items-center gap-2">
            {/* Filter Toggle Button */}
            <button
              class={`btn-sm ${showFilters() ? "btn-primary" : "btn-secondary"} ${hasActiveFilters() ? "border-blue-600" : ""}`}
              onClick={() => setShowFilters(!showFilters())}
              title="Фильтры"
            >
              <i class="i-hugeicons-filter w-4 h-4" />
              {hasActiveFilters() && <span class="ml-1">●</span>}
            </button>

            {/* Sync Mods Button */}
            <button
              class="btn-secondary"
              data-size="sm"
              onClick={handleSyncMods}
              disabled={syncing() || mods.loading()}
              title="Синхронизировать папку модов с базой данных"
            >
              <Show when={syncing()} fallback={
                <>
                  <i class="i-hugeicons-refresh w-4 h-4" />
                  Синхронизация
                </>
              }>
                <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                Синхронизация...
              </Show>
            </button>

            {/* Add Local Mod Button */}
            <button
              class="btn-secondary"
              data-size="sm"
              onClick={handleAddLocalMod}
              disabled={mods.loading()}
              title="Добавить локальный мод (.jar файл)"
            >
              <i class="i-hugeicons-add-01 w-4 h-4" />
              Локальный мод
            </button>

            {/* Check Dependencies Button - show only when mods exist */}
            <Show when={mods.mods().length > 0}>
              <button
                class="btn-secondary"
                data-size="sm"
                onClick={handleCheckDependencies}
                disabled={mods.resolvingDeps()}
              >
                <Show when={mods.resolvingDeps()} fallback={
                  <>
                    <i class="i-hugeicons-test-tube w-4 h-4" />
                    Проверить зависимости
                  </>
                }>
                  <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                  Проверка...
                </Show>
              </button>
            </Show>
          </div>
        </Show>
      </div>

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

          <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
            {/* Enabled/Disabled Filter */}
            <div>
              <label class="block text-xs font-medium mb-1 text-gray-400">Состояние</label>
              <select
                class="w-full text-sm"
                value={filterEnabled()}
                onChange={(e) => setFilterEnabled(e.currentTarget.value as any)}
              >
                <option value="all">Все ({mods.mods().length})</option>
                <option value="enabled">Включено ({mods.mods().filter(m => m.enabled).length})</option>
                <option value="disabled">Выключено ({mods.mods().filter(m => !m.enabled).length})</option>
              </select>
            </div>

            {/* Source Filter */}
            <div>
              <label class="block text-xs font-medium mb-1 text-gray-400">Источник</label>
              <select
                class="w-full text-sm"
                value={filterSource()}
                onChange={(e) => setFilterSource(e.currentTarget.value as any)}
              >
                <option value="all">Все источники</option>
                <option value="modrinth">Modrinth ({mods.mods().filter(m => m.source === "modrinth").length})</option>
                <option value="curseforge">CurseForge ({mods.mods().filter(m => m.source === "curseforge").length})</option>
                <option value="local">Локальные ({mods.mods().filter(m => m.source === "local").length})</option>
              </select>
            </div>

            {/* Auto-update Filter */}
            <div>
              <label class="block text-xs font-medium mb-1 text-gray-400">Автообновление</label>
              <select
                class="w-full text-sm"
                value={filterAutoUpdate()}
                onChange={(e) => setFilterAutoUpdate(e.currentTarget.value as any)}
              >
                <option value="all">Любое</option>
                <option value="yes">Включено ({mods.mods().filter(m => m.auto_update).length})</option>
                <option value="no">Выключено ({mods.mods().filter(m => !m.auto_update).length})</option>
              </select>
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

      {/* Sync Result Notification */}
      <Show when={syncResult()}>
        <div class="card bg-blue-600/10 border-blue-600/30 flex items-center gap-3">
          <i class="i-hugeicons-checkmark-circle-02 text-blue-400 w-5 h-5 flex-shrink-0" />
          <span class="text-sm text-blue-300">
            Синхронизация завершена:
            {syncResult()!.added > 0 && ` добавлено ${syncResult()!.added}`}
            {syncResult()!.added > 0 && syncResult()!.removed > 0 && ","}
            {syncResult()!.removed > 0 && ` удалено ${syncResult()!.removed}`}
            {syncResult()!.added === 0 && syncResult()!.removed === 0 && " изменений нет"}
          </span>
          <button
            class="ml-auto text-gray-500 hover:text-gray-300 transition-colors"
            onClick={() => setSyncResult(null)}
          >
            <i class="i-hugeicons-cancel-01 w-4 h-4" />
          </button>
        </div>
      </Show>

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
                  <h3 class="font-semibold truncate">{mod.name}</h3>
                  <div class="flex items-center gap-2 text-xs text-muted">
                    <span class="font-mono text-gray-500">{mod.slug}</span>
                    <span>•</span>
                    <span>{mod.version}</span>
                    <span>•</span>
                    <span class="capitalize">{mod.source}</span>
                  </div>
                </div>

                {/* Actions */}
                <div class="flex items-center gap-2">
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
          onClose={() => setSelectedMod(null)}
        />
      </Show>

      {/* Confirm Dialog */}
      <ConfirmDialogComponent />
    </div>
  );
};

export default ModsList;