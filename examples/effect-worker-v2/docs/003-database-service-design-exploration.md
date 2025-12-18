# 003 - Database Service Design

## Overview

This document describes the Database service design for Effect Worker. The design prioritizes simplicity, leveraging Effect's layer memoization to ensure the Drizzle client is instantiated exactly once per request.

**Key Design Goals:**
- Drizzle client memoized once per request
- Clean `query()` helper for effectful database operations
- Direct schema imports (no abstraction)
- Connection via Config service (Postgres/MySQL/Hyperdrive)
- Simple implementation that's easy to swap providers

---

## Implementation

### Types

```typescript
import { Context, Effect, Layer } from "effect";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/worker/db/schema";
import { DatabaseError } from "@/worker/effect/errors";

export type DrizzleClient = ReturnType<typeof drizzle<typeof schema>>;
```

### Service Definition

The service is intentionally simple—it just provides the Drizzle client:

```typescript
export class Database extends Context.Tag("Database")<
  Database,
  DrizzleClient
>() {}
```

**Why this works:** Effect's layer system memoizes services automatically. When you provide `Database` to your app layer once, every `yield* Database` in that request gets the same client instance.

### Query Helper

The `query` helper wraps database operations in Effects with proper error handling:

```typescript
export const query = <T>(
  fn: (db: DrizzleClient) => Promise<T>,
): Effect.Effect<T, DatabaseError, Database> =>
  Effect.gen(function* () {
    const db = yield* Database;
    return yield* Effect.tryPromise({
      try: () => fn(db),
      catch: (e) => new DatabaseError("Database query failed", e),
    });
  });
```

This gives you a clean pattern for all database operations:

```typescript
const users = yield* query((db) =>
  db.select().from(schema.users).where(eq(schema.users.id, id))
);
```

### Layer Constructors

Two layer constructors for different environments:

```typescript
/**
 * Creates a Database layer from a connection string.
 * Use for local development with a direct PostgreSQL connection.
 */
export const DatabaseLive = (connectionString: string) =>
  Layer.sync(Database, () => {
    const client = postgres(connectionString, {
      max: 5,
      fetch_types: false,
    });
    return drizzle(client, { schema });
  });

/**
 * Creates a Database layer from Hyperdrive.
 * Use in production on Cloudflare Workers.
 */
export const DatabaseHyperdrive = (hyperdrive: Hyperdrive) =>
  Layer.sync(Database, () => {
    const client = postgres(hyperdrive.connectionString, {
      max: 5,
      fetch_types: false,
    });
    return drizzle(client, { schema });
  });
```

---

## Usage Examples

### Simple Query

```typescript
const getUser = (id: string) =>
  query((db) =>
    db.select().from(users).where(eq(users.id, id)).limit(1)
  );
```

### Query with Additional Logic

```typescript
const getUserById = (id: string) =>
  Effect.gen(function* () {
    const result = yield* query((db) =>
      db.select().from(users).where(eq(users.id, id))
    );
    if (result.length === 0) {
      return yield* Effect.fail(new NotFoundError("User not found"));
    }
    return result[0];
  });
```

### Insert

```typescript
const createUser = (email: string, name: string) =>
  query((db) =>
    db.insert(users).values({
      id: crypto.randomUUID(),
      email,
      name,
    }).returning()
  );
```

### Complex Queries

```typescript
const getWorkflowSteps = (workflowId: string) =>
  query((db) =>
    db
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.workflowId, workflowId))
      .orderBy(asc(workflowSteps.createdAt))
  );
```

### Joins

```typescript
const getUserWithPosts = (userId: string) =>
  query((db) =>
    db
      .select({
        user: users,
        post: posts,
      })
      .from(users)
      .leftJoin(posts, eq(users.id, posts.authorId))
      .where(eq(users.id, userId))
  );
```

---

## Layer Memoization

### How It Works

Effect's layer system guarantees that services are memoized by reference. When you compose your app layer:

```typescript
const AppLive = Layer.mergeAll(
  ConfigLive,
  DatabaseLive(connectionString),
  // ... other services
);
```

Every service that `yield* Database` gets the **same instance**. The Drizzle client is created exactly once when the layer is first accessed during request handling.

### Verification

You can verify memoization is working by adding a log:

```typescript
export const DatabaseLive = (connectionString: string) =>
  Layer.sync(Database, () => {
    console.log("Creating Drizzle client"); // Only logs once per request
    const client = postgres(connectionString, { max: 5 });
    return drizzle(client, { schema });
  });
```

### Common Pitfall: Breaking Memoization

```typescript
// BAD: Creates multiple instances because layers are different references
const AppLive = Layer.mergeAll(
  ServiceA.pipe(Layer.provide(DatabaseLive(url))),  // instance 1
  ServiceB.pipe(Layer.provide(DatabaseLive(url))),  // instance 2!
);

// GOOD: Single layer reference, single instance
const DbLayer = DatabaseLive(url);
const AppLive = Layer.mergeAll(
  ServiceA,
  ServiceB,
).pipe(Layer.provide(DbLayer));
```

---

## Transactions

For transactions, use Drizzle's transaction API within the query helper:

```typescript
const createUserWithPost = (email: string, postTitle: string) =>
  query((db) =>
    db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({ id: crypto.randomUUID(), email })
        .returning();

      const [post] = await tx
        .insert(posts)
        .values({
          id: crypto.randomUUID(),
          title: postTitle,
          authorId: user.id,
        })
        .returning();

      return { user, post };
    })
  );
```

The transaction runs entirely within the `query()` Effect, so errors are properly caught and converted to `DatabaseError`.

---

## Error Handling

The `DatabaseError` class captures the underlying error:

```typescript
export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
```

Handle database errors with Effect's `catchTag`:

```typescript
const program = getUserById("123").pipe(
  Effect.catchTag("DatabaseError", (error) =>
    Effect.gen(function* () {
      yield* Effect.logError("Database operation failed", error.cause);
      return yield* Effect.fail(new ServiceUnavailableError());
    })
  )
);
```

---

## App Layer Composition

### With Config Service

If you want the connection string from Config:

```typescript
const DatabaseFromConfig = Layer.effect(
  Database,
  Effect.gen(function* () {
    const config = yield* Config;
    const connectionString = yield* config.get("DATABASE_URL");
    const client = postgres(connectionString, { max: 5, fetch_types: false });
    return drizzle(client, { schema });
  })
).pipe(Layer.provide(ConfigLive));
```

### Runtime Creation

```typescript
const makeRuntime = (env: Env, ctx: ExecutionContext) => {
  const bindingsLayer = CloudflareBindings.layer(env, ctx);

  // Hyperdrive in production
  const dbLayer = DatabaseHyperdrive(env.HYPERDRIVE);

  const appLayer = Layer.mergeAll(
    ConfigLive,
    dbLayer,
    // ... other services
  ).pipe(Layer.provide(bindingsLayer));

  return ManagedRuntime.make(appLayer);
};
```

---

## Why This Design

### Simplicity Over Abstraction

The service just provides the Drizzle client directly. No wrapper types, no abstraction layer. This means:

- **Easy to understand**: It's just Drizzle
- **Easy to change**: Swap `postgres-js` for another driver trivially
- **Full Drizzle API**: No limitations from abstraction layer
- **Type inference works**: Drizzle's types flow through naturally

### The `query()` Helper Pattern

The helper function provides:

1. **Automatic client injection**: No need to `yield* Database` in every function
2. **Consistent error handling**: All database errors become `DatabaseError`
3. **Clean syntax**: `yield* query((db) => ...)` is readable

But it's **not required**. You can always do:

```typescript
const db = yield* Database;
const result = yield* Effect.tryPromise({
  try: () => db.select().from(users),
  catch: (e) => new DatabaseError("Query failed", e),
});
```

The helper just reduces boilerplate.

### Layer Constructors as Functions

Using functions like `DatabaseLive(connectionString)` instead of relying on Config:

- **Explicit dependencies**: Clear what the layer needs
- **Easier testing**: Pass a test connection string directly
- **Flexible composition**: Choose Hyperdrive vs direct connection at the app boundary

---

## Testing

### Mock Layer

```typescript
const mockClient = {
  select: () => ({
    from: () => ({
      where: () => Promise.resolve([{ id: "1", email: "test@test.com" }]),
    }),
  }),
  // ... other methods as needed
} as unknown as DrizzleClient;

const MockDatabase = Layer.succeed(Database, mockClient);
```

### In Tests

```typescript
describe("getUserById", () => {
  it("should return user", async () => {
    const program = getUserById("1").pipe(Effect.provide(MockDatabase));
    const result = await Effect.runPromise(program);
    expect(result.email).toBe("test@test.com");
  });
});
```

---

## Summary

| Aspect | Design Choice |
|--------|--------------|
| Service type | Just the DrizzleClient |
| Query pattern | `query((db) => db.select()...)` |
| Error handling | `DatabaseError` with cause |
| Memoization | Automatic via Effect layers |
| Layer creation | Functions: `DatabaseLive(url)` |
| Schema access | Direct imports, no abstraction |
| Transactions | Drizzle's `db.transaction()` API |

This design is intentionally minimal. The `query()` helper handles the common case elegantly, while keeping full Drizzle access when you need it.
