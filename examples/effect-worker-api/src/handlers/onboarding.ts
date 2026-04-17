import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Effect } from "effect"
import { WorkerApi } from "@/api"
import { onboardingRuntime } from "@/tasks/onboarding/index"

export const OnboardingGroupLive = HttpApiBuilder.group(
  WorkerApi,
  "onboarding",
  (handlers) =>
    handlers
      .handle("start", ({ payload }) =>
        Effect.gen(function* () {
          yield* onboardingRuntime
            .task("onboarding")
            .send(payload.userId, {
              _tag: "Start",
              userId: payload.userId,
              email: payload.email,
            })
            .pipe(Effect.orDie)

          return { status: "ok" as const, userId: payload.userId }
        }),
      )
      .handle("status", ({ params }) =>
        Effect.gen(function* () {
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
