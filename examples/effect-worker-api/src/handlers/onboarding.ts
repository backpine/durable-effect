import { HttpApiBuilder } from "effect/http-api"
import { Effect } from "effect"
import { WorkerApi, CloudflareBindings, OnboardingStartResponseSchema } from "@/api"
import { onboardingClient } from "@/tasks/onboarding/index"

export const OnboardingGroupLive = HttpApiBuilder.group(
  WorkerApi,
  "onboarding",
  (handlers) =>
    handlers
      .handle("start", ({ payload }) =>
        Effect.gen(function* () {
          const { env } = yield* CloudflareBindings
          const onboardingRuntime = onboardingClient(env.ONBOARDING_DO)
          yield* onboardingRuntime
            .task("onboarding")
            .send(payload.userId, {
              _tag: "Start",
              userId: payload.userId,
              email: payload.email,
            })
            .pipe(Effect.orDie)

          return { status: "ok", userId: payload.userId } satisfies typeof OnboardingStartResponseSchema.Type
        }),
      )
      .handle("status", ({ params }) =>
        Effect.gen(function* () {
          const { env } = yield* CloudflareBindings
          const onboardingRuntime = onboardingClient(env.ONBOARDING_DO)
          const onboarding = yield* onboardingRuntime
            .task("onboarding")
            .getState(params.userId)
            .pipe(Effect.orDie)
          const welcomeEmail = yield* onboardingRuntime
            .task("welcomeEmail")
            .getState(params.userId)
            .pipe(Effect.orDie)

          return { onboarding, welcomeEmail }
        }),
      )
      .handle("complete", ({ params }) =>
        Effect.gen(function* () {
          const { env } = yield* CloudflareBindings
          const onboardingRuntime = onboardingClient(env.ONBOARDING_DO)
          yield* onboardingRuntime
            .task("onboarding")
            .fireAlarm(params.userId)
            .pipe(Effect.orDie)

          const onboarding = yield* onboardingRuntime
            .task("onboarding")
            .getState(params.userId)
            .pipe(Effect.orDie)
          const welcomeEmail = yield* onboardingRuntime
            .task("welcomeEmail")
            .getState(params.userId)
            .pipe(Effect.orDie)

          return { onboarding, welcomeEmail }
        }),
      ),
)
