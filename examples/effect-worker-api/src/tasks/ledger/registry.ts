import { Schema as S } from "effect"
import { Task, TaskRegistry } from "@durable-effect/task"
import { RecordedFailure } from "../../ledger/errors.js"
import { EntryInput, LedgerMode } from "../../ledger/repository.js"

/** The most entries one batch may open, and the most one alarm may post. */
export const MAX_ENTRIES = 2000
export const MAX_CHUNK = 500

/**
 * `settlement` — one instance per batch id. It opens a batch (one transaction,
 * one bulk insert), then posts it a chunk per alarm until nothing is pending,
 * and closes the books. Postgres holds the truth; the task state is the cursor
 * and the last thing that went wrong.
 */
export const Settlement = Task.make("settlement", {
  state: S.Struct({
    batchId: S.String,
    mode: LedgerMode,
    phase: S.Literals(["open", "posting", "settled", "failed"]),
    /** Whether alarms re-arm themselves, or wait to be fired by a caller. */
    autoRun: S.Boolean,
    chunkSize: S.Int,
    entryCount: S.Int,
    postedCount: S.Int,
    totalCents: S.Int,
    /** Alarms that have posted a chunk so far. */
    steps: S.Int,
    /** The last `Verify`'s verdict; null until one ran. */
    verified: S.NullOr(S.Boolean),
    /** The last hook failure; null when the last hook succeeded. */
    lastFailure: S.NullOr(RecordedFailure),
  }),
  event: S.Union([
    S.TaggedStruct("Open", {
      mode: LedgerMode,
      entries: S.NonEmptyArray(EntryInput).check(S.isMaxLength(MAX_ENTRIES)),
      chunkSize: S.Int.check(S.isBetween({ minimum: 1, maximum: MAX_CHUNK })),
      autoRun: S.Boolean,
    }),
    /** Read the books and record whether they add up. */
    S.TaggedStruct("Verify", {}),
    /** Run a transaction that must fail and roll back (the failure drill). */
    S.TaggedStruct("Poison", {}),
    /** Write a last audit row, then purge the instance. */
    S.TaggedStruct("Close", {}),
  ]),
})

/**
 * `audit` — one instance per batch id, one statement per event. Its hook names
 * its OWN layer lifetime, so it behaves the same in both groups.
 */
export const Audit = Task.make("audit", {
  state: S.Struct({ batchId: S.String, notes: S.Int }),
  event: S.TaggedStruct("Note", { detail: S.NonEmptyString }),
})

export const registry = TaskRegistry.make(Settlement, Audit)
