import { createSignal, createMemo, Accessor, Setter } from "solid-js";

/**
 * Filter configuration for a single field
 */
export interface FilterConfig<T, V extends string> {
  /** Key to access the field on the item */
  key: keyof T | ((item: T) => unknown);
  /** Default value for this filter */
  defaultValue: V;
  /** How to match the filter value against the item field */
  match: FilterMatcher<T, V>;
}

/**
 * Filter matcher function type
 */
export type FilterMatcher<T, V extends string> =
  | "exact"           // Exact string match (lowercased)
  | "boolean"         // "all" | "yes"/"true" | "no"/"false"
  | "tristate"        // "all" | "enabled" | "disabled" (maps to boolean field)
  | ((item: T, filterValue: V) => boolean);  // Custom matcher

/**
 * Result of useListFilters hook
 */
export interface UseListFiltersResult<T, F extends Record<string, string>> {
  /** Current filter values */
  filters: { [K in keyof F]: Accessor<F[K]> };
  /** Setters for filter values */
  setFilters: { [K in keyof F]: Setter<F[K]> };
  /** Apply filters to a list and return filtered items */
  applyFilters: (items: T[]) => T[];
  /** Check if any filter is active (not default) */
  hasActiveFilters: Accessor<boolean>;
  /** Reset all filters to default values */
  resetFilters: () => void;
  /** Get count of items matching each filter option */
  getFilterCounts: <K extends keyof F>(
    items: T[],
    filterKey: K,
    options: F[K][]
  ) => Record<F[K], number>;
}

/**
 * Generic hook for filtering lists with multiple filter criteria
 *
 * @example
 * const { filters, setFilters, applyFilters, hasActiveFilters } = useListFilters<Mod, {
 *   enabled: "all" | "enabled" | "disabled";
 *   source: "all" | "modrinth" | "curseforge" | "local";
 * }>({
 *   enabled: {
 *     key: "enabled",
 *     defaultValue: "all",
 *     match: "tristate",
 *   },
 *   source: {
 *     key: (mod) => mod.source.toLowerCase(),
 *     defaultValue: "all",
 *     match: "exact",
 *   },
 * });
 *
 * const filteredMods = createMemo(() => applyFilters(mods()));
 */
export function useListFilters<
  T,
  F extends Record<string, string>
>(
  config: { [K in keyof F]: FilterConfig<T, F[K]> }
): UseListFiltersResult<T, F> {
  // Create signals for each filter
  const filterSignals = {} as { [K in keyof F]: ReturnType<typeof createSignal<F[K]>> };
  const filters = {} as { [K in keyof F]: Accessor<F[K]> };
  const setFilters = {} as { [K in keyof F]: Setter<F[K]> };

  for (const key of Object.keys(config) as (keyof F)[]) {
    const [value, setValue] = createSignal<F[typeof key]>(config[key].defaultValue);
    filterSignals[key] = [value, setValue] as ReturnType<typeof createSignal<F[typeof key]>>;
    filters[key] = value;
    setFilters[key] = setValue;
  }

  // Get field value from item
  const getFieldValue = <K extends keyof F>(item: T, filterKey: K): unknown => {
    const keyConfig = config[filterKey].key;
    if (typeof keyConfig === "function") {
      return keyConfig(item);
    }
    return item[keyConfig as keyof T];
  };

  // Check if item matches a specific filter
  const matchesFilter = <K extends keyof F>(item: T, filterKey: K, filterValue: F[K]): boolean => {
    const { match, defaultValue } = config[filterKey];

    // "all" or default value means no filtering
    if (filterValue === "all" || filterValue === defaultValue) {
      return true;
    }

    const fieldValue = getFieldValue(item, filterKey);

    // Custom matcher function
    if (typeof match === "function") {
      return match(item, filterValue);
    }

    // Built-in matchers
    switch (match) {
      case "exact":
        return String(fieldValue).toLowerCase() === filterValue.toLowerCase();

      case "boolean":
        const boolValue = Boolean(fieldValue);
        if (filterValue === "yes" || filterValue === "true") return boolValue;
        if (filterValue === "no" || filterValue === "false") return !boolValue;
        return true;

      case "tristate":
        const tristateValue = Boolean(fieldValue);
        if (filterValue === "enabled") return tristateValue;
        if (filterValue === "disabled") return !tristateValue;
        return true;

      default:
        return true;
    }
  };

  // Apply all filters to a list
  const applyFilters = (items: T[]): T[] => {
    let result = items;

    for (const key of Object.keys(config) as (keyof F)[]) {
      const filterValue = filters[key]();
      if (filterValue !== "all" && filterValue !== config[key].defaultValue) {
        result = result.filter(item => matchesFilter(item, key, filterValue));
      }
    }

    return result;
  };

  // Check if any filter is active
  const hasActiveFilters = createMemo(() => {
    for (const key of Object.keys(config) as (keyof F)[]) {
      const value = filters[key]();
      if (value !== "all" && value !== config[key].defaultValue) {
        return true;
      }
    }
    return false;
  });

  // Reset all filters
  const resetFilters = () => {
    for (const key of Object.keys(config) as (keyof F)[]) {
      // Type assertion needed because SolidJS setter types don't work well with generics
      (setFilters[key] as (v: F[typeof key]) => void)(config[key].defaultValue);
    }
  };

  // Get count of items matching each filter option
  const getFilterCounts = <K extends keyof F>(
    items: T[],
    filterKey: K,
    options: F[K][]
  ): Record<F[K], number> => {
    const counts = {} as Record<F[K], number>;

    for (const option of options) {
      if (option === "all" || option === config[filterKey].defaultValue) {
        counts[option] = items.length;
      } else {
        counts[option] = items.filter(item => matchesFilter(item, filterKey, option)).length;
      }
    }

    return counts;
  };

  return {
    filters,
    setFilters,
    applyFilters,
    hasActiveFilters,
    resetFilters,
    getFilterCounts,
  };
}

/**
 * Convenience function to create a search filter that works with useListFilters
 * Returns a custom matcher that searches multiple fields
 */
export function createSearchMatcher<T>(
  fields: (keyof T | ((item: T) => string))[]
): (item: T, searchQuery: string) => boolean {
  return (item: T, searchQuery: string): boolean => {
    if (!searchQuery) return true;

    const query = searchQuery.toLowerCase();

    for (const field of fields) {
      const value = typeof field === "function"
        ? field(item)
        : String(item[field] ?? "");

      if (value.toLowerCase().includes(query)) {
        return true;
      }
    }

    return false;
  };
}
