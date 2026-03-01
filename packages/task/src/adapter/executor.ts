import { Effect, Layer, Schema } from "effect";
import { TaskNotFoundError, ValidationError } from "../errors.js";
import type { StoreError, SchedulerError } from "../errors.js";
import { Store } from "./store.js";
import { Scheduler } from "./scheduler.js";
import { Instance } from "./instance.js";
import { createTaskContext } from "./context.js";
import type { StoreShape, SchedulerShape } from "./context.js";
import type { TaskRegistry } from "./registry.js";
import type { TaskDefinition } from "../types.js";

export interface TaskExecutor {
  readonly handleEvent: (
    taskName: string,
    instanceId: string,
    rawEvent: unknown,
  ) => Effect.Effect<void, TaskNotFoundError | ValidationError, Store | Scheduler | Instance>;
  readonly handleAlarm: (
    taskName: string,
    instanceId: string,
  ) => Effect.Effect<void, TaskNotFoundError, Store | Scheduler | Instance>;
}

function provideUserLayers(
  effect: Effect.Effect<void, any, any>,
  def: TaskDefinition<any, any, any, any>,
): Effect.Effect<void, any, any> {
  if (def.layers.length === 0) return effect;
  const merged = def.layers.length === 1
    ? def.layers[0]
    : Layer.mergeAll(def.layers[0], ...def.layers.slice(1));
  return Effect.provide(effect, merged);
}

function cleanup(
  store: StoreShape,
  scheduler: SchedulerShape,
): Effect.Effect<void, StoreError | SchedulerError> {
  return Effect.gen(function* () {
    yield* store.deleteAll();
    yield* scheduler.cancel();
  });
}

function runWithErrorRouting(
  handlerEffect: Effect.Effect<void, any, any>,
  def: TaskDefinition<any, any, any, any>,
  ctx: any,
  store: StoreShape,
  scheduler: SchedulerShape,
): Effect.Effect<void, any, any> {
  const withPurge = handlerEffect.pipe(
    Effect.catchTag("PurgeSignal", () => cleanup(store, scheduler)),
  );

  if (!def.onError) return withPurge;

  return withPurge.pipe(
    Effect.catch((error) =>
      provideUserLayers(def.onError!(ctx, error), def).pipe(
        Effect.catchTag("PurgeSignal", () => cleanup(store, scheduler)),
      )
    ),
  );
}

// Task schemas are guaranteed to have no service requirements.
type NoServices = { readonly DecodingServices: never; readonly EncodingServices: never };

export function createTaskExecutor(registry: TaskRegistry): TaskExecutor {
  const handleEvent = (
    taskName: string,
    instanceId: string,
    rawEvent: unknown,
  ): Effect.Effect<void, TaskNotFoundError | ValidationError, Store | Scheduler | Instance> =>
    Effect.gen(function* () {
      const def = registry.get(taskName);
      if (!def) return yield* Effect.fail(new TaskNotFoundError({ name: taskName }));

      const validatedEvent = yield* Schema.decodeUnknownEffect(
        def.event as Schema.Schema<any> & NoServices,
      )(rawEvent).pipe(
        Effect.mapError((issue) => new ValidationError({
          message: `Failed to decode event: ${String(issue)}`,
          cause: issue,
        })),
      );

      const store = yield* Store;
      const scheduler = yield* Scheduler;
      yield* Instance;

      const ctx = createTaskContext({
        store,
        scheduler,
        instance: { id: instanceId, name: taskName },
        stateSchema: def.state,
        now: () => Date.now(),
      });

      yield* runWithErrorRouting(
        provideUserLayers(def.onEvent(ctx, validatedEvent), def),
        def,
        ctx,
        store,
        scheduler,
      );
    }) as Effect.Effect<void, TaskNotFoundError | ValidationError, Store | Scheduler | Instance>;

  const handleAlarm = (
    taskName: string,
    instanceId: string,
  ): Effect.Effect<void, TaskNotFoundError, Store | Scheduler | Instance> =>
    Effect.gen(function* () {
      const def = registry.get(taskName);
      if (!def) return yield* Effect.fail(new TaskNotFoundError({ name: taskName }));

      const store = yield* Store;
      const scheduler = yield* Scheduler;
      yield* Instance;

      const ctx = createTaskContext({
        store,
        scheduler,
        instance: { id: instanceId, name: taskName },
        stateSchema: def.state,
        now: () => Date.now(),
      });

      yield* runWithErrorRouting(
        provideUserLayers(def.onAlarm(ctx), def),
        def,
        ctx,
        store,
        scheduler,
      );
    }) as Effect.Effect<void, TaskNotFoundError, Store | Scheduler | Instance>;

  return { handleEvent, handleAlarm };
}
