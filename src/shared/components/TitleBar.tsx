import { createSignal, onMount, onCleanup, Show } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LiveCrashIndicator } from "./LiveCrashIndicator";
import DownloadsButton from "./DownloadsButton";
import ConfirmDialog from "./ConfirmDialog";
// GameSwitcher hidden until Hytale support is ready
// import GameSwitcher from "./GameSwitcher";
import { useI18n } from "../i18n";
import { hasBlockingOperations, getCloseBlockReasons } from "../stores";
import { isVisible } from "../stores/uiPreferences";
import { Tooltip } from "../ui";

interface TitleBarProps {
  onSettingsClick?: () => void;
  onConsoleClick?: () => void;
  onConnectClick?: () => void;
  onDocsClick?: () => void;
  onChangelogClick?: () => void;
  onSourceCodeClick?: () => void;
}

const TitleBar = (props: TitleBarProps) => {
  const { t } = useI18n();
  const [isMaximized, setIsMaximized] = createSignal(false);
  const [showCloseConfirm, setShowCloseConfirm] = createSignal(false);
  const [closeReason, setCloseReason] = createSignal<ReturnType<typeof getCloseBlockReasons>>(null);
  const appWindow = getCurrentWindow();

  let unlistenResize: (() => void) | null = null;

  onMount(async () => {
    setIsMaximized(await appWindow.isMaximized());

    unlistenResize = await appWindow.onResized(async () => {
      setIsMaximized(await appWindow.isMaximized());
    });
  });

  onCleanup(() => {
    unlistenResize?.();
  });

  const handleMinimize = () => appWindow.minimize();
  const handleMaximize = () => appWindow.toggleMaximize();

  const handleClose = () => {
    // Проверяем есть ли блокирующие операции
    if (hasBlockingOperations()) {
      const reason = getCloseBlockReasons();
      if (reason) {
        setCloseReason(reason);
        setShowCloseConfirm(true);
        return;
      }
    }
    // Нет блокирующих операций - закрываем сразу
    appWindow.close();
  };

  const handleConfirmClose = () => {
    setShowCloseConfirm(false);
    appWindow.close();
  };

  const handleCancelClose = () => {
    setShowCloseConfirm(false);
    setCloseReason(null);
  };

  return (
    <div
      data-tauri-drag-region
      class="fixed top-0 left-0 right-0 h-[var(--titlebar-height)] flex items-center justify-between px-3 bg-transparent select-none z-[60]"
    >
      {/* Logo */}
      <img src="/logo.png" alt="Stuzhik" class="w-6 h-6 rounded-md pointer-events-none" />

      {/* Game Switcher - hidden until Hytale support is ready */}
      {/* <div class="ml-3">
        <GameSwitcher />
      </div> */}

      {/* Center spacer for drag region */}
      <div class="flex-1" data-tauri-drag-region />

      {/* Actions */}
      <div class="flex items-center gap-1">
        {/* Live Crash Monitor Indicator */}
        <LiveCrashIndicator />

        {/* Connect (Friends) button */}
        <Show when={props.onConnectClick && isVisible("connectButton")}>
          <Tooltip text={t().titleBar.connect} position="bottom">
            <button
              class="p-1.5 flex items-center justify-center rounded-2xl bg-transparent border-none outline-none cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors duration-75"
              data-tour="connect"
              onClick={props.onConnectClick}
              aria-label={t().titleBar.connect}
            >
              <div class="i-hugeicons-user-group w-4 h-4" />
            </button>
          </Tooltip>
        </Show>

        {/* Downloads button */}
        <DownloadsButton />

        {/* Console button */}
        <Show when={props.onConsoleClick}>
          <Tooltip text={t().titleBar.devConsole} position="bottom">
            <button
              class="p-1.5 flex items-center justify-center rounded-2xl bg-transparent border-none outline-none cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors duration-75"
              onClick={props.onConsoleClick}
              aria-label={t().titleBar.devConsole}
            >
              <div class="i-hugeicons-command-line w-4 h-4" />
            </button>
          </Tooltip>
        </Show>

        {/* Documentation button */}
        <Show when={props.onDocsClick}>
          <Tooltip text={t().titleBar.docs} position="bottom">
            <button
              class="p-1.5 flex items-center justify-center rounded-2xl bg-transparent border-none outline-none cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors duration-75"
              data-tour="docs"
              onClick={props.onDocsClick}
              aria-label={t().titleBar.docs}
            >
              <div class="i-hugeicons-book-open-01 w-4 h-4" />
            </button>
          </Tooltip>
        </Show>

        {/* Changelog button */}
        <Show when={props.onChangelogClick}>
          <Tooltip text={t().titleBar.changelog} position="bottom">
            <button
              class="p-1.5 flex items-center justify-center rounded-2xl bg-transparent border-none outline-none cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors duration-75"
              onClick={props.onChangelogClick}
              aria-label={t().titleBar.changelog}
            >
              <div class="i-hugeicons-git-branch w-4 h-4" />
            </button>
          </Tooltip>
        </Show>

        {/* Source Code button */}
        <Show when={props.onSourceCodeClick}>
          <Tooltip text={t().titleBar.sourceCode} position="bottom">
            <button
              class="p-1.5 flex items-center justify-center rounded-2xl bg-transparent border-none outline-none cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors duration-75"
              onClick={props.onSourceCodeClick}
              aria-label={t().titleBar.sourceCode}
            >
              <div class="i-hugeicons-source-code w-4 h-4" />
            </button>
          </Tooltip>
        </Show>

        {/* Settings button */}
        <Show when={props.onSettingsClick}>
          <Tooltip text={t().titleBar.settings} position="bottom">
            <button
              class="p-1.5 flex items-center justify-center rounded-2xl bg-transparent border-none outline-none cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors duration-75"
              data-tour="settings"
              onClick={props.onSettingsClick}
              aria-label={t().titleBar.settings}
            >
              <div class="i-hugeicons-settings-02 w-4 h-4" />
            </button>
          </Tooltip>
        </Show>

        {/* Separator */}
        <div class="w-px h-4 bg-[var(--color-border)] mx-1" />

        {/* Window Controls */}
        <Tooltip text={t().titleBar.minimize} position="bottom">
          <button
            class="p-1.5 flex items-center justify-center rounded-2xl bg-transparent border-none outline-none cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors duration-75"
            onClick={handleMinimize}
            aria-label={t().titleBar.minimize}
          >
            <div class="i-fluent:minimize-24-regular w-4 h-4" />
          </button>
        </Tooltip>

        <Tooltip text={isMaximized() ? t().titleBar.restore : t().titleBar.maximize} position="bottom">
          <button
            class="p-1.5 flex items-center justify-center rounded-2xl bg-transparent border-none outline-none cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors duration-75"
            onClick={handleMaximize}
            aria-label={isMaximized() ? t().titleBar.restore : t().titleBar.maximize}
          >
            <div class={isMaximized() ? 'i-fluent:full-screen-minimize-16-filled w-4 h-4' : 'i-fluent:full-screen-maximize-16-filled w-4 h-4'} />
          </button>
        </Tooltip>

        <Tooltip text={t().titleBar.close} position="bottom">
          <button
            class="p-1.5 flex items-center justify-center rounded-2xl bg-transparent border-none outline-none cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-red-500/80 transition-colors duration-75"
            onClick={handleClose}
            aria-label={t().titleBar.close}
          >
            <div class="i-clarity:close-line w-4 h-4" />
          </button>
        </Tooltip>
      </div>

      {/* Close confirmation dialog */}
      <ConfirmDialog
        open={showCloseConfirm()}
        title={closeReason()?.title || t().titleBar.closeConfirm.title}
        message={closeReason()?.message || t().titleBar.closeConfirm.message}
        variant={closeReason()?.variant || "warning"}
        confirmText={t().titleBar.closeConfirm.confirm}
        cancelText={t().titleBar.closeConfirm.cancel}
        onConfirm={handleConfirmClose}
        onCancel={handleCancelClose}
      />
    </div>
  );
};

export default TitleBar;
