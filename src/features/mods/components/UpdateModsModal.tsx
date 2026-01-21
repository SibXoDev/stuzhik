import { For, Show, createSignal, createMemo } from "solid-js";
import type { Component } from "solid-js";
import type { Mod } from "../../../shared/types";
import { ModalWrapper } from "../../../shared/ui";
import { sanitizeImageUrl } from "../../../shared/utils/url-validator";
import { MarkdownRenderer, HtmlRenderer } from "../../../shared/components/MarkdownRenderer";
import { useI18n } from "../../../shared/i18n";

interface Props {
  modsWithUpdates: Mod[];
  onUpdate: (modIds: number[]) => Promise<void>;
  onClose: () => void;
  updating: boolean;
}

const UpdateModsModal: Component<Props> = (props) => {
  const { t } = useI18n();

  // Track which mods are selected for update (all selected by default)
  const [selectedModIds, setSelectedModIds] = createSignal<Set<number>>(
    new Set(props.modsWithUpdates.map(m => m.id))
  );

  // Track individual update progress
  const [currentlyUpdating, setCurrentlyUpdating] = createSignal<number | null>(null);
  const [updatedCount, setUpdatedCount] = createSignal(0);

  // Track expanded changelogs
  const [expandedChangelogs, setExpandedChangelogs] = createSignal<Set<number>>(new Set());

  const toggleMod = (modId: number) => {
    setSelectedModIds(prev => {
      const next = new Set(prev);
      if (next.has(modId)) {
        next.delete(modId);
      } else {
        next.add(modId);
      }
      return next;
    });
  };

  const toggleChangelog = (modId: number) => {
    setExpandedChangelogs(prev => {
      const next = new Set(prev);
      if (next.has(modId)) {
        next.delete(modId);
      } else {
        next.add(modId);
      }
      return next;
    });
  };

  const selectAll = () => {
    setSelectedModIds(new Set(props.modsWithUpdates.map(m => m.id)));
  };

  const deselectAll = () => {
    setSelectedModIds(new Set<number>());
  };

  const selectedCount = createMemo(() => selectedModIds().size);

  // Count mods with changelogs
  const modsWithChangelogs = createMemo(() =>
    props.modsWithUpdates.filter(m => m.latest_changelog).length
  );

  const handleUpdate = async () => {
    const ids = Array.from(selectedModIds());
    if (ids.length === 0) return;

    setUpdatedCount(0);

    // Update mods one by one with progress indicator
    for (const modId of ids) {
      setCurrentlyUpdating(modId);
      try {
        await props.onUpdate([modId]);
        setUpdatedCount(prev => prev + 1);
      } catch (e) {
        if (import.meta.env.DEV) {
          console.error(`Failed to update mod ${modId}:`, e);
        }
      }
    }

    setCurrentlyUpdating(null);
    props.onClose();
  };

  return (
    <ModalWrapper
      backdrop
      maxWidth="max-w-2xl"
      onBackdropClick={() => !props.updating && props.onClose()}
    >
      <div class="bg-gray-850 rounded-xl overflow-hidden">
        {/* Header */}
        <div class="flex items-center gap-3 px-5 py-4 border-b border-gray-700">
          <i class="i-hugeicons-download-02 w-6 h-6 text-blue-400" />
          <h3 class="text-lg font-medium text-white flex-1">
            {t().mods.updates.title}
          </h3>
          <button
            class="text-gray-400 hover:text-white transition-colors p-1"
            onClick={props.onClose}
            disabled={props.updating}
            aria-label={t().common.close}
          >
            <i class="i-hugeicons-cancel-01 w-5 h-5" />
          </button>
        </div>

        {/* Progress bar when updating */}
        <Show when={props.updating}>
          <div class="px-5 py-3 bg-blue-600/10 border-b border-blue-600/20">
            <div class="flex items-center gap-3 mb-2">
              <i class="i-svg-spinners-6-dots-scale w-4 h-4 text-blue-400" />
              <span class="text-sm text-blue-300">
                {t().mods.updates.updating} {updatedCount()}/{selectedCount()}
              </span>
            </div>
            <div class="h-1.5 bg-gray-700 rounded-full overflow-hidden">
              <div
                class="h-full bg-blue-500 transition-all duration-200"
                style={{ width: `${selectedCount() > 0 ? (updatedCount() / selectedCount()) * 100 : 0}%` }}
              />
            </div>
          </div>
        </Show>

        {/* Selection controls */}
        <div class="px-5 py-3 bg-gray-800/50 border-b border-gray-700 flex items-center justify-between">
          <span class="text-sm text-gray-400">
            {t().mods.updates.selected}: {selectedCount()} {t().mods.updates.of} {props.modsWithUpdates.length}
          </span>
          <div class="flex items-center gap-2">
            <button
              class="text-xs text-blue-400 hover:text-blue-300 transition-colors"
              onClick={selectAll}
              disabled={props.updating}
            >
              {t().mods.updates.selectAll}
            </button>
            <span class="text-gray-600">|</span>
            <button
              class="text-xs text-gray-400 hover:text-gray-300 transition-colors"
              onClick={deselectAll}
              disabled={props.updating}
            >
              {t().mods.updates.deselectAll}
            </button>
          </div>
        </div>

        {/* Mods list */}
        <div class="max-h-96 overflow-y-auto">
          <For each={props.modsWithUpdates}>
            {(mod) => {
              const isSelected = () => selectedModIds().has(mod.id);
              const isUpdating = () => currentlyUpdating() === mod.id;
              const isExpanded = () => expandedChangelogs().has(mod.id);
              const hasChangelog = () => !!mod.latest_changelog;
              const wasUpdated = () => {
                // Check if this mod was already updated in current session
                const ids = Array.from(selectedModIds());
                const modIdx = ids.indexOf(mod.id);
                return modIdx !== -1 && modIdx < updatedCount();
              };

              return (
                <div class="border-b border-gray-700/50">
                  <div
                    class={`flex items-center gap-3 px-5 py-3 transition-colors ${
                      isUpdating() ? "bg-blue-600/10" : wasUpdated() ? "bg-green-600/10" : "hover:bg-gray-800/50"
                    }`}
                  >
                    {/* Checkbox */}
                    <input
                      type="checkbox"
                      checked={isSelected()}
                      onChange={() => toggleMod(mod.id)}
                      disabled={props.updating}
                      class="w-4 h-4 rounded border-gray-600 bg-gray-800 checked:bg-blue-600 checked:border-blue-600 focus:ring-2 focus:ring-blue-600/50 cursor-pointer disabled:opacity-50"
                    />

                    {/* Icon */}
                    <Show when={sanitizeImageUrl(mod.icon_url)} fallback={
                      <div class="w-10 h-10 rounded-xl bg-gray-700 flex items-center justify-center flex-shrink-0">
                        <i class="i-hugeicons-package w-5 h-5 text-gray-500" />
                      </div>
                    }>
                      <img
                        src={sanitizeImageUrl(mod.icon_url)!}
                        alt={mod.name}
                        class="w-10 h-10 rounded-xl object-cover flex-shrink-0"
                        onError={(e) => {
                          e.currentTarget.style.display = "none";
                        }}
                      />
                    </Show>

                    {/* Info */}
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center gap-2">
                        <span class="font-medium text-white truncate">{mod.name}</span>
                        <Show when={isUpdating()}>
                          <i class="i-svg-spinners-6-dots-scale w-3.5 h-3.5 text-blue-400" />
                        </Show>
                        <Show when={wasUpdated()}>
                          <i class="i-hugeicons-checkmark-circle-02 w-4 h-4 text-green-400" />
                        </Show>
                      </div>
                      <div class="flex items-center gap-2 text-xs text-gray-400">
                        <span>{mod.version}</span>
                        <i class="i-hugeicons-arrow-right-01 w-3 h-3" />
                        <span class="text-green-400">{mod.latest_version}</span>
                      </div>
                    </div>

                    {/* Changelog toggle button */}
                    <Show when={hasChangelog()}>
                      <button
                        class={`flex items-center gap-1 text-xs px-2 py-1 rounded transition-colors ${
                          isExpanded()
                            ? "bg-blue-600/20 text-blue-400"
                            : "bg-gray-700/50 text-gray-400 hover:bg-gray-700 hover:text-gray-300"
                        }`}
                        onClick={() => toggleChangelog(mod.id)}
                        title={t().mods.updates.viewChangelog}
                      >
                        <i class={`w-3.5 h-3.5 transition-transform ${isExpanded() ? "i-hugeicons-arrow-up-01" : "i-hugeicons-arrow-down-01"}`} />
                        <span>{t().mods.updates.changelog}</span>
                      </button>
                    </Show>

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
                  </div>

                  {/* Expandable changelog */}
                  <Show when={isExpanded() && mod.latest_changelog}>
                    <div class="px-5 py-3 bg-gray-800/30 border-t border-gray-700/30">
                      <div class="text-xs text-gray-500 mb-2 flex items-center gap-1">
                        <i class="i-hugeicons-file-01 w-3.5 h-3.5" />
                        {t().mods.updates.changelogFor} {mod.latest_version}
                      </div>
                      <div class="max-h-48 overflow-y-auto text-sm bg-gray-900/50 rounded-lg p-3">
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
        </div>

        {/* Footer */}
        <div class="flex items-center justify-between px-5 py-4 border-t border-gray-700 bg-gray-800/50">
          <div class="flex flex-col gap-1">
            <p class="text-xs text-gray-500">
              {t().mods.updates.willUpdate}
            </p>
            <Show when={modsWithChangelogs() > 0}>
              <p class="text-xs text-gray-600">
                {modsWithChangelogs()} {t().mods.updates.withChangelogs}
              </p>
            </Show>
          </div>
          <div class="flex items-center gap-2">
            <button
              class="btn-secondary btn-sm"
              onClick={props.onClose}
              disabled={props.updating}
            >
              {t().common.cancel}
            </button>
            <button
              class="btn-primary btn-sm"
              onClick={handleUpdate}
              disabled={props.updating || selectedCount() === 0}
            >
              <Show when={props.updating} fallback={
                <>
                  <i class="i-hugeicons-download-02 w-4 h-4" />
                  {t().mods.updates.update} ({selectedCount()})
                </>
              }>
                <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                {t().mods.updates.updating}...
              </Show>
            </button>
          </div>
        </div>
      </div>
    </ModalWrapper>
  );
};

export default UpdateModsModal;
