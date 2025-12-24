/**
 * KubeJS TypeScript Definitions
 * Core API for KubeJS scripting (Server/Client/Startup events)
 */

// ===== Global Utilities =====

declare function console(message: any): void;

// ===== Server Events =====

declare namespace ServerEvents {
  /**
   * Recipe modification event
   * Used for adding, removing, and modifying recipes
   */
  function recipes(handler: (event: RecipeEventJS) => void): void;

  /**
   * Server tick event (runs every tick)
   */
  function tick(handler: (event: SimpleEventJS) => void): void;

  /**
   * Server loaded event (runs once when server starts)
   */
  function loaded(handler: (event: SimpleEventJS) => void): void;

  /**
   * Server unloaded event (runs when server stops)
   */
  function unloaded(handler: (event: SimpleEventJS) => void): void;

  /**
   * Entity loot tables modification
   */
  function entityLootTables(handler: (event: LootEventJS) => void): void;

  /**
   * Block loot tables modification
   */
  function blockLootTables(handler: (event: LootEventJS) => void): void;

  /**
   * Command event (register custom commands)
   */
  function command(handler: (event: CommandEventJS) => void): void;

  /**
   * Tags modification (add/remove items from tags)
   */
  function tags(type: "item" | "block" | "fluid" | "entity_type", handler: (event: TagEventJS) => void): void;
}

// ===== Client Events =====

declare namespace ClientEvents {
  /**
   * Client tick event
   */
  function tick(handler: (event: SimpleEventJS) => void): void;

  /**
   * Client loaded event
   */
  function loaded(handler: (event: SimpleEventJS) => void): void;

  /**
   * Log message to client console
   */
  function loggedIn(handler: (event: SimpleEventJS) => void): void;
}

// ===== Startup Events =====

declare namespace StartupEvents {
  /**
   * Registry modification (add custom items/blocks)
   */
  function registry(type: string, handler: (event: RegistryEventJS) => void): void;

  /**
   * Item modification
   */
  function modifyItem(handler: (event: ItemModificationEventJS) => void): void;

  /**
   * Post-initialization event
   */
  function postInit(handler: (event: SimpleEventJS) => void): void;
}

// ===== Event Objects =====

interface SimpleEventJS {
  /**
   * Server reference
   */
  server: MinecraftServer;
}

interface RecipeEventJS {
  /**
   * Recipe registry
   */
  recipes: RecipeRegistry;

  /**
   * Create a shaped recipe (crafting table pattern)
   */
  shaped(result: ItemStack | string, pattern: string[], keys: Record<string, Ingredient | string>): RecipeJS;

  /**
   * Create a shapeless recipe (order doesn't matter)
   */
  shapeless(result: ItemStack | string, ingredients: (Ingredient | string)[]): RecipeJS;

  /**
   * Create a smelting recipe
   */
  smelting(result: ItemStack | string, ingredient: Ingredient | string): RecipeJS;

  /**
   * Create a blasting recipe (blast furnace)
   */
  blasting(result: ItemStack | string, ingredient: Ingredient | string): RecipeJS;

  /**
   * Create a smoking recipe (smoker)
   */
  smoking(result: ItemStack | string, ingredient: Ingredient | string): RecipeJS;

  /**
   * Create a campfire cooking recipe
   */
  campfireCooking(result: ItemStack | string, ingredient: Ingredient | string): RecipeJS;

  /**
   * Create a stonecutting recipe
   */
  stonecutting(result: ItemStack | string, ingredient: Ingredient | string): RecipeJS;

  /**
   * Create a smithing recipe
   */
  smithing(result: ItemStack | string, base: Ingredient | string, addition: Ingredient | string): RecipeJS;

  /**
   * Create a custom recipe (for mod recipes)
   */
  custom(recipe: object): RecipeJS;

  /**
   * Remove recipes matching filter
   */
  remove(filter: RecipeFilter): void;

  /**
   * Replace input ingredient in recipes
   */
  replaceInput(filter: RecipeFilter, original: Ingredient | string, replacement: Ingredient | string): void;

  /**
   * Replace output item in recipes
   */
  replaceOutput(filter: RecipeFilter, original: Ingredient | string, replacement: Ingredient | string): void;
}

interface RecipeRegistry {
  /**
   * Create mod recipes (various mods supported)
   */
  create: CreateRecipes;
  minecraft: MinecraftRecipes;
  // Add more mod recipe registries as needed
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
  /**
   * Set recipe ID
   */
  id(id: string): this;

  /**
   * Set cooking time (furnace recipes)
   */
  cookingTime(ticks: number): this;

  /**
   * Set experience reward
   */
  xp(amount: number): this;

  /**
   * Add a chance for output (0.0 - 1.0)
   */
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
  /**
   * Modify loot table
   */
  modifyLootTable(id: string, handler: (table: LootTable) => void): void;

  /**
   * Add loot to entity
   */
  addEntityLootModifier(entity: string): LootModifier;

  /**
   * Add loot to block
   */
  addBlockLootModifier(block: string): LootModifier;
}

interface LootTable {
  /**
   * Add pool to loot table
   */
  addPool(pool: LootPool): void;
}

interface LootPool {
  /**
   * Add item to pool
   */
  addItem(item: string, weight?: number): void;
}

interface LootModifier {
  /**
   * Add item drop
   */
  addLoot(item: ItemStack | string): this;

  /**
   * Remove item drop
   */
  removeLoot(item: string): this;

  /**
   * Replace item drop
   */
  replaceLoot(original: string, replacement: ItemStack | string): this;
}

interface CommandEventJS {
  /**
   * Register a command
   */
  register(name: string, handler: (ctx: CommandContext) => void): void;
}

interface CommandContext {
  /**
   * Get command sender
   */
  sender: Entity;

  /**
   * Get argument
   */
  getArgument(name: string, type: any): any;

  /**
   * Send message to sender
   */
  sendSuccess(message: string): void;

  /**
   * Send error message
   */
  sendFailure(message: string): void;
}

interface TagEventJS {
  /**
   * Add item/block to tag
   */
  add(tag: string, items: string | string[]): void;

  /**
   * Remove item/block from tag
   */
  remove(tag: string, items: string | string[]): void;

  /**
   * Remove all items from tag
   */
  removeAll(tag: string): void;

  /**
   * Get all items in tag
   */
  get(tag: string): string[];
}

interface RegistryEventJS {
  /**
   * Create custom item
   */
  create(id: string): ItemBuilder;

  /**
   * Create custom block
   */
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
  /**
   * Modify existing item properties
   */
  modify(item: string, modifier: (item: ItemModification) => void): void;
}

interface ItemModification {
  maxStackSize: number;
  fireResistant: boolean;
  rarity: "common" | "uncommon" | "rare" | "epic";
}

// ===== Common Types =====

interface ItemStack {
  /**
   * Item ID (e.g., "minecraft:diamond")
   */
  id: string;

  /**
   * Stack count
   */
  count?: number;

  /**
   * NBT data
   */
  nbt?: object;

  /**
   * Create with count
   */
  withCount(count: number): ItemStack;

  /**
   * Create with NBT
   */
  withNBT(nbt: object): ItemStack;

  /**
   * Create with chance (for recipes)
   */
  withChance(chance: number): ItemStack;
}

/**
 * Item or tag reference for recipes
 * Can be:
 * - "minecraft:diamond" - specific item
 * - "#forge:ingots/iron" - tag
 * - Item.of("minecraft:diamond", 2) - item with count
 */
type Ingredient = string | ItemStack;

interface MinecraftServer {
  /**
   * Run command on server
   */
  runCommand(command: string): number;

  /**
   * Run command silently (no output)
   */
  runCommandSilent(command: string): number;

  /**
   * Tell all players
   */
  tell(message: string): void;

  /**
   * Get all online players
   */
  getPlayers(): Player[];

  /**
   * Schedule task
   */
  schedule(ticks: number, callback: () => void): void;

  /**
   * Schedule repeating task
   */
  scheduleRepeating(ticks: number, callback: () => void): void;
}

interface Player {
  /**
   * Player name
   */
  name: string;

  /**
   * Give item to player
   */
  give(item: ItemStack | string): void;

  /**
   * Send message to player
   */
  tell(message: string): void;

  /**
   * Get player position
   */
  getX(): number;
  getY(): number;
  getZ(): number;

  /**
   * Teleport player
   */
  teleport(x: number, y: number, z: number): void;
}

interface Entity {
  /**
   * Entity type
   */
  type: string;

  /**
   * Entity position
   */
  x: number;
  y: number;
  z: number;

  /**
   * Kill entity
   */
  kill(): void;

  /**
   * Remove entity
   */
  remove(): void;

  /**
   * Set entity NBT
   */
  setNBT(nbt: object): void;

  /**
   * Get entity NBT
   */
  getNBT(): object;
}

// ===== Utility Functions =====

declare namespace Item {
  /**
   * Create ItemStack
   */
  function of(id: string, count?: number, nbt?: object): ItemStack;

  /**
   * Get empty ItemStack
   */
  function getEmpty(): ItemStack;
}

declare namespace Block {
  /**
   * Get block by ID
   */
  function getBlock(id: string): any;
}

declare namespace Ingredient {
  /**
   * Create ingredient from tag
   */
  function tag(tag: string): Ingredient;

  /**
   * Create ingredient from item ID
   */
  function of(id: string): Ingredient;

  /**
   * Create ingredient from multiple items
   */
  function of(...items: string[]): Ingredient;
}

declare namespace Utils {
  /**
   * Get server instance
   */
  function getServer(): MinecraftServer;

  /**
   * Roll random number 0-1
   */
  function random(): number;

  /**
   * Get current time in milliseconds
   */
  function getSystemTime(): number;

  /**
   * Parse JSON
   */
  function parseJson(json: string): any;

  /**
   * Stringify to JSON
   */
  function toJson(obj: any): string;
}

declare namespace Text {
  /**
   * Create colored text
   */
  function of(text: string): TextComponent;

  /**
   * Create translatable text
   */
  function translate(key: string, ...args: any[]): TextComponent;
}

interface TextComponent {
  /**
   * Set text color
   */
  color(color: string): this;

  /**
   * Make text bold
   */
  bold(): this;

  /**
   * Make text italic
   */
  italic(): this;

  /**
   * Add underline
   */
  underlined(): this;

  /**
   * Add strikethrough
   */
  strikethrough(): this;

  /**
   * Append text
   */
  append(text: string | TextComponent): this;
}

declare namespace NBT {
  /**
   * Create NBT compound
   */
  function compound(data: object): any;

  /**
   * Create NBT list
   */
  function list(...items: any[]): any;
}
