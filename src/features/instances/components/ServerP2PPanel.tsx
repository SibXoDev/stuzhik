import { Component, createSignal, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import Toggle from "../../../shared/ui/Toggle";
import { Select } from "../../../shared/ui/Select";
import { useI18n } from "../../../shared/i18n";
import { useSafeTimers } from "../../../shared/hooks";

type ServerVisibility = "Invisible" | "FriendsOnly" | "AuthorizedOnly" | "Everyone";
type SyncSource = "none" | "client_instance" | "modpack_file";

interface ServerSyncConfig {
  server_instance_id: string;
  sync_source: SyncSource;
  linked_client_id: string | null;
  linked_modpack_path: string | null;
  p2p_enabled: boolean;
  auto_sync: boolean;
  server_ip: string;
  server_port: number;
  visibility: ServerVisibility;
  require_invite: boolean;
  authorized_peers: string[];
  include_patterns: string[];
  exclude_patterns: string[];
}

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

interface Instance {
  id: string;
  name: string;
  instance_type: string;
  mc_version?: string;
  loader?: string;
}

interface InstalledMod {
  id: number;
  instance_id: string;
  slug: string;
  name: string;
  version: string;
  minecraft_version: string;
  source: string;
  source_id: string | null;
  file_name: string;
  enabled: boolean;
  auto_update: boolean;
  icon_url: string | null;
}

interface Props {
  instanceId: string;
  instanceName: string;
  serverPort?: number;
  mcVersion?: string;
  loader?: string;
}

const ServerP2PPanel: Component<Props> = (props) => {
  const { t } = useI18n();
  const { setTimeout: safeTimeout } = useSafeTimers();
  const [config, setConfig] = createSignal<ServerSyncConfig | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [, setSaving] = createSignal(false);
  const [clients, setClients] = createSignal<Instance[]>([]);
  const [newPeerId, setNewPeerId] = createSignal("");

  // Invite state
  const [invites, setInvites] = createSignal<ServerInvite[]>([]);
  const [creatingInvite, setCreatingInvite] = createSignal(false);
  const [showInviteOptions, setShowInviteOptions] = createSignal(false);
  const [inviteExpiry, setInviteExpiry] = createSignal<"never" | "1h" | "24h" | "7d" | "30d">("never");
  const [inviteMaxUses, setInviteMaxUses] = createSignal<number>(0);
  const [copiedInviteId, setCopiedInviteId] = createSignal<string | null>(null);

  // Linked client mod info
  const [linkedModCount, setLinkedModCount] = createSignal<number>(0);
  const [manifestHash, setManifestHash] = createSignal<string>("");

  // Load config, clients, and invites
  const loadData = async () => {
    setLoading(true);
    try {
      const [syncConfig, allInstances, serverInvites] = await Promise.all([
        invoke<ServerSyncConfig | null>("get_server_sync_config", {
          serverInstanceId: props.instanceId,
        }),
        invoke<Instance[]>("list_instances"),
        invoke<ServerInvite[]>("get_server_invites", {
          serverInstanceId: props.instanceId,
        }).catch(() => [] as ServerInvite[]),
      ]);

      // Filter only client instances
      const clientInstances = allInstances.filter(
        (i) => i.instance_type === "client"
      );
      setClients(clientInstances);
      setInvites(serverInvites);

      if (syncConfig) {
        // Ensure new fields have defaults (spread first, then defaults for missing fields)
        setConfig({
          ...syncConfig,
          sync_source: syncConfig.sync_source ?? "none",
          linked_modpack_path: syncConfig.linked_modpack_path ?? null,
        });
        // Load mod info from linked client
        if (syncConfig.linked_client_id) {
          loadLinkedClientModInfo(syncConfig.linked_client_id);
        }
      } else {
        // Create default config
        setConfig({
          server_instance_id: props.instanceId,
          sync_source: "none",
          linked_client_id: null,
          linked_modpack_path: null,
          p2p_enabled: false,
          auto_sync: false,
          server_ip: "127.0.0.1",
          server_port: props.serverPort || 25565,
          visibility: "AuthorizedOnly",
          require_invite: true,
          authorized_peers: [],
          include_patterns: [
            "mods/**/*.jar",
            "config/**/*",
            "kubejs/**/*",
            "resourcepacks/**/*",
            "shaderpacks/**/*",
          ],
          exclude_patterns: [
            "**/*.jar.disabled",
            "**/cache/**",
            "**/.git/**",
            "**/logs/**",
            "**/crash-reports/**",
            "**/world/**",
          ],
        });
      }
    } catch (e) {
      console.error("Failed to load P2P config:", e);
    } finally {
      setLoading(false);
    }
  };

  onMount(loadData);

  // Load mod info from linked client to get mod count and manifest hash
  const loadLinkedClientModInfo = async (clientId: string | null) => {
    if (!clientId) {
      setLinkedModCount(0);
      setManifestHash("");
      return;
    }

    try {
      const mods = await invoke<InstalledMod[]>("list_mods", { instanceId: clientId });
      const enabledMods = mods.filter(m => m.enabled);
      setLinkedModCount(enabledMods.length);

      // Calculate a simple hash from sorted mod slugs and versions
      const modSignatures = enabledMods
        .map(m => `${m.slug}:${m.version}`)
        .sort()
        .join("|");

      // Simple hash function for the manifest
      let hash = 0;
      for (let i = 0; i < modSignatures.length; i++) {
        const char = modSignatures.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
      }
      setManifestHash(Math.abs(hash).toString(16).padStart(8, "0"));
    } catch (e) {
      console.error("Failed to load linked client mod info:", e);
      setLinkedModCount(0);
      setManifestHash("");
    }
  };

  // Create invite
  const createInvite = async () => {
    const cfg = config();
    if (!cfg) return;

    setCreatingInvite(true);
    try {
      // Calculate expiry timestamp
      let expiresAt = 0;
      const now = Math.floor(Date.now() / 1000);
      switch (inviteExpiry()) {
        case "1h":
          expiresAt = now + 3600;
          break;
        case "24h":
          expiresAt = now + 86400;
          break;
        case "7d":
          expiresAt = now + 604800;
          break;
        case "30d":
          expiresAt = now + 2592000;
          break;
      }

      const invite = await invoke<ServerInvite>("create_server_invite", {
        serverInstanceId: props.instanceId,
        serverName: props.instanceName,
        mcVersion: props.mcVersion || "1.20.1",
        loader: props.loader || "fabric",
        serverAddress: `${cfg.server_ip}:${cfg.server_port}`,
        expiresAt,
        maxUses: inviteMaxUses(),
      });

      setInvites((prev) => [invite, ...prev]);
      setShowInviteOptions(false);

      // Re-publish server with new invite code
      if (cfg.p2p_enabled) {
        await updateServerPublication(true);
      }
    } catch (e) {
      console.error("Failed to create invite:", e);
    } finally {
      setCreatingInvite(false);
    }
  };

  // Copy invite code
  const copyInviteCode = async (invite: ServerInvite) => {
    try {
      const formattedText = await invoke<string>("format_invite_text", {
        invite,
      });
      await navigator.clipboard.writeText(formattedText);
      setCopiedInviteId(invite.id);
      safeTimeout(() => setCopiedInviteId(null), 2000);
    } catch (e) {
      // Fallback to just code
      await navigator.clipboard.writeText(invite.code);
      setCopiedInviteId(invite.id);
      safeTimeout(() => setCopiedInviteId(null), 2000);
    }
  };

  // Revoke invite
  const revokeInvite = async (inviteId: string) => {
    try {
      await invoke("revoke_server_invite", { inviteId });
      setInvites((prev) =>
        prev.map((inv) => (inv.id === inviteId ? { ...inv, active: false } : inv))
      );
    } catch (e) {
      console.error("Failed to revoke invite:", e);
    }
  };

  // Delete invite
  const deleteInvite = async (inviteId: string) => {
    try {
      await invoke("delete_server_invite", { inviteId });
      setInvites((prev) => prev.filter((inv) => inv.id !== inviteId));
    } catch (e) {
      console.error("Failed to delete invite:", e);
    }
  };

  // Format date
  const formatDate = (timestamp: number) => {
    if (timestamp === 0) return t().server.p2p.expiryNever;
    const date = new Date(timestamp * 1000);
    const now = new Date();
    const diff = date.getTime() - now.getTime();

    if (diff < 0) return t().server.p2p.expired;
    if (diff < 3600000) return `${Math.ceil(diff / 60000)} ${t().server.p2p.minutes}`;
    if (diff < 86400000) return `${Math.ceil(diff / 3600000)} ${t().server.console.hours}`;
    return date.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
  };

  const isExpired = (invite: ServerInvite) => {
    return invite.expires_at > 0 && invite.expires_at * 1000 < Date.now();
  };

  // Save config
  const saveConfig = async () => {
    const cfg = config();
    if (!cfg) return;

    setSaving(true);
    try {
      await invoke("set_server_sync_config", { config: cfg });
    } catch (e) {
      console.error("Failed to save P2P config:", e);
    } finally {
      setSaving(false);
    }
  };

  // Publish/unpublish server for discovery
  const updateServerPublication = async (enabled: boolean) => {
    if (enabled) {
      // Get first active invite for publishing
      const activeInvite = invites().find(i => i.active && !isExpired(i));
      const cfg = config();
      if (cfg) {
        try {
          await invoke("publish_server_for_discovery", {
            server: {
              instance_id: props.instanceId,
              name: props.instanceName,
              mc_version: props.mcVersion || "1.20.1",
              loader: props.loader || "fabric",
              server_address: `${cfg.server_ip}:${cfg.server_port}`,
              manifest_hash: manifestHash(),
              mod_count: linkedModCount(),
              total_size: 0,
              updated_at: Math.floor(Date.now() / 1000),
              online_players: null,
              max_players: null,
              motd: null,
              invite_code: activeInvite?.code || null,
            },
          });
        } catch (e) {
          console.error("Failed to publish server:", e);
        }
      }
    } else {
      try {
        await invoke("unpublish_server", {
          serverInstanceId: props.instanceId,
        });
      } catch (e) {
        console.error("Failed to unpublish server:", e);
      }
    }
  };

  // Toggle P2P
  const toggleP2P = async (enabled: boolean) => {
    setConfig((prev) => (prev ? { ...prev, p2p_enabled: enabled } : null));
    await saveConfig();
    await updateServerPublication(enabled);
  };

  // Toggle auto-sync
  const toggleAutoSync = (enabled: boolean) => {
    setConfig((prev) => (prev ? { ...prev, auto_sync: enabled } : null));
    saveConfig();
  };

  // Update visibility
  const updateVisibility = (visibility: ServerVisibility) => {
    setConfig((prev) => (prev ? { ...prev, visibility } : null));
    saveConfig();
  };

  // Toggle require invite
  const toggleRequireInvite = (enabled: boolean) => {
    setConfig((prev) => (prev ? { ...prev, require_invite: enabled } : null));
    saveConfig();
  };

  // Update server address
  const updateServerAddress = (ip: string, port: number) => {
    setConfig((prev) =>
      prev ? { ...prev, server_ip: ip, server_port: port } : null
    );
  };

  // Change sync source type
  const setSyncSource = async (source: SyncSource) => {
    const cfg = config();
    if (!cfg) return;

    // If switching away from current source, clear the linked data
    if (source === "none") {
      if (cfg.linked_client_id) {
        try {
          await invoke("unlink_client_from_server", {
            serverInstanceId: props.instanceId,
          });
        } catch (e) {
          console.error("Failed to unlink client:", e);
        }
      }
      setConfig((prev) => prev ? {
        ...prev,
        sync_source: "none",
        linked_client_id: null,
        linked_modpack_path: null
      } : null);
      await saveConfig();
    } else {
      setConfig((prev) => prev ? { ...prev, sync_source: source } : null);
    }
  };

  // Link client instance
  const linkClient = async (clientId: string | null) => {
    if (!clientId) {
      try {
        await invoke("unlink_client_from_server", {
          serverInstanceId: props.instanceId,
        });
        setConfig((prev) => (prev ? {
          ...prev,
          linked_client_id: null,
          sync_source: prev.linked_modpack_path ? "modpack_file" : "none"
        } : null));
        loadLinkedClientModInfo(null);
      } catch (e) {
        console.error("Failed to unlink client:", e);
      }
      return;
    }

    try {
      await invoke("link_client_to_server", {
        serverInstanceId: props.instanceId,
        clientInstanceId: clientId,
      });
      setConfig((prev) =>
        prev ? {
          ...prev,
          linked_client_id: clientId,
          sync_source: "client_instance"
        } : null
      );
      loadLinkedClientModInfo(clientId);
    } catch (e) {
      console.error("Failed to link client:", e);
    }
  };

  // Link modpack file
  const linkModpack = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [
          { name: "Modpacks", extensions: ["stzhk", "mrpack", "zip"] }
        ],
        title: "Выберите файл модпака",
      });

      if (selected && typeof selected === "string") {
        await invoke("link_modpack_to_server", {
          serverInstanceId: props.instanceId,
          modpackPath: selected,
        });
        setConfig((prev) => prev ? {
          ...prev,
          linked_modpack_path: selected,
          sync_source: "modpack_file"
        } : null);
      }
    } catch (e) {
      console.error("Failed to link modpack:", e);
    }
  };

  // Unlink modpack file
  const unlinkModpack = async () => {
    try {
      // Clear the modpack link
      setConfig((prev) => prev ? {
        ...prev,
        linked_modpack_path: null,
        sync_source: prev.linked_client_id ? "client_instance" : "none"
      } : null);
      await saveConfig();
    } catch (e) {
      console.error("Failed to unlink modpack:", e);
    }
  };

  // Get filename from path
  const getFileName = (path: string): string => {
    return path.split(/[/\\]/).pop() || path;
  };

  // Add authorized peer
  const addPeer = async () => {
    const peerId = newPeerId().trim();
    if (!peerId) return;

    try {
      await invoke("authorize_server_sync_peer", {
        serverInstanceId: props.instanceId,
        peerId,
      });
      setConfig((prev) =>
        prev
          ? {
              ...prev,
              authorized_peers: [...prev.authorized_peers, peerId],
            }
          : null
      );
      setNewPeerId("");
    } catch (e) {
      console.error("Failed to add peer:", e);
    }
  };

  // Remove authorized peer
  const removePeer = async (peerId: string) => {
    try {
      await invoke("revoke_server_sync_peer", {
        serverInstanceId: props.instanceId,
        peerId,
      });
      setConfig((prev) =>
        prev
          ? {
              ...prev,
              authorized_peers: prev.authorized_peers.filter((p) => p !== peerId),
            }
          : null
      );
    } catch (e) {
      console.error("Failed to remove peer:", e);
    }
  };

  return (
    <div class="flex flex-col gap-4">
      <Show when={loading()}>
        <div class="flex items-center justify-center py-8">
          <i class="i-svg-spinners-6-dots-scale w-6 h-6 text-blue-400" />
        </div>
      </Show>

      <Show when={!loading() && config()}>
        {/* P2P Enable Toggle */}
        <div class="card p-4">
          <div class="flex items-center justify-between gap-4">
            <div class="flex-1">
              <h3 class="text-sm font-medium text-gray-100">
                {t().server.p2p.title}
              </h3>
              <p class="text-xs text-gray-400 mt-1">
                {t().server.p2p.description}
              </p>
            </div>
            <Toggle
              checked={config()!.p2p_enabled}
              onChange={toggleP2P}
            />
          </div>
        </div>

        <Show when={config()!.p2p_enabled}>
          {/* Server Address */}
          <div class="card p-4">
            <h3 class="text-sm font-medium text-gray-100 mb-3">
              {t().server.p2p.serverAddress}
            </h3>
            <div class="flex items-center gap-2">
              <input
                type="text"
                class="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-100"
                placeholder={t().server.p2p.ipPlaceholder}
                value={config()!.server_ip}
                onInput={(e) =>
                  updateServerAddress(e.currentTarget.value, config()!.server_port)
                }
                onBlur={saveConfig}
              />
              <span class="text-gray-500">:</span>
              <input
                type="number"
                class="w-24 bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-100"
                placeholder={t().server.p2p.portPlaceholder}
                value={config()!.server_port}
                onInput={(e) =>
                  updateServerAddress(
                    config()!.server_ip,
                    parseInt(e.currentTarget.value) || 25565
                  )
                }
                onBlur={saveConfig}
              />
            </div>
            <p class="text-xs text-gray-500 mt-2">
              {t().server.p2p.addressHint}
            </p>
          </div>

          {/* Visibility & Security */}
          <div class="card p-4">
            <h3 class="text-sm font-medium text-gray-100 mb-3">
              {t().server.p2p.visibility}
            </h3>
            <div class="space-y-3">
              {/* Visibility */}
              <div>
                <label class="text-xs text-gray-400 mb-1.5 block">{t().server.p2p.whoCanSee}</label>
                <div class="grid grid-cols-2 gap-2">
                  <button
                    class={`p-2 rounded-lg border text-xs text-left transition-colors ${
                      config()!.visibility === "Everyone"
                        ? "bg-blue-600/20 border-blue-500 text-blue-400"
                        : "bg-gray-800/50 border-gray-700 text-gray-400 hover:border-gray-600"
                    }`}
                    onClick={() => updateVisibility("Everyone")}
                  >
                    <div class="flex items-center gap-1.5 mb-0.5">
                      <i class="i-hugeicons-globe-02 w-3.5 h-3.5" />
                      <span class="font-medium">{t().server.p2p.everyone}</span>
                    </div>
                    <span class="text-gray-500">{t().server.p2p.everyoneHint}</span>
                  </button>
                  <button
                    class={`p-2 rounded-lg border text-xs text-left transition-colors ${
                      config()!.visibility === "FriendsOnly"
                        ? "bg-green-600/20 border-green-500 text-green-400"
                        : "bg-gray-800/50 border-gray-700 text-gray-400 hover:border-gray-600"
                    }`}
                    onClick={() => updateVisibility("FriendsOnly")}
                  >
                    <div class="flex items-center gap-1.5 mb-0.5">
                      <i class="i-hugeicons-user-love-01 w-3.5 h-3.5" />
                      <span class="font-medium">{t().server.p2p.friendsOnly}</span>
                    </div>
                    <span class="text-gray-500">{t().server.p2p.friendsOnlyHint}</span>
                  </button>
                  <button
                    class={`p-2 rounded-lg border text-xs text-left transition-colors ${
                      config()!.visibility === "AuthorizedOnly"
                        ? "bg-yellow-600/20 border-yellow-500 text-yellow-400"
                        : "bg-gray-800/50 border-gray-700 text-gray-400 hover:border-gray-600"
                    }`}
                    onClick={() => updateVisibility("AuthorizedOnly")}
                  >
                    <div class="flex items-center gap-1.5 mb-0.5">
                      <i class="i-hugeicons-lock w-3.5 h-3.5" />
                      <span class="font-medium">{t().server.p2p.authorizedOnly}</span>
                    </div>
                    <span class="text-gray-500">{t().server.p2p.authorizedOnlyHint}</span>
                  </button>
                  <button
                    class={`p-2 rounded-lg border text-xs text-left transition-colors ${
                      config()!.visibility === "Invisible"
                        ? "bg-gray-600/20 border-gray-500 text-gray-300"
                        : "bg-gray-800/50 border-gray-700 text-gray-400 hover:border-gray-600"
                    }`}
                    onClick={() => updateVisibility("Invisible")}
                  >
                    <div class="flex items-center gap-1.5 mb-0.5">
                      <i class="i-hugeicons-view-off w-3.5 h-3.5" />
                      <span class="font-medium">{t().server.p2p.invisible}</span>
                    </div>
                    <span class="text-gray-500">{t().server.p2p.invisibleHint}</span>
                  </button>
                </div>
              </div>

              {/* Require Invite */}
              <div class="flex items-center justify-between pt-2 border-t border-gray-700/50">
                <div class="flex-1">
                  <div class="text-sm text-gray-200">{t().server.p2p.requireInvite}</div>
                  <p class="text-xs text-gray-500 mt-0.5">
                    {config()!.require_invite
                      ? t().server.p2p.requireInviteOn
                      : t().server.p2p.requireInviteOff}
                  </p>
                </div>
                <Toggle
                  checked={config()!.require_invite}
                  onChange={toggleRequireInvite}
                />
              </div>
            </div>
          </div>

          {/* Sync Source Selection */}
          <div class="card p-4">
            <h3 class="text-sm font-medium text-gray-100 mb-3">
              {t().server.p2p.syncSource}
            </h3>

            {/* Sync source type selector */}
            <div class="flex flex-col gap-3">
              {/* Client Instance Option */}
              <div
                class={`p-3 rounded-lg border cursor-pointer transition-colors ${
                  config()!.sync_source === "client_instance"
                    ? "bg-blue-600/10 border-blue-500/50"
                    : "bg-gray-800/50 border-gray-700 hover:border-gray-600"
                }`}
                onClick={() => setSyncSource("client_instance")}
              >
                <div class="flex items-center gap-3">
                  <div class={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                    config()!.sync_source === "client_instance"
                      ? "border-blue-500"
                      : "border-gray-600"
                  }`}>
                    <Show when={config()!.sync_source === "client_instance"}>
                      <div class="w-2 h-2 rounded-full bg-blue-500" />
                    </Show>
                  </div>
                  <div class="flex-1">
                    <div class="text-sm text-gray-200 font-medium">{t().server.p2p.clientInstance}</div>
                    <div class="text-xs text-gray-500">{t().server.p2p.clientInstanceHint}</div>
                  </div>
                </div>

                <Show when={config()!.sync_source === "client_instance"}>
                  <div class="mt-3 ml-7" onClick={(e) => e.stopPropagation()}>
                    <Select
                      value={config()!.linked_client_id || ""}
                      onChange={(val) => linkClient(val || null)}
                      placeholder={t().server.p2p.selectClient}
                      options={[
                        { value: "", label: t().server.p2p.selectClient },
                        ...clients().map(client => ({
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
                  config()!.sync_source === "modpack_file"
                    ? "bg-green-600/10 border-green-500/50"
                    : "bg-gray-800/50 border-gray-700 hover:border-gray-600"
                }`}
                onClick={() => setSyncSource("modpack_file")}
              >
                <div class="flex items-center gap-3">
                  <div class={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                    config()!.sync_source === "modpack_file"
                      ? "border-green-500"
                      : "border-gray-600"
                  }`}>
                    <Show when={config()!.sync_source === "modpack_file"}>
                      <div class="w-2 h-2 rounded-full bg-green-500" />
                    </Show>
                  </div>
                  <div class="flex-1">
                    <div class="text-sm text-gray-200 font-medium">{t().server.p2p.modpackFile}</div>
                    <div class="text-xs text-gray-500">{t().server.p2p.modpackFileHint}</div>
                  </div>
                </div>

                <Show when={config()!.sync_source === "modpack_file"}>
                  <div class="mt-3 ml-7">
                    <Show
                      when={config()!.linked_modpack_path}
                      fallback={
                        <button
                          class="btn-secondary w-full justify-center"
                          onClick={(e) => {
                            e.stopPropagation();
                            linkModpack();
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
                          {getFileName(config()!.linked_modpack_path!)}
                        </span>
                        <button
                          class="p-1 text-gray-400 hover:text-red-400 transition-colors"
                          onClick={(e) => {
                            e.stopPropagation();
                            unlinkModpack();
                          }}
                          title={t().server.p2p.unlinkModpack}
                        >
                          <i class="i-hugeicons-cancel-01 w-4 h-4" />
                        </button>
                        <button
                          class="p-1 text-gray-400 hover:text-blue-400 transition-colors"
                          onClick={(e) => {
                            e.stopPropagation();
                            linkModpack();
                          }}
                          title={t().server.p2p.selectAnother}
                        >
                          <i class="i-hugeicons-folder-01 w-4 h-4" />
                        </button>
                      </div>
                    </Show>
                  </div>
                </Show>
              </div>

              {/* None Option */}
              <Show when={config()!.sync_source !== "none" && !config()!.linked_client_id && !config()!.linked_modpack_path}>
                <button
                  class="text-xs text-gray-500 hover:text-gray-400 text-left"
                  onClick={() => setSyncSource("none")}
                >
                  {t().server.p2p.disableSync}
                </button>
              </Show>
            </div>

            <p class="text-xs text-gray-500 mt-3">
              <Show
                when={config()!.sync_source === "modpack_file"}
                fallback={t().server.p2p.syncFromClient}
              >
                {t().server.p2p.syncFromFile}
              </Show>
            </p>
          </div>

          {/* Auto-sync */}
          <div class="card p-4">
            <div class="flex items-center justify-between gap-4">
              <div class="flex-1">
                <h3 class="text-sm font-medium text-gray-100">
                  {t().server.p2p.autoSync}
                </h3>
                <p class="text-xs text-gray-400 mt-1">
                  {t().server.p2p.autoSyncHint}
                </p>
              </div>
              <Toggle
                checked={config()!.auto_sync}
                onChange={toggleAutoSync}
              />
            </div>
          </div>

          {/* Authorized Peers */}
          <div class="card p-4">
            <h3 class="text-sm font-medium text-gray-100 mb-3">
              {t().server.p2p.authorizedPlayers}
            </h3>
            <div class="flex items-center gap-2 mb-3">
              <input
                type="text"
                class="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-100"
                placeholder={t().server.p2p.peerIdPlaceholder}
                value={newPeerId()}
                onInput={(e) => setNewPeerId(e.currentTarget.value)}
                onKeyPress={(e) => e.key === "Enter" && addPeer()}
              />
              <button
                class="btn-primary px-3 py-1.5 text-sm"
                onClick={addPeer}
                disabled={!newPeerId().trim()}
              >
                <i class="i-hugeicons-add-01 w-4 h-4" />
              </button>
            </div>

            <Show
              when={config()!.authorized_peers.length > 0}
              fallback={
                <p class="text-xs text-gray-500 text-center py-2">
                  {t().server.p2p.noAuthorizedPeers}
                </p>
              }
            >
              <div class="flex flex-wrap gap-2">
                <For each={config()!.authorized_peers}>
                  {(peer) => (
                    <div class="flex items-center gap-1 bg-gray-800 rounded-lg px-2 py-1 text-sm">
                      <span class="text-gray-200">{peer}</span>
                      <button
                        class="text-gray-500 hover:text-red-400 p-0.5"
                        onClick={() => removePeer(peer)}
                      >
                        <i class="i-hugeicons-cancel-01 w-3 h-3" />
                      </button>
                    </div>
                  )}
                </For>
              </div>
            </Show>
            <p class="text-xs text-gray-500 mt-2">
              {t().server.p2p.authorizedHint}
            </p>
          </div>

          {/* Server Invites */}
          <div class="card p-4">
            <div class="flex items-center justify-between mb-3">
              <h3 class="text-sm font-medium text-gray-100">
                {t().server.p2p.invites}
              </h3>
              <button
                class="btn-primary btn-sm"
                onClick={() => setShowInviteOptions(!showInviteOptions())}
                disabled={creatingInvite()}
              >
                <Show when={creatingInvite()} fallback={<i class="i-hugeicons-add-01 w-4 h-4" />}>
                  <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                </Show>
                <span>{t().server.p2p.createInvite}</span>
              </button>
            </div>

            {/* Create Invite Options */}
            <Show when={showInviteOptions()}>
              <div class="p-3 bg-gray-800/50 border border-gray-700 rounded-lg mb-3 space-y-3">
                <div class="flex items-center gap-4">
                  <div class="flex-1">
                    <label class="text-xs text-gray-400 mb-1 block">{t().server.p2p.expiry}</label>
                    <Select
                      value={inviteExpiry()}
                      onChange={(val) => setInviteExpiry(val as "never" | "1h" | "24h" | "7d" | "30d")}
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
                      value={inviteMaxUses() || ""}
                      onInput={(e) => setInviteMaxUses(parseInt(e.currentTarget.value) || 0)}
                    />
                  </div>
                </div>
                <div class="flex justify-end gap-2">
                  <button
                    class="btn-secondary btn-sm"
                    onClick={() => setShowInviteOptions(false)}
                  >
                    {t().common.cancel}
                  </button>
                  <button
                    class="btn-primary btn-sm"
                    onClick={createInvite}
                    disabled={creatingInvite()}
                  >
                    {t().server.p2p.createInviteBtn}
                  </button>
                </div>
              </div>
            </Show>

            {/* Invites List */}
            <Show
              when={invites().length > 0}
              fallback={
                <p class="text-xs text-gray-500 text-center py-4">
                  {t().server.p2p.noInvites}
                </p>
              }
            >
              <div class="space-y-2 max-h-64 overflow-y-auto">
                <For each={invites()}>
                  {(invite) => (
                    <div
                      class={`p-3 rounded-lg border transition-colors ${
                        !invite.active || isExpired(invite)
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
                            <Show when={invite.active && isExpired(invite)}>
                              <span class="text-xs px-1.5 py-0.5 bg-yellow-600/20 text-yellow-400 rounded">
                                {t().server.p2p.inviteExpired}
                              </span>
                            </Show>
                          </div>
                          <div class="flex items-center gap-3 text-xs text-gray-500 mt-1">
                            <span class="flex items-center gap-1">
                              <i class="i-hugeicons-clock-01 w-3 h-3" />
                              {formatDate(invite.expires_at)}
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
                          <Show when={invite.active && !isExpired(invite)}>
                            <button
                              class="p-1.5 text-gray-400 hover:text-green-400 transition-colors"
                              onClick={() => copyInviteCode(invite)}
                              title={t().server.p2p.copyInvite}
                            >
                              <Show
                                when={copiedInviteId() === invite.id}
                                fallback={<i class="i-hugeicons-copy-01 w-4 h-4" />}
                              >
                                <i class="i-hugeicons-checkmark-circle-02 w-4 h-4 text-green-400" />
                              </Show>
                            </button>
                            <button
                              class="p-1.5 text-gray-400 hover:text-yellow-400 transition-colors"
                              onClick={() => revokeInvite(invite.id)}
                              title={t().server.p2p.revokeInvite}
                            >
                              <i class="i-hugeicons-cancel-01 w-4 h-4" />
                            </button>
                          </Show>
                          <button
                            class="p-1.5 text-gray-400 hover:text-red-400 transition-colors"
                            onClick={() => deleteInvite(invite.id)}
                            title={t().server.p2p.deleteInvite}
                          >
                            <i class="i-hugeicons-delete-02 w-4 h-4" />
                          </button>
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

          {/* Sync Patterns */}
          <div class="card p-4">
            <details class="group">
              <summary class="flex items-center justify-between cursor-pointer text-sm font-medium text-gray-100">
                <span>{t().server.p2p.advancedSettings}</span>
                <i class="i-hugeicons-arrow-down-01 w-4 h-4 text-gray-400 group-open:rotate-180 transition-transform" />
              </summary>
              <div class="mt-4 flex flex-col gap-4">
                <div>
                  <label class="text-xs text-gray-400 mb-1 block">
                    {t().server.p2p.includePatterns}
                  </label>
                  <textarea
                    class="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-xs font-mono text-gray-100 h-24"
                    value={config()!.include_patterns.join("\n")}
                    onInput={(e) => {
                      const patterns = e.currentTarget.value.split("\n").filter(Boolean);
                      setConfig((prev) =>
                        prev ? { ...prev, include_patterns: patterns } : null
                      );
                    }}
                    onBlur={saveConfig}
                  />
                </div>
                <div>
                  <label class="text-xs text-gray-400 mb-1 block">
                    {t().server.p2p.excludePatterns}
                  </label>
                  <textarea
                    class="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-xs font-mono text-gray-100 h-24"
                    value={config()!.exclude_patterns.join("\n")}
                    onInput={(e) => {
                      const patterns = e.currentTarget.value.split("\n").filter(Boolean);
                      setConfig((prev) =>
                        prev ? { ...prev, exclude_patterns: patterns } : null
                      );
                    }}
                    onBlur={saveConfig}
                  />
                </div>
              </div>
            </details>
          </div>
        </Show>
      </Show>
    </div>
  );
};

export default ServerP2PPanel;
