import { Effect, Layer, Schema } from "effect"
import type { BuiltRegistry, TaskRegistryConfig } from "./TaskRegistry.js"
import type { RegisteredTask } from "./RegisteredTask.js"
import type { DispatchFn, HandlerContext } from "./RegisteredTask.js"
import type { Storage } from "./services/Storage.js"
import type { Alarm } from "./services/Alarm.js"
import type { AnyTaskTag, StateFor, EventFor } from "./TaskTag.js"
import type { TypedTaskRuntime, ExternalTaskHandle } from "./TaskRuntime.js"
import {
  TaskError,
  TaskExecutionError,
  SystemFailure,
} from "./errors.js"
import type {
  TaskValidationError,
} from "./errors.js"

// ---------------------------------------------------------------------------
// Instance — per-task-instance state, mirroring a Durable Object.
// ---------------------------------------------------------------------------

interface Instance {
  readonly storage: Map<string, unknown>
  scheduledAlarm: number | null
  systemFailure: SystemFailure | null
}

// ---------------------------------------------------------------------------
// Helpers
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
// resolveRegistry — wraps each registered task's effects with
// Effect.provide(layer) to eliminate R, producing a TaskRegistryConfig<never>.
// ---------------------------------------------------------------------------

function resolveRegistry<R>(
  config: TaskRegistryConfig<R>,
  layer: Layer.Layer<R>,
): TaskRegistryConfig<never> {
  const resolved: TaskRegistryConfig<never> = {}
  for (const [name, task] of Object.entries(config)) {
    resolved[name] = {
      handleEvent: (hctx, event) => Effect.provide(task.handleEvent(hctx, event), layer),
      handleAlarm: (hctx) => Effect.provide(task.handleAlarm(hctx), layer),
      handleGetState: (hctx) => Effect.provide(task.handleGetState(hctx), layer),
    }
  }
  return resolved
}

// ---------------------------------------------------------------------------
// ScheduledAlarm
// ---------------------------------------------------------------------------

export interface ScheduledAlarm {
  readonly name: string
  readonly id: string
  readonly timestamp: number
}

// ---------------------------------------------------------------------------
// InMemoryRuntime — always operates on fully resolved effects (R = never).
// When the user has deferred services, the factory resolves them before
// constructing the runtime.
// ---------------------------------------------------------------------------

export class InMemoryRuntime<Tags extends AnyTaskTag> implements TypedTaskRuntime<Tags> {
  private readonly instances = new Map<string, Instance>()
  private readonly dispatchFn: DispatchFn
  private readonly registryConfig: TaskRegistryConfig<never>
  private readonly tagMap: ReadonlyMap<string, Tags>

  constructor(built: BuiltRegistry<Tags, never>) {
    this.registryConfig = built.registryConfig
    this.tagMap = built.tags
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

  // ── Typed API — .task(name) ────────────────────────────

  task<K extends Tags["name"]>(name: K): ExternalTaskHandle<StateFor<Tags, K>, EventFor<Tags, K>> {
    const self = this
    const tag = this.tagMap.get(name)
    return {
      send(id: string, event: EventFor<Tags, K>): Effect.Effect<void, TaskValidationError | TaskExecutionError> {
        return Effect.gen(function* () {
          const task = self.registryConfig[name]
          if (!task) return yield* Effect.fail(new TaskExecutionError({ cause: `Task "${name}" not found` }))
          const hctx = self.makeHandlerContext(name, id)
          yield* task.handleEvent(hctx, event)
          self.getOrCreateInstance(name, id).systemFailure = null
        })
      },
      getState(id: string): Effect.Effect<StateFor<Tags, K> | null, TaskExecutionError> {
        return Effect.gen(function* () {
          const task = self.registryConfig[name]
          if (!task) return yield* Effect.fail(new TaskExecutionError({ cause: `Task "${name}" not found` }))
          const hctx = self.makeHandlerContext(name, id)
          const raw = yield* task.handleGetState(hctx)
          if (raw === null) return null
          if (!tag) return yield* Effect.fail(new TaskExecutionError({ cause: `Tag "${name}" not found` }))
          return yield* Schema.decodeUnknownEffect(tag.state)(raw).pipe(
            Effect.mapError((e) => new TaskExecutionError({ cause: e })),
          )
        })
      },
      fireAlarm(id: string): Effect.Effect<void, TaskExecutionError> {
        return Effect.gen(function* () {
          const task = self.registryConfig[name]
          if (!task) return yield* Effect.fail(new TaskExecutionError({ cause: `Task "${name}" not found` }))
          const instance = self.getOrCreateInstance(name, id)
          instance.scheduledAlarm = null
          const hctx = self.makeHandlerContext(name, id)
          yield* task.handleAlarm(hctx)
          instance.systemFailure = null
        })
      },
    }
  }

  // ── Alarm management ─────────────────────────────────────

  tick(now?: number): Effect.Effect<number, TaskExecutionError> {
    const self = this
    const currentTime = now ?? Date.now()
    return Effect.gen(function* () {
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

  injectSystemFailure(name: string, id: string, failure: SystemFailure): void {
    const instance = this.getOrCreateInstance(name, id)
    instance.systemFailure = failure
  }

  // ── Instance inspection ──────────────────────────────────

  hasInstance(name: string, id: string): boolean {
    return this.instances.has(this.instanceKey(name, id))
  }

  getInstanceStorage(name: string, id: string): ReadonlyMap<string, unknown> | undefined {
    return this.instances.get(this.instanceKey(name, id))?.storage
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create from a fully resolved registry (R = never). */
export function makeInMemoryRuntime<Tags extends AnyTaskTag>(
  built: BuiltRegistry<Tags, never>,
): InMemoryRuntime<Tags>

/** Create from a registry with deferred services — the layer resolves R. */
export function makeInMemoryRuntime<Tags extends AnyTaskTag, R>(
  built: BuiltRegistry<Tags, R>,
  options: { services: Layer.Layer<R> },
): InMemoryRuntime<Tags>

// Implementation
export function makeInMemoryRuntime<Tags extends AnyTaskTag, R>(
  built: BuiltRegistry<Tags, R>,
  options?: { services: Layer.Layer<R> },
): InMemoryRuntime<Tags> {
  if (options?.services) {
    // Resolve R by wrapping each task's effects with Effect.provide(layer).
    // Effect.provide(Effect<A, E, R>, Layer<R>) → Effect<A, E, never>
    const resolved: BuiltRegistry<Tags, never> = {
      registryConfig: resolveRegistry(built.registryConfig, options.services),
      tags: built.tags,
    }
    return new InMemoryRuntime(resolved)
  }
  // R = never (enforced by overload), so built is already BuiltRegistry<Tags, never>
  return new InMemoryRuntime(built as BuiltRegistry<Tags, never>)
}
