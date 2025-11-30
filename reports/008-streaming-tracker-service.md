# Streaming Tracker Service Design

## Overview

This document proposes a design for a **streaming-based tracker service** that establishes a persistent connection to an external tracking application and pushes workflow events through an Effect Stream.

This is **separate** from workflow control (commands like cancel, pause, resume) - that remains a distinct concern handled through direct RPC or polling.

---

## Separation of Concerns

| Concern | Service | Direction | Mechanism |
|---------|---------|-----------|-----------|
| **Event Streaming** | `StreamingTrackerService` | Workflow → Tracker | Persistent connection (WebSocket/SSE) |
| **Workflow Control** | `WorkflowControlService` | Tracker → Workflow | RPC methods on Durable Object |

This document focuses exclusively on **Event Streaming**.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         DurableWorkflowEngine                           │
│                                                                         │
│  ┌──────────────┐      ┌───────────────┐      ┌────────────────────┐   │
│  │   Workflow   │      │    PubSub     │      │  StreamingTracker  │   │
│  │   Execution  │─────▶│  (internal)   │─────▶│     Service        │   │
│  │              │ emit │               │ sub  │                    │   │
│  └──────────────┘      └───────────────┘      └─────────┬──────────┘   │
│                                                         │              │
└─────────────────────────────────────────────────────────│──────────────┘
                                                          │
                                               WebSocket / SSE
                                                          │
                                                          ▼
                                        ┌─────────────────────────────┐
                                        │   External Tracker Service   │
                                        │   (user's infrastructure)    │
                                        └─────────────────────────────┘
```

---

## Core Components

### 1. Internal Event Bus (PubSub)

Events are published to an internal PubSub within the Durable Object. The streaming service subscribes to this bus.

```typescript
import { PubSub, Queue, Effect, Stream } from "effect";
import type { WorkflowEvent } from "./events";

/**
 * Internal event bus for workflow events.
 * Uses unbounded PubSub to ensure events are never dropped internally.
 */
export const createEventBus = Effect.gen(function* () {
  const pubsub = yield* PubSub.unbounded<WorkflowEvent>();

  return {
    /**
     * Publish an event to all subscribers.
     * Non-blocking - returns immediately.
     */
    publish: (event: WorkflowEvent) => PubSub.publish(pubsub, event),

    /**
     * Subscribe to the event stream.
     * Returns a Dequeue that receives all published events.
     */
    subscribe: PubSub.subscribe(pubsub),

    /**
     * Shutdown the event bus.
     */
    shutdown: PubSub.shutdown(pubsub),
  };
});

export type EventBus = Effect.Effect.Success<typeof createEventBus>;
```

### 2. Event Stream from PubSub

Convert the PubSub subscription into a Stream:

```typescript
import { Stream, Queue, Effect } from "effect";
import type { WorkflowEvent } from "./events";

/**
 * Create a Stream from an event bus subscription.
 * The stream emits events as they are published to the bus.
 */
export const eventStream = (eventBus: EventBus): Stream.Stream<WorkflowEvent> =>
  Stream.unwrapScoped(
    Effect.gen(function* () {
      const dequeue = yield* eventBus.subscribe;

      // Convert dequeue to stream using async callback
      return Stream.repeatEffectOption(
        Queue.take(dequeue).pipe(
          Effect.map((event) => event),
          // Signal end of stream when queue is shutdown
          Effect.catchAll(() => Effect.fail(Option.none()))
        )
      );
    })
  );
```

---

## StreamingTrackerService

The main service that manages the persistent connection and pushes events.

### Configuration

```typescript
export interface StreamingTrackerConfig {
  /**
   * WebSocket URL of the external tracker.
   * e.g., "wss://tracker.example.com/ws"
   */
  url: string;

  /**
   * Access token for authentication.
   */
  accessToken: string;

  /**
   * Reconnection settings.
   */
  reconnect?: {
    /** Maximum reconnection attempts. Default: Infinity */
    maxAttempts?: number;
    /** Initial delay between reconnects in ms. Default: 1000 */
    initialDelayMs?: number;
    /** Maximum delay between reconnects in ms. Default: 30000 */
    maxDelayMs?: number;
    /** Backoff multiplier. Default: 2 */
    backoffMultiplier?: number;
  };

  /**
   * Buffer settings for offline/disconnected periods.
   */
  buffer?: {
    /** Maximum events to buffer when disconnected. Default: 1000 */
    maxSize?: number;
    /** Strategy when buffer is full: "drop-oldest" | "drop-newest". Default: "drop-oldest" */
    overflowStrategy?: "drop-oldest" | "drop-newest";
  };

  /**
   * Heartbeat interval in ms. Default: 30000
   */
  heartbeatIntervalMs?: number;
}
```

### Service Interface

```typescript
import { Effect, Stream } from "effect";

export interface StreamingTrackerService {
  /**
   * Start streaming events to the tracker.
   * Establishes connection and begins pushing events.
   * Returns a fiber that can be interrupted to stop streaming.
   */
  start: Effect.Effect<void, StreamingTrackerError>;

  /**
   * Stop streaming and close the connection gracefully.
   */
  stop: Effect.Effect<void>;

  /**
   * Check if currently connected to the tracker.
   */
  isConnected: Effect.Effect<boolean>;

  /**
   * Get current buffer size (events waiting to be sent).
   */
  bufferSize: Effect.Effect<number>;
}

export class StreamingTrackerError {
  readonly _tag = "StreamingTrackerError";
  constructor(
    readonly reason: "connection_failed" | "auth_failed" | "send_failed" | "timeout",
    readonly message: string,
    readonly cause?: unknown
  ) {}
}
```

---

## Implementation

### Connection Management

```typescript
import { Effect, Stream, Queue, Ref, Schedule, Duration, Fiber, Option } from "effect";

interface ConnectionState {
  socket: WebSocket | null;
  connected: boolean;
  reconnectAttempt: number;
}

export const createStreamingTracker = (
  config: StreamingTrackerConfig,
  eventBus: EventBus
): Effect.Effect<StreamingTrackerService, never, Scope> =>
  Effect.gen(function* () {
    // Connection state
    const stateRef = yield* Ref.make<ConnectionState>({
      socket: null,
      connected: false,
      reconnectAttempt: 0,
    });

    // Buffer for events when disconnected
    const buffer = yield* Queue.sliding<WorkflowEvent>(
      config.buffer?.maxSize ?? 1000
    );

    // Fiber reference for the main streaming loop
    const streamFiberRef = yield* Ref.make<Fiber.Fiber<void, StreamingTrackerError> | null>(null);

    /**
     * Establish WebSocket connection with authentication.
     */
    const connect = Effect.gen(function* () {
      const socket = new WebSocket(config.url);

      // Wait for connection to open
      yield* Effect.async<void, StreamingTrackerError>((resume) => {
        socket.onopen = () => {
          // Send authentication message
          socket.send(JSON.stringify({
            type: "auth",
            token: config.accessToken,
          }));
        };

        socket.onmessage = (event) => {
          const data = JSON.parse(event.data);
          if (data.type === "auth_success") {
            resume(Effect.succeed(undefined));
          } else if (data.type === "auth_failed") {
            resume(Effect.fail(new StreamingTrackerError(
              "auth_failed",
              data.message ?? "Authentication failed"
            )));
          }
        };

        socket.onerror = (error) => {
          resume(Effect.fail(new StreamingTrackerError(
            "connection_failed",
            "WebSocket connection failed",
            error
          )));
        };

        // Timeout for connection
        const timeout = setTimeout(() => {
          socket.close();
          resume(Effect.fail(new StreamingTrackerError(
            "timeout",
            "Connection timeout"
          )));
        }, 10000);

        return Effect.sync(() => clearTimeout(timeout));
      });

      // Update state
      yield* Ref.set(stateRef, {
        socket,
        connected: true,
        reconnectAttempt: 0,
      });

      return socket;
    });

    /**
     * Send an event through the WebSocket.
     */
    const sendEvent = (socket: WebSocket, event: WorkflowEvent) =>
      Effect.try({
        try: () => {
          socket.send(JSON.stringify({
            type: "event",
            payload: event,
          }));
        },
        catch: (error) => new StreamingTrackerError(
          "send_failed",
          "Failed to send event",
          error
        ),
      });

    /**
     * Drain buffered events to the socket.
     */
    const drainBuffer = (socket: WebSocket) =>
      Effect.gen(function* () {
        const events = yield* Queue.takeAll(buffer);
        for (const event of events) {
          yield* sendEvent(socket, event);
        }
      });

    /**
     * Main streaming loop with reconnection.
     */
    const streamingLoop: Effect.Effect<void, StreamingTrackerError> = Effect.gen(function* () {
      // Connect with retry
      const socket = yield* connect.pipe(
        Effect.retry(
          Schedule.exponential(
            Duration.millis(config.reconnect?.initialDelayMs ?? 1000),
            config.reconnect?.backoffMultiplier ?? 2
          ).pipe(
            Schedule.either(
              Schedule.recurs(config.reconnect?.maxAttempts ?? Infinity)
            ),
            Schedule.upTo(Duration.millis(config.reconnect?.maxDelayMs ?? 30000))
          )
        ),
        Effect.tapError((error) =>
          Effect.log(`Connection failed: ${error.message}`)
        )
      );

      // Drain any buffered events
      yield* drainBuffer(socket);

      // Subscribe to event bus and stream events
      yield* Effect.scoped(
        Effect.gen(function* () {
          const dequeue = yield* eventBus.subscribe;

          // Process events from the subscription
          yield* Effect.forever(
            Effect.gen(function* () {
              const event = yield* Queue.take(dequeue);
              const state = yield* Ref.get(stateRef);

              if (state.connected && state.socket) {
                yield* sendEvent(state.socket, event).pipe(
                  Effect.catchAll((error) =>
                    // Buffer event if send fails
                    Effect.gen(function* () {
                      yield* Effect.log(`Send failed, buffering: ${error.message}`);
                      yield* Queue.offer(buffer, event);
                      yield* Ref.update(stateRef, (s) => ({
                        ...s,
                        connected: false,
                      }));
                    })
                  )
                );
              } else {
                // Buffer event when disconnected
                yield* Queue.offer(buffer, event);
              }
            })
          );
        })
      );
    }).pipe(
      // On disconnect, attempt reconnection
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          yield* Effect.log(`Disconnected: ${error.message}, reconnecting...`);
          yield* Ref.update(stateRef, (s) => ({
            ...s,
            connected: false,
            reconnectAttempt: s.reconnectAttempt + 1,
          }));
          // Recursive reconnection
          yield* streamingLoop;
        })
      )
    );

    /**
     * Heartbeat to keep connection alive.
     */
    const heartbeat = (socket: WebSocket) =>
      Effect.forever(
        Effect.gen(function* () {
          yield* Effect.sleep(Duration.millis(config.heartbeatIntervalMs ?? 30000));
          const state = yield* Ref.get(stateRef);
          if (state.connected && state.socket) {
            state.socket.send(JSON.stringify({ type: "ping" }));
          }
        })
      );

    // Return service implementation
    return {
      start: Effect.gen(function* () {
        const fiber = yield* Effect.fork(streamingLoop);
        yield* Ref.set(streamFiberRef, fiber);
      }),

      stop: Effect.gen(function* () {
        const fiber = yield* Ref.get(streamFiberRef);
        if (fiber) {
          yield* Fiber.interrupt(fiber);
        }
        const state = yield* Ref.get(stateRef);
        if (state.socket) {
          state.socket.close();
        }
        yield* Ref.set(stateRef, {
          socket: null,
          connected: false,
          reconnectAttempt: 0,
        });
      }),

      isConnected: Ref.get(stateRef).pipe(Effect.map((s) => s.connected)),

      bufferSize: Queue.size(buffer),
    };
  });
```

---

## Stream Operators for Event Processing

Apply transformations before sending to tracker:

```typescript
/**
 * Filter events by type.
 */
export const filterEvents = (types: WorkflowEvent["type"][]) =>
  Stream.filter<WorkflowEvent>((event) => types.includes(event.type));

/**
 * Batch events for efficient transmission.
 * Groups events within a time window or up to a max count.
 */
export const batchEvents = (options: {
  maxSize: number;
  windowMs: number;
}) =>
  Stream.groupedWithin<WorkflowEvent>(
    options.maxSize,
    Duration.millis(options.windowMs)
  );

/**
 * Add metadata to events (e.g., worker ID, timestamp).
 */
export const enrichEvents = (metadata: Record<string, unknown>) =>
  Stream.map<WorkflowEvent, WorkflowEvent>((event) => ({
    ...event,
    metadata: {
      ...event.metadata,
      ...metadata,
    },
  }));

/**
 * Throttle events to prevent overwhelming the tracker.
 */
export const throttleEvents = (eventsPerSecond: number) =>
  Stream.throttle<WorkflowEvent>({
    cost: () => 1,
    units: eventsPerSecond,
    duration: Duration.seconds(1),
    strategy: "shape", // Delay events rather than drop
  });

/**
 * Deduplicate events by eventId within a time window.
 */
export const deduplicateEvents = (windowMs: number) => {
  const seen = new Map<string, number>();

  return Stream.filter<WorkflowEvent>((event) => {
    const now = Date.now();
    const lastSeen = seen.get(event.eventId);

    // Clean old entries
    for (const [id, timestamp] of seen) {
      if (now - timestamp > windowMs) {
        seen.delete(id);
      }
    }

    if (lastSeen && now - lastSeen < windowMs) {
      return false; // Duplicate
    }

    seen.set(event.eventId, now);
    return true;
  });
};
```

### Using Operators

```typescript
const processedStream = eventStream(eventBus).pipe(
  // Only send certain event types
  filterEvents([
    "workflow.started",
    "workflow.completed",
    "workflow.failed",
    "step.failed",
  ]),
  // Enrich with worker metadata
  enrichEvents({
    workerId: env.WORKER_ID,
    region: env.CF_REGION,
  }),
  // Batch for efficiency
  batchEvents({ maxSize: 10, windowMs: 100 }),
  // Throttle to avoid overwhelming tracker
  throttleEvents(100),
);
```

---

## Safe Event Delivery

Ensure events are delivered even during failures:

```typescript
/**
 * Sink that sends events with retry and acknowledgment.
 */
export const createDeliverySink = (
  socket: WebSocket,
  config: { maxRetries: number; retryDelayMs: number }
) =>
  Sink.forEach<WorkflowEvent>((event) =>
    Effect.gen(function* () {
      yield* sendWithAck(socket, event).pipe(
        Effect.retry(
          Schedule.recurs(config.maxRetries).pipe(
            Schedule.addDelay(() => Duration.millis(config.retryDelayMs))
          )
        ),
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            // Log failed delivery but don't crash the stream
            yield* Effect.logError(`Failed to deliver event: ${error.message}`);
            // Optionally store in dead letter queue
            yield* storeInDeadLetterQueue(event);
          })
        )
      );
    })
  );

/**
 * Send event and wait for acknowledgment from tracker.
 */
const sendWithAck = (socket: WebSocket, event: WorkflowEvent) =>
  Effect.async<void, StreamingTrackerError>((resume) => {
    const messageId = crypto.randomUUID();

    const handler = (msg: MessageEvent) => {
      const data = JSON.parse(msg.data);
      if (data.type === "ack" && data.messageId === messageId) {
        socket.removeEventListener("message", handler);
        resume(Effect.succeed(undefined));
      }
    };

    socket.addEventListener("message", handler);
    socket.send(JSON.stringify({
      type: "event",
      messageId,
      payload: event,
    }));

    // Timeout for ack
    const timeout = setTimeout(() => {
      socket.removeEventListener("message", handler);
      resume(Effect.fail(new StreamingTrackerError(
        "timeout",
        "Acknowledgment timeout"
      )));
    }, 5000);

    return Effect.sync(() => {
      clearTimeout(timeout);
      socket.removeEventListener("message", handler);
    });
  });
```

---

## Resource Management

Proper cleanup when the workflow engine shuts down:

```typescript
/**
 * Create a scoped streaming tracker that cleans up on scope exit.
 */
export const scopedStreamingTracker = (
  config: StreamingTrackerConfig,
  eventBus: EventBus
) =>
  Effect.acquireRelease(
    // Acquire: create and start the tracker
    Effect.gen(function* () {
      const tracker = yield* createStreamingTracker(config, eventBus);
      yield* tracker.start;
      return tracker;
    }),
    // Release: stop the tracker gracefully
    (tracker) =>
      Effect.gen(function* () {
        yield* Effect.log("Shutting down streaming tracker...");

        // Wait for buffer to drain (with timeout)
        yield* Effect.gen(function* () {
          const bufferSize = yield* tracker.bufferSize;
          if (bufferSize > 0) {
            yield* Effect.log(`Draining ${bufferSize} buffered events...`);
            yield* Effect.sleep(Duration.seconds(5)); // Give time to drain
          }
        }).pipe(Effect.timeout(Duration.seconds(10)));

        yield* tracker.stop;
        yield* Effect.log("Streaming tracker shutdown complete");
      }).pipe(Effect.orDie)
  );
```

---

## User-Facing API

### Configuration Example

```typescript
// src/workflows/order.ts
import { Effect } from "effect";
import {
  createDurableWorkflows,
  step,
  createStreamingTracker,
} from "@durable-effect/workflow";

export const OrderWorkflows = createDurableWorkflows<Env>()({
  processOrder: (orderId: string) =>
    Effect.gen(function* () {
      yield* step("Fetch order", fetchOrder(orderId));
      yield* step("Process payment", processPayment(orderId));
      yield* step("Send confirmation", sendEmail(orderId));
    }),
}, {
  // Event streaming configuration (separate from control)
  streaming: {
    // Factory function receives env
    create: (env: Env) => ({
      url: env.TRACKER_WS_URL,        // e.g., "wss://tracker.example.com/ws"
      accessToken: env.TRACKER_TOKEN,
    }),

    // Optional: configure reconnection
    reconnect: {
      maxAttempts: 10,
      initialDelayMs: 1000,
      maxDelayMs: 30000,
    },

    // Optional: configure buffering
    buffer: {
      maxSize: 1000,
      overflowStrategy: "drop-oldest",
    },

    // Optional: filter which events to stream
    events: [
      "workflow.started",
      "workflow.completed",
      "workflow.failed",
      "step.failed",
    ],
  },
});
```

### Without Streaming (Default)

```typescript
// No streaming config = no streaming overhead
export const OrderWorkflows = createDurableWorkflows<Env>()({
  processOrder: orderWorkflow,
});
```

### Full Example with Both Services

```typescript
import { Effect } from "effect";
import { createDurableWorkflows, step, durableRetry } from "@durable-effect/workflow";

export const OrderWorkflows = createDurableWorkflows<Env>()({
  processOrder: (orderId: string) =>
    Effect.gen(function* () {
      const order = yield* step("Fetch order", fetchOrder(orderId));

      yield* step("Process payment",
        processPayment(order).pipe(
          durableRetry({ maxAttempts: 3, delayMs: 5000 })
        )
      );

      yield* step("Send confirmation", sendEmail(order.email));
    }),
}, {
  // Event streaming (Workflow → Tracker)
  streaming: {
    create: (env) => ({
      url: env.TRACKER_WS_URL,
      accessToken: env.TRACKER_TOKEN,
    }),
    events: ["workflow.started", "workflow.completed", "workflow.failed"],
  },

  // Workflow control is handled via RPC methods on the Durable Object:
  // - stub.cancel(reason)
  // - stub.pause(reason)
  // - stub.resume()
  // - stub.retryStep(stepName)
  // - stub.skipStep(stepName, value)
  //
  // These methods are always available, no configuration needed.
});

// Worker handler
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Start workflow
    if (url.pathname === "/orders" && request.method === "POST") {
      const { orderId } = await request.json<{ orderId: string }>();
      const id = env.ORDER_WORKFLOWS.idFromName(`order-${orderId}`);
      const stub = env.ORDER_WORKFLOWS.get(id);
      await stub.run("processOrder", orderId);
      return Response.json({ status: "started" });
    }

    // Control endpoints (separate from streaming)
    if (url.pathname.match(/^\/orders\/[\w-]+\/cancel$/)) {
      const orderId = url.pathname.split("/")[2];
      const id = env.ORDER_WORKFLOWS.idFromName(`order-${orderId}`);
      const stub = env.ORDER_WORKFLOWS.get(id);
      await stub.cancel("Cancelled via API");
      return Response.json({ cancelled: true });
    }

    if (url.pathname.match(/^\/orders\/[\w-]+\/pause$/)) {
      const orderId = url.pathname.split("/")[2];
      const id = env.ORDER_WORKFLOWS.idFromName(`order-${orderId}`);
      const stub = env.ORDER_WORKFLOWS.get(id);
      await stub.pause("Paused via API");
      return Response.json({ paused: true });
    }

    return new Response("Not found", { status: 404 });
  },
};
```

---

## External Tracker Protocol

The external tracking service should implement this WebSocket protocol:

### Client → Tracker

```typescript
// Authentication
{ type: "auth", token: string }

// Event delivery
{
  type: "event",
  messageId: string,
  payload: WorkflowEvent
}

// Heartbeat
{ type: "ping" }

// Batch events
{
  type: "events",
  messageId: string,
  payload: WorkflowEvent[]
}
```

### Tracker → Client

```typescript
// Authentication response
{ type: "auth_success" }
{ type: "auth_failed", message: string }

// Event acknowledgment
{ type: "ack", messageId: string }

// Heartbeat response
{ type: "pong" }

// Error
{ type: "error", message: string, code: string }
```

---

## Alternative: Server-Sent Events (SSE)

For simpler deployments, SSE can be used instead of WebSocket:

```typescript
/**
 * SSE-based streaming tracker.
 * Simpler than WebSocket, one-way only, automatic reconnection.
 */
export const createSSETracker = (
  config: { url: string; accessToken: string },
  eventBus: EventBus
): Effect.Effect<StreamingTrackerService, never, Scope> =>
  Effect.gen(function* () {
    const buffer = yield* Queue.sliding<WorkflowEvent>(1000);
    const connectedRef = yield* Ref.make(false);

    const sendEvent = (event: WorkflowEvent) =>
      Effect.tryPromise({
        try: () =>
          fetch(config.url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${config.accessToken}`,
            },
            body: JSON.stringify(event),
          }),
        catch: (error) =>
          new StreamingTrackerError("send_failed", "HTTP request failed", error),
      });

    const streamingLoop = Effect.gen(function* () {
      yield* Ref.set(connectedRef, true);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const dequeue = yield* eventBus.subscribe;

          yield* Effect.forever(
            Effect.gen(function* () {
              const event = yield* Queue.take(dequeue);

              yield* sendEvent(event).pipe(
                Effect.retry(Schedule.exponential(Duration.seconds(1))),
                Effect.catchAll((error) =>
                  Effect.gen(function* () {
                    yield* Effect.logError(`Failed to send: ${error.message}`);
                    yield* Queue.offer(buffer, event);
                  })
                )
              );
            })
          );
        })
      );
    });

    return {
      start: Effect.fork(streamingLoop).pipe(Effect.asVoid),
      stop: Ref.set(connectedRef, false),
      isConnected: Ref.get(connectedRef),
      bufferSize: Queue.size(buffer),
    };
  });
```

---

## Performance Considerations

### Batching

Batch events to reduce network overhead:

```typescript
const batchedStream = eventStream(eventBus).pipe(
  // Collect up to 50 events or 100ms worth
  Stream.groupedWithin(50, Duration.millis(100)),
  // Send batch as single message
  Stream.mapEffect((batch) => sendEventBatch(socket, batch))
);
```

### Backpressure

Use bounded buffers to prevent memory issues:

```typescript
// Sliding buffer drops oldest events when full
const buffer = yield* Queue.sliding<WorkflowEvent>(1000);

// Or dropping buffer drops newest events
const buffer = yield* Queue.dropping<WorkflowEvent>(1000);
```

### Compression

For high-volume scenarios, compress event payloads:

```typescript
const compressedEvent = (event: WorkflowEvent) =>
  Effect.gen(function* () {
    const json = JSON.stringify(event);
    const compressed = yield* Effect.tryPromise(() =>
      new Response(json).body!
        .pipeThrough(new CompressionStream("gzip"))
        .getReader()
        .read()
    );
    return compressed.value;
  });
```

---

## Summary

| Aspect | Design |
|--------|--------|
| **Architecture** | PubSub → Stream → WebSocket/SSE |
| **Direction** | One-way: Workflow → Tracker |
| **Connection** | Persistent with auto-reconnect |
| **Buffering** | Sliding/dropping queue during disconnection |
| **Delivery** | At-least-once with acknowledgments |
| **Resource cleanup** | Scoped with graceful shutdown |
| **Separation** | Streaming separate from control (RPC) |

This design leverages Effect Streams for composable event processing while maintaining a persistent, resilient connection to the external tracking service.
