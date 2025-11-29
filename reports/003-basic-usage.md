# Basic Usage Guide

This document shows how to create and use workflows with `@durable-effect/workflow`.

---

## Creating a Workflow

```typescript
import { Effect } from "effect";
import { Workflow, createDurableWorkflows } from "@durable-effect/workflow";

// Define a workflow using Workflow.make
const processOrderWorkflow = Workflow.make(
  "processOrder",
  (orderId: string) =>
    Effect.gen(function* () {
      // Simple step - result is cached
      const order = yield* Workflow.step("Fetch order", fetchOrder(orderId));

      // Step with retry - operators go INSIDE the step
      const payment = yield* Workflow.step(
        "Process payment",
        processPayment(order)
      ).pipe(
        Workflow.retry({ maxAttempts: 3, delay: "5 seconds" })
      )

      // Step with timeout and retry
      yield* Workflow.step(
        "Send confirmation",
        sendConfirmation(order.email).pipe(
          Workflow.timeout("30 seconds"),
          Workflow.retry({ maxAttempts: 2 })
        )
      );

      yield* Effect.log(`Order ${orderId} completed!`);
    })
);
```

---

## Registering Workflows

```typescript
// Create a registry with multiple workflows
const workflows = {
  processOrder: processOrderWorkflow,

  cancelOrder: Workflow.make("cancelOrder", (orderId: string) =>
    Effect.gen(function* () {
      yield* Workflow.step("Refund", refundPayment(orderId));
      yield* Workflow.step("Notify", sendCancellationEmail(orderId));
    })
  ),

  scheduledTask: Workflow.make("scheduledTask", (taskId: string) =>
    Effect.gen(function* () {
      yield* Workflow.step("Process", processTask(taskId));
      yield* Workflow.sleep("1 hour"); // Durable sleep
      yield* Workflow.step("Follow up", followUp(taskId));
    })
  ),
} as const; // <-- Important: use `as const` for type inference

// Create the Durable Object class
export const OrderWorkflows = createDurableWorkflows(workflows);
```

---

## Wrangler Configuration

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

---

## Using from a Worker

```typescript
import { OrderWorkflows } from "./workflows";

export { OrderWorkflows };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const orderId = url.searchParams.get("orderId") ?? "order-123";

    // Get workflow instance
    const id = env.ORDER_WORKFLOWS.idFromName(orderId);
    const stub = env.ORDER_WORKFLOWS.get(id);

    // Start workflow - type-safe dispatch
    const result = await stub.run({
      workflow: "processOrder",
      input: orderId, // TypeScript enforces this is a string
    });

    return Response.json({
      workflowId: result.id,
      status: "started",
    });
  },
};
```

---

## Type-Safe Dispatch

The `run` method uses a discriminated union for type safety:

```typescript
// ✅ Correct - TypeScript knows input should be string
await stub.run({ workflow: "processOrder", input: "order-123" });

// ✅ Correct - TypeScript knows input should be string
await stub.run({ workflow: "cancelOrder", input: "order-456" });

// ❌ Type Error - wrong input type
await stub.run({ workflow: "processOrder", input: { wrong: true } });

// ❌ Type Error - unknown workflow
await stub.run({ workflow: "unknownWorkflow", input: "test" });
```

---

## Accessing Context

### Workflow Context

```typescript
Workflow.make("myWorkflow", (input: string) =>
  Effect.gen(function* () {
    const ctx = yield* Workflow.Context;

    // Read workflow metadata
    yield* Effect.log(`Workflow ID: ${ctx.workflowId}`);
    yield* Effect.log(`Workflow Name: ${ctx.workflowName}`);

    // Store custom metadata
    yield* ctx.setMeta("startedAt", Date.now());

    // Check completed steps
    const completed = yield* ctx.completedSteps;
    yield* Effect.log(`Completed: ${completed.join(", ")}`);

    // Check status
    const status = yield* ctx.status;
    yield* Effect.log(`Status: ${status._tag}`);
  })
);
```

### Step Context

```typescript
yield* Workflow.step(
  "My Step",
  Effect.gen(function* () {
    const step = yield* Workflow.Step;

    yield* Effect.log(`Step: ${step.stepName}`);
    yield* Effect.log(`Attempt: ${step.attempt + 1}`);

    // Store step-level metadata
    yield* step.setMeta("key", { custom: "data" });

    // Read step-level metadata
    const data = yield* step.getMeta<{ custom: string }>("key");

    return result;
  })
);
```

---

## Retry Patterns

### Fixed Delay

```typescript
effect.pipe(
  Workflow.retry({ maxAttempts: 3, delay: "5 seconds" })
);
```

### Exponential Backoff

```typescript
import { Duration } from "effect";

effect.pipe(
  Workflow.retry({
    maxAttempts: 5,
    delay: (attempt) => Duration.millis(1000 * Math.pow(2, attempt)),
    // 1s, 2s, 4s, 8s, 16s
  })
);
```

### Conditional Retry

```typescript
effect.pipe(
  Workflow.retry({
    maxAttempts: 3,
    while: (error) => error instanceof TemporaryError,
  })
);
```

---

## Timeout

```typescript
// Simple timeout
effect.pipe(Workflow.timeout("30 seconds"));

// With Duration
import { Duration } from "effect";
effect.pipe(Workflow.timeout(Duration.minutes(5)));
```

---

## Durable Sleep

```typescript
// Sleep that survives workflow restarts
yield* Workflow.sleep("5 seconds");
yield* Workflow.sleep(Duration.hours(1));
```

---

## Querying Status

```typescript
const stub = env.ORDER_WORKFLOWS.get(id);

// Get current status
const status = await stub.getStatus();
// { _tag: 'Running' }
// { _tag: 'Paused', reason: 'retry', resumeAt: 1234567890 }
// { _tag: 'Completed', completedAt: 1234567890 }
// { _tag: 'Failed', error: '...', failedAt: 1234567890 }

// Get completed steps
const steps = await stub.getCompletedSteps();
// ['Fetch order', 'Process payment']

// Get custom metadata
const meta = await stub.getMeta<{ startedAt: number }>("startedAt");
```

---

## Complete Example

```typescript
// workflows/order.ts
import { Effect } from "effect";
import { Workflow, createDurableWorkflows } from "@durable-effect/workflow";

const fetchOrder = (id: string) =>
  Effect.succeed({ id, amount: 99.99, email: "user@example.com" });

const processPayment = (order: { id: string; amount: number }) =>
  Effect.gen(function* () {
    yield* Effect.log(`Charging $${order.amount}`);
    // Simulate occasional failure
    if (Math.random() < 0.3) {
      return yield* Effect.fail(new Error("Payment failed"));
    }
    return { transactionId: `txn_${Date.now()}` };
  });

const sendEmail = (to: string, orderId: string) =>
  Effect.gen(function* () {
    yield* Effect.log(`Sending email to ${to}`);
    return { sent: true };
  });

export const workflows = {
  processOrder: Workflow.make("processOrder", (orderId: string) =>
    Effect.gen(function* () {
      const ctx = yield* Workflow.Context;
      yield* ctx.setMeta("startedAt", Date.now());

      const order = yield* Workflow.step("Fetch order", fetchOrder(orderId));

      const payment = yield* Workflow.step(
        "Process payment",
        processPayment(order).pipe(
          Workflow.retry({ maxAttempts: 3, delay: "2 seconds" })
        )
      );

      yield* Workflow.step(
        "Send confirmation",
        sendEmail(order.email, orderId).pipe(Workflow.timeout("30 seconds"))
      );

      yield* ctx.setMeta("completedAt", Date.now());
      yield* ctx.setMeta("transactionId", payment.transactionId);
    })
  ),
} as const;

export const OrderWorkflows = createDurableWorkflows(workflows);
```

```typescript
// index.ts
import { OrderWorkflows } from "./workflows/order";

export { OrderWorkflows };

interface Env {
  ORDER_WORKFLOWS: DurableObjectNamespace<OrderWorkflows>;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/orders") {
      const orderId = crypto.randomUUID();
      const id = env.ORDER_WORKFLOWS.idFromName(orderId);
      const stub = env.ORDER_WORKFLOWS.get(id);

      const result = await stub.run({
        workflow: "processOrder",
        input: orderId,
      });

      return Response.json({ orderId, workflowId: result.id });
    }

    if (request.method === "GET" && url.pathname.startsWith("/orders/")) {
      const orderId = url.pathname.split("/")[2];
      const id = env.ORDER_WORKFLOWS.idFromName(orderId);
      const stub = env.ORDER_WORKFLOWS.get(id);

      const status = await stub.getStatus();
      const steps = await stub.getCompletedSteps();

      return Response.json({ orderId, status, completedSteps: steps });
    }

    return new Response("Not found", { status: 404 });
  },
};
```
