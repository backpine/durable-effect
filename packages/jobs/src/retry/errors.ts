// packages/jobs/src/retry/errors.ts

import { Data } from "effect";

/**
 * Error when all retry attempts are exhausted.
 */
export class RetryExhaustedError extends Data.TaggedError("RetryExhaustedError")<{
  readonly jobType: "continuous" | "debounce";
  readonly jobName: string;
  readonly instanceId: string;
  readonly attempts: number;
  readonly lastError: unknown;
  readonly reason: "max_attempts_exceeded" | "max_duration_exceeded";
}> {
  get message(): string {
    return `Job "${this.jobName}" failed after ${this.attempts} attempts: ${this.reason}`;
  }
}

/**
 * Signal that a retry has been scheduled.
 * This is a control flow signal, not an error - caught by handlers.
 */
export class RetryScheduledSignal extends Data.TaggedError("RetryScheduledSignal")<{
  readonly resumeAt: number;
  readonly attempt: number;
}> {}
