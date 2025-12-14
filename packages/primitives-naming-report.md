# Naming Evaluation for Durable Effect "Jobs"

## Package / Concept Label
- **Current:** `@durable-effect/jobs` — communicates higher-level, managed units of durable work.
- **Alternatives considered:** `durable-effect/actors`, `durable-effect/routines`, `durable-effect/ops`.  
  - *Actors* leans on the DO-as-actor model; *Routines* emphasizes scheduled/managed runs.

## Individual Primitive Types
- **Continuous** (recurring execution) — keep. It is descriptive and maps to interval/cron concepts.
- **Debounce** (coalesce many -> one flush) — new name to avoid “buffer” passthrough connotation. Alternative options would be `Batch` or `Aggregator` if transformation becomes first-class.
- **WorkerPool** (controlled parallel event processing) — new name to avoid the overly broad “queue”. Alternatives: `WorkQueue` or `TaskQueue`; if priority lanes arrive, `PriorityWorkerPool` is explicit.

## API Surface Notes
- Client namespaces: `client.debounce(name)`, `client.workerPool(name)`, `client.continuous(name)`.
- Request type discriminants: mirror names (`type: "debounce" | "workerPool" | "continuous"`).
- Registry helpers/definition factories: `Debounce.make`, `WorkerPool.make` to match the semantics; keep the “name derives from object key” rule.
- Docs: frame these as “jobs” / “managed routines” or “durable workers” rather than “primitives” to keep expectations higher-level.

## Recommendation (if choosing now)
1) Package stays `@durable-effect/jobs`.  
2) Keep **Continuous** as-is.  
3) Use **Debounce** for coalescing flushers.  
4) Use **WorkerPool** for bounded-concurrency processing (with room for priority variants later).
