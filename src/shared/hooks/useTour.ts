import { createSignal, onCleanup } from "solid-js";

export interface TourStep {
  /** CSS selector для целевого элемента */
  target: string;
  /** Заголовок подсказки */
  title: string;
  /** Описание */
  description: string;
  /** Позиция подсказки относительно элемента */
  placement: "top" | "bottom" | "left" | "right";
  /** Действие перед показом шага (например, открыть панель) */
  onBeforeShow?: () => void | Promise<void>;
  /** Действие при уходе с шага */
  onAfterHide?: () => void;
  /** Номер версии, в которой этот шаг появился (для "What's New" фильтрации) */
  addedInVersion?: number;
  /** Номер версии, в которой этот шаг обновился (контент изменился) */
  updatedInVersion?: number;
  /** Описание что именно нового/изменилось в этом шаге (для "What's New" режима) */
  whatsNew?: string;
}

export interface TourConfig {
  /** Уникальный ID для localStorage persistence */
  id: string;
  /** Версия тура — при изменении пройденный тур покажется заново */
  version?: number;
  /** Шаги тура */
  steps: TourStep[];
  /** Человекочитаемое название тура (для UI выбора) */
  label?: string;
  /** Иконка тура (CSS class, например "i-hugeicons-book-02") */
  icon?: string;
  /** Описание тура (для UI выбора) */
  description?: string;
  /** ID родительского тура (для под-туров) */
  parentId?: string;
}

/** Группа туров — основной тур + под-туры для модулей */
export interface TourGroup {
  /** Основной тур */
  main: TourConfig;
  /** Под-туры по модулям (ключ = sub-tour ID) */
  subTours: Record<string, TourConfig>;
}

const STORAGE_PREFIX = "stuzhik-tour-";


/** Получить список всех сохранённых ID туров */
export function getCompletedTourIds(): string[] {
  const ids: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(STORAGE_PREFIX)) {
        const id = key.slice(STORAGE_PREFIX.length);
        ids.push(id);
      }
    }
  } catch {
    // localStorage недоступен
  }
  return ids;
}

/** Сбросить все туры */
export function resetAllTours(): void {
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(STORAGE_PREFIX)) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((key) => localStorage.removeItem(key));
  } catch {
    // localStorage недоступен
  }
}

// --- "What's New" system ---
// Показывает точку-индикатор когда тур обновился, но не перезапускает его.
// Пользователь сам решает — посмотреть новое или пропустить.

/** Проверить, есть ли непросмотренные обновления тура */
export function hasWhatsNew(tourId: string, currentVersion: number): boolean {
  try {
    const stored = localStorage.getItem(`${STORAGE_PREFIX}${tourId}`);
    if (!stored) return false; // Тур вообще не пройден — это не "what's new", это первый запуск
    if (stored === "done") return currentVersion > 1;
    const match = stored.match(/^done:(\d+)$/);
    if (match) return currentVersion > parseInt(match[1], 10);
    return false;
  } catch {
    return false;
  }
}

/** Пометить "what's new" как просмотренное (без прохождения тура) */
export function dismissWhatsNew(tourId: string, currentVersion: number): void {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${tourId}`, `done:${currentVersion}`);
  } catch {
    // localStorage недоступен
  }
}

export function useTour(config: TourConfig) {
  const STORAGE_KEY = `${STORAGE_PREFIX}${config.id}`;

  const [active, setActive] = createSignal(false);
  const [currentStep, setCurrentStep] = createSignal(0);

  const isCompleted = () => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (!stored) return false;
      // Поддержка legacy формата "done" (без версии)
      if (stored === "done") {
        // Если у тура появилась версия > 1, считаем непройденным
        return !config.version || config.version <= 1;
      }
      // Новый формат: "done:VERSION"
      const match = stored.match(/^done:(\d+)$/);
      if (match) {
        const completedVersion = parseInt(match[1], 10);
        return !config.version || completedVersion >= config.version;
      }
      return false;
    } catch {
      return false;
    }
  };

  const markCompleted = () => {
    try {
      const value = config.version ? `done:${config.version}` : "done";
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // localStorage недоступен
    }
  };

  const resetTour = () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // localStorage недоступен
    }
  };

  const start = async () => {
    setCurrentStep(0);
    setActive(true);
    const step = config.steps[0];
    if (step?.onBeforeShow) {
      await step.onBeforeShow();
    }
  };

  const next = async () => {
    const idx = currentStep();
    config.steps[idx]?.onAfterHide?.();

    if (idx < config.steps.length - 1) {
      const nextIdx = idx + 1;
      setCurrentStep(nextIdx);
      const step = config.steps[nextIdx];
      if (step?.onBeforeShow) {
        await step.onBeforeShow();
      }
    } else {
      finish();
    }
  };

  const prev = async () => {
    const idx = currentStep();
    if (idx > 0) {
      config.steps[idx]?.onAfterHide?.();
      const prevIdx = idx - 1;
      setCurrentStep(prevIdx);
      const step = config.steps[prevIdx];
      if (step?.onBeforeShow) {
        await step.onBeforeShow();
      }
    }
  };

  const skip = () => {
    const idx = currentStep();
    config.steps[idx]?.onAfterHide?.();
    markCompleted();
    setActive(false);
  };

  const finish = () => {
    markCompleted();
    setActive(false);
  };

  onCleanup(() => {
    // Cleanup при unmount
    if (active()) {
      const idx = currentStep();
      config.steps[idx]?.onAfterHide?.();
    }
  });

  /** Есть ли непросмотренные обновления (тур пройден, но появилась новая версия) */
  const hasUpdates = () => config.version ? hasWhatsNew(config.id, config.version) : false;

  /** Пометить обновления как просмотренные без прохождения тура */
  const dismissUpdates = () => {
    if (config.version) dismissWhatsNew(config.id, config.version);
  };

  /** Получить версию, до которой тур пройден */
  const getCompletedVersion = (): number => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "done") return 1;
      const match = stored?.match(/^done:(\d+)$/);
      if (match) return parseInt(match[1], 10);
      return 0;
    } catch {
      return 0;
    }
  };

  /** Получить только новые шаги (добавленные после пройденной версии) */
  const getNewSteps = (): TourStep[] => {
    if (!config.version) return [];
    const completedVersion = getCompletedVersion();
    return config.steps.filter((s) => (s.addedInVersion ?? 1) > completedVersion);
  };

  /** Получить изменённые шаги (обновлённые после пройденной версии) */
  const getChangedSteps = (): TourStep[] => {
    if (!config.version) return [];
    const completedVersion = getCompletedVersion();
    return config.steps.filter((s) =>
      (s.updatedInVersion && s.updatedInVersion > completedVersion) ||
      (s.addedInVersion ?? 1) > completedVersion
    );
  };

  /** Запустить тур только с новыми/обновлёнными шагами */
  const startWhatsNew = async () => {
    const changedSteps = getChangedSteps();
    if (changedSteps.length === 0) return;
    const originalSteps = config.steps;
    config.steps = changedSteps;
    await start();
    // Восстанавливаем после завершения (finish/skip вызовут markCompleted)
    config.steps = originalSteps;
  };

  return {
    config,
    active,
    currentStep,
    start,
    startWhatsNew,
    next,
    prev,
    skip,
    finish,
    isCompleted,
    resetTour,
    hasUpdates,
    dismissUpdates,
    getNewSteps,
    getChangedSteps,
    totalSteps: () => config.steps.length,
    step: () => config.steps[currentStep()],
  };
}

// --- Tour Registry ---
// Глобальный реестр туров для UI выбора и управления.

export type TourInstance = ReturnType<typeof useTour>;

const tourRegistry = new Map<string, TourInstance>();

/** Зарегистрировать тур в глобальном реестре */
export function registerTour(tour: TourInstance): void {
  tourRegistry.set(tour.config.id, tour);
}

/** Убрать тур из реестра */
export function unregisterTour(tourId: string): void {
  tourRegistry.delete(tourId);
}

/** Получить все зарегистрированные туры */
export function getRegisteredTours(): TourInstance[] {
  return Array.from(tourRegistry.values());
}

/** Получить тур по ID */
export function getTourById(tourId: string): TourInstance | undefined {
  return tourRegistry.get(tourId);
}

/** Получить под-туры для родительского тура */
export function getSubTours(parentId: string): TourInstance[] {
  return Array.from(tourRegistry.values()).filter(
    (t) => t.config.parentId === parentId
  );
}

/** Получить только корневые туры (без parentId) */
export function getRootTours(): TourInstance[] {
  return Array.from(tourRegistry.values()).filter(
    (t) => !t.config.parentId
  );
}
