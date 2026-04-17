import { DurableObject } from "cloudflare:workers"
import { Effect, Layer, Schema } from "effect"
import type { BuiltRegistry, TaskRegistryConfig } from "../TaskRegistry.js"
import type { DispatchFn, HandlerContext } from "../RegisteredTask.js"
import type { AnyTaskTag, StateFor, EventFor } from "../TaskTag.js"
import type { TypedTaskRuntime, ExternalTaskHandle } from "../TaskRuntime.js"
import {
  TaskError,
  TaskNotFoundError,
  TaskExecutionError,
  SystemFailure,
} from "../errors.js"
import type { TaskValidationError } from "../errors.js"
import { makeCloudflareStorage } from "./storage.js"
import { makeCloudflareAlarm } from "./alarm.js"
import { CloudflareEnv } from "./CloudflareEnv.js"
import type {
  DurableObjectStateLike,
  DurableObjectStorageLike,
  DurableObjectNamespaceLike,
  AlarmInvocationInfoLike,
} from "./types.js"

// ---------------------------------------------------------------------------
// Routing keys
// ---------------------------------------------------------------------------

const ROUTING_NAME_KEY = "__tg:name"
const ROUTING_ID_KEY = "__tg:id"

// ---------------------------------------------------------------------------
// makeTaskGroupDO
// ---------------------------------------------------------------------------

interface TaskGroupDO<Tags extends AnyTaskTag> {
  readonly DO: {
    new (ctx: DurableObjectStateLike, env: unknown): {
      handleEvent(name: string, id: string, event: unknown): Promise<void>
      handleAlarm(name: string, id: string): Promise<void>
      handleGetState(name: string, id: string): Promise<unknown>
      alarm(alarmInfo?: AlarmInvocationInfoLike): Promise<void>
    }
  }
  readonly client: (namespace: DurableObjectNamespaceLike) => TypedTaskRuntime<Tags>
}

// Overloads: R = never (all services pre-resolved) or R = CloudflareEnv (deferred)
export function makeTaskGroupDO<Tags extends AnyTaskTag>(built: BuiltRegistry<Tags, never>): TaskGroupDO<Tags>
export function makeTaskGroupDO<Tags extends AnyTaskTag>(built: BuiltRegistry<Tags, CloudflareEnv>): TaskGroupDO<Tags>
// Implementation: R is concretely CloudflareEnv (never is a subtype, so both overloads are covered)
export function makeTaskGroupDO<Tags extends AnyTaskTag>(built: BuiltRegistry<Tags, CloudflareEnv>): TaskGroupDO<Tags> {
  const registryConfig = built.registryConfig
  const tagMap = built.tags
  let sharedNamespace: DurableObjectNamespaceLike | null = null

  // ── Dispatch function builder ──────────────────────────

  function makeDispatchForNamespace(namespace: DurableObjectNamespaceLike): DispatchFn {
    return {
      send(name: string, id: string, event: unknown): Effect.Effect<void, TaskError> {
        return Effect.tryPromise({
          try: () => {
            const doId = namespace.idFromName(`${name}:${id}`)
            const stub = namespace.get(doId)
            return stub.handleEvent(name, id, event)
          },
          catch: (cause) =>
            new TaskError({ message: `Sibling dispatch error`, cause }),
        })
      },
      getState(name: string, id: string): Effect.Effect<unknown, TaskError> {
        return Effect.tryPromise({
          try: () => {
            const doId = namespace.idFromName(`${name}:${id}`)
            const stub = namespace.get(doId)
            return stub.handleGetState(name, id)
          },
          catch: (cause) =>
            new TaskError({ message: `Sibling getState error`, cause }),
        })
      },
    }
  }

  // ── The DO class ───────────────────────────────────────

  class TaskGroupDOImpl extends DurableObject {
    private doStorage: DurableObjectStorageLike
    private storageService: ReturnType<typeof makeCloudflareStorage>
    private alarmService: ReturnType<typeof makeCloudflareAlarm>
    private dispatchFn: DispatchFn
    private currentSystemFailure: SystemFailure | null = null

    // Layer that provides CloudflareEnv from the DO's env parameter.
    // Effect.provide(effect, envLayer) uses Exclude<R, CloudflareEnvId> to
    // naturally eliminate R when R = CloudflareEnvId, and is a no-op when
    // R = never. No type assertions needed.
    private envLayer: Layer.Layer<CloudflareEnv>

    constructor(ctx: DurableObjectStateLike, env: unknown) {
      super(ctx, env)
      this.doStorage = ctx.storage
      this.storageService = makeCloudflareStorage(this.doStorage)
      this.alarmService = makeCloudflareAlarm(this.doStorage)
      this.envLayer = Layer.succeed(CloudflareEnv)(env)

      if (sharedNamespace) {
        this.dispatchFn = makeDispatchForNamespace(sharedNamespace)
      } else {
        this.dispatchFn = {
          send: () => Effect.fail(new TaskError({
            message: "Sibling dispatch not available: client() has not been called.",
          })),
          getState: () => Effect.fail(new TaskError({
            message: "Sibling getState not available: client() has not been called.",
          })),
        }
      }
    }

    private makeHandlerContext(name: string, id: string): HandlerContext {
      return {
        storage: this.storageService,
        alarm: this.alarmService,
        dispatch: this.dispatchFn,
        id,
        name,
        systemFailure: this.currentSystemFailure,
      }
    }

    async handleEvent(name: string, id: string, event: unknown): Promise<void> {
      const task = registryConfig[name]
      if (!task) throw new Error(`Task "${name}" not found in registry`)

      await this.doStorage.put(ROUTING_NAME_KEY, name)
      await this.doStorage.put(ROUTING_ID_KEY, id)

      const hctx = this.makeHandlerContext(name, id)
      await Effect.runPromise(
        Effect.provide(task.handleEvent(hctx, event), this.envLayer),
      )

      this.currentSystemFailure = null
    }

    async handleAlarm(name: string, id: string): Promise<void> {
      const task = registryConfig[name]
      if (!task) throw new Error(`Task "${name}" not found in registry`)

      const hctx = this.makeHandlerContext(name, id)
      await Effect.runPromise(
        Effect.provide(task.handleAlarm(hctx), this.envLayer),
      )

      this.currentSystemFailure = null
    }

    async handleGetState(name: string, id: string): Promise<unknown> {
      const task = registryConfig[name]
      if (!task) throw new Error(`Task "${name}" not found in registry`)

      const hctx = this.makeHandlerContext(name, id)
      return await Effect.runPromise(
        Effect.provide(task.handleGetState(hctx), this.envLayer),
      )
    }

    async alarm(alarmInfo?: AlarmInvocationInfoLike): Promise<void> {
      if (alarmInfo && alarmInfo.isRetry) {
        this.currentSystemFailure = new SystemFailure({
          message: `Alarm retry #${alarmInfo.retryCount} — previous attempt failed`,
        })
      }

      const taskName = await this.doStorage.get(ROUTING_NAME_KEY)
      const taskId = await this.doStorage.get(ROUTING_ID_KEY)

      if (typeof taskName !== "string" || typeof taskId !== "string") return

      await this.handleAlarm(taskName, taskId)
    }
  }

  // ── The client ─────────────────────────────────────────

  function client(namespace: DurableObjectNamespaceLike): TypedTaskRuntime<Tags> {
    sharedNamespace = namespace

    return {
      task<K extends Tags["name"]>(name: K): ExternalTaskHandle<StateFor<Tags, K>, EventFor<Tags, K>> {
        const tag = tagMap.get(name)

        function getStub(id: string) {
          const doId = namespace.idFromName(`${name}:${id}`)
          return namespace.get(doId)
        }

        return {
          send(id: string, event: EventFor<Tags, K>): Effect.Effect<void, TaskValidationError | TaskExecutionError> {
            return Effect.tryPromise({
              try: () => getStub(id).handleEvent(name, id, event),
              catch: (cause) => new TaskExecutionError({ cause }),
            })
          },
          getState(id: string): Effect.Effect<StateFor<Tags, K> | null, TaskExecutionError> {
            return Effect.gen(function* () {
              const raw = yield* Effect.tryPromise({
                try: () => getStub(id).handleGetState(name, id),
                catch: (cause) => new TaskExecutionError({ cause }),
              })
              if (raw === null) return null
              if (!tag) return yield* Effect.fail(new TaskExecutionError({ cause: new Error(`Tag "${name}" not found`) }))
              return yield* Schema.decodeUnknownEffect(tag.state)(raw).pipe(
                Effect.mapError((e) => new TaskExecutionError({ cause: e })),
              )
            })
          },
          fireAlarm(id: string): Effect.Effect<void, TaskExecutionError> {
            return Effect.tryPromise({
              try: () => getStub(id).handleAlarm(name, id),
              catch: (cause) => new TaskExecutionError({ cause }),
            })
          },
        }
      },
    }
  }

  return { DO: TaskGroupDOImpl, client }
}
