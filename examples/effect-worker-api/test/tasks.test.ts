/**
 * Local integration test for the migrated task groups — exercises the NEW
 * per-hook / typed-env dependency-injection pattern against the in-memory
 * runtime (no Cloudflare needed). Run with `pnpm test`.
 */
import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import { counter } from "@/tasks/counter"
import { billing } from "@/tasks/billing/index"
import { onboardingRuntime } from "@/tasks/onboarding/index"

const run = <A, E>(e: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(e)

describe("effect-worker-api — new DI pattern", () => {
  it("counter: onEvent gets Analytics (per-hook provide); onAlarm increments without it", async () => {
    await run(counter.task("counter").send("c1", { _tag: "Start" }))
    expect(await run(counter.task("counter").getState("c1"))).toEqual({ count: 0 })

    await run(counter.task("counter").fireAlarm("c1"))
    expect(await run(counter.task("counter").getState("c1"))).toEqual({ count: 1 })
  })

  it("billing: env-derived BillingConfig resolves via AppEnv; receipt sibling dispatched; alarm finalizes", async () => {
    await run(billing.task("invoice").send("inv1", { _tag: "Create", userId: "u1", amount: 100 }))

    // onEvent built BillingConfig from the provided AppEnv and saved the invoice.
    expect(await run(billing.task("invoice").getState("inv1"))).toMatchObject({
      userId: "u1",
      amount: 100,
      status: "created",
      receiptSent: false,
    })

    // onEvent dispatched to the receipt sibling (which needs no services).
    expect(await run(billing.task("receipt").getState("inv1"))).toMatchObject({
      invoiceId: "inv1",
      userId: "u1",
    })

    // onAlarm needs NO services — finalizes and confirms the receipt.
    await run(billing.task("invoice").fireAlarm("inv1"))
    expect(await run(billing.task("invoice").getState("inv1"))).toMatchObject({
      status: "finalized",
      receiptSent: true,
    })
  })

  it("onboarding: both channels provide Analytics; welcomeEmail sibling dispatched", async () => {
    await run(
      onboardingRuntime.task("onboarding").send("u1", {
        _tag: "Start",
        userId: "u1",
        email: "u1@example.com",
      }),
    )

    expect(await run(onboardingRuntime.task("onboarding").getState("u1"))).toMatchObject({
      userId: "u1",
      step: "welcome_email_queued",
    })
    expect(await run(onboardingRuntime.task("welcomeEmail").getState("u1"))).toMatchObject({
      to: "u1@example.com",
      userId: "u1",
    })
  })
})
