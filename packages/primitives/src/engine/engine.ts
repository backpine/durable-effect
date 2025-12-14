// packages/jobs/src/engine/engine.ts

import { DurableObject } from "cloudflare:workers";
import {
  createJobsRuntime,
  type JobsRuntime,
} from "../runtime/runtime";
import type { JobRequest, JobResponse } from "../runtime/types";
import type {
  DurableJobsEngineInterface,
  JobsEngineConfig,
} from "./types";

// =============================================================================
// Durable Jobs Engine
// =============================================================================

/**
 * The Durable Object class for jobs.
 *
 * This is a THIN SHELL that:
 * 1. Creates the runtime in constructor
 * 2. Delegates `call()` to `runtime.handle()`
 * 3. Delegates `alarm()` to `runtime.handleAlarm()`
 * 4. Flushes events via `ctx.waitUntil()`
 *
 * The engine knows NOTHING about job types. It just:
 * - Creates the runtime
 * - Delegates to runtime.handle() and runtime.handleAlarm()
 * - Flushes events
 *
 * @example
 * ```ts
 * // In your worker's wrangler.toml:
 * // [[durable_objects.bindings]]
 * // name = "JOBS"
 * // class_name = "DurableJobsEngine"
 *
 * // The engine is created via createDurableJobs():
 * const { Jobs } = createDurableJobs({
 *   jobs: { tokenRefresher, webhookDebounce, emailWorkerPool },
 * });
 *
 * export { Jobs };
 * ```
 */
export class DurableJobsEngine
  extends DurableObject
  implements DurableJobsEngineInterface
{
  /**
   * The runtime that handles all job operations.
   */
  readonly #runtime: JobsRuntime;

  /**
   * Create a new jobs engine instance.
   *
   * @param state - Durable Object state (provides storage + alarm)
   * @param env - Environment with config injected
   */
  constructor(state: DurableObjectState, env: JobsEngineConfig) {
    super(state, env);

    if (!env.__JOB_REGISTRY__) {
      throw new Error("DurableJobsEngine requires __JOB_REGISTRY__ in env");
    }

    // Create the runtime with DO state and registry
    // The runtime handles all Effect complexity
    this.#runtime = createJobsRuntime({
      doState: state,
      registry: env.__JOB_REGISTRY__,
    });
  }

  /**
   * Handle a job request.
   *
   * ONE generic RPC method - NOT one per job operation.
   * The DO doesn't know about job types.
   *
   * @param request - The typed request from the client
   * @returns The typed response
   */
  async call(request: JobRequest): Promise<JobResponse> {
    // Delegate to runtime
    const result = await this.#runtime.handle(request);

    // Fire-and-forget event flushing - don't block response
    this.ctx.waitUntil(this.#runtime.flush());

    return result;
  }

  /**
   * Handle an alarm.
   *
   * The runtime reads metadata to determine job type,
   * then delegates to the appropriate handler.
   */
  async alarm(): Promise<void> {
    // Delegate to runtime
    await this.#runtime.handleAlarm();

    // Fire-and-forget event flushing
    this.ctx.waitUntil(this.#runtime.flush());
  }
}
