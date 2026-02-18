import { Show } from "solid-js";

export interface ToggleProps {
  /** Current state */
  checked: boolean;
  /** Change handler */
  onChange: (checked: boolean) => void;
  /** Disabled state */
  disabled?: boolean;
  /** Loading state - shows spinner */
  loading?: boolean;
}

export function Toggle(props: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      disabled={props.disabled || props.loading}
      class={`relative group w-11 h-6 rounded-full transition-all duration-100 ${
        props.checked ? "" : "bg-gray-600"
      } ${props.disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
      style={props.checked ? { "background-color": "var(--color-primary)" } : undefined}
      onClick={() => !props.disabled && !props.loading && props.onChange(!props.checked)}
    >
      {/* Thumb with hover preview */}
      <div
        class={`absolute top-[50%] ${props.checked ? "right-1" : "left-1"} w-4 h-4 rounded-full bg-white transition-all duration-100 flex items-center justify-center shadow-sm`}
        style={{
          transform: `translateY(-50%)`
        }}
      >
        <Show when={props.loading}>
          <div class="i-svg-spinners-ring-resize w-3 h-3 text-gray-400" />
        </Show>
      </div>
    </button>
  );
}

export default Toggle;
