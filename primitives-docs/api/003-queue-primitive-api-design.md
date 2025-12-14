# WorkerPool Primitive API Design

## Design Philosophy

The WorkerPool primitive processes events sequentially with controlled concurrency. It follows the same Effect-first patterns as Continuous and Debounce:

1. **Effect-first** - All operations are Effects, yieldable in generators
2. **Schema-driven** - Events are defined via Effect Schema
3. **Idempotent by default** - Client operations use IDs to ensure exactly-once semantics
4. **Explicit concurrency** - User must define concurrency (no hidden defaults)
5. **Smart routing** - Client handles distribution across workerPool instances

---

## Core Concept

A WorkerPool:
1. Receives events via `client.workerPool("name").enworkerPool({ id, event })`
2. Client routes to one of N instances based on concurrency setting
3. Each instance processes events **one at a time** in FIFO order
4. After processing, moves to next event (or idles if empty)

**Key distinction from Debounce:**
- Debounce: Accumulates → Flush all at once → Purge
- WorkerPool: EnworkerPool → Process one → Repeat until empty

---

## Naming Decision

Considered names:
| Name | Pros | Cons |
|------|------|------|
| `WorkerPool` | Simple, universally understood | Generic |
| `WorkWorkerPool` | Explicit about purpose | Longer |
| `JobWorkerPool` | Common pattern | Implies batch jobs |
| `TaskWorkerPool` | Clear | Could conflict with Effect Task |
| `Processor` | Describes action | Doesn't imply queuing |
| `Channel` | Go/Clojure terminology | Less familiar |
| `Pipeline` | Implies chaining | Misleading |

**Decision: `WorkerPool`** - Simple, clear, and the most intuitive name for this pattern.

---

## API Overview

### Definition

```ts
import { WorkerPool } from "@durable-effect/jobs";
import { Schema } from "effect";

const webhookProcessor = WorkerPool.make({
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
import { createDurableJobs } from "@durable-effect/jobs";

const { Jobs, JobsClient } = createDurableJobs({
  webhookProcessor,
  // ... other jobs
});

// Export DO class for Cloudflare
export { Jobs };
```

### Client Usage

```ts
// In your worker/webhook handler
const client = JobsClient.fromBinding(env.PRIMITIVES);

// EnworkerPool event (client handles routing to 1 of 5 instances)
yield* client.workerPool("webhookProcessor").enworkerPool({
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

### `WorkerPool.make(config)`

Creates a WorkerPool definition.

```ts
interface WorkerPoolConfig<E extends Schema.Schema.AnyNoContext, Err, R> {
  /**
   * Effect Schema defining the event shape.
   * Events enworkerPoold via client.enworkerPool() must match this schema.
   */
  readonly eventSchema: E;

  /**
   * Number of concurrent workerPool instances.
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
    ctx: WorkerPoolExecuteContext<Schema.Schema.Type<E>>
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
    ctx: WorkerPoolDeadLetterContext
  ) => Effect.Effect<void, never, R>;

  /**
   * Optional handler called when workerPool becomes empty.
   * Useful for cleanup or notifications.
   */
  readonly onEmpty?: (
    ctx: WorkerPoolEmptyContext
  ) => Effect.Effect<void, never, R>;
}
```

### `WorkerPoolExecuteContext<E>`

The context provided to the `execute` function.

```ts
interface WorkerPoolExecuteContext<E> {
  /**
   * The event being processed.
   */
  readonly event: Effect.Effect<E, never, never>;

  /**
   * The unique ID of this event (provided at enworkerPool time).
   */
  readonly eventId: string;

  /**
   * The current retry attempt (1-indexed).
   * First attempt = 1, first retry = 2, etc.
   */
  readonly attempt: number;

  /**
   * Timestamp when this event was enworkerPoold.
   */
  readonly enworkerPooldAt: number;

  /**
   * Timestamp when processing started for this attempt.
   */
  readonly processingStartedAt: number;

  /**
   * The workerPool instance index (0 to concurrency-1).
   */
  readonly instanceIndex: number;

  /**
   * Total events processed by this instance (lifetime).
   */
  readonly processedCount: Effect.Effect<number, never, never>;

  /**
   * Number of events currently waiting in this instance's workerPool.
   */
  readonly pendingCount: Effect.Effect<number, never, never>;
}
```

### `WorkerPoolDeadLetterContext`

Context for dead letter handling.

```ts
interface WorkerPoolDeadLetterContext {
  /**
   * The event ID.
   */
  readonly eventId: string;

  /**
   * Number of attempts made.
   */
  readonly attempts: number;

  /**
   * Timestamp when first enworkerPoold.
   */
  readonly enworkerPooldAt: number;

  /**
   * Timestamp of final failure.
   */
  readonly failedAt: number;

  /**
   * The workerPool instance index.
   */
  readonly instanceIndex: number;
}
```

---

## Client Routing Logic

The client is responsible for distributing events across workerPool instances. This happens **in the client**, not the DO.

### Instance ID Resolution

```ts
// Internal client logic (conceptual)
function resolveInstanceId(
  workerPoolName: string,
  concurrency: number,
  eventId: string,
  partitionKey?: string
): string {
  // Determine which instance (0 to concurrency-1)
  const instanceIndex = partitionKey
    ? consistentHash(partitionKey, concurrency)
    : roundRobinIndex(workerPoolName, concurrency);

  // Instance ID format: {workerPoolName}:{instanceIndex}
  return `${workerPoolName}:${instanceIndex}`;
}
```

### Round Robin (Default)

When no partition key is provided, events are distributed round-robin:

```ts
// Simplified round-robin (actual implementation uses atomic counter)
let counter = 0;
function roundRobinIndex(workerPoolName: string, concurrency: number): number {
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

### Getting a WorkerPool Client

```ts
const client = JobsClient.fromBinding(env.PRIMITIVES);
const webhookWorkerPool = client.workerPool("webhookProcessor");
```

### `enworkerPool(options)`

Add an event to the workerPool. **Idempotent** - same `id` is deduplicated.

```ts
interface WorkerPoolEnworkerPoolOptions<E> {
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
const result = yield* webhookWorkerPool.enworkerPool({
  id: webhookId,
  event: {
    type: "order.shipped",
    webhookId: webhookId,
    payload: data,
    receivedAt: Date.now(),
  },
});

// Usage - with partition key (ordered per customer)
const result = yield* webhookWorkerPool.enworkerPool({
  id: webhookId,
  event: { ... },
  partitionKey: customerId,  // All events for this customer go to same instance
});

// Returns
interface WorkerPoolEnworkerPoolResult {
  readonly eventId: string;
  readonly instanceId: string;
  readonly instanceIndex: number;
  readonly position: number;      // Position in workerPool (0 = processing now)
  readonly created: boolean;      // false if duplicate
}
```

### `enworkerPoolMany(options)`

Batch enworkerPool multiple events.

```ts
interface WorkerPoolEnworkerPoolManyOptions<E> {
  /**
   * Events to enworkerPool.
   */
  readonly events: ReadonlyArray<{
    readonly id: string;
    readonly event: E;
    readonly partitionKey?: string;
    readonly priority?: number;
  }>;
}

// Usage
const results = yield* webhookWorkerPool.enworkerPoolMany({
  events: webhooks.map(w => ({
    id: w.id,
    event: w,
    partitionKey: w.customerId,
  })),
});

// Returns
interface WorkerPoolEnworkerPoolManyResult {
  readonly enworkerPoold: number;
  readonly duplicates: number;
  readonly results: ReadonlyArray<WorkerPoolEnworkerPoolResult>;
}
```

### `status()`

Get overall workerPool status across all instances.

```ts
const status = yield* webhookWorkerPool.status();

interface WorkerPoolStatus {
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
const status = yield* webhookWorkerPool.instanceStatus(0);

interface WorkerPoolInstanceStatus {
  readonly index: number;
  readonly instanceId: string;
  readonly status: "processing" | "idle" | "paused";
  readonly pendingCount: number;
  readonly processedCount: number;
  readonly currentEventId: string | null;
  readonly currentEventStartedAt: number | null;
  readonly workerPooldEvents: ReadonlyArray<{
    readonly eventId: string;
    readonly enworkerPooldAt: number;
    readonly priority: number;
  }>;
}
```

### `pause(index?)` / `resume(index?)`

Pause/resume processing.

```ts
// Pause all instances
yield* webhookWorkerPool.pause();

// Pause specific instance
yield* webhookWorkerPool.pause(2);

// Resume
yield* webhookWorkerPool.resume();
yield* webhookWorkerPool.resume(2);
```

### `cancel(eventId)`

Cancel a pending event (if not yet processing).

```ts
const result = yield* webhookWorkerPool.cancel(eventId);

interface WorkerPoolCancelResult {
  readonly cancelled: boolean;
  readonly reason: "cancelled" | "not_found" | "already_processing" | "already_completed";
}
```

### `drain(index?)`

Wait for workerPool(s) to empty.

```ts
// Wait for all instances to empty
yield* webhookWorkerPool.drain();

// Wait for specific instance
yield* webhookWorkerPool.drain(2);

// With timeout
yield* webhookWorkerPool.drain().pipe(Effect.timeout("5 minutes"));
```

---

## Complete Examples

### Example 1: Webhook Delivery WorkerPool

```ts
import { WorkerPool } from "@durable-effect/jobs";
import { Effect, Schema } from "effect";

const WebhookEvent = Schema.Struct({
  webhookId: Schema.String,
  endpoint: Schema.String,
  payload: Schema.Unknown,
  customerId: Schema.String,
  receivedAt: Schema.Number,
});

type WebhookEvent = Schema.Schema.Type<typeof WebhookEvent>;

const webhookDelivery = WorkerPool.make({
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
        enworkerPooldAt: ctx.enworkerPooldAt,
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
    const client = JobsClient.fromBinding(env.PRIMITIVES);
    const webhook = await request.json();

    // EnworkerPool with partition key to ensure ordering per customer
    const result = await Effect.runPromise(
      client.workerPool("webhookDelivery").enworkerPool({
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
      workerPoold: true,
      position: result.position,
      instanceIndex: result.instanceIndex,
    }));
  },
};
```

### Example 2: Email Sending WorkerPool

```ts
const EmailJob = Schema.Struct({
  emailId: Schema.String,
  to: Schema.String,
  subject: Schema.String,
  body: Schema.String,
  templateId: Schema.optional(Schema.String),
  scheduledFor: Schema.optional(Schema.Number),
});

const emailWorkerPool = WorkerPool.make({
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
        // Re-enworkerPool with delay (or use a different pattern)
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
      // Log when workerPool drains
      console.log(`Email workerPool instance ${ctx.instanceIndex} is empty`);
    }),
});
```

**Usage:**

```ts
// Send email immediately (round-robin distribution)
yield* client.workerPool("emailWorkerPool").enworkerPool({
  id: `email-${userId}-${Date.now()}`,
  event: {
    emailId: generateId(),
    to: user.email,
    subject: "Welcome!",
    body: welcomeBody,
  },
});

// Send bulk emails
yield* client.workerPool("emailWorkerPool").enworkerPoolMany({
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

const orderProcessor = WorkerPool.make({
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
        `(${pending} orders waiting in this workerPool)`
      );

      // Reserve inventory
      yield* reserveInventory(order.items);

      // Process payment
      yield* processPayment(order.customerId, order.orderId);

      // Update order status
      yield* updateOrderStatus(order.orderId, "processing");

      // Trigger fulfillment (enworkerPool to another workerPool)
      yield* enworkerPoolFulfillment(order);
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
yield* client.workerPool("orderProcessor").enworkerPool({
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
       │ 0 │ │ 1 │ │ 2 │ │ 3 │ │ 4 │   WorkerPool Instances
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
yield* workerPool.enworkerPool({
  id: eventId,
  event: data,
  partitionKey: "mega-corp",  // Creates bottleneck on one instance
});

// BETTER: Sub-partition or accept out-of-order
yield* workerPool.enworkerPool({
  id: eventId,
  event: data,
  partitionKey: `${customerId}:${userId}`,  // Spread within customer
});

// OR: No partition key, accept parallel processing
yield* workerPool.enworkerPool({
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
const workerPool = WorkerPool.make({
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

// 3. Client enworkerPool() is typed by eventSchema
yield* client.workerPool("myWorkerPool").enworkerPool({
  id: "123",
  event: { id: "e1", data: 42 },
  //      ^? Must match MyEvent
});
```

---

## Comparison: WorkerPool vs Debounce vs Continuous

| Aspect | WorkerPool | Debounce | Continuous |
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
| Define workerPool | `WorkerPool.make({ eventSchema, concurrency, execute })` |
| Concurrency | `concurrency: 5` (required) |
| Retry config | `retry: { maxAttempts: 3, delay: ... }` |
| Execute context - event | `yield* ctx.event` |
| Execute context - attempt | `ctx.attempt` |
| Execute context - pending | `yield* ctx.pendingCount` |
| Dead letter handler | `onDeadLetter: (event, error, ctx) => ...` |
| Client - enworkerPool | `yield* client.workerPool("name").enworkerPool({ id, event })` |
| Client - partition key | `enworkerPool({ ..., partitionKey: "customer-123" })` |
| Client - batch enworkerPool | `yield* client.workerPool("name").enworkerPoolMany({ events })` |
| Client - status | `yield* client.workerPool("name").status()` |
| Client - pause/resume | `yield* client.workerPool("name").pause()` |
| Client - cancel | `yield* client.workerPool("name").cancel(eventId)` |
| Client - drain | `yield* client.workerPool("name").drain()` |

The API prioritizes:
- **Effect-native patterns** (generators, yieldable operations)
- **Type safety** (Schema-driven, full inference)
- **Explicit concurrency** (no hidden defaults)
- **Flexible routing** (round-robin default, partition key for ordering)
- **Resilience** (retry, dead letter handling)
