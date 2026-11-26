/**
 * What the database-backed checks share: an OBSERVER connection of their own
 * (never one of the pools under test), the counts they assert on, and the
 * batches they open.
 */
import { Duration, Effect, Layer, ManagedRuntime, Redacted, Schema as S } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import { PgClient } from "@effect/sql-pg"
import type { EntryInput } from "@/ledger/repository"

/** The Docker Postgres (`scripts/postgres.mjs`), unless told otherwise. */
export const DATABASE_URL =
  process.env.LEDGER_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:54417/task_example"

/** The observer's pool: one connection, named so no count below ever includes it. */
const ObserverLive = PgClient.layer({
  url: Redacted.make(DATABASE_URL),
  applicationName: "observer",
  maxConnections: 1,
  idleTimeout: Duration.infinity,
  prepare: false,
}).pipe(Layer.orDie)

const observer = ManagedRuntime.make(ObserverLive)

/** Run an effect on the observer's connection; a failure rejects the promise. */
export const observe = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>): Promise<A> =>
  observer.runPromise(effect)

export const closeObserver = (): Promise<void> => observer.dispose()

const Count = S.Struct({ n: S.Int })

const one = <E, R>(rows: Effect.Effect<ReadonlyArray<{ readonly n: number }>, E, R>) =>
  Effect.map(rows, (found) => found[0]?.n ?? 0)

/** Connections Postgres holds open right now for one `application_name`. */
export const connectionsOf = (applicationName: string): Promise<number> =>
  observe(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      return yield* one(
        SqlSchema.findAll({
          Request: S.Struct({ applicationName: S.String }),
          Result: Count,
          execute: (request) => sql`
            SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE application_name = ${request.applicationName}`,
        })({ applicationName }),
      )
    }),
  )

/** Audit rows of a batch whose detail starts with `prefix`. */
export const auditRows = (batchId: string, prefix: string): Promise<number> =>
  observe(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      return yield* one(
        SqlSchema.findAll({
          Request: S.Struct({ batchId: S.String, pattern: S.String }),
          Result: Count,
          execute: (request) => sql`
            SELECT count(*)::int AS n FROM ledger_audit
            WHERE batch_id = ${request.batchId} AND detail LIKE ${request.pattern}`,
        })({ batchId, pattern: `${prefix}%` }),
      )
    }),
  )

/** Entries of a batch in one status. */
export const entriesIn = (batchId: string, status: "pending" | "posted"): Promise<number> =>
  observe(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      return yield* one(
        SqlSchema.findAll({
          Request: S.Struct({ batchId: S.String, status: S.String }),
          Result: Count,
          execute: (request) => sql`
            SELECT count(*)::int AS n FROM ledger_entry
            WHERE batch_id = ${request.batchId} AND status = ${request.status}`,
        })({ batchId, status }),
      )
    }),
  )

/** The summed balance of every account a batch touched. */
export const balanceOf = (batchId: string): Promise<number> =>
  observe(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      return yield* one(
        SqlSchema.findAll({
          Request: S.Struct({ prefix: S.String }),
          Result: Count,
          execute: (request) => sql`
            SELECT coalesce(sum(balance_cents), 0)::int AS n FROM account_balance
            WHERE account LIKE ${request.prefix}`,
        })({ prefix: `${batchId}:%` }),
      )
    }),
  )

/** Empty every ledger table. */
export const emptyLedger = (): Promise<void> =>
  observe(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`TRUNCATE ledger_audit, ledger_entry, account_balance, ledger_batch RESTART IDENTITY CASCADE`
    }),
  )

/**
 * `count` entries for a batch over seven accounts of its own (named after the
 * batch, so no two batches share a balance), with amounts that are never all
 * the same sign. Deterministic: the same batch id always gives the same books.
 */
export const entriesFor = (batchId: string, count: number): [EntryInput, ...Array<EntryInput>] => {
  const entry = (index: number): EntryInput => ({
    account: `${batchId}:acct-${index % 7}`,
    amountCents: ((index * 37) % 501) - 120,
  })
  return [entry(0), ...Array.from({ length: count - 1 }, (_, index) => entry(index + 1))]
}

export const totalOf = (entries: ReadonlyArray<EntryInput>): number =>
  entries.reduce((sum, entry) => sum + entry.amountCents, 0)

/** A batch id no other test (or earlier run) used. */
let sequence = 0
export const batchIdFor = (label: string): string => `${label}-${Date.now().toString(36)}-${++sequence}`

const sleep = (millis: number) => new Promise<void>((resolve) => setTimeout(resolve, millis))

/** Poll `read` until `accept` takes its value, or fail saying what was last seen. */
export const eventually = async <A>(
  description: string,
  read: () => Promise<A>,
  accept: (value: A) => boolean,
  timeoutMillis = 30_000,
): Promise<A> => {
  const deadline = Date.now() + timeoutMillis
  let last = await read()
  while (!accept(last)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${description}; last seen: ${JSON.stringify(last)}`)
    }
    await sleep(100)
    last = await read()
  }
  return last
}

/** Sample `read` every 250 ms for `forMillis` and return everything it saw. */
export const sampled = async <A>(read: () => Promise<A>, forMillis: number): Promise<ReadonlyArray<A>> => {
  const seen: Array<A> = []
  const deadline = Date.now() + forMillis
  while (Date.now() < deadline) {
    seen.push(await read())
    await sleep(250)
  }
  return seen
}
