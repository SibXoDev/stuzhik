import { Show, Component } from "solid-js";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { Mod } from "../../../shared/types";
import { sanitizeImageUrl } from "../../../shared/utils/url-validator";
import { Toggle, Tooltip } from "../../../shared/ui";
import { isVisible } from "../../../shared/stores/uiPreferences";

interface ModCardProps {
  mod: Mod;
  instanceId: string;
  isSelected: boolean;
  loading: boolean;
  onToggleSelect: () => void;
  onToggleMod: (id: number, enabled: boolean) => void;
  onUpdateMod: (id: number) => void;
  onToggleAutoUpdate: (id: number, autoUpdate: boolean) => void;
  onShowInfo: (mod: Mod) => void;
  onRemove: (mod: Mod) => void;
  getVerificationStatus: (mod: Mod) => "verified" | "modified" | "unknown";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: () => any;
}

export const ModCard: Component<ModCardProps> = (props) => {
  const mod = () => props.mod;
  const t = () => props.t();

  const getModUrl = () => {
    const platform = mod().source;
    const projectId = mod().source_id;
    if (platform === "modrinth" && projectId) {
      return `https://modrinth.com/mod/${projectId}`;
    }
    if (platform === "curseforge" && projectId) {
      return `https://www.curseforge.com/minecraft/mc-mods/${projectId}`;
    }
    return null;
  };

  const getStatusInfo = () => {
    const status = props.getVerificationStatus(mod());
    const platform = mod().source;

    let platformIcon: string;
    if (platform === "modrinth") {
      platformIcon = "i-simple-icons-modrinth";
    } else if (platform === "curseforge") {
      platformIcon = "i-simple-icons-curseforge";
    } else {
      platformIcon = "i-hugeicons-folder-01";
    }

    let statusIcon: string;
    let statusColor: string;
    let tooltip: string;

    if (status === "verified") {
      statusIcon = "i-hugeicons-security-check";
      statusColor = "text-green-400 hover:text-green-300";
      tooltip = t().mods.list.verification.verifiedTooltip;
    } else if (status === "modified") {
      statusIcon = "i-hugeicons-alert-02";
      statusColor = "text-orange-400 hover:text-orange-300";
      tooltip = t().mods.list.verification.modifiedTooltip;
    } else {
      statusIcon = "i-hugeicons-help-circle";
      statusColor = "text-gray-500 hover:text-gray-400";
      tooltip = t().mods.list.verification.unknownTooltip;
    }

    return { platformIcon, statusIcon, statusColor, tooltip };
  };

  const handlePlatformClick = async (e: MouseEvent) => {
    e.stopPropagation();
    const url = getModUrl();
    if (url) {
      try {
        await openUrl(url);
      } catch (err) {
        if (import.meta.env.DEV) console.error("Failed to open URL:", err);
      }
    }
  };

  return (
    <div class="card flex items-center gap-4">
      {/* Multiselect Checkbox */}
      <Tooltip text={t().mods.list.search.selectMod} position="bottom">
        <input
          type="checkbox"
          checked={props.isSelected}
          onChange={() => props.onToggleSelect()}
          class="w-4 h-4 rounded border-gray-600 bg-gray-800 focus:ring-2 focus:ring-[var(--color-primary-border)] cursor-pointer"
        />
      </Tooltip>

      {/* Enable Toggle */}
      <Toggle
        checked={mod().enabled}
        onChange={(checked) => props.onToggleMod(mod().id, checked)}
      />

      {/* Icon */}
      <Show when={isVisible("modThumbnails") && sanitizeImageUrl(mod().icon_url)}>
        <img
          src={sanitizeImageUrl(mod().icon_url)!}
          alt={mod().name}
          class="w-12 h-12 rounded-2xl object-cover"
          onError={(e) => {
            e.currentTarget.style.display = "none";
          }}
        />
      </Show>

      {/* Info */}
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2">
          <h3 class="font-semibold truncate">
            {mod().name}
          </h3>
          {/* Update Available Badge */}
          <Show when={mod().update_available}>
            <Tooltip text={`${t().mods.list.modActions.updateAvailable}: ${mod().latest_version}`} position="bottom">
              <span
                class="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs font-medium rounded bg-[var(--color-primary-bg)] text-[var(--color-primary)] border border-[var(--color-primary-border)]"
              >
                <i class="i-hugeicons-arrow-up-02 w-3 h-3" />
                <span class="hidden sm:inline">{mod().latest_version}</span>
              </span>
            </Tooltip>
          </Show>
        </div>
        <div class="flex items-center gap-2 text-xs text-muted">
          <span class="font-mono text-gray-500">{mod().slug}</span>
          <span>•</span>
          <span>{mod().version}</span>
          <span>•</span>
          {/* Unified Source + Verification Badge */}
          {(() => {
            const info = getStatusInfo();
            const modUrl = getModUrl();
            const isClickable = !!modUrl;

            return (
              <Tooltip text={info.tooltip} position="bottom">
                <button
                  class={`inline-flex items-center gap-1 transition-colors duration-100 ${info.statusColor} ${isClickable ? "cursor-pointer" : "cursor-default"}`}
                  onClick={handlePlatformClick}
                  disabled={!isClickable}
                >
                  <i class={`${info.platformIcon} w-3 h-3`} />
                  <i class={`${info.statusIcon} w-3 h-3`} />
                  <span class="capitalize">{mod().source}</span>
                  <Show when={isClickable}>
                    <i class="i-hugeicons-arrow-up-right-01 w-3 h-3 opacity-50" />
                  </Show>
                </button>
              </Tooltip>
            );
          })()}
        </div>
      </div>

      {/* Actions */}
      <div class="flex items-center gap-2">
        {/* Update Button - only if update is available */}
        <Show when={mod().update_available}>
          <Tooltip text={`${t().mods.list.modActions.updateTo} ${mod().latest_version}`} position="bottom">
            <button
              class="btn-primary btn-sm"
              onClick={() => props.onUpdateMod(mod().id)}
              disabled={props.loading}
            >
              <i class="i-hugeicons-arrow-up-02 w-4 h-4" />
            </button>
          </Tooltip>
        </Show>

        {/* Auto-update Toggle */}
        <Show when={mod().source !== "local"}>
          <Tooltip text={mod().auto_update ? t().mods.list.modActions.autoUpdateEnabled : t().mods.list.modActions.autoUpdateDisabled} position="bottom">
            <button
              class={`btn-ghost btn-sm ${mod().auto_update ? "text-[var(--color-primary)]" : "text-gray-500"}`}
              onClick={() => props.onToggleAutoUpdate(mod().id, !mod().auto_update)}
            >
              <i class="i-hugeicons-refresh w-4 h-4" />
            </button>
          </Tooltip>
        </Show>

        {/* Mod Information */}
        <Tooltip text={t().mods.list.modActions.modInfo} position="bottom">
          <button
            class="btn-ghost btn-sm"
            onClick={() => props.onShowInfo(mod())}
          >
            <i class="i-hugeicons-information-circle w-4 h-4" />
          </button>
        </Tooltip>

        {/* Open in folder */}
        <Tooltip text={t().mods.list.modActions.showInFolder} position="bottom">
          <button
            class="btn-ghost btn-sm"
            onClick={async () => {
              try {
                const instance = await invoke<{ dir: string }>("get_instance", { id: props.instanceId });
                const modPath = `${instance.dir}/mods/${mod().file_name}`;
                await revealItemInDir(modPath);
              } catch (e) {
                if (import.meta.env.DEV) console.error("Failed to open mod in folder:", e);
              }
            }}
          >
            <i class="i-hugeicons-folder-search w-4 h-4" />
          </button>
        </Tooltip>

        {/* Delete */}
        <Tooltip text={t().mods.list.modActions.deleteMod} position="bottom">
          <button
            class="btn-ghost btn-sm text-red-400 hover:text-red-300"
            onClick={() => props.onRemove(mod())}
          >
            <i class="i-hugeicons-delete-02 w-4 h-4" />
          </button>
        </Tooltip>
      </div>
    </div>
  );
};
