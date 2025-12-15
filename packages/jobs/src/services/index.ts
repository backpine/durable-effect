// packages/jobs/src/services/index.ts

import { Layer } from "effect";

// Metadata
export {
  MetadataService,
  MetadataServiceLayer,
  type MetadataServiceI,
  type JobMetadata,
  type JobType,
  type JobStatus,
} from "./metadata";

// Entity State
export {
  createEntityStateService,
  type EntityStateServiceI,
} from "./entity-state";

// Alarm
export { AlarmService, AlarmServiceLayer, type AlarmServiceI } from "./alarm";

// Idempotency
export {
  IdempotencyService,
  IdempotencyServiceLayer,
  type IdempotencyServiceI,
} from "./idempotency";

// Registry
export {
  RegistryService,
  RegistryServiceLayer,
  type RegistryServiceI,
} from "./registry";

// =============================================================================
// Combined Layer
// =============================================================================

import { MetadataServiceLayer } from "./metadata";
import { AlarmServiceLayer } from "./alarm";
import { IdempotencyServiceLayer } from "./idempotency";

/**
 * Combined layer for all runtime services.
 *
 * Requires: StorageAdapter, SchedulerAdapter, RuntimeAdapter
 * Provides: MetadataService, AlarmService, IdempotencyService
 *
 * Note: EntityStateService is NOT included because it's a factory function
 * that creates instances per-schema, not a singleton service.
 */
export const RuntimeServicesLayer = Layer.mergeAll(
  MetadataServiceLayer,
  AlarmServiceLayer,
  IdempotencyServiceLayer
);
