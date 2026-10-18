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

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const rootDir = resolve(appDir, "../..")
const require = createRequire(join(appDir, "package.json"))
const tempDir = await mkdtemp(join(tmpdir(), "task-group-local-"))
const testAppDir = join(tempDir, "app")
const env = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true", CHOKIDAR_USEPOLLING: "true" }
let worker
let workerOutput = ""

function run(args, cwd = rootDir) {
  execFileSync("pnpm", args, { cwd, env, stdio: "inherit" })
}

async function freePort() {
  const server = createServer()
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert(address && typeof address !== "string")
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

const port = await freePort()
const baseUrl = `http://127.0.0.1:${port}`

async function request(path, options, expectedStatus = 200) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    signal: AbortSignal.timeout(5_000),
  })
  assert.equal(response.status, expectedStatus, `${path}: ${await response.clone().text()}`)
  const body = await response.text()
  return body ? JSON.parse(body) : undefined
}

function post(path, payload) {
  return request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  })
}

async function eventually(check, description, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(200)
  }
  throw new Error(`Timed out: ${description}`)
}

async function startWorker() {
  workerOutput = ""
  worker = spawn("pnpm", [
    "exec", "wrangler", "dev", "--local", "--ip", "127.0.0.1",
    "--port", String(port), "--inspector-port", "0",
    "--persist-to", join(tempDir, "state"),
  ], { cwd: testAppDir, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
  worker.stdout.on("data", (chunk) => { workerOutput += chunk })
  worker.stderr.on("data", (chunk) => { workerOutput += chunk })
  worker.on("error", (error) => { workerOutput += String(error) })
  await eventually(async () => {
    if (worker.exitCode !== null) throw new Error(workerOutput)
    try {
      return (await request("/api/health/")).status === "ok"
    } catch {
      return false
    }
  }, "Wrangler startup")
}

async function stopWorker() {
  if (!worker || worker.exitCode !== null) return
  const exited = once(worker, "exit")
  process.kill(-worker.pid, "SIGTERM")
  await exited
  worker = undefined
}

try {
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
  run(["typecheck"], testAppDir)
  run(["test"], testAppDir)
  run(["build"], testAppDir)
  await startWorker()

  const health = await request("/api/health/")
  assert.equal(health.status, "ok")
  assert(Number.isFinite(Date.parse(health.timestamp)))
  const openapi = await request("/api/openapi.json")
  assert(openapi.paths["/api/counter/status/{counterId}"])
  await request("/api/billing/create", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: "invalid", amount: "not a number" }),
  }, 400)
  assert.equal((await fetch(`${baseUrl}/not-found`)).status, 404)
  assert.deepEqual(await request("/api/billing/status/missing"), { invoice: null, receipt: null })
  console.log("PASS: health, OpenAPI, validation, missing routes and empty state")

  await request("/api/counter/start/counter-a")
  assert.deepEqual(await request("/api/counter/status/counter-a"), { counter: { count: 0 } })
  assert.deepEqual(await request("/api/counter/status/counter-b"), { counter: null })
  await eventually(async () => (await request("/api/counter/status/counter-a")).counter?.count >= 1,
    "counter's automatic alarm")
  console.log("PASS: counter state, instance isolation and automatic alarm")

  const manualInvoice = await post("/api/billing/create", { userId: "manual", amount: 42 })
  const created = await request(`/api/billing/status/${manualInvoice.invoiceId}`)
  assert.equal(created.invoice.status, "created")
  assert.equal(created.receipt.invoiceId, manualInvoice.invoiceId)
  assert.equal(created.receipt.userId, "manual")
  const finalized = await post(`/api/billing/finalize/${manualInvoice.invoiceId}`)
  assert.equal(finalized.invoice.status, "finalized")
  assert.equal(finalized.invoice.receiptSent, true)
  console.log("PASS: billing event, env service, sibling RPC, sibling state and manual alarm")

  await post("/api/onboarding/start", { userId: "manual", email: "manual@example.com" })
  const started = await request("/api/onboarding/status/manual")
  assert.equal(started.onboarding.step, "welcome_email_queued")
  assert.equal(started.welcomeEmail.to, "manual@example.com")
  const completed = await post("/api/onboarding/complete/manual")
  assert.equal(completed.onboarding.step, "completed")
  assert.equal(typeof completed.onboarding.completedAt, "number")
  console.log("PASS: onboarding sibling dispatch, optional state and services on both hooks")

  await post("/api/onboarding/start", { userId: "automatic", email: "automatic@example.com" })
  const automaticInvoice = await post("/api/billing/create", { userId: "automatic", amount: 100 })
  await eventually(async () => {
    const state = await request(`/api/billing/status/${automaticInvoice.invoiceId}`)
    return state.invoice?.status === "finalized" && state.invoice.receiptSent === true
  }, "billing's automatic alarm")
  await eventually(async () => {
    const state = await request("/api/onboarding/status/automatic")
    return state.onboarding?.step === "completed"
  }, "onboarding's automatic alarm")
  await eventually(async () => (await request("/api/counter/status/counter-a")).counter === null,
    "counter's automatic purge")
  await delay(2_200)
  assert.deepEqual(await request("/api/counter/status/counter-a"), { counter: null })
  console.log("PASS: automatic billing/onboarding alarms, repeated scheduling and purge cancellation")
  await stopWorker()
  await startWorker()
  assert.deepEqual(await request(`/api/billing/status/${manualInvoice.invoiceId}`), finalized)
  const persisted = await request(`/api/billing/status/${automaticInvoice.invoiceId}`)
  assert.equal(persisted.invoice.status, "finalized")
  assert.equal(persisted.invoice.receiptSent, true)
  assert.equal((await request("/api/onboarding/status/automatic")).onboarding.step, "completed")
  assert.deepEqual(await request("/api/counter/status/counter-a"), { counter: null })
  console.log("PASS: state and purge persist across a Wrangler restart")
  console.log("All packed-package local checks passed on Effect 4.0.5.")
} catch (error) {
  console.error(workerOutput.slice(-16_000))
  throw error
} finally {
  await stopWorker()
  await rm(tempDir, { recursive: true, force: true })
}
