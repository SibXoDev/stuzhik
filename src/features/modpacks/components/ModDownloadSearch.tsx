import { createSignal, Show, For, Component } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { ModSearchInfo } from "../../../shared/types";
import { sanitizeImageUrl } from "../../../shared/utils/url-validator";
import { useI18n } from "../../../shared/i18n";
import { createFocusTrap } from "../../../shared/hooks";

interface ModDownloadSearchProps {
  modName: string;
  onClose: () => void;
  onDownloaded: (filename: string) => void;
}

export const ModDownloadSearch: Component<ModDownloadSearchProps> = (props) => {
  const { t } = useI18n();
  const [searching, setSearching] = createSignal(false);
  const [results, setResults] = createSignal<ModSearchInfo[]>([]);
  const [downloading, setDownloading] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [source, setSource] = createSignal<"modrinth" | "curseforge">("modrinth");
  const [targetPath, setTargetPath] = createSignal("");
  let dialogRef: HTMLDivElement | undefined;
  createFocusTrap(() => dialogRef);

  const search = async () => {
    setSearching(true);
    setError(null);
    setResults([]);
    try {
      const res = await invoke<ModSearchInfo[]>("search_mod_by_name", {
        name: props.modName,
        source: source(),
      });
      setResults(res);
      if (res.length === 0) setError(t().modpackCompare.download.noResults);
    } catch (e) {
      setError(String(e));
    } finally {
      setSearching(false);
    }
  };

  const selectFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t().modpackCompare.download.selectFolderTitle
      });
      if (selected && typeof selected === "string") {
        setTargetPath(selected);
      }
    } catch (e) {
      if (import.meta.env.DEV) console.error(e);
    }
  };

  const download = async (mod: ModSearchInfo) => {
    if (!targetPath()) {
      setError(t().modpackCompare.download.selectFolderRequired);
      return;
    }
    setDownloading(mod.project_id);
    setError(null);
    try {
      const filename = await invoke<string>("download_mod_to_path", {
        source: mod.source,
        projectId: mod.project_id,
        versionId: mod.version_id,
        destPath: targetPath(),
      });
      props.onDownloaded(filename);
      props.onClose();
    } catch (e) {
      setError(String(e));
      setDownloading(null);
    }
  };

  search();

  return (
    <div class="fixed inset-0 bg-black/80 flex-center z-50" style="animation: fadeIn 0.1s ease-out">
      <div ref={dialogRef} tabIndex={-1} class="card w-[500px] max-h-[70vh] overflow-hidden flex flex-col" style="animation: scaleIn 0.1s ease-out">
        <div class="flex items-center justify-between pb-4 border-b border-gray-800">
          <h3 class="font-semibold">{t().modpackCompare.download.title}: {props.modName}</h3>
          <button
            class="btn-close"
            onClick={props.onClose}
            aria-label={t().ui?.tooltips?.close ?? "Close"}
          >
            <i class="i-hugeicons-cancel-01 w-5 h-5" />
          </button>
        </div>

        <div class="py-4 space-y-4 flex-1 overflow-hidden flex flex-col">
          <button class="btn-secondary w-full text-left" onClick={selectFolder}>
            <i class="i-hugeicons-folder-01 w-4 h-4" />
            {targetPath() ? targetPath().split(/[/\\]/).pop() : t().modpackCompare.download.selectFolder}
          </button>

          <div class="flex gap-2">
            <button
              class={`flex-1 py-2 px-3 rounded-2xl text-sm font-medium transition-colors duration-100 ${source() === "modrinth" ? "bg-green-600 text-white" : "bg-gray-800 text-muted hover:bg-gray-700"}`}
              onClick={() => { setSource("modrinth"); search(); }}
            >
              Modrinth
            </button>
            <button
              class={`flex-1 py-2 px-3 rounded-2xl text-sm font-medium transition-colors duration-100 ${source() === "curseforge" ? "bg-orange-600 text-white" : "bg-gray-800 text-muted hover:bg-gray-700"}`}
              onClick={() => { setSource("curseforge"); search(); }}
            >
              CurseForge
            </button>
          </div>

          <Show when={error()}>
            <div class="p-2 bg-red-600/20 border border-red-600/40 rounded text-sm text-red-400">{error()}</div>
          </Show>

          <Show when={searching()}>
            <div class="flex-center py-8 gap-2">
              <i class="i-svg-spinners-6-dots-scale w-6 h-6" />
              <span class="text-muted">{t().modpackCompare.download.searching}</span>
            </div>
          </Show>

          <Show when={!searching() && results().length > 0}>
            <div class="flex-1 overflow-y-auto space-y-2">
              <For each={results()}>
                {(mod) => (
                  <div class="p-3 bg-gray-alpha-50 rounded-2xl hover:bg-gray-800 transition-colors duration-100">
                    <div class="flex items-start gap-3">
                      <Show when={sanitizeImageUrl(mod.icon_url)} fallback={
                        <div class="w-10 h-10 rounded bg-gray-700 flex-center">
                          <i class="i-hugeicons-package w-5 h-5 text-muted" />
                        </div>
                      }>
                        <img src={sanitizeImageUrl(mod.icon_url)} class="w-10 h-10 rounded" alt="" />
                      </Show>
                      <div class="flex-1 min-w-0">
                        <div class="font-medium truncate">{mod.name}</div>
                        <div class="text-xs text-muted truncate">{mod.version || mod.file_name}</div>
                      </div>
                      <button
                        class="btn-primary btn-sm"
                        onClick={() => download(mod)}
                        disabled={!!downloading() || !targetPath()}
                      >
                        <Show when={downloading() === mod.project_id} fallback={
                          <><i class="i-hugeicons-download-02 w-4 h-4" /> {t().modpackCompare.download.download}</>
                        }>
                          <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                        </Show>
                      </button>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
};
