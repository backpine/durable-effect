import { CloudflareEnv, HonoCtx, RouteEffect } from "@/adapter";
import { JobsClient } from "@/jobs";
import { Effect } from "effect";

export const startRefreshTokens: RouteEffect<Response> = Effect.gen(
  function* () {
    const c = yield* HonoCtx;
    const env = yield* CloudflareEnv;

    const orderId = c.req.query("orderId") ?? `order-${Date.now()}`;
    const client = JobsClient.fromBinding(env.JOBS);

    yield* Effect.log(`Starting workflow for order ${orderId}`);

    const res = yield* client.continuous("tokenRefresher").start({
      id: orderId,
      input: {
        accessToken: "example_access_token",
        refreshToken: "example_refresh_token",
        expiresAt: Date.now() + 3600000,
        count: 0,
      },
    });

    return c.json({
      success: true,
      workflowId: res.instanceId,
      orderId,
    });
  },
);

export const stopRefreshTokens: RouteEffect<Response> = Effect.gen(
  function* () {
    const c = yield* HonoCtx;
    const env = yield* CloudflareEnv;

    const id = c.req.query("id");
    if (!id) {
      return c.json({
        success: false,
        error: "orderId is required",
      });
    }
    const client = JobsClient.fromBinding(env.JOBS);

    yield* Effect.log(`Starting workflow for order ${id}`);

    const res = yield* client.continuous("tokenRefresher").stop(id);

    return c.json({
      success: true,
      workflowId: res.stopped,
    });
  },
);

export const addWebhookEvent: RouteEffect<Response> = Effect.gen(function* () {
  const c = yield* HonoCtx;
  const env = yield* CloudflareEnv;

  const contactId = c.req.query("contactId") ?? "contact-1";
  const webhookId = c.req.query("id") ?? `evt-${Date.now()}`;
  const type = c.req.query("type") ?? "order.updated";

  const client = JobsClient.fromBinding(env.JOBS);

  const res = yield* client.debounce("webhookDebounce").add({
    id: contactId,
    event: {
      contactId,
      type,
      payload: { demo: true },
      occurredAt: Math.floor(Math.random() * 1000) + 1,
    },
  });

  return c.json({
    success: true,
    instanceId: res.instanceId,
    eventCount: res.eventCount,
    willFlushAt: res.willFlushAt,
  });
});

export const flushWebhookDebounce: RouteEffect<Response> = Effect.gen(
  function* () {
    const c = yield* HonoCtx;
    const env = yield* CloudflareEnv;

    const contactId = c.req.query("contactId");
    if (!contactId) {
      return c.json({ success: false, error: "contactId required" }, 400);
    }

    const client = JobsClient.fromBinding(env.JOBS);
    const res = yield* client.debounce("webhookDebounce").flush(contactId);

    return c.json(res);
  },
);
