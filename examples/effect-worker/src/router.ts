/// <reference path="../worker-configuration.d.ts" />

import { Effect } from "effect";
import { getHealth, getHealthReady } from "./routes/health";
import {
  getWorkflows,
  getWorkflowStatus,
  getProcessOrder,
} from "./routes/workflows";

/**
 * Route definition
 */
interface Route {
  method: string;
  pattern: RegExp;
  handler: (
    request: Request,
    env: Env,
    params: Record<string, string>,
  ) => Effect.Effect<Response, Error>;
}

/**
 * All application routes
 */
const routes: Route[] = [
  // Health routes
  {
    method: "GET",
    pattern: /^\/health$/,
    handler: getHealth,
  },
  {
    method: "GET",
    pattern: /^\/health\/ready$/,
    handler: getHealthReady,
  },

  // PulseTracker route
  {
    method: "GET",
    pattern: /^\/pulse-tracker\/track$/,
    handler: (_req, env) =>
      Effect.tryPromise({
        try: async () => {
          const id = env.PULSE_TRACKER.idFromName("default");
          const stub = env.PULSE_TRACKER.get(id);
          const result = await stub.track();
          return Response.json(result);
        },
        catch: (error) => new Error(String(error)),
      }),
  },

  // Workflow routes
  {
    method: "GET",
    pattern: /^\/workflows$/,
    handler: getWorkflows,
  },
  {
    method: "GET",
    pattern: /^\/workflows\/processOrder$/,
    handler: getProcessOrder,
  },
  {
    method: "GET",
    pattern: /^\/workflows\/([^/]+)\/status$/,
    handler: (req, env, params) => getWorkflowStatus(req, env, params.id),
  },

  // Root route
  {
    method: "GET",
    pattern: /^\/$/,
    handler: () =>
      Effect.succeed(
        Response.json({
          name: "Effect Worker",
          version: "0.0.0",
          description:
            "Durable Effect Workflow Example with Effect HTTP Server",
        }),
      ),
  },
];

/**
 * Extract params from URL using pattern
 */
function extractParams(
  url: URL,
  pattern: RegExp,
): Record<string, string> | null {
  const match = url.pathname.match(pattern);
  if (!match) return null;

  const params: Record<string, string> = {};
  // For patterns with capture groups, assign numeric keys
  match.slice(1).forEach((value, index) => {
    params[`${index}`] = value;
    // Also add 'id' for the first param for convenience
    if (index === 0) params.id = value;
  });
  return params;
}

/**
 * Handle incoming request
 */
export async function handleRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);

  // Find matching route
  for (const route of routes) {
    if (route.method !== request.method) continue;

    const params = extractParams(url, route.pattern);
    if (params === null) continue;

    // Found matching route - execute handler
    return await Effect.runPromise(route.handler(request, env, params)).catch(
      (error) => {
        console.error("Route handler error:", error);
        return Response.json(
          { error: "Internal Server Error" },
          { status: 500 },
        );
      },
    );
  }

  // No route matched - 404
  return Promise.resolve(
    Response.json({ error: "Not Found" }, { status: 404 }),
  );
}
