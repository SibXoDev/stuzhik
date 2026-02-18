import { Show, Component } from "solid-js";
import type { Instance } from "../../../shared/types";
import type { Tab } from "./InstanceDetail";

interface MenuPosition {
  top: number;
  left: number;
  maxHeight?: number;
}

interface InstanceContextMenuProps {
  instance: Instance;
  position: MenuPosition;
  menuMode: "primary" | "advanced";
  confirmDelete: string | null;
  setMenuMode: (mode: "primary" | "advanced") => void;
  onOpenMods: (instance: Instance) => void;
  onOpenDetail: (instance: Instance, tab?: Tab) => void;
  onOpenFolder: (instance: Instance) => void;
  onConfigure: (instance: Instance) => void;
  onDelete: (id: string) => void;
  onGameSettings: (instance: Instance) => void;
  onCheckIntegrity: (instance: Instance) => void;
  onExportStzhk: (instance: Instance) => void;
  onReimportManifest: (instance: Instance) => void;
  onConvertToServer: (instance: Instance) => void;
  onRepair: (id: string) => void;
  onClose: () => void;
  menuRef: (el: HTMLDivElement) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: () => any;
}

export const InstanceContextMenu: Component<InstanceContextMenuProps> = (props) => {
  const t = () => props.t();
  const instance = () => props.instance;
  const pos = () => props.position;

  return (
    <>
      {/* Backdrop для закрытия */}
      <div
        class="fixed inset-0 z-40"
        onClick={() => props.onClose()}
      />
      {/* Само меню */}
      <div
        ref={props.menuRef}
        class={`fixed z-50 bg-[--color-bg-elevated] border border-[--color-border] rounded-xl shadow-xl p-2 w-[220px] animate-scale-in ${pos().maxHeight ? 'overflow-y-auto' : 'overflow-hidden'}`}
        style={{
          top: `${pos().top}px`,
          left: `${pos().left}px`,
          ...(pos().maxHeight ? { "max-height": `${pos().maxHeight}px` } : {})
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ===== Primary Menu ===== */}
        <Show when={props.menuMode === "primary"}>
          <button
            class="dropdown-item"
            onClick={() => props.onOpenMods(instance())}
          >
            <i class="i-hugeicons-package w-4 h-4" />
            {t().mods.title}
          </button>

          {/* Game Settings - only for clients */}
          <Show when={instance().instance_type !== "server"}>
            <button
              class="dropdown-item"
              onClick={() => props.onGameSettings(instance())}
            >
              <i class="i-hugeicons-game-controller-03 w-4 h-4" />
              {t().instances.gameSettings}
            </button>
          </Show>

          {/* Server Console - only for servers */}
          <Show when={instance().instance_type === "server"}>
            <button
              class="dropdown-item"
              onClick={() => {
                props.onOpenDetail(instance(), "console");
                props.onClose();
              }}
            >
              <i class="i-hugeicons-computer-terminal-01 w-4 h-4" />
              {t().instances.console}
            </button>
          </Show>

          <button
            class="dropdown-item"
            onClick={() => props.onOpenFolder(instance())}
          >
            <i class="i-hugeicons-folder-01 w-4 h-4" />
            {t().instances.openFolder}
          </button>

          <button
            class="dropdown-item"
            onClick={() => {
              props.onConfigure(instance());
              props.onClose();
            }}
          >
            <i class="i-hugeicons-settings-02 w-4 h-4" />
            {t().common.edit}
          </button>

          <div class="dropdown-divider" />

          <button
            class="dropdown-item"
            data-danger="true"
            onClick={() => props.onDelete(instance().id)}
            disabled={instance().status === "running"}
          >
            <i class="i-hugeicons-delete-02 w-4 h-4" />
            {props.confirmDelete === instance().id
              ? t().instances.confirmDelete
              : t().common.delete}
          </button>

          <div class="dropdown-divider" />

          <button
            class="dropdown-item text-gray-500"
            onClick={() => props.setMenuMode("advanced")}
          >
            <i class="i-hugeicons-more-horizontal w-4 h-4" />
            {t().common.more ?? "Ещё..."}
          </button>
        </Show>

        {/* ===== Advanced Menu ===== */}
        <Show when={props.menuMode === "advanced"}>
          <button
            class="dropdown-item text-[var(--color-primary)]"
            onClick={() => props.setMenuMode("primary")}
          >
            <i class="i-hugeicons-arrow-left-01 w-4 h-4" />
            {t().common.back ?? "Назад"}
          </button>

          <div class="dropdown-divider" />

          <button
            class="dropdown-item"
            onClick={() => {
              props.onOpenDetail(instance(), "logs");
              props.onClose();
            }}
          >
            <i class="i-hugeicons-file-view w-4 h-4" />
            {t().instances.analyzeLogs}
          </button>

          <button
            class="dropdown-item"
            onClick={() => props.onCheckIntegrity(instance())}
          >
            <i class="i-hugeicons-checkmark-circle-02 w-4 h-4" />
            {t().instances.checkIntegrity}
          </button>

          <button
            class="dropdown-item"
            onClick={() => props.onExportStzhk(instance())}
          >
            <i class="i-hugeicons-share-01 w-4 h-4" />
            {t().instances.exportStzhk}
          </button>

          <button
            class="dropdown-item"
            onClick={() => props.onReimportManifest(instance())}
            disabled={
              instance().status === "running" ||
              instance().status === "starting"
            }
          >
            <i class="i-hugeicons-refresh w-4 h-4" />
            {t().instances?.reimport?.title ?? "Re-import Manifest"}
          </button>

          {/* Convert to Server - only for client instances */}
          <Show when={instance().instance_type === "client"}>
            <button
              class="dropdown-item"
              onClick={() => props.onConvertToServer(instance())}
              disabled={
                instance().status === "running" ||
                instance().status === "starting"
              }
            >
              <i class="i-hugeicons-hard-drive w-4 h-4" />
              {t().instances?.conversion?.title ?? "Convert to Server"}
            </button>
          </Show>

          {/* Server Settings - only for servers (in advanced) */}
          <Show when={instance().instance_type === "server"}>
            <button
              class="dropdown-item"
              onClick={() => {
                props.onOpenDetail(instance(), "settings");
                props.onClose();
              }}
            >
              <i class="i-hugeicons-settings-02 w-4 h-4" />
              {t().instances.serverSettings}
            </button>
          </Show>

          <div class="dropdown-divider" />

          <button
            class="dropdown-item"
            onClick={() => {
              props.onRepair(instance().id);
              props.onClose();
            }}
            disabled={
              instance().status === "running" ||
              instance().status === "starting"
            }
          >
            <i class="i-hugeicons-wrench-01 w-4 h-4" />
            {t().instances.repair}
          </button>

          <button
            class="dropdown-item"
            onClick={() => {
              props.onOpenDetail(instance(), "backups");
              props.onClose();
            }}
          >
            <i class="i-hugeicons-floppy-disk w-4 h-4" />
            {t().backup.title}
          </button>

          <button
            class="dropdown-item"
            onClick={() => {
              props.onOpenDetail(instance(), "patches");
              props.onClose();
            }}
          >
            <i class="i-hugeicons-git-compare w-4 h-4" />
            {t().patches?.title || "Патчи"}
          </button>

          <button
            class="dropdown-item"
            onClick={() => {
              props.onOpenDetail(instance(), "performance");
              props.onClose();
            }}
          >
            <i class="i-hugeicons-activity-01 w-4 h-4" />
            {t().performance?.title || "Производительность"}
          </button>
        </Show>
      </div>
    </>
  );
};
