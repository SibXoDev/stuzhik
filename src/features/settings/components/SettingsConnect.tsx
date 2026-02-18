import { Show, For } from "solid-js";
import type { Accessor, Setter } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { Toggle, Select } from "../../../shared/ui";

type Permission = "deny" | "friends_only" | "ask" | "allow";
type Visibility = "invisible" | "friends_only" | "local_network";

interface SendSettings {
  modpacks: Permission;
  configs: Permission;
  resourcepacks: Permission;
  shaderpacks: Permission;
}

interface ReceiveSettings {
  modpacks: Permission;
  configs: Permission;
  resourcepacks: Permission;
  shaderpacks: Permission;
  verify_hashes: boolean;
}

interface TrustedFriend {
  id: string;
  nickname: string;
  public_key: string;
  added_at: string;
  note?: string;
}

export interface ConnectSettings {
  enabled: boolean;
  nickname: string;
  visibility: Visibility;
  show_nickname: boolean;
  show_modpacks: boolean;
  show_current_server: boolean;
  send: SendSettings;
  receive: ReceiveSettings;
  discovery_port: number;
  blocked_peers: string[];
  trusted_friends: TrustedFriend[];
  remembered_permissions: { peer_id: string; content_type: string; allowed: boolean; created_at: string }[];
}

interface Props {
  connectSettings: Accessor<ConnectSettings | null>;
  setConnectSettings: Setter<ConnectSettings | null>;
  updateConnectSetting: <K extends keyof ConnectSettings>(key: K, value: ConnectSettings[K]) => void;
  updateSendPermission: (key: keyof SendSettings, value: Permission) => void;
  updateReceivePermission: (key: keyof ReceiveSettings, value: Permission) => void;
  savingConnect: Accessor<boolean>;
  defaultUsername: string | null;
  t: Accessor<Record<string, any>>;
}

export default function SettingsConnect(props: Props) {
  const t = () => props.t();

  return (
    <fieldset data-section="connect">
      <legend class="text-base font-medium mb-4 inline-flex items-center gap-2">
        <i class="i-hugeicons-user-group w-5 h-5" />
        {t().connect.settings.title}
      </legend>
      <Show when={props.connectSettings()} fallback={
        <div class="text-center py-4 text-muted">
          <i class="i-svg-spinners-6-dots-scale w-5 h-5 inline-block" />
        </div>
      }>
        <div class="space-y-6">
          {/* Включить Connect */}
          <div class="flex items-center justify-between p-4 bg-gray-alpha-30 rounded-2xl">
            <div>
              <p class="font-medium">{t().connect.settings.enabled}</p>
              <p class="text-xs text-muted">{t().connect.subtitle}</p>
            </div>
            <Toggle
              checked={props.connectSettings()?.enabled || false}
              onChange={(checked) => props.updateConnectSetting("enabled", checked)}
            />
          </div>

          {/* Настройки (только если Connect включён) */}
          <Show when={props.connectSettings()?.enabled}>
            {/* Никнейм */}
            <div class="flex flex-col gap-2">
              <label class="block text-sm font-medium">
                {t().connect.settings.nickname}
              </label>
              <div class="flex flex-col gap-1">
                <input
                  type="text"
                  value={props.connectSettings()?.nickname || ""}
                  onInput={(e) => props.updateConnectSetting("nickname", e.currentTarget.value)}
                  placeholder={props.defaultUsername || "Player"}
                  class="input w-full"
                />
                <p class="text-xs text-muted">
                  {t().connect.settings.nicknameHint}
                </p>
              </div>
            </div>

            {/* Видимость */}
            <div class="flex flex-col gap-3">
              <label class="block text-sm font-medium">
                {t().connect.settings.visibility}
              </label>
              <div class="grid grid-cols-3 gap-2">
                <button
                  class={`p-3 rounded-xl border-2 transition-fast flex flex-col items-center gap-1 ${
                    props.connectSettings()?.visibility === "invisible"
                      ? "border-[var(--color-primary)] bg-[var(--color-primary-bg)]"
                      : "border-gray-700 hover:border-gray-500"
                  }`}
                  onClick={() => props.updateConnectSetting("visibility", "invisible")}
                >
                  <i class="i-hugeicons-view-off w-5 h-5" />
                  <p class="text-xs">{t().connect.settings.visibilityInvisible}</p>
                </button>
                <button
                  class={`p-3 rounded-xl border-2 transition-fast flex flex-col items-center gap-1 ${
                    props.connectSettings()?.visibility === "friends_only"
                      ? "border-[var(--color-primary)] bg-[var(--color-primary-bg)]"
                      : "border-gray-700 hover:border-gray-500"
                  }`}
                  onClick={() => props.updateConnectSetting("visibility", "friends_only")}
                >
                  <i class="i-hugeicons-user-multiple w-5 h-5" />
                  <p class="text-xs">{t().connect.settings.visibilityFriends}</p>
                </button>
                <button
                  class={`p-3 rounded-xl border-2 transition-fast flex flex-col items-center gap-1 ${
                    props.connectSettings()?.visibility === "local_network"
                      ? "border-[var(--color-primary)] bg-[var(--color-primary-bg)]"
                      : "border-gray-700 hover:border-gray-500"
                  }`}
                  onClick={() => props.updateConnectSetting("visibility", "local_network")}
                >
                  <i class="i-hugeicons-wifi-01 w-5 h-5" />
                  <p class="text-xs">{t().connect.settings.visibilityAll}</p>
                </button>
              </div>
            </div>

            {/* Что показывать */}
            <div class="space-y-3">
              <div class="flex items-center justify-between">
                <span class="text-sm">{t().connect.settings.showNickname}</span>
                <Toggle
                  checked={props.connectSettings()?.show_nickname ?? false}
                  onChange={(checked) => props.updateConnectSetting("show_nickname", checked)}
                />
              </div>
              <div class="flex items-center justify-between">
                <span class="text-sm">{t().connect.settings.showModpacks}</span>
                <Toggle
                  checked={props.connectSettings()?.show_modpacks ?? false}
                  onChange={(checked) => props.updateConnectSetting("show_modpacks", checked)}
                />
              </div>
              <div class="flex items-center justify-between">
                <span class="text-sm">{t().connect.settings.showServer}</span>
                <Toggle
                  checked={props.connectSettings()?.show_current_server ?? false}
                  onChange={(checked) => props.updateConnectSetting("show_current_server", checked)}
                />
              </div>
            </div>

            {/* Разрешения на отправку */}
            <div class="flex flex-col gap-3">
              <label class="block text-sm font-medium">
                {t().connect.settings.send}
              </label>
              <div class="space-y-2">
                <For each={["modpacks", "configs", "resourcepacks", "shaderpacks"] as const}>
                  {(item) => (
                    <div class="flex items-center justify-between p-3 bg-gray-alpha-30 rounded-xl">
                      <span class="text-sm">{t().connect.settings[item]}</span>
                      <Select
                        value={props.connectSettings()?.send[item] || "ask"}
                        onChange={(value) => props.updateSendPermission(item, value as Permission)}
                        class="w-32"
                        options={[
                          { value: "deny", label: t().connect.settings.permissionDeny },
                          { value: "friends_only", label: t().connect.settings.permissionFriends },
                          { value: "ask", label: t().connect.settings.permissionAsk },
                          { value: "allow", label: t().connect.settings.permissionAllow },
                        ]}
                      />
                    </div>
                  )}
                </For>
              </div>
            </div>

            {/* Разрешения на получение */}
            <div class="flex flex-col gap-3">
              <label class="block text-sm font-medium">
                {t().connect.settings.receive}
              </label>
              <div class="space-y-2">
                <For each={["modpacks", "configs", "resourcepacks", "shaderpacks"] as const}>
                  {(item) => (
                    <div class="flex items-center justify-between p-3 bg-gray-alpha-30 rounded-xl">
                      <span class="text-sm">{t().connect.settings[item]}</span>
                      <Select
                        value={props.connectSettings()?.receive[item] || "ask"}
                        onChange={(value) => props.updateReceivePermission(item, value as Permission)}
                        class="w-32"
                        options={[
                          { value: "deny", label: t().connect.settings.permissionDeny },
                          { value: "friends_only", label: t().connect.settings.permissionFriends },
                          { value: "ask", label: t().connect.settings.permissionAsk },
                          { value: "allow", label: t().connect.settings.permissionAllow },
                        ]}
                      />
                    </div>
                  )}
                </For>
              </div>
            </div>

            {/* UDP Порт */}
            <div class="flex flex-col gap-2">
              <label class="block text-sm font-medium">
                {t().connect.settings.port}
              </label>
              <div class="flex flex-col gap-1">
                <input
                  type="number"
                  value={props.connectSettings()?.discovery_port || 19847}
                  onInput={(e) => props.updateConnectSetting("discovery_port", Number(e.currentTarget.value) || 19847)}
                  min="1024"
                  max="65535"
                  class="input w-32"
                />
                <p class="text-xs text-amber-400">
                  <i class="i-hugeicons-alert-02 w-3 h-3 inline-block" /> {t().connect.settings.portWarning}
                </p>
              </div>
            </div>

            {/* Blocked users */}
            <Show when={(props.connectSettings()?.blocked_peers?.length ?? 0) > 0}>
              <div class="flex flex-col gap-2 pt-4 border-t border-gray-700">
                <label class="block text-sm font-medium">
                  {t().connect.settings.blockedUsers}
                </label>
                <div class="space-y-2">
                  <For each={props.connectSettings()?.blocked_peers || []}>
                    {(peerId) => (
                      <div class="flex items-center justify-between p-2 bg-gray-800 rounded-lg">
                        <span class="text-sm text-gray-400 truncate">{peerId}</span>
                        <button
                          class="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white transition-colors"
                          onClick={async () => {
                            try {
                              await invoke("unblock_peer", { peerId });
                              const prev = props.connectSettings();
                              if (prev) {
                                props.setConnectSettings({
                                  ...prev,
                                  blocked_peers: prev.blocked_peers.filter(id => id !== peerId)
                                });
                              }
                            } catch (e) {
                              if (import.meta.env.DEV) console.error("Failed to unblock peer:", e);
                            }
                          }}
                        >
                          {t().connect.settings.unblock}
                        </button>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            {/* Trusted friends */}
            <Show when={(props.connectSettings()?.trusted_friends?.length ?? 0) > 0}>
              <div class="flex flex-col gap-2 pt-4 border-t border-gray-700">
                <label class="block text-sm font-medium">
                  {t().connect.settings.trustedFriends}
                </label>
                <div class="space-y-2">
                  <For each={props.connectSettings()?.trusted_friends || []}>
                    {(friend) => (
                      <div class="flex items-center justify-between p-3 bg-gray-800 rounded-lg">
                        <div class="flex items-center gap-3 min-w-0">
                          <div class="w-8 h-8 rounded-full bg-green-500/20 flex items-center justify-center flex-shrink-0">
                            <i class="i-hugeicons-user-check-01 w-4 h-4 text-green-400" />
                          </div>
                          <div class="min-w-0">
                            <p class="text-sm font-medium truncate">{friend.nickname}</p>
                            <p class="text-xs text-gray-500 truncate" title={friend.public_key}>
                              {friend.public_key.slice(0, 12)}...
                            </p>
                          </div>
                        </div>
                        <button
                          class="text-xs px-2 py-1 rounded bg-red-500/20 hover:bg-red-500/30 text-red-400 hover:text-red-300 transition-colors flex-shrink-0 flex items-center gap-1"
                          onClick={async () => {
                            try {
                              await invoke("remove_friend", { peerId: friend.id });
                              const prev = props.connectSettings();
                              if (prev) {
                                props.setConnectSettings({
                                  ...prev,
                                  trusted_friends: prev.trusted_friends.filter(f => f.id !== friend.id)
                                });
                              }
                            } catch (e) {
                              if (import.meta.env.DEV) console.error("Failed to remove friend:", e);
                            }
                          }}
                        >
                          <i class="i-hugeicons-user-minus-01 w-3.5 h-3.5" />
                          {t().connect.settings.removeFriend}
                        </button>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            {/* Индикатор автосохранения */}
            <Show when={props.savingConnect()}>
              <div class="flex items-center gap-2 text-muted text-xs justify-center">
                <i class="i-svg-spinners-ring-resize w-3 h-3" />
                {t().settings.actions.saving}
              </div>
            </Show>
          </Show>
        </div>
      </Show>
    </fieldset>
  );
}
