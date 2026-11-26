/**
 * The ledger task group, TWICE: the same registry and the same handlers under
 * each layer lifetime, as two Durable Object classes.
 *
 *   LedgerInstanceDO     the library's default: a hook's layers are built once
 *                        per task instance and kept, so the Postgres pool a hook
 *                        opened stays open after the hook returns.
 *   LedgerInvocationDO   `layerLifetime: "invocation"`: a hook's layers are built
 *                        for each event / alarm and released when it ends, so
 *                        nothing is left open.
 *
 * Each pool carries its group's name as its Postgres `application_name`
 * (`ledger-instance`, `ledger-invocation`, and `…-audit` for the audit task's
 * own pool), which is how the integration tests watch them from the outside.
 */
import { Layer } from "effect"
import { makeInMemoryRuntime } from "@durable-effect/task"
import type { LayerLifetime } from "@durable-effect/task"
import { makeTaskGroupDO } from "@durable-effect/task/cloudflare"
import { LedgerEnv, ledgerDatabaseLayer } from "../../ledger/database.js"
import type { LedgerMode } from "../../ledger/repository.js"
import { makeAuditHandler } from "./handlers/audit.js"
import { makeSettlementHandler } from "./handlers/settlement.js"
import { registry } from "./registry.js"

export { Audit, Settlement } from "./registry.js"

/** The layer lifetime each group runs its hooks under. */
export const lifetimeOf = (mode: LedgerMode): LayerLifetime => mode

/** The Postgres `application_name` of a group's settlement pool. */
export const poolNameOf = (mode: LedgerMode): string => `ledger-${mode}`
/** The Postgres `application_name` of a group's audit pool. */
export const auditPoolNameOf = (mode: LedgerMode): string => `ledger-${mode}-audit`

const buildGroup = (mode: LedgerMode) =>
  registry.build({
    settlement: makeSettlementHandler(ledgerDatabaseLayer(poolNameOf(mode))),
    audit: makeAuditHandler(ledgerDatabaseLayer(auditPoolNameOf(mode))),
  })

const instanceGroup = makeTaskGroupDO(buildGroup("instance"), {
  env: LedgerEnv,
  namespace: (env: Env) => env.LEDGER_INSTANCE_DO,
  layerLifetime: lifetimeOf("instance"),
})

const invocationGroup = makeTaskGroupDO(buildGroup("invocation"), {
  env: LedgerEnv,
  namespace: (env: Env) => env.LEDGER_INVOCATION_DO,
  layerLifetime: lifetimeOf("invocation"),
})

export const LedgerInstanceDO = instanceGroup.DO
export const LedgerInvocationDO = invocationGroup.DO

/** The typed client of a mode's group, over that mode's namespace binding. */
export const ledgerClient = (mode: LedgerMode, env: Env) => {
  switch (mode) {
    case "instance":
      return instanceGroup.client(env.LEDGER_INSTANCE_DO)
    case "invocation":
      return invocationGroup.client(env.LEDGER_INVOCATION_DO)
  }
}

/**
 * The same group in memory, over a real Postgres: what the integration tests
 * drive without a Worker. One runtime per call, so each test owns its instances.
 */
export const makeLedgerRuntime = (mode: LedgerMode, connectionString: string) =>
  makeInMemoryRuntime(buildGroup(mode), {
    services: Layer.succeed(LedgerEnv, { HYPERDRIVE: { connectionString } }),
    layerLifetime: lifetimeOf(mode),
  })
