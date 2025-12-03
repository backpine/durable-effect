import { Effect } from "effect";
import { WorkflowClient } from "../workflows";

/**
 * GET /workflows - List available workflows
 */
export const getWorkflows = () =>
  Effect.succeed(
    Response.json({
      workflows: ["processOrder", "greet", "scheduled"],
      endpoints: {
        "POST /workflows/processOrder?orderId=xxx":
          "Start order processing workflow",
        "POST /workflows/greet?name=xxx": "Start greeting workflow",
        "POST /workflows/scheduled?taskId=xxx": "Start scheduled workflow",
        "GET /workflows/:id/status": "Get workflow status",
      },
    }),
  );

/**
 * POST /workflows/processOrder - Start order processing workflow
 */
export const postProcessOrder = (request: Request, env: Env) =>
  Effect.gen(function* () {
    const url = new URL(request.url);
    const orderId = url.searchParams.get("orderId") ?? `order-${Date.now()}`;

    const client = WorkflowClient.fromBinding(env.WORKFLOWS);

    yield* Effect.log(`Starting workflow for order ${orderId}`);

    // Use orderId as the execution ID for idempotency
    const { id } = yield* client.runAsync({
      workflow: "processOrder2",
      input: orderId,
      execution: { id: orderId },
    });

    return Response.json({
      success: true,
      workflowId: id,
      orderId,
    });
  });

/**
 * POST /workflows/greet - Start greeting workflow
 */
export const postGreet = (request: Request, env: Env) =>
  Effect.gen(function* () {
    const url = new URL(request.url);
    const name = url.searchParams.get("name") ?? "World";

    const client = WorkflowClient.fromBinding(env.WORKFLOWS);

    // No execution config = random ID generated
    const { id } = yield* client.runAsync({
      workflow: "greet",
      input: { name },
    });

    return Response.json({
      success: true,
      workflowId: id,
      name,
    });
  });

/**
 * POST /workflows/scheduled - Start scheduled workflow
 */
export const postScheduled = (request: Request, env: Env) =>
  Effect.gen(function* () {
    const url = new URL(request.url);
    const taskId = url.searchParams.get("taskId") ?? `task-${Date.now()}`;

    const client = WorkflowClient.fromBinding(env.WORKFLOWS);

    // Use taskId as the execution ID
    const { id } = yield* client.run({
      workflow: "scheduled",
      input: taskId,
      execution: { id: taskId },
    });

    return Response.json({
      success: true,
      workflowId: id,
      taskId,
    });
  });

/**
 * GET /workflows/:id/status - Get workflow status
 */
export const getWorkflowStatus = (
  _request: Request,
  env: Env,
  instanceId: string,
) =>
  Effect.gen(function* () {
    const client = WorkflowClient.fromBinding(env.WORKFLOWS);

    // instanceId should be the full namespaced ID (e.g., "processOrder:order-123")
    const status = yield* client.status(instanceId);
    const completedSteps = yield* client.completedSteps(instanceId);

    return Response.json({
      instanceId,
      status,
      completedSteps,
    });
  });
