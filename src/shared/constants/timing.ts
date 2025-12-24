/**
 * Centralized timing constants for UI operations.
 * Extract magic numbers to named constants for better maintainability.
 */

/** Duration to show success/notification messages (ms) */
export const NOTIFICATION_DURATION_MS = 2000;

/** Duration to show fix result notifications (ms) */
export const FIX_RESULT_DURATION_MS = 8000;

/** Delay between sequential fix operations (ms) */
export const BETWEEN_FIXES_DELAY_MS = 500;

/** Duration for delete confirmation timeout (ms) */
export const DELETE_CONFIRM_TIMEOUT_MS = 3000;

/** Delay for auto-updater ready callback (ms) */
export const AUTOUPDATER_READY_DELAY_MS = 1500;

/** Copy to clipboard feedback duration (ms) */
export const COPY_FEEDBACK_DURATION_MS = 2000;
