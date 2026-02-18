import { Show, For, Component } from "solid-js";
import type { ModInfo } from "../../../shared/types";
import { Tooltip } from "../../../shared/ui";

export interface DownloadState {
  downloading: Set<string>;
  completed: Set<string>;
  failed: Set<string>;
}

interface CompareModListProps {
  mods: ModInfo[];
  variant: "purple" | "blue" | "green";
  icon: string;
  title: string;
  onDownload?: (mod: ModInfo) => void;
  downloadState?: DownloadState;
  fmtSize: (bytes: number) => string;
  downloadTooltip?: string;
  downloadedTooltip?: string;
  failedTooltip?: string;
}

export const CompareModList: Component<CompareModListProps> = (props) => {
  const bgClass = () => {
    switch (props.variant) {
      case "purple": return "bg-purple-600/10 border-purple-600/30";
      case "blue": return "bg-blue-600/10 border-blue-600/30";
      case "green": return "bg-green-600/10 border-green-600/30";
    }
  };

  const textClass = () => {
    switch (props.variant) {
      case "purple": return "text-purple-400";
      case "blue": return "text-blue-400";
      case "green": return "text-green-400";
    }
  };

  return (
    <div class="space-y-2">
      <Show when={props.title}>
        <h3 class={`text-sm font-medium ${textClass()} flex items-center gap-2`}>
          <i class={`${props.icon} w-4 h-4`} />
          {props.title} ({props.mods.length})
        </h3>
      </Show>
      <div class="grid gap-1 max-h-64 overflow-y-auto">
        <For each={props.mods}>
          {(mod) => {
            const isDownloading = () => props.downloadState?.downloading.has(mod.name);
            const isCompleted = () => props.downloadState?.completed.has(mod.name);
            const isFailed = () => props.downloadState?.failed.has(mod.name);

            return (
              <div class={`flex items-center justify-between p-2 rounded border ${bgClass()}`}>
                <div class="min-w-0 flex-1">
                  <span class="font-medium truncate block">{mod.name}</span>
                  <Show when={mod.version}>
                    <span class="text-xs text-muted">{mod.version}</span>
                  </Show>
                </div>
                <div class="flex items-center gap-2">
                  <span class="text-xs text-muted whitespace-nowrap">{props.fmtSize(mod.size)}</span>
                  <Show when={props.onDownload}>
                    <Show when={isCompleted()} fallback={
                      <Show when={isFailed()} fallback={
                        <Tooltip text={props.downloadTooltip || ""} position="bottom">
                          <button
                            class="btn-ghost btn-sm p-1"
                            onClick={() => props.onDownload?.(mod)}
                            disabled={isDownloading()}
                          >
                            <Show when={isDownloading()} fallback={
                              <i class="i-hugeicons-download-02 w-4 h-4 text-green-400" />
                            }>
                              <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                            </Show>
                          </button>
                        </Tooltip>
                      }>
                        <Tooltip text={props.failedTooltip || ""} position="bottom">
                          <i class="i-hugeicons-alert-02 w-4 h-4 text-red-400" />
                        </Tooltip>
                      </Show>
                    }>
                      <Tooltip text={props.downloadedTooltip || ""} position="bottom">
                        <i class="i-hugeicons-checkmark-circle-02 w-4 h-4 text-green-400" />
                      </Tooltip>
                    </Show>
                  </Show>
                </div>
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
};
