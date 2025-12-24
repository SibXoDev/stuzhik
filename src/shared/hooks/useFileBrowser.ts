import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { FileEntry } from "../types";

export function useFileBrowser(instanceId: () => string) {
  const [files, setFiles] = createSignal<FileEntry[]>([]);
  const [currentPath, setCurrentPath] = createSignal<string>("");
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function browse(subpath: string = "") {
    if (!instanceId()) return;

    try {
      setLoading(true);
      setError(null);
      const entries = await invoke<FileEntry[]>("browse_instance_files", {
        instanceId: instanceId(),
        subpath,
      });
      setFiles(entries);
      setCurrentPath(subpath);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to browse files:", e);
    } finally {
      setLoading(false);
    }
  }

  async function readFile(relativePath: string): Promise<string | null> {
    try {
      setError(null);
      return await invoke<string>("read_instance_file", {
        instanceId: instanceId(),
        relativePath,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to read file:", e);
      return null;
    }
  }

  async function writeFile(relativePath: string, content: string): Promise<boolean> {
    try {
      setError(null);
      await invoke("write_instance_file", {
        instanceId: instanceId(),
        relativePath,
        content,
      });
      return true;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to write file:", e);
      return false;
    }
  }

  async function deleteFile(relativePath: string): Promise<boolean> {
    try {
      setError(null);
      await invoke("delete_instance_file", {
        instanceId: instanceId(),
        relativePath,
      });
      // Refresh current directory
      await browse(currentPath());
      return true;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to delete file:", e);
      return false;
    }
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
