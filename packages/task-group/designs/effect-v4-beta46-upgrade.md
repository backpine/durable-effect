# Design: Upgrade @durable-effect/task to Effect v4 beta.46

## Current State

- Package: `@durable-effect/task@0.0.14`
- Current Effect version: `4.0.0-beta.38` (peer + dev)
- Target Effect version: `4.0.0-beta.46` (latest in effect-smol)

## Motivation

The downstream `heysegment` project upgraded Effect from beta.43 to beta.46 to fix an RPC hang in compiled Bun binaries. The published `@durable-effect/task@0.0.14` still imports `ServiceMap` from effect, which was renamed back to `Context` in beta.46. This breaks Vite builds:

```
"ServiceMap" is not exported by "effect/dist/index.js"
```

## Scope of Changes

The upgrade is **small and mechanical**. The core Effect APIs used by task-group (`Effect.gen`, `Effect.catch`, `Effect.provide`, `Schema.decodeUnknownEffect`, `Layer.succeed`, `Layer.effect`, `Data.TaggedError`, `Duration.*`, etc.) are all unchanged between beta.38 and beta.46.

The only breaking change affecting this package is the `ServiceMap` -> `Context` rename.

---

## Change 1: `ServiceMap` -> `Context` (4 files)

The `ServiceMap` module was renamed back to `Context` in beta.46 (PR #1961). This is the **only** breaking API change that affects task-group.

### Files to Change

#### `src/services/Storage.ts`

```diff
-import { Data, Effect, ServiceMap } from "effect"
+import { Data, Effect, Context } from "effect"

-export class Storage extends ServiceMap.Service<Storage, {
+export class Storage extends Context.Service<Storage, {
   readonly get: (key: string) => Effect.Effect<unknown | null, StorageError>
   readonly set: (key: string, value: unknown) => Effect.Effect<void, StorageError>
   readonly delete: (key: string) => Effect.Effect<void, StorageError>
   readonly deleteAll: () => Effect.Effect<void, StorageError>
 }>()("@task-group/Storage") {}
```

#### `src/services/Alarm.ts`

```diff
-import { Data, Effect, ServiceMap } from "effect"
+import { Data, Effect, Context } from "effect"

-export class Alarm extends ServiceMap.Service<Alarm, {
+export class Alarm extends Context.Service<Alarm, {
   readonly set: (timestamp: number) => Effect.Effect<void, AlarmError>
   readonly cancel: () => Effect.Effect<void, AlarmError>
   readonly next: () => Effect.Effect<number | null, AlarmError>
 }>()("@task-group/Alarm") {}
```

#### `src/TaskRunner.ts`

```diff
-import { Effect, Layer, ServiceMap } from "effect"
+import { Effect, Layer, Context } from "effect"

-export class TaskRunner extends ServiceMap.Service<TaskRunner, {
+export class TaskRunner extends Context.Service<TaskRunner, {
   // ... shape unchanged
 }>()("@task-group/Runner") {}
```

#### `src/cloudflare/CloudflareEnv.ts`

```diff
-import { ServiceMap } from "effect"
+import { Context } from "effect"

-export class CloudflareEnv extends ServiceMap.Service<CloudflareEnv, unknown>()(
+export class CloudflareEnv extends Context.Service<CloudflareEnv, unknown>()(
   "@durable-effect/CloudflareEnv",
 ) {}
```

---

## Change 2: `package.json` Version Bump

```diff
 "peerDependencies": {
-  "effect": "^4.0.0-beta.38"
+  "effect": "^4.0.0-beta.46"
 },
 "devDependencies": {
-  "effect": "4.0.0-beta.38",
+  "effect": "4.0.0-beta.46",
   "vitest": "^2.1.0"
 }
```

---

## APIs Verified Unchanged

The following APIs are all present and unchanged in beta.46 (verified against effect-smol source):

| API | Used In | Status |
|-----|---------|--------|
| `Effect.gen` | Everywhere | Unchanged |
| `Effect.catch` | RegisteredTask.ts | Unchanged (exported as `catch_ as catch`) |
| `Effect.succeed` / `Effect.fail` / `Effect.sync` | Throughout | Unchanged |
| `Effect.tryPromise` | cloudflare adapter | Unchanged |
| `Effect.mapError` / `Effect.map` | Throughout | Unchanged |
| `Effect.provide` | TaskRegistry, cloudflare, InMemoryRuntime | Unchanged |
| `Effect.runPromise` | cloudflare runtime | Unchanged |
| `Schema.decodeUnknownEffect` | RegisteredTask.ts, InMemoryRuntime.ts | Unchanged |
| `Schema.encodeUnknownEffect` | RegisteredTask.ts | Unchanged |
| `Schema.SchemaError` | RegisteredTask.ts (error type) | Unchanged |
| `Schema.Top` | TaskTag.ts (PureSchema type) | Unchanged |
| `Schema.Top["DecodingServices"]` | TaskTag.ts (PureSchema constraint) | Unchanged |
| `Schema.Top["EncodingServices"]` | TaskTag.ts (PureSchema constraint) | Unchanged |
| `Data.TaggedError` | errors.ts (5 error classes) | Unchanged |
| `Duration.Input` / `Duration.toMillis` / `Duration.fromInputUnsafe` | RegisteredTask.ts | Unchanged |
| `Layer.succeed` | InMemoryStorage, InMemoryAlarm, cloudflare runtime | Unchanged (both curried and non-curried forms work) |
| `Layer.effect` | TaskRunner.ts | Unchanged (both forms work) |
| `Layer.unwrap` | cloudflareServices.ts | Unchanged |
| `Layer.Layer` (type) | Throughout | Unchanged |

---

## What Does NOT Need to Change

- **`Layer.succeed(Tag, value)` calls** - Both `Layer.succeed(Tag, value)` and `Layer.succeed(Tag)(value)` are supported in beta.46. The existing non-curried calls in `InMemoryStorage.ts` and `InMemoryAlarm.ts` will continue to work. The already-curried call in `cloudflare/runtime.ts` (`Layer.succeed(CloudflareEnv)(env)`) also works.

- **`Layer.effect(Tag, effect)` calls** - Same dual-form support. The call in `TaskRunner.ts` works as-is.

- **`Effect.catch` calls** - Still exists with the same signature. The `catchAll` -> `catch` rename happened before beta.38 (task-group already uses `Effect.catch`).

- **Error classes** - `Data.TaggedError` is unchanged. All 5 error classes (`TaskError`, `PurgeSignal`, `TaskNotFoundError`, `TaskValidationError`, `TaskExecutionError`, `SystemFailure`) plus service errors (`StorageError`, `AlarmError`) work as-is.

- **Schema usage** - `Schema.decodeUnknownEffect`, `Schema.encodeUnknownEffect`, `Schema.SchemaError`, `Schema.Top` are all unchanged. The `PureSchema<T>` type definition using `Schema.Top & { Type, DecodingServices, EncodingServices }` remains valid.

- **All handler types** - `Effect.Effect<A, E, R>` type parameters unchanged.

- **Cloudflare adapter** - No cloudflare-specific changes needed. `DurableObject` import from `cloudflare:workers` is unrelated to Effect version.

---

## Risk Assessment

**Low risk.** This is a 4-file find-and-replace of `ServiceMap` -> `Context`. No behavioral changes, no type signature changes, no new patterns.

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| `Context.Service` class pattern has different type inference | Very Low | Pattern is identical, just module rename. Verified in effect-smol source. |
| Transitive dependency conflict | Low | Use exact version pin in devDependency. Peer dep `^4.0.0-beta.46` covers future betas. |
| Test breakage | Very Low | Run full test suite after changes. |

---

## Execution Plan

1. Update `package.json` versions
2. Replace `ServiceMap` -> `Context` in 4 source files
3. Run `pnpm install` to update lockfile
4. Run `pnpm typecheck` to verify compilation
5. Run `pnpm test` to verify all tests pass
6. Build with `pnpm build` and verify dist output
7. Publish new version (`0.0.15`)

---

## Consumer Impact

Consumers of `@durable-effect/task` who are on Effect beta.46 will:
- No longer see `"ServiceMap" is not exported` build errors
- Not need to change any of their own code (the public API types are unchanged)

Consumers still on beta.38-beta.45:
- Will need to upgrade Effect to `>=4.0.0-beta.46` (enforced by peer dep)
- Will need to do their own `ServiceMap` -> `Context` rename if they use Effect services directly
