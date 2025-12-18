# CLAUDE.md - Effect Worker

This document provides guidance for AI assistants working with the Effect Worker codebase.

## Project Overview

**Effect Worker** is a library that bridges Effect-TS with Cloudflare Workers runtime. It provides effectful, type-safe, and composable patterns for building serverless applications.

### Key Concepts

1. **Effect-TS Integration**: All operations use Effect types for composition, error handling, and dependency injection
2. **Request-Scoped Runtime**: ManagedRuntime is created per-request since Cloudflare bindings are only available at request time
3. **Layer Memoization**: Services are instantiated once per request through Effect's layer system
4. **Swappable Implementations**: Abstract service interfaces allow testing and future runtime migrations

## Repository Structure

```
effect-worker/
├── src/                       # Source code (to be implemented)
│   ├── worker.ts              # Main entry point (export default)
│   ├── app.ts                 # Application layer composition
│   ├── services/              # Service abstractions
│   │   ├── bindings.ts        # CloudflareBindings service
│   │   ├── config.ts          # Config service
│   │   ├── database.ts        # Database service (Drizzle)
│   │   ├── kv.ts              # KV Store service
│   │   └── storage.ts         # Object Storage (R2) service
│   ├── handlers/              # Handler implementations
│   ├── errors/                # Error definitions
│   └── db/                    # Database schema and migrations
├── test/                      # Test files
├── docs/                      # Design documentation
│   └── 001-system-design.md   # System architecture document
├── wrangler.toml              # Cloudflare configuration (to be created)
├── package.json               # Dependencies (to be created)
└── tsconfig.json              # TypeScript config (to be created)
```

## Core Patterns

### 1. CloudflareBindings Layer

The foundation service that provides access to Cloudflare's env object:

```typescript
export class CloudflareBindings extends Context.Tag("CloudflareBindings")<
  CloudflareBindings,
  { readonly env: Env; readonly ctx: ExecutionContext }
>() {
  static layer(env: Env, ctx: ExecutionContext) {
    return Layer.succeed(this, { env, ctx })
  }
}
```

### 2. Service Definition Pattern

Services use `Effect.Service` or `Context.Tag` + `Layer.effect`:

```typescript
export class MyService extends Effect.Service<MyService>()("MyService", {
  effect: Effect.gen(function* () {
    const { env } = yield* CloudflareBindings
    // Build service using env
    return { /* service methods */ }
  }),
  dependencies: [CloudflareBindings.Default],
}) {}
```

### 3. Runtime Creation

Runtime is created per-request with Cloudflare bindings:

```typescript
const makeRuntime = (env: Env, ctx: ExecutionContext) => {
  const bindingsLayer = CloudflareBindings.layer(env, ctx)
  const appLayer = AppLive.pipe(Layer.provide(bindingsLayer))
  return ManagedRuntime.make(appLayer)
}
```

### 4. Fetch Handler

```typescript
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const runtime = makeRuntime(env, ctx)
    return runtime.runPromise(handleRequest(request))
  }
}
```

## Development Workflow

### Commands (to be configured)

```bash
# Development
pnpm dev              # Start local dev server with wrangler

# Testing
pnpm test             # Run unit tests
pnpm test:integration # Run integration tests with miniflare

# Building
pnpm build            # Build for production
pnpm typecheck        # Type checking

# Deployment
pnpm deploy           # Deploy to Cloudflare
```

### Key Dependencies

- `effect` - Core Effect-TS library
- `@effect/schema` - Schema validation
- `drizzle-orm` - Database ORM
- `@cloudflare/workers-types` - Cloudflare type definitions
- `wrangler` - Cloudflare CLI tool

## Error Handling

All errors extend `Data.TaggedError` for type-safe error handling:

```typescript
export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly key: string
  readonly message: string
}> {}
```

Use pattern matching for error recovery:

```typescript
effect.pipe(
  Effect.catchTag("ConfigError", (e) => /* handle */),
  Effect.catchTag("DatabaseError", (e) => /* handle */),
)
```

## Testing Approach

1. **Unit Tests**: Use mock layer implementations
2. **Integration Tests**: Use Miniflare for Cloudflare Workers simulation
3. **Type Tests**: Ensure service interfaces are correct

Mock services for testing:

```typescript
const MockDatabase = Layer.succeed(Database, {
  client: mockClient,
  transaction: (effect) => effect(mockTx),
})
```

## Important Considerations

### Layer Memoization

Layers are memoized by reference. Always reuse the same layer instance:

```typescript
// GOOD: Reuse layer reference
const DbLive = Database.Default
const App = Layer.mergeAll(ServiceA, ServiceB).pipe(Layer.provide(DbLive))

// BAD: Creates multiple instances
const App = Layer.mergeAll(
  ServiceA.pipe(Layer.provide(Database.Default)),  // instance 1
  ServiceB.pipe(Layer.provide(Database.Default)),  // instance 2
)
```

### Cloudflare Constraints

- No global state persistence between requests
- `env` bindings only available in handler context
- Limited CPU time (10-30ms per request)
- 128MB memory limit per isolate

### ConfigProvider for Cloudflare

Use `ConfigProvider.fromJson(env)` to make Cloudflare env available to Effect's Config system:

```typescript
program.pipe(
  Effect.withConfigProvider(ConfigProvider.fromJson(env))
)
```

## Documentation Files

Design documents are stored in `/docs/` with sequential numbering:

- `001-system-design.md` - Overall system architecture
- Future docs: `002-xxx.md`, `003-xxx.md`, etc.

## Code Conventions

1. **Effects over Promises**: Prefer Effect-based APIs
2. **Explicit Errors**: All errors typed and tagged
3. **Service Abstraction**: Infrastructure behind abstract interfaces
4. **Layer Composition**: Build dependency graph with layers
5. **No Global State**: Everything flows through Effect context

## When Making Changes

1. Read the relevant design doc in `/docs/`
2. Follow existing patterns for service creation
3. Add appropriate error types for new failure modes
4. Ensure layer dependencies are correctly declared
5. Write tests using mock implementations
6. Update this CLAUDE.md if conventions change
