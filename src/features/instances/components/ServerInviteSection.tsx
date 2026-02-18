import { Show, For, Component, Accessor } from "solid-js";
import type { ServerInvite } from "./serverP2PTypes";
import { Select } from "../../../shared/ui/Select";
import { Tooltip } from "../../../shared/ui/Tooltip";

interface ServerInviteSectionProps {
  invites: Accessor<ServerInvite[]>;
  creatingInvite: Accessor<boolean>;
  showInviteOptions: Accessor<boolean>;
  inviteExpiry: Accessor<string>;
  inviteMaxUses: Accessor<number>;
  copiedInviteId: Accessor<string | null>;
  onToggleOptions: () => void;
  onSetInviteExpiry: (v: string) => void;
  onSetInviteMaxUses: (v: number) => void;
  onCreateInvite: () => void;
  onCopyInvite: (invite: ServerInvite) => void;
  onRevokeInvite: (id: string) => void;
  onDeleteInvite: (id: string) => void;
  isExpired: (invite: ServerInvite) => boolean;
  formatDate: (timestamp: number) => string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: () => any;
}

export const ServerInviteSection: Component<ServerInviteSectionProps> = (props) => {
  const t = () => props.t();

  return (
    <div class="card p-4">
      <div class="flex items-center justify-between mb-3">
        <h3 class="text-sm font-medium text-gray-100">
          {t().server.p2p.invites}
        </h3>
        <button
          class="btn-primary btn-sm"
          onClick={props.onToggleOptions}
          disabled={props.creatingInvite()}
        >
          <Show when={props.creatingInvite()} fallback={<i class="i-hugeicons-add-01 w-4 h-4" />}>
            <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
          </Show>
          <span>{t().server.p2p.createInvite}</span>
        </button>
      </div>

      {/* Create Invite Options */}
      <Show when={props.showInviteOptions()}>
        <div class="p-3 bg-gray-800/50 border border-gray-700 rounded-lg mb-3 space-y-3">
          <div class="flex items-center gap-4">
            <div class="flex-1">
              <label class="text-xs text-gray-400 mb-1 block">{t().server.p2p.expiry}</label>
              <Select
                value={props.inviteExpiry()}
                onChange={props.onSetInviteExpiry}
                options={[
                  { value: "never", label: t().server.p2p.expiryNever },
                  { value: "1h", label: t().server.p2p.expiry1h },
                  { value: "24h", label: t().server.p2p.expiry24h },
                  { value: "7d", label: t().server.p2p.expiry7d },
                  { value: "30d", label: t().server.p2p.expiry30d },
                ]}
              />
            </div>
            <div class="flex-1">
              <label class="text-xs text-gray-400 mb-1 block">{t().server.p2p.maxUses}</label>
              <input
                type="number"
                class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-100"
                placeholder={t().server.p2p.maxUsesHint}
                min="0"
                value={props.inviteMaxUses() || ""}
                onInput={(e) => props.onSetInviteMaxUses(parseInt(e.currentTarget.value) || 0)}
              />
            </div>
          </div>
          <div class="flex justify-end gap-2">
            <button
              class="btn-secondary btn-sm"
              onClick={props.onToggleOptions}
            >
              {t().common.cancel}
            </button>
            <button
              class="btn-primary btn-sm"
              onClick={props.onCreateInvite}
              disabled={props.creatingInvite()}
            >
              {t().server.p2p.createInviteBtn}
            </button>
          </div>
        </div>
      </Show>

      {/* Invites List */}
      <Show
        when={props.invites().length > 0}
        fallback={
          <p class="text-xs text-gray-500 text-center py-4">
            {t().server.p2p.noInvites}
          </p>
        }
      >
        <div class="space-y-2 max-h-64 overflow-y-auto">
          <For each={props.invites()}>
            {(invite) => (
              <div
                class={`p-3 rounded-lg border transition-colors ${
                  !invite.active || props.isExpired(invite)
                    ? "bg-gray-900/50 border-gray-800 opacity-60"
                    : "bg-gray-800/50 border-gray-700"
                }`}
              >
                <div class="flex items-center justify-between gap-2">
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                      <code class="text-sm font-mono text-green-400 truncate">
                        {invite.code}
                      </code>
                      <Show when={!invite.active}>
                        <span class="text-xs px-1.5 py-0.5 bg-red-600/20 text-red-400 rounded">
                          {t().server.p2p.inviteRevoked}
                        </span>
                      </Show>
                      <Show when={invite.active && props.isExpired(invite)}>
                        <span class="text-xs px-1.5 py-0.5 bg-yellow-600/20 text-yellow-400 rounded">
                          {t().server.p2p.inviteExpired}
                        </span>
                      </Show>
                    </div>
                    <div class="flex items-center gap-3 text-xs text-gray-500 mt-1">
                      <span class="flex items-center gap-1">
                        <i class="i-hugeicons-clock-01 w-3 h-3" />
                        {props.formatDate(invite.expires_at)}
                      </span>
                      <span class="flex items-center gap-1">
                        <i class="i-hugeicons-user-group w-3 h-3" />
                        {invite.max_uses === 0
                          ? `${invite.use_count} ${t().server.p2p.uses}`
                          : `${invite.use_count}/${invite.max_uses}`}
                      </span>
                    </div>
                  </div>
                  <div class="flex items-center gap-1">
                    <Show when={invite.active && !props.isExpired(invite)}>
                      <Tooltip text={t().server.p2p.copyInvite} position="bottom">
                        <button
                          class="p-1.5 text-gray-400 hover:text-green-400 transition-colors"
                          onClick={() => props.onCopyInvite(invite)}
                        >
                          <Show
                            when={props.copiedInviteId() === invite.id}
                            fallback={<i class="i-hugeicons-copy-01 w-4 h-4" />}
                          >
                            <i class="i-hugeicons-checkmark-circle-02 w-4 h-4 text-green-400" />
                          </Show>
                        </button>
                      </Tooltip>
                      <Tooltip text={t().server.p2p.revokeInvite} position="bottom">
                        <button
                          class="p-1.5 text-gray-400 hover:text-yellow-400 transition-colors"
                          onClick={() => props.onRevokeInvite(invite.id)}
                        >
                          <i class="i-hugeicons-cancel-01 w-4 h-4" />
                        </button>
                      </Tooltip>
                    </Show>
                    <Tooltip text={t().server.p2p.deleteInvite} position="bottom">
                      <button
                        class="p-1.5 text-gray-400 hover:text-red-400 transition-colors"
                        onClick={() => props.onDeleteInvite(invite.id)}
                      >
                        <i class="i-hugeicons-delete-02 w-4 h-4" />
                      </button>
                    </Tooltip>
                  </div>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
      <p class="text-xs text-gray-500 mt-3">
        {t().server.p2p.invitesHint}
      </p>
    </div>
  );
};
