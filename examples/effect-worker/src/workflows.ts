import { Effect } from "effect";
import {
  Backoff,
  Workflow,
  createDurableWorkflows,
} from "@durable-effect/workflow-v2";

// =============================================================================
// Example Effects (simulated async operations)
// =============================================================================

const randomDelay = () =>
  Effect.promise(() => {
    const ms = 2000 + Math.random() * 2000; // 2-4 seconds
    return new Promise((resolve) => setTimeout(resolve, ms));
  });

const fetchOrder = (orderId: string) =>
  Effect.gen(function* () {
    yield* Effect.log(`Fetching order ${orderId}...`);

    yield* randomDelay();
    return {
      id: orderId,
      amount: 99.99,
      email: "customer@example.com",
      items: ["item1", "item2"],
    };
  });

const processPayment = (order: { id: string; amount: number }) =>
  Effect.gen(function* () {
    yield* Effect.log(
      `Processing payment for order ${order.id}: $${order.amount}`,
    );
    yield* randomDelay();

    // 70% chance of failure
    if (Math.random() < 0.9) {
      yield* Effect.fail(new Error("Payment processing failed"));
    }

    return {
      transactionId: `txn_${Date.now()}`,
      amount: order.amount,
      status: "completed" as const,
    };
  });

const sendConfirmation = (email: string, orderId: string) =>
  Effect.gen(function* () {
    yield* Effect.log(`Sending confirmation to ${email} for order ${orderId}`);
    yield* randomDelay();
    return { sent: true };
  });

// =============================================================================
// Workflow Definition
// =============================================================================
const processOrderWorkflow = Workflow.make((orderId: string) =>
  Effect.gen(function* () {
    const order = yield* Workflow.step("Fetch order", fetchOrder(orderId));
    yield* Workflow.sleep("3 seconds");
    yield* Workflow.step(
      "Validate",
      Effect.gen(function* () {
        yield* Effect.log(`Validating order: ${order.id}`);
        return { valid: true };
      }),
    );
    yield* Workflow.sleep("1 seconds");

    const payment = yield* Workflow.step(
      "Process payment",
      processPayment(order).pipe(
        Workflow.retry({
          maxAttempts: 3,
          delay: Backoff.exponential({
            max: "6 seconds",
            base: "1 second",
          }),
        }),
      ),
    );

    yield* Workflow.step(
      "Send confirmation",
      sendConfirmation(order.email, order.id),
    );
    yield* Workflow.sleep("1 seconds");

    return { order, payment };
  }),
);

// =============================================================================
// Export Durable Object Class and Client
// =============================================================================

const workflows = {
  processOrder: processOrderWorkflow,
} as const;

export const { Workflows, WorkflowClient } = createDurableWorkflows(workflows, {
  tracker: {
    env: "production",
    serviceKey: "finance-workflows",
    endpoint: "https://tanstack-trpc-on-cloudflare.backpine.workers.dev/sync",
    batchSize: 2,

    retry: {
      maxAttempts: 2,
    },
  },
});
export type WorkflowsType = typeof Workflows;
