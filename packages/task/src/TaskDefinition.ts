import { Effect, type Schema, type Layer } from "effect"
import type { TaskContext } from "./TaskContext.js"

// ---------------------------------------------------------------------------
// PureSchema — a schema with no service requirements for encoding/decoding.
// Task schemas must be pure (no service deps) so that decode/encode can
// run without needing additional services in the Effect context.
// ---------------------------------------------------------------------------

export type PureSchema<T> = Schema.Top & {
  readonly "Type": T
  readonly "DecodingServices": never
  readonly "EncodingServices": never
}

// ---------------------------------------------------------------------------
// TaskDefineConfig — what the user passes to Task.define()
// Separate error params per handler for correct inference
// ---------------------------------------------------------------------------

export interface TaskDefineConfig<
  S,
  E,
  EErr,
  AErr,
  R,
  OErr = never,
> {
  readonly state: PureSchema<S>
  readonly event: PureSchema<E>
  readonly onEvent: (
    ctx: TaskContext<S>,
    event: E,
  ) => Effect.Effect<void, EErr, R>
  readonly onAlarm: (
    ctx: TaskContext<S>,
  ) => Effect.Effect<void, AErr, R>
  readonly onError?: (
    ctx: TaskContext<S>,
    error: unknown,
  ) => Effect.Effect<void, OErr, R>
}

// ---------------------------------------------------------------------------
// TaskDefineConfigVoid — config for tasks with no event data (void trigger)
// ---------------------------------------------------------------------------

export interface TaskDefineConfigVoid<
  S,
  EErr,
  AErr,
  R,
  OErr = never,
> {
  readonly state: PureSchema<S>
  readonly onEvent: (
    ctx: TaskContext<S>,
  ) => Effect.Effect<void, EErr, R>
  readonly onAlarm: (
    ctx: TaskContext<S>,
  ) => Effect.Effect<void, AErr, R>
  readonly onError?: (
    ctx: TaskContext<S>,
    error: unknown,
  ) => Effect.Effect<void, OErr, R>
}

// ---------------------------------------------------------------------------
// TaskDefinition — the pure definition value
// ---------------------------------------------------------------------------

export interface TaskDefinition<S, E, Err, R> {
  readonly _tag: "TaskDefinition"
  readonly state: PureSchema<S>
  readonly event: PureSchema<E>
  readonly onEvent: (
    ctx: TaskContext<S>,
    event: E,
  ) => Effect.Effect<void, Err, R>
  readonly onAlarm: (
    ctx: TaskContext<S>,
  ) => Effect.Effect<void, Err, R>
  readonly onError?: (
    ctx: TaskContext<S>,
    error: unknown,
  ) => Effect.Effect<void, Err, R>
}

// ---------------------------------------------------------------------------
// withServices — wraps handlers with Effect.provide to eliminate R,
// returning TaskDefinition<S, E, Err, never> (preserving S and E).
// ---------------------------------------------------------------------------

export function withServices<S, E, Err, R>(
  definition: TaskDefinition<S, E, Err, R>,
  layer: Layer.Layer<R>,
): TaskDefinition<S, E, Err, never> {
  return {
    _tag: "TaskDefinition",
    state: definition.state,
    event: definition.event,
    onEvent: (ctx, event) => Effect.provide(definition.onEvent(ctx, event), layer),
    onAlarm: (ctx) => Effect.provide(definition.onAlarm(ctx), layer),
    onError: definition.onError
      ? (ctx, error) => Effect.provide(definition.onError!(ctx, error), layer)
      : undefined,
  }
}
