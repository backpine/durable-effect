# Task Primitive API Design

## Design Philosophy

The Task primitive is the most fundamental and powerful primitive. It provides raw access to durable state, scheduling, and purging—giving full control to the user. It follows the same Effect-first patterns:

1. **Effect-first** - All operations are Effects, yieldable in generators
2. **Schema-driven** - Events are defined via Effect Schema for validation
3. **Idempotent by default** - Client operations use IDs to ensure exactly-once semantics
4. **Full power** - Direct access to schedule, state, and purge primitives

---

## Core Concept

A Task:
1. Receives events via `client.task("name").send({ id, event })`
2. Calls `execute` with full context (schedule, state, purge)
3. User decides everything: when to run next, what state to keep, when to purge

**Key distinction from other primitives:**
- Continuous: Schedule-driven, state persists between executions
- Buffer: Event-driven, state purged after flush
- Queue: Event-driven, one-at-a-time processing
- **Task: Event-driven, full manual control**

The Task is a building block—you could implement Buffer, Queue, or Continuous using Task.

---

## API Overview

### Definition

```ts
import { Task } from "@durable-effect/primitives";
import { Schema } from "effect";

const orderProcessor = Task.make({
  eventSchema: Schema.Struct({
    type: Schema.Literal("process", "cancel", "refund"),
    orderId: Schema.String,
    data: Schema.Unknown,
  }),

  execute: (ctx) =>
    Effect.gen(function* () {
      const event = yield* ctx.event;
      const state = yield* ctx.state;
      const isFirstEvent = state === null;

      if (isFirstEvent) {
        // First event - initialize
        yield* ctx.setState({ orderId: event.orderId, status: "processing" });
      }

      switch (event.type) {
        case "process":
          yield* processOrder(event.data);
          yield* ctx.setState({ ...state, status: "processed" });
          // Schedule cleanup in 30 days
          yield* ctx.schedule("30 days");
          break;

        case "cancel":
          yield* cancelOrder(event.orderId);
          // Purge immediately
          yield* ctx.purge();
          break;

        case "refund":
          yield* refundOrder(event.data);
          yield* ctx.setState({ ...state, status: "refunded" });
          yield* ctx.schedule("7 days");
          break;
      }
    }),
});
```

### Registration & Export

```ts
import { createDurablePrimitives } from "@durable-effect/primitives";

const { Primitives, PrimitivesClient } = createDurablePrimitives({
  orderProcessor,
  // ... other primitives
});

// Export DO class for Cloudflare
export { Primitives };
```

### Client Usage

```ts
// In your worker/handler
const client = PrimitivesClient.fromBinding(env.PRIMITIVES);

// Send event (idempotent)
yield* client.task("orderProcessor").send({
  id: orderId,  // Instance ID
  event: {
    type: "process",
    orderId: orderId,
    data: orderData,
  },
  eventId: `${orderId}-process`,  // Optional: event-level idempotency
});
```

---

## Detailed API

### `Task.make(config)`

Creates a Task definition.

```ts
interface TaskConfig<
  E extends Schema.Schema.AnyNoContext,
  S,
  Err,
  R
> {
  /**
   * Effect Schema defining the event shape.
   * Events sent via client.send() must match this schema.
   */
  readonly eventSchema: E;

  /**
   * Optional Effect Schema for state validation/serialization.
   * If not provided, state is typed as `unknown`.
   */
  readonly stateSchema?: Schema.Schema<S, unknown>;

  /**
   * The execution effect, called for each event.
   * Has full access to state, schedule, and purge.
   */
  readonly execute: (
    ctx: TaskContext<Schema.Schema.Type<E>, S>
  ) => Effect.Effect<void, Err, R>;

  /**
   * Optional handler called when an alarm fires (scheduled via ctx.schedule).
   * If not provided, alarms are ignored.
   */
  readonly onAlarm?: (
    ctx: TaskAlarmContext<S>
  ) => Effect.Effect<void, Err, R>;

  /**
   * Optional error handler.
   * If not provided, errors are logged and state is preserved.
   */
  readonly onError?: (
    error: Err,
    ctx: TaskErrorContext<S>
  ) => Effect.Effect<void, never, R>;
}
```

### `TaskContext<E, S>`

The context provided to the `execute` function.

```ts
interface TaskContext<E, S> {
  // ─────────────────────────────────────────────────────────────
  // Event
  // ─────────────────────────────────────────────────────────────

  /**
   * The incoming event.
   */
  readonly event: Effect.Effect<E, never, never>;

  /**
   * The event ID (if provided at send time).
   */
  readonly eventId: string | undefined;

  /**
   * Whether this is the first event (state is null).
   * Convenience for checking `(yield* ctx.state) === null`.
   */
  readonly isFirstEvent: Effect.Effect<boolean, never, never>;

  // ─────────────────────────────────────────────────────────────
  // State
  // ─────────────────────────────────────────────────────────────

  /**
   * Get the current state.
   * Returns `null` if no state has been set (first event).
   */
  readonly state: Effect.Effect<S | null, never, never>;

  /**
   * Set the state (replaces entirely).
   */
  readonly setState: (state: S) => Effect.Effect<void, never, never>;

  /**
   * Update state with a partial update (merged with current).
   * Fails if state is null (use setState for first event).
   */
  readonly updateState: (
    updater: (current: S) => Partial<S>
  ) => Effect.Effect<void, never, never>;

  /**
   * Get a specific value from state by key.
   */
  readonly getStateKey: <K extends keyof S>(
    key: K
  ) => Effect.Effect<S[K] | undefined, never, never>;

  /**
   * Set a specific value in state by key.
   */
  readonly setStateKey: <K extends keyof S>(
    key: K,
    value: S[K]
  ) => Effect.Effect<void, never, never>;

  // ─────────────────────────────────────────────────────────────
  // Schedule
  // ─────────────────────────────────────────────────────────────

  /**
   * Schedule the alarm to fire after a duration or at a timestamp.
   * If an alarm is already scheduled, it is replaced.
   */
  readonly schedule: (
    when: Duration.DurationInput | number | Date
  ) => Effect.Effect<void, never, never>;

  /**
   * Cancel any scheduled alarm.
   */
  readonly cancelSchedule: () => Effect.Effect<void, never, never>;

  /**
   * Get the currently scheduled alarm time (if any).
   */
  readonly getScheduledTime: () => Effect.Effect<number | null, never, never>;

  // ─────────────────────────────────────────────────────────────
  // Purge
  // ─────────────────────────────────────────────────────────────

  /**
   * Purge all state and cancel any scheduled alarms.
   * The DO instance will be deleted.
   * This effect never returns (throws internally to halt execution).
   */
  readonly purge: () => Effect.Effect<never, never, never>;

  /**
   * Schedule purge to happen after a duration or at a timestamp.
   * State is preserved until then; events can still be processed.
   */
  readonly schedulePurge: (
    when: Duration.DurationInput | number | Date
  ) => Effect.Effect<void, never, never>;

  /**
   * Cancel any scheduled purge.
   */
  readonly cancelPurge: () => Effect.Effect<void, never, never>;

  // ─────────────────────────────────────────────────────────────
  // Metadata
  // ─────────────────────────────────────────────────────────────

  /**
   * The instance ID.
   */
  readonly instanceId: string;

  /**
   * Timestamp when this execution started.
   */
  readonly executionStartedAt: number;

  /**
   * Number of events this instance has processed (1-indexed).
   */
  readonly eventCount: Effect.Effect<number, never, never>;

  /**
   * Timestamp when this instance was created (first event).
   */
  readonly createdAt: Effect.Effect<number, never, never>;
}
```

### `TaskAlarmContext<S>`

The context provided to the `onAlarm` handler.

```ts
interface TaskAlarmContext<S> {
  /**
   * Get the current state.
   */
  readonly state: Effect.Effect<S | null, never, never>;

  /**
   * Set the state.
   */
  readonly setState: (state: S) => Effect.Effect<void, never, never>;

  /**
   * Update state with a partial update.
   */
  readonly updateState: (
    updater: (current: S) => Partial<S>
  ) => Effect.Effect<void, never, never>;

  /**
   * Schedule the next alarm.
   */
  readonly schedule: (
    when: Duration.DurationInput | number | Date
  ) => Effect.Effect<void, never, never>;

  /**
   * Cancel scheduled alarm.
   */
  readonly cancelSchedule: () => Effect.Effect<void, never, never>;

  /**
   * Purge all state.
   */
  readonly purge: () => Effect.Effect<never, never, never>;

  /**
   * Schedule purge.
   */
  readonly schedulePurge: (
    when: Duration.DurationInput | number | Date
  ) => Effect.Effect<void, never, never>;

  /**
   * The instance ID.
   */
  readonly instanceId: string;

  /**
   * Timestamp when this alarm fired.
   */
  readonly alarmFiredAt: number;

  /**
   * Whether this is a purge alarm (vs user-scheduled alarm).
   */
  readonly isPurgeAlarm: boolean;
}
```

### `TaskErrorContext<S>`

The context provided to the `onError` handler.

```ts
interface TaskErrorContext<S> {
  /**
   * Get the current state.
   */
  readonly state: Effect.Effect<S | null, never, never>;

  /**
   * Set the state.
   */
  readonly setState: (state: S) => Effect.Effect<void, never, never>;

  /**
   * Schedule an alarm (e.g., for retry).
   */
  readonly schedule: (
    when: Duration.DurationInput | number | Date
  ) => Effect.Effect<void, never, never>;

  /**
   * Purge all state.
   */
  readonly purge: () => Effect.Effect<never, never, never>;

  /**
   * The instance ID.
   */
  readonly instanceId: string;

  /**
   * What triggered the error: "event" or "alarm".
   */
  readonly trigger: "event" | "alarm";

  /**
   * The event that caused the error (if trigger is "event").
   */
  readonly event: unknown | undefined;
}
```

---

## State Lifecycle

The state is `null` until the first `setState` call. This provides a clear signal for "first event":

```ts
execute: (ctx) =>
  Effect.gen(function* () {
    const state = yield* ctx.state;
    const event = yield* ctx.event;

    if (state === null) {
      // First event - initialize state
      yield* ctx.setState({
        id: event.id,
        status: "initialized",
        history: [event],
      });
      return;
    }

    // Subsequent events - update state
    yield* ctx.updateState((s) => ({
      history: [...s.history, event],
    }));
  }),
```

Or use the convenience property:

```ts
execute: (ctx) =>
  Effect.gen(function* () {
    const isFirst = yield* ctx.isFirstEvent;

    if (isFirst) {
      // Handle first event
    }
  }),
```

---

## Client API

### Getting a Task Client

```ts
const client = PrimitivesClient.fromBinding(env.PRIMITIVES);
const orderClient = client.task("orderProcessor");
```

### `send(options)`

Send an event to a task instance. **Idempotent** by `eventId`.

```ts
interface TaskSendOptions<E> {
  /**
   * Unique identifier for this task instance.
   * Events with the same `id` go to the same instance.
   */
  readonly id: string;

  /**
   * The event to send. Must match eventSchema.
   */
  readonly event: E;

  /**
   * Optional idempotency key for this specific event.
   * If provided, duplicate events with the same key are ignored.
   */
  readonly eventId?: string;
}

// Usage
const result = yield* orderClient.send({
  id: orderId,
  event: {
    type: "process",
    orderId: orderId,
    data: { items: [...] },
  },
  eventId: `${orderId}-process-${Date.now()}`,
});

// Returns
interface TaskSendResult {
  readonly instanceId: string;
  readonly eventCount: number;
  readonly created: boolean;      // true if this created the instance
  readonly duplicate: boolean;    // true if eventId was already processed
}
```

### `status(id)`

Get the current status of a task instance.

```ts
const status = yield* orderClient.status(orderId);

type TaskStatus =
  | {
      readonly _tag: "Active";
      readonly eventCount: number;
      readonly createdAt: number;
      readonly scheduledAt: number | null;
      readonly purgeScheduledAt: number | null;
    }
  | { readonly _tag: "NotFound" };
```

### `getState(id)`

Get the current state (typed by stateSchema if provided).

```ts
const state = yield* orderClient.getState(orderId);
// state: S | null | undefined (undefined if instance doesn't exist)
```

### `trigger(id)`

Trigger the alarm handler immediately (bypasses schedule).

```ts
yield* orderClient.trigger(orderId);

// Returns
interface TaskTriggerResult {
  readonly triggered: boolean;
  readonly reason: "triggered" | "not_found" | "no_alarm_handler";
}
```

### `purge(id)`

Purge the instance immediately.

```ts
yield* orderClient.purge(orderId);

// Returns
interface TaskPurgeResult {
  readonly purged: boolean;
  readonly reason: "purged" | "not_found";
}
```

---

## Complete Examples

### Example 1: Order Lifecycle Manager

Full control over order state, with scheduled reminders and cleanup.

```ts
import { Task } from "@durable-effect/primitives";
import { Effect, Schema, Duration } from "effect";

const OrderEvent = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("create"),
    orderId: Schema.String,
    customerId: Schema.String,
    items: Schema.Array(Schema.Struct({
      productId: Schema.String,
      quantity: Schema.Number,
    })),
  }),
  Schema.Struct({
    type: Schema.Literal("pay"),
    paymentId: Schema.String,
    amount: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.Literal("ship"),
    trackingNumber: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("deliver"),
    deliveredAt: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.Literal("cancel"),
    reason: Schema.String,
  }),
);

type OrderEvent = Schema.Schema.Type<typeof OrderEvent>;

const OrderState = Schema.Struct({
  orderId: Schema.String,
  customerId: Schema.String,
  status: Schema.Literal(
    "pending",
    "paid",
    "shipped",
    "delivered",
    "cancelled"
  ),
  items: Schema.Array(Schema.Struct({
    productId: Schema.String,
    quantity: Schema.Number,
  })),
  paymentId: Schema.NullOr(Schema.String),
  trackingNumber: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

type OrderState = Schema.Schema.Type<typeof OrderState>;

const orderManager = Task.make({
  eventSchema: OrderEvent,
  stateSchema: OrderState,

  execute: (ctx) =>
    Effect.gen(function* () {
      const event = yield* ctx.event;
      const state = yield* ctx.state;
      const now = Date.now();

      // First event must be "create"
      if (state === null) {
        if (event.type !== "create") {
          console.error(`First event must be 'create', got '${event.type}'`);
          return;
        }

        yield* ctx.setState({
          orderId: event.orderId,
          customerId: event.customerId,
          status: "pending",
          items: event.items,
          paymentId: null,
          trackingNumber: null,
          createdAt: now,
          updatedAt: now,
        });

        // Schedule reminder if not paid within 1 hour
        yield* ctx.schedule(Duration.hours(1));
        return;
      }

      // Handle events based on type
      switch (event.type) {
        case "create":
          // Ignore duplicate creates
          console.warn(`Order ${state.orderId} already created`);
          break;

        case "pay":
          yield* ctx.updateState(() => ({
            status: "paid",
            paymentId: event.paymentId,
            updatedAt: now,
          }));
          // Cancel the payment reminder
          yield* ctx.cancelSchedule();
          break;

        case "ship":
          yield* ctx.updateState(() => ({
            status: "shipped",
            trackingNumber: event.trackingNumber,
            updatedAt: now,
          }));
          // Schedule delivery check in 7 days
          yield* ctx.schedule(Duration.days(7));
          // Send shipping notification
          yield* sendShippingNotification(state.customerId, event.trackingNumber);
          break;

        case "deliver":
          yield* ctx.updateState(() => ({
            status: "delivered",
            updatedAt: now,
          }));
          // Schedule data purge in 90 days (GDPR compliance)
          yield* ctx.schedulePurge(Duration.days(90));
          // Send delivery confirmation
          yield* sendDeliveryConfirmation(state.customerId, state.orderId);
          break;

        case "cancel":
          yield* ctx.updateState(() => ({
            status: "cancelled",
            updatedAt: now,
          }));
          // Cancel any scheduled alarms
          yield* ctx.cancelSchedule();
          // Schedule purge in 30 days
          yield* ctx.schedulePurge(Duration.days(30));
          // Process refund if paid
          if (state.paymentId) {
            yield* processRefund(state.paymentId);
          }
          break;
      }
    }),

  onAlarm: (ctx) =>
    Effect.gen(function* () {
      // Skip if this is a purge alarm
      if (ctx.isPurgeAlarm) return;

      const state = yield* ctx.state;
      if (!state) return;

      switch (state.status) {
        case "pending":
          // Payment reminder - order not paid within 1 hour
          yield* sendPaymentReminder(state.customerId, state.orderId);
          // Check again in 1 hour
          yield* ctx.schedule(Duration.hours(1));
          break;

        case "shipped":
          // Delivery check - ask for confirmation
          yield* sendDeliveryCheckEmail(state.customerId, state.orderId);
          // Check again in 3 days
          yield* ctx.schedule(Duration.days(3));
          break;
      }
    }),

  onError: (error, ctx) =>
    Effect.gen(function* () {
      console.error(`Order error [${ctx.instanceId}]:`, error);

      // Store error for debugging
      const state = yield* ctx.state;
      if (state) {
        yield* recordOrderError(state.orderId, error, ctx.trigger);
      }

      // Retry in 5 minutes for transient errors
      yield* ctx.schedule(Duration.minutes(5));
    }),
});
```

**Usage:**

```ts
const client = PrimitivesClient.fromBinding(env.PRIMITIVES);
const orders = client.task("orderManager");

// Create order
yield* orders.send({
  id: orderId,
  event: {
    type: "create",
    orderId,
    customerId,
    items: [{ productId: "prod-1", quantity: 2 }],
  },
  eventId: `${orderId}-create`,
});

// Process payment
yield* orders.send({
  id: orderId,
  event: {
    type: "pay",
    paymentId: "pay-123",
    amount: 99.99,
  },
  eventId: `${orderId}-pay-${paymentId}`,
});

// Ship order
yield* orders.send({
  id: orderId,
  event: {
    type: "ship",
    trackingNumber: "1Z999AA10123456784",
  },
});
```

### Example 2: Session Manager

Track user sessions with inactivity timeout.

```ts
const SessionEvent = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("start"),
    userId: Schema.String,
    deviceId: Schema.String,
    ip: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("activity"),
    path: Schema.String,
    timestamp: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.Literal("end"),
    reason: Schema.Literal("logout", "timeout", "revoked"),
  }),
);

const SessionState = Schema.Struct({
  sessionId: Schema.String,
  userId: Schema.String,
  deviceId: Schema.String,
  ip: Schema.String,
  startedAt: Schema.Number,
  lastActivityAt: Schema.Number,
  activityCount: Schema.Number,
  active: Schema.Boolean,
});

const sessionManager = Task.make({
  eventSchema: SessionEvent,
  stateSchema: SessionState,

  execute: (ctx) =>
    Effect.gen(function* () {
      const event = yield* ctx.event;
      const state = yield* ctx.state;
      const now = Date.now();

      if (state === null) {
        if (event.type !== "start") {
          console.warn("Session must start with 'start' event");
          return;
        }

        yield* ctx.setState({
          sessionId: ctx.instanceId,
          userId: event.userId,
          deviceId: event.deviceId,
          ip: event.ip,
          startedAt: now,
          lastActivityAt: now,
          activityCount: 0,
          active: true,
        });

        // Schedule inactivity check in 30 minutes
        yield* ctx.schedule(Duration.minutes(30));
        return;
      }

      if (!state.active) {
        console.warn("Session already ended");
        return;
      }

      switch (event.type) {
        case "start":
          // Session already started
          break;

        case "activity":
          yield* ctx.updateState(() => ({
            lastActivityAt: event.timestamp,
            activityCount: state.activityCount + 1,
          }));
          // Reset inactivity timer
          yield* ctx.schedule(Duration.minutes(30));
          break;

        case "end":
          yield* ctx.updateState(() => ({
            active: false,
          }));
          yield* ctx.cancelSchedule();
          // Purge session data after 24 hours
          yield* ctx.schedulePurge(Duration.hours(24));

          // Log session end
          yield* logSessionEnd(state.sessionId, event.reason, {
            duration: now - state.startedAt,
            activityCount: state.activityCount,
          });
          break;
      }
    }),

  onAlarm: (ctx) =>
    Effect.gen(function* () {
      if (ctx.isPurgeAlarm) return;

      const state = yield* ctx.state;
      if (!state || !state.active) return;

      const now = ctx.alarmFiredAt;
      const inactiveMs = now - state.lastActivityAt;

      // 30 minutes of inactivity = timeout
      if (inactiveMs >= Duration.toMillis(Duration.minutes(30))) {
        yield* ctx.updateState(() => ({ active: false }));
        yield* ctx.schedulePurge(Duration.hours(24));

        yield* logSessionEnd(state.sessionId, "timeout", {
          duration: now - state.startedAt,
          activityCount: state.activityCount,
        });
      } else {
        // Still active, check again
        yield* ctx.schedule(Duration.minutes(30));
      }
    }),
});
```

### Example 3: Subscription Billing

Manage subscription lifecycle with trial, billing, and expiration.

```ts
const SubscriptionEvent = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("create"),
    userId: Schema.String,
    planId: Schema.String,
    trialDays: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.Literal("activate"),
    paymentMethodId: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("renew"),
    paymentId: Schema.String,
    periodEnd: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.Literal("cancel"),
    reason: Schema.String,
    immediate: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("reactivate"),
  }),
);

const SubscriptionState = Schema.Struct({
  subscriptionId: Schema.String,
  userId: Schema.String,
  planId: Schema.String,
  status: Schema.Literal(
    "trial",
    "active",
    "past_due",
    "cancelled",
    "expired"
  ),
  paymentMethodId: Schema.NullOr(Schema.String),
  currentPeriodEnd: Schema.Number,
  cancelAtPeriodEnd: Schema.Boolean,
  createdAt: Schema.Number,
});

const subscriptionManager = Task.make({
  eventSchema: SubscriptionEvent,
  stateSchema: SubscriptionState,

  execute: (ctx) =>
    Effect.gen(function* () {
      const event = yield* ctx.event;
      const state = yield* ctx.state;
      const now = Date.now();

      if (state === null) {
        if (event.type !== "create") return;

        const trialEnd = now + event.trialDays * 24 * 60 * 60 * 1000;

        yield* ctx.setState({
          subscriptionId: ctx.instanceId,
          userId: event.userId,
          planId: event.planId,
          status: "trial",
          paymentMethodId: null,
          currentPeriodEnd: trialEnd,
          cancelAtPeriodEnd: false,
          createdAt: now,
        });

        // Schedule trial end check
        yield* ctx.schedule(trialEnd);

        yield* sendTrialWelcome(event.userId, event.trialDays);
        return;
      }

      switch (event.type) {
        case "activate":
          yield* ctx.updateState(() => ({
            status: "active",
            paymentMethodId: event.paymentMethodId,
          }));
          break;

        case "renew":
          yield* ctx.updateState(() => ({
            status: "active",
            currentPeriodEnd: event.periodEnd,
          }));
          // Schedule next billing check
          yield* ctx.schedule(event.periodEnd);
          break;

        case "cancel":
          if (event.immediate) {
            yield* ctx.updateState(() => ({
              status: "cancelled",
            }));
            yield* ctx.schedulePurge(Duration.days(30));
          } else {
            yield* ctx.updateState(() => ({
              cancelAtPeriodEnd: true,
            }));
          }
          yield* sendCancellationEmail(state.userId);
          break;

        case "reactivate":
          yield* ctx.updateState(() => ({
            cancelAtPeriodEnd: false,
          }));
          break;
      }
    }),

  onAlarm: (ctx) =>
    Effect.gen(function* () {
      if (ctx.isPurgeAlarm) return;

      const state = yield* ctx.state;
      if (!state) return;

      const now = ctx.alarmFiredAt;

      // Period ended
      if (now >= state.currentPeriodEnd) {
        if (state.cancelAtPeriodEnd) {
          // Cancel at period end
          yield* ctx.updateState(() => ({ status: "cancelled" }));
          yield* ctx.schedulePurge(Duration.days(30));
          return;
        }

        if (state.status === "trial") {
          if (state.paymentMethodId) {
            // Trial ended, has payment method - bill them
            const result = yield* attemptBilling(
              state.userId,
              state.paymentMethodId,
              state.planId
            );

            if (result.success) {
              yield* ctx.updateState(() => ({
                status: "active",
                currentPeriodEnd: result.periodEnd,
              }));
              yield* ctx.schedule(result.periodEnd);
            } else {
              yield* ctx.updateState(() => ({ status: "past_due" }));
              yield* ctx.schedule(Duration.days(3)); // Retry in 3 days
            }
          } else {
            // Trial ended, no payment method
            yield* ctx.updateState(() => ({ status: "expired" }));
            yield* ctx.schedulePurge(Duration.days(90));
            yield* sendTrialExpiredEmail(state.userId);
          }
          return;
        }

        if (state.status === "active" || state.status === "past_due") {
          // Try to bill
          const result = yield* attemptBilling(
            state.userId,
            state.paymentMethodId!,
            state.planId
          );

          if (result.success) {
            yield* ctx.updateState(() => ({
              status: "active",
              currentPeriodEnd: result.periodEnd,
            }));
            yield* ctx.schedule(result.periodEnd);
          } else {
            // Billing failed
            const retryCount = 3; // Would track this in state
            if (retryCount >= 3) {
              yield* ctx.updateState(() => ({ status: "expired" }));
              yield* ctx.schedulePurge(Duration.days(90));
              yield* sendSubscriptionExpiredEmail(state.userId);
            } else {
              yield* ctx.updateState(() => ({ status: "past_due" }));
              yield* ctx.schedule(Duration.days(3));
              yield* sendPaymentFailedEmail(state.userId);
            }
          }
        }
      }
    }),
});
```

---

## Comparison: Task vs Other Primitives

| Aspect | Task | Continuous | Buffer | Queue |
|--------|------|------------|--------|-------|
| **Trigger** | Events | Schedule | Events | Events |
| **State control** | Full manual | Automatic persist | Automatic purge | Per-event |
| **Schedule control** | Full manual | Automatic | None | None |
| **Purge control** | Full manual | Via stop() | Automatic | After process |
| **Complexity** | Highest | Medium | Medium | Medium |
| **Flexibility** | Maximum | Limited | Limited | Limited |
| **Use case** | Complex state machines | Polling, periodic | Batching | Job processing |

---

## When to Use Task

Use Task when you need:

1. **Full control over lifecycle** - You decide when to schedule, what state to keep, when to purge
2. **Complex state machines** - Multiple event types, conditional transitions
3. **Custom scheduling logic** - Dynamic schedules based on state
4. **Mixed patterns** - Sometimes batch, sometimes immediate, sometimes scheduled
5. **Building custom primitives** - Task is the foundation

Use other primitives when:
- **Continuous**: You just need periodic execution with persisted state
- **Buffer**: You want to batch events and flush periodically
- **Queue**: You want ordered processing with retry/dead-letter handling

---

## Type Inference Flow

```ts
// 1. Event schema defines event type
const MyEvent = Schema.Struct({
  type: Schema.String,
  data: Schema.Number,
});

// 2. State schema defines state type
const MyState = Schema.Struct({
  total: Schema.Number,
  count: Schema.Number,
});

// 3. Types flow through the API
const task = Task.make({
  eventSchema: MyEvent,
  stateSchema: MyState,

  execute: (ctx) =>
    Effect.gen(function* () {
      const event = yield* ctx.event;
      //    ^? { type: string; data: number }

      const state = yield* ctx.state;
      //    ^? { total: number; count: number } | null

      yield* ctx.setState({ total: 0, count: 0 });
      //                    ^? Must match MyState
    }),

  onAlarm: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.state;
      //    ^? { total: number; count: number } | null
    }),
});

// 4. Client send() is typed by eventSchema
yield* client.task("myTask").send({
  id: "123",
  event: { type: "add", data: 42 },
  //      ^? Must match MyEvent
});

// 5. getState() returns state type
const state = yield* client.task("myTask").getState("123");
//    ^? { total: number; count: number } | null | undefined
```

---

## Summary

| Feature | API |
|---------|-----|
| Define task | `Task.make({ eventSchema, execute })` |
| Optional state schema | `stateSchema: MyStateSchema` |
| Optional alarm handler | `onAlarm: (ctx) => ...` |
| Get event | `yield* ctx.event` |
| Check first event | `yield* ctx.isFirstEvent` |
| Get state | `yield* ctx.state` (returns `S | null`) |
| Set state | `yield* ctx.setState(newState)` |
| Update state | `yield* ctx.updateState((s) => ({ ... }))` |
| Schedule alarm | `yield* ctx.schedule("1 hour")` |
| Cancel alarm | `yield* ctx.cancelSchedule()` |
| Purge immediately | `yield* ctx.purge()` |
| Schedule purge | `yield* ctx.schedulePurge("30 days")` |
| Cancel purge | `yield* ctx.cancelPurge()` |
| Client - send event | `yield* client.task("name").send({ id, event })` |
| Client - get status | `yield* client.task("name").status(id)` |
| Client - get state | `yield* client.task("name").getState(id)` |
| Client - trigger alarm | `yield* client.task("name").trigger(id)` |
| Client - purge | `yield* client.task("name").purge(id)` |

The Task primitive prioritizes:
- **Maximum flexibility** (full control over state, schedule, purge)
- **Effect-native patterns** (generators, yieldable operations)
- **Type safety** (Schema-driven, full inference)
- **Clear lifecycle** (null state = first event)
- **Building block** (can implement other patterns with Task)
