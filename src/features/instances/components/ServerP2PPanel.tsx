import { Component, createSignal, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import Toggle from "../../../shared/ui/Toggle";
import { useI18n, getSafeLocale } from "../../../shared/i18n";
import { useSafeTimers } from "../../../shared/hooks";
import type { ServerSyncConfig, ServerInvite, P2PInstance, InstalledMod, ServerVisibility, SyncSource } from "./serverP2PTypes";
import { ServerInviteSection } from "./ServerInviteSection";
import { ServerSyncSourceSection } from "./ServerSyncSourceSection";

interface Props {
  instanceId: string;
  instanceName: string;
  serverPort?: number;
  mcVersion?: string;
  loader?: string;
}

const ServerP2PPanel: Component<Props> = (props) => {
  const { t, language } = useI18n();
  const { setTimeout: safeTimeout } = useSafeTimers();
  const [config, setConfig] = createSignal<ServerSyncConfig | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [, setSaving] = createSignal(false);
  const [clients, setClients] = createSignal<P2PInstance[]>([]);
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
        invoke<P2PInstance[]>("list_instances"),
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
      if (import.meta.env.DEV) console.error("Failed to load P2P config:", e);
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
      if (import.meta.env.DEV) console.error("Failed to load linked client mod info:", e);
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
      if (import.meta.env.DEV) console.error("Failed to create invite:", e);
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
      if (import.meta.env.DEV) console.error("Failed to revoke invite:", e);
    }
  };

  // Delete invite
  const deleteInvite = async (inviteId: string) => {
    try {
      await invoke("delete_server_invite", { inviteId });
      setInvites((prev) => prev.filter((inv) => inv.id !== inviteId));
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to delete invite:", e);
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
    return date.toLocaleDateString(getSafeLocale(language()), { day: "numeric", month: "short" });
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
      if (import.meta.env.DEV) console.error("Failed to save P2P config:", e);
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
          if (import.meta.env.DEV) console.error("Failed to publish server:", e);
        }
      }
    } else {
      try {
        await invoke("unpublish_server", {
          serverInstanceId: props.instanceId,
        });
      } catch (e) {
        if (import.meta.env.DEV) console.error("Failed to unpublish server:", e);
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
          if (import.meta.env.DEV) console.error("Failed to unlink client:", e);
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
        if (import.meta.env.DEV) console.error("Failed to unlink client:", e);
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
      if (import.meta.env.DEV) console.error("Failed to link client:", e);
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
        title: t().server.p2p.selectModpackTitle,
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
      if (import.meta.env.DEV) console.error("Failed to link modpack:", e);
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
      if (import.meta.env.DEV) console.error("Failed to unlink modpack:", e);
    }
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
      if (import.meta.env.DEV) console.error("Failed to add peer:", e);
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
      if (import.meta.env.DEV) console.error("Failed to remove peer:", e);
    }
  };

  return (
    <div class="flex flex-col gap-4">
      <Show when={loading()}>
        <div class="flex items-center justify-center py-8">
          <i class="i-svg-spinners-6-dots-scale w-6 h-6 text-[var(--color-primary)]" />
        </div>
      </Show>

      <Show when={!loading() && config()}>
        {/* P2P Enable Toggle */}
        <div class="card p-4">
          <div class="flex items-center justify-between gap-4">
            <div class="flex-1 flex flex-col gap-1">
              <h3 class="text-sm font-medium text-gray-100">
                {t().server.p2p.title}
              </h3>
              <p class="text-xs text-gray-400">
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
          <div class="card p-4 flex flex-col gap-3">
            <h3 class="text-sm font-medium text-gray-100">
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
            <p class="text-xs text-gray-500">
              {t().server.p2p.addressHint}
            </p>
          </div>

          {/* Visibility & Security */}
          <div class="card p-4 flex flex-col gap-3">
            <h3 class="text-sm font-medium text-gray-100">
              {t().server.p2p.visibility}
            </h3>
            <div class="space-y-3">
              {/* Visibility */}
              <div class="flex flex-col gap-1.5">
                <label class="text-xs text-gray-400 block">{t().server.p2p.whoCanSee}</label>
                <div class="grid grid-cols-2 gap-2">
                  <button
                    class={`flex flex-col gap-0.5 p-2 rounded-lg border text-xs text-left transition-colors ${
                      config()!.visibility === "Everyone"
                        ? "bg-blue-600/20 border-blue-500 text-blue-400"
                        : "bg-gray-800/50 border-gray-700 text-gray-400 hover:border-gray-600"
                    }`}
                    onClick={() => updateVisibility("Everyone")}
                  >
                    <div class="flex items-center gap-1.5">
                      <i class="i-hugeicons-globe-02 w-3.5 h-3.5" />
                      <span class="font-medium">{t().server.p2p.everyone}</span>
                    </div>
                    <span class="text-gray-500">{t().server.p2p.everyoneHint}</span>
                  </button>
                  <button
                    class={`flex flex-col gap-0.5 p-2 rounded-lg border text-xs text-left transition-colors ${
                      config()!.visibility === "FriendsOnly"
                        ? "bg-green-600/20 border-green-500 text-green-400"
                        : "bg-gray-800/50 border-gray-700 text-gray-400 hover:border-gray-600"
                    }`}
                    onClick={() => updateVisibility("FriendsOnly")}
                  >
                    <div class="flex items-center gap-1.5">
                      <i class="i-hugeicons-user-love-01 w-3.5 h-3.5" />
                      <span class="font-medium">{t().server.p2p.friendsOnly}</span>
                    </div>
                    <span class="text-gray-500">{t().server.p2p.friendsOnlyHint}</span>
                  </button>
                  <button
                    class={`flex flex-col gap-0.5 p-2 rounded-lg border text-xs text-left transition-colors ${
                      config()!.visibility === "AuthorizedOnly"
                        ? "bg-yellow-600/20 border-yellow-500 text-yellow-400"
                        : "bg-gray-800/50 border-gray-700 text-gray-400 hover:border-gray-600"
                    }`}
                    onClick={() => updateVisibility("AuthorizedOnly")}
                  >
                    <div class="flex items-center gap-1.5">
                      <i class="i-hugeicons-lock w-3.5 h-3.5" />
                      <span class="font-medium">{t().server.p2p.authorizedOnly}</span>
                    </div>
                    <span class="text-gray-500">{t().server.p2p.authorizedOnlyHint}</span>
                  </button>
                  <button
                    class={`flex flex-col gap-0.5 p-2 rounded-lg border text-xs text-left transition-colors ${
                      config()!.visibility === "Invisible"
                        ? "bg-gray-600/20 border-gray-500 text-gray-300"
                        : "bg-gray-800/50 border-gray-700 text-gray-400 hover:border-gray-600"
                    }`}
                    onClick={() => updateVisibility("Invisible")}
                  >
                    <div class="flex items-center gap-1.5">
                      <i class="i-hugeicons-view-off w-3.5 h-3.5" />
                      <span class="font-medium">{t().server.p2p.invisible}</span>
                    </div>
                    <span class="text-gray-500">{t().server.p2p.invisibleHint}</span>
                  </button>
                </div>
              </div>

              {/* Require Invite */}
              <div class="flex items-center justify-between pt-2 border-t border-gray-700/50">
                <div class="flex-1 flex flex-col gap-0.5">
                  <div class="text-sm text-gray-200">{t().server.p2p.requireInvite}</div>
                  <p class="text-xs text-gray-500">
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
          <ServerSyncSourceSection
            config={config()!}
            clients={clients()}
            onSetSyncSource={setSyncSource}
            onLinkClient={linkClient}
            onLinkModpack={linkModpack}
            onUnlinkModpack={unlinkModpack}
            t={t}
          />

          {/* Auto-sync */}
          <div class="card p-4">
            <div class="flex items-center justify-between gap-4">
              <div class="flex-1 flex flex-col gap-1">
                <h3 class="text-sm font-medium text-gray-100">
                  {t().server.p2p.autoSync}
                </h3>
                <p class="text-xs text-gray-400">
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
          <div class="card p-4 flex flex-col gap-3">
            <h3 class="text-sm font-medium text-gray-100">
              {t().server.p2p.authorizedPlayers}
            </h3>
            <div class="flex items-center gap-2">
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
            <p class="text-xs text-gray-500">
              {t().server.p2p.authorizedHint}
            </p>
          </div>

          {/* Server Invites */}
          <ServerInviteSection
            invites={invites}
            creatingInvite={creatingInvite}
            showInviteOptions={showInviteOptions}
            inviteExpiry={inviteExpiry}
            inviteMaxUses={inviteMaxUses}
            copiedInviteId={copiedInviteId}
            onToggleOptions={() => setShowInviteOptions(!showInviteOptions())}
            onSetInviteExpiry={(v) => setInviteExpiry(v as "never" | "1h" | "24h" | "7d" | "30d")}
            onSetInviteMaxUses={setInviteMaxUses}
            onCreateInvite={createInvite}
            onCopyInvite={copyInviteCode}
            onRevokeInvite={revokeInvite}
            onDeleteInvite={deleteInvite}
            isExpired={isExpired}
            formatDate={formatDate}
            t={t}
          />

          {/* Sync Patterns */}
          <div class="card p-4">
            <details class="group flex flex-col gap-4">
              <summary class="flex items-center justify-between cursor-pointer text-sm font-medium text-gray-100">
                <span>{t().server.p2p.advancedSettings}</span>
                <i class="i-hugeicons-arrow-down-01 w-4 h-4 text-gray-400 group-open:rotate-180 transition-transform" />
              </summary>
              <div class="flex flex-col gap-4">
                <div class="flex flex-col gap-1">
                  <label class="text-xs text-gray-400 block">
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
                <div class="flex flex-col gap-1">
                  <label class="text-xs text-gray-400 block">
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
