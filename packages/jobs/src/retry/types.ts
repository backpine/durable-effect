// packages/jobs/src/retry/types.ts

import type { BaseRetryConfig } from "@durable-effect/core";

/**
 * Information provided when all retry attempts are exhausted.
 */
export interface RetryExhaustedInfo<E> {
  readonly jobType: "continuous" | "debounce";
  readonly jobName: string;
  readonly instanceId: string;
  readonly attempts: number;
  readonly lastError: E;
  readonly totalDurationMs: number;
}

/**
 * Retry configuration for job execute handlers.
 * Extends base config with job-specific options.
 *
 * Note: Uses method syntax for callbacks to enable bivariant type checking,
 * allowing definitions with any error type to be stored in a common registry.
 */
export interface JobRetryConfig<E = unknown> extends BaseRetryConfig {
  /**
   * Predicate to determine if an error is retryable.
   * Return false to fail immediately without retrying.
   *
   * @default () => true (all errors are retryable)
   */
  isRetryable?(error: E): boolean;

  /**
   * Called when all retry attempts are exhausted.
   * Useful for logging, alerting, or custom cleanup.
   *
   * Note: This is called BEFORE the final error is propagated to onError.
   */
  onRetryExhausted?(info: RetryExhaustedInfo<E>): void;
}
