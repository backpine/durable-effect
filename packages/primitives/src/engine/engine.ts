// packages/primitives/src/engine/engine.ts

import { DurableObject } from "cloudflare:workers";
import {
  createPrimitivesRuntime,
  type PrimitivesRuntime,
} from "../runtime/runtime";
import type { PrimitiveRequest, PrimitiveResponse } from "../runtime/types";
import type {
  DurablePrimitivesEngineInterface,
  PrimitivesEngineConfig,
} from "./types";

// =============================================================================
// Durable Primitives Engine
// =============================================================================

/**
 * The Durable Object class for primitives.
 *
 * This is a THIN SHELL that:
 * 1. Creates the runtime in constructor
 * 2. Delegates `call()` to `runtime.handle()`
 * 3. Delegates `alarm()` to `runtime.handleAlarm()`
 * 4. Flushes events via `ctx.waitUntil()`
 *
 * The engine knows NOTHING about primitive types. It just:
 * - Creates the runtime
 * - Delegates to runtime.handle() and runtime.handleAlarm()
 * - Flushes events
 *
 * @example
 * ```ts
 * // In your worker's wrangler.toml:
 * // [[durable_objects.bindings]]
 * // name = "PRIMITIVES"
 * // class_name = "DurablePrimitivesEngine"
 *
 * // The engine is created via createDurablePrimitives():
 * const { Primitives } = createDurablePrimitives({
 *   primitives: { tokenRefresher, webhookBuffer, emailQueue },
 * });
 *
 * export { Primitives };
 * ```
 */
export class DurablePrimitivesEngine
  extends DurableObject
  implements DurablePrimitivesEngineInterface
{
  /**
   * The runtime that handles all primitive operations.
   */
  readonly #runtime: PrimitivesRuntime;

  /**
   * Create a new primitives engine instance.
   *
   * @param state - Durable Object state (provides storage + alarm)
   * @param env - Environment with config injected
   */
  constructor(state: DurableObjectState, env: PrimitivesEngineConfig) {
    super(state, env);

    if (!env.__PRIMITIVE_REGISTRY__) {
      throw new Error("DurablePrimitivesEngine requires __PRIMITIVE_REGISTRY__ in env");
    }

    // Create the runtime with DO state and registry
    // The runtime handles all Effect complexity
    this.#runtime = createPrimitivesRuntime({
      doState: state,
      registry: env.__PRIMITIVE_REGISTRY__,
    });
  }

  /**
   * Handle a primitive request.
   *
   * ONE generic RPC method - NOT one per primitive operation.
   * The DO doesn't know about primitive types.
   *
   * @param request - The typed request from the client
   * @returns The typed response
   */
  async call(request: PrimitiveRequest): Promise<PrimitiveResponse> {
    // Delegate to runtime
    const result = await this.#runtime.handle(request);

    // Fire-and-forget event flushing - don't block response
    this.ctx.waitUntil(this.#runtime.flush());

    return result;
  }

  /**
   * Handle an alarm.
   *
   * The runtime reads metadata to determine primitive type,
   * then delegates to the appropriate handler.
   */
  async alarm(): Promise<void> {
    // Delegate to runtime
    await this.#runtime.handleAlarm();

    // Fire-and-forget event flushing
    this.ctx.waitUntil(this.#runtime.flush());
  }
}
