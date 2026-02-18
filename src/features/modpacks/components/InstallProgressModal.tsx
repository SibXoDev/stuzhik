import { Show, For, Accessor } from "solid-js";
import type { ModpackInstallProgress, DownloadProgress } from "../../../shared/types";
import { createFocusTrap } from "../../../shared/hooks";

interface InstallProgressModalProps {
  cancelling: Accessor<boolean>;
  installProgress: Accessor<ModpackInstallProgress | null>;
  instanceInstallStep: Accessor<string | null>;
  installedInstanceId: Accessor<string | null>;
  downloads: Accessor<DownloadProgress[]>;
  operationId: Accessor<string | null>;
  modpackOperationId: Accessor<string | null>;
  getProgressText: () => string;
  getProgressPercent: () => number;
  onCancel: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: () => any;
}

export function InstallProgressModal(props: InstallProgressModalProps) {
  const t = () => props.t();
  let dialogRef: HTMLDivElement | undefined;
  createFocusTrap(() => dialogRef);

  return (
    <div class="fixed inset-0 bg-black/70 backdrop-blur-sm z-60 flex items-center justify-center">
      <div ref={dialogRef} tabIndex={-1} class="card max-w-lg w-full text-center p-8">
        <Show when={!props.cancelling()} fallback={
          <div class="flex flex-col items-center gap-2">
            <i class="i-svg-spinners-6-dots-scale w-12 h-12 mx-auto" />
            <h3 class="text-xl font-semibold">{t().modpacks.browser.cancelling}</h3>
            <p class="text-muted">{t().modpacks.browser.waitingForOperation}</p>
          </div>
        }>
          <div class="flex flex-col items-center gap-4">
            <h3 class="text-xl font-semibold">{t().modpacks.browser.title}</h3>

          {/* Unified progress indicator - all steps */}
          <div class="flex flex-wrap items-center justify-center gap-1.5 text-xs font-medium">
            {/* Модпак */}
            {(() => {
              const stage = props.installProgress()?.stage;
              const modpackDone = stage && stage !== "downloading";
              return <>
                <span class={`px-2.5 py-1 rounded-lg transition-all duration-100 ${
                  stage === "downloading"
                    ? "bg-[var(--color-primary)] text-white animate-pulse"
                    : modpackDone
                      ? "bg-green-600/20 text-green-400"
                      : "bg-gray-800 text-gray-500"
                }`}>{t().modpacks.browser.steps.modpack}</span>
                <span class={modpackDone ? "text-green-400" : "text-gray-600"}>→</span>
              </>;
            })()}

            {/* Моды */}
            {(() => {
              const stage = props.installProgress()?.stage;
              const modsActive = stage === "resolving_mods" || stage === "downloading_mods";
              const modsDone = stage === "extracting_overrides" || stage === "completed";
              return <>
                <span class={`px-2.5 py-1 rounded-lg transition-all duration-100 ${
                  modsActive
                    ? "bg-[var(--color-primary)] text-white animate-pulse"
                    : modsDone
                      ? "bg-green-600/20 text-green-400"
                      : "bg-gray-800 text-gray-500"
                }`}>{t().modpacks.browser.steps.mods}</span>
                <span class={modsDone ? "text-green-400" : "text-gray-600"}>→</span>
              </>;
            })()}

            {/* Распаковка */}
            {(() => {
              const stage = props.installProgress()?.stage;
              const extractDone = stage === "completed";
              return <>
                <span class={`px-2.5 py-1 rounded-lg transition-all duration-100 ${
                  stage === "extracting_overrides"
                    ? "bg-[var(--color-primary)] text-white animate-pulse"
                    : extractDone
                      ? "bg-green-600/20 text-green-400"
                      : "bg-gray-800 text-gray-500"
                }`}>{t().modpacks.browser.steps.files}</span>
                <span class={extractDone ? "text-green-400" : "text-gray-600"}>→</span>
              </>;
            })()}

            {/* Java + Minecraft */}
            {(() => {
              const step = props.instanceInstallStep();
              const active = step === "java" || step === "minecraft";
              const done = step === "loader" || step === "complete";
              return <>
                <span class={`px-2.5 py-1 rounded-lg transition-all duration-100 ${
                  active
                    ? "bg-[var(--color-primary)] text-white animate-pulse"
                    : done
                      ? "bg-green-600/20 text-green-400"
                      : "bg-gray-800 text-gray-500"
                }`}>{t().modpacks.browser.steps.javaMc}</span>
                <span class={done ? "text-green-400" : "text-gray-600"}>→</span>
              </>;
            })()}

            {/* Загрузчик */}
            {(() => {
              const step = props.instanceInstallStep();
              const done = step === "complete";
              return <>
                <span class={`px-2.5 py-1 rounded-lg transition-all duration-100 ${
                  step === "loader"
                    ? "bg-[var(--color-primary)] text-white animate-pulse"
                    : done
                      ? "bg-green-600/20 text-green-400"
                      : "bg-gray-800 text-gray-500"
                }`}>{t().modpacks.browser.steps.loader}</span>
                <span class={done && props.installedInstanceId() ? "text-green-400" : "text-gray-600"}>→</span>
              </>;
            })()}

            {/* Готово */}
            <span class={`px-2.5 py-1 rounded-lg transition-all duration-100 ${
              props.instanceInstallStep() === "complete" && props.installedInstanceId()
                ? "bg-green-600 text-white"
                : "bg-gray-800 text-gray-500"
            }`}>{t().modpacks.browser.steps.done}</span>
          </div>

          {/* Current step details */}
          <p class="text-muted text-sm">{props.getProgressText()}</p>

          {/* Progress bar for mod downloads */}
          <Show when={props.installProgress()?.stage === "downloading_mods"}>
            <div class="w-full bg-gray-800 rounded-full h-2">
              <div
                class="bg-[var(--color-primary)] h-2 rounded-full transition-all duration-100"
                style={{ width: `${props.getProgressPercent()}%` }}
              />
            </div>
          </Show>

          {/* Active downloads */}
          <Show when={props.downloads().length > 0}>
            <div class="max-h-32 overflow-y-auto text-left space-y-2">
              <For each={props.downloads()}>
                {(dl) => {
                  const isFailed = () => dl.status === "failed" || dl.status === "stalled";
                  return (
                    <div class={`bg-gray-800/50 rounded-xl p-2 flex flex-col gap-1 ${isFailed() ? "opacity-60" : ""}`}>
                      <div class="flex items-center justify-between gap-2 text-xs">
                        <div class="flex items-center gap-1.5 min-w-0 flex-1">
                          <Show when={isFailed()} fallback={
                            <>
                              <Show when={dl.source === "modrinth"}>
                                <i class="i-simple-icons-modrinth w-3 h-3 flex-shrink-0 text-green-400" />
                              </Show>
                              <Show when={dl.source === "curseforge"}>
                                <i class="i-simple-icons-curseforge w-3 h-3 flex-shrink-0 text-orange-400" />
                              </Show>
                            </>
                          }>
                            <i class="i-hugeicons-alert-02 w-3 h-3 flex-shrink-0 text-red-400" />
                          </Show>
                          <span class={`truncate ${isFailed() ? "text-red-400" : "text-gray-300"}`}>{dl.name}</span>
                        </div>
                        <span class={`${isFailed() ? "text-red-400" : "text-dimmer"}`}>
                          {isFailed() ? (dl.status === "stalled" ? "stalled" : "error") : dl.total > 0 ? `${((dl.downloaded / dl.total) * 100).toFixed(0)}%` : "..."}
                        </span>
                      </div>
                      <div class="w-full bg-gray-800 rounded-full h-1">
                        <div
                          class={`h-1 rounded-full transition-all duration-100 ${isFailed() ? "bg-red-500" : "bg-[var(--color-primary)]"}`}
                          style={{ width: `${dl.total > 0 ? (dl.downloaded / dl.total) * 100 : 0}%` }}
                        />
                      </div>
                      <Show when={dl.speed > 0}>
                        <div class="text-[10px] text-dimmer">
                          {(dl.speed / (1024 * 1024)).toFixed(1)} MB/s
                        </div>
                      </Show>
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>

          <button
            class="btn-secondary"
            onClick={props.onCancel}
            disabled={props.cancelling() || (!props.operationId() && !props.modpackOperationId())}
          >
            <i class="i-hugeicons-cancel-01 w-4 h-4" />
            {(props.operationId() || props.modpackOperationId()) ? t().modpacks.browser.cancel : t().modpacks.browser.waiting}
          </button>
          </div>
        </Show>
      </div>
    </div>
  );
}
