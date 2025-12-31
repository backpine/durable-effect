// packages/jobs/src/definitions/continuous.ts

import { Cron, DateTime, Duration, type Effect, type Schema } from "effect";
import type {
  UnregisteredContinuousDefinition,
  ContinuousSchedule,
  ContinuousContext,
  LoggingOption,
} from "../registry/types";
import type { JobRetryConfig } from "../retry/types";

// =============================================================================
// Continuous Factory
// =============================================================================

/**
 * Input config for creating a continuous job definition.
 */
export interface ContinuousMakeConfig<S, E> {
  /**
   * Schema for validating and serializing state.
   * Accepts any Effect Schema (Struct, Class, etc.)
   */
  readonly stateSchema: Schema.Schema<S, any, never>;

  /**
   * Schedule for when to execute.
   */
  readonly schedule: ContinuousSchedule;

  /**
   * Whether to execute immediately on start.
   * @default true
   */
  readonly startImmediately?: boolean;

  /**
   * Optional retry configuration for execute handler failures.
   *
   * @example
   * ```ts
   * import { Backoff } from "@durable-effect/core";
   *
   * retry: {
   *   maxAttempts: 3,
   *   delay: Backoff.exponential({ base: "1 second", max: "30 seconds" }),
   *   isRetryable: (error) => error._tag !== "FatalError",
   * }
   * ```
   */
  readonly retry?: JobRetryConfig;

  /**
   * Control logging for this job.
   *
   * - `false` (default): Only log errors (LogLevel.Error)
   * - `true`: Enable all logs (LogLevel.Debug)
   * - `LogLevel.*`: Use a specific log level
   * - `LogLevel.None`: Suppress all logs
   *
   * @example
   * ```ts
   * import { LogLevel } from "effect";
   *
   * // Enable debug logging
   * logging: true,
   *
   * // Only warnings and above
   * logging: LogLevel.Warning,
   * ```
   */
  readonly logging?: LoggingOption;

  /**
   * The function to execute on schedule.
   *
   * Must return Effect<void, E, never> - all service requirements must be satisfied.
   * If your effect requires services, provide them via .pipe(Effect.provide(layer)).
   *
   * @example
   * ```ts
   * execute: (ctx) =>
   *   Effect.gen(function* () {
   *     const random = yield* Random;
   *     // ...
   *   }).pipe(Effect.provide(RandomLive))
   * ```
   */
  execute(ctx: ContinuousContext<S>): Effect.Effect<void, E, never>;
}

/**
 * Namespace for creating continuous job definitions.
 *
 * @example
 * ```ts
 * import { Continuous } from "@durable-effect/jobs";
 * import { Schema } from "effect";
 *
 * const dailyReport = Continuous.make({
 *   stateSchema: Schema.Struct({
 *     lastReportDate: Schema.DateFromSelf,
 *     totalReports: Schema.Number,
 *   }),
 *   schedule: Continuous.every("24 hours"),
 *   execute: (ctx) =>
 *     Effect.gen(function* () {
 *       console.log(`Generating report #${ctx.runCount}`);
 *       ctx.updateState((s) => ({
 *         ...s,
 *         lastReportDate: new Date(),
 *         totalReports: s.totalReports + 1,
 *       }));
 *     }),
 * });
 *
 * // Register with createDurableJobs - name comes from key
 * const { Jobs } = createDurableJobs({ dailyReport });
 * ```
 */
export const Continuous = {
  /**
   * Create a continuous job definition.
   *
   * The name is NOT provided here - it comes from the key when you
   * register the job via createDurableJobs().
   *
   * @param config - Configuration for the job
   * @returns An UnregisteredContinuousDefinition that can be registered
   */
  make: <S, E = never>(
    config: ContinuousMakeConfig<S, E>
  ): UnregisteredContinuousDefinition<S, E> => ({
    _tag: "ContinuousDefinition",
    stateSchema: config.stateSchema,
    schedule: config.schedule,
    startImmediately: config.startImmediately,
    retry: config.retry,
    logging: config.logging,
    execute: config.execute,
  }),

  /**
   * Create a schedule that executes at a fixed interval.
   *
   * @example
   * ```ts
   * Continuous.every("30 minutes")
   * Continuous.every(Duration.hours(1))
   * ```
   */
  every: (interval: Duration.DurationInput): ContinuousSchedule => ({
    _tag: "Every",
    interval,
  }),

  /**
   * Create a schedule based on a cron expression.
   *
   * Uses Effect's built-in Cron module for parsing and scheduling.
   *
   * @param expression - Standard cron expression (6 fields: seconds minutes hours days months weekdays)
   * @param tz - Optional timezone name (e.g., "America/New_York", "UTC")
   *
   * @example
   * ```ts
   * // Every day at 4am UTC
   * Continuous.cron("0 0 4 * * *")
   *
   * // Every Monday at 9am in New York
   * Continuous.cron("0 0 9 * * 1", "America/New_York")
   * ```
   */
  cron: (expression: string, tz?: string): ContinuousSchedule => {
    const timezone = tz ? DateTime.zoneUnsafeMakeNamed(tz) : undefined;
    const cron = Cron.unsafeParse(expression, timezone);
    return {
      _tag: "Cron",
      cron,
    };
  },
} as const;

/**
 * Type alias for the Continuous namespace.
 */
export type ContinuousNamespace = typeof Continuous;
