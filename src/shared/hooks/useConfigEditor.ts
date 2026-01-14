import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { ConfigFile, ConfigContent } from "../types";
import { createAsyncState, runAsync, isValidInstanceId } from "./useAsyncUtils";

const LOG_PREFIX = "[ConfigEditor]";

export function useConfigEditor(instanceId: () => string) {
  const [configs, setConfigs] = createSignal<ConfigFile[]>([]);
  const { loading, setLoading, error, setError } = createAsyncState();

  async function listConfigs(subdir: string = "config") {
    const id = instanceId();
    if (!isValidInstanceId(id)) return;

    await runAsync(
      () => invoke<ConfigFile[]>("list_config_files", { instanceId: id, subdir }),
      { setLoading, setError, logPrefix: LOG_PREFIX, onSuccess: setConfigs }
    );
  }

  async function readConfig(relativePath: string): Promise<ConfigContent | null> {
    const id = instanceId();
    if (!isValidInstanceId(id)) return null;

    return runAsync(
      () => invoke<ConfigContent>("read_config_file", { instanceId: id, relativePath }),
      { setError, logPrefix: LOG_PREFIX }
    );
  }

  async function writeConfig(relativePath: string, content: string): Promise<boolean> {
    const id = instanceId();
    if (!isValidInstanceId(id)) return false;

    const result = await runAsync(
      () => invoke<void>("write_config_file", { instanceId: id, relativePath, content }),
      { setError, logPrefix: LOG_PREFIX }
    );
    return result !== null;
  }

  async function backupConfig(relativePath: string): Promise<string | null> {
    const id = instanceId();
    if (!isValidInstanceId(id)) return null;

    return runAsync(
      () => invoke<string>("backup_config_file", { instanceId: id, relativePath }),
      { setError, logPrefix: LOG_PREFIX }
    );
  }

  return {
    configs,
    loading,
    error,
    listConfigs,
    readConfig,
    writeConfig,
    backupConfig,
  };
}
