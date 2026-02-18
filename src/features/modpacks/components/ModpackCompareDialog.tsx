import { createSignal, Show, For, Switch, Match, createMemo } from "solid-js";
import type { Component } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import {
  STZHK_FORMAT_VERSION,
  type ModpackComparison, type ModInfo, type ModVersionDiff,
  type Instance, type ModSearchInfo, type CompareSourceType, type ModpackSearchResult, type ModpackVersionInfo,
  type ModpackPatch, type PatchModAdd, type PatchModRemove, type PatchConfigAdd, type PatchChanges, type PatchBaseInfo
} from "../../../shared/types";
import { useI18n } from "../../../shared/i18n";
import { createFocusTrap } from "../../../shared/hooks";
import { Tabs, Tooltip } from "../../../shared/ui";
import { formatSize } from "../../../shared/utils/format-size";
import { ModDownloadSearch } from "./ModDownloadSearch";
import { CompareModList, type DownloadState } from "./CompareModList";
import { CompareSourceSelector } from "./CompareSourceSelector";

interface Props {
  instances: Instance[];
  onClose: () => void;
}

type Tab = "mods" | "configs" | "other";

interface SourceInfo {
  type: CompareSourceType;
  name: string;
  path?: string;
}

// Компонент подтверждения закрытия
const CloseConfirmDialog: Component<{
  onConfirm: () => void;
  onCancel: () => void;
}> = (props) => {
  const { t } = useI18n();
  let dialogRef: HTMLDivElement | undefined;
  createFocusTrap(() => dialogRef);
  return (
    <div class="fixed inset-0 bg-black/80 flex-center z-50" style="animation: fadeIn 0.1s ease-out">
      <div ref={dialogRef} tabIndex={-1} class="card w-[400px] p-6 flex flex-col gap-4" style="animation: scaleIn 0.1s ease-out">
        <div class="flex items-center gap-3">
          <i class="i-hugeicons-alert-02 w-10 h-10 p-2.5 rounded-2xl bg-yellow-600/20 text-yellow-400 flex-shrink-0" />
          <h3 class="text-lg font-semibold">{t().modpackCompare.closeConfirm.title}</h3>
        </div>
        <p class="text-sm text-muted">
          {t().modpackCompare.closeConfirm.message}
        </p>
        <div class="flex justify-end gap-2">
          <button class="btn-secondary" onClick={props.onCancel}>{t().common.cancel}</button>
          <button class="btn-primary bg-red-600 hover:bg-red-700" onClick={props.onConfirm}>{t().common.close}</button>
        </div>
      </div>
    </div>
  );
};

// Компонент создания патча
const CreatePatchDialog: Component<{
  onConfirm: (description: string, author: string) => void;
  onCancel: () => void;
  creating: boolean;
}> = (props) => {
  const { t } = useI18n();
  const [description, setDescription] = createSignal("");
  const [author, setAuthor] = createSignal("");
  let dialogRef: HTMLDivElement | undefined;
  createFocusTrap(() => dialogRef);

  return (
    <div class="fixed inset-0 bg-black/80 flex-center z-50" style="animation: fadeIn 0.1s ease-out">
      <div ref={dialogRef} tabIndex={-1} class="card w-[450px] p-6" style="animation: scaleIn 0.1s ease-out">
        <div class="flex items-center gap-3 mb-4">
          <i class="i-hugeicons-file-add w-10 h-10 p-2.5 rounded-2xl bg-cyan-600/20 text-cyan-400 flex-shrink-0" />
          <h3 class="text-lg font-semibold">{t().modpackCompare.patch?.createTitle || "Create Patch"}</h3>
        </div>
        <div class="space-y-4 mb-6">
          <div>
            <label class="text-sm font-medium text-muted mb-1 block">
              {t().modpackCompare.patch?.description || "Description"}
            </label>
            <textarea
              class="input w-full h-24 resize-none"
              placeholder={t().modpackCompare.patch?.descriptionPlaceholder || "Describe what this patch changes..."}
              value={description()}
              onInput={(e) => setDescription(e.target.value)}
            />
          </div>
          <div>
            <label class="text-sm font-medium text-muted mb-1 block">
              {t().modpackCompare.patch?.author || "Author"} ({t().common.optional || "optional"})
            </label>
            <input
              type="text"
              class="input w-full"
              placeholder={t().modpackCompare.patch?.authorPlaceholder || "Your name"}
              value={author()}
              onInput={(e) => setAuthor(e.target.value)}
            />
          </div>
        </div>
        <div class="flex justify-end gap-2">
          <button class="btn-secondary" onClick={props.onCancel} disabled={props.creating}>
            {t().common.cancel}
          </button>
          <button
            class="btn-primary"
            onClick={() => props.onConfirm(description(), author())}
            disabled={props.creating || !description().trim()}
          >
            <Show when={props.creating} fallback={
              <><i class="i-hugeicons-floppy-disk w-4 h-4" /> {t().modpackCompare.patch?.save || "Save Patch"}</>
            }>
              <i class="i-svg-spinners-6-dots-scale w-4 h-4" /> {t().modpackCompare.patch?.creating || "Creating..."}
            </Show>
          </button>
        </div>
      </div>
    </div>
  );
};

const ModpackCompareDialog: Component<Props> = (props) => {
  const { t } = useI18n();

  // Источники сравнения
  const [source1Type, setSource1Type] = createSignal<CompareSourceType>("file");
  const [source2Type, setSource2Type] = createSignal<CompareSourceType>("file");

  // Локальные файлы/инстансы
  const [path1, setPath1] = createSignal("");
  const [path2, setPath2] = createSignal("");
  const [selectedInstance1, setSelectedInstance1] = createSignal("");
  const [selectedInstance2, setSelectedInstance2] = createSignal("");

  // Платформы
  const [platformSearch1, setPlatformSearch1] = createSignal("");
  const [platformSearch2, setPlatformSearch2] = createSignal("");
  const [platformResults1, setPlatformResults1] = createSignal<ModpackSearchResult[]>([]);
  const [platformResults2, setPlatformResults2] = createSignal<ModpackSearchResult[]>([]);
  const [selectedModpack1, setSelectedModpack1] = createSignal<ModpackSearchResult | null>(null);
  const [selectedModpack2, setSelectedModpack2] = createSignal<ModpackSearchResult | null>(null);
  const [modpackVersions1, setModpackVersions1] = createSignal<ModpackVersionInfo[]>([]);
  const [modpackVersions2, setModpackVersions2] = createSignal<ModpackVersionInfo[]>([]);
  const [selectedVersion1, setSelectedVersion1] = createSignal("");
  const [selectedVersion2, setSelectedVersion2] = createSignal("");
  const [searchingPlatform1, setSearchingPlatform1] = createSignal(false);
  const [searchingPlatform2, setSearchingPlatform2] = createSignal(false);

  // Состояние сравнения
  const [comparing, setComparing] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [result, setResult] = createSignal<ModpackComparison | null>(null);
  const [activeTab, setActiveTab] = createSignal<Tab>("mods");

  // Информация об источниках для отображения
  const [sourceInfo1, setSourceInfo1] = createSignal<SourceInfo | null>(null);
  const [sourceInfo2, setSourceInfo2] = createSignal<SourceInfo | null>(null);

  // Скачивание
  const [downloadState, setDownloadState] = createSignal<DownloadState>({
    downloading: new Set(),
    completed: new Set(),
    failed: new Set(),
  });
  const [downloadSearchMod, setDownloadSearchMod] = createSignal<ModInfo | null>(null);
  const [bulkDownloadTarget, setBulkDownloadTarget] = createSignal<string | null>(null);
  const [bulkDownloading, setBulkDownloading] = createSignal(false);
  const [bulkDownloadProgress, setBulkDownloadProgress] = createSignal({ current: 0, total: 0 });

  // Защита от закрытия
  const [showCloseConfirm, setShowCloseConfirm] = createSignal(false);

  // Создание патча
  const [showCreatePatch, setShowCreatePatch] = createSignal(false);
  const [creatingPatch, setCreatingPatch] = createSignal(false);

  const hasUnsavedData = createMemo(() => {
    return result() !== null || path1() !== "" || path2() !== "" ||
           selectedInstance1() !== "" || selectedInstance2() !== "" ||
           selectedModpack1() !== null || selectedModpack2() !== null;
  });

  const handleClose = () => {
    if (hasUnsavedData()) setShowCloseConfirm(true);
    else props.onClose();
  };

  const handleBackdropClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget) handleClose();
  };

  // Поиск на платформе
  const searchPlatform = async (
    query: string,
    source: "modrinth" | "curseforge",
    setResults: (r: ModpackSearchResult[]) => void,
    setSearching: (s: boolean) => void
  ) => {
    if (query.length < 2) return;
    setSearching(true);
    try {
      const res = await invoke<{ results: ModpackSearchResult[] }>("search_modpacks", {
        query, source, limit: 10, offset: 0,
      });
      setResults(res.results);
    } catch (e) {
      if (import.meta.env.DEV) console.error("Search error:", e);
    } finally {
      setSearching(false);
    }
  };

  const loadVersions = async (modpack: ModpackSearchResult, setVersions: (v: ModpackVersionInfo[]) => void) => {
    try {
      const versions = await invoke<ModpackVersionInfo[]>("get_modpack_versions", {
        source: modpack.source,
        projectId: modpack.project_id,
      });
      setVersions(versions);
    } catch (e) {
      if (import.meta.env.DEV) console.error("Load versions error:", e);
    }
  };

  const selectFile = async (setter: (path: string) => void) => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: t().modpackCompare.fileTypes.modpacks, extensions: ["mrpack", "zip"] }],
        title: t().modpackCompare.selectFile
      });
      if (selected && typeof selected === "string") setter(selected);
    } catch (e) {
      if (import.meta.env.DEV) console.error("File selection error:", e);
    }
  };

  // Экспорт результатов в файл
  const exportResults = async (format: "json" | "text") => {
    const r = result();
    if (!r) return;

    const ext = format === "json" ? "json" : "txt";
    const filePath = await save({
      filters: [{ name: format.toUpperCase(), extensions: [ext] }],
      defaultPath: `modpack-comparison.${ext}`
    });
    if (!filePath) return;

    let content: string;
    if (format === "json") {
      content = JSON.stringify(r, null, 2);
    } else {
      const lines: string[] = [];
      lines.push(`=== ${t().modpackCompare.title} ===`);
      lines.push(`${t().modpackCompare.source1}: ${sourceInfo1()?.name || ""}`);
      lines.push(`${t().modpackCompare.source2}: ${sourceInfo2()?.name || ""}`);
      lines.push("");

      if (r.mods_only_in_first.length > 0) {
        lines.push(`--- ${t().modpackCompare.mods.onlyInFirst} (${r.mods_only_in_first.length}) ---`);
        r.mods_only_in_first.forEach(m => lines.push(`  - ${m.name} ${m.version || ""}`));
        lines.push("");
      }

      if (r.mods_only_in_second.length > 0) {
        lines.push(`--- ${t().modpackCompare.mods.onlyInSecond} (${r.mods_only_in_second.length}) ---`);
        r.mods_only_in_second.forEach(m => lines.push(`  + ${m.name} ${m.version || ""}`));
        lines.push("");
      }

      if (r.mods_different_version.length > 0) {
        lines.push(`--- ${t().modpackCompare.mods.differentVersions} (${r.mods_different_version.length}) ---`);
        r.mods_different_version.forEach(m => {
          lines.push(`  ~ ${m.name}: ${m.first_version || m.first_filename} -> ${m.second_version || m.second_filename}`);
        });
        lines.push("");
      }

      if (r.mods_identical.length > 0) {
        lines.push(`--- ${t().modpackCompare.mods.identical} (${r.mods_identical.length}) ---`);
        r.mods_identical.forEach(m => lines.push(`  = ${m.name} ${m.version || ""}`));
      }

      content = lines.join("\n");
    }

    try {
      await writeTextFile(filePath, content);
    } catch (e) {
      if (import.meta.env.DEV) console.error("Export error:", e);
    }
  };

  const getSourceName = (type: CompareSourceType, path: string, instanceId: string, modpack: ModpackSearchResult | null): string => {
    if (type === "file") return path ? path.split(/[/\\]/).pop() || path : "";
    if (type === "instance") {
      const inst = props.instances.find(i => i.id === instanceId);
      return inst?.name || "";
    }
    if (modpack) return modpack.title;
    return "";
  };

  const getComparePath = async (
    sourceType: CompareSourceType,
    localPath: string,
    instanceId: string,
    modpack: ModpackSearchResult | null,
    versionId: string
  ): Promise<string | null> => {
    if (sourceType === "file") return localPath || null;
    if (sourceType === "instance") {
      const instance = props.instances.find(i => i.id === instanceId);
      return instance?.dir || null;
    }
    if ((sourceType === "modrinth" || sourceType === "curseforge") && modpack) {
      return `platform:${modpack.source}:${modpack.project_id}:${versionId}`;
    }
    return null;
  };

  const compare = async () => {
    setComparing(true);
    setError(null);
    setResult(null);

    try {
      const p1 = await getComparePath(source1Type(), path1(), selectedInstance1(), selectedModpack1(), selectedVersion1());
      const p2 = await getComparePath(source2Type(), path2(), selectedInstance2(), selectedModpack2(), selectedVersion2());

      if (!p1 || !p2) {
        setError(t().modpackCompare.selectBoth);
        setComparing(false);
        return;
      }

      // Сохраняем информацию об источниках
      setSourceInfo1({
        type: source1Type(),
        name: getSourceName(source1Type(), path1(), selectedInstance1(), selectedModpack1()),
        path: source1Type() === "file" ? path1() : undefined
      });
      setSourceInfo2({
        type: source2Type(),
        name: getSourceName(source2Type(), path2(), selectedInstance2(), selectedModpack2()),
        path: source2Type() === "file" ? path2() : undefined
      });

      if (p1.startsWith("platform:") || p2.startsWith("platform:")) {
        let mods1: ModInfo[] = [];
        let mods2: ModInfo[] = [];

        if (p1.startsWith("platform:")) {
          const [, source, projectId, versionId] = p1.split(":");
          mods1 = await invoke<ModInfo[]>("get_modpack_mod_list", {
            source, projectId, versionId: versionId || undefined,
          });
        }

        if (p2.startsWith("platform:")) {
          const [, source, projectId, versionId] = p2.split(":");
          mods2 = await invoke<ModInfo[]>("get_modpack_mod_list", {
            source, projectId, versionId: versionId || undefined,
          });
        }

        if (!p1.startsWith("platform:")) {
          const localResult = await invoke<ModpackComparison>("compare_modpacks", { path1: p1, path2: p1 });
          mods1 = [...localResult.mods_only_in_first, ...localResult.mods_identical];
        }

        if (!p2.startsWith("platform:")) {
          const localResult = await invoke<ModpackComparison>("compare_modpacks", { path1: p2, path2: p2 });
          mods2 = [...localResult.mods_only_in_first, ...localResult.mods_identical];
        }

        const comparison = compareMods(mods1, mods2);
        setResult(comparison);
      } else {
        const comparison = await invoke<ModpackComparison>("compare_modpacks", { path1: p1, path2: p2 });
        setResult(comparison);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setComparing(false);
    }
  };

  const compareMods = (mods1: ModInfo[], mods2: ModInfo[]): ModpackComparison => {
    const mods2ByName = new Map(mods2.map(m => [m.name, m]));
    // Дополнительная мапа по хешу для поиска переименованных модов
    const mods2ByHash = new Map(mods2.filter(m => m.hash).map(m => [m.hash!, m]));
    const matchedInSecond = new Set<string>();

    const modsOnlyInFirst: ModInfo[] = [];
    const modsDifferentVersion: ModVersionDiff[] = [];
    const modsIdentical: ModInfo[] = [];

    for (const mod1 of mods1) {
      const mod2 = mods2ByName.get(mod1.name);
      if (mod2) {
        matchedInSecond.add(mod2.name);
        // Проверяем идентичность по хешу (приоритет) или по filename+size
        const isIdentical = (mod1.hash && mod2.hash)
          ? mod1.hash === mod2.hash
          : mod1.filename === mod2.filename && mod1.size === mod2.size;

        if (isIdentical) {
          modsIdentical.push(mod1);
        } else {
          modsDifferentVersion.push({
            name: mod1.name,
            first_filename: mod1.filename,
            second_filename: mod2.filename,
            first_version: mod1.version,
            second_version: mod2.version,
          });
        }
      } else if (mod1.hash) {
        // Ищем по хешу (мод мог быть переименован)
        const mod2ByHash = mods2ByHash.get(mod1.hash);
        if (mod2ByHash && !matchedInSecond.has(mod2ByHash.name)) {
          matchedInSecond.add(mod2ByHash.name);
          modsIdentical.push(mod1);
        } else {
          modsOnlyInFirst.push(mod1);
        }
      } else {
        modsOnlyInFirst.push(mod1);
      }
    }

    const modsOnlyInSecond = mods2.filter(m => !matchedInSecond.has(m.name));

    return {
      mods_only_in_first: modsOnlyInFirst,
      mods_only_in_second: modsOnlyInSecond,
      mods_different_version: modsDifferentVersion,
      mods_identical: modsIdentical,
      configs_only_in_first: [],
      configs_only_in_second: [],
      configs_different: [],
      other_only_in_first: [],
      other_only_in_second: [],
      total_mods_first: mods1.length,
      total_mods_second: mods2.length,
      total_configs_first: 0,
      total_configs_second: 0,
    };
  };

  // Localized size formatter
  const fmtSize = (bytes: number) => formatSize(bytes, t().ui?.units);

  const handleDownloadMod = (mod: ModInfo) => {
    setDownloadSearchMod(mod);
  };

  const handleModDownloaded = () => {
    const mod = downloadSearchMod();
    if (mod) {
      setDownloadState(prev => ({
        ...prev,
        completed: new Set([...Array.from(prev.completed), mod.name]),
        downloading: new Set(Array.from(prev.downloading).filter(n => n !== mod.name)),
      }));
    }
  };

  // Выбор папки для bulk download
  const selectBulkDownloadFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t().modpackCompare.download.selectFolderTitle
      });
      if (selected && typeof selected === "string") {
        setBulkDownloadTarget(selected);
        return selected;
      }
    } catch (e) {
      if (import.meta.env.DEV) console.error("Folder selection error:", e);
    }
    return null;
  };

  // Bulk download всех недостающих модов
  const handleBulkDownload = async () => {
    const r = result();
    if (!r || r.mods_only_in_second.length === 0) return;

    let targetPath = bulkDownloadTarget();
    if (!targetPath) {
      targetPath = await selectBulkDownloadFolder();
      if (!targetPath) return;
    }

    const modsToDownload = r.mods_only_in_second.filter(
      m => !downloadState().completed.has(m.name) && !downloadState().failed.has(m.name)
    );

    if (modsToDownload.length === 0) return;

    setBulkDownloading(true);
    setBulkDownloadProgress({ current: 0, total: modsToDownload.length });

    for (let i = 0; i < modsToDownload.length; i++) {
      const mod = modsToDownload[i];
      setBulkDownloadProgress({ current: i + 1, total: modsToDownload.length });

      setDownloadState(prev => ({
        ...prev,
        downloading: new Set([...Array.from(prev.downloading), mod.name]),
      }));

      try {
        // Поиск мода по имени на Modrinth
        const searchResults = await invoke<ModSearchInfo[]>("search_mod_by_name", {
          name: mod.name,
          source: "modrinth",
        });

        if (searchResults.length > 0) {
          const bestMatch = searchResults[0];
          await invoke<string>("download_mod_to_path", {
            source: bestMatch.source,
            projectId: bestMatch.project_id,
            versionId: bestMatch.version_id,
            destPath: targetPath,
          });

          setDownloadState(prev => ({
            ...prev,
            completed: new Set([...Array.from(prev.completed), mod.name]),
            downloading: new Set(Array.from(prev.downloading).filter(n => n !== mod.name)),
          }));
        } else {
          // Попробуем CurseForge
          const cfResults = await invoke<ModSearchInfo[]>("search_mod_by_name", {
            name: mod.name,
            source: "curseforge",
          });

          if (cfResults.length > 0) {
            const bestMatch = cfResults[0];
            await invoke<string>("download_mod_to_path", {
              source: bestMatch.source,
              projectId: bestMatch.project_id,
              versionId: bestMatch.version_id,
              destPath: targetPath,
            });

            setDownloadState(prev => ({
              ...prev,
              completed: new Set([...Array.from(prev.completed), mod.name]),
              downloading: new Set(Array.from(prev.downloading).filter(n => n !== mod.name)),
            }));
          } else {
            throw new Error("Mod not found");
          }
        }
      } catch (e) {
        if (import.meta.env.DEV) console.error(`Failed to download ${mod.name}:`, e);
        setDownloadState(prev => ({
          ...prev,
          failed: new Set([...Array.from(prev.failed), mod.name]),
          downloading: new Set(Array.from(prev.downloading).filter(n => n !== mod.name)),
        }));
      }
    }

    setBulkDownloading(false);
  };

  // Создание и сохранение патча
  const handleCreatePatch = async (description: string, author: string) => {
    const r = result();
    const info2 = sourceInfo2();

    if (!r || !info2) return;

    setCreatingPatch(true);

    try {
      // Получаем информацию о версии модпака для minecraft_version и loader
      const versionInfo = modpackVersions2().find(v => v.id === selectedVersion2()) || modpackVersions2()[0];
      const minecraftVersion = versionInfo?.game_versions?.[0] || "";
      const loader = versionInfo?.loaders?.[0] || "";

      // Определяем базовый модпак (второй источник - "целевой" модпак)
      const baseModpack: PatchBaseInfo = {
        name: info2.name,
        minecraft_version: minecraftVersion,
        loader: loader,
        loader_version: null,
        source: info2.type === "modrinth" || info2.type === "curseforge" ? info2.type : null,
        project_id: selectedModpack2()?.project_id || null,
        version_id: selectedVersion2() || null,
      };

      // Собираем моды для добавления (только во втором модпаке)
      const modsToAdd: PatchModAdd[] = r.mods_only_in_second.map(mod => ({
        name: mod.name,
        slug: mod.name.toLowerCase().replace(/\s+/g, "-"),
        source: "modrinth", // Предпочтительный источник
        project_id: "", // Будет заполнено при применении патча через поиск
        version_id: null,
        filename: mod.filename,
      }));

      // Собираем моды для удаления (только в первом модпаке)
      const modsToRemove: PatchModRemove[] = r.mods_only_in_first.map(mod => ({
        name: mod.name,
        filename_pattern: mod.filename.replace(/[-_]\d+\.\d+.*\.jar$/, "*.jar"), // Паттерн для fuzzy matching
      }));

      // Собираем изменения конфигов (содержимое не доступно в результатах сравнения)
      const configsToAdd: PatchConfigAdd[] = [];
      const configsToRemove: string[] = r.configs_only_in_first.map(c => c.path);

      // Формируем объект изменений
      const changes: PatchChanges = {
        mods_to_add: modsToAdd,
        mods_to_remove: modsToRemove,
        configs_to_add: configsToAdd,
        configs_to_remove: configsToRemove,
        files_to_add: [],
        files_to_remove: r.other_only_in_first,
      };

      // Формируем патч
      const patch: ModpackPatch = {
        file_type: "patch",
        format_version: STZHK_FORMAT_VERSION,
        base_modpack: baseModpack,
        created_at: new Date().toISOString(),
        description: description,
        author: author || null,
        changes: changes,
      };

      // Выбираем файл для сохранения
      const filePath = await save({
        filters: [{ name: "Stuzhik Patch", extensions: ["stzhk"] }],
        defaultPath: `${info2.name.replace(/[^a-zA-Z0-9]/g, "_")}_patch.stzhk`
      });

      if (!filePath) {
        setCreatingPatch(false);
        return;
      }

      // Сохраняем патч
      await invoke("save_modpack_patch", { patch, path: filePath });

      setShowCreatePatch(false);
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to create patch:", e);
      setError(String(e));
    } finally {
      setCreatingPatch(false);
    }
  };

  const stats = createMemo(() => {
    const r = result();
    if (!r) return null;
    return {
      modsFirst: r.total_mods_first,
      modsSecond: r.total_mods_second,
      identical: r.mods_identical.length,
      different: r.mods_different_version.length,
      modsChanges: r.mods_only_in_first.length + r.mods_only_in_second.length + r.mods_different_version.length,
      configsChanges: r.configs_only_in_first.length + r.configs_only_in_second.length + r.configs_different.length,
      otherChanges: r.other_only_in_first.length + r.other_only_in_second.length,
    };
  });

  return (
    <>
      <div class="fixed inset-0 bg-black/70 flex-center z-40" onMouseDown={handleBackdropClick}>
        <div class="card w-[900px] max-h-[85vh] overflow-hidden flex flex-col">
          {/* Header */}
          <div class="flex items-center justify-between pb-4 border-b border-gray-800">
            <div class="flex items-center gap-3">
              <div class="flex-center w-10 h-10 rounded-2xl bg-purple-600/20">
                <i class="i-hugeicons-git-compare w-5 h-5 text-purple-400" />
              </div>
              <div>
                <h2 class="text-lg font-semibold">{t().modpackCompare.title}</h2>
                <p class="text-sm text-muted">{t().modpackCompare.subtitle}</p>
              </div>
            </div>
            <button
              class="btn-close"
              onClick={handleClose}
              aria-label={t().ui?.tooltips?.close ?? "Close"}
            >
              <i class="i-hugeicons-cancel-01 w-5 h-5" />
            </button>
          </div>

          <Show when={!result()}>
            <div class="py-6 space-y-6 overflow-y-auto">
              <CompareSourceSelector
                sourceType={source1Type()}
                setSourceType={setSource1Type}
                path={path1()}
                setPath={setPath1}
                selectedInstance={selectedInstance1()}
                setSelectedInstance={setSelectedInstance1}
                platformSearch={platformSearch1()}
                setPlatformSearch={setPlatformSearch1}
                platformResults={platformResults1()}
                setPlatformResults={setPlatformResults1}
                selectedModpack={selectedModpack1()}
                setSelectedModpack={setSelectedModpack1}
                modpackVersions={modpackVersions1()}
                setModpackVersions={setModpackVersions1}
                selectedVersion={selectedVersion1()}
                setSelectedVersion={setSelectedVersion1}
                searching={searchingPlatform1()}
                setSearching={setSearchingPlatform1}
                label={t().modpackCompare.source1}
                colorClass="text-purple-400"
                instances={props.instances}
                onSelectFile={selectFile}
                onSearchPlatform={searchPlatform}
                onLoadVersions={loadVersions}
              />

              <div class="flex-center">
                <div class="w-8 h-8 rounded-full bg-gray-800 flex-center">
                  <i class="i-hugeicons-arrow-vertical w-4 h-4 text-muted" />
                </div>
              </div>

              <CompareSourceSelector
                sourceType={source2Type()}
                setSourceType={setSource2Type}
                path={path2()}
                setPath={setPath2}
                selectedInstance={selectedInstance2()}
                setSelectedInstance={setSelectedInstance2}
                platformSearch={platformSearch2()}
                setPlatformSearch={setPlatformSearch2}
                platformResults={platformResults2()}
                setPlatformResults={setPlatformResults2}
                selectedModpack={selectedModpack2()}
                setSelectedModpack={setSelectedModpack2}
                modpackVersions={modpackVersions2()}
                setModpackVersions={setModpackVersions2}
                selectedVersion={selectedVersion2()}
                setSelectedVersion={setSelectedVersion2}
                searching={searchingPlatform2()}
                setSearching={setSearchingPlatform2}
                label={t().modpackCompare.source2}
                colorClass="text-blue-400"
                instances={props.instances}
                onSelectFile={selectFile}
                onSearchPlatform={searchPlatform}
                onLoadVersions={loadVersions}
              />

              <Show when={error()}>
                <div class="p-3 bg-red-600/20 border border-red-600/40 rounded-2xl text-sm text-red-400">{error()}</div>
              </Show>

              <button class="btn-primary w-full" onClick={compare} disabled={comparing()}>
                <Show when={comparing()} fallback={<><i class="i-hugeicons-git-compare w-4 h-4" /> {t().modpackCompare.compare}</>}>
                  <i class="i-svg-spinners-6-dots-scale w-4 h-4" /> {t().modpackCompare.comparing}
                </Show>
              </button>
            </div>
          </Show>

          <Show when={result()}>
            <div class="flex-1 overflow-hidden flex flex-col">
              {/* Памятка источников */}
              <div class="py-3 px-4 bg-gray-alpha-50 border-b border-gray-800 flex gap-4">
                <div class="flex-1 min-w-0 flex flex-col gap-0.5">
                  <div class="text-xs text-muted">{t().modpackCompare.source1}</div>
                  <div class="text-sm font-medium text-purple-400 truncate">{sourceInfo1()?.name}</div>
                </div>
                <div class="flex-center text-muted">
                  <i class="i-hugeicons-arrow-horizontal w-4 h-4" />
                </div>
                <div class="flex-1 min-w-0 text-right">
                  <div class="text-xs text-muted mb-0.5">{t().modpackCompare.source2}</div>
                  <div class="text-sm font-medium text-blue-400 truncate">{sourceInfo2()?.name}</div>
                </div>
              </div>

              {/* Stats */}
              <div class="py-4 grid grid-cols-4 gap-4 border-b border-gray-800">
                <div class="text-center">
                  <div class="text-2xl font-bold text-purple-400">{stats()?.modsFirst}</div>
                  <div class="text-xs text-muted">{t().modpackCompare.stats.modsFirst}</div>
                </div>
                <div class="text-center">
                  <div class="text-2xl font-bold text-blue-400">{stats()?.modsSecond}</div>
                  <div class="text-xs text-muted">{t().modpackCompare.stats.modsSecond}</div>
                </div>
                <div class="text-center">
                  <div class="text-2xl font-bold text-green-400">{stats()?.identical}</div>
                  <div class="text-xs text-muted">{t().modpackCompare.stats.identical}</div>
                </div>
                <div class="text-center">
                  <div class="text-2xl font-bold text-yellow-400">{stats()?.different}</div>
                  <div class="text-xs text-muted">{t().modpackCompare.stats.different}</div>
                </div>
              </div>

              {/* Tabs */}
              <div class="py-3 border-b border-gray-800">
                <Tabs
                  tabs={[
                    { id: "mods", label: t().modpackCompare.tabs.mods, badge: stats()?.modsChanges },
                    { id: "configs", label: t().modpackCompare.tabs.configs, badge: stats()?.configsChanges },
                    { id: "other", label: t().modpackCompare.tabs.other, badge: stats()?.otherChanges },
                  ]}
                  activeTab={activeTab()}
                  onTabChange={(id) => setActiveTab(id as Tab)}
                  variant="pills"
                />
              </div>

              {/* Content */}
              <div class="flex-1 overflow-y-auto py-4 space-y-4">
                <Switch>
                  <Match when={activeTab() === "mods"}>
                    <Show when={result()!.mods_only_in_first.length > 0}>
                      <CompareModList
                        mods={result()!.mods_only_in_first}
                        variant="purple"
                        icon="i-hugeicons-arrow-left-01"
                        title={t().modpackCompare.mods.onlyInFirst}
                        fmtSize={fmtSize}
                      />
                    </Show>

                    <Show when={result()!.mods_only_in_second.length > 0}>
                      <div class="space-y-2">
                        <CompareModList
                          mods={result()!.mods_only_in_second}
                          variant="blue"
                          icon="i-hugeicons-arrow-right-01"
                          title={t().modpackCompare.mods.onlyInSecond}
                          onDownload={handleDownloadMod}
                          downloadState={downloadState()}
                          fmtSize={fmtSize}
                          downloadTooltip={t().modpackCompare.download.download}
                          downloadedTooltip={t().modpackCompare.download.downloaded}
                          failedTooltip={t().modpackCompare.download.failed}
                        />
                        <Tooltip text={t().modpackCompare.download.downloadAllHint} position="bottom">
                        <button
                          class="btn-primary btn-sm w-full"
                          onClick={handleBulkDownload}
                          disabled={bulkDownloading() || downloadState().completed.size === result()!.mods_only_in_second.length}
                        >
                          <Show when={bulkDownloading()} fallback={
                            <>
                              <i class="i-hugeicons-download-02 w-4 h-4" />
                              {t().modpackCompare.download.downloadAll}
                              <Show when={downloadState().completed.size > 0}>
                                <span class="text-xs opacity-70">
                                  ({downloadState().completed.size}/{result()!.mods_only_in_second.length})
                                </span>
                              </Show>
                            </>
                          }>
                            <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                            {bulkDownloadProgress().current}/{bulkDownloadProgress().total}
                          </Show>
                        </button>
                        </Tooltip>
                      </div>
                    </Show>

                    <Show when={result()!.mods_different_version.length > 0}>
                      <div class="space-y-2">
                        <h3 class="text-sm font-medium text-yellow-400 flex items-center gap-2">
                          <i class="i-hugeicons-arrow-horizontal w-4 h-4" />
                          {t().modpackCompare.mods.differentVersions} ({result()!.mods_different_version.length})
                        </h3>
                        <div class="grid gap-1 max-h-64 overflow-y-auto">
                          <For each={result()!.mods_different_version}>
                            {(diff) => (
                              <div class="p-2 bg-yellow-600/10 rounded border border-yellow-600/30">
                                <div class="font-medium mb-1">{diff.name}</div>
                                <div class="grid grid-cols-2 gap-2 text-xs">
                                  <div class="text-purple-400 truncate">{t().modpackCompare.mods.diffFirst}: {diff.first_version || diff.first_filename}</div>
                                  <div class="text-blue-400 truncate">{t().modpackCompare.mods.diffSecond}: {diff.second_version || diff.second_filename}</div>
                                </div>
                              </div>
                            )}
                          </For>
                        </div>
                      </div>
                    </Show>

                    <Show when={result()!.mods_identical.length > 0}>
                      <details class="group">
                        <summary class="text-sm font-medium text-green-400 cursor-pointer flex items-center gap-2">
                          <i class="i-hugeicons-checkmark-circle-02 w-4 h-4" />
                          {t().modpackCompare.mods.identical} ({result()!.mods_identical.length})
                          <i class="i-hugeicons-arrow-down-01 w-4 h-4 group-open:rotate-180 transition-transform duration-100" />
                        </summary>
                        <div class="mt-2">
                          <CompareModList mods={result()!.mods_identical} variant="green" icon="" title="" fmtSize={fmtSize} />
                        </div>
                      </details>
                    </Show>

                    <Show when={stats()?.modsChanges === 0}>
                      <div class="text-center text-muted py-8">
                        <i class="i-hugeicons-checkmark-circle-02 w-12 h-12 text-green-500 mx-auto mb-2" />
                        <p>{t().modpackCompare.mods.allIdentical}</p>
                      </div>
                    </Show>
                  </Match>

                  <Match when={activeTab() === "configs"}>
                    <Show when={result()!.configs_only_in_first.length > 0}>
                      <div class="space-y-2">
                        <h3 class="text-sm font-medium text-purple-400">{t().modpackCompare.configs.onlyInFirst} ({result()!.configs_only_in_first.length})</h3>
                        <div class="grid gap-1 max-h-48 overflow-y-auto">
                          <For each={result()!.configs_only_in_first}>
                            {(config) => (
                              <div class="flex items-center justify-between p-2 bg-purple-600/10 rounded border border-purple-600/30 text-sm">
                                <span class="truncate">{config.path}</span>
                                <span class="text-xs text-muted">{fmtSize(config.size)}</span>
                              </div>
                            )}
                          </For>
                        </div>
                      </div>
                    </Show>

                    <Show when={result()!.configs_only_in_second.length > 0}>
                      <div class="space-y-2">
                        <h3 class="text-sm font-medium text-blue-400">{t().modpackCompare.configs.onlyInSecond} ({result()!.configs_only_in_second.length})</h3>
                        <div class="grid gap-1 max-h-48 overflow-y-auto">
                          <For each={result()!.configs_only_in_second}>
                            {(config) => (
                              <div class="flex items-center justify-between p-2 bg-blue-600/10 rounded border border-blue-600/30 text-sm">
                                <span class="truncate">{config.path}</span>
                                <span class="text-xs text-muted">{fmtSize(config.size)}</span>
                              </div>
                            )}
                          </For>
                        </div>
                      </div>
                    </Show>

                    <Show when={result()!.configs_different.length > 0}>
                      <div class="space-y-2">
                        <h3 class="text-sm font-medium text-yellow-400">{t().modpackCompare.configs.differentContent} ({result()!.configs_different.length})</h3>
                        <div class="grid gap-1 max-h-48 overflow-y-auto">
                          <For each={result()!.configs_different}>
                            {(diff) => (
                              <div class="p-2 bg-yellow-600/10 rounded border border-yellow-600/30 text-sm">
                                <div class="truncate">{diff.path}</div>
                                <div class="flex gap-4 text-xs text-muted mt-1">
                                  <span class="text-purple-400">{t().modpackCompare.mods.diffFirst}: {fmtSize(diff.first_size)}</span>
                                  <span class="text-blue-400">{t().modpackCompare.mods.diffSecond}: {fmtSize(diff.second_size)}</span>
                                </div>
                              </div>
                            )}
                          </For>
                        </div>
                      </div>
                    </Show>

                    <Show when={stats()?.configsChanges === 0}>
                      <div class="text-center text-muted py-8">
                        <i class="i-hugeicons-checkmark-circle-02 w-12 h-12 text-green-500 mx-auto mb-2" />
                        <p>{t().modpackCompare.configs.allIdentical}</p>
                      </div>
                    </Show>
                  </Match>

                  <Match when={activeTab() === "other"}>
                    <Show when={result()!.other_only_in_first.length > 0}>
                      <div class="space-y-2">
                        <h3 class="text-sm font-medium text-purple-400">{t().modpackCompare.other.onlyInFirst} ({result()!.other_only_in_first.length})</h3>
                        <div class="grid gap-1">
                          <For each={result()!.other_only_in_first}>
                            {(file) => <div class="p-2 bg-purple-600/10 rounded border border-purple-600/30 text-sm">{file}</div>}
                          </For>
                        </div>
                      </div>
                    </Show>

                    <Show when={result()!.other_only_in_second.length > 0}>
                      <div class="space-y-2">
                        <h3 class="text-sm font-medium text-blue-400">{t().modpackCompare.other.onlyInSecond} ({result()!.other_only_in_second.length})</h3>
                        <div class="grid gap-1">
                          <For each={result()!.other_only_in_second}>
                            {(file) => <div class="p-2 bg-blue-600/10 rounded border border-blue-600/30 text-sm">{file}</div>}
                          </For>
                        </div>
                      </div>
                    </Show>

                    <Show when={stats()?.otherChanges === 0}>
                      <div class="text-center text-muted py-8">
                        <i class="i-hugeicons-checkmark-circle-02 w-12 h-12 text-green-500 mx-auto mb-2" />
                        <p>{t().modpackCompare.other.allIdentical}</p>
                      </div>
                    </Show>
                  </Match>
                </Switch>
              </div>

              {/* Footer */}
              <div class="pt-4 border-t border-gray-800 flex justify-between">
                <button class="btn-secondary" onClick={() => setResult(null)}>
                  <i class="i-hugeicons-arrow-left-01 w-4 h-4" /> {t().modpackCompare.newComparison}
                </button>
                <div class="flex gap-2">
                  <Tooltip text={t().modpackCompare.patch?.createHint || "Create a patch file from these differences"} position="bottom">
                    <button
                      class="btn-primary bg-cyan-600 hover:bg-cyan-700"
                      onClick={() => setShowCreatePatch(true)}
                    >
                      <i class="i-hugeicons-file-add w-4 h-4" /> {t().modpackCompare.patch?.create || "Create Patch"}
                    </button>
                  </Tooltip>
                  <Tooltip text={t().modpackCompare.export.exportJson} position="bottom">
                    <button class="btn-ghost" onClick={() => exportResults("json")}>
                      <i class="i-hugeicons-file-export w-4 h-4" /> JSON
                    </button>
                  </Tooltip>
                  <Tooltip text={t().modpackCompare.export.exportText} position="bottom">
                    <button class="btn-ghost" onClick={() => exportResults("text")}>
                      <i class="i-hugeicons-file-01 w-4 h-4" /> TXT
                    </button>
                  </Tooltip>
                  <button class="btn-ghost" onClick={handleClose}>{t().common.close}</button>
                </div>
              </div>
            </div>
          </Show>
        </div>
      </div>

      <Show when={showCloseConfirm()}>
        <CloseConfirmDialog onConfirm={props.onClose} onCancel={() => setShowCloseConfirm(false)} />
      </Show>

      <Show when={downloadSearchMod()}>
        <ModDownloadSearch
          modName={downloadSearchMod()!.name}
          onClose={() => setDownloadSearchMod(null)}
          onDownloaded={handleModDownloaded}
        />
      </Show>

      <Show when={showCreatePatch()}>
        <CreatePatchDialog
          onConfirm={handleCreatePatch}
          onCancel={() => setShowCreatePatch(false)}
          creating={creatingPatch()}
        />
      </Show>
    </>
  );
};

export default ModpackCompareDialog;
