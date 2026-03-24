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
          yield* onboardingRuntime.sendEvent("onboarding", payload.userId, {
            _tag: "Start",
            userId: payload.userId,
            email: payload.email,
          }).pipe(Effect.orDie)

          return { status: "ok" as const, userId: payload.userId }
        }),
      )
      .handle("status", ({ params }) =>
        Effect.gen(function* () {
          const onboarding = yield* onboardingRuntime
            .getState("onboarding", params.userId)
            .pipe(Effect.orDie)
          const welcomeEmail = yield* onboardingRuntime
            .getState("welcomeEmail", params.userId)
            .pipe(Effect.orDie)

          return { onboarding, welcomeEmail }
        }),
      )
      .handle("complete", ({ params }) =>
        Effect.gen(function* () {
          // Fire the follow-up alarm immediately (simulates time passing)
          yield* onboardingRuntime
            .fireAlarm("onboarding", params.userId)
            .pipe(Effect.orDie)

          const onboarding = yield* onboardingRuntime
            .getState("onboarding", params.userId)
            .pipe(Effect.orDie)
          const welcomeEmail = yield* onboardingRuntime
            .getState("welcomeEmail", params.userId)
            .pipe(Effect.orDie)

          return { onboarding, welcomeEmail }
        }),
      ),
)
