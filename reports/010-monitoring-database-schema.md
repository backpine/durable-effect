# Workflow Monitoring Database Schema

## Overview

This document proposes PostgreSQL table schemas for a workflow monitoring tool powered by the event tracker service. The schema is designed to:

1. **Efficiently query workflow state** - Denormalized tables for fast reads
2. **Preserve full event history** - Append-only event log for audit/replay
3. **Support rich monitoring features** - Step details, retries, errors, outputs
4. **Enable future interventions** - Schema prepared for manual workflow control
5. **Multi-environment support** - Filter by environment (production, staging, etc.)
6. **Multi-service support** - Aggregate workflows across services

## Event Schema

All events from the tracker include these base fields:

```typescript
interface BaseEventFields {
  eventId: string;      // Unique event ID for deduplication
  timestamp: string;    // ISO timestamp when event occurred
  env: string;          // Environment (e.g., "production", "staging")
  serviceKey: string;   // User-defined service identifier
  workflowId: string;   // Durable Object ID
  workflowName: string; // Workflow definition name
}
```

The `env` and `serviceKey` fields are configured at the tracker level and automatically enriched into all events before transmission.

## Event Flow

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ Durable Object  │────▶│  Event Tracker   │────▶│   PostgreSQL    │
│   (Workflow)    │     │  (HTTP Batch)    │     │   (Monitoring)  │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                               │                         │
                     env + serviceKey                    ▼
                       enrichment              ┌───────────────┐
                                               │  Monitoring   │
                                               │      UI       │
                                               └───────────────┘
```

## Table Schemas

### 1. `workflows` - Current Workflow State

Denormalized view of workflow state for fast queries. Updated by event processor.

```sql
CREATE TYPE workflow_status AS ENUM (
  'pending',
  'running',
  'paused',
  'completed',
  'failed'
);

CREATE TYPE pause_reason AS ENUM (
  'sleep',
  'retry'
);

CREATE TABLE workflows (
  -- Identity
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id           TEXT NOT NULL,             -- Durable Object ID
  workflow_name         TEXT NOT NULL,             -- Definition name (e.g., 'processOrder')

  -- Environment & Service (from event enrichment)
  env                   TEXT NOT NULL,             -- Environment (e.g., 'production', 'staging')
  service_key           TEXT NOT NULL,             -- Service identifier (e.g., 'order-service')

  -- Input/Output
  input                 JSONB,                     -- Workflow input (from workflow.started)

  -- Current State
  status                workflow_status NOT NULL DEFAULT 'pending',
  pause_reason          pause_reason,              -- Set when status = 'paused'
  resume_at             TIMESTAMPTZ,               -- When paused workflow will resume
  current_step          TEXT,                      -- Currently executing step name

  -- Progress
  completed_steps       TEXT[] NOT NULL DEFAULT '{}',
  total_steps_executed  INTEGER NOT NULL DEFAULT 0,

  -- Error Info (when status = 'failed')
  error_message         TEXT,
  error_stack           TEXT,
  error_step_name       TEXT,                      -- Step that caused failure
  error_attempt         INTEGER,                   -- Attempt number when failed

  -- Timing
  started_at            TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  failed_at             TIMESTAMPTZ,
  duration_ms           INTEGER,                   -- Total execution time

  -- Metadata
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_event_id         UUID,                      -- Last processed event (idempotency)
  last_event_at         TIMESTAMPTZ,               -- Last event timestamp

  -- Unique constraint includes env to support same workflow ID across environments
  UNIQUE(env, service_key, workflow_id)
);

-- Indexes for common queries
CREATE INDEX idx_workflows_env ON workflows(env);
CREATE INDEX idx_workflows_service_key ON workflows(service_key);
CREATE INDEX idx_workflows_env_service ON workflows(env, service_key);
CREATE INDEX idx_workflows_status ON workflows(status);
CREATE INDEX idx_workflows_name ON workflows(workflow_name);
CREATE INDEX idx_workflows_started_at ON workflows(started_at DESC);
CREATE INDEX idx_workflows_env_status ON workflows(env, status);
CREATE INDEX idx_workflows_service_status ON workflows(service_key, status);
CREATE INDEX idx_workflows_env_service_status ON workflows(env, service_key, status);
CREATE INDEX idx_workflows_status_name ON workflows(status, workflow_name);
CREATE INDEX idx_workflows_failed ON workflows(failed_at DESC) WHERE status = 'failed';
CREATE INDEX idx_workflows_running ON workflows(started_at DESC) WHERE status IN ('running', 'paused');
```

### 2. `workflow_steps` - Step Execution State

Tracks each step's current state and execution history summary.

```sql
CREATE TYPE step_status AS ENUM (
  'pending',
  'running',
  'completed',
  'failed',
  'retrying'
);

CREATE TABLE workflow_steps (
  -- Identity
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id           TEXT NOT NULL,
  env                   TEXT NOT NULL,
  service_key           TEXT NOT NULL,
  step_name             TEXT NOT NULL,

  -- Current State
  status                step_status NOT NULL DEFAULT 'pending',
  current_attempt       INTEGER NOT NULL DEFAULT 0,
  max_attempts          INTEGER,               -- If retry configured

  -- Result (when completed)
  result                JSONB,                 -- Step output (if captured)
  cached                BOOLEAN DEFAULT FALSE, -- Was result from cache

  -- Error Info (when failed/retrying)
  error_message         TEXT,
  error_stack           TEXT,
  will_retry            BOOLEAN,

  -- Retry Info
  retry_count           INTEGER NOT NULL DEFAULT 0,
  next_retry_at         TIMESTAMPTZ,
  last_retry_delay_ms   INTEGER,

  -- Timeout Info
  timeout_ms            INTEGER,
  timeout_deadline      TIMESTAMPTZ,
  timed_out             BOOLEAN DEFAULT FALSE,

  -- Timing
  started_at            TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  duration_ms           INTEGER,
  total_duration_ms     INTEGER,               -- Including retries

  -- Metadata
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  execution_order       INTEGER,               -- Order within workflow

  UNIQUE(env, service_key, workflow_id, step_name),
  FOREIGN KEY (env, service_key, workflow_id)
    REFERENCES workflows(env, service_key, workflow_id) ON DELETE CASCADE
);

-- Indexes
CREATE INDEX idx_steps_workflow ON workflow_steps(env, service_key, workflow_id);
CREATE INDEX idx_steps_status ON workflow_steps(status);
CREATE INDEX idx_steps_retrying ON workflow_steps(next_retry_at) WHERE status = 'retrying';
CREATE INDEX idx_steps_env_service ON workflow_steps(env, service_key);
```

### 3. `step_attempts` - Individual Step Attempt History

Records each attempt for a step (useful for retry analysis).

```sql
CREATE TYPE attempt_result AS ENUM (
  'success',
  'failure',
  'timeout'
);

CREATE TABLE step_attempts (
  -- Identity
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id           TEXT NOT NULL,
  env                   TEXT NOT NULL,
  service_key           TEXT NOT NULL,
  step_name             TEXT NOT NULL,
  attempt_number        INTEGER NOT NULL,

  -- Result
  result                attempt_result NOT NULL,
  error_message         TEXT,
  error_stack           TEXT,

  -- Timing
  started_at            TIMESTAMPTZ NOT NULL,
  ended_at              TIMESTAMPTZ,
  duration_ms           INTEGER,

  -- Retry scheduling (if failure led to retry)
  retry_scheduled       BOOLEAN DEFAULT FALSE,
  retry_delay_ms        INTEGER,
  next_attempt_at       TIMESTAMPTZ,

  -- Event reference
  start_event_id        UUID,
  end_event_id          UUID,

  UNIQUE(env, service_key, workflow_id, step_name, attempt_number),
  FOREIGN KEY (env, service_key, workflow_id, step_name)
    REFERENCES workflow_steps(env, service_key, workflow_id, step_name) ON DELETE CASCADE
);

-- Indexes
CREATE INDEX idx_attempts_workflow_step ON step_attempts(env, service_key, workflow_id, step_name);
CREATE INDEX idx_attempts_result ON step_attempts(result);
CREATE INDEX idx_attempts_env_service ON step_attempts(env, service_key);
```

### 4. `workflow_events` - Raw Event Log

Append-only log of all events for audit, replay, and debugging.

```sql
CREATE TABLE workflow_events (
  -- Identity (from event)
  id                    UUID PRIMARY KEY,      -- event_id from tracker

  -- Event metadata
  event_type            TEXT NOT NULL,         -- e.g., 'workflow.started', 'step.completed'
  workflow_id           TEXT NOT NULL,
  workflow_name         TEXT NOT NULL,

  -- Environment & Service (from event enrichment)
  env                   TEXT NOT NULL,
  service_key           TEXT NOT NULL,

  -- Event timestamp (from event, not insertion time)
  event_timestamp       TIMESTAMPTZ NOT NULL,

  -- Full event payload
  payload               JSONB NOT NULL,

  -- Processing metadata
  received_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed             BOOLEAN NOT NULL DEFAULT FALSE,
  processed_at          TIMESTAMPTZ,
  processing_error      TEXT
);

-- Indexes for event processing and queries
CREATE INDEX idx_events_env ON workflow_events(env);
CREATE INDEX idx_events_service_key ON workflow_events(service_key);
CREATE INDEX idx_events_env_service ON workflow_events(env, service_key);
CREATE INDEX idx_events_workflow ON workflow_events(env, service_key, workflow_id, event_timestamp);
CREATE INDEX idx_events_type ON workflow_events(event_type);
CREATE INDEX idx_events_env_type ON workflow_events(env, event_type);
CREATE INDEX idx_events_unprocessed ON workflow_events(received_at) WHERE NOT processed;
CREATE INDEX idx_events_timestamp ON workflow_events(event_timestamp DESC);

-- Partition by month for large deployments (optional)
-- CREATE TABLE workflow_events (...) PARTITION BY RANGE (event_timestamp);
```

### 5. `workflow_sleeps` - Sleep Tracking

Tracks active and completed sleeps for timeline visualization.

```sql
CREATE TABLE workflow_sleeps (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id           TEXT NOT NULL,
  env                   TEXT NOT NULL,
  service_key           TEXT NOT NULL,

  -- Sleep details
  duration_ms           INTEGER NOT NULL,
  started_at            TIMESTAMPTZ NOT NULL,
  resume_at             TIMESTAMPTZ NOT NULL,
  completed_at          TIMESTAMPTZ,

  -- Status
  completed             BOOLEAN NOT NULL DEFAULT FALSE,

  -- Event references
  start_event_id        UUID,
  complete_event_id     UUID,

  FOREIGN KEY (env, service_key, workflow_id)
    REFERENCES workflows(env, service_key, workflow_id) ON DELETE CASCADE
);

CREATE INDEX idx_sleeps_workflow ON workflow_sleeps(env, service_key, workflow_id);
CREATE INDEX idx_sleeps_active ON workflow_sleeps(resume_at) WHERE NOT completed;
CREATE INDEX idx_sleeps_env_service ON workflow_sleeps(env, service_key);
```

### 6. `services` - Service Registry (Optional)

Track registered services for the dashboard.

```sql
CREATE TABLE services (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_key           TEXT NOT NULL UNIQUE,
  display_name          TEXT,
  description           TEXT,

  -- Environments this service runs in
  environments          TEXT[] NOT NULL DEFAULT '{}',

  -- Metadata
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_event_at         TIMESTAMPTZ
);

-- Auto-populated from events
CREATE OR REPLACE FUNCTION update_services_from_event()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO services (service_key, environments, last_event_at)
  VALUES (NEW.service_key, ARRAY[NEW.env], NEW.event_timestamp)
  ON CONFLICT (service_key) DO UPDATE SET
    environments = CASE
      WHEN NEW.env = ANY(services.environments) THEN services.environments
      ELSE array_append(services.environments, NEW.env)
    END,
    last_event_at = GREATEST(services.last_event_at, NEW.event_timestamp),
    updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_update_services
AFTER INSERT ON workflow_events
FOR EACH ROW EXECUTE FUNCTION update_services_from_event();
```

## Event Processing Logic

### Event Handler Mapping

| Event Type | Tables Updated | Logic |
|------------|---------------|-------|
| `workflow.started` | `workflows` | Insert/update with status='running', set input, started_at, env, service_key |
| `workflow.completed` | `workflows` | Set status='completed', completed_at, duration_ms |
| `workflow.failed` | `workflows` | Set status='failed', error fields, failed_at |
| `workflow.paused` | `workflows` | Set status='paused', pause_reason, resume_at |
| `workflow.resumed` | `workflows` | Set status='running', clear pause fields |
| `step.started` | `workflow_steps`, `step_attempts` | Upsert step with status='running', insert attempt |
| `step.completed` | `workflow_steps`, `step_attempts` | Set status='completed', update attempt |
| `step.failed` | `workflow_steps`, `step_attempts` | Set status='failed'/'retrying', update attempt |
| `retry.scheduled` | `workflow_steps` | Update retry fields, next_retry_at |
| `retry.exhausted` | `workflow_steps` | Set max_attempts reached |
| `sleep.started` | `workflow_sleeps` | Insert sleep record |
| `sleep.completed` | `workflow_sleeps` | Mark completed |
| `timeout.set` | `workflow_steps` | Set timeout_ms, timeout_deadline |
| `timeout.exceeded` | `workflow_steps` | Set timed_out=true |

### Idempotency

Events are processed idempotently using `event_id`:

```sql
-- Check if event already processed
INSERT INTO workflow_events (id, event_type, workflow_id, workflow_name, env, service_key, event_timestamp, payload)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (id) DO NOTHING
RETURNING id;

-- Only process if insert succeeded (new event)
```

## Access Patterns & UI Features

### 1. Environment & Service Selector

**Query: Get available environments and services**

```sql
-- Get all environments with workflow counts
SELECT
  env,
  COUNT(*) as total_workflows,
  COUNT(*) FILTER (WHERE status = 'running') as running,
  COUNT(*) FILTER (WHERE status = 'failed') as failed
FROM workflows
WHERE started_at >= NOW() - INTERVAL '24 hours'
GROUP BY env
ORDER BY env;

-- Get all services with workflow counts per environment
SELECT
  service_key,
  env,
  COUNT(*) as total_workflows,
  COUNT(*) FILTER (WHERE status = 'failed') as failed
FROM workflows
WHERE started_at >= NOW() - INTERVAL '24 hours'
GROUP BY service_key, env
ORDER BY service_key, env;
```

**UI Features:**
- Environment dropdown (production, staging, development)
- Service filter (multi-select)
- Environment-specific color coding
- Cross-environment comparison view

### 2. Workflow List View

**Query: List all workflows with filtering**

```sql
SELECT
  workflow_id,
  workflow_name,
  env,
  service_key,
  status,
  started_at,
  completed_at,
  failed_at,
  duration_ms,
  array_length(completed_steps, 1) as steps_completed,
  error_message
FROM workflows
WHERE
  ($1::text IS NULL OR env = $1)
  AND ($2::text IS NULL OR service_key = $2)
  AND ($3::workflow_status IS NULL OR status = $3)
  AND ($4::text IS NULL OR workflow_name = $4)
  AND ($5::timestamptz IS NULL OR started_at >= $5)
ORDER BY started_at DESC
LIMIT $6 OFFSET $7;
```

**UI Features:**
- Filter by environment (required for most views)
- Filter by service
- Filter by status (Running, Paused, Completed, Failed)
- Filter by workflow type
- Date range filter
- Search by workflow ID
- Environment badge on each row
- Sortable columns
- Pagination

### 3. Workflow Detail View

**Query: Get workflow with all steps**

```sql
-- Workflow details
SELECT * FROM workflows
WHERE env = $1 AND service_key = $2 AND workflow_id = $3;

-- All steps with attempt counts
SELECT
  ws.*,
  (SELECT COUNT(*) FROM step_attempts sa
   WHERE sa.env = ws.env
     AND sa.service_key = ws.service_key
     AND sa.workflow_id = ws.workflow_id
     AND sa.step_name = ws.step_name) as attempt_count
FROM workflow_steps ws
WHERE ws.env = $1 AND ws.service_key = $2 AND ws.workflow_id = $3
ORDER BY ws.execution_order, ws.created_at;

-- Active/recent sleeps
SELECT * FROM workflow_sleeps
WHERE env = $1 AND service_key = $2 AND workflow_id = $3
ORDER BY started_at DESC;
```

**UI Features:**
- Environment and service badges
- Workflow status badge
- Input JSON viewer
- Step list with status indicators
- Progress visualization
- Error display with stack trace
- Timeline view
- Duration breakdown

### 4. Step Detail View

**Query: Get step with all attempts**

```sql
-- Step details
SELECT * FROM workflow_steps
WHERE env = $1 AND service_key = $2 AND workflow_id = $3 AND step_name = $4;

-- All attempts for this step
SELECT * FROM step_attempts
WHERE env = $1 AND service_key = $2 AND workflow_id = $3 AND step_name = $4
ORDER BY attempt_number;
```

**UI Features:**
- Attempt history table
- Error messages per attempt
- Duration per attempt
- Retry timing visualization
- Timeout indicator

### 5. Failed Workflows Dashboard

**Query: Recent failures with error summary**

```sql
SELECT
  workflow_id,
  workflow_name,
  env,
  service_key,
  error_message,
  error_step_name,
  failed_at,
  completed_steps
FROM workflows
WHERE status = 'failed'
  AND ($1::text IS NULL OR env = $1)
  AND ($2::text IS NULL OR service_key = $2)
ORDER BY failed_at DESC
LIMIT 50;

-- Error frequency by workflow type and environment
SELECT
  env,
  service_key,
  workflow_name,
  COUNT(*) as failure_count,
  COUNT(DISTINCT error_message) as unique_errors
FROM workflows
WHERE status = 'failed'
  AND failed_at >= NOW() - INTERVAL '24 hours'
GROUP BY env, service_key, workflow_name
ORDER BY failure_count DESC;
```

**UI Features:**
- Failed workflow list grouped by environment
- Error message grouping
- Failure rate charts by environment
- Cross-environment failure comparison
- Drill-down to workflow detail

### 6. Active Workflows Monitor

**Query: Currently running/paused workflows**

```sql
SELECT
  w.*,
  CASE
    WHEN w.status = 'paused' AND w.resume_at <= NOW() THEN 'overdue'
    WHEN w.status = 'paused' THEN 'scheduled'
    ELSE 'active'
  END as activity_state
FROM workflows w
WHERE w.status IN ('running', 'paused')
  AND ($1::text IS NULL OR w.env = $1)
  AND ($2::text IS NULL OR w.service_key = $2)
ORDER BY
  w.env,
  CASE w.status WHEN 'running' THEN 0 ELSE 1 END,
  w.started_at DESC;
```

**UI Features:**
- Real-time status updates
- Grouped by environment
- Paused workflow countdown
- Step progress indicator
- Queue depth metrics per environment

### 7. Workflow Timeline

**Query: Event timeline for a workflow**

```sql
SELECT
  event_type,
  event_timestamp,
  env,
  service_key,
  payload->>'stepName' as step_name,
  payload->>'attempt' as attempt,
  payload->>'durationMs' as duration_ms,
  payload->'error'->>'message' as error_message
FROM workflow_events
WHERE env = $1 AND service_key = $2 AND workflow_id = $3
ORDER BY event_timestamp;
```

**UI Features:**
- Visual timeline of events
- Step execution bars
- Retry/sleep gaps visualized
- Error markers

### 8. Metrics & Analytics

**Query: Workflow statistics by environment and service**

```sql
-- Completion rate by workflow type per environment (last 24h)
SELECT
  env,
  service_key,
  workflow_name,
  COUNT(*) FILTER (WHERE status = 'completed') as completed,
  COUNT(*) FILTER (WHERE status = 'failed') as failed,
  COUNT(*) FILTER (WHERE status IN ('running', 'paused')) as in_progress,
  AVG(duration_ms) FILTER (WHERE status = 'completed') as avg_duration_ms,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms)
    FILTER (WHERE status = 'completed') as p95_duration_ms
FROM workflows
WHERE started_at >= NOW() - INTERVAL '24 hours'
GROUP BY env, service_key, workflow_name
ORDER BY env, service_key, workflow_name;

-- Step retry rates by environment
SELECT
  w.env,
  w.service_key,
  w.workflow_name,
  ws.step_name,
  AVG(ws.retry_count) as avg_retries,
  MAX(ws.retry_count) as max_retries,
  COUNT(*) FILTER (WHERE ws.retry_count > 0) as workflows_with_retries
FROM workflow_steps ws
JOIN workflows w ON ws.env = w.env
  AND ws.service_key = w.service_key
  AND ws.workflow_id = w.workflow_id
WHERE w.started_at >= NOW() - INTERVAL '24 hours'
GROUP BY w.env, w.service_key, w.workflow_name, ws.step_name
HAVING AVG(ws.retry_count) > 0
ORDER BY avg_retries DESC;

-- Cross-environment comparison
SELECT
  workflow_name,
  env,
  COUNT(*) as total,
  COUNT(*) FILTER (WHERE status = 'completed') as completed,
  COUNT(*) FILTER (WHERE status = 'failed') as failed,
  ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'completed') / COUNT(*), 2) as success_rate
FROM workflows
WHERE started_at >= NOW() - INTERVAL '24 hours'
GROUP BY workflow_name, env
ORDER BY workflow_name, env;
```

**UI Features:**
- Success/failure rate charts by environment
- Duration histograms with environment comparison
- Retry frequency analysis per service
- Step performance comparison across environments
- Environment health scorecards

### 9. Service Overview Dashboard

**Query: Service health summary**

```sql
SELECT
  s.service_key,
  s.display_name,
  s.environments,
  jsonb_object_agg(
    w.env,
    jsonb_build_object(
      'total', COUNT(*),
      'completed', COUNT(*) FILTER (WHERE w.status = 'completed'),
      'failed', COUNT(*) FILTER (WHERE w.status = 'failed'),
      'running', COUNT(*) FILTER (WHERE w.status IN ('running', 'paused'))
    )
  ) as stats_by_env
FROM services s
LEFT JOIN workflows w ON s.service_key = w.service_key
  AND w.started_at >= NOW() - INTERVAL '24 hours'
GROUP BY s.service_key, s.display_name, s.environments
ORDER BY s.service_key;
```

**UI Features:**
- Service cards with environment breakdown
- Health indicators per environment
- Quick links to filtered workflow views
- Service-level alerts configuration

## Future: Manual Interventions

The schema is prepared for future intervention features:

### Planned Tables

```sql
-- Track manual interventions
CREATE TABLE workflow_interventions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id           TEXT NOT NULL,
  env                   TEXT NOT NULL,
  service_key           TEXT NOT NULL,

  intervention_type     TEXT NOT NULL,  -- 'retry', 'cancel', 'resume', 'skip_step'
  target_step           TEXT,           -- For step-specific interventions

  requested_by          TEXT NOT NULL,  -- User ID
  requested_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Execution
  executed              BOOLEAN NOT NULL DEFAULT FALSE,
  executed_at           TIMESTAMPTZ,
  execution_result      TEXT,
  execution_error       TEXT,

  FOREIGN KEY (env, service_key, workflow_id)
    REFERENCES workflows(env, service_key, workflow_id)
);

CREATE INDEX idx_interventions_workflow ON workflow_interventions(env, service_key, workflow_id);
CREATE INDEX idx_interventions_pending ON workflow_interventions(requested_at) WHERE NOT executed;
```

### Planned Intervention Types

| Type | Description | Implementation |
|------|-------------|----------------|
| `retry` | Retry a failed workflow from last checkpoint | Reset status, trigger alarm |
| `cancel` | Cancel a running/paused workflow | Set status='cancelled' |
| `resume` | Force resume a paused workflow | Trigger alarm immediately |
| `skip_step` | Skip a failed step and continue | Mark step completed, resume |

## Implementation Notes

### Event Processor Service

The event processor should:

1. Receive batched events from tracker
2. Insert events into `workflow_events` (idempotent)
3. Process unprocessed events in order
4. Update denormalized tables
5. Mark events as processed

```typescript
async function processEvents(events: WorkflowEvent[]) {
  for (const event of events) {
    await db.transaction(async (tx) => {
      // Insert event (idempotent)
      const inserted = await tx.insert(workflowEvents)
        .values({
          id: event.eventId,
          eventType: event.type,
          workflowId: event.workflowId,
          workflowName: event.workflowName,
          env: event.env,           // From tracker enrichment
          serviceKey: event.serviceKey, // From tracker enrichment
          eventTimestamp: event.timestamp,
          payload: event,
        })
        .onConflictDoNothing()
        .returning();

      if (inserted.length === 0) return; // Already processed

      // Update denormalized tables based on event type
      switch (event.type) {
        case 'workflow.started':
          await upsertWorkflow(tx, event);
          break;
        case 'step.completed':
          await updateStep(tx, event);
          break;
        // ... etc
      }

      // Mark processed
      await tx.update(workflowEvents)
        .set({ processed: true, processed_at: new Date() })
        .where(eq(workflowEvents.id, event.eventId));
    });
  }
}
```

### Scaling Considerations

1. **Partitioning**: Partition `workflow_events` by month for large deployments
2. **Sharding**: Consider sharding by `env` or `service_key` for very large deployments
3. **Archival**: Move old completed workflows to archive tables
4. **Indexes**: Add composite indexes based on actual query patterns
5. **Caching**: Cache frequently-accessed workflow details in Redis
6. **Read replicas**: Use read replicas for dashboard queries

### Multi-Tenancy Considerations

If supporting multiple organizations:

```sql
ALTER TABLE workflows ADD COLUMN org_id UUID NOT NULL;
ALTER TABLE workflow_events ADD COLUMN org_id UUID NOT NULL;
-- Add org_id to all composite keys and indexes
```

## Summary

This schema provides:

- **Fast queries** via denormalized `workflows` and `workflow_steps` tables
- **Full history** via append-only `workflow_events` and `step_attempts`
- **Rich monitoring** with support for timeline, retry analysis, error tracking
- **Multi-environment support** with `env` field on all tables
- **Multi-service support** with `service_key` field for cross-service aggregation
- **Future-ready** schema prepared for manual interventions

The design prioritizes read performance for the monitoring UI while maintaining data integrity through the event log. The `env` and `serviceKey` dimensions enable:

- Environment-specific dashboards (production vs staging)
- Cross-environment comparison (is production slower than staging?)
- Service-level health monitoring
- Scoped access control (only view production if authorized)
