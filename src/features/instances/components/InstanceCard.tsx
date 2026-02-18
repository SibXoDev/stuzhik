import { Show, Component } from "solid-js";
import type { Instance } from "../../../shared/types";
import { isVisible } from "../../../shared/stores/uiPreferences";
import { getSafeLocale } from "../../../shared/i18n";
import { LoaderIcon } from "../../../shared/components/LoaderSelector";
import { Tooltip } from "../../../shared/ui/Tooltip";

interface InstanceCardProps {
  instance: Instance;
  hasBothTypes: boolean;
  isDraggingMods: boolean;
  isHovered: boolean;
  acceptsMods: boolean;
  getStatusText: (status: string) => string;
  onClick: () => void;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  onToggleMenu: (id: string, e: MouseEvent) => void;
  registerRef: (id: string, el: HTMLDivElement) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: () => any;
  language: () => string;
}

export const InstanceCard: Component<InstanceCardProps> = (props) => {
  const instance = () => props.instance;

  const cardClasses = () => {
    if (!props.isDraggingMods) {
      return "card-hover";
    }

    if (props.acceptsMods) {
      if (props.isHovered) {
        return "bg-[var(--color-bg-card)] rounded-xl p-4 border border-[var(--color-primary)]";
      }
      return "bg-[var(--color-bg-card)] rounded-xl p-4 border border-dashed border-[var(--color-primary-border)]";
    }

    return "bg-[var(--color-bg-card)] rounded-xl p-4 border border-dashed border-gray-600/50 opacity-50";
  };

  return (
    <div
      ref={(el) => props.registerRef(instance().id, el)}
      class={`group cursor-pointer transition-all duration-150 ${cardClasses()}`}
      onClick={() => props.onClick()}
    >
      {/* Drop zone indicator overlay for valid targets */}
      <Show when={props.isDraggingMods && props.isHovered && props.acceptsMods}>
        <div class="absolute inset-0 flex items-center justify-center bg-[var(--color-primary-bg)] rounded-xl pointer-events-none z-10">
          <div class="flex items-center gap-2 px-4 py-2 bg-[var(--color-primary)] rounded-full text-white text-sm font-medium shadow-lg animate-pulse">
            <i class="i-hugeicons-download-02 w-4 h-4" />
            <span>{props.t().instances.dropToInstall}</span>
          </div>
        </div>
      </Show>

      {/* Drop zone indicator overlay for invalid targets */}
      <Show when={props.isDraggingMods && props.isHovered && !props.acceptsMods}>
        <div class="absolute inset-0 flex items-center justify-center bg-red-500/10 rounded-xl pointer-events-none z-10">
          <div class="flex items-center gap-2 px-4 py-2 bg-red-600/80 rounded-full text-white text-sm font-medium shadow-lg">
            <i class="i-hugeicons-cancel-01 w-4 h-4" />
            <span>{props.t().instances.needModLoader}</span>
          </div>
        </div>
      </Show>

      <div class="flex items-center gap-4">
        {/* Loader Icon */}
        <div class="w-12 h-12 rounded-2xl bg-black/30 flex-center flex-shrink-0 border border-gray-700/50">
          <LoaderIcon loader={instance().loader} class="w-7 h-7" />
        </div>

        {/* Info */}
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-3 mb-1">
            <h3 class="text-base font-medium truncate text-gray-100">
              {instance().name}
            </h3>
            {/* Instance Type Badge - only show when both types exist and badges enabled */}
            <Show when={props.hasBothTypes && isVisible("instanceBadges")}>
              <span
                class={`px-2 py-0.5 text-xs rounded-full flex-shrink-0 ${
                  instance().instance_type === "server"
                    ? "bg-purple-500/15 text-purple-400 border border-purple-500/30"
                    : "bg-blue-500/15 text-blue-400 border border-blue-500/30"
                }`}
              >
                {instance().instance_type === "server" ? "Server" : "Client"}
              </span>
            </Show>
            {/* Status Indicator */}
            <Show when={instance().status !== "stopped"}>
              <Show
                when={instance().status === "error" && instance().installation_error}
                fallback={
                  <span
                    class={`px-2 py-0.5 text-xs rounded-full ${
                      instance().status === "running"
                        ? "bg-emerald-500/10 text-emerald-400"
                        : instance().status === "starting"
                          ? "bg-yellow-500/10 text-yellow-400"
                          : instance().status === "installing"
                            ? "bg-blue-500/10 text-blue-400"
                            : instance().status === "error"
                              ? "bg-red-500/10 text-red-400"
                              : "bg-gray-500/10 text-gray-400"
                    }`}
                  >
                    {props.getStatusText(instance().status)}
                  </span>
                }
              >
                <Tooltip
                  text={instance().installation_error || props.t().instances.status.error}
                  position="bottom"
                  delay={100}
                >
                  <span class="px-2 py-0.5 text-xs rounded-full bg-red-500/10 text-red-400 cursor-help flex items-center gap-1">
                    <i class="i-hugeicons-alert-02 w-3 h-3" />
                    {props.getStatusText(instance().status)}
                  </span>
                </Tooltip>
              </Show>
            </Show>
          </div>
          <div class="flex items-center gap-2 text-xs text-gray-500">
            <span>{instance().version}</span>
            <span class="w-1 h-1 rounded-full bg-gray-700" />
            <span class="capitalize">{instance().loader || "vanilla"}</span>
            <Show when={instance().last_played}>
              <span class="w-1 h-1 rounded-full bg-gray-700" />
              <span>{new Date(instance().last_played!).toLocaleDateString(getSafeLocale(props.language()))}</span>
            </Show>
            <Show when={isVisible("instancePlaytime") && instance().total_playtime > 0}>
              <span class="w-1 h-1 rounded-full bg-gray-700" />
              <span>
                {Math.floor(instance().total_playtime / 3600)}{props.t().instances.hoursShort}{" "}
                {Math.floor((instance().total_playtime % 3600) / 60)}{props.t().instances.minutesShort}
              </span>
            </Show>
          </div>
        </div>

        {/* Actions */}
        <div class="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
          {/* Primary Action Button */}
          <Show
            when={instance().status === "running"}
            fallback={
              <button
                class="px-4 py-2 text-sm font-medium rounded-2xl bg-white/10 hover:bg-white/15 text-white transition-colors disabled:opacity-50"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onStart(instance().id);
                }}
                disabled={
                  instance().status === "starting" ||
                  instance().status === "installing"
                }
              >
                <Show
                  when={instance().status === "starting"}
                  fallback={
                    <span class="flex items-center gap-2">
                      <i class="i-hugeicons-play w-3.5 h-3.5" />
                      {props.t().instances.play}
                    </span>
                  }
                >
                  <span class="flex items-center gap-2">
                    <i class="i-svg-spinners-6-dots-scale w-3.5 h-3.5" />
                    {props.t().instances.launching}
                  </span>
                </Show>
              </button>
            }
          >
            <button
              class="px-4 py-2 text-sm font-medium rounded-2xl bg-red-500/10 hover:bg-red-500/20 text-red-400 transition-colors"
              onClick={(e) => {
                e.stopPropagation();
                props.onStop(instance().id);
              }}
              disabled={instance().status === "stopping"}
            >
              <Show
                when={instance().status === "stopping"}
                fallback={
                  <span class="flex items-center gap-2">
                    <i class="i-hugeicons-stop w-3.5 h-3.5" />
                    {props.t().instances.stopShort}
                  </span>
                }
              >
                <span class="flex items-center gap-2">
                  <i class="i-svg-spinners-6-dots-scale w-3.5 h-3.5" />
                  ...
                </span>
              </Show>
            </button>
          </Show>

          {/* More Actions Menu Button */}
          <Tooltip text={props.t().instances.moreActions} position="bottom">
            <button
              class="p-2 rounded-2xl hover:bg-white/10 text-gray-400 hover:text-white transition-colors"
              onClick={(e) => {
                e.stopPropagation();
                props.onToggleMenu(instance().id, e);
              }}
            >
              <i class="i-hugeicons-more-horizontal w-4 h-4" />
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
};
