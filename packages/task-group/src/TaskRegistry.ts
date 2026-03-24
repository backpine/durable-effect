import { Effect, type Layer } from "effect"
import type { TaskCtx } from "./TaskCtx.js"
import type { AnyTaskTag, StateFor, EventFor } from "./TaskTag.js"
import type { RegisteredTask, ResolvedHandlerConfig } from "./RegisteredTask.js"
import { buildRegisteredTask } from "./RegisteredTask.js"

// ---------------------------------------------------------------------------
// TaskHandler — opaque result of registry.handler(). Carries the task name
// as a type-level literal so build() can validate completeness.
// ---------------------------------------------------------------------------

export interface TaskHandler<K extends string> {
  readonly _name: K
  readonly registered: RegisteredTask
}

// ---------------------------------------------------------------------------
// TaskRegistryConfig — type-erased map of name → RegisteredTask
// This is what the runner consumes.
// ---------------------------------------------------------------------------

export type TaskRegistryConfig = Record<string, RegisteredTask>

// ---------------------------------------------------------------------------
// Handler definitions — each channel (event/alarm) can be either a plain
// function (no error handler) or an object with { handler, onError }.
//
// The nested object form ensures TypeScript infers the error type from
// `handler` and applies it to `onError` within the same inference scope,
// regardless of property ordering.
// ---------------------------------------------------------------------------

/** Plain function — no error handler for this channel */
type EventHandlerFn<S, E, EErr, Tags extends AnyTaskTag, R> =
  (ctx: TaskCtx<S, Tags>, event: E) => Effect.Effect<void, EErr, R>

/** Object with co-located error handler — error type flows from handler to onError */
interface EventHandlerWithError<S, E, EErr, Tags extends AnyTaskTag, R, OEErr = never> {
  readonly handler: (ctx: TaskCtx<S, Tags>, event: E) => Effect.Effect<void, EErr, R>
  readonly onError: (ctx: TaskCtx<S, Tags>, error: EErr) => Effect.Effect<void, OEErr, R>
}

/** Either form */
type EventDef<S, E, EErr, Tags extends AnyTaskTag, R, OEErr = never> =
  | EventHandlerFn<S, E, EErr, Tags, R>
  | EventHandlerWithError<S, E, EErr, Tags, R, OEErr>

/** Plain function — no error handler for this channel */
type AlarmHandlerFn<S, AErr, Tags extends AnyTaskTag, R> =
  (ctx: TaskCtx<S, Tags>) => Effect.Effect<void, AErr, R>

/** Object with co-located error handler */
interface AlarmHandlerWithError<S, AErr, Tags extends AnyTaskTag, R, OAErr = never> {
  readonly handler: (ctx: TaskCtx<S, Tags>) => Effect.Effect<void, AErr, R>
  readonly onError: (ctx: TaskCtx<S, Tags>, error: AErr) => Effect.Effect<void, OAErr, R>
}

/** Either form */
type AlarmDef<S, AErr, Tags extends AnyTaskTag, R, OAErr = never> =
  | AlarmHandlerFn<S, AErr, Tags, R>
  | AlarmHandlerWithError<S, AErr, Tags, R, OAErr>

// ---------------------------------------------------------------------------
// HandlerConfig — what the user passes to registry.handler()
// ---------------------------------------------------------------------------

export interface HandlerConfig<S, E, EErr, AErr, Tags extends AnyTaskTag, R = never, OEErr = never, OAErr = never> {
  readonly onEvent: EventDef<S, E, EErr, Tags, R, OEErr>
  readonly onAlarm: AlarmDef<S, AErr, Tags, R, OAErr>
}

// ---------------------------------------------------------------------------
// Type guards — discriminate function vs object form
// ---------------------------------------------------------------------------

function isHandlerObject<T>(def: T | { handler: T }): def is { handler: T; onError?: unknown } {
  return typeof def !== "function" && def !== null && typeof def === "object" && "handler" in def
}

// ---------------------------------------------------------------------------
// Normalization — convert either form into the flat ResolvedHandlerConfig
// that buildRegisteredTask expects. No type casts — the union narrowing
// gives us the correct types.
// ---------------------------------------------------------------------------

function normalizeConfig<S, E, EErr, AErr, Tags extends AnyTaskTag, OEErr, OAErr>(
  config: HandlerConfig<S, E, EErr, AErr, Tags, never, OEErr, OAErr>,
): ResolvedHandlerConfig<S, E, EErr, AErr, Tags, OEErr, OAErr> {
  const eventDef = config.onEvent
  const alarmDef = config.onAlarm

  const onEvent = isHandlerObject(eventDef) ? eventDef.handler : eventDef
  const onEventError = isHandlerObject(eventDef) ? eventDef.onError : undefined
  const onAlarm = isHandlerObject(alarmDef) ? alarmDef.handler : alarmDef
  const onAlarmError = isHandlerObject(alarmDef) ? alarmDef.onError : undefined

  return { onEvent, onAlarm, onEventError, onAlarmError }
}

// ---------------------------------------------------------------------------
// withServices — wraps handler functions with Effect.provide to eliminate R.
// Handles both plain function and object forms.
// ---------------------------------------------------------------------------

function wrapEventDef<S, E, EErr, Tags extends AnyTaskTag, R, OEErr>(
  def: EventDef<S, E, EErr, Tags, R, OEErr>,
  layer: Layer.Layer<R>,
): EventDef<S, E, EErr, Tags, never, OEErr> {
  if (isHandlerObject(def)) {
    return {
      handler: (ctx, event) => Effect.provide(def.handler(ctx, event), layer),
      onError: (ctx, error) => Effect.provide(def.onError(ctx, error), layer),
    }
  }
  return (ctx, event) => Effect.provide(def(ctx, event), layer)
}

function wrapAlarmDef<S, AErr, Tags extends AnyTaskTag, R, OAErr>(
  def: AlarmDef<S, AErr, Tags, R, OAErr>,
  layer: Layer.Layer<R>,
): AlarmDef<S, AErr, Tags, never, OAErr> {
  if (isHandlerObject(def)) {
    return {
      handler: (ctx) => Effect.provide(def.handler(ctx), layer),
      onError: (ctx, error) => Effect.provide(def.onError(ctx, error), layer),
    }
  }
  return (ctx) => Effect.provide(def(ctx), layer)
}

export function withServices<S, E, EErr, AErr, Tags extends AnyTaskTag, R, OEErr, OAErr>(
  config: HandlerConfig<S, E, EErr, AErr, Tags, R, OEErr, OAErr>,
  layer: Layer.Layer<R>,
): HandlerConfig<S, E, EErr, AErr, Tags, never, OEErr, OAErr> {
  return {
    onEvent: wrapEventDef(config.onEvent, layer),
    onAlarm: wrapAlarmDef(config.onAlarm, layer),
  }
}

// ---------------------------------------------------------------------------
// TaskHelpers — typed identity wrappers returned by registry.for(name).
// Zero runtime cost — just provides contextual types for handler functions
// defined outside the inline position.
// ---------------------------------------------------------------------------

export interface TaskHelpers<S, E, Tags extends AnyTaskTag> {
  /** Typed wrapper for onEvent handlers. Identity at runtime. */
  readonly onEvent: <EErr, R>(
    fn: (ctx: TaskCtx<S, Tags>, event: E) => Effect.Effect<void, EErr, R>,
  ) => (ctx: TaskCtx<S, Tags>, event: E) => Effect.Effect<void, EErr, R>

  /** Typed wrapper for onAlarm handlers. Identity at runtime. */
  readonly onAlarm: <AErr, R>(
    fn: (ctx: TaskCtx<S, Tags>) => Effect.Effect<void, AErr, R>,
  ) => (ctx: TaskCtx<S, Tags>) => Effect.Effect<void, AErr, R>
}

// ---------------------------------------------------------------------------
// TaskRegistry
// ---------------------------------------------------------------------------

export interface TaskRegistry<Tags extends AnyTaskTag> {
  readonly tags: ReadonlyMap<string, Tags>

  /**
   * Get typed helpers for defining handler functions outside of inline
   * position. The returned .onEvent() and .onAlarm() are identity functions
   * that provide contextual types for ctx and event.
   */
  for<K extends Tags["name"]>(name: K): TaskHelpers<StateFor<Tags, K>, EventFor<Tags, K>, Tags>

  handler<K extends Tags["name"], EErr, AErr, OEErr = never, OAErr = never>(
    name: K,
    config: HandlerConfig<StateFor<Tags, K>, EventFor<Tags, K>, EErr, AErr, Tags, never, OEErr, OAErr>,
  ): TaskHandler<K>

  build(
    handlers: { readonly [K in Tags["name"]]: TaskHandler<K> },
  ): TaskRegistryConfig
}

export const TaskRegistry = {
  make<const TagList extends ReadonlyArray<AnyTaskTag>>(
    ...tags: TagList
  ): TaskRegistry<TagList[number]> {
    type Tags = TagList[number]

    const tagMap = new Map<string, Tags>()
    for (const tag of tags) {
      tagMap.set(tag.name, tag)
    }

    return {
      tags: tagMap,

      for<K extends Tags["name"]>(_name: K): TaskHelpers<StateFor<Tags, K>, EventFor<Tags, K>, Tags> {
        return {
          onEvent: (fn) => fn,
          onAlarm: (fn) => fn,
        }
      },

      handler<K extends Tags["name"], EErr, AErr, OEErr = never, OAErr = never>(
        name: K,
        config: HandlerConfig<StateFor<Tags, K>, EventFor<Tags, K>, EErr, AErr, Tags, never, OEErr, OAErr>,
      ): TaskHandler<K> {
        const tag = tagMap.get(name)
        if (!tag) throw new Error(`Task "${name}" not found in registry`)
        const resolved = normalizeConfig(config)
        const registered = buildRegisteredTask(tag, resolved, tagMap)
        return { _name: name, registered }
      },

      build(
        handlers: { readonly [K in Tags["name"]]: TaskHandler<K> },
      ): TaskRegistryConfig {
        const config: TaskRegistryConfig = {}
        for (const name of tagMap.keys()) {
          const handler: TaskHandler<string> = handlers[name as Tags["name"]]
          config[name] = handler.registered
        }
        return config
      },
    }
  },
}
