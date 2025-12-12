// packages/workflow/src/adapters/in-memory/scheduler.ts

import { Effect, Ref } from "effect";
import type { SchedulerAdapterService } from "@durable-effect/core";

/**
 * In-memory scheduler state.
 */
export interface InMemorySchedulerState {
  readonly scheduledTime: number | undefined;
}

/**
 * Create an in-memory scheduler adapter.
 *
 * Used for testing - stores scheduled time in a Ref.
 * Does NOT automatically fire - tests must manually trigger alarms.
 */
export function createInMemoryScheduler(
  stateRef?: Ref.Ref<InMemorySchedulerState>,
): Effect.Effect<SchedulerAdapterService, never, never> {
  return Effect.gen(function* () {
    const ref =
      stateRef ??
      (yield* Ref.make<InMemorySchedulerState>({ scheduledTime: undefined }));

    return {
      schedule: (time: number) => Ref.set(ref, { scheduledTime: time }),

      cancel: () => Ref.set(ref, { scheduledTime: undefined }),

      getScheduled: () =>
        Ref.get(ref).pipe(Effect.map((state) => state.scheduledTime)),
    };
  });
}

/**
 * Helper to check if an alarm should have fired given current time.
 */
export function shouldAlarmFire(
  scheduledTime: number | undefined,
  currentTime: number,
): boolean {
  return scheduledTime !== undefined && currentTime >= scheduledTime;
}
