# Job Tracking Implementation Plan

## Overview

Add light-weight tracking to `@durable-effect/jobs` using the existing event infrastructure in `@durable-effect/core`.

## Current State

### Events Already Defined in Core (`packages/core/src/events.ts`)

All job events are already defined:

**General Lifecycle:**
- `job.started` - when job instance is created
- `job.executed` - when execution succeeds (runCount, durationMs, attempt)
- `job.failed` - when execution fails (error, runCount, attempt, willRetry)
- `job.retryExhausted` - when retries exhausted
- `job.terminated` - when job ends

**Debounce-specific:**
- `debounce.started` - first event received (flushAt)
- `debounce.flushed` - when flush occurs (eventCount, reason: timeout/maxEvents/manual, durationMs)

**Task-specific:**
- `task.scheduled` - when execution is scheduled (scheduledAt, trigger: event/execute/idle/error)

### Helper Function

```typescript
createJobBaseEvent(instanceId, jobType, jobName) // returns InternalJobBaseEvent
```

### Tracker Infrastructure

The core tracker (`emitEvent`, `flushEvents`, `EventTracker`) is generic and works with any event type.

## Architecture Analysis

### Jobs Package Structure

```
packages/jobs/src/
├── engine/engine.ts          # DO shell - delegates to runtime
├── runtime/runtime.ts        # Creates layers, provides handle/handleAlarm/flush
├── services/execution.ts     # Central execution service - ALL jobs go through here
├── handlers/
│   ├── continuous/handler.ts # Continuous job handler
│   ├── debounce/handler.ts   # Debounce job handler
│   └── task/handler.ts       # Task job handler
└── factory.ts                # Creates DO class and client
```

### Key Insight: Single Execution Point

All job executions go through `JobExecutionService.execute()`. This is the ideal place to emit:
- `job.executed` (on success)
- `job.failed` (on error, with willRetry)
- `job.retryExhausted` (when retries exhausted)

### Known Bug: Same as Workflow

The jobs package has the same `waitUntil` bug as workflow:

```typescript
// engine/engine.ts
async call(request: JobRequest): Promise<JobResponse> {
  const result = await this.#runtime.handle(request);
  this.ctx.waitUntil(this.#runtime.flush()); // BUG: Creates new tracker instance!
  return result;
}
```

And in runtime.ts:
```typescript
flush: () => runEffect(flushEvents), // BUG: runEffect creates new layer = new tracker
```

## Implementation Plan

### Phase 1: Fix the Flush Bug

**File: `packages/jobs/src/runtime/runtime.ts`**

Change from separate `flush()` to integrated approach:

```typescript
// BEFORE (broken)
handle: (request: JobRequest) =>
  runEffect(
    Effect.gen(function* () {
      const dispatcher = yield* Dispatcher;
      return yield* dispatcher.handle(request);
    })
  ),
flush: () => runEffect(flushEvents),

// AFTER (fixed)
handle: (request: JobRequest) =>
  runEffect(
    Effect.gen(function* () {
      const dispatcher = yield* Dispatcher;
      const result = yield* dispatcher.handle(request);
      yield* flushEvents; // Flush in same execution context
      return result;
    })
  ),
// Remove flush() method - no longer needed
```

Same fix for `handleAlarm`.

**File: `packages/jobs/src/engine/engine.ts`**

Remove the `waitUntil(flush())` calls since flush now happens inside handle/handleAlarm.

### Phase 2: Add Tracker to Layer Stack

**File: `packages/jobs/src/factory.ts`**

Add tracker config option:

```typescript
export interface CreateDurableJobsOptions {
  tracker?: HttpBatchTrackerConfig;
}

export function createDurableJobs<T>(
  definitions: T,
  options?: CreateDurableJobsOptions
): CreateDurableJobsResult<T> {
  // Pass tracker config to runtime
}
```

**File: `packages/jobs/src/runtime/runtime.ts`**

Add tracker layer to the layer stack:

```typescript
function createDispatcherLayer(
  coreLayer: RuntimeLayer,
  registry: RuntimeJobRegistry,
  trackerConfig?: HttpBatchTrackerConfig
): Layer.Layer<Dispatcher> {
  // Add tracker layer
  const trackerLayer = trackerConfig
    ? HttpBatchTrackerLayer(trackerConfig)
    : NoopTrackerLayer;

  // Merge into layer stack
  const baseLayer = coreLayer.pipe(Layer.provideMerge(trackerLayer));
  // ... rest of layer composition
}
```

### Phase 3: Add Events to JobExecutionService

**File: `packages/jobs/src/services/execution.ts`**

This is the cleanest place - ALL job executions go through here.

```typescript
import {
  createJobBaseEvent,
  emitEvent,
  type InternalJobExecutedEvent,
  type InternalJobFailedEvent,
  type InternalJobRetryExhaustedEvent
} from "@durable-effect/core";

// Inside execute():
const startTime = Date.now();

yield* executionEffect.pipe(
  Effect.tap(() => {
    // On success
    const durationMs = Date.now() - startTime;
    return emitEvent({
      ...createJobBaseEvent(runtime.instanceId, jobType, jobName),
      type: "job.executed",
      runCount: options.runCount ?? 0,
      durationMs,
      attempt,
    } satisfies InternalJobExecutedEvent);
  }),
  Effect.catchAll((error) => {
    if (error instanceof RetryScheduledSignal) {
      // Emit job.failed with willRetry: true
      return emitEvent({
        ...createJobBaseEvent(runtime.instanceId, jobType, jobName),
        type: "job.failed",
        error: { message: String(error.lastError) },
        runCount: options.runCount ?? 0,
        attempt,
        willRetry: true,
      }).pipe(Effect.zipRight(Effect.void));
    }

    if (error instanceof RetryExhaustedSignal) {
      // Emit job.retryExhausted
      return emitEvent({
        ...createJobBaseEvent(runtime.instanceId, jobType, jobName),
        type: "job.retryExhausted",
        attempts: error.attempts,
        reason: "max_attempts",
      }).pipe(/* continue with existing logic */);
    }

    // ... existing error handling
  })
);
```

### Phase 4: Add Lifecycle Events to Handlers

Add lightweight events at key lifecycle points:

**Continuous Handler (`handlers/continuous/handler.ts`):**
- `job.started` in `handleStart()` when new job created
- `job.terminated` in `handleTerminate()`

**Debounce Handler (`handlers/debounce/handler.ts`):**
- `debounce.started` in `handleAdd()` when first event received
- `debounce.flushed` in `handleFlush()` / `runFlush()`

**Task Handler (`handlers/task/handler.ts`):**
- `task.scheduled` when schedule is set via `applyScheduleChanges()`

### Phase 5: Re-export from Jobs Package

**File: `packages/jobs/src/index.ts`**

```typescript
// Re-export tracker types for convenience
export {
  type HttpBatchTrackerConfig,
  type InternalJobEvent,
  type JobEvent,
} from "@durable-effect/core";
```

## Event Mapping to Requirements

From `000-tracking-jobs.md`:

| Requirement | Event Type | Location |
|------------|------------|----------|
| Failure and retries (generic) | `job.failed`, `job.retryExhausted` | JobExecutionService |
| Continuous: setup | `job.started` | ContinuousHandler.handleStart |
| Continuous: executed | `job.executed` | JobExecutionService |
| Debounce: first event | `debounce.started` | DebounceHandler.handleAdd |
| Debounce: executed | `debounce.flushed` | DebounceHandler.handleFlush |
| Task: executed | `job.executed` | JobExecutionService |
| Task: schedule set | `task.scheduled` | TaskHandler.applyScheduleChanges |

## Implementation Order

1. **Fix flush bug** - Critical, same issue as workflow
2. **Add tracker to layer stack** - Infrastructure
3. **Add events to JobExecutionService** - Covers job.executed, job.failed, job.retryExhausted
4. **Add lifecycle events to handlers** - job.started, job.terminated, debounce.*, task.scheduled
5. **Update exports and types** - Clean API

## Testing

- Add tracker tests similar to `packages/workflow/test/tracker/tracker.test.ts`
- Use `createInMemoryTrackerLayer` for unit tests
- Verify events are emitted at correct points with correct data

## Notes

- Events are "fire and forget" - they don't affect job execution
- Tracker is optional - `NoopTrackerLayer` is used if no config provided
- All events go through the same `HttpBatchTracker` as workflows
- The `env` and `serviceKey` enrichment happens automatically in the tracker
