// packages/jobs/test/handlers/tracking.test.ts

import { describe, it, expect, beforeEach } from "vitest";
import { Effect, Layer, Schema } from "effect";
import {
  createTestRuntime,
  createInMemoryTracker,
  EventTracker,
  type EventTrackerService,
  type InternalJobExecutedEvent,
  type InternalJobFailedEvent,
  type InternalTrackingEvent,
} from "@durable-effect/core";
import {
  ContinuousHandler,
  ContinuousHandlerLayer,
} from "../../src/handlers/continuous";
import { MetadataServiceLayer } from "../../src/services/metadata";
import { AlarmServiceLayer } from "../../src/services/alarm";
import { RegistryServiceLayer } from "../../src/services/registry";
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

const executionLog: Array<{
  instanceId: string;
  runCount: number;
  state: CounterState;
}> = [];

const counterPrimitive = Continuous.make({
  stateSchema: CounterState,
  schedule: Continuous.every("30 minutes"),
  execute: (ctx) =>
    Effect.gen(function* () {
      const currentState = yield* ctx.state;
      executionLog.push({
        instanceId: ctx.instanceId,
        runCount: ctx.runCount,
        state: currentState,
      });
      yield* ctx.updateState((s) => ({
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

// Create test registry
const createTestRegistry = (): RuntimeJobRegistry => ({
  continuous: {
    counter: { ...counterPrimitive, name: "counter" },
    failing: { ...failingPrimitive, name: "failing" },
  } as Record<string, any>,
  debounce: {} as Record<string, any>,
  workerPool: {} as Record<string, any>,
  task: {} as Record<string, any>,
});

// =============================================================================
// Test Helpers
// =============================================================================

// Helper to run Effect with layer, bypassing strict R parameter checking
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const runWithLayer = <A, E>(
  effect: Effect.Effect<A, E, any>,
  layer: Layer.Layer<ContinuousHandler>
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E, never>
  );

// =============================================================================
// Test Setup with InMemoryTracker
// =============================================================================

const createTestLayerWithTracking = (initialTime = 1000000) => {
  const {
    layer: coreLayer,
    time,
    handles,
  } = createTestRuntime("test-instance", initialTime);
  const registry = createTestRegistry();

  // Create in-memory tracker synchronously using Effect.runSync
  const { service: trackerService, handle: trackerHandle } = Effect.runSync(
    createInMemoryTracker<InternalTrackingEvent>()
  );

  // Cast to base EventTrackerService for Layer.succeed compatibility
  const trackerLayer = Layer.succeed(
    EventTracker,
    trackerService as EventTrackerService
  );

  const servicesLayer = Layer.mergeAll(
    MetadataServiceLayer,
    AlarmServiceLayer
  ).pipe(Layer.provideMerge(trackerLayer), Layer.provideMerge(coreLayer));

  const retryLayer = RetryExecutorLayer.pipe(Layer.provideMerge(servicesLayer));

  const cleanupLayer = CleanupServiceLayer.pipe(
    Layer.provideMerge(servicesLayer)
  );

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
  ) as Layer.Layer<ContinuousHandler>;

  return { layer: handlerLayer, time, handles, coreLayer, trackerHandle };
};

// =============================================================================
// Tests
// =============================================================================

describe("Pre-Execution State Tracking", () => {
  beforeEach(() => {
    executionLog.length = 0;
  });

  describe("job.executed event", () => {
    it("includes preExecutionState in job.executed event on success", async () => {
      const { layer, trackerHandle } = createTestLayerWithTracking(1000000);
      const initialState = { count: 5, lastRun: null };

      await runWithLayer(
        Effect.gen(function* () {
          const handler = yield* ContinuousHandler;
          yield* handler.handle({
            type: "continuous",
            action: "start",
            name: "counter",
            id: "test-counter-1",
            input: initialState,
          });
        }),
        layer
      );

      // Get all events from tracker
      const events = await Effect.runPromise(trackerHandle.getEvents());

      // Find job.executed event
      const executedEvents = events.filter(
        (e): e is InternalJobExecutedEvent => e.type === "job.executed"
      );

      expect(executedEvents).toHaveLength(1);
      expect(executedEvents[0].preExecutionState).toEqual(initialState);
      expect(executedEvents[0].runCount).toBe(1);
      expect(executedEvents[0].attempt).toBe(1);
    });

    it("captures state before execute modifies it", async () => {
      const { layer, trackerHandle } = createTestLayerWithTracking(1000000);
      const initialState = { count: 10, lastRun: null };

      await runWithLayer(
        Effect.gen(function* () {
          const handler = yield* ContinuousHandler;
          yield* handler.handle({
            type: "continuous",
            action: "start",
            name: "counter",
            id: "test-counter-2",
            input: initialState,
          });
        }),
        layer
      );

      // Get events
      const events = await Effect.runPromise(trackerHandle.getEvents());
      const executedEvent = events.find(
        (e): e is InternalJobExecutedEvent => e.type === "job.executed"
      );

      // preExecutionState should be the ORIGINAL state (count: 10)
      // NOT the modified state (count: 11)
      expect(executedEvent?.preExecutionState).toEqual(initialState);

      // Verify the execution log shows state was modified during execution
      expect(executionLog[0].state).toEqual(initialState);
    });

    it("includes preExecutionState with zero count when state has zero", async () => {
      const { layer, trackerHandle } = createTestLayerWithTracking(1000000);

      await runWithLayer(
        Effect.gen(function* () {
          const handler = yield* ContinuousHandler;
          yield* handler.handle({
            type: "continuous",
            action: "start",
            name: "counter",
            id: "test-counter-3",
            input: { count: 0, lastRun: null },
          });
        }),
        layer
      );

      const events = await Effect.runPromise(trackerHandle.getEvents());
      const executedEvent = events.find(
        (e): e is InternalJobExecutedEvent => e.type === "job.executed"
      );

      expect(executedEvent?.preExecutionState).toEqual({
        count: 0,
        lastRun: null,
      });
    });
  });

  describe("job.failed event", () => {
    it("includes preExecutionState in job.failed event on error", async () => {
      const { layer, trackerHandle } = createTestLayerWithTracking(1000000);
      const initialState = { count: 42, lastRun: 999 };

      // Run failing job - expect it to throw
      try {
        await runWithLayer(
          Effect.gen(function* () {
            const handler = yield* ContinuousHandler;
            yield* handler.handle({
              type: "continuous",
              action: "start",
              name: "failing",
              id: "test-failing-1",
              input: initialState,
            });
          }),
          layer
        );
      } catch {
        // Expected to fail
      }

      // Get events from tracker
      const events = await Effect.runPromise(trackerHandle.getEvents());

      // Find job.failed event
      const failedEvents = events.filter(
        (e): e is InternalJobFailedEvent => e.type === "job.failed"
      );

      expect(failedEvents).toHaveLength(1);
      expect(failedEvents[0].preExecutionState).toEqual(initialState);
      expect(failedEvents[0].willRetry).toBe(false);
      expect(failedEvents[0].error.message).toContain(
        "Intentional test failure"
      );
    });
  });

  describe("multiple executions", () => {
    it("captures correct preExecutionState for each execution", async () => {
      const { layer, trackerHandle, time } =
        createTestLayerWithTracking(1000000);
      const initialState = { count: 0, lastRun: null };

      // First execution via start
      await runWithLayer(
        Effect.gen(function* () {
          const handler = yield* ContinuousHandler;
          yield* handler.handle({
            type: "continuous",
            action: "start",
            name: "counter",
            id: "test-counter-multi",
            input: initialState,
          });
        }),
        layer
      );

      // Clear tracker for clean second test
      await Effect.runPromise(trackerHandle.clear());

      // Advance time and trigger alarm for second execution
      time.set(1000000 + 30 * 60 * 1000 + 1000); // 30 minutes + buffer

      await runWithLayer(
        Effect.gen(function* () {
          const handler = yield* ContinuousHandler;
          yield* handler.handleAlarm();
        }),
        layer
      );

      // Get events from second execution
      const events = await Effect.runPromise(trackerHandle.getEvents());
      const executedEvent = events.find(
        (e): e is InternalJobExecutedEvent => e.type === "job.executed"
      );

      // Second execution should see count: 1 (after first execution modified it)
      expect(executedEvent?.preExecutionState).toMatchObject({
        count: 1,
      });
    });
  });

  describe("event metadata", () => {
    it("includes all required fields alongside preExecutionState", async () => {
      const { layer, trackerHandle } = createTestLayerWithTracking(1000000);

      await runWithLayer(
        Effect.gen(function* () {
          const handler = yield* ContinuousHandler;
          yield* handler.handle({
            type: "continuous",
            action: "start",
            name: "counter",
            id: "test-counter-metadata",
            input: { count: 100, lastRun: null },
          });
        }),
        layer
      );

      const events = await Effect.runPromise(trackerHandle.getEvents());
      const executedEvent = events.find(
        (e): e is InternalJobExecutedEvent => e.type === "job.executed"
      );

      // Verify all fields are present
      expect(executedEvent).toMatchObject({
        type: "job.executed",
        source: "job",
        instanceId: "test-instance",
        jobType: "continuous",
        jobName: "counter",
        runCount: 1,
        attempt: 1,
        preExecutionState: { count: 100, lastRun: null },
      });

      // Event should have eventId and timestamp
      expect(executedEvent?.eventId).toBeDefined();
      expect(executedEvent?.timestamp).toBeDefined();
      expect(typeof executedEvent?.durationMs).toBe("number");
    });
  });
});
