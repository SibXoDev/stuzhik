import { Show, type JSX } from "solid-js";

export interface RadioOptionProps {
  /** Icon (emoji or icon class) */
  icon: string | JSX.Element;
  /** Main title */
  title: string;
  /** Subtitle text */
  subtitle?: string;
  /** Is this option active? */
  active: boolean;
  /** Click handler */
  onClick: () => void;
  /** Optional: full width mode */
  fullWidth?: boolean;
  /** Optional action element (e.g. delete button) rendered next to checkmark */
  action?: JSX.Element;
  /** Accessible name for the radio option (defaults to title) */
  "aria-label"?: string;
}

/**
 * Radio option component for selection UI
 *
 * Accessibility features:
 * - role="radio" for screen readers
 * - aria-checked indicates selection state
 * - Focus visible ring for keyboard navigation
 *
 * Note: Should be wrapped in a container with role="radiogroup" for proper a11y
 */
export function RadioOption(props: RadioOptionProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.active}
      aria-label={props["aria-label"] || props.title}
      class={`rounded-2xl border-2 transition-fast p-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900 ${
        props.active
          ? "border-[var(--color-primary)] bg-[var(--color-primary-bg)]"
          : "border-gray-700 hover:border-gray-500 hover:bg-gray-alpha-50"
      } ${props.fullWidth ? "w-full" : ""}`}
      onClick={props.onClick}
    >
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-3">
          {/* Icon */}
          <Show
            when={typeof props.icon === "string"}
            fallback={
              <div class="text-2xl" aria-hidden="true">
                {props.icon}
              </div>
            }
          >
            <span class="text-2xl" aria-hidden="true">
              {props.icon as string}
            </span>
          </Show>

          {/* Text */}
          <div class="text-left">
            <div class="font-medium">{props.title}</div>
            <Show when={props.subtitle}>
              <div class="text-xs text-muted">{props.subtitle}</div>
            </Show>
          </div>
        </div>

        <div class="flex items-center gap-1.5 flex-shrink-0">
          {/* Action slot */}
          <Show when={props.action}>
            {props.action}
          </Show>

          {/* Checkmark */}
          <Show when={props.active}>
            <div
              class="w-5 h-5 bg-[var(--color-primary)] rounded-full flex-center"
              aria-hidden="true"
            >
              <i class="i-hugeicons-checkmark-circle-02 w-3 h-3 text-white" />
            </div>
          </Show>
        </div>
      </div>
    </button>
  );
}
