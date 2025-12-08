# Phase 9: Event Tracking - Observability Layer

## Overview

This phase implements the event tracking system - the observability layer that emits events for workflow and step lifecycle transitions. Events enable monitoring, debugging, and integration with external systems.

**Duration**: ~2-3 hours
**Dependencies**: Phase 1-8 (all previous phases), `@durable-effect/core` (events)
**Risk Level**: Low (observability, non-critical path)

---

## Goals

1. **Reuse event definitions from `@durable-effect/core`** - Events are already defined there
2. Create `EventTracker` service for event emission
3. Implement batched HTTP delivery
4. Support multiple tracker backends
5. Integrate with state transitions

---

## Background: Event Tracking Purpose

Events provide observability into workflow execution:

1. **Monitoring** - Track workflow throughput, latency, failures
2. **Debugging** - Trace execution path, identify issues
3. **Integration** - Send events to external systems (Datadog, etc.)
4. **Audit** - Record what happened and when

---

## Events from `@durable-effect/core`

The `@durable-effect/core` package already defines all event types with Effect Schemas. We will **reuse these** rather than redefining them:

### Workflow Events
- `workflow.started` - Workflow begins execution
- `workflow.queued` - Workflow queued for async execution
- `workflow.completed` - Workflow finishes successfully
- `workflow.failed` - Workflow fails permanently
- `workflow.paused` - Workflow pauses (sleep/retry)
- `workflow.resumed` - Workflow resumes from pause
- `workflow.cancelled` - Workflow is cancelled

### Step Events
- `step.started` - Step begins execution
- `step.completed` - Step finishes successfully
- `step.failed` - Step fails (may retry)

### Retry Events
- `retry.scheduled` - Retry is scheduled
- `retry.exhausted` - All retry attempts exhausted

### Sleep Events
- `sleep.started` - Sleep begins
- `sleep.completed` - Sleep completes

### Timeout Events
- `timeout.set` - Timeout deadline is set
- `timeout.exceeded` - Timeout deadline exceeded

### Internal vs Wire Events

The core package distinguishes between:
- **Internal events** - Created by workflow code (no `env`/`serviceKey`)
- **Wire events** - Sent to tracking service (includes `env`/`serviceKey`)

The `EventTracker` service uses `enrichEvent()` from core to add `env`/`serviceKey` before sending.

---

## File Structure

```
packages/workflow-v2/src/
├── tracker/
│   ├── index.ts               # Tracker exports
│   ├── tracker.ts             # EventTracker service
│   ├── http-batch.ts          # Batched HTTP delivery
│   ├── noop.ts                # No-op tracker for testing
│   └── in-memory.ts           # In-memory tracker for testing
└── test/
    └── tracker/
        └── tracker.test.ts
```

Note: No `events.ts` file needed - events come from `@durable-effect/core`.

---

## Implementation Details

### 1. Event Usage from `@durable-effect/core`

Events are imported from `@durable-effect/core` - no need to redefine them:

```typescript
// packages/workflow-v2/src/tracker/events.ts
// Re-export from core for convenience

export {
  // Helper functions
  createBaseEvent,
  enrichEvent,

  // Internal types (created by workflow code)
  type InternalWorkflowEvent,
  type InternalBaseEvent,
  type InternalWorkflowStartedEvent,
  type InternalWorkflowCompletedEvent,
  type InternalWorkflowFailedEvent,
  type InternalWorkflowPausedEvent,
  type InternalWorkflowResumedEvent,
  type InternalStepStartedEvent,
  type InternalStepCompletedEvent,
  type InternalStepFailedEvent,
  type InternalRetryScheduledEvent,
  type InternalRetryExhaustedEvent,
  type InternalSleepStartedEvent,
  type InternalSleepCompletedEvent,
  type InternalTimeoutSetEvent,
  type InternalTimeoutExceededEvent,

  // Wire types (sent to tracking service)
  type WorkflowEvent,
  type WorkflowEventType,
} from "@durable-effect/core";
```

### Creating Events in Workflow Code

```typescript
import { createBaseEvent, type InternalWorkflowStartedEvent } from "@durable-effect/core";

// Create base event fields
const base = createBaseEvent(workflowId, workflowName, executionId);

// Create specific event by spreading base and adding type-specific fields
const startedEvent: InternalWorkflowStartedEvent = {
  ...base,
  type: "workflow.started",
  input: workflowInput,
};

// For step events
const stepStartedEvent: InternalStepStartedEvent = {
  ...base,
  type: "step.started",
  stepName: "fetchData",
  attempt: 1,
};
```

### Enriching Events for Wire Transmission

```typescript
import { enrichEvent } from "@durable-effect/core";

// The tracker adds env/serviceKey before sending
const wireEvent = enrichEvent(internalEvent, "production", "my-service");
// Now has: { ...internalEvent, env: "production", serviceKey: "my-service" }
```

### 2. Event Tracker Service (`tracker/tracker.ts`)

```typescript
// packages/workflow-v2/src/tracker/tracker.ts

import { Context, Effect, Layer } from "effect";
import type { InternalWorkflowEvent } from "@durable-effect/core";

// =============================================================================
// Service Interface
// =============================================================================

/**
 * EventTracker service interface.
 *
 * Accepts internal events (without env/serviceKey) and handles
 * enrichment and delivery to the tracking backend.
 */
export interface EventTrackerService {
  /**
   * Emit an event.
   * Events may be buffered for batch delivery.
   * The tracker will enrich with env/serviceKey before sending.
   */
  readonly emit: (event: InternalWorkflowEvent) => Effect.Effect<void>;

  /**
   * Flush all buffered events.
   * Call before workflow completion to ensure delivery.
   */
  readonly flush: () => Effect.Effect<void>;

  /**
   * Get count of pending events.
   */
  readonly pending: () => Effect.Effect<number>;
}

/**
 * Effect service tag for EventTracker.
 */
export class EventTracker extends Context.Tag("@durable-effect/EventTracker")<
  EventTracker,
  EventTrackerService
>() {}

// =============================================================================
// Emit Helper
// =============================================================================

/**
 * Emit an event using the tracker from context.
 * Safe to call - does nothing if tracker not available.
 */
export const emitEvent = (event: InternalWorkflowEvent): Effect.Effect<void> =>
  Effect.flatMap(
    Effect.serviceOption(EventTracker),
    (option) =>
      option._tag === "Some" ? option.value.emit(event) : Effect.void
  );

/**
 * Flush events using the tracker from context.
 */
export const flushEvents: Effect.Effect<void> = Effect.flatMap(
  Effect.serviceOption(EventTracker),
  (option) =>
    option._tag === "Some" ? option.value.flush() : Effect.void
);
```

### 3. HTTP Batch Tracker (`tracker/http-batch.ts`)

```typescript
// packages/workflow-v2/src/tracker/http-batch.ts

import { Effect, Layer, Ref, Schedule, Duration } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform";
import { enrichEvent, type InternalWorkflowEvent, type WorkflowEvent } from "@durable-effect/core";
import { EventTracker, type EventTrackerService } from "./tracker";

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for HTTP batch tracker.
 */
export interface HttpBatchTrackerConfig {
  /** URL to send events to */
  readonly endpoint: string;
  /** Environment identifier (e.g., "production", "staging") */
  readonly env: string;
  /** Service key for identification */
  readonly serviceKey: string;
  /** Maximum events per batch */
  readonly batchSize?: number;
  /** Maximum time to buffer before sending */
  readonly flushIntervalMs?: number;
  /** Headers to include in requests */
  readonly headers?: Record<string, string>;
  /** Retry configuration */
  readonly retry?: {
    readonly maxAttempts?: number;
    readonly initialDelayMs?: number;
  };
}

/**
 * Default configuration.
 */
const DEFAULT_CONFIG = {
  batchSize: 100,
  flushIntervalMs: 5000,
  headers: {} as Record<string, string>,
  retry: {
    maxAttempts: 3,
    initialDelayMs: 1000,
  },
} as const;

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create an HTTP batch tracker.
 *
 * Accepts internal events, enriches them with env/serviceKey,
 * and batches them for efficient delivery.
 *
 * Uses Effect's HttpClient for type-safe HTTP requests with
 * built-in error handling and retry support.
 */
export function createHttpBatchTracker(
  config: HttpBatchTrackerConfig
): Effect.Effect<EventTrackerService, never, HttpClient.HttpClient> {
  const cfg = {
    ...DEFAULT_CONFIG,
    ...config,
    headers: { ...DEFAULT_CONFIG.headers, ...config.headers },
    retry: { ...DEFAULT_CONFIG.retry, ...config.retry },
  };

  return Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;

    // Buffer stores internal events
    const buffer = yield* Ref.make<InternalWorkflowEvent[]>([]);

    // Send batch to endpoint (enriches events before sending)
    const sendBatch = (events: InternalWorkflowEvent[]): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (events.length === 0) return;

        // Enrich events with env/serviceKey for wire transmission
        const wireEvents: WorkflowEvent[] = events.map((event) =>
          enrichEvent(event, cfg.env, cfg.serviceKey)
        );

        // Build the request using Effect's HttpClient
        const request = HttpClientRequest.post(cfg.endpoint).pipe(
          HttpClientRequest.jsonBody({ events: wireEvents }),
          // Add custom headers
          (req) =>
            Object.entries(cfg.headers).reduce(
              (r, [key, value]) => HttpClientRequest.setHeader(r, key, value),
              req
            )
        );

        yield* httpClient.execute(request).pipe(
          HttpClientResponse.filterStatusOk,
          Effect.retry(
            Schedule.exponential(Duration.millis(cfg.retry.initialDelayMs)).pipe(
              Schedule.compose(Schedule.recurs(cfg.retry.maxAttempts))
            )
          ),
          Effect.catchAll(() => Effect.void) // Don't fail workflow on tracking error
        );
      });

    // Flush current buffer
    const flush = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        const events = yield* Ref.getAndSet(buffer, []);
        yield* sendBatch(events);
      });

    const service: EventTrackerService = {
      emit: (event) =>
        Effect.gen(function* () {
          yield* Ref.update(buffer, (events) => [...events, event]);

          // Check if we should flush
          const current = yield* Ref.get(buffer);
          if (current.length >= cfg.batchSize) {
            yield* flush();
          }
        }),

      flush,

      pending: () => Ref.get(buffer).pipe(Effect.map((b) => b.length)),
    };

    return service;
  });
}

/**
 * Create an HTTP batch tracker layer.
 *
 * Requires HttpClient to be provided in the context.
 * Use with `HttpClient.layer` from `@effect/platform`:
 *
 * ```typescript
 * import { HttpClient } from "@effect/platform";
 * import { NodeHttpClient } from "@effect/platform-node";
 *
 * const trackerLayer = HttpBatchTrackerLayer({
 *   endpoint: "https://events.example.com/ingest",
 *   env: "production",
 *   serviceKey: "my-service",
 * }).pipe(Layer.provide(NodeHttpClient.layer));
 * ```
 */
export const HttpBatchTrackerLayer = (config: HttpBatchTrackerConfig) =>
  Layer.effect(EventTracker, createHttpBatchTracker(config));
```

### 4. No-op Tracker (`tracker/noop.ts`)

```typescript
// packages/workflow-v2/src/tracker/noop.ts

import { Effect, Layer } from "effect";
import { EventTracker, type EventTrackerService } from "./tracker";

/**
 * No-op tracker that discards all events.
 * Useful for testing or when tracking is disabled.
 */
export const noopTracker: EventTrackerService = {
  emit: () => Effect.void,
  flush: () => Effect.void,
  pending: () => Effect.succeed(0),
};

/**
 * Layer that provides a no-op tracker.
 */
export const NoopTrackerLayer = Layer.succeed(EventTracker, noopTracker);
```

### 5. In-Memory Tracker for Testing (`tracker/in-memory.ts`)

```typescript
// packages/workflow-v2/src/tracker/in-memory.ts

import { Effect, Layer, Ref } from "effect";
import type { InternalWorkflowEvent, WorkflowEventType } from "@durable-effect/core";
import { EventTracker, type EventTrackerService } from "./tracker";

/**
 * In-memory tracker that stores events for testing.
 */
export interface InMemoryTrackerHandle {
  /**
   * Get all recorded events.
   */
  readonly getEvents: () => Effect.Effect<InternalWorkflowEvent[]>;

  /**
   * Get events of a specific type.
   */
  readonly getEventsByType: <T extends WorkflowEventType>(
    type: T
  ) => Effect.Effect<Array<Extract<InternalWorkflowEvent, { type: T }>>>;

  /**
   * Clear all recorded events.
   */
  readonly clear: () => Effect.Effect<void>;

  /**
   * Check if a specific event type was emitted.
   */
  readonly hasEvent: (type: WorkflowEventType) => Effect.Effect<boolean>;
}

/**
 * Create an in-memory tracker for testing.
 */
export function createInMemoryTracker(): Effect.Effect<{
  service: EventTrackerService;
  handle: InMemoryTrackerHandle;
}> {
  return Effect.gen(function* () {
    const events = yield* Ref.make<InternalWorkflowEvent[]>([]);

    const service: EventTrackerService = {
      emit: (event) => Ref.update(events, (e) => [...e, event]),
      flush: () => Effect.void,
      pending: () => Ref.get(events).pipe(Effect.map((e) => e.length)),
    };

    const handle: InMemoryTrackerHandle = {
      getEvents: () => Ref.get(events),

      getEventsByType: <T extends WorkflowEventType>(type: T) =>
        Ref.get(events).pipe(
          Effect.map(
            (e) => e.filter((ev) => ev.type === type) as Array<Extract<InternalWorkflowEvent, { type: T }>>
          )
        ),

      clear: () => Ref.set(events, []),

      hasEvent: (type) =>
        Ref.get(events).pipe(Effect.map((e) => e.some((ev) => ev.type === type))),
    };

    return { service, handle };
  });
}

/**
 * Create an in-memory tracker layer.
 * Returns both the layer and a handle for test assertions.
 */
export const createInMemoryTrackerLayer = () =>
  Effect.gen(function* () {
    const { service, handle } = yield* createInMemoryTracker();
    const layer = Layer.succeed(EventTracker, service);
    return { layer, handle };
  });
```

### 6. Tracker Exports (`tracker/index.ts`)

```typescript
// packages/workflow-v2/src/tracker/index.ts

// Re-export event types and helpers from core
export {
  createBaseEvent,
  enrichEvent,
  type InternalWorkflowEvent,
  type InternalBaseEvent,
  type WorkflowEvent,
  type WorkflowEventType,
} from "@durable-effect/core";

// Tracker service
export {
  EventTracker,
  emitEvent,
  flushEvents,
  type EventTrackerService,
} from "./tracker";

// HTTP batch tracker
export {
  createHttpBatchTracker,
  HttpBatchTrackerLayer,
  type HttpBatchTrackerConfig,
} from "./http-batch";

// No-op tracker
export { noopTracker, NoopTrackerLayer } from "./noop";

// In-memory tracker (testing)
export {
  createInMemoryTracker,
  createInMemoryTrackerLayer,
  type InMemoryTrackerHandle,
} from "./in-memory";
```

### 7. Update Main Index

```typescript
// packages/workflow-v2/src/index.ts

// ... existing exports ...

// Tracker
export {
  // Service
  EventTracker,
  emitEvent,
  flushEvents,
  type EventTrackerService,
  // Event types from core (re-exported for convenience)
  createBaseEvent,
  enrichEvent,
  type InternalWorkflowEvent,
  type WorkflowEvent,
  type WorkflowEventType,
  // Implementations
  HttpBatchTrackerLayer,
  type HttpBatchTrackerConfig,
  NoopTrackerLayer,
  createInMemoryTrackerLayer,
  type InMemoryTrackerHandle,
} from "./tracker";
```

---

## Testing Strategy

### Test File: `test/tracker/tracker.test.ts`

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Effect } from "effect";
import {
  createBaseEvent,
  type InternalWorkflowStartedEvent,
  type InternalStepStartedEvent,
  type InternalWorkflowCompletedEvent,
} from "@durable-effect/core";
import {
  EventTracker,
  emitEvent,
  NoopTrackerLayer,
  createInMemoryTrackerLayer,
  type InMemoryTrackerHandle,
} from "../../src";

// Helper to create typed events
const createWorkflowStartedEvent = (
  base: ReturnType<typeof createBaseEvent>,
  input: unknown
): InternalWorkflowStartedEvent => ({
  ...base,
  type: "workflow.started",
  input,
});

const createStepStartedEvent = (
  base: ReturnType<typeof createBaseEvent>,
  stepName: string,
  attempt: number
): InternalStepStartedEvent => ({
  ...base,
  type: "step.started",
  stepName,
  attempt,
});

const createWorkflowCompletedEvent = (
  base: ReturnType<typeof createBaseEvent>,
  durationMs: number,
  completedSteps: string[]
): InternalWorkflowCompletedEvent => ({
  ...base,
  type: "workflow.completed",
  durationMs,
  completedSteps,
});

describe("EventTracker", () => {
  describe("createBaseEvent from core", () => {
    it("should create base event with eventId and timestamp", () => {
      const base = createBaseEvent("wf-123", "testWorkflow", "exec-456");

      expect(base.workflowId).toBe("wf-123");
      expect(base.workflowName).toBe("testWorkflow");
      expect(base.executionId).toBe("exec-456");
      expect(base.eventId).toBeDefined(); // UUID v7
      expect(base.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe("emitEvent helper", () => {
    it("should emit event when tracker available", async () => {
      const { layer, handle } = await Effect.runPromise(
        createInMemoryTrackerLayer()
      );

      const base = createBaseEvent("wf-123", "test");
      const event = createWorkflowStartedEvent(base, { data: 42 });

      await Effect.runPromise(
        emitEvent(event).pipe(Effect.provide(layer))
      );

      const events = await Effect.runPromise(handle.getEvents());
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("workflow.started");
    });

    it("should do nothing when tracker not available", async () => {
      const base = createBaseEvent("wf-123", "test");
      const event = createWorkflowStartedEvent(base, {});

      // Should not throw
      await Effect.runPromise(emitEvent(event));
    });
  });

  describe("NoopTrackerLayer", () => {
    it("should discard all events", async () => {
      const base = createBaseEvent("wf-123", "test");
      const event = createWorkflowStartedEvent(base, {});

      await Effect.runPromise(
        Effect.gen(function* () {
          const tracker = yield* EventTracker;
          yield* tracker.emit(event);
          yield* tracker.emit(event);
          const pending = yield* tracker.pending();
          expect(pending).toBe(0);
        }).pipe(Effect.provide(NoopTrackerLayer))
      );
    });
  });

  describe("InMemoryTracker", () => {
    let handle: InMemoryTrackerHandle;
    let layer: any;

    beforeEach(async () => {
      const result = await Effect.runPromise(createInMemoryTrackerLayer());
      handle = result.handle;
      layer = result.layer;
    });

    it("should record all events", async () => {
      const base = createBaseEvent("wf-123", "test");

      await Effect.runPromise(
        Effect.gen(function* () {
          yield* emitEvent(createWorkflowStartedEvent(base, {}));
          yield* emitEvent(createStepStartedEvent(base, "step1", 1));
          yield* emitEvent(createWorkflowCompletedEvent(base, 100, ["step1"]));
        }).pipe(Effect.provide(layer))
      );

      const events = await Effect.runPromise(handle.getEvents());
      expect(events).toHaveLength(3);
    });

    it("should filter events by type", async () => {
      const base = createBaseEvent("wf-123", "test");

      await Effect.runPromise(
        Effect.gen(function* () {
          yield* emitEvent(createWorkflowStartedEvent(base, {}));
          yield* emitEvent(createStepStartedEvent(base, "step1", 1));
          yield* emitEvent(createStepStartedEvent(base, "step2", 1));
        }).pipe(Effect.provide(layer))
      );

      const stepEvents = await Effect.runPromise(
        handle.getEventsByType("step.started")
      );
      expect(stepEvents).toHaveLength(2);
    });

    it("should check for event presence", async () => {
      const base = createBaseEvent("wf-123", "test");

      const before = await Effect.runPromise(
        handle.hasEvent("workflow.started")
      );
      expect(before).toBe(false);

      await Effect.runPromise(
        emitEvent(createWorkflowStartedEvent(base, {})).pipe(Effect.provide(layer))
      );

      const after = await Effect.runPromise(
        handle.hasEvent("workflow.started")
      );
      expect(after).toBe(true);
    });

    it("should clear events", async () => {
      const base = createBaseEvent("wf-123", "test");

      await Effect.runPromise(
        emitEvent(createWorkflowStartedEvent(base, {})).pipe(Effect.provide(layer))
      );

      await Effect.runPromise(handle.clear());

      const events = await Effect.runPromise(handle.getEvents());
      expect(events).toHaveLength(0);
    });
  });
});
```

---

## Definition of Done

- [ ] Events imported from `@durable-effect/core` (not redefined)
- [ ] EventTracker service accepts `InternalWorkflowEvent` from core
- [ ] HTTP batch tracker enriches events with `env`/`serviceKey` before sending
- [ ] emitEvent helper works with optional tracker
- [ ] HTTP batch tracker sends events in batches with retry logic
- [ ] No-op tracker discards events
- [ ] In-memory tracker records for testing
- [ ] All tests passing
- [ ] Package builds without errors

---

## Notes for Implementation

1. **Reuse events from `@durable-effect/core`** - Don't redefine event types
2. **Internal vs Wire events** - Workflow code creates internal events; tracker enriches with `env`/`serviceKey`
3. **Use Effect's HttpClient** - From `@effect/platform`, not `fetch`. Provides type-safe requests, automatic JSON handling, and composable error handling
4. **Events are fire-and-forget** - Don't fail workflow on tracking errors
5. **Batching improves performance** - Don't send one request per event
6. **In-memory tracker for tests** - Verify events without network
7. **UUID v7 for eventId** - Core uses `uuid` package for sortable, unique event IDs
