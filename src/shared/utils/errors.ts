/**
 * Extract human-readable error message from various error types
 * Handles: Error objects, Tauri error objects, strings, and unknown types
 */
export function extractErrorMessage(error: unknown): string {
  // Standard Error object
  if (error instanceof Error) {
    return error.message;
  }

  // String
  if (typeof error === 'string') {
    return error;
  }

  // Tauri error object: { code, message, details, recovery_hint }
  if (error && typeof error === 'object') {
    const obj = error as Record<string, unknown>;

    // Priority: details > message > code
    if (typeof obj.details === 'string' && obj.details) {
      return obj.details;
    }
    if (typeof obj.message === 'string' && obj.message) {
      return obj.message;
    }
    if (typeof obj.code === 'string' && obj.code) {
      return obj.code;
    }

    // Try to serialize if nothing else works
    try {
      const json = JSON.stringify(error);
      if (json !== '{}') {
        return json;
      }
    } catch {
      // Ignore serialization errors
    }
  }

  return 'Unknown error';
}

/**
 * Tauri error structure
 */
export interface TauriError {
  code: string;
  message: string;
  details?: string;
  recovery_hint?: string;
}

/**
 * Check if error is a Tauri error object
 */
export function isTauriError(error: unknown): error is TauriError {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    'message' in error
  );
}
