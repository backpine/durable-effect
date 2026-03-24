import { makeTaskGroupDO } from "@durable-effect/task-group/cloudflare";
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

// The client — wired to the DO namespace at module init.
// In production: import { env } from "cloudflare:workers" then taskGroup.client(env.BILLING_DO)
// For local dev with wrangler: same thing, wrangler provides local DOs.
//
// NOTE: For this example we use the in-memory runtime on the /billing endpoints
// and export the DO class for wrangler to bind. The CF adapter client would be:
//   export const billing = taskGroup.client(env.BILLING_DO)
// but we demonstrate the in-memory path here since it works without wrangler bindings.

import { makeInMemoryRuntime } from "@durable-effect/task-group";
export const billing = makeInMemoryRuntime(registryConfig);
