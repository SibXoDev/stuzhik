import { invoke } from "@tauri-apps/api/core";
import type {
  SolutionFeedback,
  SolutionRating,
  KnowledgeBaseStats,
} from "../types/common.types";
import { createAsyncState, runAsync } from "./useAsyncUtils";

const LOG_PREFIX = "[KnowledgeBase]";

/**
 * Hook для работы с Knowledge Base
 */
export function useKnowledgeBase() {
  const { loading, setLoading, error, setError } = createAsyncState();

  /**
   * Сохранить feedback о решении
   */
  async function saveFeedback(params: {
    problemSignature: string;
    solutionId: string;
    helped: boolean;
    notes?: string;
    instanceId?: string;
  }): Promise<string | null> {
    return runAsync(
      () => invoke<string>("save_solution_feedback", {
        problemSignature: params.problemSignature,
        solutionId: params.solutionId,
        helped: params.helped,
        notes: params.notes,
        instanceId: params.instanceId,
      }),
      { setLoading, setError, logPrefix: LOG_PREFIX }
    );
  }

  /**
   * Получить рейтинг решения
   */
  async function getRating(solutionId: string): Promise<SolutionRating | null> {
    return runAsync(
      () => invoke<SolutionRating | null>("get_solution_rating", { solutionId }),
      { setLoading, setError, logPrefix: LOG_PREFIX }
    );
  }

  /**
   * Получить все feedback для проблемы
   */
  async function getFeedbackForProblem(problemSignature: string): Promise<SolutionFeedback[]> {
    const result = await runAsync(
      () => invoke<SolutionFeedback[]>("get_feedback_for_problem", { problemSignature }),
      { setLoading, setError, logPrefix: LOG_PREFIX }
    );
    return result ?? [];
  }

  /**
   * Получить топ-N решений с лучшим рейтингом
   */
  async function getTopRatedSolutions(limit: number = 10): Promise<SolutionRating[]> {
    const result = await runAsync(
      () => invoke<SolutionRating[]>("get_top_rated_solutions", { limit }),
      { setLoading, logPrefix: LOG_PREFIX }
    );
    return result ?? [];
  }

  /**
   * Получить статистику Knowledge Base
   */
  async function getStats(): Promise<KnowledgeBaseStats | null> {
    return runAsync(
      () => invoke<KnowledgeBaseStats>("get_knowledge_base_stats"),
      { setLoading, setError, logPrefix: LOG_PREFIX }
    );
  }

  /**
   * Очистить старые feedback записи
   */
  async function cleanupOldFeedback(days: number = 90): Promise<number> {
    const result = await runAsync(
      () => invoke<number>("cleanup_old_feedback", { days }),
      { setLoading, setError, logPrefix: LOG_PREFIX }
    );
    return result ?? 0;
  }

  return {
    loading,
    error,
    saveFeedback,
    getRating,
    getFeedbackForProblem,
    getTopRatedSolutions,
    getStats,
    cleanupOldFeedback,
  };
}
