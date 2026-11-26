/**
 * The ledger's statements. Every function needs only a `SqlClient`, takes a
 * typed request, and answers with rows DECODED through a Schema: a row in a
 * shape the code does not expect is a `LedgerRowInvalid`, never a wrong value
 * carried on. Every Postgres failure is a `LedgerDatabaseError` naming the
 * operation and Postgres's own reason.
 *
 * The writes that belong together run in one transaction, and each writes its
 * audit row inside it, so a hook that rolled back leaves nothing behind.
 */
import { Effect, Option, Schema as S } from "effect"
import { SqlClient, SqlError, SqlSchema } from "effect/sql"
import {
  BatchAlreadyOpen,
  BatchNotFound,
  LedgerDatabaseError,
  LedgerInvariantBroken,
  LedgerRowInvalid,
} from "./errors.js"

// ── Shapes ───────────────────────────────────────────────────────────────────

export const LedgerMode = S.Literals(["instance", "invocation"])
export type LedgerMode = typeof LedgerMode.Type

/** One line of a batch: an account and a signed amount in whole cents. */
export const EntryInput = S.Struct({
  account: S.NonEmptyString,
  amountCents: S.Int,
})
export type EntryInput = typeof EntryInput.Type

export const BatchRow = S.Struct({
  batchId: S.String,
  mode: LedgerMode,
  status: S.Literals(["open", "settled"]),
  entryCount: S.Int,
  postedCount: S.Int,
  totalCents: S.Int,
  steps: S.Int,
})
export type BatchRow = typeof BatchRow.Type

const PostedRow = S.Struct({ account: S.String, amountCents: S.Int })

/** What the books say about one batch, read in one pass. */
export const BatchAudit = S.Struct({
  pendingEntries: S.Int,
  postedEntries: S.Int,
  postedCents: S.Int,
  entriesCents: S.Int,
  balanceCents: S.Int,
  balancePostings: S.Int,
  auditRows: S.Int,
})
export type BatchAudit = typeof BatchAudit.Type

export const ConnectionCount = S.Struct({ applicationName: S.String, connections: S.Int })
export type ConnectionCount = typeof ConnectionCount.Type

const BatchKey = S.Struct({ batchId: S.String })

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * Name the operation on whatever Postgres or a row's shape did wrong; every
 * other failure passes through as it is. The two `catchIf`s take a refinement,
 * so each REMOVES its error from the type as it replaces it.
 */
const failingAs =
  (operation: string) =>
  <A, E, R>(self: Effect.Effect<A, E | SqlError.SqlError | S.SchemaError, R>) =>
    self.pipe(
      Effect.catchIf(SqlError.isSqlError, (error) =>
        Effect.fail(
          new LedgerDatabaseError({
            operation,
            reason: error.reason._tag,
            retryable: error.isRetryable,
            message: error.message,
          }),
        ),
      ),
      Effect.catchIf(S.isSchemaError, (error) =>
        Effect.fail(new LedgerRowInvalid({ operation, message: error.message })),
      ),
    )

// ── Reads ────────────────────────────────────────────────────────────────────

const selectBatch = (sql: SqlClient.SqlClient) =>
  SqlSchema.findOneOption({
    Request: BatchKey,
    Result: BatchRow,
    execute: ({ batchId }) => sql`
      SELECT batch_id AS "batchId", mode, status,
             entry_count AS "entryCount", posted_count AS "postedCount",
             total_cents AS "totalCents", steps
      FROM ledger_batch WHERE batch_id = ${batchId}`,
  })

/** The batch, or `None` when no batch has this id. */
export const findBatch = (batchId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* selectBatch(sql)({ batchId })
  }).pipe(failingAs("findBatch"))

/** The batch, or a `BatchNotFound`. */
export const getBatch = (batchId: string) =>
  findBatch(batchId).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new BatchNotFound({ batchId, message: `No batch "${batchId}"` })),
        onSome: (batch) => Effect.succeed(batch),
      }),
    ),
  )

const selectAudit = (sql: SqlClient.SqlClient) =>
  SqlSchema.findOne({
    Request: BatchKey,
    Result: BatchAudit,
    execute: ({ batchId }) => sql`
      SELECT
        (SELECT count(*)::int FROM ledger_entry WHERE batch_id = ${batchId} AND status = 'pending') AS "pendingEntries",
        (SELECT count(*)::int FROM ledger_entry WHERE batch_id = ${batchId} AND status = 'posted') AS "postedEntries",
        (SELECT coalesce(sum(amount_cents), 0)::int FROM ledger_entry WHERE batch_id = ${batchId} AND status = 'posted') AS "postedCents",
        (SELECT coalesce(sum(amount_cents), 0)::int FROM ledger_entry WHERE batch_id = ${batchId}) AS "entriesCents",
        (SELECT coalesce(sum(balance_cents), 0)::int FROM account_balance
          WHERE account IN (SELECT DISTINCT account FROM ledger_entry WHERE batch_id = ${batchId})) AS "balanceCents",
        (SELECT coalesce(sum(postings), 0)::int FROM account_balance
          WHERE account IN (SELECT DISTINCT account FROM ledger_entry WHERE batch_id = ${batchId})) AS "balancePostings",
        (SELECT count(*)::int FROM ledger_audit WHERE batch_id = ${batchId}) AS "auditRows"`,
  })

/** What the books say about one batch. */
export const auditBatch = (batchId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* selectAudit(sql)({ batchId })
  }).pipe(
    // The statement always answers one row; none would be Postgres misbehaving.
    Effect.catchTag("NoSuchElementError", () =>
      Effect.fail(new LedgerRowInvalid({ operation: "auditBatch", message: "the audit query returned no row" })),
    ),
    failingAs("auditBatch"),
  )

/**
 * Open connections per `application_name`, for the names this example gives its
 * pools (`ledger-…`). This is how a test SEES whether a pool was released.
 */
export const countConnections = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return yield* SqlSchema.findAll({
    Request: S.Struct({ prefix: S.String }),
    Result: ConnectionCount,
    execute: ({ prefix }) => sql`
      SELECT application_name AS "applicationName", count(*)::int AS connections
      FROM pg_stat_activity
      WHERE application_name LIKE ${`${prefix}%`} AND pid <> pg_backend_pid()
      GROUP BY application_name ORDER BY application_name`,
  })({ prefix: "ledger-" })
}).pipe(failingAs("countConnections"))

// ── Writes ───────────────────────────────────────────────────────────────────

const writeAudit = (sql: SqlClient.SqlClient, batchId: string, hook: string, detail: string) =>
  sql`INSERT INTO ledger_audit ${sql.insert({ batch_id: batchId, hook, detail })}`.pipe(Effect.asVoid)

/** One audit row by itself (the `audit` task's whole job). */
export const recordAudit = (input: { readonly batchId: string; readonly hook: string; readonly detail: string }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* writeAudit(sql, input.batchId, input.hook, input.detail)
  }).pipe(failingAs("recordAudit"))

/**
 * Open a batch: the batch row, every entry in one bulk insert, and the audit
 * row, in ONE transaction. A second open of the same id is a `BatchAlreadyOpen`
 * and writes nothing.
 */
export const openBatch = (input: {
  readonly batchId: string
  readonly mode: LedgerMode
  readonly entries: ReadonlyArray<EntryInput>
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const totalCents = input.entries.reduce((sum, entry) => sum + entry.amountCents, 0)
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const inserted = yield* SqlSchema.findAll({
          Request: S.Struct({ batchId: S.String, mode: LedgerMode, entryCount: S.Int, totalCents: S.Int }),
          Result: BatchKey,
          execute: (row) => sql`
            INSERT INTO ledger_batch ${sql.insert({
              batch_id: row.batchId,
              mode: row.mode,
              status: "open",
              entry_count: row.entryCount,
              total_cents: row.totalCents,
            })}
            ON CONFLICT (batch_id) DO NOTHING
            RETURNING batch_id AS "batchId"`,
        })({ batchId: input.batchId, mode: input.mode, entryCount: input.entries.length, totalCents })
        if (inserted.length === 0) {
          return yield* Effect.fail(
            new BatchAlreadyOpen({ batchId: input.batchId, message: `Batch "${input.batchId}" is already open` }),
          )
        }
        yield* sql`INSERT INTO ledger_entry ${sql.insert(
          input.entries.map((entry, index) => ({
            batch_id: input.batchId,
            seq: index + 1,
            account: entry.account,
            amount_cents: entry.amountCents,
          })),
        )}`
        yield* writeAudit(sql, input.batchId, "onEvent", `opened ${input.entries.length} entries`)
        return { entryCount: input.entries.length, totalCents }
      }),
    )
  }).pipe(failingAs("openBatch"))

/**
 * Post the next `limit` pending entries of a batch, in ONE transaction: mark
 * them posted (row-locked, in order), add them to their accounts' balances in
 * one upsert, move the batch's counters, write the audit row. Answers how many
 * were posted and how many are left.
 */
export const postChunk = (input: { readonly batchId: string; readonly limit: number }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const posted = yield* SqlSchema.findAll({
          Request: S.Struct({ batchId: S.String, limit: S.Int }),
          Result: PostedRow,
          // The pick is a MATERIALIZED CTE on purpose. Written as
          // `seq IN (SELECT … LIMIT n FOR UPDATE)`, Postgres may run the subquery
          // again for each row it considers, and post far more than `limit`.
          execute: ({ batchId, limit }) => sql`
            WITH picked AS MATERIALIZED (
              SELECT seq FROM ledger_entry
              WHERE batch_id = ${batchId} AND status = 'pending'
              ORDER BY seq LIMIT ${limit} FOR UPDATE
            )
            UPDATE ledger_entry AS entry SET status = 'posted'
            FROM picked
            WHERE entry.batch_id = ${batchId} AND entry.seq = picked.seq
            RETURNING entry.account, entry.amount_cents AS "amountCents"`,
        })(input)

        const byAccount = new Map<string, { cents: number; postings: number }>()
        for (const row of posted) {
          const held = byAccount.get(row.account) ?? { cents: 0, postings: 0 }
          byAccount.set(row.account, { cents: held.cents + row.amountCents, postings: held.postings + 1 })
        }
        if (byAccount.size > 0) {
          yield* sql`
            INSERT INTO account_balance ${sql.insert(
              Array.from(byAccount, ([account, sum]) => ({
                account,
                balance_cents: sum.cents,
                postings: sum.postings,
              })),
            )}
            ON CONFLICT (account) DO UPDATE SET
              balance_cents = account_balance.balance_cents + EXCLUDED.balance_cents,
              postings = account_balance.postings + EXCLUDED.postings`
        }

        const counters = yield* SqlSchema.findOne({
          Request: S.Struct({ batchId: S.String, posted: S.Int }),
          Result: S.Struct({ postedCount: S.Int, entryCount: S.Int, steps: S.Int }),
          execute: ({ batchId, posted: count }) => sql`
            UPDATE ledger_batch
            SET posted_count = posted_count + ${count}, steps = steps + 1
            WHERE batch_id = ${batchId}
            RETURNING posted_count AS "postedCount", entry_count AS "entryCount", steps`,
        })({ batchId: input.batchId, posted: posted.length })

        yield* writeAudit(sql, input.batchId, "onAlarm", `posted ${posted.length}, step ${counters.steps}`)
        return {
          posted: posted.length,
          postedCount: counters.postedCount,
          remaining: counters.entryCount - counters.postedCount,
          steps: counters.steps,
        }
      }),
    )
  }).pipe(
    Effect.catchTag("NoSuchElementError", () =>
      Effect.fail(new BatchNotFound({ batchId: input.batchId, message: `No batch "${input.batchId}"` })),
    ),
    failingAs("postChunk"),
  )

/**
 * Close the books on a batch whose entries are all posted: check that what was
 * posted is what was opened, then mark it settled. A batch that does not add up
 * is a `LedgerInvariantBroken`, and is left open.
 */
export const settleBatch = (batchId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const batch = yield* getBatch(batchId)
        const books = yield* auditBatch(batchId)
        const broken = (invariant: string, message: string) =>
          Effect.fail(new LedgerInvariantBroken({ batchId, invariant, message }))
        if (books.pendingEntries !== 0) {
          return yield* broken("all_posted", `${books.pendingEntries} entries are still pending`)
        }
        if (books.postedEntries !== batch.entryCount || batch.postedCount !== batch.entryCount) {
          return yield* broken("posted_count", `posted ${books.postedEntries} of ${batch.entryCount}`)
        }
        if (books.postedCents !== batch.totalCents) {
          return yield* broken("total_cents", `posted ${books.postedCents} cents, opened ${batch.totalCents}`)
        }
        yield* sql`UPDATE ledger_batch SET status = 'settled', settled_at = now() WHERE batch_id = ${batchId}`
        yield* writeAudit(sql, batchId, "onAlarm", `settled ${batch.totalCents} cents in ${batch.steps} steps`)
        return { totalCents: batch.totalCents, steps: batch.steps }
      }),
    )
  }).pipe(failingAs("settleBatch"))

/**
 * A transaction that MUST fail, for the failure drill: it writes an audit row,
 * then inserts an entry whose key already exists. Postgres answers with a unique
 * violation and the audit row is rolled back with it.
 */
export const poisonBatch = (batchId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* writeAudit(sql, batchId, "onEvent", "poison: this row must never be committed")
        yield* sql`INSERT INTO ledger_entry ${sql.insert({
          batch_id: batchId,
          seq: 1,
          account: "poison",
          amount_cents: 1,
        })}`
      }),
    )
  }).pipe(failingAs("poisonBatch"))
