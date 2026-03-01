import { describe, it, expect } from "vitest";
import { Effect, Schema } from "effect";
import { Task } from "../src/index.js";
import type { TaskContext } from "../src/index.js";

describe("Task.define()", () => {
  const CounterState = Schema.Struct({ count: Schema.Number });
  type CounterState = typeof CounterState.Type;

  const CounterEvent = Schema.Struct({
    type: Schema.Literals(["increment", "decrement"]),
    amount: Schema.Number,
  });
  type CounterEvent = typeof CounterEvent.Type;

  it("returns a TaskDefinition with correct tag", () => {
    const def = Task.define({
      state: CounterState,
      event: CounterEvent,
      onEvent: (_ctx: TaskContext<CounterState>, _event: CounterEvent) =>
        Effect.void,
      onAlarm: (_ctx: TaskContext<CounterState>) => Effect.void,
    });

    expect(def._tag).toBe("TaskDefinition");
  });

  it("stores the schemas", () => {
    const def = Task.define({
      state: CounterState,
      event: CounterEvent,
      onEvent: (_ctx: TaskContext<CounterState>, _event: CounterEvent) =>
        Effect.void,
      onAlarm: (_ctx: TaskContext<CounterState>) => Effect.void,
    });

    expect(def.state).toBe(CounterState);
    expect(def.event).toBe(CounterEvent);
  });

  it("stores handlers", () => {
    const onEvent = (_ctx: TaskContext<CounterState>, _event: CounterEvent) =>
      Effect.void;
    const onAlarm = (_ctx: TaskContext<CounterState>) => Effect.void;
    const onError = (_ctx: TaskContext<CounterState>, _error: unknown) =>
      Effect.void;

    const def = Task.define({
      state: CounterState,
      event: CounterEvent,
      onEvent,
      onAlarm,
      onError,
    });

    expect(def.onEvent).toBe(onEvent);
    expect(def.onAlarm).toBe(onAlarm);
    expect(def.onError).toBe(onError);
  });

  it("starts with empty layers", () => {
    const def = Task.define({
      state: CounterState,
      event: CounterEvent,
      onEvent: (_ctx: TaskContext<CounterState>, _event: CounterEvent) =>
        Effect.void,
      onAlarm: (_ctx: TaskContext<CounterState>) => Effect.void,
    });

    expect(def.layers).toEqual([]);
  });

  it("has a provide method", () => {
    const def = Task.define({
      state: CounterState,
      event: CounterEvent,
      onEvent: (_ctx: TaskContext<CounterState>, _event: CounterEvent) =>
        Effect.void,
      onAlarm: (_ctx: TaskContext<CounterState>) => Effect.void,
    });

    expect(typeof def.provide).toBe("function");
  });
});
