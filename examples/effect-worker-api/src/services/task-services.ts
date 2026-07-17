// The project's typed platform-env service — declared ONCE, captures the
// wrangler-generated `Env` type. Env-dependent service layers read it with
// `yield* AppEnv` (fully typed, no cast). The runtime adapter provides it:
//   makeTaskGroupDO(config, { env: AppEnv })                                // production
//   makeInMemoryRuntime(config, { services: Layer.succeed(AppEnv, mock) })  // tests / local dev
import { Context } from "effect"

export class AppEnv extends Context.Service<AppEnv, Env>()("@app/Env") {}
