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
// AppEnv service from the DO's `env` — the one place the untyped CF env is
// bridged to the typed service the handlers depend on.
const taskGroup = makeTaskGroupDO(registryConfig, { env: AppEnv });

// Export the DO class for wrangler
export const BillingDO = taskGroup.DO;

// In-memory runtime for local dev / tests — provide a mock AppEnv so the
// env-derived BillingConfig layer can resolve.
export const billing = makeInMemoryRuntime(registryConfig, {
  services: Layer.succeed(AppEnv, {
    ENVIRONMENT: "development",
    LOG_LEVEL: "debug",
    BILLING_CURRENCY: "USD",
  } as Env),
});
