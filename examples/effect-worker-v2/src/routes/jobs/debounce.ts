// src/routes/jobs/debounce.ts
// API routes for Debounce jobs

import * as HttpRouter from "@effect/platform/HttpRouter";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import { Effect, Schema } from "effect";
import { CloudflareEnv } from "@/services";
import { JobsClient } from "@/jobs";

// =============================================================================
// Request Schemas
// =============================================================================

const AddEventRequest = Schema.Struct({
  id: Schema.String,
  actionId: Schema.String,
  metadata: Schema.optional(Schema.String),
});

const IdRequest = Schema.Struct({
  id: Schema.String,
});

// =============================================================================
// Routes
// =============================================================================

export const debounceRoutes = HttpRouter.empty.pipe(
  // POST /debounce/add - Add an event to the debounce buffer
  HttpRouter.post(
    "/add",
    Effect.gen(function* () {
      const { env } = yield* CloudflareEnv;
      const client = JobsClient.fromBinding(env.JOBS);
      const body = yield* HttpServerRequest.schemaBodyJson(AddEventRequest);

      const result = yield* client.debounce("debounceExample").add({
        id: body.id,
        event: {
          actionId: body.actionId,
          timestamp: Date.now(),
          metadata: body.metadata,
        },
      });

      return yield* HttpServerResponse.json({
        success: true,
        result: {
          instanceId: result.instanceId,
          eventCount: result.eventCount,
          willFlushAt: result.willFlushAt,
          created: result.created,
        },
      });
    })
  ),

  // POST /debounce/flush - Manually flush the buffer
  HttpRouter.post(
    "/flush",
    Effect.gen(function* () {
      const { env } = yield* CloudflareEnv;
      const client = JobsClient.fromBinding(env.JOBS);
      const body = yield* HttpServerRequest.schemaBodyJson(IdRequest);

      const result = yield* client.debounce("debounceExample").flush(body.id);

      return yield* HttpServerResponse.json({
        success: true,
        result: {
          flushed: result.flushed,
          eventCount: result.eventCount,
          reason: result.reason,
        },
      });
    })
  ),

  // POST /debounce/clear - Clear the buffer without flushing
  HttpRouter.post(
    "/clear",
    Effect.gen(function* () {
      const { env } = yield* CloudflareEnv;
      const client = JobsClient.fromBinding(env.JOBS);
      const body = yield* HttpServerRequest.schemaBodyJson(IdRequest);

      const result = yield* client.debounce("debounceExample").clear(body.id);

      return yield* HttpServerResponse.json({
        success: true,
        result: {
          cleared: result.cleared,
          discardedEvents: result.discardedEvents,
        },
      });
    })
  ),

  // POST /debounce/status - Get debounce status
  HttpRouter.post(
    "/status",
    Effect.gen(function* () {
      const { env } = yield* CloudflareEnv;
      const client = JobsClient.fromBinding(env.JOBS);
      const body = yield* HttpServerRequest.schemaBodyJson(IdRequest);

      const result = yield* client.debounce("debounceExample").status(body.id);

      return yield* HttpServerResponse.json({
        success: true,
        result,
      });
    })
  ),

  // POST /debounce/state - Get debounce state
  HttpRouter.post(
    "/state",
    Effect.gen(function* () {
      const { env } = yield* CloudflareEnv;
      const client = JobsClient.fromBinding(env.JOBS);
      const body = yield* HttpServerRequest.schemaBodyJson(IdRequest);

      const result = yield* client.debounce("debounceExample").getState(body.id);

      return yield* HttpServerResponse.json({
        success: true,
        result: {
          state: result.state,
        },
      });
    })
  )
);
