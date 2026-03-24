// ---------------------------------------------------------------------------
// Structural types — compatible with Cloudflare's types without importing them.
// This lets the adapter compile in non-CF environments (tests, etc.)
// while still being structurally assignable from CF runtime values.
// ---------------------------------------------------------------------------

export interface DurableObjectIdLike {
  toString(): string
}

export interface DurableObjectStorageLike {
  get(key: string): Promise<unknown>
  get(keys: string[]): Promise<Map<string, unknown>>
  put(key: string, value: unknown): Promise<void>
  put(entries: Record<string, unknown>): Promise<void>
  delete(key: string): Promise<boolean>
  deleteAll(): Promise<void>
  setAlarm(scheduledTime: number | Date): Promise<void>
  deleteAlarm(): Promise<void>
  getAlarm(): Promise<number | null>
}

export interface DurableObjectStateLike {
  readonly id: DurableObjectIdLike
  readonly storage: DurableObjectStorageLike
}

export interface AlarmInvocationInfoLike {
  readonly isRetry: boolean
  readonly retryCount: number
}

/** Structural type for the stub returned by namespace.get() */
export interface TaskGroupStubLike {
  handleEvent(name: string, id: string, event: unknown): Promise<void>
  handleAlarm(name: string, id: string): Promise<void>
  handleGetState(name: string, id: string): Promise<unknown>
}

/** Structural type for the DO namespace binding */
export interface DurableObjectNamespaceLike {
  idFromName(name: string): DurableObjectIdLike
  get(id: DurableObjectIdLike): TaskGroupStubLike
}
