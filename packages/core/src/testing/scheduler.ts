// packages/core/src/testing/scheduler.ts

import { Effect } from "effect";
import type { SchedulerAdapterService } from "../adapters/scheduler";

/**
 * Create an in-memory scheduler adapter for testing.
 */
export function createInMemoryScheduler(): SchedulerAdapterService {
  let scheduledTime: number | undefined = undefined;

  return {
    schedule: (time: number) =>
      Effect.sync(() => {
        scheduledTime = time;
      }),

    cancel: () =>
      Effect.sync(() => {
        scheduledTime = undefined;
      }),

    getScheduled: () => Effect.succeed(scheduledTime),
  };
}

/**
 * In-memory scheduler with test helpers.
 */
export interface InMemorySchedulerHandle extends SchedulerAdapterService {
  /**
   * Get the currently scheduled time (synchronous).
   */
  readonly getScheduledTime: () => number | undefined;

  /**
   * Check if an alarm is scheduled.
   */
  readonly isScheduled: () => boolean;

  /**
   * Clear the scheduled alarm (synchronous).
   */
  readonly clear: () => void;

  /**
   * Fire the alarm (simulate time advancement).
   * Returns the scheduled time or undefined if none.
   */
  readonly fire: () => number | undefined;
}

/**
 * Create an in-memory scheduler adapter with test helpers.
 */
export function createInMemorySchedulerWithHandle(): InMemorySchedulerHandle {
  let scheduledTime: number | undefined = undefined;

  return {
    schedule: (time: number) =>
      Effect.sync(() => {
        scheduledTime = time;
      }),

    cancel: () =>
      Effect.sync(() => {
        scheduledTime = undefined;
      }),

    getScheduled: () => Effect.succeed(scheduledTime),

    // Test helpers
    getScheduledTime: () => scheduledTime,
    isScheduled: () => scheduledTime !== undefined,
    clear: () => {
      scheduledTime = undefined;
    },
    fire: () => {
      const time = scheduledTime;
      scheduledTime = undefined;
      return time;
    },
  };
}
