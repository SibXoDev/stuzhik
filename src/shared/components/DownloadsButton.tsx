import { Show } from "solid-js";
import { useDownloads } from "../hooks/useDownloads";
import { useI18n } from "../i18n";

export default function DownloadsButton() {
  const { t } = useI18n();
  const { activeDownloads, setShowDownloadsPanel } = useDownloads();

  const count = () => activeDownloads().length;

  return (
    <Show when={count() > 0}>
      <button
        class="p-1.5 flex items-center justify-center rounded-2xl bg-transparent border-none outline-none cursor-pointer text-gray-400 hover:text-white hover:bg-white/10 transition-colors duration-75"
        onClick={() => setShowDownloadsPanel(true)}
        title={t().titleBar.downloads}
        aria-label={t().titleBar.downloads}
      >
        <i class="i-svg-spinners-6-dots-scale w-4 h-4 text-blue-400" />

        {/* Badge with count */}
        <div class="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 bg-blue-600 rounded-full flex items-center justify-center z-10">
          <span class="text-[10px] font-bold text-white">{count() > 99 ? "99+" : count()}</span>
        </div>
      </button>
    </Show>
  );
}
