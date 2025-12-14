# Primitives Implementation Architecture

This document provides a focused, implementation-oriented architecture for `@durable-effect/primitives`. It defines the exact layers, components, and phased implementation plan.

---

## 1. Key Design Decisions

| Decision | Description |
|----------|-------------|
| **RPC-based Engine** | DO class exposes typed RPC methods (like workflow's `run`, `alarm`, `cancel`) not fetch |
| **Shared Core** | All adapters, errors, and testing utilities come from `@durable-effect/core` |
| **Single DO Class** | One `DurablePrimitivesEngine` handles all primitive types |
| **Client Routing** | Client resolves instance IDs before calling DO |
| **Phased Implementation** | Build core infrastructure first, then primitives one by one |

---

## 2. Layer Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              USER CODE                                       │
│  const { Primitives, PrimitivesClient } = createDurablePrimitives({...})    │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │
┌─────────────────────────────────────▼───────────────────────────────────────┐
│                          CLIENT LAYER                                        │
│                                                                              │
│  PrimitivesClient.fromBinding(env.PRIMITIVES)                               │
│    ├── continuous(name) → ContinuousClient { start, stop, trigger, ... }    │
│    ├── buffer(name) → BufferClient { add, flush, clear, ... }               │
│    └── queue(name) → QueueClient { enqueue, pause, resume, ... }            │
│                                                                              │
│  Responsibilities:                                                           │
│    • Resolve instance ID: `{type}:{name}:{id}`                              │
│    • Route Queue events across N instances (round-robin / partition)        │
│    • Call DO RPC methods                                                     │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │ RPC calls to DO
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          ENGINE LAYER                                        │
│                                                                              │
│  class DurablePrimitivesEngine extends DurableObject {                      │
│    // RPC Methods (like workflow's run, runAsync, alarm, cancel)            │
│    continuousStart(call) → Promise<StartResult>                             │
│    continuousStop(id, opts) → Promise<StopResult>                           │
│    continuousTrigger(id) → Promise<void>                                    │
│    continuousStatus(id) → Promise<Status>                                   │
│    continuousGetState(id) → Promise<State>                                  │
│                                                                              │
│    bufferAdd(call) → Promise<AddResult>                                     │
│    bufferFlush(id) → Promise<FlushResult>                                   │
│    bufferClear(id) → Promise<ClearResult>                                   │
│    bufferStatus(id) → Promise<Status>                                       │
│    bufferGetState(id) → Promise<State>                                      │
│                                                                              │
│    queueEnqueue(call) → Promise<EnqueueResult>                              │
│    queuePause(idx?) → Promise<void>                                         │
│    queueResume(idx?) → Promise<void>                                        │
│    queueCancel(eventId) → Promise<CancelResult>                             │
│    queueStatus() → Promise<Status>                                          │
│                                                                              │
│    alarm() → Promise<void>  // Routes to correct primitive type             │
│  }                                                                           │
│                                                                              │
│  Responsibilities:                                                           │
│    • Construct Layer stack                                                   │
│    • Run Effects with layer                                                  │
│    • Route alarm() to correct primitive orchestrator                        │
│    • Fire-and-forget event flushing via waitUntil                           │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       ORCHESTRATOR LAYER                                     │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                    PrimitiveOrchestrator                              │   │
│  │  • Determines primitive type from stored metadata                     │   │
│  │  • Routes to type-specific orchestrator                               │   │
│  │  • handleAlarm() dispatches based on primitiveType                    │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                      │                                       │
│           ┌──────────────────────────┼──────────────────────────┐           │
│           ▼                          ▼                          ▼           │
│  ┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐     │
│  │   Continuous    │      │     Buffer      │      │      Queue      │     │
│  │  Orchestrator   │      │  Orchestrator   │      │  Orchestrator   │     │
│  │                 │      │                 │      │                 │     │
│  │  handleStart()  │      │  handleAdd()    │      │  handleEnqueue()│     │
│  │  handleStop()   │      │  handleFlush()  │      │  handlePause()  │     │
│  │  handleTrigger()│      │  handleClear()  │      │  handleResume() │     │
│  │  handleAlarm()  │      │  handleAlarm()  │      │  handleAlarm()  │     │
│  └────────┬────────┘      └────────┬────────┘      └────────┬────────┘     │
│           │                        │                        │               │
└───────────┼────────────────────────┼────────────────────────┼───────────────┘
            │                        │                        │
            ▼                        ▼                        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         EXECUTOR LAYER                                       │
│                                                                              │
│  ┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐     │
│  │   Continuous    │      │     Buffer      │      │      Queue      │     │
│  │    Executor     │      │    Executor     │      │    Executor     │     │
│  │                 │      │                 │      │                 │     │
│  │ • run execute() │      │ • run onEvent() │      │ • run execute() │     │
│  │ • schedule next │      │ • run execute() │      │ • process next  │     │
│  │ • manage state  │      │ • flush state   │      │ • retry logic   │     │
│  └─────────────────┘      └─────────────────┘      └─────────────────┘     │
│                                                                              │
│  Each executor:                                                              │
│    • Executes user-defined functions with typed context                     │
│    • Updates state via StateManager                                          │
│    • Schedules alarms via ScheduleManager                                    │
│    • Emits events via EventTracker                                           │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      SHARED SERVICES LAYER                                   │
│                    (Primitives-specific services)                            │
│                                                                              │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐                 │
│  │   Metadata     │  │     State      │  │   Schedule     │                 │
│  │   Manager      │  │    Manager     │  │   Manager      │                 │
│  │                │  │                │  │                │                 │
│  │ • primitiveType│  │ • get/set      │  │ • schedule()   │                 │
│  │ • primitiveName│  │ • schema       │  │ • cancel()     │                 │
│  │ • status       │  │   validation   │  │ • getScheduled │                 │
│  └────────────────┘  └────────────────┘  └────────────────┘                 │
│                                                                              │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐                 │
│  │  Idempotency   │  │     Purge      │  │    Event       │                 │
│  │   Manager      │  │    Manager     │  │   Tracker      │                 │
│  │                │  │                │  │                │                 │
│  │ • hasProcessed │  │ • purgeNow()   │  │ • emit()       │                 │
│  │ • markProcessed│  │ • schedulePurge│  │ • flush()      │                 │
│  └────────────────┘  └────────────────┘  └────────────────┘                 │
│                                                                              │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         CORE LAYER                                           │
│                   (from @durable-effect/core)                                │
│                                                                              │
│  Adapters (platform abstraction):                                            │
│    • StorageAdapter      - Key-value storage                                 │
│    • SchedulerAdapter    - Alarm scheduling                                  │
│    • RuntimeAdapter      - instanceId, now()                                 │
│                                                                              │
│  DO Adapters (Cloudflare implementation):                                    │
│    • createDurableObjectRuntime(state) → RuntimeLayer                        │
│                                                                              │
│  Errors:                                                                     │
│    • StorageError, SchedulerError                                            │
│                                                                              │
│  Tracker:                                                                    │
│    • EventTracker (generic), NoopTrackerLayer                                │
│                                                                              │
│  Testing:                                                                    │
│    • createInMemoryRuntime, createTestRuntime                                │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Component Inventory

### 3.1 From `@durable-effect/core` (Already Exists)

| Component | Purpose |
|-----------|---------|
| `StorageAdapter` | Key-value storage interface |
| `SchedulerAdapter` | Alarm scheduling interface |
| `RuntimeAdapter` | Runtime utilities (instanceId, now) |
| `StorageError` | Storage operation errors |
| `SchedulerError` | Scheduler operation errors |
| `createDurableObjectRuntime` | Creates RuntimeLayer from DO state |
| `EventTracker` | Generic event tracking service |
| `NoopTrackerLayer` | Disabled tracking layer |
| `createTestRuntime` | In-memory runtime for testing |

### 3.2 Primitives Core (To Build)

| Component | Purpose | Phase |
|-----------|---------|-------|
| `MetadataManager` | Track primitive type, name, status | 1 |
| `StateManager` | Schema-validated state get/set | 1 |
| `ScheduleManager` | Higher-level scheduling (Duration support) | 1 |
| `IdempotencyManager` | Event deduplication (Buffer, Queue) | 1 |
| `PurgeManager` | Data cleanup after completion | 1 |
| `PrimitiveError` types | Primitives-specific errors | 1 |
| `PrimitiveEvent` types | Primitives-specific tracking events | 1 |

### 3.3 Engine & Client (To Build)

| Component | Purpose | Phase |
|-----------|---------|-------|
| `DurablePrimitivesEngine` | DO class with RPC methods | 2 |
| `PrimitiveOrchestrator` | Routes requests to type orchestrators | 2 |
| `PrimitivesClient` | Client factory with typed accessors | 2 |
| `PrimitiveRegistry` | Holds primitive definitions | 2 |
| `createDurablePrimitives` | Main factory function | 2 |

### 3.4 Continuous Primitive (To Build)

| Component | Purpose | Phase |
|-----------|---------|-------|
| `Continuous.make` | Definition factory | 3 |
| `ContinuousOrchestrator` | Handles continuous operations | 3 |
| `ContinuousExecutor` | Executes user function, schedules next | 3 |
| `ContinuousContext` | Context provided to execute() | 3 |
| `ContinuousClient` | Typed client for continuous | 3 |

### 3.5 Buffer Primitive (To Build)

| Component | Purpose | Phase |
|-----------|---------|-------|
| `Buffer.make` | Definition factory | 4 |
| `BufferOrchestrator` | Handles buffer operations | 4 |
| `BufferExecutor` | Executes onEvent/execute, manages flush | 4 |
| `BufferEventContext` | Context for onEvent() | 4 |
| `BufferExecuteContext` | Context for execute() | 4 |
| `BufferClient` | Typed client for buffer | 4 |

### 3.6 Queue Primitive (To Build)

| Component | Purpose | Phase |
|-----------|---------|-------|
| `Queue.make` | Definition factory | 5 |
| `QueueOrchestrator` | Handles queue operations | 5 |
| `QueueExecutor` | Processes events, handles retries | 5 |
| `QueueExecuteContext` | Context for execute() | 5 |
| `QueueClient` | Typed client with routing logic | 5 |
| `Backoff` utilities | Exponential/linear backoff | 5 |

---

## 4. Implementation Phases

### Phase 1: Primitives Core Infrastructure

**Goal:** Build shared services that all primitives need.

**Files to create:**

```
packages/primitives/src/
├── errors/
│   └── index.ts                    # PrimitiveError types
├── events/
│   └── index.ts                    # PrimitiveEvent types
├── services/
│   ├── index.ts                    # Exports
│   ├── metadata.ts                 # MetadataManager
│   ├── state.ts                    # StateManager factory
│   ├── schedule.ts                 # ScheduleManager
│   ├── idempotency.ts              # IdempotencyManager
│   └── purge.ts                    # PurgeManager
└── storage-keys.ts                 # Centralized key constants
```

**Key interfaces:**

```ts
// MetadataManager - tracks what primitive this instance is
interface MetadataManagerService {
  readonly initialize: (
    type: "continuous" | "buffer" | "queue",
    name: string,
  ) => Effect.Effect<void, StorageError>;
  readonly get: () => Effect.Effect<PrimitiveMetadata | undefined, StorageError>;
  readonly updateStatus: (status: PrimitiveStatus) => Effect.Effect<void, StorageError>;
}

// StateManager - generic schema-validated state
interface StateManagerService<S> {
  readonly get: () => Effect.Effect<S | null, StorageError>;
  readonly set: (state: S) => Effect.Effect<void, StorageError>;
  readonly update: (fn: (s: S) => S) => Effect.Effect<void, StorageError>;
  readonly delete: () => Effect.Effect<void, StorageError>;
}

// ScheduleManager - wraps SchedulerAdapter with Duration support
interface ScheduleManagerService {
  readonly schedule: (when: Duration.DurationInput | number | Date) => Effect.Effect<void, SchedulerError>;
  readonly cancel: () => Effect.Effect<void, SchedulerError>;
  readonly getScheduled: () => Effect.Effect<number | undefined, SchedulerError>;
}
```

**Tests:** Unit tests for each service using `createTestRuntime`.

---

### Phase 2: Engine & Client Framework

**Goal:** Build the DO class and client routing infrastructure.

**Files to create:**

```
packages/primitives/src/
├── registry/
│   ├── index.ts                    # Exports
│   ├── types.ts                    # Definition types
│   └── registry.ts                 # createPrimitiveRegistry
├── orchestrator/
│   ├── index.ts                    # Exports
│   ├── types.ts                    # Request/Response types
│   └── orchestrator.ts             # PrimitiveOrchestrator
├── engine/
│   ├── index.ts                    # Exports
│   ├── types.ts                    # Engine interfaces
│   └── engine.ts                   # DurablePrimitivesEngine
├── client/
│   ├── index.ts                    # Exports
│   ├── types.ts                    # Client types
│   └── client.ts                   # PrimitivesClient factory
└── factory.ts                      # createDurablePrimitives
```

**Engine RPC pattern (like workflow):**

```ts
class DurablePrimitivesEngine extends DurableObject {
  #orchestratorLayer: Layer.Layer<...>;

  constructor(state: DurableObjectState, env: unknown) {
    super(state, env);

    const runtimeLayer = createDurableObjectRuntime(state);
    const trackerLayer = env.__TRACKING_CONFIG__?.enabled
      ? HttpBatchTrackerLayer(env.__TRACKING_CONFIG__)
      : NoopTrackerLayer;

    this.#orchestratorLayer = PrimitiveOrchestratorLayer(env.__REGISTRY__).pipe(
      Layer.provideMerge(MetadataManagerLayer),
      Layer.provideMerge(ScheduleManagerLayer),
      Layer.provideMerge(IdempotencyManagerLayer),
      Layer.provideMerge(PurgeManagerLayer),
      Layer.provideMerge(trackerLayer),
      Layer.provideMerge(runtimeLayer),
    );
  }

  #runEffect<A>(effect: Effect.Effect<A, unknown, unknown>): Promise<A> {
    return Effect.runPromise(
      effect.pipe(Effect.provide(this.#orchestratorLayer))
    );
  }

  // Continuous RPC methods
  async continuousStart(call: ContinuousStartCall): Promise<ContinuousStartResult> {
    return this.#runEffect(
      Effect.gen(function* () {
        const orchestrator = yield* PrimitiveOrchestrator;
        return yield* orchestrator.continuousStart(call);
      })
    );
  }

  // Buffer RPC methods
  async bufferAdd(call: BufferAddCall): Promise<BufferAddResult> { ... }

  // Queue RPC methods
  async queueEnqueue(call: QueueEnqueueCall): Promise<QueueEnqueueResult> { ... }

  // Alarm handler - routes based on stored metadata
  async alarm(): Promise<void> {
    await this.#runEffect(
      Effect.gen(function* () {
        const orchestrator = yield* PrimitiveOrchestrator;
        yield* orchestrator.handleAlarm();
      })
    );
  }
}
```

**Client routing:**

```ts
const PrimitivesClient = {
  fromBinding: (binding: DurableObjectNamespace, registry: PrimitiveRegistry) => ({
    continuous: (name: string) => ({
      start: ({ id, input }) => {
        const instanceId = `continuous:${name}:${id}`;
        const stub = binding.get(binding.idFromName(instanceId));
        return stub.continuousStart({ name, id, input });
      },
      // ...
    }),

    buffer: (name: string) => ({ ... }),

    queue: (name: string) => {
      const def = registry.queue.get(name);
      const concurrency = def?.concurrency ?? 1;

      return {
        enqueue: ({ id, event, partitionKey }) => {
          // Route to specific instance
          const instanceIndex = partitionKey
            ? consistentHash(partitionKey, concurrency)
            : roundRobin(name, concurrency);
          const instanceId = `queue:${name}:${instanceIndex}`;
          const stub = binding.get(binding.idFromName(instanceId));
          return stub.queueEnqueue({ name, eventId: id, event });
        },
        // ...
      };
    },
  }),
};
```

**Tests:** Integration tests using miniflare or mock DO bindings.

---

### Phase 3: Continuous Primitive

**Goal:** Implement the simplest primitive - scheduled execution.

**Files to create:**

```
packages/primitives/src/
├── primitives/
│   └── continuous/
│       ├── index.ts                # Exports
│       ├── definition.ts           # ContinuousConfig, Continuous.make
│       ├── context.ts              # ContinuousContext
│       ├── executor.ts             # ContinuousExecutor
│       ├── orchestrator.ts         # ContinuousOrchestrator
│       └── client.ts               # ContinuousClient type
```

**Execution flow:**

```
start(input)
  → MetadataManager.initialize("continuous", name)
  → StateManager.set(input)
  → if startImmediately: Executor.execute()
  → ScheduleManager.schedule(interval)
  → return { instanceId, created: true }

alarm() [when primitiveType === "continuous"]
  → Executor.execute()
    → load state
    → run user's execute(ctx)
    → save updated state
    → schedule next execution
  → EventTracker.emit("continuous.executed")
```

**API (from design doc):**

```ts
const tokenRefresher = Continuous.make({
  stateSchema: Schema.Struct({
    accessToken: Schema.NullOr(Schema.String),
    refreshToken: Schema.String,
  }),
  schedule: Continuous.every("30 minutes"),
  startImmediately: true,
  execute: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.state;
      // ... refresh token
      yield* ctx.setState({ ...state, accessToken: newToken });
      yield* ctx.schedule("25 minutes"); // Override next schedule
    }),
});
```

**Tests:** Full lifecycle tests (start, alarm, stop).

---

### Phase 4: Buffer Primitive

**Goal:** Add event accumulation and flush pattern.

**Files to create:**

```
packages/primitives/src/
├── primitives/
│   └── buffer/
│       ├── index.ts                # Exports
│       ├── definition.ts           # BufferConfig, Buffer.make
│       ├── context.ts              # BufferEventContext, BufferExecuteContext
│       ├── executor.ts             # BufferExecutor
│       ├── orchestrator.ts         # BufferOrchestrator
│       └── client.ts               # BufferClient type
```

**Execution flow:**

```
add(event)
  → IdempotencyManager.hasProcessed(eventId)? return duplicate
  → if first event:
      MetadataManager.initialize("buffer", name)
      ScheduleManager.schedule(flushAfter)
  → Executor.handleEvent(event)
    → run user's onEvent(ctx) OR default (keep latest)
    → StateManager.set(newState)
    → eventCount++
  → if eventCount >= maxEvents: flush()
  → return { eventCount, willFlushAt }

alarm() [when primitiveType === "buffer"]
  → Executor.flush()
    → load state
    → run user's execute(ctx)
    → StateManager.delete()
    → ScheduleManager.cancel()
    → MetadataManager.updateStatus("idle")
  → EventTracker.emit("buffer.flushed")
```

**API (from design doc):**

```ts
const webhookBuffer = Buffer.make({
  eventSchema: WebhookEvent,
  flushAfter: "5 minutes",
  maxEvents: 20,
  onEvent: (ctx) => Effect.succeed({
    ...ctx.state,
    events: [...(ctx.state?.events ?? []), ctx.event],
  }),
  execute: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.state;
      yield* sendConsolidatedNotification(state);
    }),
});
```

**Tests:** Event accumulation, flush triggers, idempotency.

---

### Phase 5: Queue Primitive

**Goal:** Add FIFO processing with retries and concurrency.

**Files to create:**

```
packages/primitives/src/
├── primitives/
│   └── queue/
│       ├── index.ts                # Exports
│       ├── definition.ts           # QueueConfig, Queue.make
│       ├── context.ts              # QueueExecuteContext, QueueDeadLetterContext
│       ├── executor.ts             # QueueExecutor
│       ├── orchestrator.ts         # QueueOrchestrator
│       ├── client.ts               # QueueClient type (with routing)
│       └── backoff.ts              # Backoff utilities
```

**Execution flow:**

```
enqueue(event) [routed to instance by client]
  → IdempotencyManager.hasProcessed(eventId)? return duplicate
  → if first event: MetadataManager.initialize("queue", name)
  → store event in queue: `queue:events:{eventId}`
  → add to pending list: `queue:pending`
  → if idle: ScheduleManager.schedule(now)
  → return { position, instanceIndex }

alarm() [when primitiveType === "queue"]
  → if paused: return
  → pop next event from pending
  → Executor.execute(event)
    → run user's execute(ctx)
    → on success:
        IdempotencyManager.markProcessed(eventId)
        delete event
    → on failure:
        if attempt < maxAttempts:
          schedule retry with backoff
        else:
          run onDeadLetter
          delete event
  → if more pending: schedule next
  → else: idle
```

**API (from design doc):**

```ts
const webhookProcessor = Queue.make({
  eventSchema: WebhookEvent,
  concurrency: 5,
  retry: {
    maxAttempts: 3,
    delay: Backoff.exponential({ base: "1 second" }),
  },
  execute: (ctx) =>
    Effect.gen(function* () {
      const event = yield* ctx.event;
      yield* deliverWebhook(event);
    }),
  onDeadLetter: (event, error, ctx) =>
    Effect.gen(function* () {
      yield* storeFailedEvent(event, error);
    }),
});
```

**Tests:** FIFO ordering, retries, dead letter, pause/resume.

---

## 5. Pattern for Adding New Primitives

When adding a new primitive type (e.g., "Timer", "Saga"):

### Step 1: Define the API

Create `primatives/api/00X-{name}-primitive-api-design.md`:
- Define `{Name}.make(config)` factory
- Define `{Name}Context` provided to execute
- Define client methods

### Step 2: Create Primitive Files

```
packages/primitives/src/primitives/{name}/
├── index.ts              # Exports
├── definition.ts         # Config type, make factory
├── context.ts            # Context type(s)
├── executor.ts           # {Name}Executor
├── orchestrator.ts       # {Name}Orchestrator
└── client.ts             # {Name}Client type
```

### Step 3: Implement Orchestrator

```ts
// {name}/orchestrator.ts
export const create{Name}Orchestrator = Effect.gen(function* () {
  const metadata = yield* MetadataManager;
  const state = yield* StateManager;
  const schedule = yield* ScheduleManager;
  const executor = yield* {Name}Executor;

  return {
    handleStart: (call) => Effect.gen(function* () {
      yield* metadata.initialize("{name}", call.name);
      // ... primitive-specific logic
    }),

    handleAlarm: () => Effect.gen(function* () {
      yield* executor.execute();
    }),

    // ... other methods
  };
});
```

### Step 4: Implement Executor

```ts
// {name}/executor.ts
export const create{Name}Executor = (definition: {Name}Definition) =>
  Effect.gen(function* () {
    const state = yield* StateManager;
    const schedule = yield* ScheduleManager;
    const tracker = yield* EventTracker;

    return {
      execute: () =>
        Effect.gen(function* () {
          const currentState = yield* state.get();

          // Build context for user's execute function
          const ctx: {Name}Context = {
            state: Effect.succeed(currentState),
            // ... other context properties
          };

          // Run user's execute
          yield* definition.execute(ctx);

          // Emit tracking event
          yield* tracker.emit({ type: "{name}.executed", ... });
        }),
    };
  });
```

### Step 5: Register in Engine

```ts
// Update engine.ts
async {name}Start(call) { ... }
async {name}Stop(id) { ... }
// etc.

// Update alarm()
async alarm() {
  const meta = await this.#getMeta();
  switch (meta.primitiveType) {
    case "continuous": ...
    case "buffer": ...
    case "queue": ...
    case "{name}":
      return this.#runEffect(orchestrator.{name}HandleAlarm());
  }
}
```

### Step 6: Add Client Methods

```ts
// Update client.ts
{name}: (primitiveName: string) => ({
  start: ({ id, input }) => {
    const instanceId = `{name}:${primitiveName}:${id}`;
    const stub = binding.get(binding.idFromName(instanceId));
    return stub.{name}Start({ name: primitiveName, id, input });
  },
  // ...
}),
```

---

## 6. Storage Key Namespace

```ts
// storage-keys.ts
export const STORAGE_KEYS = {
  // Metadata (all primitives)
  meta: {
    type: "meta:type",           // "continuous" | "buffer" | "queue"
    name: "meta:name",           // primitive name
    createdAt: "meta:createdAt",
    updatedAt: "meta:updatedAt",
    status: "meta:status",       // PrimitiveStatus
  },

  // User state
  state: "state:data",

  // Continuous
  continuous: {
    runCount: "cont:runCount",
    nextScheduledAt: "cont:nextAt",
    lastExecutedAt: "cont:lastAt",
  },

  // Buffer
  buffer: {
    eventCount: "buf:eventCount",
    startedAt: "buf:startedAt",
    flushAt: "buf:flushAt",
  },

  // Queue
  queue: {
    events: "q:events:",         // prefix: q:events:{eventId}
    pending: "q:pending",        // array of pending event IDs
    processedCount: "q:processed",
    currentEventId: "q:current",
    currentAttempt: "q:attempt",
    paused: "q:paused",
  },

  // Idempotency
  idem: "idem:",                 // prefix: idem:{eventId}

  // Purge
  purge: {
    scheduledAt: "purge:at",
  },
} as const;
```

---

## 7. Error Types

```ts
// errors/index.ts
import { Data } from "effect";

// Re-export from core
export { StorageError, SchedulerError } from "@durable-effect/core";

// Primitive-specific errors
export class PrimitiveNotFoundError extends Data.TaggedError("PrimitiveNotFoundError")<{
  readonly primitiveType: string;
  readonly primitiveName: string;
}> {}

export class InstanceNotFoundError extends Data.TaggedError("InstanceNotFoundError")<{
  readonly instanceId: string;
}> {}

export class InvalidStateError extends Data.TaggedError("InvalidStateError")<{
  readonly expected: string;
  readonly actual: string;
  readonly operation: string;
}> {}

export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly schemaName: string;
  readonly issues: ReadonlyArray<unknown>;
}> {}

export class ExecutionError extends Data.TaggedError("ExecutionError")<{
  readonly primitiveType: string;
  readonly primitiveName: string;
  readonly instanceId: string;
  readonly cause: unknown;
}> {}

export class RetryExhaustedError extends Data.TaggedError("RetryExhaustedError")<{
  readonly eventId: string;
  readonly attempts: number;
  readonly lastError: unknown;
}> {}
```

---

## 8. File Structure Summary

```
packages/primitives/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts                      # Public exports
    ├── factory.ts                    # createDurablePrimitives
    ├── storage-keys.ts               # Centralized storage keys
    │
    ├── errors/
    │   └── index.ts                  # Error types
    │
    ├── events/
    │   └── index.ts                  # Tracking event types
    │
    ├── services/
    │   ├── index.ts
    │   ├── metadata.ts               # MetadataManager
    │   ├── state.ts                  # StateManager factory
    │   ├── schedule.ts               # ScheduleManager
    │   ├── idempotency.ts            # IdempotencyManager
    │   └── purge.ts                  # PurgeManager
    │
    ├── registry/
    │   ├── index.ts
    │   ├── types.ts                  # Definition types
    │   └── registry.ts               # createPrimitiveRegistry
    │
    ├── orchestrator/
    │   ├── index.ts
    │   ├── types.ts                  # Request/Response types
    │   └── orchestrator.ts           # PrimitiveOrchestrator
    │
    ├── engine/
    │   ├── index.ts
    │   ├── types.ts
    │   └── engine.ts                 # DurablePrimitivesEngine
    │
    ├── client/
    │   ├── index.ts
    │   ├── types.ts
    │   └── client.ts                 # PrimitivesClient factory
    │
    ├── primitives/
    │   ├── continuous/
    │   │   ├── index.ts
    │   │   ├── definition.ts         # Continuous.make
    │   │   ├── context.ts
    │   │   ├── executor.ts
    │   │   ├── orchestrator.ts
    │   │   └── client.ts
    │   │
    │   ├── buffer/
    │   │   ├── index.ts
    │   │   ├── definition.ts         # Buffer.make
    │   │   ├── context.ts
    │   │   ├── executor.ts
    │   │   ├── orchestrator.ts
    │   │   └── client.ts
    │   │
    │   └── queue/
    │       ├── index.ts
    │       ├── definition.ts         # Queue.make
    │       ├── context.ts
    │       ├── executor.ts
    │       ├── orchestrator.ts
    │       ├── client.ts
    │       └── backoff.ts
    │
    └── testing/
        ├── index.ts
        └── harness.ts                # createTestPrimitives

test/
├── services/
│   ├── metadata.test.ts
│   ├── state.test.ts
│   └── ...
├── primitives/
│   ├── continuous.test.ts
│   ├── buffer.test.ts
│   └── queue.test.ts
└── integration/
    └── engine.test.ts
```

---

## 9. Implementation Checklist

### Phase 1: Primitives Core Infrastructure
- [ ] Create package structure (`packages/primitives/`)
- [ ] Set up `package.json` with dependency on `@durable-effect/core`
- [ ] Implement `errors/index.ts`
- [ ] Implement `events/index.ts`
- [ ] Implement `storage-keys.ts`
- [ ] Implement `services/metadata.ts` + tests
- [ ] Implement `services/state.ts` + tests
- [ ] Implement `services/schedule.ts` + tests
- [ ] Implement `services/idempotency.ts` + tests
- [ ] Implement `services/purge.ts` + tests

### Phase 2: Engine & Client Framework
- [ ] Implement `registry/types.ts`
- [ ] Implement `registry/registry.ts`
- [ ] Implement `orchestrator/types.ts`
- [ ] Implement `orchestrator/orchestrator.ts`
- [ ] Implement `engine/types.ts`
- [ ] Implement `engine/engine.ts`
- [ ] Implement `client/types.ts`
- [ ] Implement `client/client.ts`
- [ ] Implement `factory.ts`
- [ ] Implement `index.ts` (public exports)

### Phase 3: Continuous Primitive
- [ ] Implement `primitives/continuous/definition.ts`
- [ ] Implement `primitives/continuous/context.ts`
- [ ] Implement `primitives/continuous/executor.ts`
- [ ] Implement `primitives/continuous/orchestrator.ts`
- [ ] Implement `primitives/continuous/client.ts`
- [ ] Add continuous methods to engine
- [ ] Full lifecycle tests

### Phase 4: Buffer Primitive
- [ ] Implement `primitives/buffer/definition.ts`
- [ ] Implement `primitives/buffer/context.ts`
- [ ] Implement `primitives/buffer/executor.ts`
- [ ] Implement `primitives/buffer/orchestrator.ts`
- [ ] Implement `primitives/buffer/client.ts`
- [ ] Add buffer methods to engine
- [ ] Event accumulation tests
- [ ] Flush trigger tests

### Phase 5: Queue Primitive
- [ ] Implement `primitives/queue/definition.ts`
- [ ] Implement `primitives/queue/context.ts`
- [ ] Implement `primitives/queue/executor.ts`
- [ ] Implement `primitives/queue/orchestrator.ts`
- [ ] Implement `primitives/queue/client.ts`
- [ ] Implement `primitives/queue/backoff.ts`
- [ ] Add queue methods to engine
- [ ] Add routing logic to client
- [ ] FIFO ordering tests
- [ ] Retry/dead letter tests
- [ ] Pause/resume tests

---

## 10. Summary

This architecture provides:

1. **Clear separation of concerns** - Each layer has a specific responsibility
2. **RPC-based engine** - Matches workflow pattern for consistency
3. **Leverages core package** - All shared infrastructure from `@durable-effect/core`
4. **Phased implementation** - Build infrastructure first, then primitives
5. **Pattern for new primitives** - Clear steps to add new primitive types
6. **Comprehensive testing** - Unit tests for services, integration tests for engine
