// Shared hooks
export { useBackups } from './useBackups';
export { useCrashHistory } from './useCrashHistory';
export { useKnowledgeBase } from './useKnowledgeBase';
export { useLiveCrashMonitor } from './useLiveCrashMonitor';
export type { LiveCrashState } from './useLiveCrashMonitor';
export { useDownloads, initDownloadListener, cleanupDownloadListener, cancelDownload } from './useDownloads';
export { useSafeTimers, useDebounce } from './useSafeTimers';
export { useMultiselect } from './useMultiselect';
// Modpack Editor hooks
export { useConfigEditor } from './useConfigEditor';
export { useFileBrowser } from './useFileBrowser';
export { useModProfiles } from './useModProfiles';
// Secure storage
export {
  // Universal secret API (recommended)
  storeSecret,
  getSecret,
  deleteSecret,
  hasSecret,
  getStorageBackend,
  useSecrets,
  // Typed convenience hooks
  useAuthToken,
  useRconPassword,
  // Migration
  migrateLegacySecrets,
} from './useSecureStorage';
export type { StorageBackend } from './useSecureStorage';
