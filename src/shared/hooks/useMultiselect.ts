import { createSignal, createMemo } from "solid-js";

/**
 * Hook for managing multiselect state
 * @template T - Type of items being selected (must have an id field)
 */
export function useMultiselect<T extends { id: number | string }>() {
  const [selectedIds, setSelectedIds] = createSignal<Set<number | string>>(new Set());

  const toggleSelect = (id: number | string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const selectAll = (items: T[]) => {
    setSelectedIds(new Set(items.map((item) => item.id)));
  };

  const deselectAll = () => {
    setSelectedIds(new Set<number | string>());
  };

  const isSelected = (id: number | string) => {
    return selectedIds().has(id);
  };

  const selectedCount = createMemo(() => selectedIds().size);

  const getSelectedItems = (items: T[]) => {
    const ids = selectedIds();
    return items.filter((item) => ids.has(item.id));
  };

  const allSelected = (items: T[]) => {
    if (items.length === 0) return false;
    return items.every((item) => selectedIds().has(item.id));
  };

  const someSelected = (items: T[]) => {
    return items.some((item) => selectedIds().has(item.id));
  };

  return {
    selectedIds,
    selectedCount,
    toggleSelect,
    selectAll,
    deselectAll,
    isSelected,
    getSelectedItems,
    allSelected,
    someSelected,
  };
}
