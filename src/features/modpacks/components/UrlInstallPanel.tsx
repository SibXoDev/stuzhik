import { Accessor } from "solid-js";

interface UrlInstallPanelProps {
  urlInput: Accessor<string>;
  urlInstanceName: Accessor<string>;
  installing: Accessor<boolean>;
  onSetUrl: (url: string) => void;
  onSetInstanceName: (name: string) => void;
  onInstall: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: () => any;
}

export function UrlInstallPanel(props: UrlInstallPanelProps) {
  const t = () => props.t();

  return (
    <div class="card flex flex-col gap-4">
      <p class="text-sm text-muted">
        {t().modpacks.browser.url.description}
      </p>

      <div class="flex flex-wrap gap-2">
        <span class="badge bg-yellow-600/20 text-yellow-400 border-yellow-600/30">
          <i class="i-hugeicons-youtube w-3 h-3" />
          {t().modpacks.browser.url.yandexDisk}
        </span>
        <span class="badge bg-blue-600/20 text-blue-400 border-blue-600/30">
          <i class="i-hugeicons-google w-3 h-3" />
          {t().modpacks.browser.url.googleDrive}
        </span>
        <span class="badge bg-sky-600/20 text-sky-400 border-sky-600/30">
          <i class="i-hugeicons-cloud w-3 h-3" />
          {t().modpacks.browser.url.dropbox}
        </span>
        <span class="badge bg-gray-600/20 text-gray-400 border-gray-600/30">
          <i class="i-hugeicons-link-01 w-3 h-3" />
          {t().modpacks.browser.url.directLink}
        </span>
      </div>

      <label class="flex flex-col gap-1">
        <span class="text-sm text-muted">{t().modpacks.browser.url.modpackLink}</span>
        <input
          type="text"
          value={props.urlInput()}
          onInput={(e) => props.onSetUrl(e.currentTarget.value)}
          class="w-full"
          placeholder={t().ui.placeholders.cloudStorageUrl}
        />
      </label>

      <label class="flex flex-col gap-1">
        <span class="text-sm text-muted">{t().modpacks.browser.url.instanceName}</span>
        <input
          type="text"
          value={props.urlInstanceName()}
          onInput={(e) => props.onSetInstanceName(e.currentTarget.value)}
          class="w-full"
          placeholder={t().ui.placeholders.myModpack}
        />
      </label>

      <button
        class="btn w-full bg-cyan-600 hover:bg-cyan-500 text-white"
        onClick={props.onInstall}
        disabled={!props.urlInput() || !props.urlInstanceName() || props.installing()}
      >
        <i class="i-hugeicons-download-02 w-4 h-4" />
        {t().modpacks.browser.url.installByLink}
      </button>
    </div>
  );
}
