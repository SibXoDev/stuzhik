import { createSignal, createEffect, createMemo, Show, onMount } from "solid-js";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { Settings, StorageInfo, AppPaths, OrphanedFolder, GpuDetectionResult, GpuDevice, SharedResourcesBreakdown, SystemJavaInfo, JavaInstallationInfo } from "../../../shared/types";
import { createConfirmDialog } from "../../../shared/components/ConfirmDialog";
import { NOTIFICATION_DURATION_MS } from "../../../shared/constants";
import { useSafeTimers, useDebounce, useDeveloperMode } from "../../../shared/hooks";
import {
  getBackgroundType,
  setBackgroundType,
  getBackgroundDimming,
  setBackgroundDimming,
  type BackgroundType
} from "../../../shared/components/AppBackground";
import { useI18n, availableLanguages, getLanguageName, type Language } from "../../../shared/i18n";
import { addToast } from "../../../shared/components/Toast";
import { Tabs } from "../../../shared/ui";
import TranslationEditor from "./TranslationEditor";
import InterfaceSettings from "./InterfaceSettings";
import SettingsGeneral from "./SettingsGeneral";
import SettingsConnect from "./SettingsConnect";
import SettingsGame from "./SettingsGame";
import SettingsMods from "./SettingsMods";
import SettingsData from "./SettingsData";

interface Props {
  onClose?: () => void;
  scrollTo?: string; // Section to scroll to (e.g., "connect", "java", "memory")
}

export default function SettingsDialog(props: Props) {
  const { confirm, ConfirmDialogComponent } = createConfirmDialog();
  const { language, setLanguage, t, loadCustomOverrides } = useI18n();
  const { setTimeout: safeTimeout } = useSafeTimers();
  const { debounce: debounceConnectSave } = useDebounce();
  const { developerMode } = useDeveloperMode();
  let contentRef: HTMLDivElement | undefined;

  // Map scrollTo section → tab id
  const sectionToTab: Record<string, string> = {
    connect: "connect",
    java: "game",
    memory: "game",
    gpu: "game",
    mods: "mods",
    downloads: "mods",
    auth: "data",
    backup: "data",
    storage: "data",
    folders: "data",
    translations: "translations",
  };
  const initialTab = props.scrollTo ? (sectionToTab[props.scrollTo] || "general") : "general";
  const [activeTab, setActiveTab] = createSignal(initialTab);

  const settingsTabs = createMemo(() => {
    const tabs = [
      { id: "general", label: t().settings.tabs?.general ?? "General", icon: "i-hugeicons-settings-02" },
      { id: "interface", label: t().settings.tabs?.interface ?? "Interface", icon: "i-hugeicons-paint-board" },
      { id: "connect", label: t().settings.tabs?.connect ?? "Connect", icon: "i-hugeicons-wifi-01" },
      { id: "game", label: t().settings.tabs?.game ?? "Game", icon: "i-hugeicons-play" },
      { id: "mods", label: t().settings.tabs?.mods ?? "Mods", icon: "i-hugeicons-package" },
      { id: "data", label: t().settings.tabs?.data ?? "Data", icon: "i-hugeicons-folder-01" },
    ];
    if (developerMode()) {
      tabs.push({ id: "translations", label: t().settings.tabs?.translations ?? "Translations", icon: "i-hugeicons-translate" });
    }
    return tabs;
  });

  // Helper для показа временного уведомления об успехе
  const showSuccessNotification = () => {
    setSuccess(true);
    safeTimeout(() => setSuccess(false), NOTIFICATION_DURATION_MS);
  };

  // Форматирование размера файла
  const formatSize = (bytes: number): string => {
    if (bytes === 0) return `0 ${t().settings.units.bytes}`;
    const k = 1024;
    const sizes = [
      t().settings.units.bytes,
      t().settings.units.kilobytes,
      t().settings.units.megabytes,
      t().settings.units.gigabytes,
      t().settings.units.terabytes
    ];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  const [settings, setSettings] = createSignal<Settings>({} as Settings);
  const [initialSettings, setInitialSettings] = createSignal<Settings>({} as Settings); // Initial state for Cancel
  const [totalMemory, setTotalMemory] = createSignal(8192); // default value
  const [loading, setLoading] = createSignal(true);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [success, setSuccess] = createSignal(false);

  // Check if settings have changed
  const hasChanges = createMemo(() => {
    const current = settings();
    const initial = initialSettings();
    return JSON.stringify(current) !== JSON.stringify(initial);
  });

  // Storage info
  const [storageInfo, setStorageInfo] = createSignal<StorageInfo | null>(null);
  const [appPaths, setAppPaths] = createSignal<AppPaths | null>(null);
  const [loadingStorage, setLoadingStorage] = createSignal(false);
  const [clearingCache, setClearingCache] = createSignal(false);
  const [clearingLogs, setClearingLogs] = createSignal(false);

  // Orphaned folders
  const [orphanedFolders, setOrphanedFolders] = createSignal<OrphanedFolder[]>([]);
  const [loadingOrphaned, setLoadingOrphaned] = createSignal(false);
  const [deletingOrphaned, setDeletingOrphaned] = createSignal(false);

  // Shared resources (Java versions, libraries, etc.)
  const [sharedResources, setSharedResources] = createSignal<SharedResourcesBreakdown | null>(null);
  const [loadingSharedResources, setLoadingSharedResources] = createSignal(false);
  const [cleaningJava, setCleaningJava] = createSignal<string | null>(null); // version being cleaned

  // Background type (frontend-only setting, stored in localStorage)
  const [backgroundType, setBackgroundTypeState] = createSignal<BackgroundType>(getBackgroundType());
  const [backgroundImageUrl, setBackgroundImageUrl] = createSignal<string | null>(null);
  const [loadingBackgroundImage, setLoadingBackgroundImage] = createSignal(false);
  const [backgroundDimming, setBackgroundDimmingState] = createSignal(getBackgroundDimming());

  // GPU detection
  const [gpuDetection, setGpuDetection] = createSignal<GpuDetectionResult | null>(null);
  const [loadingGpu, setLoadingGpu] = createSignal(false);

  // Java management
  const [systemJavaList, setSystemJavaList] = createSignal<SystemJavaInfo[]>([]);
  const [scanningJava, setScanningJava] = createSignal(false);
  const [customJavaPath, setCustomJavaPath] = createSignal("");
  const [addingJava, setAddingJava] = createSignal(false);
  const [installingJava, setInstallingJava] = createSignal<number | null>(null);
  const [javaError, setJavaError] = createSignal<string | null>(null);
  const [installedJavaVersions, setInstalledJavaVersions] = createSignal<number[]>([]);
  const [javaByVersion, setJavaByVersion] = createSignal<Record<number, JavaInstallationInfo[]>>({});
  const [loadingJavaVersions, setLoadingJavaVersions] = createSignal(false);

  // Auto-save settings with debounce (300ms)
  const { debounce: debounceSettingsSave } = useDebounce();
  createEffect(() => {
    const currentSettings = settings();
    const initial = initialSettings();

    // Skip first run and if settings are empty
    if (!currentSettings || Object.keys(currentSettings).length === 0 || currentSettings === initial) {
      return;
    }

    // Auto-save settings after 300ms of no changes
    debounceSettingsSave(async () => {
      try {
        await invoke("save_settings", { settings: currentSettings });
      } catch (e) {
        if (import.meta.env.DEV) console.error("Auto-save failed:", e);
      }
    }, 300);
  });

  // Stuzhik Connect (P2P)
  type Permission = "deny" | "friends_only" | "ask" | "allow";
  type Visibility = "invisible" | "friends_only" | "local_network";
  interface SendSettings {
    modpacks: Permission;
    configs: Permission;
    resourcepacks: Permission;
    shaderpacks: Permission;
  }
  interface ReceiveSettings {
    modpacks: Permission;
    configs: Permission;
    resourcepacks: Permission;
    shaderpacks: Permission;
    verify_hashes: boolean;
  }
  interface TrustedFriend {
    id: string;
    nickname: string;
    public_key: string;
    added_at: string;
    note?: string;
  }
  interface RememberedPermission {
    peer_id: string;
    content_type: string;
    allowed: boolean;
    created_at: string;
  }
  interface ConnectSettings {
    enabled: boolean;
    nickname: string;
    visibility: Visibility;
    show_nickname: boolean;
    show_modpacks: boolean;
    show_current_server: boolean;
    send: SendSettings;
    receive: ReceiveSettings;
    discovery_port: number;
    blocked_peers: string[];
    trusted_friends: TrustedFriend[];
    remembered_permissions: RememberedPermission[];
  }
  const [connectSettings, setConnectSettings] = createSignal<ConnectSettings | null>(null);
  const [savingConnect, setSavingConnect] = createSignal(false);

  // Track whether translations tab has been visited (lazy mount for performance)
  const [translationsTabMounted, setTranslationsTabMounted] = createSignal(initialTab === "translations");
  createEffect(() => {
    if (activeTab() === "translations") setTranslationsTabMounted(true);
  });

  // Custom languages created in Translation Editor
  const [customLangCodes, setCustomLangCodes] = createSignal<string[]>([]);

  // Flags for well-known languages
  const langFlags: Record<string, string> = {
    ru: "\u{1F1F7}\u{1F1FA}", en: "\u{1F1EC}\u{1F1E7}", de: "\u{1F1E9}\u{1F1EA}",
    fr: "\u{1F1EB}\u{1F1F7}", es: "\u{1F1EA}\u{1F1F8}", pt: "\u{1F1E7}\u{1F1F7}",
    it: "\u{1F1EE}\u{1F1F9}", ja: "\u{1F1EF}\u{1F1F5}", ko: "\u{1F1F0}\u{1F1F7}",
    zh: "\u{1F1E8}\u{1F1F3}", uk: "\u{1F1FA}\u{1F1E6}", pl: "\u{1F1F5}\u{1F1F1}",
  };

  // Build language options: bundled + custom
  const languageOptions = createMemo(() => {
    const bundled = availableLanguages.map(code => ({
      code,
      name: getLanguageName(code),
      flag: langFlags[code],
    }));
    const custom = customLangCodes()
      .filter(code => !availableLanguages.includes(code))
      .map(code => ({
        code,
        name: getLanguageName(code),
        flag: langFlags[code],
      }));
    return [...bundled, ...custom];
  });

  // Reload custom languages when switching to general tab
  // (user may have created new languages in Translations tab)
  createEffect(() => {
    if (activeTab() === "general") {
      invoke<string[]>("list_custom_translation_langs").then(langs => {
        setCustomLangCodes(langs);
      }).catch(() => {});
    }
  });

  // Загружаем данные параллельно при монтировании - максимально быстрое открытие
  onMount(async () => {
    try {
      // Параллельно загружаем settings, paths и totalMemory - это критично для UI
      const [data, paths, memory] = await Promise.all([
        invoke<Settings>("get_settings"),
        invoke<AppPaths>("get_app_paths"),
        invoke<number>("get_total_memory"),
      ]);
      setSettings(data);
      setInitialSettings(data); // Save initial state for Cancel button
      setAppPaths(paths);
      setTotalMemory(memory);
      setLoading(false); // Сразу показываем UI после основных данных

      // НЕ загружаем storageInfo и GPU автоматически - это тяжёлые операции
      // Пользователь может нажать кнопку в соответствующих секциях

      // Загружаем установленные Java версии (лёгкая операция)
      loadInstalledJavaVersions();

      // Загружаем список кастомных языков (лёгкая операция)
      invoke<string[]>("list_custom_translation_langs").then(langs => {
        setCustomLangCodes(langs);
      }).catch(() => {});

      // Загружаем настройки Connect (лёгкая операция)
      loadConnectSettings();

      // Фоновое изображение загружаем асинхронно (лёгкая операция)
      invoke<string | null>("get_background_image_path").then(imagePath => {
        if (imagePath) {
          const normalizedPath = imagePath.replace(/\\/g, "/");
          const assetUrl = convertFileSrc(normalizedPath);
          const img = new Image();
          img.onload = () => setBackgroundImageUrl(assetUrl);
          img.onerror = async () => {
            const dataUrl = await invoke<string | null>("get_background_image_base64");
            if (dataUrl) setBackgroundImageUrl(dataUrl);
          };
          img.src = assetUrl;
        }
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      if (import.meta.env.DEV) console.error("Failed to load settings:", e);
      setLoading(false);
    }
  });

  // If developer mode is turned off while on translations tab, switch to general
  createEffect(() => {
    if (!developerMode() && activeTab() === "translations") {
      setActiveTab("general");
    }
  });

  // Switch to correct tab and scroll to section when specified (once only)
  {
    let scrollApplied = false;
    createEffect(() => {
      const scrollTo = props.scrollTo;
      const isLoading = loading();
      if (scrollTo && !isLoading && contentRef && !scrollApplied) {
        scrollApplied = true;
        // Switch to the right tab first
        const targetTab = sectionToTab[scrollTo] || "general";
        setActiveTab(targetTab);
        // Small delay to ensure DOM is ready after tab switch
        safeTimeout(() => {
          const section = contentRef?.querySelector(`[data-section="${scrollTo}"]`);
          if (section) {
            section.scrollIntoView({ behavior: "smooth", block: "start" });
          }
        }, 100);
      }
    });
  }

  const loadStorageInfo = async () => {
    setLoadingStorage(true);
    try {
      const info = await invoke<StorageInfo>("get_storage_info");
      setStorageInfo(info);
    } catch (e: unknown) {
      if (import.meta.env.DEV) console.error("Failed to load storage info:", e);
    } finally {
      setLoadingStorage(false);
    }
  };

  const openFolder = async (folderType: string) => {
    try {
      await invoke("open_app_folder", { folderType });
    } catch (e: unknown) {
      if (import.meta.env.DEV) console.error("Failed to open folder:", e);
    }
  };

  const handleClearCache = async () => {
    const confirmed = await confirm({
      title: t().settings.dialogs.clearCache.title,
      message: t().settings.dialogs.clearCache.message,
      variant: "warning",
      confirmText: t().settings.dialogs.clearCache.confirm,
    });
    if (!confirmed) return;
    setClearingCache(true);
    try {
      await invoke<number>("clear_cache");
      showSuccessNotification();
      // Обновляем информацию о хранилище
      if (storageInfo()) await loadStorageInfo();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setClearingCache(false);
    }
  };

  const handleClearLogs = async () => {
    const confirmed = await confirm({
      title: t().settings.dialogs.clearLogs.title,
      message: t().settings.dialogs.clearLogs.message,
      variant: "warning",
      confirmText: t().settings.dialogs.clearLogs.confirm,
    });
    if (!confirmed) return;
    setClearingLogs(true);
    try {
      await invoke<number>("clear_logs");
      showSuccessNotification();
      if (storageInfo()) await loadStorageInfo();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setClearingLogs(false);
    }
  };

  const loadOrphanedFolders = async () => {
    setLoadingOrphaned(true);
    try {
      const folders = await invoke<OrphanedFolder[]>("get_orphaned_folders");
      setOrphanedFolders(folders);
    } catch (e: unknown) {
      if (import.meta.env.DEV) console.error("Failed to load orphaned folders:", e);
    } finally {
      setLoadingOrphaned(false);
    }
  };

  const handleDeleteOrphaned = async (path: string) => {
    const confirmed = await confirm({
      title: t().settings.dialogs.deleteFolder.title,
      message: t().settings.dialogs.deleteFolder.message,
      variant: "danger",
      confirmText: t().settings.dialogs.deleteFolder.confirm,
    });
    if (!confirmed) return;
    try {
      await invoke<number>("delete_orphaned_folder", { path });
      setOrphanedFolders(prev => prev.filter(f => f.path !== path));
      if (storageInfo()) await loadStorageInfo();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    }
  };

  const handleDeleteAllOrphaned = async () => {
    const count = orphanedFolders().length;
    const totalSize = orphanedFolders().reduce((sum, f) => sum + f.size, 0);
    const confirmed = await confirm({
      title: t().settings.dialogs.deleteAllOrphaned.title,
      message: `${count} ${t().settings.dialogs.deleteAllOrphaned.message} (${formatSize(totalSize)}).\n${t().settings.dialogs.deleteAllOrphaned.irreversible}`,
      variant: "danger",
      confirmText: t().settings.dialogs.deleteAllOrphaned.confirm,
    });
    if (!confirmed) return;

    setDeletingOrphaned(true);
    try {
      await invoke<number>("delete_all_orphaned_folders");
      setOrphanedFolders([]);
      showSuccessNotification();
      if (storageInfo()) await loadStorageInfo();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setDeletingOrphaned(false);
    }
  };

  // Shared resources functions
  const loadSharedResources = async () => {
    setLoadingSharedResources(true);
    try {
      const breakdown = await invoke<SharedResourcesBreakdown>("get_shared_resources_breakdown");
      setSharedResources(breakdown);
    } catch (e: unknown) {
      if (import.meta.env.DEV) console.error("Failed to load shared resources breakdown:", e);
    } finally {
      setLoadingSharedResources(false);
    }
  };

  const handleCleanupJavaVersion = async (version: string) => {
    const javaInfo = sharedResources()?.java_versions.find(j => j.version === version);
    if (!javaInfo) return;

    const confirmed = await confirm({
      title: t().settings.storage.java.cleanupConfirm.title,
      message: `${t().settings.storage.java.cleanupConfirm.message} Java ${version} (${formatSize(javaInfo.size)})?`,
      variant: "danger",
      confirmText: t().settings.storage.java.cleanupConfirm.confirm,
    });
    if (!confirmed) return;

    setCleaningJava(version);
    try {
      const freedBytes = await invoke<number>("cleanup_java_version", { version });
      if (import.meta.env.DEV) console.log(`Cleaned up Java ${version}, freed ${formatSize(freedBytes)}`);
      // Перезагружаем информацию
      await loadSharedResources();
      if (storageInfo()) await loadStorageInfo();
      showSuccessNotification();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setCleaningJava(null);
    }
  };

  const handleCleanupAllUnusedJava = async () => {
    const unusedJava = sharedResources()?.java_versions.filter(j => !j.is_used) || [];
    if (unusedJava.length === 0) return;

    const totalSize = unusedJava.reduce((sum, j) => sum + j.size, 0);
    const confirmed = await confirm({
      title: t().settings.storage.java.cleanupAllConfirm.title,
      message: `${t().settings.storage.java.cleanupAllConfirm.message} (${unusedJava.length} ${t().settings.storage.java.versions}, ${formatSize(totalSize)})?`,
      variant: "danger",
      confirmText: t().settings.storage.java.cleanupAllConfirm.confirm,
    });
    if (!confirmed) return;

    setCleaningJava("all");
    try {
      const freedBytes = await invoke<number>("cleanup_all_unused_java");
      if (import.meta.env.DEV) console.log(`Cleaned up all unused Java, freed ${formatSize(freedBytes)}`);
      await loadSharedResources();
      if (storageInfo()) await loadStorageInfo();
      showSuccessNotification();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setCleaningJava(null);
    }
  };

  // Java Management handlers
  const handleScanSystemJava = async () => {
    setScanningJava(true);
    setJavaError(null);
    try {
      const found = await invoke<SystemJavaInfo[]>("scan_system_java");
      setSystemJavaList(found);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setJavaError(msg);
    } finally {
      setScanningJava(false);
    }
  };

  const handleAddSystemJava = async (path: string) => {
    setAddingJava(true);
    setJavaError(null);
    try {
      await invoke<SystemJavaInfo>("add_custom_java", { path });
      // Обновляем список - помечаем как добавленную
      setSystemJavaList(prev => prev.map(j =>
        j.path === path ? { ...j, is_already_added: true } : j
      ));
      // Обновляем shared resources и список версий
      await loadInstalledJavaVersions();
      if (sharedResources()) {
        await loadSharedResources();
      }
      showSuccessNotification();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setJavaError(msg);
    } finally {
      setAddingJava(false);
    }
  };

  const handleAddCustomJava = async () => {
    const path = customJavaPath().trim();
    if (!path) return;

    setAddingJava(true);
    setJavaError(null);
    try {
      await invoke<SystemJavaInfo>("add_custom_java", { path });
      setCustomJavaPath("");
      // Обновляем shared resources и список версий
      await loadInstalledJavaVersions();
      if (sharedResources()) {
        await loadSharedResources();
      }
      showSuccessNotification();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setJavaError(msg);
    } finally {
      setAddingJava(false);
    }
  };

  const handleBrowseJava = async () => {
    const javaName = navigator.platform.toLowerCase().includes("win") ? "java.exe" : "java";
    const selected = await open({
      multiple: false,
      filters: [{ name: "Java", extensions: [javaName === "java.exe" ? "exe" : ""] }],
    });
    if (selected && typeof selected === "string") {
      setCustomJavaPath(selected);
    }
  };

  const handleInstallJava = async (version: number) => {
    setInstallingJava(version);
    setJavaError(null);
    try {
      await invoke<string>("install_java", { version });
      // Обновляем shared resources и список версий
      await loadInstalledJavaVersions();
      if (sharedResources()) {
        await loadSharedResources();
      }
      showSuccessNotification();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setJavaError(msg);
    } finally {
      setInstallingJava(null);
    }
  };

  // Загрузка установленных Java версий
  const loadInstalledJavaVersions = async () => {
    setLoadingJavaVersions(true);
    try {
      const versions = await invoke<number[]>("get_installed_java_major_versions");
      setInstalledJavaVersions(versions);

      // Загружаем Java для каждой версии
      const byVersion: Record<number, JavaInstallationInfo[]> = {};
      for (const v of versions) {
        const javas = await invoke<JavaInstallationInfo[]>("get_java_for_version", { majorVersion: v });
        byVersion[v] = javas;
      }
      setJavaByVersion(byVersion);
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to load Java versions:", e);
    } finally {
      setLoadingJavaVersions(false);
    }
  };

  // Загрузка настроек Connect
  const loadConnectSettings = async () => {
    try {
      const data = await invoke<ConnectSettings>("get_connect_settings");
      setConnectSettings(data);
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to load Connect settings:", e);
    }
  };

  // Сохранение настроек Connect (внутренняя функция)
  const saveConnectSettingsInternal = async (settings: ConnectSettings) => {
    setSavingConnect(true);
    try {
      await invoke("save_connect_settings", { settings });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setSavingConnect(false);
    }
  };

  // Debounced auto-save для Connect settings with automatic cleanup
  const debouncedSaveConnect = (settings: ConnectSettings) => {
    debounceConnectSave(() => {
      saveConnectSettingsInternal(settings);
    }, 500);
  };

  // Обновление одного поля Connect settings с автосохранением
  const updateConnectSetting = <K extends keyof ConnectSettings>(key: K, value: ConnectSettings[K]) => {
    const prev = connectSettings();
    if (!prev) return;
    const updated = { ...prev, [key]: value };
    setConnectSettings(updated);
    debouncedSaveConnect(updated);
  };

  // Обновление Send permission с автосохранением
  const updateSendPermission = (key: keyof SendSettings, value: Permission) => {
    const prev = connectSettings();
    if (!prev) return;
    const updated = { ...prev, send: { ...prev.send, [key]: value } };
    setConnectSettings(updated);
    debouncedSaveConnect(updated);
  };

  // Обновление Receive permission с автосохранением
  const updateReceivePermission = (key: keyof ReceiveSettings, value: Permission) => {
    const prev = connectSettings();
    if (!prev) return;
    const updated = { ...prev, receive: { ...prev.receive, [key]: value } };
    setConnectSettings(updated);
    debouncedSaveConnect(updated);
  };

  // Установка активной Java для версии
  const handleSetActiveJava = async (majorVersion: number, javaPath: string) => {
    try {
      await invoke("set_active_java", { majorVersion, javaPath });
      // Обновляем локальный state
      setJavaByVersion(prev => {
        const updated = { ...prev };
        if (updated[majorVersion]) {
          updated[majorVersion] = updated[majorVersion].map(j => ({
            ...j,
            is_active: j.path === javaPath
          }));
        }
        return updated;
      });
      showSuccessNotification();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setJavaError(msg);
    }
  };


  // Cancel - revert to initial state when Settings opened
  const handleCancel = async () => {
    if (saving()) return;

    try {
      setSaving(true);
      setError(null);
      // Revert to initial settings
      setSettings(initialSettings());
      // Save reverted settings to database
      await invoke("save_settings", { settings: initialSettings() });
      // Also revert language
      if (initialSettings().language) {
        setLanguage(initialSettings().language);
      }
      // Close dialog
      props.onClose?.();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      if (import.meta.env.DEV) console.error("Failed to cancel settings:", e);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (saving()) return;

    const confirmed = await confirm({
      title: t().settings.dialogs.resetSettings.title,
      message: t().settings.dialogs.resetSettings.message,
      variant: "warning",
      confirmText: t().settings.dialogs.resetSettings.confirm,
    });
    if (!confirmed) return;

    try {
      setSaving(true);
      setError(null);
      const defaultSettings = await invoke<Settings>("reset_settings");
      setSettings(defaultSettings);
      showSuccessNotification();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      if (import.meta.env.DEV) console.error("Failed to reset settings:", e);
    } finally {
      setSaving(false);
    }
  };

  const updateSetting = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  const handleBackgroundTypeChange = (type: BackgroundType) => {
    setBackgroundTypeState(type);
    setBackgroundType(type);
    // Dispatch custom event for real-time update
    window.dispatchEvent(new CustomEvent("backgroundTypeChange", { detail: type }));
  };

  const handlePickBackgroundImage = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{
          name: t().settings.fileTypes.images,
          extensions: ["png", "jpg", "jpeg", "webp", "gif"]
        }]
      });
      if (selected) {
        setLoadingBackgroundImage(true);
        // Копируем файл в папку лаунчера
        await invoke<string>("copy_background_image", { sourcePath: selected as string });
        // Пробуем asset://, fallback на base64 для release
        const imagePath = await invoke<string | null>("get_background_image_path");
        if (imagePath) {
          // Нормализуем путь для Windows
          const normalizedPath = imagePath.replace(/\\/g, "/");
          const assetUrl = convertFileSrc(normalizedPath);
          const img = new Image();
          img.onload = () => {
            setBackgroundImageUrl(assetUrl);
            setBackgroundTypeState("image");
            setBackgroundType("image");
            window.dispatchEvent(new CustomEvent("backgroundImageChange", { detail: assetUrl }));
            window.dispatchEvent(new CustomEvent("backgroundTypeChange", { detail: "image" }));
            setLoadingBackgroundImage(false);
          };
          img.onerror = async () => {
            // Fallback на base64
            const dataUrl = await invoke<string | null>("get_background_image_base64");
            if (dataUrl) {
              setBackgroundImageUrl(dataUrl);
              setBackgroundTypeState("image");
              setBackgroundType("image");
              window.dispatchEvent(new CustomEvent("backgroundImageChange", { detail: dataUrl }));
              window.dispatchEvent(new CustomEvent("backgroundTypeChange", { detail: "image" }));
            }
            setLoadingBackgroundImage(false);
          };
          img.src = assetUrl;
        } else {
          setLoadingBackgroundImage(false);
        }
      }
    } catch (e) {
      setLoadingBackgroundImage(false);
      if (import.meta.env.DEV) console.error("Failed to pick image:", e);
      setError(`${t().settings.dialogs.imageError}: ${e}`);
    }
  };

  const handleClearBackgroundImage = async () => {
    try {
      await invoke("delete_background_image");
      setBackgroundImageUrl(null);
      setBackgroundTypeState("static");
      setBackgroundType("static");
      window.dispatchEvent(new CustomEvent("backgroundImageChange", { detail: null }));
      window.dispatchEvent(new CustomEvent("backgroundTypeChange", { detail: "static" }));
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to delete background image:", e);
    }
  };

  // Выбрать существующую картинку как фон (без выбора новой)
  const handleSelectExistingImage = () => {
    if (backgroundImageUrl()) {
      setBackgroundTypeState("image");
      setBackgroundType("image");
      window.dispatchEvent(new CustomEvent("backgroundTypeChange", { detail: "image" }));
    }
  };

  // Изменить затемнение
  const handleDimmingChange = (value: number) => {
    setBackgroundDimmingState(value);
    setBackgroundDimming(value);
    window.dispatchEvent(new CustomEvent("backgroundDimmingChange", { detail: value }));
  };

  // Изменить язык
  const handleLanguageChange = (lang: Language) => {
    setLanguage(lang);
    updateSetting("language", lang);
  };

  // Импорт языка из JSON-файла (из General tab)
  const [importingLanguage, setImportingLanguage] = createSignal(false);

  const handleImportLanguage = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!selected || typeof selected !== "string") return;

      setImportingLanguage(true);

      // Backend determines lang code from _meta.lang in JSON, or filename as fallback
      const [code] = await invoke<[string, number]>("import_translation_file", { srcPath: selected });

      // Add to the local list
      setCustomLangCodes(prev => {
        if (prev.includes(code)) return prev;
        return [...prev, code];
      });

      // Auto-select the imported language
      handleLanguageChange(code);

      // Reload custom overrides for the active language
      await loadCustomOverrides();

      addToast({
        type: "success",
        title: `${getLanguageName(code)} (${code})`,
        message: t().settings?.language?.imported ?? "Language imported",
        duration: 3000,
      });
    } catch (e) {
      addToast({
        type: "error",
        title: t().settings?.language?.importError ?? "Import failed",
        message: String(e),
        duration: 5000,
      });
      if (import.meta.env.DEV) console.error("Failed to import language:", e);
    } finally {
      setImportingLanguage(false);
    }
  };

  // Delete a custom language
  const handleDeleteLanguage = async (code: string) => {
    try {
      await invoke("delete_custom_translations", { lang: code });
      setCustomLangCodes(prev => prev.filter(c => c !== code));

      // If the deleted language was active, switch to first bundled
      if (language() === code) {
        const fallback = availableLanguages[0] || "ru";
        handleLanguageChange(fallback);
        await loadCustomOverrides();
      }

      addToast({
        type: "success",
        title: t().settings?.language?.deleted ?? "Language deleted",
        duration: 2000,
      });
    } catch (e) {
      addToast({
        type: "error",
        title: t().settings?.language?.deleteError ?? "Failed to delete language",
        message: String(e),
        duration: 4000,
      });
    }
  };

  // Изменить режим разработчика (сохраняется сразу)
  const handleDeveloperModeChange = async (checked: boolean) => {
    updateSetting("developer_mode", checked);
    try {
      // Сохраняем сразу, не ждем кнопки Save
      await invoke("save_settings", { settings: { ...settings(), developer_mode: checked } });
      // Отправляем событие для обновления UI
      window.dispatchEvent(new CustomEvent("developerModeChange", { detail: checked }));
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to save developer mode setting:", e);
    }
  };

  // Загрузить список GPU
  const loadGpuDevices = async () => {
    setLoadingGpu(true);
    try {
      const result = await invoke<GpuDetectionResult>("detect_gpus_command");
      setGpuDetection(result);

      // Если GPU ещё не выбран и есть рекомендуемый - предлагаем его
      if (!settings().selected_gpu && result.recommended_id && result.has_multiple_gpus) {
        // Автоматически не устанавливаем - пусть пользователь сам выберет
      }
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to detect GPUs:", e);
    } finally {
      setLoadingGpu(false);
    }
  };

  // Получить тип GPU для отображения
  const getGpuTypeLabel = (device: GpuDevice): string => {
    switch (device.gpu_type) {
      case "discrete": return t().settings.gpu.discrete;
      case "integrated": return t().settings.gpu.integrated;
      default: return t().settings.gpu.unknown;
    }
  };

  return (
    <div class="fixed inset-0 z-50 pt-[var(--titlebar-height)] pb-4 px-4 flex items-center justify-center pointer-events-none">
      <div
        class="bg-gray-850 rounded-2xl shadow-2xl w-full max-w-7xl h-full max-h-full flex flex-col border border-gray-750 pointer-events-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div class="flex items-center justify-between px-6 py-4 border-b border-gray-800">
          <div>
            <h2 class="text-2xl font-bold">{t().settings.title}</h2>
            <p class="text-sm text-muted mt-1">
              {t().settings.subtitle}
            </p>
          </div>
          <button
            class="btn-close"
            onClick={() => props.onClose?.()}
            aria-label={t().ui?.tooltips?.close ?? "Close"}
          >
            <i class="i-hugeicons-cancel-01 w-5 h-5" />
          </button>
        </div>

        {/* Sidebar + Content layout */}
        <div class="flex flex-1 min-h-0">
          {/* Sidebar navigation */}
          <nav class="w-52 flex-shrink-0 border-r border-gray-800 py-3 px-2 overflow-y-auto">
            <Tabs
              tabs={settingsTabs()}
              activeTab={activeTab()}
              onTabChange={setActiveTab}
              variant="sidebar"
              aria-label="Settings sections"
            />
          </nav>

          {/* Content with proper scroll */}
          <div ref={contentRef} class="flex-1 overflow-y-auto px-6 py-4 min-w-0">
          {/* Loading State - без мерцания */}
          <Show when={loading()}>
            <div class="flex-center py-12 gap-2">
              <i class="i-svg-spinners-6-dots-scale w-6 h-6" />
              <span class="text-muted">{t().settings.loading}</span>
            </div>
          </Show>

          {/* Error Alert */}
          <Show when={error()}>
            <div class="mb-4 bg-red-600/10 border border-red-600/30 rounded-2xl p-4 animate-fade-in flex items-start gap-3" style="animation-duration: 0.1s">
              <i class="i-hugeicons-alert-02 text-red-400 w-5 h-5 flex-shrink-0" />
              <p class="text-red-400 text-sm flex-1">{error()}</p>
              <button
                class="text-red-400 hover:text-red-300 flex-shrink-0"
                onClick={() => setError(null)}
              >
                <i class="i-hugeicons-cancel-01 w-4 h-4" />
              </button>
            </div>
          </Show>

          {/* Success Alert */}
          <Show when={success()}>
            <div class="mb-4 bg-green-600/10 border border-green-600/30 rounded-2xl p-4 animate-fade-in flex items-start gap-3" style="animation-duration: 0.1s">
              <i class="i-hugeicons-checkmark-circle-02 text-green-400 w-5 h-5 flex-shrink-0" />
              <p class="text-green-400 text-sm flex-1">{t().settings.saved}</p>
            </div>
          </Show>

          {/* Settings Form - показываем только после загрузки */}
          <Show when={!loading()}>
            <div class="space-y-6">
              {/* === Tab: General === */}
              <Show when={activeTab() === "general"}>
                <SettingsGeneral
                  settings={settings}
                  updateSetting={updateSetting}
                  language={language}
                  onLanguageChange={handleLanguageChange}
                  languageOptions={languageOptions}
                  onImportLanguage={handleImportLanguage}
                  onDeleteLanguage={handleDeleteLanguage}
                  importingLanguage={importingLanguage}
                  backgroundType={backgroundType}
                  onBackgroundTypeChange={handleBackgroundTypeChange}
                  backgroundImageUrl={backgroundImageUrl}
                  loadingBackgroundImage={loadingBackgroundImage}
                  onPickBackgroundImage={handlePickBackgroundImage}
                  onClearBackgroundImage={handleClearBackgroundImage}
                  onSelectExistingImage={handleSelectExistingImage}
                  backgroundDimming={backgroundDimming}
                  onDimmingChange={handleDimmingChange}
                  onDeveloperModeChange={handleDeveloperModeChange}
                  t={t}
                />
              </Show>

              {/* === Tab: Interface === */}
              <Show when={activeTab() === "interface"}>
                <InterfaceSettings />
              </Show>

              {/* === Tab: Connect === */}
              <Show when={activeTab() === "connect"}>
                <SettingsConnect
                  connectSettings={connectSettings}
                  setConnectSettings={setConnectSettings}
                  updateConnectSetting={updateConnectSetting}
                  updateSendPermission={updateSendPermission}
                  updateReceivePermission={updateReceivePermission}
                  savingConnect={savingConnect}
                  defaultUsername={settings().default_username}
                  t={t}
                />
              </Show>

              {/* === Tab: Game === */}
              <Show when={activeTab() === "game"}>
                <SettingsGame
                  settings={settings}
                  updateSetting={updateSetting}
                  totalMemory={totalMemory}
                  java={{
                    loadInstalledJavaVersions,
                    installedJavaVersions,
                    javaByVersion,
                    loadingJavaVersions,
                    javaError,
                    installingJava,
                    systemJavaList,
                    scanningJava,
                    customJavaPath,
                    setCustomJavaPath,
                    addingJava,
                    handleScanSystemJava,
                    handleAddSystemJava,
                    handleAddCustomJava,
                    handleBrowseJava,
                    handleInstallJava,
                    handleSetActiveJava,
                  }}
                  gpu={{
                    gpuDetection,
                    loadingGpu,
                    loadGpuDevices,
                    getGpuTypeLabel,
                  }}
                  t={t}
                />
              </Show>

              {/* === Tab: Mods === */}
              <Show when={activeTab() === "mods"}>
                <SettingsMods
                  settings={settings}
                  updateSetting={updateSetting}
                  t={t}
                />
              </Show>

              {/* === Tab: Data === */}
              <Show when={activeTab() === "data"}>
                <SettingsData
                  settings={settings}
                  updateSetting={updateSetting}
                  appPaths={appPaths}
                  openFolder={openFolder}
                  formatSize={formatSize}
                  storage={{
                    storageInfo,
                    loadStorageInfo,
                    loadingStorage,
                    clearingCache,
                    handleClearCache,
                    clearingLogs,
                    handleClearLogs,
                  }}
                  orphaned={{
                    orphanedFolders,
                    loadOrphanedFolders,
                    loadingOrphaned,
                    handleDeleteOrphaned,
                    handleDeleteAllOrphaned,
                    deletingOrphaned,
                  }}
                  shared={{
                    sharedResources,
                    loadSharedResources,
                    loadingSharedResources,
                    cleaningJava,
                    handleCleanupJavaVersion,
                    handleCleanupAllUnusedJava,
                  }}
                  t={t}
                />
              </Show>

              {/* === Tab: Translations === */}
              {/* CSS display toggle preserves state across tab switches; Show guards lazy mount */}
              <Show when={translationsTabMounted()}>
                <div class="h-full" style={{ display: activeTab() === "translations" ? "block" : "none" }}>
                  <TranslationEditor />
                </div>
              </Show>
            </div>
          </Show>
        </div>
        </div>{/* /flex sidebar+content */}

        {/* Footer */}
        <div class="flex items-center justify-between px-6 py-4 border-t border-gray-800">
          <button
            type="button"
            class="btn-secondary"
            onClick={handleReset}
            disabled={saving() || loading()}
          >
            <i class="i-hugeicons-refresh w-4 h-4" />
            {t().settings.actions.reset}
          </button>
          <button
            type="button"
            class="btn-secondary"
            onClick={handleCancel}
            disabled={saving() || loading() || !hasChanges()}
          >
            <Show when={saving()} fallback={
              <>
                <i class="i-hugeicons-cancel-01 w-4 h-4" />
                {t().settings.actions.discardChanges || t().common.cancel}
              </>
            }>
              <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
              {t().settings.actions.reverting || "Отмена..."}
            </Show>
          </button>
        </div>
      </div>

      {/* Confirm Dialog */}
      <ConfirmDialogComponent />
    </div>
  );
}