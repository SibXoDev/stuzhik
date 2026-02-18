import { For, Show, createMemo } from "solid-js";

export interface RangeSliderProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  showTicks?: boolean;
  showLabels?: boolean;
  ticks?: number[];
  labelTicks?: number[]; // Subset of ticks to show labels for (to avoid overlap)
  formatLabel?: (value: number) => string;
  disabled?: boolean;
  class?: string;
}

export function RangeSlider(props: RangeSliderProps) {
  const min = () => props.min ?? 0;
  const max = () => props.max ?? 100;
  const step = () => props.step ?? 1;

  const tickValues = createMemo(() => {
    if (props.ticks) return props.ticks;

    // Always generate ticks based on step if specified
    const range = max() - min();
    const stepVal = step();
    const ticks: number[] = [];

    // Generate ticks from min to max using step
    for (let v = min(); v <= max(); v += stepVal) {
      ticks.push(v);
    }

    // Limit to reasonable number of ticks (max 20)
    if (ticks.length > 20) {
      // If too many ticks, use quartiles instead
      return [min(), min() + range * 0.25, min() + range * 0.5, min() + range * 0.75, max()];
    }

    return ticks;
  });

  const getTickPercent = (tickValue: number) => {
    return ((tickValue - min()) / (max() - min())) * 100;
  };

  const formatLabel = (value: number) => {
    if (props.formatLabel) return props.formatLabel(value);
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  };

  const fillPercent = createMemo(() => {
    return ((props.value - min()) / (max() - min())) * 100;
  });

  // Use labelTicks if provided, otherwise use all tickValues
  const labelTickValues = createMemo(() => {
    return props.labelTicks ?? tickValues();
  });

  return (
    <div class={`flex flex-col ${props.class || ""}`}>
      {/* Track container */}
      <div class="h-5 flex items-center">
        {/* Background track */}
        <div class="absolute inset-x-0 top-1/2 h-1 bg-gray-700 rounded-full -translate-y-1/2">
          {/* Fill */}
          <div
            class="h-full bg-[var(--color-primary)] rounded-full"
            style={{ width: `${fillPercent()}%` }}
          />
        </div>

        {/* Tick marks */}
        <Show when={props.showTicks}>
          <For each={tickValues()}>
            {(tick) => (
              <div
                class="absolute top-1/2 w-px h-2.5 bg-gray-500 -translate-y-1/2"
                style={{ left: `${getTickPercent(tick)}%` }}
              />
            )}
          </For>
        </Show>

        {/* Thumb */}
        <div
          class={`absolute top-1/2 w-3.5 h-3.5 bg-[var(--color-primary)] rounded-full border-2 border-white shadow pointer-events-none ${
            props.disabled ? "opacity-50" : ""
          }`}
          style={{ left: `${fillPercent()}%`, transform: "translate(-50%, -50%)" }}
        />

        {/* Invisible input - reduced height to match track */}
        <input
          type="range"
          min={min()}
          max={max()}
          step={step()}
          value={props.value}
          disabled={props.disabled}
          onInput={(e) => props.onChange(parseFloat(e.currentTarget.value))}
          class="absolute inset-x-0 top-1/2 -translate-y-1/2 w-full h-1 opacity-0 cursor-pointer disabled:cursor-not-allowed"
          style={{ margin: "0" }}
        />
      </div>

      {/* Labels - positioned absolutely by tick percent, using labelTicks */}
      <Show when={props.showLabels}>
        <div class="h-3.5 mt-0.5">
          <For each={labelTickValues()}>
            {(tick) => (
              <span
                class={`absolute text-xs -translate-x-1/2 text-center ${tick <= props.value ? "text-[var(--color-primary)]" : "text-gray-500"}`}
                style={{ left: `${getTickPercent(tick)}%` }}
              >
                {formatLabel(tick)}
              </span>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

export default RangeSlider;
