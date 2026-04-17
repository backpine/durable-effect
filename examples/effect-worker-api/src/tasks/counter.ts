import { Effect, Layer, Schema, Context } from "effect";
import {
  Task,
  TaskRegistry,
  makeInMemoryRuntime,
  withServices,
} from "@durable-effect/task";

// ── Service ──────────────────────────────────────────────

class Analytics extends Context.Service<
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

// ── Task declaration ─────────────────────────────────────

export const Counter = Task.make("counter", {
  state: Schema.Struct({
    count: Schema.Number,
  }),
  event: Schema.Struct({
    _tag: Schema.Literal("Start"),
  }),
});

const registry = TaskRegistry.make(Counter);

// ── Handler ──────────────────────────────────────────────

const c = registry.for("counter");

const onEvent = c.onEvent((ctx, _event) =>
  Effect.gen(function* () {
    const analytics = yield* Analytics;
    yield* analytics.track("counter.started", { id: ctx.id });
    yield* Effect.log(`[${ctx.name}:${ctx.id}] Starting counter`);
    yield* ctx.save({ count: 0 });
    yield* ctx.scheduleIn("2 seconds");
    yield* Effect.log(`[${ctx.name}:${ctx.id}] Alarm scheduled in 2s`);
  }),
);

const onAlarm = c.onAlarm((ctx) =>
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
);

const counterHandler = registry.handler(
  "counter",
  withServices(
    {
      onEvent: { handler: onEvent, onError: () => Effect.void },
      onAlarm: { handler: onAlarm, onError: () => Effect.void },
    },
    AnalyticsLive,
  ),
);

// ── Runtime ──────────────────────────────────────────────

const registryConfig = registry.build({
  counter: counterHandler,
});

export const counter = makeInMemoryRuntime(registryConfig);
