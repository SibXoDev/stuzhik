import { createSignal, createEffect, Show, For } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import type {
  LogAnalysisResult,
  DetectedProblem,
  AutoFix,
  AutoFixResult,
  LogSeverity,
  AnalysisReport,
  ProblemStatus,
} from "../types";
import { useI18n } from "../i18n";
import {
  COPY_FEEDBACK_DURATION_MS,
  FIX_RESULT_DURATION_MS,
  BETWEEN_FIXES_DELAY_MS,
} from "../constants";
import { useSafeTimers } from "../hooks";
import { FeedbackDialog } from "./FeedbackDialog";

// Компонент для отображения кода с кнопкой копирования
function CodeBlock(props: { code: string; maxHeight?: string; class?: string }) {
  const [copied, setCopied] = createSignal(false);
  const { setTimeout: safeTimeout } = useSafeTimers();

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(props.code);
      setCopied(true);
      safeTimeout(() => setCopied(false), COPY_FEEDBACK_DURATION_MS);
    } catch (e) {
      console.error("Failed to copy:", e);
    }
  };

  return (
    <div class={`group ${props.class || ""}`}>
      <pre
        class="p-3 bg-black/30 rounded-2xl text-xs text-gray-300 overflow-x-auto font-mono"
        style={{ "max-height": props.maxHeight || "auto" }}
      >
        {props.code}
      </pre>
      <button
        class="absolute top-2 right-2 p-1.5 bg-gray-700/80 hover:bg-gray-600 rounded text-gray-300 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={copyToClipboard}
      >
        <Show when={copied()} fallback={<i class="i-hugeicons-copy-01 w-4 h-4" />}>
          <i class="i-hugeicons-checkmark-circle-02 w-4 h-4 text-green-400" />
        </Show>
      </button>
    </div>
  );
}

interface LogAnalyzerProps {
  instanceId?: string;
  onClose?: () => void;
}

interface FixPreview {
  problem: DetectedProblem;
  solution: { title: string; description: string; auto_fix: AutoFix };
}

// Helper to properly serialize errors (avoid [object Object])
function serializeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null) {
    // Tauri errors often have a 'message' property
    if ('message' in e && typeof (e as { message: unknown }).message === 'string') {
      return (e as { message: string }).message;
    }
    return JSON.stringify(e);
  }
  return String(e);
}

export function LogAnalyzer(props: LogAnalyzerProps) {
  const { t } = useI18n();
  const { setTimeout: safeTimeout } = useSafeTimers();
  const [loading, setLoading] = createSignal(false);
  const [result, setResult] = createSignal<LogAnalysisResult | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [selectedProblem, setSelectedProblem] = createSignal<DetectedProblem | null>(null);
  const [applyingFix, setApplyingFix] = createSignal<string | null>(null);
  const [viewMode, setViewMode] = createSignal<"analyze" | "view">("analyze");
  const [reportInfo, setReportInfo] = createSignal<{ name?: string; date?: string } | null>(null);
  // Локальное состояние статусов проблем (сохраняется между анализами)
  const [problemStatuses, setProblemStatuses] = createSignal<Record<string, ProblemStatus>>({});
  // Предпросмотр фиксов
  const [showFixPreview, setShowFixPreview] = createSignal(false);
  const [fixPreviews, setFixPreviews] = createSignal<FixPreview[]>([]);
  const [selectedFixes, setSelectedFixes] = createSignal<Set<string>>(new Set());
  // Feedback dialog
  const [showFeedback, setShowFeedback] = createSignal(false);
  const [feedbackData, setFeedbackData] = createSignal<{
    problemSignature: string;
    solutionId: string;
    solutionTitle: string;
  } | null>(null);

  createEffect(() => {
    if (props.instanceId) {
      analyzeInstanceLog(props.instanceId);
    }
  });

  async function analyzeInstanceLog(instanceId: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await invoke<LogAnalysisResult>("analyze_instance_log", {
        instanceId,
      });
      setResult(res);
    } catch (e) {
      setError(serializeError(e));
    } finally {
      setLoading(false);
    }
  }

  async function analyzeFile() {
    const filePath = await open({
      multiple: false,
      filters: [{ name: "Log files", extensions: ["log", "txt"] }],
    });

    if (!filePath) return;

    setLoading(true);
    setError(null);
    setViewMode("analyze");
    setReportInfo(null);
    try {
      const res = await invoke<LogAnalysisResult>("analyze_log_file", {
        path: filePath,
      });
      setResult(res);
    } catch (e) {
      setError(serializeError(e));
    } finally {
      setLoading(false);
    }
  }

  async function exportReport() {
    const res = result();
    if (!res) return;

    const filePath = await save({
      defaultPath: `analysis-${props.instanceId || "log"}-${Date.now()}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });

    if (!filePath) return;

    try {
      const exportData = {
        result: res,
        instanceId: props.instanceId || null,
        exportedAt: new Date().toISOString(),
      };
      await writeTextFile(filePath, JSON.stringify(exportData, null, 2));
    } catch (e) {
      setError(serializeError(e));
    }
  }

  async function exportArchive() {
    if (!props.instanceId) {
      setError(t().logAnalyzer.exportArchiveOnlyInstances);
      return;
    }

    const filePath = await save({
      defaultPath: `logs-${props.instanceId}-${Date.now()}.zip`,
      filters: [{ name: "ZIP Archive", extensions: ["zip"] }],
    });

    if (!filePath) return;

    setLoading(true);
    try {
      await invoke("export_logs_archive", {
        instanceId: props.instanceId,
        outputPath: filePath,
      });
    } catch (e) {
      setError(serializeError(e));
    } finally {
      setLoading(false);
    }
  }

  async function importReport() {
    const filePath = await open({
      multiple: false,
      filters: [{ name: "Analysis Report", extensions: ["json"] }],
    });

    if (!filePath) return;

    setLoading(true);
    setError(null);
    try {
      const report = await invoke<AnalysisReport>("import_analysis", {
        path: filePath,
      });
      setResult(report.result);
      setViewMode("view");
      setReportInfo({
        name: report.instance_name || report.instance_id,
        date: new Date(report.created_at * 1000).toLocaleString(),
      });
    } catch (e) {
      setError(serializeError(e));
    } finally {
      setLoading(false);
    }
  }

  const [fixResult, setFixResult] = createSignal<AutoFixResult | null>(null);

  async function applyAutoFix(fix: AutoFix, problemId: string, solutionTitle?: string) {
    if (!props.instanceId) {
      setError(t().logAnalyzer.instanceNotSelected);
      return;
    }

    setApplyingFix(problemId);
    setFixResult(null);
    try {
      const fixResult = await invoke<AutoFixResult>("apply_auto_fix_command", {
        instanceId: props.instanceId,
        fix,
      });

      setFixResult(fixResult);

      // Обновляем статус проблемы локально
      if (fixResult.success) {
        setProblemStatuses(prev => ({
          ...prev,
          [problemId]: fixResult.requires_restart ? "awaiting_restart" : "resolved"
        }));

        // Show feedback dialog for successful fix (not for optimizations)
        if (problemId !== "optimization" && solutionTitle) {
          setFeedbackData({
            problemSignature: problemId,
            solutionId: `${problemId}-${fix.type}`,
            solutionTitle,
          });
          // Show feedback dialog after a brief delay
          safeTimeout(() => setShowFeedback(true), FIX_RESULT_DURATION_MS + 500);
        }
      } else {
        setProblemStatuses(prev => ({
          ...prev,
          [problemId]: "failed"
        }));
      }

      // Автоматически скрываем уведомление
      safeTimeout(() => setFixResult(null), FIX_RESULT_DURATION_MS);
    } catch (e) {
      setError(serializeError(e));
      setProblemStatuses(prev => ({
        ...prev,
        [problemId]: "failed"
      }));
    } finally {
      setApplyingFix(null);
    }
  }

  function showFixAllPreview() {
    if (!props.instanceId || !result()) {
      return;
    }

    // Собираем все проблемы с auto_fix решениями (ещё не исправленные)
    const fixableProblems = result()!.problems.filter(problem => {
      const status = getProblemStatus(problem);
      const hasAutoFix = problem.solutions.some(s => s.auto_fix);
      return hasAutoFix && status === "detected";
    });

    if (fixableProblems.length === 0) {
      setError(t().logAnalyzer.noFixableProblems);
      return;
    }

    // Создаем превью для каждой проблемы
    const previews: FixPreview[] = fixableProblems.map(problem => {
      const solution = problem.solutions.find(s => s.auto_fix)!;
      return {
        problem,
        solution: {
          title: solution.title,
          description: solution.description,
          auto_fix: solution.auto_fix!
        }
      };
    });

    setFixPreviews(previews);
    // По умолчанию выбираем все фиксы
    setSelectedFixes(new Set(previews.map((_, idx) => idx.toString())));
    setShowFixPreview(true);
  }

  async function applySelectedFixes() {
    const selected = selectedFixes();
    const previews = fixPreviews();

    if (selected.size === 0) {
      setError(t().logAnalyzer.noFixableProblems);
      return;
    }

    setShowFixPreview(false);

    // Применяем выбранные фиксы последовательно
    for (let i = 0; i < previews.length; i++) {
      if (selected.has(i.toString())) {
        const preview = previews[i];
        await applyAutoFix(preview.solution.auto_fix, preview.problem.id, preview.solution.title);
        // Небольшая задержка между фиксами
        await new Promise<void>(resolve => safeTimeout(() => resolve(), BETWEEN_FIXES_DELAY_MS));
      }
    }
  }

  // Получить статус проблемы (локальный или из данных)
  function getProblemStatus(problem: DetectedProblem): ProblemStatus {
    return problemStatuses()[problem.id] || problem.status || "detected";
  }

  function getStatusLabel(status: ProblemStatus | undefined): string {
    if (!status) return "";
    switch (status) {
      case "awaiting_restart": return t().autoFix.status.awaitingRestart;
      case "resolved": return t().autoFix.status.resolved;
      case "failed": return t().autoFix.status.failed;
      default: return "";
    }
  }

  function getStatusColor(status: ProblemStatus): string {
    switch (status) {
      case "awaiting_restart": return "bg-yellow-500/20 text-yellow-400 border-yellow-500/30";
      case "resolved": return "bg-green-500/20 text-green-400 border-green-500/30";
      case "failed": return "bg-red-500/20 text-red-400 border-red-500/30";
      default: return "";
    }
  }

  function getSeverityColor(severity: LogSeverity): string {
    switch (severity) {
      case "critical":
        return "bg-red-600";
      case "error":
        return "bg-red-500";
      case "warning":
        return "bg-yellow-500";
      case "info":
        return "bg-blue-500";
      default:
        return "bg-gray-500";
    }
  }

  function getSeverityBorder(severity: LogSeverity): string {
    switch (severity) {
      case "critical":
        return "border-red-600/50 bg-red-500/5";
      case "error":
        return "border-red-500/40 bg-red-500/5";
      case "warning":
        return "border-yellow-500/40 bg-yellow-500/5";
      case "info":
        return "border-blue-500/40 bg-blue-500/5";
      default:
        return "border-gray-600";
    }
  }

  function getSeverityLabel(severity: LogSeverity): string {
    switch (severity) {
      case "critical":
        return "CRITICAL";
      case "error":
        return "ERROR";
      case "warning":
        return "WARN";
      case "info":
        return "INFO";
    }
  }

  function getDifficultyLabel(difficulty: string): string {
    switch (difficulty) {
      case "easy":
        return t().logAnalyzer.difficulty.easy;
      case "medium":
        return t().logAnalyzer.difficulty.medium;
      case "hard":
        return t().logAnalyzer.difficulty.hard;
      case "expert":
        return t().logAnalyzer.difficulty.expert;
      default:
        return difficulty;
    }
  }

  function getDifficultyColor(difficulty: string): string {
    switch (difficulty) {
      case "easy":
        return "text-green-400";
      case "medium":
        return "text-yellow-400";
      case "hard":
        return "text-orange-400";
      case "expert":
        return "text-red-400";
      default:
        return "text-gray-400";
    }
  }

  function getAutoFixLabel(fix: AutoFix): string {
    const autoFixTypes = t().autoFix.types;
    switch (fix.type) {
      case "remove_mod":
        return `${autoFixTypes.removeMod}: ${fix.filename}`;
      case "download_mod":
        return `${autoFixTypes.downloadMod}: ${fix.name}`;
      case "increase_ram":
        return `${autoFixTypes.increaseRam}: ${fix.recommended_mb} MB`;
      case "delete_config":
        return autoFixTypes.deleteConfig;
      case "reset_configs":
        return autoFixTypes.resetConfigs;
      case "install_java":
        return `${autoFixTypes.installJava} ${fix.version}`;
      case "verify_files":
        return autoFixTypes.verifyFiles;
      case "change_jvm_arg":
        return autoFixTypes.changeJvmArg;
      case "update_loader":
        return autoFixTypes.updateLoader;
      case "reinstall_mod":
        return `${autoFixTypes.reinstallMod}: ${fix.filename}`;
      default:
        return t().logAnalyzer.apply;
    }
  }

  return (
    <div class="flex flex-col gap-4">
      {/* View mode indicator */}
      <Show when={viewMode() === "view" && reportInfo()}>
        <div class="bg-blue-500/10 border border-blue-500/30 rounded-2xl px-3 py-2 flex items-center justify-between">
          <div class="flex items-center gap-2 text-sm">
            <i class="i-hugeicons-file-01 w-4 h-4 text-blue-400" />
            <span class="text-blue-400">{t().logAnalyzer.viewMode}</span>
            <span class="text-white">{reportInfo()?.name || t().logAnalyzer.report}</span>
            <span class="text-muted">({reportInfo()?.date})</span>
          </div>
          <button
            onClick={() => { setViewMode("analyze"); setReportInfo(null); setResult(null); }}
            class="btn-ghost"
            data-size="sm"
          >
            <i class="i-hugeicons-cancel-01 w-4 h-4" />
          </button>
        </div>
      </Show>

      {/* Actions */}
      <div class="flex items-center gap-2 flex-wrap">
        <button
          onClick={analyzeFile}
          disabled={loading()}
          class="btn-ghost"
          data-size="sm"
        >
          <i class="i-hugeicons-folder-open w-4 h-4" />
          {t().logAnalyzer.openFile}
        </button>
        <button
          onClick={importReport}
          disabled={loading()}
          class="btn-ghost"
          data-size="sm"
        >
          <i class="i-hugeicons-upload-02 w-4 h-4" />
          {t().logAnalyzer.import}
        </button>
        <Show when={props.instanceId && viewMode() === "analyze"}>
          <button
            onClick={() => { setViewMode("analyze"); setReportInfo(null); analyzeInstanceLog(props.instanceId!); }}
            disabled={loading()}
            class="btn-primary"
            data-size="sm"
          >
            <Show when={loading()} fallback={<i class="i-hugeicons-refresh w-4 h-4" />}>
              <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
            </Show>
            {t().logAnalyzer.analyze}
          </button>
        </Show>
        <Show when={result()}>
          <button
            onClick={exportReport}
            class="btn-ghost"
            data-size="sm"
            title={t().logAnalyzer.export}
          >
            <i class="i-hugeicons-file-01 w-4 h-4" />
            {t().logAnalyzer.export}
          </button>
        </Show>
        <Show when={result() && props.instanceId}>
          <button
            onClick={exportArchive}
            class="btn-ghost"
            data-size="sm"
            disabled={loading()}
            title={t().logAnalyzer.archive}
          >
            <i class="i-hugeicons-file-download w-4 h-4" />
            {t().logAnalyzer.archive}
          </button>
        </Show>
      </div>

      <Show when={loading()}>
        <div class="flex-col-center py-12">
          <i class="i-svg-spinners-6-dots-scale w-8 h-8 mb-3" />
          <span class="text-muted">{t().logAnalyzer.analyzing}</span>
        </div>
      </Show>

      <Show when={error()}>
        <div class="bg-red-500/10 border border-red-500/30 rounded-2xl p-3">
          <p class="text-red-400 text-sm">{error()}</p>
        </div>
      </Show>

      {/* Auto-fix Result Notification */}
      <Show when={fixResult()}>
        {(result) => (
          <div
            class={`border rounded-2xl p-3 flex items-start gap-3 transition-colors ${
              result().success
                ? "bg-green-500/10 border-green-500/30"
                : "bg-red-500/10 border-red-500/30"
            }`}
          >
            <i
              class={`w-5 h-5 flex-shrink-0 mt-0.5 ${
                result().success
                  ? "i-hugeicons-checkmark-circle-02 text-green-400"
                  : "i-hugeicons-alert-02 text-red-400"
              }`}
            />
            <div class="flex-1 min-w-0">
              <p class={`font-medium ${result().success ? "text-green-400" : "text-red-400"}`}>
                {result().message}
              </p>
              <Show when={result().details}>
                <p class="text-sm text-muted mt-1">{result().details}</p>
              </Show>
              <Show when={result().requires_restart}>
                <p class="text-sm text-yellow-400 mt-1 flex items-center gap-1">
                  <i class="i-hugeicons-refresh w-4 h-4" />
                  {t().autoFix.requiresRestart}
                </p>
              </Show>
            </div>
            <button
              class="btn-ghost flex-shrink-0"
              data-icon-only="true"
              data-size="sm"
              onClick={() => setFixResult(null)}
            >
              <i class="i-hugeicons-cancel-01 w-4 h-4" />
            </button>
          </div>
        )}
      </Show>

      <Show when={!loading() && result()}>
        <>
          {/* Summary */}
          <div class="grid grid-cols-4 gap-3">
            <div class="bg-gray-850 border border-gray-750 rounded-2xl p-3">
              <div class="text-2xl font-bold text-white">
                {result()!.summary.total_lines.toLocaleString()}
              </div>
              <div class="text-xs text-muted">{t().logAnalyzer.lines}</div>
            </div>
            <div class="bg-red-500/10 border border-red-500/20 rounded-2xl p-3">
              <div class="text-2xl font-bold text-red-400">
                {result()!.summary.critical_count}
              </div>
              <div class="text-xs text-muted">{t().logAnalyzer.critical}</div>
            </div>
            <div class="bg-orange-500/10 border border-orange-500/20 rounded-2xl p-3">
              <div class="text-2xl font-bold text-orange-400">
                {result()!.summary.error_count}
              </div>
              <div class="text-xs text-muted">{t().logAnalyzer.errors}</div>
            </div>
            <div class="bg-yellow-500/10 border border-yellow-500/20 rounded-2xl p-3">
              <div class="text-2xl font-bold text-yellow-400">
                {result()!.summary.warning_count}
              </div>
              <div class="text-xs text-muted">{t().logAnalyzer.warnings}</div>
            </div>
          </div>

          {/* Crash Info */}
          <Show when={result()!.crash_info}>
            {(crash) => (
              <div class="bg-red-500/10 border border-red-500/30 rounded-2xl p-4 flex items-start gap-3">
                <i class="i-hugeicons-alert-02 w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
                <div class="flex-1 min-w-0">
                  <h3 class="font-bold text-red-400 mb-2">{t().logAnalyzer.crashDetected}</h3>
                  <p class="text-white mb-2">{crash().main_cause}</p>
                  <Show when={crash().culprit_mod}>
                    <p class="text-yellow-400 text-sm">
                      {t().logAnalyzer.possibleCulprit}: <strong>{crash().culprit_mod}</strong>
                    </p>
                  </Show>
                  <Show when={crash().stack_trace.length > 0}>
                    <details class="mt-3">
                      <summary class="text-muted cursor-pointer text-sm hover:text-white transition-colors">
                        {t().logAnalyzer.stackTrace} ({crash().stack_trace.length} {t().logAnalyzer.lines.toLowerCase()})
                      </summary>
                      <CodeBlock code={crash().stack_trace.join("\n")} maxHeight="10rem" class="mt-2" />
                    </details>
                  </Show>
                </div>
              </div>
            )}
          </Show>

          {/* Problems List */}
          <Show when={result()!.problems.length > 0}>
            <div>
              <div class="flex items-center justify-between mb-3">
                <h3 class="font-semibold text-white">
                  {t().logAnalyzer.detectedProblems} ({result()!.problems.length})
                </h3>
                <Show when={result()!.problems.some(p => {
                  const status = getProblemStatus(p);
                  return p.solutions.some(s => s.auto_fix) && status === "detected";
                }) && viewMode() === "analyze"}>
                  <button
                    onClick={showFixAllPreview}
                    disabled={applyingFix() !== null}
                    class="btn-primary flex items-center gap-2"
                    data-size="sm"
                  >
                    <i class="i-hugeicons-wrench-01 w-4 h-4" />
                    <span>{t().logAnalyzer.fixAllProblems}</span>
                  </button>
                </Show>
              </div>
              <div class="flex flex-col gap-2">
                <For each={result()!.problems}>
                    {(problem) => {
                      const status = () => getProblemStatus(problem);
                      const isFixed = () => status() !== "detected";

                      return (
                        <div
                          class={`border rounded-2xl p-3 cursor-pointer transition-colors duration-100 ${
                            isFixed() ? getStatusColor(status()) : getSeverityBorder(problem.severity)
                          } ${
                            selectedProblem()?.id === problem.id
                              ? "ring-2 ring-blue-500"
                              : "hover:border-gray-500"
                          }`}
                          onClick={() => setSelectedProblem(problem)}
                        >
                          <div class="flex items-start gap-2">
                            <span
                              class={`${getSeverityColor(problem.severity)} px-1.5 py-0.5 rounded text-xs font-medium text-white flex-shrink-0`}
                            >
                              {getSeverityLabel(problem.severity)}
                            </span>
                            <div class="flex-1 min-w-0">
                              <div class="flex items-center gap-2">
                                <span class="font-medium text-white truncate">
                                  {problem.title}
                                </span>
                                <Show when={isFixed()}>
                                  <span class={`px-1.5 py-0.5 rounded text-xs font-medium flex items-center gap-1 ${
                                    status() === "awaiting_restart" ? "bg-yellow-500/20 text-yellow-400" :
                                    status() === "resolved" ? "bg-green-500/20 text-green-400" :
                                    "bg-red-500/20 text-red-400"
                                  }`}>
                                    <i class={`w-3 h-3 ${
                                      status() === "awaiting_restart" ? "i-hugeicons-clock-01" :
                                      status() === "resolved" ? "i-hugeicons-checkmark-circle-02" :
                                      "i-hugeicons-alert-02"
                                    }`} />
                                    {getStatusLabel(status())}
                                  </span>
                                </Show>
                              </div>
                              <div class="text-sm text-muted line-clamp-2 mt-0.5">
                                {problem.description}
                              </div>
                            </div>
                          </div>

                          <Show when={problem.solutions.length > 0 && viewMode() === "analyze" && !isFixed()}>
                            <div class="mt-2 flex gap-2 flex-wrap">
                              <For each={problem.solutions.slice(0, 2)}>
                                {(solution) => (
                                  <Show when={solution.auto_fix}>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        applyAutoFix(solution.auto_fix!, problem.id, solution.title);
                                      }}
                                      disabled={applyingFix() === problem.id}
                                      class="px-2 py-1 bg-green-600/80 hover:bg-green-600 disabled:bg-green-800 rounded text-xs flex items-center gap-1.5 transition-colors"
                                    >
                                      <Show
                                        when={applyingFix() === problem.id}
                                        fallback={
                                          <>
                                            <i class="i-hugeicons-checkmark-circle-02 w-3 h-3" />
                                            <span>{solution.title}</span>
                                          </>
                                        }
                                      >
                                        <i class="i-svg-spinners-6-dots-scale w-3 h-3" />
                                      </Show>
                                    </button>
                                  </Show>
                                )}
                              </For>
                            </div>
                          </Show>
                        </div>
                      );
                    }}
                  </For>
                </div>
              </div>
            </Show>

          {/* No problems */}
          <Show when={result()!.problems.length === 0 && !result()!.crash_info}>
            <div class="bg-green-500/10 border border-green-500/30 rounded-2xl p-4">
              <div class="flex items-center gap-3">
                <i class="i-hugeicons-checkmark-circle-02 w-5 h-5 text-green-400" />
                <p class="text-green-400 font-medium">
                  {t().logAnalyzer.noProblems}
                </p>
              </div>
            </div>
          </Show>

          {/* Optimizations */}
          <Show when={result()!.optimizations.length > 0}>
            <div>
              <h3 class="font-semibold text-white mb-3">{t().logAnalyzer.optimizations}</h3>
              <div class="flex flex-col gap-2">
                <For each={result()!.optimizations}>
                  {(opt) => (
                    <div class="bg-blue-500/10 border border-blue-500/30 rounded-2xl p-3">
                      <div class="flex items-center justify-between gap-3">
                        <div class="flex-1 min-w-0">
                          <div class="font-medium text-white">{opt.title}</div>
                          <div class="text-sm text-muted mt-0.5">{opt.description}</div>
                          <div class="text-xs text-blue-400 mt-1">
                            {opt.impact}
                          </div>
                        </div>
                        <Show when={opt.auto_fix && viewMode() === "analyze"}>
                          <button
                            onClick={() => applyAutoFix(opt.auto_fix!, "optimization")}
                            disabled={applyingFix() === "optimization"}
                            class="btn-primary flex-shrink-0"
                            data-size="sm"
                          >
                            {t().logAnalyzer.apply}
                          </button>
                        </Show>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </Show>

          <div class="text-xs text-dim">
            {t().logAnalyzer.completedIn} {result()!.summary.parse_time_ms} {t().logAnalyzer.ms}
          </div>
        </>
      </Show>

      <Show when={!result() && !loading() && !error()}>
        <div class="flex-col-center py-12 text-muted">
          <i class="i-hugeicons-file-view w-12 h-12 mb-3 text-gray-600" />
          <p>{t().logAnalyzer.clickToAnalyze}</p>
        </div>
      </Show>

      {/* Problem Details Modal */}
      <Show when={selectedProblem()}>
        {(problem) => (
          <div
            class="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[60] p-4"
            onClick={() => setSelectedProblem(null)}
          >
            <div
              class="card max-w-2xl w-full max-h-[80vh] overflow-y-auto animate-in fade-in zoom-in-95 duration-100"
              onClick={(e) => e.stopPropagation()}
            >
              <div class="flex items-center justify-between mb-4">
                <div class="flex items-center gap-2">
                  <span
                    class={`${getSeverityColor(problem().severity)} px-2 py-0.5 rounded text-xs font-medium text-white`}
                  >
                    {getSeverityLabel(problem().severity)}
                  </span>
                  <h3 class="font-bold text-white">{problem().title}</h3>
                </div>
                <button
                  class="btn-close"
                  onClick={() => setSelectedProblem(null)}
                >
                  <i class="i-hugeicons-cancel-01 w-5 h-5" />
                </button>
              </div>

              <div class="space-y-4">
                <div>
                  <h4 class="text-sm font-medium text-muted mb-1">{t().logAnalyzer.description}</h4>
                  <p class="text-white">{problem().description}</p>
                </div>

                <Show when={problem().log_line}>
                  <div>
                    <h4 class="text-sm font-medium text-muted mb-1">
                      {t().logAnalyzer.logLine} {problem().line_number ? `(#${problem().line_number})` : ""}
                    </h4>
                    <CodeBlock code={problem().log_line!} />
                  </div>
                </Show>

                <Show when={problem().related_mods.length > 0}>
                  <div>
                    <h4 class="text-sm font-medium text-muted mb-1">{t().logAnalyzer.relatedMods}</h4>
                    <div class="flex gap-2 flex-wrap">
                      <For each={problem().related_mods}>
                        {(mod) => (
                          <span class="badge">
                            {mod}
                          </span>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>

                <div>
                  <h4 class="text-sm font-medium text-muted mb-2">{t().logAnalyzer.solutions}</h4>
                  <div class="flex flex-col gap-2">
                    <For each={problem().solutions}>
                      {(solution) => (
                        <div class="bg-gray-850 border border-gray-750 rounded-2xl p-3">
                          <div class="flex items-start justify-between gap-2">
                            <div class="flex-1">
                              <div class="font-medium text-white">{solution.title}</div>
                              <div class="text-sm text-muted mt-0.5">{solution.description}</div>
                              <div class="flex items-center gap-3 mt-2 text-xs">
                                <span class={getDifficultyColor(solution.difficulty)}>
                                  {getDifficultyLabel(solution.difficulty)}
                                </span>
                                <span class="text-dim">
                                  {t().logAnalyzer.successRate}: {solution.success_rate}%
                                </span>
                              </div>
                            </div>
                            <Show when={solution.auto_fix && viewMode() === "analyze"}>
                              <button
                                onClick={() => applyAutoFix(solution.auto_fix!, problem().id, solution.title)}
                                disabled={applyingFix() === problem().id}
                                class="btn-primary flex-shrink-0"
                                data-size="sm"
                              >
                                {getAutoFixLabel(solution.auto_fix!)}
                              </button>
                            </Show>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </div>

                <Show when={problem().docs_links.length > 0}>
                  <div>
                    <h4 class="text-sm font-medium text-muted mb-1">{t().logAnalyzer.documentation}</h4>
                    <div class="space-y-1">
                      <For each={problem().docs_links}>
                        {(link) => (
                          <a
                            href={link}
                            target="_blank"
                            rel="noopener noreferrer"
                            class="text-blue-400 hover:underline text-sm block"
                          >
                            {link}
                          </a>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>
              </div>
            </div>
          </div>
        )}
      </Show>

      {/* Fix Preview Modal */}
      <Show when={showFixPreview()}>
        <div class="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-auto">
          {/* Backdrop */}
          <div
            class="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setShowFixPreview(false)}
          />

          {/* Modal Content */}
          <div class="bg-gray-850 border border-gray-750 rounded-2xl max-w-3xl w-full max-h-[80vh] overflow-hidden flex flex-col pointer-events-auto">
            {/* Header */}
            <div class="flex items-center justify-between p-4 border-b border-gray-750">
              <div>
                <h2 class="text-lg font-semibold text-white">
                  {t().logAnalyzer.fixPreview}
                </h2>
                <p class="text-sm text-gray-400 mt-1">
                  {t().logAnalyzer.selectFixesToApply}
                </p>
              </div>
              <button
                onClick={() => setShowFixPreview(false)}
                class="btn-close"
              >
                <i class="i-hugeicons-cancel-01 w-5 h-5" />
              </button>
            </div>

            {/* Fixes List */}
            <div class="flex-1 overflow-y-auto p-4 space-y-3">
              <For each={fixPreviews()}>
                {(preview, index) => {
                  const isSelected = () => selectedFixes().has(index().toString());

                  const toggleFix = () => {
                    const newSelected = new Set(selectedFixes());
                    const key = index().toString();
                    if (newSelected.has(key)) {
                      newSelected.delete(key);
                    } else {
                      newSelected.add(key);
                    }
                    setSelectedFixes(newSelected);
                  };

                  return (
                    <div
                      class={`border rounded-2xl p-3 cursor-pointer transition-colors duration-100 ${
                        isSelected()
                          ? "border-blue-500/50 bg-blue-500/5"
                          : "border-gray-700 hover:border-gray-600"
                      }`}
                      onClick={toggleFix}
                    >
                      <div class="flex items-start gap-3">
                        {/* Checkbox */}
                        <div class="pt-0.5">
                          <div
                            class={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
                              isSelected()
                                ? "border-blue-500 bg-blue-500"
                                : "border-gray-600"
                            }`}
                          >
                            <Show when={isSelected()}>
                              <i class="i-hugeicons-checkmark-circle-02 w-4 h-4 text-white" />
                            </Show>
                          </div>
                        </div>

                        {/* Problem + Solution Info */}
                        <div class="flex-1 min-w-0">
                          {/* Problem */}
                          <div class="mb-2">
                            <div class="flex items-center gap-2 mb-1">
                              <span class={`${getSeverityColor(preview.problem.severity)} px-1.5 py-0.5 rounded text-xs font-medium text-white`}>
                                {getSeverityLabel(preview.problem.severity)}
                              </span>
                              <span class="font-medium text-white">
                                {preview.problem.title}
                              </span>
                            </div>
                            <p class="text-sm text-gray-400">
                              {preview.problem.description}
                            </p>
                          </div>

                          {/* Arrow */}
                          <div class="flex items-center gap-2 my-2">
                            <div class="h-px flex-1 bg-gray-700" />
                            <i class="i-hugeicons-arrow-down-01 w-4 h-4 text-gray-500" />
                            <div class="h-px flex-1 bg-gray-700" />
                          </div>

                          {/* Solution */}
                          <div class="bg-green-500/10 border border-green-500/30 rounded-2xl p-2 flex items-start gap-2">
                            <i class="i-hugeicons-checkmark-circle-02 w-4 h-4 text-green-400 flex-shrink-0" />
                            <div class="flex-1 min-w-0">
                              <span class="font-medium text-green-400 text-sm block mb-1">
                                {preview.solution.title}
                              </span>
                              <p class="text-xs text-gray-300">
                                {preview.solution.description}
                              </p>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                }}
              </For>
            </div>

            {/* Footer */}
            <div class="flex items-center justify-between p-4 border-t border-gray-750">
              <div class="text-sm text-gray-400">
                {t().logAnalyzer.selectedCount}: {selectedFixes().size} / {fixPreviews().length}
              </div>
              <div class="flex items-center gap-2">
                <button
                  onClick={() => setShowFixPreview(false)}
                  class="px-4 py-2 text-sm rounded hover:bg-gray-700 transition-colors text-gray-300"
                >
                  {t().common.cancel}
                </button>
                <button
                  onClick={applySelectedFixes}
                  disabled={selectedFixes().size === 0}
                  class="btn-primary"
                  data-size="sm"
                >
                  <i class="i-hugeicons-wrench-01 w-4 h-4" />
                  <span>{t().logAnalyzer.applySelected} ({selectedFixes().size})</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </Show>

      {/* Feedback Dialog */}
      <FeedbackDialog
        open={showFeedback()}
        onClose={() => {
          setShowFeedback(false);
          setFeedbackData(null);
        }}
        problemSignature={feedbackData()?.problemSignature || ""}
        solutionId={feedbackData()?.solutionId || ""}
        solutionTitle={feedbackData()?.solutionTitle || ""}
        instanceId={props.instanceId}
      />
    </div>
  );
}

export default LogAnalyzer;
