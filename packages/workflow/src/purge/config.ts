// packages/workflow/src/purge/config.ts

import { parseDuration } from "../primitives/backoff";

// =============================================================================
// Types
// =============================================================================

/**
 * User-facing purge configuration.
 */
export interface PurgeConfig {
  /**
   * Delay before purging data after terminal state.
   * Allows time for external systems to query final results.
   *
   * Accepts duration string (e.g., "60 seconds", "5 minutes") or number in ms.
   * Default: "60 seconds"
   */
  readonly delay?: string | number;
}

/**
 * Internal parsed purge configuration.
 */
export interface ParsedPurgeConfig {
  readonly enabled: boolean;
  readonly delayMs: number;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Default purge delay in milliseconds (60 seconds).
 */
export const defaultPurgeDelayMs = 60_000;

// =============================================================================
// Parser
// =============================================================================

/**
 * Parse user-provided purge config into internal format.
 *
 * - If options is undefined, purge is disabled
 * - If options is provided (even empty object), purge is enabled
 */
export function parsePurgeConfig(
  options?: PurgeConfig
): ParsedPurgeConfig {
  // If options is undefined, purge is disabled
  if (options === undefined) {
    return { enabled: false, delayMs: defaultPurgeDelayMs };
  }

  // If options provided (even empty object), purge is enabled
  return {
    enabled: true,
    delayMs: options.delay !== undefined
      ? parseDuration(options.delay)
      : defaultPurgeDelayMs,
  };
}
