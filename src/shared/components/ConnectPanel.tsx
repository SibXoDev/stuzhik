import { createSignal, onMount, onCleanup, Show, For, lazy } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { useI18n } from "../i18n";
import { Toggle, Tooltip } from "../ui";
import { ConsentDialog, ConsentRequest } from "./ConsentDialog";
import { useSafeTimers } from "../hooks";
import { PeerCard } from "./PeerCard";
import { TransferList } from "./TransferList";
import { TransferHistorySection } from "./TransferHistorySection";
import { NetworkDiagnosticsPanel } from "./NetworkDiagnosticsPanel";
import type {
  PeerInfo,
  ConnectSettings,
  TransferSession,
  TransferHistoryEntry,
  HistoryStats,
  QueuedTransfer,
  UpdateNotification,
  NetworkDiagnostics,
  DiscoveredServer,
  DiscoveredServersResponse,
  TransferEventPayload,
  ConnectPanelProps,
} from "./connectTypes";

const JoinServerDialog = lazy(() => import("../../features/instances/components/JoinServerDialog"));

// VPN app keys for translations
const VPN_APPS = [
  { key: "radmin", url: "https://www.radmin-vpn.com/", difficulty: "easy", recommended: true },
  { key: "zerotier", url: "https://www.zerotier.com/", difficulty: "medium", recommended: true },
  { key: "tailscale", url: "https://tailscale.com/", difficulty: "advanced", recommended: false },
  { key: "hamachi", url: "https://vpn.net/", difficulty: "easy", recommended: false },
] as const;

export function ConnectPanel(props: ConnectPanelProps) {
  const { t } = useI18n();
  const [settings, setSettings] = createSignal<ConnectSettings | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [enabling, setEnabling] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [defaultUsername, setDefaultUsername] = createSignal<string>("Player");
  const [peers, setPeers] = createSignal<PeerInfo[]>([]);
  const [consentRequest, setConsentRequest] = createSignal<ConsentRequest | null>(null);
  const [openPeerMenu, setOpenPeerMenu] = createSignal<string | null>(null);
  const [joiningPeer, setJoiningPeer] = createSignal<string | null>(null);
  const [joinStatus, setJoinStatus] = createSignal<string | null>(null);
  const [shortCode, setShortCode] = createSignal<string | null>(null);
  const [friendCode, setFriendCode] = createSignal("");
  const [connectingByCode, setConnectingByCode] = createSignal(false);
  const [codeCopied, setCodeCopied] = createSignal(false);
  const [transfers, setTransfers] = createSignal<TransferSession[]>([]);
  const [showTransfers, setShowTransfers] = createSignal(false);
  const [networkDiagnostics, setNetworkDiagnostics] = createSignal<NetworkDiagnostics | null>(null);
  const [diagnosing, setDiagnosing] = createSignal(false);
  const [showDiagnostics, setShowDiagnostics] = createSignal(false);
  const [showJoinDialog, setShowJoinDialog] = createSignal(false);
  const [discoveredServers, setDiscoveredServers] = createSignal<DiscoveredServer[]>([]);
  const [joiningServer, setJoiningServer] = createSignal<string | null>(null);
  // Transfer History
  const [history, setHistory] = createSignal<TransferHistoryEntry[]>([]);
  const [historyStats, setHistoryStats] = createSignal<HistoryStats | null>(null);
  const [showHistory, setShowHistory] = createSignal(false);
  // Transfer Queue
  const [queue, setQueue] = createSignal<QueuedTransfer[]>([]);
  const [showQueue, setShowQueue] = createSignal(false);
  // Update Notifications
  const [notifications, setNotifications] = createSignal<UpdateNotification[]>([]);
  const [showNotifications, setShowNotifications] = createSignal(false);

  let unlistenPeers: UnlistenFn | null = null;
  let unlistenConsent: UnlistenFn | null = null;
  let unlistenTransfer: UnlistenFn | null = null;

  // Use safe timers hook for automatic cleanup
  const { setTimeout: safeTimeout } = useSafeTimers();

  onMount(async () => {
    try {
      const [connectSettings, appSettings, discoveredPeers] = await Promise.all([
        invoke<ConnectSettings>("get_connect_settings"),
        invoke<{ default_username: string | null }>("get_settings"),
        invoke<PeerInfo[]>("get_discovered_peers"),
      ]);
      setSettings(connectSettings);
      setPeers(discoveredPeers);
      if (appSettings.default_username) {
        setDefaultUsername(appSettings.default_username);
      }

      // Загружаем короткий код если Connect включён
      if (connectSettings.enabled) {
        const code = await invoke<string | null>("get_short_code");
        setShortCode(code);

        // Загружаем обнаруженные серверы
        try {
          const servers = await invoke<DiscoveredServersResponse>("get_discovered_servers");
          const peersMap = new Map(discoveredPeers.map(p => [p.id, p.nickname]));
          setDiscoveredServers(servers.map(([peerId, server]) => ({
            ...server,
            host_peer_id: peerId,
            host_nickname: peersMap.get(peerId) ?? null,
          })));
        } catch (e) {
          if (import.meta.env.DEV) console.error("Failed to load discovered servers:", e);
        }
      }

      // Подписываемся на обновления списка пиров
      unlistenPeers = await listen<PeerInfo[]>("peers-updated", (event) => {
        setPeers(event.payload);
      });

      // Подписываемся на запросы согласия
      unlistenConsent = await listen<ConsentRequest>("consent-request", (event) => {
        setConsentRequest(event.payload);
      });

      // Подписываемся на события передачи файлов
      unlistenTransfer = await listen<TransferEventPayload>("transfer-event", (event) => {
        const data = event.payload;
        switch (data.type) {
          case "session_created":
            setTransfers(prev => [...prev, data.session]);
            setShowTransfers(true);
            break;
          case "progress":
            setTransfers(prev => prev.map(t =>
              t.id === data.session_id
                ? { ...t, bytes_done: data.bytes_done, files_done: data.files_done, current_file: data.current_file, speed_bps: data.speed_bps, eta_seconds: data.eta_seconds }
                : t
            ));
            break;
          case "completed":
            setTransfers(prev => prev.map(t =>
              t.id === data.session_id ? { ...t, status: "completed" as const } : t
            ));
            break;
          case "error":
            setTransfers(prev => prev.map(t =>
              t.id === data.session_id ? { ...t, status: "failed" as const } : t
            ));
            break;
          case "cancelled":
            setTransfers(prev => prev.map(t =>
              t.id === data.session_id ? { ...t, status: "cancelled" as const } : t
            ));
            break;
          case "paused":
            setTransfers(prev => prev.map(t =>
              t.id === data.session_id ? { ...t, status: "paused" as const } : t
            ));
            break;
          case "resumed":
            setTransfers(prev => prev.map(t =>
              t.id === data.session_id ? { ...t, status: "transferring" as const } : t
            ));
            break;
        }
      });

      // Загружаем активные сессии передачи
      const activeSessions = await invoke<TransferSession[]>("get_transfer_sessions");
      setTransfers(activeSessions);

      // Загружаем историю, очередь и уведомления (если Connect включён)
      if (connectSettings.enabled) {
        const [historyData, statsData, queueData, notificationsData] = await Promise.all([
          invoke<TransferHistoryEntry[]>("get_recent_transfer_history", { limit: 20 }),
          invoke<HistoryStats>("get_transfer_history_stats"),
          invoke<QueuedTransfer[]>("get_transfer_queue"),
          invoke<UpdateNotification[]>("get_unread_update_notifications"),
        ]);
        setHistory(historyData);
        setHistoryStats(statsData);
        setQueue(queueData);
        setNotifications(notificationsData);
      }
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to load connect settings:", e);
      setError(t().errors.unknown);
    } finally {
      setLoading(false);
    }
  });

  onCleanup(() => {
    // Timers are cleaned up automatically by useSafeTimers
    if (unlistenPeers) {
      unlistenPeers();
    }
    if (unlistenConsent) {
      unlistenConsent();
    }
    if (unlistenTransfer) {
      unlistenTransfer();
    }
  });

  const handleToggleConnect = async () => {
    const current = settings();
    if (!current) return;

    setEnabling(true);
    setError(null);

    try {
      const updated = { ...current, enabled: !current.enabled };
      await invoke("save_connect_settings", { settings: updated });
      setSettings(updated);

      // Если включили - загружаем короткий код
      if (updated.enabled) {
        const code = await invoke<string | null>("get_short_code");
        setShortCode(code);
      } else {
        setShortCode(null);
      }
    } catch (e: unknown) {
      if (import.meta.env.DEV) console.error("Failed to toggle Connect:", e);
      const errorMessage = e instanceof Error ? e.message :
        typeof e === 'object' && e !== null && 'message' in e ? String((e as { message: unknown }).message) :
        t().errors.unknown;
      setError(errorMessage);
    } finally {
      setEnabling(false);
    }
  };

  const getDifficultyLabel = (difficulty: string) => {
    const diff = t().connect.difficulty as Record<string, string>;
    return diff[difficulty] || difficulty;
  };

  const handleVisibilityChange = async (visibility: "invisible" | "friends_only" | "local_network") => {
    const current = settings();
    if (!current || current.visibility === visibility) return;

    try {
      const updated = { ...current, visibility };
      await invoke("save_connect_settings", { settings: updated });
      setSettings(updated);
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to change visibility:", e);
    }
  };

  const handleBlockPeer = async (peerId: string) => {
    try {
      await invoke("block_peer", { peerId });
      setPeers(prev => prev.filter(p => p.id !== peerId));
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to block peer:", e);
    }
  };

  const handleSendFriendRequest = async (peer: PeerInfo) => {
    try {
      await invoke("send_friend_request", { peerId: peer.id });
      setOpenPeerMenu(null);
      import("./Toast").then(({ addToast }) => {
        addToast({
          type: "success",
          title: t().notifications.friendRequest,
          message: peer.nickname || t().connect.anonymous,
          duration: 3000,
        });
      });
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to send friend request:", e);
      setError(typeof e === "string" ? e : t().errors.unknown);
    }
  };

  const isFriend = (peerId: string) => {
    return settings()?.trusted_friends.some(f => f.id === peerId) ?? false;
  };

  const handleRequestModpack = async (peer: PeerInfo) => {
    if (!peer.modpacks || peer.modpacks.length === 0) return;

    setOpenPeerMenu(null);
    setError(null);

    try {
      const modpack = peer.modpacks[0];
      await invoke("request_modpack_sync", {
        peerId: peer.id,
        modpackName: modpack.name,
      });

      import("./Toast").then(({ addToast }) => {
        addToast({
          type: "info",
          title: t().connect.syncingModpack,
          message: modpack.name,
          duration: 3000,
        });
      });
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to request modpack:", e);
      const errorMessage = e instanceof Error ? e.message :
        typeof e === 'object' && e !== null && 'message' in e ? String((e as { message: unknown }).message) :
        t().errors.unknown;
      setError(errorMessage);
    }
  };

  const handleConsentResponse = (_approved: boolean, _remember: boolean) => {
    setConsentRequest(null);
  };

  let quickJoinInProgress = false;
  const handleQuickJoin = async (peer: PeerInfo) => {
    if (!peer.current_server || !peer.modpacks?.length || quickJoinInProgress) return;
    quickJoinInProgress = true;

    setJoiningPeer(peer.id);
    setOpenPeerMenu(null);
    setError(null);

    try {
      setJoinStatus(t().connect.syncingModpack);
      const modpack = peer.modpacks[0];

      await invoke("request_modpack_sync", {
        peerId: peer.id,
        modpackName: modpack.name,
      });

      setJoinStatus(t().connect.launchingGame);
      const instanceId = await invoke<string>("quick_join_server", {
        peerId: peer.id,
        serverAddress: peer.current_server,
        modpackName: modpack.name,
      });

      setJoinStatus(t().connect.connectingToServer);
      await invoke("start_instance", { id: instanceId });

      safeTimeout(() => {
        props.onClose();
      }, 500);
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to quick join:", e);
      const errorMessage = e instanceof Error ? e.message :
        typeof e === 'object' && e !== null && 'message' in e ? String((e as { message: unknown }).message) :
        t().errors.unknown;
      setError(errorMessage);
    } finally {
      setJoiningPeer(null);
      setJoinStatus(null);
      quickJoinInProgress = false;
    }
  };

  const togglePeerMenu = (peerId: string) => {
    setOpenPeerMenu(prev => prev === peerId ? null : peerId);
  };

  const handleCopyCode = async () => {
    const code = shortCode();
    if (!code) return;

    try {
      await navigator.clipboard.writeText(code);
      setCodeCopied(true);
      safeTimeout(() => setCodeCopied(false), 2000);
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to copy code:", e);
    }
  };

  const handleConnectByCode = async () => {
    let code = friendCode().trim().toUpperCase();
    if (!code || code.length < 4) return;

    // Auto-add STUZHIK- prefix if not present
    if (!code.startsWith("STUZHIK-")) {
      code = "STUZHIK-" + code;
    }

    // Check if it's a server invite code (STUZHIK-XXXX-XXXX format)
    const isInviteCode = /^STUZHIK-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code);

    if (isInviteCode) {
      setFriendCode(code);
      setShowJoinDialog(true);
      return;
    }

    // Short code for P2P discovery
    setConnectingByCode(true);
    setError(null);

    try {
      await invoke("connect_by_code", { code });
      setFriendCode("");
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to connect by code:", e);
      const errorMessage = e instanceof Error ? e.message :
        typeof e === 'object' && e !== null && 'message' in e ? String((e as { message: unknown }).message) :
        t().connect.invalidCode;
      setError(errorMessage);
    } finally {
      setConnectingByCode(false);
    }
  };

  // Auto-format code input
  const handleCodeInput = (value: string) => {
    let formatted = value.toUpperCase().replace(/[^A-Z0-9-]/g, "");

    // Remove STUZHIK- prefix for editing, we'll add it back
    if (formatted.startsWith("STUZHIK-")) {
      formatted = formatted.slice(8);
    }

    // Auto-add dashes for invite format
    if (formatted.length > 4 && !formatted.includes("-")) {
      formatted = formatted.slice(0, 4) + "-" + formatted.slice(4);
    }

    setFriendCode(formatted.slice(0, 9)); // Max: XXXX-XXXX
  };

  const getVpnInfo = (key: string) => {
    const vpn = (t().connect.vpn as Record<string, { name: string; description: string }>)[key];
    return vpn || { name: key, description: "" };
  };

  const handleCancelTransfer = async (sessionId: string) => {
    try {
      await invoke("cancel_transfer", { sessionId });
      setTransfers(prev => prev.map(t =>
        t.id === sessionId ? { ...t, status: "cancelled" as const } : t
      ));
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to cancel transfer:", e);
    }
  };

  const clearCompletedTransfers = () => {
    setTransfers(prev => prev.filter(t =>
      t.status !== "completed" && t.status !== "failed" && t.status !== "cancelled"
    ));
    if (transfers().length === 0) {
      setShowTransfers(false);
    }
  };

  const activeTransfersCount = () => transfers().filter(t =>
    t.status === "connecting" || t.status === "negotiating" || t.status === "transferring"
  ).length;

  const handleDiagnoseNetwork = async () => {
    if (diagnosing()) return;
    setDiagnosing(true);
    setShowDiagnostics(true);
    try {
      const diagnostics = await invoke<NetworkDiagnostics>("diagnose_network");
      setNetworkDiagnostics(diagnostics);
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to diagnose network:", e);
    } finally {
      setDiagnosing(false);
    }
  };

  // Join discovered server directly
  const handleJoinServer = async (server: DiscoveredServer) => {
    if (!server.invite_code) return;

    setJoiningServer(server.instance_id);
    try {
      await invoke("quick_join_by_invite", {
        inviteCode: server.invite_code,
      });
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to join server:", e);
    } finally {
      setJoiningServer(null);
    }
  };

  // ==================== Queue Handlers ====================

  const pendingQueueCount = () => queue().filter(q => q.status === "pending").length;

  const handleCancelQueuedTransfer = async (queueId: string) => {
    try {
      await invoke("cancel_queued_transfer", { queueId });
      setQueue(prev => prev.filter(q => q.id !== queueId));
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to cancel queued transfer:", e);
    }
  };

  const handleRetryQueuedTransfer = async (queueId: string) => {
    try {
      await invoke("retry_queued_transfer", { queueId });
      setQueue(prev => prev.map(q =>
        q.id === queueId ? { ...q, status: "pending" as const, error: null } : q
      ));
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to retry transfer:", e);
    }
  };

  // ==================== History Handlers ====================

  const handleClearHistory = async () => {
    try {
      await invoke("clear_transfer_history");
      setHistory([]);
      setHistoryStats(null);
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to clear history:", e);
    }
  };

  const handleLoadHistory = async () => {
    setShowHistory(true);
    try {
      const [historyData, statsData] = await Promise.all([
        invoke<TransferHistoryEntry[]>("get_recent_transfer_history", { limit: 50 }),
        invoke<HistoryStats>("get_transfer_history_stats"),
      ]);
      setHistory(historyData);
      setHistoryStats(statsData);
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to load history:", e);
    }
  };

  // ==================== Notifications Handlers ====================

  const unreadNotificationsCount = () => notifications().filter(n => !n.read && !n.dismissed).length;

  const handleDismissNotification = async (notificationId: string) => {
    try {
      await invoke("dismiss_notification", { notificationId });
      setNotifications(prev => prev.filter(n => n.id !== notificationId));
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to dismiss notification:", e);
    }
  };

  const handleMarkAllNotificationsRead = async () => {
    try {
      await invoke("mark_all_notifications_read");
      setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to mark all notifications read:", e);
    }
  };

  return (
    <div class="fixed inset-0 z-50 flex items-start justify-end pt-[calc(var(--titlebar-height)+0.5rem)] pr-3">
      {/* Backdrop - starts below TitleBar to avoid blocking it */}
      <div class="absolute inset-0 top-[var(--titlebar-height)]" onClick={() => {
        setOpenPeerMenu(null);
        props.onClose();
      }} />

      {/* Panel */}
      <div
        class="bg-gray-850 border border-gray-700 rounded-xl shadow-2xl w-96 max-h-[80vh] overflow-hidden flex flex-col animate-in slide-in-from-right duration-100"
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest('[data-peer-menu]')) {
            setOpenPeerMenu(null);
          }
        }}
      >
        {/* Header */}
        <div class="p-4 border-b border-gray-700 flex items-center justify-between">
          <div>
            <h2 class="text-lg font-semibold text-white">{t().connect.title}</h2>
            <p class="text-xs text-gray-400">{t().connect.subtitle}</p>
          </div>
          <div class="flex items-center gap-2">
            <Tooltip text={t().connect.openSettings} position="bottom">
              <button
                class="p-1.5 text-gray-400 hover:text-white hover:bg-gray-700 rounded-lg transition-colors"
                onClick={() => {
                  props.onClose();
                  props.onOpenSettings("connect");
                }}
              >
                <div class="i-hugeicons-settings-02 w-4 h-4" />
              </button>
            </Tooltip>
            <button
              class="btn-close"
              onClick={props.onClose}
              aria-label={t().ui?.tooltips?.close ?? "Close"}
            >
              <i class="i-hugeicons-cancel-01 w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div class="flex-1 overflow-y-auto p-4">
          <Show when={loading()}>
            <div class="flex items-center justify-center py-8">
              <div class="i-hugeicons-loading-01 w-6 h-6 animate-spin text-[var(--color-primary)]" />
            </div>
          </Show>

          <Show when={!loading()}>
            {/* Error message */}
            <Show when={error()}>
              <div class="mb-4 p-3 bg-red-600/10 border border-red-600/30 rounded-xl flex items-start gap-2">
                <div class="i-hugeicons-alert-02 w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                <div class="flex-1 min-w-0">
                  <p class="text-sm text-red-400">{error()}</p>
                </div>
                <button
                  class="text-red-400 hover:text-red-300 flex-shrink-0"
                  onClick={() => setError(null)}
                >
                  <div class="i-hugeicons-cancel-01 w-4 h-4" />
                </button>
              </div>
            </Show>

            {/* Enable/Disable Toggle */}
            <div class="flex items-center justify-between p-3 bg-gray-800 rounded-xl mb-4">
              <div class="flex items-center gap-3">
                <div class={`w-2 h-2 rounded-full ${settings()?.enabled ? "bg-green-500" : "bg-gray-500"}`} />
                <span class="text-sm">
                  {settings()?.enabled ? t().common.enabled : t().common.disabled}
                </span>
              </div>
              <Toggle
                checked={settings()?.enabled || false}
                onChange={handleToggleConnect}
                loading={enabling()}
                disabled={enabling()}
              />
            </div>

            {/* When disabled - show enable prompt and VPN recommendations */}
            <Show when={!settings()?.enabled}>
              <div class="flex flex-col items-center text-center py-4 gap-3">
                <div class="i-hugeicons-user-group w-10 h-10 text-gray-600" />
                <p class="text-gray-400 text-sm">{t().connect.enableHint}</p>
              </div>

              {/* VPN Recommendations */}
              <div class="mt-4 pt-4 border-t border-gray-700 flex flex-col gap-3">
                <p class="text-xs text-gray-500">{t().connect.vpnHint}</p>
                <div class="flex flex-col gap-2">
                  <For each={VPN_APPS}>
                    {(vpn) => {
                      const info = getVpnInfo(vpn.key);
                      return (
                        <a
                          href={vpn.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          class={`p-3 rounded-xl transition-colors group ${
                            vpn.recommended
                              ? "bg-blue-900/20 border border-blue-800/50 hover:bg-blue-900/30"
                              : "bg-gray-800 hover:bg-gray-750"
                          }`}
                        >
                          <div class="flex flex-col gap-1.5">
                            <div class="flex items-start justify-between gap-2">
                              <div class="flex items-center gap-2">
                                <div class={`w-4 h-4 flex-shrink-0 ${
                                  vpn.recommended
                                    ? "i-hugeicons-star text-blue-400"
                                    : "i-hugeicons-link-01 text-gray-500 group-hover:text-blue-400"
                                }`} />
                                <span class="text-sm font-medium text-gray-300 group-hover:text-white">
                                  {info.name}
                                </span>
                                <Show when={vpn.recommended}>
                                  <span class="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-primary)] text-white">
                                    {t().connect.recommended}
                                  </span>
                                </Show>
                              </div>
                              <span class={`text-xs px-2 py-0.5 rounded-full flex-shrink-0 ${
                                vpn.difficulty === "easy" ? "bg-green-900/50 text-green-400" :
                                vpn.difficulty === "medium" ? "bg-amber-900/50 text-amber-400" :
                                "bg-blue-900/50 text-blue-400"
                              }`}>
                                {getDifficultyLabel(vpn.difficulty)}
                              </span>
                            </div>
                            <p class="text-xs text-gray-500 leading-relaxed pl-6">
                              {info.description}
                            </p>
                          </div>
                        </a>
                      );
                    }}
                  </For>
                </div>
              </div>
            </Show>

            {/* When enabled - show peers or search status */}
            <Show when={settings()?.enabled}>
              {/* Short code section */}
              <div class="space-y-3 pb-3 border-b border-gray-700 mb-3">
                {/* Your code */}
                <Show when={shortCode()}>
                  <div class="bg-gray-800/50 rounded-lg p-3 flex flex-col gap-1">
                    <div class="flex items-center justify-between">
                      <span class="text-xs text-gray-500">{t().connect.yourCode}</span>
                      <span class="text-xs text-gray-600">{t().connect.yourCodeHint}</span>
                    </div>
                    <div class="flex items-center gap-2">
                      <code class="flex-1 bg-gray-900 px-3 py-2 rounded-lg font-mono text-lg text-center text-blue-400 tracking-wider">
                        {shortCode()}
                      </code>
                      <Tooltip text={codeCopied() ? t().connect.copied : t().common.copy} position="bottom">
                        <button
                          class={`p-2 rounded-lg transition-colors ${
                            codeCopied()
                              ? "bg-green-600 text-white"
                              : "bg-gray-700 hover:bg-gray-600 text-gray-400 hover:text-white"
                          }`}
                          onClick={handleCopyCode}
                        >
                          <i class={`w-5 h-5 ${codeCopied() ? "i-hugeicons-checkmark-circle-02" : "i-hugeicons-copy-01"}`} />
                        </button>
                      </Tooltip>
                    </div>
                  </div>
                </Show>

                {/* Universal code input */}
                <div class="bg-gray-800/50 rounded-lg p-3 flex flex-col gap-2">
                  <div class="flex items-center justify-between">
                    <span class="text-xs text-gray-500">{t().connect?.codeHint ?? "Enter friend code or invite"}</span>
                  </div>
                  <div class="flex gap-2">
                    <div class="flex-1 flex items-center bg-gray-900 rounded-xl border border-gray-700 focus-within:border-[var(--color-primary)]">
                      <span class="pl-3 pr-1 text-gray-500 font-mono text-sm select-none">STUZHIK-</span>
                      <input
                        type="text"
                        placeholder="XXXX-XXXX"
                        value={friendCode()}
                        onInput={(e) => handleCodeInput(e.currentTarget.value)}
                        onKeyDown={(e) => e.key === "Enter" && handleConnectByCode()}
                        class="flex-1 bg-transparent py-1 px-1 text-sm font-mono tracking-wider placeholder:text-gray-600 focus:outline-none border-none"
                        maxLength={9}
                        disabled={connectingByCode()}
                      />
                    </div>
                    <button
                      class={`px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2 ${
                        connectingByCode()
                          ? "bg-[var(--color-primary-bg)] text-[var(--color-primary-light)] cursor-wait"
                          : "bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white"
                      }`}
                      onClick={handleConnectByCode}
                      disabled={connectingByCode() || friendCode().length < 4}
                    >
                      <Show when={connectingByCode()} fallback={
                        <>
                          <i class="i-hugeicons-link-01 w-4 h-4" />
                          {t().connect.connect}
                        </>
                      }>
                        <i class="i-svg-spinners-ring-resize w-4 h-4" />
                      </Show>
                    </button>
                  </div>
                  <p class="text-xs text-gray-500">
                    XXXX — код друга &nbsp;•&nbsp; XXXX-XXXX — приглашение на сервер
                  </p>
                </div>

                {/* Discovered Servers Section */}
                <Show when={discoveredServers().length > 0}>
                  <div class="pt-3 border-t border-gray-700/50 flex flex-col gap-2">
                    <div class="flex items-center gap-2">
                      <i class="i-hugeicons-hard-drive w-4 h-4 text-green-400" />
                      <span class="text-sm font-medium text-gray-200">Доступные серверы</span>
                      <span class="text-xs px-1.5 py-0.5 bg-green-600/20 text-green-400 rounded-full">
                        {discoveredServers().length}
                      </span>
                    </div>
                    <div class="space-y-2">
                      <For each={discoveredServers()}>
                        {(server) => (
                          <div class="p-3 bg-gray-800/50 rounded-xl hover:bg-gray-800 transition-colors border border-gray-700/50">
                            <div class="flex items-start gap-3">
                              <div class="w-10 h-10 rounded-lg bg-gradient-to-br from-green-600/30 to-emerald-600/30 flex items-center justify-center flex-shrink-0">
                                <i class="i-hugeicons-package w-5 h-5 text-green-400" />
                              </div>
                              <div class="flex-1 min-w-0">
                                <div class="flex items-center gap-2">
                                  <span class="font-medium text-sm truncate text-gray-100">
                                    {server.name}
                                  </span>
                                  <Show when={server.online_players !== null}>
                                    <span class="text-xs px-1.5 py-0.5 bg-blue-600/20 text-blue-400 rounded">
                                      {server.online_players}/{server.max_players || "?"}
                                    </span>
                                  </Show>
                                </div>
                                <div class="flex items-center gap-2 text-xs text-gray-500 mt-0.5">
                                  <span>{server.mc_version}</span>
                                  <span class="text-gray-600">•</span>
                                  <span class="capitalize">{server.loader}</span>
                                  <span class="text-gray-600">•</span>
                                  <span>{server.mod_count} модов</span>
                                </div>
                                <Show when={server.host_nickname}>
                                  <div class="text-xs text-gray-500 mt-1 flex items-center gap-1">
                                    <i class="i-hugeicons-user w-3 h-3" />
                                    <span>от {server.host_nickname}</span>
                                  </div>
                                </Show>
                              </div>
                              <Show when={server.invite_code}>
                                <button
                                  class={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5 ${
                                    joiningServer() === server.instance_id
                                      ? "bg-green-600/30 text-green-300 cursor-wait"
                                      : "bg-green-600 hover:bg-green-500 text-white"
                                  }`}
                                  onClick={() => handleJoinServer(server)}
                                  disabled={joiningServer() === server.instance_id}
                                >
                                  <Show when={joiningServer() === server.instance_id} fallback={
                                    <>
                                      <i class="i-hugeicons-play w-4 h-4" />
                                      <span>Играть</span>
                                    </>
                                  }>
                                    <i class="i-svg-spinners-ring-resize w-4 h-4" />
                                  </Show>
                                </button>
                              </Show>
                            </div>
                            <Show when={server.motd}>
                              <div class="mt-2 text-xs text-gray-400 italic truncate">
                                {server.motd}
                              </div>
                            </Show>
                          </div>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>

              </div>

              {/* Peers list */}
              <Show when={peers().length > 0} fallback={
                <div class="flex flex-col items-center text-center py-6 gap-3">
                  <div class="i-hugeicons-search-01 w-8 h-8 text-gray-500 animate-pulse" />
                  <div class="flex flex-col gap-1">
                    <p class="text-gray-400">{t().connect.searching}</p>
                    <p class="text-xs text-gray-500">{t().connect.noPeersHint}</p>
                  </div>
                </div>
              }>
                <div class="space-y-2">
                  <div class="flex items-center justify-between text-xs text-gray-500 px-1">
                    <span>{t().connect.foundPeers.replace("{count}", String(peers().length))}</span>
                  </div>
                  <For each={peers()}>
                    {(peer) => (
                      <PeerCard
                        peer={peer}
                        isFriend={isFriend(peer.id)}
                        joiningPeer={joiningPeer()}
                        joinStatus={joinStatus()}
                        openPeerMenu={openPeerMenu()}
                        onTogglePeerMenu={togglePeerMenu}
                        onQuickJoin={handleQuickJoin}
                        onRequestModpack={handleRequestModpack}
                        onSendFriendRequest={handleSendFriendRequest}
                        onBlockPeer={handleBlockPeer}
                        t={t}
                      />
                    )}
                  </For>
                </div>
              </Show>

              {/* Transfers section */}
              <Show when={transfers().length > 0}>
                <TransferList
                  transfers={transfers}
                  showTransfers={showTransfers}
                  onToggleShow={() => setShowTransfers(!showTransfers())}
                  onCancelTransfer={handleCancelTransfer}
                  onClearCompleted={clearCompletedTransfers}
                  activeTransfersCount={activeTransfersCount}
                  t={t}
                />
              </Show>

              {/* Transfer Queue section */}
              <Show when={queue().length > 0}>
                <div class="mt-4 pt-4 border-t border-gray-700">
                  <button
                    class="w-full flex items-center justify-between p-2 rounded-lg hover:bg-gray-800 transition-colors"
                    onClick={() => setShowQueue(!showQueue())}
                  >
                    <div class="flex items-center gap-2">
                      <i class="i-hugeicons-menu-01 w-4 h-4 text-purple-400" />
                      <span class="text-sm font-medium">{t().connect.queue?.title || "Queue"}</span>
                      <Show when={pendingQueueCount() > 0}>
                        <span class="px-1.5 py-0.5 rounded-full bg-purple-600 text-xs text-white">
                          {pendingQueueCount()}
                        </span>
                      </Show>
                    </div>
                    <i class={`w-4 h-4 text-gray-400 transition-transform ${showQueue() ? "i-hugeicons-arrow-up-01" : "i-hugeicons-arrow-down-01"}`} />
                  </button>

                  <Show when={showQueue()}>
                    <div class="mt-2 space-y-2">
                      <For each={queue()}>
                        {(item) => (
                          <div class={`p-3 rounded-lg flex flex-col gap-1 ${
                            item.status === "pending" ? "bg-gray-800" :
                            item.status === "active" ? "bg-blue-900/20 border border-blue-800/50" :
                            item.status === "failed" ? "bg-red-900/20 border border-red-800/50" :
                            "bg-gray-800/50"
                          }`}>
                            <div class="flex items-center justify-between">
                              <div class="flex items-center gap-2 min-w-0">
                                <span class={`text-xs px-1.5 py-0.5 rounded ${
                                  item.priority === "urgent" ? "bg-red-600 text-white" :
                                  item.priority === "high" ? "bg-orange-600 text-white" :
                                  item.priority === "low" ? "bg-gray-600 text-gray-300" :
                                  "bg-[var(--color-primary)] text-white"
                                }`}>
                                  {item.priority}
                                </span>
                                <span class="text-sm truncate">{item.modpack_name}</span>
                              </div>
                              <div class="flex items-center gap-1">
                                <Show when={item.status === "pending"}>
                                  <Tooltip text={t().connect.transfer.cancel} position="bottom">
                                    <button
                                      class="p-1 rounded hover:bg-gray-700 text-gray-400 hover:text-red-400 transition-colors"
                                      onClick={() => handleCancelQueuedTransfer(item.id)}
                                    >
                                      <i class="i-hugeicons-cancel-01 w-4 h-4" />
                                    </button>
                                  </Tooltip>
                                </Show>
                                <Show when={item.status === "failed"}>
                                  <Tooltip text={t().connect.queue?.retry || "Retry"} position="bottom">
                                    <button
                                      class="p-1 rounded hover:bg-gray-700 text-gray-400 hover:text-[var(--color-primary)] transition-colors"
                                      onClick={() => handleRetryQueuedTransfer(item.id)}
                                    >
                                      <i class="i-hugeicons-refresh w-4 h-4" />
                                    </button>
                                  </Tooltip>
                                </Show>
                              </div>
                            </div>
                            <div class="flex items-center justify-between text-xs text-gray-500">
                              <span>{item.peer_nickname || item.peer_id.slice(0, 8)}</span>
                              <span class={
                                item.status === "active" ? "text-blue-400" :
                                item.status === "failed" ? "text-red-400" :
                                "text-gray-500"
                              }>
                                {item.status === "pending" ? t().connect.queue?.pending || "Pending" :
                                 item.status === "active" ? t().connect.queue?.active || "Active" :
                                 item.status === "failed" ? item.error?.slice(0, 30) || "Failed" :
                                 item.status}
                              </span>
                            </div>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              </Show>

              {/* Transfer History section */}
              <TransferHistorySection
                history={history}
                historyStats={historyStats}
                showHistory={showHistory}
                onToggleShow={() => showHistory() ? setShowHistory(false) : handleLoadHistory()}
                onClearHistory={handleClearHistory}
                t={t}
              />

              {/* Update Notifications section */}
              <Show when={notifications().length > 0}>
                <div class="mt-4 pt-4 border-t border-gray-700">
                  <button
                    class="w-full flex items-center justify-between p-2 rounded-lg hover:bg-gray-800 transition-colors"
                    onClick={() => setShowNotifications(!showNotifications())}
                  >
                    <div class="flex items-center gap-2">
                      <i class="i-hugeicons-notification-01 w-4 h-4 text-amber-400" />
                      <span class="text-sm font-medium">{t().connect.notifications?.title || "Updates"}</span>
                      <Show when={unreadNotificationsCount() > 0}>
                        <span class="px-1.5 py-0.5 rounded-full bg-amber-600 text-xs text-white">
                          {unreadNotificationsCount()}
                        </span>
                      </Show>
                    </div>
                    <i class={`w-4 h-4 text-gray-400 transition-transform ${showNotifications() ? "i-hugeicons-arrow-up-01" : "i-hugeicons-arrow-down-01"}`} />
                  </button>

                  <Show when={showNotifications()}>
                    <div class="mt-2 space-y-2">
                      <For each={notifications()}>
                        {(notification) => (
                          <div class={`p-3 rounded-lg flex flex-col gap-1 ${notification.read ? "bg-gray-800/50" : "bg-amber-900/20 border border-amber-800/50"}`}>
                            <div class="flex items-center justify-between">
                              <div class="flex items-center gap-2 min-w-0">
                                <i class="i-hugeicons-arrow-up-01 w-4 h-4 text-amber-400 flex-shrink-0" />
                                <span class="text-sm truncate">{notification.modpack_name}</span>
                              </div>
                              <button
                                class="p-1 rounded hover:bg-gray-700 text-gray-400 hover:text-gray-200 transition-colors"
                                onClick={() => handleDismissNotification(notification.id)}
                              >
                                <i class="i-hugeicons-cancel-01 w-4 h-4" />
                              </button>
                            </div>
                            <div class="text-xs text-gray-400">
                              {notification.peer_nickname || notification.peer_id.slice(0, 8)} {t().connect.notifications?.hasUpdate || "has update"}
                            </div>
                            <div class="flex items-center justify-between text-xs">
                              <span class="text-gray-500">{notification.local_version}</span>
                              <i class="i-hugeicons-arrow-right-01 w-3 h-3 text-gray-500" />
                              <span class="text-green-400">{notification.peer_version}</span>
                            </div>
                          </div>
                        )}
                      </For>

                      <Show when={unreadNotificationsCount() > 0}>
                        <button
                          class="w-full py-2 text-xs text-gray-500 hover:text-gray-300 transition-colors"
                          onClick={handleMarkAllNotificationsRead}
                        >
                          {t().connect.notifications?.markAllRead || "Mark all as read"}
                        </button>
                      </Show>
                    </div>
                  </Show>
                </div>
              </Show>

              {/* Quick settings */}
              <div class="mt-4 p-3 bg-gray-800/50 rounded-xl space-y-3">
                <div class="flex items-center justify-between text-xs">
                  <span class="text-gray-500">{t().connect.settings.nickname}</span>
                  <span class="text-gray-300">{settings()?.nickname || defaultUsername()}</span>
                </div>

                {/* Quick visibility switcher */}
                <div class="flex items-center justify-between">
                  <span class="text-xs text-gray-500">{t().connect.settings.visibility}</span>
                  <div class="flex items-center gap-1">
                    <Tooltip text={t().connect.settings.visibilityInvisible} position="bottom">
                      <button
                        class={`p-1.5 rounded-lg transition-colors ${
                          settings()?.visibility === "invisible"
                            ? "bg-[var(--color-primary)] text-white"
                            : "bg-gray-700 text-gray-400 hover:bg-gray-600"
                        }`}
                        onClick={() => handleVisibilityChange("invisible")}
                      >
                        <i class="i-hugeicons-view-off w-4 h-4" />
                      </button>
                    </Tooltip>
                    <Tooltip text={t().connect.settings.visibilityFriends} position="bottom">
                      <button
                        class={`p-1.5 rounded-lg transition-colors ${
                          settings()?.visibility === "friends_only"
                            ? "bg-[var(--color-primary)] text-white"
                            : "bg-gray-700 text-gray-400 hover:bg-gray-600"
                        }`}
                        onClick={() => handleVisibilityChange("friends_only")}
                      >
                        <i class="i-hugeicons-user-multiple w-4 h-4" />
                      </button>
                    </Tooltip>
                    <Tooltip text={t().connect.settings.visibilityAll} position="bottom">
                      <button
                        class={`p-1.5 rounded-lg transition-colors ${
                          settings()?.visibility === "local_network"
                            ? "bg-[var(--color-primary)] text-white"
                            : "bg-gray-700 text-gray-400 hover:bg-gray-600"
                        }`}
                        onClick={() => handleVisibilityChange("local_network")}
                      >
                        <i class="i-hugeicons-wifi-01 w-4 h-4" />
                      </button>
                    </Tooltip>
                  </div>
                </div>
              </div>

              {/* Network Diagnostics */}
              <NetworkDiagnosticsPanel
                networkDiagnostics={networkDiagnostics}
                diagnosing={diagnosing}
                showDiagnostics={showDiagnostics}
                onToggleShow={() => showDiagnostics() ? setShowDiagnostics(false) : handleDiagnoseNetwork()}
                onDiagnose={handleDiagnoseNetwork}
                t={t}
              />

              {/* VPN hint for enabled state too */}
              <div class="mt-4 pt-4 border-t border-gray-700 flex flex-col gap-2">
                <p class="text-xs text-gray-500">{t().connect.vpnHint}</p>
                <div class="flex flex-wrap gap-2">
                  <For each={VPN_APPS}>
                    {(vpn) => {
                      const info = getVpnInfo(vpn.key);
                      return (
                        <a
                          href={vpn.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          class="text-xs px-2 py-1 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 transition-colors"
                        >
                          {info.name}
                        </a>
                      );
                    }}
                  </For>
                </div>
              </div>
            </Show>
          </Show>
        </div>
      </div>

      {/* Consent Dialog */}
      <Show when={consentRequest()}>
        <ConsentDialog
          request={consentRequest()!}
          onResponse={handleConsentResponse}
          onClose={() => setConsentRequest(null)}
        />
      </Show>

      {/* Join Server Dialog */}
      <Show when={showJoinDialog()}>
        <JoinServerDialog
          onClose={() => {
            setShowJoinDialog(false);
            setFriendCode("");
          }}
          onSuccess={(instanceId) => {
            setShowJoinDialog(false);
            setFriendCode("");
            if (import.meta.env.DEV) console.log("Joined server, created instance:", instanceId);
          }}
          initialCode={friendCode().includes("-") ? `STUZHIK-${friendCode()}` : undefined}
        />
      </Show>
    </div>
  );
}

export default ConnectPanel;
