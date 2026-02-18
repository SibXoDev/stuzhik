import type { Accessor } from "solid-js";
import type { Settings } from "../../../shared/types";
import { Toggle, RangeSlider } from "../../../shared/ui";

interface Props {
  settings: Accessor<Settings>;
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  t: Accessor<Record<string, any>>;
}

export default function SettingsMods(props: Props) {
  const t = () => props.t();

  return (
    <>
      {/* Моды */}
      <fieldset>
        <legend class="text-base font-medium mb-4 inline-flex items-center gap-2">
          <i class="i-hugeicons-package w-5 h-5" />
          {t().settings.mods.title}
        </legend>
        <div class="space-y-3">
          <div class="flex items-center justify-between">
            <span class="text-sm">{t().settings.mods.autoUpdate}</span>
            <Toggle
              checked={props.settings().auto_update_mods}
              onChange={(checked) => props.updateSetting("auto_update_mods", checked)}
            />
          </div>
          <div class="flex items-center justify-between">
            <div>
              <span class="text-sm">{t().settings.mods.preferModrinth}</span>
              <div class="text-xs text-muted">{t().settings.mods.preferModrinthHint}</div>
            </div>
            <Toggle
              checked={props.settings().prefer_modrinth}
              onChange={(checked) => props.updateSetting("prefer_modrinth", checked)}
            />
          </div>
        </div>
      </fieldset>

      {/* Загрузки */}
      <fieldset>
        <legend class="text-base font-medium mb-4 inline-flex items-center gap-2">
          <i class="i-hugeicons-download-02 w-5 h-5" />
          {t().settings.downloads.title}
        </legend>
        <div class="space-y-4">
          <div>
            <label class="block text-sm font-medium mb-2">
              {t().settings.downloads.threads}: {props.settings().download_threads}
            </label>
            <RangeSlider
              value={props.settings().download_threads}
              onChange={(val) => props.updateSetting("download_threads", val)}
              min={1}
              max={8}
              step={1}
              showTicks
              showLabels
              formatLabel={(val) => String(val)}
            />
          </div>
          <div>
            <label class="block text-sm font-medium mb-2">
              {t().settings.downloads.maxConcurrent}: {props.settings().max_concurrent_downloads}
            </label>
            <RangeSlider
              value={props.settings().max_concurrent_downloads}
              onChange={(val) => props.updateSetting("max_concurrent_downloads", val)}
              min={1}
              max={16}
              step={1}
              showTicks
              showLabels
              formatLabel={(val) => String(val)}
            />
          </div>
          <div>
            <label class="block text-sm font-medium mb-2">
              {t().settings.downloads.bandwidthLimit}: {props.settings().bandwidth_limit === 0 ? "∞" : `${Math.round(props.settings().bandwidth_limit / 1_000_000)} MB/s`}
            </label>
            <RangeSlider
              value={Math.round(props.settings().bandwidth_limit / 1_000_000)}
              onChange={(val) => props.updateSetting("bandwidth_limit", val * 1_000_000)}
              min={0}
              max={100}
              step={1}
              showTicks
              showLabels
              ticks={[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]}
              formatLabel={(val) => val === 0 ? "∞" : `${val} MB/s`}
            />
          </div>
        </div>
      </fieldset>
    </>
  );
}
