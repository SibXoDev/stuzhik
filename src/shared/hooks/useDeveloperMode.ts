import { createSignal, onMount, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { Settings } from "../types";

/**
 * Hook для управления режимом разработчика
 * Загружает настройку developer_mode из settings и слушает изменения
 */
export function useDeveloperMode() {
  const [developerMode, setDeveloperMode] = createSignal(false);
  const [loading, setLoading] = createSignal(true);

  onMount(async () => {
    // Загружаем initial value
    try {
      const settings = await invoke<Settings>('get_settings');
      setDeveloperMode(settings.developer_mode);
    } catch (e) {
      console.warn('Failed to load developer mode setting:', e);
    } finally {
      setLoading(false);
    }

    // Слушаем изменения через window event
    const handleDeveloperModeChange = (event: Event) => {
      const customEvent = event as CustomEvent<boolean>;
      setDeveloperMode(customEvent.detail);
    };

    window.addEventListener('developerModeChange', handleDeveloperModeChange);

    onCleanup(() => {
      window.removeEventListener('developerModeChange', handleDeveloperModeChange);
    });
  });

  return {
    developerMode,
    loading,
  };
}
