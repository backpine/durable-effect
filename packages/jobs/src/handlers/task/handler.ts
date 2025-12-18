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
import { createEntityStateService } from "../../services/entity-state";
import { RegistryService } from "../../services/registry";
import { JobExecutionService } from "../../services/execution";
import { KEYS } from "../../storage-keys";
import {
  JobNotFoundError,
  ExecutionError,
  TerminateSignal,
  type JobError,
} from "../../errors";
import { RetryExecutor } from "../../retry";
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

export class TaskHandler extends Context.Tag(
  "@durable-effect/jobs/TaskHandler",
)<TaskHandler, TaskHandlerI>() {}

type HandlerError = JobError | StorageError | SchedulerError;

export const TaskHandlerLayer = Layer.effect(
  TaskHandler,
  Effect.gen(function* () {
    const registryService = yield* RegistryService;
    const metadata = yield* MetadataService;
    const alarm = yield* AlarmService;
    const runtime = yield* RuntimeAdapter;
    const storage = yield* StorageAdapter;
    const execution = yield* JobExecutionService;

    const withStorage = <A, E>(
      effect: Effect.Effect<A, E, StorageAdapter>,
    ): Effect.Effect<A, E> =>
      Effect.provideService(effect, StorageAdapter, storage);

    const getDefinition = (
      name: string,
    ): Effect.Effect<StoredTaskDefinition<any, any, any>, JobNotFoundError> => {
      const def = registryService.registry.task[name];
      if (!def) {
        return Effect.fail(new JobNotFoundError({ type: "task", name }));
      }
      return Effect.succeed(def);
    };

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

    const purge = (): Effect.Effect<void, StorageError | SchedulerError> =>
      Effect.gen(function* () {
        yield* alarm.cancel();
        yield* storage.deleteAll();
      });

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

    const runExecution = (
      def: StoredTaskDefinition<any, any, any>,
      runCount: number,
      triggerType: "execute" | "onEvent",
      event?: any
    ) => 
      execution.execute({
        jobType: "task",
        jobName: def.name,
        schema: def.stateSchema,
        retryConfig: undefined,
        runCount,
        allowNullState: true,
        createContext: (base) => {
            const scheduleHolder: TaskScheduleHolder = {
                scheduledAt: null,
                cancelled: false,
                dirty: false
            };
            
            // Proxy state holder for the legacy context factories
            const proxyStateHolder: TaskStateHolder<any> = {
                get current() { return base.getState(); },
                set current(val) { base.setState(val); },
            get dirty() { return true; }, // Handled by service
            set dirty(_) { /* no-op */ }

            };
            
            return { base, scheduleHolder, proxyStateHolder };
        },
        run: (metaCtx) => Effect.gen(function* () {
            const { base, scheduleHolder, proxyStateHolder } = metaCtx;
            
            // Define error handler for this scope
            const runWithErrorHandling = (effect: Effect.Effect<void, any, any>, errorSource: "onEvent" | "execute") =>
                effect.pipe(
                    Effect.catchAll(error => {
                        // Let TerminateSignal propagate to JobExecutionService
                        if (error instanceof TerminateSignal) return Effect.fail(error);

                        if (def.onError) {
                            const errorCtx = createTaskErrorContext(
                                proxyStateHolder,
                                scheduleHolder,
                                base.instanceId,
                                def.name,
                                errorSource,
                                () => Effect.succeed(base.getState()),
                                () => getScheduledAt().pipe(Effect.catchAll(() => Effect.succeed(null)))
                            );
                            return def.onError(error, errorCtx);
                        }
                        return Effect.fail(error);
                    })
                );

            if (triggerType === "onEvent") {
                const ctx = createTaskEventContext(
                    proxyStateHolder,
                    scheduleHolder,
                    base.instanceId,
                    def.name,
                    Date.now(),
                    () => getEventCount().pipe(Effect.catchAll(() => Effect.succeed(0))),
                    () => getCreatedAt().pipe(Effect.map(t => t ?? Date.now()), Effect.catchAll(() => Effect.succeed(Date.now()))),
                    () => getScheduledAt().pipe(Effect.catchAll(() => Effect.succeed(null)))
                );
                // Pass event as first argument to make it clear it's a direct value
                yield* runWithErrorHandling(def.onEvent(event, ctx), "onEvent");
            } else {
                const ctx = createTaskExecuteContext(
                    proxyStateHolder,
                    scheduleHolder,
                    base.instanceId,
                    def.name,
                    Date.now(),
                    () => Effect.succeed(base.getState()),
                    () => getEventCount().pipe(Effect.catchAll(() => Effect.succeed(0))),
                    () => getCreatedAt().pipe(Effect.map(t => t ?? Date.now()), Effect.catchAll(() => Effect.succeed(Date.now()))),
                    () => getExecuteCount().pipe(Effect.catchAll(() => Effect.succeed(0))),
                    () => getScheduledAt().pipe(Effect.catchAll(() => Effect.succeed(null)))
                );
                yield* runWithErrorHandling(def.execute(ctx), "execute");
            }
            
            // Apply schedule changes
            yield* applyScheduleChanges(scheduleHolder);
            
            // Maybe run onIdle
            if (def.onIdle) {
               // Check if scheduled
               const scheduled = scheduleHolder.dirty 
                  ? scheduleHolder.scheduledAt 
                  : (yield* getScheduledAt());
               
               if (scheduled === null) {
                   const idleCtx = createTaskIdleContext(
                       proxyStateHolder,
                       scheduleHolder,
                       base.instanceId,
                       def.name,
                       triggerType,
                       () => Effect.succeed(base.getState()),
                       () => getScheduledAt().pipe(Effect.catchAll(() => Effect.succeed(null)))
                   );
                   
                   // onIdle doesn't have standard error handling in definition, it returns Effect<void, never, R>
                   // But let's wrap it just in case
                   yield* def.onIdle(idleCtx);
                   
                   // Re-apply schedule changes
                   yield* applyScheduleChanges(scheduleHolder);
               }
            }
        })
      });

    const handleSend = (
      def: StoredTaskDefinition<any, any, any>,
      request: TaskRequest,
    ): Effect.Effect<TaskResponse, HandlerError, any> =>
      Effect.gen(function* () {
        const meta = yield* metadata.get();
        const created = !meta;
        const now = yield* runtime.now();

        if (created) {
          yield* metadata.initialize("task", request.name);
          yield* metadata.updateStatus("running");
          yield* setCreatedAt(now);
          yield* storage.put(KEYS.TASK.EVENT_COUNT, 0);
          yield* storage.put(KEYS.TASK.EXECUTE_COUNT, 0);
        }

        yield* incrementEventCount();

        const decodeEvent = Schema.decodeUnknown(def.eventSchema);
        const validatedEvent = yield* decodeEvent(request.event).pipe(
          Effect.mapError(e => new ExecutionError({
             jobType: "task",
             jobName: def.name,
             instanceId: runtime.instanceId,
             cause: e
          }))
        );

        yield* runExecution(def, 0, "onEvent", validatedEvent);

        const scheduledAt = yield* getScheduledAt();

        return {
          _type: "task.send" as const,
          instanceId: runtime.instanceId,
          created,
          scheduledAt,
        };
      });

    const handleTrigger = (
      def: StoredTaskDefinition<any, any, any>,
    ): Effect.Effect<TaskResponse, HandlerError, any> =>
      Effect.gen(function* () {
        const meta = yield* metadata.get();
        if (!meta) {
          return {
            _type: "task.trigger" as const,
            instanceId: runtime.instanceId,
            triggered: false,
          };
        }

        yield* incrementExecuteCount();
        yield* runExecution(def, 0, "execute");

        return {
          _type: "task.trigger" as const,
          instanceId: runtime.instanceId,
          triggered: true,
        };
      });

    const handleTerminate = (): Effect.Effect<TaskResponse, HandlerError> =>
      Effect.gen(function* () {
        const meta = yield* metadata.get();
        if (!meta) {
          return {
            _type: "task.terminate" as const,
            instanceId: runtime.instanceId,
            terminated: false,
          };
        }

        yield* purge();

        return {
          _type: "task.terminate" as const,
          instanceId: runtime.instanceId,
          terminated: true,
        };
      });

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

    return {
      handle: (
        request: TaskRequest,
      ): Effect.Effect<TaskResponse, JobError, any> =>
        Effect.gen(function* () {
          const def = yield* getDefinition(request.name);

          switch (request.action) {
            case "send":
              return yield* handleSend(def, request);
            case "trigger":
              return yield* handleTrigger(def);
            case "terminate":
              return yield* handleTerminate();
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
        ),

      handleAlarm: (): Effect.Effect<void, JobError, any> =>
        Effect.gen(function* () {
          const meta = yield* metadata.get();
          if (!meta || meta.type !== "task") {
            return;
          }

          const def = yield* getDefinition(meta.name);

          yield* incrementExecuteCount();
          yield* runExecution(def, 0, "execute");
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
        ),
    };
  }),
);
