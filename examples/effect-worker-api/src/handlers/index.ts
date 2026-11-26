import { Layer } from "effect"
import { HealthGroupLive } from "@/handlers/health"
import { CounterGroupLive } from "@/handlers/counter"
import { OnboardingGroupLive } from "@/handlers/onboarding"
import { BillingGroupLive } from "@/handlers/billing"
import { LedgerGroupLive } from "@/handlers/ledger"

export { HealthGroupLive }
export { CounterGroupLive }
export { OnboardingGroupLive }
export { BillingGroupLive }
export { LedgerGroupLive }

export const HttpGroupsLive = Layer.mergeAll(
  HealthGroupLive,
  CounterGroupLive,
  OnboardingGroupLive,
  BillingGroupLive,
  LedgerGroupLive,
)
