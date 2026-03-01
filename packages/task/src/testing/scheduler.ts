import { Effect, Layer } from "effect";
import { Scheduler } from "../adapter/scheduler.js";

export interface TestSchedulerHandle {
  readonly schedule: (timestamp: number) => Effect.Effect<void>;
  readonly cancel: () => Effect.Effect<void>;
  readonly getNext: () => Effect.Effect<number | null>;
  readonly getScheduledTime: () => number | null;
  readonly isScheduled: () => boolean;
  readonly clear: () => void;
}

export function createTestScheduler(): { layer: Layer.Layer<Scheduler>; handle: TestSchedulerHandle } {
  let scheduledTime: number | null = null;

  const handle: TestSchedulerHandle = {
    schedule: (timestamp) => Effect.sync(() => { scheduledTime = timestamp; }),
    cancel: () => Effect.sync(() => { scheduledTime = null; }),
    getNext: () => Effect.succeed(scheduledTime),
    getScheduledTime: () => scheduledTime,
    isScheduled: () => scheduledTime !== null,
    clear: () => { scheduledTime = null; },
  };

  const layer = Layer.succeed(Scheduler)({
    schedule: handle.schedule,
    cancel: handle.cancel,
    getNext: handle.getNext,
  });

  return { layer, handle };
}
