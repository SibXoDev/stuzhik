import { createSignal, Show, type JSX } from "solid-js";
import { useI18n } from "../i18n";
import { useKnowledgeBase } from "../hooks";

export interface FeedbackDialogProps {
  /** Показать диалог */
  open: boolean;
  /** Callback при закрытии */
  onClose: () => void;
  /** Сигнатура проблемы */
  problemSignature: string;
  /** ID решения */
  solutionId: string;
  /** Заголовок решения */
  solutionTitle: string;
  /** ID экземпляра (опционально) */
  instanceId?: string;
  /** Callback после успешного сохранения feedback */
  onFeedbackSaved?: (helped: boolean) => void;
}

/**
 * Диалог для сбора feedback о решении
 */
export function FeedbackDialog(props: FeedbackDialogProps) {
  const { t } = useI18n();
  const kb = useKnowledgeBase();

  const [notes, setNotes] = createSignal("");
  const [submitting, setSubmitting] = createSignal(false);

  async function handleFeedback(helped: boolean) {
    setSubmitting(true);

    try {
      const result = await kb.saveFeedback({
        problemSignature: props.problemSignature,
        solutionId: props.solutionId,
        helped,
        notes: notes() || undefined,
        instanceId: props.instanceId,
      });

      if (result) {
        props.onFeedbackSaved?.(helped);
        setNotes("");
        props.onClose();
      }
    } finally {
      setSubmitting(false);
    }
  }

  const handleOverlayClick: JSX.EventHandler<HTMLDivElement, MouseEvent> = (
    e
  ) => {
    if (e.target === e.currentTarget) {
      props.onClose();
    }
  };

  return (
    <Show when={props.open}>
      <div class="modal-overlay" onClick={handleOverlayClick}>
        <div class="modal-content max-w-md">
          {/* Header */}
          <div class="flex items-center justify-between mb-4">
            <h2 class="text-xl font-semibold">
              {t().knowledgeBase.feedbackTitle}
            </h2>
            <button
              onClick={props.onClose}
              class="btn-close"
              aria-label="Close"
            >
              <i class="i-hugeicons-cancel-01 w-5 h-5" />
            </button>
          </div>

          {/* Solution title */}
          <div class="mb-4">
            <p class="text-sm text-gray-400 mb-1">
              {t().knowledgeBase.solution}:
            </p>
            <p class="text-gray-200">{props.solutionTitle}</p>
          </div>

          {/* Question */}
          <p class="text-lg mb-6">{t().knowledgeBase.didItHelp}</p>

          {/* Notes textarea */}
          <div class="mb-6">
            <label
              for="feedback-notes"
              class="block text-sm text-gray-400 mb-2"
            >
              {t().knowledgeBase.notesOptional}
            </label>
            <textarea
              id="feedback-notes"
              value={notes()}
              onInput={(e) => setNotes(e.currentTarget.value)}
              placeholder={t().knowledgeBase.notesPlaceholder}
              rows={4}
              disabled={submitting()}
            />
          </div>

          {/* Error message */}
          <Show when={kb.error()}>
            <div class="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-xl">
              <p class="text-sm text-red-400">{kb.error()}</p>
            </div>
          </Show>

          {/* Actions */}
          <div class="flex gap-3">
            <button
              onClick={() => handleFeedback(true)}
              disabled={submitting()}
              class="flex-1 btn btn-primary"
            >
              <Show
                when={!submitting()}
                fallback={<i class="i-svg-spinners-6-dots-scale w-5 h-5" />}
              >
                <i class="i-hugeicons-thumbs-up w-5 h-5" />
                <span>{t().knowledgeBase.yesHelped}</span>
              </Show>
            </button>

            <button
              onClick={() => handleFeedback(false)}
              disabled={submitting()}
              class="flex-1 btn btn-secondary"
            >
              <Show
                when={!submitting()}
                fallback={<i class="i-svg-spinners-6-dots-scale w-5 h-5" />}
              >
                <i class="i-hugeicons-thumbs-down w-5 h-5" />
                <span>{t().knowledgeBase.noDidntHelp}</span>
              </Show>
            </button>
          </div>

          {/* Skip button */}
          <button
            onClick={props.onClose}
            disabled={submitting()}
            class="btn-ghost w-full mt-3"
          >
            {t().knowledgeBase.skipFeedback}
          </button>
        </div>
      </div>
    </Show>
  );
}
