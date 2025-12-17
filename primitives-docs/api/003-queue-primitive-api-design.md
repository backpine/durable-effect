# WorkerPool Primitive API Design

## Design Philosophy

The WorkerPool primitive processes events sequentially with controlled concurrency. It follows the same Effect-first patterns as Continuous and Debounce:

1. **Effect-first** - All operations are Effects, yieldable in generators
2. **Schema-driven** - Events are defined via Effect Schema
3. **Explicit concurrency** - User must define concurrency (no hidden defaults)
4. **Smart routing** - Client handles distribution across workerPool instances
5. **Sequence-based ordering** - Events identified by arrival sequence, not user-provided IDs

---

## Core Concept

A WorkerPool:
1. Receives events via `client.workerPool("name").enqueue({ event })`
2. Client routes to one of N instances based on concurrency setting (round-robin or partition key)
3. Each instance processes events **one at a time** in FIFO order
4. After processing, moves to next event (or idles if empty)

**Key distinction from Debounce:**
- Debounce: Accumulates → Flush all at once → Purge
- WorkerPool: Enqueue → Process one → Repeat until empty

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
      const event = ctx.event;

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

// Enqueue event (client handles routing to 1 of 5 instances)
yield* client.workerPool("webhookProcessor").enqueue({
  event: {
    type: "order.shipped",
    webhookId: webhookId,
    payload: webhookPayload,
    receivedAt: Date.now(),
  },
});

// With partition key for ordered processing per customer
yield* client.workerPool("webhookProcessor").enqueue({
  event: { ... },
  partitionKey: customerId,  // All events for this customer go to same instance
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
   * Events enqueued via client.enqueue() must match this schema.
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
   * @default { maxAttempts: 3, initialDelay: "1 second" }
   */
  readonly retry?: {
    readonly maxAttempts: number;
    readonly initialDelay: Duration.DurationInput;
    readonly maxDelay?: Duration.DurationInput;
    readonly backoffMultiplier?: number;
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
   * The event being processed (synchronous access).
   */
  readonly event: E;

  /**
   * The sequence number of this event within the queue.
   * Unique within this instance, monotonically increasing.
   */
  readonly sequence: number;

  /**
   * The current retry attempt (1-indexed).
   * First attempt = 1, first retry = 2, etc.
   */
  readonly attempt: number;

  /**
   * Whether this is a retry of a previously failed attempt.
   */
  readonly isRetry: boolean;

  /**
   * Timestamp when this event was enqueued.
   */
  readonly enqueuedAt: number;

  /**
   * Timestamp when processing started for this attempt.
   */
  readonly processingStartedAt: number;

  /**
   * The workerPool instance index (0 to concurrency-1).
   */
  readonly instanceIndex: number;

  /**
   * The unique instance ID for this DO instance.
   */
  readonly instanceId: string;

  /**
   * The job name (as registered).
   */
  readonly jobName: string;
}
```

### `WorkerPoolDeadLetterContext`

Context for dead letter handling.

```ts
interface WorkerPoolDeadLetterContext {
  /**
   * The sequence number of the failed event.
   */
  readonly sequence: number;

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
   * The workerPool instance index.
   */
  readonly instanceIndex: number;

  /**
   * The unique instance ID.
   */
  readonly instanceId: string;

  /**
   * The job name.
   */
  readonly jobName: string;
}
```

### `WorkerPoolEmptyContext`

Context for empty queue handler.

```ts
interface WorkerPoolEmptyContext {
  /**
   * The unique instance ID.
   */
  readonly instanceId: string;

  /**
   * The workerPool instance index.
   */
  readonly instanceIndex: number;

  /**
   * The job name.
   */
  readonly jobName: string;

  /**
   * Total events processed by this instance (lifetime).
   */
  readonly processedCount: number;
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
  partitionKey?: string
): { instanceId: string; instanceIndex: number } {
  // Determine which instance (0 to concurrency-1)
  const instanceIndex = partitionKey
    ? consistentHash(partitionKey, concurrency)
    : roundRobinIndex(workerPoolName, concurrency);

  // Instance ID format: workerPool:{workerPoolName}:{instanceIndex}
  return {
    instanceId: `workerPool:${workerPoolName}:${instanceIndex}`,
    instanceIndex,
  };
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
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    const char = key.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash) % concurrency;
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

### `enqueue(options)`

Add an event to the workerPool.

```ts
interface WorkerPoolEnqueueOptions<E> {
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
const result = yield* webhookWorkerPool.enqueue({
  event: {
    type: "order.shipped",
    webhookId: webhookId,
    payload: data,
    receivedAt: Date.now(),
  },
});

// Usage - with partition key (ordered per customer)
const result = yield* webhookWorkerPool.enqueue({
  event: { ... },
  partitionKey: customerId,  // All events for this customer go to same instance
});

// Returns
interface WorkerPoolEnqueueResponse {
  readonly _type: "workerPool.enqueue";
  readonly sequence: number;        // Event sequence number in this instance
  readonly instanceId: string;
  readonly instanceIndex: number;
  readonly position: number;        // Position in queue (0 = processing now)
}
```

### `enqueueMany(options)`

Batch enqueue multiple events.

```ts
interface WorkerPoolEnqueueManyOptions<E> {
  /**
   * Events to enqueue.
   */
  readonly events: ReadonlyArray<{
    readonly event: E;
    readonly partitionKey?: string;
    readonly priority?: number;
  }>;
}

// Usage
const results = yield* webhookWorkerPool.enqueueMany({
  events: webhooks.map(w => ({
    event: w,
    partitionKey: w.customerId,
  })),
});

// Returns
interface WorkerPoolEnqueueManyResponse {
  readonly _type: "workerPool.enqueueMany";
  readonly enqueued: number;
  readonly results: ReadonlyArray<WorkerPoolEnqueueResponse>;
}
```

### `status()`

Get overall workerPool status across all instances.

```ts
const status = yield* webhookWorkerPool.status();

interface WorkerPoolAggregatedStatus {
  readonly instances: ReadonlyArray<WorkerPoolStatusResponse>;
  readonly totalPending: number;
  readonly totalProcessed: number;
  readonly activeInstances: number;
  readonly pausedInstances: number;
}
```

### `instanceStatus(index)`

Get status of a specific instance.

```ts
const status = yield* webhookWorkerPool.instanceStatus(0);

interface WorkerPoolStatusResponse {
  readonly _type: "workerPool.status";
  readonly status: "processing" | "idle" | "paused" | "not_found";
  readonly pendingCount?: number;
  readonly processedCount?: number;
  readonly currentSequence?: number | null;
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

### `drain(index?)`

Stop processing and clear all pending events.

```ts
// Drain all instances
yield* webhookWorkerPool.drain();

// Drain specific instance
yield* webhookWorkerPool.drain(2);

interface WorkerPoolDrainResponse {
  readonly _type: "workerPool.drain";
  readonly drained: boolean;
  readonly eventsCleared: number;
}
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
    initialDelay: "1 second",
    maxDelay: "5 minutes",
    backoffMultiplier: 2,
  },

  execute: (ctx) =>
    Effect.gen(function* () {
      console.log(
        `Processing webhook seq=${ctx.sequence} (attempt ${ctx.attempt})`
      );

      // Deliver the webhook
      const response = yield* Effect.tryPromise(() =>
        fetch(ctx.event.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(ctx.event.payload),
        })
      );

      if (!response.ok) {
        yield* Effect.fail(new HttpError(response.status, await response.text()));
      }

      console.log(`Delivered webhook ${ctx.event.webhookId}`);
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
    const client = JobsClient.fromBinding(env.PRIMITIVES);
    const webhook = await request.json();

    // Enqueue with partition key to ensure ordering per customer
    const result = await Effect.runPromise(
      client.workerPool("webhookDelivery").enqueue({
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
      sequence: result.sequence,
      position: result.position,
      instanceIndex: result.instanceIndex,
    }));
  },
};
```

### Example 2: Email Sending WorkerPool

```ts
const EmailJob = Schema.Struct({
  to: Schema.String,
  subject: Schema.String,
  body: Schema.String,
  templateId: Schema.optional(Schema.String),
});

const emailWorkerPool = WorkerPool.make({
  eventSchema: EmailJob,

  concurrency: 20,  // 20 concurrent email senders

  retry: {
    maxAttempts: 3,
    initialDelay: "30 seconds",
  },

  execute: (ctx) =>
    Effect.gen(function* () {
      // Send via email provider
      yield* sendEmail({
        to: ctx.event.to,
        subject: ctx.event.subject,
        body: ctx.event.body,
      });
    }),

  onDeadLetter: (email, error, ctx) =>
    Effect.gen(function* () {
      yield* recordEmailFailure(email.to, error);
    }),

  onEmpty: (ctx) =>
    Effect.gen(function* () {
      console.log(`Email queue instance ${ctx.instanceIndex} is empty`);
    }),
});
```

**Usage:**

```ts
// Send email immediately (round-robin distribution)
yield* client.workerPool("emailWorkerPool").enqueue({
  event: {
    to: user.email,
    subject: "Welcome!",
    body: welcomeBody,
  },
});

// Send bulk emails
yield* client.workerPool("emailWorkerPool").enqueueMany({
  events: users.map(user => ({
    event: {
      to: user.email,
      subject: campaignSubject,
      body: campaignBody,
    },
  })),
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
yield* workerPool.enqueue({
  event: data,
  partitionKey: "mega-corp",  // Creates bottleneck on one instance
});

// BETTER: Sub-partition or accept out-of-order
yield* workerPool.enqueue({
  event: data,
  partitionKey: `${customerId}:${userId}`,  // Spread within customer
});

// OR: No partition key, accept parallel processing
yield* workerPool.enqueue({
  event: data,
  // No partitionKey = round-robin = max throughput
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
| Retry config | `retry: { maxAttempts: 3, initialDelay: "1s" }` |
| Execute context - event | `ctx.event` |
| Execute context - attempt | `ctx.attempt` |
| Execute context - sequence | `ctx.sequence` |
| Dead letter handler | `onDeadLetter: (event, error, ctx) => ...` |
| Empty queue handler | `onEmpty: (ctx) => ...` |
| Client - enqueue | `yield* client.workerPool("name").enqueue({ event })` |
| Client - partition key | `enqueue({ event, partitionKey: "customer-123" })` |
| Client - batch enqueue | `yield* client.workerPool("name").enqueueMany({ events })` |
| Client - status | `yield* client.workerPool("name").status()` |
| Client - pause/resume | `yield* client.workerPool("name").pause()` |
| Client - drain | `yield* client.workerPool("name").drain()` |

The API prioritizes:
- **Effect-native patterns** (generators, yieldable operations)
- **Type safety** (Schema-driven, full inference)
- **Explicit concurrency** (no hidden defaults)
- **Flexible routing** (round-robin default, partition key for ordering)
- **Resilience** (retry, dead letter handling)
- **Simplicity** (no required event IDs, sequence-based identification)
