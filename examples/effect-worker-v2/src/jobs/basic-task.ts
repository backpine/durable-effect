import { Task } from "@durable-effect/jobs";
import { Effect, Schema } from "effect";

export const TaskState = Schema.Struct({
  targetRuns: Schema.Number,
  currentRun: Schema.Number,
});

export type TaskState = typeof TaskState.Type;

export const TaskEvent = Schema.Struct({
  targetRuns: Schema.Number,
});

export type TaskEvent = typeof TaskEvent.Type;

export const basicTask = Task.make({
  eventSchema: TaskEvent,
  stateSchema: TaskState,

  onEvent: (event, ctx) =>
    Effect.gen(function* () {
      yield* Effect.log("Handling event");
      if (ctx.isFirstEvent) {
        yield* ctx.setState({
          targetRuns: event.targetRuns,
          currentRun: 0,
        });

        yield* ctx.schedule(Date.now() + 5000);
      }
    }),

  execute: (ctx) =>
    Effect.gen(function* () {
      // In execute, state IS an Effect - yield required
      const state = yield* ctx.state;
      yield* Effect.log("Executing task");
      if (!state) {
        yield* ctx.terminate();
        return;
      }
      const executeCount = yield* ctx.executeCount;
      if (executeCount >= state.targetRuns) {
        yield* Effect.log("Task completed");
        yield* ctx.terminate();
        return;
      }
      const currentRun = state.currentRun + 1;
      yield* ctx.updateState((data) => ({
        ...data,
        currentRun,
      }));
      yield* ctx.schedule(Date.now() + 5000);
      yield* Effect.log(`Executing run ${currentRun}`);
      return Effect.fail(new Error("Task failed"));
    }),
});
