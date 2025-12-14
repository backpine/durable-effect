// packages/jobs/src/handlers/index.ts

import { Layer } from "effect";
import { ContinuousHandlerLayer } from "./continuous";

// Re-export handlers
export {
  ContinuousHandler,
  ContinuousHandlerLayer,
  createContinuousContext,
  type ContinuousHandlerI,
  type ContinuousResponse,
  type StateHolder,
} from "./continuous";

// =============================================================================
// Combined Handlers Layer
// =============================================================================

/**
 * Combined layer for all job handlers.
 *
 * Phase 3: Only ContinuousHandler
 * Phase 4: Add DebounceHandler
 * Phase 5: Add WorkerPoolHandler
 */
export const JobHandlersLayer = Layer.mergeAll(
  ContinuousHandlerLayer
  // TODO: Add DebounceHandlerLayer in Phase 4
  // TODO: Add WorkerPoolHandlerLayer in Phase 5
);
