# Jobs Implementation Architecture

This document provides a focused, implementation-oriented architecture for `@durable-effect/jobs`. It defines the exact layers, components, and phased implementation plan.

---

## 1. Key Design Decisions

| Decision | Description |
|----------|-------------|
| **RPC-based Engine** | DO class exposes typed RPC methods (like workflow's `run`, `alarm`, `cancel`) not fetch |
| **Shared Core** | All adapters, errors, and testing utilities come from `@durable-effect/core` |
| **Single DO Class** | One `DurableJobsEngine` handles all primitive types |
| **Client Routing** | Client resolves instance IDs before calling DO |
| **Phased Implementation** | Build core infrastructure first, then jobs one by one |

---

## 2. Layer Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              USER CODE                                       │
│  const { Jobs, JobsClient } = createDurableJobs({...})    │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │
┌─────────────────────────────────────▼───────────────────────────────────────┐
│                          CLIENT LAYER                                        │
│                                                                              │
│  JobsClient.fromBinding(env.PRIMITIVES)                               │
│    ├── continuous(name) → ContinuousClient { start, stop, trigger, ... }    │
│    ├── debounce(name) → DebounceClient { add, flush, clear, ... }               │
│    └── workerPool(name) → WorkerPoolClient { enworkerPool, pause, resume, ... }            │
│                                                                              │
│  Responsibilities:                                                           │
│    • Resolve instance ID: `{type}:{name}:{id}`                              │
│    • Route WorkerPool events across N instances (round-robin / partition)        │
│    • Call DO RPC methods                                                     │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │ RPC calls to DO
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          ENGINE LAYER                                        │
│                                                                              │
│  class DurableJobsEngine extends DurableObject {                      │
│    // RPC Methods (like workflow's run, runAsync, alarm, cancel)            │
│    continuousStart(call) → Promise<StartResult>                             │
│    continuousStop(id, opts) → Promise<StopResult>                           │
│    continuousTrigger(id) → Promise<void>                                    │
│    continuousStatus(id) → Promise<Status>                                   │
│    continuousGetState(id) → Promise<State>                                  │
│                                                                              │
│    debounceAdd(call) → Promise<AddResult>                                     │
│    debounceFlush(id) → Promise<FlushResult>                                   │
│    debounceClear(id) → Promise<ClearResult>                                   │
│    debounceStatus(id) → Promise<Status>                                       │
│    debounceGetState(id) → Promise<State>                                      │
│                                                                              │
│    workerPoolEnworkerPool(call) → Promise<EnworkerPoolResult>                              │
│    workerPoolPause(idx?) → Promise<void>                                         │
│    workerPoolResume(idx?) → Promise<void>                                        │
│    workerPoolCancel(eventId) → Promise<CancelResult>                             │
│    workerPoolStatus() → Promise<Status>                                          │
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
│  │   Continuous    │      │     Debounce      │      │      WorkerPool      │     │
│  │  Orchestrator   │      │  Orchestrator   │      │  Orchestrator   │     │
│  │                 │      │                 │      │                 │     │
│  │  handleStart()  │      │  handleAdd()    │      │  handleEnworkerPool()│     │
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
│  │   Continuous    │      │     Debounce      │      │      WorkerPool      │     │
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
│                    (Jobs-specific services)                            │
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

### 3.2 Jobs Core (To Build)

| Component | Purpose | Phase |
|-----------|---------|-------|
| `MetadataManager` | Track primitive type, name, status | 1 |
| `StateManager` | Schema-validated state get/set | 1 |
| `ScheduleManager` | Higher-level scheduling (Duration support) | 1 |
| `IdempotencyManager` | Event deduplication (Debounce, WorkerPool) | 1 |
| `PurgeManager` | Data cleanup after completion | 1 |
| `PrimitiveError` types | Jobs-specific errors | 1 |
| `PrimitiveEvent` types | Jobs-specific tracking events | 1 |

### 3.3 Engine & Client (To Build)

| Component | Purpose | Phase |
|-----------|---------|-------|
| `DurableJobsEngine` | DO class with RPC methods | 2 |
| `PrimitiveOrchestrator` | Routes requests to type orchestrators | 2 |
| `JobsClient` | Client factory with typed accessors | 2 |
| `PrimitiveRegistry` | Holds primitive definitions | 2 |
| `createDurableJobs` | Main factory function | 2 |

### 3.4 Continuous Primitive (To Build)

| Component | Purpose | Phase |
|-----------|---------|-------|
| `Continuous.make` | Definition factory | 3 |
| `ContinuousOrchestrator` | Handles continuous operations | 3 |
| `ContinuousExecutor` | Executes user function, schedules next | 3 |
| `ContinuousContext` | Context provided to execute() | 3 |
| `ContinuousClient` | Typed client for continuous | 3 |

### 3.5 Debounce Primitive (To Build)

| Component | Purpose | Phase |
|-----------|---------|-------|
| `Debounce.make` | Definition factory | 4 |
| `DebounceOrchestrator` | Handles debounce operations | 4 |
| `DebounceExecutor` | Executes onEvent/execute, manages flush | 4 |
| `DebounceEventContext` | Context for onEvent() | 4 |
| `DebounceExecuteContext` | Context for execute() | 4 |
| `DebounceClient` | Typed client for debounce | 4 |

### 3.6 WorkerPool Primitive (To Build)

| Component | Purpose | Phase |
|-----------|---------|-------|
| `WorkerPool.make` | Definition factory | 5 |
| `WorkerPoolOrchestrator` | Handles workerPool operations | 5 |
| `WorkerPoolExecutor` | Processes events, handles retries | 5 |
| `WorkerPoolExecuteContext` | Context for execute() | 5 |
| `WorkerPoolClient` | Typed client with routing logic | 5 |
| `Backoff` utilities | Exponential/linear backoff | 5 |

---

## 4. Implementation Phases

### Phase 1: Jobs Core Infrastructure

**Goal:** Build shared services that all jobs need.

**Files to create:**

```
packages/jobs/src/
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
    type: "continuous" | "debounce" | "workerPool",
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
packages/jobs/src/
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
│   └── engine.ts                   # DurableJobsEngine
├── client/
│   ├── index.ts                    # Exports
│   ├── types.ts                    # Client types
│   └── client.ts                   # JobsClient factory
└── factory.ts                      # createDurableJobs
```

**Engine RPC pattern (like workflow):**

```ts
class DurableJobsEngine extends DurableObject {
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

  // Debounce RPC methods
  async debounceAdd(call: DebounceAddCall): Promise<DebounceAddResult> { ... }

  // WorkerPool RPC methods
  async workerPoolEnworkerPool(call: WorkerPoolEnworkerPoolCall): Promise<WorkerPoolEnworkerPoolResult> { ... }

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
const JobsClient = {
  fromBinding: (binding: DurableObjectNamespace, registry: PrimitiveRegistry) => ({
    continuous: (name: string) => ({
      start: ({ id, input }) => {
        const instanceId = `continuous:${name}:${id}`;
        const stub = binding.get(binding.idFromName(instanceId));
        return stub.continuousStart({ name, id, input });
      },
      // ...
    }),

    debounce: (name: string) => ({ ... }),

    workerPool: (name: string) => {
      const def = registry.workerPool.get(name);
      const concurrency = def?.concurrency ?? 1;

      return {
        enworkerPool: ({ id, event, partitionKey }) => {
          // Route to specific instance
          const instanceIndex = partitionKey
            ? consistentHash(partitionKey, concurrency)
            : roundRobin(name, concurrency);
          const instanceId = `workerPool:${name}:${instanceIndex}`;
          const stub = binding.get(binding.idFromName(instanceId));
          return stub.workerPoolEnworkerPool({ name, eventId: id, event });
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
packages/jobs/src/
├── jobs/
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

### Phase 4: Debounce Primitive

**Goal:** Add event accumulation and flush pattern.

**Files to create:**

```
packages/jobs/src/
├── jobs/
│   └── debounce/
│       ├── index.ts                # Exports
│       ├── definition.ts           # DebounceConfig, Debounce.make
│       ├── context.ts              # DebounceEventContext, DebounceExecuteContext
│       ├── executor.ts             # DebounceExecutor
│       ├── orchestrator.ts         # DebounceOrchestrator
│       └── client.ts               # DebounceClient type
```

**Execution flow:**

```
add(event)
  → IdempotencyManager.hasProcessed(eventId)? return duplicate
  → if first event:
      MetadataManager.initialize("debounce", name)
      ScheduleManager.schedule(flushAfter)
  → Executor.handleEvent(event)
    → run user's onEvent(ctx) OR default (keep latest)
    → StateManager.set(newState)
    → eventCount++
  → if eventCount >= maxEvents: flush()
  → return { eventCount, willFlushAt }

alarm() [when primitiveType === "debounce"]
  → Executor.flush()
    → load state
    → run user's execute(ctx)
    → StateManager.delete()
    → ScheduleManager.cancel()
    → MetadataManager.updateStatus("idle")
  → EventTracker.emit("debounce.flushed")
```

**API (from design doc):**

```ts
const webhookDebounce = Debounce.make({
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

### Phase 5: WorkerPool Primitive

**Goal:** Add FIFO processing with retries and concurrency.

**Files to create:**

```
packages/jobs/src/
├── jobs/
│   └── workerPool/
│       ├── index.ts                # Exports
│       ├── definition.ts           # WorkerPoolConfig, WorkerPool.make
│       ├── context.ts              # WorkerPoolExecuteContext, WorkerPoolDeadLetterContext
│       ├── executor.ts             # WorkerPoolExecutor
│       ├── orchestrator.ts         # WorkerPoolOrchestrator
│       ├── client.ts               # WorkerPoolClient type (with routing)
│       └── backoff.ts              # Backoff utilities
```

**Execution flow:**

```
enworkerPool(event) [routed to instance by client]
  → IdempotencyManager.hasProcessed(eventId)? return duplicate
  → if first event: MetadataManager.initialize("workerPool", name)
  → store event in workerPool: `workerPool:events:{eventId}`
  → add to pending list: `workerPool:pending`
  → if idle: ScheduleManager.schedule(now)
  → return { position, instanceIndex }

alarm() [when primitiveType === "workerPool"]
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
const webhookProcessor = WorkerPool.make({
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

## 5. Pattern for Adding New Jobs

When adding a new primitive type (e.g., "Timer", "Saga"):

### Step 1: Define the API

Create `primatives/api/00X-{name}-primitive-api-design.md`:
- Define `{Name}.make(config)` factory
- Define `{Name}Context` provided to execute
- Define client methods

### Step 2: Create Primitive Files

```
packages/jobs/src/jobs/{name}/
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
    case "debounce": ...
    case "workerPool": ...
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
  // Metadata (all jobs)
  meta: {
    type: "meta:type",           // "continuous" | "debounce" | "workerPool"
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

  // Debounce
  debounce: {
    eventCount: "buf:eventCount",
    startedAt: "buf:startedAt",
    flushAt: "buf:flushAt",
  },

  // WorkerPool
  workerPool: {
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
packages/jobs/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts                      # Public exports
    ├── factory.ts                    # createDurableJobs
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
    │   └── engine.ts                 # DurableJobsEngine
    │
    ├── client/
    │   ├── index.ts
    │   ├── types.ts
    │   └── client.ts                 # JobsClient factory
    │
    ├── jobs/
    │   ├── continuous/
    │   │   ├── index.ts
    │   │   ├── definition.ts         # Continuous.make
    │   │   ├── context.ts
    │   │   ├── executor.ts
    │   │   ├── orchestrator.ts
    │   │   └── client.ts
    │   │
    │   ├── debounce/
    │   │   ├── index.ts
    │   │   ├── definition.ts         # Debounce.make
    │   │   ├── context.ts
    │   │   ├── executor.ts
    │   │   ├── orchestrator.ts
    │   │   └── client.ts
    │   │
    │   └── workerPool/
    │       ├── index.ts
    │       ├── definition.ts         # WorkerPool.make
    │       ├── context.ts
    │       ├── executor.ts
    │       ├── orchestrator.ts
    │       ├── client.ts
    │       └── backoff.ts
    │
    └── testing/
        ├── index.ts
        └── harness.ts                # createTestJobs

test/
├── services/
│   ├── metadata.test.ts
│   ├── state.test.ts
│   └── ...
├── jobs/
│   ├── continuous.test.ts
│   ├── debounce.test.ts
│   └── workerPool.test.ts
└── integration/
    └── engine.test.ts
```

---

## 9. Implementation Checklist

### Phase 1: Jobs Core Infrastructure
- [ ] Create package structure (`packages/jobs/`)
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
- [ ] Implement `jobs/continuous/definition.ts`
- [ ] Implement `jobs/continuous/context.ts`
- [ ] Implement `jobs/continuous/executor.ts`
- [ ] Implement `jobs/continuous/orchestrator.ts`
- [ ] Implement `jobs/continuous/client.ts`
- [ ] Add continuous methods to engine
- [ ] Full lifecycle tests

### Phase 4: Debounce Primitive
- [ ] Implement `jobs/debounce/definition.ts`
- [ ] Implement `jobs/debounce/context.ts`
- [ ] Implement `jobs/debounce/executor.ts`
- [ ] Implement `jobs/debounce/orchestrator.ts`
- [ ] Implement `jobs/debounce/client.ts`
- [ ] Add debounce methods to engine
- [ ] Event accumulation tests
- [ ] Flush trigger tests

### Phase 5: WorkerPool Primitive
- [ ] Implement `jobs/workerPool/definition.ts`
- [ ] Implement `jobs/workerPool/context.ts`
- [ ] Implement `jobs/workerPool/executor.ts`
- [ ] Implement `jobs/workerPool/orchestrator.ts`
- [ ] Implement `jobs/workerPool/client.ts`
- [ ] Implement `jobs/workerPool/backoff.ts`
- [ ] Add workerPool methods to engine
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
4. **Phased implementation** - Build infrastructure first, then jobs
5. **Pattern for new jobs** - Clear steps to add new primitive types
6. **Comprehensive testing** - Unit tests for services, integration tests for engine
