import { Effect } from "effect";
import { Workflow, createDurableWorkflows } from "@durable-effect/workflow";

// =============================================================================
// Example Effects (simulated async operations)
// =============================================================================

const fetchOrder = (orderId: string) =>
  Effect.gen(function* () {
    yield* Effect.log(`Fetching order ${orderId}...`);
    yield* Effect.sleep("100 millis");
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

    // Simulate occasional failure
    if (Math.random() < 1) {
      yield* Effect.log("Payment gateway temporarily unavailable");
      return yield* Effect.fail(
        new Error("Payment gateway temporarily unavailable"),
      );
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
    yield* Effect.sleep("100 millis");
    return { sent: true };
  });

// =============================================================================
// Workflow Definitions
// =============================================================================

const processOrderWorkflow = Workflow.make("processOrder", (orderId: string) =>
  Effect.gen(function* () {
    const order = yield* Workflow.step("Fetch order", fetchOrder(orderId));
    // yield* Effect.log(`Sleeping for order ${orderId}`);
    yield* Workflow.sleep("1 seconds");

    const payment = yield* Workflow.step(
      "Process payment",
      processPayment(order).pipe(
        Workflow.retry({ maxAttempts: 2, delay: "2 seconds" }),
      ),
    ).pipe(Effect.tapError((error) => Effect.log(`payment error: ${error}`)));

    yield* Workflow.step(
      "Send confirmation",
      sendConfirmation(order.email, order.id).pipe(
        Workflow.timeout("30 seconds"),
      ),
    );
  }).pipe(
    Effect.tapError((error) => Effect.log(`processOrder error: ${error}`)),
  ),
);

const greetWorkflow = Workflow.make("greet", (input: { name: string }) =>
  Effect.gen(function* () {
    yield* Effect.log(`=== Starting Greet Workflow ===`);

    const greeting = yield* Workflow.step(
      "Generate greeting",
      Effect.succeed(`Hello, ${input.name}!`),
    );

    yield* Effect.log(greeting);
    yield* Effect.log(`=== Greet Workflow Complete ===`);
  }),
);

const scheduledWorkflow = Workflow.make("scheduled", (taskId: string) =>
  Effect.gen(function* () {
    yield* Effect.log("=== Starting Scheduled Workflow ===");

    yield* Workflow.step(
      "Initial task",
      Effect.log(`Processing task ${taskId}`),
    );

    yield* Workflow.sleep("10 seconds");

    yield* Workflow.step(
      "Follow-up task",
      Effect.log(`Follow-up for task ${taskId}`),
    );

    yield* Effect.log("=== Scheduled Workflow Complete ===");
  }),
);

// =============================================================================
// Export Durable Object Class
// =============================================================================

const workflows = {
  processOrder: processOrderWorkflow,
  greet: greetWorkflow,
  scheduled: scheduledWorkflow,
} as const;

export const Workflows = createDurableWorkflows(workflows);

export type WorkflowsType = InstanceType<typeof Workflows>;
