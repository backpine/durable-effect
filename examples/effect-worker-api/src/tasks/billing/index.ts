import { Layer } from "effect";
import { makeTaskGroupDO } from "@durable-effect/task/cloudflare";
import { makeInMemoryRuntime } from "@durable-effect/task";
import { registry } from "./registry.js";
import { AppEnv } from "../../services/task-services.js";
import { invoiceHandler } from "./handlers/invoice.js";
import { receiptHandler } from "./handlers/receipt.js";

export { Invoice, Receipt } from "./registry.js";

const registryConfig = registry.build({
  invoice: invoiceHandler,
  receipt: receiptHandler,
});

// The DO class + client. `{ env: AppEnv }` tells the runtime to populate the
// AppEnv service from the DO's typed env. The namespace selector also works
// when Cloudflare wakes an alarm without first receiving a client request.
const taskGroup = makeTaskGroupDO(registryConfig, {
  env: AppEnv,
  namespace: (env: Env) => env.BILLING_DO,
});

// Export the DO class for wrangler
export const BillingDO = taskGroup.DO;

// In-memory runtime for local dev / tests — provide a mock AppEnv so the
// env-derived BillingConfig layer can resolve.
export const billing = makeInMemoryRuntime(registryConfig, {
  services: Layer.succeed(AppEnv, {
    BILLING_CURRENCY: "USD",
  }),
});

export const billingClient = taskGroup.client;
