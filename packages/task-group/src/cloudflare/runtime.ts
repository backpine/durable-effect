import { Effect } from "effect"
import type { TaskRegistryConfig } from "../TaskRegistry.js"
import type { DispatchFn, HandlerContext } from "../RegisteredTask.js"
import type { TaskRuntime } from "../TaskRuntime.js"
import {
  TaskError,
  TaskNotFoundError,
  TaskExecutionError,
  SystemFailure,
} from "../errors.js"
import type { TaskValidationError } from "../errors.js"
import { makeCloudflareStorage } from "./storage.js"
import { makeCloudflareAlarm } from "./alarm.js"
import type {
  DurableObjectStateLike,
  DurableObjectNamespaceLike,
  AlarmInvocationInfoLike,
} from "./types.js"

// ---------------------------------------------------------------------------
// Routing keys — stored in DO storage so alarm() knows which task to fire
// ---------------------------------------------------------------------------

const ROUTING_NAME_KEY = "__tg:name"
const ROUTING_ID_KEY = "__tg:id"

// ---------------------------------------------------------------------------
// makeTaskGroupDO — factory that returns a DO class + client creator.
//
// The DO class and client share a closure for the namespace reference.
// .client(namespace) stores it; the DO reads it for sibling dispatch.
// ---------------------------------------------------------------------------

export function makeTaskGroupDO(registryConfig: TaskRegistryConfig): {
  /** The Durable Object class. Export this for wrangler. */
  readonly DO: {
    new (ctx: DurableObjectStateLike, env: unknown): {
      handleEvent(name: string, id: string, event: unknown): Promise<void>
      handleAlarm(name: string, id: string): Promise<void>
      handleGetState(name: string, id: string): Promise<unknown>
      alarm(alarmInfo?: AlarmInvocationInfoLike): Promise<void>
    }
  }

  /** Create a runtime bound to a DO namespace. */
  readonly client: (namespace: DurableObjectNamespaceLike) => TaskRuntime
} {
  // Shared between DO and client — set by client(), read by DO constructor
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

  class TaskGroupDOImpl {
    private storageService: ReturnType<typeof makeCloudflareStorage>
    private alarmService: ReturnType<typeof makeCloudflareAlarm>
    private dispatchFn: DispatchFn
    private currentSystemFailure: SystemFailure | null = null
    private ctx: DurableObjectStateLike

    constructor(ctx: DurableObjectStateLike, _env: unknown) {
      this.ctx = ctx
      this.storageService = makeCloudflareStorage(ctx.storage)
      this.alarmService = makeCloudflareAlarm(ctx.storage)

      // Use shared namespace for sibling dispatch (set by client())
      if (sharedNamespace) {
        this.dispatchFn = makeDispatchForNamespace(sharedNamespace)
      } else {
        // No namespace available — sibling dispatch will fail with a clear error
        this.dispatchFn = {
          send: () => Effect.fail(new TaskError({
            message: "Sibling dispatch not available: client() has not been called. "
              + "Call taskGroup.client(env.YOUR_BINDING) before the DO is instantiated.",
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

      // Store routing keys so alarm() can find the right task
      await this.ctx.storage.put(ROUTING_NAME_KEY, name)
      await this.ctx.storage.put(ROUTING_ID_KEY, id)

      const hctx = this.makeHandlerContext(name, id)
      await Effect.runPromise(task.handleEvent(hctx, event))

      this.currentSystemFailure = null
    }

    async handleAlarm(name: string, id: string): Promise<void> {
      const task = registryConfig[name]
      if (!task) throw new Error(`Task "${name}" not found in registry`)

      const hctx = this.makeHandlerContext(name, id)
      await Effect.runPromise(task.handleAlarm(hctx))

      this.currentSystemFailure = null
    }

    async handleGetState(name: string, id: string): Promise<unknown> {
      const task = registryConfig[name]
      if (!task) throw new Error(`Task "${name}" not found in registry`)

      const hctx = this.makeHandlerContext(name, id)
      return await Effect.runPromise(task.handleGetState(hctx))
    }

    // CF lifecycle — called when a scheduled alarm fires
    async alarm(alarmInfo?: AlarmInvocationInfoLike): Promise<void> {
      // Detect system failure: CF retries alarms after crashes
      if (alarmInfo && alarmInfo.isRetry) {
        this.currentSystemFailure = new SystemFailure({
          message: `Alarm retry #${alarmInfo.retryCount} — previous attempt failed`,
        })
      }

      // Read routing keys to know which task to fire
      const taskName = await this.ctx.storage.get(ROUTING_NAME_KEY)
      const taskId = await this.ctx.storage.get(ROUTING_ID_KEY)

      if (typeof taskName !== "string" || typeof taskId !== "string") {
        // No routing info — can't fire alarm
        return
      }

      await this.handleAlarm(taskName, taskId)
    }
  }

  // ── The client ─────────────────────────────────────────

  function client(namespace: DurableObjectNamespaceLike): TaskRuntime {
    // Store namespace for the DO class to use for sibling dispatch
    sharedNamespace = namespace

    function getStub(name: string, id: string) {
      const doId = namespace.idFromName(`${name}:${id}`)
      return namespace.get(doId)
    }

    return {
      sendEvent(
        name: string,
        id: string,
        event: unknown,
      ): Effect.Effect<void, TaskNotFoundError | TaskValidationError | TaskExecutionError> {
        return Effect.tryPromise({
          try: () => getStub(name, id).handleEvent(name, id, event),
          catch: (cause) => new TaskExecutionError({ cause }),
        })
      },

      getState(
        name: string,
        id: string,
      ): Effect.Effect<unknown, TaskNotFoundError | TaskExecutionError> {
        return Effect.tryPromise({
          try: () => getStub(name, id).handleGetState(name, id),
          catch: (cause) => new TaskExecutionError({ cause }),
        })
      },

      fireAlarm(
        name: string,
        id: string,
      ): Effect.Effect<void, TaskNotFoundError | TaskExecutionError> {
        return Effect.tryPromise({
          try: () => getStub(name, id).handleAlarm(name, id),
          catch: (cause) => new TaskExecutionError({ cause }),
        })
      },
    }
  }

  return { DO: TaskGroupDOImpl, client }
}
