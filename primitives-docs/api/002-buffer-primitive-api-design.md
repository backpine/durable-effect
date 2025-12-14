# Debounce Primitive API Design

## Design Philosophy

The Debounce primitive collects events over time and processes them in batches. It follows the same Effect-first patterns as Continuous:

1. **Effect-first** - All operations are Effects, yieldable in generators
2. **Schema-driven** - Input events and state are defined via Effect Schema
3. **Idempotent by default** - Client operations use IDs to ensure exactly-once semantics
4. **Minimal boilerplate** - Simple default behavior with powerful customization options

---

## Core Concept

A Debounce:
1. Receives events via `client.debounce("name").add({ id, event })`
2. Accumulates state (by default, keeps the most recent event)
3. Fires `execute` when either:
   - `maxEvents` threshold is reached, OR
   - `flushAfter` duration elapses since the first event
4. After `execute` completes, state is purged (no alarm remains)

---

## API Overview

### Definition

```ts
import { Debounce } from "@durable-effect/jobs";
import { Schema } from "effect";

const webhookDebounce = Debounce.make({
  eventSchema: Schema.Struct({
    type: Schema.String,
    contactId: Schema.String,
    data: Schema.Unknown,
    occurredAt: Schema.Number,
  }),

  flushAfter: "5 minutes",

  execute: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.state;
      const eventCount = yield* ctx.eventCount;

      // Process the debounceed state
      yield* sendConsolidatedNotification(state);

      console.log(`Processed ${eventCount} events`);
    }),
});
```

### Registration & Export

```ts
import { createDurableJobs } from "@durable-effect/jobs";

const { Jobs, JobsClient } = createDurableJobs({
  webhookDebounce,
  // ... other jobs
});

// Export DO class for Cloudflare
export { Jobs };
```

### Client Usage

```ts
// In your worker/webhook handler
const client = JobsClient.fromBinding(env.PRIMITIVES);

// Add event to debounce (idempotent)
yield* client.debounce("webhookDebounce").add({
  id: `${contactId}-${eventId}`,  // Idempotency key
  event: {
    type: "order.shipped",
    contactId: contactId,
    data: webhookPayload,
    occurredAt: Date.now(),
  },
});
```

---

## Detailed API

### `Debounce.make(config)`

Creates a Debounce definition.

```ts
interface DebounceConfig<
  I extends Schema.Schema.AnyNoContext,
  S extends Schema.Schema.AnyNoContext,
  E,
  R
> {
  /**
   * Effect Schema defining the event shape.
   * Events added via client.add() must match this schema.
   */
  readonly eventSchema: I;

  /**
   * Effect Schema defining the state shape.
   * If not provided, defaults to eventSchema (state = most recent event).
   */
  readonly stateSchema?: S;

  /**
   * Duration to wait before flushing after first event.
   * The debounce will execute after this duration OR when maxEvents is reached.
   */
  readonly flushAfter: Duration.DurationInput;

  /**
   * Maximum number of events before flushing.
   * When reached, execute fires immediately.
   * @default undefined (no limit, only time-based flushing)
   */
  readonly maxEvents?: number;

  /**
   * The execution effect, called when debounce flushes.
   * After execution completes, state is purged.
   */
  readonly execute: (
    ctx: DebounceExecuteContext<Schema.Schema.Type<S>>
  ) => Effect.Effect<void, E, R>;

  /**
   * Optional handler called for each event.
   * Returns the new state based on the incoming event and current state.
   *
   * Default behavior: Replace state with incoming event (keep most recent).
   */
  readonly onEvent?: (
    ctx: DebounceEventContext<Schema.Schema.Type<I>, Schema.Schema.Type<S>>
  ) => Effect.Effect<Schema.Schema.Type<S>, never, R>;

  /**
   * Optional error handler for execution failures.
   * If not provided, errors are logged and state is preserved for retry.
   */
  readonly onError?: (
    error: E,
    ctx: DebounceExecuteContext<Schema.Schema.Type<S>>
  ) => Effect.Effect<void, never, R>;
}
```

### `DebounceExecuteContext<S>`

The context provided to the `execute` function.

```ts
interface DebounceExecuteContext<S> {
  /**
   * Get the current accumulated state.
   * Returns the validated, typed state.
   */
  readonly state: Effect.Effect<S, never, never>;

  /**
   * The total number of events that were debounceed.
   * (Events may have been deduplicated or reduced via onEvent)
   */
  readonly eventCount: Effect.Effect<number, never, never>;

  /**
   * The instance ID.
   */
  readonly instanceId: string;

  /**
   * Timestamp when the first event arrived (debounce started).
   */
  readonly debounceStartedAt: Effect.Effect<number, never, never>;

  /**
   * Timestamp when execute was triggered.
   */
  readonly executionStartedAt: number;

  /**
   * Why the debounce was flushed.
   */
  readonly flushReason: "maxEvents" | "flushAfter" | "manual";
}
```

### `DebounceEventContext<I, S>`

The context provided to the `onEvent` handler.

```ts
interface DebounceEventContext<I, S> {
  /**
   * The incoming event.
   */
  readonly event: I;

  /**
   * The current state (null if this is the first event).
   * Note: Uses null (not undefined) for consistency with other jobs.
   */
  readonly state: S | null;

  /**
   * The total number of events received so far (including this one).
   */
  readonly eventCount: number;

  /**
   * The instance ID.
   */
  readonly instanceId: string;
}
```

---

## Default Behavior: Keep Most Recent

When `onEvent` is not provided, the default behavior is to **keep the most recent event as state**:

```ts
// This is the implicit default onEvent:
onEvent: (ctx) => Effect.succeed(ctx.event)
```

This is useful for scenarios where you only care about the latest state:
- Status updates (only final status matters)
- Location tracking (only current position matters)
- Progress updates (only latest progress matters)

---

## Custom `onEvent` Examples

### Keep Event with Latest Timestamp

```ts
const webhookDebounce = Debounce.make({
  eventSchema: WebhookEvent,

  flushAfter: "5 minutes",

  onEvent: (ctx) =>
    Effect.gen(function* () {
      const { event, state } = ctx;

      // First event - use it
      if (state === null) {
        return event;
      }

      // Keep the one with the latest timestamp
      return event.occurredAt > state.occurredAt
        ? event
        : state;
    }),

  execute: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.state;
      yield* processLatestEvent(state);
    }),
});
```

### Keep Highest Priority Event

```ts
const priorityOrder = {
  "order.cancelled": 4,
  "order.delivered": 3,
  "order.shipped": 2,
  "order.placed": 1,
} as const;

const orderDebounce = Debounce.make({
  eventSchema: OrderEvent,

  flushAfter: "5 minutes",

  onEvent: (ctx) =>
    Effect.gen(function* () {
      const { event, state } = ctx;

      if (state === null) {
        return event;
      }

      const eventPriority = priorityOrder[event.type] ?? 0;
      const statePriority = priorityOrder[state.type] ?? 0;

      return eventPriority > statePriority ? event : state;
    }),

  execute: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.state;
      // state contains the highest priority event
      yield* sendNotification(state);
    }),
});
```

### Aggregate into Custom State

```ts
// Different state schema than input
const NotificationSummary = Schema.Struct({
  contactId: Schema.String,
  eventTypes: Schema.Array(Schema.String),
  mostImportant: Schema.String,
  firstEventAt: Schema.Number,
  lastEventAt: Schema.Number,
});

const aggregateDebounce = Debounce.make({
  eventSchema: WebhookEvent,
  stateSchema: NotificationSummary,

  flushAfter: "5 minutes",
  maxEvents: 50,

  onEvent: (ctx) =>
    Effect.gen(function* () {
      const { event, state, eventCount } = ctx;

      if (state === null) {
        return {
          contactId: event.contactId,
          eventTypes: [event.type],
          mostImportant: event.type,
          firstEventAt: event.occurredAt,
          lastEventAt: event.occurredAt,
        };
      }

      return {
        ...state,
        eventTypes: [...state.eventTypes, event.type],
        mostImportant: pickMostImportant(state.mostImportant, event.type),
        lastEventAt: event.occurredAt,
      };
    }),

  execute: (ctx) =>
    Effect.gen(function* () {
      const summary = yield* ctx.state;
      const eventCount = yield* ctx.eventCount;

      yield* sendConsolidatedEmail({
        to: summary.contactId,
        subject: `${eventCount} updates for your order`,
        highlight: summary.mostImportant,
        events: summary.eventTypes,
      });
    }),
});
```

---

## Client API

### Getting a Debounce Client

```ts
const client = JobsClient.fromBinding(env.PRIMITIVES);
const webhookClient = client.debounce("webhookDebounce");
```

### `add(options)`

Add an event to the debounce. **Idempotent** - same `id` is deduplicated.

```ts
interface DebounceAddOptions<I> {
  /**
   * Unique identifier for this debounce instance.
   * Events with the same instanceId go to the same debounce.
   */
  readonly id: string;

  /**
   * The event to add. Must match eventSchema.
   */
  readonly event: I;

  /**
   * Optional idempotency key for this specific event.
   * If provided, duplicate events with the same key are ignored.
   * @default undefined (no event-level deduplication)
   */
  readonly eventId?: string;
}

// Usage
const result = yield* webhookClient.add({
  id: contactId,           // Debounce instance ID
  event: {
    type: "order.shipped",
    contactId: contactId,
    data: payload,
    occurredAt: Date.now(),
  },
  eventId: webhookId,      // Optional: deduplicate this specific event
});

// Returns
interface DebounceAddResult {
  readonly instanceId: string;
  readonly eventCount: number;
  readonly willFlushAt: number | null;  // null if maxEvents will trigger first
  readonly created: boolean;            // true if this started a new debounce
}
```

### `flush(id)`

Manually trigger the debounce to flush immediately.

```ts
yield* webhookClient.flush(contactId);

// Returns
interface DebounceFlushResult {
  readonly flushed: boolean;
  readonly eventCount: number;
  readonly reason: "manual" | "empty";  // "empty" if no events debounceed
}
```

### `status(id)`

Get the current status of a debounce.

```ts
const status = yield* webhookClient.status(contactId);

type DebounceStatus =
  | {
      readonly _tag: "Debounceing";
      readonly eventCount: number;
      readonly startedAt: number;
      readonly willFlushAt: number;
    }
  | { readonly _tag: "Empty" }
  | { readonly _tag: "NotFound" };
```

### `getState(id)`

Get the current debounceed state (typed by stateSchema).

```ts
const state = yield* webhookClient.getState(contactId);
// state: WebhookEvent | null | undefined
// null = instance exists but no state yet, undefined = instance doesn't exist
```

### `clear(id)`

Clear the debounce without executing (discard events).

```ts
yield* webhookClient.clear(contactId);

// Returns
interface DebounceClearResult {
  readonly cleared: boolean;
  readonly discardedEvents: number;
}
```

---

## Complete Examples

### Example 1: Webhook Event Consolidation

```ts
import { Debounce } from "@durable-effect/jobs";
import { Effect, Schema } from "effect";

// Define the input event schema
const WebhookEvent = Schema.Struct({
  type: Schema.Literal(
    "order.placed",
    "order.shipped",
    "order.delivered",
    "order.cancelled"
  ),
  contactId: Schema.String,
  orderId: Schema.String,
  data: Schema.Unknown,
  occurredAt: Schema.Number,
});

type WebhookEvent = Schema.Schema.Type<typeof WebhookEvent>;

// Priority for determining most important event
const eventPriority: Record<WebhookEvent["type"], number> = {
  "order.cancelled": 4,
  "order.delivered": 3,
  "order.shipped": 2,
  "order.placed": 1,
};

const webhookDebounce = Debounce.make({
  eventSchema: WebhookEvent,

  flushAfter: "5 minutes",
  maxEvents: 20,

  // Keep the highest priority event
  onEvent: (ctx) =>
    Effect.gen(function* () {
      const { event, state } = ctx;

      if (state === null) {
        return event;
      }

      const incomingPriority = eventPriority[event.type];
      const currentPriority = eventPriority[state.type];

      // Keep higher priority, or more recent if same priority
      if (incomingPriority > currentPriority) {
        return event;
      }
      if (incomingPriority === currentPriority && event.occurredAt > state.occurredAt) {
        return event;
      }

      return state;
    }),

  execute: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.state;
      const eventCount = yield* ctx.eventCount;
      const flushReason = ctx.flushReason;

      // Send consolidated notification
      yield* sendEmail({
        to: state.contactId,
        template: "order-update",
        data: {
          eventType: state.type,
          orderId: state.orderId,
          totalEvents: eventCount,
        },
      });

      console.log(
        `Sent notification for ${state.contactId}: ${state.type} ` +
        `(${eventCount} events, flushed by ${flushReason})`
      );
    }),

  onError: (error, ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.state;

      // Send to dead letter workerPool for manual processing
      yield* sendToDeadLetter("webhook-debounce-failures", {
        state,
        error: String(error),
        instanceId: ctx.instanceId,
      });
    }),
});
```

**Webhook handler usage:**

```ts
export default {
  async fetch(request: Request, env: Env) {
    const webhook = await request.json();
    const client = JobsClient.fromBinding(env.PRIMITIVES);

    // Add to debounce (idempotent by webhookId)
    const result = await Effect.runPromise(
      client.debounce("webhookDebounce").add({
        id: webhook.contactId,
        event: {
          type: webhook.type,
          contactId: webhook.contactId,
          orderId: webhook.orderId,
          data: webhook.data,
          occurredAt: webhook.timestamp,
        },
        eventId: webhook.id,  // Webhook providers often send duplicates
      })
    );

    return new Response(JSON.stringify({
      debounceed: true,
      eventCount: result.eventCount,
      willFlushAt: result.willFlushAt,
    }));
  },
};
```

### Example 2: Analytics Event Batching

```ts
const AnalyticsEvent = Schema.Struct({
  eventName: Schema.String,
  userId: Schema.String,
  properties: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  timestamp: Schema.Number,
});

// Custom state: collect all events
const AnalyticsBatch = Schema.Struct({
  userId: Schema.String,
  events: Schema.Array(AnalyticsEvent),
  firstEventAt: Schema.Number,
});

const analyticsDebounce = Debounce.make({
  eventSchema: AnalyticsEvent,
  stateSchema: AnalyticsBatch,

  flushAfter: "1 minute",
  maxEvents: 100,

  // Collect all events into an array
  onEvent: (ctx) =>
    Effect.gen(function* () {
      const { event, state } = ctx;

      if (state === null) {
        return {
          userId: event.userId,
          events: [event],
          firstEventAt: event.timestamp,
        };
      }

      return {
        ...state,
        events: [...state.events, event],
      };
    }),

  execute: (ctx) =>
    Effect.gen(function* () {
      const batch = yield* ctx.state;

      // Send batch to analytics service
      yield* Effect.tryPromise(() =>
        fetch("https://analytics.example.com/batch", {
          method: "POST",
          body: JSON.stringify({
            userId: batch.userId,
            events: batch.events,
          }),
        })
      );
    }),
});
```

**Usage in application:**

```ts
// Track an event (fire and forget)
yield* client.debounce("analyticsDebounce").add({
  id: userId,
  event: {
    eventName: "button_clicked",
    userId: userId,
    properties: { buttonId: "signup", page: "/home" },
    timestamp: Date.now(),
  },
});
```

### Example 3: Rate-Limited API Calls

```ts
const ApiRequest = Schema.Struct({
  endpoint: Schema.String,
  method: Schema.Literal("GET", "POST", "PUT", "DELETE"),
  body: Schema.NullOr(Schema.Unknown),
  requestId: Schema.String,
  workerPooldAt: Schema.Number,
});

// Batch requests to same endpoint
const ApiBatch = Schema.Struct({
  endpoint: Schema.String,
  requests: Schema.Array(ApiRequest),
});

const apiDebounce = Debounce.make({
  eventSchema: ApiRequest,
  stateSchema: ApiBatch,

  flushAfter: "100 millis",  // Small delay to batch rapid requests
  maxEvents: 10,             // API batch limit

  onEvent: (ctx) =>
    Effect.gen(function* () {
      const { event, state } = ctx;

      if (state === null) {
        return {
          endpoint: event.endpoint,
          requests: [event],
        };
      }

      return {
        ...state,
        requests: [...state.requests, event],
      };
    }),

  execute: (ctx) =>
    Effect.gen(function* () {
      const batch = yield* ctx.state;

      // Make batched API call
      const response = yield* Effect.tryPromise(() =>
        fetch(batch.endpoint + "/batch", {
          method: "POST",
          body: JSON.stringify({ requests: batch.requests }),
        })
      );

      // Handle responses...
    }),
});
```

---

## Naming Considerations

### `flushAfter` Alternatives

| Name | Pros | Cons |
|------|------|------|
| `flushAfter` | Clear, describes timing | Could be confused with "flush after execute" |
| `debounceTimeout` | Common pattern | Less clear about what happens |
| `maxWait` | Short, clear | Doesn't mention flushing |
| `flushDelay` | Explicit about delay | Could imply delay after trigger |
| `collectFor` | Describes accumulation | Less common terminology |

**Recommendation:** `flushAfter` is clear and intuitive.

### `maxEvents` Alternatives

| Name | Pros | Cons |
|------|------|------|
| `maxEvents` | Clear, simple | - |
| `maxDebounceSize` | Explicit about debounce | Could imply bytes |
| `flushAt` | Describes trigger | Less clear |
| `batchSize` | Common pattern | Could imply fixed size |

**Recommendation:** `maxEvents` is clear.

### `onEvent` Alternatives

| Name | Pros | Cons |
|------|------|------|
| `onEvent` | Simple, clear | Generic |
| `reducer` | Functional programming term | Less familiar to some |
| `accumulate` | Describes action | Verb vs noun inconsistency |
| `aggregate` | Describes result | Same issue |
| `onReceive` | Explicit about timing | Longer |

**Recommendation:** `onEvent` is simple and clear.

---

## Type Inference Flow

```ts
// 1. Input schema defines event type
const MyEvent = Schema.Struct({
  type: Schema.String,
  value: Schema.Number,
});

// 2. State schema (optional) defines accumulated state type
const MyState = Schema.Struct({
  latestType: Schema.String,
  totalValue: Schema.Number,
});

// 3. Types flow through the API
const debounce = Debounce.make({
  eventSchema: MyEvent,
  stateSchema: MyState,

  onEvent: (ctx) =>
    Effect.gen(function* () {
      // ctx.event is { type: string; value: number }
      // ctx.state is { latestType: string; totalValue: number } | null
      const { event, state } = ctx;

      return {
        latestType: event.type,
        totalValue: (state?.totalValue ?? 0) + event.value,
      };
      // ^? Must match MyState
    }),

  execute: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.state;
      //    ^? { latestType: string; totalValue: number }
    }),
});

// 4. Client add() is typed by eventSchema
yield* client.debounce("myDebounce").add({
  id: "123",
  event: { type: "click", value: 1 },
  //      ^? Must match MyEvent
});

// 5. getState() returns state type
const state = yield* client.debounce("myDebounce").getState("123");
//    ^? { latestType: string; totalValue: number } | null | undefined
// null = instance exists but no state yet, undefined = instance doesn't exist
```

---

## Lifecycle Diagram

```
                    ┌─────────┐
                    │  EMPTY  │◄─────────────────────────┐
                    └────┬────┘                          │
                         │ add(event)                    │
                         │ starts timer                  │
                         ▼                               │
                    ┌─────────────┐                      │
        add(event)  │  BUFFERING  │                      │
              ┌────►│             │◄────┐                │
              │     │ eventCount++│     │                │
              │     └──────┬──────┘     │                │
              │            │            │                │
              │     ┌──────┴──────┐     │                │
              │     │             │     │                │
              │     ▼             ▼     │                │
              │  timer       maxEvents  │                │
              │  fires       reached    │                │
              │     │             │     │                │
              │     └──────┬──────┘     │                │
              │            │            │                │
              │            ▼            │                │
              │     ┌─────────────┐     │                │
              │     │  FLUSHING   │     │ (events during │
              │     │  execute()  │─────┘  flush go to   │
              │     └──────┬──────┘        next batch)   │
              │            │                             │
              │            │ execute completes           │
              │            │ state purged                │
              │            │                             │
              └────────────┴─────────────────────────────┘
                      (if events arrived during flush)
```

---

## Comparison: Debounce vs Continuous

| Aspect | Debounce | Continuous |
|--------|--------|------------|
| **Trigger** | Events (external) | Schedule (internal) |
| **Lifecycle** | Event → Accumulate → Flush → Purge | Start → Execute → Schedule → Repeat |
| **State after execute** | Purged | Persisted |
| **Alarm after execute** | None | Scheduled |
| **Primary use case** | Batching, debouncing | Polling, periodic tasks |
| **Client interaction** | `add()` events | `start()` once |

---

## Summary

| Feature | API |
|---------|-----|
| Define debounce | `Debounce.make({ eventSchema, flushAfter, execute })` |
| Custom state | `stateSchema: MyStateSchema` |
| Event handling | `onEvent: (ctx) => Effect<State>` |
| Max events trigger | `maxEvents: 100` |
| Flush timeout | `flushAfter: "5 minutes"` |
| Execute context - state | `yield* ctx.state` |
| Execute context - count | `yield* ctx.eventCount` |
| Execute context - reason | `ctx.flushReason` |
| Client - add event | `yield* client.debounce("name").add({ id, event })` |
| Client - manual flush | `yield* client.debounce("name").flush(id)` |
| Client - get status | `yield* client.debounce("name").status(id)` |
| Client - get state | `yield* client.debounce("name").getState(id)` |
| Client - clear | `yield* client.debounce("name").clear(id)` |

The API prioritizes:
- **Effect-native patterns** (generators, yieldable operations)
- **Type safety** (Schema-driven, full inference)
- **Idempotency** (ID-based operations, event deduplication)
- **Sensible defaults** (keep most recent, automatic purge)
- **Flexibility** (custom `onEvent` for any accumulation logic)
