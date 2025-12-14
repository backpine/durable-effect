# Continuous Primitive API Design

## Design Philosophy

The Continuous primitive should feel native to Effect users and mirror the DX patterns established in `@durable-effect/workflow`. Key principles:

1. **Effect-first** - All operations are Effects, yieldable in generators
2. **Schema-driven** - State is defined via Effect Schema for validation and serialization
3. **Idempotent by default** - Client operations use IDs to ensure exactly-once semantics
4. **Minimal boilerplate** - No manual state initialization; the system handles it

---

## API Overview

### Definition

```ts
import { Continuous } from "@durable-effect/primitives";
import { Schema } from "effect";

const tokenRefresher = Continuous.make({
  stateSchema: Schema.Struct({
    accessToken: Schema.NullOr(Schema.String),
    refreshToken: Schema.String,
    expiresAt: Schema.Number,
    userId: Schema.String,
  }),

  schedule: Continuous.every("30 minutes"),

  startImmediately: true,

  execute: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.state;

      // Do work
      const result = yield* refreshAccessToken(state.refreshToken);

      // Update state for next run
      yield* ctx.setState({
        ...state,
        accessToken: result.accessToken,
        expiresAt: Date.now() + result.expiresIn * 1000,
      });

      // Optionally override next schedule
      const nextRefresh = result.expiresIn * 1000 - 5 * 60 * 1000;
      yield* ctx.schedule(nextRefresh);
    }),
});
```

### Registration & Export

```ts
import { createDurablePrimitives } from "@durable-effect/primitives";

const { Primitives, PrimitivesClient } = createDurablePrimitives({
  tokenRefresher,
  // ... other primitives
});

// Export DO class for Cloudflare
export { Primitives };
```

### Client Usage

```ts
// In your worker/handler
const client = PrimitivesClient.fromBinding(env.PRIMITIVES);

// Start a continuous process (idempotent)
yield* client.continuous("tokenRefresher").start({
  id: userId,  // Idempotency key - same ID = same instance
  input: {
    refreshToken: "rt_abc123",
    userId: userId,
    accessToken: null,
    expiresAt: 0,
  },
});
```

---

## Detailed API

### `Continuous.make(config)`

Creates a Continuous definition.

```ts
interface ContinuousConfig<S extends Schema.Schema.AnyNoContext, E, R> {
  /**
   * Effect Schema defining the state shape.
   * Used for validation and serialization.
   */
  readonly stateSchema: S;

  /**
   * Schedule configuration for when to run.
   */
  readonly schedule: ContinuousSchedule;

  /**
   * Whether to execute immediately when started, or wait for first scheduled time.
   * @default true
   */
  readonly startImmediately?: boolean;

  /**
   * The execution effect, called on each alarm.
   */
  readonly execute: (
    ctx: ContinuousContext<Schema.Schema.Type<S>>
  ) => Effect.Effect<void, E, R>;

  /**
   * Optional error handler for execution failures.
   * If not provided, errors are logged and process continues on schedule.
   */
  readonly onError?: (
    error: E,
    ctx: ContinuousContext<Schema.Schema.Type<S>>
  ) => Effect.Effect<void, never, R>;
}
```

### `ContinuousContext<S>`

The context provided to the `execute` function.

```ts
interface ContinuousContext<S> {
  /**
   * Current state value (synchronous access).
   */
  readonly state: S;

  /**
   * Replace the entire state.
   * State is marked dirty and persisted after execution completes.
   */
  readonly setState: (state: S) => void;

  /**
   * Update state via transformation function.
   * State is marked dirty and persisted after execution completes.
   */
  readonly updateState: (fn: (current: S) => S) => void;

  /**
   * The unique instance ID for this primitive instance.
   */
  readonly instanceId: string;

  /**
   * The number of times execute has been called (1-indexed).
   */
  readonly runCount: number;

  /**
   * The name of this primitive (as registered).
   */
  readonly primitiveName: string;

  // -------------------------------------------------------------------------
  // Lifecycle Control (NEW)
  // -------------------------------------------------------------------------

  /**
   * Terminate this primitive instance.
   *
   * Options:
   * - `purgeState: true` (default) - Delete all stored state
   * - `purgeState: false` - Keep state for potential restart
   * - `reason` - Optional reason for termination (stored in metadata)
   *
   * When called, the primitive will:
   * 1. Cancel any scheduled alarm
   * 2. Update status to "stopped" (or "terminated" if purging)
   * 3. Optionally purge all state from storage
   * 4. Short-circuit the current execution (no further code runs)
   *
   * @example
   * ```ts
   * execute: (ctx) => Effect.gen(function* () {
   *   if (ctx.state.failureCount > 10) {
   *     // Terminate and purge - too many failures
   *     return yield* ctx.terminate({
   *       reason: "Too many failures",
   *       purgeState: true
   *     });
   *   }
   *
   *   if (ctx.state.expiresAt < Date.now()) {
   *     // Stop but keep state for debugging
   *     return yield* ctx.terminate({
   *       reason: "Token expired",
   *       purgeState: false
   *     });
   *   }
   * })
   * ```
   */
  readonly terminate: (options?: {
    readonly reason?: string;
    readonly purgeState?: boolean; // default: true
  }) => Effect.Effect<never, never, never>;

  // -------------------------------------------------------------------------
  // Schedule Control (Future Enhancement)
  // -------------------------------------------------------------------------

  /**
   * Override the next scheduled execution time.
   * Accepts Duration or absolute timestamp.
   *
   * @example
   * ```ts
   * // Schedule next run in 5 minutes
   * yield* ctx.reschedule("5 minutes");
   *
   * // Schedule at specific time
   * yield* ctx.reschedule(Date.now() + 3600000);
   * ```
   */
  readonly reschedule?: (
    when: Duration.DurationInput | number
  ) => Effect.Effect<void, never, never>;
}
```

#### Terminate Behavior

The `terminate` method provides graceful shutdown from within the execute function:

| Option | Behavior |
|--------|----------|
| `purgeState: true` (default) | Deletes all state keys, sets status to "terminated" |
| `purgeState: false` | Keeps state intact, sets status to "stopped" |

**Important**: `terminate()` returns `Effect<never>` - it short-circuits execution. After calling terminate, no further code in the execute function will run. Always use `return yield* ctx.terminate(...)`.

```ts
// CORRECT - return the terminate effect
if (shouldStop) {
  return yield* ctx.terminate({ reason: "Done" });
}

// INCORRECT - terminate won't stop execution without return
if (shouldStop) {
  yield* ctx.terminate({ reason: "Done" }); // Code below still runs!
}
doMoreWork(); // This will execute!
```

### Schedule Configuration

```ts
// Fixed interval - runs every N after each completion
Continuous.every("30 minutes")
Continuous.every(Duration.minutes(30))

// Cron expression - runs at specific times
Continuous.cron("0 */6 * * *")  // Every 6 hours
Continuous.cron("0 9 * * MON-FRI")  // 9am weekdays

// Using Effect Schedule (advanced)
Continuous.schedule(
  Schedule.spaced(Duration.minutes(30))
)
```

```ts
type ContinuousSchedule =
  | { readonly _tag: "Every"; readonly interval: Duration.Duration }
  | { readonly _tag: "Cron"; readonly expression: string }
  | { readonly _tag: "Schedule"; readonly schedule: Schedule.Schedule<unknown, unknown> };

const Continuous = {
  every: (interval: Duration.DurationInput): ContinuousSchedule => ({
    _tag: "Every",
    interval: Duration.decode(interval),
  }),

  cron: (expression: string): ContinuousSchedule => ({
    _tag: "Cron",
    expression,
  }),

  schedule: <Out, In>(schedule: Schedule.Schedule<Out, In>): ContinuousSchedule => ({
    _tag: "Schedule",
    schedule,
  }),
};
```

---

## Client API

### Getting a Continuous Client

```ts
const client = PrimitivesClient.fromBinding(env.PRIMITIVES);
const tokenClient = client.continuous("tokenRefresher");
```

### `start(options)`

Start a continuous process. **Idempotent** - calling with the same `id` returns the existing instance.

```ts
interface ContinuousStartOptions<S> {
  /**
   * Unique identifier for this instance.
   * Used for idempotency - same ID = same instance.
   */
  readonly id: string;

  /**
   * Initial state input. Must match the stateSchema.
   * Only used if this is a new instance.
   */
  readonly input: S;
}

// Usage
const result = yield* tokenClient.start({
  id: "user-123",
  input: {
    refreshToken: "rt_abc",
    userId: "user-123",
    accessToken: null,
    expiresAt: 0,
  },
});

// Returns
interface ContinuousStartResult {
  readonly instanceId: string;
  readonly created: boolean;  // false if already existed
  readonly status: ContinuousStatus;
}
```

### `stop(id, options?)`

Stop a continuous process and purge its state.

```ts
const result = yield* tokenClient.stop("user-123", {
  reason: "User logged out",
});

// Returns
interface ContinuousStopResult {
  readonly stopped: boolean;
  readonly reason?: string;
}
```

### `status(id)`

Get the current status of a continuous process.

```ts
const status = yield* tokenClient.status("user-123");

type ContinuousStatus =
  | { readonly _tag: "Running"; readonly nextRunAt: number; readonly runCount: number }
  | { readonly _tag: "Stopped"; readonly stoppedAt: number; readonly reason?: string }
  | { readonly _tag: "NotFound" };
```

### `getState(id)`

Get the current state (typed by schema).

```ts
const state = yield* tokenClient.getState("user-123");
// state: { accessToken: string | null, refreshToken: string, ... } | undefined
```

### `trigger(id)`

Trigger immediate execution (bypasses schedule).

```ts
yield* tokenClient.trigger("user-123");
```

---

## Complete Examples

### Example 1: Token Refresher

```ts
import { Continuous } from "@durable-effect/primitives";
import { Effect, Schema, Duration } from "effect";

// Define state schema
const TokenState = Schema.Struct({
  accessToken: Schema.NullOr(Schema.String),
  refreshToken: Schema.String,
  expiresAt: Schema.Number,
  userId: Schema.String,
  failureCount: Schema.optional(Schema.Number, { default: () => 0 }),
});

type TokenState = Schema.Schema.Type<typeof TokenState>;

// Define the continuous process
const tokenRefresher = Continuous.make({
  stateSchema: TokenState,

  schedule: Continuous.every("55 minutes"),

  startImmediately: true,

  execute: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.state;

      // Refresh the token
      const result = yield* Effect.tryPromise(() =>
        fetch("/oauth/token", {
          method: "POST",
          body: JSON.stringify({ refresh_token: state.refreshToken }),
        }).then((r) => r.json())
      );

      if (result.error === "token_revoked") {
        return yield* ctx.terminate({ reason: "Token was revoked by user" });
      }

      // Update state
      yield* ctx.setState({
        ...state,
        accessToken: result.access_token,
        expiresAt: Date.now() + result.expires_in * 1000,
        failureCount: 0,
      });

      // Store token where other services can access it
      yield* saveTokenToKV(state.userId, result.access_token);

      // Schedule next refresh 5 minutes before expiry
      const nextRefresh = result.expires_in * 1000 - 5 * 60 * 1000;
      yield* ctx.schedule(Duration.millis(nextRefresh));
    }),

  onError: (error, ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.state;
      const failures = (state.failureCount ?? 0) + 1;

      yield* ctx.updateState((s) => ({ failureCount: failures }));

      if (failures >= 5) {
        return yield* ctx.terminate({
          reason: "Too many consecutive failures",
          purgeState: false // Keep state for debugging
        });
      }

      // Exponential backoff on failure
      const backoff = Math.min(30 * 60 * 1000, 1000 * Math.pow(2, failures));
      yield* ctx.schedule(Duration.millis(backoff));
    }),
});
```

**Client usage:**

```ts
export default {
  async fetch(request: Request, env: Env) {
    const client = PrimitivesClient.fromBinding(env.PRIMITIVES);

    // Start token refresh for a user (idempotent)
    const result = await Effect.runPromise(
      client.continuous("tokenRefresher").start({
        id: userId,
        input: {
          refreshToken: refreshToken,
          userId: userId,
          accessToken: null,
          expiresAt: 0,
        },
      })
    );

    return new Response(JSON.stringify(result));
  },
};
```

### Example 2: Drip Campaign Messenger

```ts
const CampaignState = Schema.Struct({
  userId: Schema.String,
  campaignId: Schema.String,
  stage: Schema.Literal("day1", "day3", "day7", "day14", "complete"),
  messagesDelivered: Schema.Array(Schema.String),
  startedAt: Schema.Number,
  lastInteraction: Schema.NullOr(Schema.Number),
});

type CampaignState = Schema.Schema.Type<typeof CampaignState>;

const stageConfig = {
  day1: { delay: Duration.days(1), next: "day3" },
  day3: { delay: Duration.days(2), next: "day7" },
  day7: { delay: Duration.days(4), next: "day14" },
  day14: { delay: Duration.days(7), next: "complete" },
  complete: null,
} as const;

const dripCampaign = Continuous.make({
  stateSchema: CampaignState,

  schedule: Continuous.every("1 day"),  // Default, overridden per stage

  startImmediately: false,  // Wait for first scheduled time

  execute: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.state;
      const runCount = yield* ctx.runCount;

      // Check if campaign is complete
      if (state.stage === "complete") {
        return yield* ctx.terminate({ reason: "Campaign completed" });
      }

      // Check if user has interacted recently (pause campaign)
      if (state.lastInteraction && Date.now() - state.lastInteraction < Duration.toMillis(Duration.days(1))) {
        // User is engaged, skip this message and check tomorrow
        yield* ctx.schedule(Duration.days(1));
        return;
      }

      // Get message for current stage
      const message = yield* getMessageForStage(state.campaignId, state.stage);

      // Send message
      yield* sendEmail(state.userId, message);

      // Advance to next stage
      const config = stageConfig[state.stage];
      if (!config) {
        return yield* ctx.terminate({ reason: "Campaign completed" });
      }

      yield* ctx.setState({
        ...state,
        stage: config.next as CampaignState["stage"],
        messagesDelivered: [...state.messagesDelivered, message.id],
      });

      // Schedule next message
      yield* ctx.schedule(config.delay);
    }),
});
```

**Client usage:**

```ts
// Start campaign for a user
yield* client.continuous("dripCampaign").start({
  id: `${userId}-${campaignId}`,
  input: {
    userId,
    campaignId,
    stage: "day1",
    messagesDelivered: [],
    startedAt: Date.now(),
    lastInteraction: null,
  },
});

// When user interacts, update state
yield* client.continuous("dripCampaign").updateState(
  `${userId}-${campaignId}`,
  (state) => ({ lastInteraction: Date.now() })
);

// User unsubscribes
yield* client.continuous("dripCampaign").stop(
  `${userId}-${campaignId}`,
  { reason: "User unsubscribed" }
);
```

### Example 3: Health Check Monitor

```ts
const HealthState = Schema.Struct({
  endpoint: Schema.String,
  consecutiveFailures: Schema.Number,
  lastCheck: Schema.NullOr(Schema.Number),
  lastSuccess: Schema.NullOr(Schema.Number),
  status: Schema.Literal("healthy", "degraded", "down"),
});

const healthMonitor = Continuous.make({
  stateSchema: HealthState,

  schedule: Continuous.cron("*/5 * * * *"),  // Every 5 minutes

  startImmediately: true,

  execute: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.state;
      const now = Date.now();

      const isHealthy = yield* checkEndpoint(state.endpoint).pipe(
        Effect.map(() => true),
        Effect.catchAll(() => Effect.succeed(false))
      );

      if (isHealthy) {
        yield* ctx.setState({
          ...state,
          consecutiveFailures: 0,
          lastCheck: now,
          lastSuccess: now,
          status: "healthy",
        });
      } else {
        const failures = state.consecutiveFailures + 1;
        const newStatus =
          failures >= 3 ? "down" : failures >= 1 ? "degraded" : "healthy";

        yield* ctx.setState({
          ...state,
          consecutiveFailures: failures,
          lastCheck: now,
          status: newStatus,
        });

        // Alert if status changed to down
        if (newStatus === "down" && state.status !== "down") {
          yield* sendAlert(`Endpoint ${state.endpoint} is DOWN`);
        }

        // Check more frequently when degraded/down
        if (newStatus !== "healthy") {
          yield* ctx.schedule(Duration.minutes(1));
        }
      }
    }),
});
```

---

## Naming Considerations

### `startImmediately` Alternatives

| Name | Pros | Cons |
|------|------|------|
| `startImmediately` | Clear intent | Slightly long |
| `runOnStart` | Shorter | Could be confused with "run when calling start()" |
| `executeImmediately` | Matches "execute" | Long |
| `eager` | Very short | Less clear |
| `immediate` | Short, clear | Needs context |
| `delayFirstRun` (inverted) | Describes the false case | Double negative when true |

**Recommendation:** `startImmediately: true` (default) is clear.

Alternative phrasing with inverted default:
```ts
delayStart: false  // Default - runs immediately
delayStart: true   // Waits for first scheduled time
```

### Schedule API Alternatives

```ts
// Current proposal
schedule: Continuous.every("30 minutes")
schedule: Continuous.cron("0 * * * *")

// Alternative: Unified with Effect Schedule
schedule: Schedule.spaced(Duration.minutes(30))
schedule: Schedule.cron("0 * * * *")  // If Effect adds cron support

// Alternative: Object config
schedule: { every: "30 minutes" }
schedule: { cron: "0 * * * *" }
schedule: { interval: Duration.minutes(30) }
```

**Recommendation:** `Continuous.every()` / `Continuous.cron()` feels natural and provides good type inference.

---

## Type Inference Flow

The API is designed for maximum type inference:

```ts
// 1. Schema defines state type
const MyState = Schema.Struct({
  count: Schema.Number,
  name: Schema.String,
});

// 2. State type flows to execute context
const process = Continuous.make({
  stateSchema: MyState,
  execute: (ctx) =>
    Effect.gen(function* () {
      // ctx.state is Effect<{ count: number; name: string }>
      const state = yield* ctx.state;
      //    ^? { count: number; name: string }

      yield* ctx.setState({ count: 1, name: "test" });
      //                    ^? Must match schema
    }),
});

// 3. Client start() input is typed by schema
yield* client.continuous("myProcess").start({
  id: "123",
  input: { count: 0, name: "initial" },
  //      ^? Must match schema
});

// 4. getState() returns typed state
const state = yield* client.continuous("myProcess").getState("123");
//    ^? { count: number; name: string } | undefined
```

---

## Error Handling

### Execution Errors

```ts
Continuous.make({
  // ...

  execute: (ctx) =>
    Effect.gen(function* () {
      // Errors here are caught by onError
      yield* riskyOperation();
    }),

  // Optional: Handle errors explicitly
  onError: (error, ctx) =>
    Effect.gen(function* () {
      // Log, update state, adjust schedule, or stop
      yield* ctx.updateState((s) => ({
        errorCount: (s.errorCount ?? 0) + 1,
      }));

      // Can choose to terminate on certain errors
      if (error._tag === "FatalError") {
        return yield* ctx.terminate({ reason: "Fatal error occurred" });
      }

      // Can adjust schedule for retry
      yield* ctx.schedule(Duration.minutes(5));
    }),
});
```

### Default Error Behavior

If `onError` is not provided:
1. Error is logged
2. Process continues on normal schedule
3. No state changes from the failed execution are persisted

---

## Summary

| Feature | API |
|---------|-----|
| Define process | `Continuous.make({ stateSchema, schedule, execute })` |
| Schedule - interval | `Continuous.every("30 minutes")` |
| Schedule - cron | `Continuous.cron("0 * * * *")` |
| Run on start | `startImmediately: true` (default) |
| Get state | `ctx.state` |
| Update state | `ctx.setState(newState)` |
| Transform state | `ctx.updateState((s) => ({ ...s, count: s.count + 1 }))` |
| Terminate (purge) | `return yield* ctx.terminate({ reason: "..." })` |
| Terminate (keep state) | `return yield* ctx.terminate({ reason: "...", purgeState: false })` |
| Override schedule | `yield* ctx.reschedule(duration)` (future) |
| Get run count | `ctx.runCount` |
| Client - start | `yield* client.continuous("name").start({ id, input })` |
| Client - stop | `yield* client.continuous("name").stop(id)` |
| Client - status | `yield* client.continuous("name").status(id)` |
| Client - trigger | `yield* client.continuous("name").trigger(id)` |

The API prioritizes:
- **Effect-native patterns** (generators, yieldable operations)
- **Type safety** (Schema-driven, full inference)
- **Idempotency** (ID-based operations)
- **Simplicity** (minimal boilerplate, sensible defaults)
