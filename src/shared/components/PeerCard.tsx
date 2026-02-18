import { Show, For } from "solid-js";
import type { PeerInfo } from "./connectTypes";
import { isPeerStale, formatLastSeen } from "./connectUtils";
import { Tooltip } from "../ui";

interface PeerCardProps {
  peer: PeerInfo;
  isFriend: boolean;
  joiningPeer: string | null;
  joinStatus: string | null;
  openPeerMenu: string | null;
  onTogglePeerMenu: (peerId: string) => void;
  onQuickJoin: (peer: PeerInfo) => void;
  onRequestModpack: (peer: PeerInfo) => void;
  onSendFriendRequest: (peer: PeerInfo) => void;
  onBlockPeer: (peerId: string) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: () => any;
}

export function PeerCard(props: PeerCardProps) {
  const peer = () => props.peer;
  const t = () => props.t();

  return (
    <div class="p-3 bg-gray-800/50 rounded-xl hover:bg-gray-800 transition-colors">
      <div class="flex items-center gap-3">
        {/* Avatar */}
        <div class="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white font-medium">
          {(peer().nickname || peer().id.slice(0, 2)).charAt(0).toUpperCase()}
        </div>

        {/* Info */}
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <span class={`font-medium text-sm truncate ${isPeerStale(peer()) ? "text-gray-400" : ""}`}>
              {peer().nickname || t().connect.anonymous}
            </span>
            <Show when={props.isFriend}>
              <Tooltip text={t().connect.settings.trustedFriends} position="bottom">
                <i class="i-hugeicons-user-check-01 w-3.5 h-3.5 text-green-400" />
              </Tooltip>
            </Show>
            <Show when={isPeerStale(peer())} fallback={
              <span class={`w-2 h-2 rounded-full ${
                peer().status === "in_game" ? "bg-green-500" :
                peer().status === "online" ? "bg-blue-500" : "bg-gray-500"
              }`} />
            }>
              <Tooltip text={formatLastSeen(peer(), props.t)} position="bottom">
                <span class="w-2 h-2 rounded-full bg-gray-500 opacity-50" />
              </Tooltip>
            </Show>
          </div>
          <div class="text-xs text-gray-500 truncate">
            <Show when={isPeerStale(peer())} fallback={
              peer().status === "in_game" && peer().current_server
                ? `${t().connect.inGame} • ${peer().current_server}`
                : peer().status === "in_game" ? t().connect.inGame
                : t().connect.online
            }>
              <span class="text-gray-600">
                {t().connect?.lastSeen ?? "Last seen"} {formatLastSeen(peer(), props.t)}
              </span>
            </Show>
          </div>
        </div>

        {/* Actions */}
        <div class="flex items-center gap-1">
          {/* Quick Join */}
          <Show when={peer().status === "in_game" && peer().current_server && peer().modpacks?.length}>
            <Tooltip text={t().connect.quickJoinHint} position="bottom">
              <button
                class={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5 ${
                  props.joiningPeer === peer().id
                    ? "bg-green-600/50 text-green-300 cursor-wait"
                    : "bg-green-600 hover:bg-green-500 text-white"
                }`}
                onClick={() => props.onQuickJoin(peer())}
                disabled={props.joiningPeer !== null}
              >
              <Show when={props.joiningPeer === peer().id} fallback={
                <>
                  <i class="i-hugeicons-play w-3.5 h-3.5" />
                  {t().connect.quickJoin}
                </>
              }>
                <i class="i-svg-spinners-ring-resize w-3.5 h-3.5" />
                {props.joinStatus || t().connect.joining}
              </Show>
            </button>
            </Tooltip>
          </Show>
          <Show when={peer().modpacks && peer().modpacks!.length > 0 && !(peer().status === "in_game" && peer().current_server)}>
            <Tooltip text={t().connect.requestModpack} position="bottom">
              <button
                class="p-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-400 hover:text-white transition-colors"
                onClick={() => props.onRequestModpack(peer())}
              >
                <i class="i-hugeicons-download-02 w-4 h-4" />
              </button>
            </Tooltip>
          </Show>
          {/* More actions menu */}
          <div data-peer-menu>
            <Tooltip text={t().instances.moreActions} position="bottom">
              <button
                class="p-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-400 hover:text-white transition-colors"
                onClick={() => props.onTogglePeerMenu(peer().id)}
              >
                <i class="i-hugeicons-more-vertical w-4 h-4" />
              </button>
            </Tooltip>
            <Show when={props.openPeerMenu === peer().id}>
              <div class="absolute right-0 top-full mt-1 z-10 bg-gray-800 rounded-lg shadow-lg border border-gray-700 py-1 min-w-32">
                <Show when={peer().status === "in_game" && peer().current_server && peer().modpacks?.length}>
                  <button
                    class="w-full px-3 py-2 text-left text-sm text-green-400 hover:bg-gray-700 hover:text-green-300 flex items-center gap-2"
                    onClick={() => props.onQuickJoin(peer())}
                    disabled={props.joiningPeer !== null}
                  >
                    <i class="i-hugeicons-play w-4 h-4" />
                    {t().connect.quickJoin}
                  </button>
                </Show>
                <button
                  class="w-full px-3 py-2 text-left text-sm text-gray-300 hover:bg-gray-700 hover:text-white flex items-center gap-2"
                  onClick={() => props.onRequestModpack(peer())}
                >
                  <i class="i-hugeicons-download-02 w-4 h-4" />
                  {t().connect.requestModpack}
                </button>
                <Show when={!props.isFriend}>
                  <button
                    class="w-full px-3 py-2 text-left text-sm text-green-400 hover:bg-gray-700 hover:text-green-300 flex items-center gap-2"
                    onClick={() => props.onSendFriendRequest(peer())}
                  >
                    <i class="i-hugeicons-user-add-01 w-4 h-4" />
                    {t().connect.addFriend}
                  </button>
                </Show>
                <button
                  class="w-full px-3 py-2 text-left text-sm text-red-400 hover:bg-gray-700 hover:text-red-300 flex items-center gap-2"
                  onClick={() => props.onBlockPeer(peer().id)}
                >
                  <i class="i-hugeicons-user-block-01 w-4 h-4" />
                  {t().connect.blockUser}
                </button>
              </div>
            </Show>
          </div>
        </div>
      </div>

      {/* Modpacks preview */}
      <Show when={peer().modpacks && peer().modpacks!.length > 0}>
        <div class="mt-2 pt-2 border-t border-gray-700">
          <div class="flex flex-wrap gap-1">
            <For each={peer().modpacks!.slice(0, 3)}>
              {(mp) => (
                <span class="text-xs px-2 py-0.5 rounded bg-gray-700 text-gray-400">
                  {mp.name}
                </span>
              )}
            </For>
            <Show when={peer().modpacks!.length > 3}>
              <span class="text-xs px-2 py-0.5 text-gray-500">
                +{peer().modpacks!.length - 3}
              </span>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}
