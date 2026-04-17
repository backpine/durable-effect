import { Layer } from "effect"
import { HealthGroupLive } from "@/handlers/health"
// import { CounterGroupLive } from "@/handlers/counter" // uses old Task.define API
import { OnboardingGroupLive } from "@/handlers/onboarding"
import { BillingGroupLive } from "@/handlers/billing"

export { HealthGroupLive }
// export { CounterGroupLive }
export { OnboardingGroupLive }
export { BillingGroupLive }

export const HttpGroupsLive = Layer.mergeAll(
  HealthGroupLive,
  OnboardingGroupLive,
  BillingGroupLive,
)
