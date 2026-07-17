import { Effect, Layer } from "effect"
import type { AnyTaskTag } from "../TaskTag.js"
import type { HandlerConfig } from "../TaskRegistry.js"
import { wrapEventDef, wrapAlarmDef } from "../TaskRegistry.js"
import { CloudflareEnv } from "./CloudflareEnv.js"

// ---------------------------------------------------------------------------
// cloudflareServices<Env>() — factory that returns a typed helper for
// deferring service layer construction to the DO constructor.
//
// Usage (once per project):
//   import { cloudflareServices } from "@durable-effect/task-group/cloudflare"
//   export const withCloudflareServices = cloudflareServices<Env>()
//
// Then per handler:
//   registry.handler("myTask", withCloudflareServices(config, (env) => layer))
// ---------------------------------------------------------------------------

export function cloudflareServices<Env>() {
  return <S, E, EErr, AErr, Tags extends AnyTaskTag, RHe, RHa, OEErr = never, OAErr = never>(
    config: HandlerConfig<S, E, EErr, AErr, Tags, RHe, RHa, OEErr, OAErr>,
    makeLayer: (env: Env) => Layer.Layer<RHe | RHa>,
  ): HandlerConfig<S, E, EErr, AErr, Tags, RHe, RHa, OEErr, OAErr, RHe | RHa, RHe | RHa, CloudflareEnv, CloudflareEnv> => {
    // Build a Layer<R, never, CloudflareEnv> that:
    // 1. Reads CloudflareEnv (unknown) from the Effect context
    // 2. Casts to Env (safe — the DO constructor provides real CF env)
    // 3. Calls the user's factory to build the actual service layer
    // The layer is attached to BOTH channels via `provide`; it builds once per
    // instance through the runtime's MemoMap. (Prefer per-hook `provide` +
    // a typed env service for new code — see designs/effect-native-services.md.)
    const deferredLayer = Layer.unwrap(
      Effect.gen(function* () {
        const env = yield* CloudflareEnv
        return makeLayer(env as Env)
      }),
    )

    return {
      onEvent: wrapEventDef(config.onEvent, deferredLayer),
      onAlarm: wrapAlarmDef(config.onAlarm, deferredLayer),
    }
  }
}
