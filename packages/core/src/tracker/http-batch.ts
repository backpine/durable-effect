// packages/core/src/tracker/http-batch.ts

import { Effect, Layer, Ref, Schedule, Duration } from "effect";
import { EventTracker, type EventTrackerService, type BaseTrackingEvent } from "./tracker";

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
  /** User-defined service key for identifying the service */
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
    readonly statusCode?: number,
  ) {
    super(
      `HttpTracker ${operation} failed${statusCode ? ` (${statusCode})` : ""}: ${String(cause)}`,
    );
    this.name = "HttpTrackerError";
  }
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create a generic HTTP batch tracker.
 *
 * This is a generic implementation that works with any event type.
 * Events are batched and sent to the configured endpoint.
 *
 * @typeParam E - The event type to track
 * @param config - Tracker configuration
 * @param enrichFn - Optional function to enrich events before sending
 */
export function createHttpBatchTracker<E extends BaseTrackingEvent>(
  config: HttpBatchTrackerConfig,
  enrichFn?: (event: E) => E,
): Effect.Effect<EventTrackerService<E>> {
  const cfg = {
    ...DEFAULT_CONFIG,
    ...config,
    headers: { ...DEFAULT_CONFIG.headers, ...config.headers },
    retry: { ...DEFAULT_CONFIG.retry, ...config.retry },
  };

  // Default enrichment adds env and serviceKey to events
  const defaultEnrich = (event: E): E & { env: string; serviceKey: string } => ({
    ...event,
    env: config.env,
    serviceKey: config.serviceKey,
  });

  // Compose enrichment: apply default first, then custom if provided
  const enrich = enrichFn
    ? (event: E) => enrichFn(defaultEnrich(event) as E)
    : defaultEnrich;

  return Effect.gen(function* () {
    const buffer = yield* Ref.make<E[]>([]);

    // Send batch to endpoint
    const sendBatch = (events: E[]): Effect.Effect<void> => {
      if (events.length === 0) {
        return Effect.void;
      }

      // Apply enrichment (adds env and serviceKey)
      const wireEvents = events.map(enrich);

      return Effect.tryPromise({
        try: async () => {
          const body = JSON.stringify({ events: wireEvents });

          const response = await fetch(cfg.endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...cfg.headers,
            },
            body,
          });

          if (!response.ok) {
            const errorText = await response.text().catch(() => "unable to read response");
            throw new HttpTrackerError(
              "send",
              `HTTP ${response.status}: ${errorText}`,
              response.status,
            );
          }
        },
        catch: (error) => {
          return error instanceof HttpTrackerError
            ? error
            : new HttpTrackerError("send", error);
        },
      }).pipe(
        Effect.retry(
          Schedule.exponential(Duration.millis(cfg.retry.initialDelayMs)).pipe(
            Schedule.compose(Schedule.recurs(cfg.retry.maxAttempts)),
          ),
        ),
        // Don't fail on tracking error - silently continue
        Effect.catchAll(() => Effect.void),
      );
    };

    // Flush current buffer
    const flush = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        const events = yield* Ref.getAndSet(buffer, []);
        yield* sendBatch(events);
      });

    const service: EventTrackerService<E> = {
      emit: (event) =>
        Effect.gen(function* () {
          yield* Ref.update(buffer, (events) => [...events, event]);
          const current = yield* Ref.get(buffer);

          // Check if we should flush
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
 * });
 * ```
 */
export const HttpBatchTrackerLayer = (config: HttpBatchTrackerConfig) =>
  Layer.effect(EventTracker, createHttpBatchTracker(config));
