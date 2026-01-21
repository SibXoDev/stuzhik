import { createSignal, Show, For } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type {
  IntegrityCheckResult,
  RepairResult,
} from "../types";
import { formatSize } from "../utils/format-size";
import { useI18n } from "../i18n";

interface IntegrityCheckerProps {
  instanceId: string;
  onClose?: () => void;
  onRepairComplete?: () => void;
}

export function IntegrityChecker(props: IntegrityCheckerProps) {
  const { t } = useI18n();
  const [loading, setLoading] = createSignal(false);
  const [result, setResult] = createSignal<IntegrityCheckResult | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [repairing, setRepairing] = createSignal(false);
  const [repairResult, setRepairResult] = createSignal<RepairResult | null>(null);
  const [selectedFiles, setSelectedFiles] = createSignal<string[]>([]);
  const fmtSize = (bytes: number) => formatSize(bytes, t().ui?.units);

  async function checkIntegrity() {
    setLoading(true);
    setError(null);
    setResult(null);
    setRepairResult(null);

    try {
      const res = await invoke<IntegrityCheckResult>("check_integrity", {
        instanceId: props.instanceId,
      });
      setResult(res);

      const recoverableFiles = [
        ...res.corrupted_files.filter(f => f.recoverable).map(f => f.path),
        ...res.missing_files.filter(f => f.recoverable).map(f => f.path),
      ];
      setSelectedFiles(recoverableFiles);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function quickCheck() {
    setLoading(true);
    setError(null);

    try {
      const valid = await invoke<boolean>("quick_integrity_check", {
        instanceId: props.instanceId,
      });

      if (valid) {
        setResult({
          valid: true,
          total_files: 0,
          valid_files: 0,
          corrupted_files: [],
          missing_files: [],
          check_time_ms: 0,
        });
      } else {
        await checkIntegrity();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function createManifest() {
    setLoading(true);
    setError(null);

    try {
      await invoke("create_integrity_manifest", {
        instanceId: props.instanceId,
      });
      await checkIntegrity();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function repairFiles() {
    if (selectedFiles().length === 0) return;

    setRepairing(true);
    setError(null);

    try {
      const res = await invoke<RepairResult>("repair_integrity", {
        instanceId: props.instanceId,
        files: selectedFiles(),
      });
      setRepairResult(res);
      await checkIntegrity();

      if (res.failed.length === 0) {
        props.onRepairComplete?.();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setRepairing(false);
    }
  }

  function toggleFile(path: string) {
    setSelectedFiles(prev => {
      if (prev.includes(path)) {
        return prev.filter(p => p !== path);
      }
      return [...prev, path];
    });
  }

  function selectAllRecoverable() {
    const res = result();
    if (!res) return;

    const recoverableFiles = [
      ...res.corrupted_files.filter(f => f.recoverable).map(f => f.path),
      ...res.missing_files.filter(f => f.recoverable).map(f => f.path),
    ];
    setSelectedFiles(recoverableFiles);
  }

  return (
    <div class="space-y-4">
      {/* Actions */}
      <div class="flex items-center gap-2 flex-wrap">
        <button
          onClick={quickCheck}
          disabled={loading()}
          class="btn-ghost"
          data-size="sm"
        >
          <i class="i-hugeicons-flash w-4 h-4" />
          Быстрая проверка
        </button>
        <button
          onClick={checkIntegrity}
          disabled={loading()}
          class="btn-primary"
          data-size="sm"
        >
          <Show when={loading()} fallback={<i class="i-hugeicons-checkmark-circle-02 w-4 h-4" />}>
            <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
          </Show>
          Полная проверка
        </button>
        <button
          onClick={createManifest}
          disabled={loading()}
          class="btn-ghost"
          data-size="sm"
          title="Создать манифест для отслеживания изменений"
        >
          <i class="i-hugeicons-file-add w-4 h-4" />
          Создать манифест
        </button>
      </div>

      <Show when={loading()}>
        <div class="flex-col-center py-12">
          <i class="i-svg-spinners-6-dots-scale w-8 h-8 mb-3" />
          <span class="text-muted">Проверка файлов...</span>
        </div>
      </Show>

      <Show when={error()}>
        <div class="bg-red-500/10 border border-red-500/30 rounded-2xl p-3">
          <p class="text-red-400 text-sm">{error()}</p>
        </div>
      </Show>

      <Show when={repairResult()}>
        {(res) => (
          <div class={`${res().failed.length === 0 ? "bg-green-500/10 border-green-500/30" : "bg-yellow-500/10 border-yellow-500/30"} border rounded-2xl p-3 flex items-center gap-2`}>
            <i class={`w-5 h-5 flex-shrink-0 ${res().failed.length === 0 ? "i-hugeicons-checkmark-circle-02 text-green-400" : "i-hugeicons-alert-02 text-yellow-400"}`} />
            <p class={res().failed.length === 0 ? "text-green-400" : "text-yellow-400"}>
              Восстановлено: {res().repaired} файлов
              <Show when={res().failed.length > 0}>
                <span>, Не удалось: {res().failed.length}</span>
              </Show>
            </p>
          </div>
        )}
      </Show>

      <Show when={!loading() && result()}>
        <>
          {/* Summary */}
          <div class="grid grid-cols-4 gap-3">
            <div class={`rounded-2xl p-3 border ${result()!.valid ? "bg-green-500/10 border-green-500/20" : "bg-red-500/10 border-red-500/20"}`}>
              <div class={`text-2xl font-bold ${result()!.valid ? "text-green-400" : "text-red-400"}`}>
                {result()!.valid ? "OK" : "Ошибки"}
              </div>
              <div class="text-xs text-muted">Статус</div>
            </div>
            <div class="bg-gray-850 border border-gray-750 rounded-2xl p-3">
              <div class="text-2xl font-bold text-white">{result()!.total_files}</div>
              <div class="text-xs text-muted">Всего файлов</div>
            </div>
            <div class="bg-gray-850 border border-gray-750 rounded-2xl p-3">
              <div class="text-2xl font-bold text-green-400">{result()!.valid_files}</div>
              <div class="text-xs text-muted">Корректных</div>
            </div>
            <div class="bg-gray-850 border border-gray-750 rounded-2xl p-3">
              <div class="text-2xl font-bold text-red-400">
                {result()!.corrupted_files.length + result()!.missing_files.length}
              </div>
              <div class="text-xs text-muted">Проблем</div>
            </div>
          </div>

          {/* All OK */}
          <Show when={result()!.valid}>
            <div class="bg-green-500/10 border border-green-500/30 rounded-2xl p-4 flex items-center gap-3">
              <i class="i-hugeicons-checkmark-circle-02 w-5 h-5 text-green-400 flex-shrink-0" />
              <p class="text-green-400 font-medium">
                Все файлы в порядке. Проблем не обнаружено.
              </p>
            </div>
          </Show>

          {/* Corrupted files */}
          <Show when={result()!.corrupted_files.length > 0}>
            <div>
              <div class="flex items-center justify-between mb-2">
                <h3 class="font-semibold text-red-400">
                  Повреждённые файлы ({result()!.corrupted_files.length})
                </h3>
                <button
                  onClick={selectAllRecoverable}
                  class="text-xs text-blue-400 hover:underline"
                >
                  Выбрать все восстанавливаемые
                </button>
              </div>
              <div class="space-y-2 max-h-48 overflow-y-auto pr-1">
                <For each={result()!.corrupted_files}>
                    {(file) => (
                      <div class="bg-red-500/10 border border-red-500/30 rounded-2xl p-2.5 flex items-center gap-2">
                        <Show when={file.recoverable}>
                          <input
                            type="checkbox"
                            checked={selectedFiles().includes(file.path)}
                            onChange={() => toggleFile(file.path)}
                            class="rounded border-gray-600 bg-gray-800 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
                          />
                        </Show>
                        <div class="flex-1 min-w-0">
                          <div class="text-white text-sm truncate" title={file.path}>
                            {file.path}
                          </div>
                          <div class="text-xs text-muted inline-flex items-center gap-2">
                            <span>Размер: {fmtSize(file.size)}</span>
                            <Show when={!file.recoverable}>
                              <span class="text-red-400">Невозможно восстановить</span>
                            </Show>
                          </div>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </Show>

          {/* Missing files */}
          <Show when={result()!.missing_files.length > 0}>
            <div>
              <h3 class="font-semibold text-yellow-400 mb-2">
                Отсутствующие файлы ({result()!.missing_files.length})
              </h3>
              <div class="space-y-2 max-h-48 overflow-y-auto pr-1">
                <For each={result()!.missing_files}>
                    {(file) => (
                      <div class="bg-yellow-500/10 border border-yellow-500/30 rounded-2xl p-2.5 flex items-center gap-2">
                        <Show when={file.recoverable}>
                          <input
                            type="checkbox"
                            checked={selectedFiles().includes(file.path)}
                            onChange={() => toggleFile(file.path)}
                            class="rounded border-gray-600 bg-gray-800 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
                          />
                        </Show>
                        <div class="flex-1 min-w-0">
                          <div class="text-white text-sm truncate" title={file.path}>
                            {file.path}
                          </div>
                          <div class="text-xs text-muted inline-flex items-center gap-2">
                            <span>Ожидаемый размер: {fmtSize(file.expected_size)}</span>
                            <Show when={!file.recoverable}>
                              <span class="text-yellow-400">Невозможно восстановить</span>
                            </Show>
                          </div>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            {/* Repair button */}
            <Show when={selectedFiles().length > 0}>
              <div class="flex items-center justify-between bg-gray-850 border border-gray-750 rounded-2xl p-3">
                <span class="text-muted">
                  Выбрано файлов для восстановления: {selectedFiles().length}
                </span>
                <button
                  onClick={repairFiles}
                  disabled={repairing()}
                  class="btn-primary"
                >
                  <Show when={repairing()} fallback={<i class="i-hugeicons-wrench-01 w-4 h-4" />}>
                    <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                  </Show>
                  Восстановить
                </button>
              </div>
            </Show>

          <Show when={result()!.check_time_ms > 0}>
            <div class="text-xs text-dim">
              Проверка завершена за {result()!.check_time_ms} мс
            </div>
          </Show>
        </>
      </Show>

      <Show when={!result() && !loading() && !error()}>
        <div class="flex-col-center py-12 text-muted">
          <i class="i-hugeicons-checkmark-circle-02 w-12 h-12 mb-3 text-gray-600" />
          <p>Нажмите "Полная проверка" для проверки всех файлов</p>
          <p class="text-sm mt-1">"Быстрая проверка" проверяет только размеры файлов</p>
        </div>
      </Show>
    </div>
  );
}

export default IntegrityChecker;
