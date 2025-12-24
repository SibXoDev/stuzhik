import { createSignal, Show, onCleanup, type JSX } from "solid-js";

export interface TooltipProps {
  /** Text to display in tooltip */
  text: string;
  /** Content to wrap with tooltip */
  children: JSX.Element;
  /** Position of tooltip */
  position?: "top" | "bottom" | "left" | "right";
  /** Delay before showing tooltip (ms) */
  delay?: number;
}

export function Tooltip(props: TooltipProps) {
  const [visible, setVisible] = createSignal(false);
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const delay = props.delay ?? 300;
  const position = props.position ?? "top";

  const showTooltip = () => {
    timeoutId = setTimeout(() => setVisible(true), delay);
  };

  const hideTooltip = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    setVisible(false);
  };

  onCleanup(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  });

  const positionClasses = () => {
    switch (position) {
      case "top":
        return "bottom-full left-1/2 -translate-x-1/2 mb-2";
      case "bottom":
        return "top-full left-1/2 -translate-x-1/2 mt-2";
      case "left":
        return "right-full top-1/2 -translate-y-1/2 mr-2";
      case "right":
        return "left-full top-1/2 -translate-y-1/2 ml-2";
      default:
        return "bottom-full left-1/2 -translate-x-1/2 mb-2";
    }
  };

  return (
    <div
      class="inline-flex"
      onMouseEnter={showTooltip}
      onMouseLeave={hideTooltip}
      onFocusIn={showTooltip}
      onFocusOut={hideTooltip}
    >
      {props.children}
      <Show when={visible()}>
        <div
          class={`absolute z-[100] px-2 py-1 text-xs font-medium text-white bg-gray-900 rounded-lg whitespace-nowrap pointer-events-none animate-fade-in ${positionClasses()}`}
          style={{ "box-shadow": "0 4px 12px rgba(0, 0, 0, 0.4)" }}
        >
          {props.text}
        </div>
      </Show>
    </div>
  );
}

export default Tooltip;
