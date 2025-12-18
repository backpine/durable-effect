// src/workflows/order-processing.ts
// Example workflow that demonstrates steps, sleep, and retry

import { Effect } from "effect";
import { Workflow, Backoff } from "@durable-effect/workflow";

// =============================================================================
// Types
// =============================================================================

export interface OrderInput {
  orderId: string;
  items: readonly string[];
  customerEmail: string;
}

export interface OrderResult {
  orderId: string;
  status: "completed" | "failed";
  totalSteps: number;
  processedAt: string;
}

// =============================================================================
// Workflow Definition
// =============================================================================

/**
 * Order processing workflow.
 *
 * Demonstrates:
 * - Multiple steps with automatic caching
 * - Sleep between steps
 * - Retry configuration
 * - Step-level error handling
 */
export const orderProcessing = Workflow.make((input: OrderInput) =>
  Effect.gen(function* () {
    // Step 1: Validate the order
    const validation = yield* Workflow.step({
      name: "validateOrder",
      execute: Effect.gen(function* () {
        console.log(`[Order ${input.orderId}] Validating order...`);
        // Simulate validation
        yield* Effect.sleep("100 millis");
        return {
          valid: true,
          itemCount: input.items.length,
          validatedAt: new Date().toISOString(),
        };
      }),
      retry: { maxAttempts: 3, delay: "1 second" },
    });

    console.log(`[Order ${input.orderId}] Validation result:`, validation);

    // Step 2: Reserve inventory
    yield* Workflow.step({
      name: "reserveInventory",
      execute: Effect.gen(function* () {
        console.log(
          `[Order ${input.orderId}] Reserving inventory for ${validation.itemCount} items...`,
        );
        yield* Effect.sleep("100 millis");
        return { reserved: true };
      }),
      retry: { maxAttempts: 3, delay: "500 millis" },
    });

    // Wait a bit before processing payment (demonstrates sleep)
    console.log(
      `[Order ${input.orderId}] Waiting before payment processing...`,
    );
    yield* Workflow.sleep("2 seconds");

    // Step 3: Process payment
    const payment = yield* Workflow.step({
      name: "processPayment",
      execute: Effect.gen(function* () {
        console.log(`[Order ${input.orderId}] Processing payment...`);
        yield* Effect.sleep("100 millis");
        return {
          transactionId: `txn-${Date.now()}`,
          amount: input.items.length * 10.0,
          processedAt: new Date().toISOString(),
        };
      }),
      retry: {
        maxAttempts: 5,
        delay: Backoff.exponential({ base: "1 second" }),
      },
    });

    console.log(
      `[Order ${input.orderId}] Payment processed:`,
      payment.transactionId,
    );

    // Step 4: Send confirmation email
    yield* Workflow.step({
      name: "sendConfirmation",
      execute: Effect.gen(function* () {
        console.log(
          `[Order ${input.orderId}] Sending confirmation to ${input.customerEmail}...`,
        );
        yield* Effect.sleep("100 millis");
        return { sent: true, email: input.customerEmail };
      }),
    });

    // Return final result
    return {
      orderId: input.orderId,
      status: "completed" as const,
      totalSteps: 4,
      processedAt: new Date().toISOString(),
    };
  }),
);
