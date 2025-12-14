// packages/jobs/src/handlers/continuous/types.ts

import type { Effect } from "effect";
import type {
  ContinuousRequest,
  ContinuousStartResponse,
  ContinuousStopResponse,
  ContinuousTriggerResponse,
  ContinuousStatusResponse,
  ContinuousGetStateResponse,
} from "../../runtime/types";
import type { JobError } from "../../errors";

// =============================================================================
// Handler Response Types
// =============================================================================

/**
 * Union of all continuous response types.
 */
export type ContinuousResponse =
  | ContinuousStartResponse
  | ContinuousStopResponse
  | ContinuousTriggerResponse
  | ContinuousStatusResponse
  | ContinuousGetStateResponse;

// =============================================================================
// Handler Interface
// =============================================================================

/**
 * Continuous handler service interface.
 *
 * Handles all continuous job operations:
 * - start: Initialize and optionally run first execution
 * - stop: Stop and purge
 * - trigger: Trigger immediate execution
 * - status: Get current status
 * - getState: Get current state
 * - handleAlarm: Execute on schedule
 */
export interface ContinuousHandlerI {
  /**
   * Handle a continuous request.
   */
  readonly handle: (
    request: ContinuousRequest
  ) => Effect.Effect<ContinuousResponse, JobError>;

  /**
   * Handle an alarm for this continuous job.
   */
  readonly handleAlarm: () => Effect.Effect<void, JobError>;
}

// =============================================================================
// Internal Types
// =============================================================================

/**
 * Internal state stored alongside user state.
 */
export interface ContinuousInternalState {
  readonly runCount: number;
  readonly lastExecutedAt: number | null;
}
