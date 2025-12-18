// packages/jobs/test/handlers/continuous.test.ts

import { describe, it, expect, beforeEach } from "vitest";
import { Effect, Layer, Schema, Duration } from "effect";
import { createTestRuntime, NoopTrackerLayer } from "@durable-effect/core";
import {
  ContinuousHandler,
  ContinuousHandlerLayer,
  type ContinuousResponse,
} from "../../src/handlers/continuous";
import { MetadataService, MetadataServiceLayer } from "../../src/services/metadata";
import { AlarmService, AlarmServiceLayer } from "../../src/services/alarm";
import { RegistryService, RegistryServiceLayer } from "../../src/services/registry";
import { JobExecutionServiceLayer } from "../../src/services/execution";
import { CleanupServiceLayer } from "../../src/services/cleanup";
import { RetryExecutorLayer } from "../../src/retry";
import { Continuous } from "../../src/definitions/continuous";
import type { RuntimeJobRegistry } from "../../src/registry/typed";

// =============================================================================
// Test Fixtures
// =============================================================================

const CounterState = Schema.Struct({
  count: Schema.Number,
  lastRun: Schema.NullOr(Schema.Number),
});
type CounterState = typeof CounterState.Type;

const executionLog: Array<{ instanceId: string; runCount: number; state: CounterState }> = [];

const counterPrimitive = Continuous.make({
  stateSchema: CounterState,
  schedule: Continuous.every("30 minutes"),
  execute: (ctx) =>
    Effect.sync(() => {
      executionLog.push({
        instanceId: ctx.instanceId,
        runCount: ctx.runCount,
        state: ctx.state,
      });
      ctx.updateState((s) => ({
        count: s.count + 1,
        lastRun: Date.now(),
      }));
    }),
});

const failingPrimitive = Continuous.make({
  stateSchema: CounterState,
  schedule: Continuous.every("1 hour"),
  execute: () => Effect.fail(new Error("Intentional test failure")),
});

const noImmediateStartPrimitive = Continuous.make({
  stateSchema: CounterState,
  schedule: Continuous.every("1 hour"),
  startImmediately: false,
  execute: (ctx) =>
    Effect.sync(() => {
      executionLog.push({
        instanceId: ctx.instanceId,
        runCount: ctx.runCount,
        state: ctx.state,
      });
    }),
});

// Primitive that terminates after N runs
const TerminatingState = Schema.Struct({
  maxRuns: Schema.Number,
  currentRun: Schema.Number,
});
type TerminatingState = typeof TerminatingState.Type;

const terminateLog: Array<{ reason?: string }> = [];

const terminatingPrimitive = Continuous.make({
  stateSchema: TerminatingState,
  schedule: Continuous.every("10 minutes"),
  execute: (ctx) =>
    Effect.gen(function* () {
      executionLog.push({
        instanceId: ctx.instanceId,
        runCount: ctx.runCount,
        state: ctx.state as any,
      });

      if (ctx.runCount >= ctx.state.maxRuns) {
        terminateLog.push({ reason: "Max runs reached" });
        return yield* ctx.terminate({ reason: "Max runs reached" });
      }

      ctx.updateState((s) => ({ ...s, currentRun: s.currentRun + 1 }));
    }),
});

// Create test registry using object types (RuntimeJobRegistry)
const createTestRegistry = (): RuntimeJobRegistry => ({
  continuous: {
    "counter": { ...counterPrimitive, name: "counter" },
    "failing": { ...failingPrimitive, name: "failing" },
    "no-immediate": { ...noImmediateStartPrimitive, name: "no-immediate" },
    "terminating": { ...terminatingPrimitive, name: "terminating" },
  } as Record<string, any>,
  debounce: {} as Record<string, any>,
  workerPool: {} as Record<string, any>,
});

// =============================================================================
// Test Setup
// =============================================================================

const createTestLayer = (initialTime = 1000000) => {
  const { layer: coreLayer, time, handles } = createTestRuntime("test-instance", initialTime);
  const registry = createTestRegistry();

  const servicesLayer = Layer.mergeAll(
    MetadataServiceLayer,
    AlarmServiceLayer
  ).pipe(
    Layer.provideMerge(NoopTrackerLayer),
    Layer.provideMerge(coreLayer)
  );

  // RetryExecutor depends on AlarmService from servicesLayer
  const retryLayer = RetryExecutorLayer.pipe(
    Layer.provideMerge(servicesLayer)
  );

  // CleanupService depends on AlarmService and StorageAdapter
  const cleanupLayer = CleanupServiceLayer.pipe(
    Layer.provideMerge(servicesLayer)
  );

  // JobExecutionService depends on RetryExecutor, CleanupService, and core adapters
  const executionLayer = JobExecutionServiceLayer.pipe(
    Layer.provideMerge(retryLayer),
    Layer.provideMerge(cleanupLayer),
    Layer.provideMerge(coreLayer)
  );

  const handlerLayer = ContinuousHandlerLayer.pipe(
    Layer.provideMerge(RegistryServiceLayer(registry)),
    Layer.provideMerge(servicesLayer),
    Layer.provideMerge(retryLayer),
    Layer.provideMerge(executionLayer)
  );

  return { layer: handlerLayer, time, handles, coreLayer };
};

// =============================================================================
// Tests
// =============================================================================

describe("ContinuousHandler", () => {
  beforeEach(() => {
    // Clear execution logs before each test
    executionLog.length = 0;
    terminateLog.length = 0;
  });

  describe("start action", () => {
    it("creates a new instance and executes immediately by default", async () => {
      const { layer } = createTestLayer(1000000);

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const handler = yield* ContinuousHandler;
          return yield* handler.handle({
            type: "continuous",
            action: "start",
            name: "counter",
            input: { count: 0, lastRun: null },
          });
        }).pipe(Effect.provide(layer))
      );

      expect(result._type).toBe("continuous.start");
      expect((result as any).created).toBe(true);
      expect((result as any).status).toBe("running");

      // Verify execute was called immediately
      expect(executionLog).toHaveLength(1);
      expect(executionLog[0]).toEqual({
        instanceId: "test-instance",
        runCount: 1,
        state: { count: 0, lastRun: null },
      });
    });

    it("returns existing instance if already started", async () => {
      const { layer } = createTestLayer();

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const handler = yield* ContinuousHandler;

          // First start
          yield* handler.handle({
            type: "continuous",
            action: "start",
            name: "counter",
            input: { count: 0, lastRun: null },
          });

          // Second start should return existing
          return yield* handler.handle({
            type: "continuous",
            action: "start",
            name: "counter",
            input: { count: 100, lastRun: null },
          });
        }).pipe(Effect.provide(layer))
      );

      expect(result._type).toBe("continuous.start");
      expect((result as any).created).toBe(false);
      expect((result as any).status).toBe("running");

      // Only one execution from first start
      expect(executionLog).toHaveLength(1);
    });

    it("respects startImmediately: false", async () => {
      const { layer } = createTestLayer();

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const handler = yield* ContinuousHandler;
          return yield* handler.handle({
            type: "continuous",
            action: "start",
            name: "no-immediate",
            input: { count: 0, lastRun: null },
          });
        }).pipe(Effect.provide(layer))
      );

      expect(result._type).toBe("continuous.start");
      expect((result as any).created).toBe(true);

      // Should NOT execute immediately
      expect(executionLog).toHaveLength(0);
    });
  });

  describe("terminate action", () => {
    it("terminates a running instance and deletes all storage", async () => {
      const { layer } = createTestLayer();

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const handler = yield* ContinuousHandler;

          // Start first
          yield* handler.handle({
            type: "continuous",
            action: "start",
            name: "counter",
            input: { count: 0, lastRun: null },
          });

          // Terminate
          const terminateResult = yield* handler.handle({
            type: "continuous",
            action: "terminate",
            name: "counter",
            reason: "user requested",
          });

          // Verify status is now not_found (all storage deleted)
          const statusResult = yield* handler.handle({
            type: "continuous",
            action: "status",
            name: "counter",
          });

          return { terminateResult, statusResult };
        }).pipe(Effect.provide(layer))
      );

      expect(result.terminateResult._type).toBe("continuous.terminate");
      expect((result.terminateResult as any).terminated).toBe(true);
      expect((result.terminateResult as any).reason).toBe("user requested");

      // Instance should be gone after terminate
      expect((result.statusResult as any).status).toBe("not_found");
    });

    it("returns not_found for non-existent instance", async () => {
      const { layer } = createTestLayer();

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const handler = yield* ContinuousHandler;
          return yield* handler.handle({
            type: "continuous",
            action: "terminate",
            name: "counter",
            reason: "test",
          });
        }).pipe(Effect.provide(layer))
      );

      expect(result._type).toBe("continuous.terminate");
      expect((result as any).terminated).toBe(false);
      expect((result as any).reason).toBe("not_found");
    });

    it("returns not_found when called twice (since first terminate deletes all storage)", async () => {
      const { layer } = createTestLayer();

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const handler = yield* ContinuousHandler;

          // Start
          yield* handler.handle({
            type: "continuous",
            action: "start",
            name: "counter",
            input: { count: 0, lastRun: null },
          });

          // First terminate
          yield* handler.handle({
            type: "continuous",
            action: "terminate",
            name: "counter",
            reason: "first terminate",
          });

          // Second terminate - instance no longer exists
          return yield* handler.handle({
            type: "continuous",
            action: "terminate",
            name: "counter",
            reason: "second terminate",
          });
        }).pipe(Effect.provide(layer))
      );

      expect(result._type).toBe("continuous.terminate");
      expect((result as any).terminated).toBe(false);
      expect((result as any).reason).toBe("not_found");
    });
  });

  describe("trigger action", () => {
    it("triggers immediate execution", async () => {
      const { layer } = createTestLayer();

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const handler = yield* ContinuousHandler;

          // Start (this also executes)
          yield* handler.handle({
            type: "continuous",
            action: "start",
            name: "counter",
            input: { count: 0, lastRun: null },
          });

          // Trigger manual execution
          return yield* handler.handle({
            type: "continuous",
            action: "trigger",
            name: "counter",
          });
        }).pipe(Effect.provide(layer))
      );

      expect(result._type).toBe("continuous.trigger");
      expect((result as any).triggered).toBe(true);

      // Two executions: start + trigger
      expect(executionLog).toHaveLength(2);
      expect(executionLog[1].runCount).toBe(2);
    });

    it("returns triggered: false for non-existent instance", async () => {
      const { layer } = createTestLayer();

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const handler = yield* ContinuousHandler;
          return yield* handler.handle({
            type: "continuous",
            action: "trigger",
            name: "counter",
          });
        }).pipe(Effect.provide(layer))
      );

      expect(result._type).toBe("continuous.trigger");
      expect((result as any).triggered).toBe(false);
    });

    it("returns triggered: false for terminated instance", async () => {
      const { layer } = createTestLayer();

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const handler = yield* ContinuousHandler;

          yield* handler.handle({
            type: "continuous",
            action: "start",
            name: "counter",
            input: { count: 0, lastRun: null },
          });

          yield* handler.handle({
            type: "continuous",
            action: "terminate",
            name: "counter",
            reason: "terminating",
          });

          return yield* handler.handle({
            type: "continuous",
            action: "trigger",
            name: "counter",
          });
        }).pipe(Effect.provide(layer))
      );

      expect(result._type).toBe("continuous.trigger");
      expect((result as any).triggered).toBe(false);
    });
  });

  describe("status action", () => {
    it("returns status for running instance", async () => {
      const { layer } = createTestLayer();

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const handler = yield* ContinuousHandler;

          yield* handler.handle({
            type: "continuous",
            action: "start",
            name: "counter",
            input: { count: 0, lastRun: null },
          });

          return yield* handler.handle({
            type: "continuous",
            action: "status",
            name: "counter",
          });
        }).pipe(Effect.provide(layer))
      );

      expect(result._type).toBe("continuous.status");
      expect((result as any).status).toBe("running");
      expect((result as any).runCount).toBe(1);
    });

    it("returns not_found for non-existent instance", async () => {
      const { layer } = createTestLayer();

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const handler = yield* ContinuousHandler;
          return yield* handler.handle({
            type: "continuous",
            action: "status",
            name: "counter",
          });
        }).pipe(Effect.provide(layer))
      );

      expect(result._type).toBe("continuous.status");
      expect((result as any).status).toBe("not_found");
    });
  });

  describe("getState action", () => {
    it("returns current state", async () => {
      const { layer } = createTestLayer();

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const handler = yield* ContinuousHandler;

          yield* handler.handle({
            type: "continuous",
            action: "start",
            name: "counter",
            input: { count: 5, lastRun: null },
          });

          return yield* handler.handle({
            type: "continuous",
            action: "getState",
            name: "counter",
          });
        }).pipe(Effect.provide(layer))
      );

      expect(result._type).toBe("continuous.getState");
      // After start with immediate execution, count should be incremented
      expect((result as any).state.count).toBe(6);
    });
  });

  describe("handleAlarm", () => {
    it("executes on alarm and schedules next", async () => {
      const { layer, time, handles } = createTestLayer(1000000);

      await Effect.runPromise(
        Effect.gen(function* () {
          const handler = yield* ContinuousHandler;

          // Start the primitive (this schedules the first alarm)
          yield* handler.handle({
            type: "continuous",
            action: "start",
            name: "counter",
            input: { count: 0, lastRun: null },
          });

          // Clear execution log from start
          executionLog.length = 0;

          // Advance time and simulate alarm
          time.advance(Duration.toMillis("30 minutes"));
          yield* handler.handleAlarm();
        }).pipe(Effect.provide(layer))
      );

      // Verify execution happened
      expect(executionLog).toHaveLength(1);
      expect(executionLog[0].runCount).toBe(2);

      // Verify next alarm was scheduled
      const scheduledTime = handles.scheduler.getScheduledTime();
      expect(scheduledTime).toBeDefined();
    });

    it("does nothing when terminated", async () => {
      const { layer, time } = createTestLayer();

      await Effect.runPromise(
        Effect.gen(function* () {
          const handler = yield* ContinuousHandler;

          yield* handler.handle({
            type: "continuous",
            action: "start",
            name: "counter",
            input: { count: 0, lastRun: null },
          });

          yield* handler.handle({
            type: "continuous",
            action: "terminate",
            name: "counter",
            reason: "terminating",
          });

          executionLog.length = 0;

          time.advance(Duration.toMillis("30 minutes"));
          yield* handler.handleAlarm();
        }).pipe(Effect.provide(layer))
      );

      // No execution should happen
      expect(executionLog).toHaveLength(0);
    });
  });

  describe("error handling", () => {
    it("fails with ExecutionError when execute fails without retry config", async () => {
      const { layer } = createTestLayer();

      const resultExit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const handler = yield* ContinuousHandler;

          return yield* handler.handle({
            type: "continuous",
            action: "start",
            name: "failing",
            input: { count: 0, lastRun: null },
          });
        }).pipe(Effect.provide(layer))
      );

      // Without onError or retry, the job should fail with an error
      expect(resultExit._tag).toBe("Failure");
    });
  });

  describe("ctx.terminate", () => {
    it("terminates on first run when condition met (purges state by default)", async () => {
      const { layer } = createTestLayer();

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const handler = yield* ContinuousHandler;

          // Start with maxRuns=1 so it terminates immediately
          const startResult = yield* handler.handle({
            type: "continuous",
            action: "start",
            name: "terminating",
            input: { maxRuns: 1, currentRun: 0 },
          });

          // Get status to check it's terminated
          const statusResult = yield* handler.handle({
            type: "continuous",
            action: "status",
            name: "terminating",
          });

          return { startResult, statusResult };
        }).pipe(Effect.provide(layer))
      );

      // Start should return terminated status
      expect(result.startResult._type).toBe("continuous.start");
      expect((result.startResult as any).status).toBe("terminated");

      // Status should show not_found since purgeState: true deletes all storage
      expect(result.statusResult._type).toBe("continuous.status");
      expect((result.statusResult as any).status).toBe("not_found");

      // Execute was called once
      expect(executionLog).toHaveLength(1);
      expect(terminateLog).toHaveLength(1);
      expect(terminateLog[0].reason).toBe("Max runs reached");
    });

    it("terminates during alarm and stops further alarms", async () => {
      const { layer, time, handles } = createTestLayer(1000000);

      await Effect.runPromise(
        Effect.gen(function* () {
          const handler = yield* ContinuousHandler;

          // Start with maxRuns=2 (so it runs twice then terminates)
          yield* handler.handle({
            type: "continuous",
            action: "start",
            name: "terminating",
            input: { maxRuns: 2, currentRun: 0 },
          });

          // First execution happened on start, clear log
          executionLog.length = 0;
          terminateLog.length = 0;

          // Advance time and trigger alarm (run 2 - should terminate)
          time.advance(Duration.toMillis("10 minutes"));
          yield* handler.handleAlarm();

          // Check status
          const status = yield* handler.handle({
            type: "continuous",
            action: "status",
            name: "terminating",
          });

          // After purge, job is completely deleted
          expect((status as any).status).toBe("not_found");
        }).pipe(Effect.provide(layer))
      );

      // Execution happened once (during alarm)
      expect(executionLog).toHaveLength(1);
      expect(executionLog[0].runCount).toBe(2);

      // Terminate was called
      expect(terminateLog).toHaveLength(1);

      // No more alarms should be scheduled
      const scheduledTime = handles.scheduler.getScheduledTime();
      expect(scheduledTime).toBeUndefined();
    });

    it("trigger action returns terminated: true when terminate called", async () => {
      const { layer } = createTestLayer();

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const handler = yield* ContinuousHandler;

          // Start with maxRuns=2 so first run doesn't terminate
          yield* handler.handle({
            type: "continuous",
            action: "start",
            name: "terminating",
            input: { maxRuns: 2, currentRun: 0 },
          });

          // Trigger should cause second run which terminates
          const triggerResult = yield* handler.handle({
            type: "continuous",
            action: "trigger",
            name: "terminating",
          });

          return triggerResult;
        }).pipe(Effect.provide(layer))
      );

      expect(result._type).toBe("continuous.trigger");
      expect((result as any).triggered).toBe(true);
      expect((result as any).terminated).toBe(true);
    });

    it("trigger action returns triggered: false for terminated instance", async () => {
      const { layer } = createTestLayer();

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const handler = yield* ContinuousHandler;

          // Start with maxRuns=1 so it terminates immediately
          yield* handler.handle({
            type: "continuous",
            action: "start",
            name: "terminating",
            input: { maxRuns: 1, currentRun: 0 },
          });

          // Trigger on terminated instance should fail
          const triggerResult = yield* handler.handle({
            type: "continuous",
            action: "trigger",
            name: "terminating",
          });

          return triggerResult;
        }).pipe(Effect.provide(layer))
      );

      expect(result._type).toBe("continuous.trigger");
      expect((result as any).triggered).toBe(false);
    });

    it("handleAlarm does nothing for terminated instance", async () => {
      const { layer, time } = createTestLayer();

      await Effect.runPromise(
        Effect.gen(function* () {
          const handler = yield* ContinuousHandler;

          // Start with maxRuns=1 so it terminates immediately
          yield* handler.handle({
            type: "continuous",
            action: "start",
            name: "terminating",
            input: { maxRuns: 1, currentRun: 0 },
          });

          // Clear logs
          executionLog.length = 0;
          terminateLog.length = 0;

          // Try to trigger alarm on terminated instance
          time.advance(Duration.toMillis("10 minutes"));
          yield* handler.handleAlarm();
        }).pipe(Effect.provide(layer))
      );

      // No execution should happen
      expect(executionLog).toHaveLength(0);
      expect(terminateLog).toHaveLength(0);
    });
  });
});
