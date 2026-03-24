# Design: Cloudflare Durable Object Adapter

## Developer Experience

```typescript
// tasks/onboarding/index.ts
import { makeTaskGroupDO } from "@durable-effect/task-group/cloudflare"
import { env } from "cloudflare:workers"

const registryConfig = registry.build({
  onboarding: onboardingHandler,
  welcomeEmail: welcomeEmailHandler,
})

const taskGroup = makeTaskGroupDO(registryConfig)

// 1. The DO class — export for wrangler binding
export const OnboardingDO = taskGroup.DO

// 2. The client — pass the namespace to get a typed runtime
export const onboarding = taskGroup.client(env.ONBOARDING_DO)
```

```typescript
// src/index.ts — wire the DO class for wrangler
export { OnboardingDO } from "./tasks/onboarding"
```

```typescript
// src/handlers/onboarding.ts — use the client, identical to InMemoryRuntime
import { onboarding } from "@/tasks/onboarding"

yield* onboarding.sendEvent("onboarding", userId, { _tag: "Start", ... })
const state = yield* onboarding.getState("onboarding", userId)
```

The one-line swap between dev and prod:

```typescript
// Development / testing
export const onboarding = makeInMemoryRuntime(registryConfig)

// Production
const taskGroup = makeTaskGroupDO(registryConfig)
export const OnboardingDO = taskGroup.DO
export const onboarding = taskGroup.client(env.ONBOARDING_DO)
```

Handler code doesn't change. Same `sendEvent`, `getState`, `fireAlarm`.

---

## Multiple Task Groups

Each group gets its own DO class and client. The namespace binding determines routing.

```typescript
// Onboarding tasks
const onboardingGroup = makeTaskGroupDO(onboardingConfig)
export const OnboardingDO = onboardingGroup.DO
export const onboarding = onboardingGroup.client(env.ONBOARDING_DO)

// Analytics tasks
const analyticsGroup = makeTaskGroupDO(analyticsConfig)
export const AnalyticsDO = analyticsGroup.DO
export const analytics = analyticsGroup.client(env.ANALYTICS_DO)
```

No service/layer conflict — each group is a self-contained value. The `env.BINDING` is passed directly to `.client()`, not baked into the factory.

---

## Shared Runtime Interface

Both `InMemoryRuntime` and the Cloudflare client implement the same core interface:

```typescript
interface TaskRuntime {
  sendEvent(name: string, id: string, event: unknown): Effect<void, TaskNotFoundError | TaskValidationError | TaskExecutionError>
  getState(name: string, id: string): Effect<unknown, TaskNotFoundError | TaskExecutionError>
  fireAlarm(name: string, id: string): Effect<void, TaskNotFoundError | TaskExecutionError>
}
```

`InMemoryRuntime` extends this with test-only methods (`tick`, `getScheduledAlarms`, `injectSystemFailure`). The Cloudflare client implements just the core.

---

## What `makeTaskGroupDO(registryConfig)` Returns

```typescript
interface TaskGroupDO {
  /** The Durable Object class — export this for wrangler. */
  readonly DO: DurableObjectClass

  /** Create a client bound to a DO namespace. */
  readonly client: (namespace: DurableObjectNamespace) => TaskRuntime
}
```

### The DO Class (`.DO`)

A class that CF instantiates. Uses RPC methods instead of fetch:

```typescript
class GeneratedDO {
  private storage: Storage["Service"]
  private alarm: Alarm["Service"]
  private dispatch: DispatchFn
  private systemFailure: SystemFailure | null = null

  constructor(private ctx: DurableObjectState, private env: Record<string, unknown>) {
    // Wire ctx.storage → Storage service
    // Wire ctx.storage alarm methods → Alarm service
    // Capture env for sibling dispatch (resolved lazily on first use)
  }

  // ── RPC Methods (called by stubs) ─────────────────────

  async handleEvent(name: string, id: string, event: unknown): Promise<void> {
    const hctx = this.makeHandlerContext(name, id)
    await Effect.runPromise(registryConfig[name].handleEvent(hctx, event))
  }

  async handleAlarm(name: string, id: string): Promise<void> {
    const hctx = this.makeHandlerContext(name, id)
    await Effect.runPromise(registryConfig[name].handleAlarm(hctx))
  }

  async handleGetState(name: string, id: string): Promise<unknown> {
    const hctx = this.makeHandlerContext(name, id)
    return await Effect.runPromise(registryConfig[name].handleGetState(hctx))
  }

  // ── CF Lifecycle ──────────────────────────────────────

  async alarm(): Promise<void> {
    // Read stored routing keys (__taskName, __taskId)
    // Delegate to handleAlarm
  }
}
```

RPC instead of fetch means:
- No JSON envelope — `stub.handleEvent(name, id, event)` directly
- No Response parsing — return values come back as-is
- Structured clone — richer data than JSON (Dates, Maps, etc.)
- Type safety on the stub — the DO class methods are the contract

### The Client (`.client(namespace)`)

```typescript
function makeClient(
  registryConfig: TaskRegistryConfig,
  namespace: DurableObjectNamespace,
): TaskRuntime {
  function getStub(name: string, id: string) {
    const instanceId = `${name}:${id}`
    return namespace.get(namespace.idFromName(instanceId))
  }

  return {
    sendEvent: (name, id, event) =>
      Effect.tryPromise({
        try: () => getStub(name, id).handleEvent(name, id, event),
        catch: (cause) => new TaskExecutionError({ cause }),
      }),

    getState: (name, id) =>
      Effect.tryPromise({
        try: () => getStub(name, id).handleGetState(name, id),
        catch: (cause) => new TaskExecutionError({ cause }),
      }),

    fireAlarm: (name, id) =>
      Effect.tryPromise({
        try: () => getStub(name, id).handleAlarm(name, id),
        catch: (cause) => new TaskExecutionError({ cause }),
      }),
  }
}
```

The client is thin — it creates a stub and calls the RPC method. The DO does all the real work.

---

## Sibling Dispatch Inside the DO

When a handler calls `ctx.task("welcomeEmail").send(id, event)`, the dispatch needs to reach a different DO instance. The DO needs the namespace to create stubs.

The namespace is passed by the user via `.client(env.ONBOARDING_DO)`. Since the DO class and client are produced by the same `makeTaskGroupDO` call, they **share a closure**:

```typescript
function makeTaskGroupDO(config: TaskRegistryConfig) {
  // Shared between the DO class and the client
  let namespace: DurableObjectNamespace | null = null

  class GeneratedDO {
    constructor(ctx: DurableObjectState, env: unknown) {
      // namespace is available here — set by client() at module init
      // Use it for sibling dispatch
    }
  }

  function client(ns: DurableObjectNamespace): TaskRuntime {
    namespace = ns  // captured by the DO class closure
    return { sendEvent, getState, fireAlarm }
  }

  return { DO: GeneratedDO, client }
}
```

When `.client(env.ONBOARDING_DO)` runs at module init, it stores the namespace. When CF later instantiates the DO, the namespace is already available in the closure. No binding strings, no scanning env, no subclassing.

This works because:
1. Module-level code runs before CF creates DO instances
2. `import { env } from "cloudflare:workers"` makes `env` available at module scope
3. The closure is shared — both `DO` and `client` close over the same `namespace` variable

Let me update the design doc with this approach.
</thinking>

Now let me update the design doc with the refined approach.

<function_calls>
<invoke name="Read">
<parameter name="file_path">/Users/matthewsessions/workspace/backpine/durable-effect/packages/task-group/designs/cloudflare-adapter.md