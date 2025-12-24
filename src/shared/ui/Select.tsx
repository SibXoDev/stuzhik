import { createSignal, For, Show } from "solid-js";
import Dropdown from "./Dropdown";

export interface SelectOption {
  value: string;
  label: string;
  icon?: string;
  description?: string;
}

export interface SelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  class?: string;
  /** Maximum height of dropdown (e.g., "300px") */
  maxHeight?: string;
  /** Allow multiline text in options instead of truncating */
  multiline?: boolean;
}

export function Select(props: SelectProps) {
  const [open, setOpen] = createSignal(false);

  const selectedOption = () => props.options.find(o => o.value === props.value);

  const handleSelect = (value: string) => {
    props.onChange(value);
    setOpen(false);
  };

  const trigger = (
    <button
      type="button"
      class={`flex items-center justify-between w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-xl hover:border-gray-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-all text-sm ${
        props.disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
      } ${props.class || ""}`}
      disabled={props.disabled}
    >
      <div class="flex items-center gap-2 min-w-0">
        <Show when={selectedOption()?.icon}>
          <i class={`${selectedOption()!.icon} w-4 h-4 text-gray-400 flex-shrink-0`} />
        </Show>
        <span class={`${props.multiline ? "" : "truncate"} ${selectedOption() ? "text-gray-200" : "text-gray-500"}`}>
          {selectedOption()?.label || props.placeholder || "Select..."}
        </span>
      </div>
      <i class={`i-hugeicons-arrow-down-01 w-4 h-4 text-gray-400 flex-shrink-0 transition-transform duration-100 ${open() ? "rotate-180" : ""}`} />
    </button>
  );

  return (
    <Dropdown
      trigger={trigger}
      open={open()}
      onToggle={() => setOpen(!open())}
      onClose={() => setOpen(false)}
      disabled={props.disabled}
      maxHeight={props.maxHeight}
    >
      <div class="p-1 overflow-y-auto" style={{ "max-height": props.maxHeight || "400px" }}>
        <For each={props.options}>
          {(option) => (
            <button
              type="button"
              class={`dropdown-item w-full justify-between ${
                option.value === props.value
                  ? "bg-blue-600/15 text-blue-400"
                  : "text-gray-200"
              }`}
              onClick={() => handleSelect(option.value)}
            >
              <div class="flex items-center gap-3 min-w-0">
                <Show when={option.icon}>
                  <i class={`${option.icon} w-4 h-4 flex-shrink-0`} />
                </Show>
                <div class="flex flex-col min-w-0">
                  <span class={props.multiline ? "" : "truncate"}>{option.label}</span>
                  <Show when={option.description}>
                    <span class={`text-xs text-gray-500 ${props.multiline ? "" : "truncate"}`}>{option.description}</span>
                  </Show>
                </div>
              </div>
              <Show when={option.value === props.value}>
                <i class="i-hugeicons-checkmark-circle-02 w-4 h-4 text-blue-400 flex-shrink-0" />
              </Show>
            </button>
          )}
        </For>
      </div>
    </Dropdown>
  );
}

export default Select;
