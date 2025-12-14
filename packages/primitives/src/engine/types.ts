// packages/primitives/src/engine/types.ts

import type { PrimitiveRequest, PrimitiveResponse } from "../runtime/types";
import type { PrimitiveRegistry } from "../registry/types";

// =============================================================================
// Engine Configuration
// =============================================================================

/**
 * Configuration for the primitives engine.
 *
 * This is passed to the engine via the Cloudflare environment binding.
 */
export interface PrimitivesEngineConfig {
  /**
   * The primitive registry containing all registered primitives.
   */
  readonly __PRIMITIVE_REGISTRY__: PrimitiveRegistry;

  /**
   * Optional tracker configuration for event tracking.
   */
  readonly __TRACKER_CONFIG__?: TrackerConfig;
}

/**
 * Tracker configuration for event observability.
 */
export interface TrackerConfig {
  /**
   * Whether tracking is enabled.
   */
  readonly enabled: boolean;

  /**
   * HTTP endpoint to send events to.
   */
  readonly endpoint?: string;

  /**
   * Environment name (e.g., "production", "staging").
   */
  readonly env?: string;

  /**
   * Service key for identification.
   */
  readonly serviceKey?: string;

  /**
   * Optional batch size for event batching.
   */
  readonly batchSize?: number;

  /**
   * Optional flush interval in milliseconds.
   */
  readonly flushIntervalMs?: number;
}

// =============================================================================
// Engine Interface
// =============================================================================

/**
 * The Durable Object interface for the primitives engine.
 *
 * This is a thin shell that delegates all operations to the runtime.
 * It has ONE generic RPC method `call()` and `alarm()` - nothing else.
 */
export interface DurablePrimitivesEngineInterface {
  /**
   * Handle a primitive request.
   *
   * This is the ONLY RPC method for primitives. The client sends typed
   * requests and receives typed responses. The engine doesn't know
   * about specific primitive operations - it just delegates to the runtime.
   *
   * @param request - The primitive request to handle
   * @returns The response from the primitive handler
   */
  call(request: PrimitiveRequest): Promise<PrimitiveResponse>;

  /**
   * Handle an alarm.
   *
   * The alarm handler reads metadata to determine which primitive type
   * owns this instance, then delegates to the appropriate handler.
   */
  alarm(): Promise<void>;
}

// =============================================================================
// Env Type Helper
// =============================================================================

/**
 * Type helper for Cloudflare worker environment with primitives binding.
 *
 * @example
 * ```ts
 * interface Env extends PrimitivesEnv<"PRIMITIVES"> {
 *   // Other bindings...
 * }
 * ```
 */
export type PrimitivesEnv<BindingName extends string = "PRIMITIVES"> = {
  [K in BindingName]: DurableObjectNamespace;
};
