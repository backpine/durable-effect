import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Effect } from "effect";
import { WorkerApi } from "@/api";
import { counter } from "@/tasks/counter";

export const CounterGroupLive = HttpApiBuilder.group(
  WorkerApi,
  "counter",
  (handlers) =>
    handlers.handle("start", ({ params }) =>
      Effect.gen(function* () {
        yield* counter
          .task("counter")
          .send(params.counterId, { _tag: "Start" })
          .pipe(Effect.orDie);

        return { status: "ok" as const, counterId: params.counterId };
      }),
    ),
);
