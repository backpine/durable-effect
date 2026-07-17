import { Effect, Layer } from "effect"
import type { TaskCtx } from "./TaskCtx.js"
import type { AnyTaskTag, StateFor, EventFor } from "./TaskTag.js"
import type { RegisteredTask, ResolvedHandlerConfig, ResidualEnv } from "./RegisteredTask.js"
import { buildRegisteredTask } from "./RegisteredTask.js"

// ---------------------------------------------------------------------------
// TaskHandler — opaque result of registry.handler(). Carries the task name
// as a type-level literal so build() can validate completeness. R is the
// residual requirement (the platform env) left after per-hook layers resolve.
// ---------------------------------------------------------------------------

export interface TaskHandler<K extends string, R = never> {
  readonly _name: K
  readonly registered: RegisteredTask<R>
}

// ---------------------------------------------------------------------------
// TaskRegistryConfig — type-erased map of name → RegisteredTask
// ---------------------------------------------------------------------------

export type TaskRegistryConfig<R = never> = Record<string, RegisteredTask<R>>

// ---------------------------------------------------------------------------
// BuiltRegistry — result of registry.build(). Carries the Tags type via
// the tag map (used at runtime for schema access AND at the type level
// so factory functions can infer Tags and produce typed runtimes).
// ---------------------------------------------------------------------------

export interface BuiltRegistry<Tags extends AnyTaskTag, R = never> {
  readonly registryConfig: TaskRegistryConfig<R>
  readonly tags: ReadonlyMap<string, Tags>
}

// ---------------------------------------------------------------------------
// Per-hook service provision.
//
// Each channel (event/alarm) can be either a plain function (no error handler,
// no services) or an object form { handler, onError?, provide? }. The `provide`
// field attaches the service Layer(s) for THAT channel — the core feature that
// lets onEvent and onAlarm require different services. `provide` accepts a
// single Layer or an array (auto-merged).
//
// Type params per channel:
//   RH — the handler's own requirements
//   RP — services the `provide` layer supplies
//   RL — the layer's own requirement (the platform env), which flows to residual
// ---------------------------------------------------------------------------

/**
 * The service Layer attached to a hook via `provide`. To provide several
 * services, merge them: `provide: Layer.mergeAll(DbLive, SlackLive)`.
 */
export type ProvideInput<RP, RL> = Layer.Layer<RP, never, RL>

/** Plain function — no error handler, no services for this channel */
type EventHandlerFn<S, E, EErr, Tags extends AnyTaskTag, RH> =
  (ctx: TaskCtx<S, Tags>, event: E) => Effect.Effect<void, EErr, RH>

/** Object form — co-located error handler and/or per-hook services */
export interface EventHandlerObject<S, E, EErr, Tags extends AnyTaskTag, RH, OEErr = never, RP = never, RL = never> {
  readonly handler: (ctx: TaskCtx<S, Tags>, event: E) => Effect.Effect<void, EErr, RH>
  readonly onError?: (ctx: TaskCtx<S, Tags>, error: EErr) => Effect.Effect<void, OEErr, RH>
  readonly provide?: ProvideInput<RP, RL>
}

/** Either form */
type EventDef<S, E, EErr, Tags extends AnyTaskTag, RH, OEErr = never, RP = never, RL = never> =
  | EventHandlerFn<S, E, EErr, Tags, RH>
  | EventHandlerObject<S, E, EErr, Tags, RH, OEErr, RP, RL>

/** Plain function — no error handler, no services for this channel */
type AlarmHandlerFn<S, AErr, Tags extends AnyTaskTag, RH> =
  (ctx: TaskCtx<S, Tags>) => Effect.Effect<void, AErr, RH>

/** Object form — co-located error handler and/or per-hook services */
export interface AlarmHandlerObject<S, AErr, Tags extends AnyTaskTag, RH, OAErr = never, RP = never, RL = never> {
  readonly handler: (ctx: TaskCtx<S, Tags>) => Effect.Effect<void, AErr, RH>
  readonly onError?: (ctx: TaskCtx<S, Tags>, error: AErr) => Effect.Effect<void, OAErr, RH>
  readonly provide?: ProvideInput<RP, RL>
}

/** Either form */
type AlarmDef<S, AErr, Tags extends AnyTaskTag, RH, OAErr = never, RP = never, RL = never> =
  | AlarmHandlerFn<S, AErr, Tags, RH>
  | AlarmHandlerObject<S, AErr, Tags, RH, OAErr, RP, RL>

// ---------------------------------------------------------------------------
// HandlerConfig — what the user passes to registry.handler(). Each channel
// carries its own requirement (RH*), provided services (RP*), and layer
// input / residual env (RL*).
// ---------------------------------------------------------------------------

export interface HandlerConfig<
  S, E, EErr, AErr, Tags extends AnyTaskTag,
  RHe = never, RHa = never,
  OEErr = never, OAErr = never,
  RPe = never, RPa = never, RLe = never, RLa = never,
> {
  readonly onEvent: EventDef<S, E, EErr, Tags, RHe, OEErr, RPe, RLe>
  readonly onAlarm: AlarmDef<S, AErr, Tags, RHa, OAErr, RPa, RLa>
}

// ---------------------------------------------------------------------------
// Type guard — discriminate function vs object form. The union narrows to the
// object member (a plain function has no `handler` property), preserving the
// precise handler/onError/provide types.
// ---------------------------------------------------------------------------

function isHandlerObject<T>(def: T | { handler: T }): def is { handler: T; onError?: unknown; provide?: unknown } {
  return typeof def !== "function" && def !== null && typeof def === "object" && "handler" in def
}

// ---------------------------------------------------------------------------
// toLayer — normalize a `provide` input (Layer | Layer[] | undefined) into a
// single Layer. Missing provide → the empty layer (requires/provides nothing).
// ---------------------------------------------------------------------------

function toLayer<RP, RL>(provide: ProvideInput<RP, RL> | undefined): Layer.Layer<RP, never, RL> {
  // Layer.empty requires and provides nothing, so widening its (never) params
  // to (RP, RL) here is sound — it is only used when no services are attached.
  return provide ?? (Layer.empty as unknown as Layer.Layer<RP, never, RL>)
}

// ---------------------------------------------------------------------------
// Normalization — convert either form into the flat ResolvedHandlerConfig
// (handlers + per-channel layers) that buildRegisteredTask expects.
// ---------------------------------------------------------------------------

function normalizeConfig<
  S, E, EErr, AErr, Tags extends AnyTaskTag,
  RHe, RHa, OEErr, OAErr, RPe, RPa, RLe, RLa,
>(
  config: HandlerConfig<S, E, EErr, AErr, Tags, RHe, RHa, OEErr, OAErr, RPe, RPa, RLe, RLa>,
): ResolvedHandlerConfig<S, E, EErr, AErr, Tags, OEErr, OAErr, RHe, RHa, RPe, RPa, RLe, RLa> {
  const eventDef = config.onEvent
  const alarmDef = config.onAlarm

  const onEvent = isHandlerObject(eventDef) ? eventDef.handler : eventDef
  const onEventError = isHandlerObject(eventDef) ? eventDef.onError : undefined
  const onEventLayer = toLayer<RPe, RLe>(isHandlerObject(eventDef) ? eventDef.provide : undefined)

  const onAlarm = isHandlerObject(alarmDef) ? alarmDef.handler : alarmDef
  const onAlarmError = isHandlerObject(alarmDef) ? alarmDef.onError : undefined
  const onAlarmLayer = toLayer<RPa, RLa>(isHandlerObject(alarmDef) ? alarmDef.provide : undefined)

  return { onEvent, onAlarm, onEventError, onAlarmError, onEventLayer, onAlarmLayer }
}

// ---------------------------------------------------------------------------
// wrapEventDef / wrapAlarmDef — attach a service Layer to a hook's `provide`.
// Building/memoization happens in the runtime (per instance), so these are
// pure data transforms. Public for adapters and advanced per-hook wiring.
// ---------------------------------------------------------------------------

export function wrapEventDef<S, E, EErr, Tags extends AnyTaskTag, RH, OEErr, RP, RL>(
  def: EventDef<S, E, EErr, Tags, RH, OEErr>,
  layer: Layer.Layer<RP, never, RL>,
): EventHandlerObject<S, E, EErr, Tags, RH, OEErr, RP, RL> {
  if (isHandlerObject(def)) {
    return { handler: def.handler, onError: def.onError, provide: layer }
  }
  return { handler: def, provide: layer }
}

export function wrapAlarmDef<S, AErr, Tags extends AnyTaskTag, RH, OAErr, RP, RL>(
  def: AlarmDef<S, AErr, Tags, RH, OAErr>,
  layer: Layer.Layer<RP, never, RL>,
): AlarmHandlerObject<S, AErr, Tags, RH, OAErr, RP, RL> {
  if (isHandlerObject(def)) {
    return { handler: def.handler, onError: def.onError, provide: layer }
  }
  return { handler: def, provide: layer }
}

// ---------------------------------------------------------------------------
// withServices — attach one Layer to BOTH channels. Convenience for the
// "wrap the whole task" case; the layer is built once per instance (memoized)
// just like per-hook `provide`. For different services per channel, use the
// per-hook `provide` field instead.
// ---------------------------------------------------------------------------

export function withServices<S, E, EErr, AErr, Tags extends AnyTaskTag, RHe, RHa, OEErr, OAErr>(
  config: HandlerConfig<S, E, EErr, AErr, Tags, RHe, RHa, OEErr, OAErr>,
  layer: Layer.Layer<RHe | RHa>,
): HandlerConfig<S, E, EErr, AErr, Tags, RHe, RHa, OEErr, OAErr, RHe | RHa, RHe | RHa, never, never> {
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

  handler<
    K extends Tags["name"], EErr, AErr,
    RHe = never, RHa = never,
    OEErr = never, OAErr = never,
    RPe = never, RPa = never, RLe = never, RLa = never,
  >(
    name: K,
    config: HandlerConfig<StateFor<Tags, K>, EventFor<Tags, K>, EErr, AErr, Tags, RHe, RHa, OEErr, OAErr, RPe, RPa, RLe, RLa>,
  ): TaskHandler<K, ResidualEnv<RHe, RHa, RPe, RPa, RLe, RLa>>

  build<R = never>(
    handlers: { readonly [K in Tags["name"]]: TaskHandler<K, R> },
  ): BuiltRegistry<Tags, R>
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

      handler<
        K extends Tags["name"], EErr, AErr,
        RHe = never, RHa = never,
        OEErr = never, OAErr = never,
        RPe = never, RPa = never, RLe = never, RLa = never,
      >(
        name: K,
        config: HandlerConfig<StateFor<Tags, K>, EventFor<Tags, K>, EErr, AErr, Tags, RHe, RHa, OEErr, OAErr, RPe, RPa, RLe, RLa>,
      ): TaskHandler<K, ResidualEnv<RHe, RHa, RPe, RPa, RLe, RLa>> {
        const tag = tagMap.get(name)
        if (!tag) throw new Error(`Task "${name}" not found in registry`)
        const resolved = normalizeConfig(config)
        const registered = buildRegisteredTask(tag, resolved, tagMap)
        return { _name: name, registered }
      },

      build<R = never>(
        handlers: { readonly [K in Tags["name"]]: TaskHandler<K, R> },
      ): BuiltRegistry<Tags, R> {
        const config: TaskRegistryConfig<R> = {}
        for (const name of tagMap.keys()) {
          const handler: TaskHandler<string, R> = handlers[name as Tags["name"]]
          config[name] = handler.registered
        }
        return { registryConfig: config, tags: tagMap }
      },
    }
  },
}
