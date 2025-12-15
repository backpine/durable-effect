import { Effect, Schema } from "effect";
import { Continuous, Debounce, createDurableJobs } from "@durable-effect/jobs";

// 1. Define your job (name comes from the key in createDurableJobs)
const tokenRefresher = Continuous.make({
  // Schema for persistent state
  stateSchema: Schema.Struct({
    accessToken: Schema.String,
    refreshToken: Schema.String,
    expiresAt: Schema.Number,
    count: Schema.optionalWith(Schema.Number, { default: () => 0 }),
  }),
  retry: {
    maxAttempts: 3,
  },
  // Execute every 30 minutes
  schedule: Continuous.every("5 seconds"),

  startImmediately: true,
  onError: (error) => Effect.logError(error),

  // The function to run
  execute: (ctx) =>
    Effect.gen(function* () {
      console.log(`Refreshing token (run #${ctx.runCount})`);

      // Call your refresh API

      if (ctx.runCount > 5) {
        yield* ctx.terminate({
          reason: "done",
          purgeState: true,
        });
      }
      yield* Effect.log(`setting the state`);

      // Update state (persisted automatically)
      ctx.setState({
        accessToken: ctx.state.accessToken,
        refreshToken: ctx.state.refreshToken,
        expiresAt: Date.now() + ctx.state.expiresAt * 1000,
        count: ctx.state.count + 1,
      });
    }),
});

// Debounce example: coalesce webhook updates per contact
const webhookDebounce = Debounce.make({
  eventSchema: Schema.Struct({
    contactId: Schema.String,
    type: Schema.String,
    payload: Schema.Unknown,
    occurredAt: Schema.Number,
  }),
  flushAfter: "10 seconds",
  retry: {
    maxAttempts: 30,
    delay: "1 second",
  },

  maxEvents: 5,

  execute: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.state;
      const count = yield* ctx.eventCount;

      // 70% chance of failure
      const shouldFail = Math.random() < 0.7;

      yield* Effect.log(
        `Flushing webhook debounce for ${state.contactId} with ${count} events`,
      );

      if (shouldFail) {
        yield* Effect.log(`Simulated failure (70% chance)`);
        return yield* Effect.fail(
          new Error("Simulated webhook processing failure"),
        );
      }
    }),
  onEvent: (ctx) =>
    Effect.gen(function* () {
      const event = ctx.event;
      const state = ctx.state; // Never null - auto-initialized from first event
      if (event.occurredAt > state.occurredAt) {
        yield* Effect.log(`Updating state for ${event.contactId}`);
        return event;
      }
      yield* Effect.log(`Skipping event for ${event.contactId}`);
      return state;
    }),
});

// 2. Create the Durable Object and Client - key becomes the job name
const { Jobs, JobsClient } = createDurableJobs({
  tokenRefresher: tokenRefresher,
  webhookDebounce,
});

// 3. Export the Durable Object class
export { Jobs, JobsClient };
