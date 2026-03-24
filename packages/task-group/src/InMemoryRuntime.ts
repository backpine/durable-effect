import { Effect } from "effect"
import type { TaskRegistryConfig } from "./TaskRegistry.js"
import type { DispatchFn, HandlerContext } from "./RegisteredTask.js"
import type { Storage } from "./services/Storage.js"
import type { Alarm } from "./services/Alarm.js"
import {
  TaskError,
  TaskNotFoundError,
  SystemFailure,
} from "./errors.js"
import type {
  TaskValidationError,
  TaskExecutionError,
} from "./errors.js"

// ---------------------------------------------------------------------------
// Instance — per-task-instance state, mirroring a Durable Object.
// Each name:id pair gets its own isolated storage and alarm.
// ---------------------------------------------------------------------------

interface Instance {
  readonly storage: Map<string, unknown>
  scheduledAlarm: number | null
  systemFailure: SystemFailure | null
}

// ---------------------------------------------------------------------------
// Helpers — create scoped Storage/Alarm services for a single instance
// ---------------------------------------------------------------------------

function makeInstanceStorage(data: Map<string, unknown>): Storage["Service"] {
  return {
    get: (key) => Effect.succeed(data.get(key) ?? null),
    set: (key, value) => Effect.sync(() => { data.set(key, value) }),
    delete: (key) => Effect.sync(() => { data.delete(key) }),
    deleteAll: () => Effect.sync(() => { data.clear() }),
  }
}

function makeInstanceAlarm(instance: Instance): Alarm["Service"] {
  return {
    set: (timestamp) => Effect.sync(() => { instance.scheduledAlarm = timestamp }),
    cancel: () => Effect.sync(() => { instance.scheduledAlarm = null }),
    next: () => Effect.sync(() => instance.scheduledAlarm),
  }
}

// ---------------------------------------------------------------------------
// ScheduledAlarm — public view of a pending alarm
// ---------------------------------------------------------------------------

export interface ScheduledAlarm {
  readonly name: string
  readonly id: string
  readonly timestamp: number
}

// ---------------------------------------------------------------------------
// InMemoryRuntime — a full in-memory adapter that mimics Durable Objects.
//
// Each task+id pair gets isolated storage and alarm state, just like a
// real DO instance. Alarms fire via tick(). System failures can be
// injected to test recovery paths.
// ---------------------------------------------------------------------------

export class InMemoryRuntime {
  private readonly instances = new Map<string, Instance>()
  private readonly dispatchFn: DispatchFn

  constructor(private readonly registryConfig: TaskRegistryConfig) {
    const self = this
    this.dispatchFn = {
      send(name: string, id: string, event: unknown): Effect.Effect<void, TaskError> {
        return Effect.gen(function* () {
          const task = self.registryConfig[name]
          if (!task) {
            return yield* Effect.fail(new TaskError({ message: `Sibling task "${name}" not found in registry` }))
          }
          const hctx = self.makeHandlerContext(name, id)
          yield* task.handleEvent(hctx, event).pipe(
            Effect.mapError((e) => new TaskError({ message: `Sibling dispatch error`, cause: e })),
          )
        })
      },
      getState(name: string, id: string): Effect.Effect<unknown, TaskError> {
        return Effect.gen(function* () {
          const task = self.registryConfig[name]
          if (!task) {
            return yield* Effect.fail(new TaskError({ message: `Sibling task "${name}" not found in registry` }))
          }
          const hctx = self.makeHandlerContext(name, id)
          return yield* task.handleGetState(hctx).pipe(
            Effect.mapError((e) => new TaskError({ message: `Sibling getState error`, cause: e })),
          )
        })
      },
    }
  }

  // ── Instance management ──────────────────────────────────

  private instanceKey(name: string, id: string): string {
    return `${name}:${id}`
  }

  private getOrCreateInstance(name: string, id: string): Instance {
    const key = this.instanceKey(name, id)
    let instance = this.instances.get(key)
    if (!instance) {
      instance = { storage: new Map(), scheduledAlarm: null, systemFailure: null }
      this.instances.set(key, instance)
    }
    return instance
  }

  private makeHandlerContext(name: string, id: string): HandlerContext {
    const instance = this.getOrCreateInstance(name, id)
    return {
      storage: makeInstanceStorage(instance.storage),
      alarm: makeInstanceAlarm(instance),
      dispatch: this.dispatchFn,
      id,
      name,
      systemFailure: instance.systemFailure,
    }
  }

  private parseInstanceKey(key: string): [name: string, id: string] {
    const idx = key.indexOf(":")
    return [key.slice(0, idx), key.slice(idx + 1)]
  }

  // ── External API — mimics what a worker/route would call ───

  /**
   * Send an event to a task instance. Creates the instance if it
   * doesn't exist yet (just like a DO is created on first access).
   */
  sendEvent(
    name: string,
    id: string,
    event: unknown,
  ): Effect.Effect<void, TaskNotFoundError | TaskValidationError | TaskExecutionError> {
    const self = this
    return Effect.gen(function* () {
      const task = self.registryConfig[name]
      if (!task) return yield* Effect.fail(new TaskNotFoundError({ name }))
      const hctx = self.makeHandlerContext(name, id)
      yield* task.handleEvent(hctx, event)
      // Clear system failure after successful handling
      self.getOrCreateInstance(name, id).systemFailure = null
    })
  }

  /**
   * Get the current state of a task instance.
   */
  getState(
    name: string,
    id: string,
  ): Effect.Effect<unknown, TaskNotFoundError | TaskExecutionError> {
    const self = this
    return Effect.gen(function* () {
      const task = self.registryConfig[name]
      if (!task) return yield* Effect.fail(new TaskNotFoundError({ name }))
      const hctx = self.makeHandlerContext(name, id)
      return yield* task.handleGetState(hctx)
    })
  }

  // ── Alarm management ─────────────────────────────────────

  /**
   * Directly fire the alarm handler for a specific instance.
   * Useful for testing alarm behavior without advancing time.
   */
  fireAlarm(
    name: string,
    id: string,
  ): Effect.Effect<void, TaskNotFoundError | TaskExecutionError> {
    const self = this
    return Effect.gen(function* () {
      const task = self.registryConfig[name]
      if (!task) return yield* Effect.fail(new TaskNotFoundError({ name }))
      const instance = self.getOrCreateInstance(name, id)
      instance.scheduledAlarm = null
      const hctx = self.makeHandlerContext(name, id)
      yield* task.handleAlarm(hctx)
      instance.systemFailure = null
    })
  }

  /**
   * Advance time and fire all alarms that are due. Returns the number
   * of alarms fired. Defaults to Date.now() if no timestamp provided.
   */
  tick(
    now?: number,
  ): Effect.Effect<number, TaskExecutionError> {
    const self = this
    const currentTime = now ?? Date.now()
    return Effect.gen(function* () {
      // Collect alarms to fire (avoid mutating while iterating)
      const toFire: Array<{ name: string; id: string; instance: Instance }> = []
      for (const [key, instance] of self.instances) {
        if (instance.scheduledAlarm !== null && instance.scheduledAlarm <= currentTime) {
          const [name, id] = self.parseInstanceKey(key)
          toFire.push({ name, id, instance })
        }
      }

      for (const { name, id, instance } of toFire) {
        const task = self.registryConfig[name]
        if (task) {
          instance.scheduledAlarm = null
          const hctx = self.makeHandlerContext(name, id)
          yield* task.handleAlarm(hctx)
          instance.systemFailure = null
        }
      }

      return toFire.length
    })
  }

  /**
   * Get all currently scheduled alarms across all instances.
   */
  getScheduledAlarms(): ReadonlyArray<ScheduledAlarm> {
    const alarms: ScheduledAlarm[] = []
    for (const [key, instance] of this.instances) {
      if (instance.scheduledAlarm !== null) {
        const [name, id] = this.parseInstanceKey(key)
        alarms.push({ name, id, timestamp: instance.scheduledAlarm })
      }
    }
    return alarms
  }

  // ── System failure injection ─────────────────────────────

  /**
   * Inject a system failure for a specific instance. The next handler
   * invocation for this instance will have ctx.systemFailure set.
   * Simulates a DO crash/restart.
   */
  injectSystemFailure(name: string, id: string, failure: SystemFailure): void {
    const instance = this.getOrCreateInstance(name, id)
    instance.systemFailure = failure
  }

  // ── Instance inspection (for test assertions) ────────────

  hasInstance(name: string, id: string): boolean {
    return this.instances.has(this.instanceKey(name, id))
  }

  getInstanceStorage(name: string, id: string): ReadonlyMap<string, unknown> | undefined {
    return this.instances.get(this.instanceKey(name, id))?.storage
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

export function makeInMemoryRuntime(registryConfig: TaskRegistryConfig): InMemoryRuntime {
  return new InMemoryRuntime(registryConfig)
}
