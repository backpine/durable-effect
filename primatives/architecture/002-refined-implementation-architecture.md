# Refined Primitives Implementation Architecture

## The Core Insight

**The Durable Object should be a thin shell that only provides storage and alarm capabilities.**

The previous design (`001-implementation-architecture.md`) had the DO class implementing RPC methods for every primitive operation (`continuousStart`, `bufferAdd`, `queueEnqueue`, etc.). This couples the DO to primitive types and makes the architecture rigid.

**Better approach:** Insert a **Primitives Runtime** layer between the DO and primitive handlers. This runtime:
- Takes raw storage + alarm capabilities as input
- Provides higher-level services (state management, scheduling, idempotency)
- Routes requests to primitive handlers
- Is completely platform-agnostic (could be backed by DO, in-memory, SQLite, etc.)

---

## Architecture Layers

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              USER CODE                                       │
│  const { Primitives, PrimitivesClient } = createDurablePrimitives({...})    │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT                                          │
│                                                                              │
│  PrimitivesClient.fromBinding(env.PRIMITIVES)                               │
│    • Resolves instance ID: `{type}:{name}:{id}`                             │
│    • Creates typed request                                                   │
│    • Calls DO.call(request)                                                  │
│                                                                              │
│  Methods:                                                                    │
│    continuous(name).start({ id, input }) → call({ type, action, ... })      │
│    buffer(name).add({ id, event }) → call({ type, action, ... })            │
│    queue(name).enqueue({ id, event }) → call({ type, action, ... })         │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     │ DO RPC: call(request), alarm()
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     DURABLE OBJECT (Thin Shell)                              │
│                                                                              │
│  class DurablePrimitivesEngine extends DurableObject {                      │
│    #runtime: PrimitivesRuntime;                                             │
│                                                                              │
│    constructor(state, env) {                                                │
│      this.#runtime = createPrimitivesRuntime({                              │
│        doState: state,                                                       │
│        registry: env.__REGISTRY__,                                          │
│        tracker: env.__TRACKER_CONFIG__,                                     │
│      });                                                                     │
│    }                                                                         │
│                                                                              │
│    // ONE generic RPC method - NOT one per primitive operation              │
│    async call(request: PrimitiveRequest): Promise<PrimitiveResponse> {      │
│      const result = await this.#runtime.handle(request);                    │
│      this.ctx.waitUntil(this.#runtime.flush());                             │
│      return result;                                                          │
│    }                                                                         │
│                                                                              │
│    async alarm(): Promise<void> {                                           │
│      await this.#runtime.handleAlarm();                                     │
│      this.ctx.waitUntil(this.#runtime.flush());                             │
│    }                                                                         │
│  }                                                                           │
│                                                                              │
│  The DO knows NOTHING about primitive types. It just:                       │
│    1. Creates the runtime                                                   │
│    2. Delegates to runtime.handle() and runtime.handleAlarm()               │
│    3. Flushes events via waitUntil                                          │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     │ handle(request), handleAlarm()
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       PRIMITIVES RUNTIME                                     │
│                    (The swappable abstraction layer)                         │
│                                                                              │
│  interface PrimitivesRuntime {                                               │
│    handle(request: PrimitiveRequest): Promise<PrimitiveResponse>;           │
│    handleAlarm(): Promise<void>;                                            │
│    flush(): Promise<void>;                                                  │
│  }                                                                           │
│                                                                              │
│  createPrimitivesRuntime(config) → PrimitivesRuntime                        │
│                                                                              │
│  Internally uses Effect and builds a layer stack:                           │
│    ┌─────────────────────────────────────────────────────────────────────┐  │
│    │                         Dispatcher                                   │  │
│    │  • Parses request type (continuous/buffer/queue)                    │  │
│    │  • Routes to correct handler                                         │  │
│    │  • handleAlarm() reads metadata to determine type, then routes      │  │
│    └─────────────────────────────────────────────────────────────────────┘  │
│                                     │                                        │
│                                     ▼                                        │
│    ┌─────────────────────────────────────────────────────────────────────┐  │
│    │                    Primitive Handlers                                │  │
│    │                                                                      │  │
│    │  ContinuousHandler { handle(req), handleAlarm() }                   │  │
│    │  BufferHandler { handle(req), handleAlarm() }                       │  │
│    │  QueueHandler { handle(req), handleAlarm() }                        │  │
│    │                                                                      │  │
│    │  Each handler knows its primitive's logic:                          │  │
│    │    • What operations it supports (start, stop, add, enqueue, etc.)  │  │
│    │    • How to execute user functions                                   │  │
│    │    • When to schedule alarms                                         │  │
│    └─────────────────────────────────────────────────────────────────────┘  │
│                                     │                                        │
│                                     ▼                                        │
│    ┌─────────────────────────────────────────────────────────────────────┐  │
│    │                    Runtime Services                                  │  │
│    │                 (Built on core adapters)                             │  │
│    │                                                                      │  │
│    │  MetadataService                                                     │  │
│    │    • initialize(type, name)                                          │  │
│    │    • get() → { type, name, status, createdAt, updatedAt }           │  │
│    │    • updateStatus(status)                                            │  │
│    │                                                                      │  │
│    │  EntityStateService<S>                                               │  │
│    │    • get() → S | null                                                │  │
│    │    • set(state: S)                                                   │  │
│    │    • update(fn: S → S)                                               │  │
│    │    • delete()                                                        │  │
│    │    • Validates against schema                                        │  │
│    │                                                                      │  │
│    │  AlarmService                                                        │  │
│    │    • schedule(Duration | Date | number)                              │  │
│    │    • cancel()                                                        │  │
│    │    • getScheduled() → number | undefined                             │  │
│    │                                                                      │  │
│    │  IdempotencyService                                                  │  │
│    │    • check(eventId) → boolean                                        │  │
│    │    • mark(eventId)                                                   │  │
│    │                                                                      │  │
│    │  EventTracker                                                        │  │
│    │    • emit(event)                                                     │  │
│    │    • flush()                                                         │  │
│    └─────────────────────────────────────────────────────────────────────┘  │
│                                     │                                        │
│                                     ▼                                        │
│    ┌─────────────────────────────────────────────────────────────────────┐  │
│    │                    Platform Adapters                                 │  │
│    │                 (from @durable-effect/core)                          │  │
│    │                                                                      │  │
│    │  StorageAdapter                                                      │  │
│    │    • get<T>(key) → Effect<T | undefined>                            │  │
│    │    • set<T>(key, value) → Effect<void>                              │  │
│    │    • delete(key) → Effect<void>                                     │  │
│    │    • list(options) → Effect<Map<string, T>>                         │  │
│    │                                                                      │  │
│    │  SchedulerAdapter                                                    │  │
│    │    • schedule(time: number) → Effect<void>                          │  │
│    │    • cancel() → Effect<void>                                        │  │
│    │    • getScheduled() → Effect<number | undefined>                    │  │
│    │                                                                      │  │
│    │  RuntimeAdapter                                                      │  │
│    │    • instanceId: string                                              │  │
│    │    • now() → Effect<number>                                         │  │
│    │                                                                      │  │
│    │  These wrap DO APIs into Effect interfaces.                         │  │
│    │  Could be swapped for in-memory implementations for testing.        │  │
│    └─────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **DO has ONE `call()` method** | Not one method per primitive operation. DO doesn't know about primitive types. |
| **Runtime is swappable** | Same runtime code works with DO storage, in-memory storage, or any other backend. |
| **Services wrap adapters** | Higher-level services (EntityStateService, AlarmService) provide Duration support, schema validation, etc. on top of raw adapters. |
| **Handlers are independent** | Each primitive handler is self-contained. Adding a new primitive doesn't touch DO or runtime - just add a new handler. |
| **Client does routing** | Instance ID resolution (`{type}:{name}:{id}`) happens in client, not DO. |

---

## Request/Response Protocol

The client creates typed requests, and the runtime returns typed responses:

```ts
// Request types
type PrimitiveRequest =
  | ContinuousRequest
  | BufferRequest
  | QueueRequest;

interface ContinuousRequest {
  readonly type: "continuous";
  readonly action: "start" | "stop" | "trigger" | "status" | "getState";
  readonly name: string;
  readonly id: string;
  readonly input?: unknown;  // For start
  readonly reason?: string;  // For stop
}

interface BufferRequest {
  readonly type: "buffer";
  readonly action: "add" | "flush" | "clear" | "status" | "getState";
  readonly name: string;
  readonly id: string;
  readonly event?: unknown;  // For add
  readonly eventId?: string; // For add (idempotency)
}

interface QueueRequest {
  readonly type: "queue";
  readonly action: "enqueue" | "pause" | "resume" | "cancel" | "status" | "drain";
  readonly name: string;
  readonly instanceIndex: number;  // Client already resolved this
  readonly eventId?: string;
  readonly event?: unknown;
}

// Response types
type PrimitiveResponse =
  | ContinuousStartResponse
  | ContinuousStopResponse
  | ContinuousStatusResponse
  | BufferAddResponse
  | BufferFlushResponse
  | QueueEnqueueResponse
  // ... etc
```

---

## Runtime Implementation

```ts
// packages/primitives/src/runtime/runtime.ts

interface PrimitivesRuntimeConfig {
  readonly doState: DurableObjectState;
  readonly registry: PrimitiveRegistry;
  readonly tracker?: TrackerConfig;
}

interface PrimitivesRuntime {
  readonly handle: (request: PrimitiveRequest) => Promise<PrimitiveResponse>;
  readonly handleAlarm: () => Promise<void>;
  readonly flush: () => Promise<void>;
}

export function createPrimitivesRuntime(
  config: PrimitivesRuntimeConfig
): PrimitivesRuntime {
  // Build the Effect layer stack
  const coreLayer = createDurableObjectRuntime(config.doState);

  const trackerLayer = config.tracker
    ? HttpBatchTrackerLayer(config.tracker)
    : NoopTrackerLayer;

  const runtimeServicesLayer = RuntimeServicesLayer.pipe(
    Layer.provideMerge(trackerLayer),
    Layer.provideMerge(coreLayer),
  );

  const handlersLayer = PrimitiveHandlersLayer(config.registry).pipe(
    Layer.provideMerge(runtimeServicesLayer),
  );

  const dispatcherLayer = DispatcherLayer.pipe(
    Layer.provideMerge(handlersLayer),
  );

  // Helper to run effects
  const runEffect = <A>(effect: Effect.Effect<A, unknown, unknown>): Promise<A> =>
    Effect.runPromise(effect.pipe(Effect.provide(dispatcherLayer)));

  return {
    handle: (request) => runEffect(
      Effect.gen(function* () {
        const dispatcher = yield* Dispatcher;
        return yield* dispatcher.handle(request);
      })
    ),

    handleAlarm: () => runEffect(
      Effect.gen(function* () {
        const dispatcher = yield* Dispatcher;
        yield* dispatcher.handleAlarm();
      })
    ),

    flush: () => runEffect(flushEvents),
  };
}
```

---

## Dispatcher Implementation

```ts
// packages/primitives/src/runtime/dispatcher.ts

interface DispatcherService {
  readonly handle: (request: PrimitiveRequest) => Effect.Effect<PrimitiveResponse, PrimitiveError>;
  readonly handleAlarm: () => Effect.Effect<void, PrimitiveError>;
}

class Dispatcher extends Context.Tag("@durable-effect/primitives/Dispatcher")<
  Dispatcher,
  DispatcherService
>() {}

const DispatcherLayer = Layer.effect(
  Dispatcher,
  Effect.gen(function* () {
    const metadata = yield* MetadataService;
    const continuous = yield* ContinuousHandler;
    const buffer = yield* BufferHandler;
    const queue = yield* QueueHandler;

    return {
      handle: (request: PrimitiveRequest) =>
        Effect.gen(function* () {
          switch (request.type) {
            case "continuous":
              return yield* continuous.handle(request);
            case "buffer":
              return yield* buffer.handle(request);
            case "queue":
              return yield* queue.handle(request);
            default:
              return yield* Effect.fail(new UnknownPrimitiveTypeError(request));
          }
        }),

      handleAlarm: () =>
        Effect.gen(function* () {
          const meta = yield* metadata.get();

          // No metadata = instance was never initialized, nothing to do
          if (!meta) {
            return;
          }

          switch (meta.type) {
            case "continuous":
              return yield* continuous.handleAlarm();
            case "buffer":
              return yield* buffer.handleAlarm();
            case "queue":
              return yield* queue.handleAlarm();
            default:
              // Unknown type - log and ignore
              console.warn(`Unknown primitive type in alarm: ${meta.type}`);
          }
        }),
    };
  })
);
```

---

## Runtime Services

### MetadataService

```ts
// packages/primitives/src/services/metadata.ts

interface PrimitiveMetadata {
  readonly type: "continuous" | "buffer" | "queue";
  readonly name: string;
  readonly status: PrimitiveStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

type PrimitiveStatus =
  | "initializing"
  | "running"
  | "buffering"
  | "processing"
  | "idle"
  | "paused"
  | "stopped"
  | "completed";

interface MetadataServiceI {
  readonly initialize: (
    type: PrimitiveMetadata["type"],
    name: string
  ) => Effect.Effect<void, StorageError>;

  readonly get: () => Effect.Effect<PrimitiveMetadata | undefined, StorageError>;

  readonly updateStatus: (
    status: PrimitiveStatus
  ) => Effect.Effect<void, StorageError>;

  readonly delete: () => Effect.Effect<void, StorageError>;
}

class MetadataService extends Context.Tag("@durable-effect/primitives/MetadataService")<
  MetadataService,
  MetadataServiceI
>() {}

const MetadataServiceLayer = Layer.effect(
  MetadataService,
  Effect.gen(function* () {
    const storage = yield* StorageAdapter;
    const runtime = yield* RuntimeAdapter;

    return {
      initialize: (type, name) =>
        Effect.gen(function* () {
          const now = yield* runtime.now();
          yield* storage.set(KEYS.META, {
            type,
            name,
            status: "initializing" as PrimitiveStatus,
            createdAt: now,
            updatedAt: now,
          });
        }),

      get: () => storage.get<PrimitiveMetadata>(KEYS.META),

      updateStatus: (status) =>
        Effect.gen(function* () {
          const current = yield* storage.get<PrimitiveMetadata>(KEYS.META);
          if (!current) return;
          const now = yield* runtime.now();
          yield* storage.set(KEYS.META, { ...current, status, updatedAt: now });
        }),

      delete: () => storage.delete(KEYS.META),
    };
  })
);
```

### EntityStateService

```ts
// packages/primitives/src/services/entity-state.ts

interface EntityStateServiceI<S> {
  readonly get: () => Effect.Effect<S | null, StorageError>;
  readonly set: (state: S) => Effect.Effect<void, StorageError | ValidationError>;
  readonly update: (fn: (s: S) => S) => Effect.Effect<void, StorageError | ValidationError>;
  readonly delete: () => Effect.Effect<void, StorageError>;
}

/**
 * Creates an EntityStateService for a specific schema.
 * This is called by handlers to create state services typed to their schema.
 */
function createEntityStateService<S>(
  schema: Schema.Schema<S>
): Effect.Effect<EntityStateServiceI<S>, never, StorageAdapter> {
  return Effect.gen(function* () {
    const storage = yield* StorageAdapter;
    const decode = Schema.decodeUnknownSync(schema);
    const encode = Schema.encodeSync(schema);

    return {
      get: () =>
        Effect.gen(function* () {
          const raw = yield* storage.get(KEYS.STATE);
          if (raw === undefined) return null;
          try {
            return decode(raw);
          } catch (e) {
            return yield* Effect.fail(new ValidationError({ schema: schema.ast, issues: e }));
          }
        }),

      set: (state) =>
        Effect.gen(function* () {
          const encoded = encode(state);
          yield* storage.set(KEYS.STATE, encoded);
        }),

      update: (fn) =>
        Effect.gen(function* () {
          const current = yield* storage.get(KEYS.STATE);
          if (current === undefined) return;
          const decoded = decode(current);
          const updated = fn(decoded);
          const encoded = encode(updated);
          yield* storage.set(KEYS.STATE, encoded);
        }),

      delete: () => storage.delete(KEYS.STATE),
    };
  });
}
```

### AlarmService

```ts
// packages/primitives/src/services/alarm.ts

interface AlarmServiceI {
  readonly schedule: (
    when: Duration.DurationInput | number | Date
  ) => Effect.Effect<void, SchedulerError>;

  readonly cancel: () => Effect.Effect<void, SchedulerError>;

  readonly getScheduled: () => Effect.Effect<number | undefined, SchedulerError>;
}

class AlarmService extends Context.Tag("@durable-effect/primitives/AlarmService")<
  AlarmService,
  AlarmServiceI
>() {}

const AlarmServiceLayer = Layer.effect(
  AlarmService,
  Effect.gen(function* () {
    const scheduler = yield* SchedulerAdapter;
    const runtime = yield* RuntimeAdapter;

    return {
      schedule: (when) =>
        Effect.gen(function* () {
          let timestamp: number;

          if (typeof when === "number") {
            timestamp = when;
          } else if (when instanceof Date) {
            timestamp = when.getTime();
          } else {
            // Duration - convert to absolute timestamp
            const now = yield* runtime.now();
            const ms = Duration.toMillis(Duration.decode(when));
            timestamp = now + ms;
          }

          yield* scheduler.schedule(timestamp);
        }),

      cancel: () => scheduler.cancel(),

      getScheduled: () => scheduler.getScheduled(),
    };
  })
);
```

### IdempotencyService

```ts
// packages/primitives/src/services/idempotency.ts

interface IdempotencyServiceI {
  readonly check: (eventId: string) => Effect.Effect<boolean, StorageError>;
  readonly mark: (eventId: string) => Effect.Effect<void, StorageError>;
}

class IdempotencyService extends Context.Tag("@durable-effect/primitives/IdempotencyService")<
  IdempotencyService,
  IdempotencyServiceI
>() {}

const IdempotencyServiceLayer = Layer.effect(
  IdempotencyService,
  Effect.gen(function* () {
    const storage = yield* StorageAdapter;
    const runtime = yield* RuntimeAdapter;

    return {
      check: (eventId) =>
        Effect.gen(function* () {
          const key = `${KEYS.IDEMPOTENCY}${eventId}`;
          const exists = yield* storage.get(key);
          return exists !== undefined;
        }),

      mark: (eventId) =>
        Effect.gen(function* () {
          const key = `${KEYS.IDEMPOTENCY}${eventId}`;
          const now = yield* runtime.now();
          yield* storage.set(key, { processedAt: now });
        }),
    };
  })
);
```

---

## Handler Pattern

Each primitive implements a handler with `handle(request)` and `handleAlarm()`:

```ts
// packages/primitives/src/handlers/continuous/handler.ts

interface ContinuousHandlerI {
  readonly handle: (request: ContinuousRequest) => Effect.Effect<ContinuousResponse, PrimitiveError>;
  readonly handleAlarm: () => Effect.Effect<void, PrimitiveError>;
}

class ContinuousHandler extends Context.Tag("@durable-effect/primitives/ContinuousHandler")<
  ContinuousHandler,
  ContinuousHandlerI
>() {}

const ContinuousHandlerLayer = (registry: PrimitiveRegistry) =>
  Layer.effect(
    ContinuousHandler,
    Effect.gen(function* () {
      const metadata = yield* MetadataService;
      const alarm = yield* AlarmService;
      const runtime = yield* RuntimeAdapter;
      const tracker = yield* EventTracker;

      return {
        handle: (request) =>
          Effect.gen(function* () {
            const def = registry.continuous.get(request.name);
            if (!def) {
              return yield* Effect.fail(
                new PrimitiveNotFoundError({ type: "continuous", name: request.name })
              );
            }

            // Create state service scoped to this primitive's schema
            const state = yield* createEntityStateService(def.stateSchema);

            switch (request.action) {
              case "start":
                return yield* handleStart(def, state, metadata, alarm, runtime, tracker, request);
              case "stop":
                return yield* handleStop(def, state, metadata, alarm, request);
              case "trigger":
                return yield* handleTrigger(def, state, alarm);
              case "status":
                return yield* handleStatus(metadata, alarm);
              case "getState":
                return yield* handleGetState(state);
            }
          }),

        handleAlarm: () =>
          Effect.gen(function* () {
            const meta = yield* metadata.get();
            if (!meta || meta.status === "stopped") return;

            const def = registry.continuous.get(meta.name);
            if (!def) return;

            const state = yield* createEntityStateService(def.stateSchema);

            // Execute the user's function
            yield* ContinuousExecutor.execute(def, state, metadata, runtime);

            // Schedule next execution
            yield* scheduleNext(def, alarm, runtime);

            // Emit tracking event
            yield* tracker.emit({
              type: "continuous.executed",
              primitiveName: meta.name,
              instanceId: runtime.instanceId,
              timestamp: yield* runtime.now(),
            });
          }),
      };
    })
  );

// Handler functions
const handleStart = (def, state, metadata, alarm, runtime, tracker, request) =>
  Effect.gen(function* () {
    // Check if already exists
    const existing = yield* metadata.get();
    if (existing) {
      return {
        instanceId: runtime.instanceId,
        created: false,
        status: existing.status,
      };
    }

    // Initialize
    yield* metadata.initialize("continuous", request.name);
    yield* state.set(request.input);
    yield* metadata.updateStatus("running");

    // Execute immediately if configured
    if (def.startImmediately !== false) {
      yield* ContinuousExecutor.execute(def, state, metadata, runtime);
    }

    // Schedule next execution
    yield* scheduleNext(def, alarm, runtime);

    // Emit tracking event
    yield* tracker.emit({
      type: "continuous.started",
      primitiveName: request.name,
      instanceId: runtime.instanceId,
      timestamp: yield* runtime.now(),
    });

    return {
      instanceId: runtime.instanceId,
      created: true,
      status: "running" as PrimitiveStatus,
    };
  });

const scheduleNext = (def, alarm, runtime) =>
  Effect.gen(function* () {
    const schedule = def.schedule;

    switch (schedule._tag) {
      case "Every":
        yield* alarm.schedule(schedule.interval);
        break;
      case "Cron":
        // Calculate next cron time
        const nextTime = calculateNextCronTime(schedule.expression, yield* runtime.now());
        yield* alarm.schedule(nextTime);
        break;
      case "Schedule":
        // Effect Schedule - more complex, handle separately
        // ...
        break;
    }
  });
```

---

## Adding a New Primitive

To add a new primitive type (e.g., "Timer"):

### Step 1: Define API

Create `primatives/api/00X-timer-primitive-api-design.md` with:
- `Timer.make(config)` factory
- `TimerContext` provided to execute
- Client methods

### Step 2: Create Handler

```
packages/primitives/src/handlers/timer/
├── index.ts
├── handler.ts      # TimerHandler with handle() and handleAlarm()
├── executor.ts     # TimerExecutor - runs user's execute function
└── types.ts        # TimerRequest, TimerResponse, etc.
```

### Step 3: Register Handler

```ts
// packages/primitives/src/handlers/index.ts
export const PrimitiveHandlersLayer = (registry: PrimitiveRegistry) =>
  Layer.mergeAll(
    ContinuousHandlerLayer(registry),
    BufferHandlerLayer(registry),
    QueueHandlerLayer(registry),
    TimerHandlerLayer(registry),  // Add new handler
  );
```

### Step 4: Update Dispatcher

```ts
// packages/primitives/src/runtime/dispatcher.ts
switch (request.type) {
  case "continuous": ...
  case "buffer": ...
  case "queue": ...
  case "timer":                    // Add new case
    return yield* timer.handle(request);
}
```

### Step 5: Add Client Methods

```ts
// packages/primitives/src/client/client.ts
timer: (name: string) => ({
  start: ({ id, duration }) => {
    const instanceId = `timer:${name}:${id}`;
    const stub = binding.get(binding.idFromName(instanceId));
    return stub.call({
      type: "timer",
      action: "start",
      name,
      id,
      duration,
    });
  },
  // ... other methods
}),
```

**Notice:** The DO class is NOT modified. Adding primitives only touches:
- Handler code
- Dispatcher switch cases
- Client methods

---

## Storage Key Namespace

```ts
// packages/primitives/src/storage-keys.ts
export const KEYS = {
  // Metadata (all primitives)
  META: "meta",

  // User state
  STATE: "state",

  // Continuous-specific
  CONTINUOUS: {
    RUN_COUNT: "cont:runCount",
    LAST_EXECUTED_AT: "cont:lastAt",
  },

  // Buffer-specific
  BUFFER: {
    EVENT_COUNT: "buf:count",
    STARTED_AT: "buf:startedAt",
  },

  // Queue-specific
  QUEUE: {
    EVENTS: "q:events:",      // prefix: q:events:{eventId}
    PENDING: "q:pending",     // array of pending event IDs
    PROCESSED: "q:processed",
    CURRENT: "q:current",
    ATTEMPT: "q:attempt",
    PAUSED: "q:paused",
  },

  // Idempotency
  IDEMPOTENCY: "idem:",  // prefix: idem:{eventId}
} as const;
```

---

## Testing Strategy

The runtime is platform-agnostic, making testing straightforward:

```ts
// test/helpers.ts
import { createTestRuntime } from "@durable-effect/core";
import { createPrimitivesRuntime } from "@durable-effect/primitives";

export async function createTestPrimitivesRuntime(
  registry: PrimitiveRegistry
) {
  const { layer: coreLayer, handles } = await Effect.runPromise(
    createTestRuntime()
  );

  // Create runtime using test adapters
  const runtime = createPrimitivesRuntimeFromLayer(coreLayer, registry);

  return {
    runtime,
    handles,  // For time control, storage inspection
  };
}

// test/continuous.test.ts
describe("Continuous", () => {
  it("executes on schedule", async () => {
    const { runtime, handles } = await createTestPrimitivesRuntime({
      continuous: new Map([["tokenRefresher", tokenRefresherDef]]),
    });

    // Start
    await runtime.handle({
      type: "continuous",
      action: "start",
      name: "tokenRefresher",
      id: "user-123",
      input: { refreshToken: "rt_abc" },
    });

    // Advance time past schedule
    await Effect.runPromise(handles.advanceTime(Duration.toMillis("30 minutes")));

    // Trigger alarm
    await runtime.handleAlarm();

    // Verify execution
    const state = await runtime.handle({
      type: "continuous",
      action: "getState",
      name: "tokenRefresher",
      id: "user-123",
    });

    expect(state.value.accessToken).toBeDefined();
  });
});
```

---

## Implementation Phases

### Phase 1: Runtime Foundation

**Goal:** Build the runtime infrastructure without any primitives.

```
packages/primitives/src/
├── runtime/
│   ├── index.ts
│   ├── runtime.ts          # createPrimitivesRuntime
│   ├── dispatcher.ts       # Dispatcher (empty switch for now)
│   └── types.ts            # PrimitiveRequest, PrimitiveResponse
├── services/
│   ├── index.ts
│   ├── metadata.ts         # MetadataService
│   ├── entity-state.ts     # createEntityStateService
│   ├── alarm.ts            # AlarmService
│   └── idempotency.ts      # IdempotencyService
├── storage-keys.ts
├── errors.ts
└── index.ts
```

**Tests:** Unit tests for each service using `createTestRuntime`.

### Phase 2: DO Shell & Client Foundation

**Goal:** Build the thin DO class and client routing.

```
packages/primitives/src/
├── engine/
│   ├── index.ts
│   ├── engine.ts           # DurablePrimitivesEngine (thin shell)
│   └── types.ts
├── client/
│   ├── index.ts
│   ├── client.ts           # PrimitivesClient factory
│   └── types.ts
├── registry/
│   ├── index.ts
│   ├── registry.ts         # createPrimitiveRegistry
│   └── types.ts
└── factory.ts              # createDurablePrimitives
```

**Tests:** Integration tests with mock DO bindings.

### Phase 3: Continuous Handler

**Goal:** Implement first primitive handler.

```
packages/primitives/src/
└── handlers/
    ├── index.ts
    └── continuous/
        ├── index.ts
        ├── handler.ts
        ├── executor.ts
        ├── context.ts
        └── types.ts
```

**Tests:** Full lifecycle tests (start, alarm, stop, trigger).

### Phase 4: Buffer Handler

```
packages/primitives/src/
└── handlers/
    └── buffer/
        ├── index.ts
        ├── handler.ts
        ├── executor.ts
        ├── context.ts
        └── types.ts
```

**Tests:** Event accumulation, flush triggers, idempotency.

### Phase 5: Queue Handler

```
packages/primitives/src/
└── handlers/
    └── queue/
        ├── index.ts
        ├── handler.ts
        ├── executor.ts
        ├── context.ts
        ├── backoff.ts
        └── types.ts
```

**Tests:** FIFO ordering, retries, dead letter, pause/resume.

---

## File Structure

```
packages/primitives/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts                  # Public exports
    ├── factory.ts                # createDurablePrimitives
    ├── storage-keys.ts           # Centralized storage keys
    ├── errors.ts                 # Error types
    │
    ├── runtime/
    │   ├── index.ts
    │   ├── runtime.ts            # createPrimitivesRuntime
    │   ├── dispatcher.ts         # Dispatcher service
    │   └── types.ts              # Request/Response types
    │
    ├── services/
    │   ├── index.ts
    │   ├── metadata.ts           # MetadataService
    │   ├── entity-state.ts       # createEntityStateService
    │   ├── alarm.ts              # AlarmService
    │   └── idempotency.ts        # IdempotencyService
    │
    ├── engine/
    │   ├── index.ts
    │   ├── engine.ts             # DurablePrimitivesEngine (thin!)
    │   └── types.ts
    │
    ├── client/
    │   ├── index.ts
    │   ├── client.ts             # PrimitivesClient factory
    │   └── types.ts
    │
    ├── registry/
    │   ├── index.ts
    │   ├── registry.ts
    │   └── types.ts
    │
    ├── handlers/
    │   ├── index.ts              # Exports all handlers
    │   ├── continuous/
    │   │   ├── index.ts
    │   │   ├── handler.ts
    │   │   ├── executor.ts
    │   │   ├── context.ts
    │   │   ├── definition.ts     # Continuous.make()
    │   │   └── types.ts
    │   ├── buffer/
    │   │   ├── index.ts
    │   │   ├── handler.ts
    │   │   ├── executor.ts
    │   │   ├── context.ts
    │   │   ├── definition.ts     # Buffer.make()
    │   │   └── types.ts
    │   └── queue/
    │       ├── index.ts
    │       ├── handler.ts
    │       ├── executor.ts
    │       ├── context.ts
    │       ├── definition.ts     # Queue.make()
    │       ├── backoff.ts
    │       └── types.ts
    │
    └── testing/
        ├── index.ts
        └── helpers.ts            # createTestPrimitivesRuntime

test/
├── services/
│   ├── metadata.test.ts
│   ├── entity-state.test.ts
│   ├── alarm.test.ts
│   └── idempotency.test.ts
├── handlers/
│   ├── continuous.test.ts
│   ├── buffer.test.ts
│   └── queue.test.ts
└── integration/
    └── runtime.test.ts
```

---

## Summary

This refined architecture provides:

1. **Thin DO shell** - The DO class has exactly 2 methods: `call()` and `alarm()`. It knows nothing about primitive types.

2. **Swappable runtime** - The `PrimitivesRuntime` can be backed by DO storage, in-memory storage, or any other implementation. This makes testing trivial.

3. **Clean service layer** - Higher-level services (MetadataService, EntityStateService, AlarmService, IdempotencyService) provide Duration support, schema validation, etc. on top of raw adapters.

4. **Independent handlers** - Each primitive type is self-contained. Adding a new primitive doesn't modify the DO class.

5. **Request/response protocol** - Clean contract between client and runtime via typed requests/responses.

6. **Leverages core** - All platform adapters come from `@durable-effect/core`, ensuring consistency with the workflow package.

The key insight: **The DO is just a platform that provides storage + alarm. The Primitives Runtime is the abstraction layer that makes everything else possible.**
