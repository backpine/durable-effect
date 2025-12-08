import { Effect } from "effect";
import { WorkflowClient } from "../workflows";

/**
 * GET /workflows - List available workflows
 */
export const getWorkflows = () =>
  Effect.succeed(
    Response.json({
      workflows: ["processOrder"],
      endpoints: {
        "GET /workflows/processOrder?orderId=xxx":
          "Start order processing workflow",
        "GET /workflows/:id/status": "Get workflow status",
      },
    }),
  );

/**
 * GET /workflows/processOrder - Start order processing workflow
 */
export const getProcessOrder = (request: Request, env: Env) =>
  Effect.gen(function* () {
    const url = new URL(request.url);
    const orderId = url.searchParams.get("orderId") ?? `order-${Date.now()}`;

    const client = WorkflowClient.fromBinding(env.WORKFLOWS);

    yield* Effect.log(`Starting workflow for order ${orderId}`);
    const { id } = yield* Effect.promise(() =>
      client.runAsync({
        workflow: "processOrder",
        input: orderId,
        executionId: orderId,
      }),
    );

    return Response.json({
      success: true,
      workflowId: id,
      orderId,
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

    const instance = yield* Effect.promise(() =>
      client.getInstance({ workflow: "processOrder", id: instanceId }),
    );
    const status = yield* Effect.promise(() => instance.status());

    return Response.json({
      instanceId,
    });
  });
