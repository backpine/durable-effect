// packages/jobs/src/retry/errors.ts

import { Data } from "effect";
import type { RetryExhaustedInfo } from "./types";

/**
 * Signal that all retry attempts have been exhausted.
 *
 * This is a control flow signal, not a true error. It's caught by
 * JobExecutionService which terminates the job (state purged).
 */
export class RetryExhaustedSignal extends Data.TaggedError("RetryExhaustedSignal")<
  RetryExhaustedInfo & {
    readonly reason: "max_attempts_exceeded" | "max_duration_exceeded";
  }
> {
  get message(): string {
    return `Job "${this.jobName}" exhausted after ${this.attempts} attempts: ${this.reason}`;
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
