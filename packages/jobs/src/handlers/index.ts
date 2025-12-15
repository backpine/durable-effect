// packages/jobs/src/handlers/index.ts

import { Layer } from "effect";
import { ContinuousHandlerLayer } from "./continuous";
import { DebounceHandlerLayer } from "./debounce";
import { RetryExecutorLayer } from "../retry";

// Re-export handlers
export {
  ContinuousHandler,
  ContinuousHandlerLayer,
  createContinuousContext,
  type ContinuousHandlerI,
  type ContinuousResponse,
  type StateHolder,
} from "./continuous";
export {
  DebounceHandler,
  DebounceHandlerLayer,
  type DebounceHandlerI,
  type DebounceResponse,
} from "./debounce";

// Re-export RetryExecutorLayer for runtime composition
export { RetryExecutorLayer } from "../retry";

// =============================================================================
// Combined Handlers Layer
// =============================================================================

/**
 * Combined layer for all job handlers.
 *
 * Note: RetryExecutorLayer is NOT included here because it depends on
 * AlarmService which is provided by RuntimeServicesLayer. The runtime
 * must compose the layers in the correct order.
 */
export const JobHandlersLayer = Layer.mergeAll(
  ContinuousHandlerLayer,
  DebounceHandlerLayer
  // TODO: Add WorkerPoolHandlerLayer in Phase 5
);
