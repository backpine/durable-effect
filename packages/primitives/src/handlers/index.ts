// packages/primitives/src/handlers/index.ts

import { Layer } from "effect";
import { ContinuousHandlerLayer } from "./continuous";

// Re-export handlers
export {
  ContinuousHandler,
  ContinuousHandlerLayer,
  createContinuousContext,
  executeUserFunction,
  type ContinuousHandlerI,
  type ContinuousResponse,
  type StateHolder,
} from "./continuous";

// =============================================================================
// Combined Handlers Layer
// =============================================================================

/**
 * Combined layer for all primitive handlers.
 *
 * Phase 3: Only ContinuousHandler
 * Phase 4: Add BufferHandler
 * Phase 5: Add QueueHandler
 */
export const PrimitiveHandlersLayer = Layer.mergeAll(
  ContinuousHandlerLayer
  // TODO: Add BufferHandlerLayer in Phase 4
  // TODO: Add QueueHandlerLayer in Phase 5
);
