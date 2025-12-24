import { createSignal, For, Show, JSX, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { ModalWrapper } from "../ui";
import { addToast } from "./Toast";

interface TestResult {
  success: boolean;
  message: string;
  data?: unknown;
  duration?: number;
}

interface SectionProps {
  title: string;
  icon: string;
  children: JSX.Element;
  defaultCollapsed?: boolean;
}

function Section(props: SectionProps) {
  const [collapsed, setCollapsed] = createSignal(props.defaultCollapsed ?? false);

  return (
    <div class="border border-gray-700 rounded-xl overflow-hidden">
      <button
        class="w-full flex items-center justify-between p-3 bg-gray-800/50 hover:bg-gray-800 transition-colors"
        onClick={() => setCollapsed(!collapsed())}
      >
        <div class="flex items-center gap-2">
          <i class={`${props.icon} w-5 h-5 text-blue-400`} />
          <span class="font-semibold">{props.title}</span>
        </div>
        <i class={`w-4 h-4 transition-transform ${collapsed() ? "i-hugeicons-arrow-right-01" : "i-hugeicons-arrow-down-01"}`} />
      </button>
      <Show when={!collapsed()}>
        <div class="p-3 flex flex-wrap gap-2 bg-gray-900/30">
          {props.children}
        </div>
      </Show>
    </div>
  );
}

function TestButton(props: {
  label: string;
  onClick: () => Promise<TestResult>;
  variant?: "primary" | "danger" | "warning";
}) {
  const [loading, setLoading] = createSignal(false);
  const [result, setResult] = createSignal<TestResult | null>(null);

  const handleClick = async () => {
    setLoading(true);
    setResult(null);
    const start = performance.now();
    try {
      const res = await props.onClick();
      res.duration = Math.round(performance.now() - start);
      setResult(res);
      if (res.success) {
        addToast({ type: "success", title: props.label, message: res.message, duration: 3000 });
      } else {
        addToast({ type: "error", title: props.label, message: res.message, duration: 5000 });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setResult({ success: false, message: msg, duration: Math.round(performance.now() - start) });
      addToast({ type: "error", title: props.label, message: msg, duration: 5000 });
    } finally {
      setLoading(false);
    }
  };

  const btnClass = () => {
    switch (props.variant) {
      case "danger": return "btn-danger";
      case "warning": return "btn-warning";
      default: return "btn-secondary";
    }
  };

  // Format message for display (no truncation - show full error)
  const formatMessage = (msg: string) => msg;

  return (
    <div class="flex flex-col gap-1">
      <button
        class={`${btnClass()} text-sm min-w-32`}
        onClick={handleClick}
        disabled={loading()}
      >
        <Show when={loading()} fallback={props.label}>
          <i class="i-svg-spinners-ring-resize w-4 h-4" />
        </Show>
      </button>
      <Show when={result()}>
        <div
          class={`text-xs px-2 py-1.5 rounded max-w-64 ${result()!.success ? "bg-green-900/30 text-green-400" : "bg-red-900/30 text-red-400"}`}
          style={{ "word-break": "break-word", "white-space": "pre-wrap" }}
        >
          <span class="opacity-60">{result()!.duration}ms</span>
          <span class="mx-1">-</span>
          <span>{formatMessage(result()!.message)}</span>
        </div>
      </Show>
    </div>
  );
}

export function DevTests(props: { onClose: () => void }) {
  const [logs, setLogs] = createSignal<string[]>([]);
  const [myPeerId, setMyPeerId] = createSignal<string>("");
  const [myShortCode, setMyShortCode] = createSignal<string>("");
  const [instances, setInstances] = createSignal<{ id: string; name: string; instance_type: string }[]>([]);

  const log = (msg: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs(prev => [`[${timestamp}] ${msg}`, ...prev.slice(0, 99)]);
  };

  onMount(async () => {
    log("DevTests loaded");

    // Get peer info
    try {
      const peerId = await invoke<string | null>("get_my_peer_id");
      if (peerId) {
        setMyPeerId(peerId);
        log(`My peer ID: ${peerId.slice(0, 16)}...`);
      } else {
        log("P2P not enabled - no peer ID");
      }
    } catch (e) {
      log(`Failed to get peer ID: ${e}`);
    }

    try {
      const code = await invoke<string | null>("get_short_code");
      if (code) {
        setMyShortCode(code);
        log(`My short code: ${code}`);
      } else {
        log("P2P not enabled - no short code");
      }
    } catch (e) {
      log(`Failed to get short code: ${e}`);
    }

    // Load instances for tests that need them
    try {
      const list = await invoke<{ id: string; name: string; instance_type: string }[]>("list_instances");
      setInstances(list);
      log(`Loaded ${list.length} instances`);
    } catch (e) {
      log(`Failed to load instances: ${e}`);
    }
  });

  // Helper to get first instance ID
  const getFirstInstanceId = () => instances()[0]?.id;
  const getFirstServerId = () => instances().find(i => i.instance_type === "server")?.id;

  // ==================== P2P Discovery Tests ====================

  const testStartDiscovery = async (): Promise<TestResult> => {
    await invoke("start_p2p_discovery");
    log("P2P discovery started");
    return { success: true, message: "Discovery started" };
  };

  const testStopDiscovery = async (): Promise<TestResult> => {
    await invoke("stop_p2p_discovery");
    log("P2P discovery stopped");
    return { success: true, message: "Discovery stopped" };
  };

  const testGetPeers = async (): Promise<TestResult> => {
    const peers = await invoke<unknown[]>("get_discovered_peers");
    log(`Found ${peers.length} peers`);
    return { success: true, message: `Found ${peers.length} peers`, data: peers };
  };

  const testGetMyPeerId = async (): Promise<TestResult> => {
    const peerId = await invoke<string | null>("get_my_peer_id");
    if (!peerId) {
      return { success: false, message: "P2P not enabled" };
    }
    log(`Peer ID: ${peerId}`);
    return { success: true, message: `ID: ${peerId.slice(0, 24)}...` };
  };

  const testGetShortCode = async (): Promise<TestResult> => {
    const code = await invoke<string | null>("get_short_code");
    if (!code) {
      return { success: false, message: "P2P not enabled" };
    }
    log(`Short code: ${code}`);
    return { success: true, message: `Code: ${code}` };
  };

  // ==================== P2P Network Tests ====================

  const testNetworkDiagnostics = async (): Promise<TestResult> => {
    const result = await invoke<{
      local_ip: string;
      is_private_network: boolean;
      udp_port_open: boolean;
      tcp_port_open: boolean;
    }>("diagnose_p2p_network", { discoveryPort: 19847, connectEnabled: true });
    log(`Network: ${result.local_ip}, UDP: ${result.udp_port_open}, TCP: ${result.tcp_port_open}`);
    return {
      success: true,
      message: `IP: ${result.local_ip}\nUDP: ${result.udp_port_open ? "✓" : "✗"}\nTCP: ${result.tcp_port_open ? "✓" : "✗"}`,
      data: result
    };
  };

  const testCheckFirewall = async (): Promise<TestResult> => {
    const configured = await invoke<boolean>("check_firewall_configured", { appName: "Stuzhik" });
    log(`Firewall configured: ${configured}`);
    return { success: true, message: configured ? "Firewall configured ✓" : "Firewall not configured" };
  };

  const testGetFirewallExplanation = async (): Promise<TestResult> => {
    const explanation = await invoke<string>("get_firewall_explanation", { udpPort: 19847, tcpPort: 19848 });
    log("Got firewall explanation");
    return { success: true, message: explanation.slice(0, 150) };
  };

  // ==================== P2P Consent Tests ====================

  const testGetPendingConsents = async (): Promise<TestResult> => {
    const consents = await invoke<unknown[]>("get_pending_consents");
    log(`Pending consents: ${consents.length}`);
    return { success: true, message: `${consents.length} pending consents`, data: consents };
  };

  // ==================== P2P Friends Tests ====================

  const testGetFriends = async (): Promise<TestResult> => {
    const friends = await invoke<unknown[]>("get_friends");
    log(`Friends: ${friends.length}`);
    return { success: true, message: `${friends.length} friends`, data: friends };
  };

  // ==================== P2P Transfer Tests ====================

  const testGetTransferSessions = async (): Promise<TestResult> => {
    const sessions = await invoke<unknown[]>("get_transfer_sessions");
    log(`Active sessions: ${sessions.length}`);
    return { success: true, message: `${sessions.length} active sessions`, data: sessions };
  };

  const testGetTransferHistory = async (): Promise<TestResult> => {
    const history = await invoke<unknown[]>("get_transfer_history");
    log(`History entries: ${history.length}`);
    return { success: true, message: `${history.length} entries`, data: history };
  };

  const testGetRecentHistory = async (): Promise<TestResult> => {
    const history = await invoke<unknown[]>("get_recent_transfer_history", { limit: 10 });
    log(`Recent history: ${history.length}`);
    return { success: true, message: `${history.length} recent entries`, data: history };
  };

  const testGetHistoryStats = async (): Promise<TestResult> => {
    const stats = await invoke<{
      total_transfers: number;
      total_bytes_sent: number;
      total_bytes_received: number;
    }>("get_transfer_history_stats");
    log(`Stats: ${stats.total_transfers} transfers`);
    const sent = (stats.total_bytes_sent / 1024 / 1024).toFixed(1);
    const recv = (stats.total_bytes_received / 1024 / 1024).toFixed(1);
    return {
      success: true,
      message: `Transfers: ${stats.total_transfers}\nSent: ${sent}MB\nRecv: ${recv}MB`,
      data: stats
    };
  };

  // ==================== P2P Transfer Queue Tests ====================

  const testGetTransferQueue = async (): Promise<TestResult> => {
    const queue = await invoke<unknown[]>("get_transfer_queue");
    log(`Queue items: ${queue.length}`);
    return { success: true, message: `${queue.length} queued`, data: queue };
  };

  // ==================== P2P Peer Groups Tests ====================

  const testLoadPeerGroups = async (): Promise<TestResult> => {
    await invoke("load_peer_groups");
    log("Peer groups loaded");
    return { success: true, message: "Groups loaded" };
  };

  const testGetAllPeerGroups = async (): Promise<TestResult> => {
    const groups = await invoke<unknown[]>("get_all_peer_groups");
    log(`Peer groups: ${groups.length}`);
    return { success: true, message: `${groups.length} groups`, data: groups };
  };

  // ==================== P2P Watch Mode Tests ====================

  const testGetAllWatchConfigs = async (): Promise<TestResult> => {
    const configs = await invoke<unknown[]>("get_all_watch_configs");
    log(`Watch configs: ${configs.length}`);
    return { success: true, message: `${configs.length} watch configs`, data: configs };
  };

  const testGetActiveWatches = async (): Promise<TestResult> => {
    const watches = await invoke<string[]>("get_active_watches");
    log(`Active watches: ${watches.length}`);
    return { success: true, message: `${watches.length} active watches`, data: watches };
  };

  // ==================== P2P Update Notifications Tests ====================

  const testGetUpdateNotifications = async (): Promise<TestResult> => {
    const notifications = await invoke<unknown[]>("get_update_notifications");
    log(`Update notifications: ${notifications.length}`);
    return { success: true, message: `${notifications.length} notifications`, data: notifications };
  };

  const testGetUnreadCount = async (): Promise<TestResult> => {
    const count = await invoke<number>("get_unread_notification_count");
    log(`Unread notifications: ${count}`);
    return { success: true, message: `${count} unread` };
  };

  // ==================== P2P Server Sync Tests ====================

  const testGetAllServerSyncConfigs = async (): Promise<TestResult> => {
    const configs = await invoke<unknown[]>("get_all_server_sync_configs");
    log(`Server sync configs: ${configs.length}`);
    return { success: true, message: `${configs.length} configs`, data: configs };
  };

  const testGetLocalPublishedServers = async (): Promise<TestResult> => {
    const servers = await invoke<unknown[]>("get_local_published_servers");
    log(`Published servers: ${servers.length}`);
    return { success: true, message: `${servers.length} published`, data: servers };
  };

  const testGetDiscoveredServers = async (): Promise<TestResult> => {
    const servers = await invoke<unknown[]>("get_discovered_servers");
    log(`Discovered servers: ${servers.length}`);
    return { success: true, message: `${servers.length} discovered`, data: servers };
  };

  // ==================== P2P Server Invites Tests ====================

  const testGetAllActiveInvites = async (): Promise<TestResult> => {
    const invites = await invoke<unknown[]>("get_all_active_invites");
    log(`Active invites: ${invites.length}`);
    return { success: true, message: `${invites.length} active invites`, data: invites };
  };

  // ==================== P2P Settings Tests ====================

  const testGetConnectSettings = async (): Promise<TestResult> => {
    const settings = await invoke<{
      enabled: boolean;
      visibility: string;
      nickname: string;
    }>("get_connect_settings");
    log(`Connect settings: enabled=${settings.enabled}, visibility=${settings.visibility}`);
    return {
      success: true,
      message: `Enabled: ${settings.enabled}\nVisibility: ${settings.visibility}\nNick: ${settings.nickname || "none"}`,
      data: settings
    };
  };

  const testGetVpnRecommendations = async (): Promise<TestResult> => {
    const recommendations = await invoke<{ name: string; url: string }[]>("get_vpn_recommendations");
    log(`VPN recommendations: ${recommendations.length}`);
    return { success: true, message: recommendations.map(r => r.name).join(", "), data: recommendations };
  };

  // ==================== Instance Tests ====================

  const testListInstances = async (): Promise<TestResult> => {
    const list = await invoke<unknown[]>("list_instances");
    log(`Found ${list.length} instances`);
    return { success: true, message: `${list.length} instances`, data: list };
  };

  const testGetAppPaths = async (): Promise<TestResult> => {
    const paths = await invoke<{
      instances_dir?: string;
      cache_dir?: string;
      logs_dir?: string;
    }>("get_app_paths");
    log(`Paths loaded`);
    const instancesPath = paths.instances_dir || "unknown";
    const shortPath = instancesPath.split(/[/\\]/).slice(-2).join("/");
    return {
      success: true,
      message: `Instances: ${shortPath}`,
      data: paths
    };
  };

  const testGetStorageInfo = async (): Promise<TestResult> => {
    const info = await invoke<{
      total_size: number;
      instances_size: number;
      shared_size: number;
      libraries_size: number;
      assets_size: number;
      java_size: number;
      cache_size: number;
    }>("get_storage_info");
    const totalMb = (info.total_size / 1024 / 1024).toFixed(1);
    const instancesMb = (info.instances_size / 1024 / 1024).toFixed(1);
    const librariesMb = (info.libraries_size / 1024 / 1024).toFixed(1);
    log(`Storage: total ${totalMb}MB, instances ${instancesMb}MB`);
    return {
      success: true,
      message: `Total: ${totalMb}MB\nInstances: ${instancesMb}MB\nLibraries: ${librariesMb}MB`,
      data: info
    };
  };

  // ==================== API Tests ====================

  const testModrinthSearch = async (): Promise<TestResult> => {
    const results = await invoke<{ hits: unknown[] }>("search_mods", {
      query: "sodium",
      source: "modrinth",
      limit: 5,
      offset: 0,
    });
    log(`Modrinth search: ${results.hits.length} results`);
    return { success: true, message: `${results.hits.length} mods found`, data: results.hits };
  };

  const testCurseForgeSearch = async (): Promise<TestResult> => {
    const results = await invoke<{ hits: unknown[] }>("search_mods", {
      query: "jei",
      source: "curseforge",
      limit: 5,
      offset: 0,
    });
    log(`CurseForge search: ${results.hits.length} results`);
    return { success: true, message: `${results.hits.length} mods found`, data: results.hits };
  };

  const testFetchVersions = async (): Promise<TestResult> => {
    const versions = await invoke<unknown[]>("fetch_minecraft_versions");
    log(`MC versions: ${versions.length}`);
    return { success: true, message: `${versions.length} versions`, data: versions };
  };

  const testGetLoaderVersions = async (): Promise<TestResult> => {
    const versions = await invoke<unknown[]>("get_loader_versions", {
      minecraftVersion: "1.20.1",
      loader: "fabric"
    });
    log(`Fabric versions: ${versions.length}`);
    return { success: true, message: `${versions.length} Fabric versions`, data: versions };
  };

  const testSearchModpacks = async (): Promise<TestResult> => {
    const results = await invoke<{ hits?: unknown[] }>("search_modpacks", {
      query: "create",
      source: "modrinth",
      limit: 5,
      offset: 0,
    });
    const hits = results?.hits || [];
    log(`Modpack search: ${hits.length} results`);
    return { success: true, message: `${hits.length} modpacks`, data: hits };
  };

  // ==================== Java Tests ====================

  const testListJava = async (): Promise<TestResult> => {
    const javas = await invoke<unknown[]>("list_java_installations");
    log(`Found ${javas.length} Java installations`);
    return { success: true, message: `${javas.length} installations`, data: javas };
  };

  const testScanSystemJava = async (): Promise<TestResult> => {
    const javas = await invoke<unknown[]>("scan_system_java");
    log(`Scanned ${javas.length} system Java installations`);
    return { success: true, message: `${javas.length} system installations`, data: javas };
  };

  const testGetJavaForVersion = async (): Promise<TestResult> => {
    // MC 1.20.1 requires Java 17, so major_version = 17
    const javas = await invoke<unknown[]>("get_java_for_version", { majorVersion: 17 });
    log(`Java 17: ${javas.length} found`);
    return { success: true, message: `${javas.length} Java 17 installations`, data: javas };
  };

  // ==================== Settings Tests ====================

  const testGetSettings = async (): Promise<TestResult> => {
    const settings = await invoke<unknown>("get_settings");
    log("Settings loaded");
    return { success: true, message: "Settings loaded", data: settings };
  };

  // ==================== Server Tests ====================

  const testGetServerProperties = async (): Promise<TestResult> => {
    const serverId = getFirstServerId();
    if (!serverId) {
      return { success: false, message: "No server instance found" };
    }
    const props = await invoke<Record<string, unknown>>("get_server_properties", { instanceId: serverId });
    const count = Object.keys(props).length;
    log(`Server properties: ${count} entries`);
    return { success: true, message: `${count} properties`, data: props };
  };

  const testGetEulaStatus = async (): Promise<TestResult> => {
    const serverId = getFirstServerId();
    if (!serverId) {
      return { success: false, message: "No server instance found" };
    }
    const status = await invoke<{ accepted: boolean; exists: boolean }>("get_eula_status", { instanceId: serverId });
    log(`EULA: accepted=${status.accepted}, exists=${status.exists}`);
    return { success: true, message: `EULA: ${status.accepted ? "accepted ✓" : "not accepted"}` };
  };

  const testGetServerStatus = async (): Promise<TestResult> => {
    const serverId = getFirstServerId();
    if (!serverId) {
      return { success: false, message: "No server instance found" };
    }
    const status = await invoke<{ running: boolean; pid?: number }>("get_server_status", { instanceId: serverId });
    log(`Server status: running=${status.running}`);
    return { success: true, message: status.running ? `Running (PID: ${status.pid})` : "Stopped" };
  };

  const testIsRconConnected = async (): Promise<TestResult> => {
    const serverId = getFirstServerId();
    if (!serverId) {
      return { success: false, message: "No server instance found" };
    }
    const connected = await invoke<boolean>("is_rcon_connected", { instanceId: serverId });
    log(`RCON connected: ${connected}`);
    return { success: true, message: connected ? "RCON connected ✓" : "RCON not connected" };
  };

  const testGetPlayerManagement = async (): Promise<TestResult> => {
    const serverId = getFirstServerId();
    if (!serverId) {
      return { success: false, message: "No server instance found" };
    }
    const mgmt = await invoke<{
      whitelist: unknown[];
      ops: unknown[];
      banned_players: unknown[];
    }>("get_player_management", { instanceId: serverId });
    log(`Players: ${mgmt.whitelist.length} whitelist, ${mgmt.ops.length} ops`);
    return {
      success: true,
      message: `Whitelist: ${mgmt.whitelist.length}\nOps: ${mgmt.ops.length}\nBanned: ${mgmt.banned_players.length}`,
      data: mgmt
    };
  };

  const testScanClientMods = async (): Promise<TestResult> => {
    const serverId = getFirstServerId();
    if (!serverId) {
      return { success: false, message: "No server instance found" };
    }
    const result = await invoke<{ client_only: string[]; unknown: string[] }>("scan_client_mods", { instanceId: serverId });
    log(`Client mods: ${result.client_only.length} found, ${result.unknown.length} unknown`);
    return {
      success: true,
      message: `Client-only: ${result.client_only.length}\nUnknown: ${result.unknown.length}`,
      data: result
    };
  };

  const testGetServerLoaderVersions = async (): Promise<TestResult> => {
    const versions = await invoke<unknown[]>("get_server_loader_versions", {
      mcVersion: "1.20.1",
      loader: "fabric"
    });
    log(`Server loader versions: ${versions.length}`);
    return { success: true, message: `${versions.length} versions`, data: versions };
  };

  // ==================== Performance Tests ====================

  const testGetPerformanceSnapshot = async (): Promise<TestResult> => {
    const instanceId = getFirstInstanceId();
    if (!instanceId) {
      return { success: false, message: "No instance found" };
    }
    try {
      const snapshot = await invoke<{
        cpu_percent: number;
        memory_used_mb: number;
        memory_max_mb?: number;
        timestamp: string;
      }>("get_performance_snapshot", { instanceId });
      const cpu = snapshot.cpu_percent ?? 0;
      const mem = snapshot.memory_used_mb ?? 0;
      const maxMem = snapshot.memory_max_mb;
      log(`Performance: CPU ${cpu}%, RAM ${mem}MB`);
      return {
        success: true,
        message: `CPU: ${cpu.toFixed(1)}%\nRAM: ${mem}MB${maxMem ? ` / ${maxMem}MB` : ""}`,
        data: snapshot
      };
    } catch {
      return { success: false, message: "Instance not running" };
    }
  };

  const testIsPerformanceMonitoring = async (): Promise<TestResult> => {
    const instanceId = getFirstInstanceId();
    if (!instanceId) {
      return { success: false, message: "No instance found" };
    }
    const monitoring = await invoke<boolean>("is_performance_monitoring", { instanceId });
    log(`Performance monitoring: ${monitoring}`);
    return { success: true, message: monitoring ? "Monitoring active" : "Not monitoring" };
  };

  // ==================== Backup Tests ====================

  const testListBackups = async (): Promise<TestResult> => {
    const instanceId = getFirstInstanceId();
    if (!instanceId) {
      return { success: false, message: "No instance found" };
    }
    const backups = await invoke<unknown[]>("list_backups", { instanceId });
    log(`Backups: ${backups.length}`);
    return { success: true, message: `${backups.length} backups`, data: backups };
  };

  const testDetectBackupMod = async (): Promise<TestResult> => {
    const instanceId = getFirstInstanceId();
    if (!instanceId) {
      return { success: false, message: "No instance found" };
    }
    const status = await invoke<{
      has_backup_mod: boolean;
      detected_mod: string | null;
      message: string;
    }>("detect_backup_mod", { instanceId });
    log(`Backup mod: ${status.detected_mod || "none"}`);
    if (!status.has_backup_mod) {
      return { success: true, message: "No backup mod detected" };
    }
    return { success: true, message: `Detected: ${status.detected_mod}` };
  };

  // ==================== Integrity Tests ====================

  const testQuickIntegrityCheck = async (): Promise<TestResult> => {
    const instanceId = getFirstInstanceId();
    if (!instanceId) {
      return { success: false, message: "No instance found" };
    }
    const result = await invoke<{ valid?: boolean; issues?: string[] } | null>("quick_integrity_check", { instanceId });
    if (!result) {
      return { success: false, message: "Check failed" };
    }
    const valid = result.valid ?? true;
    const issues = result.issues || [];
    log(`Integrity: ${valid ? "valid" : "issues found"}`);
    return {
      success: true,
      message: valid ? "All files valid ✓" : `Issues: ${issues.length}`,
      data: result
    };
  };

  // ==================== Collections Tests ====================

  const testListCollections = async (): Promise<TestResult> => {
    const collections = await invoke<unknown[]>("list_collections");
    log(`Collections: ${collections.length}`);
    return { success: true, message: `${collections.length} collections`, data: collections };
  };

  // ==================== Resources Tests ====================

  const testListResources = async (): Promise<TestResult> => {
    const instanceId = getFirstInstanceId();
    // List shaders (resourceType = "shaderpack")
    const shaders = await invoke<unknown[]>("list_resources", {
      resourceType: "shaderpack",
      instanceId: instanceId || null,
      includeGlobal: true
    });
    // List resourcepacks
    const resourcepacks = await invoke<unknown[]>("list_resources", {
      resourceType: "resourcepack",
      instanceId: instanceId || null,
      includeGlobal: true
    });
    log(`Resources: ${shaders.length} shaders, ${resourcepacks.length} resourcepacks`);
    return {
      success: true,
      message: `Shaders: ${shaders.length}\nResourcepacks: ${resourcepacks.length}`,
      data: { shaders, resourcepacks }
    };
  };

  // ==================== Secrets Tests ====================

  const testGetStorageBackend = async (): Promise<TestResult> => {
    const backend = await invoke<string>("get_storage_backend");
    log(`Secret storage backend: ${backend}`);
    return { success: true, message: `Backend: ${backend}` };
  };

  const testTestSecureStorage = async (): Promise<TestResult> => {
    const result = await invoke<{ success: boolean; backend: string; error?: string }>("test_secure_storage");
    log(`Secure storage test: ${result.success ? "passed" : "failed"}`);
    return {
      success: result.success,
      message: result.success ? `${result.backend} working ✓` : `Failed: ${result.error}`
    };
  };

  // ==================== Log Analyzer Tests ====================

  const testGetInstanceLogFiles = async (): Promise<TestResult> => {
    const instanceId = getFirstInstanceId();
    if (!instanceId) {
      return { success: false, message: "No instance found" };
    }
    const logs = await invoke<string[]>("get_instance_log_files", { instanceId });
    log(`Log files: ${logs.length}`);
    return { success: true, message: `${logs.length} log files`, data: logs };
  };

  const testGetCrashHistory = async (): Promise<TestResult> => {
    const instanceId = getFirstInstanceId();
    if (!instanceId) {
      return { success: false, message: "No instance found" };
    }
    const history = await invoke<unknown[]>("get_crash_history_command", { instanceId, limit: 10 });
    log(`Crash history: ${history.length} entries`);
    return { success: true, message: `${history.length} crashes`, data: history };
  };

  // ==================== GPU Tests ====================

  const testDetectGpus = async (): Promise<TestResult> => {
    const result = await invoke<{
      devices: { name: string; vendor: string; device_type: string }[];
      recommended_id: string | null;
      has_multiple_gpus: boolean;
      platform: string;
    }>("detect_gpus_command");
    const gpuNames = result.devices.map(d => d.name).join(", ");
    log(`GPUs detected: ${result.devices.length}`);
    return {
      success: true,
      message: `${result.devices.length} GPUs found\n${gpuNames || "None"}`,
      data: result
    };
  };

  // ==================== Sync Tests ====================

  const testListSyncProfiles = async (): Promise<TestResult> => {
    const profiles = await invoke<unknown[]>("list_sync_profiles");
    log(`Sync profiles: ${profiles.length}`);
    return { success: true, message: `${profiles.length} profiles`, data: profiles };
  };

  // ==================== Modpack Editor Tests ====================

  const testListModpackProjects = async (): Promise<TestResult> => {
    const projects = await invoke<unknown[]>("list_modpack_projects");
    log(`Modpack projects: ${projects.length}`);
    return { success: true, message: `${projects.length} projects`, data: projects };
  };

  // ==================== Error Reporter Tests ====================

  const testListErrorReports = async (): Promise<TestResult> => {
    const reports = await invoke<unknown[]>("list_error_reports");
    log(`Error reports: ${reports.length}`);
    return { success: true, message: `${reports.length} reports`, data: reports };
  };

  const testGetSystemInfo = async (): Promise<TestResult> => {
    const info = await invoke<{
      os: string;
      os_version: string;
      arch: string;
      cpu_cores: number;
      total_memory_mb: number;
      app_version: string;
    }>("get_system_info_command");
    log(`System: ${info.os} ${info.os_version} ${info.arch}`);
    const ramGb = (info.total_memory_mb / 1024).toFixed(1);
    return {
      success: true,
      message: `${info.os} ${info.os_version}\n${info.arch}, ${info.cpu_cores} CPUs\nRAM: ${ramGb}GB`,
      data: info
    };
  };

  return (
    <ModalWrapper maxWidth="max-w-5xl">
      <div class="flex flex-col h-full max-h-[90vh]">
        {/* Header */}
        <div class="flex items-center justify-between p-4 border-b border-gray-700 flex-shrink-0">
          <div class="flex items-center gap-3">
            <i class="i-hugeicons-test-tube w-6 h-6 text-green-400" />
            <div>
              <h2 class="text-xl font-bold">Dev Tests</h2>
              <p class="text-sm text-gray-500">Comprehensive API tests (dev mode only)</p>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <Show when={myShortCode()}>
              <div class="px-3 py-1 bg-blue-600/20 border border-blue-500/30 rounded-lg text-sm font-mono">
                {myShortCode()}
              </div>
            </Show>
            <Show when={myPeerId()}>
              <div class="px-2 py-1 bg-gray-800 rounded text-xs font-mono text-gray-500" title={myPeerId()}>
                {myPeerId().slice(0, 8)}...
              </div>
            </Show>
            <button class="btn-close" onClick={props.onClose}>
              <i class="i-hugeicons-cancel-01 w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div class="flex-1 overflow-y-auto min-h-0">
          <div class="p-4 flex flex-col gap-3">

            {/* P2P Discovery */}
            <Section title="P2P Discovery" icon="i-hugeicons-wifi-01">
              <TestButton label="Start Discovery" onClick={testStartDiscovery} />
              <TestButton label="Stop Discovery" onClick={testStopDiscovery} variant="warning" />
              <TestButton label="Get Peers" onClick={testGetPeers} />
              <TestButton label="My Peer ID" onClick={testGetMyPeerId} />
              <TestButton label="My Short Code" onClick={testGetShortCode} />
            </Section>

            {/* P2P Network */}
            <Section title="P2P Network" icon="i-hugeicons-globe-02">
              <TestButton label="Network Diagnostics" onClick={testNetworkDiagnostics} />
              <TestButton label="Check Firewall" onClick={testCheckFirewall} />
              <TestButton label="Firewall Explanation" onClick={testGetFirewallExplanation} />
            </Section>

            {/* P2P Transfer */}
            <Section title="P2P Transfer" icon="i-hugeicons-download-02">
              <TestButton label="Transfer Sessions" onClick={testGetTransferSessions} />
              <TestButton label="Transfer History" onClick={testGetTransferHistory} />
              <TestButton label="Recent History" onClick={testGetRecentHistory} />
              <TestButton label="History Stats" onClick={testGetHistoryStats} />
              <TestButton label="Transfer Queue" onClick={testGetTransferQueue} />
            </Section>

            {/* P2P Friends & Consent */}
            <Section title="P2P Friends & Consent" icon="i-hugeicons-user-multiple">
              <TestButton label="Get Friends" onClick={testGetFriends} />
              <TestButton label="Pending Consents" onClick={testGetPendingConsents} />
            </Section>

            {/* P2P Groups & Watch */}
            <Section title="P2P Groups & Watch" icon="i-hugeicons-folder-01">
              <TestButton label="Load Peer Groups" onClick={testLoadPeerGroups} />
              <TestButton label="Get All Groups" onClick={testGetAllPeerGroups} />
              <TestButton label="Watch Configs" onClick={testGetAllWatchConfigs} />
              <TestButton label="Active Watches" onClick={testGetActiveWatches} />
            </Section>

            {/* P2P Notifications */}
            <Section title="P2P Notifications" icon="i-hugeicons-notification-02">
              <TestButton label="Update Notifications" onClick={testGetUpdateNotifications} />
              <TestButton label="Unread Count" onClick={testGetUnreadCount} />
            </Section>

            {/* P2P Server Sync */}
            <Section title="P2P Server Sync" icon="i-hugeicons-hard-drive">
              <TestButton label="Server Sync Configs" onClick={testGetAllServerSyncConfigs} />
              <TestButton label="Published Servers" onClick={testGetLocalPublishedServers} />
              <TestButton label="Discovered Servers" onClick={testGetDiscoveredServers} />
              <TestButton label="Active Invites" onClick={testGetAllActiveInvites} />
            </Section>

            {/* P2P Settings */}
            <Section title="P2P Settings" icon="i-hugeicons-settings-02">
              <TestButton label="Connect Settings" onClick={testGetConnectSettings} />
              <TestButton label="VPN Recommendations" onClick={testGetVpnRecommendations} />
            </Section>

            {/* Instances */}
            <Section title="Instances" icon="i-hugeicons-package">
              <TestButton label="List Instances" onClick={testListInstances} />
              <TestButton label="App Paths" onClick={testGetAppPaths} />
              <TestButton label="Storage Info" onClick={testGetStorageInfo} />
            </Section>

            {/* Server */}
            <Section title="Server Management" icon="i-hugeicons-hard-drive">
              <TestButton label="Server Properties" onClick={testGetServerProperties} />
              <TestButton label="EULA Status" onClick={testGetEulaStatus} />
              <TestButton label="Server Status" onClick={testGetServerStatus} />
              <TestButton label="RCON Connected" onClick={testIsRconConnected} />
              <TestButton label="Player Management" onClick={testGetPlayerManagement} />
              <TestButton label="Scan Client Mods" onClick={testScanClientMods} />
              <TestButton label="Loader Versions" onClick={testGetServerLoaderVersions} />
            </Section>

            {/* API */}
            <Section title="API Tests" icon="i-hugeicons-cloud">
              <TestButton label="Modrinth Search" onClick={testModrinthSearch} />
              <TestButton label="CurseForge Search" onClick={testCurseForgeSearch} />
              <TestButton label="MC Versions" onClick={testFetchVersions} />
              <TestButton label="Fabric Versions" onClick={testGetLoaderVersions} />
              <TestButton label="Search Modpacks" onClick={testSearchModpacks} />
            </Section>

            {/* Java */}
            <Section title="Java" icon="i-hugeicons-coffee-01">
              <TestButton label="List Java" onClick={testListJava} />
              <TestButton label="Scan System Java" onClick={testScanSystemJava} />
              <TestButton label="Java for 1.20.1" onClick={testGetJavaForVersion} />
            </Section>

            {/* Settings */}
            <Section title="Settings" icon="i-hugeicons-settings-02" defaultCollapsed>
              <TestButton label="Get Settings" onClick={testGetSettings} />
            </Section>

            {/* Performance */}
            <Section title="Performance" icon="i-hugeicons-chart-line-data-02" defaultCollapsed>
              <TestButton label="Performance Snapshot" onClick={testGetPerformanceSnapshot} />
              <TestButton label="Is Monitoring" onClick={testIsPerformanceMonitoring} />
            </Section>

            {/* Backup */}
            <Section title="Backup" icon="i-hugeicons-archive">
              <TestButton label="List Backups" onClick={testListBackups} />
              <TestButton label="Detect Backup Mod" onClick={testDetectBackupMod} />
            </Section>

            {/* Integrity */}
            <Section title="Integrity" icon="i-hugeicons-shield-01" defaultCollapsed>
              <TestButton label="Quick Integrity Check" onClick={testQuickIntegrityCheck} />
            </Section>

            {/* Collections & Resources */}
            <Section title="Collections & Resources" icon="i-hugeicons-bookmark-02" defaultCollapsed>
              <TestButton label="List Collections" onClick={testListCollections} />
              <TestButton label="List Resources" onClick={testListResources} />
            </Section>

            {/* Secrets */}
            <Section title="Secrets" icon="i-hugeicons-key-01" defaultCollapsed>
              <TestButton label="Storage Backend" onClick={testGetStorageBackend} />
              <TestButton label="Test Secure Storage" onClick={testTestSecureStorage} />
            </Section>

            {/* Log Analyzer */}
            <Section title="Log Analyzer" icon="i-hugeicons-file-view" defaultCollapsed>
              <TestButton label="Instance Log Files" onClick={testGetInstanceLogFiles} />
              <TestButton label="Crash History" onClick={testGetCrashHistory} />
            </Section>

            {/* System */}
            <Section title="System" icon="i-hugeicons-computer" defaultCollapsed>
              <TestButton label="Detect GPUs" onClick={testDetectGpus} />
              <TestButton label="System Info" onClick={testGetSystemInfo} />
              <TestButton label="Sync Profiles" onClick={testListSyncProfiles} />
            </Section>

            {/* Modpack Editor */}
            <Section title="Modpack Editor" icon="i-hugeicons-edit-02" defaultCollapsed>
              <TestButton label="List Projects" onClick={testListModpackProjects} />
            </Section>

            {/* Error Reporter */}
            <Section title="Error Reporter" icon="i-hugeicons-bug-01" defaultCollapsed>
              <TestButton label="List Error Reports" onClick={testListErrorReports} />
            </Section>

          </div>
        </div>

        {/* Log Panel */}
        <div class="border-t border-gray-700 flex-shrink-0">
          <div class="p-2 bg-gray-900/50">
            <div class="flex items-center justify-between mb-1">
              <span class="text-xs text-gray-500 font-mono">Log ({logs().length} entries)</span>
              <button
                class="text-xs text-gray-500 hover:text-gray-300"
                onClick={() => setLogs([])}
              >
                Clear
              </button>
            </div>
            <div class="h-24 overflow-y-auto font-mono text-xs bg-black/30 rounded p-2 space-y-0.5">
              <For each={logs()}>
                {(line) => <div class="text-gray-400">{line}</div>}
              </For>
              <Show when={logs().length === 0}>
                <div class="text-gray-600 italic">No logs yet...</div>
              </Show>
            </div>
          </div>
        </div>
      </div>
    </ModalWrapper>
  );
}

export default DevTests;
