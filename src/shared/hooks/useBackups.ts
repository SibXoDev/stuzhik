import { createSignal, Accessor } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { BackupRecord, BackupModStatus, BackupTrigger } from "../types/common.types";
import { createAsyncState, runAsync, runAsyncSilent, isValidInstanceId } from "./useAsyncUtils";

const LOG_PREFIX = "[Backup]";

/**
 * Hook для работы с бэкапами экземпляра
 */
export function useBackups(instanceId: Accessor<string | undefined>) {
  const [backups, setBackups] = createSignal<BackupRecord[]>([]);
  const { loading, setLoading, error, setError } = createAsyncState();

  /**
   * Загрузить список бэкапов для экземпляра
   */
  const loadBackups = async () => {
    const id = instanceId();
    if (!isValidInstanceId(id)) return;

    await runAsync(
      () => invoke<BackupRecord[]>("list_backups", { instanceId: id }),
      { setLoading, setError, logPrefix: LOG_PREFIX, onSuccess: setBackups }
    );
  };

  /**
   * Проверить, обнаружен ли мод для бэкапов
   */
  const detectBackupMod = async (): Promise<BackupModStatus | null> => {
    const id = instanceId();
    if (!isValidInstanceId(id)) return null;

    return runAsyncSilent(
      () => invoke<BackupModStatus>("detect_backup_mod", { instanceId: id }),
      { logPrefix: LOG_PREFIX }
    );
  };

  /**
   * Проверить, нужно ли создавать бэкап
   */
  const shouldBackup = async (trigger: BackupTrigger): Promise<boolean> => {
    const id = instanceId();
    if (!isValidInstanceId(id)) return false;

    const result = await runAsyncSilent(
      () => invoke<boolean>("should_backup", { instanceId: id, trigger }),
      { logPrefix: LOG_PREFIX }
    );
    return result ?? false;
  };

  /**
   * Создать бэкап
   */
  const createBackup = async (
    trigger: BackupTrigger,
    description: string
  ): Promise<BackupRecord | null> => {
    const id = instanceId();
    if (!isValidInstanceId(id)) return null;

    return runAsync(
      () => invoke<BackupRecord>("create_backup", { instanceId: id, trigger, description }),
      { setLoading, setError, logPrefix: LOG_PREFIX, onSuccess: () => loadBackups() }
    );
  };

  /**
   * Восстановить из бэкапа
   */
  const restoreBackup = async (backupId: string): Promise<boolean> => {
    const id = instanceId();
    if (!isValidInstanceId(id)) return false;

    const result = await runAsync(
      () => invoke<void>("restore_backup", { instanceId: id, backupId }),
      { setLoading, setError, logPrefix: LOG_PREFIX }
    );
    return result !== null;
  };

  /**
   * Удалить бэкап
   */
  const deleteBackup = async (backupId: string): Promise<boolean> => {
    const id = instanceId();
    if (!isValidInstanceId(id)) return false;

    const result = await runAsync(
      () => invoke<void>("delete_backup", { instanceId: id, backupId }),
      { setLoading, setError, logPrefix: LOG_PREFIX, onSuccess: () => loadBackups() }
    );
    return result !== null;
  };

  return {
    // State
    backups,
    loading,
    error,
    // Actions
    loadBackups,
    detectBackupMod,
    shouldBackup,
    createBackup,
    restoreBackup,
    deleteBackup,
  };
}
