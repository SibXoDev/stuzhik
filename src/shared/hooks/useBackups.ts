import { createSignal, Accessor } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { BackupRecord, BackupModStatus, BackupTrigger } from "../types/common.types";

/**
 * Hook для работы с бэкапами экземпляра
 */
export function useBackups(instanceId: Accessor<string | undefined>) {
  const [backups, setBackups] = createSignal<BackupRecord[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  /**
   * Загрузить список бэкапов для экземпляра
   */
  const loadBackups = async () => {
    const id = instanceId();
    if (!id) return;

    setLoading(true);
    setError(null);

    try {
      const result = await invoke<BackupRecord[]>("list_backups", {
        instanceId: id,
      });
      setBackups(result);
    } catch (e) {
      console.error("[BACKUP] Failed to load backups:", e);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  /**
   * Проверить, обнаружен ли мод для бэкапов
   */
  const detectBackupMod = async (): Promise<BackupModStatus | null> => {
    const id = instanceId();
    if (!id) return null;

    try {
      return await invoke<BackupModStatus>("detect_backup_mod", {
        instanceId: id,
      });
    } catch (e) {
      console.error("[BACKUP] Failed to detect backup mod:", e);
      return null;
    }
  };

  /**
   * Проверить, нужно ли создавать бэкап
   */
  const shouldBackup = async (trigger: BackupTrigger): Promise<boolean> => {
    const id = instanceId();
    if (!id) return false;

    try {
      return await invoke<boolean>("should_backup", {
        instanceId: id,
        trigger,
      });
    } catch (e) {
      console.error("[BACKUP] Failed to check should_backup:", e);
      return false;
    }
  };

  /**
   * Создать бэкап
   */
  const createBackup = async (
    trigger: BackupTrigger,
    description: string
  ): Promise<BackupRecord | null> => {
    const id = instanceId();
    if (!id) return null;

    setLoading(true);
    setError(null);

    try {
      const result = await invoke<BackupRecord>("create_backup", {
        instanceId: id,
        trigger,
        description,
      });
      // Обновляем список бэкапов
      await loadBackups();
      return result;
    } catch (e) {
      console.error("[BACKUP] Failed to create backup:", e);
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setLoading(false);
    }
  };

  /**
   * Восстановить из бэкапа
   */
  const restoreBackup = async (backupId: string): Promise<boolean> => {
    const id = instanceId();
    if (!id) return false;

    setLoading(true);
    setError(null);

    try {
      await invoke("restore_backup", {
        instanceId: id,
        backupId,
      });
      return true;
    } catch (e) {
      console.error("[BACKUP] Failed to restore backup:", e);
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setLoading(false);
    }
  };

  /**
   * Удалить бэкап
   */
  const deleteBackup = async (backupId: string): Promise<boolean> => {
    const id = instanceId();
    if (!id) return false;

    setLoading(true);
    setError(null);

    try {
      await invoke("delete_backup", {
        instanceId: id,
        backupId,
      });
      // Обновляем список бэкапов
      await loadBackups();
      return true;
    } catch (e) {
      console.error("[BACKUP] Failed to delete backup:", e);
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setLoading(false);
    }
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
