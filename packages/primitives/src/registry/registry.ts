// packages/primitives/src/registry/registry.ts

import type {
  AnyPrimitiveDefinition,
  BufferDefinition,
  ContinuousDefinition,
  PrimitiveRegistry,
  QueueDefinition,
} from "./types";

// =============================================================================
// Registry Factory
// =============================================================================

/**
 * Creates a primitive registry from a definitions object.
 *
 * The registry organizes definitions by type for efficient lookup.
 *
 * @example
 * ```ts
 * const registry = createPrimitiveRegistry({
 *   tokenRefresher: Continuous.make({ ... }),
 *   webhookBuffer: Buffer.make({ ... }),
 *   emailQueue: Queue.make({ ... }),
 * });
 *
 * // Lookup by type and name
 * const def = registry.continuous.get("tokenRefresher");
 * ```
 */
export function createPrimitiveRegistry<
  T extends Record<string, AnyPrimitiveDefinition>,
>(definitions: T): PrimitiveRegistry {
  const registry: PrimitiveRegistry = {
    continuous: new Map<string, ContinuousDefinition<any, any, any>>(),
    buffer: new Map<string, BufferDefinition<any, any, any, any>>(),
    queue: new Map<string, QueueDefinition<any, any, any>>(),
  };

  for (const [name, def] of Object.entries(definitions)) {
    // Assign the name from the key
    const withName = { ...def, name };

    switch (def._tag) {
      case "continuous":
        registry.continuous.set(
          name,
          withName as ContinuousDefinition<any, any, any>
        );
        break;
      case "buffer":
        registry.buffer.set(
          name,
          withName as BufferDefinition<any, any, any, any>
        );
        break;
      case "queue":
        registry.queue.set(name, withName as QueueDefinition<any, any, any>);
        break;
    }
  }

  return registry;
}

// =============================================================================
// Registry Lookup Helpers
// =============================================================================

/**
 * Get a continuous definition by name.
 * Returns undefined if not found.
 */
export function getContinuousDefinition(
  registry: PrimitiveRegistry,
  name: string
): ContinuousDefinition<any, any, any> | undefined {
  return registry.continuous.get(name);
}

/**
 * Get a buffer definition by name.
 * Returns undefined if not found.
 */
export function getBufferDefinition(
  registry: PrimitiveRegistry,
  name: string
): BufferDefinition<any, any, any, any> | undefined {
  return registry.buffer.get(name);
}

/**
 * Get a queue definition by name.
 * Returns undefined if not found.
 */
export function getQueueDefinition(
  registry: PrimitiveRegistry,
  name: string
): QueueDefinition<any, any, any> | undefined {
  return registry.queue.get(name);
}

/**
 * Get any primitive definition by type and name.
 * Returns undefined if not found.
 */
export function getPrimitiveDefinition(
  registry: PrimitiveRegistry,
  type: "continuous" | "buffer" | "queue",
  name: string
): AnyPrimitiveDefinition | undefined {
  switch (type) {
    case "continuous":
      return registry.continuous.get(name);
    case "buffer":
      return registry.buffer.get(name);
    case "queue":
      return registry.queue.get(name);
  }
}

/**
 * Get all primitive names in the registry.
 */
export function getAllPrimitiveNames(registry: PrimitiveRegistry): {
  continuous: string[];
  buffer: string[];
  queue: string[];
} {
  return {
    continuous: Array.from(registry.continuous.keys()),
    buffer: Array.from(registry.buffer.keys()),
    queue: Array.from(registry.queue.keys()),
  };
}
