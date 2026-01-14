import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { FileEntry } from "../types";
import { createAsyncState, runAsync, isValidInstanceId } from "./useAsyncUtils";

const LOG_PREFIX = "[FileBrowser]";

export function useFileBrowser(instanceId: () => string) {
  const [files, setFiles] = createSignal<FileEntry[]>([]);
  const [currentPath, setCurrentPath] = createSignal<string>("");
  const { loading, setLoading, error, setError } = createAsyncState();

  async function browse(subpath: string = "") {
    const id = instanceId();
    if (!isValidInstanceId(id)) return;

    await runAsync(
      () => invoke<FileEntry[]>("browse_instance_files", { instanceId: id, subpath }),
      {
        setLoading,
        setError,
        logPrefix: LOG_PREFIX,
        onSuccess: (entries) => {
          setFiles(entries);
          setCurrentPath(subpath);
        },
      }
    );
  }

  async function readFile(relativePath: string): Promise<string | null> {
    const id = instanceId();
    if (!isValidInstanceId(id)) return null;

    return runAsync(
      () => invoke<string>("read_instance_file", { instanceId: id, relativePath }),
      { setError, logPrefix: LOG_PREFIX }
    );
  }

  async function writeFile(relativePath: string, content: string): Promise<boolean> {
    const id = instanceId();
    if (!isValidInstanceId(id)) return false;

    const result = await runAsync(
      () => invoke<void>("write_instance_file", { instanceId: id, relativePath, content }),
      { setError, logPrefix: LOG_PREFIX }
    );
    return result !== null;
  }

  async function deleteFile(relativePath: string): Promise<boolean> {
    const id = instanceId();
    if (!isValidInstanceId(id)) return false;

    const result = await runAsync(
      () => invoke<void>("delete_instance_file", { instanceId: id, relativePath }),
      { setError, logPrefix: LOG_PREFIX, onSuccess: () => browse(currentPath()) }
    );
    return result !== null;
  }

  return {
    files,
    currentPath,
    loading,
    error,
    browse,
    readFile,
    writeFile,
    deleteFile,
  };
}
