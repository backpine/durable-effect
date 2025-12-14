import { Effect, Schema } from "effect";
import { Continuous, createDurableJobs } from "@durable-effect/jobs";

// 1. Define your job (name comes from the key in createDurableJobs)
const tokenRefresher = Continuous.make({
  // Schema for persistent state
  stateSchema: Schema.Struct({
    accessToken: Schema.String,
    refreshToken: Schema.String,
    expiresAt: Schema.Number,
    count: Schema.optionalWith(Schema.Number, { default: () => 0 }),
  }),

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

// 2. Create the Durable Object and Client - key becomes the job name
const { Jobs, JobsClient } = createDurableJobs({
  tokenRefresher,
});

// 3. Export the Durable Object class
export { Jobs, JobsClient };
