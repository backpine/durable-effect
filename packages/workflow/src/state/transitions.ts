// packages/workflow-v2/src/state/transitions.ts

import type { StatusTag, TransitionTag } from "./types";

/**
 * Valid transitions from each status.
 *
 * This matrix is the source of truth for allowed state changes.
 * Any transition not in this matrix will be rejected.
 */
export const VALID_TRANSITIONS: Record<StatusTag, readonly TransitionTag[]> = {
  // Pending: Can start immediately or queue for later
  Pending: ["Start", "Queue"],

  // Queued: Can start when alarm fires, or cancel
  Queued: ["Start", "Cancel"],

  // Running: Can complete, pause, fail, cancel, or recover (from interrupt)
  Running: ["Complete", "Pause", "Fail", "Cancel", "Recover"],

  // Paused: Can resume when alarm fires, cancel, or recover (from interrupt)
  Paused: ["Resume", "Cancel", "Recover"],

  // Terminal states: No transitions allowed
  Completed: [],
  Failed: [],
  Cancelled: [],
} as const;

/**
 * Check if a transition is valid from a given status.
 */
export function isValidTransition(
  fromStatus: StatusTag,
  transition: TransitionTag
): boolean {
  return VALID_TRANSITIONS[fromStatus].includes(transition);
}

/**
 * Get all valid transitions from a status.
 */
export function getValidTransitions(fromStatus: StatusTag): readonly TransitionTag[] {
  return VALID_TRANSITIONS[fromStatus];
}

/**
 * Check if a status is terminal (no further transitions).
 */
export function isTerminalStatus(status: StatusTag): boolean {
  return VALID_TRANSITIONS[status].length === 0;
}

/**
 * Check if a status is recoverable (can apply Recover transition).
 */
export function isRecoverableStatus(status: StatusTag): boolean {
  return VALID_TRANSITIONS[status].includes("Recover");
}
