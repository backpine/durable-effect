import { Effect } from "effect";
import { HonoCtx, type RouteEffect } from "../adapter";

/**
 * GET /health - Basic health check
 */
export const getHealth: RouteEffect<Response> = Effect.gen(function* () {
  const c = yield* HonoCtx;
  return c.text("OK", 200);
});

/**
 * GET /health/ready - Readiness check with details
 */
export const getHealthReady: RouteEffect<Response> = Effect.gen(function* () {
  const c = yield* HonoCtx;
  return c.json({ status: "ready", timestamp: Date.now() });
});
