/**
 * The ledger's HTTP surface. Every input and output is a Schema, and every
 * failure an endpoint can answer with is listed on it by its tagged error, so
 * the OpenAPI document, the server and the typed client all agree on them.
 *
 * `:mode` picks the task group: `instance` or `invocation` (the layer lifetime
 * its hooks run under). The two groups share every table.
 */
import { Schema as S } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Audit, Settlement } from "../tasks/ledger/registry.js"
import { MAX_CHUNK, MAX_ENTRIES } from "../tasks/ledger/registry.js"
import {
  BatchAlreadyOpen,
  BatchNotFound,
  LedgerDatabaseError,
  LedgerRowInvalid,
  TaskDispatchFailed,
} from "./errors.js"
import { BatchAudit, BatchRow, ConnectionCount, EntryInput, LedgerMode } from "./repository.js"

const BatchId = S.NonEmptyString.check(S.isMaxLength(120))

/** A batch as Postgres holds it, beside the task instance's own state. */
export const BatchView = S.Struct({
  mode: LedgerMode,
  /** The settlement task's state; null once the instance is purged. */
  task: S.NullOr(Settlement.state),
  batch: BatchRow,
  books: BatchAudit,
})
export type BatchView = typeof BatchView.Type

export const OpenBatchPayload = S.Struct({
  batchId: BatchId,
  entries: S.NonEmptyArray(EntryInput).check(S.isMaxLength(MAX_ENTRIES)),
  chunkSize: S.Int.check(S.isBetween({ minimum: 1, maximum: MAX_CHUNK })),
  /** True: alarms run the batch to the end. False: each step waits for `/step`. */
  autoRun: S.Boolean,
})

export const AuditNoteResponse = S.Struct({ batchId: S.String, audit: Audit.state })

export const ConnectionsResponse = S.Struct({ pools: S.Array(ConnectionCount) })

const ModeParams = S.Struct({ mode: LedgerMode })
const BatchParams = S.Struct({ mode: LedgerMode, batchId: BatchId })

/**
 * The errors of an endpoint that reads Postgres and calls a task, plus its own.
 * A function (not a shared array) so each endpoint's list is inferred exactly.
 */
const taskErrors = <const Own extends ReadonlyArray<S.Top>>(...own: Own) =>
  [LedgerDatabaseError, LedgerRowInvalid, TaskDispatchFailed, ...own]

export const LedgerGroup = HttpApiGroup.make("ledger")
  .add(
    HttpApiEndpoint.get("connections", "/connections", {
      success: ConnectionsResponse,
      error: [LedgerDatabaseError, LedgerRowInvalid],
    }),
  )
  .add(
    HttpApiEndpoint.post("open", "/:mode/batches", {
      params: ModeParams,
      payload: OpenBatchPayload,
      success: BatchView,
      error: taskErrors(BatchAlreadyOpen, BatchNotFound),
    }),
  )
  .add(
    HttpApiEndpoint.get("view", "/:mode/batches/:batchId", {
      params: BatchParams,
      success: BatchView,
      error: taskErrors(BatchNotFound),
    }),
  )
  .add(
    HttpApiEndpoint.post("step", "/:mode/batches/:batchId/step", {
      params: BatchParams,
      success: BatchView,
      error: taskErrors(BatchNotFound),
    }),
  )
  .add(
    HttpApiEndpoint.post("verify", "/:mode/batches/:batchId/verify", {
      params: BatchParams,
      success: BatchView,
      error: taskErrors(BatchNotFound),
    }),
  )
  .add(
    HttpApiEndpoint.post("poison", "/:mode/batches/:batchId/poison", {
      params: BatchParams,
      success: BatchView,
      error: taskErrors(BatchNotFound),
    }),
  )
  .add(
    HttpApiEndpoint.post("close", "/:mode/batches/:batchId/close", {
      params: BatchParams,
      success: BatchView,
      error: taskErrors(BatchNotFound),
    }),
  )
  .add(
    HttpApiEndpoint.post("note", "/:mode/batches/:batchId/notes", {
      params: BatchParams,
      payload: S.Struct({ detail: S.NonEmptyString }),
      success: AuditNoteResponse,
      error: taskErrors(BatchNotFound),
    }),
  )
  .prefix("/ledger")
