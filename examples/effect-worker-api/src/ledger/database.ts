/**
 * The ledger's Postgres pool, as a layer.
 *
 * `idleTimeout` is infinite ON PURPOSE: the pool never gives a connection back
 * on its own, so the only thing that closes one is the scope the layer was
 * built in. That makes the layer's lifetime visible from the outside. Under the
 * task library's "instance" lifetime the connection stays open for as long as
 * the task instance lives; under "invocation" it is gone the moment the hook
 * returns. `application_name` is how a test tells the pools apart in
 * `pg_stat_activity`.
 */
import { Context, Duration, Effect, Layer, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import { LedgerDatabaseError } from "./errors.js"

/** The one binding the ledger tasks read: a Hyperdrive-shaped connection string. */
export class LedgerEnv extends Context.Service<
  LedgerEnv,
  { readonly HYPERDRIVE: { readonly connectionString: string } }
>()("@app/LedgerEnv") {}

/** A pool on `connectionString`, named `applicationName`. Fails with a tagged error. */
export const poolLayer = (input: { readonly connectionString: string; readonly applicationName: string }) =>
  PgClient.layerFrom(
    PgClient.make({
      url: Redacted.make(input.connectionString),
      applicationName: input.applicationName,
      idleTimeout: Duration.infinity,
      maxConnections: 4,
      prepare: false,
    }).pipe(
      Effect.mapError(
        (error) =>
          new LedgerDatabaseError({
            operation: "connect",
            reason: error.reason._tag,
            retryable: error.isRetryable,
            message: error.message,
          }),
      ),
    ),
  )

/**
 * The pool for a task hook's `provide`. A hook layer cannot fail, so a pool that
 * cannot be opened is a defect, carrying the same tagged `LedgerDatabaseError`
 * (`operation: "connect"`) a caller would otherwise have matched on.
 */
export const ledgerDatabaseLayer = (applicationName: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const env = yield* LedgerEnv
      return Layer.orDie(poolLayer({ connectionString: env.HYPERDRIVE.connectionString, applicationName }))
    }),
  )
