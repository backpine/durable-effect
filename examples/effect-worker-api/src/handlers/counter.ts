import { HttpApiBuilder } from "effect/http-api"
import { Effect } from "effect"
import { WorkerApi, CloudflareBindings, CounterResponseSchema } from "@/api"
import { counterClient } from "@/tasks/counter"

export const CounterGroupLive = HttpApiBuilder.group(
  WorkerApi,
  "counter",
  (handlers) => handlers
    .handle("start", ({ params }) => Effect.gen(function* () {
      const { env } = yield* CloudflareBindings
      yield* counterClient(env.COUNTER_DO).task("counter")
        .send(params.counterId, { _tag: "Start" }).pipe(Effect.orDie)
      return { status: "ok", counterId: params.counterId } satisfies typeof CounterResponseSchema.Type
    }))
    .handle("status", ({ params }) => Effect.gen(function* () {
      const { env } = yield* CloudflareBindings
      const counter = yield* counterClient(env.COUNTER_DO).task("counter")
        .getState(params.counterId).pipe(Effect.orDie)
      return { counter }
    })),
)
