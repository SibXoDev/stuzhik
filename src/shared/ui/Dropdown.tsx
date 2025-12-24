import { JSX, Show, createSignal, onMount, onCleanup, createEffect } from "solid-js";

interface DropdownProps {
  trigger: JSX.Element;
  open: boolean;
  onClose: () => void;
  onToggle?: () => void;
  class?: string;
  contentClass?: string;
  disabled?: boolean;
  children?: JSX.Element;
  /** Custom max height for dropdown content */
  maxHeight?: string;
}

/**
 * Универсальный Dropdown компонент с адаптивным позиционированием
 * Автоматически определяет направление открытия (вверх/вниз)
 * Адаптирует высоту под доступное пространство
 */
function Dropdown(props: DropdownProps) {
  let triggerRef: HTMLDivElement | undefined;
  let dropdownRef: HTMLDivElement | undefined;

  const [position, setPosition] = createSignal<{
    top?: number;
    bottom?: number;
    left: number;
    translateX: number; // смещение от центра для корректировки краёв
    minWidth: number;
    maxWidth: number;
    maxHeight: number;
  } | null>(null);

  const calculatePosition = () => {
    if (!triggerRef || !props.open) return;

    const triggerRect = triggerRef.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;

    // Отступ от края экрана
    const margin = 16;
    const gap = 8; // Расстояние между триггером и дропдауном

    // Доступное пространство снизу и сверху
    const spaceBelow = viewportHeight - triggerRect.bottom - margin;
    const spaceAbove = triggerRect.top - margin;

    // Определяем, куда открывать (вверх/вниз)
    const openUpward = spaceBelow < 200 && spaceAbove > spaceBelow;

    // Вычисляем максимальную высоту
    const customMaxHeight = props.maxHeight ? parseInt(props.maxHeight, 10) : 400;
    const maxHeight = openUpward
      ? Math.min(spaceAbove - gap, customMaxHeight)
      : Math.min(spaceBelow - gap, customMaxHeight);

    // Максимальная ширина с учётом viewport
    const maxWidth = Math.min(400, viewportWidth - margin * 2);

    // Центр триггера - точка привязки dropdown
    const triggerCenterX = triggerRect.left + triggerRect.width / 2;

    // Базовая позиция (центрирование через CSS transform)
    const basePos: {
      top?: number;
      bottom?: number;
      left: number;
      translateX: number;
      minWidth: number;
      maxWidth: number;
      maxHeight: number;
    } = {
      left: triggerCenterX,
      translateX: -50, // центрируем через transform
      minWidth: triggerRect.width,
      maxWidth: Math.max(maxWidth, triggerRect.width),
      maxHeight: Math.max(maxHeight, 150),
    };

    // Вертикальное позиционирование
    if (openUpward) {
      basePos.bottom = viewportHeight - triggerRect.top + gap;
    } else {
      basePos.top = triggerRect.bottom + gap;
    }

    setPosition(basePos);

    // После рендера корректируем если выходит за края
    requestAnimationFrame(() => {
      if (!dropdownRef) return;
      const dropdownRect = dropdownRef.getBoundingClientRect();

      let translateX = -50; // процент от ширины dropdown

      // Проверяем выход за левый край
      if (dropdownRect.left < margin) {
        // Смещаем вправо на нужное количество пикселей
        const shiftNeeded = margin - dropdownRect.left;
        // Переводим в проценты от ширины dropdown
        translateX = -50 + (shiftNeeded / dropdownRect.width) * 100;
      }
      // Проверяем выход за правый край
      else if (dropdownRect.right > viewportWidth - margin) {
        // Смещаем влево
        const shiftNeeded = dropdownRect.right - (viewportWidth - margin);
        translateX = -50 - (shiftNeeded / dropdownRect.width) * 100;
      }

      if (translateX !== -50) {
        setPosition(prev => prev ? { ...prev, translateX } : null);
      }
    });
  };

  // Пересчитываем позицию при открытии
  createEffect(() => {
    if (props.open) {
      requestAnimationFrame(() => {
        calculatePosition();
      });
    }
  });

  onMount(() => {
    window.addEventListener("resize", calculatePosition);
    window.addEventListener("scroll", calculatePosition, true);
  });

  onCleanup(() => {
    window.removeEventListener("resize", calculatePosition);
    window.removeEventListener("scroll", calculatePosition, true);
  });

  return (
    <div
      class={`${props.class || ""} ${props.open ? "relative" : ""}`}
      style={props.open ? { "z-index": 62 } : {}}
      ref={triggerRef}
      onClick={(e) => {
        if (props.disabled) return;
        e.stopPropagation();
        props.onToggle?.();
      }}
    >
      {props.trigger}

      {/* Overlay - BELOW content and trigger */}
      <Show when={props.open}>
        <div
          class="fixed inset-0"
          style={{ "z-index": 60 }}
          onClick={(e) => {
            e.stopPropagation();
            props.onClose();
          }}
        />
      </Show>

      {/* Dropdown Content - ABOVE overlay */}
      <Show when={props.open && position()}>
        <div
          ref={dropdownRef}
          class={`fixed bg-[--color-bg-elevated] border border-gray-700 rounded-xl shadow-xl flex flex-col ${
            props.contentClass || ""
          }`}
          style={{
            "z-index": 61,
            top: position()!.top !== undefined ? `${position()!.top}px` : "auto",
            bottom: position()!.bottom !== undefined ? `${position()!.bottom}px` : "auto",
            left: `${position()!.left}px`,
            transform: `translateX(${position()!.translateX}%)`,
            "min-width": `${position()!.minWidth}px`,
            "max-width": `${position()!.maxWidth}px`,
            "max-height": `${position()!.maxHeight}px`,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {props.children}
        </div>
      </Show>
    </div>
  );
}

export default Dropdown;
