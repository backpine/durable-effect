# Task-group Worker example

Uses Effect **4.0.5** and `@durable-effect/task` from `packages/task-group`.
The other examples and packages use Effect v3 and are independent of this app.

From the repository root:

```sh
pnpm install
pnpm --filter @durable-effect/task build
pnpm --filter effect-worker-api dev
```

Wrangler runs locally with SQLite Durable Objects for counter, billing, and
onboarding. Alarms fire automatically. Each task instance has its own persistent
state. Billing and onboarding dispatch to sibling tasks through Durable Object
RPC. Hook services build lazily and reuse their instance's layer memo map.
The ledger tasks (below) also use Postgres, and are the only part that needs it.

```sh
curl http://localhost:8787/api/health/
curl http://localhost:8787/api/counter/start/demo
curl http://localhost:8787/api/counter/status/demo
curl -X POST http://localhost:8787/api/billing/create \
  -H 'content-type: application/json' \
  -d '{"userId":"demo","amount":42}'
curl -X POST http://localhost:8787/api/onboarding/start \
  -H 'content-type: application/json' \
  -d '{"userId":"demo","email":"demo@example.com"}'
curl http://localhost:8787/api/onboarding/status/demo
```

Use the invoice ID returned by `/api/billing/create` with
`/api/billing/status/:invoiceId`. Billing finalizes after five seconds;
onboarding completes after ten seconds. The counter increments every two
seconds and purges itself after ten increments. Explicit alarm endpoints are
`POST /api/billing/finalize/:invoiceId` and
`POST /api/onboarding/complete/:userId`. OpenAPI is at `/api/openapi.json`.

Run the complete local package-consumer check:

```sh
pnpm --filter @durable-effect/task typecheck
pnpm --filter @durable-effect/task test
pnpm --filter effect-worker-api test:local
```

`test:local` builds and packs the library, copies this app to a temporary
directory outside the workspace, and installs the tarball alongside the exact
Effect and tooling versions installed in this checkout. It typechecks the app
and tests, runs the in-memory tests, builds the Worker, and starts local Wrangler
on an available port. HTTP assertions cover every endpoint, schema validation,
instance isolation, sibling dispatch and state reads, automatic and manual
alarms, optional state fields, persistence after restart,
repeated scheduling, and purge cancellation. It stops Wrangler and removes the
temporary directory when finished. No Cloudflare account is needed.

Workerd does not resume locally scheduled alarms after a process restart
([upstream issue](https://github.com/cloudflare/workerd/issues/3566)). The HTTP
check verifies automatic alarms before restarting, then verifies stored state.
The library's Cloudflare tests separately reconstruct a Durable Object and call
its persisted alarm lifecycle to verify cold sibling RPC and service provision.

## The ledger tasks: Postgres, and the two layer lifetimes

`src/tasks/ledger` is a database-heavy task group registered TWICE, as two
Durable Object classes that share every handler and every table:

| Group | `layerLifetime` | What its hooks leave behind |
|---|---|---|
| `LedgerInstanceDO` (`/api/ledger/instance/…`) | `"instance"` (the library's default) | the Postgres pool a hook opened stays connected after the hook returns |
| `LedgerInvocationDO` (`/api/ledger/invocation/…`) | `"invocation"` | nothing: the pool is closed before the event or alarm returns |

The `settlement` task opens a batch (one transaction, one bulk insert), posts it
a chunk per alarm (row locks, a balance upsert, counters and an audit row in one
transaction), then closes the books. It also has a failure drill (`poison`: a
transaction that must roll back) and a purge (`close`). The `audit` task names
its own `lifetime: "invocation"`, which wins over its group's default.

Everything is typed end to end: task state and events, every row read back from
Postgres (decoded through a Schema), every API payload and response, and every
failure, as a tagged error with its HTTP status (`BatchNotFound` 404,
`BatchAlreadyOpen` 409, `TaskDispatchFailed` 502, `LedgerDatabaseError` 503, …;
see `src/ledger/errors.ts`).

Each pool carries its group's name as its Postgres `application_name`, so you can
watch the difference yourself:

```sh
pnpm --filter effect-worker-api db:up      # Postgres in Docker, schema applied
pnpm --filter effect-worker-api dev        # in another terminal

for mode in instance invocation; do
  curl -X POST "http://localhost:8787/api/ledger/$mode/batches" \
    -H 'content-type: application/json' \
    -d '{"batchId":"demo-'$mode'","chunkSize":2,"autoRun":true,
         "entries":[{"account":"a","amountCents":100},{"account":"b","amountCents":-40},{"account":"a","amountCents":7}]}'
done
sleep 3
curl http://localhost:8787/api/ledger/invocation/batches/demo-invocation   # settled
curl http://localhost:8787/api/ledger/connections
# {"pools":[{"applicationName":"ledger-instance","connections":1}]}
#   the instance group still holds its pool; the invocation group holds none

pnpm --filter effect-worker-api db:down
```

The whole comparison is automated, against the packed library:

```sh
pnpm --filter effect-worker-api test:db
```

`test:db` starts Postgres in Docker, builds and packs `@durable-effect/task`,
installs the tarball into a copy of this app outside the workspace, typechecks
it, then runs `test/integration` twice over: on the in-memory runtime, and
through a Worker under local Wrangler (real Durable Objects and alarms, Postgres
through the Hyperdrive binding, the API's own typed client). The checks count
connections in `pg_stat_activity`: under `"invocation"` none is open once any
hook has returned, after a success, a rolled-back failure or a purge; under
`"instance"` each task instance still holds its pool twenty seconds after its
last alarm. It needs Docker and nothing else. Add `--keep-database` to keep
Postgres up afterwards.

After editing Wrangler bindings, regenerate the checked-in runtime types:

```sh
pnpm --filter effect-worker-api cf-typegen
```

Effect v4 stable removed the `unstable` import segment and renamed `httpapi` to
`http-api`; this app now imports `effect/http` and `effect/http-api`. Schema error
classes use `Schema.TaggedError`. See the upstream
[release notes](https://github.com/Effect-TS/effect/blob/main/packages/effect/CHANGELOG.md).
