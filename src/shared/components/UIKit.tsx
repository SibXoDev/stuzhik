import { createSignal, For, Show, JSX } from "solid-js";
import { Toggle, Dropdown, Pagination, ModalWrapper, Tooltip, RangeSlider, Select, Tabs, Skeleton, SkeletonCard, SkeletonList } from "../ui";
import { addToast } from "./Toast";

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

export function UIKit(props: { onClose: () => void }) {
  // State for interactive demos
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

  return (
    <ModalWrapper maxWidth="max-w-6xl">
      <div class="flex flex-col h-full max-h-[85vh]">
        {/* Header - fixed */}
        <div class="flex items-center justify-between p-4 border-b border-gray-700 flex-shrink-0">
          <div class="flex items-center gap-3">
            <i class="i-hugeicons-paint-board w-6 h-6 text-purple-400" />
            <div>
              <h2 class="text-xl font-bold">UI Kit</h2>
              <p class="text-sm text-gray-500">Component showcase (dev mode only)</p>
            </div>
          </div>
          <button class="btn-close" onClick={props.onClose}>
            <i class="i-hugeicons-cancel-01 w-5 h-5" />
          </button>
        </div>

        {/* Content - scrollable */}
        <div class="flex-1 overflow-y-auto p-4 min-h-0">
          <div class="flex flex-col gap-8">

            {/* BUTTONS */}
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

            {/* CARDS */}
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

            {/* INPUTS */}
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

              <ComponentBox label="Disabled input" vertical>
                <input
                  type="text"
                  placeholder="Disabled"
                  disabled
                  class="w-64"
                />
              </ComponentBox>

              <ComponentBox label="Number input" vertical>
                <input
                  type="number"
                  placeholder="0"
                  class="w-32"
                />
              </ComponentBox>

              <ComponentBox label="Textarea" vertical>
                <textarea
                  placeholder="Multi-line text..."
                  class="w-64 h-20"
                />
              </ComponentBox>

              <ComponentBox label="Input group" vertical>
                <div class="input-group w-64">
                  <span class="input-addon">https://</span>
                  <input type="text" placeholder="example.com" />
                </div>
              </ComponentBox>
            </Section>

            {/* CHECKBOXES & RADIO */}
            <Section title="Checkbox & Radio">
              <ComponentBox label="Checkbox">
                <label class="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={checkboxState()}
                    onChange={(e) => setCheckboxState(e.currentTarget.checked)}
                  />
                  <span class="text-sm">Check me</span>
                </label>
              </ComponentBox>

              <ComponentBox label="Checkbox disabled">
                <label class="flex items-center gap-2">
                  <input type="checkbox" disabled />
                  <span class="text-sm text-gray-500">Disabled</span>
                </label>
                <label class="flex items-center gap-2">
                  <input type="checkbox" checked disabled />
                  <span class="text-sm text-gray-500">Checked disabled</span>
                </label>
              </ComponentBox>

              <ComponentBox label="Radio group" vertical>
                <div class="flex flex-col gap-2">
                  <For each={["option1", "option2", "option3"]}>
                    {(opt) => (
                      <label class="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="demo-radio"
                          checked={radioState() === opt}
                          onChange={() => setRadioState(opt)}
                        />
                        <span class="text-sm">Option {opt.slice(-1)}</span>
                      </label>
                    )}
                  </For>
                </div>
              </ComponentBox>
            </Section>

            {/* TOGGLE */}
            <Section title="Toggle">
              <ComponentBox label="Toggle component">
                <Toggle
                  checked={toggleState()}
                  onChange={setToggleState}
                />
                <span class="text-sm">{toggleState() ? "On" : "Off"}</span>
              </ComponentBox>

              <ComponentBox label="Toggle loading">
                <Toggle
                  checked={toggleLoading()}
                  onChange={setToggleLoading}
                  loading={true}
                />
              </ComponentBox>

              <ComponentBox label="Toggle disabled">
                <Toggle
                  checked={false}
                  onChange={() => {}}
                  disabled={true}
                />
              </ComponentBox>
            </Section>

            {/* RANGE SLIDER */}
            <Section title="Range Slider">
              <ComponentBox label="Basic (native input)" vertical>
                <div class="w-64 flex flex-col gap-2">
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={rangeValue()}
                    onInput={(e) => setRangeValue(parseInt(e.currentTarget.value))}
                  />
                  <span class="text-sm text-gray-400">Value: {rangeValue()}</span>
                </div>
              </ComponentBox>

              <ComponentBox label="RangeSlider with ticks" vertical>
                <RangeSlider
                  value={rangeValue()}
                  onChange={setRangeValue}
                  min={0}
                  max={100}
                  step={25}
                  showTicks
                  showLabels
                  class="w-64"
                />
              </ComponentBox>

              <ComponentBox label="RangeSlider custom ticks" vertical>
                <RangeSlider
                  value={rangeValue()}
                  onChange={setRangeValue}
                  min={0}
                  max={100}
                  ticks={[0, 20, 40, 60, 80, 100]}
                  showTicks
                  showLabels
                  formatLabel={(v) => `${v}%`}
                  class="w-64"
                />
              </ComponentBox>

              <ComponentBox label="RangeSlider (no labels)" vertical>
                <RangeSlider
                  value={rangeValue()}
                  onChange={setRangeValue}
                  min={0}
                  max={100}
                  step={10}
                  showTicks
                  class="w-64"
                />
              </ComponentBox>
            </Section>

            {/* PROGRESS BAR */}
            <Section title="Progress Bar">
              <ComponentBox label="Basic progress" vertical>
                <div class="w-64 flex flex-col gap-2">
                  <div class="h-2 bg-gray-700 rounded-full overflow-hidden">
                    <div
                      class="h-full bg-blue-500 rounded-full transition-all duration-100"
                      style={{ width: `${progressValue()}%` }}
                    />
                  </div>
                  <span class="text-sm text-gray-400">{progressValue()}%</span>
                </div>
              </ComponentBox>

              <ComponentBox label="Progress colors" vertical>
                <div class="w-64 flex flex-col gap-3">
                  <div class="h-2 bg-gray-700 rounded-full overflow-hidden">
                    <div class="h-full bg-green-500 rounded-full" style={{ width: "80%" }} />
                  </div>
                  <div class="h-2 bg-gray-700 rounded-full overflow-hidden">
                    <div class="h-full bg-yellow-500 rounded-full" style={{ width: "60%" }} />
                  </div>
                  <div class="h-2 bg-gray-700 rounded-full overflow-hidden">
                    <div class="h-full bg-red-500 rounded-full" style={{ width: "40%" }} />
                  </div>
                </div>
              </ComponentBox>

              <ComponentBox label="Progress with label" vertical>
                <div class="w-64 flex flex-col gap-1">
                  <div class="flex justify-between text-xs">
                    <span class="text-gray-400">Downloading...</span>
                    <span class="text-blue-400 font-medium">{progressValue()}%</span>
                  </div>
                  <div class="h-2.5 bg-gray-700 rounded-full overflow-hidden">
                    <div
                      class="h-full bg-blue-500 rounded-full transition-all duration-100"
                      style={{ width: `${progressValue()}%` }}
                    />
                  </div>
                </div>
              </ComponentBox>

              <ComponentBox label="Animated (indeterminate)" vertical>
                <div class="w-64 h-2 bg-gray-700 rounded-full overflow-hidden">
                  <div class="h-full w-1/3 bg-blue-500 rounded-full animate-pulse" />
                </div>
              </ComponentBox>
            </Section>

            {/* SPINNERS / LOADERS */}
            <Section title="Spinners & Loaders">
              <ComponentBox label="Dots spinner">
                <i class="i-svg-spinners-6-dots-scale w-6 h-6 text-blue-400" />
              </ComponentBox>

              <ComponentBox label="Ring spinner">
                <i class="i-svg-spinners-ring-resize w-6 h-6 text-blue-400" />
              </ComponentBox>

              <ComponentBox label="Pulse dots">
                <i class="i-svg-spinners-3-dots-scale w-8 h-8 text-gray-400" />
              </ComponentBox>

              <ComponentBox label="Sizes">
                <i class="i-svg-spinners-6-dots-scale w-4 h-4 text-blue-400" />
                <i class="i-svg-spinners-6-dots-scale w-6 h-6 text-blue-400" />
                <i class="i-svg-spinners-6-dots-scale w-8 h-8 text-blue-400" />
              </ComponentBox>

              <ComponentBox label="In button">
                <button class="btn-primary" disabled>
                  <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                  Loading...
                </button>
              </ComponentBox>
            </Section>

            {/* DROPDOWN */}
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
                        <button
                          class="dropdown-item"
                          onClick={() => setDropdownOpen(false)}
                        >
                          {opt}
                        </button>
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

            {/* SELECT */}
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

            {/* TABS */}
            <Section title="Tabs">
              <ComponentBox label="Default tabs" vertical>
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
                  <Show when={activeTab() === "tab1"}>
                    <p class="text-sm text-gray-400">General content</p>
                  </Show>
                  <Show when={activeTab() === "tab2"}>
                    <p class="text-sm text-gray-400">Settings content</p>
                  </Show>
                </div>
              </ComponentBox>

              <ComponentBox label="Pills variant" vertical>
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

              <ComponentBox label="Underline variant" vertical>
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

              <ComponentBox label="With icons and badges" vertical>
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
            </Section>

            {/* TOAST */}
            <Section title="Toast Notifications">
              <div class="flex flex-wrap gap-3">
                <button
                  class="btn-secondary"
                  onClick={() => addToast({
                    type: "info",
                    title: "Info Toast",
                    message: "This is an informational message",
                    duration: 3000,
                  })}
                >
                  <i class="i-hugeicons-information-circle w-4 h-4 text-blue-400" />
                  Show Info
                </button>

                <button
                  class="btn-secondary"
                  onClick={() => addToast({
                    type: "success",
                    title: "Success!",
                    message: "Operation completed successfully",
                    duration: 3000,
                  })}
                >
                  <i class="i-hugeicons-checkmark-circle-02 w-4 h-4 text-green-400" />
                  Show Success
                </button>

                <button
                  class="btn-secondary"
                  onClick={() => addToast({
                    type: "warning",
                    title: "Warning",
                    message: "Please check your settings",
                    duration: 3000,
                  })}
                >
                  <i class="i-hugeicons-alert-02 w-4 h-4 text-amber-400" />
                  Show Warning
                </button>

                <button
                  class="btn-secondary"
                  onClick={() => addToast({
                    type: "error",
                    title: "Error",
                    message: "Something went wrong",
                    duration: 3000,
                  })}
                >
                  <i class="i-hugeicons-cancel-circle w-4 h-4 text-red-400" />
                  Show Error
                </button>

                <button
                  class="btn-secondary"
                  onClick={() => addToast({
                    type: "info",
                    title: "Persistent Toast",
                    message: "This won't auto-dismiss",
                    duration: 0,
                  })}
                >
                  <i class="i-hugeicons-pin w-4 h-4 text-purple-400" />
                  Persistent
                </button>
              </div>
              <p class="text-xs text-gray-500 mt-3">
                Click buttons to show toast notifications in the bottom-right corner
              </p>
            </Section>

            {/* SKELETON */}
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
                <div class="w-64">
                  <SkeletonCard />
                </div>
              </ComponentBox>

              <ComponentBox label="List skeleton" vertical>
                <div class="w-64">
                  <SkeletonList count={3} />
                </div>
              </ComponentBox>

              <ComponentBox label="Button skeleton" vertical>
                <div class="flex gap-2">
                  <Skeleton variant="button" width="100px" />
                  <Skeleton variant="button" width="80px" />
                </div>
              </ComponentBox>
            </Section>

            {/* PAGINATION */}
            <Section title="Pagination">
              <ComponentBox label="Pagination component" vertical>
                <Pagination
                  currentPage={paginationPage()}
                  totalPages={10}
                  onPageChange={setPaginationPage}
                />
                <span class="text-sm text-gray-400">Page {paginationPage() + 1} of 10</span>
              </ComponentBox>

              <ComponentBox label="Many pages (78)" vertical>
                <Pagination
                  currentPage={paginationPage()}
                  totalPages={78}
                  onPageChange={setPaginationPage}
                />
              </ComponentBox>
            </Section>

            {/* BADGES / PILLS */}
            <Section title="Badges">
              <ComponentBox label="Status badges (rounded-full)">
                <span class="px-2.5 py-0.5 text-xs font-medium rounded-full bg-green-500/20 text-green-400">
                  Running
                </span>
                <span class="px-2.5 py-0.5 text-xs font-medium rounded-full bg-gray-500/20 text-gray-400">
                  Stopped
                </span>
                <span class="px-2.5 py-0.5 text-xs font-medium rounded-full bg-yellow-500/20 text-yellow-400">
                  Installing
                </span>
                <span class="px-2.5 py-0.5 text-xs font-medium rounded-full bg-red-500/20 text-red-400">
                  Error
                </span>
              </ComponentBox>

              <ComponentBox label="Tag badges (rounded-full)">
                <span class="px-2.5 py-0.5 text-xs font-medium rounded-full bg-blue-500/20 text-blue-400 border border-blue-500/30">
                  Forge
                </span>
                <span class="px-2.5 py-0.5 text-xs font-medium rounded-full bg-purple-500/20 text-purple-400 border border-purple-500/30">
                  Fabric
                </span>
                <span class="px-2.5 py-0.5 text-xs font-medium rounded-full bg-orange-500/20 text-orange-400 border border-orange-500/30">
                  NeoForge
                </span>
                <span class="px-2.5 py-0.5 text-xs font-medium rounded-full bg-cyan-500/20 text-cyan-400 border border-cyan-500/30">
                  Quilt
                </span>
              </ComponentBox>

              <ComponentBox label="Count badges">
                <span class="px-1.5 py-0.5 text-xs font-medium rounded-full bg-blue-600 text-white min-w-[1.25rem] text-center">
                  5
                </span>
                <span class="px-1.5 py-0.5 text-xs font-medium rounded-full bg-red-600 text-white min-w-[1.25rem] text-center">
                  99+
                </span>
              </ComponentBox>
            </Section>

            {/* TOOLTIPS */}
            <Section title="Tooltips (custom component)">
              <ComponentBox label="Tooltip positions">
                <Tooltip text="Tooltip on top" position="top">
                  <button class="btn-secondary">Top</button>
                </Tooltip>
                <Tooltip text="Tooltip on bottom" position="bottom">
                  <button class="btn-secondary">Bottom</button>
                </Tooltip>
                <Tooltip text="Tooltip on left" position="left">
                  <button class="btn-secondary">Left</button>
                </Tooltip>
                <Tooltip text="Tooltip on right" position="right">
                  <button class="btn-secondary">Right</button>
                </Tooltip>
              </ComponentBox>

              <ComponentBox label="Icon button with tooltip">
                <Tooltip text="Settings" position="bottom">
                  <button class="btn-ghost" data-icon-only="true">
                    <i class="i-hugeicons-settings-02 w-4 h-4" />
                  </button>
                </Tooltip>
                <Tooltip text="Download" position="bottom">
                  <button class="btn-ghost" data-icon-only="true">
                    <i class="i-hugeicons-download-02 w-4 h-4" />
                  </button>
                </Tooltip>
              </ComponentBox>
            </Section>

            {/* ALERTS */}
            <Section title="Alerts">
              <div class="flex flex-col gap-3 w-full">
                <div class="p-3 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-start gap-3">
                  <i class="i-hugeicons-information-circle w-5 h-5 text-blue-400 flex-shrink-0" />
                  <div>
                    <p class="text-sm text-blue-300">Info alert with helpful information</p>
                  </div>
                </div>

                <div class="p-3 rounded-xl bg-green-500/10 border border-green-500/20 flex items-start gap-3">
                  <i class="i-hugeicons-checkmark-circle-02 w-5 h-5 text-green-400 flex-shrink-0" />
                  <div>
                    <p class="text-sm text-green-300">Success! Operation completed</p>
                  </div>
                </div>

                <div class="p-3 rounded-xl bg-yellow-500/10 border border-yellow-500/20 flex items-start gap-3">
                  <i class="i-hugeicons-alert-02 w-5 h-5 text-yellow-400 flex-shrink-0" />
                  <div>
                    <p class="text-sm text-yellow-300">Warning: Please review before continuing</p>
                  </div>
                </div>

                <div class="p-3 rounded-xl bg-red-500/10 border border-red-500/20 flex items-start gap-3">
                  <i class="i-hugeicons-alert-circle w-5 h-5 text-red-400 flex-shrink-0" />
                  <div>
                    <p class="text-sm text-red-300">Error: Something went wrong</p>
                  </div>
                </div>
              </div>
            </Section>

            {/* ICONS */}
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
                ]}>
                  {(item) => (
                    <div class="flex flex-col items-center gap-1">
                      <i class={`${item.icon} w-5 h-5 text-gray-300`} />
                      <span class="text-xs text-gray-500">{item.name}</span>
                    </div>
                  )}
                </For>
              </div>
            </Section>

            {/* TYPOGRAPHY */}
            <Section title="Typography">
              <div class="flex flex-col gap-2 w-full">
                <h1 class="text-2xl font-bold">Heading 1 (text-2xl font-bold)</h1>
                <h2 class="text-xl font-bold">Heading 2 (text-xl font-bold)</h2>
                <h3 class="text-lg font-semibold">Heading 3 (text-lg font-semibold)</h3>
                <p class="text-base">Body text (text-base)</p>
                <p class="text-sm text-gray-400">Secondary text (text-sm text-gray-400)</p>
                <p class="text-xs text-gray-500">Caption text (text-xs text-gray-500)</p>
                <code class="text-sm">Inline code</code>
              </div>
            </Section>

            {/* SPACING DEMO */}
            <Section title="Spacing (gap classes)">
              <div class="flex flex-col gap-4 w-full">
                <div class="flex flex-col gap-1">
                  <span class="text-xs text-gray-500">gap-1 (4px)</span>
                  <div class="flex gap-1">
                    <div class="w-8 h-8 bg-blue-600 rounded" />
                    <div class="w-8 h-8 bg-blue-600 rounded" />
                    <div class="w-8 h-8 bg-blue-600 rounded" />
                  </div>
                </div>

                <div class="flex flex-col gap-1">
                  <span class="text-xs text-gray-500">gap-2 (8px)</span>
                  <div class="flex gap-2">
                    <div class="w-8 h-8 bg-green-600 rounded" />
                    <div class="w-8 h-8 bg-green-600 rounded" />
                    <div class="w-8 h-8 bg-green-600 rounded" />
                  </div>
                </div>

                <div class="flex flex-col gap-1">
                  <span class="text-xs text-gray-500">gap-3 (12px)</span>
                  <div class="flex gap-3">
                    <div class="w-8 h-8 bg-purple-600 rounded" />
                    <div class="w-8 h-8 bg-purple-600 rounded" />
                    <div class="w-8 h-8 bg-purple-600 rounded" />
                  </div>
                </div>

                <div class="flex flex-col gap-1">
                  <span class="text-xs text-gray-500">gap-4 (16px)</span>
                  <div class="flex gap-4">
                    <div class="w-8 h-8 bg-amber-600 rounded" />
                    <div class="w-8 h-8 bg-amber-600 rounded" />
                    <div class="w-8 h-8 bg-amber-600 rounded" />
                  </div>
                </div>
              </div>
            </Section>

          </div>
        </div>

        {/* Footer - fixed */}
        <div class="flex items-center justify-between p-4 border-t border-gray-700 flex-shrink-0">
          <p class="text-sm text-gray-500">
            Press <kbd class="px-1.5 py-0.5 bg-gray-800 rounded text-xs">Ctrl+Shift+U</kbd> to toggle UI Kit
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
