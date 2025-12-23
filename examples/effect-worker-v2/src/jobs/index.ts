// src/jobs/index.ts
// Jobs factory - creates Durable Object class and typed client

import { createDurableJobs } from "@durable-effect/jobs";
import { basicTask } from "./basic-task";
import { heartbeat } from "./heartbeat";
import { debounceExample } from "./basic-debounce";

// =============================================================================
// Create Jobs Engine
// =============================================================================

/**
 * Create the durable jobs engine with all job definitions.
 *
 * The keys in this object become the job names used in the client.
 *
 * @example
 * ```ts
 * // In your worker
 * const client = JobsClient.fromBinding(env.JOBS);
 *
 * // Task job
 * await client.task("basicTask").send({ id: "my-task", event: { targetRuns: 3 } });
 *
 * // Continuous job
 * await client.continuous("heartbeat").start({
 *   id: "my-heartbeat",
 *   input: { name: "My Heartbeat", count: 0, lastHeartbeat: 0, startedAt: Date.now() }
 * });
 * ```
 */
export const { Jobs, JobsClient, registry } = createDurableJobs(
  {
    // Task jobs
    basicTask2: basicTask,

    // Continuous jobs
    heartbeat2: heartbeat,
    // Debounce job
    debounceExample2: debounceExample,
  },
  {
    tracker: {
      endpoint: "http://localhost:3000/sync",
      env: "dev",
      serviceKey: "my-service-key",
    },
  },
);

// =============================================================================
// Type Exports
// =============================================================================

export type { TaskState, TaskEvent } from "./basic-task";
export type { HeartbeatState } from "./heartbeat";
export type { DebounceEvent } from "./basic-debounce";
