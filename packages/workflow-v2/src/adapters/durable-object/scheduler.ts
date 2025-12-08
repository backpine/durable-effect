// packages/workflow-v2/src/adapters/durable-object/scheduler.ts

import { Effect } from "effect";
import { SchedulerError } from "../../errors";
import type { SchedulerAdapterService } from "../scheduler";

/**
 * Create a Durable Object scheduler adapter.
 *
 * Wraps DO alarm methods with Effect error handling.
 */
export function createDOSchedulerAdapter(
  storage: DurableObjectStorage
): SchedulerAdapterService {
  return {
    schedule: (time: number) =>
      Effect.tryPromise({
        try: () => storage.setAlarm(time),
        catch: (e) => new SchedulerError({ operation: "schedule", cause: e }),
      }),

    cancel: () =>
      Effect.tryPromise({
        try: () => storage.deleteAlarm(),
        catch: (e) => new SchedulerError({ operation: "cancel", cause: e }),
      }),

    getScheduled: () =>
      Effect.tryPromise({
        try: () => storage.getAlarm(),
        catch: (e) => new SchedulerError({ operation: "get", cause: e }),
      }).pipe(Effect.map((time) => (time === null ? undefined : time))),
  };
}
