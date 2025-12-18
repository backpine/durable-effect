# 002 - Effect Worker Implementation Guide

## Overview

This document provides a comprehensive, step-by-step implementation guide for building the Effect Worker library. It contains production-ready code examples, configuration files, and detailed explanations of implementation patterns.

**Prerequisite**: Read [001-system-design.md](./001-system-design.md) for architectural context.

**Target Audience**: Developers familiar with Effect-TS who want to integrate it with Cloudflare Workers.

---

## Table of Contents

1. [Project Bootstrap](#project-bootstrap)
2. [CloudflareBindings Layer Implementation](#cloudflarebindings-layer-implementation)
3. [Service Implementation Patterns](#service-implementation-patterns)
4. [Runtime Factory Patterns](#runtime-factory-patterns)
5. [Handler Implementation](#handler-implementation)
6. [Application Layer Composition](#application-layer-composition)
7. [Error Architecture](#error-architecture)
8. [Testing Implementation](#testing-implementation)
9. [Development Workflow](#development-workflow)
10. [Production Considerations](#production-considerations)

---

## Project Bootstrap

### 1.1 Package Dependencies

Create `package.json` with the following dependencies:

```json
{
  "name": "effect-worker",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "typecheck": "tsc --noEmit",
    "build": "tsc && wrangler deploy --dry-run",
    "db:migrate": "wrangler d1 migrations apply DB --local",
    "db:migrate:prod": "wrangler d1 migrations apply DB --remote"
  },
  "dependencies": {
    "effect": "^3.10.0",
    "@effect/schema": "^0.75.0",
    "drizzle-orm": "^0.36.0"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20241127.0",
    "@types/node": "^22.0.0",
    "drizzle-kit": "^0.28.0",
    "miniflare": "^3.20241127.0",
    "typescript": "^5.7.0",
    "vitest": "^2.1.0",
    "wrangler": "^3.93.0"
  }
}
```

**Why These Versions Matter**:
- `effect@^3.10.0`: Latest stable version with improved Layer APIs
- `@effect/schema`: Schema validation and transformations
- `drizzle-orm`: Type-safe ORM that works with D1, PostgreSQL, etc.
- `@cloudflare/workers-types`: TypeScript definitions for Cloudflare runtime
- `miniflare`: Local Cloudflare Workers simulator for integration tests
- `wrangler`: Cloudflare CLI for deployment and local development

### 1.2 TypeScript Configuration

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "lib": ["ES2022"],
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "allowSyntheticDefaultImports": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitReturns": true,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true,
    "types": ["@cloudflare/workers-types", "vitest/globals"],
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*", "test/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**Key Settings Explained**:
- `target: "ES2022"`: Cloudflare Workers support modern JavaScript
- `moduleResolution: "bundler"`: Proper resolution for Wrangler's bundler
- `noUncheckedIndexedAccess`: Prevents accessing potentially undefined array/object members
- `strict: true`: Enables all strict type checking options
- `types`: Include Cloudflare and Vitest types globally

### 1.3 Wrangler Configuration

Create `wrangler.toml`:

```toml
name = "effect-worker"
main = "src/worker.ts"
compatibility_date = "2024-11-27"
node_compat = false

# Account and deployment settings
# account_id = "your-account-id"
# workers_dev = true

# Resource limits (adjust based on your plan)
[limits]
cpu_ms = 50

# Environment variables (non-secret config)
[vars]
ENVIRONMENT = "production"
LOG_LEVEL = "info"

# D1 Database binding
[[d1_databases]]
binding = "DB"
database_name = "effect-worker-db"
database_id = "your-database-id"

# KV Namespace binding
[[kv_namespaces]]
binding = "MY_KV"
id = "your-kv-namespace-id"

# R2 Bucket binding
[[r2_buckets]]
binding = "MY_BUCKET"
bucket_name = "effect-worker-storage"

# Development overrides
[env.development]
vars = { ENVIRONMENT = "development", LOG_LEVEL = "debug" }

[[env.development.d1_databases]]
binding = "DB"
database_name = "effect-worker-db-dev"
database_id = "local"

[[env.development.kv_namespaces]]
binding = "MY_KV"
id = "local-kv"

[[env.development.r2_buckets]]
binding = "MY_BUCKET"
bucket_name = "effect-worker-storage-dev"
```

**Important Configuration Notes**:
- `compatibility_date`: Set to latest date for newest features
- `node_compat = false`: We don't need Node.js compatibility (Effect works without it)
- `main`: Points to your worker entry point
- Bindings are typed and available in `env` parameter at runtime
- Use `[env.development]` for local development overrides

### 1.4 Directory Structure Setup

```bash
mkdir -p src/{services,handlers,errors,db/migrations}
mkdir -p test/{unit,integration,fixtures}
mkdir -p docs
```

Final structure:
```
effect-worker/
├── src/
│   ├── worker.ts              # Main entry point (exports default handler)
│   ├── app.ts                 # Application layer composition
│   ├── services/
│   │   ├── bindings.ts        # CloudflareBindings foundation layer
│   │   ├── config.ts          # Config service
│   │   ├── database.ts        # Database service (Drizzle + D1)
│   │   ├── kv.ts              # KV Store service
│   │   ├── storage.ts         # Object Storage (R2) service
│   │   └── index.ts           # Re-exports all services
│   ├── handlers/
│   │   ├── fetch.ts           # HTTP request handler
│   │   ├── api.ts             # API route handlers
│   │   └── errors.ts          # Error response formatting
│   ├── errors/
│   │   └── index.ts           # Typed error definitions
│   └── db/
│       ├── schema.ts          # Drizzle schema definitions
│       ├── index.ts           # Database exports
│       └── migrations/        # SQL migration files
├── test/
│   ├── unit/                  # Unit tests with mock layers
│   ├── integration/           # Integration tests with Miniflare
│   └── fixtures/              # Test data and utilities
├── docs/
│   ├── 001-system-design.md
│   └── 002-implementation-guide.md
├── wrangler.toml
├── package.json
├── tsconfig.json
├── drizzle.config.ts          # Drizzle Kit configuration
└── vitest.config.ts           # Test configuration
```

---

## CloudflareBindings Layer Implementation

The CloudflareBindings service is the **foundation layer** that provides access to Cloudflare's runtime bindings (env and ctx).

### 2.1 Env Interface Definition

Create `src/services/bindings.ts`:

```typescript
import { Context, Layer } from "effect"
import type {
  D1Database,
  KVNamespace,
  R2Bucket,
  ExecutionContext,
} from "@cloudflare/workers-types"

/**
 * Cloudflare Worker Environment interface
 *
 * This interface defines all bindings available to your worker.
 * Update this when adding new bindings in wrangler.toml.
 */
export interface Env {
  // D1 Database
  readonly DB: D1Database

  // KV Namespaces
  readonly MY_KV: KVNamespace

  // R2 Buckets
  readonly MY_BUCKET: R2Bucket

  // Environment variables
  readonly ENVIRONMENT: string
  readonly LOG_LEVEL: string

  // Secrets (added via wrangler secret put)
  readonly API_KEY?: string
  readonly DATABASE_ENCRYPTION_KEY?: string

  // Add other bindings as needed:
  // readonly DURABLE_OBJECT: DurableObjectNamespace
  // readonly QUEUE: Queue
}

/**
 * CloudflareBindings Service
 *
 * Provides access to Cloudflare's env object and ExecutionContext.
 * This is the foundation layer for all other services.
 *
 * **Why This Exists**:
 * - Cloudflare bindings are only available at request time
 * - We need to inject them into Effect's layer system
 * - Provides type-safe access to bindings throughout the application
 */
export class CloudflareBindings extends Context.Tag("CloudflareBindings")<
  CloudflareBindings,
  {
    readonly env: Env
    readonly ctx: ExecutionContext
  }
>() {
  /**
   * Creates a CloudflareBindings layer from env and ctx
   *
   * This should be called once per request with the env and ctx
   * parameters passed to your fetch handler.
   */
  static layer(env: Env, ctx: ExecutionContext) {
    return Layer.succeed(this, { env, ctx })
  }
}
```

**Key Design Decisions**:

1. **Context.Tag instead of Effect.Service**: We use `Context.Tag` because this service doesn't have complex initialization logic—it just wraps the env object.

2. **Readonly Properties**: All env properties are readonly to prevent accidental mutations.

3. **ExecutionContext Inclusion**: The `ctx` parameter is included because it provides `ctx.waitUntil()` for background tasks.

### 2.2 Usage Patterns

**Accessing Bindings in Other Services**:

```typescript
import { Effect } from "effect"
import { CloudflareBindings } from "./bindings"

// Example: Access D1 database
const program = Effect.gen(function* () {
  const { env } = yield* CloudflareBindings
  const db = env.DB

  // Now you can use db
  const result = await db.prepare("SELECT * FROM users").all()
  return result
})
```

**Using ExecutionContext for Background Tasks**:

```typescript
import { Effect } from "effect"
import { CloudflareBindings } from "./bindings"

const sendEmailInBackground = (email: string) =>
  Effect.gen(function* () {
    const { ctx } = yield* CloudflareBindings

    // Start background task that continues after response is sent
    ctx.waitUntil(
      Effect.runPromise(
        sendEmail(email).pipe(
          Effect.catchAll((error) =>
            Effect.log(`Email send failed: ${error}`)
          )
        )
      )
    )
  })
```

**Common Pitfall**: Never try to access `env` at module level:

```typescript
// ❌ WRONG: env is not available at module load time
const db = env.DB // ReferenceError: env is not defined

// ✅ CORRECT: Access env inside Effect
const getDb = Effect.gen(function* () {
  const { env } = yield* CloudflareBindings
  return env.DB
})
```

### 2.3 Extending for New Binding Types

When you add a new binding in `wrangler.toml`, update the `Env` interface:

```typescript
// Add to wrangler.toml:
// [[queues.producers]]
// binding = "MY_QUEUE"
// queue = "my-queue-name"

// Update Env interface:
export interface Env {
  // ... existing bindings
  readonly MY_QUEUE: Queue<QueueMessage>
}
```

---

## Service Implementation Patterns

This section provides complete, production-ready implementations for each service type.

### 3.1 Config Service

The Config service provides type-safe access to environment variables and secrets with validation.

Create `src/services/config.ts`:

```typescript
import { Context, Effect, Layer } from "effect"
import { Schema } from "@effect/schema"
import { CloudflareBindings } from "./bindings"
import { ConfigError } from "../errors"

/**
 * Config Service Interface
 *
 * Provides type-safe access to environment variables and secrets.
 * All methods return Effects that can fail with ConfigError.
 */
export interface ConfigService {
  /**
   * Get a string config value
   */
  readonly get: (key: string) => Effect.Effect<string, ConfigError>

  /**
   * Get a secret value (same as get, but semantically different)
   */
  readonly getSecret: (key: string) => Effect.Effect<string, ConfigError>

  /**
   * Get a numeric config value
   */
  readonly getNumber: (key: string) => Effect.Effect<number, ConfigError>

  /**
   * Get a boolean config value
   * Accepts: "true", "false", "1", "0", "yes", "no"
   */
  readonly getBoolean: (key: string) => Effect.Effect<boolean, ConfigError>

  /**
   * Get a JSON config value with schema validation
   */
  readonly getJson: <A, I, R>(
    key: string,
    schema: Schema.Schema<A, I, R>
  ) => Effect.Effect<A, ConfigError, R>

  /**
   * Get a config value with a default fallback
   */
  readonly getOrElse: (
    key: string,
    defaultValue: string
  ) => Effect.Effect<string, never>

  /**
   * Get all config as a record (useful for debugging)
   */
  readonly getAll: () => Effect.Effect<Record<string, string>, never>
}

/**
 * Config Service Tag
 */
export class Config extends Context.Tag("Config")<Config, ConfigService>() {}

/**
 * Live Config Implementation
 *
 * Backed by Cloudflare's env object.
 * Values are read from environment variables and secrets.
 */
export const ConfigLive = Layer.effect(
  Config,
  Effect.gen(function* () {
    const { env } = yield* CloudflareBindings

    // Helper to get raw value from env
    const getRaw = (key: string): string | undefined => {
      const value = env[key as keyof typeof env]
      return typeof value === "string" ? value : undefined
    }

    return Config.of({
      get: (key: string) =>
        Effect.fromNullable(getRaw(key)).pipe(
          Effect.mapError(
            () =>
              new ConfigError({
                key,
                message: `Config key "${key}" not found`,
              })
          )
        ),

      getSecret: (key: string) =>
        Effect.fromNullable(getRaw(key)).pipe(
          Effect.mapError(
            () =>
              new ConfigError({
                key,
                message: `Secret "${key}" not found`,
              })
          )
        ),

      getNumber: (key: string) =>
        Effect.gen(function* () {
          const value = yield* Config.get(key)
          const num = Number(value)

          if (Number.isNaN(num)) {
            return yield* Effect.fail(
              new ConfigError({
                key,
                message: `Config key "${key}" is not a valid number: "${value}"`,
              })
            )
          }

          return num
        }),

      getBoolean: (key: string) =>
        Effect.gen(function* () {
          const value = yield* Config.get(key)
          const lower = value.toLowerCase().trim()

          if (["true", "1", "yes"].includes(lower)) return true
          if (["false", "0", "no"].includes(lower)) return false

          return yield* Effect.fail(
            new ConfigError({
              key,
              message: `Config key "${key}" is not a valid boolean: "${value}"`,
            })
          )
        }),

      getJson: <A, I, R>(key: string, schema: Schema.Schema<A, I, R>) =>
        Effect.gen(function* () {
          const value = yield* Config.get(key)

          let parsed: unknown
          try {
            parsed = JSON.parse(value)
          } catch (error) {
            return yield* Effect.fail(
              new ConfigError({
                key,
                message: `Config key "${key}" is not valid JSON: ${error}`,
              })
            )
          }

          return yield* Schema.decodeUnknown(schema)(parsed).pipe(
            Effect.mapError(
              (error) =>
                new ConfigError({
                  key,
                  message: `Config key "${key}" failed schema validation: ${error}`,
                })
            )
          )
        }),

      getOrElse: (key: string, defaultValue: string) =>
        Config.get(key).pipe(
          Effect.orElseSucceed(() => defaultValue)
        ),

      getAll: () =>
        Effect.sync(() => {
          const result: Record<string, string> = {}
          for (const key in env) {
            const value = env[key as keyof typeof env]
            if (typeof value === "string") {
              result[key] = value
            }
          }
          return result
        }),
    })
  })
).pipe(Layer.provide(CloudflareBindings.Default))

/**
 * Default Config Layer
 *
 * Use this in your application layer composition.
 */
Config.Default = ConfigLive
```

**Usage Examples**:

```typescript
import { Effect } from "effect"
import { Config } from "./services/config"
import { Schema } from "@effect/schema"

// Get simple string value
const apiKey = Config.getSecret("API_KEY")

// Get number with validation
const maxRetries = Config.getNumber("MAX_RETRIES")

// Get boolean
const debugMode = Config.getBoolean("DEBUG")

// Get complex JSON config with schema validation
const FeatureFlagsSchema = Schema.Struct({
  enableNewUI: Schema.Boolean,
  maxUploadSize: Schema.Number,
  allowedOrigins: Schema.Array(Schema.String),
})

const featureFlags = Config.getJson("FEATURE_FLAGS", FeatureFlagsSchema)

// Use in program
const program = Effect.gen(function* () {
  const config = yield* Config

  const key = yield* config.getSecret("API_KEY")
  const retries = yield* config.getOrElse("MAX_RETRIES", "3")

  console.log(`Using API key: ${key.substring(0, 4)}...`)
  console.log(`Max retries: ${retries}`)
})
```

**Common Pitfalls**:

1. **Don't access env directly**: Always use the Config service for type safety and error handling.
2. **Secret masking**: When logging, never log the full secret value.
3. **Environment-specific config**: Use different wrangler.toml `[env]` sections for dev/staging/prod.

### 3.2 Database Service (Drizzle + D1)

The Database service provides a swappable abstraction over Drizzle ORM with D1.

**Step 1: Define Database Schema**

Create `src/db/schema.ts`:

```typescript
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"

/**
 * Users table
 */
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
})

/**
 * Posts table
 */
export const posts = sqliteTable("posts", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  authorId: text("author_id")
    .notNull()
    .references(() => users.id),
  published: integer("published", { mode: "boolean" })
    .notNull()
    .default(false),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
})

/**
 * Schema type export
 */
export const schema = {
  users,
  posts,
}

export type Schema = typeof schema
```

**Step 2: Create Migration**

Create `drizzle.config.ts`:

```typescript
import type { Config } from "drizzle-kit"

export default {
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  driver: "d1",
  dbCredentials: {
    wranglerConfigPath: "./wrangler.toml",
    dbName: "effect-worker-db",
  },
} satisfies Config
```

Generate migration:

```bash
npx drizzle-kit generate:sqlite
```

This creates a migration file in `src/db/migrations/`.

**Step 3: Implement Database Service**

Create `src/services/database.ts`:

```typescript
import { Context, Effect, Layer } from "effect"
import { drizzle } from "drizzle-orm/d1"
import type { DrizzleD1Database } from "drizzle-orm/d1"
import { CloudflareBindings } from "./bindings"
import { DatabaseError } from "../errors"
import { schema, type Schema } from "../db/schema"

/**
 * Database Service Interface
 *
 * Provides access to Drizzle client and transaction handling.
 */
export interface DatabaseService {
  /**
   * Drizzle client for direct queries
   */
  readonly client: DrizzleD1Database<Schema>

  /**
   * Execute a function within a database transaction
   *
   * @example
   * const result = yield* db.transaction((tx) =>
   *   Effect.gen(function* () {
   *     yield* Effect.promise(() => tx.insert(users).values({ ... }))
   *     yield* Effect.promise(() => tx.insert(posts).values({ ... }))
   *     return "success"
   *   })
   * )
   */
  readonly transaction: <A, E, R>(
    effect: (tx: DrizzleD1Database<Schema>) => Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | DatabaseError, R>

  /**
   * Execute a raw SQL query
   */
  readonly execute: <T = unknown>(
    query: string,
    params?: unknown[]
  ) => Effect.Effect<T[], DatabaseError>
}

/**
 * Database Service Tag
 */
export class Database extends Context.Tag("Database")<
  Database,
  DatabaseService
>() {}

/**
 * Live D1 Database Implementation
 *
 * Uses Cloudflare D1 as the backing database.
 */
export const DatabaseD1Live = Layer.effect(
  Database,
  Effect.gen(function* () {
    const { env } = yield* CloudflareBindings
    const d1 = env.DB

    // Create Drizzle client
    const client = drizzle(d1, { schema })

    return Database.of({
      client,

      transaction: <A, E, R>(
        effect: (tx: DrizzleD1Database<Schema>) => Effect.Effect<A, E, R>
      ) =>
        Effect.tryPromise({
          try: async () => {
            // D1 doesn't support nested transactions, so we use batch
            return await client.batch([
              // Execute the effect and return its result
              effect(client) as any,
            ]).then(([result]) => result)
          },
          catch: (error) =>
            new DatabaseError({
              operation: "transaction",
              message: `Transaction failed: ${error}`,
              cause: error,
            }),
        }),

      execute: <T = unknown>(query: string, params?: unknown[]) =>
        Effect.tryPromise({
          try: async () => {
            const statement = d1.prepare(query)
            if (params && params.length > 0) {
              statement.bind(...params)
            }
            const result = await statement.all<T>()
            return result.results
          },
          catch: (error) =>
            new DatabaseError({
              operation: "execute",
              message: `Query execution failed: ${error}`,
              cause: error,
            }),
        }),
    })
  })
).pipe(Layer.provide(CloudflareBindings.Default))

/**
 * Default Database Layer
 */
Database.Default = DatabaseD1Live
```

**Why This Matters**:

1. **Type Safety**: Drizzle provides full TypeScript support for queries
2. **Swappable**: Easy to swap D1 for PostgreSQL, MySQL, or SQLite for local dev
3. **Transaction Support**: Effect-based transactions with proper error handling
4. **Raw Query Escape Hatch**: For complex queries not supported by Drizzle

**Usage Examples**:

```typescript
import { Effect } from "effect"
import { Database } from "./services/database"
import { users, posts } from "./db/schema"
import { eq } from "drizzle-orm"

// Insert a user
const createUser = (email: string, name: string) =>
  Effect.gen(function* () {
    const db = yield* Database

    const [user] = yield* Effect.tryPromise(() =>
      db.client
        .insert(users)
        .values({
          id: crypto.randomUUID(),
          email,
          name,
        })
        .returning()
    )

    return user
  })

// Query users
const getUserByEmail = (email: string) =>
  Effect.gen(function* () {
    const db = yield* Database

    const [user] = yield* Effect.tryPromise(() =>
      db.client
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1)
    )

    return user
  })

// Transaction example
const createUserWithPost = (email: string, name: string, postTitle: string) =>
  Effect.gen(function* () {
    const db = yield* Database

    return yield* db.transaction((tx) =>
      Effect.gen(function* () {
        const [user] = yield* Effect.tryPromise(() =>
          tx.insert(users).values({
            id: crypto.randomUUID(),
            email,
            name,
          }).returning()
        )

        const [post] = yield* Effect.tryPromise(() =>
          tx.insert(posts).values({
            id: crypto.randomUUID(),
            title: postTitle,
            content: "",
            authorId: user.id,
          }).returning()
        )

        return { user, post }
      })
    )
  })
```

**Migration Strategy**:

For local development:

```bash
# Apply migrations locally
pnpm db:migrate

# Apply to production
pnpm db:migrate:prod
```

Create migration files in `src/db/migrations/` manually or use `drizzle-kit generate`.

**Common Pitfalls**:

1. **D1 Limitations**: D1 doesn't support all SQLite features (e.g., no foreign key enforcement in early versions)
2. **No Connection Pooling**: Each request gets a fresh D1 client (isolate model)
3. **Cold Start Latency**: First query might be slower due to D1 cold start

### 3.3 KV Store Service

The KV Store service abstracts Cloudflare KV operations.

Create `src/services/kv.ts`:

```typescript
import { Context, Effect, Layer, Option } from "effect"
import type { KVNamespace } from "@cloudflare/workers-types"
import { Schema } from "@effect/schema"
import { CloudflareBindings } from "./bindings"
import { KVError } from "../errors"

/**
 * KV Store Service Interface
 */
export interface KVService {
  /**
   * Get a value by key
   */
  readonly get: (key: string) => Effect.Effect<Option.Option<string>, KVError>

  /**
   * Get a value with metadata
   */
  readonly getWithMetadata: <A, I, R>(
    key: string,
    schema: Schema.Schema<A, I, R>
  ) => Effect.Effect<
    Option.Option<{ value: string; metadata: A }>,
    KVError,
    R
  >

  /**
   * Set a value
   */
  readonly set: (
    key: string,
    value: string,
    options?: {
      expirationTtl?: number
      expiration?: number
      metadata?: unknown
    }
  ) => Effect.Effect<void, KVError>

  /**
   * Delete a key
   */
  readonly delete: (key: string) => Effect.Effect<void, KVError>

  /**
   * List keys with optional prefix
   */
  readonly list: (options?: {
    prefix?: string
    limit?: number
    cursor?: string
  }) => Effect.Effect<
    { keys: Array<{ name: string }>; cursor?: string },
    KVError
  >

  /**
   * Get JSON value with schema validation
   */
  readonly getJson: <A, I, R>(
    key: string,
    schema: Schema.Schema<A, I, R>
  ) => Effect.Effect<Option.Option<A>, KVError, R>

  /**
   * Set JSON value
   */
  readonly setJson: <A>(
    key: string,
    value: A,
    options?: {
      expirationTtl?: number
      expiration?: number
    }
  ) => Effect.Effect<void, KVError>
}

/**
 * KV Store Tag
 */
export class KVStore extends Context.Tag("KVStore")<KVStore, KVService>() {}

/**
 * Cloudflare KV Implementation
 *
 * @param bindingName - The name of the KV binding in wrangler.toml
 */
export const KVStoreCloudflare = (bindingName: keyof CloudflareBindings["Type"]["env"]) =>
  Layer.effect(
    KVStore,
    Effect.gen(function* () {
      const { env } = yield* CloudflareBindings
      const kv = env[bindingName] as KVNamespace

      return KVStore.of({
        get: (key: string) =>
          Effect.tryPromise({
            try: () => kv.get(key),
            catch: (error) =>
              new KVError({
                operation: "get",
                key,
                message: `Failed to get key "${key}"`,
                cause: error,
              }),
          }).pipe(Effect.map(Option.fromNullable)),

        getWithMetadata: <A, I, R>(
          key: string,
          schema: Schema.Schema<A, I, R>
        ) =>
          Effect.gen(function* () {
            const result = yield* Effect.tryPromise({
              try: () => kv.getWithMetadata(key),
              catch: (error) =>
                new KVError({
                  operation: "getWithMetadata",
                  key,
                  message: `Failed to get metadata for key "${key}"`,
                  cause: error,
                }),
            })

            if (result.value === null) {
              return Option.none()
            }

            const metadata = yield* Schema.decodeUnknown(schema)(
              result.metadata
            ).pipe(
              Effect.mapError(
                (error) =>
                  new KVError({
                    operation: "getWithMetadata",
                    key,
                    message: `Metadata validation failed: ${error}`,
                    cause: error,
                  })
              )
            )

            return Option.some({
              value: result.value,
              metadata,
            })
          }),

        set: (key: string, value: string, options) =>
          Effect.tryPromise({
            try: () => kv.put(key, value, options),
            catch: (error) =>
              new KVError({
                operation: "set",
                key,
                message: `Failed to set key "${key}"`,
                cause: error,
              }),
          }),

        delete: (key: string) =>
          Effect.tryPromise({
            try: () => kv.delete(key),
            catch: (error) =>
              new KVError({
                operation: "delete",
                key,
                message: `Failed to delete key "${key}"`,
                cause: error,
              }),
          }),

        list: (options) =>
          Effect.tryPromise({
            try: () => kv.list(options),
            catch: (error) =>
              new KVError({
                operation: "list",
                message: "Failed to list keys",
                cause: error,
              }),
          }).pipe(
            Effect.map((result) => ({
              keys: result.keys,
              cursor: result.list_complete ? undefined : result.cursor,
            }))
          ),

        getJson: <A, I, R>(key: string, schema: Schema.Schema<A, I, R>) =>
          Effect.gen(function* () {
            const value = yield* KVStore.get(key)

            if (Option.isNone(value)) {
              return Option.none()
            }

            let parsed: unknown
            try {
              parsed = JSON.parse(value.value)
            } catch (error) {
              return yield* Effect.fail(
                new KVError({
                  operation: "getJson",
                  key,
                  message: `Invalid JSON in key "${key}"`,
                  cause: error,
                })
              )
            }

            const decoded = yield* Schema.decodeUnknown(schema)(parsed).pipe(
              Effect.mapError(
                (error) =>
                  new KVError({
                    operation: "getJson",
                    key,
                    message: `Schema validation failed: ${error}`,
                    cause: error,
                  })
              )
            )

            return Option.some(decoded)
          }),

        setJson: <A>(key: string, value: A, options) =>
          Effect.gen(function* () {
            const json = JSON.stringify(value)
            yield* KVStore.set(key, json, options)
          }),
      })
    })
  ).pipe(Layer.provide(CloudflareBindings.Default))

/**
 * In-Memory KV Implementation (for testing)
 */
export const KVStoreMemory = Layer.sync(KVStore, () => {
  const store = new Map<
    string,
    { value: string; metadata?: unknown; expiresAt?: number }
  >()

  return KVStore.of({
    get: (key: string) =>
      Effect.sync(() => {
        const item = store.get(key)
        if (!item) return Option.none()

        // Check expiration
        if (item.expiresAt && Date.now() > item.expiresAt) {
          store.delete(key)
          return Option.none()
        }

        return Option.some(item.value)
      }),

    getWithMetadata: <A, I, R>(
      key: string,
      schema: Schema.Schema<A, I, R>
    ) =>
      Effect.gen(function* () {
        const item = store.get(key)
        if (!item) return Option.none()

        if (item.expiresAt && Date.now() > item.expiresAt) {
          store.delete(key)
          return Option.none()
        }

        const metadata = yield* Schema.decodeUnknown(schema)(
          item.metadata
        ).pipe(
          Effect.mapError(
            (error) =>
              new KVError({
                operation: "getWithMetadata",
                key,
                message: `Metadata validation failed: ${error}`,
                cause: error,
              })
          )
        )

        return Option.some({ value: item.value, metadata })
      }),

    set: (key: string, value: string, options) =>
      Effect.sync(() => {
        const expiresAt = options?.expirationTtl
          ? Date.now() + options.expirationTtl * 1000
          : options?.expiration
            ? options.expiration * 1000
            : undefined

        store.set(key, {
          value,
          metadata: options?.metadata,
          expiresAt,
        })
      }),

    delete: (key: string) =>
      Effect.sync(() => {
        store.delete(key)
      }),

    list: (options) =>
      Effect.sync(() => {
        const keys: Array<{ name: string }> = []
        const prefix = options?.prefix ?? ""
        const limit = options?.limit ?? 1000

        for (const [key] of store) {
          if (key.startsWith(prefix)) {
            keys.push({ name: key })
          }
          if (keys.length >= limit) break
        }

        return { keys }
      }),

    getJson: <A, I, R>(key: string, schema: Schema.Schema<A, I, R>) =>
      Effect.gen(function* () {
        const value = yield* KVStore.get(key)
        if (Option.isNone(value)) return Option.none()

        const parsed = JSON.parse(value.value)
        const decoded = yield* Schema.decodeUnknown(schema)(parsed).pipe(
          Effect.mapError(
            (error) =>
              new KVError({
                operation: "getJson",
                key,
                message: `Schema validation failed: ${error}`,
                cause: error,
              })
          )
        )

        return Option.some(decoded)
      }),

    setJson: <A>(key: string, value: A, options) =>
      KVStore.set(key, JSON.stringify(value), options),
  })
})

/**
 * Default KV Layer (using MY_KV binding)
 */
KVStore.Default = KVStoreCloudflare("MY_KV")
```

**Usage Examples**:

```typescript
import { Effect, Option } from "effect"
import { KVStore } from "./services/kv"
import { Schema } from "@effect/schema"

// Simple string storage
const cacheUserData = (userId: string, data: string) =>
  Effect.gen(function* () {
    const kv = yield* KVStore

    // Cache for 1 hour
    yield* kv.set(`user:${userId}`, data, { expirationTtl: 3600 })
  })

// JSON storage with schema
const UserSchema = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  name: Schema.String,
})

const cacheUser = (user: Schema.Schema.Type<typeof UserSchema>) =>
  Effect.gen(function* () {
    const kv = yield* KVStore
    yield* kv.setJson(`user:${user.id}`, user, { expirationTtl: 3600 })
  })

const getCachedUser = (userId: string) =>
  Effect.gen(function* () {
    const kv = yield* KVStore
    const cached = yield* kv.getJson(`user:${userId}`, UserSchema)

    if (Option.isSome(cached)) {
      return cached.value
    }

    // Fetch from database if not cached
    return yield* fetchUserFromDb(userId)
  })

// Metadata example
const MetadataSchema = Schema.Struct({
  createdAt: Schema.Number,
  version: Schema.Number,
})

const setWithMetadata = (key: string, value: string) =>
  Effect.gen(function* () {
    const kv = yield* KVStore

    yield* kv.set(key, value, {
      metadata: {
        createdAt: Date.now(),
        version: 1,
      },
    })
  })
```

**Performance Considerations**:

- **KV Eventual Consistency**: Writes may take up to 60 seconds to propagate globally
- **Size Limits**: 25 MB per value, 512 bytes per key
- **Read Performance**: Reads are extremely fast (single-digit milliseconds)
- **TTL Precision**: TTL is approximate, not exact

### 3.4 Object Storage Service (R2)

The Object Storage service abstracts R2 bucket operations.

Create `src/services/storage.ts`:

```typescript
import { Context, Effect, Layer, Option } from "effect"
import type {
  R2Bucket,
  R2Object,
  R2ObjectBody,
  R2ListOptions,
  R2PutOptions,
} from "@cloudflare/workers-types"
import { CloudflareBindings } from "./bindings"
import { StorageError } from "../errors"

/**
 * Object Storage Service Interface
 */
export interface ObjectStorageService {
  /**
   * Get an object by key
   */
  readonly get: (
    key: string
  ) => Effect.Effect<Option.Option<R2ObjectBody>, StorageError>

  /**
   * Get object metadata without downloading the body
   */
  readonly head: (
    key: string
  ) => Effect.Effect<Option.Option<R2Object>, StorageError>

  /**
   * Put an object
   */
  readonly put: (
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob,
    options?: R2PutOptions
  ) => Effect.Effect<R2Object, StorageError>

  /**
   * Delete an object
   */
  readonly delete: (key: string) => Effect.Effect<void, StorageError>

  /**
   * Delete multiple objects
   */
  readonly deleteMany: (keys: string[]) => Effect.Effect<void, StorageError>

  /**
   * List objects
   */
  readonly list: (
    options?: R2ListOptions
  ) => Effect.Effect<
    {
      objects: R2Object[]
      truncated: boolean
      cursor?: string
    },
    StorageError
  >

  /**
   * Check if an object exists
   */
  readonly exists: (key: string) => Effect.Effect<boolean, StorageError>

  /**
   * Get object as text
   */
  readonly getText: (
    key: string
  ) => Effect.Effect<Option.Option<string>, StorageError>

  /**
   * Get object as JSON with schema validation
   */
  readonly getJson: <A, I, R>(
    key: string,
    schema: Schema.Schema<A, I, R>
  ) => Effect.Effect<Option.Option<A>, StorageError, R>

  /**
   * Put JSON object
   */
  readonly putJson: <A>(
    key: string,
    value: A,
    options?: Omit<R2PutOptions, "httpMetadata">
  ) => Effect.Effect<R2Object, StorageError>
}

/**
 * Object Storage Tag
 */
export class ObjectStorage extends Context.Tag("ObjectStorage")<
  ObjectStorage,
  ObjectStorageService
>() {}

/**
 * Cloudflare R2 Implementation
 *
 * @param bindingName - The name of the R2 binding in wrangler.toml
 */
export const ObjectStorageR2 = (
  bindingName: keyof CloudflareBindings["Type"]["env"]
) =>
  Layer.effect(
    ObjectStorage,
    Effect.gen(function* () {
      const { env } = yield* CloudflareBindings
      const r2 = env[bindingName] as R2Bucket

      return ObjectStorage.of({
        get: (key: string) =>
          Effect.tryPromise({
            try: () => r2.get(key),
            catch: (error) =>
              new StorageError({
                operation: "get",
                key,
                message: `Failed to get object "${key}"`,
                cause: error,
              }),
          }).pipe(Effect.map(Option.fromNullable)),

        head: (key: string) =>
          Effect.tryPromise({
            try: () => r2.head(key),
            catch: (error) =>
              new StorageError({
                operation: "head",
                key,
                message: `Failed to get object metadata "${key}"`,
                cause: error,
              }),
          }).pipe(Effect.map(Option.fromNullable)),

        put: (key: string, value, options) =>
          Effect.tryPromise({
            try: () => r2.put(key, value, options),
            catch: (error) =>
              new StorageError({
                operation: "put",
                key,
                message: `Failed to put object "${key}"`,
                cause: error,
              }),
          }),

        delete: (key: string) =>
          Effect.tryPromise({
            try: () => r2.delete(key),
            catch: (error) =>
              new StorageError({
                operation: "delete",
                key,
                message: `Failed to delete object "${key}"`,
                cause: error,
              }),
          }),

        deleteMany: (keys: string[]) =>
          Effect.tryPromise({
            try: () => r2.delete(keys),
            catch: (error) =>
              new StorageError({
                operation: "deleteMany",
                message: `Failed to delete ${keys.length} objects`,
                cause: error,
              }),
          }),

        list: (options) =>
          Effect.tryPromise({
            try: () => r2.list(options),
            catch: (error) =>
              new StorageError({
                operation: "list",
                message: "Failed to list objects",
                cause: error,
              }),
          }),

        exists: (key: string) =>
          Effect.gen(function* () {
            const obj = yield* ObjectStorage.head(key)
            return Option.isSome(obj)
          }),

        getText: (key: string) =>
          Effect.gen(function* () {
            const obj = yield* ObjectStorage.get(key)

            if (Option.isNone(obj)) {
              return Option.none()
            }

            const text = yield* Effect.tryPromise({
              try: () => obj.value.text(),
              catch: (error) =>
                new StorageError({
                  operation: "getText",
                  key,
                  message: `Failed to read text from "${key}"`,
                  cause: error,
                }),
            })

            return Option.some(text)
          }),

        getJson: <A, I, R>(key: string, schema: Schema.Schema<A, I, R>) =>
          Effect.gen(function* () {
            const text = yield* ObjectStorage.getText(key)

            if (Option.isNone(text)) {
              return Option.none()
            }

            let parsed: unknown
            try {
              parsed = JSON.parse(text.value)
            } catch (error) {
              return yield* Effect.fail(
                new StorageError({
                  operation: "getJson",
                  key,
                  message: `Invalid JSON in object "${key}"`,
                  cause: error,
                })
              )
            }

            const decoded = yield* Schema.decodeUnknown(schema)(parsed).pipe(
              Effect.mapError(
                (error) =>
                  new StorageError({
                    operation: "getJson",
                    key,
                    message: `Schema validation failed: ${error}`,
                    cause: error,
                  })
              )
            )

            return Option.some(decoded)
          }),

        putJson: <A>(key: string, value: A, options) =>
          Effect.gen(function* () {
            const json = JSON.stringify(value)

            return yield* ObjectStorage.put(key, json, {
              ...options,
              httpMetadata: {
                ...options?.httpMetadata,
                contentType: "application/json",
              },
            })
          }),
      })
    })
  ).pipe(Layer.provide(CloudflareBindings.Default))

/**
 * Default Object Storage Layer (using MY_BUCKET binding)
 */
ObjectStorage.Default = ObjectStorageR2("MY_BUCKET")
```

**Usage Examples**:

```typescript
import { Effect, Option } from "effect"
import { ObjectStorage } from "./services/storage"
import { Schema } from "@effect/schema"

// Upload a file
const uploadFile = (key: string, file: File) =>
  Effect.gen(function* () {
    const storage = yield* ObjectStorage

    const obj = yield* storage.put(key, file, {
      httpMetadata: {
        contentType: file.type,
      },
      customMetadata: {
        uploadedAt: new Date().toISOString(),
      },
    })

    return obj.key
  })

// Download as text
const downloadTextFile = (key: string) =>
  Effect.gen(function* () {
    const storage = yield* ObjectStorage
    const text = yield* storage.getText(key)

    return text
  })

// Stream large file
const downloadLargeFile = (key: string) =>
  Effect.gen(function* () {
    const storage = yield* ObjectStorage
    const obj = yield* storage.get(key)

    if (Option.isNone(obj)) {
      return new Response("Not found", { status: 404 })
    }

    // Stream the response
    return new Response(obj.value.body, {
      headers: {
        "Content-Type": obj.value.httpMetadata?.contentType ?? "application/octet-stream",
        "Content-Length": obj.value.size.toString(),
      },
    })
  })

// JSON storage
const DocumentSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  content: Schema.String,
})

const saveDocument = (doc: Schema.Schema.Type<typeof DocumentSchema>) =>
  Effect.gen(function* () {
    const storage = yield* ObjectStorage
    yield* storage.putJson(`documents/${doc.id}.json`, doc)
  })

// List all documents
const listDocuments = () =>
  Effect.gen(function* () {
    const storage = yield* ObjectStorage

    const result = yield* storage.list({
      prefix: "documents/",
      limit: 100,
    })

    return result.objects.map((obj) => obj.key)
  })
```

**Performance Considerations**:

- **No Size Limits**: R2 supports objects up to 5 TB
- **Streaming**: Use `body` stream for large files to avoid memory issues
- **Class Transition**: Set lifecycle policies for automatic archival
- **Multipart Uploads**: For objects >100 MB, use multipart uploads

---

## Runtime Factory Patterns

The runtime factory creates a ManagedRuntime per request (or per isolate) with all necessary services.

### 4.1 Basic Runtime Factory

Create `src/runtime.ts`:

```typescript
import { Layer, ManagedRuntime } from "effect"
import { CloudflareBindings, type Env } from "./services/bindings"
import type { ExecutionContext } from "@cloudflare/workers-types"
import { AppLive } from "./app"

/**
 * Create a ManagedRuntime for a request
 *
 * This function creates a fresh runtime with all services bootstrapped
 * for the given Cloudflare environment and execution context.
 *
 * **Important**: Call this once per request and dispose after use.
 */
export const makeRuntime = (env: Env, ctx: ExecutionContext) => {
  // Create the bindings layer with env and ctx
  const bindingsLayer = CloudflareBindings.layer(env, ctx)

  // Provide bindings to the application layer
  const appLayer = AppLive.pipe(Layer.provide(bindingsLayer))

  // Create and return the runtime
  return ManagedRuntime.make(appLayer)
}

/**
 * Type of the runtime created by makeRuntime
 */
export type AppRuntime = ReturnType<typeof makeRuntime>
```

**Why This Pattern**:

1. **Request Scoped**: Each request gets a fresh runtime with its own service instances
2. **Proper Cleanup**: ManagedRuntime handles resource cleanup via `dispose()`
3. **Type Safe**: The runtime type is inferred from AppLive

### 4.2 Optimized Runtime with Caching

For better performance, cache the runtime at the isolate level:

```typescript
import { Layer, ManagedRuntime } from "effect"
import { CloudflareBindings, type Env } from "./services/bindings"
import type { ExecutionContext } from "@cloudflare/workers-types"
import { AppLive } from "./app"

/**
 * Cached runtime and env reference
 *
 * These are cached at the isolate level (not request level).
 * The runtime is reused across requests in the same isolate.
 */
let cachedRuntime: ReturnType<typeof ManagedRuntime.make<typeof AppLive>> | null = null
let cachedEnv: Env | null = null

/**
 * Get or create runtime
 *
 * This implementation caches the runtime per isolate for better performance.
 * The runtime is only recreated if the env reference changes (new isolate).
 *
 * **Why This Works**:
 * - Cloudflare reuses isolates for multiple requests
 * - The env object reference is stable within an isolate
 * - Services are still instantiated per-request via Layer memoization
 */
export const getOrCreateRuntime = (env: Env, ctx: ExecutionContext) => {
  // Check if we need to create a new runtime
  if (cachedRuntime === null || cachedEnv !== env) {
    // Dispose old runtime if it exists
    if (cachedRuntime !== null) {
      cachedRuntime.dispose()
    }

    // Create new runtime
    const bindingsLayer = CloudflareBindings.layer(env, ctx)
    const appLayer = AppLive.pipe(Layer.provide(bindingsLayer))
    cachedRuntime = ManagedRuntime.make(appLayer)
    cachedEnv = env
  }

  return cachedRuntime
}

/**
 * Simple runtime factory (no caching)
 *
 * Use this if you want a fresh runtime per request.
 */
export const makeRuntime = (env: Env, ctx: ExecutionContext) => {
  const bindingsLayer = CloudflareBindings.layer(env, ctx)
  const appLayer = AppLive.pipe(Layer.provide(bindingsLayer))
  return ManagedRuntime.make(appLayer)
}
```

**Performance Trade-offs**:

| Approach | Cold Start | Warm Request | Memory |
|----------|------------|--------------|--------|
| Per-Request | Higher | Higher | Lower |
| Cached (Isolate) | Higher (first) | Lower | Higher |

**Recommendation**: Use cached runtime for production, per-request for testing.

### 4.3 Common Pitfalls

**Pitfall 1: Not Disposing Runtime**

```typescript
// ❌ WRONG: Memory leak
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const runtime = makeRuntime(env, ctx)
    return runtime.runPromise(handleRequest(request))
    // Runtime is never disposed!
  }
}

// ✅ CORRECT: Proper cleanup
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const runtime = makeRuntime(env, ctx)
    try {
      return await runtime.runPromise(handleRequest(request))
    } finally {
      await runtime.dispose()
    }
  }
}
```

**Pitfall 2: Creating Runtime at Module Level**

```typescript
// ❌ WRONG: env not available at module level
const runtime = makeRuntime(env, ctx) // ReferenceError

// ✅ CORRECT: Create in handler
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const runtime = makeRuntime(env, ctx)
    // ...
  }
}
```

---

## Handler Implementation

Handlers are the entry points for your worker (fetch, queue, scheduled, etc.).

### 5.1 Fetch Handler

Create `src/handlers/fetch.ts`:

```typescript
import { Effect } from "effect"
import { Schema } from "@effect/schema"
import type { Database, Config, KVStore, ObjectStorage } from "../services"

/**
 * Handle HTTP requests
 *
 * This is the main request handler that routes to different endpoints.
 */
export const handleRequest = (request: Request) =>
  Effect.gen(function* () {
    const url = new URL(request.url)
    const { pathname, searchParams } = url

    // Health check endpoint
    if (pathname === "/health") {
      return new Response("OK", { status: 200 })
    }

    // API routes
    if (pathname.startsWith("/api/")) {
      return yield* handleApiRequest(request)
    }

    // Not found
    return new Response("Not Found", { status: 404 })
  })

/**
 * Handle API requests
 */
const handleApiRequest = (request: Request) =>
  Effect.gen(function* () {
    const url = new URL(request.url)
    const { pathname } = url

    // Example: GET /api/users
    if (pathname === "/api/users" && request.method === "GET") {
      return yield* getUsers(request)
    }

    // Example: POST /api/users
    if (pathname === "/api/users" && request.method === "POST") {
      return yield* createUser(request)
    }

    // Example: GET /api/users/:id
    const userMatch = pathname.match(/^\/api\/users\/([^/]+)$/)
    if (userMatch && request.method === "GET") {
      const userId = userMatch[1]
      return yield* getUser(userId)
    }

    return new Response("Not Found", { status: 404 })
  })

/**
 * Get all users
 */
const getUsers = (request: Request) =>
  Effect.gen(function* () {
    const db = yield* Database

    const users = yield* Effect.tryPromise(() =>
      db.client.select().from(users).limit(100)
    )

    return Response.json(users)
  })

/**
 * Get a single user
 */
const getUser = (userId: string) =>
  Effect.gen(function* () {
    const db = yield* Database
    const kv = yield* KVStore

    // Try cache first
    const UserSchema = Schema.Struct({
      id: Schema.String,
      email: Schema.String,
      name: Schema.String,
    })

    const cached = yield* kv.getJson(`user:${userId}`, UserSchema)

    if (Option.isSome(cached)) {
      return Response.json(cached.value, {
        headers: { "X-Cache": "HIT" },
      })
    }

    // Fetch from database
    const [user] = yield* Effect.tryPromise(() =>
      db.client
        .select()
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
    )

    if (!user) {
      return new Response("User not found", { status: 404 })
    }

    // Cache for 1 hour
    yield* kv.setJson(`user:${userId}`, user, { expirationTtl: 3600 })

    return Response.json(user, {
      headers: { "X-Cache": "MISS" },
    })
  })

/**
 * Create a user
 */
const createUser = (request: Request) =>
  Effect.gen(function* () {
    const db = yield* Database

    // Parse and validate request body
    const CreateUserSchema = Schema.Struct({
      email: Schema.String.pipe(Schema.pattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)),
      name: Schema.String.pipe(Schema.minLength(1)),
    })

    const body = yield* parseJsonBody(request, CreateUserSchema)

    // Insert user
    const [user] = yield* Effect.tryPromise(() =>
      db.client
        .insert(users)
        .values({
          id: crypto.randomUUID(),
          email: body.email,
          name: body.name,
        })
        .returning()
    )

    return Response.json(user, { status: 201 })
  })

/**
 * Parse and validate JSON request body
 */
const parseJsonBody = <A, I, R>(
  request: Request,
  schema: Schema.Schema<A, I, R>
) =>
  Effect.gen(function* () {
    // Parse JSON
    let json: unknown
    try {
      json = yield* Effect.tryPromise(() => request.json())
    } catch (error) {
      return yield* Effect.fail(
        new ValidationError({
          message: "Invalid JSON",
          errors: [error],
        })
      )
    }

    // Validate with schema
    return yield* Schema.decodeUnknown(schema)(json).pipe(
      Effect.mapError(
        (error) =>
          new ValidationError({
            message: "Validation failed",
            errors: [error],
          })
      )
    )
  })
```

### 5.2 Error Response Formatting

Create `src/handlers/errors.ts`:

```typescript
import { Effect, Match } from "effect"
import type {
  ConfigError,
  DatabaseError,
  KVError,
  StorageError,
  ValidationError,
} from "../errors"

/**
 * Convert an error to an HTTP response
 */
export const errorToResponse = (
  error: ConfigError | DatabaseError | KVError | StorageError | ValidationError
): Response => {
  const { status, body } = Match.value(error).pipe(
    Match.tag("ConfigError", (e) => ({
      status: 500,
      body: {
        error: "ConfigError",
        message: e.message,
        key: e.key,
      },
    })),
    Match.tag("DatabaseError", (e) => ({
      status: 503,
      body: {
        error: "DatabaseError",
        message: e.message,
        operation: e.operation,
      },
    })),
    Match.tag("KVError", (e) => ({
      status: 503,
      body: {
        error: "KVError",
        message: e.message,
        operation: e.operation,
      },
    })),
    Match.tag("StorageError", (e) => ({
      status: 503,
      body: {
        error: "StorageError",
        message: e.message,
        operation: e.operation,
      },
    })),
    Match.tag("ValidationError", (e) => ({
      status: 400,
      body: {
        error: "ValidationError",
        message: e.message,
        errors: e.errors,
      },
    })),
    Match.orElse(() => ({
      status: 500,
      body: {
        error: "UnknownError",
        message: String(error),
      },
    }))
  )

  return Response.json(body, { status })
}

/**
 * Wrap a handler with error handling
 */
export const withErrorHandling = <A, E, R>(
  effect: Effect.Effect<Response, E, R>
) =>
  effect.pipe(
    Effect.catchAll((error) =>
      Effect.succeed(errorToResponse(error as any))
    ),
    Effect.catchAllDefect((defect) => {
      // Log defects (unexpected errors)
      console.error("Defect:", defect)

      return Effect.succeed(
        Response.json(
          {
            error: "InternalServerError",
            message: "An unexpected error occurred",
          },
          { status: 500 }
        )
      )
    })
  )
```

### 5.3 Main Worker Entry Point

Create `src/worker.ts`:

```typescript
import { Effect, ConfigProvider } from "effect"
import type { Env } from "./services/bindings"
import type { ExecutionContext } from "@cloudflare/workers-types"
import { getOrCreateRuntime } from "./runtime"
import { handleRequest } from "./handlers/fetch"
import { withErrorHandling } from "./handlers/errors"

/**
 * Cloudflare Worker Fetch Handler
 */
const fetch = async (
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> => {
  // Get or create runtime
  const runtime = getOrCreateRuntime(env, ctx)

  // Create the program
  const program = handleRequest(request).pipe(
    withErrorHandling,
    // Make env available to Effect's Config system
    Effect.withConfigProvider(ConfigProvider.fromJson(env))
  )

  // Run the program
  try {
    return await runtime.runPromise(program)
  } catch (error) {
    // This should never happen if withErrorHandling is used correctly
    console.error("Unhandled error:", error)
    return new Response("Internal Server Error", { status: 500 })
  }
}

/**
 * Export default handler
 */
export default {
  fetch,
}
```

**Why ConfigProvider.fromJson**:

Effect's built-in `Config` system can read from the env object when you provide it via `ConfigProvider.fromJson(env)`. This allows you to use Effect's Config API alongside the custom Config service.

---

## Application Layer Composition

The application layer composes all service layers into a single layer graph.

Create `src/app.ts`:

```typescript
import { Layer } from "effect"
import {
  CloudflareBindings,
  Config,
  ConfigLive,
  Database,
  DatabaseD1Live,
  KVStore,
  ObjectStorage,
} from "./services"

/**
 * Application Layer
 *
 * This layer composes all infrastructure services.
 * Services are automatically memoized - each service is instantiated once per request.
 *
 * **Layer Dependencies**:
 * - All infrastructure services depend on CloudflareBindings
 * - CloudflareBindings is provided at runtime creation time
 */
export const AppLive = Layer.mergeAll(
  ConfigLive,
  DatabaseD1Live,
  KVStore.Default, // Uses MY_KV binding
  ObjectStorage.Default, // Uses MY_BUCKET binding
)

/**
 * Application Dependencies Type
 *
 * This type represents all services available in the application.
 */
export type AppDependencies = Layer.Layer.Success<typeof AppLive>
```

**Why This Works**:

1. **Layer.mergeAll**: Combines multiple layers into a single layer
2. **Automatic Memoization**: Each service is instantiated once per request
3. **Type Inference**: `AppDependencies` automatically includes all services

**Adding New Services**:

```typescript
// Add a new service
import { EmailService } from "./services/email"

export const AppLive = Layer.mergeAll(
  ConfigLive,
  DatabaseD1Live,
  KVStore.Default,
  ObjectStorage.Default,
  EmailService.Default, // New service
)
```

**Common Pitfall: Providing Layers Multiple Times**

```typescript
// ❌ WRONG: Creates multiple Database instances
export const AppLive = Layer.mergeAll(
  ServiceA.Default.pipe(Layer.provide(DatabaseD1Live)),
  ServiceB.Default.pipe(Layer.provide(DatabaseD1Live)), // New instance!
)

// ✅ CORRECT: Single Database instance
const DbLive = DatabaseD1Live

export const AppLive = Layer.mergeAll(
  ServiceA.Default,
  ServiceB.Default,
).pipe(Layer.provide(DbLive))
```

---

## Error Architecture

All errors extend `Data.TaggedError` for type-safe pattern matching.

Create `src/errors/index.ts`:

```typescript
import { Data } from "effect"

/**
 * Base Worker Error
 */
export class WorkerError extends Data.TaggedError("WorkerError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Configuration Error
 *
 * Thrown when a config key is missing or invalid.
 */
export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly key: string
  readonly message: string
}> {}

/**
 * Database Error
 *
 * Thrown when a database operation fails.
 */
export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly operation: string
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * KV Error
 *
 * Thrown when a KV operation fails.
 */
export class KVError extends Data.TaggedError("KVError")<{
  readonly operation: string
  readonly key?: string
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Storage Error
 *
 * Thrown when an R2 operation fails.
 */
export class StorageError extends Data.TaggedError("StorageError")<{
  readonly operation: string
  readonly key?: string
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Validation Error
 *
 * Thrown when request validation fails.
 */
export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly message: string
  readonly errors: ReadonlyArray<unknown>
}> {}

/**
 * Authorization Error
 *
 * Thrown when a user is not authorized.
 */
export class AuthorizationError extends Data.TaggedError("AuthorizationError")<{
  readonly message: string
  readonly resource?: string
}> {}

/**
 * Not Found Error
 *
 * Thrown when a resource is not found.
 */
export class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly resource: string
  readonly id: string
}> {}
```

**HTTP Status Mapping**:

| Error | HTTP Status | When to Use |
|-------|-------------|-------------|
| `ConfigError` | 500 | Missing/invalid configuration |
| `DatabaseError` | 503 | Database unavailable |
| `KVError` | 503 | KV unavailable |
| `StorageError` | 503 | R2 unavailable |
| `ValidationError` | 400 | Invalid request data |
| `AuthorizationError` | 403 | Insufficient permissions |
| `NotFoundError` | 404 | Resource doesn't exist |

**Pattern Matching**:

```typescript
import { Effect, Match } from "effect"
import { ConfigError, DatabaseError } from "./errors"

const program = Effect.gen(function* () {
  // ... code that might fail
}).pipe(
  Effect.catchTag("ConfigError", (error) =>
    Effect.gen(function* () {
      yield* Effect.log(`Config error: ${error.message}`)
      return defaultValue
    })
  ),
  Effect.catchTag("DatabaseError", (error) =>
    Effect.gen(function* () {
      yield* Effect.log(`Database error: ${error.message}`)
      // Retry or fail
      return yield* Effect.fail(error)
    })
  )
)
```

---

## Testing Implementation

### 8.1 Vitest Configuration

Create `vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/unit/**/*.test.ts"],
  },
})
```

Create `vitest.integration.config.ts`:

```typescript
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/integration/**/*.test.ts"],
    testTimeout: 30000, // Integration tests may be slower
  },
})
```

### 8.2 Unit Testing with Mock Layers

Create `test/unit/services/config.test.ts`:

```typescript
import { Effect, Layer } from "effect"
import { describe, it, expect } from "vitest"
import { Config, ConfigService } from "../../../src/services/config"
import { ConfigError } from "../../../src/errors"

// Mock Config Layer
const MockConfig = Layer.succeed(
  Config,
  Config.of({
    get: (key: string) => {
      const values: Record<string, string> = {
        API_KEY: "test-key",
        MAX_RETRIES: "3",
        DEBUG: "true",
      }

      return key in values
        ? Effect.succeed(values[key])
        : Effect.fail(new ConfigError({ key, message: "Not found" }))
    },

    getSecret: (key: string) => Config.get(key),

    getNumber: (key: string) =>
      Effect.gen(function* () {
        const value = yield* Config.get(key)
        const num = Number(value)
        return Number.isNaN(num)
          ? yield* Effect.fail(new ConfigError({ key, message: "Not a number" }))
          : num
      }),

    getBoolean: (key: string) =>
      Effect.gen(function* () {
        const value = yield* Config.get(key)
        return value === "true"
      }),

    getJson: (key, schema) =>
      Effect.gen(function* () {
        const value = yield* Config.get(key)
        return yield* Schema.decodeUnknown(schema)(JSON.parse(value))
      }),

    getOrElse: (key: string, defaultValue: string) =>
      Config.get(key).pipe(Effect.orElseSucceed(() => defaultValue)),

    getAll: () => Effect.succeed({ API_KEY: "test-key" }),
  })
)

describe("Config Service", () => {
  it("should get string value", async () => {
    const program = Effect.gen(function* () {
      const config = yield* Config
      return yield* config.get("API_KEY")
    }).pipe(Effect.provide(MockConfig))

    const result = await Effect.runPromise(program)
    expect(result).toBe("test-key")
  })

  it("should fail for missing key", async () => {
    const program = Effect.gen(function* () {
      const config = yield* Config
      return yield* config.get("MISSING_KEY")
    }).pipe(Effect.provide(MockConfig))

    await expect(Effect.runPromise(program)).rejects.toThrow()
  })

  it("should get number value", async () => {
    const program = Effect.gen(function* () {
      const config = yield* Config
      return yield* config.getNumber("MAX_RETRIES")
    }).pipe(Effect.provide(MockConfig))

    const result = await Effect.runPromise(program)
    expect(result).toBe(3)
  })

  it("should get boolean value", async () => {
    const program = Effect.gen(function* () {
      const config = yield* Config
      return yield* config.getBoolean("DEBUG")
    }).pipe(Effect.provide(MockConfig))

    const result = await Effect.runPromise(program)
    expect(result).toBe(true)
  })

  it("should use default value", async () => {
    const program = Effect.gen(function* () {
      const config = yield* Config
      return yield* config.getOrElse("MISSING", "default")
    }).pipe(Effect.provide(MockConfig))

    const result = await Effect.runPromise(program)
    expect(result).toBe("default")
  })
})
```

### 8.3 Integration Testing with Miniflare

Create `test/integration/worker.test.ts`:

```typescript
import { Miniflare } from "miniflare"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import worker from "../../src/worker"

describe("Worker Integration", () => {
  let mf: Miniflare

  beforeAll(async () => {
    mf = new Miniflare({
      script: `
        export default {
          async fetch(request, env, ctx) {
            // Import your worker
            const { default: worker } = await import("./src/worker")
            return worker.fetch(request, env, ctx)
          }
        }
      `,
      modules: true,
      kvNamespaces: ["MY_KV"],
      d1Databases: ["DB"],
      r2Buckets: ["MY_BUCKET"],
      bindings: {
        ENVIRONMENT: "test",
        LOG_LEVEL: "debug",
        API_KEY: "test-key",
      },
    })
  })

  afterAll(async () => {
    await mf.dispose()
  })

  it("should respond to health check", async () => {
    const response = await mf.dispatchFetch("http://localhost/health")

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("OK")
  })

  it("should return 404 for unknown routes", async () => {
    const response = await mf.dispatchFetch("http://localhost/unknown")

    expect(response.status).toBe(404)
  })

  it("should handle API requests", async () => {
    const response = await mf.dispatchFetch("http://localhost/api/users", {
      method: "GET",
    })

    expect(response.status).toBe(200)
    const users = await response.json()
    expect(Array.isArray(users)).toBe(true)
  })
})
```

### 8.4 Test Fixtures

Create `test/fixtures/mock-services.ts`:

```typescript
import { Layer } from "effect"
import {
  Config,
  Database,
  KVStore,
  ObjectStorage,
} from "../../src/services"

/**
 * Mock Config for tests
 */
export const MockConfig = Layer.succeed(
  Config,
  Config.of({
    get: (key) => Effect.succeed(`mock-${key}`),
    getSecret: (key) => Effect.succeed(`secret-${key}`),
    getNumber: (key) => Effect.succeed(42),
    getBoolean: (key) => Effect.succeed(true),
    getJson: (key, schema) => Schema.decodeUnknown(schema)({}),
    getOrElse: (key, def) => Effect.succeed(def),
    getAll: () => Effect.succeed({}),
  })
)

/**
 * In-memory KV Store for tests
 */
export const MockKVStore = KVStoreMemory

/**
 * Mock Database for tests
 */
export const MockDatabase = Layer.succeed(
  Database,
  Database.of({
    client: {} as any, // Mock Drizzle client
    transaction: (effect) => effect({} as any),
    execute: (query, params) => Effect.succeed([]),
  })
)

/**
 * Complete test layer
 */
export const TestLayer = Layer.mergeAll(
  MockConfig,
  MockDatabase,
  MockKVStore,
)
```

---

## Development Workflow

### 9.1 Local Development

Start the local development server:

```bash
pnpm dev
```

This runs `wrangler dev`, which:
- Starts a local HTTP server
- Hot-reloads on file changes
- Simulates Cloudflare Workers environment
- Uses local D1, KV, and R2 bindings

### 9.2 Debugging Effect Code

**Console Logging**:

```typescript
const program = Effect.gen(function* () {
  yield* Effect.log("Starting request")

  const config = yield* Config
  const apiKey = yield* config.get("API_KEY")

  yield* Effect.logDebug(`API Key: ${apiKey.substring(0, 4)}...`)

  return "done"
})
```

**Inspect Values**:

```typescript
import { Effect, Console } from "effect"

const program = Effect.gen(function* () {
  const user = yield* getUser("123")

  // Log the value
  yield* Console.log(user)

  return user
})
```

**Tap for Side Effects**:

```typescript
const program = getUserById("123").pipe(
  Effect.tap((user) => Effect.log(`Fetched user: ${user.email}`)),
  Effect.tap((user) => cacheUser(user))
)
```

### 9.3 Type Checking

Run TypeScript type checker:

```bash
pnpm typecheck
```

This runs `tsc --noEmit` to check types without emitting files.

### 9.4 Running Tests

```bash
# Run unit tests
pnpm test

# Run unit tests in watch mode
pnpm test:watch

# Run integration tests
pnpm test:integration
```

---

## Production Considerations

### 10.1 Performance Optimization

**1. Minimize Cold Starts**

- Keep bundle size small (< 1 MB)
- Use dynamic imports for large dependencies
- Cache runtime at isolate level

**2. Optimize Database Queries**

```typescript
// ❌ BAD: N+1 queries
for (const userId of userIds) {
  const user = yield* getUserById(userId)
}

// ✅ GOOD: Batch query
const users = yield* Effect.tryPromise(() =>
  db.client
    .select()
    .from(users)
    .where(inArray(users.id, userIds))
)
```

**3. Use KV for Caching**

```typescript
const getCachedOrFetch = <A>(
  key: string,
  fetch: Effect.Effect<A, never, never>,
  ttl: number
) =>
  Effect.gen(function* () {
    const kv = yield* KVStore

    // Try cache
    const cached = yield* kv.get(key)
    if (Option.isSome(cached)) {
      return JSON.parse(cached.value) as A
    }

    // Fetch and cache
    const value = yield* fetch
    yield* kv.set(key, JSON.stringify(value), { expirationTtl: ttl })

    return value
  })
```

### 10.2 Monitoring and Observability

**Add Request ID**:

```typescript
const handleRequest = (request: Request) =>
  Effect.gen(function* () {
    const requestId = crypto.randomUUID()

    yield* Effect.annotateCurrentSpan("request.id", requestId)
    yield* Effect.log(`[${requestId}] Handling request`)

    // ... handle request
  })
```

**Track Metrics**:

```typescript
const trackDuration = <A, E, R>(
  name: string,
  effect: Effect.Effect<A, E, R>
) =>
  Effect.gen(function* () {
    const start = Date.now()
    const result = yield* effect
    const duration = Date.now() - start

    yield* Effect.log(`${name} took ${duration}ms`)

    return result
  })

// Usage
const users = yield* trackDuration("getUsers", getUsersFromDb())
```

### 10.3 Deployment Pipeline

**1. Build and Type Check**

```bash
# CI pipeline
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

**2. Deploy to Cloudflare**

```bash
# Deploy to production
pnpm deploy

# Deploy to staging
wrangler deploy --env staging
```

**3. Migrations**

```bash
# Apply migrations before deployment
pnpm db:migrate:prod

# Then deploy
pnpm deploy
```

### 10.4 Security Considerations

**1. Never Log Secrets**

```typescript
// ❌ BAD
yield* Effect.log(`API Key: ${apiKey}`)

// ✅ GOOD
yield* Effect.log(`API Key: ${apiKey.substring(0, 4)}...`)
```

**2. Validate All Inputs**

```typescript
const createUser = (request: Request) =>
  Effect.gen(function* () {
    // Always validate with schema
    const body = yield* parseJsonBody(request, CreateUserSchema)

    // Sanitize inputs
    const email = body.email.trim().toLowerCase()

    // ...
  })
```

**3. Use CORS Headers**

```typescript
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE",
  "Access-Control-Allow-Headers": "Content-Type",
}

return new Response(JSON.stringify(data), {
  headers: {
    "Content-Type": "application/json",
    ...corsHeaders,
  },
})
```

---

## Summary

This implementation guide provides:

1. **Complete project setup**: package.json, tsconfig.json, wrangler.toml
2. **Production-ready services**: Config, Database, KV, R2 with full implementations
3. **Runtime patterns**: Request-scoped and cached runtime strategies
4. **Handler implementations**: Fetch handler with routing and error handling
5. **Testing strategies**: Unit tests with mocks, integration tests with Miniflare
6. **Development workflow**: Local dev, debugging, deployment
7. **Production considerations**: Performance, monitoring, security

**Next Steps**:

1. Bootstrap the project with the provided configuration files
2. Implement services one by one, starting with CloudflareBindings
3. Create your application layer composition
4. Build handlers for your specific use cases
5. Write tests for critical paths
6. Deploy to Cloudflare Workers

---

## References

- [Effect Documentation](https://effect.website/docs/)
- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)
- [Drizzle ORM Documentation](https://orm.drizzle.team/)
- [Miniflare Documentation](https://miniflare.dev/)
- [001-system-design.md](./001-system-design.md) - Architectural overview
