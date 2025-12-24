/**
 * Close Protection Store
 *
 * Глобальный стейт для защиты от случайного закрытия приложения
 * когда есть активные операции (работающие серверы, загрузки и т.п.)
 */

import { createSignal, createMemo } from "solid-js";
import type { Instance } from "../types";

// Глобальные сигналы
const [instances, setInstances] = createSignal<Instance[]>([]);
const [activeDownloadsCount, setActiveDownloadsCount] = createSignal(0);
const [hasUnsavedData, setHasUnsavedData] = createSignal(false);
const [unsavedDataSource, setUnsavedDataSource] = createSignal<string | null>(null);

/**
 * Обновить список инстансов для отслеживания
 */
export function updateInstances(newInstances: Instance[]) {
  setInstances(newInstances);
}

/**
 * Обновить количество активных загрузок
 */
export function updateActiveDownloads(count: number) {
  setActiveDownloadsCount(count);
}

/**
 * Установить флаг несохранённых данных
 */
export function markUnsavedData(source: string | null) {
  setHasUnsavedData(!!source);
  setUnsavedDataSource(source);
}

/**
 * Получить работающие серверы
 */
export const runningServers = createMemo(() =>
  instances().filter(i =>
    i.instance_type === "server" &&
    (i.status === "running" || i.status === "starting" || i.status === "stopping")
  )
);

/**
 * Есть ли работающие серверы
 */
export const hasRunningServers = createMemo(() => runningServers().length > 0);

/**
 * Есть ли активные загрузки
 */
export const hasActiveDownloads = createMemo(() => activeDownloadsCount() > 0);

/**
 * Есть ли что-то что мешает закрытию
 */
export const hasBlockingOperations = createMemo(() =>
  hasRunningServers() || hasActiveDownloads() || hasUnsavedData()
);

/**
 * Получить причины блокировки закрытия
 */
export function getCloseBlockReasons(): { title: string; message: string; variant: "danger" | "warning" } | null {
  const servers = runningServers();
  const downloads = activeDownloadsCount();
  const unsaved = hasUnsavedData();

  if (servers.length > 0) {
    const serverNames = servers.map(s => s.name).join(", ");
    return {
      title: "Есть работающие серверы",
      message: `Следующие серверы всё ещё запущены:\n${serverNames}\n\nПри закрытии приложения серверы будут принудительно остановлены. Игроки потеряют соединение.`,
      variant: "danger"
    };
  }

  if (downloads > 0) {
    return {
      title: "Идёт загрузка",
      message: `Сейчас выполняется ${downloads} ${downloads === 1 ? "загрузка" : "загрузок"}.\n\nПри закрытии приложения загрузки будут прерваны.`,
      variant: "warning"
    };
  }

  if (unsaved) {
    return {
      title: "Есть несохранённые данные",
      message: unsavedDataSource()
        ? `Несохранённые изменения в: ${unsavedDataSource()}`
        : "У вас есть несохранённые изменения.",
      variant: "warning"
    };
  }

  return null;
}

/**
 * Экспорт для использования в компонентах
 */
export function useCloseProtection() {
  return {
    instances,
    runningServers,
    hasRunningServers,
    hasActiveDownloads,
    hasBlockingOperations,
    getCloseBlockReasons,
    updateInstances,
    updateActiveDownloads,
    markUnsavedData,
  };
}
