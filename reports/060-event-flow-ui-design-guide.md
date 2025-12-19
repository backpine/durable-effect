# Event Flow & UI Design Guide

**For Product Engineers designing monitoring/observability UIs**

This document describes all tracking events emitted by the durable-effect system, their data schemas, and recommended UI patterns for visualizing workflow and job execution.

---

## Table of Contents

1. [Overview](#overview)
2. [Event Architecture](#event-architecture)
3. [Common Event Fields](#common-event-fields)
4. [Workflow Events](#workflow-events)
5. [Job Events](#job-events)
6. [Event Flow Diagrams](#event-flow-diagrams)
7. [UI Design Recommendations](#ui-design-recommendations)
8. [Database Schema Recommendations](#database-schema-recommendations)

---

## Overview

The system emits two categories of tracking events:

| Source | Package | Purpose |
|--------|---------|---------|
| `workflow` | `@durable-effect/workflow` | Multi-step, long-running processes with steps, retries, sleeps |
| `job` | `@durable-effect/jobs` | Recurring/scheduled tasks (continuous, debounce, task) |

Events are batched and sent via HTTP POST to a configured tracking endpoint in the format:

```json
{
  "events": [
    { /* event 1 */ },
    { /* event 2 */ },
    ...
  ]
}
```

---

## Event Architecture

### Discriminator Pattern

All events use a discriminated union pattern:

```typescript
// Route by source first
if (event.source === "workflow") {
  // Then by type: "workflow.started" | "step.completed" | ...
} else if (event.source === "job") {
  // Then by type: "job.started" | "debounce.flushed" | ...
}
```

### Event ID & Deduplication

Every event has a globally unique `eventId` (UUIDv7). UUIDv7 is:
- Lexicographically sortable by creation time
- Contains embedded timestamp for efficient time-range queries
- Safe for use as database primary key

---

## Common Event Fields

### Workflow Events Base Fields

All workflow events include:

```typescript
{
  eventId: string;        // UUIDv7 - unique event ID
  timestamp: string;      // ISO 8601 - when event occurred
  source: "workflow";     // Discriminator
  workflowId: string;     // Durable Object ID (unique per instance)
  workflowName: string;   // Definition name (e.g., "orderProcessing")
  executionId?: string;   // Optional user-provided correlation ID
  env: string;            // Environment (e.g., "production")
  serviceKey: string;     // Service identifier
}
```

### Job Events Base Fields

All job events include:

```typescript
{
  eventId: string;        // UUIDv7 - unique event ID
  timestamp: string;      // ISO 8601 - when event occurred
  source: "job";          // Discriminator
  instanceId: string;     // Durable Object ID (unique per instance)
  jobType: "continuous" | "debounce" | "task" | "workerPool";
  jobName: string;        // Definition name (e.g., "tokenRefresher")
  env: string;            // Environment
  serviceKey: string;     // Service identifier
}
```

---

## Workflow Events

### Lifecycle Events

#### `workflow.started`
**When:** Workflow begins synchronous execution via `run()`

```typescript
{
  type: "workflow.started",
  input: unknown,         // The input payload provided to the workflow
  // + base fields
}
```

**UI:** Show workflow as "Running" with start time. Display input in expandable panel.

---

#### `workflow.queued`
**When:** Workflow queued for async execution via `runAsync()`

```typescript
{
  type: "workflow.queued",
  input: unknown,
  // + base fields
}
```

**UI:** Show workflow as "Queued" with scheduled badge.

---

#### `workflow.resumed`
**When:** Workflow resumes after a pause (sleep completed or retry ready)

```typescript
{
  type: "workflow.resumed",
  // + base fields
}
```

**UI:** Update status from "Paused" to "Running". Add timeline entry.

---

#### `workflow.paused`
**When:** Workflow pauses for sleep or retry backoff

```typescript
{
  type: "workflow.paused",
  reason: "sleep" | "retry",
  resumeAt?: string,      // ISO timestamp when it will resume
  stepName?: string,      // Which step caused the pause (for retry)
  // + base fields
}
```

**UI:** Show workflow as "Paused" with countdown to `resumeAt`. Highlight the step causing the pause.

---

#### `workflow.completed`
**When:** Workflow finishes successfully

```typescript
{
  type: "workflow.completed",
  completedSteps: string[],  // Names of all completed steps
  durationMs: number,        // Total execution time
  // + base fields
}
```

**UI:** Show workflow as "Completed" (green). Display total duration and step count.

---

#### `workflow.failed`
**When:** Workflow fails permanently (unrecoverable error or retries exhausted)

```typescript
{
  type: "workflow.failed",
  error: {
    message: string,
    stack?: string,
    stepName?: string,    // Which step failed
    attempt?: number,     // Which attempt
  },
  completedSteps: string[],
  // + base fields
}
```

**UI:** Show workflow as "Failed" (red). Highlight failed step. Show error message prominently.

---

#### `workflow.cancelled`
**When:** Workflow manually cancelled

```typescript
{
  type: "workflow.cancelled",
  reason?: string,
  completedSteps: string[],
  // + base fields
}
```

**UI:** Show workflow as "Cancelled" (gray). Show reason if provided.

---

### Step Events

#### `step.started`
**When:** A step begins execution

```typescript
{
  type: "step.started",
  stepName: string,
  attempt: number,        // 1 = first attempt, 2 = first retry, etc.
  // + base fields
}
```

**UI:** Show step as "Running". If `attempt > 1`, show retry badge.

---

#### `step.completed`
**When:** A step completes successfully

```typescript
{
  type: "step.completed",
  stepName: string,
  attempt: number,
  durationMs: number,
  cached: boolean,        // True if result came from cache (replay)
  // + base fields
}
```

**UI:** Show step as "Completed" (green). Show duration. If `cached`, show "Cached" badge (indicates replay).

---

#### `step.failed`
**When:** A step fails

```typescript
{
  type: "step.failed",
  stepName: string,
  attempt: number,
  error: {
    message: string,
    stack?: string,
  },
  willRetry: boolean,     // True if retry will be attempted
  // + base fields
}
```

**UI:** If `willRetry`, show step as "Retrying" (orange). Otherwise, show as "Failed" (red).

---

### Retry Events

#### `retry.scheduled`
**When:** A retry is scheduled for a failed step

```typescript
{
  type: "retry.scheduled",
  stepName: string,
  attempt: number,        // The attempt that failed
  nextAttemptAt: string,  // When retry will execute
  delayMs: number,        // Backoff delay
  // + base fields
}
```

**UI:** Show countdown timer. Display retry strategy info (exponential backoff).

---

#### `retry.exhausted`
**When:** All retry attempts exhausted for a step

```typescript
{
  type: "retry.exhausted",
  stepName: string,
  attempts: number,       // Total attempts made
  // + base fields
}
```

**UI:** Show step as "Failed - Retries Exhausted" (red). Show total attempt count.

---

### Sleep Events

#### `sleep.started`
**When:** Workflow begins a sleep

```typescript
{
  type: "sleep.started",
  durationMs: number,
  resumeAt: string,       // When sleep ends
  // + base fields
}
```

**UI:** Show countdown timer. Display as workflow "Sleeping".

---

#### `sleep.completed`
**When:** Sleep ends and workflow continues

```typescript
{
  type: "sleep.completed",
  durationMs: number,
  // + base fields
}
```

**UI:** Remove sleep indicator. Resume workflow timeline.

---

### Timeout Events

#### `timeout.set`
**When:** A step timeout is configured

```typescript
{
  type: "timeout.set",
  stepName: string,
  deadline: string,       // Absolute deadline timestamp
  timeoutMs: number,      // Original timeout duration
  // + base fields
}
```

**UI:** Show timeout indicator on step with countdown.

---

#### `timeout.exceeded`
**When:** A step exceeds its timeout

```typescript
{
  type: "timeout.exceeded",
  stepName: string,
  timeoutMs: number,
  // + base fields
}
```

**UI:** Show step as "Timed Out" (red). This leads to step.failed.

---

## Job Events

### General Lifecycle Events

#### `job.started`
**When:** A new job instance is created

```typescript
{
  type: "job.started",
  input?: unknown,        // Initial state/input
  // + base fields (including jobType, jobName)
}
```

**UI:** Show job as "Started". Display job type badge (continuous/debounce/task).

---

#### `job.executed`
**When:** A job execution completes successfully

```typescript
{
  type: "job.executed",
  runCount: number,       // Total executions (1-indexed)
  durationMs: number,     // This execution's duration
  attempt: number,        // 1 = first attempt (no retries)
  // + base fields
}
```

**UI:** Increment run counter. Show duration. For continuous jobs, this repeats indefinitely.

---

#### `job.failed`
**When:** A job execution fails

```typescript
{
  type: "job.failed",
  error: {
    message: string,
    stack?: string,
  },
  runCount: number,
  attempt: number,
  willRetry: boolean,
  // + base fields
}
```

**UI:** If `willRetry`, show "Retrying". Otherwise, may lead to termination or exhaustion.

---

#### `job.retryExhausted`
**When:** All retry attempts exhausted for a job

```typescript
{
  type: "job.retryExhausted",
  attempts: number,
  reason: "max_attempts" | "max_duration",
  // + base fields
}
```

**UI:** Show "Retries Exhausted" error state. Job may terminate or pause depending on handler.

---

#### `job.terminated`
**When:** A job is terminated (manually or automatically)

```typescript
{
  type: "job.terminated",
  reason?: string,
  runCount: number,       // Total executions before termination
  // + base fields
}
```

**UI:** Show job as "Terminated" (gray). Display final run count.

---

### Debounce-Specific Events

#### `debounce.started`
**When:** First event received for a debounce job

```typescript
{
  type: "debounce.started",
  flushAt: string,        // When flush is scheduled
  // + base fields (jobType = "debounce")
}
```

**UI:** Show "Collecting Events" with countdown to flush.

---

#### `debounce.flushed`
**When:** Debounce job flushes (executes with collected events)

```typescript
{
  type: "debounce.flushed",
  eventCount: number,     // Number of events in batch
  reason: "timeout" | "maxEvents" | "manual",
  durationMs: number,
  // + base fields
}
```

**UI:** Show "Flushed" with event count and reason. Great for analytics charts.

---

### Task-Specific Events

#### `task.scheduled`
**When:** A task execution is scheduled

```typescript
{
  type: "task.scheduled",
  scheduledAt: string,    // When execution will run
  trigger: "event" | "execute" | "idle" | "error",
  // + base fields (jobType = "task")
}
```

**UI:** Show "Scheduled" with countdown. Display trigger type.

---

## Event Flow Diagrams

### Successful Workflow Execution

```
workflow.started
    │
    ├── step.started (step1, attempt=1)
    │   └── step.completed (step1, cached=false)
    │
    ├── step.started (step2, attempt=1)
    │   └── step.completed (step2, cached=false)
    │
    └── workflow.completed (durationMs=1234)
```

### Workflow with Retry

```
workflow.started
    │
    ├── step.started (paymentStep, attempt=1)
    │   ├── step.failed (willRetry=true)
    │   └── retry.scheduled (nextAttemptAt=...)
    │
    ├── workflow.paused (reason=retry)
    │
    ├── workflow.resumed
    │
    ├── step.started (paymentStep, attempt=2)
    │   └── step.completed
    │
    └── workflow.completed
```

### Workflow with Sleep

```
workflow.started
    │
    ├── step.started (processOrder)
    │   └── step.completed
    │
    ├── sleep.started (durationMs=3600000, resumeAt=...)
    │
    ├── workflow.paused (reason=sleep)
    │
    ├── workflow.resumed
    │
    ├── sleep.completed
    │
    ├── step.started (sendConfirmation)
    │   └── step.completed
    │
    └── workflow.completed
```

### Continuous Job Lifecycle

```
job.started (jobType=continuous)
    │
    ├── job.executed (runCount=1)
    │   ... (waits for schedule)
    ├── job.executed (runCount=2)
    │   ... (waits for schedule)
    ├── job.executed (runCount=3)
    │
    └── job.terminated (runCount=3, reason="manual")
```

### Debounce Job Flow

```
debounce.started (flushAt=...)
    │
    │   ... (events accumulate)
    │
    ├── debounce.flushed (eventCount=5, reason=timeout)
    │
    └── job.executed (runCount=1)
```

---

## UI Design Recommendations

### 1. Workflow List View

**Columns:**
- Workflow Name
- Instance ID (truncated)
- Status (Running/Paused/Completed/Failed/Cancelled)
- Progress (e.g., "3/5 steps")
- Duration
- Started At

**Status Colors:**
- Running: Blue (animated)
- Paused: Orange
- Completed: Green
- Failed: Red
- Cancelled: Gray

### 2. Workflow Detail View

**Timeline/Gantt Chart:**
- Horizontal timeline showing step executions
- Color-coded by status
- Hover shows duration and attempt number
- Retry attempts shown as stacked bars

**Step List:**
- Collapsible step details
- Show error messages inline
- Cache badge for replayed steps

**Pause Indicators:**
- Visual break in timeline for sleep
- Countdown for scheduled resume

### 3. Job Dashboard

**Continuous Jobs:**
- Run counter (total executions)
- Last execution time
- Average duration chart
- Error rate metric

**Debounce Jobs:**
- Events/flush histogram
- Average batch size
- Flush reason breakdown (timeout vs maxEvents)

**Task Jobs:**
- Schedule visualization
- Next execution countdown
- Trigger type distribution

### 4. Real-Time Updates

Use WebSocket or SSE for live updates:
- Workflow status changes
- Step progress
- Countdown timers for pauses/sleeps

### 5. Error Analysis

**Error Aggregation:**
- Group by error message
- Show affected workflows/jobs
- Display stack traces in modal

**Retry Analysis:**
- Retry success rate
- Average attempts before success
- Backoff delay distribution

---

## Database Schema Recommendations

### Events Table

```sql
CREATE TABLE tracking_events (
  event_id UUID PRIMARY KEY,        -- UUIDv7 from eventId
  timestamp TIMESTAMPTZ NOT NULL,
  source VARCHAR(10) NOT NULL,      -- 'workflow' or 'job'
  type VARCHAR(50) NOT NULL,
  env VARCHAR(50) NOT NULL,
  service_key VARCHAR(100) NOT NULL,

  -- Workflow fields (null for jobs)
  workflow_id VARCHAR(100),
  workflow_name VARCHAR(100),
  execution_id VARCHAR(100),

  -- Job fields (null for workflows)
  instance_id VARCHAR(100),
  job_type VARCHAR(20),
  job_name VARCHAR(100),

  -- Event-specific payload
  payload JSONB NOT NULL,

  -- Indexes
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX idx_events_workflow ON tracking_events(workflow_id, timestamp DESC);
CREATE INDEX idx_events_job ON tracking_events(instance_id, timestamp DESC);
CREATE INDEX idx_events_type ON tracking_events(type, timestamp DESC);
CREATE INDEX idx_events_env ON tracking_events(env, service_key, timestamp DESC);
```

### Workflow Runs Table (Materialized)

```sql
CREATE TABLE workflow_runs (
  workflow_id VARCHAR(100) PRIMARY KEY,
  workflow_name VARCHAR(100) NOT NULL,
  execution_id VARCHAR(100),
  env VARCHAR(50) NOT NULL,
  service_key VARCHAR(100) NOT NULL,

  status VARCHAR(20) NOT NULL,      -- running/paused/completed/failed/cancelled
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  duration_ms INTEGER,

  completed_steps TEXT[],
  error_message TEXT,

  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Job Runs Table (Materialized)

```sql
CREATE TABLE job_instances (
  instance_id VARCHAR(100) PRIMARY KEY,
  job_type VARCHAR(20) NOT NULL,
  job_name VARCHAR(100) NOT NULL,
  env VARCHAR(50) NOT NULL,
  service_key VARCHAR(100) NOT NULL,

  status VARCHAR(20) NOT NULL,      -- running/terminated
  run_count INTEGER DEFAULT 0,
  last_execution_at TIMESTAMPTZ,
  last_duration_ms INTEGER,

  created_at TIMESTAMPTZ,
  terminated_at TIMESTAMPTZ,

  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## TypeScript Schema Import

For validation in your tracking service:

```typescript
import {
  // Combined schema (validates both workflow and job events)
  TrackingEventSchema,
  type TrackingEvent,

  // Individual schemas if you need to route separately
  WorkflowEventSchema,
  JobEventSchema,

  // Type helpers
  type WorkflowEvent,
  type JobEvent,
} from "@durable-effect/core";

// Validate incoming batch
const result = Schema.decodeUnknown(
  Schema.Array(TrackingEventSchema)
)(body.events);
```

---

## Summary

| Event Type | Source | When Emitted | Key Data |
|------------|--------|--------------|----------|
| `workflow.started` | workflow | Sync execution begins | input |
| `workflow.queued` | workflow | Async execution queued | input |
| `workflow.resumed` | workflow | After pause ends | - |
| `workflow.paused` | workflow | Sleep or retry wait | reason, resumeAt |
| `workflow.completed` | workflow | Success | completedSteps, durationMs |
| `workflow.failed` | workflow | Permanent failure | error, completedSteps |
| `workflow.cancelled` | workflow | Manual cancel | reason |
| `step.started` | workflow | Step begins | stepName, attempt |
| `step.completed` | workflow | Step succeeds | stepName, durationMs, cached |
| `step.failed` | workflow | Step fails | stepName, error, willRetry |
| `retry.scheduled` | workflow | Retry queued | stepName, nextAttemptAt, delayMs |
| `retry.exhausted` | workflow | No more retries | stepName, attempts |
| `sleep.started` | workflow | Sleep begins | durationMs, resumeAt |
| `sleep.completed` | workflow | Sleep ends | durationMs |
| `timeout.set` | workflow | Timeout configured | stepName, deadline |
| `timeout.exceeded` | workflow | Timeout fired | stepName, timeoutMs |
| `job.started` | job | Job instance created | input, jobType |
| `job.executed` | job | Execution succeeds | runCount, durationMs, attempt |
| `job.failed` | job | Execution fails | error, willRetry |
| `job.retryExhausted` | job | Retries exhausted | attempts, reason |
| `job.terminated` | job | Job ends | reason, runCount |
| `debounce.started` | job | First event received | flushAt |
| `debounce.flushed` | job | Batch executes | eventCount, reason, durationMs |
| `task.scheduled` | job | Execution scheduled | scheduledAt, trigger |
