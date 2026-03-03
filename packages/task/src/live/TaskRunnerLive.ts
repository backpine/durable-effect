import { Effect, Layer } from "effect"
import { TaskRunner } from "../services/TaskRunner.js"
import { TaskRegistry } from "../services/TaskRegistry.js"
import { Storage } from "../services/Storage.js"
import { Alarm } from "../services/Alarm.js"
import { TaskNotFoundError } from "../errors.js"

// ---------------------------------------------------------------------------
// TaskRunnerLive — constructs the TaskRunner from Registry + Storage + Alarm
//
// The runner captures the registry, storage, and alarm at construction time.
// Each handleEvent/handleAlarm call looks up the task by name in the registry
// and delegates to the registered task's pre-built handler closures.
// ---------------------------------------------------------------------------

export const TaskRunnerLive: Layer.Layer<
  TaskRunner,
  never,
  TaskRegistry | Storage | Alarm
> = Layer.effect(
  TaskRunner,
  Effect.gen(function* () {
    const registry = yield* TaskRegistry
    const storage = yield* Storage
    const alarm = yield* Alarm

    return {
      handleEvent: (name, id, event) =>
        Effect.gen(function* () {
          const task = registry.get(name)
          if (task === undefined) {
            return yield* Effect.fail(new TaskNotFoundError({ name }))
          }
          yield* task.handleEvent(storage, alarm, id, name, event)
        }),

      handleAlarm: (name, id) =>
        Effect.gen(function* () {
          const task = registry.get(name)
          if (task === undefined) {
            return yield* Effect.fail(new TaskNotFoundError({ name }))
          }
          yield* task.handleAlarm(storage, alarm, id, name)
        }),
    }
  }),
)
