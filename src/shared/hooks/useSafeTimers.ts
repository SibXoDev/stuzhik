import { onCleanup } from "solid-js";

/**
 * Хук для безопасного использования setTimeout с автоматической очисткой при unmount.
 * Предотвращает утечки памяти и вызовы setState на unmounted компонентах.
 *
 * @example
 * const { setTimeout: safeTimeout, clearAllTimeouts } = useSafeTimers();
 * safeTimeout(() => setLoading(false), 3000);
 */
export function useSafeTimers() {
  const activeTimers = new Set<ReturnType<typeof globalThis.setTimeout>>();
  const activeIntervals = new Set<ReturnType<typeof globalThis.setInterval>>();

  /**
   * Безопасный setTimeout с автоматической очисткой
   */
  const safeTimeout = (callback: () => void, delay: number) => {
    const id = globalThis.setTimeout(() => {
      activeTimers.delete(id);
      callback();
    }, delay);
    activeTimers.add(id);
    return id;
  };

  /**
   * Безопасный setInterval с автоматической очисткой
   */
  const safeInterval = (callback: () => void, delay: number) => {
    const id = globalThis.setInterval(callback, delay);
    activeIntervals.add(id);
    return id;
  };

  /**
   * Очистить конкретный таймер
   */
  const clearSafeTimeout = (id: ReturnType<typeof globalThis.setTimeout>) => {
    activeTimers.delete(id);
    globalThis.clearTimeout(id);
  };

  /**
   * Очистить конкретный интервал
   */
  const clearSafeInterval = (id: ReturnType<typeof globalThis.setInterval>) => {
    activeIntervals.delete(id);
    globalThis.clearInterval(id);
  };

  /**
   * Очистить все таймеры
   */
  const clearAllTimeouts = () => {
    for (const id of activeTimers) {
      globalThis.clearTimeout(id);
    }
    activeTimers.clear();
  };

  /**
   * Очистить все интервалы
   */
  const clearAllIntervals = () => {
    for (const id of activeIntervals) {
      globalThis.clearInterval(id);
    }
    activeIntervals.clear();
  };

  // Автоматическая очистка при unmount компонента
  onCleanup(() => {
    clearAllTimeouts();
    clearAllIntervals();
  });

  return {
    setTimeout: safeTimeout,
    setInterval: safeInterval,
    clearTimeout: clearSafeTimeout,
    clearInterval: clearSafeInterval,
    clearAllTimeouts,
    clearAllIntervals,
  };
}

/**
 * Хук для дебаунса с автоматической очисткой.
 * Идеально для поисковых полей.
 *
 * @example
 * const [debouncedValue, setDebounced] = createSignal("");
 * const debounce = useDebounce();
 *
 * const handleInput = (value: string) => {
 *   debounce(() => setDebounced(value), 300);
 * };
 */
export function useDebounce() {
  let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;

  const debounce = (callback: () => void, delay: number) => {
    if (timeoutId !== null) {
      globalThis.clearTimeout(timeoutId);
    }
    timeoutId = globalThis.setTimeout(() => {
      timeoutId = null;
      callback();
    }, delay);
  };

  const cancel = () => {
    if (timeoutId !== null) {
      globalThis.clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  onCleanup(cancel);

  return { debounce, cancel };
}
