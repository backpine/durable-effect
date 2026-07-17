import { Effect, Layer, Context } from "effect";
import { registry } from "../registry.js";
import { AppEnv } from "../../../services/task-services.js";

// ── Service that reads from the (typed) platform env ─────
// Platform-agnostic: it reads AppEnv via the Effect context. No cast, and it
// builds only when the hook that needs it runs (onEvent), never for onAlarm.

class BillingConfig extends Context.Service<BillingConfig, {
  readonly currency: string
}>()("@app/BillingConfig") {}

const BillingConfigLive = Layer.effect(
  BillingConfig,
  Effect.gen(function* () {
    const env = yield* AppEnv; // typed as Env — no cast
    return { currency: env.BILLING_CURRENCY ?? "USD" };
  }),
);

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

// Per-hook service provision: onEvent needs BillingConfig (env-derived), so it
// `provide`s the layer — built once per instance. onAlarm needs no services, so
// it provides nothing and never builds the BillingConfig layer.
export const invoiceHandler = registry.handler("invoice", {
  onEvent: {
    handler: onEvent,
    onError: (ctx, error) => Effect.log(`[invoice] Error: ${error}`),
    provide: BillingConfigLive,
  },
  onAlarm: {
    handler: onAlarm,
    onError: (ctx, error) => Effect.log(`[invoice] Alarm error: ${error}`),
  },
});
