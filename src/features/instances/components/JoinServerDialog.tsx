import { createSignal, Show, createEffect, onCleanup } from "solid-js";
import type { Component } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ModalWrapper } from "../../../shared/ui/ModalWrapper";

interface ServerInvite {
  id: string;
  code: string;
  server_instance_id: string;
  server_name: string;
  mc_version: string;
  loader: string;
  server_address: string;
  host_peer_id: string;
  created_at: number;
  expires_at: number;
  max_uses: number;
  use_count: number;
  active: boolean;
}

interface QuickJoinStatus {
  stage: string;
  progress: number;
  message: string;
  error?: string;
}

interface Props {
  onClose: () => void;
  onSuccess?: (instanceId: string) => void;
  initialCode?: string;
}

const JoinServerDialog: Component<Props> = (props) => {
  const [inviteCode, setInviteCode] = createSignal(props.initialCode ?? "");
  const [validating, setValidating] = createSignal(false);
  const [joining, setJoining] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [invite, setInvite] = createSignal<ServerInvite | null>(null);
  const [joinStatus, setJoinStatus] = createSignal<QuickJoinStatus | null>(null);

  // Listen for quick join status updates
  createEffect(() => {
    const unlisten = listen<QuickJoinStatus>("quick_join_status", (event) => {
      setJoinStatus(event.payload);
      if (event.payload.error) {
        setError(event.payload.error);
        setJoining(false);
      }
      if (event.payload.stage === "complete") {
        setJoining(false);
      }
    });

    onCleanup(() => {
      unlisten.then(fn => fn());
    });
  });

  // Auto-validate if initial code is provided
  createEffect(() => {
    if (props.initialCode && props.initialCode.length >= 15) {
      // Only auto-validate complete codes
      validateInvite();
    }
  });

  // Format invite code as user types (STUZHIK-XXXX-XXXX)
  const handleCodeInput = (value: string) => {
    // Remove non-alphanumeric chars except hyphens
    let clean = value.toUpperCase().replace(/[^A-Z0-9-]/g, "");

    // Auto-format with hyphens
    const parts = clean.replace(/-/g, "").match(/.{1,4}/g) || [];
    if (parts.length > 0 && parts[0]) {
      if (parts[0] === "STUZ" || parts[0] === "STUZH" || parts[0] === "STUZHI" || parts[0] === "STUZHIK" || parts[0].startsWith("STUZHIK")) {
        // Full STUZHIK prefix - format as STUZHIK-XXXX-XXXX
        const afterPrefix = clean.replace(/^STUZHIK-?/, "").replace(/-/g, "");
        const codeParts = afterPrefix.match(/.{1,4}/g) || [];
        clean = "STUZHIK" + (codeParts.length > 0 ? "-" + codeParts.slice(0, 2).join("-") : "");
      }
    }

    setInviteCode(clean);
    setInvite(null);
    setError(null);
  };

  const validateInvite = async () => {
    const code = inviteCode().trim();
    if (!code) return;

    setValidating(true);
    setError(null);

    try {
      const result = await invoke<ServerInvite>("validate_server_invite", { code });
      setInvite(result);
    } catch (e) {
      setError(String(e));
      setInvite(null);
    } finally {
      setValidating(false);
    }
  };

  const joinServer = async () => {
    const inv = invite();
    if (!inv) return;

    setJoining(true);
    setError(null);
    setJoinStatus({
      stage: "connecting",
      progress: 0,
      message: "Подключение к хосту...",
    });

    try {
      const instanceId = await invoke<string>("quick_join_by_invite", {
        inviteCode: inv.code,
      });

      props.onSuccess?.(instanceId);
      props.onClose();
    } catch (e) {
      setError(String(e));
      setJoining(false);
    }
  };

  const formatDate = (timestamp: number) => {
    if (timestamp === 0) return "Бессрочно";
    return new Date(timestamp * 1000).toLocaleDateString("ru-RU", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const isExpired = (invite: ServerInvite) => {
    return invite.expires_at > 0 && invite.expires_at * 1000 < Date.now();
  };

  const getProgressColor = () => {
    const status = joinStatus();
    if (!status) return "bg-blue-500";
    if (status.error) return "bg-red-500";
    if (status.stage === "complete") return "bg-green-500";
    return "bg-blue-500";
  };

  return (
    <ModalWrapper maxWidth="max-w-md">
      <div class="p-6">
        {/* Header */}
        <div class="flex items-center justify-between mb-6">
          <div class="flex items-center gap-3">
            <div class="flex items-center justify-center w-10 h-10 rounded-2xl bg-green-600/20">
              <i class="i-hugeicons-link-01 w-5 h-5 text-green-400" />
            </div>
            <div>
              <h2 class="text-lg font-semibold">Присоединиться к серверу</h2>
              <p class="text-sm text-gray-400">Введите код приглашения</p>
            </div>
          </div>
          <button
            class="btn-close"
            onClick={props.onClose}
            disabled={joining()}
          >
            <i class="i-hugeicons-cancel-01 w-5 h-5" />
          </button>
        </div>

        {/* Invite Code Input */}
        <div class="space-y-4">
          <div class="space-y-2">
            <label class="text-sm font-medium text-gray-300">Код приглашения</label>
            <div class="flex gap-2">
              <input
                type="text"
                class="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-center font-mono text-lg tracking-wider placeholder:text-gray-600"
                placeholder="STUZHIK-XXXX-XXXX"
                value={inviteCode()}
                onInput={(e) => handleCodeInput(e.currentTarget.value)}
                onKeyPress={(e) => e.key === "Enter" && validateInvite()}
                disabled={joining()}
              />
              <button
                class="btn-primary px-4"
                onClick={validateInvite}
                disabled={!inviteCode().trim() || validating() || joining()}
              >
                <Show when={validating()} fallback={<i class="i-hugeicons-search-01 w-5 h-5" />}>
                  <i class="i-svg-spinners-6-dots-scale w-5 h-5" />
                </Show>
              </button>
            </div>
            <p class="text-xs text-gray-500">
              Получите код приглашения от администратора сервера
            </p>
          </div>

          {/* Error */}
          <Show when={error()}>
            <div class="p-3 bg-red-600/20 border border-red-600/40 rounded-lg text-sm text-red-400 flex items-center gap-2">
              <i class="i-hugeicons-alert-02 w-4 h-4 flex-shrink-0" />
              <span>{error()}</span>
            </div>
          </Show>

          {/* Invite Info */}
          <Show when={invite()}>
            {(inv) => (
              <div class="space-y-3">
                <div class="p-4 bg-gray-800/50 border border-gray-700 rounded-xl space-y-3">
                  {/* Server Name */}
                  <div class="flex items-center gap-3">
                    <div class="flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br from-green-600/30 to-blue-600/30">
                      <i class="i-hugeicons-hard-drive w-6 h-6 text-green-400" />
                    </div>
                    <div class="flex-1 min-w-0">
                      <h3 class="font-semibold text-gray-100 truncate">{inv().server_name}</h3>
                      <div class="flex items-center gap-2 text-sm text-gray-400">
                        <span>{inv().mc_version}</span>
                        <span class="text-gray-600">•</span>
                        <span class="capitalize">{inv().loader}</span>
                      </div>
                    </div>
                  </div>

                  {/* Server Address */}
                  <div class="flex items-center gap-2 p-2 bg-gray-900/50 rounded-lg">
                    <i class="i-hugeicons-wifi-01 w-4 h-4 text-gray-500" />
                    <span class="font-mono text-sm text-gray-300">{inv().server_address}</span>
                  </div>

                  {/* Details */}
                  <div class="grid grid-cols-2 gap-2 text-xs">
                    <div class="flex items-center gap-2 text-gray-400">
                      <i class="i-hugeicons-clock-01 w-3.5 h-3.5" />
                      <span>Истекает: {formatDate(inv().expires_at)}</span>
                    </div>
                    <div class="flex items-center gap-2 text-gray-400">
                      <i class="i-hugeicons-user-group w-3.5 h-3.5" />
                      <span>
                        {inv().max_uses === 0
                          ? "Без лимита"
                          : `${inv().use_count}/${inv().max_uses} использований`}
                      </span>
                    </div>
                  </div>

                  {/* Expired Warning */}
                  <Show when={isExpired(inv())}>
                    <div class="p-2 bg-red-600/20 border border-red-600/40 rounded-lg text-xs text-red-400 flex items-center gap-2">
                      <i class="i-hugeicons-alert-02 w-4 h-4" />
                      <span>Приглашение истекло</span>
                    </div>
                  </Show>
                </div>

                {/* Join Progress */}
                <Show when={joining() && joinStatus()}>
                  <div class="space-y-2">
                    <div class="flex items-center justify-between text-sm">
                      <span class="text-gray-300">{joinStatus()!.message}</span>
                      <span class="text-gray-500">{Math.round(joinStatus()!.progress)}%</span>
                    </div>
                    <div class="h-2 bg-gray-800 rounded-full overflow-hidden">
                      <div
                        class={`h-full transition-all duration-100 ${getProgressColor()}`}
                        style={{ width: `${joinStatus()!.progress}%` }}
                      />
                    </div>
                  </div>
                </Show>
              </div>
            )}
          </Show>
        </div>

        {/* Footer */}
        <div class="flex justify-end gap-2 mt-6 pt-4 border-t border-gray-800">
          <button
            class="btn-secondary"
            onClick={props.onClose}
            disabled={joining()}
          >
            Отмена
          </button>
          <button
            class="btn-primary"
            onClick={joinServer}
            disabled={!invite() || isExpired(invite()!) || joining()}
          >
            <Show when={joining()} fallback={
              <>
                <i class="i-hugeicons-play w-4 h-4" />
                Присоединиться
              </>
            }>
              <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
              Подключение...
            </Show>
          </button>
        </div>
      </div>
    </ModalWrapper>
  );
};

export default JoinServerDialog;
