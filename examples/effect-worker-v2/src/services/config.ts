import { Context, Effect, Layer } from "effect"
import { Schema } from "effect"
import { CloudflareEnv } from "./cloudflare"
import { ConfigError } from "@/errors"

/**
 * Config Service Interface
 *
 * Provides type-safe access to environment variables and secrets.
 * All methods return Effects that can fail with ConfigError.
 *
 * IMPORTANT: Methods require CloudflareEnv to be provided in the context.
 * This is provided per-request via Context.make(CloudflareEnv, { env }).
 */
export interface ConfigService {
  /**
   * Get a string config value
   */
  readonly get: (key: string) => Effect.Effect<string, ConfigError, CloudflareEnv>

  /**
   * Get a secret value (same as get, but semantically different)
   */
  readonly getSecret: (key: string) => Effect.Effect<string, ConfigError, CloudflareEnv>

  /**
   * Get a numeric config value
   */
  readonly getNumber: (key: string) => Effect.Effect<number, ConfigError, CloudflareEnv>

  /**
   * Get a boolean config value
   * Accepts: "true", "false", "1", "0", "yes", "no"
   */
  readonly getBoolean: (key: string) => Effect.Effect<boolean, ConfigError, CloudflareEnv>

  /**
   * Get a JSON config value with schema validation
   */
  readonly getJson: <A, I, R>(
    key: string,
    schema: Schema.Schema<A, I, R>
  ) => Effect.Effect<A, ConfigError, CloudflareEnv | R>

  /**
   * Get a config value with a default fallback
   */
  readonly getOrElse: (
    key: string,
    defaultValue: string
  ) => Effect.Effect<string, never, CloudflareEnv>

  /**
   * Get all config as a record (useful for debugging)
   */
  readonly getAll: () => Effect.Effect<Record<string, string>, never, CloudflareEnv>
}

/**
 * Config Service Tag
 */
export class Config extends Context.Tag("Config")<Config, ConfigService>() {}

/**
 * Helper to get raw value from env
 */
const getRaw = (env: Env, key: string): string | undefined => {
  const value = env[key as keyof typeof env]
  return typeof value === "string" ? value : undefined
}

/**
 * Live Config Implementation
 *
 * Backed by Cloudflare's env object.
 * Values are read from environment variables and secrets.
 *
 * IMPORTANT: This layer is built ONCE at module level.
 * CloudflareEnv is accessed at METHOD CALL time, not construction time.
 * This allows the layer to be static while still accessing request-specific env.
 */
export const ConfigLive = Layer.succeed(Config, {
  get: (key: string) =>
    Effect.gen(function* () {
      const { env } = yield* CloudflareEnv
      const value = getRaw(env, key)
      if (value === undefined) {
        return yield* Effect.fail(
          new ConfigError({
            key,
            message: `Config key "${key}" not found`,
          })
        )
      }
      return value
    }),

  getSecret: (key: string) =>
    Effect.gen(function* () {
      const { env } = yield* CloudflareEnv
      const value = getRaw(env, key)
      if (value === undefined) {
        return yield* Effect.fail(
          new ConfigError({
            key,
            message: `Secret "${key}" not found`,
          })
        )
      }
      return value
    }),

  getNumber: (key: string) =>
    Effect.gen(function* () {
      const { env } = yield* CloudflareEnv
      const value = getRaw(env, key)
      if (value === undefined) {
        return yield* Effect.fail(
          new ConfigError({
            key,
            message: `Config key "${key}" not found`,
          })
        )
      }
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
      const { env } = yield* CloudflareEnv
      const value = getRaw(env, key)
      if (value === undefined) {
        return yield* Effect.fail(
          new ConfigError({
            key,
            message: `Config key "${key}" not found`,
          })
        )
      }
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
      const { env } = yield* CloudflareEnv
      const value = getRaw(env, key)
      if (value === undefined) {
        return yield* Effect.fail(
          new ConfigError({
            key,
            message: `Config key "${key}" not found`,
          })
        )
      }
      const parsed = yield* Effect.try({
        try: () => JSON.parse(value) as unknown,
        catch: (error) =>
          new ConfigError({
            key,
            message: `Config key "${key}" is not valid JSON: ${error}`,
          }),
      })
      return yield* Schema.decodeUnknown(schema)(parsed).pipe(
        Effect.mapError(
          (parseError) =>
            new ConfigError({
              key,
              message: `Config key "${key}" failed schema validation: ${parseError}`,
            })
        )
      )
    }),

  getOrElse: (key: string, defaultValue: string) =>
    Effect.gen(function* () {
      const { env } = yield* CloudflareEnv
      const value = getRaw(env, key)
      return value ?? defaultValue
    }),

  getAll: () =>
    Effect.gen(function* () {
      const { env } = yield* CloudflareEnv
      const result: Record<string, string> = {}
      for (const key in env) {
        const value = env[key as keyof typeof env]
        if (typeof value === "string") {
          result[key] = value
        }
      }
      return result
    }),
} satisfies ConfigService)
