import type { Effect, Schema } from "effect"
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
