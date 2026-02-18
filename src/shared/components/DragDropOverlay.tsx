import { Show, For, createMemo, createSignal, createEffect } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { useDragDrop, type DroppedFile } from "../stores/dragDrop";
import { useI18n } from "../i18n";

/** Verification result from backend */
interface ModVerificationResult {
  verified: boolean;
  platform: string;
  project_name: string | null;
  project_slug: string | null;
  version: string | null;
  mod_id: string | null;
}

/** Batch verification result from backend */
interface BatchVerificationResult {
  file_path: string;
  result: ModVerificationResult;
}

/** Map of file path -> verification result */
type VerificationMap = Map<string, ModVerificationResult | "loading" | "error">;

interface DragDropTranslations {
  mixedFiles: string;
  mixedFilesDesc: string;
  manifestDesc: string;
  mod: string;
  mods: string;
  modDesc: string;
  modpackStuzhik: string;
  modpackModrinth: string;
  modpackDesc: string;
  archive: string;
  archives: string;
  archiveDesc: string;
  resources: string;
  resourcesDesc: string;
  unsupportedFormat: string;
  unsupportedDesc: string;
}

/** Определяет тип файла и соответствующую иконку/цвет */
function getFileTypeInfo(files: DroppedFile[], tr: DragDropTranslations): {
  type: "mod" | "modpack" | "modpack-manifest" | "resource" | "mixed" | "unknown";
  icon: string;
  color: string;
  bgColor: string;
  borderColor: string;
  title: string;
  description: string;
  format?: "modrinth" | "curseforge";
} {
  const extensions = files.map((f) => f.extension);
  const uniqueExts = [...new Set(extensions)];

  // FIRST: Check for mixed types - multiple different extensions
  if (uniqueExts.length > 1) {
    return {
      type: "mixed",
      icon: "i-hugeicons-layers-01",
      color: "text-yellow-400",
      bgColor: "bg-yellow-600/20",
      borderColor: "border-yellow-500",
      title: tr.mixedFiles,
      description: tr.mixedFilesDesc,
    };
  }

  // Single extension type from here
  const ext = uniqueExts[0];

  // Manifest files (Modrinth/CurseForge JSON) - single file only
  if (ext === "json" && files.length === 1) {
    const name = files[0].name.toLowerCase();

    if (name === "modrinth.index.json") {
      return {
        type: "modpack-manifest",
        icon: "i-hugeicons-file-01",
        color: "text-green-400",
        bgColor: "bg-green-600/20",
        borderColor: "border-green-500",
        title: "Modrinth Manifest",
        description: tr.manifestDesc,
        format: "modrinth",
      };
    }

    if (name === "manifest.json") {
      return {
        type: "modpack-manifest",
        icon: "i-hugeicons-file-01",
        color: "text-orange-400",
        bgColor: "bg-orange-600/20",
        borderColor: "border-orange-500",
        title: "CurseForge Manifest",
        description: tr.manifestDesc,
        format: "curseforge",
      };
    }
  }

  // Моды - all .jar files
  if (ext === "jar") {
    return {
      type: "mod",
      icon: "i-hugeicons-package",
      color: "text-blue-400",
      bgColor: "bg-blue-600/20",
      borderColor: "border-blue-500",
      title: files.length === 1 ? tr.mod : tr.mods.replace("{count}", String(files.length)),
      description: tr.modDesc,
    };
  }

  // Модпаки .stzhk - single file only
  if (ext === "stzhk" && files.length === 1) {
    return {
      type: "modpack",
      icon: "i-hugeicons-folder-01",
      color: "text-cyan-400",
      bgColor: "bg-cyan-600/20",
      borderColor: "border-cyan-500",
      title: tr.modpackStuzhik,
      description: tr.modpackDesc,
    };
  }

  // Модпаки .mrpack - single file only
  if (ext === "mrpack" && files.length === 1) {
    return {
      type: "modpack",
      icon: "i-hugeicons-folder-01",
      color: "text-green-400",
      bgColor: "bg-green-600/20",
      borderColor: "border-green-500",
      title: tr.modpackModrinth,
      description: tr.modpackDesc,
    };
  }

  // Zip files (может быть модпак CurseForge или ресурспак)
  if (ext === "zip") {
    return {
      type: "modpack",
      icon: "i-hugeicons-folder-01",
      color: "text-orange-400",
      bgColor: "bg-orange-600/20",
      borderColor: "border-orange-500",
      title: files.length === 1 ? tr.archive : tr.archives.replace("{count}", String(files.length)),
      description: tr.archiveDesc,
    };
  }

  // Ресурспаки/шейдеры (images)
  if (["png", "jpg", "jpeg"].includes(ext)) {
    return {
      type: "resource",
      icon: "i-hugeicons-image-02",
      color: "text-purple-400",
      bgColor: "bg-purple-600/20",
      borderColor: "border-purple-500",
      title: tr.resources,
      description: tr.resourcesDesc,
    };
  }

  // Неизвестный тип
  return {
    type: "unknown",
    icon: "i-hugeicons-file-01",
    color: "text-gray-400",
    bgColor: "bg-gray-600/20",
    borderColor: "border-gray-500",
    title: tr.unsupportedFormat,
    description: tr.unsupportedDesc,
  };
}

export function DragDropOverlay() {
  const { t } = useI18n();
  const { isDragging, draggedFiles, isInDetailView } = useDragDrop();

  // Create translations object for getFileTypeInfo
  const translations = createMemo((): DragDropTranslations => ({
    mixedFiles: t().dragDrop?.mixedFiles ?? "Mixed files",
    mixedFilesDesc: t().dragDrop?.mixedFilesDesc ?? "Drop files of the same type",
    manifestDesc: t().dragDrop?.manifestDesc ?? "An instance will be created and all mods downloaded",
    mod: t().dragDrop?.mod ?? "Mod",
    mods: t().dragDrop?.mods ?? "{count} mods",
    modDesc: t().dragDrop?.modDesc ?? "Drag to an instance in the list or open one",
    modpackStuzhik: t().dragDrop?.modpackStuzhik ?? "Stuzhik Modpack",
    modpackModrinth: t().dragDrop?.modpackModrinth ?? "Modrinth Modpack",
    modpackDesc: t().dragDrop?.modpackDesc ?? "Modpack browser will open for import",
    archive: t().dragDrop?.archive ?? "Archive",
    archives: t().dragDrop?.archives ?? "{count} archives",
    archiveDesc: t().dragDrop?.archiveDesc ?? "CurseForge modpack or resource pack",
    resources: t().dragDrop?.resources ?? "Resources",
    resourcesDesc: t().dragDrop?.resourcesDesc ?? "Resource packs or textures",
    unsupportedFormat: t().dragDrop?.unsupportedFormat ?? "Unsupported format",
    unsupportedDesc: t().dragDrop?.unsupportedDesc ?? "Supported: .jar, .stzhk, .mrpack, .zip, manifest.json",
  }));

  const fileInfo = createMemo(() => getFileTypeInfo(draggedFiles(), translations()));
  const isSupported = createMemo(() =>
    fileInfo().type !== "unknown" && fileInfo().type !== "mixed"
  );
  const isMod = createMemo(() => fileInfo().type === "mod");

  // Verification state for JAR files
  const [verifications, setVerifications] = createSignal<VerificationMap>(new Map());

  // Trigger batch verification when JAR files are dragged
  createEffect(() => {
    const files = draggedFiles();
    const dragging = isDragging();

    if (!dragging || files.length === 0) {
      setVerifications(new Map());
      return;
    }

    const jarFiles = files.filter(f => f.extension === "jar");
    if (jarFiles.length === 0) return;

    // Mark all as loading initially
    const newMap = new Map<string, ModVerificationResult | "loading" | "error">();
    jarFiles.forEach(f => newMap.set(f.path, "loading"));
    setVerifications(newMap);

    // Batch verify all files (limit to first 10 for performance)
    const filesToVerify = jarFiles.slice(0, 10);
    const filePaths = filesToVerify.map(f => f.path);

    // Single batch API call
    (async () => {
      try {
        const results = await invoke<BatchVerificationResult[]>("verify_mod_files_batch", {
          filePaths,
        });

        // Update all results at once
        setVerifications(prev => {
          const updated = new Map(prev);
          for (const item of results) {
            updated.set(item.file_path, item.result);
          }
          return updated;
        });
      } catch (err) {
        if (import.meta.env.DEV) console.error("Batch verification failed:", err);
        // Mark all as error
        setVerifications(prev => {
          const updated = new Map(prev);
          for (const path of filePaths) {
            updated.set(path, "error");
          }
          return updated;
        });
      }
    })();
  });

  // Get verification status icon and color for a file
  const getVerificationDisplay = (file: DroppedFile) => {
    const verification = verifications().get(file.path);
    if (!verification || verification === "loading") {
      return { icon: "i-svg-spinners-ring-resize", color: "text-gray-400", label: t().dragDrop?.verifying ?? "Verifying..." };
    }
    if (verification === "error") {
      return { icon: "i-hugeicons-alert-02", color: "text-yellow-400", label: t().dragDrop?.verifyFailed ?? "Failed to verify" };
    }
    if (verification.verified) {
      const platformIcon = verification.platform === "modrinth"
        ? "i-simple-icons-modrinth"
        : verification.platform === "curseforge"
        ? "i-simple-icons-curseforge"
        : "i-hugeicons-checkmark-circle-02";
      const platformColor = verification.platform === "modrinth"
        ? "text-green-400"
        : verification.platform === "curseforge"
        ? "text-orange-400"
        : "text-green-400";
      return {
        icon: platformIcon,
        color: platformColor,
        label: verification.project_name || verification.platform,
      };
    }
    return { icon: "i-hugeicons-alert-02", color: "text-yellow-400", label: t().dragDrop?.notFoundOnPlatforms ?? "Not found on platforms" };
  };

  // Summary of verification results
  const verificationSummary = createMemo(() => {
    const vers = verifications();
    if (vers.size === 0) return null;

    let verified = 0;
    let loading = 0;
    let unknown = 0;
    let modrinth = 0;
    let curseforge = 0;

    vers.forEach(v => {
      if (v === "loading") loading++;
      else if (v === "error") unknown++;
      else if (v.verified) {
        verified++;
        if (v.platform === "modrinth") modrinth++;
        if (v.platform === "curseforge") curseforge++;
      } else {
        unknown++;
      }
    });

    return { verified, loading, unknown, modrinth, curseforge, total: vers.size };
  });

  // Determine what to show based on file type and context
  const showModBanner = createMemo(() => isMod() && !isInDetailView());
  const showModDetailOverlay = createMemo(() => isMod() && isInDetailView());

  // Для модов:
  // - если в списке: показываем компактный баннер сверху
  // - если в detail view: показываем оверлей "отпустите для установки"
  // Для остальных файлов - полноэкранный оверлей
  return (
    <Show when={isDragging()}>
      {/* Мод в detail view - специальный оверлей */}
      <Show when={showModDetailOverlay()}>
        <div class="fixed inset-0 z-[200] pointer-events-none flex items-center justify-center bg-black/50 backdrop-blur-sm transition-opacity duration-150">
          <div class="border-2 border-dashed border-[var(--color-primary)] rounded-2xl p-8 max-w-md bg-[var(--color-bg-modal)] shadow-2xl">
            <div class="flex flex-col items-center gap-4">
              <div class="w-20 h-20 rounded-full bg-[var(--color-primary-bg)] flex items-center justify-center">
                <i class="i-hugeicons-package w-10 h-10 text-[var(--color-primary)]" />
              </div>
              <h3 class="text-xl font-semibold text-[var(--color-text)]">
                {fileInfo().title}
              </h3>

              {/* Verification status summary */}
              <Show when={verificationSummary()}>
                {(summary) => (
                  <div class="flex flex-col items-center gap-2 w-full">
                    <span class="text-xs text-gray-500">{t().dragDrop?.verifyingAuthenticity ?? "Verifying authenticity"}</span>
                    <div class="flex items-center gap-2 flex-wrap justify-center">
                      <Show when={summary().loading > 0}>
                        <div class="flex items-center gap-1.5 bg-gray-700/50 px-3 py-1.5 rounded-full">
                          <i class="i-svg-spinners-ring-resize w-4 h-4 text-gray-400" />
                          <span class="text-gray-300 text-sm">{t().dragDrop?.verifying ?? "Verifying..."}</span>
                        </div>
                      </Show>
                      <Show when={summary().modrinth > 0}>
                        <div class="flex items-center gap-1.5 bg-green-600/20 px-3 py-1.5 rounded-full">
                          <i class="i-simple-icons-modrinth w-4 h-4 text-green-400" />
                          <span class="text-green-300 text-sm">{summary().modrinth} Modrinth</span>
                        </div>
                      </Show>
                      <Show when={summary().curseforge > 0}>
                        <div class="flex items-center gap-1.5 bg-orange-600/20 px-3 py-1.5 rounded-full">
                          <i class="i-simple-icons-curseforge w-4 h-4 text-orange-400" />
                          <span class="text-orange-300 text-sm">{summary().curseforge} CurseForge</span>
                        </div>
                      </Show>
                      <Show when={summary().unknown > 0}>
                        <div class="flex items-center gap-1.5 bg-yellow-600/20 px-3 py-1.5 rounded-full">
                          <i class="i-hugeicons-alert-02 w-4 h-4 text-yellow-400" />
                          <span class="text-yellow-300 text-sm">{summary().unknown} {t().dragDrop?.unknown ?? "unknown"}</span>
                        </div>
                      </Show>
                    </div>
                  </div>
                )}
              </Show>

              <p class="text-sm text-gray-400 text-center">
                {t().dragDrop?.modWillBeInstalled ?? "Mod will be installed to current instance"}
              </p>
              <div class="flex items-center gap-2 px-4 py-2 rounded-full bg-[var(--color-primary-bg)] text-[var(--color-primary-light)]">
                <i class="i-hugeicons-arrow-down-01 w-4 h-4 animate-bounce" />
                <span class="text-sm">{t().dragDrop?.releaseToInstall ?? "Release to install"}</span>
              </div>
            </div>
          </div>
        </div>
      </Show>

      {/* Остальные случаи */}
      <Show when={!showModDetailOverlay()}>
      <Show
        when={showModBanner()}
        fallback={
          // Полноэкранный оверлей для модпаков и прочих файлов (не для модов в detail view)
          <div class="fixed inset-0 z-[200] pointer-events-none flex items-center justify-center bg-black/30 backdrop-blur-lg transition-opacity duration-150">
            <div
              class={`border-2 border-dashed rounded-2xl p-8 max-w-md shadow-2xl transition-all duration-150 ${
                isSupported()
                  ? `bg-[var(--color-bg-modal)] ${fileInfo().borderColor}`
                  : "bg-[var(--color-bg-modal)] border-red-500/50"
              }`}
            >
              <div class="flex flex-col items-center gap-4">
                {/* Icon */}
                <div
                  class={`w-20 h-20 rounded-full flex items-center justify-center transition-colors ${
                    isSupported() ? fileInfo().bgColor : "bg-red-600/20"
                  }`}
                >
                  <i
                    class={`w-10 h-10 ${
                      isSupported() ? `${fileInfo().icon} ${fileInfo().color}` : "i-hugeicons-cancel-01 text-red-400"
                    }`}
                  />
                </div>

                {/* Title */}
                <h3
                  class={`text-xl font-semibold ${
                    isSupported() ? "text-[var(--color-text)]" : "text-red-400"
                  }`}
                >
                  {fileInfo().title}
                </h3>

                {/* Description */}
                <p class="text-sm text-gray-400 text-center">
                  {fileInfo().description}
                </p>

                {/* File list */}
                <Show when={draggedFiles().length > 0 && draggedFiles().length <= 5}>
                  <div class="w-full max-h-40 overflow-y-auto space-y-1">
                    <For each={draggedFiles()}>
                      {(file) => {
                        const verifyDisplay = () => file.extension === "jar" ? getVerificationDisplay(file) : null;
                        return (
                          <div class="flex items-center gap-2 py-2 px-3 bg-gray-700/50 rounded-lg">
                            <i
                              class={`w-4 h-4 flex-shrink-0 ${
                                file.extension === "jar"
                                  ? "i-hugeicons-package text-blue-400"
                                  : file.extension === "stzhk"
                                  ? "i-hugeicons-folder-01 text-cyan-400"
                                  : file.extension === "mrpack"
                                  ? "i-hugeicons-folder-01 text-green-400"
                                  : file.extension === "zip"
                                  ? "i-hugeicons-folder-01 text-orange-400"
                                  : file.extension === "json" && file.name.toLowerCase().includes("modrinth")
                                  ? "i-hugeicons-file-01 text-green-400"
                                  : file.extension === "json" && file.name.toLowerCase() === "manifest.json"
                                  ? "i-hugeicons-file-01 text-orange-400"
                                  : "i-hugeicons-file-01 text-gray-400"
                              }`}
                            />
                            <span class="text-sm text-gray-300 truncate flex-1">
                              {file.name}
                            </span>
                            {/* Verification status for JAR files */}
                            <Show when={verifyDisplay()}>
                              {(display) => (
                                <i
                                  class={`w-4 h-4 flex-shrink-0 ${display().icon} ${display().color}`}
                                  title={display().label}
                                />
                              )}
                            </Show>
                            <span
                              class={`text-xs uppercase px-1.5 py-0.5 rounded ${
                                file.extension === "jar"
                                  ? "bg-blue-600/30 text-blue-300"
                                  : file.extension === "stzhk"
                                  ? "bg-cyan-600/30 text-cyan-300"
                                  : file.extension === "mrpack"
                                  ? "bg-green-600/30 text-green-300"
                                  : file.extension === "zip"
                                  ? "bg-orange-600/30 text-orange-300"
                                  : file.extension === "json" && file.name.toLowerCase().includes("modrinth")
                                  ? "bg-green-600/30 text-green-300"
                                  : file.extension === "json" && file.name.toLowerCase() === "manifest.json"
                                  ? "bg-orange-600/30 text-orange-300"
                                  : "bg-gray-600/30 text-gray-400"
                              }`}
                            >
                              {file.extension === "json" && file.name.toLowerCase().includes("modrinth")
                                ? "MR"
                                : file.extension === "json" && file.name.toLowerCase() === "manifest.json"
                                ? "CF"
                                : file.extension}
                            </span>
                          </div>
                        );
                      }}
                    </For>
                  </div>
                </Show>

                {/* Many files hint */}
                <Show when={draggedFiles().length > 5}>
                  <p class="text-xs text-gray-500">
                    {(t().dragDrop?.moreFiles ?? "+{count} more files...").replace("{count}", String(draggedFiles().length - 5))}
                  </p>
                </Show>

                {/* Action hint */}
                <div
                  class={`flex items-center gap-2 px-4 py-2 rounded-full ${
                    isSupported()
                      ? "bg-gray-700/50 text-gray-300"
                      : "bg-red-900/30 text-red-400"
                  }`}
                >
                  <Show
                    when={isSupported()}
                    fallback={
                      <>
                        <i class="i-hugeicons-cancel-01 w-4 h-4" />
                        <span class="text-sm">{t().dragDrop?.releaseToCancel ?? "Release to cancel"}</span>
                      </>
                    }
                  >
                    <i class="i-hugeicons-arrow-down-01 w-4 h-4 animate-bounce" />
                    <span class="text-sm">{t().dragDrop?.releaseToInstall ?? "Release to install"}</span>
                  </Show>
                </div>
              </div>
            </div>
          </div>
        }
      >
        {/* Компактный баннер для модов - не закрывает экземпляры */}
        <div class="fixed top-[var(--titlebar-height)] left-0 right-0 z-[200] pointer-events-none px-4 py-3">
          <div class="max-w-2xl mx-auto backdrop-blur-sm rounded-2xl shadow-2xl border border-[var(--color-primary-border)] px-6 py-4" style={{ "background-color": "color-mix(in srgb, var(--color-primary) 95%, transparent)" }}>
            <div class="flex items-center gap-4">
              {/* Icon */}
              <div class="w-12 h-12 rounded-full bg-white/20 flex items-center justify-center flex-shrink-0">
                <i class="i-hugeicons-package w-6 h-6 text-white" />
              </div>

              {/* Info */}
              <div class="flex-1 min-w-0">
                <h3 class="text-white font-semibold">
                  {fileInfo().title}
                </h3>
                <p class="text-blue-100 text-sm">
                  {t().dragDrop?.dragToInstance ?? "Drag to an instance below"}
                </p>
              </div>

              {/* Verification status summary */}
              <Show when={verificationSummary()}>
                {(summary) => (
                  <div class="flex items-center gap-1.5 flex-shrink-0">
                    <span class="text-white/60 text-xs">{t().dragDrop?.authenticity ?? "Authenticity:"}</span>
                    <Show when={summary().loading > 0}>
                      <div class="flex items-center gap-1 bg-white/20 px-2 py-0.5 rounded-full">
                        <i class="i-svg-spinners-ring-resize w-3.5 h-3.5 text-white" />
                      </div>
                    </Show>
                    <Show when={summary().modrinth > 0}>
                      <div class="flex items-center gap-1 bg-green-500/30 px-2 py-0.5 rounded-full">
                        <i class="i-simple-icons-modrinth w-3.5 h-3.5 text-green-300" />
                        <span class="text-green-200 text-xs">{summary().modrinth}</span>
                      </div>
                    </Show>
                    <Show when={summary().curseforge > 0}>
                      <div class="flex items-center gap-1 bg-orange-500/30 px-2 py-0.5 rounded-full">
                        <i class="i-simple-icons-curseforge w-3.5 h-3.5 text-orange-300" />
                        <span class="text-orange-200 text-xs">{summary().curseforge}</span>
                      </div>
                    </Show>
                    <Show when={summary().unknown > 0}>
                      <div class="flex items-center gap-1 bg-yellow-500/30 px-2 py-0.5 rounded-full">
                        <i class="i-hugeicons-alert-02 w-3.5 h-3.5 text-yellow-300" />
                        <span class="text-yellow-200 text-xs">{summary().unknown}</span>
                      </div>
                    </Show>
                  </div>
                )}
              </Show>

              {/* Files count */}
              <Show when={draggedFiles().length > 1 && !verificationSummary()}>
                <div class="flex-shrink-0 bg-white/20 px-3 py-1.5 rounded-full">
                  <span class="text-white text-sm font-medium">
                    {draggedFiles().length} {t().dragDrop?.files ?? "files"}
                  </span>
                </div>
              </Show>

              {/* Animated arrow */}
              <div class="flex-shrink-0 animate-bounce">
                <i class="i-hugeicons-arrow-down-01 w-6 h-6 text-white" />
              </div>
            </div>
          </div>
        </div>
      </Show>
      </Show>
    </Show>
  );
}
