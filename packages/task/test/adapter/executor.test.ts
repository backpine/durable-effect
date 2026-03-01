import { describe, it, expect } from "vitest";
import { Data, Effect, Schema } from "effect";
import { Task } from "../../src/index.js";
import type { TaskContext } from "../../src/index.js";
import { createTaskExecutor } from "../../src/adapter/executor.js";
import { createTaskRegistry } from "../../src/adapter/registry.js";
import { createTestLayer } from "../../src/testing/index.js";
import { KEYS } from "../../src/adapter/keys.js";

const CounterState = Schema.Struct({ count: Schema.Number });
type CounterState = typeof CounterState.Type;

const CounterEvent = Schema.Struct({ amount: Schema.Number });
type CounterEvent = typeof CounterEvent.Type;

function setup() {
  const registry = createTaskRegistry();
  const executor = createTaskExecutor(registry);
  const { layer, handles } = createTestLayer();
  return { registry, executor, layer, handles };
}

describe("TaskExecutor", () => {
  it("fails with TaskNotFoundError for unknown task", async () => {
    const { executor, layer } = setup();
    let caughtTag = "";
    await Effect.runPromise(Effect.provide(
      executor.handleEvent("unknown", "id-1", {}).pipe(
        Effect.catchTag("TaskNotFoundError", (e) => {
          caughtTag = e._tag;
          return Effect.void;
        }),
      ),
      layer,
    ));
    expect(caughtTag).toBe("TaskNotFoundError");
  });

  it("fails with ValidationError for invalid event", async () => {
    const { registry, executor, layer } = setup();
    registry.register("counter", Task.define({
      state: CounterState,
      event: CounterEvent,
      onEvent: (_ctx: TaskContext<CounterState>, _event: CounterEvent) => Effect.void,
      onAlarm: (_ctx: TaskContext<CounterState>) => Effect.void,
    }));

    let caughtTag = "";
    await Effect.runPromise(Effect.provide(
      executor.handleEvent("counter", "id-1", { invalid: true }).pipe(
        Effect.catchTag("ValidationError", (e) => {
          caughtTag = e._tag;
          return Effect.void;
        }),
      ),
      layer,
    ));
    expect(caughtTag).toBe("ValidationError");
  });

  it("runs onEvent handler successfully", async () => {
    const { registry, executor, layer, handles } = setup();
    registry.register("counter", Task.define({
      state: CounterState,
      event: CounterEvent,
      onEvent: (ctx: TaskContext<CounterState>, event: CounterEvent) =>
        ctx.save({ count: event.amount }),
      onAlarm: (_ctx: TaskContext<CounterState>) => Effect.void,
    }));

    await Effect.runPromise(Effect.provide(
      executor.handleEvent("counter", "id-1", { amount: 42 }),
      layer,
    ));

    const stored = handles.store.getData().get(KEYS.STATE);
    expect(stored).toEqual({ count: 42 });
  });

  it("runs onAlarm handler successfully", async () => {
    const { registry, executor, layer, handles } = setup();
    registry.register("counter", Task.define({
      state: CounterState,
      event: CounterEvent,
      onEvent: (_ctx: TaskContext<CounterState>, _event: CounterEvent) => Effect.void,
      onAlarm: (ctx: TaskContext<CounterState>) =>
        ctx.save({ count: 999 }),
    }));

    await Effect.runPromise(Effect.provide(
      executor.handleAlarm("counter", "id-1"),
      layer,
    ));

    const stored = handles.store.getData().get(KEYS.STATE);
    expect(stored).toEqual({ count: 999 });
  });

  it("handles purge signal: clears store and cancels scheduler", async () => {
    const { registry, executor, layer, handles } = setup();
    registry.register("counter", Task.define({
      state: CounterState,
      event: CounterEvent,
      onEvent: (ctx: TaskContext<CounterState>, _event: CounterEvent) =>
        Effect.gen(function* () {
          yield* ctx.save({ count: 1 });
          yield* ctx.scheduleAt(5000);
          yield* ctx.purge();
        }),
      onAlarm: (_ctx: TaskContext<CounterState>) => Effect.void,
    }));

    await Effect.runPromise(Effect.provide(
      executor.handleEvent("counter", "id-1", { amount: 1 }),
      layer,
    ));

    expect(handles.store.keys()).toEqual([]);
    expect(handles.scheduler.isScheduled()).toBe(false);
  });

  it("routes errors to onError when defined", async () => {
    const { registry, executor, layer, handles } = setup();

    class CustomError extends Data.TaggedError("CustomError")<{ message: string }> {}

    registry.register("counter", Task.define({
      state: CounterState,
      event: CounterEvent,
      onEvent: (_ctx: TaskContext<CounterState>, _event: CounterEvent) =>
        Effect.fail(new CustomError({ message: "boom" })),
      onAlarm: (_ctx: TaskContext<CounterState>) => Effect.void,
      onError: (ctx: TaskContext<CounterState>, _error: unknown) =>
        ctx.save({ count: -1 }),
    }));

    await Effect.runPromise(Effect.provide(
      executor.handleEvent("counter", "id-1", { amount: 1 }),
      layer,
    ));

    const stored = handles.store.getData().get(KEYS.STATE);
    expect(stored).toEqual({ count: -1 });
  });

  it("propagates error when no onError defined", async () => {
    const { registry, executor, layer } = setup();

    class CustomError extends Data.TaggedError("CustomError")<{ message: string }> {}

    registry.register("counter", Task.define({
      state: CounterState,
      event: CounterEvent,
      onEvent: (_ctx: TaskContext<CounterState>, _event: CounterEvent) =>
        Effect.fail(new CustomError({ message: "boom" })),
      onAlarm: (_ctx: TaskContext<CounterState>) => Effect.void,
    }));

    const result = await Effect.runPromiseExit(Effect.provide(
      executor.handleEvent("counter", "id-1", { amount: 1 }),
      layer,
    ));

    expect(result._tag).toBe("Failure");
  });

  it("propagates error when onError also fails", async () => {
    const { registry, executor, layer } = setup();

    class CustomError extends Data.TaggedError("CustomError")<{ message: string }> {}

    registry.register("counter", Task.define({
      state: CounterState,
      event: CounterEvent,
      onEvent: (_ctx: TaskContext<CounterState>, _event: CounterEvent) =>
        Effect.fail(new CustomError({ message: "original" })),
      onAlarm: (_ctx: TaskContext<CounterState>) => Effect.void,
      onError: (_ctx: TaskContext<CounterState>, _error: unknown) =>
        Effect.fail(new CustomError({ message: "onError failed too" })),
    }));

    const result = await Effect.runPromiseExit(Effect.provide(
      executor.handleEvent("counter", "id-1", { amount: 1 }),
      layer,
    ));

    expect(result._tag).toBe("Failure");
  });

  it("purge from onError triggers cleanup", async () => {
    const { registry, executor, layer, handles } = setup();

    class CustomError extends Data.TaggedError("CustomError")<{ message: string }> {}

    registry.register("counter", Task.define({
      state: CounterState,
      event: CounterEvent,
      onEvent: (ctx: TaskContext<CounterState>, _event: CounterEvent) =>
        Effect.gen(function* () {
          yield* ctx.save({ count: 100 });
          yield* Effect.fail(new CustomError({ message: "boom" }));
        }),
      onAlarm: (_ctx: TaskContext<CounterState>) => Effect.void,
      onError: (ctx: TaskContext<CounterState>, _error: unknown) =>
        ctx.purge(),
    }));

    await Effect.runPromise(Effect.provide(
      executor.handleEvent("counter", "id-1", { amount: 1 }),
      layer,
    ));

    expect(handles.store.keys()).toEqual([]);
    expect(handles.scheduler.isScheduled()).toBe(false);
  });

  it("handleAlarm fails with TaskNotFoundError for unknown task", async () => {
    const { executor, layer } = setup();
    const result = await Effect.runPromiseExit(Effect.provide(
      executor.handleAlarm("unknown", "id-1"),
      layer,
    ));
    expect(result._tag).toBe("Failure");
  });

  it("full lifecycle: event → save → schedule → alarm → recall → purge", async () => {
    const { registry, executor, layer, handles } = setup();

    registry.register("counter", Task.define({
      state: CounterState,
      event: CounterEvent,
      onEvent: (ctx: TaskContext<CounterState>, event: CounterEvent) =>
        Effect.gen(function* () {
          yield* ctx.save({ count: event.amount });
          yield* ctx.scheduleAt(10000);
        }),
      onAlarm: (ctx: TaskContext<CounterState>) =>
        Effect.gen(function* () {
          const state = yield* ctx.recall();
          const newCount = (state?.count ?? 0) + 50;
          if (newCount >= 90) {
            yield* ctx.purge();
          } else {
            yield* ctx.save({ count: newCount });
          }
        }),
    }));

    // Event: save count=42, schedule alarm
    await Effect.runPromise(Effect.provide(
      executor.handleEvent("counter", "id-1", { amount: 42 }),
      layer,
    ));
    expect(handles.store.getData().get(KEYS.STATE)).toEqual({ count: 42 });
    expect(handles.scheduler.isScheduled()).toBe(true);

    // Alarm: count 42 + 50 = 92 >= 90 → purge
    handles.scheduler.clear();
    await Effect.runPromise(Effect.provide(
      executor.handleAlarm("counter", "id-1"),
      layer,
    ));
    expect(handles.store.keys()).toEqual([]);
    expect(handles.scheduler.isScheduled()).toBe(false);
  });
});
