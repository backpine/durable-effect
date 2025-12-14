import { Effect } from "effect";
import { HonoCtx, type RouteEffect } from "../adapter";

let count = 0;

/**
 * GET /health - Basic health check
 */
export const getHealth: RouteEffect<Response> = Effect.gen(function* () {
  count += 1;
  const c = yield* HonoCtx;
  return c.text(count.toString(), 200);
});

/**
 * GET /health/ready - Readiness check with details
 */
export const getHealthReady: RouteEffect<Response> = Effect.gen(function* () {
  const c = yield* HonoCtx;
  return c.json({ status: "ready", timestamp: Date.now() });
});
