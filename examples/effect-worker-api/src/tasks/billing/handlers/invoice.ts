import { Effect, Layer, Context } from "effect";
import { registry } from "../registry.js";
import { withCloudflareServices } from "../../../services/task-services.js";

// ── Service that reads from Cloudflare env ───────────────

class BillingConfig extends Context.Service<BillingConfig, {
  readonly currency: string
}>()("@app/BillingConfig") {}

const makeBillingConfigLayer = (env: Env) =>
  Layer.succeed(BillingConfig)({
    currency: env.BILLING_CURRENCY ?? "USD",
  });

// ── Handler ──────────────────────────────────────────────

const o = registry.for("invoice");

const onEvent = o.onEvent((ctx, event) =>
  Effect.gen(function* () {
    const config = yield* BillingConfig;

    yield* Effect.log(`[invoice] Creating invoice for user ${event.userId}, amount: ${config.currency} ${event.amount}`);

    yield* ctx.save({
      userId: event.userId,
      amount: event.amount,
      status: "created",
      receiptSent: false,
    });

    yield* Effect.log(`[invoice] Dispatching receipt for user ${event.userId}`);
    yield* ctx.task("receipt").send(ctx.id, {
      _tag: "Send",
      invoiceId: ctx.id,
      userId: event.userId,
    });

    yield* ctx.scheduleIn("5 seconds");
    yield* Effect.log(`[invoice] Scheduled finalization in 5s`);
  }),
);

const onAlarm = o.onAlarm((ctx) =>
  Effect.gen(function* () {
    const state = yield* ctx.recall();
    if (!state) return;

    yield* Effect.log(`[invoice] Finalizing invoice for user ${state.userId}`);

    const receiptState = yield* ctx.task("receipt").getState(ctx.id);
    const receiptSent = receiptState !== null;

    yield* ctx.save({
      ...state,
      status: "finalized",
      receiptSent,
    });

    yield* Effect.log(`[invoice] Finalized. Receipt sent: ${receiptSent}`);
  }),
);

export const invoiceHandler = registry.handler("invoice",
  withCloudflareServices(
    {
      onEvent: { handler: onEvent, onError: (ctx, error) => Effect.log(`[invoice] Error: ${error}`) },
      onAlarm: { handler: onAlarm, onError: (ctx, error) => Effect.log(`[invoice] Alarm error: ${error}`) },
    },
    (env) => makeBillingConfigLayer(env),
  ),
);
