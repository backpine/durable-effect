import { describe, it, expect } from "vitest";
import { Effect, Layer, Schema, ServiceMap } from "effect";
import { Task, StoreError, ValidationError } from "../src/index.js";
import type { TaskContext, TaskDefinition, ProvidedTaskDefinition } from "../src/index.js";

// ---------------------------------------------------------------------------
// Test services
// ---------------------------------------------------------------------------

class MockDb extends ServiceMap.Service<MockDb, {
  readonly query: (sql: string) => Effect.Effect<string>;
}>()("MockDb") {}

const MockDbLive = Layer.succeed(MockDb)({
  query: (sql: string) => Effect.succeed(`result: ${sql}`),
});

class MockLogger extends ServiceMap.Service<MockLogger, {
  readonly log: (msg: string) => Effect.Effect<void>;
}>()("MockLogger") {}

const MockLoggerLive = Layer.succeed(MockLogger)({
  log: (_msg: string) => Effect.void,
});

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

const TestState = Schema.Struct({ value: Schema.Number });
type TestState = typeof TestState.Type;

const TestEvent = Schema.Struct({ kind: Schema.String });
type TestEvent = typeof TestEvent.Type;

// Error types from TaskContext methods (save, recall, etc.)
type CtxErrors = StoreError | ValidationError;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Service provision (.provide())", () => {
  it("single service: R narrows from MockDb to never after .provide()", () => {
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
    });

    // Before provide: R = MockDb, Err includes ctx errors
    const _beforeCheck: TaskDefinition<TestState, TestEvent, CtxErrors, MockDb> = def;
    void _beforeCheck;

    const provided = def.provide(MockDbLive);

    // After provide: R = never (ProvidedTaskDefinition)
    const _afterCheck: ProvidedTaskDefinition<TestState, TestEvent, CtxErrors> = provided;
    void _afterCheck;

    expect(provided._tag).toBe("TaskDefinition");
    expect(provided.layers).toHaveLength(1);
  });

  it("forgetting .provide() keeps R = MockDb", () => {
    const def = Task.define({
      state: TestState,
      event: TestEvent,
      onEvent: (_ctx: TaskContext<TestState>, _event: TestEvent) =>
        Effect.gen(function* () {
          const db = yield* MockDb;
          yield* db.query("SELECT 1");
        }),
      onAlarm: (_ctx: TaskContext<TestState>) => Effect.void,
    });

    // This should NOT compile if you uncomment it:
    // const _bad: ProvidedTaskDefinition<TestState, TestEvent, never> = def;

    // It IS assignable to TaskDefinition with R = MockDb
    const _ok: TaskDefinition<TestState, TestEvent, never, MockDb> = def;
    void _ok;

    expect(def.layers).toHaveLength(0);
  });

  it("multiple services: provide a merged layer", () => {
    const def = Task.define({
      state: TestState,
      event: TestEvent,
      onEvent: (_ctx: TaskContext<TestState>, _event: TestEvent) =>
        Effect.gen(function* () {
          const db = yield* MockDb;
          const logger = yield* MockLogger;
          yield* logger.log("querying...");
          yield* db.query("SELECT 1");
        }),
      onAlarm: (_ctx: TaskContext<TestState>) => Effect.void,
    });

    // Before: R = MockDb | MockLogger
    const _before: TaskDefinition<
      TestState,
      TestEvent,
      never,
      MockDb | MockLogger
    > = def;
    void _before;

    const provided = def.provide(Layer.mergeAll(MockDbLive, MockLoggerLive));

    // After: R = never
    const _after: ProvidedTaskDefinition<TestState, TestEvent, never> = provided;
    void _after;

    expect(provided.layers).toHaveLength(1);
  });

  it("chained .provide() calls narrow incrementally", () => {
    const def = Task.define({
      state: TestState,
      event: TestEvent,
      onEvent: (_ctx: TaskContext<TestState>, _event: TestEvent) =>
        Effect.gen(function* () {
          const db = yield* MockDb;
          const logger = yield* MockLogger;
          yield* logger.log("querying...");
          yield* db.query("SELECT 1");
        }),
      onAlarm: (_ctx: TaskContext<TestState>) => Effect.void,
    });

    const step1 = def.provide(MockDbLive);

    // After providing MockDb: R = MockLogger
    const _step1Check: TaskDefinition<
      TestState,
      TestEvent,
      never,
      MockLogger
    > = step1;
    void _step1Check;

    const step2 = step1.provide(MockLoggerLive);

    // After providing MockLogger: R = never
    const _step2Check: ProvidedTaskDefinition<TestState, TestEvent, never> = step2;
    void _step2Check;

    expect(step2.layers).toHaveLength(2);
  });

  it("no-service task: R = never from the start", () => {
    const def = Task.define({
      state: TestState,
      event: TestEvent,
      onEvent: (ctx: TaskContext<TestState>, _event: TestEvent) =>
        ctx.save({ value: 42 }),
      onAlarm: (_ctx: TaskContext<TestState>) => Effect.void,
    });

    // R is already never, no .provide() needed. Err includes ctx errors.
    const _check: ProvidedTaskDefinition<TestState, TestEvent, CtxErrors> = def;
    void _check;

    expect(def.layers).toHaveLength(0);
  });

  it("preserves schemas and handlers through .provide() chain", () => {
    const onEvent = (ctx: TaskContext<TestState>, _event: TestEvent) =>
      Effect.gen(function* () {
        const db = yield* MockDb;
        yield* db.query("SELECT 1");
        yield* ctx.save({ value: 1 });
      });

    const onAlarm = (_ctx: TaskContext<TestState>) => Effect.void;

    const def = Task.define({
      state: TestState,
      event: TestEvent,
      onEvent,
      onAlarm,
    });

    const provided = def.provide(MockDbLive);

    expect(provided.state).toBe(TestState);
    expect(provided.event).toBe(TestEvent);
    expect(provided.onEvent).toBe(onEvent);
    expect(provided.onAlarm).toBe(onAlarm);
  });
});
