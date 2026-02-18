import { For, Show } from "solid-js";
import type { Component } from "solid-js";
import { useI18n } from "../i18n";

interface PaginationProps {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  /** Maximum number of page buttons to show (default: 7) */
  maxButtons?: number;
}

/**
 * Pagination component with page numbers
 * Shows: First | ... | pages around current | ... | Last
 */
const Pagination: Component<PaginationProps> = (props) => {
  const { t } = useI18n();
  const maxButtons = () => props.maxButtons || 7;

  // Generate array of page numbers to display
  const getPageNumbers = (): (number | "ellipsis-start" | "ellipsis-end")[] => {
    const total = props.totalPages;
    const current = props.currentPage;
    const max = maxButtons();

    if (total <= max) {
      // Show all pages
      return Array.from({ length: total }, (_, i) => i);
    }

    const pages: (number | "ellipsis-start" | "ellipsis-end")[] = [];

    // Always show first page
    pages.push(0);

    // Calculate range around current page
    const sideButtons = Math.floor((max - 3) / 2); // -3 for first, last, and at least one ellipsis
    let startPage = Math.max(1, current - sideButtons);
    let endPage = Math.min(total - 2, current + sideButtons);

    // Adjust if we're near the start
    if (current < sideButtons + 2) {
      endPage = Math.min(total - 2, max - 2);
    }

    // Adjust if we're near the end
    if (current > total - sideButtons - 3) {
      startPage = Math.max(1, total - max + 1);
    }

    // Add ellipsis before middle section if needed
    if (startPage > 1) {
      pages.push("ellipsis-start");
    }

    // Add middle pages
    for (let i = startPage; i <= endPage; i++) {
      pages.push(i);
    }

    // Add ellipsis after middle section if needed
    if (endPage < total - 2) {
      pages.push("ellipsis-end");
    }

    // Always show last page
    if (total > 1) {
      pages.push(total - 1);
    }

    return pages;
  };

  return (
    <Show when={props.totalPages > 1}>
      <nav class="flex items-center justify-center gap-1 flex-wrap" aria-label={t().ui?.tooltips?.pagination ?? "Pagination"}>
        {/* Previous button */}
        <button
          class="btn-ghost px-2 py-1.5 min-w-8"
          onClick={() => props.onPageChange(props.currentPage - 1)}
          disabled={props.currentPage === 0}
          title={t().ui?.tooltips?.previous ?? "Previous"}
          aria-label={t().ui?.tooltips?.previous ?? "Previous page"}
        >
          <i class="i-hugeicons-arrow-left-01 w-4 h-4" />
        </button>

        {/* Page numbers */}
        <For each={getPageNumbers()}>
          {(item) => (
            <>
              <Show when={typeof item === "number"} fallback={
                <span class="px-2 py-1.5 text-gray-500" aria-hidden="true">...</span>
              }>
                <button
                  class={`min-w-8 px-2 py-1.5 rounded-xl text-sm font-medium transition-colors duration-100 ${
                    item === props.currentPage
                      ? "bg-[var(--color-primary)] text-white"
                      : "btn-ghost"
                  }`}
                  onClick={() => props.onPageChange(item as number)}
                  aria-label={`${t().ui?.tooltips?.goToPage ?? "Go to page"} ${(item as number) + 1}`}
                  aria-current={item === props.currentPage ? "page" : undefined}
                >
                  {(item as number) + 1}
                </button>
              </Show>
            </>
          )}
        </For>

        {/* Next button */}
        <button
          class="btn-ghost px-2 py-1.5 min-w-8"
          onClick={() => props.onPageChange(props.currentPage + 1)}
          disabled={props.currentPage >= props.totalPages - 1}
          title={t().ui?.tooltips?.next ?? "Next"}
          aria-label={t().ui?.tooltips?.next ?? "Next page"}
        >
          <i class="i-hugeicons-arrow-right-01 w-4 h-4" />
        </button>
      </nav>
    </Show>
  );
};

export default Pagination;
