import type { PortStatus, PortStatusCode, PeerInfo } from "./connectTypes";

export const formatBytes = (bytes: number | undefined | null): string => {
  if (bytes === undefined || bytes === null || isNaN(bytes) || bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
};

export const formatSpeed = (bps: number | undefined | null): string => {
  if (bps === undefined || bps === null || isNaN(bps) || bps === 0) return "0 B/s";
  const k = 1024;
  const sizes = ["B/s", "KB/s", "MB/s", "GB/s"];
  const i = Math.min(Math.floor(Math.log(bps) / Math.log(k)), sizes.length - 1);
  return parseFloat((bps / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const formatEta = (seconds: number | undefined | null, translations: () => any): string => {
  if (seconds === undefined || seconds === null || isNaN(seconds) || seconds <= 0) {
    return translations().connect?.transfer?.calculating ?? "Calculating...";
  }
  if (seconds < 60) {
    return `${Math.ceil(seconds)} ${translations().connect?.transfer?.secondsShort ?? "s"}`;
  }
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.ceil(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")} ${translations().connect?.transfer?.remaining ?? "remaining"}`;
  }
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}:${mins.toString().padStart(2, "0")} ${translations().connect?.transfer?.remaining ?? "remaining"}`;
};

export const getSecondsSinceLastSeen = (lastSeenIso: string): number => {
  try {
    const lastSeenDate = new Date(lastSeenIso);
    return Math.floor((Date.now() - lastSeenDate.getTime()) / 1000);
  } catch {
    return 0;
  }
};

export const isPeerStale = (peer: PeerInfo): boolean => {
  const secondsAgo = getSecondsSinceLastSeen(peer.last_seen);
  return secondsAgo > 15;
};

export const formatLastSeen = (peer: PeerInfo, t: () => { connect?: { lastSeenSeconds?: string; lastSeenMinutes?: string; ago?: string } }): string => {
  const secondsAgo = getSecondsSinceLastSeen(peer.last_seen);
  if (secondsAgo < 60) {
    return `${secondsAgo}${t().connect?.lastSeenSeconds ?? "s"} ${t().connect?.ago ?? "ago"}`;
  }
  const minutes = Math.floor(secondsAgo / 60);
  return `${minutes}${t().connect?.lastSeenMinutes ?? "m"} ${t().connect?.ago ?? "ago"}`;
};

export const formatTimeAgo = (dateString: string, t: () => { connect: { timeAgo: { justNow: string; minutes: string; hours: string; days: string } } }): string => {
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

export const getPortStatusText = (
  status: PortStatus | undefined,
  isOpen: boolean,
  t: () => { connect?: { network?: Record<string, string> } }
): string => {
  if (!status) {
    return isOpen
      ? (t().connect?.network?.portOpen ?? "Open")
      : (t().connect?.network?.portClosed ?? "Closed");
  }

  const network = t().connect?.network ?? {};
  const statusTexts: Record<PortStatusCode, string> = {
    available: network.portAvailable ?? "Available",
    available_fallback: (network.portAvailableFallback ?? `Available (fallback: ${status.fallback_port})`).replace("{port}", String(status.fallback_port)),
    stuzhik_using: network.portStuzhikUsing ?? "Used by Stuzhik",
    stuzhik_using_fallback: (network.portStuzhikFallback ?? `Used by Stuzhik (fallback: ${status.fallback_port})`).replace("{port}", String(status.fallback_port)),
    all_busy: network.portAllBusy ?? "All ports busy",
    closed: network.portClosed ?? "Closed",
  };

  return statusTexts[status.status_code] || (isOpen ? network.portOpen ?? "Open" : network.portClosed ?? "Closed");
};
