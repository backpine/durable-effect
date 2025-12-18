// src/workflows/index.ts
// Workflow factory - creates Durable Object class and typed client

import { createDurableWorkflows } from "@durable-effect/workflow";
import {
  orderProcessing,
  type OrderInput,
  type OrderResult,
} from "./order-processing";

// =============================================================================
// Create Workflow Engine
// =============================================================================

/**
 * Create the durable workflow engine with all workflow definitions.
 *
 * The keys in this object become the workflow names used in the client.
 *
 * @example
 * ```ts
 * // In your worker
 * const client = WorkflowClient.fromBinding(env.WORKFLOWS);
 *
 * // Run a workflow synchronously (waits for completion)
 * const result = await client.run({
 *   workflow: "orderProcessing",
 *   input: { orderId: "123", items: ["item1"], customerEmail: "test@example.com" }
 * });
 *
 * // Run a workflow asynchronously (returns immediately)
 * const { id } = await client.runAsync({
 *   workflow: "orderProcessing",
 *   input: { orderId: "456", items: ["item2"], customerEmail: "test@example.com" }
 * });
 * ```
 */
export const { Workflows, WorkflowClient } = createDurableWorkflows(
  {
    orderProcessing,
  },
  {
    tracker: {
      env: "production",
      serviceKey: "finance-workflows",
      endpoint: "https://tanstack-trpc-on-cloudflare.backpine.workers.dev/sync",
      retry: {
        maxAttempts: 3,
      },
    },
  },
);

// =============================================================================
// Type Exports
// =============================================================================

export type { OrderInput, OrderResult };
