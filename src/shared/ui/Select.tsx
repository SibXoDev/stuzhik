import { createSignal, For, Show, onCleanup, createEffect } from "solid-js";
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
  /** aria-label for accessibility */
  ariaLabel?: string;
}

export function Select(props: SelectProps) {
  const [open, setOpen] = createSignal(false);
  const [focusedIndex, setFocusedIndex] = createSignal(-1);
  const [typeaheadQuery, setTypeaheadQuery] = createSignal("");
  let typeaheadTimeout: ReturnType<typeof setTimeout> | null = null;
  let triggerRef: HTMLButtonElement | undefined;
  let optionRefs: (HTMLButtonElement | undefined)[] = [];

  const selectedOption = () => props.options.find(o => o.value === props.value);
  const selectedIndex = () => props.options.findIndex(o => o.value === props.value);

  const handleSelect = (value: string) => {
    props.onChange(value);
    setOpen(false);
    triggerRef?.focus();
  };

  // Reset focused index when opening/closing
  createEffect(() => {
    if (open()) {
      // Focus on currently selected item when opening
      const idx = selectedIndex();
      setFocusedIndex(idx >= 0 ? idx : 0);
    } else {
      setFocusedIndex(-1);
    }
  });

  // Scroll focused option into view
  createEffect(() => {
    const idx = focusedIndex();
    if (idx >= 0 && optionRefs[idx]) {
      optionRefs[idx]?.scrollIntoView({ block: "nearest" });
    }
  });

  const handleKeyDown = (e: KeyboardEvent) => {
    if (props.disabled) return;

    const opts = props.options;
    const currentFocus = focusedIndex();

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (!open()) {
          setOpen(true);
        } else {
          setFocusedIndex(Math.min(currentFocus + 1, opts.length - 1));
        }
        break;

      case "ArrowUp":
        e.preventDefault();
        if (!open()) {
          setOpen(true);
        } else {
          setFocusedIndex(Math.max(currentFocus - 1, 0));
        }
        break;

      case "Enter":
      case " ":
        e.preventDefault();
        if (!open()) {
          setOpen(true);
        } else if (currentFocus >= 0 && currentFocus < opts.length) {
          handleSelect(opts[currentFocus].value);
        }
        break;

      case "Escape":
        e.preventDefault();
        setOpen(false);
        triggerRef?.focus();
        break;

      case "Home":
        e.preventDefault();
        if (open()) {
          setFocusedIndex(0);
        }
        break;

      case "End":
        e.preventDefault();
        if (open()) {
          setFocusedIndex(opts.length - 1);
        }
        break;

      case "Tab":
        // Allow tab to close dropdown and move focus naturally
        if (open()) {
          setOpen(false);
        }
        break;

      default:
        // Type-ahead search - match by first character(s)
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          handleTypeahead(e.key);
        }
        break;
    }
  };

  // Type-ahead functionality
  const handleTypeahead = (char: string) => {
    // Clear previous timeout
    if (typeaheadTimeout) {
      clearTimeout(typeaheadTimeout);
    }

    // Build query
    const newQuery = typeaheadQuery() + char.toLowerCase();
    setTypeaheadQuery(newQuery);

    // Find matching option
    const opts = props.options;
    const startIndex = focusedIndex() >= 0 ? focusedIndex() : 0;

    // Search from current position first, then wrap around
    let foundIndex = -1;
    for (let i = 0; i < opts.length; i++) {
      const searchIndex = (startIndex + i) % opts.length;
      const label = opts[searchIndex].label.toLowerCase();
      if (label.startsWith(newQuery)) {
        foundIndex = searchIndex;
        break;
      }
    }

    // If single char and no match, try just that character from next item
    if (foundIndex === -1 && newQuery.length > 1) {
      for (let i = 0; i < opts.length; i++) {
        const searchIndex = (startIndex + i + 1) % opts.length;
        const label = opts[searchIndex].label.toLowerCase();
        if (label.startsWith(char.toLowerCase())) {
          foundIndex = searchIndex;
          setTypeaheadQuery(char.toLowerCase());
          break;
        }
      }
    }

    if (foundIndex >= 0) {
      if (!open()) {
        setOpen(true);
      }
      setFocusedIndex(foundIndex);
    }

    // Clear query after timeout
    typeaheadTimeout = setTimeout(() => {
      setTypeaheadQuery("");
    }, 500);
  };

  // Cleanup timeout on unmount
  onCleanup(() => {
    if (typeaheadTimeout) {
      clearTimeout(typeaheadTimeout);
    }
  });

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      role="combobox"
      aria-haspopup="listbox"
      aria-expanded={open()}
      aria-label={props.ariaLabel}
      aria-activedescendant={focusedIndex() >= 0 ? `select-option-${focusedIndex()}` : undefined}
      class={`flex items-center justify-between w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-xl hover:border-gray-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-all text-sm ${
        props.disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
      } ${props.class || ""}`}
      disabled={props.disabled}
      onKeyDown={handleKeyDown}
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
      <div
        role="listbox"
        class="p-1 overflow-y-auto"
        style={{ "max-height": props.maxHeight || "400px" }}
      >
        <For each={props.options}>
          {(option, index) => (
            <button
              ref={(el) => { optionRefs[index()] = el; }}
              id={`select-option-${index()}`}
              type="button"
              role="option"
              aria-selected={option.value === props.value}
              class={`dropdown-item w-full justify-between ${
                option.value === props.value
                  ? "bg-blue-600/15 text-blue-400"
                  : focusedIndex() === index()
                    ? "bg-gray-700/50 text-gray-200"
                    : "text-gray-200"
              }`}
              onClick={() => handleSelect(option.value)}
              onMouseEnter={() => setFocusedIndex(index())}
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
