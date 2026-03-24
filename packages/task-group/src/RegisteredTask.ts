import { Duration, Effect, Schema } from "effect"
import type { TaskCtx, SiblingHandle } from "./TaskCtx.js"
import type { AnyTaskTag, EventOf, TaskTag } from "./TaskTag.js"
import {
  TaskError,
  PurgeSignal,
  TaskValidationError,
  TaskExecutionError,
} from "./errors.js"
import type { SystemFailure } from "./errors.js"
import type { StorageError } from "./services/Storage.js"
import { Storage } from "./services/Storage.js"
import type { AlarmError } from "./services/Alarm.js"
import { Alarm } from "./services/Alarm.js"

// ---------------------------------------------------------------------------
// Storage keys — plain, because each task instance has isolated storage
// (the adapter provides per-instance Storage/Alarm).
// ---------------------------------------------------------------------------

const STATE_KEY = "t:state"
const ALARM_KEY = "t:alarm"

// ---------------------------------------------------------------------------
// DispatchFn — how a task sends events to siblings
// ---------------------------------------------------------------------------

export interface DispatchFn {
  readonly send: (name: string, id: string, event: unknown) => Effect.Effect<void, TaskError>
  readonly getState: (name: string, id: string) => Effect.Effect<unknown, TaskError>
}

// ---------------------------------------------------------------------------
// HandlerContext — everything a RegisteredTask handler needs from the
// adapter. Grouped into a single object for clean extensibility.
// ---------------------------------------------------------------------------

export interface HandlerContext {
  readonly storage: Storage["Service"]
  readonly alarm: Alarm["Service"]
  readonly dispatch: DispatchFn
  readonly id: string
  readonly name: string
  readonly systemFailure: SystemFailure | null
}

// ---------------------------------------------------------------------------
// RegisteredTask — pre-built handler closures with types captured.
// ---------------------------------------------------------------------------

export interface RegisteredTask {
  readonly handleEvent: (
    ctx: HandlerContext,
    event: unknown,
  ) => Effect.Effect<void, TaskValidationError | TaskExecutionError>
  readonly handleAlarm: (
    ctx: HandlerContext,
  ) => Effect.Effect<void, TaskExecutionError>
  readonly handleGetState: (
    ctx: HandlerContext,
  ) => Effect.Effect<unknown, TaskExecutionError>
}

// ---------------------------------------------------------------------------
// ResolvedHandlerConfig — handler functions with services already provided
// (R = never). This is what buildRegisteredTask consumes.
// ---------------------------------------------------------------------------

export interface ResolvedHandlerConfig<S, E, EErr, AErr, Tags extends AnyTaskTag, OEErr = never, OAErr = never> {
  readonly onEvent: (ctx: TaskCtx<S, Tags>, event: E) => Effect.Effect<void, EErr, never>
  readonly onAlarm: (ctx: TaskCtx<S, Tags>) => Effect.Effect<void, AErr, never>
  readonly onEventError?: ((ctx: TaskCtx<S, Tags>, error: EErr) => Effect.Effect<void, OEErr, never>) | undefined
  readonly onAlarmError?: ((ctx: TaskCtx<S, Tags>, error: AErr) => Effect.Effect<void, OAErr, never>) | undefined
}

// ---------------------------------------------------------------------------
// Internal: build a typed TaskCtx from an adapter-provided HandlerContext
// ---------------------------------------------------------------------------

function buildTaskCtx<S, Tags extends AnyTaskTag>(
  hctx: HandlerContext,
  decodeState: (input: unknown) => Effect.Effect<S, Schema.SchemaError>,
  encodeState: (input: S) => Effect.Effect<unknown, Schema.SchemaError>,
  tagsByName: ReadonlyMap<string, AnyTaskTag>,
): TaskCtx<S, Tags> {
  const { storage, alarm, dispatch, id, name, systemFailure } = hctx

  const mapStorageError = (e: StorageError) =>
    new TaskError({ message: e.message, cause: e })
  const mapAlarmError = (e: AlarmError) =>
    new TaskError({ message: e.message, cause: e })
  const mapSchemaError = (e: Schema.SchemaError) =>
    new TaskError({ message: String(e.message), cause: e })

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

  const task = (ref: AnyTaskTag | string): SiblingHandle<any, any> => {
    const targetName = typeof ref === "string" ? ref : ref.name
    return {
      send: (targetId: string, event: unknown): Effect.Effect<void, TaskError> =>
        dispatch.send(targetName, targetId, event),
      getState: (targetId: string): Effect.Effect<unknown, TaskError> =>
        Effect.gen(function* () {
          const raw = yield* dispatch.getState(targetName, targetId)
          if (raw === null) return null
          const targetTag = tagsByName.get(targetName)
          if (!targetTag) return yield* Effect.fail(new TaskError({ message: `Unknown sibling "${targetName}"` }))
          return yield* Schema.decodeUnknownEffect(targetTag.state)(raw).pipe(
            Effect.mapError(mapSchemaError),
          )
        }),
    }
  }

  return { recall, save, update, scheduleIn, scheduleAt, cancelSchedule, nextAlarm, purge, id, name, task, systemFailure }
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
// Internal: handle errors from a handler, routing PurgeSignal to cleanup
// and delegating to the typed error handler if provided.
// ---------------------------------------------------------------------------

function handleError<S, HErr, OErr, Tags extends AnyTaskTag>(
  ctx: TaskCtx<S, Tags>,
  error: HErr,
  errorHandler: ((ctx: TaskCtx<S, Tags>, error: HErr) => Effect.Effect<void, OErr, never>) | undefined,
  storage: Storage["Service"],
  alarm: Alarm["Service"],
): Effect.Effect<void, TaskExecutionError> {
  if (isPurgeSignal(error)) {
    return cleanup(storage, alarm)
  }

  if (!errorHandler) {
    return Effect.fail(new TaskExecutionError({ cause: error }))
  }

  return errorHandler(ctx, error).pipe(
    Effect.catch((oErr) =>
      isPurgeSignal(oErr)
        ? cleanup(storage, alarm)
        : Effect.fail(new TaskExecutionError({ cause: oErr })),
    ),
    Effect.mapError((e) => new TaskExecutionError({ cause: e })),
  )
}

// ---------------------------------------------------------------------------
// buildRegisteredTask — captures types in closures, returns type-erased
// RegisteredTask for the runtime to dispatch to.
// ---------------------------------------------------------------------------

export function buildRegisteredTask<S, E, EErr, AErr, Tags extends AnyTaskTag, OEErr, OAErr>(
  tag: TaskTag<string, S, E>,
  config: ResolvedHandlerConfig<S, E, EErr, AErr, Tags, OEErr, OAErr>,
  tagsByName: ReadonlyMap<string, AnyTaskTag>,
): RegisteredTask {
  const decodeEvent = Schema.decodeUnknownEffect(tag.event)
  const decodeState = Schema.decodeUnknownEffect(tag.state)
  const encodeState = Schema.encodeUnknownEffect(tag.state)

  const handleEvent = (
    hctx: HandlerContext,
    rawEvent: unknown,
  ): Effect.Effect<void, TaskValidationError | TaskExecutionError> =>
    Effect.gen(function* () {
      const event = yield* decodeEvent(rawEvent).pipe(
        Effect.mapError((e) => new TaskValidationError({ message: String(e.message), cause: e })),
      )

      const ctx = buildTaskCtx<S, Tags>(hctx, decodeState, encodeState, tagsByName)

      yield* config.onEvent(ctx, event).pipe(
        Effect.catch((error) =>
          handleError(ctx, error, config.onEventError, hctx.storage, hctx.alarm),
        ),
      )
    })

  const handleAlarm = (
    hctx: HandlerContext,
  ): Effect.Effect<void, TaskExecutionError> =>
    Effect.gen(function* () {
      yield* hctx.storage.delete(ALARM_KEY).pipe(
        Effect.mapError((e) => new TaskExecutionError({ cause: e })),
      )

      const ctx = buildTaskCtx<S, Tags>(hctx, decodeState, encodeState, tagsByName)

      yield* config.onAlarm(ctx).pipe(
        Effect.catch((error) =>
          handleError(ctx, error, config.onAlarmError, hctx.storage, hctx.alarm),
        ),
      )
    })

  const handleGetState = (
    hctx: HandlerContext,
  ): Effect.Effect<unknown, TaskExecutionError> =>
    Effect.gen(function* () {
      const ctx = buildTaskCtx<S, Tags>(hctx, decodeState, encodeState, tagsByName)
      const raw = yield* ctx.recall().pipe(
        Effect.mapError((e) => new TaskExecutionError({ cause: e })),
      )
      if (raw === null) return null
      return yield* encodeState(raw).pipe(
        Effect.mapError((e) => new TaskExecutionError({ cause: e })),
      )
    })

  return { handleEvent, handleAlarm, handleGetState }
}
