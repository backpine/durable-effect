# @durable-effect/workflow

Write workflows that survive server restarts, network failures, and deployments. Your code picks up exactly where it left off.

```typescript
const orderWorkflow = Workflow.make((orderId: string) =>
  Effect.gen(function* () {
    const order = yield* Workflow.step("Fetch", fetchOrder(orderId));
    yield* Workflow.sleep("24 hours");  // Yes, actually sleep for a day
    yield* Workflow.step("Charge", chargeCard(order));
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
- [Retry Features](#retry-features)
  - [Basic Retry Configuration](#basic-retry-configuration)
  - [Backoff Strategies](#backoff-strategies)
  - [Jitter](#jitter)
  - [Presets](#presets)
  - [Max Duration](#max-duration)
  - [Selective Retry with Effect Error Handling](#selective-retry-with-effect-error-handling)
- [Timeouts](#timeouts)
- [Providing Services](#providing-services)

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
    const order = yield* Workflow.step("Fetch order", fetchOrder(orderId));

    // Wait before processing
    yield* Workflow.sleep("5 seconds");

    // Process the order
    yield* Workflow.step("Process order", processOrder(order));

    // Send confirmation
    yield* Workflow.step("Send confirmation", sendEmail(order.email));
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
const result = yield* Workflow.step("Process data", processData(orderId));

// Same pattern for any effect
const user = yield* Workflow.step("Fetch user", fetchUser(userId));

// Step with non-serializable result - use Effect.asVoid to discard
yield* Workflow.step("Update database",
  updateRecord(id).pipe(Effect.asVoid)
);

// Step with complex result - extract serializable fields
yield* Workflow.step("Create order",
  createOrder(data).pipe(
    Effect.map((order) => ({ id: order.id, status: order.status }))
  )
);
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

// Using Duration
import { Duration } from "effect";
yield* Workflow.sleep(Duration.minutes(5));
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

// Define your workflow
const processOrderWorkflow = Workflow.make((orderId: string) =>
  Effect.gen(function* () {
    const order = yield* Workflow.step("Fetch order", fetchOrder(orderId));
    yield* Workflow.sleep("3 seconds");

    yield* Workflow.step("Process payment",
      processPayment(order).pipe(
        Workflow.retry({
          maxAttempts: 5,
          delay: Backoff.exponential({ base: "1 second", max: "60 seconds" }),
        })
      )
    );

    yield* Workflow.step("Send confirmation", sendEmail(order.email));
  })
);

// Create a registry of all workflows
const workflows = {
  processOrder: processOrderWorkflow,
};

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

The `WorkflowClient` provides a type-safe interface for invoking and managing workflows.

### Creating a Client

Create a client from your Durable Object binding:

```typescript
import { Effect } from "effect";
import { WorkflowClient } from "./workflows";

export const startWorkflow = (request: Request, env: Env) =>
  Effect.gen(function* () {
    const client = WorkflowClient.fromBinding(env.WORKFLOWS);

    // Start a workflow
    const { id } = yield* client.runAsync({
      workflow: "processOrder",
      input: "order-123",
      execution: { id: "order-123" }, // Optional: custom execution ID
    });

    return Response.json({ workflowId: id });
  });
```

### Client Methods

```typescript
const client = WorkflowClient.fromBinding(env.WORKFLOWS);

// Start a workflow asynchronously (returns immediately)
const { id } = yield* client.runAsync({
  workflow: "processOrder",
  input: orderId,
  execution: { id: orderId }, // Optional custom ID
});

// Get workflow status
const status = yield* client.status(workflowId);
// Returns: { _tag: "Running" } | { _tag: "Completed", completedAt: number } | ...

// Get completed steps
const steps = yield* client.completedSteps(workflowId);
// Returns: ["Fetch order", "Process payment"]

// Get workflow metadata
const meta = yield* client.getMeta<MyMetaType>(workflowId, "myKey");

// Cancel a workflow
yield* client.cancel(workflowId, { reason: "User requested cancellation" });
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

## Retry Features

The `Workflow.retry()` operator provides durable retries that persist across workflow restarts. Retries are applied **inside** a step:

```typescript
yield* Workflow.step("External API call",
  callExternalAPI().pipe(
    Workflow.retry({ maxAttempts: 3, delay: "5 seconds" })
  )
);
```

### Basic Retry Configuration

```typescript
interface RetryOptions {
  maxAttempts: number;              // Number of retries (not including initial attempt)
  delay?: DelayConfig;              // Delay between retries
  maxDuration?: Duration.DurationInput; // Total time budget for all attempts
}
```

**Examples:**

```typescript
// Fixed delay
Workflow.retry({ maxAttempts: 3, delay: "5 seconds" })

// No delay (immediate retry)
Workflow.retry({ maxAttempts: 3 })

// Custom delay function
Workflow.retry({
  maxAttempts: 5,
  delay: (attempt) => Duration.millis(1000 * Math.pow(2, attempt))
})
```

### Backoff Strategies

Import the `Backoff` namespace for advanced retry strategies:

```typescript
import { Backoff } from "@durable-effect/workflow";
```

#### Exponential Backoff

Delay grows exponentially: `base * factor^attempt`

```typescript
Workflow.retry({
  maxAttempts: 5,
  delay: Backoff.exponential({
    base: "1 second",       // Starting delay
    factor: 2,              // Multiplier (default: 2)
    max: "30 seconds",      // Maximum delay cap
    jitter: true,           // Add randomness
  })
})
// Delays: 1s -> 2s -> 4s -> 8s -> 16s (capped at 30s)
```

#### Linear Backoff

Delay grows linearly: `initial + (attempt * increment)`

```typescript
Workflow.retry({
  maxAttempts: 5,
  delay: Backoff.linear({
    initial: "1 second",
    increment: "2 seconds",
    max: "10 seconds",
  })
})
// Delays: 1s -> 3s -> 5s -> 7s -> 9s (capped at 10s)
```

#### Constant Backoff

Fixed delay between retries:

```typescript
Workflow.retry({
  maxAttempts: 3,
  delay: Backoff.constant("5 seconds", true) // true = apply jitter
})
```

### Jitter

Jitter adds randomness to delays to prevent the "thundering herd" problem when many clients retry simultaneously.

```typescript
// Simple jitter (full randomization)
Backoff.exponential({ base: "1 second", jitter: true })

// Specific jitter type
Backoff.exponential({
  base: "1 second",
  jitter: { type: "full" }      // random(0, delay)
})

Backoff.exponential({
  base: "1 second",
  jitter: { type: "equal" }     // delay/2 + random(0, delay/2)
})

Backoff.exponential({
  base: "1 second",
  jitter: { type: "decorrelated", factor: 3 }  // AWS-style
})
```

**Jitter Types:**

| Type | Formula | Best For |
|------|---------|----------|
| `full` | `random(0, delay)` | Maximum spread, many clients |
| `equal` | `delay/2 + random(0, delay/2)` | Balanced, never zero delay |
| `decorrelated` | `random(base, delay * factor)` | AWS-style, prevents correlation |

### Presets

Use built-in presets for common scenarios:

```typescript
// Standard: 1s -> 2s -> 4s -> 8s -> 16s (max 30s) with full jitter
Backoff.presets.standard()

// Aggressive: 100ms -> 200ms -> 400ms -> 800ms (max 5s)
// For internal services with low latency
Backoff.presets.aggressive()

// Patient: 5s -> 10s -> 20s -> 40s (max 2min)
// For rate-limited APIs
Backoff.presets.patient()

// Simple: 1s fixed with jitter
// For polling scenarios
Backoff.presets.simple()
```

**Usage:**

```typescript
yield* Workflow.step("Call rate-limited API",
  callAPI().pipe(
    Workflow.retry({
      maxAttempts: 10,
      delay: Backoff.presets.patient(),
    })
  )
);
```

### Max Duration

Set a total time budget for all retry attempts:

```typescript
Workflow.retry({
  maxAttempts: 100,
  delay: Backoff.exponential({ base: "1 second" }),
  maxDuration: "5 minutes",  // Stop retrying after 5 minutes total
})
```

### Selective Retry with Effect Error Handling

One of the most powerful features of using Effect with a durable runtime is **fine-grained error control**. You can use Effect's error handling to decide which errors should trigger retries and which should fail immediately.

This is incredibly useful because Effect can manage retry logic on a durable runtime - you get type-safe, composable error handling with persistence!

#### Using `catchTag` to Skip Retries

```typescript
import { Effect, Data } from "effect";

// Define typed errors
class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly message: string;
}> {}

class NetworkError extends Data.TaggedError("NetworkError")<{
  readonly message: string;
}> {}

class RateLimitError extends Data.TaggedError("RateLimitError")<{
  readonly retryAfter: number;
}> {}

// Workflow with selective retry
const processPaymentWorkflow = Workflow.make((paymentId: string) =>
  Effect.gen(function* () {
    yield* Workflow.step("Process payment",
      processPayment(paymentId).pipe(
        // Catch validation errors - don't retry, fail immediately
        Effect.catchTag("ValidationError", (err) =>
          Effect.fail(new PaymentFailed({ reason: err.message }))
        ),
        // Rate limit errors - let them bubble up for retry
        // Network errors - let them bubble up for retry
        Workflow.retry({
          maxAttempts: 5,
          delay: Backoff.presets.standard(),
        })
      )
    );
  })
);
```

In this example:
- `ValidationError` is caught and converted to a `PaymentFailed` error - **no retry**
- `NetworkError` and `RateLimitError` bubble up and trigger the retry mechanism

#### More Complex Error Handling

```typescript
yield* Workflow.step("Call external service",
  callService(data).pipe(
    // Handle specific errors before retry
    Effect.catchTags({
      // Client errors (4xx) - don't retry
      "ClientError": (err) => Effect.fail(new PermanentFailure(err.message)),

      // Auth errors - don't retry
      "AuthError": () => Effect.fail(new AuthenticationFailed()),

      // Timeout errors - retry with longer delay
      "TimeoutError": (err) => Effect.fail(err), // Let retry handle it
    }),
    // Retry only transient errors
    Workflow.retry({
      maxAttempts: 3,
      delay: Backoff.exponential({ base: "2 seconds" }),
    })
  )
);
```

#### Pattern: Retry Only Specific Errors

```typescript
const retryableErrors = ["NetworkError", "TimeoutError", "RateLimitError"] as const;

yield* Workflow.step("Resilient call",
  riskyOperation().pipe(
    Effect.catchIf(
      // If it's NOT a retryable error, convert to permanent failure
      (err) => !retryableErrors.some(tag => err._tag === tag),
      (err) => Effect.fail(new PermanentFailure({ cause: err }))
    ),
    Workflow.retry({ maxAttempts: 5 })
  )
);
```

---

## Timeouts

The `Workflow.timeout()` operator sets a deadline for step execution. The deadline persists across workflow restarts.

```typescript
yield* Workflow.step("External API",
  callExternalAPI().pipe(
    Workflow.timeout("30 seconds")
  )
);
```

### Timeout with Retry

When combining timeout and retry, the timeout applies to **each attempt individually**:

```typescript
yield* Workflow.step("API call",
  callAPI().pipe(
    Workflow.timeout("30 seconds"),  // Each attempt has 30 seconds
    Workflow.retry({ maxAttempts: 3 })
  )
);
// Total max time: 3 attempts * 30 seconds = 90 seconds (plus delays)
```

### Duration Formats

Both `timeout` and `sleep` accept Effect duration formats:

```typescript
Workflow.timeout("30 seconds")
Workflow.timeout("5 minutes")
Workflow.timeout("2 hours")
Workflow.timeout(Duration.millis(5000))
Workflow.timeout(Duration.minutes(10))
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
    const user = yield* Workflow.step("Fetch user", fetchUser(userId));

    const emailService = yield* EmailService;
    yield* Workflow.step("Send email",
      emailService.send(user.email, "Hello!").pipe(Effect.asVoid)
    );
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

### Environment-Specific Services

```typescript
const ProductionServices = Layer.mergeAll(
  RealEmailService,
  ProductionDatabase,
  CloudLogging
);

const TestServices = Layer.mergeAll(
  MockEmailService,
  TestDatabase,
  ConsoleLogging
);

// Use different layers based on environment
const services = process.env.NODE_ENV === "production"
  ? ProductionServices
  : TestServices;

const workflow = Workflow.make((input) =>
  workflowLogic(input).pipe(Effect.provide(services))
);
```

---

## Error Types

The library exports typed errors for proper error handling:

```typescript
import {
  StepError,              // Step execution failed
  StepTimeoutError,       // Step exceeded timeout
  StepSerializationError, // Step result not serializable
  StepInfrastructureError,// Framework/storage error
  StorageError,           // Durable Object storage error
  WorkflowCancelledError, // Workflow was cancelled
} from "@durable-effect/workflow";
```

---

## Accessing Workflow Context

> **Note**: Most workflows won't need direct context access. The primitives (`step`, `sleep`, `retry`, `timeout`) handle state management automatically. This section is for advanced use cases like custom metadata storage or debugging.

```typescript
// Access workflow context
const ctx = yield* Workflow.Context;
const workflowId = ctx.workflowId;
const completedSteps = yield* ctx.completedSteps;

// Store workflow-level metadata
yield* ctx.setMeta("orderId", orderId);
const savedOrderId = yield* ctx.getMeta<string>("orderId");

// Access step context (inside a step)
yield* Workflow.step("My step", Effect.gen(function* () {
  const step = yield* Workflow.Step;
  console.log(`Step: ${step.stepName}, Attempt: ${step.attempt + 1}`);
}));
```

---

## License

MIT

---

Built by [Matthew Sessions](https://github.com/matthew-sessions) at [Backpine Labs](https://github.com/backpine)
