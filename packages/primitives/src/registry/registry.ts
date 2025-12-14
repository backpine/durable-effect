// packages/jobs/src/registry/registry.ts

import type {
  AnyUnregisteredDefinition,
  AnyJobDefinition,
  DebounceDefinition,
  ContinuousDefinition,
  JobRegistry,
  WorkerPoolDefinition,
} from "./types";

// =============================================================================
// Registry Factory
// =============================================================================

/**
 * Creates a job registry from a definitions object.
 *
 * The registry organizes definitions by type for efficient lookup.
 *
 * @example
 * ```ts
 * const registry = createJobRegistry({
 *   tokenRefresher: Continuous.make({ ... }),
 *   webhookDebounce: Debounce.make({ ... }),
 *   emailWorkerPool: WorkerPool.make({ ... }),
 * });
 *
 * // Lookup by type and name
 * const def = registry.continuous.get("tokenRefresher");
 * ```
 */
export function createJobRegistry<
  T extends Record<string, AnyUnregisteredDefinition>,
>(definitions: T): JobRegistry {
  const registry: JobRegistry = {
    continuous: new Map<string, ContinuousDefinition<any, any, any>>(),
    debounce: new Map<string, DebounceDefinition<any, any, any, any>>(),
    workerPool: new Map<string, WorkerPoolDefinition<any, any, any>>(),
  };

  for (const [name, def] of Object.entries(definitions)) {
    // Assign the name from the key
    const withName = { ...def, name };

    switch (def._tag) {
      case "ContinuousDefinition":
        registry.continuous.set(
          name,
          withName as ContinuousDefinition<any, any, any>
        );
        break;
      case "DebounceDefinition":
        registry.debounce.set(
          name,
          withName as DebounceDefinition<any, any, any, any>
        );
        break;
      case "WorkerPoolDefinition":
        registry.workerPool.set(name, withName as WorkerPoolDefinition<any, any, any>);
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
  registry: JobRegistry,
  name: string
): ContinuousDefinition<any, any, any> | undefined {
  return registry.continuous.get(name);
}

/**
 * Get a debounce definition by name.
 * Returns undefined if not found.
 */
export function getDebounceDefinition(
  registry: JobRegistry,
  name: string
): DebounceDefinition<any, any, any, any> | undefined {
  return registry.debounce.get(name);
}

/**
 * Get a workerPool definition by name.
 * Returns undefined if not found.
 */
export function getWorkerPoolDefinition(
  registry: JobRegistry,
  name: string
): WorkerPoolDefinition<any, any, any> | undefined {
  return registry.workerPool.get(name);
}

/**
 * Get any job definition by type and name.
 * Returns undefined if not found.
 */
export function getJobDefinition(
  registry: JobRegistry,
  type: "continuous" | "debounce" | "workerPool",
  name: string
): AnyJobDefinition | undefined {
  switch (type) {
    case "continuous":
      return registry.continuous.get(name);
    case "debounce":
      return registry.debounce.get(name);
    case "workerPool":
      return registry.workerPool.get(name);
  }
}

/**
 * Get all job names in the registry.
 */
export function getAllJobNames(registry: JobRegistry): {
  continuous: string[];
  debounce: string[];
  workerPool: string[];
} {
  return {
    continuous: Array.from(registry.continuous.keys()),
    debounce: Array.from(registry.debounce.keys()),
    workerPool: Array.from(registry.workerPool.keys()),
  };
}
