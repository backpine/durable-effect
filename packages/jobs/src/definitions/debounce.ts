// packages/jobs/src/definitions/debounce.ts

import { Duration, Effect, type Schema } from "effect";
import type {
  UnregisteredDebounceDefinition,
  DebounceEventContext,
  DebounceExecuteContext,
  LoggingOption,
} from "../registry/types";
import type { JobRetryConfig } from "../retry/types";

// =============================================================================
// Debounce Factory
// =============================================================================

/**
 * Configuration for creating a debounce job definition.
 *
 * Note: All handler functions must return Effect with R = never.
 * If your effect requires services, provide them via .pipe(Effect.provide(layer)).
 */
export interface DebounceMakeConfig<I, S, E> {
  /**
   * Schema for validating incoming events.
   */
  readonly eventSchema: Schema.Schema<I, any, never>;

  /**
   * Optional schema for persisted state.
   * Defaults to eventSchema (keep latest event).
   */
  readonly stateSchema?: Schema.Schema<S, any, never>;

  /**
   * Duration to wait after first event before flushing.
   */
  readonly flushAfter: Duration.DurationInput;

  /**
   * Optional max events before immediate flush.
   */
  readonly maxEvents?: number;

  /**
   * Optional retry configuration for flush/execute handler failures.
   *
   * @example
   * ```ts
   * import { Backoff } from "@durable-effect/core";
   *
   * retry: {
   *   maxAttempts: 3,
   *   delay: Backoff.exponential({ base: "1 second", max: "30 seconds" }),
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
   * Reducer for each incoming event. Defaults to returning the latest event.
   * Must return Effect<S, never, never> - all service requirements must be satisfied.
   */
  onEvent?(ctx: DebounceEventContext<I, S>): Effect.Effect<S, never, never>;

  /**
   * Effect executed when the debounce flushes.
   * Must return Effect<void, E, never> - all service requirements must be satisfied.
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
  execute(ctx: DebounceExecuteContext<S>): Effect.Effect<void, E, never>;
}

/**
 * Namespace for creating debounce job definitions.
 *
 * @example
 * ```ts
 * const webhookDebounce = Debounce.make({
 *   eventSchema: Schema.Struct({ ... }),
 *   flushAfter: "5 minutes",
 *   execute: (ctx) => Effect.log(ctx.state),
 * });
 * ```
 */
export const Debounce = {
  make: <I, S = I, E = never>(
    config: DebounceMakeConfig<I, S, E>
  ): UnregisteredDebounceDefinition<I, S, E> => ({
    _tag: "DebounceDefinition",
    eventSchema: config.eventSchema,
    stateSchema: (config.stateSchema ?? config.eventSchema) as Schema.Schema<
      S,
      unknown,
      never
    >,
    flushAfter: config.flushAfter,
    maxEvents: config.maxEvents,
    retry: config.retry,
    logging: config.logging,
    onEvent:
      config.onEvent ??
      ((ctx: DebounceEventContext<I, S>) =>
        Effect.succeed(ctx.event as unknown as S)),
    execute: config.execute,
  }),
};

/**
 * Type alias for the Debounce namespace.
 */
export type DebounceNamespace = typeof Debounce;
