export interface PeerInfo {
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

export interface ConnectSettings {
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

export interface TransferSession {
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

export interface TransferHistoryEntry {
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

export interface HistoryStats {
  total_transfers: number;
  successful: number;
  failed: number;
  cancelled: number;
  total_bytes_uploaded: number;
  total_bytes_downloaded: number;
}

export interface QueuedTransfer {
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

export interface UpdateNotification {
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

export interface NetworkRecommendation {
  priority: number;
  title: string;
  description: string;
  action: string | null;
}

export interface NetworkInterface {
  name: string;
  ip: string;
  is_vpn: boolean;
}

export type PortStatusCode = "available" | "available_fallback" | "stuzhik_using" | "stuzhik_using_fallback" | "all_busy" | "closed";

export interface PortStatus {
  port: number;
  open: boolean;
  status_code: PortStatusCode;
  fallback_port: number | null;
}

export interface NetworkDiagnostics {
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

export interface DiscoveredServer {
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
export type DiscoveredServerRaw = Omit<DiscoveredServer, "host_peer_id" | "host_nickname">;
export type DiscoveredServersResponse = Array<[string, DiscoveredServerRaw]>;

// Union type for transfer events - strict typing for event payloads
export type TransferEventPayload =
  | { type: "session_created"; session: TransferSession }
  | { type: "progress"; session_id: string; bytes_done: number; bytes_total: number; files_done: number; files_total: number; current_file: string | null; speed_bps?: number; eta_seconds?: number }
  | { type: "completed"; session_id: string }
  | { type: "error"; session_id: string; error_message?: string }
  | { type: "cancelled"; session_id: string }
  | { type: "paused"; session_id: string }
  | { type: "resumed"; session_id: string };

export interface ConnectPanelProps {
  onClose: () => void;
  onOpenSettings: (scrollTo?: string) => void;
}
