// packages/jobs/src/services/job-logging.ts

import { Effect, Logger, LogLevel } from "effect";
import type { LoggingOption } from "../registry/types";

// =============================================================================
// Log Level Resolution
// =============================================================================

/**
 * Resolve logging option to an Effect LogLevel.
 *
 * - undefined/false → LogLevel.Error (failures only - default)
 * - true → LogLevel.Debug (all logs)
 * - LogLevel.* → Use as-is
 */
export const resolveLogLevel = (option?: LoggingOption): LogLevel.LogLevel => {
  if (option === undefined || option === false) {
    return LogLevel.Error; // Default: only log failures
  }
  if (option === true) {
    return LogLevel.Debug; // Shorthand for all logs
  }
  return option; // Use the provided LogLevel directly
};

// =============================================================================
// Job Logging Wrapper
// =============================================================================

/**
 * Configuration for job logging.
 */
export interface JobLoggingConfig {
  readonly logging?: LoggingOption;
  readonly jobType: string;
  readonly jobName: string;
  readonly instanceId: string;
}

/**
 * Wrap an effect with job-scoped logging.
 *
 * - Adds job context as annotations (propagates to all nested logs)
 * - Controls log level based on job's logging config
 * - Default (false): Only errors logged
 * - Use LogLevel.None for truly silent operation
 *
 * @example
 * ```ts
 * const handler = withJobLogging(
 *   Effect.gen(function* () {
 *     yield* Effect.logInfo("Job started");
 *     // ... handler logic ...
 *   }),
 *   {
 *     logging: def.logging,
 *     jobType: "continuous",
 *     jobName: def.name,
 *     instanceId: runtime.instanceId,
 *   }
 * );
 * ```
 */
export const withJobLogging = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  config: JobLoggingConfig
): Effect.Effect<A, E, R> =>
  effect.pipe(
    // Add all annotations at once using object form
    Effect.annotateLogs({
      jobType: config.jobType,
      jobName: config.jobName,
      instanceId: config.instanceId,
    }),
    // Control log level based on config
    Logger.withMinimumLogLevel(resolveLogLevel(config.logging))
  );

// =============================================================================
// Log Span Helper
// =============================================================================

/**
 * Wrap an execution with a log span to measure duration.
 * Duration is automatically added to all logs within the span.
 *
 * @example
 * ```ts
 * yield* withLogSpan(
 *   Effect.gen(function* () {
 *     yield* Effect.logDebug("Execution starting");
 *     const result = yield* runExecution(def, runCount);
 *     yield* Effect.logDebug("Execution completed");
 *     return result;
 *   }),
 *   "execution"
 * );
 * // Output includes: execution=145ms
 * ```
 */
export const withLogSpan = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  spanName: string
): Effect.Effect<A, E, R> => effect.pipe(Effect.withLogSpan(spanName));
