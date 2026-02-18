import { createSignal, createEffect, onMount, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import type { Instance, CreateInstanceRequest } from "../../../shared/types";
import { extractErrorMessage } from "../../../shared/utils/errors";
import { updateInstances } from "../../../shared/stores";

// Типы событий экземпляров
type InstanceStatusEvent = { id: string; status: string };
type InstanceEvent = { id: string; name?: string };
type InstanceErrorEvent = { id: string; error: string };

export function useInstances() {
  const [instances, setInstances] = createSignal<Instance[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [operatingInstances, setOperatingInstances] = createSignal<Set<string>>(new Set());

  // Синхронизируем инстансы со store для защиты от закрытия
  createEffect(() => {
    updateInstances(instances());
  });

  // Helpers для обновления состояния
  const updateInstanceStatus = (id: string, status: string) => {
    setInstances(prev =>
      prev.filter(inst => inst != null).map(inst =>
        inst.id === id ? { ...inst, status: status as Instance["status"] } : inst
      )
    );
  };

  const clearOperating = (id: string) => {
    setOperatingInstances(prev => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const addToOperating = (id: string) => {
    setOperatingInstances(prev => new Set(prev).add(id));
  };

  async function load() {
    try {
      setLoading(true);
      setError(null);
      const items = await invoke<Instance[]>("list_instances");
      // Filter out any null items from backend
      setInstances(items.filter(i => i != null));
    } catch (e: unknown) {
      setError(extractErrorMessage(e));
      if (import.meta.env.DEV) console.error("Failed to load instances:", e);
    } finally {
      setLoading(false);
    }
  }

  async function createInstance(request: CreateInstanceRequest): Promise<Instance | null> {
    try {
      setLoading(true);
      setError(null);
      const instance = await invoke<Instance>("create_instance", { req: request });
      setInstances(prev => [instance, ...prev]);
      return instance;
    } catch (e: unknown) {
      setError(extractErrorMessage(e));
      if (import.meta.env.DEV) console.error("Failed to create instance:", e);
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function startInstance(id: string) {
    if (operatingInstances().has(id)) {
      if (import.meta.env.DEV) console.log("Instance is already being started:", id);
      return;
    }

    // Check current status - don't start if already running/starting/stopping
    const instance = instances().find(i => i.id === id);
    if (instance && ["running", "starting", "stopping"].includes(instance.status)) {
      if (import.meta.env.DEV) console.log(`Cannot start instance ${id} - current status: ${instance.status}`);
      return;
    }

    try {
      setError(null);
      addToOperating(id);
      updateInstanceStatus(id, "starting");

      // Create launch snapshot before starting (for tracking changes)
      try {
        await invoke("save_launch_snapshot", { instanceId: id });
      } catch {
        // Non-critical - continue even if snapshot fails
      }

      await invoke("start_instance", { id });
      // Backend emits event, but as fallback fetch actual status
      // This ensures status is synced even if event is missed
      try {
        const instance = await invoke<Instance>("get_instance", { id });
        if (instance && instance.status) {
          updateInstanceStatus(id, instance.status);
          if (["running", "stopped", "error"].includes(instance.status)) {
            clearOperating(id);
          }
        }
      } catch {
        // Fallback failed, rely on event
      }
    } catch (e: unknown) {
      setError(extractErrorMessage(e));
      if (import.meta.env.DEV) console.error("Failed to start instance:", e);
      updateInstanceStatus(id, "stopped");
      clearOperating(id);
    }
  }

  async function stopInstance(id: string) {
    if (operatingInstances().has(id)) {
      if (import.meta.env.DEV) console.log("Instance is already being stopped:", id);
      return;
    }

    // Get instance info BEFORE updating status
    const instance = instances().find(i => i.id === id);
    const wasRunning = instance?.status === "running";
    const isServer = instance?.instance_type === "server";

    try {
      setError(null);
      addToOperating(id);
      updateInstanceStatus(id, "stopping");

      // For servers that were fully running, use graceful stop
      if (isServer && wasRunning) {
        // Try graceful stop first (sends "stop" command)
        // If server was still "starting", stdin/RCON not ready - skip to force stop
        try {
          await invoke("graceful_stop_server", { id });
          // Graceful stop initiated, wait for process to exit
          // The monitor thread will update status when done
          return;
        } catch (e) {
          if (import.meta.env.DEV) console.warn("Graceful stop failed, falling back to force stop:", e);
          // Fall through to force stop
        }
      }

      // For clients, starting servers, or if graceful stop failed - force stop
      await invoke("stop_instance", { id });
    } catch (e: unknown) {
      setError(extractErrorMessage(e));
      if (import.meta.env.DEV) console.error("Failed to stop instance:", e);
      updateInstanceStatus(id, "running");
      clearOperating(id);
    }
  }

  async function deleteInstance(id: string) {
    if (operatingInstances().has(id)) return;

    try {
      setError(null);
      addToOperating(id);
      await invoke("delete_instance", { id });
      setInstances(prev => prev.filter(inst => inst.id !== id));
    } catch (e: unknown) {
      setError(extractErrorMessage(e));
      if (import.meta.env.DEV) console.error("Failed to delete instance:", e);
    } finally {
      clearOperating(id);
    }
  }

  async function reinstallInstance(id: string) {
    if (operatingInstances().has(id)) return;

    try {
      setError(null);
      addToOperating(id);
      await invoke("reinstall_instance", { id });
      updateInstanceStatus(id, "installing");
    } catch (e: unknown) {
      setError(extractErrorMessage(e));
      if (import.meta.env.DEV) console.error("Failed to reinstall instance:", e);
    } finally {
      clearOperating(id);
    }
  }

  async function repairInstance(id: string) {
    if (operatingInstances().has(id)) return;

    try {
      setError(null);
      addToOperating(id);
      await invoke("repair_instance", { id });
      updateInstanceStatus(id, "installing");
    } catch (e: unknown) {
      setError(extractErrorMessage(e));
      if (import.meta.env.DEV) console.error("Failed to repair instance:", e);
    } finally {
      clearOperating(id);
    }
  }

  async function updateInstance(id: string, updates: Partial<Instance>) {
    try {
      setError(null);
      const updated = await invoke<Instance>("update_instance", { id, updates });
      setInstances(prev =>
        prev.map(inst => (inst.id === id ? updated : inst))
      );
    } catch (e: unknown) {
      setError(extractErrorMessage(e));
      if (import.meta.env.DEV) console.error("Failed to update instance:", e);
    }
  }

  // Загружает или добавляет экземпляр в список
  const ensureInstanceInList = async (id: string, status: Instance["status"]) => {
    const exists = instances().filter(inst => inst != null).some(inst => inst.id === id);
    if (!exists) {
      try {
        const newInstance = await invoke<Instance>("get_instance", { id });
        if (newInstance) {
          setInstances(prev => [{ ...newInstance, status }, ...prev.filter(i => i != null)]);
        }
      } catch (e) {
        if (import.meta.env.DEV) console.error("Failed to fetch instance:", e);
        load(); // Fallback - reload all
      }
    } else {
      updateInstanceStatus(id, status);
    }
  };

  onMount(() => {
    load();

    // Массив для хранения отписок.
    // Resolved listeners stored directly for safe cleanup.
    const resolvedUnlisteners: UnlistenFn[] = [];
    let isCleanedUp = false;
    const unlisteners: Promise<UnlistenFn>[] = [];

    // Обработчик изменения статуса
    unlisteners.push(
      listen<InstanceStatusEvent>("instance-status-changed", (event) => {
        const { id, status } = event.payload;
        updateInstanceStatus(id, status);

        // Убираем из операций на финальных статусах
        if (["running", "stopped", "error", "crashed", "restarting"].includes(status)) {
          clearOperating(id);
        }
      })
    );

    // Failsafe: периодически очищаем operatingInstances для экземпляров в финальных статусах
    const cleanupInterval = setInterval(() => {
      const ops = operatingInstances();
      if (ops.size > 0) {
        const insts = instances();
        ops.forEach(id => {
          const inst = insts.find(i => i.id === id);
          if (inst && ["running", "stopped", "error", "crashed", "restarting"].includes(inst.status)) {
            if (import.meta.env.DEV) console.log("Failsafe: clearing stuck operatingInstance:", id);
            clearOperating(id);
          }
        });
      }
    }, 2000);

    // Начало установки - показываем сразу в списке
    unlisteners.push(
      listen<InstanceEvent>("instance-installing", async (event) => {
        const { id, name } = event.payload;
        if (import.meta.env.DEV) console.log("Instance installing event:", id, name);
        await ensureInstanceInList(id, "installing");
      })
    );

    // НОВОЕ: Реактивное обновление прогресса установки
    // Обновляем статус экземпляра на основе текущего шага установки
    unlisteners.push(
      listen<{id: string; step: string; message: string}>("instance-install-progress", (event) => {
        const { id, step } = event.payload;
        // Убеждаемся что экземпляр есть в списке и имеет статус "installing"
        const instance = instances().find(inst => inst.id === id);
        if (instance && instance.status === "installing") {
          // Статус остаётся "installing", но мы знаем что процесс идёт
          // UI компоненты могут отображать текущий шаг через InstallProgressModal
          if (import.meta.env.DEV) console.log(`Installation progress for ${id}: ${step}`);
        }
      })
    );

    // Экземпляр создан (установка завершена)
    unlisteners.push(
      listen<InstanceEvent>("instance-created", async (event) => {
        const { id } = event.payload;
        await ensureInstanceInList(id, "stopped");
        clearOperating(id);
      })
    );

    // Консолидированный обработчик для события "переустановка/repair завершена"
    const completionEvents = [
      "instance-reinstalled",
      "instance-repaired",
    ];

    for (const eventName of completionEvents) {
      unlisteners.push(
        listen<InstanceEvent>(eventName, (event) => {
          const { id } = event.payload;
          updateInstanceStatus(id, "stopped");
          clearOperating(id);
        })
      );
    }

    // Консолидированный обработчик для события "начало операции"
    const startingEvents = [
      "instance-reinstalling",
      "instance-repairing",
    ];

    for (const eventName of startingEvents) {
      unlisteners.push(
        listen<InstanceStatusEvent>(eventName, (event) => {
          const { id } = event.payload;
          updateInstanceStatus(id, "installing");
        })
      );
    }

    // Консолидированный обработчик для ошибок
    const errorEvents = [
      "instance-creation-failed",
      "instance-reinstall-failed",
      "instance-repair-failed",
    ];

    for (const eventName of errorEvents) {
      unlisteners.push(
        listen<InstanceErrorEvent>(eventName, (event) => {
          const { id } = event.payload;
          updateInstanceStatus(id, "error");
          clearOperating(id);
        })
      );
    }

    // Экземпляр удалён (отмена установки модпака / cleanup).
    // Немедленно убираем из списка — экземпляр уже удалён из БД на backend.
    unlisteners.push(
      listen<{ id: string }>("instance-removed", (event) => {
        const { id } = event.payload;
        if (import.meta.env.DEV) console.log("Instance removed (cancelled):", id);
        setInstances(prev => prev.filter(inst => inst.id !== id));
        clearOperating(id);
      })
    );

    // Auto-restart сервера при краше (если включено)
    unlisteners.push(
      listen<{ instance_id: string }>("server-restart-now", async (event) => {
        const { instance_id } = event.payload;
        if (import.meta.env.DEV) console.log("Auto-restarting server:", instance_id);

        // Сначала обновим статус на "stopped" чтобы startInstance сработал
        updateInstanceStatus(instance_id, "stopped");
        clearOperating(instance_id);

        // Небольшая задержка для стабильности
        await new Promise(resolve => setTimeout(resolve, 500));

        // Guard against stale operations after unmount
        if (isCleanedUp) return;

        // Re-check instance status after delay — user may have manually started/deleted
        const currentInstance = instances().find(i => i.id === instance_id);
        if (!currentInstance || currentInstance.status !== "stopped") {
          if (import.meta.env.DEV) console.log(`Auto-restart skipped for ${instance_id}: status is ${currentInstance?.status ?? "deleted"}`);
          return;
        }

        // Запускаем заново
        try {
          // Create snapshot before restart
          try {
            await invoke("save_launch_snapshot", { instanceId: instance_id });
          } catch {
            // Non-critical
          }
          if (isCleanedUp) return;
          await invoke("start_instance", { id: instance_id });
        } catch (e) {
          if (import.meta.env.DEV) console.error("Auto-restart failed:", e);
          if (!isCleanedUp) updateInstanceStatus(instance_id, "crashed");
        }
      })
    );

    // Track all listener promises to handle cleanup race
    for (const promise of unlisteners) {
      promise.then(fn => {
        if (isCleanedUp) {
          fn(); // Already cleaned up — unlisten immediately
        } else {
          resolvedUnlisteners.push(fn);
        }
      }).catch(() => {});
    }

    // Очистка при размонтировании
    onCleanup(() => {
      isCleanedUp = true;
      clearInterval(cleanupInterval);
      // Unlisten all resolved listeners
      for (const fn of resolvedUnlisteners) {
        fn();
      }
    });
  });

  return {
    instances,
    loading,
    error,
    operatingInstances,
    load,
    createInstance,
    startInstance,
    stopInstance,
    deleteInstance,
    reinstallInstance,
    repairInstance,
    updateInstance,
  };
}
