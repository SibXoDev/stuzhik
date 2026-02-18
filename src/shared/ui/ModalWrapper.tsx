import type { JSX } from "solid-js";
import { Show, createSignal, onMount, onCleanup } from "solid-js";

export interface ModalWrapperProps {
  children: JSX.Element;
  /** Max width class (e.g., "max-w-6xl", "max-w-4xl") */
  maxWidth?: string;
  /** Additional classes for the modal content */
  class?: string;
  /** Show backdrop overlay (default: false - uses shared backdrop from App.tsx) */
  backdrop?: boolean;
  /** Callback when backdrop is clicked (only works when backdrop=true) */
  onBackdropClick?: () => void;
  /** Disable scroll and use full available height (for canvas/graph content) */
  fullHeight?: boolean;
  /** Callback when Escape key is pressed */
  onEscape?: () => void;
  /** ID of the element that labels this dialog (for aria-labelledby) */
  labelledBy?: string;
  /** Accessible label for the dialog */
  "aria-label"?: string;
}

/**
 * Unified modal wrapper component
 * Positions content with titlebar offset
 *
 * When backdrop=false (default): no backdrop, uses shared backdrop from App.tsx
 * When backdrop=true: includes its own backdrop with optional click handler
 * When fullHeight=true: no scroll, content fills available height
 *
 * Accessibility features:
 * - role="dialog" and aria-modal="true"
 * - Focus trap: focus stays within the modal
 * - Escape key support via onEscape callback
 * - aria-labelledby/aria-label for screen readers
 *
 * Note: Uses mousedown/mouseup tracking to prevent closing when user drags
 * inside the modal and releases outside (common in canvas/graph interactions)
 */
export function ModalWrapper(props: ModalWrapperProps) {
  let contentRef: HTMLDivElement | undefined;
  let previouslyFocusedElement: Element | null = null;

  // Track if mousedown started on backdrop (not inside content)
  const [mouseDownOnBackdrop, setMouseDownOnBackdrop] = createSignal(false);

  const handleMouseDown = (e: MouseEvent) => {
    // Only set true if mousedown is directly on backdrop (not on content)
    setMouseDownOnBackdrop(e.target === e.currentTarget);
  };

  const handleMouseUp = (e: MouseEvent) => {
    // Only close if BOTH mousedown AND mouseup happened on backdrop
    if (
      mouseDownOnBackdrop() &&
      e.target === e.currentTarget &&
      props.onBackdropClick
    ) {
      props.onBackdropClick();
    }
    setMouseDownOnBackdrop(false);
  };

  // Handle Escape key
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && props.onEscape) {
      e.preventDefault();
      e.stopPropagation();
      props.onEscape();
    }
  };

  // Focus trap - get all focusable elements
  const getFocusableElements = () => {
    if (!contentRef) return [];
    return Array.from(
      contentRef.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ) as HTMLElement[];
  };

  // Handle Tab key for focus trap
  const handleTabKey = (e: KeyboardEvent) => {
    if (e.key !== "Tab") return;

    const focusable = getFocusableElements();
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (e.shiftKey) {
      // Shift+Tab: if on first element, go to last
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      // Tab: if on last element, go to first
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  onMount(() => {
    // Save currently focused element to restore later
    previouslyFocusedElement = document.activeElement;

    // Add keyboard listeners
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keydown", handleTabKey);

    // Focus the first focusable element or the content itself
    requestAnimationFrame(() => {
      const focusable = getFocusableElements();
      if (focusable.length > 0) {
        focusable[0].focus();
      } else if (contentRef) {
        contentRef.focus();
      }
    });
  });

  onCleanup(() => {
    window.removeEventListener("keydown", handleKeyDown);
    window.removeEventListener("keydown", handleTabKey);

    // Restore focus to previously focused element
    if (previouslyFocusedElement instanceof HTMLElement) {
      previouslyFocusedElement.focus();
    }
  });

  const scrollClass = props.fullHeight ? "overflow-hidden" : "overflow-y-auto";

  const content = (
    <div
      ref={contentRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={props.labelledBy}
      aria-label={props["aria-label"]}
      tabIndex={-1}
      class={`rounded-2xl shadow-2xl w-full ${props.maxWidth || "max-w-6xl"} max-h-full flex flex-col border border-[var(--color-border)] pointer-events-auto focus:outline-none bg-[var(--color-bg-modal)] ${scrollClass} ${props.class || ""}`}
      onClick={(e) => e.stopPropagation()}
    >
      {props.children}
    </div>
  );

  return (
    <Show
      when={props.backdrop}
      fallback={
        <div class="fixed inset-0 z-50 pt-[var(--titlebar-height)] pb-4 px-4 flex items-center justify-center pointer-events-none">
          {content}
        </div>
      }
    >
      <div
        class="fixed inset-0 z-50 pt-[var(--titlebar-height)] pb-4 px-4 flex items-center justify-center bg-black/30 backdrop-blur-lg"
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        aria-hidden="true"
      >
        {content}
      </div>
    </Show>
  );
}
