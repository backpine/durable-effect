import { Effect } from "effect";

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

    const id = env.WORKFLOWS.idFromName(orderId);
    const stub = env.WORKFLOWS.get(id);
    yield* Effect.log(`Starting workflow for order ${orderId}`);
    const result = yield* Effect.tryPromise({
      try: () =>
        stub.runAsync({
          workflow: "processOrder",
          input: "test it",
        }),
      catch: (e) => new Error(`Failed to start workflow: ${e}`),
    });

    return Response.json({
      success: true,
      workflowId: "d",
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

    const id = env.WORKFLOWS.idFromName(`greet-${name}`);
    const stub = env.WORKFLOWS.get(id);

    const result = yield* Effect.tryPromise({
      try: () =>
        stub.run({
          workflow: "greet",
          input: { name },
        }),
      catch: (e) => new Error(`Failed to start workflow: ${e}`),
    });

    return Response.json({
      success: true,
      workflowId: "result.id",
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

    const id = env.WORKFLOWS.idFromName(taskId);
    const stub = env.WORKFLOWS.get(id);

    const result = yield* Effect.tryPromise({
      try: () =>
        stub.run({
          workflow: "scheduled",
          input: taskId,
        }),
      catch: (e) => new Error(`Failed to start workflow: ${e}`),
    });

    return Response.json({
      success: true,
      workflowId: "result.id",
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
    const id = env.WORKFLOWS.idFromName(instanceId);
    const stub = env.WORKFLOWS.get(id);

    const [status, completedSteps] = yield* Effect.tryPromise({
      try: async () => {
        const status = await stub.getStatus();
        const completedSteps = await stub.getCompletedSteps();
        return [status, completedSteps] as const;
      },
      catch: (e) => new Error(`Failed to get workflow status: ${e}`),
    });

    return Response.json({
      instanceId,
      status,
      completedSteps,
    });
  });
