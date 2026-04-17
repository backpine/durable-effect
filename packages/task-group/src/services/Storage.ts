import { Data, Effect, Context } from "effect"

export class StorageError extends Data.TaggedError("StorageError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class Storage extends Context.Service<Storage, {
  readonly get: (key: string) => Effect.Effect<unknown | null, StorageError>
  readonly set: (key: string, value: unknown) => Effect.Effect<void, StorageError>
  readonly delete: (key: string) => Effect.Effect<void, StorageError>
  readonly deleteAll: () => Effect.Effect<void, StorageError>
}>()("@task-group/Storage") {}
