// src/routes/jobs/continuous.ts
// API routes for Continuous jobs

import * as HttpRouter from "@effect/platform/HttpRouter";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import { Effect, Schema } from "effect";
import { CloudflareEnv } from "@/services";
import { JobsClient } from "@/jobs";

// =============================================================================
// Request Schemas
// =============================================================================

const StartRequest = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});

const IdRequest = Schema.Struct({
  id: Schema.String,
});

const TerminateRequest = Schema.Struct({
  id: Schema.String,
  reason: Schema.optional(Schema.String),
});

// =============================================================================
// Routes
// =============================================================================

export const continuousRoutes = HttpRouter.empty.pipe(
  // POST /continuous/start - Start a heartbeat job
  HttpRouter.post(
    "/start",
    Effect.gen(function* () {
      const { env } = yield* CloudflareEnv;
      const client = JobsClient.fromBinding(env.JOBS);
      const body = yield* HttpServerRequest.schemaBodyJson(StartRequest);

      const now = Date.now();
      const result = yield* client.continuous("heartbeat2").start({
        id: body.id,
        input: {
          name: body.name,
          count: 0,
          lastHeartbeat: now,
          startedAt: now,
        },
      });

      return yield* HttpServerResponse.json({
        success: true,
        result: {
          instanceId: result.instanceId,
          created: result.created,
          status: result.status,
        },
      });
    }),
  ),

  // POST /continuous/terminate - Terminate a heartbeat job
  HttpRouter.post(
    "/terminate",
    Effect.gen(function* () {
      const { env } = yield* CloudflareEnv;
      const client = JobsClient.fromBinding(env.JOBS);
      const body = yield* HttpServerRequest.schemaBodyJson(TerminateRequest);

      const result = yield* client.continuous("heartbeat2").terminate(body.id, {
        reason: body.reason,
      });

      return yield* HttpServerResponse.json({
        success: true,
        result: {
          terminated: result.terminated,
          reason: result.reason,
        },
      });
    }),
  ),

  // POST /continuous/trigger - Trigger immediate execution
  HttpRouter.post(
    "/trigger",
    Effect.gen(function* () {
      const { env } = yield* CloudflareEnv;
      const client = JobsClient.fromBinding(env.JOBS);
      const body = yield* HttpServerRequest.schemaBodyJson(IdRequest);

      const result = yield* client.continuous("heartbeat2").trigger(body.id);

      return yield* HttpServerResponse.json({
        success: true,
        result: {
          triggered: result.triggered,
          terminated: result.terminated,
          retryScheduled: result.retryScheduled,
        },
      });
    }),
  ),

  // POST /continuous/status - Get job status
  HttpRouter.post(
    "/status",
    Effect.gen(function* () {
      const { env } = yield* CloudflareEnv;
      const client = JobsClient.fromBinding(env.JOBS);
      const body = yield* HttpServerRequest.schemaBodyJson(IdRequest);

      const result = yield* client.continuous("heartbeat2").status(body.id);

      return yield* HttpServerResponse.json({
        success: true,
        result,
      });
    }),
  ),

  // POST /continuous/state - Get job state
  HttpRouter.post(
    "/state",
    Effect.gen(function* () {
      const { env } = yield* CloudflareEnv;
      const client = JobsClient.fromBinding(env.JOBS);
      const body = yield* HttpServerRequest.schemaBodyJson(IdRequest);

      const result = yield* client.continuous("heartbeat2").getState(body.id);

      return yield* HttpServerResponse.json({
        success: true,
        result: {
          state: result.state,
        },
      });
    }),
  ),
);
