import { Effect } from "effect"
import type { ledgerDatabaseLayer } from "../../../ledger/database.js"
import { recordAudit } from "../../../ledger/repository.js"
import { registry } from "../registry.js"

/**
 * The audit handler over `database`. Its event hook names its OWN lifetime,
 * `"invocation"`, which wins over whatever the group's default is: the pool it
 * opens to write one row is closed before the event returns, in both groups.
 */
export const makeAuditHandler = (database: ReturnType<typeof ledgerDatabaseLayer>) =>
  registry.handler("audit", {
    onEvent: {
      handler: (ctx, event) =>
        Effect.gen(function* () {
          yield* recordAudit({ batchId: ctx.id, hook: "audit", detail: event.detail })
          const state = yield* ctx.recall()
          yield* ctx.save({ batchId: ctx.id, notes: (state?.notes ?? 0) + 1 })
        }),
      provide: database,
      lifetime: "invocation",
    },
    onAlarm: () => Effect.void,
  })
