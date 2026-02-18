import { Show, createEffect, createSignal, onCleanup } from "solid-js";
import type { TourStep } from "../hooks/useTour";
import { useI18n } from "../i18n";

interface TourProps {
  steps: TourStep[];
  active: boolean;
  currentStep: number;
  totalSteps: number;
  onNext: () => void;
  onPrev: () => void;
  onSkip: () => void;
}

interface TargetRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const SPOTLIGHT_PADDING = 8;
const TOOLTIP_GAP = 12;
const TOOLTIP_MAX_WIDTH = 340;

export function Tour(props: TourProps) {
  const { t } = useI18n();
  const [targetRect, setTargetRect] = createSignal<TargetRect | null>(null);
  let resizeObserver: ResizeObserver | undefined;
  let animFrameId: number | undefined;

  // Находим и отслеживаем целевой элемент при смене шага
  createEffect(() => {
    if (!props.active) {
      setTargetRect(null);
      return;
    }

    const step = props.steps[props.currentStep];
    if (!step) return;

    // Очищаем предыдущий observer
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = undefined;
    }
    if (animFrameId !== undefined) {
      cancelAnimationFrame(animFrameId);
    }

    const findAndTrack = () => {
      const el = document.querySelector(step.target);
      if (!el) {
        // Элемент не найден — пропускаем шаг
        if (import.meta.env.DEV) console.log(`[Tour] Target not found: ${step.target}, skipping`);
        setTargetRect(null);
        return;
      }

      // Scroll into view если элемент вне viewport
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });

      const updateRect = () => {
        const rect = el.getBoundingClientRect();
        setTargetRect({
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
        });
      };

      // Начальный расчёт
      updateRect();

      // Отслеживаем resize
      resizeObserver = new ResizeObserver(updateRect);
      resizeObserver.observe(el);

      // Отслеживаем scroll/window resize (recalc на каждый frame не нужен,
      // достаточно по событиям)
      const handleReposition = () => {
        animFrameId = requestAnimationFrame(updateRect);
      };

      window.addEventListener("resize", handleReposition);
      window.addEventListener("scroll", handleReposition, true);

      onCleanup(() => {
        window.removeEventListener("resize", handleReposition);
        window.removeEventListener("scroll", handleReposition, true);
      });
    };

    // Даём DOM время обновиться (onBeforeShow мог изменить layout)
    requestAnimationFrame(findAndTrack);
  });

  onCleanup(() => {
    if (resizeObserver) resizeObserver.disconnect();
    if (animFrameId !== undefined) cancelAnimationFrame(animFrameId);
  });

  const TOOLTIP_ESTIMATED_HEIGHT = 160;

  // Позиционирование tooltip с автоматическим переворотом при переполнении viewport
  const tooltipStyle = () => {
    const rect = targetRect();
    if (!rect) return {};

    const step = props.steps[props.currentStep];
    if (!step) return {};

    let placement = step.placement || "bottom";
    const spotTop = rect.top - SPOTLIGHT_PADDING;
    const spotLeft = rect.left - SPOTLIGHT_PADDING;
    const spotWidth = rect.width + SPOTLIGHT_PADDING * 2;
    const spotHeight = rect.height + SPOTLIGHT_PADDING * 2;
    const spotBottom = spotTop + spotHeight;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 12;
    const titleBarH = 52;

    // Автоматический переворот: если не помещается — ставим с противоположной стороны
    if (placement === "top" && spotTop - TOOLTIP_GAP - TOOLTIP_ESTIMATED_HEIGHT < titleBarH) {
      placement = "bottom";
    } else if (placement === "bottom" && spotBottom + TOOLTIP_GAP + TOOLTIP_ESTIMATED_HEIGHT > vh) {
      placement = "top";
    } else if (placement === "left" && spotLeft - TOOLTIP_GAP - TOOLTIP_MAX_WIDTH < margin) {
      placement = "right";
    } else if (placement === "right" && spotLeft + spotWidth + TOOLTIP_GAP + TOOLTIP_MAX_WIDTH > vw - margin) {
      placement = "left";
    }

    let top: number;
    let left: number;
    let transform = "";

    switch (placement) {
      case "bottom":
        top = spotBottom + TOOLTIP_GAP;
        left = spotLeft + spotWidth / 2 - TOOLTIP_MAX_WIDTH / 2;
        break;
      case "top":
        top = spotTop - TOOLTIP_GAP;
        left = spotLeft + spotWidth / 2 - TOOLTIP_MAX_WIDTH / 2;
        transform = "translateY(-100%)";
        break;
      case "right":
        top = spotTop + spotHeight / 2;
        left = spotLeft + spotWidth + TOOLTIP_GAP;
        transform = "translateY(-50%)";
        break;
      case "left":
        top = spotTop + spotHeight / 2;
        left = spotLeft - TOOLTIP_MAX_WIDTH - TOOLTIP_GAP;
        transform = "translateY(-50%)";
        break;
      default:
        top = spotBottom + TOOLTIP_GAP;
        left = spotLeft;
    }

    // Горизонтальная коррекция — не вылезать за края экрана
    left = Math.max(margin, Math.min(left, vw - TOOLTIP_MAX_WIDTH - margin));

    // Вертикальная коррекция для left/right/bottom — не вылезать за верх/низ
    if (placement === "bottom" || placement === "left" || placement === "right") {
      top = Math.max(titleBarH, Math.min(top, vh - TOOLTIP_ESTIMATED_HEIGHT - margin));
    }

    const result: Record<string, string> = {
      top: `${top}px`,
      left: `${left}px`,
      "max-width": `${TOOLTIP_MAX_WIDTH}px`,
    };

    if (transform) {
      result.transform = transform;
    }

    return result;
  };

  // Keyboard navigation
  const handleKeyDown = (e: KeyboardEvent) => {
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        props.onSkip();
        break;
      case "ArrowRight":
      case "Enter":
        e.preventDefault();
        props.onNext();
        break;
      case "ArrowLeft":
        e.preventDefault();
        props.onPrev();
        break;
    }
  };

  createEffect(() => {
    if (props.active) {
      document.addEventListener("keydown", handleKeyDown);
    } else {
      document.removeEventListener("keydown", handleKeyDown);
    }
    onCleanup(() => document.removeEventListener("keydown", handleKeyDown));
  });

  return (
    <Show when={props.active && targetRect()}>
      {/* Spotlight — дырка над целевым элементом, всё остальное затемнено */}
      <div
        class="fixed z-[70] pointer-events-none rounded-xl"
        style={{
          top: `${targetRect()!.top - SPOTLIGHT_PADDING}px`,
          left: `${targetRect()!.left - SPOTLIGHT_PADDING}px`,
          width: `${targetRect()!.width + SPOTLIGHT_PADDING * 2}px`,
          height: `${targetRect()!.height + SPOTLIGHT_PADDING * 2}px`,
          "box-shadow": "0 0 0 9999px rgba(0, 0, 0, 0.7)",
        }}
      />

      {/* Кликабельный backdrop — skip при клике вне tooltip */}
      <div
        class="fixed inset-0 z-[70]"
        onClick={(e) => {
          // Не закрываем если кликнули на сам tooltip
          if ((e.target as HTMLElement).closest("[data-tour-tooltip]")) return;
          props.onSkip();
        }}
      />

      {/* Tooltip */}
      <div
        data-tour-tooltip
        class="fixed z-[70] bg-gray-850 border border-gray-700 rounded-2xl p-4 shadow-2xl animate-scale-in"
        style={{ ...tooltipStyle(), "animation-duration": "0.1s" }}
      >
        <h3 class="text-base font-semibold mb-1">
          {props.steps[props.currentStep]?.title}
        </h3>
        <p class="text-sm text-gray-400 mb-3">
          {props.steps[props.currentStep]?.description}
        </p>
        <Show when={props.steps[props.currentStep]?.whatsNew}>
          <div class="flex items-start gap-2 px-2.5 py-2 mb-3 bg-blue-500/10 border border-blue-500/20 rounded-xl text-xs text-blue-300">
            <i class="i-hugeicons-sparkles w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <span>{props.steps[props.currentStep]!.whatsNew}</span>
          </div>
        </Show>

        <div class="flex items-center justify-between">
          {/* Step indicator */}
          <span class="text-xs text-gray-600">
            {props.currentStep + 1} / {props.totalSteps}
          </span>

          {/* Navigation */}
          <div class="flex items-center gap-2">
            <button
              class="btn-ghost btn-sm text-gray-500"
              onClick={(e) => { e.stopPropagation(); props.onSkip(); }}
            >
              {t().common.skip}
            </button>

            <Show when={props.currentStep > 0}>
              <button
                class="btn-secondary btn-sm"
                onClick={(e) => { e.stopPropagation(); props.onPrev(); }}
              >
                <i class="i-hugeicons-arrow-left-01 w-3.5 h-3.5" />
              </button>
            </Show>

            <button
              class="btn-primary btn-sm"
              onClick={(e) => { e.stopPropagation(); props.onNext(); }}
            >
              {props.currentStep === props.totalSteps - 1
                ? t().common.done
                : t().common.next}
              <Show when={props.currentStep < props.totalSteps - 1}>
                <i class="i-hugeicons-arrow-right-01 w-3.5 h-3.5" />
              </Show>
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
