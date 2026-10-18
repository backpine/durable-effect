import { makeTaskGroupDO } from "@durable-effect/task/cloudflare";
import { AppEnv } from "../../services/task-services.js";
import { makeInMemoryRuntime } from "@durable-effect/task";
import { registry } from "./registry.js";
import { onboardingHandler } from "./handlers/onboarding.js";
import { welcomeEmailHandler } from "./handlers/welcome-email.js";

export { Onboarding, WelcomeEmail } from "./registry.js";

const registryConfig = registry.build({
  onboarding: onboardingHandler,
  welcomeEmail: welcomeEmailHandler,
});

export const onboardingRuntime = makeInMemoryRuntime(registryConfig);

const taskGroup = makeTaskGroupDO(registryConfig, {
  env: AppEnv,
  namespace: (env: Env) => env.ONBOARDING_DO,
});
export const OnboardingDO = taskGroup.DO;
export const onboardingClient = taskGroup.client;
