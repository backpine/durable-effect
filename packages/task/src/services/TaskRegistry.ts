import { Duration, Effect, Layer, Schema, ServiceMap } from "effect"
import type { TaskDefinition, PureSchema } from "../TaskDefinition.js"
import type { TaskContext } from "../TaskContext.js"
import {
  TaskError,
  PurgeSignal,
  TaskValidationError,
  TaskExecutionError,
} from "../errors.js"
import type { StorageError } from "./Storage.js"
import { Storage } from "./Storage.js"
import type { AlarmError } from "./Alarm.js"
import { Alarm } from "./Alarm.js"

// ---------------------------------------------------------------------------
// Storage key constants
// ---------------------------------------------------------------------------

const STATE_KEY = "t:state"
const ALARM_KEY = "t:alarm"

// ---------------------------------------------------------------------------
// RegisteredTask — pre-built handler closures with types captured
// ---------------------------------------------------------------------------

export interface RegisteredTask {
  readonly handleEvent: (
    storage: Storage["Service"],
    alarm: Alarm["Service"],
    id: string,
    name: string,
    event: unknown,
  ) => Effect.Effect<void, TaskValidationError | TaskExecutionError>
  readonly handleAlarm: (
    storage: Storage["Service"],
    alarm: Alarm["Service"],
    id: string,
    name: string,
  ) => Effect.Effect<void, TaskExecutionError>
  readonly handleGetState: (
    storage: Storage["Service"],
    alarm: Alarm["Service"],
    id: string,
    name: string,
  ) => Effect.Effect<unknown, TaskExecutionError>
}

// ---------------------------------------------------------------------------
// TaskRegistry service — maps task names to registered tasks
// ---------------------------------------------------------------------------

export class TaskRegistry extends ServiceMap.Service<TaskRegistry, {
  readonly get: (name: string) => RegisteredTask | undefined
  readonly names: () => ReadonlyArray<string>
}>()("@task/Registry") {}

// ---------------------------------------------------------------------------
// Internal: build a typed TaskContext from services
// ---------------------------------------------------------------------------

function buildTaskContext<S>(
  storage: Storage["Service"],
  alarm: Alarm["Service"],
  id: string,
  name: string,
  decodeState: (input: unknown) => Effect.Effect<S, Schema.SchemaError>,
  encodeState: (input: S) => Effect.Effect<unknown, Schema.SchemaError>,
): TaskContext<S> {
  const mapStorageError = (e: StorageError) =>
    new TaskError({ message: e.message, cause: e })
  const mapAlarmError = (e: AlarmError) =>
    new TaskError({ message: e.message, cause: e })
  const mapSchemaError = (e: Schema.SchemaError) =>
    new TaskError({ message: e.message, cause: e })

  const recall = (): Effect.Effect<S | null, TaskError> =>
    Effect.gen(function* () {
      const raw = yield* storage.get(STATE_KEY).pipe(Effect.mapError(mapStorageError))
      if (raw === null) return null
      return yield* decodeState(raw).pipe(Effect.mapError(mapSchemaError))
    })

  const save = (state: S): Effect.Effect<void, TaskError> =>
    Effect.gen(function* () {
      const encoded = yield* encodeState(state).pipe(Effect.mapError(mapSchemaError))
      yield* storage.set(STATE_KEY, encoded).pipe(Effect.mapError(mapStorageError))
    })

  const update = (fn: (s: S) => S): Effect.Effect<void, TaskError> =>
    Effect.gen(function* () {
      const current = yield* recall()
      if (current === null) return
      yield* save(fn(current))
    })

  const scheduleIn = (delay: Duration.Input): Effect.Effect<void, TaskError> =>
    Effect.gen(function* () {
      const ms = Duration.toMillis(Duration.fromInputUnsafe(delay))
      const ts = Date.now() + ms
      yield* alarm.set(ts).pipe(Effect.mapError(mapAlarmError))
      yield* storage.set(ALARM_KEY, ts).pipe(Effect.mapError(mapStorageError))
    })

  const scheduleAt = (time: Date | number): Effect.Effect<void, TaskError> =>
    Effect.gen(function* () {
      const ts = time instanceof Date ? time.getTime() : time
      yield* alarm.set(ts).pipe(Effect.mapError(mapAlarmError))
      yield* storage.set(ALARM_KEY, ts).pipe(Effect.mapError(mapStorageError))
    })

  const cancelSchedule = (): Effect.Effect<void, TaskError> =>
    Effect.gen(function* () {
      yield* alarm.cancel().pipe(Effect.mapError(mapAlarmError))
      yield* storage.delete(ALARM_KEY).pipe(Effect.mapError(mapStorageError))
    })

  const nextAlarm = (): Effect.Effect<number | null, TaskError> =>
    storage.get(ALARM_KEY).pipe(
      Effect.mapError(mapStorageError),
      Effect.map((v) => (typeof v === "number" ? v : null)),
    )

  const purge = (): Effect.Effect<never, PurgeSignal> =>
    Effect.fail(new PurgeSignal())

  return { recall, save, update, scheduleIn, scheduleAt, cancelSchedule, nextAlarm, purge, id, name }
}

// ---------------------------------------------------------------------------
// Internal: cleanup on purge
// ---------------------------------------------------------------------------

function cleanup(
  storage: Storage["Service"],
  alarm: Alarm["Service"],
): Effect.Effect<void, TaskExecutionError> {
  return Effect.gen(function* () {
    yield* storage.deleteAll()
    yield* alarm.cancel()
  }).pipe(Effect.mapError((e) => new TaskExecutionError({ cause: e })))
}

// ---------------------------------------------------------------------------
// Internal: type guard for PurgeSignal
// ---------------------------------------------------------------------------

function isPurgeSignal(error: unknown): error is PurgeSignal {
  return error instanceof PurgeSignal
}

// ---------------------------------------------------------------------------
// Internal: handle errors from a handler effect, routing PurgeSignal to
// cleanup and other errors to onError (if provided).
// ---------------------------------------------------------------------------

function handleHandlerError<S, HErr, OErr>(
  ctx: TaskContext<S>,
  error: HErr,
  onError: ((ctx: TaskContext<S>, error: HErr) => Effect.Effect<void, OErr, never>) | undefined,
  storage: Storage["Service"],
  alarm: Alarm["Service"],
): Effect.Effect<void, TaskExecutionError> {
  if (isPurgeSignal(error)) {
    return cleanup(storage, alarm)
  }

  if (!onError) {
    return Effect.fail(new TaskExecutionError({ cause: error }))
  }

  return onError(ctx, error).pipe(
    Effect.catch((oErr) =>
      isPurgeSignal(oErr)
        ? cleanup(storage, alarm)
        : Effect.fail(new TaskExecutionError({ cause: oErr })),
    ),
    Effect.mapError((e) => new TaskExecutionError({ cause: e })),
  )
}

// ---------------------------------------------------------------------------
// Internal: build RegisteredTask from a fully-resolved definition (R = never).
//
// All handler effects in the definition have R = never, so no layer provision
// is needed. S, E, EErr, AErr are captured in closures via generic params.
// ---------------------------------------------------------------------------

function buildRegisteredTask<S, E, EErr, AErr, OErr, GErr>(
  definition: TaskDefinition<S, E, EErr, AErr, never, OErr, GErr>,
): RegisteredTask {
  const decodeEvent = Schema.decodeUnknownEffect(definition.event)
  const decodeState = Schema.decodeUnknownEffect(definition.state)
  const encodeState = Schema.encodeUnknownEffect(definition.state)

  const handleEvent = (
    storage: Storage["Service"],
    alarm: Alarm["Service"],
    id: string,
    name: string,
    rawEvent: unknown,
  ): Effect.Effect<void, TaskValidationError | TaskExecutionError> =>
    Effect.gen(function* () {
      const event = yield* decodeEvent(rawEvent).pipe(
        Effect.mapError((e) => new TaskValidationError({ message: e.message, cause: e })),
      )

      const ctx = buildTaskContext(storage, alarm, id, name, decodeState, encodeState)

      yield* definition.onEvent(ctx, event).pipe(
        Effect.catch((error) =>
          handleHandlerError(ctx, error, definition.onError, storage, alarm),
        ),
      )
    })

  const handleAlarm = (
    storage: Storage["Service"],
    alarm: Alarm["Service"],
    id: string,
    name: string,
  ): Effect.Effect<void, TaskExecutionError> =>
    Effect.gen(function* () {
      // Clear the alarm bookmark — the alarm has fired, so it's no longer pending
      yield* storage.delete(ALARM_KEY).pipe(
        Effect.mapError((e) => new TaskExecutionError({ cause: e })),
      )

      const ctx = buildTaskContext(storage, alarm, id, name, decodeState, encodeState)

      yield* definition.onAlarm(ctx).pipe(
        Effect.catch((error) =>
          handleHandlerError(ctx, error, definition.onError, storage, alarm),
        ),
      )
    })

  const handleGetState = (
    storage: Storage["Service"],
    alarm: Alarm["Service"],
    id: string,
    name: string,
  ): Effect.Effect<unknown, TaskExecutionError> =>
    Effect.gen(function* () {
      const ctx = buildTaskContext(storage, alarm, id, name, decodeState, encodeState)
      const raw = yield* ctx.recall().pipe(
        Effect.mapError((e) => new TaskExecutionError({ cause: e })),
      )

      if (!definition.onClientGetState) return raw

      const result = yield* definition.onClientGetState(ctx, raw).pipe(
        Effect.mapError((e) => new TaskExecutionError({ cause: e })),
      )

      if (result === null) return null
      return yield* encodeState(result).pipe(
        Effect.mapError((e) => new TaskExecutionError({ cause: e })),
      )
    })

  return { handleEvent, handleAlarm, handleGetState }
}

// ---------------------------------------------------------------------------
// registerTask — for definitions with no service requirements (R = never)
// ---------------------------------------------------------------------------

export function registerTask<S, E, EErr, AErr, OErr, GErr>(
  definition: TaskDefinition<S, E, EErr, AErr, never, OErr, GErr>,
): RegisteredTask {
  return buildRegisteredTask(definition)
}

// ---------------------------------------------------------------------------
// registerTaskWithLayer — for definitions with service requirements (R ≠ never)
//
// Wraps each handler with Effect.provide(handler, layer) to eliminate R,
// producing a resolved definition with R = never, then delegates to the
// shared buildRegisteredTask.
// ---------------------------------------------------------------------------

export function registerTaskWithLayer<S, E, EErr, AErr, R, OErr, GErr>(
  definition: TaskDefinition<S, E, EErr, AErr, R, OErr, GErr>,
  layer: Layer.Layer<R>,
): RegisteredTask {
  const resolved: TaskDefinition<S, E, EErr, AErr, never, OErr, GErr> = {
    _tag: "TaskDefinition",
    state: definition.state,
    event: definition.event,
    onEvent: (ctx, event) => Effect.provide(definition.onEvent(ctx, event), layer),
    onAlarm: (ctx) => Effect.provide(definition.onAlarm(ctx), layer),
    onError: definition.onError
      ? (ctx, error) => Effect.provide(definition.onError!(ctx, error), layer)
      : undefined,
    onClientGetState: definition.onClientGetState
      ? (ctx, state) => Effect.provide(definition.onClientGetState!(ctx, state), layer)
      : undefined,
  }
  return buildRegisteredTask(resolved)
}

// ---------------------------------------------------------------------------
// buildRegistryLayer — builds a TaskRegistry layer from a config object
// ---------------------------------------------------------------------------

export type TaskRegistryConfig = Record<string, RegisteredTask>

export function buildRegistryLayer(
  config: TaskRegistryConfig,
): Layer.Layer<TaskRegistry> {
  return Layer.succeed(TaskRegistry, {
    get: (name) => config[name],
    names: () => Object.keys(config),
  })
}
