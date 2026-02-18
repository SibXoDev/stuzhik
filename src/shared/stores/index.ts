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

// UI Preferences
export {
  getViewMode,
  setViewMode,
  isVisible,
  setVisible,
  getLayout,
  setLayoutField,
  getSectionOrder,
  setSectionOrder,
  // Surface themes (bg, text, borders, shadows)
  getActiveTheme,
  setActiveTheme,
  resolveTheme,
  getCustomThemes,
  saveCustomTheme,
  deleteCustomTheme,
  makeSurfaceTheme,
  applyTheme,
  BUILT_IN_THEMES,
  // Accent colors (--color-primary-*)
  getActiveAccent,
  setActiveAccent,
  resolveAccent,
  getCustomAccents,
  saveCustomAccent,
  deleteCustomAccent,
  generateAccentFromColor,
  applyAccent,
  BUILT_IN_ACCENTS,
  // Shape (border-radius, spacing, blur)
  getActiveShape,
  setActiveShape,
  resolveShape,
  applyShape,
  SHAPE_PRESETS,
  // Layout
  applyLayout,
  // Profiles
  getProfiles,
  getActiveProfile,
  saveProfile,
  loadProfile,
  deleteProfile,
  // Export / Import / Reset
  exportPreferences,
  importPreferences,
  resetPreferences,
  preferences,
} from "./uiPreferences";
export type {
  ViewMode,
  CardDensity,
  FontScale,
  SurfaceTheme,
  AccentTheme,
  ShapeConfig,
  LayoutConfig,
  UIProfile,
  UIPreferencesData,
} from "./uiPreferences";
