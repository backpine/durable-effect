import { Layer } from "effect";
import { makeTaskGroupDO, CloudflareEnv } from "@durable-effect/task/cloudflare";
import { makeInMemoryRuntime } from "@durable-effect/task";
import { registry } from "./registry.js";
import { invoiceHandler } from "./handlers/invoice.js";
import { receiptHandler } from "./handlers/receipt.js";

export { Invoice, Receipt } from "./registry.js";

const registryConfig = registry.build({
  invoice: invoiceHandler,
  receipt: receiptHandler,
});

// The DO class + client — same factory, shared closure for namespace
const taskGroup = makeTaskGroupDO(registryConfig);

// Export the DO class for wrangler
export const BillingDO = taskGroup.DO;

// In-memory runtime for local dev — provide a mock CloudflareEnv
// so the deferred BillingConfig layer can resolve.
export const billing = makeInMemoryRuntime(registryConfig, {
  services: Layer.succeed(CloudflareEnv)({
    BILLING_CURRENCY: "USD",
    ENVIRONMENT: "development",
  }),
});
