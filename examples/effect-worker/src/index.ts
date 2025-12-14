/// <reference path="../worker-configuration.d.ts" />

import { Hono } from "hono";
import { effectHandler } from "./adapter";
import { getHealth, getHealthReady } from "./routes/health";
import {
  getWorkflows,
  getWorkflowStatus,
  getProcessOrder,
  getGenerateReport,
} from "./routes/workflows";
import { Workflows } from "./workflows";
import { Jobs } from "./primitives";
import { startRefreshTokens, stopRefreshTokens } from "./routes/primitives";

// Export the Durable Object classes
export { Workflows };
export { Jobs };

// =============================================================================
// Hono Application
// =============================================================================

const app = new Hono<{ Bindings: Env }>();

// Root route
app.get("/", (c) =>
  c.json({
    name: "Effect Worker",
    version: "0.0.0",
    description: "Durable Effect Workflow Example with Hono + Effect",
  }),
);

// Health routes
app.get("/health", effectHandler(getHealth));
app.get("/health/ready", effectHandler(getHealthReady));

// Workflow routes
app.get("/workflows", effectHandler(getWorkflows));
app.get("/workflows/processOrder", effectHandler(getProcessOrder));
app.get("/workflows/generateReport", effectHandler(getGenerateReport));
app.get("/workflows/:id/status", effectHandler(getWorkflowStatus));

// Job routes
app.get("/jobs/tokenRefresher", effectHandler(startRefreshTokens));
app.get("/jobs/contine/stop", effectHandler(stopRefreshTokens));

// 404 handler
app.notFound((c) => c.json({ error: "Not Found" }, 404));

// Error handler
app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json({ error: "Internal Server Error" }, 500);
});

// =============================================================================
// Export Worker
// =============================================================================

export default app;
