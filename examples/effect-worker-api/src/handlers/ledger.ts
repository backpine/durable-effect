import { Effect, Option } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import type { TaskExecutionError, TaskValidationError } from "@durable-effect/task"
import { CloudflareBindings, WorkerApi } from "@/api"
import type { BatchView } from "@/ledger/api"
import { poolLayer } from "@/ledger/database"
import { BatchAlreadyOpen, TaskDispatchFailed } from "@/ledger/errors"
import { auditBatch, countConnections, findBatch, getBatch } from "@/ledger/repository"
import type { LedgerMode } from "@/ledger/repository"
import { ledgerClient } from "@/tasks/ledger/index"

/** The API's own pool name: never one the tests watch for task hooks. */
const API_POOL = "ledger-api"

/**
 * Run a request's reads on a pool that lives exactly as long as the request:
 * `Effect.provide` builds it in a scope that closes when `effect` ends.
 */
const withDatabase = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const { env } = yield* CloudflareBindings
    return yield* effect.pipe(
      Effect.provide(poolLayer({ connectionString: env.HYPERDRIVE.connectionString, applicationName: API_POOL })),
    )
  })

/** Name the task and the call on a Durable Object call that failed. */
const dispatched =
  (task: string, action: string) =>
  <A>(call: Effect.Effect<A, TaskValidationError | TaskExecutionError>) =>
    call.pipe(
      Effect.mapError((error) => {
        switch (error._tag) {
          case "TaskValidationError":
            return new TaskDispatchFailed({ task, action, message: error.message })
          case "TaskExecutionError":
            return new TaskDispatchFailed({ task, action, message: String(error.cause) })
        }
      }),
    )

/** The batch as Postgres holds it, beside its task's state. 404 when there is none. */
const viewBatch = (mode: LedgerMode, batchId: string) =>
  Effect.gen(function* () {
    const { env } = yield* CloudflareBindings
    const batch = yield* getBatch(batchId)
    const books = yield* auditBatch(batchId)
    const task = yield* ledgerClient(mode, env)
      .task("settlement")
      .getState(batchId)
      .pipe(dispatched("settlement", "getState"))
    return { mode, task, batch, books } satisfies BatchView
  })

export const LedgerGroupLive = HttpApiBuilder.group(WorkerApi, "ledger", (handlers) =>
  handlers
    .handle("connections", () =>
      withDatabase(Effect.map(countConnections, (pools) => ({ pools }))),
    )
    .handle("open", ({ params, payload }) =>
      withDatabase(
        Effect.gen(function* () {
          const { env } = yield* CloudflareBindings
          const existing = yield* findBatch(payload.batchId)
          if (Option.isSome(existing)) {
            return yield* Effect.fail(
              new BatchAlreadyOpen({
                batchId: payload.batchId,
                message: `Batch "${payload.batchId}" is already open`,
              }),
            )
          }
          yield* ledgerClient(params.mode, env)
            .task("settlement")
            .send(payload.batchId, {
              _tag: "Open",
              mode: params.mode,
              entries: payload.entries,
              chunkSize: payload.chunkSize,
              autoRun: payload.autoRun,
            })
            .pipe(dispatched("settlement", "Open"))
          return yield* viewBatch(params.mode, payload.batchId)
        }),
      ),
    )
    .handle("view", ({ params }) => withDatabase(viewBatch(params.mode, params.batchId)))
    .handle("step", ({ params }) =>
      withDatabase(
        Effect.gen(function* () {
          const { env } = yield* CloudflareBindings
          yield* getBatch(params.batchId)
          yield* ledgerClient(params.mode, env)
            .task("settlement")
            .fireAlarm(params.batchId)
            .pipe(dispatched("settlement", "fireAlarm"))
          return yield* viewBatch(params.mode, params.batchId)
        }),
      ),
    )
    .handle("verify", ({ params }) =>
      withDatabase(
        Effect.gen(function* () {
          const { env } = yield* CloudflareBindings
          yield* getBatch(params.batchId)
          yield* ledgerClient(params.mode, env)
            .task("settlement")
            .send(params.batchId, { _tag: "Verify" })
            .pipe(dispatched("settlement", "Verify"))
          return yield* viewBatch(params.mode, params.batchId)
        }),
      ),
    )
    .handle("poison", ({ params }) =>
      withDatabase(
        Effect.gen(function* () {
          const { env } = yield* CloudflareBindings
          yield* getBatch(params.batchId)
          yield* ledgerClient(params.mode, env)
            .task("settlement")
            .send(params.batchId, { _tag: "Poison" })
            .pipe(dispatched("settlement", "Poison"))
          return yield* viewBatch(params.mode, params.batchId)
        }),
      ),
    )
    .handle("close", ({ params }) =>
      withDatabase(
        Effect.gen(function* () {
          const { env } = yield* CloudflareBindings
          yield* getBatch(params.batchId)
          yield* ledgerClient(params.mode, env)
            .task("settlement")
            .send(params.batchId, { _tag: "Close" })
            .pipe(dispatched("settlement", "Close"))
          return yield* viewBatch(params.mode, params.batchId)
        }),
      ),
    )
    .handle("note", ({ params, payload }) =>
      withDatabase(
        Effect.gen(function* () {
          const { env } = yield* CloudflareBindings
          yield* getBatch(params.batchId)
          const audit = ledgerClient(params.mode, env).task("audit")
          yield* audit.send(params.batchId, { _tag: "Note", detail: payload.detail }).pipe(dispatched("audit", "Note"))
          const state = yield* audit.getState(params.batchId).pipe(dispatched("audit", "getState"))
          if (state === null) {
            return yield* Effect.fail(
              new TaskDispatchFailed({ task: "audit", action: "getState", message: "the audit task kept no state" }),
            )
          }
          return { batchId: params.batchId, audit: state }
        }),
      ),
    ),
)
