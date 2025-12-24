import { createSignal, createContext, useContext, JSX } from 'solid-js';

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
 * Supported languages - automatically detected from locales/ directory!
 * Just add a new JSON file to locales/ and it will be auto-registered.
 */
export type Language = keyof typeof translationsMap extends never
  ? 'ru'  // Fallback if no files found (shouldn't happen)
  : keyof typeof translationsMap & string;

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
 * Get language display name
 */
export function getLanguageName(lang: Language): string {
  // Check if JSON has custom display name
  const meta = translationsMap[lang]?._meta as any;
  if (meta?.displayName) {
    return meta.displayName;
  }

  // Fallback to predefined names or lang code
  return languageNames[lang] || lang.toUpperCase();
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
 * I18n Context value
 */
interface I18nContextValue {
  language: () => Language;
  setLanguage: (lang: Language) => void;
  t: () => Translations;  // Function for reactivity!
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
  const [language, setLanguage] = createSignal<Language>(
    props.initialLanguage && availableLanguages.includes(props.initialLanguage)
      ? props.initialLanguage
      : (availableLanguages[0] || 'ru')
  );

  // Reactive translations - returns a function for SolidJS reactivity
  const getTranslations = () => translations[language()];

  const value: I18nContextValue = {
    language,
    setLanguage,
    t: getTranslations,  // Pass as function for reactivity
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
