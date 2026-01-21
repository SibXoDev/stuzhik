import { createSignal, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../i18n";
import { ModalWrapper } from "../ui/ModalWrapper";
import { formatSize } from "../utils/format-size";

export interface ConsentRequest {
  request_id: string;
  peer_id: string;
  peer_nickname: string | null;
  request_type: "modpack" | "config" | "resourcepack" | "shaderpack";
  content_name: string;
  content_size?: number;
}

interface ConsentDialogProps {
  request: ConsentRequest;
  onResponse: (approved: boolean, remember: boolean) => void;
  onClose: () => void;
}

export function ConsentDialog(props: ConsentDialogProps) {
  const { t } = useI18n();
  const [remember, setRemember] = createSignal(false);
  const [responding, setResponding] = createSignal(false);
  const fmtSize = (bytes: number) => formatSize(bytes, t().ui?.units);

  const handleResponse = async (approved: boolean) => {
    setResponding(true);
    try {
      await invoke("respond_to_consent", {
        requestId: props.request.request_id,
        approved,
        remember: remember(),
      });
      props.onResponse(approved, remember());
    } catch (e) {
      console.error("Failed to respond to consent:", e);
    } finally {
      setResponding(false);
      props.onClose();
    }
  };

  const getRequestTypeIcon = () => {
    switch (props.request.request_type) {
      case "modpack": return "i-hugeicons-package";
      case "config": return "i-hugeicons-settings-02";
      case "resourcepack": return "i-hugeicons-image-01";
      case "shaderpack": return "i-hugeicons-bulb";
      default: return "i-hugeicons-file-01";
    }
  };

  const getRequestTypeLabel = () => {
    const types = t().connect.consent.types as Record<string, string>;
    return types[props.request.request_type] || props.request.request_type;
  };

  return (
    <ModalWrapper maxWidth="max-w-md" backdrop>
      <div class="overflow-hidden">
        {/* Header */}
        <div class="p-4 border-b border-gray-700 bg-gray-800/50">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-full bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center">
              <i class="i-hugeicons-alert-02 w-5 h-5 text-white" />
            </div>
            <div>
              <h2 class="font-semibold">{t().connect.consent.requestTitle}</h2>
              <p class="text-xs text-gray-400">
                {props.request.peer_nickname || t().connect.anonymous}
              </p>
            </div>
          </div>
        </div>

        {/* Content */}
        <div class="p-4 space-y-4">
          {/* Request description */}
          <div class="p-3 bg-gray-800/50 rounded-xl">
            <div class="flex items-center gap-3">
              <div class="w-10 h-10 rounded-lg bg-gray-700 flex items-center justify-center">
                <i class={`${getRequestTypeIcon()} w-5 h-5 text-gray-400`} />
              </div>
              <div class="flex-1 min-w-0">
                <p class="text-sm">
                  <span class="text-gray-400">{t().connect.consent.wantsToSend} </span>
                  <span class="font-medium">{getRequestTypeLabel()}</span>
                </p>
                <p class="text-sm font-medium truncate">{props.request.content_name}</p>
                <Show when={props.request.content_size}>
                  <p class="text-xs text-gray-500">{fmtSize(props.request.content_size!)}</p>
                </Show>
              </div>
            </div>
          </div>

          {/* Remember checkbox */}
          <label class="flex items-center gap-3 cursor-pointer group">
            <input
              type="checkbox"
              checked={remember()}
              onChange={(e) => setRemember(e.currentTarget.checked)}
            />
            <span class="text-sm text-gray-400 group-hover:text-gray-300">
              {t().connect.consent.rememberForPeer}
            </span>
          </label>

          {/* Warning */}
          <p class="text-xs text-gray-500">
            {t().connect.consent.warning}
          </p>
        </div>

        {/* Actions */}
        <div class="p-4 border-t border-gray-700 flex gap-3">
          <button
            class="btn-secondary flex-1"
            onClick={() => handleResponse(false)}
            disabled={responding()}
          >
            {t().connect.consent.deny}
          </button>
          <button
            class="btn-primary flex-1"
            onClick={() => handleResponse(true)}
            disabled={responding()}
          >
            <Show when={responding()} fallback={t().connect.consent.allow}>
              <i class="i-svg-spinners-ring-resize w-4 h-4" />
            </Show>
          </button>
        </div>
      </div>
    </ModalWrapper>
  );
}

export default ConsentDialog;
