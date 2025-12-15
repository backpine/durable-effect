// packages/jobs/src/definitions/debounce.ts

import { Duration, Effect, type Schema } from "effect";
import type {
  UnregisteredDebounceDefinition,
  DebounceEventContext,
  DebounceExecuteContext,
} from "../registry/types";
import type { JobRetryConfig } from "../retry/types";

// =============================================================================
// Debounce Factory
// =============================================================================

/**
 * Configuration for creating a debounce job definition.
 */
export interface DebounceMakeConfig<I, S, E, R> {
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
  readonly retry?: JobRetryConfig<E>;

  /**
   * Reducer for each incoming event. Defaults to returning the latest event.
   */
  onEvent?(ctx: DebounceEventContext<I, S>): Effect.Effect<S, never, R>;

  /**
   * Effect executed when the debounce flushes.
   */
  execute(ctx: DebounceExecuteContext<S>): Effect.Effect<void, E, R>;

  /**
   * Optional error handler for execute failures.
   */
  onError?(
    error: E,
    ctx: DebounceExecuteContext<S>
  ): Effect.Effect<void, never, R>;
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
  make: <I, S = I, E = never, R = never>(
    config: DebounceMakeConfig<I, S, E, R>
  ): UnregisteredDebounceDefinition<I, S, E, R> => ({
    _tag: "DebounceDefinition",
    eventSchema: config.eventSchema,
    stateSchema: (config.stateSchema ?? config.eventSchema) as Schema.Schema<
      S,
      any,
      never
    >,
    flushAfter: config.flushAfter,
    maxEvents: config.maxEvents,
    retry: config.retry,
    onEvent:
      config.onEvent ??
      ((ctx: DebounceEventContext<I, S>) =>
        Effect.succeed(ctx.event as unknown as S)),
    execute: config.execute,
    onError: config.onError,
  }),
};

/**
 * Type alias for the Debounce namespace.
 */
export type DebounceNamespace = typeof Debounce;
