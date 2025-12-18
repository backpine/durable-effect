# Report 059: Jobs Event Schema Design

## Overview

This report details how to add job tracking events to `@durable-effect/core` while:
1. Distinguishing workflow events from job events
2. Keeping workflow tracking backward compatible
3. Supporting the lightweight job events defined in `primitives-docs/features/000-tracking-jobs.md`

## Current State

### Workflow Event Structure

Events in `packages/core/src/events.ts` are workflow-specific:

```typescript
// Base fields are workflow-specific
const InternalBaseEventFields = {
  eventId: Schema.String,
  timestamp: Schema.String,
  workflowId: Schema.String,      // ← Workflow-specific
  workflowName: Schema.String,    // ← Workflow-specific
  executionId: Schema.optional(Schema.String),
};
```

Event types are prefixed with workflow concepts:
- `workflow.started`, `workflow.completed`, `workflow.failed`
- `step.started`, `step.completed`, `step.failed`
- `retry.scheduled`, `retry.exhausted`
- `sleep.started`, `sleep.completed`

### Required Job Events

From `primitives-docs/features/000-tracking-jobs.md`:

**General (shared)**
- Failure and retries

**Continuous**
- Event when setup
- Event when executed (include run count)

**Debounce**
- Event for first event received
- Event when executed (include event count and flush reason)

**Task**
- Event for each execution (include run count)
- Event when schedule is set

## Design Approach

### Option 1: Add `source` Discriminator Field

Add a `source` field to all events to distinguish origin:

```typescript
const CommonBaseFields = {
  eventId: Schema.String,
  timestamp: Schema.String,
  source: Schema.Literal("workflow", "job"),  // ← New discriminator
};
```

**Pros**: Simple, backward compatible (add default)
**Cons**: Doesn't address the workflowId/jobId naming issue

### Option 2: Separate Base Schemas (Recommended)

Create separate base schemas for workflows and jobs:

```typescript
// Shared across all events
const SharedBaseFields = {
  eventId: Schema.String,
  timestamp: Schema.String,
};

// Workflow-specific base
const WorkflowBaseFields = {
  ...SharedBaseFields,
  source: Schema.Literal("workflow"),
  workflowId: Schema.String,
  workflowName: Schema.String,
  executionId: Schema.optional(Schema.String),
};

// Job-specific base
const JobBaseFields = {
  ...SharedBaseFields,
  source: Schema.Literal("job"),
  instanceId: Schema.String,        // Durable Object ID
  jobType: Schema.Literal("continuous", "debounce", "task", "workerPool"),
  jobName: Schema.String,           // Job definition name
};
```

**Pros**:
- Clear separation of concerns
- Type-safe - workflows use workflow fields, jobs use job fields
- `source` field allows easy filtering on the receiving end
- No breaking changes to existing workflow events

**Cons**:
- More schemas to maintain
- Wire format grows slightly

## Recommended Implementation

### Phase 1: Add Shared Base and Source Field

```typescript
// packages/core/src/events.ts

// =============================================================================
// Shared Base (all events)
// =============================================================================

const SharedBaseFields = {
  /** Unique event ID for deduplication */
  eventId: Schema.String,
  /** ISO timestamp when event occurred */
  timestamp: Schema.String,
};

// =============================================================================
// Workflow Base (existing, updated)
// =============================================================================

const InternalWorkflowBaseFields = {
  ...SharedBaseFields,
  /** Event source discriminator */
  source: Schema.Literal("workflow"),
  /** Durable Object ID */
  workflowId: Schema.String,
  /** Workflow definition name */
  workflowName: Schema.String,
  /** Optional user-provided execution ID for correlation */
  executionId: Schema.optional(Schema.String),
};

// =============================================================================
// Job Base (new)
// =============================================================================

const InternalJobBaseFields = {
  ...SharedBaseFields,
  /** Event source discriminator */
  source: Schema.Literal("job"),
  /** Durable Object instance ID */
  instanceId: Schema.String,
  /** Job type discriminator */
  jobType: Schema.Literal("continuous", "debounce", "task", "workerPool"),
  /** Job definition name */
  jobName: Schema.String,
};
```

### Phase 2: Define Job Event Schemas

```typescript
// =============================================================================
// Job Lifecycle Events
// =============================================================================

/**
 * Emitted when a job instance is created/started.
 */
export const InternalJobStartedEventSchema = Schema.Struct({
  ...InternalJobBaseFields,
  type: Schema.Literal("job.started"),
  /** Initial state/input provided */
  input: Schema.optional(Schema.Unknown),
});

/**
 * Emitted when a job execution runs.
 */
export const InternalJobExecutedEventSchema = Schema.Struct({
  ...InternalJobBaseFields,
  type: Schema.Literal("job.executed"),
  /** Run number (1-indexed) */
  runCount: Schema.Number,
  /** Execution duration in milliseconds */
  durationMs: Schema.Number,
  /** Current retry attempt (1 = first attempt) */
  attempt: Schema.Number,
});

/**
 * Emitted when a job execution fails.
 */
export const InternalJobFailedEventSchema = Schema.Struct({
  ...InternalJobBaseFields,
  type: Schema.Literal("job.failed"),
  error: Schema.Struct({
    message: Schema.String,
    stack: Schema.optional(Schema.String),
  }),
  /** Run number when failure occurred */
  runCount: Schema.Number,
  /** Retry attempt when failure occurred */
  attempt: Schema.Number,
  /** Whether a retry will be attempted */
  willRetry: Schema.Boolean,
});

/**
 * Emitted when job retries are exhausted.
 */
export const InternalJobRetryExhaustedEventSchema = Schema.Struct({
  ...InternalJobBaseFields,
  type: Schema.Literal("job.retryExhausted"),
  /** Total attempts made */
  attempts: Schema.Number,
  /** Reason for exhaustion */
  reason: Schema.Literal("max_attempts", "max_duration"),
});

/**
 * Emitted when a job is terminated.
 */
export const InternalJobTerminatedEventSchema = Schema.Struct({
  ...InternalJobBaseFields,
  type: Schema.Literal("job.terminated"),
  /** Termination reason */
  reason: Schema.optional(Schema.String),
  /** Total runs before termination */
  runCount: Schema.Number,
});

// =============================================================================
// Debounce-specific Events
// =============================================================================

/**
 * Emitted when first event is received for a debounce job.
 */
export const InternalDebounceStartedEventSchema = Schema.Struct({
  ...InternalJobBaseFields,
  type: Schema.Literal("debounce.started"),
  /** When the flush is scheduled */
  flushAt: Schema.String,
});

/**
 * Emitted when a debounce job flushes.
 */
export const InternalDebounceFlushedEventSchema = Schema.Struct({
  ...InternalJobBaseFields,
  type: Schema.Literal("debounce.flushed"),
  /** Number of events in the batch */
  eventCount: Schema.Number,
  /** What triggered the flush */
  reason: Schema.Literal("timeout", "maxEvents", "manual"),
  /** Execution duration in milliseconds */
  durationMs: Schema.Number,
});

// =============================================================================
// Task-specific Events
// =============================================================================

/**
 * Emitted when a task execution is scheduled.
 */
export const InternalTaskScheduledEventSchema = Schema.Struct({
  ...InternalJobBaseFields,
  type: Schema.Literal("task.scheduled"),
  /** When execution is scheduled for */
  scheduledAt: Schema.String,
  /** What triggered the schedule */
  trigger: Schema.Literal("event", "execute", "idle", "error"),
});
```

### Phase 3: Create Union Types

```typescript
// =============================================================================
// Job Event Union
// =============================================================================

export const InternalJobEventSchema = Schema.Union(
  // Lifecycle
  InternalJobStartedEventSchema,
  InternalJobExecutedEventSchema,
  InternalJobFailedEventSchema,
  InternalJobRetryExhaustedEventSchema,
  InternalJobTerminatedEventSchema,
  // Debounce-specific
  InternalDebounceStartedEventSchema,
  InternalDebounceFlushedEventSchema,
  // Task-specific
  InternalTaskScheduledEventSchema,
);

export type InternalJobEvent = Schema.Schema.Type<typeof InternalJobEventSchema>;

// =============================================================================
// Combined Event Union (for HTTP tracker)
// =============================================================================

export const InternalTrackingEventSchema = Schema.Union(
  InternalWorkflowEventSchema,
  InternalJobEventSchema,
);

export type InternalTrackingEvent = Schema.Schema.Type<typeof InternalTrackingEventSchema>;
```

### Phase 4: Update Helper Functions

```typescript
// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Create base fields for a workflow event.
 */
export function createWorkflowBaseEvent(
  workflowId: string,
  workflowName: string,
  executionId?: string,
): InternalWorkflowBase {
  return {
    eventId: uuidv7(),
    timestamp: new Date().toISOString(),
    source: "workflow",
    workflowId,
    workflowName,
    ...(executionId && { executionId }),
  };
}

/**
 * Create base fields for a job event.
 */
export function createJobBaseEvent(
  instanceId: string,
  jobType: "continuous" | "debounce" | "task" | "workerPool",
  jobName: string,
): InternalJobBase {
  return {
    eventId: uuidv7(),
    timestamp: new Date().toISOString(),
    source: "job",
    instanceId,
    jobType,
    jobName,
  };
}

/**
 * Enrich any tracking event with env and serviceKey.
 */
export function enrichEvent<T extends InternalTrackingEvent>(
  event: T,
  env: string,
  serviceKey: string,
): T & { env: string; serviceKey: string } {
  return {
    ...event,
    env,
    serviceKey,
  };
}
```

## Backward Compatibility

### Workflow Package Changes

The workflow package currently uses:
```typescript
import { createBaseEvent, type InternalWorkflowEvent } from "@durable-effect/core";
```

After changes:
1. `createBaseEvent` → `createWorkflowBaseEvent` (rename or alias)
2. `InternalWorkflowEvent` stays the same but now includes `source: "workflow"`
3. All existing workflow events get `source: "workflow"` added

### Migration Path

1. Add `source: "workflow"` to existing `InternalBaseEventFields`
2. Add new job base and event schemas
3. Update `createBaseEvent` to include `source: "workflow"`
4. Export new job helpers and types
5. Workflow package continues working - only internal field added

## Event Summary

### Workflow Events (existing + source field)
| Event | When Emitted |
|-------|--------------|
| `workflow.started` | Workflow begins execution |
| `workflow.queued` | Workflow queued for async |
| `workflow.completed` | Workflow finishes successfully |
| `workflow.failed` | Workflow fails permanently |
| `workflow.paused` | Workflow pauses (sleep/retry) |
| `workflow.resumed` | Workflow resumes from pause |
| `workflow.cancelled` | Workflow is cancelled |
| `step.started` | Step begins execution |
| `step.completed` | Step finishes successfully |
| `step.failed` | Step fails |
| `retry.scheduled` | Retry scheduled after failure |
| `retry.exhausted` | All retries exhausted |
| `sleep.started` | Sleep begins |
| `sleep.completed` | Sleep completes |
| `timeout.set` | Timeout deadline set |
| `timeout.exceeded` | Timeout deadline exceeded |

### Job Events (new)
| Event | When Emitted | Job Types |
|-------|--------------|-----------|
| `job.started` | Job instance created | All |
| `job.executed` | Execution completes | Continuous, Task |
| `job.failed` | Execution fails | All |
| `job.retryExhausted` | All retries exhausted | All |
| `job.terminated` | Job terminated | All |
| `debounce.started` | First event received | Debounce |
| `debounce.flushed` | Flush executes | Debounce |
| `task.scheduled` | Schedule is set | Task |

## Wire Format Examples

### Workflow Event (wire format)
```json
{
  "eventId": "01234567-89ab-cdef-0123-456789abcdef",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "source": "workflow",
  "workflowId": "workflow-abc123",
  "workflowName": "processOrder",
  "executionId": "order-456",
  "type": "workflow.completed",
  "completedSteps": ["validateOrder", "chargePayment", "sendEmail"],
  "durationMs": 5420,
  "env": "production",
  "serviceKey": "order-service"
}
```

### Job Event (wire format)
```json
{
  "eventId": "01234567-89ab-cdef-0123-456789abcdef",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "source": "job",
  "instanceId": "job-xyz789",
  "jobType": "continuous",
  "jobName": "heartbeat",
  "type": "job.executed",
  "runCount": 42,
  "durationMs": 15,
  "attempt": 1,
  "env": "production",
  "serviceKey": "monitoring-service"
}
```

## File Changes Summary

| File | Changes |
|------|---------|
| `packages/core/src/events.ts` | Add shared base, job base, job events, source field |
| `packages/core/src/index.ts` | Export new job event types and helpers |
| `packages/workflow/src/orchestrator/orchestrator.ts` | Use `createWorkflowBaseEvent` (or alias) |
| `packages/workflow/src/primitives/step.ts` | Use `createWorkflowBaseEvent` (or alias) |
| `packages/workflow/src/primitives/sleep.ts` | Use `createWorkflowBaseEvent` (or alias) |

## Implementation Order

1. **Phase 1**: Update `events.ts` with shared base and `source` field for workflows
2. **Phase 2**: Add job base fields and event schemas
3. **Phase 3**: Add union types and helper functions
4. **Phase 4**: Update workflow package to use renamed helper (if needed)
5. **Phase 5**: Build and test - all workflow tests should pass
6. **Phase 6**: Jobs package can start using job events
