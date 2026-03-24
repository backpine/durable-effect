import { makeInMemoryRuntime } from "@durable-effect/task-group";
import { registry } from "./registry.js";
import { onboardingHandler } from "./handlers/onboarding.js";
import { welcomeEmailHandler } from "./handlers/welcome-email.js";

export { Onboarding, WelcomeEmail } from "./registry.js";

const registryConfig = registry.build({
  onboarding: onboardingHandler,
  welcomeEmail: welcomeEmailHandler,
});

export const onboardingRuntime = makeInMemoryRuntime(registryConfig);
