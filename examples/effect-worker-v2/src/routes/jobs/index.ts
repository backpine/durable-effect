// src/routes/jobs/index.ts
// Job routes index - aggregates all job type routes

import * as HttpRouter from "@effect/platform/HttpRouter";
import { taskRoutes } from "./task";
import { continuousRoutes } from "./continuous";
import { debounceRoutes } from "./debounce";

// Combine all job routes under /api/jobs
export const jobsRoutes = HttpRouter.empty.pipe(
  // Task job routes at /api/jobs/task/*
  HttpRouter.mount("/task", taskRoutes),

  // Continuous job routes at /api/jobs/continuous/*
  HttpRouter.mount("/continuous", continuousRoutes),

  // Debounce job routes at /api/jobs/debounce/*
  HttpRouter.mount("/debounce", debounceRoutes)
);
