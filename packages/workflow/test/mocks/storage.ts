/**
 * Mock implementation of DurableObjectStorage for testing.
 */
export class MockStorage {
  private data = new Map<string, unknown>();

  /** Track all operations for assertions */
  readonly operations: Array<{
    type: "get" | "put" | "delete";
    key: string | string[];
    value?: unknown;
  }> = [];

  /** Failure configuration for simulating storage errors */
  private failureConfig: {
    keys?: Set<string>;
    operations?: Set<"get" | "put" | "delete">;
    error?: Error;
    failOnce?: boolean;
  } | null = null;

  /** Count of failures triggered (for failOnce tracking) */
  private failureCount = 0;

  /**
   * Configure storage to fail on specific operations.
   * @param config Failure configuration
   */
  simulateFailure(config: {
    /** Keys that should fail (undefined = all keys) */
    keys?: string[];
    /** Operations that should fail (undefined = all operations) */
    operations?: ("get" | "put" | "delete")[];
    /** Error to throw (default: generic Error) */
    error?: Error;
    /** If true, only fail once then succeed */
    failOnce?: boolean;
  }): void {
    this.failureConfig = {
      keys: config.keys ? new Set(config.keys) : undefined,
      operations: config.operations ? new Set(config.operations) : undefined,
      error: config.error,
      failOnce: config.failOnce,
    };
    this.failureCount = 0;
  }

  /** Clear failure simulation */
  clearFailure(): void {
    this.failureConfig = null;
    this.failureCount = 0;
  }

  /** Check if operation should fail */
  private shouldFail(type: "get" | "put" | "delete", key: string): boolean {
    if (!this.failureConfig) return false;

    // Check if we've already failed once
    if (this.failureConfig.failOnce && this.failureCount > 0) return false;

    // Check operation type
    if (
      this.failureConfig.operations &&
      !this.failureConfig.operations.has(type)
    ) {
      return false;
    }

    // Check key
    if (this.failureConfig.keys && !this.failureConfig.keys.has(key)) {
      return false;
    }

    return true;
  }

  /** Throw configured error */
  private throwError(): never {
    this.failureCount++;
    throw this.failureConfig?.error ?? new Error("Simulated storage error");
  }

  async get<T = unknown>(key: string): Promise<T | undefined>;
  async get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
  async get<T = unknown>(
    keyOrKeys: string | string[],
  ): Promise<T | undefined | Map<string, T>> {
    if (Array.isArray(keyOrKeys)) {
      this.operations.push({ type: "get", key: keyOrKeys });
      // Check if any key should fail
      for (const key of keyOrKeys) {
        if (this.shouldFail("get", key)) {
          this.throwError();
        }
      }
      const result = new Map<string, T>();
      for (const key of keyOrKeys) {
        const value = this.data.get(key);
        if (value !== undefined) {
          result.set(key, value as T);
        }
      }
      return result;
    }
    this.operations.push({ type: "get", key: keyOrKeys });
    if (this.shouldFail("get", keyOrKeys)) {
      this.throwError();
    }
    return this.data.get(keyOrKeys) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void>;
  async put(entries: Record<string, unknown>): Promise<void>;
  async put<T>(
    keyOrEntries: string | Record<string, unknown>,
    value?: T,
  ): Promise<void> {
    if (typeof keyOrEntries === "string") {
      this.operations.push({ type: "put", key: keyOrEntries, value });
      if (this.shouldFail("put", keyOrEntries)) {
        this.throwError();
      }
      this.data.set(keyOrEntries, value);
    } else {
      for (const [k, v] of Object.entries(keyOrEntries)) {
        this.operations.push({ type: "put", key: k, value: v });
        if (this.shouldFail("put", k)) {
          this.throwError();
        }
        this.data.set(k, v);
      }
    }
  }

  async delete(key: string): Promise<boolean>;
  async delete(keys: string[]): Promise<number>;
  async delete(keyOrKeys: string | string[]): Promise<boolean | number> {
    if (Array.isArray(keyOrKeys)) {
      this.operations.push({ type: "delete", key: keyOrKeys });
      // Check if any key should fail
      for (const key of keyOrKeys) {
        if (this.shouldFail("delete", key)) {
          this.throwError();
        }
      }
      let count = 0;
      for (const key of keyOrKeys) {
        if (this.data.delete(key)) count++;
      }
      return count;
    }
    this.operations.push({ type: "delete", key: keyOrKeys });
    if (this.shouldFail("delete", keyOrKeys)) {
      this.throwError();
    }
    return this.data.delete(keyOrKeys);
  }

  async list(): Promise<Map<string, unknown>> {
    return new Map(this.data);
  }

  // Alarm methods (minimal implementation)
  private alarmTime: number | null = null;

  async getAlarm(): Promise<number | null> {
    return this.alarmTime;
  }

  async setAlarm(time: number | Date): Promise<void> {
    this.alarmTime = typeof time === "number" ? time : time.getTime();
  }

  async deleteAlarm(): Promise<void> {
    this.alarmTime = null;
  }

  // Helper methods for testing

  /** Clear all data and operations */
  clear(): void {
    this.data.clear();
    this.operations.length = 0;
    this.alarmTime = null;
    this.failureConfig = null;
    this.failureCount = 0;
  }

  /** Get raw data for assertions */
  getRawData(): Map<string, unknown> {
    return new Map(this.data);
  }

  /** Check if a key exists */
  has(key: string): boolean {
    return this.data.has(key);
  }

  /** Get operations filtered by type */
  getOperations(type: "get" | "put" | "delete") {
    return this.operations.filter((op) => op.type === type);
  }

  /** Set initial data for testing */
  seed(data: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(data)) {
      this.data.set(key, value);
    }
  }
}

/**
 * Create a mock storage with optional seed data.
 */
export function createMockStorage(seed?: Record<string, unknown>): MockStorage {
  const storage = new MockStorage();
  if (seed) {
    storage.seed(seed);
  }
  return storage;
}
