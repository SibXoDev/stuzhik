import { createSignal, onMount, onCleanup, type JSX, Show } from "solid-js";

interface LazyPreviewProps {
  children: JSX.Element;
  placeholder?: JSX.Element;
  /** Keep rendered after first visibility (default: false for better performance) */
  keepAlive?: boolean;
}

/**
 * Lazy loading wrapper for heavy preview components (WebGL, etc.)
 * Renders children only when visible in viewport.
 * By default, unrenders when scrolled out of view to save GPU resources.
 */
export function LazyPreview(props: LazyPreviewProps) {
  const [isVisible, setIsVisible] = createSignal(false);
  let containerRef: HTMLDivElement | undefined;

  onMount(() => {
    if (!containerRef) return;

    // Use IntersectionObserver for efficient visibility detection
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;

        if (props.keepAlive) {
          // Keep alive mode: render once visible, never unrender
          if (entry.isIntersecting) {
            setIsVisible(true);
            observer.disconnect();
          }
        } else {
          // Default mode: render/unrender based on visibility
          // This saves GPU resources by stopping WebGL when not visible
          setIsVisible(entry.isIntersecting);
        }
      },
      {
        threshold: 0.1, // Trigger when 10% visible
        rootMargin: "100px", // Start loading slightly before visible
      }
    );

    observer.observe(containerRef);

    onCleanup(() => {
      observer.disconnect();
    });
  });

  return (
    <div ref={containerRef} class="w-full h-full">
      <Show
        when={isVisible()}
        fallback={
          props.placeholder || (
            <div class="w-full h-full bg-gray-900" />
          )
        }
      >
        {props.children}
      </Show>
    </div>
  );
}
