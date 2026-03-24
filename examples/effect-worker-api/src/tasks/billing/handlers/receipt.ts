import { Effect } from "effect";
import { registry } from "../registry.js";

const o = registry.for("receipt");

const onEvent = o.onEvent((ctx, event) =>
  Effect.gen(function* () {
    yield* Effect.log(`[receipt] Sending receipt to user ${event.userId} for invoice ${event.invoiceId}`);

    yield* ctx.save({
      invoiceId: event.invoiceId,
      userId: event.userId,
      sentAt: Date.now(),
    });

    yield* Effect.log(`[receipt] Receipt sent successfully`);
  }),
);

export const receiptHandler = registry.handler("receipt", {
  onEvent: onEvent,
  onAlarm: (ctx) => Effect.void,
});
