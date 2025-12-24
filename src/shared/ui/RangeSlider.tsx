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

    const range = max() - min();
    const stepVal = step();

    if (stepVal > 1 && range / stepVal <= 10) {
      const ticks: number[] = [];
      for (let v = min(); v <= max(); v += stepVal) {
        ticks.push(v);
      }
      return ticks;
    }

    return [min(), min() + range * 0.25, min() + range * 0.5, min() + range * 0.75, max()];
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

  return (
    <div class={`flex flex-col gap-1 ${props.class || ""}`}>
      {/* Track container */}
      <div class="h-5 flex items-center" style={{ position: "relative" }}>
        {/* Background track */}
        <div class="absolute inset-x-0 top-1/2 h-1 bg-gray-700 rounded-full" style={{ transform: "translateY(-50%)" }}>
          {/* Fill */}
          <div
            class="h-full bg-blue-500 rounded-full"
            style={{ width: `${fillPercent()}%` }}
          />
        </div>

        {/* Tick marks */}
        <Show when={props.showTicks}>
          <For each={tickValues()}>
            {(tick) => (
              <div
                class="absolute top-1/2 w-px h-2.5 bg-gray-500"
                style={{ left: `${getTickPercent(tick)}%`, transform: "translateY(-50%)" }}
              />
            )}
          </For>
        </Show>

        {/* Thumb */}
        <div
          class={`absolute top-1/2 w-3.5 h-3.5 bg-blue-500 rounded-full border-2 border-white shadow pointer-events-none ${
            props.disabled ? "opacity-50" : ""
          }`}
          style={{ left: `${fillPercent()}%`, transform: "translate(-50%, -50%)" }}
        />

        {/* Invisible input */}
        <input
          type="range"
          min={min()}
          max={max()}
          step={step()}
          value={props.value}
          disabled={props.disabled}
          onInput={(e) => props.onChange(parseFloat(e.currentTarget.value))}
          class="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
          style={{ margin: "0" }}
        />
      </div>

      {/* Labels */}
      <Show when={props.showLabels}>
        <div class="flex justify-between">
          <For each={tickValues()}>
            {(tick) => (
              <span class={`text-xs ${tick <= props.value ? "text-blue-400" : "text-gray-500"}`}>
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
