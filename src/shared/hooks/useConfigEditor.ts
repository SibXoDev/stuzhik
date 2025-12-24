import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { ConfigFile, ConfigContent } from "../types";

export function useConfigEditor(instanceId: () => string) {
  const [configs, setConfigs] = createSignal<ConfigFile[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function listConfigs(subdir: string = "config") {
    if (!instanceId()) return;

    try {
      setLoading(true);
      setError(null);
      const files = await invoke<ConfigFile[]>("list_config_files", {
        instanceId: instanceId(),
        subdir,
      });
      setConfigs(files);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to list config files:", e);
    } finally {
      setLoading(false);
    }
  }

  async function readConfig(relativePath: string): Promise<ConfigContent | null> {
    try {
      setError(null);
      return await invoke<ConfigContent>("read_config_file", {
        instanceId: instanceId(),
        relativePath,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to read config file:", e);
      return null;
    }
  }

  async function writeConfig(relativePath: string, content: string): Promise<boolean> {
    try {
      setError(null);
      await invoke("write_config_file", {
        instanceId: instanceId(),
        relativePath,
        content,
      });
      return true;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to write config file:", e);
      return false;
    }
  }

  async function backupConfig(relativePath: string): Promise<string | null> {
    try {
      setError(null);
      return await invoke<string>("backup_config_file", {
        instanceId: instanceId(),
        relativePath,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to backup config file:", e);
      return null;
    }
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
