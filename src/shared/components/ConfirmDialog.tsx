import { Show, createSignal, createEffect } from "solid-js";
import { useI18n } from "../i18n";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: "danger" | "warning" | "info";
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Кастомный диалог подтверждения для замены системного confirm().
 * Использование:
 *
 * const [showConfirm, setShowConfirm] = createSignal(false);
 *
 * <ConfirmDialog
 *   open={showConfirm()}
 *   title="Удалить?"
 *   message="Это действие нельзя отменить."
 *   variant="danger"
 *   onConfirm={() => { doDelete(); setShowConfirm(false); }}
 *   onCancel={() => setShowConfirm(false)}
 * />
 */
export default function ConfirmDialog(props: ConfirmDialogProps) {
  const { t } = useI18n();
  let dialogRef: HTMLDivElement | undefined;

  // Focus trap и ESC для закрытия
  createEffect(() => {
    if (props.open && dialogRef) {
      dialogRef.focus();
    }
  });

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      props.onCancel();
    } else if (e.key === "Enter") {
      props.onConfirm();
    }
  };

  const variantStyles = () => {
    switch (props.variant) {
      case "danger":
        return {
          icon: "i-hugeicons-alert-02",
          iconColor: "text-red-400",
          iconBg: "bg-red-500/10",
          btnClass: "btn-danger",
        };
      case "warning":
        return {
          icon: "i-hugeicons-alert-02",
          iconColor: "text-amber-400",
          iconBg: "bg-amber-500/10",
          btnClass: "btn-warning",
        };
      default:
        return {
          icon: "i-hugeicons-information-circle",
          iconColor: "text-blue-400",
          iconBg: "bg-blue-500/10",
          btnClass: "btn-primary",
        };
    }
  };

  return (
    <Show when={props.open}>
      {/* Backdrop - blocks all interactions below */}
      <div
        class="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm animate-fade-in pointer-events-auto"
        style="animation-duration: 0.1s"
        onClick={(e) => {
          // Only close if clicking directly on backdrop, not bubbled events
          if (e.target === e.currentTarget) {
            e.preventDefault();
            e.stopPropagation();
            props.onCancel();
          }
        }}
        onKeyDown={handleKeyDown}
        role="dialog"
        aria-modal="true"
      >
        {/* Dialog content */}
        <div
          ref={dialogRef}
          tabIndex={-1}
          class="bg-gray-850 rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6 animate-scale-in border border-gray-800 outline-none"
          style="animation-duration: 0.1s"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Icon and Title */}
          <div class="flex items-start gap-4 mb-4">
            <div class={`p-3 rounded-full ${variantStyles().iconBg}`}>
              <i class={`${variantStyles().icon} w-6 h-6 ${variantStyles().iconColor}`} />
            </div>
            <div class="flex-1 min-w-0">
              <h3 class="text-lg font-semibold text-white">{props.title}</h3>
              <p class="text-sm text-gray-400 mt-1 whitespace-pre-line">{props.message}</p>
            </div>
          </div>

          {/* Buttons */}
          <div class="flex items-center justify-end gap-3 mt-6">
            <button
              type="button"
              class="btn-secondary"
              onClick={props.onCancel}
            >
              {props.cancelText || t().common.cancel}
            </button>
            <button
              type="button"
              class={variantStyles().btnClass}
              onClick={props.onConfirm}
            >
              {props.confirmText || t().common.confirm}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}

// Хелпер для удобного использования с Promise
export function createConfirmDialog() {
  const [state, setState] = createSignal<{
    open: boolean;
    title: string;
    message: string;
    variant?: "danger" | "warning" | "info";
    confirmText?: string;
    cancelText?: string;
    resolve?: (value: boolean) => void;
  }>({
    open: false,
    title: "",
    message: "",
  });

  const confirm = (options: {
    title: string;
    message: string;
    variant?: "danger" | "warning" | "info";
    confirmText?: string;
    cancelText?: string;
  }): Promise<boolean> => {
    return new Promise((resolve) => {
      setState({
        open: true,
        ...options,
        resolve,
      });
    });
  };

  const handleConfirm = () => {
    state().resolve?.(true);
    setState((prev) => ({ ...prev, open: false }));
  };

  const handleCancel = () => {
    state().resolve?.(false);
    setState((prev) => ({ ...prev, open: false }));
  };

  const ConfirmDialogComponent = () => (
    <ConfirmDialog
      open={state().open}
      title={state().title}
      message={state().message}
      variant={state().variant}
      confirmText={state().confirmText}
      cancelText={state().cancelText}
      onConfirm={handleConfirm}
      onCancel={handleCancel}
    />
  );

  return { confirm, ConfirmDialogComponent };
}
