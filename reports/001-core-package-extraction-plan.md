# Core Package Extraction Plan

This document outlines a comprehensive plan for extracting shared components from `@durable-effect/workflow` into `@durable-effect/core` to enable code reuse with the new `@durable-effect/primitives` package.

---

## 1. Executive Summary

### Current State

| Package | Purpose | Shared Code |
|---------|---------|-------------|
| `@durable-effect/core` | Minimal shared abstractions | PauseSignal, Events, ExecutionContext |
| `@durable-effect/workflow` | Workflow engine | Adapters, errors, tracker, backoff |
| `@durable-effect/primitives` | (new) Primitive engine | Will share adapters, errors, tracker |

### Target State

| Package | Purpose | Contents |
|---------|---------|----------|
| `@durable-effect/core` | **All shared infrastructure** | Adapters, errors, tracker, testing, backoff |
| `@durable-effect/workflow` | Workflow-specific logic | Orchestrator, executor, state machine, primitives |
| `@durable-effect/primitives` | Primitive-specific logic | Type-specific executors, orchestrators |

### Benefits

1. **No Circular Dependencies** - Core has no dependencies on workflow or primitives
2. **Single Source of Truth** - Adapter interfaces defined once
3. **Consistent Patterns** - Same error types, tracking, testing across packages
4. **Easier Maintenance** - Changes to adapters propagate automatically

---

## 2. Components to Extract

### 2.1 Adapter Interfaces (HIGH PRIORITY)

These are the platform abstraction interfaces used by both workflow and primitives.

| Source File | Target Location | Dependencies |
|-------------|-----------------|--------------|
| `workflow/src/adapters/storage.ts` | `core/src/adapters/storage.ts` | StorageError |
| `workflow/src/adapters/scheduler.ts` | `core/src/adapters/scheduler.ts` | SchedulerError |
| `workflow/src/adapters/runtime.ts` | `core/src/adapters/runtime.ts` | StorageAdapter, SchedulerAdapter |

**StorageAdapter Interface:**
```ts
// core/src/adapters/storage.ts
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

**SchedulerAdapter Interface:**
```ts
// core/src/adapters/scheduler.ts
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

**RuntimeAdapter Interface:**
```ts
// core/src/adapters/runtime.ts
type LifecycleEvent =
  | { readonly _tag: "Initialized" }
  | { readonly _tag: "AlarmFired" }
  | { readonly _tag: "Shutdown" }
  | { readonly _tag: "Reset"; readonly reason?: string };

interface RuntimeAdapterService {
  readonly instanceId: string;
  readonly now: () => Effect.Effect<number>;
}

class RuntimeAdapter extends Context.Tag("@durable-effect/RuntimeAdapter")<
  RuntimeAdapter,
  RuntimeAdapterService
>() {}

type RuntimeLayer = Layer.Layer<StorageAdapter | SchedulerAdapter | RuntimeAdapter>;
```

### 2.2 Durable Object Adapter Implementations (HIGH PRIORITY)

Platform-specific implementations of the adapter interfaces.

| Source File | Target Location | Dependencies |
|-------------|-----------------|--------------|
| `workflow/src/adapters/durable-object/storage.ts` | `core/src/adapters/durable-object/storage.ts` | StorageAdapter, StorageError |
| `workflow/src/adapters/durable-object/scheduler.ts` | `core/src/adapters/durable-object/scheduler.ts` | SchedulerAdapter, SchedulerError |
| `workflow/src/adapters/durable-object/runtime.ts` | `core/src/adapters/durable-object/runtime.ts` | All adapters |

### 2.3 Error Types (HIGH PRIORITY)

Shared error types used across packages.

| Error Type | Current Location | Used By |
|------------|------------------|---------|
| `StorageError` | `workflow/src/errors.ts` | Workflow, Primitives |
| `SchedulerError` | `workflow/src/errors.ts` | Workflow, Primitives |

**Note:** Keep these in core. Other errors remain package-specific:
- `InvalidTransitionError` → workflow-specific (state machine)
- `RecoveryError` → workflow-specific (recovery manager)
- `OrchestratorError` → each package has its own orchestrator errors

```ts
// core/src/errors.ts (additions)

class StorageError extends Data.TaggedError("StorageError")<{
  readonly operation: "get" | "put" | "delete" | "deleteAll" | "list";
  readonly key?: string;
  readonly cause: unknown;
}> {
  get message(): string {
    const keyPart = this.key ? ` for key "${this.key}"` : "";
    return `Storage ${this.operation}${keyPart} failed: ${
      this.cause instanceof Error ? this.cause.message : String(this.cause)
    }`;
  }
}

class SchedulerError extends Data.TaggedError("SchedulerError")<{
  readonly operation: "schedule" | "cancel" | "get";
  readonly cause: unknown;
}> {
  get message(): string {
    return `Scheduler ${this.operation} failed: ${
      this.cause instanceof Error ? this.cause.message : String(this.cause)
    }`;
  }
}
```

### 2.4 Event Tracker Infrastructure (MEDIUM PRIORITY)

The tracker pattern is reusable, but event types are package-specific.

| Component | Shared? | Notes |
|-----------|---------|-------|
| `EventTracker` service interface | **Yes** | Generic emit/flush/pending |
| `emitEvent` helper | **Yes** | Generic helper |
| `flushEvents` helper | **Yes** | Generic helper |
| `createHttpBatchTracker` | **Yes** | Transport is generic |
| Event schemas/types | **No** | Workflow has its own, Primitives has its own |
| `NoopTrackerLayer` | **Yes** | Disabled tracking |

**Generic EventTracker Interface:**
```ts
// core/src/tracker/tracker.ts

// Generic event type (each package defines their own)
interface BaseTrackingEvent {
  readonly type: string;
  readonly timestamp: string;
  readonly eventId: string;
}

interface EventTrackerService<E extends BaseTrackingEvent = BaseTrackingEvent> {
  readonly emit: (event: E) => Effect.Effect<void>;
  readonly flush: () => Effect.Effect<void>;
  readonly pending: () => Effect.Effect<number>;
}

// Generic tag - packages can use this or create their own typed version
class EventTracker extends Context.Tag("@durable-effect/EventTracker")<
  EventTracker,
  EventTrackerService
>() {}

// Helpers
const emitEvent = <E extends BaseTrackingEvent>(event: E): Effect.Effect<void> =>
  Effect.flatMap(Effect.serviceOption(EventTracker), (option) =>
    option._tag === "Some" ? option.value.emit(event) : Effect.void,
  );

const flushEvents: Effect.Effect<void> = Effect.flatMap(
  Effect.serviceOption(EventTracker),
  (option) => (option._tag === "Some" ? option.value.flush() : Effect.void),
);
```

**HTTP Batch Tracker (generic version):**
```ts
// core/src/tracker/http-batch.ts

interface HttpBatchTrackerConfig {
  readonly endpoint: string;
  readonly env: string;
  readonly serviceKey: string;
  readonly batchSize?: number;
  readonly flushIntervalMs?: number;
}

// Generic factory - caller provides event enrichment function
const createHttpBatchTracker = <E extends BaseTrackingEvent>(
  config: HttpBatchTrackerConfig,
  enrich: (event: E) => E & { env: string; serviceKey: string },
): EventTrackerService<E> => { ... }
```

### 2.5 Testing Utilities (MEDIUM PRIORITY)

In-memory adapters for testing.

| Component | Target Location | Purpose |
|-----------|-----------------|---------|
| `createInMemoryStorage` | `core/src/testing/storage.ts` | Test storage adapter |
| `createInMemoryScheduler` | `core/src/testing/scheduler.ts` | Test scheduler adapter |
| `createInMemoryRuntime` | `core/src/testing/runtime.ts` | Combined test runtime |
| `NoopTrackerLayer` | `core/src/testing/tracker.ts` | Disabled tracker |

```ts
// core/src/testing/storage.ts
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

// core/src/testing/scheduler.ts
export const createInMemoryScheduler = () => {
  let scheduledTime: number | undefined = undefined;

  return {
    adapter: {
      schedule: (time: number) => Effect.sync(() => { scheduledTime = time; }),
      cancel: () => Effect.sync(() => { scheduledTime = undefined; }),
      getScheduled: () => Effect.succeed(scheduledTime),
    } satisfies SchedulerAdapterService,

    // Test helpers
    getScheduledTime: () => scheduledTime,
    isScheduled: () => scheduledTime !== undefined,
    clear: () => { scheduledTime = undefined; },
  };
};
```

### 2.6 Backoff Utilities (LOW PRIORITY)

Reusable backoff strategies for retries.

| Source File | Target Location |
|-------------|-----------------|
| `workflow/src/backoff.ts` | `core/src/backoff.ts` |

```ts
// core/src/backoff.ts

type BackoffStrategy =
  | { readonly _tag: "exponential"; readonly baseMs: number; readonly maxMs?: number }
  | { readonly _tag: "linear"; readonly incrementMs: number; readonly maxMs?: number }
  | { readonly _tag: "fixed"; readonly delayMs: number };

const calculateBackoff = (
  strategy: BackoffStrategy,
  attempt: number,
): number => { ... }
```

### 2.7 Keep in Current Location (DO NOT EXTRACT)

These components are package-specific and should NOT be moved to core:

| Component | Package | Reason |
|-----------|---------|--------|
| `PauseSignal` | core (keep) | Already in core, workflow-specific signal |
| Workflow event schemas | core (keep) | Workflow-specific event types |
| `ExecutionContext` | core → **REMOVE** | Legacy, replaced by adapters |
| `InvalidTransitionError` | workflow | Workflow state machine specific |
| `RecoveryError` | workflow | Workflow recovery specific |
| `OrchestratorError` | workflow | Workflow orchestrator specific |
| `WorkflowStateMachine` | workflow | Workflow-specific |
| `WorkflowOrchestrator` | workflow | Workflow-specific |
| `WorkflowExecutor` | workflow | Workflow-specific |

---

## 3. Migration Plan

### Phase 1: Create New Core Structure (Non-Breaking)

**Goal:** Set up new directory structure in core without breaking existing code.

**Tasks:**
1. Create `core/src/adapters/` directory
2. Create `core/src/testing/` directory
3. Create `core/src/tracker/` directory
4. Add new files (initially empty or with interfaces only)

**New Core Structure:**
```
packages/core/src/
├── index.ts                    # Public exports
├── errors.ts                   # Existing + StorageError, SchedulerError
├── events.ts                   # Existing (workflow events)
├── backoff.ts                  # NEW: Backoff strategies
│
├── adapters/
│   ├── index.ts                # Adapter exports
│   ├── storage.ts              # StorageAdapter interface
│   ├── scheduler.ts            # SchedulerAdapter interface
│   ├── runtime.ts              # RuntimeAdapter interface
│   └── durable-object/
│       ├── index.ts            # DO adapter exports
│       ├── storage.ts          # DO storage implementation
│       ├── scheduler.ts        # DO scheduler implementation
│       └── runtime.ts          # DO runtime layer factory
│
├── tracker/
│   ├── index.ts                # Tracker exports
│   ├── tracker.ts              # EventTracker interface
│   └── http-batch.ts           # HTTP batch implementation
│
├── testing/
│   ├── index.ts                # Testing exports
│   ├── storage.ts              # In-memory storage
│   ├── scheduler.ts            # In-memory scheduler
│   ├── runtime.ts              # In-memory runtime layer
│   └── tracker.ts              # Noop tracker
│
└── services/
    ├── index.ts                # Service exports
    └── execution-context.ts    # DEPRECATED (to be removed)
```

### Phase 2: Copy Adapters to Core (Non-Breaking)

**Goal:** Copy adapter code to core, workflow still has its copies.

**Tasks:**
1. Copy `workflow/src/adapters/storage.ts` → `core/src/adapters/storage.ts`
2. Copy `workflow/src/adapters/scheduler.ts` → `core/src/adapters/scheduler.ts`
3. Copy `workflow/src/adapters/runtime.ts` → `core/src/adapters/runtime.ts`
4. Copy `workflow/src/adapters/durable-object/*` → `core/src/adapters/durable-object/*`
5. Add `StorageError` and `SchedulerError` to `core/src/errors.ts`
6. Update imports in copied files to use core paths
7. Export from `core/src/index.ts`

### Phase 3: Copy Tracker to Core (Non-Breaking)

**Goal:** Copy tracker infrastructure to core.

**Tasks:**
1. Create generic `EventTracker` interface in `core/src/tracker/tracker.ts`
2. Copy HTTP batch tracker pattern to `core/src/tracker/http-batch.ts`
3. Create `NoopTrackerLayer` in `core/src/testing/tracker.ts`
4. Export from `core/src/index.ts`

### Phase 4: Copy Testing Utilities to Core (Non-Breaking)

**Goal:** Create in-memory adapters for testing.

**Tasks:**
1. Create `core/src/testing/storage.ts` with in-memory storage
2. Create `core/src/testing/scheduler.ts` with in-memory scheduler
3. Create `core/src/testing/runtime.ts` with combined runtime layer
4. Export from `core/src/index.ts`

### Phase 5: Copy Backoff to Core (Non-Breaking)

**Goal:** Move backoff utilities to core.

**Tasks:**
1. Copy `workflow/src/backoff.ts` → `core/src/backoff.ts`
2. Export from `core/src/index.ts`

### Phase 6: Update Workflow to Use Core (BREAKING for workflow internals)

**Goal:** Workflow imports from core instead of having its own copies.

**Tasks:**
1. Update `workflow/src/adapters/storage.ts` to re-export from core
2. Update `workflow/src/adapters/scheduler.ts` to re-export from core
3. Update `workflow/src/adapters/runtime.ts` to re-export from core
4. Update `workflow/src/adapters/durable-object/*` to re-export from core
5. Update `workflow/src/errors.ts` to import StorageError/SchedulerError from core
6. Update all internal imports in workflow package
7. Update workflow tests to use testing utilities from core
8. Remove duplicate code from workflow (now just re-exports)

### Phase 7: Deprecate ExecutionContext (Non-Breaking)

**Goal:** Mark legacy ExecutionContext as deprecated.

**Tasks:**
1. Add `@deprecated` JSDoc to `ExecutionContext` in `core/src/services/execution-context.ts`
2. Document migration path to new adapters
3. Keep exported for backwards compatibility
4. Remove in next major version

### Phase 8: Create Primitives Package Using Core (New)

**Goal:** New primitives package imports from core.

**Tasks:**
1. Create `packages/primitives/` directory
2. Import adapters from `@durable-effect/core`
3. Import errors from `@durable-effect/core`
4. Import testing utilities from `@durable-effect/core`
5. Create primitives-specific components (orchestrators, executors)

---

## 4. Final Core Package Structure

```
packages/core/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts
    │
    ├── errors.ts
    │   ├── PauseSignal (existing)
    │   ├── StorageError (new)
    │   └── SchedulerError (new)
    │
    ├── events.ts (existing - workflow events)
    │
    ├── backoff.ts (new)
    │
    ├── adapters/
    │   ├── index.ts
    │   ├── storage.ts
    │   ├── scheduler.ts
    │   ├── runtime.ts
    │   └── durable-object/
    │       ├── index.ts
    │       ├── storage.ts
    │       ├── scheduler.ts
    │       └── runtime.ts
    │
    ├── tracker/
    │   ├── index.ts
    │   ├── tracker.ts
    │   └── http-batch.ts
    │
    ├── testing/
    │   ├── index.ts
    │   ├── storage.ts
    │   ├── scheduler.ts
    │   ├── runtime.ts
    │   └── tracker.ts
    │
    └── services/
        ├── index.ts
        └── execution-context.ts (DEPRECATED)
```

---

## 5. Export Structure

### Main Exports (core/src/index.ts)

```ts
// Errors
export { PauseSignal, StorageError, SchedulerError } from "./errors";

// Adapters
export {
  StorageAdapter,
  type StorageAdapterService,
  SchedulerAdapter,
  type SchedulerAdapterService,
  RuntimeAdapter,
  type RuntimeAdapterService,
  type LifecycleEvent,
  type RuntimeLayer,
} from "./adapters";

// DO Adapters
export {
  createDOStorageAdapter,
  createDOSchedulerAdapter,
  createDurableObjectRuntime,
} from "./adapters/durable-object";

// Tracker
export {
  EventTracker,
  type EventTrackerService,
  type BaseTrackingEvent,
  emitEvent,
  flushEvents,
  createHttpBatchTracker,
  type HttpBatchTrackerConfig,
} from "./tracker";

// Testing
export {
  createInMemoryStorage,
  createInMemoryScheduler,
  createInMemoryRuntime,
  NoopTrackerLayer,
} from "./testing";

// Backoff
export {
  type BackoffStrategy,
  calculateBackoff,
} from "./backoff";

// Events (workflow-specific, kept for backwards compatibility)
export * from "./events";

// Services (DEPRECATED)
export {
  ExecutionContext,
  createExecutionContext,
  type ExecutionContextService,
} from "./services";
```

---

## 6. Dependency Graph

### Before Extraction

```
┌─────────────────┐
│   @app (user)   │
└────────┬────────┘
         │ uses
         ▼
┌─────────────────┐     ┌─────────────────┐
│    workflow     │────▶│      core       │
│                 │     │                 │
│ - adapters      │     │ - PauseSignal   │
│ - errors        │     │ - events        │
│ - tracker       │     │ - ExecutionCtx  │
│ - orchestrator  │     │   (legacy)      │
│ - executor      │     │                 │
└─────────────────┘     └─────────────────┘
```

### After Extraction

```
┌─────────────────┐
│   @app (user)   │
└────────┬────────┘
         │ uses
    ┌────┴────┐
    ▼         ▼
┌──────────┐ ┌──────────┐
│ workflow │ │primitives│
│          │ │          │
│-orches-  │ │-executors│
│ trator   │ │-orchest- │
│-executor │ │ rators   │
│-state    │ │-metadata │
│ machine  │ │          │
└────┬─────┘ └────┬─────┘
     │            │
     └──────┬─────┘
            │ imports
            ▼
┌─────────────────────────┐
│          core           │
│                         │
│  - adapters (interfaces)│
│  - adapters/do (impl)   │
│  - errors               │
│  - tracker              │
│  - testing              │
│  - backoff              │
│  - events (workflow)    │
│  - PauseSignal          │
│                         │
└─────────────────────────┘
```

---

## 7. Breaking Changes

### For workflow Package Users

**None** - The public API remains unchanged. Internal refactoring only.

### For workflow Package Contributors

1. Import paths change from `../errors` to `@durable-effect/core`
2. Some files become thin re-exports

### For primitives Package (New)

No breaking changes - it's a new package that imports from core from the start.

---

## 8. Rollout Timeline

| Phase | Description | Risk | Dependencies |
|-------|-------------|------|--------------|
| 1 | Create core structure | Low | None |
| 2 | Copy adapters | Low | Phase 1 |
| 3 | Copy tracker | Low | Phase 2 |
| 4 | Copy testing | Low | Phase 2 |
| 5 | Copy backoff | Low | None |
| 6 | Update workflow imports | Medium | Phases 2-5 |
| 7 | Deprecate ExecutionContext | Low | Phase 2 |
| 8 | Create primitives | Low | Phases 2-5 |

**Recommended Approach:**
- Phases 1-5 can be done in a single PR (additive, non-breaking)
- Phase 6 should be a separate PR (internal refactoring)
- Phase 7 can be done alongside Phase 6
- Phase 8 is independent once Phases 2-5 are complete

---

## 9. Success Criteria

1. **No Circular Dependencies** - `core` has no dependencies on `workflow` or `primitives`
2. **All Tests Pass** - Workflow tests continue to pass after migration
3. **No Public API Changes** - External users see no difference
4. **Primitives Works** - New primitives package can import from core
5. **Single Source of Truth** - No duplicate adapter code between packages

---

## 10. Open Questions

1. **Event Schema Location** - Should workflow-specific events stay in core or move to workflow?
   - **Recommendation:** Keep in core for backwards compatibility, but namespace clearly

2. **PauseSignal Location** - Is this workflow-specific or could primitives use it?
   - **Recommendation:** Keep in core, it's a general pause signal pattern

3. **Version Sync** - Should core, workflow, and primitives share a version number?
   - **Recommendation:** Yes, use monorepo versioning

4. **Tracker Generics** - How generic should the tracker interface be?
   - **Recommendation:** Generic with type parameter, each package defines its event type
