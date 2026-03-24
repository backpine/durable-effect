import { Layer } from "effect"
import { HealthGroupLive } from "@/handlers/health"
import { CounterGroupLive } from "@/handlers/counter"
import { OnboardingGroupLive } from "@/handlers/onboarding"
import { BillingGroupLive } from "@/handlers/billing"

export { HealthGroupLive }
export { CounterGroupLive }
export { OnboardingGroupLive }
export { BillingGroupLive }

export const HttpGroupsLive = Layer.mergeAll(
  HealthGroupLive,
  CounterGroupLive,
  OnboardingGroupLive,
  BillingGroupLive,
)
