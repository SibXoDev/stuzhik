import type { JSX } from "solid-js";
import { Show } from "solid-js";

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
}

/**
 * Unified modal wrapper component
 * Positions content with titlebar offset
 *
 * When backdrop=false (default): no backdrop, uses shared backdrop from App.tsx
 * When backdrop=true: includes its own backdrop with optional click handler
 */
export function ModalWrapper(props: ModalWrapperProps) {
  const handleBackdropClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget && props.onBackdropClick) {
      props.onBackdropClick();
    }
  };

  const content = (
    <div
      class={`rounded-2xl shadow-2xl w-full ${props.maxWidth || "max-w-6xl"} max-h-full flex flex-col border border-gray-750 pointer-events-auto overflow-y-auto ${props.class || ""}`}
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
        onClick={handleBackdropClick}
      >
        {content}
      </div>
    </Show>
  );
}
