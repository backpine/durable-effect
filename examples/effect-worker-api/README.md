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

After editing Wrangler bindings, regenerate the checked-in runtime types:

```sh
pnpm --filter effect-worker-api cf-typegen
```

Effect v4 stable removed the `unstable` import segment and renamed `httpapi` to
`http-api`; this app now imports `effect/http` and `effect/http-api`. Schema error
classes use `Schema.TaggedError`. See the upstream
[release notes](https://github.com/Effect-TS/effect/blob/main/packages/effect/CHANGELOG.md).
