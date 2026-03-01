import { describe, it, expect } from "vitest";
import { Effect, Layer, Schema, ServiceMap } from "effect";
import { Task } from "../../src/index.js";
import type { TaskContext } from "../../src/index.js";
import { createTaskExecutor } from "../../src/adapter/executor.js";
import { createTaskRegistry } from "../../src/adapter/registry.js";
import { createTestLayer } from "../../src/testing/index.js";
import { KEYS } from "../../src/adapter/keys.js";

const TestState = Schema.Struct({ value: Schema.Number });
type TestState = typeof TestState.Type;

const TestEvent = Schema.Struct({ kind: Schema.String });
type TestEvent = typeof TestEvent.Type;

// Test services
class MockDb extends ServiceMap.Service<MockDb, {
  readonly query: (sql: string) => Effect.Effect<string>;
}>()("MockDb") {}

const MockDbLive = Layer.succeed(MockDb)({
  query: (sql: string) => Effect.succeed(`result: ${sql}`),
});

class MockLogger extends ServiceMap.Service<MockLogger, {
  readonly log: (msg: string) => Effect.Effect<void>;
}>()("MockLogger") {}

const logMessages: string[] = [];
const MockLoggerLive = Layer.succeed(MockLogger)({
  log: (msg: string) => Effect.sync(() => { logMessages.push(msg); }),
});

function setup() {
  const registry = createTaskRegistry();
  const executor = createTaskExecutor(registry);
  const { layer, handles } = createTestLayer();
  return { registry, executor, layer, handles };
}

describe("Service provision integration", () => {
  it("zero-service task runs without layers", async () => {
    const { registry, executor, layer, handles } = setup();

    registry.register("simple", Task.define({
      state: TestState,
      event: TestEvent,
      onEvent: (ctx: TaskContext<TestState>, _event: TestEvent) =>
        ctx.save({ value: 1 }),
      onAlarm: (_ctx: TaskContext<TestState>) => Effect.void,
    }));

    await Effect.runPromise(Effect.provide(
      executor.handleEvent("simple", "id-1", { kind: "test" }),
      layer,
    ));

    expect(handles.store.getData().get(KEYS.STATE)).toEqual({ value: 1 });
  });

  it("single service task with .provide()", async () => {
    const { registry, executor, layer, handles } = setup();

    const def = Task.define({
      state: TestState,
      event: TestEvent,
      onEvent: (ctx: TaskContext<TestState>, _event: TestEvent) =>
        Effect.gen(function* () {
          const db = yield* MockDb;
          const result = yield* db.query("SELECT 1");
          yield* ctx.save({ value: result.length });
        }),
      onAlarm: (_ctx: TaskContext<TestState>) => Effect.void,
    }).provide(MockDbLive);

    registry.register("with-db", def);

    await Effect.runPromise(Effect.provide(
      executor.handleEvent("with-db", "id-1", { kind: "test" }),
      layer,
    ));

    // "result: SELECT 1".length = 16
    expect(handles.store.getData().get(KEYS.STATE)).toEqual({ value: 16 });
  });

  it("multi-service task with merged layers", async () => {
    const { registry, executor, layer, handles } = setup();
    logMessages.length = 0;

    const def = Task.define({
      state: TestState,
      event: TestEvent,
      onEvent: (ctx: TaskContext<TestState>, _event: TestEvent) =>
        Effect.gen(function* () {
          const db = yield* MockDb;
          const logger = yield* MockLogger;
          yield* logger.log("querying...");
          const result = yield* db.query("SELECT 1");
          yield* logger.log(`got: ${result}`);
          yield* ctx.save({ value: result.length });
        }),
      onAlarm: (_ctx: TaskContext<TestState>) => Effect.void,
    }).provide(Layer.mergeAll(MockDbLive, MockLoggerLive));

    registry.register("with-both", def);

    await Effect.runPromise(Effect.provide(
      executor.handleEvent("with-both", "id-1", { kind: "test" }),
      layer,
    ));

    expect(handles.store.getData().get(KEYS.STATE)).toBeDefined();
    expect(logMessages.length).toBeGreaterThanOrEqual(2);
  });

  it("user service is accessible in handler", async () => {
    const { registry, executor, layer } = setup();
    logMessages.length = 0;

    const def = Task.define({
      state: TestState,
      event: TestEvent,
      onEvent: (_ctx: TaskContext<TestState>, _event: TestEvent) =>
        Effect.gen(function* () {
          const logger = yield* MockLogger;
          yield* logger.log("hello from handler");
        }),
      onAlarm: (_ctx: TaskContext<TestState>) => Effect.void,
    }).provide(MockLoggerLive);

    registry.register("logger-task", def);

    await Effect.runPromise(Effect.provide(
      executor.handleEvent("logger-task", "id-1", { kind: "test" }),
      layer,
    ));

    expect(logMessages).toContain("hello from handler");
  });
});
