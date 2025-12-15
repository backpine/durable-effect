// packages/core/src/retry/types.ts

import type { Duration } from "effect";

/**
 * Backoff strategy for calculating retry delays.
 */
export type BackoffStrategy =
  | { readonly type: "constant"; readonly delayMs: number }
  | {
      readonly type: "linear";
      readonly initialDelayMs: number;
      readonly incrementMs: number;
      readonly maxDelayMs?: number;
    }
  | {
      readonly type: "exponential";
      readonly initialDelayMs: number;
      readonly multiplier?: number;
      readonly maxDelayMs?: number;
    };

/**
 * Duration input - supports human-readable strings or milliseconds.
 * Uses Effect's DurationInput for compatibility.
 */
export type DurationInput = Duration.DurationInput;

/**
 * Delay configuration for retries.
 * Can be a fixed duration, backoff strategy, or custom function.
 */
export type RetryDelay =
  | DurationInput
  | BackoffStrategy
  | ((attempt: number) => number);

/**
 * Base retry configuration shared across packages.
 */
export interface BaseRetryConfig {
  /**
   * Maximum number of retry attempts (not including initial attempt).
   * Example: maxAttempts: 3 means up to 4 total executions.
   */
  readonly maxAttempts: number;

  /**
   * Delay between retries.
   * - string: Human-readable duration ("5 seconds", "1 minute")
   * - number: Milliseconds
   * - BackoffStrategy: Structured backoff (constant/linear/exponential)
   * - function: Custom delay based on attempt number
   *
   * @default Backoff.presets.standard() (exponential, 1s base, 30s max)
   */
  readonly delay?: RetryDelay;

  /**
   * Whether to add random jitter to delays.
   * Helps prevent thundering herd when multiple operations retry simultaneously.
   *
   * @default true
   */
  readonly jitter?: boolean;

  /**
   * Maximum total time for all retry attempts.
   * If exceeded, fails immediately without further retries.
   */
  readonly maxDuration?: DurationInput;
}
