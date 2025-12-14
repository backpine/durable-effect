# Workflow Package Architecture

## Executive Summary

This document provides a comprehensive analysis of the `@durable-effect/workflow` package architecture, identifies structural issues that complicate adding new runtimes and implementing recovery logic, and proposes a new runtime-agnostic architecture built on Effect services.

---

## Part 1: Current Architecture Analysis

### 1.1 Package Overview

The workflow system spans two packages:

```
packages/
├── core/                    # Shared abstractions
│   └── src/
│       ├── errors.ts        # PauseSignal
│       ├── events.ts        # Event schemas (internal + wire)
│       └── services/
│           └── execution-context.ts  # ExecutionContext service
│
└── workflow/                # Main workflow engine
    └── src/
        ├── engine.ts        # DurableObject class (MONOLITH)
        ├── workflow.ts      # Workflow jobs (step, sleep, retry)
        ├── transitions.ts   # Status + event emission
        ├── types.ts         # Type definitions
        ├── errors.ts        # Error types
        ├── backoff.ts       # Backoff strategies
        ├── services/        # Effect services
        ├── tracker/         # Event tracking
        └── client/          # Type-safe client
```

### 1.2 Current Layer Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              USER APPLICATION                                    │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌──────────────────────┐    ┌──────────────────────────────────────────────┐   │
│  │   WorkflowClient     │    │             User Workflow Code               │   │
│  │   (client/)          │    │                                              │   │
│  │                      │    │  const myWorkflow = Workflow.make(           │   │
│  │  - fromBinding()     │    │    (input) => Effect.gen(function* () {      │   │
│  │  - run/runAsync      │    │      yield* Workflow.step('Fetch', ...)      │   │
│  │  - cancel            │    │      yield* Workflow.sleep('5 seconds')      │   │
│  │  - status            │    │    })                                        │   │
│  └──────────┬───────────┘    │  );                                          │   │
│             │                └───────────────────┬──────────────────────────┘   │
│             │                                    │                               │
│             │ RPC                                │ Definition                    │
│             ▼                                    ▼                               │
├─────────────────────────────────────────────────────────────────────────────────┤
│                              ENGINE LAYER (engine.ts)                            │
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │                    DurableWorkflowEngine (extends DurableObject)          │   │
│  │                                                                           │   │
│  │  RESPONSIBILITIES (TOO MANY):                                             │   │
│  │  ├── RPC Method Handlers (run, runAsync, cancel, getStatus, etc.)        │   │
│  │  ├── Alarm Handler                                                        │   │
│  │  ├── State Transitions (calls transitionWorkflow)                        │   │
│  │  ├── Workflow Execution Orchestration (#executeWorkflow)                 │   │
│  │  ├── Result Handling (handleWorkflowResult)                              │   │
│  │  ├── Cancellation Logic                                                   │   │
│  │  ├── Tracker Layer Management                                             │   │
│  │  └── Storage Cleanup                                                      │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
├─────────────────────────────────────────────────────────────────────────────────┤
│                           PRIMITIVES LAYER (workflow.ts)                         │
│                                                                                  │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐    │
│  │  Workflow.    │  │  Workflow.    │  │  Workflow.    │  │  Workflow.    │    │
│  │  step()       │  │  sleep()      │  │  retry()      │  │  timeout()    │    │
│  │               │  │               │  │               │  │               │    │
│  │  - Cache      │  │  - Pause      │  │  - Backoff    │  │  - Deadline   │    │
│  │  - Execute    │  │    tracking   │  │  - Alarm      │  │  - Timeout    │    │
│  │  - Events     │  │  - Alarm      │  │  - Events     │  │  - Events     │    │
│  └───────┬───────┘  └───────┬───────┘  └───────┬───────┘  └───────┬───────┘    │
│          │                  │                  │                  │             │
│          └──────────────────┴──────────────────┴──────────────────┘             │
│                                      │                                          │
│                                      ▼                                          │
├─────────────────────────────────────────────────────────────────────────────────┤
│                            SERVICES LAYER (services/)                            │
│                                                                                  │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐              │
│  │ WorkflowContext  │  │   StepContext    │  │  WorkflowScope   │              │
│  │                  │  │                  │  │                  │              │
│  │ - workflowId     │  │ - stepName       │  │ - Compile-time   │              │
│  │ - workflowName   │  │ - attempt        │  │   nesting guard  │              │
│  │ - input          │  │ - getMeta/setMeta│  │                  │              │
│  │ - executionId    │  │ - getResult      │  │                  │              │
│  │ - completedSteps │  │ - setResult      │  │                  │              │
│  │ - pauseIndex     │  │ - startedAt      │  │                  │              │
│  │ - pendingResume  │  │ - deadline       │  │                  │              │
│  └────────┬─────────┘  └────────┬─────────┘  └──────────────────┘              │
│           │                     │                                               │
│           └──────────┬──────────┘                                               │
│                      ▼                                                          │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │                      Storage Utils (storage-utils.ts)                     │   │
│  │                                                                           │   │
│  │  storageGet() / storagePut() / storageDelete() / storagePutBatch()       │   │
│  │  - Retry with exponential backoff                                         │   │
│  │  - Error classification (retryable vs permanent)                          │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
│                                      │                                          │
│                                      ▼                                          │
├─────────────────────────────────────────────────────────────────────────────────┤
│                              CORE LAYER (@durable-effect/core)                   │
│                                                                                  │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐              │
│  │ ExecutionContext │  │   PauseSignal    │  │  Event Schemas   │              │
│  │                  │  │                  │  │                  │              │
│  │ - storage        │  │ - reason         │  │ - Internal types │              │
│  │ - setAlarm()     │  │ - resumeAt       │  │ - Wire types     │              │
│  │                  │  │ - stepName       │  │ - createBaseEvent│              │
│  └────────┬─────────┘  └──────────────────┘  └──────────────────┘              │
│           │                                                                     │
│           ▼                                                                     │
├─────────────────────────────────────────────────────────────────────────────────┤
│                         CLOUDFLARE DURABLE OBJECTS RUNTIME                       │
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │                        DurableObjectStorage                               │   │
│  │                                                                           │   │
│  │  get<T>(key) / put(key, value) / delete(key) / setAlarm(time)            │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 1.3 Detailed Layer Analysis

#### Layer 1: Engine (engine.ts) - 749 lines

**Current Responsibilities** (too many!):

| Responsibility | Lines | Description |
|---------------|-------|-------------|
| Class definition | ~50 | DurableObject class setup |
| `run()` method | ~45 | Sync workflow execution |
| `runAsync()` method | ~45 | Async workflow queueing |
| `alarm()` handler | ~85 | Resume/start queued workflows |
| `cancel()` method | ~80 | Cancellation logic |
| `#executeWorkflow()` | ~50 | Core execution orchestration |
| `handleWorkflowResult()` | ~130 | Exit → transition mapping |
| Query methods | ~20 | getStatus, getCompletedSteps, getMeta |

**Problems:**
1. **Monolithic**: All orchestration in one class
2. **Runtime coupling**: Extends `DurableObject` directly
3. **No recovery logic**: Constructor does nothing
4. **Mixed concerns**: RPC handling mixed with state management
5. **Hard to test**: Requires full DO environment

#### Layer 2: Transitions (transitions.ts) - 169 lines

**Purpose**: Unified status update + event emission

```typescript
// Single function for all transitions
transitionWorkflow(storage, workflowId, workflowName, transition, executionId)

// Transition types:
type WorkflowTransition =
  | { _tag: "Start"; input: unknown }
  | { _tag: "Queue"; input: unknown }
  | { _tag: "Resume" }
  | { _tag: "Complete"; completedSteps; durationMs }
  | { _tag: "Pause"; reason; resumeAt; stepName }
  | { _tag: "Fail"; error; completedSteps }
  | { _tag: "Cancel"; reason; completedSteps }
```

**Problems:**
1. **No state validation**: Doesn't check if transition is valid from current state
2. **Direct storage coupling**: Takes `DurableObjectStorage` directly
3. **No recovery transitions**: Missing `Recover` transition type

#### Layer 3: Workflow Jobs (workflow.ts) - 834 lines

| Primitive | Purpose | Dependencies |
|-----------|---------|--------------|
| `step()` | Execute + cache idempotent operation | ExecutionContext, WorkflowContext, StepContext |
| `sleep()` | Durable pause with alarm | ExecutionContext, WorkflowContext |
| `retry()` | Durable retry with backoff | ExecutionContext, StepContext, WorkflowContext |
| `timeout()` | Step deadline tracking | StepContext, WorkflowContext |

**Problems:**
1. **Mixed concerns**: Orchestration logic in jobs
2. **Direct storage access**: Through ExecutionContext.storage
3. **Complex state tracking**: `step()` has 7 phases

#### Layer 4: Services (services/)

| Service | File | Purpose |
|---------|------|---------|
| `WorkflowContext` | workflow-context.ts | Workflow-level state access |
| `StepContext` | step-context.ts | Step-level state + caching |
| `WorkflowScope` | workflow-scope.ts | Compile-time nesting guard |
| `StepClock` | step-clock.ts | Reject Effect.sleep in steps |
| Storage Utils | storage-utils.ts | Retryable storage operations |

**Problems:**
1. **Directly coupled to `DurableObjectStorage`**: No abstraction
2. **Created imperatively**: Not Effect services with layers
3. **No unified state management**: State scattered across contexts

#### Layer 5: Tracker (tracker/)

| Component | Purpose |
|-----------|---------|
| `EventTracker` | Effect service tag |
| `createHttpBatchTracker()` | Batched HTTP delivery |
| `emitEvent()` | Safe event emission |
| `flushEvents` | Trigger batch send |
| `NoopTrackerLayer` | Disabled tracking |

**Well designed**: Clean separation, Effect-based, optional.

#### Layer 6: Client (client/)

| Component | Purpose |
|-----------|---------|
| `WorkflowClientFactory` | Create typed clients |
| `WorkflowClientInstance` | Type-safe operations |
| `createClientInstance()` | Instance from binding |

**Well designed**: Clean API, type-safe, decoupled.

### 1.4 Storage Key Schema

Current storage keys used:

```
workflow:status          # WorkflowStatus
workflow:name            # string
workflow:input           # unknown
workflow:executionId     # string | undefined
workflow:completedSteps  # string[]
workflow:completedPauseIndex  # number
workflow:pendingResumeAt # number | undefined
workflow:cancelled       # boolean
workflow:cancelReason    # string | undefined
workflow:meta:{key}      # any

step:{name}:attempt      # number
step:{name}:startedAt    # number
step:{name}:result       # T
step:{name}:meta:{key}   # any
```

### 1.5 Control Flow Analysis

```
                              ┌─────────────────────┐
                              │   run() / runAsync()│
                              └──────────┬──────────┘
                                         │
                    ┌────────────────────┼────────────────────┐
                    │                    │                    │
                    ▼                    ▼                    ▼
             [Idempotent Check]    [Store Meta]        [Get Definition]
                    │                    │                    │
                    └────────────────────┼────────────────────┘
                                         │
                              ┌──────────┴──────────┐
                              │                     │
                     (sync run)                (async runAsync)
                              │                     │
                              ▼                     ▼
                    #executeWorkflow()       transitionWorkflow(Queue)
                              │                     │
                              │                     ▼
                              │              storage.setAlarm()
                              │                     │
                              │                     ▼
                              │                 [return]
                              │
                              │                 ... alarm fires ...
                              │                     │
                              │                     ▼
                              │                 alarm()
                              │                     │
                              │     ┌───────────────┴───────────────┐
                              │     │                               │
                              │  (Queued)                       (Paused)
                              │     │                               │
                              │     ▼                               ▼
                              │  transitionWorkflow(Start)  transitionWorkflow(Resume)
                              │     │                               │
                              │     └───────────────┬───────────────┘
                              │                     │
                              └──────────┬──────────┘
                                         │
                                         ▼
                              ┌─────────────────────┐
                              │  #executeWorkflow() │
                              │                     │
                              │  1. transitionWorkflow(Start/Resume)
                              │  2. workflowDef(input)
                              │  3. handleWorkflowResult()
                              │  4. flushEvents
                              └──────────┬──────────┘
                                         │
                    ┌────────────────────┼────────────────────┐
                    │                    │                    │
                    ▼                    ▼                    ▼
            [Exit.Success]       [PauseSignal]          [Failure]
                    │                    │                    │
                    ▼                    ▼                    ▼
           Complete + cleanup     Pause              Fail + cleanup
```

### 1.6 Critical Issues Summary

| Issue | Impact | Location |
|-------|--------|----------|
| **No runtime abstraction** | Can't add new runtimes | engine.ts |
| **No recovery logic** | Workflows orphaned on reset | engine.ts:constructor |
| **Monolithic engine** | Hard to maintain/test | engine.ts |
| **Direct storage coupling** | Tight runtime binding | everywhere |
| **No state machine** | Invalid transitions possible | transitions.ts |
| **Mixed orchestration** | Logic in jobs | workflow.ts |

---

## Part 2: New Architecture Design

### 2.1 Design Goals

1. **Runtime Agnostic**: Abstract away Durable Objects specifics
2. **Fully Effect-Based**: All state management through Effect services
3. **Recovery Built-In**: Infrastructure failure recovery as first-class concern
4. **Testable**: Easy to test without full runtime
5. **Maintainable**: Clear separation of concerns

### 2.2 New Layer Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              USER APPLICATION                                    │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌──────────────────────┐    ┌──────────────────────────────────────────────┐   │
│  │   WorkflowClient     │    │             User Workflow Code               │   │
│  │   (unchanged)        │    │             (unchanged)                      │   │
│  └──────────┬───────────┘    └───────────────────┬──────────────────────────┘   │
│             │                                    │                               │
├─────────────┼────────────────────────────────────┼───────────────────────────────┤
│             │         RUNTIME ADAPTER LAYER (NEW)│                               │
│             │                                    │                               │
│  ┌──────────▼──────────────────────────────────────────────────────────────┐    │
│  │                      RuntimeAdapter Interface                            │    │
│  │                                                                          │    │
│  │  interface RuntimeAdapter {                                              │    │
│  │    storage: StorageAdapter                                               │    │
│  │    scheduler: SchedulerAdapter                                           │    │
│  │    lifecycle: LifecycleHooks                                             │    │
│  │  }                                                                       │    │
│  └──────────────────────────────────────────────────────────────────────────┘    │
│                                      │                                          │
│         ┌────────────────────────────┼────────────────────────────────────┐     │
│         │                            │                                    │     │
│         ▼                            ▼                                    ▼     │
│  ┌──────────────────┐    ┌──────────────────────┐    ┌──────────────────────┐  │
│  │ DurableObject    │    │   Redis/Postgres     │    │    In-Memory         │  │
│  │ Adapter          │    │   Adapter (future)   │    │    Adapter (test)    │  │
│  │                  │    │                      │    │                      │  │
│  │ - CF DO Storage  │    │ - SQL/KV storage     │    │ - Map-based storage  │  │
│  │ - CF Alarms      │    │ - Queue scheduler    │    │ - Timer scheduler    │  │
│  │ - DO Lifecycle   │    │ - Process lifecycle  │    │ - Test lifecycle     │  │
│  └──────────────────┘    └──────────────────────┘    └──────────────────────┘  │
│                                                                                  │
├─────────────────────────────────────────────────────────────────────────────────┤
│                        ORCHESTRATION LAYER (NEW - Pure Effect)                   │
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │                         WorkflowOrchestrator                              │   │
│  │                                                                           │   │
│  │  Effect.Effect<void, OrchestratorError, OrchestratorDeps>                │   │
│  │                                                                           │   │
│  │  - start(workflowName, input, options)                                   │   │
│  │  - resume(workflowId)                                                     │   │
│  │  - recover(workflowId)     ← NEW: Infrastructure recovery                │   │
│  │  - cancel(workflowId, reason)                                            │   │
│  │  - handleAlarm()                                                          │   │
│  │  - handleLifecycleEvent(event)                                           │   │
│  └────────────────────────────────────────┬─────────────────────────────────┘   │
│                                           │                                     │
│                    ┌──────────────────────┼──────────────────────┐              │
│                    │                      │                      │              │
│                    ▼                      ▼                      ▼              │
│  ┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐  │
│  │  WorkflowStateMachine │  │   WorkflowExecutor   │  │   RecoveryManager    │  │
│  │  (NEW)               │  │   (refactored)       │  │   (NEW)              │  │
│  │                      │  │                      │  │                      │  │
│  │  - validateTransition│  │  - execute()         │  │  - detectStale()     │  │
│  │  - applyTransition() │  │  - handleResult()    │  │  - scheduleRecovery()│  │
│  │  - getCurrentState() │  │  - provideContext()  │  │  - executeRecovery() │  │
│  │  - getValidActions() │  │                      │  │  - trackAttempts()   │  │
│  └──────────┬───────────┘  └──────────┬───────────┘  └──────────┬───────────┘  │
│             │                         │                         │              │
│             └─────────────────────────┼─────────────────────────┘              │
│                                       │                                         │
├───────────────────────────────────────┼─────────────────────────────────────────┤
│                            PRIMITIVES │LAYER (mostly unchanged)                 │
│                                       │                                         │
│  ┌───────────────┐  ┌───────────────┐ │ ┌───────────────┐  ┌───────────────┐   │
│  │  Workflow.    │  │  Workflow.    │ │ │  Workflow.    │  │  Workflow.    │   │
│  │  step()       │  │  sleep()      │ │ │  retry()      │  │  timeout()    │   │
│  └───────┬───────┘  └───────┬───────┘ │ └───────┬───────┘  └───────┬───────┘   │
│          │                  │         │         │                  │            │
│          └──────────────────┴─────────┼─────────┴──────────────────┘            │
│                                       │                                         │
├───────────────────────────────────────┼─────────────────────────────────────────┤
│                       SERVICES LAYER  │(refactored to use adapters)             │
│                                       │                                         │
│  ┌──────────────────┐  ┌──────────────┴──────┐  ┌──────────────────┐           │
│  │ WorkflowContext  │  │   StepContext       │  │  WorkflowScope   │           │
│  │ (uses Storage    │  │   (uses Storage     │  │  (unchanged)     │           │
│  │  Adapter)        │  │    Adapter)         │  │                  │           │
│  └────────┬─────────┘  └────────┬────────────┘  └──────────────────┘           │
│           │                     │                                               │
│           └──────────┬──────────┘                                               │
│                      │                                                          │
│  ┌───────────────────▼──────────────────────────────────────────────────────┐   │
│  │                      StorageAdapter Interface (NEW)                       │   │
│  │                                                                           │   │
│  │  interface StorageAdapter {                                               │   │
│  │    get<T>(key: string): Effect.Effect<T | undefined, StorageError>       │   │
│  │    put<T>(key: string, value: T): Effect.Effect<void, StorageError>      │   │
│  │    delete(key: string): Effect.Effect<boolean, StorageError>             │   │
│  │    deleteAll(): Effect.Effect<void, StorageError>                         │   │
│  │    list(prefix: string): Effect.Effect<Map<string, unknown>, StorageError>│   │
│  │  }                                                                        │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │                     SchedulerAdapter Interface (NEW)                      │   │
│  │                                                                           │   │
│  │  interface SchedulerAdapter {                                             │   │
│  │    schedule(time: number): Effect.Effect<void, SchedulerError>           │   │
│  │    cancel(): Effect.Effect<void, SchedulerError>                          │   │
│  │    getScheduled(): Effect.Effect<number | undefined, SchedulerError>     │   │
│  │  }                                                                        │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
├─────────────────────────────────────────────────────────────────────────────────┤
│                            TRACKER LAYER (unchanged)                             │
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │  EventTracker / createHttpBatchTracker / emitEvent / flushEvents         │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 2.3 New Components Detail

#### 2.3.1 StorageAdapter (New Interface)

```typescript
// packages/workflow/src/adapters/storage.ts

import { Context, Effect } from "effect";
import { StorageError } from "@/errors";

/**
 * Abstract storage interface for workflow state persistence.
 * Implementations provide runtime-specific storage (DO, Redis, Postgres, etc.)
 */
export interface StorageAdapterService {
  /** Get a value by key */
  readonly get: <T>(key: string) => Effect.Effect<T | undefined, StorageError>;

  /** Put a value */
  readonly put: <T>(key: string, value: T) => Effect.Effect<void, StorageError>;

  /** Put multiple values atomically */
  readonly putBatch: (
    entries: Record<string, unknown>
  ) => Effect.Effect<void, StorageError>;

  /** Delete a key */
  readonly delete: (key: string) => Effect.Effect<boolean, StorageError>;

  /** Delete all keys */
  readonly deleteAll: () => Effect.Effect<void, StorageError>;

  /** List keys with prefix */
  readonly list: (
    prefix: string
  ) => Effect.Effect<Map<string, unknown>, StorageError>;
}

export class StorageAdapter extends Context.Tag("@durable-effect/StorageAdapter")<
  StorageAdapter,
  StorageAdapterService
>() {}
```

#### 2.3.2 SchedulerAdapter (New Interface)

```typescript
// packages/workflow/src/adapters/scheduler.ts

import { Context, Effect } from "effect";

export class SchedulerError extends Data.TaggedError("SchedulerError")<{
  readonly operation: "schedule" | "cancel" | "get";
  readonly cause: unknown;
}> {}

/**
 * Abstract scheduler interface for delayed execution.
 * Implementations provide runtime-specific scheduling (DO alarms, queues, etc.)
 */
export interface SchedulerAdapterService {
  /** Schedule execution at a specific time */
  readonly schedule: (time: number) => Effect.Effect<void, SchedulerError>;

  /** Cancel scheduled execution */
  readonly cancel: () => Effect.Effect<void, SchedulerError>;

  /** Get currently scheduled time (if any) */
  readonly getScheduled: () => Effect.Effect<number | undefined, SchedulerError>;
}

export class SchedulerAdapter extends Context.Tag("@durable-effect/SchedulerAdapter")<
  SchedulerAdapter,
  SchedulerAdapterService
>() {}
```

#### 2.3.3 RuntimeAdapter (New Interface)

```typescript
// packages/workflow/src/adapters/runtime.ts

import { Layer } from "effect";
import type { StorageAdapter } from "./storage";
import type { SchedulerAdapter } from "./scheduler";

/**
 * Lifecycle events from the runtime.
 */
export type LifecycleEvent =
  | { readonly _tag: "Initialized" }
  | { readonly _tag: "AlarmFired" }
  | { readonly _tag: "Shutdown" }
  | { readonly _tag: "Reset"; readonly reason?: string };

/**
 * Combined runtime adapter providing all runtime-specific services.
 */
export interface RuntimeAdapterService {
  /** Unique instance identifier */
  readonly instanceId: string;

  /** Subscribe to lifecycle events */
  readonly onLifecycle: (
    handler: (event: LifecycleEvent) => Effect.Effect<void>
  ) => Effect.Effect<void>;
}

export class RuntimeAdapter extends Context.Tag("@durable-effect/RuntimeAdapter")<
  RuntimeAdapter,
  RuntimeAdapterService
>() {}

/**
 * Create a complete runtime layer from an adapter.
 */
export type RuntimeLayer = Layer.Layer<
  StorageAdapter | SchedulerAdapter | RuntimeAdapter
>;
```

#### 2.3.4 WorkflowStateMachine (New Service)

```typescript
// packages/workflow/src/orchestration/state-machine.ts

import { Context, Effect } from "effect";
import type { WorkflowStatus, WorkflowTransition } from "@/types";

/**
 * Valid state transitions matrix.
 */
const VALID_TRANSITIONS: Record<WorkflowStatus["_tag"], WorkflowTransition["_tag"][]> = {
  Pending: ["Start", "Queue"],
  Queued: ["Start", "Cancel"],
  Running: ["Complete", "Pause", "Fail", "Cancel", "Recover"],
  Paused: ["Resume", "Cancel", "Recover"],
  Completed: [],  // Terminal
  Failed: [],     // Terminal
  Cancelled: [],  // Terminal
};

export interface WorkflowStateMachineService {
  /**
   * Get current workflow state.
   */
  readonly getState: () => Effect.Effect<WorkflowState, StorageError>;

  /**
   * Validate if a transition is allowed from current state.
   */
  readonly canTransition: (
    transition: WorkflowTransition
  ) => Effect.Effect<boolean, StorageError>;

  /**
   * Apply a transition (validates + updates storage + emits event).
   */
  readonly applyTransition: (
    transition: WorkflowTransition
  ) => Effect.Effect<void, InvalidTransitionError | StorageError>;

  /**
   * Check if workflow is in a recoverable state.
   */
  readonly isRecoverable: () => Effect.Effect<RecoverabilityInfo, StorageError>;
}

export interface WorkflowState {
  readonly status: WorkflowStatus;
  readonly runningAt?: number;
  readonly pendingResumeAt?: number;
  readonly recoveryAttempts: number;
  readonly completedSteps: ReadonlyArray<string>;
}

export interface RecoverabilityInfo {
  readonly canRecover: boolean;
  readonly reason: "stale_running" | "pending_resume" | "not_recoverable";
  readonly staleDuration?: number;
}

export class WorkflowStateMachine extends Context.Tag(
  "@durable-effect/WorkflowStateMachine"
)<WorkflowStateMachine, WorkflowStateMachineService>() {}
```

#### 2.3.5 RecoveryManager (New Service)

```typescript
// packages/workflow/src/orchestration/recovery.ts

import { Context, Effect } from "effect";

export interface RecoveryConfig {
  /** Time after which Running status is considered stale */
  readonly staleThresholdMs: number;
  /** Maximum recovery attempts before permanent failure */
  readonly maxRecoveryAttempts: number;
  /** Delay before scheduling recovery alarm */
  readonly recoveryDelayMs: number;
}

export const defaultRecoveryConfig: RecoveryConfig = {
  staleThresholdMs: 30_000,
  maxRecoveryAttempts: 3,
  recoveryDelayMs: 100,
};

export interface RecoveryManagerService {
  /**
   * Check for and schedule recovery of stale workflows.
   * Called on runtime initialization (constructor).
   */
  readonly checkAndScheduleRecovery: () => Effect.Effect<RecoveryResult>;

  /**
   * Execute recovery for a workflow.
   * Called when recovery alarm fires.
   */
  readonly executeRecovery: () => Effect.Effect<void, RecoveryError>;

  /**
   * Get recovery statistics.
   */
  readonly getStats: () => Effect.Effect<RecoveryStats>;
}

export interface RecoveryResult {
  readonly scheduled: boolean;
  readonly reason?: string;
  readonly staleDuration?: number;
}

export interface RecoveryStats {
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly lastAttemptAt?: number;
}

export class RecoveryManager extends Context.Tag(
  "@durable-effect/RecoveryManager"
)<RecoveryManager, RecoveryManagerService>() {}
```

#### 2.3.6 WorkflowOrchestrator (New Service)

```typescript
// packages/workflow/src/orchestration/orchestrator.ts

import { Context, Effect, Layer } from "effect";
import type { WorkflowRegistry, WorkflowCall } from "@/types";

/**
 * High-level orchestrator that coordinates all workflow operations.
 * This replaces the monolithic DurableWorkflowEngine class logic.
 */
export interface WorkflowOrchestratorService<W extends WorkflowRegistry> {
  /**
   * Start a new workflow (sync).
   */
  readonly start: (
    call: WorkflowCall<W>
  ) => Effect.Effect<{ id: string }, OrchestratorError>;

  /**
   * Queue a workflow for async execution.
   */
  readonly queue: (
    call: WorkflowCall<W>
  ) => Effect.Effect<{ id: string }, OrchestratorError>;

  /**
   * Handle alarm (resume, start queued, or recover).
   */
  readonly handleAlarm: () => Effect.Effect<void, OrchestratorError>;

  /**
   * Cancel a workflow.
   */
  readonly cancel: (
    reason?: string
  ) => Effect.Effect<CancelResult, OrchestratorError>;

  /**
   * Get current status.
   */
  readonly getStatus: () => Effect.Effect<WorkflowStatus | undefined>;

  /**
   * Handle lifecycle event from runtime.
   */
  readonly handleLifecycleEvent: (
    event: LifecycleEvent
  ) => Effect.Effect<void, OrchestratorError>;
}

export class WorkflowOrchestrator<W extends WorkflowRegistry> extends Context.Tag(
  "@durable-effect/WorkflowOrchestrator"
)<WorkflowOrchestrator<W>, WorkflowOrchestratorService<W>>() {}
```

### 2.4 Durable Object Adapter Implementation

```typescript
// packages/workflow/src/adapters/durable-object.ts

import { Layer, Effect } from "effect";
import { StorageAdapter, type StorageAdapterService } from "./storage";
import { SchedulerAdapter, type SchedulerAdapterService } from "./scheduler";
import { RuntimeAdapter, type RuntimeAdapterService, type LifecycleEvent } from "./runtime";

/**
 * Create a Durable Object storage adapter.
 */
export function createDOStorageAdapter(
  storage: DurableObjectStorage
): StorageAdapterService {
  return {
    get: <T>(key: string) =>
      Effect.tryPromise({
        try: () => storage.get<T>(key),
        catch: (e) => new StorageError({ operation: "get", key, cause: e, retriesAttempted: 0 }),
      }).pipe(
        Effect.retry(storageRetrySchedule),
        // ... retry logic
      ),

    put: <T>(key: string, value: T) =>
      Effect.tryPromise({
        try: () => storage.put(key, value),
        catch: (e) => new StorageError({ operation: "put", key, cause: e, retriesAttempted: 0 }),
      }).pipe(Effect.retry(storageRetrySchedule)),

    // ... other methods
  };
}

/**
 * Create a Durable Object scheduler adapter.
 */
export function createDOSchedulerAdapter(
  storage: DurableObjectStorage
): SchedulerAdapterService {
  return {
    schedule: (time: number) =>
      Effect.tryPromise({
        try: () => storage.setAlarm(time),
        catch: (e) => new SchedulerError({ operation: "schedule", cause: e }),
      }),

    cancel: () =>
      Effect.tryPromise({
        try: () => storage.deleteAlarm(),
        catch: (e) => new SchedulerError({ operation: "cancel", cause: e }),
      }),

    getScheduled: () =>
      Effect.tryPromise({
        try: () => storage.getAlarm(),
        catch: (e) => new SchedulerError({ operation: "get", cause: e }),
      }),
  };
}

/**
 * Create a complete Durable Object runtime layer.
 */
export function createDurableObjectRuntime(
  state: DurableObjectState
): RuntimeLayer {
  const storage = createDOStorageAdapter(state.storage);
  const scheduler = createDOSchedulerAdapter(state.storage);
  const instanceId = state.id.toString();

  return Layer.mergeAll(
    Layer.succeed(StorageAdapter, storage),
    Layer.succeed(SchedulerAdapter, scheduler),
    Layer.succeed(RuntimeAdapter, {
      instanceId,
      onLifecycle: () => Effect.void, // DO lifecycle handled externally
    }),
  );
}
```

### 2.5 New Engine Implementation

The new engine becomes a thin shell that wires adapters to the orchestrator:

```typescript
// packages/workflow/src/engine.ts (NEW - much simpler)

import { DurableObject } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import { createDurableObjectRuntime } from "@/adapters/durable-object";
import { createWorkflowOrchestrator } from "@/orchestration/orchestrator";
import { createRecoveryManager } from "@/orchestration/recovery";
import { createWorkflowStateMachine } from "@/orchestration/state-machine";
import type { WorkflowRegistry, WorkflowCall, CancelOptions, CancelResult, WorkflowStatus } from "@/types";

export function createDurableWorkflows<const T extends WorkflowRegistry>(
  workflows: T,
  options?: CreateDurableWorkflowsOptions,
): CreateDurableWorkflowsResult<T> {
  const trackerLayer = options?.tracker
    ? createTrackerLayer(options.tracker)
    : NoopTrackerLayer;

  class DurableWorkflowEngine extends DurableObject {
    readonly #runtimeLayer: RuntimeLayer;
    readonly #orchestratorLayer: Layer.Layer<WorkflowOrchestrator<T>>;

    constructor(state: DurableObjectState, env: unknown) {
      super(state, env as never);

      // Create runtime adapter layer
      this.#runtimeLayer = createDurableObjectRuntime(state);

      // Create orchestrator layer with all dependencies
      this.#orchestratorLayer = createWorkflowOrchestrator(workflows).pipe(
        Layer.provide(this.#runtimeLayer),
        Layer.provide(trackerLayer),
        Layer.provide(createWorkflowStateMachine()),
        Layer.provide(createRecoveryManager()),
      );

      // Run recovery check in constructor
      state.blockConcurrencyWhile(async () => {
        await Effect.runPromise(
          Effect.gen(function* () {
            const recovery = yield* RecoveryManager;
            yield* recovery.checkAndScheduleRecovery();
          }).pipe(Effect.provide(this.#orchestratorLayer))
        );
      });
    }

    async run(call: WorkflowCall<T>): Promise<{ id: string }> {
      return Effect.runPromise(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator<T>;
          return yield* orchestrator.start(call);
        }).pipe(Effect.provide(this.#orchestratorLayer))
      );
    }

    async runAsync(call: WorkflowCall<T>): Promise<{ id: string }> {
      return Effect.runPromise(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator<T>;
          return yield* orchestrator.queue(call);
        }).pipe(Effect.provide(this.#orchestratorLayer))
      );
    }

    async alarm(): Promise<void> {
      return Effect.runPromise(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator<T>;
          yield* orchestrator.handleAlarm();
        }).pipe(Effect.provide(this.#orchestratorLayer))
      );
    }

    async cancel(options?: CancelOptions): Promise<CancelResult> {
      return Effect.runPromise(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator<T>;
          return yield* orchestrator.cancel(options?.reason);
        }).pipe(Effect.provide(this.#orchestratorLayer))
      );
    }

    async getStatus(): Promise<WorkflowStatus | undefined> {
      return Effect.runPromise(
        Effect.gen(function* () {
          const orchestrator = yield* WorkflowOrchestrator<T>;
          return yield* orchestrator.getStatus();
        }).pipe(Effect.provide(this.#orchestratorLayer))
      );
    }

    // ... other query methods
  }

  return {
    Workflows: DurableWorkflowEngine,
    WorkflowClient: createWorkflowClientFactory<T>(),
  };
}
```

### 2.6 Migration Path

#### Phase 1: Introduce Adapters (Non-Breaking)
1. Create `StorageAdapter` interface
2. Create `SchedulerAdapter` interface
3. Create `DurableObjectAdapter` implementation
4. Add adapter layer to existing engine (internal refactor)

#### Phase 2: Extract State Machine (Non-Breaking)
1. Create `WorkflowStateMachine` service
2. Add transition validation
3. Migrate `transitions.ts` to use state machine
4. Add `Recover` transition type

#### Phase 3: Add Recovery Manager (Non-Breaking)
1. Create `RecoveryManager` service
2. Add constructor recovery logic
3. Add recovery handling in alarm
4. Add `workflow.recovery` event type

#### Phase 4: Create Orchestrator (Non-Breaking)
1. Create `WorkflowOrchestrator` service
2. Migrate engine methods to orchestrator
3. Engine becomes thin shell

#### Phase 5: Simplify Engine (Breaking)
1. Remove duplicated logic from engine
2. Engine only wires layers
3. Full adapter pattern

### 2.7 Testing Benefits

```typescript
// Test with in-memory adapter
const testRuntime = createInMemoryRuntime();

const testProgram = Effect.gen(function* () {
  const orchestrator = yield* WorkflowOrchestrator<TestWorkflows>;

  // Start workflow
  const { id } = yield* orchestrator.start({
    workflow: "testWorkflow",
    input: {},
  });

  // Verify state
  const state = yield* WorkflowStateMachine.pipe(
    Effect.flatMap(sm => sm.getState())
  );

  expect(state.status._tag).toBe("Running");

  // Simulate infrastructure failure
  yield* RuntimeAdapter.pipe(
    Effect.flatMap(r => r.simulateReset())
  );

  // Verify recovery triggered
  const recovery = yield* RecoveryManager.pipe(
    Effect.flatMap(r => r.getStats())
  );

  expect(recovery.attempts).toBe(1);
});

await Effect.runPromise(
  testProgram.pipe(Effect.provide(testRuntime))
);
```

---

## Part 3: Recovery Implementation with New Architecture

### 3.1 Recovery Flow in New Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                      Infrastructure Failure Recovery Flow                        │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  [Infrastructure Reset / Code Deploy]                                            │
│                    │                                                             │
│                    ▼                                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                    DurableWorkflowEngine.constructor()                   │    │
│  │                                                                          │    │
│  │  state.blockConcurrencyWhile(async () => {                              │    │
│  │    await Effect.runPromise(                                              │    │
│  │      RecoveryManager.checkAndScheduleRecovery()                         │    │
│  │    );                                                                    │    │
│  │  });                                                                     │    │
│  └─────────────────────────────────┬───────────────────────────────────────┘    │
│                                    │                                             │
│                                    ▼                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                    RecoveryManager.checkAndScheduleRecovery()            │    │
│  │                                                                          │    │
│  │  1. stateMachine.getState()                                              │    │
│  │  2. if status === "Running":                                             │    │
│  │       staleDuration = now - runningAt                                    │    │
│  │       if staleDuration > threshold:                                      │    │
│  │         scheduler.schedule(now + 100)  // Schedule recovery             │    │
│  │         return { scheduled: true, reason: "stale_running" }             │    │
│  └─────────────────────────────────┬───────────────────────────────────────┘    │
│                                    │                                             │
│                                    ▼                                             │
│                             [Alarm Fires]                                        │
│                                    │                                             │
│                                    ▼                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                    WorkflowOrchestrator.handleAlarm()                    │    │
│  │                                                                          │    │
│  │  state = yield* stateMachine.getState()                                  │    │
│  │                                                                          │    │
│  │  switch (state.status._tag) {                                            │    │
│  │    case "Running":                                                       │    │
│  │      // Infrastructure interrupted - need recovery                       │    │
│  │      yield* recoveryManager.executeRecovery()                           │    │
│  │      break;                                                              │    │
│  │                                                                          │    │
│  │    case "Queued":                                                        │    │
│  │      yield* stateMachine.applyTransition({ _tag: "Start", ... })        │    │
│  │      yield* executor.execute(...)                                        │    │
│  │      break;                                                              │    │
│  │                                                                          │    │
│  │    case "Paused":                                                        │    │
│  │      yield* stateMachine.applyTransition({ _tag: "Resume" })            │    │
│  │      yield* executor.execute(...)                                        │    │
│  │      break;                                                              │    │
│  │  }                                                                       │    │
│  └─────────────────────────────────┬───────────────────────────────────────┘    │
│                                    │                                             │
│                    (case "Running")│                                             │
│                                    ▼                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                    RecoveryManager.executeRecovery()                     │    │
│  │                                                                          │    │
│  │  1. Check recovery attempts < maxAttempts                                │    │
│  │     - If exceeded: stateMachine.applyTransition({ _tag: "Fail", ... })  │    │
│  │                                                                          │    │
│  │  2. Increment recovery attempts in storage                               │    │
│  │                                                                          │    │
│  │  3. Emit workflow.recovery event                                         │    │
│  │                                                                          │    │
│  │  4. Check pendingResumeAt:                                               │    │
│  │     - If exists: stateMachine.applyTransition({ _tag: "Recover" })      │    │
│  │                  executor.execute() with Resume mode                     │    │
│  │     - If not: stateMachine.applyTransition({ _tag: "Recover" })         │    │
│  │               executor.execute() with Replay mode                        │    │
│  │                                                                          │    │
│  │  5. Clear recovery attempts on success                                   │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 New Transition: Recover

```typescript
export type WorkflowTransition =
  | { readonly _tag: "Start"; readonly input: unknown }
  | { readonly _tag: "Queue"; readonly input: unknown }
  | { readonly _tag: "Resume" }
  | {
      readonly _tag: "Recover";  // NEW
      readonly reason: "infrastructure_restart" | "stale_detection" | "manual";
      readonly attempt: number;
    }
  | { readonly _tag: "Complete"; ... }
  | { readonly _tag: "Pause"; ... }
  | { readonly _tag: "Fail"; ... }
  | { readonly _tag: "Cancel"; ... }
```

### 3.3 Valid Transitions with Recovery

```typescript
const VALID_TRANSITIONS = {
  Pending:   ["Start", "Queue"],
  Queued:    ["Start", "Cancel"],
  Running:   ["Complete", "Pause", "Fail", "Cancel", "Recover"],  // Added Recover
  Paused:    ["Resume", "Cancel", "Recover"],                      // Added Recover
  Completed: [],
  Failed:    [],
  Cancelled: [],
};
```

---

## Appendix A: File-by-File Analysis

### packages/workflow/src/engine.ts

| Section | Lines | Responsibility |
|---------|-------|----------------|
| Imports | 1-44 | Dependencies |
| Types | 46-150 | Options, results, interfaces |
| createDurableWorkflows | 152-580 | Factory function |
| DurableWorkflowEngine class | 216-574 | DO class definition |
| run() | 235-280 | Sync execution |
| runAsync() | 286-328 | Async queueing |
| alarm() | 333-414 | Resume/start handler |
| #executeWorkflow() | 420-470 | Core execution |
| Query methods | 472-486 | Status, steps, meta |
| cancel() | 495-573 | Cancellation |
| handleWorkflowResult() | 598-731 | Exit → transition |
| extractStepContext() | 737-748 | Error helper |

**Verdict**: This file is doing too much. Should be split into orchestrator, executor, and thin DO shell.

### packages/workflow/src/workflow.ts

| Section | Lines | Responsibility |
|---------|-------|----------------|
| Imports | 1-32 | Dependencies |
| StepState interface | 34-51 | Internal tracking |
| Helper functions | 53-72 | Control flow checks |
| Workflow.make() | 77-101 | Definition factory |
| Workflow.step() | 103-443 | Durable step execution |
| Workflow.retry() | 467-627 | Durable retry |
| Workflow.timeout() | 629-730 | Durable timeout |
| Workflow.sleep() | 732-807 | Durable sleep |
| Context exports | 809-833 | Service access |

**Verdict**: Well-structured but `step()` is complex. Could benefit from extracting state tracking.

### packages/workflow/src/transitions.ts

| Section | Lines | Responsibility |
|---------|-------|----------------|
| Types | 14-51 | WorkflowTransition union |
| transitionWorkflow() | 53-168 | Status + event emission |

**Verdict**: Good but lacks transition validation. Should be wrapped by state machine.

### packages/workflow/src/services/

| File | Lines | Purpose |
|------|-------|---------|
| workflow-context.ts | 254 | Workflow-level state |
| step-context.ts | 196 | Step-level state |
| workflow-scope.ts | 30 | Nesting guard |
| step-clock.ts | 46 | Reject Effect.sleep |
| storage-utils.ts | 134 | Retryable storage |

**Verdict**: Well-structured services but directly coupled to DurableObjectStorage.

---

## Appendix B: Storage Schema Reference

```typescript
// Workflow-level keys
interface WorkflowStorage {
  "workflow:status": WorkflowStatus;
  "workflow:name": string;
  "workflow:input": unknown;
  "workflow:executionId": string | undefined;
  "workflow:completedSteps": string[];
  "workflow:completedPauseIndex": number;
  "workflow:pendingResumeAt": number | undefined;
  "workflow:cancelled": boolean;
  "workflow:cancelReason": string | undefined;
  "workflow:runningAt": number;           // NEW for recovery
  "workflow:recoveryAttempts": number;    // NEW for recovery
  "workflow:maxRecoveryAttempts": number; // NEW for recovery
  [key: `workflow:meta:${string}`]: unknown;
}

// Step-level keys
interface StepStorage {
  [key: `step:${string}:attempt`]: number;
  [key: `step:${string}:startedAt`]: number;
  [key: `step:${string}:result`]: unknown;
  [key: `step:${string}:meta:${string}`]: unknown;
}
```

---

## Conclusion

The current architecture, while functional, has grown organically into a monolith that makes it difficult to:

1. Add new runtimes (everything coupled to Durable Objects)
2. Implement recovery logic (no clear ownership)
3. Test in isolation (requires full DO environment)
4. Maintain (749-line engine.ts file)

The proposed new architecture:

1. **Introduces adapter interfaces** (`StorageAdapter`, `SchedulerAdapter`, `RuntimeAdapter`)
2. **Creates an orchestration layer** (`WorkflowOrchestrator`, `WorkflowStateMachine`, `RecoveryManager`)
3. **Makes the engine a thin shell** (just wires layers together)
4. **Enables infrastructure failure recovery** (built into the architecture)
5. **Supports multiple runtimes** (DO, Redis, Postgres, in-memory for testing)

The migration can be done incrementally with each phase being non-breaking until the final simplification.
