# External Tracking Service Integration

## Overview

This document proposes a design for an optional external tracking service integration that allows `@durable-effect/workflow` to push workflow state to an external service. This enables:

1. **Real-time visibility** - View workflow instances, their status, and progress
2. **Failure tracking** - See failed workflows, error details, and retry history
3. **Manual intervention** - Pause, resume, cancel, or retry workflows from an external dashboard

The tracking service is **opt-in** - users who don't configure it get zero overhead.

---

## Design Goals

| Goal | Description |
|------|-------------|
| **Optional** | No tracking = no overhead. The package works identically without it. |
| **Pluggable** | Users provide a `TrackerService` implementation for their backend. |
| **Push-based** | Workflow pushes events to tracker (no polling from tracker). |
| **Bidirectional** | Tracker can send commands back to influence workflow execution. |
| **Non-blocking** | Tracking failures should not fail the workflow. |
| **Type-safe** | Full TypeScript types for events and commands. |

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Cloudflare Worker                            │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                    DurableWorkflowEngine                      │  │
│  │                                                               │  │
│  │  ┌─────────────┐    Events    ┌──────────────────────────┐   │  │
│  │  │  Workflow   │ ──────────▶  │   TrackerService         │   │  │
│  │  │  Execution  │              │   (user-provided impl)   │   │  │
│  │  │             │ ◀──────────  │                          │   │  │
│  │  └─────────────┘   Commands   └──────────┬───────────────┘   │  │
│  │                                          │                   │  │
│  └──────────────────────────────────────────│───────────────────┘  │
│                                             │                      │
└─────────────────────────────────────────────│──────────────────────┘
                                              │
                                              │ HTTP/WebSocket/Queue
                                              ▼
                              ┌───────────────────────────────┐
                              │    External Tracking Service   │
                              │    (user's infrastructure)     │
                              │                               │
                              │  - Dashboard UI               │
                              │  - Database                   │
                              │  - Alerting                   │
                              └───────────────────────────────┘
```

---

## Event Model (Workflow → Tracker)

The workflow emits events at key lifecycle points. All events are **fire-and-forget** with optional retry.

### Event Types

```typescript
/**
 * Base event shape - all events include these fields.
 */
interface BaseEvent {
  /** Unique event ID for deduplication */
  eventId: string;
  /** ISO timestamp when event occurred */
  timestamp: string;
  /** Durable Object ID */
  workflowId: string;
  /** Workflow definition name (e.g., "processOrder") */
  workflowName: string;
}

/**
 * All possible workflow events.
 */
type WorkflowEvent =
  | WorkflowStartedEvent
  | WorkflowCompletedEvent
  | WorkflowFailedEvent
  | WorkflowPausedEvent
  | WorkflowResumedEvent
  | WorkflowCancelledEvent
  | StepStartedEvent
  | StepCompletedEvent
  | StepFailedEvent
  | StepRetryScheduledEvent;

/**
 * Workflow started execution.
 */
interface WorkflowStartedEvent extends BaseEvent {
  type: "workflow.started";
  input: unknown;
}

/**
 * Workflow completed successfully.
 */
interface WorkflowCompletedEvent extends BaseEvent {
  type: "workflow.completed";
  result?: unknown;
  completedSteps: string[];
  durationMs: number;
}

/**
 * Workflow failed permanently (retries exhausted or unhandled error).
 */
interface WorkflowFailedEvent extends BaseEvent {
  type: "workflow.failed";
  error: {
    message: string;
    stack?: string;
    stepName?: string;
    attempt?: number;
  };
  completedSteps: string[];
}

/**
 * Workflow paused (waiting for sleep, retry, or external signal).
 */
interface WorkflowPausedEvent extends BaseEvent {
  type: "workflow.paused";
  reason: "sleep" | "retry" | "manual";
  resumeAt?: string; // ISO timestamp
  stepName?: string;
}

/**
 * Workflow resumed from pause.
 */
interface WorkflowResumedEvent extends BaseEvent {
  type: "workflow.resumed";
  resumedFrom: "alarm" | "manual";
}

/**
 * Workflow was cancelled.
 */
interface WorkflowCancelledEvent extends BaseEvent {
  type: "workflow.cancelled";
  reason?: string;
  cancelledBy?: string;
}

/**
 * Step started execution.
 */
interface StepStartedEvent extends BaseEvent {
  type: "step.started";
  stepName: string;
  attempt: number;
}

/**
 * Step completed successfully.
 */
interface StepCompletedEvent extends BaseEvent {
  type: "step.completed";
  stepName: string;
  attempt: number;
  durationMs: number;
  cached: boolean; // true if result was from cache
}

/**
 * Step failed (may retry).
 */
interface StepFailedEvent extends BaseEvent {
  type: "step.failed";
  stepName: string;
  attempt: number;
  error: {
    message: string;
    stack?: string;
  };
  willRetry: boolean;
  nextAttemptAt?: string;
}

/**
 * Step retry has been scheduled.
 */
interface StepRetryScheduledEvent extends BaseEvent {
  type: "step.retry_scheduled";
  stepName: string;
  attempt: number;
  nextAttemptAt: string;
  delayMs: number;
}
```

### Event Emission Points

| Lifecycle Point | Event Emitted |
|-----------------|---------------|
| `engine.run()` called | `workflow.started` |
| Workflow Effect completes successfully | `workflow.completed` |
| Workflow Effect fails (unrecoverable) | `workflow.failed` |
| PauseSignal caught | `workflow.paused` |
| `alarm()` handler invoked | `workflow.resumed` |
| `cancel()` RPC called | `workflow.cancelled` |
| `step()` begins execution (not cached) | `step.started` |
| `step()` returns result | `step.completed` |
| `step()` throws error | `step.failed` |
| `durableRetry` schedules retry | `step.retry_scheduled` |

---

## Command Model (Tracker → Workflow)

The tracker can send commands to influence workflow execution. Commands are delivered through a **polling mechanism** or **direct RPC**.

### Command Types

```typescript
/**
 * Commands the tracker can send to workflows.
 */
type WorkflowCommand =
  | CancelCommand
  | PauseCommand
  | ResumeCommand
  | RetryStepCommand
  | SkipStepCommand
  | SetMetaCommand;

/**
 * Cancel the workflow immediately.
 */
interface CancelCommand {
  type: "cancel";
  reason?: string;
  cancelledBy?: string;
}

/**
 * Pause the workflow at the next safe point.
 */
interface PauseCommand {
  type: "pause";
  reason?: string;
}

/**
 * Resume a manually paused workflow.
 */
interface ResumeCommand {
  type: "resume";
}

/**
 * Retry a specific failed step immediately.
 */
interface RetryStepCommand {
  type: "retry_step";
  stepName: string;
}

/**
 * Skip a failed step and continue with a provided value.
 */
interface SkipStepCommand {
  type: "skip_step";
  stepName: string;
  value: unknown;
}

/**
 * Set workflow metadata from external source.
 */
interface SetMetaCommand {
  type: "set_meta";
  key: string;
  value: unknown;
}
```

### Command Delivery Mechanisms

There are two approaches for command delivery:

#### Option A: Polling (Recommended)

The workflow periodically checks for pending commands:

```
┌──────────────┐                    ┌───────────────────┐
│   Workflow   │ ── poll every N ─▶ │  TrackerService   │
│   Engine     │    seconds         │  .getCommands()   │
│              │ ◀── commands ───── │                   │
└──────────────┘                    └───────────────────┘
```

**Pros:**
- Works with any backend (HTTP, queue, database)
- No need for the tracker to know how to reach the worker
- Works behind NAT/firewalls

**Cons:**
- Latency (commands not instant)
- Requires periodic work even when idle

#### Option B: Direct RPC (WebSocket/Durable Object Stub)

The tracker calls RPC methods directly on the Durable Object:

```
┌───────────────────┐                 ┌──────────────┐
│ External Tracker  │ ── RPC call ──▶ │   Workflow   │
│ (has DO binding)  │                 │   Engine     │
└───────────────────┘                 └──────────────┘
```

**Pros:**
- Instant command delivery
- No polling overhead

**Cons:**
- Requires tracker to have Cloudflare Worker binding
- More complex infrastructure setup

### Recommended: Hybrid Approach

Use **polling for external trackers** and **RPC for same-worker integrations**:

```typescript
interface TrackerService {
  // Push events (always available)
  emit(event: WorkflowEvent): Effect<void, TrackerError>;

  // Poll for commands (optional - for external trackers)
  getCommands?(workflowId: string): Effect<WorkflowCommand[], TrackerError>;
}

// RPC methods exposed by engine (for direct integration)
class DurableWorkflowEngine {
  async cancel(reason?: string): Promise<void>;
  async pause(reason?: string): Promise<void>;
  async resume(): Promise<void>;
  async retryStep(stepName: string): Promise<void>;
  async skipStep(stepName: string, value: unknown): Promise<void>;
}
```

---

## TrackerService Interface

Users implement this interface to connect to their tracking backend.

```typescript
import { Effect } from "effect";

/**
 * Error from tracker operations.
 */
export class TrackerError {
  readonly _tag = "TrackerError";
  constructor(
    readonly message: string,
    readonly cause?: unknown
  ) {}
}

/**
 * Configuration for the tracker service.
 */
export interface TrackerConfig {
  /**
   * Whether to block workflow execution if event emission fails.
   * Default: false (fire-and-forget)
   */
  blocking?: boolean;

  /**
   * Retry configuration for event emission.
   */
  retry?: {
    maxAttempts: number;
    delayMs: number;
  };

  /**
   * Command polling interval in milliseconds.
   * Set to 0 to disable polling.
   * Default: 0 (disabled)
   */
  commandPollIntervalMs?: number;

  /**
   * Events to emit. Default: all events.
   */
  events?: WorkflowEvent["type"][];
}

/**
 * Service interface for external tracking.
 * Users implement this to connect to their tracking backend.
 */
export interface TrackerService {
  /**
   * Emit a workflow event to the tracking backend.
   * Should be non-blocking unless config.blocking is true.
   */
  emit(event: WorkflowEvent): Effect<void, TrackerError>;

  /**
   * Optional: Poll for pending commands from the tracker.
   * Only needed if using polling-based command delivery.
   */
  getCommands?(workflowId: string): Effect<WorkflowCommand[], TrackerError>;

  /**
   * Optional: Acknowledge that commands were processed.
   */
  ackCommands?(workflowId: string, commandIds: string[]): Effect<void, TrackerError>;
}

/**
 * Effect service tag for dependency injection.
 */
export class TrackerServiceTag extends Context.Tag("TrackerService")<
  TrackerServiceTag,
  TrackerService
>() {}
```

---

## Integration with Workflow Engine

### Engine Configuration

```typescript
import { createDurableWorkflows } from "@durable-effect/workflow";

export const MyWorkflows = createDurableWorkflows<Env>()({
  processOrder: orderWorkflow,
  sendNotification: notificationWorkflow,
}, {
  // Optional tracker configuration
  tracker: {
    // Service factory - receives env for runtime configuration
    service: (env: Env) => createHttpTracker({
      endpoint: env.TRACKER_ENDPOINT,
      apiKey: env.TRACKER_API_KEY,
    }),

    // Configuration
    config: {
      blocking: false,
      retry: { maxAttempts: 3, delayMs: 1000 },
      commandPollIntervalMs: 5000, // Poll every 5 seconds
      events: [
        "workflow.started",
        "workflow.completed",
        "workflow.failed",
        "step.failed",
      ],
    },
  },
});
```

### Internal Event Emission

The engine emits events at lifecycle points:

```typescript
// Simplified internal implementation
class DurableWorkflowEngine {
  #tracker?: TrackerService;
  #config?: TrackerConfig;

  async #emitEvent(event: WorkflowEvent): Promise<void> {
    if (!this.#tracker) return;

    // Check if this event type should be emitted
    if (this.#config?.events && !this.#config.events.includes(event.type)) {
      return;
    }

    const effect = this.#tracker.emit(event).pipe(
      // Apply retry if configured
      this.#config?.retry
        ? Effect.retry({
            times: this.#config.retry.maxAttempts,
            delay: Duration.millis(this.#config.retry.delayMs),
          })
        : identity,
      // Ignore errors unless blocking
      this.#config?.blocking
        ? identity
        : Effect.catchAll(() => Effect.void)
    );

    await Effect.runPromise(effect);
  }

  async run(call: WorkflowCall<T>): Promise<WorkflowRunResult> {
    await this.#emitEvent({
      type: "workflow.started",
      eventId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      workflowId: this.ctx.id.toString(),
      workflowName: call.workflow,
      input: call.input,
    });

    // ... execute workflow ...

    await this.#emitEvent({
      type: "workflow.completed",
      // ... event data
    });
  }
}
```

### Command Processing

Commands are checked at safe points (before steps, after resume):

```typescript
class DurableWorkflowEngine {
  async #checkCommands(): Promise<void> {
    if (!this.#tracker?.getCommands) return;

    const commands = await Effect.runPromise(
      this.#tracker.getCommands(this.ctx.id.toString())
    );

    for (const command of commands) {
      await this.#processCommand(command);
    }
  }

  async #processCommand(command: WorkflowCommand): Promise<void> {
    switch (command.type) {
      case "cancel":
        await this.#setCancelled(command.reason);
        throw new WorkflowCancelledError(command.reason);

      case "pause":
        await this.#setManualPause(command.reason);
        throw new PauseSignal("manual", undefined);

      case "resume":
        // Handled by alarm mechanism
        break;

      case "retry_step":
        await this.#clearStepResult(command.stepName);
        break;

      case "skip_step":
        await this.#setStepResult(command.stepName, command.value);
        break;

      case "set_meta":
        await this.#setMeta(command.key, command.value);
        break;
    }
  }
}
```

---

## Example Implementations

### HTTP Tracker (Simple)

A simple HTTP-based tracker that POSTs events to an endpoint:

```typescript
import { Effect } from "effect";
import type { TrackerService, WorkflowEvent, TrackerError } from "@durable-effect/workflow";

interface HttpTrackerOptions {
  endpoint: string;
  apiKey: string;
  timeout?: number;
}

export function createHttpTracker(options: HttpTrackerOptions): TrackerService {
  return {
    emit: (event: WorkflowEvent) =>
      Effect.tryPromise({
        try: async () => {
          const response = await fetch(options.endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${options.apiKey}`,
            },
            body: JSON.stringify(event),
            signal: AbortSignal.timeout(options.timeout ?? 5000),
          });

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }
        },
        catch: (error) => new TrackerError("Failed to emit event", error),
      }),

    getCommands: (workflowId: string) =>
      Effect.tryPromise({
        try: async () => {
          const response = await fetch(
            `${options.endpoint}/commands/${workflowId}`,
            {
              headers: {
                "Authorization": `Bearer ${options.apiKey}`,
              },
            }
          );

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }

          return response.json();
        },
        catch: (error) => new TrackerError("Failed to get commands", error),
      }),
  };
}
```

### Queue-Based Tracker (Production)

A more robust tracker using Cloudflare Queues:

```typescript
import { Effect } from "effect";
import type { TrackerService, WorkflowEvent } from "@durable-effect/workflow";

interface QueueTrackerOptions {
  queue: Queue<WorkflowEvent>;
  commandKV: KVNamespace;
}

export function createQueueTracker(options: QueueTrackerOptions): TrackerService {
  return {
    emit: (event: WorkflowEvent) =>
      Effect.tryPromise({
        try: () => options.queue.send(event),
        catch: (error) => new TrackerError("Failed to queue event", error),
      }),

    getCommands: (workflowId: string) =>
      Effect.tryPromise({
        try: async () => {
          const key = `commands:${workflowId}`;
          const data = await options.commandKV.get(key, "json");
          return (data as WorkflowCommand[]) ?? [];
        },
        catch: (error) => new TrackerError("Failed to get commands", error),
      }),

    ackCommands: (workflowId: string, commandIds: string[]) =>
      Effect.tryPromise({
        try: async () => {
          const key = `commands:${workflowId}`;
          const commands = await options.commandKV.get<WorkflowCommand[]>(key, "json") ?? [];
          const remaining = commands.filter((c) => !commandIds.includes(c.id));
          await options.commandKV.put(key, JSON.stringify(remaining));
        },
        catch: (error) => new TrackerError("Failed to ack commands", error),
      }),
  };
}
```

### WebSocket Tracker (Real-time)

For real-time dashboards using Durable Objects WebSocket:

```typescript
import { Effect } from "effect";
import type { TrackerService, WorkflowEvent } from "@durable-effect/workflow";

interface WebSocketTrackerOptions {
  dashboardDO: DurableObjectStub;
}

export function createWebSocketTracker(options: WebSocketTrackerOptions): TrackerService {
  return {
    emit: (event: WorkflowEvent) =>
      Effect.tryPromise({
        try: () => options.dashboardDO.fetch("https://internal/event", {
          method: "POST",
          body: JSON.stringify(event),
        }),
        catch: (error) => new TrackerError("Failed to emit to dashboard", error),
      }),
  };
}
```

---

## User-Facing API Example

### Complete Setup Example

```typescript
// src/tracker.ts
import { createHttpTracker } from "@durable-effect/workflow/tracker";

export function createTracker(env: Env) {
  return createHttpTracker({
    endpoint: env.TRACKER_ENDPOINT,
    apiKey: env.TRACKER_API_KEY,
  });
}

// src/workflows/order.ts
import { Effect } from "effect";
import { createDurableWorkflows, step, durableRetry } from "@durable-effect/workflow";
import { createTracker } from "../tracker";

export const OrderWorkflows = createDurableWorkflows<Env>()({
  processOrder: (orderId: string) =>
    Effect.gen(function* () {
      const order = yield* step("Fetch order", fetchOrder(orderId));

      yield* step("Process payment",
        processPayment(order).pipe(
          durableRetry({ maxAttempts: 3, delayMs: 5000 })
        )
      );

      yield* step("Send confirmation", sendEmail(order.email));
    }),
}, {
  // Enable external tracking
  tracker: {
    service: createTracker,
    config: {
      blocking: false,
      retry: { maxAttempts: 2, delayMs: 500 },
      commandPollIntervalMs: 10_000,
    },
  },
});

// src/index.ts
import { OrderWorkflows } from "./workflows/order";

export { OrderWorkflows };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/orders" && request.method === "POST") {
      const { orderId } = await request.json<{ orderId: string }>();

      const id = env.ORDER_WORKFLOWS.idFromName(`order-${orderId}`);
      const stub = env.ORDER_WORKFLOWS.get(id);

      // Start workflow - tracker automatically notified
      const result = await stub.run("processOrder", orderId);

      return Response.json({ status: result.status });
    }

    // Manual intervention endpoints (alternative to tracker commands)
    if (url.pathname.startsWith("/orders/") && request.method === "DELETE") {
      const orderId = url.pathname.split("/")[2];
      const id = env.ORDER_WORKFLOWS.idFromName(`order-${orderId}`);
      const stub = env.ORDER_WORKFLOWS.get(id);

      await stub.cancel("Cancelled via API");
      return Response.json({ cancelled: true });
    }

    return new Response("Not found", { status: 404 });
  },
};
```

### Without Tracking (Default)

If no tracker is configured, workflows work exactly as before:

```typescript
// No tracker config = no tracking overhead
export const OrderWorkflows = createDurableWorkflows<Env>()({
  processOrder: (orderId: string) =>
    Effect.gen(function* () {
      // ... workflow logic
    }),
});
```

---

## Tracking Service Backend Requirements

For users building their own tracking backend, it should handle:

### Event Ingestion

```
POST /events
Content-Type: application/json
Authorization: Bearer <api-key>

{
  "type": "workflow.started",
  "eventId": "evt_abc123",
  "timestamp": "2024-01-15T10:30:00Z",
  "workflowId": "do_xyz789",
  "workflowName": "processOrder",
  "input": { "orderId": "order-456" }
}
```

### Command Queue

```
GET /commands/:workflowId
Authorization: Bearer <api-key>

Response:
[
  {
    "id": "cmd_001",
    "type": "cancel",
    "reason": "User requested cancellation"
  }
]

DELETE /commands/:workflowId/:commandId
Authorization: Bearer <api-key>
```

### Dashboard Queries

The backend should support queries like:
- List all workflows by status
- Get workflow history (events for a specific workflow)
- Search workflows by name, input, or metadata
- Aggregate statistics (success rate, average duration, etc.)

---

## Security Considerations

### Authentication

- Use API keys or OAuth tokens for event emission
- Validate tokens on both emit and command endpoints
- Consider IP allowlisting for Cloudflare Worker IP ranges

### Data Privacy

- Events may contain sensitive input data
- Consider redacting/hashing sensitive fields before emission
- Implement data retention policies in the tracking backend

### Command Authorization

- Validate who can send commands (admin only, specific users, etc.)
- Log all commands for audit trail
- Consider requiring confirmation for destructive commands (cancel)

---

## Performance Considerations

### Event Emission

- Events are fire-and-forget by default (non-blocking)
- Use connection pooling for HTTP trackers
- Consider batching events for high-throughput workflows

### Command Polling

- Poll interval should balance responsiveness vs overhead
- Consider exponential backoff when no commands pending
- Disable polling for workflows that don't need intervention

### Storage Overhead

- Events should be stored efficiently (time-series database)
- Implement retention policies (delete events older than N days)
- Index by workflowId for efficient queries

---

## Future Enhancements

### Event Streaming

Support real-time event streaming via:
- Server-Sent Events (SSE)
- WebSocket connections
- Cloudflare Durable Objects WebSocket

### Distributed Tracing

Integrate with OpenTelemetry:
- Trace IDs across workflow executions
- Span data for steps
- Integration with Jaeger/Zipkin

### Workflow Replay

Enable replaying workflows from events:
- Store complete event history
- Rebuild workflow state from events
- Debug/analyze past executions

### Metrics Export

Prometheus/StatsD metrics:
- Workflow execution counts
- Step durations
- Error rates
- Queue depths

---

## Summary

| Aspect | Design Decision |
|--------|-----------------|
| **Dependency** | Optional - no tracker = no overhead |
| **Direction** | Push events, poll/RPC for commands |
| **Failure mode** | Non-blocking by default (configurable) |
| **Events** | Comprehensive lifecycle events |
| **Commands** | Cancel, pause, resume, retry, skip |
| **Implementation** | User provides TrackerService implementation |

This design allows users to integrate with any tracking backend while keeping the core workflow package lightweight and focused on its primary purpose: durable workflow execution.
