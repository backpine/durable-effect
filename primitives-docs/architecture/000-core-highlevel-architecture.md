# Jobs Package Core Architecture

This document defines the high-level architecture for `@durable-effect/jobs`, a package that provides durable jobs (Continuous, Debounce, WorkerPool) under a unified engine. The architecture draws heavily from `@durable-effect/workflow` while being tailored for the distinct needs of each primitive type.

---

## 1. Design Goals

1. **Unified Engine** - All jobs share a single Durable Object class
2. **Swappable Compute** - Abstract adapters allow future migration away from Cloudflare
3. **Consistent Patterns** - Share as much infrastructure as possible between jobs
4. **Type Safety** - Full Effect Schema integration with TypeScript inference
5. **Observability** - Standardized event tracking across all primitive types
6. **Testability** - In-memory adapters for fast, isolated tests
7. **Code Sharing** - Reuse adapter interfaces from `@durable-effect/workflow`

---

## 2. Layered Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           CLIENT LAYER                                  │
│  JobsClient.fromBinding(env.PRIMITIVES)                           │
│  - Typed accessors: client.continuous(), client.debounce(), client.workerPool()│
│  - Instance ID resolution and routing (critical for WorkerPool concurrency)  │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      │ HTTP/RPC
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           ENGINE LAYER                                  │
│  DurableJobsEngine (Durable Object class)                         │
│  - Receives requests, creates Layer, routes to Orchestrator             │
│  - Manages alarm wakeups via alarm() method                             │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        ORCHESTRATOR LAYER                               │
│  PrimitiveOrchestrator (unified router)                                 │
│  - Determines primitive type from metadata                              │
│  - Routes to type-specific orchestrators                                │
│                                                                         │
│  ┌──────────────────┬──────────────────┬──────────────────┐             │
│  │   Continuous     │     Debounce       │      WorkerPool       │             │
│  │  Orchestrator    │   Orchestrator   │   Orchestrator   │             │
│  └──────────────────┴──────────────────┴──────────────────┘             │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         EXECUTOR LAYER                                  │
│  Type-specific execution logic                                          │
│                                                                         │
│  ┌──────────────────┬──────────────────┬──────────────────┐             │
│  │   Continuous     │     Debounce       │      WorkerPool       │             │
│  │    Executor      │    Executor      │    Executor      │             │
│  │  - run execute() │  - run onEvent() │  - run execute() │             │
│  │  - schedule next │  - run execute() │  - process next  │             │
│  │  - manage state  │  - flush state   │  - retry logic   │             │
│  └──────────────────┴──────────────────┴──────────────────┘             │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      SHARED SERVICES LAYER                              │
│                                                                         │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐        │
│  │  Metadata  │  │   Event    │  │   State    │  │ Idempotency│        │
│  │  Manager   │  │  Tracker   │  │  Manager   │  │  Manager   │        │
│  │            │  │            │  │  (schema)  │  │            │        │
│  └────────────┘  └────────────┘  └────────────┘  └────────────┘        │
│                                                                         │
│  ┌────────────┐  ┌────────────┐                                        │
│  │  Schedule  │  │   Purge    │                                        │
│  │  Manager   │  │  Manager   │                                        │
│  └────────────┘  └────────────┘                                        │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         ADAPTER LAYER                                   │
│  Platform-agnostic interfaces (SHARED WITH @durable-effect/workflow)    │
│                                                                         │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐            │
│  │    Storage     │  │   Scheduler    │  │    Runtime     │            │
│  │    Adapter     │  │    Adapter     │  │    Adapter     │            │
│  └────────────────┘  └────────────────┘  └────────────────┘            │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         PLATFORM LAYER                                  │
│  Cloudflare Durable Objects (initial implementation)                    │
│  - DurableObjectStorage for persistence                                 │
│  - Alarms API for scheduled execution                                   │
│  - ctx.waitUntil() for fire-and-forget tracking                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Relationship to @durable-effect/workflow

### 3.1 Shared Components (Import from workflow)

The jobs package **imports and reuses** these from the workflow package:

| Component | Location | Purpose |
|-----------|----------|---------|
| `StorageAdapter` | `@durable-effect/workflow/adapters` | Key-value storage interface |
| `SchedulerAdapter` | `@durable-effect/workflow/adapters` | Alarm scheduling interface |
| `RuntimeAdapter` | `@durable-effect/workflow/adapters` | Runtime utilities (now, instanceId) |
| `StorageError` | `@durable-effect/workflow/errors` | Storage operation errors |
| `SchedulerError` | `@durable-effect/workflow/errors` | Scheduler operation errors |
| DO adapter implementations | `@durable-effect/workflow/adapters/durable-object` | Platform-specific code |

### 3.2 Jobs-Specific Components

| Component | Purpose |
|-----------|---------|
| `MetadataManager` | Track primitive type, name, status per instance |
| `EventTracker` | Emit primitive-specific lifecycle events |
| `StateManager` | Schema-validated state (Continuous, Debounce) |
| `IdempotencyManager` | Event deduplication (Debounce, WorkerPool) |
| Type-specific orchestrators | Handle primitive-specific operations |
| Type-specific executors | Execute primitive logic |

### 3.3 Architecture Comparison

| Aspect | Workflow | Jobs |
|--------|----------|------------|
| DO class | One per workflow registry | One for all jobs |
| Instance routing | `workflowName:id` | `primitiveType:primitiveName:id` |
| State machine | Full workflow lifecycle | Simpler per-primitive status |
| Alarm semantics | Resume/recover workflow | Type-dependent (see Section 4) |
| Recovery | Complex (stale detection) | Simpler (primitive-specific) |

---

## 4. Critical Design Decision: Instance ID and Alarm Routing

### 4.1 Instance ID Format

Each Durable Object instance is identified by a composite ID:

```ts
// Format: {primitiveType}:{primitiveName}:{userProvidedId}
const instanceId = `continuous:tokenRefresher:user-123`;
const instanceId = `debounce:webhookDebounce:contact-456`;
const instanceId = `workerPool:emailSender:0`;  // Note: WorkerPool uses index, not user ID
```

**Client resolves instance ID before calling DO:**

```ts
// Client code (simplified)
const continuous = (name: string) => ({
  start: ({ id, input }) => {
    const instanceId = `continuous:${name}:${id}`;
    const stub = binding.get(binding.idFromName(instanceId));
    return stub.fetch(/* request */);
  },
});
```

### 4.2 WorkerPool's Multi-Instance Model

WorkerPool is **special** - it uses N instances for concurrency:

```ts
// WorkerPool with concurrency: 5 creates instances:
// workerPool:emailSender:0
// workerPool:emailSender:1
// workerPool:emailSender:2
// workerPool:emailSender:3
// workerPool:emailSender:4

// Client routes events across instances
const workerPool = (name: string) => ({
  enworkerPool: ({ id, event, partitionKey }) => {
    const concurrency = registry.workerPool.get(name).concurrency;

    // Determine target instance
    const instanceIndex = partitionKey
      ? consistentHash(partitionKey, concurrency)
      : roundRobin(name, concurrency);

    const instanceId = `workerPool:${name}:${instanceIndex}`;
    const stub = binding.get(binding.idFromName(instanceId));
    return stub.fetch(/* enworkerPool request */);
  },
});
```

### 4.3 Alarm Semantics Per Primitive

Each primitive type uses alarms differently:

| Primitive | Alarm Trigger | Alarm Action |
|-----------|---------------|--------------|
| **Continuous** | `schedule(duration)` | Execute `execute()`, reschedule |
| **Debounce** | `flushAfter` timer | Execute `execute()`, purge state |
| **WorkerPool** | After event processing | Process next event OR idle |

**The orchestrator determines alarm handling based on stored metadata:**

```ts
// In PrimitiveOrchestrator.handleAlarm()
const meta = yield* metadataManager.get();
if (!meta) return; // No primitive exists

switch (meta.primitiveType) {
  case "continuous":
    yield* continuousOrchestrator.handleAlarm();
    break;
  case "debounce":
    yield* debounceOrchestrator.handleAlarm();
    break;
  case "workerPool":
    yield* workerPoolOrchestrator.handleAlarm();
    break;
}
```

---

## 5. Adapter Layer (Shared with Workflow)

The adapter layer provides platform-agnostic interfaces. These are **imported from** `@durable-effect/workflow`.

### 5.1 StorageAdapter

```ts
// From @durable-effect/workflow/adapters/storage
interface StorageAdapterService {
  readonly get: <T>(key: string) => Effect.Effect<T | undefined, StorageError>;
  readonly put: <T>(key: string, value: T) => Effect.Effect<void, StorageError>;
  readonly putBatch: (entries: Record<string, unknown>) => Effect.Effect<void, StorageError>;
  readonly delete: (key: string) => Effect.Effect<boolean, StorageError>;
  readonly deleteAll: () => Effect.Effect<void, StorageError>;
  readonly list: <T>(prefix: string) => Effect.Effect<Map<string, T>, StorageError>;
}

class StorageAdapter extends Context.Tag("@durable-effect/StorageAdapter")<
  StorageAdapter,
  StorageAdapterService
>() {}
```

### 5.2 SchedulerAdapter

```ts
// From @durable-effect/workflow/adapters/scheduler
interface SchedulerAdapterService {
  readonly schedule: (time: number) => Effect.Effect<void, SchedulerError>;
  readonly cancel: () => Effect.Effect<void, SchedulerError>;
  readonly getScheduled: () => Effect.Effect<number | undefined, SchedulerError>;
}

class SchedulerAdapter extends Context.Tag("@durable-effect/SchedulerAdapter")<
  SchedulerAdapter,
  SchedulerAdapterService
>() {}
```

### 5.3 RuntimeAdapter

```ts
// From @durable-effect/workflow/adapters/runtime
interface RuntimeAdapterService {
  readonly instanceId: string;
  readonly now: () => Effect.Effect<number>;
}

class RuntimeAdapter extends Context.Tag("@durable-effect/RuntimeAdapter")<
  RuntimeAdapter,
  RuntimeAdapterService
>() {}
```

---

## 6. Shared Services Layer

Shared services provide cross-cutting functionality used by all primitive types.

### 6.1 MetadataManager

Manages standard metadata that all jobs track. **Critical for determining primitive type on alarm.**

```ts
interface PrimitiveMetadata {
  readonly primitiveType: "continuous" | "debounce" | "workerPool";
  readonly primitiveName: string;
  readonly instanceId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly status: PrimitiveStatus;
}

type PrimitiveStatus =
  | { _tag: "Active" }
  | { _tag: "Paused"; pausedAt: number }
  | { _tag: "Stopped"; stoppedAt: number; reason?: string }
  | { _tag: "Error"; errorAt: number; error: string };

interface MetadataManagerService {
  readonly initialize: (
    type: PrimitiveMetadata["primitiveType"],
    name: string,
    instanceId: string,
  ) => Effect.Effect<void, StorageError>;

  readonly get: () => Effect.Effect<PrimitiveMetadata | undefined, StorageError>;

  readonly update: (
    updates: Partial<Pick<PrimitiveMetadata, "status" | "updatedAt">>
  ) => Effect.Effect<void, StorageError>;

  readonly markError: (error: string) => Effect.Effect<void, StorageError>;

  readonly markStopped: (reason?: string) => Effect.Effect<void, StorageError>;
}

class MetadataManager extends Context.Tag("@durable-effect/jobs/MetadataManager")<
  MetadataManager,
  MetadataManagerService
>() {}
```

**Storage Keys:**
```ts
const METADATA_KEYS = {
  type: "meta:type",
  name: "meta:name",
  instanceId: "meta:instanceId",
  createdAt: "meta:createdAt",
  updatedAt: "meta:updatedAt",
  status: "meta:status",
} as const;
```

### 6.2 EventTracker

Emits lifecycle events for observability. Similar pattern to workflow's tracker but with primitive-specific events.

```ts
// Internal events (before enrichment)
type ContinuousEvent =
  | { type: "continuous.started"; primitiveName: string; instanceId: string; input: unknown }
  | { type: "continuous.executed"; primitiveName: string; instanceId: string; runCount: number; durationMs: number }
  | { type: "continuous.scheduled"; primitiveName: string; instanceId: string; nextRunAt: number }
  | { type: "continuous.stopped"; primitiveName: string; instanceId: string; reason?: string }
  | { type: "continuous.error"; primitiveName: string; instanceId: string; error: string };

type DebounceEvent =
  | { type: "debounce.eventReceived"; primitiveName: string; instanceId: string; eventId?: string; eventCount: number }
  | { type: "debounce.flushing"; primitiveName: string; instanceId: string; eventCount: number; reason: "flushAfter" | "maxEvents" | "manual" }
  | { type: "debounce.flushed"; primitiveName: string; instanceId: string; eventCount: number; durationMs: number }
  | { type: "debounce.cleared"; primitiveName: string; instanceId: string; discardedEvents: number }
  | { type: "debounce.error"; primitiveName: string; instanceId: string; error: string };

type WorkerPoolEvent =
  | { type: "workerPool.enworkerPoold"; primitiveName: string; instanceId: string; eventId: string; position: number }
  | { type: "workerPool.processing"; primitiveName: string; instanceId: string; eventId: string; attempt: number }
  | { type: "workerPool.completed"; primitiveName: string; instanceId: string; eventId: string; durationMs: number }
  | { type: "workerPool.failed"; primitiveName: string; instanceId: string; eventId: string; error: string; attempt: number }
  | { type: "workerPool.deadLettered"; primitiveName: string; instanceId: string; eventId: string; error: string }
  | { type: "workerPool.paused"; primitiveName: string; instanceId: string }
  | { type: "workerPool.resumed"; primitiveName: string; instanceId: string };

type InternalPrimitiveEvent = ContinuousEvent | DebounceEvent | WorkerPoolEvent;

// Wire event (enriched for transport)
interface PrimitiveEvent extends InternalPrimitiveEvent {
  readonly timestamp: number;
  readonly env: string;
  readonly serviceKey: string;
}

interface EventTrackerService {
  readonly emit: (event: InternalPrimitiveEvent) => Effect.Effect<void>;
  readonly flush: () => Effect.Effect<void>;
  readonly pending: () => Effect.Effect<number>;
}

class EventTracker extends Context.Tag("@durable-effect/jobs/EventTracker")<
  EventTracker,
  EventTrackerService
>() {}
```

**Implementation Pattern (fire-and-forget via waitUntil):**

```ts
const createHttpBatchEventTracker = (config: EventTrackerConfig) =>
  Effect.gen(function* () {
    const debounce: InternalPrimitiveEvent[] = [];

    return {
      emit: (event) =>
        Effect.sync(() => {
          debounce.push(event);
        }),

      flush: () =>
        Effect.gen(function* () {
          if (debounce.length === 0) return;

          const events = debounce.map(e => ({
            ...e,
            timestamp: Date.now(),
            env: config.env,
            serviceKey: config.serviceKey,
          }));
          debounce.length = 0;

          // Fire and forget via ctx.waitUntil - don't block response
          // This is handled at the engine layer
          yield* sendEventsToCollector(config.endpoint, events).pipe(
            Effect.catchAll(() => Effect.void)
          );
        }),

      pending: () => Effect.succeed(debounce.length),
    };
  });
```

### 6.3 StateManager

Generic state management with schema validation. Used by Continuous (persistent state) and Debounce (accumulated state).

```ts
interface StateManagerService<S> {
  readonly get: () => Effect.Effect<S | null, StorageError>;
  readonly set: (state: S) => Effect.Effect<void, StorageError>;
  readonly update: (updater: (s: S) => Partial<S>) => Effect.Effect<void, StorageError>;
  readonly delete: () => Effect.Effect<void, StorageError>;
}

// Factory function creates typed state managers
const createStateManager = <S extends Schema.Schema.AnyNoContext>(
  schema: S,
  storageKey: string = "state:data"
): Effect.Effect<StateManagerService<Schema.Schema.Type<S>>, never, StorageAdapter> =>
  Effect.gen(function* () {
    const storage = yield* StorageAdapter;
    const decode = Schema.decodeUnknown(schema);
    const encode = Schema.encodeUnknown(schema);

    return {
      get: () =>
        Effect.gen(function* () {
          const raw = yield* storage.get(storageKey);
          if (raw === undefined) return null;
          return yield* decode(raw);
        }),

      set: (state) =>
        Effect.gen(function* () {
          const encoded = yield* encode(state);
          yield* storage.put(storageKey, encoded);
        }),

      update: (updater) =>
        Effect.gen(function* () {
          const current = yield* storage.get(storageKey);
          if (current === undefined) {
            return yield* Effect.fail(new StateNotFoundError());
          }
          const decoded = yield* decode(current);
          const updated = { ...decoded, ...updater(decoded) };
          const encoded = yield* encode(updated);
          yield* storage.put(storageKey, encoded);
        }),

      delete: () => storage.delete(storageKey).pipe(Effect.asVoid),
    };
  });
```

### 6.4 IdempotencyManager

Tracks processed event IDs to prevent duplicate processing. Used by Debounce and WorkerPool.

```ts
interface IdempotencyManagerService {
  readonly hasProcessed: (eventId: string) => Effect.Effect<boolean, StorageError>;
  readonly markProcessed: (eventId: string) => Effect.Effect<void, StorageError>;
  readonly clearProcessed: (eventId: string) => Effect.Effect<void, StorageError>;
}

class IdempotencyManager extends Context.Tag("@durable-effect/jobs/IdempotencyManager")<
  IdempotencyManager,
  IdempotencyManagerService
>() {}
```

**Storage Keys:**
```ts
// Prefix: "idem:{eventId}" -> { processedAt: number }
```

### 6.5 ScheduleManager

Higher-level schedule management wrapping SchedulerAdapter.

```ts
interface ScheduleManagerService {
  readonly schedule: (
    when: Duration.DurationInput | number | Date
  ) => Effect.Effect<void, SchedulerError>;

  readonly cancel: () => Effect.Effect<void, SchedulerError>;

  readonly getScheduledTime: () => Effect.Effect<number | undefined, SchedulerError>;

  readonly hasSchedule: () => Effect.Effect<boolean, SchedulerError>;
}

class ScheduleManager extends Context.Tag("@durable-effect/jobs/ScheduleManager")<
  ScheduleManager,
  ScheduleManagerService
>() {}
```

### 6.6 PurgeManager

Handles data cleanup. Used by Debounce (after flush) and optionally by Continuous (on stop).

```ts
interface PurgeManagerService {
  readonly purgeNow: () => Effect.Effect<void, StorageError>;
  readonly schedulePurge: (when: Duration.DurationInput | number | Date) => Effect.Effect<void, StorageError | SchedulerError>;
  readonly cancelPurge: () => Effect.Effect<void, StorageError>;
  readonly getPendingPurge: () => Effect.Effect<number | undefined, StorageError>;
}

class PurgeManager extends Context.Tag("@durable-effect/jobs/PurgeManager")<
  PurgeManager,
  PurgeManagerService
>() {}
```

---

## 7. Executor Layer

Each primitive type has a dedicated executor that implements its specific logic.

### 7.1 ContinuousExecutor

```ts
interface ContinuousExecutorService<S, E, R> {
  /** Initialize and optionally run first execution */
  readonly start: (input: S) => Effect.Effect<ContinuousStartResult, E, R>;

  /** Handle alarm - run execute() and reschedule */
  readonly executeOnAlarm: () => Effect.Effect<void, E, R>;

  /** Stop and purge */
  readonly stop: (reason?: string) => Effect.Effect<void, StorageError>;

  /** Trigger immediate execution (bypass schedule) */
  readonly trigger: () => Effect.Effect<void, E, R>;

  /** Get current status */
  readonly getStatus: () => Effect.Effect<ContinuousStatus, StorageError>;

  /** Get current state */
  readonly getState: () => Effect.Effect<S | null, StorageError>;
}
```

**Execution Flow:**

```
start(input) → [save state] → [if startImmediately: execute()] → [schedule next]
     ↓
alarm fires → executeOnAlarm() → execute() → [update state] → [schedule next]
     ↓
stop(reason) → [cancel schedule] → [purge state]
```

### 7.2 DebounceExecutor

```ts
interface DebounceExecutorService<I, S, E, R> {
  /** Add event to debounce, optionally trigger flush */
  readonly addEvent: (event: I, eventId?: string) => Effect.Effect<DebounceAddResult, E, R>;

  /** Handle alarm - flush the debounce */
  readonly executeOnAlarm: () => Effect.Effect<void, E, R>;

  /** Manual flush */
  readonly flush: () => Effect.Effect<DebounceFlushResult, E, R>;

  /** Clear debounce without executing */
  readonly clear: () => Effect.Effect<DebounceClearResult, StorageError>;

  /** Get current status */
  readonly getStatus: () => Effect.Effect<DebounceStatus, StorageError>;

  /** Get current accumulated state */
  readonly getState: () => Effect.Effect<S | null, StorageError>;
}
```

**Execution Flow:**

```
add(event) → [dedupe check] → [onEvent() → update state] → [eventCount++]
     ↓
     ├── if eventCount >= maxEvents → flush()
     └── if first event → schedule(flushAfter)

alarm fires → executeOnAlarm() → execute(state) → [purge state, cancel alarm]

flush() → execute(state) → [purge state, cancel alarm]
```

### 7.3 WorkerPoolExecutor

```ts
interface WorkerPoolExecutorService<E, Err, R> {
  /** Add event to workerPool */
  readonly enworkerPool: (event: E, eventId: string, priority?: number) => Effect.Effect<WorkerPoolEnworkerPoolResult, Err, R>;

  /** Handle alarm - process next event */
  readonly executeOnAlarm: () => Effect.Effect<void, Err, R>;

  /** Pause processing */
  readonly pause: () => Effect.Effect<void, StorageError>;

  /** Resume processing */
  readonly resume: () => Effect.Effect<void, StorageError>;

  /** Cancel pending event */
  readonly cancel: (eventId: string) => Effect.Effect<WorkerPoolCancelResult, StorageError>;

  /** Get current status */
  readonly getStatus: () => Effect.Effect<WorkerPoolInstanceStatus, StorageError>;
}
```

**Execution Flow:**

```
enworkerPool(event) → [dedupe check] → [add to pending list] → [schedule alarm if idle]
     ↓
alarm fires → executeOnAlarm() → [pop next event] → execute(event)
     ↓
     ├── success → [mark processed] → [schedule for next event]
     └── failure → [retry logic] → [if exhausted: onDeadLetter()]
                                  → [schedule for next event]
```

---

## 8. Orchestrator Layer

The orchestrator routes requests to the appropriate executor based on primitive type.

### 8.1 Type-Specific Orchestrators

```ts
// ContinuousOrchestrator
interface ContinuousOrchestratorService {
  readonly handleStart: (req: ContinuousStartRequest) => Effect.Effect<ContinuousStartResult, ...>;
  readonly handleStop: (req: ContinuousStopRequest) => Effect.Effect<ContinuousStopResult, ...>;
  readonly handleTrigger: (req: ContinuousTriggerRequest) => Effect.Effect<void, ...>;
  readonly handleStatus: (req: StatusRequest) => Effect.Effect<ContinuousStatus, ...>;
  readonly handleGetState: (req: GetStateRequest) => Effect.Effect<unknown, ...>;
  readonly handleAlarm: () => Effect.Effect<void, ...>;
}

// DebounceOrchestrator
interface DebounceOrchestratorService {
  readonly handleAdd: (req: DebounceAddRequest) => Effect.Effect<DebounceAddResult, ...>;
  readonly handleFlush: (req: DebounceFlushRequest) => Effect.Effect<DebounceFlushResult, ...>;
  readonly handleClear: (req: DebounceClearRequest) => Effect.Effect<DebounceClearResult, ...>;
  readonly handleStatus: (req: StatusRequest) => Effect.Effect<DebounceStatus, ...>;
  readonly handleGetState: (req: GetStateRequest) => Effect.Effect<unknown, ...>;
  readonly handleAlarm: () => Effect.Effect<void, ...>;
}

// WorkerPoolOrchestrator
interface WorkerPoolOrchestratorService {
  readonly handleEnworkerPool: (req: WorkerPoolEnworkerPoolRequest) => Effect.Effect<WorkerPoolEnworkerPoolResult, ...>;
  readonly handlePause: (req: WorkerPoolPauseRequest) => Effect.Effect<void, ...>;
  readonly handleResume: (req: WorkerPoolResumeRequest) => Effect.Effect<void, ...>;
  readonly handleCancel: (req: WorkerPoolCancelRequest) => Effect.Effect<WorkerPoolCancelResult, ...>;
  readonly handleStatus: (req: StatusRequest) => Effect.Effect<WorkerPoolInstanceStatus, ...>;
  readonly handleAlarm: () => Effect.Effect<void, ...>;
}
```

### 8.2 Unified PrimitiveOrchestrator

```ts
interface PrimitiveOrchestratorService {
  readonly route: (request: PrimitiveRequest) => Effect.Effect<PrimitiveResponse, PrimitiveError>;
  readonly handleAlarm: () => Effect.Effect<void, PrimitiveError>;
}

class PrimitiveOrchestrator extends Context.Tag("@durable-effect/jobs/PrimitiveOrchestrator")<
  PrimitiveOrchestrator,
  PrimitiveOrchestratorService
>() {}
```

**Implementation:**

```ts
const createPrimitiveOrchestrator = Effect.gen(function* () {
  const metadata = yield* MetadataManager;
  const tracker = yield* EventTracker;
  const continuousOrchestrator = yield* ContinuousOrchestrator;
  const debounceOrchestrator = yield* DebounceOrchestrator;
  const workerPoolOrchestrator = yield* WorkerPoolOrchestrator;

  return {
    route: (request: PrimitiveRequest) =>
      Effect.gen(function* () {
        // Route based on request type
        switch (request._tag) {
          case "ContinuousStart":
          case "ContinuousStop":
          case "ContinuousTrigger":
          case "ContinuousStatus":
          case "ContinuousGetState":
            return yield* routeToContinuous(continuousOrchestrator, request);

          case "DebounceAdd":
          case "DebounceFlush":
          case "DebounceClear":
          case "DebounceStatus":
          case "DebounceGetState":
            return yield* routeToDebounce(debounceOrchestrator, request);

          case "WorkerPoolEnworkerPool":
          case "WorkerPoolPause":
          case "WorkerPoolResume":
          case "WorkerPoolCancel":
          case "WorkerPoolStatus":
            return yield* routeToWorkerPool(workerPoolOrchestrator, request);
        }
      }),

    handleAlarm: () =>
      Effect.gen(function* () {
        const meta = yield* metadata.get();
        if (!meta) return; // No primitive exists

        switch (meta.primitiveType) {
          case "continuous":
            yield* continuousOrchestrator.handleAlarm();
            break;
          case "debounce":
            yield* debounceOrchestrator.handleAlarm();
            break;
          case "workerPool":
            yield* workerPoolOrchestrator.handleAlarm();
            break;
        }
      }),
  };
});
```

---

## 9. Engine Layer

The engine is the Durable Object entry point.

### 9.1 DurableJobsEngine

```ts
import { DurableObject } from "cloudflare:workers";
import { Effect, Layer, pipe } from "effect";

export class DurableJobsEngine extends DurableObject {
  readonly #runtimeLayer: Layer.Layer<StorageAdapter | SchedulerAdapter | RuntimeAdapter>;
  readonly #orchestratorLayer: Layer.Layer<PrimitiveOrchestrator | EventTracker | MetadataManager, never, never>;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);

    // Create runtime adapter layer (platform-specific)
    this.#runtimeLayer = createDurableObjectRuntime(state);

    // Create tracker layer
    const trackerLayer = env.__TRACKING_CONFIG__?.enabled
      ? HttpBatchEventTrackerLayer(env.__TRACKING_CONFIG__)
      : NoopEventTrackerLayer;

    // Create full orchestrator layer
    this.#orchestratorLayer = pipe(
      this.#runtimeLayer,
      Layer.provideMerge(MetadataManagerLayer),
      Layer.provideMerge(trackerLayer),
      Layer.provideMerge(IdempotencyManagerLayer),
      Layer.provideMerge(ScheduleManagerLayer),
      Layer.provideMerge(PurgeManagerLayer),
      Layer.provideMerge(PrimitiveOrchestratorLayer(env.__PRIMITIVE_REGISTRY__)),
    );
  }

  #runEffect<A>(effect: Effect.Effect<A, unknown, PrimitiveOrchestrator | EventTracker>): Promise<A> {
    return Effect.runPromise(
      effect.pipe(Effect.provide(this.#orchestratorLayer))
    );
  }

  async fetch(request: Request): Promise<Response> {
    const result = await this.#runEffect(
      Effect.gen(function* () {
        const orchestrator = yield* PrimitiveOrchestrator;
        const tracker = yield* EventTracker;

        const req = yield* parseRequest(request);
        const result = yield* orchestrator.route(req);

        // Don't await - let engine handle via waitUntil
        return { result, pendingFlush: tracker.flush() };
      })
    );

    // Fire-and-forget event flushing
    this.ctx.waitUntil(Effect.runPromise(result.pendingFlush));

    return new Response(JSON.stringify(result.result), {
      headers: { "Content-Type": "application/json" },
    });
  }

  async alarm(): Promise<void> {
    await this.#runEffect(
      Effect.gen(function* () {
        const orchestrator = yield* PrimitiveOrchestrator;
        const tracker = yield* EventTracker;

        yield* orchestrator.handleAlarm();

        // Fire-and-forget event flushing
        // Note: alarm() doesn't have waitUntil, but we're inside blockConcurrencyWhile
        yield* tracker.flush();
      })
    );
  }
}
```

---

## 10. Registry Pattern

The registry holds all primitive definitions and enables type-safe lookup.

### 10.1 Definition Types

```ts
// Base definition shape
interface PrimitiveDefinitionBase {
  readonly _tag: "continuous" | "debounce" | "workerPool";
  readonly name: string;
}

// Continuous definition
interface ContinuousDefinition<S, E, R> extends PrimitiveDefinitionBase {
  readonly _tag: "continuous";
  readonly stateSchema: Schema.Schema<S, unknown, never>;
  readonly schedule: ContinuousSchedule;
  readonly startImmediately: boolean;
  readonly execute: (ctx: ContinuousContext<S>) => Effect.Effect<void, E, R>;
  readonly onError?: (error: E, ctx: ContinuousContext<S>) => Effect.Effect<void, never, R>;
}

// Debounce definition
interface DebounceDefinition<I, S, E, R> extends PrimitiveDefinitionBase {
  readonly _tag: "debounce";
  readonly eventSchema: Schema.Schema<I, unknown, never>;
  readonly stateSchema?: Schema.Schema<S, unknown, never>;
  readonly flushAfter: Duration.DurationInput;
  readonly maxEvents?: number;
  readonly execute: (ctx: DebounceExecuteContext<S>) => Effect.Effect<void, E, R>;
  readonly onEvent?: (ctx: DebounceEventContext<I, S>) => S;  // Synchronous reducer
  readonly onError?: (error: E, ctx: DebounceExecuteContext<S>) => Effect.Effect<void, never, R>;
}

// WorkerPool definition
interface WorkerPoolDefinition<E, Err, R> extends PrimitiveDefinitionBase {
  readonly _tag: "workerPool";
  readonly eventSchema: Schema.Schema<E, unknown, never>;
  readonly concurrency: number;
  readonly execute: (ctx: WorkerPoolExecuteContext<E>) => Effect.Effect<void, Err, R>;
  readonly retry?: WorkerPoolRetryConfig;
  readonly onDeadLetter?: (event: E, error: Err, ctx: WorkerPoolDeadLetterContext) => Effect.Effect<void, never, R>;
  readonly onEmpty?: (ctx: WorkerPoolEmptyContext) => Effect.Effect<void, never, R>;
}

type AnyPrimitiveDefinition =
  | ContinuousDefinition<any, any, any>
  | DebounceDefinition<any, any, any, any>
  | WorkerPoolDefinition<any, any, any>;
```

### 10.2 Registry Structure

```ts
interface PrimitiveRegistry {
  readonly continuous: Map<string, ContinuousDefinition<any, any, any>>;
  readonly debounce: Map<string, DebounceDefinition<any, any, any, any>>;
  readonly workerPool: Map<string, WorkerPoolDefinition<any, any, any>>;
}

// Type-safe registry builder
const createPrimitiveRegistry = <T extends Record<string, AnyPrimitiveDefinition>>(
  definitions: T
): PrimitiveRegistry => {
  const registry: PrimitiveRegistry = {
    continuous: new Map(),
    debounce: new Map(),
    workerPool: new Map(),
  };

  for (const [name, def] of Object.entries(definitions)) {
    const withName = { ...def, name };
    switch (def._tag) {
      case "continuous":
        registry.continuous.set(name, withName);
        break;
      case "debounce":
        registry.debounce.set(name, withName);
        break;
      case "workerPool":
        registry.workerPool.set(name, withName);
        break;
    }
  }

  return registry;
};
```

---

## 11. Client Layer

The client provides typed access to jobs with proper instance routing.

### 11.1 JobsClient Factory

```ts
interface JobsClientFactory<T extends PrimitiveRegistry> {
  readonly fromBinding: (binding: DurableObjectNamespace) => JobsClient<T>;
  readonly Tag: Context.Tag<JobsClient<T>, JobsClient<T>>;
}

interface JobsClient<T extends PrimitiveRegistry> {
  readonly continuous: <K extends keyof T["continuous"] & string>(
    name: K
  ) => ContinuousClient<T["continuous"][K]>;

  readonly debounce: <K extends keyof T["debounce"] & string>(
    name: K
  ) => DebounceClient<T["debounce"][K]>;

  readonly workerPool: <K extends keyof T["workerPool"] & string>(
    name: K
  ) => WorkerPoolClient<T["workerPool"][K]>;
}
```

### 11.2 Instance ID Resolution

```ts
const createJobsClient = <T extends PrimitiveRegistry>(
  binding: DurableObjectNamespace,
  registry: PrimitiveRegistry
): JobsClient<T> => {
  // Helper to get stub for an instance
  const getStub = (instanceId: string) =>
    binding.get(binding.idFromName(instanceId));

  return {
    continuous: (name) => ({
      start: ({ id, input }) => {
        const instanceId = `continuous:${name}:${id}`;
        const stub = getStub(instanceId);
        return sendRequest(stub, { _tag: "ContinuousStart", name, id, input });
      },
      stop: (id, options) => {
        const instanceId = `continuous:${name}:${id}`;
        const stub = getStub(instanceId);
        return sendRequest(stub, { _tag: "ContinuousStop", name, id, ...options });
      },
      // ... other methods
    }),

    debounce: (name) => ({
      add: ({ id, event, eventId }) => {
        const instanceId = `debounce:${name}:${id}`;
        const stub = getStub(instanceId);
        return sendRequest(stub, { _tag: "DebounceAdd", name, id, event, eventId });
      },
      // ... other methods
    }),

    workerPool: (name) => {
      const def = registry.workerPool.get(name);
      const concurrency = def?.concurrency ?? 1;
      let roundRobinCounter = 0;

      return {
        enworkerPool: ({ id, event, partitionKey, priority }) => {
          // Route to specific instance based on partitionKey or round-robin
          const instanceIndex = partitionKey
            ? consistentHash(partitionKey, concurrency)
            : roundRobinCounter++ % concurrency;

          const instanceId = `workerPool:${name}:${instanceIndex}`;
          const stub = getStub(instanceId);
          return sendRequest(stub, { _tag: "WorkerPoolEnworkerPool", name, eventId: id, event, priority });
        },

        status: () => {
          // Aggregate status from all instances
          return Effect.all(
            Array.from({ length: concurrency }, (_, i) => {
              const instanceId = `workerPool:${name}:${i}`;
              const stub = getStub(instanceId);
              return sendRequest(stub, { _tag: "WorkerPoolStatus", name, instanceIndex: i });
            })
          ).pipe(Effect.map(aggregateWorkerPoolStatus));
        },

        pause: (index) => {
          if (index !== undefined) {
            const instanceId = `workerPool:${name}:${index}`;
            const stub = getStub(instanceId);
            return sendRequest(stub, { _tag: "WorkerPoolPause", name });
          }
          // Pause all instances
          return Effect.all(
            Array.from({ length: concurrency }, (_, i) => {
              const instanceId = `workerPool:${name}:${i}`;
              const stub = getStub(instanceId);
              return sendRequest(stub, { _tag: "WorkerPoolPause", name });
            })
          ).pipe(Effect.asVoid);
        },
        // ... other methods
      };
    },
  };
};
```

---

## 12. Storage Key Namespacing

All jobs use consistent key prefixes for organization and isolation.

```ts
const STORAGE_KEYS = {
  // Metadata (all jobs)
  metadata: {
    type: "meta:type",
    name: "meta:name",
    instanceId: "meta:instanceId",
    createdAt: "meta:createdAt",
    updatedAt: "meta:updatedAt",
    status: "meta:status",
  },

  // User state (Continuous, Debounce)
  state: "state:data",

  // Continuous-specific
  continuous: {
    runCount: "continuous:runCount",
    nextScheduledAt: "continuous:nextScheduledAt",
    lastExecutedAt: "continuous:lastExecutedAt",
  },

  // Debounce-specific
  debounce: {
    eventCount: "debounce:eventCount",
    debounceStartedAt: "debounce:debounceStartedAt",
    flushScheduledAt: "debounce:flushScheduledAt",
  },

  // WorkerPool-specific
  workerPool: {
    events: "workerPool:events:",        // Prefix: workerPool:events:{eventId}
    pendingIds: "workerPool:pending",    // Ordered array of pending event IDs
    processedCount: "workerPool:processedCount",
    currentEventId: "workerPool:currentEventId",
    currentAttempt: "workerPool:currentAttempt",
    paused: "workerPool:paused",
  },

  // Idempotency (Debounce, WorkerPool)
  idempotency: "idem:",  // Prefix: idem:{eventId}

  // Purge scheduling
  purge: {
    scheduledAt: "purge:scheduledAt",
  },
} as const;
```

---

## 13. Error Types

```ts
import { Data } from "effect";

// Primitive-specific errors
class PrimitiveNotFoundError extends Data.TaggedError("PrimitiveNotFoundError")<{
  readonly primitiveType: "continuous" | "debounce" | "workerPool";
  readonly primitiveName: string;
}> {}

class InstanceNotFoundError extends Data.TaggedError("InstanceNotFoundError")<{
  readonly primitiveType: "continuous" | "debounce" | "workerPool";
  readonly primitiveName: string;
  readonly instanceId: string;
}> {}

class InvalidStateError extends Data.TaggedError("InvalidStateError")<{
  readonly expected: string;
  readonly actual: string;
  readonly operation: string;
}> {}

class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly schemaName: string;
  readonly issues: ReadonlyArray<unknown>;
}> {}

class ExecutionError extends Data.TaggedError("ExecutionError")<{
  readonly primitiveType: "continuous" | "debounce" | "workerPool";
  readonly primitiveName: string;
  readonly instanceId: string;
  readonly cause: unknown;
}> {}

class ClientError extends Data.TaggedError("ClientError")<{
  readonly statusCode: number;
  readonly message: string;
  readonly cause?: unknown;
}> {}

// Re-export from workflow
export { StorageError, SchedulerError } from "@durable-effect/workflow/errors";
```

---

## 14. Factory: createDurableJobs

The main entry point for users.

```ts
interface CreateDurableJobsOptions<T extends Record<string, AnyPrimitiveDefinition>> {
  readonly jobs: T;
  readonly tracking?: {
    readonly enabled: boolean;
    readonly endpoint?: string;
    readonly env?: string;
    readonly serviceKey?: string;
  };
}

interface CreateDurableJobsResult<T extends Record<string, AnyPrimitiveDefinition>> {
  /** The Durable Object class to export */
  readonly Jobs: typeof DurableJobsEngine;

  /** Factory for creating typed clients */
  readonly JobsClient: JobsClientFactory<InferRegistry<T>>;

  /** The registry (for advanced use cases) */
  readonly registry: PrimitiveRegistry;
}

export const createDurableJobs = <T extends Record<string, AnyPrimitiveDefinition>>(
  options: CreateDurableJobsOptions<T>
): CreateDurableJobsResult<T> => {
  const registry = createPrimitiveRegistry(options.jobs);

  // Create DO class with registry and config bound
  class BoundJobsEngine extends DurableJobsEngine {
    constructor(state: DurableObjectState, env: Env) {
      super(state, {
        ...env,
        __PRIMITIVE_REGISTRY__: registry,
        __TRACKING_CONFIG__: options.tracking,
      });
    }
  }

  // Create client factory with Effect Tag for service pattern
  const ClientTag = Context.GenericTag<JobsClient<InferRegistry<T>>>(
    "@durable-effect/jobs/Client"
  );

  const JobsClient: JobsClientFactory<InferRegistry<T>> = {
    fromBinding: (binding) => createJobsClient(binding, registry),
    Tag: ClientTag,
  };

  return {
    Jobs: BoundJobsEngine as any,
    JobsClient,
    registry,
  };
};
```

---

## 15. Testing Support

### 15.1 In-Memory Adapters

```ts
// In-memory storage for testing
export const createInMemoryStorage = (): StorageAdapterService => {
  const data = new Map<string, unknown>();
  return {
    get: (key) => Effect.succeed(data.get(key)),
    put: (key, value) => Effect.sync(() => { data.set(key, value); }),
    putBatch: (entries) => Effect.sync(() => {
      for (const [k, v] of Object.entries(entries)) data.set(k, v);
    }),
    delete: (key) => Effect.sync(() => data.delete(key)),
    deleteAll: () => Effect.sync(() => data.clear()),
    list: (prefix) => Effect.sync(() => {
      const result = new Map<string, unknown>();
      for (const [k, v] of data) {
        if (k.startsWith(prefix)) result.set(k, v);
      }
      return result;
    }),
  };
};

// In-memory scheduler for testing
export const createInMemoryScheduler = () => {
  let scheduledTime: number | undefined = undefined;
  let alarmCallback: (() => Promise<void>) | undefined = undefined;

  return {
    adapter: {
      schedule: (time: number) => Effect.sync(() => { scheduledTime = time; }),
      cancel: () => Effect.sync(() => { scheduledTime = undefined; }),
      getScheduled: () => Effect.succeed(scheduledTime),
    } satisfies SchedulerAdapterService,

    // Test helper: trigger alarm
    triggerAlarm: async () => {
      if (alarmCallback) await alarmCallback();
    },

    // Test helper: set alarm callback
    onAlarm: (cb: () => Promise<void>) => { alarmCallback = cb; },

    // Test helper: get scheduled time
    getScheduledTime: () => scheduledTime,
  };
};
```

### 15.2 Test Harness

```ts
export const createTestJobs = <T extends Record<string, AnyPrimitiveDefinition>>(
  definitions: T
) => {
  const registry = createPrimitiveRegistry(definitions);
  const storage = createInMemoryStorage();
  const scheduler = createInMemoryScheduler();

  const testLayer = pipe(
    Layer.mergeAll(
      Layer.succeed(StorageAdapter, storage),
      Layer.succeed(SchedulerAdapter, scheduler.adapter),
      Layer.succeed(RuntimeAdapter, {
        instanceId: "test-instance",
        now: () => Effect.succeed(Date.now()),
      }),
    ),
    Layer.provideMerge(MetadataManagerLayer),
    Layer.provideMerge(NoopEventTrackerLayer),
    Layer.provideMerge(IdempotencyManagerLayer),
    Layer.provideMerge(ScheduleManagerLayer),
    Layer.provideMerge(PurgeManagerLayer),
    Layer.provideMerge(PrimitiveOrchestratorLayer(registry)),
  );

  return {
    /** Run an effect with test layer */
    run: <A, E>(effect: Effect.Effect<A, E, PrimitiveOrchestrator>) =>
      Effect.runPromise(effect.pipe(Effect.provide(testLayer))),

    /** Trigger alarm (simulate time passing) */
    triggerAlarm: () => scheduler.triggerAlarm(),

    /** Get scheduled alarm time */
    getScheduledTime: () => scheduler.getScheduledTime(),

    /** Access storage directly for assertions */
    storage,
  };
};
```

---

## 16. File Structure

```
packages/jobs/
├── src/
│   ├── index.ts                      # Public exports
│   ├── factory.ts                    # createDurableJobs
│   │
│   ├── services/
│   │   ├── metadata.ts               # MetadataManager
│   │   ├── tracker.ts                # EventTracker
│   │   ├── state.ts                  # StateManager factory
│   │   ├── idempotency.ts            # IdempotencyManager
│   │   ├── schedule.ts               # ScheduleManager
│   │   └── purge.ts                  # PurgeManager
│   │
│   ├── jobs/
│   │   ├── continuous/
│   │   │   ├── index.ts              # Public exports
│   │   │   ├── definition.ts         # ContinuousDefinition type
│   │   │   ├── make.ts               # Continuous.make factory
│   │   │   ├── executor.ts           # ContinuousExecutor
│   │   │   ├── orchestrator.ts       # ContinuousOrchestrator
│   │   │   ├── context.ts            # ContinuousContext
│   │   │   └── client.ts             # ContinuousClient
│   │   │
│   │   ├── debounce/
│   │   │   ├── index.ts              # Public exports
│   │   │   ├── definition.ts         # DebounceDefinition type
│   │   │   ├── make.ts               # Debounce.make factory
│   │   │   ├── executor.ts           # DebounceExecutor
│   │   │   ├── orchestrator.ts       # DebounceOrchestrator
│   │   │   ├── context.ts            # DebounceContext types
│   │   │   └── client.ts             # DebounceClient
│   │   │
│   │   └── workerPool/
│   │       ├── index.ts              # Public exports
│   │       ├── definition.ts         # WorkerPoolDefinition type
│   │       ├── make.ts               # WorkerPool.make factory
│   │       ├── executor.ts           # WorkerPoolExecutor
│   │       ├── orchestrator.ts       # WorkerPoolOrchestrator
│   │       ├── context.ts            # WorkerPoolContext types
│   │       └── client.ts             # WorkerPoolClient
│   │
│   ├── orchestrator/
│   │   ├── index.ts                  # PrimitiveOrchestrator
│   │   └── types.ts                  # Request/Response types
│   │
│   ├── engine/
│   │   ├── engine.ts                 # DurableJobsEngine DO class
│   │   └── types.ts                  # Engine interfaces
│   │
│   ├── registry/
│   │   ├── registry.ts               # PrimitiveRegistry
│   │   └── types.ts                  # Registry types
│   │
│   ├── client/
│   │   ├── client.ts                 # JobsClient factory
│   │   └── types.ts                  # Client types
│   │
│   ├── errors/
│   │   └── index.ts                  # Error types
│   │
│   ├── events/
│   │   └── index.ts                  # Event type definitions
│   │
│   └── testing/
│       ├── adapters.ts               # In-memory adapters
│       └── harness.ts                # Test harness
│
├── test/
│   ├── continuous.test.ts
│   ├── debounce.test.ts
│   ├── workerPool.test.ts
│   └── integration.test.ts
│
└── package.json
```

---

## 17. Summary

### Layer Responsibilities

| Layer | Purpose | Key Types |
|-------|---------|-----------|
| **Client** | User-facing API, instance routing | `JobsClient`, type-specific clients |
| **Engine** | DO entry point, layer composition | `DurableJobsEngine` |
| **Orchestrator** | Request routing, alarm dispatch | `PrimitiveOrchestrator`, type-specific orchestrators |
| **Executor** | Primitive-specific logic | `ContinuousExecutor`, `DebounceExecutor`, `WorkerPoolExecutor` |
| **Shared Services** | Cross-cutting concerns | `MetadataManager`, `EventTracker`, `StateManager`, etc. |
| **Adapters** | Platform abstraction | `StorageAdapter`, `SchedulerAdapter`, `RuntimeAdapter` |
| **Platform** | Implementation | Cloudflare Durable Objects |

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Single DO class for all jobs** | Simplifies deployment, reduces binding complexity |
| **Shared adapters with workflow** | Code reuse, consistent platform abstraction |
| **Instance ID includes primitive type** | Enables alarm routing without additional storage reads |
| **WorkerPool uses multiple DO instances** | Each DO processes sequentially; concurrency via N instances |
| **Client handles routing** | Keeps DO logic simple; client has full type information |
| **Fire-and-forget event tracking** | Non-blocking observability via `ctx.waitUntil()` |

### Architecture Benefits

- **Code sharing** - Adapters, error types shared with workflow package
- **Swappable compute** - Replace DO with another platform via adapters
- **Consistent patterns** - All jobs follow same layered structure
- **Type safety** - Full Effect Schema integration with TypeScript inference
- **Observability** - Unified event tracking across all primitive types
- **Testability** - In-memory adapters for fast, isolated unit tests
