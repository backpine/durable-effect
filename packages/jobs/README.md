# @durable-effect/jobs

Durable job abstractions for Cloudflare Workers built on [Effect](https://effect.website/). Write business logic as Effect programs while the framework handles durability, retries, and scheduling.

## Overview

This package provides three job types for different patterns:

| Job Type | Purpose | Use Cases |
|----------|---------|-----------|
| **Continuous** | Recurring work on a schedule | Token refresh, health checks, daily reports |
| **Debounce** | Batch rapid events before processing | Webhook coalescing, update batching |
| **Task** | Event-driven state machines | Order workflows, multi-step processes |

Each job instance runs in its own Durable Object, providing:
- Persistent state that survives restarts
- Durable alarms for scheduling
- Automatic retry with configurable backoff
- Type-safe client with full inference

## Quick Start

```typescript
import { Effect, Schema } from "effect";
import { createDurableJobs, Continuous } from "@durable-effect/jobs";

// 1. Define a job
const tokenRefresher = Continuous.make({
  stateSchema: Schema.Struct({
    accessToken: Schema.String,
    refreshToken: Schema.String,
    expiresAt: Schema.Number,
  }),
  schedule: Continuous.every("30 minutes"),
  execute: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.state;
      const newToken = yield* refreshAccessToken(state.refreshToken);
      yield* ctx.setState({ ...state, accessToken: newToken, expiresAt: Date.now() + 1800000 });
    }),
});

// 2. Create engine and client
const { Jobs, JobsClient } = createDurableJobs({ tokenRefresher });

// 3. Export the Durable Object class
export { Jobs };

// 4. Use the client in your worker
export default {
  async fetch(request: Request, env: Env) {
    const client = JobsClient.fromBinding(env.JOBS);

    await Effect.runPromise(
      client.continuous("tokenRefresher").start({
        id: "user-123",
        input: { accessToken: "", refreshToken: "rt_abc", expiresAt: 0 },
      })
    );

    return new Response("OK");
  },
};
```

Configure your `wrangler.jsonc`:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "my-worker",
  "main": "src/worker.ts",
  "compatibility_date": "2024-11-27",
  "compatibility_flags": ["nodejs_compat"],

  "durable_objects": {
    "bindings": [
      {
        "name": "JOBS",
        "class_name": "Jobs"
      }
    ]
  },

  "migrations": [
    {
      "tag": "v1",
      "new_classes": ["Jobs"]
    }
  ]
}
```

---

## Defining Jobs

### Continuous Jobs

Execute on a fixed schedule. Best for recurring background work.

```typescript
import { Continuous } from "@durable-effect/jobs";
import { Backoff } from "@durable-effect/core";

const healthChecker = Continuous.make({
  stateSchema: Schema.Struct({
    lastCheckAt: Schema.Number,
    consecutiveFailures: Schema.Number,
  }),

  // Schedule options
  schedule: Continuous.every("5 minutes"),  // or Continuous.cron("0 */5 * * *")

  // Execute immediately on start (default: true)
  startImmediately: true,

  // Optional retry configuration
  retry: {
    maxAttempts: 3,
    delay: Backoff.exponential({ base: "1 second", max: "30 seconds" }),
  },

  execute: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.state;

      // ctx provides rich metadata
      console.log(`Run #${ctx.runCount}, attempt ${ctx.attempt}`);

      const healthy = yield* checkHealth();
      if (!healthy && state.consecutiveFailures > 10) {
        // Terminate removes all state and cancels the schedule
        return yield* ctx.terminate({ reason: "Too many failures" });
      }

      yield* ctx.updateState((s) => ({
        lastCheckAt: Date.now(),
        consecutiveFailures: healthy ? 0 : s.consecutiveFailures + 1,
      }));
    }),
});
```

**Context properties:**

| Property | Type | Description |
|----------|------|-------------|
| `state` | `Effect<S>` | Current state (yields the value) |
| `setState(s)` | `Effect<void>` | Replace entire state |
| `updateState(fn)` | `Effect<void>` | Transform state |
| `terminate(opts?)` | `Effect<never>` | Stop job and purge state |
| `instanceId` | `string` | Unique DO instance ID |
| `jobName` | `string` | Registered job name |
| `runCount` | `number` | Execution count (1-indexed) |
| `attempt` | `number` | Current retry attempt (1 = first try) |
| `isRetry` | `boolean` | Whether this is a retry |

---

### Debounce Jobs

Collect events and process them in batches. Flushes after a delay or when max events reached.

```typescript
import { Debounce } from "@durable-effect/jobs";

const webhookBatcher = Debounce.make({
  // Schema for incoming events
  eventSchema: Schema.Struct({
    type: Schema.String,
    contactId: Schema.String,
    data: Schema.Unknown,
  }),

  // Optional: separate state schema (defaults to eventSchema)
  stateSchema: Schema.Struct({
    events: Schema.Array(Schema.Unknown),
    count: Schema.Number,
  }),

  // Flush timing
  flushAfter: "5 seconds",
  maxEvents: 100,  // Optional: flush early if reached

  // Optional: custom event reducer (default: keep latest event)
  onEvent: (ctx) =>
    Effect.succeed({
      events: [...ctx.state.events, ctx.event],
      count: ctx.state.count + 1,
    }),

  // Process the batch
  execute: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.state;
      const count = yield* ctx.eventCount;

      console.log(`Flushing ${count} events, reason: ${ctx.flushReason}`);
      yield* sendWebhookBatch(state.events);
    }),
});
```

**Execute context:**

| Property | Type | Description |
|----------|------|-------------|
| `state` | `Effect<S>` | Accumulated state |
| `eventCount` | `Effect<number>` | Total events received |
| `flushReason` | `string` | `"maxEvents"` \| `"flushAfter"` \| `"manual"` |
| `debounceStartedAt` | `Effect<number>` | When first event arrived |
| `attempt` | `number` | Retry attempt |
| `isRetry` | `boolean` | Whether this is a retry |

**Event context (onEvent):**

| Property | Type | Description |
|----------|------|-------------|
| `event` | `I` | The incoming event |
| `state` | `S` | Current accumulated state |
| `eventCount` | `number` | Events so far |
| `instanceId` | `string` | DO instance ID |

---

### Task Jobs

User-controlled state machines. You decide when to schedule execution via events.

```typescript
import { Task } from "@durable-effect/jobs";
import { Duration } from "effect";

const orderProcessor = Task.make({
  stateSchema: Schema.Struct({
    orderId: Schema.String,
    status: Schema.Literal("pending", "processing", "shipped", "delivered"),
    attempts: Schema.Number,
  }),

  eventSchema: Schema.Union(
    Schema.Struct({ _tag: Schema.Literal("OrderPlaced"), orderId: Schema.String }),
    Schema.Struct({ _tag: Schema.Literal("PaymentReceived") }),
    Schema.Struct({ _tag: Schema.Literal("Shipped"), trackingNumber: Schema.String }),
  ),

  // Handle incoming events
  onEvent: (event, ctx) =>
    Effect.gen(function* () {
      switch (event._tag) {
        case "OrderPlaced":
          yield* ctx.setState({
            orderId: event.orderId,
            status: "pending",
            attempts: 0,
          });
          yield* ctx.schedule(Duration.minutes(5)); // Check payment in 5 min
          break;

        case "PaymentReceived":
          yield* ctx.updateState((s) => ({ ...s, status: "processing" }));
          break;

        case "Shipped":
          yield* ctx.updateState((s) => ({ ...s, status: "shipped" }));
          yield* ctx.schedule(Duration.hours(24)); // Check delivery tomorrow
          break;
      }
    }),

  // Execute when alarm fires
  execute: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.state;
      if (!state) return;

      if (state.status === "pending") {
        // Still pending after 5 min - send reminder
        yield* sendPaymentReminder(state.orderId);
        yield* ctx.schedule(Duration.minutes(30)); // Check again
      }

      if (state.status === "shipped") {
        const delivered = yield* checkDelivery(state.orderId);
        if (delivered) {
          yield* ctx.updateState((s) => ({ ...s, status: "delivered" }));
          yield* ctx.terminate(); // Order complete
        } else {
          yield* ctx.schedule(Duration.hours(24)); // Check again tomorrow
        }
      }
    }),

  // Optional: handle idle state (no alarm scheduled)
  onIdle: (ctx) =>
    Effect.gen(function* () {
      // Schedule cleanup in 1 hour
      yield* ctx.schedule(Duration.hours(1));
    }),

  // Optional: handle errors
  onError: (error, ctx) =>
    Effect.gen(function* () {
      yield* Effect.logError("Task failed", error);
      yield* ctx.updateState((s) => ({ ...s, attempts: s.attempts + 1 }));
      yield* ctx.schedule(Duration.seconds(30)); // Retry
    }),
});
```

**Event context (onEvent):**

| Property | Type | Description |
|----------|------|-------------|
| `state` | `Effect<S \| null>` | Current state (null if first event) |
| `setState(s)` | `Effect<void>` | Set state |
| `updateState(fn)` | `Effect<void>` | Transform state |
| `schedule(when)` | `Effect<void>` | Schedule execution |
| `cancelSchedule()` | `Effect<void>` | Cancel scheduled execution |
| `getScheduledTime()` | `Effect<number \| null>` | Get scheduled time |
| `terminate()` | `Effect<never>` | Terminate and purge state |
| `isFirstEvent` | `boolean` | True if state was null |
| `eventCount` | `Effect<number>` | Total events received |

**Execute context:**

| Property | Type | Description |
|----------|------|-------------|
| `state` | `Effect<S \| null>` | Current state |
| `setState/updateState` | `Effect<void>` | Modify state |
| `schedule/cancelSchedule` | `Effect<void>` | Control scheduling |
| `terminate()` | `Effect<never>` | Terminate task |
| `executeCount` | `Effect<number>` | Times execute has run |
| `eventCount` | `Effect<number>` | Total events received |
| `createdAt` | `Effect<number>` | Task creation time |

---

## Using the Client

### Setup

```typescript
const { Jobs, JobsClient } = createDurableJobs({
  tokenRefresher,
  webhookBatcher,
  orderProcessor,
});

// In your worker
const client = JobsClient.fromBinding(env.JOBS);
```

### Continuous Client

```typescript
// Start a job instance
const result = yield* client.continuous("tokenRefresher").start({
  id: "user-123",            // Instance identifier
  input: { /* initial state */ },
});
// Returns: { created: boolean, instanceId: string, status: JobStatus }

// Trigger immediate execution (bypass schedule)
yield* client.continuous("tokenRefresher").trigger("user-123");

// Check status
const status = yield* client.continuous("tokenRefresher").status("user-123");
// Returns: { status: "running" | "stopped" | "not_found", runCount?, nextRunAt? }

// Get current state
const { state } = yield* client.continuous("tokenRefresher").getState("user-123");

// Terminate (cancel alarm + delete all state)
yield* client.continuous("tokenRefresher").terminate("user-123", {
  reason: "User requested",
});
```

### Debounce Client

```typescript
// Add an event (creates instance if needed)
const result = yield* client.debounce("webhookBatcher").add({
  id: "contact-456",
  event: { type: "contact.updated", contactId: "456", data: {} },
});
// Returns: { created: boolean, eventCount: number, willFlushAt: number | null }

// Force immediate flush
yield* client.debounce("webhookBatcher").flush("contact-456");

// Clear without processing
yield* client.debounce("webhookBatcher").clear("contact-456");

// Check status
const status = yield* client.debounce("webhookBatcher").status("contact-456");
// Returns: { status: "debouncing" | "idle" | "not_found", eventCount?, willFlushAt? }

// Get accumulated state
const { state } = yield* client.debounce("webhookBatcher").getState("contact-456");
```

### Task Client

```typescript
// Send an event (creates instance if needed)
const result = yield* client.task("orderProcessor").send({
  id: "order-789",
  event: { _tag: "OrderPlaced", orderId: "order-789" },
});
// Returns: { created: boolean, instanceId: string, scheduledAt: number | null }

// Trigger immediate execution
yield* client.task("orderProcessor").trigger("order-789");

// Check status
const status = yield* client.task("orderProcessor").status("order-789");
// Returns: { status: "active" | "idle" | "not_found", scheduledAt?, eventCount? }

// Get state
const { state, scheduledAt } = yield* client.task("orderProcessor").getState("order-789");

// Terminate
yield* client.task("orderProcessor").terminate("order-789");
```

---

## Common Concepts

### Instance IDs

Each job instance is identified by a unique ID. The internal Durable Object instance ID follows the pattern:

```
{jobType}:{jobName}:{userProvidedId}
```

For example: `continuous:tokenRefresher:user-123`

### State Schemas

All jobs use Effect Schema for state validation and serialization:

```typescript
const stateSchema = Schema.Struct({
  // Basic types
  count: Schema.Number,
  name: Schema.String,
  active: Schema.Boolean,

  // Rich types (automatically encoded/decoded)
  createdAt: Schema.DateFromSelf,
  data: Schema.Unknown,

  // Optional fields
  lastError: Schema.optional(Schema.String),
});
```

State is validated on read/write. Invalid state throws `ValidationError`.

### Terminate vs Stop

- **`terminate()`**: Removes all state and cancels alarms. The instance ID can be reused to start fresh.
- Jobs don't have a "pause" concept - they're either running or terminated.

### Schedule Inputs

Task's `schedule()` accepts flexible time inputs:

```typescript
// Duration (from now)
yield* ctx.schedule(Duration.seconds(30));
yield* ctx.schedule("5 minutes");

// Absolute timestamp (ms since epoch)
yield* ctx.schedule(Date.now() + 60000);

// Date object
yield* ctx.schedule(new Date("2024-12-31"));
```

---

## Retry Configuration

Configure automatic retries for execute failures:

```typescript
import { Backoff } from "@durable-effect/core";

const job = Continuous.make({
  // ...
  retry: {
    maxAttempts: 3,
    delay: Backoff.exponential({
      base: "1 second",
      max: "30 seconds",
    }),
    jitter: true,  // Add randomness to prevent thundering herd
  },
  execute: (ctx) =>
    Effect.gen(function* () {
      if (ctx.isRetry) {
        console.log(`Retry attempt ${ctx.attempt}`);
      }
      // ... your logic
    }),
});
```

**Retry behavior:**
- Retries are scheduled via alarms (durable, survives restarts)
- When all retries exhausted, the job is terminated (state purged)
- A `job.retryExhausted` event is emitted for observability

**Backoff strategies:**

```typescript
// Exponential: 1s, 2s, 4s, 8s... (capped at max)
Backoff.exponential({ base: "1 second", max: "30 seconds" })

// Linear: 1s, 2s, 3s, 4s...
Backoff.linear({ base: "1 second", increment: "1 second" })

// Fixed: always 5s
Backoff.fixed("5 seconds")
```

---

## Logging

Control logging per job:

```typescript
import { LogLevel } from "effect";

const job = Continuous.make({
  // ...
  logging: true,           // LogLevel.Debug (all logs)
  logging: false,          // LogLevel.Error (failures only) - DEFAULT
  logging: LogLevel.Warning,
  logging: LogLevel.None,  // Silent
});
```

---

## Telemetry

Send job events to an external endpoint:

```typescript
const { Jobs, JobsClient } = createDurableJobs(
  { tokenRefresher, webhookBatcher },
  {
    tracker: {
      endpoint: "https://events.example.com/ingest",
      env: "production",
      serviceKey: "my-jobs-service",
    },
  }
);
```

**Emitted events:**
- `job.started` - Job instance created
- `job.executed` - Execute completed successfully
- `job.failed` - Execute threw an error
- `job.retryExhausted` - All retries failed
- `job.terminated` - Job instance terminated
- `debounce.started` - First event added
- `debounce.flushed` - Batch processed
- `task.scheduled` - Execution scheduled

---

## Error Types

All errors are typed Effect errors:

```typescript
import {
  JobNotFoundError,      // Job name not in registry
  InstanceNotFoundError, // Instance has no metadata
  InvalidStateError,     // Invalid state transition
  ValidationError,       // Schema validation failed
  ExecutionError,        // User function threw
  DuplicateEventError,   // Idempotency check failed
  StorageError,          // Durable Object storage error
  SchedulerError,        // Alarm scheduling error
} from "@durable-effect/jobs";
```

---

## Effect Service Integration

TODO
