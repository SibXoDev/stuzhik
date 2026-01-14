export {
  initModInstallTracking,
  startModInstall,
  completeModInstall,
  isModInstalling,
  getInstallingMods,
  useInstallingMods,
  cleanupStaleEntries,
} from "./installingMods";

export {
  useCloseProtection,
  updateInstances,
  updateActiveDownloads,
  markUnsavedData,
  hasRunningServers,
  hasActiveDownloads,
  hasBlockingOperations,
  getCloseBlockReasons,
  runningServers,
} from "./closeProtection";

export {
  initDragDrop,
  cleanupDragDrop,
  registerDropHandler,
  useDragDrop,
  hasExtensions,
  filterByExtensions,
} from "./dragDrop";
export type { DroppedFile, DropHandler } from "./dragDrop";

export {
  registerSearchHandler,
  unregisterSearchHandler,
  triggerSearch,
  hasSearchHandlers,
} from "./searchFocus";
