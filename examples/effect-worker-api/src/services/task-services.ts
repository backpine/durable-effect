// Project-wide cloudflareServices helper — captures the Env type once.
// Import this in any handler that needs deferred services.
import { cloudflareServices } from "@durable-effect/task/cloudflare"

export const withCloudflareServices = cloudflareServices<Env>()
