import { createSignal, Show, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { ModalWrapper } from "../../../shared/ui/ModalWrapper";
import { useI18n } from "../../../shared/i18n";
import { addToast } from "../../../shared/components/Toast";
import type { Instance } from "../../../shared/types/common.types";

interface ConversionProgress {
  stage: string;
  message: string;
  disabled_mods?: number;
}

interface Props {
  instance: Instance;
  onClose: () => void;
  onConverted: (instance: Instance) => void;
}

export default function ConvertToServerDialog(props: Props) {
  const { t } = useI18n();

  const [port, setPort] = createSignal(25565);
  const [converting, setConverting] = createSignal(false);
  const [progress, setProgress] = createSignal<ConversionProgress | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  // Listen for progress events
  let unlisten: UnlistenFn | null = null;

  const setupProgressListener = async () => {
    unlisten = await listen<ConversionProgress>("conversion-progress", (event) => {
      setProgress(event.payload);
    });
  };

  onCleanup(() => {
    if (unlisten) unlisten();
  });

  const handleConvert = async () => {
    setConverting(true);
    setError(null);
    setProgress(null);

    // Clean up previous listener if any
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
    await setupProgressListener();

    try {
      const result = await invoke<Instance>("convert_client_to_server", {
        instanceId: props.instance.id,
        port: port(),
      });

      // Show success toast
      const disabledMods = progress()?.disabled_mods ?? 0;
      addToast({
        type: "success",
        title: t().instances?.conversion?.success ?? "Instance converted to server",
        message: disabledMods > 0
          ? `${t().instances?.conversion?.successMods ?? "Client-only mods disabled"}: ${disabledMods}`
          : undefined,
        duration: 5000,
      });

      props.onConverted(result);
      props.onClose();
    } catch (e) {
      const errorMsg = String(e);
      setError(errorMsg);

      addToast({
        type: "error",
        title: t().instances?.conversion?.title ?? "Conversion failed",
        message: errorMsg,
        duration: 5000,
      });
    } finally {
      setConverting(false);
      // Type assertion needed because TypeScript doesn't track reassignment in async setupProgressListener()
      const unlistenFn = unlisten as UnlistenFn | null;
      if (unlistenFn) {
        unlistenFn();
        unlisten = null;
      }
    }
  };

  // Get localized progress message
  const progressMessage = () => {
    const p = progress();
    if (!p) return null;

    const stage = p.stage;
    const translations = t().instances?.conversion?.progress as Record<string, string> | undefined;
    return translations?.[stage] ?? p.message;
  };

  return (
    <ModalWrapper maxWidth="max-w-md" backdrop>
      <div class="p-4">
        {/* Header */}
        <div class="flex items-center justify-between mb-4">
          <div class="flex flex-col gap-1">
            <h2 class="text-xl font-bold">{t().instances?.conversion?.title ?? "Convert to Server"}</h2>
            <p class="text-sm text-muted">{props.instance.name}</p>
          </div>
          <button
            class="btn-close"
            onClick={props.onClose}
            disabled={converting()}
            aria-label={t().ui?.tooltips?.close ?? "Close"}
          >
            <i class="i-hugeicons-cancel-01 w-5 h-5" />
          </button>
        </div>

        {/* Warning */}
        <div class="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 mb-4 flex items-start gap-3">
          <i class="i-hugeicons-alert-02 w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
          <div class="text-sm">
            <p class="text-amber-400 font-medium">{t().instances?.conversion?.warning ?? "Warning"}</p>
            <p class="text-muted mt-1">
              {t().instances?.conversion?.warningText ?? "Client-only mods will be automatically disabled. You will need to accept EULA before first launch."}
            </p>
          </div>
        </div>

        <Show when={error()}>
          <div class="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-4">
            <p class="text-red-400 text-sm">{error()}</p>
          </div>
        </Show>

        {/* Port input */}
        <div class="mb-4">
          <label class="block text-sm font-medium mb-2">
            {t().instances?.conversion?.port ?? "Server Port"}
          </label>
          <input
            type="number"
            value={port()}
            onInput={(e) => setPort(parseInt(e.currentTarget.value) || 25565)}
            min={1024}
            max={65535}
            disabled={converting()}
            class="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm focus:outline-none focus:border-[var(--color-primary)] transition-colors disabled:opacity-50"
          />
          <p class="text-xs text-muted mt-1">
            {t().instances?.conversion?.portHint ?? "Default port: 25565"}
          </p>
        </div>

        {/* Progress */}
        <Show when={converting() && progressMessage()}>
          <div class="mb-4 p-3 bg-gray-800/50 rounded-lg">
            <div class="flex items-center gap-2">
              <i class="i-svg-spinners-6-dots-scale w-4 h-4 text-[var(--color-primary)]" />
              <span class="text-sm">{progressMessage()}</span>
            </div>
          </div>
        </Show>

        {/* Actions */}
        <div class="flex justify-end gap-2 pt-4 border-t border-gray-750">
          <button
            class="btn-ghost"
            onClick={props.onClose}
            disabled={converting()}
          >
            {t().ui?.buttons?.cancel ?? "Cancel"}
          </button>
          <button
            class="btn-primary"
            onClick={handleConvert}
            disabled={converting()}
          >
            <Show when={converting()} fallback={
              <>
                <i class="i-hugeicons-hard-drive w-4 h-4" />
                {t().instances?.conversion?.convert ?? "Convert"}
              </>
            }>
              <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
              {t().instances?.conversion?.converting ?? "Converting..."}
            </Show>
          </button>
        </div>
      </div>
    </ModalWrapper>
  );
}
