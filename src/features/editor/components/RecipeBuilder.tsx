import { For, Show, createSignal, createMemo, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { createVirtualizer } from "@tanstack/solid-virtual";
import type { MinecraftEntry, MinecraftModInfo, CacheStats, RebuildStats } from "../../../shared/types";
import { ModalWrapper, Select, Tabs, Tooltip } from "../../../shared/ui";
import { useDebounce, useSafeTimers } from "../../../shared/hooks";
import { useI18n } from "../../../shared/i18n";

interface RecipeBuilderProps {
  instanceId: string;
  onClose: () => void;
  onInsert: (code: string) => void;
  format: "kubejs" | "crafttweaker" | "json";
  kubeJsVersion?: string;
}

type RecipeType = "shaped" | "shapeless" | "smelting" | "blasting" | "smoking" | "smithing";

interface Ingredient {
  id: string;
  name: string;
  count: number;
  texture_path?: string | null;
}

const EMPTY_GRID = (): (Ingredient | null)[][] => [
  [null, null, null],
  [null, null, null],
  [null, null, null],
];

// Get color for mod namespace
const getModColor = (id: string): string => {
  const namespace = id.split(":")[0] || "minecraft";
  const colors: Record<string, string> = {
    minecraft: "bg-green-700",
    create: "bg-orange-600",
    mekanism: "bg-cyan-600",
    thermal: "bg-red-600",
    ae2: "bg-purple-600",
    botania: "bg-pink-600",
    immersiveengineering: "bg-amber-700",
    tconstruct: "bg-blue-600",
    farmersdelight: "bg-lime-600",
  };
  // Generate consistent color from namespace hash
  if (!colors[namespace]) {
    const hash = namespace.split("").reduce((a, b) => a + b.charCodeAt(0), 0);
    const hue = hash % 360;
    return `bg-[hsl(${hue},50%,35%)]`;
  }
  return colors[namespace];
};

// Item icon component with texture support
function ItemIcon(props: { item: Ingredient | MinecraftEntry; size?: "sm" | "md" | "lg" }) {
  const [imgError, setImgError] = createSignal(false);

  const size = () => props.size || "md";
  const sizeClass = () => ({
    sm: "w-6 h-6 text-[8px]",
    md: "w-10 h-10 text-[10px]",
    lg: "w-12 h-12 text-xs",
  }[size()]);

  const id = () => props.item.id;
  const name = () => props.item.name;
  const initials = () => name().substring(0, 2).toUpperCase();

  // Get texture path from item - reset error when path changes
  const texturePath = createMemo(() => {
    setImgError(false); // Reset error when item changes
    const item = props.item as MinecraftEntry;
    return item.texture_path;
  });

  // Convert local file path to asset URL
  const textureUrl = createMemo(() => {
    const path = texturePath();
    if (!path || imgError()) return null;
    // Only use absolute paths (from extracted textures)
    if (!path.startsWith("/") && !path.match(/^[A-Z]:\\/i)) return null;
    try {
      return convertFileSrc(path);
    } catch {
      return null;
    }
  });

  return (
    <div
      class={`${sizeClass()} ${textureUrl() ? "bg-gray-800" : getModColor(id())} rounded flex-center font-bold text-gray-200/90 select-none overflow-hidden`}
    >
      <Show when={textureUrl()} fallback={initials()}>
        <img
          src={textureUrl()!}
          alt={name()}
          class="w-full h-full object-contain pixelated"
          onError={() => setImgError(true)}
          draggable={false}
        />
      </Show>
    </div>
  );
}

export function RecipeBuilder(props: RecipeBuilderProps) {
  const { t } = useI18n();
  const { debounce } = useDebounce();
  const { setTimeout: safeTimeout } = useSafeTimers();

  const [recipeType, setRecipeType] = createSignal<RecipeType>("shaped");
  const [recipeName, setRecipeName] = createSignal("");
  const [outputItem, setOutputItem] = createSignal<Ingredient | null>(null);
  const [outputCount, setOutputCount] = createSignal(1);
  const [grid, setGrid] = createSignal<(Ingredient | null)[][]>(EMPTY_GRID());
  const [shapelessIngredients, setShapelessIngredients] = createSignal<Ingredient[]>([]);
  const [smeltingInput, setSmeltingInput] = createSignal<Ingredient | null>(null);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [searchResults, setSearchResults] = createSignal<MinecraftEntry[]>([]);
  const [searching, setSearching] = createSignal(false);
  const [initialItems, setInitialItems] = createSignal<MinecraftEntry[]>([]);
  const [loadingInitial, setLoadingInitial] = createSignal(true);
  const [rebuildingCache, setRebuildingCache] = createSignal(false);
  const [rebuildStats, setRebuildStats] = createSignal<RebuildStats | null>(null);
  const [dragOverSlot, setDragOverSlot] = createSignal<string | null>(null);
  const [availableMods, setAvailableMods] = createSignal<MinecraftModInfo[]>([]);
  const [selectedModId, setSelectedModId] = createSignal<string>("");
  const [draggedItem, setDraggedItem] = createSignal<Ingredient | null>(null);
  const [copied, setCopied] = createSignal(false);

  // Scroll ref for virtualizer
  let itemsScrollRef: HTMLDivElement | undefined;

  // Mod options for dropdown (items + blocks)
  const modOptions = createMemo(() => {
    const mods = availableMods();
    const totalItems = mods.reduce((sum, m) => sum + m.item_count, 0);
    const totalBlocks = mods.reduce((sum, m) => sum + m.block_count, 0);
    const options = [{ value: "", label: t().editor.allMods, description: `${totalItems + totalBlocks} (${totalItems} 📦 + ${totalBlocks} 🧱)` }];
    return options.concat(
      mods
        .filter((m) => m.item_count > 0 || m.block_count > 0)
        .map((m) => ({
          value: m.mod_id,
          label: m.name,
          description: `${m.item_count + m.block_count} (${m.item_count} 📦 + ${m.block_count} 🧱)`,
        }))
    );
  });

  // Load mods list
  const loadMods = async () => {
    try {
      const mods = await invoke<MinecraftModInfo[]>("get_minecraft_mods", {
        instanceId: props.instanceId,
      });
      setAvailableMods(mods);
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to load mods:", e);
    }
  };

  // Load items AND blocks from cache with optional mod filter
  const loadItems = async (modId?: string) => {
    try {
      const results = await invoke<MinecraftEntry[]>("search_minecraft_entries", {
        instanceId: props.instanceId,
        query: "",
        modId: modId || null,
        limit: 5000, // Load more items & blocks
      });
      setInitialItems(results);
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to load items:", e);
    }
  };

  // Check cache and rebuild if empty
  onMount(async () => {
    try {
      const stats = await invoke<CacheStats>("get_minecraft_data_stats", {
        instanceId: props.instanceId,
      });

      if (stats.total_items === 0) {
        setRebuildingCache(true);
        const result = await invoke<RebuildStats>("rebuild_minecraft_data_cache", {
          instanceId: props.instanceId,
        });
        setRebuildStats(result);
        setRebuildingCache(false);
      }

      await Promise.all([loadItems(), loadMods()]);
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to initialize cache:", e);
    } finally {
      setLoadingInitial(false);
    }
  });

  // Handle mod filter change
  const handleModFilterChange = async (modId: string) => {
    setSelectedModId(modId);
    setLoadingInitial(true);
    await loadItems(modId || undefined);
    setLoadingInitial(false);
    // Clear search when switching mod
    setSearchQuery("");
    setSearchResults([]);
  };

  const displayItems = () => searchQuery() ? searchResults() : initialItems();

  // Items per row in the grid
  const ITEMS_PER_ROW = 6;
  const ITEM_HEIGHT = 42;

  // Compute rows for virtualization
  const itemRows = createMemo(() => {
    const items = displayItems();
    const rows: MinecraftEntry[][] = [];
    for (let i = 0; i < items.length; i += ITEMS_PER_ROW) {
      rows.push(items.slice(i, i + ITEMS_PER_ROW));
    }
    return rows;
  });

  // Virtualizer for items grid
  const virtualizer = createVirtualizer({
    get count() {
      return itemRows().length;
    },
    getScrollElement: () => itemsScrollRef ?? null,
    estimateSize: () => ITEM_HEIGHT,
    overscan: 5,
  });

  // Search for items and blocks
  const searchItems = async (query: string) => {
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }

    setSearching(true);
    try {
      const results = await invoke<MinecraftEntry[]>("search_minecraft_entries", {
        instanceId: props.instanceId,
        query: query.trim(),
        modId: selectedModId() || null,
        limit: 100,
      });
      setSearchResults(results);
    } catch (e) {
      if (import.meta.env.DEV) console.error("Search failed:", e);
    } finally {
      setSearching(false);
    }
  };

  const handleSearchInput = (value: string) => {
    setSearchQuery(value);
    debounce(() => searchItems(value), 300);
  };

  // Selected item for click-to-place (alternative to drag)
  const [selectedItem, setSelectedItem] = createSignal<Ingredient | null>(null);

  // Pointer-based drag state (more reliable than HTML5 D&D in Tauri)
  const [pointerPos, setPointerPos] = createSignal<{ x: number; y: number } | null>(null);
  const [isDragging, setIsDragging] = createSignal(false);
  // Track if drag just ended to prevent click from firing
  let justEndedDrag = false;

  // Pointer drag handlers - works better in Tauri WebView than HTML5 D&D
  const handlePointerDown = (e: globalThis.PointerEvent, item: MinecraftEntry) => {
    e.preventDefault();
    justEndedDrag = false;
    const ingredient: Ingredient = { id: item.id, name: item.name, count: 1, texture_path: item.texture_path };
    setDraggedItem(ingredient);
    setPointerPos({ x: e.clientX, y: e.clientY });
    setIsDragging(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: globalThis.PointerEvent) => {
    if (isDragging()) {
      setPointerPos({ x: e.clientX, y: e.clientY });
      // Check what we're hovering over
      const elements = document.elementsFromPoint(e.clientX, e.clientY);
      const dropTarget = elements.find((el) => el.hasAttribute("data-drop-slot"));
      if (dropTarget) {
        setDragOverSlot(dropTarget.getAttribute("data-drop-slot"));
      } else {
        setDragOverSlot(null);
      }
    }
  };

  const handlePointerUp = (e: globalThis.PointerEvent) => {
    if (!isDragging()) return;

    const item = draggedItem();
    if (item) {
      // Find drop target at current position
      const elements = document.elementsFromPoint(e.clientX, e.clientY);
      const dropTarget = elements.find((el) => el.hasAttribute("data-drop-slot"));

      if (dropTarget) {
        const slotId = dropTarget.getAttribute("data-drop-slot")!;
        handleDropOnSlot(slotId, item);
      }
    }

    // Mark that drag just ended (to prevent click from selecting)
    justEndedDrag = true;
    // Reset after short delay to allow click event to check
    safeTimeout(() => { justEndedDrag = false; }, 50);

    // Reset drag state
    setIsDragging(false);
    setDraggedItem(null);
    setPointerPos(null);
    setDragOverSlot(null);
  };

  // Handle drop based on slot ID
  const handleDropOnSlot = (slotId: string, item: Ingredient) => {
    if (slotId === "output") {
      setOutputItem({ ...item });
    } else if (slotId === "smelting-input") {
      setSmeltingInput({ ...item });
    } else if (slotId === "shapeless" && shapelessIngredients().length < 9) {
      setShapelessIngredients([...shapelessIngredients(), { ...item }]);
    } else if (slotId.startsWith("grid-")) {
      const [_, row, col] = slotId.split("-").map(Number);
      if (!isNaN(row) && !isNaN(col)) {
        const newGrid = grid().map((r) => [...r]);
        newGrid[row][col] = { ...item };
        setGrid(newGrid);
      }
    }
  };

  // Click to select item (alternative to drag)
  const handleItemClick = (item: MinecraftEntry) => {
    const ingredient: Ingredient = { id: item.id, name: item.name, count: 1, texture_path: item.texture_path };
    setSelectedItem(ingredient);
  };

  // Place selected item in slot on click
  const handleSlotClick = (slotId: string, existingItem?: Ingredient | null) => {
    const selected = selectedItem();
    if (selected) {
      // Place selected item
      handleDropOnSlot(slotId, selected);
      setSelectedItem(null);
    } else if (existingItem) {
      // Remove existing item
      if (slotId === "output") {
        setOutputItem(null);
      } else if (slotId === "smelting-input") {
        setSmeltingInput(null);
      } else if (slotId.startsWith("grid-")) {
        const [_, row, col] = slotId.split("-").map(Number);
        if (!isNaN(row) && !isNaN(col)) {
          const newGrid = grid().map((r) => [...r]);
          newGrid[row][col] = null;
          setGrid(newGrid);
        }
      }
    }
    return null;
  };

  const removeShapelessIngredient = (index: number) => {
    setShapelessIngredients(shapelessIngredients().filter((_, i) => i !== index));
  };

  const clearAll = () => {
    setGrid(EMPTY_GRID());
    setOutputItem(null);
    setOutputCount(1);
    setShapelessIngredients([]);
    setSmeltingInput(null);
    setRecipeName("");
  };

  // Copy generated code to clipboard
  const handleCopyCode = async () => {
    const code = generatedCode();
    if (code) {
      try {
        await navigator.clipboard.writeText(code);
        setCopied(true);
        debounce(() => setCopied(false), 2000);
      } catch (e) {
        if (import.meta.env.DEV) console.error("Failed to copy:", e);
      }
    }
  };

  // Code generation
  const generatedCode = createMemo(() => {
    const output = outputItem();
    if (!output) return "";

    switch (recipeType()) {
      case "shaped":
        return generateShapedCode();
      case "shapeless":
        return generateShapelessCode();
      case "smelting":
      case "blasting":
      case "smoking":
        return generateSmeltingCode();
      default:
        return "";
    }
  });

  const generateShapedCode = (): string => {
    const output = outputItem();
    if (!output) return "";

    const g = grid();
    const pattern: string[] = [];
    const keyMap: Record<string, string> = {};
    let keyIndex = 0;
    const keyChars = "ABCDEFGHI";

    for (let row = 0; row < 3; row++) {
      let rowPattern = "";
      for (let col = 0; col < 3; col++) {
        const item = g[row][col];
        if (item) {
          let key = Object.entries(keyMap).find(([_, v]) => v === item.id)?.[0];
          if (!key) {
            key = keyChars[keyIndex++];
            keyMap[key] = item.id;
          }
          rowPattern += key;
        } else {
          rowPattern += " ";
        }
      }
      pattern.push(rowPattern);
    }

    while (pattern.length > 0 && pattern[0].trim() === "") pattern.shift();
    while (pattern.length > 0 && pattern[pattern.length - 1].trim() === "") pattern.pop();

    if (pattern.length === 0) return "";

    if (props.format === "kubejs") {
      const isV6Plus = !props.kubeJsVersion || props.kubeJsVersion.startsWith("6.") || props.kubeJsVersion.startsWith("7.");

      if (isV6Plus) {
        const patternStr = pattern.map((p) => `'${p}'`).join(",\n      ");
        const keysStr = Object.entries(keyMap).map(([k, v]) => `${k}: '${v}'`).join(",\n      ");
        const outputStr = outputCount() > 1 ? `Item.of('${output.id}', ${outputCount()})` : `'${output.id}'`;

        return `ServerEvents.recipes(event => {
  event.shaped(
    ${outputStr},
    [
      ${patternStr}
    ],
    {
      ${keysStr}
    }
  )
})`;
      } else {
        const patternStr = pattern.map((p) => `'${p}'`).join(", ");
        const keysStr = Object.entries(keyMap).map(([k, v]) => `${k}: '${v}'`).join(", ");
        return `onEvent('recipes', event => {
  event.shaped('${output.id}', [${patternStr}], {${keysStr}})
})`;
      }
    } else if (props.format === "crafttweaker") {
      const name = recipeName() || "custom_shaped";
      const patternRows = pattern.map((row) => {
        const items = row.split("").map((char) => char === " " ? "<item:minecraft:air>" : `<item:${keyMap[char]}>`);
        return `[${items.join(", ")}]`;
      });
      return `craftingTable.addShaped("${name}", <item:${output.id}>${outputCount() > 1 ? ` * ${outputCount()}` : ""}, [
    ${patternRows.join(",\n    ")}
]);`;
    } else {
      return JSON.stringify({
        type: "minecraft:crafting_shaped",
        pattern,
        key: Object.fromEntries(Object.entries(keyMap).map(([k, v]) => [k, { item: v }])),
        result: { item: output.id, count: outputCount() },
      }, null, 2);
    }
  };

  const generateShapelessCode = (): string => {
    const output = outputItem();
    const ingredients = shapelessIngredients();
    if (!output || ingredients.length === 0) return "";

    if (props.format === "kubejs") {
      const ingredientsStr = ingredients.map((i) => `'${i.id}'`).join(",\n    ");
      return `ServerEvents.recipes(event => {
  event.shapeless(
    '${output.id}'${outputCount() > 1 ? `, ${outputCount()}` : ""},
    [
    ${ingredientsStr}
    ]
  )
})`;
    } else if (props.format === "crafttweaker") {
      const name = recipeName() || "custom_shapeless";
      const ingredientsStr = ingredients.map((i) => `<item:${i.id}>`).join(",\n    ");
      return `craftingTable.addShapeless("${name}", <item:${output.id}>${outputCount() > 1 ? ` * ${outputCount()}` : ""}, [
    ${ingredientsStr}
]);`;
    } else {
      return JSON.stringify({
        type: "minecraft:crafting_shapeless",
        ingredients: ingredients.map((i) => ({ item: i.id })),
        result: { item: output.id, count: outputCount() },
      }, null, 2);
    }
  };

  const generateSmeltingCode = (): string => {
    const output = outputItem();
    const input = smeltingInput();
    if (!output || !input) return "";

    const type = recipeType();

    if (props.format === "kubejs") {
      return `ServerEvents.recipes(event => {
  event.${type}('${output.id}', '${input.id}')
})`;
    } else if (props.format === "crafttweaker") {
      const name = recipeName() || `custom_${type}`;
      const typeMap: Record<string, string> = { smelting: "furnace", blasting: "blastFurnace", smoking: "smoker" };
      return `${typeMap[type]}.addRecipe("${name}", <item:${output.id}>, <item:${input.id}>, 0.7, 200);`;
    } else {
      return JSON.stringify({
        type: `minecraft:${type}`,
        ingredient: { item: input.id },
        result: output.id,
        experience: 0.7,
        cookingtime: type === "blasting" || type === "smoking" ? 100 : 200,
      }, null, 2);
    }
  };

  const handleInsert = () => {
    const code = generatedCode();
    if (code) {
      props.onInsert(code);
      props.onClose();
    }
  };

  // Unified slot component for all craft cells
  type SlotVariant = "input" | "output" | "grid";

  const CraftSlot = (props: {
    slotId: string;
    item: Ingredient | null | undefined;
    variant?: SlotVariant;
    size?: "sm" | "md" | "lg";
    label?: string;
  }) => {
    const variant = () => props.variant || "input";
    const size = () => props.size || "md";
    const isOver = () => dragOverSlot() === props.slotId;
    const canPlace = () => !props.item && selectedItem();

    const sizeClass = () => ({
      sm: "w-10 h-10",
      md: "w-12 h-12",
      lg: "w-14 h-14",
    }[size()]);

    const variantClass = () => {
      const v = variant();
      const hasItem = !!props.item;
      const highlighted = isOver() || canPlace();

      if (v === "output") {
        return hasItem
          ? "bg-green-900/30 border-green-600 hover:border-green-500"
          : highlighted
          ? "bg-green-900/30 border-green-500 border-solid"
          : "bg-gray-800 border-gray-700 border-dashed hover:border-gray-600";
      }
      // input & grid
      return hasItem
        ? "bg-gray-700 border-gray-600 hover:border-gray-500"
        : highlighted
        ? "bg-[var(--color-primary-bg)] border-[var(--color-primary)] border-solid"
        : "bg-gray-800 border-gray-700 border-dashed hover:border-gray-600";
    };

    const tooltip = () =>
      props.item?.name || (selectedItem() ? t().editor.clickToPlace : props.label || t().editor.dragItemHere);

    return (
      <div
        data-drop-slot={props.slotId}
        class={`${sizeClass()} border-2 rounded-lg flex-center cursor-pointer transition-all ${variantClass()}`}
        onClick={() => handleSlotClick(props.slotId, props.item)}
        title={tooltip()}
      >
        <Show when={props.item}>
          <ItemIcon item={props.item!} size={size() === "lg" ? "md" : "sm"} />
        </Show>
      </div>
    );
  };

  return (
    <ModalWrapper maxWidth="max-w-4xl" backdrop onBackdropClick={props.onClose}>
      {/* Header */}
      <div class="flex items-center justify-between p-4 border-b border-gray-700 flex-shrink-0">
        <div class="flex items-center gap-3">
          <i class="i-hugeicons-chef-hat w-6 h-6 text-orange-400" />
          <div>
            <h2 class="text-xl font-bold">{t().editor.recipeBuilderTitle}</h2>
            <p class="text-sm text-gray-500">{t().editor.recipeBuilderDescription}</p>
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

      <div class="p-4 flex flex-col gap-4 overflow-y-auto max-h-[70vh]">
        {/* Top row - Items + Recipe */}
        <div class="flex flex-col lg:flex-row gap-4">
          {/* Left panel - Items */}
          <div class="flex min-w-0 lg:max-w-[280px] flex flex-col gap-3">
          {/* Mod filter */}
          <div class="flex flex-col gap-2">
            <label class="text-sm font-medium">{t().editor.filterByMod}</label>
            <Select
              value={selectedModId()}
              options={modOptions()}
              onChange={handleModFilterChange}
              maxHeight="200px"
              class="rounded-lg"
            />
          </div>

          {/* Search */}
          <div class="flex flex-col gap-2">
            <label class="text-sm font-medium">{t().editor.searchItems}</label>
            <input
              type="text"
              value={searchQuery()}
              onInput={(e) => handleSearchInput(e.currentTarget.value)}
              placeholder={t().editor.searchItemsPlaceholder}
              class="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg focus:outline-none focus:border-[var(--color-primary)] text-sm"
            />
          </div>

          {/* Items list - virtualized */}
          <div ref={itemsScrollRef} class="h-48 overflow-y-auto">
            <Show when={rebuildingCache()}>
              <div class="flex flex-col items-center gap-3 py-6 text-gray-500">
                <i class="i-svg-spinners-ring-resize w-8 h-8 text-[var(--color-primary)]" />
                <div class="flex flex-col items-center gap-1">
                  <p class="text-sm font-medium">{t().editor.rebuildingCache}</p>
                  <p class="text-xs text-gray-600">{t().editor.rebuildingCacheHint}</p>
                </div>
              </div>
            </Show>

            <Show when={!rebuildingCache() && (searching() || loadingInitial())}>
              <div class="flex flex-col items-center gap-2 py-6 text-gray-500">
                <i class="i-svg-spinners-6-dots-scale w-6 h-6" />
                <p class="text-xs">{t().editor.loadingItems}</p>
              </div>
            </Show>

            <Show when={!rebuildingCache() && !searching() && !loadingInitial() && displayItems().length === 0}>
              <div class="flex flex-col items-center gap-2 py-6 text-gray-500 text-sm">
                <i class="i-hugeicons-package w-10 h-10 opacity-40" />
                <div class="flex flex-col items-center gap-1">
                  <p>{searchQuery() ? t().editor.noItemsFound : t().editor.noItemsInCache}</p>
                  <p class="text-xs text-gray-600">{t().editor.noItemsHint}</p>
                </div>
              </div>
            </Show>

            <Show when={!rebuildingCache() && !searching() && !loadingInitial() && displayItems().length > 0}>
              <div class="flex items-center justify-between text-xs text-gray-500 px-1 pb-2">
                <span>{t().editor.dragToPlace} ({displayItems().length})</span>
                <Show when={selectedItem()}>
                  <button
                    class="text-[var(--color-primary)] hover:text-[var(--color-primary-light)]"
                    onClick={() => setSelectedItem(null)}
                  >
                    {t().common.cancel}
                  </button>
                </Show>
              </div>
              <div
                style={{ height: `${virtualizer.getTotalSize()}px`, width: "100%" }}
              >
                <For each={virtualizer.getVirtualItems()}>
                  {(virtualRow) => {
                    const rowItems = () => itemRows()[virtualRow.index] || [];
                    return (
                      <div
                        style={{
                          position: "absolute",
                          top: `${virtualRow.start}px`,
                          left: 0,
                          width: "100%",
                          height: `${ITEM_HEIGHT}px`,
                        }}
                        class="flex gap-1"
                      >
                        <For each={rowItems()}>
                          {(item) => {
                            const isSelected = () => selectedItem()?.id === item.id;
                            const isItemDragging = () => isDragging() && draggedItem()?.id === item.id;
                            const typeLabel = () => item.entry_type === "block" ? "🧱" : "📦";
                            return (
                              <div
                                onPointerDown={(e) => handlePointerDown(e, item)}
                                onPointerMove={handlePointerMove}
                                onPointerUp={handlePointerUp}
                                onClick={() => !isDragging() && !justEndedDrag && handleItemClick(item)}
                                class={`flex-center w-10 h-10 border-1 border-transparent cursor-grab active:cursor-grabbing select-none rounded transition-colors touch-none ${
                                  isSelected() ? "border-[var(--color-primary)] bg-[var(--color-primary-bg)]" : ""
                                } ${isItemDragging() ? "border-orange-500" : ""}`}
                                title={`${typeLabel()} ${item.name}\nID: ${item.id}`}
                              >
                                <ItemIcon item={item} size="md" />
                              </div>
                            );
                          }}
                        </For>
                      </div>
                    );
                  }}
                </For>
              </div>
            </Show>
          </div>

          {/* Stats after rebuild */}
          <Show when={rebuildStats()}>
            <div class="p-2 bg-green-900/20 border border-green-800/30 rounded-lg text-xs flex flex-col gap-1">
              <div class="text-green-400 font-medium">{t().editor.cacheRebuilt}</div>
              <div class="text-gray-400">
                {rebuildStats()!.total_items} 📦 + {rebuildStats()!.total_blocks} 🧱, {rebuildStats()!.parsed_mods} {t().editor.mods}
              </div>
            </div>
          </Show>

          {/* Force rebuild button */}
          <Show when={!rebuildingCache() && !loadingInitial()}>
            <button
              class="w-full text-xs text-gray-500 hover:text-gray-300 hover:bg-gray-800 py-1.5 rounded transition-colors flex items-center justify-center gap-1.5"
              onClick={async () => {
                setRebuildingCache(true);
                setRebuildStats(null);
                try {
                  const result = await invoke<RebuildStats>("rebuild_minecraft_data_cache", {
                    instanceId: props.instanceId,
                  });
                  setRebuildStats(result);
                  await Promise.all([loadItems(selectedModId() || undefined), loadMods()]);
                } catch (e) {
                  if (import.meta.env.DEV) console.error("Rebuild failed:", e);
                } finally {
                  setRebuildingCache(false);
                }
              }}
            >
              <i class="i-hugeicons-refresh w-3.5 h-3.5" />
              {t().editor.rebuildCache}
            </button>
          </Show>
        </div>

        {/* Middle panel - Recipe grid */}
        <div class="flex-[2] flex flex-col gap-4 min-w-0">
          {/* Recipe type selector */}
          <div class="overflow-x-auto">
            <Tabs
              tabs={[
                { id: "shaped", label: t().editor.shaped, icon: "i-hugeicons-grid-view" },
                { id: "shapeless", label: t().editor.shapeless, icon: "i-hugeicons-shuffle" },
                { id: "smelting", label: t().editor.smelting, icon: "i-hugeicons-fire" },
                { id: "blasting", label: t().editor.blasting, icon: "i-hugeicons-fire" },
                { id: "smoking", label: t().editor.smoking, icon: "i-hugeicons-fire" },
              ]}
              activeTab={recipeType()}
              onTabChange={(id) => setRecipeType(id as RecipeType)}
              variant="pills"
            />
          </div>

          {/* Shaped recipe */}
          <Show when={recipeType() === "shaped"}>
            <div class="flex items-center gap-6">
              <div class="grid grid-cols-3 gap-1">
                <For each={[0, 1, 2]}>
                  {(row) => (
                    <For each={[0, 1, 2]}>
                      {(col) => (
                        <CraftSlot
                          slotId={`grid-${row}-${col}`}
                          item={grid()[row][col]}
                          variant="grid"
                        />
                      )}
                    </For>
                  )}
                </For>
              </div>

              <i class="i-hugeicons-arrow-right-01 w-8 h-8 text-gray-500" />

              <div class="flex flex-col items-center gap-2">
                <CraftSlot
                  slotId="output"
                  item={outputItem()}
                  variant="output"
                  size="lg"
                  label={t().editor.output}
                />
                <input
                  type="number"
                  min="1"
                  max="64"
                  value={outputCount()}
                  onInput={(e) => setOutputCount(parseInt(e.currentTarget.value) || 1)}
                  class="w-14 px-2 py-1 text-center bg-gray-800 border border-gray-700 rounded text-sm"
                />
              </div>
            </div>
          </Show>

          {/* Shapeless recipe */}
          <Show when={recipeType() === "shapeless"}>
            <div class="flex items-center gap-6">
              <div>
                <div class="text-sm text-gray-400 mb-2">{t().editor.ingredients}</div>
                <div
                  data-drop-slot="shapeless"
                  class={`flex flex-wrap gap-1 p-2 bg-gray-800 rounded-lg min-h-[120px] w-[156px] transition-all cursor-pointer ${
                    dragOverSlot() === "shapeless" || (selectedItem() && shapelessIngredients().length < 9)
                      ? "ring-2 ring-[var(--color-primary)]"
                      : ""
                  }`}
                  onClick={() => handleSlotClick("shapeless")}
                >
                  <For each={shapelessIngredients()}>
                    {(ingredient, index) => (
                      <div
                        class="w-10 h-10 bg-gray-700 border border-gray-600 rounded flex-center cursor-pointer hover:border-red-500"
                        onClick={(e) => { e.stopPropagation(); removeShapelessIngredient(index()); }}
                        title={`${ingredient.name} (${t().editor.clickToRemove})`}
                      >
                        <ItemIcon item={ingredient} size="sm" />
                      </div>
                    )}
                  </For>
                  <Show when={shapelessIngredients().length < 9}>
                    <div class="w-10 h-10 border-2 border-dashed border-gray-700 rounded flex-center text-gray-600">
                      <i class="i-hugeicons-add-01 w-4 h-4" />
                    </div>
                  </Show>
                </div>
              </div>

              <i class="i-hugeicons-arrow-right-01 w-8 h-8 text-gray-500" />

              <div class="flex flex-col items-center gap-2">
                <CraftSlot
                  slotId="output"
                  item={outputItem()}
                  variant="output"
                  size="lg"
                  label={t().editor.output}
                />
                <input
                  type="number"
                  min="1"
                  max="64"
                  value={outputCount()}
                  onInput={(e) => setOutputCount(parseInt(e.currentTarget.value) || 1)}
                  class="w-14 px-2 py-1 text-center bg-gray-800 border border-gray-700 rounded text-sm"
                />
              </div>
            </div>
          </Show>

          {/* Smelting recipes */}
          <Show when={recipeType() === "smelting" || recipeType() === "blasting" || recipeType() === "smoking"}>
            <div class="flex items-center gap-6">
              <div class="flex flex-col items-center gap-2">
                <div class="text-sm text-gray-400">{t().editor.input}</div>
                <CraftSlot
                  slotId="smelting-input"
                  item={smeltingInput()}
                  variant="input"
                  size="lg"
                  label={t().editor.input}
                />
              </div>

              <div class="flex flex-col items-center text-gray-500">
                <i class="i-hugeicons-fire w-8 h-8" />
                <i class="i-hugeicons-arrow-right-01 w-6 h-6" />
              </div>

              <div class="flex flex-col items-center gap-2">
                <div class="text-sm text-gray-400">{t().editor.output}</div>
                <CraftSlot
                  slotId="output"
                  item={outputItem()}
                  variant="output"
                  size="lg"
                  label={t().editor.output}
                />
              </div>
            </div>
          </Show>

          <button
            class="text-sm text-gray-500 hover:text-gray-300"
            onClick={clearAll}
          >
            {t().editor.clearAll}
          </button>
        </div>
        </div>

        {/* Bottom panel - Code preview */}
        <div class="border-t border-gray-700 pt-4 flex flex-col lg:flex-row gap-4">
          {/* Recipe name input */}
          <div class="flex flex-col gap-2 lg:w-48">
            <label class="text-sm font-medium">{t().editor.recipeName}</label>
            <input
              type="text"
              value={recipeName()}
              onInput={(e) => setRecipeName(e.currentTarget.value)}
              placeholder={t().editor.recipeNamePlaceholder}
              class="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg focus:outline-none focus:border-[var(--color-primary)] text-sm"
            />
          </div>

          {/* Code preview */}
          <div class="flex-1 flex flex-col gap-2">
            <div class="flex items-center justify-between">
              <label class="text-sm font-medium">{t().editor.generatedCode}</label>
              <div class="flex items-center gap-2">
                <span class="text-xs text-gray-500 capitalize">{props.format}</span>
                <Tooltip text={copied() ? t().common.copied : t().common.copy} position="top">
                  <button
                    class="p-1 rounded hover:bg-gray-700 text-gray-400 hover:text-gray-200 transition-colors"
                    onClick={handleCopyCode}
                    disabled={!generatedCode()}
                  >
                    <i class={`w-4 h-4 ${copied() ? "i-hugeicons-checkmark-circle-02 text-green-400" : "i-hugeicons-copy-01"}`} />
                  </button>
                </Tooltip>
              </div>
            </div>
            <pre class="p-3 bg-gray-900 border border-gray-700 rounded-lg text-xs overflow-auto max-h-32">
              <code class={generatedCode() ? "text-gray-300" : "text-gray-500 italic"}>
                {generatedCode() || t().editor.configureRecipe}
              </code>
            </pre>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div class="flex items-center justify-between p-4 border-t border-gray-700 flex-shrink-0">
        <p class="text-sm text-gray-500">
          {t().editor.recipeBuilderHint}
        </p>
        <div class="flex gap-3">
          <button class="btn-secondary" onClick={props.onClose}>
            {t().common.cancel}
          </button>
          <button
            class="btn-primary"
            onClick={handleInsert}
            disabled={!generatedCode()}
          >
            <i class="i-hugeicons-code w-4 h-4" />
            {t().editor.insertCode}
          </button>
        </div>
      </div>

      {/* Floating drag preview */}
      <Show when={isDragging() && pointerPos() && draggedItem()}>
        <div
          class="fixed pointer-events-none z-50 bg-gray-800 border border-[var(--color-primary)] rounded-lg p-2 shadow-lg"
          style={{
            left: `${pointerPos()!.x + 12}px`,
            top: `${pointerPos()!.y + 12}px`,
          }}
        >
          <div class="flex items-center gap-2">
            <ItemIcon item={draggedItem()!} size="sm" />
            <div class="text-xs">
              <div class="font-medium text-white">{draggedItem()!.name}</div>
              <div class="text-gray-400">{draggedItem()!.id}</div>
            </div>
          </div>
        </div>
      </Show>
    </ModalWrapper>
  );
}
