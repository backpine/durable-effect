import { describe, it, expect } from "vitest";
import { Effect, Layer, Schema } from "effect";
import {
  Task,
  TaskRunner,
  registerTask,
  buildRegistryLayer,
  TaskRunnerLive,
  makeInMemoryStorage,
  makeInMemoryAlarm,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Test schemas
// ---------------------------------------------------------------------------

const CounterState = Schema.Struct({
  count: Schema.Number,
});
type CounterState = typeof CounterState.Type;

const IncrementEvent = Schema.Struct({
  _tag: Schema.Literal("Increment"),
  amount: Schema.Number,
});
type IncrementEvent = typeof IncrementEvent.Type;

// ---------------------------------------------------------------------------
// Helper: build a full test stack
// ---------------------------------------------------------------------------

function makeTestStack(
  registryConfig: Record<string, ReturnType<typeof registerTask>>,
) {
  const { layer: storageLayer, handle: storageHandle } = makeInMemoryStorage();
  const { layer: alarmLayer, handle: alarmHandle } = makeInMemoryAlarm();
  const registryLayer = buildRegistryLayer(registryConfig);

  // Wire dependencies: TaskRunnerLive requires TaskRegistry + Storage + Alarm
  const depsLayer = Layer.mergeAll(registryLayer, storageLayer, alarmLayer);
  const fullLayer = Layer.provide(TaskRunnerLive, depsLayer);

  return { fullLayer, storageHandle, alarmHandle };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TaskRunnerLive", () => {
  it("handles an event that saves state", async () => {
    const counterTask = Task.define({
      state: CounterState,
      event: IncrementEvent,
      onEvent: (ctx, event) =>
        Effect.gen(function* () {
          const current = yield* ctx.recall();
          const count = current ? current.count : 0;
          yield* ctx.save({ count: count + event.amount });
        }),
      onAlarm: () => Effect.void,
    });

    const { fullLayer, storageHandle } = makeTestStack({
      counter: registerTask(counterTask),
    });

    const program = Effect.gen(function* () {
      const runner = yield* TaskRunner;
      yield* runner.handleEvent("counter", "c-1", {
        _tag: "Increment",
        amount: 5,
      });
      yield* runner.handleEvent("counter", "c-1", {
        _tag: "Increment",
        amount: 3,
      });
    });

    await Effect.runPromise(Effect.provide(program, fullLayer));

    // State should be persisted: count = 5 + 3 = 8
    const stateRaw = storageHandle.getData().get("t:state");
    expect(stateRaw).toEqual({ count: 8 });
  });

  it("handles alarms", async () => {
    let alarmCalled = false;

    const counterTask = Task.define({
      state: CounterState,
      event: IncrementEvent,
      onEvent: () => Effect.void,
      onAlarm: (ctx) =>
        Effect.gen(function* () {
          alarmCalled = true;
          yield* ctx.save({ count: 999 });
        }),
    });

    const { fullLayer, storageHandle } = makeTestStack({
      counter: registerTask(counterTask),
    });

    const program = Effect.gen(function* () {
      const runner = yield* TaskRunner;
      yield* runner.handleAlarm("counter", "c-1");
    });

    await Effect.runPromise(Effect.provide(program, fullLayer));

    expect(alarmCalled).toBe(true);
    expect(storageHandle.getData().get("t:state")).toEqual({ count: 999 });
  });

  it("fails with TaskNotFoundError for unknown task", async () => {
    const { fullLayer } = makeTestStack({});

    const program = Effect.gen(function* () {
      const runner = yield* TaskRunner;
      yield* runner.handleEvent("nonexistent", "id-1", {});
    });

    const result = await Effect.runPromiseExit(
      Effect.provide(program, fullLayer),
    );
    expect(result._tag).toBe("Failure");
  });

  it("fails with TaskValidationError for invalid event", async () => {
    const counterTask = Task.define({
      state: CounterState,
      event: IncrementEvent,
      onEvent: () => Effect.void,
      onAlarm: () => Effect.void,
    });

    const { fullLayer } = makeTestStack({
      counter: registerTask(counterTask),
    });

    const program = Effect.gen(function* () {
      const runner = yield* TaskRunner;
      // Pass invalid event (missing required fields)
      yield* runner.handleEvent("counter", "c-1", { wrong: "shape" });
    });

    const result = await Effect.runPromiseExit(
      Effect.provide(program, fullLayer),
    );
    expect(result._tag).toBe("Failure");
  });

  it("scheduleIn sets an alarm", async () => {
    const counterTask = Task.define({
      state: CounterState,
      event: IncrementEvent,
      onEvent: (ctx) =>
        Effect.gen(function* () {
          yield* ctx.scheduleIn("5 seconds");
        }),
      onAlarm: () => Effect.void,
    });

    const { fullLayer, alarmHandle } = makeTestStack({
      counter: registerTask(counterTask),
    });

    const program = Effect.gen(function* () {
      const runner = yield* TaskRunner;
      yield* runner.handleEvent("counter", "c-1", {
        _tag: "Increment",
        amount: 1,
      });
    });

    await Effect.runPromise(Effect.provide(program, fullLayer));

    expect(alarmHandle.isScheduled()).toBe(true);
    const scheduledTime = alarmHandle.getScheduledTime();
    expect(scheduledTime).toBeGreaterThan(Date.now() - 1000);
  });

  it("purge cleans up all state and alarms", async () => {
    const counterTask = Task.define({
      state: CounterState,
      event: IncrementEvent,
      onEvent: (ctx, event) =>
        Effect.gen(function* () {
          if (event.amount === 0) {
            yield* ctx.purge();
          }
          yield* ctx.save({ count: event.amount });
        }),
      onAlarm: () => Effect.void,
    });

    const { fullLayer, storageHandle, alarmHandle } = makeTestStack({
      counter: registerTask(counterTask),
    });

    const program = Effect.gen(function* () {
      const runner = yield* TaskRunner;
      // First save some state
      yield* runner.handleEvent("counter", "c-1", {
        _tag: "Increment",
        amount: 10,
      });
      // Then purge (amount=0 triggers purge)
      yield* runner.handleEvent("counter", "c-1", {
        _tag: "Increment",
        amount: 0,
      });
    });

    await Effect.runPromise(Effect.provide(program, fullLayer));

    // After purge, all storage should be cleared
    expect(storageHandle.getData().size).toBe(0);
    expect(alarmHandle.isScheduled()).toBe(false);
  });

  it("onError handler catches handler errors", async () => {
    let errorHandlerCalled = false;
    let capturedError: unknown = null;

    const failingTask = Task.define({
      state: CounterState,
      event: IncrementEvent,
      onEvent: () => Effect.fail(new Error("handler failed")),
      onAlarm: () => Effect.void,
      onError: (ctx, error) =>
        Effect.gen(function* () {
          errorHandlerCalled = true;
          capturedError = error;
          yield* ctx.save({ count: -1 });
        }),
    });

    const { fullLayer, storageHandle } = makeTestStack({
      failing: registerTask(failingTask),
    });

    const program = Effect.gen(function* () {
      const runner = yield* TaskRunner;
      yield* runner.handleEvent("failing", "f-1", {
        _tag: "Increment",
        amount: 1,
      });
    });

    await Effect.runPromise(Effect.provide(program, fullLayer));

    expect(errorHandlerCalled).toBe(true);
    expect(capturedError).toBeInstanceOf(Error);
    expect(storageHandle.getData().get("t:state")).toEqual({ count: -1 });
  });
});
