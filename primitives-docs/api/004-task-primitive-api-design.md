# Task Primitive API Design

## Design Philosophy

The Task primitive provides **user-controlled durable state machines**. Unlike Continuous (schedule-driven) or Debounce (auto-flush), Task gives users complete control over the lifecycle:

1. **Effect-first** - All operations are Effects, yieldable in generators
2. **Schema-driven** - State and events are defined via Effect Schema
3. **User-controlled lifecycle** - No automatic scheduling or clearing
4. **Event + Alarm model** - Events mutate state, alarms trigger execution
5. **Stateful actors** - Think of Tasks as long-lived actors that respond to events

---

## Core Concept

A Task:
1. Persists state indefinitely (until manually cleared)
2. Receives events via `client.task("name").send({ id, event })`
3. Processes events in `onEvent` handler - can update state and schedule execution
4. Executes via `execute` when alarm fires (scheduled by user)
5. User decides when to clear state - nothing is automatic

**Key mental model**: A Task is a durable state machine that reacts to events and scheduled executions. You control when it runs and when it dies.

---

## Use Case Examples

Before diving into the API, here are the patterns Task enables:

### Pattern 1: Delayed Processing with State
Store data, wait, then process it with access to accumulated state.

```
Event arrives → Store in state → Schedule alarm for 1 hour
                                          ↓
                              Alarm fires → Execute with full state access
                                          ↓
                              Process, decide: schedule again or clear?
```

### Pattern 2: Stateful Retry with Backoff
Process something, on failure schedule retry with increasing delay.

```
Event arrives → Try to process
                     ↓
              Success? → Clear
              Failure? → Update state (retryCount++), schedule next attempt
```

### Pattern 3: Aggregation then Delivery
Collect events over time, then deliver when ready.

```
Events arrive → Accumulate in state → Schedule delivery window
                                            ↓
                              Window fires → Execute delivery
                                            ↓
                              More to send? → Schedule next window
                              Done? → Clear
```

### Pattern 4: User Activity Timeout
Track user activity, trigger action on inactivity.

```
Activity event → Update lastActivityAt → Schedule check in 30 min
                                               ↓
                              Check fires → User still inactive?
                                               ↓
                              Yes → Send reminder, schedule next check
                              No → User became active, already rescheduled
```

---

## API Overview

### Definition

```ts
import { Task } from "@durable-effect/jobs";
import { Schema, Effect, Duration } from "effect";

const orderProcessor = Task.make({
  stateSchema: Schema.Struct({
    orderId: Schema.String,
    status: Schema.Literal("pending", "processing", "shipped", "delivered"),
    retryCount: Schema.Number,
    lastError: Schema.NullOr(Schema.String),
    deliveryAttempts: Schema.Array(Schema.Struct({
      attemptedAt: Schema.Number,
      success: Schema.Boolean,
    })),
  }),

  eventSchema: Schema.Union(
    Schema.Struct({
      _tag: Schema.Literal("OrderPlaced"),
      orderId: Schema.String,
      items: Schema.Array(Schema.String),
    }),
    Schema.Struct({
      _tag: Schema.Literal("ShipmentUpdate"),
      trackingNumber: Schema.String,
      status: Schema.String,
    }),
    Schema.Struct({
      _tag: Schema.Literal("DeliveryConfirmed"),
      signature: Schema.String,
    }),
  ),

  // Called when an event is sent
  onEvent: (ctx) =>
    Effect.gen(function* () {
      const event = ctx.event;
      const state = ctx.state;

      switch (event._tag) {
        case "OrderPlaced": {
          // First event - initialize state
          yield* ctx.setState({
            orderId: event.orderId,
            status: "pending",
            retryCount: 0,
            lastError: null,
            deliveryAttempts: [],
          });
          // Schedule processing in 5 seconds
          yield* ctx.schedule(Duration.seconds(5));
          break;
        }

        case "ShipmentUpdate": {
          if (state === null) return; // Ignore if no state
          yield* ctx.updateState((s) => ({
            ...s,
            status: "shipped",
          }));
          // Schedule delivery check in 1 hour
          yield* ctx.schedule(Duration.hours(1));
          break;
        }

        case "DeliveryConfirmed": {
          if (state === null) return;
          yield* ctx.updateState((s) => ({
            ...s,
            status: "delivered",
          }));
          // Schedule cleanup in 24 hours
          yield* ctx.schedule(Duration.hours(24));
          break;
        }
      }
    }),

  // Called when alarm fires
  execute: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.state;
      if (state === null) return; // Safety check

      if (state.status === "pending") {
        // Try to process the order
        const result = yield* processOrder(state.orderId).pipe(
          Effect.either
        );

        if (result._tag === "Right") {
          yield* ctx.updateState((s) => ({
            ...s,
            status: "processing",
          }));
        } else {
          // Failed - schedule retry with backoff
          const nextRetry = state.retryCount + 1;
          if (nextRetry > 5) {
            // Too many retries - give up but keep state for debugging
            yield* ctx.updateState((s) => ({
              ...s,
              lastError: `Failed after ${nextRetry} attempts`,
            }));
            return; // No more scheduling
          }

          yield* ctx.updateState((s) => ({
            ...s,
            retryCount: nextRetry,
            lastError: String(result.left),
          }));
          // Exponential backoff
          yield* ctx.schedule(Duration.seconds(Math.pow(2, nextRetry)));
        }
      }

      if (state.status === "shipped") {
        // Check if delivered
        const delivered = yield* checkDeliveryStatus(state.orderId);
        if (!delivered) {
          // Not yet - check again in 1 hour
          yield* ctx.schedule(Duration.hours(1));
        }
        // If delivered, we'll get a DeliveryConfirmed event
      }

      if (state.status === "delivered") {
        // 24 hours after delivery - cleanup
        return yield* ctx.clear();
      }
    }),

  // Optional: called when execute/onEvent completes with no alarm scheduled
  onIdle: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.state;
      console.log(`Task ${ctx.instanceId} is now idle with state:`, state);
      // Could schedule a cleanup, send notification, etc.
    }),
});
```

### Registration & Export

```ts
import { createDurableJobs } from "@durable-effect/jobs";

const { Jobs, JobsClient } = createDurableJobs({
  orderProcessor,
  // ... other jobs
});

// Export DO class for Cloudflare
export { Jobs };
```

### Client Usage

```ts
// In your worker/handler
const client = JobsClient.fromBinding(env.PRIMITIVES);

// Send an event to a task
yield* client.task("orderProcessor").send({
  id: orderId,  // Instance ID
  event: {
    _tag: "OrderPlaced",
    orderId: orderId,
    items: ["item1", "item2"],
  },
});

// Get current state
const state = yield* client.task("orderProcessor").getState(orderId);

// Trigger execution manually (bypasses normal event flow)
yield* client.task("orderProcessor").trigger(orderId);

// Clear task immediately (delete all state + cancel alarms)
yield* client.task("orderProcessor").clear(orderId);
```

---

## Detailed API

### `Task.make(config)`

Creates a Task definition.

```ts
interface TaskConfig<
  S extends Schema.Schema.AnyNoContext,
  E extends Schema.Schema.AnyNoContext,
  Err,
  R
> {
  /**
   * Effect Schema defining the state shape.
   * State persists indefinitely until manually cleared.
   */
  readonly stateSchema: S;

  /**
   * Effect Schema defining the event shape.
   * Events sent via client.send() must match this schema.
   */
  readonly eventSchema: E;

  /**
   * Handler called for each incoming event.
   *
   * Responsibilities:
   * - Update state based on event
   * - Schedule next execution (if needed)
   *
   * If this handler doesn't schedule anything and no alarm is pending,
   * `onIdle` will be called (if defined).
   */
  readonly onEvent: (
    ctx: TaskEventContext<Schema.Schema.Type<S>, Schema.Schema.Type<E>>
  ) => Effect.Effect<void, Err, R>;

  /**
   * Handler called when alarm fires.
   *
   * Responsibilities:
   * - Process state
   * - Schedule next execution (if needed)
   * - Clear state (if task is complete)
   *
   * If this handler doesn't schedule anything and no alarm is pending,
   * `onIdle` will be called (if defined).
   */
  readonly execute: (
    ctx: TaskExecuteContext<Schema.Schema.Type<S>>
  ) => Effect.Effect<void, Err, R>;

  /**
   * Optional handler called when either `onEvent` or `execute` completes
   * and no alarm is scheduled.
   *
   * Use cases:
   * - Logging/debugging when task goes quiet
   * - Auto-scheduling a cleanup or timeout
   * - Sending notifications
   *
   * Note: If you schedule an alarm in this handler, it won't be called
   * again until the next idle state.
   */
  readonly onIdle?: (
    ctx: TaskIdleContext<Schema.Schema.Type<S>>
  ) => Effect.Effect<void, never, R>;

  /**
   * Optional error handler for execute/onEvent failures.
   * If not provided, errors are logged and task continues.
   */
  readonly onError?: (
    error: Err,
    ctx: TaskErrorContext<Schema.Schema.Type<S>>
  ) => Effect.Effect<void, never, R>;
}
```

### `TaskEventContext<S, E>`

Context provided to the `onEvent` handler.

```ts
interface TaskEventContext<S, E> {
  // -------------------------------------------------------------------------
  // Event Access
  // -------------------------------------------------------------------------

  /**
   * The incoming event (direct access, not Effect).
   */
  readonly event: E;

  // -------------------------------------------------------------------------
  // State Access
  // -------------------------------------------------------------------------

  /**
   * Get the current state.
   * Returns null if no state has been set yet (first event).
   */
  readonly state: S | null;

  /**
   * Replace the entire state.
   * State is validated against schema and persisted.
   */
  readonly setState: (state: S) => Effect.Effect<void, never, never>;

  /**
   * Update state via transformation function.
   * No-op if state is null (use setState for first event).
   */
  readonly updateState: (
    fn: (current: S) => S
  ) => Effect.Effect<void, never, never>;

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------

  /**
   * Schedule execute() to run at the specified time.
   *
   * @param when - Duration, Date, or timestamp
   *
   * Note: This REPLACES any existing scheduled alarm.
   * Only one alarm can be scheduled at a time.
   */
  readonly schedule: (
    when: Duration.DurationInput | number | Date
  ) => Effect.Effect<void, never, never>;

  /**
   * Cancel any scheduled execution.
   */
  readonly cancelSchedule: () => Effect.Effect<void, never, never>;

  /**
   * Get the currently scheduled execution time.
   * Returns null if no execution is scheduled.
   */
  readonly getScheduledTime: () => Effect.Effect<number | null, never, never>;

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  /**
   * Immediately clear all state and cancel alarms.
   * Returns Effect<never> - short-circuits execution.
   *
   * Use `return yield* ctx.clear()` to terminate processing.
   *
   * Note: This is the consistent API across all job types:
   * - Continuous: stop()
   * - Debounce: clear()
   * - WorkerPool: drain()
   * - Task: clear()
   */
  readonly clear: () => Effect.Effect<never, never, never>;

  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------

  /**
   * The unique instance ID for this task.
   */
  readonly instanceId: string;

  /**
   * The job name (as registered).
   */
  readonly jobName: string;

  /**
   * Timestamp when this event handler started executing.
   */
  readonly executionStartedAt: number;

  /**
   * Total events processed by this instance (including this one).
   */
  readonly eventCount: Effect.Effect<number, never, never>;

  /**
   * Timestamp when this instance was first created.
   */
  readonly createdAt: Effect.Effect<number, never, never>;

  /**
   * Whether this is the first event for this instance.
   * Convenience helper equivalent to `state === null`.
   */
  readonly isFirstEvent: boolean;
}
```

### `TaskExecuteContext<S>`

Context provided to the `execute` handler (when alarm fires).

```ts
interface TaskExecuteContext<S> {
  // -------------------------------------------------------------------------
  // State Access
  // -------------------------------------------------------------------------

  /**
   * Get the current state.
   * Returns null if no state has been set (edge case).
   */
  readonly state: Effect.Effect<S | null, never, never>;

  /**
   * Replace the entire state.
   */
  readonly setState: (state: S) => Effect.Effect<void, never, never>;

  /**
   * Update state via transformation function.
   */
  readonly updateState: (
    fn: (current: S) => S
  ) => Effect.Effect<void, never, never>;

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------

  /**
   * Schedule next execution.
   */
  readonly schedule: (
    when: Duration.DurationInput | number | Date
  ) => Effect.Effect<void, never, never>;

  /**
   * Cancel any scheduled execution.
   */
  readonly cancelSchedule: () => Effect.Effect<void, never, never>;

  /**
   * Get the currently scheduled execution time.
   */
  readonly getScheduledTime: () => Effect.Effect<number | null, never, never>;

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  /**
   * Immediately clear all state and cancel alarms.
   */
  readonly clear: () => Effect.Effect<never, never, never>;

  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------

  readonly instanceId: string;
  readonly jobName: string;
  readonly executionStartedAt: number;
  readonly eventCount: Effect.Effect<number, never, never>;
  readonly createdAt: Effect.Effect<number, never, never>;

  /**
   * Number of times execute has been called (1-indexed).
   */
  readonly executeCount: Effect.Effect<number, never, never>;
}
```

### `TaskIdleContext<S>`

Context provided to the `onIdle` handler.

```ts
interface TaskIdleContext<S> {
  /**
   * Get the current state.
   */
  readonly state: Effect.Effect<S | null, never, never>;

  /**
   * Schedule next execution (break out of idle).
   */
  readonly schedule: (
    when: Duration.DurationInput | number | Date
  ) => Effect.Effect<void, never, never>;

  /**
   * Immediately clear all state.
   */
  readonly clear: () => Effect.Effect<never, never, never>;

  // Metadata
  readonly instanceId: string;
  readonly jobName: string;

  /**
   * What triggered the idle state.
   */
  readonly idleReason: "onEvent" | "execute";
}
```

### `TaskErrorContext<S>`

Context provided to the `onError` handler.

```ts
interface TaskErrorContext<S> {
  /**
   * Get the current state.
   */
  readonly state: Effect.Effect<S | null, never, never>;

  /**
   * Update state (e.g., to record error).
   */
  readonly updateState: (
    fn: (current: S) => S
  ) => Effect.Effect<void, never, never>;

  /**
   * Schedule retry.
   */
  readonly schedule: (
    when: Duration.DurationInput | number | Date
  ) => Effect.Effect<void, never, never>;

  /**
   * Give up and clear.
   */
  readonly clear: () => Effect.Effect<never, never, never>;

  // Metadata
  readonly instanceId: string;
  readonly jobName: string;

  /**
   * Where the error occurred.
   */
  readonly errorSource: "onEvent" | "execute";
}
```

---

## Client API

### Getting a Task Client

```ts
const client = JobsClient.fromBinding(env.PRIMITIVES);
const orderClient = client.task("orderProcessor");
```

### `send(options)`

Send an event to a task instance.

```ts
interface TaskSendOptions<E> {
  /**
   * Unique identifier for this task instance.
   */
  readonly id: string;

  /**
   * The event to send. Must match eventSchema.
   */
  readonly event: E;
}

// Usage
const result = yield* orderClient.send({
  id: orderId,
  event: {
    _tag: "OrderPlaced",
    orderId: orderId,
    items: ["item1", "item2"],
  },
});

// Returns
interface TaskSendResponse {
  readonly _type: "task.send";
  readonly instanceId: string;
  readonly created: boolean;           // true if this created the instance
  readonly scheduledAt: number | null; // when execute will fire (if scheduled)
}
```

### `getState(id)`

Get the current state of a task instance.

```ts
const state = yield* orderClient.getState(orderId);
// state: OrderState | null | undefined
// null = instance exists but no state set
// undefined = instance doesn't exist

interface TaskGetStateResponse<S> {
  readonly _type: "task.getState";
  readonly instanceId: string;
  readonly state: S | null | undefined;
  readonly scheduledAt: number | null;
  readonly createdAt: number | undefined;
}
```

### `status(id)`

Get the status of a task instance.

```ts
const status = yield* orderClient.status(orderId);

interface TaskStatusResponse {
  readonly _type: "task.status";
  readonly status: "active" | "idle" | "not_found";
  readonly scheduledAt: number | null;  // null = no alarm scheduled (idle)
  readonly createdAt: number | undefined;
  readonly eventCount: number | undefined;
  readonly executeCount: number | undefined;
}
```

### `trigger(id)`

Manually trigger execution (bypasses normal scheduling).

```ts
yield* orderClient.trigger(orderId);

interface TaskTriggerResponse {
  readonly _type: "task.trigger";
  readonly instanceId: string;
  readonly triggered: boolean;  // false if instance doesn't exist
}
```

### `clear(id)`

Immediately clear a task instance (delete all state + cancel alarms).

```ts
yield* orderClient.clear(orderId);

interface TaskClearResponse {
  readonly _type: "task.clear";
  readonly instanceId: string;
  readonly cleared: boolean;  // false if instance didn't exist
}
```

---

## Complete Examples

### Example 1: Delayed Notification with Cancellation

A user can schedule a reminder, but can also cancel it before it fires.

```ts
const ReminderState = Schema.Struct({
  userId: Schema.String,
  message: Schema.String,
  scheduledFor: Schema.Number,
  cancelled: Schema.Boolean,
});

const ReminderEvent = Schema.Union(
  Schema.Struct({
    _tag: Schema.Literal("Schedule"),
    userId: Schema.String,
    message: Schema.String,
    delayMinutes: Schema.Number,
  }),
  Schema.Struct({
    _tag: Schema.Literal("Cancel"),
  }),
  Schema.Struct({
    _tag: Schema.Literal("Reschedule"),
    delayMinutes: Schema.Number,
  }),
);

const reminderTask = Task.make({
  stateSchema: ReminderState,
  eventSchema: ReminderEvent,

  onEvent: (ctx) =>
    Effect.gen(function* () {
      const event = ctx.event;

      switch (event._tag) {
        case "Schedule": {
          const scheduledFor = Date.now() + event.delayMinutes * 60 * 1000;
          yield* ctx.setState({
            userId: event.userId,
            message: event.message,
            scheduledFor,
            cancelled: false,
          });
          yield* ctx.schedule(scheduledFor);
          break;
        }

        case "Cancel": {
          if (ctx.state === null) return;
          yield* ctx.updateState((s) => ({ ...s, cancelled: true }));
          yield* ctx.cancelSchedule();
          // Schedule cleanup in 1 hour (keep for audit trail)
          yield* ctx.schedule(Duration.hours(1));
          break;
        }

        case "Reschedule": {
          if (ctx.state === null) return;
          const newTime = Date.now() + event.delayMinutes * 60 * 1000;
          yield* ctx.updateState((s) => ({
            ...s,
            scheduledFor: newTime,
            cancelled: false,
          }));
          yield* ctx.schedule(newTime);
          break;
        }
      }
    }),

  execute: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.state;
      if (state === null) return;

      if (state.cancelled) {
        // Cleanup time - clear everything
        return yield* ctx.clear();
      }

      // Send the reminder
      yield* sendPushNotification(state.userId, state.message);

      // Done - clear immediately
      return yield* ctx.clear();
    }),
});
```

**Client usage:**

```ts
// Schedule a reminder
yield* client.task("reminderTask").send({
  id: `reminder-${userId}-${Date.now()}`,
  event: {
    _tag: "Schedule",
    userId: userId,
    message: "Don't forget your meeting!",
    delayMinutes: 30,
  },
});

// Cancel it
yield* client.task("reminderTask").send({
  id: reminderId,
  event: { _tag: "Cancel" },
});
```

### Example 2: Rate-Limited API Caller with Retry

Call an external API with rate limiting and automatic retry on failure.

```ts
const ApiCallState = Schema.Struct({
  endpoint: Schema.String,
  payload: Schema.Unknown,
  attempts: Schema.Number,
  maxAttempts: Schema.Number,
  lastError: Schema.NullOr(Schema.String),
  lastAttemptAt: Schema.NullOr(Schema.Number),
  completedAt: Schema.NullOr(Schema.Number),
  result: Schema.NullOr(Schema.Unknown),
});

const ApiCallEvent = Schema.Union(
  Schema.Struct({
    _tag: Schema.Literal("Create"),
    endpoint: Schema.String,
    payload: Schema.Unknown,
    maxAttempts: Schema.optional(Schema.Number, { default: () => 3 }),
  }),
  Schema.Struct({
    _tag: Schema.Literal("ForceRetry"),
  }),
);

const apiCallerTask = Task.make({
  stateSchema: ApiCallState,
  eventSchema: ApiCallEvent,

  onEvent: (ctx) =>
    Effect.gen(function* () {
      const event = ctx.event;

      switch (event._tag) {
        case "Create": {
          yield* ctx.setState({
            endpoint: event.endpoint,
            payload: event.payload,
            attempts: 0,
            maxAttempts: event.maxAttempts ?? 3,
            lastError: null,
            lastAttemptAt: null,
            completedAt: null,
            result: null,
          });
          // Start immediately
          yield* ctx.schedule(Duration.millis(0));
          break;
        }

        case "ForceRetry": {
          if (ctx.state === null) return;
          yield* ctx.updateState((s) => ({
            ...s,
            attempts: 0,
            lastError: null,
            completedAt: null,
            result: null,
          }));
          yield* ctx.schedule(Duration.millis(0));
          break;
        }
      }
    }),

  execute: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.state;
      if (state === null) return;

      const attemptNumber = state.attempts + 1;

      yield* ctx.updateState((s) => ({
        ...s,
        attempts: attemptNumber,
        lastAttemptAt: Date.now(),
      }));

      // Try the API call
      const result = yield* Effect.tryPromise(() =>
        fetch(state.endpoint, {
          method: "POST",
          body: JSON.stringify(state.payload),
        }).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
      ).pipe(Effect.either);

      if (result._tag === "Right") {
        // Success!
        yield* ctx.updateState((s) => ({
          ...s,
          completedAt: Date.now(),
          result: result.right,
          lastError: null,
        }));
        // Keep state for 7 days then clear
        yield* ctx.schedule(Duration.days(7));
      } else {
        // Failed
        const error = String(result.left);
        yield* ctx.updateState((s) => ({
          ...s,
          lastError: error,
        }));

        if (attemptNumber >= state.maxAttempts) {
          // No more retries - keep state for debugging
          console.error(`API call failed after ${attemptNumber} attempts: ${error}`);
          // Don't schedule anything - goes idle
        } else {
          // Exponential backoff: 1s, 2s, 4s, 8s, ...
          const delay = Math.pow(2, attemptNumber - 1) * 1000;
          yield* ctx.schedule(Duration.millis(delay));
        }
      }
    }),

  onIdle: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.state;
      if (state === null) return;

      if (state.completedAt === null && state.lastError !== null) {
        // Failed and exhausted retries - notify someone
        yield* notifyOperations({
          taskId: ctx.instanceId,
          endpoint: state.endpoint,
          error: state.lastError,
          attempts: state.attempts,
        });
      }

      if (state.completedAt !== null) {
        // 7 days after completion - cleanup
        return yield* ctx.clear();
      }
    }),
});
```

### Example 3: Session Activity Tracker

Track user session activity and trigger actions on idle timeout.

```ts
const SessionState = Schema.Struct({
  userId: Schema.String,
  sessionId: Schema.String,
  startedAt: Schema.Number,
  lastActivityAt: Schema.Number,
  activityCount: Schema.Number,
  idleWarnings: Schema.Number,
  terminated: Schema.Boolean,
});

const SessionEvent = Schema.Union(
  Schema.Struct({
    _tag: Schema.Literal("Start"),
    userId: Schema.String,
    sessionId: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal("Activity"),
  }),
  Schema.Struct({
    _tag: Schema.Literal("End"),
  }),
);

const IDLE_TIMEOUT = Duration.minutes(15);
const MAX_IDLE_WARNINGS = 2;

const sessionTracker = Task.make({
  stateSchema: SessionState,
  eventSchema: SessionEvent,

  onEvent: (ctx) =>
    Effect.gen(function* () {
      const event = ctx.event;
      const now = Date.now();

      switch (event._tag) {
        case "Start": {
          yield* ctx.setState({
            userId: event.userId,
            sessionId: event.sessionId,
            startedAt: now,
            lastActivityAt: now,
            activityCount: 0,
            idleWarnings: 0,
            terminated: false,
          });
          // Schedule idle check
          yield* ctx.schedule(IDLE_TIMEOUT);
          break;
        }

        case "Activity": {
          if (ctx.state === null) return;
          yield* ctx.updateState((s) => ({
            ...s,
            lastActivityAt: now,
            activityCount: s.activityCount + 1,
            idleWarnings: 0, // Reset warnings on activity
          }));
          // Reset idle timer
          yield* ctx.schedule(IDLE_TIMEOUT);
          break;
        }

        case "End": {
          if (ctx.state === null) return;
          yield* ctx.updateState((s) => ({
            ...s,
            terminated: true,
          }));
          // Log session and schedule cleanup in 1 hour
          yield* logSessionEnd(ctx.state);
          yield* ctx.schedule(Duration.hours(1));
          break;
        }
      }
    }),

  execute: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.state;
      if (state === null) return;

      // If terminated, clean up
      if (state.terminated) {
        return yield* ctx.clear();
      }

      const now = Date.now();
      const idleTime = now - state.lastActivityAt;
      const idleMinutes = Duration.toMinutes(Duration.millis(idleTime));

      if (idleMinutes >= Duration.toMinutes(IDLE_TIMEOUT)) {
        // User is idle
        const warnings = state.idleWarnings + 1;

        if (warnings > MAX_IDLE_WARNINGS) {
          // Too many warnings - terminate session
          yield* ctx.updateState((s) => ({ ...s, terminated: true }));
          yield* terminateSession(state.sessionId);
          yield* notifyUser(state.userId, "Your session was terminated due to inactivity");
          yield* ctx.schedule(Duration.hours(1)); // Cleanup later
        } else {
          // Send warning
          yield* ctx.updateState((s) => ({ ...s, idleWarnings: warnings }));
          yield* notifyUser(state.userId, `Your session will expire in ${(MAX_IDLE_WARNINGS - warnings + 1) * 15} minutes`);
          // Check again in 15 minutes
          yield* ctx.schedule(IDLE_TIMEOUT);
        }
      } else {
        // User wasn't idle long enough (edge case: activity after schedule but before execute)
        const remainingIdle = Duration.toMillis(IDLE_TIMEOUT) - idleTime;
        yield* ctx.schedule(Duration.millis(remainingIdle));
      }
    }),
});
```

**Client usage:**

```ts
// Start session
yield* client.task("sessionTracker").send({
  id: sessionId,
  event: { _tag: "Start", userId, sessionId },
});

// Record activity (called frequently)
yield* client.task("sessionTracker").send({
  id: sessionId,
  event: { _tag: "Activity" },
});

// End session (user logs out)
yield* client.task("sessionTracker").send({
  id: sessionId,
  event: { _tag: "End" },
});
```

### Example 4: Order Fulfillment State Machine

Complex state machine for order processing with multiple stages.

```ts
const OrderState = Schema.Struct({
  orderId: Schema.String,
  customerId: Schema.String,
  items: Schema.Array(Schema.String),
  status: Schema.Literal(
    "created",
    "payment_pending",
    "payment_confirmed",
    "preparing",
    "shipped",
    "delivered",
    "cancelled"
  ),
  paymentId: Schema.NullOr(Schema.String),
  trackingNumber: Schema.NullOr(Schema.String),
  timeline: Schema.Array(Schema.Struct({
    status: Schema.String,
    timestamp: Schema.Number,
  })),
  cleanupAt: Schema.NullOr(Schema.Number),
});

const OrderEvent = Schema.Union(
  Schema.Struct({
    _tag: Schema.Literal("Created"),
    orderId: Schema.String,
    customerId: Schema.String,
    items: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    _tag: Schema.Literal("PaymentReceived"),
    paymentId: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal("PaymentFailed"),
    reason: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal("Shipped"),
    trackingNumber: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal("Delivered"),
  }),
  Schema.Struct({
    _tag: Schema.Literal("Cancelled"),
    reason: Schema.String,
  }),
);

const addTimeline = (state: OrderState, status: string): OrderState => ({
  ...state,
  timeline: [...state.timeline, { status, timestamp: Date.now() }],
});

const orderFulfillment = Task.make({
  stateSchema: OrderState,
  eventSchema: OrderEvent,

  onEvent: (ctx) =>
    Effect.gen(function* () {
      const event = ctx.event;
      const now = Date.now();

      switch (event._tag) {
        case "Created": {
          yield* ctx.setState({
            orderId: event.orderId,
            customerId: event.customerId,
            items: event.items,
            status: "created",
            paymentId: null,
            trackingNumber: null,
            timeline: [{ status: "created", timestamp: now }],
            cleanupAt: null,
          });
          // Schedule payment timeout check (cancel if no payment in 1 hour)
          yield* ctx.schedule(Duration.hours(1));
          break;
        }

        case "PaymentReceived": {
          if (ctx.state === null) return;
          yield* ctx.updateState((s) =>
            addTimeline({ ...s, status: "payment_confirmed", paymentId: event.paymentId }, "payment_confirmed")
          );
          // Cancel timeout, schedule fulfillment
          yield* ctx.schedule(Duration.seconds(5)); // Start fulfillment
          break;
        }

        case "PaymentFailed": {
          if (ctx.state === null) return;
          yield* ctx.updateState((s) => ({
            ...addTimeline({ ...s, status: "cancelled" }, `payment_failed: ${event.reason}`),
            cleanupAt: now + Duration.toMillis(Duration.days(30)),
          }));
          yield* ctx.schedule(Duration.days(30)); // Cleanup later
          break;
        }

        case "Shipped": {
          if (ctx.state === null) return;
          yield* ctx.updateState((s) =>
            addTimeline({ ...s, status: "shipped", trackingNumber: event.trackingNumber }, "shipped")
          );
          // Schedule delivery check in 24 hours
          yield* ctx.schedule(Duration.hours(24));
          break;
        }

        case "Delivered": {
          if (ctx.state === null) return;
          const cleanupTime = now + Duration.toMillis(Duration.days(90));
          yield* ctx.updateState((s) => ({
            ...addTimeline({ ...s, status: "delivered" }, "delivered"),
            cleanupAt: cleanupTime,
          }));
          // Keep record for 90 days
          yield* ctx.schedule(Duration.days(90));
          break;
        }

        case "Cancelled": {
          if (ctx.state === null) return;
          if (ctx.state.status === "shipped" || ctx.state.status === "delivered") {
            // Can't cancel shipped/delivered orders
            return;
          }
          yield* ctx.updateState((s) => ({
            ...addTimeline({ ...s, status: "cancelled" }, `cancelled: ${event.reason}`),
            cleanupAt: now + Duration.toMillis(Duration.days(30)),
          }));
          yield* ctx.schedule(Duration.days(30));
          break;
        }
      }
    }),

  execute: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.state;
      if (state === null) return;

      // Check if it's cleanup time
      if (state.cleanupAt !== null && Date.now() >= state.cleanupAt) {
        return yield* ctx.clear();
      }

      switch (state.status) {
        case "created": {
          // Payment timeout - cancel order
          yield* ctx.updateState((s) => ({
            ...addTimeline({ ...s, status: "cancelled" }, "payment_timeout"),
            cleanupAt: Date.now() + Duration.toMillis(Duration.days(30)),
          }));
          yield* notifyCustomer(state.customerId, "Your order was cancelled due to payment timeout");
          yield* ctx.schedule(Duration.days(30));
          break;
        }

        case "payment_confirmed": {
          // Start preparing
          yield* ctx.updateState((s) =>
            addTimeline({ ...s, status: "preparing" }, "preparing")
          );
          yield* startFulfillment(state.orderId, state.items);
          // Fulfillment will send Shipped event when done
          break;
        }

        case "shipped": {
          // Check delivery status
          const delivered = yield* checkDeliveryStatus(state.trackingNumber!);
          if (delivered) {
            const cleanupTime = Date.now() + Duration.toMillis(Duration.days(90));
            yield* ctx.updateState((s) => ({
              ...addTimeline({ ...s, status: "delivered" }, "delivered"),
              cleanupAt: cleanupTime,
            }));
            yield* ctx.schedule(Duration.days(90));
          } else {
            // Not delivered yet - check again in 24 hours
            yield* ctx.schedule(Duration.hours(24));
          }
          break;
        }
      }
    }),
});
```

---

## Lifecycle Diagram

```
                     ┌─────────────────────────────────────────────────────┐
                     │                       TASK                          │
                     └─────────────────────────────────────────────────────┘

  Client                          Task Instance                        State
    │                                  │                                 │
    │   send(event)                    │                                 │
    ├─────────────────────────────────►│                                 │
    │                                  │  onEvent(ctx)                   │
    │                                  ├────────────────────────────────►│
    │                                  │  ctx.setState(...)              │
    │                                  │  ctx.schedule(5 min)            │
    │                                  │◄────────────────────────────────┤
    │                                  │                                 │
    │                          [5 min passes]                            │
    │                                  │                                 │
    │                          alarm fires                               │
    │                                  │  execute(ctx)                   │
    │                                  ├────────────────────────────────►│
    │                                  │  state = ctx.state              │
    │                                  │  ctx.updateState(...)           │
    │                                  │  ctx.schedule(1 hour)           │
    │                                  │◄────────────────────────────────┤
    │                                  │                                 │
    │   send(event)                    │                                 │
    ├─────────────────────────────────►│                                 │
    │                                  │  onEvent(ctx)                   │
    │                                  ├────────────────────────────────►│
    │                                  │  // event cancels alarm         │
    │                                  │  ctx.cancelSchedule()           │
    │                                  │  // no alarm scheduled          │
    │                                  │◄────────────────────────────────┤
    │                                  │                                 │
    │                                  │  onIdle(ctx)  // optional       │
    │                                  │                                 │
    │   send(event)                    │                                 │
    ├─────────────────────────────────►│                                 │
    │                                  │  onEvent(ctx)                   │
    │                                  │  ctx.clear()                    │
    │                                  │                                 │
    │                         [STATE DELETED]                            │
    │                                  │                                 │
```

---

## Comparison: Task vs Other Primitives

| Aspect | Task | Continuous | Debounce | WorkerPool |
|--------|------|------------|----------|-------|
| **Primary trigger** | Events + Manual scheduling | Schedule (cron/interval) | Time/count threshold | Each event |
| **State lifecycle** | User-controlled (clear) | Persisted until stop() | Cleared after execute | No state |
| **Alarm management** | Manual (schedule/cancel) | Automatic (from config) | Automatic (flushAfter) | Automatic |
| **Execute timing** | When user schedules | On schedule | When buffer flushes | Per event |
| **Event handling** | onEvent → can schedule | N/A | onEvent → accumulate | execute per event |
| **Idle detection** | Yes (onIdle) | N/A | N/A | onEmpty |
| **Cleanup API** | clear() | stop() | clear() | drain() |
| **Use case** | State machines, delayed processing | Polling, periodic tasks | Batching, debouncing | Job processing |

---

## Implementation Notes

### Internal State Keys

```ts
// Stored alongside user state
interface TaskInternalState {
  readonly eventCount: number;
  readonly executeCount: number;
  readonly createdAt: number;
}
```

### Alarm Handling

Task uses a single alarm slot (Durable Object constraint). The alarm always triggers the `execute` handler. Users who want delayed cleanup should:

1. Store a `cleanupAt` timestamp in state
2. Check in `execute` if `Date.now() >= cleanupAt`
3. Call `ctx.clear()` when ready

This pattern is explicit and avoids confusion about multiple alarm types.

### Event Processing

```ts
// Pseudocode for onEvent processing
handleEvent(request):
  1. Validate event against schema
  2. Load state (null if first event)
  3. Create TaskEventContext
  4. Run onEvent handler
  5. If no alarm scheduled after handler:
     a. Run onIdle handler (if defined)
  6. Persist any state changes
```

### Concurrency Safety

Within a single DO instance, operations are serialized by the Cloudflare runtime. However, when designing Tasks:

- Multiple events can arrive rapidly - `onEvent` should be fast
- `execute` should be the place for long-running operations
- State updates within a handler are batched and persisted atomically

---

## Summary

| Feature | API |
|---------|-----|
| Define task | `Task.make({ stateSchema, eventSchema, onEvent, execute })` |
| Event handler | `onEvent: (ctx) => Effect<void>` |
| Execute handler | `execute: (ctx) => Effect<void>` |
| Idle handler | `onIdle?: (ctx) => Effect<void>` |
| Error handler | `onError?: (error, ctx) => Effect<void>` |
| State - get | `ctx.state` (onEvent) or `yield* ctx.state` (execute) |
| State - set | `yield* ctx.setState(newState)` |
| State - update | `yield* ctx.updateState((s) => ({ ...s, ... }))` |
| Schedule execute | `yield* ctx.schedule(Duration.hours(1))` |
| Cancel schedule | `yield* ctx.cancelSchedule()` |
| Get scheduled time | `yield* ctx.getScheduledTime()` |
| Clear immediately | `return yield* ctx.clear()` |
| Client - send event | `yield* client.task("name").send({ id, event })` |
| Client - get state | `yield* client.task("name").getState(id)` |
| Client - status | `yield* client.task("name").status(id)` |
| Client - trigger | `yield* client.task("name").trigger(id)` |
| Client - clear | `yield* client.task("name").clear(id)` |

The Task primitive prioritizes:
- **User control** - You decide when to execute and when to clear
- **Event-driven** - React to external events with full state access
- **State machine friendly** - Natural fit for complex state transitions
- **Effect-native** - Generators, yieldable operations, schema validation
- **Durable** - State persists until you explicitly remove it
- **Simple** - One alarm, explicit cleanup via schedule + clear pattern
