// src/routes/jobs/task.ts
// API routes for Task jobs

import * as HttpRouter from "@effect/platform/HttpRouter";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import { Effect, Schema } from "effect";
import { CloudflareEnv } from "@/services";
import { JobsClient } from "@/jobs";

// =============================================================================
// Request Schemas
// =============================================================================

const SendEventRequest = Schema.Struct({
  id: Schema.String,
  targetRuns: Schema.Number,
});

const IdRequest = Schema.Struct({
  id: Schema.String,
});

// =============================================================================
// Routes
// =============================================================================

export const taskRoutes = HttpRouter.empty.pipe(
  // POST /task/send - Start a task with target run count
  HttpRouter.post(
    "/send",
    Effect.gen(function* () {
      const { env } = yield* CloudflareEnv;
      const client = JobsClient.fromBinding(env.JOBS);
      const body = yield* HttpServerRequest.schemaBodyJson(SendEventRequest);

      const result = yield* client.task("basicTask").send({
        id: body.id,
        event: { targetRuns: body.targetRuns },
      });

      return yield* HttpServerResponse.json({
        success: true,
        result: {
          instanceId: result.instanceId,
          scheduledAt: result.scheduledAt,
        },
      });
    })
  ),

  // POST /task/status - Get task status
  HttpRouter.post(
    "/status",
    Effect.gen(function* () {
      const { env } = yield* CloudflareEnv;
      const client = JobsClient.fromBinding(env.JOBS);
      const body = yield* HttpServerRequest.schemaBodyJson(IdRequest);

      const result = yield* client.task("basicTask").status(body.id);

      return yield* HttpServerResponse.json({
        success: true,
        result,
      });
    })
  ),

  // POST /task/state - Get task state
  HttpRouter.post(
    "/state",
    Effect.gen(function* () {
      const { env } = yield* CloudflareEnv;
      const client = JobsClient.fromBinding(env.JOBS);
      const body = yield* HttpServerRequest.schemaBodyJson(IdRequest);

      const result = yield* client.task("basicTask").getState(body.id);

      return yield* HttpServerResponse.json({
        success: true,
        result: {
          instanceId: result.instanceId,
          state: result.state,
          scheduledAt: result.scheduledAt,
        },
      });
    })
  ),

  // POST /task/terminate - Terminate task
  HttpRouter.post(
    "/terminate",
    Effect.gen(function* () {
      const { env } = yield* CloudflareEnv;
      const client = JobsClient.fromBinding(env.JOBS);
      const body = yield* HttpServerRequest.schemaBodyJson(IdRequest);

      const result = yield* client.task("basicTask").terminate(body.id);

      return yield* HttpServerResponse.json({
        success: true,
        result: {
          instanceId: result.instanceId,
          terminated: result.terminated,
        },
      });
    })
  )
);
