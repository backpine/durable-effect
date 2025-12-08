// packages/workflow/src/primitives/backoff.ts

/**
 * Backoff strategy for retries.
 */
export type BackoffStrategy =
  | { readonly type: "constant"; readonly delayMs: number }
  | {
      readonly type: "linear";
      readonly initialDelayMs: number;
      readonly incrementMs: number;
      readonly maxDelayMs?: number;
    }
  | {
      readonly type: "exponential";
      readonly initialDelayMs: number;
      readonly multiplier?: number;
      readonly maxDelayMs?: number;
    };

/**
 * Default backoff strategies.
 */
export const BackoffStrategies = {
  /**
   * Constant delay between retries.
   */
  constant: (delayMs: number): BackoffStrategy => ({
    type: "constant",
    delayMs,
  }),

  /**
   * Linear backoff: delay increases by a fixed amount.
   */
  linear: (
    initialDelayMs: number,
    incrementMs: number,
    maxDelayMs?: number,
  ): BackoffStrategy => ({
    type: "linear",
    initialDelayMs,
    incrementMs,
    maxDelayMs,
  }),

  /**
   * Exponential backoff: delay doubles (or multiplies) each time.
   */
  exponential: (
    initialDelayMs: number,
    options?: { multiplier?: number; maxDelayMs?: number },
  ): BackoffStrategy => ({
    type: "exponential",
    initialDelayMs,
    multiplier: options?.multiplier ?? 2,
    maxDelayMs: options?.maxDelayMs,
  }),
} as const;

/**
 * Calculate the delay for a given attempt using a backoff strategy.
 *
 * @param strategy - The backoff strategy to use
 * @param attempt - Current attempt number (1-indexed)
 * @returns Delay in milliseconds
 */
export function calculateBackoffDelay(
  strategy: BackoffStrategy,
  attempt: number,
): number {
  switch (strategy.type) {
    case "constant":
      return strategy.delayMs;

    case "linear": {
      const delay =
        strategy.initialDelayMs + strategy.incrementMs * (attempt - 1);
      return strategy.maxDelayMs !== undefined
        ? Math.min(delay, strategy.maxDelayMs)
        : delay;
    }

    case "exponential": {
      const multiplier = strategy.multiplier ?? 2;
      const delay = strategy.initialDelayMs * Math.pow(multiplier, attempt - 1);
      return strategy.maxDelayMs !== undefined
        ? Math.min(delay, strategy.maxDelayMs)
        : delay;
    }
  }
}

/**
 * Add jitter to a delay to prevent thundering herd.
 *
 * @param delayMs - Base delay in milliseconds
 * @param jitterFactor - Jitter factor (0-1, default 0.1 = +/-10%)
 * @returns Delay with random jitter applied
 */
export function addJitter(delayMs: number, jitterFactor = 0.1): number {
  const jitter = delayMs * jitterFactor;
  return delayMs + (Math.random() * 2 - 1) * jitter;
}

/**
 * Parse a human-readable duration string to milliseconds.
 *
 * Supports: "5s", "5 seconds", "5m", "5 minutes", "5h", "5 hours", "5d", "5 days"
 *
 * @example
 * parseDuration("5 seconds") // 5000
 * parseDuration("1 hour") // 3600000
 * parseDuration("30m") // 1800000
 */
export function parseDuration(duration: string | number): number {
  if (typeof duration === "number") {
    return duration;
  }

  const match = duration.match(
    /^(\d+(?:\.\d+)?)\s*(s|sec|second|seconds|m|min|minute|minutes|h|hr|hour|hours|d|day|days|ms|millisecond|milliseconds)?$/i,
  );

  if (!match) {
    throw new Error(`Invalid duration format: "${duration}"`);
  }

  const value = parseFloat(match[1]);
  const unit = (match[2] || "ms").toLowerCase();

  switch (unit) {
    case "ms":
    case "millisecond":
    case "milliseconds":
      return value;
    case "s":
    case "sec":
    case "second":
    case "seconds":
      return value * 1000;
    case "m":
    case "min":
    case "minute":
    case "minutes":
      return value * 60 * 1000;
    case "h":
    case "hr":
    case "hour":
    case "hours":
      return value * 60 * 60 * 1000;
    case "d":
    case "day":
    case "days":
      return value * 24 * 60 * 60 * 1000;
    default:
      throw new Error(`Unknown duration unit: "${unit}"`);
  }
}
