// packages/primitives/src/handlers/continuous/handler.ts

import { Context, Effect, Layer } from "effect";
import {
  RuntimeAdapter,
  StorageAdapter,
  type StorageError,
  type SchedulerError,
} from "@durable-effect/core";
import { MetadataService, type PrimitiveStatus } from "../../services/metadata";
import { AlarmService } from "../../services/alarm";
import { createEntityStateService, type EntityStateServiceI } from "../../services/entity-state";
import { RegistryService } from "../../services/registry";
import { KEYS } from "../../storage-keys";
import {
  PrimitiveNotFoundError,
  ExecutionError,
  TerminateSignal,
  type PrimitiveError,
} from "../../errors";
import type { ContinuousRequest } from "../../runtime/types";
import type { ContinuousDefinition } from "../../registry/types";
import type { ContinuousHandlerI, ContinuousResponse } from "./types";
import { createContinuousContext, type StateHolder } from "./context";

// =============================================================================
// Service Tag
// =============================================================================

export class ContinuousHandler extends Context.Tag(
  "@durable-effect/primitives/ContinuousHandler"
)<ContinuousHandler, ContinuousHandlerI>() {}

// =============================================================================
// Error Types for Internal Use
// =============================================================================

type HandlerError = PrimitiveError | StorageError | SchedulerError;

// =============================================================================
// Layer Implementation
// =============================================================================

export const ContinuousHandlerLayer = Layer.effect(
  ContinuousHandler,
  Effect.gen(function* () {
    // Get all required services
    const registryService = yield* RegistryService;
    const metadata = yield* MetadataService;
    const alarm = yield* AlarmService;
    const runtime = yield* RuntimeAdapter;
    const storage = yield* StorageAdapter;

    // -------------------------------------------------------------------------
    // Internal Helpers
    // -------------------------------------------------------------------------

    const getDefinition = (
      name: string
    ): Effect.Effect<ContinuousDefinition<unknown, unknown, never>, PrimitiveNotFoundError> => {
      const def = registryService.registry.continuous.get(name);
      if (!def) {
        return Effect.fail(new PrimitiveNotFoundError({ type: "continuous", name }));
      }
      // Cast is safe here - we know the definition exists and matches the schema
      return Effect.succeed(def as ContinuousDefinition<unknown, unknown, never>);
    };

    const getRunCount = (): Effect.Effect<number, StorageError> =>
      storage.get<number>(KEYS.CONTINUOUS.RUN_COUNT).pipe(
        Effect.map((count) => count ?? 0)
      );

    const incrementRunCount = (): Effect.Effect<number, StorageError> =>
      Effect.gen(function* () {
        const current = yield* getRunCount();
        const next = current + 1;
        yield* storage.put(KEYS.CONTINUOUS.RUN_COUNT, next);
        return next;
      });

    const updateLastExecutedAt = (): Effect.Effect<void, StorageError> =>
      Effect.gen(function* () {
        const now = yield* runtime.now();
        yield* storage.put(KEYS.CONTINUOUS.LAST_EXECUTED_AT, now);
      });

    const scheduleNext = (
      def: ContinuousDefinition<unknown, unknown, never>
    ): Effect.Effect<void, SchedulerError | ExecutionError> => {
      const schedule = def.schedule;
      switch (schedule._tag) {
        case "Every":
          return alarm.schedule(schedule.interval);
        case "Cron":
          return Effect.fail(
            new ExecutionError({
              primitiveType: "continuous",
              primitiveName: def.name,
              instanceId: runtime.instanceId,
              cause: new Error("Cron schedules are not supported yet"),
            })
          );
      }
    };

    // -------------------------------------------------------------------------
    // Termination Helper
    // -------------------------------------------------------------------------

    /**
     * Perform termination of the primitive.
     * Called when ctx.terminate() is invoked from execute function.
     */
    const performTermination = (
      signal: TerminateSignal
    ): Effect.Effect<void, StorageError | SchedulerError> =>
      Effect.gen(function* () {
        // 1. Cancel any scheduled alarm
        yield* alarm.cancel();

        // 2. Update metadata status
        const newStatus = signal.purgeState ? "terminated" : "stopped";
        yield* metadata.updateStatus(newStatus);

        // 3. Set stop reason if provided
        if (signal.reason) {
          yield* metadata.setStopReason(signal.reason);
        }

        // 4. Optionally purge state
        if (signal.purgeState) {
          yield* storage.delete(KEYS.STATE);
          yield* storage.delete(KEYS.CONTINUOUS.RUN_COUNT);
          yield* storage.delete(KEYS.CONTINUOUS.LAST_EXECUTED_AT);
        }
      });

    // -------------------------------------------------------------------------
    // User Function Execution
    // -------------------------------------------------------------------------

    /**
     * Execute user function.
     * TerminateSignal will propagate up to be caught by the caller.
     */
    const executeUserFunction = <S>(
      def: ContinuousDefinition<S, unknown, never>,
      stateService: EntityStateServiceI<S>,
      runCount: number
    ): Effect.Effect<void, PrimitiveError | TerminateSignal> =>
      Effect.gen(function* () {
        // Get current state
        const currentState = yield* stateService.get().pipe(
          Effect.mapError((e) =>
            new ExecutionError({
              primitiveType: "continuous",
              primitiveName: def.name,
              instanceId: runtime.instanceId,
              cause: e,
            })
          )
        );

        if (currentState === null) {
          return; // Instance was deleted
        }

        // Create state holder for execution
        const stateHolder: StateHolder<S> = {
          current: currentState,
          dirty: false,
        };

        const ctx = createContinuousContext(
          stateHolder,
          runtime.instanceId,
          runCount,
          def.name
        );

        // Helper to wrap errors as ExecutionError
        const wrapError = (e: unknown): ExecutionError =>
          e instanceof ExecutionError
            ? e
            : new ExecutionError({
                primitiveType: "continuous",
                primitiveName: def.name,
                instanceId: runtime.instanceId,
                cause: e,
              });

        // Execute user function
        const executeEffect = Effect.try({
          try: () => def.execute(ctx),
          catch: wrapError,
        }).pipe(Effect.flatten);

        // Run and handle errors
        yield* executeEffect.pipe(
          Effect.catchAll((error): Effect.Effect<void, TerminateSignal | ExecutionError> => {
            // Let TerminateSignal propagate up
            if (error instanceof TerminateSignal) {
              return Effect.fail(error);
            }

            // If user provided onError handler, call it
            if (def.onError) {
              return Effect.try({
                try: () => def.onError!(error, ctx),
                catch: wrapError,
              }).pipe(
                Effect.flatten,
                // Also let TerminateSignal from onError propagate
                Effect.catchAll((onErrorError): Effect.Effect<void, TerminateSignal | ExecutionError> => {
                  if (onErrorError instanceof TerminateSignal) {
                    return Effect.fail(onErrorError);
                  }
                  return Effect.fail(wrapError(onErrorError));
                }),
                Effect.asVoid
              );
            }

            // Re-throw as ExecutionError
            return Effect.fail(wrapError(error));
          })
        );

        // Persist state if modified (only reached if no terminate)
        if (stateHolder.dirty) {
          yield* stateService.set(stateHolder.current).pipe(
            Effect.mapError((e) =>
              new ExecutionError({
                primitiveType: "continuous",
                primitiveName: def.name,
                instanceId: runtime.instanceId,
                cause: e,
              })
            )
          );
        }
      });

    // -------------------------------------------------------------------------
    // Helper to provide storage context to effects
    // -------------------------------------------------------------------------

    const withStorage = <A, E>(
      effect: Effect.Effect<A, E, StorageAdapter>
    ): Effect.Effect<A, E> => Effect.provideService(effect, StorageAdapter, storage);

    // -------------------------------------------------------------------------
    // Action Handlers
    // -------------------------------------------------------------------------

    const handleStart = (
      def: ContinuousDefinition<unknown, unknown, never>,
      request: ContinuousRequest
    ): Effect.Effect<ContinuousResponse, HandlerError | TerminateSignal> =>
      Effect.gen(function* () {
        // Check if already exists
        const existing = yield* metadata.get();
        if (existing) {
          return {
            _type: "continuous.start" as const,
            instanceId: runtime.instanceId,
            created: false,
            status: existing.status,
          };
        }

        // Initialize metadata
        yield* metadata.initialize("continuous", request.name);

        // Create state service and set initial state
        const stateService = yield* withStorage(createEntityStateService(def.stateSchema));
        yield* stateService.set(request.input);

        // Initialize run count
        yield* storage.put(KEYS.CONTINUOUS.RUN_COUNT, 0);

        // Update status to running
        yield* metadata.updateStatus("running");

        // Execute immediately if configured (default true)
        // TerminateSignal will propagate up
        if (def.startImmediately !== false) {
          const runCount = yield* incrementRunCount();
          yield* executeUserFunction(def, stateService, runCount);
          yield* updateLastExecutedAt();
        }

        // Schedule next execution
        yield* scheduleNext(def);

        return {
          _type: "continuous.start" as const,
          instanceId: runtime.instanceId,
          created: true,
          status: "running" as PrimitiveStatus,
        };
      });

    const handleStop = (
      request: ContinuousRequest
    ): Effect.Effect<ContinuousResponse, HandlerError> =>
      Effect.gen(function* () {
        const existing = yield* metadata.get();
        if (!existing) {
          return {
            _type: "continuous.stop" as const,
            stopped: false,
            reason: "not_found",
          };
        }

        if (existing.status === "stopped") {
          return {
            _type: "continuous.stop" as const,
            stopped: false,
            reason: "already_stopped",
          };
        }

        // Cancel any scheduled alarm
        yield* alarm.cancel();

        // Update status
        yield* metadata.updateStatus("stopped");

        return {
          _type: "continuous.stop" as const,
          stopped: true,
          reason: request.reason,
        };
      });

    const handleTrigger = (
      def: ContinuousDefinition<unknown, unknown, never>
    ): Effect.Effect<ContinuousResponse, HandlerError | TerminateSignal> =>
      Effect.gen(function* () {
        const existing = yield* metadata.get();
        if (!existing || existing.status === "stopped" || existing.status === "terminated") {
          return {
            _type: "continuous.trigger" as const,
            triggered: false,
          };
        }

        // Create state service
        const stateService = yield* withStorage(createEntityStateService(def.stateSchema));

        // Get and increment run count
        const runCount = yield* incrementRunCount();

        // Execute user function
        // TerminateSignal will propagate up
        yield* executeUserFunction(def, stateService, runCount);

        // Update last executed timestamp
        yield* updateLastExecutedAt();

        // Re-schedule next execution (resets timer)
        yield* scheduleNext(def);

        return {
          _type: "continuous.trigger" as const,
          triggered: true,
        };
      });

    const handleStatus = (): Effect.Effect<ContinuousResponse, HandlerError> =>
      Effect.gen(function* () {
        const existing = yield* metadata.get();
        if (!existing) {
          return {
            _type: "continuous.status" as const,
            status: "not_found" as const,
          };
        }

        const runCount = yield* getRunCount();
        const nextRunAt = yield* alarm.getScheduled();

        return {
          _type: "continuous.status" as const,
          status: existing.status,
          nextRunAt,
          runCount,
          stopReason: existing.stopReason,
        };
      });

    const handleGetState = (
      def: ContinuousDefinition<unknown, unknown, never>
    ): Effect.Effect<ContinuousResponse, HandlerError> =>
      Effect.gen(function* () {
        const stateService = yield* withStorage(createEntityStateService(def.stateSchema));
        const state = yield* stateService.get();

        return {
          _type: "continuous.getState" as const,
          state,
        };
      });

    // -------------------------------------------------------------------------
    // Main Handler Implementation
    // -------------------------------------------------------------------------

    return {
      handle: (request: ContinuousRequest): Effect.Effect<ContinuousResponse, PrimitiveError> =>
        Effect.gen(function* () {
          const def = yield* getDefinition(request.name);

          switch (request.action) {
            case "start":
              return yield* handleStart(def, request).pipe(
                // Catch TerminateSignal from initial execution
                Effect.catchTag("TerminateSignal", (signal) =>
                  Effect.gen(function* () {
                    yield* performTermination(signal);
                    return {
                      _type: "continuous.start" as const,
                      instanceId: runtime.instanceId,
                      created: true,
                      status: (signal.purgeState ? "terminated" : "stopped") as PrimitiveStatus,
                    };
                  })
                )
              );
            case "stop":
              return yield* handleStop(request);
            case "trigger":
              return yield* handleTrigger(def).pipe(
                // Catch TerminateSignal from triggered execution
                Effect.catchTag("TerminateSignal", (signal) =>
                  Effect.gen(function* () {
                    yield* performTermination(signal);
                    return {
                      _type: "continuous.trigger" as const,
                      triggered: true,
                      terminated: true,
                    };
                  })
                )
              );
            case "status":
              return yield* handleStatus();
            case "getState":
              return yield* handleGetState(def);
          }
        }).pipe(
          // Map internal errors to PrimitiveError
          Effect.catchTag("StorageError", (e) =>
            Effect.fail(
              new ExecutionError({
                primitiveType: "continuous",
                primitiveName: request.name,
                instanceId: runtime.instanceId,
                cause: e,
              })
            )
          ),
          Effect.catchTag("SchedulerError", (e) =>
            Effect.fail(
              new ExecutionError({
                primitiveType: "continuous",
                primitiveName: request.name,
                instanceId: runtime.instanceId,
                cause: e,
              })
            )
          )
        ),

      handleAlarm: (): Effect.Effect<void, PrimitiveError> =>
        Effect.gen(function* () {
          // Get metadata to find primitive name
          const meta = yield* metadata.get();
          if (!meta || meta.status === "stopped" || meta.status === "terminated") {
            return;
          }

          const def = yield* getDefinition(meta.name);

          // Create state service for this schema
          const stateService = yield* withStorage(createEntityStateService(def.stateSchema));

          // Get and increment run count
          const runCount = yield* incrementRunCount();

          // Execute user function
          // Catch TerminateSignal and perform termination
          yield* executeUserFunction(def, stateService, runCount).pipe(
            Effect.catchTag("TerminateSignal", (signal) =>
              performTermination(signal)
            )
          );

          // Only continue if not terminated
          const currentMeta = yield* metadata.get();
          if (currentMeta && currentMeta.status === "running") {
            // Update last executed timestamp
            yield* updateLastExecutedAt();

            // Schedule next execution
            yield* scheduleNext(def);
          }
        }).pipe(
          // Map internal errors to PrimitiveError
          Effect.catchTag("StorageError", (e) =>
            Effect.fail(
              new ExecutionError({
                primitiveType: "continuous",
                primitiveName: "unknown",
                instanceId: runtime.instanceId,
                cause: e,
              })
            )
          ),
          Effect.catchTag("SchedulerError", (e) =>
            Effect.fail(
              new ExecutionError({
                primitiveType: "continuous",
                primitiveName: "unknown",
                instanceId: runtime.instanceId,
                cause: e,
              })
            )
          )
        ),
    };
  })
);
