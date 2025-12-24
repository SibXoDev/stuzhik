import { createSignal } from "solid-js";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

export interface DroppedFile {
  path: string;
  name: string;
  extension: string;
}

export interface DropHandler {
  /**
   * Filter function to determine if handler should process these files
   * Return true if handler wants to process the files
   */
  accept: (files: DroppedFile[]) => boolean;
  /**
   * Handler function to process dropped files
   */
  onDrop: (files: DroppedFile[]) => void | Promise<void>;
  /**
   * Priority (higher = processed first), default: 0
   */
  priority?: number;
}

// Global state
const [isDragging, setIsDragging] = createSignal(false);
const [draggedFiles, setDraggedFiles] = createSignal<DroppedFile[]>([]);
const handlers: DropHandler[] = [];

let unlistenHover: UnlistenFn | null = null;
let unlistenDrop: UnlistenFn | null = null;
let unlistenCancel: UnlistenFn | null = null;

/**
 * Parse file path to DroppedFile
 */
function parseFilePath(path: string): DroppedFile {
  const name = path.split(/[\\/]/).pop() || path;
  const extension = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return { path, name, extension };
}

/**
 * Initialize Tauri file drop listeners
 */
export async function initDragDrop() {
  // Listen for file hover (drag over window)
  unlistenHover = await listen<{ paths: string[] }>("tauri://drag-over", (event) => {
    const files = event.payload.paths.map(parseFilePath);
    setIsDragging(true);
    setDraggedFiles(files);
  });

  // Listen for file drop
  unlistenDrop = await listen<{ paths: string[] }>("tauri://drag-drop", async (event) => {
    const files = event.payload.paths.map(parseFilePath);
    setIsDragging(false);
    setDraggedFiles([]);

    // Sort handlers by priority (descending)
    const sortedHandlers = [...handlers].sort((a, b) => (b.priority || 0) - (a.priority || 0));

    // Find first handler that accepts these files
    for (const handler of sortedHandlers) {
      if (handler.accept(files)) {
        await handler.onDrop(files);
        break; // Only one handler processes the drop
      }
    }
  });

  // Listen for drag cancel
  unlistenCancel = await listen("tauri://drag-cancelled", () => {
    setIsDragging(false);
    setDraggedFiles([]);
  });
}

/**
 * Cleanup listeners
 */
export function cleanupDragDrop() {
  unlistenHover?.();
  unlistenDrop?.();
  unlistenCancel?.();
  handlers.length = 0;
}

/**
 * Register a drop handler
 * Returns cleanup function
 */
export function registerDropHandler(handler: DropHandler): () => void {
  handlers.push(handler);
  return () => {
    const index = handlers.indexOf(handler);
    if (index !== -1) {
      handlers.splice(index, 1);
    }
  };
}

/**
 * Hook for using drag & drop state
 */
export function useDragDrop() {
  return {
    isDragging,
    draggedFiles,
    registerDropHandler,
  };
}

/**
 * Utility: Check if files match extensions
 */
export function hasExtensions(files: DroppedFile[], extensions: string[]): boolean {
  return files.every((file) => extensions.includes(file.extension));
}

/**
 * Utility: Filter files by extensions
 */
export function filterByExtensions(files: DroppedFile[], extensions: string[]): DroppedFile[] {
  return files.filter((file) => extensions.includes(file.extension));
}
