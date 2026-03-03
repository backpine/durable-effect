import { Effect, ServiceMap } from "effect"

export const currentEnv = ServiceMap.Reference<Env | null>(
  "@app/currentEnv",
  { defaultValue: () => null },
)

export const currentCtx = ServiceMap.Reference<ExecutionContext | null>(
  "@app/currentCtx",
  { defaultValue: () => null },
)

export const withCloudflareBindings = (env: Env, ctx: ExecutionContext) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(currentEnv, env),
      Effect.provideService(currentCtx, ctx),
    )

export const waitUntil = <A, E>(
  effect: Effect.Effect<A, E>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const ctx = yield* currentCtx
    if (ctx) {
      ctx.waitUntil(
        Effect.runPromise(
          effect.pipe(
            Effect.tapCause(Effect.logError),
            Effect.catch(() => Effect.void),
          ),
        ),
      )
    }
  })
