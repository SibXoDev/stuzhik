import { createSignal } from "solid-js";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow, cursorPosition } from "@tauri-apps/api/window";

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
const [isInDetailView, setIsInDetailView] = createSignal(false);
const [dragPosition, setDragPosition] = createSignal<{ x: number; y: number } | null>(null);
const handlers: DropHandler[] = [];

let unlistenEnter: UnlistenFn | null = null;
let unlistenHover: UnlistenFn | null = null;
let unlistenDrop: UnlistenFn | null = null;
let unlistenLeave: UnlistenFn | null = null;

// Position polling interval (for Windows where drag-over doesn't fire)
let positionPollingInterval: ReturnType<typeof setInterval> | null = null;

async function pollCursorPosition() {
  try {
    const window = getCurrentWindow();
    const pos = await cursorPosition();
    // cursorPosition returns physical position, convert to logical
    const scaleFactor = await window.scaleFactor();
    const logicalX = pos.x / scaleFactor;
    const logicalY = pos.y / scaleFactor;

    // Get window position to convert to client coordinates
    const windowPos = await window.outerPosition();
    const clientX = logicalX - windowPos.x / scaleFactor;
    const clientY = logicalY - windowPos.y / scaleFactor;

    setDragPosition({ x: clientX, y: clientY });
  } catch (e) {
    // Ignore errors during polling
  }
}

function startPositionPolling() {
  if (positionPollingInterval) return;
  // Poll at 30fps for reasonable responsiveness
  positionPollingInterval = setInterval(pollCursorPosition, 33);
  // Also poll immediately
  pollCursorPosition();
}

function stopPositionPolling() {
  if (positionPollingInterval) {
    clearInterval(positionPollingInterval);
    positionPollingInterval = null;
  }
}

/**
 * Parse file path to DroppedFile
 */
function parseFilePath(path: string): DroppedFile {
  const name = path.split(/[\\/]/).pop() || path;
  const extension = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return { path, name, extension };
}

/**
 * Check if files are a valid homogeneous group (not mixed types)
 * Valid groups:
 * - All .jar files (mods)
 * - Single modpack file (.stzhk, .mrpack)
 * - Single or multiple .zip files (modpacks or resources)
 * - Single manifest file (manifest.json, modrinth.index.json)
 * Invalid: mixing different file types
 */
function isValidFileGroup(files: DroppedFile[]): boolean {
  if (files.length === 0) return false;

  const extensions = files.map((f) => f.extension);
  const uniqueExts = [...new Set(extensions)];

  // All same extension - check if valid
  if (uniqueExts.length === 1) {
    const ext = uniqueExts[0];
    // .jar - mods, any count OK
    if (ext === "jar") return true;
    // .zip - modpacks/resources, any count OK
    if (ext === "zip") return true;
    // .stzhk, .mrpack - modpacks, only single file
    if (ext === "stzhk" || ext === "mrpack") return files.length === 1;
    // .json - manifest files, only single file
    if (ext === "json") {
      const name = files[0].name.toLowerCase();
      return files.length === 1 && (name === "manifest.json" || name === "modrinth.index.json");
    }
    // Unknown extension
    return false;
  }

  // Multiple different extensions - not allowed
  return false;
}

/**
 * Initialize Tauri file drop listeners
 */
export async function initDragDrop() {
  // Listen for file enter (initial drag into window)
  unlistenEnter = await listen<{ paths: string[]; position?: { x: number; y: number } }>("tauri://drag-enter", (event) => {
    const files = event.payload.paths.map(parseFilePath);
    setIsDragging(true);
    setDraggedFiles(files);
    // Set initial position from Tauri event if available
    if (event.payload.position) {
      setDragPosition(event.payload.position);
    }
    // Start polling cursor position (Windows workaround)
    startPositionPolling();
  });

  // Listen for file hover (drag over window) - may not fire on Windows
  unlistenHover = await listen<{ paths: string[]; position?: { x: number; y: number } }>("tauri://drag-over", (event) => {
    const files = event.payload.paths.map(parseFilePath);
    setIsDragging(true);
    setDraggedFiles(files);
    if (event.payload.position) {
      setDragPosition(event.payload.position);
    }
  });

  // Listen for file drop
  unlistenDrop = await listen<{ paths: string[]; position?: { x: number; y: number } }>("tauri://drag-drop", async (event) => {
    stopPositionPolling();
    const files = event.payload.paths.map(parseFilePath);

    setIsDragging(false);
    setDraggedFiles([]);

    // Reject mixed file types - don't process anything
    if (!isValidFileGroup(files)) {
      setDragPosition(null);
      return;
    }

    // Sort handlers by priority (descending)
    const sortedHandlers = [...handlers].sort((a, b) => (b.priority || 0) - (a.priority || 0));

    // Find first handler that accepts these files
    for (const handler of sortedHandlers) {
      if (handler.accept(files)) {
        await handler.onDrop(files);
        break; // Only one handler processes the drop
      }
    }

    // Clear position after handlers processed
    setDragPosition(null);
  });

  // Listen for drag cancel/leave
  unlistenLeave = await listen("tauri://drag-leave", () => {
    stopPositionPolling();
    setIsDragging(false);
    setDraggedFiles([]);
    setDragPosition(null);
  });
}

/**
 * Cleanup listeners
 */
export function cleanupDragDrop() {
  stopPositionPolling();
  unlistenEnter?.();
  unlistenHover?.();
  unlistenDrop?.();
  unlistenLeave?.();
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
    dragPosition,
    isInDetailView,
    setIsInDetailView,
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
