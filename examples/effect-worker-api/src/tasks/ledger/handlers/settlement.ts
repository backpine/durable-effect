import { Effect } from "effect"
import type { PurgeSignal, TaskError } from "@durable-effect/task"
import type { ledgerDatabaseLayer } from "../../../ledger/database.js"
import type {
  BatchAlreadyOpen,
  BatchNotFound,
  LedgerDatabaseError,
  LedgerInvariantBroken,
  LedgerRowInvalid,
  RecordedFailure,
} from "../../../ledger/errors.js"
import {
  auditBatch,
  getBatch,
  openBatch,
  poisonBatch,
  postChunk,
  recordAudit,
  settleBatch,
} from "../../../ledger/repository.js"
import { registry } from "../registry.js"

/** How long after one chunk the next alarm fires, when the batch runs itself. */
const STEP_DELAY = "250 millis"

/** Everything a settlement hook can fail with. */
type SettlementFailure =
  | LedgerDatabaseError
  | LedgerRowInvalid
  | BatchAlreadyOpen
  | BatchNotFound
  | LedgerInvariantBroken
  | TaskError
  | PurgeSignal

/** A failure as the state keeps it: its tag, and words naming what and why. */
const recorded = (hook: RecordedFailure["hook"], error: SettlementFailure): RecordedFailure => {
  switch (error._tag) {
    case "LedgerDatabaseError":
      return { hook, tag: error._tag, message: `${error.operation}: ${error.reason}: ${error.message}` }
    case "LedgerRowInvalid":
      return { hook, tag: error._tag, message: `${error.operation}: ${error.message}` }
    case "LedgerInvariantBroken":
      return { hook, tag: error._tag, message: `${error.invariant}: ${error.message}` }
    case "BatchAlreadyOpen":
    case "BatchNotFound":
    case "TaskError":
      return { hook, tag: error._tag, message: error.message }
    case "PurgeSignal":
      return { hook, tag: error._tag, message: "purged" }
  }
}

const s = registry.for("settlement")

const onEvent = s.onEvent((ctx, event) =>
  Effect.gen(function* () {
    switch (event._tag) {
      case "Open": {
        const opened = yield* openBatch({ batchId: ctx.id, mode: event.mode, entries: event.entries })
        yield* ctx.save({
          batchId: ctx.id,
          mode: event.mode,
          phase: "open",
          autoRun: event.autoRun,
          chunkSize: event.chunkSize,
          entryCount: opened.entryCount,
          postedCount: 0,
          totalCents: opened.totalCents,
          steps: 0,
          verified: null,
          lastFailure: null,
        })
        if (event.autoRun) yield* ctx.scheduleIn(STEP_DELAY)
        return
      }
      case "Verify": {
        const batch = yield* getBatch(ctx.id)
        const books = yield* auditBatch(ctx.id)
        const verified =
          books.entriesCents === batch.totalCents &&
          books.postedEntries === batch.postedCount &&
          books.pendingEntries === batch.entryCount - batch.postedCount &&
          books.balancePostings === batch.postedCount &&
          books.balanceCents === books.postedCents
        yield* ctx.update((state) => ({ ...state, verified, lastFailure: null }))
        return
      }
      case "Poison": {
        yield* poisonBatch(ctx.id)
        return
      }
      case "Close": {
        yield* recordAudit({ batchId: ctx.id, hook: "onEvent", detail: "closed" })
        return yield* ctx.purge()
      }
    }
  }),
)

const onAlarm = s.onAlarm((ctx) =>
  Effect.gen(function* () {
    const state = yield* ctx.recall()
    if (state === null || state.phase === "settled") return

    const step = yield* postChunk({ batchId: ctx.id, limit: state.chunkSize })
    if (step.remaining > 0) {
      yield* ctx.save({ ...state, phase: "posting", postedCount: step.postedCount, steps: step.steps, lastFailure: null })
      if (state.autoRun) yield* ctx.scheduleIn(STEP_DELAY)
      return
    }
    const settled = yield* settleBatch(ctx.id)
    yield* ctx.save({
      ...state,
      phase: "settled",
      postedCount: step.postedCount,
      steps: settled.steps,
      lastFailure: null,
    })
  }),
)

/**
 * The settlement handler over `database`. NEITHER hook names a lifetime: the
 * group it is registered in decides (`layerLifetime` on the runtime), which is
 * what lets the same handler run under both lifetimes side by side.
 *
 * A failed hook records what failed in the state and ends normally: the caller
 * reads `lastFailure` instead of a thrown error whose tag would not survive the
 * Durable Object boundary. Only an event that fails before there is any state
 * (a first `Open`) fails its send. A failed alarm also parks the batch as
 * `failed` and does not re-arm.
 */
export const makeSettlementHandler = (database: ReturnType<typeof ledgerDatabaseLayer>) =>
  registry.handler("settlement", {
    onEvent: {
      handler: onEvent,
      onError: (ctx, error) =>
        Effect.gen(function* () {
          const state = yield* ctx.recall()
          // No state to record on (a first `Open` that failed): the caller gets
          // the failure itself, as the cause of the send's `TaskExecutionError`.
          if (state === null) return yield* Effect.fail(error)
          yield* ctx.save({ ...state, lastFailure: recorded("onEvent", error) })
        }),
      provide: database,
    },
    onAlarm: {
      handler: onAlarm,
      onError: (ctx, error) =>
        ctx.update((state) => ({ ...state, phase: "failed", lastFailure: recorded("onAlarm", error) })),
      provide: database,
    },
  })
