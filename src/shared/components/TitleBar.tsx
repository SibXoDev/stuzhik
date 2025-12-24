import { createSignal, onMount, onCleanup, Show } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LiveCrashIndicator } from "./LiveCrashIndicator";
import DownloadsButton from "./DownloadsButton";
import ConfirmDialog from "./ConfirmDialog";
import { useI18n } from "../i18n";
import { hasBlockingOperations, getCloseBlockReasons } from "../stores";

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

      {/* Center spacer for drag region */}
      <div class="flex-1" data-tauri-drag-region />

      {/* Actions */}
      <div class="flex items-center gap-1">
        {/* Live Crash Monitor Indicator */}
        <LiveCrashIndicator />

        {/* Connect (Friends) button */}
        <Show when={props.onConnectClick}>
          <button
            class="p-1.5 flex items-center justify-center rounded-2xl bg-transparent border-none outline-none cursor-pointer text-gray-400 hover:text-white hover:bg-white/10 transition-colors duration-75"
            onClick={props.onConnectClick}
            title={t().titleBar.connect}
          >
            <div class="i-hugeicons-user-group w-4 h-4" />
          </button>
        </Show>

        {/* Downloads button */}
        <DownloadsButton />

        {/* Console button */}
        <Show when={props.onConsoleClick}>
          <button
            class="p-1.5 flex items-center justify-center rounded-2xl bg-transparent border-none outline-none cursor-pointer text-gray-400 hover:text-white hover:bg-white/10 transition-colors duration-75"
            onClick={props.onConsoleClick}
            title={t().titleBar.devConsole}
          >
            <div class="i-hugeicons-command-line w-4 h-4" />
          </button>
        </Show>

        {/* Documentation button */}
        <Show when={props.onDocsClick}>
          <button
            class="p-1.5 flex items-center justify-center rounded-2xl bg-transparent border-none outline-none cursor-pointer text-gray-400 hover:text-white hover:bg-white/10 transition-colors duration-75"
            onClick={props.onDocsClick}
            title={t().titleBar.docs}
          >
            <div class="i-hugeicons-book-open-01 w-4 h-4" />
          </button>
        </Show>

        {/* Changelog button */}
        <Show when={props.onChangelogClick}>
          <button
            class="p-1.5 flex items-center justify-center rounded-2xl bg-transparent border-none outline-none cursor-pointer text-gray-400 hover:text-white hover:bg-white/10 transition-colors duration-75"
            onClick={props.onChangelogClick}
            title={t().titleBar.changelog}
          >
            <div class="i-hugeicons-git-branch w-4 h-4" />
          </button>
        </Show>

        {/* Source Code button */}
        <Show when={props.onSourceCodeClick}>
          <button
            class="p-1.5 flex items-center justify-center rounded-2xl bg-transparent border-none outline-none cursor-pointer text-gray-400 hover:text-white hover:bg-white/10 transition-colors duration-75"
            onClick={props.onSourceCodeClick}
            title="Исходный код"
          >
            <div class="i-hugeicons-source-code w-4 h-4" />
          </button>
        </Show>

        {/* Settings button */}
        <Show when={props.onSettingsClick}>
          <button
            class="p-1.5 flex items-center justify-center rounded-2xl bg-transparent border-none outline-none cursor-pointer text-gray-400 hover:text-white hover:bg-white/10 transition-colors duration-75"
            onClick={props.onSettingsClick}
            title={t().titleBar.settings}
          >
            <div class="i-hugeicons-settings-02 w-4 h-4" />
          </button>
        </Show>

        {/* Separator */}
        <div class="w-px h-4 bg-white/10 mx-1" />

        {/* Window Controls */}
        <button
          class="p-1.5 flex items-center justify-center rounded-2xl bg-transparent border-none outline-none cursor-pointer text-gray-400 hover:text-white hover:bg-white/10 transition-colors duration-75"
          onClick={handleMinimize}
          title={t().titleBar.minimize}
        >
          <div class="i-fluent:minimize-24-regular w-4 h-4" />
        </button>

        <button
          class="p-1.5 flex items-center justify-center rounded-2xl bg-transparent border-none outline-none cursor-pointer text-gray-400 hover:text-white hover:bg-white/10 transition-colors duration-75"
          onClick={handleMaximize}
          title={isMaximized() ? t().titleBar.restore : t().titleBar.maximize}
        >
          <div class={isMaximized() ? 'i-fluent:full-screen-minimize-16-filled w-4 h-4' : 'i-fluent:full-screen-maximize-16-filled w-4 h-4'} />
        </button>

        <button
          class="p-1.5 flex items-center justify-center rounded-2xl bg-transparent border-none outline-none cursor-pointer text-gray-400 hover:text-white hover:bg-red-500/80 transition-colors duration-75"
          onClick={handleClose}
          title={t().titleBar.close}
        >
          <div class="i-clarity:close-line w-4 h-4" />
        </button>
      </div>

      {/* Close confirmation dialog */}
      <ConfirmDialog
        open={showCloseConfirm()}
        title={closeReason()?.title || "Закрыть приложение?"}
        message={closeReason()?.message || "Вы уверены что хотите закрыть приложение?"}
        variant={closeReason()?.variant || "warning"}
        confirmText="Закрыть"
        cancelText="Отмена"
        onConfirm={handleConfirmClose}
        onCancel={handleCancelClose}
      />
    </div>
  );
};

export default TitleBar;
