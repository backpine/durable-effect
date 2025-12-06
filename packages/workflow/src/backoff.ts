import { Duration } from "effect";

// =============================================================================
// Jitter Configuration
// =============================================================================

/**
 * Configuration for jitter applied to delay calculations.
 *
 * Jitter helps prevent the "thundering herd" problem where many clients
 * retry at exactly the same time.
 */
export interface JitterConfig {
  /**
   * Jitter algorithm:
   * - `full`: `random(0, delay)` - Maximum spread, good for many clients
   * - `equal`: `delay/2 + random(0, delay/2)` - Balanced, never zero delay
   * - `decorrelated`: `random(base, delay * factor)` - AWS-style, prevents correlation
   */
  readonly type: "full" | "equal" | "decorrelated";

  /**
   * Factor for jitter calculation.
   * - For `decorrelated`: multiplier for max range (default: 3)
   * - Ignored for `full` and `equal`
   */
  readonly factor?: number;
}

// =============================================================================
// Backoff Strategy Types
// =============================================================================

/**
 * Exponential backoff configuration.
 *
 * Delay grows exponentially: `base * factor^attempt`
 *
 * @example
 * ```typescript
 * // 1s → 2s → 4s → 8s → 16s (capped at 30s)
 * Backoff.exponential({
 *   base: "1 second",
 *   factor: 2,
 *   max: "30 seconds",
 *   jitter: true
 * })
 * ```
 */
export interface ExponentialBackoff {
  readonly _tag: "Exponential";
  /** Base delay for first retry */
  readonly base: Duration.DurationInput;
  /** Multiplier for each subsequent retry (default: 2) */
  readonly factor?: number;
  /** Maximum delay cap per attempt */
  readonly max?: Duration.DurationInput;
  /** Add jitter to prevent thundering herd */
  readonly jitter?: boolean | JitterConfig;
}

/**
 * Linear backoff configuration.
 *
 * Delay grows linearly: `initial + (attempt * increment)`
 *
 * @example
 * ```typescript
 * // 1s → 3s → 5s → 7s → 9s (capped at 10s)
 * Backoff.linear({
 *   initial: "1 second",
 *   increment: "2 seconds",
 *   max: "10 seconds"
 * })
 * ```
 */
export interface LinearBackoff {
  readonly _tag: "Linear";
  /** Initial delay for first retry */
  readonly initial: Duration.DurationInput;
  /** Amount added for each subsequent retry */
  readonly increment: Duration.DurationInput;
  /** Maximum delay cap per attempt */
  readonly max?: Duration.DurationInput;
  /** Add jitter */
  readonly jitter?: boolean | JitterConfig;
}

/**
 * Constant backoff configuration.
 *
 * Fixed delay between retries (optionally with jitter).
 *
 * @example
 * ```typescript
 * // 5s between each retry, with jitter
 * Backoff.constant("5 seconds", true)
 * ```
 */
export interface ConstantBackoff {
  readonly _tag: "Constant";
  /** Fixed delay between retries */
  readonly duration: Duration.DurationInput;
  /** Add jitter */
  readonly jitter?: boolean | JitterConfig;
}

/**
 * Discriminated union of all backoff strategies.
 */
export type BackoffConfig =
  | ExponentialBackoff
  | LinearBackoff
  | ConstantBackoff;

/**
 * Type guard to check if a value is a BackoffConfig.
 *
 * Used internally to differentiate between Duration values and BackoffConfig
 * in the unified `delay` field of RetryOptions.
 *
 * @example
 * ```typescript
 * if (isBackoffConfig(delay)) {
 *   // delay is BackoffConfig
 *   const delayMs = calculateDelay(delay, attempt);
 * } else if (typeof delay === "function") {
 *   // delay is a function
 * } else {
 *   // delay is Duration.DurationInput
 * }
 * ```
 */
export function isBackoffConfig(value: unknown): value is BackoffConfig {
  return (
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    typeof (value as Record<string, unknown>)._tag === "string" &&
    ["Exponential", "Linear", "Constant"].includes(
      (value as Record<string, unknown>)._tag as string,
    )
  );
}

// =============================================================================
// Internal: Delay Calculation
// =============================================================================

/**
 * Calculate the delay for a given attempt using the backoff configuration.
 *
 * The calculation applies in order:
 * 1. Base delay calculation based on backoff type
 * 2. Maximum cap (if configured)
 * 3. Jitter (if configured)
 *
 * @param config - The backoff configuration
 * @param attempt - The current attempt number (0-indexed)
 * @param random - Random number generator (default: Math.random, injectable for testing)
 * @returns The calculated delay duration
 *
 * @internal
 */
export function calculateDelay(
  config: BackoffConfig,
  attempt: number,
  random: () => number = Math.random,
): Duration.Duration {
  const baseDelay = calculateBaseDelay(config, attempt);
  const cappedDelay = applyMax(config, baseDelay);
  return applyJitter(config, cappedDelay, random);
}

/**
 * Calculate the base delay before max cap and jitter.
 */
function calculateBaseDelay(
  config: BackoffConfig,
  attempt: number,
): Duration.Duration {
  switch (config._tag) {
    case "Exponential": {
      const factor = config.factor ?? 2;
      const baseMs = Duration.toMillis(Duration.decode(config.base));
      return Duration.millis(baseMs * Math.pow(factor, attempt));
    }

    case "Linear": {
      const initialMs = Duration.toMillis(Duration.decode(config.initial));
      const incrementMs = Duration.toMillis(Duration.decode(config.increment));
      return Duration.millis(initialMs + attempt * incrementMs);
    }

    case "Constant": {
      return Duration.decode(config.duration);
    }
  }
}

/**
 * Apply maximum delay cap if configured.
 */
function applyMax(
  config: BackoffConfig,
  delay: Duration.Duration,
): Duration.Duration {
  if ("max" in config && config.max !== undefined) {
    const maxDuration = Duration.decode(config.max);
    return Duration.min(delay, maxDuration);
  }
  return delay;
}

/**
 * Apply jitter to the delay if configured.
 */
function applyJitter(
  config: BackoffConfig,
  delay: Duration.Duration,
  random: () => number,
): Duration.Duration {
  const jitter = config.jitter;
  if (!jitter) {
    return delay;
  }

  const jitterConfig: JitterConfig =
    typeof jitter === "boolean" ? { type: "full" } : jitter;

  const delayMs = Duration.toMillis(delay);

  switch (jitterConfig.type) {
    case "full":
      // random(0, delay) - Maximum spread
      return Duration.millis(random() * delayMs);

    case "equal":
      // delay/2 + random(0, delay/2) - Never zero, balanced spread
      return Duration.millis(delayMs / 2 + random() * (delayMs / 2));

    case "decorrelated": {
      // random(0, delay * factor) - AWS-style decorrelated jitter
      const factor = jitterConfig.factor ?? 3;
      return Duration.millis(random() * delayMs * factor);
    }
  }
}

// =============================================================================
// Backoff Constructors
// =============================================================================

/**
 * Utility functions and presets for creating backoff configurations.
 *
 * @example
 * ```typescript
 * // Using constructor
 * Backoff.exponential({ base: "1 second", factor: 2, max: "30 seconds" })
 *
 * // Using preset
 * Backoff.presets.standard()
 * ```
 */
export const Backoff = {
  /**
   * Create an exponential backoff configuration.
   *
   * Delay formula: `base * factor^attempt`
   *
   * @example
   * ```typescript
   * Backoff.exponential({
   *   base: "1 second",
   *   factor: 2,
   *   max: "30 seconds",
   *   jitter: true
   * })
   * // Produces: 1s → 2s → 4s → 8s → 16s → 30s (capped)
   * ```
   */
  exponential: (
    config: Omit<ExponentialBackoff, "_tag">,
  ): ExponentialBackoff => ({
    _tag: "Exponential",
    ...config,
  }),

  /**
   * Create a linear backoff configuration.
   *
   * Delay formula: `initial + (attempt * increment)`
   *
   * @example
   * ```typescript
   * Backoff.linear({
   *   initial: "1 second",
   *   increment: "2 seconds",
   *   max: "10 seconds"
   * })
   * // Produces: 1s → 3s → 5s → 7s → 9s → 10s (capped)
   * ```
   */
  linear: (config: Omit<LinearBackoff, "_tag">): LinearBackoff => ({
    _tag: "Linear",
    ...config,
  }),

  /**
   * Create a constant backoff configuration.
   *
   * Fixed delay between retries, optionally with jitter.
   *
   * @example
   * ```typescript
   * Backoff.constant("5 seconds", true)
   * // Produces: ~5s → ~5s → ~5s (with jitter variation)
   * ```
   */
  constant: (
    duration: Duration.DurationInput,
    jitter?: boolean | JitterConfig,
  ): ConstantBackoff => ({
    _tag: "Constant",
    duration,
    jitter,
  }),

  /**
   * Common presets for typical use cases.
   */
  presets: {
    /**
     * Standard exponential backoff for external API calls.
     *
     * Configuration: 1s → 2s → 4s → 8s → 16s (max 30s), with full jitter
     *
     * Good for: External API calls, third-party services
     */
    standard: (): ExponentialBackoff => ({
      _tag: "Exponential",
      base: "1 second",
      factor: 2,
      max: "30 seconds",
      jitter: true,
    }),

    /**
     * Aggressive exponential backoff for fast recovery.
     *
     * Configuration: 100ms → 200ms → 400ms → 800ms (max 5s), with full jitter
     *
     * Good for: Internal services, microservices, fast recovery scenarios
     */
    aggressive: (): ExponentialBackoff => ({
      _tag: "Exponential",
      base: "100 millis",
      factor: 2,
      max: "5 seconds",
      jitter: true,
    }),

    /**
     * Patient exponential backoff for rate-limited APIs.
     *
     * Configuration: 5s → 10s → 20s → 40s (max 2min), with full jitter
     *
     * Good for: Rate-limited APIs, eventual consistency, slow services
     */
    patient: (): ExponentialBackoff => ({
      _tag: "Exponential",
      base: "5 seconds",
      factor: 2,
      max: "2 minutes",
      jitter: true,
    }),

    /**
     * Simple constant delay for polling scenarios.
     *
     * Configuration: 1s fixed delay with full jitter
     *
     * Good for: Polling, simple retry scenarios
     */
    simple: (): ConstantBackoff => ({
      _tag: "Constant",
      duration: "1 second",
      jitter: true,
    }),
  },
} as const;
