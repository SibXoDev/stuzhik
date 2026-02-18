export type ServerVisibility = "Invisible" | "FriendsOnly" | "AuthorizedOnly" | "Everyone";
export type SyncSource = "none" | "client_instance" | "modpack_file";

export interface ServerSyncConfig {
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

export interface ServerInvite {
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

export interface P2PInstance {
  id: string;
  name: string;
  instance_type: string;
  mc_version?: string;
  loader?: string;
}

export interface InstalledMod {
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
