// packages/jobs/src/definitions/task.ts

import type { Effect, Schema } from "effect";
import type {
  UnregisteredTaskDefinition,
  TaskEventContext,
  TaskExecuteContext,
  TaskIdleContext,
  TaskErrorContext,
  LoggingOption,
} from "../registry/types";

// =============================================================================
// Task Factory
// =============================================================================

/**
 * Configuration for creating a task job definition.
 *
 * Task provides user-controlled durable state machines where:
 * - Events update state and optionally schedule execution
 * - Execute runs when alarm fires
 * - User controls the full lifecycle via schedule/clear
 *
 * Note: All handler functions must return Effect with R = never.
 * If your effect requires services, provide them via .pipe(Effect.provide(layer)).
 *
 * @typeParam S - State type (inferred from stateSchema)
 * @typeParam E - Event type (inferred from eventSchema)
 * @typeParam Err - Error type (inferred from handlers)
 */
export interface TaskMakeConfig<S, E, Err> {
  /**
   * Schema for validating and serializing state.
   * State is persisted durably and survives restarts.
   */
  readonly stateSchema: Schema.Schema<S, any, never>;

  /**
   * Schema for validating incoming events.
   * Events are validated before being passed to onEvent.
   */
  readonly eventSchema: Schema.Schema<E, any, never>;

  /**
   * Handler called for each incoming event.
   * Must return Effect<void, Err, never> - all service requirements must be satisfied.
   *
   * The event is passed as the first parameter (not on ctx) to make it
   * clear that it's a direct value, not an Effect that needs yielding.
   *
   * Responsibilities:
   * - Update state based on the event (via ctx.setState or ctx.updateState)
   * - Schedule execution if needed (via ctx.schedule)
   * - Optionally clear the task if complete (via ctx.clear)
   *
   * @param event - The incoming event (already validated against eventSchema)
   * @param ctx - Context for state access, scheduling, and metadata
   *
   * @example
   * ```ts
   * onEvent: (event, ctx) => Effect.gen(function* () {
   *   // event is a direct value - no yield needed!
   *   console.log("Received:", event);
   *
   *   // Initialize state on first event
   *   if (ctx.state === null) {
   *     yield* ctx.setState({ items: [event], createdAt: Date.now() });
   *   } else {
   *     // Update state based on event
   *     yield* ctx.updateState(s => ({
   *       ...s,
   *       items: [...s.items, event]
   *     }));
   *   }
   *
   *   // Schedule processing in 5 seconds
   *   yield* ctx.schedule(Duration.seconds(5));
   * })
   * ```
   */
  onEvent(event: E, ctx: TaskEventContext<S>): Effect.Effect<void, Err, never>;

  /**
   * Handler called when the scheduled alarm fires.
   * Must return Effect<void, Err, never> - all service requirements must be satisfied.
   *
   * Responsibilities:
   * - Process the current state
   * - Schedule next execution if needed
   * - Clear the task when work is complete
   *
   * @example
   * ```ts
   * execute: (ctx) => Effect.gen(function* () {
   *   const state = yield* ctx.state;
   *   if (state === null) return;
   *
   *   // Process items
   *   yield* processItems(state.items);
   *
   *   // Clear when done
   *   yield* ctx.clear();
   * })
   * ```
   */
  execute(ctx: TaskExecuteContext<S>): Effect.Effect<void, Err, never>;

  /**
   * Optional handler called when either `onEvent` or `execute` completes
   * and no alarm is scheduled.
   * Must return Effect<void, never, never> - all service requirements must be satisfied.
   *
   * Use this to:
   * - Schedule delayed cleanup
   * - Log idle state
   * - Trigger maintenance tasks
   *
   * @example
   * ```ts
   * onIdle: (ctx) => Effect.gen(function* () {
   *   // Schedule cleanup in 1 hour if nothing happens
   *   yield* ctx.schedule(Duration.hours(1));
   * })
   * ```
   */
  readonly onIdle?: (ctx: TaskIdleContext<S>) => Effect.Effect<void, never, never>;

  /**
   * Optional error handler for onEvent/execute failures.
   * Must return Effect<void, never, never> - all service requirements must be satisfied.
   *
   * Use this to:
   * - Log errors
   * - Update state to track failures
   * - Schedule retries
   * - Clear the task on fatal errors
   *
   * If not provided, errors are logged and the task continues.
   *
   * @example
   * ```ts
   * onError: (error, ctx) => Effect.gen(function* () {
   *   yield* Effect.logError("Task failed", error);
   *
   *   // Track error in state
   *   yield* ctx.updateState(s => ({
   *     ...s,
   *     errorCount: (s.errorCount ?? 0) + 1
   *   }));
   *
   *   // Retry in 30 seconds
   *   yield* ctx.schedule(Duration.seconds(30));
   * })
   * ```
   */
  readonly onError?: (
    error: Err,
    ctx: TaskErrorContext<S>
  ) => Effect.Effect<void, never, never>;

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
}

/**
 * Namespace for creating task job definitions.
 *
 * Task is a user-controlled durable state machine that provides:
 * - Event-driven state updates
 * - Scheduled execution via alarms
 * - Full lifecycle control (schedule, cancel, clear)
 *
 * @example
 * ```ts
 * import { Task } from "@durable-effect/jobs";
 * import { Schema, Effect, Duration } from "effect";
 *
 * // Order processing task
 * const orderProcessor = Task.make({
 *   stateSchema: Schema.Struct({
 *     orderId: Schema.String,
 *     status: Schema.Literal("pending", "processing", "shipped", "delivered"),
 *     lastUpdated: Schema.Number,
 *   }),
 *
 *   eventSchema: Schema.Union(
 *     Schema.Struct({ _tag: Schema.Literal("OrderPlaced"), orderId: Schema.String }),
 *     Schema.Struct({ _tag: Schema.Literal("PaymentReceived") }),
 *     Schema.Struct({ _tag: Schema.Literal("Shipped"), trackingNumber: Schema.String }),
 *   ),
 *
 *   // event is passed as first parameter - clear it's a direct value!
 *   onEvent: (event, ctx) => Effect.gen(function* () {
 *     switch (event._tag) {
 *       case "OrderPlaced":
 *         yield* ctx.setState({
 *           orderId: event.orderId,
 *           status: "pending",
 *           lastUpdated: Date.now(),
 *         });
 *         // Check payment status in 5 minutes
 *         yield* ctx.schedule(Duration.minutes(5));
 *         break;
 *
 *       case "PaymentReceived":
 *         yield* ctx.updateState(s => ({ ...s, status: "processing", lastUpdated: Date.now() }));
 *         break;
 *
 *       case "Shipped":
 *         yield* ctx.updateState(s => ({ ...s, status: "shipped", lastUpdated: Date.now() }));
 *         // Check delivery in 24 hours
 *         yield* ctx.schedule(Duration.hours(24));
 *         break;
 *     }
 *   }),
 *
 *   execute: (ctx) => Effect.gen(function* () {
 *     const state = yield* ctx.state;
 *     if (state === null) return;
 *
 *     if (state.status === "shipped") {
 *       // Check if delivered
 *       const delivered = yield* checkDeliveryStatus(state.orderId);
 *       if (delivered) {
 *         yield* ctx.updateState(s => ({ ...s, status: "delivered", lastUpdated: Date.now() }));
 *         yield* ctx.clear(); // Order complete
 *       } else {
 *         yield* ctx.schedule(Duration.hours(24)); // Check again tomorrow
 *       }
 *     }
 *   }),
 * });
 *
 * // Register with createDurableJobs - name comes from key
 * const { Jobs, client } = createDurableJobs({
 *   jobs: { orderProcessor },
 *   binding: env.JOBS,
 * });
 *
 * // Send events
 * await Effect.runPromise(
 *   client.task("orderProcessor").send({
 *     id: "order-123",
 *     event: { _tag: "OrderPlaced", orderId: "order-123" }
 *   })
 * );
 * ```
 */
export const Task = {
  /**
   * Create a task job definition.
   *
   * The name is NOT provided here - it comes from the key when you
   * register the job via createDurableJobs().
   *
   * @param config - Configuration for the task
   * @returns An UnregisteredTaskDefinition that can be registered
   */
  make: <S, E, Err = never>(
    config: TaskMakeConfig<S, E, Err>
  ): UnregisteredTaskDefinition<S, E, Err> => ({
    _tag: "TaskDefinition",
    stateSchema: config.stateSchema,
    eventSchema: config.eventSchema,
    onEvent: config.onEvent,
    execute: config.execute,
    onIdle: config.onIdle,
    onError: config.onError,
    logging: config.logging,
  }),
} as const;

/**
 * Type alias for the Task namespace.
 */
export type TaskNamespace = typeof Task;
