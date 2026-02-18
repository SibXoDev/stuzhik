import { onMount, onCleanup } from "solid-js";

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Creates a focus trap for a modal/dialog container.
 *
 * - On mount: saves active element, focuses first focusable child (or container)
 * - Tab/Shift+Tab: wraps focus within the container
 * - On cleanup: restores focus to previously active element
 *
 * Usage:
 *   let ref: HTMLDivElement | undefined;
 *   createFocusTrap(() => ref);
 *   <div ref={ref} tabIndex={-1}> ... </div>
 */
export function createFocusTrap(getRef: () => HTMLElement | undefined) {
  let previouslyFocused: Element | null = null;

  const getFocusable = (): HTMLElement[] => {
    const el = getRef();
    if (!el) return [];
    return Array.from(el.querySelectorAll(FOCUSABLE_SELECTOR));
  };

  const handleTab = (e: KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const focusable = getFocusable();
    if (focusable.length === 0) {
      e.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first || !getRef()?.contains(document.activeElement)) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last || !getRef()?.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  onMount(() => {
    previouslyFocused = document.activeElement;
    window.addEventListener("keydown", handleTab);

    requestAnimationFrame(() => {
      const focusable = getFocusable();
      if (focusable.length > 0) {
        focusable[0].focus();
      } else {
        getRef()?.focus();
      }
    });
  });

  onCleanup(() => {
    window.removeEventListener("keydown", handleTab);
    if (previouslyFocused instanceof HTMLElement) {
      previouslyFocused.focus();
    }
  });
}
