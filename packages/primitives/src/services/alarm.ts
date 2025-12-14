// packages/primitives/src/services/alarm.ts

import { Context, Effect, Layer, Duration } from "effect";
import {
  SchedulerAdapter,
  RuntimeAdapter,
  type SchedulerError,
} from "@durable-effect/core";

// =============================================================================
// Service Interface
// =============================================================================

/**
 * AlarmService provides higher-level alarm scheduling.
 *
 * Unlike the raw SchedulerAdapter which only accepts timestamps,
 * AlarmService supports:
 * - Duration inputs ("30 minutes", Duration.minutes(30))
 * - Date objects
 * - Absolute timestamps (numbers)
 */
export interface AlarmServiceI {
  /**
   * Schedule an alarm.
   *
   * @param when - When to fire the alarm:
   *   - Duration: relative to now
   *   - Date: absolute time
   *   - number: absolute timestamp in ms
   */
  readonly schedule: (
    when: Duration.DurationInput | number | Date
  ) => Effect.Effect<void, SchedulerError>;

  /**
   * Cancel the scheduled alarm.
   */
  readonly cancel: () => Effect.Effect<void, SchedulerError>;

  /**
   * Get the scheduled alarm time.
   * Returns undefined if no alarm is scheduled.
   */
  readonly getScheduled: () => Effect.Effect<number | undefined, SchedulerError>;
}

// =============================================================================
// Service Tag
// =============================================================================

export class AlarmService extends Context.Tag(
  "@durable-effect/primitives/AlarmService"
)<AlarmService, AlarmServiceI>() {}

// =============================================================================
// Implementation
// =============================================================================

export const AlarmServiceLayer = Layer.effect(
  AlarmService,
  Effect.gen(function* () {
    const scheduler = yield* SchedulerAdapter;
    const runtime = yield* RuntimeAdapter;

    return {
      schedule: (when: Duration.DurationInput | number | Date) =>
        Effect.gen(function* () {
          let timestamp: number;

          if (typeof when === "number") {
            // Absolute timestamp
            timestamp = when;
          } else if (when instanceof Date) {
            // Date object
            timestamp = when.getTime();
          } else {
            // Duration - convert to absolute timestamp
            const now = yield* runtime.now();
            const duration = Duration.decode(when);
            const ms = Duration.toMillis(duration);
            timestamp = now + ms;
          }

          yield* scheduler.schedule(timestamp);
        }),

      cancel: () => scheduler.cancel(),

      getScheduled: () => scheduler.getScheduled(),
    };
  })
);
