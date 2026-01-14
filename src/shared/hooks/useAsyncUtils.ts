import { createSignal, Setter, Accessor } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

/**
 * Extracts error message from unknown error type
 * Replaces repeated: e instanceof Error ? e.message : String(e)
 */
export function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/**
 * Creates standard loading/error state signals
 */
export function createAsyncState() {
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  return { loading, setLoading, error, setError };
}

/**
 * Async operation options
 */
interface AsyncOperationOptions<T> {
  setLoading?: Setter<boolean>;
  setError?: Setter<string | null>;
  logPrefix?: string;
  onSuccess?: (result: T) => void | Promise<void>;
}

/**
 * Wraps an async operation with loading/error handling
 * Replaces repeated try/catch/finally patterns
 *
 * @example
 * const result = await runAsync(
 *   () => invoke("my_command", { id }),
 *   { setLoading, setError, logPrefix: "[MyHook]" }
 * );
 */
export async function runAsync<T>(
  operation: () => Promise<T>,
  options: AsyncOperationOptions<T> = {}
): Promise<T | null> {
  const { setLoading, setError, logPrefix, onSuccess } = options;

  setLoading?.(true);
  setError?.(null);

  try {
    const result = await operation();
    if (onSuccess) {
      await onSuccess(result);
    }
    return result;
  } catch (e) {
    const msg = extractErrorMessage(e);
    setError?.(msg);
    if (import.meta.env.DEV && logPrefix) {
      console.error(`${logPrefix} Error:`, e);
    }
    return null;
  } finally {
    setLoading?.(false);
  }
}

/**
 * Runs async operation without affecting loading state
 * For operations that shouldn't show loading indicator
 */
export async function runAsyncSilent<T>(
  operation: () => Promise<T>,
  options: Omit<AsyncOperationOptions<T>, "setLoading"> = {}
): Promise<T | null> {
  return runAsync(operation, { ...options, setLoading: undefined });
}

/**
 * Creates a typed invoke wrapper with automatic error handling
 *
 * @example
 * const invokeTyped = createTypedInvoke<BackupRecord[]>();
 * const result = await invokeTyped("list_backups", { instanceId: id }, options);
 */
export function createTypedInvoke<T>() {
  return async (
    command: string,
    args: Record<string, unknown>,
    options: AsyncOperationOptions<T> = {}
  ): Promise<T | null> => {
    return runAsync(() => invoke<T>(command, args), options);
  };
}

// Collection update helpers

/**
 * Updates an item in a collection by ID
 */
export function updateItemById<T extends { id: string | number }>(
  setter: Setter<T[]>,
  id: string | number,
  updates: Partial<T>
): void {
  setter((prev) =>
    prev.map((item) =>
      item.id === id ? { ...item, ...updates } : item
    )
  );
}

/**
 * Removes an item from a collection by ID
 */
export function removeItemById<T extends { id: string | number }>(
  setter: Setter<T[]>,
  id: string | number
): void {
  setter((prev) => prev.filter((item) => item.id !== id));
}

/**
 * Adds an item to a collection (at the beginning or end)
 */
export function addItem<T>(
  setter: Setter<T[]>,
  item: T,
  position: "start" | "end" = "end"
): void {
  setter((prev) => position === "start" ? [item, ...prev] : [...prev, item]);
}

/**
 * Updates an item in a collection by a custom key
 */
export function updateItemByKey<T, K extends keyof T>(
  setter: Setter<T[]>,
  key: K,
  value: T[K],
  updates: Partial<T>
): void {
  setter((prev) =>
    prev.map((item) =>
      item[key] === value ? { ...item, ...updates } : item
    )
  );
}

/**
 * Toggles a boolean field on an item by ID
 */
export function toggleItemField<T extends { id: string | number }, K extends keyof T>(
  setter: Setter<T[]>,
  id: string | number,
  field: K
): void {
  setter((prev) =>
    prev.map((item) =>
      item.id === id ? { ...item, [field]: !item[field] } : item
    )
  );
}

/**
 * Hook factory for creating async operation handlers
 * Returns a function that can be used to create standardized async handlers
 *
 * @example
 * const { loading, error, createHandler } = useAsyncHandlers();
 * const loadData = createHandler(
 *   () => invoke("load_data"),
 *   (data) => setItems(data)
 * );
 */
export function useAsyncHandlers() {
  const { loading, setLoading, error, setError } = createAsyncState();

  function createHandler<T, Args extends unknown[]>(
    operation: (...args: Args) => Promise<T>,
    onSuccess?: (result: T) => void | Promise<void>,
    options?: { logPrefix?: string; withLoading?: boolean }
  ) {
    return async (...args: Args): Promise<T | null> => {
      return runAsync(
        () => operation(...args),
        {
          setLoading: options?.withLoading !== false ? setLoading : undefined,
          setError,
          logPrefix: options?.logPrefix,
          onSuccess,
        }
      );
    };
  }

  return { loading, error, setError, createHandler };
}

/**
 * Type guard for checking if instanceId is valid
 */
export function isValidInstanceId(id: string | undefined | null): id is string {
  return typeof id === "string" && id.length > 0;
}

/**
 * Accessor helper - safely gets value from accessor or undefined
 */
export function safeAccessor<T>(accessor: Accessor<T | undefined>): T | undefined {
  try {
    return accessor();
  } catch {
    return undefined;
  }
}
