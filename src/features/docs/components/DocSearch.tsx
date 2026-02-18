import { Component, createSignal, createMemo, For, Show, onMount } from "solid-js";
import { docSections, getSectionSearchTerms } from "../data/sections";
import { useI18n } from "../../../shared/i18n";

interface SearchResult {
  sectionId: string;
  subsectionId?: string;
  sectionTitle: string;
  subsectionTitle?: string;
  icon: string;
  matchedText: string;
  score: number;
}

interface Props {
  onNavigate: (sectionId: string, subsectionId?: string) => void;
  onClose?: () => void;
}

/**
 * Нормализовать строку для поиска
 */
function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-zа-яё0-9\s]/gi, "");
}

/**
 * Получить локализованный текст
 */
function getLocalizedText(t: () => Record<string, unknown>, key: string): string {
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
 * Подсветить найденный текст
 */
function highlightMatch(text: string, query: string): { before: string; match: string; after: string } | null {
  const normalizedText = normalizeText(text);
  const normalizedQuery = normalizeText(query);

  const index = normalizedText.indexOf(normalizedQuery);
  if (index === -1) return null;

  // Найти соответствующую позицию в оригинальном тексте
  let originalIndex = 0;
  let normalizedIndex = 0;

  while (normalizedIndex < index && originalIndex < text.length) {
    const char = text[originalIndex].toLowerCase();
    if (/[a-zа-яё0-9\s]/i.test(char)) {
      normalizedIndex++;
    }
    originalIndex++;
  }

  const matchStart = originalIndex;
  let matchLength = 0;
  normalizedIndex = 0;

  while (normalizedIndex < query.length && originalIndex < text.length) {
    const char = text[originalIndex].toLowerCase();
    if (/[a-zа-яё0-9\s]/i.test(char)) {
      normalizedIndex++;
    }
    originalIndex++;
    matchLength++;
  }

  return {
    before: text.slice(0, matchStart),
    match: text.slice(matchStart, matchStart + matchLength),
    after: text.slice(matchStart + matchLength),
  };
}

const DocSearch: Component<Props> = (props) => {
  const { t } = useI18n();
  const [query, setQuery] = createSignal("");
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  let inputRef: HTMLInputElement | undefined;

  onMount(() => {
    inputRef?.focus();
  });

  // Поиск по документации
  const searchResults = createMemo<SearchResult[]>(() => {
    const q = query().trim();
    if (q.length < 2) return [];

    const normalizedQuery = normalizeText(q);
    const results: SearchResult[] = [];

    for (const section of docSections) {
      const sectionTitle = getLocalizedText(t, section.titleKey);
      const sectionTerms = getSectionSearchTerms(section);

      // Поиск по секции
      for (const term of sectionTerms) {
        const localizedTerm = getLocalizedText(t, term);
        if (normalizeText(localizedTerm).includes(normalizedQuery)) {
          // Добавляем результат только если такого еще нет
          const existing = results.find(r => r.sectionId === section.id && !r.subsectionId);
          if (!existing) {
            results.push({
              sectionId: section.id,
              sectionTitle,
              icon: section.icon,
              matchedText: localizedTerm,
              score: localizedTerm.toLowerCase().startsWith(q.toLowerCase()) ? 100 : 50,
            });
          }
          break;
        }
      }

      // Поиск по подсекциям
      if (section.subsections) {
        for (const subsection of section.subsections) {
          const subsectionTitle = getLocalizedText(t, subsection.titleKey);

          // Проверяем заголовок подсекции
          if (normalizeText(subsectionTitle).includes(normalizedQuery)) {
            results.push({
              sectionId: section.id,
              subsectionId: subsection.id,
              sectionTitle,
              subsectionTitle,
              icon: section.icon,
              matchedText: subsectionTitle,
              score: subsectionTitle.toLowerCase().startsWith(q.toLowerCase()) ? 90 : 40,
            });
            continue;
          }

          // Проверяем контент подсекции
          for (const item of subsection.content) {
            if (item.type === "paragraph" || item.type === "heading") {
              const text = getLocalizedText(t, item.text);
              if (normalizeText(text).includes(normalizedQuery)) {
                // Добавляем только если такой подсекции еще нет
                const existing = results.find(
                  r => r.sectionId === section.id && r.subsectionId === subsection.id
                );
                if (!existing) {
                  results.push({
                    sectionId: section.id,
                    subsectionId: subsection.id,
                    sectionTitle,
                    subsectionTitle,
                    icon: section.icon,
                    matchedText: text.length > 100 ? text.slice(0, 100) + "..." : text,
                    score: 30,
                  });
                }
                break;
              }
            }
          }
        }
      }
    }

    // Сортировка по релевантности
    return results.sort((a, b) => b.score - a.score).slice(0, 10);
  });

  // Обработка клавиатуры
  const handleKeyDown = (e: KeyboardEvent) => {
    const results = searchResults();

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelectedIndex(i => Math.min(i + 1, results.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIndex(i => Math.max(i - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        if (results[selectedIndex()]) {
          const result = results[selectedIndex()];
          props.onNavigate(result.sectionId, result.subsectionId);
          props.onClose?.();
        }
        break;
      case "Escape":
        e.preventDefault();
        props.onClose?.();
        break;
    }
  };

  // Сброс индекса при изменении результатов
  createMemo(() => {
    searchResults();
    setSelectedIndex(0);
  });

  return (
    <div>
      {/* Search Input */}
      <div class="flex items-center gap-2 px-4 py-3 border-b border-gray-800">
        <i class="i-hugeicons-search-01 w-5 h-5 text-gray-500" />
        <input
          ref={inputRef}
          type="text"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
          placeholder={getLocalizedText(t, "docs.search.placeholder")}
          class="flex-1 bg-transparent text-base outline-none placeholder:text-gray-600"
        />
        <Show when={query()}>
          <button
            class="p-1 rounded text-gray-500 hover:text-gray-300 transition-colors"
            onClick={() => setQuery("")}
          >
            <i class="i-hugeicons-cancel-01 w-4 h-4" />
          </button>
        </Show>
        <kbd class="px-2 py-0.5 bg-gray-800 rounded text-xs font-mono text-gray-500">Esc</kbd>
      </div>

      {/* Results */}
      <div class="max-h-80 overflow-y-auto">
        <Show when={query().length >= 2}>
          <Show when={searchResults().length > 0} fallback={
            <div class="flex-col-center gap-2 py-8 text-gray-500">
              <i class="i-hugeicons-search-01 w-8 h-8 opacity-30" />
              <p class="text-sm">{getLocalizedText(t, "docs.search.noResults")}</p>
            </div>
          }>
            <For each={searchResults()}>
              {(result, index) => {
                const highlight = highlightMatch(result.matchedText, query());

                return (
                  <button
                    class={`w-full px-4 py-3 text-left flex items-center gap-3 transition-colors ${
                      index() === selectedIndex()
                        ? "bg-[var(--color-primary-bg)] text-[var(--color-primary)]"
                        : "hover:bg-gray-800/50"
                    }`}
                    onClick={() => {
                      props.onNavigate(result.sectionId, result.subsectionId);
                      props.onClose?.();
                    }}
                    onMouseEnter={() => setSelectedIndex(index())}
                  >
                    <i class={`${result.icon} w-5 h-5 flex-shrink-0 ${
                      index() === selectedIndex() ? "text-[var(--color-primary)]" : "text-gray-500"
                    }`} />
                    <div class="flex-1 min-w-0 flex flex-col gap-0.5">
                      <div class="flex items-center gap-2">
                        <span class="font-medium text-sm">{result.sectionTitle}</span>
                        <Show when={result.subsectionTitle}>
                          <i class="i-hugeicons-arrow-right-01 w-3 h-3 text-gray-600" />
                          <span class="text-sm text-gray-400">{result.subsectionTitle}</span>
                        </Show>
                      </div>
                      <Show when={highlight}>
                        <p class="text-xs text-gray-500 truncate">
                          {highlight!.before}
                          <span class="text-[var(--color-primary)] font-medium">{highlight!.match}</span>
                          {highlight!.after}
                        </p>
                      </Show>
                    </div>
                    <i class="i-hugeicons-arrow-right-01 w-4 h-4 text-gray-600" />
                  </button>
                );
              }}
            </For>
          </Show>
        </Show>

        <Show when={query().length === 0}>
          {/* Quick Links when no query */}
          <div class="p-4">
            <p class="text-xs text-gray-500 mb-3 uppercase tracking-wide">
              {getLocalizedText(t, "docs.search.quickLinks")}
            </p>
            <div class="space-y-1">
              <For each={docSections.slice(0, 5)}>
                {(section) => (
                  <button
                    class="w-full px-3 py-2 text-left flex items-center gap-3 rounded-lg hover:bg-gray-800/50 transition-colors"
                    onClick={() => {
                      props.onNavigate(section.id);
                      props.onClose?.();
                    }}
                  >
                    <i class={`${section.icon} w-4 h-4 text-gray-500`} />
                    <span class="text-sm text-gray-400">
                      {getLocalizedText(t, section.titleKey)}
                    </span>
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>
      </div>

      {/* Footer */}
      <div class="px-4 py-2 border-t border-gray-800 flex items-center justify-between text-xs text-gray-600">
        <div class="flex items-center gap-3">
          <span class="flex items-center gap-1">
            <kbd class="px-1.5 py-0.5 bg-gray-800 rounded font-mono">↑↓</kbd>
            {getLocalizedText(t, "docs.search.navigate")}
          </span>
          <span class="flex items-center gap-1">
            <kbd class="px-1.5 py-0.5 bg-gray-800 rounded font-mono">Enter</kbd>
            {getLocalizedText(t, "docs.search.select")}
          </span>
        </div>
      </div>
    </div>
  );
};

export default DocSearch;
