import { Effect } from "effect";
import { Workflow, createDurableWorkflows } from "@durable-effect/workflow";

// =============================================================================
// Example Effects (simulated async operations)
// =============================================================================

const fetchOrder = (orderId: string) =>
  Effect.gen(function* () {
    yield* Effect.log(`Fetching order ${orderId}...`);
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

    yield* Effect.promise(
      () => new Promise((resolve) => setTimeout(resolve, 2000)),
    );

    return {
      transactionId: `txn_${Date.now()}`,
      amount: order.amount,
      status: "completed" as const,
    };
  });

const sendConfirmation = (email: string, orderId: string) =>
  Effect.gen(function* () {
    yield* Effect.log(`Sending confirmation to ${email} for order ${orderId}`);
    return { sent: true };
  });

// =============================================================================
// Workflow Definition
// =============================================================================

const processOrderWorkflow = Workflow.make(
  "Process New Order",
  (orderId: string) =>
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
          // Workflow.retry({
          //   maxAttempts: 2,
          //   delay: "1 second",
          // }),
          Workflow.timeout("1 second"),
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
    serviceKey: "my-app",
    url: "http://localhost:3000/sync",
    accessToken: "token",
  },
});
export type WorkflowsType = typeof Workflows;
