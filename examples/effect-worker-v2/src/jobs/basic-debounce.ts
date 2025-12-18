import { Debounce } from "@durable-effect/jobs";
import { Effect, Schema } from "effect";

// =============================================================================
// Debounce Job - Batches events and flushes after delay
// =============================================================================

/**
 * Event schema for the debounce job.
 * Each event represents a click or action to be batched.
 */
export const DebounceEvent = Schema.Struct({
  /** Unique click/action ID */
  actionId: Schema.String,
  /** Timestamp of the action */
  timestamp: Schema.Number,
  /** Optional metadata */
  metadata: Schema.optional(Schema.String),
});

export type DebounceEvent = typeof DebounceEvent.Type;

/**
 * A debounce job that batches click events.
 *
 * Use cases:
 * - Analytics event batching
 * - Search-as-you-type debouncing
 * - Bulk write operations
 *
 * Key points about Debounce jobs:
 * - Events are accumulated until flushAfter delay or maxEvents
 * - State is the last accumulated event (or custom via onEvent)
 * - execute() is called when flush happens
 */
export const debounceExample = Debounce.make({
  eventSchema: DebounceEvent,

  // Flush after 5 seconds of inactivity
  flushAfter: "5 seconds",

  // Or flush immediately when 10 events accumulated
  maxEvents: 10,

  retry: {
    delay: "1 second",
    maxAttempts: 3,
  },

  // Execute is called on flush
  execute: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.state;
      const eventCount = yield* ctx.eventCount;

      yield* Effect.log(
        `Debounce flushed! Events: ${eventCount}, Last action: ${state?.actionId}, Reason: ${ctx.flushReason}`,
      );
    }),
});
