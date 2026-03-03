import type { Duration, Effect } from "effect"
import type { TaskError, PurgeSignal } from "./errors.js"

// ---------------------------------------------------------------------------
// TaskContext<S> - what handler authors interact with
// ---------------------------------------------------------------------------

export interface TaskContext<S> {
  // State
  readonly recall: () => Effect.Effect<S | null, TaskError>
  readonly save: (state: S) => Effect.Effect<void, TaskError>
  readonly update: (fn: (s: S) => S) => Effect.Effect<void, TaskError>

  // Scheduling
  readonly scheduleIn: (delay: Duration.Input) => Effect.Effect<void, TaskError>
  readonly scheduleAt: (time: Date | number) => Effect.Effect<void, TaskError>
  readonly cancelSchedule: () => Effect.Effect<void, TaskError>
  readonly nextAlarm: () => Effect.Effect<number | null, TaskError>

  // Lifecycle
  readonly purge: () => Effect.Effect<never, PurgeSignal>

  // Identity
  readonly id: string
  readonly name: string
}
