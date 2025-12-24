import { For, Show } from "solid-js";

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
  variant?: "default" | "pills" | "underline";
}

export function Tabs(props: TabsProps) {
  const variant = () => props.variant || "default";

  const baseClasses = () => {
    switch (variant()) {
      case "pills":
        return "flex gap-1 p-1 bg-gray-800 rounded-xl";
      case "underline":
        return "flex gap-1";
      default:
        return "flex gap-1";
    }
  };

  const tabClasses = (tab: Tab) => {
    const isActive = props.activeTab === tab.id;
    const isDisabled = tab.disabled;

    switch (variant()) {
      case "pills":
        return `px-4 py-2 text-sm font-medium rounded-lg transition-all ${
          isActive
            ? "bg-blue-600 text-white shadow-sm"
            : isDisabled
            ? "text-gray-600 cursor-not-allowed"
            : "text-gray-400 hover:text-gray-200 hover:bg-gray-700"
        }`;
      case "underline":
        return `px-3 py-2 text-sm font-medium transition-all border-b-2 ${
          isActive
            ? "border-blue-500 text-blue-400"
            : isDisabled
            ? "border-transparent text-gray-600 cursor-not-allowed"
            : "border-transparent text-gray-400 hover:text-gray-200 hover:border-gray-600"
        }`;
      default:
        return `px-4 py-2 text-sm font-medium rounded-xl transition-all ${
          isActive
            ? "bg-gray-700 text-white"
            : isDisabled
            ? "text-gray-600 cursor-not-allowed"
            : "text-gray-400 hover:text-gray-200 hover:bg-gray-800"
        }`;
    }
  };

  return (
    <div class={`${baseClasses()} ${props.class || ""}`}>
      <For each={props.tabs}>
        {(tab) => (
          <button
            type="button"
            class={tabClasses(tab)}
            onClick={() => !tab.disabled && props.onTabChange(tab.id)}
            disabled={tab.disabled}
          >
            <div class="flex items-center gap-2">
              <Show when={tab.icon}>
                <i class={`${tab.icon} w-4 h-4`} />
              </Show>
              <span>{tab.label}</span>
              <Show when={tab.badge !== undefined}>
                <span class="px-1.5 py-0.5 text-xs rounded-full bg-blue-500/20 text-blue-400 min-w-[1.25rem] text-center">
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
