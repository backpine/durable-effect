// packages/primitives/src/definitions/continuous.ts

import { Duration, type Effect, type Schema } from "effect";
import type {
  ContinuousDefinition,
  ContinuousSchedule,
  ContinuousContext,
} from "../registry/types";

// =============================================================================
// Continuous Factory
// =============================================================================

/**
 * Input config for creating a continuous primitive definition.
 * The `name` field is provided at the call site of `Continuous.make()`.
 */
export interface ContinuousMakeConfig<S, E, R> {
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
   * The function to execute on schedule.
   */
  execute(ctx: ContinuousContext<S>): Effect.Effect<void, E, R>;

  /**
   * Optional error handler. If provided, errors from execute() are
   * passed here instead of failing the execution.
   */
  onError?(error: E, ctx: ContinuousContext<S>): Effect.Effect<void, never, R>;
}

/**
 * Namespace for creating continuous primitive definitions.
 *
 * @example
 * ```ts
 * import { Continuous } from "@durable-effect/primitives";
 * import { Schema } from "effect";
 *
 * const DailyReport = Continuous.make("daily-report", {
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
 * ```
 */
export const Continuous = {
  /**
   * Create a continuous primitive definition.
   *
   * @param name - Unique name for this primitive (used for routing)
   * @param config - Configuration for the primitive
   * @returns A ContinuousDefinition that can be registered
   */
  make: <S, E = never, R = never>(
    name: string,
    config: ContinuousMakeConfig<S, E, R>
  ): ContinuousDefinition<S, E, R> => ({
    _tag: "continuous",
    name,
    stateSchema: config.stateSchema,
    schedule: config.schedule,
    startImmediately: config.startImmediately,
    execute: config.execute,
    onError: config.onError,
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
   * @example
   * ```ts
   * // Every day at midnight
   * Continuous.cron("0 0 * * *")
   *
   * // Every Monday at 9am
   * Continuous.cron("0 9 * * 1")
   * ```
   */
  cron: (expression: string): ContinuousSchedule => ({
    _tag: "Cron",
    expression,
  }),
} as const;

/**
 * Type alias for the Continuous namespace.
 */
export type ContinuousNamespace = typeof Continuous;
