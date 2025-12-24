import { createSignal, onMount, onCleanup, Show, For, lazy } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { useI18n } from "../i18n";
import { Toggle } from "../ui";
import { ConsentDialog, ConsentRequest } from "./ConsentDialog";
import { useSafeTimers } from "../hooks";

const JoinServerDialog = lazy(() => import("../../features/instances/components/JoinServerDialog"));

interface PeerInfo {
  id: string;
  nickname: string | null;
  address: string;
  port: number;
  app_version: string;
  last_seen: string;
  status: "online" | "in_game" | "away";
  modpacks: Array<{ name: string; minecraft_version: string; loader: string; mod_count: number }> | null;
  current_server: string | null;
}

interface ConnectSettings {
  enabled: boolean;
  nickname: string;
  visibility: string;
  show_nickname: boolean;
  show_modpacks: boolean;
  show_current_server: boolean;
  discovery_port: number;
  send: {
    modpacks: string;
    configs: string;
    resourcepacks: string;
    shaderpacks: string;
  };
  receive: {
    modpacks: string;
    configs: string;
    resourcepacks: string;
    shaderpacks: string;
    verify_hashes: boolean;
  };
  blocked_peers: string[];
  trusted_friends: Array<{
    id: string;
    nickname: string;
    public_key: string;
    added_at: string;
    note?: string;
  }>;
  remembered_permissions: Array<{
    peer_id: string;
    content_type: string;
    allowed: boolean;
    created_at: string;
  }>;
}

interface TransferSession {
  id: string;
  peer_id: string;
  peer_nickname: string | null;
  direction: "upload" | "download";
  status: "connecting" | "negotiating" | "transferring" | "paused" | "completed" | "failed" | "cancelled";
  files_total: number;
  files_done: number;
  bytes_total: number;
  bytes_done: number;
  current_file: string | null;
  started_at: string;
  speed_bps?: number;
  eta_seconds?: number;
}

interface TransferHistoryEntry {
  id: string;
  peer_id: string;
  peer_nickname: string | null;
  modpack_name: string;
  direction: "upload" | "download";
  result: "success" | "failed" | "cancelled";
  files_count: number;
  bytes_total: number;
  started_at: string;
  completed_at: string;
  duration_seconds: number;
  error_message: string | null;
}

interface HistoryStats {
  total_transfers: number;
  successful: number;
  failed: number;
  cancelled: number;
  total_bytes_uploaded: number;
  total_bytes_downloaded: number;
}

interface QueuedTransfer {
  id: string;
  peer_id: string;
  peer_nickname: string | null;
  modpack_name: string;
  priority: "low" | "normal" | "high" | "urgent";
  status: "pending" | "active" | "completed" | "failed" | "cancelled";
  queued_at: string;
  session_id: string | null;
  error: string | null;
}

interface UpdateNotification {
  id: string;
  peer_id: string;
  peer_nickname: string | null;
  modpack_name: string;
  local_version: string;
  peer_version: string;
  created_at: string;
  read: boolean;
  dismissed: boolean;
}

interface NetworkRecommendation {
  priority: number;
  title: string;
  description: string;
  action: string | null;
}

interface NetworkInterface {
  name: string;
  ip: string;
  is_vpn: boolean;
}

interface PortStatus {
  port: number;
  open: boolean;
  status: string;
}

interface NetworkDiagnostics {
  local_ip: string | null;
  all_interfaces: NetworkInterface[];
  udp_port: number;
  tcp_port: number;
  udp_status: PortStatus;
  tcp_status: PortStatus;
  udp_port_open: boolean;
  tcp_port_open: boolean;
  connect_enabled: boolean;
  peers_found: boolean;
  firewall_likely_blocking: boolean;
  recommendations: NetworkRecommendation[];
}

interface DiscoveredServer {
  instance_id: string;
  name: string;
  mc_version: string;
  loader: string;
  server_address: string;
  manifest_hash: string;
  mod_count: number;
  total_size: number;
  updated_at: number;
  online_players: number | null;
  max_players: number | null;
  motd: string | null;
  invite_code: string | null;
  host_peer_id: string;
  host_nickname: string | null;
}

// Raw API response type (without host_peer_id and host_nickname)
type DiscoveredServerRaw = Omit<DiscoveredServer, "host_peer_id" | "host_nickname">;
type DiscoveredServersResponse = Array<[string, DiscoveredServerRaw]>;

interface ConnectPanelProps {
  onClose: () => void;
  onOpenSettings: (scrollTo?: string) => void;
}

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
          console.error("Failed to load discovered servers:", e);
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
      unlistenTransfer = await listen<{ type: string; session?: TransferSession; session_id?: string; bytes_done?: number; bytes_total?: number; files_done?: number; files_total?: number; current_file?: string }>("transfer-event", (event) => {
        const data = event.payload;
        if (data.type === "session_created" && data.session) {
          setTransfers(prev => [...prev, data.session!]);
          setShowTransfers(true);
        } else if (data.type === "progress" && data.session_id) {
          setTransfers(prev => prev.map(t =>
            t.id === data.session_id
              ? { ...t, bytes_done: data.bytes_done ?? t.bytes_done, files_done: data.files_done ?? t.files_done, current_file: data.current_file ?? t.current_file }
              : t
          ));
        } else if (data.type === "completed" && data.session_id) {
          setTransfers(prev => prev.map(t =>
            t.id === data.session_id ? { ...t, status: "completed" as const } : t
          ));
        } else if (data.type === "error" && data.session_id) {
          setTransfers(prev => prev.map(t =>
            t.id === data.session_id ? { ...t, status: "failed" as const } : t
          ));
        } else if (data.type === "cancelled" && data.session_id) {
          setTransfers(prev => prev.map(t =>
            t.id === data.session_id ? { ...t, status: "cancelled" as const } : t
          ));
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
      console.error("Failed to load connect settings:", e);
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
      console.error("Failed to toggle Connect:", e);
      // Показываем ошибку пользователю
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
      console.error("Failed to change visibility:", e);
    }
  };

  const handleBlockPeer = async (peerId: string) => {
    try {
      await invoke("block_peer", { peerId });
      // Удаляем пира из локального списка
      setPeers(prev => prev.filter(p => p.id !== peerId));
    } catch (e) {
      console.error("Failed to block peer:", e);
    }
  };

  const handleSendFriendRequest = async (peer: PeerInfo) => {
    try {
      await invoke("send_friend_request", { peerId: peer.id });
      setOpenPeerMenu(null);
      // Show toast notification that request was sent
      import("./Toast").then(({ addToast }) => {
        addToast({
          type: "success",
          title: t().notifications.friendRequest,
          message: peer.nickname || t().connect.anonymous,
          duration: 3000,
        });
      });
    } catch (e) {
      console.error("Failed to send friend request:", e);
      setError(typeof e === "string" ? e : t().errors.unknown);
    }
  };

  // Note: Friend requests are handled via the transfer-event listener in ToastProvider
  // When a friend_request event is received, a toast is shown
  // User can then manually add the friend via the peer context menu

  const isFriend = (peerId: string) => {
    return settings()?.trusted_friends.some(f => f.id === peerId) ?? false;
  };

  const handleRequestModpack = async (peer: PeerInfo) => {
    if (!peer.modpacks || peer.modpacks.length === 0) return;

    setOpenPeerMenu(null);
    setError(null);

    try {
      // Запрашиваем синхронизацию первого (активного) модпака
      const modpack = peer.modpacks[0];
      await invoke("request_modpack_sync", {
        peerId: peer.id,
        modpackName: modpack.name,
      });

      // Показываем уведомление о начале синхронизации
      import("./Toast").then(({ addToast }) => {
        addToast({
          type: "info",
          title: t().connect.syncingModpack,
          message: modpack.name,
          duration: 3000,
        });
      });
    } catch (e) {
      console.error("Failed to request modpack:", e);
      const errorMessage = e instanceof Error ? e.message :
        typeof e === 'object' && e !== null && 'message' in e ? String((e as { message: unknown }).message) :
        t().errors.unknown;
      setError(errorMessage);
    }
  };

  const handleConsentResponse = (_approved: boolean, _remember: boolean) => {
    // Callback after consent response is handled
    setConsentRequest(null);
  };

  const handleQuickJoin = async (peer: PeerInfo) => {
    if (!peer.current_server || !peer.modpacks?.length) return;

    setJoiningPeer(peer.id);
    setOpenPeerMenu(null);
    setError(null);

    try {
      // 1. Синхронизация модпака (пока просто логируем)
      setJoinStatus(t().connect.syncingModpack);
      const modpack = peer.modpacks[0]; // Берём первый модпак (активный)

      // Запрашиваем синхронизацию модпака у пира
      await invoke("request_modpack_sync", {
        peerId: peer.id,
        modpackName: modpack.name,
      });

      // 2. Подготовка экземпляра для подключения к серверу
      setJoinStatus(t().connect.launchingGame);
      const instanceId = await invoke<string>("quick_join_server", {
        peerId: peer.id,
        serverAddress: peer.current_server,
        modpackName: modpack.name,
      });

      // 3. Запускаем экземпляр
      setJoinStatus(t().connect.connectingToServer);
      await invoke("start_instance", { id: instanceId });

      // Закрываем панель после успешного запуска
      safeTimeout(() => {
        props.onClose();
      }, 500);
    } catch (e) {
      console.error("Failed to quick join:", e);
      const errorMessage = e instanceof Error ? e.message :
        typeof e === 'object' && e !== null && 'message' in e ? String((e as { message: unknown }).message) :
        t().errors.unknown;
      setError(errorMessage);
    } finally {
      setJoiningPeer(null);
      setJoinStatus(null);
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
      console.error("Failed to copy code:", e);
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
      // Server invite - open dialog with pre-filled code
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
      console.error("Failed to connect by code:", e);
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

  const formatBytes = (bytes: number | undefined | null) => {
    if (bytes === undefined || bytes === null || isNaN(bytes) || bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  };

  const handleCancelTransfer = async (sessionId: string) => {
    try {
      await invoke("cancel_transfer", { sessionId });
      setTransfers(prev => prev.map(t =>
        t.id === sessionId ? { ...t, status: "cancelled" as const } : t
      ));
    } catch (e) {
      console.error("Failed to cancel transfer:", e);
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
    setDiagnosing(true);
    setShowDiagnostics(true);
    try {
      const diagnostics = await invoke<NetworkDiagnostics>("diagnose_network");
      setNetworkDiagnostics(diagnostics);
    } catch (e) {
      console.error("Failed to diagnose network:", e);
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
      console.error("Failed to join server:", e);
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
      console.error("Failed to cancel queued transfer:", e);
    }
  };

  const handleRetryQueuedTransfer = async (queueId: string) => {
    try {
      await invoke("retry_queued_transfer", { queueId });
      setQueue(prev => prev.map(q =>
        q.id === queueId ? { ...q, status: "pending" as const, error: null } : q
      ));
    } catch (e) {
      console.error("Failed to retry transfer:", e);
    }
  };

  // ==================== History Handlers ====================

  const handleClearHistory = async () => {
    try {
      await invoke("clear_transfer_history");
      setHistory([]);
      setHistoryStats(null);
    } catch (e) {
      console.error("Failed to clear history:", e);
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
      console.error("Failed to load history:", e);
    }
  };

  // ==================== Notifications Handlers ====================

  const unreadNotificationsCount = () => notifications().filter(n => !n.read && !n.dismissed).length;

  const handleDismissNotification = async (notificationId: string) => {
    try {
      await invoke("dismiss_notification", { notificationId });
      setNotifications(prev => prev.filter(n => n.id !== notificationId));
    } catch (e) {
      console.error("Failed to dismiss notification:", e);
    }
  };

  const handleMarkAllNotificationsRead = async () => {
    try {
      await invoke("mark_all_notifications_read");
      setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    } catch (e) {
      console.error("Failed to mark all notifications read:", e);
    }
  };

  const formatTimeAgo = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return t().connect.timeAgo.justNow;
    if (diffMins < 60) return `${diffMins} ${t().connect.timeAgo.minutes}`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours} ${t().connect.timeAgo.hours}`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays} ${t().connect.timeAgo.days}`;
  };

  return (
    <div class="fixed inset-0 z-50 flex items-start justify-end pt-[calc(var(--titlebar-height)+0.5rem)] pr-3">
      {/* Backdrop */}
      <div class="absolute inset-0" onClick={() => {
        setOpenPeerMenu(null);
        props.onClose();
      }} />

      {/* Panel */}
      <div
        class="bg-gray-850 border border-gray-700 rounded-xl shadow-2xl w-96 max-h-[80vh] overflow-hidden flex flex-col animate-in slide-in-from-right duration-100"
        onClick={(e) => {
          // Close peer menu if clicking inside panel but not on menu items
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
            {/* Settings button */}
            <button
              class="p-1.5 text-gray-400 hover:text-white hover:bg-gray-700 rounded-lg transition-colors"
              onClick={() => {
                props.onClose();
                props.onOpenSettings("connect");
              }}
              title={t().connect.openSettings}
            >
              <div class="i-hugeicons-settings-02 w-4 h-4" />
            </button>
            <button
              class="btn-close"
              onClick={props.onClose}
            >
              <i class="i-hugeicons-cancel-01 w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div class="flex-1 overflow-y-auto p-4">
          <Show when={loading()}>
            <div class="flex items-center justify-center py-8">
              <div class="i-hugeicons-loading-01 w-6 h-6 animate-spin text-blue-500" />
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
              <div class="text-center py-4">
                <div class="i-hugeicons-user-group w-10 h-10 mx-auto text-gray-600 mb-3" />
                <p class="text-gray-400 text-sm">{t().connect.enableHint}</p>
              </div>

              {/* VPN Recommendations */}
              <div class="mt-4 pt-4 border-t border-gray-700">
                <p class="text-xs text-gray-500 mb-3">{t().connect.vpnHint}</p>
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
                          <div class="flex items-start justify-between gap-2 mb-1.5">
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
                                <span class="text-[10px] px-1.5 py-0.5 rounded bg-blue-600 text-white">
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
                  <div class="bg-gray-800/50 rounded-lg p-3">
                    <div class="flex items-center justify-between mb-1">
                      <span class="text-xs text-gray-500">{t().connect.yourCode}</span>
                      <span class="text-xs text-gray-600">{t().connect.yourCodeHint}</span>
                    </div>
                    <div class="flex items-center gap-2">
                      <code class="flex-1 bg-gray-900 px-3 py-2 rounded-lg font-mono text-lg text-center text-blue-400 tracking-wider">
                        {shortCode()}
                      </code>
                      <button
                        class={`p-2 rounded-lg transition-colors ${
                          codeCopied()
                            ? "bg-green-600 text-white"
                            : "bg-gray-700 hover:bg-gray-600 text-gray-400 hover:text-white"
                        }`}
                        onClick={handleCopyCode}
                        title={codeCopied() ? t().connect.copied : t().common.copy}
                      >
                        <i class={`w-5 h-5 ${codeCopied() ? "i-hugeicons-checkmark-circle-02" : "i-hugeicons-copy-01"}`} />
                      </button>
                    </div>
                  </div>
                </Show>

                {/* Universal code input - works for both short codes and server invites */}
                <div class="bg-gray-800/50 rounded-lg p-3">
                  <div class="flex items-center justify-between mb-2">
                    <span class="text-xs text-gray-500">Введите код друга или приглашение</span>
                  </div>
                  <div class="flex gap-2">
                    <div class="flex-1 flex items-center bg-gray-900 rounded-lg border border-gray-700 focus-within:border-blue-500">
                      <span class="pl-3 pr-1 text-gray-500 font-mono text-sm">STUZHIK-</span>
                      <input
                        type="text"
                        placeholder="XXXX или XXXX-XXXX"
                        value={friendCode()}
                        onInput={(e) => handleCodeInput(e.currentTarget.value)}
                        onKeyDown={(e) => e.key === "Enter" && handleConnectByCode()}
                        class="flex-1 bg-transparent py-2 pr-3 text-sm font-mono tracking-wider placeholder:text-gray-600 focus:outline-none"
                        maxLength={9}
                        disabled={connectingByCode()}
                      />
                    </div>
                    <button
                      class={`px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2 ${
                        connectingByCode()
                          ? "bg-blue-600/50 text-blue-300 cursor-wait"
                          : "bg-blue-600 hover:bg-blue-500 text-white"
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
                  <p class="text-xs text-gray-500 mt-1.5">
                    XXXX — код друга &nbsp;•&nbsp; XXXX-XXXX — приглашение на сервер
                  </p>
                </div>

                {/* Discovered Servers Section */}
                <Show when={discoveredServers().length > 0}>
                  <div class="mt-3 pt-3 border-t border-gray-700/50">
                    <div class="flex items-center gap-2 mb-2">
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
                              {/* Server Icon */}
                              <div class="w-10 h-10 rounded-lg bg-gradient-to-br from-green-600/30 to-emerald-600/30 flex items-center justify-center flex-shrink-0">
                                <i class="i-hugeicons-package w-5 h-5 text-green-400" />
                              </div>
                              {/* Server Info */}
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
                              {/* Join Button */}
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
                <div class="text-center py-6">
                  <div class="i-hugeicons-search-01 w-8 h-8 mx-auto text-gray-500 mb-3 animate-pulse" />
                  <p class="text-gray-400">{t().connect.searching}</p>
                  <p class="text-xs text-gray-500 mt-1">{t().connect.noPeersHint}</p>
                </div>
              }>
                <div class="space-y-2">
                  <div class="flex items-center justify-between text-xs text-gray-500 px-1">
                    <span>{t().connect.foundPeers.replace("{count}", String(peers().length))}</span>
                  </div>
                  <For each={peers()}>
                    {(peer) => (
                      <div class="p-3 bg-gray-800/50 rounded-xl hover:bg-gray-800 transition-colors">
                        <div class="flex items-center gap-3">
                          {/* Avatar */}
                          <div class="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white font-medium">
                            {(peer.nickname || peer.id.slice(0, 2)).charAt(0).toUpperCase()}
                          </div>

                          {/* Info */}
                          <div class="flex-1 min-w-0">
                            <div class="flex items-center gap-2">
                              <span class="font-medium text-sm truncate">
                                {peer.nickname || t().connect.anonymous}
                              </span>
                              <Show when={isFriend(peer.id)}>
                                <i class="i-hugeicons:user-check-01 w-3.5 h-3.5 text-green-400" title={t().connect.settings.trustedFriends} />
                              </Show>
                              <span class={`w-2 h-2 rounded-full ${
                                peer.status === "in_game" ? "bg-green-500" :
                                peer.status === "online" ? "bg-blue-500" : "bg-gray-500"
                              }`} />
                            </div>
                            <div class="text-xs text-gray-500 truncate">
                              {peer.status === "in_game" && peer.current_server
                                ? `${t().connect.inGame} • ${peer.current_server}`
                                : peer.status === "in_game" ? t().connect.inGame
                                : t().connect.online}
                            </div>
                          </div>

                          {/* Actions */}
                          <div class="flex items-center gap-1">
                            {/* Quick Join - показываем если друг на сервере и есть модпаки */}
                            <Show when={peer.status === "in_game" && peer.current_server && peer.modpacks?.length}>
                              <button
                                title={t().connect.quickJoinHint}
                                class={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5 ${
                                  joiningPeer() === peer.id
                                    ? "bg-green-600/50 text-green-300 cursor-wait"
                                    : "bg-green-600 hover:bg-green-500 text-white"
                                }`}
                                onClick={() => handleQuickJoin(peer)}
                                disabled={joiningPeer() !== null}
                              >
                                <Show when={joiningPeer() === peer.id} fallback={
                                  <>
                                    <i class="i-hugeicons-play w-3.5 h-3.5" />
                                    {t().connect.quickJoin}
                                  </>
                                }>
                                  <i class="i-svg-spinners-ring-resize w-3.5 h-3.5" />
                                  {joinStatus() || t().connect.joining}
                                </Show>
                              </button>
                            </Show>
                            <Show when={peer.modpacks && peer.modpacks.length > 0 && !(peer.status === "in_game" && peer.current_server)}>
                              <button
                                title={t().connect.requestModpack}
                                class="p-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-400 hover:text-white transition-colors"
                                onClick={() => handleRequestModpack(peer)}
                              >
                                <i class="i-hugeicons-download-02 w-4 h-4" />
                              </button>
                            </Show>
                            {/* More actions menu */}
                            <div class="relative" data-peer-menu>
                              <button
                                title={t().instances.moreActions}
                                class="p-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-400 hover:text-white transition-colors"
                                onClick={() => togglePeerMenu(peer.id)}
                              >
                                <i class="i-hugeicons-more-vertical w-4 h-4" />
                              </button>
                              <Show when={openPeerMenu() === peer.id}>
                                <div class="absolute right-0 top-full mt-1 z-10 bg-gray-800 rounded-lg shadow-lg border border-gray-700 py-1 min-w-32">
                                  {/* Quick Join в меню если на сервере */}
                                  <Show when={peer.status === "in_game" && peer.current_server && peer.modpacks?.length}>
                                    <button
                                      class="w-full px-3 py-2 text-left text-sm text-green-400 hover:bg-gray-700 hover:text-green-300 flex items-center gap-2"
                                      onClick={() => handleQuickJoin(peer)}
                                      disabled={joiningPeer() !== null}
                                    >
                                      <i class="i-hugeicons-play w-4 h-4" />
                                      {t().connect.quickJoin}
                                    </button>
                                  </Show>
                                  <button
                                    class="w-full px-3 py-2 text-left text-sm text-gray-300 hover:bg-gray-700 hover:text-white flex items-center gap-2"
                                    onClick={() => handleRequestModpack(peer)}
                                  >
                                    <i class="i-hugeicons-download-02 w-4 h-4" />
                                    {t().connect.requestModpack}
                                  </button>
                                  <Show when={!isFriend(peer.id)}>
                                    <button
                                      class="w-full px-3 py-2 text-left text-sm text-green-400 hover:bg-gray-700 hover:text-green-300 flex items-center gap-2"
                                      onClick={() => handleSendFriendRequest(peer)}
                                    >
                                      <i class="i-hugeicons:user-add-01 w-4 h-4" />
                                      {t().connect.addFriend}
                                    </button>
                                  </Show>
                                  <button
                                    class="w-full px-3 py-2 text-left text-sm text-red-400 hover:bg-gray-700 hover:text-red-300 flex items-center gap-2"
                                    onClick={() => handleBlockPeer(peer.id)}
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
                        <Show when={peer.modpacks && peer.modpacks.length > 0}>
                          <div class="mt-2 pt-2 border-t border-gray-700">
                            <div class="flex flex-wrap gap-1">
                              <For each={peer.modpacks!.slice(0, 3)}>
                                {(mp) => (
                                  <span class="text-xs px-2 py-0.5 rounded bg-gray-700 text-gray-400">
                                    {mp.name}
                                  </span>
                                )}
                              </For>
                              <Show when={peer.modpacks!.length > 3}>
                                <span class="text-xs px-2 py-0.5 text-gray-500">
                                  +{peer.modpacks!.length - 3}
                                </span>
                              </Show>
                            </div>
                          </div>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              </Show>

              {/* Transfers section */}
              <Show when={transfers().length > 0}>
                <div class="mt-4 pt-4 border-t border-gray-700">
                  <button
                    class="w-full flex items-center justify-between p-2 rounded-lg hover:bg-gray-800 transition-colors"
                    onClick={() => setShowTransfers(!showTransfers())}
                  >
                    <div class="flex items-center gap-2">
                      <i class={`w-4 h-4 ${activeTransfersCount() > 0 ? "i-hugeicons-loading-01 text-blue-400 animate-pulse" : "i-hugeicons-checkmark-circle-02 text-green-400"}`} />
                      <span class="text-sm font-medium">{t().connect.transfer.title}</span>
                      <Show when={activeTransfersCount() > 0}>
                        <span class="px-1.5 py-0.5 rounded-full bg-blue-600 text-xs text-white">
                          {activeTransfersCount()}
                        </span>
                      </Show>
                    </div>
                    <i class={`w-4 h-4 text-gray-400 transition-transform ${showTransfers() ? "i-hugeicons-arrow-up-01" : "i-hugeicons-arrow-down-01"}`} />
                  </button>

                  <Show when={showTransfers()}>
                    <div class="mt-2 space-y-2">
                      <For each={transfers()}>
                        {(transfer) => {
                          const progress = transfer.bytes_total > 0
                            ? Math.round((transfer.bytes_done / transfer.bytes_total) * 100)
                            : 0;
                          const isActive = transfer.status === "connecting" || transfer.status === "negotiating" || transfer.status === "transferring";

                          return (
                            <div class={`p-3 rounded-lg ${
                              transfer.status === "completed" ? "bg-green-900/20 border border-green-800/50" :
                              transfer.status === "failed" ? "bg-red-900/20 border border-red-800/50" :
                              transfer.status === "cancelled" ? "bg-gray-800/50 border border-gray-700" :
                              "bg-gray-800"
                            }`}>
                              {/* Header */}
                              <div class="flex items-center justify-between mb-2">
                                <div class="flex items-center gap-2 min-w-0">
                                  <i class={`w-4 h-4 flex-shrink-0 ${
                                    transfer.direction === "upload" ? "i-hugeicons-upload-02 text-orange-400" : "i-hugeicons-download-02 text-blue-400"
                                  }`} />
                                  <span class="text-sm font-medium truncate">
                                    {transfer.peer_nickname || transfer.peer_id.slice(0, 8)}
                                  </span>
                                </div>
                                <div class="flex items-center gap-1">
                                  <Show when={isActive}>
                                    <button
                                      class="p-1 rounded hover:bg-gray-700 text-gray-400 hover:text-red-400 transition-colors"
                                      onClick={() => handleCancelTransfer(transfer.id)}
                                      title={t().connect.transfer.cancel}
                                    >
                                      <i class="i-hugeicons-cancel-01 w-4 h-4" />
                                    </button>
                                  </Show>
                                  <Show when={!isActive}>
                                    <span class={`text-xs px-2 py-0.5 rounded-full ${
                                      transfer.status === "completed" ? "bg-green-600/30 text-green-400" :
                                      transfer.status === "failed" ? "bg-red-600/30 text-red-400" :
                                      "bg-gray-600/30 text-gray-400"
                                    }`}>
                                      {transfer.status === "completed" ? t().connect.transfer.completed :
                                       transfer.status === "failed" ? t().connect.transfer.failed :
                                       t().connect.transfer.cancelled}
                                    </span>
                                  </Show>
                                </div>
                              </div>

                              {/* Progress bar */}
                              <Show when={isActive}>
                                <div class="mb-2">
                                  <div class="w-full h-1.5 bg-gray-700 rounded-full overflow-hidden">
                                    <div
                                      class={`h-full transition-all duration-100 ${
                                        transfer.direction === "upload" ? "bg-orange-500" : "bg-blue-500"
                                      }`}
                                      style={{ width: `${progress}%` }}
                                    />
                                  </div>
                                </div>
                              </Show>

                              {/* Stats */}
                              <div class="flex items-center justify-between text-xs text-gray-500">
                                <span>
                                  {transfer.current_file
                                    ? transfer.current_file.split('/').pop()
                                    : transfer.status === "connecting" ? t().connect.transfer.connecting :
                                      transfer.status === "negotiating" ? t().connect.transfer.negotiating :
                                      `${transfer.files_done}/${transfer.files_total} ${t().connect.transfer.filesCount}`
                                  }
                                </span>
                                <Show when={transfer.bytes_total > 0}>
                                  <span>{formatBytes(transfer.bytes_done)} / {formatBytes(transfer.bytes_total)}</span>
                                </Show>
                              </div>
                            </div>
                          );
                        }}
                      </For>

                      {/* Clear completed button */}
                      <Show when={transfers().some(t => t.status === "completed" || t.status === "failed" || t.status === "cancelled")}>
                        <button
                          class="w-full py-2 text-xs text-gray-500 hover:text-gray-300 transition-colors"
                          onClick={clearCompletedTransfers}
                        >
                          {t().connect.transfer.clearCompleted}
                        </button>
                      </Show>
                    </div>
                  </Show>
                </div>
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
                          <div class={`p-3 rounded-lg ${
                            item.status === "pending" ? "bg-gray-800" :
                            item.status === "active" ? "bg-blue-900/20 border border-blue-800/50" :
                            item.status === "failed" ? "bg-red-900/20 border border-red-800/50" :
                            "bg-gray-800/50"
                          }`}>
                            <div class="flex items-center justify-between mb-1">
                              <div class="flex items-center gap-2 min-w-0">
                                <span class={`text-xs px-1.5 py-0.5 rounded ${
                                  item.priority === "urgent" ? "bg-red-600 text-white" :
                                  item.priority === "high" ? "bg-orange-600 text-white" :
                                  item.priority === "low" ? "bg-gray-600 text-gray-300" :
                                  "bg-blue-600 text-white"
                                }`}>
                                  {item.priority}
                                </span>
                                <span class="text-sm truncate">{item.modpack_name}</span>
                              </div>
                              <div class="flex items-center gap-1">
                                <Show when={item.status === "pending"}>
                                  <button
                                    class="p-1 rounded hover:bg-gray-700 text-gray-400 hover:text-red-400 transition-colors"
                                    onClick={() => handleCancelQueuedTransfer(item.id)}
                                    title={t().connect.transfer.cancel}
                                  >
                                    <i class="i-hugeicons-cancel-01 w-4 h-4" />
                                  </button>
                                </Show>
                                <Show when={item.status === "failed"}>
                                  <button
                                    class="p-1 rounded hover:bg-gray-700 text-gray-400 hover:text-blue-400 transition-colors"
                                    onClick={() => handleRetryQueuedTransfer(item.id)}
                                    title={t().connect.queue?.retry || "Retry"}
                                  >
                                    <i class="i-hugeicons-refresh w-4 h-4" />
                                  </button>
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
              <div class="mt-4 pt-4 border-t border-gray-700">
                <button
                  class="w-full flex items-center justify-between p-2 rounded-lg hover:bg-gray-800 transition-colors"
                  onClick={() => showHistory() ? setShowHistory(false) : handleLoadHistory()}
                >
                  <div class="flex items-center gap-2">
                    <i class="i-hugeicons-clock-01 w-4 h-4 text-gray-400" />
                    <span class="text-sm font-medium">{t().connect.history?.title || "History"}</span>
                    <Show when={historyStats()}>
                      <span class="text-xs text-gray-500">
                        {historyStats()!.total_transfers} {t().connect.history?.transfers || "transfers"}
                      </span>
                    </Show>
                  </div>
                  <i class={`w-4 h-4 text-gray-400 transition-transform ${showHistory() ? "i-hugeicons-arrow-up-01" : "i-hugeicons-arrow-down-01"}`} />
                </button>

                <Show when={showHistory()}>
                  <div class="mt-2 space-y-2">
                    {/* Stats summary */}
                    <Show when={historyStats()}>
                      <div class="p-3 bg-gray-800/50 rounded-lg grid grid-cols-3 gap-2 text-center text-xs">
                        <div>
                          <div class="text-green-400 font-medium">{historyStats()!.successful}</div>
                          <div class="text-gray-500">{t().connect.history?.successful || "Success"}</div>
                        </div>
                        <div>
                          <div class="text-red-400 font-medium">{historyStats()!.failed}</div>
                          <div class="text-gray-500">{t().connect.history?.failed || "Failed"}</div>
                        </div>
                        <div>
                          <div class="text-gray-400 font-medium">{formatBytes((historyStats()?.total_bytes_uploaded ?? 0) + (historyStats()?.total_bytes_downloaded ?? 0))}</div>
                          <div class="text-gray-500">{t().connect.history?.total || "Total"}</div>
                        </div>
                      </div>
                    </Show>

                    {/* History entries */}
                    <Show when={history().length > 0} fallback={
                      <div class="text-center py-4 text-gray-500 text-sm">
                        {t().connect.history?.empty || "No transfer history"}
                      </div>
                    }>
                      <For each={history().slice(0, 10)}>
                        {(entry) => (
                          <div class={`p-2 rounded-lg ${
                            entry.result === "success" ? "bg-green-900/10" :
                            entry.result === "failed" ? "bg-red-900/10" :
                            "bg-gray-800/50"
                          }`}>
                            <div class="flex items-center justify-between mb-1">
                              <div class="flex items-center gap-2 min-w-0">
                                <i class={`w-3 h-3 flex-shrink-0 ${
                                  entry.direction === "upload" ? "i-hugeicons-upload-02 text-orange-400" : "i-hugeicons-download-02 text-blue-400"
                                }`} />
                                <span class="text-xs truncate">{entry.modpack_name}</span>
                              </div>
                              <i class={`w-3 h-3 flex-shrink-0 ${
                                entry.result === "success" ? "i-hugeicons-checkmark-circle-02 text-green-400" :
                                entry.result === "failed" ? "i-hugeicons-cancel-01 text-red-400" :
                                "i-hugeicons-alert-02 text-yellow-400"
                              }`} />
                            </div>
                            <div class="flex items-center justify-between text-xs text-gray-500">
                              <span>{entry.peer_nickname || entry.peer_id.slice(0, 8)}</span>
                              <span>{formatTimeAgo(entry.completed_at)}</span>
                            </div>
                          </div>
                        )}
                      </For>
                    </Show>

                    {/* Clear history button */}
                    <Show when={history().length > 0}>
                      <button
                        class="w-full py-2 text-xs text-gray-500 hover:text-red-400 transition-colors"
                        onClick={handleClearHistory}
                      >
                        {t().connect.history?.clear || "Clear history"}
                      </button>
                    </Show>
                  </div>
                </Show>
              </div>

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
                          <div class={`p-3 rounded-lg ${notification.read ? "bg-gray-800/50" : "bg-amber-900/20 border border-amber-800/50"}`}>
                            <div class="flex items-center justify-between mb-1">
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
                            <div class="text-xs text-gray-400 mb-2">
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

                      {/* Mark all as read */}
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
                    <button
                      title={t().connect.settings.visibilityInvisible}
                      class={`p-1.5 rounded-lg transition-colors ${
                        settings()?.visibility === "invisible"
                          ? "bg-blue-600 text-white"
                          : "bg-gray-700 text-gray-400 hover:bg-gray-600"
                      }`}
                      onClick={() => handleVisibilityChange("invisible")}
                    >
                      <i class="i-hugeicons-view-off w-4 h-4" />
                    </button>
                    <button
                      title={t().connect.settings.visibilityFriends}
                      class={`p-1.5 rounded-lg transition-colors ${
                        settings()?.visibility === "friends_only"
                          ? "bg-blue-600 text-white"
                          : "bg-gray-700 text-gray-400 hover:bg-gray-600"
                      }`}
                      onClick={() => handleVisibilityChange("friends_only")}
                    >
                      <i class="i-hugeicons:user-multiple w-4 h-4" />
                    </button>
                    <button
                      title={t().connect.settings.visibilityAll}
                      class={`p-1.5 rounded-lg transition-colors ${
                        settings()?.visibility === "local_network"
                          ? "bg-blue-600 text-white"
                          : "bg-gray-700 text-gray-400 hover:bg-gray-600"
                      }`}
                      onClick={() => handleVisibilityChange("local_network")}
                    >
                      <i class="i-hugeicons-wifi-01 w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>

              {/* Network Diagnostics */}
              <div class="mt-4 pt-4 border-t border-gray-700">
                <button
                  class="w-full flex items-center justify-between p-2 rounded-lg hover:bg-gray-800 transition-colors"
                  onClick={() => showDiagnostics() ? setShowDiagnostics(false) : handleDiagnoseNetwork()}
                >
                  <div class="flex items-center gap-2">
                    <i class={`w-4 h-4 ${
                      networkDiagnostics()?.firewall_likely_blocking
                        ? "i-hugeicons-alert-02 text-amber-400"
                        : networkDiagnostics()
                          ? "i-hugeicons-checkmark-circle-02 text-green-400"
                          : "i-hugeicons-wifi-01 text-gray-400"
                    }`} />
                    <span class="text-sm font-medium">{t().connect.network.title}</span>
                  </div>
                  <div class="flex items-center gap-2">
                    <Show when={diagnosing()}>
                      <i class="i-svg-spinners-ring-resize w-4 h-4 text-blue-400" />
                    </Show>
                    <i class={`w-4 h-4 text-gray-400 transition-transform ${showDiagnostics() ? "i-hugeicons-arrow-up-01" : "i-hugeicons-arrow-down-01"}`} />
                  </div>
                </button>

                <Show when={showDiagnostics()}>
                  <div class="mt-2 space-y-3">
                    {/* Diagnostics results */}
                    <Show when={networkDiagnostics()} fallback={
                      <div class="flex items-center justify-center py-4">
                        <i class="i-svg-spinners-ring-resize w-5 h-5 text-blue-400" />
                      </div>
                    }>
                      {/* All Network Interfaces */}
                      <div class="p-3 bg-gray-800 rounded-lg">
                        <div class="text-xs text-gray-500 mb-2 flex items-center gap-1">
                          <i class="i-hugeicons-wifi-01 w-3 h-3" />
                          {t().connect.network.allInterfaces || "Сетевые интерфейсы"}
                        </div>
                        <div class="space-y-1.5">
                          <For each={networkDiagnostics()?.all_interfaces || []} fallback={
                            <div class="text-sm text-gray-500 font-mono">
                              {networkDiagnostics()?.local_ip || "—"}
                            </div>
                          }>
                            {(iface) => (
                              <div class="flex items-center justify-between gap-2 text-sm">
                                <div class="flex items-center gap-2 min-w-0">
                                  <Show when={iface.is_vpn}>
                                    <span class="px-1.5 py-0.5 text-[10px] bg-purple-500/20 text-purple-300 rounded font-medium">
                                      VPN
                                    </span>
                                  </Show>
                                  <span class="text-gray-400 truncate">{iface.name}</span>
                                </div>
                                <span class="font-mono text-gray-300 flex-shrink-0">{iface.ip}</span>
                              </div>
                            )}
                          </For>
                          <Show when={(networkDiagnostics()?.all_interfaces?.length || 0) === 0 && networkDiagnostics()?.local_ip}>
                            <div class="text-sm text-gray-400 font-mono">
                              {networkDiagnostics()?.local_ip}
                            </div>
                          </Show>
                        </div>
                      </div>

                      {/* Status indicators */}
                      <div class="grid grid-cols-3 gap-2">
                        {/* Status */}
                        <div class="p-2 bg-gray-800 rounded-lg">
                          <div class="text-xs text-gray-500 mb-1">{t().connect.network.status}</div>
                          <div class={`text-sm font-medium ${
                            networkDiagnostics()?.firewall_likely_blocking ? "text-amber-400" : "text-green-400"
                          }`}>
                            {networkDiagnostics()?.firewall_likely_blocking
                              ? t().connect.network.issues
                              : t().connect.network.ok}
                          </div>
                        </div>

                        {/* UDP Port - detailed */}
                        <div class="p-2 bg-gray-800 rounded-lg">
                          <div class="flex items-center justify-between">
                            <span class="text-xs text-gray-500">UDP</span>
                            <span class="text-xs font-mono text-gray-400">
                              :{networkDiagnostics()?.udp_status?.port || networkDiagnostics()?.udp_port}
                            </span>
                          </div>
                          <div class={`text-sm font-medium flex items-center gap-1 mt-1 ${
                            networkDiagnostics()?.udp_port_open ? "text-green-400" : "text-red-400"
                          }`}>
                            <i class={`w-3 h-3 ${networkDiagnostics()?.udp_port_open ? "i-hugeicons-checkmark-circle-02" : "i-hugeicons-cancel-01"}`} />
                            <span class="truncate" title={networkDiagnostics()?.udp_status?.status}>
                              {networkDiagnostics()?.udp_status?.status || (networkDiagnostics()?.udp_port_open ? "OK" : "Закрыт")}
                            </span>
                          </div>
                        </div>

                        {/* TCP Port - detailed */}
                        <div class="p-2 bg-gray-800 rounded-lg">
                          <div class="flex items-center justify-between">
                            <span class="text-xs text-gray-500">TCP</span>
                            <span class="text-xs font-mono text-gray-400">
                              :{networkDiagnostics()?.tcp_status?.port || networkDiagnostics()?.tcp_port}
                            </span>
                          </div>
                          <div class={`text-sm font-medium flex items-center gap-1 mt-1 ${
                            networkDiagnostics()?.tcp_port_open ? "text-green-400" : "text-red-400"
                          }`}>
                            <i class={`w-3 h-3 ${networkDiagnostics()?.tcp_port_open ? "i-hugeicons-checkmark-circle-02" : "i-hugeicons-cancel-01"}`} />
                            <span class="truncate" title={networkDiagnostics()?.tcp_status?.status}>
                              {networkDiagnostics()?.tcp_status?.status || (networkDiagnostics()?.tcp_port_open ? "OK" : "Закрыт")}
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* Firewall/network warning */}
                      <Show when={networkDiagnostics()?.firewall_likely_blocking}>
                        <div class="p-3 bg-amber-900/20 border border-amber-700/40 rounded-lg">
                          <div class="flex items-start gap-2">
                            <i class="i-hugeicons-alert-02 w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
                            <div class="space-y-2 flex-1">
                              <div class="text-sm text-amber-300">
                                Порты закрыты — возможны проблемы с подключением
                              </div>
                              <div class="text-xs text-amber-400/70">
                                Убедитесь что оба устройства в одной сети. Для игры через интернет используйте VPN (Radmin VPN, ZeroTier, Tailscale).
                              </div>
                              <button
                                class="text-xs px-2 py-1 rounded bg-amber-600/30 hover:bg-amber-600/50 text-amber-300 transition-colors"
                                onClick={() => invoke("open_firewall_settings").catch(() => {})}
                              >
                                <i class="i-hugeicons-settings-02 w-3 h-3 mr-1" />
                                Настройки Firewall
                              </button>
                            </div>
                          </div>
                        </div>
                      </Show>

                      {/* Re-check button */}
                      <button
                        class="w-full py-2 text-xs text-gray-500 hover:text-gray-300 transition-colors flex items-center justify-center gap-1"
                        onClick={handleDiagnoseNetwork}
                        disabled={diagnosing()}
                      >
                        <i class={`w-3 h-3 ${diagnosing() ? "i-svg-spinners-ring-resize" : "i-hugeicons-refresh"}`} />
                        {diagnosing() ? t().connect.network.diagnosing : t().connect.network.diagnose}
                      </button>
                    </Show>
                  </div>
                </Show>
              </div>

              {/* VPN hint for enabled state too */}
              <div class="mt-4 pt-4 border-t border-gray-700">
                <p class="text-xs text-gray-500 mb-2">{t().connect.vpnHint}</p>
                <div class="flex flex-wrap gap-2">
                  <For each={VPN_APPS}>
                    {(vpn) => {
                      const info = getVpnInfo(vpn.key);
                      return (
                        <a
                          href={vpn.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          class="text-xs px-2 py-1 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
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
            setFriendCode(""); // Clear input after closing
          }}
          onSuccess={(instanceId) => {
            setShowJoinDialog(false);
            setFriendCode(""); // Clear input after success
            // Optionally navigate to the instance or show success message
            console.log("Joined server, created instance:", instanceId);
          }}
          initialCode={friendCode().includes("-") ? `STUZHIK-${friendCode()}` : undefined}
        />
      </Show>
    </div>
  );
}

export default ConnectPanel;
