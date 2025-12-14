// packages/primitives/src/runtime/dispatcher.ts

import { Context, Effect, Layer } from "effect";
import { MetadataService } from "../services/metadata";
import { ContinuousHandler } from "../handlers/continuous";
import { UnknownPrimitiveTypeError, type PrimitiveError } from "../errors";
import type { PrimitiveRequest, PrimitiveResponse } from "./types";

// =============================================================================
// Service Interface
// =============================================================================

/**
 * Dispatcher routes requests to primitive handlers.
 *
 * This is the central routing hub for all primitive operations:
 * - handle(request): Routes to the appropriate handler based on request.type
 * - handleAlarm(): Reads metadata to determine type, then routes to handler
 */
export interface DispatcherServiceI {
  /**
   * Handle a primitive request.
   * Routes to the appropriate handler based on request.type.
   */
  readonly handle: (
    request: PrimitiveRequest
  ) => Effect.Effect<PrimitiveResponse, PrimitiveError>;

  /**
   * Handle an alarm.
   * Reads metadata to determine which primitive type to route to.
   */
  readonly handleAlarm: () => Effect.Effect<void, PrimitiveError>;
}

// =============================================================================
// Service Tag
// =============================================================================

export class Dispatcher extends Context.Tag(
  "@durable-effect/primitives/Dispatcher"
)<Dispatcher, DispatcherServiceI>() {}

// =============================================================================
// Layer Implementation
// =============================================================================

/**
 * Creates the dispatcher that routes to primitive handlers.
 *
 * Phase 3: Routes to ContinuousHandler
 * Phase 4: Add routing to BufferHandler
 * Phase 5: Add routing to QueueHandler
 */
export const DispatcherLayer = Layer.effect(
  Dispatcher,
  Effect.gen(function* () {
    const metadata = yield* MetadataService;
    const continuous = yield* ContinuousHandler;

    return {
      handle: (request: PrimitiveRequest) =>
        Effect.gen(function* () {
          switch (request.type) {
            case "continuous":
              return yield* continuous.handle(request);

            case "buffer":
              // TODO: Route to BufferHandler in Phase 4
              return yield* Effect.fail(
                new UnknownPrimitiveTypeError({
                  type: `buffer (handler not implemented)`,
                })
              );

            case "queue":
              // TODO: Route to QueueHandler in Phase 5
              return yield* Effect.fail(
                new UnknownPrimitiveTypeError({
                  type: `queue (handler not implemented)`,
                })
              );

            default:
              // TypeScript exhaustiveness check
              const _exhaustive: never = request;
              return yield* Effect.fail(
                new UnknownPrimitiveTypeError({
                  type: (request as PrimitiveRequest).type,
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

            case "buffer":
              // TODO: Route to BufferHandler.handleAlarm in Phase 4
              yield* Effect.logInfo(
                `Alarm for buffer/${meta.name} (handler not implemented)`
              );
              break;

            case "queue":
              // TODO: Route to QueueHandler.handleAlarm in Phase 5
              yield* Effect.logInfo(
                `Alarm for queue/${meta.name} (handler not implemented)`
              );
              break;

            default:
              yield* Effect.logWarning(
                `Unknown primitive type in alarm: ${meta.type}`
              );
          }
        }),
    };
  })
);
