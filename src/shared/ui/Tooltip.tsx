import { createSignal, Show, onCleanup, getOwner, runWithOwner, type JSX } from "solid-js";

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
  const [coords, setCoords] = createSignal({ x: 0, y: 0 });
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let triggerRef: HTMLDivElement | undefined;
  let tooltipRef: HTMLDivElement | undefined;
  const delay = props.delay ?? 300;
  const position = props.position ?? "top";
  const owner = getOwner();

  const updatePosition = () => {
    if (!triggerRef) return;
    const rect = triggerRef.getBoundingClientRect();
    const gap = 8;

    let x = 0;
    let y = 0;

    switch (position) {
      case "top":
        x = rect.left + rect.width / 2;
        y = rect.top - gap;
        break;
      case "bottom":
        x = rect.left + rect.width / 2;
        y = rect.bottom + gap;
        break;
      case "left":
        x = rect.left - gap;
        y = rect.top + rect.height / 2;
        break;
      case "right":
        x = rect.right + gap;
        y = rect.top + rect.height / 2;
        break;
    }

    setCoords({ x, y });
  };

  // Suppress tooltip briefly after pointerdown to prevent focusIn from re-showing it
  let suppressUntil = 0;

  const showTooltip = () => {
    if (Date.now() < suppressUntil) return;
    timeoutId = setTimeout(() => {
      if (Date.now() < suppressUntil) return;
      runWithOwner(owner, () => {
        updatePosition();
        setVisible(true);
      });
    }, delay);
  };

  const hideTooltip = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    setVisible(false);
  };

  // Dismiss tooltip on any click/tap and suppress re-show from focusIn
  const handleGlobalPointerDown = () => {
    suppressUntil = Date.now() + 400;
    hideTooltip();
  };
  document.addEventListener("pointerdown", handleGlobalPointerDown);

  onCleanup(() => {
    document.removeEventListener("pointerdown", handleGlobalPointerDown);
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  });

  const transformStyle = () => {
    switch (position) {
      case "top":
        return "translate(-50%, -100%)";
      case "bottom":
        return "translate(-50%, 0)";
      case "left":
        return "translate(-100%, -50%)";
      case "right":
        return "translate(0, -50%)";
      default:
        return "translate(-50%, -100%)";
    }
  };

  return (
    <div
      ref={triggerRef}
      class="inline-flex"
      onMouseEnter={showTooltip}
      onMouseLeave={hideTooltip}
      onFocusIn={showTooltip}
      onFocusOut={hideTooltip}
    >
      {props.children}
      <Show when={visible()}>
        <div
          ref={tooltipRef}
          class="fixed z-[9999] px-2 py-1 text-xs font-medium text-[var(--color-text)] bg-[var(--color-bg-elevated)] border border-[var(--color-border)] rounded-lg whitespace-nowrap pointer-events-none animate-fade-in"
          style={{
            left: `${coords().x}px`,
            top: `${coords().y}px`,
            transform: transformStyle(),
            "box-shadow": "var(--shadow-lg, 0 4px 12px rgba(0, 0, 0, 0.4))",
          }}
        >
          {props.text}
        </div>
      </Show>
    </div>
  );
}

export default Tooltip;
