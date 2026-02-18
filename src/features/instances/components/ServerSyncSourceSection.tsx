import { Show, Component } from "solid-js";
import type { ServerSyncConfig, SyncSource, P2PInstance } from "./serverP2PTypes";
import { Select } from "../../../shared/ui/Select";
import { Tooltip } from "../../../shared/ui/Tooltip";

interface ServerSyncSourceSectionProps {
  config: ServerSyncConfig;
  clients: P2PInstance[];
  onSetSyncSource: (source: SyncSource) => void;
  onLinkClient: (clientId: string | null) => void;
  onLinkModpack: () => void;
  onUnlinkModpack: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: () => any;
}

const getFileName = (path: string): string => {
  return path.split(/[/\\]/).pop() || path;
};

export const ServerSyncSourceSection: Component<ServerSyncSourceSectionProps> = (props) => {
  const t = () => props.t();
  const cfg = () => props.config;

  return (
    <div class="card p-4">
      <h3 class="text-sm font-medium text-gray-100 mb-3">
        {t().server.p2p.syncSource}
      </h3>

      {/* Sync source type selector */}
      <div class="flex flex-col gap-3">
        {/* Client Instance Option */}
        <div
          class={`p-3 rounded-lg border cursor-pointer transition-colors ${
            cfg().sync_source === "client_instance"
              ? "bg-blue-600/10 border-blue-500/50"
              : "bg-gray-800/50 border-gray-700 hover:border-gray-600"
          }`}
          onClick={() => props.onSetSyncSource("client_instance")}
        >
          <div class="flex items-center gap-3">
            <div class={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
              cfg().sync_source === "client_instance"
                ? "border-blue-500"
                : "border-gray-600"
            }`}>
              <Show when={cfg().sync_source === "client_instance"}>
                <div class="w-2 h-2 rounded-full bg-blue-500" />
              </Show>
            </div>
            <div class="flex-1">
              <div class="text-sm text-gray-200 font-medium">{t().server.p2p.clientInstance}</div>
              <div class="text-xs text-gray-500">{t().server.p2p.clientInstanceHint}</div>
            </div>
          </div>

          <Show when={cfg().sync_source === "client_instance"}>
            <div class="mt-3 ml-7" onClick={(e) => e.stopPropagation()}>
              <Select
                value={cfg().linked_client_id || ""}
                onChange={(val) => props.onLinkClient(val || null)}
                placeholder={t().server.p2p.selectClient}
                options={[
                  { value: "", label: t().server.p2p.selectClient },
                  ...props.clients.map(client => ({
                    value: client.id,
                    label: `${client.name}${client.mc_version ? ` (${client.mc_version})` : ""}`
                  }))
                ]}
              />
            </div>
          </Show>
        </div>

        {/* Modpack File Option */}
        <div
          class={`p-3 rounded-lg border cursor-pointer transition-colors ${
            cfg().sync_source === "modpack_file"
              ? "bg-green-600/10 border-green-500/50"
              : "bg-gray-800/50 border-gray-700 hover:border-gray-600"
          }`}
          onClick={() => props.onSetSyncSource("modpack_file")}
        >
          <div class="flex items-center gap-3">
            <div class={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
              cfg().sync_source === "modpack_file"
                ? "border-green-500"
                : "border-gray-600"
            }`}>
              <Show when={cfg().sync_source === "modpack_file"}>
                <div class="w-2 h-2 rounded-full bg-green-500" />
              </Show>
            </div>
            <div class="flex-1">
              <div class="text-sm text-gray-200 font-medium">{t().server.p2p.modpackFile}</div>
              <div class="text-xs text-gray-500">{t().server.p2p.modpackFileHint}</div>
            </div>
          </div>

          <Show when={cfg().sync_source === "modpack_file"}>
            <div class="mt-3 ml-7">
              <Show
                when={cfg().linked_modpack_path}
                fallback={
                  <button
                    class="btn-secondary w-full justify-center"
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onLinkModpack();
                    }}
                  >
                    <i class="i-hugeicons-file-add w-4 h-4" />
                    <span>{t().server.p2p.selectModpack}</span>
                  </button>
                }
              >
                <div class="flex items-center gap-2 p-2 bg-gray-800 rounded-lg">
                  <i class="i-hugeicons-archive w-4 h-4 text-green-400" />
                  <span class="flex-1 text-sm text-gray-200 truncate">
                    {getFileName(cfg().linked_modpack_path!)}
                  </span>
                  <Tooltip text={t().server.p2p.unlinkModpack} position="bottom">
                    <button
                      class="p-1 text-gray-400 hover:text-red-400 transition-colors"
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onUnlinkModpack();
                      }}
                    >
                      <i class="i-hugeicons-cancel-01 w-4 h-4" />
                    </button>
                  </Tooltip>
                  <Tooltip text={t().server.p2p.selectAnother} position="bottom">
                    <button
                      class="p-1 text-gray-400 hover:text-[var(--color-primary)] transition-colors"
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onLinkModpack();
                      }}
                    >
                      <i class="i-hugeicons-folder-01 w-4 h-4" />
                    </button>
                  </Tooltip>
                </div>
              </Show>
            </div>
          </Show>
        </div>

        {/* None Option */}
        <Show when={cfg().sync_source !== "none" && !cfg().linked_client_id && !cfg().linked_modpack_path}>
          <button
            class="text-xs text-gray-500 hover:text-gray-400 text-left"
            onClick={() => props.onSetSyncSource("none")}
          >
            {t().server.p2p.disableSync}
          </button>
        </Show>
      </div>

      <p class="text-xs text-gray-500 mt-3">
        <Show
          when={cfg().sync_source === "modpack_file"}
          fallback={t().server.p2p.syncFromClient}
        >
          {t().server.p2p.syncFromFile}
        </Show>
      </p>
    </div>
  );
};
