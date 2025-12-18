# Report 058: Jobs Package Tracking Integration Design

## Overview

This report outlines a high-level design for integrating event tracking into `packages/jobs/`, modeled after the existing tracking architecture in `packages/workflow/`.

## Goals

1. **Observability**: Capture job lifecycle events for monitoring, debugging, and analytics
2. **Consistency**: Use the same tracking patterns as `packages/workflow/`
3. **Non-invasive**: Tracking should be optional and not affect job execution
4. **Reusable**: Share tracker implementations between workflow and jobs packages

## Current State

### Workflow Tracking Architecture

The workflow package has a mature tracking system:

```
┌─────────────────────────────────────────────────────────────┐
│                    EventTrackerService                       │
│  ├─ emit(event): Effect<void>                               │
│  ├─ flush(): Effect<void>                                   │
│  └─ pending(): Effect<number>                               │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
        NoopTracker    InMemoryTracker   HttpBatchTracker
        (default)        (testing)        (production)
```

**Key Patterns**:
- `EventTracker` Context.Tag for dependency injection
- `emitEvent()` helper that safely does nothing if tracker unavailable
- `NoopTrackerLayer` as default (zero overhead when tracking disabled)
- Events defined in `@durable-effect/core` for shared types

### Jobs Package Architecture

The jobs package has clear service boundaries ideal for tracking integration:

```
┌─────────────────────────────────────────────────────────────┐
│                      JobsRuntime                             │
└────────────────────────┬────────────────────────────────────┘
                         │
                    Dispatcher
                         │
        ┌────────────────┼────────────────┬──────────────┐
        │                │                │              │
   Continuous         Debounce           Task       WorkerPool
   Handler           Handler            Handler      Handler
        │                │                │              │
        └────────────────┴────────────────┴──────────────┘
                         │
              JobExecutionService  ←── Central orchestrator
                         │
              ┌──────────┼──────────┐
              │          │          │
         RetryExecutor  Cleanup   EntityState
                         Service    Service
```

## Proposed Architecture

### 1. Shared Tracker Infrastructure

The `EventTrackerService` interface and implementations already exist in `packages/workflow/`. We have two options:

**Option A: Move to Core Package** (Recommended)
```
packages/core/src/tracker/
├─ tracker.ts          # EventTrackerService interface + EventTracker tag
├─ noop.ts             # NoopTrackerLayer
├─ in-memory.ts        # InMemoryTrackerLayer (testing)
└─ http-batch.ts       # HttpBatchTrackerLayer (production)
```

**Option B: Import from Workflow**
- Jobs depends on workflow package for tracker
- Creates coupling, but avoids duplication

### 2. Job Event Types

Define job-specific events in `packages/core/src/events.ts`:

```typescript
// =============================================================================
// Job Event Types
// =============================================================================

export type JobEventType =
  // Lifecycle
  | "job.created"
  | "job.started"
  | "job.completed"
  | "job.failed"
  | "job.terminated"

  // Execution
  | "execution.started"
  | "execution.succeeded"
  | "execution.failed"

  // Retry
  | "retry.scheduled"
  | "retry.attempted"
  | "retry.exhausted"

  // Alarm
  | "alarm.scheduled"
  | "alarm.fired"
  | "alarm.cancelled"

  // Task-specific
  | "task.event.received"
  | "task.event.processed"
  | "task.idle"

  // Debounce-specific
  | "debounce.event.added"
  | "debounce.flush.triggered"
  | "debounce.cleared";
```

### 3. Event Base Structure

```typescript
interface JobEventBase {
  eventId: string;           // UUIDv7 for deduplication
  timestamp: string;         // ISO 8601
  instanceId: string;        // Durable Object ID
  jobType: "continuous" | "debounce" | "task" | "workerPool";
  jobName: string;           // Job definition name
  type: JobEventType;        // Event discriminator
}
```

### 4. Integration Points

The following table shows where to emit events in the jobs package:

| Event | Location | Service/Handler |
|-------|----------|-----------------|
| `job.created` | `MetadataService.initialize()` | MetadataService |
| `job.started` | Handler start action | ContinuousHandler, TaskHandler, DebounceHandler |
| `job.terminated` | `CleanupService.terminate()` | CleanupService |
| `execution.started` | Before `run()` in execute | JobExecutionService |
| `execution.succeeded` | After successful `run()` | JobExecutionService |
| `execution.failed` | On error in `run()` | JobExecutionService |
| `retry.scheduled` | On `RetryScheduledSignal` | JobExecutionService |
| `retry.exhausted` | On `RetryExhaustedSignal` | JobExecutionService |
| `alarm.scheduled` | `AlarmService.schedule()` | AlarmService |
| `alarm.fired` | `Dispatcher.handleAlarm()` | Dispatcher |

### 5. Layer Integration

Add tracker to the jobs runtime layer composition:

```typescript
// packages/jobs/src/runtime/runtime.ts

export const createJobsRuntime = <R>(
  registry: RuntimeJobRegistry,
  config?: {
    tracker?: HttpBatchTrackerConfig;  // Optional tracking config
  }
) => {
  // Select tracker layer based on config
  const trackerLayer = config?.tracker
    ? HttpBatchTrackerLayer(config.tracker)
    : NoopTrackerLayer;

  // Compose with existing layers
  const runtimeLayer = Layer.mergeAll(
    RuntimeServicesLayer,
    CleanupServiceLayer,
    RetryExecutorLayer,
    JobExecutionServiceLayer,
    JobHandlersLayer,
    DispatcherLayer,
  ).pipe(
    Layer.provideMerge(trackerLayer),  // Add tracker
    Layer.provideMerge(RegistryServiceLayer(registry)),
  );

  return { /* ... */ };
};
```

### 6. Safe Emission Pattern

Use the same pattern as workflow - events are emitted safely without failing execution:

```typescript
// packages/jobs/src/tracker/emit.ts

import { Effect } from "effect";
import { EventTracker } from "@durable-effect/core";

export const emitJobEvent = (event: InternalJobEvent): Effect.Effect<void> =>
  Effect.flatMap(Effect.serviceOption(EventTracker), (option) =>
    option._tag === "Some" ? option.value.emit(event) : Effect.void,
  );
```

## Implementation Strategy

### Phase 1: Infrastructure Setup

1. Move tracker types and implementations to `packages/core/src/tracker/`
2. Export from core package
3. Update workflow package to import from core
4. Add job event type definitions to `packages/core/src/events.ts`

### Phase 2: Core Integration Points

1. Add `EventTracker` to jobs runtime layer composition
2. Create `emitJobEvent()` helper in jobs package
3. Integrate tracking into `JobExecutionService`:
   - `execution.started` before user function
   - `execution.succeeded` / `execution.failed` after
   - `retry.scheduled` / `retry.exhausted` on signals

### Phase 3: Service-Level Integration

1. **MetadataService**: Emit `job.created` on `initialize()`
2. **CleanupService**: Emit `job.terminated` on `terminate()`
3. **AlarmService**: Emit `alarm.scheduled` / `alarm.cancelled`
4. **Dispatcher**: Emit `alarm.fired` in `handleAlarm()`

### Phase 4: Handler-Specific Events

1. **ContinuousHandler**: `job.started`, execution lifecycle
2. **TaskHandler**: `task.event.received`, `task.event.processed`, `task.idle`
3. **DebounceHandler**: `debounce.event.added`, `debounce.flush.triggered`

### Phase 5: Testing & Documentation

1. Add tracking tests using `InMemoryTrackerLayer`
2. Update job definition examples with tracking config
3. Document event schema for consumers

## Event Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                     Job Execution                            │
└─────────────────────────────────────────────────────────────┘
                              │
   ┌──────────────────────────┼──────────────────────────────┐
   │                          │                              │
   ▼                          ▼                              ▼
job.created              execution.started              alarm.scheduled
(MetadataService)        (JobExecutionService)          (AlarmService)
   │                          │                              │
   │                     ┌────┴────┐                         │
   │                     │         │                         │
   │            execution.succeeded  execution.failed        │
   │                     │         │                         │
   │                     │    ┌────┴────┐                    │
   │                     │    │         │                    │
   │                     │ retry.scheduled  retry.exhausted  │
   │                     │    │         │                    │
   │                     │    │         ▼                    │
   │                     │    │    job.terminated            │
   │                     │    │    (CleanupService)          │
   │                     │    │                              │
   └─────────────────────┴────┴──────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────────┐
                    │   EventTracker      │
                    │   ├─ emit()         │
                    │   └─ flush()        │
                    └─────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
         NoopTracker    InMemoryTracker  HttpBatchTracker
```

## Key Design Decisions

### 1. Shared Core vs Separate Implementations

**Decision**: Move tracker infrastructure to `@durable-effect/core`

**Rationale**:
- Single source of truth for event types
- Reusable tracker implementations
- Consistent patterns across workflow and jobs
- Easier to maintain unified monitoring

### 2. Event Granularity

**Decision**: Emit at service boundaries, not within user code

**Rationale**:
- Non-invasive to user functions
- Captures infrastructure-level events
- User can add custom events via Effect.log if needed
- Reduces event volume

### 3. Flush Strategy

**Decision**: Flush at job completion boundaries (success, failure, termination)

**Rationale**:
- Ensures events delivered before DO hibernates
- Matches workflow pattern
- Batching provides efficiency

### 4. Event Enrichment

**Decision**: Base events contain job context; tracker adds env/serviceKey

**Rationale**:
- Separation of concerns
- Base events are portable
- Environment context is deployment-specific

## Testing Strategy

```typescript
// Example test with tracking
describe("ContinuousHandler with tracking", () => {
  it("emits lifecycle events", async () => {
    const { layer: trackerLayer, handle } = await Effect.runPromise(
      createInMemoryTrackerLayer()
    );

    const testLayer = createTestLayer().pipe(
      Layer.provideMerge(trackerLayer)
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const handler = yield* ContinuousHandler;
        yield* handler.handle({ type: "continuous", action: "start", ... });
      }).pipe(Effect.provide(testLayer))
    );

    const events = await Effect.runPromise(handle.getEvents());
    expect(events).toContainEqual(expect.objectContaining({ type: "job.created" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "execution.started" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "execution.succeeded" }));
  });
});
```

## Migration Path

1. **No Breaking Changes**: Tracking is opt-in via config
2. **Default Behavior**: NoopTracker (same as current behavior)
3. **Gradual Adoption**: Enable tracking per-deployment

## Summary

This design provides a clear path to integrate tracking into the jobs package:

1. **Reuse** existing tracker infrastructure from workflow (move to core)
2. **Define** job-specific event types in core package
3. **Integrate** at well-defined service boundaries
4. **Test** with in-memory tracker for assertions
5. **Deploy** with HTTP batch tracker for production

The architecture ensures tracking is:
- **Optional**: NoopTracker by default
- **Efficient**: Batched event delivery
- **Safe**: Failed emission doesn't fail jobs
- **Consistent**: Same patterns as workflow tracking
