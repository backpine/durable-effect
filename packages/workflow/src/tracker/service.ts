/**
 * Event tracker service implementation.
 *
 * Uses an Effect Queue for batching events and sends them
 * via HTTP POST to an external tracking service.
 *
 * The tracker enriches internal events with env and serviceKey
 * before sending them over the wire.
 */

import {
  Context,
  Effect,
  Layer,
  Queue,
  Fiber,
  Duration,
  Schedule,
  Chunk,
  Scope,
  Option,
} from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform";
import type {
  InternalWorkflowEvent,
  WorkflowEvent,
} from "@durable-effect/core";
import { enrichEvent } from "@durable-effect/core";
import type { EventTrackerConfig } from "./types";

// =============================================================================
// Service Interface
// =============================================================================

/**
 * Event tracker service interface.
 *
 * Accepts internal events (without env/serviceKey) and enriches them
 * with the configured env and serviceKey before sending.
 */
export interface EventTrackerService {
  /**
   * Emit a single event.
   * Non-blocking - event is queued for batching.
   * The tracker automatically adds env and serviceKey.
   */
  readonly emit: (event: InternalWorkflowEvent) => Effect.Effect<void>;

  /**
   * Flush all pending events immediately.
   * Useful during shutdown to ensure events are sent.
   */
  readonly flush: Effect.Effect<void>;

  /**
   * Get count of events currently in buffer.
   */
  readonly pendingCount: Effect.Effect<number>;
}

/**
 * Effect Context Tag for the event tracker service.
 */
export class EventTracker extends Context.Tag("@durable-effect/EventTracker")<
  EventTracker,
  EventTrackerService
>() {}

// =============================================================================
// No-Op Tracker (for when tracking is disabled)
// =============================================================================

/**
 * No-op tracker implementation.
 * Used when tracking is disabled - all operations are silent no-ops.
 */
export const noopTracker: EventTrackerService = {
  emit: () => Effect.void,
  flush: Effect.void,
  pendingCount: Effect.succeed(0),
};

/**
 * Layer that provides the no-op tracker.
 * Use this when event tracking is disabled.
 */
export const NoopTrackerLayer: Layer.Layer<EventTracker> = Layer.succeed(
  EventTracker,
  noopTracker,
);

// =============================================================================
// Safe Helpers (use with serviceOption)
// =============================================================================

/**
 * Safely emit an event.
 * If tracker is not configured, this is a no-op.
 */
export const emitEvent = (event: InternalWorkflowEvent): Effect.Effect<void> =>
  Effect.gen(function* () {
    const maybeTracker = yield* Effect.serviceOption(EventTracker);

    if (Option.isSome(maybeTracker)) {
      yield* maybeTracker.value.emit(event);
    }
  });

/**
 * Safely flush pending events.
 * If tracker is not configured, this is a no-op.
 */
export const flushEvents: Effect.Effect<void> = Effect.gen(function* () {
  const maybeTracker = yield* Effect.serviceOption(EventTracker);

  if (Option.isSome(maybeTracker)) {
    yield* maybeTracker.value.flush;
  }
});

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create an EventTrackerService with queue-based HTTP batch delivery.
 *
 * Events are collected into batches and sent when:
 * 1. `maxSize` events are collected, OR
 * 2. `maxWaitMs` elapses since the first event in the batch
 *
 * The tracker automatically enriches events with env and serviceKey
 * from the config before sending them.
 *
 * @example
 * ```typescript
 * const program = Effect.scoped(
 *   Effect.gen(function* () {
 *     const tracker = yield* createHttpBatchTracker({
 *       url: "https://tracker.example.com/api/events",
 *       accessToken: "your-token",
 *       env: "production",
 *       serviceKey: "order-service",
 *       batch: { maxSize: 50, maxWaitMs: 1000 },
 *     });
 *
 *     // Events are enriched with env/serviceKey automatically
 *     yield* tracker.emit(internalEvent);
 *     yield* tracker.flush;
 *   })
 * ).pipe(Effect.provide(FetchHttpClient.layer));
 * ```
 */
export const createHttpBatchTracker = (
  config: EventTrackerConfig,
): Effect.Effect<
  EventTrackerService,
  never,
  Scope.Scope | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    // Capture env and serviceKey for event enrichment
    const { env, serviceKey } = config;

    // Apply defaults
    const maxSize = config.batch?.maxSize ?? 50;
    const maxWaitMs = config.batch?.maxWaitMs ?? 1000;
    const maxRetries = config.retry?.maxAttempts ?? 3;
    const initialDelay = config.retry?.initialDelayMs ?? 100;
    const maxDelay = config.retry?.maxDelayMs ?? 5000;
    const timeoutMs = config.timeoutMs ?? 10000;

    // Get HTTP client from context
    const httpClient = yield* HttpClient.HttpClient;

    // Sliding queue - drops oldest events when full (back-pressure protection)
    // Stores internal events (without env/serviceKey)
    const eventQueue = yield* Queue.sliding<InternalWorkflowEvent>(1000);

    // Signal for manual flush
    const flushSignal = yield* Queue.unbounded<void>();

    /**
     * Send a batch of events via HTTP POST.
     * Enriches internal events with env and serviceKey before sending.
     */
    const sendBatch = (
      events: ReadonlyArray<InternalWorkflowEvent>,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (events.length === 0) return;

        // Enrich all events with env and serviceKey
        const enrichedEvents: WorkflowEvent[] = events.map((event) =>
          enrichEvent(event, env, serviceKey),
        );

        yield* HttpClientRequest.post(config.url).pipe(
          HttpClientRequest.bodyJson({ events: enrichedEvents }),
          Effect.flatMap((request) =>
            request.pipe(
              HttpClientRequest.bearerToken(config.accessToken),
              httpClient.execute,
              Effect.flatMap(HttpClientResponse.filterStatusOk),
              Effect.scoped,
              Effect.timeout(Duration.millis(timeoutMs)),
            ),
          ),
          // Retry with exponential backoff
          Effect.retry(
            Schedule.exponential(Duration.millis(initialDelay), 2).pipe(
              Schedule.intersect(Schedule.recurs(maxRetries)),
              Schedule.upTo(Duration.millis(maxDelay)),
            ),
          ),
          // CRITICAL: Catch all errors - tracker failures must never propagate
          Effect.catchAll((error) =>
            Effect.logWarning(
              `Event tracker failed to send batch of ${enrichedEvents.length} events: ${error}`,
            ),
          ),
          Effect.asVoid,
        );
      });

    /**
     * Background consumer that collects events into batches.
     * Sends batch when:
     * 1. maxSize events collected, OR
     * 2. maxWaitMs elapsed since first event in batch
     */
    const consumer: Effect.Effect<void> = Effect.gen(function* () {
      while (true) {
        // Wait for first event (blocks until available)
        const firstEvent = yield* Queue.take(eventQueue);
        const batch: InternalWorkflowEvent[] = [firstEvent];
        const batchStartTime = Date.now();

        // Collect more events until maxSize or maxWaitMs
        while (batch.length < maxSize) {
          const elapsed = Date.now() - batchStartTime;
          const remaining = Math.max(0, maxWaitMs - elapsed);

          if (remaining === 0) break;

          // Race: get next event OR flush signal OR timeout
          const result = yield* Effect.raceAll([
            Queue.take(eventQueue).pipe(
              Effect.map((e) => ({ _tag: "event" as const, event: e })),
            ),
            Queue.take(flushSignal).pipe(
              Effect.map(() => ({ _tag: "flush" as const })),
            ),
            Effect.sleep(Duration.millis(remaining)).pipe(
              Effect.map(() => ({ _tag: "timeout" as const })),
            ),
          ]);

          if (result._tag === "event") {
            batch.push(result.event);
          } else {
            // Flush signal or timeout - send what we have
            break;
          }
        }

        // Send the collected batch (enrichment happens inside sendBatch)
        yield* sendBatch(batch);
      }
    });

    // Start background consumer
    const consumerFiber = yield* Effect.fork(consumer);

    // Cleanup on scope close
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        // Signal flush for any remaining events
        yield* Queue.offer(flushSignal, undefined);

        // Take any remaining events and send them
        const remaining = yield* Queue.takeAll(eventQueue);
        if (Chunk.size(remaining) > 0) {
          yield* sendBatch(Chunk.toReadonlyArray(remaining));
        }

        // Shutdown queues
        yield* Queue.shutdown(eventQueue);
        yield* Queue.shutdown(flushSignal);
        yield* Fiber.interrupt(consumerFiber);

        yield* Effect.logDebug("Event tracker shutdown complete");
      }),
    );

    // Return service implementation
    return {
      emit: (event: InternalWorkflowEvent): Effect.Effect<void> =>
        Queue.offer(eventQueue, event).pipe(Effect.asVoid),

      flush: Queue.offer(flushSignal, undefined).pipe(Effect.asVoid),

      pendingCount: Queue.size(eventQueue),
    };
  });
