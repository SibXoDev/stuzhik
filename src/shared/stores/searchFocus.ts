/**
 * Global search focus store.
 *
 * Allows components to register their search handlers so Ctrl+F
 * triggers custom search instead of browser's default find dialog.
 *
 * Usage:
 * 1. Component registers handler on mount:
 *    registerSearchHandler("mods", () => { setSearchFocused(true); });
 *
 * 2. Component unregisters on cleanup:
 *    unregisterSearchHandler("mods");
 *
 * 3. App.tsx calls triggerSearch() on Ctrl+F
 */

import { createSignal } from "solid-js";

type SearchHandler = () => void;

interface SearchHandlerEntry {
  id: string;
  handler: SearchHandler;
  priority: number; // Higher = called first
}

const [handlers, setHandlers] = createSignal<SearchHandlerEntry[]>([]);

/**
 * Register a search handler for a component.
 * @param id Unique identifier for the handler
 * @param handler Function to call when Ctrl+F is pressed
 * @param priority Higher priority handlers are called first (default: 0)
 */
export function registerSearchHandler(id: string, handler: SearchHandler, priority = 0): void {
  setHandlers(prev => {
    // Remove existing handler with same id
    const filtered = prev.filter(h => h.id !== id);
    // Add new handler and sort by priority (highest first)
    return [...filtered, { id, handler, priority }].sort((a, b) => b.priority - a.priority);
  });
}

/**
 * Unregister a search handler.
 * @param id Identifier of handler to remove
 */
export function unregisterSearchHandler(id: string): void {
  setHandlers(prev => prev.filter(h => h.id !== id));
}

/**
 * Trigger search - calls the highest priority registered handler.
 * @returns true if a handler was called, false if no handlers registered
 */
export function triggerSearch(): boolean {
  const current = handlers();
  if (current.length > 0) {
    // Call the highest priority handler
    current[0].handler();
    return true;
  }
  return false;
}

/**
 * Check if any search handlers are registered.
 */
export function hasSearchHandlers(): boolean {
  return handlers().length > 0;
}
