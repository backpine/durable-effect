import { Effect } from "effect";

/**
 * GET /health - Basic health check
 */
export const getHealth = () =>
  Effect.succeed(new Response("OK", { status: 200 }));

/**
 * GET /health/ready - Readiness check with details
 */
export const getHealthReady = () =>
  Effect.succeed(
    Response.json({ status: "ready", timestamp: Date.now() }),
  );
