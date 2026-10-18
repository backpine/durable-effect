import { HttpApiBuilder } from "effect/http-api";
import { Effect } from "effect";
import { WorkerApi, CloudflareBindings, BillingCreateResponseSchema } from "@/api";
import { billingClient } from "@/tasks/billing/index";

export const BillingGroupLive = HttpApiBuilder.group(
  WorkerApi,
  "billing",
  (handlers) =>
    handlers
      .handle("create", ({ payload }) =>
        Effect.gen(function* () {
          const { env } = yield* CloudflareBindings;
          const billing = billingClient(env.BILLING_DO);
          const invoiceId = `inv-${payload.userId}-${Date.now()}`;

          yield* billing
            .task("invoice")
            .send(invoiceId, {
              _tag: "Create",
              userId: payload.userId,
              amount: payload.amount,
            })
            .pipe(Effect.orDie);

          return { status: "ok", invoiceId } satisfies typeof BillingCreateResponseSchema.Type;
        }),
      )
      .handle("status", ({ params }) =>
        Effect.gen(function* () {
          const { env } = yield* CloudflareBindings;
          const billing = billingClient(env.BILLING_DO);
          const invoice = yield* billing
            .task("invoice")
            .getState(params.invoiceId)
            .pipe(Effect.orDie);
          const receipt = yield* billing
            .task("receipt")
            .getState(params.invoiceId)
            .pipe(Effect.orDie);

          return { invoice, receipt };
        }),
      )
      .handle("finalize", ({ params }) =>
        Effect.gen(function* () {
          const { env } = yield* CloudflareBindings;
          const billing = billingClient(env.BILLING_DO);
          yield* billing
            .task("invoice")
            .fireAlarm(params.invoiceId)
            .pipe(Effect.orDie);

          const invoice = yield* billing
            .task("invoice")
            .getState(params.invoiceId)
            .pipe(Effect.orDie);
          const receipt = yield* billing
            .task("receipt")
            .getState(params.invoiceId)
            .pipe(Effect.orDie);

          return { invoice, receipt };
        }),
      ),
);
