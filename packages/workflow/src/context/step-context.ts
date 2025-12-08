// packages/workflow/src/context/step-context.ts

import { Context, Effect, Layer } from "effect";
import { StorageAdapter } from "../adapters/storage";
import { RuntimeAdapter } from "../adapters/runtime";
import type { StorageError } from "../errors";

// =============================================================================
// Storage Keys
// =============================================================================

const stepKey = (stepName: string, suffix: string) =>
  `step:${stepName}:${suffix}`;

const KEYS = {
  attempt: (stepName: string) => stepKey(stepName, "attempt"),
  startedAt: (stepName: string) => stepKey(stepName, "startedAt"),
  result: (stepName: string) => stepKey(stepName, "result"),
  meta: (stepName: string, key: string) => stepKey(stepName, `meta:${key}`),
} as const;

// =============================================================================
// Types
// =============================================================================

/**
 * Step execution metadata stored with results.
 */
export interface StepResultMeta {
  readonly completedAt: number;
  readonly attempt: number;
  readonly durationMs: number;
}

/**
 * Cached step result with metadata.
 */
export interface CachedStepResult<T> {
  readonly value: T;
  readonly meta: StepResultMeta;
}

// =============================================================================
// Service Interface
// =============================================================================

/**
 * StepContext service interface.
 *
 * Provides step-level state access for the step primitive.
 * Each step has its own isolated state in storage.
 */
export interface StepContextService {
  /**
   * Get the current step name.
   */
  readonly stepName: string;

  /**
   * Get current attempt number (1-indexed).
   */
  readonly attempt: Effect.Effect<number, StorageError>;

  /**
   * Increment and get next attempt number.
   */
  readonly incrementAttempt: () => Effect.Effect<number, StorageError>;

  /**
   * Reset attempt counter (after success).
   */
  readonly resetAttempt: () => Effect.Effect<void, StorageError>;

  /**
   * Get step start time.
   */
  readonly startedAt: Effect.Effect<number | undefined, StorageError>;

  /**
   * Set step start time.
   */
  readonly setStartedAt: (time: number) => Effect.Effect<void, StorageError>;

  /**
   * Get cached result (if exists).
   */
  readonly getResult: <T>() => Effect.Effect<
    CachedStepResult<T> | undefined,
    StorageError
  >;

  /**
   * Cache step result.
   */
  readonly setResult: <T>(
    value: T,
    meta: StepResultMeta,
  ) => Effect.Effect<void, StorageError>;

  /**
   * Check if step has cached result.
   */
  readonly hasResult: Effect.Effect<boolean, StorageError>;

  /**
   * Get step-level metadata.
   */
  readonly getMeta: <T>(
    key: string,
  ) => Effect.Effect<T | undefined, StorageError>;

  /**
   * Set step-level metadata.
   */
  readonly setMeta: <T>(
    key: string,
    value: T,
  ) => Effect.Effect<void, StorageError>;

  /**
   * Clear all step state (for cleanup).
   */
  readonly clear: () => Effect.Effect<void, StorageError>;

  /**
   * Calculate deadline time given a timeout duration.
   */
  readonly calculateDeadline: (
    timeoutMs: number,
  ) => Effect.Effect<number, StorageError>;
}

/**
 * Effect service tag for StepContext.
 */
export class StepContext extends Context.Tag("@durable-effect/StepContext")<
  StepContext,
  StepContextService
>() {}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create a StepContext service for a specific step.
 */
export const createStepContext = (stepName: string) =>
  Effect.gen(function* () {
    const storage = yield* StorageAdapter;
    const runtime = yield* RuntimeAdapter;

    const service: StepContextService = {
      stepName,

      attempt: storage
        .get<number>(KEYS.attempt(stepName))
        .pipe(Effect.map((a) => a ?? 1)),

      incrementAttempt: () =>
        Effect.gen(function* () {
          const current =
            (yield* storage.get<number>(KEYS.attempt(stepName))) ?? 1;
          const next = current + 1;
          yield* storage.put(KEYS.attempt(stepName), next);
          return next;
        }),

      resetAttempt: () => storage.put(KEYS.attempt(stepName), 1),

      startedAt: storage.get<number>(KEYS.startedAt(stepName)),

      setStartedAt: (time) => storage.put(KEYS.startedAt(stepName), time),

      getResult: <T>() =>
        storage.get<CachedStepResult<T>>(KEYS.result(stepName)),

      setResult: <T>(value: T, meta: StepResultMeta) =>
        storage.put(KEYS.result(stepName), { value, meta }),

      hasResult: storage
        .get(KEYS.result(stepName))
        .pipe(Effect.map((r) => r !== undefined)),

      getMeta: <T>(key: string) => storage.get<T>(KEYS.meta(stepName, key)),

      setMeta: <T>(key: string, value: T) =>
        storage.put(KEYS.meta(stepName, key), value),

      clear: () =>
        Effect.gen(function* () {
          yield* storage.delete(KEYS.attempt(stepName));
          yield* storage.delete(KEYS.startedAt(stepName));
          yield* storage.delete(KEYS.result(stepName));
          // Note: We don't delete meta here - metadata may need to persist
        }),

      calculateDeadline: (timeoutMs) =>
        Effect.gen(function* () {
          const started = yield* storage.get<number>(KEYS.startedAt(stepName));
          if (started === undefined) {
            const now = yield* runtime.now();
            return now + timeoutMs;
          }
          return started + timeoutMs;
        }),
    };

    return service;
  });

/**
 * Create a StepContext layer for a specific step.
 */
export const StepContextLayer = (stepName: string) =>
  Layer.effect(StepContext, createStepContext(stepName));
