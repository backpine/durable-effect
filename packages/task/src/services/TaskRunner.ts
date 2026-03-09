import { Effect, ServiceMap } from "effect"
import type {
  TaskNotFoundError,
  TaskValidationError,
  TaskExecutionError,
} from "../errors.js"

// ---------------------------------------------------------------------------
// TaskRunner service — orchestrates task execution
// ---------------------------------------------------------------------------

export class TaskRunner extends ServiceMap.Service<TaskRunner, {
  readonly handleEvent: (
    name: string,
    id: string,
    event: unknown,
  ) => Effect.Effect<
    void,
    TaskNotFoundError | TaskValidationError | TaskExecutionError
  >
  readonly handleAlarm: (
    name: string,
    id: string,
  ) => Effect.Effect<
    void,
    TaskNotFoundError | TaskExecutionError
  >
  readonly handleGetState: (
    name: string,
    id: string,
  ) => Effect.Effect<
    unknown,
    TaskNotFoundError | TaskExecutionError
  >
}>()("@task/Runner") {}
