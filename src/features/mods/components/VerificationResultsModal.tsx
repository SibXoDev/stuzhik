import { Show, For, Component } from "solid-js";
import type { Mod } from "../../../shared/types";
import { ModalWrapper } from "../../../shared/ui";

interface VerificationSummary {
  verified: number;
  unverified: number;
  total: number;
}

interface VerificationResultsModalProps {
  summary: VerificationSummary;
  unverifiedMods: Mod[];
  onClose: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: () => any;
}

export const VerificationResultsModal: Component<VerificationResultsModalProps> = (props) => {
  const t = () => props.t();

  return (
    <ModalWrapper
      backdrop
      maxWidth="max-w-lg"
      onBackdropClick={props.onClose}
    >
      <div class="bg-gray-850 rounded-xl overflow-hidden">
        <div class="flex items-center gap-3 px-5 py-4 border-b border-gray-700">
          <i class={`w-6 h-6 ${
            props.summary.unverified === 0
              ? "i-hugeicons-security-check text-green-400"
              : "i-hugeicons-alert-02 text-yellow-400"
          }`} />
          <h3 class="text-lg font-medium text-white">
            {t().mods?.verification?.results?.title || "Verification Results"}
          </h3>
        </div>

        <div class="p-5">
          <p class="text-sm text-gray-300 mb-4">
            {props.summary.unverified === 0
              ? (t().mods?.verification?.results?.allVerified || "All mods are verified and authentic")
              : (t().mods?.verification?.results?.someUnverified || "Some mods were not found in official sources")}
          </p>

          <div class="flex gap-4 mb-4">
            <div class="flex-1 p-4 bg-green-500/10 rounded-lg border border-green-500/20">
              <div class="flex items-center gap-2 mb-1">
                <i class="i-hugeicons-security-check w-5 h-5 text-green-400" />
                <span class="text-sm font-medium text-green-400">
                  {t().mods?.verification?.results?.verifiedCount || "Verified"}
                </span>
              </div>
              <div class="text-2xl font-bold text-white">
                {props.summary.verified}
              </div>
            </div>

            <div class="flex-1 p-4 bg-yellow-500/10 rounded-lg border border-yellow-500/20">
              <div class="flex items-center gap-2 mb-1">
                <i class="i-hugeicons-alert-02 w-5 h-5 text-yellow-400" />
                <span class="text-sm font-medium text-yellow-400">
                  {t().mods?.verification?.results?.unverifiedCount || "Not found"}
                </span>
              </div>
              <div class="text-2xl font-bold text-white">
                {props.summary.unverified}
              </div>
            </div>
          </div>

          {/* List of unverified mods */}
          <Show when={props.summary.unverified > 0}>
            <div class="max-h-64 overflow-y-auto space-y-1.5">
              <For each={props.unverifiedMods}>
                {(mod) => (
                  <div class="px-3 py-2.5 bg-gray-800 rounded-lg flex items-center gap-2">
                    <i class="i-hugeicons-file-01 w-4 h-4 text-gray-500 flex-shrink-0" />
                    <span class="text-sm text-gray-300 truncate">{mod.file_name}</span>
                    <span class="text-xs text-gray-500 ml-auto flex-shrink-0">
                      {t().mods?.verification?.status?.unknown || "Источник неизвестен"}
                    </span>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>

        <div class="flex justify-end px-5 py-4 border-t border-gray-700 bg-gray-800/50">
          <button
            onClick={props.onClose}
            class="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg transition-colors"
          >
            {t().mods?.verification?.results?.close || "Close"}
          </button>
        </div>
      </div>
    </ModalWrapper>
  );
};
