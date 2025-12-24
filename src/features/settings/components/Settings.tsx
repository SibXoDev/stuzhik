import { createSignal, createEffect, Show, onMount, For } from "solid-js";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { Settings, StorageInfo, AppPaths, OrphanedFolder, GpuDetectionResult, GpuDevice, SharedResourcesBreakdown, SystemJavaInfo, JavaInstallationInfo } from "../../../shared/types";
import { createConfirmDialog } from "../../../shared/components/ConfirmDialog";
import { NOTIFICATION_DURATION_MS } from "../../../shared/constants";
import { useSafeTimers, useDebounce } from "../../../shared/hooks";
import {
  getBackgroundType,
  setBackgroundType,
  getBackgroundDimming,
  setBackgroundDimming,
  type BackgroundType
} from "../../../shared/components/AppBackground";
import { useI18n, type Language } from "../../../shared/i18n";
import { BackgroundOption, RadioOption, LazyPreview, Toggle, Select } from "../../../shared/ui";
import FloatingLines from "../../../shared/components/FloatingLines";
import Aurora from "../../../shared/components/Aurora";
import DotGrid from "../../../shared/components/DotGrid";
import RippleGrid from "../../../shared/components/RippleGrid";
import EdgePixels from "../../../shared/components/EdgePixels";

interface Props {
  onClose?: () => void;
  scrollTo?: string; // Section to scroll to (e.g., "connect", "java", "memory")
}

export default function SettingsDialog(props: Props) {
  const { confirm, ConfirmDialogComponent } = createConfirmDialog();
  const { language, setLanguage, t } = useI18n();
  const { setTimeout: safeTimeout } = useSafeTimers();
  const { debounce: debounceConnectSave } = useDebounce();
  let contentRef: HTMLDivElement | undefined;

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
  const [loading, setLoading] = createSignal(true);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [success, setSuccess] = createSignal(false);

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

  // Загружаем данные параллельно при монтировании - максимально быстрое открытие
  onMount(async () => {
    try {
      // Параллельно загружаем settings и paths - это критично для UI
      const [data, paths] = await Promise.all([
        invoke<Settings>("get_settings"),
        invoke<AppPaths>("get_app_paths"),
      ]);
      setSettings(data);
      setAppPaths(paths);
      setLoading(false); // Сразу показываем UI после основных данных

      // НЕ загружаем storageInfo и GPU автоматически - это тяжёлые операции
      // Пользователь может нажать кнопку в соответствующих секциях

      // Загружаем установленные Java версии (лёгкая операция)
      loadInstalledJavaVersions();

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
      console.error("Failed to load settings:", e);
      setLoading(false);
    }
  });

  // Scroll to section when specified
  createEffect(() => {
    if (props.scrollTo && !loading() && contentRef) {
      // Small delay to ensure DOM is ready
      safeTimeout(() => {
        const section = contentRef?.querySelector(`[data-section="${props.scrollTo}"]`);
        if (section) {
          section.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }, 100);
    }
  });

  const loadStorageInfo = async () => {
    setLoadingStorage(true);
    try {
      const info = await invoke<StorageInfo>("get_storage_info");
      setStorageInfo(info);
    } catch (e: unknown) {
      console.error("Failed to load storage info:", e);
    } finally {
      setLoadingStorage(false);
    }
  };

  const openFolder = async (folderType: string) => {
    try {
      await invoke("open_app_folder", { folderType });
    } catch (e: unknown) {
      console.error("Failed to open folder:", e);
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
      console.error("Failed to load orphaned folders:", e);
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
      console.error("Failed to load shared resources breakdown:", e);
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
      console.log(`Cleaned up Java ${version}, freed ${formatSize(freedBytes)}`);
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
      console.log(`Cleaned up all unused Java, freed ${formatSize(freedBytes)}`);
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
      console.error("Failed to load Java versions:", e);
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
      console.error("Failed to load Connect settings:", e);
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

  // Описание для каких версий MC нужна Java
  const javaVersionDescriptions: Record<number, string> = {
    8: "MC 1.0 - 1.16.5",
    17: "MC 1.17 - 1.20.4",
    21: "MC 1.20.5+"
  };

  const handleSave = async () => {
    if (saving()) return;

    try {
      setSaving(true);
      setError(null);
      await invoke("save_settings", { settings: settings() });
      showSuccessNotification();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to save settings:", e);
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
      console.error("Failed to reset settings:", e);
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
      console.error("Failed to pick image:", e);
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
      console.error("Failed to delete background image:", e);
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
    updateSetting("language", lang as 'ru' | 'en');
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
      console.error("Failed to detect GPUs:", e);
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
        class="bg-gray-850 rounded-2xl shadow-2xl w-full max-w-5xl max-h-full flex flex-col border border-gray-750 pointer-events-auto"
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
          >
            <i class="i-hugeicons-cancel-01 w-5 h-5" />
          </button>
        </div>

        {/* Content with proper scroll - contain for scroll performance optimization */}
        <div ref={contentRef} class="flex-1 overflow-y-auto px-6 py-4">
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
              {/* Внешний вид */}
              <fieldset>
                <legend class="text-base font-medium mb-4 inline-flex items-center gap-2">
                  <i class="i-hugeicons-colors w-5 h-5" />
                  {t().settings.appearance.title}
                </legend>
                <div class="space-y-4">
                  <div>
                    <label class="block text-sm font-medium mb-3">{t().settings.appearance.background}</label>
                    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      {/* Floating Lines */}
                      <BackgroundOption
                        type="floatingLines"
                        label={t().settings.appearance.backgroundTypes.floatingLines}
                        active={backgroundType() === "floatingLines"}
                        onClick={() => handleBackgroundTypeChange("floatingLines")}
                        preview={
                          <LazyPreview>
                            <FloatingLines
                              linesGradient={["#1e3a5f", "#2d1b4e", "#1a3d5c", "#3d1f5c"]}
                              lineCount={4}
                              lineDistance={4}
                              animationSpeed={0.3}
                            />
                          </LazyPreview>
                        }
                      />

                      {/* Aurora */}
                      <BackgroundOption
                        type="aurora"
                        label={t().settings.appearance.backgroundTypes.aurora}
                        active={backgroundType() === "aurora"}
                        onClick={() => handleBackgroundTypeChange("aurora")}
                        preview={
                          <LazyPreview>
                            <Aurora
                              colorStops={["#0d3d4d", "#0d4035", "#2d1b4e"]}
                              amplitude={1.2}
                              blend={0.4}
                              speed={0.4}
                            />
                          </LazyPreview>
                        }
                      />

                      {/* Dot Grid */}
                      <BackgroundOption
                        type="dotGrid"
                        label={t().settings.appearance.backgroundTypes.dotGrid}
                        active={backgroundType() === "dotGrid"}
                        onClick={() => handleBackgroundTypeChange("dotGrid")}
                        preview={
                          <LazyPreview>
                            <DotGrid
                              dotSize={2}
                              gap={16}
                              baseColor="#1a1a2e"
                              activeColor="#3b82f6"
                              waveIntensity={0.15}
                              waveSpeed={0.2}
                            />
                          </LazyPreview>
                        }
                      />

                      {/* Ripple Grid */}
                      <BackgroundOption
                        type="rippleGrid"
                        label={t().settings.appearance.backgroundTypes.rippleGrid}
                        active={backgroundType() === "rippleGrid"}
                        onClick={() => handleBackgroundTypeChange("rippleGrid")}
                        preview={
                          <LazyPreview>
                            <RippleGrid
                              gridColor="#2d3748"
                              rippleIntensity={0.04}
                              gridSize={10.0}
                              gridThickness={20.0}
                              vignetteStrength={3.0}
                            />
                          </LazyPreview>
                        }
                      />

                      {/* Edge Pixels */}
                      <BackgroundOption
                        type="edgePixels"
                        label={t().settings.appearance.backgroundTypes.edgePixels}
                        active={backgroundType() === "edgePixels"}
                        onClick={() => handleBackgroundTypeChange("edgePixels")}
                        preview={
                          <LazyPreview>
                            <EdgePixels
                              pixelColor="#3b82f6"
                              pixelSize={3}
                              edgeWidth={0.2}
                            />
                          </LazyPreview>
                        }
                      />

                      {/* Static */}
                      <BackgroundOption
                        type="static"
                        label={t().settings.appearance.backgroundTypes.static}
                        active={backgroundType() === "static"}
                        onClick={() => handleBackgroundTypeChange("static")}
                        preview={<div />}
                      />

                      {/* Custom Image - special case with loading state */}
                      <BackgroundOption
                        type="image"
                        label={t().settings.appearance.backgroundTypes.image}
                        active={backgroundType() === "image"}
                        onClick={() => backgroundImageUrl() ? handleSelectExistingImage() : handlePickBackgroundImage()}
                        preview={
                          <Show
                            when={!loadingBackgroundImage()}
                            fallback={
                              <div class="absolute inset-0 bg-gray-alpha-50 flex-col-center gap-1">
                                <i class="i-svg-spinners-6-dots-scale w-5 h-5" />
                                <span class="text-xs text-gray-400">{t().settings.appearance.copying}</span>
                              </div>
                            }
                          >
                            {backgroundImageUrl() ? (
                              <div
                                class="absolute inset-0 bg-cover bg-center"
                                style={{ "background-image": `url(${backgroundImageUrl()})` }}
                              />
                            ) : (
                              <div class="absolute inset-0 bg-gray-alpha-50 flex-col-center gap-1">
                                <i class="i-hugeicons-image-01 w-6 h-6 text-gray-500" />
                                <span class="text-xs text-gray-500">{t().settings.appearance.selectImage}</span>
                              </div>
                            )}
                          </Show>
                        }
                      />
                    </div>
                  </div>

                  {/* Управление картинкой если есть */}
                  <Show when={backgroundImageUrl()}>
                    <div class="flex items-center gap-3 p-3 bg-gray-alpha-50 rounded-2xl">
                      <div
                        class="w-16 h-10 rounded bg-cover bg-center border border-gray-600 flex-shrink-0"
                        style={{ "background-image": `url(${backgroundImageUrl()})` }}
                      />
                      <div class="flex-1 min-w-0">
                        <p class="text-xs text-muted truncate">{t().settings.appearance.backgroundImage}</p>
                      </div>
                      <button
                        type="button"
                        class="btn-ghost btn-sm text-gray-400 hover:text-white hover:bg-gray-700"
                        onClick={handlePickBackgroundImage}
                        title={t().settings.appearance.change}
                        disabled={loadingBackgroundImage()}
                      >
                        <i class="i-hugeicons-edit-02 w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        class="btn-ghost btn-sm text-red-400 hover:bg-red-500/20"
                        onClick={handleClearBackgroundImage}
                        title={t().common.delete}
                      >
                        <i class="i-hugeicons-delete-02 w-4 h-4" />
                      </button>
                    </div>
                  </Show>

                  {/* Затемнение */}
                  <div>
                    <label class="flex items-center justify-between text-sm font-medium mb-2">
                      <span>{t().settings.appearance.dimming}</span>
                      <span class="text-muted">{backgroundDimming()}%</span>
                    </label>
                    <input
                      type="range"
                      min="0"
                      max="80"
                      step="5"
                      value={backgroundDimming()}
                      onInput={(e) => handleDimmingChange(parseInt(e.currentTarget.value, 10))}
                      class="w-full"
                    />
                    <p class="text-xs text-muted mt-1">{t().settings.appearance.dimmingHint}</p>
                  </div>
                </div>
              </fieldset>

              {/* Язык / Language */}
              <fieldset>
                <legend class="text-base font-medium mb-4 inline-flex items-center gap-2">
                  <i class="i-hugeicons-translate w-5 h-5" />
                  {t().settings.language.title}
                </legend>
                <div class="space-y-4">
                  <div>
                    <label class="block text-sm font-medium mb-3">{t().settings.language.select}</label>
                    <div class="grid grid-cols-2 gap-3">
                      <RadioOption
                        icon="🇷🇺"
                        title="Русский"
                        subtitle="Russian"
                        active={language() === "ru"}
                        onClick={() => handleLanguageChange("ru")}
                      />
                      <RadioOption
                        icon="🇬🇧"
                        title="English"
                        subtitle="Английский"
                        active={language() === "en"}
                        onClick={() => handleLanguageChange("en")}
                      />
                    </div>
                    <p class="text-xs text-muted mt-2">
                      {t().settings.language.changesApply}
                    </p>
                  </div>
                </div>
              </fieldset>

              {/* Пользователь */}
              <fieldset>
                <legend class="text-base font-medium mb-4 inline-flex items-center gap-2">
                  <i class="i-hugeicons-user w-5 h-5" />
                  {t().settings.user.title}
                </legend>
                <div>
                  <label class="block text-sm font-medium mb-2">
                    {t().settings.user.defaultUsername}
                  </label>
                  <input
                    type="text"
                    value={settings().default_username || ""}
                    onInput={(e) => updateSetting("default_username", e.currentTarget.value || null)}
                    placeholder={t().settings.user.usernamePlaceholder}
                    class="input w-full"
                  />
                  <p class="text-xs text-muted mt-1">
                    {t().settings.user.usernameHint}
                  </p>
                </div>
              </fieldset>

              {/* Stuzhik Connect (P2P) */}
              <fieldset data-section="connect">
                <legend class="text-base font-medium mb-4 inline-flex items-center gap-2">
                  <i class="i-hugeicons-user-group w-5 h-5" />
                  {t().connect.settings.title}
                </legend>
                <Show when={connectSettings()} fallback={
                  <div class="text-center py-4 text-muted">
                    <i class="i-svg-spinners-6-dots-scale w-5 h-5 inline-block" />
                  </div>
                }>
                  <div class="space-y-6">
                    {/* Включить Connect */}
                    <div class="flex items-center justify-between p-4 bg-gray-alpha-30 rounded-2xl">
                      <div>
                        <p class="font-medium">{t().connect.settings.enabled}</p>
                        <p class="text-xs text-muted">{t().connect.subtitle}</p>
                      </div>
                      <Toggle
                        checked={connectSettings()?.enabled || false}
                        onChange={(checked) => updateConnectSetting("enabled", checked)}
                      />
                    </div>

                    {/* Настройки (только если Connect включён) */}
                    <Show when={connectSettings()?.enabled}>
                      {/* Никнейм */}
                      <div>
                        <label class="block text-sm font-medium mb-2">
                          {t().connect.settings.nickname}
                        </label>
                        <input
                          type="text"
                          value={connectSettings()?.nickname || ""}
                          onInput={(e) => updateConnectSetting("nickname", e.currentTarget.value)}
                          placeholder={settings().default_username || "Player"}
                          class="input w-full"
                        />
                        <p class="text-xs text-muted mt-1">
                          {t().connect.settings.nicknameHint}
                        </p>
                      </div>

                      {/* Видимость */}
                      <div>
                        <label class="block text-sm font-medium mb-3">
                          {t().connect.settings.visibility}
                        </label>
                        <div class="grid grid-cols-3 gap-2">
                          <button
                            class={`p-3 rounded-xl border-2 transition-fast text-center ${
                              connectSettings()?.visibility === "invisible"
                                ? "border-blue-500 bg-blue-500/10"
                                : "border-gray-700 hover:border-gray-500"
                            }`}
                            onClick={() => updateConnectSetting("visibility", "invisible")}
                          >
                            <i class="i-hugeicons-view-off w-5 h-5 mb-1" />
                            <p class="text-xs">{t().connect.settings.visibilityInvisible}</p>
                          </button>
                          <button
                            class={`p-3 rounded-xl border-2 transition-fast text-center ${
                              connectSettings()?.visibility === "friends_only"
                                ? "border-blue-500 bg-blue-500/10"
                                : "border-gray-700 hover:border-gray-500"
                            }`}
                            onClick={() => updateConnectSetting("visibility", "friends_only")}
                          >
                            <i class="i-hugeicons:user-multiple w-5 h-5 mb-1" />
                            <p class="text-xs">{t().connect.settings.visibilityFriends}</p>
                          </button>
                          <button
                            class={`p-3 rounded-xl border-2 transition-fast text-center ${
                              connectSettings()?.visibility === "local_network"
                                ? "border-blue-500 bg-blue-500/10"
                                : "border-gray-700 hover:border-gray-500"
                            }`}
                            onClick={() => updateConnectSetting("visibility", "local_network")}
                          >
                            <i class="i-hugeicons-wifi-01 w-5 h-5 mb-1" />
                            <p class="text-xs">{t().connect.settings.visibilityAll}</p>
                          </button>
                        </div>
                      </div>

                      {/* Что показывать */}
                      <div class="space-y-3">
                        <div class="flex items-center justify-between">
                          <span class="text-sm">{t().connect.settings.showNickname}</span>
                          <Toggle
                            checked={connectSettings()?.show_nickname ?? false}
                            onChange={(checked) => updateConnectSetting("show_nickname", checked)}
                          />
                        </div>
                        <div class="flex items-center justify-between">
                          <span class="text-sm">{t().connect.settings.showModpacks}</span>
                          <Toggle
                            checked={connectSettings()?.show_modpacks ?? false}
                            onChange={(checked) => updateConnectSetting("show_modpacks", checked)}
                          />
                        </div>
                        <div class="flex items-center justify-between">
                          <span class="text-sm">{t().connect.settings.showServer}</span>
                          <Toggle
                            checked={connectSettings()?.show_current_server ?? false}
                            onChange={(checked) => updateConnectSetting("show_current_server", checked)}
                          />
                        </div>
                      </div>

                      {/* Разрешения на отправку */}
                      <div>
                        <label class="block text-sm font-medium mb-3">
                          {t().connect.settings.send}
                        </label>
                        <div class="space-y-2">
                          <For each={["modpacks", "configs", "resourcepacks", "shaderpacks"] as const}>
                            {(item) => (
                              <div class="flex items-center justify-between p-3 bg-gray-alpha-30 rounded-xl">
                                <span class="text-sm">{t().connect.settings[item]}</span>
                                <Select
                                  value={connectSettings()?.send[item] || "ask"}
                                  onChange={(value) => updateSendPermission(item, value as Permission)}
                                  class="w-32"
                                  options={[
                                    { value: "deny", label: t().connect.settings.permissionDeny },
                                    { value: "friends_only", label: t().connect.settings.permissionFriends },
                                    { value: "ask", label: t().connect.settings.permissionAsk },
                                    { value: "allow", label: t().connect.settings.permissionAllow },
                                  ]}
                                />
                              </div>
                            )}
                          </For>
                        </div>
                      </div>

                      {/* Разрешения на получение */}
                      <div>
                        <label class="block text-sm font-medium mb-3">
                          {t().connect.settings.receive}
                        </label>
                        <div class="space-y-2">
                          <For each={["modpacks", "configs", "resourcepacks", "shaderpacks"] as const}>
                            {(item) => (
                              <div class="flex items-center justify-between p-3 bg-gray-alpha-30 rounded-xl">
                                <span class="text-sm">{t().connect.settings[item]}</span>
                                <Select
                                  value={connectSettings()?.receive[item] || "ask"}
                                  onChange={(value) => updateReceivePermission(item, value as Permission)}
                                  class="w-32"
                                  options={[
                                    { value: "deny", label: t().connect.settings.permissionDeny },
                                    { value: "friends_only", label: t().connect.settings.permissionFriends },
                                    { value: "ask", label: t().connect.settings.permissionAsk },
                                    { value: "allow", label: t().connect.settings.permissionAllow },
                                  ]}
                                />
                              </div>
                            )}
                          </For>
                        </div>
                      </div>

                      {/* UDP Порт */}
                      <div>
                        <label class="block text-sm font-medium mb-2">
                          {t().connect.settings.port}
                        </label>
                        <input
                          type="number"
                          value={connectSettings()?.discovery_port || 19847}
                          onInput={(e) => updateConnectSetting("discovery_port", Number(e.currentTarget.value) || 19847)}
                          min="1024"
                          max="65535"
                          class="input w-32"
                        />
                        <p class="text-xs text-amber-400 mt-1">
                          <i class="i-hugeicons-alert-02 w-3 h-3 inline-block" /> {t().connect.settings.portWarning}
                        </p>
                      </div>

                      {/* Blocked users */}
                      <Show when={(connectSettings()?.blocked_peers?.length ?? 0) > 0}>
                        <div class="mt-4 pt-4 border-t border-gray-700">
                          <label class="block text-sm font-medium mb-2">
                            {t().connect.settings.blockedUsers}
                          </label>
                          <div class="space-y-2">
                            <For each={connectSettings()?.blocked_peers || []}>
                              {(peerId) => (
                                <div class="flex items-center justify-between p-2 bg-gray-800 rounded-lg">
                                  <span class="text-sm text-gray-400 truncate">{peerId}</span>
                                  <button
                                    class="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white transition-colors"
                                    onClick={async () => {
                                      try {
                                        await invoke("unblock_peer", { peerId });
                                        const prev = connectSettings();
                                        if (prev) {
                                          setConnectSettings({
                                            ...prev,
                                            blocked_peers: prev.blocked_peers.filter(id => id !== peerId)
                                          });
                                        }
                                      } catch (e) {
                                        console.error("Failed to unblock peer:", e);
                                      }
                                    }}
                                  >
                                    {t().connect.settings.unblock}
                                  </button>
                                </div>
                              )}
                            </For>
                          </div>
                        </div>
                      </Show>

                      {/* Trusted friends */}
                      <Show when={(connectSettings()?.trusted_friends?.length ?? 0) > 0}>
                        <div class="mt-4 pt-4 border-t border-gray-700">
                          <label class="block text-sm font-medium mb-2">
                            {t().connect.settings.trustedFriends}
                          </label>
                          <div class="space-y-2">
                            <For each={connectSettings()?.trusted_friends || []}>
                              {(friend) => (
                                <div class="flex items-center justify-between p-3 bg-gray-800 rounded-lg">
                                  <div class="flex items-center gap-3 min-w-0">
                                    <div class="w-8 h-8 rounded-full bg-green-500/20 flex items-center justify-center flex-shrink-0">
                                      <i class="i-hugeicons:user-check-01 w-4 h-4 text-green-400" />
                                    </div>
                                    <div class="min-w-0">
                                      <p class="text-sm font-medium truncate">{friend.nickname}</p>
                                      <p class="text-xs text-gray-500 truncate" title={friend.public_key}>
                                        {friend.public_key.slice(0, 12)}...
                                      </p>
                                    </div>
                                  </div>
                                  <button
                                    class="text-xs px-2 py-1 rounded bg-red-500/20 hover:bg-red-500/30 text-red-400 hover:text-red-300 transition-colors flex-shrink-0 flex items-center gap-1"
                                    onClick={async () => {
                                      try {
                                        await invoke("remove_friend", { peerId: friend.id });
                                        const prev = connectSettings();
                                        if (prev) {
                                          setConnectSettings({
                                            ...prev,
                                            trusted_friends: prev.trusted_friends.filter(f => f.id !== friend.id)
                                          });
                                        }
                                      } catch (e) {
                                        console.error("Failed to remove friend:", e);
                                      }
                                    }}
                                  >
                                    <i class="i-hugeicons:user-minus-01 w-3.5 h-3.5" />
                                    {t().connect.settings.removeFriend}
                                  </button>
                                </div>
                              )}
                            </For>
                          </div>
                        </div>
                      </Show>

                      {/* Индикатор автосохранения */}
                      <Show when={savingConnect()}>
                        <div class="flex items-center gap-2 text-muted text-xs justify-center">
                          <i class="i-svg-spinners-ring-resize w-3 h-3" />
                          {t().settings.actions.saving}
                        </div>
                      </Show>
                    </Show>
                  </div>
                </Show>
              </fieldset>

              {/* Память */}
              <fieldset>
                <legend class="text-base font-medium mb-4 inline-flex items-center gap-2">
                  <i class="i-hugeicons-cpu w-5 h-5" />
                  {t().settings.memory.title}
                </legend>
                <div class="space-y-4">
                  <div>
                    <label class="block text-sm font-medium mb-2">
                      {t().settings.memory.minMemory}: {settings().default_memory_min} МБ
                    </label>
                    <input
                      type="range"
                      min="512"
                      max="16384"
                      step="128"
                      value={settings().default_memory_min}
                      onInput={(e) => {
                        const val = Number(e.currentTarget.value);
                        updateSetting("default_memory_min", val);
                        if (val > settings().default_memory_max) {
                          updateSetting("default_memory_max", val);
                        }
                      }}
                      class="w-full"
                    />
                  </div>
                  <div>
                    <label class="block text-sm font-medium mb-2">
                      {t().settings.memory.maxMemory}: {settings().default_memory_max} МБ
                    </label>
                    <input
                      type="range"
                      min="512"
                      max="16384"
                      step="128"
                      value={settings().default_memory_max}
                      onInput={(e) => {
                        const val = Number(e.currentTarget.value);
                        updateSetting("default_memory_max", val);
                        if (val < settings().default_memory_min) {
                          updateSetting("default_memory_min", val);
                        }
                      }}
                      class="w-full"
                    />
                  </div>
                </div>
              </fieldset>

              {/* Java & Запуск */}
              <fieldset>
                <legend class="text-base font-medium mb-4 inline-flex items-center gap-2">
                  <i class="i-hugeicons-source-code w-5 h-5" />
                  {t().settings.java.title}
                </legend>
                <div class="space-y-4">
                  <div>
                    <label class="block text-sm font-medium mb-2">
                      {t().settings.java.defaultJvmArgs}
                    </label>
                    <textarea
                      value={settings().default_java_args || ""}
                      onInput={(e) => updateSetting("default_java_args", e.currentTarget.value || null)}
                      placeholder="-XX:+UseG1GC -XX:+UnlockExperimentalVMOptions..."
                      rows="3"
                      class="input w-full"
                    />
                    <p class="text-xs text-muted mt-1">
                      {t().settings.java.jvmArgsHint}
                    </p>
                  </div>
                  <div>
                    <label class="block text-sm font-medium mb-2">
                      {t().settings.java.defaultGameArgs}
                    </label>
                    <textarea
                      value={settings().default_game_args || ""}
                      onInput={(e) => updateSetting("default_game_args", e.currentTarget.value || null)}
                      placeholder="--fullscreen"
                      rows="2"
                      class="input w-full"
                    />
                  </div>
                  <div class="flex items-center justify-between">
                    <span class="text-sm">{t().settings.java.autoInstall}</span>
                    <Toggle
                      checked={settings().java_auto_install}
                      onChange={(checked) => updateSetting("java_auto_install", checked)}
                    />
                  </div>

                  {/* Java Management */}
                  <div class="border-t border-gray-700 pt-4 mt-4">
                    <div class="flex items-center justify-between mb-3">
                      <p class="text-sm font-medium">{t().settings.java.management.title}</p>
                      <button
                        class="btn-secondary text-xs py-1 px-2"
                        onClick={loadInstalledJavaVersions}
                        disabled={loadingJavaVersions()}
                      >
                        <Show when={loadingJavaVersions()} fallback={
                          <><i class="i-hugeicons-refresh w-3 h-3" /></>
                        }>
                          <i class="i-svg-spinners-6-dots-scale w-3 h-3" />
                        </Show>
                      </button>
                    </div>

                    {/* Ошибка */}
                    <Show when={javaError()}>
                      <div class="bg-red-500/10 border border-red-500/20 rounded-2xl p-3 mb-3 text-sm text-red-400">
                        {javaError()}
                      </div>
                    </Show>

                    <div class="space-y-3">
                      {/* Java версии с выбором активной */}
                      <For each={[8, 17, 21] as const}>
                        {(version) => {
                          const isInstalled = () => installedJavaVersions().includes(version);
                          const javasForVersion = () => javaByVersion()[version] || [];
                          const hasMultiple = () => javasForVersion().length > 1;
                          const activeJava = () => javasForVersion().find(j => j.is_active) || javasForVersion()[0];

                          return (
                            <div class={`p-3 rounded-2xl border ${isInstalled() ? 'bg-green-600/5 border-green-600/20' : 'bg-gray-800/50 border-gray-700/50'}`}>
                              <div class="flex items-center justify-between mb-2">
                                <div class="flex items-center gap-2">
                                  <i class={`i-hugeicons-coffee-01 w-4 h-4 ${isInstalled() ? 'text-green-400' : 'text-gray-500'}`} />
                                  <span class="font-medium">Java {version}</span>
                                  <span class="text-xs text-muted">({javaVersionDescriptions[version]})</span>
                                </div>
                                <Show when={isInstalled()} fallback={
                                  <button
                                    class="btn-primary text-xs py-1 px-2"
                                    onClick={() => handleInstallJava(version)}
                                    disabled={installingJava() !== null}
                                  >
                                    <Show when={installingJava() === version} fallback={
                                      <><i class="i-hugeicons-download-02 w-3 h-3 mr-1" />{t().settings.java.management.download}</>
                                    }>
                                      <i class="i-svg-spinners-6-dots-scale w-3 h-3" />
                                    </Show>
                                  </button>
                                }>
                                  <span class="text-xs text-green-400 flex items-center gap-1">
                                    <i class="i-hugeicons-checkmark-circle-02 w-3 h-3" />
                                    {t().settings.java.management.installed}
                                  </span>
                                </Show>
                              </div>

                              {/* Выбор активной Java если несколько */}
                              <Show when={isInstalled()}>
                                <Show when={hasMultiple()} fallback={
                                  <p class="text-xs text-muted truncate" title={activeJava()?.path}>
                                    {activeJava()?.vendor && <span class="text-blue-400">[{activeJava()?.vendor}] </span>}
                                    {activeJava()?.path}
                                  </p>
                                }>
                                  <div class="mt-1">
                                    <Select
                                      value={activeJava()?.path || ""}
                                      onChange={(val) => handleSetActiveJava(version, val)}
                                      options={javasForVersion().map(java => ({
                                        value: java.path,
                                        label: `${java.vendor ? `[${java.vendor}] ` : ""}${java.path}${java.is_auto_installed ? " (Adoptium)" : ""}`
                                      }))}
                                    />
                                  </div>
                                </Show>
                              </Show>
                            </div>
                          );
                        }}
                      </For>

                      {/* Поиск системных Java */}
                      <div class="border-t border-gray-700 pt-3 mt-3">
                        <button
                          class="btn-secondary w-full"
                          onClick={handleScanSystemJava}
                          disabled={scanningJava()}
                        >
                          <Show when={scanningJava()} fallback={
                            <>
                              <i class="i-hugeicons-search-01 w-4 h-4" />
                              {t().settings.java.management.scan}
                            </>
                          }>
                            <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                            {t().settings.java.management.scanning}
                          </Show>
                        </button>

                        {/* Найденные системные Java */}
                        <Show when={systemJavaList().length > 0}>
                          <div class="space-y-2 mt-3">
                            <p class="text-xs text-muted">{t().settings.java.management.found}: {systemJavaList().length}</p>
                            <For each={systemJavaList()}>
                              {(java) => (
                                <div class="flex items-center justify-between text-sm p-2 rounded-2xl bg-gray-800/50 border border-gray-700/50">
                                  <div class="flex-1 min-w-0 mr-2">
                                    <div class="flex items-center gap-2">
                                      <span class="font-medium">Java {java.major_version}</span>
                                      <span class="text-xs text-muted">({java.version})</span>
                                      <Show when={java.vendor}>
                                        <span class="text-xs px-1.5 py-0.5 bg-blue-600/20 text-blue-400 rounded-full">{java.vendor}</span>
                                      </Show>
                                    </div>
                                    <p class="text-xs text-muted truncate mt-0.5" title={java.path}>{java.path}</p>
                                  </div>
                                  <Show when={!java.is_already_added} fallback={
                                    <span class="text-xs text-green-400 flex items-center gap-1">
                                      <i class="i-hugeicons-checkmark-circle-02 w-3 h-3" />
                                      {t().settings.java.management.added}
                                    </span>
                                  }>
                                    <button
                                      class="btn-primary text-xs py-1 px-2"
                                      onClick={() => handleAddSystemJava(java.path)}
                                      disabled={addingJava()}
                                    >
                                      <Show when={addingJava()} fallback={
                                        <>{t().settings.java.management.add}</>
                                      }>
                                        <i class="i-svg-spinners-6-dots-scale w-3 h-3" />
                                      </Show>
                                    </button>
                                  </Show>
                                </div>
                              )}
                            </For>
                          </div>
                        </Show>
                      </div>

                      {/* Ручной ввод пути */}
                      <div class="border-t border-gray-700 pt-3 mt-3">
                        <p class="text-xs text-muted mb-2">{t().settings.java.management.customPath}</p>
                        <div class="flex gap-2">
                          <input
                            type="text"
                            class="input flex-1"
                            placeholder={navigator.platform.toLowerCase().includes("win") ? "C:\\Program Files\\Java\\jdk-21\\bin\\java.exe" : "/usr/lib/jvm/java-21/bin/java"}
                            value={customJavaPath()}
                            onInput={(e) => setCustomJavaPath(e.currentTarget.value)}
                          />
                          <button class="btn-secondary" onClick={handleBrowseJava}>
                            <i class="i-hugeicons-folder-01 w-4 h-4" />
                          </button>
                          <button
                            class="btn-primary"
                            onClick={handleAddCustomJava}
                            disabled={!customJavaPath().trim() || addingJava()}
                          >
                            <Show when={addingJava()} fallback={
                              <>{t().settings.java.management.add}</>
                            }>
                              <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                            </Show>
                          </button>
                        </div>
                      </div>

                      <p class="text-xs text-muted">{t().settings.java.management.downloadHint}</p>
                    </div>
                  </div>
                </div>
              </fieldset>

              {/* GPU Selection */}
              <fieldset>
                <legend class="text-base font-medium mb-4 inline-flex items-center gap-2">
                  <i class="i-hugeicons-cpu w-5 h-5" />
                  {t().settings.gpu.title}
                </legend>
                <div class="space-y-4">
                  {/* Кнопка обнаружения GPU */}
                  <Show when={!gpuDetection()}>
                    <button
                      class="btn-secondary w-full"
                      onClick={loadGpuDevices}
                      disabled={loadingGpu()}
                    >
                      <Show when={loadingGpu()} fallback={
                        <>
                          <i class="i-hugeicons-search-01 w-4 h-4" />
                          {t().settings.gpu.select}
                        </>
                      }>
                        <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                        {t().settings.gpu.detecting}
                      </Show>
                    </button>
                  </Show>

                  {/* Список GPU */}
                  <Show when={gpuDetection()}>
                    <div class="space-y-3">
                      {/* Подсказка если несколько GPU */}
                      <Show when={gpuDetection()!.has_multiple_gpus}>
                        <div class="p-3 bg-blue-600/10 border border-blue-600/30 rounded-2xl">
                          <div class="flex items-start gap-2">
                            <i class="i-hugeicons-information-circle w-4 h-4 text-blue-400 mt-0.5" />
                            <div>
                              <p class="text-sm font-medium text-blue-400">{t().settings.gpu.multipleGpus}</p>
                              <p class="text-xs text-muted mt-1">{t().settings.gpu.multipleGpusHint}</p>
                            </div>
                          </div>
                        </div>
                      </Show>

                      {/* Автоматический выбор */}
                      <button
                        type="button"
                        class={`group overflow-hidden rounded-2xl border-2 transition-colors duration-75 p-4 w-full ${
                          !settings().selected_gpu
                            ? "border-blue-500 bg-blue-500/10"
                            : "border-gray-700 hover:border-gray-500 hover:bg-gray-alpha-50"
                        }`}
                        onClick={() => updateSetting("selected_gpu", null)}
                      >
                        <div class="flex items-center gap-3">
                          <i class="i-hugeicons-ai-magic w-6 h-6 text-blue-400" />
                          <div class="text-left flex-1">
                            <div class="font-medium text-sm">{t().settings.gpu.auto}</div>
                            <div class="text-xs text-muted">{t().settings.gpu.autoHint}</div>
                          </div>
                          <Show when={!settings().selected_gpu}>
                            <div class="w-5 h-5 bg-blue-500 rounded-full flex items-center justify-center flex-shrink-0">
                              <i class="i-hugeicons-checkmark-circle-02 w-3 h-3 text-white" />
                            </div>
                          </Show>
                        </div>
                      </button>

                      {/* Список устройств */}
                      <For each={gpuDetection()!.devices}>
                        {(device) => (
                          <button
                            type="button"
                            class={`group overflow-hidden rounded-2xl border-2 transition-colors duration-75 p-4 w-full ${
                              settings().selected_gpu === device.id
                                ? "border-blue-500 bg-blue-500/10"
                                : "border-gray-700 hover:border-gray-500 hover:bg-gray-alpha-50"
                            }`}
                            onClick={() => updateSetting("selected_gpu", device.id)}
                          >
                            <div class="flex items-center gap-3">
                              <i class={`w-6 h-6 ${
                                device.gpu_type === "discrete"
                                  ? "i-hugeicons-package text-green-400"
                                  : device.gpu_type === "integrated"
                                    ? "i-hugeicons-laptop text-yellow-400"
                                    : "i-hugeicons-help-circle text-gray-400"
                              }`} />
                              <div class="text-left flex-1">
                                <div class="font-medium text-sm">{device.name}</div>
                                <div class="flex items-center gap-2 text-xs text-muted">
                                  <span>{device.vendor}</span>
                                  <span>•</span>
                                  <span>{getGpuTypeLabel(device)}</span>
                                  <Show when={device.recommended}>
                                    <span class="px-1.5 py-0.5 bg-green-600/20 text-green-400 rounded text-xs">
                                      {t().settings.gpu.recommended}
                                    </span>
                                  </Show>
                                </div>
                              </div>
                              <Show when={settings().selected_gpu === device.id}>
                                <div class="w-5 h-5 bg-blue-500 rounded-full flex items-center justify-center flex-shrink-0">
                                  <i class="i-hugeicons-checkmark-circle-02 w-3 h-3 text-white" />
                                </div>
                              </Show>
                            </div>
                          </button>
                        )}
                      </For>

                      {/* Кнопка обновления */}
                      <button
                        class="btn-ghost text-xs w-full"
                        onClick={loadGpuDevices}
                        disabled={loadingGpu()}
                      >
                        <i class="i-hugeicons-refresh w-3 h-3" />
                        {t().settings.storage.refresh}
                      </button>
                    </div>
                  </Show>
                </div>
              </fieldset>

              {/* Поведение при запуске игры */}
              <fieldset>
                <legend class="text-base font-medium mb-4 inline-flex items-center gap-2">
                  <i class="i-hugeicons-play w-5 h-5" />
                  {t().settings.launchBehavior.title}
                </legend>
                <div class="space-y-4">
                  <p class="text-sm text-muted">{t().settings.launchBehavior.description}</p>
                  <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    {/* Свернуть в трей */}
                    <button
                      type="button"
                      class={`group overflow-hidden rounded-2xl border-2 transition-colors duration-75 p-4 ${
                        settings().launch_behavior === "minimize_to_tray"
                          ? "border-blue-500 bg-blue-500/10"
                          : "border-gray-700 hover:border-gray-500 hover:bg-gray-alpha-50"
                      }`}
                      onClick={() => updateSetting("launch_behavior", "minimize_to_tray")}
                    >
                      <div class="flex items-center gap-3">
                        <i class="i-hugeicons-minimize-01 w-6 h-6 text-blue-400" />
                        <div class="text-left flex-1">
                          <div class="font-medium text-sm">{t().settings.launchBehavior.minimizeToTray}</div>
                          <div class="text-xs text-muted">{t().settings.launchBehavior.minimizeToTrayHint}</div>
                        </div>
                        <Show when={settings().launch_behavior === "minimize_to_tray"}>
                          <div class="w-5 h-5 bg-blue-500 rounded-full flex items-center justify-center flex-shrink-0">
                            <i class="i-hugeicons-checkmark-circle-02 w-3 h-3 text-white" />
                          </div>
                        </Show>
                      </div>
                    </button>

                    {/* Оставить открытым */}
                    <button
                      type="button"
                      class={`group overflow-hidden rounded-2xl border-2 transition-colors duration-75 p-4 ${
                        settings().launch_behavior === "keep_open"
                          ? "border-blue-500 bg-blue-500/10"
                          : "border-gray-700 hover:border-gray-500 hover:bg-gray-alpha-50"
                      }`}
                      onClick={() => updateSetting("launch_behavior", "keep_open")}
                    >
                      <div class="flex items-center gap-3">
                        <i class="i-hugeicons-browser w-6 h-6 text-green-400" />
                        <div class="text-left flex-1">
                          <div class="font-medium text-sm">{t().settings.launchBehavior.keepOpen}</div>
                          <div class="text-xs text-muted">{t().settings.launchBehavior.keepOpenHint}</div>
                        </div>
                        <Show when={settings().launch_behavior === "keep_open"}>
                          <div class="w-5 h-5 bg-blue-500 rounded-full flex items-center justify-center flex-shrink-0">
                            <i class="i-hugeicons-checkmark-circle-02 w-3 h-3 text-white" />
                          </div>
                        </Show>
                      </div>
                    </button>

                    {/* Закрыть */}
                    <button
                      type="button"
                      class={`group overflow-hidden rounded-2xl border-2 transition-colors duration-75 p-4 ${
                        settings().launch_behavior === "close"
                          ? "border-blue-500 bg-blue-500/10"
                          : "border-gray-700 hover:border-gray-500 hover:bg-gray-alpha-50"
                      }`}
                      onClick={() => updateSetting("launch_behavior", "close")}
                    >
                      <div class="flex items-center gap-3">
                        <i class="i-hugeicons-cancel-01 w-6 h-6 text-red-400" />
                        <div class="text-left flex-1">
                          <div class="font-medium text-sm">{t().settings.launchBehavior.close}</div>
                          <div class="text-xs text-muted">{t().settings.launchBehavior.closeHint}</div>
                        </div>
                        <Show when={settings().launch_behavior === "close"}>
                          <div class="w-5 h-5 bg-blue-500 rounded-full flex items-center justify-center flex-shrink-0">
                            <i class="i-hugeicons-checkmark-circle-02 w-3 h-3 text-white" />
                          </div>
                        </Show>
                      </div>
                    </button>
                  </div>
                </div>
              </fieldset>

              {/* Моды */}
              <fieldset>
                <legend class="text-base font-medium mb-4 inline-flex items-center gap-2">
                  <i class="i-hugeicons-package w-5 h-5" />
                  {t().settings.mods.title}
                </legend>
                <div class="flex items-center justify-between">
                  <span class="text-sm">{t().settings.mods.autoUpdate}</span>
                  <Toggle
                    checked={settings().auto_update_mods}
                    onChange={(checked) => updateSetting("auto_update_mods", checked)}
                  />
                </div>
              </fieldset>

              {/* Загрузки */}
              <fieldset>
                <legend class="text-base font-medium mb-4 inline-flex items-center gap-2">
                  <i class="i-hugeicons-download-02 w-5 h-5" />
                  {t().settings.downloads.title}
                </legend>
                <div class="space-y-4">
                  <div>
                    <label class="block text-sm font-medium mb-2">
                      {t().settings.downloads.threads}: {settings().download_threads}
                    </label>
                    <input
                      type="range"
                      min="1"
                      max="8"
                      step="1"
                      value={settings().download_threads}
                      onInput={(e) => updateSetting("download_threads", Number(e.currentTarget.value))}
                      class="w-full"
                    />
                  </div>
                  <div>
                    <label class="block text-sm font-medium mb-2">
                      {t().settings.downloads.maxConcurrent}: {settings().max_concurrent_downloads}
                    </label>
                    <input
                      type="range"
                      min="1"
                      max="16"
                      step="1"
                      value={settings().max_concurrent_downloads}
                      onInput={(e) => updateSetting("max_concurrent_downloads", Number(e.currentTarget.value))}
                      class="w-full"
                    />
                  </div>
                  <div>
                    <label class="block text-sm font-medium mb-2">
                      {t().settings.downloads.bandwidthLimit}: {settings().bandwidth_limit === 0 ? t().settings.downloads.unlimited : `${Math.round(settings().bandwidth_limit / 1_000_000)} MB/s`}
                    </label>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      step="1"
                      value={Math.round(settings().bandwidth_limit / 1_000_000)}
                      onInput={(e) => {
                        const val = Number(e.currentTarget.value);
                        updateSetting("bandwidth_limit", val * 1_000_000);
                      }}
                      class="w-full"
                    />
                    <p class="text-xs text-gray-400 mt-1">{t().settings.downloads.bandwidthHint}</p>
                  </div>
                </div>
              </fieldset>

              {/* Авторизация */}
              <fieldset>
                <legend class="text-base font-medium mb-4 inline-flex items-center gap-2">
                  <i class="i-hugeicons-lock w-5 h-5" />
                  {t().settings.auth.title}
                </legend>
                <div class="space-y-4">
                  <div>
                    <label class="block text-sm font-medium mb-2">{t().settings.auth.type}</label>
                    <Select
                      value={settings().auth_type}
                      onChange={(val) => updateSetting("auth_type", val)}
                      options={[
                        { value: "offline", label: t().settings.auth.offline },
                        { value: "ely_by", label: t().settings.auth.elyBy },
                        { value: "microsoft", label: t().settings.auth.microsoft },
                      ]}
                    />
                  </div>
                  <Show when={settings().auth_type === "ely_by"}>
                    <div class="space-y-3 p-3 bg-blue-600/10 border border-blue-600/30 rounded-2xl">
                      <div>
                        <label class="block text-sm font-medium mb-2">
                          {t().settings.auth.elyByServer}
                        </label>
                        <input
                          type="url"
                          value={settings().ely_by_server_url || ""}
                          onInput={(e) => updateSetting("ely_by_server_url", e.currentTarget.value || null)}
                          placeholder="https://authserver.ely.by"
                          class="input w-full"
                        />
                      </div>
                    </div>
                  </Show>
                </div>
              </fieldset>

              {/* Бэкапы */}
              <fieldset>
                <legend class="text-base font-medium mb-4 inline-flex items-center gap-2">
                  <i class="i-hugeicons-floppy-disk w-5 h-5" />
                  {t().backup.title}
                </legend>
                <div class="space-y-4">
                  {/* Включить/выключить бэкапы */}
                  <div class="flex items-center justify-between">
                    <div>
                      <div class="text-sm font-medium">{t().backup.enabled}</div>
                      <div class="text-xs text-gray-400">{t().backup.enabledDescription}</div>
                    </div>
                    <Toggle
                      checked={settings().backup_enabled}
                      onChange={(checked) => updateSetting("backup_enabled", checked)}
                    />
                  </div>

                  <Show when={settings().backup_enabled}>
                    {/* Максимум бэкапов */}
                    <div>
                      <div class="flex items-center justify-between mb-2">
                        <div>
                          <div class="text-sm font-medium">{t().backup.maxCount}</div>
                          <div class="text-xs text-gray-400">{t().backup.maxCountDescription}</div>
                        </div>
                        <span class="text-sm font-mono bg-gray-alpha-50 px-2 py-1 rounded">
                          {settings().backup_max_count}
                        </span>
                      </div>
                      <input
                        type="range"
                        min="1"
                        max="20"
                        value={settings().backup_max_count}
                        onInput={(e) => updateSetting("backup_max_count", Number(e.currentTarget.value))}
                        class="w-full"
                      />
                    </div>

                    {/* Включать saves */}
                    <div class="flex items-center justify-between">
                      <div>
                        <div class="text-sm font-medium">{t().backup.includeSaves}</div>
                        <div class="text-xs text-gray-400">{t().backup.includeSavesDescription}</div>
                      </div>
                      <Toggle
                        checked={settings().backup_include_saves}
                        onChange={(checked) => updateSetting("backup_include_saves", checked)}
                      />
                    </div>
                  </Show>
                </div>
              </fieldset>

              {/* Хранилище */}
              <fieldset>
                <legend class="text-base font-medium mb-4 inline-flex items-center gap-2">
                  <i class="i-hugeicons-folder-01 w-5 h-5" />
                  {t().settings.storage.title}
                </legend>
                <div class="space-y-4">
                  {/* Кнопка загрузки информации */}
                  <Show when={!storageInfo()}>
                    <button
                      class="btn-secondary w-full"
                      onClick={loadStorageInfo}
                      disabled={loadingStorage()}
                    >
                      <Show when={loadingStorage()} fallback={
                        <>
                          <i class="i-hugeicons-analytics-01 w-4 h-4" />
                          {t().settings.storage.calculate}
                        </>
                      }>
                        <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                        {t().settings.storage.calculating}
                      </Show>
                    </button>
                  </Show>

                  {/* Информация о размерах */}
                  <Show when={storageInfo()}>
                    <div class="space-y-3">
                      {/* Общий размер */}
                      <div class="p-3 bg-purple-600/10 border border-purple-600/30 rounded-2xl">
                        <div class="flex items-center justify-between">
                          <span class="text-sm font-medium">{t().settings.storage.totalUsed}</span>
                          <span class="text-lg font-bold text-purple-400">
                            {formatSize(storageInfo()!.total_size)}
                          </span>
                        </div>
                      </div>

                      {/* Разбивка по категориям */}
                      <div class="grid grid-cols-2 gap-2 text-sm">
                        <div class="p-2 bg-gray-alpha-50 rounded-2xl flex justify-between">
                          <span class="text-muted">{t().settings.storage.instances}</span>
                          <span>{formatSize(storageInfo()!.instances_size)}</span>
                        </div>
                        <div class="p-2 bg-gray-alpha-50 rounded-2xl flex justify-between">
                          <span class="text-muted">{t().settings.storage.shared}</span>
                          <span>{formatSize(storageInfo()!.shared_size)}</span>
                        </div>
                        <div class="p-2 bg-gray-alpha-50 rounded-2xl flex justify-between">
                          <span class="text-muted">{t().settings.storage.libraries}</span>
                          <span>{formatSize(storageInfo()!.libraries_size)}</span>
                        </div>
                        <div class="p-2 bg-gray-alpha-50 rounded-2xl flex justify-between">
                          <span class="text-muted">{t().settings.storage.assets}</span>
                          <span>{formatSize(storageInfo()!.assets_size)}</span>
                        </div>
                        <div class="p-2 bg-gray-alpha-50 rounded-2xl flex justify-between">
                          <span class="text-muted">{t().settings.storage.versions}</span>
                          <span>{formatSize(storageInfo()!.versions_size)}</span>
                        </div>
                        <div class="p-2 bg-gray-alpha-50 rounded-2xl flex justify-between">
                          <span class="text-muted">{t().settings.storage.javaTotal}</span>
                          <span>{formatSize(storageInfo()!.java_size)}</span>
                        </div>
                        <div class="p-2 bg-gray-alpha-50 rounded-2xl flex justify-between">
                          <span class="text-muted">{t().settings.storage.cache}</span>
                          <span>{formatSize(storageInfo()!.cache_size)}</span>
                        </div>
                        <div class="p-2 bg-gray-alpha-50 rounded-2xl flex justify-between">
                          <span class="text-muted">{t().settings.storage.logs}</span>
                          <span>{formatSize(storageInfo()!.logs_size)}</span>
                        </div>
                      </div>

                      {/* Размер экземпляров */}
                      <Show when={storageInfo()!.instances.length > 0}>
                        <div class="border-t border-gray-700 pt-3">
                          <p class="text-sm font-medium mb-2">{t().settings.storage.byInstances}</p>
                          <div class="space-y-1 max-h-32 overflow-y-auto">
                            <For each={storageInfo()!.instances}>
                              {(inst) => (
                                <div class="flex items-center gap-2 text-sm p-1.5 bg-gray-alpha-30 rounded-2xl hover:bg-gray-alpha-50 transition-fast">
                                  <button
                                    class="btn-ghost btn-xs flex-shrink-0 p-1"
                                    onClick={() => invoke("open_instance_folder", { id: inst.id }).catch(() => {})}
                                    title={t().settings.storage.openFolder}
                                  >
                                    <i class="i-hugeicons-folder-01 w-3 h-3" />
                                  </button>
                                  <span class="truncate flex-1 text-muted" title={inst.path}>{inst.id}</span>
                                  <span class="flex-shrink-0">{formatSize(inst.size)}</span>
                                </div>
                              )}
                            </For>
                          </div>
                        </div>
                      </Show>

                      {/* Кнопка обновления */}
                      <button
                        class="btn-ghost text-xs w-full"
                        onClick={loadStorageInfo}
                        disabled={loadingStorage()}
                      >
                        <i class="i-hugeicons-refresh w-3 h-3" />
                        {t().settings.storage.refresh}
                      </button>
                    </div>
                  </Show>

                  {/* Очистка */}
                  <div class="flex gap-2">
                    <button
                      class="btn-secondary flex-1"
                      onClick={handleClearCache}
                      disabled={clearingCache()}
                    >
                      <Show when={clearingCache()} fallback={
                        <>
                          <i class="i-hugeicons-delete-02 w-4 h-4" />
                          {t().settings.storage.clearCache}
                        </>
                      }>
                        <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                      </Show>
                    </button>
                    <button
                      class="btn-secondary flex-1"
                      onClick={handleClearLogs}
                      disabled={clearingLogs()}
                    >
                      <Show when={clearingLogs()} fallback={
                        <>
                          <i class="i-hugeicons-file-01 w-4 h-4" />
                          {t().settings.storage.clearLogs}
                        </>
                      }>
                        <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                      </Show>
                    </button>
                  </div>

                  {/* Управление Java версиями */}
                  <div class="border-t border-gray-700 pt-4 mt-4">
                    <div class="flex items-center justify-between mb-3">
                      <div>
                        <p class="text-sm font-medium">{t().settings.storage.java.title}</p>
                        <p class="text-xs text-muted">{t().settings.storage.java.description}</p>
                      </div>
                      <button
                        class="btn-ghost btn-sm"
                        onClick={loadSharedResources}
                        disabled={loadingSharedResources()}
                      >
                        <Show when={loadingSharedResources()} fallback={
                          <i class="i-hugeicons-search-01 w-4 h-4" />
                        }>
                          <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                        </Show>
                        {t().settings.storage.java.analyze}
                      </button>
                    </div>

                    <Show when={sharedResources()}>
                      {(resources) => {
                        const unusedJava = () => resources().java_versions.filter(j => !j.is_used);
                        const unusedSize = () => unusedJava().reduce((sum, j) => sum + j.size, 0);

                        return (
                          <>
                            {/* Статистика общих ресурсов */}
                            <div class="grid grid-cols-2 gap-2 text-xs mb-3">
                              <div class="p-2 bg-gray-alpha-30 rounded-2xl inline-flex items-center gap-1">
                                <span class="text-muted">{t().settings.storage.libraries}:</span>
                                <span>{resources().libraries_count} ({formatSize(resources().libraries_size)})</span>
                              </div>
                              <div class="p-2 bg-gray-alpha-30 rounded-2xl inline-flex items-center gap-1">
                                <span class="text-muted">{t().settings.storage.assets}:</span>
                                <span>{resources().assets_indexes_count} ({formatSize(resources().assets_size)})</span>
                              </div>
                              <div class="p-2 bg-gray-alpha-30 rounded-2xl inline-flex items-center gap-1">
                                <span class="text-muted">{t().settings.storage.versions}:</span>
                                <span>{resources().versions_count} ({formatSize(resources().versions_size)})</span>
                              </div>
                              <div class="p-2 bg-gray-alpha-30 rounded-2xl inline-flex items-center gap-1">
                                <span class="text-muted">{t().settings.storage.java.versions}:</span>
                                <span>{resources().java_versions.length}</span>
                              </div>
                            </div>

                            {/* Список Java версий */}
                            <Show when={resources().java_versions.length > 0}>
                              <div class="space-y-2">
                                <div class="flex items-center justify-between">
                                  <span class="text-sm font-medium">{t().settings.storage.java.installedVersions}</span>
                                  <Show when={unusedJava().length > 0}>
                                    <button
                                      class="btn-secondary btn-sm text-orange-400 border-orange-600/50 hover:bg-orange-600/20"
                                      onClick={handleCleanupAllUnusedJava}
                                      disabled={cleaningJava() !== null}
                                    >
                                      <Show when={cleaningJava() === "all"} fallback={
                                        <>
                                          <i class="i-hugeicons-delete-02 w-3 h-3" />
                                          {t().settings.storage.java.cleanupAll} ({formatSize(unusedSize())})
                                        </>
                                      }>
                                        <i class="i-svg-spinners-6-dots-scale w-3 h-3" />
                                      </Show>
                                    </button>
                                  </Show>
                                </div>

                                <div class="space-y-1 max-h-40 overflow-y-auto">
                                  <For each={resources().java_versions}>
                                    {(java) => (
                                      <div class={`flex items-center justify-between text-sm p-2 rounded-2xl ${java.is_used ? 'bg-green-600/10 border border-green-600/20' : 'bg-orange-600/10 border border-orange-600/20'}`}>
                                        <div class="flex-1 min-w-0">
                                          <div class="flex items-center gap-2">
                                            <i class={`w-4 h-4 ${java.is_used ? 'i-hugeicons-checkmark-circle-02 text-green-400' : 'i-hugeicons-alert-02 text-orange-400'}`} />
                                            <span class="font-medium">Java {java.version}</span>
                                            <span class="text-xs text-muted">({formatSize(java.size)})</span>
                                          </div>
                                          <Show when={java.is_used && java.used_by_instances.length > 0}>
                                            <div class="text-xs text-muted mt-0.5 ml-6 truncate" title={java.used_by_instances.join(", ")}>
                                              {t().settings.storage.java.usedBy}: {java.used_by_instances.slice(0, 3).join(", ")}
                                              <Show when={java.used_by_instances.length > 3}>
                                                ... +{java.used_by_instances.length - 3}
                                              </Show>
                                            </div>
                                          </Show>
                                          <Show when={!java.is_used}>
                                            <div class="text-xs text-orange-400 mt-0.5 ml-6">
                                              {t().settings.storage.java.notUsed}
                                            </div>
                                          </Show>
                                        </div>
                                        <Show when={!java.is_used}>
                                          <button
                                            class="btn-ghost btn-sm text-red-400 hover:bg-red-600/20 flex-shrink-0"
                                            onClick={() => handleCleanupJavaVersion(java.version)}
                                            disabled={cleaningJava() !== null}
                                            title={t().common.delete}
                                          >
                                            <Show when={cleaningJava() === java.version} fallback={
                                              <i class="i-hugeicons-delete-02 w-4 h-4" />
                                            }>
                                              <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                                            </Show>
                                          </button>
                                        </Show>
                                      </div>
                                    )}
                                  </For>
                                </div>
                              </div>
                            </Show>

                            {/* Подсказка если нет неиспользуемых ресурсов */}
                            <Show when={resources().total_unused_size === 0 && resources().java_versions.every(j => j.is_used)}>
                              <div class="p-3 bg-green-600/10 border border-green-600/30 rounded-2xl text-sm text-green-400 text-center inline-flex items-center justify-center gap-1">
                                <i class="i-hugeicons-checkmark-circle-02 w-4 h-4" />
                                {t().settings.storage.java.allUsed}
                              </div>
                            </Show>
                          </>
                        );
                      }}
                    </Show>
                  </div>

                  {/* Мёртвые папки */}
                  <div class="border-t border-gray-700 pt-4 mt-4">
                    <div class="flex items-center justify-between mb-3">
                      <div>
                        <p class="text-sm font-medium">{t().settings.storage.orphaned.title}</p>
                        <p class="text-xs text-muted">{t().settings.storage.orphaned.description}</p>
                      </div>
                      <button
                        class="btn-ghost btn-sm"
                        onClick={loadOrphanedFolders}
                        disabled={loadingOrphaned()}
                      >
                        <Show when={loadingOrphaned()} fallback={
                          <i class="i-hugeicons-search-01 w-4 h-4" />
                        }>
                          <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                        </Show>
                        {t().settings.storage.orphaned.check}
                      </button>
                    </div>

                    <Show when={orphanedFolders().length > 0}>
                      <div class="p-3 bg-orange-600/10 border border-orange-600/30 rounded-2xl space-y-3">
                        <div class="flex items-center justify-between">
                          <span class="text-sm text-orange-400">
                            {t().settings.storage.orphaned.found}: {orphanedFolders().length} ({formatSize(orphanedFolders().reduce((s, f) => s + f.size, 0))})
                          </span>
                          <button
                            class="btn-secondary btn-sm text-orange-400 border-orange-600/50 hover:bg-orange-600/20"
                            onClick={handleDeleteAllOrphaned}
                            disabled={deletingOrphaned()}
                          >
                            <Show when={deletingOrphaned()} fallback={
                              <>
                                <i class="i-hugeicons-delete-02 w-3 h-3" />
                                {t().settings.storage.orphaned.deleteAll}
                              </>
                            }>
                              <i class="i-svg-spinners-6-dots-scale w-3 h-3" />
                            </Show>
                          </button>
                        </div>

                        <div class="space-y-1 max-h-32 overflow-y-auto">
                          <For each={orphanedFolders()}>
                            {(folder) => (
                              <div class="flex items-center justify-between text-sm p-1.5 bg-gray-alpha-30 rounded-2xl">
                                <div class="flex-1 min-w-0">
                                  <span class="truncate block" title={folder.path}>{folder.name}</span>
                                  <span class="text-xs text-muted">{formatSize(folder.size)}</span>
                                </div>
                                <button
                                  class="btn-ghost btn-sm text-red-400 hover:bg-red-600/20 flex-shrink-0"
                                  onClick={() => handleDeleteOrphaned(folder.path)}
                                  title={t().common.delete}
                                >
                                  <i class="i-hugeicons-delete-02 w-3 h-3" />
                                </button>
                              </div>
                            )}
                          </For>
                        </div>
                      </div>
                    </Show>
                  </div>
                </div>
              </fieldset>

              {/* Папки приложения */}
              <fieldset>
                <legend class="text-base font-medium mb-4 inline-flex items-center gap-2">
                  <i class="i-hugeicons-folder-open w-5 h-5" />
                  {t().settings.folders.title}
                </legend>
                <Show when={appPaths()}>
                  <div class="space-y-2">
                    <For each={[
                      { key: "base", label: t().settings.folders.base, path: appPaths()!.base },
                      { key: "instances", label: t().settings.folders.instances, path: appPaths()!.instances },
                      { key: "shared", label: t().settings.folders.shared, path: appPaths()!.shared },
                      { key: "java", label: t().settings.folders.java, path: appPaths()!.java },
                      { key: "cache", label: t().settings.folders.cache, path: appPaths()!.cache },
                      { key: "logs", label: t().settings.folders.logs, path: appPaths()!.logs },
                    ]}>
                      {(item) => (
                        <div class="flex items-center gap-2 p-2 bg-gray-alpha-30 rounded-2xl hover:bg-gray-alpha-50 transition-fast">
                          <button
                            class="btn-ghost btn-sm flex-shrink-0"
                            onClick={() => openFolder(item.key)}
                            title={t().settings.folders.openFolder}
                          >
                            <i class="i-hugeicons-folder-01 w-4 h-4" />
                          </button>
                          <div class="flex-1 min-w-0">
                            <p class="text-sm font-medium">{item.label}</p>
                            <p class="text-xs text-muted truncate" title={item.path}>{item.path}</p>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </fieldset>
            </div>
          </Show>
        </div>

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
          <div class="flex gap-2">
            <button
              type="button"
              class="btn-secondary"
              onClick={() => props.onClose?.()}
              disabled={saving()}
            >
              {t().common.cancel}
            </button>
            <button
              type="button"
              class="btn-primary"
              onClick={handleSave}
              disabled={saving() || loading()}
            >
              <Show when={saving()} fallback={
                <>
                  <i class="i-hugeicons-checkmark-circle-02 w-4 h-4" />
                  {t().settings.actions.save}
                </>
              }>
                <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                {t().settings.actions.saving}
              </Show>
            </button>
          </div>
        </div>
      </div>

      {/* Confirm Dialog */}
      <ConfirmDialogComponent />
    </div>
  );
}