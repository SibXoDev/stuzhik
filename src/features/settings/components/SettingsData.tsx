import { Show, For } from "solid-js";
import type { Accessor } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { Settings, StorageInfo, AppPaths, OrphanedFolder, SharedResourcesBreakdown } from "../../../shared/types";
import { Toggle, Select, RangeSlider } from "../../../shared/ui";

interface StorageManagement {
  storageInfo: Accessor<StorageInfo | null>;
  loadStorageInfo: () => void;
  loadingStorage: Accessor<boolean>;
  clearingCache: Accessor<boolean>;
  handleClearCache: () => void;
  clearingLogs: Accessor<boolean>;
  handleClearLogs: () => void;
}

interface OrphanedManagement {
  orphanedFolders: Accessor<OrphanedFolder[]>;
  loadOrphanedFolders: () => void;
  loadingOrphaned: Accessor<boolean>;
  handleDeleteOrphaned: (path: string) => void;
  handleDeleteAllOrphaned: () => void;
  deletingOrphaned: Accessor<boolean>;
}

interface SharedResourcesManagement {
  sharedResources: Accessor<SharedResourcesBreakdown | null>;
  loadSharedResources: () => void;
  loadingSharedResources: Accessor<boolean>;
  cleaningJava: Accessor<string | null>;
  handleCleanupJavaVersion: (version: string) => void;
  handleCleanupAllUnusedJava: () => void;
}

interface Props {
  settings: Accessor<Settings>;
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  appPaths: Accessor<AppPaths | null>;
  openFolder: (folderType: string) => void;
  formatSize: (bytes: number) => string;
  storage: StorageManagement;
  orphaned: OrphanedManagement;
  shared: SharedResourcesManagement;
  t: Accessor<Record<string, any>>;
}

export default function SettingsData(props: Props) {
  const t = () => props.t();

  return (
    <>
      {/* Авторизация */}
      <fieldset>
        <legend class="text-base font-medium mb-4 inline-flex items-center gap-2">
          <i class="i-hugeicons-lock w-5 h-5" />
          {t().settings.auth.title}
        </legend>
        <div class="space-y-4">
          <div>
            <label class="block text-sm font-medium mb-2">{t().settings.auth.type}</label>
            <Select
              value={props.settings().auth_type}
              onChange={(val) => props.updateSetting("auth_type", val)}
              options={[
                { value: "offline", label: t().settings.auth.offline },
                { value: "ely_by", label: t().settings.auth.elyBy },
                { value: "microsoft", label: t().settings.auth.microsoft },
              ]}
            />
          </div>
          <Show when={props.settings().auth_type === "ely_by"}>
            <div class="space-y-3 p-3 bg-blue-600/10 border border-blue-600/30 rounded-2xl">
              <div>
                <label class="block text-sm font-medium mb-2">
                  {t().settings.auth.elyByServer}
                </label>
                <input
                  type="url"
                  value={props.settings().ely_by_server_url || ""}
                  onInput={(e) => props.updateSetting("ely_by_server_url", e.currentTarget.value || null)}
                  placeholder="https://authserver.ely.by"
                  class="input w-full"
                />
              </div>
            </div>
          </Show>
        </div>
      </fieldset>

      {/* Бэкапы */}
      <fieldset>
        <legend class="text-base font-medium mb-4 inline-flex items-center gap-2">
          <i class="i-hugeicons-floppy-disk w-5 h-5" />
          {t().backup.title}
        </legend>
        <div class="space-y-4">
          {/* Включить/выключить бэкапы */}
          <div class="flex items-center justify-between">
            <div>
              <div class="text-sm font-medium">{t().backup.enabled}</div>
              <div class="text-xs text-gray-400">{t().backup.enabledDescription}</div>
            </div>
            <Toggle
              checked={props.settings().backup_enabled}
              onChange={(checked) => props.updateSetting("backup_enabled", checked)}
            />
          </div>

          <Show when={props.settings().backup_enabled}>
            {/* Максимум бэкапов */}
            <div>
              <div class="flex items-center justify-between mb-2">
                <div>
                  <div class="text-sm font-medium">{t().backup.maxCount}</div>
                  <div class="text-xs text-gray-400">{t().backup.maxCountDescription}</div>
                </div>
                <span class="text-sm font-mono bg-gray-alpha-50 px-2 py-1 rounded">
                  {props.settings().backup_max_count}
                </span>
              </div>
              <RangeSlider
                value={props.settings().backup_max_count}
                onChange={(val) => props.updateSetting("backup_max_count", val)}
                min={1}
                max={20}
                step={1}
                showTicks
                showLabels
                formatLabel={(val) => String(val)}
              />
            </div>

            {/* Включать saves */}
            <div class="flex items-center justify-between">
              <div>
                <div class="text-sm font-medium">{t().backup.includeSaves}</div>
                <div class="text-xs text-gray-400">{t().backup.includeSavesDescription}</div>
              </div>
              <Toggle
                checked={props.settings().backup_include_saves}
                onChange={(checked) => props.updateSetting("backup_include_saves", checked)}
              />
            </div>
          </Show>
        </div>
      </fieldset>

      {/* Хранилище */}
      <fieldset>
        <legend class="text-base font-medium mb-4 inline-flex items-center gap-2">
          <i class="i-hugeicons-folder-01 w-5 h-5" />
          {t().settings.storage.title}
        </legend>
        <div class="space-y-4">
          {/* Кнопка загрузки информации */}
          <Show when={!props.storage.storageInfo()}>
            <button
              class="btn-secondary w-full"
              onClick={props.storage.loadStorageInfo}
              disabled={props.storage.loadingStorage()}
            >
              <Show when={props.storage.loadingStorage()} fallback={
                <>
                  <i class="i-hugeicons-analytics-01 w-4 h-4" />
                  {t().settings.storage.calculate}
                </>
              }>
                <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                {t().settings.storage.calculating}
              </Show>
            </button>
          </Show>

          {/* Информация о размерах */}
          <Show when={props.storage.storageInfo()}>
            <div class="space-y-3">
              {/* Общий размер */}
              <div class="p-3 bg-purple-600/10 border border-purple-600/30 rounded-2xl">
                <div class="flex items-center justify-between">
                  <span class="text-sm font-medium">{t().settings.storage.totalUsed}</span>
                  <span class="text-lg font-bold text-purple-400">
                    {props.formatSize(props.storage.storageInfo()!.total_size)}
                  </span>
                </div>
              </div>

              {/* Разбивка по категориям */}
              <div class="grid grid-cols-2 gap-2 text-sm">
                <div class="p-2 bg-gray-alpha-50 rounded-2xl flex justify-between">
                  <span class="text-muted">{t().settings.storage.instances}</span>
                  <span>{props.formatSize(props.storage.storageInfo()!.instances_size)}</span>
                </div>
                <div class="p-2 bg-gray-alpha-50 rounded-2xl flex justify-between">
                  <span class="text-muted">{t().settings.storage.shared}</span>
                  <span>{props.formatSize(props.storage.storageInfo()!.shared_size)}</span>
                </div>
                <div class="p-2 bg-gray-alpha-50 rounded-2xl flex justify-between">
                  <span class="text-muted">{t().settings.storage.libraries}</span>
                  <span>{props.formatSize(props.storage.storageInfo()!.libraries_size)}</span>
                </div>
                <div class="p-2 bg-gray-alpha-50 rounded-2xl flex justify-between">
                  <span class="text-muted">{t().settings.storage.assets}</span>
                  <span>{props.formatSize(props.storage.storageInfo()!.assets_size)}</span>
                </div>
                <div class="p-2 bg-gray-alpha-50 rounded-2xl flex justify-between">
                  <span class="text-muted">{t().settings.storage.versions}</span>
                  <span>{props.formatSize(props.storage.storageInfo()!.versions_size)}</span>
                </div>
                <div class="p-2 bg-gray-alpha-50 rounded-2xl flex justify-between">
                  <span class="text-muted">{t().settings.storage.javaTotal}</span>
                  <span>{props.formatSize(props.storage.storageInfo()!.java_size)}</span>
                </div>
                <div class="p-2 bg-gray-alpha-50 rounded-2xl flex justify-between">
                  <span class="text-muted">{t().settings.storage.cache}</span>
                  <span>{props.formatSize(props.storage.storageInfo()!.cache_size)}</span>
                </div>
                <div class="p-2 bg-gray-alpha-50 rounded-2xl flex justify-between">
                  <span class="text-muted">{t().settings.storage.logs}</span>
                  <span>{props.formatSize(props.storage.storageInfo()!.logs_size)}</span>
                </div>
              </div>

              {/* Размер экземпляров */}
              <Show when={props.storage.storageInfo()!.instances.length > 0}>
                <div class="border-t border-gray-700 pt-3">
                  <p class="text-sm font-medium mb-2">{t().settings.storage.byInstances}</p>
                  <div class="space-y-1 max-h-32 overflow-y-auto">
                    <For each={props.storage.storageInfo()!.instances}>
                      {(inst) => (
                        <div class="flex items-center gap-2 text-sm p-1.5 bg-gray-alpha-30 rounded-2xl hover:bg-gray-alpha-50 transition-fast">
                          <button
                            class="btn-ghost btn-xs flex-shrink-0 p-1"
                            onClick={() => invoke("open_instance_folder", { id: inst.id }).catch(() => {})}
                            title={t().settings.storage.openFolder}
                          >
                            <i class="i-hugeicons-folder-01 w-3 h-3" />
                          </button>
                          <span class="truncate flex-1 text-muted" title={inst.path}>{inst.id}</span>
                          <span class="flex-shrink-0">{props.formatSize(inst.size)}</span>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              </Show>

              {/* Кнопка обновления */}
              <button
                class="btn-ghost text-xs w-full"
                onClick={props.storage.loadStorageInfo}
                disabled={props.storage.loadingStorage()}
              >
                <i class="i-hugeicons-refresh w-3 h-3" />
                {t().settings.storage.refresh}
              </button>
            </div>
          </Show>

          {/* Очистка */}
          <div class="flex gap-2">
            <button
              class="btn-secondary flex-1"
              onClick={props.storage.handleClearCache}
              disabled={props.storage.clearingCache()}
            >
              <Show when={props.storage.clearingCache()} fallback={
                <>
                  <i class="i-hugeicons-delete-02 w-4 h-4" />
                  {t().settings.storage.clearCache}
                </>
              }>
                <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
              </Show>
            </button>
            <button
              class="btn-secondary flex-1"
              onClick={props.storage.handleClearLogs}
              disabled={props.storage.clearingLogs()}
            >
              <Show when={props.storage.clearingLogs()} fallback={
                <>
                  <i class="i-hugeicons-file-01 w-4 h-4" />
                  {t().settings.storage.clearLogs}
                </>
              }>
                <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
              </Show>
            </button>
          </div>

          {/* Управление Java версиями */}
          <div class="border-t border-gray-700 pt-4 mt-4">
            <div class="flex items-center justify-between mb-3">
              <div>
                <p class="text-sm font-medium">{t().settings.storage.java.title}</p>
                <p class="text-xs text-muted">{t().settings.storage.java.description}</p>
              </div>
              <button
                class="btn-ghost btn-sm"
                onClick={props.shared.loadSharedResources}
                disabled={props.shared.loadingSharedResources()}
              >
                <Show when={props.shared.loadingSharedResources()} fallback={
                  <i class="i-hugeicons-search-01 w-4 h-4" />
                }>
                  <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                </Show>
                {t().settings.storage.java.analyze}
              </button>
            </div>

            <Show when={props.shared.sharedResources()}>
              {(resources) => {
                const unusedJava = () => resources().java_versions.filter(j => !j.is_used);
                const unusedSize = () => unusedJava().reduce((sum, j) => sum + j.size, 0);

                return (
                  <>
                    {/* Статистика общих ресурсов */}
                    <div class="grid grid-cols-2 gap-2 text-xs mb-3">
                      <div class="p-2 bg-gray-alpha-30 rounded-2xl inline-flex items-center gap-1">
                        <span class="text-muted">{t().settings.storage.libraries}:</span>
                        <span>{resources().libraries_count} ({props.formatSize(resources().libraries_size)})</span>
                      </div>
                      <div class="p-2 bg-gray-alpha-30 rounded-2xl inline-flex items-center gap-1">
                        <span class="text-muted">{t().settings.storage.assets}:</span>
                        <span>{resources().assets_indexes_count} ({props.formatSize(resources().assets_size)})</span>
                      </div>
                      <div class="p-2 bg-gray-alpha-30 rounded-2xl inline-flex items-center gap-1">
                        <span class="text-muted">{t().settings.storage.versions}:</span>
                        <span>{resources().versions_count} ({props.formatSize(resources().versions_size)})</span>
                      </div>
                      <div class="p-2 bg-gray-alpha-30 rounded-2xl inline-flex items-center gap-1">
                        <span class="text-muted">{t().settings.storage.java.versions}:</span>
                        <span>{resources().java_versions.length}</span>
                      </div>
                    </div>

                    {/* Список Java версий */}
                    <Show when={resources().java_versions.length > 0}>
                      <div class="space-y-2">
                        <div class="flex items-center justify-between">
                          <span class="text-sm font-medium">{t().settings.storage.java.installedVersions}</span>
                          <Show when={unusedJava().length > 0}>
                            <button
                              class="btn-secondary btn-sm text-orange-400 border-orange-600/50 hover:bg-orange-600/20"
                              onClick={props.shared.handleCleanupAllUnusedJava}
                              disabled={props.shared.cleaningJava() !== null}
                            >
                              <Show when={props.shared.cleaningJava() === "all"} fallback={
                                <>
                                  <i class="i-hugeicons-delete-02 w-3 h-3" />
                                  {t().settings.storage.java.cleanupAll} ({props.formatSize(unusedSize())})
                                </>
                              }>
                                <i class="i-svg-spinners-6-dots-scale w-3 h-3" />
                              </Show>
                            </button>
                          </Show>
                        </div>

                        <div class="space-y-1 max-h-40 overflow-y-auto">
                          <For each={resources().java_versions}>
                            {(java) => (
                              <div class={`flex items-center justify-between text-sm p-2 rounded-2xl ${java.is_used ? 'bg-green-600/10 border border-green-600/20' : 'bg-orange-600/10 border border-orange-600/20'}`}>
                                <div class="flex-1 min-w-0">
                                  <div class="flex items-center gap-2">
                                    <i class={`w-4 h-4 ${java.is_used ? 'i-hugeicons-checkmark-circle-02 text-green-400' : 'i-hugeicons-alert-02 text-orange-400'}`} />
                                    <span class="font-medium">Java {java.version}</span>
                                    <span class="text-xs text-muted">({props.formatSize(java.size)})</span>
                                  </div>
                                  <Show when={java.is_used && java.used_by_instances.length > 0}>
                                    <div class="text-xs text-muted mt-0.5 ml-6 truncate" title={java.used_by_instances.join(", ")}>
                                      {t().settings.storage.java.usedBy}: {java.used_by_instances.slice(0, 3).join(", ")}
                                      <Show when={java.used_by_instances.length > 3}>
                                        ... +{java.used_by_instances.length - 3}
                                      </Show>
                                    </div>
                                  </Show>
                                  <Show when={!java.is_used}>
                                    <div class="text-xs text-orange-400 mt-0.5 ml-6">
                                      {t().settings.storage.java.notUsed}
                                    </div>
                                  </Show>
                                </div>
                                <Show when={!java.is_used}>
                                  <button
                                    class="btn-ghost btn-sm text-red-400 hover:bg-red-600/20 flex-shrink-0"
                                    onClick={() => props.shared.handleCleanupJavaVersion(java.version)}
                                    disabled={props.shared.cleaningJava() !== null}
                                    title={t().common.delete}
                                  >
                                    <Show when={props.shared.cleaningJava() === java.version} fallback={
                                      <i class="i-hugeicons-delete-02 w-4 h-4" />
                                    }>
                                      <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                                    </Show>
                                  </button>
                                </Show>
                              </div>
                            )}
                          </For>
                        </div>
                      </div>
                    </Show>

                    {/* Подсказка если нет неиспользуемых ресурсов */}
                    <Show when={resources().total_unused_size === 0 && resources().java_versions.every(j => j.is_used)}>
                      <div class="p-3 bg-green-600/10 border border-green-600/30 rounded-2xl text-sm text-green-400 text-center inline-flex items-center justify-center gap-1">
                        <i class="i-hugeicons-checkmark-circle-02 w-4 h-4" />
                        {t().settings.storage.java.allUsed}
                      </div>
                    </Show>
                  </>
                );
              }}
            </Show>
          </div>

          {/* Мёртвые папки */}
          <div class="border-t border-gray-700 pt-4 mt-4">
            <div class="flex items-center justify-between mb-3">
              <div>
                <p class="text-sm font-medium">{t().settings.storage.orphaned.title}</p>
                <p class="text-xs text-muted">{t().settings.storage.orphaned.description}</p>
              </div>
              <button
                class="btn-ghost btn-sm"
                onClick={props.orphaned.loadOrphanedFolders}
                disabled={props.orphaned.loadingOrphaned()}
              >
                <Show when={props.orphaned.loadingOrphaned()} fallback={
                  <i class="i-hugeicons-search-01 w-4 h-4" />
                }>
                  <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                </Show>
                {t().settings.storage.orphaned.check}
              </button>
            </div>

            <Show when={props.orphaned.orphanedFolders().length > 0}>
              <div class="p-3 bg-orange-600/10 border border-orange-600/30 rounded-2xl space-y-3">
                <div class="flex items-center justify-between">
                  <span class="text-sm text-orange-400">
                    {t().settings.storage.orphaned.found}: {props.orphaned.orphanedFolders().length} ({props.formatSize(props.orphaned.orphanedFolders().reduce((s, f) => s + f.size, 0))})
                  </span>
                  <button
                    class="btn-secondary btn-sm text-orange-400 border-orange-600/50 hover:bg-orange-600/20"
                    onClick={props.orphaned.handleDeleteAllOrphaned}
                    disabled={props.orphaned.deletingOrphaned()}
                  >
                    <Show when={props.orphaned.deletingOrphaned()} fallback={
                      <>
                        <i class="i-hugeicons-delete-02 w-3 h-3" />
                        {t().settings.storage.orphaned.deleteAll}
                      </>
                    }>
                      <i class="i-svg-spinners-6-dots-scale w-3 h-3" />
                    </Show>
                  </button>
                </div>

                <div class="space-y-1 max-h-32 overflow-y-auto">
                  <For each={props.orphaned.orphanedFolders()}>
                    {(folder) => (
                      <div class="flex items-center justify-between text-sm p-1.5 bg-gray-alpha-30 rounded-2xl">
                        <div class="flex-1 min-w-0">
                          <span class="truncate block" title={folder.path}>{folder.name}</span>
                          <span class="text-xs text-muted">{props.formatSize(folder.size)}</span>
                        </div>
                        <button
                          class="btn-ghost btn-sm text-red-400 hover:bg-red-600/20 flex-shrink-0"
                          onClick={() => props.orphaned.handleDeleteOrphaned(folder.path)}
                          title={t().common.delete}
                        >
                          <i class="i-hugeicons-delete-02 w-3 h-3" />
                        </button>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </Show>
          </div>
        </div>
      </fieldset>

      {/* Папки приложения */}
      <fieldset>
        <legend class="text-base font-medium mb-4 inline-flex items-center gap-2">
          <i class="i-hugeicons-folder-open w-5 h-5" />
          {t().settings.folders.title}
        </legend>
        <Show when={props.appPaths()}>
          <div class="space-y-2">
            <For each={[
              { key: "base", label: t().settings.folders.base, path: props.appPaths()!.base },
              { key: "instances", label: t().settings.folders.instances, path: props.appPaths()!.instances },
              { key: "shared", label: t().settings.folders.shared, path: props.appPaths()!.shared },
              { key: "java", label: t().settings.folders.java, path: props.appPaths()!.java },
              { key: "cache", label: t().settings.folders.cache, path: props.appPaths()!.cache },
              { key: "logs", label: t().settings.folders.logs, path: props.appPaths()!.logs },
            ]}>
              {(item) => (
                <div class="flex items-center gap-2 p-2 bg-gray-alpha-30 rounded-2xl hover:bg-gray-alpha-50 transition-fast">
                  <button
                    class="btn-ghost btn-sm flex-shrink-0"
                    onClick={() => props.openFolder(item.key)}
                    title={t().settings.folders.openFolder}
                  >
                    <i class="i-hugeicons-folder-01 w-4 h-4" />
                  </button>
                  <div class="flex-1 min-w-0">
                    <p class="text-sm font-medium">{item.label}</p>
                    <p class="text-xs text-muted truncate" title={item.path}>{item.path}</p>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </fieldset>
    </>
  );
}
