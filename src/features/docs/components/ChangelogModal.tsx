import { Component, For, onCleanup } from "solid-js";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ModalWrapper } from "../../../shared/ui/ModalWrapper";
import { useI18n } from "../../../shared/i18n";
import changelogData from "../../../changelog.json";

const LAST_VIEWED_VERSION_KEY = "stuzhik_last_viewed_changelog_version";

interface ChangelogChange {
  text: string;
  experimental?: boolean;
  type?: "new" | "fix" | "improvement" | "change";
}

interface ChangelogEntry {
  version: string;
  date: string;
  type: "feature" | "fix" | "improvement" | "breaking";
  changes: (string | ChangelogChange)[];
}

interface Props {
  onClose: () => void;
}

// Import changelog from JSON - single source of truth
const changelog: ChangelogEntry[] = changelogData as ChangelogEntry[];

const NEW_VERSION_BADGE_COLOR = "bg-blue-600/30 text-blue-300 border-blue-500/30";

const ChangelogModal: Component<Props> = (props) => {
  const { t } = useI18n();

  // Get last viewed version from localStorage
  const getLastViewedVersion = () => {
    try {
      return localStorage.getItem(LAST_VIEWED_VERSION_KEY) || null;
    } catch {
      return null;
    }
  };

  // Check if version is new (not yet viewed)
  const isNewVersion = (version: string, isLatest: boolean) => {
    const lastViewed = getLastViewedVersion();
    if (!lastViewed) return isLatest; // Only latest version is new if never viewed

    // Compare versions (simple string comparison works for x.y.z format)
    return version > lastViewed;
  };

  // Mark all versions as viewed when closing
  const markAsViewed = () => {
    try {
      const latestVersion = changelog[0]?.version;
      if (latestVersion) {
        localStorage.setItem(LAST_VIEWED_VERSION_KEY, latestVersion);
      }
    } catch (error) {
      console.warn("Failed to save last viewed version:", error);
    }
  };

  // Mark as viewed when closing
  onCleanup(() => {
    markAsViewed();
  });

  return (
    <ModalWrapper maxWidth="max-w-2xl">
      <div class="flex flex-col max-h-[80vh]">
        {/* Header */}
        <div class="flex items-center justify-between p-4 border-b border-gray-750 flex-shrink-0">
          <div class="flex items-center gap-3">
            <i class="i-hugeicons-git-branch w-5 h-5 text-blue-400" />
            <div>
              <h2 class="text-lg font-bold">{t().changelog?.title || "Changelog"}</h2>
              <span class="text-xs text-gray-500">{changelog.length} {t().changelog?.versions || "versions"}</span>
            </div>
          </div>
          <button
            class="btn-close"
            onClick={() => {
              markAsViewed();
              props.onClose();
            }}
            aria-label={t().ui?.tooltips?.close ?? "Close"}
          >
            <i class="i-hugeicons-cancel-01 w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div class="flex-1 overflow-y-auto min-h-0">
          <For each={changelog}>
            {(entry, index) => {
              const isFirst = index() === 0;
              const isLatest = index() === 0;

              return (
                <div class={`p-4 ${!isFirst ? "border-t border-gray-800" : ""}`}>
                        {/* Version Header */}
                        <div class="flex items-center gap-2 flex-wrap mb-3">
                          <span class="text-xl font-bold text-white">v{entry.version}</span>
                          {isNewVersion(entry.version, isLatest) && (
                            <span class={`px-2 py-0.5 text-xs rounded-full border ${NEW_VERSION_BADGE_COLOR}`}>
                              Новое
                            </span>
                          )}
                        </div>

                        {/* Changes List */}
                        <ul class="space-y-2 pl-7">
                          <For each={entry.changes}>
                            {(change) => {
                              const isExperimental = typeof change === "object" && change.experimental;
                              const text = typeof change === "string" ? change : change.text;
                              const changeType = typeof change === "object" ? change.type : undefined;

                              const getChangeIcon = () => {
                                if (isExperimental) return "i-hugeicons-alert-02 w-4 h-4 text-yellow-400";
                                switch (changeType) {
                                  case "new":
                                    return "i-hugeicons-star w-4 h-4 text-blue-400";
                                  case "fix":
                                    return "i-hugeicons-wrench-01 w-4 h-4 text-red-400";
                                  case "improvement":
                                    return "i-hugeicons-arrow-up-02 w-4 h-4 text-green-400";
                                  case "change":
                                    return "i-hugeicons-refresh w-4 h-4 text-orange-400";
                                  default:
                                    return "i-hugeicons-checkmark-circle-02 w-4 h-4 text-green-400";
                                }
                              };

                              return (
                                <li class="flex items-start gap-2">
                                  <i class={`${getChangeIcon()} flex-shrink-0 mt-0.5`} />
                                  <div class="flex flex-col gap-1.5 flex-1">
                                    {isExperimental && (
                                      <span class="px-2 py-0.5 rounded text-xs font-medium bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 w-fit">
                                        ЭКСПЕРИМЕНТАЛЬНО
                                      </span>
                                    )}
                                    <span class={`text-sm ${isExperimental ? "text-gray-400" : "text-gray-300"} break-words overflow-wrap-anywhere`}>
                                      {text}
                                    </span>
                                  </div>
                                </li>
                              );
                            }}
                          </For>
                        </ul>
                      </div>
              );
            }}
          </For>
        </div>

        {/* Footer */}
        <div class="p-4 border-t border-gray-750 flex-shrink-0">
          <div class="flex flex-col gap-2">
            <div class="flex flex-col sm:flex-row items-center justify-between gap-2 text-sm text-gray-500">
              <span class="flex items-center gap-2">
                <img src="/logo.png" alt="Stuzhik" class="w-5 h-5" />
                Стужик — сморожено в Сибири
              </span>
              <button
                class="flex items-center gap-1 text-gray-400 hover:text-white transition-colors"
                onClick={() => openUrl("https://github.com/SibXoDev/stuzhik/releases")}
              >
                <i class="i-hugeicons-github w-4 h-4" />
                {t().changelog?.allReleases || "All releases"}
              </button>
            </div>
            <div class="text-xs text-gray-600 text-center">
              {t().changelog?.madeIn || "Made in Russia"}
            </div>
          </div>
        </div>
      </div>
    </ModalWrapper>
  );
};

export default ChangelogModal;
