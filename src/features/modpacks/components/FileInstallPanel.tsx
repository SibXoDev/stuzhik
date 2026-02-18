import { Show, Accessor } from "solid-js";
import type { ModpackFilePreview } from "../../../shared/types";

interface FileInstallPanelProps {
  filePath: Accessor<string>;
  fileInstanceName: Accessor<string>;
  filePreview: Accessor<ModpackFilePreview | null>;
  filePreviewLoading: Accessor<boolean>;
  filePreviewError: Accessor<string | null>;
  installing: Accessor<boolean>;
  onSelectFile: () => void;
  onClearFile: () => void;
  onSetInstanceName: (name: string) => void;
  onShowDetailedPreview: () => void;
  onInstall: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: () => any;
}

export function FileInstallPanel(props: FileInstallPanelProps) {
  const t = () => props.t();

  return (
    <div class="card flex flex-col gap-4">
      <p class="text-sm text-muted">
        {t().modpacks.browser.file.supportedFormats} <strong>.mrpack</strong> (Modrinth), <strong>.zip</strong> (CurseForge), <strong>.stzhk</strong> (Stuzhik)
      </p>

      <div class="flex flex-col gap-2">
        <span class="text-sm text-muted block">{t().modpacks.browser.file.modpackFile}</span>
        <div class="flex gap-2">
          <button
            class="btn-secondary flex-1 justify-start text-left"
            onClick={props.onSelectFile}
          >
            <i class="i-hugeicons-folder-01 w-4 h-4 flex-shrink-0" />
            <span class="truncate">
              {props.filePath() || t().modpacks.browser.file.selectFile}
            </span>
          </button>
          <Show when={props.filePath()}>
            <button
              class="btn-ghost px-2"
              onClick={props.onClearFile}
              title={t().modpacks.browser.file.clear}
            >
              <i class="i-hugeicons-cancel-01 w-4 h-4" />
            </button>
          </Show>
        </div>
      </div>

      {/* Preview loading */}
      <Show when={props.filePreviewLoading()}>
        <div class="flex-center gap-2 py-4">
          <i class="i-svg-spinners-6-dots-scale w-5 h-5" />
          <span class="text-muted text-sm">{t().modpacks.browser.file.reading}</span>
        </div>
      </Show>

      {/* Preview error */}
      <Show when={props.filePreviewError()}>
        <div class="card bg-yellow-600/10 border-yellow-600/30">
          <p class="text-yellow-400 text-sm inline-flex items-center gap-1">
            <i class="i-hugeicons-alert-02 w-4 h-4" />
            {t().modpacks.browser.file.readError}
          </p>
        </div>
      </Show>

      {/* Preview info */}
      <Show when={props.filePreview()}>
        <div class="card bg-gray-alpha-50 space-y-3">
          <div class="flex items-start justify-between">
            <div>
              <h4 class="font-semibold text-lg">{props.filePreview()!.name}</h4>
              <p class="text-sm text-muted">{props.filePreview()!.summary || `Версия ${props.filePreview()!.version}`}</p>
            </div>
            <span class={`badge ${
              props.filePreview()!.format === "modrinth" ? "badge-success" :
              props.filePreview()!.format === "stzhk" ? "bg-cyan-600/20 text-cyan-400 border-cyan-600/30" :
              "bg-orange-600/20 text-orange-400 border-orange-600/30"
            }`}>
              {props.filePreview()!.format === "modrinth" ? "Modrinth" :
               props.filePreview()!.format === "stzhk" ? "Stuzhik" : "CurseForge"}
            </span>
          </div>

          <div class="grid grid-cols-3 gap-3 text-center">
            <div class="card bg-gray-alpha-50">
              <p class="text-xs text-dimmer">{t().modpacks.browser.file.minecraft}</p>
              <p class="font-medium">{props.filePreview()!.minecraft_version}</p>
            </div>
            <div class="card bg-gray-alpha-50">
              <p class="text-xs text-dimmer">{t().modpacks.browser.file.loader}</p>
              <p class="font-medium">{props.filePreview()!.loader}</p>
              <Show when={props.filePreview()!.loader_version}>
                <p class="text-xs text-muted">{props.filePreview()!.loader_version}</p>
              </Show>
            </div>
            <div class="card bg-gray-alpha-50">
              <p class="text-xs text-dimmer">{t().modpacks.browser.file.modsCount}</p>
              <p class="font-medium">
                {props.filePreview()!.mod_count + props.filePreview()!.overrides_mods_count}
              </p>
              <Show when={props.filePreview()!.overrides_mods_count > 0}>
                <p class="text-xs text-muted">
                  ({props.filePreview()!.mod_count} {t().modpacks.browser.file.inManifest} + {props.filePreview()!.overrides_mods_count} {t().modpacks.browser.file.inOverrides})
                </p>
              </Show>
            </div>
          </div>
        </div>
      </Show>

      <label class="flex flex-col gap-1">
        <span class="text-sm text-muted">{t().modpacks.browser.confirm.instanceName}</span>
        <input
          type="text"
          value={props.fileInstanceName()}
          onInput={(e) => props.onSetInstanceName(e.currentTarget.value)}
          class="w-full"
          placeholder={t().ui.placeholders.myModpack}
        />
      </label>

      <div class="flex gap-2">
        <button
          class="btn-secondary flex-1"
          onClick={props.onShowDetailedPreview}
          disabled={!props.filePath() || props.installing() || props.filePreviewLoading()}
          title={t().modpacks.browser.file.details}
        >
          <i class="i-hugeicons-view w-4 h-4" />
          {t().modpacks.browser.file.details}
        </button>
        <button
          class="btn-primary flex-1"
          onClick={props.onInstall}
          disabled={!props.filePath() || !props.fileInstanceName() || props.installing() || props.filePreviewLoading()}
        >
          <i class="i-hugeicons-download-02 w-4 h-4" />
          {t().modpacks.browser.file.install}
        </button>
      </div>
    </div>
  );
}
