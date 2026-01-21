import { For, Show, createSignal, createMemo } from "solid-js";
import type { Component } from "solid-js";
import type { Mod } from "../../../shared/types";
import { ModalWrapper } from "../../../shared/ui";
import { sanitizeImageUrl } from "../../../shared/utils/url-validator";
import { MarkdownRenderer, HtmlRenderer } from "../../../shared/components/MarkdownRenderer";
import { useI18n } from "../../../shared/i18n";

interface Props {
  /** List of mods that were updated (with latest_changelog populated) */
  updatedMods: Mod[];
  onClose: () => void;
}

/**
 * Modal that shows aggregated changelogs after updating mods.
 * Displays "What's New" summary for all updated mods.
 */
const ChangelogAggregatorModal: Component<Props> = (props) => {
  const { t } = useI18n();

  // Track which changelogs are expanded (all collapsed by default for quick overview)
  const [expandedMods, setExpandedMods] = createSignal<Set<number>>(new Set());

  // Filter mods that have changelogs
  const modsWithChangelogs = createMemo(() =>
    props.updatedMods.filter(m => m.latest_changelog)
  );

  const modsWithoutChangelogs = createMemo(() =>
    props.updatedMods.filter(m => !m.latest_changelog)
  );

  const toggleMod = (modId: number) => {
    setExpandedMods(prev => {
      const next = new Set(prev);
      if (next.has(modId)) {
        next.delete(modId);
      } else {
        next.add(modId);
      }
      return next;
    });
  };

  const expandAll = () => {
    setExpandedMods(new Set(modsWithChangelogs().map(m => m.id)));
  };

  const collapseAll = () => {
    setExpandedMods(new Set<number>());
  };

  return (
    <ModalWrapper
      backdrop
      maxWidth="max-w-3xl"
      onBackdropClick={props.onClose}
    >
      <div class="bg-gray-850 rounded-xl overflow-hidden">
        {/* Header */}
        <div class="flex items-center gap-3 px-5 py-4 border-b border-gray-700">
          <i class="i-hugeicons-news w-6 h-6 text-green-400" />
          <div class="flex-1">
            <h3 class="text-lg font-medium text-white">
              {t().mods.changelog.title}
            </h3>
            <p class="text-xs text-gray-400">
              {props.updatedMods.length} {t().mods.changelog.modsUpdated}
            </p>
          </div>
          <button
            class="text-gray-400 hover:text-white transition-colors p-1"
            onClick={props.onClose}
            aria-label={t().common.close}
          >
            <i class="i-hugeicons-cancel-01 w-5 h-5" />
          </button>
        </div>

        {/* Controls */}
        <Show when={modsWithChangelogs().length > 0}>
          <div class="px-5 py-2 bg-gray-800/50 border-b border-gray-700 flex items-center justify-between">
            <span class="text-sm text-gray-400">
              {modsWithChangelogs().length} {t().mods.changelog.withChangelogs}
            </span>
            <div class="flex items-center gap-2">
              <button
                class="text-xs text-blue-400 hover:text-blue-300 transition-colors"
                onClick={expandAll}
              >
                {t().mods.changelog.expandAll}
              </button>
              <span class="text-gray-600">|</span>
              <button
                class="text-xs text-gray-400 hover:text-gray-300 transition-colors"
                onClick={collapseAll}
              >
                {t().mods.changelog.collapseAll}
              </button>
            </div>
          </div>
        </Show>

        {/* Changelogs list */}
        <div class="max-h-[60vh] overflow-y-auto">
          {/* Mods with changelogs */}
          <For each={modsWithChangelogs()}>
            {(mod) => {
              const isExpanded = () => expandedMods().has(mod.id);

              return (
                <div class="border-b border-gray-700/50">
                  {/* Mod header - clickable to expand */}
                  <button
                    class="w-full flex items-center gap-3 px-5 py-3 hover:bg-gray-800/50 transition-colors text-left"
                    onClick={() => toggleMod(mod.id)}
                  >
                    {/* Expand/collapse indicator */}
                    <i class={`w-4 h-4 text-gray-500 transition-transform ${
                      isExpanded() ? "i-hugeicons-arrow-down-01" : "i-hugeicons-arrow-right-01"
                    }`} />

                    {/* Icon */}
                    <Show when={sanitizeImageUrl(mod.icon_url)} fallback={
                      <div class="w-8 h-8 rounded-lg bg-gray-700 flex items-center justify-center flex-shrink-0">
                        <i class="i-hugeicons-package w-4 h-4 text-gray-500" />
                      </div>
                    }>
                      <img
                        src={sanitizeImageUrl(mod.icon_url)!}
                        alt={mod.name}
                        class="w-8 h-8 rounded-lg object-cover flex-shrink-0"
                        onError={(e) => {
                          e.currentTarget.style.display = "none";
                        }}
                      />
                    </Show>

                    {/* Info */}
                    <div class="flex-1 min-w-0">
                      <span class="font-medium text-white truncate block">{mod.name}</span>
                      <div class="flex items-center gap-2 text-xs text-gray-400">
                        <span>{mod.version}</span>
                        <i class="i-hugeicons-arrow-right-01 w-3 h-3" />
                        <span class="text-green-400">{mod.latest_version}</span>
                      </div>
                    </div>

                    {/* Source badge */}
                    <div class={`flex items-center gap-1 text-xs px-2 py-1 rounded ${
                      mod.source === "modrinth"
                        ? "bg-green-600/20 text-green-400"
                        : mod.source === "curseforge"
                        ? "bg-orange-600/20 text-orange-400"
                        : "bg-gray-600/20 text-gray-400"
                    }`}>
                      <i class={
                        mod.source === "modrinth"
                          ? "i-simple-icons-modrinth w-3 h-3"
                          : mod.source === "curseforge"
                          ? "i-simple-icons-curseforge w-3 h-3"
                          : "i-hugeicons-folder-01 w-3 h-3"
                      } />
                    </div>
                  </button>

                  {/* Expanded changelog content */}
                  <Show when={isExpanded()}>
                    <div class="px-5 pb-4">
                      <div class="bg-gray-900/50 rounded-lg p-4 max-h-64 overflow-y-auto">
                        {/* Modrinth uses Markdown, CurseForge uses HTML */}
                        <Show
                          when={mod.source === "curseforge"}
                          fallback={
                            <MarkdownRenderer
                              content={mod.latest_changelog!}
                              class="prose prose-invert prose-sm max-w-none"
                            />
                          }
                        >
                          <HtmlRenderer
                            content={mod.latest_changelog!}
                            class="prose prose-invert prose-sm max-w-none"
                          />
                        </Show>
                      </div>
                    </div>
                  </Show>
                </div>
              );
            }}
          </For>

          {/* Mods without changelogs (collapsed section) */}
          <Show when={modsWithoutChangelogs().length > 0}>
            <div class="px-5 py-3 bg-gray-800/30">
              <div class="text-xs text-gray-500 mb-2">
                {t().mods.changelog.noChangelogAvailable} ({modsWithoutChangelogs().length})
              </div>
              <div class="flex flex-wrap gap-2">
                <For each={modsWithoutChangelogs()}>
                  {(mod) => (
                    <span class="inline-flex items-center gap-1 text-xs bg-gray-700/50 text-gray-400 px-2 py-1 rounded">
                      <Show when={sanitizeImageUrl(mod.icon_url)} fallback={
                        <i class="i-hugeicons-package w-3 h-3" />
                      }>
                        <img
                          src={sanitizeImageUrl(mod.icon_url)!}
                          alt={mod.name}
                          class="w-3 h-3 rounded"
                        />
                      </Show>
                      {mod.name}
                    </span>
                  )}
                </For>
              </div>
            </div>
          </Show>

          {/* Empty state */}
          <Show when={props.updatedMods.length === 0}>
            <div class="px-5 py-12 text-center">
              <i class="i-hugeicons-file-01 w-12 h-12 text-gray-600 mx-auto mb-3" />
              <p class="text-gray-400">{t().mods.changelog.noUpdates}</p>
            </div>
          </Show>
        </div>

        {/* Footer */}
        <div class="flex items-center justify-end px-5 py-4 border-t border-gray-700 bg-gray-800/50">
          <button
            class="btn-primary btn-sm"
            onClick={props.onClose}
          >
            <i class="i-hugeicons-checkmark-circle-02 w-4 h-4" />
            {t().common.close}
          </button>
        </div>
      </div>
    </ModalWrapper>
  );
};

export default ChangelogAggregatorModal;
