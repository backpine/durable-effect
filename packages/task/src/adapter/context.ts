import { Duration, Effect, Schema } from "effect";
import type { TaskContext } from "../types.js";
import { PurgeSignal, ValidationError } from "../errors.js";
import type { StoreError, SchedulerError } from "../errors.js";
import { KEYS } from "./keys.js";

export interface StoreShape {
  readonly get: (key: string) => Effect.Effect<unknown | null, StoreError>;
  readonly set: (key: string, value: unknown) => Effect.Effect<void, StoreError>;
  readonly delete: (key: string) => Effect.Effect<void, StoreError>;
  readonly deleteAll: () => Effect.Effect<void, StoreError>;
}

export interface SchedulerShape {
  readonly schedule: (timestamp: number) => Effect.Effect<void, SchedulerError>;
  readonly cancel: () => Effect.Effect<void, SchedulerError>;
  readonly getNext: () => Effect.Effect<number | null, SchedulerError>;
}

export interface CreateTaskContextOptions<S> {
  readonly store: StoreShape;
  readonly scheduler: SchedulerShape;
  readonly instance: { readonly id: string; readonly name: string };
  readonly stateSchema: Schema.Schema<S>;
  readonly now: () => number;
}

export function createTaskContext<S>(options: CreateTaskContextOptions<S>): TaskContext<S> {
  const { store, scheduler, instance, stateSchema, now } = options;

  // Task schemas are guaranteed to have no service requirements.
  // Schema.decodeUnknownEffect returns Effect<S, Issue, DecodingServices> where
  // DecodingServices is `unknown` on the generic Schema.Schema<S> type.
  // We narrow the service channel since task schemas have no service deps.
  type NoServices = { readonly DecodingServices: never; readonly EncodingServices: never };
  const pureSchema = stateSchema as Schema.Schema<S> & NoServices;

  const decodeState = (raw: unknown): Effect.Effect<S, ValidationError> =>
    Schema.decodeUnknownEffect(pureSchema)(raw).pipe(
      Effect.mapError((issue) => new ValidationError({
        message: `Failed to decode state: ${String(issue)}`,
        cause: issue,
      })),
    );

  const encodeState = (state: S): Effect.Effect<unknown, ValidationError> =>
    Schema.encodeEffect(pureSchema)(state).pipe(
      Effect.mapError((issue) => new ValidationError({
        message: `Failed to encode state: ${String(issue)}`,
        cause: issue,
      })),
    );

  const recall = (): Effect.Effect<S | null, StoreError | ValidationError> =>
    Effect.gen(function* () {
      const raw = yield* store.get(KEYS.STATE);
      if (raw === null) return null;
      return yield* decodeState(raw);
    });

  const save = (state: S): Effect.Effect<void, StoreError | ValidationError> =>
    Effect.gen(function* () {
      const encoded = yield* encodeState(state);
      yield* store.set(KEYS.STATE, encoded);
    });

  const update = (fn: (s: S) => S): Effect.Effect<void, StoreError | ValidationError> =>
    Effect.gen(function* () {
      const current = yield* recall();
      if (current === null) return;
      yield* save(fn(current));
    });

  const scheduleIn = (delay: Duration.Input): Effect.Effect<void, StoreError | SchedulerError> =>
    Effect.gen(function* () {
      const ms = Duration.toMillis(delay);
      const ts = now() + ms;
      yield* scheduler.schedule(ts);
      yield* store.set(KEYS.ALARM, ts);
    });

  const scheduleAt = (time: Date | number): Effect.Effect<void, StoreError | SchedulerError> =>
    Effect.gen(function* () {
      const ts = time instanceof Date ? time.getTime() : time;
      yield* scheduler.schedule(ts);
      yield* store.set(KEYS.ALARM, ts);
    });

  const cancelSchedule = (): Effect.Effect<void, StoreError | SchedulerError> =>
    Effect.gen(function* () {
      yield* scheduler.cancel();
      yield* store.delete(KEYS.ALARM);
    });

  const nextAlarm = (): Effect.Effect<number | null, StoreError> =>
    Effect.map(store.get(KEYS.ALARM), (v) => v as number | null);

  const purge = (): Effect.Effect<never, PurgeSignal> =>
    Effect.fail(new PurgeSignal());

  return {
    recall,
    save,
    update,
    scheduleIn,
    scheduleAt,
    cancelSchedule,
    nextAlarm,
    purge,
    id: instance.id,
    name: instance.name,
  };
}
