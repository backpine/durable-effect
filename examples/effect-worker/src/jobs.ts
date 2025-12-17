import { Effect, Schema, Duration } from "effect";
import { Continuous, Debounce, Task, createDurableJobs } from "@durable-effect/jobs";

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

// Task example: countdown timer with event-driven control
const countdownTimer = Task.make({
  stateSchema: Schema.Struct({
    name: Schema.String,
    targetTime: Schema.Number,
    status: Schema.Literal("running", "paused", "completed", "cancelled"),
    createdAt: Schema.Number,
    message: Schema.optionalWith(Schema.String, { default: () => "" }),
  }),

  eventSchema: Schema.Union(
    Schema.Struct({
      _tag: Schema.Literal("Start"),
      name: Schema.String,
      durationSeconds: Schema.Number,
      message: Schema.optionalWith(Schema.String, { default: () => "" }),
    }),
    Schema.Struct({
      _tag: Schema.Literal("Pause"),
    }),
    Schema.Struct({
      _tag: Schema.Literal("Resume"),
    }),
    Schema.Struct({
      _tag: Schema.Literal("Cancel"),
    }),
    Schema.Struct({
      _tag: Schema.Literal("AddTime"),
      seconds: Schema.Number,
    }),
  ),

  onEvent: (ctx) =>
    Effect.gen(function* () {
      const event = ctx.event;
      const now = Date.now();

      switch (event._tag) {
        case "Start": {
          yield* Effect.log(`Starting countdown: ${event.name}`);
          const targetTime = now + event.durationSeconds * 1000;
          yield* ctx.setState({
            name: event.name,
            targetTime,
            status: "running",
            createdAt: now,
            message: event.message,
          });
          // Schedule execution when countdown completes
          yield* ctx.schedule(targetTime);
          break;
        }

        case "Pause": {
          if (ctx.state === null || ctx.state.status !== "running") {
            yield* Effect.log("Cannot pause - timer not running");
            return;
          }
          yield* Effect.log("Pausing countdown");
          yield* ctx.updateState((s) => ({ ...s, status: "paused" as const }));
          yield* ctx.cancelSchedule();
          break;
        }

        case "Resume": {
          if (ctx.state === null || ctx.state.status !== "paused") {
            yield* Effect.log("Cannot resume - timer not paused");
            return;
          }
          yield* Effect.log("Resuming countdown");
          yield* ctx.updateState((s) => ({ ...s, status: "running" as const }));
          // Resume with remaining time
          yield* ctx.schedule(ctx.state.targetTime);
          break;
        }

        case "Cancel": {
          yield* Effect.log("Cancelling countdown");
          yield* ctx.updateState((s) => ({
            ...s,
            status: "cancelled" as const,
          }));
          yield* ctx.cancelSchedule();
          // Clear after a short delay for status retrieval
          yield* ctx.schedule(Duration.seconds(10));
          break;
        }

        case "AddTime": {
          if (ctx.state === null) return;
          yield* Effect.log(`Adding ${event.seconds} seconds`);
          const newTarget = ctx.state.targetTime + event.seconds * 1000;
          yield* ctx.updateState((s) => ({ ...s, targetTime: newTarget }));
          if (ctx.state.status === "running") {
            yield* ctx.schedule(newTarget);
          }
          break;
        }
      }
    }),

  execute: (ctx) =>
    Effect.gen(function* () {
      const state = yield* ctx.state;
      if (state === null) return;

      if (state.status === "cancelled") {
        yield* Effect.log("Timer was cancelled, cleaning up");
        yield* ctx.clear();
        return;
      }

      if (state.status === "paused") {
        yield* Effect.log("Timer is paused, skipping execution");
        return;
      }

      const now = Date.now();
      if (now >= state.targetTime) {
        yield* Effect.log(`🎉 COUNTDOWN COMPLETE: ${state.name}!`);
        if (state.message) {
          yield* Effect.log(`Message: ${state.message}`);
        }
        yield* ctx.setState({ ...state, status: "completed" });
        // Keep for status check, then clean up
        yield* ctx.schedule(Duration.seconds(30));
      } else {
        // Not yet time, reschedule
        yield* ctx.schedule(state.targetTime);
      }
    }),

  onIdle: (ctx) =>
    Effect.gen(function* () {
      yield* Effect.log(`Timer idle (reason: ${ctx.idleReason})`);
    }),

  onError: (error, ctx) =>
    Effect.gen(function* () {
      yield* Effect.logError("Timer error", error);
      // Schedule retry in 5 seconds
      yield* ctx.schedule(Duration.seconds(5));
    }),
});

// 2. Create the Durable Object and Client - key becomes the job name
const { Jobs, JobsClient } = createDurableJobs({
  tokenRefresher: tokenRefresher,
  webhookDebounce,
  countdownTimer,
});

// 3. Export the Durable Object class
export { Jobs, JobsClient };
