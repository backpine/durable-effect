// packages/primitives/src/services/registry.ts

import { Context, Layer } from "effect";
import type { PrimitiveRegistry } from "../registry/types";

// =============================================================================
// Service Interface
// =============================================================================

/**
 * Registry service provides access to primitive definitions.
 *
 * This is injected via Layer so handlers can look up definitions.
 */
export interface RegistryServiceI {
  readonly registry: PrimitiveRegistry;
}

// =============================================================================
// Service Tag
// =============================================================================

export class RegistryService extends Context.Tag(
  "@durable-effect/primitives/RegistryService"
)<RegistryService, RegistryServiceI>() {}

// =============================================================================
// Layer Factory
// =============================================================================

/**
 * Create a Registry service layer from a registry.
 */
export function RegistryServiceLayer(
  registry: PrimitiveRegistry
): Layer.Layer<RegistryService> {
  return Layer.succeed(RegistryService, { registry });
}
