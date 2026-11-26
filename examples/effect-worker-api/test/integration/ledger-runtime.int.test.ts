/**
 * The ledger tasks on the in-memory runtime, over a REAL Postgres.
 *
 * Every test runs under both layer lifetimes. The work must come out the same;
 * what differs, and what these tests pin, is what is left open afterwards:
 *
 *   instance     the hook's pool is still connected after the hook returned
 *   invocation   nothing is connected after ANY hook returned: after a
 *                success, after a failure that rolled back, after a purge
 *
 * Connections are counted from the outside, in `pg_stat_activity`, by the
 * pool's `application_name`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Cause, Effect, Exit } from "effect"
import type { LedgerMode } from "@/ledger/repository"
import { auditPoolNameOf, makeLedgerRuntime, poolNameOf } from "@/tasks/ledger/index"
import {
  DATABASE_URL,
  auditRows,
  balanceOf,
  batchIdFor,
  closeObserver,
  connectionsOf,
  emptyLedger,
  entriesFor,
  entriesIn,
  eventually,
  totalOf,
} from "./support"

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)

/** Wait for a pool to reach a connection count (a closed socket takes Postgres a moment to drop). */
const settlesAt = (pool: string, accept: (count: number) => boolean) =>
  eventually(`connections of ${pool}`, () => connectionsOf(pool), accept, 5_000)

const MODES: ReadonlyArray<LedgerMode> = ["instance", "invocation"]

beforeAll(async () => {
  await emptyLedger()
})

afterAll(async () => {
  await closeObserver()
})

describe.each(MODES)("ledger tasks, layer lifetime %s", (mode) => {
  const pool = poolNameOf(mode)
  /** What must be true of the pool once a hook has returned. */
  const afterHook = async (heldBefore: number) => {
    if (mode === "invocation") {
      expect(await settlesAt(pool, (count) => count === 0)).toBe(0)
    } else {
      // The instance's pool is still connected, on top of whatever earlier
      // instances in this process hold.
      expect(await connectionsOf(pool)).toBeGreaterThan(heldBefore)
    }
  }

  it("posts a 500-entry batch over nine alarms and the books add up", async () => {
    const runtime = makeLedgerRuntime(mode, DATABASE_URL)
    const settlement = runtime.task("settlement")
    const batchId = batchIdFor(`big-${mode}`)
    const entries = entriesFor(batchId, 500)
    const held = await connectionsOf(pool)

    await run(settlement.send(batchId, { _tag: "Open", mode, entries, chunkSize: 60, autoRun: false }))
    expect(await run(settlement.getState(batchId))).toMatchObject({
      phase: "open",
      entryCount: 500,
      postedCount: 0,
      totalCents: totalOf(entries),
      lastFailure: null,
    })
    expect(await entriesIn(batchId, "pending")).toBe(500)
    await afterHook(held)

    // Eight full chunks of 60, then the last 20: nine alarms, and the ninth settles.
    for (let alarm = 1; alarm <= 9; alarm++) {
      await run(settlement.fireAlarm(batchId))
      const state = await run(settlement.getState(batchId))
      expect(state?.steps).toBe(alarm)
      expect(state?.postedCount).toBe(Math.min(alarm * 60, 500))
      expect(state?.phase).toBe(alarm < 9 ? "posting" : "settled")
      expect(await entriesIn(batchId, "posted")).toBe(Math.min(alarm * 60, 500))
      await afterHook(held)
    }

    // An alarm after the end changes nothing.
    await run(settlement.fireAlarm(batchId))
    expect((await run(settlement.getState(batchId)))?.steps).toBe(9)

    expect(await entriesIn(batchId, "pending")).toBe(0)
    expect(await balanceOf(batchId)).toBe(totalOf(entries))
    // One audit row per committed hook: the open, nine chunks, the settlement.
    expect(await auditRows(batchId, "opened")).toBe(1)
    expect(await auditRows(batchId, "posted")).toBe(9)
    expect(await auditRows(batchId, "settled")).toBe(1)

    await run(settlement.send(batchId, { _tag: "Verify" }))
    expect((await run(settlement.getState(batchId)))?.verified).toBe(true)
    await afterHook(held)
  })

  it("a transaction that fails rolls back, is recorded by its tag, and leaves the batch usable", async () => {
    const runtime = makeLedgerRuntime(mode, DATABASE_URL)
    const settlement = runtime.task("settlement")
    const batchId = batchIdFor(`poison-${mode}`)
    const entries = entriesFor(batchId, 10)
    const held = await connectionsOf(pool)

    await run(settlement.send(batchId, { _tag: "Open", mode, entries, chunkSize: 4, autoRun: false }))
    await run(settlement.send(batchId, { _tag: "Poison" }))

    const state = await run(settlement.getState(batchId))
    expect(state?.lastFailure).toEqual({
      hook: "onEvent",
      tag: "LedgerDatabaseError",
      message: expect.stringMatching(/^poisonBatch: UniqueViolation: /),
    })
    // The poison's audit row was written inside the transaction that failed.
    expect(await auditRows(batchId, "poison")).toBe(0)
    expect(await entriesIn(batchId, "pending")).toBe(10)
    await afterHook(held)

    // The batch still runs to the end, and a success clears the recorded failure.
    for (let alarm = 1; alarm <= 3; alarm++) await run(settlement.fireAlarm(batchId))
    expect(await run(settlement.getState(batchId))).toMatchObject({
      phase: "settled",
      postedCount: 10,
      lastFailure: null,
    })
    expect(await balanceOf(batchId)).toBe(totalOf(entries))
    await afterHook(held)
  })

  it("a second Open of the same batch is recorded as BatchAlreadyOpen and writes nothing", async () => {
    const runtime = makeLedgerRuntime(mode, DATABASE_URL)
    const settlement = runtime.task("settlement")
    const batchId = batchIdFor(`twice-${mode}`)
    const held = await connectionsOf(pool)

    await run(settlement.send(batchId, { _tag: "Open", mode, entries: entriesFor(batchId, 5), chunkSize: 5, autoRun: false }))
    await run(settlement.send(batchId, { _tag: "Open", mode, entries: entriesFor(batchId, 9), chunkSize: 5, autoRun: false }))

    expect(await run(settlement.getState(batchId))).toMatchObject({
      entryCount: 5,
      lastFailure: { hook: "onEvent", tag: "BatchAlreadyOpen" },
    })
    expect(await entriesIn(batchId, "pending")).toBe(5)
    expect(await auditRows(batchId, "opened")).toBe(1)
    await afterHook(held)
  })

  it("a first Open that fails has no state to record on, so its send fails with the tagged error", async () => {
    const runtime = makeLedgerRuntime(mode, DATABASE_URL)
    const batchId = batchIdFor(`taken-${mode}`)
    // Another task instance (another runtime) already opened this batch id.
    await run(
      makeLedgerRuntime(mode, DATABASE_URL)
        .task("settlement")
        .send(batchId, { _tag: "Open", mode, entries: entriesFor(batchId, 3), chunkSize: 3, autoRun: false }),
    )
    const held = await connectionsOf(pool)

    const exit = await Effect.runPromiseExit(
      runtime
        .task("settlement")
        .send(batchId, { _tag: "Open", mode, entries: entriesFor(batchId, 3), chunkSize: 3, autoRun: false }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    const failure = Exit.isFailure(exit) ? Cause.squash(exit.cause) : null
    expect(failure).toMatchObject({
      _tag: "TaskExecutionError",
      cause: { _tag: "BatchAlreadyOpen", batchId },
    })
    expect(await run(runtime.task("settlement").getState(batchId))).toBeNull()
    await afterHook(held)
  })

  it("Close writes its last row, purges the instance, and the purge releases too", async () => {
    const runtime = makeLedgerRuntime(mode, DATABASE_URL)
    const settlement = runtime.task("settlement")
    const batchId = batchIdFor(`close-${mode}`)
    const held = await connectionsOf(pool)

    await run(settlement.send(batchId, { _tag: "Open", mode, entries: entriesFor(batchId, 4), chunkSize: 4, autoRun: false }))
    await run(settlement.send(batchId, { _tag: "Close" }))

    expect(await run(settlement.getState(batchId))).toBeNull()
    expect(await auditRows(batchId, "closed")).toBe(1)
    await afterHook(held)
  })

  it("the audit task's own `lifetime: invocation` wins over the group's default", async () => {
    const runtime = makeLedgerRuntime(mode, DATABASE_URL)
    const batchId = batchIdFor(`note-${mode}`)
    const auditPool = auditPoolNameOf(mode)

    for (const detail of ["first", "second", "third"]) {
      await run(runtime.task("audit").send(batchId, { _tag: "Note", detail }))
      // Released after every event, in BOTH groups: the hook names its lifetime.
      expect(await settlesAt(auditPool, (count) => count === 0)).toBe(0)
    }
    expect(await run(runtime.task("audit").getState(batchId))).toEqual({ batchId, notes: 3 })
    expect(await auditRows(batchId, "")).toBe(3)
  })

  it("twelve batches at once all settle, and only the instance lifetime holds a pool each", async () => {
    const runtime = makeLedgerRuntime(mode, DATABASE_URL)
    const settlement = runtime.task("settlement")
    const batchIds = Array.from({ length: 12 }, (_, index) => batchIdFor(`many-${mode}-${index}`))
    const held = await connectionsOf(pool)

    await run(
      Effect.forEach(
        batchIds,
        (batchId) =>
          Effect.gen(function* () {
            yield* settlement.send(batchId, {
              _tag: "Open",
              mode,
              entries: entriesFor(batchId, 150),
              chunkSize: 40,
              autoRun: false,
            })
            // 150 entries in chunks of 40: four alarms.
            for (let alarm = 0; alarm < 4; alarm++) yield* settlement.fireAlarm(batchId)
            yield* settlement.send(batchId, { _tag: "Verify" })
          }),
        { concurrency: "unbounded" },
      ),
    )

    for (const batchId of batchIds) {
      expect(await run(settlement.getState(batchId))).toMatchObject({
        phase: "settled",
        postedCount: 150,
        steps: 4,
        verified: true,
        lastFailure: null,
      })
      expect(await balanceOf(batchId)).toBe(totalOf(entriesFor(batchId, 150)))
    }

    if (mode === "invocation") {
      expect(await settlesAt(pool, (count) => count === 0)).toBe(0)
    } else {
      // One pool per task instance, each still connected: twelve more than before.
      expect(await connectionsOf(pool)).toBeGreaterThanOrEqual(held + 12)
    }
  })
})

describe("a database that cannot be reached", () => {
  it.each(MODES)("fails the send with a tagged LedgerDatabaseError (%s)", async (mode) => {
    // Nothing listens on port 9 of this host.
    const runtime = makeLedgerRuntime(mode, "postgres://postgres:postgres@127.0.0.1:9/task_example")
    const batchId = batchIdFor(`down-${mode}`)

    const exit = await Effect.runPromiseExit(
      runtime
        .task("settlement")
        .send(batchId, { _tag: "Open", mode, entries: entriesFor(batchId, 2), chunkSize: 2, autoRun: false }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    // The pool connects on its first statement, so the hook's own `openBatch`
    // fails, and with no state to record on the send carries it out.
    expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : null).toMatchObject({
      _tag: "TaskExecutionError",
      cause: { _tag: "LedgerDatabaseError", operation: "openBatch", reason: "ConnectionError" },
    })
  })
})
