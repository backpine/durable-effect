// The database-backed check of `@durable-effect/task`, as a package consumer
// would meet it:
//
//   1. start Postgres in Docker and apply db/schema.sql
//   2. build and PACK the library, copy this app outside the workspace, and
//      install the tarball beside the exact dependency versions of this checkout
//   3. typecheck the app and its tests, run the in-memory tests
//   4. run the ledger tasks on the in-memory runtime against Postgres
//   5. start the Worker under local Wrangler and run the same tasks through its
//      HTTP API: real Durable Objects, real alarms, Postgres through Hyperdrive
//   6. stop the Worker, remove the copy and the database
//
// Needs Docker. No Cloudflare account is needed. `--keep-database` leaves
// Postgres running afterwards (to look at the rows the checks wrote).
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { once } from "node:events"
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { DATABASE_URL, down as databaseDown, psql, up as databaseUp } from "./postgres.mjs"

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const rootDir = resolve(appDir, "../..")
const require = createRequire(join(appDir, "package.json"))
const tempDir = await mkdtemp(join(tmpdir(), "task-group-db-"))
const testAppDir = join(tempDir, "app")
const keepDatabase = process.argv.includes("--keep-database")
const env = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true", CHOKIDAR_USEPOLLING: "true" }
let worker
let workerOutput = ""

function run(args, cwd = rootDir, extraEnv = {}) {
  execFileSync("pnpm", args, { cwd, env: { ...env, ...extraEnv }, stdio: "inherit" })
}

async function freePort() {
  const server = createServer()
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert(address && typeof address !== "string")
  await new Promise((done, fail) => server.close((error) => (error ? fail(error) : done())))
  return address.port
}

async function startWorker(baseUrl, port) {
  worker = spawn("pnpm", [
    "exec", "wrangler", "dev", "--local", "--ip", "127.0.0.1",
    "--port", String(port), "--inspector-port", "0",
    "--persist-to", join(tempDir, "state"),
  ], { cwd: testAppDir, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
  worker.stdout.on("data", (chunk) => { workerOutput += chunk })
  worker.stderr.on("data", (chunk) => { workerOutput += chunk })
  worker.on("error", (error) => { workerOutput += String(error) })
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (worker.exitCode !== null) throw new Error(`Wrangler exited:\n${workerOutput}`)
    try {
      const response = await fetch(`${baseUrl}/api/health/`, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return
    } catch {
      // not listening yet
    }
    await delay(200)
  }
  throw new Error("Timed out: Wrangler startup")
}

async function stopWorker() {
  if (!worker || worker.exitCode !== null) return
  const exited = once(worker, "exit")
  process.kill(-worker.pid, "SIGTERM")
  await exited
  worker = undefined
}

/** Connections Postgres holds for the pools the task hooks open. */
function taskConnections() {
  return psql(`SELECT coalesce(string_agg(application_name || '=' || n, ', ' ORDER BY application_name), 'none')
    FROM (SELECT application_name, count(*) AS n FROM pg_stat_activity
          WHERE application_name LIKE 'ledger-%' GROUP BY 1) pools`)
}

try {
  await databaseUp()
  console.log(`PASS: Postgres is up in Docker (${DATABASE_URL})`)

  run(["--filter", "@durable-effect/task", "build"])
  run(["--filter", "@durable-effect/task", "pack", "--pack-destination", tempDir])
  const tarball = (await readdir(tempDir)).find((file) => file.endsWith(".tgz"))
  assert(tarball, "pnpm pack produced a tarball")

  await cp(appDir, testAppDir, {
    recursive: true,
    filter: (path) => !["node_modules", ".wrangler", "dist"].includes(path.split("/").at(-1)),
  })
  const manifest = JSON.parse(await readFile(join(appDir, "package.json"), "utf8"))
  for (const section of ["dependencies", "devDependencies"]) {
    for (const name of Object.keys(manifest[section])) {
      manifest[section][name] = name === "@durable-effect/task"
        ? `file:${join(tempDir, tarball)}`
        : require(`${name}/package.json`).version
    }
  }
  manifest.pnpm = { onlyBuiltDependencies: ["esbuild", "sharp", "workerd"] }
  await writeFile(join(testAppDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  run(["install", "--ignore-workspace", "--prefer-offline"], testAppDir)
  const installed = JSON.parse(
    await readFile(join(testAppDir, "node_modules/@durable-effect/task/package.json"), "utf8"),
  )
  console.log(`PASS: installed the packed @durable-effect/task ${installed.version} (${tarball}) outside the workspace`)

  run(["typecheck"], testAppDir)
  run(["test"], testAppDir)
  console.log("PASS: typecheck and in-memory tests")

  const databaseEnv = { LEDGER_DATABASE_URL: DATABASE_URL }
  run(["exec", "vitest", "run", "--config", "vitest.integration.config.ts",
    "test/integration/ledger-runtime.int.test.ts"], testAppDir, databaseEnv)
  console.log("PASS: ledger tasks on the in-memory runtime over Postgres, both layer lifetimes")

  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  await startWorker(baseUrl, port)
  // Nothing from the in-memory run is still connected: that process has ended.
  assert.equal(taskConnections(), "none", "no task pool is connected before the Worker runs anything")
  run(["exec", "vitest", "run", "--config", "vitest.integration.config.ts",
    "test/integration/ledger-worker.int.test.ts"], testAppDir, { ...databaseEnv, LEDGER_API_URL: baseUrl })
  console.log(`PASS: ledger tasks in the Worker over Postgres, both layer lifetimes`)
  console.log(`      still connected after the run: ${taskConnections()}`)

  const batches = psql("SELECT count(*) FILTER (WHERE status = 'settled') || ' settled of ' || count(*) FROM ledger_batch")
  const entries = psql("SELECT count(*) FILTER (WHERE status = 'posted') || ' posted of ' || count(*) FROM ledger_entry")
  console.log(`      the Worker run left ${batches} batches, ${entries} entries`)
  console.log(`All database-backed checks passed on the packed @durable-effect/task ${installed.version}.`)
} catch (error) {
  console.error(workerOutput.slice(-16_000))
  throw error
} finally {
  await stopWorker()
  await rm(tempDir, { recursive: true, force: true })
  if (!keepDatabase) databaseDown()
}
