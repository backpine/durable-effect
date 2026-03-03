import { HttpApiBuilder } from "effect/unstable/httpapi"
import { DateTime, Effect } from "effect"
import { WorkerApi } from "@/api"

export const HealthGroupLive = HttpApiBuilder.group(
  WorkerApi,
  "health",
  (handlers) =>
    handlers.handle("check", () =>
      Effect.gen(function* () {
        return {
          status: "ok" as const,
          timestamp: DateTime.nowUnsafe(),
        }
      }),
    ),
)
