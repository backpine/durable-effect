import type { Duration, Effect, Layer, Schema } from "effect";
import type {
  StoreError,
  SchedulerError,
  ValidationError,
  PurgeSignal,
} from "./errors.js";

// ---------------------------------------------------------------------------
// TaskContext
// ---------------------------------------------------------------------------

export interface TaskContext<S> {
  recall(): Effect.Effect<S | null, StoreError | ValidationError>;
  save(state: S): Effect.Effect<void, StoreError | ValidationError>;
  update(fn: (s: S) => S): Effect.Effect<void, StoreError | ValidationError>;
  scheduleIn(delay: Duration.Input): Effect.Effect<void, StoreError | SchedulerError>;
  scheduleAt(time: Date | number): Effect.Effect<void, StoreError | SchedulerError>;
  cancelSchedule(): Effect.Effect<void, StoreError | SchedulerError>;
  nextAlarm(): Effect.Effect<number | null, StoreError>;
  purge(): Effect.Effect<never, PurgeSignal>;
  readonly id: string;
  readonly name: string;
}

// ---------------------------------------------------------------------------
// TaskDefineConfig — separate error params for correct inference
// ---------------------------------------------------------------------------

export interface TaskDefineConfig<S, E, EErr, AErr, R, OErr = never> {
  readonly state: Schema.Schema<S>;
  readonly event: Schema.Schema<E>;
  readonly onEvent: (
    ctx: TaskContext<S>,
    event: E,
  ) => Effect.Effect<void, EErr, R>;
  readonly onAlarm: (ctx: TaskContext<S>) => Effect.Effect<void, AErr, R>;
  readonly onError?: (
    ctx: TaskContext<S>,
    error: unknown,
  ) => Effect.Effect<void, OErr, R>;
}

// ---------------------------------------------------------------------------
// TaskDefinition — single unified Err
// ---------------------------------------------------------------------------

export interface TaskDefinition<S, E, Err, R> {
  readonly _tag: "TaskDefinition";
  readonly state: Schema.Schema<S>;
  readonly event: Schema.Schema<E>;
  readonly onEvent: (
    ctx: TaskContext<S>,
    event: E,
  ) => Effect.Effect<void, Err, R>;
  readonly onAlarm: (ctx: TaskContext<S>) => Effect.Effect<void, Err, R>;
  readonly onError?: (
    ctx: TaskContext<S>,
    error: unknown,
  ) => Effect.Effect<void, Err, R>;
  readonly layers: ReadonlyArray<Layer.Layer<any, any, any>>;

  provide<ROut>(
    layer: Layer.Layer<ROut, any, any>,
  ): TaskDefinition<S, E, Err, Exclude<R, ROut>>;
}

// ---------------------------------------------------------------------------
// ProvidedTaskDefinition
// ---------------------------------------------------------------------------

export type ProvidedTaskDefinition<S, E, Err> = TaskDefinition<S, E, Err, never>;
