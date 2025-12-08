// packages/workflow/src/recovery/config.ts

/**
 * Configuration for the recovery system.
 */
export interface RecoveryConfig {
  /**
   * Time in milliseconds after which a "Running" status is considered stale.
   * If a workflow has been "Running" for longer than this, it was likely
   * interrupted by infrastructure and needs recovery.
   *
   * Default: 30 seconds (typical workflow step shouldn't take this long)
   */
  readonly staleThresholdMs: number;

  /**
   * Maximum number of recovery attempts before marking workflow as failed.
   * Prevents infinite recovery loops from bugs or persistent failures.
   *
   * Default: 3 attempts
   */
  readonly maxRecoveryAttempts: number;

  /**
   * Delay in milliseconds before scheduling recovery alarm.
   * Small delay ensures storage operations complete before alarm fires.
   *
   * Default: 100ms
   */
  readonly recoveryDelayMs: number;

  /**
   * Whether to emit recovery events for observability.
   * When true, emits workflow.recovery events.
   *
   * Default: true
   */
  readonly emitRecoveryEvents: boolean;
}

/**
 * Default recovery configuration.
 * These defaults are tuned for typical Durable Object usage.
 */
export const defaultRecoveryConfig: RecoveryConfig = {
  staleThresholdMs: 30_000,
  maxRecoveryAttempts: 3,
  recoveryDelayMs: 100,
  emitRecoveryEvents: true,
};

/**
 * Create a recovery config by merging with defaults.
 */
export function createRecoveryConfig(
  overrides?: Partial<RecoveryConfig>,
): RecoveryConfig {
  return {
    ...defaultRecoveryConfig,
    ...overrides,
  };
}

/**
 * Validate recovery config values.
 */
export function validateRecoveryConfig(config: RecoveryConfig): void {
  if (config.staleThresholdMs < 1000) {
    throw new Error("staleThresholdMs must be at least 1000ms");
  }
  if (config.maxRecoveryAttempts < 1) {
    throw new Error("maxRecoveryAttempts must be at least 1");
  }
  if (config.recoveryDelayMs < 0) {
    throw new Error("recoveryDelayMs must be non-negative");
  }
}
