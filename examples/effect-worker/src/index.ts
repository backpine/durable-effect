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
import { Jobs } from "./jobs";
import {
  startRefreshTokens,
  stopRefreshTokens,
  addWebhookEvent,
  flushWebhookDebounce,
  // Task routes
  startCountdown,
  pauseCountdown,
  resumeCountdown,
  cancelCountdown,
  addTimeCountdown,
  getCountdownStatus,
  getCountdownState,
  clearCountdown,
} from "./routes/jobs";

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

// Job routes - Continuous
app.get("/jobs/tokenRefresher", effectHandler(startRefreshTokens));
app.get("/jobs/tokenRefresher/stop", effectHandler(stopRefreshTokens));

// Job routes - Debounce
app.get("/jobs/webhookDebounce/add", effectHandler(addWebhookEvent));
app.get("/jobs/webhookDebounce/flush", effectHandler(flushWebhookDebounce));

// Job routes - Task (Countdown Timer)
app.get("/jobs/countdown/start", effectHandler(startCountdown));
app.get("/jobs/countdown/pause", effectHandler(pauseCountdown));
app.get("/jobs/countdown/resume", effectHandler(resumeCountdown));
app.get("/jobs/countdown/cancel", effectHandler(cancelCountdown));
app.get("/jobs/countdown/addTime", effectHandler(addTimeCountdown));
app.get("/jobs/countdown/status", effectHandler(getCountdownStatus));
app.get("/jobs/countdown/state", effectHandler(getCountdownState));
app.get("/jobs/countdown/clear", effectHandler(clearCountdown));

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
