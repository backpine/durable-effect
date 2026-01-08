// packages/jobs/test/handlers/debounce.test.ts

import { describe, it, expect, beforeEach } from "vitest";
import { Effect, Schema } from "effect";
import { DebounceHandler } from "../../src/handlers/debounce";
import { Debounce } from "../../src/definitions/debounce";
import {
  createTestRegistry,
  createDebounceTestLayer,
  runWithLayer,
} from "./test-utils";

// =============================================================================
// Test Fixtures
// =============================================================================

const WebhookEvent = Schema.Struct({
  type: Schema.String,
  payload: Schema.Unknown,
});
type WebhookEvent = typeof WebhookEvent.Type;

const BatchState = Schema.Struct({
  events: Schema.Array(WebhookEvent),
  firstEventAt: Schema.NullOr(Schema.Number),
});
type BatchState = typeof BatchState.Type;

const executionLog: Array<{
  instanceId: string;
  eventCount: number;
  state: BatchState;
}> = [];

// Basic debounce that accumulates events
const batcherPrimitive = Debounce.make({
  eventSchema: WebhookEvent,
  stateSchema: BatchState,
  flushAfter: "5 minutes",
  maxEvents: 10,
  onEvent: (ctx) =>
    Effect.succeed({
      events: [...(ctx.state?.events ?? []), ctx.event],
      firstEventAt: ctx.state?.firstEventAt ?? Date.now(),
    }),
  execute: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.state;
      const eventCount = yield* ctx.eventCount;
      executionLog.push({
        instanceId: ctx.instanceId,
        eventCount,
        state,
      });
    }),
});

// Debounce with maxEvents = 3 for testing immediate flush
const smallBatchPrimitive = Debounce.make({
  eventSchema: WebhookEvent,
  stateSchema: BatchState,
  flushAfter: "10 minutes",
  maxEvents: 3,
  onEvent: (ctx) =>
    Effect.succeed({
      events: [...(ctx.state?.events ?? []), ctx.event],
      firstEventAt: ctx.state?.firstEventAt ?? Date.now(),
    }),
  execute: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.state;
      const eventCount = yield* ctx.eventCount;
      executionLog.push({
        instanceId: ctx.instanceId,
        eventCount,
        state,
      });
    }),
});

const createRegistry = () =>
  createTestRegistry({
    debounce: {
      batcher: { ...batcherPrimitive, name: "batcher" },
      smallBatch: { ...smallBatchPrimitive, name: "smallBatch" },
    },
  });

// =============================================================================
// Tests
// =============================================================================

describe("DebounceHandler", () => {
  beforeEach(() => {
    executionLog.length = 0;
  });

  // ===========================================================================
  // Event Accumulation (3 tests)
  // ===========================================================================

  describe("event accumulation", () => {
    it("first add creates metadata, sets startedAt, schedules timeout", async () => {
      const registry = createRegistry();
      const { layer, handles } = createDebounceTestLayer(registry, 1000000);

      const result = await runWithLayer(
        Effect.gen(function* () {
          const handler = yield* DebounceHandler;
          return yield* handler.handle({
            type: "debounce",
            action: "add",
            name: "batcher",
            id: "batch-1",
            event: { type: "webhook", payload: { data: 1 } },
          });
        }),
        layer
      );

      expect(result._type).toBe("debounce.add");

      // Verify alarm was scheduled (5 minutes = 300000ms)
      const scheduledTime = handles.scheduler.getScheduledTime();
      expect(scheduledTime).toBeDefined();
      expect(scheduledTime).toBeGreaterThan(1000000);
    });

    it("add calls onEvent reducer and persists updated state", async () => {
      const registry = createRegistry();
      const { layer } = createDebounceTestLayer(registry, 1000000);

      // Add two events
      await runWithLayer(
        Effect.gen(function* () {
          const handler = yield* DebounceHandler;
          yield* handler.handle({
            type: "debounce",
            action: "add",
            name: "batcher",
            id: "batch-1",
            event: { type: "webhook", payload: { first: true } },
          });
          yield* handler.handle({
            type: "debounce",
            action: "add",
            name: "batcher",
            id: "batch-1",
            event: { type: "webhook", payload: { second: true } },
          });
        }),
        layer
      );

      // Check state via getState
      const stateResult = await runWithLayer(
        Effect.gen(function* () {
          const handler = yield* DebounceHandler;
          return yield* handler.handle({
            type: "debounce",
            action: "getState",
            name: "batcher",
            id: "batch-1",
          });
        }),
        layer
      );

      expect(stateResult._type).toBe("debounce.getState");
      const state = (stateResult as any).state as BatchState;
      expect(state.events).toHaveLength(2);
      expect(state.events[0].payload).toEqual({ first: true });
      expect(state.events[1].payload).toEqual({ second: true });
    });

    it("eventCount increments correctly across adds", async () => {
      const registry = createRegistry();
      const { layer } = createDebounceTestLayer(registry, 1000000);

      // Add 3 events
      const results = await runWithLayer(
        Effect.gen(function* () {
          const handler = yield* DebounceHandler;
          const r1 = yield* handler.handle({
            type: "debounce",
            action: "add",
            name: "batcher",
            id: "batch-1",
            event: { type: "webhook", payload: 1 },
          });
          const r2 = yield* handler.handle({
            type: "debounce",
            action: "add",
            name: "batcher",
            id: "batch-1",
            event: { type: "webhook", payload: 2 },
          });
          const r3 = yield* handler.handle({
            type: "debounce",
            action: "add",
            name: "batcher",
            id: "batch-1",
            event: { type: "webhook", payload: 3 },
          });
          return [r1, r2, r3];
        }),
        layer
      );

      // Check eventCount via status
      const status = await runWithLayer(
        Effect.gen(function* () {
          const handler = yield* DebounceHandler;
          return yield* handler.handle({
            type: "debounce",
            action: "status",
            name: "batcher",
            id: "batch-1",
          });
        }),
        layer
      );

      expect(status._type).toBe("debounce.status");
      expect((status as any).eventCount).toBe(3);
    });
  });

  // ===========================================================================
  // Flush Triggers (3 tests)
  // ===========================================================================

  describe("flush triggers", () => {
    it("maxEvents triggers immediate flush", async () => {
      const registry = createRegistry();
      const { layer } = createDebounceTestLayer(registry, 1000000);

      // smallBatch has maxEvents = 3, so third event should trigger flush
      await runWithLayer(
        Effect.gen(function* () {
          const handler = yield* DebounceHandler;
          yield* handler.handle({
            type: "debounce",
            action: "add",
            name: "smallBatch",
            id: "batch-1",
            event: { type: "webhook", payload: 1 },
          });
          yield* handler.handle({
            type: "debounce",
            action: "add",
            name: "smallBatch",
            id: "batch-1",
            event: { type: "webhook", payload: 2 },
          });
          yield* handler.handle({
            type: "debounce",
            action: "add",
            name: "smallBatch",
            id: "batch-1",
            event: { type: "webhook", payload: 3 },
          });
        }),
        layer
      );

      // Execute should have been called
      expect(executionLog).toHaveLength(1);
      expect(executionLog[0].eventCount).toBe(3);
      expect(executionLog[0].state.events).toHaveLength(3);
    });

    it("handleAlarm flushes when timeout fires", async () => {
      const registry = createRegistry();
      const { layer, time } = createDebounceTestLayer(registry, 1000000);

      // Add event (schedules flush in 5 minutes)
      await runWithLayer(
        Effect.gen(function* () {
          const handler = yield* DebounceHandler;
          yield* handler.handle({
            type: "debounce",
            action: "add",
            name: "batcher",
            id: "batch-1",
            event: { type: "webhook", payload: "timeout-test" },
          });
        }),
        layer
      );

      expect(executionLog).toHaveLength(0);

      // Advance time past flush timeout (5 minutes = 300000ms)
      time.set(1000000 + 300000 + 1000);

      // Trigger alarm
      await runWithLayer(
        Effect.gen(function* () {
          const handler = yield* DebounceHandler;
          yield* handler.handleAlarm();
        }),
        layer
      );

      expect(executionLog).toHaveLength(1);
      expect(executionLog[0].state.events[0].payload).toBe("timeout-test");
    });

    it("manual flush executes regardless of eventCount", async () => {
      const registry = createRegistry();
      const { layer } = createDebounceTestLayer(registry, 1000000);

      // Add single event (below maxEvents)
      await runWithLayer(
        Effect.gen(function* () {
          const handler = yield* DebounceHandler;
          yield* handler.handle({
            type: "debounce",
            action: "add",
            name: "batcher",
            id: "batch-1",
            event: { type: "webhook", payload: "manual-flush" },
          });
        }),
        layer
      );

      expect(executionLog).toHaveLength(0);

      // Manual flush
      await runWithLayer(
        Effect.gen(function* () {
          const handler = yield* DebounceHandler;
          yield* handler.handle({
            type: "debounce",
            action: "flush",
            name: "batcher",
            id: "batch-1",
          });
        }),
        layer
      );

      expect(executionLog).toHaveLength(1);
      expect(executionLog[0].eventCount).toBe(1);
    });
  });

  // ===========================================================================
  // Flush Behavior (2 tests)
  // ===========================================================================

  describe("flush behavior", () => {
    it("successful flush purges all state", async () => {
      const registry = createRegistry();
      const { layer } = createDebounceTestLayer(registry, 1000000);

      // Add event and flush
      await runWithLayer(
        Effect.gen(function* () {
          const handler = yield* DebounceHandler;
          yield* handler.handle({
            type: "debounce",
            action: "add",
            name: "batcher",
            id: "batch-1",
            event: { type: "webhook", payload: "purge-test" },
          });
          yield* handler.handle({
            type: "debounce",
            action: "flush",
            name: "batcher",
            id: "batch-1",
          });
        }),
        layer
      );

      // State should be gone after flush
      const status = await runWithLayer(
        Effect.gen(function* () {
          const handler = yield* DebounceHandler;
          return yield* handler.handle({
            type: "debounce",
            action: "status",
            name: "batcher",
            id: "batch-1",
          });
        }),
        layer
      );

      expect(status._type).toBe("debounce.status");
      expect((status as any).status).toBe("not_found");
    });

    it("flush on empty buffer purges without executing", async () => {
      const registry = createRegistry();
      const { layer } = createDebounceTestLayer(registry, 1000000);

      // Flush without adding any events
      const result = await runWithLayer(
        Effect.gen(function* () {
          const handler = yield* DebounceHandler;
          return yield* handler.handle({
            type: "debounce",
            action: "flush",
            name: "batcher",
            id: "batch-1",
          });
        }),
        layer
      );

      expect(result._type).toBe("debounce.flush");
      // Execute should not be called for empty buffer
      expect(executionLog).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Clear & Status (2 tests)
  // ===========================================================================

  describe("clear and status", () => {
    it("clear discards buffered events without executing", async () => {
      const registry = createRegistry();
      const { layer } = createDebounceTestLayer(registry, 1000000);

      // Add events
      await runWithLayer(
        Effect.gen(function* () {
          const handler = yield* DebounceHandler;
          yield* handler.handle({
            type: "debounce",
            action: "add",
            name: "batcher",
            id: "batch-1",
            event: { type: "webhook", payload: 1 },
          });
          yield* handler.handle({
            type: "debounce",
            action: "add",
            name: "batcher",
            id: "batch-1",
            event: { type: "webhook", payload: 2 },
          });
        }),
        layer
      );

      // Clear
      await runWithLayer(
        Effect.gen(function* () {
          const handler = yield* DebounceHandler;
          yield* handler.handle({
            type: "debounce",
            action: "clear",
            name: "batcher",
            id: "batch-1",
          });
        }),
        layer
      );

      // Execute should not have been called
      expect(executionLog).toHaveLength(0);

      // Status should show not_found
      const status = await runWithLayer(
        Effect.gen(function* () {
          const handler = yield* DebounceHandler;
          return yield* handler.handle({
            type: "debounce",
            action: "status",
            name: "batcher",
            id: "batch-1",
          });
        }),
        layer
      );

      expect((status as any).status).toBe("not_found");
    });

    it("status returns eventCount and scheduled flush time", async () => {
      const registry = createRegistry();
      const { layer } = createDebounceTestLayer(registry, 1000000);

      // Add events
      await runWithLayer(
        Effect.gen(function* () {
          const handler = yield* DebounceHandler;
          yield* handler.handle({
            type: "debounce",
            action: "add",
            name: "batcher",
            id: "batch-1",
            event: { type: "webhook", payload: 1 },
          });
          yield* handler.handle({
            type: "debounce",
            action: "add",
            name: "batcher",
            id: "batch-1",
            event: { type: "webhook", payload: 2 },
          });
        }),
        layer
      );

      const status = await runWithLayer(
        Effect.gen(function* () {
          const handler = yield* DebounceHandler;
          return yield* handler.handle({
            type: "debounce",
            action: "status",
            name: "batcher",
            id: "batch-1",
          });
        }),
        layer
      );

      expect(status._type).toBe("debounce.status");
      expect((status as any).status).toBe("debouncing");
      expect((status as any).eventCount).toBe(2);
      expect((status as any).willFlushAt).toBeDefined();
    });
  });
});
