// packages/jobs/src/registry/typed.ts

/**
 * Type-safe registry types that preserve literal keys.
 *
 * This replaces the Map-based JobRegistry with object types,
 * eliminating the need for phantom types and ensuring type safety
 * throughout the client API.
 */

import type {
  UnregisteredContinuousDefinition,
  UnregisteredDebounceDefinition,
  UnregisteredWorkerPoolDefinition,
  UnregisteredTaskDefinition,
  AnyUnregisteredDefinition,
  ContinuousDefinition,
  DebounceDefinition,
  WorkerPoolDefinition,
  TaskDefinition,
  StoredContinuousDefinition,
  StoredDebounceDefinition,
  StoredWorkerPoolDefinition,
  StoredTaskDefinition,
} from "./types";

// =============================================================================
// Key Extraction Types
// =============================================================================

/**
 * Extract keys from T that are continuous definitions.
 */
export type ContinuousKeysOf<T extends Record<string, AnyUnregisteredDefinition>> = {
  [K in keyof T]: T[K] extends UnregisteredContinuousDefinition<any, any> ? K : never;
}[keyof T] & string;

/**
 * Extract keys from T that are debounce definitions.
 */
export type DebounceKeysOf<T extends Record<string, AnyUnregisteredDefinition>> = {
  [K in keyof T]: T[K] extends UnregisteredDebounceDefinition<any, any, any> ? K : never;
}[keyof T] & string;

/**
 * Extract keys from T that are workerPool definitions.
 */
export type WorkerPoolKeysOf<T extends Record<string, AnyUnregisteredDefinition>> = {
  [K in keyof T]: T[K] extends UnregisteredWorkerPoolDefinition<any, any> ? K : never;
}[keyof T] & string;

/**
 * Extract keys from T that are task definitions.
 */
export type TaskKeysOf<T extends Record<string, AnyUnregisteredDefinition>> = {
  [K in keyof T]: T[K] extends UnregisteredTaskDefinition<any, any, any> ? K : never;
}[keyof T] & string;

// =============================================================================
// Definition Type Extraction
// =============================================================================

/**
 * Extract the state type from a continuous definition.
 */
export type ContinuousStateOf<
  T extends Record<string, AnyUnregisteredDefinition>,
  K extends ContinuousKeysOf<T>,
> = T[K] extends UnregisteredContinuousDefinition<infer S, any> ? S : never;

/**
 * Extract the error type from a continuous definition.
 */
export type ContinuousErrorOf<
  T extends Record<string, AnyUnregisteredDefinition>,
  K extends ContinuousKeysOf<T>,
> = T[K] extends UnregisteredContinuousDefinition<any, infer E> ? E : never;

/**
 * Extract the event type from a debounce definition.
 */
export type DebounceEventOf<
  T extends Record<string, AnyUnregisteredDefinition>,
  K extends DebounceKeysOf<T>,
> = T[K] extends UnregisteredDebounceDefinition<infer I, any, any> ? I : never;

/**
 * Extract the state type from a debounce definition.
 */
export type DebounceStateOf<
  T extends Record<string, AnyUnregisteredDefinition>,
  K extends DebounceKeysOf<T>,
> = T[K] extends UnregisteredDebounceDefinition<any, infer S, any> ? S : never;

/**
 * Extract the event type from a workerPool definition.
 */
export type WorkerPoolEventOf<
  T extends Record<string, AnyUnregisteredDefinition>,
  K extends WorkerPoolKeysOf<T>,
> = T[K] extends UnregisteredWorkerPoolDefinition<infer E, any> ? E : never;

/**
 * Extract the state type from a task definition.
 */
export type TaskStateOf<
  T extends Record<string, AnyUnregisteredDefinition>,
  K extends TaskKeysOf<T>,
> = T[K] extends UnregisteredTaskDefinition<infer S, any, any> ? S : never;

/**
 * Extract the event type from a task definition.
 */
export type TaskEventOf<
  T extends Record<string, AnyUnregisteredDefinition>,
  K extends TaskKeysOf<T>,
> = T[K] extends UnregisteredTaskDefinition<any, infer E, any> ? E : never;

// =============================================================================
// Registered Definition Types (with name added)
// =============================================================================

/**
 * Add the name property to a definition, making it a registered definition.
 */
type RegisterContinuous<
  D extends UnregisteredContinuousDefinition<any, any>,
  N extends string,
> = D extends UnregisteredContinuousDefinition<infer S, infer E>
  ? ContinuousDefinition<S, E> & { readonly name: N }
  : never;

type RegisterDebounce<
  D extends UnregisteredDebounceDefinition<any, any, any>,
  N extends string,
> = D extends UnregisteredDebounceDefinition<infer I, infer S, infer E>
  ? DebounceDefinition<I, S, E> & { readonly name: N }
  : never;

type RegisterWorkerPool<
  D extends UnregisteredWorkerPoolDefinition<any, any>,
  N extends string,
> = D extends UnregisteredWorkerPoolDefinition<infer E, infer Err>
  ? WorkerPoolDefinition<E, Err> & { readonly name: N }
  : never;

type RegisterTask<
  D extends UnregisteredTaskDefinition<any, any, any>,
  N extends string,
> = D extends UnregisteredTaskDefinition<infer S, infer E, infer Err>
  ? TaskDefinition<S, E, Err> & { readonly name: N }
  : never;

// =============================================================================
// Typed Job Registry
// =============================================================================

/**
 * Type-safe job registry that preserves literal keys.
 *
 * Uses object types instead of Maps, allowing TypeScript to track
 * the exact keys and their associated definition types.
 */
export interface TypedJobRegistry<T extends Record<string, AnyUnregisteredDefinition>> {
  /**
   * Continuous job definitions indexed by name.
   */
  readonly continuous: {
    [K in ContinuousKeysOf<T>]: RegisterContinuous<
      Extract<T[K], UnregisteredContinuousDefinition<any, any>>,
      K
    >;
  };

  /**
   * Debounce job definitions indexed by name.
   */
  readonly debounce: {
    [K in DebounceKeysOf<T>]: RegisterDebounce<
      Extract<T[K], UnregisteredDebounceDefinition<any, any, any>>,
      K
    >;
  };

  /**
   * WorkerPool job definitions indexed by name.
   */
  readonly workerPool: {
    [K in WorkerPoolKeysOf<T>]: RegisterWorkerPool<
      Extract<T[K], UnregisteredWorkerPoolDefinition<any, any>>,
      K
    >;
  };

  /**
   * Task job definitions indexed by name.
   */
  readonly task: {
    [K in TaskKeysOf<T>]: RegisterTask<
      Extract<T[K], UnregisteredTaskDefinition<any, any, any>>,
      K
    >;
  };

  /**
   * Original definitions object for type inference.
   * This is the actual runtime value, not a phantom type.
   */
  readonly __definitions: T;
}

// =============================================================================
// Runtime Registry Type (for handlers)
// =============================================================================

/**
 * Runtime-accessible registry interface.
 *
 * Handlers use this interface for lookups. Uses stored types
 * with unknown state/event types to allow any definition.
 */
export interface RuntimeJobRegistry {
  readonly continuous: Record<string, StoredContinuousDefinition>;
  readonly debounce: Record<string, StoredDebounceDefinition>;
  readonly workerPool: Record<string, StoredWorkerPoolDefinition>;
  readonly task: Record<string, StoredTaskDefinition>;
}

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Check if a registry has a specific continuous job.
 */
export function hasContinuousJob<
  T extends Record<string, AnyUnregisteredDefinition>,
  K extends string,
>(
  registry: TypedJobRegistry<T>,
  name: K,
): name is K & ContinuousKeysOf<T> {
  return name in registry.continuous;
}

/**
 * Check if a registry has a specific debounce job.
 */
export function hasDebounceJob<
  T extends Record<string, AnyUnregisteredDefinition>,
  K extends string,
>(
  registry: TypedJobRegistry<T>,
  name: K,
): name is K & DebounceKeysOf<T> {
  return name in registry.debounce;
}

/**
 * Check if a registry has a specific workerPool job.
 */
export function hasWorkerPoolJob<
  T extends Record<string, AnyUnregisteredDefinition>,
  K extends string,
>(
  registry: TypedJobRegistry<T>,
  name: K,
): name is K & WorkerPoolKeysOf<T> {
  return name in registry.workerPool;
}

/**
 * Check if a registry has a specific task job.
 */
export function hasTaskJob<
  T extends Record<string, AnyUnregisteredDefinition>,
  K extends string,
>(
  registry: TypedJobRegistry<T>,
  name: K,
): name is K & TaskKeysOf<T> {
  return name in registry.task;
}
