// packages/workflow-v2/src/tracker/http-batch.ts

import { Effect, Layer, Ref, Schedule, Duration } from "effect";
import {
  enrichEvent,
  type InternalWorkflowEvent,
  type WorkflowEvent,
} from "@durable-effect/core";
import { EventTracker, type EventTrackerService } from "./tracker";

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for HTTP batch tracker.
 */
export interface HttpBatchTrackerConfig {
  /** URL to send events to */
  readonly endpoint: string;
  /** Environment identifier (e.g., "production", "staging") */
  readonly env: string;
  /** Service key for identification */
  readonly serviceKey: string;
  /** Maximum events per batch (default: 100) */
  readonly batchSize?: number;
  /** Headers to include in requests */
  readonly headers?: Record<string, string>;
  /** Retry configuration */
  readonly retry?: {
    /** Maximum retry attempts (default: 3) */
    readonly maxAttempts?: number;
    /** Initial delay in ms (default: 1000) */
    readonly initialDelayMs?: number;
  };
}

/**
 * Default configuration.
 */
const DEFAULT_CONFIG = {
  batchSize: 100,
  headers: {} as Record<string, string>,
  retry: {
    maxAttempts: 3,
    initialDelayMs: 1000,
  },
} as const;

// =============================================================================
// Errors
// =============================================================================

/**
 * Error when HTTP tracking fails.
 */
export class HttpTrackerError extends Error {
  readonly _tag = "HttpTrackerError";

  constructor(
    readonly operation: "send",
    readonly cause: unknown,
    readonly statusCode?: number
  ) {
    super(
      `HttpTracker ${operation} failed${statusCode ? ` (${statusCode})` : ""}: ${String(cause)}`
    );
    this.name = "HttpTrackerError";
  }
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create an HTTP batch tracker.
 *
 * Accepts internal events, enriches them with env/serviceKey,
 * and batches them for efficient delivery.
 */
export function createHttpBatchTracker(
  config: HttpBatchTrackerConfig
): Effect.Effect<EventTrackerService> {
  const cfg = {
    ...DEFAULT_CONFIG,
    ...config,
    headers: { ...DEFAULT_CONFIG.headers, ...config.headers },
    retry: { ...DEFAULT_CONFIG.retry, ...config.retry },
  };

  return Effect.gen(function* () {
    // Buffer stores internal events
    const buffer = yield* Ref.make<InternalWorkflowEvent[]>([]);

    // Send batch to endpoint (enriches events before sending)
    const sendBatch = (events: InternalWorkflowEvent[]): Effect.Effect<void> => {
      if (events.length === 0) return Effect.void;

      // Enrich events with env/serviceKey for wire transmission
      const wireEvents: WorkflowEvent[] = events.map((event) =>
        enrichEvent(event, cfg.env, cfg.serviceKey)
      );

      return Effect.tryPromise({
        try: async () => {
          const response = await fetch(cfg.endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...cfg.headers,
            },
            body: JSON.stringify({ events: wireEvents }),
          });

          if (!response.ok) {
            throw new HttpTrackerError(
              "send",
              `HTTP ${response.status}`,
              response.status
            );
          }
        },
        catch: (error) =>
          error instanceof HttpTrackerError
            ? error
            : new HttpTrackerError("send", error),
      }).pipe(
        Effect.retry(
          Schedule.exponential(Duration.millis(cfg.retry.initialDelayMs)).pipe(
            Schedule.compose(Schedule.recurs(cfg.retry.maxAttempts))
          )
        ),
        // Don't fail workflow on tracking error - just log and continue
        Effect.catchAll(() => Effect.void)
      );
    };

    // Flush current buffer
    const flush = (): Effect.Effect<void> =>
      Ref.getAndSet(buffer, []).pipe(Effect.flatMap(sendBatch));

    const service: EventTrackerService = {
      emit: (event) =>
        Effect.gen(function* () {
          yield* Ref.update(buffer, (events) => [...events, event]);

          // Check if we should flush
          const current = yield* Ref.get(buffer);
          if (current.length >= cfg.batchSize) {
            yield* flush();
          }
        }),

      flush,

      pending: () => Ref.get(buffer).pipe(Effect.map((b) => b.length)),
    };

    return service;
  });
}

/**
 * Create an HTTP batch tracker layer.
 *
 * @example
 * ```typescript
 * const trackerLayer = HttpBatchTrackerLayer({
 *   endpoint: "https://events.example.com/ingest",
 *   env: "production",
 *   serviceKey: "my-service",
 * });
 * ```
 */
export const HttpBatchTrackerLayer = (config: HttpBatchTrackerConfig) =>
  Layer.effect(EventTracker, createHttpBatchTracker(config));
