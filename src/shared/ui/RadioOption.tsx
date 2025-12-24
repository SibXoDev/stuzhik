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
}

export function RadioOption(props: RadioOptionProps) {
  return (
    <button
      type="button"
      class={`rounded-2xl border-2 transition-fast p-4 ${
        props.active
          ? "border-blue-500 bg-blue-500/10"
          : "border-gray-700 hover:border-gray-500 hover:bg-gray-alpha-50"
      } ${props.fullWidth ? "w-full" : ""}`}
      onClick={props.onClick}
    >
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-3">
          {/* Icon */}
          <Show
            when={typeof props.icon === "string"}
            fallback={<div class="text-2xl">{props.icon}</div>}
          >
            <span class="text-2xl">{props.icon as string}</span>
          </Show>

          {/* Text */}
          <div class="text-left">
            <div class="font-medium">{props.title}</div>
            <Show when={props.subtitle}>
              <div class="text-xs text-muted">{props.subtitle}</div>
            </Show>
          </div>
        </div>

        {/* Checkmark */}
        <Show when={props.active}>
          <div class="w-5 h-5 bg-blue-500 rounded-full flex-center flex-shrink-0">
            <i class="i-hugeicons-checkmark-circle-02 w-3 h-3 text-white" />
          </div>
        </Show>
      </div>
    </button>
  );
}
