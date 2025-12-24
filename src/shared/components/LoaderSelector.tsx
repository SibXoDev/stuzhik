import { createSignal, For, Show } from "solid-js";
import type { LoaderType } from "../types";
import Dropdown from "../ui/Dropdown";

// Official loader icons
import fabricIcon from "../../assets/loaders/fabric.png";
import forgeIcon from "../../assets/loaders/forge.svg";
import neoforgeIcon from "../../assets/loaders/neoforge.png";
import quiltIcon from "../../assets/loaders/quilt.svg";
import vanillaIcon from "../../assets/loaders/vanilla.svg";

interface Props {
  value: LoaderType;
  onChange: (loader: LoaderType) => void;
  disabled?: boolean;
}

const LOADER_ICONS: Record<string, string> = {
  fabric: fabricIcon,
  forge: forgeIcon,
  neoforge: neoforgeIcon,
  quilt: quiltIcon,
  vanilla: vanillaIcon,
};

// Official loader icons
// Exported for use in other components
export const LoaderIcon = (props: { loader: string; class?: string }) => {
  const iconClass = () => props.class || "w-5 h-5";
  const loaderKey = () => props.loader?.toLowerCase() || "vanilla";
  const iconSrc = () => LOADER_ICONS[loaderKey()] || LOADER_ICONS.vanilla;

  return (
    <img
      src={iconSrc()}
      alt={loaderKey()}
      class={`${iconClass()} object-contain`}
    />
  );
};

interface LoaderInfo {
  id: LoaderType;
  name: string;
  description: string;
  color: string;
}

const LOADERS: LoaderInfo[] = [
  {
    id: "vanilla",
    name: "Vanilla",
    description: "Чистый Minecraft без модов",
    color: "text-green-400",
  },
  {
    id: "forge",
    name: "Forge",
    description: "Классический загрузчик, большинство модов",
    color: "text-amber-400",
  },
  {
    id: "neoforge",
    name: "NeoForge",
    description: "Современный форк Forge для 1.20.1+",
    color: "text-rose-400",
  },
  {
    id: "fabric",
    name: "Fabric",
    description: "Лёгкий и быстрый, оптимизация",
    color: "text-stone-300",
  },
  {
    id: "quilt",
    name: "Quilt",
    description: "Форк Fabric с дополнительными функциями",
    color: "text-purple-400",
  },
];

function LoaderSelector(props: Props) {
  const [showDropdown, setShowDropdown] = createSignal(false);

  const selectedLoader = () => LOADERS.find(l => l.id === props.value) || LOADERS[0];

  const handleSelect = (loader: LoaderType) => {
    props.onChange(loader);
    setShowDropdown(false);
  };

  const triggerButton = (
    <button
      type="button"
      class="flex items-center justify-between w-full px-3 py-2.5 bg-gray-850 border border-gray-700 rounded-2xl hover:border-gray-600 transition-colors"
      onClick={() => setShowDropdown(!showDropdown())}
      disabled={props.disabled}
    >
      <div class="flex items-center gap-3">
        <LoaderIcon loader={props.value} class="w-6 h-6" />
        <div class="text-left">
          <div class={`font-medium ${selectedLoader().color}`}>
            {selectedLoader().name}
          </div>
          <div class="text-xs text-gray-500 truncate max-w-[180px]">
            {selectedLoader().description}
          </div>
        </div>
      </div>
      <i class={`${showDropdown() ? "i-hugeicons-arrow-up-01" : "i-hugeicons-arrow-down-01"} w-5 h-5 text-gray-400`} />
    </button>
  );

  return (
    <Dropdown
      trigger={triggerButton}
      open={showDropdown()}
      onClose={() => setShowDropdown(false)}
      disabled={props.disabled}
    >
      <div class="p-1">
        <For each={LOADERS}>
          {(loader) => (
            <button
              type="button"
              class={`w-full px-3 py-2.5 flex items-center gap-3 hover:bg-gray-700/50 transition-colors rounded-2xl ${
                props.value === loader.id ? "bg-blue-600/20" : ""
              }`}
              onClick={() => handleSelect(loader.id)}
            >
              <LoaderIcon loader={loader.id} class="w-6 h-6 flex-shrink-0" />
              <div class="flex-1 text-left min-w-0">
                <div class={`font-medium ${loader.color}`}>{loader.name}</div>
                <div class="text-xs text-gray-500 truncate">{loader.description}</div>
              </div>
              <Show when={props.value === loader.id}>
                <i class="i-hugeicons-checkmark-circle-02 w-5 h-5 text-blue-400 flex-shrink-0" />
              </Show>
            </button>
          )}
        </For>
      </div>
    </Dropdown>
  );
}

export default LoaderSelector;
