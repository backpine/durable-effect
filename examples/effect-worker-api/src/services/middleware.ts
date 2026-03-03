import { Effect, Layer } from "effect"
import {
  CloudflareBindingsMiddleware,
  CloudflareBindingsError,
  CloudflareBindings,
} from "@/api"
import { currentEnv, currentCtx } from "@/services/cloudflare"

export const CloudflareBindingsMiddlewareLive = Layer.succeed(
  CloudflareBindingsMiddleware,
  (httpEffect) =>
    Effect.gen(function* () {
      const env = yield* currentEnv
      const ctx = yield* currentCtx

      if (env === null || ctx === null) {
        return yield* Effect.fail(
          new CloudflareBindingsError({
            message:
              "Cloudflare bindings not available. Ensure the worker entry point passes env/ctx via ServiceMap.",
          }),
        )
      }

      return yield* httpEffect.pipe(
        Effect.provideService(CloudflareBindings, { env, ctx }),
      )
    }),
)

export const MiddlewareLive = CloudflareBindingsMiddlewareLive
