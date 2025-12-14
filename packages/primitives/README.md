# @durable-effect/primitives

Durable primitives for Cloudflare Workers built on Effect. This package provides high-level abstractions for common durable patterns:

- **Continuous** - Execute functions on a schedule (this guide)
- **Buffer** - Accumulate events and flush on schedule/threshold (coming soon)
- **Queue** - Process events one at a time with retries (coming soon)

## Installation

```bash
npm install @durable-effect/primitives effect
```

## Continuous Primitive

The Continuous primitive executes a function on a recurring schedule. Perfect for:

- Token refresh
- Periodic data sync
- Health checks
- Report generation
- Cache warming

### Quick Start

```ts
import { Effect, Schema } from "effect";
import { Continuous, createDurablePrimitives } from "@durable-effect/primitives";

// 1. Define your primitive (name comes from the object key in step 2)
const tokenRefresher = Continuous.make({
  // Schema for persistent state
  stateSchema: Schema.Struct({
    accessToken: Schema.String,
    refreshToken: Schema.String,
    expiresAt: Schema.Number,
  }),

  // Execute every 30 minutes
  schedule: Continuous.every("30 minutes"),

  // The function to run
  execute: (ctx) =>
    Effect.gen(function* () {
      console.log(`Refreshing token (run #${ctx.runCount})`);

      // Access current state
      const { refreshToken } = ctx.state;

      // Call your refresh API
      const newTokens = yield* refreshTokens(refreshToken);

      // Update state (persisted automatically)
      ctx.setState({
        accessToken: newTokens.access_token,
        refreshToken: newTokens.refresh_token,
        expiresAt: Date.now() + newTokens.expires_in * 1000,
      });
    }),
});

// 2. Create the Durable Object and Client - keys become primitive names
const { Primitives, PrimitivesClient } = createDurablePrimitives({
  tokenRefresher,
});

// 3. Export the Durable Object class
export { Primitives };

// 4. Use in your worker
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const client = PrimitivesClient.fromBinding(env.PRIMITIVES);

    // Start a token refresher for a user (name matches the key from step 2)
    await client.continuous("tokenRefresher").start({
      id: "user-123",
      input: {
        accessToken: "",
        refreshToken: "rt_initial_token",
        expiresAt: 0,
      },
    });

    return new Response("Token refresher started!");
  },
};
```

### wrangler.toml Configuration

```toml
[[durable_objects.bindings]]
name = "PRIMITIVES"
class_name = "Primitives"

[[migrations]]
tag = "v1"
new_classes = ["Primitives"]
```

## API Reference

### `Continuous.make(config)`

Creates a continuous primitive definition. The name is assigned when you register
the primitive via `createDurablePrimitives()` - the object key becomes the name.

```ts
const myPrimitive = Continuous.make({
  stateSchema: Schema.Struct({ ... }),
  schedule: Continuous.every("1 hour"),
  execute: (ctx) => Effect.succeed(undefined),
});

// Name "myPrimitive" comes from the key
const { Primitives, PrimitivesClient } = createDurablePrimitives({
  myPrimitive,
});
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `config.stateSchema` | `Schema.Schema<S>` | Effect Schema for validating and serializing state |
| `config.schedule` | `ContinuousSchedule` | When to execute (see Schedules below) |
| `config.startImmediately` | `boolean` | Execute immediately on start (default: `true`) |
| `config.execute` | `(ctx) => Effect<void, E, R>` | Function to execute on schedule |
| `config.onError` | `(error, ctx) => Effect<void>` | Optional error handler |

### Schedules

#### `Continuous.every(interval)`

Execute at a fixed interval.

```ts
Continuous.every("30 minutes")
Continuous.every("1 hour")
Continuous.every("24 hours")
Continuous.every(Duration.minutes(30))
```

#### `Continuous.cron(expression)` (coming soon)

Execute based on a cron expression.

```ts
// Every day at midnight
Continuous.cron("0 0 * * *")

// Every Monday at 9am
Continuous.cron("0 9 * * 1")

// Every hour
Continuous.cron("0 * * * *")
```

### ContinuousContext

The context object passed to your `execute` function:

```ts
interface ContinuousContext<S> {
  // Current state (read-only reference)
  readonly state: S;

  // Replace the entire state
  readonly setState: (state: S) => void;

  // Update state via function
  readonly updateState: (fn: (current: S) => S) => void;

  // Unique instance identifier
  readonly instanceId: string;

  // Number of times execute has been called
  readonly runCount: number;

  // Name of this primitive
  readonly primitiveName: string;
}
```

### Client Methods

#### `client.continuous(name).start({ id, input })`

Start a continuous primitive instance.

```ts
const result = await client.continuous("tokenRefresher").start({
  id: "user-123",           // Unique instance ID
  input: { ... },           // Initial state (must match stateSchema)
});

// Result:
// { _type: "continuous.start", instanceId: string, created: boolean, status: string }
```

If the instance already exists, returns `{ created: false }` with current status.

#### `client.continuous(name).stop(id, options?)`

Stop a running instance.

```ts
const result = await client.continuous("tokenRefresher").stop("user-123", {
  reason: "User logged out",  // Optional reason
});

// Result:
// { _type: "continuous.stop", stopped: boolean, reason: string }
```

#### `client.continuous(name).trigger(id)`

Manually trigger immediate execution (bypasses schedule).

```ts
const result = await client.continuous("tokenRefresher").trigger("user-123");

// Result:
// { _type: "continuous.trigger", triggered: boolean }
```

#### `client.continuous(name).status(id)`

Get current status of an instance.

```ts
const result = await client.continuous("tokenRefresher").status("user-123");

// Result:
// { _type: "continuous.status", status: string, runCount: number, nextRunAt?: number }
```

#### `client.continuous(name).getState(id)`

Get current state of an instance.

```ts
const result = await client.continuous("tokenRefresher").getState("user-123");

// Result:
// { _type: "continuous.getState", state: S | null }
```

## Error Handling

### Using `onError`

Handle errors gracefully without failing the execution:

```ts
const resilientPrimitive = Continuous.make({
  stateSchema: Schema.Struct({
    data: Schema.String,
    errorCount: Schema.Number,
    lastError: Schema.NullOr(Schema.String),
  }),
  schedule: Continuous.every("5 minutes"),

  execute: (ctx) =>
    Effect.gen(function* () {
      // This might fail
      const data = yield* fetchExternalData();
      ctx.updateState((s) => ({
        ...s,
        data,
        errorCount: 0,
        lastError: null,
      }));
    }),

  onError: (error, ctx) =>
    Effect.sync(() => {
      console.error(`Execution failed: ${error}`);
      ctx.updateState((s) => ({
        ...s,
        errorCount: s.errorCount + 1,
        lastError: String(error),
      }));
    }),
});
```

### Typed Errors

Define typed errors for better error handling:

```ts
class RefreshError extends Data.TaggedError("RefreshError")<{
  readonly reason: string;
}> {}

const typedPrimitive = Continuous.make({
  stateSchema: Schema.Struct({ token: Schema.String }),
  schedule: Continuous.every("1 hour"),

  execute: (ctx) =>
    Effect.gen(function* () {
      const result = yield* refreshToken(ctx.state.token);
      if (!result.ok) {
        return yield* Effect.fail(new RefreshError({ reason: result.error }));
      }
      ctx.setState({ token: result.token });
    }),

  onError: (error, ctx) =>
    Effect.sync(() => {
      // error is typed as RefreshError
      console.error(`Refresh failed: ${error.reason}`);
    }),
});
```

## Testing

Use the test runtime for unit testing:

```ts
import { describe, it, expect } from "vitest";
import { Effect, Schema } from "effect";
import { createTestRuntime, NoopTrackerLayer } from "@durable-effect/core";
import { createPrimitivesRuntimeFromLayer } from "@durable-effect/primitives";

describe("tokenRefresher", () => {
  it("refreshes token on schedule", async () => {
    // Create test runtime with time control
    const { layer, time, handles } = createTestRuntime("test-instance", 1000000);

    // Create registry (manually add name for test registry)
    const registry = {
      continuous: new Map([["tokenRefresher", { ...tokenRefresher, name: "tokenRefresher" }]]),
      buffer: new Map(),
      queue: new Map(),
    };

    // Create runtime from test layer
    const runtime = createPrimitivesRuntimeFromLayer(layer, registry);

    // Start the primitive
    await runtime.handle({
      type: "continuous",
      action: "start",
      name: "tokenRefresher",
      id: "test-user",
      input: { accessToken: "", refreshToken: "rt_test", expiresAt: 0 },
    });

    // Advance time past schedule
    time.advance(30 * 60 * 1000); // 30 minutes

    // Trigger alarm
    await runtime.handleAlarm();

    // Verify state was updated
    const result = await runtime.handle({
      type: "continuous",
      action: "getState",
      name: "tokenRefresher",
      id: "test-user",
    });

    expect(result.state.accessToken).toBeDefined();
  });
});
```

## Examples

### Daily Report Generator

```ts
const dailyReport = Continuous.make({
  stateSchema: Schema.Struct({
    lastReportDate: Schema.NullOr(Schema.String),
    totalReports: Schema.Number,
  }),
  schedule: Continuous.every("24 hours"),
  startImmediately: false, // Wait for first schedule

  execute: (ctx) =>
    Effect.gen(function* () {
      const report = yield* generateReport();
      yield* sendReport(report);

      ctx.updateState((s) => ({
        lastReportDate: new Date().toISOString(),
        totalReports: s.totalReports + 1,
      }));
    }),
});
```

### Health Check Monitor

```ts
const healthCheck = Continuous.make({
  stateSchema: Schema.Struct({
    status: Schema.Literal("healthy", "degraded", "down"),
    lastCheck: Schema.Number,
    consecutiveFailures: Schema.Number,
  }),
  schedule: Continuous.every("1 minute"),

  execute: (ctx) =>
    Effect.gen(function* () {
      const isHealthy = yield* checkHealth();

      ctx.updateState((s) => ({
        status: isHealthy ? "healthy" : s.consecutiveFailures >= 3 ? "down" : "degraded",
        lastCheck: Date.now(),
        consecutiveFailures: isHealthy ? 0 : s.consecutiveFailures + 1,
      }));

      if (!isHealthy && ctx.state.consecutiveFailures >= 3) {
        yield* sendAlert("Service is down!");
      }
    }),
});
```

### Cache Warmer

```ts
const cacheWarmer = Continuous.make({
  stateSchema: Schema.Struct({
    lastWarmTime: Schema.Number,
    itemsWarmed: Schema.Number,
  }),
  schedule: Continuous.every("15 minutes"),

  execute: (ctx) =>
    Effect.gen(function* () {
      const items = yield* getPopularItems();

      for (const item of items) {
        yield* warmCache(item);
      }

      ctx.setState({
        lastWarmTime: Date.now(),
        itemsWarmed: items.length,
      });
    }),
});
```

## Architecture

The Continuous primitive is built on a thin Durable Object shell that delegates to a swappable runtime:

```
┌─────────────────────────────────────────────────────────────┐
│                     Worker Code                              │
│  client.continuous("name").start({ id, input })             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              Durable Object (Thin Shell)                     │
│                                                              │
│  • Receives RPC calls                                        │
│  • Delegates to PrimitivesRuntime                           │
│  • Handles alarms                                            │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   Primitives Runtime                         │
│                                                              │
│  • Routes requests to handlers                               │
│  • Manages state via StorageAdapter                         │
│  • Schedules alarms via SchedulerAdapter                    │
│  • Executes user functions                                   │
└─────────────────────────────────────────────────────────────┘
```

Each instance has its own:
- **Storage** - Isolated key-value storage for state
- **Alarm** - Single alarm for scheduling next execution
- **Instance ID** - Format: `continuous:{name}:{userProvidedId}`

## License

MIT
