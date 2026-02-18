import { createSignal, For, Show, JSX, onMount, onCleanup } from "solid-js";
import { Toggle, Dropdown, Pagination, ModalWrapper, Tooltip, RangeSlider, Select, Tabs, Skeleton, SkeletonCard, SkeletonList, BackgroundOption, RadioOption, BulkOperationsToolbar, ViewModeSwitch } from "../ui";
import { addToast } from "./Toast";
import CodeViewer from "./CodeViewer";
import { useI18n } from "../i18n";
import { BUILT_IN_ACCENTS, getActiveAccent, setActiveAccent, generateAccentFromColor, type ViewMode } from "../stores/uiPreferences";

// ==================== Helpers ====================

interface SectionProps {
  title: string;
  children: JSX.Element;
}

function Section(props: SectionProps) {
  return (
    <div class="flex flex-col gap-3">
      <h3 class="text-lg font-semibold text-gray-200 border-b border-gray-700 pb-2">
        {props.title}
      </h3>
      <div class="flex flex-wrap gap-3 items-start">
        {props.children}
      </div>
    </div>
  );
}

function ComponentBox(props: { label: string; children: JSX.Element; vertical?: boolean }) {
  return (
    <div class="flex flex-col gap-1.5">
      <span class="text-xs text-gray-500 font-mono">{props.label}</span>
      <div class={`flex ${props.vertical ? "flex-col" : ""} gap-2 items-center`}>
        {props.children}
      </div>
    </div>
  );
}

// ==================== Sidebar Categories ====================

interface NavItem {
  id: string;
  label: string;
  icon: string;
}

interface NavCategory {
  label: string;
  items: NavItem[];
}

const NAV_CATEGORIES: NavCategory[] = [
  {
    label: "Foundation",
    items: [
      { id: "buttons", label: "Buttons", icon: "i-hugeicons-mouse-left-click-02" },
      { id: "typography", label: "Typography", icon: "i-hugeicons-text-font" },
      { id: "colors", label: "Colors", icon: "i-hugeicons-paint-board" },
      { id: "icons", label: "Icons", icon: "i-hugeicons-star" },
      { id: "spacing", label: "Spacing", icon: "i-hugeicons-layers-01" },
    ],
  },
  {
    label: "Inputs",
    items: [
      { id: "inputs", label: "Text Inputs", icon: "i-hugeicons-text" },
      { id: "select", label: "Select", icon: "i-hugeicons-arrow-down-01" },
      { id: "toggle", label: "Toggle & Check", icon: "i-hugeicons-toggle-on" },
      { id: "range", label: "Range Slider", icon: "i-hugeicons-chart-line-data-01" },
      { id: "forms", label: "Form Validation", icon: "i-hugeicons-checkmark-circle-02" },
    ],
  },
  {
    label: "Data Display",
    items: [
      { id: "cards", label: "Cards", icon: "i-hugeicons-dashboard-square-01" },
      { id: "badges", label: "Badges", icon: "i-hugeicons-bookmark-02" },
      { id: "table", label: "Data Table", icon: "i-hugeicons-grid-view" },
      { id: "status", label: "Status", icon: "i-hugeicons-activity-01" },
      { id: "skeleton", label: "Skeleton", icon: "i-hugeicons-loading-01" },
      { id: "tooltips", label: "Tooltips", icon: "i-hugeicons-information-circle" },
      { id: "code", label: "Code Viewer", icon: "i-hugeicons-source-code" },
    ],
  },
  {
    label: "Navigation",
    items: [
      { id: "tabs", label: "Tabs", icon: "i-hugeicons-browser" },
      { id: "dropdown", label: "Dropdown", icon: "i-hugeicons-menu-01" },
      { id: "pagination", label: "Pagination", icon: "i-hugeicons-arrow-right-01" },
      { id: "context-menu", label: "Context Menu", icon: "i-hugeicons-more-horizontal" },
    ],
  },
  {
    label: "Feedback",
    items: [
      { id: "toast", label: "Toast", icon: "i-hugeicons-notification-01" },
      { id: "alerts", label: "Alerts", icon: "i-hugeicons-alert-02" },
      { id: "progress", label: "Progress", icon: "i-hugeicons-loading-01" },
      { id: "spinners", label: "Spinners", icon: "i-svg-spinners-ring-resize" },
      { id: "empty", label: "Empty States", icon: "i-hugeicons-file-01" },
    ],
  },
  {
    label: "Layout",
    items: [
      { id: "grid", label: "Grid Layouts", icon: "i-hugeicons-grid" },
      { id: "dividers", label: "Dividers", icon: "i-hugeicons-minus-sign" },
      { id: "animations", label: "Animations", icon: "i-hugeicons-magic-wand-01" },
      { id: "truncation", label: "Truncation", icon: "i-hugeicons-text" },
      { id: "responsive", label: "Responsive", icon: "i-hugeicons-laptop" },
    ],
  },
  {
    label: "Domain",
    items: [
      { id: "instance-cards", label: "Instance Cards", icon: "i-hugeicons-game-controller-03" },
      { id: "console", label: "Console", icon: "i-hugeicons-computer-terminal-01" },
      { id: "backgrounds", label: "Backgrounds", icon: "i-hugeicons-image-02" },
      { id: "viewmode", label: "View Mode", icon: "i-hugeicons-grid-view" },
      { id: "bulk", label: "Bulk Actions", icon: "i-hugeicons-tick-02" },
      { id: "filedrop", label: "File Drop", icon: "i-hugeicons-upload-02" },
    ],
  },
  {
    label: "Theming",
    items: [
      { id: "themes", label: "Accent Themes", icon: "i-hugeicons-colors" },
      { id: "theme-gen", label: "Theme Generator", icon: "i-hugeicons-paint-brush-01" },
    ],
  },
  {
    label: "Reference",
    items: [
      { id: "shortcuts", label: "Keyboard Shortcuts", icon: "i-hugeicons-command-line" },
      { id: "focus", label: "Focus States", icon: "i-hugeicons-view" },
    ],
  },
];

const ALL_NAV_ITEMS = NAV_CATEGORIES.flatMap(c => c.items);

// ==================== Component ====================

export function UIKit(props: { onClose: () => void }) {
  const { t } = useI18n();
  const [activeSection, setActiveSection] = createSignal("buttons");
  const [sidebarSearch, setSidebarSearch] = createSignal("");

  // Interactive state
  const [toggleState, setToggleState] = createSignal(false);
  const [toggleLoading, setToggleLoading] = createSignal(false);
  const [dropdownOpen, setDropdownOpen] = createSignal(false);
  const [paginationPage, setPaginationPage] = createSignal(0);
  const [checkboxState, setCheckboxState] = createSignal(false);
  const [radioState, setRadioState] = createSignal("option1");
  const [inputValue, setInputValue] = createSignal("");
  const [rangeValue, setRangeValue] = createSignal(50);
  const progressValue = () => 65;
  const [selectValue, setSelectValue] = createSignal("option1");
  const [activeTab, setActiveTab] = createSignal("tab1");
  const [sidebarTab, setSidebarTab] = createSignal("general");
  const [activeBg, setActiveBg] = createSignal("aurora");
  const [bulkSelected, setBulkSelected] = createSignal(3);
  const [responsiveWidth, setResponsiveWidth] = createSignal<string>("100%");
  const [viewModeDemo, setViewModeDemo] = createSignal<ViewMode>("grid");
  const [searchDemo, setSearchDemo] = createSignal("");
  const [customColor, setCustomColor] = createSignal("#ff6600");
  const [ctxMenuMode, setCtxMenuMode] = createSignal<"primary" | "advanced">("primary");

  const filteredNav = () => {
    const q = sidebarSearch().toLowerCase();
    if (!q) return NAV_CATEGORIES;
    return NAV_CATEGORIES.map(cat => ({
      ...cat,
      items: cat.items.filter(i => i.label.toLowerCase().includes(q) || i.id.includes(q)),
    })).filter(cat => cat.items.length > 0);
  };

  // Close on Escape
  const handleEsc = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onClose();
  };
  onMount(() => document.addEventListener("keydown", handleEsc));
  onCleanup(() => document.removeEventListener("keydown", handleEsc));

  return (
    <ModalWrapper maxWidth="max-w-7xl">
      <div class="flex flex-col h-full max-h-[85vh]">
        {/* Header */}
        <div class="flex items-center justify-between p-4 border-b border-gray-700 flex-shrink-0">
          <div class="flex items-center gap-3">
            <i class="i-hugeicons-paint-board w-6 h-6 text-purple-400" />
            <div>
              <h2 class="text-xl font-bold">Design System</h2>
              <p class="text-sm text-gray-500">
                {ALL_NAV_ITEMS.length} components &middot; dev mode
              </p>
            </div>
          </div>
          <button
            class="btn-close"
            onClick={props.onClose}
            aria-label={t().ui?.tooltips?.close ?? "Close"}
          >
            <i class="i-hugeicons-cancel-01 w-5 h-5" />
          </button>
        </div>

        {/* Body: Sidebar + Content */}
        <div class="flex flex-1 min-h-0">
          {/* Sidebar */}
          <nav class="w-56 flex-shrink-0 border-r border-gray-700 flex flex-col">
            <div class="p-2">
              <div class="flex items-center gap-2 px-2 py-1.5 bg-gray-800 rounded-lg border border-gray-700">
                <i class="i-hugeicons-search-01 w-3.5 h-3.5 text-gray-500" />
                <input
                  type="text"
                  placeholder="Search..."
                  class="bg-transparent text-sm border-none outline-none flex-1 p-0 text-gray-300 placeholder-gray-600"
                  value={sidebarSearch()}
                  onInput={(e) => setSidebarSearch(e.currentTarget.value)}
                />
              </div>
            </div>
            <div class="flex-1 overflow-y-auto px-2 pb-2">
              <For each={filteredNav()}>
                {(category) => (
                  <div class="flex flex-col gap-0.5 mb-3">
                    <span class="text-[10px] uppercase tracking-wider text-gray-600 font-semibold px-2 py-1">
                      {category.label}
                    </span>
                    <For each={category.items}>
                      {(item) => (
                        <button
                          class={`flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm transition-colors duration-100 w-full text-left ${
                            activeSection() === item.id
                              ? "bg-[var(--color-primary-bg)] text-[var(--color-primary)]"
                              : "text-gray-400 hover:text-gray-200 hover:bg-gray-800"
                          }`}
                          onClick={() => setActiveSection(item.id)}
                        >
                          <i class={`${item.icon} w-4 h-4 flex-shrink-0`} />
                          <span class="truncate">{item.label}</span>
                        </button>
                      )}
                    </For>
                  </div>
                )}
              </For>
            </div>
          </nav>

          {/* Content */}
          <main class="flex-1 overflow-y-auto p-6 min-h-0">
            <div class="flex flex-col gap-8">

              {/* ==================== BUTTONS ==================== */}
              <Show when={activeSection() === "buttons"}>
                <Section title="Buttons">
                  <ComponentBox label="btn-primary">
                    <button class="btn-primary">Primary</button>
                    <button class="btn-primary" disabled>Disabled</button>
                  </ComponentBox>
                  <ComponentBox label="btn-secondary">
                    <button class="btn-secondary">Secondary</button>
                    <button class="btn-secondary" disabled>Disabled</button>
                  </ComponentBox>
                  <ComponentBox label="btn-ghost">
                    <button class="btn-ghost">Ghost</button>
                    <button class="btn-ghost" disabled>Disabled</button>
                  </ComponentBox>
                  <ComponentBox label="data-variant='danger'">
                    <button data-variant="danger">Danger</button>
                  </ComponentBox>
                  <ComponentBox label="data-variant='success'">
                    <button data-variant="success">Success</button>
                  </ComponentBox>
                  <ComponentBox label="btn-sm">
                    <button class="btn-primary btn-sm">Small Primary</button>
                    <button class="btn-secondary btn-sm">Small Secondary</button>
                  </ComponentBox>
                  <ComponentBox label="btn-lg">
                    <button class="btn-primary btn-lg">Large</button>
                  </ComponentBox>
                  <ComponentBox label="With icons">
                    <button class="btn-primary">
                      <i class="i-hugeicons-add-01 w-4 h-4" />
                      Add Item
                    </button>
                    <button class="btn-secondary">
                      <i class="i-hugeicons-settings-02 w-4 h-4" />
                      Settings
                    </button>
                  </ComponentBox>
                  <ComponentBox label="Icon only (data-icon-only)">
                    <button class="btn-ghost" data-icon-only="true">
                      <i class="i-hugeicons-cancel-01 w-4 h-4" />
                    </button>
                    <button class="btn-secondary" data-icon-only="true">
                      <i class="i-hugeicons-edit-02 w-4 h-4" />
                    </button>
                  </ComponentBox>
                  <ComponentBox label="btn-close (round)">
                    <button class="btn-close">
                      <i class="i-hugeicons-cancel-01 w-5 h-5" />
                    </button>
                  </ComponentBox>
                </Section>
              </Show>

              {/* ==================== TYPOGRAPHY ==================== */}
              <Show when={activeSection() === "typography"}>
                <Section title="Typography">
                  <div class="flex flex-col gap-2 w-full">
                    <h1 class="text-2xl font-bold">Heading 1 (text-2xl font-bold)</h1>
                    <h2 class="text-xl font-bold">Heading 2 (text-xl font-bold)</h2>
                    <h3 class="text-lg font-semibold">Heading 3 (text-lg font-semibold)</h3>
                    <p class="text-base">Body text (text-base)</p>
                    <p class="text-sm text-gray-400">Secondary text (text-sm text-gray-400)</p>
                    <p class="text-xs text-gray-500">Caption text (text-xs text-gray-500)</p>
                    <code class="text-sm font-mono bg-gray-800 px-1.5 py-0.5 rounded">Inline code</code>
                    <div class="flex flex-col gap-1 mt-2">
                      <span class="text-xs text-gray-500">font-mono</span>
                      <span class="font-mono text-sm">0123456789 ABCDEF</span>
                    </div>
                  </div>
                </Section>
              </Show>

              {/* ==================== COLORS ==================== */}
              <Show when={activeSection() === "colors"}>
                <Section title="Color Palette (CSS Variables)">
                  <div class="flex flex-col gap-4 w-full">
                    <div class="flex flex-col gap-1">
                      <span class="text-xs text-gray-500 font-mono">Background scale</span>
                      <div class="flex gap-1">
                        {[
                          { var: "--color-bg", label: "bg" },
                          { var: "--color-bg-elevated", label: "elevated" },
                          { var: "--color-bg-hover", label: "hover" },
                        ].map(c => (
                          <div class="flex flex-col items-center gap-1">
                            <div class="w-16 h-12 rounded-lg border border-gray-700" style={{ "background-color": `var(${c.var})` }} />
                            <span class="text-[10px] text-gray-500 font-mono">{c.label}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div class="flex flex-col gap-1">
                      <span class="text-xs text-gray-500 font-mono">Accent (primary)</span>
                      <div class="flex gap-1">
                        {[
                          { var: "--color-primary", label: "primary" },
                          { var: "--color-primary-hover", label: "hover" },
                          { var: "--color-primary-active", label: "active" },
                          { var: "--color-primary-light", label: "light" },
                          { var: "--color-primary-dark", label: "dark" },
                        ].map(c => (
                          <div class="flex flex-col items-center gap-1">
                            <div class="w-14 h-10 rounded-lg border border-gray-700" style={{ "background-color": `var(${c.var})` }} />
                            <span class="text-[10px] text-gray-500 font-mono">{c.label}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div class="flex flex-col gap-1">
                      <span class="text-xs text-gray-500 font-mono">Semantic</span>
                      <div class="flex gap-1">
                        {[
                          { color: "bg-green-500", label: "success" },
                          { color: "bg-yellow-500", label: "warning" },
                          { color: "bg-red-500", label: "error" },
                          { color: "bg-blue-500", label: "info" },
                        ].map(c => (
                          <div class="flex flex-col items-center gap-1">
                            <div class={`w-14 h-10 rounded-lg ${c.color}`} />
                            <span class="text-[10px] text-gray-500 font-mono">{c.label}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div class="flex flex-col gap-1">
                      <span class="text-xs text-gray-500 font-mono">Gray scale</span>
                      <div class="flex gap-0.5">
                        {["bg-gray-950", "bg-gray-900", "bg-gray-850", "bg-gray-800", "bg-gray-750", "bg-gray-700", "bg-gray-600", "bg-gray-500", "bg-gray-400", "bg-gray-300"].map(c => (
                          <div class={`w-8 h-8 rounded ${c}`} />
                        ))}
                      </div>
                    </div>
                  </div>
                </Section>
              </Show>

              {/* ==================== ICONS ==================== */}
              <Show when={activeSection() === "icons"}>
                <Section title="Common Icons (Hugeicons)">
                  <div class="flex flex-wrap gap-4">
                    <For each={[
                      { icon: "i-hugeicons-add-01", name: "add" },
                      { icon: "i-hugeicons-cancel-01", name: "close" },
                      { icon: "i-hugeicons-settings-02", name: "settings" },
                      { icon: "i-hugeicons-edit-02", name: "edit" },
                      { icon: "i-hugeicons-delete-02", name: "delete" },
                      { icon: "i-hugeicons-download-02", name: "download" },
                      { icon: "i-hugeicons-upload-02", name: "upload" },
                      { icon: "i-hugeicons-play", name: "play" },
                      { icon: "i-hugeicons-stop", name: "stop" },
                      { icon: "i-hugeicons-checkmark-circle-02", name: "check" },
                      { icon: "i-hugeicons-alert-02", name: "warning" },
                      { icon: "i-hugeicons-information-circle", name: "info" },
                      { icon: "i-hugeicons-search-01", name: "search" },
                      { icon: "i-hugeicons-filter", name: "filter" },
                      { icon: "i-hugeicons-folder-01", name: "folder" },
                      { icon: "i-hugeicons-file-01", name: "file" },
                      { icon: "i-hugeicons-user", name: "user" },
                      { icon: "i-hugeicons-package", name: "package" },
                      { icon: "i-hugeicons-refresh", name: "refresh" },
                      { icon: "i-hugeicons-copy-01", name: "copy" },
                      { icon: "i-hugeicons-arrow-left-01", name: "arrow-left" },
                      { icon: "i-hugeicons-arrow-right-01", name: "arrow-right" },
                      { icon: "i-hugeicons-arrow-down-01", name: "arrow-down" },
                      { icon: "i-hugeicons-arrow-up-01", name: "arrow-up" },
                      { icon: "i-hugeicons-more-horizontal", name: "more" },
                      { icon: "i-hugeicons-link-01", name: "link" },
                      { icon: "i-hugeicons-share-01", name: "share" },
                      { icon: "i-hugeicons-star", name: "star" },
                      { icon: "i-hugeicons-floppy-disk", name: "save" },
                      { icon: "i-hugeicons-terminal", name: "terminal" },
                      { icon: "i-hugeicons-wrench-01", name: "wrench" },
                      { icon: "i-hugeicons-game-controller-03", name: "game" },
                    ]}>
                      {(item) => (
                        <div class="flex flex-col items-center gap-1">
                          <div class="w-10 h-10 flex items-center justify-center rounded-lg bg-gray-800 hover:bg-gray-750 transition-colors">
                            <i class={`${item.icon} w-5 h-5 text-gray-300`} />
                          </div>
                          <span class="text-[10px] text-gray-500">{item.name}</span>
                        </div>
                      )}
                    </For>
                  </div>
                </Section>
                <Section title="Spinners">
                  <ComponentBox label="ring-resize">
                    <i class="i-svg-spinners-ring-resize w-4 h-4 text-[var(--color-primary)]" />
                    <i class="i-svg-spinners-ring-resize w-6 h-6 text-[var(--color-primary)]" />
                    <i class="i-svg-spinners-ring-resize w-8 h-8 text-[var(--color-primary)]" />
                  </ComponentBox>
                  <ComponentBox label="6-dots-scale">
                    <i class="i-svg-spinners-6-dots-scale w-4 h-4 text-[var(--color-primary)]" />
                    <i class="i-svg-spinners-6-dots-scale w-6 h-6 text-[var(--color-primary)]" />
                    <i class="i-svg-spinners-6-dots-scale w-8 h-8 text-[var(--color-primary)]" />
                  </ComponentBox>
                </Section>
              </Show>

              {/* ==================== SPACING ==================== */}
              <Show when={activeSection() === "spacing"}>
                <Section title="Spacing (gap classes)">
                  <div class="flex flex-col gap-4 w-full">
                    {[
                      { gap: "gap-1", label: "gap-1 (4px)", color: "bg-blue-600" },
                      { gap: "gap-2", label: "gap-2 (8px)", color: "bg-green-600" },
                      { gap: "gap-3", label: "gap-3 (12px)", color: "bg-purple-600" },
                      { gap: "gap-4", label: "gap-4 (16px)", color: "bg-amber-600" },
                      { gap: "gap-6", label: "gap-6 (24px)", color: "bg-red-600" },
                    ].map(s => (
                      <div class="flex flex-col gap-1">
                        <span class="text-xs text-gray-500">{s.label}</span>
                        <div class={`flex ${s.gap}`}>
                          <div class={`w-8 h-8 ${s.color} rounded`} />
                          <div class={`w-8 h-8 ${s.color} rounded`} />
                          <div class={`w-8 h-8 ${s.color} rounded`} />
                        </div>
                      </div>
                    ))}
                  </div>
                </Section>
              </Show>

              {/* ==================== TEXT INPUTS ==================== */}
              <Show when={activeSection() === "inputs"}>
                <Section title="Inputs">
                  <ComponentBox label="Text input" vertical>
                    <input
                      type="text"
                      placeholder="Type something..."
                      value={inputValue()}
                      onInput={(e) => setInputValue(e.currentTarget.value)}
                      class="w-64"
                    />
                  </ComponentBox>
                  <ComponentBox label="Disabled" vertical>
                    <input type="text" placeholder="Disabled" disabled class="w-64" />
                  </ComponentBox>
                  <ComponentBox label="Number" vertical>
                    <input type="number" placeholder="0" class="w-32" />
                  </ComponentBox>
                  <ComponentBox label="Search input" vertical>
                    <div class="flex items-center gap-2 px-3 py-2 bg-gray-800 border border-gray-700 rounded-xl w-64">
                      <i class="i-hugeicons-search-01 w-4 h-4 text-gray-500" />
                      <input
                        type="text"
                        placeholder="Search mods..."
                        value={searchDemo()}
                        onInput={(e) => setSearchDemo(e.currentTarget.value)}
                        class="bg-transparent border-none outline-none text-sm flex-1 p-0"
                      />
                      <Show when={searchDemo()}>
                        <button class="text-gray-500 hover:text-gray-300" onClick={() => setSearchDemo("")}>
                          <i class="i-hugeicons-cancel-01 w-3.5 h-3.5" />
                        </button>
                      </Show>
                    </div>
                  </ComponentBox>
                  <ComponentBox label="Textarea" vertical>
                    <textarea placeholder="Multi-line text..." class="w-64 h-20" />
                  </ComponentBox>
                  <ComponentBox label="Checkbox" vertical>
                    <label class="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={checkboxState()}
                        onChange={(e) => setCheckboxState(e.currentTarget.checked)}
                        class="w-4 h-4 rounded border-gray-600 bg-gray-800 accent-[var(--color-primary)]"
                      />
                      <span class="text-sm">{checkboxState() ? "Checked" : "Unchecked"}</span>
                    </label>
                  </ComponentBox>
                </Section>
              </Show>

              {/* ==================== SELECT ==================== */}
              <Show when={activeSection() === "select"}>
                <Section title="Select">
                  <ComponentBox label="Basic Select" vertical>
                    <Select
                      value={selectValue()}
                      options={[
                        { value: "option1", label: "Option 1" },
                        { value: "option2", label: "Option 2" },
                        { value: "option3", label: "Option 3" },
                      ]}
                      onChange={setSelectValue}
                      placeholder="Choose..."
                      class="w-48"
                    />
                    <span class="text-sm text-gray-400">Selected: {selectValue()}</span>
                  </ComponentBox>
                  <ComponentBox label="With icons" vertical>
                    <Select
                      value={selectValue()}
                      options={[
                        { value: "forge", label: "Forge", icon: "i-hugeicons-package" },
                        { value: "fabric", label: "Fabric", icon: "i-hugeicons-package" },
                        { value: "neoforge", label: "NeoForge", icon: "i-hugeicons-package" },
                        { value: "quilt", label: "Quilt", icon: "i-hugeicons-package" },
                      ]}
                      onChange={setSelectValue}
                      placeholder="Select loader"
                      class="w-56"
                    />
                  </ComponentBox>
                  <ComponentBox label="With descriptions" vertical>
                    <Select
                      value={selectValue()}
                      options={[
                        { value: "1.20.1", label: "1.20.1", description: "Latest stable" },
                        { value: "1.19.4", label: "1.19.4", description: "Long term support" },
                        { value: "1.18.2", label: "1.18.2", description: "Legacy" },
                      ]}
                      onChange={setSelectValue}
                      placeholder="Select version"
                      class="w-56"
                    />
                  </ComponentBox>
                  <ComponentBox label="Disabled" vertical>
                    <Select
                      value=""
                      options={[{ value: "a", label: "Disabled option" }]}
                      onChange={() => {}}
                      disabled
                      class="w-48"
                    />
                  </ComponentBox>
                </Section>
              </Show>

              {/* ==================== TOGGLE ==================== */}
              <Show when={activeSection() === "toggle"}>
                <Section title="Toggle & Checkbox">
                  <ComponentBox label="Toggle component" vertical>
                    <div class="flex items-center gap-3">
                      <Toggle checked={toggleState()} onChange={setToggleState} />
                      <span class="text-sm">{toggleState() ? "On" : "Off"}</span>
                    </div>
                  </ComponentBox>
                  <ComponentBox label="Toggle loading" vertical>
                    <div class="flex items-center gap-3">
                      <Toggle checked={toggleLoading()} onChange={(v) => { setToggleLoading(v); }} loading />
                      <span class="text-sm">Loading state</span>
                    </div>
                  </ComponentBox>
                  <ComponentBox label="Toggle disabled" vertical>
                    <Toggle checked={false} onChange={() => {}} disabled />
                  </ComponentBox>
                  <ComponentBox label="RadioOption" vertical>
                    <div role="radiogroup" aria-label="Game type" class="flex flex-col gap-2 w-full">
                      <RadioOption
                        icon={<i class="i-hugeicons-game-controller-03 w-5 h-5" />}
                        title="Minecraft"
                        subtitle="Java Edition"
                        active={radioState() === "option1"}
                        onClick={() => setRadioState("option1")}
                        fullWidth
                      />
                      <RadioOption
                        icon={<i class="i-hugeicons-cube-01 w-5 h-5" />}
                        title="Hytale"
                        subtitle="Coming soon"
                        active={radioState() === "option2"}
                        onClick={() => setRadioState("option2")}
                        fullWidth
                      />
                    </div>
                  </ComponentBox>
                </Section>
              </Show>

              {/* ==================== RANGE ==================== */}
              <Show when={activeSection() === "range"}>
                <Section title="Range Slider">
                  <ComponentBox label="Basic range" vertical>
                    <div class="w-80">
                      <RangeSlider
                        value={rangeValue()}
                        onChange={setRangeValue}
                        min={0}
                        max={100}
                      />
                      <span class="text-sm text-gray-400">Value: {rangeValue()}</span>
                    </div>
                  </ComponentBox>
                  <ComponentBox label="With ticks" vertical>
                    <div class="w-80">
                      <RangeSlider
                        value={rangeValue()}
                        onChange={setRangeValue}
                        min={0}
                        max={100}
                        step={10}
                        showTicks
                      />
                    </div>
                  </ComponentBox>
                  <ComponentBox label="With ticks + labels" vertical>
                    <div class="w-80">
                      <RangeSlider
                        value={rangeValue()}
                        onChange={setRangeValue}
                        min={0}
                        max={100}
                        step={25}
                        showTicks
                        showLabels
                        formatLabel={(v) => `${v}%`}
                      />
                    </div>
                  </ComponentBox>
                  <ComponentBox label="RAM allocation (MB)" vertical>
                    <div class="w-80">
                      <RangeSlider
                        value={rangeValue() * 128}
                        onChange={(v) => setRangeValue(Math.round(v / 128))}
                        min={1024}
                        max={16384}
                        step={1024}
                        showTicks
                        showLabels
                        labelTicks={[1024, 4096, 8192, 16384]}
                        formatLabel={(v) => `${v / 1024}G`}
                      />
                    </div>
                  </ComponentBox>
                  <ComponentBox label="Custom ticks" vertical>
                    <div class="w-80">
                      <RangeSlider
                        value={rangeValue()}
                        onChange={setRangeValue}
                        min={0}
                        max={100}
                        ticks={[0, 10, 25, 50, 75, 100]}
                        showTicks
                        showLabels
                      />
                    </div>
                  </ComponentBox>
                  <ComponentBox label="Disabled" vertical>
                    <div class="w-80">
                      <RangeSlider
                        value={65}
                        onChange={() => {}}
                        min={0}
                        max={100}
                        disabled
                        showTicks
                        step={25}
                      />
                    </div>
                  </ComponentBox>
                </Section>
              </Show>

              {/* ==================== FORM VALIDATION ==================== */}
              <Show when={activeSection() === "forms"}>
                <Section title="Form Validation States">
                  <div class="flex flex-col gap-4 w-full max-w-md">
                    <ComponentBox label="Default" vertical>
                      <input type="text" placeholder="Enter username..." class="w-full" />
                    </ComponentBox>
                    <ComponentBox label="Success state" vertical>
                      <div class="flex flex-col gap-1 w-full">
                        <input
                          type="text"
                          placeholder="valid_user"
                          class="w-full border-green-500/50 focus:border-green-500"
                        />
                        <span class="text-xs text-green-400 flex items-center gap-1">
                          <i class="i-hugeicons-checkmark-circle-02 w-3 h-3" />
                          Username is available
                        </span>
                      </div>
                    </ComponentBox>
                    <ComponentBox label="Error state" vertical>
                      <div class="flex flex-col gap-1 w-full">
                        <input
                          type="text"
                          placeholder="ab"
                          class="w-full border-red-500/50 focus:border-red-500"
                        />
                        <span class="text-xs text-red-400 flex items-center gap-1">
                          <i class="i-hugeicons-alert-circle w-3 h-3" />
                          Minimum 3 characters required
                        </span>
                      </div>
                    </ComponentBox>
                    <ComponentBox label="Required field" vertical>
                      <div class="flex flex-col gap-1 w-full">
                        <label class="text-sm text-gray-300">
                          Instance name <span class="text-red-400">*</span>
                        </label>
                        <input type="text" placeholder="My Modpack..." class="w-full" />
                      </div>
                    </ComponentBox>
                    <ComponentBox label="With helper text" vertical>
                      <div class="flex flex-col gap-1 w-full">
                        <label class="text-sm text-gray-300">RAM allocation</label>
                        <input type="number" placeholder="4096" class="w-full" />
                        <span class="text-xs text-gray-500">Recommended: 4-8 GB for modded Minecraft</span>
                      </div>
                    </ComponentBox>
                  </div>
                </Section>
              </Show>

              {/* ==================== CARDS ==================== */}
              <Show when={activeSection() === "cards"}>
                <Section title="Cards">
                  <ComponentBox label=".card" vertical>
                    <div class="card w-64">
                      <p class="text-sm">Basic card with p-4, rounded-xl, border</p>
                    </div>
                  </ComponentBox>
                  <ComponentBox label=".card-hover" vertical>
                    <div class="card-hover w-64 cursor-pointer">
                      <p class="text-sm">Hover me - border changes</p>
                    </div>
                  </ComponentBox>
                  <ComponentBox label=".card-glass" vertical>
                    <div class="card-glass w-64">
                      <p class="text-sm">Glass effect with backdrop-blur</p>
                    </div>
                  </ComponentBox>
                </Section>
              </Show>

              {/* ==================== BADGES ==================== */}
              <Show when={activeSection() === "badges"}>
                <Section title="Badges">
                  <ComponentBox label="Status badges">
                    <span class="px-2.5 py-0.5 text-xs font-medium rounded-full bg-green-500/20 text-green-400">Running</span>
                    <span class="px-2.5 py-0.5 text-xs font-medium rounded-full bg-gray-500/20 text-gray-400">Stopped</span>
                    <span class="px-2.5 py-0.5 text-xs font-medium rounded-full bg-yellow-500/20 text-yellow-400">Installing</span>
                    <span class="px-2.5 py-0.5 text-xs font-medium rounded-full bg-red-500/20 text-red-400">Error</span>
                  </ComponentBox>
                  <ComponentBox label="Tag badges">
                    <span class="px-2.5 py-0.5 text-xs font-medium rounded-full bg-blue-500/20 text-blue-400 border border-blue-500/30">Forge</span>
                    <span class="px-2.5 py-0.5 text-xs font-medium rounded-full bg-purple-500/20 text-purple-400 border border-purple-500/30">Fabric</span>
                    <span class="px-2.5 py-0.5 text-xs font-medium rounded-full bg-orange-500/20 text-orange-400 border border-orange-500/30">NeoForge</span>
                    <span class="px-2.5 py-0.5 text-xs font-medium rounded-full bg-cyan-500/20 text-cyan-400 border border-cyan-500/30">Quilt</span>
                  </ComponentBox>
                  <ComponentBox label="Count badges">
                    <span class="px-1.5 py-0.5 text-xs font-medium rounded-full bg-[var(--color-primary)] text-white min-w-[1.25rem] text-center">5</span>
                    <span class="px-1.5 py-0.5 text-xs font-medium rounded-full bg-red-600 text-white min-w-[1.25rem] text-center">99+</span>
                  </ComponentBox>
                </Section>
              </Show>

              {/* ==================== DATA TABLE ==================== */}
              <Show when={activeSection() === "table"}>
                <Section title="Data Table">
                  <div class="w-full overflow-x-auto rounded-xl border border-gray-700">
                    <table class="w-full text-sm">
                      <thead>
                        <tr class="border-b border-gray-700 bg-gray-800/50">
                          <th class="text-left px-4 py-2 text-xs text-gray-500 font-medium uppercase tracking-wider">Name</th>
                          <th class="text-left px-4 py-2 text-xs text-gray-500 font-medium uppercase tracking-wider">Version</th>
                          <th class="text-left px-4 py-2 text-xs text-gray-500 font-medium uppercase tracking-wider">Status</th>
                          <th class="text-right px-4 py-2 text-xs text-gray-500 font-medium uppercase tracking-wider">Downloads</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[
                          { name: "Sodium", ver: "0.5.8", status: "active", dl: "24.1M" },
                          { name: "Iris Shaders", ver: "1.7.0", status: "active", dl: "18.3M" },
                          { name: "Lithium", ver: "0.12.1", status: "update", dl: "12.0M" },
                          { name: "OptiFine", ver: "HD U I6", status: "incompatible", dl: "205M" },
                        ].map((row, i) => (
                          <tr class={`border-b border-gray-800 hover:bg-gray-800/30 ${i % 2 ? "bg-gray-850/30" : ""}`}>
                            <td class="px-4 py-2.5 font-medium">{row.name}</td>
                            <td class="px-4 py-2.5 text-gray-400 font-mono text-xs">{row.ver}</td>
                            <td class="px-4 py-2.5">
                              <span class={`px-2 py-0.5 text-xs rounded-full ${
                                row.status === "active" ? "bg-green-500/20 text-green-400" :
                                row.status === "update" ? "bg-yellow-500/20 text-yellow-400" :
                                "bg-red-500/20 text-red-400"
                              }`}>{row.status}</span>
                            </td>
                            <td class="px-4 py-2.5 text-right text-gray-400">{row.dl}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Section>
              </Show>

              {/* ==================== STATUS ==================== */}
              <Show when={activeSection() === "status"}>
                <Section title="Status Indicators">
                  <ComponentBox label="Dot indicators">
                    <div class="flex items-center gap-2"><span class="w-2 h-2 rounded-full bg-green-400" /><span class="text-sm">Online</span></div>
                    <div class="flex items-center gap-2"><span class="w-2 h-2 rounded-full bg-yellow-400" /><span class="text-sm">Away</span></div>
                    <div class="flex items-center gap-2"><span class="w-2 h-2 rounded-full bg-red-400" /><span class="text-sm">Error</span></div>
                    <div class="flex items-center gap-2"><span class="w-2 h-2 rounded-full bg-gray-500" /><span class="text-sm">Offline</span></div>
                  </ComponentBox>
                  <ComponentBox label="Animated">
                    <div class="flex items-center gap-2"><span class="w-2 h-2 rounded-full bg-green-400 animate-pulse" /><span class="text-sm">Running</span></div>
                    <div class="flex items-center gap-2"><span class="w-2 h-2 rounded-full bg-blue-400 animate-pulse" /><span class="text-sm">Installing</span></div>
                  </ComponentBox>
                  <ComponentBox label="Notification dot">
                    <div class="flex items-center gap-4">
                      <div class="p-2">
                        <i class="i-hugeicons-notification-01 w-5 h-5 text-gray-300" />
                        <span class="absolute -top-1 -right-1 w-2.5 h-2.5 bg-red-500 rounded-full border-2 border-gray-850" />
                      </div>
                      <div class="p-2">
                        <i class="i-hugeicons-notification-01 w-5 h-5 text-gray-300" />
                        <span class="absolute -top-1 -right-1 min-w-[1rem] h-4 bg-red-500 rounded-full flex items-center justify-center text-[10px] text-white font-bold px-1">3</span>
                      </div>
                    </div>
                  </ComponentBox>
                </Section>
              </Show>

              {/* ==================== SKELETON ==================== */}
              <Show when={activeSection() === "skeleton"}>
                <Section title="Skeleton Loaders">
                  <ComponentBox label="Basic skeleton" vertical>
                    <div class="w-64 space-y-2">
                      <Skeleton height="20px" />
                      <Skeleton height="16px" width="80%" />
                      <Skeleton height="16px" width="60%" />
                    </div>
                  </ComponentBox>
                  <ComponentBox label="Avatar + text" vertical>
                    <div class="flex items-center gap-3 w-64">
                      <Skeleton variant="avatar" width="40px" height="40px" />
                      <div class="flex-1 space-y-2">
                        <Skeleton variant="title" />
                        <Skeleton variant="text" width="60%" />
                      </div>
                    </div>
                  </ComponentBox>
                  <ComponentBox label="Card skeleton" vertical>
                    <div class="w-64"><SkeletonCard /></div>
                  </ComponentBox>
                  <ComponentBox label="List skeleton" vertical>
                    <div class="w-64"><SkeletonList count={3} /></div>
                  </ComponentBox>
                  <ComponentBox label="Button skeleton" vertical>
                    <div class="flex gap-2">
                      <Skeleton variant="button" width="100px" />
                      <Skeleton variant="button" width="80px" />
                    </div>
                  </ComponentBox>
                </Section>
              </Show>

              {/* ==================== TOOLTIPS ==================== */}
              <Show when={activeSection() === "tooltips"}>
                <Section title="Tooltips">
                  <ComponentBox label="Positions">
                    <Tooltip text="Tooltip on top" position="top"><button class="btn-secondary">Top</button></Tooltip>
                    <Tooltip text="Tooltip on bottom" position="bottom"><button class="btn-secondary">Bottom</button></Tooltip>
                    <Tooltip text="Tooltip on left" position="left"><button class="btn-secondary">Left</button></Tooltip>
                    <Tooltip text="Tooltip on right" position="right"><button class="btn-secondary">Right</button></Tooltip>
                  </ComponentBox>
                  <ComponentBox label="Icon buttons">
                    <Tooltip text="Settings" position="bottom">
                      <button class="btn-ghost" data-icon-only="true"><i class="i-hugeicons-settings-02 w-4 h-4" /></button>
                    </Tooltip>
                    <Tooltip text="Download" position="bottom">
                      <button class="btn-ghost" data-icon-only="true"><i class="i-hugeicons-download-02 w-4 h-4" /></button>
                    </Tooltip>
                  </ComponentBox>
                </Section>
              </Show>

              {/* ==================== CODE VIEWER ==================== */}
              <Show when={activeSection() === "code"}>
                <Section title="Code Viewer">
                  <ComponentBox label="TypeScript" vertical>
                    <div class="w-full">
                      <CodeViewer
                        code={`import { createSignal } from "solid-js";\n\nfunction Counter() {\n  const [count, setCount] = createSignal(0);\n  return (\n    <button onClick={() => setCount(c => c + 1)}>\n      Count: {count()}\n    </button>\n  );\n}`}
                        language="typescript"
                        filename="Counter.tsx"
                        showLineNumbers
                        showHeader
                        maxHeight="250px"
                      />
                    </div>
                  </ComponentBox>
                  <ComponentBox label="JSON" vertical>
                    <div class="w-full">
                      <CodeViewer
                        code={`{\n  "name": "my-modpack",\n  "version": "1.0.0",\n  "minecraft": "1.20.1",\n  "loader": "fabric",\n  "mods": ["sodium", "lithium", "iris"]\n}`}
                        language="json"
                        filename="manifest.json"
                        showHeader
                        maxHeight="200px"
                      />
                    </div>
                  </ComponentBox>
                  <ComponentBox label="Properties (minimal)" vertical>
                    <div class="w-full">
                      <CodeViewer
                        code={`server-port=25565\ndifficulty=hard\ngamemode=survival`}
                        language="properties"
                        minimal
                        maxHeight="100px"
                      />
                    </div>
                  </ComponentBox>
                </Section>
              </Show>

              {/* ==================== TABS ==================== */}
              <Show when={activeSection() === "tabs"}>
                <Section title="Tabs">
                  <ComponentBox label="Default" vertical>
                    <Tabs
                      tabs={[
                        { id: "tab1", label: "General" },
                        { id: "tab2", label: "Settings" },
                        { id: "tab3", label: "Advanced", disabled: true },
                      ]}
                      activeTab={activeTab()}
                      onTabChange={setActiveTab}
                    />
                    <div class="card p-4 w-64">
                      <Show when={activeTab() === "tab1"}><p class="text-sm text-gray-400">General content</p></Show>
                      <Show when={activeTab() === "tab2"}><p class="text-sm text-gray-400">Settings content</p></Show>
                    </div>
                  </ComponentBox>
                  <ComponentBox label="Pills" vertical>
                    <Tabs
                      tabs={[
                        { id: "tab1", label: "Mods" },
                        { id: "tab2", label: "Config" },
                        { id: "tab3", label: "Files" },
                      ]}
                      activeTab={activeTab()}
                      onTabChange={setActiveTab}
                      variant="pills"
                    />
                  </ComponentBox>
                  <ComponentBox label="Underline" vertical>
                    <Tabs
                      tabs={[
                        { id: "tab1", label: "Overview" },
                        { id: "tab2", label: "Details" },
                        { id: "tab3", label: "History" },
                      ]}
                      activeTab={activeTab()}
                      onTabChange={setActiveTab}
                      variant="underline"
                    />
                  </ComponentBox>
                  <ComponentBox label="With icons & badges" vertical>
                    <Tabs
                      tabs={[
                        { id: "tab1", label: "Mods", icon: "i-hugeicons-package", badge: 24 },
                        { id: "tab2", label: "Console", icon: "i-hugeicons-computer-terminal-01" },
                        { id: "tab3", label: "Settings", icon: "i-hugeicons-settings-02" },
                      ]}
                      activeTab={activeTab()}
                      onTabChange={setActiveTab}
                      variant="pills"
                    />
                  </ComponentBox>
                  <ComponentBox label="Sidebar variant" vertical>
                    <div class="flex gap-4 w-full">
                      <div class="w-48 border border-gray-700 rounded-lg p-2">
                        <Tabs
                          tabs={[
                            { id: "general", label: "General", icon: "i-hugeicons-settings-02" },
                            { id: "game", label: "Game", icon: "i-hugeicons-game-controller-03" },
                            { id: "mods", label: "Mods", icon: "i-hugeicons-package" },
                            { id: "data", label: "Data", icon: "i-hugeicons-folder-01", disabled: true },
                          ]}
                          activeTab={sidebarTab()}
                          onTabChange={setSidebarTab}
                          variant="sidebar"
                          aria-label="Demo sidebar"
                        />
                      </div>
                      <div class="flex-1 flex items-center justify-center text-sm text-gray-500 border border-dashed border-gray-700 rounded-lg p-4">
                        Active: <span class="text-gray-300 ml-1">{sidebarTab()}</span>
                      </div>
                    </div>
                  </ComponentBox>
                </Section>
              </Show>

              {/* ==================== DROPDOWN ==================== */}
              <Show when={activeSection() === "dropdown"}>
                <Section title="Dropdown">
                  <ComponentBox label="Dropdown component" vertical>
                    <Dropdown
                      open={dropdownOpen()}
                      onToggle={() => setDropdownOpen(!dropdownOpen())}
                      onClose={() => setDropdownOpen(false)}
                      trigger={
                        <button class="btn-secondary w-48 justify-between">
                          <span>Select option</span>
                          <i class={`w-4 h-4 transition-transform ${dropdownOpen() ? "i-hugeicons-arrow-up-01" : "i-hugeicons-arrow-down-01"}`} />
                        </button>
                      }
                    >
                      <div class="p-1">
                        <For each={["Option 1", "Option 2", "Option 3"]}>
                          {(opt) => (
                            <button class="dropdown-item" onClick={() => setDropdownOpen(false)}>{opt}</button>
                          )}
                        </For>
                        <div class="dropdown-divider" />
                        <button class="dropdown-item" data-danger="true">
                          <i class="i-hugeicons-delete-02 w-4 h-4" />
                          Delete
                        </button>
                      </div>
                    </Dropdown>
                  </ComponentBox>
                </Section>
              </Show>

              {/* ==================== PAGINATION ==================== */}
              <Show when={activeSection() === "pagination"}>
                <Section title="Pagination">
                  <ComponentBox label="Basic" vertical>
                    <Pagination currentPage={paginationPage()} totalPages={10} onPageChange={setPaginationPage} />
                    <span class="text-sm text-gray-400">Page {paginationPage() + 1} of 10</span>
                  </ComponentBox>
                  <ComponentBox label="Many pages (78)" vertical>
                    <Pagination currentPage={paginationPage()} totalPages={78} onPageChange={setPaginationPage} />
                  </ComponentBox>
                </Section>
              </Show>

              {/* ==================== CONTEXT MENU ==================== */}
              <Show when={activeSection() === "context-menu"}>
                <Section title="Context Menu (Two-Level)">
                  <div class="flex flex-col gap-4 w-full max-w-sm">
                    <p class="text-sm text-gray-400">
                      Two-level context menu pattern: primary actions visible immediately, advanced actions behind "More..." button.
                    </p>
                    <div class="card p-1 w-56">
                      <Show when={ctxMenuMode() === "primary"}>
                        <For each={[
                          { icon: "i-hugeicons-package", label: "Mods" },
                          { icon: "i-hugeicons-settings-02", label: "Game Settings" },
                          { icon: "i-hugeicons-folder-01", label: "Open Folder" },
                          { icon: "i-hugeicons-edit-02", label: "Edit" },
                          { icon: "i-hugeicons-delete-02", label: "Delete", danger: true },
                        ]}>
                          {(item) => (
                            <button class="dropdown-item" data-danger={item.danger || undefined}>
                              <i class={`${item.icon} w-4 h-4`} />
                              {item.label}
                            </button>
                          )}
                        </For>
                        <div class="dropdown-divider" />
                        <button class="dropdown-item" onClick={() => setCtxMenuMode("advanced")}>
                          <i class="i-hugeicons-more-horizontal w-4 h-4" />
                          More...
                        </button>
                      </Show>
                      <Show when={ctxMenuMode() === "advanced"}>
                        <button class="dropdown-item text-gray-500" onClick={() => setCtxMenuMode("primary")}>
                          <i class="i-hugeicons-arrow-left-01 w-4 h-4" />
                          Back
                        </button>
                        <div class="dropdown-divider" />
                        <For each={[
                          { icon: "i-hugeicons-search-01", label: "Analyze Logs" },
                          { icon: "i-hugeicons-checkmark-circle-02", label: "Check Integrity" },
                          { icon: "i-hugeicons-share-01", label: "Export" },
                          { icon: "i-hugeicons-refresh", label: "Re-import" },
                          { icon: "i-hugeicons-wrench-01", label: "Repair" },
                        ]}>
                          {(item) => (
                            <button class="dropdown-item">
                              <i class={`${item.icon} w-4 h-4`} />
                              {item.label}
                            </button>
                          )}
                        </For>
                      </Show>
                    </div>
                  </div>
                </Section>
              </Show>

              {/* ==================== TOAST ==================== */}
              <Show when={activeSection() === "toast"}>
                <Section title="Toast Notifications">
                  <div class="flex flex-wrap gap-3">
                    <button class="btn-secondary" onClick={() => addToast({ type: "info", title: "Info Toast", message: "This is an informational message", duration: 3000 })}>
                      <i class="i-hugeicons-information-circle w-4 h-4 text-blue-400" /> Show Info
                    </button>
                    <button class="btn-secondary" onClick={() => addToast({ type: "success", title: "Success!", message: "Operation completed successfully", duration: 3000 })}>
                      <i class="i-hugeicons-checkmark-circle-02 w-4 h-4 text-green-400" /> Show Success
                    </button>
                    <button class="btn-secondary" onClick={() => addToast({ type: "warning", title: "Warning", message: "Please check your settings", duration: 3000 })}>
                      <i class="i-hugeicons-alert-02 w-4 h-4 text-amber-400" /> Show Warning
                    </button>
                    <button class="btn-secondary" onClick={() => addToast({ type: "error", title: "Error", message: "Something went wrong", duration: 3000 })}>
                      <i class="i-hugeicons-cancel-circle w-4 h-4 text-red-400" /> Show Error
                    </button>
                    <button class="btn-secondary" onClick={() => addToast({ type: "info", title: "Persistent", message: "This won't auto-dismiss", duration: 0 })}>
                      <i class="i-hugeicons-pin w-4 h-4 text-purple-400" /> Persistent
                    </button>
                  </div>
                  <p class="text-xs text-gray-500 mt-3">Click buttons to show toast notifications</p>
                </Section>
              </Show>

              {/* ==================== ALERTS ==================== */}
              <Show when={activeSection() === "alerts"}>
                <Section title="Alerts">
                  <div class="flex flex-col gap-3 w-full">
                    <div class="p-3 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-start gap-3">
                      <i class="i-hugeicons-information-circle w-5 h-5 text-blue-400 flex-shrink-0" />
                      <p class="text-sm text-blue-300">Info alert with helpful information</p>
                    </div>
                    <div class="p-3 rounded-xl bg-green-500/10 border border-green-500/20 flex items-start gap-3">
                      <i class="i-hugeicons-checkmark-circle-02 w-5 h-5 text-green-400 flex-shrink-0" />
                      <p class="text-sm text-green-300">Success! Operation completed</p>
                    </div>
                    <div class="p-3 rounded-xl bg-yellow-500/10 border border-yellow-500/20 flex items-start gap-3">
                      <i class="i-hugeicons-alert-02 w-5 h-5 text-yellow-400 flex-shrink-0" />
                      <p class="text-sm text-yellow-300">Warning: Please review before continuing</p>
                    </div>
                    <div class="p-3 rounded-xl bg-red-500/10 border border-red-500/20 flex items-start gap-3">
                      <i class="i-hugeicons-alert-circle w-5 h-5 text-red-400 flex-shrink-0" />
                      <p class="text-sm text-red-300">Error: Something went wrong</p>
                    </div>
                  </div>
                </Section>
              </Show>

              {/* ==================== PROGRESS ==================== */}
              <Show when={activeSection() === "progress"}>
                <Section title="Progress Bars">
                  <ComponentBox label="Default progress" vertical>
                    <div class="w-full flex flex-col gap-3">
                      <div class="w-full h-2 bg-gray-700 rounded-full overflow-hidden">
                        <div class="h-full rounded-full bg-[var(--color-primary)] transition-all" style={{ width: `${progressValue()}%` }} />
                      </div>
                      <span class="text-xs text-gray-400">{progressValue()}%</span>
                    </div>
                  </ComponentBox>
                  <ComponentBox label="Sizes" vertical>
                    <div class="w-full flex flex-col gap-3">
                      <div class="w-full h-1 bg-gray-700 rounded-full overflow-hidden">
                        <div class="h-full rounded-full bg-green-500" style={{ width: "40%" }} />
                      </div>
                      <div class="w-full h-2 bg-gray-700 rounded-full overflow-hidden">
                        <div class="h-full rounded-full bg-blue-500" style={{ width: "60%" }} />
                      </div>
                      <div class="w-full h-3 bg-gray-700 rounded-full overflow-hidden">
                        <div class="h-full rounded-full bg-purple-500" style={{ width: "80%" }} />
                      </div>
                    </div>
                  </ComponentBox>
                  <ComponentBox label="With label" vertical>
                    <div class="w-full flex items-center gap-3">
                      <div class="flex-1 h-2 bg-gray-700 rounded-full overflow-hidden">
                        <div class="h-full rounded-full bg-[var(--color-primary)]" style={{ width: "45%" }} />
                      </div>
                      <span class="text-xs text-gray-400 w-12 text-right">45/100</span>
                    </div>
                  </ComponentBox>
                </Section>
              </Show>

              {/* ==================== SPINNERS ==================== */}
              <Show when={activeSection() === "spinners"}>
                <Section title="Spinners">
                  <ComponentBox label="ring-resize">
                    <i class="i-svg-spinners-ring-resize w-4 h-4 text-[var(--color-primary)]" />
                    <i class="i-svg-spinners-ring-resize w-6 h-6 text-[var(--color-primary)]" />
                    <i class="i-svg-spinners-ring-resize w-8 h-8 text-[var(--color-primary)]" />
                  </ComponentBox>
                  <ComponentBox label="6-dots-scale">
                    <i class="i-svg-spinners-6-dots-scale w-4 h-4 text-[var(--color-primary)]" />
                    <i class="i-svg-spinners-6-dots-scale w-6 h-6 text-[var(--color-primary)]" />
                    <i class="i-svg-spinners-6-dots-scale w-8 h-8 text-[var(--color-primary)]" />
                  </ComponentBox>
                  <ComponentBox label="In button">
                    <button class="btn-primary" disabled>
                      <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                      Loading...
                    </button>
                  </ComponentBox>
                </Section>
              </Show>

              {/* ==================== EMPTY STATES ==================== */}
              <Show when={activeSection() === "empty"}>
                <Section title="Empty States">
                  <div class="flex flex-col gap-4 w-full">
                    <div class="card p-8 flex flex-col items-center justify-center gap-3">
                      <i class="i-hugeicons-package w-12 h-12 text-gray-700" />
                      <p class="text-sm text-gray-500">No mods installed</p>
                      <button class="btn-primary btn-sm">
                        <i class="i-hugeicons-add-01 w-4 h-4" />
                        Browse Mods
                      </button>
                    </div>
                    <div class="card p-8 flex flex-col items-center justify-center gap-3">
                      <i class="i-hugeicons-search-01 w-12 h-12 text-gray-700" />
                      <p class="text-sm text-gray-500">No results found</p>
                      <p class="text-xs text-gray-600">Try adjusting your search or filters</p>
                    </div>
                  </div>
                </Section>
              </Show>

              {/* ==================== GRID LAYOUTS ==================== */}
              <Show when={activeSection() === "grid"}>
                <Section title="Grid Layouts">
                  <div class="flex flex-col gap-4 w-full">
                    <ComponentBox label="grid-cols-2" vertical>
                      <div class="grid grid-cols-2 gap-2 w-full">
                        {["A", "B", "C", "D"].map(x => <div class="card p-2 text-center text-xs">{x}</div>)}
                      </div>
                    </ComponentBox>
                    <ComponentBox label="grid-cols-3" vertical>
                      <div class="grid grid-cols-3 gap-2 w-full">
                        {["A", "B", "C", "D", "E", "F"].map(x => <div class="card p-2 text-center text-xs">{x}</div>)}
                      </div>
                    </ComponentBox>
                    <ComponentBox label="grid-cols-4 (responsive)" vertical>
                      <div class="grid grid-cols-2 md:grid-cols-4 gap-2 w-full">
                        {["A", "B", "C", "D", "E", "F", "G", "H"].map(x => <div class="card p-2 text-center text-xs">{x}</div>)}
                      </div>
                    </ComponentBox>
                  </div>
                </Section>
              </Show>

              {/* ==================== DIVIDERS ==================== */}
              <Show when={activeSection() === "dividers"}>
                <Section title="Dividers & Separators">
                  <div class="flex flex-col gap-4 w-full">
                    <ComponentBox label="Horizontal (border-b)" vertical>
                      <div class="w-full">
                        <div class="pb-3 text-sm">Content above</div>
                        <div class="border-b border-gray-700" />
                        <div class="pt-3 text-sm">Content below</div>
                      </div>
                    </ComponentBox>
                    <ComponentBox label="With label" vertical>
                      <div class="w-full flex items-center gap-3">
                        <div class="flex-1 border-b border-gray-700" />
                        <span class="text-xs text-gray-500">OR</span>
                        <div class="flex-1 border-b border-gray-700" />
                      </div>
                    </ComponentBox>
                    <ComponentBox label="Vertical (in flex)" vertical>
                      <div class="flex items-center gap-3 h-8">
                        <span class="text-sm">Left</span>
                        <div class="w-px h-full bg-gray-700" />
                        <span class="text-sm">Right</span>
                      </div>
                    </ComponentBox>
                    <ComponentBox label="Dot separator">
                      <div class="flex items-center gap-2 text-xs text-gray-500">
                        <span>1.20.1</span>
                        <span class="w-1 h-1 rounded-full bg-gray-700" />
                        <span>Fabric</span>
                        <span class="w-1 h-1 rounded-full bg-gray-700" />
                        <span>24 mods</span>
                      </div>
                    </ComponentBox>
                  </div>
                </Section>
              </Show>

              {/* ==================== ANIMATIONS ==================== */}
              <Show when={activeSection() === "animations"}>
                <Section title="Animations (max 100ms)">
                  <ComponentBox label="animate-scale-in" vertical>
                    <button
                      class="btn-secondary btn-sm"
                      onClick={(e) => {
                        const el = e.currentTarget.nextElementSibling as HTMLElement;
                        if (el) { el.classList.remove("animate-scale-in"); void el.offsetWidth; el.classList.add("animate-scale-in"); }
                      }}
                    >
                      Replay
                    </button>
                    <div class="card p-3 w-48 animate-scale-in" style={{ "animation-duration": "0.1s" }}>
                      <span class="text-sm">Scale in</span>
                    </div>
                  </ComponentBox>
                  <ComponentBox label="animate-slide-in-up" vertical>
                    <button
                      class="btn-secondary btn-sm"
                      onClick={(e) => {
                        const el = e.currentTarget.nextElementSibling as HTMLElement;
                        if (el) { el.classList.remove("animate-slide-in-up"); void el.offsetWidth; el.classList.add("animate-slide-in-up"); }
                      }}
                    >
                      Replay
                    </button>
                    <div class="card p-3 w-48 animate-slide-in-up" style={{ "animation-duration": "0.1s" }}>
                      <span class="text-sm">Slide up</span>
                    </div>
                  </ComponentBox>
                  <ComponentBox label="transition-colors (100ms)" vertical>
                    <button class="px-4 py-2 rounded-xl bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition-colors duration-100">
                      Hover me
                    </button>
                  </ComponentBox>
                </Section>
              </Show>

              {/* ==================== TRUNCATION ==================== */}
              <Show when={activeSection() === "truncation"}>
                <Section title="Text Truncation">
                  <ComponentBox label="truncate (single line)" vertical>
                    <div class="w-48 truncate text-sm">
                      This is a very long text that will be truncated with an ellipsis at the end
                    </div>
                  </ComponentBox>
                  <ComponentBox label="line-clamp-2" vertical>
                    <div class="w-48 text-sm text-gray-400" style={{ display: "-webkit-box", "-webkit-line-clamp": "2", "-webkit-box-orient": "vertical", overflow: "hidden" }}>
                      This is a longer text that will be clamped to exactly two lines. Any content beyond that will be hidden with an ellipsis.
                    </div>
                  </ComponentBox>
                </Section>
              </Show>

              {/* ==================== RESPONSIVE ==================== */}
              <Show when={activeSection() === "responsive"}>
                <Section title="Responsive Preview">
                  <div class="flex flex-col gap-3 w-full">
                    <div class="flex gap-2">
                      {[
                        { label: "Mobile", w: "360px" },
                        { label: "Tablet", w: "768px" },
                        { label: "Full", w: "100%" },
                      ].map(bp => (
                        <button
                          class={`btn-sm ${responsiveWidth() === bp.w ? "btn-primary" : "btn-secondary"}`}
                          onClick={() => setResponsiveWidth(bp.w)}
                        >
                          {bp.label}
                        </button>
                      ))}
                    </div>
                    <div
                      class="border border-dashed border-gray-600 rounded-lg p-4 overflow-x-auto transition-all"
                      style={{ width: responsiveWidth(), "max-width": "100%" }}
                    >
                      <div class="flex flex-col gap-3">
                        <div class="flex gap-2 flex-wrap">
                          <button class="btn-primary btn-sm">Primary</button>
                          <button class="btn-secondary btn-sm">Secondary</button>
                          <button class="btn-ghost btn-sm">Ghost</button>
                        </div>
                        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <div class="card p-3">
                            <div class="text-sm font-medium">Card A</div>
                            <div class="text-xs text-gray-500">Responsive grid test</div>
                          </div>
                          <div class="card p-3">
                            <div class="text-sm font-medium">Card B</div>
                            <div class="text-xs text-gray-500">Responsive grid test</div>
                          </div>
                        </div>
                        <input type="text" placeholder="Input field..." class="w-full" />
                      </div>
                    </div>
                    <p class="text-xs text-gray-600">Current width: {responsiveWidth()}</p>
                  </div>
                </Section>
              </Show>

              {/* ==================== INSTANCE CARDS ==================== */}
              <Show when={activeSection() === "instance-cards"}>
                <Section title="Instance Cards">
                  <ComponentBox label="Status variants" vertical>
                    <div class="grid grid-cols-2 gap-2 w-full">
                      {[
                        { name: "Create SMP", version: "1.20.1", loader: "Fabric", status: "running", color: "text-green-400" },
                        { name: "Better MC", version: "1.19.2", loader: "Forge", status: "stopped", color: "text-gray-400" },
                        { name: "Vanilla", version: "1.21", loader: "—", status: "installing", color: "text-blue-400" },
                        { name: "Broken Pack", version: "1.18.2", loader: "Quilt", status: "error", color: "text-red-400" },
                      ].map(inst => (
                        <div class="card p-3 flex items-center gap-3">
                          <div class={`w-2 h-2 rounded-full ${inst.status === "running" ? "bg-green-400" : inst.status === "error" ? "bg-red-400" : inst.status === "installing" ? "bg-blue-400 animate-pulse" : "bg-gray-600"}`} />
                          <div class="flex-1 min-w-0">
                            <div class="text-sm font-medium truncate">{inst.name}</div>
                            <div class="text-xs text-gray-500">{inst.version} · {inst.loader}</div>
                          </div>
                          <span class={`text-xs ${inst.color}`}>{inst.status}</span>
                        </div>
                      ))}
                    </div>
                  </ComponentBox>
                </Section>
              </Show>

              {/* ==================== CONSOLE ==================== */}
              <Show when={activeSection() === "console"}>
                <Section title="Console Output">
                  <ComponentBox label="Server console" vertical>
                    <div class="w-full bg-gray-900 border border-gray-700 rounded-lg p-3 font-mono text-xs space-y-0.5 max-h-48 overflow-y-auto">
                      <div class="text-gray-500">[12:00:01] <span class="text-blue-400">[INFO]</span> Starting Minecraft server on *:25565</div>
                      <div class="text-gray-500">[12:00:02] <span class="text-blue-400">[INFO]</span> Loading properties</div>
                      <div class="text-gray-500">[12:00:03] <span class="text-blue-400">[INFO]</span> Preparing level "world"</div>
                      <div class="text-gray-500">[12:00:05] <span class="text-yellow-400">[WARN]</span> Can't keep up! Is the server overloaded?</div>
                      <div class="text-gray-500">[12:00:06] <span class="text-blue-400">[INFO]</span> Done (5.2s)! For help, type "help"</div>
                      <div class="text-gray-500">[12:01:30] <span class="text-blue-400">[INFO]</span> Player123 joined the game</div>
                      <div class="text-gray-500">[12:05:12] <span class="text-red-400">[ERROR]</span> java.lang.OutOfMemoryError: Java heap space</div>
                    </div>
                  </ComponentBox>
                  <ComponentBox label="Command input" vertical>
                    <div class="w-full flex gap-2">
                      <div class="flex-1 flex items-center bg-gray-900 border border-gray-700 rounded-lg px-3 font-mono text-sm">
                        <span class="text-gray-600 mr-2">&gt;</span>
                        <span class="text-gray-300">say Hello world</span>
                      </div>
                      <button class="btn-primary btn-sm">
                        <i class="i-hugeicons-play w-3.5 h-3.5" />
                      </button>
                    </div>
                  </ComponentBox>
                  <ComponentBox label="Log levels" vertical>
                    <div class="w-full bg-gray-900 border border-gray-700 rounded-lg p-3 font-mono text-xs space-y-1">
                      <div class="flex items-center gap-2">
                        <span class="px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 text-[10px] font-bold">INFO</span>
                        <span class="text-gray-400">Server thread/INFO</span>
                        <span class="text-gray-300">Loading world data</span>
                      </div>
                      <div class="flex items-center gap-2">
                        <span class="px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-400 text-[10px] font-bold">WARN</span>
                        <span class="text-gray-400">Server thread/WARN</span>
                        <span class="text-gray-300">Ambiguity between arguments</span>
                      </div>
                      <div class="flex items-center gap-2">
                        <span class="px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 text-[10px] font-bold">ERROR</span>
                        <span class="text-gray-400">Server thread/ERROR</span>
                        <span class="text-gray-300">Encountered exception during tick</span>
                      </div>
                      <div class="flex items-center gap-2">
                        <span class="px-1.5 py-0.5 rounded bg-green-500/20 text-green-400 text-[10px] font-bold">DEBUG</span>
                        <span class="text-gray-400">Render thread/DEBUG</span>
                        <span class="text-gray-300">Reloading ResourceManager</span>
                      </div>
                    </div>
                  </ComponentBox>
                </Section>
              </Show>

              {/* ==================== BACKGROUNDS ==================== */}
              <Show when={activeSection() === "backgrounds"}>
                <Section title="BackgroundOption">
                  <ComponentBox label="Background selector" vertical>
                    <div class="grid grid-cols-3 gap-3 w-full max-w-lg">
                      <BackgroundOption
                        type="aurora" label="Aurora" active={activeBg() === "aurora"} onClick={() => setActiveBg("aurora")}
                        preview={<div class="w-full h-full bg-gradient-to-br from-teal-900 to-emerald-900" />}
                      />
                      <BackgroundOption
                        type="lines" label="Lines" active={activeBg() === "lines"} onClick={() => setActiveBg("lines")}
                        preview={<div class="w-full h-full bg-gradient-to-br from-blue-900 to-purple-900" />}
                      />
                      <BackgroundOption
                        type="dots" label="Dot Grid" active={activeBg() === "dots"} onClick={() => setActiveBg("dots")}
                        preview={<div class="w-full h-full bg-gradient-to-br from-gray-900 to-gray-800" />}
                      />
                    </div>
                  </ComponentBox>
                </Section>
              </Show>

              {/* ==================== VIEW MODE ==================== */}
              <Show when={activeSection() === "viewmode"}>
                <Section title="ViewModeSwitch">
                  <ComponentBox label="Grid / List" vertical>
                    <ViewModeSwitch value={viewModeDemo()} onChange={setViewModeDemo} modes={["grid", "list"]} />
                    <span class="text-xs text-gray-500">Mode: {viewModeDemo()}</span>
                  </ComponentBox>
                  <ComponentBox label="All modes" vertical>
                    <ViewModeSwitch value={viewModeDemo()} onChange={setViewModeDemo} />
                    <span class="text-xs text-gray-500">Mode: {viewModeDemo()}</span>
                  </ComponentBox>
                  <ComponentBox label="Live preview" vertical>
                    <div class="w-full">
                      <Show when={viewModeDemo() === "grid"}>
                        <div class="grid grid-cols-3 gap-2">
                          {["A", "B", "C", "D", "E", "F"].map(x => <div class="card p-3 text-center text-sm">{x}</div>)}
                        </div>
                      </Show>
                      <Show when={viewModeDemo() === "list"}>
                        <div class="flex flex-col gap-1">
                          {["Item A", "Item B", "Item C", "Item D"].map(x => (
                            <div class="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-800 text-sm">
                              <div class="w-2 h-2 rounded-full bg-green-400" />{x}
                            </div>
                          ))}
                        </div>
                      </Show>
                      <Show when={viewModeDemo() === "compact"}>
                        <div class="flex flex-col">
                          {["Entry A", "Entry B", "Entry C", "Entry D", "Entry E"].map(x => (
                            <div class="flex items-center gap-2 py-1 px-2 text-xs text-gray-400 border-b border-gray-800 last:border-0">
                              <span class="text-gray-300">{x}</span>
                            </div>
                          ))}
                        </div>
                      </Show>
                    </div>
                  </ComponentBox>
                </Section>
              </Show>

              {/* ==================== BULK ACTIONS ==================== */}
              <Show when={activeSection() === "bulk"}>
                <Section title="BulkOperationsToolbar">
                  <ComponentBox label="With actions" vertical>
                    <div class="w-full flex flex-col gap-2">
                      <BulkOperationsToolbar
                        selectedCount={bulkSelected()}
                        onEnableAll={() => addToast({ type: "success", title: "Enable all", duration: 2000 })}
                        onDisableAll={() => addToast({ type: "info", title: "Disable all", duration: 2000 })}
                        onDeleteAll={() => addToast({ type: "error", title: "Delete all", duration: 2000 })}
                        onDeselectAll={() => setBulkSelected(0)}
                      />
                      <Show when={bulkSelected() === 0}>
                        <button class="btn-secondary btn-sm" onClick={() => setBulkSelected(3)}>
                          <i class="i-hugeicons-refresh w-3.5 h-3.5" />
                          Reset selection (3 items)
                        </button>
                      </Show>
                    </div>
                  </ComponentBox>
                  <ComponentBox label="No selection">
                    <div class="w-full">
                      <BulkOperationsToolbar selectedCount={0} onDeselectAll={() => {}} />
                    </div>
                  </ComponentBox>
                </Section>
              </Show>

              {/* ==================== FILE DROP ==================== */}
              <Show when={activeSection() === "filedrop"}>
                <Section title="File Drop Zone">
                  <ComponentBox label="Drop area" vertical>
                    <div class="w-full border-2 border-dashed border-gray-700 rounded-2xl p-8 flex flex-col items-center justify-center gap-3 hover:border-gray-600 transition-colors">
                      <i class="i-hugeicons-upload-02 w-8 h-8 text-gray-600" />
                      <p class="text-sm text-gray-500">Drop .jar or .zip files here</p>
                      <p class="text-xs text-gray-600">or click to browse</p>
                    </div>
                  </ComponentBox>
                  <ComponentBox label="Active drop (dragging)" vertical>
                    <div class="w-full border-2 border-dashed border-[var(--color-primary-border)] rounded-2xl p-8 flex flex-col items-center justify-center gap-3 bg-[var(--color-primary-bg)]">
                      <i class="i-hugeicons-download-02 w-8 h-8 text-[var(--color-primary)]" />
                      <p class="text-sm text-[var(--color-primary)]">Release to install</p>
                    </div>
                  </ComponentBox>
                </Section>
              </Show>

              {/* ==================== ACCENT THEMES ==================== */}
              <Show when={activeSection() === "themes"}>
                <Section title="Accent Themes">
                  <div class="flex flex-col gap-4 w-full">
                    <div class="grid grid-cols-4 sm:grid-cols-8 gap-2">
                      <For each={Object.entries(BUILT_IN_ACCENTS)}>
                        {([id, accent]) => (
                          <button
                            class={`flex flex-col items-center gap-1.5 p-2 rounded-xl transition-colors duration-100 ${
                              getActiveAccent() === id ? "bg-gray-750 ring-2 ring-offset-2 ring-offset-gray-850" : "hover:bg-gray-800"
                            }`}
                            style={{ "--un-ring-color": getActiveAccent() === id ? accent.accent : undefined } as Record<string, string | undefined>}
                            onClick={() => setActiveAccent(id)}
                          >
                            <div class="w-8 h-8 rounded-full border-2 border-gray-700" style={{ "background-color": accent.accent }} />
                            <span class="text-xs text-gray-400">{accent.name}</span>
                          </button>
                        )}
                      </For>
                    </div>
                    <div class="flex gap-3 flex-wrap">
                      <button class="btn-primary btn-sm">Primary Button</button>
                      <button class="btn-primary">Primary Normal</button>
                      <div class="flex items-center gap-2 px-3 py-1.5 bg-[var(--color-primary-bg)] border border-[var(--color-primary-border)] rounded-xl text-sm" style={{ color: "var(--color-primary)" }}>
                        Accent badge
                      </div>
                      <div class="w-32 h-2 bg-gray-700 rounded-full overflow-hidden">
                        <div class="h-full rounded-full" style={{ width: "65%", "background-color": "var(--color-primary)" }} />
                      </div>
                    </div>
                  </div>
                </Section>
              </Show>

              {/* ==================== THEME GENERATOR ==================== */}
              <Show when={activeSection() === "theme-gen"}>
                <Section title="Theme Generator">
                  <div class="flex flex-col gap-4 w-full max-w-md">
                    <p class="text-sm text-gray-400">
                      Generate a custom accent theme from any color using <code class="text-gray-300">generateAccentFromColor()</code>.
                    </p>
                    <div class="flex items-center gap-3">
                      <div
                        class="w-10 h-10 rounded-lg cursor-pointer border border-gray-700 overflow-hidden flex-shrink-0"
                        style={{ "background-color": customColor() }}
                        onClick={() => {
                          const input = document.getElementById("uikit-color-picker") as HTMLInputElement;
                          input?.click();
                        }}
                      >
                        <input
                          id="uikit-color-picker"
                          type="color"
                          value={customColor()}
                          onInput={(e) => {
                            setCustomColor(e.currentTarget.value);
                            generateAccentFromColor("Custom", e.currentTarget.value);
                          }}
                          class="opacity-0 w-full h-full cursor-pointer"
                        />
                      </div>
                      <input
                        type="text"
                        value={customColor()}
                        onInput={(e) => {
                          const v = e.currentTarget.value;
                          setCustomColor(v);
                          if (/^#[0-9a-fA-F]{6}$/.test(v)) {
                            generateAccentFromColor("Custom", v);
                          }
                        }}
                        class="w-32 font-mono text-sm"
                        maxLength={7}
                      />
                      <button
                        class="btn-primary btn-sm"
                        onClick={() => {
                          generateAccentFromColor("Custom", customColor());
                          addToast({ type: "success", title: "Applied!", message: `Color: ${customColor()}`, duration: 2000 });
                        }}
                      >
                        Apply
                      </button>
                    </div>
                    <div class="flex gap-2 flex-wrap">
                      {["#ff6600", "#e91e63", "#00bcd4", "#4caf50", "#9c27b0", "#ff5722"].map(c => (
                        <button
                          class="w-8 h-8 rounded-full border-2 border-gray-700 hover:scale-110 transition-transform"
                          style={{ "background-color": c }}
                          onClick={() => {
                            setCustomColor(c);
                            generateAccentFromColor("Custom", c);
                          }}
                        />
                      ))}
                    </div>
                    <div class="card p-4">
                      <p class="text-sm text-gray-400 mb-2">Preview with current accent:</p>
                      <div class="flex gap-2 flex-wrap items-center">
                        <button class="btn-primary btn-sm">Button</button>
                        <span class="px-2.5 text-xs rounded-full bg-[var(--color-primary-bg)] text-[var(--color-primary)] border border-[var(--color-primary-border)] inline-flex items-center h-6">Badge</span>
                        <div class="w-24 h-2 bg-gray-700 rounded-full overflow-hidden">
                          <div class="h-full rounded-full" style={{ width: "75%", "background-color": "var(--color-primary)" }} />
                        </div>
                      </div>
                    </div>
                  </div>
                </Section>
              </Show>

              {/* ==================== KEYBOARD SHORTCUTS ==================== */}
              <Show when={activeSection() === "shortcuts"}>
                <Section title="Keyboard Shortcuts">
                  <div class="flex flex-col gap-3 w-full">
                    {[
                      { keys: ["Ctrl", "Shift", "D"], desc: "Developer Console" },
                      { keys: ["Ctrl", "Shift", "U"], desc: "UI Kit" },
                      { keys: ["Ctrl", "Shift", "T"], desc: "Dev Tests" },
                      { keys: ["Ctrl", "F"], desc: "Search" },
                      { keys: ["Esc"], desc: "Close / Cancel" },
                      { keys: ["Enter"], desc: "Confirm" },
                    ].map(shortcut => (
                      <div class="flex items-center justify-between py-1.5">
                        <span class="text-sm text-gray-300">{shortcut.desc}</span>
                        <div class="flex items-center gap-1">
                          {shortcut.keys.map((key, i) => (
                            <>
                              {i > 0 && <span class="text-gray-600 text-xs">+</span>}
                              <kbd class="px-2 py-0.5 bg-gray-800 border border-gray-700 rounded text-xs text-gray-300 font-mono min-w-[1.75rem] text-center">{key}</kbd>
                            </>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </Section>
              </Show>

              {/* ==================== FOCUS STATES ==================== */}
              <Show when={activeSection() === "focus"}>
                <Section title="Focus States">
                  <ComponentBox label="Tab through these elements">
                    <button class="btn-primary btn-sm">Button 1</button>
                    <button class="btn-secondary btn-sm">Button 2</button>
                    <input type="text" placeholder="Input" class="w-32" />
                    <Toggle checked={false} onChange={() => {}} />
                  </ComponentBox>
                  <p class="text-xs text-gray-500 mt-2">
                    Focus ring uses <code class="text-gray-400">--color-primary</code> and adapts to accent theme
                  </p>
                </Section>
              </Show>

            </div>
          </main>
        </div>

        {/* Footer */}
        <div class="flex items-center justify-between p-4 border-t border-gray-700 flex-shrink-0">
          <p class="text-sm text-gray-500">
            Press <kbd class="px-1.5 py-0.5 bg-gray-800 rounded text-xs">Ctrl+Shift+U</kbd> to toggle
          </p>
          <button class="btn-secondary" onClick={props.onClose}>
            Close
          </button>
        </div>
      </div>
    </ModalWrapper>
  );
}

export default UIKit;
