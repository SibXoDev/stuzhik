import { Component, createSignal, createMemo, For, Show, onMount, onCleanup } from "solid-js";
import { getVersion } from "@tauri-apps/api/app";
import { docSections } from "../data/sections";
import type { DocContentItem } from "../data/types";
import DocContent from "./DocContent";
import DocSearch from "./DocSearch";
import { useI18n } from "../../../shared/i18n";

interface Props {
  onClose: () => void;
  onOpenChangelog?: () => void;
  onOpenSourceCode?: (path?: string, line?: number) => void;
}

/**
 * Получить локализованный текст
 */
function getLocalizedText(t: () => Record<string, unknown>, key: string | undefined): string {
  if (!key || typeof key !== "string") return "";

  const parts = key.split(".");
  let current: unknown = t();

  for (const part of parts) {
    if (current && typeof current === "object" && part in current) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return key;
    }
  }

  return typeof current === "string" ? current : key;
}

/**
 * Определить модификатор клавиши для текущей ОС
 */
function getModKey(): string {
  const isMac = typeof navigator !== "undefined" && navigator.platform?.toLowerCase().includes("mac");
  return isMac ? "⌘" : "Ctrl";
}

const DocumentationPage: Component<Props> = (props) => {
  const { t } = useI18n();
  const modKey = getModKey();

  const [activeSectionId, setActiveSectionId] = createSignal("getting-started");
  const [activeSubsectionId, setActiveSubsectionId] = createSignal<string | null>("welcome");
  const [expandedSections, setExpandedSections] = createSignal<Set<string>>(new Set(["getting-started"]));
  const [showSearch, setShowSearch] = createSignal(false);
  const [appVersion, setAppVersion] = createSignal("...");
  const [searchQuery, setSearchQuery] = createSignal("");

  let contentRef: HTMLDivElement | undefined;

  onMount(async () => {
    try {
      const version = await getVersion();
      setAppVersion(version);
    } catch {
      setAppVersion("0.0.0");
    }
  });

  // Keyboard shortcut for search
  const handleKeyDown = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyK") {
      e.preventDefault();
      e.stopPropagation();
      setShowSearch(true);
    }
    // ESC закрывает поиск если открыт
    if (e.key === "Escape" && showSearch()) {
      e.preventDefault();
      e.stopPropagation();
      setShowSearch(false);
    }
  };

  onMount(() => {
    window.addEventListener("keydown", handleKeyDown);
  });

  onCleanup(() => {
    window.removeEventListener("keydown", handleKeyDown);
  });

  // Текущая активная секция
  const activeSection = createMemo(() =>
    docSections.find(s => s.id === activeSectionId())
  );

  // Текущая активная подсекция
  const activeSubsection = createMemo(() => {
    const section = activeSection();
    if (!section?.subsections || !activeSubsectionId()) return null;
    return section.subsections.find(s => s.id === activeSubsectionId());
  });

  // Контент для отображения
  const currentContent = createMemo<DocContentItem[]>(() => {
    const section = activeSection();
    if (!section) return [];

    // Если есть активная подсекция
    const subsection = activeSubsection();
    if (subsection) return subsection.content;

    // Если у секции есть контент без подсекций
    if (section.content) return section.content;

    // Если есть подсекции - показываем первую
    if (section.subsections && section.subsections.length > 0) {
      return section.subsections[0].content;
    }

    return [];
  });

  // Toggle секции в сайдбаре (только сворачивание/разворачивание)
  const toggleSection = (sectionId: string, e: MouseEvent) => {
    e.stopPropagation();
    const expanded = new Set(expandedSections());
    if (expanded.has(sectionId)) {
      expanded.delete(sectionId);
    } else {
      expanded.add(sectionId);
    }
    setExpandedSections(expanded);
  };

  // Навигация к секции/подсекции
  const navigateTo = (sectionId: string, subsectionId?: string | null) => {
    setActiveSectionId(sectionId);

    // Раскрыть секцию если закрыта
    if (!expandedSections().has(sectionId)) {
      const expanded = new Set(expandedSections());
      expanded.add(sectionId);
      setExpandedSections(expanded);
    }

    // Установить подсекцию
    if (subsectionId) {
      setActiveSubsectionId(subsectionId);
    } else {
      // Если не указана подсекция, установить первую или null
      const section = docSections.find(s => s.id === sectionId);
      if (section?.subsections && section.subsections.length > 0) {
        setActiveSubsectionId(section.subsections[0].id);
      } else {
        setActiveSubsectionId(null);
      }
    }

    // Scroll to top
    if (contentRef) {
      contentRef.scrollTop = 0;
    }
  };

  // Открыть исходный код
  const handleOpenSourceCode = (path: string, line?: number) => {
    props.onOpenSourceCode?.(path, line);
  };

  // Заголовок текущей секции/подсекции
  const currentTitle = createMemo(() => {
    const section = activeSection();
    if (!section) return "";

    const sectionTitle = getLocalizedText(t, section.titleKey);
    const subsection = activeSubsection();

    if (subsection) {
      return `${sectionTitle} → ${getLocalizedText(t, subsection.titleKey)}`;
    }

    // Если есть подсекции, показать первую
    if (section.subsections && section.subsections.length > 0 && !activeSubsectionId()) {
      return `${sectionTitle} → ${getLocalizedText(t, section.subsections[0].titleKey)}`;
    }

    return sectionTitle;
  });

  return (
    <>
      {/* Background behind TitleBar */}
      <div class="fixed top-0 left-0 right-0 h-[var(--titlebar-height)] bg-gray-900 border-b border-gray-800 z-50" />

      <div class="flex-1 flex min-h-0 bg-gray-950">
        {/* Sidebar */}
        <div class="w-72 flex-shrink-0 border-r border-gray-800 flex flex-col bg-gray-900">
          {/* Header */}
          <div class="p-4 border-b border-gray-800">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-3">
                <i class="i-hugeicons-book-01 w-6 h-6 text-blue-400" />
                <div>
                  <h2 class="text-lg font-bold">{getLocalizedText(t, "docs.title")}</h2>
                  <p class="text-xs text-gray-500">v{appVersion()}</p>
                </div>
              </div>
              <button class="btn-ghost p-1.5" onClick={props.onClose} title="Закрыть">
                <i class="i-hugeicons-cancel-01 w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Search */}
          <div class="border-b border-gray-800 flex items-center gap-2 p-2">
            <i class="i-hugeicons-search-01 w-4 h-4 text-gray-500 flex-shrink-0" />
            <input
              type="text"
              placeholder={`${getLocalizedText(t, "docs.search.placeholder")} (${modKey}+K)`}
              value={searchQuery()}
              onInput={(e) => setSearchQuery(e.currentTarget.value)}
              onFocus={() => setShowSearch(true)}
              class="flex-1 bg-transparent text-sm outline-none min-w-0"
            />
            <Show when={searchQuery()}>
              <button
                class="p-1 rounded text-gray-500 hover:text-gray-300 transition-colors flex-shrink-0"
                onClick={() => setSearchQuery("")}
                title="Очистить"
              >
                <i class="i-hugeicons-cancel-01 w-3.5 h-3.5" />
              </button>
            </Show>
          </div>

          {/* Navigation */}
          <nav class="flex-1 overflow-y-auto p-3">
            <For each={docSections}>
              {(section) => {
                const isActive = () => activeSectionId() === section.id;
                const isExpanded = () => expandedSections().has(section.id);
                const hasSubsections = section.subsections && section.subsections.length > 0;

                return (
                  <div class="mb-1">
                    {/* Section Header */}
                    <div
                      class={`w-full px-3 py-2 rounded-xl text-left flex items-center gap-2 transition-colors cursor-pointer ${
                        isActive()
                          ? "bg-blue-600/20 text-blue-400"
                          : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"
                      }`}
                      onClick={() => navigateTo(section.id)}
                    >
                      <i class={`${section.icon} w-4 h-4 flex-shrink-0`} />
                      <span class="text-sm flex-1 truncate">
                        {getLocalizedText(t, section.titleKey)}
                      </span>
                      <Show when={hasSubsections}>
                        <button
                          class="p-0.5 hover:bg-gray-700 rounded transition-colors"
                          onClick={(e) => toggleSection(section.id, e)}
                        >
                          <i class={`w-3 h-3 transition-transform ${
                            isExpanded() ? "i-hugeicons-arrow-down-01" : "i-hugeicons-arrow-right-01"
                          } text-gray-500`} />
                        </button>
                      </Show>
                    </div>

                    {/* Subsections */}
                    <Show when={hasSubsections && isExpanded()}>
                      <div class="ml-6 mt-1 space-y-0.5 border-l border-gray-800 pl-3">
                        <For each={section.subsections}>
                          {(subsection) => {
                            const isSubActive = () =>
                              isActive() && activeSubsectionId() === subsection.id;

                            return (
                              <button
                                class={`w-full px-2 py-1.5 rounded-lg text-left text-sm transition-colors ${
                                  isSubActive()
                                    ? "text-blue-400 bg-blue-600/10"
                                    : "text-gray-500 hover:text-gray-300 hover:bg-gray-800/50"
                                }`}
                                onClick={() => navigateTo(section.id, subsection.id)}
                              >
                                {getLocalizedText(t, subsection.titleKey)}
                              </button>
                            );
                          }}
                        </For>
                      </div>
                    </Show>
                  </div>
                );
              }}
            </For>
          </nav>

          {/* Footer */}
          <div class="p-3 border-t border-gray-800 space-y-2">
            <button class="btn-secondary w-full text-sm" onClick={props.onOpenChangelog}>
              <i class="i-hugeicons-git-branch w-4 h-4" />
              {getLocalizedText(t, "docs.changelog")}
            </button>
            <button
              class="btn-ghost w-full text-sm"
              onClick={() => props.onOpenSourceCode?.()}
            >
              <i class="i-hugeicons-source-code w-4 h-4" />
              {getLocalizedText(t, "docs.sourceCode")}
            </button>
          </div>
        </div>

        {/* Content */}
        <div class="flex-1 flex flex-col min-w-0 bg-gray-950">
          {/* Breadcrumb */}
          <div class="flex items-center gap-2 px-6 py-3 border-b border-gray-800 bg-gray-900/50 flex-shrink-0">
            <i class={`${activeSection()?.icon || "i-hugeicons-file-01"} w-4 h-4 text-blue-400 flex-shrink-0`} />
            <span class="text-sm text-gray-300 truncate">
              {currentTitle()}
            </span>
          </div>

          {/* Content Area */}
          <div ref={contentRef} class="flex-1 overflow-y-auto p-6">
            <div class="max-w-3xl mx-auto">
              {/* Section Title (for sections without subsections) */}
              <Show when={!activeSubsection() && activeSection()?.content}>
                <h2 class="text-2xl font-bold mb-6">
                  {getLocalizedText(t, activeSection()?.titleKey)}
                </h2>
              </Show>

              {/* Subsection Title */}
              <Show when={activeSubsection()}>
                <h2 class="text-2xl font-bold mb-6">
                  {getLocalizedText(t, activeSubsection()?.titleKey)}
                </h2>
              </Show>

              {/* First subsection title if no active subsection selected */}
              <Show when={
                !activeSubsectionId() &&
                activeSection()?.subsections &&
                activeSection()!.subsections!.length > 0 &&
                !activeSection()?.content
              }>
                <h2 class="text-2xl font-bold mb-6">
                  {getLocalizedText(t, activeSection()?.subsections?.[0]?.titleKey)}
                </h2>
              </Show>

              {/* Actual Content */}
              <DocContent
                items={currentContent()}
                onOpenSourceCode={handleOpenSourceCode}
                onNavigate={navigateTo}
              />

              {/* Navigation between subsections */}
              <Show when={activeSection()?.subsections && activeSection()!.subsections!.length > 1}>
                {(() => {
                  const section = activeSection()!;
                  const subsections = section.subsections!;
                  const currentIdx = subsections.findIndex(s =>
                    s.id === (activeSubsectionId() || subsections[0].id)
                  );
                  const prevSub = currentIdx > 0 ? subsections[currentIdx - 1] : null;
                  const nextSub = currentIdx < subsections.length - 1 ? subsections[currentIdx + 1] : null;

                  return (
                    <div class="flex items-center justify-between mt-12 pt-6 border-t border-gray-800">
                      <Show when={prevSub} fallback={<div />}>
                        <button
                          class="flex items-center gap-2 px-4 py-2 rounded-xl hover:bg-gray-800/50 transition-colors text-gray-400 hover:text-white"
                          onClick={() => navigateTo(section.id, prevSub!.id)}
                        >
                          <i class="i-hugeicons-arrow-left-01 w-4 h-4" />
                          <span class="text-sm">
                            {getLocalizedText(t, prevSub?.titleKey)}
                          </span>
                        </button>
                      </Show>
                      <Show when={nextSub}>
                        <button
                          class="flex items-center gap-2 px-4 py-2 rounded-xl hover:bg-gray-800/50 transition-colors text-gray-400 hover:text-white"
                          onClick={() => navigateTo(section.id, nextSub!.id)}
                        >
                          <span class="text-sm">
                            {getLocalizedText(t, nextSub?.titleKey)}
                          </span>
                          <i class="i-hugeicons-arrow-right-01 w-4 h-4" />
                        </button>
                      </Show>
                    </div>
                  );
                })()}
              </Show>
            </div>
          </div>
        </div>
      </div>

      {/* Search Modal */}
      <Show when={showSearch()}>
        <div
          class="fixed inset-0 z-50 flex items-start justify-center bg-black/60 backdrop-blur-sm pt-20"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowSearch(false);
          }}
        >
          <div class="w-full max-w-xl bg-gray-900 rounded-2xl border border-gray-800 shadow-2xl overflow-hidden">
            <DocSearch
              onNavigate={(sectionId, subsectionId) => {
                navigateTo(sectionId, subsectionId);
                setShowSearch(false);
              }}
              onClose={() => setShowSearch(false)}
            />
          </div>
        </div>
      </Show>
    </>
  );
};

export default DocumentationPage;
