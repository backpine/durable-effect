# HTTP Batch Tracker Service

## Overview

This document provides a detailed design and implementation for an **HTTP batch-based event tracker service** for `@durable-effect/workflow`. The service collects workflow events into a queue and sends them in batches to an external tracking service via HTTP POST.

**Key Principles:**
- **Pure Effect** - Queue-based batching using Effect jobs
- **Safe** - Tracker failures never impact workflow execution
- **Optional** - Zero overhead when not configured (uses `Effect.serviceOption`)
- **Configurable** - User controls batch size (`maxSize`) and buffer time (`maxWaitMs`)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         DurableWorkflowEngine                           │
│                                                                         │
│  ┌──────────────┐     emit()     ┌────────────────────────────────────┐ │
│  │   Workflow   │ ─────────────▶ │       EventTrackerService          │ │
│  │   Execution  │                │                                    │ │
│  └──────────────┘                │  ┌──────────┐    ┌─────────────┐   │ │
│         │                        │  │  Queue   │───▶│  Consumer   │   │ │
│         │ (lifecycle events)     │  │ (sliding)│    │  (batches)  │   │ │
│         ▼                        │  └──────────┘    └──────┬──────┘   │ │
│  • workflow.started              │                         │          │ │
│  • step.started                  │           flush when:   │          │ │
│  • step.completed                │           • maxSize hit │          │ │
│  • workflow.paused               │           • maxWaitMs   │          │ │
│  • workflow.completed            │             elapsed     │          │ │
│  • workflow.failed               │                         ▼          │ │
│                                  │              ┌─────────────────┐   │ │
│                                  │              │   HTTP POST     │   │ │
│                                  │              │   (Effect)      │   │ │
│                                  │              └────────┬────────┘   │ │
│                                  └───────────────────────│────────────┘ │
└──────────────────────────────────────────────────────────│──────────────┘
                                                           │
                                                           ▼
                                           ┌───────────────────────────┐
                                           │  External Tracker Service │
                                           │  POST /events             │
                                           └───────────────────────────┘
```

---

## Event Types

All events are sent to the tracker - no filtering.

### Base Event

```typescript
interface BaseEvent {
  eventId: string;
  timestamp: string;
  workflowId: string;
  workflowName: string;
}
```

### Workflow Events

```typescript
interface WorkflowStartedEvent extends BaseEvent {
  type: "workflow.started";
  input: unknown;
}

interface WorkflowCompletedEvent extends BaseEvent {
  type: "workflow.completed";
  completedSteps: string[];
  durationMs: number;
}

interface WorkflowFailedEvent extends BaseEvent {
  type: "workflow.failed";
  error: {
    message: string;
    stack?: string;
    stepName?: string;
    attempt?: number;
  };
  completedSteps: string[];
}

interface WorkflowPausedEvent extends BaseEvent {
  type: "workflow.paused";
  reason: "sleep" | "retry";
  resumeAt?: string;
  stepName?: string;
}

interface WorkflowResumedEvent extends BaseEvent {
  type: "workflow.resumed";
}
```

### Step Events

```typescript
interface StepStartedEvent extends BaseEvent {
  type: "step.started";
  stepName: string;
  attempt: number;
}

interface StepCompletedEvent extends BaseEvent {
  type: "step.completed";
  stepName: string;
  attempt: number;
  durationMs: number;
  cached: boolean;
}

interface StepFailedEvent extends BaseEvent {
  type: "step.failed";
  stepName: string;
  attempt: number;
  error: {
    message: string;
    stack?: string;
  };
  willRetry: boolean;
}
```

### Retry Events

```typescript
interface RetryScheduledEvent extends BaseEvent {
  type: "retry.scheduled";
  stepName: string;
  attempt: number;
  nextAttemptAt: string;
  delayMs: number;
}

interface RetryExhaustedEvent extends BaseEvent {
  type: "retry.exhausted";
  stepName: string;
  attempts: number;
}
```

### Sleep Events

```typescript
interface SleepStartedEvent extends BaseEvent {
  type: "sleep.started";
  durationMs: number;
  resumeAt: string;
}

interface SleepCompletedEvent extends BaseEvent {
  type: "sleep.completed";
  durationMs: number;
}
```

### Timeout Events

```typescript
interface TimeoutSetEvent extends BaseEvent {
  type: "timeout.set";
  stepName: string;
  deadline: string;
  timeoutMs: number;
}

interface TimeoutExceededEvent extends BaseEvent {
  type: "timeout.exceeded";
  stepName: string;
  timeoutMs: number;
}
```

### Complete Union Type

```typescript
type WorkflowEvent =
  | WorkflowStartedEvent
  | WorkflowCompletedEvent
  | WorkflowFailedEvent
  | WorkflowPausedEvent
  | WorkflowResumedEvent
  | StepStartedEvent
  | StepCompletedEvent
  | StepFailedEvent
  | RetryScheduledEvent
  | RetryExhaustedEvent
  | SleepStartedEvent
  | SleepCompletedEvent
  | TimeoutSetEvent
  | TimeoutExceededEvent;
```

---

## Configuration

```typescript
export interface EventTrackerConfig {
  /**
   * HTTP endpoint to POST events to.
   * e.g., "https://tracker.example.com/api/events"
   */
  url: string;

  /**
   * Access token for authentication.
   * Sent as Bearer token in Authorization header.
   */
  accessToken: string;

  /**
   * Batching configuration.
   */
  batch?: {
    /**
     * Maximum number of events per batch.
     * When reached, batch is sent immediately.
     * Default: 50
     */
    maxSize?: number;

    /**
     * Maximum time to wait before sending a batch (ms).
     * Events are sent when this time elapses, even if batch isn't full.
     * Default: 1000 (1 second)
     */
    maxWaitMs?: number;
  };

  /**
   * Retry configuration for failed HTTP requests.
   */
  retry?: {
    /**
     * Maximum retry attempts.
     * Default: 3
     */
    maxAttempts?: number;

    /**
     * Initial delay between retries (ms).
     * Default: 100
     */
    initialDelayMs?: number;

    /**
     * Maximum delay between retries (ms).
     * Default: 5000
     */
    maxDelayMs?: number;
  };

  /**
   * HTTP request timeout (ms).
   * Default: 10000
   */
  timeoutMs?: number;
}
```

---

## Optional Service Pattern

Using Effect's `serviceOption` for proper optional service handling.

### Service Definition

```typescript
// packages/workflow/src/services/event-tracker.ts
import { Context, Effect, Option } from "effect";

export interface EventTrackerService {
  readonly emit: (event: WorkflowEvent) => Effect.Effect<void>;
  readonly flush: Effect.Effect<void>;
  readonly pendingCount: Effect.Effect<number>;
}

export class EventTracker extends Context.Tag("@durable-effect/EventTracker")<
  EventTracker,
  EventTrackerService
>() {}
```

### Safe Event Emission

```typescript
/**
 * Safely emit an event.
 * If tracker is not configured, this is a no-op.
 */
export const emitEvent = (event: WorkflowEvent): Effect.Effect<void> =>
  Effect.gen(function* () {
    const maybeTracker = yield* Effect.serviceOption(EventTracker);

    if (Option.isSome(maybeTracker)) {
      yield* maybeTracker.value.emit(event);
    }
  });

/**
 * Safely flush pending events.
 */
export const flushEvents: Effect.Effect<void> =
  Effect.gen(function* () {
    const maybeTracker = yield* Effect.serviceOption(EventTracker);

    if (Option.isSome(maybeTracker)) {
      yield* maybeTracker.value.flush;
    }
  });
```

---

## Implementation

### Queue-Based Batch Tracker

Using Effect Queue with a background consumer that batches events based on `maxSize` or `maxWaitMs`.

```typescript
// packages/workflow/src/tracker/http-batch-tracker.ts
import {
  Effect,
  Queue,
  Fiber,
  Duration,
  Schedule,
  Chunk,
  Scope,
  Option,
} from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform";

/**
 * Create an EventTrackerService with queue-based HTTP batch delivery.
 */
export const createHttpBatchTracker = (
  config: EventTrackerConfig
): Effect.Effect<EventTrackerService, never, Scope.Scope | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    // Apply defaults
    const maxSize = config.batch?.maxSize ?? 50;
    const maxWaitMs = config.batch?.maxWaitMs ?? 1000;
    const maxRetries = config.retry?.maxAttempts ?? 3;
    const initialDelay = config.retry?.initialDelayMs ?? 100;
    const maxDelay = config.retry?.maxDelayMs ?? 5000;
    const timeoutMs = config.timeoutMs ?? 10000;

    // Get HTTP client from context
    const httpClient = yield* HttpClient.HttpClient;

    // Sliding queue - drops oldest events when full (back-pressure protection)
    const eventQueue = yield* Queue.sliding<WorkflowEvent>(1000);

    // Signal for manual flush
    const flushSignal = yield* Queue.unbounded<void>();

    /**
     * Send a batch of events via HTTP POST using Effect HttpClient.
     */
    const sendBatch = (
      events: ReadonlyArray<WorkflowEvent>
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (events.length === 0) return;

        yield* HttpClientRequest.post(config.url).pipe(
          HttpClientRequest.bodyJson({ events }),
          Effect.flatMap((request) =>
            request.pipe(
              HttpClientRequest.bearerToken(config.accessToken),
              httpClient.execute,
              Effect.flatMap(
                HttpClientResponse.filterStatusOk
              ),
              Effect.scoped,
              Effect.timeout(Duration.millis(timeoutMs)),
            )
          ),
          // Retry with exponential backoff
          Effect.retry(
            Schedule.exponential(Duration.millis(initialDelay), 2).pipe(
              Schedule.intersect(Schedule.recurs(maxRetries)),
              Schedule.upTo(Duration.millis(maxDelay))
            )
          ),
          // CRITICAL: Catch all errors - tracker failures must never propagate
          Effect.catchAll((error) =>
            Effect.logWarning(`Event tracker failed to send batch: ${error}`)
          ),
          Effect.asVoid,
        );
      });

    /**
     * Background consumer that collects events into batches.
     * Sends batch when:
     * 1. maxSize events collected, OR
     * 2. maxWaitMs elapsed since first event in batch
     */
    const consumer: Effect.Effect<void> = Effect.gen(function* () {
      while (true) {
        // Wait for first event (blocks until available)
        const firstEvent = yield* Queue.take(eventQueue);
        const batch: WorkflowEvent[] = [firstEvent];
        const batchStartTime = Date.now();

        // Collect more events until maxSize or maxWaitMs
        while (batch.length < maxSize) {
          const elapsed = Date.now() - batchStartTime;
          const remaining = Math.max(0, maxWaitMs - elapsed);

          if (remaining === 0) break;

          // Race: get next event OR flush signal OR timeout
          const result = yield* Effect.raceAll([
            Queue.take(eventQueue).pipe(
              Effect.map((e) => ({ _tag: "event" as const, event: e }))
            ),
            Queue.take(flushSignal).pipe(
              Effect.map(() => ({ _tag: "flush" as const }))
            ),
            Effect.sleep(Duration.millis(remaining)).pipe(
              Effect.map(() => ({ _tag: "timeout" as const }))
            ),
          ]);

          if (result._tag === "event") {
            batch.push(result.event);
          } else {
            // Flush signal or timeout - send what we have
            break;
          }
        }

        // Send the collected batch
        yield* sendBatch(batch);
      }
    });

    // Start background consumer
    const consumerFiber = yield* Effect.fork(consumer);

    // Cleanup on scope close
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        // Signal flush for any remaining events
        yield* Queue.offer(flushSignal, undefined);

        // Take any remaining events and send them
        const remaining = yield* Queue.takeAll(eventQueue);
        if (Chunk.size(remaining) > 0) {
          yield* sendBatch(Chunk.toReadonlyArray(remaining));
        }

        // Shutdown queues
        yield* Queue.shutdown(eventQueue);
        yield* Queue.shutdown(flushSignal);
        yield* Fiber.interrupt(consumerFiber);

        yield* Effect.logDebug("Event tracker shutdown complete");
      })
    );

    // Return service implementation
    return {
      emit: (event: WorkflowEvent): Effect.Effect<void> =>
        Queue.offer(eventQueue, event).pipe(Effect.asVoid),

      flush: Queue.offer(flushSignal, undefined).pipe(Effect.asVoid),

      pendingCount: Queue.size(eventQueue),
    };
  });
```

### Key Queue Operations Used

| Operation | Purpose |
|-----------|---------|
| `Queue.sliding(1000)` | Bounded queue that drops oldest when full |
| `Queue.take(queue)` | Blocks until event available |
| `Queue.offer(queue, event)` | Non-blocking add to queue |
| `Queue.takeAll(queue)` | Get all remaining events (for shutdown) |
| `Queue.shutdown(queue)` | Clean shutdown |

### Batching Logic

```
┌─────────────────────────────────────────────────────────────┐
│                    Consumer Loop                            │
│                                                             │
│  1. Wait for first event (blocking)                         │
│     ↓                                                       │
│  2. Start batch timer                                       │
│     ↓                                                       │
│  3. Collect events until:                                   │
│     • batch.length >= maxSize  → send immediately           │
│     • maxWaitMs elapsed        → send what we have          │
│     • flush signal received    → send what we have          │
│     ↓                                                       │
│  4. Send batch via HTTP POST                                │
│     ↓                                                       │
│  5. Repeat from step 1                                      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Engine Integration

### Providing the Tracker Service

```typescript
// packages/workflow/src/engine.ts
import { Effect, Scope, Layer } from "effect";
import { HttpClient, FetchHttpClient } from "@effect/platform";
import { EventTracker, emitEvent, flushEvents } from "./services/event-tracker";
import { createHttpBatchTracker } from "./tracker/http-batch-tracker";

export interface WorkflowEngineConfig {
  tracker?: EventTrackerConfig;
}

export function createDurableWorkflows<T extends WorkflowRegistry>(
  workflows: T,
  config?: WorkflowEngineConfig
) {
  return class DurableWorkflowEngine extends DurableObject<Env> {
    #tracker: EventTrackerService | null = null;
    #trackerScope: Scope.CloseableScope | null = null;
    #workflowStartTime: number = 0;

    constructor(ctx: DurableObjectState, env: Env) {
      super(ctx, env);

      if (config?.tracker) {
        this.#initTracker(config.tracker);
      }
    }

    async #initTracker(trackerConfig: EventTrackerConfig): Promise<void> {
      const program = Effect.gen(function* () {
        const scope = yield* Scope.make();

        const tracker = yield* createHttpBatchTracker(trackerConfig).pipe(
          Scope.extend(scope)
        );

        return { scope, tracker };
      }).pipe(
        // Provide HTTP client layer
        Effect.provide(FetchHttpClient.layer)
      );

      const { scope, tracker } = await Effect.runPromise(program);
      this.#trackerScope = scope;
      this.#tracker = tracker;
    }

    async #executeWorkflow(
      workflowId: string,
      workflowName: string,
      input: unknown
    ): Promise<void> {
      // Build workflow effect
      let workflowEffect = workflowDef
        .definition(input)
        .pipe(
          Effect.provideService(ExecutionContext, execCtx),
          Effect.provideService(WorkflowContext, workflowCtx),
        );

      // Provide tracker if configured
      if (this.#tracker) {
        workflowEffect = workflowEffect.pipe(
          Effect.provideService(EventTracker, this.#tracker)
        );
      }

      // Emit workflow.started
      if (this.#tracker) {
        await Effect.runPromise(
          this.#tracker.emit({
            type: "workflow.started",
            eventId: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            workflowId,
            workflowName,
            input,
          })
        );
      }

      // Execute workflow
      const result = await Effect.runPromiseExit(workflowEffect);

      // Emit result events...
      // (workflow.completed, workflow.paused, or workflow.failed)

      // Flush before returning
      if (this.#tracker) {
        await Effect.runPromise(this.#tracker.flush);
      }
    }
  };
}
```

---

## User-Facing API

### Basic Usage

```typescript
// src/workflows.ts
import { Effect } from "effect";
import { Workflow, createDurableWorkflows } from "@durable-effect/workflow";

const processOrderWorkflow = Workflow.make("processOrder", (orderId: string) =>
  Effect.gen(function* () {
    const order = yield* Workflow.step("Fetch order", fetchOrder(orderId));

    yield* Workflow.step("Process payment",
      processPayment(order).pipe(
        Workflow.retry({ maxAttempts: 3, delay: "5 seconds" })
      )
    );

    yield* Workflow.sleep("1 minute");

    yield* Workflow.step("Send confirmation", sendEmail(order.email));
  })
);

const greetWorkflow = Workflow.make("greet", (input: { name: string }) =>
  Effect.gen(function* () {
    yield* Workflow.step("Generate greeting",
      Effect.succeed(`Hello, ${input.name}!`)
    );
  })
);

// Create workflows with optional tracker
const workflows = {
  processOrder: processOrderWorkflow,
  greet: greetWorkflow,
} as const;

export const Workflows = createDurableWorkflows(workflows, {
  tracker: {
    url: "https://tracker.example.com/api/events",
    accessToken: "your-api-token",
    batch: {
      maxSize: 50,
      maxWaitMs: 1000,
    },
  },
});

export type WorkflowsType = InstanceType<typeof Workflows>;
```

### Without Tracker (Zero Overhead)

```typescript
// No tracker = emitEvent becomes no-op via Effect.serviceOption
const workflows = {
  processOrder: processOrderWorkflow,
  greet: greetWorkflow,
} as const;

export const Workflows = createDurableWorkflows(workflows);
```

---

## External Tracker API

### Request Format

```
POST /api/events
Content-Type: application/json
Authorization: Bearer <access-token>

{
  "events": [
    {
      "type": "workflow.started",
      "eventId": "evt_abc123",
      "timestamp": "2024-01-15T10:30:00.000Z",
      "workflowId": "do_xyz789",
      "workflowName": "processOrder",
      "input": { "orderId": "order-456" }
    },
    {
      "type": "step.started",
      "eventId": "evt_def456",
      "timestamp": "2024-01-15T10:30:00.050Z",
      "workflowId": "do_xyz789",
      "workflowName": "processOrder",
      "stepName": "Fetch order",
      "attempt": 0
    }
  ]
}
```

### Response Format

```
HTTP/1.1 200 OK
Content-Type: application/json

{
  "received": 2
}
```

---

## Safety Guarantees

### 1. Optional Service Pattern

```typescript
const emitEvent = (event: WorkflowEvent): Effect.Effect<void> =>
  Effect.gen(function* () {
    const maybeTracker = yield* Effect.serviceOption(EventTracker);
    if (Option.isSome(maybeTracker)) {
      yield* maybeTracker.value.emit(event);
    }
    // Option.none() = no-op
  });
```

### 2. Error Isolation

```typescript
// All HTTP errors caught - never propagate to workflow
Effect.catchAll((error) =>
  Effect.logWarning(`Event tracker failed: ${error}`)
)
```

### 3. Non-Blocking Emission

```typescript
// Queue.offer is non-blocking
emit: (event) => Queue.offer(eventQueue, event).pipe(Effect.asVoid)
```

### 4. Buffer Overflow Protection

```typescript
// Sliding queue drops oldest events when full
const eventQueue = yield* Queue.sliding<WorkflowEvent>(1000);
```

### 5. Graceful Shutdown

```typescript
yield* Effect.addFinalizer(() =>
  Effect.gen(function* () {
    yield* Queue.offer(flushSignal, undefined);
    const remaining = yield* Queue.takeAll(eventQueue);
    if (Chunk.size(remaining) > 0) {
      yield* sendBatch(Chunk.toReadonlyArray(remaining));
    }
    yield* Queue.shutdown(eventQueue);
  })
);
```

---

## Summary

| Aspect | Design |
|--------|--------|
| **Service Pattern** | `Effect.serviceOption(EventTracker)` |
| **Configuration** | Direct `url` + `accessToken` |
| **Events** | All 14 event types sent |
| **Queue** | `Queue.sliding` for back-pressure |
| **Batching** | `maxSize` OR `maxWaitMs` triggers send |
| **HTTP Client** | Effect `HttpClient` with `bearerToken` |
| **Safety** | All errors caught, never impacts workflow |
| **Overhead** | Zero when tracker not configured |

Sources:
- [Effect Queue Documentation](https://effect.website/docs/concurrency/queue/)
- [HttpClient.ts API](https://effect-ts.github.io/effect/platform/HttpClient.ts.html)
- [HttpClientRequest.ts API](https://effect-ts.github.io/effect/platform/HttpClientRequest.ts.html)
