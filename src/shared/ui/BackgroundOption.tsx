import { Show, type JSX } from "solid-js";

export interface BackgroundOptionProps {
  type: string;
  label: string;
  preview: JSX.Element;
  active: boolean;
  onClick: () => void;
}

export function BackgroundOption(props: BackgroundOptionProps) {
  return (
    <button
      type="button"
      class={`relative group overflow-hidden rounded-xl border-2 transition-fast aspect-video ${
        props.active
          ? "border-blue-500 bg-blue-500/10"
          : "border-gray-700 hover:border-gray-500"
      }`}
      onClick={props.onClick}
    >
      {/* Background preview */}
      <div class="absolute inset-0 bg-gray-950">
        {props.preview}
      </div>

      {/* Label */}
      <div class="absolute bottom-0 inset-x-0 p-2 bg-gradient-to-t from-black/80 to-transparent">
        <span class="text-xs font-medium">{props.label}</span>
      </div>

      {/* Checkmark for active state */}
      <Show when={props.active}>
        <div class="absolute top-1 right-1 w-4 h-4 bg-blue-500 rounded-full flex-center">
          <i class="i-hugeicons-checkmark-circle-02 w-2.5 h-2.5 text-white" />
        </div>
      </Show>
    </button>
  );
}
