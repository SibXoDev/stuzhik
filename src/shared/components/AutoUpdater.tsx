import { createSignal, Show, onMount } from "solid-js";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { AUTOUPDATER_READY_DELAY_MS } from "../constants";
import { useSafeTimers } from "../hooks";

interface AutoUpdaterProps {
  onReady: () => void;
}

/**
 * Splash screen with update check
 * Shows before main app loads, checks for updates and installs if available
 */
export default function AutoUpdater(props: AutoUpdaterProps) {
  const { setTimeout: safeTimeout } = useSafeTimers();
  const [status, setStatus] = createSignal<
    "checking" | "downloading" | "installing" | "restarting" | "error"
  >("checking");
  const [progress, setProgress] = createSignal(0);
  const [downloadedMB, setDownloadedMB] = createSignal(0);
  const [totalMB, setTotalMB] = createSignal(0);
  const [_error, setError] = createSignal<string | null>(null);
  const [newVersion, setNewVersion] = createSignal<string | null>(null);
  const [currentVersion, setCurrentVersion] = createSignal<string>("...");

  onMount(async () => {
    // Get current version
    try {
      const version = await getVersion();
      setCurrentVersion(version);
    } catch {
      setCurrentVersion("?");
    }

    try {
      const update = await check();

      if (!update) {
        // No update - proceed to app immediately
        props.onReady();
        return;
      }

      setNewVersion(update.version);
      setStatus("downloading");

      let downloaded = 0;
      let total = 0;

      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength || 0;
            setTotalMB(total / 1024 / 1024);
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            setDownloadedMB(downloaded / 1024 / 1024);
            if (total > 0) {
              setProgress(Math.round((downloaded / total) * 100));
            }
            break;
          case "Finished":
            setStatus("installing");
            break;
        }
      });

      setStatus("restarting");
      await relaunch();
    } catch (e) {
      console.error("Update check failed:", e);
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
      // Show error briefly, then proceed to app
      safeTimeout(() => props.onReady(), AUTOUPDATER_READY_DELAY_MS);
    }
  });

  const statusText = () => {
    switch (status()) {
      case "checking":
        return "Проверка обновлений...";
      case "downloading":
        return `Загрузка v${newVersion()}`;
      case "installing":
        return "Установка...";
      case "restarting":
        return "Перезапуск...";
      case "error":
        return "Не удалось проверить обновления";
    }
  };

  return (
    <div class="fixed inset-0 bg-gray-950 flex flex-col items-center justify-center z-50">
      {/* Logo */}
      <div class="mb-6">
        <img src="/logo.png" alt="Stuzhik" class="w-16 h-16 rounded-xl shadow-lg" />
      </div>

      {/* App name */}
      <h1 class="text-xl font-semibold text-white mb-1">Stuzhik</h1>
      <p class="text-gray-600 text-xs mb-6">Minecraft Launcher</p>

      {/* Status */}
      <div class="w-64 flex flex-col items-center">
        <p class="text-gray-400 text-sm mb-3">{statusText()}</p>

        {/* Progress bar */}
        <Show when={status() === "downloading"}>
          <div class="w-full h-1 bg-gray-800 rounded-full overflow-hidden mb-2">
            <div
              class="h-full bg-gradient-to-r from-blue-500 to-indigo-500 transition-all duration-100"
              style={{ width: `${progress()}%` }}
            />
          </div>
          <p class="text-gray-600 text-xs">
            {downloadedMB().toFixed(1)} / {totalMB().toFixed(1)} MB
          </p>
        </Show>

        {/* Spinner */}
        <Show when={status() === "checking" || status() === "installing" || status() === "restarting"}>
          <i class="i-svg-spinners-6-dots-scale w-5 h-5 text-blue-500" />
        </Show>

        {/* Error */}
        <Show when={status() === "error"}>
          <p class="text-gray-600 text-xs">Запуск...</p>
        </Show>
      </div>

      {/* Version */}
      <p class="absolute bottom-4 text-gray-700 text-xs">v{currentVersion()}</p>
    </div>
  );
}
