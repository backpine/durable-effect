// Postgres for the ledger tasks, in Docker (plain `docker run`, no Compose).
//
//   node scripts/postgres.mjs up      start it, apply db/schema.sql, wait until it answers
//   node scripts/postgres.mjs down    stop it and delete its data
//   node scripts/postgres.mjs reset   empty every ledger table
//
// The port matches the Hyperdrive binding's `localConnectionString` in
// `wrangler.jsonc`; change both together.
import { execFileSync, spawnSync } from "node:child_process"
import { dirname, join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"

export const CONTAINER = "task-example-postgres"
export const PORT = 54417
export const DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${PORT}/task_example`

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const docker = (args, options = {}) => spawnSync("docker", args, { encoding: "utf8", ...options })

/** Run SQL inside the container over TCP, so it only succeeds on the real server. */
export function psql(sql) {
  const result = docker([
    "exec", "-e", "PGPASSWORD=postgres", CONTAINER,
    "psql", "-h", "127.0.0.1", "-U", "postgres", "-d", "task_example", "-v", "ON_ERROR_STOP=1", "-Atc", sql,
  ])
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

export function down() {
  docker(["rm", "-f", "-v", CONTAINER])
}

export async function up() {
  down()
  execFileSync("docker", [
    "run", "-d", "--name", CONTAINER,
    "-e", "POSTGRES_USER=postgres", "-e", "POSTGRES_PASSWORD=postgres", "-e", "POSTGRES_DB=task_example",
    "-p", `127.0.0.1:${PORT}:5432`,
    "-v", `${join(appDir, "db/schema.sql")}:/docker-entrypoint-initdb.d/001-schema.sql:ro`,
    "postgres:17-alpine",
  ], { stdio: ["ignore", "ignore", "inherit"] })
  // The image starts a temporary server to run the schema, then the real one.
  // Only the real one listens on TCP, and only it has the tables.
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      if (psql("SELECT count(*) FROM ledger_batch") === "0") return
    } catch {
      // not up yet
    }
    await delay(300)
  }
  throw new Error(`Postgres did not come up:\n${docker(["logs", "--tail", "40", CONTAINER]).stderr}`)
}

export function reset() {
  psql("TRUNCATE ledger_audit, ledger_entry, account_balance, ledger_batch RESTART IDENTITY CASCADE")
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2]
  if (command === "up") {
    await up()
    console.log(`Postgres is up: ${DATABASE_URL}`)
  } else if (command === "down") {
    down()
    console.log("Postgres is removed.")
  } else if (command === "reset") {
    reset()
    console.log("Ledger tables are empty.")
  } else {
    console.error("usage: node scripts/postgres.mjs <up|down|reset>")
    process.exit(1)
  }
}
