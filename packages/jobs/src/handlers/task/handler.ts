// packages/jobs/src/handlers/task/handler.ts

import { Context, Effect, Layer, Schema } from "effect";
import {
  RuntimeAdapter,
  StorageAdapter,
  type StorageError,
  type SchedulerError,
} from "@durable-effect/core";
import { MetadataService } from "../../services/metadata";
import { AlarmService } from "../../services/alarm";
import {
  createEntityStateService,
  type EntityStateServiceI,
} from "../../services/entity-state";
import { RegistryService } from "../../services/registry";
import { KEYS } from "../../storage-keys";
import {
  JobNotFoundError,
  ExecutionError,
  ClearSignal,
  type JobError,
} from "../../errors";
import type { TaskRequest } from "../../runtime/types";
import type { StoredTaskDefinition } from "../../registry/types";
import type { TaskHandlerI, TaskResponse } from "./types";
import {
  createTaskEventContext,
  createTaskExecuteContext,
  createTaskIdleContext,
  createTaskErrorContext,
  type TaskStateHolder,
  type TaskScheduleHolder,
} from "./context";

// =============================================================================
// Service Tag
// =============================================================================

export class TaskHandler extends Context.Tag(
  "@durable-effect/jobs/TaskHandler",
)<TaskHandler, TaskHandlerI>() {}

// =============================================================================
// Layer Implementation
// =============================================================================

type HandlerError = JobError | StorageError | SchedulerError;

export const TaskHandlerLayer = Layer.effect(
  TaskHandler,
  Effect.gen(function* () {
    const registryService = yield* RegistryService;
    const metadata = yield* MetadataService;
    const alarm = yield* AlarmService;
    const runtime = yield* RuntimeAdapter;
    const storage = yield* StorageAdapter;

    // -------------------------------------------------------------------------
    // Helper: Provide storage to effects
    // -------------------------------------------------------------------------
    const withStorage = <A, E>(
      effect: Effect.Effect<A, E, StorageAdapter>,
    ): Effect.Effect<A, E> =>
      Effect.provideService(effect, StorageAdapter, storage);

    // -------------------------------------------------------------------------
    // Helper: Get definition from registry
    // -------------------------------------------------------------------------
    const getDefinition = (
      name: string,
    ): Effect.Effect<StoredTaskDefinition<any, any, any>, JobNotFoundError> => {
      const def = registryService.registry.task[name];
      if (!def) {
        return Effect.fail(new JobNotFoundError({ type: "task", name }));
      }
      return Effect.succeed(def);
    };

    // -------------------------------------------------------------------------
    // Storage Helpers
    // -------------------------------------------------------------------------
    const getEventCount = (): Effect.Effect<number, StorageError> =>
      storage
        .get<number>(KEYS.TASK.EVENT_COUNT)
        .pipe(Effect.map((n) => n ?? 0));

    const incrementEventCount = (): Effect.Effect<number, StorageError> =>
      Effect.gen(function* () {
        const current = yield* getEventCount();
        const next = current + 1;
        yield* storage.put(KEYS.TASK.EVENT_COUNT, next);
        return next;
      });

    const getExecuteCount = (): Effect.Effect<number, StorageError> =>
      storage
        .get<number>(KEYS.TASK.EXECUTE_COUNT)
        .pipe(Effect.map((n) => n ?? 0));

    const incrementExecuteCount = (): Effect.Effect<number, StorageError> =>
      Effect.gen(function* () {
        const current = yield* getExecuteCount();
        const next = current + 1;
        yield* storage.put(KEYS.TASK.EXECUTE_COUNT, next);
        return next;
      });

    const getCreatedAt = (): Effect.Effect<number | undefined, StorageError> =>
      storage.get<number>(KEYS.TASK.CREATED_AT);

    const setCreatedAt = (
      timestamp: number,
    ): Effect.Effect<void, StorageError> =>
      storage.put(KEYS.TASK.CREATED_AT, timestamp);

    const getScheduledAt = (): Effect.Effect<number | null, StorageError> =>
      storage
        .get<number>(KEYS.TASK.SCHEDULED_AT)
        .pipe(Effect.map((t) => t ?? null));

    const setScheduledAt = (
      timestamp: number | null,
    ): Effect.Effect<void, StorageError> =>
      timestamp === null
        ? storage.delete(KEYS.TASK.SCHEDULED_AT).pipe(Effect.asVoid)
        : storage.put(KEYS.TASK.SCHEDULED_AT, timestamp);

    // -------------------------------------------------------------------------
    // Purge: Clear all storage and cancel alarm
    // -------------------------------------------------------------------------
    const purge = (): Effect.Effect<void, StorageError | SchedulerError> =>
      Effect.gen(function* () {
        yield* alarm.cancel();
        yield* storage.deleteAll();
      });

    // -------------------------------------------------------------------------
    // Apply schedule holder changes
    // -------------------------------------------------------------------------
    const applyScheduleChanges = (
      holder: TaskScheduleHolder,
    ): Effect.Effect<void, StorageError | SchedulerError> =>
      Effect.gen(function* () {
        if (!holder.dirty) return;

        if (holder.cancelled) {
          yield* alarm.cancel();
          yield* setScheduledAt(null);
        } else if (holder.scheduledAt !== null) {
          yield* alarm.schedule(holder.scheduledAt);
          yield* setScheduledAt(holder.scheduledAt);
        }
      });

    // -------------------------------------------------------------------------
    // Run onIdle if no alarm scheduled
    // -------------------------------------------------------------------------
    const maybeRunOnIdle = <S>(
      def: StoredTaskDefinition<S, any, any>,
      stateHolder: TaskStateHolder<S>,
      scheduleHolder: TaskScheduleHolder,
      idleReason: "onEvent" | "execute",
      getState: () => Effect.Effect<S | null, never, never>,
    ): Effect.Effect<void, HandlerError | ClearSignal, any> =>
      Effect.gen(function* () {
        if (!def.onIdle) return;

        // Check if alarm is scheduled
        const scheduled = scheduleHolder.dirty
          ? scheduleHolder.scheduledAt
          : yield* getScheduledAt();

        if (scheduled !== null) return; // Not idle

        const ctx = createTaskIdleContext(
          stateHolder,
          scheduleHolder,
          runtime.instanceId,
          def.name,
          idleReason,
          getState,
          () =>
            getScheduledAt().pipe(Effect.catchAll(() => Effect.succeed(null))),
        );

        yield* Effect.try({
          try: () => def.onIdle!(ctx),
          catch: (e) =>
            new ExecutionError({
              jobType: "task",
              jobName: def.name,
              instanceId: runtime.instanceId,
              cause: e,
            }),
        }).pipe(Effect.flatten);
      });

    // -------------------------------------------------------------------------
    // Handle: send
    // -------------------------------------------------------------------------
    const handleSend = (
      def: StoredTaskDefinition<any, any, any>,
      request: TaskRequest,
    ): Effect.Effect<TaskResponse, HandlerError | ClearSignal, any> =>
      Effect.gen(function* () {
        const meta = yield* metadata.get();
        const created = !meta;
        const now = yield* runtime.now();

        // Initialize if new
        if (created) {
          yield* metadata.initialize("task", request.name);
          yield* metadata.updateStatus("running");
          yield* setCreatedAt(now);
          yield* storage.put(KEYS.TASK.EVENT_COUNT, 0);
          yield* storage.put(KEYS.TASK.EXECUTE_COUNT, 0);
        }

        // Increment event count
        yield* incrementEventCount();

        // Get state service and load current state
        const stateService = yield* withStorage(
          createEntityStateService(def.stateSchema),
        );
        const currentState = yield* stateService.get();

        // Decode event
        const decodeEvent = Schema.decodeUnknown(def.eventSchema);
        const validatedEvent = yield* decodeEvent(request.event).pipe(
          Effect.mapError(
            (e) =>
              new ExecutionError({
                jobType: "task",
                jobName: def.name,
                instanceId: runtime.instanceId,
                cause: e,
              }),
          ),
        );

        // Create holders
        const stateHolder: TaskStateHolder<any> = {
          current: currentState,
          dirty: false,
        };

        const scheduleHolder: TaskScheduleHolder = {
          scheduledAt: null,
          cancelled: false,
          dirty: false,
        };

        // Create context
        const ctx = createTaskEventContext(
          stateHolder,
          scheduleHolder,
          validatedEvent,
          runtime.instanceId,
          def.name,
          now,
          () => getEventCount().pipe(Effect.catchAll(() => Effect.succeed(0))),
          () =>
            getCreatedAt().pipe(
              Effect.map((t) => t ?? now),
              Effect.catchAll(() => Effect.succeed(now)),
            ),
          () =>
            getScheduledAt().pipe(Effect.catchAll(() => Effect.succeed(null))),
        );

        // Run onEvent
        const getState = () =>
          stateHolder.dirty
            ? Effect.succeed(stateHolder.current)
            : stateService
                .get()
                .pipe(Effect.catchAll(() => Effect.succeed(null)));

        yield* Effect.try({
          try: () => def.onEvent(ctx),
          catch: (e) =>
            new ExecutionError({
              jobType: "task",
              jobName: def.name,
              instanceId: runtime.instanceId,
              cause: e,
            }),
        }).pipe(
          Effect.flatten,
          Effect.catchAll(
            (
              error: unknown,
            ): Effect.Effect<void, HandlerError | ClearSignal, any> => {
              // Let ClearSignal propagate
              if (error instanceof ClearSignal) {
                return Effect.fail(error);
              }

              // Call onError if provided
              if (def.onError) {
                const errorCtx = createTaskErrorContext(
                  stateHolder,
                  scheduleHolder,
                  runtime.instanceId,
                  def.name,
                  "onEvent",
                  getState,
                  () =>
                    getScheduledAt().pipe(
                      Effect.catchAll(() => Effect.succeed(null)),
                    ),
                );
                return Effect.try({
                  try: () => def.onError!(error, errorCtx),
                  catch: (e) =>
                    new ExecutionError({
                      jobType: "task",
                      jobName: def.name,
                      instanceId: runtime.instanceId,
                      cause: e,
                    }),
                }).pipe(Effect.flatten, Effect.ignore);
              }

              // Re-throw wrapped error
              return Effect.fail(
                error instanceof ExecutionError
                  ? error
                  : new ExecutionError({
                      jobType: "task",
                      jobName: def.name,
                      instanceId: runtime.instanceId,
                      cause: error,
                    }),
              );
            },
          ),
        );

        // Persist state if dirty
        if (stateHolder.dirty && stateHolder.current !== null) {
          yield* stateService.set(stateHolder.current);
        }

        // Apply schedule changes
        yield* applyScheduleChanges(scheduleHolder);

        // Maybe run onIdle
        yield* maybeRunOnIdle(
          def,
          stateHolder,
          scheduleHolder,
          "onEvent",
          getState,
        );

        // Re-apply schedule changes after onIdle
        yield* applyScheduleChanges(scheduleHolder);

        // Persist state again if onIdle modified it
        if (stateHolder.dirty && stateHolder.current !== null) {
          yield* stateService.set(stateHolder.current);
        }

        // Get final scheduled time
        const scheduledAt = scheduleHolder.dirty
          ? scheduleHolder.scheduledAt
          : yield* getScheduledAt();

        return {
          _type: "task.send" as const,
          instanceId: runtime.instanceId,
          created,
          scheduledAt,
        };
      });

    // -------------------------------------------------------------------------
    // Handle: trigger (manual execution)
    // -------------------------------------------------------------------------
    const handleTrigger = (
      def: StoredTaskDefinition<any, any, any>,
    ): Effect.Effect<TaskResponse, HandlerError | ClearSignal, any> =>
      Effect.gen(function* () {
        const meta = yield* metadata.get();
        if (!meta) {
          return {
            _type: "task.trigger" as const,
            instanceId: runtime.instanceId,
            triggered: false,
          };
        }

        yield* runExecute(def);

        return {
          _type: "task.trigger" as const,
          instanceId: runtime.instanceId,
          triggered: true,
        };
      });

    // -------------------------------------------------------------------------
    // Handle: clear
    // -------------------------------------------------------------------------
    const handleClear = (): Effect.Effect<TaskResponse, HandlerError> =>
      Effect.gen(function* () {
        const meta = yield* metadata.get();
        if (!meta) {
          return {
            _type: "task.clear" as const,
            instanceId: runtime.instanceId,
            cleared: false,
          };
        }

        yield* purge();

        return {
          _type: "task.clear" as const,
          instanceId: runtime.instanceId,
          cleared: true,
        };
      });

    // -------------------------------------------------------------------------
    // Handle: status
    // -------------------------------------------------------------------------
    const handleStatus = (): Effect.Effect<TaskResponse, HandlerError> =>
      Effect.gen(function* () {
        const meta = yield* metadata.get();
        if (!meta) {
          return {
            _type: "task.status" as const,
            status: "not_found" as const,
            scheduledAt: null,
            createdAt: undefined,
            eventCount: undefined,
            executeCount: undefined,
          };
        }

        const scheduledAt = yield* getScheduledAt();
        const createdAt = yield* getCreatedAt();
        const eventCount = yield* getEventCount();
        const executeCount = yield* getExecuteCount();

        return {
          _type: "task.status" as const,
          status: scheduledAt !== null ? "active" : "idle",
          scheduledAt,
          createdAt,
          eventCount,
          executeCount,
        };
      });

    // -------------------------------------------------------------------------
    // Handle: getState
    // -------------------------------------------------------------------------
    const handleGetState = (
      def: StoredTaskDefinition<any, any, any>,
    ): Effect.Effect<TaskResponse, HandlerError> =>
      Effect.gen(function* () {
        const meta = yield* metadata.get();
        if (!meta) {
          return {
            _type: "task.getState" as const,
            instanceId: runtime.instanceId,
            state: undefined,
            scheduledAt: null,
            createdAt: undefined,
          };
        }

        const stateService = yield* withStorage(
          createEntityStateService(def.stateSchema),
        );
        const state = yield* stateService.get();
        const scheduledAt = yield* getScheduledAt();
        const createdAt = yield* getCreatedAt();

        return {
          _type: "task.getState" as const,
          instanceId: runtime.instanceId,
          state,
          scheduledAt,
          createdAt,
        };
      });

    // -------------------------------------------------------------------------
    // Run execute (shared by trigger and alarm)
    // -------------------------------------------------------------------------
    const runExecute = (
      def: StoredTaskDefinition<any, any, any>,
    ): Effect.Effect<void, HandlerError | ClearSignal, any> =>
      Effect.gen(function* () {
        const now = yield* runtime.now();

        // Increment execute count
        yield* incrementExecuteCount();

        // Get state service
        const stateService = yield* withStorage(
          createEntityStateService(def.stateSchema),
        );

        // Create holders
        const stateHolder: TaskStateHolder<any> = {
          current: null,
          dirty: false,
        };

        const scheduleHolder: TaskScheduleHolder = {
          scheduledAt: null,
          cancelled: false,
          dirty: false,
        };

        // Create context
        const getState = () =>
          stateHolder.dirty
            ? Effect.succeed(stateHolder.current)
            : stateService
                .get()
                .pipe(Effect.catchAll(() => Effect.succeed(null)));

        const ctx = createTaskExecuteContext(
          stateHolder,
          scheduleHolder,
          runtime.instanceId,
          def.name,
          now,
          getState,
          () => getEventCount().pipe(Effect.catchAll(() => Effect.succeed(0))),
          () =>
            getCreatedAt().pipe(
              Effect.map((t) => t ?? now),
              Effect.catchAll(() => Effect.succeed(now)),
            ),
          () =>
            getExecuteCount().pipe(Effect.catchAll(() => Effect.succeed(0))),
          () =>
            getScheduledAt().pipe(Effect.catchAll(() => Effect.succeed(null))),
        );

        // Run execute
        yield* Effect.try({
          try: () => def.execute(ctx),
          catch: (e) =>
            new ExecutionError({
              jobType: "task",
              jobName: def.name,
              instanceId: runtime.instanceId,
              cause: e,
            }),
        }).pipe(
          Effect.flatten,
          Effect.catchAll(
            (
              error: unknown,
            ): Effect.Effect<void, HandlerError | ClearSignal, any> => {
              // Let ClearSignal propagate
              if (error instanceof ClearSignal) {
                return Effect.fail(error);
              }

              // Call onError if provided
              if (def.onError) {
                const errorCtx = createTaskErrorContext(
                  stateHolder,
                  scheduleHolder,
                  runtime.instanceId,
                  def.name,
                  "execute",
                  getState,
                  () =>
                    getScheduledAt().pipe(
                      Effect.catchAll(() => Effect.succeed(null)),
                    ),
                );
                return Effect.try({
                  try: () => def.onError!(error, errorCtx),
                  catch: (e) =>
                    new ExecutionError({
                      jobType: "task",
                      jobName: def.name,
                      instanceId: runtime.instanceId,
                      cause: e,
                    }),
                }).pipe(Effect.flatten, Effect.ignore);
              }

              // Re-throw wrapped error
              return Effect.fail(
                error instanceof ExecutionError
                  ? error
                  : new ExecutionError({
                      jobType: "task",
                      jobName: def.name,
                      instanceId: runtime.instanceId,
                      cause: error,
                    }),
              );
            },
          ),
        );

        // Persist state if dirty
        if (stateHolder.dirty && stateHolder.current !== null) {
          yield* stateService.set(stateHolder.current);
        }

        // Apply schedule changes
        yield* applyScheduleChanges(scheduleHolder);

        // Maybe run onIdle
        yield* maybeRunOnIdle(
          def,
          stateHolder,
          scheduleHolder,
          "execute",
          getState,
        );

        // Re-apply schedule changes after onIdle
        yield* applyScheduleChanges(scheduleHolder);

        // Persist state again if onIdle modified it
        if (stateHolder.dirty && stateHolder.current !== null) {
          yield* stateService.set(stateHolder.current);
        }
      });

    // -------------------------------------------------------------------------
    // Return handler interface
    // -------------------------------------------------------------------------
    return {
      handle: (
        request: TaskRequest,
      ): Effect.Effect<TaskResponse, JobError, any> =>
        Effect.gen(function* () {
          const def = yield* getDefinition(request.name);

          switch (request.action) {
            case "send":
              return yield* handleSend(def, request).pipe(
                Effect.catchTag("ClearSignal", () =>
                  Effect.gen(function* () {
                    yield* purge();
                    return {
                      _type: "task.send" as const,
                      instanceId: runtime.instanceId,
                      created: false,
                      scheduledAt: null,
                    };
                  }),
                ),
              );

            case "trigger":
              return yield* handleTrigger(def).pipe(
                Effect.catchTag("ClearSignal", () =>
                  Effect.gen(function* () {
                    yield* purge();
                    return {
                      _type: "task.trigger" as const,
                      instanceId: runtime.instanceId,
                      triggered: true,
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
          }
        }).pipe(
          Effect.catchTag("StorageError", (e) =>
            Effect.fail(
              new ExecutionError({
                jobType: "task",
                jobName: request.name,
                instanceId: runtime.instanceId,
                cause: e,
              }),
            ),
          ),
          Effect.catchTag("SchedulerError", (e) =>
            Effect.fail(
              new ExecutionError({
                jobType: "task",
                jobName: request.name,
                instanceId: runtime.instanceId,
                cause: e,
              }),
            ),
          ),
        ),

      handleAlarm: (): Effect.Effect<void, JobError, any> =>
        Effect.gen(function* () {
          const meta = yield* metadata.get();
          if (!meta || meta.type !== "task") {
            return;
          }

          const def = yield* getDefinition(meta.name);

          yield* runExecute(def).pipe(
            Effect.catchTag("ClearSignal", () =>
              purge().pipe(Effect.catchAll(() => Effect.void)),
            ),
          );
        }).pipe(
          Effect.catchTag("StorageError", (e) =>
            Effect.fail(
              new ExecutionError({
                jobType: "task",
                jobName: "unknown",
                instanceId: runtime.instanceId,
                cause: e,
              }),
            ),
          ),
          Effect.catchTag("SchedulerError", (e) =>
            Effect.fail(
              new ExecutionError({
                jobType: "task",
                jobName: "unknown",
                instanceId: runtime.instanceId,
                cause: e,
              }),
            ),
          ),
        ),
    };
  }),
);
