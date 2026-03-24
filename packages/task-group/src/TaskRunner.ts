import { Effect, Layer, ServiceMap } from "effect"
import type { TaskRegistryConfig } from "./TaskRegistry.js"
import type { DispatchFn, HandlerContext } from "./RegisteredTask.js"
import { Storage } from "./services/Storage.js"
import { Alarm } from "./services/Alarm.js"
import {
  TaskError,
  TaskNotFoundError,
} from "./errors.js"

// ---------------------------------------------------------------------------
// TaskRunner service — dispatches events and alarms to registered tasks.
//
// This is the abstract runner for single-instance adapters (e.g. Cloudflare
// where each DO is one task instance). For multi-instance testing, use
// InMemoryRuntime instead.
// ---------------------------------------------------------------------------

export class TaskRunner extends ServiceMap.Service<TaskRunner, {
  readonly handleEvent: (
    name: string,
    id: string,
    event: unknown,
  ) => Effect.Effect<
    void,
    TaskNotFoundError | import("./errors.js").TaskValidationError | import("./errors.js").TaskExecutionError
  >
  readonly handleAlarm: (
    name: string,
    id: string,
  ) => Effect.Effect<
    void,
    TaskNotFoundError | import("./errors.js").TaskExecutionError
  >
  readonly handleGetState: (
    name: string,
    id: string,
  ) => Effect.Effect<
    unknown,
    TaskNotFoundError | import("./errors.js").TaskExecutionError
  >
}>()("@task-group/Runner") {}

// ---------------------------------------------------------------------------
// makeTaskRunnerLayer — builds a TaskRunner from a registry config.
//
// Uses a single Storage + Alarm (appropriate for adapters where storage is
// already scoped to one instance, like Cloudflare DOs).
// ---------------------------------------------------------------------------

export function makeTaskRunnerLayer(
  registryConfig: TaskRegistryConfig,
): Layer.Layer<TaskRunner, never, Storage | Alarm> {
  return Layer.effect(
    TaskRunner,
    Effect.gen(function* () {
      const storage = yield* Storage
      const alarm = yield* Alarm

      const dispatchFn: DispatchFn = {
        send: function dispatchSend(name: string, id: string, event: unknown): Effect.Effect<void, TaskError> {
          return Effect.gen(function* () {
            const task = registryConfig[name]
            if (!task) {
              return yield* Effect.fail(new TaskError({ message: `Sibling task "${name}" not found in registry` }))
            }
            const hctx: HandlerContext = { storage, alarm, dispatch: dispatchFn, id, name, systemFailure: null }
            yield* task.handleEvent(hctx, event).pipe(
              Effect.mapError((e) => new TaskError({ message: `Sibling dispatch error`, cause: e })),
            )
          })
        },
        getState: function dispatchGetState(name: string, id: string): Effect.Effect<unknown, TaskError> {
          return Effect.gen(function* () {
            const task = registryConfig[name]
            if (!task) {
              return yield* Effect.fail(new TaskError({ message: `Sibling task "${name}" not found in registry` }))
            }
            const hctx: HandlerContext = { storage, alarm, dispatch: dispatchFn, id, name, systemFailure: null }
            return yield* task.handleGetState(hctx).pipe(
              Effect.mapError((e) => new TaskError({ message: `Sibling getState error`, cause: e })),
            )
          })
        },
      }

      return {
        handleEvent: (name, id, event) =>
          Effect.gen(function* () {
            const task = registryConfig[name]
            if (!task) return yield* Effect.fail(new TaskNotFoundError({ name }))
            const hctx: HandlerContext = { storage, alarm, dispatch: dispatchFn, id, name, systemFailure: null }
            yield* task.handleEvent(hctx, event)
          }),

        handleAlarm: (name, id) =>
          Effect.gen(function* () {
            const task = registryConfig[name]
            if (!task) return yield* Effect.fail(new TaskNotFoundError({ name }))
            const hctx: HandlerContext = { storage, alarm, dispatch: dispatchFn, id, name, systemFailure: null }
            yield* task.handleAlarm(hctx)
          }),

        handleGetState: (name, id) =>
          Effect.gen(function* () {
            const task = registryConfig[name]
            if (!task) return yield* Effect.fail(new TaskNotFoundError({ name }))
            const hctx: HandlerContext = { storage, alarm, dispatch: dispatchFn, id, name, systemFailure: null }
            return yield* task.handleGetState(hctx)
          }),
      }
    }),
  )
}
