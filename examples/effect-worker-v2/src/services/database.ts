import { Context, Effect } from "effect";
import { drizzle } from "drizzle-orm/postgres-js";
// import postgres from "postgres";
// import { env } from "cloudflare:workers";
import { DatabaseError } from "@/errors";

/**
 * DrizzleClient type
 *
 * This is the type of the Drizzle client instance.
 * When you have a schema, update this to include it:
 *
 * ```typescript
 * import * as schema from "@/db/schema"
 * export type DrizzleClient = ReturnType<typeof drizzle<typeof schema>>
 * ```
 */
export type DrizzleClient = ReturnType<typeof drizzle>;

/**
 * Database Service
 *
 * Provides access to the Drizzle client.
 * The client is memoized once per request via Effect's layer system.
 *
 * **Usage:**
 * ```typescript
 * const db = yield* Database
 * const users = await db.select().from(usersTable)
 * ```
 *
 * **Or use the query helper:**
 * ```typescript
 * const users = yield* query((db) =>
 *   db.select().from(usersTable).where(eq(usersTable.id, id))
 * )
 * ```
 */
export class Database extends Context.Tag("Database")<
  Database,
  DrizzleClient
>() {}

/**
 * Query helper
 *
 * Wraps database operations in Effects with proper error handling.
 * Automatically injects the Database client and adds tracing.
 *
 * @example
 * ```typescript
 * const getUser = (id: string) =>
 *   query((db) =>
 *     db.select().from(users).where(eq(users.id, id)).limit(1)
 *   )
 *
 * // In your Effect.gen:
 * const users = yield* getUser("123")
 * ```
 */
export const query = <T>(
  fn: (db: DrizzleClient) => Promise<T>,
): Effect.Effect<T, DatabaseError, Database> =>
  Effect.gen(function* () {
    const db = yield* Database;
    return yield* Effect.tryPromise({
      try: () => fn(db),
      catch: (error) =>
        new DatabaseError({
          message: "Database query failed",
          cause: error,
        }),
    });
  }).pipe(
    Effect.withSpan("database.query", {
      attributes: { "db.system": "postgresql" },
    }),
  );

/**
 * Live Database Layer
 *
 * Creates a database connection using the module-level env.
 * This layer is built ONCE when the ManagedRuntime initializes.
 *
 * Uses `import { env } from "cloudflare:workers"` to access
 * DATABASE_URL at module level, which allows the layer to be
 * built statically without per-request env access.
 *
 * @example
 * ```typescript
 * // In app.ts - layer composition
 * export const AppLayer = Layer.mergeAll(
 *   ConfigLive,
 *   KVLive,
 *   StorageLive,
 *   DatabaseLive,
 * )
 *
 * // In worker.ts - runtime initialization
 * const runtime = ManagedRuntime.make(AppLayer)
 * ```
 */
// export const DatabaseLive = Layer.scoped(
//   Database,
//   Effect.gen(function* () {
//     console.log("Connecting to database...", Date.now());

//     const client = postgres(env.DATABASE_URL, {
//       max: 5,
//       fetch_types: false,
//     });

//     const db = drizzle(client);

//     // Register cleanup to close connections when runtime disposes
//     yield* Effect.addFinalizer(() =>
//       Effect.promise(async () => {
//         await client.end({ timeout: 5 });
//       }).pipe(Effect.catchAll(() => Effect.void)),
//     );

//     return db;
//   }),
// );
