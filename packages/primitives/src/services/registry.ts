// packages/jobs/src/services/registry.ts

import { Context, Layer } from "effect";
import type { JobRegistry } from "../registry/types";

// =============================================================================
// Service Interface
// =============================================================================

/**
 * Registry service provides access to job definitions.
 *
 * This is injected via Layer so handlers can look up definitions.
 */
export interface RegistryServiceI {
  readonly registry: JobRegistry;
}

// =============================================================================
// Service Tag
// =============================================================================

export class RegistryService extends Context.Tag(
  "@durable-effect/jobs/RegistryService"
)<RegistryService, RegistryServiceI>() {}

// =============================================================================
// Layer Factory
// =============================================================================

/**
 * Create a Registry service layer from a registry.
 */
export function RegistryServiceLayer(
  registry: JobRegistry
): Layer.Layer<RegistryService> {
  return Layer.succeed(RegistryService, { registry });
}
