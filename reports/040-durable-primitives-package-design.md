# Report 040: Durable Jobs Package Design

## Overview

Design proposal for a new package that consolidates common durable compute patterns beyond workflows. These patterns are frequently implemented on Durable Objects but lack a unified, well-designed abstraction.

## Target Use Cases

| Pattern | Description | Example |
|---------|-------------|---------|
| **Buffering** | Collect items over time, flush on timer/count | Event batching, log aggregation |
| **Concurrency** | Rate limiting, semaphores, distributed locks | API rate limits, resource pools |
| **Queueing** | Durable queues with processing guarantees | Email sending, webhook delivery |
| **Continuous** | Long-running loops with self-managed schedules | Token refresh, polling, heartbeats |

## Package Naming (Ranked)

### Tier 1: Recommended

| Rank | Name | Rationale |
|------|------|-----------|
| **1** | `@durable-effect/jobs` | Clear parallel to "workflow", indicates building blocks, implies composability |
| **2** | `@durable-effect/actors` | Aligns with actor model (stateful entities processing messages), widely understood pattern |
| **3** | `@durable-effect/services` | Implies long-running, stateful services - matches the continuous/queue use cases well |

### Tier 2: Acceptable

| Rank | Name | Rationale |
|------|------|-----------|
| 4 | `@durable-effect/patterns` | Design patterns focus, but less specific |
| 5 | `@durable-effect/compute` | Broad but captures durable compute nature |
| 6 | `@durable-effect/entities` | Domain-driven feel, but less intuitive |

### Tier 3: Not Recommended

| Name | Why Not |
|------|---------|
| `@durable-effect/tasks` | Overlaps with workflow concept |
| `@durable-effect/runtime` | Too generic, conflicts with Effect Runtime |
| `@durable-effect/engine` | Conflicts with workflow engine |
| `@durable-effect/objects` | Too Cloudflare-specific |
| `@durable-effect/durable` | Redundant with package scope |

### Recommendation: `@durable-effect/jobs`

**Why:**
- Clear relationship to `@durable-effect/workflow` (workflows use jobs)
- "Jobs" suggests composable building blocks
- Doesn't conflict with existing terminology
- Works well in imports: `import { Buffer, Queue } from "@durable-effect/jobs"`

---

## Unified Engine Design

The key design goal is a **single Durable Object** that hosts multiple primitive types, avoiding the need for users to define many DO classes.

### Factory Pattern (Matching Workflow)

```typescript
import { createDurableJobs, Buffer, Queue, Semaphore, Continuous } from "@durable-effect/jobs";

// Define all jobs in one registry
const { Jobs, PrimitiveClient } = createDurableJobs({
  // Continuous processes
  tokenRefresher: Continuous.make({
    interval: "30 minutes",
    execute: () => refreshAccessToken(),
    shouldStop: (state) => state.revoked,
  }),
  // Buffers
  eventBuffer: Buffer.make({
    maxItems: 100,
    maxWait: "5 minutes",
    flush: (items) => sendToAnalytics(items),
  }),
  // Queues
   webhookQueue: Queue.make({
    process: (webhook) => deliverWebhook(webhook),
    concurrency: 10,
    retry: { maxAttempts: 5, delay: Backoff.exponential({ base: "1 second" }) },
  }),
  // Semaphores / Rate Limiters
  apiRateLimiter: Semaphore.make({
    permits: 100,
    window: "1 minute",
  })
}, {
  tracker: { endpoint: "https://events.example.com/ingest" },
});

// Export single DO class
export { Jobs };
```

### Wrangler Config

```toml
[[durable_objects.bindings]]
name = "PRIMITIVES"
class_name = "Jobs"
```

### Client Usage

```typescript
// In worker
export default {
  async fetch(request: Request, env: Env) {
    const client = PrimitiveClient.fromBinding(env.PRIMITIVES);

    // Add to buffer (keyed by bufferName:instanceId)
    await Effect.runPromise(
      client.buffer("eventBuffer").add({ type: "pageview", url: "/home" })
    );

    // Enqueue item
    await Effect.runPromise(
      client.queue("emailQueue").enqueue({
        to: "user@example.com",
        subject: "Welcome!",
      })
    );

    // Acquire semaphore permit
    const result = await Effect.runPromise(
      client.semaphore("apiRateLimiter").tryAcquire({
        key: request.headers.get("x-user-id"),
      })
    );

    if (!result.acquired) {
      return new Response("Rate limited", { status: 429 });
    }

    // Start/check continuous process
    await Effect.runPromise(
      client.continuous("tokenRefresher").start({ userId: "123" })
    );
  }
};
```

---

## Primitive API Design

### 1. Buffer

Collects items and flushes based on count or time.

```typescript
// Definition
Buffer.make<T>({
  // Flush triggers (at least one required)
  maxItems?: number;           // Flush when buffer reaches N items
  maxWait?: Duration;          // Flush after duration since first item

  // Flush handler
  flush: (items: T[]) => Effect.Effect<void, E, R>;

  // Optional
  onFlushError?: (error: E, items: T[]) => Effect.Effect<void>;
  deduplication?: {
    key: (item: T) => string;
    strategy: "first" | "last" | "merge";
  };
})

// Client API
interface BufferClient<T> {
  add(item: T): Effect.Effect<{ buffered: number }, BufferError>;
  addMany(items: T[]): Effect.Effect<{ buffered: number }, BufferError>;
  flush(): Effect.Effect<{ flushed: number }, BufferError>;
  count(): Effect.Effect<number, BufferError>;
  clear(): Effect.Effect<void, BufferError>;
}
```

### 2. Queue

Durable queue with processing guarantees.

```typescript
// Definition
Queue.make<T>({
  // Processing
  process: (item: T) => Effect.Effect<void, E, R>;
  concurrency?: number;        // Max concurrent processors (default: 1)

  // Retry
  retry?: {
    maxAttempts: number;
    delay: Duration | BackoffStrategy;
    isRetryable?: (error: E) => boolean;
  };

  // Optional
  deadLetter?: (item: T, error: E) => Effect.Effect<void>;
  priority?: (item: T) => number;  // Higher = processed first
  deduplication?: {
    key: (item: T) => string;
    window: Duration;
  };
})

// Client API
interface QueueClient<T> {
  enqueue(item: T): Effect.Effect<{ position: number }, QueueError>;
  enqueueBatch(items: T[]): Effect.Effect<{ count: number }, QueueError>;
  size(): Effect.Effect<number, QueueError>;
  pause(): Effect.Effect<void, QueueError>;
  resume(): Effect.Effect<void, QueueError>;
  clear(): Effect.Effect<{ cleared: number }, QueueError>;
  stats(): Effect.Effect<QueueStats, QueueError>;
}

interface QueueStats {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  deadLettered: number;
}
```

### 3. Semaphore / Rate Limiter

Manages concurrency and rate limiting.

```typescript
// Definition
Semaphore.make({
  permits: number;             // Max concurrent permits
  window?: Duration;           // Sliding window (for rate limiting)

  // Optional
  queueing?: {
    enabled: boolean;
    maxWait: Duration;
    maxQueueSize: number;
  };
})

// Client API (keyed by caller)
interface SemaphoreClient {
  tryAcquire(opts: {
    key: string;               // e.g., userId, apiKey
    permits?: number;          // default: 1
  }): Effect.Effect<{ acquired: boolean; waitMs?: number }, SemaphoreError>;

  acquire(opts: {
    key: string;
    permits?: number;
    timeout?: Duration;
  }): Effect.Effect<{ acquired: true }, SemaphoreError | TimeoutError>;

  release(opts: {
    key: string;
    permits?: number;
  }): Effect.Effect<void, SemaphoreError>;

  stats(key: string): Effect.Effect<{
    available: number;
    used: number;
    queued: number;
  }, SemaphoreError>;
}
```

### 4. Continuous

Long-running processes with self-managed schedules.

```typescript
// Definition
Continuous.make<State>({
  // Execution
  interval: Duration;
  execute: (state: State) => Effect.Effect<State, E, R>;

  // Lifecycle
  initialState: State | ((input: I) => State);
  shouldStop?: (state: State) => boolean;
  maxIterations?: number;
  maxDuration?: Duration;

  // Error handling
  onError?: (error: E, state: State) => Effect.Effect<
    | { action: "continue"; state: State }
    | { action: "stop"; reason: string }
    | { action: "retry"; delay: Duration }
  >;
})

// Client API
interface ContinuousClient<I, State> {
  start(input: I): Effect.Effect<{ started: boolean }, ContinuousError>;
  stop(reason?: string): Effect.Effect<{ stopped: boolean }, ContinuousError>;
  getState(): Effect.Effect<State | undefined, ContinuousError>;
  isRunning(): Effect.Effect<boolean, ContinuousError>;
  stats(): Effect.Effect<{
    iterations: number;
    lastRun: Date;
    nextRun: Date;
    errors: number;
  }, ContinuousError>;
}
```

---

## Internal Architecture

### Unified DO Structure

```
┌─────────────────────────────────────────────────────────────┐
│                    DurablePrimitiveEngine                   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │   Buffer     │  │    Queue     │  │  Semaphore   │      │
│  │   Manager    │  │   Manager    │  │   Manager    │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│                                                             │
│  ┌──────────────┐  ┌──────────────────────────────────┐    │
│  │ Continuous   │  │         Shared Services          │    │
│  │   Manager    │  │  - Storage Adapter               │    │
│  └──────────────┘  │  - Scheduler Adapter             │    │
│                    │  - Event Tracker                 │    │
│                    └──────────────────────────────────┘    │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                    Alarm Dispatcher                         │
│  - Routes alarms to appropriate manager based on stored    │
│    metadata about pending timers                           │
└─────────────────────────────────────────────────────────────┘
```

### Storage Key Namespacing

```
primitive:buffer:{name}:items          -> T[]
primitive:buffer:{name}:firstAddedAt   -> number
primitive:queue:{name}:pending         -> QueueItem[]
primitive:queue:{name}:processing      -> QueueItem[]
primitive:queue:{name}:stats           -> QueueStats
primitive:semaphore:{name}:permits:{key} -> { count, expiresAt }[]
primitive:continuous:{name}:state      -> State
primitive:continuous:{name}:meta       -> { iterations, lastRun, ... }
primitive:alarm:next                   -> { type, name, data, at }
```

### Alarm Multiplexing

Since DOs have a single alarm, we need to multiplex:

```typescript
interface PendingAlarm {
  type: "buffer_flush" | "queue_process" | "semaphore_expire" | "continuous_tick";
  name: string;
  scheduledAt: number;
  data?: unknown;
}

// Store multiple pending alarms, set DO alarm to earliest
async alarm() {
  const pending = await this.storage.get<PendingAlarm[]>("primitive:alarms");
  const now = Date.now();

  // Process all alarms that are due
  const due = pending.filter(a => a.scheduledAt <= now);
  const remaining = pending.filter(a => a.scheduledAt > now);

  for (const alarm of due) {
    await this.dispatchAlarm(alarm);
  }

  // Reschedule next alarm
  if (remaining.length > 0) {
    const next = Math.min(...remaining.map(a => a.scheduledAt));
    await this.storage.setAlarm(next);
    await this.storage.put("primitive:alarms", remaining);
  }
}
```

---

## Instance Keying Strategy

Different jobs need different keying strategies:

| Primitive | Key Strategy | Example |
|-----------|--------------|---------|
| Buffer | Per-buffer-name | `eventBuffer` → single instance |
| Queue | Per-queue-name | `emailQueue` → single instance |
| Semaphore | Per-semaphore-name | `apiRateLimiter` → single instance |
| Continuous | Per-name + input | `tokenRefresher:user123` → per-user instance |

### Client ID Generation

```typescript
// Buffer/Queue/Semaphore: use primitive name as DO ID
const bufferId = env.PRIMITIVES.idFromName(`buffer:${bufferName}`);

// Continuous: combine name + instance key
const continuousId = env.PRIMITIVES.idFromName(`continuous:${name}:${instanceKey}`);
```

---

## Comparison with Workflow Package

| Aspect | @durable-effect/workflow | @durable-effect/jobs |
|--------|-------------------------|---------------------------|
| Purpose | Step-by-step processes | Stateful behaviors |
| Execution | Run-to-completion with pauses | Continuous/reactive |
| State | Workflow progress + step results | Primitive-specific state |
| Triggering | Explicit start | Events/timers/external calls |
| Composition | Steps within workflows | Jobs are independent |
| Recovery | Resume from last step | Primitive-specific recovery |

---

## Next Steps

1. **Validate naming**: Confirm `@durable-effect/jobs` or choose alternative
2. **Prioritize jobs**: Start with Buffer + Queue (most common), add Semaphore + Continuous later
3. **Prototype Buffer**: Simplest primitive, validates the engine architecture
4. **Define event schema**: Standardize events across all primitive types
5. **Design testing utilities**: In-memory implementations for each primitive type
