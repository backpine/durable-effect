# @durable-effect/workflow

Write workflows that survive server restarts, network failures, and deployments. Your code picks up exactly where it left off.

```typescript
const orderWorkflow = Workflow.make((orderId: string) =>
  Effect.gen(function* () {
    const order = yield* Workflow.step({
      name: "Fetch",
      execute: fetchOrder(orderId),
    });
    yield* Workflow.sleep("24 hours");  // Yes, actually sleep for a day
    yield* Workflow.step({
      name: "Charge",
      execute: chargeCard(order),
    });
  })
);
```

This library brings [Effect's](https://effect.website/) composable, type-safe programming model to durable execution. Built by [Matthew Sessions](https://github.com/matthew-sessions) at [Backpine Labs](https://github.com/backpine) as an experiment in generalizing effectful code on a durable runtime.

**Status**: Experimental. API may have breaking changes. Currently only supports **Cloudflare Durable Objects** as the execution engine.

---

## Table of Contents

- [Installation](#installation)
- [High-Level Usage](#high-level-usage)
  - [Building a Basic Workflow](#building-a-basic-workflow)
  - [Steps](#steps)
  - [Sleep](#sleep)
- [Exporting the Workflow Class](#exporting-the-workflow-class)
- [Using the Workflow Client](#using-the-workflow-client)
- [Event Tracking](#event-tracking)
- [Retry Features](#retry-features)
  - [Basic Retry Configuration](#basic-retry-configuration)
  - [Backoff Strategies](#backoff-strategies)
  - [Jitter](#jitter)
  - [Presets](#presets)
  - [Max Duration](#max-duration)
  - [Selective Retry with isRetryable](#selective-retry-with-isretryable)
- [Timeouts](#timeouts)
- [Providing Services](#providing-services)
- [Recovery](#recovery)
- [Automatic Data Purging](#automatic-data-purging)

---

## Installation

```bash
pnpm add @durable-effect/workflow effect
```

---

## High-Level Usage

### Building a Basic Workflow

Workflows are built using `Workflow.make()`. A workflow is a function that takes an input and returns an Effect containing your workflow logic.

```typescript
import { Effect } from "effect";
import { Workflow } from "@durable-effect/workflow";

const myWorkflow = Workflow.make((orderId: string) =>
  Effect.gen(function* () {
    // Fetch order data
    const order = yield* Workflow.step({
      name: "Fetch order",
      execute: fetchOrder(orderId),
    });

    // Wait before processing
    yield* Workflow.sleep("5 seconds");

    // Process the order
    yield* Workflow.step({
      name: "Process order",
      execute: processOrder(order),
    });

    // Send confirmation
    yield* Workflow.step({
      name: "Send confirmation",
      execute: sendEmail(order.email),
    });
  })
);
```

### Steps

Steps are the core building blocks of a workflow. Each step:

- Has a unique name within the workflow
- Automatically caches its result in Durable Object storage
- Replays the cached result on workflow resume (skipping re-execution)
- Must return a JSON-serializable value

```typescript
// Define your business logic as a regular Effect
const processData = (input: string) =>
  Effect.gen(function* () {
    // Process data, call services, access databases, etc.
    yield* Effect.promise(() => new Promise(resolve => setTimeout(resolve, 3000)));

    return { id: input, status: "complete" };
  });

// Use it in a step - the result gets cached automatically
const result = yield* Workflow.step({
  name: "Process data",
  execute: processData(orderId),
});

// Same pattern for any effect
const user = yield* Workflow.step({
  name: "Fetch user",
  execute: fetchUser(userId),
});

// Step with non-serializable result - use Effect.asVoid to discard
yield* Workflow.step({
  name: "Update database",
  execute: updateRecord(id).pipe(Effect.asVoid),
});

// Step with complex result - extract serializable fields
yield* Workflow.step({
  name: "Create order",
  execute: createOrder(data).pipe(
    Effect.map((order) => ({ id: order.id, status: order.status }))
  ),
});
```

**Important**: Step results must be serializable. If your effect returns a complex object (ORM result, class instance, etc.), map it to a plain object or use `Effect.asVoid` to discard it.

### Sleep

Sleeps are fully durable. Your workflow can sleep for a few seconds or a few months - it all depends on your business use case. The workflow will resume exactly where it left off, even across deployments and server restarts.

```typescript
// Short delays for rate limiting
yield* Workflow.sleep("30 seconds");

// Wait a day before sending a follow-up
yield* Workflow.sleep("24 hours");

// Subscription renewal in 30 days
yield* Workflow.sleep("30 days");

// Using milliseconds
yield* Workflow.sleep(5000);
```

---

## Exporting the Workflow Class

To use your workflows with Cloudflare Workers, you need to:

1. **Define your workflows** as a registry object
2. **Create the Durable Object class and client** using `createDurableWorkflows()`
3. **Export the Workflows class** from your worker entry point

### Step 1: Define and Export Workflows

Create a file (e.g., `workflows.ts`) that defines and exports your workflows:

```typescript
import { Effect } from "effect";
import { Workflow, Backoff, createDurableWorkflows } from "@durable-effect/workflow";

// Define your workflow (name comes from registry key)
const processOrderWorkflow = Workflow.make((orderId: string) =>
  Effect.gen(function* () {
    const order = yield* Workflow.step({
      name: "Fetch order",
      execute: fetchOrder(orderId),
    });
    yield* Workflow.sleep("3 seconds");

    yield* Workflow.step({
      name: "Process payment",
      execute: processPayment(order),
      retry: {
        maxAttempts: 5,
        delay: Backoff.exponential({ base: "1 second", max: "60 seconds" }),
      },
    });

    yield* Workflow.step({
      name: "Send confirmation",
      execute: sendEmail(order.email),
    });
  })
);

// Create a registry of all workflows
// The key becomes the workflow name
const workflows = {
  processOrder: processOrderWorkflow,
} as const;

// Create and export the Durable Object class and client
export const { Workflows, WorkflowClient } = createDurableWorkflows(workflows);
```

### Step 2: Export from Worker Entry Point

In your main worker file (e.g., `index.ts`), export the `Workflows` class:

```typescript
import { Workflows } from "./workflows";

// Export the Durable Object class
export { Workflows };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Your fetch handler
  },
};
```

### Step 3: Configure Wrangler

Add the Durable Object binding to your `wrangler.jsonc`:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "my-worker",
  "main": "src/index.ts",
  "compatibility_date": "2025-11-28",

  "durable_objects": {
    "bindings": [
      {
        "name": "WORKFLOWS",
        "class_name": "Workflows"
      }
    ]
  },

  "migrations": [
    {
      "tag": "v1",
      "new_classes": ["Workflows"]
    }
  ]
}
```

---

## Using the Workflow Client

The `WorkflowClient` provides a type-safe, Effect-based interface for invoking and managing workflows. All methods are yieldable.

### Creating a Client

Create a client from your Durable Object binding:

```typescript
import { Effect } from "effect";
import { WorkflowClient } from "./workflows";

export const startWorkflow = (request: Request, env: Env) =>
  Effect.gen(function* () {
    const client = WorkflowClient.fromBinding(env.WORKFLOWS);

    // Start a workflow - yields an Effect
    const { id } = yield* client.runAsync({
      workflow: "processOrder",
      input: "order-123",
      execution: { id: "order-123" }, // Optional: custom execution ID
    });

    return Response.json({ workflowId: id });
  });
```

### Client Methods

All methods return Effects, making them yieldable:

```typescript
const client = WorkflowClient.fromBinding(env.WORKFLOWS);

// Start a workflow asynchronously (returns immediately)
const { id } = yield* client.runAsync({
  workflow: "processOrder",
  input: orderId,
  execution: { id: orderId }, // Optional custom ID
});
// id = "processOrder:order-123" (namespaced)

// Start a workflow synchronously (waits for completion/pause/failure)
const { id } = yield* client.run({
  workflow: "processOrder",
  input: orderId,
});

// Get workflow status
const status = yield* client.status(workflowId);
// Returns: { _tag: "Running" } | { _tag: "Completed", completedAt: number } | ...

// Get completed steps
const steps = yield* client.completedSteps(workflowId);
// Returns: ["Fetch order", "Process payment"]

// Get workflow metadata
const meta = yield* client.meta<MyMetaType>(workflowId, "myKey");

// Cancel a workflow
yield* client.cancel(workflowId, { reason: "User requested cancellation" });
```

### Using with Effect.runPromise

If you need to use the client outside of an Effect context:

```typescript
const client = WorkflowClient.fromBinding(env.WORKFLOWS);

const { id } = await Effect.runPromise(
  client.runAsync({
    workflow: "processOrder",
    input: orderId,
    execution: { id: orderId },
  })
);
```

### Service Pattern with Effect Tag

The client factory includes an Effect Tag for use with the service pattern:

```typescript
const client = WorkflowClient.fromBinding(env.WORKFLOWS);

// Use the Tag for dependency injection
const program = Effect.gen(function* () {
  const client = yield* WorkflowClient.Tag;
  yield* client.runAsync({ workflow: "processOrder", input: "order-123" });
});

// Provide the client
Effect.runPromise(
  program.pipe(Effect.provideService(WorkflowClient.Tag, client))
);
```

### Workflow Status Types

```typescript
type WorkflowStatus =
  | { _tag: "Pending" }
  | { _tag: "Queued"; queuedAt: number }
  | { _tag: "Running" }
  | { _tag: "Paused"; reason: string; resumeAt: number }
  | { _tag: "Completed"; completedAt: number }
  | { _tag: "Failed"; error: unknown; failedAt: number }
  | { _tag: "Cancelled"; cancelledAt: number; reason?: string };
```

---

## Event Tracking

Configure a tracker endpoint to monitor workflow execution and receive events.

### Configuration

```typescript
export const { Workflows, WorkflowClient } = createDurableWorkflows(workflows, {
  tracker: {
    // Required
    endpoint: "https://events.example.com/ingest",
    env: "production",
    serviceKey: "my-service",

    // Optional
    batchSize: 10,           // Events per batch (default: 10)
    flushIntervalMs: 5000,   // Auto-flush interval (default: 5000)
    retry: {
      maxAttempts: 3,        // Retry failed sends (default: 3)
    },
  },
});
```

### Event Types

The tracker emits the following events:

**Workflow Events:**
- `workflow.started` - Workflow execution began
- `workflow.completed` - Workflow finished successfully
- `workflow.failed` - Workflow failed with an error
- `workflow.paused` - Workflow paused (sleep/retry)
- `workflow.resumed` - Workflow resumed from pause
- `workflow.cancelled` - Workflow was cancelled
- `workflow.queued` - Workflow queued for async execution

**Step Events:**
- `step.started` - Step execution began
- `step.completed` - Step finished successfully
- `step.failed` - Step failed with an error

**Retry Events:**
- `retry.scheduled` - Retry attempt scheduled
- `retry.exhausted` - All retries exhausted

**Sleep Events:**
- `sleep.started` - Sleep began
- `sleep.completed` - Sleep completed

**Timeout Events:**
- `timeout.set` - Timeout deadline set
- `timeout.exceeded` - Timeout fired

### Disabling Tracking

If no tracker is configured, events are not emitted:

```typescript
// No tracker - events disabled
export const { Workflows, WorkflowClient } = createDurableWorkflows(workflows);
```

---

## Retry Features

Steps support durable retries that persist across workflow restarts. Configure retries directly in the step config:

```typescript
yield* Workflow.step({
  name: "External API call",
  execute: callExternalAPI(),
  retry: { maxAttempts: 3, delay: "5 seconds" },
});
```

### Basic Retry Configuration

```typescript
interface RetryConfig {
  maxAttempts: number;              // Number of retries (not including initial attempt)
  delay?: DelayConfig;              // Delay between retries
  maxDuration?: string | number;    // Total time budget for all attempts
  jitter?: boolean;                 // Add randomness to delays (default: true)
  isRetryable?: (error: unknown) => boolean;  // Filter which errors trigger retry
}
```

**Examples:**

```typescript
// Fixed delay
yield* Workflow.step({
  name: "API call",
  execute: callAPI(),
  retry: { maxAttempts: 3, delay: "5 seconds" },
});

// No delay (immediate retry)
yield* Workflow.step({
  name: "Quick retry",
  execute: quickOperation(),
  retry: { maxAttempts: 3 },
});

// Custom delay function
yield* Workflow.step({
  name: "Custom backoff",
  execute: operation(),
  retry: {
    maxAttempts: 5,
    delay: (attempt) => 1000 * Math.pow(2, attempt),
  },
});
```

### Backoff Strategies

Import the `Backoff` namespace for advanced retry strategies:

```typescript
import { Backoff } from "@durable-effect/workflow";
```

#### Exponential Backoff

Delay grows exponentially: `base * factor^attempt`

```typescript
yield* Workflow.step({
  name: "API call",
  execute: callAPI(),
  retry: {
    maxAttempts: 5,
    delay: Backoff.exponential({
      base: "1 second",       // Starting delay
      factor: 2,              // Multiplier (default: 2)
      max: "30 seconds",      // Maximum delay cap
    }),
  },
});
// Delays: 1s -> 2s -> 4s -> 8s -> 16s (capped at 30s)
```

#### Linear Backoff

Delay grows linearly: `initial + (attempt * increment)`

```typescript
yield* Workflow.step({
  name: "API call",
  execute: callAPI(),
  retry: {
    maxAttempts: 5,
    delay: Backoff.linear({
      initial: "1 second",
      increment: "2 seconds",
      max: "10 seconds",
    }),
  },
});
// Delays: 1s -> 3s -> 5s -> 7s -> 9s (capped at 10s)
```

#### Constant Backoff

Fixed delay between retries:

```typescript
yield* Workflow.step({
  name: "API call",
  execute: callAPI(),
  retry: {
    maxAttempts: 3,
    delay: Backoff.constant("5 seconds"),
  },
});
```

### Jitter

Jitter adds randomness to delays to prevent the "thundering herd" problem when many clients retry simultaneously. Jitter is enabled by default.

```typescript
// Disable jitter
yield* Workflow.step({
  name: "Precise timing",
  execute: operation(),
  retry: {
    maxAttempts: 3,
    delay: "5 seconds",
    jitter: false,
  },
});
```

### Presets

Use built-in presets for common scenarios:

```typescript
// Standard: 1s -> 2s -> 4s -> 8s -> 16s (max 30s)
Backoff.presets.standard()

// Aggressive: 100ms -> 200ms -> 400ms -> 800ms (max 5s)
// For internal services with low latency
Backoff.presets.aggressive()

// Patient: 5s -> 10s -> 20s -> 40s (max 2min)
// For rate-limited APIs
Backoff.presets.patient()

// Simple: 1s constant
// For polling scenarios
Backoff.presets.simple()
```

**Usage:**

```typescript
yield* Workflow.step({
  name: "Call rate-limited API",
  execute: callAPI(),
  retry: {
    maxAttempts: 10,
    delay: Backoff.presets.patient(),
  },
});
```

### Max Duration

Set a total time budget for all retry attempts:

```typescript
yield* Workflow.step({
  name: "Time-bounded operation",
  execute: operation(),
  retry: {
    maxAttempts: 100,
    delay: Backoff.exponential({ base: "1 second" }),
    maxDuration: "5 minutes",  // Stop retrying after 5 minutes total
  },
});
```

### Selective Retry with isRetryable

You can use the `isRetryable` option to decide which errors should trigger retries and which should fail immediately:

```typescript
import { Effect, Data } from "effect";

// Define typed errors
class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly message: string;
}> {}

class NetworkError extends Data.TaggedError("NetworkError")<{
  readonly message: string;
}> {}

// Workflow with selective retry
const processPaymentWorkflow = Workflow.make((paymentId: string) =>
  Effect.gen(function* () {
    yield* Workflow.step({
      name: "Process payment",
      execute: processPayment(paymentId),
      retry: {
        maxAttempts: 5,
        delay: Backoff.presets.standard(),
        // Only retry network errors, not validation errors
        isRetryable: (error) => error instanceof NetworkError,
      },
    });
  })
);
```

#### Using Effect's `catchTag` for Error Transformation

You can also use Effect's error handling to transform errors before the retry logic:

```typescript
yield* Workflow.step({
  name: "Process payment",
  execute: processPayment(paymentId).pipe(
    // Catch validation errors - transform to non-retryable error
    Effect.catchTag("ValidationError", (err) =>
      Effect.fail(new PaymentFailed({ reason: err.message }))
    )
    // Network errors bubble up and will be retried
  ),
  retry: {
    maxAttempts: 5,
    delay: Backoff.presets.standard(),
  },
});
```

---

## Timeouts

Steps support timeouts that set a deadline for execution. The deadline persists across workflow restarts.

```typescript
yield* Workflow.step({
  name: "External API",
  execute: callExternalAPI(),
  timeout: "30 seconds",
});
```

### Timeout with Retry

When combining timeout and retry, the timeout applies to **each attempt individually**:

```typescript
yield* Workflow.step({
  name: "API call",
  execute: callAPI(),
  timeout: "30 seconds",  // Each attempt has 30 seconds
  retry: { maxAttempts: 3 },
});
// Total max time: 3 attempts * 30 seconds = 90 seconds (plus delays)
```

### Duration Formats

Both `timeout` and `sleep` accept string or number formats:

```typescript
// String formats
timeout: "30 seconds"
timeout: "5 minutes"
timeout: "2 hours"

// Milliseconds
timeout: 5000
```

---

## Providing Services

Workflows support Effect's service pattern for dependency injection. Provide services at the end of your workflow using `.pipe()`.

### Basic Service Provision

```typescript
import { Effect, Context, Layer } from "effect";

// Define a service
class EmailService extends Context.Tag("EmailService")<
  EmailService,
  {
    readonly send: (to: string, body: string) => Effect.Effect<void>;
  }
>() {}

// Create a layer
const EmailServiceLive = Layer.succeed(EmailService, {
  send: (to, body) => Effect.promise(() => sendEmailViaAPI(to, body)),
});

// Workflow using the service
const notificationWorkflow = Workflow.make((userId: string) =>
  Effect.gen(function* () {
    const user = yield* Workflow.step({
      name: "Fetch user",
      execute: fetchUser(userId),
    });

    const emailService = yield* EmailService;
    yield* Workflow.step({
      name: "Send email",
      execute: emailService.send(user.email, "Hello!").pipe(Effect.asVoid),
    });
  }).pipe(
    Effect.provide(EmailServiceLive)
  )
);
```

### Multiple Services

```typescript
const MyServices = Layer.mergeAll(
  EmailServiceLive,
  DatabaseServiceLive,
  LoggingServiceLive
);

const complexWorkflow = Workflow.make((input: Input) =>
  Effect.gen(function* () {
    // ... workflow logic using services
  }).pipe(
    Effect.provide(MyServices)
  )
);
```

---

## Error Types

The library exports typed errors for proper error handling:

```typescript
import {
  WorkflowClientError,      // Client operation failed
  StepCancelledError,       // Step was cancelled
  RetryExhaustedError,      // All retries exhausted
  WorkflowTimeoutError,     // Step exceeded timeout
  StorageError,             // Durable Object storage error
  OrchestratorError,        // Orchestration error
  WorkflowScopeError,       // Operation used outside workflow
  StepScopeError,           // Sleep/sleepUntil used inside step
} from "@durable-effect/workflow";
```

---

## Recovery

Workflows automatically recover from infrastructure failures. If a workflow is in "Running" state when the Durable Object restarts, it will automatically schedule recovery.

### Configuration

```typescript
export const { Workflows, WorkflowClient } = createDurableWorkflows(workflows, {
  recovery: {
    staleThresholdMs: 30000,     // Consider stale after 30s (default)
    maxRecoveryAttempts: 3,       // Max recovery attempts (default: 3)
    recoveryDelayMs: 1000,        // Delay before recovery (default: 1000)
  },
});
```

---

## Automatic Data Purging

By default, workflow data (state, step results, metadata) persists in Durable Object storage indefinitely. For high-volume workflows, this can lead to storage bloat. Enable automatic purging to delete workflow data after completion.

### Configuration

```typescript
export const { Workflows, WorkflowClient } = createDurableWorkflows(workflows, {
  purge: {
    delay: "5 minutes",  // Delete data 5 minutes after terminal state
  },
});
```

When enabled, workflow data is automatically purged after the workflow reaches a terminal state (completed, failed, or cancelled). The delay gives you time to query final status before cleanup.

### Delay Formats

The `delay` option accepts Effect duration strings or milliseconds:

```typescript
// String formats
purge: { delay: "30 seconds" }
purge: { delay: "5 minutes" }
purge: { delay: "1 hour" }
purge: { delay: "1 day" }

// Milliseconds
purge: { delay: 60000 }

```

### What Gets Purged

When purge executes, **all** Durable Object storage for that workflow instance is deleted:
- Workflow state and status
- Step results and metadata
- Recovery tracking data
- Any custom metadata stored via `getMeta()`

### Disabling Purge

Omit the `purge` option to retain data indefinitely (default behavior):

```typescript
// No purge - data retained forever
export const { Workflows, WorkflowClient } = createDurableWorkflows(workflows);
```

### Logs

When a purge executes, it logs:

```
[Workflow] Purged data for {instanceId} ({reason})
```

Where `reason` is the terminal state that triggered the purge (`completed`, `failed`, or `cancelled`).

---

## License

MIT

---

Built by [Matthew Sessions](https://github.com/matthew-sessions) at [Backpine Labs](https://github.com/backpine)
