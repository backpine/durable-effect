# Queue Primitive API Design

## Design Philosophy

The Queue primitive processes events sequentially with controlled concurrency. It follows the same Effect-first patterns as Continuous and Buffer:

1. **Effect-first** - All operations are Effects, yieldable in generators
2. **Schema-driven** - Events are defined via Effect Schema
3. **Idempotent by default** - Client operations use IDs to ensure exactly-once semantics
4. **Explicit concurrency** - User must define concurrency (no hidden defaults)
5. **Smart routing** - Client handles distribution across queue instances

---

## Core Concept

A Queue:
1. Receives events via `client.queue("name").enqueue({ id, event })`
2. Client routes to one of N instances based on concurrency setting
3. Each instance processes events **one at a time** in FIFO order
4. After processing, moves to next event (or idles if empty)

**Key distinction from Buffer:**
- Buffer: Accumulates → Flush all at once → Purge
- Queue: Enqueue → Process one → Repeat until empty

---

## Naming Decision

Considered names:
| Name | Pros | Cons |
|------|------|------|
| `Queue` | Simple, universally understood | Generic |
| `WorkQueue` | Explicit about purpose | Longer |
| `JobQueue` | Common pattern | Implies batch jobs |
| `TaskQueue` | Clear | Could conflict with Effect Task |
| `Processor` | Describes action | Doesn't imply queuing |
| `Channel` | Go/Clojure terminology | Less familiar |
| `Pipeline` | Implies chaining | Misleading |

**Decision: `Queue`** - Simple, clear, and the most intuitive name for this pattern.

---

## API Overview

### Definition

```ts
import { Queue } from "@durable-effect/primitives";
import { Schema } from "effect";

const webhookProcessor = Queue.make({
  eventSchema: Schema.Struct({
    type: Schema.String,
    webhookId: Schema.String,
    payload: Schema.Unknown,
    receivedAt: Schema.Number,
  }),

  concurrency: 5,

  execute: (ctx) =>
    Effect.gen(function* () {
      const event = yield* ctx.event;

      // Process the webhook
      yield* deliverWebhook(event.payload);

      console.log(`Processed webhook ${event.webhookId}`);
    }),
});
```

### Registration & Export

```ts
import { createDurablePrimitives } from "@durable-effect/primitives";

const { Primitives, PrimitivesClient } = createDurablePrimitives({
  webhookProcessor,
  // ... other primitives
});

// Export DO class for Cloudflare
export { Primitives };
```

### Client Usage

```ts
// In your worker/webhook handler
const client = PrimitivesClient.fromBinding(env.PRIMITIVES);

// Enqueue event (client handles routing to 1 of 5 instances)
yield* client.queue("webhookProcessor").enqueue({
  id: webhookId,  // Idempotency key
  event: {
    type: "order.shipped",
    webhookId: webhookId,
    payload: webhookPayload,
    receivedAt: Date.now(),
  },
});
```

---

## Detailed API

### `Queue.make(config)`

Creates a Queue definition.

```ts
interface QueueConfig<E extends Schema.Schema.AnyNoContext, Err, R> {
  /**
   * Effect Schema defining the event shape.
   * Events enqueued via client.enqueue() must match this schema.
   */
  readonly eventSchema: E;

  /**
   * Number of concurrent queue instances.
   * REQUIRED - no default. User must explicitly choose.
   *
   * Each instance processes one event at a time.
   * Total throughput = concurrency × (events per instance per second).
   */
  readonly concurrency: number;

  /**
   * Execute handler for a single event.
   * Called for each event in FIFO order.
   */
  readonly execute: (
    ctx: QueueExecuteContext<Schema.Schema.Type<E>>
  ) => Effect.Effect<void, Err, R>;

  /**
   * Optional retry configuration for failed processing.
   * @default { maxAttempts: 3, delay: Backoff.exponential({ base: "1 second" }) }
   */
  readonly retry?: {
    readonly maxAttempts: number;
    readonly delay?: Duration.DurationInput | BackoffStrategy;
    readonly isRetryable?: (error: Err) => boolean;
  };

  /**
   * Optional handler for events that fail after all retries.
   * If not provided, failed events are logged and discarded.
   */
  readonly onDeadLetter?: (
    event: Schema.Schema.Type<E>,
    error: Err,
    ctx: QueueDeadLetterContext
  ) => Effect.Effect<void, never, R>;

  /**
   * Optional handler called when queue becomes empty.
   * Useful for cleanup or notifications.
   */
  readonly onEmpty?: (
    ctx: QueueEmptyContext
  ) => Effect.Effect<void, never, R>;
}
```

### `QueueExecuteContext<E>`

The context provided to the `execute` function.

```ts
interface QueueExecuteContext<E> {
  /**
   * The event being processed.
   */
  readonly event: Effect.Effect<E, never, never>;

  /**
   * The unique ID of this event (provided at enqueue time).
   */
  readonly eventId: string;

  /**
   * The current retry attempt (1-indexed).
   * First attempt = 1, first retry = 2, etc.
   */
  readonly attempt: number;

  /**
   * Timestamp when this event was enqueued.
   */
  readonly enqueuedAt: number;

  /**
   * Timestamp when processing started for this attempt.
   */
  readonly processingStartedAt: number;

  /**
   * The queue instance index (0 to concurrency-1).
   */
  readonly instanceIndex: number;

  /**
   * Total events processed by this instance (lifetime).
   */
  readonly processedCount: Effect.Effect<number, never, never>;

  /**
   * Number of events currently waiting in this instance's queue.
   */
  readonly pendingCount: Effect.Effect<number, never, never>;
}
```

### `QueueDeadLetterContext`

Context for dead letter handling.

```ts
interface QueueDeadLetterContext {
  /**
   * The event ID.
   */
  readonly eventId: string;

  /**
   * Number of attempts made.
   */
  readonly attempts: number;

  /**
   * Timestamp when first enqueued.
   */
  readonly enqueuedAt: number;

  /**
   * Timestamp of final failure.
   */
  readonly failedAt: number;

  /**
   * The queue instance index.
   */
  readonly instanceIndex: number;
}
```

---

## Client Routing Logic

The client is responsible for distributing events across queue instances. This happens **in the client**, not the DO.

### Instance ID Resolution

```ts
// Internal client logic (conceptual)
function resolveInstanceId(
  queueName: string,
  concurrency: number,
  eventId: string,
  partitionKey?: string
): string {
  // Determine which instance (0 to concurrency-1)
  const instanceIndex = partitionKey
    ? consistentHash(partitionKey, concurrency)
    : roundRobinIndex(queueName, concurrency);

  // Instance ID format: {queueName}:{instanceIndex}
  return `${queueName}:${instanceIndex}`;
}
```

### Round Robin (Default)

When no partition key is provided, events are distributed round-robin:

```ts
// Simplified round-robin (actual implementation uses atomic counter)
let counter = 0;
function roundRobinIndex(queueName: string, concurrency: number): number {
  return counter++ % concurrency;
}
```

**Characteristics:**
- Even distribution across instances
- No ordering guarantees across events
- Maximum throughput

### Consistent Hashing (With Partition Key)

When a partition key is provided, the same key always routes to the same instance:

```ts
function consistentHash(key: string, concurrency: number): number {
  const hash = hashString(key);  // e.g., murmur3, xxhash
  return hash % concurrency;
}
```

**Characteristics:**
- Same partition key → same instance → FIFO ordering within partition
- Useful when events for the same entity must be processed in order
- Risk: Hot partitions if key distribution is uneven

---

## Client API

### Getting a Queue Client

```ts
const client = PrimitivesClient.fromBinding(env.PRIMITIVES);
const webhookQueue = client.queue("webhookProcessor");
```

### `enqueue(options)`

Add an event to the queue. **Idempotent** - same `id` is deduplicated.

```ts
interface QueueEnqueueOptions<E> {
  /**
   * Unique identifier for this event.
   * Used for idempotency - same ID won't be processed twice.
   */
  readonly id: string;

  /**
   * The event to process. Must match eventSchema.
   */
  readonly event: E;

  /**
   * Optional partition key for consistent routing.
   * Events with the same partition key go to the same instance,
   * ensuring FIFO ordering within that partition.
   *
   * WARNING: Choose partition keys with good distribution.
   * Hot partitions will create bottlenecks.
   */
  readonly partitionKey?: string;

  /**
   * Optional priority (higher = processed first).
   * Within same priority, FIFO ordering is maintained.
   * @default 0
   */
  readonly priority?: number;
}

// Usage - round robin (default)
const result = yield* webhookQueue.enqueue({
  id: webhookId,
  event: {
    type: "order.shipped",
    webhookId: webhookId,
    payload: data,
    receivedAt: Date.now(),
  },
});

// Usage - with partition key (ordered per customer)
const result = yield* webhookQueue.enqueue({
  id: webhookId,
  event: { ... },
  partitionKey: customerId,  // All events for this customer go to same instance
});

// Returns
interface QueueEnqueueResult {
  readonly eventId: string;
  readonly instanceId: string;
  readonly instanceIndex: number;
  readonly position: number;      // Position in queue (0 = processing now)
  readonly created: boolean;      // false if duplicate
}
```

### `enqueueMany(options)`

Batch enqueue multiple events.

```ts
interface QueueEnqueueManyOptions<E> {
  /**
   * Events to enqueue.
   */
  readonly events: ReadonlyArray<{
    readonly id: string;
    readonly event: E;
    readonly partitionKey?: string;
    readonly priority?: number;
  }>;
}

// Usage
const results = yield* webhookQueue.enqueueMany({
  events: webhooks.map(w => ({
    id: w.id,
    event: w,
    partitionKey: w.customerId,
  })),
});

// Returns
interface QueueEnqueueManyResult {
  readonly enqueued: number;
  readonly duplicates: number;
  readonly results: ReadonlyArray<QueueEnqueueResult>;
}
```

### `status()`

Get overall queue status across all instances.

```ts
const status = yield* webhookQueue.status();

interface QueueStatus {
  readonly concurrency: number;
  readonly instances: ReadonlyArray<{
    readonly index: number;
    readonly instanceId: string;
    readonly status: "processing" | "idle" | "paused";
    readonly pendingCount: number;
    readonly processedCount: number;
    readonly currentEventId: string | null;
  }>;
  readonly totalPending: number;
  readonly totalProcessed: number;
}
```

### `instanceStatus(index)`

Get status of a specific instance.

```ts
const status = yield* webhookQueue.instanceStatus(0);

interface QueueInstanceStatus {
  readonly index: number;
  readonly instanceId: string;
  readonly status: "processing" | "idle" | "paused";
  readonly pendingCount: number;
  readonly processedCount: number;
  readonly currentEventId: string | null;
  readonly currentEventStartedAt: number | null;
  readonly queuedEvents: ReadonlyArray<{
    readonly eventId: string;
    readonly enqueuedAt: number;
    readonly priority: number;
  }>;
}
```

### `pause(index?)` / `resume(index?)`

Pause/resume processing.

```ts
// Pause all instances
yield* webhookQueue.pause();

// Pause specific instance
yield* webhookQueue.pause(2);

// Resume
yield* webhookQueue.resume();
yield* webhookQueue.resume(2);
```

### `cancel(eventId)`

Cancel a pending event (if not yet processing).

```ts
const result = yield* webhookQueue.cancel(eventId);

interface QueueCancelResult {
  readonly cancelled: boolean;
  readonly reason: "cancelled" | "not_found" | "already_processing" | "already_completed";
}
```

### `drain(index?)`

Wait for queue(s) to empty.

```ts
// Wait for all instances to empty
yield* webhookQueue.drain();

// Wait for specific instance
yield* webhookQueue.drain(2);

// With timeout
yield* webhookQueue.drain().pipe(Effect.timeout("5 minutes"));
```

---

## Complete Examples

### Example 1: Webhook Delivery Queue

```ts
import { Queue } from "@durable-effect/primitives";
import { Effect, Schema } from "effect";

const WebhookEvent = Schema.Struct({
  webhookId: Schema.String,
  endpoint: Schema.String,
  payload: Schema.Unknown,
  customerId: Schema.String,
  receivedAt: Schema.Number,
});

type WebhookEvent = Schema.Schema.Type<typeof WebhookEvent>;

const webhookDelivery = Queue.make({
  eventSchema: WebhookEvent,

  concurrency: 10,

  retry: {
    maxAttempts: 5,
    delay: Backoff.exponential({ base: "1 second", max: "5 minutes" }),
    isRetryable: (error) => {
      // Don't retry 4xx errors
      if (error instanceof HttpError && error.status >= 400 && error.status < 500) {
        return false;
      }
      return true;
    },
  },

  execute: (ctx) =>
    Effect.gen(function* () {
      const event = yield* ctx.event;
      const attempt = ctx.attempt;

      console.log(
        `Processing webhook ${event.webhookId} (attempt ${attempt})`
      );

      // Deliver the webhook
      const response = yield* Effect.tryPromise(() =>
        fetch(event.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(event.payload),
        })
      );

      if (!response.ok) {
        yield* Effect.fail(new HttpError(response.status, await response.text()));
      }

      console.log(`Delivered webhook ${event.webhookId}`);
    }),

  onDeadLetter: (event, error, ctx) =>
    Effect.gen(function* () {
      // Store failed webhook for manual retry
      yield* storeFailedWebhook({
        webhookId: event.webhookId,
        customerId: event.customerId,
        error: String(error),
        attempts: ctx.attempts,
        enqueuedAt: ctx.enqueuedAt,
        failedAt: ctx.failedAt,
      });

      // Notify customer of delivery failure
      yield* notifyWebhookFailure(event.customerId, event.webhookId);
    }),
});
```

**Usage:**

```ts
export default {
  async fetch(request: Request, env: Env) {
    const client = PrimitivesClient.fromBinding(env.PRIMITIVES);
    const webhook = await request.json();

    // Enqueue with partition key to ensure ordering per customer
    const result = await Effect.runPromise(
      client.queue("webhookDelivery").enqueue({
        id: webhook.id,
        event: {
          webhookId: webhook.id,
          endpoint: webhook.endpoint,
          payload: webhook.payload,
          customerId: webhook.customerId,
          receivedAt: Date.now(),
        },
        partitionKey: webhook.customerId,  // Same customer = same instance = ordered
      })
    );

    return new Response(JSON.stringify({
      queued: true,
      position: result.position,
      instanceIndex: result.instanceIndex,
    }));
  },
};
```

### Example 2: Email Sending Queue

```ts
const EmailJob = Schema.Struct({
  emailId: Schema.String,
  to: Schema.String,
  subject: Schema.String,
  body: Schema.String,
  templateId: Schema.optional(Schema.String),
  scheduledFor: Schema.optional(Schema.Number),
});

const emailQueue = Queue.make({
  eventSchema: EmailJob,

  concurrency: 20,  // 20 concurrent email senders

  retry: {
    maxAttempts: 3,
    delay: "30 seconds",
  },

  execute: (ctx) =>
    Effect.gen(function* () {
      const email = yield* ctx.event;

      // Check if scheduled for future
      if (email.scheduledFor && email.scheduledFor > Date.now()) {
        // Re-enqueue with delay (or use a different pattern)
        yield* Effect.sleep(Duration.millis(email.scheduledFor - Date.now()));
      }

      // Send via email provider
      yield* sendEmail({
        to: email.to,
        subject: email.subject,
        body: email.body,
      });
    }),

  onDeadLetter: (email, error, ctx) =>
    Effect.gen(function* () {
      yield* recordEmailFailure(email.emailId, error);
    }),

  onEmpty: (ctx) =>
    Effect.gen(function* () {
      // Log when queue drains
      console.log(`Email queue instance ${ctx.instanceIndex} is empty`);
    }),
});
```

**Usage:**

```ts
// Send email immediately (round-robin distribution)
yield* client.queue("emailQueue").enqueue({
  id: `email-${userId}-${Date.now()}`,
  event: {
    emailId: generateId(),
    to: user.email,
    subject: "Welcome!",
    body: welcomeBody,
  },
});

// Send bulk emails
yield* client.queue("emailQueue").enqueueMany({
  events: users.map(user => ({
    id: `campaign-${campaignId}-${user.id}`,
    event: {
      emailId: `${campaignId}-${user.id}`,
      to: user.email,
      subject: campaignSubject,
      body: campaignBody,
    },
  })),
});
```

### Example 3: Order Processing Pipeline

```ts
const OrderJob = Schema.Struct({
  orderId: Schema.String,
  customerId: Schema.String,
  items: Schema.Array(Schema.Struct({
    productId: Schema.String,
    quantity: Schema.Number,
  })),
  status: Schema.Literal("pending", "processing", "shipped", "delivered"),
});

const orderProcessor = Queue.make({
  eventSchema: OrderJob,

  concurrency: 5,

  retry: {
    maxAttempts: 3,
    delay: Backoff.exponential({ base: "5 seconds" }),
  },

  execute: (ctx) =>
    Effect.gen(function* () {
      const order = yield* ctx.event;
      const pending = yield* ctx.pendingCount;

      console.log(
        `Processing order ${order.orderId} ` +
        `(${pending} orders waiting in this queue)`
      );

      // Reserve inventory
      yield* reserveInventory(order.items);

      // Process payment
      yield* processPayment(order.customerId, order.orderId);

      // Update order status
      yield* updateOrderStatus(order.orderId, "processing");

      // Trigger fulfillment (enqueue to another queue)
      yield* enqueueFulfillment(order);
    }),

  onDeadLetter: (order, error, ctx) =>
    Effect.gen(function* () {
      // Mark order as failed
      yield* updateOrderStatus(order.orderId, "failed");

      // Notify customer
      yield* sendOrderFailureNotification(order.customerId, order.orderId);

      // Alert ops team
      yield* alertOps(`Order ${order.orderId} failed after ${ctx.attempts} attempts`);
    }),
});
```

**Usage with partition key for customer ordering:**

```ts
// Ensure orders for same customer are processed in sequence
yield* client.queue("orderProcessor").enqueue({
  id: order.id,
  event: order,
  partitionKey: order.customerId,  // Customer's orders processed in order
  priority: order.isPriority ? 10 : 0,  // Priority orders first
});
```

---

## Routing Visualization

### Round Robin (Default)

```
Events:  E1  E2  E3  E4  E5  E6  E7  E8  E9  E10
         │   │   │   │   │   │   │   │   │   │
         ▼   ▼   ▼   ▼   ▼   ▼   ▼   ▼   ▼   ▼
         ┌───────────────────────────────────────┐
         │           Client Router                │
         │         (Round Robin)                  │
         └─────┬─────┬─────┬─────┬─────┬─────────┘
               │     │     │     │     │
         ┌─────┼─────┼─────┼─────┼─────┘
         ▼     ▼     ▼     ▼     ▼
       ┌───┐ ┌───┐ ┌───┐ ┌───┐ ┌───┐
       │ 0 │ │ 1 │ │ 2 │ │ 3 │ │ 4 │   Queue Instances
       └─┬─┘ └─┬─┘ └─┬─┘ └─┬─┘ └─┬─┘   (concurrency: 5)
         │     │     │     │     │
         ▼     ▼     ▼     ▼     ▼
       E1,E6 E2,E7 E3,E8 E4,E9 E5,E10  Events per instance
```

### With Partition Key

```
Events:  [A1] [B1] [A2] [C1] [B2] [A3] [C2] [B3]
          │    │    │    │    │    │    │    │
          ▼    ▼    ▼    ▼    ▼    ▼    ▼    ▼
         ┌────────────────────────────────────────┐
         │           Client Router                 │
         │     (Consistent Hash by partition)      │
         └────┬────────┬──────────┬───────────────┘
              │        │          │
         ┌────┘        │          └────┐
         ▼             ▼               ▼
       ┌───┐         ┌───┐           ┌───┐
       │ 0 │         │ 2 │           │ 4 │    Instances
       └─┬─┘         └─┬─┘           └─┬─┘    (only 3 used)
         │             │               │
         ▼             ▼               ▼
    A1→A2→A3       B1→B2→B3        C1→C2      Events (FIFO per partition)

    Partition A     Partition B    Partition C
    hash("A")=0     hash("B")=2    hash("C")=4
```

---

## Partition Key Considerations

### When to Use Partition Key

✅ **Good use cases:**
- Customer events that must be processed in order
- Per-entity state machines (order lifecycle, user onboarding)
- Preventing race conditions on same resource

❌ **Bad use cases:**
- Events that are independent (use round-robin for max throughput)
- Keys with very uneven distribution (creates hot spots)
- When ordering doesn't matter

### Hot Partition Warning

```ts
// BAD: One customer generates 90% of traffic
yield* queue.enqueue({
  id: eventId,
  event: data,
  partitionKey: "mega-corp",  // Creates bottleneck on one instance
});

// BETTER: Sub-partition or accept out-of-order
yield* queue.enqueue({
  id: eventId,
  event: data,
  partitionKey: `${customerId}:${userId}`,  // Spread within customer
});

// OR: No partition key, accept parallel processing
yield* queue.enqueue({
  id: eventId,
  event: data,
  // No partitionKey = round-robin = max throughput
});
```

---

## Type Inference Flow

```ts
// 1. Event schema defines event type
const MyEvent = Schema.Struct({
  id: Schema.String,
  data: Schema.Number,
});

// 2. Types flow through the API
const queue = Queue.make({
  eventSchema: MyEvent,
  concurrency: 5,

  execute: (ctx) =>
    Effect.gen(function* () {
      const event = yield* ctx.event;
      //    ^? { id: string; data: number }
    }),

  onDeadLetter: (event, error, ctx) => {
    //           ^? { id: string; data: number }
  },
});

// 3. Client enqueue() is typed by eventSchema
yield* client.queue("myQueue").enqueue({
  id: "123",
  event: { id: "e1", data: 42 },
  //      ^? Must match MyEvent
});
```

---

## Comparison: Queue vs Buffer vs Continuous

| Aspect | Queue | Buffer | Continuous |
|--------|-------|--------|------------|
| **Trigger** | Each event | Time/count threshold | Schedule |
| **Processing** | One at a time | All at once | Each execution |
| **Concurrency** | Multiple instances | Single instance | Single instance |
| **State after execute** | Next event | Purged | Persisted |
| **Ordering** | FIFO (per instance) | N/A | N/A |
| **Use case** | Job processing | Batching, debouncing | Polling, periodic |

---

## Summary

| Feature | API |
|---------|-----|
| Define queue | `Queue.make({ eventSchema, concurrency, execute })` |
| Concurrency | `concurrency: 5` (required) |
| Retry config | `retry: { maxAttempts: 3, delay: ... }` |
| Execute context - event | `yield* ctx.event` |
| Execute context - attempt | `ctx.attempt` |
| Execute context - pending | `yield* ctx.pendingCount` |
| Dead letter handler | `onDeadLetter: (event, error, ctx) => ...` |
| Client - enqueue | `yield* client.queue("name").enqueue({ id, event })` |
| Client - partition key | `enqueue({ ..., partitionKey: "customer-123" })` |
| Client - batch enqueue | `yield* client.queue("name").enqueueMany({ events })` |
| Client - status | `yield* client.queue("name").status()` |
| Client - pause/resume | `yield* client.queue("name").pause()` |
| Client - cancel | `yield* client.queue("name").cancel(eventId)` |
| Client - drain | `yield* client.queue("name").drain()` |

The API prioritizes:
- **Effect-native patterns** (generators, yieldable operations)
- **Type safety** (Schema-driven, full inference)
- **Explicit concurrency** (no hidden defaults)
- **Flexible routing** (round-robin default, partition key for ordering)
- **Resilience** (retry, dead letter handling)
