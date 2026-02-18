import { Show, For, Accessor } from "solid-js";
import type { ModpackInstallSummary, FailedModInfo, ModSearchInfo } from "../../../shared/types";
import { sanitizeImageUrl } from "../../../shared/utils/url-validator";
import { createFocusTrap } from "../../../shared/hooks";

export type ModResolutionStatus = "idle" | "searching" | "found" | "not_found" | "installing" | "installed" | "error";

export interface ModResolution {
  status: ModResolutionStatus;
  results: ModSearchInfo[];
  selectedIndex: number;
  error?: string;
}

interface InstallSummaryDialogProps {
  installSummary: Accessor<ModpackInstallSummary | null>;
  modResolutions: Accessor<Record<string, ModResolution>>;
  setModResolutions: (fn: (prev: Record<string, ModResolution>) => Record<string, ModResolution>) => void;
  resolvedCount: () => number;
  installedResolvedCount: () => number;
  onAutoSearch: (summary: ModpackInstallSummary) => void;
  onInstallMod: (failedMod: FailedModInfo, result: ModSearchInfo) => void;
  onInstallAll: () => void;
  onDismiss: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: () => any;
}

export function InstallSummaryDialog(props: InstallSummaryDialogProps) {
  const t = () => props.t();
  const summary = () => props.installSummary()!;
  let dialogRef: HTMLDivElement | undefined;
  createFocusTrap(() => dialogRef);

  return (
    <div class="fixed inset-0 bg-black/70 backdrop-blur-sm z-60 flex items-center justify-center p-4">
      <div ref={dialogRef} tabIndex={-1} class="card max-w-2xl w-full max-h-[85vh] flex flex-col">
        <h3 class="text-lg font-semibold mb-4 flex items-center gap-2 flex-shrink-0">
          <i class="i-hugeicons-alert-02 w-5 h-5 text-yellow-500" />
          {t().modpacks.browser.summary.title}
        </h3>

        <div class="flex-1 overflow-y-auto min-h-0 space-y-4">
          {/* Modrinth warning section */}
          <Show when={summary().from_modrinth.length > 0}>
            <div class="p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-2xl">
              <p class="text-sm font-medium text-yellow-400 mb-2">
                {t().modpacks.browser.summary.modrinthWarning}
                <br />
                <span class="text-yellow-500/80">{t().modpacks.browser.summary.modrinthWarningNote}</span>
              </p>
              <ul class="text-xs text-muted space-y-1 max-h-32 overflow-y-auto">
                <For each={summary().from_modrinth}>
                  {(mod) => <li class="truncate">• {mod}</li>}
                </For>
              </ul>
            </div>
          </Show>

          {/* Failed mods — interactive resolution */}
          <Show when={summary().failed.length > 0}>
            <div class="p-3 bg-red-500/10 border border-red-500/30 rounded-2xl">
              <p class="text-sm font-medium text-red-400 mb-2">
                {t().modpacks.browser.summary.failedMods}
              </p>
              <p class="text-xs text-muted mb-3">
                {t().modpacks.browser.summary.failedModsHint}
              </p>

              <div class="space-y-2 max-h-[40vh] overflow-y-auto">
                <For each={summary().failed}>
                  {(failedMod) => {
                    const resolution = () => props.modResolutions()[failedMod.file_name];
                    const status = () => resolution()?.status ?? "idle";
                    const searchResults = () => resolution()?.results ?? [];
                    const selectedResult = () => {
                      const r = resolution();
                      if (!r || r.results.length === 0) return null;
                      return r.results[r.selectedIndex];
                    };

                    return (
                      <div class="bg-gray-800/50 rounded-xl p-3">
                        <div class="flex items-center gap-3">
                          {/* Mod icon or status indicator */}
                          <div class="flex-shrink-0 w-8 h-8 rounded-lg bg-gray-700 flex items-center justify-center">
                            <Show
                              when={status() === "found" && selectedResult()?.icon_url}
                              fallback={
                                <Show
                                  when={status() === "installed"}
                                  fallback={
                                    <Show
                                      when={status() === "searching"}
                                      fallback={<i class="i-hugeicons-package w-4 h-4 text-gray-400" />}
                                    >
                                      <i class="i-svg-spinners-ring-resize w-4 h-4 text-[var(--color-primary)]" />
                                    </Show>
                                  }
                                >
                                  <i class="i-hugeicons-checkmark-circle-02 w-4 h-4 text-green-400" />
                                </Show>
                              }
                            >
                              <img
                                src={sanitizeImageUrl(selectedResult()?.icon_url) ?? ""}
                                class="w-8 h-8 rounded-lg object-cover"
                                alt=""
                              />
                            </Show>
                          </div>

                          {/* Mod name and status */}
                          <div class="flex-1 min-w-0">
                            <div class="flex items-center gap-2">
                              <span class="text-sm font-medium truncate">
                                {failedMod.display_name}
                              </span>
                              <Show when={status() === "installed"}>
                                <span class="text-[10px] px-1.5 py-0.5 bg-green-500/20 text-green-400 rounded-md">
                                  {t().modpacks.browser.summary.installed}
                                </span>
                              </Show>
                              <Show when={status() === "not_found"}>
                                <span class="text-[10px] px-1.5 py-0.5 bg-gray-700 text-gray-400 rounded-md">
                                  {t().modpacks.browser.summary.notFound}
                                </span>
                              </Show>
                            </div>
                            <div class="text-[10px] text-dimmer truncate">
                              {failedMod.file_name}
                            </div>
                            {/* Show found result name if different from display_name */}
                            <Show when={status() === "found" && selectedResult()}>
                              <div class="flex items-center gap-1 mt-1">
                                <Show when={selectedResult()!.source === "modrinth"}>
                                  <i class="i-simple-icons-modrinth w-3 h-3 text-green-500" />
                                </Show>
                                <Show when={selectedResult()!.source === "curseforge"}>
                                  <i class="i-simple-icons-curseforge w-3 h-3 text-orange-500" />
                                </Show>
                                <span class="text-[10px] text-muted truncate">
                                  {selectedResult()!.name}
                                  <Show when={selectedResult()!.version}>
                                    {" "}({selectedResult()!.version})
                                  </Show>
                                </span>
                                {/* Switch between results if multiple */}
                                <Show when={searchResults().length > 1}>
                                  <button
                                    class="text-[10px] text-[var(--color-primary)] hover:text-[var(--color-primary-light)] ml-1"
                                    onClick={() => {
                                      const r = resolution();
                                      if (!r) return;
                                      const next = (r.selectedIndex + 1) % r.results.length;
                                      props.setModResolutions((prev) => ({
                                        ...prev,
                                        [failedMod.file_name]: { ...prev[failedMod.file_name], selectedIndex: next },
                                      }));
                                    }}
                                  >
                                    ({(resolution()?.selectedIndex ?? 0) + 1}/{searchResults().length})
                                  </button>
                                </Show>
                              </div>
                            </Show>
                          </div>

                          {/* Action button */}
                          <div class="flex-shrink-0">
                            <Show when={status() === "searching"}>
                              <span class="text-xs text-muted">
                                {t().modpacks.browser.summary.searchingMod}
                              </span>
                            </Show>
                            <Show when={status() === "found"}>
                              <button
                                class="btn-primary btn-sm text-xs"
                                onClick={() => {
                                  const result = selectedResult();
                                  if (result) props.onInstallMod(failedMod, result);
                                }}
                              >
                                {t().modpacks.browser.summary.installMod}
                              </button>
                            </Show>
                            <Show when={status() === "installing"}>
                              <span class="text-xs text-[var(--color-primary)] flex items-center gap-1">
                                <i class="i-svg-spinners-ring-resize w-3 h-3" />
                                {t().modpacks.browser.summary.installingMod}
                              </span>
                            </Show>
                            <Show when={status() === "error"}>
                              <button
                                class="text-xs text-red-400 hover:text-red-300"
                                onClick={() => {
                                  const s = props.installSummary();
                                  if (s) props.onAutoSearch(s);
                                }}
                              >
                                {t().modpacks.browser.summary.retrySearch}
                              </button>
                            </Show>
                          </div>
                        </div>
                      </div>
                    );
                  }}
                </For>
              </div>

              {/* Batch actions */}
              <Show when={props.resolvedCount() > props.installedResolvedCount() && props.resolvedCount() > 0}>
                <div class="flex justify-end mt-3 pt-3 border-t border-gray-700/50">
                  <button
                    class="btn-primary btn-sm text-xs"
                    onClick={props.onInstallAll}
                  >
                    <i class="i-hugeicons-download-02 w-3.5 h-3.5" />
                    {t().modpacks.browser.summary.installAll} ({props.resolvedCount() - props.installedResolvedCount()})
                  </button>
                </div>
              </Show>
            </div>
          </Show>
        </div>

        {/* Footer */}
        <div class="flex-shrink-0 pt-4 space-y-3">
          <div class="text-xs text-dimmer">
            {t().modpacks.browser.summary.totalMods}: {summary().total_mods} |
            CurseForge: {summary().from_curseforge.length} |
            Modrinth: {summary().from_modrinth.length} |
            {t().modpacks.browser.summary.notDownloaded}: {summary().failed.length}
            <Show when={props.installedResolvedCount() > 0}>
              {" "}| {t().modpacks.browser.summary.installed}: {props.installedResolvedCount()}
            </Show>
          </div>

          <button class="btn-primary w-full" onClick={props.onDismiss}>
            {t().modpacks.browser.summary.understood}
          </button>
        </div>
      </div>
    </div>
  );
}
