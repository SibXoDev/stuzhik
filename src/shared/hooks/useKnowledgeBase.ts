import { invoke } from "@tauri-apps/api/core";
import { createSignal } from "solid-js";
import type {
  SolutionFeedback,
  SolutionRating,
  KnowledgeBaseStats,
} from "../types/common.types";

/**
 * Hook для работы с Knowledge Base
 */
export function useKnowledgeBase() {
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

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
    setLoading(true);
    setError(null);

    try {
      const feedbackId = await invoke<string>("save_solution_feedback", {
        problemSignature: params.problemSignature,
        solutionId: params.solutionId,
        helped: params.helped,
        notes: params.notes,
        instanceId: params.instanceId,
      });

      return feedbackId;
    } catch (e) {
      const errorMsg =
        e instanceof Error ? e.message : "Failed to save feedback";
      setError(errorMsg);
      console.error("Save feedback error:", e);
      return null;
    } finally {
      setLoading(false);
    }
  }

  /**
   * Получить рейтинг решения
   */
  async function getRating(
    solutionId: string
  ): Promise<SolutionRating | null> {
    setLoading(true);
    setError(null);

    try {
      const rating = await invoke<SolutionRating | null>(
        "get_solution_rating",
        {
          solutionId,
        }
      );

      return rating;
    } catch (e) {
      const errorMsg =
        e instanceof Error ? e.message : "Failed to get rating";
      setError(errorMsg);
      console.error("Get rating error:", e);
      return null;
    } finally {
      setLoading(false);
    }
  }

  /**
   * Получить все feedback для проблемы
   */
  async function getFeedbackForProblem(
    problemSignature: string
  ): Promise<SolutionFeedback[]> {
    setLoading(true);
    setError(null);

    try {
      const feedback = await invoke<SolutionFeedback[]>(
        "get_feedback_for_problem",
        {
          problemSignature,
        }
      );

      return feedback;
    } catch (e) {
      const errorMsg =
        e instanceof Error ? e.message : "Failed to get feedback";
      setError(errorMsg);
      console.error("Get feedback error:", e);
      return [];
    } finally {
      setLoading(false);
    }
  }

  /**
   * Получить топ-N решений с лучшим рейтингом
   */
  async function getTopRatedSolutions(
    limit: number = 10
  ): Promise<SolutionRating[]> {
    setLoading(true);
    setError(null);

    try {
      const ratings = await invoke<SolutionRating[]>(
        "get_top_rated_solutions",
        {
          limit,
        }
      );

      return ratings;
    } finally {
      setLoading(false);
    }
  }

  /**
   * Получить статистику Knowledge Base
   */
  async function getStats(): Promise<KnowledgeBaseStats | null> {
    setLoading(true);
    setError(null);

    try {
      const stats = await invoke<KnowledgeBaseStats>(
        "get_knowledge_base_stats"
      );

      return stats;
    } catch (e) {
      const errorMsg =
        e instanceof Error ? e.message : "Failed to get stats";
      setError(errorMsg);
      console.error("Get stats error:", e);
      return null;
    } finally {
      setLoading(false);
    }
  }

  /**
   * Очистить старые feedback записи
   */
  async function cleanupOldFeedback(days: number = 90): Promise<number> {
    setLoading(true);
    setError(null);

    try {
      const deleted = await invoke<number>("cleanup_old_feedback", {
        days,
      });

      return deleted;
    } catch (e) {
      const errorMsg =
        e instanceof Error ? e.message : "Failed to cleanup feedback";
      setError(errorMsg);
      console.error("Cleanup feedback error:", e);
      return 0;
    } finally {
      setLoading(false);
    }
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
