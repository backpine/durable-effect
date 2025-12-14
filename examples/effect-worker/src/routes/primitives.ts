import { CloudflareEnv, HonoCtx, RouteEffect } from "@/adapter";
import { PrimitivesClient } from "@/primitives";
import { Effect } from "effect";

export const startRefreshTokens: RouteEffect<Response> = Effect.gen(
  function* () {
    const c = yield* HonoCtx;
    const env = yield* CloudflareEnv;

    const orderId = c.req.query("orderId") ?? `order-${Date.now()}`;
    const client = PrimitivesClient.fromBinding(env.PRIMITIVES);

    yield* Effect.log(`Starting workflow for order ${orderId}`);

    const res = yield* client.continuous("TokenRefresher").start({
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
    const client = PrimitivesClient.fromBinding(env.PRIMITIVES);

    yield* Effect.log(`Starting workflow for order ${id}`);

    const res = yield* client.continuous("TokenRefresher").stop(id);

    return c.json({
      success: true,
      workflowId: res.stopped,
    });
  },
);
