import { Effect, Layer, Schema, ServiceMap } from "effect";
import { Task, withServices } from "@durable-effect/task";
import { createTasks } from "@durable-effect/task/cloudflare";

// ---------------------------------------------------------------------------
// Dummy service
// ---------------------------------------------------------------------------

class Analytics extends ServiceMap.Service<
  Analytics,
  {
    readonly track: (
      event: string,
      data: Record<string, unknown>,
    ) => Effect.Effect<void>;
  }
>()("@app/Analytics") {}

const AnalyticsLive = Layer.succeed(Analytics, {
  track: (event, data) =>
    Effect.log(`[Analytics] ${event} ${JSON.stringify(data)}`),
});

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const CounterState = Schema.Struct({
  count: Schema.Number,
});

const StartEvent = Schema.Struct({
  _tag: Schema.Literal("Start"),
});

// ---------------------------------------------------------------------------
// Task definition
// ---------------------------------------------------------------------------

const counter = Task.define({
  state: CounterState,
  event: StartEvent,
  onEvent: (ctx, _event) =>
    Effect.gen(function* () {
      const analytics = yield* Analytics;
      yield* analytics.track("counter.started", { id: ctx.id });
      yield* Effect.log(`[${ctx.name}:${ctx.id}] Starting counter`);
      yield* ctx.save({ count: 0 });
      yield* ctx.scheduleIn("2 seconds");
      yield* Effect.log(`[${ctx.name}:${ctx.id}] Alarm scheduled in 2s`);
    }),
  onAlarm: (ctx) =>
    Effect.gen(function* () {
      const current = yield* ctx.recall();
      const count = (current?.count ?? 0) + 1;
      yield* ctx.save({ count });
      yield* Effect.log(`[${ctx.name}:${ctx.id}] Alarm fired — count=${count}`);

      if (count >= 10) {
        yield* Effect.log(`[${ctx.name}:${ctx.id}] Reached 10, purging`);
        yield* ctx.purge();
      }

      yield* ctx.scheduleIn("2 seconds");
      yield* Effect.log(`[${ctx.name}:${ctx.id}] Next alarm in 2s`);
    }),
});

export const { TasksDO, tasks } = createTasks({
  counter: counter,
});
