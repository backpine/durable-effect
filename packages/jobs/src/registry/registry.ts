// packages/jobs/src/registry/registry.ts

import type {
  AnyUnregisteredDefinition,
  AnyJobDefinition,
  DebounceDefinition,
  ContinuousDefinition,
  JobRegistry,
  WorkerPoolDefinition,
  StoredContinuousDefinition,
  StoredDebounceDefinition,
  StoredWorkerPoolDefinition,
  StoredTaskDefinition,
} from "./types";
import type { TypedJobRegistry, RuntimeJobRegistry } from "./typed";

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
    continuous: new Map<string, ContinuousDefinition<any, any>>(),
    debounce: new Map<string, DebounceDefinition<any, any, any>>(),
    workerPool: new Map<string, WorkerPoolDefinition<any, any>>(),
  };

  // Type casts are needed because Object.entries loses the discriminated union
  // narrowing after the spread operation ({ ...def, name })
  for (const [name, def] of Object.entries(definitions)) {
    const withName = { ...def, name };

    switch (def._tag) {
      case "ContinuousDefinition":
        registry.continuous.set(
          name,
          withName as ContinuousDefinition<any, any>,
        );
        break;
      case "DebounceDefinition":
        registry.debounce.set(
          name,
          withName as DebounceDefinition<any, any, any>,
        );
        break;
      case "WorkerPoolDefinition":
        registry.workerPool.set(
          name,
          withName as WorkerPoolDefinition<any, any>,
        );
        break;
    }
  }

  return registry;
}

// =============================================================================
// Typed Registry Factory
// =============================================================================

/**
 * Creates a type-safe job registry from a definitions object.
 *
 * Unlike createJobRegistry (which uses Maps), this creates an object-based
 * registry that preserves literal keys for full type safety.
 *
 * @example
 * ```ts
 * const registry = createTypedJobRegistry({
 *   tokenRefresher: Continuous.make({ ... }),
 *   webhookDebounce: Debounce.make({ ... }),
 * });
 *
 * // Type-safe access with autocomplete
 * const def = registry.continuous.tokenRefresher;
 * ```
 */
export function createTypedJobRegistry<
  const T extends Record<string, AnyUnregisteredDefinition>,
>(definitions: T): TypedJobRegistry<T> {
  const continuous: Record<string, any> = {};
  const debounce: Record<string, any> = {};
  const workerPool: Record<string, any> = {};
  const task: Record<string, any> = {};

  for (const [name, def] of Object.entries(definitions)) {
    const withName = { ...def, name };

    switch (def._tag) {
      case "ContinuousDefinition":
        continuous[name] = withName;
        break;
      case "DebounceDefinition":
        debounce[name] = withName;
        break;
      case "WorkerPoolDefinition":
        workerPool[name] = withName;
        break;
      case "TaskDefinition":
        task[name] = withName;
        break;
    }
  }

  // The cast is safe because we're filling objects with matching keys
  // and the __definitions property preserves the original type
  return {
    continuous,
    debounce,
    workerPool,
    task,
    __definitions: definitions,
  } as TypedJobRegistry<T>;
}

/**
 * Convert a TypedJobRegistry to a RuntimeJobRegistry for handler use.
 *
 * This provides a consistent interface for handlers to access definitions
 * without needing to know the full generic type. The conversion widens
 * error types to `unknown` via the Stored definition types.
 */
export function toRuntimeRegistry<
  T extends Record<string, AnyUnregisteredDefinition>,
>(registry: TypedJobRegistry<T>): RuntimeJobRegistry {
  return {
    continuous: registry.continuous as Record<
      string,
      StoredContinuousDefinition
    >,
    debounce: registry.debounce as Record<
      string,
      StoredDebounceDefinition
    >,
    workerPool: registry.workerPool as Record<
      string,
      StoredWorkerPoolDefinition
    >,
    task: registry.task as Record<string, StoredTaskDefinition>,
  };
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
  name: string,
): ContinuousDefinition<any, any> | undefined {
  return registry.continuous.get(name);
}

/**
 * Get a debounce definition by name.
 * Returns undefined if not found.
 */
export function getDebounceDefinition(
  registry: JobRegistry,
  name: string,
): DebounceDefinition<any, any, any> | undefined {
  return registry.debounce.get(name);
}

/**
 * Get a workerPool definition by name.
 * Returns undefined if not found.
 */
export function getWorkerPoolDefinition(
  registry: JobRegistry,
  name: string,
): WorkerPoolDefinition<any, any> | undefined {
  return registry.workerPool.get(name);
}

/**
 * Get any job definition by type and name.
 * Returns undefined if not found.
 */
export function getJobDefinition(
  registry: JobRegistry,
  type: "continuous" | "debounce" | "workerPool",
  name: string,
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
