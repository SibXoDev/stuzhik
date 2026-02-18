/**
 * UIPreferences — централизованное хранилище настроек интерфейса.
 *
 * Архитектура:
 * - Тема (SurfaceTheme): фон, текст, бордеры, тени — любое количество
 * - Акцент (AccentTheme): --color-primary-* — ортогонально к теме
 * - makeSurfaceTheme() — генерирует тему из 5 ключевых цветов
 * - makeAccent() — генерирует акцент из одного hex-цвета
 * - View modes: grid / list / compact для каждой секции
 * - Visibility toggles: показ/скрытие любого элемента интерфейса
 * - Layout: плотность, размер шрифта, колонки, ширина контента
 * - Профили: сохранение/загрузка/удаление/экспорт/импорт пресетов
 * - Миграции: versioned schema с автоматическим обновлением
 */
import { createSignal } from "solid-js";

// ==================== Types ====================

export type ViewMode = "grid" | "list" | "compact";
export type CardDensity = "compact" | "normal" | "comfortable";
export type FontScale = "small" | "default" | "large";
export type TextAlign = "left" | "center";

/**
 * ShapeConfig — форма элементов (скругления, отступы, размытие).
 * Опционально включается в SurfaceTheme — если не задано, используются CSS-дефолты из :root.
 * Все значения — CSS-строки (rem, px).
 */
export interface ShapeConfig {
  radiusSm?: string;    // --radius-sm (default 0.25rem)
  radiusMd?: string;    // --radius-md (default 0.375rem)
  radiusLg?: string;    // --radius-lg (default 0.5rem)
  radiusXl?: string;    // --radius-xl (default 0.75rem)
  radius2xl?: string;   // --radius-2xl (default 1rem)
  radius3xl?: string;   // --radius-3xl (default 1.5rem)
  radiusFull?: string;  // --radius-full (default 9999px)
  spacingXs?: string;   // --spacing-xs (default 0.25rem)
  spacingSm?: string;   // --spacing-sm (default 0.5rem)
  spacingMd?: string;   // --spacing-md (default 1rem)
  spacingLg?: string;   // --spacing-lg (default 1.5rem)
  spacingXl?: string;   // --spacing-xl (default 2rem)
  blurSm?: string;      // --blur-sm (default 4px)
  blurMd?: string;      // --blur-md (default 8px)
  blurLg?: string;      // --blur-lg (default 16px)
}

/** Пресеты формы */
export const SHAPE_PRESETS: Record<string, { name: string; shape: ShapeConfig }> = {
  default: {
    name: "Default",
    shape: {},  // uses :root defaults (round)
  },
  sharp: {
    name: "Sharp",
    shape: {
      radiusSm: "0.125rem", radiusMd: "0.1875rem", radiusLg: "0.25rem",
      radiusXl: "0.375rem", radius2xl: "0.5rem", radius3xl: "0.75rem",
    },
  },
  round: {
    name: "Round",
    shape: {
      radiusSm: "0.5rem", radiusMd: "0.75rem", radiusLg: "1rem",
      radiusXl: "1.5rem", radius2xl: "2rem", radius3xl: "2.5rem",
    },
  },
  square: {
    name: "Square",
    shape: {
      radiusSm: "0px", radiusMd: "0px", radiusLg: "0px",
      radiusXl: "0px", radius2xl: "0px", radius3xl: "0px",
    },
  },
};

/**
 * SurfaceTheme — полная тема оформления (фон, текст, бордеры, тени, форма).
 * Применяется через CSS-переменные --color-bg-*, --color-text-*, --color-border-*, --shadow-*, --radius-*, --spacing-*, --blur-*.
 *
 * Добавить новую тему = один вызов makeSurfaceTheme():
 *   makeSurfaceTheme("OLED Black", "#000000", "#111111", "#ffffff", "#888888", "#333333", "dark")
 */
export interface SurfaceTheme {
  name: string;
  colorScheme: "dark" | "light";
  // Backgrounds
  bg: string;
  bgElevated: string;
  bgElevatedHover: string;
  bgInput: string;
  bgCard: string;
  bgOverlay: string;
  bgModal: string;
  bgHover: string;
  bgActive: string;
  bgGlass: string;
  // Text
  text: string;
  textSecondary: string;
  textMuted: string;
  textDim: string;
  textDimmer: string;
  textInverse: string;
  // Borders
  border: string;
  borderLight: string;
  borderLighter: string;
  borderHover: string;
  // Shadows
  shadowSm: string;
  shadowMd: string;
  shadowLg: string;
  shadowXl: string;
  // Semantic bg/border alpha (для success/warning/danger/info/purple)
  semanticBgAlpha: number;
  semanticBorderAlpha: number;
  // Shape (optional — если не задано, используются дефолты из :root)
  shape?: ShapeConfig;
}

/** AccentTheme — акцентный цвет (--color-primary-*). Ортогонален к SurfaceTheme. */
export interface AccentTheme {
  name: string;
  accent: string;       // --color-primary
  accentHover: string;  // --color-primary-hover
  accentActive: string; // --color-primary-active
  accentLight: string;  // --color-primary-light
  accentDark: string;   // --color-primary-dark
  accentBg: string;     // --color-primary-bg (rgba)
  accentBorder: string; // --color-primary-border (rgba)
}

export interface LayoutConfig {
  cardDensity: CardDensity;
  fontSize: FontScale;
  contentMaxWidth: number;  // px, 0 = full
  instanceColumns: number;  // 0 = auto
  menuAlign: TextAlign;     // text alignment for menus, sidebar, etc.
}

export interface UIProfile {
  name: string;
  icon: string;
  createdAt: number;
  snapshot: UIPreferencesSnapshot;
}

/** Снимок настроек (без профилей — чтобы не было рекурсии) */
export interface UIPreferencesSnapshot {
  viewModes: Record<string, ViewMode>;
  visibility: Record<string, boolean>;
  layout: LayoutConfig;
  activeTheme: string;
  activeAccent: string;
  activeShape: string;
  customThemes: Record<string, SurfaceTheme>;
  customAccents: Record<string, AccentTheme>;
  sectionOrder: string[];
}

export interface UIPreferencesData {
  _version: number;
  viewModes: Record<string, ViewMode>;
  visibility: Record<string, boolean>;
  layout: LayoutConfig;
  activeTheme: string;
  activeAccent: string;
  activeShape: string;
  customThemes: Record<string, SurfaceTheme>;
  customAccents: Record<string, AccentTheme>;
  sectionOrder: string[];
  activeProfile: string;
  profiles: Record<string, UIProfile>;
}

// ==================== Helpers ====================

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function lighten(hex: string, amount: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const lr = Math.min(255, Math.round(r + (255 - r) * amount));
  const lg = Math.min(255, Math.round(g + (255 - g) * amount));
  const lb = Math.min(255, Math.round(b + (255 - b) * amount));
  return `#${lr.toString(16).padStart(2, "0")}${lg.toString(16).padStart(2, "0")}${lb.toString(16).padStart(2, "0")}`;
}

function darken(hex: string, amount: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const dr = Math.max(0, Math.round(r * (1 - amount)));
  const dg = Math.max(0, Math.round(g * (1 - amount)));
  const db = Math.max(0, Math.round(b * (1 - amount)));
  return `#${dr.toString(16).padStart(2, "0")}${dg.toString(16).padStart(2, "0")}${db.toString(16).padStart(2, "0")}`;
}

function lerpColor(hex1: string, hex2: string, t: number): string {
  const r1 = parseInt(hex1.slice(1, 3), 16);
  const g1 = parseInt(hex1.slice(3, 5), 16);
  const b1 = parseInt(hex1.slice(5, 7), 16);
  const r2 = parseInt(hex2.slice(1, 3), 16);
  const g2 = parseInt(hex2.slice(3, 5), 16);
  const b2 = parseInt(hex2.slice(5, 7), 16);
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const b = Math.round(b1 + (b2 - b1) * t);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

/** Derive full gray scale from SurfaceTheme key colors */
function deriveGrayScale(theme: SurfaceTheme): Record<string, string> {
  return {
    '50': lighten(theme.text, 0.6),
    '100': lighten(theme.text, 0.35),
    '200': theme.text,
    '300': theme.textSecondary,
    '400': theme.textMuted,
    '500': theme.textDim,
    '600': theme.textDimmer,
    '700': theme.bgActive,
    '750': theme.bgHover,
    '800': theme.bgElevatedHover,
    '850': theme.bgElevated,
    '900': lerpColor(theme.bg, theme.bgElevated, 0.5),
    '925': lerpColor(theme.bg, theme.bgElevated, 0.25),
    '950': theme.bg,
    '975': darken(theme.bg, 0.2),
  };
}

// ==================== Surface Theme Factory ====================

/**
 * Генерирует полную SurfaceTheme из 5 ключевых цветов.
 * Все остальные значения вычисляются автоматически.
 *
 * @param name     Название темы
 * @param bg       Основной фон (напр. "#0d0e11" для dark, "#f5f6f8" для light)
 * @param elevated Фон карточек/панелей (напр. "#1a1b1f" для dark, "#ffffff" для light)
 * @param text     Основной цвет текста
 * @param muted    Приглушённый текст
 * @param border   Основной цвет бордера
 * @param scheme   "dark" | "light" — hint для браузера
 */
export function makeSurfaceTheme(
  name: string,
  bg: string,
  elevated: string,
  text: string,
  muted: string,
  border: string,
  scheme: "dark" | "light",
): SurfaceTheme {
  const isDark = scheme === "dark";
  const shadowAlpha = isDark ? 0.3 : 0.06;

  return {
    name,
    colorScheme: scheme,
    // Backgrounds
    bg,
    bgElevated: elevated,
    bgElevatedHover: isDark ? lighten(elevated, 0.08) : darken(elevated, 0.03),
    bgInput: elevated,
    bgCard: hexToRgba(elevated, 0.8),
    bgOverlay: hexToRgba(bg, 0.9),
    bgModal: elevated,
    bgHover: isDark ? lighten(bg, 0.08) : darken(bg, 0.04),
    bgActive: isDark ? lighten(bg, 0.14) : darken(bg, 0.08),
    bgGlass: hexToRgba(elevated, 0.6),
    // Text
    text,
    textSecondary: isDark ? darken(text, 0.1) : lighten(text, 0.15),
    textMuted: muted,
    textDim: isDark ? darken(muted, 0.25) : lighten(muted, 0.2),
    textDimmer: isDark ? darken(muted, 0.45) : lighten(muted, 0.4),
    textInverse: bg,
    // Borders
    border,
    borderLight: isDark ? lighten(border, 0.12) : darken(border, 0.08),
    borderLighter: isDark ? lighten(border, 0.25) : darken(border, 0.15),
    borderHover: isDark ? lighten(border, 0.12) : darken(border, 0.12),
    // Shadows
    shadowSm: `0 1px 2px 0 rgba(0, 0, 0, ${shadowAlpha})`,
    shadowMd: `0 4px 6px -1px rgba(0, 0, 0, ${shadowAlpha * 1.3})`,
    shadowLg: `0 10px 15px -3px rgba(0, 0, 0, ${shadowAlpha * 1.7})`,
    shadowXl: `0 20px 25px -5px rgba(0, 0, 0, ${shadowAlpha * 2})`,
    // Semantic
    semanticBgAlpha: isDark ? 0.1 : 0.08,
    semanticBorderAlpha: isDark ? 0.3 : 0.25,
  };
}

// ==================== Built-in Surface Themes ====================

export const BUILT_IN_THEMES: Record<string, SurfaceTheme> = {
  dark: makeSurfaceTheme(
    "Dark",
    "#0d0e11",   // bg
    "#1a1b1f",   // elevated
    "#e5e7eb",   // text
    "#9ca3af",   // muted
    "#2a2b2f",   // border
    "dark",
  ),
  light: makeSurfaceTheme(
    "Light",
    "#f5f6f8",   // bg
    "#ffffff",   // elevated
    "#1a1b1f",   // text
    "#6e6f74",   // muted
    "#d4d5d9",   // border
    "light",
  ),
};

// ==================== Accent Factory ====================

function makeAccent(
  name: string,
  accent: string,
  hover: string,
  active: string,
  light: string,
  dark: string,
): AccentTheme {
  return {
    name,
    accent,
    accentHover: hover,
    accentActive: active,
    accentLight: light,
    accentDark: dark,
    accentBg: hexToRgba(accent, 0.1),
    accentBorder: hexToRgba(accent, 0.3),
  };
}

// ==================== Built-in Accents ====================

export const BUILT_IN_ACCENTS: Record<string, AccentTheme> = {
  default:  makeAccent("Default",  "#3b82f6", "#60a5fa", "#2563eb", "#93c5fd", "#1d4ed8"),
  midnight: makeAccent("Midnight", "#8b5cf6", "#a78bfa", "#7c3aed", "#c4b5fd", "#6d28d9"),
  ocean:    makeAccent("Ocean",    "#06b6d4", "#22d3ee", "#0891b2", "#67e8f9", "#0e7490"),
  forest:   makeAccent("Forest",   "#10b981", "#34d399", "#059669", "#6ee7b7", "#047857"),
  crimson:  makeAccent("Crimson",  "#ef4444", "#f87171", "#dc2626", "#fca5a5", "#b91c1c"),
  amber:    makeAccent("Amber",    "#f59e0b", "#fbbf24", "#d97706", "#fcd34d", "#b45309"),
  rose:     makeAccent("Rose",     "#f43f5e", "#fb7185", "#e11d48", "#fda4af", "#be123c"),
  sky:      makeAccent("Sky",      "#0ea5e9", "#38bdf8", "#0284c7", "#7dd3fc", "#0369a1"),
};

/** Генерирует AccentTheme из одного hex-цвета */
export function generateAccentFromColor(name: string, hex: string): AccentTheme {
  return {
    name,
    accent: hex,
    accentHover: lighten(hex, 0.2),
    accentActive: darken(hex, 0.15),
    accentLight: lighten(hex, 0.45),
    accentDark: darken(hex, 0.35),
    accentBg: hexToRgba(hex, 0.1),
    accentBorder: hexToRgba(hex, 0.3),
  };
}


// ==================== Defaults ====================

const CURRENT_VERSION = 2;
const STORAGE_KEY = "stuzhik_ui_prefs";

const DEFAULT_VIEW_MODES: Record<string, ViewMode> = {
  instances: "grid",
  mods: "list",
  modpacks: "grid",
  backups: "list",
  servers: "list",
  resources: "grid",
};

const DEFAULT_VISIBILITY: Record<string, boolean> = {
  instanceBadges: true,
  instancePlaytime: true,
  instanceQuickPlay: true,
  modDescriptions: true,
  modThumbnails: true,
  modpackChangelogs: true,
  toolsMenu: true,
  connectButton: true,
  downloadNotifications: true,
  searchBar: true,
  titleBarIcons: true,
};

const DEFAULT_LAYOUT: LayoutConfig = {
  cardDensity: "normal",
  fontSize: "default",
  contentMaxWidth: 1600,
  instanceColumns: 0,
  menuAlign: "left",
};

const DEFAULT_SECTION_ORDER = [
  "instances",
  "mods",
  "modpacks",
  "servers",
  "backups",
  "resources",
];

function createDefaults(): UIPreferencesData {
  return {
    _version: CURRENT_VERSION,
    viewModes: { ...DEFAULT_VIEW_MODES },
    visibility: { ...DEFAULT_VISIBILITY },
    layout: { ...DEFAULT_LAYOUT },
    activeTheme: "dark",
    activeAccent: "default",
    activeShape: "default",
    customThemes: {},
    customAccents: {},
    sectionOrder: [...DEFAULT_SECTION_ORDER],
    activeProfile: "default",
    profiles: {},
  };
}

// ==================== Migration ====================

function migratePreferences(raw: unknown): UIPreferencesData {
  if (!raw || typeof raw !== "object") return createDefaults();

  const obj = raw as Record<string, unknown>;
  const version = typeof obj._version === "number" ? obj._version : 0;

  const defaults = createDefaults();

  // v1 → v2: rename activeTheme→activeAccent, colorMode→activeTheme, customThemes→customAccents
  let activeTheme = defaults.activeTheme;
  let activeAccent = defaults.activeAccent;
  let customAccents: Record<string, AccentTheme> = {};
  const customThemes: Record<string, SurfaceTheme> = {};

  if (version < 2) {
    // v1 had: activeTheme = accent id, colorMode = "dark"|"light", customThemes = accent themes
    activeAccent = typeof obj.activeTheme === "string" ? obj.activeTheme : "default";
    activeTheme = obj.colorMode === "light" ? "light" : "dark";
    customAccents = (obj.customThemes as Record<string, AccentTheme>) ?? {};
  } else {
    activeTheme = typeof obj.activeTheme === "string" ? obj.activeTheme : defaults.activeTheme;
    activeAccent = typeof obj.activeAccent === "string" ? obj.activeAccent : defaults.activeAccent;
    customAccents = (obj.customAccents as Record<string, AccentTheme>) ?? {};
    Object.assign(customThemes, (obj.customThemes as Record<string, SurfaceTheme>) ?? {});
  }

  return {
    _version: CURRENT_VERSION,
    viewModes: { ...defaults.viewModes, ...(obj.viewModes as Record<string, ViewMode> ?? {}) },
    visibility: { ...defaults.visibility, ...(obj.visibility as Record<string, boolean> ?? {}) },
    layout: { ...defaults.layout, ...(obj.layout as LayoutConfig ?? {}) },
    activeTheme,
    activeAccent,
    activeShape: typeof obj.activeShape === "string" ? obj.activeShape : "default",
    customThemes,
    customAccents,
    sectionOrder: Array.isArray(obj.sectionOrder) ? obj.sectionOrder as string[] : defaults.sectionOrder,
    activeProfile: typeof obj.activeProfile === "string" ? obj.activeProfile : "default",
    profiles: (obj.profiles as Record<string, UIProfile>) ?? {},
  };
}

// ==================== Persistence ====================

function loadFromStorage(): UIPreferencesData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return migratePreferences(JSON.parse(raw));
  } catch { /* corrupted → defaults */ }
  return createDefaults();
}

function saveToStorage(data: UIPreferencesData): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch { /* storage full */ }
}

// ==================== Reactive Store ====================

const [preferences, _setPreferences] = createSignal<UIPreferencesData>(loadFromStorage());

function update(fn: (prev: UIPreferencesData) => UIPreferencesData): void {
  _setPreferences(prev => {
    const next = fn(prev);
    saveToStorage(next);
    return next;
  });
}

// ==================== View Modes ====================

export function getViewMode(section: string): ViewMode {
  return preferences().viewModes[section] ?? "grid";
}

export function setViewMode(section: string, mode: ViewMode): void {
  update(prev => ({
    ...prev,
    viewModes: { ...prev.viewModes, [section]: mode },
  }));
}

// ==================== Visibility ====================

export function isVisible(key: string): boolean {
  return preferences().visibility[key] ?? true;
}

export function setVisible(key: string, visible: boolean): void {
  update(prev => ({
    ...prev,
    visibility: { ...prev.visibility, [key]: visible },
  }));
}

// ==================== Layout ====================

export function getLayout(): LayoutConfig {
  return preferences().layout;
}

export function setLayoutField<K extends keyof LayoutConfig>(key: K, value: LayoutConfig[K]): void {
  update(prev => ({
    ...prev,
    layout: { ...prev.layout, [key]: value },
  }));
}

// ==================== Section Order ====================

export function getSectionOrder(): string[] {
  return preferences().sectionOrder;
}

export function setSectionOrder(order: string[]): void {
  update(prev => ({ ...prev, sectionOrder: order }));
}

// ==================== Surface Themes ====================

export function getActiveTheme(): string {
  return preferences().activeTheme;
}

export function resolveTheme(id: string): SurfaceTheme | undefined {
  return BUILT_IN_THEMES[id] ?? preferences().customThemes[id];
}

export function setActiveTheme(id: string): void {
  update(prev => ({ ...prev, activeTheme: id }));
  applyTheme(id);
}

export function getCustomThemes(): Record<string, SurfaceTheme> {
  return preferences().customThemes;
}

export function saveCustomTheme(id: string, theme: SurfaceTheme): void {
  update(prev => ({
    ...prev,
    customThemes: { ...prev.customThemes, [id]: theme },
  }));
}

export function deleteCustomTheme(id: string): void {
  update(prev => {
    const { [id]: _, ...rest } = prev.customThemes;
    return {
      ...prev,
      customThemes: rest,
      activeTheme: prev.activeTheme === id ? "dark" : prev.activeTheme,
    };
  });
  if (preferences().activeTheme === "dark") {
    applyTheme("dark");
  }
}

// ==================== Accent Colors ====================

export function getActiveAccent(): string {
  return preferences().activeAccent;
}

export function resolveAccent(id: string): AccentTheme | undefined {
  return BUILT_IN_ACCENTS[id] ?? preferences().customAccents[id];
}

export function setActiveAccent(id: string): void {
  update(prev => ({ ...prev, activeAccent: id }));
  applyAccent(id);
}

export function getCustomAccents(): Record<string, AccentTheme> {
  return preferences().customAccents;
}

export function saveCustomAccent(id: string, accent: AccentTheme): void {
  update(prev => ({
    ...prev,
    customAccents: { ...prev.customAccents, [id]: accent },
  }));
}

export function deleteCustomAccent(id: string): void {
  update(prev => {
    const { [id]: _, ...rest } = prev.customAccents;
    return {
      ...prev,
      customAccents: rest,
      activeAccent: prev.activeAccent === id ? "default" : prev.activeAccent,
    };
  });
  if (preferences().activeAccent === "default") {
    applyAccent("default");
  }
}

// ==================== Apply Theme (CSS vars) ====================

/** Применяет SurfaceTheme — устанавливает все CSS-переменные фона, текста, бордеров, теней */
export function applyTheme(id: string): void {
  const theme = resolveTheme(id);
  if (!theme) return;

  const root = document.documentElement;
  // Color scheme hint for browser (scrollbars, form elements)
  root.style.setProperty("color-scheme", theme.colorScheme);
  root.setAttribute("data-theme", id);

  // Backgrounds
  root.style.setProperty("--color-bg", theme.bg);
  root.style.setProperty("--color-bg-elevated", theme.bgElevated);
  root.style.setProperty("--color-bg-elevated-hover", theme.bgElevatedHover);
  root.style.setProperty("--color-bg-input", theme.bgInput);
  root.style.setProperty("--color-bg-card", theme.bgCard);
  root.style.setProperty("--color-bg-overlay", theme.bgOverlay);
  root.style.setProperty("--color-bg-modal", theme.bgModal);
  root.style.setProperty("--color-bg-hover", theme.bgHover);
  root.style.setProperty("--color-bg-active", theme.bgActive);
  root.style.setProperty("--color-bg-glass", theme.bgGlass);

  // Text
  root.style.setProperty("--color-text", theme.text);
  root.style.setProperty("--color-text-secondary", theme.textSecondary);
  root.style.setProperty("--color-text-muted", theme.textMuted);
  root.style.setProperty("--color-text-dim", theme.textDim);
  root.style.setProperty("--color-text-dimmer", theme.textDimmer);
  root.style.setProperty("--color-text-inverse", theme.textInverse);

  // Borders
  root.style.setProperty("--color-border", theme.border);
  root.style.setProperty("--color-border-light", theme.borderLight);
  root.style.setProperty("--color-border-lighter", theme.borderLighter);
  root.style.setProperty("--color-border-hover", theme.borderHover);

  // Shadows
  root.style.setProperty("--shadow-sm", theme.shadowSm);
  root.style.setProperty("--shadow-md", theme.shadowMd);
  root.style.setProperty("--shadow-lg", theme.shadowLg);
  root.style.setProperty("--shadow-xl", theme.shadowXl);

  // Semantic color backgrounds/borders — adjust alpha based on theme
  const semantics = ["success", "warning", "danger", "info", "purple"];
  const semanticColors: Record<string, string> = {
    success: "#10b981", warning: "#f59e0b", danger: "#ef4444",
    info: "#06b6d4", purple: "#8b5cf6",
  };
  for (const s of semantics) {
    root.style.setProperty(`--color-${s}-bg`, hexToRgba(semanticColors[s], theme.semanticBgAlpha));
    root.style.setProperty(`--color-${s}-border`, hexToRgba(semanticColors[s], theme.semanticBorderAlpha));
  }

  // Gray scale — derive from theme colors for light/custom themes, reset for dark
  // For dark built-in: :root defaults match, no override needed.
  // For light/custom: deriveGrayScale() maps semantic colors → shade numbers,
  // so bg-gray-850 becomes white in light mode, dark text in gray-200, etc.
  const grayShades = ['50','100','200','300','400','500','600','700','750','800','850','900','925','950','975'];
  if (id === "dark") {
    // Reset to :root defaults (they already match the dark theme)
    for (const shade of grayShades) {
      root.style.removeProperty(`--color-gray-${shade}`);
    }
  } else {
    const grayScale = deriveGrayScale(theme);
    for (const shade of grayShades) {
      if (grayScale[shade]) {
        root.style.setProperty(`--color-gray-${shade}`, grayScale[shade]);
      }
    }
  }

  // Shape overrides from theme (if any)
  if (theme.shape) {
    applyShapeConfig(theme.shape);
  }
}

/** Применяет AccentTheme — устанавливает CSS-переменные --color-primary-* */
export function applyAccent(id: string): void {
  const accent = resolveAccent(id);
  if (!accent) return;

  const root = document.documentElement;
  root.style.setProperty("--color-primary", accent.accent);
  root.style.setProperty("--color-primary-hover", accent.accentHover);
  root.style.setProperty("--color-primary-active", accent.accentActive);
  root.style.setProperty("--color-primary-light", accent.accentLight);
  root.style.setProperty("--color-primary-dark", accent.accentDark);
  root.style.setProperty("--color-primary-bg", accent.accentBg);
  root.style.setProperty("--color-primary-border", accent.accentBorder);
  root.style.setProperty("--color-border-focus", accent.accent);
  root.setAttribute("data-accent", id);
}

/** Применяет layout настройки (font-size, max-width, menu alignment) к документу */
export function applyLayout(): void {
  const layout = getLayout();
  const root = document.documentElement;

  const fontSizeMap: Record<FontScale, string> = {
    small: "14px",
    default: "16px",
    large: "18px",
  };
  root.style.setProperty("font-size", fontSizeMap[layout.fontSize]);
  root.setAttribute("data-density", layout.cardDensity);
  root.setAttribute("data-menu-align", layout.menuAlign ?? "left");
}

export function getMenuAlign(): TextAlign {
  return getLayout().menuAlign ?? "left";
}

export function setMenuAlign(align: TextAlign): void {
  setLayoutField("menuAlign", align);
  document.documentElement.setAttribute("data-menu-align", align);
}

// ==================== Shape ====================

/** Маппинг ShapeConfig полей → CSS-переменных */
const SHAPE_VAR_MAP: Record<keyof ShapeConfig, string> = {
  radiusSm: "--radius-sm",
  radiusMd: "--radius-md",
  radiusLg: "--radius-lg",
  radiusXl: "--radius-xl",
  radius2xl: "--radius-2xl",
  radius3xl: "--radius-3xl",
  radiusFull: "--radius-full",
  spacingXs: "--spacing-xs",
  spacingSm: "--spacing-sm",
  spacingMd: "--spacing-md",
  spacingLg: "--spacing-lg",
  spacingXl: "--spacing-xl",
  blurSm: "--blur-sm",
  blurMd: "--blur-md",
  blurLg: "--blur-lg",
};

/** Применяет ShapeConfig — устанавливает CSS-переменные скругления, отступов, размытия */
function applyShapeConfig(shape: ShapeConfig): void {
  const root = document.documentElement;
  for (const [key, cssVar] of Object.entries(SHAPE_VAR_MAP)) {
    const value = shape[key as keyof ShapeConfig];
    if (value != null) {
      root.style.setProperty(cssVar, value);
    } else {
      root.style.removeProperty(cssVar);
    }
  }
}

export function getActiveShape(): string {
  return preferences().activeShape;
}

export function resolveShape(id: string): ShapeConfig {
  return SHAPE_PRESETS[id]?.shape ?? {};
}

export function setActiveShape(id: string): void {
  update(prev => ({ ...prev, activeShape: id }));
  applyShape(id);
}

/** Применяет пресет формы по id */
export function applyShape(id: string): void {
  const shape = resolveShape(id);
  applyShapeConfig(shape);
  document.documentElement.setAttribute("data-shape", id);
}

// ==================== Profiles ====================

function takeSnapshot(): UIPreferencesSnapshot {
  const p = preferences();
  return {
    viewModes: { ...p.viewModes },
    visibility: { ...p.visibility },
    layout: { ...p.layout },
    activeTheme: p.activeTheme,
    activeAccent: p.activeAccent,
    activeShape: p.activeShape,
    customThemes: { ...p.customThemes },
    customAccents: { ...p.customAccents },
    sectionOrder: [...p.sectionOrder],
  };
}

function applySnapshot(snap: UIPreferencesSnapshot): void {
  update(prev => ({
    ...prev,
    viewModes: { ...snap.viewModes },
    visibility: { ...snap.visibility },
    layout: { ...snap.layout },
    activeTheme: snap.activeTheme ?? "dark",
    activeAccent: snap.activeAccent ?? "default",
    activeShape: snap.activeShape ?? "default",
    customThemes: { ...snap.customThemes },
    customAccents: { ...(snap.customAccents ?? {}) },
    sectionOrder: [...snap.sectionOrder],
  }));
  applyTheme(snap.activeTheme ?? "dark");
  applyAccent(snap.activeAccent ?? "default");
  applyShape(snap.activeShape ?? "default");
  applyLayout();
}

export function getProfiles(): Record<string, UIProfile> {
  return preferences().profiles;
}

export function getActiveProfile(): string {
  return preferences().activeProfile;
}

export function saveProfile(id: string, name: string, icon: string): void {
  update(prev => ({
    ...prev,
    activeProfile: id,
    profiles: {
      ...prev.profiles,
      [id]: { name, icon, createdAt: Date.now(), snapshot: takeSnapshot() },
    },
  }));
}

export function loadProfile(id: string): void {
  const profile = preferences().profiles[id];
  if (!profile) return;
  applySnapshot(profile.snapshot);
  update(prev => ({ ...prev, activeProfile: id }));
}

export function deleteProfile(id: string): void {
  update(prev => {
    const { [id]: _, ...rest } = prev.profiles;
    return {
      ...prev,
      profiles: rest,
      activeProfile: prev.activeProfile === id ? "default" : prev.activeProfile,
    };
  });
}

// ==================== Export / Import ====================

export function exportPreferences(): string {
  return JSON.stringify(preferences(), null, 2);
}

export function importPreferences(json: string): boolean {
  try {
    const data = migratePreferences(JSON.parse(json));
    _setPreferences(data);
    saveToStorage(data);
    applyTheme(data.activeTheme);
    applyAccent(data.activeAccent);
    applyShape(data.activeShape);
    applyLayout();
    return true;
  } catch {
    return false;
  }
}

// ==================== Reset ====================

export function resetPreferences(): void {
  const defaults = createDefaults();
  _setPreferences(defaults);
  saveToStorage(defaults);
  applyTheme("dark");
  applyAccent("default");
  applyShape("default");
  applyLayout();
}

// ==================== Raw accessor (for Settings UI) ====================

export { preferences };

// ==================== Init ====================

// Применяем тему, акцент, форму и layout при загрузке модуля
const _initData = loadFromStorage();
applyTheme(_initData.activeTheme);
applyAccent(_initData.activeAccent);
applyShape(_initData.activeShape);
applyLayout();
