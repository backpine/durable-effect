// packages/jobs/src/handlers/continuous/handler.ts

import { Context, Effect, Layer } from "effect";
import {
  RuntimeAdapter,
  StorageAdapter,
  createJobBaseEvent,
  emitEvent,
  type StorageError,
  type SchedulerError,
  type InternalJobStartedEvent,
  type InternalJobTerminatedEvent,
} from "@durable-effect/core";
import { MetadataService, type JobStatus } from "../../services/metadata";
import { AlarmService } from "../../services/alarm";
import { createEntityStateService } from "../../services/entity-state";
import { RegistryService } from "../../services/registry";
import { JobExecutionService, type ExecutionResult } from "../../services/execution";
import { KEYS } from "../../storage-keys";
import {
  JobNotFoundError,
  ExecutionError,
  type JobError,
} from "../../errors";
import { RetryExecutor } from "../../retry";
import type { ContinuousRequest } from "../../runtime/types";
import type { ContinuousDefinition, ContinuousContext } from "../../registry/types";
import type { ContinuousHandlerI, ContinuousResponse } from "./types";
import { createContinuousContext, type StateHolder } from "./context";

export class ContinuousHandler extends Context.Tag(
  "@durable-effect/jobs/ContinuousHandler",
)<ContinuousHandler, ContinuousHandlerI>() {}

type HandlerError = JobError | StorageError | SchedulerError;

export const ContinuousHandlerLayer = Layer.effect(
  ContinuousHandler,
  Effect.gen(function* () {
    const registryService = yield* RegistryService;
    const metadata = yield* MetadataService;
    const alarm = yield* AlarmService;
    const runtime = yield* RuntimeAdapter;
    const storage = yield* StorageAdapter;
    const execution = yield* JobExecutionService;
    const retryExecutor = yield* RetryExecutor;

    const getDefinition = (
      name: string,
    ): Effect.Effect<
      ContinuousDefinition<unknown, unknown, never>,
      JobNotFoundError
    > => {
      const def = registryService.registry.continuous[name];
      if (!def) {
        return Effect.fail(new JobNotFoundError({ type: "continuous", name }));
      }
      return Effect.succeed(
        def as ContinuousDefinition<unknown, unknown, never>,
      );
    };

    const getRunCount = (): Effect.Effect<number, StorageError> =>
      storage
        .get<number>(KEYS.CONTINUOUS.RUN_COUNT)
        .pipe(Effect.map((count) => count ?? 0));

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
      def: ContinuousDefinition<unknown, unknown, never>,
    ): Effect.Effect<void, SchedulerError | ExecutionError> => {
      const schedule = def.schedule;
      switch (schedule._tag) {
        case "Every":
          return alarm.schedule(schedule.interval);
        case "Cron":
          return Effect.fail(
            new ExecutionError({
              jobType: "continuous",
              jobName: def.name,
              instanceId: runtime.instanceId,
              cause: new Error("Cron schedules are not supported yet"),
            }),
          );
      }
    };

    const runExecution = (
      def: ContinuousDefinition<unknown, unknown, never>,
      runCount: number,
      id?: string
    ): Effect.Effect<ExecutionResult, ExecutionError> =>
      execution.execute({
        jobType: "continuous",
        jobName: def.name,
        schema: def.stateSchema,
        retryConfig: def.retry,
        runCount,
        id,
        run: (ctx: ContinuousContext<unknown>) => def.execute(ctx),
        createContext: (base) => {
          const proxyHolder: StateHolder<any> = {
            get current() {
              return base.getState();
            },
            set current(val) {
              base.setState(val);
            },
            get dirty() { return true; }, // Dummy, handled by service
            set dirty(_) { /* no-op */ }
          };
          return createContinuousContext(
            proxyHolder,
            base.instanceId,
            base.runCount,
            def.name,
            base.attempt
          );
        }
      });

    const handleStart = (
      def: ContinuousDefinition<unknown, unknown, never>,
      request: ContinuousRequest,
    ): Effect.Effect<
      ContinuousResponse,
      HandlerError
    > =>
      Effect.gen(function* () {
        const existing = yield* metadata.get();
        if (existing) {
          return {
            _type: "continuous.start" as const,
            instanceId: runtime.instanceId,
            created: false,
            status: existing.status,
          };
        }

        yield* metadata.initialize("continuous", request.name, request.id);

        // Emit job.started event
        yield* emitEvent({
          ...createJobBaseEvent(runtime.instanceId, "continuous", request.name, request.id),
          type: "job.started" as const,
          input: request.input,
        } satisfies InternalJobStartedEvent);

        // Initial state set
        // TODO: ExecutionService handles loading, but here we need to set INITIAL state
        // We can use execution service to "seed" state? No, we should just use storage directly for init.
        // Or we use a special "init" execution?
        // Let's use direct storage access for init as before.
        const stateService = yield* createEntityStateService(def.stateSchema).pipe(
            Effect.provideService(StorageAdapter, storage)
        );
        yield* stateService.set(request.input);


        yield* storage.put(KEYS.CONTINUOUS.RUN_COUNT, 0);
        yield* metadata.updateStatus("running");

        let status: JobStatus = "running";

        if (def.startImmediately !== false) {
          const runCount = yield* incrementRunCount();
          const result = yield* runExecution(def, runCount, request.id);
          
          if (result.terminated) {
            // Terminated - CleanupService has already purged everything
            return {
              _type: "continuous.start" as const,
              instanceId: runtime.instanceId,
              created: true,
              status: "terminated" as JobStatus
            };
          }
          
          // Only update last executed if successful (or handled error)
          if (result.success) {
             yield* updateLastExecutedAt();
          }
          
          // If retry scheduled, we don't schedule next run yet (handled by retry alarm)
          if (result.retryScheduled) {
             // Do nothing, alarm is set
          } else if (!result.terminated) {
             // Success, schedule next
             yield* scheduleNext(def);
          }
        } else {
           yield* scheduleNext(def);
        }

        return {
          _type: "continuous.start" as const,
          instanceId: runtime.instanceId,
          created: true,
          status,
        };
      });

    const handleTerminate = (
      request: ContinuousRequest,
    ): Effect.Effect<ContinuousResponse, HandlerError> =>
      Effect.gen(function* () {
        const existing = yield* metadata.get();
        if (!existing) {
          return {
            _type: "continuous.terminate" as const,
            terminated: false,
            reason: "not_found",
          };
        }

        // Get run count before deletion for event
        const runCount = yield* getRunCount();

        // Emit job.terminated event
        yield* emitEvent({
          ...createJobBaseEvent(runtime.instanceId, "continuous", existing.name, existing.id),
          type: "job.terminated" as const,
          reason: request.reason,
          runCount,
        } satisfies InternalJobTerminatedEvent);

        // Cancel alarm
        yield* alarm.cancel();

        // Delete ALL storage (state, metadata, run count, etc.)
        yield* storage.deleteAll();

        return {
          _type: "continuous.terminate" as const,
          terminated: true,
          reason: request.reason,
        };
      });

    const handleTrigger = (
      def: ContinuousDefinition<unknown, unknown, never>,
    ): Effect.Effect<
      ContinuousResponse,
      HandlerError
    > =>
      Effect.gen(function* () {
        const existing = yield* metadata.get();
        if (
          !existing ||
          existing.status === "stopped" ||
          existing.status === "terminated"
        ) {
          return {
            _type: "continuous.trigger" as const,
            triggered: false,
          };
        }

        // Reset retry state
        yield* retryExecutor.reset().pipe(Effect.ignore);

        const runCount = yield* incrementRunCount();
        const result = yield* runExecution(def, runCount, existing.id);

        if (result.terminated) {
          // Terminated - CleanupService has already purged everything
          return {
            _type: "continuous.trigger" as const,
            triggered: true,
            terminated: true
          };
        }

        if (result.retryScheduled) {
             return {
               _type: "continuous.trigger" as const,
               triggered: true,
               retryScheduled: true
             };
        }

        yield* updateLastExecutedAt();
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
      def: ContinuousDefinition<unknown, unknown, never>,
    ): Effect.Effect<ContinuousResponse, HandlerError> =>
      Effect.gen(function* () {
        const stateService = yield* createEntityStateService(def.stateSchema).pipe(
            Effect.provideService(StorageAdapter, storage)
        );
        const state = yield* stateService.get();

        return {
          _type: "continuous.getState" as const,
          state,
        };
      });

    return {
      handle: (
        request: ContinuousRequest,
      ): Effect.Effect<ContinuousResponse, JobError> =>
        Effect.gen(function* () {
          const def = yield* getDefinition(request.name);

          switch (request.action) {
            case "start":
              return yield* handleStart(def, request);
            case "terminate":
              return yield* handleTerminate(request);
            case "trigger":
              return yield* handleTrigger(def);
            case "status":
              return yield* handleStatus();
            case "getState":
              return yield* handleGetState(def);
          }
        }).pipe(
          Effect.catchTag("StorageError", (e) =>
            Effect.fail(
              new ExecutionError({
                jobType: "continuous",
                jobName: request.name,
                instanceId: runtime.instanceId,
                cause: e,
              }),
            ),
          ),
          Effect.catchTag("SchedulerError", (e) =>
            Effect.fail(
              new ExecutionError({
                jobType: "continuous",
                jobName: request.name,
                instanceId: runtime.instanceId,
                cause: e,
              }),
            ),
          ),
        ),

      handleAlarm: (): Effect.Effect<void, JobError> =>
        Effect.gen(function* () {
          const meta = yield* metadata.get();
          if (
            !meta ||
            meta.status === "stopped" ||
            meta.status === "terminated"
          ) {
            return;
          }

          const def = yield* getDefinition(meta.name);

          const isRetrying = yield* retryExecutor.isRetrying().pipe(
            Effect.catchAll(() => Effect.succeed(false)),
          );

          let runCount: number;
          if (isRetrying) {
            runCount = yield* getRunCount();
          } else {
            runCount = yield* incrementRunCount();
          }

          const result = yield* runExecution(def, runCount, meta.id);

          if (result.retryScheduled) {
            return;
          }

          if (result.terminated) {
            // Terminated - CleanupService has already purged everything
            return;
          }

          const currentMeta = yield* metadata.get();
          if (currentMeta && currentMeta.status === "running") {
            yield* updateLastExecutedAt();
            yield* scheduleNext(def);
          }
        }).pipe(
          Effect.catchTag("StorageError", (e) =>
            Effect.fail(
              new ExecutionError({
                jobType: "continuous",
                jobName: "unknown",
                instanceId: runtime.instanceId,
                cause: e,
              }),
            ),
          ),
          Effect.catchTag("SchedulerError", (e) =>
            Effect.fail(
              new ExecutionError({
                jobType: "continuous",
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
