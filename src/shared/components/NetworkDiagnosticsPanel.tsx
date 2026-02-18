import { Show, For, Accessor } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { NetworkDiagnostics } from "./connectTypes";
import { getPortStatusText } from "./connectUtils";

interface NetworkDiagnosticsPanelProps {
  networkDiagnostics: Accessor<NetworkDiagnostics | null>;
  diagnosing: Accessor<boolean>;
  showDiagnostics: Accessor<boolean>;
  onToggleShow: () => void;
  onDiagnose: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: () => any;
}

export function NetworkDiagnosticsPanel(props: NetworkDiagnosticsPanelProps) {
  const t = () => props.t();

  return (
    <div class="mt-4 pt-4 border-t border-gray-700">
      <button
        class="w-full flex items-center justify-between p-2 rounded-lg hover:bg-gray-800 transition-colors"
        onClick={props.onToggleShow}
      >
        <div class="flex items-center gap-2">
          <i class={`w-4 h-4 ${
            props.networkDiagnostics()?.firewall_likely_blocking
              ? "i-hugeicons-alert-02 text-amber-400"
              : props.networkDiagnostics()
                ? "i-hugeicons-checkmark-circle-02 text-green-400"
                : "i-hugeicons-wifi-01 text-gray-400"
          }`} />
          <span class="text-sm font-medium">{t().connect.network.title}</span>
        </div>
        <div class="flex items-center gap-2">
          <Show when={props.diagnosing()}>
            <i class="i-svg-spinners-ring-resize w-4 h-4 text-[var(--color-primary)]" />
          </Show>
          <i class={`w-4 h-4 text-gray-400 transition-transform ${props.showDiagnostics() ? "i-hugeicons-arrow-up-01" : "i-hugeicons-arrow-down-01"}`} />
        </div>
      </button>

      <Show when={props.showDiagnostics()}>
        <div class="mt-2 space-y-3">
          <Show when={props.networkDiagnostics()} fallback={
            <div class="flex items-center justify-center py-4">
              <i class="i-svg-spinners-ring-resize w-5 h-5 text-[var(--color-primary)]" />
            </div>
          }>
            {/* All Network Interfaces */}
            <div class="p-3 bg-gray-800 rounded-lg">
              <div class="text-xs text-gray-500 mb-2 flex items-center gap-1">
                <i class="i-hugeicons-wifi-01 w-3 h-3" />
                {t().connect.network.allInterfaces || "Сетевые интерфейсы"}
              </div>
              <div class="space-y-1.5">
                <For each={props.networkDiagnostics()?.all_interfaces || []} fallback={
                  <div class="text-sm text-gray-500 font-mono">
                    {props.networkDiagnostics()?.local_ip || "—"}
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
                <Show when={(props.networkDiagnostics()?.all_interfaces?.length || 0) === 0 && props.networkDiagnostics()?.local_ip}>
                  <div class="text-sm text-gray-400 font-mono">
                    {props.networkDiagnostics()?.local_ip}
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
                  props.networkDiagnostics()?.firewall_likely_blocking ? "text-amber-400" : "text-green-400"
                }`}>
                  {props.networkDiagnostics()?.firewall_likely_blocking
                    ? t().connect.network.issues
                    : t().connect.network.ok}
                </div>
              </div>

              {/* UDP Port */}
              <div class="p-2 bg-gray-800 rounded-lg">
                <div class="flex items-center justify-between">
                  <span class="text-xs text-gray-500">UDP</span>
                  <span class="text-xs font-mono text-gray-400">
                    :{props.networkDiagnostics()?.udp_status?.port || props.networkDiagnostics()?.udp_port}
                  </span>
                </div>
                <div class={`text-sm font-medium flex items-center gap-1 mt-1 ${
                  props.networkDiagnostics()?.udp_port_open ? "text-green-400" : "text-red-400"
                }`}>
                  <i class={`w-3 h-3 ${props.networkDiagnostics()?.udp_port_open ? "i-hugeicons-checkmark-circle-02" : "i-hugeicons-cancel-01"}`} />
                  <span class="truncate" title={getPortStatusText(props.networkDiagnostics()?.udp_status, props.networkDiagnostics()?.udp_port_open ?? false, props.t)}>
                    {getPortStatusText(props.networkDiagnostics()?.udp_status, props.networkDiagnostics()?.udp_port_open ?? false, props.t)}
                  </span>
                </div>
              </div>

              {/* TCP Port */}
              <div class="p-2 bg-gray-800 rounded-lg">
                <div class="flex items-center justify-between">
                  <span class="text-xs text-gray-500">TCP</span>
                  <span class="text-xs font-mono text-gray-400">
                    :{props.networkDiagnostics()?.tcp_status?.port || props.networkDiagnostics()?.tcp_port}
                  </span>
                </div>
                <div class={`text-sm font-medium flex items-center gap-1 mt-1 ${
                  props.networkDiagnostics()?.tcp_port_open ? "text-green-400" : "text-red-400"
                }`}>
                  <i class={`w-3 h-3 ${props.networkDiagnostics()?.tcp_port_open ? "i-hugeicons-checkmark-circle-02" : "i-hugeicons-cancel-01"}`} />
                  <span class="truncate" title={getPortStatusText(props.networkDiagnostics()?.tcp_status, props.networkDiagnostics()?.tcp_port_open ?? false, props.t)}>
                    {getPortStatusText(props.networkDiagnostics()?.tcp_status, props.networkDiagnostics()?.tcp_port_open ?? false, props.t)}
                  </span>
                </div>
              </div>
            </div>

            {/* Firewall/network warning */}
            <Show when={props.networkDiagnostics()?.firewall_likely_blocking}>
              <div class="p-3 bg-amber-900/20 border border-amber-700/40 rounded-lg">
                <div class="flex items-start gap-2">
                  <i class="i-hugeicons-alert-02 w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
                  <div class="space-y-2 flex-1">
                    <div class="text-sm text-amber-300">
                      {t().connect?.network?.portsClosedWarning ?? "Ports closed — connection issues possible"}
                    </div>
                    <div class="text-xs text-amber-400/70">
                      {t().connect?.network?.portsClosedHint ?? "Make sure both devices are on the same network. For internet play, use VPN (Radmin VPN, ZeroTier, Tailscale)."}
                    </div>
                    <button
                      class="text-xs px-2 py-1 rounded bg-amber-600/30 hover:bg-amber-600/50 text-amber-300 transition-colors"
                      onClick={() => invoke("open_firewall_settings").catch(() => {})}
                    >
                      <i class="i-hugeicons-settings-02 w-3 h-3 mr-1" />
                      {t().connect?.network?.firewallSettings ?? "Firewall Settings"}
                    </button>
                  </div>
                </div>
              </div>
            </Show>

            {/* Re-check button */}
            <button
              class="w-full py-2 text-xs text-gray-500 hover:text-gray-300 transition-colors flex items-center justify-center gap-1"
              onClick={props.onDiagnose}
              disabled={props.diagnosing()}
            >
              <i class={`w-3 h-3 ${props.diagnosing() ? "i-svg-spinners-ring-resize" : "i-hugeicons-refresh"}`} />
              {props.diagnosing() ? t().connect.network.diagnosing : t().connect.network.diagnose}
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
}
