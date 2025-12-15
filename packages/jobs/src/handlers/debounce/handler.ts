// packages/jobs/src/handlers/debounce/handler.ts

import { Context, Effect, Layer, Schema } from "effect";
import {
  RuntimeAdapter,
  StorageAdapter,
  type StorageError,
  type SchedulerError,
} from "@durable-effect/core";
import { MetadataService } from "../../services/metadata";
import { AlarmService } from "../../services/alarm";
import { createEntityStateService, type EntityStateServiceI } from "../../services/entity-state";
import { RegistryService } from "../../services/registry";
import { KEYS } from "../../storage-keys";
import {
  JobNotFoundError,
  ExecutionError,
  UnknownJobTypeError,
  type JobError,
} from "../../errors";
import {
  RetryExecutor,
  RetryScheduledSignal,
  RetryExhaustedError,
} from "../../retry";
import type { DebounceRequest } from "../../runtime/types";
import type { DebounceDefinition, DebounceExecuteContext } from "../../registry/types";
import type { DebounceHandlerI, DebounceResponse } from "./types";

// =============================================================================
// Service Tag
// =============================================================================

export class DebounceHandler extends Context.Tag(
  "@durable-effect/jobs/DebounceHandler"
)<DebounceHandler, DebounceHandlerI>() {}

// =============================================================================
// Layer Implementation
// =============================================================================

type HandlerError = JobError | StorageError | SchedulerError;

export const DebounceHandlerLayer = Layer.effect(
  DebounceHandler,
  Effect.gen(function* () {
    const registryService = yield* RegistryService;
    const metadata = yield* MetadataService;
    const alarm = yield* AlarmService;
    const runtime = yield* RuntimeAdapter;
    const storage = yield* StorageAdapter;
    const retryExecutor = yield* RetryExecutor;

    const withStorage = <A, E>(
      effect: Effect.Effect<A, E, StorageAdapter>
    ): Effect.Effect<A, E> => Effect.provideService(effect, StorageAdapter, storage);

    const getDefinition = (
      name: string
    ): Effect.Effect<DebounceDefinition<any, any, any, never>, JobNotFoundError> => {
      const def = registryService.registry.debounce[name];
      if (!def) {
        return Effect.fail(new JobNotFoundError({ type: "debounce", name }));
      }
      return Effect.succeed(def as DebounceDefinition<any, any, any, never>);
    };

    const getEventCount = (): Effect.Effect<number, StorageError> =>
      storage.get<number>(KEYS.DEBOUNCE.EVENT_COUNT).pipe(Effect.map((n) => n ?? 0));

    const setEventCount = (count: number): Effect.Effect<void, StorageError> =>
      storage.put(KEYS.DEBOUNCE.EVENT_COUNT, count);

    const getStartedAt = (): Effect.Effect<number | undefined, StorageError> =>
      storage.get<number>(KEYS.DEBOUNCE.STARTED_AT);

    const setStartedAt = (): Effect.Effect<void, StorageError> =>
      Effect.gen(function* () {
        const now = yield* runtime.now();
        yield* storage.put(KEYS.DEBOUNCE.STARTED_AT, now);
      });

    /**
     * Purge all storage data for this debounce job.
     * Uses deleteAll() for safety - ensures no keys are forgotten.
     * Note: deleteAll() does not affect alarms, so we cancel separately.
     */
    const purge = (): Effect.Effect<void, StorageError | SchedulerError> =>
      Effect.gen(function* () {
        yield* alarm.cancel();
        yield* storage.deleteAll();
      });

    const runExecute = <S>(
      def: DebounceDefinition<any, S, any, never>,
      stateService: EntityStateServiceI<S>,
      eventCount: number,
      flushReason: "maxEvents" | "flushAfter" | "manual",
      attempt: number = 1
    ): Effect.Effect<void, ExecutionError> =>
      Effect.gen(function* () {
        const currentState = yield* stateService.get().pipe(
          Effect.mapError((e) =>
            new ExecutionError({
              jobType: "debounce",
              jobName: def.name,
              instanceId: runtime.instanceId,
              cause: e,
            })
          )
        );

        if (currentState === null) {
          return;
        }

        const startedAt = (yield* getStartedAt().pipe(
          Effect.mapError((e) =>
            new ExecutionError({
              jobType: "debounce",
              jobName: def.name,
              instanceId: runtime.instanceId,
              cause: e,
            })
          )
        )) ?? (yield* runtime.now());
        const now = yield* runtime.now();

        const ctx: DebounceExecuteContext<S> = {
          state: Effect.succeed(currentState),
          eventCount: Effect.succeed(eventCount),
          instanceId: runtime.instanceId,
          debounceStartedAt: Effect.succeed(startedAt),
          executionStartedAt: now,
          flushReason,
          attempt,
          isRetry: attempt > 1,
        };

        const wrapError = (e: unknown): ExecutionError =>
          e instanceof ExecutionError
            ? e
            : new ExecutionError({
                jobType: "debounce",
                jobName: def.name,
                instanceId: runtime.instanceId,
                cause: e,
              });

        const execEffect = Effect.try({
          try: () => def.execute(ctx),
          catch: wrapError,
        }).pipe(Effect.flatten);

        yield* execEffect.pipe(
          Effect.catchAll((error): Effect.Effect<void, ExecutionError> => {
            if (def.onError) {
              return Effect.try({
                try: () => def.onError!(error as never, ctx),
                catch: wrapError,
              }).pipe(Effect.flatten, Effect.asVoid);
            }
            return Effect.fail(wrapError(error));
          })
        );
      });

    const flushAndCleanup = (
      def: DebounceDefinition<any, any, any, never>,
      flushReason: "maxEvents" | "flushAfter" | "manual"
    ): Effect.Effect<DebounceResponse, HandlerError | RetryScheduledSignal> => {
      const impl = Effect.gen(function* () {
        const stateService = yield* withStorage(createEntityStateService(def.stateSchema));
        const currentState = yield* stateService.get();
        const eventCount = yield* getEventCount();

        if (currentState === null || eventCount === 0) {
          yield* purge();
          return {
            _type: "debounce.flush" as const,
            flushed: false,
            eventCount: 0,
            reason: "empty" as const,
          };
        }

        // Get current attempt for context
        const attempt = yield* retryExecutor.getAttempt().pipe(
          Effect.catchAll(() => Effect.succeed(1)),
        );

        if (!def.retry) {
          // No retry configured - execute directly
          yield* runExecute(def, stateService, eventCount, flushReason, attempt);

          // Cleanup storage and metadata
          yield* purge();

          return {
            _type: "debounce.flush" as const,
            flushed: true,
            eventCount,
            reason: flushReason,
          };
        }

        // Create execute effect for retry wrapper
        const executeEffect = runExecute(
          def,
          stateService,
          eventCount,
          flushReason,
          attempt,
        );

        // Wrap with retry executor
        yield* retryExecutor
          .executeWithRetry(
            executeEffect as Effect.Effect<void, unknown, never>,
            def.retry,
            { jobType: "debounce", jobName: def.name },
          )
          .pipe(
            Effect.catchAll((error): Effect.Effect<
              void,
              HandlerError | RetryScheduledSignal
            > => {
              // Handle RetryScheduledSignal - propagate (don't purge)
              if (error instanceof RetryScheduledSignal) {
                return Effect.fail(error);
              }

              // Handle RetryExhaustedError - onError already called in runExecute,
              // just continue to purge
              if (error instanceof RetryExhaustedError) {
                return Effect.void;
              }

              // Other errors - wrap and propagate
              return Effect.fail(
                new ExecutionError({
                  jobType: "debounce",
                  jobName: def.name,
                  instanceId: runtime.instanceId,
                  cause: error,
                }),
              );
            }),
          );

        // Cleanup storage and metadata (only reached if not retry scheduled)
        yield* purge();

        return {
          _type: "debounce.flush" as const,
          flushed: true,
          eventCount,
          reason: flushReason,
        };
      });

      return impl as Effect.Effect<DebounceResponse, HandlerError | RetryScheduledSignal>;
    };

    const handleAdd = (
      def: DebounceDefinition<any, any, any, never>,
      request: DebounceRequest
    ): Effect.Effect<DebounceResponse, HandlerError> =>
      Effect.gen(function* () {
        const meta = yield* metadata.get();
        const created = !meta;

        if (created) {
          yield* metadata.initialize("debounce", request.name);
          yield* metadata.updateStatus("running");
          yield* setStartedAt();
          yield* setEventCount(0);
        }

        const stateService = yield* withStorage(createEntityStateService(def.stateSchema));
        const currentState = yield* stateService.get();
        const currentCount = yield* getEventCount();
        const nextCount = currentCount + 1;

        const decodeEvent = Schema.decodeUnknown(def.eventSchema);
        const validatedEvent = yield* decodeEvent(request.event).pipe(
          Effect.mapError((e) =>
            new ExecutionError({
              jobType: "debounce",
              jobName: def.name,
              instanceId: runtime.instanceId,
              cause: e,
            })
          )
        );

        // Auto-initialize state from event when null (first event)
        const stateForContext = currentState ?? (validatedEvent as unknown);

        const onEvent = def.onEvent!;
        const reducedState = yield* onEvent({
          event: validatedEvent as unknown,
          state: stateForContext,
          eventCount: nextCount,
          instanceId: runtime.instanceId,
        } as any);

        yield* stateService.set(reducedState);
        yield* setEventCount(nextCount);

        if (created) {
          yield* alarm.schedule(def.flushAfter);
        }

        const willFlushAt = yield* alarm.getScheduled();

        if (def.maxEvents !== undefined && nextCount >= def.maxEvents) {
          const retryScheduled = yield* flushAndCleanup(def, "maxEvents").pipe(
            Effect.map(() => false),
            Effect.catchTag("RetryScheduledSignal", () => Effect.succeed(true)),
          );

          const scheduledAt = retryScheduled
            ? (yield* alarm.getScheduled().pipe(Effect.orElse(() => Effect.succeed(undefined)))) ?? null
            : null;

          return {
            _type: "debounce.add" as const,
            instanceId: runtime.instanceId,
            eventCount: nextCount,
            willFlushAt: scheduledAt,
            created,
            retryScheduled,
          };
        }

        return {
          _type: "debounce.add" as const,
          instanceId: runtime.instanceId,
          eventCount: nextCount,
          willFlushAt: willFlushAt ?? null,
          created,
        };
      });

    const handleFlush = (
      def: DebounceDefinition<any, any, any, never>,
      reason: "manual" | "flushAfter" | "maxEvents"
    ): Effect.Effect<DebounceResponse, HandlerError | RetryScheduledSignal> =>
      Effect.gen(function* () {
        const meta = yield* metadata.get();
        if (!meta) {
          return {
            _type: "debounce.flush" as const,
            flushed: false,
            eventCount: 0,
            reason: "empty" as const,
          };
        }

        const eventCount = yield* getEventCount();
        if (eventCount === 0) {
          yield* purge();
          return {
            _type: "debounce.flush" as const,
            flushed: false,
            eventCount: 0,
            reason: "empty" as const,
          };
        }

        return yield* flushAndCleanup(def, reason);
      });

    const handleClear = (): Effect.Effect<DebounceResponse, HandlerError> =>
      Effect.gen(function* () {
        const meta = yield* metadata.get();
        if (!meta) {
          return {
            _type: "debounce.clear" as const,
            cleared: false,
            discardedEvents: 0,
          };
        }

        const eventCount = yield* getEventCount();
        yield* purge();

        return {
          _type: "debounce.clear" as const,
          cleared: true,
          discardedEvents: eventCount,
        };
      });

    const handleStatus = (): Effect.Effect<DebounceResponse, HandlerError> =>
      Effect.gen(function* () {
        const meta = yield* metadata.get();
        if (!meta) {
          return {
            _type: "debounce.status" as const,
            status: "not_found" as const,
          };
        }

        const eventCount = yield* getEventCount();
        const startedAt = yield* getStartedAt();
        const willFlushAt = yield* alarm.getScheduled();

        return {
          _type: "debounce.status" as const,
          status: eventCount > 0 ? "debouncing" : "idle",
          eventCount,
          startedAt,
          willFlushAt: willFlushAt ?? undefined,
        };
      });

    const handleGetState = (
      def: DebounceDefinition<any, any, any, never>
    ): Effect.Effect<DebounceResponse, HandlerError> =>
      Effect.gen(function* () {
        const stateService = yield* withStorage(createEntityStateService(def.stateSchema));
        const state = yield* stateService.get();

        return {
          _type: "debounce.getState" as const,
          state,
        };
      });

    return {
      handle: (request: DebounceRequest): Effect.Effect<DebounceResponse, JobError> =>
        Effect.gen(function* () {
          const def = yield* getDefinition(request.name);

          switch (request.action) {
            case "add":
              return yield* handleAdd(def, request);
            case "flush":
              return yield* handleFlush(def, "manual").pipe(
                // Catch RetryScheduledSignal and return appropriate response
                Effect.catchTag("RetryScheduledSignal", () =>
                  Effect.gen(function* () {
                    const eventCount = yield* getEventCount();
                    return {
                      _type: "debounce.flush" as const,
                      flushed: false,
                      eventCount,
                      reason: "manual" as const,
                      retryScheduled: true,
                    };
                  }),
                ),
              );
            case "clear":
              return yield* handleClear();
            case "status":
              return yield* handleStatus();
            case "getState":
              return yield* handleGetState(def);
            default:
              return yield* Effect.fail(
                new UnknownJobTypeError({ type: `debounce/${(request as any).action}` })
              );
          }
        }).pipe(
          Effect.catchTag("StorageError", (e) =>
            Effect.fail(
              new ExecutionError({
                jobType: "debounce",
                jobName: request.name,
                instanceId: runtime.instanceId,
                cause: e,
              })
            )
          ),
          Effect.catchTag("SchedulerError", (e) =>
            Effect.fail(
              new ExecutionError({
                jobType: "debounce",
                jobName: request.name,
                instanceId: runtime.instanceId,
                cause: e,
              })
            )
          )
        ),

      handleAlarm: (): Effect.Effect<void, JobError> =>
        Effect.gen(function* () {
          const meta = yield* metadata.get();
          if (!meta || meta.status === "stopped" || meta.status === "terminated") {
            return;
          }

          const def = yield* getDefinition(meta.name);

          // Check if this is a retry alarm
          const isRetrying = yield* retryExecutor.isRetrying().pipe(
            Effect.catchAll(() => Effect.succeed(false)),
          );

          // Reset retry state if manual trigger while retrying
          if (!isRetrying) {
            yield* retryExecutor.reset().pipe(Effect.ignore);
          }

          const retryScheduled = yield* handleFlush(def, "flushAfter").pipe(
            Effect.map((result) => {
              // If not flushed and not retrying, purge
              if (result._type === "debounce.flush" && !result.flushed) {
                return "empty";
              }
              return "success";
            }),
            Effect.catchTag("RetryScheduledSignal", () =>
              Effect.succeed("retry_scheduled" as const),
            ),
          );

          // Only purge if flush returned empty and no retry scheduled
          if (retryScheduled === "empty") {
            yield* purge();
          }
          // If retry_scheduled, don't purge - alarm already set by RetryExecutor
        }).pipe(
          Effect.catchTag("StorageError", (e) =>
            Effect.fail(
              new ExecutionError({
                jobType: "debounce",
                jobName: "unknown",
                instanceId: runtime.instanceId,
                cause: e,
              })
            )
          ),
          Effect.catchTag("SchedulerError", (e) =>
            Effect.fail(
              new ExecutionError({
                jobType: "debounce",
                jobName: "unknown",
                instanceId: runtime.instanceId,
                cause: e,
              })
            )
          )
        ),
    };
  })
);
