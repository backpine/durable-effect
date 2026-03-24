import type { Effect } from "effect"
import type {
  TaskNotFoundError,
  TaskValidationError,
  TaskExecutionError,
} from "./errors.js"

// ---------------------------------------------------------------------------
// TaskRuntime — shared interface implemented by all adapters.
// InMemoryRuntime extends this with test-only methods.
// DurableObjectRuntime implements this directly.
// ---------------------------------------------------------------------------

export interface TaskRuntime {
  readonly sendEvent: (
    name: string,
    id: string,
    event: unknown,
  ) => Effect.Effect<void, TaskNotFoundError | TaskValidationError | TaskExecutionError>

  readonly getState: (
    name: string,
    id: string,
  ) => Effect.Effect<unknown, TaskNotFoundError | TaskExecutionError>

  readonly fireAlarm: (
    name: string,
    id: string,
  ) => Effect.Effect<void, TaskNotFoundError | TaskExecutionError>
}
