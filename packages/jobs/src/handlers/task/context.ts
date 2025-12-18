// packages/jobs/src/handlers/task/context.ts

import { Effect, Duration } from "effect";
import type {
  TaskEventContext,
  TaskExecuteContext,
  TaskIdleContext,
  TaskErrorContext,
} from "../../registry/types";
import { TerminateSignal } from "../../errors";

// =============================================================================
// State Holder
// =============================================================================

/**
 * State holder for mutable state updates during execution.
 */
export interface TaskStateHolder<S> {
  current: S | null;
  dirty: boolean;
}

// =============================================================================
// Scheduling Holder
// =============================================================================

/**
 * Scheduling holder for tracking schedule operations during execution.
 */
export interface TaskScheduleHolder {
  scheduledAt: number | null;
  cancelled: boolean;
  dirty: boolean;
}

// =============================================================================
// Effect Factories
// =============================================================================

/**
 * Create the common scheduling effects.
 * Shared between onEvent and execute contexts.
 */
function createSchedulingEffects(
  scheduleHolder: TaskScheduleHolder,
  getScheduledFromStorage: () => Effect.Effect<number | null, never, never>,
) {
  return {
    schedule: (when: Duration.DurationInput | number | Date): Effect.Effect<void, never, never> =>
      Effect.sync(() => {
        let timestamp: number;
        if (when instanceof Date) {
          timestamp = when.getTime();
        } else if (typeof when === "number") {
          timestamp = when;
        } else {
          timestamp = Date.now() + Duration.toMillis(Duration.decode(when));
        }
        scheduleHolder.scheduledAt = timestamp;
        scheduleHolder.cancelled = false;
        scheduleHolder.dirty = true;
      }),

    cancelSchedule: (): Effect.Effect<void, never, never> =>
      Effect.sync(() => {
        scheduleHolder.scheduledAt = null;
        scheduleHolder.cancelled = true;
        scheduleHolder.dirty = true;
      }),

    getScheduledTime: (): Effect.Effect<number | null, never, never> =>
      scheduleHolder.dirty
        ? Effect.succeed(scheduleHolder.scheduledAt)
        : getScheduledFromStorage(),
  };
}

// =============================================================================
// Context Factories
// =============================================================================

/**
 * Create TaskEventContext for onEvent handler.
 * Note: event is passed separately to onEvent, not via context.
 */
export function createTaskEventContext<S>(
  stateHolder: TaskStateHolder<S>,
  scheduleHolder: TaskScheduleHolder,
  instanceId: string,
  jobName: string,
  executionStartedAt: number,
  getEventCount: () => Effect.Effect<number, never, never>,
  getCreatedAt: () => Effect.Effect<number, never, never>,
  getScheduledFromStorage: () => Effect.Effect<number | null, never, never>,
): TaskEventContext<S> {
  const scheduling = createSchedulingEffects(scheduleHolder, getScheduledFromStorage);

  // Capture isFirstEvent at context creation time (before state might change)
  const isFirstEvent = stateHolder.current === null;

  return {
    // State access (Effect-based)
    state: Effect.sync(() => stateHolder.current),

    // State mutations
    setState: (state: S): Effect.Effect<void, never, never> =>
      Effect.sync(() => {
        stateHolder.current = state;
        stateHolder.dirty = true;
      }),

    updateState: (fn: (current: S) => S): Effect.Effect<void, never, never> =>
      Effect.sync(() => {
        if (stateHolder.current !== null) {
          stateHolder.current = fn(stateHolder.current);
          stateHolder.dirty = true;
        }
      }),

    // Scheduling
    ...scheduling,

    // Cleanup
    terminate: (): Effect.Effect<never, never, never> =>
      Effect.fail(new TerminateSignal({ reason: "terminate", purgeState: true })) as Effect.Effect<never, never, never>,

    // Metadata
    instanceId,
    jobName,
    executionStartedAt,
    isFirstEvent,

    // Metadata (Effects)
    eventCount: getEventCount(),
    createdAt: getCreatedAt(),
  };
}

/**
 * Create TaskExecuteContext for execute handler.
 */
export function createTaskExecuteContext<S>(
  stateHolder: TaskStateHolder<S>,
  scheduleHolder: TaskScheduleHolder,
  instanceId: string,
  jobName: string,
  executionStartedAt: number,
  getState: () => Effect.Effect<S | null, never, never>,
  getEventCount: () => Effect.Effect<number, never, never>,
  getCreatedAt: () => Effect.Effect<number, never, never>,
  getExecuteCount: () => Effect.Effect<number, never, never>,
  getScheduledFromStorage: () => Effect.Effect<number | null, never, never>,
): TaskExecuteContext<S> {
  const scheduling = createSchedulingEffects(scheduleHolder, getScheduledFromStorage);

  return {
    // State access (Effect - loaded on demand, but uses holder if dirty)
    state: stateHolder.dirty
      ? Effect.succeed(stateHolder.current)
      : getState(),

    // State mutations
    setState: (state: S): Effect.Effect<void, never, never> =>
      Effect.sync(() => {
        stateHolder.current = state;
        stateHolder.dirty = true;
      }),

    updateState: (fn: (current: S) => S): Effect.Effect<void, never, never> =>
      Effect.gen(function* () {
        const current = stateHolder.dirty
          ? stateHolder.current
          : yield* getState();
        if (current !== null) {
          stateHolder.current = fn(current);
          stateHolder.dirty = true;
        }
      }),

    // Scheduling
    ...scheduling,

    // Cleanup
    terminate: (): Effect.Effect<never, never, never> =>
      Effect.fail(new TerminateSignal({ reason: "terminate", purgeState: true })) as Effect.Effect<never, never, never>,

    // Metadata
    instanceId,
    jobName,
    executionStartedAt,

    // Metadata (Effects)
    eventCount: getEventCount(),
    createdAt: getCreatedAt(),
    executeCount: getExecuteCount(),
  };
}

/**
 * Create TaskIdleContext for onIdle handler.
 */
export function createTaskIdleContext<S>(
  stateHolder: TaskStateHolder<S>,
  scheduleHolder: TaskScheduleHolder,
  instanceId: string,
  jobName: string,
  idleReason: "onEvent" | "execute",
  getState: () => Effect.Effect<S | null, never, never>,
  getScheduledFromStorage: () => Effect.Effect<number | null, never, never>,
): TaskIdleContext<S> {
  const scheduling = createSchedulingEffects(scheduleHolder, getScheduledFromStorage);

  return {
    state: stateHolder.dirty
      ? Effect.succeed(stateHolder.current)
      : getState(),

    schedule: scheduling.schedule,

    terminate: (): Effect.Effect<never, never, never> =>
      Effect.fail(new TerminateSignal({ reason: "terminate", purgeState: true })) as Effect.Effect<never, never, never>,

    instanceId,
    jobName,
    idleReason,
  };
}

/**
 * Create TaskErrorContext for onError handler.
 */
export function createTaskErrorContext<S>(
  stateHolder: TaskStateHolder<S>,
  scheduleHolder: TaskScheduleHolder,
  instanceId: string,
  jobName: string,
  errorSource: "onEvent" | "execute",
  getState: () => Effect.Effect<S | null, never, never>,
  getScheduledFromStorage: () => Effect.Effect<number | null, never, never>,
): TaskErrorContext<S> {
  const scheduling = createSchedulingEffects(scheduleHolder, getScheduledFromStorage);

  return {
    state: stateHolder.dirty
      ? Effect.succeed(stateHolder.current)
      : getState(),

    updateState: (fn: (current: S) => S): Effect.Effect<void, never, never> =>
      Effect.gen(function* () {
        const current = stateHolder.dirty
          ? stateHolder.current
          : yield* getState();
        if (current !== null) {
          stateHolder.current = fn(current);
          stateHolder.dirty = true;
        }
      }),

    schedule: scheduling.schedule,

    terminate: (): Effect.Effect<never, never, never> =>
      Effect.fail(new TerminateSignal({ reason: "terminate", purgeState: true })) as Effect.Effect<never, never, never>,

    instanceId,
    jobName,
    errorSource,
  };
}
