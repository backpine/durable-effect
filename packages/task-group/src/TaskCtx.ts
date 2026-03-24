import type { Duration, Effect } from "effect"
import type { TaskError, PurgeSignal, SystemFailure } from "./errors.js"
import type { AnyTaskTag, EventOf, StateOf, EventFor, StateFor } from "./TaskTag.js"

// ---------------------------------------------------------------------------
// SiblingHandle — what ctx.task() returns for dispatching to a sibling
// ---------------------------------------------------------------------------

export interface SiblingHandle<S, E> {
  readonly send: (id: string, event: E) => Effect.Effect<void, TaskError>
  readonly getState: (id: string) => Effect.Effect<S | null, TaskError>
}

// ---------------------------------------------------------------------------
// TaskCtx — what handler authors interact with
//
// Generic parameters:
//   S    — the task's own state type
//   Tags — union of all task tags in the registry (for sibling access)
// ---------------------------------------------------------------------------

export interface TaskCtx<S, Tags extends AnyTaskTag> {
  // ── State ──────────────────────────────────────────────
  readonly recall: () => Effect.Effect<S | null, TaskError>
  readonly save: (state: S) => Effect.Effect<void, TaskError>
  readonly update: (fn: (s: S) => S) => Effect.Effect<void, TaskError>

  // ── Scheduling ─────────────────────────────────────────
  readonly scheduleIn: (delay: Duration.Input) => Effect.Effect<void, TaskError>
  readonly scheduleAt: (time: Date | number) => Effect.Effect<void, TaskError>
  readonly cancelSchedule: () => Effect.Effect<void, TaskError>
  readonly nextAlarm: () => Effect.Effect<number | null, TaskError>

  // ── Lifecycle ──────────────────────────────────────────
  readonly purge: () => Effect.Effect<never, PurgeSignal>

  // ── Identity ───────────────────────────────────────────
  readonly id: string
  readonly name: string

  // ── Sibling Access ─────────────────────────────────────
  /**
   * Get a typed handle to a sibling task in the same registry.
   * Accepts either a task tag object or a string task name.
   */
  readonly task: {
    <T extends Tags>(tag: T): SiblingHandle<StateOf<T>, EventOf<T>>
    <K extends Tags["name"]>(name: K): SiblingHandle<StateFor<Tags, K>, EventFor<Tags, K>>
  }

  // ── Infrastructure ─────────────────────────────────────
  /**
   * Non-null when this invocation is recovering from an infrastructure-level
   * failure (e.g. DO crash/restart). Handlers can check this to decide
   * whether to retry, compensate, or alert.
   */
  readonly systemFailure: SystemFailure | null
}
