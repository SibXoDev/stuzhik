/**
 * Hytale Settings Panel
 * Configure launch options, localization, and logging
 */

import { createSignal, For, Show, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useI18n } from "../../../shared/i18n";
import { Toggle } from "../../../shared/ui";
import { addToast } from "../../../shared/components/Toast";

interface HytaleSettings {
  verbose_logging: boolean;
  game_args: string | null;
  skip_intro: boolean;
  windowed: boolean;
  resolution_width: number | null;
  resolution_height: number | null;
  language: string | null;
  auto_connect_server: string | null;
}

interface LanguagePack {
  code: string;
  name: string;
  url: string | null;
  installed: boolean;
  version: string | null;
}

export default function HytaleSettingsPanel() {
  const { t } = useI18n();

  const [settings, setSettings] = createSignal<HytaleSettings>({
    verbose_logging: false,
    game_args: null,
    skip_intro: false,
    windowed: false,
    resolution_width: null,
    resolution_height: null,
    language: null,
    auto_connect_server: null,
  });

  const [languages, setLanguages] = createSignal<LanguagePack[]>([]);
  const [saving, setSaving] = createSignal(false);
  const [installing, setInstalling] = createSignal(false);

  onMount(async () => {
    try {
      const [loadedSettings, loadedLanguages] = await Promise.all([
        invoke<HytaleSettings>("get_hytale_settings"),
        invoke<LanguagePack[]>("get_hytale_languages"),
      ]);
      setSettings(loadedSettings);
      setLanguages(loadedLanguages);
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to load Hytale settings:", e);
    }
  });

  const updateSetting = <K extends keyof HytaleSettings>(
    key: K,
    value: HytaleSettings[K]
  ) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const saveSettings = async () => {
    setSaving(true);
    try {
      await invoke("save_hytale_settings", { settings: settings() });
      addToast({
        type: "success",
        title: t().common.saved || "Saved",
        message: t().hytale?.settingsSaved || "Hytale settings saved",
      });
    } catch (e) {
      addToast({
        type: "error",
        title: t().common.error || "Error",
        message: String(e),
      });
    } finally {
      setSaving(false);
    }
  };

  const installLanguagePack = async () => {
    setInstalling(true);
    try {
      const file = await open({
        filters: [{ name: "Language Pack", extensions: ["json"] }],
        multiple: false,
      });

      if (file) {
        // Ask for language code (default to ru)
        const langCode = "ru"; // TODO: Add dialog to select language code

        await invoke("install_hytale_language", {
          filePath: file,
          langCode,
        });

        // Reload languages
        const updatedLanguages = await invoke<LanguagePack[]>("get_hytale_languages");
        setLanguages(updatedLanguages);

        addToast({
          type: "success",
          title: t().hytale?.languageInstalled || "Language pack installed",
          message: t().hytale?.restartRequired || "Restart Hytale to apply",
        });
      }
    } catch (e) {
      addToast({
        type: "error",
        title: t().common.error || "Error",
        message: String(e),
      });
    } finally {
      setInstalling(false);
    }
  };

  const openLogs = async () => {
    try {
      await invoke("open_hytale_logs");
    } catch (e) {
      addToast({
        type: "error",
        title: t().common.error || "Error",
        message: String(e),
      });
    }
  };

  return (
    <div class="flex flex-col gap-6 p-4">
      {/* Launch Settings */}
      <section>
        <h3 class="text-lg font-semibold mb-4 flex items-center gap-2">
          <i class="i-hugeicons-settings-02 w-5 h-5 text-[var(--color-primary)]" />
          {t().hytale?.launchSettings || "Launch Settings"}
        </h3>

        <div class="space-y-4">
          {/* Skip Intro */}
          <div class="flex items-center justify-between">
            <div>
              <div class="font-medium">{t().hytale?.skipIntro || "Skip Intro"}</div>
              <div class="text-sm text-gray-400">
                {t().hytale?.skipIntroDesc || "Skip intro videos on launch"}
              </div>
            </div>
            <Toggle
              checked={settings().skip_intro}
              onChange={(v) => updateSetting("skip_intro", v)}
            />
          </div>

          {/* Windowed Mode */}
          <div class="flex items-center justify-between">
            <div>
              <div class="font-medium">{t().hytale?.windowed || "Windowed Mode"}</div>
              <div class="text-sm text-gray-400">
                {t().hytale?.windowedDesc || "Launch in windowed mode instead of fullscreen"}
              </div>
            </div>
            <Toggle
              checked={settings().windowed}
              onChange={(v) => updateSetting("windowed", v)}
            />
          </div>

          {/* Resolution */}
          <Show when={settings().windowed}>
            <div class="flex items-center gap-4 pl-4 border-l-2 border-gray-700">
              <div class="flex-1">
                <label class="text-sm text-gray-400 mb-1 block">
                  {t().hytale?.width || "Width"}
                </label>
                <input
                  type="number"
                  class="w-full px-3 py-2 bg-gray-800 rounded-lg border border-gray-700"
                  value={settings().resolution_width || ""}
                  placeholder="1920"
                  onInput={(e) =>
                    updateSetting(
                      "resolution_width",
                      e.currentTarget.value ? parseInt(e.currentTarget.value) : null
                    )
                  }
                />
              </div>
              <div class="flex-1">
                <label class="text-sm text-gray-400 mb-1 block">
                  {t().hytale?.height || "Height"}
                </label>
                <input
                  type="number"
                  class="w-full px-3 py-2 bg-gray-800 rounded-lg border border-gray-700"
                  value={settings().resolution_height || ""}
                  placeholder="1080"
                  onInput={(e) =>
                    updateSetting(
                      "resolution_height",
                      e.currentTarget.value ? parseInt(e.currentTarget.value) : null
                    )
                  }
                />
              </div>
            </div>
          </Show>

          {/* Custom Arguments */}
          <div>
            <label class="font-medium mb-1 block">
              {t().hytale?.customArgs || "Custom Arguments"}
            </label>
            <input
              type="text"
              class="w-full px-3 py-2 bg-gray-800 rounded-lg border border-gray-700"
              value={settings().game_args || ""}
              placeholder="--arg1 --arg2=value"
              onInput={(e) =>
                updateSetting("game_args", e.currentTarget.value || null)
              }
            />
            <div class="text-xs text-gray-500 mt-1">
              {t().hytale?.customArgsDesc || "Additional command line arguments"}
            </div>
          </div>

          {/* Auto-connect Server */}
          <div>
            <label class="font-medium mb-1 block">
              {t().hytale?.autoConnect || "Auto-connect Server"}
            </label>
            <input
              type="text"
              class="w-full px-3 py-2 bg-gray-800 rounded-lg border border-gray-700"
              value={settings().auto_connect_server || ""}
              placeholder="server.example.com"
              onInput={(e) =>
                updateSetting("auto_connect_server", e.currentTarget.value || null)
              }
            />
            <div class="text-xs text-gray-500 mt-1">
              {t().hytale?.autoConnectDesc || "Automatically connect to this server on launch"}
            </div>
          </div>
        </div>
      </section>

      {/* Localization */}
      <section>
        <h3 class="text-lg font-semibold mb-4 flex items-center gap-2">
          <i class="i-hugeicons-globe-02 w-5 h-5 text-green-400" />
          {t().hytale?.localization || "Localization"}
        </h3>

        <div class="space-y-3">
          <For each={languages()}>
            {(lang) => (
              <div class="flex items-center justify-between p-3 bg-gray-800/50 rounded-lg">
                <div class="flex items-center gap-3">
                  <span class="text-lg">{lang.code === "ru" ? "🇷🇺" : "🇬🇧"}</span>
                  <div>
                    <div class="font-medium">{lang.name}</div>
                    <Show when={lang.version}>
                      <div class="text-xs text-gray-500">{lang.version}</div>
                    </Show>
                  </div>
                </div>
                <Show
                  when={lang.installed}
                  fallback={
                    <span class="text-xs text-gray-500">
                      {t().hytale?.notInstalled || "Not installed"}
                    </span>
                  }
                >
                  <span class="flex items-center gap-1 text-xs text-green-400">
                    <i class="i-hugeicons-checkmark-circle-02 w-4 h-4" />
                    {t().hytale?.installed || "Installed"}
                  </span>
                </Show>
              </div>
            )}
          </For>

          <button
            class="btn-secondary w-full flex items-center justify-center gap-2"
            onClick={installLanguagePack}
            disabled={installing()}
          >
            <Show when={installing()} fallback={<i class="i-hugeicons-upload-02 w-4 h-4" />}>
              <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
            </Show>
            {t().hytale?.installLanguage || "Install Language Pack..."}
          </button>

          <p class="text-xs text-gray-500">
            {t().hytale?.languageNote || "Download language packs from community sources and install here."}
          </p>
        </div>
      </section>

      {/* Logging & Diagnostics */}
      <section>
        <h3 class="text-lg font-semibold mb-4 flex items-center gap-2">
          <i class="i-hugeicons-bug-01 w-5 h-5 text-amber-400" />
          {t().hytale?.diagnostics || "Diagnostics"}
        </h3>

        <div class="space-y-4">
          {/* Verbose Logging */}
          <div class="flex items-center justify-between">
            <div>
              <div class="font-medium">{t().hytale?.verboseLogging || "Verbose Logging"}</div>
              <div class="text-sm text-gray-400">
                {t().hytale?.verboseLoggingDesc || "Enable detailed logging for troubleshooting"}
              </div>
            </div>
            <Toggle
              checked={settings().verbose_logging}
              onChange={(v) => updateSetting("verbose_logging", v)}
            />
          </div>

          {/* Open Logs Button */}
          <button
            class="btn-secondary flex items-center gap-2"
            onClick={openLogs}
          >
            <i class="i-hugeicons-folder-01 w-4 h-4" />
            {t().hytale?.openLogs || "Open Logs Folder"}
          </button>
        </div>
      </section>

      {/* Save Button */}
      <div class="flex justify-end pt-4 border-t border-gray-700">
        <button
          class="btn-primary flex items-center gap-2"
          onClick={saveSettings}
          disabled={saving()}
        >
          <Show when={saving()} fallback={<i class="i-hugeicons-floppy-disk w-4 h-4" />}>
            <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
          </Show>
          {t().common.save || "Save"}
        </button>
      </div>
    </div>
  );
}
