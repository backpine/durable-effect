// packages/workflow-v2/src/primitives/pause-signal.ts

import { Data } from "effect";

/**
 * Reason for pausing workflow execution.
 */
export type PauseReason = "sleep" | "retry";

/**
 * PauseSignal is a special error type that signals the workflow
 * should pause and be resumed later.
 *
 * This is NOT a failure - it's a control flow mechanism.
 * The orchestrator catches this and schedules an alarm.
 */
export class PauseSignal extends Data.TaggedError("PauseSignal")<{
  /** Why the workflow is pausing */
  readonly reason: PauseReason;
  /** When to resume (timestamp ms) */
  readonly resumeAt: number;
  /** Step name that caused pause (for retry) */
  readonly stepName?: string;
  /** Current attempt (for retry) */
  readonly attempt?: number;
}> {
  /**
   * Create a sleep pause signal.
   */
  static sleep(resumeAt: number): PauseSignal {
    return new PauseSignal({ reason: "sleep", resumeAt });
  }

  /**
   * Create a retry pause signal.
   */
  static retry(
    resumeAt: number,
    stepName: string,
    attempt: number
  ): PauseSignal {
    return new PauseSignal({
      reason: "retry",
      resumeAt,
      stepName,
      attempt,
    });
  }
}

/**
 * Check if an error is a PauseSignal.
 */
export function isPauseSignal(error: unknown): error is PauseSignal {
  return error instanceof PauseSignal;
}
