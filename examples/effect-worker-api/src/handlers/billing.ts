import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Effect } from "effect";
import { WorkerApi } from "@/api";
import { billing } from "@/tasks/billing/index";

export const BillingGroupLive = HttpApiBuilder.group(
  WorkerApi,
  "billing",
  (handlers) =>
    handlers
      .handle("create", ({ payload }) =>
        Effect.gen(function* () {
          const invoiceId = `inv-${payload.userId}-${Date.now()}`;

          yield* billing
            .sendEvent("invoice", invoiceId, {
              _tag: "Create",
              userId: payload.userId,
              amount: payload.amount,
            })
            .pipe(Effect.orDie);

          return { status: "ok" as const, invoiceId };
        }),
      )
      .handle("status", ({ params }) =>
        Effect.gen(function* () {
          const invoice = yield* billing
            .getState("invoice", params.invoiceId)
            .pipe(Effect.orDie);
          const receipt = yield* billing
            .getState("receipt", params.invoiceId)
            .pipe(Effect.orDie);

          return { invoice, receipt };
        }),
      )
      .handle("finalize", ({ params }) =>
        Effect.gen(function* () {
          // Fire the alarm to trigger finalization
          yield* billing.fireAlarm("invoice", params.invoiceId).pipe(Effect.orDie);

          const invoice = yield* billing
            .getState("invoice", params.invoiceId)
            .pipe(Effect.orDie);
          const receipt = yield* billing
            .getState("receipt", params.invoiceId)
            .pipe(Effect.orDie);

          return { invoice, receipt };
        }),
      ),
);
