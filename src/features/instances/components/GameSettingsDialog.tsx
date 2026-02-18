import { createSignal, Show, For, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { createConfirmDialog } from "../../../shared/components/ConfirmDialog";
import { ModalWrapper } from "../../../shared/ui/ModalWrapper";
import { useI18n } from "../../../shared/i18n";

interface Props {
  instanceId: string;
  instanceName: string;
  onClose: () => void;
}

function GameSettingsDialog(props: Props) {
  const { confirm, ConfirmDialogComponent } = createConfirmDialog();
  const { t } = useI18n();
  const [templates, setTemplates] = createSignal<string[]>([]);
  const [selectedTemplate, setSelectedTemplate] = createSignal("");
  const [newTemplateName, setNewTemplateName] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [success, setSuccess] = createSignal<string | null>(null);

  onMount(async () => {
    await loadTemplates();
  });

  const loadTemplates = async () => {
    try {
      const data = await invoke<string[]>("list_settings_templates");
      setTemplates(data);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Не удалось загрузить шаблоны: ${msg}`);
      if (import.meta.env.DEV) console.error("Failed to load templates:", e);
    }
  };

  const handleSaveTemplate = async () => {
    const name = newTemplateName().trim();
    if (!name) {
      setError("Введите название шаблона");
      return;
    }

    try {
      setLoading(true);
      setError(null);
      setSuccess(null);

      await invoke("save_settings_template", {
        instanceId: props.instanceId,
        templateName: name,
      });

      setSuccess(`Шаблон "${name}" сохранён`);
      setNewTemplateName("");
      await loadTemplates();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Не удалось сохранить шаблон: ${msg}`);
      if (import.meta.env.DEV) console.error("Failed to save template:", e);
    } finally {
      setLoading(false);
    }
  };

  const handleApplyTemplate = async () => {
    const template = selectedTemplate();
    if (!template) {
      setError("Выберите шаблон");
      return;
    }

    const confirmed = await confirm({
      title: "Применить шаблон?",
      message: `Применить шаблон "${template}" к экземпляру "${props.instanceName}"?\n\nВнимание: текущие настройки игры будут перезаписаны!`,
      variant: "warning",
      confirmText: "Применить",
    });
    if (!confirmed) return;

    try {
      setLoading(true);
      setError(null);
      setSuccess(null);

      await invoke("apply_settings_template", {
        instanceId: props.instanceId,
        templateName: template,
      });

      setSuccess(`Шаблон "${template}" применён к экземпляру`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Не удалось применить шаблон: ${msg}`);
      if (import.meta.env.DEV) console.error("Failed to apply template:", e);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteTemplate = async (templateName: string) => {
    const confirmed = await confirm({
      title: "Удалить шаблон?",
      message: `Удалить шаблон "${templateName}"?`,
      variant: "danger",
      confirmText: "Удалить",
    });
    if (!confirmed) return;

    try {
      setLoading(true);
      setError(null);
      setSuccess(null);

      await invoke("delete_settings_template", {
        templateName: templateName,
      });

      setSuccess(`Шаблон "${templateName}" удалён`);
      if (selectedTemplate() === templateName) {
        setSelectedTemplate("");
      }
      await loadTemplates();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Не удалось удалить шаблон: ${msg}`);
      if (import.meta.env.DEV) console.error("Failed to delete template:", e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <ModalWrapper maxWidth="max-w-4xl" backdrop>
      <div class="p-6 max-h-[90vh] overflow-y-auto flex flex-col gap-6">
        <div class="flex items-center justify-between">
          <div class="flex flex-col gap-1">
            <h2 class="text-2xl font-bold">Шаблоны настроек игры</h2>
            <p class="text-sm text-gray-400">Экземпляр: {props.instanceName}</p>
          </div>
          <button
            type="button"
            class="btn-close"
            onClick={props.onClose}
            aria-label={t().ui?.tooltips?.close ?? "Close"}
          >
            <i class="i-hugeicons-cancel-01 w-5 h-5" />
          </button>
        </div>

        {/* Alerts */}
        <Show when={error()}>
          <div class="bg-red-500/10 border border-red-500/30 rounded-2xl p-4">
            <div class="flex items-start gap-3">
              <div class="i-hugeicons-alert-02 text-red-400 w-5 h-5 flex-shrink-0" />
              <div class="flex-1">
                <p class="text-red-400 text-sm">{error()}</p>
              </div>
              <button
                type="button"
                class="text-red-400 hover:text-red-300"
                onClick={() => setError(null)}
              >
                <div class="i-hugeicons-cancel-01 w-5 h-5" />
              </button>
            </div>
          </div>
        </Show>

        <Show when={success()}>
          <div class="bg-green-500/10 border border-green-500/30 rounded-2xl p-4">
            <div class="flex items-start gap-3">
              <div class="i-hugeicons-checkmark-circle-02 text-green-400 w-5 h-5 flex-shrink-0" />
              <div class="flex-1">
                <p class="text-green-400 text-sm">{success()}</p>
              </div>
              <button
                type="button"
                class="text-green-400 hover:text-green-300"
                onClick={() => setSuccess(null)}
              >
                <div class="i-hugeicons-cancel-01 w-5 h-5" />
              </button>
            </div>
          </div>
        </Show>

        {/* Info */}
        <div class="bg-blue-500/10 border border-blue-500/30 rounded-2xl p-4 text-sm text-blue-300">
          <div class="flex items-start gap-2">
            <div class="i-hugeicons-information-circle text-blue-400 w-5 h-5 flex-shrink-0 mt-0.5" />
            <div class="flex flex-col gap-2">
              <p>
                <strong>Шаблоны настроек</strong> позволяют сохранять и применять настройки игры (options.txt),
                конфиги модов и другие файлы настроек между экземплярами.
              </p>
              <p>
                <strong>Что сохраняется:</strong> options.txt, optionsof.txt, optionsshaders.txt, config/
              </p>
            </div>
          </div>
        </div>

        <div class="flex flex-col gap-6">
          {/* Сохранить текущие настройки как шаблон */}
          <div class="border border-gray-750 rounded-2xl p-4 flex flex-col gap-3">
            <h3 class="text-lg font-semibold">Сохранить настройки</h3>
            <p class="text-sm text-gray-400">
              Сохраните текущие настройки этого экземпляра как шаблон для применения к другим экземплярам
            </p>
            <div class="flex gap-2">
              <input
                type="text"
                value={newTemplateName()}
                onInput={(e) => setNewTemplateName(e.currentTarget.value)}
                placeholder="Название шаблона..."
                class="flex-1 px-3.5 py-2.5 focus:outline-none focus:border-[var(--color-primary)]"
                disabled={loading()}
              />
              <button
                type="button"
                class="btn-primary disabled:opacity-40"
                onClick={handleSaveTemplate}
                disabled={loading() || !newTemplateName().trim()}
              >
                <div class="flex items-center gap-2">
                  <div class="i-hugeicons-floppy-disk w-4 h-4" />
                  Сохранить
                </div>
              </button>
            </div>
          </div>

          {/* Применить шаблон */}
          <div class="border border-gray-750 rounded-2xl p-4 flex flex-col gap-3">
            <h3 class="text-lg font-semibold">Применить шаблон</h3>
            <Show
              when={templates().length > 0}
              fallback={
                <p class="text-sm text-gray-400">
                  Нет сохранённых шаблонов. Сохраните настройки экземпляра как шаблон, чтобы применить их к другим экземплярам.
                </p>
              }
            >
              <div class="flex flex-col gap-3">
                <For each={templates()}>
                  {(template) => (
                    <div class="flex items-center justify-between p-3 bg-gray-700/30 rounded-2xl border border-gray-700">
                      <label class="flex items-center gap-3 flex-1 cursor-pointer">
                        <input
                          type="radio"
                          name="template"
                          value={template}
                          checked={selectedTemplate() === template}
                          onChange={(e) => setSelectedTemplate(e.currentTarget.value)}
                          class="w-4 h-4"
                        />
                        <span class="text-sm font-medium">{template}</span>
                      </label>
                      <button
                        type="button"
                        class="px-2 py-1 text-xs text-red-400 hover:text-red-300"
                        onClick={() => handleDeleteTemplate(template)}
                        disabled={loading()}
                      >
                        <div class="i-hugeicons-delete-02 w-4 h-4" />
                      </button>
                    </div>
                  )}
                </For>
                <button
                  type="button"
                  class="w-full px-4 py-2.5 font-medium rounded-2xl bg-green-600 text-white hover:bg-green-400 disabled:opacity-40"
                  onClick={handleApplyTemplate}
                  disabled={loading() || !selectedTemplate()}
                >
                  <div class="flex items-center justify-center gap-2">
                    <div class="i-hugeicons-checkmark-circle-02 w-4 h-4" />
                    Применить к этому экземпляру
                  </div>
                </button>
              </div>
            </Show>
          </div>
        </div>

        {/* Close button */}
        <div class="flex justify-end">
          <button
            type="button"
            class="px-4 py-2.5 font-medium rounded-2xl bg-gray-700 text-gray-100 hover:bg-gray-600"
            onClick={props.onClose}
          >
            Закрыть
          </button>
        </div>

        {/* Confirm Dialog */}
        <ConfirmDialogComponent />
      </div>
    </ModalWrapper>
  );
}

export default GameSettingsDialog;
