# @durable-effect/jobs Architecture Guide

A comprehensive breakdown of the codebase for newcomers.

---

## Overview

`@durable-effect/jobs` provides durable job abstractions for Cloudflare Workers, built on [Effect](https://effect.website/). It enables you to write business logic as pure Effect programs while the framework handles durability concerns (persistence, retries, scheduling, resumption).

**Key insight:** Cloudflare Durable Objects provide the durability primitives (storage + alarms), but their API is imperative. This package bridges the gap between Effect's composable, type-safe programs and Durable Objects' infrastructure concerns.

---

## The Big Picture: Request Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              YOUR WORKER                                     │
│                                                                              │
│   const client = JobsClient.fromBinding(env.JOBS);                          │
│   await client.continuous("tokenRefresher").start({ id: "user-123", ... }); │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT LAYER                                    │
│                                                                              │
│   • Creates instance ID: "continuous:tokenRefresher:user-123"               │
│   • Gets DO stub from binding                                                │
│   • Calls stub.call({ type: "continuous", action: "start", ... })           │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │ RPC Call
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              ENGINE LAYER                                    │
│                         (Durable Object Shell)                               │
│                                                                              │
│   class DurableJobsEngine extends DurableObject {                           │
│     call(request) → delegates to runtime.handle(request)                    │
│     alarm() → delegates to runtime.handleAlarm()                            │
│   }                                                                          │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              RUNTIME LAYER                                   │
│                                                                              │
│   • Creates Effect layers (services, handlers)                              │
│   • Converts async runtime → Effect execution                               │
│   • Flushes events after execution                                          │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                             DISPATCHER LAYER                                 │
│                                                                              │
│   Routes requests by type:                                                   │
│   • "continuous" → ContinuousHandler                                        │
│   • "debounce" → DebounceHandler                                            │
│   • "task" → TaskHandler                                                    │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                             HANDLER LAYER                                    │
│                                                                              │
│   • Looks up job definition from registry                                   │
│   • Manages metadata and state via services                                 │
│   • Calls YOUR execute/onEvent function with a rich context                 │
│   • Schedules alarms, handles retries                                       │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                             SERVICES LAYER                                   │
│                                                                              │
│   MetadataService → Job type, status, timestamps                            │
│   EntityStateService → Schema-validated user state                          │
│   AlarmService → Schedule/cancel alarms                                     │
│   IdempotencyService → Prevent duplicate event processing                   │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         CORE ADAPTERS (from @durable-effect/core)            │
│                                                                              │
│   StorageAdapter → Durable Object storage.get/put/delete                    │
│   SchedulerAdapter → Durable Object storage.setAlarm                        │
│   RuntimeAdapter → Time, instance ID, logging                               │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Layer 1: Core Adapters (`@durable-effect/core`)

**Purpose:** Abstract the Durable Object primitives behind Effect service interfaces.

**Why this matters:** Decouples business logic from Cloudflare-specific APIs, enabling testing with in-memory implementations.

### StorageAdapter (`packages/core/src/adapters/storage.ts`)

```typescript
interface StorageAdapterService {
  get: <T>(key: string) => Effect<T | undefined, StorageError>;
  put: <T>(key: string, value: T) => Effect<void, StorageError>;
  delete: (key: string) => Effect<boolean, StorageError>;
  deleteAll: () => Effect<void, StorageError>;
  list: <T>(prefix: string) => Effect<Map<string, T>, StorageError>;
}
```

Wraps `DurableObjectStorage` methods. Returns Effects that fail with typed `StorageError`.

### SchedulerAdapter (`packages/core/src/adapters/scheduler.ts`)

```typescript
interface SchedulerAdapterService {
  schedule: (time: number) => Effect<void, SchedulerError>;
  cancel: () => Effect<void, SchedulerError>;
  getScheduled: () => Effect<number | undefined, SchedulerError>;
}
```

Wraps `storage.setAlarm()` and `storage.deleteAlarm()`. Only one alarm can be scheduled at a time (Durable Object constraint).

### RuntimeAdapter

Provides:
- Current timestamp
- Instance ID
- Logging utilities

---

## Layer 2: Services (`packages/jobs/src/services/`)

**Purpose:** Higher-level operations built on top of core adapters.

**Why this matters:** Encapsulates common patterns (metadata tracking, schema validation, alarm scheduling with durations) so handlers don't repeat this logic.

### MetadataService (`metadata.ts`)

Tracks job instance metadata:

```typescript
interface JobMetadata {
  type: "continuous" | "debounce" | "workerPool" | "task";
  name: string;              // Job definition name (e.g., "tokenRefresher")
  status: "initializing" | "running" | "stopped" | "terminated";
  createdAt: number;
  updatedAt: number;
  id?: string;               // User-provided ID for correlation
  stopReason?: string;
}
```

**Key operations:**
- `initialize(type, name, id)` - Create metadata for new instance
- `get()` - Read current metadata
- `updateStatus(status)` - Transition status

**Storage key:** `__meta__`

### EntityStateService (`entity-state.ts`)

Schema-validated state management:

```typescript
interface EntityStateServiceI<S> {
  get: () => Effect<S | null, StorageError | ValidationError>;
  set: (state: S) => Effect<void, StorageError | ValidationError>;
  update: (fn: (current: S) => S) => Effect<void, StorageError | ValidationError>;
  delete: () => Effect<boolean, StorageError>;
}
```

**Key insight:** This is a **factory function**, not a Layer, because each job needs a state service typed to its own schema:

```typescript
const stateService = yield* createEntityStateService(def.stateSchema);
const current = yield* stateService.get();
```

Uses Effect Schema for:
- Runtime validation (catches invalid state early)
- Encoding (converts rich types like `Date` to JSON-serializable form)
- Decoding (restores rich types when reading)

**Storage key:** `__state__`

### AlarmService (`alarm.ts`)

Higher-level alarm scheduling with flexible time inputs:

```typescript
interface AlarmServiceI {
  schedule: (when: Duration | Date | number) => Effect<void, SchedulerError>;
  cancel: () => Effect<void, SchedulerError>;
  getScheduled: () => Effect<number | undefined, SchedulerError>;
}
```

Accepts:
- `Duration.seconds(30)` or `"30 seconds"`
- `new Date("2024-01-01")`
- Epoch milliseconds

Converts to absolute timestamp for SchedulerAdapter.

### IdempotencyService (`idempotency.ts`)

Prevents duplicate event processing:

```typescript
interface IdempotencyServiceI {
  markProcessed: (eventId: string) => Effect<void, StorageError>;
  isProcessed: (eventId: string) => Effect<boolean, StorageError>;
  clear: (eventId: string) => Effect<void, StorageError>;
}
```

**Storage key prefix:** `__idem__:`

### JobExecutionService (`execution.ts`)

Orchestrates job execution with retry support:

```typescript
interface JobExecutionServiceI {
  execute: <S, E, R, Ctx>(options: ExecuteOptions) => Effect<ExecutionResult, ExecutionError>;
}
```

Handles:
- Loading/saving state
- Creating context for user function
- Retry scheduling on failure
- Event emission (job.executed, job.failed, job.retryExhausted)
- Termination signals

### CleanupService (`cleanup.ts`)

Resource cleanup:

```typescript
interface CleanupServiceI {
  purgeState: () => Effect<void, StorageError>;
  cancelAlarm: () => Effect<void, SchedulerError>;
}
```

Used when terminating a job or cleaning up after retry exhaustion.

---

## Layer 3: Definition Factories (`packages/jobs/src/definitions/`)

**Purpose:** User-facing API for defining jobs.

**Why this matters:** Provides a clean, type-safe way to define jobs without knowing internal implementation details.

### Continuous Jobs (`continuous.ts`)

For recurring work on a schedule:

```typescript
const tokenRefresher = Continuous.make({
  stateSchema: Schema.Struct({
    accessToken: Schema.String,
    refreshToken: Schema.String,
    expiresAt: Schema.Number,
  }),
  schedule: Continuous.every("30 minutes"),
  startImmediately: true,  // Execute on start (default)
  retry: { maxAttempts: 3, delay: Backoff.exponential({ base: "1 second" }) },
  execute: (ctx) => Effect.gen(function* () {
    const state = yield* ctx.state;
    const newToken = yield* refreshToken(state.refreshToken);
    yield* ctx.setState({ ...state, accessToken: newToken });
  }),
});
```

**Use cases:** Token refresh, health checks, cache warming, daily reports

### Debounce Jobs (`debounce.ts`)

For batching rapid events:

```typescript
const webhookBatcher = Debounce.make({
  eventSchema: Schema.Struct({ type: Schema.String, data: Schema.Unknown }),
  flushAfter: "5 seconds",
  maxEvents: 100,           // Flush early if this many events
  onEvent: (ctx) => Effect.succeed({
    events: [...ctx.state.events, ctx.event],
    count: ctx.state.count + 1,
  }),
  execute: (ctx) => Effect.gen(function* () {
    const state = yield* ctx.state;
    yield* sendBatch(state.events);
  }),
});
```

**Use cases:** Webhook coalescing, update batching, notification grouping

### Task Jobs (`task.ts`)

For user-controlled state machines:

```typescript
const orderProcessor = Task.make({
  stateSchema: Schema.Struct({
    orderId: Schema.String,
    status: Schema.Literal("pending", "processing", "shipped"),
    lastUpdated: Schema.Number,
  }),
  eventSchema: Schema.Union(
    Schema.Struct({ _tag: Schema.Literal("OrderPlaced"), orderId: Schema.String }),
    Schema.Struct({ _tag: Schema.Literal("Shipped"), trackingNumber: Schema.String }),
  ),
  onEvent: (event, ctx) => Effect.gen(function* () {
    switch (event._tag) {
      case "OrderPlaced":
        yield* ctx.setState({ orderId: event.orderId, status: "pending", lastUpdated: Date.now() });
        yield* ctx.schedule("5 minutes");  // Check payment
        break;
      case "Shipped":
        yield* ctx.updateState(s => ({ ...s, status: "shipped" }));
        yield* ctx.schedule("24 hours");   // Check delivery
        break;
    }
  }),
  execute: (ctx) => Effect.gen(function* () {
    // Runs when alarm fires - check status, schedule next, or terminate
  }),
});
```

**Use cases:** Order workflows, user onboarding, multi-step processes

---

## Layer 4: Registry (`packages/jobs/src/registry/`)

**Purpose:** Type-safe storage and lookup of job definitions.

**Why this matters:** Enables compile-time checking of job names and type inference for state/events.

### Two Registry Types

**TypedJobRegistry** (compile-time):
```typescript
// Preserves literal key types for client type-safety
type TypedJobRegistry<T> = {
  continuous: { [K in ContinuousKeysOf<T>]: ... };
  debounce: { [K in DebounceKeysOf<T>]: ... };
  task: { [K in TaskKeysOf<T>]: ... };
  workerPool: { [K in WorkerPoolKeysOf<T>]: ... };
};
```

**RuntimeJobRegistry** (runtime):
```typescript
// Used by handlers to look up definitions
type RuntimeJobRegistry = {
  continuous: Record<string, StoredContinuousDefinition>;
  debounce: Record<string, StoredDebounceDefinition>;
  task: Record<string, StoredTaskDefinition>;
  workerPool: Record<string, StoredWorkerPoolDefinition>;
};
```

### Type Flow

```
Continuous.make({...})           // UnregisteredContinuousDefinition (no name)
        │
        ▼
createDurableJobs({ myJob })     // Name assigned from object key
        │
        ▼
TypedJobRegistry                 // Type-safe, preserves literal key "myJob"
        │
        ▼
RuntimeJobRegistry               // For handlers to look up by name
```

---

## Layer 5: Handlers (`packages/jobs/src/handlers/`)

**Purpose:** Process requests by invoking user-defined functions with rich context.

**Why this matters:** Encapsulates all the complexity of state management, alarm scheduling, retries, and event emission.

### Handler Structure

Each job type has:
- `types.ts` - Request/response types
- `handler.ts` - Request processing logic
- `context.ts` - Context creation for user functions

### ContinuousHandler Example

```typescript
// handler.ts (simplified)
export const ContinuousHandlerLayer = Layer.effect(
  ContinuousHandler,
  Effect.gen(function* () {
    const registryService = yield* RegistryService;
    const metadata = yield* MetadataService;
    const alarm = yield* AlarmService;
    const execution = yield* JobExecutionService;
    // ... more services

    return {
      handle: (request) => Effect.gen(function* () {
        const def = registryService.registry.continuous[request.name];

        switch (request.action) {
          case "start":
            yield* metadata.initialize("continuous", request.name, request.id);
            yield* execution.execute({ ... });
            yield* alarm.schedule(def.schedule.interval);
            return { _type: "continuous.start", created: true };

          case "terminate":
            yield* alarm.cancel();
            yield* storage.deleteAll();
            return { _type: "continuous.terminate", terminated: true };

          // ... other actions
        }
      }),

      handleAlarm: () => Effect.gen(function* () {
        // Called when alarm fires
        yield* execution.execute({ ... });
        yield* alarm.schedule(def.schedule.interval);
      }),
    };
  })
);
```

### Context Objects

User functions receive rich context objects:

```typescript
// ContinuousContext<S>
{
  state: Effect<S, never, never>,           // Current state (Effect for lazy loading)
  setState: (state: S) => Effect<void>,     // Replace state
  updateState: (fn: S => S) => Effect<void>,// Transform state
  instanceId: string,                        // DO instance identifier
  runCount: number,                          // Execution count (1-indexed)
  jobName: string,                           // Registered name
  attempt: number,                           // Retry attempt (1 = first try)
  isRetry: boolean,                          // Is this a retry?
  terminate: (options?) => Effect<never>,   // Stop job, purge state
}
```

---

## Layer 6: Dispatcher (`packages/jobs/src/runtime/dispatcher.ts`)

**Purpose:** Route requests to the correct handler.

**Why this matters:** Single point of request routing, enabling clean separation between job types.

```typescript
export const DispatcherLayer = Layer.effect(
  Dispatcher,
  Effect.gen(function* () {
    const metadata = yield* MetadataService;
    const continuous = yield* ContinuousHandler;
    const debounce = yield* DebounceHandler;
    const task = yield* TaskHandler;

    return {
      handle: (request) => {
        switch (request.type) {
          case "continuous": return continuous.handle(request);
          case "debounce": return debounce.handle(request);
          case "task": return task.handle(request);
          case "workerPool": return Effect.fail(new UnknownJobTypeError({ type: "workerPool (not implemented)" }));
        }
      },

      handleAlarm: () => Effect.gen(function* () {
        const meta = yield* metadata.get();
        if (!meta) return;

        switch (meta.type) {
          case "continuous": return continuous.handleAlarm();
          case "debounce": return debounce.handleAlarm();
          case "task": return task.handleAlarm();
        }
      }),
    };
  })
);
```

---

## Layer 7: Runtime (`packages/jobs/src/runtime/runtime.ts`)

**Purpose:** Wire all layers together and provide the interface for the DO shell.

**Why this matters:** Isolates Effect complexity from the Durable Object class.

```typescript
export function createJobsRuntime(config: JobsRuntimeConfig): JobsRuntime {
  // Build layer stack
  const coreLayer = createDurableObjectRuntime(config.doState);
  const trackerLayer = config.trackerConfig ? HttpBatchTrackerLayer(config.trackerConfig) : NoopTrackerLayer;
  const servicesLayer = RuntimeServicesLayer.pipe(Layer.provideMerge(coreLayer));
  const handlersLayer = JobHandlersLayer.pipe(Layer.provideMerge(servicesLayer));
  const dispatcherLayer = DispatcherLayer.pipe(Layer.provideMerge(handlersLayer));

  return {
    handle: (request) => Effect.runPromise(
      Effect.gen(function* () {
        const dispatcher = yield* Dispatcher;
        const result = yield* dispatcher.handle(request);
        yield* flushEvents;  // Send any queued telemetry
        return result;
      }).pipe(Effect.provide(dispatcherLayer))
    ),

    handleAlarm: () => Effect.runPromise(
      Effect.gen(function* () {
        const dispatcher = yield* Dispatcher;
        yield* dispatcher.handleAlarm();
        yield* flushEvents;
      }).pipe(Effect.provide(dispatcherLayer))
    ),
  };
}
```

---

## Layer 8: Engine (`packages/jobs/src/engine/engine.ts`)

**Purpose:** Thin Durable Object shell that delegates everything to the runtime.

**Why this matters:** Keeps the DO class minimal - it just creates the runtime and forwards calls.

```typescript
export class DurableJobsEngine extends DurableObject implements DurableJobsEngineInterface {
  readonly #runtime: JobsRuntime;

  constructor(state: DurableObjectState, env: JobsEngineConfig) {
    super(state, env);

    // Create runtime once in constructor
    this.#runtime = createJobsRuntime({
      doState: state,
      registry: env.__JOB_REGISTRY__,
      trackerConfig: env.__TRACKER_CONFIG__,
    });
  }

  // Single RPC method - no method per action
  async call(request: JobRequest): Promise<JobResponse> {
    return this.#runtime.handle(request);
  }

  async alarm(): Promise<void> {
    await this.#runtime.handleAlarm();
  }
}
```

**Key design:** One `call()` method for all operations. The request includes `type` and `action`. This simplifies the DO interface and centralizes routing in the dispatcher.

---

## Layer 9: Client (`packages/jobs/src/client/`)

**Purpose:** Type-safe client for calling jobs from your worker.

**Why this matters:** Provides IDE autocomplete, type checking for job names, and proper typing for state/events.

```typescript
export function createJobsClient<T extends Record<string, AnyUnregisteredDefinition>>(
  binding: DurableObjectNamespace,
  registry: TypedJobRegistry<T>,
): JobsClient<TypedJobRegistry<T>> {
  return {
    continuous: (name: string) => ({
      start: ({ id, input }) => {
        const instanceId = `continuous:${name}:${id}`;
        const stub = binding.get(binding.idFromName(instanceId));
        return narrowResponseEffect(
          stub.call({ type: "continuous", action: "start", name, id, input }),
          "continuous.start"
        );
      },
      terminate: (id, options) => { ... },
      trigger: (id) => { ... },
      status: (id) => { ... },
      getState: (id) => { ... },
    }),

    debounce: (name: string) => ({ ... }),
    task: (name: string) => ({ ... }),
    workerPool: (name: string) => ({ ... }),
  };
}
```

### Instance ID Format

```
{jobType}:{jobName}:{userProvidedId}
```

Examples:
- `continuous:tokenRefresher:user-123`
- `debounce:webhookBatcher:contact-456`
- `task:orderProcessor:order-789`

Each unique ID gets its own Durable Object instance.

---

## Layer 10: Factory (`packages/jobs/src/factory.ts`)

**Purpose:** Main entry point that wires everything together.

**Why this matters:** Single function call creates everything you need.

```typescript
export function createDurableJobs<const T extends Record<string, AnyUnregisteredDefinition>>(
  definitions: T,
  options?: CreateDurableJobsOptions
): CreateDurableJobsResult<T> {
  // Create typed registry (preserves literal keys)
  const registry = createTypedJobRegistry(definitions);

  // Create runtime registry (for handlers)
  const runtimeRegistry = toRuntimeRegistry(registry);

  // Create bound DO class with registry injected
  class BoundJobsEngine extends DurableJobsEngine {
    constructor(state: DurableObjectState, env: unknown) {
      super(state, {
        ...env,
        __JOB_REGISTRY__: runtimeRegistry,
        __TRACKER_CONFIG__: options?.tracker,
      });
    }
  }

  // Create client factory
  const JobsClientFactory = {
    fromBinding: (binding) => createJobsClient(binding, registry),
    Tag: Context.GenericTag<JobsClient<TypedJobRegistry<T>>>("@durable-effect/jobs/Client"),
  };

  return {
    Jobs: BoundJobsEngine,
    JobsClient: JobsClientFactory,
    registry,
    runtimeRegistry,
  };
}
```

### Usage

```typescript
// Define jobs
const tokenRefresher = Continuous.make({ ... });
const webhookBatcher = Debounce.make({ ... });
const orderProcessor = Task.make({ ... });

// Create engine and client factory
const { Jobs, JobsClient } = createDurableJobs({
  tokenRefresher,
  webhookBatcher,
  orderProcessor,
}, {
  tracker: {
    endpoint: "https://events.example.com/ingest",
    env: "production",
    serviceKey: "my-jobs",
  },
});

// Export DO class for Cloudflare
export { Jobs };

// Use client in worker
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
  }
};
```

---

## Supporting Concepts

### Storage Keys (`storage-keys.ts`)

Centralized key management prevents typos and documents the storage layout:

```typescript
export const KEYS = {
  META: "__meta__",
  STATE: "__state__",
  CONTINUOUS: {
    RUN_COUNT: "__continuous__:runCount",
    LAST_EXECUTED_AT: "__continuous__:lastExecutedAt",
  },
  DEBOUNCE: {
    EVENT_COUNT: "__debounce__:eventCount",
    STARTED_AT: "__debounce__:startedAt",
  },
  TASK: {
    EVENT_COUNT: "__task__:eventCount",
    EXECUTE_COUNT: "__task__:executeCount",
    CREATED_AT: "__task__:createdAt",
    SCHEDULED_AT: "__task__:scheduledAt",
  },
  IDEMPOTENCY: "__idem__:",
  RETRY: {
    ATTEMPT: "__retry__:attempt",
    STARTED_AT: "__retry__:startedAt",
    LAST_ERROR: "__retry__:lastError",
    SCHEDULED_AT: "__retry__:scheduledAt",
  },
} as const;
```

### Error Types (`errors.ts`)

Typed errors for different failure modes:

```typescript
// Job-specific errors
JobNotFoundError      // Job name not in registry
InstanceNotFoundError // Instance has no metadata
InvalidStateError     // Invalid state transition
ValidationError       // Schema validation failure
ExecutionError        // User function threw
RetryExhaustedError   // All retries failed
UnknownJobTypeError   // Unknown job type in request
DuplicateEventError   // Idempotency check failed

// Control flow
TerminateSignal       // Short-circuit execution (ctx.terminate())
```

### Retry System (`retry/`)

Durable retries that survive restarts:

```typescript
const tokenRefresher = Continuous.make({
  retry: {
    maxAttempts: 3,
    delay: Backoff.exponential({ base: "1 second", max: "30 seconds" }),
    jitter: true,
    isRetryable: (error) => error._tag !== "FatalError",
  },
  execute: (ctx) => { ... },
});
```

Retries are scheduled via alarms, not in-memory. If the worker restarts, retry continues.

### Event Tracking (`tracker/`)

Telemetry for observability:

```typescript
const { Jobs } = createDurableJobs(definitions, {
  tracker: {
    endpoint: "https://events.example.com/ingest",
    env: "production",
    serviceKey: "my-jobs",
  },
});
```

Emits events:
- `job.started` - Job instance created
- `job.executed` - Execute completed successfully
- `job.failed` - Execute threw an error
- `job.retryExhausted` - All retries failed
- `job.terminated` - Job instance terminated

---

## Testing

The layered architecture enables testing without Cloudflare:

```typescript
import { createTestRuntime } from "@durable-effect/core";
import { createJobsRuntimeFromLayer } from "@durable-effect/jobs";

// Create in-memory test layer
const { layer, handles } = createTestRuntime("test-instance", Date.now());
const runtime = createJobsRuntimeFromLayer(layer, runtimeRegistry);

// Test job operations
await runtime.handle({ type: "continuous", action: "start", name: "myJob", id: "test", input: {...} });

// Advance time and fire alarm
handles.scheduler.fire();
await runtime.handleAlarm();

// Assert state
const status = await runtime.handle({ type: "continuous", action: "status", name: "myJob", id: "test" });
expect(status.runCount).toBe(1);
```

---

## Directory Structure

```
packages/jobs/src/
├── index.ts                  # Public API exports
├── factory.ts                # createDurableJobs() - main entry point
├── errors.ts                 # Error types
├── storage-keys.ts           # Storage key constants
│
├── definitions/              # User-facing definition factories
│   ├── continuous.ts         # Continuous.make()
│   ├── debounce.ts           # Debounce.make()
│   └── task.ts               # Task.make()
│
├── registry/                 # Job registry and type system
│   ├── types.ts              # Definition, context, registry types
│   ├── registry.ts           # Registry factory functions
│   └── typed.ts              # Type helpers and guards
│
├── services/                 # Service layer
│   ├── metadata.ts           # MetadataService
│   ├── entity-state.ts       # EntityStateService factory
│   ├── alarm.ts              # AlarmService
│   ├── idempotency.ts        # IdempotencyService
│   ├── execution.ts          # JobExecutionService
│   ├── cleanup.ts            # CleanupService
│   ├── registry.ts           # RegistryService
│   └── job-logging.ts        # Logging utilities
│
├── handlers/                 # Request handlers
│   ├── continuous/
│   │   ├── handler.ts        # ContinuousHandler
│   │   ├── context.ts        # Context creation
│   │   └── types.ts          # Handler types
│   ├── debounce/
│   └── task/
│
├── runtime/                  # Runtime orchestration
│   ├── types.ts              # Request/response types
│   ├── dispatcher.ts         # Request routing
│   └── runtime.ts            # Runtime factory
│
├── engine/                   # Durable Object shell
│   ├── engine.ts             # DurableJobsEngine class
│   └── types.ts              # Engine types
│
├── client/                   # Worker-side client
│   ├── client.ts             # createJobsClient()
│   ├── response.ts           # Response narrowing
│   └── types.ts              # Client types
│
└── retry/                    # Retry system
    ├── types.ts              # Retry config types
    ├── executor.ts           # RetryExecutor
    └── errors.ts             # Retry-related errors
```

---

## Summary

The architecture follows these principles:

1. **Thin DO shell** - The Durable Object class is minimal, delegating everything to the runtime.

2. **Effect layers** - Services are composed using Effect's Layer system, enabling testability and clean separation.

3. **Type safety** - TypeScript generics flow from definitions through the registry to the client, catching errors at compile time.

4. **Durability first** - Retries use alarms (durable), not in-memory loops. State is persisted immediately.

5. **User-focused API** - `createDurableJobs()` and `Continuous.make()` hide the complexity. Users write business logic; the framework handles infrastructure.

6. **Extensibility** - Adding a new job type means adding a definition factory, handler, and client method. The layers compose naturally.
