import { Show, For, createMemo, createSignal } from "solid-js";

interface RecipePreviewProps {
  content: string;
  language: string;
  fileName: string;
}

interface ParsedRecipe {
  type: "shaped" | "shapeless" | "smelting" | "smoking" | "blasting" | "campfire" | "smithing" | "stonecutting" | "custom";
  id?: string;
  output: string;
  outputCount?: number;
  inputs: string[];
  pattern?: string[];
  key?: Record<string, string>;
  modId?: string;
}

// Parse KubeJS recipe syntax
function parseKubeJSRecipes(content: string): ParsedRecipe[] {
  const recipes: ParsedRecipe[] = [];

  // Match shaped recipes: event.shaped('output', ['pattern'], {key: 'item'})
  const shapedRegex = /\.shaped\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*\[([^\]]+)\]\s*,\s*\{([^}]+)\}/g;
  let match;

  while ((match = shapedRegex.exec(content)) !== null) {
    const output = match[1];
    const patternStr = match[2];
    const keyStr = match[3];

    // Parse pattern
    const pattern = patternStr
      .split(",")
      .map((s) => s.trim().replace(/['"`]/g, ""))
      .filter(Boolean);

    // Parse keys
    const key: Record<string, string> = {};
    const keyPairs = keyStr.matchAll(/(['"`])([^'"`])['"`]\s*:\s*['"`]([^'"`]+)['"`]/g);
    for (const pair of keyPairs) {
      key[pair[2]] = pair[3];
    }

    // Collect all inputs
    const inputs = new Set<string>();
    for (const row of pattern) {
      for (const char of row) {
        if (char !== " " && key[char]) {
          inputs.add(key[char]);
        }
      }
    }

    recipes.push({
      type: "shaped",
      output,
      inputs: Array.from(inputs),
      pattern,
      key,
    });
  }

  // Match shapeless recipes: event.shapeless('output', ['input1', 'input2'])
  const shapelessRegex = /\.shapeless\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*\[([^\]]+)\]/g;
  while ((match = shapelessRegex.exec(content)) !== null) {
    const output = match[1];
    const inputsStr = match[2];
    const inputs = inputsStr
      .split(",")
      .map((s) => s.trim().replace(/['"`]/g, ""))
      .filter(Boolean);

    recipes.push({
      type: "shapeless",
      output,
      inputs,
    });
  }

  // Match smelting recipes: event.smelting('output', 'input')
  const smeltingTypes = ["smelting", "smoking", "blasting", "campfire"] as const;
  for (const smeltType of smeltingTypes) {
    const regex = new RegExp(`\\.${smeltType}\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]\\s*,\\s*['"\`]([^'"\`]+)['"\`]`, "g");
    while ((match = regex.exec(content)) !== null) {
      recipes.push({
        type: smeltType,
        output: match[1],
        inputs: [match[2]],
      });
    }
  }

  // Match stonecutting: event.stonecutting('output', 'input')
  const stonecuttingRegex = /\.stonecutting\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*['"`]([^'"`]+)['"`]/g;
  while ((match = stonecuttingRegex.exec(content)) !== null) {
    recipes.push({
      type: "stonecutting",
      output: match[1],
      inputs: [match[2]],
    });
  }

  return recipes;
}

// Parse CraftTweaker recipe syntax
function parseCraftTweakerRecipes(content: string): ParsedRecipe[] {
  const recipes: ParsedRecipe[] = [];

  // Match recipes.addShaped("name", <output>, [[inputs]])
  const shapedRegex = /recipes\.addShaped\s*\(\s*"([^"]+)"\s*,\s*<([^>]+)>\s*,\s*\[\s*(\[[\s\S]*?\])\s*\]/g;
  let match;

  while ((match = shapedRegex.exec(content)) !== null) {
    const id = match[1];
    const output = match[2];
    const patternStr = match[3];

    // Parse pattern - crude but works for basic cases
    // eslint-disable-next-line no-useless-escape
    const rows = patternStr.split("],").map((r) => r.replace(/[\[\]]/g, "").trim());
    const inputs = new Set<string>();
    const pattern: string[] = [];

    for (const row of rows) {
      const items = row.split(",").map((s) => s.trim());
      let patternRow = "";
      for (const item of items) {
        if (item.startsWith("<") && item.includes(">")) {
          const itemId = item.replace(/<|>/g, "");
          inputs.add(itemId);
          patternRow += "X"; // Simplified
        } else {
          patternRow += " ";
        }
      }
      if (patternRow) pattern.push(patternRow);
    }

    recipes.push({
      type: "shaped",
      id,
      output,
      inputs: Array.from(inputs),
      pattern,
    });
  }

  // Match recipes.addShapeless
  const shapelessRegex = /recipes\.addShapeless\s*\(\s*"([^"]+)"\s*,\s*<([^>]+)>\s*,\s*\[([^\]]+)\]/g;
  while ((match = shapelessRegex.exec(content)) !== null) {
    const id = match[1];
    const output = match[2];
    const inputsStr = match[3];
    const inputs = inputsStr
      .split(",")
      .map((s) => s.trim().replace(/<|>/g, ""))
      .filter(Boolean);

    recipes.push({
      type: "shapeless",
      id,
      output,
      inputs,
    });
  }

  return recipes;
}

// Parse JSON datapack recipes
function parseJSONRecipes(content: string): ParsedRecipe[] {
  try {
    const json = JSON.parse(content);
    const recipes: ParsedRecipe[] = [];

    if (!json.type) return [];

    const type = json.type.replace("minecraft:", "");
    const recipe: ParsedRecipe = {
      type: type as ParsedRecipe["type"],
      output: "",
      inputs: [],
    };

    // Handle output
    if (json.result) {
      if (typeof json.result === "string") {
        recipe.output = json.result;
      } else if (json.result.item || json.result.id) {
        recipe.output = json.result.item || json.result.id;
        recipe.outputCount = json.result.count;
      }
    }

    // Handle shaped recipes
    if (type === "crafting_shaped") {
      recipe.type = "shaped";
      recipe.pattern = json.pattern;
      recipe.key = {};

      if (json.key) {
        for (const [k, v] of Object.entries(json.key)) {
          if (typeof v === "string") {
            recipe.key[k] = v;
            recipe.inputs.push(v);
          } else if (v && typeof v === "object") {
            const item = (v as any).item || (v as any).tag;
            if (item) {
              recipe.key[k] = item;
              recipe.inputs.push(item);
            }
          }
        }
      }
    }

    // Handle shapeless recipes
    if (type === "crafting_shapeless") {
      recipe.type = "shapeless";
      if (json.ingredients) {
        for (const ing of json.ingredients) {
          if (typeof ing === "string") {
            recipe.inputs.push(ing);
          } else if (ing.item || ing.tag) {
            recipe.inputs.push(ing.item || ing.tag);
          }
        }
      }
    }

    // Handle smelting-type recipes
    if (["smelting", "smoking", "blasting", "campfire_cooking"].includes(type)) {
      recipe.type = type.replace("_cooking", "") as ParsedRecipe["type"];
      if (json.ingredient) {
        if (typeof json.ingredient === "string") {
          recipe.inputs.push(json.ingredient);
        } else if (json.ingredient.item || json.ingredient.tag) {
          recipe.inputs.push(json.ingredient.item || json.ingredient.tag);
        }
      }
    }

    // Handle stonecutting
    if (type === "stonecutting") {
      if (json.ingredient) {
        if (typeof json.ingredient === "string") {
          recipe.inputs.push(json.ingredient);
        } else if (json.ingredient.item || json.ingredient.tag) {
          recipe.inputs.push(json.ingredient.item || json.ingredient.tag);
        }
      }
    }

    if (recipe.output) {
      recipes.push(recipe);
    }

    return recipes;
  } catch {
    return [];
  }
}

export function RecipePreview(props: RecipePreviewProps) {
  const [expanded, setExpanded] = createSignal(true);

  const isRecipeFile = createMemo(() => {
    const name = props.fileName.toLowerCase();
    // KubeJS recipe files
    if (name.endsWith(".js") || name.endsWith(".ts")) {
      if (props.fileName.includes("kubejs") || props.content.includes("ServerEvents.recipes")) {
        return true;
      }
    }
    // CraftTweaker files
    if (name.endsWith(".zs")) {
      return true;
    }
    // JSON recipe files (datapack)
    if (name.endsWith(".json") && props.content.includes('"type"') && props.content.includes('"result"')) {
      return true;
    }
    return false;
  });

  const parsedRecipes = createMemo(() => {
    if (!isRecipeFile()) return [];

    const name = props.fileName.toLowerCase();

    if (name.endsWith(".js") || name.endsWith(".ts")) {
      return parseKubeJSRecipes(props.content);
    }

    if (name.endsWith(".zs")) {
      return parseCraftTweakerRecipes(props.content);
    }

    if (name.endsWith(".json")) {
      return parseJSONRecipes(props.content);
    }

    return [];
  });

  const getRecipeTypeIcon = (type: ParsedRecipe["type"]): string => {
    switch (type) {
      case "shaped":
        return "i-hugeicons-grid";
      case "shapeless":
        return "i-hugeicons-shuffle";
      case "smelting":
        return "i-hugeicons-fire";
      case "smoking":
        return "i-hugeicons-fire";
      case "blasting":
        return "i-hugeicons-fire";
      case "campfire":
        return "i-hugeicons-fire";
      case "smithing":
        return "i-hugeicons-wrench-01";
      case "stonecutting":
        return "i-hugeicons-scissor-01";
      default:
        return "i-hugeicons-magic-wand-01";
    }
  };

  const getRecipeTypeName = (type: ParsedRecipe["type"]): string => {
    switch (type) {
      case "shaped":
        return "Крафт (форма)";
      case "shapeless":
        return "Крафт (без формы)";
      case "smelting":
        return "Плавка";
      case "smoking":
        return "Коптильня";
      case "blasting":
        return "Доменная печь";
      case "campfire":
        return "Костёр";
      case "smithing":
        return "Кузнечный стол";
      case "stonecutting":
        return "Камнерез";
      default:
        return "Кастомный";
    }
  };

  const formatItemId = (id: string): string => {
    // Extract just the item name for display
    const parts = id.split(":");
    const name = parts[parts.length - 1];
    return name.replace(/_/g, " ");
  };

  // Render a 3x3 crafting grid
  const renderCraftingGrid = (recipe: ParsedRecipe) => {
    const pattern = recipe.pattern || [];
    const key = recipe.key || {};

    // Normalize to 3x3 grid
    const grid: (string | null)[][] = [];
    for (let row = 0; row < 3; row++) {
      const gridRow: (string | null)[] = [];
      const patternRow = pattern[row] || "";
      for (let col = 0; col < 3; col++) {
        const char = patternRow[col];
        if (char && char !== " " && key[char]) {
          gridRow.push(key[char]);
        } else {
          gridRow.push(null);
        }
      }
      grid.push(gridRow);
    }

    return (
      <div class="grid grid-cols-3 gap-1 p-2 bg-gray-900 rounded-lg w-fit">
        <For each={grid}>
          {(row) => (
            <For each={row}>
              {(cell) => (
                <div
                  class={`w-10 h-10 rounded flex-center text-xs text-center ${
                    cell ? "bg-gray-800 border border-gray-700" : "bg-gray-900 border border-gray-800"
                  }`}
                  title={cell || ""}
                >
                  <Show when={cell}>
                    <span class="truncate px-1">{formatItemId(cell!)}</span>
                  </Show>
                </div>
              )}
            </For>
          )}
        </For>
      </div>
    );
  };

  return (
    <Show when={isRecipeFile() && parsedRecipes().length > 0}>
      <div class="border-t border-gray-750 bg-gray-850/50">
        <button
          class="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-800/50 transition-colors"
          onClick={() => setExpanded(!expanded())}
        >
          <i class={`w-4 h-4 transition-transform ${expanded() ? "i-hugeicons-arrow-down-01" : "i-hugeicons-arrow-right-01"}`} />
          <i class="i-hugeicons-magic-wand-01 w-4 h-4 text-purple-400" />
          <span>Превью рецептов</span>
          <span class="text-xs text-gray-500 ml-auto">{parsedRecipes().length} рецептов</span>
        </button>

        <Show when={expanded()}>
          <div class="p-3 space-y-4 max-h-64 overflow-y-auto">
            <For each={parsedRecipes()}>
              {(recipe) => (
                <div class="bg-gray-800 rounded-xl p-3">
                  {/* Header */}
                  <div class="flex items-center gap-2 mb-3">
                    <i class={`${getRecipeTypeIcon(recipe.type)} w-4 h-4 text-blue-400`} />
                    <span class="text-sm font-medium">{getRecipeTypeName(recipe.type)}</span>
                    <Show when={recipe.id}>
                      <span class="text-xs text-gray-500 ml-auto">#{recipe.id}</span>
                    </Show>
                  </div>

                  {/* Recipe visualization */}
                  <div class="flex items-center gap-4">
                    {/* Inputs */}
                    <Show
                      when={recipe.type === "shaped"}
                      fallback={
                        <div class="flex flex-wrap gap-1 max-w-[160px]">
                          <For each={recipe.inputs}>
                            {(input) => (
                              <div
                                class="px-2 py-1 bg-gray-700 rounded text-xs truncate max-w-[70px]"
                                title={input}
                              >
                                {formatItemId(input)}
                              </div>
                            )}
                          </For>
                        </div>
                      }
                    >
                      {renderCraftingGrid(recipe)}
                    </Show>

                    {/* Arrow */}
                    <i class="i-hugeicons-arrow-right-01 w-5 h-5 text-gray-500 flex-shrink-0" />

                    {/* Output */}
                    <div class="flex items-center gap-2">
                      <div
                        class="px-3 py-2 bg-green-600/20 border border-green-600/30 rounded-lg text-sm"
                        title={recipe.output}
                      >
                        {formatItemId(recipe.output)}
                        <Show when={recipe.outputCount && recipe.outputCount > 1}>
                          <span class="text-green-400 ml-1">x{recipe.outputCount}</span>
                        </Show>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  );
}
