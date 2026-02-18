import { createSignal, createContext, useContext, JSX } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';

// Auto-import all translation files from locales/ directory
// Vite will bundle these at compile time - zero runtime overhead!
const translationModules = import.meta.glob<{ default: Record<string, unknown> }>(
  '../../../locales/*.json',
  { eager: true }
);

/**
 * Extract language codes from file paths
 * Example: "../../../locales/ru.json" -> "ru"
 */
const extractLanguageCode = (path: string): string => {
  const match = path.match(/\/([^/]+)\.json$/);
  return match ? match[1] : '';
};

/**
 * Build translations map from imported modules
 */
const translationsMap: Record<string, Record<string, any>> = {};
for (const [path, module] of Object.entries(translationModules)) {
  const lang = extractLanguageCode(path);
  if (lang) {
    translationsMap[lang] = module.default;
  }
}

/**
 * Language code — any ISO 639-1 string.
 * Bundled languages (ru, en) have compile-time translations.
 * Custom languages use base (ru) translations + user overrides from disk.
 */
export type Language = string;

/**
 * All available languages - automatically populated!
 */
export const availableLanguages = Object.keys(translationsMap) as Language[];

/**
 * Language display names
 * You can override by adding "_meta": { "displayName": "..." } to JSON
 */
const languageNames: Record<string, string> = {
  ru: 'Русский',
  en: 'English',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
  pt: 'Português',
  it: 'Italiano',
  ja: '日本語',
  ko: '한국어',
  zh: '中文',
  uk: 'Українська',
  pl: 'Polski',
  // Add more as needed, or use ISO 639-1 codes
};

/**
 * Get language display name.
 * Checks: 1) bundled JSON _meta.displayName, 2) well-known names map, 3) uppercase code.
 * Optional `customName` overrides all (for user-created languages).
 */
export function getLanguageName(lang: Language, customName?: string): string {
  if (customName) return customName.slice(0, 50);

  // Check if JSON has custom display name
  const meta = translationsMap[lang]?._meta as any;
  if (meta?.displayName && typeof meta.displayName === 'string') {
    return meta.displayName.slice(0, 50);
  }

  // Fallback to predefined names or lang code
  return languageNames[lang] || lang.toUpperCase();
}

/**
 * Check if a language is bundled (has compile-time translations).
 */
export function isBundledLanguage(lang: string): boolean {
  return lang in translationsMap;
}

/**
 * Get a safe BCP 47 locale tag from a language code.
 * Custom languages (e.g. "test") may not be valid locale tags.
 * Falls back to "en" for invalid tags.
 */
export function getSafeLocale(lang: string): string {
  try {
    new Intl.DateTimeFormat(lang);
    return lang;
  } catch {
    return "en";
  }
}

/**
 * Deep readonly type helper
 */
type DeepReadonly<T> = {
  readonly [K in keyof T]: T[K] extends object ? DeepReadonly<T[K]> : T[K];
};

/**
 * Infer translation structure from ru.json (base language)
 * This gives us full type safety and autocomplete!
 *
 * Type is automatically derived from JSON structure:
 * - t.common.create ✅ (autocomplete works)
 * - t.common.foo ❌ (TypeScript error)
 */
export type Translations = DeepReadonly<typeof translationsMap['ru']>;

/**
 * All translations typed properly
 */
const translations: Record<Language, Translations> = translationsMap as any;

/**
 * Deep merge two objects. `override` values take precedence over `base`.
 * Only merges plain objects; primitive values and arrays are replaced entirely.
 */
function deepMerge(base: Record<string, any>, override: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = { ...base };
  for (const key of Object.keys(override)) {
    // Prevent prototype pollution; skip _meta (file metadata, not translations)
    if (key === '__proto__' || key === 'constructor' || key === 'prototype' || key === '_meta') continue;
    const baseVal = base[key];
    const overVal = override[key];
    if (
      overVal !== null &&
      typeof overVal === 'object' &&
      !Array.isArray(overVal) &&
      baseVal !== null &&
      typeof baseVal === 'object' &&
      !Array.isArray(baseVal)
    ) {
      result[key] = deepMerge(baseVal, overVal);
    } else {
      result[key] = overVal;
    }
  }
  return result;
}

/**
 * Get base (bundled) translations for a language
 */
export function getBaseTranslations(lang: Language): Record<string, any> {
  return translationsMap[lang] ?? translationsMap['ru'] ?? {};
}

/**
 * Flatten a nested translation object into dot-separated key-value pairs.
 * Example: { common: { save: "Save" } } → { "common.save": "Save" }
 */
export function flattenTranslations(obj: Record<string, any>, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    // Skip _meta — it's file metadata, not translation content
    if (key === '_meta' && !prefix) continue;
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(result, flattenTranslations(value, fullKey));
    } else if (typeof value === 'string') {
      result[fullKey] = value;
    }
  }
  return result;
}

/**
 * Unflatten dot-separated key-value pairs back into a nested object.
 * Example: { "common.save": "Save" } → { common: { save: "Save" } }
 */
export function unflattenTranslations(flat: Record<string, string>): Record<string, any> {
  const BLOCKED = new Set(['__proto__', 'constructor', 'prototype']);
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split('.');
    // Skip keys with dangerous segments
    if (parts.some(p => BLOCKED.has(p))) continue;
    let current = result;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!(parts[i] in current) || typeof current[parts[i]] !== 'object') {
        current[parts[i]] = {};
      }
      current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;
  }
  return result;
}

/**
 * I18n Context value
 */
interface I18nContextValue {
  language: () => Language;
  setLanguage: (lang: Language) => void;
  t: () => Translations;  // Function for reactivity!
  /** Custom translation overrides (flat key-value map for current language) */
  customOverrides: () => Record<string, string>;
  /** Set custom overrides and persist to disk */
  setCustomOverrides: (overrides: Record<string, string>) => Promise<void>;
  /** Load custom overrides from disk for current language */
  loadCustomOverrides: () => Promise<void>;
  /** Clear all custom overrides for current language */
  clearCustomOverrides: () => Promise<void>;
  /** Whether custom overrides are loaded */
  customOverridesLoaded: () => boolean;
}

// Create context with proper default
const I18nContext = createContext<I18nContextValue>();

/**
 * I18n Provider component
 *
 * Wrap your app with this to enable internationalization:
 * ```tsx
 * <I18nProvider initialLanguage="ru">
 *   <App />
 * </I18nProvider>
 * ```
 */
export function I18nProvider(props: { initialLanguage?: Language; children?: JSX.Element }) {
  const [language, setLanguageSignal] = createSignal<Language>(
    props.initialLanguage || availableLanguages[0] || 'ru'
  );

  // Custom overrides stored as nested object (same shape as base translations)
  const [customOverridesNested, setCustomOverridesNested] = createSignal<Record<string, any>>({});
  const [customOverridesLoaded, setCustomOverridesLoaded] = createSignal(false);

  // Reactive translations with custom overrides merged in.
  // For custom languages (no bundled JSON), falls back to 'ru' as base.
  const getTranslations = (): Translations => {
    const lang = language();
    const base = translations[lang] ?? translations['ru'];
    const overrides = customOverridesNested();
    if (!overrides || Object.keys(overrides).length === 0) {
      return base;
    }
    return deepMerge(base as Record<string, any>, overrides) as unknown as Translations;
  };

  // Flat overrides for the editor UI
  const getCustomOverridesFlat = (): Record<string, string> => {
    const nested = customOverridesNested();
    if (!nested || Object.keys(nested).length === 0) return {};
    return flattenTranslations(nested);
  };

  // Load overrides from backend
  const loadCustomOverrides = async () => {
    try {
      const lang = language();
      const data = await invoke<Record<string, any> | null>('get_custom_translations', { lang });
      if (data) {
        setCustomOverridesNested(data);
      } else {
        setCustomOverridesNested({});
      }
      setCustomOverridesLoaded(true);
    } catch (e) {
      if (import.meta.env.DEV) console.error('[i18n] Failed to load custom translations:', e);
      setCustomOverridesNested({});
      setCustomOverridesLoaded(true);
    }
  };

  // Save overrides to backend (accepts flat key-value map)
  const setCustomOverrides = async (flatOverrides: Record<string, string>) => {
    const lang = language();
    const nested = unflattenTranslations(flatOverrides);
    try {
      if (Object.keys(flatOverrides).length === 0) {
        await invoke('delete_custom_translations', { lang });
        setCustomOverridesNested({});
      } else {
        await invoke('save_custom_translations', { lang, data: nested });
        setCustomOverridesNested(nested);
      }
    } catch (e) {
      if (import.meta.env.DEV) console.error('[i18n] Failed to save custom translations:', e);
      throw e;
    }
  };

  // Clear all custom overrides
  const clearCustomOverrides = async () => {
    const lang = language();
    try {
      await invoke('delete_custom_translations', { lang });
      setCustomOverridesNested({});
    } catch (e) {
      if (import.meta.env.DEV) console.error('[i18n] Failed to clear custom translations:', e);
      throw e;
    }
  };

  // Wrapper for setLanguage that also loads custom overrides for new language
  const setLanguage = (lang: Language) => {
    setLanguageSignal(lang);
    // Load overrides for the new language
    loadCustomOverrides();
  };

  // Load custom overrides on mount
  loadCustomOverrides();

  const value: I18nContextValue = {
    language,
    setLanguage,
    t: getTranslations,
    customOverrides: getCustomOverridesFlat,
    setCustomOverrides,
    loadCustomOverrides,
    clearCustomOverrides,
    customOverridesLoaded,
  };

  return (
    <I18nContext.Provider value={value}>
      {props.children}
    </I18nContext.Provider>
  );
}

/**
 * Use i18n hook
 *
 * Access translations and language state:
 * ```tsx
 * const { t, language, setLanguage } = useI18n();
 *
 * return <h1>{t.instances.title}</h1>;
 * ```
 *
 * Full type safety with autocomplete!
 */
export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error('useI18n must be used within I18nProvider');
  }
  return context;
}
