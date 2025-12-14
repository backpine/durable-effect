# Naming Evaluation for Durable Effect "Primitives"

## Package / Concept Label
- **Current:** `@durable-effect/primitives` — “primitives” reads low-level and undersells the opinionated orchestration these objects provide.
- **Alternatives:** `durable-effect/actors`, `durable-effect/routines`, `durable-effect/ops`, `durable-effect/jobs`.  
  - *Actors* leans on the DO-as-actor model; *Routines* or *Jobs* emphasize recurring/managed work without implying bare building blocks.

## Individual Primitive Types
- **Continuous** (recurring execution) — keep. It is descriptive and maps to interval/cron concepts.
- **Buffer** (coalesce many -> one flush) — “buffer” can imply passthrough or queue. Options: `Batch`, `Aggregator`, `Debounce`, `Coalescer`.  
  - `Batch` or `Aggregator` best convey N-in/1-out flush semantics and scheduled flush triggers.
- **Queue** (controlled parallel event processing) — “queue” is broad. Options: `WorkerPool`, `WorkQueue`, `Processor`, `TaskQueue`.  
  - `WorkerPool` highlights bounded concurrency; `TaskQueue` is a safe middle ground; if priority lanes arrive, `PriorityTaskQueue` is explicit.

## API Surface Notes
- Client namespaces: consider `client.batch(name)`, `client.workerPool(name)` (or `taskQueue`), `client.continuous(name)`.
- Request type discriminants: mirror names (`type: "batch" | "workerPool" | "continuous"`).
- Registry helpers/definition factories: `Batch.make`, `WorkerPool.make` to match the semantics; keep the “name derives from object key” rule.
- Docs: frame these as “managed routines” or “durable workers” rather than “primitives” to keep expectations higher-level.

## Recommendation (if choosing now)
1) Rename package to `@durable-effect/actors` or `@durable-effect/routines`.  
2) Keep **Continuous** as-is.  
3) Rename **Buffer** → **Batch** (or **Aggregator** if you want to stress transformation).  
4) Rename **Queue** → **WorkerPool** (if emphasizing bounded concurrency) or **TaskQueue** (if keeping queue wording with clearer intent).
