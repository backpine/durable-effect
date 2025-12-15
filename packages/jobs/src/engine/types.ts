// packages/jobs/src/engine/types.ts

import type { JobRequest, JobResponse } from "../runtime/types";
import type { RuntimeJobRegistry } from "../registry/typed";

// =============================================================================
// Engine Configuration
// =============================================================================

/**
 * Configuration for the jobs engine.
 *
 * This is passed to the engine via the Cloudflare environment binding.
 */
export interface JobsEngineConfig {
  /**
   * The job registry containing all registered jobs.
   */
  readonly __JOB_REGISTRY__: RuntimeJobRegistry;
}

// =============================================================================
// Engine Interface
// =============================================================================

/**
 * The Durable Object interface for the jobs engine.
 *
 * This is a thin shell that delegates all operations to the runtime.
 * It has ONE generic RPC method `call()` and `alarm()` - nothing else.
 */
export interface DurableJobsEngineInterface {
  /**
   * Handle a job request.
   *
   * This is the ONLY RPC method for jobs. The client sends typed
   * requests and receives typed responses. The engine doesn't know
   * about specific job operations - it just delegates to the runtime.
   *
   * @param request - The job request to handle
   * @returns The response from the job handler
   */
  call(request: JobRequest): Promise<JobResponse>;

  /**
   * Handle an alarm.
   *
   * The alarm handler reads metadata to determine which job type
   * owns this instance, then delegates to the appropriate handler.
   */
  alarm(): Promise<void>;
}

// =============================================================================
// Env Type Helper
// =============================================================================

/**
 * Type helper for Cloudflare worker environment with jobs binding.
 *
 * @example
 * ```ts
 * interface Env extends JobsEnv<"JOBS"> {
 *   // Other bindings...
 * }
 * ```
 */
export type JobsEnv<BindingName extends string = "JOBS"> = {
  [K in BindingName]: DurableObjectNamespace;
};
