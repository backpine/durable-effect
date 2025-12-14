# Primitive Events Data Model

## Overview

This document describes the event data model for tracking jobs (Continuous, Debounce, WorkerPool). Unlike workflow tracking which captures fine-grained step-level events, primitive tracking is designed for higher volume, lower granularity observability.

## Design Principles

### 1. Volume Awareness
Jobs execute at much higher frequencies than workflows:
- **Continuous**: Can run every 10 seconds
- **Debounce**: Receives events continuously, flushes periodically
- **WorkerPool**: Processes potentially thousands of events per second

We must be selective about what we track to avoid overwhelming the tracking service.

### 2. Segmentation via "Grain"
To allow the tracking service to distinguish workflows from jobs, we introduce a **`grain`** field:

```typescript
type Grain = "workflow" | "primitive";
```

This enables:
- Separate dashboards/views for workflows vs jobs
- Different retention policies
- Optimized queries per grain type

### 3. Primitive Type Discrimination
Within jobs, events are further discriminated by **`primitiveType`**:

```typescript
type PrimitiveType = "continuous" | "debounce" | "workerPool";
```

---

## Base Event Schema

### Current Workflow Base Event

```typescript
// Workflow base fields
interface WorkflowBaseEvent {
  eventId: string;      // UUIDv7 for time-ordering
  timestamp: string;    // ISO 8601
  workflowId: string;   // Durable Object ID
  workflowName: string; // Definition name
  executionId?: string; // User correlation ID
  env: string;          // Environment (production, staging)
  serviceKey: string;   // User service identifier
}
```

### Proposed Primitive Base Event

```typescript
// Primitive base fields
interface PrimitiveBaseEvent {
  eventId: string;        // UUIDv7 for time-ordering
  timestamp: string;      // ISO 8601
  grain: "primitive";     // Discriminator from workflows
  primitiveType: "continuous" | "debounce" | "workerPool";
  primitiveId: string;    // Durable Object ID
  primitiveName: string;  // Definition name (e.g., "tokenRefresher")
  instanceId: string;     // User-provided instance ID
  env: string;            // Environment
  serviceKey: string;     // User service identifier
}
```

### Key Differences from Workflows

| Field | Workflow | Primitive | Reason |
|-------|----------|-----------|--------|
| `grain` | (not present) | `"primitive"` | Segment at ingestion |
| `primitiveType` | (not present) | `"continuous" \| "debounce" \| "workerPool"` | Type discrimination |
| `workflowId` | DO ID | - | Renamed for clarity |
| `primitiveId` | - | DO ID | Renamed for clarity |
| `instanceId` | - | User ID | What user passes to `start()` |

---

## Event Types by Primitive

### Continuous Primitive Events

Per the tracking rules, we track:
1. When started (with config info)
2. When execution succeeds
3. When execution fails (with error info)

#### `continuous.started`

Emitted once when the primitive is first started.

```typescript
interface ContinuousStartedEvent extends PrimitiveBaseEvent {
  type: "continuous.started";
  primitiveType: "continuous";
  config: {
    schedule: {
      type: "every" | "cron";
      interval?: string;      // e.g., "30 minutes"
      expression?: string;    // cron expression
    };
    startImmediately: boolean;
  };
  initialState: unknown;  // Redacted or subset for privacy
}
```

#### `continuous.executed`

Emitted after each successful execution.

```typescript
interface ContinuousExecutedEvent extends PrimitiveBaseEvent {
  type: "continuous.executed";
  primitiveType: "continuous";
  runCount: number;       // How many times execute() has run
  durationMs: number;     // Execution time
  nextRunAt?: string;     // ISO timestamp of next scheduled run
}
```

#### `continuous.failed`

Emitted when execution fails (after onError handler, if any).

```typescript
interface ContinuousFailedEvent extends PrimitiveBaseEvent {
  type: "continuous.failed";
  primitiveType: "continuous";
  runCount: number;
  error: {
    message: string;
    stack?: string;
    name?: string;
  };
  handledByOnError: boolean;  // Whether onError handler was called
}
```

#### `continuous.stopped`

Emitted when primitive is stopped (via client or terminate).

```typescript
interface ContinuousStoppedEvent extends PrimitiveBaseEvent {
  type: "continuous.stopped";
  primitiveType: "continuous";
  runCount: number;
  reason?: string;
  stoppedBy: "client" | "terminate" | "error";
  totalDurationMs: number;  // Time since started
}
```

---

### Debounce Primitive Events

Per the tracking rules, we track:
1. First event received (with config info)
2. Successful flush (with event count, trigger reason)
3. Failed flush (with error info)

#### `debounce.initialized`

Emitted when first event is added to debounce (not on every add).

```typescript
interface DebounceInitializedEvent extends PrimitiveBaseEvent {
  type: "debounce.initialized";
  primitiveType: "debounce";
  config: {
    flushAfter: string;     // Duration string
    maxEvents?: number;
  };
}
```

#### `debounce.flushed`

Emitted after successful flush.

```typescript
interface DebounceFlushedEvent extends PrimitiveBaseEvent {
  type: "debounce.flushed";
  primitiveType: "debounce";
  eventCount: number;       // How many events were in debounce
  trigger: "schedule" | "maxEvents" | "manual";
  durationMs: number;       // Flush execution time
  totalEventsProcessed: number; // Cumulative count
}
```

#### `debounce.failed`

Emitted when flush fails.

```typescript
interface DebounceFailedEvent extends PrimitiveBaseEvent {
  type: "debounce.failed";
  primitiveType: "debounce";
  eventCount: number;
  trigger: "schedule" | "maxEvents" | "manual";
  error: {
    message: string;
    stack?: string;
  };
  handledByOnError: boolean;
}
```

---

### WorkerPool Primitive Events

WorkerPools are high-volume, so we need aggregated events rather than per-message tracking.

#### Proposed Approach: Periodic Snapshots

Instead of tracking every enworkerPool/deworkerPool, emit periodic snapshots:

#### `workerPool.snapshot`

Emitted periodically (e.g., every 30 seconds, or after N events processed).

```typescript
interface WorkerPoolSnapshotEvent extends PrimitiveBaseEvent {
  type: "workerPool.snapshot";
  primitiveType: "workerPool";
  metrics: {
    pendingCount: number;     // Events waiting
    processingCount: number;  // Events being processed
    processedCount: number;   // Events processed since last snapshot
    failedCount: number;      // Events failed since last snapshot
    deadLetterCount: number;  // Events sent to DLQ since last snapshot
    avgProcessingMs: number;  // Average processing time
    maxProcessingMs: number;  // Max processing time in period
  };
  config: {
    concurrency: number;
    retry?: {
      maxAttempts: number;
    };
  };
}
```

#### `workerPool.initialized`

Emitted when workerPool first receives an event.

```typescript
interface WorkerPoolInitializedEvent extends PrimitiveBaseEvent {
  type: "workerPool.initialized";
  primitiveType: "workerPool";
  config: {
    concurrency: number;
    retry?: {
      maxAttempts: number;
      initialDelay: string;
      maxDelay?: string;
      backoffMultiplier?: number;
    };
  };
}
```

#### `workerPool.deadLetter`

Emitted when an event exhausts retries.

```typescript
interface WorkerPoolDeadLetterEvent extends PrimitiveBaseEvent {
  type: "workerPool.deadLetter";
  primitiveType: "workerPool";
  eventId: string;          // The failed event's ID
  attempts: number;
  error: {
    message: string;
    stack?: string;
  };
}
```

#### `workerPool.drained`

Emitted when workerPool becomes empty after processing.

```typescript
interface WorkerPoolDrainedEvent extends PrimitiveBaseEvent {
  type: "workerPool.drained";
  primitiveType: "workerPool";
  totalProcessed: number;
  totalFailed: number;
  totalDeadLettered: number;
  totalDurationMs: number;
}
```

---

## Event Union Types

### All Primitive Events (Internal)

```typescript
type InternalPrimitiveEvent =
  // Continuous
  | ContinuousStartedEvent
  | ContinuousExecutedEvent
  | ContinuousFailedEvent
  | ContinuousStoppedEvent
  // Debounce
  | DebounceInitializedEvent
  | DebounceFlushedEvent
  | DebounceFailedEvent
  // WorkerPool
  | WorkerPoolInitializedEvent
  | WorkerPoolSnapshotEvent
  | WorkerPoolDeadLetterEvent
  | WorkerPoolDrainedEvent;
```

### Combined with Workflows

The tracking service receives a unified stream:

```typescript
type TrackingEvent =
  | WorkflowEvent      // grain: "workflow" (implicit, or add field)
  | PrimitiveEvent;    // grain: "primitive"
```

---

## Implementation Plan

### Phase 1: Add `grain` to Core Events

Update `@durable-effect/core` to support grain discrimination:

```typescript
// In events.ts
const BaseEventFields = {
  eventId: Schema.String,
  timestamp: Schema.String,
  grain: Schema.Literal("workflow", "primitive"),
  // ... rest
};
```

Or alternatively, keep separate schemas and discriminate at the tracking service level via the `type` prefix:
- `workflow.*` events
- `continuous.*`, `debounce.*`, `workerPool.*` events

**Recommendation**: Use the `type` prefix approach initially (simpler), add explicit `grain` field later if needed for query optimization.

### Phase 2: Implement Continuous Events

1. Add event schemas to `@durable-effect/jobs`
2. Emit `continuous.started` in start handler
3. Emit `continuous.executed` after successful execute
4. Emit `continuous.failed` after failed execute
5. Emit `continuous.stopped` on stop/terminate

### Phase 3: Implement Debounce Events

1. Add event schemas
2. Track first event to emit `debounce.initialized`
3. Emit `debounce.flushed` after successful flush
4. Emit `debounce.failed` after failed flush

### Phase 4: Implement WorkerPool Events

1. Add event schemas
2. Implement snapshot timer/counter
3. Emit `workerPool.snapshot` periodically
4. Emit `workerPool.deadLetter` on DLQ
5. Emit `workerPool.drained` when empty

---

## Event Volume Analysis

### Continuous (Low Volume)
- 1 `started` per instance lifetime
- 1 `executed` or `failed` per schedule interval
- 1 `stopped` per instance lifetime

Example: 100 instances × 1 execution/30min = **200 events/hour**

### Debounce (Medium Volume)
- 1 `initialized` per debounce lifetime
- 1 `flushed` or `failed` per flush cycle
- Flushes happen on schedule OR max events

Example: 50 debounces × 12 flushes/hour = **600 events/hour**

### WorkerPool (Controlled Volume)
- 1 `initialized` per workerPool lifetime
- 1 `snapshot` per 30 seconds = 120/hour per workerPool
- 1 `deadLetter` per failed event (hopefully rare)
- 1 `drained` per empty event (variable)

Example: 10 workerPools × 120 snapshots/hour = **1,200 events/hour**

**Total**: ~2,000 events/hour for a moderate deployment (vs potentially millions of per-message events).

---

## Schema Definitions (Effect Schema)

```typescript
// packages/jobs/src/events.ts

import { Schema } from "effect";

// Base fields for all primitive events
const PrimitiveBaseFields = {
  eventId: Schema.String,
  timestamp: Schema.String,
  primitiveType: Schema.Literal("continuous", "debounce", "workerPool"),
  primitiveId: Schema.String,
  primitiveName: Schema.String,
  instanceId: Schema.String,
};

// Wire format adds env/serviceKey
const WirePrimitiveBaseFields = {
  ...PrimitiveBaseFields,
  env: Schema.String,
  serviceKey: Schema.String,
};

// Continuous events
export const ContinuousStartedEventSchema = Schema.Struct({
  ...WirePrimitiveBaseFields,
  type: Schema.Literal("continuous.started"),
  primitiveType: Schema.Literal("continuous"),
  config: Schema.Struct({
    schedule: Schema.Struct({
      type: Schema.Literal("every", "cron"),
      interval: Schema.optional(Schema.String),
      expression: Schema.optional(Schema.String),
    }),
    startImmediately: Schema.Boolean,
  }),
});

// ... etc for other events
```

---

## Open Questions

1. **Should `grain` be explicit or inferred from `type` prefix?**
   - Explicit: Easier to query, more bytes per event
   - Inferred: Smaller events, query logic in tracking service

2. **WorkerPool snapshot frequency?**
   - Time-based (every 30s) vs count-based (every 100 events)?
   - Configurable per workerPool?

3. **Should we track `continuous.terminated` separately from `stopped`?**
   - Currently using `stoppedBy: "terminate"` field
   - Could be separate event type for clearer semantics

4. **Error redaction?**
   - Should we limit error message/stack length?
   - PII concerns in error messages?

5. **State tracking?**
   - Should we include state snapshots in events?
   - Privacy/size concerns vs debugging value

---

## Next Steps

1. Review this proposal
2. Decide on `grain` field approach
3. Implement Phase 1 (core changes if needed)
4. Implement Phase 2 (continuous events)
5. Update `000-tracking-rules.md` with final decisions
