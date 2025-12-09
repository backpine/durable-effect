# Architecture: @durable-effect/workflow

This document provides a comprehensive overview of how the workflow package is designed, how its components work together, and the data flow through the system. It's intended for developers who want to understand the internals or contribute to the project.

---

## Table of Contents

- [Overview](#overview)
- [Directory Structure](#directory-structure)
- [Core Concepts](#core-concepts)
- [Effect Services & Layers](#effect-services--layers)
- [Layer Composition](#layer-composition)
- [Data Types](#data-types)
- [Execution Flow](#execution-flow)
- [State Machine](#state-machine)
- [Context Hierarchy](#context-hierarchy)
- [Entry Points](#entry-points)

---

## Overview

The workflow package enables durable execution of Effect-based workflows on Cloudflare Durable Objects. The key insight is that workflows can be interrupted at any point (server restarts, deployments, failures) and need to resume exactly where they left off.

**Core design principles:**

1. **Effect-native**: Built entirely on Effect's service pattern with composable layers
2. **Deterministic replay**: Completed steps are cached and replayed on resume
3. **Explicit durability points**: Only `Workflow.step()` and `Workflow.sleep()` create durability boundaries
4. **Type-safe**: Full type inference from workflow registry to client calls
5. **Testable**: In-memory adapters allow testing without Durable Objects

**How durability works:**

```
Workflow starts → Executes steps → Each step result is persisted
                                          ↓
Server crashes → Workflow resumes → Cached results are replayed
                                          ↓
                  Execution continues from last incomplete step
```

---

## Directory Structure

```
src/
├── adapters/           # Infrastructure abstraction (storage, scheduler, runtime)
│   ├── storage.ts      # Key-value persistence interface
│   ├── scheduler.ts    # Alarm scheduling interface
│   ├── runtime.ts      # Runtime identity (instance ID, time)
│   ├── durable-object/ # Cloudflare DO implementations
│   └── in-memory/      # Test implementations
│
├── client/             # External API for invoking workflows
│   ├── types.ts        # Client interface
│   └── instance.ts     # Client implementation
│
├── context/            # Effect contexts for workflow/step state
│   ├── workflow-context.ts  # Workflow-level state
│   ├── step-context.ts      # Step-level state
│   ├── workflow-scope.ts    # Prevents workflow nesting
│   ├── step-scope.ts        # Prevents primitives inside steps
│   └── workflow-level.ts    # Compile-time guard for primitives
│
├── engine/             # Main entry point
│   ├── engine.ts       # createDurableWorkflows() factory
│   └── types.ts        # Configuration types
│
├── executor/           # Workflow execution engine
│   ├── executor.ts     # Runs workflow definitions
│   └── types.ts        # ExecutionResult, ExecutionMode
│
├── orchestrator/       # Workflow lifecycle coordination
│   ├── orchestrator.ts # Start, resume, cancel operations
│   ├── registry.ts     # Workflow lookup by name
│   └── types.ts        # WorkflowCall, results
│
├── primitives/         # User-facing APIs
│   ├── make.ts         # Workflow.make() - define workflows
│   ├── step.ts         # Workflow.step() - durable steps
│   ├── sleep.ts        # Workflow.sleep() - durable delays
│   ├── retry.ts        # Workflow.retry() - retry operator
│   ├── timeout.ts      # Workflow.timeout() - timeout operator
│   ├── backoff.ts      # Backoff strategies
│   └── pause-signal.ts # Internal pause control flow
│
├── state/              # Workflow state management
│   ├── machine.ts      # State machine service
│   ├── transitions.ts  # Valid state transitions
│   └── types.ts        # WorkflowStatus, WorkflowState
│
├── recovery/           # Infrastructure failure handling
│   ├── manager.ts      # Recovery detection and execution
│   └── config.ts       # Recovery configuration
│
├── purge/              # Data lifecycle management
│   ├── manager.ts      # Purge scheduling and execution
│   └── config.ts       # Purge configuration
│
├── tracker/            # Event tracking/observability
│   ├── tracker.ts      # EventTracker service
│   ├── http-batch.ts   # HTTP batch implementation
│   ├── noop.ts         # No-op implementation
│   └── in-memory.ts    # Test implementation
│
├── errors.ts           # Domain error types
└── index.ts            # Public API exports
```

---

## Core Concepts

### Adapters

Adapters abstract the underlying infrastructure. This allows the same workflow code to run on Durable Objects in production and in-memory for tests.

| Adapter | Purpose | DO Implementation | Test Implementation |
|---------|---------|-------------------|---------------------|
| `StorageAdapter` | Key-value persistence | DO storage API | In-memory Map |
| `SchedulerAdapter` | Alarm scheduling | DO alarm API | Simulated timer |
| `RuntimeAdapter` | Instance identity, time | DO state.id | Configurable |

### State Machine

Every workflow instance has a state machine that tracks its lifecycle:

```
┌─────────┐     ┌────────┐     ┌─────────┐
│ Pending │────▶│ Queued │────▶│ Running │
└─────────┘     └────────┘     └────┬────┘
     │                              │
     │         ┌────────────────────┼────────────────────┐
     │         │                    │                    │
     │         ▼                    ▼                    ▼
     │    ┌─────────┐         ┌──────────┐         ┌───────────┐
     └───▶│ Running │◀───────▶│  Paused  │         │ Cancelled │
          └────┬────┘         └──────────┘         └───────────┘
               │
       ┌───────┴───────┐
       ▼               ▼
┌───────────┐    ┌──────────┐
│ Completed │    │  Failed  │
└───────────┘    └──────────┘
```

### Execution Modes

When a workflow runs, it operates in one of three modes:

| Mode | When Used | Behavior |
|------|-----------|----------|
| `fresh` | First execution | No cached data, execute everything |
| `resume` | After pause (sleep/retry) | Replay cached steps, continue from pause |
| `recover` | After infrastructure failure | Like resume, but triggered by recovery system |

### Pause Signal

When a workflow needs to pause (sleep or retry delay), it doesn't actually stop the Effect. Instead, it throws a `PauseSignal` that bubbles up to the executor:

```typescript
// Inside Workflow.sleep():
yield* Effect.fail(new PauseSignal({
  reason: "sleep",
  resumeAt: Date.now() + durationMs,
}))
```

The executor catches this signal and:
1. Records the pause in state
2. Schedules an alarm for `resumeAt`
3. Returns `{ _tag: "Paused", ... }`

---

## Effect Services & Layers

The package uses Effect's service pattern extensively. Here are the key services:

### Infrastructure Services

```typescript
// Storage persistence
class StorageAdapter extends Context.Tag("StorageAdapter")<
  StorageAdapter,
  {
    get<T>(key: string): Effect<T | undefined, StorageError>
    put<T>(key: string, value: T): Effect<void, StorageError>
    delete(key: string): Effect<void, StorageError>
    deleteAll(): Effect<void, StorageError>
    // ...
  }
>() {}

// Alarm scheduling
class SchedulerAdapter extends Context.Tag("SchedulerAdapter")<
  SchedulerAdapter,
  {
    schedule(time: number): Effect<void, SchedulerError>
    cancel(): Effect<void, SchedulerError>
    getScheduled(): Effect<number | undefined, SchedulerError>
  }
>() {}

// Runtime identity
class RuntimeAdapter extends Context.Tag("RuntimeAdapter")<
  RuntimeAdapter,
  {
    readonly instanceId: string
    now(): Effect<number>
  }
>() {}
```

### State Management Services

```typescript
// Central state authority
class WorkflowStateMachine extends Context.Tag("WorkflowStateMachine")<
  WorkflowStateMachine,
  {
    initialize(name: string, input: unknown, executionId?: string): Effect<void>
    getState(): Effect<WorkflowState | undefined>
    getStatus(): Effect<WorkflowStatus | undefined>
    applyTransition(transition: WorkflowTransition): Effect<void>
    getCompletedSteps(): Effect<ReadonlyArray<string>>
    // ...
  }
>() {}
```

### Execution Services

```typescript
// Runs workflow definitions
class WorkflowExecutor extends Context.Tag("WorkflowExecutor")<
  WorkflowExecutor,
  {
    execute<I, O, E, R>(
      definition: WorkflowDefinition<I, O, E, R>,
      context: ExecutionContext
    ): Effect<ExecutionResult<O>, never, R>
  }
>() {}

// Coordinates workflow lifecycle
class WorkflowOrchestrator extends Context.Tag("WorkflowOrchestrator")<
  WorkflowOrchestrator,
  {
    start(call: WorkflowCall): Effect<StartResult>
    queue(call: WorkflowCall): Effect<StartResult>
    handleAlarm(): Effect<void>
    cancel(options?: CancelOptions): Effect<CancelResult>
    getStatus(): Effect<WorkflowStatusResult>
  }
>() {}
```

### Context Services

```typescript
// Workflow-level state access
class WorkflowContext extends Context.Tag("WorkflowContext")<
  WorkflowContext,
  {
    readonly workflowId: string
    readonly workflowName: string
    readonly input: unknown
    hasCompletedStep(name: string): Effect<boolean>
    markStepCompleted(name: string): Effect<void>
    // ...
  }
>() {}

// Step-level state access
class StepContext extends Context.Tag("StepContext")<
  StepContext,
  {
    readonly stepName: string
    readonly attempt: number
    incrementAttempt(): Effect<void>
    hasResult(): Effect<boolean>
    getResult<T>(): Effect<CachedStepResult<T> | undefined>
    setResult<T>(value: T, meta: StepResultMeta): Effect<void>
  }
>() {}
```

### Scope Guards

These services enforce correct usage of workflow primitives:

```typescript
// Prevents workflow nesting
class WorkflowScope extends Context.Tag("WorkflowScope")<
  WorkflowScope,
  { readonly _tag: "WorkflowScope" }
>() {}

// Prevents Workflow.sleep/step inside Workflow.step
class StepScope extends Context.Tag("StepScope")<
  StepScope,
  { readonly inStep: boolean }
>() {}

// Compile-time guard - only provided at workflow level
class WorkflowLevel extends Context.Tag("WorkflowLevel")<
  WorkflowLevel,
  { readonly _tag: "WorkflowLevel" }
>() {}
```

---

## Layer Composition

Layers are composed bottom-up, with each layer depending on those below:

```
┌─────────────────────────────────────────────────────────────┐
│                  WorkflowOrchestratorLayer                  │
│  Coordinates lifecycle, emits events, handles alarms        │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌───────────────┐    ┌────────────────┐    ┌───────────────┐
│WorkflowExecutor│    │  TrackerLayer  │    │RegistryLayer │
│    Layer      │    │ (HTTP/Noop)    │    │               │
└───────────────┘    └────────────────┘    └───────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│              WorkflowStateMachineLayer                      │
│  State transitions, step tracking, recovery state           │
└─────────────────────────────────────────────────────────────┘
        │
        ├─────────────────────┬─────────────────────┐
        ▼                     ▼                     ▼
┌───────────────┐    ┌────────────────┐    ┌───────────────┐
│RecoveryManager│    │  PurgeManager  │    │               │
│    Layer      │    │     Layer      │    │               │
└───────────────┘    └────────────────┘    │               │
        │                     │             │               │
        └─────────────────────┴─────────────┘               │
                              │                             │
                              ▼                             │
┌─────────────────────────────────────────────────────────────┐
│                      RuntimeLayer                           │
│  StorageAdapter + SchedulerAdapter + RuntimeAdapter         │
│  (Durable Objects or In-Memory)                             │
└─────────────────────────────────────────────────────────────┘
```

### Engine Factory Assembly

The `createDurableWorkflows()` factory assembles all layers:

```typescript
// Simplified view of layer assembly in engine.ts
const orchestratorLayer = WorkflowOrchestratorLayer<W>().pipe(
  Layer.provideMerge(WorkflowRegistryLayer(workflows)),
  Layer.provideMerge(WorkflowExecutorLayer),
  Layer.provideMerge(RecoveryManagerLayer(options?.recovery)),
  Layer.provideMerge(WorkflowStateMachineLayer),
  Layer.provideMerge(purgeLayer),      // PurgeManagerLayer or DisabledPurgeManagerLayer
  Layer.provideMerge(trackerLayer),    // HttpBatchTrackerLayer or NoopTrackerLayer
  Layer.provideMerge(runtimeLayer),    // createDurableObjectRuntime(state)
);
```

### Execution-Time Layers

When executing a workflow, additional layers are provided:

```typescript
// In executor.ts
const executionLayer = Layer.mergeAll(
  WorkflowScopeLayer,           // Prevents workflow nesting
  WorkflowContextLayer(ctx),    // Workflow state access
  WorkflowLevelLayer,           // Compile-time primitive guard
);

// The workflow effect runs with these layers
definition.execute(input).pipe(Effect.provide(executionLayer));
```

---

## Data Types

### Workflow Status

The discriminated union representing workflow state:

```typescript
type WorkflowStatus =
  | { _tag: "Pending" }
  | { _tag: "Queued"; queuedAt: number }
  | { _tag: "Running"; runningAt: number }
  | { _tag: "Paused"; reason: "sleep" | "retry"; resumeAt: number; stepName?: string }
  | { _tag: "Completed"; completedAt: number }
  | { _tag: "Failed"; failedAt: number; error: WorkflowError }
  | { _tag: "Cancelled"; cancelledAt: number; reason?: string }
```

### Workflow Transitions

Actions that change workflow state:

```typescript
type WorkflowTransition =
  | { _tag: "Start"; input: unknown }
  | { _tag: "Queue"; input: unknown }
  | { _tag: "Resume" }
  | { _tag: "Recover"; reason: string; attempt: number }
  | { _tag: "Complete"; completedSteps: string[]; durationMs: number }
  | { _tag: "Pause"; reason: "sleep" | "retry"; resumeAt: number; stepName?: string }
  | { _tag: "Fail"; error: WorkflowError; completedSteps: string[] }
  | { _tag: "Cancel"; reason?: string; completedSteps: string[] }
```

### Execution Result

What the executor returns:

```typescript
type ExecutionResult<Output> =
  | { _tag: "Completed"; output: Output; durationMs: number; completedSteps: string[] }
  | { _tag: "Paused"; reason: "sleep" | "retry"; resumeAt: number; stepName?: string }
  | { _tag: "Failed"; error: unknown; durationMs: number; completedSteps: string[] }
  | { _tag: "Cancelled"; reason?: string; completedSteps: string[] }
```

### Workflow Definition

What `Workflow.make()` returns:

```typescript
interface WorkflowDefinition<Input, Output, Error, Requirements> {
  _tag: "WorkflowDefinition"
  execute: (input: Input) => Effect<Output, Error | PauseSignal, Requirements>
}
```

### Cached Step Result

How step results are stored:

```typescript
interface CachedStepResult<T> {
  value: T
  meta: {
    completedAt: number
    attempt: number
    durationMs: number
  }
}
```

---

## Execution Flow

### Fresh Start

```
Client.run({ workflow: "processOrder", input: { orderId: "123" } })
    │
    ▼
WorkflowOrchestrator.start()
    │
    ├─► Registry.get("processOrder")           // Validate workflow exists
    ├─► StateMachine.initialize()              // Create initial state
    ├─► StateMachine.applyTransition("Start")  // Status: Running
    ├─► EventTracker.emit("workflow.started")
    │
    ▼
WorkflowExecutor.execute(definition, { mode: "fresh" })
    │
    ├─► Provide WorkflowScope, WorkflowContext, WorkflowLevel
    ├─► Run workflow effect
    │       │
    │       ├─► Workflow.step("fetch", ...)
    │       │       ├─► Check cache → miss
    │       │       ├─► Execute effect
    │       │       ├─► Store result
    │       │       └─► Return result
    │       │
    │       ├─► Workflow.sleep("1 hour")
    │       │       └─► throw PauseSignal({ resumeAt: now + 1hr })
    │       │
    │       └─► (execution stops here)
    │
    ▼
ExecutionResult: { _tag: "Paused", reason: "sleep", resumeAt: ... }
    │
    ▼
WorkflowOrchestrator
    ├─► StateMachine.applyTransition("Pause")
    ├─► Scheduler.schedule(resumeAt)           // Set alarm
    ├─► EventTracker.emit("workflow.paused")
    └─► Return { id, completed: false }
```

### Resume After Sleep

```
Durable Object Alarm fires
    │
    ▼
engine.alarm()
    │
    ├─► PurgeManager.executePurgeIfDue()       // Check if purge alarm
    │       └─► { purged: false }              // Not a purge
    │
    ▼
WorkflowOrchestrator.handleAlarm()
    │
    ├─► StateMachine.getStatus()               // Status: Paused
    ├─► StateMachine.applyTransition("Resume") // Status: Running
    ├─► EventTracker.emit("workflow.resumed")
    │
    ▼
WorkflowExecutor.execute(definition, { mode: "resume" })
    │
    ├─► Run workflow effect
    │       │
    │       ├─► Workflow.step("fetch", ...)
    │       │       ├─► Check cache → HIT
    │       │       └─► Return cached result (skip execution)
    │       │
    │       ├─► Workflow.sleep("1 hour")
    │       │       ├─► Check pauseIndex → already completed
    │       │       └─► Continue (don't pause again)
    │       │
    │       ├─► Workflow.step("process", ...)
    │       │       ├─► Check cache → miss
    │       │       ├─► Execute effect
    │       │       ├─► Store result
    │       │       └─► Return result
    │       │
    │       └─► Return finalResult
    │
    ▼
ExecutionResult: { _tag: "Completed", output: ..., completedSteps: [...] }
    │
    ▼
WorkflowOrchestrator
    ├─► StateMachine.applyTransition("Complete")
    ├─► EventTracker.emit("workflow.completed")
    ├─► Scheduler.cancel()                     // Clear any alarms
    └─► PurgeManager.schedulePurge("completed") // Schedule data cleanup
```

### Recovery After Failure

```
Durable Object restarts (process crash, deployment, etc.)
    │
    ▼
DurableWorkflowEngine constructor
    │
    └─► state.blockConcurrencyWhile(...)
            │
            ▼
        RecoveryManager.checkAndScheduleRecovery()
            │
            ├─► StateMachine.getStatus()       // Status: Running
            ├─► Check lastUpdated timestamp
            │       └─► now - lastUpdated > staleThresholdMs (30s)
            ├─► StateMachine.incrementRecoveryAttempts()
            ├─► Scheduler.schedule(now + recoveryDelayMs)
            └─► Return { scheduled: true, reason: "stale_running" }
                    │
                    ▼
                Alarm fires (after short delay)
                    │
                    ▼
        WorkflowOrchestrator.handleAlarm()
            │
            ├─► Detects stale "Running" status
            ├─► RecoveryManager.executeRecovery()
            │       ├─► Validate recovery attempts < max
            │       └─► Return { success: true }
            │
            ▼
        WorkflowExecutor.execute(definition, { mode: "recover" })
            │
            └─► Same as resume: replay cached steps, continue
```

---

## State Machine

### Valid Transitions

```typescript
const VALID_TRANSITIONS = {
  Pending:   ["Start", "Queue"],
  Queued:    ["Start", "Cancel"],
  Running:   ["Complete", "Pause", "Fail", "Cancel", "Recover"],
  Paused:    ["Resume", "Cancel", "Recover"],
  Completed: [],  // Terminal
  Failed:    [],  // Terminal
  Cancelled: [],  // Terminal
} as const;
```

### Transition Validation

Before applying a transition, the state machine validates:

1. Current status allows the transition
2. Required fields are present
3. No invalid state combinations

```typescript
// In state/machine.ts
applyTransition(transition) {
  const currentStatus = yield* this.getStatus();
  const validTransitions = VALID_TRANSITIONS[currentStatus._tag];

  if (!validTransitions.includes(transition._tag)) {
    yield* Effect.fail(new InvalidTransitionError({
      from: currentStatus._tag,
      to: transition._tag,
    }));
  }

  // Apply the transition...
}
```

---

## Context Hierarchy

### What's Available Where

| Context | At Workflow Level | Inside step() | Purpose |
|---------|-------------------|---------------|---------|
| `WorkflowScope` | ✓ | ✓ | Prevents workflow nesting |
| `WorkflowContext` | ✓ | ✓ | Workflow state access |
| `WorkflowLevel` | ✓ | ✗ | Compile-time primitive guard |
| `StepContext` | ✗ | ✓ | Step state access |
| `StepScope` | ✗ | ✓ | Prevents primitives in steps |
| `StorageAdapter` | ✓ | ✓ | Persistence |
| `RuntimeAdapter` | ✓ | ✓ | Time, instance ID |

### Why WorkflowLevel Matters

`WorkflowLevel` is only provided at the workflow level, not inside steps. This prevents:

```typescript
// This would be a compile error - WorkflowLevel not available
yield* Workflow.step("outer",
  Effect.gen(function* () {
    yield* Workflow.sleep("1 hour")  // Error: requires WorkflowLevel
  })
)
```

The correct pattern is:

```typescript
yield* Workflow.step("fetch", fetchData())
yield* Workflow.sleep("1 hour")  // At workflow level, WorkflowLevel is available
yield* Workflow.step("process", processData())
```

### StepScope Runtime Guard

Even with compile-time guards, `StepScope` provides runtime protection:

```typescript
// Inside Workflow.sleep()
const stepScope = yield* StepScope;
if (stepScope.inStep) {
  yield* Effect.fail(new StepScopeError({
    operation: "sleep",
    message: "Workflow.sleep cannot be used inside Workflow.step",
  }));
}
```

---

## Entry Points

### For Users

**Define workflows:**
```typescript
import { Workflow } from "@durable-effect/workflow";

const myWorkflow = Workflow.make((input: MyInput) =>
  Effect.gen(function* () {
    const data = yield* Workflow.step("fetch", fetchData(input));
    yield* Workflow.sleep("5 minutes");
    return yield* Workflow.step("process", processData(data));
  })
);
```

**Create engine:**
```typescript
import { createDurableWorkflows } from "@durable-effect/workflow";

export const { Workflows, WorkflowClient } = createDurableWorkflows({
  myWorkflow,
  anotherWorkflow,
}, {
  tracker: { endpoint: "...", env: "production", serviceKey: "my-app" },
  recovery: { maxRecoveryAttempts: 5 },
  purge: { delay: "5 minutes" },
});
```

**Use client:**
```typescript
const client = WorkflowClient.fromBinding(env.WORKFLOWS);

const { id } = yield* client.runAsync({
  workflow: "myWorkflow",
  input: { /* ... */ },
  execution: { id: "custom-id" },
});

const status = yield* client.status(id);
```

### For Testing

```typescript
import { createInMemoryRuntime } from "@durable-effect/workflow";

const { layer, handle } = await Effect.runPromise(
  createInMemoryRuntime({ initialTime: 1000 })
);

// Use handle to control time, inspect storage, trigger alarms
await Effect.runPromise(handle.advanceTime(60_000));
const storageState = await Effect.runPromise(handle.getStorageState());
```

---

## Summary

The workflow package achieves durable execution through:

1. **Cached step results**: Each `Workflow.step()` persists its result, enabling replay
2. **Pause signals**: `Workflow.sleep()` and retry delays throw signals caught by the executor
3. **Alarm-based resumption**: The Durable Object alarm triggers continuation
4. **State machine**: Tracks workflow lifecycle with validated transitions
5. **Recovery system**: Detects stale "Running" workflows and re-executes them
6. **Layer composition**: Effect services are composed bottom-up for clean dependency injection

The design separates concerns cleanly:
- **Adapters**: Infrastructure abstraction
- **State machine**: Lifecycle management
- **Executor**: Running workflow code
- **Orchestrator**: Coordinating everything
- **Primitives**: User-facing APIs
