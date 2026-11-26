/**
 * The ledger tasks in a RUNNING Worker (local workerd): real Durable Objects,
 * real alarms, Postgres through the Hyperdrive binding. Every call goes through
 * the API's own typed client, so each response is decoded by the schema the
 * server declared and each failure arrives as its tagged error class.
 *
 * Needs `LEDGER_API_URL` (the Worker's origin) and the Docker Postgres;
 * `pnpm test:db` provides both.
 *
 * What it pins, per layer lifetime:
 *
 *   instance     a task instance's pool is still connected long after its last
 *                alarm returned (the instance cannot go idle)
 *   invocation   no pool is connected once an event or alarm has returned
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { WorkerApi } from "@/api"
import { BatchAlreadyOpen, BatchNotFound } from "@/ledger/errors"
import type { LedgerMode } from "@/ledger/repository"
import { auditPoolNameOf, poolNameOf } from "@/tasks/ledger/index"
import {
  auditRows,
  balanceOf,
  batchIdFor,
  closeObserver,
  connectionsOf,
  emptyLedger,
  entriesFor,
  entriesIn,
  eventually,
  sampled,
  totalOf,
} from "./support"

const API_URL = process.env.LEDGER_API_URL

const client = Effect.gen(function* () {
  if (API_URL === undefined) {
    return yield* Effect.die(new Error("LEDGER_API_URL is not set: start the Worker, or run `pnpm test:db`"))
  }
  return yield* HttpApiClient.make(WorkerApi, { baseUrl: API_URL })
})

type Client = Effect.Success<typeof client>

/** Call the API; a failure (a tagged error included) rejects the promise. */
const call = <A, E>(use: (api: Client) => Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(Effect.flatMap(client, use).pipe(Effect.provide(FetchHttpClient.layer)))

/** Call the API expecting it to FAIL, and hand back the failure it answered with. */
const failureOf = <A, E>(use: (api: Client) => Effect.Effect<A, E>): Promise<E> =>
  Effect.runPromise(Effect.flatMap(client, use).pipe(Effect.flip, Effect.provide(FetchHttpClient.layer)))

const MODES: ReadonlyArray<LedgerMode> = ["instance", "invocation"]

beforeAll(async () => {
  await emptyLedger()
})

afterAll(async () => {
  await closeObserver()
})

describe.each(MODES)("ledger tasks in the Worker, layer lifetime %s", (mode) => {
  const pool = poolNameOf(mode)

  const view = (batchId: string) => call((api) => api.ledger.view({ params: { mode, batchId } }))

  it("a 300-entry batch runs itself to the end on real alarms, and the books add up", async () => {
    const batchId = batchIdFor(`auto-${mode}`)
    const entries = entriesFor(batchId, 300)
    const held = await connectionsOf(pool)

    const opened = await call((api) =>
      api.ledger.open({ params: { mode }, payload: { batchId, entries, chunkSize: 50, autoRun: true } }),
    )
    expect(opened.task).toMatchObject({ phase: "open", entryCount: 300, totalCents: totalOf(entries) })
    expect(opened.batch).toMatchObject({ status: "open", entryCount: 300, postedCount: 0 })

    // Six alarms of 50, each scheduled by the one before it.
    const settled = await eventually(`batch ${batchId} to settle`, () => view(batchId), (seen) => seen.batch.status === "settled")
    expect(settled.batch).toMatchObject({ postedCount: 300, steps: 6, totalCents: totalOf(entries) })
    expect(settled.books).toMatchObject({
      pendingEntries: 0,
      postedEntries: 300,
      postedCents: totalOf(entries),
      balanceCents: totalOf(entries),
      balancePostings: 300,
      // The open, six chunks, the settlement.
      auditRows: 8,
    })
    const finished = await eventually(`task ${batchId} to settle`, () => view(batchId), (seen) => seen.task?.phase === "settled")
    expect(finished.task).toMatchObject({ postedCount: 300, steps: 6, lastFailure: null })
    expect(await balanceOf(batchId)).toBe(totalOf(entries))

    const verified = await call((api) => api.ledger.verify({ params: { mode, batchId } }))
    expect(verified.task?.verified).toBe(true)

    // The work is over. What is still connected, watched for three seconds:
    const seen = await sampled(() => connectionsOf(pool), 3_000)
    if (mode === "invocation") {
      expect(await eventually(`${pool} to be released`, () => connectionsOf(pool), (count) => count === 0, 5_000)).toBe(0)
      expect(seen.slice(-4)).toEqual([0, 0, 0, 0])
    } else {
      for (const count of seen) expect(count).toBeGreaterThan(held)
    }
  })

  it("steps by hand, survives a transaction that fails, and closes", async () => {
    const batchId = batchIdFor(`manual-${mode}`)
    const entries = entriesFor(batchId, 25)

    await call((api) => api.ledger.open({ params: { mode }, payload: { batchId, entries, chunkSize: 10, autoRun: false } }))

    const first = await call((api) => api.ledger.step({ params: { mode, batchId } }))
    expect(first.task).toMatchObject({ phase: "posting", postedCount: 10, steps: 1 })
    expect(first.books).toMatchObject({ pendingEntries: 15, postedEntries: 10 })

    const rowsBefore = first.books.auditRows
    const poisoned = await call((api) => api.ledger.poison({ params: { mode, batchId } }))
    expect(poisoned.task?.lastFailure).toEqual({
      hook: "onEvent",
      tag: "LedgerDatabaseError",
      message: expect.stringMatching(/^poisonBatch: UniqueViolation: /),
    })
    // Rolled back whole: no audit row, nothing posted, nothing lost.
    expect(poisoned.books.auditRows).toBe(rowsBefore)
    expect(poisoned.books).toMatchObject({ pendingEntries: 15, postedEntries: 10 })
    expect(await auditRows(batchId, "poison")).toBe(0)

    await call((api) => api.ledger.step({ params: { mode, batchId } }))
    const last = await call((api) => api.ledger.step({ params: { mode, batchId } }))
    expect(last.task).toMatchObject({ phase: "settled", postedCount: 25, steps: 3, lastFailure: null })
    expect(last.batch.status).toBe("settled")
    expect(await entriesIn(batchId, "pending")).toBe(0)
    expect(await balanceOf(batchId)).toBe(totalOf(entries))

    const closed = await call((api) => api.ledger.close({ params: { mode, batchId } }))
    // The instance purged itself; Postgres still has the batch.
    expect(closed.task).toBeNull()
    expect(closed.batch.status).toBe("settled")
    expect(await auditRows(batchId, "closed")).toBe(1)

    if (mode === "invocation") {
      expect(await eventually(`${pool} to be released`, () => connectionsOf(pool), (count) => count === 0, 5_000)).toBe(0)
    }
  })

  it("answers with its tagged errors, decoded by the client", async () => {
    const missing = batchIdFor(`missing-${mode}`)
    const notFound = await failureOf((api) => api.ledger.view({ params: { mode, batchId: missing } }))
    expect(notFound).toBeInstanceOf(BatchNotFound)
    expect(notFound).toMatchObject({ _tag: "BatchNotFound", batchId: missing })

    const stepMissing = await failureOf((api) => api.ledger.step({ params: { mode, batchId: missing } }))
    expect(stepMissing).toBeInstanceOf(BatchNotFound)

    const batchId = batchIdFor(`dup-${mode}`)
    const payload = { batchId, entries: entriesFor(batchId, 3), chunkSize: 3, autoRun: false }
    await call((api) => api.ledger.open({ params: { mode }, payload }))
    const again = await failureOf((api) => api.ledger.open({ params: { mode }, payload }))
    expect(again).toBeInstanceOf(BatchAlreadyOpen)
    expect(again).toMatchObject({ _tag: "BatchAlreadyOpen", batchId })
    expect(await entriesIn(batchId, "pending")).toBe(3)
  })

  it("refuses a payload its schema does not accept, before any task runs", async () => {
    if (API_URL === undefined) throw new Error("LEDGER_API_URL is not set")
    const batchId = batchIdFor(`invalid-${mode}`)
    const send = (payload: unknown) =>
      fetch(`${API_URL}/api/ledger/${mode}/batches`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
    const entries = entriesFor(batchId, 2)
    // A chunk size of zero, an amount that is not whole cents, no entries at all.
    expect((await send({ batchId, entries, chunkSize: 0, autoRun: false })).status).toBe(400)
    expect((await send({ batchId, entries: [{ account: "a", amountCents: 1.5 }], chunkSize: 1, autoRun: false })).status).toBe(400)
    expect((await send({ batchId, entries: [], chunkSize: 1, autoRun: false })).status).toBe(400)
    expect((await fetch(`${API_URL}/api/ledger/sometimes/batches/${batchId}`)).status).toBe(400)
    expect(await entriesIn(batchId, "pending")).toBe(0)
  })

  it("the audit task releases after every note, whatever the group's default", async () => {
    const batchId = batchIdFor(`note-${mode}`)
    await call((api) =>
      api.ledger.open({ params: { mode }, payload: { batchId, entries: entriesFor(batchId, 2), chunkSize: 2, autoRun: false } }),
    )
    for (const [index, detail] of ["one", "two", "three"].entries()) {
      const noted = await call((api) => api.ledger.note({ params: { mode, batchId }, payload: { detail } }))
      expect(noted.audit).toEqual({ batchId, notes: index + 1 })
      const auditPool = auditPoolNameOf(mode)
      expect(await eventually(`${auditPool} to be released`, () => connectionsOf(auditPool), (count) => count === 0, 5_000)).toBe(0)
    }
    expect(await auditRows(batchId, "t")).toBe(2) // "two" and "three"
  })

  it("ten batches at once all settle on their own alarms", async () => {
    const batchIds = Array.from({ length: 10 }, (_, index) => batchIdFor(`fleet-${mode}-${index}`))
    const held = await connectionsOf(pool)

    await Promise.all(
      batchIds.map((batchId) =>
        call((api) =>
          api.ledger.open({ params: { mode }, payload: { batchId, entries: entriesFor(batchId, 200), chunkSize: 45, autoRun: true } }),
        ),
      ),
    )
    for (const batchId of batchIds) {
      const settled = await eventually(`batch ${batchId} to settle`, () => view(batchId), (seen) => seen.task?.phase === "settled")
      // 200 entries in chunks of 45: five alarms.
      expect(settled.task).toMatchObject({ postedCount: 200, steps: 5, lastFailure: null })
      expect(settled.batch.status).toBe("settled")
      expect(settled.books).toMatchObject({ pendingEntries: 0, postedEntries: 200, balancePostings: 200 })
      expect(await balanceOf(batchId)).toBe(totalOf(entriesFor(batchId, 200)))
    }

    if (mode === "invocation") {
      expect(await eventually(`${pool} to be released`, () => connectionsOf(pool), (count) => count === 0, 5_000)).toBe(0)
    } else {
      // Ten task instances, each still holding the pool its hooks opened.
      expect(await connectionsOf(pool)).toBeGreaterThanOrEqual(held + 10)
    }
  })
})

describe("what stays connected once every task has gone quiet", () => {
  it("after twenty idle seconds: the instance lifetime still holds its pools, the invocation lifetime holds none", async () => {
    const instanceBefore = await connectionsOf(poolNameOf("instance"))
    expect(instanceBefore).toBeGreaterThan(0)

    const seen = await sampled(
      async () => ({
        instance: await connectionsOf(poolNameOf("instance")),
        invocation: await connectionsOf(poolNameOf("invocation")),
      }),
      20_000,
    )
    for (const sample of seen) {
      expect(sample.invocation).toBe(0)
      expect(sample.instance).toBe(instanceBefore)
    }

    // The Worker's own report agrees with what Postgres told the observer.
    const reported = await call((api) => api.ledger.connections())
    expect(reported.pools).toContainEqual({ applicationName: poolNameOf("instance"), connections: instanceBefore })
    expect(reported.pools.map((entry) => entry.applicationName)).not.toContain(poolNameOf("invocation"))
  })
})
