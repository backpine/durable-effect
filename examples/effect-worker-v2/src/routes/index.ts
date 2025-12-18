import * as HttpRouter from "@effect/platform/HttpRouter";
import { healthRoutes } from "./health";
import { jobsRoutes } from "./jobs";
import { workflowRoutes } from "./workflows";
import { uiRoutes } from "./ui";

export const routes = HttpRouter.empty.pipe(
  // Mount health routes at /health
  HttpRouter.mount("/health", healthRoutes),
  // Mount jobs API routes at /api/jobs
  HttpRouter.mount("/api/jobs", jobsRoutes),
  // Mount workflow API routes at /api/workflows
  HttpRouter.mount("/api/workflows", workflowRoutes),

  // Mount UI routes at /ui
  HttpRouter.mount("/ui", uiRoutes),
);
