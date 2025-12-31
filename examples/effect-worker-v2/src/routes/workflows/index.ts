// src/routes/workflows/index.ts
// API routes for Workflows

import * as HttpRouter from "@effect/platform/HttpRouter";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import { Effect, Schema } from "effect";
import { CloudflareEnv } from "@/services";
import { WorkflowClient } from "@/workflows";

// =============================================================================
// Request Schemas
// =============================================================================

const RunWorkflowRequest = Schema.Struct({
  instanceId: Schema.optional(Schema.String),
  orderId: Schema.String,
  items: Schema.Array(Schema.String),
  customerEmail: Schema.String,
});

const InstanceIdRequest = Schema.Struct({
  instanceId: Schema.String,
});

const CancelRequest = Schema.Struct({
  instanceId: Schema.String,
  reason: Schema.optional(Schema.String),
});

// =============================================================================
// Helper to get namespaced instance ID
// =============================================================================

/**
 * Build the full instance ID with workflow namespace.
 * The workflow client uses format: `{workflow}:{id}`
 */
const getFullInstanceId = (orderId: string, instanceId?: string): string => {
  const id = instanceId || orderId;
  return `orderProcessing:${id}`;
};

// =============================================================================
// Routes
// =============================================================================

export const workflowRoutes = HttpRouter.empty.pipe(
  // POST /workflows/run - Run workflow synchronously (waits for completion)
  HttpRouter.post(
    "/run",
    Effect.gen(function* () {
      const { env } = yield* CloudflareEnv;
      const body = yield* HttpServerRequest.schemaBodyJson(RunWorkflowRequest);

      const client = WorkflowClient.fromBinding(env.WORKFLOWS);

      // The execution.id becomes part of the namespaced ID
      const executionId = body.instanceId || body.orderId;

      const result = yield* client.run({
        workflow: "orderProcessing",
        input: {
          orderId: body.orderId,
          items: body.items,
          customerEmail: body.customerEmail,
        },
        execution: { id: executionId },
      });

      return yield* HttpServerResponse.json({
        success: true,
        result: {
          id: result.id,
        },
      });
    }),
  ),

  // POST /workflows/runAsync - Run workflow asynchronously (returns immediately)
  HttpRouter.post(
    "/runAsync",
    Effect.gen(function* () {
      const { env } = yield* CloudflareEnv;
      const body = yield* HttpServerRequest.schemaBodyJson(RunWorkflowRequest);

      const client = WorkflowClient.fromBinding(env.WORKFLOWS);
      const executionId = body.instanceId || body.orderId;

      const result = yield* client.runAsync({
        workflow: "orderProcessing",
        input: {
          orderId: body.orderId,
          items: body.items,
          customerEmail: body.customerEmail,
        },
        execution: { id: executionId },
      });

      return yield* HttpServerResponse.json({
        success: true,
        result: {
          id: result.id,
          message: "Workflow started asynchronously",
        },
      });
    }),
  ),

  // POST /workflows/status - Get workflow status
  HttpRouter.post(
    "/status",
    Effect.gen(function* () {
      const { env } = yield* CloudflareEnv;
      const body = yield* HttpServerRequest.schemaBodyJson(InstanceIdRequest);

      const client = WorkflowClient.fromBinding(env.WORKFLOWS);

      // Build the full namespaced ID
      const fullId = getFullInstanceId(body.instanceId);
      const status = yield* client.status(fullId);

      return yield* HttpServerResponse.json({
        success: true,
        result: {
          instanceId: body.instanceId,
          status,
        },
      });
    }),
  ),

  // POST /workflows/steps - Get completed steps
  HttpRouter.post(
    "/steps",
    Effect.gen(function* () {
      const { env } = yield* CloudflareEnv;
      const body = yield* HttpServerRequest.schemaBodyJson(InstanceIdRequest);

      const client = WorkflowClient.fromBinding(env.WORKFLOWS);

      const fullId = getFullInstanceId(body.instanceId);
      const steps = yield* client.completedSteps(fullId);

      return yield* HttpServerResponse.json({
        success: true,
        result: {
          instanceId: body.instanceId,
          completedSteps: steps,
        },
      });
    }),
  ),

  // POST /workflows/cancel - Cancel a running workflow
  HttpRouter.post(
    "/cancel",
    Effect.gen(function* () {
      const { env } = yield* CloudflareEnv;
      const body = yield* HttpServerRequest.schemaBodyJson(CancelRequest);

      const client = WorkflowClient.fromBinding(env.WORKFLOWS);

      const fullId = getFullInstanceId(body.instanceId);
      const result = yield* client.cancel(fullId, { reason: body.reason });

      return yield* HttpServerResponse.json({
        success: true,
        result: {
          instanceId: body.instanceId,
          cancelled: result.cancelled,
          reason: result.reason,
        },
      });
    }),
  ),
);
