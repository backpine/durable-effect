import type { Effect } from "effect"
import type { AnyTaskTag, StateFor, EventFor } from "./TaskTag.js"
import type {
  TaskValidationError,
  TaskExecutionError,
} from "./errors.js"

// ---------------------------------------------------------------------------
// ExternalTaskHandle — typed handle for a specific task, returned by
// runtime.task(name). Mirrors SiblingHandle from ctx.task() but adds
// fireAlarm for external callers.
// ---------------------------------------------------------------------------

export interface ExternalTaskHandle<S, E> {
  readonly send: (id: string, event: E) => Effect.Effect<void, TaskValidationError | TaskExecutionError>
  readonly getState: (id: string) => Effect.Effect<S | null, TaskExecutionError>
  readonly fireAlarm: (id: string) => Effect.Effect<void, TaskExecutionError>
}

// ---------------------------------------------------------------------------
// TypedTaskRuntime — typed runtime interface. .task(name) constrains the
// name to valid task names and returns a handle typed with that task's
// state and event schemas.
// ---------------------------------------------------------------------------

export interface TypedTaskRuntime<Tags extends AnyTaskTag> {
  readonly task: <K extends Tags["name"]>(name: K) => ExternalTaskHandle<StateFor<Tags, K>, EventFor<Tags, K>>
}
