import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Effect } from "effect";
import { WorkerApi } from "@/api";
import { tasks } from "@/tasks/counter";
import { env } from "cloudflare:workers";

export const CounterGroupLive = HttpApiBuilder.group(
  WorkerApi,
  "counter",
  (handlers) =>
    handlers.handle("start", ({ params }) =>
      Effect.gen(function* () {
        const counter = tasks(env.TASKS_DO, "counter");
        yield* counter.send(params.counterId, { _tag: "Start" }).pipe(Effect.orDie);

        return { status: "ok" as const, counterId: params.counterId };
      }),
    ),
);
