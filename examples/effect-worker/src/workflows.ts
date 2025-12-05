import { Effect, Data, Context } from "effect";
import { Workflow, createDurableWorkflows } from "@durable-effect/workflow";

// =============================================================================
// Services
// =============================================================================

class PaymentGateway extends Context.Tag("PaymentGateway")<
  PaymentGateway,
  {
    readonly charge: (
      amount: number,
    ) => Effect.Effect<{ transactionId: string }, PaymentDeclinedError>;
    readonly refund: (transactionId: string) => Effect.Effect<void>;
  }
>() {}

const FakePaymentGateway = PaymentGateway.of({
  charge: (amount) =>
    Effect.succeed({ transactionId: `fake_txn_${Date.now()}` }),
  refund: () => Effect.void,
});

// =============================================================================
// Tagged Errors
// =============================================================================

class PaymentDeclinedError extends Data.TaggedError("PaymentDeclinedError")<{
  readonly orderId: string;
  readonly reason: string;
}> {}

class InsufficientFundsError extends Data.TaggedError(
  "InsufficientFundsError",
)<{
  readonly orderId: string;
  readonly required: number;
  readonly available: number;
}> {}

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
    const gateway = yield* PaymentGateway;

    yield* Effect.log(
      `Processing payment for order ${order.id}: $${order.amount}`,
    );
    yield* randomDelay();

    const random = Math.random();
    // 35% chance of InsufficientFundsError
    if (random < 0.35) {
      yield* new InsufficientFundsError({
        orderId: order.id,
        required: order.amount,
        available: order.amount * 0.5,
      });
    }
    // 35% chance of PaymentDeclinedError
    if (random < 0.7) {
      yield* new PaymentDeclinedError({
        orderId: order.id,
        reason: "Card declined by issuer",
      });
    }

    // Use the gateway service to charge
    const result = yield* gateway.charge(order.amount);

    return {
      transactionId: result.transactionId,
      amount: order.amount,
      status: "completed" as const,
    };
  });

const sendConfirmation = (email: string, orderId: string) =>
  Effect.gen(function* () {
    yield* Effect.log(`Sending confirmation to ${email} for order ${orderId}`);
    yield* randomDelay();
    return () => {
      sent: true;
    };
  });

// =============================================================================
// Workflow Definition
// =============================================================================

const processOrderWorkflow = Workflow.make((orderId: string) =>
  Effect.gen(function* () {
    const order = yield* Workflow.step("Fetch order", fetchOrder(orderId));
    yield* Workflow.sleep("3 seconds");
    const validation = yield* Workflow.step(
      `Validate`,
      Effect.gen(function* () {
        yield* Effect.log(`Validating order: ${order.id}`);
        yield* randomDelay();
        return { valid: true };
      }),
    );
    yield* Workflow.sleep("1 seconds");

    const payment = yield* Workflow.step(
      `Process payment`,
      processPayment(order).pipe(
        Effect.catchTag("PaymentDeclinedError", () =>
          Effect.succeed({
            transactionId: "recovered",
            amount: 0,
            status: "completed" as const,
          }),
        ),
        Workflow.retry({
          maxAttempts: 5,
          delay: "1 second",
        }),
      ),
    );

    const d = yield* Workflow.step(
      "Send confirmation",
      sendConfirmation(order.email, order.id),
    );
    console.log({ orderIg: orderId });
    yield* Workflow.sleep("1 seconds");
  }).pipe(Effect.provideService(PaymentGateway, FakePaymentGateway)),
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
    url: "https://tanstack-trpc-on-cloudflare.backpine.workers.dev/sync",
    accessToken: "token",
    retry: {
      maxAttempts: 2,
    },
    batch: {
      maxSize: 20,
    },
  },
});
export type WorkflowsType = typeof Workflows;
