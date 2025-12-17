// packages/jobs/src/runtime/dispatcher.ts

import { Context, Effect, Layer } from "effect";
import { MetadataService } from "../services/metadata";
import { ContinuousHandler } from "../handlers/continuous";
import { DebounceHandler } from "../handlers/debounce";
import { TaskHandler } from "../handlers/task";
import { UnknownJobTypeError, type JobError } from "../errors";
import type { JobRequest, JobResponse } from "./types";

// =============================================================================
// Service Interface
// =============================================================================

/**
 * Dispatcher routes requests to job handlers.
 *
 * This is the central routing hub for all job operations:
 * - handle(request): Routes to the appropriate handler based on request.type
 * - handleAlarm(): Reads metadata to determine type, then routes to handler
 */
export interface DispatcherServiceI {
  /**
   * Handle a job request.
   * Routes to the appropriate handler based on request.type.
   */
  readonly handle: (
    request: JobRequest
  ) => Effect.Effect<JobResponse, JobError, any>;

  /**
   * Handle an alarm.
   * Reads metadata to determine which job type to route to.
   */
  readonly handleAlarm: () => Effect.Effect<void, JobError, any>;
}

// =============================================================================
// Service Tag
// =============================================================================

export class Dispatcher extends Context.Tag(
  "@durable-effect/jobs/Dispatcher"
)<Dispatcher, DispatcherServiceI>() {}

// =============================================================================
// Layer Implementation
// =============================================================================

/**
 * Creates the dispatcher that routes to job handlers.
 *
 * Phase 3: Routes to ContinuousHandler
 * Phase 4: Add routing to DebounceHandler
 * Phase 5: Add routing to WorkerPoolHandler
 */
export const DispatcherLayer = Layer.effect(
  Dispatcher,
  Effect.gen(function* () {
    const metadata = yield* MetadataService;
    const continuous = yield* ContinuousHandler;
    const debounce = yield* DebounceHandler;
    const task = yield* TaskHandler;

    return {
      handle: (request: JobRequest) =>
        Effect.gen(function* () {
          switch (request.type) {
            case "continuous":
              return yield* continuous.handle(request);

            case "debounce":
              return yield* debounce.handle(request);

            case "task":
              return yield* task.handle(request);

            case "workerPool":
              // TODO: Route to WorkerPoolHandler in Phase 5
              return yield* Effect.fail(
                new UnknownJobTypeError({
                  type: `workerPool (handler not implemented)`,
                })
              );

            default:
              // TypeScript exhaustiveness check
              const _exhaustive: never = request;
              return yield* Effect.fail(
                new UnknownJobTypeError({
                  type: (request as JobRequest).type,
                })
              );
          }
        }),

      handleAlarm: () =>
        Effect.gen(function* () {
          const meta = yield* metadata.get();

          // No metadata = instance was never initialized, nothing to do
          if (!meta) {
            return;
          }

          switch (meta.type) {
            case "continuous":
              yield* continuous.handleAlarm();
              break;

            case "debounce":
              yield* debounce.handleAlarm();
              break;

            case "task":
              yield* task.handleAlarm();
              break;

            case "workerPool":
              // TODO: Route to WorkerPoolHandler.handleAlarm in Phase 5
              yield* Effect.logInfo(
                `Alarm for workerPool/${meta.name} (handler not implemented)`
              );
              break;

            default:
              yield* Effect.logWarning(
                `Unknown job type in alarm: ${meta.type}`
              );
          }
        }),
    };
  })
);
