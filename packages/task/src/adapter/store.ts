import { Effect, ServiceMap } from "effect";
import type { StoreError } from "../errors.js";

export class Store extends ServiceMap.Service<Store, {
  readonly get: (key: string) => Effect.Effect<unknown | null, StoreError>;
  readonly set: (key: string, value: unknown) => Effect.Effect<void, StoreError>;
  readonly delete: (key: string) => Effect.Effect<void, StoreError>;
  readonly deleteAll: () => Effect.Effect<void, StoreError>;
}>()("@task/Store") {}
