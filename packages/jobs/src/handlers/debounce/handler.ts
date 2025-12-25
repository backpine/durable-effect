// packages/jobs/src/handlers/debounce/handler.ts

import { Context, Effect, Layer, Schema } from "effect";
import {
  RuntimeAdapter,
  StorageAdapter,
  createJobBaseEvent,
  emitEvent,
  type StorageError,
  type SchedulerError,
  type InternalDebounceStartedEvent,
  type InternalDebounceFlushedEvent,
} from "@durable-effect/core";
import { MetadataService } from "../../services/metadata";
import { AlarmService } from "../../services/alarm";
import { createEntityStateService } from "../../services/entity-state";
import { RegistryService } from "../../services/registry";
import { JobExecutionService, type ExecutionResult } from "../../services/execution";
import { KEYS } from "../../storage-keys";
import {
  JobNotFoundError,
  ExecutionError,
  UnknownJobTypeError,
  type JobError,
} from "../../errors";
import { RetryExecutor } from "../../retry";
import { withJobLogging } from "../../services/job-logging";
import type { DebounceRequest } from "../../runtime/types";
import type { DebounceDefinition, DebounceExecuteContext } from "../../registry/types";
import type { DebounceHandlerI, DebounceResponse } from "./types";

export class DebounceHandler extends Context.Tag(
  "@durable-effect/jobs/DebounceHandler"
)<DebounceHandler, DebounceHandlerI>() {}

type HandlerError = JobError | StorageError | SchedulerError;

export const DebounceHandlerLayer = Layer.effect(
  DebounceHandler,
  Effect.gen(function* () {
    const registryService = yield* RegistryService;
    const metadata = yield* MetadataService;
    const alarm = yield* AlarmService;
    const runtime = yield* RuntimeAdapter;
    const storage = yield* StorageAdapter;
    const execution = yield* JobExecutionService;
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

    const purge = (): Effect.Effect<void, StorageError | SchedulerError> =>
      Effect.gen(function* () {
        yield* alarm.cancel();
        yield* storage.deleteAll();
      });

    const runFlush = (
      def: DebounceDefinition<any, any, any, never>,
      flushReason: "maxEvents" | "flushAfter" | "manual",
      id?: string
    ): Effect.Effect<ExecutionResult, ExecutionError> =>
      execution.execute({
        jobType: "debounce",
        jobName: def.name,
        schema: def.stateSchema,
        retryConfig: def.retry,
        runCount: 0, // Debounce doesn't track runCount persistently in same way
        id,
        run: (ctx: DebounceExecuteContext<any>) => def.execute(ctx),
        createContext: (base) => {
           return {
             state: Effect.succeed(base.getState()), // Snapshotted state
             eventCount: getEventCount().pipe(Effect.orDie), // Live event count
             instanceId: base.instanceId,
             debounceStartedAt: getStartedAt().pipe(Effect.orDie, Effect.map(t => t ?? 0)),
             executionStartedAt: Date.now(),
             flushReason,
             attempt: base.attempt,
             isRetry: base.isRetry
           } as DebounceExecuteContext<any>;
        }
      });

    const handleAdd = (
      def: DebounceDefinition<any, any, any, never>,
      request: DebounceRequest
    ): Effect.Effect<DebounceResponse, HandlerError> =>
      Effect.gen(function* () {
        const meta = yield* metadata.get();
        const created = !meta;

        if (created) {
          yield* metadata.initialize("debounce", request.name, request.id);
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

        const stateForContext = currentState ?? (validatedEvent as unknown);

        const onEvent = def.onEvent!;
        // Cast is still needed unless we fix Definition generic constraints
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

          // Emit debounce.started event for first event
          const scheduledAt = yield* alarm.getScheduled();
          yield* emitEvent({
            ...createJobBaseEvent(runtime.instanceId, "debounce", request.name, request.id),
            type: "debounce.started" as const,
            flushAt: scheduledAt ? new Date(scheduledAt).toISOString() : new Date().toISOString(),
          } satisfies InternalDebounceStartedEvent);
        }

        const willFlushAt = yield* alarm.getScheduled();

        if (def.maxEvents !== undefined && nextCount >= def.maxEvents) {
          // Get startedAt for duration calculation before flush
          const startedAt = yield* getStartedAt();
          const durationMs = startedAt ? Date.now() - startedAt : 0;

          // Immediate flush - use request.id since we just initialized or it's the same
          const result = yield* runFlush(def, "maxEvents", request.id);

          if (result.success) {
            // Emit debounce.flushed event for maxEvents trigger
            yield* emitEvent({
              ...createJobBaseEvent(runtime.instanceId, "debounce", def.name, request.id),
              type: "debounce.flushed" as const,
              eventCount: nextCount,
              reason: "maxEvents" as const,
              durationMs,
            } satisfies InternalDebounceFlushedEvent);

            // Success - purge state after flush
            yield* purge();
          } else if (result.terminated) {
            // Terminated by CleanupService - already purged
          } else if (!result.retryScheduled && !result.rescheduled) {
            // Execution failed without retry - purge to avoid zombie state
            yield* purge();
          }

          return {
            _type: "debounce.add" as const,
            instanceId: runtime.instanceId,
            eventCount: nextCount,
            willFlushAt: result.retryScheduled ? ((yield* alarm.getScheduled()) ?? null) : null,
            created,
            retryScheduled: result.retryScheduled,
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
    ): Effect.Effect<DebounceResponse, HandlerError> =>
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

        // Get startedAt for duration calculation
        const startedAt = yield* getStartedAt();
        const durationMs = startedAt ? Date.now() - startedAt : 0;

        const result = yield* runFlush(def, reason, meta.id);

        if (result.success) {
          // Emit debounce.flushed event
          yield* emitEvent({
            ...createJobBaseEvent(runtime.instanceId, "debounce", def.name, meta.id),
            type: "debounce.flushed" as const,
            eventCount,
            reason: reason === "flushAfter" ? "timeout" : reason,
            durationMs,
          } satisfies InternalDebounceFlushedEvent);

          // Success - purge state after flush
          yield* purge();
        } else if (result.terminated) {
          // Terminated by CleanupService - already purged
        } else if (!result.retryScheduled && !result.rescheduled) {
          // Execution failed without retry - purge to avoid zombie state
          yield* purge();
        }

        return {
          _type: "debounce.flush" as const,
          flushed: true,
          eventCount,
          reason,
          retryScheduled: result.retryScheduled
        };
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

          const handlerEffect = Effect.gen(function* () {
            switch (request.action) {
              case "add":
                return yield* handleAdd(def, request);
              case "flush":
                return yield* handleFlush(def, "manual");
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
          });

          return yield* withJobLogging(handlerEffect, {
            logging: def.logging,
            jobType: "debounce",
            jobName: def.name,
            instanceId: runtime.instanceId,
          });
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

          const alarmEffect = Effect.gen(function* () {
            // Check if this is a retry alarm
            const isRetrying = yield* retryExecutor.isRetrying().pipe(
              Effect.catchAll(() => Effect.succeed(false)),
            );

            // Reset retry state if manual trigger while retrying
            if (!isRetrying) {
              yield* retryExecutor.reset().pipe(Effect.ignore);
            }

            const result = yield* handleFlush(def, "flushAfter");
            void result;

            // Note: handleFlush already purges on success.
            // If retryScheduled, handleFlush returns retryScheduled=true.
            // We don't need to do anything else.
          });

          yield* withJobLogging(alarmEffect, {
            logging: def.logging,
            jobType: "debounce",
            jobName: def.name,
            instanceId: runtime.instanceId,
          });
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
