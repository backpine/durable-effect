# 011: Database Connection String Abstraction

## Problem

The current database service has multiple implementations that do essentially the same thing:

```typescript
// These all just need a connection string
export const DatabaseLive = (connectionString: string) => ...
export const DatabaseHyperdrive = (hyperdrive: Hyperdrive) => ...  // hyperdrive.connectionString
export const DatabaseFromEnv = ...  // env.DATABASE_URL
```

This creates unnecessary complexity:
- `DatabaseHyperdrive` just extracts `hyperdrive.connectionString` and calls the same postgres setup
- `DatabaseFromEnv` reads `env.DATABASE_URL` and calls the same postgres setup
- The Database service shouldn't know about Cloudflare-specific concerns

## Solution

**Move the connection string resolution up to the layer composition level.**

The Database service should only have ONE implementation that takes a connection string:

```typescript
// src/services/database.ts
export const DatabaseLive = (connectionString: string) =>
  Layer.scoped(
    Database,
    Effect.gen(function* () {
      const client = postgres(connectionString, { max: 5, fetch_types: false });
      const db = drizzle(client);

      yield* Effect.addFinalizer(() =>
        Effect.promise(() => client.end({ timeout: 5 }))
          .pipe(Effect.catchAll(() => Effect.void))
      );

      return db;
    })
  );
```

Then at the **app/runtime level**, decide where the connection string comes from:

```typescript
// src/app.ts

// Option 1: Connection string from env.DATABASE_URL
export const AppLive = (env: Env) =>
  Layer.mergeAll(
    AppCoreLive,
    DatabaseLive(env.DATABASE_URL)
  );

// Option 2: Connection string from Hyperdrive
export const AppLiveHyperdrive = (env: Env) =>
  Layer.mergeAll(
    AppCoreLive,
    DatabaseLive(env.HYPERDRIVE.connectionString)
  );
```

## Implementation

### Step 1: Simplify database.ts

```typescript
// src/services/database.ts
import { Context, Effect, Layer } from "effect";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { DatabaseError } from "@/errors";

export type DrizzleClient = ReturnType<typeof drizzle>;

export class Database extends Context.Tag("Database")<Database, DrizzleClient>() {}

/**
 * Query helper - wraps database operations with error handling.
 */
export const query = <T>(
  fn: (db: DrizzleClient) => Promise<T>
): Effect.Effect<T, DatabaseError, Database> =>
  Effect.gen(function* () {
    const db = yield* Database;
    return yield* Effect.tryPromise({
      try: () => fn(db),
      catch: (error) => new DatabaseError({ message: "Database query failed", cause: error }),
    });
  }).pipe(Effect.withSpan("database.query"));

/**
 * Creates a Database layer from a connection string.
 *
 * This is the ONLY database layer implementation.
 * Where the connection string comes from is decided at the app level.
 */
export const DatabaseLive = (connectionString: string) =>
  Layer.scoped(
    Database,
    Effect.gen(function* () {
      const client = postgres(connectionString, {
        max: 5,
        fetch_types: false,
      });

      const db = drizzle(client);

      yield* Effect.addFinalizer(() =>
        Effect.promise(() => client.end({ timeout: 5 }))
          .pipe(Effect.catchAll(() => Effect.void))
      );

      return db;
    })
  );
```

### Step 2: Update app.ts

```typescript
// src/app.ts
import { Layer } from "effect";
import { ConfigLive, KVLive, StorageLive, DatabaseLive } from "@/services";

export const StaticAppLayer = Layer.empty;

export const AppCoreLive = Layer.mergeAll(ConfigLive, KVLive, StorageLive);

/**
 * Create full application layer with database.
 *
 * Connection string source is passed in - could be:
 * - env.DATABASE_URL (direct connection)
 * - env.HYPERDRIVE.connectionString (Cloudflare pooling)
 * - Any other source
 */
export const AppLive = (connectionString: string) =>
  Layer.mergeAll(AppCoreLive, DatabaseLive(connectionString));
```

### Step 3: Update runtime.ts

```typescript
// src/runtime.ts
import { Layer, ManagedRuntime } from "effect";
import { CloudflareEnv, CloudflareCtx } from "@/services";
import { StaticAppLayer, AppCoreLive, AppLive } from "@/app";

export const runtime = ManagedRuntime.make(StaticAppLayer);

export const makeRequestLayer = (env: Env, ctx: ExecutionContext) =>
  Layer.mergeAll(
    Layer.succeed(CloudflareEnv, { env }),
    Layer.succeed(CloudflareCtx, { ctx }),
  );

/**
 * Create core app layer (no database).
 */
export const makeCoreAppLayer = (env: Env, ctx: ExecutionContext) => {
  const requestLayer = makeRequestLayer(env, ctx);
  return AppCoreLive.pipe(Layer.provide(requestLayer));
};

/**
 * Create full app layer with database from DATABASE_URL.
 */
export const makeAppLayer = (env: Env, ctx: ExecutionContext) => {
  const requestLayer = makeRequestLayer(env, ctx);
  return AppLive(env.DATABASE_URL).pipe(Layer.provide(requestLayer));
};

/**
 * Create full app layer with database from Hyperdrive.
 */
export const makeAppLayerHyperdrive = (env: Env, ctx: ExecutionContext) => {
  const requestLayer = makeRequestLayer(env, ctx);
  return AppLive(env.HYPERDRIVE.connectionString).pipe(Layer.provide(requestLayer));
};
```

### Step 4: Update worker.ts

```typescript
// src/worker.ts
import { Effect, ManagedRuntime } from "effect";
import { handleRequest } from "./handler";
import { StaticAppLayer } from "./app";
import { makeAppLayer } from "./runtime";

const runtime = ManagedRuntime.make(StaticAppLayer);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Connection string source decided here
    const appLayer = makeAppLayer(env, ctx);  // Uses env.DATABASE_URL
    // OR: makeAppLayerHyperdrive(env, ctx)   // Uses env.HYPERDRIVE.connectionString

    const effect = handleRequest(request).pipe(Effect.provide(appLayer));
    return runtime.runPromise(effect);
  },
};
```

## Benefits

1. **Single implementation**: Database service has one `DatabaseLive(connectionString)`
2. **Separation of concerns**: Database doesn't know about Cloudflare env or Hyperdrive
3. **Flexibility**: Connection string source is a runtime decision
4. **Testability**: Easy to test with any connection string
5. **Clarity**: The abstraction boundary is clear - service takes a string, app decides where it comes from

## Removed Code

Delete these from `database.ts`:
- `DatabaseHyperdrive`
- `DatabaseFromEnv`
- `DatabaseFromConfig`
- Import of `CloudflareEnv`

## Summary

| Before | After |
|--------|-------|
| 3+ database layer implementations | 1 implementation: `DatabaseLive(connectionString)` |
| Database knows about CloudflareEnv, Hyperdrive | Database only knows about connection strings |
| Connection source baked into service | Connection source decided at app/runtime level |
