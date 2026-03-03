import { Effect, Layer } from "effect"
import { TaskRunner } from "../services/TaskRunner.js"
import type { TaskRegistryConfig } from "../services/TaskRegistry.js"
import { buildRegistryLayer } from "../services/TaskRegistry.js"
import { TaskRunnerLive } from "../live/TaskRunnerLive.js"
import { makeCloudflareStorage } from "./CloudflareStorage.js"
import { makeCloudflareAlarm } from "./CloudflareAlarm.js"
import type { DurableObjectStorageMethods } from "./CloudflareStorage.js"
import type { DurableObjectAlarmMethods } from "./CloudflareAlarm.js"

// ---------------------------------------------------------------------------
// Minimal structural interface for CF DurableObjectState
// ---------------------------------------------------------------------------

export interface DurableObjectState {
  readonly id: { toString(): string }
  readonly storage: DurableObjectStorageMethods & DurableObjectAlarmMethods
}

// ---------------------------------------------------------------------------
// TaskEngine — wires CF Durable Object into the task-v2 runtime
//
// Usage:
//   class MyTaskDO {
//     private engine: ReturnType<typeof makeTaskEngine>
//     constructor(state: DurableObjectState) {
//       this.engine = makeTaskEngine(state, {
//         name: "counter",
//         tasks: { counter: registerTask(counterTask) },
//       })
//     }
//     fetch(request: Request) { return this.engine.fetch(request) }
//     alarm() { return this.engine.alarm() }
//   }
// ---------------------------------------------------------------------------

export function makeTaskEngine(
  state: DurableObjectState,
  config: { name: string; tasks: TaskRegistryConfig },
): {
  fetch: (request: Request) => Promise<Response>
  alarm: () => Promise<void>
} {
  const id = state.id.toString()

  const storageLayer = makeCloudflareStorage(state.storage)
  const alarmLayer = makeCloudflareAlarm(state.storage)
  const registryLayer = buildRegistryLayer(config.tasks)

  const depsLayer = Layer.mergeAll(registryLayer, storageLayer, alarmLayer)
  const runnerLayer = Layer.provide(TaskRunnerLive, depsLayer)

  const runWithRunner = <A, E>(
    fn: (runner: TaskRunner["Service"]) => Effect.Effect<A, E>,
  ): Promise<A> =>
    Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runner = yield* TaskRunner
          return yield* fn(runner)
        }),
        runnerLayer,
      ),
    )

  return {
    fetch: async (request: Request): Promise<Response> => {
      try {
        const body = (await request.json()) as {
          type: string
          name?: string
          id?: string
          event?: unknown
        }

        const taskName = body.name ?? config.name
        const taskId = body.id ?? id

        if (body.type === "event") {
          await runWithRunner((runner) =>
            runner.handleEvent(taskName, taskId, body.event),
          )
          // Store routing keys so alarm() can find the right task
          await state.storage.put("__taskName", taskName)
          await state.storage.put("__taskId", taskId)
          return new Response("ok", { status: 200 })
        }

        if (body.type === "alarm") {
          await runWithRunner((runner) =>
            runner.handleAlarm(taskName, taskId),
          )
          return new Response("ok", { status: 200 })
        }

        return new Response(
          JSON.stringify({ error: `Unknown type: ${body.type}` }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        )
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Internal error"
        return new Response(JSON.stringify({ error: message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        })
      }
    },

    alarm: async (): Promise<void> => {
      const storedName = (await state.storage.get("__taskName")) as
        | string
        | undefined
      const storedId = (await state.storage.get("__taskId")) as
        | string
        | undefined
      const alarmName = storedName ?? config.name
      const alarmId = storedId ?? id
      await runWithRunner((runner) => runner.handleAlarm(alarmName, alarmId))
    },
  }
}
