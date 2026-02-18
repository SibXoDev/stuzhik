import { createSignal, Show, For, onMount } from "solid-js";
import { useBackups } from "../../../shared/hooks";
import { useI18n } from "../../../shared/i18n";
import { createConfirmDialog } from "../../../shared/components/ConfirmDialog";
import { Tooltip } from "../../../shared/ui/Tooltip";
import { formatSize } from "../../../shared/utils/format-size";
import type { Instance, BackupRecord, BackupModStatus } from "../../../shared/types";

interface Props {
  instance: Instance;
  onClose?: () => void;
  onInstanceUpdate?: (updates: Record<string, unknown>) => void;
  isModal?: boolean;
}

export default function BackupManager(props: Props) {
  const { t } = useI18n();
  const { confirm, ConfirmDialogComponent } = createConfirmDialog();

  // Safe accessor for instance
  const inst = () => props.instance;
  const instanceId = () => inst()?.id ?? "";

  const backups = useBackups(() => instanceId());
  const [backupModStatus, setBackupModStatus] = createSignal<BackupModStatus | null>(null);
  const [creating, setCreating] = createSignal(false);
  const [restoring, setRestoring] = createSignal<string | null>(null);

  // Localized size formatter
  const fmtSize = (bytes: number) => formatSize(bytes, t().ui?.units);

  // Форматирование даты
  const formatDate = (dateStr: string): string => {
    const date = new Date(dateStr);
    return date.toLocaleString();
  };

  // Получить название триггера
  const getTriggerName = (trigger: string): string => {
    const triggers: Record<string, string> = {
      before_mod_install: t().backup.trigger.beforeModInstall,
      before_mod_remove: t().backup.trigger.beforeModRemove,
      before_mod_update: t().backup.trigger.beforeModUpdate,
      before_auto_fix: t().backup.trigger.beforeAutoFix,
      manual: t().backup.trigger.manual,
    };
    return triggers[trigger] || trigger;
  };

  onMount(async () => {
    await backups.loadBackups();
    const status = await backups.detectBackupMod();
    setBackupModStatus(status);
  });

  // Создать ручной бэкап
  const handleCreateBackup = async () => {
    setCreating(true);
    try {
      await backups.createBackup("manual", t().backup.trigger.manual);
    } finally {
      setCreating(false);
    }
  };

  // Восстановить из бэкапа
  const handleRestore = async (backup: BackupRecord) => {
    const confirmed = await confirm({
      title: t().backup.restore,
      message: `${t().backup.restore} ${formatDate(backup.created_at)}?`,
      variant: "warning",
      confirmText: t().backup.restore,
    });
    if (!confirmed) return;

    setRestoring(backup.id);
    try {
      await backups.restoreBackup(backup.id);
    } finally {
      setRestoring(null);
    }
  };

  // Удалить бэкап
  const handleDelete = async (backup: BackupRecord) => {
    const confirmed = await confirm({
      title: t().backup.delete,
      message: t().backup.confirmDelete,
      variant: "danger",
      confirmText: t().common.delete,
    });
    if (!confirmed) return;

    await backups.deleteBackup(backup.id);
  };

  // Изменить override настройки
  const handleOverrideChange = (value: boolean | null) => {
    props.onInstanceUpdate?.({ backup_enabled: value });
  };

  // Текущее состояние бэкапов для этого экземпляра
  const backupStatus = () => {
    const backupEnabled = inst()?.backup_enabled;
    if (backupEnabled === true) return "enabled";
    if (backupEnabled === false) return "disabled";
    return "global";
  };

  const isModal = () => props.isModal !== false;

  const content = (
    <div class={`bg-gray-850 border border-gray-700 rounded-2xl ${isModal() ? 'w-full max-w-lg max-h-[80vh] overflow-hidden flex flex-col' : 'w-full'}`}>
      {/* Header */}
      <div class="flex items-center justify-between p-4 border-b border-gray-700">
        <div class="flex items-center gap-3">
          <i class="i-hugeicons-floppy-disk w-5 h-5 text-[var(--color-primary)]" />
          <h2 class="text-lg font-medium">{t().backup.title}</h2>
        </div>
        <Show when={isModal() && props.onClose}>
          <button
            class="btn-close"
            onClick={props.onClose}
            aria-label={t().ui?.tooltips?.close ?? "Close"}
          >
            <i class="i-hugeicons-cancel-01 w-5 h-5" />
          </button>
        </Show>
      </div>

        {/* Content */}
        <div class={`p-4 space-y-4 ${isModal() ? 'flex-1 overflow-y-auto' : ''}`}>
          {/* Backup Mod Detection */}
          <Show when={backupModStatus()}>
            <div class={`p-3 rounded-2xl border ${
              backupModStatus()?.detected
                ? 'bg-green-600/10 border-green-600/30'
                : 'bg-gray-alpha-30 border-gray-600/30'
            }`}>
              <div class="flex items-center gap-2">
                <i class={`w-4 h-4 ${
                  backupModStatus()?.detected ? 'i-hugeicons-checkmark-circle-02 text-green-400' : 'i-hugeicons-information-circle text-gray-400'
                }`} />
                <span class="text-sm font-medium">
                  {backupModStatus()?.detected ? t().backup.backupModDetected : t().backup.noBackupMod}
                </span>
              </div>
              <p class="text-xs text-gray-400">
                {backupModStatus()?.detected
                  ? t().backup.backupModMessage.replace('{mod}', backupModStatus()?.mod_name || '')
                  : t().backup.noBackupModMessage
                }
              </p>
            </div>
          </Show>

          {/* Override Setting */}
          <div class="space-y-2">
            <label class="text-sm font-medium">{t().backup.enabled}</label>
            <div class="grid grid-cols-3 gap-2">
              <Tooltip text={t().backup.useGlobal} position="bottom">
                <button
                  class={`px-2 py-2 rounded-2xl text-sm text-center truncate transition-colors ${
                    backupStatus() === 'global'
                      ? 'bg-[var(--color-primary)] text-white'
                      : 'bg-gray-alpha-30 hover:bg-gray-alpha-50'
                  }`}
                  onClick={() => handleOverrideChange(null)}
                >
                  {t().backup.useGlobal}
                </button>
              </Tooltip>
              <Tooltip text={t().common.enabled} position="bottom">
                <button
                  class={`px-2 py-2 rounded-2xl text-sm text-center truncate transition-colors ${
                    backupStatus() === 'enabled'
                      ? 'bg-green-600 text-white'
                      : 'bg-gray-alpha-30 hover:bg-gray-alpha-50'
                  }`}
                  onClick={() => handleOverrideChange(true)}
                >
                  {t().common.enabled}
                </button>
              </Tooltip>
              <Tooltip text={t().backup.disabled} position="bottom">
                <button
                  class={`px-2 py-2 rounded-2xl text-sm text-center truncate transition-colors ${
                    backupStatus() === 'disabled'
                      ? 'bg-red-600 text-white'
                      : 'bg-gray-alpha-30 hover:bg-gray-alpha-50'
                  }`}
                  onClick={() => handleOverrideChange(false)}
                >
                  {t().backup.disabled}
                </button>
              </Tooltip>
            </div>
          </div>

          {/* Create Manual Backup */}
          <button
            class="btn-primary w-full"
            onClick={handleCreateBackup}
            disabled={creating() || backups.loading()}
          >
            <Show when={creating()} fallback={
              <>
                <i class="i-hugeicons-add-01 w-4 h-4" />
                {t().backup.createManual}
              </>
            }>
              <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
              {t().backup.creating}
            </Show>
          </button>

          {/* Backup List */}
          <div class="space-y-2">
            <h3 class="text-sm font-medium text-gray-400">
              {t().backup.title} ({backups.backups().length})
            </h3>

            <Show when={backups.loading()}>
              <div class="flex items-center justify-center py-8">
                <i class="i-svg-spinners-6-dots-scale w-6 h-6" />
              </div>
            </Show>

            <Show when={!backups.loading() && backups.backups().length === 0}>
              <div class="text-center py-8 text-gray-500">
                <i class="i-hugeicons-file-01 w-10 h-10 mx-auto mb-2 opacity-50" />
                <p class="text-sm">{t().backup.noBackups}</p>
                <p class="text-xs mt-1">{t().backup.noBackupsDescription}</p>
              </div>
            </Show>

            <For each={backups.backups()}>
              {(backup) => (
                <div class="p-3 bg-gray-alpha-30 rounded-2xl border border-gray-700/50">
                  <div class="flex items-start justify-between gap-2">
                    <div class="flex-1 min-w-0">
                      <div class="text-sm font-medium truncate">{backup.description}</div>
                      <div class="flex items-center gap-2 mt-1 text-xs text-gray-400">
                        <span>{formatDate(backup.created_at)}</span>
                        <span>•</span>
                        <span>{fmtSize(backup.size)}</span>
                      </div>
                      <div class="mt-1">
                        <span class="text-xs px-2 py-0.5 bg-gray-600/50 rounded">
                          {getTriggerName(backup.trigger)}
                        </span>
                      </div>
                    </div>
                    <div class="flex items-center gap-1">
                      <Tooltip text={t().backup.restore} position="bottom">
                        <button
                          class="p-2 hover:bg-[var(--color-primary-bg)] text-[var(--color-primary)] rounded transition-colors"
                          onClick={() => handleRestore(backup)}
                          disabled={restoring() === backup.id}
                        >
                          <Show when={restoring() === backup.id} fallback={
                            <i class="i-hugeicons-refresh w-4 h-4" />
                          }>
                            <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                          </Show>
                        </button>
                      </Tooltip>
                      <Tooltip text={t().backup.delete} position="bottom">
                        <button
                          class="p-2 hover:bg-red-600/20 text-red-400 rounded transition-colors"
                          onClick={() => handleDelete(backup)}
                        >
                          <i class="i-hugeicons-delete-02 w-4 h-4" />
                        </button>
                      </Tooltip>
                    </div>
                  </div>
                </div>
              )}
            </For>
          </div>
        </div>
      </div>
  );

  // Return with optional modal wrapper
  return (
    <>
      {isModal() ? (
        <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div class="absolute inset-0 bg-black/60" onMouseDown={props.onClose} />
          {content}
        </div>
      ) : content}
      <ConfirmDialogComponent />
    </>
  );
}
