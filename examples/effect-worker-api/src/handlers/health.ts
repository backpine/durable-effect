import { HttpApiBuilder } from "effect/http-api"
import { DateTime, Effect } from "effect"
import { WorkerApi, HealthResponseSchema } from "@/api"

export const HealthGroupLive = HttpApiBuilder.group(
  WorkerApi,
  "health",
  (handlers) =>
    handlers.handle("check", () =>
      Effect.gen(function* () {
        return {
          status: "ok",
          timestamp: DateTime.nowUnsafe(),
        } satisfies typeof HealthResponseSchema.Type
      }),
    ),
)
