# User Experience Guide

This document shows how end users will interact with `@durable-effect/workflow`.

---

## Installation

```bash
pnpm add @durable-effect/workflow effect
```

---

## Quick Start

### 1. Define a Workflow

```typescript
// src/workflows/order.ts
import { Effect } from "effect";
import {
  createDurableWorkflows,
  step,
  durableRetry,
  durableTimeout,
  WorkflowExecutionContext,
  StepExecutionContext,
} from "@durable-effect/workflow";

// Define your workflow
export const OrderWorkflows = createDurableWorkflows<Env>()({
  processOrder: (orderId: string) =>
    Effect.gen(function* () {
      // Access workflow context
      const workflow = yield* WorkflowExecutionContext;
      yield* Effect.log(`Starting workflow ${workflow.workflowId}`);

      // Step 1: Fetch order (result is cached)
      const order = yield* step("Fetch order", fetchOrder(orderId));

      // Step 2: Process payment with retry
      const payment = yield* step(
        "Process payment",
        processPayment(order).pipe(
          durableRetry({ maxAttempts: 3, delayMs: 5000 })
        )
      );

      // Step 3: Send confirmation with timeout
      yield* step(
        "Send confirmation",
        sendConfirmationEmail(order.email, payment.transactionId).pipe(
          durableTimeout(30_000)
        )
      );

      // Store workflow result
      yield* workflow.setMeta("completedAt", Date.now());
    }),
});

// Type-safe helper functions
const fetchOrder = (orderId: string) =>
  Effect.gen(function* () {
    yield* Effect.log(`Fetching order ${orderId}`);
    // ... fetch from database
    return { id: orderId, amount: 99.99, email: "user@example.com" };
  });

const processPayment = (order: { id: string; amount: number }) =>
  Effect.gen(function* () {
    yield* Effect.log(`Processing payment for ${order.id}`);
    // ... call payment provider
    return { transactionId: `txn_${Date.now()}` };
  });

const sendConfirmationEmail = (email: string, transactionId: string) =>
  Effect.gen(function* () {
    yield* Effect.log(`Sending confirmation to ${email}`);
    // ... send email
  });
```

### 2. Configure Wrangler

```toml
# wrangler.toml
name = "my-worker"
main = "src/index.ts"

[[durable_objects.bindings]]
name = "ORDER_WORKFLOWS"
class_name = "OrderWorkflows"

[[migrations]]
tag = "v1"
new_classes = ["OrderWorkflows"]
```

### 3. Export and Use from Worker

```typescript
// src/index.ts
import { OrderWorkflows } from "./workflows/order";

export { OrderWorkflows };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/orders/")) {
      const orderId = url.pathname.split("/")[2];

      // Get or create workflow instance
      const id = env.ORDER_WORKFLOWS.idFromName(`order-${orderId}`);
      const stub = env.ORDER_WORKFLOWS.get(id);

      if (request.method === "POST") {
        // Start the workflow
        await stub.run("processOrder", orderId);
        return new Response(JSON.stringify({ status: "started" }));
      }

      if (request.method === "GET") {
        // Check workflow status
        const status = await stub.getStatus();
        const completedSteps = await stub.getCompletedSteps();
        return new Response(JSON.stringify({ status, completedSteps }));
      }
    }

    return new Response("Not found", { status: 404 });
  },
};
```

---

## Core Concepts

### Steps

Steps are the fundamental unit of work. Each step:
- Executes exactly once (cached on success)
- Replays instantly on workflow resume
- Provides `StepExecutionContext` to the handler

```typescript
// Simple step
const user = yield* step("Fetch user", fetchUser(userId));

// Access step context
yield* step("Custom step", Effect.gen(function* () {
  const ctx = yield* StepExecutionContext;
  yield* Effect.log(`Step: ${ctx.stepName}, Attempt: ${ctx.attempt}`);

  // Store step-level metadata
  yield* ctx.setMeta("startedAt", Date.now());

  return yield* doWork();
}));
```

### Workflow Context

Access workflow-level information and metadata:

```typescript
const myWorkflow = (input: string) =>
  Effect.gen(function* () {
    const ctx = yield* WorkflowExecutionContext;

    // Read-only properties
    console.log(ctx.workflowName);  // "myWorkflow"
    console.log(ctx.workflowId);    // "abc123..."
    console.log(ctx.workflowInput); // input value

    // Query status
    const status = yield* ctx.getStatus();           // "running" | "paused" | ...
    const steps = yield* ctx.getCompletedSteps();    // ["Step 1", "Step 2"]

    // Custom metadata
    yield* ctx.setMeta("customKey", { foo: "bar" });
    const data = yield* ctx.getMeta<{ foo: string }>("customKey");
    yield* ctx.deleteMeta("customKey");
  });
```

---

## Operators

### `durableRetry`

Retry failed steps with durable state:

```typescript
// Basic retry
yield* step("Send email",
  sendEmail().pipe(
    durableRetry({ maxAttempts: 3 })
  )
);

// With delay
yield* step("Call API",
  callAPI().pipe(
    durableRetry({ maxAttempts: 5, delayMs: 2000 })
  )
);

// Exponential backoff
yield* step("Sync data",
  syncData().pipe(
    durableRetry({
      maxAttempts: 5,
      delayMs: 1000,
      backoff: "exponential",
      maxDelayMs: 60_000
    })
  )
);

// Conditional retry
yield* step("Process",
  process().pipe(
    durableRetry({
      maxAttempts: 3,
      retryIf: (error) => error instanceof TransientError
    })
  )
);
```

### `durableTimeout`

Set a deadline that persists across restarts:

```typescript
// Simple timeout
yield* step("Long task",
  longTask().pipe(
    durableTimeout(30_000) // 30 seconds
  )
);

// With options
yield* step("Long task",
  longTask().pipe(
    durableTimeout({ duration: 30_000 })
  )
);

// Combined with retry (timeout applies across all attempts)
yield* step("Fetch with deadline",
  fetchData().pipe(
    durableTimeout(60_000),
    durableRetry({ maxAttempts: 3 })
  )
);
```

---

## Multiple Workflows

Define multiple workflows in a single Durable Object:

```typescript
export const Workflows = createDurableWorkflows<Env>()({
  // Order processing
  processOrder: (orderId: string) =>
    Effect.gen(function* () {
      yield* step("Validate", validateOrder(orderId));
      yield* step("Charge", chargePayment(orderId));
      yield* step("Fulfill", fulfillOrder(orderId));
    }),

  // Order cancellation
  cancelOrder: (orderId: string) =>
    Effect.gen(function* () {
      yield* step("Refund", refundPayment(orderId));
      yield* step("Notify", sendCancellationEmail(orderId));
    }),

  // Scheduled cleanup
  cleanupStaleOrders: () =>
    Effect.gen(function* () {
      yield* step("Find stale", findStaleOrders());
      yield* step("Archive", archiveOrders());
    }),
});

// Usage
await stub.run("processOrder", "order-123");
await stub.run("cancelOrder", "order-456");
```

---

## Error Handling

### Step-Level Errors

Errors in steps are captured and can trigger retry:

```typescript
yield* step("Risky operation",
  Effect.gen(function* () {
    const result = yield* riskyCall();
    if (!result.ok) {
      // This will trigger retry if durableRetry is applied
      return yield* Effect.fail(new Error("Operation failed"));
    }
    return result;
  }).pipe(
    durableRetry({ maxAttempts: 3 })
  )
);
```

### Workflow-Level Errors

Catch and handle errors at workflow level:

```typescript
const myWorkflow = (input: string) =>
  Effect.gen(function* () {
    yield* step("Step 1", doStep1());
    yield* step("Step 2", doStep2());
  }).pipe(
    Effect.catchTag("StepTimeoutError", (err) =>
      Effect.gen(function* () {
        yield* Effect.log(`Step ${err.stepName} timed out`);
        // Handle timeout...
      })
    ),
    Effect.catchTag("RetriesExhaustedError", (err) =>
      Effect.gen(function* () {
        yield* Effect.log(`Step ${err.stepName} failed after ${err.attempts} attempts`);
        // Handle failure...
      })
    )
  );
```

---

## Monitoring & Observability

### Query Workflow Status

```typescript
// From Worker
const stub = env.ORDER_WORKFLOWS.get(id);

const status = await stub.getStatus();
// "pending" | "running" | "paused" | "completed" | "failed"

const completedSteps = await stub.getCompletedSteps();
// ["Fetch order", "Process payment"]

const customMeta = await stub.getMeta<{ completedAt: number }>("completedAt");
```

### Logging

Use Effect's built-in logging:

```typescript
yield* step("Process",
  Effect.gen(function* () {
    yield* Effect.log("Starting process");
    yield* Effect.logDebug("Debug info");
    yield* Effect.logWarning("Warning message");
    yield* Effect.logError("Error occurred");

    // Structured logging
    yield* Effect.log("Processing order").pipe(
      Effect.annotateLogs({ orderId: "123", step: "process" })
    );

    return result;
  })
);
```

---

## Advanced Patterns

### Conditional Steps

```typescript
const workflow = (input: { premium: boolean }) =>
  Effect.gen(function* () {
    yield* step("Basic processing", basicProcess());

    if (input.premium) {
      yield* step("Premium features", premiumProcess());
    }

    yield* step("Finalize", finalize());
  });
```

### Parallel Steps (Future)

```typescript
// Note: This pattern may be supported in future versions
const workflow = () =>
  Effect.gen(function* () {
    // Sequential for now
    const a = yield* step("Task A", taskA());
    const b = yield* step("Task B", taskB());
    const c = yield* step("Task C", taskC());

    yield* step("Combine", combine(a, b, c));
  });
```

### Sub-workflows (Future)

```typescript
// Note: Pattern under consideration
const parentWorkflow = () =>
  Effect.gen(function* () {
    yield* step("Start", start());
    yield* step("Child workflow", childWorkflow());
    yield* step("Complete", complete());
  });
```

---

## Type Safety

Full TypeScript support with inferred types:

```typescript
// Workflow input/output types
type OrderInput = { orderId: string; priority: "normal" | "high" };
type OrderOutput = { transactionId: string; completedAt: number };

const workflow: WorkflowDefinition<OrderInput, OrderOutput> = (input) =>
  Effect.gen(function* () {
    // input is typed as OrderInput
    const order = yield* step("Fetch", fetchOrder(input.orderId));

    // Step return types are inferred
    const payment = yield* step("Pay", processPayment(order));
    // payment is typed based on processPayment return type

    return {
      transactionId: payment.transactionId,
      completedAt: Date.now(),
    };
  });

// Type-safe workflow invocation
await stub.run("processOrder", { orderId: "123", priority: "high" });
// TypeScript error: await stub.run("processOrder", { wrong: "type" });
```

---

## Best Practices

### 1. Name Steps Clearly

Step names are used for caching and debugging:

```typescript
// Good
yield* step("Fetch user from database", fetchUser(id));
yield* step("Send welcome email", sendEmail(user));

// Avoid
yield* step("step1", fetchUser(id));
yield* step("do thing", sendEmail(user));
```

### 2. Keep Steps Idempotent

Steps may be replayed, so ensure side effects are safe:

```typescript
// Good - idempotent
yield* step("Create order", createOrderIdempotent(orderId, data));

// Risky - may create duplicates
yield* step("Create order", createOrder(data));
```

### 3. Use Appropriate Timeouts

Set timeouts based on expected duration:

```typescript
// API call - short timeout
yield* step("Quick API", quickAPI().pipe(durableTimeout(5_000)));

// Email sending - medium timeout
yield* step("Send email", sendEmail().pipe(durableTimeout(30_000)));

// Heavy processing - longer timeout
yield* step("Generate report", generateReport().pipe(durableTimeout(300_000)));
```

### 4. Handle All Error Cases

```typescript
const robustWorkflow = () =>
  Effect.gen(function* () {
    yield* step("Critical", criticalWork());
  }).pipe(
    Effect.catchAll((error) =>
      Effect.gen(function* () {
        const ctx = yield* WorkflowExecutionContext;
        yield* ctx.setMeta("error", String(error));
        yield* Effect.logError("Workflow failed", error);
      })
    )
  );
```
