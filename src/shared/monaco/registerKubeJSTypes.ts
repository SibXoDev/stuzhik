import type * as Monaco from "monaco-editor";

// Import type definitions as raw strings
// These will be loaded into Monaco's TypeScript compiler
const kubeJSTypes = `
/**
 * KubeJS TypeScript Definitions
 * Automatically loaded for JavaScript/TypeScript files
 */

// ===== Server Events =====

declare namespace ServerEvents {
  function recipes(handler: (event: RecipeEventJS) => void): void;
  function tick(handler: (event: SimpleEventJS) => void): void;
  function loaded(handler: (event: SimpleEventJS) => void): void;
  function unloaded(handler: (event: SimpleEventJS) => void): void;
  function entityLootTables(handler: (event: LootEventJS) => void): void;
  function blockLootTables(handler: (event: LootEventJS) => void): void;
  function command(handler: (event: CommandEventJS) => void): void;
  function tags(type: "item" | "block" | "fluid" | "entity_type", handler: (event: TagEventJS) => void): void;
}

// ===== Client Events =====

declare namespace ClientEvents {
  function tick(handler: (event: SimpleEventJS) => void): void;
  function loaded(handler: (event: SimpleEventJS) => void): void;
  function loggedIn(handler: (event: SimpleEventJS) => void): void;
}

// ===== Startup Events =====

declare namespace StartupEvents {
  function registry(type: string, handler: (event: RegistryEventJS) => void): void;
  function modifyItem(handler: (event: ItemModificationEventJS) => void): void;
  function postInit(handler: (event: SimpleEventJS) => void): void;
}

// ===== Event Interfaces =====

interface SimpleEventJS {
  server: MinecraftServer;
}

interface RecipeEventJS {
  recipes: RecipeRegistry;
  shaped(result: ItemStack | string, pattern: string[], keys: Record<string, Ingredient | string>): RecipeJS;
  shapeless(result: ItemStack | string, ingredients: (Ingredient | string)[]): RecipeJS;
  smelting(result: ItemStack | string, ingredient: Ingredient | string): RecipeJS;
  blasting(result: ItemStack | string, ingredient: Ingredient | string): RecipeJS;
  smoking(result: ItemStack | string, ingredient: Ingredient | string): RecipeJS;
  campfireCooking(result: ItemStack | string, ingredient: Ingredient | string): RecipeJS;
  stonecutting(result: ItemStack | string, ingredient: Ingredient | string): RecipeJS;
  smithing(result: ItemStack | string, base: Ingredient | string, addition: Ingredient | string): RecipeJS;
  custom(recipe: object): RecipeJS;
  remove(filter: RecipeFilter): void;
  replaceInput(filter: RecipeFilter, original: Ingredient | string, replacement: Ingredient | string): void;
  replaceOutput(filter: RecipeFilter, original: Ingredient | string, replacement: Ingredient | string): void;
}

interface RecipeRegistry {
  create: CreateRecipes;
  minecraft: MinecraftRecipes;
}

interface CreateRecipes {
  mixing(outputs: (ItemStack | string)[], inputs: (Ingredient | string)[]): RecipeJS;
  crushing(outputs: (ItemStack | string)[], input: Ingredient | string): RecipeJS;
  pressing(output: ItemStack | string, input: Ingredient | string): RecipeJS;
  cutting(output: ItemStack | string, input: Ingredient | string): RecipeJS;
  milling(outputs: (ItemStack | string)[], input: Ingredient | string): RecipeJS;
  compacting(output: ItemStack | string, inputs: (Ingredient | string)[]): RecipeJS;
  haunting(output: ItemStack | string, input: Ingredient | string): RecipeJS;
  washing(outputs: (ItemStack | string)[], input: Ingredient | string): RecipeJS;
  deploying(output: ItemStack | string, block: Ingredient | string, item: Ingredient | string): RecipeJS;
  filling(output: ItemStack | string, input: Ingredient | string, fluid: string, amount: number): RecipeJS;
  emptying(outputs: [ItemStack | string, string], input: Ingredient | string): RecipeJS;
}

interface MinecraftRecipes {
  crafting_shaped(result: ItemStack | string, pattern: string[], keys: Record<string, Ingredient | string>): RecipeJS;
  crafting_shapeless(result: ItemStack | string, ingredients: (Ingredient | string)[]): RecipeJS;
  smelting(result: ItemStack | string, ingredient: Ingredient | string): RecipeJS;
  blasting(result: ItemStack | string, ingredient: Ingredient | string): RecipeJS;
  smoking(result: ItemStack | string, ingredient: Ingredient | string): RecipeJS;
  stonecutting(result: ItemStack | string, ingredient: Ingredient | string): RecipeJS;
  smithing(result: ItemStack | string, base: Ingredient | string, addition: Ingredient | string): RecipeJS;
}

interface RecipeJS {
  id(id: string): this;
  cookingTime(ticks: number): this;
  xp(amount: number): this;
  chance(chance: number): this;
}

interface RecipeFilter {
  id?: string | RegExp;
  output?: Ingredient | string;
  input?: Ingredient | string;
  type?: string;
  mod?: string;
}

interface LootEventJS {
  modifyLootTable(id: string, handler: (table: LootTable) => void): void;
  addEntityLootModifier(entity: string): LootModifier;
  addBlockLootModifier(block: string): LootModifier;
}

interface LootTable {
  addPool(pool: LootPool): void;
}

interface LootPool {
  addItem(item: string, weight?: number): void;
}

interface LootModifier {
  addLoot(item: ItemStack | string): this;
  removeLoot(item: string): this;
  replaceLoot(original: string, replacement: ItemStack | string): this;
}

interface CommandEventJS {
  register(name: string, handler: (ctx: CommandContext) => void): void;
}

interface CommandContext {
  sender: Entity;
  getArgument(name: string, type: any): any;
  sendSuccess(message: string): void;
  sendFailure(message: string): void;
}

interface TagEventJS {
  add(tag: string, items: string | string[]): void;
  remove(tag: string, items: string | string[]): void;
  removeAll(tag: string): void;
  get(tag: string): string[];
}

interface RegistryEventJS {
  create(id: string): ItemBuilder;
  createBlock(id: string): BlockBuilder;
}

interface ItemBuilder {
  displayName(name: string): this;
  maxStackSize(size: number): this;
  rarity(rarity: "common" | "uncommon" | "rare" | "epic"): this;
  glow(enabled: boolean): this;
  tooltip(text: string): this;
  group(group: string): this;
  texture(texture: string): this;
  parentModel(model: string): this;
  food(builder: (food: FoodBuilder) => void): this;
}

interface BlockBuilder {
  displayName(name: string): this;
  material(material: string): this;
  hardness(hardness: number): this;
  resistance(resistance: number): this;
  lightLevel(level: number): this;
  requiresTool(requiresTool: boolean): this;
  texture(texture: string | Record<string, string>): this;
  model(model: string): this;
  item(builder: (item: ItemBuilder) => void): this;
  tagBoth(tag: string): this;
}

interface FoodBuilder {
  hunger(hunger: number): this;
  saturation(saturation: number): this;
  effect(effect: string, duration: number, amplifier: number, chance: number): this;
  alwaysEdible(): this;
  fastToEat(): this;
  meat(): this;
}

interface ItemModificationEventJS {
  modify(item: string, modifier: (item: ItemModification) => void): void;
}

interface ItemModification {
  maxStackSize: number;
  fireResistant: boolean;
  rarity: "common" | "uncommon" | "rare" | "epic";
}

// ===== Common Types =====

interface ItemStack {
  id: string;
  count?: number;
  nbt?: object;
  withCount(count: number): ItemStack;
  withNBT(nbt: object): ItemStack;
  withChance(chance: number): ItemStack;
}

type Ingredient = string | ItemStack;

interface MinecraftServer {
  runCommand(command: string): number;
  runCommandSilent(command: string): number;
  tell(message: string): void;
  getPlayers(): Player[];
  schedule(ticks: number, callback: () => void): void;
  scheduleRepeating(ticks: number, callback: () => void): void;
}

interface Player {
  name: string;
  give(item: ItemStack | string): void;
  tell(message: string): void;
  getX(): number;
  getY(): number;
  getZ(): number;
  teleport(x: number, y: number, z: number): void;
}

interface Entity {
  type: string;
  x: number;
  y: number;
  z: number;
  kill(): void;
  remove(): void;
  setNBT(nbt: object): void;
  getNBT(): object;
}

// ===== Utility Functions =====

declare namespace Item {
  function of(id: string, count?: number, nbt?: object): ItemStack;
  function getEmpty(): ItemStack;
}

declare namespace Block {
  function getBlock(id: string): any;
}

declare namespace Ingredient {
  function tag(tag: string): Ingredient;
  function of(id: string): Ingredient;
  function of(...items: string[]): Ingredient;
}

declare namespace Utils {
  function getServer(): MinecraftServer;
  function random(): number;
  function getSystemTime(): number;
  function parseJson(json: string): any;
  function toJson(obj: any): string;
}

declare namespace Text {
  function of(text: string): TextComponent;
  function translate(key: string, ...args: any[]): TextComponent;
}

interface TextComponent {
  color(color: string): this;
  bold(): this;
  italic(): this;
  underlined(): this;
  strikethrough(): this;
  append(text: string | TextComponent): this;
}

declare namespace NBT {
  function compound(data: object): any;
  function list(...items: any[]): any;
}

declare function console(message: any): void;
`;

/**
 * Register KubeJS type definitions with Monaco
 * This enables IntelliSense for KubeJS scripting
 */
export function registerKubeJSTypes(monaco: typeof Monaco) {
  try {
    // Check if TypeScript language support is available
    const ts = (monaco.languages as any).typescript;
    if (!ts || !ts.javascriptDefaults || !ts.typescriptDefaults) {
      console.warn("[Monaco] TypeScript language support not available, skipping KubeJS types registration");
      return;
    }

    // Add KubeJS types to Monaco's TypeScript compiler
    ts.javascriptDefaults.addExtraLib(kubeJSTypes, "kubejs.d.ts");
    ts.typescriptDefaults.addExtraLib(kubeJSTypes, "kubejs.d.ts");

    // Configure TypeScript compiler options
    ts.javascriptDefaults.setCompilerOptions({
      target: ts.ScriptTarget?.ES2020 || 99, // Fallback to numeric value
      allowNonTsExtensions: true,
      moduleResolution: ts.ModuleResolutionKind?.NodeJs || 2,
      module: ts.ModuleKind?.CommonJS || 1,
      noEmit: true,
      esModuleInterop: true,
      allowJs: true,
      typeRoots: ["kubejs"],
    });

    ts.typescriptDefaults.setCompilerOptions({
      target: ts.ScriptTarget?.ES2020 || 99,
      allowNonTsExtensions: true,
      moduleResolution: ts.ModuleResolutionKind?.NodeJs || 2,
      module: ts.ModuleKind?.CommonJS || 1,
      noEmit: true,
      esModuleInterop: true,
      jsx: ts.JsxEmit?.React || 2,
      typeRoots: ["kubejs"],
    });

    // Disable diagnostics for undefined globals
    ts.javascriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: false,
      noSyntaxValidation: false,
    });

    ts.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: false,
      noSyntaxValidation: false,
    });

    console.log("[Monaco] KubeJS type definitions registered");
  } catch (error) {
    console.warn("[Monaco] Failed to register KubeJS types:", error);
  }
}
