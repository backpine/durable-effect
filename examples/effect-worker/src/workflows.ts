import { Effect } from "effect";
import {
  Workflow,
  WorkflowContext,
  createDurableWorkflows,
} from "@durable-effect/workflow";

// =============================================================================
// Example Effects (simulated async operations)
// =============================================================================

const fetchOrder = (orderId: string) =>
  Effect.gen(function* () {
    yield* Effect.log(`Fetching order ${orderId}...`);
    yield* Effect.sleep("100 millis");
    yield* Effect.log(`Inner Sleep 10 seconds ${orderId}...`);

    yield* Effect.log(`done inner sleep`);

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
    if (Math.random() < 0.3) {
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
    yield* Effect.sleep("10 seconds");
    return { sent: true };
  });

// =============================================================================
// Workflow Definitions
// =============================================================================

const processOrderWorkflow = Workflow.make("processOrder", (orderId: string) =>
  Effect.gen(function* () {
    console.log("[workflow] Starting processOrder workflow, orderId:", orderId);
    const order = yield* Workflow.step("Fetch order", fetchOrder(orderId));
    console.log("[workflow] Fetch order step completed");

    yield* Workflow.step(
      "Vaidate",
      Effect.gen(function* () {
        yield* Effect.log(`basic order: ${order}`);
        yield* Effect.sleep("10 seconds");
        return { sent: true };
      }),
    );
    // yield* Effect.log(`Sleeping for order ${orderId}`);
    // const pauseIndex = yield* workflowCtx.nextPauseIndex;
    // const completedIndex = yield* workflowCtx.completedPauseIndex;

    console.log("[workflow] About to sleep for 3 seconds");
    yield* Workflow.sleep("5 seconds");
    console.log("[workflow] Sleep completed - should only see this once!");

    const payment = yield* Workflow.step(
      "Process payment",
      processPayment(order).pipe(
        Workflow.retry({ maxAttempts: 2, delay: "2 seconds" }),
      ),
    ).pipe(Effect.tapError((error) => Effect.log(`payment error: ${error}`)));
    console.log("[workflow] About to sleep for 1 seconds");
    yield* Workflow.sleep("1 seconds");
    console.log("[workflow] Sleep completed - should only see this once!");
    yield* Workflow.step(
      "Send confirmation",
      sendConfirmation(order.email, order.id).pipe(
        Workflow.timeout("40 seconds"),
        Workflow.retry({ maxAttempts: 3, delay: "1 second" }),
      ),
    ).pipe(
      Effect.tapError((error) =>
        Effect.log(`[[[confirmation error]]]: ${error}`),
      ),
    );
    // console.log("[workflow] About to sleep for 4 seconds");
    // yield* Workflow.sleep("4 seconds");
    // console.log("[workflow] About to sleep for 5 seconds");
    // yield* Workflow.sleep("5 seconds");
    // console.log("[workflow] About to sleep for 6 seconds");
    // yield* Workflow.sleep("6 seconds");
    // console.log("[workflow] done");
  }),
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

export const Workflows = createDurableWorkflows(workflows, {
  tracker: {
    env: "prod",
    serviceKey: "test-service",
    accessToken: "your-access-token",
    url: "http://localhost:3000/sync",
    batch: {
      maxSize: 5,
      maxWaitMs: 200,
    },
  },
});

export type WorkflowsType = InstanceType<typeof Workflows>;
