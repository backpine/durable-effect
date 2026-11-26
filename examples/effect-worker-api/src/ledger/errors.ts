/**
 * Every way the ledger can fail, as a tagged error with its own fields. Each one
 * is a Schema class, so the same value is a typed failure inside a task, a
 * documented response of the HTTP API (with its status), and a decoded error in
 * the typed client the integration tests use.
 */
import { Schema as S } from "effect"

/** The names Postgres failures are sorted into (`SqlError`'s own reason tags). */
export const DatabaseFailureReason = S.Literals([
  "ConnectionError",
  "AuthenticationError",
  "AuthorizationError",
  "SqlSyntaxError",
  "UniqueViolation",
  "ConstraintError",
  "DeadlockError",
  "SerializationError",
  "LockTimeoutError",
  "StatementTimeoutError",
  "UnknownError",
])
export type DatabaseFailureReason = typeof DatabaseFailureReason.Type

/** Postgres refused or could not run a statement. `operation` names which one. */
export class LedgerDatabaseError extends S.TaggedError<LedgerDatabaseError>()(
  "LedgerDatabaseError",
  {
    operation: S.String,
    reason: DatabaseFailureReason,
    retryable: S.Boolean,
    message: S.String,
  },
  { httpApiStatus: 503 },
) {}

/** A row came back in a shape the code does not accept. Never a silent `any`. */
export class LedgerRowInvalid extends S.TaggedError<LedgerRowInvalid>()(
  "LedgerRowInvalid",
  { operation: S.String, message: S.String },
  { httpApiStatus: 500 },
) {}

/** A batch with this id was opened before. */
export class BatchAlreadyOpen extends S.TaggedError<BatchAlreadyOpen>()(
  "BatchAlreadyOpen",
  { batchId: S.String, message: S.String },
  { httpApiStatus: 409 },
) {}

/** No batch has this id. */
export class BatchNotFound extends S.TaggedError<BatchNotFound>()(
  "BatchNotFound",
  { batchId: S.String, message: S.String },
  { httpApiStatus: 404 },
) {}

/** The books do not add up: what was posted is not what was opened. */
export class LedgerInvariantBroken extends S.TaggedError<LedgerInvariantBroken>()(
  "LedgerInvariantBroken",
  { batchId: S.String, invariant: S.String, message: S.String },
  { httpApiStatus: 500 },
) {}

/** The API could not reach the task (the Durable Object call itself failed). */
export class TaskDispatchFailed extends S.TaggedError<TaskDispatchFailed>()(
  "TaskDispatchFailed",
  { task: S.String, action: S.String, message: S.String },
  { httpApiStatus: 502 },
) {}

/** What a task hook records in its state when it fails: enough to act on. */
export const RecordedFailure = S.Struct({
  hook: S.Literals(["onEvent", "onAlarm"]),
  tag: S.String,
  message: S.String,
})
export type RecordedFailure = typeof RecordedFailure.Type
