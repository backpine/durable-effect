import { Layer } from "effect"
import { HealthGroupLive } from "@/handlers/health"
import { CounterGroupLive } from "@/handlers/counter"

export { HealthGroupLive }
export { CounterGroupLive }

export const HttpGroupsLive = Layer.mergeAll(HealthGroupLive, CounterGroupLive)
