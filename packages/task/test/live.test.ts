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
import { createTasks } from "../src/cloudflare/index.js";

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

  it("clears alarm bookmark after alarm fires so nextAlarm returns null", async () => {
    const counterTask = Task.define({
      state: CounterState,
      event: IncrementEvent,
      onEvent: (ctx) =>
        Effect.gen(function* () {
          yield* ctx.scheduleIn("5 seconds");
        }),
      onAlarm: (ctx) =>
        Effect.gen(function* () {
          // After firing, nextAlarm should return null (no pending alarm)
          const next = yield* ctx.nextAlarm();
          yield* ctx.save({ count: next === null ? 0 : -1 });
        }),
    });

    const { fullLayer, storageHandle } = makeTestStack({
      counter: registerTask(counterTask),
    });

    const program = Effect.gen(function* () {
      const runner = yield* TaskRunner;
      // Schedule an alarm
      yield* runner.handleEvent("counter", "c-1", {
        _tag: "Increment",
        amount: 1,
      });
      // Fire the alarm
      yield* runner.handleAlarm("counter", "c-1");
    });

    await Effect.runPromise(Effect.provide(program, fullLayer));

    // count=0 means nextAlarm returned null inside onAlarm (correct)
    // count=-1 would mean stale alarm time was returned (bug)
    expect(storageHandle.getData().get("t:state")).toEqual({ count: 0 });
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

// ---------------------------------------------------------------------------
// createTasks / getState integration tests
// ---------------------------------------------------------------------------

describe("createTasks getState", () => {
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

  const { TasksDO, tasks } = createTasks({ counter: counterTask });

  // Mock DurableObjectState backed by a simple Map
  function makeMockDOState() {
    const data = new Map<string, unknown>();
    let alarmTime: number | null = null;
    return {
      id: { toString: () => "mock-do-id" },
      storage: {
        get: (key: string) => Promise.resolve(data.get(key) ?? null),
        put: (key: string, value: unknown) => {
          data.set(key, value);
          return Promise.resolve();
        },
        delete: (key: string) => {
          data.delete(key);
          return Promise.resolve(true);
        },
        deleteAll: () => {
          data.clear();
          return Promise.resolve();
        },
        getAlarm: () => Promise.resolve(alarmTime),
        setAlarm: (ts: number) => {
          alarmTime = ts;
          return Promise.resolve();
        },
        deleteAlarm: () => {
          alarmTime = null;
          return Promise.resolve();
        },
      },
      data,
    };
  }

  // Mock DurableObjectNamespace that routes to a real TasksDO instance
  function makeMockNamespace() {
    const instances = new Map<string, InstanceType<typeof TasksDO>>();
    const states = new Map<string, ReturnType<typeof makeMockDOState>>();

    return {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (id: { toString(): string }) => {
        const key = id.toString();
        if (!instances.has(key)) {
          const mockState = makeMockDOState();
          states.set(key, mockState);
          instances.set(key, new TasksDO(mockState));
        }
        const instance = instances.get(key)!;
        return {
          fetch: (input: RequestInfo, init?: RequestInit) => {
            const request = new Request(
              typeof input === "string" ? input : (input as Request).url,
              init,
            );
            return instance.fetch(request);
          },
        };
      },
      getState: (key: string) => states.get(key),
    };
  }

  it("getState returns null when no state exists", async () => {
    const ns = makeMockNamespace();
    const handle = tasks(ns, "counter");

    const result = await Effect.runPromise(handle.getState("new-task"));
    expect(result).toBeNull();
  });

  it("getState returns state after send", async () => {
    const ns = makeMockNamespace();
    const handle = tasks(ns, "counter");

    await Effect.runPromise(
      handle.send("c-1", { _tag: "Increment", amount: 5 }),
    );

    const state = await Effect.runPromise(handle.getState("c-1"));
    expect(state).toEqual({ count: 5 });
  });

  it("getState reflects accumulated state from multiple sends", async () => {
    const ns = makeMockNamespace();
    const handle = tasks(ns, "counter");

    await Effect.runPromise(
      handle.send("c-2", { _tag: "Increment", amount: 3 }),
    );
    await Effect.runPromise(
      handle.send("c-2", { _tag: "Increment", amount: 7 }),
    );

    const state = await Effect.runPromise(handle.getState("c-2"));
    expect(state).toEqual({ count: 10 });
  });
});

// ---------------------------------------------------------------------------
// createTasks / scheduleIn + alarm integration test
// ---------------------------------------------------------------------------

describe("createTasks scheduleIn + alarm", () => {
  const ScheduleState = Schema.Struct({
    phase: Schema.String,
  });

  const TriggerEvent = Schema.Struct({
    _tag: Schema.Literal("Trigger"),
  });

  const scheduleTask = Task.define({
    state: ScheduleState,
    event: TriggerEvent,
    onEvent: (ctx) =>
      Effect.gen(function* () {
        yield* ctx.save({ phase: "scheduled" });
        yield* ctx.scheduleIn("2 seconds");
      }),
    onAlarm: (ctx) =>
      Effect.gen(function* () {
        yield* ctx.save({ phase: "alarm-fired" });
      }),
  });

  const { TasksDO, tasks } = createTasks({ schedule: scheduleTask });

  function makeMockDOState() {
    const data = new Map<string, unknown>();
    let alarmTime: number | null = null;
    return {
      id: { toString: () => "mock-do-id" },
      storage: {
        get: (key: string) => Promise.resolve(data.get(key) ?? null),
        put: (key: string, value: unknown) => {
          data.set(key, value);
          return Promise.resolve();
        },
        delete: (key: string) => {
          data.delete(key);
          return Promise.resolve(true);
        },
        deleteAll: () => {
          data.clear();
          return Promise.resolve();
        },
        getAlarm: () => Promise.resolve(alarmTime),
        setAlarm: (ts: number) => {
          alarmTime = ts;
          return Promise.resolve();
        },
        deleteAlarm: () => {
          alarmTime = null;
          return Promise.resolve();
        },
      },
      data,
    };
  }

  it("scheduleIn from onEvent followed by alarm does not throw _tag error", async () => {
    const mockState = makeMockDOState();
    const doInstance = new TasksDO(mockState);

    // Send event that calls scheduleIn
    const sendResp = await doInstance.fetch(
      new Request("http://task/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "event",
          name: "schedule",
          id: "s-1",
          event: { _tag: "Trigger" },
        }),
      }),
    );
    expect(sendResp.status).toBe(200);
    expect(mockState.data.get("t:state")).toEqual({ phase: "scheduled" });

    // Simulate the alarm firing (as CF would call it)
    await doInstance.alarm();

    expect(mockState.data.get("t:state")).toEqual({ phase: "alarm-fired" });
  });
});
