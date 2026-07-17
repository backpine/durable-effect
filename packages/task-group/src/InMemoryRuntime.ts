import { Effect, Layer, Schema, Scope } from "effect"
import type { BuiltRegistry, TaskRegistryConfig } from "./TaskRegistry.js"
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
// Instance — per-task-instance state, mirroring a Durable Object. Each instance
// owns a MemoMap + long-lived Scope so hook layers (e.g. a DB pool) build once
// per instance and are reused across every event and alarm.
// ---------------------------------------------------------------------------

interface Instance {
  readonly storage: Map<string, unknown>
  scheduledAlarm: number | null
  systemFailure: SystemFailure | null
  readonly memoMap: Layer.MemoMap
  readonly scope: Scope.Closeable
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
// ScheduledAlarm
// ---------------------------------------------------------------------------

export interface ScheduledAlarm {
  readonly name: string
  readonly id: string
  readonly timestamp: number
}

// ---------------------------------------------------------------------------
// InMemoryRuntime — multi-instance test runtime. Handlers keep their residual
// requirement (the platform env, Renv); the runtime provides it via a single
// `services` Layer while per-hook service layers build/memoize per instance.
// ---------------------------------------------------------------------------

export class InMemoryRuntime<Tags extends AnyTaskTag, Renv = never> implements TypedTaskRuntime<Tags> {
  private readonly instances = new Map<string, Instance>()
  private readonly dispatchFn: DispatchFn
  private readonly registryConfig: TaskRegistryConfig<Renv>
  private readonly tagMap: ReadonlyMap<string, Tags>
  private readonly servicesLayer: Layer.Layer<Renv>

  constructor(built: BuiltRegistry<Tags, Renv>, servicesLayer: Layer.Layer<Renv>) {
    this.registryConfig = built.registryConfig
    this.tagMap = built.tags
    this.servicesLayer = servicesLayer
    const self = this
    this.dispatchFn = {
      send(name: string, id: string, event: unknown): Effect.Effect<void, TaskError> {
        return Effect.gen(function* () {
          const task = self.registryConfig[name]
          if (!task) {
            return yield* Effect.fail(new TaskError({ message: `Sibling task "${name}" not found in registry` }))
          }
          const hctx = self.makeHandlerContext(name, id)
          yield* self.run(
            task.handleEvent(hctx, event).pipe(
              Effect.mapError((e) => new TaskError({ message: `Sibling dispatch error`, cause: e })),
            ),
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
          return yield* self.run(
            task.handleGetState(hctx).pipe(
              Effect.mapError((e) => new TaskError({ message: `Sibling getState error`, cause: e })),
            ),
          )
        })
      },
    }
  }

  // ── Residual env provision ───────────────────────────────
  // Provide the platform env (Renv) to a handler effect. Per-hook service
  // layers are already built via the instance MemoMap inside the handler; this
  // only resolves the residual env so the effect can run with R = never.
  private run<A, E>(eff: Effect.Effect<A, E, Renv>): Effect.Effect<A, E> {
    return Effect.provide(eff, this.servicesLayer)
  }

  // ── Instance management ──────────────────────────────────

  private instanceKey(name: string, id: string): string {
    return `${name}:${id}`
  }

  private getOrCreateInstance(name: string, id: string): Instance {
    const key = this.instanceKey(name, id)
    let instance = this.instances.get(key)
    if (!instance) {
      instance = {
        storage: new Map(),
        scheduledAlarm: null,
        systemFailure: null,
        memoMap: Layer.makeMemoMapUnsafe(),
        scope: Scope.makeUnsafe(),
      }
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
      memoMap: instance.memoMap,
      scope: instance.scope,
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
          yield* self.run(task.handleEvent(hctx, event))
          self.getOrCreateInstance(name, id).systemFailure = null
        })
      },
      getState(id: string): Effect.Effect<StateFor<Tags, K> | null, TaskExecutionError> {
        return Effect.gen(function* () {
          const task = self.registryConfig[name]
          if (!task) return yield* Effect.fail(new TaskExecutionError({ cause: `Task "${name}" not found` }))
          const hctx = self.makeHandlerContext(name, id)
          const raw = yield* self.run(task.handleGetState(hctx))
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
          yield* self.run(task.handleAlarm(hctx))
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
          yield* self.run(task.handleAlarm(hctx))
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

/**
 * Create an in-memory runtime. When the registry has a residual env (R != never
 * — e.g. handlers use env-dependent service layers), `services` is required and
 * provides it; when R = never, no options are needed.
 */
export function makeInMemoryRuntime<Tags extends AnyTaskTag, R = never>(
  built: BuiltRegistry<Tags, R>,
  ...options: [R] extends [never] ? [] : [{ readonly services: Layer.Layer<R> }]
): InMemoryRuntime<Tags, R> {
  const opts = options as ReadonlyArray<{ readonly services: Layer.Layer<R> }>
  // No residual env (R = never) → the empty layer provides nothing.
  const servicesLayer = opts[0]?.services ?? (Layer.empty as unknown as Layer.Layer<R>)
  return new InMemoryRuntime<Tags, R>(built, servicesLayer)
}
