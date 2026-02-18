import { Show, For } from "solid-js";
import type { Accessor } from "solid-js";
import { ModalWrapper } from "../../../shared/ui";
import type { ModRemovalAnalysis } from "./graphTypes";

interface Props {
  analysis: Accessor<ModRemovalAnalysis | null>;
  onClose: () => void;
  t: Accessor<Record<string, any>>;
}

export default function RemovalAnalysisDialog(props: Props) {
  const tg = () => props.t().mods?.dependencyGraph;

  return (
    <ModalWrapper backdrop onBackdropClick={props.onClose}>
      <div class="w-[480px] bg-gray-850 rounded-xl overflow-hidden">
        <div class="flex items-center gap-3 px-5 py-4 border-b border-gray-700">
          <i
            class={`w-6 h-6 ${
              props.analysis()!.is_safe
                ? "i-hugeicons-checkmark-circle-02 text-green-400"
                : "i-hugeicons-alert-02 text-yellow-400"
            }`}
          />
          <h3 class="text-lg font-medium text-white">
            {tg()?.removal?.title || "Removal Analysis"}
          </h3>
        </div>

        <div class="p-5">
          <p class="text-sm text-gray-300 mb-4">
            {props.analysis()!.is_safe
              ? (tg()?.removal?.safe || "This mod can be safely removed without breaking other mods.")
              : (tg()?.removal?.unsafe || "Removing this mod may cause issues with other mods.")}
          </p>

          <Show when={props.analysis()!.affected_mods.length > 0}>
            <div class="mb-4">
              <h4 class="text-sm font-medium text-red-400 mb-2 flex items-center gap-2">
                <i class="i-hugeicons-alert-02 w-4 h-4" />
                {tg()?.removal?.willBreak || "Will Break"} ({props.analysis()!.affected_mods.length} {tg()?.removal?.modsCount || "mods"})
              </h4>
              <div class="space-y-2 max-h-40 overflow-y-auto">
                <For each={props.analysis()!.affected_mods}>
                  {(mod) => (
                    <div class="p-3 bg-red-500/10 rounded-lg border border-red-500/20">
                      <div class="font-medium text-white text-sm">{mod.name}</div>
                      <div class="text-xs text-gray-400 mt-0.5">{mod.reason}</div>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </Show>

          <Show when={props.analysis()!.warning_mods.length > 0}>
            <div>
              <h4 class="text-sm font-medium text-yellow-400 mb-2 flex items-center gap-2">
                <i class="i-hugeicons-alert-02 w-4 h-4" />
                {tg()?.removal?.mayHaveIssues || "May Have Issues"} ({props.analysis()!.warning_mods.length} {tg()?.removal?.modsCount || "mods"})
              </h4>
              <div class="space-y-2 max-h-40 overflow-y-auto">
                <For each={props.analysis()!.warning_mods}>
                  {(mod) => (
                    <div class="p-3 bg-yellow-500/10 rounded-lg border border-yellow-500/20">
                      <div class="font-medium text-white text-sm">{mod.name}</div>
                      <div class="text-xs text-gray-400 mt-0.5">{mod.reason}</div>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </Show>
        </div>

        <div class="flex justify-end px-5 py-4 border-t border-gray-700 bg-gray-800/50">
          <button
            onClick={props.onClose}
            class="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg transition-colors"
          >
            {tg()?.removal?.close || "Close"}
          </button>
        </div>
      </div>
    </ModalWrapper>
  );
}
