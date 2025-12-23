import { Continuous } from "@durable-effect/jobs";
import { Duration, Effect, Schema } from "effect";

// =============================================================================
// Heartbeat Job - Simple Continuous Job Example
// =============================================================================

/**
 * State schema for the heartbeat job.
 *
 * Tracks how many heartbeats have occurred and when.
 */
export const HeartbeatState = Schema.Struct({
  /** Name/label for this heartbeat instance */
  name: Schema.String,
  /** Total number of heartbeats */
  count: Schema.Number,
  /** Timestamp of last heartbeat */
  lastHeartbeat: Schema.Number,
  /** When this heartbeat was started */
  startedAt: Schema.Number,
});

export type HeartbeatState = typeof HeartbeatState.Type;

/**
 * A simple continuous job that "beats" every 10 seconds.
 *
 * Use cases:
 * - Health monitoring
 * - Periodic sync tasks
 * - Background processing
 *
 * Key points about Continuous jobs:
 * - They run on a schedule (every N seconds, or cron)
 * - State is persisted durably
 * - ctx.state, ctx.setState, ctx.updateState are Effects (use yield*)
 * - Use ctx.terminate() to stop the job
 */
export const heartbeat = Continuous.make({
  stateSchema: HeartbeatState,

  // Run every 10 seconds
  schedule: Continuous.every("4 seconds"),

  // Start immediately when created (default: true)
  startImmediately: true,

  retry: {
    maxAttempts: 3,
    delay: Duration.seconds(1),
  },

  // The execute function runs on each scheduled tick
  execute: (ctx) =>
    Effect.gen(function* () {
      // Get current state (Effect-based)
      const currentState = yield* ctx.state;

      yield* Effect.log(
        `Heartbeat #${ctx.runCount}: ${currentState.name} - count=${currentState.count}`,
      );
      // yield* Effect.fail("Heartbeat job failed");

      // Update state (Effect-based)
      yield* ctx.updateState((s) => ({
        ...s,
        count: s.count + 1,
        lastHeartbeat: Date.now(),
      }));

      // Example: auto-terminate after 10 heartbeats
      if (currentState.count >= 2000) {
        yield* Effect.log(
          `Heartbeat ${currentState.name} reached max count, terminating`,
        );

        return yield* ctx.terminate({ reason: "Max count reached" });
      }
    }),
});
