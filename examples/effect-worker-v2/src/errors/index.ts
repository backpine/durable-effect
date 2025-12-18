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

/**
 * Database Error
 *
 * Thrown when a database operation fails.
 */
export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly message: string
  readonly cause?: unknown
}> {}
