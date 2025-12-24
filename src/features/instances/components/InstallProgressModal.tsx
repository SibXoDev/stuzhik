import { createSignal, Show, onCleanup, For } from "solid-js";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { ModalWrapper } from "../../../shared/ui/ModalWrapper";
import { useSafeTimers } from "../../../shared/hooks";

interface InstallProgress {
  id: string;
  step: "java" | "minecraft" | "loader" | "complete";
  message: string;
}

interface DownloadProgress {
  id: string;
  name: string;
  downloaded: number;
  total: number;
  speed: number;
  percentage: number;
  status: string;
}

interface Props {
  instanceId: string;
  instanceName: string;
  onComplete?: () => void;
  onError?: (error: string) => void;
  onCancel?: () => void;
}

function InstallProgressModal(props: Props) {
  const [currentStep, setCurrentStep] = createSignal<InstallProgress["step"]>("java");
  const [message, setMessage] = createSignal("Подготовка...");
  const [downloads, setDownloads] = createSignal<DownloadProgress[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [completed, setCompleted] = createSignal(false);
  const [operationId, setOperationId] = createSignal<string | null>(null);
  const [cancelling, setCancelling] = createSignal(false);

  // Use safe timers hook for automatic cleanup
  const { setTimeout: safeTimeout } = useSafeTimers();

  const steps = [
    { id: "java", label: "Java", icon: "i-hugeicons-source-code" },
    { id: "minecraft", label: "Minecraft", icon: "i-hugeicons-game-controller-03" },
    { id: "loader", label: "Загрузчик", icon: "i-hugeicons-cpu" },
    { id: "complete", label: "Готово", icon: "i-hugeicons-checkmark-circle-02" },
  ];

  const getStepIndex = (step: InstallProgress["step"]) => {
    return steps.findIndex(s => s.id === step);
  };

  // Слушаем события установки
  const unlistenProgress = listen<InstallProgress>("instance-install-progress", (event) => {
    const progress = event.payload;
    if (progress.id === props.instanceId) {
      setCurrentStep(progress.step);
      setMessage(progress.message);
    }
  });

  const unlistenCreated = listen<{id: string}>("instance-created", (event) => {
    if (event.payload.id === props.instanceId) {
      setCurrentStep("complete");
      setMessage("Установка завершена!");
      setCompleted(true);
      safeTimeout(() => {
        props.onComplete?.();
      }, 2000);
    }
  });

  const unlistenError = listen<{id: string, error: string}>("instance-creation-failed", (event) => {
    if (event.payload.id === props.instanceId) {
      setError(event.payload.error);
      props.onError?.(event.payload.error);
    }
  });

  // Слушаем прогресс загрузок
  const unlistenDownload = listen<DownloadProgress>("download-progress", (event) => {
    const progress = event.payload;

    setDownloads(prev => {
      const existing = prev.findIndex(p => p.id === progress.id);
      if (existing >= 0) {
        const updated = [...prev];
        updated[existing] = progress;

        // Удаляем завершённые через 1 секунду
        if (progress.status === "completed") {
          safeTimeout(() => {
            setDownloads(p => p.filter(item => item.id !== progress.id));
          }, 1000);
        }

        return updated;
      } else {
        return [...prev, progress];
      }
    });
  });

  // Слушаем начало операции для получения ID
  const unlistenOpStarted = listen<{ operation_id: string }>("instance-operation-started", (event) => {
    setOperationId(event.payload.operation_id);
  });

  // Слушаем отмену операции
  const unlistenOpCancelled = listen<{ id: string }>("operation-cancelled", (event) => {
    if (event.payload.id === operationId()) {
      setCancelling(false);
      setError("Установка отменена");
      props.onCancel?.();
    }
  });

  onCleanup(() => {
    // Unlisten all events (timers are cleaned up automatically by useSafeTimers)
    unlistenProgress.then(fn => fn());
    unlistenCreated.then(fn => fn());
    unlistenError.then(fn => fn());
    unlistenDownload.then(fn => fn());
    unlistenOpStarted.then(fn => fn());
    unlistenOpCancelled.then(fn => fn());
  });

  const handleCancel = async () => {
    const opId = operationId();
    if (!opId) {
      // Если нет operation ID, пробуем отменить по instance ID
      setCancelling(true);
      try {
        await invoke<boolean>("cancel_operation", { operationId: `instance-install-${props.instanceId}` });
      } catch (e) {
        console.error("Failed to cancel:", e);
        setCancelling(false);
      }
      return;
    }

    setCancelling(true);
    try {
      await invoke<boolean>("cancel_operation", { operationId: opId });
    } catch (e) {
      console.error("Failed to cancel:", e);
      setCancelling(false);
    }
  };

  return (
    <ModalWrapper maxWidth="max-w-3xl">
      <div class="p-6">
        {/* Header */}
        <div class="mb-6">
          <h2 class="text-2xl font-bold mb-1">
            {completed() ? "Установка завершена!" : "Установка экземпляра"}
          </h2>
          <p class="text-sm text-muted">{props.instanceName}</p>
        </div>

        {/* Error */}
        <Show when={error()}>
          <div class="card bg-red-600/10 border-red-600/30 mb-6">
            <div class="flex items-start gap-3">
              <i class="i-hugeicons-alert-02 text-red-400 w-5 h-5 flex-shrink-0" />
              <div class="flex-1">
                <h3 class="font-medium text-red-400 mb-1">Ошибка установки</h3>
                <p class="text-sm text-red-300">{error()}</p>
              </div>
            </div>
          </div>
        </Show>

        {/* Steps Progress */}
        <div class="mb-6">
          <div class="flex items-center justify-between mb-4">
            <For each={steps}>
              {(step, index) => {
                const currentIndex = getStepIndex(currentStep());
                const stepIndex = index();
                const isActive = stepIndex === currentIndex;
                const isCompleted = stepIndex < currentIndex;
                const isFuture = stepIndex > currentIndex;

                return (
                  <>
                    <div class="flex flex-col items-center gap-2 flex-1">
                      <div
                        class={`w-12 h-12 rounded-full flex items-center justify-center text-xl transition-all ${
                          isCompleted
                            ? "bg-green-600 text-white"
                            : isActive
                            ? "bg-blue-600 text-white animate-pulse"
                            : "bg-gray-700 text-gray-500"
                        }`}
                      >
                        <Show when={isCompleted} fallback={<i class={step.icon} />}>
                          <i class="i-hugeicons-checkmark-circle-02" />
                        </Show>
                      </div>
                      <span
                        class={`text-sm font-medium ${
                          isActive ? "text-white" : isFuture ? "text-gray-500" : "text-gray-400"
                        }`}
                      >
                        {step.label}
                      </span>
                    </div>

                    {/* Connector Line */}
                    <Show when={index() < steps.length - 1}>
                      <div class="flex-1 h-1 mx-2" style="max-width: 120px;">
                        <div class="absolute inset-0 bg-gray-700 rounded" />
                        <div
                          class={`absolute inset-0 rounded transition-all duration-100 ${
                            stepIndex < currentIndex ? "bg-green-600" : "bg-gray-700"
                          }`}
                          style={{
                            width: stepIndex < currentIndex ? "100%" : "0%",
                          }}
                        />
                      </div>
                    </Show>
                  </>
                );
              }}
            </For>
          </div>

          {/* Current Message */}
          <div class="text-center">
            <p class="text-sm text-muted">{message()}</p>
          </div>
        </div>

        {/* Downloads Progress */}
        <Show when={downloads().length > 0}>
          <div class="space-y-2 mb-4">
            <h3 class="text-sm font-medium text-gray-400 mb-2">Загрузки:</h3>
            <For each={downloads()}>
              {(download) => (
                <div class="bg-gray-800 rounded-2xl p-3">
                  <div class="flex items-center justify-between mb-2">
                    <span class="text-sm font-medium truncate flex-1">{download.name}</span>
                    <span class="text-xs text-muted">
                      {(download.speed / 1024 / 1024).toFixed(2)} MB/s
                    </span>
                  </div>
                  <div class="w-full bg-gray-700 rounded-full h-2">
                    <div
                      class="bg-blue-600 h-2 rounded-full transition-all"
                      style={{ width: `${download.percentage}%` }}
                    />
                  </div>
                  <div class="flex items-center justify-between mt-1">
                    <span class="text-xs text-muted">
                      {(download.downloaded / 1024 / 1024).toFixed(2)} /{" "}
                      {(download.total / 1024 / 1024).toFixed(2)} MB
                    </span>
                    <span class="text-xs text-muted">{download.percentage.toFixed(0)}%</span>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>

        {/* Cancel Button (during installation) */}
        <Show when={!completed() && !error()}>
          <Show when={cancelling()} fallback={
            <button
              class="btn-secondary w-full"
              onClick={handleCancel}
            >
              <i class="i-hugeicons-cancel-01 w-4 h-4" />
              Отменить установку
            </button>
          }>
            <button class="btn-secondary w-full" disabled>
              <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
              Отмена...
            </button>
          </Show>
        </Show>

        {/* Close Button (only when completed or error) */}
        <Show when={completed() || error()}>
          <button
            class="btn-primary w-full"
            onClick={() => {
              if (completed()) {
                props.onComplete?.();
              }
            }}
          >
            {completed() ? "Продолжить" : "Закрыть"}
          </button>
        </Show>
      </div>
    </ModalWrapper>
  );
}

export default InstallProgressModal;