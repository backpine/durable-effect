import { Effect } from "effect";
import { CloudflareEnv, HonoCtx, type RouteEffect } from "../adapter";
import { WorkflowClient } from "../workflows";

/**
 * GET /workflows - List available workflows
 */
export const getWorkflows: RouteEffect<Response> = Effect.gen(function* () {
  const c = yield* HonoCtx;
  return c.json({
    workflows: ["processOrder", "generateReport"],
    endpoints: {
      "GET /workflows/processOrder?orderId=xxx":
        "Start order processing workflow",
      "GET /workflows/generateReport?reportId=xxx":
        "Start report generation workflow",
      "GET /workflows/:id/status": "Get workflow status",
    },
  });
});

/**
 * GET /workflows/processOrder - Start order processing workflow
 */
export const getProcessOrder: RouteEffect<Response> = Effect.gen(function* () {
  const c = yield* HonoCtx;
  const env = yield* CloudflareEnv;

  const orderId = c.req.query("orderId") ?? `order-${Date.now()}`;
  const client = WorkflowClient.fromBinding(env.WORKFLOWS);

  yield* Effect.log(`Starting workflow for order ${orderId}`);

  const { id } = yield* client.runAsync({
    workflow: "processOrder",
    input: orderId,
    execution: { id: orderId },
  });

  return c.json({
    success: true,
    workflowId: id,
    orderId,
  });
});

/**
 * GET /workflows/generateReport - Start report generation workflow
 */
export const getGenerateReport: RouteEffect<Response> = Effect.gen(
  function* () {
    const c = yield* HonoCtx;
    const env = yield* CloudflareEnv;

    const processId = c.req.query("reportId") ?? `report-${Date.now()}`;
    const client = WorkflowClient.fromBinding(env.WORKFLOWS);

    const processOrderRes = yield* client.runAsync({
      workflow: "processOrder",
      input: processId,
      execution: { id: processId },
    });

    yield* Effect.log(`Starting report generation workflow for ${processId}`);

    const generateReportRes = yield* client.runAsync({
      workflow: "generateReport",
      input: processId,
      execution: { id: processId },
    });

    return c.json({
      success: true,
      workflowId: processId,
      processOrderRes,
      generateReportRes,
    });
  },
);

/**
 * GET /workflows/:id/status - Get workflow status
 */
export const getWorkflowStatus: RouteEffect<Response> = Effect.gen(
  function* () {
    const c = yield* HonoCtx;
    const env = yield* CloudflareEnv;

    const instanceId = c.req.param("id");
    const client = WorkflowClient.fromBinding(env.WORKFLOWS);

    const status = yield* client.status(instanceId);

    return c.json({
      instanceId,
      status,
    });
  },
);
