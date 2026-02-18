import { For, Show, createSignal } from "solid-js";

export interface Tab {
  id: string;
  label: string;
  icon?: string;
  disabled?: boolean;
  badge?: string | number;
}

export interface TabsProps {
  tabs: Tab[];
  activeTab: string;
  onTabChange: (tabId: string) => void;
  class?: string;
  variant?: "default" | "pills" | "underline" | "sidebar";
  /** Show only icons on small screens (requires icon in tabs) */
  compact?: boolean;
  /** Accessible label for the tablist */
  "aria-label"?: string;
  /** Orientation hint for ARIA (auto-detected from variant) */
  orientation?: "horizontal" | "vertical";
}

export function Tabs(props: TabsProps) {
  const variant = () => props.variant || "default";
  const compact = () => props.compact || false;

  // Track which tab has focus for keyboard navigation
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_focusedIndex, setFocusedIndex] = createSignal(-1);

  // Get enabled tabs for keyboard navigation
  const enabledTabs = () => props.tabs.filter((tab) => !tab.disabled);

  const isVertical = () => props.orientation === "vertical" || variant() === "sidebar";

  const baseClasses = () => {
    // min-w-0 is CRITICAL - without it flex items won't shrink below content width
    // overflow-x-auto enables horizontal scroll when tabs don't fit
    // pb-1 adds space for scrollbar, -mb-1 compensates so layout doesn't shift
    switch (variant()) {
      case "pills":
        return "flex gap-1 p-1 bg-gray-800 rounded-xl min-w-0 overflow-x-auto pb-2 -mb-1";
      case "underline":
        return "flex gap-1 min-w-0 overflow-x-auto pb-2 -mb-1 flex-nowrap";
      case "sidebar":
        return "flex flex-col gap-0.5";
      default:
        return "flex gap-1 min-w-0 overflow-x-auto pb-2 -mb-1";
    }
  };

  const tabClasses = (tab: Tab) => {
    const isActive = props.activeTab === tab.id;
    const isDisabled = tab.disabled;
    // In compact mode, use smaller padding on small screens
    const padding = compact() ? "px-2 py-1.5 lg:px-4 lg:py-2" : "px-4 py-2";

    const focusRing = "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900";

    switch (variant()) {
      case "pills":
        return `${padding} text-sm font-medium rounded-lg transition-all ${focusRing} ${
          isActive
            ? "bg-[var(--color-primary)] text-white shadow-sm"
            : isDisabled
            ? "text-gray-600 cursor-not-allowed"
            : "text-gray-400 hover:text-gray-200 hover:bg-gray-700"
        }`;
      case "underline":
        return `${padding} text-sm font-medium transition-all border-b-2 ${focusRing} ${
          isActive
            ? "border-[var(--color-primary)] text-[var(--color-primary)]"
            : isDisabled
            ? "border-transparent text-gray-600 cursor-not-allowed"
            : "border-transparent text-gray-400 hover:text-gray-200 hover:border-gray-600"
        }`;
      case "sidebar":
        return `px-3 py-2 text-sm font-medium rounded-lg transition-all w-full text-left ${focusRing} ${
          isActive
            ? "bg-[var(--color-primary-bg)] text-[var(--color-primary)]"
            : isDisabled
            ? "text-gray-600 cursor-not-allowed"
            : "text-gray-400 hover:text-gray-200 hover:bg-gray-800"
        }`;
      default:
        return `${padding} text-sm font-medium rounded-xl transition-all ${focusRing} ${
          isActive
            ? "bg-gray-700 text-gray-200"
            : isDisabled
            ? "text-gray-600 cursor-not-allowed"
            : "text-gray-400 hover:text-gray-200 hover:bg-gray-800"
        }`;
    }
  };

  // Keyboard navigation handler
  const handleKeyDown = (e: KeyboardEvent, currentIndex: number) => {
    const enabled = enabledTabs();
    if (enabled.length === 0) return;

    let newIndex = -1;

    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown": {
        e.preventDefault();
        // Find next enabled tab
        const currentEnabledIndex = enabled.findIndex(
          (t) => t.id === props.tabs[currentIndex]?.id
        );
        newIndex = (currentEnabledIndex + 1) % enabled.length;
        break;
      }
      case "ArrowLeft":
      case "ArrowUp": {
        e.preventDefault();
        // Find previous enabled tab
        const currentEnabledIndex = enabled.findIndex(
          (t) => t.id === props.tabs[currentIndex]?.id
        );
        newIndex =
          currentEnabledIndex <= 0
            ? enabled.length - 1
            : currentEnabledIndex - 1;
        break;
      }
      case "Home": {
        e.preventDefault();
        newIndex = 0;
        break;
      }
      case "End": {
        e.preventDefault();
        newIndex = enabled.length - 1;
        break;
      }
      case "Enter":
      case " ": {
        e.preventDefault();
        const tab = props.tabs[currentIndex];
        if (tab && !tab.disabled) {
          props.onTabChange(tab.id);
        }
        return;
      }
      default:
        return;
    }

    if (newIndex >= 0 && newIndex < enabled.length) {
      const newTab = enabled[newIndex];
      // Find the actual index in props.tabs
      const actualIndex = props.tabs.findIndex((t) => t.id === newTab.id);
      setFocusedIndex(actualIndex);
      // Focus the button
      const buttons = document.querySelectorAll('[role="tab"]');
      const button = buttons[actualIndex] as HTMLButtonElement | undefined;
      button?.focus();
      // Optionally activate on focus (automatic activation)
      // props.onTabChange(newTab.id);
    }
  };

  return (
    <div
      class={`${baseClasses()} ${props.class || ""}`}
      role="tablist"
      aria-label={props["aria-label"]}
      aria-orientation={isVertical() ? "vertical" : "horizontal"}
    >
      <For each={props.tabs}>
        {(tab, index) => (
          <button
            type="button"
            role="tab"
            aria-selected={props.activeTab === tab.id}
            aria-disabled={tab.disabled}
            tabIndex={props.activeTab === tab.id ? 0 : -1}
            class={`${tabClasses(tab)} ${isVertical() ? "" : "flex-shrink-0 whitespace-nowrap"}`}
            onClick={() => !tab.disabled && props.onTabChange(tab.id)}
            onKeyDown={(e) => handleKeyDown(e, index())}
            onFocus={() => setFocusedIndex(index())}
            disabled={tab.disabled}
          >
            <div class="flex items-center gap-2">
              <Show when={tab.icon}>
                <i class={`${tab.icon} w-4 h-4`} aria-hidden="true" />
              </Show>
              <span class={props.compact ? "hidden lg:inline" : ""}>
                {tab.label}
              </span>
              <Show when={tab.badge !== undefined}>
                <span
                  class={`px-1.5 py-0.5 text-xs rounded-full min-w-[1.25rem] text-center ${
                    props.activeTab === tab.id && variant() === "pills"
                      ? "bg-white/20 text-white"
                      : "bg-[var(--color-primary-bg)] text-[var(--color-primary)]"
                  }`}
                  aria-label={`${tab.badge} items`}
                >
                  {tab.badge}
                </span>
              </Show>
            </div>
          </button>
        )}
      </For>
    </div>
  );
}

export default Tabs;
