// packages/jobs/src/retry/types.ts

import type { BaseRetryConfig } from "@durable-effect/core";

/**
 * Information provided when all retry attempts are exhausted.
 *
 * This is passed to the RetryExhaustedSignal and can be used by
 * the job's onRetryExhausted handler.
 */
export interface RetryExhaustedInfo {
  readonly jobType: "continuous" | "debounce" | "task" | "workerPool";
  readonly jobName: string;
  readonly instanceId: string;
  readonly attempts: number;
  readonly lastError: unknown;
  readonly totalDurationMs: number;
}

/**
 * Retry configuration for job execute handlers.
 *
 * Simplified configuration focused only on retry timing.
 * All errors from execute are retryable - use onRetryExhausted
 * at the job definition level for custom exhaustion handling.
 *
 * When retries are exhausted:
 * - If onRetryExhausted is defined on the job: it's called with the typed error
 * - If not defined: the job is terminated (state purged) by default
 */
export interface JobRetryConfig extends BaseRetryConfig {
  // Inherits from BaseRetryConfig:
  // - maxAttempts: number
  // - delay: RetryDelay
  // - jitter?: boolean
  // - maxDuration?: Duration.DurationInput
}
