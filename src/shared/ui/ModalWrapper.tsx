import type { JSX } from "solid-js";
import { Show, createSignal } from "solid-js";

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
}

/**
 * Unified modal wrapper component
 * Positions content with titlebar offset
 *
 * When backdrop=false (default): no backdrop, uses shared backdrop from App.tsx
 * When backdrop=true: includes its own backdrop with optional click handler
 * When fullHeight=true: no scroll, content fills available height
 *
 * Note: Uses mousedown/mouseup tracking to prevent closing when user drags
 * inside the modal and releases outside (common in canvas/graph interactions)
 */
export function ModalWrapper(props: ModalWrapperProps) {
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

  const scrollClass = props.fullHeight ? "overflow-hidden" : "overflow-y-auto";

  const content = (
    <div
      class={`rounded-2xl shadow-2xl w-full ${props.maxWidth || "max-w-6xl"} max-h-full flex flex-col border border-gray-750 pointer-events-auto ${scrollClass} ${props.class || ""}`}
      style={{ "background-color": "#1a1b1f" }}
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
        class="fixed inset-0 z-50 pt-[var(--titlebar-height)] pb-4 px-4 flex items-center justify-center bg-black/60 backdrop-blur-sm"
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
      >
        {content}
      </div>
    </Show>
  );
}
