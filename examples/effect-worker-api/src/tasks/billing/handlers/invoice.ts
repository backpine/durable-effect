import { Effect } from "effect";
import { registry } from "../registry.js";

const o = registry.for("invoice");

const onEvent = o.onEvent((ctx, event) =>
  Effect.gen(function* () {
    yield* Effect.log(`[invoice] Creating invoice for user ${event.userId}, amount: $${event.amount}`);

    yield* ctx.save({
      userId: event.userId,
      amount: event.amount,
      status: "created",
      receiptSent: false,
    });

    // Dispatch to sibling — send a receipt
    yield* Effect.log(`[invoice] Dispatching receipt for user ${event.userId}`);
    yield* ctx.task("receipt").send(ctx.id, {
      _tag: "Send",
      invoiceId: ctx.id,
      userId: event.userId,
    });

    // Schedule a follow-up to mark as finalized
    yield* ctx.scheduleIn("5 seconds");
    yield* Effect.log(`[invoice] Scheduled finalization in 5s`);
  }),
);

const onAlarm = o.onAlarm((ctx) =>
  Effect.gen(function* () {
    const state = yield* ctx.recall();
    if (!state) return;

    yield* Effect.log(`[invoice] Finalizing invoice for user ${state.userId}`);

    // Check if receipt was sent by reading sibling state
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

export const invoiceHandler = registry.handler("invoice", {
  onEvent: { handler: onEvent, onError: (ctx, error) => Effect.log(`[invoice] Error: ${error}`) },
  onAlarm: { handler: onAlarm, onError: (ctx, error) => Effect.log(`[invoice] Alarm error: ${error}`) },
});
